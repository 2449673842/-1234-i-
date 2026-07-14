import { AnimatePresence } from 'motion/react';
import { FileSearch, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../api/adminApi';
import type { AdminAuditLog } from '../types';
import { DetailDrawer, DetailField, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge, formatDateTime } from '../components/AdminPrimitives';

export function AuditLogsPage() {
  const [logs, setLogs] = useState<AdminAuditLog[]>([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminAuditLog | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.auditLogs(200)
      .then(value => { if (!cancelled) setLogs(value || []); })
      .catch(err => { if (!cancelled) setError(err?.message || '无法读取审计日志'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const filtered = useMemo(() => logs.filter(log => {
    if (result === 'success' && !log.success) return false;
    if (result === 'failed' && log.success) return false;
    if (!deferredQuery) return true;
    return [log.id, log.action, log.actorUserId, log.resourceType, log.resourceId].some(value => String(value || '').toLowerCase().includes(deferredQuery));
  }), [deferredQuery, logs, result]);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Security"
        title="管理审计"
        description="追踪管理员读取、写入和被拒绝操作。metadata 在写入前经过白名单与脱敏。"
        action={<button type="button" className="admin-button" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={14} />刷新</button>}
      />
      <section className="admin-section" style={{ marginTop: 0 }}>
        <div className="admin-filters">
          <label className="relative"><Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#82908b' }} /><input className="admin-input" style={{ paddingLeft: 32 }} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索操作、管理员或资源 ID" /></label>
          <select className="admin-select" value={result} onChange={event => setResult(event.target.value)} aria-label="执行结果"><option value="">全部结果</option><option value="success">成功</option><option value="failed">失败 / 被拒绝</option></select>
        </div>
        {loading && <LoadingState label="正在读取审计事件" />}
        {error && <ErrorState message={error} onRetry={() => setRefreshKey(value => value + 1)} />}
        {!loading && !error && filtered.length === 0 && <EmptyState title="没有匹配审计事件" detail="可以调整筛选条件或刷新后重试。" />}
        {!loading && !error && filtered.length > 0 && (
          <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>时间</th><th>结果</th><th>操作</th><th>管理员</th><th>资源</th><th>HTTP</th></tr></thead><tbody>
            {filtered.map(log => (
              <tr key={log.id} data-clickable="true" onClick={() => setSelected(log)}>
                <td>{formatDateTime(log.createdAt)}</td><td><StatusBadge tone={log.success ? 'success' : 'danger'}>{log.success ? '成功' : '失败'}</StatusBadge></td>
                <td><span className="admin-cell-main">{log.action}</span><span className="admin-cell-sub">{log.id}</span></td><td>{log.actorUserId || '匿名 / 未认证'}</td>
                <td>{log.resourceType || '—'}{log.resourceId ? ` / ${log.resourceId}` : ''}</td><td>{log.statusCode || '—'}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </section>

      <AnimatePresence>{selected && (
        <DetailDrawer title={selected.action} subtitle={selected.id} onClose={() => setSelected(null)}>
          <DetailField label="结果"><StatusBadge tone={selected.success ? 'success' : 'danger'}>{selected.success ? '成功' : '失败 / 被拒绝'}</StatusBadge></DetailField>
          <DetailField label="时间">{formatDateTime(selected.createdAt)}</DetailField>
          <DetailField label="管理员">{selected.actorUserId || '未认证请求'}</DetailField>
          <DetailField label="资源">{selected.resourceType || '—'} / {selected.resourceId || '—'}</DetailField>
          <DetailField label="HTTP 状态">{selected.statusCode || '—'}</DetailField>
          <DetailField label="IP"><ShieldAlert size={13} style={{ display: 'inline', marginRight: 6 }} />{selected.ipAddress || '—'}</DetailField>
          <DetailField label="User Agent">{selected.userAgent || '—'}</DetailField>
          <div style={{ marginTop: 18 }}><div className="admin-eyebrow"><FileSearch size={12} style={{ display: 'inline', marginRight: 5 }} />脱敏 metadata</div><pre className="admin-code-block">{JSON.stringify(selected.metadata || {}, null, 2)}</pre></div>
        </DetailDrawer>
      )}</AnimatePresence>
    </div>
  );
}
