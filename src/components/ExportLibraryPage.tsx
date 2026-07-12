import { useEffect, useState, useMemo } from 'react';
import { downloadAuthenticatedFile } from '../utils/authenticatedFetch';
import { 
  Download, 
  FileImage, 
  RefreshCw, 
  Search, 
  Trash2, 
  Grid, 
  List, 
  ArrowLeft, 
  ChevronDown, 
  Calendar, 
  Layers, 
  CheckSquare, 
  Square,
  Info
} from 'lucide-react';
import type { ViewState } from '../App';
import { sanitizeSvg } from '../utils/svgEditor';

interface ExportAsset {
  assetId: string;
  projectId: string;
  figureId: string | null;
  name: string;
  format: string;
  dpi: number | null;
  filePath: string;
  thumbnailSvg: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  projectName?: string;
  fileExists?: boolean;
  sizeBytes?: number;
}

interface ExportLibraryPageProps {
  projectId: string | null;
  onNavigate: (view: ViewState, subView?: string) => void;
  onBack?: () => void;
}

type SortField = 'date' | 'name' | 'size' | 'dpi';
type SortOrder = 'asc' | 'desc';

function isSubplotAsset(asset: ExportAsset) {
  return asset.tags?.includes('subplot') || typeof asset.metadata?.subplotId === 'string';
}

function getAssetTypeLabel(asset: ExportAsset) {
  if (isSubplotAsset(asset)) return '子图裁剪';
  if (asset.tags?.includes('composite')) return '组合图';
  return '整图';
}

function getAssetSourceLabel(asset: ExportAsset) {
  const subplotId = typeof asset.metadata?.subplotId === 'string' ? asset.metadata.subplotId : null;
  if (subplotId && asset.figureId) return `${asset.figureId} · ${subplotId}`;
  return asset.figureId || '外部拼接';
}

export function ExportLibraryPage({ projectId, onNavigate, onBack }: ExportLibraryPageProps) {
  const [assets, setAssets] = useState<ExportAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<string>('all');
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  
  // Sorting state
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  
  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const loadAssets = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/export-assets');
      const data = await res.json();
      if (data.status === 'success') {
        setAssets(data.assets || []);
      } else {
        alert(`加载失败: ${data.message}`);
      }
    } catch (e: any) {
      alert(`网络异常: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
  }, []);

  // Handle individual asset download
  const downloadAsset = async (asset: ExportAsset) => {
    await downloadAuthenticatedFile(
      `/api/projects/${asset.projectId}/export-assets/${asset.assetId}/file`,
      `${asset.name}.${asset.format}`,
    );
  };

  // Handle batch download
  const handleBatchDownload = async () => {
    if (selectedIds.size === 0) return;
    try {
      const res = await fetch('/api/export-assets/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || '打包下载失败');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scifigure_exports.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e.message || '打包下载失败');
    }
  };

  // Handle batch delete
  const handleBatchDelete = async (explicitIds?: string[]) => {
    const ids = explicitIds ?? Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`确定要永久删除这 ${ids.length} 个导出图资产及本地文件吗？`)) return;
    
    setLoading(true);
    try {
      const res = await fetch('/api/export-assets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: ids })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setSelectedIds(new Set());
        await loadAssets();
      } else {
        alert(`删除失败: ${data.message}`);
      }
    } catch (e: any) {
      alert(`删除请求异常: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Toggle selection for all filtered assets
  const handleToggleSelectAll = (filteredAssets: ExportAsset[]) => {
    const allSelected = filteredAssets.every(a => selectedIds.has(a.assetId));
    const next = new Set(selectedIds);
    if (allSelected) {
      filteredAssets.forEach(a => next.delete(a.assetId));
    } else {
      filteredAssets.forEach(a => next.add(a.assetId));
    }
    setSelectedIds(next);
  };

  // Format filter options
  const formatsList = useMemo(() => {
    const set = new Set<string>();
    assets.forEach(a => set.add(a.format.toUpperCase()));
    return Array.from(set);
  }, [assets]);

  const projectOptions = useMemo(() => {
    const projects = new Map<string, string>();
    assets.forEach(asset => projects.set(asset.projectId, asset.projectName || asset.projectId));
    return Array.from(projects.entries()).sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  }, [assets]);

  // Filtered and Sorted assets
  const processedAssets = useMemo(() => {
    let result = [...assets];

    if (selectedProject !== 'all') {
      result = result.filter(asset => asset.projectId === selectedProject);
    }
    
    // 1. Search Query Filter
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(a => 
        a.name.toLowerCase().includes(q) || 
        (a.figureId && a.figureId.toLowerCase().includes(q))
      );
    }
    
    // 2. Format Filter
    if (selectedFormat !== 'all') {
      result = result.filter(a => a.format.toLowerCase() === selectedFormat.toLowerCase());
    }
    
    // 3. Sorting
    result.sort((a, b) => {
      let valA: any = a[sortField === 'date' ? 'createdAt' : sortField];
      let valB: any = b[sortField === 'date' ? 'createdAt' : sortField];
      
      if (sortField === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (sortField === 'size') {
        valA = a.sizeBytes ?? 0;
        valB = b.sizeBytes ?? 0;
      } else if (sortField === 'dpi') {
        valA = a.dpi ?? 0;
        valB = b.dpi ?? 0;
      }
      
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    
    return result;
  }, [assets, query, selectedFormat, selectedProject, sortField, sortOrder]);

  const totalSelected = useMemo(() => {
    let count = 0;
    processedAssets.forEach(a => {
      if (selectedIds.has(a.assetId)) count++;
    });
    return count;
  }, [processedAssets, selectedIds]);

  return (
    <div className="flex-1 overflow-auto bg-slate-50 flex flex-col min-w-0">
      {/* Top Banner / Actions */}
      <div className="h-16 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-3">
          <button 
            type="button" 
            onClick={() => {
              if (onBack) onBack();
              else onNavigate('home');
            }}
            className="p-2 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors"
            title="返回上一页"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-bold text-slate-800">导出资产库</h1>
            <p className="text-xs text-slate-500">汇总当前账号所有项目的历史导出图，可按项目筛选、对比和下载</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            type="button" 
            onClick={() => void loadAssets()} 
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 bg-white rounded-lg text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新库
          </button>
          <button 
            type="button" 
            onClick={() => onNavigate('export_settings')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-md shadow-blue-100 hover:shadow-lg transition-all"
          >
            去配置导出
          </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 p-8 max-w-7xl mx-auto w-full space-y-6">
        {/* Controls Board */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Search Input */}
            <div className="relative w-80 max-w-full">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
              <input 
                type="text" 
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="搜索导出的文件名或 Figure..." 
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:bg-white focus:border-blue-500 transition-all text-slate-700" 
              />
            </div>
            
            {/* Format Tags */}
            <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
              <button 
                type="button"
                onClick={() => setSelectedFormat('all')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${selectedFormat === 'all' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                全部
              </button>
              {formatsList.map(fmt => (
                <button 
                  type="button"
                  key={fmt}
                  onClick={() => setSelectedFormat(fmt)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold uppercase transition-all ${selectedFormat.toLowerCase() === fmt.toLowerCase() ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  {fmt}
                </button>
              ))}
            </div>

            <select
              value={selectedProject}
              onChange={event => setSelectedProject(event.target.value)}
              className="min-w-44 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 outline-none focus:border-blue-500"
              aria-label="按来源项目筛选"
            >
              <option value="all">全部项目（{assets.length}）</option>
              {projectOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>

            {/* View / Sort Actions */}
            <div className="flex items-center gap-3">
              {/* Sorting Selectors */}
              <div className="flex items-center gap-2 text-xs border border-slate-200 rounded-lg bg-slate-50/50 p-1">
                <select 
                  value={sortField} 
                  onChange={e => setSortField(e.target.value as SortField)} 
                  className="bg-transparent font-medium text-slate-600 py-1 px-1.5 outline-none cursor-pointer"
                >
                  <option value="date">导出日期</option>
                  <option value="name">文件名</option>
                  <option value="size">文件大小</option>
                  <option value="dpi">分辨率 (DPI)</option>
                </select>
                <button 
                  type="button"
                  onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                  className="px-2 py-1 bg-white border border-slate-200 rounded hover:bg-slate-50 text-slate-600 font-semibold"
                >
                  {sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}
                </button>
              </div>

              {/* View Toggle */}
              <div className="flex items-center border border-slate-200 rounded-lg p-1 bg-slate-50">
                <button 
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  title="网格视图"
                >
                  <Grid className="w-4 h-4" />
                </button>
                <button 
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  title="列表视图"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
          
          {/* Stats Bar */}
          <div className="flex items-center justify-between text-xs text-slate-500 border-t border-slate-100 pt-3">
            <div className="flex items-center gap-1">
              <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              <span>共筛选出 <strong className="text-slate-700">{processedAssets.length}</strong> 个导出资产。</span>
            </div>
            {processedAssets.length > 0 && (
              <button 
                type="button"
                onClick={() => handleToggleSelectAll(processedAssets)}
                className="text-blue-600 font-semibold hover:text-blue-700"
              >
                {processedAssets.every(a => selectedIds.has(a.assetId)) ? '取消全选' : '全选此页面'}
              </button>
            )}
          </div>
        </div>

        {/* Assets List/Grid */}
        {processedAssets.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 py-16 px-4 text-center shadow-sm">
            <FileImage className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <div className="text-sm font-semibold text-slate-700">未找到任何导出资产</div>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              {query || selectedProject !== 'all' ? '尝试更改搜索关键词、格式或来源项目' : '当前账号还没有写入历史导出资产。普通渲染预览不会自动进入图库。'}
            </p>
            {!query && (
              <button
                type="button"
                onClick={() => onNavigate('export_settings')}
                className="mt-5 px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-sm transition-colors"
              >
                去导出设置保存到图库
              </button>
            )}
          </div>
        ) : viewMode === 'grid' ? (
          /* Grid View */
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {processedAssets.map(asset => {
              const isSelected = selectedIds.has(asset.assetId);
              return (
                <div 
                  key={asset.assetId} 
                  className={`bg-white rounded-xl border transition-all duration-200 overflow-hidden flex flex-col group relative ${
                    isSelected ? 'border-blue-500 shadow-blue-50 shadow-md ring-1 ring-blue-500' : 'border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300'
                  }`}
                >
                  {/* Select Checkbox Indicator */}
                  <button 
                    type="button"
                    onClick={() => {
                      const next = new Set(selectedIds);
                      if (isSelected) next.delete(asset.assetId);
                      else next.add(asset.assetId);
                      setSelectedIds(next);
                    }}
                    className="absolute top-2.5 left-2.5 z-10 w-6 h-6 rounded-md bg-white border border-slate-200 shadow-sm hover:bg-slate-50 flex items-center justify-center transition-all"
                  >
                    {isSelected ? (
                      <CheckSquare className="w-4 h-4 text-blue-600" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-400 hover:text-slate-600" />
                    )}
                  </button>

                  {/* Thumbnail SVG Preview */}
                  <div className="h-44 bg-slate-100/50 border-b border-slate-100 flex items-center justify-center relative overflow-hidden p-4 group-hover:bg-slate-100/30 transition-colors">
                    {asset.thumbnailSvg ? (
                      <div 
                        className="w-full h-full [&>svg]:w-full [&>svg]:h-full flex items-center justify-center select-none"
                        dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }}
                      />
                    ) : (
                      <FileImage className="w-10 h-10 text-slate-300" />
                    )}
                    <div className="absolute bottom-2 right-2 flex items-center gap-1">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded select-none ${isSubplotAsset(asset) ? 'bg-emerald-600/90 text-white' : 'bg-slate-900/70 text-white'}`}>
                        {getAssetTypeLabel(asset)}
                      </span>
                      <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-slate-900/70 text-white select-none">
                        {asset.format}
                      </span>
                    </div>
                  </div>

                  {/* Info Details */}
                  <div className="p-4 flex-1 flex flex-col">
                    <div className="text-xs font-semibold text-slate-800 line-clamp-1 mb-1" title={asset.name}>
                      {asset.name}
                    </div>
                    
                    {/* Attributes */}
                    <div className="space-y-1 mt-auto">
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span className="flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> 来源</span>
                        <span className="font-mono text-slate-600 truncate max-w-[120px]" title={getAssetSourceLabel(asset)}>{getAssetSourceLabel(asset)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[10px] text-slate-400">
                        <span>项目</span>
                        <span className="truncate font-semibold text-slate-600" title={asset.projectName || asset.projectId}>{asset.projectName || asset.projectId}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>资产类型</span>
                        <span className={`font-semibold ${isSubplotAsset(asset) ? 'text-emerald-700' : 'text-slate-600'}`}>{getAssetTypeLabel(asset)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>大小 / DPI</span>
                        <span className="text-slate-600 font-semibold">
                          {asset.sizeBytes ? `${(asset.sizeBytes / 1024).toFixed(1)} KB` : '--'}
                          {asset.dpi ? ` · ${asset.dpi} DPI` : ''}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> 导出日期</span>
                        <span className="text-slate-500">{new Date(asset.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>

                    {/* Actions overlay / footer */}
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                      <button 
                        type="button"
                        onClick={() => downloadAsset(asset)}
                        className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 text-xs font-semibold transition-all"
                      >
                        <Download className="w-3 h-3" /> 下载
                      </button>
                      <button 
                        type="button"
                        onClick={() => void handleBatchDelete([asset.assetId])}
                        className="p-1.5 rounded-lg border border-slate-200 hover:border-red-200 hover:bg-red-50 text-slate-500 hover:text-red-600 transition-all"
                        title="删除此导出"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List View (Table-like grid) */
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
            <div className="grid grid-cols-[48px_80px_1fr_100px_120px_90px_120px_150px_100px] border-b border-slate-200 bg-slate-50/75 px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider select-none">
              <span className="text-center">选择</span>
              <span>缩略图</span>
              <span>文件名</span>
              <span>格式</span>
              <span>来源图元</span>
              <span>类型</span>
              <span>大小</span>
              <span>导出时间</span>
              <span className="text-right">操作</span>
            </div>
            
            <div className="divide-y divide-slate-100">
              {processedAssets.map(asset => {
                const isSelected = selectedIds.has(asset.assetId);
                return (
                  <div 
                    key={asset.assetId} 
                    className={`grid grid-cols-[48px_80px_1fr_100px_120px_90px_120px_150px_100px] items-center px-4 py-3 text-xs transition-colors hover:bg-slate-50/50 ${
                      isSelected ? 'bg-blue-50/20' : ''
                    }`}
                  >
                    {/* Checkbox */}
                    <div className="flex justify-center">
                      <button 
                        type="button"
                        onClick={() => {
                          const next = new Set(selectedIds);
                          if (isSelected) next.delete(asset.assetId);
                          else next.add(asset.assetId);
                          setSelectedIds(next);
                        }}
                        className="w-5 h-5 rounded hover:bg-slate-100 flex items-center justify-center transition-all"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-blue-600" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-300" />
                        )}
                      </button>
                    </div>

                    {/* Thumbnail */}
                    <div className="w-14 h-10 bg-slate-100 border border-slate-200 rounded overflow-hidden flex items-center justify-center p-1">
                      {asset.thumbnailSvg ? (
                        <div 
                          className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                          dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }}
                        />
                      ) : (
                        <FileImage className="w-4 h-4 text-slate-300" />
                      )}
                    </div>

                    {/* File Name */}
                    <div className="min-w-0 pr-4" title={`${asset.projectName || asset.projectId} · ${asset.name}`}>
                      <div className="truncate font-semibold text-slate-800">{asset.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-slate-400">{asset.projectName || asset.projectId}</div>
                    </div>

                    {/* Format */}
                    <span className="uppercase font-mono font-bold text-slate-500">
                      {asset.format}
                    </span>

                    {/* Figure ID */}
                    <span className="font-mono text-slate-600 truncate pr-3">
                      {getAssetSourceLabel(asset)}
                    </span>

                    {/* Asset Type */}
                    <span className={`font-semibold ${isSubplotAsset(asset) ? 'text-emerald-700' : 'text-slate-500'}`}>
                      {getAssetTypeLabel(asset)}
                    </span>

                    {/* Size / Resolution */}
                    <span className="text-slate-600">
                      {asset.sizeBytes ? `${(asset.sizeBytes / 1024).toFixed(1)} KB` : '--'}
                      {asset.dpi ? ` (${asset.dpi} DPI)` : ''}
                    </span>

                    {/* Created Date */}
                    <span className="text-slate-500">
                      {new Date(asset.createdAt).toLocaleString()}
                    </span>

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-2.5">
                      <button 
                        type="button"
                        onClick={() => downloadAsset(asset)}
                        className="p-1.5 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded text-blue-600 transition-colors"
                        title="下载"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        type="button"
                        onClick={() => void handleBatchDelete([asset.assetId])}
                        className="p-1.5 hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded text-slate-400 hover:text-red-600 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Floating Action Bar for Multiple Selections */}
      {totalSelected > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-4 bg-slate-900 text-white px-6 py-3 rounded-full shadow-2xl border border-slate-800 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-xs font-semibold select-none pr-2 border-r border-slate-800">
            已选择 <strong className="text-blue-400 text-sm">{totalSelected}</strong> 项
          </span>
          <div className="flex items-center gap-2">
            <button 
              type="button"
              onClick={handleBatchDownload}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-xs font-bold rounded-full transition-all"
            >
              <Download className="w-3.5 h-3.5" />
              打包下载
            </button>
            <button 
              type="button"
              onClick={() => void handleBatchDelete()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-xs font-bold rounded-full transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
              批量删除
            </button>
            <button 
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-slate-400 hover:text-white px-2 py-1 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
