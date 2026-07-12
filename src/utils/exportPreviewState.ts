import type { EditEntry, Manifest } from '../schemas/manifest';

const PREVIEW_GLOBAL_PROPS = ['figure.width_in', 'figure.height_in', 'figure.dpi'] as const;
const DURABLE_VIRTUAL_GIDS = new Set(['global', 'font-center-xticks', 'font-center-yticks']);

export function isDurableVirtualEditGid(gid: string): boolean {
  return DURABLE_VIRTUAL_GIDS.has(gid);
}

export function mergePreviewGlobalsIntoEditLog(
  editLog: EditEntry[],
  manifestValue: Manifest | string | null | undefined,
): EditEntry[] {
  let manifest: Manifest | null = null;
  if (typeof manifestValue === 'string') {
    try {
      manifest = JSON.parse(manifestValue) as Manifest;
    } catch {
      return [...editLog];
    }
  } else if (manifestValue && typeof manifestValue === 'object') {
    manifest = manifestValue;
  }
  if (!manifest?.globals) return [...editLog];

  const timestamp = editLog.reduce((max, entry) => Math.max(max, Number(entry.timestamp) || 0), 0) + 1;
  const recovered: EditEntry[] = [];
  PREVIEW_GLOBAL_PROPS.forEach((prop) => {
    const field = manifest?.globals?.[prop];
    if (!field || field.type !== 'number') return;
    const value = Number(field.value);
    if (!Number.isFinite(value)) return;
    recovered.push({ gid: 'global', prop, value, mode: 'backend_patch', timestamp });
  });
  return [...editLog, ...recovered];
}
