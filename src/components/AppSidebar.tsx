import { Home, Folder, Database, Settings, Blocks } from 'lucide-react';
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
    <div className="w-64 bg-slate-50/50 border-r border-slate-200 h-full flex flex-col shrink-0 overflow-y-auto">
      <div className="p-4 space-y-1">
        <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider px-3">项目</div>
        <button 
          onClick={() => navigateTo('home', 'home')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${(currentView === 'home' && subView === 'home') || (currentView === 'home' && subView === '') ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Home className="w-4 h-4" />
          首页
        </button>
        <button 
          onClick={() => navigateTo('projects', 'my_projects')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${subView === 'my_projects' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Folder className="w-4 h-4" />
          我的项目
        </button>
        <button 
          onClick={() => navigateTo('data', 'data_files')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${subView === 'data_files' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Database className="w-4 h-4" />
          当前项目数据
        </button>
      </div>

      <div className="p-4 space-y-1 mt-auto">
        <button 
          onClick={() => navigateTo('settings', 'settings')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${subView === 'settings' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Settings className="w-4 h-4" />
          设置
        </button>
        <button 
          onClick={() => navigateTo('settings', 'integrations')}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${subView === 'integrations' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Blocks className="w-4 h-4" />
          集成
        </button>
      </div>

      {/* Account Status */}
      <div className="p-4 border-t border-slate-200 mt-auto shrink-0">
        <div className="bg-white border border-slate-200 p-3 rounded-lg shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-slate-800">当前计划</span>
            <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">专业版</span>
          </div>
          <div className="text-xs text-slate-500 mb-4">有效期：永久有效</div>
          
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="font-medium text-slate-700">68.4 GB <span className="text-slate-400 font-normal">/ 200 GB</span></span>
              <span className="text-slate-500">34%</span>
            </div>
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 w-[34%] rounded-full"></div>
            </div>
          </div>
          
          <button className="text-xs text-blue-600 font-medium mt-3 hover:text-blue-700 transition-colors flex items-center gap-1" onClick={() => navigateTo('settings', 'settings')}>
            管理存储 <span className="text-[10px]">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}
