import { AnimatePresence } from 'motion/react';
import { AlertCircle, Search } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { adminApi } from '../api/adminApi';
import type { AdminErrorReport } from '../types';
import { DetailDrawer, DetailField, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, formatDateTime } from '../components/AdminPrimitives';

function severityTone(value: string): 'neutral' | 'warning' | 'danger' | 'info' {
  if (value === 'critical' || value === 'error') return 'danger';
  if (value === 'warning') return 'warning';
  if (value === 'info') return 'info';
  return 'neutral';
}

export function ErrorReportsPage() {
  const [items, setItems] = useState<AdminErrorReport[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminErrorReport | null>(null);
  const deferredQuery = useDeferredValue(query);
  const pageSize = 40;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.errorReports({ page, pageSize, query: deferredQuery, source, severity, status })
      .then(data => { if (!cancelled) { setItems(data.items || []); setTotal(data.total || 0); } })
      .catch(err => { if (!cancelled) setError(err?.message || '无法读取错误记录'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deferredQuery, page, severity, source, status]);

  const resetPage = () => setPage(1);
  return (
    <div className="admin-page">
      <PageHeader eyebrow="Reliability" title="错误中心" description="接收用户端、编辑器和 Python/R 渲染链路的脱敏错误摘要。同类错误自动合并计数，不保存 traceback、脚本或数据内容。" />
      <section className="admin-section" style={{ marginTop: 0 }}>
        <div className="admin-filters">
          <label className="relative">
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#82908b' }} />
            <input className="admin-input" style={{ paddingLeft: 32 }} value={query} onChange={event => { setQuery(event.target.value); resetPage(); }} placeholder="搜索标题、错误码或事件 ID" />
          </label>
          <select className="admin-select" value={source} onChange={event => { setSource(event.target.value); resetPage(); }} aria-label="错误来源">
            <option value="">全部来源</option><option value="client">页面运行</option><option value="editor">编辑器</option><option value="render">渲染</option><option value="export">导出</option><option value="import">导入</option>
          </select>
          <select className="admin-select" value={severity} onChange={event => { setSeverity(event.target.value); resetPage(); }} aria-label="严重程度">
            <option value="">全部等级</option><option value="critical">严重</option><option value="error">错误</option><option value="warning">警告</option><option value="info">信息</option>
          </select>
          <select className="admin-select" value={status} onChange={event => { setStatus(event.target.value); resetPage(); }} aria-label="处理状态">
            <option value="">全部状态</option><option value="open">待处理</option><option value="triaged">已分流</option><option value="resolved">已解决</option><option value="ignored">已忽略</option>
          </select>
        </div>
        {loading && <LoadingState label="正在读取脱敏错误记录" />}
        {error && <ErrorState message={error} />}
        {!loading && !error && items.length === 0 && <EmptyState title="当前没有匹配错误" detail="这可能表示平台运行正常，或当前筛选条件过严。" />}
        {!loading && !error && items.length > 0 && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>最近发生</th><th>等级</th><th>来源</th><th>错误摘要</th><th>代码</th><th>影响次数</th><th>状态</th></tr></thead>
                <tbody>{items.map(item => (
                  <tr key={item.id} data-clickable="true" onClick={() => setSelected(item)}>
                    <td>{formatDateTime(item.lastSeenAt)}</td>
                    <td><StatusBadge tone={severityTone(item.severity)}>{item.severity}</StatusBadge></td>
                    <td>{item.source}</td>
                    <td><span className="admin-cell-main">{item.title}</span><span className="admin-cell-sub">{item.message.slice(0, 96)}</span></td>
                    <td>{item.errorCode || '—'}</td><td>{item.occurrenceCount}</td>
                    <td><StatusBadge tone={item.status === 'open' ? 'warning' : item.status === 'resolved' ? 'success' : 'info'}>{item.status === 'open' ? '待处理' : item.status === 'resolved' ? '已解决' : item.status === 'ignored' ? '已忽略' : '已分流'}</StatusBadge></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
          </>
        )}
      </section>

      <AnimatePresence>{selected && (
        <DetailDrawer title={selected.title} subtitle={selected.id} onClose={() => setSelected(null)}>
          <DetailField label="严重程度"><StatusBadge tone={severityTone(selected.severity)}>{selected.severity}</StatusBadge></DetailField>
          <DetailField label="来源">{selected.source}</DetailField>
          <DetailField label="错误码">{selected.errorCode || '—'}</DetailField>
          <DetailField label="脱敏摘要">{selected.message}</DetailField>
          <DetailField label="路由">{selected.route || '—'}</DetailField>
          <DetailField label="用户">{selected.userEmail || selected.userId || '—'}</DetailField>
          <DetailField label="项目 / Figure">{selected.projectId || '—'} / {selected.figureId || '—'}</DetailField>
          <DetailField label="首次发生">{formatDateTime(selected.firstSeenAt)}</DetailField>
          <DetailField label="最近发生">{formatDateTime(selected.lastSeenAt)}</DetailField>
          <DetailField label="合并次数"><AlertCircle size={13} style={{ display: 'inline', marginRight: 6 }} />{selected.occurrenceCount}</DetailField>
          <div style={{ marginTop: 18 }}><div className="admin-eyebrow">允许的环境元数据</div><pre className="admin-code-block">{JSON.stringify(selected.metadata || {}, null, 2)}</pre></div>
          <p style={{ marginTop: 16, color: '#7b8883', fontSize: 11, lineHeight: 1.7 }}>安全边界：详情不包含用户脚本、traceback、表格内容、图像或服务器绝对路径。</p>
        </DetailDrawer>
      )}</AnimatePresence>
    </div>
  );
}
