import { useState, useEffect, useCallback } from 'react';
import {
  updatePosition,
  deletePosition,
  addPositionTrade,
  reducePositionTrade,
  updatePositionsNav,
  getPreferences,
  updatePreferences
} from '../services/api';

/**
 * 排序选项
 */
export const SORT_OPTIONS = [
  { label: '预估总值（从高到低）', key: 'est_market_value', direction: 'desc' },
  { label: '预估总值（从低到高）', key: 'est_market_value', direction: 'asc' },
  { label: '持有收益（从高到低）', key: 'accumulated_income', direction: 'desc' },
  { label: '持有收益（从低到高）', key: 'accumulated_income', direction: 'asc' },
  { label: '持有收益率（从高到低）', key: 'accumulated_return_rate', direction: 'desc' },
  { label: '持有收益率（从低到高）', key: 'accumulated_return_rate', direction: 'asc' },
  { label: '当日预估（从高到低）', key: 'day_income', direction: 'desc' },
  { label: '当日预估（从低到高）', key: 'day_income', direction: 'asc' },
  { label: '当日预估收益率（从高到低）', key: 'est_rate', direction: 'desc' },
  { label: '当日预估收益率（从低到高）', key: 'est_rate', direction: 'asc' },
];

/**
 * 持仓操作管理 Hook
 * 负责持仓的增删改、加仓、减仓、更新净值、同步关注、排序
 *
 * @param {number} currentAccount - 当前账户 ID
 * @param {Function} onPositionChange - 持仓变化回调
 * @param {Function} onSyncWatchlist - 同步关注列表回调
 * @param {Function} onRefetch - 重新获取数据回调
 * @returns {Object} 持仓操作相关的状态和方法
 */
export function usePositions(currentAccount, onPositionChange, onSyncWatchlist, onRefetch) {
  // 排序状态
  const [sortOption, setSortOption] = useState(SORT_OPTIONS[0]);
  const [sortLoaded, setSortLoaded] = useState(false);

  // 操作状态
  const [submitting, setSubmitting] = useState(false);
  const [navUpdating, setNavUpdating] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  /**
   * 加载排序偏好
   */
  useEffect(() => {
    const loadSortPreference = async () => {
      try {
        const prefs = await getPreferences();
        if (prefs.sortOption) {
          setSortOption(JSON.parse(prefs.sortOption));
        } else {
          // 从 localStorage 迁移
          const saved = localStorage.getItem('account_sort_option');
          if (saved) {
            const parsed = JSON.parse(saved);
            setSortOption(parsed);
            await updatePreferences({ sortOption: saved });
          }
        }
      } catch (e) {
        console.error('Failed to load sort preference', e);
      }
      setSortLoaded(true);
    };

    loadSortPreference();
  }, []);

  /**
   * 同步排序选项到后端
   */
  useEffect(() => {
    if (!sortLoaded) return;

    const syncSortOption = async () => {
      try {
        await updatePreferences({ sortOption: JSON.stringify(sortOption) });
      } catch (e) {
        console.error('Failed to sync sort option to backend', e);
      }
    };

    syncSortOption();
  }, [sortOption, sortLoaded]);

  /**
   * 新增/修改持仓
   */
  const handleUpdatePosition = useCallback(async (formData) => {
    if (!formData.code || !formData.cost || !formData.shares) {
      throw new Error('表单数据不完整');
    }

    setSubmitting(true);
    try {
      await updatePosition({
        code: formData.code,
        cost: parseFloat(formData.cost),
        shares: parseFloat(formData.shares)
      }, currentAccount);

      onPositionChange && onPositionChange(formData.code, 'add');
      onRefetch && onRefetch();
    } finally {
      setSubmitting(false);
    }
  }, [currentAccount, onPositionChange, onRefetch]);

  /**
   * 删除持仓
   */
  const handleDeletePosition = useCallback(async (code) => {
    if (!confirm(`确定删除 ${code} 吗？`)) return;

    try {
      await deletePosition(code, currentAccount);
      onPositionChange && onPositionChange(code, 'remove');
      onRefetch && onRefetch();
    } catch (e) {
      alert('删除失败');
      throw e;
    }
  }, [currentAccount, onPositionChange, onRefetch]);

  /**
   * 加仓
   */
  const handleAddPosition = useCallback(async (code, amount, tradeTime) => {
    if (!amount || parseFloat(amount) <= 0) {
      throw new Error('加仓金额必须大于 0');
    }

    try {
      const payload = { amount: parseFloat(amount), trade_time: tradeTime };
      const result = await addPositionTrade(code, payload, currentAccount);

      if (result.pending) {
        alert(result.message || '已记录，待净值公布后自动更新持仓');
      } else {
        alert(`加仓成功，确认净值 ${result.confirm_nav}，获得份额 ${result.shares_added}`);
      }

      onRefetch && onRefetch();
      return result;
    } catch (err) {
      alert(err.response?.data?.detail || '加仓失败');
      throw err;
    }
  }, [currentAccount, onRefetch]);

  /**
   * 减仓
   */
  const handleReducePosition = useCallback(async (code, shares, maxShares, tradeTime) => {
    if (!shares || parseFloat(shares) <= 0) {
      throw new Error('减仓份额必须大于 0');
    }

    const sh = parseFloat(shares);
    if (maxShares != null && sh > maxShares) {
      alert(`减仓份额不能大于当前持仓 ${maxShares}`);
      throw new Error('减仓份额超出限制');
    }

    try {
      const payload = { shares: sh, trade_time: tradeTime };
      const result = await reducePositionTrade(code, payload, currentAccount);

      if (result.pending) {
        alert(result.message || '已记录，待净值公布后自动更新持仓');
      } else {
        alert(`减仓成功，确认净值 ${result.confirm_nav}，到账金额约 ${result.amount_cny}`);
      }

      onRefetch && onRefetch();
      return result;
    } catch (err) {
      alert(err.response?.data?.detail || '减仓失败');
      throw err;
    }
  }, [currentAccount, onRefetch]);

  /**
   * 更新净值
   */
  const handleUpdateNav = useCallback(async () => {
    if (navUpdating) return;
    if (!confirm('确定手动更新所有持仓基金的净值吗？\\n这可能需要几秒钟时间。')) return;

    setNavUpdating(true);
    try {
      const result = await updatePositionsNav(currentAccount);
      const data = result.data;

      // 构建详细消息
      let msg = data.message || '净值更新完成';
      if (data.failed && data.failed.length > 0) {
        msg += `\\n\\n失败的基金：\\n${data.failed.map(f => `${f.code}: ${f.error}`).join('\\n')}`;
      }

      alert(msg);
      onRefetch && onRefetch();
    } catch (err) {
      alert(err.response?.data?.detail || '净值更新失败');
    } finally {
      setNavUpdating(false);
    }
  }, [navUpdating, currentAccount, onRefetch]);

  /**
   * 同步关注列表
   */
  const handleSyncWatchlist = useCallback(async (positions) => {
    if (!positions || positions.length === 0) return;
    if (!confirm(`确定将 ${positions.length} 个持仓基金同步到关注列表吗？`)) return;

    setSyncLoading(true);
    try {
      onSyncWatchlist && await onSyncWatchlist(positions);
    } finally {
      setSyncLoading(false);
    }
  }, [onSyncWatchlist]);

  /**
   * 排序持仓列表
   */
  const sortPositions = useCallback((positions) => {
    return [...positions].sort((a, b) => {
      const aValue = a[sortOption.key] || 0;
      const bValue = b[sortOption.key] || 0;
      return sortOption.direction === 'desc' ? bValue - aValue : aValue - bValue;
    });
  }, [sortOption]);

  return {
    // 排序
    sortOption,
    setSortOption,
    sortPositions,

    // 操作状态
    submitting,
    navUpdating,
    syncLoading,

    // 操作方法
    handleUpdatePosition,
    handleDeletePosition,
    handleAddPosition,
    handleReducePosition,
    handleUpdateNav,
    handleSyncWatchlist
  };
}
