import { useState } from 'react';
import { FileText, BarChart2, Image as ImageIcon, Type, List, Settings, ChevronsLeft } from 'lucide-react';
import type { ViewState } from '../App';

type EditorRailAction = 'resources' | 'layers' | 'assets' | 'fonts' | 'history' | 'settings';

export function IconSidebar({ onNavigate }: { onNavigate?: (view: ViewState) => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  
  const icons = [
    { Icon: FileText, idx: 0, label: '项目资源', action: 'resources' as const },
    { Icon: BarChart2, idx: 1, label: '图层结构与搜索', action: 'layers' as const },
    { Icon: ImageIcon, idx: 2, label: '历史导出资产', action: 'assets' as const },
    { Icon: Type, idx: 3, label: '字体中心', action: 'fonts' as const },
    { Icon: List, idx: 4, label: '编辑历史', action: 'history' as const },
  ];

  const activate = (action: EditorRailAction, index: number) => {
    setActiveIndex(index);
    if (action === 'assets') {
      onNavigate?.('export_library');
      return;
    }
    if (action === 'settings') {
      onNavigate?.('settings');
      return;
    }
    window.dispatchEvent(new CustomEvent('scifigure:editor-rail-action', { detail: { action } }));
  };

  return (
    <div className="scifig-icon-rail w-14 flex flex-col items-center py-3 shrink-0 z-20 relative">
      <div className="flex-1 flex flex-col gap-2">
        {icons.map((item) => {
          const Icon = item.Icon;
          const isActive = activeIndex === item.idx;
          return (
            <button 
              key={item.idx}
              onClick={() => activate(item.action, item.idx)}
              aria-label={item.label}
              title={item.label}
              className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors relative ${isActive ? 'bg-emerald-100 text-emerald-800' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'}`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[10px] w-[3px] h-5 bg-emerald-600 rounded-r-full" />
              )}
              <Icon className="w-[18px] h-[18px]" />
            </button>
          );
        })}
      </div>
      
      <div className="flex flex-col gap-2 mt-auto">
        <button 
          onClick={() => activate('settings', 5)}
          aria-label="编辑器设置"
          title="编辑器设置"
          className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors relative ${activeIndex === 5 ? 'bg-emerald-100 text-emerald-800' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'}`}
        >
          {activeIndex === 5 && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[10px] w-[3px] h-5 bg-emerald-600 rounded-r-full" />
          )}
          <Settings className="w-[18px] h-[18px]" />
        </button>
      </div>

      <div title="收起工具栏" className="absolute -right-3 bottom-4 w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm cursor-pointer hover:bg-slate-50 z-20 hidden md:flex text-slate-400">
         <ChevronsLeft className="w-3.5 h-3.5" />
      </div>
    </div>
  );
}
