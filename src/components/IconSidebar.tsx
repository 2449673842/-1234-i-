import { useState } from 'react';
import { FileText, BarChart2, Image as ImageIcon, Type, List, Settings, ChevronsLeft } from 'lucide-react';

export function IconSidebar() {
  const [activeIndex, setActiveIndex] = useState(0);
  
  const icons = [
    { Icon: FileText, idx: 0 },
    { Icon: BarChart2, idx: 1 },
    { Icon: ImageIcon, idx: 2 },
    { Icon: Type, idx: 3 },
    { Icon: List, idx: 4 },
  ];

  return (
    <div className="w-14 bg-white border-r border-slate-200 flex flex-col items-center py-4 shrink-0 shadow-sm z-10 relative">
      <div className="flex-1 flex flex-col gap-4">
        {icons.map((item) => {
          const Icon = item.Icon;
          const isActive = activeIndex === item.idx;
          return (
            <button 
              key={item.idx}
              onClick={() => setActiveIndex(item.idx)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200 relative ${isActive ? 'bg-blue-100 text-blue-600 shadow-sm ring-1 ring-blue-200' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[7px] w-[3px] h-5 bg-blue-600 rounded-r-full" />
              )}
              <Icon className={`w-5 h-5 transition-transform duration-200 ${isActive ? 'scale-110' : ''}`} />
            </button>
          );
        })}
      </div>
      
      <div className="flex flex-col gap-4 mt-auto">
        <button 
          onClick={() => setActiveIndex(5)}
          className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200 relative ${activeIndex === 5 ? 'bg-blue-100 text-blue-600 shadow-sm ring-1 ring-blue-200' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
        >
          {activeIndex === 5 && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[7px] w-[3px] h-5 bg-blue-600 rounded-r-full" />
          )}
          <Settings className={`w-5 h-5 transition-transform duration-200 ${activeIndex === 5 ? 'scale-110' : ''}`} />
        </button>
      </div>

      <div className="absolute -right-3 bottom-4 w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm cursor-pointer hover:bg-slate-50 z-20 hidden md:flex text-slate-400">
         <ChevronsLeft className="w-3.5 h-3.5" />
      </div>
    </div>
  );
}

