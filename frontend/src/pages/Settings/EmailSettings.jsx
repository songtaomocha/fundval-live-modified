import React from 'react';

export function EmailSettings({ settings, errors, onChange }) {
  return (
    <div className="bg-white rounded-lg shadow p-3 sm:p-6 space-y-4">
      <h2 className="text-lg sm:text-xl font-semibold text-gray-900">邮件配置</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">SMTP Host</label>
          <input type="text" value={settings.SMTP_HOST} onChange={(e) => onChange('SMTP_HOST', e.target.value)} className="w-full min-h-[44px] px-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="smtp.gmail.com" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">SMTP Port</label>
          <input type="number" value={settings.SMTP_PORT} onChange={(e) => onChange('SMTP_PORT', e.target.value)} className={`w-full min-h-[44px] px-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${errors.SMTP_PORT ? 'border-red-500' : 'border-gray-300'}`} placeholder="587" />
          {errors.SMTP_PORT && <p className="mt-1 text-sm text-red-600">{errors.SMTP_PORT}</p>}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">SMTP User (Email)</label>
        <input type="email" value={settings.SMTP_USER} onChange={(e) => onChange('SMTP_USER', e.target.value)} className={`w-full min-h-[44px] px-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${errors.SMTP_USER ? 'border-red-500' : 'border-gray-300'}`} placeholder="user@example.com" />
        {errors.SMTP_USER && <p className="mt-1 text-sm text-red-600">{errors.SMTP_USER}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">SMTP Password</label>
        <input type="password" value={settings.SMTP_PASSWORD} onChange={(e) => onChange('SMTP_PASSWORD', e.target.value)} className="w-full min-h-[44px] px-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="••••••••" />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">From Email Address</label>
        <input type="email" value={settings.EMAIL_FROM} onChange={(e) => onChange('EMAIL_FROM', e.target.value)} className={`w-full min-h-[44px] px-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${errors.EMAIL_FROM ? 'border-red-500' : 'border-gray-300'}`} placeholder="noreply@example.com" />
        {errors.EMAIL_FROM && <p className="mt-1 text-sm text-red-600">{errors.EMAIL_FROM}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">分时数据采集间隔（分钟）</label>
        <input type="number" value={settings.INTRADAY_COLLECT_INTERVAL} onChange={(e) => onChange('INTRADAY_COLLECT_INTERVAL', e.target.value)} className={`w-full min-h-[44px] px-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${errors.INTRADAY_COLLECT_INTERVAL ? 'border-red-500' : 'border-gray-300'}`} placeholder="5" min="1" max="60" />
        {errors.INTRADAY_COLLECT_INTERVAL && <p className="mt-1 text-sm text-red-600">{errors.INTRADAY_COLLECT_INTERVAL}</p>}
      </div>
    </div>
  );
}
