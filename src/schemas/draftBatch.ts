import { PatchEntry } from './manifest';

export interface DraftPatchValue {
  gid: string;
  prop: string;
  value: unknown;
  mode: 'local_patch' | 'backend_patch';
  timestamp: number;
}

/**
 * Draft updates for a single figure, mapped by `${gid}:${prop}` to enforce last-write-wins.
 */
export type DraftFigureBucket = Record<string, DraftPatchValue>;

/**
 * Draft updates for the entire project, bucketed by `figureId`.
 */
export type DraftProjectBucket = Record<string, DraftFigureBucket>;
