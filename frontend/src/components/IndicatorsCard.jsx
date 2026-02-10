import React from 'react';
import { Target, TrendingUp, ShieldAlert, BarChart2, PieChart, Activity } from 'lucide-react';

const IndicatorItem = ({ label, value, unit = '', color = 'text-slate-700' }) => (
  <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
    <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">{label}</span>
    <span className={`font-mono font-bold text-base ${color}`}>
        {value}{value !== '--' && unit}
    </span>
  </div>
);

export const IndicatorsCard = ({ indicators }) => {
  if (!indicators) return null;

  const { returns = {}, concentration = '--', technical = {} } = indicators;

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Target className="w-5 h-5 text-indigo-500" />
            技术指标审计
        </h3>
        <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-bold">数学归因模式</span>
      </div>

      <div className="space-y-8">
        {/* Row 1: Return Metrics */}
        <div>
            <h4 className="text-xs font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5" /> 阶段累计收益
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <IndicatorItem label="近1月" value={returns['1M'] || '--'} unit="%" color={parseFloat(returns['1M']) > 0 ? 'text-red-600' : 'text-green-600'} />
                <IndicatorItem label="近3月" value={returns['3M'] || '--'} unit="%" color={parseFloat(returns['3M']) > 0 ? 'text-red-600' : 'text-green-600'} />
                <IndicatorItem label="近6月" value={returns['6M'] || '--'} unit="%" color={parseFloat(returns['6M']) > 0 ? 'text-red-600' : 'text-green-600'} />
                <IndicatorItem label="近1年" value={returns['1Y'] || '--'} unit="%" color={parseFloat(returns['1Y']) > 0 ? 'text-red-600' : 'text-green-600'} />
            </div>
        </div>

        {/* Row 2: Risk & Efficiency */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
                <h4 className="text-xs font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" /> 风险回撤审计
                </h4>
                <div className="grid grid-cols-2 gap-3">
                    <IndicatorItem label="最大回撤 (1Y)" value={technical.max_drawdown || '--'} color="text-green-600" />
                    <IndicatorItem label="年化波动率" value={technical.volatility || '--'} color="text-orange-600" />
                </div>
            </div>

            <div className="space-y-4">
                <h4 className="text-xs font-bold text-slate-400 mb-3 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5" /> 效率与集中度
                </h4>
                <div className="grid grid-cols-2 gap-3">
                    <IndicatorItem label="夏普比率 (1Y)" value={technical.sharpe || '--'} color="text-indigo-600" />
                    <IndicatorItem label="前十持仓占比" value={concentration || '--'} unit="%" color="text-slate-700" />
                </div>
            </div>
        </div>
      </div>
      
      <p className="mt-6 text-[10px] text-slate-400 text-center italic">
        * 指标基于历史净值序列经由 Numpy 实时审计，非第三方主观评分。
      </p>
    </div>
  );
};