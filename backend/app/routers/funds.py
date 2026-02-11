import logging
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Body, Depends
from ..services.fund import search_funds, get_fund_intraday, get_fund_history, run_daily_model_evaluation, get_combined_valuation
from ..config import Config
from ..auth import User, get_current_user
from ..utils import get_user_id_for_query

from ..services.subscription import add_subscription

logger = logging.getLogger(__name__)
router = APIRouter()

# /api/fund/{id} short cache + stale-on-error fallback
_FUND_DETAIL_CACHE = {}
_FUND_DETAIL_INFLIGHT = {}
_FUND_DETAIL_LOCK = threading.Lock()
_FUND_DETAIL_CACHE_TTL = 60   # seconds（详情缓存加长，减少重复重算）
_FUND_DETAIL_STALE_TTL = 1800  # seconds（上游抖动时优先回旧值，提升可用性）

@router.get("/categories")
def get_fund_categories():
    """
    Get all unique fund categories from database.
    Returns major categories (simplified) sorted by frequency.
    """
    from ..db import db_connection

    with db_connection() as conn:
        cursor = conn.cursor()

        # Get all unique types with their counts
        cursor.execute("""
            SELECT type, COUNT(*) as count
            FROM funds
            WHERE type IS NOT NULL AND type != ''
            GROUP BY type
            ORDER BY count DESC
        """)

        rows = cursor.fetchall()

    # Map to major categories
    major_categories = {}
    for row in rows:
        fund_type = row["type"]
        count = row["count"]

        # Simplify to major categories
        if "股票" in fund_type or "偏股" in fund_type:
            major = "股票型"
        elif "混合" in fund_type:
            major = "混合型"
        elif "债" in fund_type:
            major = "债券型"
        elif "指数" in fund_type:
            major = "指数型"
        elif "QDII" in fund_type:
            major = "QDII"
        elif "货币" in fund_type:
            major = "货币型"
        elif "FOF" in fund_type:
            major = "FOF"
        elif "REITs" in fund_type or "Reits" in fund_type:
            major = "REITs"
        else:
            major = "其他"

        major_categories[major] = major_categories.get(major, 0) + count

    # Sort by count
    categories = sorted(major_categories.keys(), key=lambda x: major_categories[x], reverse=True)

    return {"categories": categories}

@router.get("/search")
def search(q: str = Query(..., min_length=1)):
    try:
        return search_funds(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _get_quote_payload(fund_id: str):
    now = time.time()
    cache_key = f"quote:{fund_id}"

    cached = _FUND_DETAIL_CACHE.get(cache_key)
    if cached and now - cached["ts"] <= _FUND_DETAIL_CACHE_TTL:
        return cached["data"]

    q = get_combined_valuation(fund_id)
    data = {
        "id": str(fund_id),
        "name": q.get("name") or str(fund_id),
        "estimate": float(q.get("estimate") or 0.0),
        "nav": float(q.get("nav") or 0.0),
        "estRate": float(q.get("estRate") or 0.0),
        "time": q.get("time") or "--:--",
        "source": q.get("source"),
        "trusted": True,
    }
    _FUND_DETAIL_CACHE[cache_key] = {"data": data, "ts": time.time()}
    return data

@router.get("/fund/{fund_id}/quote")
def fund_quote(fund_id: str):
    """轻量报价接口：仅返回卡片展示必要字段，避免首屏调用重型详情计算。"""
    now = time.time()
    try:
        return _get_quote_payload(fund_id)
    except Exception as e:
        cached = _FUND_DETAIL_CACHE.get(f"quote:{fund_id}")
        if cached and now - cached["ts"] <= _FUND_DETAIL_STALE_TTL:
            logger.warning(f"fund_quote {fund_id} upstream failed, serve stale cache: {e}")
            return cached["data"]
        raise HTTPException(status_code=502, detail=f"Upstream quote unavailable: {e}")

@router.get("/fund/quotes")
def fund_quotes(ids: str = Query(..., description="基金代码列表，逗号分隔，例如 161725,005827")):
    """批量轻量报价接口：用于关注列表轮询，减少 N 次 HTTP 往返。"""
    code_list = [c.strip() for c in (ids or "").split(",") if c.strip()]
    if not code_list:
        return {"items": []}

    code_list = code_list[:100]
    items = []

    max_workers = min(8, max(1, len(code_list)))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_get_quote_payload, code): code for code in code_list}
        for future in as_completed(futures):
            code = futures[future]
            now = time.time()
            try:
                items.append(future.result())
            except Exception as e:
                cached = _FUND_DETAIL_CACHE.get(f"quote:{code}")
                if cached and now - cached["ts"] <= _FUND_DETAIL_STALE_TTL:
                    logger.warning(f"fund_quotes {code} upstream failed, serve stale cache: {e}")
                    items.append(cached["data"])
                else:
                    logger.warning(f"fund_quotes {code} failed: {e}")
                    items.append({
                        "id": str(code),
                        "name": str(code),
                        "estimate": 0.0,
                        "nav": 0.0,
                        "estRate": 0.0,
                        "time": "--:--",
                        "source": "error",
                        "trusted": False,
                    })

    item_map = {str(i.get("id")): i for i in items}
    ordered = [item_map.get(code, {"id": code, "name": code, "estimate": 0.0, "nav": 0.0, "estRate": 0.0, "time": "--:--", "source": "missing", "trusted": False}) for code in code_list]
    return {"items": ordered}

@router.get("/fund/{fund_id}")
def fund_detail(fund_id: str):
    now = time.time()

    # 1) Fast-path cache hit
    cached = _FUND_DETAIL_CACHE.get(fund_id)
    if cached and now - cached["ts"] <= _FUND_DETAIL_CACHE_TTL:
        return cached["data"]

    owner = False
    with _FUND_DETAIL_LOCK:
        inflight = _FUND_DETAIL_INFLIGHT.get(fund_id)
        if inflight is None:
            inflight = threading.Event()
            _FUND_DETAIL_INFLIGHT[fund_id] = inflight
            owner = True

    if not owner:
        inflight.wait(timeout=6)
        cached = _FUND_DETAIL_CACHE.get(fund_id)
        if cached and now - cached["ts"] <= _FUND_DETAIL_STALE_TTL:
            return cached["data"]

    try:
        data = get_fund_intraday(fund_id)
        _FUND_DETAIL_CACHE[fund_id] = {"data": data, "ts": time.time()}
        return data
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        # 2) Stale-on-error fallback (avoid 502 storms)
        cached = _FUND_DETAIL_CACHE.get(fund_id)
        if cached and now - cached["ts"] <= _FUND_DETAIL_STALE_TTL:
            logger.warning(f"fund_detail {fund_id} upstream failed, serve stale cache: {e}")
            return cached["data"]
        # Upstream quote provider failure should be surfaced as 502 for frontend circuit breaker
        raise HTTPException(status_code=502, detail=f"Upstream valuation unavailable: {e}")
    finally:
        if owner:
            with _FUND_DETAIL_LOCK:
                event = _FUND_DETAIL_INFLIGHT.pop(fund_id, None)
                if event:
                    event.set()

@router.get("/fund/{fund_id}/history")
def fund_history(
    fund_id: str,
    limit: int = 30,
    account_id: int = Query(None),
    current_user: Optional[User] = Depends(get_current_user)
):
    """
    Get historical NAV data for charts.
    Optionally include transaction markers if account_id is provided (需要验证所有权).

    单用户模式：不需要认证，可以获取历史数据
    多用户模式：如果提供 account_id，需要验证所有权
    """
    try:
        history = get_fund_history(fund_id, limit=limit)

        # If account_id is provided, fetch transactions for this fund
        transactions = []
        if account_id:
            # 验证账户所有权（单用户模式和多用户模式都需要验证）
            from ..utils import verify_account_ownership
            verify_account_ownership(account_id, current_user)

            from ..db import db_connection
            with db_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT confirm_date, op_type, confirm_nav, amount_cny, shares_redeemed
                    FROM transactions
                    WHERE code = ? AND account_id = ? AND confirm_nav IS NOT NULL
                    ORDER BY confirm_date ASC
                """, (fund_id, account_id))

                for row in cursor.fetchall():
                    # Map op_type: "add" -> "buy", "reduce" -> "sell"
                    op_type = row["op_type"]
                    transaction_type = "buy" if op_type == "add" else "sell"

                    transactions.append({
                        "date": row["confirm_date"],
                        "type": transaction_type,
                        "nav": float(row["confirm_nav"]),
                        "amount": float(row["amount_cny"]) if row["amount_cny"] else None,
                        "shares": float(row["shares_redeemed"]) if row["shares_redeemed"] else None
                    })

        return {
            "history": history,
            "transactions": transactions
        }
    except Exception as e:
        # Don't break UI if history fails
        print(f"History error: {e}")
        return {"history": [], "transactions": []}

@router.get("/fund/{fund_id}/intraday")
def fund_intraday(fund_id: str, date: str = None):
    """
    Get intraday valuation snapshots for charts.
    Returns today's data by default.
    """
    from datetime import datetime
    from ..db import db_connection

    if not date:
        date = datetime.now().strftime("%Y-%m-%d")

    with db_connection() as conn:
        cursor = conn.cursor()

        # 0. Check if fund exists
        cursor.execute("SELECT 1 FROM funds WHERE code = ?", (fund_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Fund not found")

        # 1. Get previous day NAV
        cursor.execute("""
            SELECT nav FROM fund_history
            WHERE code = ? AND date < ?
            ORDER BY date DESC
            LIMIT 1
        """, (fund_id, date))
        row = cursor.fetchone()
        prev_nav = float(row["nav"]) if row else None

        # 2. Get intraday snapshots
        cursor.execute("""
            SELECT time, estimate FROM fund_intraday_snapshots
            WHERE fund_code = ? AND date = ?
            ORDER BY time ASC
        """, (fund_id, date))
        snapshots = [{"time": r["time"], "estimate": float(r["estimate"])} for r in cursor.fetchall()]

        # 3. Check whether this fund has meaningful historical intraday dates (for date picker UX)
        # Only show date picker when there is at least one prior date with >= 3 points.
        cursor.execute("""
            SELECT COUNT(*) AS cnt
            FROM (
                SELECT date, COUNT(*) AS points
                FROM fund_intraday_snapshots
                WHERE fund_code = ? AND date < ?
                GROUP BY date
                HAVING COUNT(*) >= 3
            ) t
        """, (fund_id, date))
        historical_day_count = int(cursor.fetchone()["cnt"] or 0)

        cursor.execute("""
            SELECT COUNT(DISTINCT date) AS cnt
            FROM fund_intraday_snapshots
            WHERE fund_code = ?
        """, (fund_id,))
        date_count = int(cursor.fetchone()["cnt"] or 0)

    return {
        "date": date,
        "prevNav": prev_nav,
        "snapshots": snapshots,
        "lastCollectedAt": snapshots[-1]["time"] if snapshots else None,
        "hasHistoricalIntraday": historical_day_count > 0,
        "intradayDateCount": date_count
    }

@router.get("/fund/{fund_id}/backtest")
def fund_backtest(fund_id: str, days: int = 20):
    """
    回测基金估值算法准确率

    Args:
        fund_id: 基金代码
        days: 回测天数（默认20天）

    Returns:
        回测结果，包括平均误差率、方向准确率等
    """
    from ..services.fund import get_fund_history
    from ..services.estimate import estimate_with_weighted_ma, estimate_with_simple_ma
    import statistics

    try:
        # 获取历史数据（需要额外的数据用于训练）
        history = get_fund_history(fund_id, limit=days + 30)

        if not history or len(history) < days + 10:
            raise HTTPException(
                status_code=400,
                detail=f"历史数据不足（需要至少 {days + 10} 天）"
            )

        results = []

        # 从倒数第 days 天开始，逐日预测并对比实际值
        for i in range(days, 0, -1):
            train_data = history[:-i]
            actual_nav = float(history[-i]["nav"])
            actual_date = history[-i]["date"]

            # 使用加权移动平均预测
            pred = estimate_with_weighted_ma(train_data)
            if pred:
                error = abs(pred["estimate"] - actual_nav)
                error_rate = (error / actual_nav) * 100

                # 计算实际涨跌幅
                prev_nav = float(train_data[-1]["nav"])
                actual_change = ((actual_nav - prev_nav) / prev_nav) * 100

                # 判断方向是否正确
                direction_correct = (
                    (pred["est_rate"] > 0 and actual_change > 0) or
                    (pred["est_rate"] < 0 and actual_change < 0) or
                    (pred["est_rate"] == 0 and actual_change == 0)
                )

                results.append({
                    "date": actual_date,
                    "actual": actual_nav,
                    "predicted": pred["estimate"],
                    "error_rate": round(error_rate, 3),
                    "direction_correct": direction_correct
                })

        if not results:
            raise HTTPException(status_code=500, detail="回测失败")

        # 统计结果
        error_rates = [r["error_rate"] for r in results]
        direction_correct_count = sum(1 for r in results if r["direction_correct"])

        within_05 = sum(1 for e in error_rates if e <= 0.5)
        within_10 = sum(1 for e in error_rates if e <= 1.0)
        within_20 = sum(1 for e in error_rates if e <= 2.0)

        return {
            "fund_id": fund_id,
            "test_days": len(results),
            "avg_error_rate": round(statistics.mean(error_rates), 3),
            "median_error_rate": round(statistics.median(error_rates), 3),
            "max_error_rate": round(max(error_rates), 3),
            "min_error_rate": round(min(error_rates), 3),
            "direction_accuracy": round((direction_correct_count / len(results)) * 100, 1),
            "error_distribution": {
                "within_0_5": round((within_05 / len(results)) * 100, 1),
                "within_1_0": round((within_10 / len(results)) * 100, 1),
                "within_2_0": round((within_20 / len(results)) * 100, 1)
            },
            "method": "weighted_ma"
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/fund-eval/daily-run")
def trigger_daily_eval(date: str = Query(None)):
    """手动触发每日估值评估并落库。"""
    try:
        result = run_daily_model_evaluation(trade_date=date)
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"daily eval failed: {e}")


@router.post("/fund/{fund_id}/subscribe")
def subscribe_fund(
    fund_id: str,
    data: dict = Body(...),
    current_user: Optional[User] = Depends(get_current_user)
):
    """
    订阅基金提醒

    Args:
        fund_id: 基金代码
        data: 订阅配置（email, thresholdUp, thresholdDown, enableDailyDigest, digestTime, enableVolatility）
        current_user: 当前用户（单用户模式为 None）

    Returns:
        dict: 成功消息
    """
    user_id = get_user_id_for_query(current_user)
    email = data.get("email")
    up = data.get("thresholdUp")
    down = data.get("thresholdDown")
    enable_digest = data.get("enableDailyDigest", False)
    digest_time = data.get("digestTime", "14:45")
    enable_volatility = data.get("enableVolatility", True)

    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    try:
        add_subscription(
            fund_id,
            email,
            user_id,  # 添加 user_id 参数
            float(up or 0),
            float(down or 0),
            enable_digest=enable_digest,
            digest_time=digest_time,
            enable_volatility=enable_volatility
        )
        return {"status": "ok", "message": "Subscription active"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Subscription failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save subscription")
