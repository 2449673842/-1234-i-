import type { SvgRuntimePatch } from './svgEditor';

export interface AppliedPatchLike {
  type?: unknown;
  mode?: unknown;
  gid?: unknown;
  prop?: unknown;
  value?: unknown;
}

export interface AuthoritativePatchOutcome {
  appliedPatches: AppliedPatchLike[];
  runtimeLocalPatches: SvgRuntimePatch[];
  needsBackendRender: boolean;
}

/** Use server-applied modes when present; submitted modes are only a legacy fallback. */
export function resolveAuthoritativePatchOutcome(
  submittedPatches: AppliedPatchLike[],
  responseApplied: unknown,
): AuthoritativePatchOutcome {
  const appliedPatches = Array.isArray(responseApplied)
    ? responseApplied.filter((patch): patch is AppliedPatchLike => Boolean(patch) && typeof patch === 'object')
    : submittedPatches;
  const needsBackendRender = appliedPatches.some(
    patch => patch.type === 'code_patch' || patch.mode !== 'local_patch',
  );
  const runtimeLocalPatches = appliedPatches
    .filter(
      patch => patch.mode === 'local_patch'
        && typeof patch.gid === 'string'
        && typeof patch.prop === 'string',
    )
    .map(patch => ({
      gid: patch.gid as string,
      prop: patch.prop as string,
      value: patch.value,
    }));

  return { appliedPatches, runtimeLocalPatches, needsBackendRender };
}
