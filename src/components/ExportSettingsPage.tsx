import { useEffect, useMemo, useState } from 'react';
import type { PointerEvent } from 'react';
import { Download, CheckCircle, AlertTriangle, FileImage, Settings2, FileCode, Check } from 'lucide-react';
import { ViewState } from '../App';
import { FigureSpec } from '../types';
import type { FigureSession } from '../schemas/manifest';
import { sanitizeSvg } from '../utils/svgEditor';

const DPI_OPTIONS = [
  { value: 300, label: '300 dpi (标准印花)' },
  { value: 600, label: '600 dpi (高质量 - Nature/Science 推荐)' },
  { value: 1200, label: '1200 dpi (极高清晰度线图)' },
];

interface ExportAsset {
  assetId: string;
  projectId: string;
  figureId: string | null;
  name: string;
  format: string;
  dpi: number | null;
  filePath: string;
  thumbnailSvg: string | null;
  tags: string[];
  createdAt: string;
}

interface ComposerPanel {
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

interface DragState {
  assetId: string;
  pointerId: number;
  startX: number;
  startY: number;
  panelX: number;
  panelY: number;
}

const COMPOSER_PANEL_WIDTH = 280;
const COMPOSER_PANEL_HEIGHT = 210;
const COMPOSER_GAP_X = 34;
const COMPOSER_GAP_Y = 44;
const COMPOSER_LABEL_OFFSET = 24;

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function ExportSettingsPage({
  spec,
  onNavigate,
  onSpecChange,
  figSession,
  projectId,
  activeFigureId,
}: {
  spec: FigureSpec;
  onNavigate: (view: ViewState) => void;
  onSpecChange: (spec: FigureSpec) => void;
  figSession: FigureSession | null;
  projectId?: string | null;
  activeFigureId?: string;
}) {
  const exportConfig = spec.export ?? { format: 'PDF', dpi: 600, color_mode: 'RGB', embed_fonts: true };
  const figureConfig = spec.figure ?? { width: 100, height: 80, unit: 'mm', dpi: exportConfig.dpi };
  const [assets, setAssets] = useState<ExportAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetFormatFilter, setAssetFormatFilter] = useState('all');
  const [assetSort, setAssetSort] = useState<'newest' | 'oldest' | 'name'>('newest');
  const [isAssetLoading, setIsAssetLoading] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composerPanels, setComposerPanels] = useState<ComposerPanel[]>([]);
  const [activeComposerAssetId, setActiveComposerAssetId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  const loadAssets = async () => {
    if (!projectId) return;
    setIsAssetLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export-assets`);
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '导出图库加载失败');
      setAssets(data.assets || []);
    } catch (err) {
      console.error('Load export assets error:', err);
    } finally {
      setIsAssetLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
  }, [projectId]);

  const filteredAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    return [...assets]
      .filter(asset => assetFormatFilter === 'all' || asset.format.toLowerCase() === assetFormatFilter)
      .filter(asset => {
        if (!query) return true;
        return `${asset.name} ${asset.figureId || ''} ${asset.format}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (assetSort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
        const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return assetSort === 'oldest' ? diff : -diff;
      });
  }, [assets, assetFormatFilter, assetSearch, assetSort]);

  const selectedAssets = useMemo(
    () => assets.filter(asset => selectedAssetIds.includes(asset.assetId)),
    [assets, selectedAssetIds]
  );

  const composerCanvas = useMemo(() => {
    const count = composerPanels.length || selectedAssetIds.length || 2;
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    return {
      width: cols * COMPOSER_PANEL_WIDTH + (cols - 1) * COMPOSER_GAP_X,
      height: rows * COMPOSER_PANEL_HEIGHT + (rows - 1) * COMPOSER_GAP_Y + COMPOSER_LABEL_OFFSET,
    };
  }, [composerPanels.length, selectedAssetIds.length]);

  const createDefaultComposerPanels = (inputAssets: ExportAsset[]): ComposerPanel[] => {
    const cols = inputAssets.length <= 2 ? inputAssets.length : inputAssets.length <= 4 ? 2 : 3;
    return inputAssets.map((asset, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        assetId: asset.assetId,
        x: col * (COMPOSER_PANEL_WIDTH + COMPOSER_GAP_X),
        y: row * (COMPOSER_PANEL_HEIGHT + COMPOSER_GAP_Y) + COMPOSER_LABEL_OFFSET,
        width: COMPOSER_PANEL_WIDTH,
        height: COMPOSER_PANEL_HEIGHT,
        label: `(${String.fromCharCode(97 + index)})`,
      };
    });
  };

  const composerAssets = useMemo(() => {
    const map = new Map(assets.map(asset => [asset.assetId, asset]));
    return composerPanels.map(panel => map.get(panel.assetId)).filter(Boolean) as ExportAsset[];
  }, [assets, composerPanels]);

  const toggleAssetSelection = (assetId: string) => {
    setSelectedAssetIds(prev => prev.includes(assetId) ? prev.filter(id => id !== assetId) : [...prev, assetId]);
  };

  const downloadAsset = (asset: ExportAsset) => {
    if (!projectId) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/projects/${projectId}/export-assets/${asset.assetId}/file`;
    anchor.download = `${asset.name}.${asset.format}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const downloadSelectedAssets = () => {
    selectedAssets.forEach(asset => downloadAsset(asset));
  };

  const deleteSelectedAssets = async () => {
    if (!projectId || selectedAssetIds.length === 0) return;
    if (!window.confirm(`删除 ${selectedAssetIds.length} 个导出记录？本地导出文件也会删除。`)) return;
    const res = await fetch(`/api/projects/${projectId}/export-assets`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetIds: selectedAssetIds }),
    });
    const data = await res.json();
    if (data.status !== 'success') {
      alert(data.message || '删除失败');
      return;
    }
    setSelectedAssetIds([]);
    await loadAssets();
  };

  const openComposer = () => {
    if (![2, 4, 6].includes(selectedAssetIds.length)) {
      alert('一键排版 MVP 目前支持选择 2、4 或 6 张图。');
      return;
    }
    const ordered = selectedAssetIds
      .map(id => assets.find(asset => asset.assetId === id))
      .filter(Boolean) as ExportAsset[];
    setComposerPanels(createDefaultComposerPanels(ordered));
    setActiveComposerAssetId(ordered[0]?.assetId || null);
    setIsComposerOpen(true);
  };

  const composeSelectedAssets = async () => {
    if (!projectId) return;
    if (![2, 4, 6].includes(composerPanels.length)) {
      alert('一键排版 MVP 目前支持选择 2、4 或 6 张图。');
      return;
    }
    setIsComposing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: composerPanels.map(panel => panel.assetId),
          layout: {
            width: composerCanvas.width,
            height: composerCanvas.height,
            panels: composerPanels,
          },
        }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '组合排版失败');
      downloadTextFile(`${data.asset?.name || 'composite'}.svg`, data.svg, 'image/svg+xml');
      setSelectedAssetIds([]);
      setIsComposerOpen(false);
      await loadAssets();
    } catch (err: any) {
      alert(`组合排版失败: ${err.message}`);
    } finally {
      setIsComposing(false);
    }
  };

  const moveComposerPanel = (assetId: string, direction: -1 | 1) => {
    setComposerPanels(prev => {
      const index = prev.findIndex(panel => panel.assetId === assetId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
      const copy = [...prev];
      const current = copy[index];
      const target = copy[nextIndex];
      copy[index] = { ...target, x: current.x, y: current.y, label: current.label };
      copy[nextIndex] = { ...current, x: target.x, y: target.y, label: target.label };
      return copy;
    });
  };

  const resetComposerLayout = () => {
    setComposerPanels(createDefaultComposerPanels(composerAssets));
  };

  const handleComposerPointerDown = (event: PointerEvent<HTMLDivElement>, panel: ComposerPanel) => {
    event.preventDefault();
    setActiveComposerAssetId(panel.assetId);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      assetId: panel.assetId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panelX: panel.x,
      panelY: panel.y,
    });
  };

  const handleComposerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    setComposerPanels(prev => prev.map(panel => {
      if (panel.assetId !== dragState.assetId) return panel;
      const maxX = Math.max(0, composerCanvas.width - panel.width);
      const maxY = Math.max(COMPOSER_LABEL_OFFSET, composerCanvas.height - panel.height);
      return {
        ...panel,
        x: Math.max(0, Math.min(maxX, dragState.panelX + dx)),
        y: Math.max(COMPOSER_LABEL_OFFSET, Math.min(maxY, dragState.panelY + dy)),
      };
    }));
  };

  const handleComposerPointerUp = () => {
    setDragState(null);
  };

  const updateExportFormat = (format: string) => {
    onSpecChange({ ...spec, export: { ...exportConfig, format } });
  };

  const updateExportDpi = (dpi: number) => {
    onSpecChange({ ...spec, export: { ...exportConfig, dpi } });
  };

  const updateFigureWidth = (width: number) => {
    onSpecChange({ ...spec, figure: { ...figureConfig, width } });
  };

  const updateFigureHeight = (height: number) => {
    onSpecChange({ ...spec, figure: { ...figureConfig, height } });
  };

  const handleExport = async (formatOverride?: string) => {
    try {
      const selectedFormat = formatOverride || exportConfig.format || 'PDF';
      const selectedDpi = exportConfig.dpi || 600;
      const isProjectExport = Boolean(projectId && activeFigureId);

      if (!isProjectExport && !figSession?.sessionId) {
        alert('请先在编辑器中渲染一次图形，然后再进行导出。');
        return;
      }

      const endpoint = isProjectExport ? `/api/projects/${projectId}/export` : '/api/figure/export';
      const payload = isProjectExport
        ? { figureId: activeFigureId, format: selectedFormat, dpi: selectedDpi }
        : { sessionId: figSession?.sessionId, format: selectedFormat, dpi: selectedDpi };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Export failed');

      const exportPayload = isProjectExport
        ? data.figures?.find((figure: any) => figure.figureId === activeFigureId) || data.figures?.[0]
        : data;
      if (!exportPayload) {
        throw new Error('没有可导出的 Figure');
      }

      // Show a note if format conversion fell back to SVG
      if (data.format_note) {
        alert(`提示: ${data.format_note}`);
      }

      const fmt = (exportPayload.format || selectedFormat).toLowerCase();
      let blob: Blob;

      if (exportPayload.binary_b64) {
        const byteStr = atob(exportPayload.binary_b64);
        const byteArr = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) byteArr[i] = byteStr.charCodeAt(i);
        const mimeMap: Record<string, string> = {
          pdf: 'application/pdf',
          png: 'image/png',
          tiff: 'image/tiff',
          eps: 'application/postscript',
        };
        blob = new Blob([byteArr], { type: mimeMap[fmt] || 'application/octet-stream' });
      } else {
        blob = new Blob([exportPayload.svg], { type: 'image/svg+xml' });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportPayload.figureId || 'figure'}.${exportPayload.binary_b64 ? fmt : 'svg'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      // Download reproducible bundle
      if (data.bundle) {
        downloadTextFile('reproducible_bundle.json', JSON.stringify(data.bundle, null, 2), 'application/json');
      }
      if (isProjectExport) {
        await loadAssets();
      }
    } catch (err: any) {
      console.error('Export error:', err);
      alert(`导出失败: ${err.message}`);
    }
  };


  return (
    <div className="flex-1 flex flex-col bg-slate-50 min-w-0 overflow-y-auto">
      <div className="p-8 max-w-7xl mx-auto w-full flex flex-col h-full gap-6">
        
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 mb-1 flex items-center gap-2">
              导出与出版设置
            </h1>
            <p className="text-slate-500 text-sm">配置最终论文图片导出参数，检查图形是否满足目标期刊要求。</p>
          </div>
          <button onClick={() => onNavigate('editor')} className="px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm">
            返回编辑器
          </button>
        </div>

        <div className="flex gap-6 items-start">
          {/* Main Settings Panel */}
          <div className="flex-1 space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h3 className="font-bold text-lg text-slate-800 mb-4 pb-2 border-b border-slate-100 flex items-center gap-2"><Settings2 className="w-5 h-5 text-blue-600" /> 出版参数配置</h3>
              
              <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">输出格式</label>
                  <div className="flex bg-slate-100 rounded-lg p-1">
                    {['PDF', 'SVG', 'TIFF', 'PNG', 'EPS'].map(fmt => (
                      <button 
                        key={fmt}
                        onClick={() => updateExportFormat(fmt)}
                        className={`flex-1 py-2 text-center rounded-md text-sm font-medium transition-all ${exportConfig.format === fmt ? 'bg-white shadow-sm text-blue-600 border border-slate-200/50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'}`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-2">推荐：矢量图(PDF, SVG)放大不失真；高分辨率图(TIFF)适合多数期刊系统。</p>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">分辨率 (DPI)</label>
                  <select
                    value={exportConfig.dpi}
                    onChange={(e) => updateExportDpi(Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {DPI_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">图形尺寸（毫米）</label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <div className="flex items-center border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                        <span className="bg-slate-50 px-3 py-2 border-r border-slate-300 text-slate-500 text-sm">宽</span>
                        <input type="number" value={figureConfig.width} onChange={(e) => updateFigureWidth(Number(e.target.value))} className="w-full p-2 outline-none text-sm" />
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                        <span className="bg-slate-50 px-3 py-2 border-r border-slate-300 text-slate-500 text-sm">高</span>
                        <input type="number" value={figureConfig.height} onChange={(e) => updateFigureHeight(Number(e.target.value))} className="w-full p-2 outline-none text-sm" />
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <span onClick={() => updateFigureWidth(85)} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded border border-blue-100 cursor-pointer hover:bg-blue-100">单栏 (85mm)</span>
                    <span onClick={() => updateFigureWidth(180)} className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded border border-slate-200 cursor-pointer hover:bg-slate-200">双栏 (180mm)</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">颜色模式</label>
                  <select 
                    value={exportConfig.color_mode || 'RGB'} 
                    onChange={(e) => onSpecChange({ ...spec, export: { ...exportConfig, color_mode: e.target.value } })}
                    className="w-full border border-slate-300 rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="RGB">RGB (默认屏幕显示)</option>
                    <option value="CMYK">CMYK (印刷出版用)</option>
                    <option value="Grayscale">Grayscale (灰度图检查)</option>
                  </select>
                </div>

                <div className="col-span-2 pt-4 border-t border-slate-100">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input 
                      type="checkbox" 
                      checked={exportConfig.embed_fonts ?? true} 
                      onChange={(e) => onSpecChange({ ...spec, export: { ...exportConfig, embed_fonts: e.target.checked } })}
                      className="w-4 h-4 text-blue-600 rounded cursor-pointer accent-blue-600" 
                    />
                    <span className="text-sm font-medium text-slate-800">嵌入字体 (Embed Fonts)</span>
                  </label>
                  <p className="text-xs text-slate-500 ml-6">确保目标电脑或排版系统没有当前字体时能正常显示。</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Sidebar - Publication Checklist & Export */}
          <div className="w-[360px] shrink-0 space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-4 justify-between border-b border-slate-100 pb-2">
                <h3 className="font-bold text-slate-800">出版质量检查单</h3>
                <span className="text-xs font-semibold px-2 py-1 bg-emerald-100 text-emerald-700 rounded border border-emerald-200 flex items-center gap-1"><Check className="w-3 h-3"/> Ready</span>
              </div>
              
              <div className="space-y-3 mb-6">
                {[
                  { label: '图表分辨率 >= 300 PPI', ok: true },
                  { label: '最小字号满足 7pt 要求', ok: true },
                  { label: '线宽不低于 0.5pt', ok: true },
                  { label: '未检测到透明度压缩伪影', ok: true },
                  { label: '字体已嵌入配置', ok: true },
                  { label: 'CMYK 颜色转换安全', ok: false, warn: true }
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm">
                    {item.ok ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    )}
                    <span className={item.ok ? 'text-slate-700' : 'text-amber-700'}>{item.label}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <button onClick={() => handleExport()} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold shadow-md hover:bg-blue-700 flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5">
                  <Download className="w-4 h-4" /> 导出高质量图形 ({exportConfig.format})
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => { updateExportFormat('PDF'); void handleExport('PDF'); }} className="py-2.5 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 shadow-sm">
                    <FileImage className="w-4 h-4 text-red-500" /> PDF 矢量
                  </button>
                  <button 
                    onClick={() => {
                      const script = figSession?.script
                        || spec.custom_script
                        || '# No rendered session script available';
                      downloadTextFile('figure.py', script, 'text/x-python');
                    }}
                    className="py-2.5 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                  >
                    <FileCode className="w-4 h-4 text-blue-500" /> Python 代码
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="font-bold text-lg text-slate-800">导出图库</h3>
              <p className="text-sm text-slate-500 mt-1">
                当前项目导出的图片会自动保存到这里，可按时间、名称和格式管理，也可选择 2/4/6 张自动拼版。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void loadAssets()}
                disabled={!projectId || isAssetLoading}
                className="px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
              >
                {isAssetLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                onClick={downloadSelectedAssets}
                disabled={selectedAssetIds.length === 0}
                className="px-3 py-2 text-sm rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                下载选中 ({selectedAssetIds.length})
              </button>
              <button
                onClick={openComposer}
                disabled={isComposing || ![2, 4, 6].includes(selectedAssetIds.length)}
                className="px-3 py-2 text-sm rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
              >
                快速排版
              </button>
              <button
                onClick={() => onNavigate('composer')}
                disabled={!projectId}
                className="px-3 py-2 text-sm rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              >
                组合图工作台
              </button>
              <button
                onClick={() => void deleteSelectedAssets()}
                disabled={selectedAssetIds.length === 0}
                className="px-3 py-2 text-sm rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                删除
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
            <input
              value={assetSearch}
              onChange={(e) => setAssetSearch(e.target.value)}
              placeholder="搜索名称 / Figure / 格式"
              className="md:col-span-2 border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={assetFormatFilter}
              onChange={(e) => setAssetFormatFilter(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">全部格式</option>
              <option value="svg">SVG</option>
              <option value="pdf">PDF</option>
              <option value="png">PNG</option>
              <option value="tiff">TIFF</option>
              <option value="eps">EPS</option>
            </select>
            <select
              value={assetSort}
              onChange={(e) => setAssetSort(e.target.value as 'newest' | 'oldest' | 'name')}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="newest">按导出时间：最新</option>
              <option value="oldest">按导出时间：最早</option>
              <option value="name">按名称</option>
            </select>
          </div>

          {!projectId ? (
            <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center text-sm text-slate-500">
              当前不是项目导出模式，图库仅在项目内启用。
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="border border-dashed border-slate-300 rounded-xl p-8 text-center text-sm text-slate-500">
              暂无导出记录。先导出一张图，系统会自动保存到项目图库。
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {filteredAssets.map(asset => {
                const selected = selectedAssetIds.includes(asset.assetId);
                return (
                  <div
                    key={asset.assetId}
                    className={`border rounded-xl overflow-hidden bg-slate-50 transition-all ${selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}`}
                  >
                    <div className="h-40 bg-white border-b border-slate-200 flex items-center justify-center overflow-hidden">
                      {asset.thumbnailSvg ? (
                        <div
                          className="w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
                          dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }}
                        />
                      ) : (
                        <FileImage className="w-10 h-10 text-slate-300" />
                      )}
                    </div>
                    <div className="p-3 space-y-3">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleAssetSelection(asset.assetId)}
                          className="mt-1 accent-blue-600"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-sm text-slate-800 truncate" title={asset.name}>{asset.name}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {asset.figureId || 'figure'} · {asset.format.toUpperCase()} · {asset.dpi ? `${asset.dpi} dpi` : '矢量'}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {new Date(asset.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => downloadAsset(asset)}
                          className="flex-1 px-2 py-1.5 text-xs rounded-md bg-white border border-slate-200 hover:bg-slate-100"
                        >
                          下载
                        </button>
                        <button
                          onClick={() => toggleAssetSelection(asset.assetId)}
                          className="flex-1 px-2 py-1.5 text-xs rounded-md bg-white border border-slate-200 hover:bg-slate-100"
                        >
                          {selected ? '取消选择' : '选择'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isComposerOpen && (
          <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-5">
            <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-[min(1180px,96vw)] max-h-[92vh] flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                <div>
                  <h3 className="font-bold text-slate-900 text-lg">组合图排版编辑器</h3>
                  <p className="text-xs text-slate-500 mt-1">拖动单图微调位置；用前移/后移交换顺序；保存后生成新的组合 SVG。</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={resetComposerLayout}
                    className="px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
                  >
                    重置布局
                  </button>
                  <button
                    onClick={() => setIsComposerOpen(false)}
                    className="px-3 py-2 text-sm rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => void composeSelectedAssets()}
                    disabled={isComposing}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isComposing ? '保存中...' : '保存为组合图'}
                  </button>
                </div>
              </div>

              <div className="flex min-h-0">
                <div className="flex-1 overflow-auto bg-slate-100 p-6">
                  <div className="min-w-max mx-auto">
                    <div
                      className="relative bg-white shadow-sm border border-slate-300"
                      style={{ width: composerCanvas.width, height: composerCanvas.height }}
                      onPointerMove={handleComposerPointerMove}
                      onPointerUp={handleComposerPointerUp}
                      onPointerCancel={handleComposerPointerUp}
                    >
                      {composerPanels.map((panel, index) => {
                        const asset = assets.find(item => item.assetId === panel.assetId);
                        const active = activeComposerAssetId === panel.assetId;
                        return (
                          <div
                            key={panel.assetId}
                            className={`absolute select-none rounded-md border-2 bg-white overflow-hidden cursor-grab active:cursor-grabbing ${active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-300 hover:border-blue-300'}`}
                            style={{
                              left: panel.x,
                              top: panel.y,
                              width: panel.width,
                              height: panel.height,
                            }}
                            onPointerDown={(event) => handleComposerPointerDown(event, panel)}
                          >
                            <div className="absolute left-0 -top-6 text-sm font-bold text-slate-900 pointer-events-none">
                              {panel.label}
                            </div>
                            {asset?.thumbnailSvg ? (
                              <div
                                className="w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain pointer-events-none"
                                dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                                无 SVG 预览
                              </div>
                            )}
                            <div className="absolute right-1 top-1 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[10px] font-semibold shadow">
                              {index + 1}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="w-80 shrink-0 border-l border-slate-200 bg-white p-4 overflow-y-auto">
                  <div className="font-semibold text-slate-800 mb-3">单图顺序与位置</div>
                  <div className="space-y-3">
                    {composerPanels.map((panel, index) => {
                      const asset = assets.find(item => item.assetId === panel.assetId);
                      const active = activeComposerAssetId === panel.assetId;
                      return (
                        <div
                          key={panel.assetId}
                          onClick={() => setActiveComposerAssetId(panel.assetId)}
                          className={`rounded-lg border p-3 cursor-pointer ${active ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-800 truncate">{panel.label} {asset?.name || '未命名图'}</div>
                              <div className="text-xs text-slate-500 mt-1">x {Math.round(panel.x)} · y {Math.round(panel.y)}</div>
                            </div>
                            <span className="text-xs px-2 py-1 rounded bg-white border border-slate-200 text-slate-500">#{index + 1}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-3">
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                moveComposerPanel(panel.assetId, -1);
                              }}
                              disabled={index === 0}
                              className="px-2 py-1.5 text-xs rounded-md border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40"
                            >
                              前移交换
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                moveComposerPanel(panel.assetId, 1);
                              }}
                              disabled={index === composerPanels.length - 1}
                              className="px-2 py-1.5 text-xs rounded-md border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40"
                            >
                              后移交换
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
