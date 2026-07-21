import type { DraftPatch } from '../schemas/draftPatchBatch';

export interface DraftTransactionJob {
  targetId: string;
  draftKeys: string[];
}

export interface DraftTransactionJobResult {
  targetId: string;
  success: boolean;
}

export interface DraftTransactionSettlement {
  nextBucket: Record<string, DraftPatch>;
  completedDraftKeys: string[];
  pendingDraftKeys: string[];
  failedTargetIds: string[];
}

function stableDraftValue(value: unknown): string {
  if (value === undefined) return '__undefined__';
  try {
    return JSON.stringify(value, Object.keys(value as Record<string, unknown> || {}).sort());
  } catch {
    return String(value);
  }
}

function normalizeMatchColor(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function isSameDraftPatch(current: DraftPatch | undefined, snapshot: DraftPatch): boolean {
  if (!current) return false;
  return current.gid === snapshot.gid
    && current.prop === snapshot.prop
    && current.mode === snapshot.mode
    && normalizeMatchColor(current.matchColor) === normalizeMatchColor(snapshot.matchColor)
    && current.type === snapshot.type
    && current.target_id === snapshot.target_id
    && stableDraftValue(current.value) === stableDraftValue(snapshot.value)
    && stableDraftValue(current.new_value) === stableDraftValue(snapshot.new_value)
    && stableDraftValue(current.gids) === stableDraftValue(snapshot.gids)
    && stableDraftValue(current.pendingFigureIds) === stableDraftValue(snapshot.pendingFigureIds);
}

export function mergeDraftSettlement(
  currentBucket: Record<string, DraftPatch>,
  snapshotBucket: Record<string, DraftPatch>,
  settledSnapshotBucket: Record<string, DraftPatch>,
): Record<string, DraftPatch> {
  const nextBucket = { ...currentBucket };
  Object.entries(snapshotBucket).forEach(([draftKey, snapshotDraft]) => {
    if (!isSameDraftPatch(currentBucket[draftKey], snapshotDraft)) return;
    const settledDraft = settledSnapshotBucket[draftKey];
    if (settledDraft) {
      nextBucket[draftKey] = settledDraft;
    } else {
      delete nextBucket[draftKey];
    }
  });
  return nextBucket;
}

export function draftAppliesToFigure(draft: DraftPatch, figureId: string): boolean {
  return !draft.pendingFigureIds?.length || draft.pendingFigureIds.includes(figureId);
}

export function draftsEligibleForDirectPersistence(drafts: DraftPatch[]): DraftPatch[] {
  return drafts.filter(draft => (
    draft.mode === 'local_patch'
    && draft.type !== 'code_patch'
    && !draft.pendingFigureIds?.length
  ));
}

export function draftsRequiringEngineApply(drafts: DraftPatch[]): DraftPatch[] {
  const directDrafts = new Set(draftsEligibleForDirectPersistence(drafts));
  return drafts.filter(draft => !directDrafts.has(draft));
}

export function settleDraftTransaction(
  sourceBucket: Record<string, DraftPatch>,
  jobs: DraftTransactionJob[],
  results: DraftTransactionJobResult[],
): DraftTransactionSettlement {
  const resultByTarget = new Map(results.map(result => [result.targetId, result.success]));
  const attemptsByDraft = new Map<string, Set<string>>();

  jobs.forEach((job) => {
    job.draftKeys.forEach((draftKey) => {
      const targets = attemptsByDraft.get(draftKey) ?? new Set<string>();
      targets.add(job.targetId);
      attemptsByDraft.set(draftKey, targets);
    });
  });

  const nextBucket: Record<string, DraftPatch> = {};
  const completedDraftKeys: string[] = [];
  const pendingDraftKeys: string[] = [];
  const failedTargetIds = new Set<string>();

  Object.entries(sourceBucket).forEach(([draftKey, draft]) => {
    const attemptedTargets = Array.from(attemptsByDraft.get(draftKey) ?? []);
    if (attemptedTargets.length === 0) {
      nextBucket[draftKey] = draft;
      pendingDraftKeys.push(draftKey);
      return;
    }

    const failedTargets = attemptedTargets.filter(targetId => resultByTarget.get(targetId) !== true);
    if (failedTargets.length === 0) {
      completedDraftKeys.push(draftKey);
      return;
    }

    failedTargets.forEach(targetId => failedTargetIds.add(targetId));
    nextBucket[draftKey] = {
      ...draft,
      pendingFigureIds: failedTargets,
    };
    pendingDraftKeys.push(draftKey);
  });

  return {
    nextBucket,
    completedDraftKeys,
    pendingDraftKeys,
    failedTargetIds: Array.from(failedTargetIds).sort(),
  };
}
