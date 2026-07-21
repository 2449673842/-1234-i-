import type { ManifestObjectIdentity } from './manifest';
import type { EditingIntent } from './editingIntent';

export type DraftPatchMode = 'local_patch' | 'backend_patch';

export interface DraftPatch {
  gid: string;
  prop: string;
  value: unknown;
  matchColor?: string;
  mode: DraftPatchMode;
  /** Identity captured when the draft was created; never overwrite on apply. */
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
  // Support code patches
  type?: 'code_patch';
  target_id?: string;
  new_value?: unknown;
  gids?: string[];
  intent?: EditingIntent;
  /** Figure targets still awaiting a successful retry after a partial apply. */
  pendingFigureIds?: string[];
}

export function draftPatchStorageKey(
  patch: Pick<DraftPatch, 'gid' | 'prop' | 'matchColor'>,
): string {
  const base = `${patch.gid}:${patch.prop}`;
  const matchColor = patch.matchColor?.trim().toLowerCase();
  return matchColor ? `${base}:match:${matchColor}` : base;
}

export interface DraftPatchBatch {
  batchId: string;
  figureIds: string[];
  patches: DraftPatch[];
  status: 'draft' | 'applying' | 'applied' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
