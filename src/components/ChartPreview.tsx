import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Minus, Plus, ScanSearch, Move } from 'lucide-react';
import { FigureSpec } from '../types';
import { sanitizeSvg } from '../utils/svgEditor';
import { PatchEntry, FigureSession } from '../schemas/manifest';

const TEXT_GID_RE = /^(r\.text|text|title|xlabel|ylabel|legend_text|legend_title|fig_text)\./;

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
  dragMode?: boolean;
}

interface DragSession {
  pointerId: number;
  startClient: { x: number; y: number };
  startSvg: { x: number; y: number };
  gids: string[];
  originalTransforms: Map<string, string>;
}

interface DragDelta {
  dx: number;
  dy: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function parseSvgDimensions(svg: string | null | undefined) {
  if (!svg) return { width: 900, height: 700, viewBox: { x: 0, y: 0, width: 900, height: 700 } };
  const widthMatch = svg.match(/width=['"]([\d.]+)(pt|px|mm)?['"]/i);
  const heightMatch = svg.match(/height=['"]([\d.]+)(pt|px|mm)?['"]/i);
  const viewBoxMatch = svg.match(/viewBox=['"]([\d.\s-]+)['"]/i);
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

export function ChartPreview({ spec, onSpecChange, onSelectObject, selectedObject, selectedGids = [], onSelectGids, renderedSVG, onPatch, figSession, dragMode = false }: ChartPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const didPanRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragPendingRef = useRef(false);
  const dragStartRef = useRef<DragSession | null>(null);
  const dragRestoreRef = useRef<DragSession | null>(null);
  const dragCaptureTargetRef = useRef<HTMLElement | null>(null);
  const dragPreviewRef = useRef<{ dx: number; dy: number; gids: string[] } | null>(null);
  const pendingDragDeltasRef = useRef<Map<string, DragDelta>>(new Map());
  const pendingPatchMapRef = useRef<Map<string, PatchEntry>>(new Map());
  const pendingOriginalTransformsRef = useRef<Map<string, string>>(new Map());

  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<'fit' | 'manual'>('fit');
  const [manualScale, setManualScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [overlayBoxes, setOverlayBoxes] = useState<{ gid: string; x: number; y: number; w: number; h: number }[]>([]);
  const [overlayFrame, setOverlayFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ dx: number; dy: number; gids: string[] } | null>(null);
  const [pendingPositionPatches, setPendingPositionPatches] = useState<PatchEntry[]>([]);
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
  const manifestObjectMap = useMemo(() => {
    const map = new Map<string, any>();
    (figSession?.manifest?.objects || []).forEach(obj => map.set(obj.id, obj));
    return map;
  }, [figSession?.manifest?.objects]);

  const querySvgElementById = useCallback((svgEl: SVGSVGElement | null, id: string): SVGGraphicsElement | null => {
    if (!svgEl || !id) return null;
    const escaped = CSS.escape(id);
    return (
      svgEl.querySelector(`#${escaped}`)
      || svgEl.querySelector(`[data-fig-id="${escaped}"]`)
    ) as SVGGraphicsElement | null;
  }, []);

  const getSelectableSvgElement = useCallback((svgEl: SVGSVGElement | null, gid: string): SVGGraphicsElement | null => {
    const direct = querySvgElementById(svgEl, gid);
    if (direct) return direct;

    // subplot.* is a logical manifest object. Matplotlib writes the physical axes group as axes.*.
    const subplotMatch = gid.match(/^subplot\.(\d+)$/);
    if (subplotMatch) {
      return querySvgElementById(svgEl, `axes.${subplotMatch[1]}`);
    }

    // R layer/group/text gids: the id is stamped as data-fig-id on individual SVG elements.
    // When no single element owns the id, query all elements with that data-fig-id and return the first.
    if (svgEl) {
      const escaped = CSS.escape(gid);
      const first = svgEl.querySelector(`[data-fig-id="${escaped}"]`) as SVGGraphicsElement | null;
      if (first) return first;
    }
    return null;
  }, [querySvgElementById]);

  const isDraggableTextObject = useCallback((gid: string) => {
    const obj = manifestObjectMap.get(gid);
    const props = obj?.currentProps || {};
    return obj?.kind === 'text'
      && Array.isArray(obj?.editable)
      && obj.editable.includes('position')
      && typeof props.x === 'number'
      && typeof props.y === 'number'
      && (props.coord_system === 'axes' || props.coord_system === 'figure');
  }, [manifestObjectMap]);

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
    // For R layer groups: compute union bbox from all data-fig-id siblings with the same gid
    const gid = el.getAttribute('data-fig-id');
    if (gid && gid.startsWith('r.layer.')) {
      const escaped = CSS.escape(gid);
      const allEls = Array.from(svgEl.querySelectorAll(`[data-fig-id="${escaped}"]`));
      if (allEls.length > 1) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let valid = false;
        allEls.forEach(child => {
          const childRect = child.getBoundingClientRect();
          const tl = getSvgPoint(childRect.left, childRect.top);
          const br = getSvgPoint(childRect.right, childRect.bottom);
          if (tl && br) {
            minX = Math.min(minX, tl.x); minY = Math.min(minY, tl.y);
            maxX = Math.max(maxX, br.x); maxY = Math.max(maxY, br.y);
            valid = true;
          }
        });
        if (valid && maxX > minX && maxY > minY) {
          return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
      }
    }
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

  const findElementGid = useCallback((target: HTMLElement | null) => {
    let current: HTMLElement | null = target;
    while (current) {
      if (current.id) {
        if (validGids.has(current.id)) return current.id;
        const gridMatch = current.id.match(/^grid\.(\d+)\.line\./);
        if (gridMatch && validGids.has(`grid.${gridMatch[1]}`)) {
          return `grid.${gridMatch[1]}`;
        }
      }
      const dataFigId = current.getAttribute('data-fig-id');
      if (dataFigId && validGids.has(dataFigId)) return dataFigId;
      current = current.parentElement;
    }
    return null;
  }, [validGids]);

  const inferAxesIndexFromGid = useCallback((gid: string): number | null => {
    const obj = manifestObjectMap.get(gid);
    if (typeof obj?.source?.axesIndex === 'number') return obj.source.axesIndex;
    if (typeof obj?.subplotId === 'string') {
      const subplotMatch = obj.subplotId.match(/^subplot\.(\d+)$/);
      if (subplotMatch) return Number(subplotMatch[1]);
    }

    // Common gid forms: title.0, title.left.0, xlabel.0, legend_text.0.1, xtick.0.3.
    const match = gid.match(/\.(\d+)(?:\.\d+)?$/);
    if (match) return Number(match[1]);
    return null;
  }, [manifestObjectMap]);

  const getAxesBoxForObject = useCallback((gid: string, svgEl: SVGSVGElement) => {
    const obj = manifestObjectMap.get(gid);
    const subplotId = obj?.subplotId;
    const axesIndex = inferAxesIndexFromGid(gid);
    const candidateIds = [
      axesIndex !== null && Number.isFinite(axesIndex) ? `axes.patch.${axesIndex}` : null,
      axesIndex !== null && Number.isFinite(axesIndex) ? `patch_${axesIndex + 2}` : null,
      axesIndex !== null && Number.isFinite(axesIndex) ? `axes.${axesIndex}` : null,
      typeof subplotId === 'string' ? subplotId : null,
    ].filter(Boolean) as string[];
    for (const id of candidateIds) {
      const el = getSelectableSvgElement(svgEl, id);
      if (!el) continue;
      const box = getElementSvgBox(el, svgEl);
      if (box && box.w > 0 && box.h > 0) return box;
    }
    return null;
  }, [getElementSvgBox, getSelectableSvgElement, inferAxesIndexFromGid, manifestObjectMap]);

  const buildPositionPatch = useCallback((gid: string, dx: number, dy: number): PatchEntry | null => {
    const obj = manifestObjectMap.get(gid);
    const props = obj?.currentProps || {};
    const coordSystem = props.coord_system;
    if (obj?.kind !== 'text' || typeof props.x !== 'number' || typeof props.y !== 'number') return null;
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return null;

    let nextX = props.x;
    let nextY = props.y;
    if (coordSystem === 'axes') {
      const axesBox = getAxesBoxForObject(gid, svgEl);
      const fallbackViewBox = svgEl.viewBox.baseVal;
      const width = axesBox?.w || fallbackViewBox?.width || svgSize.viewBox.width;
      const height = axesBox?.h || fallbackViewBox?.height || svgSize.viewBox.height;
      if (!width || !height) return null;
      nextX = props.x + dx / width;
      nextY = props.y - dy / height;
    } else if (coordSystem === 'figure') {
      const viewBox = svgEl.viewBox.baseVal;
      const width = viewBox?.width || svgSize.viewBox.width;
      const height = viewBox?.height || svgSize.viewBox.height;
      nextX = props.x + dx / width;
      nextY = props.y - dy / height;
    } else {
      return null;
    }

    return {
      op: 'set',
      mode: 'backend_patch',
      gid,
      prop: 'position',
      value: {
        x: Number(nextX.toFixed(6)),
        y: Number(nextY.toFixed(6)),
        coord_system: coordSystem,
      },
    };
  }, [getAxesBoxForObject, manifestObjectMap, svgSize.viewBox.height, svgSize.viewBox.width]);

  const releaseDragCapture = useCallback((pointerId?: number) => {
    const target = dragCaptureTargetRef.current;
    if (target && typeof pointerId === 'number') {
      try {
        target.releasePointerCapture(pointerId);
      } catch { /* pointer may already be released */ }
    }
    dragCaptureTargetRef.current = null;
  }, []);

  const clearDragPreview = useCallback(() => {
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    const session = dragStartRef.current || dragRestoreRef.current;
    pendingOriginalTransformsRef.current.forEach((transform, gid) => {
      const el = querySvgElementById(svgEl, gid);
      if (!el) return;
      if (transform) {
        el.setAttribute('transform', transform);
      } else {
        el.removeAttribute('transform');
      }
      el.style.cursor = '';
    });
    session?.originalTransforms.forEach((transform, gid) => {
      if (pendingOriginalTransformsRef.current.has(gid)) return;
      const el = querySvgElementById(svgEl, gid);
      if (!el) return;
      if (transform) {
        el.setAttribute('transform', transform);
      } else {
        el.removeAttribute('transform');
      }
      el.style.cursor = '';
    });
    releaseDragCapture(session?.pointerId);
    dragStartRef.current = null;
    dragRestoreRef.current = null;
    dragPreviewRef.current = null;
    dragPendingRef.current = false;
    pendingDragDeltasRef.current.clear();
    pendingPatchMapRef.current.clear();
    pendingOriginalTransformsRef.current.clear();
    setDragPreview(null);
  }, [querySvgElementById, releaseDragCapture]);

  const applyDragPreviewTransform = useCallback((drag: { dx: number; dy: number; gids: string[] }) => {
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    const session = dragStartRef.current || dragRestoreRef.current;
    drag.gids.forEach(gid => {
      const el = querySvgElementById(svgEl, gid);
      if (!el) return;
      const original = pendingOriginalTransformsRef.current.get(gid)
        ?? session?.originalTransforms.get(gid)
        ?? '';
      const previousDelta = pendingDragDeltasRef.current.get(gid) ?? { dx: 0, dy: 0 };
      const totalDx = previousDelta.dx + drag.dx;
      const totalDy = previousDelta.dy + drag.dy;
      const nextTransform = `${original} translate(${totalDx.toFixed(3)} ${totalDy.toFixed(3)})`.trim();
      el.setAttribute('transform', nextTransform);
    });
  }, [querySvgElementById]);

  const applyPendingDragTransforms = useCallback(() => {
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    pendingDragDeltasRef.current.forEach((delta, gid) => {
      const el = querySvgElementById(svgEl, gid);
      if (!el) return;
      const original = pendingOriginalTransformsRef.current.get(gid) ?? '';
      const nextTransform = `${original} translate(${delta.dx.toFixed(3)} ${delta.dy.toFixed(3)})`.trim();
      el.setAttribute('transform', nextTransform);
    });
  }, [querySvgElementById]);

  const finalizeDragFromPointer = useCallback((clientX: number, clientY: number) => {
    if (!dragStartRef.current) return false;
    const currentSvg = getSvgPoint(clientX, clientY);
    if (!currentSvg) {
      clearDragPreview();
      dragStartRef.current = null;
      return true;
    }
    const currentDrag = {
      dx: currentSvg.x - dragStartRef.current.startSvg.x,
      dy: currentSvg.y - dragStartRef.current.startSvg.y,
      gids: dragStartRef.current.gids,
    };
    dragPreviewRef.current = currentDrag;
    setDragPreview(currentDrag);
    applyDragPreviewTransform(currentDrag);
    const movedEnough = Math.hypot(currentDrag.dx, currentDrag.dy) >= 0.5;
    const nextPatches: PatchEntry[] = [];
    if (movedEnough) {
      currentDrag.gids.forEach(gid => {
        const sessionOriginal = dragStartRef.current?.originalTransforms.get(gid) || '';
        if (!pendingOriginalTransformsRef.current.has(gid)) {
          pendingOriginalTransformsRef.current.set(gid, sessionOriginal);
        }
        const previousDelta = pendingDragDeltasRef.current.get(gid) ?? { dx: 0, dy: 0 };
        const nextDelta = {
          dx: previousDelta.dx + currentDrag.dx,
          dy: previousDelta.dy + currentDrag.dy,
        };
        pendingDragDeltasRef.current.set(gid, nextDelta);
        const patch = buildPositionPatch(gid, nextDelta.dx, nextDelta.dy);
        if (patch) {
          pendingPatchMapRef.current.set(gid, patch);
          nextPatches.push(patch);
        }
      });
    }
    if (nextPatches.length > 0) {
      dragPendingRef.current = true;
      dragRestoreRef.current = dragStartRef.current;
      releaseDragCapture(dragStartRef.current.pointerId);
      dragStartRef.current = null;
      applyPendingDragTransforms();
      setPendingPositionPatches(Array.from(pendingPatchMapRef.current.values()));
    } else {
      clearDragPreview();
      dragStartRef.current = null;
    }
    return true;
  }, [applyDragPreviewTransform, applyPendingDragTransforms, buildPositionPatch, clearDragPreview, getSvgPoint, releaseDragCapture]);

  useEffect(() => {
    if (!dragPendingRef.current) return;
    applyPendingDragTransforms();
  }, [applyPendingDragTransforms, dragPreview, pendingPositionPatches.length]);

  const finalizeDragPreviewKeepingTransform = useCallback(() => {
    const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
    const session = dragStartRef.current || dragRestoreRef.current;
    session?.gids.forEach(gid => {
      const el = querySvgElementById(svgEl, gid);
      if (el) el.style.cursor = '';
    });
    releaseDragCapture(session?.pointerId);
    dragStartRef.current = null;
    dragRestoreRef.current = null;
    dragPreviewRef.current = null;
    dragPendingRef.current = false;
    pendingDragDeltasRef.current.clear();
    pendingPatchMapRef.current.clear();
    pendingOriginalTransformsRef.current.clear();
    setDragPreview(null);
  }, [querySvgElementById, releaseDragCapture]);

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
      const el = getSelectableSvgElement(svgEl, gid);
      if (!el) return;
      try {
        const box = getElementSvgBox(el, svgEl);
        if (box) boxes.push({ gid, ...box });
      } catch { /* skip */ }
    });
    setOverlayBoxes(boxes);
  }, [getElementSvgBox, getSelectableSvgElement, scale, selectedGids]);

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
    clearDragPreview();
    setPendingPositionPatches([]);
  }, [clearDragPreview, renderedSVG]);

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
    const handlePointerUp = (event: PointerEvent) => {
      setIsPanning(false);
      panStartRef.current = null;
      finalizeDragFromPointer(event.clientX, event.clientY);
      if (marqueeStartRef.current) {
        marqueeStartRef.current = null;
        marqueeRectRef.current = null;
        setMarqueeRect(null);
      }
      setTimeout(() => { didPanRef.current = false; }, 0);
    };
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, [finalizeDragFromPointer]);

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
    const foundGid = findElementGid(target);

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
  }, [findElementGid, selectedGids, onSelectGids, onSelectObject]);

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
    if (dragMode && event.button === 0) {
      const foundGid = findElementGid(event.target as HTMLElement);
      if (foundGid && isDraggableTextObject(foundGid)) {
        const dragGids = (selectedGids.includes(foundGid) ? selectedGids : [foundGid]).filter(isDraggableTextObject);
        if (!selectedGids.includes(foundGid)) {
          onSelectGids?.([foundGid]);
          onSelectObject(foundGid);
        }
        if (dragGids.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
          const startSvg = getSvgPoint(event.clientX, event.clientY);
          if (!startSvg) return;
          const originalTransforms = new Map<string, string>();
          dragGids.forEach(gid => {
            const el = querySvgElementById(svgEl, gid);
            originalTransforms.set(gid, el?.getAttribute('transform') || '');
            if (el) el.style.cursor = 'grabbing';
          });
          dragStartRef.current = {
            pointerId: event.pointerId,
            startClient: { x: event.clientX, y: event.clientY },
            startSvg,
            gids: dragGids,
            originalTransforms,
          };
          dragPreviewRef.current = { dx: 0, dy: 0, gids: dragGids };
          dragPendingRef.current = pendingPatchMapRef.current.size > 0;
          dragRestoreRef.current = null;
          setDragPreview(dragPreviewRef.current);
          try {
            const captureTarget = event.currentTarget as HTMLElement;
            dragCaptureTargetRef.current = captureTarget;
            captureTarget.setPointerCapture(event.pointerId);
          } catch { /* ignore */ }
          return;
        }
      }
    }

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
  }, [dragMode, findElementGid, getSvgPoint, isDraggableTextObject, onSelectGids, onSelectObject, pan.x, pan.y, querySvgElementById, selectedGids, spacePressed, validGids]);

  const handleSvgPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current) {
      const currentSvg = getSvgPoint(event.clientX, event.clientY);
      if (!currentSvg) return;
      const dx = currentSvg.x - dragStartRef.current.startSvg.x;
      const dy = currentSvg.y - dragStartRef.current.startSvg.y;
      dragPreviewRef.current = { dx, dy, gids: dragStartRef.current.gids };
      applyDragPreviewTransform(dragPreviewRef.current);
      setDragPreview(dragPreviewRef.current);
      updateOverlayGeometry();
      return;
    }

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
  }, [applyDragPreviewTransform, getSvgPoint, updateOverlayGeometry]);

  const handleSvgPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (finalizeDragFromPointer(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    // Resolve marquee
    if (marqueeStartRef.current && marqueeRectRef.current) {
      const svgEl = svgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
      if (svgEl) {
        const mr = marqueeRectRef.current;
        const hitGids: string[] = [];
        validGids.forEach(gid => {
          const el = getSelectableSvgElement(svgEl, gid);
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
  }, [validGids, selectedGids, onSelectGids, getElementSvgBox, getSelectableSvgElement, finalizeDragFromPointer]);

  // Hover effect: show pointer cursor generally, grab if selected
  const handleSvgPointerOver = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    let current: HTMLElement | null = target;
    while (current) {
      if (current.id && isTextGid(current.id) && validGids.has(current.id)) {
        current.style.cursor = dragMode && isDraggableTextObject(current.id)
          ? 'grab'
          : 'pointer';
        break;
      }
      current = current.parentElement;
    }
  }, [dragMode, isDraggableTextObject, validGids]);

  const confirmPendingDrag = useCallback(() => {
    if (pendingPositionPatches.length === 0) return;
    finalizeDragPreviewKeepingTransform();
    void onPatch?.(pendingPositionPatches);
    setPendingPositionPatches([]);
  }, [finalizeDragPreviewKeepingTransform, onPatch, pendingPositionPatches]);

  const cancelPendingDrag = useCallback(() => {
    clearDragPreview();
    setPendingPositionPatches([]);
  }, [clearDragPreview]);

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
          {dragMode && (
            <>
              <span className="text-slate-300">|</span>
              <span className="font-semibold text-blue-700">拖拽模式：直接拖文字，确认后写回</span>
            </>
          )}
        </div>

        {dragMode && pendingPositionPatches.length > 0 && (
          <div
            className="absolute left-1/2 top-14 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-blue-100 bg-white/95 px-4 py-2 text-xs shadow-xl backdrop-blur"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="font-medium text-slate-700">
              已累计移动 {pendingPositionPatches.length} 个文本对象，确认后一次性写入 Python 坐标并重渲染。
            </span>
            <button
              type="button"
              onClick={confirmPendingDrag}
              className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
            >
              确认位置
            </button>
            <button
              type="button"
              onClick={cancelPendingDrag}
              className="rounded-md border border-slate-200 px-3 py-1.5 font-semibold text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        )}

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
