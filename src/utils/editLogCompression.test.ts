import { describe, expect, it } from 'vitest';
import { compressEditLogEntries } from './editLogCompression';

describe('editLog compression', () => {
  it('keeps the latest ordinary property value', () => {
    expect(compressEditLogEntries([
      { gid: 'line.0', prop: 'linewidth', value: 1 },
      { gid: 'line.0', prop: 'linewidth', value: 2 },
    ])).toEqual([{ gid: 'line.0', prop: 'linewidth', value: 2 }]);
  });

  it('preserves independent and chained mixed-color subset edits', () => {
    const blueToCyan = { gid: 'collection.0', prop: 'facecolor', matchColor: '#0F3CF0', value: '#1188ff' };
    const redToMagenta = { gid: 'collection.0', prop: 'facecolor', matchColor: '#D62728', value: '#cc44aa' };
    const cyanToGreen = { gid: 'collection.0', prop: 'facecolor', matchColor: '#1188FF', value: '#22aa77' };

    expect(compressEditLogEntries([blueToCyan, redToMagenta, cyanToGreen])).toEqual([
      blueToCyan,
      redToMagenta,
      cyanToGreen,
    ]);
  });

  it('preserves repeated subset writes because later edits can depend on their output', () => {
    const blueToCyan = { gid: 'collection.0', prop: 'facecolor', matchColor: '#0f3cf0', value: '#1188ff' };
    const cyanToGreen = { gid: 'collection.0', prop: 'facecolor', matchColor: '#1188ff', value: '#22aa77' };
    const staleBlueToPurple = { gid: 'collection.0', prop: 'facecolor', matchColor: '#0F3CF0', value: '#aa55cc' };

    expect(compressEditLogEntries([
      blueToCyan,
      cyanToGreen,
      staleBlueToPurple,
    ])).toEqual([
      blueToCyan,
      cyanToGreen,
      staleBlueToPurple,
    ]);
  });
});
