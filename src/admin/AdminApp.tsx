import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, LockKeyhole, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { adminApi } from './api/adminApi';
import { AdminApiError, type AdminOverview, type AdminSection, type AdminUserIdentity } from './types';
import { AdminShell } from './AdminShell';
import { OverviewPage } from './pages/OverviewPage';
import { UsersPage } from './pages/UsersPage';
import { ErrorReportsPage } from './pages/ErrorReportsPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { SecurityPage } from './pages/SecurityPage';
import './admin.css';

type AccessState = 'checking' | 'ready' | 'anonymous' | 'forbidden' | 'disabled' | 'error';

function sectionFromPath(pathname = window.location.pathname): AdminSection {
  const segment = pathname.replace(/^\/admin\/?/, '').split('/')[0];
  return segment === 'users' || segment === 'subscriptions' || segment === 'errors' || segment === 'audit' || segment === 'security' ? segment : 'overview';
}

function AccessScreen({ state, message }: { state: Exclude<AccessState, 'ready'>; message?: string }) {
  const isChecking = state === 'checking';
  const Icon = state === 'disabled' ? ShieldOff : state === 'forbidden' ? LockKeyhole : AlertTriangle;
  const title = isChecking ? '正在校验管理员权限' : state === 'disabled' ? '管理员后台未启用' : state === 'forbidden' ? '当前账号没有管理权限' : state === 'anonymous' ? '请先登录' : '后台加载失败';
  return (
    <main className="admin-root flex min-h-screen items-center justify-center px-6">
      <div style={{ width: 'min(520px, 100%)', background: 'white', border: '1px solid #dce4e1', padding: 32 }}>
        <Icon size={24} color="#176b5b" />
        <div className="admin-eyebrow" style={{ marginTop: 20 }}>SciFigure Administration</div>
        <h1 style={{ margin: '5px 0 0', fontSize: 22 }}>{title}</h1>
        <p style={{ margin: '10px 0 0', color: '#66746f', fontSize: 13, lineHeight: 1.7 }}>{message || (isChecking ? '后端正在重新查询数据库角色。' : '普通用户平台不受影响。')}</p>
        {!isChecking && <button type="button" className="admin-button" style={{ marginTop: 22 }} onClick={() => { window.location.href = '/'; }}>返回 SciFigure</button>}
      </div>
    </main>
  );
}

export default function AdminApp() {
  const [access, setAccess] = useState<AccessState>('checking');
  const [message, setMessage] = useState('');
  const [user, setUser] = useState<AdminUserIdentity | null>(null);
  const [initialOverview, setInitialOverview] = useState<AdminOverview | null>(null);
  const [section, setSection] = useState<AdminSection>(() => sectionFromPath());

  useEffect(() => {
    let cancelled = false;
    Promise.all([adminApi.currentUser(), adminApi.overview()])
      .then(([identity, overview]) => {
        if (cancelled) return;
        if (identity.role !== 'admin') { setAccess('forbidden'); return; }
        setUser(identity);
        setInitialOverview(overview);
        setAccess('ready');
      })
      .catch((error: AdminApiError) => {
        if (cancelled) return;
        setMessage(error?.message || '无法校验管理权限');
        setAccess(error?.statusCode === 401 ? 'anonymous' : error?.statusCode === 403 ? 'forbidden' : error?.statusCode === 404 ? 'disabled' : 'error');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onPopState = () => setSection(sectionFromPath());
    const onRevoked = () => setAccess('forbidden');
    window.addEventListener('popstate', onPopState);
    window.addEventListener('scifigure:admin-access-revoked', onRevoked);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('scifigure:admin-access-revoked', onRevoked);
    };
  }, []);

  if (access !== 'ready' || !user) return <AccessScreen state={access === 'ready' ? 'error' : access} message={message} />;

  const navigate = (next: AdminSection) => {
    const path = next === 'overview' ? '/admin' : `/admin/${next}`;
    window.history.pushState({}, '', path);
    setSection(next);
  };
  const page = section === 'users' ? <UsersPage /> : section === 'subscriptions' ? <SubscriptionsPage /> : section === 'errors' ? <ErrorReportsPage /> : section === 'audit' ? <AuditLogsPage /> : section === 'security' ? <SecurityPage /> : <OverviewPage initialOverview={initialOverview} />;

  return (
    <AdminShell section={section} user={user} onNavigate={navigate}>
      <AnimatePresence mode="wait">
        <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
          {page}
        </motion.div>
      </AnimatePresence>
    </AdminShell>
  );
}
