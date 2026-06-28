import { useEffect, useMemo, useState } from 'react';
import type { PointerEvent } from 'react';
import { ArrowLeft, Download, FileImage, RefreshCw } from 'lucide-react';
import type { ViewState } from '../App';
import { sanitizeSvg } from '../utils/svgEditor';

interface ExportAsset {
  assetId: string;
  projectId: string;
  figureId: string | null;
  name: string;
  format: string;
  dpi: number | null;
  thumbnailSvg: string | null;
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

const LABEL_FAMILIES = [
  'Arial, sans-serif',
  'Times New Roman, serif',
  'Helvetica, Arial, sans-serif',
  'SimHei, Microsoft YaHei, sans-serif',
];

function safeCssText(value: string) {
  return value.replace(/[<>{}"']/g, '');
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

export function ComposerPage({
  projectId,
  onNavigate,
}: {
  projectId: string | null;
  onNavigate: (view: ViewState) => void;
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
  const [labelFontSize, setLabelFontSize] = useState(18);
  const [labelFontFamily, setLabelFontFamily] = useState(LABEL_FAMILIES[0]);
  const [labelColor, setLabelColor] = useState('#0f172a');
  const [applyInnerFont, setApplyInnerFont] = useState(false);
  const [innerFontSize, setInnerFontSize] = useState(10);
  const [innerFontFamily, setInnerFontFamily] = useState(LABEL_FAMILIES[1]);
  const [innerFontColor, setInnerFontColor] = useState('#111827');
  const [formats, setFormats] = useState<string[]>(['svg']);
  const [dpi, setDpi] = useState(600);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const selectedAssets = useMemo(
    () => selectedAssetIds.map(id => assets.find(asset => asset.assetId === id)).filter(Boolean) as ExportAsset[],
    [assets, selectedAssetIds]
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

  const loadAssets = async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/export-assets`);
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '导出图库加载失败');
      setAssets(data.assets || []);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadAssets();
  }, [projectId]);

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
  };

  const applyUniformSize = () => {
    setPanels(prev => buildDefaultPanels(prev.map(panel => assets.find(asset => asset.assetId === panel.assetId)).filter(Boolean) as ExportAsset[]));
  };

  const toggleFormat = (format: string) => {
    setFormats(prev => {
      const next = prev.includes(format) ? prev.filter(item => item !== format) : [...prev, format];
      return next.length > 0 ? next : ['svg'];
    });
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
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    setPanels(prev => prev.map(panel => {
      if (panel.assetId !== dragState.assetId) return panel;
      return {
        ...panel,
        x: Math.max(0, Math.min(canvas.width - panel.width, dragState.panelX + dx)),
        y: Math.max(labelFontSize + 8, Math.min(canvas.height - panel.height, dragState.panelY + dy)),
      };
    }));
  };

  const saveComposition = async () => {
    if (!projectId || panels.length === 0) return;
    setIsSaving(true);
    try {
      const wantsSvg = formats.includes('svg');
      const wantsPng = formats.includes('png');
      const unsupported = formats.filter(format => !['svg', 'png'].includes(format));
      const res = await fetch(`/api/projects/${projectId}/compose`, {
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
            labelFontSize,
            labelFontFamily,
            labelColor,
            applyInnerFont,
            innerFontSize,
            innerFontFamily,
            innerFontColor,
            panels,
          },
        }),
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '保存组合图失败');
      if (!wantsSvg && data.asset?.assetId) {
        await fetch(`/api/projects/${projectId}/export-assets`, {
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
        const importRes = await fetch(`/api/projects/${projectId}/export-assets/import`, {
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
                labelFontSize,
                labelFontFamily,
                labelColor,
                applyInnerFont,
                innerFontSize,
                innerFontFamily,
                innerFontColor,
                panels,
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
        <aside className="w-80 bg-white border-r border-slate-200 p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-slate-800">导出图库</h3>
            <button onClick={() => void loadAssets()} className="p-1.5 rounded border border-slate-200 hover:bg-slate-50" title="刷新">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="text-xs text-slate-500 mb-3">请选择 2、4 或 6 张图。</div>
          <div className="space-y-2">
            {assets.map(asset => {
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
        </aside>

        <main className="flex-1 overflow-auto p-6">
          <div className="min-w-max mx-auto">
            <div className="relative bg-white border border-slate-300 shadow-sm" style={{ width: canvas.width, height: canvas.height }} onPointerMove={handlePointerMove} onPointerUp={() => setDragState(null)} onPointerCancel={() => setDragState(null)}>
              {applyInnerFont ? (
                <style>
                  {`.composer-inner-font-preview text { font-family: ${safeCssText(innerFontFamily)} !important; font-size: ${Math.max(4, Math.min(96, innerFontSize))}px !important; fill: ${innerFontColor} !important; }`}
                </style>
              ) : null}
              {panels.map((panel, index) => {
                const asset = assets.find(item => item.assetId === panel.assetId);
                const active = activeAssetId === panel.assetId;
                return (
                  <div
                    key={panel.assetId}
                    className={`absolute rounded-md border-2 bg-white overflow-hidden cursor-grab active:cursor-grabbing select-none ${active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-300 hover:border-blue-300'}`}
                    style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height }}
                    onPointerDown={(event) => handlePointerDown(event, panel)}
                  >
                    <div className="absolute left-0 pointer-events-none font-bold" style={{ top: -labelFontSize - 4, fontSize: labelFontSize, fontFamily: labelFontFamily, color: labelColor }}>{panel.label}</div>
                    {asset?.thumbnailSvg ? <div className={`w-full h-full pointer-events-none [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain ${applyInnerFont ? 'composer-inner-font-preview' : ''}`} dangerouslySetInnerHTML={{ __html: sanitizeSvg(asset.thumbnailSvg) }} /> : null}
                    <span className="absolute right-1 top-1 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[10px] font-semibold">{index + 1}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        <aside className="w-80 bg-white border-l border-slate-200 p-4 overflow-y-auto">
          <h3 className="font-semibold text-slate-800 mb-3">统一设置</h3>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <label className="text-xs text-slate-600">单图宽
              <input type="number" value={panelWidth} onChange={(e) => setPanelWidth(Number(e.target.value) || 1)} className="mt-1 w-full border rounded px-2 py-1.5" />
            </label>
            <label className="text-xs text-slate-600">单图高
              <input type="number" value={panelHeight} onChange={(e) => setPanelHeight(Number(e.target.value) || 1)} className="mt-1 w-full border rounded px-2 py-1.5" />
            </label>
            <label className="text-xs text-slate-600">横向间距
              <input type="number" value={gapX} onChange={(e) => setGapX(Number(e.target.value) || 0)} className="mt-1 w-full border rounded px-2 py-1.5" />
            </label>
            <label className="text-xs text-slate-600">纵向间距
              <input type="number" value={gapY} onChange={(e) => setGapY(Number(e.target.value) || 0)} className="mt-1 w-full border rounded px-2 py-1.5" />
            </label>
          </div>
          <button onClick={applyUniformSize} className="w-full mb-5 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm">应用统一尺寸并重排</button>

          <div className="space-y-3 mb-5">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-sm font-semibold text-slate-800">组合标签字体</div>
              <div className="text-xs text-slate-500 mt-1">控制 (a)、(b)、(c) 这类面板编号。</div>
            </div>
            <label className="block text-xs text-slate-600">标签字号
              <input type="number" value={labelFontSize} onChange={(e) => setLabelFontSize(Number(e.target.value) || 1)} className="mt-1 w-full border rounded px-2 py-1.5" />
            </label>
            <label className="block text-xs text-slate-600">标签字体
              <select value={labelFontFamily} onChange={(e) => setLabelFontFamily(e.target.value)} className="mt-1 w-full border rounded px-2 py-1.5">
                {LABEL_FAMILIES.map(font => <option key={font} value={font}>{font}</option>)}
              </select>
            </label>
            <label className="block text-xs text-slate-600">标签颜色
              <input type="color" value={labelColor} onChange={(e) => setLabelColor(e.target.value)} className="mt-1 w-full h-9 border rounded" />
            </label>
          </div>

          <div className="space-y-3 mb-5 rounded-xl border border-blue-100 bg-blue-50/40 p-3">
            <label className="flex items-start gap-2 text-sm font-semibold text-slate-800">
              <input type="checkbox" checked={applyInnerFont} onChange={(e) => setApplyInnerFont(e.target.checked)} className="mt-1 accent-blue-600" />
              <span>
                统一子图内部文字
                <span className="block text-xs font-normal text-slate-500 mt-0.5">导出层覆盖 SVG 文本，适合组合图统一字体；不会回写原单图。</span>
              </span>
            </label>
            <label className="block text-xs text-slate-600">内部字号
              <input disabled={!applyInnerFont} type="number" value={innerFontSize} onChange={(e) => setInnerFontSize(Number(e.target.value) || 1)} className="mt-1 w-full border rounded px-2 py-1.5 disabled:bg-slate-100" />
            </label>
            <label className="block text-xs text-slate-600">内部字体
              <select disabled={!applyInnerFont} value={innerFontFamily} onChange={(e) => setInnerFontFamily(e.target.value)} className="mt-1 w-full border rounded px-2 py-1.5 disabled:bg-slate-100">
                {LABEL_FAMILIES.map(font => <option key={font} value={font}>{font}</option>)}
              </select>
            </label>
            <label className="block text-xs text-slate-600">内部文字颜色
              <input disabled={!applyInnerFont} type="color" value={innerFontColor} onChange={(e) => setInnerFontColor(e.target.value)} className="mt-1 w-full h-9 border rounded disabled:opacity-50" />
            </label>
          </div>

          <h3 className="font-semibold text-slate-800 mb-3">导出格式</h3>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {['svg', 'png'].map(format => (
              <label key={format} className="flex items-center gap-2 text-sm border rounded-lg px-2 py-2 cursor-pointer">
                <input type="checkbox" checked={formats.includes(format)} onChange={() => toggleFormat(format)} className="accent-blue-600" />
                {format.toUpperCase()}
              </label>
            ))}
          </div>
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            PDF/TIFF 不再依赖 Cairo，后续会接入平台服务端渲染路径；当前组合图先稳定支持 SVG + PNG。
          </div>
          <label className="block text-xs text-slate-600 mb-5">DPI
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} className="mt-1 w-full border rounded px-2 py-1.5">
              <option value={300}>300 dpi</option>
              <option value={600}>600 dpi</option>
              <option value={1200}>1200 dpi</option>
            </select>
          </label>

          <h3 className="font-semibold text-slate-800 mb-3">顺序</h3>
          <div className="space-y-2">
            {panels.map((panel, index) => {
              const asset = assets.find(item => item.assetId === panel.assetId);
              return (
                <div key={panel.assetId} onClick={() => setActiveAssetId(panel.assetId)} className={`rounded-lg border p-2 cursor-pointer ${activeAssetId === panel.assetId ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <div className="text-xs font-semibold truncate">{panel.label} {asset?.name || '未命名图'}</div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button disabled={index === 0} onClick={(event) => { event.stopPropagation(); movePanel(panel.assetId, -1); }} className="px-2 py-1 text-xs border rounded disabled:opacity-40">前移</button>
                    <button disabled={index === panels.length - 1} onClick={(event) => { event.stopPropagation(); movePanel(panel.assetId, 1); }} className="px-2 py-1 text-xs border rounded disabled:opacity-40">后移</button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
