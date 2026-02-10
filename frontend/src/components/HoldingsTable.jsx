import React from 'react';
import { PieChart } from 'lucide-react';
import { getRateColor } from './StatCard';

export const HoldingsTable = ({ holdings = [] }) => {
  return (
    <div className="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-100 min-w-0">
      <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
        <PieChart className="w-5 h-5 text-slate-400" />持仓股明细
      </h3>

      <div className="md:hidden space-y-2">
        {holdings.length === 0 ? (
          <div className="py-8 text-center text-slate-400">暂无持仓数据</div>
        ) : holdings.map((stock, idx) => (
          <div key={idx} className="border border-slate-100 rounded-lg p-3">
            <div className="font-medium text-slate-700 truncate">{stock.name}</div>
            <div className="flex justify-between text-sm mt-2">
              <span className="text-slate-500">持仓占比 {stock.percent}%</span>
              <span className={`font-medium ${getRateColor(stock.change)}`}>{stock.change > 0 ? '+' : ''}{stock.change}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-400 uppercase bg-slate-50">
            <tr>
              <th className="px-4 py-3 rounded-l-lg">股票名称</th>
              <th className="px-4 py-3 text-right">持仓占比</th>
              <th className="px-4 py-3 rounded-r-lg text-right">今日涨跌</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {holdings.length === 0 ? (
              <tr><td colSpan="3" className="px-4 py-8 text-center text-slate-400">暂无持仓数据</td></tr>
            ) : holdings.map((stock, idx) => (
              <tr key={idx} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 font-medium text-slate-700 max-w-[240px] truncate">{stock.name}</td>
                <td className="px-4 py-3 text-right text-slate-500">{stock.percent}%</td>
                <td className={`px-4 py-3 text-right font-medium ${getRateColor(stock.change)}`}>{stock.change > 0 ? '+' : ''}{stock.change}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-center text-xs text-slate-400 mt-4">* 数据源自最近一期定期报告</p>
    </div>
  );
};
