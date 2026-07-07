import { describe, expect, it } from 'vitest';
import { computeEqualAxesPhysicalLayout } from './subplotPhysicalLayout';

describe('subplot physical layout', () => {
  it('keeps every axes box at the requested physical size', () => {
    const layout = computeEqualAxesPhysicalLayout({
      rows: 2,
      cols: 3,
      targetAxesWidthIn: 2.2,
      targetAxesHeightIn: 1.6,
      margins: {
        left: 0.7,
        right: 0.3,
        top: 0.35,
        bottom: 0.55,
        wspace: 0.45,
        hspace: 0.4,
      },
    });

    expect(layout.figureWidthIn).toBeCloseTo(8.5, 3);
    expect(layout.figureHeightIn).toBeCloseTo(4.5, 3);
    expect(layout.bounds).toHaveLength(6);
    layout.bounds.forEach((bounds) => {
      expect(bounds.width * layout.figureWidthIn).toBeCloseTo(2.2, 2);
      expect(bounds.height * layout.figureHeightIn).toBeCloseTo(1.6, 2);
    });
  });

  it('removes horizontal or vertical spacing for single-column and single-row layouts', () => {
    const layout = computeEqualAxesPhysicalLayout({
      rows: 3,
      cols: 1,
      targetAxesWidthIn: 2,
      targetAxesHeightIn: 1,
      margins: {
        left: 0.5,
        right: 0.5,
        top: 0.25,
        bottom: 0.25,
        wspace: 99,
        hspace: 0.2,
      },
    });

    expect(layout.figureWidthIn).toBeCloseTo(3, 3);
    expect(layout.figureHeightIn).toBeCloseTo(3.9, 3);
    layout.bounds.forEach((bounds) => {
      expect(bounds.width * layout.figureWidthIn).toBeCloseTo(2, 2);
      expect(bounds.height * layout.figureHeightIn).toBeCloseTo(1, 2);
    });
  });
});
