import { useState } from 'react';
import { UploadCloud, Save, Download, ChevronDown, Plus, Check, UserRound, ShieldCheck } from 'lucide-react';
import { ViewState } from '../App';

interface NavbarProps {
  currentView: ViewState;
  onNavigate: (view: ViewState, subView?: string) => void;
}

export function Navbar({ currentView, onNavigate }: NavbarProps) {
  const [isSaved, setIsSaved] = useState(false);

  const handleSave = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <nav className="scifig-navbar h-14 flex items-center justify-between px-3 sm:px-4 shrink-0 z-40 relative">
      <div className="flex min-w-0 items-center gap-5">
        <div className="flex items-center gap-2 select-none cursor-pointer group" onClick={() => onNavigate('home', 'home')}>
          <div className="scifig-brand-mark w-8 h-8 flex items-center justify-center font-black text-sm transition-colors">
            S
          </div>
          <div className="hidden sm:block min-w-0 leading-none">
            <span className="block font-bold text-[15px] text-white whitespace-nowrap">SciFigure Studio</span>
            <span className="mt-1 block text-[9px] font-semibold uppercase text-emerald-200/70">Journal-ready workspace</span>
          </div>
        </div>
        
        <div className="hidden lg:flex items-center gap-1 text-xs font-semibold">
          <button 
            type="button"
            onClick={() => onNavigate('home', 'home')} 
            className={`scifig-nav-link ${currentView === 'home' || currentView === 'projects' || currentView === 'data' || currentView === 'settings' ? 'is-active' : ''}`}
          >
            项目与资源
          </button>
          <button type="button" onClick={() => onNavigate('data', 'data_files')} className={`scifig-nav-link ${currentView === 'data' ? 'is-active' : ''}`}>当前项目数据</button>
          <button 
            type="button" 
            onClick={() => onNavigate('landing')} 
            className={`scifig-nav-link flex items-center gap-1 ${currentView === 'landing' ? 'is-active' : ''}`}
          >
            专业版
          </button>
          <button type="button" onClick={() => onNavigate('help')} className={`scifig-nav-link flex items-center gap-1 ${currentView === 'help' ? 'is-active' : ''}`}>
            帮助 <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {(currentView === 'editor' || currentView === 'export_settings' || currentView === 'composer') ? (
          <>
            <button type="button" onClick={() => onNavigate('project_reconfigure')} className="scifig-top-button hidden sm:flex">
              <UploadCloud className="w-4 h-4" />
              重新配置
            </button>
            <button 
              type="button"
              className={`scifig-top-button hidden sm:flex ${isSaved ? 'is-saved' : ''}`}
              onClick={handleSave}
            >
              {isSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              {isSaved ? '已保存' : '保存项目'}
            </button>
            <div className="flex">
              <button type="button" onClick={() => onNavigate('export_settings')} className="scifig-top-primary rounded-r-none">
                <Download className="w-4 h-4" />
                导出图形
              </button>
              <button type="button" aria-label="更多导出选项" title="更多导出选项" className="scifig-top-primary border-l border-white/15 px-1.5 rounded-l-none">
                 <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="hidden xl:flex items-center gap-1.5 text-[10px] font-semibold text-emerald-100/80 mr-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-200" />
              受保护工作区
            </div>
            <button type="button" onClick={() => onNavigate('project_create')} className="scifig-top-button hidden sm:flex">
              <UploadCloud className="w-4 h-4" />
              导入数据
            </button>
            <button 
              type="button"
              onClick={() => onNavigate('project_create')}
              className="scifig-top-primary hidden sm:flex"
            >
              <Plus className="w-4 h-4" />
              新建图形项目
            </button>
          </>
        )}
        
        <button
          type="button"
          title="账号设置"
          aria-label="账号设置"
          className="w-8 h-8 ml-1 cursor-pointer border border-white/15 bg-white/10 text-emerald-50 flex items-center justify-center hover:bg-white/16 hover:text-white transition-colors"
          onClick={() => onNavigate('settings', 'settings')}
        >
          <UserRound className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}
