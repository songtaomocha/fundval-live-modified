import React, { useRef } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { useElementSize } from '../hooks/useElementSize';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6'];
const RADIAN = Math.PI / 180;

const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  if (percent < 0.05) return null;
  return <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" className="text-[10px] font-bold">{`${(percent * 100).toFixed(0)}%`}</text>;
};

const getRateColor = (rate) => rate > 0 ? 'text-red-500' : rate < 0 ? 'text-green-500' : 'text-slate-500';

export const PortfolioChart = ({ positions, summary, loading, onRefresh }) => {
  const chartRef = useRef(null);
  const { width: chartWidth, height: chartHeight } = useElementSize(chartRef);
  if (!positions || positions.length === 0) return null;

  const dataMap = {};
  positions.forEach(p => {
    let type = p.type || '未知';
    if (type.includes('股票') || type.includes('偏股')) type = '股票型';
    else if (type.includes('混合')) type = '混合型';
    else if (type.includes('债')) type = '债券型';
    else if (type.includes('指数')) type = '指数型';
    else if (type.includes('QDII')) type = 'QDII';
    else if (type.includes('货币')) type = '货币型';
    else if (type.includes('FOF')) type = 'FOF';
    else if (type.includes('REITs') || type.includes('Reits')) type = 'REITs';
    else if (!type || type === '未知') type = '其他';

    if (!dataMap[type]) dataMap[type] = 0;
    dataMap[type] += p.market_value || p.est_market_value;
  });

  const data = Object.keys(dataMap).map(key => ({ name: key, value: dataMap[key] })).sort((a, b) => b.value - a.value);

  return (
    <div className="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-slate-200 min-w-0 overflow-hidden">
      <div className="flex justify-between items-center mb-4 gap-2">
        <h3 className="text-base sm:text-lg font-bold text-slate-700 uppercase tracking-wider truncate">资产概览</h3>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-10 gap-4 sm:gap-6 items-start min-w-0">
        <div className="xl:col-span-4 grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1 min-w-0"><div className="text-sm text-slate-500 font-medium uppercase tracking-wider">预估总资产</div><div className="text-xl sm:text-2xl font-bold text-slate-800 truncate">¥{(summary?.total_market_value || 0).toLocaleString()}</div></div>
          <div className="flex flex-col gap-1 min-w-0"><div className="text-sm text-slate-500 font-medium uppercase tracking-wider">成本总额</div><div className="text-xl sm:text-2xl font-bold text-slate-600 truncate">¥{(summary?.total_cost || 0).toLocaleString()}</div></div>
          <div className="flex flex-col gap-1 min-w-0"><div className="text-sm text-slate-500 font-medium uppercase tracking-wider">预估总盈亏</div><div className={`text-xl sm:text-2xl font-bold truncate ${getRateColor(summary?.total_income || 0)}`}>{(summary?.total_income || 0) > 0 ? '+' : ''}¥{(summary?.total_income || 0).toLocaleString()}</div><div className={`text-base font-medium ${getRateColor(summary?.total_income || 0)}`}>{(summary?.total_return_rate || 0) > 0 ? '+' : ''}{(summary?.total_return_rate || 0).toFixed(2)}%</div></div>
          <div className="flex flex-col gap-1 min-w-0"><div className="text-sm text-slate-500 font-medium uppercase tracking-wider">当日预估盈亏</div><div className={`text-xl sm:text-2xl font-bold truncate ${getRateColor(summary?.total_day_income || 0)}`}>{(summary?.total_day_income || 0) > 0 ? '+' : ''}¥{(summary?.total_day_income || 0).toLocaleString()}</div></div>
        </div>

        <div ref={chartRef} className="xl:col-span-6 h-[320px] sm:h-[360px] w-full min-w-0 overflow-hidden">
          {chartWidth > 0 && chartHeight > 0 && (
            <PieChart width={chartWidth} height={chartHeight}>
              <Pie
                data={data}
                cx="50%"
                cy="40%"
                labelLine={false}
                label={renderCustomizedLabel}
                outerRadius={Math.max(110, Math.min(chartWidth, chartHeight) * 0.33)}
                dataKey="value"
                paddingAngle={2}
              >
                {data.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
              </Pie>
              <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '12px' }} />
              <Tooltip formatter={(value) => `¥${value.toLocaleString()}`} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
            </PieChart>
          )}
        </div>
      </div>
    </div>
  );
};
