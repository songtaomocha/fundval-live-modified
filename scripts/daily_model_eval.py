#!/usr/bin/env python3
"""Run daily valuation model evaluation and persist metrics."""

import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)

from backend.app.db import init_db
from backend.app.services.fund import run_daily_model_evaluation


if __name__ == "__main__":
    init_db()
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%Y-%m-%d")
    result = run_daily_model_evaluation(trade_date=date)
    print(result)
