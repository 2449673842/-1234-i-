import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Minus, Plus, ScanSearch, Move } from 'lucide-react';
import { FigureSpec } from '../types';
import { sanitizeSvg } from '../utils/svgEditor';
import { PatchEntry, FigureSession } from '../schemas/manifest';

interface ChartPreviewProps {
  spec: FigureSpec;
  onSpecChange: (spec: FigureSpec) => void;
  selectedObject: string;
  onSelectObject: (obj: string) => void;
  renderedSVG?: string | null;
  onPatch?: (patches: PatchEntry[]) => void;
  figSession?: FigureSession | null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function parseSvgDimensions(svg: string | null | undefined) {
  if (!svg) return { width: 900, height: 700 };

  const widthMatch = svg.match(/width="([\d.]+)(pt|px|mm)?"/i);
  const heightMatch = svg.match(/height="([\d.]+)(pt|px|mm)?"/i);
  const viewBoxMatch = svg.match(/viewBox="([\d.\s-]+)"/i);

  const unitScale = (unit?: string) => {
    if (unit === 'mm') return 3.7795275591;
    if (unit === 'pt') return 1.3333333333;
    return 1;
  };

  const width = widthMatch ? Number(widthMatch[1]) * unitScale(widthMatch[2]) : NaN;
  const height = heightMatch ? Number(heightMatch[1]) * unitScale(heightMatch[2]) : NaN;
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { width, height };
  }

  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { width: parts[2], height: parts[3] };
    }
  }

  return { width: 900, height: 700 };
}

export function ChartPreview({ spec, onSpecChange, onSelectObject, renderedSVG, onPatch, figSession }: ChartPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const didPanRef = useRef(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [manualScale, setManualScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const svgSize = useMemo(() => parseSvgDimensions(renderedSVG), [renderedSVG]);
  const fitScale = useMemo(() => {
    if (!viewport.width || !viewport.height) return 1;
    const availableWidth = Math.max(viewport.width - 64, 200);
    const availableHeight = Math.max(viewport.height - 64, 200);
    return clamp(Math.min(availableWidth / svgSize.width, availableHeight / svgSize.height), 0.2, 4);
  }, [svgSize.height, svgSize.width, viewport.height, viewport.width]);
  const scale = zoomMode === 'fit' ? fitScale : manualScale;
  const zoomPercent = Math.round(scale * 100);

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoomMode('fit');
    setManualScale(1);
    setPan({ x: 0, y: 0 });
  }, [renderedSVG]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        setSpacePressed(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setSpacePressed(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const handleMouseUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
      setTimeout(() => {
        didPanRef.current = false;
      }, 0);
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const setManualZoom = (nextScale: number) => {
    setZoomMode('manual');
    setManualScale(clamp(nextScale, 0.2, 6));
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.08 : 0.92;
      setManualZoom(scale * factor);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [renderedSVG, scale]);

  if (!renderedSVG) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-slate-50">
        <div className="text-slate-500 text-center space-y-4">
          <div className="text-5xl mb-2">🐍</div>
          <h3 className="text-lg font-medium text-slate-700">等待 Python 渲染结果</h3>
          <p className="text-sm max-w-[320px] mx-auto text-slate-500 leading-relaxed">
            当前画布只显示后端真渲染 SVG。请点击上方「同步至引擎并预览 SVG」生成预览。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full p-4 bg-slate-50">
      <div className="relative w-full h-full rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-2 py-1.5 shadow-sm backdrop-blur">
          <button
            type="button"
            className="rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            onClick={() => setManualZoom(scale / 1.1)}
            title="缩小"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            onClick={() => setManualZoom(scale * 1.1)}
            title="放大"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${zoomMode === 'fit' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => {
              setZoomMode('fit');
              setPan({ x: 0, y: 0 });
            }}
            title="适配窗口"
          >
            适配
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${zoomMode === 'manual' && Math.abs(scale - 1) < 0.01 ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => {
              setManualZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            title="100%"
          >
            100%
          </button>
          <span className="min-w-[52px] text-center text-xs font-semibold text-slate-700">{zoomPercent}%</span>
        </div>

        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 px-2 py-1.5 text-[11px] text-slate-600 shadow-sm backdrop-blur">
          <Move className="w-3.5 h-3.5" />
          <span>空格 + 拖动平移</span>
          <span className="text-slate-300">|</span>
          <ScanSearch className="w-3.5 h-3.5" />
          <span>滚轮缩放</span>
        </div>

        <div
          ref={containerRef}
          className={`w-full h-full overflow-hidden flex items-center justify-center ${spacePressed ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
          onMouseDown={(event) => {
            if (!(spacePressed || event.button === 1)) return;
            event.preventDefault();
            setIsPanning(true);
            didPanRef.current = false;
            panStartRef.current = {
              x: event.clientX,
              y: event.clientY,
              originX: pan.x,
              originY: pan.y,
            };
          }}
          onMouseMove={(event) => {
            if (!panStartRef.current) return;
            const dx = event.clientX - panStartRef.current.x;
            const dy = event.clientY - panStartRef.current.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
              didPanRef.current = true;
            }
            setPan({
              x: panStartRef.current.originX + dx,
              y: panStartRef.current.originY + dy,
            });
          }}
        >
          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: 'center center',
            }}
            className="transition-transform duration-150 will-change-transform"
          >
            <div
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(renderedSVG) }}
              className="shadow-sm bg-white flex items-center justify-center [&>svg]:block [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-none [&>svg]:max-h-none"
              onClick={(event) => {
                if (didPanRef.current) return;
                const target = event.target as HTMLElement;
                const objects = figSession?.manifest?.objects || [];
                const validGids = new Set(objects.map(o => o.id));
                
                console.log("[ChartPreview Click] target:", target.tagName, "id:", target.id, "class:", target.className, "text:", target.textContent?.slice(0, 30));
                
                let current: HTMLElement | null = target;
                let foundGid: string | null = null;
                const path: string[] = [];
                while (current) {
                  path.push(`${current.tagName}${current.id ? `#${current.id}` : ''}`);
                  if (current.id) {
                    if (validGids.has(current.id) || current.id === 'Figure') {
                      foundGid = current.id;
                      break;
                    }
                    const gridMatch = current.id.match(/^grid\.(\d+)\.line\./);
                    if (gridMatch) {
                      const resolvedGridId = `grid.${gridMatch[1]}`;
                      if (validGids.has(resolvedGridId)) {
                        foundGid = resolvedGridId;
                        break;
                      }
                    }
                  }
                  current = current.parentElement;
                }
                
                console.log("[ChartPreview Click] parent path:", path.join(" -> "));
                console.log("[ChartPreview Click] matched GID:", foundGid, "validGids:", Array.from(validGids));

                if (foundGid) {
                  onSelectObject(foundGid);
                  return;
                }

                if (target.closest('svg')) {
                  onSelectObject('Figure');
                }
              }}
              onDoubleClick={(event) => {
                const target = event.target as HTMLElement;
                const objects = figSession?.manifest?.objects || [];
                const validGids = new Set(objects.map(o => o.id));
                
                let current: HTMLElement | null = target;
                let foundGid: string | null = null;
                while (current) {
                  if (current.id && (validGids.has(current.id) || current.id === 'Figure')) {
                    foundGid = current.id;
                    break;
                  }
                  current = current.parentElement;
                }

                if (foundGid && onPatch) {
                  const gid = foundGid;
                  const isTextObject = gid.startsWith('text.') ||
                                       gid.startsWith('title.') ||
                                       gid.startsWith('xlabel.') ||
                                       gid.startsWith('ylabel.') ||
                                       gid.startsWith('legend_text.') ||
                                       gid.startsWith('legend_title.') ||
                                       gid.startsWith('fig_text.');
                  
                  if (isTextObject) {
                    onSelectObject(gid);
                    const currentText = current.textContent?.trim() || "";
                    const newText = window.prompt("修改文本内容:", currentText);
                    if (newText !== null && newText !== currentText) {
                      onPatch([
                        {
                          op: 'set',
                          mode: 'local_patch',
                          gid,
                          prop: 'text',
                          value: newText
                        }
                      ]);
                    }
                  }
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
