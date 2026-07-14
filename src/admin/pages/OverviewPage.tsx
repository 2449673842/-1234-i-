import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Database, HardDrive, RefreshCw, Server, Users } from 'lucide-react';
import { adminApi } from '../api/adminApi';
import type { AdminOverview } from '../types';
import { ErrorState, LoadingState, PageHeader, StatusBadge, formatBytes, formatDateTime } from '../components/AdminPrimitives';

export function OverviewPage({ initialOverview }: { initialOverview?: AdminOverview | null }) {
  const [overview, setOverview] = useState<AdminOverview | null>(initialOverview || null);
  const [loading, setLoading] = useState(!initialOverview);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (refreshKey === 0 && overview) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.overview()
      .then(value => { if (!cancelled) setOverview(value); })
      .catch(err => { if (!cancelled) setError(err?.message || '无法读取系统概览'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Operations"
        title="系统概览"
        description="只读观察账号、项目、渲染与错误状态。该页不读取用户代码、数据表或图片内容。"
        action={<button type="button" className="admin-button" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={14} />刷新</button>}
      />

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={() => setRefreshKey(value => value + 1)} />}
      {!loading && !error && overview && (
        <>
          <section className="admin-metric-band" aria-label="平台核心指标">
            <div className="admin-metric"><span>注册用户</span><strong>{overview.counts.users}</strong><small>近24小时活跃 {overview.activity.activeUsers24h}</small></div>
            <div className="admin-metric"><span>项目 / Figure</span><strong>{overview.counts.projects} / {overview.counts.figures}</strong><small>文件 {overview.counts.files} · 导出 {overview.counts.exports}</small></div>
            <div className="admin-metric"><span>待处理错误</span><strong>{overview.counts.openErrors}</strong><small>错误记录共 {overview.counts.errorReports}</small></div>
            <div className="admin-metric"><span>渲染队列</span><strong>{overview.renderer.active} / {overview.renderer.queued}</strong><small>活动 / 等待 · 并发 {overview.renderer.concurrency}</small></div>
          </section>

          <div className="admin-grid-two">
            <section className="admin-section" style={{ marginTop: 0 }}>
              <div className="admin-section-header"><div><h2>运行状态</h2><p>采集于 {formatDateTime(overview.collectedAt)}</p></div><StatusBadge tone="success">服务可用</StatusBadge></div>
              <ul className="admin-ops-list">
                <li><div><strong><Server size={14} style={{ display: 'inline', marginRight: 7 }} />Node 进程</strong><p>运行 {Math.floor(overview.process.uptimeSeconds / 3600)} 小时</p></div><span>RSS {formatBytes(overview.process.rssBytes)}</span></li>
                <li><div><strong><Activity size={14} style={{ display: 'inline', marginRight: 7 }} />渲染工作池</strong><p>{overview.renderer.workers} 个 worker 已登记</p></div><span>{overview.renderer.active ? '处理中' : '空闲'}</span></li>
                <li><div><strong><HardDrive size={14} style={{ display: 'inline', marginRight: 7 }} />内存</strong><p>只显示进程聚合，不扫描用户文件</p></div><span>Heap {formatBytes(overview.process.heapUsedBytes)}</span></li>
              </ul>
            </section>

            <section className="admin-section" style={{ marginTop: 0 }}>
              <div className="admin-section-header"><div><h2>近24小时信号</h2><p>用于快速决定是否需要进入错误中心</p></div></div>
              <ul className="admin-ops-list">
                <li><div><strong><AlertTriangle size={14} style={{ display: 'inline', marginRight: 7 }} />渲染失败</strong><p>Python / R 的结构化错误统计</p></div><StatusBadge tone={overview.activity.renderFailures24h ? 'warning' : 'success'}>{overview.activity.renderFailures24h}</StatusBadge></li>
                <li><div><strong><Database size={14} style={{ display: 'inline', marginRight: 7 }} />管理请求失败</strong><p>包含 401 / 403 和管理 API 失败</p></div><StatusBadge tone={overview.activity.adminFailures24h ? 'danger' : 'success'}>{overview.activity.adminFailures24h}</StatusBadge></li>
                <li><div><strong><Users size={14} style={{ display: 'inline', marginRight: 7 }} />活跃用户</strong><p>基于登录和会话活动时间</p></div><span>{overview.activity.activeUsers24h}</span></li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
