import { describe, expect, it } from 'vitest';
import type { Manifest, ManifestObject } from '../schemas/manifest';
import { projectPaletteColorControl } from './palettePropertyProjection';
import type { PaletteTargetResolution, ResolvedPaletteTarget } from './paletteTargetResolver';

function object(id: string, prop: string, value: unknown): ManifestObject {
  return {
    id,
    kind: prop === 'color' ? 'line' : 'patch',
    label: id,
    editable: [prop],
    currentProps: { [prop]: value },
    propertyCapabilities: [{
      prop,
      patchMode: 'local_patch',
      scopes: ['object', 'group'],
      preview: 'exact',
      replay: 'stable',
    }],
  } as ManifestObject;
}

function target(
  objectId: string,
  prop: string,
  replayMode: ResolvedPaletteTarget['replayMode'] = 'object_patch',
): ResolvedPaletteTarget {
  return {
    objectId,
    prop,
    match: 'label_and_color',
    confidence: 'exact',
    patchMode: 'local_patch',
    replayMode,
  };
}

function resolution(
  targets: ResolvedPaletteTarget[],
  overrides: Partial<PaletteTargetResolution> = {},
): PaletteTargetResolution {
  return {
    paletteId: 'SERIES',
    strategy: 'strict',
    targetMode: 'exact',
    targets,
    skipped: [],
    ambiguous: [],
    warnings: [],
    ...overrides,
  };
}

function manifest(objects: ManifestObject[]): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {},
    objects,
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
}

describe('palette property projection', () => {
  it('uses resolver-owned per-target props and reports mixed object colors', () => {
    const line = object('line.0', 'color', '#112233');
    const patch = object('patch.0', 'facecolor', '#445566');

    const result = projectPaletteColorControl({
      manifest: manifest([line, patch]),
      resolution: resolution([
        target(line.id, 'color'),
        target(patch.id, 'facecolor'),
      ]),
      paletteColor: '#112233',
      controlId: 'palette:SERIES',
      allowCodePatch: true,
    });

    expect(result.projection.state).toBe('mixed');
    expect(result.projection.mixed).toBe(true);
    expect(Object.values(result.projection.propByObjectId)).toEqual(['color', 'facecolor']);
    expect(result.projection.counts.editable).toBe(2);
  });

  it('uses the semantic palette color for code-only vector collections', () => {
    const collection = object('collection.0', 'facecolor', [
      [0.1, 0.2, 0.3, 1],
      [0.8, 0.4, 0.2, 1],
    ]);

    const result = projectPaletteColorControl({
      manifest: manifest([collection]),
      resolution: resolution([target(collection.id, 'facecolor', 'code_only')]),
      paletteColor: '#1f78b4',
      controlId: 'palette:SERIES',
      allowCodePatch: true,
    });

    expect(result.projection.state).toBe('editable');
    expect(result.projection.mixed).toBe(false);
    expect(result.projection.valuesByObjectId[result.representativeId]).toBe('#1f78b4');
    expect(result.codeOnlyTargets).toHaveLength(1);
  });

  it('blocks an ambiguous R binding that has no safe object target', () => {
    const result = projectPaletteColorControl({
      manifest: { ...manifest([]), generatedBy: 'r_svg' },
      resolution: resolution([], {
        targetMode: 'ambiguous',
        ambiguous: [{ reason: 'ambiguous_binding', detail: 'duplicate scale color' }],
      }),
      paletteColor: '#aa3377',
      controlId: 'palette:SERIES',
      allowCodePatch: false,
    });

    expect(result.projection.state).toBe('unsupported');
    expect(result.projection.unsupportedReasons[result.representativeId]).toContain('duplicate scale color');
  });

  it('keeps an explicit Python code target editable while exposing ambiguity as partial', () => {
    const result = projectPaletteColorControl({
      manifest: manifest([]),
      resolution: resolution([], {
        targetMode: 'ambiguous',
        ambiguous: [{ reason: 'ambiguous_binding', detail: 'object identity is ambiguous' }],
      }),
      paletteColor: '#aa3377',
      controlId: 'palette:SERIES',
      allowCodePatch: true,
    });

    expect(result.projection.state).toBe('partial');
    expect(result.projection.counts).toMatchObject({ editable: 1, unsupported: 1, total: 2 });
  });

  it('excludes code-only targets from selected-object controls', () => {
    const collection = object('collection.0', 'facecolor', '#1f78b4');
    const result = projectPaletteColorControl({
      manifest: manifest([collection]),
      resolution: resolution([target(collection.id, 'facecolor', 'code_only')]),
      paletteColor: '#1f78b4',
      controlId: 'palette-subset:SERIES',
      allowCodePatch: false,
      selectedOnly: true,
    });

    expect(result.projection.state).toBe('unsupported');
    expect(result.objectTargets).toEqual([]);
  });
});
