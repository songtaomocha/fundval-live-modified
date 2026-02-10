import React, { useState } from 'react';
import { Mail, TrendingUp, TrendingDown, CheckCircle2, X } from 'lucide-react';

export const SubscribeModal = ({ fund, onClose, onSubmit }) => {
  const [form, setForm] = useState({
    email: '',
    thresholdUp: 2.0,
    thresholdDown: -2.0,
    enableDailyDigest: false,
    digestTime: '14:45',
    enableVolatility: true
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(fund, form);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm transition-opacity">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
        
        {/* Modal Header */}
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-100 flex justify-between items-center">
          <div>
            <h3 className="font-bold text-slate-800">订阅提醒</h3>
            <p className="text-xs text-slate-500 mt-0.5">{fund.name} ({fund.id})</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          
          {/* Email Input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
              <Mail className="w-4 h-4 text-slate-400" />
              接收邮箱
            </label>
            <input 
              type="email" 
              required
              placeholder="yourname@example.com"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
              value={form.email}
              onChange={(e) => setForm({...form, email: e.target.value})}
            />
          </div>

          <div className="border-t border-slate-100 pt-4 space-y-4">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">触发条件</h4>
            
            {/* Thresholds */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-500">上涨触发值 (%)</label>
                <div className="relative">
                  <TrendingUp className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />
                  <input 
                    type="number" 
                    step="0.1"
                    className="w-full pl-9 pr-3 py-2 bg-red-50 border border-red-100 rounded-lg text-red-700 font-mono text-sm focus:ring-2 focus:ring-red-200 outline-none"
                    value={form.thresholdUp}
                    onChange={(e) => setForm({...form, thresholdUp: e.target.value})}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500">下跌触发值 (%)</label>
                <div className="relative">
                  <TrendingDown className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                  <input 
                    type="number" 
                    step="0.1"
                    className="w-full pl-9 pr-3 py-2 bg-green-50 border border-green-100 rounded-lg text-green-700 font-mono text-sm focus:ring-2 focus:ring-green-200 outline-none"
                    value={form.thresholdDown}
                    onChange={(e) => setForm({...form, thresholdDown: e.target.value})}
                  />
                </div>
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer group">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-slate-700">异常波动监控</span>
                  <span className="text-xs text-slate-400">当10分钟内波动超过 1% 时发送</span>
                </div>
                <div className="relative">
                  <input 
                    type="checkbox" 
                    className="peer sr-only"
                    checked={form.enableVolatility}
                    onChange={(e) => setForm({...form, enableVolatility: e.target.checked})}
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </div>
              </label>

              <label className="flex items-center justify-between cursor-pointer group">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-slate-700">每日定时摘要</span>
                  <span className="text-xs text-slate-400">收盘前发送今日估值汇总</span>
                </div>
                <input 
                  type="time" 
                  className="text-sm bg-slate-100 border-none rounded px-2 py-1 text-slate-600 focus:ring-2 focus:ring-blue-500"
                  value={form.digestTime}
                  onChange={(e) => setForm({...form, digestTime: e.target.value})}
                />
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="pt-2">
            <button 
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg shadow-sm shadow-blue-200 transition-all active:scale-[0.98] flex justify-center items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存订阅设置
            </button>
            <p className="text-center text-xs text-slate-400 mt-3">
              * 订阅需验证邮箱，随时可退订
            </p>
          </div>

        </form>
      </div>
    </div>
  );
};
