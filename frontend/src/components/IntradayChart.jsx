import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { api, normalizeFundId } from '../services/api';
import { useElementSize } from '../hooks/useElementSize';

export const IntradayChart = ({ fundId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(''); // Empty = today
  const [displayMode, setDisplayMode] = useState('nav'); // 'nav' | 'rate'
  const containerRef = useRef(null);
  const { width: containerWidth, height: containerHeight } = useElementSize(containerRef);
  const normalizedFundId = useMemo(() => normalizeFundId(fundId), [fundId]);

  const getEvenlyDistributedTicks = useCallback((values, desiredCount) => {
    const n = values.length;
    if (n === 0) return [];
    if (n === 1) return [values[0]];

    const count = Math.max(2, Math.min(desiredCount, n));
    const last = n - 1;
    const indexes = [0];
    for (let i = 1; i < count - 1; i++) {
      let idx = Math.round((i * last) / (count - 1));
      idx = Math.max(idx, indexes[indexes.length - 1] + 1);
      idx = Math.min(idx, last - (count - 1 - i));
      indexes.push(idx);
    }
    indexes.push(last);
    return indexes.map((idx) => values[idx]);
  }, []);

  const fetchIntraday = useCallback(async (date = '') => {
    if (!normalizedFundId) return;
    setLoading(true);
    setError(null);
    try {
      const encodedFundId = encodeURIComponent(normalizedFundId);
      const url = date
        ? `/fund/${encodedFundId}/intraday?date=${date}`
        : `/fund/${encodedFundId}/intraday`;
      const response = await api.get(url);
      const json = response.data;
      setData(json);
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
    fetchIntraday(selectedDate);
  }, [normalizedFundId, selectedDate, fetchIntraday]);

  // 今日分时自动刷新：页面保持打开时，每30秒刷新一次（仅今日）
  useEffect(() => {
    if (!normalizedFundId) return;
    if (selectedDate) return;

    const timer = setInterval(() => {
      if (!document.hidden) {
        fetchIntraday('');
      }
    }, 30000);

    return () => clearInterval(timer);
  }, [normalizedFundId, selectedDate, fetchIntraday]);

  const safeWidth = containerWidth > 0
    ? containerWidth
    : (typeof window !== 'undefined' ? window.innerWidth : 375);
  const chartTier = safeWidth < 640 ? 'compact' : safeWidth < 1024 ? 'medium' : 'large';
  const isCompact = chartTier === 'compact';
  const chartHeight = chartTier === 'compact' ? 260 : chartTier === 'medium' ? 320 : 380;
  const xAxisHeight = chartTier === 'compact' ? 40 : chartTier === 'medium' ? 46 : 52;
  const chartMargin = chartTier === 'compact'
    ? { top: 8, right: 12, left: 2, bottom: 2 }
    : chartTier === 'medium'
      ? { top: 12, right: 20, left: 6, bottom: 4 }
      : { top: 14, right: 30, left: 10, bottom: 6 };
  const yAxisWidth = displayMode === 'rate'
    ? (chartTier === 'compact' ? 60 : chartTier === 'medium' ? 62 : 64)
    : (chartTier === 'compact' ? 54 : chartTier === 'medium' ? 56 : 60);

  const snapshots = data?.snapshots || [];

  const timeline = [];
  for (let hour = 9; hour <= 15; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      if (hour === 15 && minute > 0) break;
      timeline.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }

  const snapshotMap = new Map(snapshots.map(s => [s.time, s.estimate]));

  const toMinutes = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };

  const mergedTimes = Array.from(new Set([
    ...timeline,
    ...snapshots.map(s => s.time)
  ])).sort((a, b) => toMinutes(a) - toMinutes(b));

  const prevNav = data?.prevNav;
  const chartData = mergedTimes.map((time) => {
    const estimate = snapshotMap.has(time) ? snapshotMap.get(time) : null;
    const estRate = (estimate !== null && prevNav)
      ? parseFloat(((estimate - prevNav) / prevNav * 100).toFixed(4))
      : null;

    return { time, estimate, estRate };
  });

  const xTicks = useMemo(() => {
    const times = chartData.map((d) => d.time);
    const n = times.length;
    if (n <= 1) return times;

    const desired = isCompact
      ? Math.max(4, Math.min(6, Math.floor((safeWidth || 320) / 96)))
      : Math.max(5, Math.min(9, Math.floor((safeWidth || 320) / 80)));
    return getEvenlyDistributedTicks(times, desired);
  }, [chartData, safeWidth, isCompact, getEvenlyDistributedTicks]);

  const yDomain = useMemo(() => {
    const key = displayMode === 'nav' ? 'estimate' : 'estRate';
    const values = chartData.map((d) => Number(d[key])).filter((v) => Number.isFinite(v));
    if (values.length === 0) return ['auto', 'auto'];

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    if (displayMode === 'nav') {
      const navBaseline = Number.isFinite(Number(prevNav)) ? Number(prevNav) : ((min + max) / 2 || 1);
      const minSpan = Math.max(Math.abs(navBaseline) * 0.00018, 0.00008);
      const effectiveSpan = Math.max(span, minSpan);
      const pad = effectiveSpan * 0.22;
      return [Number((min - pad).toFixed(6)), Number((max + pad).toFixed(6))];
    }

    const minSpan = 0.06;
    const effectiveSpan = Math.max(span, minSpan);
    const pad = effectiveSpan * 0.18;
    return [Number((min - pad).toFixed(4)), Number((max + pad).toFixed(4))];
  }, [chartData, displayMode, prevNav]);

  if (loading) return <div className="h-64 flex items-center justify-center text-slate-400">加载分时数据中...</div>;
  if (error) return <div className="h-64 flex items-center justify-center text-red-400">加载失败: {error}</div>;
  if (!data || snapshots.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">暂无分时数据（仅在交易时间采集持仓和关注的基金）</div>;
  }

  const lastValidPoint = [...chartData].reverse().find(p => p.estimate !== null);
  const lastEstimate = lastValidPoint?.estimate || 0;
  const lastRate = lastValidPoint?.estRate || 0;

  const lineColor = displayMode === 'nav'
    ? (!data.prevNav ? '#94a3b8' : lastEstimate >= data.prevNav ? '#ef4444' : '#22c55e')
    : (lastRate >= 0 ? '#ef4444' : '#22c55e');

  return (
    <div className="w-full">
      {!data.prevNav && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
          ⚠️ 缺少前日净值数据，无法计算涨跌幅百分比
        </div>
      )}

      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600 inline-flex flex-wrap items-center gap-3 min-h-[44px]">
          <span className="leading-[44px]">日期: {data.date}</span>
          {data.prevNav && <span className="leading-[44px]">前一日净值: {data.prevNav.toFixed(4)}</span>}
          {data.lastCollectedAt && <span className="leading-[44px]">最后更新: {data.lastCollectedAt}</span>}
        </div>
        <div className="flex items-center gap-2 min-h-[44px]">
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg min-h-[44px] items-center">
            <button
              onClick={() => setDisplayMode('nav')}
              className={`px-3 min-h-[40px] text-xs rounded-md transition-colors ${
                displayMode === 'nav'
                  ? 'bg-white text-slate-700 font-medium shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              净值
            </button>
            <button
              onClick={() => setDisplayMode('rate')}
              className={`px-3 min-h-[40px] text-xs rounded-md transition-colors ${
                displayMode === 'rate'
                  ? 'bg-white text-slate-700 font-medium shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              涨跌幅
            </button>
          </div>
          {data.hasHistoricalIntraday && (
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              max={new Date().toISOString().split('T')[0]}
              className="h-11 px-3 py-1 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full min-w-0"
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
              dataKey="time"
              ticks={xTicks}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
              interval={0}
              tickMargin={isCompact ? 7 : 12}
              angle={isCompact ? 0 : -45}
              textAnchor="middle"
              height={xAxisHeight}
              padding={isCompact ? { left: 2, right: 10 } : { left: 8, right: 16 }}
            />
            <YAxis
              domain={yDomain}
              tickCount={6}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              width={yAxisWidth}
              tickFormatter={(value) => displayMode === 'rate' ? `${Number(value).toFixed(2)}%` : Number(value).toFixed(4)}
            />
            <Tooltip
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
                    '估值'
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
              type="monotone"
              dataKey={displayMode === 'nav' ? 'estimate' : 'estRate'}
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
        数据采集频率可在设置中配置 ·  仅在系统开启时运行（交易日 09:00-15:00）
      </div>
    </div>
  );
};
