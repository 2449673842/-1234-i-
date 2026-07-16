export type LayoutBox = {
  id: string;
  left: number;
  bottom: number;
  width: number;
  height: number;
};

export type VerticalGapShift = {
  id: string;
  rowIndex: number;
  currentBottom: number;
  nextBottom: number;
  deltaBottom: number;
};

export type VerticalGapPlan = {
  rowIds: string[][];
  currentGap: number;
  targetGap: number;
  maxGap: number;
  shifts: VerticalGapShift[];
};

type LayoutRow = {
  boxes: LayoutBox[];
  bottom: number;
  top: number;
  height: number;
};

function rowFromBoxes(boxes: LayoutBox[]): LayoutRow {
  const bottom = Math.min(...boxes.map(box => box.bottom));
  const top = Math.max(...boxes.map(box => box.bottom + box.height));
  return { boxes, bottom, top, height: top - bottom };
}

function groupIntoRows(boxes: LayoutBox[]): LayoutRow[] {
  const ordered = boxes
    .filter(box => [box.left, box.bottom, box.width, box.height].every(Number.isFinite))
    .filter(box => box.width > 0 && box.height > 0)
    .sort((left, right) => (
      (right.bottom + right.height / 2) - (left.bottom + left.height / 2)
      || left.left - right.left
    ));
  const rows: LayoutRow[] = [];

  ordered.forEach(box => {
    const boxTop = box.bottom + box.height;
    let bestIndex = -1;
    let bestOverlap = 0;
    rows.forEach((row, index) => {
      const overlap = Math.max(0, Math.min(boxTop, row.top) - Math.max(box.bottom, row.bottom));
      const required = Math.min(box.height, row.height) * 0.45;
      if (overlap >= required && overlap > bestOverlap) {
        bestIndex = index;
        bestOverlap = overlap;
      }
    });

    if (bestIndex < 0) {
      rows.push(rowFromBoxes([box]));
      return;
    }
    rows[bestIndex] = rowFromBoxes([...rows[bestIndex].boxes, box]);
  });

  return rows
    .map(row => ({ ...row, boxes: [...row.boxes].sort((left, right) => left.left - right.left) }))
    .sort((left, right) => right.top - left.top);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function planVerticalGapPreservingSizes(boxes: LayoutBox[], requestedGap: number): VerticalGapPlan {
  const rows = groupIntoRows(boxes);
  if (rows.length < 2) {
    return {
      rowIds: rows.map(row => row.boxes.map(box => box.id)),
      currentGap: 0,
      targetGap: 0,
      maxGap: 0,
      shifts: rows.flatMap((row, rowIndex) => row.boxes.map(box => ({
        id: box.id,
        rowIndex,
        currentBottom: box.bottom,
        nextBottom: box.bottom,
        deltaBottom: 0,
      }))),
    };
  }

  const currentGaps = rows.slice(0, -1).map((row, index) => (
    row.bottom - rows[index + 1].top
  ));
  const currentGap = Math.max(0, median(currentGaps));
  const lowerRowsHeight = rows.slice(1).reduce((total, row) => total + row.height, 0);
  const maxGap = Math.max(0, (rows[0].bottom - lowerRowsHeight) / (rows.length - 1));
  const safeRequestedGap = Number.isFinite(requestedGap) ? requestedGap : currentGap;
  const targetGap = Math.min(maxGap, Math.max(0, safeRequestedGap));
  const shifts: VerticalGapShift[] = [];
  let previousTargetBottom = rows[0].bottom;

  rows.forEach((row, rowIndex) => {
    const deltaBottom = rowIndex === 0
      ? 0
      : previousTargetBottom - targetGap - row.top;
    row.boxes.forEach(box => {
      shifts.push({
        id: box.id,
        rowIndex,
        currentBottom: box.bottom,
        nextBottom: box.bottom + deltaBottom,
        deltaBottom,
      });
    });
    previousTargetBottom = row.bottom + deltaBottom;
  });

  return {
    rowIds: rows.map(row => row.boxes.map(box => box.id)),
    currentGap,
    targetGap,
    maxGap,
    shifts,
  };
}
