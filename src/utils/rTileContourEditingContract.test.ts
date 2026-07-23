import { describe, expect, it } from 'vitest';
import type { EditingIntent, SemanticTargetRole } from '../schemas/editingIntent';
import type {
  Manifest,
  ManifestObject,
  ManifestPropertyCapability,
  RLayerAdapterClass,
} from '../schemas/manifest';
import { supportsComponentBatchProp } from '../components/RightSidebar';
import { inferEditingTargetRole } from './editingIntentCompiler';
import { compileEditingIntentStrict } from './targetResolver';

const capability = (prop: string, scopes: ManifestPropertyCapability['scopes'] = ['object']) => ({
  prop,
  patchMode: 'backend_patch' as const,
  scopes,
  preview: 'none' as const,
  replay: 'stable' as const,
});

function rObject(input: {
  id: string;
  kind: ManifestObject['kind'];
  role: string;
  adapterClass: RLayerAdapterClass;
  editable: string[];
  currentProps: Record<string, unknown>;
  subplotId?: string;
}): ManifestObject {
  return {
    id: input.id,
    kind: input.kind,
    label: input.id,
    role: input.role,
    editable: input.editable,
    currentProps: input.currentProps,
    identity: {
      semanticKey: `${input.role}:layer:${input.id}`,
      instanceKey: `r:${input.id}`,
      seriesKey: `r-series:${input.id}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: {
        subplotId: input.subplotId || 'subplot.0',
        layerKey: `${input.role}:PositionIdentity:${input.id}`,
      },
    },
    propertyCapabilities: input.editable.map(prop => capability(prop)),
    source: {
      artistClass: input.adapterClass,
      adapterClass: input.adapterClass,
      axesIndex: 0,
    },
  };
}

function manifest(objects: ManifestObject[]): Manifest {
  return {
    generatedBy: 'r_svg',
    objects,
    globals: {},
    groups: [],
    colorGroups: [],
    palettes: [],
    bindings: [],
    capabilities: { localPatch: false, backendPatch: true, codePatch: false },
    unsupportedNotes: [],
  };
}

function intent(
  objectIds: string[],
  targetKinds: ManifestObject['kind'][],
  targetRole: SemanticTargetRole,
  prop: string,
  value: unknown,
): EditingIntent {
  return {
    intent: 'style.component',
    scope: {
      selectionMode: 'explicit_objects',
      objectIds,
      targetKinds,
      targetRole,
    },
    operation: { prop, value },
    commit: { mode: 'draft', applyAsOneHistoryStep: true },
    fallback: { onUnsupported: 'skip_with_warning' },
  };
}

describe('R tile, raster, rect, contour, and contourf editing contract', () => {
  it('infers dedicated contour target roles from contour parents', () => {
    const contour = rObject({
      id: 'r.layer.contour.0',
      kind: 'contour',
      role: 'ggplot_GeomContour',
      adapterClass: 'GeomContour',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.8, cmap: 'viridis', vmin: 0, vmax: 1 },
    });
    const contourf = rObject({
      id: 'r.layer.contourf.0',
      kind: 'contourf',
      role: 'ggplot_GeomContourFilled',
      adapterClass: 'GeomContourFilled',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.6, cmap: 'magma', vmin: -1, vmax: 1 },
    });

    expect(inferEditingTargetRole(contour)).toBe('data_contour');
    expect(inferEditingTargetRole(contourf)).toBe('data_contourf');
  });

  it('keeps contour and contourf editable props authoritative and backend patched', () => {
    const contour = rObject({
      id: 'r.layer.contour.1',
      kind: 'contour',
      role: 'ggplot_GeomContour',
      adapterClass: 'GeomContour',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.75, cmap: 'viridis', vmin: 0, vmax: 1 },
    });
    const contourf = rObject({
      id: 'r.layer.contourf.1',
      kind: 'contourf',
      role: 'ggplot_GeomContourFilled',
      adapterClass: 'GeomContourFilled',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.55, cmap: 'magma', vmin: -1, vmax: 2 },
    });
    const model = manifest([contour, contourf]);

    const cases: Array<{
      object: ManifestObject;
      role: SemanticTargetRole;
      prop: string;
      value: unknown;
    }> = [
      { object: contour, role: 'data_contour', prop: 'alpha', value: 0.4 },
      { object: contour, role: 'data_contour', prop: 'cmap', value: 'plasma' },
      { object: contour, role: 'data_contour', prop: 'vmin', value: -0.25 },
      { object: contour, role: 'data_contour', prop: 'vmax', value: 1.25 },
      { object: contourf, role: 'data_contourf', prop: 'alpha', value: 0.35 },
      { object: contourf, role: 'data_contourf', prop: 'cmap', value: 'inferno' },
      { object: contourf, role: 'data_contourf', prop: 'vmin', value: -0.5 },
      { object: contourf, role: 'data_contourf', prop: 'vmax', value: 1.5 },
    ];

    for (const testCase of cases) {
      expect(supportsComponentBatchProp(testCase.object, testCase.prop, 'r_svg')).toBe(true);
      expect(
        compileEditingIntentStrict(
          model,
          intent([testCase.object.id], [testCase.object.kind], testCase.role, testCase.prop, testCase.value),
        ),
      ).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{
          gid: testCase.object.id,
          prop: testCase.prop,
          value: testCase.value,
          mode: 'backend_patch',
        }],
      });
    }
  });

  it('rejects contour structural props from the modern capability contract', () => {
    const contour = rObject({
      id: 'r.layer.contour.2',
      kind: 'contour',
      role: 'ggplot_GeomContour',
      adapterClass: 'GeomContour',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.75, cmap: 'viridis', vmin: 0, vmax: 1 },
    });
    const contourf = rObject({
      id: 'r.layer.contourf.2',
      kind: 'contourf',
      role: 'ggplot_GeomContourFilled',
      adapterClass: 'GeomContourFilled',
      editable: ['alpha', 'cmap', 'vmin', 'vmax'],
      currentProps: { alpha: 0.55, cmap: 'magma', vmin: -1, vmax: 2 },
    });
    const model = manifest([contour, contourf]);

    for (const prop of ['levels', 'x', 'y', 'z', 'bins', 'breaks']) {
      expect(supportsComponentBatchProp(contour, prop, 'r_svg')).toBe(false);
      expect(supportsComponentBatchProp(contourf, prop, 'r_svg')).toBe(false);

      expect(
        compileEditingIntentStrict(
          model,
          intent([contour.id], ['contour'], 'data_contour', prop, 1),
        ),
      ).toMatchObject({
        strategy: 'strict',
        patches: [],
        skipped: [expect.objectContaining({ gid: contour.id, reason: 'unsupported_prop' })],
      });
      expect(
        compileEditingIntentStrict(
          model,
          intent([contourf.id], ['contourf'], 'data_contourf', prop, 1),
        ),
      ).toMatchObject({
        strategy: 'strict',
        patches: [],
        skipped: [expect.objectContaining({ gid: contourf.id, reason: 'unsupported_prop' })],
      });
    }
  });

  it('keeps mapped tile, raster, and rect on renderer-declared safe props only', () => {
    const tile = rObject({
      id: 'r.layer.tile.0',
      kind: 'patch',
      role: 'ggplot_GeomTile',
      adapterClass: 'GeomTile',
      editable: ['edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#c7e9c0',
        edgecolor: '#238b45',
        linewidth: 0.8,
        alpha: 0.9,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const raster = rObject({
      id: 'r.layer.raster.0',
      kind: 'patch',
      role: 'ggplot_GeomRaster',
      adapterClass: 'GeomRaster',
      editable: ['alpha'],
      currentProps: {
        facecolor: '#9ecae1',
        alpha: 0.8,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const rect = rObject({
      id: 'r.layer.rect.0',
      kind: 'patch',
      role: 'ggplot_GeomRect',
      adapterClass: 'GeomRect',
      editable: ['edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#fdae6b',
        edgecolor: '#e6550d',
        linewidth: 1.1,
        alpha: 0.85,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const model = manifest([tile, raster, rect]);

    expect(supportsComponentBatchProp(tile, 'facecolor', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(tile, 'edgecolor', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(tile, 'linewidth', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(tile, 'alpha', 'r_svg')).toBe(true);

    expect(supportsComponentBatchProp(raster, 'facecolor', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(raster, 'alpha', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(raster, 'edgecolor', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(raster, 'linewidth', 'r_svg')).toBe(false);

    expect(supportsComponentBatchProp(rect, 'facecolor', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(rect, 'edgecolor', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(rect, 'linewidth', 'r_svg')).toBe(true);
    expect(supportsComponentBatchProp(rect, 'alpha', 'r_svg')).toBe(true);

    for (const [object, prop, value] of [
      [tile, 'edgecolor', '#31a354'],
      [tile, 'linewidth', 1.2],
      [raster, 'alpha', 0.65],
      [rect, 'edgecolor', '#d94801'],
      [rect, 'linewidth', 1.6],
    ] as const) {
      const role = inferEditingTargetRole(object);
      expect(
        compileEditingIntentStrict(
          model,
          intent([object.id], [object.kind], role, prop, value),
        ),
      ).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{ gid: object.id, prop, value, mode: 'backend_patch' }],
      });
    }

    expect(
      compileEditingIntentStrict(
        model,
        intent([tile.id], ['patch'], 'data_patch', 'facecolor', '#a1d99b'),
      ),
    ).toMatchObject({
      strategy: 'strict',
      patches: [],
      skipped: [expect.objectContaining({ gid: tile.id, reason: 'unsupported_prop' })],
    });

    expect(supportsComponentBatchProp(tile, 'cmap', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(tile, 'vmin', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(tile, 'vmax', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(raster, 'cmap', 'r_svg')).toBe(false);
    expect(supportsComponentBatchProp(rect, 'cmap', 'r_svg')).toBe(false);
  });

  it('allows unmapped tile and rect fill edits without confusing mapped fill contracts', () => {
    const tile = rObject({
      id: 'r.layer.tile.unmapped',
      kind: 'patch',
      role: 'ggplot_GeomTile',
      adapterClass: 'GeomTile',
      editable: ['facecolor', 'edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#c7e9c0',
        edgecolor: '#238b45',
        linewidth: 0.8,
        alpha: 0.9,
        fillMapped: false,
        scaleControlled: false,
      },
    });
    const rect = rObject({
      id: 'r.layer.rect.unmapped',
      kind: 'patch',
      role: 'ggplot_GeomRect',
      adapterClass: 'GeomRect',
      editable: ['facecolor', 'edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#fdae6b',
        edgecolor: '#e6550d',
        linewidth: 1.1,
        alpha: 0.85,
        fillMapped: false,
        scaleControlled: false,
      },
    });
    const model = manifest([tile, rect]);

    for (const object of [tile, rect]) {
      expect(supportsComponentBatchProp(object, 'facecolor', 'r_svg')).toBe(true);
      expect(
        compileEditingIntentStrict(
          model,
          intent([object.id], ['patch'], 'data_patch', 'facecolor', '#a1d99b'),
        ),
      ).toMatchObject({
        strategy: 'strict',
        skipped: [],
        patches: [{ gid: object.id, prop: 'facecolor', value: '#a1d99b', mode: 'backend_patch' }],
      });
    }
  });

  it('does not let continuous scale controls spill from contour targets to tile or raster objects', () => {
    const contour = rObject({
      id: 'r.layer.contour.3',
      kind: 'contour',
      role: 'ggplot_GeomContour',
      adapterClass: 'GeomContour',
      editable: ['cmap', 'vmin', 'vmax'],
      currentProps: { cmap: 'viridis', vmin: 0, vmax: 1 },
    });
    const contourf = rObject({
      id: 'r.layer.contourf.3',
      kind: 'contourf',
      role: 'ggplot_GeomContourFilled',
      adapterClass: 'GeomContourFilled',
      editable: ['cmap', 'vmin', 'vmax'],
      currentProps: { cmap: 'magma', vmin: -1, vmax: 1 },
    });
    const tile = rObject({
      id: 'r.layer.tile.1',
      kind: 'patch',
      role: 'ggplot_GeomTile',
      adapterClass: 'GeomTile',
      editable: ['edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#c7e9c0',
        edgecolor: '#238b45',
        linewidth: 0.8,
        alpha: 0.9,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const raster = rObject({
      id: 'r.layer.raster.1',
      kind: 'patch',
      role: 'ggplot_GeomRaster',
      adapterClass: 'GeomRaster',
      editable: ['alpha'],
      currentProps: {
        facecolor: '#9ecae1',
        alpha: 0.8,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const rect = rObject({
      id: 'r.layer.rect.1',
      kind: 'patch',
      role: 'ggplot_GeomRect',
      adapterClass: 'GeomRect',
      editable: ['edgecolor', 'linewidth', 'alpha'],
      currentProps: {
        facecolor: '#fdae6b',
        edgecolor: '#e6550d',
        linewidth: 1.1,
        alpha: 0.85,
        fillMapped: true,
        scaleControlled: true,
      },
    });
    const model = manifest([contour, contourf, tile, raster, rect]);

    const contourIntent = intent(
      [contour.id, contourf.id, tile.id, raster.id, rect.id],
      ['contour', 'contourf', 'patch'],
      'data_contour',
      'cmap',
      'plasma',
    );
    const contourfIntent = intent(
      [contour.id, contourf.id, tile.id, raster.id, rect.id],
      ['contour', 'contourf', 'patch'],
      'data_contourf',
      'vmax',
      1.5,
    );

    expect(compileEditingIntentStrict(model, contourIntent)).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: contour.id, prop: 'cmap', value: 'plasma', mode: 'backend_patch' }],
    });

    expect(compileEditingIntentStrict(model, contourfIntent)).toMatchObject({
      strategy: 'strict',
      skipped: [],
      patches: [{ gid: contourf.id, prop: 'vmax', value: 1.5, mode: 'backend_patch' }],
    });
  });
});
