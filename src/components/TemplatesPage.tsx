import { Search, Filter, LayoutGrid, List, ChevronDown, DownloadCloud } from 'lucide-react';

export function TemplatesPage({ onNavigate }: { onNavigate: (view: 'editor') => void }) {
  const templates = [
    { title: '分组柱状图', tags: ['Nature', '柱状图', '比较'], type: 'bar' },
    { title: '折线图 (多序列)', tags: ['Nature', '折线图', '时间序列'], type: 'line' },
    { title: '散点图 (回归分析)', tags: ['Science', '散点图', '回归'], type: 'scatter' },
    { title: '箱线图', tags: ['Nature', '箱线图', '分布'], type: 'box' },
    { title: '热图 (聚类)', tags: ['Nature', '热图', '聚类'], type: 'heatmap' },
    { title: 'PCA 评分图', tags: ['Nature', 'PCA', '多变量'], type: 'scatter' },
    { title: 'PCoA 图', tags: ['ISME J', 'PCoA', 'β 多样性'], type: 'scatter' },
    { title: '相关性热图', tags: ['Nature', '相关性', '矩阵'], type: 'heatmap' },
    { title: 'Mantel 图', tags: ['Ecology', 'Mantel', '距离'], type: 'network' },
    { title: '网络图', tags: ['Microbiology', '网络', '相互作用'], type: 'network' },
    { title: '多面板图 (6 面板)', tags: ['Nature', '多面板', '复合'], type: 'grid' },
  ];

  return (
    <div className="flex-1 flex flex-col bg-slate-50 min-w-0 overflow-hidden">
      <div className="p-8 max-w-7xl mx-auto w-full flex flex-col h-full">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-800 mb-2 flex items-center gap-2">
            模板库 <span className="text-slate-400 font-normal">☆</span>
          </h1>
          <p className="text-slate-500 text-sm">从专业模板开始，快速创建高质量、可发表的科学图形。</p>
        </div>

        {/* Search and Filters */}
        <div className="flex flex-col md:flex-row gap-4 mb-6 relative z-10">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="搜索模板 (如: 条形图、PCA、heatmap、箱线图...)" 
              className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
            />
          </div>
          <div className="flex gap-2 shrink-0">
            {[
              { label: '期刊风格', value: '全部期刊' },
              { label: '图形类型', value: '全部类型' },
              { label: '学科', value: '全部学科' },
              { label: '☆ 收藏', value: '全部' },
            ].map(filter => (
              <button key={filter.label} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium text-slate-600 flex items-center gap-2 hover:bg-slate-50 shadow-sm whitespace-nowrap">
                {filter.label} <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-auto border-l border-slate-200 pl-4">
            <span className="text-sm text-slate-500 mr-2">排序方式: <span className="font-medium text-slate-700 cursor-pointer">热门 <ChevronDown className="w-3.5 h-3.5 inline" /></span></span>
            <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              <button className="p-1.5 bg-white rounded shadow-sm text-blue-600"><LayoutGrid className="w-4 h-4" /></button>
              <button className="p-1.5 text-slate-400 hover:text-slate-600"><List className="w-4 h-4" /></button>
            </div>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto min-h-0 pr-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {templates.map((tpl, i) => (
              <div key={i} className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden flex flex-col">
                <div className="h-40 bg-slate-50 border-b border-slate-100 flex items-center justify-center p-4 relative group cursor-pointer" onClick={() => onNavigate('editor')}>
                   {/* Fake Chart Placeholder */}
                   <div className="w-full h-full opacity-50 flex items-center justify-center border border-dashed border-slate-300 rounded group-hover:border-blue-400 transition-colors bg-white">
                     <span className="text-slate-400 font-mono text-xs uppercase">{tpl.type} _preview</span>
                   </div>
                   
                   <div className="absolute inset-0 bg-blue-900/5 backdrop-blur-[1px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                      <button className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg shadow hover:bg-blue-700 transition-colors">
                        使用此模板
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col flex-1">
                  <div className="font-bold text-slate-800 mb-2 truncate">{tpl.title}</div>
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {tpl.tags.map(tag => (
                      <span key={tag} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-medium border border-slate-200">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-2 border-t border-slate-100">
                    <button className="text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors px-2 py-1 bg-blue-50 rounded" onClick={() => onNavigate('editor')}>
                      使用模板
                    </button>
                    <button className="text-slate-300 hover:text-amber-400 transition-colors">
                       <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-8 mb-4 border-t border-slate-200 pt-4">
            <div className="text-sm text-slate-500">共 11 个模板</div>
            <div className="flex items-center gap-2">
              <button className="w-8 h-8 rounded border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50 disabled:opacity-50" disabled>
                <ChevronDown className="w-4 h-4 rotate-90" />
              </button>
              <button className="w-8 h-8 rounded border border-blue-600 bg-blue-50 text-blue-600 font-medium text-sm flex items-center justify-center">1</button>
              <button className="w-8 h-8 rounded border border-slate-200 flex items-center justify-center text-slate-400 hover:bg-slate-50">
                <ChevronDown className="w-4 h-4 -rotate-90" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
