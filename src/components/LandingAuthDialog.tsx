import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, LogIn, UserPlus, X } from 'lucide-react';
import { AUTH_TOKEN_STORAGE_KEY } from '../utils/authenticatedFetch';

export type LandingAuthMode = 'login' | 'register';

interface LandingAuthDialogProps {
  open: boolean;
  mode: LandingAuthMode;
  onModeChange: (mode: LandingAuthMode) => void;
  onClose: () => void;
  onAuthenticated: () => void;
}

const DEVICE_KEY = 'scifigure:device-fingerprint';

function getDeviceFingerprint(): string {
  let fingerprint = window.localStorage.getItem(DEVICE_KEY);
  if (!fingerprint) {
    const suffix = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    fingerprint = `web_${suffix}`;
    window.localStorage.setItem(DEVICE_KEY, fingerprint);
  }
  return fingerprint;
}

export function LandingAuthDialog({
  open,
  mode,
  onModeChange,
  onClose,
  onAuthenticated,
}: LandingAuthDialogProps) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPassword('');
    setConfirmPassword('');
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setError('请输入邮箱地址');
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位');
      return;
    }
    if (mode === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': getDeviceFingerprint(),
          'X-Device-Name': navigator.userAgent.slice(0, 80),
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
          displayName: mode === 'register' ? displayName.trim() : undefined,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status !== 'success' || typeof data?.token !== 'string') {
        throw new Error(data?.message || `${mode === 'login' ? '登录' : '注册'}失败，请稍后重试`);
      }
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, data.token);
      window.dispatchEvent(new CustomEvent('scifigure:auth-changed', {
        detail: { authenticated: true },
      }));
      onAuthenticated();
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : '认证失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const isRegister = mode === 'register';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#02070d]/80 px-4 py-8 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-auth-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md border border-white/15 bg-[#0c1722] p-6 shadow-2xl shadow-black/50 sm:p-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-200/75">SciFigure Studio</div>
            <h2 id="landing-auth-title" className="mt-3 text-2xl font-black text-white">
              {isRegister ? '创建科研作图工作区' : '登录你的工作区'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              {isRegister ? '注册免费账号后即可进入项目、编辑器和导出功能。' : '登录后继续访问已有项目和编辑历史。'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/10 text-slate-400 transition hover:border-white/25 hover:text-white disabled:opacity-50"
            aria-label="关闭认证窗口"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-7 grid grid-cols-2 border border-white/10 bg-white/[0.04] p-1">
          <button
            type="button"
            onClick={() => onModeChange('register')}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-bold transition ${isRegister ? 'bg-cyan-200 text-slate-950' : 'text-slate-400 hover:text-white'}`}
          >
            <UserPlus className="h-4 w-4" />
            注册
          </button>
          <button
            type="button"
            onClick={() => onModeChange('login')}
            className={`flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-bold transition ${!isRegister ? 'bg-cyan-200 text-slate-950' : 'text-slate-400 hover:text-white'}`}
          >
            <LogIn className="h-4 w-4" />
            登录
          </button>
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          {isRegister && (
            <label className="block text-sm font-semibold text-slate-200">
              昵称
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-2 w-full border border-white/12 bg-white/[0.06] px-3 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
                placeholder="用于工作区显示"
                autoComplete="name"
              />
            </label>
          )}
          <label className="block text-sm font-semibold text-slate-200">
            邮箱
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 w-full border border-white/12 bg-white/[0.06] px-3 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
              placeholder="name@example.com"
              autoComplete="email"
              required
              autoFocus
            />
          </label>
          <label className="block text-sm font-semibold text-slate-200">
            密码
            <span className="relative mt-2 block">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full border border-white/12 bg-white/[0.06] px-3 py-3 pr-11 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
                placeholder="至少 8 位"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(value => !value)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 transition hover:text-white"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </span>
          </label>
          {isRegister && (
            <label className="block text-sm font-semibold text-slate-200">
              确认密码
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-2 w-full border border-white/12 bg-white/[0.06] px-3 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
                placeholder="再次输入密码"
                autoComplete="new-password"
                required
              />
            </label>
          )}

          {error && (
            <div role="alert" className="border border-red-300/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 bg-cyan-200 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-60"
          >
            {isRegister ? <UserPlus className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
            {busy ? '处理中...' : isRegister ? '注册并进入平台' : '登录并进入平台'}
          </button>
        </form>
      </div>
    </div>
  );
}
