import { AnimatePresence } from 'motion/react';
import { Search, ShieldCheck, UserRound } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { adminApi } from '../api/adminApi';
import type { AdminUserRow } from '../types';
import { DetailDrawer, DetailField, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, formatDateTime } from '../components/AdminPrimitives';

export function UsersPage() {
  const [items, setItems] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const deferredQuery = useDeferredValue(query);
  const pageSize = 30;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminApi.users({ page, pageSize, query: deferredQuery, role })
      .then(data => {
        if (cancelled) return;
        setItems(data.items || []);
        setTotal(data.total || 0);
      })
      .catch(err => { if (!cancelled) setError(err?.message || '无法读取用户'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deferredQuery, page, role]);

  return (
    <div className="admin-page">
      <PageHeader eyebrow="Accounts" title="用户元数据" description="查看账号、订阅和资源数量。后台不读取用户上传文件、脚本、Figure 或导出图内容。" />
      <section className="admin-section" style={{ marginTop: 0 }}>
        <div className="admin-filters">
          <label className="relative">
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#82908b' }} />
            <input className="admin-input" style={{ paddingLeft: 32 }} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索用户 ID" />
          </label>
          <select className="admin-select" value={role} onChange={event => { setRole(event.target.value); setPage(1); }} aria-label="角色筛选">
            <option value="">全部角色</option><option value="user">普通用户</option><option value="admin">管理员</option>
          </select>
        </div>
        {loading && <LoadingState label="正在读取用户元数据" />}
        {error && <ErrorState message={error} />}
        {!loading && !error && items.length === 0 && <EmptyState title="没有匹配用户" detail="调整搜索或角色筛选后重试。" />}
        {!loading && !error && items.length > 0 && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>用户</th><th>角色</th><th>订阅</th><th>项目 / Figure</th><th>文件 / 导出</th><th>活跃会话</th><th>最近登录</th></tr></thead>
                <tbody>{items.map(item => (
                  <tr key={item.id} data-clickable="true" onClick={() => setSelected(item)}>
                    <td><span className="admin-cell-main">{item.accountLabel}</span><span className="admin-cell-sub">{item.id}</span></td>
                    <td><StatusBadge tone={item.role === 'admin' ? 'info' : 'neutral'}>{item.role === 'admin' ? '管理员' : '用户'}</StatusBadge></td>
                    <td><span className="admin-cell-main">{item.subscriptionPlan || 'free'}</span><span className="admin-cell-sub">{item.subscriptionStatus || '未订阅'}</span></td>
                    <td>{item.projectCount} / {item.figureCount}</td><td>{item.fileCount} / {item.exportCount}</td><td>{item.activeSessionCount}</td><td>{formatDateTime(item.lastLoginAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
          </>
        )}
      </section>

      <AnimatePresence>{selected && (
        <DetailDrawer title={selected.accountLabel || '用户详情'} subtitle={selected.id} onClose={() => setSelected(null)}>
          <DetailField label="账号标识">{selected.accountLabel}</DetailField>
          <DetailField label="角色"><StatusBadge tone={selected.role === 'admin' ? 'info' : 'neutral'}>{selected.role}</StatusBadge></DetailField>
          <DetailField label="注册时间">{formatDateTime(selected.createdAt)}</DetailField>
          <DetailField label="最近登录">{formatDateTime(selected.lastLoginAt)}</DetailField>
          <DetailField label="订阅">{selected.subscriptionPlan || 'free'} / {selected.subscriptionStatus || '未订阅'}</DetailField>
          <DetailField label="到期时间">{formatDateTime(selected.subscriptionEndsAt)}</DetailField>
          <DetailField label="项目"><UserRound size={13} style={{ display: 'inline', marginRight: 6 }} />{selected.projectCount} 个项目，{selected.figureCount} 张 Figure</DetailField>
          <DetailField label="资产">{selected.fileCount} 个文件，{selected.exportCount} 个导出资产</DetailField>
          <DetailField label="会话"><ShieldCheck size={13} style={{ display: 'inline', marginRight: 6 }} />{selected.activeSessionCount} 个活跃会话</DetailField>
          <p style={{ marginTop: 20, color: '#7b8883', fontSize: 11, lineHeight: 1.7 }}>本页仅显示聚合元数据，不提供用户代码、数据表、图像或文件路径的查看入口。</p>
        </DetailDrawer>
      )}</AnimatePresence>
    </div>
  );
}
