import React from 'react';
import { Download, Upload } from 'lucide-react';

export function DataManagement({ onExport, onImport }) {
  return (
    <div className="bg-white rounded-lg shadow p-4 sm:p-6 space-y-4">
      <h2 className="text-lg sm:text-xl font-semibold text-gray-900">数据导入导出</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button onClick={onExport} className="flex items-center justify-center gap-2 px-6 min-h-[44px] border-2 border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors"><Download className="w-5 h-5" /><span className="font-medium">导出数据</span></button>
        <button onClick={onImport} className="flex items-center justify-center gap-2 px-6 min-h-[44px] border-2 border-green-200 text-green-700 rounded-lg hover:bg-green-50 transition-colors"><Upload className="w-5 h-5" /><span className="font-medium">导入数据</span></button>
      </div>
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <ul className="text-sm text-yellow-700 space-y-1 list-disc list-inside">
          <li>导出时，敏感信息（API Key、密码）将被掩码处理</li>
          <li>导入时，可选择合并模式或替换模式</li>
          <li>替换模式需要二次确认，请谨慎操作</li>
        </ul>
      </div>
    </div>
  );
}
