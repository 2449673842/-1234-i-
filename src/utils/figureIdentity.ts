export function resolveFigureId(explicitFigureId?: string | null, fallback = 'fig_1'): string {
  if (explicitFigureId && /^fig_\d+$/.test(explicitFigureId)) {
    return explicitFigureId;
  }
  return fallback;
}
