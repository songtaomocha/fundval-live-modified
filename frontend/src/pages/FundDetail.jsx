import React, { useEffect, useRef, useState } from 'react';
import { User, Bell, ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react';
import { AiAnalysis } from '../components/AiAnalysis';
import { HoldingsTable } from '../components/HoldingsTable';
import { HistoryChart } from '../components/HistoryChart';
import { IntradayChart } from '../components/IntradayChart';
import { IndicatorsCard } from '../components/IndicatorsCard';
import { getFundBacktest } from '../services/api';

export const FundDetail = ({ fund, onSubscribe, accountId, onNavigate, onEnsureDetail, hasPrev, hasNext, currentIndex, totalCount }) => {
  const [chartType, setChartType] = useState('history');
  const [showBacktest, setShowBacktest] = useState(false);
  const [backtestData, setBacktestData] = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const autoHydratedRef = useRef(new Set());
  const autoRetryTimerRef = useRef(null);
  const autoRetryCountRef = useRef({});

  const handleBacktest = async () => {
    if (backtestLoading) return;
    setBacktestLoading(true);
    try {
      const data = await getFundBacktest(fund.id, 20);
      setBacktestData(data);
      setShowBacktest(true);
    } catch (error) {
      console.error('Backtest error:', error);
      alert('回测失败，请稍后重试');
    } finally {
      setBacktestLoading(false);
    }
  };

  useEffect(() => {
    if (!fund?.id || !onEnsureDetail) return;
    const needsDetail = !fund?.indicators || !Array.isArray(fund?.holdings) || fund.holdings.length === 0;
    if (!needsDetail) {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      return;
    }

    // 首次进入详情先静默补拉一次
    if (!autoHydratedRef.current.has(fund.id)) {
      autoHydratedRef.current.add(fund.id);
      onEnsureDetail(fund.id, { silent: true });
    }

    // 自动静默重试（不在页面提示），最多 5 次，避免无限请求
    const retryCount = autoRetryCountRef.current[fund.id] || 0;
    if (retryCount >= 5) return;

    if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
    autoRetryTimerRef.current = setTimeout(() => {
      autoRetryCountRef.current[fund.id] = retryCount + 1;
      onEnsureDetail(fund.id, { silent: true });
    }, 2200);

    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    };
  }, [fund?.id, fund?.indicators, fund?.holdings, onEnsureDetail]);

  if (!fund) return null;

  return (
    <div className="space-y-3 sm:space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 min-w-0">
      <div className="bg-white rounded-2xl p-3.5 sm:p-6 shadow-sm border border-slate-100 min-w-0">
        {onNavigate && totalCount > 1 && (
          <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-100 gap-1.5">
            <button
              onClick={() => onNavigate('prev')}
              disabled={!hasPrev}
              className="flex items-center gap-0.5 px-2.5 min-h-[40px] rounded-lg text-xs sm:text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-100 text-slate-600"
            >
              <ChevronLeft className="w-4 h-4" />
              上一个
            </button>
            <span className="text-xs text-slate-400 shrink-0">{currentIndex} / {totalCount}</span>
            <button
              onClick={() => onNavigate('next')}
              disabled={!hasNext}
              className="flex items-center gap-0.5 px-2.5 min-h-[40px] rounded-lg text-xs sm:text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-100 text-slate-600"
            >
              下一个
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex flex-col lg:flex-row justify-between lg:items-start gap-3 mb-4 sm:mb-6 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs font-bold">{fund.type || '基金'}</span>
              <span className="text-slate-400 text-xs font-mono truncate">{fund.id}</span>
            </div>
            <h2 className="text-lg sm:text-2xl font-bold text-slate-800 break-words leading-tight">{fund.name}</h2>
            <div className="flex items-center gap-2 mt-2 text-sm text-slate-500 min-w-0">
              <User className="w-4 h-4 shrink-0" />
              <span className="truncate">基金经理: {fund.manager || '--'}</span>
            </div>
          </div>

          <div className="text-left lg:text-right mt-1">
            <p className="text-xs text-slate-400 mb-1">更新时间</p>
            <p className="font-mono text-slate-600 text-sm sm:text-base break-all">{fund.time}</p>
            {fund.source === 'ml_estimate' && (
              <div className="mt-2 flex flex-col lg:items-end gap-2">
                <span className="inline-block px-2 py-1 bg-purple-50 text-purple-600 rounded text-xs font-medium">算法估值</span>
                <button
                  onClick={handleBacktest}
                  disabled={backtestLoading}
                  className="flex items-center gap-1 px-3 min-h-[44px] text-xs text-purple-600 hover:bg-purple-50 rounded transition-colors disabled:opacity-50"
                >
                  <TrendingUp className="w-3 h-3" />
                  {backtestLoading ? '计算中...' : '准确率'}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4 py-3.5 sm:py-6 border-t border-b border-slate-50">
          <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0">
            <div className="text-[11px] sm:text-xs text-slate-400 mb-1">盘中估算</div>
            <div className={`text-lg sm:text-2xl font-mono font-semibold ${Number(fund.estRate) > 0 ? 'text-red-500' : Number(fund.estRate) < 0 ? 'text-green-500' : 'text-slate-600'}`}>
              {Number(fund.estRate) > 0 ? '+' : ''}{Number(fund.estRate || 0).toFixed(4)}%
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0">
            <div className="text-[11px] sm:text-xs text-slate-400 mb-1">实时估值</div>
            <div className="text-lg sm:text-2xl font-mono font-semibold text-slate-800 truncate">
              {fund.estimate ? fund.estimate.toFixed(4) : '--'}
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0">
            <div className="text-[11px] sm:text-xs text-slate-400 mb-1">昨日净值</div>
            <div className="text-lg sm:text-2xl font-mono font-semibold text-slate-800 truncate">
              {fund.nav ? fund.nav.toFixed(4) : '--'}
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 p-2.5 sm:p-3 min-w-0">
            <div className="text-[11px] sm:text-xs text-slate-400 mb-1">置信度</div>
            <div className="text-lg sm:text-2xl font-mono font-semibold text-slate-800 truncate">
              {fund.confidence != null ? `${Number(fund.confidence).toFixed(2)}%` : '--'}
            </div>
          </div>
        </div>

        <div className="pt-2 pb-1 border-b border-slate-50 mb-1 min-w-0">
          <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar">
            <button
              onClick={() => setChartType('history')}
              className={`px-4 min-h-[44px] rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                chartType === 'history' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >历史走势</button>
            <button
              onClick={() => setChartType('intraday')}
              className={`px-4 min-h-[44px] rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                chartType === 'intraday' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >今日分时</button>
          </div>

          <div className="-mx-2 sm:mx-0 min-w-0">
            {chartType === 'history' ? <HistoryChart fundId={fund.id} accountId={accountId} /> : <IntradayChart fundId={fund.id} />}
          </div>
        </div>

        <div className="mt-1.5 flex gap-3">
          <button
            onClick={() => onSubscribe(fund)}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 min-h-[44px] rounded-xl font-medium transition-colors flex justify-center items-center gap-2"
          >
            <Bell className="w-4 h-4" /> 订阅提醒
          </button>
        </div>
      </div>


      <IndicatorsCard indicators={fund.indicators} />
      <AiAnalysis fund={fund} />
      <HoldingsTable holdings={fund.holdings} />

      {showBacktest && backtestData && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowBacktest(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold text-lg text-slate-800">算法回测结果</h3>
              <button onClick={() => setShowBacktest(false)} className="h-11 w-11 flex items-center justify-center text-slate-400 hover:text-slate-600">✕</button>
            </div>
            <div className="bg-purple-50 rounded-lg p-4">
              <div className="text-sm text-slate-600 mb-1">平均误差率</div>
              <div className="text-3xl font-bold text-purple-600">{backtestData.avg_error_rate}%</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
