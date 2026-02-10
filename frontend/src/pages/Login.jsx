import React, { useState, useEffect } from 'react';
import { LogIn, UserPlus, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { register as apiRegister } from '../api/auth';

export default function Login() {
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(false);
  const { login } = useAuth();

  // 检查是否允许注册
  useEffect(() => {
    const checkRegistration = async () => {
      try {
        const response = await fetch('/api/auth/registration-enabled', {
          credentials: 'include',
        });
        if (response.ok) {
          const data = await response.json();
          setAllowRegistration(data.registration_enabled);
        }
      } catch (err) {
        console.error('Failed to check registration setting:', err);
      }
    };

    checkRegistration();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegisterMode) {
        // 注册逻辑
        if (password !== confirmPassword) {
          setError('两次输入的密码不一致');
          setLoading(false);
          return;
        }

        if (password.length < 6) {
          setError('密码长度至少为 6 位');
          setLoading(false);
          return;
        }

        await apiRegister(username, password);
        // 注册成功后会自动登录，AuthContext 会更新 currentUser
        window.location.reload(); // 刷新页面
      } else {
        // 登录逻辑
        await login(username, password);
        // 登录成功后，AuthContext 会更新 currentUser，App.jsx 会自动切换到主界面
      }
    } catch (err) {
      setError(err.message || (isRegisterMode ? '注册失败' : '登录失败'));
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsRegisterMode(!isRegisterMode);
    setError('');
    setPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-600 rounded-full mb-4">
            {isRegisterMode ? (
              <UserPlus className="w-8 h-8 text-white" />
            ) : (
              <LogIn className="w-8 h-8 text-white" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-gray-900">FundVal Live</h1>
          <p className="text-gray-600 mt-2">盘中基金实时估值系统</p>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* 登录/注册表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
              用户名
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="请输入用户名"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              密码
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={isRegisterMode ? "请输入密码（至少 6 位）" : "请输入密码"}
              required
            />
          </div>

          {isRegisterMode && (
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                确认密码
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="请再次输入密码"
                required
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 text-white py-2 px-4 rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (isRegisterMode ? '注册中...' : '登录中...') : (isRegisterMode ? '注册' : '登录')}
          </button>
        </form>

        {/* 底部信息 */}
        <div className="mt-6 text-center text-sm text-gray-600">
          {allowRegistration ? (
            <p>
              {isRegisterMode ? '已有账户？' : '还没有账户？'}
              <button
                onClick={toggleMode}
                className="ml-1 text-indigo-600 hover:text-indigo-700 font-medium"
              >
                {isRegisterMode ? '立即登录' : '立即注册'}
              </button>
            </p>
          ) : (
            <p>首次使用？请联系管理员创建账户</p>
          )}
        </div>
      </div>
    </div>
  );
}
