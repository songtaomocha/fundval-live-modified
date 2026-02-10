import React, { useState } from 'react';
import { AlertCircle, Bell, Trash2, Clock, TrendingUp } from 'lucide-react';
import { StatCard, getRateColor } from './StatCard';
import { getFundBacktest } from '../services/api';

export const FundCard = ({ fund, onClick, onRemove, onSubscribe }) => {
  const [removing, setRemoving] = useState(false);
  const [showBacktest, setShowBacktest] = useState(false);
  const [backtestData, setBacktestData] = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);

  const handleRemove = (e) => {
    e.stopPropagation();
    if (removing) return;
    setRemoving(true);
    onRemove(fund.id);
  };

  const handleBacktest = async (e) => {
    e.stopPropagation();
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

  return (
    <div
      onClick={() => onClick(fund.id)}
      className="bg-white rounded-xl p-4 sm:p-5 border border-slate-100 shadow-sm hover:shadow-md hover:border-blue-200 transition-all cursor-pointer relative overflow-hidden group min-w-0"
    >
      <div className="flex justify-between items-start mb-4 gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-slate-800 line-clamp-1 text-base sm:text-lg group-hover:text-blue-600 transition-colors break-all">
            {fund.name}
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-xs font-mono">{fund.id}</span>
            {(!fund.estimate && fund.estRate === 0) && (
              <span className="flex items-center gap-1 text-orange-500 text-xs bg-orange-50 px-1.5 py-0.5 rounded">
                <AlertCircle className="w-3 h-3" /> 数据待更新
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onSubscribe(fund); }}
            className="h-11 w-11 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-colors z-10 flex items-center justify-center"
            title="订阅提醒"
          >
            <Bell className="w-5 h-5" />
          </button>
          <button
            onClick={handleRemove}
            disabled={removing}
            className="h-11 w-11 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors z-10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            title="删除"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 items-end pointer-events-none min-w-0">
        <div className="col-span-1">
          <span className="text-xs text-slate-400 block mb-1">盘中估算</span>
          <div className={`text-2xl sm:text-3xl font-bold tracking-tight ${getRateColor(fund.estRate)}`}>
            {fund.estRate > 0 ? '+' : ''}{fund.estRate}%
          </div>
        </div>
        <div className="col-span-1 sm:col-span-2 flex justify-between items-end sm:pl-4 sm:border-l border-slate-100 gap-2">
          <StatCard label="估算净值" value={fund.estimate ? fund.estimate.toFixed(4) : '--'} />
          <StatCard label="昨日净值" value={fund.nav ? fund.nav.toFixed(4) : '--'} />
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-50 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <div className="flex flex-col gap-1 pointer-events-none min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-400 flex-wrap">
            <Clock className="w-3 h-3" />
            {fund.time || '--:--'}
            {fund.source === 'ml_estimate' && (
              <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded text-xs font-medium">
                算法估值
              </span>
            )}
          </div>
          {fund.source === 'ml_estimate' && (
            <div className="text-xs text-slate-400 italic line-clamp-2">
              {fund.method === 'weighted_ma' && '基于近5日加权平均预测（近期权重更大）'}
              {fund.method === 'simple_ma' && '基于近5日简单平均预测'}
              {!fund.method && '基于历史数据算法预测'}
            </div>
          )}
        </div>
        {fund.source === 'ml_estimate' && (
          <button
            onClick={handleBacktest}
            disabled={backtestLoading}
            className="pointer-events-auto flex items-center justify-center gap-1 px-3 min-h-[44px] text-xs text-purple-600 hover:bg-purple-50 rounded transition-colors disabled:opacity-50"
            title="查看回测准确率"
          >
            <TrendingUp className="w-3 h-3" />
            {backtestLoading ? '计算中...' : '准确率'}
          </button>
        )}
      </div>

      {showBacktest && backtestData && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={(e) => {
          e.stopPropagation();
          setShowBacktest(false);
        }}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold text-lg text-slate-800">算法回测结果</h3>
              <button onClick={(e) => {
                e.stopPropagation();
                setShowBacktest(false);
              }} className="text-slate-400 hover:text-slate-600 h-11 w-11 flex items-center justify-center">✕</button>
            </div>
            <div className="space-y-4">
              <div className="bg-purple-50 rounded-lg p-4">
                <div className="text-sm text-slate-600 mb-1">平均误差率</div>
                <div className="text-3xl font-bold text-purple-600">{backtestData.avg_error_rate}%</div>
                <div className="text-xs text-slate-500 mt-1">基于近 {backtestData.test_days} 天历史数据回测</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={`absolute bottom-0 left-0 w-full h-1 ${getRateColor(fund.estRate).replace('text', 'bg')} opacity-50`}></div>
    </div>
  );
};
