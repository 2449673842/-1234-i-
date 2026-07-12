import { describe, expect, it } from 'vitest';
import { buildCompositionRisks, planCompositionLayout } from './compositionPlanner';

describe('composition planner', () => {
  it('resolves auto into a concrete grid and physical size', () => {
    const plan = planCompositionLayout({ count: 6, requestedLayout: 'auto', axesWidthIn: 2.3, axesHeightIn: 2.2 });
    expect(plan.layoutKey).toMatch(/^\d+x\d+$/);
    expect(plan.rows * plan.cols).toBeGreaterThanOrEqual(6);
    expect(plan.estimatedWidthIn).toBeGreaterThan(2.3);
    expect(plan.autoResolved).toBe(true);
  });

  it('preserves a valid explicit layout', () => {
    const plan = planCompositionLayout({ count: 8, requestedLayout: '2x4', axesWidthIn: 2.2, axesHeightIn: 2.2 });
    expect(plan.layoutKey).toBe('2x4');
    expect(plan.emptyCells).toBe(0);
    expect(plan.autoResolved).toBe(false);
  });

  it('falls back when an explicit grid cannot contain all figures', () => {
    const plan = planCompositionLayout({ count: 5, requestedLayout: '1x3', axesWidthIn: 2.2, axesHeightIn: 2.2 });
    expect(plan.rows * plan.cols).toBeGreaterThanOrEqual(5);
    expect(plan.autoResolved).toBe(true);
  });

  it('reports nested, fallback, mixed-language and size risks', () => {
    const plan = planCompositionLayout({ count: 2, requestedLayout: '1x2', axesWidthIn: 4, axesHeightIn: 2.2 });
    const risks = buildCompositionRisks({
      count: 2,
      plan,
      sources: [
        { key: 'a:1', projectType: 'composition_code', hasCodeSlice: false, hasPreview: true, language: 'python' },
        { key: 'b:1', hasCodeSlice: true, hasPreview: false, language: 'r' },
      ],
    });
    expect(risks.map(risk => risk.code)).toEqual(expect.arrayContaining(['wide_canvas', 'nested_composition', 'script_fallback', 'missing_preview', 'mixed_language']));
  });
});
