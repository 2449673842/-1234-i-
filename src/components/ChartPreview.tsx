import React, { useEffect, useMemo, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { Minus, Plus, ScanSearch, Move } from 'lucide-react';
import { FigureSpec } from '../types';
import { sanitizeSvg } from '../utils/svgEditor';
import { PatchEntry, FigureSession } from '../schemas/manifest';

interface ChartPreviewProps {
  spec: FigureSpec;
  onSpecChange: (spec: FigureSpec) => void;
  selectedObject: string;
  onSelectObject: (obj: string) => void;
  selectedGids?: string[];
  onSelectGids?: (gids: string[]) => void;
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
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) return { width: parts[2], height: parts[3] };
  }
  return { width: 900, height: 700 };
}

export function ChartPreview({ spec, onSpecChange, onSelectObject, selectedObject, selectedGids = [], onSelectGids, renderedSVG, onPatch, figSession }: ChartPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const didPanRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [manualScale, setManualScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [overlayBoxes, setOverlayBoxes] = useState<{ gid: string; x: number; y: number; w: number; h: number }[]>([]);
  const svgSize = useMemo(() => parseSvgDimensions(renderedSVG), [renderedSVG]);
  const fitScale = useMemo(() => {
    if (!viewport.width || !viewport.height) return 1;
    const availableWidth = Math.max(viewport.width - 64, 200);
    const availableHeight = Math.max(viewport.height - 64, 200);
    return clamp(Math.min(availableWidth / svgSize.width, availableHeight / svgSize.height), 0.2, 4);
  }, [svgSize.height, svgSize.width, viewport.height, viewport.width]);
  const scale = zoomMode === 'fit' ? fitScale : manualScale;
  const zoomPercent = Math.round(scale * 100);
  const validGids = useMemo(() => new Set((figSession?.manifest?.objects || []).map(o => o.id)), [figSession?.manifest?.objects]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
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
      if (event.code === 'Space') setSpacePressed(false);
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
      if (marqueeStartRef.current) {
        marqueeStartRef.current = null;
        setMarqueeRect(null);
      }
      setTimeout(() => { didPanRef.current = false; }, 0);
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
    return () => container.removeEventListener('wheel', handleWheel);
  }, [renderedSVG, scale]);

  // Compute overlay bboxes after render
  useEffect(() => {
    if (!svgContainerRef.current || selectedGids.length === 0) {
      setOverlayBoxes([]);
      return;
    }
    const svgEl = svgContainerRef.current.querySelector('svg');
    if (!svgEl) { setOverlayBoxes([]); return; }
    const boxes: { gid: string; x: number; y: number; w: number; h: number }[] = [];
    selectedGids.forEach(gid => {
      const el = svgEl.querySelector(`[id="${gid}"]`);
      if (!el) return;
      try {
        const bbox = el.getBBox();
        boxes.push({ gid, x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height });
      } catch { /* cross-origin or detached */ }
    });
    setOverlayBoxes(boxes);
  }, [selectedGids, renderedSVG]);

  const handleSvgClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (didPanRef.current || marqueeStartRef.current) return;
    const target = event.target as HTMLElement;
    const objects = figSession?.manifest?.objects || [];
    
    let current: HTMLElement | null = target;
    let foundGid: string | null = null;
    while (current) {
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

    if (foundGid) {
      if (event.ctrlKey || event.metaKey) {
        const next = selectedGids.includes(foundGid)
          ? selectedGids.filter(g => g !== foundGid)
          : [...selectedGids, foundGid];
        onSelectGids?.(next);
      } else {
        onSelectGids?.([foundGid]);
        onSelectObject(foundGid);
      }
      return;
    }
    if (target.closest('svg')) {
      if (!event.ctrlKey && !event.metaKey) {
        onSelectGids?.([]);
        onSelectObject('Figure');
      }
    }
  }, [figSession?.manifest?.objects, validGids, selectedGids, onSelectGids, onSelectObject]);

  const handleSvgMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (spacePressed || event.button === 1) {
      event.preventDefault();
      setIsPanning(true);
      didPanRef.current = false;
      panStartRef.current = { x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
      return;
    }

    // Start marquee on background click (not on an element with valid gid)
    const target = event.target as HTMLElement;
    let current: HTMLElement | null = target;
    let hitElement = false;
    while (current) {
      if (current.id && (validGids.has(current.id) || current.id === 'Figure')) { hitElement = true; break; }
      current = current.parentElement;
    }
    if (!hitElement && target.closest('svg')) {
      marqueeStartRef.current = { x: event.clientX, y: event.clientY };
    }
  }, [spacePressed, pan.x, pan.y, validGids]);

  const handleSvgMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (panStartRef.current) {
      const dx = event.clientX - panStartRef.current.x;
      const dy = event.clientY - panStartRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didPanRef.current = true;
      setPan({ x: panStartRef.current.originX + dx, y: panStartRef.current.originY + dy });
      return;
    }
    if (marqueeStartRef.current && svgContainerRef.current) {
      const svgEl = svgContainerRef.current.querySelector('svg');
      if (!svgEl) return;
      const svgRect = svgEl.getBoundingClientRect();
      const x0 = Math.min(marqueeStartRef.current.x, event.clientX) - svgRect.left;
      const y0 = Math.min(marqueeStartRef.current.y, event.clientY) - svgRect.top;
      const x1 = Math.max(marqueeStartRef.current.x, event.clientX) - svgRect.left;
      const y1 = Math.max(marqueeStartRef.current.y, event.clientY) - svgRect.top;
      setMarqueeRect({ x: x0 / scale, y: y0 / scale, w: (x1 - x0) / scale, h: (y1 - y0) / scale });
    }
  }, [scale]);

  const handleSvgMouseUp = useCallback(() => {
    if (marqueeStartRef.current && marqueeRect) {
      const svgEl = svgContainerRef.current?.querySelector('svg');
      if (svgEl) {
        const hitGids: string[] = [];
        selectedGids.forEach(gid => {
          const el = svgEl.querySelector(`[id="${gid}"]`);
          if (!el) return;
          try {
            const bbox = el.getBBox();
            if (bbox.x < marqueeRect.x + marqueeRect.w && bbox.x + bbox.width > marqueeRect.x &&
                bbox.y < marqueeRect.y + marqueeRect.h && bbox.y + bbox.height > marqueeRect.y) {
              hitGids.push(gid);
            }
          } catch { /* skip */ }
        });
        if (hitGids.length > 0) onSelectGids?.(hitGids);
      }
    }
    marqueeStartRef.current = null;
    setMarqueeRect(null);
  }, [marqueeRect, selectedGids, onSelectGids]);

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
          <button type="button" className="rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900" onClick={() => setManualZoom(scale / 1.1)} title="缩小"><Minus className="w-4 h-4" /></button>
          <button type="button" className="rounded p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900" onClick={() => setManualZoom(scale * 1.1)} title="放大"><Plus className="w-4 h-4" /></button>
          <button type="button" className={`rounded px-2 py-1 text-xs font-medium transition-colors ${zoomMode === 'fit' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => { setZoomMode('fit'); setPan({ x: 0, y: 0 }); }} title="适配窗口">适配</button>
          <button type="button" className={`rounded px-2 py-1 text-xs font-medium transition-colors ${zoomMode === 'manual' && Math.abs(scale - 1) < 0.01 ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => { setManualZoom(1); setPan({ x: 0, y: 0 }); }} title="100%">100%</button>
          <span className="min-w-[52px] text-center text-xs font-semibold text-slate-700">{zoomPercent}%</span>
        </div>

        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 px-2 py-1.5 text-[11px] text-slate-600 shadow-sm backdrop-blur">
          <Move className="w-3.5 h-3.5" /><span>空格+拖动平移</span>
          <span className="text-slate-300">|</span>
          <ScanSearch className="w-3.5 h-3.5" /><span>滚轮缩放</span>
          <span className="text-slate-300">|</span>
          <span>拖动框选</span>
        </div>

        <div
          ref={containerRef}
          className={`w-full h-full overflow-hidden flex items-center justify-center ${spacePressed ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : marqueeStartRef.current ? 'crosshair' : 'cursor-default'}`}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
        >
          <div
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            className="transition-transform duration-150 will-change-transform relative"
          >
            <div
              ref={svgContainerRef}
              onClick={handleSvgClick}
              onDoubleClick={(event) => {
                const target = event.target as HTMLElement;
                let current: HTMLElement | null = target;
                let foundGid: string | null = null;
                while (current) {
                  if (current.id && (validGids.has(current.id) || current.id === 'Figure')) { foundGid = current.id; break; }
                  current = current.parentElement;
                }
                if (foundGid && onPatch) {
                  const isTextObject = foundGid.startsWith('text.') || foundGid.startsWith('title.') || foundGid.startsWith('xlabel.') || foundGid.startsWith('ylabel.') || foundGid.startsWith('legend_text.') || foundGid.startsWith('legend_title.') || foundGid.startsWith('fig_text.');
                  if (isTextObject) {
                    onSelectObject(foundGid);
                    const currentText = target.textContent?.trim() || "";
                    const newText = window.prompt("修改文本内容:", currentText);
                    if (newText !== null && newText !== currentText) {
                      onPatch([{ op: 'set', mode: 'local_patch', gid: foundGid, prop: 'text', value: newText }]);
                    }
                  }
                }
              }}
              className="shadow-sm bg-white flex items-center justify-center [&>svg]:block [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-none [&>svg]:max-h-none"
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(renderedSVG) }}
            />
            {/* Selection overlay SVG */}
            {(overlayBoxes.length > 0 || marqueeRect) && (
              <svg
                className="absolute inset-0 pointer-events-none"
                style={{ width: svgSize.width, height: svgSize.height }}
                viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
              >
                {overlayBoxes.map(box => (
                  <rect
                    key={box.gid}
                    x={box.x}
                    y={box.y}
                    width={box.w}
                    height={box.h}
                    fill="none"
                    stroke={selectedGids.length > 1 ? "#6366f1" : "#3b82f6"}
                    strokeWidth={1.5 / scale}
                    strokeDasharray={selectedGids.length > 1 ? "4,2" : "none"}
                    rx={2}
                    ry={2}
                  />
                ))}
                {marqueeRect && (
                  <rect
                    x={marqueeRect.x}
                    y={marqueeRect.y}
                    width={marqueeRect.w}
                    height={marqueeRect.h}
                    fill="rgba(59,130,246,0.08)"
                    stroke="#3b82f6"
                    strokeWidth={1 / scale}
                    strokeDasharray="4,2"
                  />
                )}
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
