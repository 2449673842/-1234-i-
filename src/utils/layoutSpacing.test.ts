import { describe, expect, it } from 'vitest';
import { planHorizontalGapPreservingSizes, planVerticalGapPreservingSizes } from './layoutSpacing';

describe('vertical subplot spacing that preserves sizes', () => {
  const boxes = [
    { id: 'subplot.0', left: 0.10, bottom: 0.58, width: 0.32, height: 0.30 },
    { id: 'subplot.1', left: 0.56, bottom: 0.58, width: 0.34, height: 0.30 },
    { id: 'subplot.2', left: 0.10, bottom: 0.15, width: 0.40, height: 0.30 },
    { id: 'subplot.3', left: 0.56, bottom: 0.15, width: 0.34, height: 0.30 },
  ];

  it('keeps the top row fixed and moves only lower-row bottoms', () => {
    const plan = planVerticalGapPreservingSizes(boxes, 0.20);
    const shifts = Object.fromEntries(plan.shifts.map(shift => [shift.id, shift]));

    expect(plan.rowIds).toEqual([
      ['subplot.0', 'subplot.1'],
      ['subplot.2', 'subplot.3'],
    ]);
    expect(plan.currentGap).toBeCloseTo(0.13);
    expect(shifts['subplot.0'].deltaBottom).toBe(0);
    expect(shifts['subplot.1'].deltaBottom).toBe(0);
    expect(shifts['subplot.2'].deltaBottom).toBeCloseTo(-0.07);
    expect(shifts['subplot.3'].deltaBottom).toBeCloseTo(-0.07);
  });

  it('clamps the requested gap so the final row remains on the canvas', () => {
    const plan = planVerticalGapPreservingSizes(boxes, 0.80);
    const lowerRow = plan.shifts.filter(shift => shift.rowIndex === 1);

    expect(plan.targetGap).toBeCloseTo(plan.maxGap);
    expect(lowerRow.every(shift => shift.nextBottom >= -1e-9)).toBe(true);
  });

  it('uses vertical overlap instead of source order to identify rows', () => {
    const shuffled = [boxes[2], boxes[0], boxes[3], boxes[1]];
    const plan = planVerticalGapPreservingSizes(shuffled, 0.10);

    expect(plan.rowIds).toEqual([
      ['subplot.0', 'subplot.1'],
      ['subplot.2', 'subplot.3'],
    ]);
  });
});

describe('horizontal subplot spacing that preserves sizes', () => {
  const boxes = [
    { id: 'subplot.0', left: 0.10, bottom: 0.58, width: 0.32, height: 0.30 },
    { id: 'subplot.1', left: 0.56, bottom: 0.58, width: 0.34, height: 0.30 },
    { id: 'subplot.2', left: 0.10, bottom: 0.15, width: 0.32, height: 0.30 },
    { id: 'subplot.3', left: 0.56, bottom: 0.15, width: 0.34, height: 0.30 },
  ];

  it('keeps the left column fixed and moves only right-column left positions', () => {
    const plan = planHorizontalGapPreservingSizes(boxes, 0.20);
    const shifts = Object.fromEntries(plan.shifts.map(shift => [shift.id, shift]));

    expect(plan.columnIds).toEqual([
      ['subplot.0', 'subplot.2'],
      ['subplot.1', 'subplot.3'],
    ]);
    expect(plan.currentGap).toBeCloseTo(0.14);
    expect(shifts['subplot.0'].deltaLeft).toBe(0);
    expect(shifts['subplot.2'].deltaLeft).toBe(0);
    expect(shifts['subplot.1'].deltaLeft).toBeCloseTo(0.06);
    expect(shifts['subplot.3'].deltaLeft).toBeCloseTo(0.06);
  });

  it('clamps the requested gap so the final column remains on the canvas', () => {
    const plan = planHorizontalGapPreservingSizes(boxes, 0.80);
    const rightColumn = plan.shifts.filter(shift => shift.columnIndex === 1);

    expect(plan.targetGap).toBeCloseTo(plan.maxGap);
    expect(rightColumn.every(shift => shift.nextLeft + 0.34 <= 1 + 1e-9)).toBe(true);
  });

  it('uses horizontal overlap instead of source order to identify columns', () => {
    const shuffled = [boxes[3], boxes[0], boxes[1], boxes[2]];
    const plan = planHorizontalGapPreservingSizes(shuffled, 0.10);

    expect(plan.columnIds).toEqual([
      ['subplot.0', 'subplot.2'],
      ['subplot.1', 'subplot.3'],
    ]);
  });
});
