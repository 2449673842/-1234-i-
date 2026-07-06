export type DraftPatchMode = 'local_patch' | 'backend_patch';

export interface DraftPatch {
  gid: string;
  prop: string;
  value: unknown;
  mode: DraftPatchMode;
  // Support code patches
  type?: 'code_patch';
  target_id?: string;
  new_value?: unknown;
  gids?: string[];
}

export interface DraftPatchBatch {
  batchId: string;
  figureIds: string[];
  patches: DraftPatch[];
  status: 'draft' | 'applying' | 'applied' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
