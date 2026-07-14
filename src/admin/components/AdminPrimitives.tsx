import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function StatusBadge({ tone, children }: { tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={`admin-status admin-status-${tone}`}>{children}</span>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="admin-page-header">
      <div>
        <div className="admin-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="admin-page-action">{action}</div>}
    </header>
  );
}

export function LoadingState({ label = '正在读取数据' }: { label?: string }) {
  return <div className="admin-state"><Loader2 className="admin-spin" size={18} /><span>{label}</span></div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="admin-state admin-state-column"><CheckCircle2 size={20} /><strong>{title}</strong><span>{detail}</span></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="admin-state admin-state-error">
      <AlertTriangle size={18} />
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <footer className="admin-pagination">
      <span>共 {total} 条 · 第 {page}/{totalPages} 页</span>
      <div>
        <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button>
        <button type="button" aria-label="下一页" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button>
      </div>
    </footer>
  );
}

export function DetailDrawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <motion.aside
      className="admin-detail-drawer"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      aria-label={title}
    >
      <div className="admin-detail-header">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" aria-label="关闭详情" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="admin-detail-body">{children}</div>
    </motion.aside>
  );
}

export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="admin-detail-field"><dt>{label}</dt><dd>{children || '—'}</dd></div>;
}
