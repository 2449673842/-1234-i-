import { AnimatePresence, motion } from 'motion/react';
import { CreditCard, Loader2, Pencil, Search, ShieldCheck, X } from 'lucide-react';
import { FormEvent, useDeferredValue, useEffect, useState } from 'react';
import { adminApi } from '../api/adminApi';
import type { AdminSubscriptionRow } from '../types';
import {
  DetailDrawer,
  DetailField,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  StatusBadge,
  formatDateTime,
} from '../components/AdminPrimitives';

function statusTone(status: AdminSubscriptionRow['status']): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  if (status === 'expired') return 'danger';
  return 'neutral';
}

function localDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function createRequestId(): string {
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `subscription-${id}`;
}

export function SubscriptionsPage() {
  const [items, setItems] = useState<AdminSubscriptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminSubscriptionRow | null>(null);
  const [editing, setEditing] = useState<AdminSubscriptionRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const pageSize = 30;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.subscriptions({ page, pageSize, query: deferredQuery })
      .then(data => {
        if (cancelled) return;
        setItems(data.items || []);
        setTotal(data.total || 0);
        setSelected(current => current ? data.items.find(item => item.userId === current.userId) || current : null);
      })
      .catch(err => { if (!cancelled) setError(err?.message || '无法读取订阅记录'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deferredQuery, page, refreshKey]);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Entitlements"
        title="订阅权限"
        description="受控调整用户套餐、状态和到期时间。每次写操作均要求管理员密码二次验证、调整原因和唯一请求号，并写入审计日志。"
      />
      {notice && <div className="admin-page-notice" role="status"><ShieldCheck size={15} />{notice}</div>}
      <section className="admin-section" style={{ marginTop: 0 }}>
        <div className="admin-filters">
          <label className="relative">
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#82908b' }} />
            <input className="admin-input" style={{ paddingLeft: 32 }} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索邮箱或用户 ID" />
          </label>
        </div>
        {loading && <LoadingState label="正在读取订阅元数据" />}
        {error && <ErrorState message={error} onRetry={() => setRefreshKey(value => value + 1)} />}
        {!loading && !error && items.length === 0 && <EmptyState title="没有匹配账号" detail="调整搜索条件后重试。" />}
        {!loading && !error && items.length > 0 && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>用户</th><th>套餐</th><th>状态</th><th>到期时间</th><th>来源</th><th>历史记录</th><th>操作</th></tr></thead>
                <tbody>{items.map(item => (
                  <tr key={item.userId} data-clickable="true" onClick={() => setSelected(item)}>
                    <td><span className="admin-cell-main">{item.displayName || item.email}</span><span className="admin-cell-sub">{item.email} · {item.userId}</span></td>
                    <td><span className="admin-cell-main">{item.plan}</span></td>
                    <td><StatusBadge tone={statusTone(item.status)}>{item.status === 'none' ? '未配置' : item.status}</StatusBadge></td>
                    <td>{formatDateTime(item.endsAt)}</td>
                    <td>{item.source}</td>
                    <td>{item.historyCount}</td>
                    <td><button type="button" className="admin-icon-command" title="调整订阅" aria-label={`调整 ${item.email} 的订阅`} onClick={event => { event.stopPropagation(); setEditing(item); }}><Pencil size={14} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
          </>
        )}
      </section>

      <AnimatePresence>{selected && !editing && (
        <DetailDrawer title={selected.displayName || selected.email} subtitle={selected.userId} onClose={() => setSelected(null)}>
          <button type="button" className="admin-button admin-button-primary admin-full-button" onClick={() => setEditing(selected)}><CreditCard size={14} />调整订阅权限</button>
          <DetailField label="账号">{selected.email}</DetailField>
          <DetailField label="套餐 / 状态">{selected.plan} / {selected.status}</DetailField>
          <DetailField label="生效时间">{formatDateTime(selected.startsAt)}</DetailField>
          <DetailField label="到期时间">{formatDateTime(selected.endsAt)}</DetailField>
          <DetailField label="来源">{selected.source}</DetailField>
          <DetailField label="调整原因">{selected.changeReason || '—'}</DetailField>
          <DetailField label="管理员备注">{selected.adminNote || '—'}</DetailField>
          <DetailField label="变更记录">{selected.historyCount} 条</DetailField>
          <p className="admin-safety-note">订阅调整不会读取、修改或删除该用户的项目、脚本、数据文件、Figure 和导出资产。</p>
        </DetailDrawer>
      )}</AnimatePresence>

      <AnimatePresence>{editing && (
        <SubscriptionDialog
          user={editing}
          onClose={() => setEditing(null)}
          onApplied={(message) => {
            setEditing(null);
            setNotice(message);
            setRefreshKey(value => value + 1);
          }}
        />
      )}</AnimatePresence>
    </div>
  );
}

function SubscriptionDialog({ user, onClose, onApplied }: { user: AdminSubscriptionRow; onClose: () => void; onApplied: (message: string) => void }) {
  const [plan, setPlan] = useState<'free' | 'pro'>(user.plan === 'pro' ? 'pro' : 'free');
  const [status, setStatus] = useState<'active' | 'paused' | 'expired'>(user.status === 'active' || user.status === 'paused' || user.status === 'expired' ? user.status : 'active');
  const [endsAt, setEndsAt] = useState(localDateTime(user.endsAt));
  const [reason, setReason] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [password, setPassword] = useState('');
  const [requestId] = useState(createRequestId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const reauth = await adminApi.reauth(password);
      const result = await adminApi.adjustSubscription(user.userId, {
        plan,
        status,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        reason: reason.trim(),
        adminNote: adminNote.trim() || null,
        requestId,
        reauthToken: reauth.reauthToken,
      });
      setPassword('');
      onApplied(`${user.email} 的订阅已调整${result.replayed ? '（重复请求已安全复用原结果）' : ''}`);
    } catch (err: any) {
      setPassword('');
      setError(err?.message || '订阅调整失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="admin-dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="subscription-dialog-title" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }}>
        <header className="admin-dialog-header">
          <div><div className="admin-eyebrow">Controlled write</div><h2 id="subscription-dialog-title">调整订阅权限</h2><p>{user.email}</p></div>
          <button type="button" aria-label="关闭订阅调整" onClick={onClose} disabled={submitting}><X size={18} /></button>
        </header>
        <form onSubmit={event => void submit(event)}>
          <div className="admin-dialog-body">
            <div className="admin-form-grid">
              <label><span>套餐</span><select className="admin-select" value={plan} onChange={event => setPlan(event.target.value as 'free' | 'pro')}><option value="free">Free</option><option value="pro">Pro</option></select></label>
              <label><span>状态</span><select className="admin-select" value={status} onChange={event => setStatus(event.target.value as 'active' | 'paused' | 'expired')}><option value="active">Active</option><option value="paused">Paused</option><option value="expired">Expired</option></select></label>
            </div>
            <label className="admin-form-field"><span>到期时间（留空表示无固定期限）</span><input className="admin-input" type="datetime-local" value={endsAt} onChange={event => setEndsAt(event.target.value)} /></label>
            <label className="admin-form-field"><span>调整原因 *</span><textarea className="admin-textarea" required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：人工开通测试期、暂停异常订阅" /></label>
            <label className="admin-form-field"><span>管理员备注</span><textarea className="admin-textarea" maxLength={500} value={adminNote} onChange={event => setAdminNote(event.target.value)} placeholder="可选，不填写用户内容或敏感信息" /></label>
            <label className="admin-form-field"><span>管理员密码 *</span><input className="admin-input" type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
            {error && <div className="admin-form-error" role="alert">{error}</div>}
            <p className="admin-safety-note"><ShieldCheck size={14} />密码仅用于本次二次验证；短时令牌使用一次后立即失效。用户项目和资产不受影响。</p>
          </div>
          <footer className="admin-dialog-footer">
            <button type="button" className="admin-button" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="admin-button admin-button-primary" disabled={submitting}>{submitting ? <Loader2 className="admin-spin" size={14} /> : <ShieldCheck size={14} />}验证并应用</button>
          </footer>
        </form>
      </motion.div>
    </motion.div>
  );
}
