import { Copy, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { copyTextToClipboard } from '../../utils/clipboard';
import { adminApi } from '../api/adminApi';
import type { AdminMfaEnrollment, AdminSecurityState } from '../types';
import { ErrorState, LoadingState, PageHeader, StatusBadge, formatDateTime } from '../components/AdminPrimitives';

export function SecurityPage() {
  const [security, setSecurity] = useState<AdminSecurityState | null>(null);
  const [enrollment, setEnrollment] = useState<AdminMfaEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSecurity(await adminApi.security());
    } catch (loadError: any) {
      setError(loadError?.message || '无法读取管理员安全状态');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const beginEnrollment = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await adminApi.beginMfaEnrollment(password);
      setEnrollment(next);
      setPassword('');
      setCode('');
      setNotice('验证器密钥仅在当前设置流程中展示。添加后输入新的 6 位代码确认。');
    } catch (enrollmentError: any) {
      setError(enrollmentError?.message || '无法开始二步验证设置');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const codes = await adminApi.confirmMfaEnrollment(enrollment.enrollmentToken, code.trim());
      setEnrollment(null);
      setCode('');
      setRecoveryCodes(codes);
      setNotice('管理员二步验证已启用。请立即离线保存恢复码，关闭后平台不会再次显示。');
      await load();
    } catch (confirmationError: any) {
      setError(confirmationError?.message || '二步验证码确认失败');
    } finally {
      setBusy(false);
    }
  };

  const regenerateRecoveryCodes = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const codes = await adminApi.regenerateMfaRecoveryCodes(password, code.trim());
      setPassword('');
      setCode('');
      setRecoveryCodes(codes);
      setNotice('旧恢复码已全部作废。请离线保存本次新恢复码。');
      await load();
    } catch (regenerationError: any) {
      setError(regenerationError?.message || '恢复码更新失败');
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCodes = async () => {
    const copied = await copyTextToClipboard(recoveryCodes.join('\n'));
    setNotice(copied ? '恢复码已复制，请存入离线密码管理器。' : '浏览器未允许复制，请手动记录恢复码。');
  };

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Administrator security"
        title="管理员安全设置"
        description="使用独立验证器保护后台登录与订阅写操作。TOTP 密钥在数据库中加密保存，恢复码只保存不可逆摘要。"
      />
      {notice && <div className="admin-page-notice" role="status"><ShieldCheck size={15} />{notice}</div>}
      {loading && <section className="admin-section"><LoadingState label="正在读取管理员安全状态" /></section>}
      {!loading && error && !security && <section className="admin-section"><ErrorState message={error} onRetry={() => void load()} /></section>}
      {!loading && security && (
        <div className="admin-security-grid">
          <section className="admin-section" style={{ marginTop: 0 }}>
            <header className="admin-section-header"><div><h2>二步验证状态</h2><p>后台权限仍会在每次请求中重新校验数据库角色。</p></div><StatusBadge tone={security.recoveryRequired ? 'warning' : security.enabled ? 'success' : security.mode === 'enforce' ? 'danger' : 'warning'}>{security.recoveryRequired ? '需更新恢复码' : security.enabled ? '已启用' : security.mode === 'enforce' ? '必须设置' : '观察模式'}</StatusBadge></header>
            <dl className="admin-security-facts">
              <div><dt>执行模式</dt><dd>{security.mode}</dd></div>
              <div><dt>密钥配置</dt><dd>{security.encryptionConfigured ? '已配置' : '未配置'}</dd></div>
              <div><dt>当前会话</dt><dd>{security.sessionVerified ? '已完成 MFA' : '尚未完成 MFA'}</dd></div>
              <div><dt>启用时间</dt><dd>{formatDateTime(security.confirmedAt)}</dd></div>
              <div><dt>剩余恢复码</dt><dd>{security.recoveryCodesRemaining}</dd></div>
            </dl>
            {security.recoveryRequired && <div className="admin-form-error" style={{ margin: '14px 18px 0' }}>恢复码已全部使用，但验证器仍可正常使用。请立即使用新的动态码生成一组恢复码。</div>}
            <p className="admin-safety-note" style={{ padding: '0 18px 18px' }}><ShieldCheck size={14} />后台不提供关闭二步验证的网页按钮。设备丢失时使用恢复码；服务器级恢复必须通过受审计的离线流程。</p>
          </section>

          {!security.enabled && !enrollment && (
            <section className="admin-section" style={{ marginTop: 0 }}>
              <header className="admin-section-header"><div><h2>绑定验证器</h2><p>需要先验证管理员密码。</p></div><KeyRound size={17} /></header>
              <form className="admin-security-form" onSubmit={event => void beginEnrollment(event)}>
                <label className="admin-form-field"><span>管理员密码</span><input className="admin-input" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
                {!security.encryptionConfigured && <div className="admin-form-error">服务器尚未配置 MFA 加密密钥，当前不能生成验证器密钥。</div>}
                {error && <div className="admin-form-error" role="alert">{error}</div>}
                <button type="submit" className="admin-button admin-button-primary" disabled={busy || !security.encryptionConfigured}>{busy ? <Loader2 className="admin-spin" size={14} /> : <KeyRound size={14} />}开始绑定</button>
              </form>
            </section>
          )}

          {enrollment && (
            <section className="admin-section" style={{ marginTop: 0 }}>
              <header className="admin-section-header"><div><h2>确认验证器</h2><p>设置将在 {formatDateTime(enrollment.expiresAt)} 失效。</p></div><KeyRound size={17} /></header>
              <div className="admin-security-form">
                <div className="admin-secret-block"><span>手动输入密钥</span><code>{enrollment.manualKey}</code><button type="button" className="admin-icon-command" aria-label="复制验证器密钥" title="复制验证器密钥" onClick={() => void copyTextToClipboard(enrollment.manualKey)}><Copy size={14} /></button></div>
                <a className="admin-button" href={enrollment.otpAuthUrl}><ExternalLink size={14} />在验证器应用中打开</a>
                <form onSubmit={event => void confirmEnrollment(event)}>
                  <label className="admin-form-field"><span>6 位动态代码</span><input className="admin-input" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
                  {error && <div className="admin-form-error" role="alert">{error}</div>}
                  <button type="submit" className="admin-button admin-button-primary" disabled={busy || code.length !== 6}>{busy ? <Loader2 className="admin-spin" size={14} /> : <ShieldCheck size={14} />}确认并启用</button>
                </form>
              </div>
            </section>
          )}

          {security.enabled && (
            <section className="admin-section" style={{ marginTop: 0 }}>
              <header className="admin-section-header"><div><h2>更新恢复码</h2><p>更新后旧恢复码立即全部失效。</p></div><RefreshCw size={17} /></header>
              <form className="admin-security-form" onSubmit={event => void regenerateRecoveryCodes(event)}>
                <label className="admin-form-field"><span>管理员密码</span><input className="admin-input" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
                <label className="admin-form-field"><span>验证器代码或恢复码</span><input className="admin-input" autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value.slice(0, 64))} /></label>
                {error && <div className="admin-form-error" role="alert">{error}</div>}
                <button type="submit" className="admin-button" disabled={busy}>{busy ? <Loader2 className="admin-spin" size={14} /> : <RefreshCw size={14} />}生成新恢复码</button>
              </form>
            </section>
          )}
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <section className="admin-section">
          <header className="admin-section-header"><div><h2>一次性恢复码</h2><p>每个恢复码只能使用一次，平台不会再次显示本组明文。</p></div><button type="button" className="admin-button" onClick={() => void copyRecoveryCodes()}><Copy size={14} />复制全部</button></header>
          <div className="admin-recovery-codes">{recoveryCodes.map(value => <code key={value}>{value}</code>)}</div>
        </section>
      )}
    </div>
  );
}
