import { describe, expect, it } from 'vitest';
import type { EditEntry, Manifest } from '../schemas/manifest';
import { figureDpiFromPatches, isDurableVirtualEditGid, mergePreviewGlobalsIntoEditLog, synchronizeFigureDpiSpec } from './exportPreviewState';
import { defaultSpec } from '../types';

const existing: EditEntry[] = [{
  gid: 'title.0', prop: 'fontsize', value: 14, mode: 'backend_patch', timestamp: 10,
}];

describe('export preview state recovery', () => {
  it('restores the last successful preview dimensions for export replay', () => {
    const manifest = {
      generatedBy: 'introspection',
      globals: {
        'figure.width_in': { type: 'number', value: 9, min: 2, max: 30, step: 0.1 },
        'figure.height_in': { type: 'number', value: 7.5, min: 2, max: 30, step: 0.1 },
        'figure.dpi': { type: 'number', value: 150, min: 72, max: 600, step: 1 },
      },
      objects: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;

    const merged = mergePreviewGlobalsIntoEditLog(existing, manifest);

    expect(merged.slice(-3).map(entry => [entry.gid, entry.prop, entry.value])).toEqual([
      ['global', 'figure.width_in', 9],
      ['global', 'figure.height_in', 7.5],
      ['global', 'figure.dpi', 150],
    ]);
  });

  it('uses explicit session globals instead of stale preview globals', () => {
    const editLog: EditEntry[] = [
      ...existing,
      { gid: 'global', prop: 'figure.width_in', value: 16, mode: 'backend_patch', timestamp: 20 },
      { gid: 'global', prop: 'figure.dpi', value: 1200, mode: 'backend_patch', timestamp: 21 },
    ];
    const manifest = {
      generatedBy: 'introspection',
      globals: {
        'figure.width_in': { type: 'number', value: 14, min: 2, max: 30, step: 0.1 },
        'figure.height_in': { type: 'number', value: 12, min: 2, max: 30, step: 0.1 },
        'figure.dpi': { type: 'number', value: 100, min: 72, max: 1200, step: 1 },
      },
      objects: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    } as Manifest;

    const merged = mergePreviewGlobalsIntoEditLog(editLog, manifest);
    const globals = merged.filter(entry => entry.gid === 'global');

    expect(globals.map(entry => [entry.prop, entry.value])).toEqual([
      ['figure.width_in', 16],
      ['figure.dpi', 1200],
      ['figure.height_in', 12],
    ]);
  });

  it('keeps global and legacy font-center edits out of drift orphan cleanup', () => {
    expect(isDurableVirtualEditGid('global')).toBe(true);
    expect(isDurableVirtualEditGid('font-center-xticks')).toBe(true);
    expect(isDurableVirtualEditGid('title.0')).toBe(false);
  });

  it('synchronizes an applied property-panel DPI with preview and export settings', () => {
    const dpi = figureDpiFromPatches([
      { op: 'set', mode: 'backend_patch', gid: 'global', prop: 'figure.dpi', value: 600 },
    ]);
    expect(dpi).toBe(600);
    const synchronized = synchronizeFigureDpiSpec(defaultSpec, dpi!);
    expect(synchronized.figure.dpi).toBe(600);
    expect(synchronized.export.dpi).toBe(600);
  });
});
