import React from 'react';

export const getRateColor = (rate) => {
  if (rate > 0) return 'text-red-500';
  if (rate < 0) return 'text-green-500';
  return 'text-gray-500';
};

export const StatCard = ({ label, value, subValue, highlight = false, isRate = false, large = false }) => (
  <div className="flex flex-col">
    <span className="text-xs text-gray-400 mb-1">{label}</span>
    <div className={`${large ? 'text-2xl md:text-3xl' : 'text-lg'} font-mono font-medium ${highlight ? getRateColor(parseFloat(value)) : 'text-slate-800'}`}>
      {value}{isRate ? '%' : ''}
    </div>
    {subValue && <span className="text-xs text-gray-400">{subValue}</span>}
  </div>
);
