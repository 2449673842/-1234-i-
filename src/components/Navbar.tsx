import { useState } from 'react';
import { UploadCloud, Save, Download, ChevronDown, Plus, Check } from 'lucide-react';
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
    <nav className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 transition-colors z-20 relative shadow-sm">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2 select-none cursor-pointer group" onClick={() => onNavigate('home', 'home')}>
          <div className="w-8 h-8 bg-blue-600 text-white rounded flex items-center justify-center font-bold text-lg rotate-12 group-hover:bg-blue-700 transition-colors shadow">
            <span className="-rotate-12">S</span>
          </div>
          <span className="font-bold text-xl text-slate-800 tracking-tight whitespace-nowrap group-hover:text-blue-600 transition-colors">SciFigure Studio</span>
        </div>
        
        <div className="hidden md:flex items-center gap-6 text-sm font-medium ml-4">
          <button 
            type="button"
            onClick={() => onNavigate('home', 'home')} 
            className={`transition-colors relative pb-4 top-2 ${currentView === 'home' || currentView === 'projects' || currentView === 'data' || currentView === 'settings' ? 'text-blue-600 font-semibold' : 'text-slate-600 hover:text-slate-900'}`}
          >
            项目与资源
            {(currentView === 'home' || currentView === 'projects' || currentView === 'data' || currentView === 'settings') && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-t-full"></div>}
          </button>
          <button type="button" onClick={() => onNavigate('data', 'data_files')} className={`transition-colors relative pb-4 top-2 ${currentView === 'data' ? 'text-blue-600 font-semibold' : 'text-slate-600 hover:text-slate-900'}`}>当前项目数据</button>
          <button type="button" className="transition-colors relative pb-4 top-2 text-slate-600 hover:text-slate-900 flex items-center gap-1">
            帮助 <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {(currentView === 'editor' || currentView === 'export_settings') ? (
          <>
            <button type="button" onClick={() => onNavigate('data_import')} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors shadow-sm">
              <UploadCloud className="w-4 h-4 text-blue-600" />
              重新配置
            </button>
            <button 
              type="button"
              className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border rounded-md transition-colors shadow-sm ${isSaved ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'text-blue-600 bg-blue-50 border-blue-200 hover:bg-blue-100'}`}
              onClick={handleSave}
            >
              {isSaved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              {isSaved ? '已保存' : '保存项目'}
            </button>
            <div className="flex">
              <button type="button" onClick={() => onNavigate('export_settings')} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded-l-md hover:bg-blue-700 transition-colors shadow-sm">
                <Download className="w-4 h-4" />
                导出图形
              </button>
              <button type="button" className="flex items-center justify-center px-1.5 py-1.5 text-white bg-blue-700 border border-blue-700 rounded-r-md hover:bg-blue-800 transition-colors shadow-sm">
                 <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" onClick={() => onNavigate('data_import')} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors shadow-sm">
              <UploadCloud className="w-4 h-4 text-blue-600" />
              导入数据
            </button>
            <button 
              type="button"
              onClick={() => onNavigate('project_create')}
              className="hidden sm:flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 border border-blue-600 rounded-md hover:bg-blue-700 transition-colors shadow-sm tracking-wide"
            >
              <Plus className="w-4 h-4" />
              新建图形项目
            </button>
          </>
        )}
        
        <div className="w-8 h-8 rounded-full ml-2 cursor-pointer shadow border border-slate-200 overflow-hidden bg-slate-100 flex items-center justify-center hover:ring-2 hover:ring-blue-100 transition-all" onClick={() => onNavigate('settings', 'settings')}>
          <img src="https://i.pravatar.cc/100?img=33" alt="Avatar" className="w-full h-full object-cover pointer-events-none" />
        </div>
      </div>
    </nav>
  );
}
