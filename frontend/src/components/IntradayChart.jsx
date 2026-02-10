import React, { useEffect, useState, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { api } from '../services/api';

export const IntradayChart = ({ fundId }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(''); // Empty = today
  const [displayMode, setDisplayMode] = useState('nav'); // 'nav' | 'rate'
  const chartWrapRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [chartHeight, setChartHeight] = useState(220);

  const fetchIntraday = useCallback(async (date = '') => {
    setLoading(true);
    setError(null);
    try {
      const url = date
        ? `/fund/${fundId}/intraday?date=${date}`
        : `/fund/${fundId}/intraday`;
      const response = await api.get(url);
      const json = response.data;
      console.log('Intraday data loaded:', {
        date: json.date,
        prevNav: json.prevNav,
        snapshotsCount: json.snapshots?.length || 0,
        lastCollectedAt: json.lastCollectedAt
      });
      setData(json);
    } catch (e) {
      console.error("Failed to load intraday data", e);
      setError(e.message || '加载失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fundId]);

  useEffect(() => {
    if (!fundId) return;
    fetchIntraday(selectedDate);
  }, [fundId, selectedDate]);

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.floor(rect.width || 0);
      const h = Math.floor(rect.height || 0);
      setChartWidth(w > 0 ? w : 0);
      setChartHeight(h > 0 ? h : 220);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (loading) return <div className="h-64 flex items-center justify-center text-slate-400">加载分时数据中...</div>;
  if (error) return <div className="h-64 flex items-center justify-center text-red-400">加载失败: {error}</div>;
  if (!data || !data.snapshots || data.snapshots.length === 0) {
    return <div className="h-64 flex items-center justify-center text-slate-400">暂无分时数据（仅在交易时间采集持仓和关注的基金）</div>;
  }

  // Build base timeline (09:00-15:00, every 5 minutes), and merge with actual snapshot times
  // so non-5-min points (e.g. 13:22) are also rendered.
  const timeline = [];
  for (let hour = 9; hour <= 15; hour++) {
    for (let minute = 0; minute < 60; minute += 5) {
      if (hour === 15 && minute > 0) break;
      timeline.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }

  const snapshotMap = new Map((data.snapshots || []).map(s => [s.time, s.estimate]));

  const toMinutes = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  };

  const mergedTimes = Array.from(new Set([
    ...timeline,
    ...(data.snapshots || []).map(s => s.time)
  ])).sort((a, b) => toMinutes(a) - toMinutes(b));

  const chartData = mergedTimes.map((time) => {
    const estimate = snapshotMap.has(time) ? snapshotMap.get(time) : null;
    const estRate = (estimate !== null && data.prevNav)
      ? parseFloat(((estimate - data.prevNav) / data.prevNav * 100).toFixed(2))
      : null;

    return { time, estimate, estRate };
  });

  console.log('IntradayChart debug:', {
    displayMode,
    hasPrevNav: !!data.prevNav,
    prevNav: data.prevNav,
    snapshotsCount: data.snapshots.length,
    firstEstRate: chartData[0]?.estRate,
    lastEstRate: chartData[chartData.length - 1]?.estRate
  });

  const lastValidPoint = [...chartData].reverse().find(p => p.estimate !== null);
  const lastEstimate = lastValidPoint?.estimate || 0;
  const lastRate = lastValidPoint?.estRate || 0;

  const lineColor = displayMode === 'nav'
    ? (!data.prevNav ? '#94a3b8' : lastEstimate >= data.prevNav ? '#ef4444' : '#22c55e')
    : (lastRate >= 0 ? '#ef4444' : '#22c55e');

  return (
    <div className="w-full">
      {/* Warning if no prevNav */}
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

      <div ref={chartWrapRef} className="h-[220px] md:h-[280px] min-h-[220px] md:min-h-[280px] w-full min-w-0 overflow-hidden">
        {chartWidth > 0 ? (
          <LineChart
            width={chartWidth}
            height={chartHeight}
            data={chartData}
            margin={{ top: 10, right: 40, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              ticks={chartData.map(d => d.time).filter(t => t.endsWith(':00') || t.endsWith(':30') || t === '15:00')}
              minTickGap={20}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickLine={false}
              axisLine={false}
              width={50}
              tickFormatter={(value) => displayMode === 'rate' ? `${value}%` : value}
            />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
              itemStyle={{ color: '#1e293b', fontSize: '12px', fontWeight: 'bold' }}
              labelStyle={{ color: '#64748b', fontSize: '10px', marginBottom: '4px' }}
              formatter={(value, name, props) => {
                if (displayMode === 'nav' && name === 'estimate') {
                  const rate = props.payload.estRate;
                  return [
                    <span key="estimate">
                      {value} <span style={{ color: '#64748b', fontSize: '10px' }}>({rate}%)</span>
                    </span>,
                    '估值'
                  ];
                }
                if (displayMode === 'rate' && name === 'estRate') {
                  return [`${value}%`, '涨跌幅'];
                }
                return [value, name];
              }}
            />
            {displayMode === 'nav' && data.prevNav ? (
              <ReferenceLine
                y={data.prevNav}
                stroke="#94a3b8"
                strokeDasharray="3 3"
              />
            ) : displayMode === 'rate' ? (
              <ReferenceLine
                y={0}
                stroke="#94a3b8"
                strokeDasharray="3 3"
              />
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
        ) : (
          <div className="h-[220px] md:h-[280px] min-h-[220px] md:min-h-[280px] flex items-center justify-center text-slate-400">图表布局计算中...</div>
        )}
      </div>

      <div className="mt-2 text-xs text-slate-500 text-center">
        数据采集频率可在设置中配置 ·  仅在系统开启时运行（交易日 09:00-15:00）
      </div>
    </div>
  );
};
