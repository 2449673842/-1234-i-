import { describe, expect, it } from 'vitest';
import type { StandardFigureObject } from '../schemas/standardFigureModel';
import { resolveExplicitColorbarOwner } from './colorbarOwnership';

function object(
  id: string,
  kind: string,
  relation?: StandardFigureObject['identity'] extends infer Identity
    ? Identity extends { relation?: infer Relation }
      ? Relation
      : never
    : never,
): StandardFigureObject {
  return {
    id,
    kind,
    label: id,
    editable: [],
    props: {},
    currentProps: {},
    identity: {
      instanceKey: `instance:${id}`,
      semanticKey: `semantic:${id}`,
      relation,
    },
  };
}

describe('explicit colorbar ownership', () => {
  it('keeps two heatmap/colorbar pairs isolated by reciprocal relationships', () => {
    const objects = [
      object('subplot.0', 'subplot'),
      object('subplot.1', 'subplot'),
      object('heatmap.image.0.0', 'heatmap', { subplotId: 'subplot.0', colorbarId: 'colorbar.2' }),
      object('heatmap.image.1.0', 'heatmap', { subplotId: 'subplot.1', colorbarId: 'colorbar.3' }),
      object('colorbar.2', 'colorbar', { subplotId: 'subplot.0', mappableId: 'heatmap.image.0.0' }),
      object('colorbar.3', 'colorbar', { subplotId: 'subplot.1', mappableId: 'heatmap.image.1.0' }),
    ];

    expect(resolveExplicitColorbarOwner(objects[4], objects)).toEqual({
      status: 'resolved', subplotId: 'subplot.0', subplotIds: ['subplot.0'], source: 'colorbar_relation',
    });
    expect(resolveExplicitColorbarOwner(objects[5], objects)).toEqual({
      status: 'resolved', subplotId: 'subplot.1', subplotIds: ['subplot.1'], source: 'colorbar_relation',
    });
  });

  it('preserves a shared colorbar as a multi-subplot relationship', () => {
    const objects = [
      object('subplot.0', 'subplot'),
      object('subplot.1', 'subplot'),
      object('heatmap.image.0.0', 'heatmap', { subplotId: 'subplot.0', colorbarId: 'colorbar.2' }),
      object('heatmap.image.1.0', 'heatmap', { subplotId: 'subplot.1', colorbarId: 'colorbar.2' }),
      object('colorbar.2', 'colorbar', {
        subplotIds: ['subplot.0', 'subplot.1'],
        mappableId: 'heatmap.image.0.0',
        mappableIds: ['heatmap.image.0.0', 'heatmap.image.1.0'],
      }),
    ];

    expect(resolveExplicitColorbarOwner(objects[4], objects)).toEqual({
      status: 'resolved_shared',
      subplotIds: ['subplot.0', 'subplot.1'],
      source: 'colorbar_relation',
    });
  });

  it('rejects shared mappable relationships that omit an owner subplot', () => {
    const objects = [
      object('subplot.0', 'subplot'),
      object('subplot.1', 'subplot'),
      object('heatmap.image.0.0', 'heatmap', { subplotId: 'subplot.0', colorbarId: 'colorbar.2' }),
      object('heatmap.image.1.0', 'heatmap', { subplotId: 'subplot.1', colorbarId: 'colorbar.2' }),
      object('colorbar.2', 'colorbar', {
        subplotIds: ['subplot.0'],
        mappableId: 'heatmap.image.0.0',
        mappableIds: ['heatmap.image.0.0', 'heatmap.image.1.0'],
      }),
    ];

    expect(resolveExplicitColorbarOwner(objects[4], objects).status).toBe('invalid');
  });

  it('rejects a shared relationship that omits the mappable subplot', () => {
    const objects = [
      object('subplot.0', 'subplot'),
      object('subplot.1', 'subplot'),
      object('heatmap.image.0.0', 'heatmap', { subplotId: 'subplot.0', colorbarId: 'colorbar.2' }),
      object('colorbar.2', 'colorbar', {
        subplotIds: ['subplot.1'],
        mappableId: 'heatmap.image.0.0',
      }),
    ];

    expect(resolveExplicitColorbarOwner(objects[3], objects).status).toBe('invalid');
  });

  it('rejects conflicting reciprocal relations instead of guessing by geometry', () => {
    const objects = [
      object('subplot.0', 'subplot'),
      object('heatmap.image.0.0', 'heatmap', { subplotId: 'subplot.0', colorbarId: 'colorbar.other' }),
      object('colorbar.2', 'colorbar', { subplotId: 'subplot.0', mappableId: 'heatmap.image.0.0' }),
    ];

    expect(resolveExplicitColorbarOwner(objects[2], objects).status).toBe('invalid');
  });

  it('returns absent for legacy manifests so callers may use compatibility geometry', () => {
    const legacyColorbar: StandardFigureObject = {
      id: 'colorbar.1',
      kind: 'colorbar',
      label: 'legacy',
      editable: [],
      props: {},
      currentProps: {},
    };
    expect(resolveExplicitColorbarOwner(legacyColorbar, [legacyColorbar])).toEqual({ status: 'absent' });
  });
});
