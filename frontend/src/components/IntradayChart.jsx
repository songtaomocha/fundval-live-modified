import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { api, normalizeFundId } from '../services/api';
import { useElementSize } from '../hooks/useElementSize';

const toMinutes = (time) => {
  const [h, m] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
};

const isTradingMinute = (mins) => {
  const morningOpen = 9 * 60;
  const morningClose = 11 * 60 + 30;
  const afternoonOpen = 13 * 60;
  const afternoonClose = 15 * 60;
  return (mins >= morningOpen && mins <= morningClose) || (mins >= afternoonOpen && mins <= afternoonClose);
};

// 压缩午休：13:00 之后整体左移 90 分钟，使 11:30 与 13:00 重合
const compressTradingX = (mins) => (mins >= 13 * 60 ? mins - 90 : mins);

export const IntradayChart = ({ fundId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [displayMode, setDisplayMode] = useState('nav'); // 'nav' | 'rate'

  const containerRef = useRef(null);
  const { width: containerWidth, height: containerHeight } = useElementSize(containerRef);
  const normalizedFundId = useMemo(() => normalizeFundId(fundId), [fundId]);

  const fetchIntraday = useCallback(async () => {
    if (!normalizedFundId) return;
    setLoading(true);
    setError(null);
    try {
      const encodedFundId = encodeURIComponent(normalizedFundId);
      const response = await api.get(`/fund/${encodedFundId}/intraday`);
      setData(response.data);
    } catch (e) {
      console.error('Failed to load intraday data', e);
      setError(e.message || '加载失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [normalizedFundId]);

  useEffect(() => {
    if (!normalizedFundId) return;
    fetchIntraday();
  }, [normalizedFundId, fetchIntraday]);

  const safeWidth = containerWidth > 0
    ? containerWidth
    : (typeof window !== 'undefined' ? window.innerWidth : 375);
  const chartTier = safeWidth < 640 ? 'compact' : safeWidth < 1024 ? 'medium' : 'large';
  const isCompact = chartTier === 'compact';
  const chartHeight = chartTier === 'compact' ? 260 : chartTier === 'medium' ? 320 : 380;
  const xAxisHeight = chartTier === 'compact' ? 52 : chartTier === 'medium' ? 46 : 52;
  const yAxisWidth = chartTier === 'compact' ? 44 : chartTier === 'medium' ? 56 : 60;
  const chartMargin = chartTier === 'compact'
    ? { top: 6, right: 13, left: -1, bottom: 2 }
    : chartTier === 'medium'
      ? { top: 12, right: 20, left: 6, bottom: 4 }
      : { top: 14, right: 30, left: 10, bottom: 6 };

  if (loading) return <div className="h-64 flex items-center justify-center text-slate-400">加载分时数据中...</div>;
  if (error) return <div className="h-64 flex items-center justify-center text-red-400">加载失败: {error}</div>;
  if (!data || !data.snapshots || data.snapshots.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">暂无分时数据（仅在交易时间采集持仓和关注的基金）</div>;
  }

  // 用原始 snapshots 直接画，不重采样；仅压缩午休时间轴
  const chartData = data.snapshots
    .map((s) => {
      const mins = toMinutes(s.time);
      const estimate = Number(s.estimate);
      return {
        time: s.time,
        mins,
        x: compressTradingX(mins),
        estimate,
        estRate: data.prevNav
          ? parseFloat((((estimate - data.prevNav) / data.prevNav) * 100).toFixed(2))
          : 0,
      };
    })
    .filter((d) => Number.isFinite(d.mins) && isTradingMinute(d.mins) && Number.isFinite(d.estimate))
    .sort((a, b) => a.mins - b.mins);

  if (chartData.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">暂无有效分时点</div>;
  }

  const valueKey = displayMode === 'nav' ? 'estimate' : 'estRate';
  const values = chartData.map((d) => d[valueKey]).filter((v) => Number.isFinite(v));

  const yDomain = values.length
    ? (() => {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min;
        const pad = span > 0 ? span * 0.12 : (displayMode === 'nav' ? 0.0003 : 0.03);
        return [min - pad, max + pad];
      })()
    : ['auto', 'auto'];

  // 11:30 与 13:00 重合，仅显示 13:00
  const xTicks = [
    { v: 9 * 60, label: '09:00' },
    { v: 10 * 60, label: '10:00' },
    { v: 11 * 60, label: '11:00' },
    { v: compressTradingX(13 * 60), label: '13:00' },
    { v: compressTradingX(14 * 60), label: '14:00' },
    { v: compressTradingX(15 * 60), label: '15:00' },
  ];
  const tickMap = new Map(xTicks.map((t) => [t.v, t.label]));

  const xMin = 9 * 60;
  const xMax = compressTradingX(15 * 60);

  const lastPoint = chartData[chartData.length - 1];
  const lineColor = displayMode === 'nav'
    ? (!data.prevNav ? '#94a3b8' : lastPoint.estimate >= data.prevNav ? '#ef4444' : '#22c55e')
    : (lastPoint.estRate >= 0 ? '#ef4444' : '#22c55e');

  return (
    <div className="w-full">
      {!data.prevNav && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
          ⚠️ 缺少前日净值数据，无法计算涨跌幅百分比
        </div>
      )}

      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600">
          <span>日期: {data.date}</span>
          {data.prevNav && <span className="ml-4">前一日净值: {data.prevNav.toFixed(4)}</span>}
          {data.lastCollectedAt && <span className="ml-4">最后更新: {data.lastCollectedAt}</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              onClick={() => setDisplayMode('nav')}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                displayMode === 'nav'
                  ? 'bg-white text-slate-700 font-medium shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              净值
            </button>
            <button
              onClick={() => setDisplayMode('rate')}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                displayMode === 'rate'
                  ? 'bg-white text-slate-700 font-medium shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              涨跌幅
            </button>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full min-w-0 relative"
        style={{ height: `${chartHeight}px`, minHeight: `${chartHeight}px` }}
      >
        {containerWidth > 0 && containerHeight > 0 && (
          <LineChart
            width={containerWidth}
            height={containerHeight}
            data={chartData}
            margin={chartMargin}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[xMin, xMax]}
              ticks={xTicks.map((t) => t.v)}
              tickFormatter={(v) => tickMap.get(v) || ''}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              interval={0}
              padding={isCompact ? { left: 9, right: 9 } : { left: 8, right: 16 }}
              tickMargin={12}
              angle={-45}
              textAnchor="end"
              height={xAxisHeight}
            />
            <YAxis
              domain={yDomain}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              width={yAxisWidth}
              tickFormatter={(value) => (displayMode === 'rate' ? `${Number(value).toFixed(2)}%` : Number(value).toFixed(4))}
            />
            <Tooltip
              labelFormatter={(_, payload) => payload?.[0]?.payload?.time || ''}
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              itemStyle={{ color: '#1e293b', fontSize: '12px', fontWeight: 'bold' }}
              labelStyle={{ color: '#64748b', fontSize: '10px', marginBottom: '4px' }}
              formatter={(value, name, props) => {
                if (displayMode === 'nav' && name === 'estimate') {
                  const rate = Number(props.payload.estRate || 0).toFixed(2);
                  return [
                    <span key="estimate">
                      {Number(value).toFixed(4)} <span style={{ color: '#64748b', fontSize: '10px' }}>({rate}%)</span>
                    </span>,
                    '估值',
                  ];
                }
                if (displayMode === 'rate' && name === 'estRate') {
                  return [`${Number(value).toFixed(2)}%`, '涨跌幅'];
                }
                return [value, name];
              }}
            />
            {displayMode === 'nav' && data.prevNav ? (
              <ReferenceLine y={data.prevNav} stroke="#94a3b8" strokeDasharray="3 3" />
            ) : displayMode === 'rate' ? (
              <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
            ) : null}
            <Line
              type="linear"
              dataKey={valueKey}
              stroke={lineColor}
              strokeWidth={2}
              dot={false}
              connectNulls={true}
              animationDuration={500}
            />
          </LineChart>
        )}
      </div>

      <div className="mt-2 text-xs text-slate-500 text-center">
        数据采集仅在系统开启时运行（交易日 09:00-15:00）
      </div>
    </div>
  );
};
