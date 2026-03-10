import time
import json
import re
import logging
import math
from datetime import datetime, timedelta
from typing import List, Dict, Any, Tuple
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

import pandas as pd
import akshare as ak
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from ..db import get_db_connection
from ..config import Config

logger = logging.getLogger(__name__)

# Global HTTP session with connection pooling and retry strategy
_http_session = None

# Short-lived valuation cache to dedupe repeated requests from watchlist polling / account page
_VALUATION_CACHE: Dict[str, Dict[str, Any]] = {}
_VALUATION_CACHE_TTL_SECONDS = 8

# Stock spot provider circuit breaker (Sina -> Tencent)
_SINA_SPOT_FAIL_COUNT = 0
_SINA_SPOT_COOLDOWN_UNTIL = 0.0
_SINA_SPOT_FAIL_THRESHOLD = 2
_SINA_SPOT_COOLDOWN_SECONDS = 600  # 10 min
_SPOT_PREFERRED_PROVIDER = "sina"
_SPOT_PREFERRED_UNTIL = 0.0

# Dirty tick guard state (in-memory, per process)
_TICK_GUARD_STATE: Dict[str, Dict[str, Any]] = {}

# Detail sub-part caches to speed up heavy sections (technical indicators / holdings parse)
_INDICATOR_CACHE: Dict[str, Dict[str, Any]] = {}
_HOLDINGS_BASE_CACHE: Dict[str, Dict[str, Any]] = {}
_INDICATOR_CACHE_TTL_SECONDS = 1800   # 30 min
_HOLDINGS_BASE_CACHE_TTL_SECONDS = 1800  # 30 min

# Residual basket proxy by fund type/category
_FUND_PROXY_MAP = {
    "偏股类": ["510300", "510500"],  # CSI300 + CSI500 ETF
    "指数型-股票": ["510300", "159915"],
    "混合型-偏股": ["510300", "510500"],
    "QDII": ["513100", "513500"],     # 纳指/标普相关ETF（A股上市QDII）
    "商品类": ["518880"],               # 黄金ETF作为商品代理
    "偏债类": ["511010"],               # 国债ETF
}

def _get_http_session():
    """
    Get or create a global HTTP session with connection pooling.
    This prevents creating new connections for every request.
    """
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
        # Configure retry strategy
        retry_strategy = Retry(
            total=1,
            backoff_factor=0.2,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "POST"]
        )
        adapter = HTTPAdapter(
            max_retries=retry_strategy,
            pool_connections=10,
            pool_maxsize=20
        )
        _http_session.mount("http://", adapter)
        _http_session.mount("https://", adapter)
    return _http_session


def _run_with_timeout(fn, timeout_seconds: float, *args, **kwargs):
    """Run blocking call with timeout; return None on timeout/error.

    注意：不能用 `with ThreadPoolExecutor(...)`，否则即使 fut.result(timeout) 超时，
    退出 context 时也会等待线程结束，导致“看似有超时，实际仍卡住”。
    """
    ex = ThreadPoolExecutor(max_workers=1)
    try:
        fut = ex.submit(fn, *args, **kwargs)
        return fut.result(timeout=timeout_seconds)
    except Exception as e:
        logger.warning(f"Timeout or error in background call {getattr(fn, '__name__', 'fn')}: {e}")
        return None
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


def get_fund_type(code: str, name: str) -> str:
    """
    Get fund type from database official_type field.
    Fallback to name-based heuristics if official_type is empty.

    Args:
        code: Fund code
        name: Fund name

    Returns:
        Fund type string
    """
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT type FROM funds WHERE code = ?", (code,))
        row = cursor.fetchone()

        if row and row["type"]:
            return row["type"]
    except Exception as e:
        print(f"DB query error for {code}: {e}")
    finally:
        if conn:
            conn.close()

    # Fallback: simple heuristics based on name
    if "债" in name or "纯债" in name or "固收" in name:
        return "债券"
    if "QDII" in name or "纳斯达克" in name or "标普" in name or "恒生" in name:
        return "QDII"
    if "货币" in name:
        return "货币"

    return "未知"


def get_fund_category(fund_type: str) -> str:
    """
    Map official fund type to 4 major categories.

    Args:
        fund_type: Official type from AkShare

    Returns:
        One of: 货币类, 偏债类, 偏股类, 商品类, 未分类
    """
    if not fund_type:
        return "未分类"

    # 货币类
    if fund_type.startswith("货币型") or fund_type == "货币":
        return "货币类"

    # 偏债类
    debt_keywords = [
        "债券型-", "混合型-偏债", "混合型-绝对收益",
        "QDII-纯债", "QDII-混合债", "指数型-固收"
    ]
    if any(fund_type.startswith(k) for k in debt_keywords) or fund_type == "债券":
        return "偏债类"

    # 商品类
    commodity_keywords = ["商品", "QDII-商品", "REITs", "Reits", "QDII-REITs"]
    if any(k in fund_type for k in commodity_keywords):
        return "商品类"

    # 偏股类（最宽泛，放最后）
    equity_keywords = [
        "股票型", "混合型-偏股", "混合型-平衡", "混合型-灵活",
        "指数型-股票", "指数型-海外股票", "指数型-其他",
        "QDII-普通股票", "QDII-混合偏股", "QDII-混合平衡", "QDII-混合灵活",
        "FOF-", "QDII-FOF"
    ]
    if any(fund_type.startswith(k) or k in fund_type for k in equity_keywords):
        return "偏股类"

    # 兜底
    return "未分类"


def get_eastmoney_valuation(code: str) -> Dict[str, Any]:
    """
    Fetch real-time valuation from Tiantian Jijin (Eastmoney) API.
    """
    url = f"http://fundgz.1234567.com.cn/js/{code}.js?rt={int(time.time()*1000)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36)"
    }
    try:
        response = _get_http_session().get(url, headers=headers, timeout=1.5)
        if response.status_code == 200:
            text = response.text
            # Regex to capture JSON content inside jsonpgz(...)
            # Allow optional semicolon at end
            match = re.search(r"jsonpgz\((.*)\)", text)
            if match and match.group(1):
                data = json.loads(match.group(1))
                return {
                    "name": data.get("name"),
                    "nav": float(data.get("dwjz", 0.0)),
                    "estimate": float(data.get("gsz", 0.0)),
                    "estRate": float(data.get("gszzl", 0.0)),
                    "time": data.get("gztime")
                }
    except Exception as e:
        print(f"Eastmoney API error for {code}: {e}")
    return {}


def get_sina_valuation(code: str) -> Dict[str, Any]:
    """
    Backup source: Sina Fund API.
    Format: Name, Time, Estimate, NAV, ..., Rate, Date
    """
    url = f"http://hq.sinajs.cn/list=fu_{code}"
    headers = {"Referer": "http://finance.sina.com.cn"}
    try:
        response = _get_http_session().get(url, headers=headers, timeout=1.5)
        text = response.text
        # var hq_str_fu_005827="Name,15:00:00,1.234,1.230,...";
        match = re.search(r'="(.*)"', text)
        if match and match.group(1):
            parts = match.group(1).split(',')
            if len(parts) >= 8:
                return {
                    # parts[0] is name (GBK), often garbled in utf-8 env, ignore it
                    "estimate": float(parts[2]),
                    "nav": float(parts[3]),
                    "estRate": float(parts[6]),
                    "time": f"{parts[7]} {parts[1]}"
                }
    except Exception as e:
        print(f"Sina Valuation API error for {code}: {e}")
    return {}


def _get_global_setting(key: str, default: str) -> str:
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ? AND user_id IS NULL", (key,))
        row = cursor.fetchone()
        if row and row["value"] not in (None, ""):
            return str(row["value"])
    except Exception:
        pass
    finally:
        if conn:
            conn.close()
    return default


def _estimate_stock_exposure(fund_type: str, concentration_rate: float, holdings_count: int) -> float:
    """动态估计 stock_exposure（股票仓位）。"""
    ft = (fund_type or "").strip()
    if ft.startswith("货币") or "货币" in ft:
        return 0.0

    # 口径约束：混合一级债基视作“无股票仓位”；二级债基才重点核验权益暴露。
    is_primary_bond = any(k in ft for k in ["一级债", "混合一级债"]) or ft.startswith("债券型-长债")
    is_secondary_bond = any(k in ft for k in ["二级债", "混合二级债"])
    is_debt_fund = ("债" in ft and "可转债" not in ft)

    if is_primary_bond:
        return 0.0

    if is_secondary_bond:
        # 二级债基通常含一定权益敞口，但披露可能不完整，给一个偏保守基线。
        base = 0.12
    elif is_debt_fund:
        # 纯债/一级债以外的债券类默认按接近零权益处理。
        base = 0.02
    elif "QDII" in ft or "股票" in ft or "偏股" in ft or "指数" in ft or "混合" in ft:
        base = 0.88
    elif "商品" in ft or "REIT" in ft or "Reits" in ft:
        base = 0.75
    else:
        base = 0.65

    # 持仓集中度越高，说明披露更完整，股票暴露可上调；反之保守
    depth_adj = min(max((concentration_rate - 40.0) / 100.0, -0.2), 0.12)
    count_adj = 0.03 if holdings_count >= 15 else (-0.05 if holdings_count <= 5 else 0.0)
    exposure = min(max(base + depth_adj + count_adj, 0.0), 0.98)

    # 仅对二级债基做“明细反推”下限，避免出现“有股票明细却权益=0%”
    if is_secondary_bond and holdings_count > 0 and concentration_rate > 0:
        inferred_floor = min(max((concentration_rate / 100.0) * 2.2, 0.03), 0.35)
        exposure = max(exposure, inferred_floor)

    return round(exposure, 4)


def _is_convertible_bond_holding(code: str, name: str) -> bool:
    """识别可转债持仓（用于单独估算转债暴露）。"""
    n = (name or "").strip()
    c = re.sub(r"\D", "", str(code or "").strip())

    if "转债" in n:
        return True

    # A股可转债常见代码段（上海11/113/118，深圳12/123/127/128/11x/12x）
    if len(c) == 6 and (c.startswith("11") or c.startswith("12")):
        return True
    if len(c) == 6 and c.startswith(("113", "118", "123", "127", "128", "111")):
        return True

    return False


def _compute_holdings_timeliness_decay(holdings_df: pd.DataFrame, half_life_days: int = 120) -> Tuple[float, int]:
    """持仓披露时效衰减，返回 decay 与 age_days。"""
    if holdings_df is None or holdings_df.empty:
        return 0.55, 240

    report_col = None
    for col in ["报告期", "季度", "截止日期", "公告日期", "报告日期"]:
        if col in holdings_df.columns:
            report_col = col
            break

    if not report_col:
        return 0.7, 150

    latest_dt = None
    for v in holdings_df[report_col].dropna().tolist():
        s = str(v).strip()
        m = re.search(r"(\d{4})[-/年]?(\d{1,2})[-/月]?(\d{1,2})?", s)
        if not m:
            continue
        y = int(m.group(1))
        mm = int(m.group(2)) if m.group(2) else 1
        dd = int(m.group(3)) if m.group(3) else 1
        try:
            d = datetime(y, mm, dd)
            if latest_dt is None or d > latest_dt:
                latest_dt = d
        except Exception:
            continue

    if latest_dt is None:
        return 0.65, 180

    age_days = max((datetime.now() - latest_dt).days, 0)
    decay = math.exp(-math.log(2) * age_days / max(half_life_days, 30))
    return round(float(min(max(decay, 0.25), 1.0)), 4), age_days


def _get_recent_calibration(code: str, lookback_days: int = 20) -> Dict[str, Any]:
    """基于最近N日收盘误差做在线 bias/scale 校准。"""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT s.date AS date, s.estimate AS estimate, h.nav AS nav
            FROM (
                SELECT fund_code, date, estimate
                FROM fund_intraday_snapshots
                WHERE fund_code = ?
                  AND time = (
                      SELECT MAX(time)
                      FROM fund_intraday_snapshots s2
                      WHERE s2.fund_code = ? AND s2.date = fund_intraday_snapshots.date
                  )
                ORDER BY date DESC
                LIMIT ?
            ) s
            JOIN fund_history h
              ON h.code = s.fund_code AND h.date = s.date
            ORDER BY s.date ASC
        """, (code, code, lookback_days))
        rows = cursor.fetchall()

        if not rows or len(rows) < 5:
            return {"bias": 0.0, "scale": 1.0, "samples": len(rows) if rows else 0, "mae": None, "direction_acc": None}

        xs = [float(r["estimate"]) for r in rows]
        ys = [float(r["nav"]) for r in rows]

        mean_x = sum(xs) / len(xs)
        mean_y = sum(ys) / len(ys)
        var_x = sum((x - mean_x) ** 2 for x in xs)
        cov_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))

        scale = cov_xy / var_x if var_x > 1e-12 else 1.0
        scale = float(min(max(scale, 0.95), 1.05))
        bias = float(mean_y - scale * mean_x)

        errs = [abs((scale * x + bias) - y) / y * 100.0 for x, y in zip(xs, ys) if y > 0]
        mae = sum(errs) / len(errs) if errs else None

        dir_hit = 0
        dir_total = 0
        for i in range(1, len(xs)):
            pred_ret = (scale * xs[i] + bias) - (scale * xs[i - 1] + bias)
            act_ret = ys[i] - ys[i - 1]
            if abs(act_ret) < 1e-12:
                continue
            dir_total += 1
            if pred_ret * act_ret > 0:
                dir_hit += 1
        direction_acc = (dir_hit / dir_total * 100.0) if dir_total > 0 else None

        return {
            "bias": round(bias, 8),
            "scale": round(scale, 8),
            "samples": len(xs),
            "mae": round(mae, 4) if mae is not None else None,
            "direction_acc": round(direction_acc, 2) if direction_acc is not None else None,
        }
    except Exception as e:
        logger.warning(f"Calibration compute failed for {code}: {e}")
        return {"bias": 0.0, "scale": 1.0, "samples": 0, "mae": None, "direction_acc": None}
    finally:
        if conn:
            conn.close()


def _get_time_bucket(hhmm: str | None = None) -> str:
    try:
        t = hhmm or time.strftime("%H:%M")
        hh, mm = t.split(":")[:2]
        v = int(hh) * 60 + int(mm)
    except Exception:
        v = 14 * 60

    if 9 * 60 + 30 <= v < 10 * 60:
        return "open"
    if 10 * 60 <= v < 11 * 60 + 30:
        return "morning"
    if 13 * 60 <= v < 14 * 60 + 30:
        return "afternoon"
    if 14 * 60 + 30 <= v <= 15 * 60 + 5:
        return "close"
    return "off"


def _build_profile_from_eval(code: str, fund_type: str, lookback_days: int = 30) -> Dict[str, Any]:
    """构建基金画像（自动）：风险等级、漂移状态、分时偏差。"""
    profile = {
        "code": code,
        "fundType": fund_type or "未知",
        "riskLevel": "B",
        "driftState": "two_sided",
        "regime": "normal",
        "bucketBiasPct": {"open": 0.0, "morning": 0.0, "afternoon": 0.0, "close": 0.0},
        "dataQuality": "normal",
        "samples": 0,
    }

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT mae, direction_acc, close_error, bias, scale, samples
            FROM fund_model_eval_daily
            WHERE code = ?
            ORDER BY trade_date DESC
            LIMIT ?
        """, (code, max(5, lookback_days)))
        eval_rows = cursor.fetchall() or []

        cursor.execute("""
            SELECT date, time, estimate
            FROM fund_intraday_snapshots
            WHERE fund_code = ?
            ORDER BY date DESC, time DESC
            LIMIT 400
        """, (code,))
        snaps = cursor.fetchall() or []

        cursor.execute("""
            SELECT date, nav
            FROM fund_history
            WHERE code = ?
            ORDER BY date DESC
            LIMIT 90
        """, (code,))
        nav_rows = cursor.fetchall() or []

        profile["samples"] = len(eval_rows)

        if eval_rows:
            maes = [float(r["mae"]) for r in eval_rows if r["mae"] is not None]
            dirs = [float(r["direction_acc"]) for r in eval_rows if r["direction_acc"] is not None]
            biases = [float(r["bias"]) for r in eval_rows if r["bias"] is not None]
            close_err = [float(r["close_error"]) for r in eval_rows if r["close_error"] is not None]

            mae_avg = (sum(maes) / len(maes)) if maes else 1.2
            dir_avg = (sum(dirs) / len(dirs)) if dirs else 50.0
            bias_avg = (sum(biases) / len(biases)) if biases else 0.0

            if mae_avg <= 0.5 and dir_avg >= 62:
                profile["riskLevel"] = "A"
            elif mae_avg <= 1.2 and dir_avg >= 52:
                profile["riskLevel"] = "B"
            else:
                profile["riskLevel"] = "C"

            if abs(bias_avg) < 0.002:
                profile["driftState"] = "two_sided"
            elif bias_avg > 0:
                profile["driftState"] = "under_estimate"
            else:
                profile["driftState"] = "over_estimate"

            if close_err:
                ce_avg = sum(close_err) / len(close_err)
                if ce_avg >= 2.0:
                    profile["regime"] = "extreme"
                elif ce_avg >= 1.2:
                    profile["regime"] = "volatile"

        if snaps and nav_rows:
            nav_map = {str(r["date"]): float(r["nav"]) for r in nav_rows if r["nav"] is not None and float(r["nav"]) > 0}
            bucket_errs: Dict[str, List[float]] = {"open": [], "morning": [], "afternoon": [], "close": []}
            for s in snaps:
                d = str(s["date"])
                if d not in nav_map:
                    continue
                nav = nav_map[d]
                est = float(s["estimate"])
                if nav <= 0 or est <= 0:
                    continue
                b = _get_time_bucket(str(s["time"]))
                if b in bucket_errs:
                    bucket_errs[b].append((est - nav) / nav * 100.0)
            for k, arr in bucket_errs.items():
                if arr:
                    profile["bucketBiasPct"][k] = round(sum(arr) / len(arr), 4)

        if "QDII" in (fund_type or ""):
            profile["dataQuality"] = "fx_sensitive"
        elif "债" in (fund_type or ""):
            profile["dataQuality"] = "stable"

        cursor.execute("""
            INSERT OR REPLACE INTO fund_model_profile
            (code, profile_json, risk_level, drift_state, regime, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            code,
            json.dumps(profile, ensure_ascii=False),
            profile["riskLevel"],
            profile["driftState"],
            profile["regime"],
        ))
        conn.commit()
    except Exception as e:
        logger.warning(f"profile build failed for {code}: {e}")
    finally:
        if conn:
            conn.close()

    return profile


def _get_profile(code: str, fund_type: str) -> Dict[str, Any]:
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT profile_json, updated_at FROM fund_model_profile WHERE code=?", (code,))
        row = cursor.fetchone()
        if row and row["profile_json"]:
            try:
                p = json.loads(row["profile_json"])
                upd = row["updated_at"]
                is_stale = True
                if upd:
                    try:
                        dt = datetime.strptime(str(upd)[:19], "%Y-%m-%d %H:%M:%S")
                        is_stale = (datetime.now() - dt).total_seconds() > 86400
                    except Exception:
                        is_stale = True
                if not is_stale:
                    return p
            except Exception:
                pass
    except Exception:
        pass
    finally:
        if conn:
            conn.close()

    return _build_profile_from_eval(code, fund_type)


def _compute_profile_correction(code: str, fund_type: str, estimate: float, nav: float, calib: Dict[str, Any], spread: float) -> Dict[str, Any]:
    """画像驱动纠偏：返回 level/reasons/修正参数。"""
    profile = _get_profile(code, fund_type)
    bucket = _get_time_bucket()
    bucket_bias_pct = float(profile.get("bucketBiasPct", {}).get(bucket, 0.0) or 0.0)

    calib_mae = float(calib.get("mae") or 1.4)
    spread_pct = (spread / max(estimate, 1e-6)) * 100.0 if estimate > 0 else 0.0

    level = "L1"
    reasons = []
    if profile.get("riskLevel") == "C" or calib_mae >= 1.4 or spread_pct >= 1.2:
        level = "L2"
    if profile.get("regime") == "extreme" or spread_pct >= 2.2 or calib_mae >= 2.2:
        level = "L3"

    if abs(bucket_bias_pct) >= 0.08:
        reasons.append("time_bucket_bias")
    if spread_pct >= 1.0:
        reasons.append("source_divergence")
    if profile.get("dataQuality") == "fx_sensitive":
        reasons.append("fx_sensitive")

    bias_adj = -bucket_bias_pct / 100.0 * max(nav, estimate)
    scale_adj = 1.0
    nav_blend = 0.0
    confidence_penalty = 0.0

    if level == "L2":
        scale_adj = 0.998 if bucket_bias_pct > 0 else 1.002
        confidence_penalty = 8.0
    elif level == "L3":
        nav_blend = 0.35
        confidence_penalty = 18.0

    # 保存每日动作（审计）
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        trade_date = datetime.now().strftime("%Y-%m-%d")
        cursor.execute("""
            INSERT OR REPLACE INTO fund_model_correction_daily
            (code, trade_date, level, reason_codes, bucket, bias_adj, scale_adj, nav_blend, confidence_penalty, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            code,
            trade_date,
            level,
            ",".join(reasons),
            bucket,
            float(bias_adj),
            float(scale_adj),
            float(nav_blend),
            float(confidence_penalty),
        ))
        conn.commit()
        conn.close()
    except Exception:
        pass

    return {
        "profile": profile,
        "bucket": bucket,
        "level": level,
        "reasons": reasons,
        "biasAdj": bias_adj,
        "scaleAdj": scale_adj,
        "navBlend": nav_blend,
        "confidencePenalty": confidence_penalty,
    }


def _apply_tick_guard(code: str, estimate: float, nav: float) -> Tuple[float, Dict[str, Any]]:
    """异常点检测与限速（脏tick防护）。"""
    now = time.time()
    max_jump_pct = float(_get_global_setting("MODEL_TICK_MAX_JUMP_PCT", "2.8"))
    max_slope_pct_per_min = float(_get_global_setting("MODEL_TICK_MAX_SLOPE_PCT_PER_MIN", "0.9"))

    state = _TICK_GUARD_STATE.get(code)
    flags = {"dirty": False, "rate_limited": False}

    if estimate <= 0 or nav <= 0:
        flags["dirty"] = True
        if state and state.get("estimate", 0) > 0:
            return float(state["estimate"]), flags
        return max(nav, 0.0), flags

    if state and state.get("estimate", 0) > 0:
        prev_est = float(state["estimate"])
        prev_ts = float(state.get("ts", now))
        dt_min = max((now - prev_ts) / 60.0, 1 / 60.0)
        delta_pct = abs((estimate - prev_est) / prev_est) * 100.0 if prev_est > 0 else 0.0

        if delta_pct > max_jump_pct:
            flags["dirty"] = True

        max_step_pct = max_slope_pct_per_min * dt_min
        allowed_hi = prev_est * (1 + max_step_pct / 100.0)
        allowed_lo = prev_est * (1 - max_step_pct / 100.0)
        adjusted = min(max(estimate, allowed_lo), allowed_hi)
        if abs(adjusted - estimate) > 1e-12:
            flags["rate_limited"] = True
        estimate = adjusted

    _TICK_GUARD_STATE[code] = {"estimate": float(estimate), "ts": now}
    return float(estimate), flags


def get_combined_valuation(code: str) -> Dict[str, Any]:
    """
    多源融合基金估值（含在线校准、异常点防护、置信度评分）。
    """
    now = time.time()
    cached = _VALUATION_CACHE.get(code)
    if cached and now - cached.get("ts", 0) <= _VALUATION_CACHE_TTL_SECONDS:
        return cached["data"]

    def _cache_and_return(payload: Dict[str, Any]) -> Dict[str, Any]:
        _VALUATION_CACHE[code] = {"ts": time.time(), "data": payload}
        return payload

    candidates = []
    local_fallback = None
    fund_name = code
    nav_val = 0.0
    nav_date = None

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM funds WHERE code = ?", (code,))
        row_name = cursor.fetchone()
        if row_name and row_name["name"]:
            fund_name = row_name["name"]
        cursor.execute("SELECT date, nav FROM fund_history WHERE code = ? ORDER BY date DESC LIMIT 1", (code,))
        row_nav = cursor.fetchone()
        conn.close()

        if row_nav:
            nav_val = float(row_nav["nav"])
            nav_date = row_nav["date"]
            local_fallback = {
                "name": fund_name,
                "nav": nav_val,
                "navDate": nav_date,
                "estimate": nav_val,
                "estRate": 0.0,
                "time": "--",
                "source": "local_cache",
            }
            candidates.append({"source": "local_cache", "estimate": nav_val, "weight": 0.15})
    except Exception:
        pass

    em_data = get_eastmoney_valuation(code)
    if em_data and em_data.get("estimate") and em_data.get("estimate") > 0:
        candidates.append({"source": "eastmoney", "estimate": float(em_data["estimate"]), "weight": 0.58, "raw": em_data})
        if em_data.get("name"):
            fund_name = em_data.get("name")
        nav_val = float(em_data.get("nav") or nav_val or 0.0)

    sina_data = get_sina_valuation(code)
    if sina_data and sina_data.get("estimate") and sina_data.get("estimate") > 0:
        candidates.append({"source": "sina", "estimate": float(sina_data["estimate"]), "weight": 0.27, "raw": sina_data})
        nav_val = float(sina_data.get("nav") or nav_val or 0.0)

    if len(candidates) <= 1:
        try:
            from .estimate import estimate_nav
            history = get_fund_history(code, limit=30)
            if history and len(history) >= 2:
                ml_result = estimate_nav(code, history)
                if ml_result and ml_result.get("estimate"):
                    candidates.append({"source": "ml_estimate", "estimate": float(ml_result["estimate"]), "weight": 0.12, "raw": ml_result})
                    if not nav_val and history:
                        nav_val = float(history[-1]["nav"])
                        nav_date = history[-1]["date"]
        except Exception as e:
            logger.error(f"Custom estimation failed for {code}: {e}")

    if not candidates:
        if local_fallback:
            return _cache_and_return({"code": code, **local_fallback, "confidence": 35.0, "confidenceDetail": {"source": 0.3}})
        return _cache_and_return({"code": code, "name": fund_name, "nav": 0, "estimate": 0, "estRate": 0, "confidence": 20.0})

    weight_sum = sum(max(float(c.get("weight", 0.0)), 0.0) for c in candidates)
    if weight_sum <= 1e-12:
        weight_sum = 1.0

    fused_estimate = sum(float(c["estimate"]) * float(c.get("weight", 0.0)) for c in candidates) / weight_sum
    spread = max(c["estimate"] for c in candidates) - min(c["estimate"] for c in candidates) if len(candidates) > 1 else 0.0

    # 在线误差校准（bias/scale）
    calib_days = int(_get_global_setting("MODEL_CALIBRATION_LOOKBACK_DAYS", "20"))
    calib = _get_recent_calibration(code, lookback_days=max(5, calib_days))
    calibrated_estimate = fused_estimate * float(calib.get("scale", 1.0)) + float(calib.get("bias", 0.0))

    if nav_val <= 0:
        nav_val = calibrated_estimate

    fund_type = get_fund_type(code, fund_name)
    correction = _compute_profile_correction(
        code=code,
        fund_type=fund_type,
        estimate=calibrated_estimate,
        nav=nav_val,
        calib=calib,
        spread=spread,
    )

    corrected_estimate = (calibrated_estimate + float(correction.get("biasAdj", 0.0))) * float(correction.get("scaleAdj", 1.0))
    nav_blend = float(correction.get("navBlend", 0.0))
    if nav_blend > 0 and nav_val > 0:
        corrected_estimate = corrected_estimate * (1.0 - nav_blend) + nav_val * nav_blend

    guarded_estimate, tick_guard = _apply_tick_guard(code, corrected_estimate, nav_val)

    est_rate = ((guarded_estimate - nav_val) / nav_val * 100.0) if nav_val > 0 else 0.0
    update_time = em_data.get("time") if em_data else (sina_data.get("time") if sina_data else time.strftime("%H:%M"))

    source_score = max(0.0, 1.0 - (spread / max(guarded_estimate, 1e-6)) * 8.0)
    calibration_score = max(0.0, 1.0 - ((calib.get("mae") or 1.2) / 1.5))
    anomaly_penalty = 0.35 if tick_guard.get("dirty") else (0.18 if tick_guard.get("rate_limited") else 0.0)
    profile_penalty = float(correction.get("confidencePenalty", 0.0)) / 100.0
    confidence = max(5.0, min(99.0, (0.48 * source_score + 0.42 * calibration_score + 0.10 * (1.0 - anomaly_penalty) - profile_penalty) * 100.0))

    payload = {
        "code": code,
        "name": fund_name,
        "nav": float(nav_val),
        "navDate": nav_date,
        "estimate": round(float(guarded_estimate), 6),
        "estRate": round(float(est_rate), 4),
        "time": update_time,
        "source": "weighted_fusion",
        "sources": [{"name": c["source"], "estimate": round(float(c["estimate"]), 6), "weight": float(c.get("weight", 0.0))} for c in candidates],
        "calibration": calib,
        "tickGuard": tick_guard,
        "modelProfile": correction.get("profile", {}),
        "correction": {
            "level": correction.get("level"),
            "bucket": correction.get("bucket"),
            "reasonCodes": correction.get("reasons", []),
            "biasAdj": round(float(correction.get("biasAdj", 0.0)), 8),
            "scaleAdj": round(float(correction.get("scaleAdj", 1.0)), 8),
            "navBlend": round(float(correction.get("navBlend", 0.0)), 4),
        },
        "confidence": round(float(confidence), 2),
        "confidenceDetail": {
            "source_consistency": round(source_score * 100.0, 2),
            "calibration_quality": round(calibration_score * 100.0, 2),
            "anomaly_penalty": round(anomaly_penalty * 100.0, 2),
            "profile_penalty": round(profile_penalty * 100.0, 2),
        },
    }
    return _cache_and_return(payload)


def search_funds(q: str) -> List[Dict[str, Any]]:
    """
    Search funds by keyword using local SQLite DB.
    Supports both code and name search.
    Results are ordered by relevance: exact code match > code prefix > name match
    """
    if not q:
        return []

    q_clean = q.strip()
    pattern = f"%{q_clean}%"
    prefix_pattern = f"{q_clean}%"

    conn = get_db_connection()
    cursor = conn.cursor()

    try:
        cursor.execute("""
            SELECT code, name, type,
                CASE
                    WHEN code = ? THEN 1
                    WHEN code LIKE ? THEN 2
                    WHEN name LIKE ? THEN 3
                    ELSE 4
                END as relevance
            FROM funds
            WHERE code LIKE ? OR name LIKE ?
            ORDER BY relevance, code
            LIMIT 30
        """, (q_clean, prefix_pattern, pattern, pattern, pattern))

        rows = cursor.fetchall()

        results = []
        for row in rows:
            results.append({
                "id": str(row["code"]),
                "name": row["name"],
                "type": row["type"] or "未知"
            })
        return results
    finally:
        conn.close()


def get_eastmoney_pingzhong_data(code: str) -> Dict[str, Any]:
    """
    Fetch static detailed data from Eastmoney (PingZhongData).
    """
    url = Config.EASTMONEY_DETAILED_API_URL.format(code=code)
    try:
        response = _get_http_session().get(url, timeout=4.5)
        if response.status_code == 200:
            text = response.text
            data = {}
            name_match = re.search(r'fS_name\s*=\s*"(.*?)";', text)
            if name_match: data["name"] = name_match.group(1)
            
            code_match = re.search(r'fS_code\s*=\s*"(.*?)";', text)
            if code_match: data["code"] = code_match.group(1)
            
            manager_match = re.search(r'Data_currentFundManager\s*=\s*(\[.+?\])\s*;\s*/\*', text)
            if manager_match:
                try:
                    managers = json.loads(manager_match.group(1))
                    if managers:
                        data["manager"] = ", ".join([m["name"] for m in managers])
                except:
                    pass

            # Extract Performance Metrics
            for key in ["syl_1n", "syl_6y", "syl_3y", "syl_1y"]:
                m = re.search(rf'{key}\s*=\s*"(.*?)";', text)
                if m: data[key] = m.group(1)

            # Extract Performance Evaluation (Capability Scores)
            # var Data_performanceEvaluation = {"avr":"72.25","categories":[...],"data":[80.0,70.0...]};
            # Match until `};`
            perf_match = re.search(r'Data_performanceEvaluation\s*=\s*(\{.+?\})\s*;\s*/\*', text)
            if perf_match:
                try:
                    perf = json.loads(perf_match.group(1))
                    if perf and "data" in perf and "categories" in perf:
                        data["performance"] = dict(zip(perf["categories"], perf["data"]))
                except:
                    pass

            # Extract Full History (Data_netWorthTrend)
            # var Data_netWorthTrend = [{"x":1536076800000,"y":1.0,...},...];
            history_match = re.search(r'Data_netWorthTrend\s*=\s*(\[.+?\])\s*;\s*/\*', text)
            if history_match:
                try:
                    raw_hist = json.loads(history_match.group(1))
                    # Convert to standard format: [{"date": "YYYY-MM-DD", "nav": 1.23}, ...]
                    # x is ms timestamp
                    data["history"] = [
                        {
                            "date": time.strftime('%Y-%m-%d', time.localtime(item['x']/1000)),
                            "nav": float(item['y'])
                        }
                        for item in raw_hist
                    ]
                except:
                    pass

            return data
    except Exception as e:
        print(f"PingZhong API error for {code}: {e}")
    return {}


def _get_fund_info_from_db(code: str) -> Dict[str, Any]:
    """
    Get fund basic info from local SQLite cache.
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name, type FROM funds WHERE code = ?", (code,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return {"name": row["name"], "type": row["type"]}
    except Exception as e:
        print(f"DB fetch error for {code}: {e}")
    return {}


def _fetch_stock_spots_sina(codes: List[str]) -> Dict[str, float]:
    """
    Fetch real-time stock prices from Sina API in batch.
    Supports A-share (sh/sz), HK (hk), US (gb_).
    """
    if not codes:
        return {}
    
    formatted = []
    # Map cleaned code back to original for result dict
    code_map = {} 
    
    for c in codes:
        if not c: continue
        c_str = str(c).strip()
        prefix = ""
        clean_c = c_str
        
        # Detect Market
        if c_str.isdigit():
            if len(c_str) == 6:
                # A-share
                prefix = "sh" if c_str.startswith(('60', '68', '90', '11')) else "sz"
            elif len(c_str) == 5:
                # HK
                prefix = "hk"
        elif c_str.isalpha():
            # US
            prefix = "gb_"
            clean_c = c_str.lower()
        
        if prefix:
            sina_code = f"{prefix}{clean_c}"
            formatted.append(sina_code)
            code_map[sina_code] = c_str
            
    if not formatted:
        return {}

    url = f"http://hq.sinajs.cn/list={','.join(formatted)}"
    headers = {"Referer": "http://finance.sina.com.cn"}
    
    try:
        response = _get_http_session().get(url, headers=headers, timeout=3.2)
        results = {}
        for line in response.text.strip().split('\n'):
            if not line or '=' not in line or '"' not in line: continue
            
            # var hq_str_sh600519="..."
            line_key = line.split('=')[0].split('_str_')[-1] # sh600519 or hk00700 or gb_nvda
            original_code = code_map.get(line_key)
            if not original_code: continue

            data_part = line.split('"')[1]
            if not data_part: continue
            parts = data_part.split(',')
            
            change = 0.0
            try:
                if line_key.startswith("gb_"):
                    # US: name, price, change_percent, ...
                    # Example: "英伟达,135.20,2.55,..."
                    if len(parts) > 2:
                        change = float(parts[2])
                elif line_key.startswith("hk"):
                    # HK: en, ch, open, prev_close, high, low, last, ...
                    if len(parts) > 6:
                        prev_close = float(parts[3])
                        last = float(parts[6])
                        if prev_close > 0:
                            change = round((last - prev_close) / prev_close * 100, 2)
                else:
                    # A-share: name, open, prev_close, last, ...
                    if len(parts) > 3:
                        prev_close = float(parts[2])
                        last = float(parts[3])
                        if prev_close > 0:
                            change = round((last - prev_close) / prev_close * 100, 2)
                
                results[original_code] = change
            except:
                continue
                
        return results
    except Exception as e:
        print(f"Sina fetch failed: {e}")
        return {}




def _fetch_stock_spots_tencent(codes: List[str]) -> Dict[str, float]:
    """Fetch stock spot changes from Tencent quote API (A-share fallback)."""
    if not codes:
        return {}

    formatted = []
    code_map = {}
    for c in codes:
        if not c:
            continue
        c_str = str(c).strip()
        if c_str.isdigit() and len(c_str) == 6:
            prefix = "sh" if c_str.startswith(('60', '68', '90', '11')) else "sz"
            q = f"{prefix}{c_str}"
            formatted.append(q)
            code_map[q] = c_str

    if not formatted:
        return {}

    url = f"http://qt.gtimg.cn/q={','.join(formatted)}"
    try:
        response = _get_http_session().get(url, timeout=3.2)
        text = response.text or ""
        results = {}
        for line in text.strip().split(';'):
            if '="' not in line:
                continue
            left, right = line.split('="', 1)
            quote_key = left.split('v_')[-1]
            payload = right.rstrip('"')
            parts = payload.split('~')
            original_code = code_map.get(quote_key)
            if not original_code or len(parts) < 5:
                continue
            try:
                last = float(parts[3])
                prev_close = float(parts[4])
                if prev_close > 0:
                    change = round((last - prev_close) / prev_close * 100, 2)
                    results[original_code] = change
            except Exception:
                continue
        return results
    except Exception as e:
        print(f"Tencent fetch failed: {e}")
        return {}


def _fetch_stock_spots(codes: List[str]) -> Dict[str, float]:
    """Smart auto-switch: race Sina/Tencent for A-share, keep Sina for HK/US, and remember faster provider briefly."""
    global _SINA_SPOT_FAIL_COUNT, _SINA_SPOT_COOLDOWN_UNTIL, _SPOT_PREFERRED_PROVIDER, _SPOT_PREFERRED_UNTIL

    if not codes:
        return {}

    now = time.time()
    a_share_codes = [c for c in codes if str(c).strip().isdigit() and len(str(c).strip()) == 6]
    other_codes = [c for c in codes if c not in a_share_codes]

    results = {}

    # HK/US still from Sina path
    if other_codes:
        results.update(_fetch_stock_spots_sina(other_codes))

    if not a_share_codes:
        return results

    # Forced cooldown to Tencent if Sina recently unhealthy
    if now < _SINA_SPOT_COOLDOWN_UNTIL:
        results.update(_fetch_stock_spots_tencent(a_share_codes))
        return results

    # Prefer previously faster provider for a short window
    if now < _SPOT_PREFERRED_UNTIL:
        primary = _fetch_stock_spots_sina if _SPOT_PREFERRED_PROVIDER == "sina" else _fetch_stock_spots_tencent
        backup = _fetch_stock_spots_tencent if primary is _fetch_stock_spots_sina else _fetch_stock_spots_sina
        primary_res = primary(a_share_codes)
        if primary_res:
            results.update(primary_res)
            return results
        backup_res = backup(a_share_codes)
        if backup_res:
            results.update(backup_res)
            return results

    # Smart race: launch both; take first non-empty, fallback to other within short budget
    with ThreadPoolExecutor(max_workers=2) as ex:
        fut_sina = ex.submit(_fetch_stock_spots_sina, a_share_codes)
        fut_tencent = ex.submit(_fetch_stock_spots_tencent, a_share_codes)
        done, pending = wait({fut_sina, fut_tencent}, timeout=3.0, return_when=FIRST_COMPLETED)

        winner_res = {}
        winner = None

        for fut in done:
            try:
                r = fut.result()
            except Exception:
                r = {}
            if r:
                winner_res = r
                winner = "sina" if fut is fut_sina else "tencent"
                break

        if not winner_res:
            # wait a bit more for the other one
            done2, _ = wait({fut_sina, fut_tencent}, timeout=3.0)
            for fut in done2:
                try:
                    r = fut.result()
                except Exception:
                    r = {}
                if r:
                    winner_res = r
                    winner = "sina" if fut is fut_sina else "tencent"
                    break

    if winner_res:
        _SPOT_PREFERRED_PROVIDER = winner or "sina"
        _SPOT_PREFERRED_UNTIL = time.time() + 300  # 5 min sticky preference
        if winner == "sina":
            _SINA_SPOT_FAIL_COUNT = 0
        else:
            _SINA_SPOT_FAIL_COUNT += 1
        results.update(winner_res)
        return results

    # Both failed
    _SINA_SPOT_FAIL_COUNT += 1
    if _SINA_SPOT_FAIL_COUNT >= _SINA_SPOT_FAIL_THRESHOLD:
        _SINA_SPOT_COOLDOWN_UNTIL = time.time() + _SINA_SPOT_COOLDOWN_SECONDS
        logger.warning("Sina stock spot slow/failing, switch to Tencent fallback for 10 minutes")

    return results


def get_fund_history(code: str, limit: int = 30) -> List[Dict[str, Any]]:
    """
    Get historical NAV data with database caching.
    If limit >= 9999, fetch all available history.
    """
    from ..db import get_db_connection
    import time

    # 1. Try to get from database cache first
    conn = get_db_connection()
    cursor = conn.cursor()

    # If limit is very large, get all data
    if limit >= 9999:
        cursor.execute("""
            SELECT date, nav, updated_at FROM fund_history
            WHERE code = ?
            ORDER BY date DESC
        """, (code,))
    else:
        cursor.execute("""
            SELECT date, nav, updated_at FROM fund_history
            WHERE code = ?
            ORDER BY date DESC
            LIMIT ?
        """, (code, limit))

    rows = cursor.fetchall()

    # Check if cache is fresh
    cache_valid = False
    if rows:
        latest_update = rows[0]["updated_at"]
        latest_nav_date = rows[0]["date"]
        # Parse timestamp
        try:
            from datetime import datetime
            update_time = datetime.fromisoformat(latest_update)
            age_hours = (datetime.now() - update_time).total_seconds() / 3600

            # Get today's date
            today_str = datetime.now().strftime("%Y-%m-%d")
            current_hour = datetime.now().hour

            # For "all history" requests, require more data to consider cache valid
            min_rows = 10 if limit < 9999 else 100

            # Cache invalidation logic:
            # 1. If it's after 16:00 on a trading day and cache doesn't have today's NAV, invalidate
            # 2. Otherwise, use 24-hour cache
            if current_hour >= 16 and latest_nav_date < today_str:
                # After 16:00, if we don't have today's NAV, force refresh
                cache_valid = False
            else:
                # Normal 24-hour cache
                cache_valid = age_hours < 24 and len(rows) >= min(limit, min_rows)
        except:
            pass

    if cache_valid:
        conn.close()
        # Reverse to ascending order (oldest to newest) for chart display
        return [{"date": row["date"], "nav": float(row["nav"])} for row in reversed(rows)]

    # 2. Cache miss or stale, fetch from API
    try:
        df = _run_with_timeout(ak.fund_open_fund_info_em, 6.0, symbol=code, indicator="单位净值走势")
        if df is None or df.empty:
            conn.close()
            return []

        # If limit < 9999, take only the most recent N records
        if limit < 9999:
            df = df.sort_values(by="净值日期", ascending=False).head(limit)

        # Sort ascending for chart display
        df = df.sort_values(by="净值日期", ascending=True)

        results = []
        for _, row in df.iterrows():
            d = row["净值日期"]
            date_str = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10]
            nav_value = float(row["单位净值"])
            results.append({"date": date_str, "nav": nav_value})

            # 3. Save to database cache
            cursor.execute("""
                INSERT OR REPLACE INTO fund_history (code, date, nav, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            """, (code, date_str, nav_value))

        conn.commit()
        conn.close()
        return results
    except Exception as e:
        print(f"History fetch error for {code}: {e}")
        conn.close()
        return []


def get_nav_on_date(code: str, date_str: str) -> float | None:
    """
    Get fund NAV on a specific date (YYYY-MM-DD). Used for T+1 confirm.
    Returns None if that date's NAV is not yet available.
    """
    history = get_fund_history(code, limit=90)
    for item in history:
        if item["date"][:10] == date_str[:10]:
            return item["nav"]
    return None


def _calculate_technical_indicators(history: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Calculate real technical indicators from NAV history.
    """
    if not history or len(history) < 10:
        return {
            "sharpe": "--",
            "volatility": "--",
            "max_drawdown": "--",
            "annual_return": "--"
        }
    
    try:
        import numpy as np
        # Convert to numpy array of NAVs
        navs = np.array([item['nav'] for item in history])
        
        # 1. Returns (Daily)
        daily_returns = np.diff(navs) / navs[:-1]
        
        # 2. Annualized Return
        total_return = (navs[-1] - navs[0]) / navs[0]
        # Approximate years based on history length
        years = len(history) / 250.0
        annual_return = (1 + total_return)**(1/years) - 1 if years > 0 else 0
        
        # 3. Annualized Volatility
        volatility = np.std(daily_returns) * np.sqrt(250)
        
        # 4. Sharpe Ratio (Risk-free rate = 2%)
        rf = 0.02
        sharpe = (annual_return - rf) / volatility if volatility > 0 else 0
        
        # 5. Max Drawdown
        # Running max
        rolling_max = np.maximum.accumulate(navs)
        drawdowns = (navs - rolling_max) / rolling_max
        max_drawdown = np.min(drawdowns)
        
        return {
            "sharpe": round(float(sharpe), 2),
            "volatility": f"{round(float(volatility) * 100, 2)}%",
            "max_drawdown": f"{round(float(max_drawdown) * 100, 2)}%",
            "annual_return": f"{round(float(annual_return) * 100, 2)}%"
        }
    except Exception as e:
        print(f"Indicator calculation error: {e}")
        return {
            "sharpe": "--",
            "volatility": "--",
            "max_drawdown": "--",
            "annual_return": "--"
        }

def _collect_target_funds_for_evaluation() -> List[str]:
    conn = get_db_connection()
    cursor = conn.cursor()

    codes = set()
    cursor.execute("SELECT DISTINCT code FROM positions WHERE shares > 0")
    for row in cursor.fetchall():
        codes.add(str(row["code"]).strip())

    # single-user watchlist
    cursor.execute("SELECT value FROM settings WHERE key='user_watchlist' AND user_id IS NULL")
    r = cursor.fetchone()
    if r and r["value"]:
        try:
            arr = json.loads(r["value"])
            for item in arr if isinstance(arr, list) else []:
                if isinstance(item, str):
                    codes.add(item.strip())
                elif isinstance(item, dict):
                    c = (item.get("id") or item.get("code") or "").strip()
                    if c:
                        codes.add(c)
        except Exception:
            pass

    conn.close()
    return sorted([c for c in codes if c])


def run_daily_model_evaluation(trade_date: str | None = None) -> Dict[str, Any]:
    """每日自动评估：MAE、方向命中率、收盘误差，结果落库。"""
    if trade_date is None:
        trade_date = datetime.now().strftime("%Y-%m-%d")

    lookback = int(_get_global_setting("MODEL_EVAL_LOOKBACK_DAYS", "20"))
    funds = _collect_target_funds_for_evaluation()
    if not funds:
        return {"date": trade_date, "evaluated": 0, "saved": 0}

    conn = get_db_connection()
    cursor = conn.cursor()
    saved = 0

    for code in funds:
        calib = _get_recent_calibration(code, lookback_days=max(5, lookback))

        cursor.execute("""
            SELECT s.date AS date, s.estimate AS estimate, h.nav AS nav
            FROM (
                SELECT fund_code, date, estimate
                FROM fund_intraday_snapshots
                WHERE fund_code = ?
                  AND time = (
                    SELECT MAX(time)
                    FROM fund_intraday_snapshots s2
                    WHERE s2.fund_code = ? AND s2.date = fund_intraday_snapshots.date
                  )
                ORDER BY date DESC
                LIMIT ?
            ) s
            JOIN fund_history h ON h.code = s.fund_code AND h.date = s.date
            ORDER BY s.date ASC
        """, (code, code, max(5, lookback)))
        rows = cursor.fetchall()
        if len(rows) < 3:
            continue

        errors = []
        hit = 0
        total = 0
        for i, r in enumerate(rows):
            pred = float(r["estimate"]) * float(calib.get("scale", 1.0)) + float(calib.get("bias", 0.0))
            act = float(r["nav"])
            if act > 0:
                errors.append(abs(pred - act) / act * 100.0)
            if i > 0:
                prev_pred = float(rows[i-1]["estimate"]) * float(calib.get("scale", 1.0)) + float(calib.get("bias", 0.0))
                prev_act = float(rows[i-1]["nav"])
                if (pred - prev_pred) * (act - prev_act) > 0:
                    hit += 1
                total += 1

        mae = sum(errors) / len(errors) if errors else None

        cursor.execute("SELECT estimate FROM fund_intraday_snapshots WHERE fund_code=? AND date=? ORDER BY time DESC LIMIT 1", (code, trade_date))
        est_row = cursor.fetchone()
        cursor.execute("SELECT nav FROM fund_history WHERE code=? AND date=?", (code, trade_date))
        nav_row = cursor.fetchone()
        close_error = None
        if est_row and nav_row and float(nav_row["nav"]) > 0:
            close_error = abs(float(est_row["estimate"]) - float(nav_row["nav"])) / float(nav_row["nav"]) * 100.0

        cursor.execute("""
            INSERT OR REPLACE INTO fund_model_calibration
            (code, bias, scale, mae, direction_acc, samples, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            code,
            float(calib.get("bias", 0.0)),
            float(calib.get("scale", 1.0)),
            float(calib.get("mae")) if calib.get("mae") is not None else mae,
            float(calib.get("direction_acc")) if calib.get("direction_acc") is not None else ((hit / total * 100.0) if total else None),
            int(calib.get("samples", len(rows))),
        ))

        cursor.execute("""
            INSERT OR REPLACE INTO fund_model_eval_daily
            (code, trade_date, mae, direction_acc, close_error, bias, scale, samples, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            code,
            trade_date,
            round(mae, 4) if mae is not None else None,
            round(hit / total * 100.0, 2) if total else None,
            round(close_error, 4) if close_error is not None else None,
            float(calib.get("bias", 0.0)),
            float(calib.get("scale", 1.0)),
            int(calib.get("samples", len(rows))),
        ))
        saved += 1

    conn.commit()
    conn.close()
    return {"date": trade_date, "evaluated": len(funds), "saved": saved}


def get_fund_intraday(code: str) -> Dict[str, Any]:
    """
    Get fund holdings + real-time valuation estimate.
    """
    req_started = time.time()

    def _budget_exceeded(limit_seconds: float) -> bool:
        return (time.time() - req_started) >= limit_seconds

    # 1) Get real-time valuation (Multi-source)
    em_data = get_combined_valuation(code)
    
    name = em_data.get("name")
    nav = float(em_data.get("nav", 0.0))
    estimate = float(em_data.get("estimate", 0.0))
    est_rate = float(em_data.get("estRate", 0.0))
    update_time = em_data.get("time", time.strftime("%H:%M:%S"))
    source = em_data.get("source")
    source_method = em_data.get("method")
    method = "proportional_extension"
    confidence = em_data.get("confidence")

    # 1.5) Enrich with detailed info (time-budget aware)
    # 避免详情页被上游卡死：对 PingZhong 再包一层硬超时
    pz_data = _run_with_timeout(get_eastmoney_pingzhong_data, 3.2, code) or {}
    extra_info = {}
    if pz_data.get("name"): extra_info["full_name"] = pz_data["name"]
    if pz_data.get("manager"): extra_info["manager"] = pz_data["manager"]
    for k in ["syl_1n", "syl_6y", "syl_3y", "syl_1y"]:
        if pz_data.get(k): extra_info[k] = pz_data[k]
    
    db_info = _get_fund_info_from_db(code)
    if db_info:
        if not extra_info.get("full_name"): extra_info["full_name"] = db_info["name"]
        extra_info["official_type"] = db_info["type"]

    if not name:
        name = extra_info.get("full_name", f"基金 {code}")
    manager = extra_info.get("manager", "--")

    # 2) Use history from PingZhong for Indicators（加缓存，避免重复算）
    tech_indicators = {}
    indi_cached = _INDICATOR_CACHE.get(code)
    now_ts = time.time()
    if indi_cached and (now_ts - indi_cached.get("ts", 0) <= _INDICATOR_CACHE_TTL_SECONDS):
        tech_indicators = indi_cached.get("data", {})
    else:
        # We take last 250 trading days (approx 1 year)
        history_data = pz_data.get("history", [])
        if history_data:
            # Indicators need 1 year
            tech_indicators = _calculate_technical_indicators(history_data[-250:])
        else:
            # 强制走本地历史兜底（主要是 SQLite 读取，成本可控）
            history_data = get_fund_history(code, limit=250)
            tech_indicators = _calculate_technical_indicators(history_data)
        _INDICATOR_CACHE[code] = {"data": tech_indicators, "ts": time.time()}

    # 3) Get holdings from AkShare + 时效衰减 + 残差篮子补全 + 动态股票仓位
    holdings = []
    concentration_rate = 0.0
    stock_exposure = 0.0
    cb_exposure = 0.0
    holdings_decay = 0.65
    holdings_age_days = 180
    residual_percent = 0.0
    residual_proxy = []

    # 先用30分钟缓存的“基础持仓结构”（名称/代码/比例/时效）；每次仅刷新涨跌幅
    base_cached = _HOLDINGS_BASE_CACHE.get(code)
    base_holdings = []
    if base_cached and (time.time() - base_cached.get("ts", 0) <= _HOLDINGS_BASE_CACHE_TTL_SECONDS):
        base_holdings = base_cached.get("items", []) or []
        concentration_rate = float(base_cached.get("concentration_rate", 0.0))
        holdings_decay = float(base_cached.get("holdings_decay", 0.65))
        holdings_age_days = int(base_cached.get("holdings_age_days", 180))

    try:
        if not base_holdings:
            holdings_df = None
            if not _budget_exceeded(7.0):
                current_year = str(time.localtime().tm_year)
                holdings_df = _run_with_timeout(ak.fund_portfolio_hold_em, 3.0, symbol=code, date=current_year)
                # 年初/当年未披露时，快速回退上一年（否则会出现持仓全空）
                if (holdings_df is None or holdings_df.empty) and not _budget_exceeded(5.8):
                    prev_year = str(time.localtime().tm_year - 1)
                    # 上一年持仓接口有时较慢，适当放宽一次，命中后走30分钟缓存
                    holdings_df = _run_with_timeout(ak.fund_portfolio_hold_em, 4.2, symbol=code, date=prev_year)

            if holdings_df is not None and not holdings_df.empty:
                holdings_df = holdings_df.copy()
                if "占净值比例" in holdings_df.columns:
                    holdings_df["占净值比例"] = (
                        holdings_df["占净值比例"].astype(str).str.replace("%", "", regex=False)
                    )
                    holdings_df["占净值比例"] = pd.to_numeric(holdings_df["占净值比例"], errors="coerce").fillna(0.0)

                def _select_latest_quarter(df: pd.DataFrame) -> pd.DataFrame:
                    if df is None or df.empty or "季度" not in df.columns:
                        return df
                    q_series = df["季度"].astype(str)
                    unique_quarters = [q for q in q_series.dropna().unique().tolist() if q and q != "nan"]
                    if not unique_quarters:
                        return df

                    def _quarter_sort_key(q: str):
                        m = re.search(r"(\d{4})年([1-4])季度", q)
                        if not m:
                            return (-1, -1)
                        return (int(m.group(1)), int(m.group(2)))

                    latest_quarter = max(unique_quarters, key=_quarter_sort_key)
                    return df[q_series == latest_quarter]

                latest_stock_df = _select_latest_quarter(holdings_df)

                # 额外拉取债券持仓（含可转债），避免仅股票口径漏掉转债明细
                bond_df = _run_with_timeout(ak.fund_portfolio_bond_hold_em, 3.5, symbol=code, date=current_year)
                if bond_df is None or bond_df.empty:
                    prev_year = str(time.localtime().tm_year - 1)
                    bond_df = _run_with_timeout(ak.fund_portfolio_bond_hold_em, 4.2, symbol=code, date=prev_year)

                latest_bond_df = None
                if bond_df is not None and not bond_df.empty:
                    bond_df = bond_df.copy()
                    if "占净值比例" in bond_df.columns:
                        bond_df["占净值比例"] = (
                            bond_df["占净值比例"].astype(str).str.replace("%", "", regex=False)
                        )
                        bond_df["占净值比例"] = pd.to_numeric(bond_df["占净值比例"], errors="coerce").fillna(0.0)
                    latest_bond_df = _select_latest_quarter(bond_df)

                merged_rows = []

                def _collect_rows(df: pd.DataFrame):
                    if df is None or df.empty:
                        return
                    for _, row in df.iterrows():
                        sec_code = str(
                            row.get("股票代码") or row.get("债券代码") or row.get("证券代码") or row.get("资产代码") or ""
                        ).strip()
                        sec_name = str(
                            row.get("股票名称") or row.get("债券名称") or row.get("证券名称") or row.get("资产名称") or ""
                        ).strip()
                        pct = float(row.get("占净值比例", 0.0))
                        if (not sec_code and not sec_name) or pct < 0.01:
                            continue
                        merged_rows.append({"code": sec_code, "name": sec_name, "percent": pct})

                _collect_rows(latest_stock_df)
                _collect_rows(latest_bond_df)
                merged_rows.sort(key=lambda x: x["percent"], reverse=True)

                concentration_rate = float(sum(item["percent"] for item in merged_rows[:10]))
                holdings_decay, holdings_age_days = _compute_holdings_timeliness_decay(latest_stock_df)

                seen_codes = set()
                for item in merged_rows:
                    sec_code = item["code"]
                    sec_name = item["name"]
                    percent = item["percent"]
                    dedup_key = sec_code or sec_name
                    if dedup_key in seen_codes:
                        continue
                    seen_codes.add(dedup_key)
                    base_holdings.append({
                        "code": sec_code,
                        "name": sec_name,
                        "percent": percent,
                        "isConvertibleBond": _is_convertible_bond_holding(sec_code, sec_name),
                    })

                base_holdings = base_holdings[:20]
                _HOLDINGS_BASE_CACHE[code] = {
                    "items": base_holdings,
                    "concentration_rate": concentration_rate,
                    "holdings_decay": holdings_decay,
                    "holdings_age_days": holdings_age_days,
                    "ts": time.time(),
                }

        # 每次请求都尽量刷新这20只的涨跌（比全量股票更快）
        stock_codes = [h.get("code") for h in base_holdings if h.get("code")]
        # 优先保证持仓涨跌可用：即使超预算也至少走一次腾讯快速兜底
        if stock_codes:
            if not _budget_exceeded(4.2):
                spot_map = _fetch_stock_spots(stock_codes)
            else:
                spot_map = _fetch_stock_spots_tencent(stock_codes[:30])
        else:
            spot_map = {}

        holdings = [{
            "name": h.get("name"),
            "percent": float(h.get("percent", 0.0)),
            "change": spot_map.get(h.get("code")),
            "isConvertibleBond": bool(h.get("isConvertibleBond", False)),
        } for h in base_holdings]
    except Exception as e:
        logger.warning(f"holdings parse failed for {code}: {e}")

    # 4) Determine sector/type
    sector = get_fund_type(code, name)
    major_category = get_fund_category(sector)

    cb_percent = sum(float(h.get("percent", 0.0)) for h in holdings if h.get("isConvertibleBond"))
    eq_percent = max(concentration_rate - cb_percent, 0.0)
    eq_count = sum(1 for h in holdings if not h.get("isConvertibleBond"))

    stock_exposure = _estimate_stock_exposure(sector, eq_percent, eq_count)
    cb_exposure = min(max(cb_percent / 100.0, 0.0), 0.6)
    total_risk_exposure = min(max(stock_exposure + cb_exposure, 0.0), 0.98)

    # 5) Top10 外残差篮子补全（按基金类型映射指数代理）
    residual_percent = max(stock_exposure * 100.0 - eq_percent, 0.0)
    proxy_codes = _FUND_PROXY_MAP.get(sector) or _FUND_PROXY_MAP.get(major_category) or _FUND_PROXY_MAP.get("偏股类", ["510300"])
    residual_spots = _fetch_stock_spots(proxy_codes) if (proxy_codes and not _budget_exceeded(4.5)) else {}
    # 仅在已有真实持仓时才展示残差篮子，避免页面只剩“残差代理”造成误导
    if residual_percent > 0.2 and proxy_codes and len(holdings) > 0:
        per_bucket = residual_percent / len(proxy_codes)
        for pcode in proxy_codes:
            residual_proxy.append({
                "name": f"残差篮子({pcode})",
                "percent": round(per_bucket, 2),
                "change": float(residual_spots.get(pcode, 0.0)),
                "isResidual": True,
            })
    
    holdings_with_residual = holdings + residual_proxy

    # 6) 用持仓实时涨跌（含可转债实时价格）对 estRate 做融合修正
    holdings_rate_num = 0.0
    holdings_rate_den = 0.0
    for h in holdings_with_residual:
        try:
            pct = float(h.get("percent", 0.0))
            chg = h.get("change")
            if chg is None:
                continue
            chg = float(chg)
            if pct <= 0:
                continue
            holdings_rate_num += pct * chg
            holdings_rate_den += pct
        except Exception:
            continue

    holdings_est_rate = (holdings_rate_num / 100.0) if holdings_rate_den > 0 else None
    # 以有效覆盖度决定融合强度，最多 65% 权重给持仓实时估算
    holdings_blend_weight = min(max(holdings_rate_den / 60.0, 0.0), 0.65)
    if holdings_est_rate is not None and holdings_rate_den >= 5.0:
        blended_est_rate = (1 - holdings_blend_weight) * float(est_rate) + holdings_blend_weight * float(holdings_est_rate)
        est_rate = round(float(blended_est_rate), 4)
        if nav and nav > 0:
            estimate = round(float(nav) * (1 + est_rate / 100.0), 6)

    # 7) 置信度评分（含组成项）
    fused_conf = float(confidence) if confidence is not None else 60.0
    calib = em_data.get("calibration") or {}
    calib_mae = calib.get("mae") if isinstance(calib, dict) else None
    calibration_score = max(0.0, 100.0 - (float(calib_mae) * 60.0 if calib_mae is not None else 35.0))
    composition = {
        "sourceFusion": round(fused_conf, 2),
        "holdingsTimeliness": round(holdings_decay * 100.0, 2),
        "coverage": round(min(100.0, (concentration_rate / max(total_risk_exposure * 100.0, 1e-6)) * 100.0), 2) if total_risk_exposure > 0 else 100.0,
        "calibration": round(calibration_score, 2),
        "tickGuard": 70.0 if (em_data.get("tickGuard") or {}).get("rate_limited") else 95.0,
    }
    total_conf = 0.34 * composition["sourceFusion"] + 0.22 * composition["holdingsTimeliness"] + 0.2 * composition["coverage"] + 0.18 * composition["calibration"] + 0.06 * composition["tickGuard"]

    response = {
        "id": str(code),
        "name": name,
        "type": sector,
        "category": major_category,
        "manager": manager,
        "nav": nav,
        "estimate": estimate,
        "estRate": est_rate,
        "time": update_time,
        "source": source,
        "method": method,
        "confidence": round(total_conf, 2),
        "confidenceDetail": composition,
        "holdings": holdings_with_residual,
        "modelMeta": {
            "holdingsDecay": holdings_decay,
            "holdingsAgeDays": holdings_age_days,
            "stockExposure": round(stock_exposure, 4),
            "cbExposure": round(cb_exposure, 4),
            "totalRiskExposure": round(total_risk_exposure, 4),
            "top10Concentration": round(concentration_rate, 2),
            "top10ConvertibleBondConcentration": round(cb_percent, 2),
            "residualBasketPercent": round(residual_percent, 2),
            "calibration": calib,
            "tickGuard": em_data.get("tickGuard"),
            "fusionSources": em_data.get("sources", []),
            "sourceMethod": source_method,
            "equityValuationMethod": "proportional_extension",
            "estRateFusion": "hybrid_realtime_holdings",
            "holdingsRealtimeCoverage": round(holdings_rate_den, 2),
            "holdingsRealtimeEstRate": round(float(holdings_est_rate), 4) if holdings_est_rate is not None else None,
            "holdingsBlendWeight": round(float(holdings_blend_weight), 4),
        },
        "indicators": {
            "returns": {
                "1M": extra_info.get("syl_1y", "--"),
                "3M": extra_info.get("syl_3y", "--"),
                "6M": extra_info.get("syl_6y", "--"),
                "1Y": extra_info.get("syl_1n", "--")
            },
            "concentration": round(concentration_rate, 2),
            "technical": tech_indicators
        }
    }
    return response