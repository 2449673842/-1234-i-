import { Bug, CreditCard, ExternalLink, Gauge, ScrollText, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AdminSection, AdminUserIdentity } from './types';

const navItems: Array<{ id: AdminSection; label: string; icon: typeof Gauge; group: string }> = [
  { id: 'overview', label: '系统概览', icon: Gauge, group: 'Operations' },
  { id: 'errors', label: '错误中心', icon: Bug, group: 'Operations' },
  { id: 'users', label: '用户元数据', icon: Users, group: 'Accounts' },
  { id: 'subscriptions', label: '订阅权限', icon: CreditCard, group: 'Accounts' },
  { id: 'audit', label: '管理审计', icon: ScrollText, group: 'Security' },
];

export function AdminShell({ section, user, onNavigate, children }: { section: AdminSection; user: AdminUserIdentity; onNavigate: (section: AdminSection) => void; children: ReactNode }) {
  const groups = [...new Set(navItems.map(item => item.group))];
  return (
    <div className="admin-root">
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <div className="admin-brand"><div className="admin-brand-mark">S</div><div><strong>SciFigure</strong><span>Administration</span></div></div>
          <nav className="admin-nav" aria-label="管理员导航">
            {groups.map(group => <div className="admin-nav-group" key={group}><div className="admin-nav-label">{group}</div>{navItems.filter(item => item.group === group).map(item => {
              const Icon = item.icon;
              return <button key={item.id} type="button" className={section === item.id ? 'is-active' : ''} onClick={() => onNavigate(item.id)}><Icon size={16} /><span>{item.label}</span></button>;
            })}</div>)}
          </nav>
          <div className="admin-sidebar-footer"><div className="admin-identity"><ShieldCheck size={14} style={{ display: 'inline', marginRight: 7 }} />{user.displayName || user.email}<small>{user.email}</small></div></div>
        </aside>
        <div className="admin-workspace">
          <header className="admin-topbar">
            <div className="admin-environment"><span className="admin-live-dot" />管理员受控工作台</div>
            <div className="admin-top-actions"><span>服务端实时校验 admin 角色</span><button type="button" onClick={() => { window.location.href = '/'; }}><ExternalLink size={14} />返回用户端</button></div>
          </header>
          <main className="admin-content">{children}</main>
        </div>
      </div>
    </div>
  );
}
