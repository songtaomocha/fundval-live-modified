import React, { useEffect, useState, useId, useRef, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { getFundHistory } from '../services/api';

const RANGES = [
  { label: '近1周', val: 5 },
  { label: '近1月', val: 22 },
  { label: '近3月', val: 66 },
  { label: '近半年', val: 130 },
  { label: '近1年', val: 250 },
  { label: '成立来', val: 9999 },
];

export const HistoryChart = ({ fundId, accountId = null }) => {
  const [data, setData] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(22); // Default 1M
  const gradientId = useId().replace(/:/g, '_');
  const chartWrapRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(() => (typeof window !== 'undefined' ? Math.max(Math.min(window.innerWidth - 64, 1200), 320) : 320));
  const [chartHeight, setChartHeight] = useState(300);

  useEffect(() => {
    if (!fundId) return;

    const fetchHistory = async () => {
      setLoading(true);
      try {
        const result = await getFundHistory(fundId, range, accountId);
        // Handle both old format (array) and new format (object)
        if (Array.isArray(result)) {
          setData(result);
          setTransactions([]);
        } else {
          setData(result.history || []);
          setTransactions(result.transactions || []);
        }
      } catch (e) {
        console.error("Failed to load history", e);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [fundId, range, accountId]);

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const fallbackWidth = Math.max(Math.min(window.innerWidth - 64, 1200), 320);
      const w = Math.floor(rect.width || 0);
      const h = Math.floor(rect.height || 0);
      setChartWidth(w > 0 ? w : fallbackWidth);
      setChartHeight(h > 0 ? h : 300);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('orientationchange', update);
    window.addEventListener('resize', update);

    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', update);
      window.removeEventListener('resize', update);
    };
  }, [fundId, range]);

  // Ensure hooks order is stable across renders
  const validData = useMemo(
    () => (Array.isArray(data) ? data.filter(d => d && d.date && d.nav !== null && d.nav !== undefined) : []),
    [data]
  );

  const xTicks = useMemo(() => {
    const dates = validData.map((d) => d.date);
    const n = dates.length;
    if (n <= 1) return dates;

    const desired = Math.max(4, Math.min(7, Math.floor((chartWidth || 320) / 90)));
    const count = Math.min(desired, n);
    if (count <= 2) return [dates[0], dates[n - 1]];

    const ticks = [dates[0]];
    for (let i = 1; i < count - 1; i++) {
      const idx = Math.round((i * (n - 1)) / (count - 1));
      const value = dates[idx];
      if (value && value !== ticks[ticks.length - 1]) ticks.push(value);
    }
    if (ticks[ticks.length - 1] !== dates[n - 1]) ticks.push(dates[n - 1]);
    return ticks;
  }, [validData, chartWidth]);

  const yDomain = useMemo(() => {
    const values = validData.map((d) => Number(d.nav)).filter((v) => Number.isFinite(v));
    if (values.length === 0) return ['auto', 'auto'];

    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const pad = Math.max(span * 0.12, 0.0008);
    return [Number((min - pad).toFixed(6)), Number((max + pad).toFixed(6))];
  }, [validData]);

  if (loading) return <div className="h-64 flex items-center justify-center text-slate-400">加载走势中...</div>;
  if (!data || data.length === 0) return <div className="h-64 flex items-center justify-center text-slate-400">暂无历史数据</div>;
  if (validData.length === 0) return <div className="h-64 flex items-center justify-center text-slate-400">暂无有效数据</div>;

  // Custom dot component for transaction markers
  const TransactionDot = (props) => {
    const { cx, cy, payload } = props;
    const transaction = transactions.find(t => t.date === payload.date);

    if (!transaction) return null;

    const isBuy = transaction.type === 'buy';
    const color = isBuy ? '#ef4444' : '#10b981'; // red for buy, green for sell
    const label = isBuy ? 'B' : 'S';

    return (
      <g>
        <circle cx={cx} cy={cy} r={12} fill={color} stroke="white" strokeWidth={2} />
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="white"
          fontSize={10}
          fontWeight="bold"
        >
          {label}
        </text>
      </g>
    );
  };

  // Custom tooltip to show transaction info
  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload || !payload.length) return null;

    const point = payload[0].payload;
    const transaction = transactions.find(t => t.date === point.date);

    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-slate-200">
        <p className="text-xs text-slate-500 mb-1">{point.date}</p>
        <p className="text-sm font-bold text-slate-800">净值: {point.nav?.toFixed(4)}</p>
        {transaction && (
          <div className={`mt-2 pt-2 border-t ${transaction.type === 'buy' ? 'border-red-200' : 'border-green-200'}`}>
            <p className={`text-xs font-bold ${transaction.type === 'buy' ? 'text-red-600' : 'text-green-600'}`}>
              {transaction.type === 'buy' ? '买入' : '卖出'}
            </p>
            {transaction.amount && (
              <p className="text-xs text-slate-600">金额: ¥{transaction.amount.toFixed(2)}</p>
            )}
            {transaction.shares && (
              <p className="text-xs text-slate-600">份额: {transaction.shares.toFixed(2)}</p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full">
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {RANGES.map((r) => (
          <button
            key={r.label}
            onClick={() => setRange(r.val)}
            className={`px-3 min-h-[44px] text-xs rounded-full whitespace-nowrap transition-colors ${
              range === r.val
                ? 'bg-blue-600 text-white font-medium'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {transactions.length > 0 && (
        <div className="mb-2 flex items-center gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white font-bold text-[8px]">B</div>
            <span>买入</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white font-bold text-[8px]">S</div>
            <span>卖出</span>
          </div>
        </div>
      )}

      <div ref={chartWrapRef} className="h-[320px] md:h-[400px] w-full min-h-[320px] md:min-h-[400px] min-w-0 overflow-hidden">
          <AreaChart
            width={Math.max(chartWidth || 0, 320)}
            height={Math.max(chartHeight || 0, 300)}
            data={validData}
            margin={chartWidth < 768
              ? { top: 10, right: 12, left: 4, bottom: 4 }
              : { top: 14, right: 28, left: 10, bottom: 6 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
            <XAxis
              dataKey="date"
              ticks={xTicks}
              tick={{fontSize: 10, fill: '#94a3b8'}}
              tickLine={false}
              axisLine={false}
              tickFormatter={(str) => String(str || '').slice(0, 10)}
              minTickGap={20}
              interval={0}
              padding={chartWidth < 768 ? { left: 2, right: 8 } : { left: 10, right: 16 }}
              tickMargin={chartWidth < 768 ? 10 : 14}
              angle={-45}
              textAnchor="middle"
              height={chartWidth < 768 ? 48 : 52}
            />
            <YAxis
              domain={yDomain}
              tick={{fontSize: 10, fill: '#94a3b8'}}
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(value) => Number(value).toFixed(4)}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="nav"
              stroke="#3b82f6"
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#${gradientId})`}
              animationDuration={500}
              dot={<TransactionDot />}
            />
          </AreaChart>
      </div>
    </div>
  );
};
