import { Home, Folder, Database, Settings, Blocks, FileImage, Grid, CircleHelp } from 'lucide-react';
import { ViewState } from '../App';

interface AppSidebarProps {
  currentView: ViewState;
  subView: string;
  onNavigate: (view: ViewState, subView?: string) => void;
}

export function AppSidebar({ currentView, subView = '', onNavigate }: AppSidebarProps) {
  const navigateTo = (view: ViewState, tab: string) => {
    onNavigate(view, tab);
  };

  return (
    <aside className="scifig-app-sidebar w-64 h-full flex flex-col shrink-0 overflow-y-auto">
      <div className="px-3 py-4 space-y-1">
        <div className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-[0.14em] px-3">工作区</div>
        <button 
          onClick={() => navigateTo('home', 'home')}
          className={`scifig-sidebar-link ${(currentView === 'home' && subView === 'home') || (currentView === 'home' && subView === '') ? 'is-active' : ''}`}
        >
          <Home className="w-4 h-4" />
          首页
        </button>
        <button 
          onClick={() => navigateTo('projects', 'my_projects')}
          className={`scifig-sidebar-link ${subView === 'my_projects' ? 'is-active' : ''}`}
        >
          <Folder className="w-4 h-4" />
          我的项目
        </button>
        <button 
          onClick={() => navigateTo('data', 'data_files')}
          className={`scifig-sidebar-link ${subView === 'data_files' ? 'is-active' : ''}`}
        >
          <Database className="w-4 h-4" />
          当前项目数据
        </button>
        <button 
          onClick={() => navigateTo('export_library', 'export_library')}
          className={`scifig-sidebar-link ${currentView === 'export_library' ? 'is-active' : ''}`}
        >
          <FileImage className="w-4 h-4" />
          历史导出资产
        </button>
        <button 
          onClick={() => navigateTo('composer', 'composer')}
          className={`scifig-sidebar-link ${currentView === 'composer' ? 'is-active' : ''}`}
        >
          <Grid className="w-4 h-4" />
          组合图工作台
        </button>
      </div>

      <div className="px-3 py-3 space-y-1 mt-auto border-t border-slate-200/80">
        <button
          onClick={() => navigateTo('help', 'help')}
          className={`scifig-sidebar-link ${currentView === 'help' ? 'is-active' : ''}`}
        >
          <CircleHelp className="w-4 h-4" />
          帮助中心
        </button>
        <button 
          onClick={() => navigateTo('settings', 'settings')}
          className={`scifig-sidebar-link ${subView === 'settings' ? 'is-active' : ''}`}
        >
          <Settings className="w-4 h-4" />
          设置
        </button>
        <button 
          onClick={() => navigateTo('settings', 'integrations')}
          className={`scifig-sidebar-link ${subView === 'integrations' ? 'is-active' : ''}`}
        >
          <Blocks className="w-4 h-4" />
          集成
        </button>
      </div>

      <div className="px-3 pb-4 shrink-0">
        <div className="scifig-sidebar-status p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-slate-800">项目数据受保护</span>
            <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">账号隔离与受限渲染已启用。</p>
          <button className="mt-2 flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-900" onClick={() => navigateTo('settings', 'settings')}>
            查看安全设置 <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
