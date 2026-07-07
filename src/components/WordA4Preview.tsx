import { useEffect, useMemo, useState } from 'react';
import type { FigureSpec } from '../types';
import type { FigureSession } from '../schemas/manifest';
import { sanitizeSvg } from '../utils/svgEditor';

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const CSS_PX_PER_MM = 96 / 25.4;

const WORD_MARGIN_PRESETS = {
  normal: { label: 'Word 默认', top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
  narrow: { label: '窄页边距', top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
  manuscript: { label: '论文 20mm', top: 20, right: 20, bottom: 20, left: 20 },
};

function collectFontSizeStats(figSession: FigureSession | null, scale: number) {
  const objects = figSession?.manifest?.objects || [];
  const sizes = objects
    .map((obj) => {
      const props = obj.currentProps || {};
      const size = Number(props.fontsize ?? props.tick_labelsize ?? props.label_fontsize);
      if (!Number.isFinite(size) || size <= 0) return null;
      return { id: obj.id, finalPt: size * scale };
    })
    .filter(Boolean) as Array<{ id: string; finalPt: number }>;

  sizes.sort((a, b) => a.finalPt - b.finalPt);
  return {
    min: sizes[0] || null,
    count: sizes.length,
    tooSmall: sizes.filter(item => item.finalPt < 6).length,
    borderline: sizes.filter(item => item.finalPt >= 6 && item.finalPt < 7).length,
  };
}

export function WordA4Preview({
  spec,
  figSession,
  compact = false,
  readingMode = false,
}: {
  spec: FigureSpec;
  figSession: FigureSession | null;
  compact?: boolean;
  readingMode?: boolean;
}) {
  const exportConfig = spec.export ?? { dpi: 600 };
  const figureConfig = spec.figure ?? { width: 100, height: 80, unit: 'mm', dpi: exportConfig.dpi };
  const [marginPreset, setMarginPreset] = useState<keyof typeof WORD_MARGIN_PRESETS>('normal');
  const [previewMode, setPreviewMode] = useState<'actual' | 'fitWidth'>('fitWidth');
  const [pageZoom, setPageZoom] = useState(readingMode ? 1 : (compact ? 0.5 : 1));
  const [screenCalibration, setScreenCalibration] = useState(() => {
    if (typeof window === 'undefined') return 100;
    const stored = Number(window.localStorage.getItem('scifigure.wordPreviewCalibration'));
    return Number.isFinite(stored) && stored >= 60 && stored <= 160 ? stored : 100;
  });
  const [sampleTitlePt, setSampleTitlePt] = useState(14);
  const [sampleBodyPt, setSampleBodyPt] = useState(11);
  const [sampleCaptionPt, setSampleCaptionPt] = useState(9);
  const [showSampleText, setShowSampleText] = useState(true);
  const calibratedZoom = pageZoom * (screenCalibration / 100);

  useEffect(() => {
    window.localStorage.setItem('scifigure.wordPreviewCalibration', String(screenCalibration));
  }, [screenCalibration]);

  const preview = useMemo(() => {
    const margins = WORD_MARGIN_PRESETS[marginPreset];
    const contentWidth = A4_WIDTH_MM - margins.left - margins.right;
    const contentHeight = A4_HEIGHT_MM - margins.top - margins.bottom;
    const sourceWidth = Math.max(1, Number(figureConfig.width) || 100);
    const sourceHeight = Math.max(1, Number(figureConfig.height) || 80);
    const sampleTopReserveMm = showSampleText ? Math.max(34, sampleTitlePt * 1.2 + sampleBodyPt * 2.3) : 0;
    const captionReserveMm = showSampleText ? Math.max(14, sampleCaptionPt * 1.9) : 0;
    const availableFigureHeight = Math.max(20, contentHeight - sampleTopReserveMm - captionReserveMm);
    const fitWidthScale = contentWidth / sourceWidth;
    const fitHeightScale = availableFigureHeight / sourceHeight;
    const displayScale = previewMode === 'fitWidth' ? Math.min(fitWidthScale, fitHeightScale) : 1;
    const finalWidth = sourceWidth * displayScale;
    const finalHeight = sourceHeight * displayScale;
    const pagePx = A4_WIDTH_MM * CSS_PX_PER_MM * calibratedZoom;
    const pageScale = pagePx / A4_WIDTH_MM;
    const left = margins.left * pageScale + Math.max(0, (contentWidth - finalWidth) * pageScale / 2);
    const top = (margins.top + sampleTopReserveMm) * pageScale;
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
      figureWidthPx: finalWidth * pageScale,
      figureHeightPx: finalHeight * pageScale,
      overflows: finalWidth > contentWidth || finalHeight > contentHeight,
      stats: collectFontSizeStats(figSession, displayScale),
    };
  }, [calibratedZoom, figSession, figureConfig.height, figureConfig.width, marginPreset, previewMode, sampleBodyPt, sampleCaptionPt, sampleTitlePt, showSampleText]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="shrink-0 border-b border-slate-200 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold text-slate-800">Word / A4 预览</div>
            <div className="text-[11px] text-slate-500">
              {readingMode ? '按 Word 打印布局判断真实阅读大小。' : '旁路检查插入 Word 后的版面比例和字号。'}
            </div>
          </div>
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={showSampleText}
              onChange={(e) => setShowSampleText(e.target.checked)}
              className="accent-blue-600"
            />
            示例文字
          </label>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <select value={marginPreset} onChange={(e) => setMarginPreset(e.target.value as keyof typeof WORD_MARGIN_PRESETS)} className="rounded border border-slate-200 px-2 py-1 text-[11px]">
            {Object.entries(WORD_MARGIN_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>{preset.label}</option>
            ))}
          </select>
          <select value={previewMode} onChange={(e) => setPreviewMode(e.target.value as 'actual' | 'fitWidth')} className="rounded border border-slate-200 px-2 py-1 text-[11px]">
            <option value="fitWidth">适应版心</option>
            <option value="actual">物理尺寸</option>
          </select>
          <select value={pageZoom} onChange={(e) => setPageZoom(Number(e.target.value) || 0.5)} className="rounded border border-slate-200 px-2 py-1 text-[11px]">
            <option value={0.5}>页面 50%</option>
            <option value={0.75}>页面 75%</option>
            <option value={1}>页面 100%</option>
            <option value={1.25}>页面 125%</option>
          </select>
        </div>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-600">
            <span className="font-semibold">Word 100% 屏幕校准</span>
            <span>{screenCalibration}%</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={60}
              max={160}
              step={1}
              value={screenCalibration}
              onChange={(e) => setScreenCalibration(Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <button
              type="button"
              onClick={() => setScreenCalibration(100)}
              className="shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-500 hover:text-slate-800"
            >
              重置
            </button>
          </div>
          <div className="mt-1 text-[10px] leading-relaxed text-slate-500">
            如果平台 100% 和 Word 100% 看起来不一样，调这个比例让 A4 页面宽度先对齐；字号判断才可信。
          </div>
        </div>
        {showSampleText && (
          <div className="mt-2 grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-white p-2">
            <label className="space-y-1 text-[10px] font-semibold text-slate-600">
              标题 pt
              <input
                type="number"
                min={8}
                max={24}
                step={0.5}
                value={sampleTitlePt}
                onChange={(e) => setSampleTitlePt(Number(e.target.value) || 14)}
                className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
              />
            </label>
            <label className="space-y-1 text-[10px] font-semibold text-slate-600">
              正文 pt
              <input
                type="number"
                min={8}
                max={18}
                step={0.5}
                value={sampleBodyPt}
                onChange={(e) => setSampleBodyPt(Number(e.target.value) || 11)}
                className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
              />
            </label>
            <label className="space-y-1 text-[10px] font-semibold text-slate-600">
              图注 pt
              <input
                type="number"
                min={6}
                max={16}
                step={0.5}
                value={sampleCaptionPt}
                onChange={(e) => setSampleCaptionPt(Number(e.target.value) || 9)}
                className="w-full rounded border border-slate-200 px-2 py-1 text-[11px]"
              />
            </label>
          </div>
        )}
      </div>

      <div className={`min-h-0 flex-1 overflow-auto bg-slate-100 ${readingMode ? 'p-8' : 'p-4'}`}>
        <div
          className={`relative mx-auto bg-white ring-1 ring-slate-200 ${readingMode ? 'shadow-2xl' : 'shadow-lg'}`}
          style={{ width: preview.pagePx, height: preview.pageHeightPx }}
        >
          <div
            className="absolute border border-dashed border-slate-300 bg-slate-50/40"
            style={{
              left: preview.margins.left * preview.pageScale,
              top: preview.margins.top * preview.pageScale,
              width: preview.contentWidth * preview.pageScale,
              height: preview.contentHeight * preview.pageScale,
            }}
          />
          {showSampleText && (
            <div
              className="absolute font-serif text-slate-800"
              style={{
                left: preview.margins.left * preview.pageScale,
                top: preview.margins.top * preview.pageScale,
                width: preview.contentWidth * preview.pageScale,
              }}
            >
              <div className="font-bold leading-tight" style={{ fontSize: sampleTitlePt * calibratedZoom, lineHeight: 1.25 }}>
                Results and discussion
              </div>
              <div className="mt-2 text-slate-700" style={{ fontSize: sampleBodyPt * calibratedZoom, lineHeight: 1.55 }}>
                Example manuscript text for judging whether the final figure size, axis labels and legends remain readable.
              </div>
            </div>
          )}
          <div
            className={`absolute flex items-center justify-center overflow-hidden bg-white shadow-sm ring-1 ${
              preview.overflows ? 'ring-rose-400' : 'ring-blue-300'
            }`}
            style={{
              left: preview.left,
              top: preview.top,
              width: preview.figureWidthPx,
              height: preview.figureHeightPx,
            }}
          >
            {figSession?.svg ? (
              <div
                className="h-full w-full [&>svg]:h-full [&>svg]:w-full [&>svg]:object-contain"
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(figSession.svg) }}
              />
            ) : (
              <div className="px-4 text-center text-xs text-slate-400">请先渲染当前 Figure</div>
            )}
          </div>
          {showSampleText && (
            <div
              className="absolute font-serif text-slate-700"
              style={{
                left: preview.left,
                top: preview.top + preview.figureHeightPx + 10 * calibratedZoom,
                width: Math.min(preview.figureWidthPx, preview.contentWidth * preview.pageScale),
                fontSize: sampleCaptionPt * calibratedZoom,
                lineHeight: 1.35,
              }}
            >
              <span className="font-bold">Figure 1.</span> Example caption showing the figure relative to manuscript typography.
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <span>插入尺寸：<b>{preview.finalWidth.toFixed(1)} × {preview.finalHeight.toFixed(1)} mm</b></span>
          <span>Word 缩放：<b>{Math.round(preview.displayScale * 100)}%</b></span>
          <span>页面显示：<b>{Math.round(pageZoom * 100)}%</b></span>
          <span>校准：<b>{screenCalibration}%</b></span>
          <span>最小字号：<b>{preview.stats.min ? `${preview.stats.min.finalPt.toFixed(1)} pt` : '--'}</b></span>
          <span className={preview.stats.tooSmall > 0 ? 'text-amber-700' : 'text-emerald-700'}>
            小于 6pt：<b>{preview.stats.tooSmall}</b>
          </span>
        </div>
      </div>
    </div>
  );
}
