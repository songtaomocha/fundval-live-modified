import React from 'react';

export function AISettings({ settings, errors, onChange }) {
  return (
    <div className="bg-white rounded-lg shadow p-3 sm:p-6 space-y-4">
      <h2 className="text-lg sm:text-xl font-semibold text-gray-900">AI 配置</h2>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">OpenAI API Key</label>
        <input type="password" value={settings.OPENAI_API_KEY} onChange={(e) => onChange('OPENAI_API_KEY', e.target.value)} className="w-full min-h-[44px] px-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="sk-..." />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">OpenAI API Base URL</label>
        <input type="text" value={settings.OPENAI_API_BASE} onChange={(e) => onChange('OPENAI_API_BASE', e.target.value)} className={`w-full min-h-[44px] px-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${errors.OPENAI_API_BASE ? 'border-red-500' : 'border-gray-300'}`} placeholder="https://api.openai.com/v1" />
        {errors.OPENAI_API_BASE && <p className="mt-1 text-sm text-red-600">{errors.OPENAI_API_BASE}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">AI Model Name</label>
        <input type="text" value={settings.AI_MODEL_NAME} onChange={(e) => onChange('AI_MODEL_NAME', e.target.value)} className="w-full min-h-[44px] px-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" placeholder="gpt-4" />
      </div>
    </div>
  );
}
