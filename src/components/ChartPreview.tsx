import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Minus, Plus, ScanSearch, Move } from 'lucide-react';
import { FigureSpec } from '../types';
import { sanitizeSvg } from '../utils/svgEditor';
import { PatchEntry, FigureSession } from '../schemas/manifest';

const TEXT_GID_RE = /^(text|title|xlabel|ylabel|legend_text|legend_title|fig_text)\./;

function isTextGid(gid: string): boolean {
  return TEXT_GID_RE.test(gid);
}

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
  if (!svg) return { width: 900, height: 700, viewBox: { x: 0, y: 0, width: 900, height: 700 } };
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
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return {
        width: Number.isFinite(width) ? width : parts[2],
        height: Number.isFinite(height) ? height : parts[3],
        viewBox: { x: parts[0], y: parts[1], width: parts[2], height: parts[3] },
      };
    }
  }
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height, viewBox: { x: 0, y: 0, width, height } };
  return { width: 900, height: 700, viewBox: { x: 0, y: 0, width: 900, height: 700 } };
}

export function ChartPreview({ spec, onSpecChange, onSelectObject, selectedObject, selectedGids = [], onSelectGids, renderedSVG, onPatch, figSession }: ChartPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const didPanRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [manualScale, setManualScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [overlayBoxes, setOverlayBoxes] = useState<{ gid: string; x: number; y: number; w: number; h: number }[]>([]);
  const [overlayFrame, setOverlayFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const svgSize = useMemo(() => parseSvgDimensions(renderedSVG), [renderedSVG]);
  const escId = (id: string) => CSS.escape(id);
  const fitScale = useMemo(() => {
    if (!viewport.width || !viewport.height) return 1;
    const availableWidth = Math.max(viewport.width - 64, 200);
    const availableHeight = Math.max(viewport.height - 64, 200);
    return clamp(Math.min(availableWidth / svgSize.width, availableHeight / svgSize.height), 0.2, 4);
  }, [svgSize.height, svgSize.width, viewport.height, viewport.width]);
  const scale = zoomMode === 'fit' ? fitScale : manualScale;
  const zoomPercent = Math.round(scale * 100);
  const validGids = useMemo(() => new Set((figSession?.manifest?.objects || []).map(o => o.id)), [figSession?.manifest?.objects]);

  const getSvgPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return null;
    const ctm = svgEl.getScreenCTM();
    if (ctm) {
      const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: point.x, y: point.y };
    }
    const rect = svgEl.getBoundingClientRect();
    const viewBox = svgEl.viewBox.baseVal;
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
    };
  }, []);

  const getElementSvgBox = useCallback((el: Element, svgEl: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const corners = [
      getSvgPoint(rect.left, rect.top),
      getSvgPoint(rect.right, rect.top),
      getSvgPoint(rect.right, rect.bottom),
      getSvgPoint(rect.left, rect.bottom),
    ].filter((point): point is { x: number; y: number } => Boolean(point));
    if (corners.length !== 4) return null;
    const xs = corners.map(point => point.x);
    const ys = corners.map(point => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }, [getSvgPoint]);

  const updateOverlayGeometry = useCallback(() => {
    const stageEl = stageRef.current;
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!stageEl || !svgEl) {
      setOverlayFrame(null);
      setOverlayBoxes([]);
      return;
    }

    const stageRect = stageEl.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    setOverlayFrame({
      left: (svgRect.left - stageRect.left) / scale,
      top: (svgRect.top - stageRect.top) / scale,
      width: svgRect.width / scale,
      height: svgRect.height / scale,
    });

    if (selectedGids.length === 0) {
      setOverlayBoxes([]);
      return;
    }

    const boxes: { gid: string; x: number; y: number; w: number; h: number }[] = [];
    selectedGids.forEach(gid => {
      const el = svgEl.querySelector(`[id="${escId(gid)}"]`);
      if (!el) return;
      try {
        const box = getElementSvgBox(el, svgEl);
        if (box) boxes.push({ gid, ...box });
      } catch { /* skip */ }
    });
    setOverlayBoxes(boxes);
  }, [getElementSvgBox, scale, selectedGids]);

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
  }, [figSession?.sessionId]);

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
    const handlePointerUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
      if (marqueeStartRef.current) {
        marqueeStartRef.current = null;
        marqueeRectRef.current = null;
        setMarqueeRect(null);
      }
      setTimeout(() => { didPanRef.current = false; }, 0);
    };
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
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

  useEffect(() => {
    updateOverlayGeometry();
  }, [updateOverlayGeometry, renderedSVG, pan.x, pan.y, scale]);

  const handleSvgClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (didPanRef.current || marqueeStartRef.current) return;
    const target = event.target as HTMLElement;
    
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
  }, [validGids, selectedGids, onSelectGids, onSelectObject]);

  const handleSvgDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    let current: HTMLElement | null = target;
    let foundGid: string | null = null;
    while (current) {
      if (current.id && isTextGid(current.id) && validGids.has(current.id)) {
        foundGid = current.id;
        break;
      }
      current = current.parentElement;
    }
    if (!foundGid) return;

    event.preventDefault();
    event.stopPropagation();
    onSelectGids?.([foundGid]);
    onSelectObject(foundGid);

    const currentText = (current?.textContent || '').trim();
    const nextText = window.prompt('编辑文本内容', currentText);
    if (nextText == null || nextText === currentText) return;
    void onPatch?.([{
      op: 'set',
      mode: 'backend_patch',
      gid: foundGid,
      prop: 'text',
      value: nextText,
    }]);
  }, [validGids, onSelectGids, onSelectObject, onPatch]);

  const handleSvgPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (spacePressed || event.button === 1) {
      event.preventDefault();
      setIsPanning(true);
      didPanRef.current = false;
      panStartRef.current = { x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
      return;
    }

    const target = event.target as HTMLElement;
    let current: HTMLElement | null = target;

    // Start marquee on background (not on a valid element)
    let hitElement = false;
    current = target;
    while (current) {
      if (current.id && (validGids.has(current.id) || current.id === 'Figure')) { hitElement = true; break; }
      current = current.parentElement;
    }
    if (!hitElement && target.closest('svg')) {
      marqueeStartRef.current = { x: event.clientX, y: event.clientY };
    }
  }, [spacePressed, pan.x, pan.y, validGids]);

  const handleSvgPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
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
      const p0 = getSvgPoint(marqueeStartRef.current.x, marqueeStartRef.current.y);
      const p1 = getSvgPoint(event.clientX, event.clientY);
      if (!p0 || !p1) return;
      const rect = {
        x: Math.min(p0.x, p1.x),
        y: Math.min(p0.y, p1.y),
        w: Math.abs(p1.x - p0.x),
        h: Math.abs(p1.y - p0.y),
      };
      marqueeRectRef.current = rect;
      setMarqueeRect(rect);
    }
  }, [getSvgPoint]);

  const handleSvgPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Resolve marquee
    if (marqueeStartRef.current && marqueeRectRef.current) {
      const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
      if (svgEl) {
        const mr = marqueeRectRef.current;
        const hitGids: string[] = [];
        validGids.forEach(gid => {
          const el = svgEl.querySelector(`[id="${escId(gid)}"]`);
          if (!el) return;
          try {
            const bbox = getElementSvgBox(el, svgEl);
            if (bbox && bbox.x < mr.x + mr.w && bbox.x + bbox.w > mr.x &&
                bbox.y < mr.y + mr.h && bbox.y + bbox.h > mr.y) {
              hitGids.push(gid);
            }
          } catch { /* skip */ }
        });
        if (hitGids.length > 0) {
          if (event.ctrlKey || event.metaKey) {
            onSelectGids?.(Array.from(new Set([...selectedGids, ...hitGids])));
          } else {
            onSelectGids?.(hitGids);
          }
        }
      }
    }
    marqueeStartRef.current = null;
    marqueeRectRef.current = null;
    setMarqueeRect(null);
  }, [validGids, selectedGids, onSelectGids, getElementSvgBox]);

  // Hover effect: show pointer cursor generally, grab if selected
  const handleSvgPointerOver = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    let current: HTMLElement | null = target;
    while (current) {
      if (current.id && isTextGid(current.id) && validGids.has(current.id)) {
        current.style.cursor = 'pointer';
        break;
      }
      current = current.parentElement;
    }
  }, [validGids]);

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
          className={`w-full h-full overflow-hidden flex items-center justify-center ${
            spacePressed ? (isPanning ? 'cursor-grabbing' : 'cursor-grab')
            : marqueeStartRef.current ? 'crosshair'
            : 'cursor-default'
          }`}
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
        >
          <div
            ref={stageRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            className="transition-transform duration-150 will-change-transform relative"
          >
            <div
              ref={svgContainerRef}
              onClick={handleSvgClick}
              onDoubleClick={handleSvgDoubleClick}
              onPointerOver={handleSvgPointerOver}
              className="shadow-sm bg-white flex items-center justify-center [&>svg]:block [&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-none [&>svg]:max-h-none"
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(renderedSVG) }}
            />
            {overlayFrame && (overlayBoxes.length > 0 || marqueeRect) && (
              <svg
                className="absolute pointer-events-none"
                style={{
                  left: overlayFrame.left,
                  top: overlayFrame.top,
                  width: overlayFrame.width,
                  height: overlayFrame.height,
                }}
                viewBox={`${svgSize.viewBox.x} ${svgSize.viewBox.y} ${svgSize.viewBox.width} ${svgSize.viewBox.height}`}
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
