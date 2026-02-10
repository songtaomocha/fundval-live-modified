import os
import re
import datetime
import numpy as np
import pandas as pd
from typing import Optional, Dict, Any, List
from duckduckgo_search import DDGS
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import StrOutputParser

from ..config import Config
from .prompts import LINUS_FINANCIAL_ANALYSIS_PROMPT
from .fund import get_fund_history, _calculate_technical_indicators
from ..db import get_db_connection


class AIService:
    def __init__(self):
        # 不在初始化时创建 LLM，而是每次调用时动态创建
        pass

    def _get_prompt_template(self, prompt_id: Optional[int] = None, user_id: Optional[int] = None):
        """
        固定使用内置提示词模板（回退到旧版行为）。
        忽略数据库中的自定义模板，确保所有用户（含管理员）一致。
        """
        return LINUS_FINANCIAL_ANALYSIS_PROMPT

    def _init_llm(self, fast_mode=True, user_id: Optional[int] = None):
        # 每次调用时重新读取配置，支持热重载
        # 按 user_id 读取配置（多用户模式下支持继承管理员 AI 配置）
        from ..crypto import decrypt_value

        conn = get_db_connection()
        cursor = conn.cursor()

        settings = {}

        if user_id is None:
            # 单用户模式：读取 settings 表中 user_id IS NULL 的配置
            cursor.execute("""
                SELECT key, value, encrypted FROM settings
                WHERE user_id IS NULL
            """)
            rows = cursor.fetchall()
            for row in rows:
                key, value, encrypted = row
                if encrypted and value:
                    value = decrypt_value(value)
                settings[key] = value
        else:
            # 多用户模式：先读取当前用户配置
            cursor.execute("""
                SELECT key, value, encrypted FROM user_settings
                WHERE user_id = ?
            """, (user_id,))
            rows = cursor.fetchall()
            for row in rows:
                key, value, encrypted = row
                if encrypted and value:
                    value = decrypt_value(value)
                settings[key] = value

            # 若用户未单独配置 AI 参数，则继承管理员配置
            required_ai_keys = ["OPENAI_API_KEY", "OPENAI_API_BASE", "AI_MODEL_NAME"]
            missing_keys = [k for k in required_ai_keys if not settings.get(k)]

            if missing_keys:
                cursor.execute("""
                    SELECT us.key, us.value, us.encrypted
                    FROM user_settings us
                    JOIN users u ON u.id = us.user_id
                    WHERE u.is_admin = 1
                      AND us.key IN ('OPENAI_API_KEY', 'OPENAI_API_BASE', 'AI_MODEL_NAME')
                    ORDER BY u.id ASC
                """)
                admin_rows = cursor.fetchall()
                admin_settings = {}
                for row in admin_rows:
                    key, value, encrypted = row
                    if encrypted and value:
                        value = decrypt_value(value)
                    # 多管理员场景下，优先取最早管理员的数据
                    if key not in admin_settings:
                        admin_settings[key] = value

                for key in missing_keys:
                    if admin_settings.get(key):
                        settings[key] = admin_settings[key]

            # 再兜底：若仍缺失，使用系统级 settings（兼容历史数据）
            missing_keys = [k for k in required_ai_keys if not settings.get(k)]
            if missing_keys:
                cursor.execute("""
                    SELECT key, value, encrypted FROM settings
                    WHERE user_id IS NULL
                      AND key IN ('OPENAI_API_KEY', 'OPENAI_API_BASE', 'AI_MODEL_NAME')
                """)
                global_rows = cursor.fetchall()
                for row in global_rows:
                    key, value, encrypted = row
                    if encrypted and value:
                        value = decrypt_value(value)
                    if key in missing_keys and value:
                        settings[key] = value

        conn.close()

        api_base = settings.get("OPENAI_API_BASE") or "https://api.openai.com/v1"
        api_key = settings.get("OPENAI_API_KEY") or ""
        model = settings.get("AI_MODEL_NAME") or "gpt-3.5-turbo"

        if not api_key:
            return None

        return ChatOpenAI(
            model=model,
            openai_api_key=api_key,
            openai_api_base=api_base,
            temperature=0.3, # Linus needs to be sharp, not creative
            request_timeout=60 if fast_mode else 120
        )

    def search_news(self, query: str) -> str:
        try:
            # Simple wrapper to fetch news
            ddgs = DDGS(verify=False)
            results = ddgs.text(
                keywords=query,
                region="cn-zh",
                safesearch="off",
                timelimit="w", # last week
                max_results=5,
            )
            
            if not results:
                return "暂无相关近期新闻。"
            
            output = ""
            for i, res in enumerate(results, 1):
                output += f"{i}. {res.get('title')} - {res.get('body')}\n"
            return output
        except Exception as e:
            print(f"Search error: {e}")
            return "新闻搜索服务暂时不可用。"

    def _calculate_indicators(self, history: List[Dict[str, Any]]) -> Dict[str, str]:
        """
        Calculate simple technical indicators based on recent history.
        """
        if not history or len(history) < 5:
            return {"status": "数据不足", "desc": "新基金或数据缺失"}

        navs = [item['nav'] for item in history]
        current_nav = navs[-1]
        max_nav = max(navs)
        min_nav = min(navs)
        avg_nav = sum(navs) / len(navs)

        # Position in range
        position = (current_nav - min_nav) / (max_nav - min_nav) if max_nav > min_nav else 0.5

        status = "正常"
        if position > 0.9: status = "高位"
        elif position < 0.1: status = "低位"
        elif current_nav > avg_nav * 1.05: status = "偏高"
        elif current_nav < avg_nav * 0.95: status = "偏低"

        return {
            "status": status,
            "desc": f"近30日最高{max_nav:.4f}, 最低{min_nav:.4f}, 现价处于{'高位' if position>0.8 else '低位' if position<0.2 else '中位'}区间 ({int(position*100)}%)"
        }

    async def analyze_fund(self, fund_info: Dict[str, Any], prompt_id: Optional[int] = None, user_id: Optional[int] = None) -> Dict[str, Any]:
        # 每次调用时重新初始化 LLM，支持配置热重载
        llm = self._init_llm(user_id=user_id)

        if not llm:
            return {
                "markdown": "## 配置错误\n\n未配置 OpenAI API Key，请前往设置页面配置。",
                "indicators": {"status": "未知", "desc": "无法分析"},
                "timestamp": datetime.datetime.now().strftime("%H:%M:%S")
            }

        fund_id = fund_info.get("id")
        fund_name = fund_info.get("name", "未知基金")

        # 1. Gather Data
        # History (Last 250 days for technical indicators)
        history = get_fund_history(fund_id, limit=250)
        indicators = self._calculate_indicators(history[:30] if len(history) >= 30 else history)

        # Calculate technical indicators (Sharpe, Volatility, Max Drawdown)
        technical_indicators = _calculate_technical_indicators(history)

        # 1.5 Data Consistency Check
        consistency_note = ""
        try:
            sharpe = technical_indicators.get("sharpe")
            annual_return_str = technical_indicators.get("annual_return", "")
            volatility_str = technical_indicators.get("volatility", "")

            if sharpe != "--" and annual_return_str != "--" and volatility_str != "--":
                # Parse percentage strings
                annual_return = float(annual_return_str.rstrip('%')) / 100.0
                volatility = float(volatility_str.rstrip('%')) / 100.0
                sharpe_val = float(sharpe)

                # Expected Sharpe = (annual_return - rf) / volatility
                rf = 0.02
                expected_sharpe = (annual_return - rf) / volatility if volatility > 0 else 0
                sharpe_diff = abs(expected_sharpe - sharpe_val)

                if sharpe_diff > 0.3:
                    consistency_note = f"\n 数据一致性警告：夏普比率 {sharpe_val} 与计算值 {expected_sharpe:.2f} 偏差 {sharpe_diff:.2f}，可能存在数据异常。"
                else:
                    consistency_note = f"\n✓ 数据自洽性验证通过：夏普比率与年化回报/波动率数学一致（偏差 {sharpe_diff:.2f}）。"
        except:
            pass

        history_summary = "暂无历史数据"
        if history:
            recent_history = history[:30]
            history_summary = f"近30日走势: 起始{recent_history[0]['nav']} -> 结束{recent_history[-1]['nav']}. {indicators['desc']}"

        # Prepare variables for template replacement
        holdings_str = ""
        if fund_info.get("holdings"):
            holdings_str = "\n".join([
                f"- {h['name']}: {h['percent']}% (涨跌: {h['change']:+.2f}%)"
                for h in fund_info["holdings"][:10]
            ])

        # Prepare variables for prompt template
        fund_summary = {
            "id": fund_id,
            "name": fund_name,
            "type": fund_info.get("type", "未知"),
            "manager": fund_info.get("manager", "未知"),
            "latest_nav": fund_info.get("nav", "--"),
            "estimate": fund_info.get("estimate", "--"),
            "estimate_rate": f"{fund_info.get('estRate', 0)}%",
            "concentration": fund_info.get("indicators", {}).get("concentration", "--"),
            "holdings": holdings_str or "暂无持仓数据",
        }

        technical_indicators_with_note = str(technical_indicators) + consistency_note

        variables = {
            # 兼容旧版内置模板（services/prompts.py）
            "fund_info": str(fund_summary),
            "history_summary": history_summary,
            "technical_indicators": technical_indicators_with_note,

            # 同时保留新版变量，避免后续模板切换报错
            "fund_code": fund_id,
            "fund_name": fund_name,
            "fund_type": fund_info.get("type", "未知"),
            "manager": fund_info.get("manager", "未知"),
            "nav": fund_info.get("nav", "--"),
            "estimate": fund_info.get("estimate", "--"),
            "est_rate": f"{fund_info.get('estRate', 0)}%",
            "concentration": fund_info.get("indicators", {}).get("concentration", "--"),
            "holdings": holdings_str or "暂无持仓数据",
            "sharpe": technical_indicators.get("sharpe", "--"),
            "volatility": technical_indicators.get("volatility", "--"),
            "max_drawdown": technical_indicators.get("max_drawdown", "--"),
            "annual_return": technical_indicators.get("annual_return", "--"),
        }

        # 2. Get prompt template and replace variables (with user_id filtering)
        prompt_template = self._get_prompt_template(prompt_id, user_id)

        # 3. Invoke LLM
        chain = prompt_template | llm | StrOutputParser()

        # Import json at module level to avoid UnboundLocalError
        import json

        try:
            markdown_result = await chain.ainvoke(variables)

            # Clean up markdown (remove code blocks if present)
            clean_markdown = markdown_result.strip()
            if "```markdown" in clean_markdown:
                clean_markdown = clean_markdown.split("```markdown")[1].split("```")[0].strip()
            elif "```" in clean_markdown:
                # If wrapped in generic code blocks, extract content
                clean_markdown = clean_markdown.split("```")[1].split("```")[0].strip()

            # Return markdown directly with metadata
            return {
                "markdown": clean_markdown,
                "indicators": indicators,
                "timestamp": datetime.datetime.now().strftime("%H:%M:%S")
            }

        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            print(f"AI Analysis Error: {e}\n{error_detail}")
            return {
                "markdown": f"## 分析失败\n\nLLM 调用失败: {str(e)}\n\n请检查 API 配置和提示词格式。",
                "indicators": indicators,
                "timestamp": datetime.datetime.now().strftime("%H:%M:%S")
            }

ai_service = AIService()
