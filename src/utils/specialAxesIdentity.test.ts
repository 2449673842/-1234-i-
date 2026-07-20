import { describe, expect, it } from 'vitest';
import {
  hasSpecialAxesRelation,
  requiresSpecialAxesRelationIdentity,
  specialAxesRelationSignature,
} from './specialAxesIdentity';

describe('special axes identity', () => {
  it('returns a canonical signature for a complete special axes relation', () => {
    expect(specialAxesRelationSignature({
      relation: {
        axesFamily: 'polar',
        projection: 'polar',
        parentSubplotId: 'subplot.0',
        ownerSubplotId: 'subplot.polar.0',
      },
    } as any)).toBe(
      'axesFamily=polar;projection=polar;parentSubplotId=subplot.0;ownerSubplotId=subplot.polar.0',
    );
  });

  it.each([
    ['missing axes family', { projection: 'polar', parentSubplotId: 'subplot.0', ownerSubplotId: 'subplot.polar.0' }],
    ['missing projection', { axesFamily: 'polar', parentSubplotId: 'subplot.0', ownerSubplotId: 'subplot.polar.0' }],
    ['missing parent subplot', { axesFamily: 'polar', projection: 'polar', ownerSubplotId: 'subplot.polar.0' }],
    ['missing owner subplot', { axesFamily: 'polar', projection: 'polar', parentSubplotId: 'subplot.0' }],
    ['malformed value', { axesFamily: 'polar', projection: 'polar', parentSubplotId: 'subplot.0', ownerSubplotId: 0 }],
  ])('returns null for %s', (_label, relation) => {
    expect(specialAxesRelationSignature({ relation } as any)).toBeNull();
    expect(hasSpecialAxesRelation({ relation } as any)).toBe(false);
  });

  it('detects a complete special axes relation', () => {
    expect(hasSpecialAxesRelation({
      relation: {
        axesFamily: 'inset',
        projection: 'rectilinear',
        parentSubplotId: 'subplot.0',
        ownerSubplotId: 'subplot.inset.0',
      },
    } as any)).toBe(true);
  });

  it('requires relation identity for special axes objects', () => {
    expect(requiresSpecialAxesRelationIdentity({
      id: 'axis.y.secondary.0',
      kind: 'axis_y',
      role: 'secondary_y_axis',
      label: 'Secondary Y',
      editable: ['label'],
      currentProps: {},
      identity: {
        relation: {
          axesFamily: 'secondary_y',
          projection: 'rectilinear',
          parentSubplotId: 'subplot.0',
          ownerSubplotId: 'subplot.secondary_y.0',
        },
      },
    } as any)).toBe(true);
  });

  it('does not require relation identity for legacy objects without special axes metadata', () => {
    expect(requiresSpecialAxesRelationIdentity({
      id: 'axis.y.0',
      kind: 'axis_y',
      role: 'y_axis',
      label: 'Y',
      editable: ['label'],
      currentProps: {},
      subplotId: 'subplot.0',
    } as any)).toBe(false);
  });
});
