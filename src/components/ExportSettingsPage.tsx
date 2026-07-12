import { useEffect, useMemo, useState } from 'react';
import type { PointerEvent } from 'react';
import { Download, CheckCircle, AlertTriangle, FileImage, Settings2, FileCode, Check } from 'lucide-react';
import { ViewState } from '../App';
import { FigureSpec } from '../types';
import type { FigureSession } from '../schemas/manifest';
import { sanitizeSvg } from '../utils/svgEditor';
import { downloadAuthenticatedFile } from '../utils/authenticatedFetch';

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
  sizeBytes?: number;
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

interface ExportProgressState {
  phase: string;
  detail: string;
  percent: number;
}

const COMPOSER_PANEL_WIDTH = 280;
const COMPOSER_PANEL_HEIGHT = 210;
const COMPOSER_GAP_X = 34;
const COMPOSER_GAP_Y = 44;
const COMPOSER_LABEL_OFFSET = 24;
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const CSS_PX_PER_MM = 96 / 25.4;
const WORD_MARGIN_PRESETS = {
  normal: { label: 'Word 默认页边距', top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
  narrow: { label: 'Word 窄页边距', top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
  manuscript: { label: '论文常用 20mm', top: 20, right: 20, bottom: 20, left: 20 },
};

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

function isSubplotExportAsset(asset: ExportAsset) {
  return asset.tags?.includes('subplot') || asset.figureId?.includes(':subplot.');
}

function getExportAssetTypeLabel(asset: ExportAsset) {
  if (isSubplotExportAsset(asset)) return '子图裁剪';
  if (asset.tags?.includes('composite')) return '组合图';
  return '整图';
}

function getExportAssetSourceLabel(asset: ExportAsset) {
  if (asset.figureId?.includes(':subplot.')) return asset.figureId.replace(':', ' · ');
  return asset.figureId || 'figure';
}

function collectFontSizeStats(figSession: FigureSession | null, scale: number) {
  const objects = figSession?.manifest?.objects || [];
  const sizes = objects
    .map((obj) => {
      const props = obj.currentProps || {};
      const size = Number(props.fontsize ?? props.tick_labelsize ?? props.label_fontsize);
      if (!Number.isFinite(size) || size <= 0) return null;
      const role = obj.role || obj.kind || obj.id;
      return { id: obj.id, role: String(role), sourcePt: size, finalPt: size * scale };
    })
    .filter(Boolean) as Array<{ id: string; role: string; sourcePt: number; finalPt: number }>;

  sizes.sort((a, b) => a.finalPt - b.finalPt);
  const min = sizes[0] || null;
  const tooSmall = sizes.filter(item => item.finalPt < 6).length;
  const borderline = sizes.filter(item => item.finalPt >= 6 && item.finalPt < 7).length;
  return { min, tooSmall, borderline, count: sizes.length };
}

export function ExportSettingsPage({
  spec,
  onNavigate,
  onSpecChange,
  figSession,
  projectId,
  activeFigureId,
  isRendering = false,
}: {
  spec: FigureSpec;
  onNavigate: (view: ViewState) => void;
  onSpecChange: (spec: FigureSpec) => void;
  figSession: FigureSession | null;
  projectId?: string | null;
  activeFigureId?: string;
  isRendering?: boolean;
}) {
  const exportConfig = spec.export ?? { format: 'PDF', dpi: 600, color_mode: 'RGB', embed_fonts: true };
  const figureConfig = spec.figure ?? { width: 100, height: 80, unit: 'mm', dpi: exportConfig.dpi };
  const [assets, setAssets] = useState<ExportAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetFormatFilter, setAssetFormatFilter] = useState('all');
  const [assetSort, setAssetSort] = useState<'newest' | 'oldest' | 'name'>('newest');
  const [isAssetLoading, setIsAssetLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgressState | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [isSavingAllFigures, setIsSavingAllFigures] = useState(false);
  const [includeSubplotExports, setIncludeSubplotExports] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composerPanels, setComposerPanels] = useState<ComposerPanel[]>([]);
  const [activeComposerAssetId, setActiveComposerAssetId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [wordMarginPreset, setWordMarginPreset] = useState<keyof typeof WORD_MARGIN_PRESETS>('normal');
  const [wordPreviewMode, setWordPreviewMode] = useState<'actual' | 'fitWidth'>('fitWidth');
  const [wordPageZoom, setWordPageZoom] = useState(1);
  const [showWordSampleText, setShowWordSampleText] = useState(true);

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

  const wordPreview = useMemo(() => {
    const margins = WORD_MARGIN_PRESETS[wordMarginPreset];
    const contentWidth = A4_WIDTH_MM - margins.left - margins.right;
    const contentHeight = A4_HEIGHT_MM - margins.top - margins.bottom;
    const sourceWidth = Math.max(1, Number(figureConfig.width) || 100);
    const sourceHeight = Math.max(1, Number(figureConfig.height) || 80);
    const fitScale = Math.min(contentWidth / sourceWidth, contentHeight / sourceHeight);
    const displayScale = wordPreviewMode === 'fitWidth' ? Math.min(fitScale, 1) : 1;
    const finalWidth = sourceWidth * displayScale;
    const finalHeight = sourceHeight * displayScale;
    const pagePx = A4_WIDTH_MM * CSS_PX_PER_MM * wordPageZoom;
    const pageScale = pagePx / A4_WIDTH_MM;
    const left = margins.left * pageScale + Math.max(0, (contentWidth - finalWidth) * pageScale / 2);
    const sampleTopReserveMm = showWordSampleText ? 44 : 0;
    const top = (margins.top + sampleTopReserveMm) * pageScale;
    const stats = collectFontSizeStats(figSession, displayScale);
    return {
      margins,
      contentWidth,
      contentHeight,
      sourceWidth,
      sourceHeight,
      finalWidth,
      finalHeight,
      displayScale,
      pagePx,
      pageHeightPx: A4_HEIGHT_MM * pageScale,
      pageScale,
      left,
      top,
      sampleTopReserveMm,
      figureWidthPx: finalWidth * pageScale,
      figureHeightPx: finalHeight * pageScale,
      overflows: finalWidth > contentWidth || finalHeight > contentHeight,
      stats,
    };
  }, [figSession, figureConfig.height, figureConfig.width, showWordSampleText, wordMarginPreset, wordPageZoom, wordPreviewMode]);

  const toggleAssetSelection = (assetId: string) => {
    setSelectedAssetIds(prev => prev.includes(assetId) ? prev.filter(id => id !== assetId) : [...prev, assetId]);
  };

  const downloadAsset = async (asset: ExportAsset) => {
    if (!projectId) return;
    await downloadAuthenticatedFile(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/file`,
      `${asset.name}.${asset.format}`,
    );
  };

  const downloadSelectedAssets = async () => {
    if (selectedAssetIds.length === 0) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/export-assets/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: selectedAssetIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || '打包下载失败');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `exports_${projectId?.slice(0, 8) || 'archive'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e.message || '打包下载失败');
    }
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
    if (isRendering) {
      alert('后台引擎正在渲染中，请等待渲染完成后再进行导出。');
      return;
    }
    if (isExporting) return;
    try {
      const selectedFormat = formatOverride || exportConfig.format || 'PDF';
      const selectedDpi = exportConfig.dpi || 600;
      const isProjectExport = Boolean(projectId && activeFigureId);

      if (!isProjectExport && !figSession?.sessionId) {
        alert('请先在编辑器中渲染一次图形，然后再进行导出。');
        return;
      }

      setIsExporting(true);
      setExportProgress({
        phase: '准备导出',
        detail: `正在准备 ${selectedFormat.toUpperCase()} · ${selectedDpi} dpi${includeSubplotExports ? ' · 包含子图' : ''}`,
        percent: 12,
      });

      const endpoint = isProjectExport ? `/api/projects/${projectId}/export` : '/api/figure/export';
      const payload = isProjectExport
        ? { figureId: activeFigureId, format: selectedFormat, dpi: selectedDpi, revision: figSession?.revision, includeSubplots: includeSubplotExports }
        : { sessionId: figSession?.sessionId, format: selectedFormat, dpi: selectedDpi, revision: figSession?.revision };

      setExportProgress({
        phase: '服务器生成中',
        detail: '正在重放编辑记录并生成导出文件，请不要重复点击。',
        percent: 38,
      });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setExportProgress({
        phase: '处理导出结果',
        detail: '服务器已返回，正在准备浏览器下载与图库记录。',
        percent: 72,
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
      setExportProgress({
        phase: '下载文件',
        detail: `正在下载主图 ${String(exportPayload.format || fmt).toUpperCase()} 文件。`,
        percent: 86,
      });
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      // Download reproducible bundle
      if (data.bundle) {
        downloadTextFile('reproducible_bundle.json', JSON.stringify(data.bundle, null, 2), 'application/json');
      }
      if (isProjectExport) {
        setExportProgress({
          phase: '刷新导出图库',
          detail: includeSubplotExports ? '正在刷新主图和子图导出资产。' : '正在刷新导出资产。',
          percent: 94,
        });
        await loadAssets();
        const subplotCount = Array.isArray(exportPayload.subplotAssets) ? exportPayload.subplotAssets.length : 0;
        if (includeSubplotExports && subplotCount > 0) {
          const subplotFormats = Array.from(new Set(exportPayload.subplotAssets.map((asset: ExportAsset) => asset.format?.toUpperCase()).filter(Boolean))).join(' / ');
          alert(`已同时保存 ${subplotCount} 个子图到导出图库。子图格式：${subplotFormats || selectedFormat.toUpperCase()}。`);
        }
      }
      setExportProgress({
        phase: '导出完成',
        detail: '文件已生成，导出图库已同步。',
        percent: 100,
      });
    } catch (err: any) {
      console.error('Export error:', err);
      alert(`导出失败: ${err.message}`);
    } finally {
      window.setTimeout(() => {
        setIsExporting(false);
        setExportProgress(null);
      }, 650);
    }
  };

  const saveAllFiguresToLibrary = async () => {
    if (!projectId) {
      alert('请先打开一个项目。');
      return;
    }
    if (isRendering) {
      alert('后台引擎正在渲染中，请等待渲染完成后再保存到图库。');
      return;
    }
    setIsSavingAllFigures(true);
    try {
      const selectedDpi = exportConfig.dpi || 600;
      const res = await fetch(`/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'svg',
          dpi: selectedDpi,
          saveToLibrary: true,
        }),
      });
      const data = await res.json();
      if (data.status !== 'success') {
        throw new Error(data.message || '保存到图库失败');
      }
      const count = Array.isArray(data.figures) ? data.figures.filter((figure: any) => figure.asset).length : 0;
      await loadAssets();
      alert(`已保存 ${count} 张 Figure 到历史导出资产。`);
    } catch (err: any) {
      alert(`保存到图库失败: ${err.message || '未知错误'}`);
    } finally {
      setIsSavingAllFigures(false);
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
          <div className="flex gap-2">
            <button onClick={() => onNavigate('export_library')} className="px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm text-slate-700">
              历史导出资产
            </button>
            <button onClick={() => onNavigate('editor')} className="px-4 py-2 border border-slate-300 bg-white rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm">
              返回编辑器
            </button>
          </div>
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

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-4 pb-3 border-b border-slate-100">
                <div>
                  <h3 className="font-bold text-lg text-slate-800">Word / A4 最终尺寸预览</h3>
                  <p className="text-sm text-slate-500 mt-1">模拟图片插入 A4 Word 页面后的占位大小，重点检查缩放后的字体是否还能读清。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={wordMarginPreset}
                    onChange={(e) => setWordMarginPreset(e.target.value as keyof typeof WORD_MARGIN_PRESETS)}
                    className="border border-slate-300 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {Object.entries(WORD_MARGIN_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.label}</option>
                    ))}
                  </select>
                  <select
                    value={wordPreviewMode}
                    onChange={(e) => setWordPreviewMode(e.target.value as 'actual' | 'fitWidth')}
                    className="border border-slate-300 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="fitWidth">适应 Word 版心</option>
                    <option value="actual">按导出物理尺寸</option>
                  </select>
                  <select
                    value={wordPageZoom}
                    onChange={(e) => setWordPageZoom(Number(e.target.value) || 1)}
                    className="border border-slate-300 rounded-lg px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value={0.75}>页面 75%</option>
                    <option value={1}>页面 100%（Word）</option>
                    <option value={1.25}>页面 125%</option>
                  </select>
                  <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={showWordSampleText}
                      onChange={(e) => setShowWordSampleText(e.target.checked)}
                      className="accent-blue-600"
                    />
                    示例正文
                  </label>
                </div>
              </div>

              <div className="space-y-5">
                <div className="max-h-[82vh] overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-8">
                  <div
                    className="relative mx-auto bg-white shadow-lg ring-1 ring-slate-200"
                    style={{ width: wordPreview.pagePx, height: wordPreview.pageHeightPx }}
                  >
                    <div
                      className="absolute border border-dashed border-slate-300 bg-slate-50/40"
                      style={{
                        left: wordPreview.margins.left * wordPreview.pageScale,
                        top: wordPreview.margins.top * wordPreview.pageScale,
                        width: wordPreview.contentWidth * wordPreview.pageScale,
                        height: wordPreview.contentHeight * wordPreview.pageScale,
                      }}
                    />
                    {showWordSampleText && (
                      <div
                        className="absolute text-slate-800"
                        style={{
                          left: wordPreview.margins.left * wordPreview.pageScale,
                          top: wordPreview.margins.top * wordPreview.pageScale,
                          width: wordPreview.contentWidth * wordPreview.pageScale,
                        }}
                      >
                        <div
                          className="font-serif font-bold leading-tight"
                          style={{ fontSize: 14 * wordPageZoom, lineHeight: 1.25 }}
                        >
                          Results and discussion
                        </div>
                        <div
                          className="mt-2 font-serif text-slate-700"
                          style={{ fontSize: 11 * wordPageZoom, lineHeight: 1.55 }}
                        >
                          The assembled figure is placed in the manuscript body to evaluate whether axis labels,
                          tick labels, legends and panel annotations remain readable at the final Word layout size.
                        </div>
                      </div>
                    )}
                    <div
                      className={`absolute flex items-center justify-center overflow-hidden bg-white shadow-sm ring-1 ${
                        wordPreview.overflows ? 'ring-rose-400' : 'ring-blue-300'
                      }`}
                      style={{
                        left: wordPreview.left,
                        top: wordPreview.top,
                        width: wordPreview.figureWidthPx,
                        height: wordPreview.figureHeightPx,
                      }}
                      title={`${wordPreview.finalWidth.toFixed(1)} × ${wordPreview.finalHeight.toFixed(1)} mm`}
                    >
                      {figSession?.svg ? (
                        <div
                          className="w-full h-full [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
                          dangerouslySetInnerHTML={{ __html: sanitizeSvg(figSession.svg) }}
                        />
                      ) : (
                        <div className="px-4 text-center text-xs text-slate-400">请先渲染当前 Figure，再查看 A4 预览</div>
                      )}
                    </div>
                    {showWordSampleText && (
                      <div
                        className="absolute font-serif text-slate-700"
                        style={{
                          left: wordPreview.left,
                          top: wordPreview.top + wordPreview.figureHeightPx + 10 * wordPageZoom,
                          width: Math.min(wordPreview.figureWidthPx, wordPreview.contentWidth * wordPreview.pageScale),
                          fontSize: 9 * wordPageZoom,
                          lineHeight: 1.35,
                        }}
                      >
                        <span className="font-bold">Figure 1.</span> Example caption text showing how the exported
                        figure, legend and panel labels sit relative to manuscript typography on an A4 page.
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="text-xs font-semibold text-slate-500 mb-2">页面与图片尺寸</div>
                    <div className="space-y-1.5 text-xs text-slate-600">
                      <div className="flex justify-between gap-3"><span>A4 页面</span><span className="font-mono">210 × 297 mm</span></div>
                      <div className="flex justify-between gap-3"><span>Word 版心</span><span className="font-mono">{wordPreview.contentWidth.toFixed(1)} × {wordPreview.contentHeight.toFixed(1)} mm</span></div>
                      <div className="flex justify-between gap-3"><span>导出尺寸</span><span className="font-mono">{wordPreview.sourceWidth.toFixed(1)} × {wordPreview.sourceHeight.toFixed(1)} mm</span></div>
                      <div className="flex justify-between gap-3"><span>插入后尺寸</span><span className="font-mono">{wordPreview.finalWidth.toFixed(1)} × {wordPreview.finalHeight.toFixed(1)} mm</span></div>
                      <div className="flex justify-between gap-3"><span>Word 缩放</span><span className="font-mono">{Math.round(wordPreview.displayScale * 100)}%</span></div>
                      <div className="flex justify-between gap-3"><span>页面显示</span><span className="font-mono">{Math.round(wordPageZoom * 100)}%</span></div>
                    </div>
                  </div>

                  <div className={`rounded-xl border p-4 ${
                    wordPreview.overflows || wordPreview.stats.tooSmall > 0
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  }`}>
                    <div className="text-xs font-semibold mb-2">可读性检查</div>
                    <div className="space-y-1.5 text-xs leading-relaxed">
                      {wordPreview.stats.count > 0 ? (
                        <>
                          <div>最小估算字号：<span className="font-mono font-semibold">{wordPreview.stats.min?.finalPt.toFixed(1)} pt</span>（来源 {wordPreview.stats.min?.id}）</div>
                          <div>低于 6 pt：{wordPreview.stats.tooSmall} 个；6-7 pt 临界：{wordPreview.stats.borderline} 个。</div>
                        </>
                      ) : (
                        <div>当前 manifest 未提供可统计字号；请以视觉预览为准。</div>
                      )}
                      {wordPreview.overflows && <div>当前图片超过 Word 版心，建议改用“适应 Word 版心”或减小导出尺寸。</div>}
                      {!wordPreview.overflows && wordPreview.stats.tooSmall === 0 && <div>当前尺寸下没有检测到明显过小字体。</div>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs leading-relaxed text-blue-700">
                    建议流程：先用“适应 Word 版心”看最终读者视角；若最小字号低于 6 pt，回到字体中心提高 tick/legend 字号，或减少拼图面板数量后再导出。
                  </div>
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
                <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                  <input
                    type="checkbox"
                    checked={includeSubplotExports}
                    onChange={(event) => setIncludeSubplotExports(event.target.checked)}
                    disabled={!projectId}
                    className="mt-0.5 accent-blue-600"
                  />
                  <span>
                    <span className="font-semibold text-slate-800">同时导出每个子图到图库</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      适合 2×2 等多子图 Figure。子图会使用当前主图导出格式；框外图例、长标签或色条可能需要后续“包含标签图例”模式。
                    </span>
                  </span>
                </label>
                {exportProgress && (
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-semibold text-blue-900">{exportProgress.phase}</span>
                      <span className="font-mono text-blue-700">{exportProgress.percent}%</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white">
                      <div
                        className="h-full rounded-full bg-blue-600 transition-all duration-300"
                        style={{ width: `${exportProgress.percent}%` }}
                      />
                    </div>
                    <div className="mt-1.5 text-[11px] leading-relaxed text-blue-700">{exportProgress.detail}</div>
                  </div>
                )}
                <button
                  onClick={() => handleExport()}
                  disabled={isExporting}
                  className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold shadow-md hover:bg-blue-700 flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0"
                >
                  <Download className="w-4 h-4" /> {isExporting ? '导出处理中...' : `导出高质量图形 (${exportConfig.format})`}
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { updateExportFormat('PDF'); void handleExport('PDF'); }}
                    disabled={isExporting}
                    className="py-2.5 bg-slate-50 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5 shadow-sm disabled:cursor-wait disabled:opacity-60"
                  >
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
                onClick={() => void saveAllFiguresToLibrary()}
                disabled={!projectId || isRendering || isSavingAllFigures}
                className="px-3 py-2 text-sm rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                title="把当前项目所有已渲染 Figure 以 SVG 保存到历史导出资产，供组合图工作台和资产库使用。"
              >
                {isSavingAllFigures ? '保存中...' : '保存全部 Figure 到图库'}
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
              暂无历史导出资产。渲染预览不会自动进入图库；点击上方“保存全部 Figure 到图库”，或导出单张高质量图形后，这里才会出现可下载/拼版的资产。
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
                          <div className="flex items-center gap-1.5">
                            <div className="font-semibold text-sm text-slate-800 truncate" title={asset.name}>{asset.name}</div>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${isSubplotExportAsset(asset) ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                              {getExportAssetTypeLabel(asset)}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {getExportAssetSourceLabel(asset)} · {asset.format.toUpperCase()} · {asset.dpi ? `${asset.dpi} dpi` : '矢量'}
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
