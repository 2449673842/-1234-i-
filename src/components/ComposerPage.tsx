import { useEffect, useMemo, useState, useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { ArrowLeft, Download, FileImage, RefreshCw, Grid, Layers, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
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
  tags: string[];
  createdAt: string;
  sizeBytes?: number;
  metadata?: any;
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

const LABEL_FAMILIES = [
  'Arial, sans-serif',
  'Times New Roman, serif',
  'Helvetica, Arial, sans-serif',
  'SimHei, Microsoft YaHei, sans-serif',
];

function safeCssText(value: string) {
  return value.replace(/[<>{}"']/g, '');
}

function parseSvgViewport(svg: string | null | undefined): { width: number; height: number } {
  if (!svg) return { width: 1, height: 1 };
  const viewBox = svg.match(/viewBox=["']([^"']+)["']/i)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = Number(svg.match(/\bwidth=["']([\d.]+)/i)?.[1]);
  const height = Number(svg.match(/\bheight=["']([\d.]+)/i)?.[1]);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return { width: 1, height: 1 };
}

function getPanelSvgScale(panel: ComposerPanel, asset: ExportAsset | undefined): number {
  const viewport = parseSvgViewport(asset?.thumbnailSvg);
  const scale = Math.min(panel.width / viewport.width, panel.height / viewport.height);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function compensateForPanelScale(value: number, scale: number): number {
  const safeScale = Math.max(0.001, scale);
  return Math.max(0.1, value / safeScale);
}

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

function downloadBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function svgToPngBlob(svg: string, width: number, height: number, dpi: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const scale = Math.max(1, dpi / 96);
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('浏览器 Canvas 不可用');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) reject(new Error('PNG 生成失败'));
          else resolve(blob);
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 预览无法加载为图片'));
    };
    image.src = url;
  });
}

const JOURNAL_STYLE_PRESETS = {
  compact: {
    label: '紧凑投稿',
    description: '适合 4-6 图：压缩间距、统一小字号和细线。',
    labelFontSize: 12,
    title: 9,
    axisLabel: 8,
    tick: 6.5,
    legend: 6.5,
    axisLine: 0.8,
    tickLine: 0.6,
    panelBorder: 0,
    gapX: 18,
    gapY: 28,
  },
  balanced: {
    label: '标准论文',
    description: '适合常规 2-4 图：字号清楚，线条不过重。',
    labelFontSize: 14,
    title: 10,
    axisLabel: 9,
    tick: 7.5,
    legend: 7.5,
    axisLine: 1,
    tickLine: 0.8,
    panelBorder: 0,
    gapX: 26,
    gapY: 36,
  },
  presentation: {
    label: '展示清晰',
    description: '适合汇报/预览：字号更大，线条更醒目。',
    labelFontSize: 18,
    title: 13,
    axisLabel: 11,
    tick: 9,
    legend: 9,
    axisLine: 1.4,
    tickLine: 1,
    panelBorder: 1,
    gapX: 34,
    gapY: 44,
  },
} as const;

export function ComposerPage({
  projectId,
  onNavigate,
  onEditSourceFigure,
  canEditSourceFigure,
}: {
  projectId: string | null;
  onNavigate: (view: ViewState) => void;
  onEditSourceFigure?: (figureId: string) => boolean;
  canEditSourceFigure?: (figureId: string) => boolean;
}) {
  const [assets, setAssets] = useState<ExportAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [panels, setPanels] = useState<ComposerPanel[]>([]);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [panelWidth, setPanelWidth] = useState(280);
  const [panelHeight, setPanelHeight] = useState(210);
  const [gapX, setGapX] = useState(34);
  const [gapY, setGapY] = useState(44);
  const [globalFontFamily, setGlobalFontFamily] = useState(LABEL_FAMILIES[0]);
  const [labelFontSize, setLabelFontSize] = useState(18);
  const [labelColor, setLabelColor] = useState('#0f172a');
  const [applyInnerFont, setApplyInnerFont] = useState(false);
  const [innerFontSize, setInnerFontSize] = useState(10);
  const [innerFontColor, setInnerFontColor] = useState('#111827');
  const [applySemanticTextStyle, setApplySemanticTextStyle] = useState(false);
  const [sourceTitleFontSize, setSourceTitleFontSize] = useState(12);
  const [sourceAxisLabelFontSize, setSourceAxisLabelFontSize] = useState(10);
  const [sourceTickFontSize, setSourceTickFontSize] = useState(8);
  const [sourceLegendFontSize, setSourceLegendFontSize] = useState(8);
  const [sourceTextColor, setSourceTextColor] = useState('#111827');

  // Outer Border & Radius controls
  const [panelBorderWidth, setPanelBorderWidth] = useState(1);
  const [panelBorderColor, setPanelBorderColor] = useState('#cbd5e1');
  const [panelBorderRadius, setPanelBorderRadius] = useState(0); // 0px default for academic publication compliance

  // Inner Line Width controls
  const [applyInnerLine, setApplyInnerLine] = useState(false);
  const [innerLineWidth, setInnerLineWidth] = useState(1.0);
  const [innerLineColor, setInnerLineColor] = useState('#000000');
  const [applyAxisElementStyle, setApplyAxisElementStyle] = useState(false);
  const [axisLineWidth, setAxisLineWidth] = useState(1.0);
  const [axisLineColor, setAxisLineColor] = useState('#000000');
  const [tickLineWidth, setTickLineWidth] = useState(0.8);
  const [tickLineColor, setTickLineColor] = useState('#000000');
  const [formats, setFormats] = useState<string[]>(['svg']);
  const [dpi, setDpi] = useState(600);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [gridSnap, setGridSnap] = useState(true);
  const [snapStep, setSnapStep] = useState(10);
  const [historyStack, setHistoryStack] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [leftTab, setLeftTab] = useState<'single' | 'composite'>('single');
  const [zoom, setZoom] = useState(100);
  const [focusCanvas, setFocusCanvas] = useState(false);
  const [rightTab, setRightTab] = useState<'layout' | 'fonts' | 'output'>('layout');
  const [journalPreset, setJournalPreset] = useState<string>('custom');
  const [projectsList, setProjectsList] = useState<{ id: string; name: string }[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>(projectId || '');
  const hasInitializedHistoryRef = useRef(false);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);

  const figureAssets = useMemo(() => {
    return assets.filter(a => a.metadata?.kind !== 'composite' && !a.tags?.includes('composite'));
  }, [assets]);

  const compositeAssets = useMemo(() => {
    return assets.filter(a => a.metadata?.kind === 'composite' || a.tags?.includes('composite'));
  }, [assets]);

  const selectedAssets = useMemo(
    () => selectedAssetIds.map(id => assets.find(asset => asset.assetId === id)).filter(Boolean) as ExportAsset[],
    [assets, selectedAssetIds]
  );

  const activePanel = useMemo(
    () => panels.find(panel => panel.assetId === activeAssetId) || null,
    [activeAssetId, panels]
  );

  const activePanelAsset = useMemo(
    () => activePanel ? assets.find(asset => asset.assetId === activePanel.assetId) || null : null,
    [activePanel, assets]
  );

  const activeSourceFigureId = activePanelAsset?.figureId && activePanelAsset.figureId !== 'composite'
    ? activePanelAsset.figureId
    : null;
  const canOpenActiveSourceFigure = Boolean(
    activeSourceFigureId && (!canEditSourceFigure || canEditSourceFigure(activeSourceFigureId))
  );

  const canvas = useMemo(() => {
    const count = Math.max(panels.length, selectedAssetIds.length, 2);
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    return {
      width: cols * panelWidth + (cols - 1) * gapX,
      height: rows * panelHeight + (rows - 1) * gapY + labelFontSize + 8,
    };
  }, [gapX, gapY, labelFontSize, panelHeight, panelWidth, panels.length, selectedAssetIds.length]);

  const getSnapshot = (currentPanels: ComposerPanel[], selectedIds: string[], overrides: Record<string, unknown> = {}) => {
    return {
      panels: JSON.parse(JSON.stringify(currentPanels)),
      panelWidth,
      panelHeight,
      gapX,
      gapY,
      labelFontSize,
      globalFontFamily,
      labelColor,
      applyInnerFont,
      innerFontSize,
      innerFontColor,
      applySemanticTextStyle,
      sourceTitleFontSize,
      sourceAxisLabelFontSize,
      sourceTickFontSize,
      sourceLegendFontSize,
      sourceTextColor,
      selectedAssetIds: selectedIds,
      panelBorderWidth,
      panelBorderColor,
      panelBorderRadius,
      applyInnerLine,
      innerLineWidth,
      innerLineColor,
      applyAxisElementStyle,
      axisLineWidth,
      axisLineColor,
      tickLineWidth,
      tickLineColor,
      ...overrides,
    };
  };

  const pushHistory = (currentPanels: ComposerPanel[], overrides: Record<string, unknown> = {}) => {
    const snapshot = getSnapshot(currentPanels, selectedAssetIds, overrides);
    if (historyStack.length > 0 && historyIndex >= 0) {
      const top = historyStack[historyIndex];
      if (JSON.stringify(top) === JSON.stringify(snapshot)) {
        return;
      }
    }
    setHistoryStack(prev => {
      const next = prev.slice(0, historyIndex + 1);
      return [...next, snapshot].slice(-50);
    });
    setHistoryIndex(prev => prev + 1);
  };

  const updateActivePanel = (patch: Partial<ComposerPanel>) => {
    if (!activeAssetId) return;
    setPanels(prev => prev.map(panel => {
      if (panel.assetId !== activeAssetId) return panel;
      const next = { ...panel, ...patch };
      return {
        ...next,
        width: Math.max(20, next.width),
        height: Math.max(20, next.height),
        x: Math.max(0, next.x),
        y: Math.max(0, next.y),
      };
    }));
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const idx = historyIndex - 1;
      setHistoryIndex(idx);
      restoreSnapshot(historyStack[idx]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < historyStack.length - 1) {
      const idx = historyIndex + 1;
      setHistoryIndex(idx);
      restoreSnapshot(historyStack[idx]);
    }
  };

  const restoreSnapshot = (snapshot: any) => {
    if (!snapshot) return;
    setPanels(snapshot.panels);
    setPanelWidth(snapshot.panelWidth);
    setPanelHeight(snapshot.panelHeight);
    setGapX(snapshot.gapX);
    setGapY(snapshot.gapY);
    setLabelFontSize(snapshot.labelFontSize);
    setGlobalFontFamily(snapshot.globalFontFamily || snapshot.labelFontFamily || LABEL_FAMILIES[0]);
    setLabelColor(snapshot.labelColor);
    setApplyInnerFont(snapshot.applyInnerFont);
    setInnerFontSize(snapshot.innerFontSize);
    setInnerFontColor(snapshot.innerFontColor);
    setApplySemanticTextStyle(snapshot.applySemanticTextStyle || false);
    setSourceTitleFontSize(snapshot.sourceTitleFontSize !== undefined ? snapshot.sourceTitleFontSize : 12);
    setSourceAxisLabelFontSize(snapshot.sourceAxisLabelFontSize !== undefined ? snapshot.sourceAxisLabelFontSize : 10);
    setSourceTickFontSize(snapshot.sourceTickFontSize !== undefined ? snapshot.sourceTickFontSize : 8);
    setSourceLegendFontSize(snapshot.sourceLegendFontSize !== undefined ? snapshot.sourceLegendFontSize : 8);
    setSourceTextColor(snapshot.sourceTextColor || '#111827');
    setSelectedAssetIds(snapshot.selectedAssetIds || []);

    // Borders & Lines
    setPanelBorderWidth(snapshot.panelBorderWidth !== undefined ? snapshot.panelBorderWidth : 1);
    setPanelBorderColor(snapshot.panelBorderColor || '#cbd5e1');
    setPanelBorderRadius(snapshot.panelBorderRadius !== undefined ? snapshot.panelBorderRadius : 0);
    setApplyInnerLine(snapshot.applyInnerLine || false);
    setInnerLineWidth(snapshot.innerLineWidth !== undefined ? snapshot.innerLineWidth : 1.0);
    setInnerLineColor(snapshot.innerLineColor || '#000000');
    setApplyAxisElementStyle(snapshot.applyAxisElementStyle || false);
    setAxisLineWidth(snapshot.axisLineWidth !== undefined ? snapshot.axisLineWidth : 1.0);
    setAxisLineColor(snapshot.axisLineColor || '#000000');
    setTickLineWidth(snapshot.tickLineWidth !== undefined ? snapshot.tickLineWidth : 0.8);
    setTickLineColor(snapshot.tickLineColor || '#000000');
  };

  const alignLeft = () => {
    if (panels.length <= 1) return;
    const minX = Math.min(...panels.map(p => p.x));
    const next = panels.map(p => ({ ...p, x: minX }));
    setPanels(next);
    pushHistory(next);
  };

  const alignRight = () => {
    if (panels.length <= 1) return;
    const maxX = Math.max(...panels.map(p => p.x + p.width));
    const next = panels.map(p => ({ ...p, x: maxX - p.width }));
    setPanels(next);
    pushHistory(next);
  };

  const alignTop = () => {
    if (panels.length <= 1) return;
    const minY = Math.min(...panels.map(p => p.y));
    const next = panels.map(p => ({ ...p, y: minY }));
    setPanels(next);
    pushHistory(next);
  };

  const alignBottom = () => {
    if (panels.length <= 1) return;
    const maxY = Math.max(...panels.map(p => p.y + p.height));
    const next = panels.map(p => ({ ...p, y: maxY - p.height }));
    setPanels(next);
    pushHistory(next);
  };

  const distributeHorizontally = () => {
    if (panels.length <= 2) return;
    const sorted = [...panels].sort((a, b) => a.x - b.x);
    const minX = sorted[0].x;
    const lastPanel = sorted[sorted.length - 1];
    const maxX = lastPanel.x;
    const totalWidthRange = maxX - minX;
    if (totalWidthRange <= 0) return;
    const step = totalWidthRange / (sorted.length - 1);
    const next = panels.map(p => {
      const idx = sorted.findIndex(s => s.assetId === p.assetId);
      return { ...p, x: Math.round(minX + idx * step) };
    });
    setPanels(next);
    pushHistory(next);
  };

  const distributeVertically = () => {
    if (panels.length <= 2) return;
    const sorted = [...panels].sort((a, b) => a.y - b.y);
    const minY = sorted[0].y;
    const lastPanel = sorted[sorted.length - 1];
    const maxY = lastPanel.y;
    const totalHeightRange = maxY - minY;
    if (totalHeightRange <= 0) return;
    const step = totalHeightRange / (sorted.length - 1);
    const next = panels.map(p => {
      const idx = sorted.findIndex(s => s.assetId === p.assetId);
      return { ...p, y: Math.round(minY + idx * step) };
    });
    setPanels(next);
    pushHistory(next);
  };

  const loadSavedComposition = (asset: ExportAsset) => {
    const layout = asset.metadata?.layout as any;
    if (!layout || !layout.panels) {
      alert('该历史组合图不包含可二次编辑的排版数据。');
      return;
    }
    setPanelWidth(layout.panelWidth || layout.panels[0]?.width || 280);
    setPanelHeight(layout.panelHeight || layout.panels[0]?.height || 210);
    setGapX(layout.gapX || 34);
    setGapY(layout.gapY || 44);
    setLabelFontSize(layout.labelFontSize || 18);
    setGlobalFontFamily(layout.globalFontFamily || layout.labelFontFamily || LABEL_FAMILIES[0]);
    setLabelColor(layout.labelColor || '#0f172a');
    setApplyInnerFont(layout.applyInnerFont || false);
    setInnerFontSize(layout.innerFontSize || 10);
    setInnerFontColor(layout.innerFontColor || '#111827');
    setApplySemanticTextStyle(layout.applySemanticTextStyle || false);
    setSourceTitleFontSize(layout.sourceTitleFontSize !== undefined ? layout.sourceTitleFontSize : 12);
    setSourceAxisLabelFontSize(layout.sourceAxisLabelFontSize !== undefined ? layout.sourceAxisLabelFontSize : 10);
    setSourceTickFontSize(layout.sourceTickFontSize !== undefined ? layout.sourceTickFontSize : 8);
    setSourceLegendFontSize(layout.sourceLegendFontSize !== undefined ? layout.sourceLegendFontSize : 8);
    setSourceTextColor(layout.sourceTextColor || '#111827');

    setPanelBorderWidth(layout.panelBorderWidth !== undefined ? layout.panelBorderWidth : 1);
    setPanelBorderColor(layout.panelBorderColor || '#cbd5e1');
    setPanelBorderRadius(layout.panelBorderRadius !== undefined ? layout.panelBorderRadius : 0);
    setApplyInnerLine(layout.applyInnerLine || false);
    setInnerLineWidth(layout.innerLineWidth !== undefined ? layout.innerLineWidth : 1.0);
    setInnerLineColor(layout.innerLineColor || '#000000');
    setApplyAxisElementStyle(layout.applyAxisElementStyle || false);
    setAxisLineWidth(layout.axisLineWidth !== undefined ? layout.axisLineWidth : 1.0);
    setAxisLineColor(layout.axisLineColor || '#000000');
    setTickLineWidth(layout.tickLineWidth !== undefined ? layout.tickLineWidth : 0.8);
    setTickLineColor(layout.tickLineColor || '#000000');

    setSelectedAssetIds(layout.sourceAssetIds || layout.panels.map((p: any) => p.assetId));
    setPanels(layout.panels);
    setActiveAssetId(layout.panels[0]?.assetId || null);

    const initialSnapshot = {
      panels: JSON.parse(JSON.stringify(layout.panels)),
      panelWidth: layout.panelWidth || layout.panels[0]?.width || 280,
      panelHeight: layout.panelHeight || layout.panels[0]?.height || 210,
      gapX: layout.gapX || 34,
      gapY: layout.gapY || 44,
      labelFontSize: layout.labelFontSize || 18,
      globalFontFamily: layout.globalFontFamily || layout.labelFontFamily || LABEL_FAMILIES[0],
      labelColor: layout.labelColor || '#0f172a',
      applyInnerFont: layout.applyInnerFont || false,
      innerFontSize: layout.innerFontSize || 10,
      innerFontColor: layout.innerFontColor || '#111827',
      applySemanticTextStyle: layout.applySemanticTextStyle || false,
      sourceTitleFontSize: layout.sourceTitleFontSize !== undefined ? layout.sourceTitleFontSize : 12,
      sourceAxisLabelFontSize: layout.sourceAxisLabelFontSize !== undefined ? layout.sourceAxisLabelFontSize : 10,
      sourceTickFontSize: layout.sourceTickFontSize !== undefined ? layout.sourceTickFontSize : 8,
      sourceLegendFontSize: layout.sourceLegendFontSize !== undefined ? layout.sourceLegendFontSize : 8,
      sourceTextColor: layout.sourceTextColor || '#111827',
      selectedAssetIds: layout.sourceAssetIds || layout.panels.map((p: any) => p.assetId),
      panelBorderWidth: layout.panelBorderWidth !== undefined ? layout.panelBorderWidth : 1,
      panelBorderColor: layout.panelBorderColor || '#cbd5e1',
      panelBorderRadius: layout.panelBorderRadius !== undefined ? layout.panelBorderRadius : 0,
      applyInnerLine: layout.applyInnerLine || false,
      innerLineWidth: layout.innerLineWidth !== undefined ? layout.innerLineWidth : 1.0,
      innerLineColor: layout.innerLineColor || '#000000',
      applyAxisElementStyle: layout.applyAxisElementStyle || false,
      axisLineWidth: layout.axisLineWidth !== undefined ? layout.axisLineWidth : 1.0,
      axisLineColor: layout.axisLineColor || '#000000',
      tickLineWidth: layout.tickLineWidth !== undefined ? layout.tickLineWidth : 0.8,
      tickLineColor: layout.tickLineColor || '#000000',
    };
    setHistoryStack([initialSnapshot]);
    setHistoryIndex(0);
  };

  useEffect(() => {
    if (panels.length > 0 && !hasInitializedHistoryRef.current) {
      hasInitializedHistoryRef.current = true;
      const initialSnapshot = {
        panels: JSON.parse(JSON.stringify(panels)),
        panelWidth,
        panelHeight,
        gapX,
        gapY,
        labelFontSize,
        globalFontFamily,
        labelColor,
        applyInnerFont,
        innerFontSize,
        innerFontColor,
        applySemanticTextStyle,
        sourceTitleFontSize,
        sourceAxisLabelFontSize,
        sourceTickFontSize,
        sourceLegendFontSize,
        sourceTextColor,
        selectedAssetIds,
        panelBorderWidth,
        panelBorderColor,
        panelBorderRadius,
        applyInnerLine,
        innerLineWidth,
        innerLineColor,
        applyAxisElementStyle,
        axisLineWidth,
        axisLineColor,
        tickLineWidth,
        tickLineColor,
      };
      setHistoryStack([initialSnapshot]);
      setHistoryIndex(0);
    }
  }, [panels]);

  useEffect(() => {
    const loadProjects = async () => {
      try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        if (data.status === 'success') {
          setProjectsList(data.projects || []);
          if (!projectId && data.projects?.length > 0 && !activeProjectId) {
            setActiveProjectId(data.projects[0].id);
          }
        }
      } catch (e) {
        console.error('加载项目列表失败:', e);
      }
    };
    void loadProjects();
  }, [projectId]);

  const loadAssets = async () => {
    const projId = activeProjectId || projectId;
    if (!projId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/projects/${projId}/export-assets`);
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '导出图库加载失败');
      setAssets(data.assets || []);
    } catch (e: any) {
      console.error(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeProjectId || projectId) {
      void loadAssets();
    }
  }, [activeProjectId, projectId]);

  const fitZoom = () => {
    const viewport = canvasViewportRef.current;
    if (!viewport || canvas.width <= 0 || canvas.height <= 0) return;
    const padding = 32;
    const availableWidth = Math.max(80, viewport.clientWidth - padding);
    const availableHeight = Math.max(80, viewport.clientHeight - padding);
    const zoomW = (availableWidth / canvas.width) * 100;
    const zoomH = (availableHeight / canvas.height) * 100;
    const newZoom = Math.max(10, Math.min(400, Math.floor(Math.min(zoomW, zoomH))));
    setZoom(newZoom);
  };

  useEffect(() => {
    if (panels.length === 0) return;
    const frame = window.requestAnimationFrame(() => fitZoom());
    return () => window.cancelAnimationFrame(frame);
  }, [canvas.width, canvas.height, panels.length, focusCanvas]);

  useEffect(() => {
    const handleResize = () => fitZoom();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [canvas.width, canvas.height]);

  const handleApplyJournalPreset = (preset: string) => {
    setJournalPreset(preset);
    if (preset === 'custom') return;

    let targetWidth = 600;
    if (preset === 'nature_single') targetWidth = 336;
    else if (preset === 'nature_double') targetWidth = 692;
    else if (preset === 'cell_page') targetWidth = 658;
    else if (preset === 'pnas_single') targetWidth = 328;
    else if (preset === 'pnas_double') targetWidth = 672;

    const count = Math.max(panels.length, selectedAssetIds.length, 2);
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;

    const newPanelWidth = Math.max(40, Math.floor((targetWidth - (cols - 1) * gapX) / cols));
    setPanelWidth(newPanelWidth);

    const ratio = panelWidth > 0 ? panelHeight / panelWidth : 0.75;
    const newPanelHeight = Math.round(newPanelWidth * ratio);
    setPanelHeight(newPanelHeight);

    const next = panels.map((panel, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      return {
        ...panel,
        width: newPanelWidth,
        height: newPanelHeight,
        x: col * newPanelWidth + col * gapX,
        y: row * newPanelHeight + row * gapY + labelFontSize + 8
      };
    });

    setPanels(next);
    pushHistory(next);
  };

  const buildDefaultPanels = (items: ExportAsset[]) => {
    const cols = items.length <= 2 ? items.length : items.length <= 4 ? 2 : 3;
    return items.map((asset, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        assetId: asset.assetId,
        x: col * (panelWidth + gapX),
        y: row * (panelHeight + gapY) + labelFontSize + 8,
        width: panelWidth,
        height: panelHeight,
        label: `(${String.fromCharCode(97 + index)})`,
      };
    });
  };

  const startLayout = () => {
    if (![2, 4, 6].includes(selectedAssets.length)) {
      alert('请选择 2、4 或 6 张图进入组合排版。');
      return;
    }
    const next = buildDefaultPanels(selectedAssets);
    setPanels(next);
    setActiveAssetId(next[0]?.assetId || null);

    const initialSnapshot = getSnapshot(next, selectedAssetIds);
    setHistoryStack([initialSnapshot]);
    setHistoryIndex(0);
  };

  const applyUniformSize = () => {
    const next = buildDefaultPanels(panels.map(panel => assets.find(asset => asset.assetId === panel.assetId)).filter(Boolean) as ExportAsset[]);
    setPanels(next);
    pushHistory(next);
  };

  const relabelPanels = (format: 'paren-lower' | 'plain-lower' | 'paren-upper' | 'upper-dot' = 'paren-lower') => {
    const next = panels.map((panel, index) => {
      const lower = String.fromCharCode(97 + index);
      const upper = lower.toUpperCase();
      const label = format === 'plain-lower'
        ? lower
        : format === 'paren-upper'
          ? `(${upper})`
          : format === 'upper-dot'
            ? `${upper}.`
            : `(${lower})`;
      return { ...panel, label };
    });
    setPanels(next);
    pushHistory(next);
  };

  const applyJournalStylePreset = (presetKey: keyof typeof JOURNAL_STYLE_PRESETS) => {
    const preset = JOURNAL_STYLE_PRESETS[presetKey];
    setLabelFontSize(preset.labelFontSize);
    setGlobalFontFamily('Arial, sans-serif');
    setLabelColor('#111827');
    setApplySemanticTextStyle(true);
    setSourceTitleFontSize(preset.title);
    setSourceAxisLabelFontSize(preset.axisLabel);
    setSourceTickFontSize(preset.tick);
    setSourceLegendFontSize(preset.legend);
    setSourceTextColor('#111827');
    setApplyAxisElementStyle(true);
    setAxisLineWidth(preset.axisLine);
    setTickLineWidth(preset.tickLine);
    setAxisLineColor('#000000');
    setTickLineColor('#000000');
    setPanelBorderWidth(preset.panelBorder);
    setPanelBorderColor('#cbd5e1');
    setPanelBorderRadius(0);
    setGapX(preset.gapX);
    setGapY(preset.gapY);
    const next = panels.map((panel, index) => ({
      ...panel,
      label: `(${String.fromCharCode(97 + index)})`,
    }));
    setPanels(next);
    pushHistory(next, {
      labelFontSize: preset.labelFontSize,
      globalFontFamily: 'Arial, sans-serif',
      labelColor: '#111827',
      applySemanticTextStyle: true,
      sourceTitleFontSize: preset.title,
      sourceAxisLabelFontSize: preset.axisLabel,
      sourceTickFontSize: preset.tick,
      sourceLegendFontSize: preset.legend,
      sourceTextColor: '#111827',
      applyAxisElementStyle: true,
      axisLineWidth: preset.axisLine,
      tickLineWidth: preset.tickLine,
      axisLineColor: '#000000',
      tickLineColor: '#000000',
      panelBorderWidth: preset.panelBorder,
      panelBorderColor: '#cbd5e1',
      panelBorderRadius: 0,
      gapX: preset.gapX,
      gapY: preset.gapY,
    });
  };

  const toggleFormat = (format: string) => {
    setFormats(prev => {
      const next = prev.includes(format) ? prev.filter(item => item !== format) : [...prev, format];
      return next.length > 0 ? next : ['svg'];
    });
  };

  const handlePointerUp = () => {
    if (dragState) {
      pushHistory(panels);
    }
    setDragState(null);
  };

  const movePanel = (assetId: string, direction: -1 | 1) => {
    setPanels(prev => {
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

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>, panel: ComposerPanel) => {
    event.preventDefault();
    setActiveAssetId(panel.assetId);
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

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragState) return;
    const zoomFactor = zoom / 100;
    const dx = (event.clientX - dragState.startX) / zoomFactor;
    const dy = (event.clientY - dragState.startY) / zoomFactor;
    setPanels(prev => prev.map(panel => {
      if (panel.assetId !== dragState.assetId) return panel;
      let newX = dragState.panelX + dx;
      let newY = dragState.panelY + dy;
      if (gridSnap) {
        newX = Math.round(newX / snapStep) * snapStep;
        newY = Math.round(newY / snapStep) * snapStep;
      }
      return {
        ...panel,
        x: Math.max(0, Math.min(canvas.width - panel.width, newX)),
        y: Math.max(labelFontSize + 8, Math.min(canvas.height - panel.height, newY)),
      };
    }));
  };

  const saveComposition = async () => {
    const projId = activeProjectId || projectId;
    if (!projId || panels.length === 0) return;
    setIsSaving(true);
    try {
      const wantsSvg = formats.includes('svg');
      const wantsPng = formats.includes('png');
      const unsupported = formats.filter(format => !['svg', 'png'].includes(format));
      const res = await fetch(`/api/projects/${projId}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: panels.map(panel => panel.assetId),
          formats: ['svg'],
          dpi,
          name: `组合图_${panels.length}张`,
          layout: {
            width: canvas.width,
            height: canvas.height,
            panelWidth,
            panelHeight,
            gapX,
            gapY,
            labelFontSize,
            globalFontFamily,
            labelColor,
            applyInnerFont,
            innerFontSize,
            innerFontColor,
            applySemanticTextStyle,
            sourceTitleFontSize,
            sourceAxisLabelFontSize,
            sourceTickFontSize,
            sourceLegendFontSize,
            sourceTextColor,
            panelBorderWidth,
            panelBorderColor,
            panelBorderRadius,
            applyInnerLine,
            innerLineWidth,
            innerLineColor,
            applyAxisElementStyle,
            axisLineWidth,
            axisLineColor,
            tickLineWidth,
            tickLineColor,
            panels,
            sourceAssetIds: panels.map(panel => panel.assetId),
          },
        }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '保存组合图失败');
      if (!wantsSvg && data.asset?.assetId) {
        await fetch(`/api/projects/${projId}/export-assets`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetIds: [data.asset.assetId] }),
        });
      }
      if (wantsSvg && data.svg) downloadTextFile(`${data.asset?.name || 'composite'}.svg`, data.svg, 'image/svg+xml');
      let savedCount = wantsSvg ? 1 : 0;
      if (wantsPng && data.svg) {
        const pngBlob = await svgToPngBlob(data.svg, canvas.width, canvas.height, dpi);
        downloadBlobFile(`${data.asset?.name || 'composite'}.png`, pngBlob);
        const binaryB64 = await blobToBase64(pngBlob);
        const importRes = await fetch(`/api/projects/${projId}/export-assets/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.asset?.name || `组合图_${panels.length}张`,
            figureId: 'composite',
            format: 'png',
            dpi,
            binary_b64: binaryB64,
            thumbnailSvg: data.svg,
            metadata: {
              kind: 'composite',
              createdBy: 'browser-svg-canvas',
              sourceAssetIds: panels.map(panel => panel.assetId),
              layout: {
                width: canvas.width,
                height: canvas.height,
                panelWidth,
                panelHeight,
                gapX,
                gapY,
                labelFontSize,
                globalFontFamily,
                labelColor,
                applyInnerFont,
                innerFontSize,
                innerFontColor,
                applySemanticTextStyle,
                sourceTitleFontSize,
                sourceAxisLabelFontSize,
                sourceTickFontSize,
                sourceLegendFontSize,
                sourceTextColor,
                panelBorderWidth,
                panelBorderColor,
                panelBorderRadius,
                applyInnerLine,
                innerLineWidth,
                innerLineColor,
                applyAxisElementStyle,
                axisLineWidth,
                axisLineColor,
                tickLineWidth,
                tickLineColor,
                panels,
                sourceAssetIds: panels.map(panel => panel.assetId),
              },
            },
            tags: ['composite'],
          }),
        });
        const importData = await importRes.json();
        if (importData.status !== 'success') throw new Error(importData.message || 'PNG 保存到图库失败');
        savedCount += 1;
      }
      await loadAssets();
      const unsupportedNote = unsupported.length > 0 ? `\nPDF/TIFF 将在后续无 Cairo 服务端渲染路径接入后开放。` : '';
      alert(`已保存 ${savedCount} 个组合图导出资产。${unsupportedNote}`);
    } catch (err: any) {
      alert(`保存失败: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex-1 bg-slate-100 overflow-hidden flex flex-col">
      <div className="h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => onNavigate('export_settings')} className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm flex items-center gap-1.5">
            <ArrowLeft className="w-4 h-4" /> 返回导出页
          </button>
          
          <div className="flex items-center border border-slate-200 rounded-lg overflow-hidden bg-white">
            <button 
              onClick={handleUndo} 
              disabled={historyIndex <= 0} 
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-100 hover:bg-slate-50 ${historyIndex > 0 ? 'text-slate-700' : 'text-slate-300 cursor-not-allowed'}`}
              title="撤销"
            >
              撤销
            </button>
            <button 
              onClick={handleRedo} 
              disabled={historyIndex >= historyStack.length - 1} 
              className={`px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 ${historyIndex < historyStack.length - 1 ? 'text-slate-700' : 'text-slate-300 cursor-not-allowed'}`}
              title="重做"
            >
              重做
            </button>
          </div>

          <div>
            <div className="font-bold text-slate-900">组合图编辑工作台</div>
            <div className="text-xs text-slate-500">选图、统一尺寸/标签字体、拖动微调、交换位置、多格式导出</div>
          </div>
        </div>
        <button onClick={saveComposition} disabled={isSaving || panels.length === 0} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
          <Download className="w-4 h-4" /> {isSaving ? '保存中...' : '保存组合图'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className={focusCanvas ? 'hidden' : 'w-80 bg-white border-r border-slate-200 p-4 overflow-y-auto shrink-0 flex flex-col'}>
          {/* Project Selector */}
          <div className="mb-4 pb-4 border-b border-slate-100 shrink-0">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">当前项目图库</label>
            <select
              value={activeProjectId}
              onChange={(e) => setActiveProjectId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">-- 选择项目 --</option>
              {projectsList.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between mb-3 shrink-0">
            <h3 className="font-semibold text-slate-800">图库与拼图</h3>
            <button onClick={() => void loadAssets()} className="p-1.5 rounded border border-slate-200 hover:bg-slate-50" title="刷新">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex border-b border-slate-200 mb-4">
            <button 
              type="button"
              onClick={() => setLeftTab('single')}
              className={`flex-1 pb-2 text-center text-xs font-semibold border-b-2 transition-colors ${leftTab === 'single' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              单图素材 ({figureAssets.length})
            </button>
            <button 
              type="button"
              onClick={() => setLeftTab('composite')}
              className={`flex-1 pb-2 text-center text-xs font-semibold border-b-2 transition-colors ${leftTab === 'composite' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              历史拼图 ({compositeAssets.length})
            </button>
          </div>

          {leftTab === 'single' && (
            <>
              <div className="text-xs text-slate-500 mb-3">请选择 2、4 或 6 张图。</div>
              <div className="space-y-2">
                {figureAssets.map(asset => {
                  const selected = selectedAssetIds.includes(asset.assetId);
                  return (
                    <button
                      key={asset.assetId}
                      onClick={() => setSelectedAssetIds(prev => selected ? prev.filter(id => id !== asset.assetId) : [...prev, asset.assetId])}
                      className={`w-full text-left rounded-lg border p-2 flex gap-2 ${selected ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div className="w-16 h-12 bg-white border border-slate-200 rounded overflow-hidden shrink-0 flex items-center justify-center">
                        {asset.thumbnailSvg ? <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }} /> : <FileImage className="w-5 h-5 text-slate-300" />}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">{asset.name}</div>
                        <div className="text-[11px] text-slate-500">{asset.format.toUpperCase()} · {new Date(asset.createdAt).toLocaleString()}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <button onClick={startLayout} className="mt-4 w-full px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">
                用选中图片开始排版
              </button>

              {/* Layout templates */}
              <div className="mt-6 pt-6 border-t border-slate-200">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">快捷布局模板</h4>
                <div className="grid grid-cols-1 gap-2">
                  <button 
                    type="button"
                    onClick={() => {
                      if (figureAssets.length >= 2) {
                        const firstTwo = figureAssets.slice(0, 2).map(a => a.assetId);
                        setSelectedAssetIds(firstTwo);
                        const ordered = firstTwo.map(id => figureAssets.find(asset => asset.assetId === id)).filter(Boolean) as ExportAsset[];
                        const next = buildDefaultPanels(ordered);
                        setPanels(next);
                        setActiveAssetId(next[0]?.assetId || null);

                        const initialSnapshot = getSnapshot(next, firstTwo);
                        setHistoryStack([initialSnapshot]);
                        setHistoryIndex(0);
                      } else {
                        alert('单图素材库中需要至少有 2 张图片');
                      }
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-between"
                  >
                    <span>左右双栏 (1x2 布局)</span>
                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">2 张图</span>
                  </button>
                  <button 
                    type="button"
                    onClick={() => {
                      if (figureAssets.length >= 4) {
                        const firstFour = figureAssets.slice(0, 4).map(a => a.assetId);
                        setSelectedAssetIds(firstFour);
                        const ordered = firstFour.map(id => figureAssets.find(asset => asset.assetId === id)).filter(Boolean) as ExportAsset[];
                        const next = buildDefaultPanels(ordered);
                        setPanels(next);
                        setActiveAssetId(next[0]?.assetId || null);

                        const initialSnapshot = getSnapshot(next, firstFour);
                        setHistoryStack([initialSnapshot]);
                        setHistoryIndex(0);
                      } else {
                        alert('单图素材库中需要至少有 4 张图片');
                      }
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-between"
                  >
                    <span>田字四栏 (2x2 布局)</span>
                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">4 张图</span>
                  </button>
                  <button 
                    type="button"
                    onClick={() => {
                      if (figureAssets.length >= 6) {
                        const firstSix = figureAssets.slice(0, 6).map(a => a.assetId);
                        setSelectedAssetIds(firstSix);
                        const ordered = firstSix.map(id => figureAssets.find(asset => asset.assetId === id)).filter(Boolean) as ExportAsset[];
                        const next = buildDefaultPanels(ordered);
                        setPanels(next);
                        setActiveAssetId(next[0]?.assetId || null);

                        const initialSnapshot = getSnapshot(next, firstSix);
                        setHistoryStack([initialSnapshot]);
                        setHistoryIndex(0);
                      } else {
                        alert('单图素材库中需要至少有 6 张图片');
                      }
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-between"
                  >
                    <span>六栏网格 (2x3 布局)</span>
                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">6 张图</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {leftTab === 'composite' && (
            <div className="space-y-2">
              <div className="text-xs text-slate-500 mb-3">点击加载历史拼图，恢复二次拖拽编辑。</div>
              {compositeAssets.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-8">暂无已保存的组合拼图。</div>
              ) : (
                compositeAssets.map(asset => (
                  <button
                    key={asset.assetId}
                    type="button"
                    onClick={() => loadSavedComposition(asset)}
                    className="w-full text-left rounded-lg border border-slate-200 p-2 flex gap-2 hover:bg-slate-50 transition-colors"
                  >
                    <div className="w-16 h-12 bg-white border border-slate-200 rounded overflow-hidden shrink-0 flex items-center justify-center">
                      {asset.thumbnailSvg ? <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }} /> : <FileImage className="w-5 h-5 text-slate-300" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">{asset.name}</div>
                      <div className="text-[10px] text-slate-400 mt-1">
                        子图: {(asset.metadata?.layout as any)?.panels?.length || 0} 张
                      </div>
                      <div className="text-[9px] text-slate-500 mt-0.5">{new Date(asset.createdAt).toLocaleString()}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <main className="flex-grow min-w-0 overflow-hidden p-4 flex flex-col bg-slate-50">
          {/* Zoom Control Bar */}
          <div className="flex items-center gap-1.5 mb-4 bg-white border border-slate-200 rounded-lg p-1.5 shadow-sm w-fit shrink-0">
            <button
              type="button"
              onClick={() => setZoom(prev => Math.max(10, prev - 10))}
              className="p-1 px-2.5 rounded hover:bg-slate-100 text-xs font-semibold text-slate-600 border border-slate-200 bg-white shadow-sm flex items-center gap-1 cursor-pointer"
              title="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" /> 缩小
            </button>
            <span className="text-xs font-mono font-semibold text-slate-700 w-12 text-center select-none">{zoom}%</span>
            <button
              type="button"
              onClick={() => setZoom(prev => Math.min(400, prev + 10))}
              className="p-1 px-2.5 rounded hover:bg-slate-100 text-xs font-semibold text-slate-600 border border-slate-200 bg-white shadow-sm flex items-center gap-1 cursor-pointer"
              title="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" /> 放大
            </button>
            <button
              type="button"
              onClick={() => setZoom(100)}
              className="p-1 px-2 rounded hover:bg-slate-100 text-xs text-slate-600 border border-slate-200 bg-white shadow-sm cursor-pointer"
            >
              100%
            </button>
            <button
              type="button"
              onClick={fitZoom}
              className="p-1 px-2 rounded hover:bg-slate-100 text-xs text-slate-600 border border-slate-200 bg-white shadow-sm flex items-center gap-1 cursor-pointer"
              title="铺满中间视窗"
            >
              <Maximize className="w-3.5 h-3.5" /> 铺满
            </button>
            <button
              type="button"
              onClick={() => {
                setFocusCanvas(prev => !prev);
                window.requestAnimationFrame(() => fitZoom());
              }}
              className={`p-1 px-2 rounded text-xs border shadow-sm flex items-center gap-1 cursor-pointer ${focusCanvas ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'}`}
              title={focusCanvas ? '恢复图库和参数面板' : '收起左右面板，让画布占满工作区'}
            >
              {focusCanvas ? '退出专注' : '专注画布'}
            </button>
          </div>

          <div ref={canvasViewportRef} className="relative overflow-auto flex-grow min-h-0 bg-slate-100 p-3 flex items-center justify-center border border-slate-200 rounded-xl" style={{ minHeight: '520px' }}>
            <div style={{ width: canvas.width * (zoom / 100), height: canvas.height * (zoom / 100) }} className="relative shrink-0 transition-all duration-100 flex items-center justify-center">
              <div 
                className="relative bg-white border border-slate-350 shadow-md origin-center transition-transform duration-100" 
                style={{ 
                  width: canvas.width, 
                  height: canvas.height, 
                  transform: `scale(${zoom / 100})`,
                  backgroundImage: 'radial-gradient(circle, #cbd5e1 1.5px, transparent 1.5px)',
                  backgroundSize: '16px 16px'
                }}
                onPointerMove={handlePointerMove} 
                onPointerUp={handlePointerUp} 
                onPointerCancel={handlePointerUp}
              >
                {applyInnerFont ? (
                  <style>
                    {`.composer-inner-font-preview text { font-family: ${safeCssText(globalFontFamily)} !important; font-size: ${Math.max(4, Math.min(96, innerFontSize))}px !important; fill: ${innerFontColor} !important; }`}
                  </style>
                ) : null}
                {applySemanticTextStyle ? (
                  <style>
                    {`
                      .composer-semantic-preview [id^="title."] text,
                      .composer-semantic-preview [id^="suptitle."] text {
                        font-family: ${safeCssText(globalFontFamily)} !important;
                        font-size: var(--composer-title-font-size, ${Math.max(4, Math.min(96, sourceTitleFontSize))}px) !important;
                        fill: ${sourceTextColor} !important;
                      }
                      .composer-semantic-preview [id^="xlabel."] text,
                      .composer-semantic-preview [id^="ylabel."] text,
                      .composer-semantic-preview [id^="supxlabel."] text,
                      .composer-semantic-preview [id^="supylabel."] text {
                        font-family: ${safeCssText(globalFontFamily)} !important;
                        font-size: var(--composer-axis-label-font-size, ${Math.max(4, Math.min(96, sourceAxisLabelFontSize))}px) !important;
                        fill: ${sourceTextColor} !important;
                      }
                      .composer-semantic-preview [id^="xtick."] text,
                      .composer-semantic-preview [id^="ytick."] text {
                        font-family: ${safeCssText(globalFontFamily)} !important;
                        font-size: var(--composer-tick-font-size, ${Math.max(4, Math.min(96, sourceTickFontSize))}px) !important;
                        fill: ${sourceTextColor} !important;
                      }
                      .composer-semantic-preview [id^="legend_text."] text,
                      .composer-semantic-preview [id^="legend_title."] text {
                        font-family: ${safeCssText(globalFontFamily)} !important;
                        font-size: var(--composer-legend-font-size, ${Math.max(4, Math.min(96, sourceLegendFontSize))}px) !important;
                        fill: ${sourceTextColor} !important;
                      }
                    `}
                  </style>
                ) : null}
                {applyInnerLine ? (
                  <style>
                    {`.composer-inner-line-preview line, .composer-inner-line-preview path { stroke-width: ${innerLineWidth}px !important; stroke: ${innerLineColor} !important; }`}
                  </style>
                ) : null}
                {applyAxisElementStyle ? (
                  <style>
                    {`
                      .composer-axis-preview [id^="spine."] path,
                      .composer-axis-preview [id^="axis.x."] path,
                      .composer-axis-preview [id^="axis.y."] path {
                        stroke-width: var(--composer-axis-line-width, ${Math.max(0.1, Math.min(20, axisLineWidth))}px) !important;
                        stroke: ${axisLineColor} !important;
                      }
                      .composer-axis-preview [id^="xtick."] line,
                      .composer-axis-preview [id^="ytick."] line,
                      .composer-axis-preview [id^="xtick."] path,
                      .composer-axis-preview [id^="ytick."] path,
                      .composer-axis-preview [id^="xtick."] use,
                      .composer-axis-preview [id^="ytick."] use {
                        stroke-width: var(--composer-tick-line-width, ${Math.max(0.1, Math.min(20, tickLineWidth))}px) !important;
                        stroke: ${tickLineColor} !important;
                      }
                    `}
                  </style>
                ) : null}
                {panels.map((panel, index) => {
                  const asset = assets.find(item => item.assetId === panel.assetId);
                  const active = activeAssetId === panel.assetId;
                  const panelScale = getPanelSvgScale(panel, asset);
                  const compensatedStyle = {
                    '--composer-title-font-size': `${compensateForPanelScale(Math.max(4, Math.min(96, sourceTitleFontSize)), panelScale).toFixed(3)}px`,
                    '--composer-axis-label-font-size': `${compensateForPanelScale(Math.max(4, Math.min(96, sourceAxisLabelFontSize)), panelScale).toFixed(3)}px`,
                    '--composer-tick-font-size': `${compensateForPanelScale(Math.max(4, Math.min(96, sourceTickFontSize)), panelScale).toFixed(3)}px`,
                    '--composer-legend-font-size': `${compensateForPanelScale(Math.max(4, Math.min(96, sourceLegendFontSize)), panelScale).toFixed(3)}px`,
                    '--composer-axis-line-width': `${compensateForPanelScale(Math.max(0.1, Math.min(20, axisLineWidth)), panelScale).toFixed(3)}px`,
                    '--composer-tick-line-width': `${compensateForPanelScale(Math.max(0.1, Math.min(20, tickLineWidth)), panelScale).toFixed(3)}px`,
                  } as CSSProperties;
                  return (
                    <div
                      key={panel.assetId}
                      className={`absolute cursor-grab active:cursor-grabbing select-none transition-shadow ${active ? 'ring-2 ring-blue-500 shadow-lg z-10' : 'hover:border-blue-300 shadow-sm'}`}
                      style={{ 
                        left: panel.x, 
                        top: panel.y, 
                        width: panel.width, 
                        height: panel.height,
                        borderStyle: 'solid',
                        borderWidth: `${panelBorderWidth}px`,
                        borderColor: active ? '#3b82f6' : panelBorderColor,
                        borderRadius: `${panelBorderRadius}px`
                      }}
                      onPointerDown={(event) => handlePointerDown(event, panel)}
                    >
                      <div className="absolute left-0 pointer-events-none font-bold" style={{ top: -labelFontSize - 4, fontSize: labelFontSize, fontFamily: globalFontFamily, color: labelColor }}>{panel.label}</div>
                      <div className="absolute inset-0 bg-white overflow-hidden">
                        {asset?.thumbnailSvg ? (
                          <div
                            className={`w-full h-full pointer-events-none [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain ${applyInnerFont ? 'composer-inner-font-preview' : ''} ${applySemanticTextStyle ? 'composer-semantic-preview' : ''} ${applyInnerLine ? 'composer-inner-line-preview' : ''} ${applyAxisElementStyle ? 'composer-axis-preview' : ''}`}
                            style={compensatedStyle}
                            dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }}
                          />
                        ) : null}
                      </div>
                      <span className="absolute right-1 top-1 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[10px] font-semibold">{index + 1}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </main>

        <aside className={focusCanvas ? 'hidden' : 'w-80 bg-white border-l border-slate-200 p-4 overflow-y-auto shrink-0 flex flex-col'}>
          {/* Right Sidebar Tab Switcher */}
          <div className="flex border-b border-slate-200 mb-4 bg-slate-50 rounded-lg p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setRightTab('layout')}
              className={`flex-grow py-1.5 text-center text-xs font-semibold rounded-md transition-all ${rightTab === 'layout' ? 'bg-white text-blue-600 shadow-sm border border-slate-100' : 'text-slate-500 hover:text-slate-700'}`}
            >
              排版
            </button>
            <button
              type="button"
              onClick={() => setRightTab('fonts')}
              className={`flex-grow py-1.5 text-center text-xs font-semibold rounded-md transition-all ${rightTab === 'fonts' ? 'bg-white text-blue-600 shadow-sm border border-slate-100' : 'text-slate-500 hover:text-slate-700'}`}
            >
              批量样式
            </button>
            <button
              type="button"
              onClick={() => setRightTab('output')}
              className={`flex-grow py-1.5 text-center text-xs font-semibold rounded-md transition-all ${rightTab === 'output' ? 'bg-white text-blue-600 shadow-sm border border-slate-100' : 'text-slate-500 hover:text-slate-700'}`}
            >
              保存
            </button>
          </div>

          <div className="flex-grow overflow-y-auto space-y-4 pr-1">
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[10px] leading-relaxed text-blue-800">
              组合图工作台只调整拼版层：子图位置、展示尺寸、外部标号和统一样式覆盖。这里的修改不会回写源单图；坐标范围、数据点、误差棒等深度编辑仍在单图编辑器完成。
            </div>

            {rightTab === 'layout' && (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-bold text-slate-900">1. 画布与模板</div>
                  <p className="text-[10px] text-slate-400 mt-0.5">先确定整体版面，再统一子图展示框，最后单独微调某一张。</p>
                </div>

                {/* Snapping */}
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <label className="flex items-center gap-2 text-xs text-slate-600 font-semibold cursor-pointer">
                    <input type="checkbox" checked={gridSnap} onChange={(e) => setGridSnap(e.target.checked)} className="accent-blue-600" />
                    <span>开启对齐网格磁吸</span>
                  </label>
                  {gridSnap && (
                    <select value={snapStep} onChange={(e) => setSnapStep(Number(e.target.value))} className="border border-slate-200 rounded text-xs px-1.5 py-0.5">
                      <option value={5}>5px</option>
                      <option value={10}>10px</option>
                      <option value={15}>15px</option>
                      <option value={20}>20px</option>
                    </select>
                  )}
                </div>

                {/* Journal Preset Dropdown */}
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-600">期刊排版尺寸规范</label>
                  <select
                    value={journalPreset}
                    onChange={(e) => handleApplyJournalPreset(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 bg-white"
                  >
                    <option value="custom">⚙️ 自定义比例尺寸</option>
                    <option value="nature_single">Nature 单栏 (89 mm / 336 px)</option>
                    <option value="nature_double">Nature 双栏 (183 mm / 692 px)</option>
                    <option value="cell_page">Cell 满版 (174 mm / 658 px)</option>
                    <option value="pnas_single">PNAS 单栏 (87 mm / 328 px)</option>
                    <option value="pnas_double">PNAS 双栏 (178 mm / 672 px)</option>
                  </select>
                </div>

                {/* Dimensions */}
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-600">单图宽 (px)
                    <input type="number" value={panelWidth} onChange={(e) => { setJournalPreset('custom'); setPanelWidth(Number(e.target.value) || 1); }} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5" />
                  </label>
                  <label className="text-xs text-slate-600">单图高 (px)
                    <input type="number" value={panelHeight} onChange={(e) => { setJournalPreset('custom'); setPanelHeight(Number(e.target.value) || 1); }} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5" />
                  </label>
                  <label className="text-xs text-slate-600">横向间距 (px)
                    <input type="number" value={gapX} onChange={(e) => { setJournalPreset('custom'); setGapX(Number(e.target.value) || 0); }} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5" />
                  </label>
                  <label className="text-xs text-slate-600">纵向间距 (px)
                    <input type="number" value={gapY} onChange={(e) => { setJournalPreset('custom'); setGapY(Number(e.target.value) || 0); }} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5" />
                  </label>
                </div>
                <button onClick={applyUniformSize} className="w-full px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold">应用统一尺寸并重排</button>
                <p className="text-[10px] text-slate-400 leading-normal">
                  统一尺寸只改变组合图里的展示框大小，不修改源单图的 Python 代码、导出 SVG 或单图编辑状态。
                </p>

                {activePanel && (
                  <div className="space-y-3 p-3 rounded-lg border border-blue-200 bg-blue-50/30">
                    <div>
                      <div className="text-sm font-bold text-slate-900">2. 当前子图</div>
                      <p className="text-[10px] text-slate-500 mt-0.5">先确认“我正在改谁”，再调位置、大小和外部标号。</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10px] leading-normal text-slate-500">
                      源图：{activePanelAsset?.figureId || '无法识别'} · 当前只改组合图展示层
                    </div>
                    <label className="block text-xs text-slate-600">子图标签文本
                      <input 
                        type="text" 
                        value={activePanel.label} 
                        onChange={(e) => updateActivePanel({ label: e.target.value })} 
                        onBlur={() => pushHistory(panels)}
                        className="mt-1 w-full border rounded bg-white px-2 py-1.5 outline-none focus:border-blue-500 text-xs" 
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-slate-600">X 位置
                        <input
                          type="number"
                          value={Math.round(activePanel.x)}
                          onChange={(e) => updateActivePanel({ x: Number(e.target.value) || 0 })}
                          onBlur={() => pushHistory(panels)}
                          className="mt-1 w-full border rounded bg-white px-2 py-1.5 outline-none focus:border-blue-500 text-xs"
                        />
                      </label>
                      <label className="text-xs text-slate-600">Y 位置
                        <input
                          type="number"
                          value={Math.round(activePanel.y)}
                          onChange={(e) => updateActivePanel({ y: Number(e.target.value) || 0 })}
                          onBlur={() => pushHistory(panels)}
                          className="mt-1 w-full border rounded bg-white px-2 py-1.5 outline-none focus:border-blue-500 text-xs"
                        />
                      </label>
                      <label className="text-xs text-slate-600">显示宽度
                        <input
                          type="number"
                          min={20}
                          value={Math.round(activePanel.width)}
                          onChange={(e) => updateActivePanel({ width: Number(e.target.value) || 20 })}
                          onBlur={() => pushHistory(panels)}
                          className="mt-1 w-full border rounded bg-white px-2 py-1.5 outline-none focus:border-blue-500 text-xs"
                        />
                      </label>
                      <label className="text-xs text-slate-600">显示高度
                        <input
                          type="number"
                          min={20}
                          value={Math.round(activePanel.height)}
                          onChange={(e) => updateActivePanel({ height: Number(e.target.value) || 20 })}
                          onBlur={() => pushHistory(panels)}
                          className="mt-1 w-full border rounded bg-white px-2 py-1.5 outline-none focus:border-blue-500 text-xs"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = panels.map(panel => panel.assetId === activePanel.assetId
                          ? { ...panel, width: panelWidth, height: panelHeight }
                          : panel
                        );
                        setPanels(next);
                        pushHistory(next);
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
                    >
                      将当前子图恢复为统一宽高
                    </button>
                    <button
                      type="button"
                      disabled={!canOpenActiveSourceFigure}
                      onClick={() => {
                        if (!activeSourceFigureId) return;
                        const ok = onEditSourceFigure?.(activeSourceFigureId);
                        if (ok === false) {
                          alert(`无法定位源 Figure：${activeSourceFigureId}。请确认当前项目仍包含该图。`);
                        }
                      }}
                      className="w-full px-3 py-1.5 rounded-lg border border-blue-200 bg-white hover:bg-blue-50 text-xs font-semibold text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      回到单图编辑器修改源图
                    </button>
                    {!canOpenActiveSourceFigure && activeSourceFigureId && (
                      <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                        当前项目状态里未加载 {activeSourceFigureId}，请先打开对应项目并完成一次渲染。
                      </div>
                    )}
                    <p className="text-[10px] text-slate-400 leading-normal">
                      这些数值是组合图里的展示框坐标，不修改源单图文件。需要改数据、坐标轴范围或误差棒，请回到单图编辑器。
                    </p>
                  </div>
                )}

                {!activePanel && (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-4 text-center">
                    <div className="text-xs font-semibold text-slate-700">还没有选中子图</div>
                    <p className="text-[10px] text-slate-400 mt-1">在画布里点击某张子图后，这里会显示它的位置、尺寸和源图入口。</p>
                  </div>
                )}

                {/* Alignment & distribution helpers */}
                <div className="border-t border-slate-100 pt-3">
                  <div className="text-sm font-bold text-slate-900 mb-1">3. 对齐辅助</div>
                  <p className="text-[10px] text-slate-400 mb-2">用于把多张子图快速排整齐，不修改单图内容。</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      type="button" 
                      onClick={alignLeft} 
                      disabled={panels.length <= 1} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      左对齐
                    </button>
                    <button 
                      type="button" 
                      onClick={alignRight} 
                      disabled={panels.length <= 1} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      右对齐
                    </button>
                    <button 
                      type="button" 
                      onClick={alignTop} 
                      disabled={panels.length <= 1} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      顶对齐
                    </button>
                    <button 
                      type="button" 
                      onClick={alignBottom} 
                      disabled={panels.length <= 1} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      底对齐
                    </button>
                    <button 
                      type="button" 
                      onClick={distributeHorizontally} 
                      disabled={panels.length <= 2} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 col-span-2 disabled:opacity-40"
                    >
                      水平等距均分
                    </button>
                    <button 
                      type="button" 
                      onClick={distributeVertically} 
                      disabled={panels.length <= 2} 
                      className="px-2 py-1.5 text-xs rounded border border-slate-200 hover:bg-slate-50 text-slate-700 flex items-center justify-center gap-1 col-span-2 disabled:opacity-40"
                    >
                      垂直等距均分
                    </button>
                  </div>
                </div>

                {/* Borders & Lines */}
                <div className="border-t border-slate-100 pt-3 space-y-3">
                  <div>
                    <div className="text-sm font-bold text-slate-900">4. 组合图框线</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">控制子图展示框和导出覆盖层，不改变源 SVG 图元。</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-slate-500">边框线宽 (px)
                      <input 
                        type="number" 
                        min={0}
                        max={10}
                        value={panelBorderWidth} 
                        onChange={(e) => setPanelBorderWidth(Math.max(0, Number(e.target.value) || 0))} 
                        onBlur={() => pushHistory(panels)}
                        className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" 
                      />
                    </label>
                    <label className="text-[11px] text-slate-500">边框圆角 (px)
                      <input 
                        type="number" 
                        min={0}
                        max={50}
                        value={panelBorderRadius} 
                        onChange={(e) => setPanelBorderRadius(Math.max(0, Number(e.target.value) || 0))} 
                        onBlur={() => pushHistory(panels)}
                        className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" 
                      />
                    </label>
                  </div>
                  <label className="block text-[11px] text-slate-500">边框颜色
                    <input 
                      type="color" 
                      value={panelBorderColor} 
                      onChange={(e) => setPanelBorderColor(e.target.value)} 
                      onBlur={() => pushHistory(panels)}
                      className="mt-1 w-full h-8 border rounded" 
                    />
                  </label>
                  <p className="text-[10px] text-slate-400">💡 提示: 学术论文直角投稿规范要求边框圆角设置为 0px。</p>

                  <div className="border-t border-slate-100 pt-3 space-y-3">
                    <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                      <input type="checkbox" checked={applyInnerLine} onChange={(e) => setApplyInnerLine(e.target.checked)} className="mt-0.5 accent-blue-600" />
                      <span>统一调整子图内部框线 (Inner Lines)</span>
                    </label>
                    
                    {applyInnerLine && (
                      <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                        <label className="block text-[11px] text-slate-600">线条粗细 (px)
                          <input 
                            type="number" 
                            step={0.1}
                            min={0.1}
                            max={10}
                            value={innerLineWidth} 
                            onChange={(e) => setInnerLineWidth(Math.max(0.1, Number(e.target.value) || 1))} 
                            onBlur={() => pushHistory(panels)}
                            className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" 
                          />
                        </label>
                        <label className="block text-[11px] text-slate-600">线条颜色
                          <input 
                            type="color" 
                            value={innerLineColor} 
                            onChange={(e) => setInnerLineColor(e.target.value)} 
                            onBlur={() => pushHistory(panels)}
                            className="mt-1 w-full h-8 border rounded" 
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {rightTab === 'fonts' && (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-bold text-slate-900">批量样式覆盖</div>
                  <p className="text-[10px] text-slate-400 mt-0.5">用于快速统一组合图观感，只影响当前组合图预览和导出，不写回源单图。</p>
                </div>

                <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-3 space-y-3">
                  <div>
                    <div className="text-xs font-bold text-blue-900">一键统一</div>
                    <p className="text-[10px] text-blue-700/80 mt-0.5">确定性应用字号、线宽、间距和 panel label，不自动改数据、不改源图。</p>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {Object.entries(JOURNAL_STYLE_PRESETS).map(([key, preset]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => applyJournalStylePreset(key as keyof typeof JOURNAL_STYLE_PRESETS)}
                        disabled={panels.length === 0}
                        className="rounded-lg border border-blue-100 bg-white px-3 py-2 text-left hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <div className="text-xs font-semibold text-slate-800">{preset.label}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{preset.description}</div>
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-blue-100 pt-2">
                    <div className="text-[10px] font-semibold text-blue-900 mb-1.5">Panel label 格式</div>
                    <div className="grid grid-cols-4 gap-1.5">
                      <button type="button" onClick={() => relabelPanels('paren-lower')} disabled={panels.length === 0} className="rounded border border-blue-100 bg-white px-1.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-blue-50 disabled:opacity-40">(a)</button>
                      <button type="button" onClick={() => relabelPanels('plain-lower')} disabled={panels.length === 0} className="rounded border border-blue-100 bg-white px-1.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-blue-50 disabled:opacity-40">a</button>
                      <button type="button" onClick={() => relabelPanels('paren-upper')} disabled={panels.length === 0} className="rounded border border-blue-100 bg-white px-1.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-blue-50 disabled:opacity-40">(A)</button>
                      <button type="button" onClick={() => relabelPanels('upper-dot')} disabled={panels.length === 0} className="rounded border border-blue-100 bg-white px-1.5 py-1 text-[10px] font-semibold text-slate-700 hover:bg-blue-50 disabled:opacity-40">A.</button>
                    </div>
                  </div>
                </div>

                {/* Global Unified Font */}
                <div className="bg-slate-50 px-3 py-2.5 rounded-lg border border-slate-200 space-y-2">
                  <div className="text-xs font-bold text-slate-800">1. 统一字体族</div>
                  <div className="text-[10px] text-slate-500 leading-normal">这里只保留一个字体族，同时用于外部标号和子图内部文本。字号和颜色可以分开调，字体名称不再分两套。</div>
                  <label className="block text-xs font-semibold text-slate-700">唯一字体族 (Font Family)</label>
                  <select 
                    value={globalFontFamily} 
                    onChange={(e) => setGlobalFontFamily(e.target.value)}
                    onBlur={() => pushHistory(panels)}
                    className="w-full border border-slate-200 rounded px-2 py-1.5 bg-white text-xs outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {LABEL_FAMILIES.map(font => <option key={font} value={font}>{font}</option>)}
                  </select>
                </div>

                {/* Label Font */}
                <div className="space-y-3 border-b border-slate-100 pb-4">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">2. 外部标号</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">控制 (a)、(b)、(c) 这类组合图标号，不影响子图内部文字。</p>
                  </div>
                  <label className="block text-xs text-slate-600">标签字号 (px)
                    <input type="number" value={labelFontSize} onChange={(e) => setLabelFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                  </label>
                  <label className="block text-xs text-slate-600">标签颜色
                    <input type="color" value={labelColor} onChange={(e) => setLabelColor(e.target.value)} onBlur={() => pushHistory(panels)} className="mt-1 w-full h-8 border rounded" />
                  </label>
                </div>

                {/* Subplot Inner Font */}
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">3. 子图内部文字覆盖</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">用于导出阶段统一轴标签、刻度和图例文字；复杂局部修改请回源图编辑。</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={applyInnerFont} onChange={(e) => setApplyInnerFont(e.target.checked)} className="accent-blue-600" />
                    <span>启用内部字号/颜色覆盖</span>
                  </label>

                  {applyInnerFont && (
                    <div className="space-y-3 p-3 bg-blue-50/20 border border-blue-100 rounded-lg">
                      <label className="block text-xs text-slate-600">内部字号 (px)
                        <input type="number" value={innerFontSize} onChange={(e) => setInnerFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                      </label>
                      <label className="block text-xs text-slate-600">内部文字颜色
                        <input type="color" value={innerFontColor} onChange={(e) => setInnerFontColor(e.target.value)} onBlur={() => pushHistory(panels)} className="mt-1 w-full h-8 border rounded" />
                      </label>
                    </div>
                  )}
                </div>

                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">4. 按语义分组改字号</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">识别 matplotlib 导出的 title/xlabel/ylabel/tick/legend gid，只改对应文本组。</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={applySemanticTextStyle} onChange={(e) => setApplySemanticTextStyle(e.target.checked)} className="accent-blue-600" />
                    <span>启用分组文字覆盖</span>
                  </label>
                  {applySemanticTextStyle && (
                    <div className="space-y-3 p-3 bg-emerald-50/30 border border-emerald-100 rounded-lg">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block text-xs text-slate-600">标题字号
                          <input type="number" value={sourceTitleFontSize} onChange={(e) => setSourceTitleFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                        <label className="block text-xs text-slate-600">轴标签字号
                          <input type="number" value={sourceAxisLabelFontSize} onChange={(e) => setSourceAxisLabelFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                        <label className="block text-xs text-slate-600">刻度字号
                          <input type="number" value={sourceTickFontSize} onChange={(e) => setSourceTickFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                        <label className="block text-xs text-slate-600">图例字号
                          <input type="number" value={sourceLegendFontSize} onChange={(e) => setSourceLegendFontSize(Number(e.target.value) || 1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                      </div>
                      <label className="block text-xs text-slate-600">内部文字颜色
                        <input type="color" value={sourceTextColor} onChange={(e) => setSourceTextColor(e.target.value)} onBlur={() => pushHistory(panels)} className="mt-1 w-full h-8 border rounded" />
                      </label>
                    </div>
                  )}
                </div>

                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-800">5. 坐标轴与刻度线</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">只作用于 spine、axis、xtick、ytick 相关 SVG 节点，避免误改数据线。</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={applyAxisElementStyle} onChange={(e) => setApplyAxisElementStyle(e.target.checked)} className="accent-blue-600" />
                    <span>启用坐标轴/刻度线覆盖</span>
                  </label>
                  {applyAxisElementStyle && (
                    <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block text-xs text-slate-600">框线线宽
                          <input type="number" step={0.1} value={axisLineWidth} onChange={(e) => setAxisLineWidth(Number(e.target.value) || 0.1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                        <label className="block text-xs text-slate-600">刻度线宽
                          <input type="number" step={0.1} value={tickLineWidth} onChange={(e) => setTickLineWidth(Number(e.target.value) || 0.1)} onBlur={() => pushHistory(panels)} className="mt-1 w-full border rounded px-2 py-1.5 bg-white text-xs" />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block text-xs text-slate-600">框线颜色
                          <input type="color" value={axisLineColor} onChange={(e) => setAxisLineColor(e.target.value)} onBlur={() => pushHistory(panels)} className="mt-1 w-full h-8 border rounded" />
                        </label>
                        <label className="block text-xs text-slate-600">刻度颜色
                          <input type="color" value={tickLineColor} onChange={(e) => setTickLineColor(e.target.value)} onBlur={() => pushHistory(panels)} className="mt-1 w-full h-8 border rounded" />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {rightTab === 'output' && (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-bold text-slate-900">保存与导出</div>
                  <p className="text-[10px] text-slate-400 mt-0.5">保存会生成新的组合图资产，源单图仍保留在图库中。</p>
                </div>

                {/* Export Formats */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-700">1. 导出格式</div>
                  <div className="grid grid-cols-2 gap-2">
                    {['svg', 'png'].map(format => (
                      <label key={format} className="flex items-center gap-2 text-xs border rounded-lg px-2.5 py-2 cursor-pointer bg-white hover:bg-slate-50 border-slate-200">
                        <input type="checkbox" checked={formats.includes(format)} onChange={() => toggleFormat(format)} className="accent-blue-600" />
                        {format.toUpperCase()}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800 leading-normal">
                  PDF / TIFF 矢量引擎优化正在后台开发中。当前拼图版面已原生支持超高清 SVG 论文矢量图与 600+ DPI 的 PNG 物理位图。
                </div>

                <label className="block text-xs text-slate-600">图像输出 DPI
                  <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} className="mt-1 w-full border rounded px-2 py-1.5 bg-white">
                    <option value={300}>300 DPI (常规印刷)</option>
                    <option value={600}>600 DPI (高清学术期刊)</option>
                    <option value={1200}>1200 DPI (极限精度)</option>
                  </select>
                </label>

                {/* Subplots order */}
                <div className="space-y-2 border-t border-slate-100 pt-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-700">2. 子图顺序</div>
                    <p className="text-[10px] text-slate-400 mt-0.5">调整列表顺序会影响叠放和编号；位置仍以画布上的坐标为准。</p>
                  </div>
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {panels.map((panel, index) => {
                      const asset = assets.find(item => item.assetId === panel.assetId);
                      return (
                        <div
                          key={panel.assetId}
                          onClick={() => setActiveAssetId(panel.assetId)}
                          className={`rounded-lg border p-2 cursor-pointer transition-all ${activeAssetId === panel.assetId ? 'border-blue-500 bg-blue-50/50 shadow-sm' : 'border-slate-200 hover:bg-slate-50'}`}
                        >
                          <div className="text-xs font-semibold truncate flex items-center justify-between">
                            <span>{panel.label} {asset?.name || '图元'}</span>
                            <span className="text-[10px] text-slate-400 bg-slate-100 px-1 rounded">No. {index + 1}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-2">
                            <button
                              type="button"
                              disabled={index === 0}
                              onClick={(event) => { event.stopPropagation(); movePanel(panel.assetId, -1); }}
                              className="px-1 py-0.5 text-[10px] border rounded bg-white hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                            >
                              前移
                            </button>
                            <button
                              type="button"
                              disabled={index === panels.length - 1}
                              onClick={(event) => { event.stopPropagation(); movePanel(panel.assetId, 1); }}
                              className="px-1 py-0.5 text-[10px] border rounded bg-white hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                            >
                              后移
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
