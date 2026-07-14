import {StrictMode, type ComponentType} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';
import {installAuthenticatedFetch} from './utils/authenticatedFetch';
import {installGlobalErrorReporting} from './utils/clientErrorReporter';

installAuthenticatedFetch();
installGlobalErrorReporting();

const isAdminRoute = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
const root = createRoot(document.getElementById('root')!);
const loadAdminApp = () => import('./admin/AdminApp');
const loadUserApp = () => import('./App');

const modulePromise: Promise<{ default: ComponentType }> = isAdminRoute
  ? loadAdminApp()
  : loadUserApp();

modulePromise
  .then(({ default: RootApp }) => {
    root.render(
      <StrictMode>
        <RootApp />
      </StrictMode>,
    );
  })
  .catch(() => {
    root.render(
      <main className="flex min-h-screen items-center justify-center bg-[#071411] px-6 text-white">
        <div className="max-w-md border-l-2 border-[#8de6d1] pl-6">
          <div className="text-xs font-bold uppercase text-[#8de6d1]">SciFigure</div>
          <h1 className="mt-2 text-xl font-bold">页面模块加载失败</h1>
          <p className="mt-2 text-sm leading-6 text-white/60">请刷新页面。管理员模块故障不会影响普通绘图工作区。</p>
          <button type="button" onClick={() => { window.location.href = '/'; }} className="mt-5 bg-[#8de6d1] px-4 py-2 text-sm font-bold text-[#071411]">
            返回工作区
          </button>
        </div>
      </main>,
    );
  });
