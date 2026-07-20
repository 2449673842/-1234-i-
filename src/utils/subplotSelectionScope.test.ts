import { describe, expect, it } from 'vitest';
import type { StandardFigureObject } from '../schemas/standardFigureModel';
import { getObjectSubplotId, resolveSelectionSubplotScope } from './subplotSelectionScope';

function object(input: Partial<StandardFigureObject> & Pick<StandardFigureObject, 'id' | 'kind'>): StandardFigureObject {
  return {
    label: input.id,
    editable: [],
    currentProps: {},
    ...input,
  } as StandardFigureObject;
}

const objects = [
  object({ id: 'subplot.0', kind: 'subplot' }),
  object({ id: 'subplot.1', kind: 'subplot' }),
  object({ id: 'title.0', kind: 'text', identity: { relation: { subplotId: 'subplot.0' } } as any }),
  object({ id: 'line.0', kind: 'line', subplotId: 'subplot.0' }),
  object({ id: 'line.1', kind: 'line', source: { axesIndex: 1 } as any }),
  object({ id: 'shared.legend', kind: 'legend', identity: { relation: { subplotIds: ['subplot.0', 'subplot.1'] } } as any }),
];

describe('subplot selection scope', () => {
  it('resolves subplot, relation, and source ownership', () => {
    expect(getObjectSubplotId(objects[0])).toBe('subplot.0');
    expect(getObjectSubplotId(objects[2])).toBe('subplot.0');
    expect(getObjectSubplotId(objects[4])).toBe('subplot.1');
  });

  it('follows a single object or multiple objects in the same subplot', () => {
    expect(resolveSelectionSubplotScope(objects, [], 'title.0')).toBe('subplot.0');
    expect(resolveSelectionSubplotScope(objects, ['title.0', 'line.0'], 'title.0')).toBe('subplot.0');
  });

  it('uses all for cross-subplot, shared, missing, and Figure selections', () => {
    expect(resolveSelectionSubplotScope(objects, ['line.0', 'line.1'], 'line.0')).toBe('all');
    expect(resolveSelectionSubplotScope(objects, ['shared.legend'], 'shared.legend')).toBe('all');
    expect(resolveSelectionSubplotScope(objects, ['missing'], 'missing')).toBe('all');
    expect(resolveSelectionSubplotScope(objects, [], 'Figure')).toBe('all');
  });

  it.each([
    ['polar', 'polar'],
    ['3d', '3d'],
    ['inset', 'rectilinear'],
  ])('resolves a %s panel from its own trusted relation subplot id', (axesFamily, projection) => {
    const panel = object({
      id: `subplot.${axesFamily}.0`,
      kind: 'axes',
      source: { axesIndex: 0 } as any,
      identity: {
        relation: {
          subplotId: `subplot.${axesFamily}.0`,
          axesFamily,
          projection,
          parentSubplotId: 'subplot.0',
          ownerSubplotId: `subplot.${axesFamily}.0`,
        },
      } as any,
    });

    expect(getObjectSubplotId(panel)).toBe(`subplot.${axesFamily}.0`);
    expect(resolveSelectionSubplotScope([panel], [panel.id], panel.id)).toBe(`subplot.${axesFamily}.0`);
  });

  it('resolves secondary axes to the trusted parent subplot', () => {
    const secondaryAxis = object({
      id: 'axis.y.secondary.0',
      kind: 'axis_y',
      source: { axesIndex: 3, ownerAxesIndex: 3 } as any,
      identity: {
        relation: {
          axesFamily: 'secondary_y',
          projection: 'rectilinear',
          parentSubplotId: 'subplot.0',
          ownerSubplotId: 'subplot.secondary_y.0',
        },
      } as any,
    });

    expect(getObjectSubplotId(secondaryAxis)).toBe('subplot.0');
    expect(resolveSelectionSubplotScope([secondaryAxis], [secondaryAxis.id], secondaryAxis.id)).toBe('subplot.0');
  });

  it('does not infer an ordinary subplot for unsupported axes without a trusted relation', () => {
    const unsupportedAxes = object({
      id: 'axes.unsupported.0',
      kind: 'unsupported',
      source: { axesIndex: 1, artistClass: 'mpl_toolkits.axes_grid1.parasite_axes.AxesHostAxes' } as any,
    });

    expect(getObjectSubplotId(unsupportedAxes)).toBeNull();
    expect(resolveSelectionSubplotScope([unsupportedAxes], [unsupportedAxes.id], unsupportedAxes.id)).toBe('all');
  });
});
