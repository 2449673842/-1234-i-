export interface PhysicalLayoutMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
  wspace: number;
  hspace: number;
}

export interface SubplotPhysicalLayoutInput {
  rows: number;
  cols: number;
  targetAxesWidthIn: number;
  targetAxesHeightIn: number;
  margins: PhysicalLayoutMargins;
}

export interface SubplotBounds {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SubplotPhysicalLayoutResult {
  figureWidthIn: number;
  figureHeightIn: number;
  bounds: SubplotBounds[];
}

const round4 = (value: number) => Number(value.toFixed(4));
const round3 = (value: number) => Number(value.toFixed(3));

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

export function computeEqualAxesPhysicalLayout(input: SubplotPhysicalLayoutInput): SubplotPhysicalLayoutResult {
  const rows = Math.floor(input.rows);
  const cols = Math.floor(input.cols);
  assertPositive('rows', rows);
  assertPositive('cols', cols);
  assertPositive('targetAxesWidthIn', input.targetAxesWidthIn);
  assertPositive('targetAxesHeightIn', input.targetAxesHeightIn);

  const margin = input.margins;
  const left = Math.max(0, margin.left);
  const right = Math.max(0, margin.right);
  const top = Math.max(0, margin.top);
  const bottom = Math.max(0, margin.bottom);
  const wspace = Math.max(0, margin.wspace);
  const hspace = Math.max(0, margin.hspace);

  const figureWidthIn = left + cols * input.targetAxesWidthIn + Math.max(0, cols - 1) * wspace + right;
  const figureHeightIn = bottom + rows * input.targetAxesHeightIn + Math.max(0, rows - 1) * hspace + top;
  assertPositive('figureWidthIn', figureWidthIn);
  assertPositive('figureHeightIn', figureHeightIn);

  const bounds: SubplotBounds[] = [];
  for (let index = 0; index < rows * cols; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    bounds.push({
      left: round4((left + col * (input.targetAxesWidthIn + wspace)) / figureWidthIn),
      bottom: round4((bottom + (rows - 1 - row) * (input.targetAxesHeightIn + hspace)) / figureHeightIn),
      width: round4(input.targetAxesWidthIn / figureWidthIn),
      height: round4(input.targetAxesHeightIn / figureHeightIn),
    });
  }

  return {
    figureWidthIn: round3(figureWidthIn),
    figureHeightIn: round3(figureHeightIn),
    bounds,
  };
}
