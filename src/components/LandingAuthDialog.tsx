import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff, KeyRound, LogIn, MailCheck, RefreshCw, UserPlus, X } from 'lucide-react';
import { setAccessToken } from '../utils/authenticatedFetch';

export type LandingAuthMode = 'login' | 'register';

interface LandingAuthDialogProps {
  open: boolean;
  mode: LandingAuthMode;
  onModeChange: (mode: LandingAuthMode) => void;
  onClose: () => void;
  onAuthenticated: () => void;
}

const DEVICE_KEY = 'scifigure:device-fingerprint';

interface EmailVerificationState {
  challengeId: string;
  expiresAt: string;
  maskedEmail: string;
}

interface AdminMfaChallengeState {
  challengeToken: string;
  expiresAt: string;
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<EmailVerificationState | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [adminMfaChallenge, setAdminMfaChallenge] = useState<AdminMfaChallengeState | null>(null);
  const [adminMfaCode, setAdminMfaCode] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setVerification(null);
    setVerificationCode('');
    setAdminMfaChallenge(null);
    setAdminMfaCode('');
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

  const finishAuthentication = (token: string) => {
    setAccessToken(token);
    window.dispatchEvent(new CustomEvent('scifigure:auth-changed', {
      detail: { authenticated: true },
    }));
    onAuthenticated();
  };

  const requestVerificationCode = async (normalizedEmail: string): Promise<EmailVerificationState> => {
    const response = await fetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizedEmail }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status !== 'success' || !data?.verification?.challengeId) {
      throw new Error(data?.message || '验证码暂时无法发送');
    }
    return data.verification as EmailVerificationState;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
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
      if (data?.adminMfaRequired && data?.challenge?.challengeToken) {
        setAdminMfaChallenge(data.challenge as AdminMfaChallengeState);
        setAdminMfaCode('');
        setNotice('管理员账号需要完成验证器二步验证。');
        return;
      }
      if (data?.verificationRequired && data?.verification?.challengeId) {
        setVerification(data.verification as EmailVerificationState);
        setVerificationCode('');
        setNotice(`验证码已发送至 ${data.verification.maskedEmail}`);
        return;
      }
      if (response.status === 403 && data?.errorCode === 'EMAIL_VERIFICATION_REQUIRED') {
        const nextVerification = await requestVerificationCode(normalizedEmail);
        setVerification(nextVerification);
        setVerificationCode('');
        setNotice(`验证码已重新发送至 ${nextVerification.maskedEmail}`);
        return;
      }
      if (!response.ok || data?.status !== 'success' || typeof data?.token !== 'string') {
        throw new Error(data?.message || `${mode === 'login' ? '登录' : '注册'}失败，请稍后重试`);
      }
      finishAuthentication(data.token);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : '认证失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const verifyAdminMfa = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!adminMfaChallenge || adminMfaCode.trim().length < 6) {
      setError('请输入验证器代码或一次性恢复码');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/auth/admin-mfa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': getDeviceFingerprint(),
          'X-Device-Name': navigator.userAgent.slice(0, 80),
        },
        body: JSON.stringify({ challengeToken: adminMfaChallenge.challengeToken, code: adminMfaCode.trim() }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status !== 'success' || typeof data?.token !== 'string') {
        throw new Error(data?.message || '管理员二步验证失败');
      }
      finishAuthentication(data.token);
    } catch (mfaError) {
      setError(mfaError instanceof Error ? mfaError.message : '管理员二步验证失败');
    } finally {
      setBusy(false);
    }
  };

  const verifyEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!verification || !/^\d{6}$/.test(verificationCode)) {
      setError('请输入 6 位邮箱验证码');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': getDeviceFingerprint(),
          'X-Device-Name': navigator.userAgent.slice(0, 80),
        },
        body: JSON.stringify({ challengeId: verification.challengeId, code: verificationCode, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.status !== 'success' || typeof data?.token !== 'string') {
        throw new Error(data?.message || '邮箱验证失败');
      }
      finishAuthentication(data.token);
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : '邮箱验证失败');
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const nextVerification = await requestVerificationCode(email.trim().toLowerCase());
      setVerification(nextVerification);
      setVerificationCode('');
      setNotice(`新验证码已发送至 ${nextVerification.maskedEmail}`);
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : '验证码暂时无法发送');
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
              {adminMfaChallenge ? '管理员二步验证' : verification ? '验证邮箱地址' : isRegister ? '创建科研作图工作区' : '登录你的工作区'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              {adminMfaChallenge
                ? '输入验证器中的 6 位动态代码，也可以使用一个尚未使用的恢复码。'
                : verification
                ? `请输入发送至 ${verification.maskedEmail} 的 6 位验证码。`
                : isRegister
                  ? '填写账号信息，完成注册后即可进入工作区。'
                  : '登录后继续访问已有项目和编辑历史。'}
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

        {adminMfaChallenge ? (
          <form className="mt-7 space-y-4" onSubmit={verifyAdminMfa}>
            <div className="flex items-center gap-3 border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-3 text-sm text-cyan-50">
              <KeyRound className="h-5 w-5 shrink-0 text-cyan-200" />
              <span>管理员会话只有完成二步验证后才能访问后台。验证码和恢复码不会写入日志。</span>
            </div>
            <label className="block text-sm font-semibold text-slate-200">
              验证器代码或恢复码
              <input
                value={adminMfaCode}
                onChange={(event) => setAdminMfaCode(event.target.value.slice(0, 64))}
                className="mt-2 w-full border border-white/12 bg-white/[0.06] px-3 py-3 text-center text-lg font-black text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
                placeholder="000000"
                autoComplete="one-time-code"
                maxLength={64}
                required
                autoFocus
              />
            </label>
            {notice && <div role="status" className="border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2.5 text-sm text-cyan-50">{notice}</div>}
            {error && <div role="alert" className="border border-red-300/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">{error}</div>}
            <button type="submit" disabled={busy || adminMfaCode.trim().length < 6} className="flex w-full items-center justify-center gap-2 bg-cyan-200 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-60">
              <KeyRound className="h-4 w-4" />{busy ? '正在验证...' : '验证并进入平台'}
            </button>
            <button type="button" className="flex w-full items-center justify-center gap-2 border border-white/10 px-3 py-2.5 text-sm font-bold text-slate-300 transition hover:border-white/25 hover:text-white" disabled={busy} onClick={() => { setAdminMfaChallenge(null); setAdminMfaCode(''); setError(null); setNotice(null); }}>
              <ArrowLeft className="h-4 w-4" />返回登录
            </button>
          </form>
        ) : verification ? (
          <form className="mt-7 space-y-4" onSubmit={verifyEmail}>
            <div className="flex items-center gap-3 border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-3 text-sm text-cyan-50">
              <MailCheck className="h-5 w-5 shrink-0 text-cyan-200" />
              <span>验证码在短时间内有效，连续输错 5 次后需要重新发送。</span>
            </div>
            <label className="block text-sm font-semibold text-slate-200">
              邮箱验证码
              <input
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                className="mt-2 w-full border border-white/12 bg-white/[0.06] px-3 py-3 text-center text-xl font-black text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-200/70"
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            </label>
            {notice && <div role="status" className="border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2.5 text-sm text-cyan-50">{notice}</div>}
            {error && <div role="alert" className="border border-red-300/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">{error}</div>}
            <button
              type="submit"
              disabled={busy || verificationCode.length !== 6}
              className="flex w-full items-center justify-center gap-2 bg-cyan-200 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-60"
            >
              <MailCheck className="h-4 w-4" />
              {busy ? '正在验证...' : '验证并进入平台'}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="flex items-center justify-center gap-2 border border-white/10 px-3 py-2.5 text-sm font-bold text-slate-300 transition hover:border-white/25 hover:text-white" disabled={busy} onClick={() => { setVerification(null); setVerificationCode(''); setError(null); setNotice(null); }}>
                <ArrowLeft className="h-4 w-4" />返回
              </button>
              <button type="button" className="flex items-center justify-center gap-2 border border-white/10 px-3 py-2.5 text-sm font-bold text-slate-300 transition hover:border-white/25 hover:text-white" disabled={busy} onClick={() => void resendVerification()}>
                <RefreshCw className="h-4 w-4" />重新发送
              </button>
            </div>
          </form>
        ) : (
          <>
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

          {notice && (
            <div role="status" className="border border-cyan-200/15 bg-cyan-200/[0.06] px-3 py-2.5 text-sm text-cyan-50">
              {notice}
            </div>
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
            {busy ? '处理中...' : isRegister ? '注册并继续' : '登录并进入平台'}
          </button>
        </form>
          </>
        )}
      </div>
    </div>
  );
}
