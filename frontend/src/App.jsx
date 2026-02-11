import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import {
  Search,
  ChevronLeft,
  Wallet,
  LayoutGrid,
  Settings as SettingsIcon,
  Users,
  LogOut,
  UserCog
} from 'lucide-react';
import Login from './pages/Login';
import { SubscribeModal } from './components/SubscribeModal';
import { AccountModal } from './components/AccountModal';

const FundList = lazy(() => import('./pages/FundList').then(m => ({ default: m.FundList })));
const FundDetail = lazy(() => import('./pages/FundDetail').then(m => ({ default: m.FundDetail })));
const Account = lazy(() => import('./pages/Account'));
const Settings = lazy(() => import('./pages/Settings'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
import { searchFunds, getFundQuote, getFundQuotes, getFundDetail, getAccountPositions, subscribeFund, getAccounts, getPreferences, updatePreferences } from './services/api';
import { useAuth } from './contexts/AuthContext';
import packageJson from '../../package.json';

const APP_VERSION = packageJson.version;

const isWatchlistDebugEnabled = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const byQuery = params.get('debugWatchlist');
    if (byQuery === '1' || byQuery === 'true' || byQuery === 'on') return true;
    if (byQuery === '0' || byQuery === 'false' || byQuery === 'off') return false;

    const byStorage = localStorage.getItem('fundval_debug_watchlist');
    return byStorage === '1' || byStorage === 'true' || byStorage === 'on';
  } catch {
    return false;
  }
};

export default function App() {
  const { currentUser, isMultiUserMode, loading: authLoading, logout } = useAuth();

  // 路由守卫：多用户模式下未登录显示登录页
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">加载中...</p>
        </div>
      </div>
    );
  }

  if (isMultiUserMode && !currentUser) {
    return <Login />;
  }

  return <AppContent currentUser={currentUser} isMultiUserMode={isMultiUserMode} isAdmin={currentUser?.is_admin || false} logout={logout} />;
}

function AppContent({ currentUser, isMultiUserMode, isAdmin, logout }) {
  // --- State ---
  const [currentView, setCurrentView] = useState('list'); // 'list' | 'detail' | 'account' | 'settings' | 'users'
  const [currentAccount, setCurrentAccount] = useState(currentUser?.default_account_id || 1);
  const [accounts, setAccounts] = useState([]);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeoutRef = useRef(null);
  const watchlistRef = useRef([]);
  const currentViewRef = useRef('list');
  const fundFetchCooldownRef = useRef({});
  const pollRunningRef = useRef(false);
  const pendingHydrateRef = useRef(new Set());
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedFund, setSelectedFund] = useState(null);
  const [detailFundId, setDetailFundId] = useState(null);
  const [accountCodes, setAccountCodes] = useState(new Set());
  const watchlistPersistSigRef = useRef('');
  const watchlistDebug = useRef(isWatchlistDebugEnabled());

  const dlog = (...args) => {
    if (watchlistDebug.current) {
      console.log('[WATCHLIST_DEBUG]', ...args);
    }
  };

  // Debug switch helpers (run once)
  useEffect(() => {
    dlog('enabled', {
      query: window.location.search,
      localStorage: localStorage.getItem('fundval_debug_watchlist')
    });
    window.__fundvalWatchlistDebug = {
      on: () => localStorage.setItem('fundval_debug_watchlist', '1'),
      off: () => localStorage.setItem('fundval_debug_watchlist', '0'),
      status: () => ({ enabled: watchlistDebug.current }),
    };
  }, []);

  // Load preferences from backend on mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await getPreferences();

        // Parse watchlist (merge backend + local backup to avoid random disappear on auth/session jitter)
        const watchlistData = JSON.parse(prefs.watchlist || '[]');

        let localWatchlistData = [];
        const savedWatchlist = localStorage.getItem('fundval_watchlist');
        if (savedWatchlist) {
          try {
            localWatchlistData = JSON.parse(savedWatchlist);
          } catch (parseError) {
            console.error('Failed to parse localStorage watchlist', parseError);
          }
        }

        const merged = [...watchlistData, ...localWatchlistData];
        const seen = new Set();
        const deduped = merged.filter(fund => {
          if (!fund?.id) return false;
          if (seen.has(fund.id)) return false;
          seen.add(fund.id);
          return true;
        });
        dlog('loadPreferences merged', {
          backendCount: watchlistData.length,
          localCount: localWatchlistData.length,
          finalCount: deduped.length,
          ids: deduped.map(f => f.id),
        });
        setWatchlist(deduped);

        // Best-effort writeback merged result to backend（真正后台异步，不阻塞首屏）
        updatePreferences({ watchlist: JSON.stringify(deduped) })
          .then(() => dlog('loadPreferences writeback ok', { count: deduped.length }))
          .catch((e) => {
            console.warn('Best-effort watchlist writeback skipped', e);
            dlog('loadPreferences writeback failed', { error: String(e) });
          });

        // Set current account
        if (prefs.currentAccount && prefs.currentAccount !== 1) {
          setCurrentAccount(prefs.currentAccount);
        } else if (currentUser?.default_account_id) {
          setCurrentAccount(currentUser.default_account_id);
        } else {
          const savedAccount = localStorage.getItem('fundval_current_account');
          if (savedAccount) {
            const accountId = parseInt(savedAccount);
            setCurrentAccount(accountId);
            await updatePreferences({ currentAccount: accountId });
            console.log('Migrated current account from localStorage to backend');
          } else {
            setCurrentAccount(1);
          }
        }

        setPreferencesLoaded(true);
      } catch (e) {
        console.error('Failed to load preferences from backend', e);
        dlog('loadPreferences failed, fallback to localStorage', { error: String(e) });
        try {
          const savedWatchlist = localStorage.getItem('fundval_watchlist');
          const savedAccount = localStorage.getItem('fundval_current_account');

          if (savedWatchlist) {
            const parsed = JSON.parse(savedWatchlist);
            const seen = new Set();
            const deduped = parsed.filter(fund => {
              if (seen.has(fund.id)) return false;
              seen.add(fund.id);
              return true;
            });
            dlog('fallback localStorage watchlist', { count: deduped.length, ids: deduped.map(f => f.id) });
            setWatchlist(deduped);
          }

          if (savedAccount) {
            setCurrentAccount(parseInt(savedAccount));
          } else if (currentUser?.default_account_id) {
            setCurrentAccount(currentUser.default_account_id);
          }
        } catch (migrationError) {
          console.error('Migration from localStorage failed', migrationError);
        }

        setPreferencesLoaded(true);
      }
    };

    loadPreferences();
  }, []); // 避免认证抖动导致关注列表被后端旧值覆盖

  // Sync watchlist to backend whenever structural list changes (ids/order), not quote updates
  useEffect(() => {
    if (!preferencesLoaded) return;

    const persistableWatchlist = watchlist.map(f => ({
      id: f.id,
      name: f.name,
      type: f.type,
      trusted: f.trusted !== false,
    }));

    const payload = JSON.stringify(persistableWatchlist);
    const sig = persistableWatchlist.map(f => f.id).join(',');
    if (watchlistPersistSigRef.current === sig) {
      dlog('syncWatchlist skipped (no structural change)', { sig });
      return;
    }
    watchlistPersistSigRef.current = sig;
    dlog('syncWatchlist start', { count: persistableWatchlist.length, sig, ids: persistableWatchlist.map(f => f.id) });

    const syncWatchlist = async () => {
      // Always keep a local backup to avoid "visible now, missing after refresh" when auth/session fails.
      try {
        localStorage.setItem('fundval_watchlist', payload);
      } catch (e) {
        console.warn('Failed to cache watchlist in localStorage', e);
      }

      try {
        await updatePreferences({ watchlist: payload });
        dlog('syncWatchlist backend ok', { count: persistableWatchlist.length });
      } catch (e) {
        console.error('Failed to sync watchlist to backend', e);
        dlog('syncWatchlist backend failed', { error: String(e) });
      }
    };

    syncWatchlist();
  }, [watchlist, preferencesLoaded]);

  // Sync current account to backend whenever it changes
  useEffect(() => {
    if (!preferencesLoaded) return;

    const syncAccount = async () => {
      // Local backup first (same reason as watchlist)
      try {
        localStorage.setItem('fundval_current_account', String(currentAccount));
      } catch (e) {
        console.warn('Failed to cache current account in localStorage', e);
      }

      try {
        await updatePreferences({ currentAccount });
      } catch (e) {
        console.error('Failed to sync current account to backend', e);
      }
    };

    syncAccount();
  }, [currentAccount, preferencesLoaded]);

  // Load accounts
  const loadAccounts = async () => {
    const accs = await getAccounts();
    setAccounts(accs);

    // 如果当前账户不在账户列表中，设置为用户的默认账户或第一个账户
    if (accs.length > 0) {
      const accountIds = accs.map(acc => acc.id);
      if (!accountIds.includes(currentAccount) && currentAccount !== 0) {
        // 优先使用用户的默认账户
        const defaultAccountId = currentUser?.default_account_id;
        if (defaultAccountId && accountIds.includes(defaultAccountId)) {
          setCurrentAccount(defaultAccountId);
        } else {
          setCurrentAccount(accs[0].id);
        }
      }
    }
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  // Keep latest watchlist in ref to avoid polling stale-closure overwrites
  useEffect(() => {
    watchlistRef.current = watchlist;
  }, [watchlist]);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  // 首屏/新增后立即补齐详情：不等 30s 轮询，优先提升可感知速度
  useEffect(() => {
    if (!watchlist || watchlist.length === 0) return;

    const candidates = watchlist.filter(
      (f) => f?.id && (f.trusted === false || (!f.estimate && (f.estRate || 0) === 0))
    );
    if (candidates.length === 0) return;

    const queue = candidates
      .filter(f => !pendingHydrateRef.current.has(f.id))
      .slice(0, 6); // 限流，避免首屏瞬时打满

    if (queue.length === 0) return;

    queue.forEach(f => pendingHydrateRef.current.add(f.id));

    (async () => {
      try {
        const quotes = await getFundQuotes(queue.map(f => f.id));
        const quoteMap = new Map((quotes || []).map(q => [q.id, q]));
        setWatchlist(prev => prev.map(f => quoteMap.has(f.id) ? { ...f, ...quoteMap.get(f.id), trusted: true } : f));
      } catch (e) {
        dlog('instant hydrate batch failed', { error: String(e) });
      } finally {
        queue.forEach(f => pendingHydrateRef.current.delete(f.id));
      }
    })();
  }, [watchlist]);

  // Fetch account codes to prevent duplicates
  const fetchAccountCodes = async () => {
    try {
        const data = await getAccountPositions(currentAccount);
        setAccountCodes(new Set((data.positions || []).map(p => p.code)));
    } catch (e) {
        console.error("Failed to fetch account codes", e);
    }
  };

  useEffect(() => {
    fetchAccountCodes();
  }, [currentView, currentAccount]); // Refresh when switching views or accounts
  
  // --- Data Fetching ---
  
  // Polling for updates (use ref + functional setState to avoid add/remove being overwritten)
  useEffect(() => {
    const tick = async () => {
      if (pollRunningRef.current) return;
      // 详情页暂停列表轮询，避免与重详情请求抢资源导致“补拉很慢/失败”
      if (currentViewRef.current === 'detail') return;
      pollRunningRef.current = true;

      const currentWatchlist = watchlistRef.current;
      if (!currentWatchlist || currentWatchlist.length === 0) {
        pollRunningRef.current = false;
        return;
      }

      try {
        const now = Date.now();
        const activeFunds = currentWatchlist.filter(f => now >= (fundFetchCooldownRef.current[f.id] || 0));
        if (activeFunds.length > 0) {
          const quotes = await getFundQuotes(activeFunds.map(f => f.id));
          const updatedMap = new Map((quotes || []).map(q => [q.id, q]));

          setWatchlist(prev => {
            const next = prev.map(f => updatedMap.has(f.id) ? { ...f, ...updatedMap.get(f.id) } : f);
            dlog('poll merge(batch)', { prevCount: prev.length, nextCount: next.length, ids: next.map(f => f.id) });
            return next;
          });

          // batch 成功后清理冷却
          activeFunds.forEach(f => {
            if (fundFetchCooldownRef.current[f.id]) {
              delete fundFetchCooldownRef.current[f.id];
            }
          });
        }
      } catch (e) {
        const status = e?.response?.status;
        if (status === 502 || status === 503 || status === 504) {
          const until = Date.now() + 120000;
          (currentWatchlist || []).forEach(f => {
            fundFetchCooldownRef.current[f.id] = until;
          });
          dlog('poll batch cooldown set', { status, until });
        }
        console.error("Polling error", e);
      } finally {
        pollRunningRef.current = false;
      }
    };

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
        await tick();
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
    schedule(true);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []); 


  // --- Handlers ---

  // Search funds with debounce
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await searchFunds(searchQuery);
        setSearchResults(results || []);
        setShowSearchResults(true);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  const handleSelectFund = async (fund) => {
    setShowSearchResults(false);
    setSearchQuery('');

    // 先秒加占位，避免“添加很慢”
    const placeholderFund = {
      ...fund,
      name: fund.name || fund.id,
      estimate: fund.estimate || 0,
      nav: fund.nav || 0,
      estRate: fund.estRate || 0,
      trusted: false,
    };

    const alreadyExists = (watchlistRef.current || []).some(f => f.id === placeholderFund.id);
    if (alreadyExists) {
      dlog('add skipped duplicate(placeholder)', { id: placeholderFund.id });
      return;
    }

    setWatchlist(prev => {
      if (prev.find(f => f.id === placeholderFund.id)) return prev;
      const next = [...prev, placeholderFund];
      dlog('add success(placeholder)', { id: placeholderFund.id, prevCount: prev.length, nextCount: next.length });
      return next;
    });

    setLoading(true);
    try {
      const quote = await getFundQuote(fund.id);
      setWatchlist(prev => prev.map(f => f.id === fund.id ? { ...f, ...quote, trusted: true } : f));
      dlog('add quote hydrated', { id: fund.id });
    } catch (e) {
      dlog('add detail hydrate failed', { id: fund.id, error: String(e) });
      // 不阻塞体验：保留占位，等待轮询补齐
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery || searchResults.length === 0) return;

    // Select first result
    await handleSelectFund(searchResults[0]);
  };

  const removeFund = (id) => {
    setWatchlist(prev => {
      const next = prev.filter(f => f.id !== id);
      dlog('remove', { id, prevCount: prev.length, nextCount: next.length, existed: prev.length !== next.length });
      return next;
    });
  };

  const notifyPositionChange = (code, type = 'add') => {
      if (type === 'add') {
          // Update local account codes set
          setAccountCodes(prev => {
              const next = new Set(prev);
              next.add(code);
              return next;
          });
      } else if (type === 'remove') {
          setAccountCodes(prev => {
              const next = new Set(prev);
              next.delete(code);
              return next;
          });
      }
  };

  const openSubscribeModal = (fund) => {
    setSelectedFund(fund);
    setModalOpen(true);
  };

  const ensureFundDetail = async (fundId, { silent = false } = {}) => {
    const applyDetail = (detail) => {
      setWatchlist(prev => {
        const idx = prev.findIndex(f => f.id === fundId);
        if (idx === -1) {
          return [...prev, { ...detail, trusted: true }];
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...detail, trusted: true };
        return next;
      });
    };

    try {
      const detail = await getFundDetail(fundId);
      applyDetail(detail);
      return true;
    } catch (e1) {
      console.error('load detail failed(first)', e1);
      // 快速二次重试一次，规避上游短抖动
      try {
        await new Promise(r => setTimeout(r, 600));
        const detail2 = await getFundDetail(fundId);
        applyDetail(detail2);
        return true;
      } catch (e2) {
        console.error('load detail failed(retry)', e2);
        if (!silent) alert('基金详情加载失败，请稍后重试');
        return false;
      }
    }
  };

  const handleCardClick = async (fundId) => {
    // 先切到详情页，保证交互即时
    setDetailFundId(fundId);
    setCurrentView('detail');
    window.scrollTo(0, 0);

    // 再异步补齐重详情（持仓/指标/AI分析等）
    await ensureFundDetail(fundId);
  };

  const handleBack = () => {
    setCurrentView('list');
    setDetailFundId(null);
  };

  const handleSubscribeSubmit = async (fund, formData) => {
    try {
        await subscribeFund(fund.id, formData);
        alert(`已更新 ${fund.name} 的订阅设置：\n发送至：${formData.email}\n阈值：涨>${formData.thresholdUp}% 或 跌<${formData.thresholdDown}%`);
        setModalOpen(false);
    } catch (e) {
        alert('订阅设置保存失败，请检查网络或后端配置');
    }
  };

  const [syncLoading, setSyncLoading] = useState(false);

  const handleSyncWatchlist = async (positions) => {
      if (!positions || positions.length === 0) return;
      if (syncLoading) return; // Prevent duplicate clicks

      const existingIds = new Set(watchlist.map(f => f.id));
      const newFunds = positions.filter(p => !existingIds.has(p.code));

      if (newFunds.length === 0) {
          alert('所有持仓已在关注列表中');
          return;
      }

      setSyncLoading(true);
      try {
          const addedFunds = await Promise.all(
              newFunds.map(async (pos) => {
                  try {
                      const quote = await getFundQuote(pos.code);
                      // 确保返回的数据有 id 字段
                      if (!quote.id) {
                          console.error(`Fund ${pos.code} has no id field`, quote);
                          return null;
                      }
                      return { ...quote, trusted: true };
                  } catch (e) {
                      console.error(`Failed to sync ${pos.code}`, e);
                      return null;
                  }
              })
          );

          const validFunds = addedFunds.filter(f => f !== null);

          if (validFunds.length > 0) {
              console.log('Adding funds to watchlist:', validFunds.map(f => ({ id: f.id, name: f.name })));
              setWatchlist(prev => {
                  // 过滤掉已存在的基金，避免重复
                  const existingIds = new Set(prev.map(f => f.id));
                  const newFunds = validFunds.filter(f => !existingIds.has(f.id));

                  if (newFunds.length === 0) {
                      console.log('All funds already in watchlist');
                      return prev;
                  }

                  const updated = [...prev, ...newFunds];
                  console.log('Updated watchlist length:', updated.length);
                  return updated;
              });
              alert(`成功同步 ${validFunds.length} 个基金到关注列表`);
          } else {
              alert('同步失败：无法获取基金详情');
          }
      } catch (e) {
          console.error('Sync error:', e);
          alert('同步失败');
      } finally {
          setSyncLoading(false);
      }
  };

  const currentDetailFund = detailFundId ? watchlist.find(f => f.id === detailFundId) : null;
  const currentDetailIndex = detailFundId ? watchlist.findIndex(f => f.id === detailFundId) : -1;

  // Navigate between funds in detail view
  const navigateFund = (direction) => {
    if (currentDetailIndex === -1) return;

    const newIndex = direction === 'prev' ? currentDetailIndex - 1 : currentDetailIndex + 1;
    if (newIndex >= 0 && newIndex < watchlist.length) {
      handleCardClick(watchlist[newIndex].id);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 overflow-x-hidden">
      
      {/* 1. Header Area */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-2 sm:py-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4">
            
            {/* Logo / Back Button */}
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {currentView === 'detail' ? (
                <button 
                  onClick={handleBack}
                  className="mr-2 h-11 w-11 -ml-1 rounded-full hover:bg-slate-100 text-slate-600 transition-colors flex items-center justify-center"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              ) : (
                <div className="flex gap-2">
                   <button
                      onClick={() => setCurrentView('list')}
                      className={`h-11 w-11 flex items-center justify-center rounded-lg transition-colors ${currentView === 'list' ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
                   >
                      <LayoutGrid className="w-6 h-6" />
                   </button>
                   <button
                      onClick={() => setCurrentView('account')}
                      className={`h-11 w-11 flex items-center justify-center rounded-lg transition-colors ${currentView === 'account' ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
                   >
                      <Wallet className="w-6 h-6" />
                   </button>
                   {/* 管理员：显示用户管理按钮 */}
                   {isMultiUserMode && isAdmin && (
                     <button
                        onClick={() => setCurrentView('users')}
                        className={`h-11 w-11 flex items-center justify-center rounded-lg transition-colors ${currentView === 'users' ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
                        title="用户管理"
                     >
                        <UserCog className="w-6 h-6" />
                     </button>
                   )}
                   <button
                      onClick={() => setCurrentView('settings')}
                      className={`h-11 w-11 flex items-center justify-center rounded-lg transition-colors ${currentView === 'settings' ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
                   >
                      <SettingsIcon className="w-6 h-6" />
                   </button>
                </div>
              )}

              {/* Account Selector */}
              {currentView === 'account' && accounts.length > 0 && (
                <div className="order-3 w-full sm:order-none sm:w-auto flex items-center gap-2 ml-0 sm:ml-2 lg:ml-4">
                  <select
                    value={currentAccount}
                    onChange={(e) => setCurrentAccount(Number(e.target.value))}
                    className="h-11 px-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent w-full sm:w-auto sm:min-w-[180px]"
                  >
                    <option value={0}>全部账户</option>
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>{acc.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setAccountModalOpen(true)}
                    className="h-11 w-11 text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex items-center justify-center"
                    title="管理账户"
                  >
                    <Users className="w-5 h-5" />
                  </button>
                </div>
              )}

              <div className="order-2 min-w-0 flex-1 ml-auto text-right sm:text-right">
                <h1 className="text-sm sm:text-lg font-bold text-slate-800 leading-tight break-words">
                  {currentView === 'detail' ? '基金详情' : (currentView === 'account' ? '我的账户' : (currentView === 'settings' ? '设置' : 'FundVal Live'))}
                </h1>
                <p className="hidden sm:block text-xs text-slate-400 truncate">
                  {currentView === 'detail' ? '盘中实时估值分析' : '盘中估值参考工具'}
                </p>
              </div>
            </div>

            {/* Search Bar (Only in List View) */}
            {currentView === 'list' && (
              <form onSubmit={handleSearch} className="relative flex-1 w-full lg:max-w-md">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4 z-10" />
                  <input
                    type="text"
                    placeholder="输入基金代码或名称 (如: 005827 或 易方达蓝筹)"
                    className="w-full h-11 pl-10 pr-24 bg-slate-100 border-none rounded-full text-sm focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all outline-none"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => searchQuery && setShowSearchResults(true)}
                  />
                  <button
                    type="submit"
                    disabled={loading || !searchQuery || searchResults.length === 0}
                    className="absolute right-1 top-1/2 -translate-y-1/2 bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 min-h-[36px] rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed z-10"
                  >
                    {loading ? '添加中...' : '添加'}
                  </button>

                  {/* Search Results Dropdown */}
                  {showSearchResults && searchResults.length > 0 && (
                    <div className="absolute z-20 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-80 overflow-y-auto">
                      {searchResults.map((fund) => (
                        <button
                          key={fund.id}
                          type="button"
                          onClick={() => handleSelectFund(fund)}
                          className="w-full px-4 py-3 min-h-[44px] text-left hover:bg-slate-50 border-b border-slate-100 last:border-b-0 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-slate-800 truncate">{fund.name}</div>
                              <div className="text-xs text-slate-500 font-mono mt-0.5">{fund.id}</div>
                            </div>
                            <div className="text-xs text-slate-400 shrink-0 bg-slate-100 px-2 py-1 rounded">{fund.type}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {showSearchResults && searchResults.length === 0 && !searchLoading && searchQuery && (
                    <div className="absolute z-20 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl p-4 text-sm text-slate-500 text-center">
                      未找到匹配的基金
                    </div>
                  )}

                  {searchLoading && (
                    <div className="absolute z-20 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl p-4 text-sm text-slate-500 text-center">
                      搜索中...
                    </div>
                  )}
                </div>
              </form>
            )}

            {/* User / Status */}
            <div className="hidden md:flex items-center gap-4 text-xs text-slate-500">
              {/* 多用户模式：显示用户信息和登出按钮 */}
              {isMultiUserMode && currentUser && (
                <>
                  <span className="flex items-center gap-1.5 text-slate-700">
                    <Users className="w-4 h-4" />
                    {currentUser.username}
                    {currentUser.is_admin && (
                      <span className="ml-1 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded">管理员</span>
                    )}
                  </span>
                  <button
                    onClick={logout}
                    className="flex items-center gap-1.5 hover:text-red-600 transition-colors"
                    title="登出"
                  >
                    <LogOut className="w-4 h-4" />
                    登出
                  </button>
                </>
              )}

              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                API 正常
              </span>
              <a
                href="https://github.com/Ye-Yu-Mo/FundVal-Live"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:text-blue-600 transition-colors"
                title="GitHub 仓库"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                </svg>
                GitHub
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* 2. Main Content Area */}
      <main className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-4">
        <Suspense fallback={<div className="py-10 text-center text-slate-400">页面加载中...</div>}>
          {currentView === 'list' && (
            <FundList
              watchlist={watchlist}
              setWatchlist={setWatchlist}
              onSelectFund={handleCardClick}
              onRemove={removeFund}
              onSubscribe={openSubscribeModal}
            />
          )}

          {currentView === 'account' && (
            <Account
              currentAccount={currentAccount}
              isActive={currentView === 'account'}
              onSelectFund={handleCardClick}
              onPositionChange={notifyPositionChange}
              onSyncWatchlist={handleSyncWatchlist}
              syncLoading={syncLoading}
            />
          )}

          {currentView === 'settings' && (
            <Settings />
          )}

          {currentView === 'users' && (
            <UserManagement />
          )}

          {currentView === 'detail' && (
            <FundDetail
              fund={currentDetailFund}
              onSubscribe={openSubscribeModal}
              accountId={currentAccount}
              onNavigate={navigateFund}
              onEnsureDetail={ensureFundDetail}
              hasPrev={currentDetailIndex > 0}
              hasNext={currentDetailIndex < watchlist.length - 1}
              currentIndex={currentDetailIndex + 1}
              totalCount={watchlist.length}
            />
          )}
        </Suspense>
      </main>

      {/* 3. Subscription Modal (Global) */}
      {modalOpen && selectedFund && (
        <SubscribeModal 
            fund={selectedFund} 
            onClose={() => setModalOpen(false)}
            onSubmit={handleSubscribeSubmit}
        />
      )}

      {/* 4. Footer */}
      <footer className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-8 text-center text-slate-400 text-xs">
        <p className="mb-2">数据仅供参考，不构成投资建议。</p>
        <p className="mb-3">
          Data Source: AkShare Public API · Status: <span className="text-green-600">Operational</span>
        </p>
        <div className="flex items-center justify-center gap-3 sm:gap-4 text-slate-500 flex-wrap">
          <a
            href="https://github.com/Ye-Yu-Mo/FundVal-Live"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-600 transition-colors flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
            GitHub
          </a>
          <span>·</span>
          <a
            href="https://github.com/Ye-Yu-Mo/FundVal-Live/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-600 transition-colors"
          >
            v{APP_VERSION}
          </a>
          <span>·</span>
          <a
            href="https://github.com/Ye-Yu-Mo/FundVal-Live/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-600 transition-colors"
          >
            AGPL-3.0
          </a>
          <span>·</span>
          <a
            href="https://github.com/Ye-Yu-Mo/FundVal-Live/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-600 transition-colors"
          >
            反馈问题
          </a>
        </div>
      </footer>

      {/* Account Management Modal */}
      {accountModalOpen && (
        <AccountModal
          accounts={accounts}
          currentAccount={currentAccount}
          onClose={() => setAccountModalOpen(false)}
          onRefresh={loadAccounts}
          onSwitch={setCurrentAccount}
        />
      )}

    </div>
  );
}