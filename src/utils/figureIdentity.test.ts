import { describe, expect, it } from 'vitest';
import { resolveFigureId } from './figureIdentity';

describe('resolveFigureId', () => {
  it('uses explicit figure id when valid', () => {
    expect(resolveFigureId('fig_1')).toBe('fig_1');
    expect(resolveFigureId('fig_24')).toBe('fig_24');
  });

  it('does not infer from project session ids', () => {
    expect(resolveFigureId('project_with_underscores_fig_2')).toBe('fig_1');
  });

  it('falls back for missing or malformed values', () => {
    expect(resolveFigureId(undefined)).toBe('fig_1');
    expect(resolveFigureId('fig')).toBe('fig_1');
    expect(resolveFigureId('2')).toBe('fig_1');
    expect(resolveFigureId(null, 'fig_3')).toBe('fig_3');
  });
});
