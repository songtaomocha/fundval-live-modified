import React, { useState, useRef } from 'react';
import { Plus, Edit2, Trash2, RefreshCw, ArrowUpDown, ChevronDown, Download, CheckCircle, Clock } from 'lucide-react';
import { getRateColor } from '../components/StatCard';
import { PortfolioChart } from '../components/PortfolioChart';
import { useAccountData } from '../hooks/useAccountData';
import { usePositions, SORT_OPTIONS } from '../hooks/usePositions';
import { PositionModal, AddPositionModal, ReducePositionModal } from '../components/TradeModal';

const Account = ({ currentAccount = 1, onSelectFund, onPositionChange, onSyncWatchlist, syncLoading, isActive }) => {
  const { data, loading, error, refetch } = useAccountData(currentAccount, isActive);
  const {
    sortOption,
    setSortOption,
    sortPositions,
    submitting,
    navUpdating,
    syncLoading: positionSyncLoading,
    handleUpdatePosition,
    handleDeletePosition,
    handleAddPosition,
    handleReducePosition,
    handleUpdateNav,
    handleSyncWatchlist
  } = usePositions(currentAccount, onPositionChange, onSyncWatchlist, refetch);

  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPos, setEditingPos] = useState(null);
  const [addModalPos, setAddModalPos] = useState(null);
  const [reduceModalPos, setReduceModalPos] = useState(null);
  const sortDropdownRef = useRef(null);
  const isAggregatedView = currentAccount === 0;

  const { summary, positions } = data;
  const displayPositions = positions || [];
  const CATEGORIES = ['全部', '货币类', '偏债类', '偏股类', '商品类', '未分类'];

  const categoryCounts = CATEGORIES.reduce((acc, cat) => {
    acc[cat] = cat === '全部' ? displayPositions.length : displayPositions.filter(p => p.category === cat).length;
    return acc;
  }, {});

  const filteredPositions = selectedCategory === '全部' ? displayPositions : displayPositions.filter(p => p.category === selectedCategory);
  const sortedPositions = sortPositions(filteredPositions);

  const handleOpenModal = (pos = null) => { setEditingPos(pos); setModalOpen(true); };
  const handleSubmitPosition = async (formData) => { try { await handleUpdatePosition(formData); setModalOpen(false); } catch { alert('保存失败'); } };
  const handleSync = () => handleSyncWatchlist(positions);
  const handleSortChange = (option) => { setSortOption(option); setSortDropdownOpen(false); };

  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(event.target)) {
        setSortDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="space-y-3 sm:space-y-4 min-w-0">
      {isAggregatedView && <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800"><strong>正在查看全部账户的汇总数据</strong> - 汇总视图仅供查看，不支持修改操作。</div>}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-red-800 break-words">{error}</p>
          <button onClick={() => refetch()} className="text-sm font-medium text-red-600 hover:text-red-700 underline min-h-[44px] px-2">重试</button>
        </div>
      )}

      {loading && !data.positions.length ? (
        <div className="w-full bg-white rounded-2xl p-6 shadow-sm border border-slate-100 animate-pulse">
          <div className="h-8 bg-slate-200 rounded w-1/3 mb-4"></div><div className="h-32 bg-slate-200 rounded mb-4"></div>
        </div>
      ) : (
        <PortfolioChart positions={positions} summary={summary} loading={loading} onRefresh={refetch} />
      )}

      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <h2 className="text-lg sm:text-xl font-bold text-slate-800">{isAggregatedView ? '全部账户持仓汇总' : '持仓明细'}</h2>
          <div className="grid grid-cols-2 sm:flex gap-2">
            <div className="relative" ref={sortDropdownRef}>
              <button onClick={() => setSortDropdownOpen(!sortDropdownOpen)} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-200 px-3 py-2 min-h-[44px] rounded-lg transition-colors text-sm font-medium">
                <ArrowUpDown className="w-4 h-4" />排序<ChevronDown className={`w-3 h-3 transition-transform ${sortDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {sortDropdownOpen && <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1">{SORT_OPTIONS.map((option, index) => <button key={index} onClick={() => handleSortChange(option)} className={`w-full text-left px-4 py-2 min-h-[44px] text-sm transition-colors ${sortOption.label === option.label ? 'bg-blue-50 text-blue-600 font-medium' : 'text-slate-700 hover:bg-slate-50'}`}>{option.label}</button>)}</div>}
            </div>

            <button onClick={handleSync} disabled={syncLoading || positionSyncLoading} className="flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-200 px-3 py-2 min-h-[44px] rounded-lg transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              <RefreshCw className={`w-4 h-4 ${(syncLoading || positionSyncLoading) ? 'animate-spin' : ''}`} />{(syncLoading || positionSyncLoading) ? '同步中...' : '同步关注'}
            </button>
            <button onClick={handleUpdateNav} disabled={navUpdating} className="flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-600 hover:text-green-600 hover:border-green-200 px-3 py-2 min-h-[44px] rounded-lg transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              <Download className={`w-4 h-4 ${navUpdating ? 'animate-spin' : ''}`} />{navUpdating ? '更新中...' : '更新净值'}
            </button>
            {!isAggregatedView && <button onClick={() => handleOpenModal()} className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 min-h-[44px] rounded-lg transition-colors text-sm font-medium"><Plus className="w-4 h-4" />记一笔</button>}
          </div>
        </div>

        <div className="flex gap-1 bg-slate-50 p-1 rounded-lg overflow-x-auto no-scrollbar">
          {CATEGORIES.map(cat => <button key={cat} onClick={() => setSelectedCategory(cat)} className={`px-3 py-2 min-h-[44px] rounded text-sm font-medium transition-colors whitespace-nowrap ${selectedCategory === cat ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white hover:text-blue-600'}`}>{cat} ({categoryCounts[cat]})</button>)}
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {sortedPositions.length === 0 ? <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-center text-slate-400">暂无持仓，快去记一笔吧</div> : sortedPositions.map((pos) => (
          <div key={pos.code} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <button onClick={() => onSelectFund && onSelectFund(pos.code)} className="text-left w-full min-h-[44px]">
              <div className="font-semibold text-slate-800 truncate">{pos.name}</div>
              <div className="text-xs text-slate-400 font-mono">{pos.code}</div>
            </button>
            <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
              <div><div className="text-xs text-slate-400">净值 | 估值</div><div className="font-mono text-slate-700">{pos.nav.toFixed(4)} | <span className={getRateColor(pos.est_rate)}>{pos.estimate > 0 ? pos.estimate.toFixed(4) : '--'}</span></div></div>
              <div><div className="text-xs text-slate-400">份额 | 成本</div><div className="font-mono text-slate-700">{pos.shares.toLocaleString()} | {pos.cost.toFixed(4)}</div></div>
              <div><div className="text-xs text-slate-400">持有收益</div><div className={`font-mono ${getRateColor(pos.accumulated_income)}`}>{pos.accumulated_income > 0 ? '+' : ''}{pos.accumulated_income.toFixed(2)}</div></div>
              <div><div className="text-xs text-slate-400">当日预估</div><div className={`font-mono ${!pos.is_est_valid ? 'text-slate-300' : getRateColor(pos.day_income)}`}>{pos.is_est_valid ? (pos.day_income > 0 ? '+' : '') + pos.day_income.toFixed(2) : '--'}</div></div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-slate-400 flex items-center gap-1">{pos.nav_updated_today ? <CheckCircle className="w-3 h-3 text-green-500" /> : <Clock className="w-3 h-3 text-slate-300" />}{pos.nav_updated_today ? '净值已更新' : '净值未更新'}</span>
              {!isAggregatedView && <div className="flex gap-2"><button onClick={() => handleOpenModal(pos)} className="h-11 w-11 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors flex items-center justify-center"><Edit2 className="w-4 h-4" /></button><button onClick={() => handleDeletePosition(pos.code)} className="h-11 w-11 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors flex items-center justify-center"><Trash2 className="w-4 h-4" /></button></div>}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse min-w-[760px] xl:min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500 font-medium text-xs uppercase tracking-wider sticky top-[73px] z-30 shadow-sm">
            <tr><th className="px-4 py-3 text-left">基金</th><th className="px-4 py-3 text-right">净值 | 估值</th><th className="px-4 py-3 text-right">份额 | 成本</th><th className="px-4 py-3 text-right hidden xl:table-cell">持有收益</th><th className="px-4 py-3 text-right hidden xl:table-cell">当日预估</th><th className="px-4 py-3 text-right">预估总值</th><th className="px-4 py-3 text-center">操作</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedPositions.length === 0 ? <tr><td colSpan="7" className="px-4 py-8 text-center text-slate-400">暂无持仓，快去记一笔吧</td></tr> : sortedPositions.map((pos) => (
              <tr key={pos.code} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 cursor-pointer group max-w-[180px]" onClick={() => onSelectFund && onSelectFund(pos.code)}><div className="font-medium text-slate-800 group-hover:text-blue-600 transition-colors truncate" title={pos.name}>{pos.name}</div><div className="text-xs text-slate-400 font-mono">{pos.code}</div></td>
                <td className="px-4 py-3 text-right font-mono"><div className="text-slate-500 text-xs">{pos.nav.toFixed(4)}</div><div className={`font-medium ${getRateColor(pos.est_rate)}`}>{pos.estimate > 0 ? pos.estimate.toFixed(4) : '--'}</div></td>
                <td className="px-4 py-3 text-right font-mono text-slate-600"><div>{pos.shares.toLocaleString()}</div><div className="text-xs text-slate-400">{pos.cost.toFixed(4)}</div></td>
                <td className="px-4 py-3 text-right font-mono hidden xl:table-cell"><div className={`font-medium ${getRateColor(pos.accumulated_income)}`}>{pos.accumulated_income > 0 ? '+' : ''}{pos.accumulated_income.toFixed(2)}</div></td>
                <td className="px-4 py-3 text-right font-mono hidden xl:table-cell"><div className={`font-medium ${!pos.is_est_valid ? 'text-slate-300' : getRateColor(pos.day_income)}`}>{pos.is_est_valid ? (pos.day_income > 0 ? '+' : '') + pos.day_income.toFixed(2) : '--'}</div></td>
                <td className="px-4 py-3 text-right font-mono"><div className="text-slate-800 font-medium">{pos.est_market_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></td>
                <td className="px-4 py-3 text-center">{!isAggregatedView && <div className="flex justify-center gap-1"><button onClick={() => handleOpenModal(pos)} className="h-11 w-11 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors flex items-center justify-center"><Edit2 className="w-4 h-4" /></button><button onClick={() => handleDeletePosition(pos.code)} className="h-11 w-11 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors flex items-center justify-center"><Trash2 className="w-4 h-4" /></button></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PositionModal isOpen={modalOpen} onClose={() => setModalOpen(false)} onSubmit={handleSubmitPosition} editingPos={editingPos} submitting={submitting} onOpenAdd={setAddModalPos} onOpenReduce={setReduceModalPos} currentAccount={currentAccount} />
      <AddPositionModal isOpen={!!addModalPos} onClose={() => setAddModalPos(null)} onSubmit={handleAddPosition} position={addModalPos} submitting={submitting} />
      <ReducePositionModal isOpen={!!reduceModalPos} onClose={() => setReduceModalPos(null)} onSubmit={handleReducePosition} position={reduceModalPos} submitting={submitting} />
    </div>
  );
};

export default Account;
