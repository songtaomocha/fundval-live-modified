import { useState, useEffect, useCallback, useRef } from 'react';
import { getAccountPositions } from '../services/api';

/**
 * 账户数据管理 Hook
 * 负责数据获取、轮询、重试、错误处理
 *
 * @param {number} currentAccount - 当前账户 ID
 * @param {boolean} isActive - 是否激活轮询
 * @returns {Object} { data, loading, error, refetch }
 */
export function useAccountData(currentAccount, isActive = true) {
  const [data, setData] = useState({ summary: {}, positions: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const silentRefreshingRef = useRef(false);

  /**
   * 获取数据（带重试逻辑）
   */
  const fetchData = useCallback(async (retryCount = 0) => {
    setLoading(true);
    setError(null);

    try {
      const res = await getAccountPositions(currentAccount);
      setData(res);
    } catch (e) {
      console.error(e);

      const status = e?.response?.status;
      if (status === 401) {
        setError('登录已失效，请刷新页面后重新登录');
        return;
      }

      // 重试逻辑：最多重试 2 次，指数退避
      if (retryCount < 2) {
        const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s
        console.log(`Retrying in ${delay}ms... (attempt ${retryCount + 1}/2)`);
        setTimeout(() => fetchData(retryCount + 1), delay);
      } else {
        setError('加载账户数据失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [currentAccount]);

  /**
   * 静默刷新（轮询时使用，不显示 loading）
   */
  const silentRefresh = useCallback(async () => {
    if (silentRefreshingRef.current) return;
    silentRefreshingRef.current = true;
    try {
      const res = await getAccountPositions(currentAccount);
      setData(res);
    } catch (e) {
      console.error('Silent refresh failed:', e);
    } finally {
      silentRefreshingRef.current = false;
    }
  }, [currentAccount]);

  // 账户切换时重新加载数据
  useEffect(() => {
    fetchData();
  }, [currentAccount, fetchData]);

  // 轮询机制：基础 30 秒 + 抖动；后台页暂停，回前台立即补拉
  useEffect(() => {
    if (!isActive) return;

    let timer = null;
    let stopped = false;

    const schedule = (immediate = false) => {
      if (stopped) return;
      const jitter = Math.floor(Math.random() * 4000); // 0-4s
      const delay = immediate ? 0 : (30000 + jitter);
      timer = setTimeout(async () => {
        if (document.hidden) {
          schedule(false);
          return;
        }
        await silentRefresh();
        schedule(false);
      }, delay);
    };

    const onVisible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        schedule(true);
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    schedule(false);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isActive, silentRefresh]);

  return {
    data,
    loading,
    error,
    refetch: fetchData
  };
}
