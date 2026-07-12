export interface CompositionLayoutPlan {
  rows: number;
  cols: number;
  layoutKey: string;
  requestedLayout: string;
  autoResolved: boolean;
  estimatedWidthIn: number;
  estimatedHeightIn: number;
  emptyCells: number;
}

export interface CompositionRisk {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

const DEFAULT_MARGIN = { left: 0.7, right: 0.3, bottom: 0.55, top: 0.35, gapX: 0.45, gapY: 0.45 };

function parseGrid(value: string): { rows: number; cols: number } | null {
  const match = String(value || '').trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!match) return null;
  const rows = Number(match[1]);
  const cols = Number(match[2]);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 20 || cols > 20) return null;
  return { rows, cols };
}

function recommendGrid(count: number, targetPageAspect = 1.35): { rows: number; cols: number } {
  if (count <= 1) return { rows: 1, cols: 1 };
  let best = { rows: 1, cols: count, score: Number.POSITIVE_INFINITY };
  for (let rows = 1; rows <= count; rows += 1) {
    const cols = Math.ceil(count / rows);
    const empty = rows * cols - count;
    const aspect = cols / rows;
    const score = empty * 2.8 + Math.abs(Math.log(aspect / targetPageAspect));
    if (score < best.score || (score === best.score && cols >= rows)) {
      best = { rows, cols, score };
    }
  }
  return { rows: best.rows, cols: best.cols };
}

export function planCompositionLayout(input: {
  count: number;
  requestedLayout?: string;
  axesWidthIn: number;
  axesHeightIn: number;
}): CompositionLayoutPlan {
  const count = Math.max(1, Math.floor(input.count || 1));
  const axesWidthIn = Math.max(0.5, Math.min(12, Number(input.axesWidthIn) || 2.2));
  const axesHeightIn = Math.max(0.5, Math.min(12, Number(input.axesHeightIn) || 2.2));
  const requestedLayout = String(input.requestedLayout || 'auto').trim() || 'auto';
  const parsed = parseGrid(requestedLayout);
  const autoResolved = !parsed || requestedLayout.toLowerCase() === 'auto' || parsed.rows * parsed.cols < count;
  const grid = parsed && parsed.rows * parsed.cols >= count
    ? parsed
    : recommendGrid(count, axesWidthIn >= axesHeightIn ? 1.45 : 1.05);
  const estimatedWidthIn = DEFAULT_MARGIN.left
    + grid.cols * axesWidthIn
    + Math.max(0, grid.cols - 1) * DEFAULT_MARGIN.gapX
    + DEFAULT_MARGIN.right;
  const estimatedHeightIn = DEFAULT_MARGIN.bottom
    + grid.rows * axesHeightIn
    + Math.max(0, grid.rows - 1) * DEFAULT_MARGIN.gapY
    + DEFAULT_MARGIN.top;
  return {
    rows: grid.rows,
    cols: grid.cols,
    layoutKey: `${grid.rows}x${grid.cols}`,
    requestedLayout,
    autoResolved,
    estimatedWidthIn: Number(estimatedWidthIn.toFixed(2)),
    estimatedHeightIn: Number(estimatedHeightIn.toFixed(2)),
    emptyCells: grid.rows * grid.cols - count,
  };
}

export function buildCompositionRisks(input: {
  count: number;
  plan: CompositionLayoutPlan;
  sources: Array<{
    key: string;
    hasPreview?: boolean;
    hasCodeSlice?: boolean;
    projectType?: string;
    language?: string;
    dependencyStatus?: 'complete' | 'unknown' | 'missing';
  }>;
}): CompositionRisk[] {
  const risks: CompositionRisk[] = [];
  if (input.count === 0) risks.push({ code: 'no_sources', level: 'error', message: '尚未选择任何 Figure。' });
  if (new Set(input.sources.map(source => source.key)).size !== input.sources.length) {
    risks.push({ code: 'duplicate_source', level: 'error', message: '存在重复 Figure，请移除重复来源。' });
  }
  if (input.plan.estimatedWidthIn > 7.2) {
    risks.push({ code: 'wide_canvas', level: 'warning', message: `预计宽度 ${input.plan.estimatedWidthIn} in，超过常见论文双栏宽度。` });
  }
  if (input.plan.estimatedHeightIn > 9.7) {
    risks.push({ code: 'tall_canvas', level: 'warning', message: `预计高度 ${input.plan.estimatedHeightIn} in，可能超过 A4/Word 可用版心。` });
  }
  if (input.plan.emptyCells > 0) {
    risks.push({ code: 'empty_cells', level: 'info', message: `当前布局包含 ${input.plan.emptyCells} 个空位。` });
  }
  if (input.sources.some(source => source.projectType === 'composition_code')) {
    risks.push({ code: 'nested_composition', level: 'warning', message: '来源中包含组合代码项目，请确认没有重复嵌套原始 Figure。' });
  }
  if (input.sources.some(source => !source.hasCodeSlice)) {
    risks.push({ code: 'script_fallback', level: 'info', message: '部分 Figure 缺少独立代码片段，将使用来源项目完整脚本回退。' });
  }
  if (input.sources.some(source => !source.hasPreview)) {
    risks.push({ code: 'missing_preview', level: 'info', message: '部分 Figure 没有缩略图，但仍可按代码来源创建。' });
  }
  if (new Set(input.sources.map(source => source.language).filter(Boolean)).size > 1) {
    risks.push({ code: 'mixed_language', level: 'warning', message: '来源同时包含 Python 与 R，组合项目将以 Python 作为转写目标。' });
  }
  if (input.sources.some(source => source.dependencyStatus === 'missing')) {
    risks.push({ code: 'missing_dependencies', level: 'error', message: '至少一个来源 Figure 缺少脚本所需数据文件。' });
  }
  return risks;
}
