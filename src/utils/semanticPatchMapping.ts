import type { Manifest, ManifestObject } from '../schemas/manifest';
import type { DraftPatch } from '../schemas/draftPatchBatch';

type PatchLike = DraftPatch | {
  gid?: string;
  prop?: string;
  mode?: string;
  type?: string;
  target_id?: string;
  new_value?: unknown;
  gids?: string[];
  value?: unknown;
};

function objectList(manifest: Manifest | null | undefined): ManifestObject[] {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
}

function supportsProp(object: ManifestObject, prop: string | undefined): boolean {
  if (!prop) return true;
  return Array.isArray(object.editable) && object.editable.includes(prop);
}

const FANOUT_KINDS = new Set([
  'axis_x',
  'axis_y',
  'grid',
  'spine',
  'spine_group',
  'line',
  'collection',
  'bar_container',
  'errorbar_container',
  'boxplot_container',
  'violinplot_container',
  'heatmap',
  'colorbar',
  'legend',
]);

const FANOUT_PROPS = new Set([
  'alpha',
  'box_color',
  'capthick',
  'color',
  'edgecolor',
  'elinewidth',
  'facecolor',
  'fontfamily',
  'fontsize',
  'fontstyle',
  'fontweight',
  'frameon',
  'grid_color',
  'grid_linewidth',
  'grid_linestyle',
  'label_color',
  'label_fontsize',
  'linewidth',
  'linestyle',
  'handletextpad',
  'marker',
  'marker_yoffset',
  'markerscale',
  'markersize',
  'labelspacing',
  'median_color',
  'minor_tick_color',
  'minor_tick_length',
  'minor_tick_width',
  'ncol',
  'offset_text_size',
  'sci_notation',
  'show_minor_ticks',
  'tick_color',
  'tick_direction',
  'tick_fontstyle',
  'tick_fontweight',
  'tick_labelcolor',
  'tick_labelfamily',
  'tick_labelsize',
  'tick_length',
  'tick_pad',
  'tick_rotation',
  'tick_width',
  'use_math_text',
  'visible',
  'zorder',
]);

function subplotCount(manifest: Manifest | null | undefined): number {
  return objectList(manifest).filter(object => object.kind === 'subplot').length;
}

function isStyleFanoutCandidate(
  source: ManifestObject,
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
  prop: string | undefined,
): boolean {
  if (!prop || !FANOUT_PROPS.has(prop)) return false;
  if (!FANOUT_KINDS.has(source.kind)) return false;
  return subplotCount(sourceManifest) <= 1 && subplotCount(targetManifest) > 1;
}

function findSourceObject(sourceManifest: Manifest | null | undefined, gid: string | undefined) {
  if (!gid) return null;
  return objectList(sourceManifest).find(object => object.id === gid) || null;
}

function scoreSemanticMatch(source: ManifestObject, target: ManifestObject, prop: string | undefined): number {
  if (!supportsProp(target, prop)) return -1;

  let score = 0;
  if (source.stableKey && target.stableKey && source.stableKey === target.stableKey) score += 100;
  if (source.role && target.role && source.role === target.role) score += 40;
  if (source.kind === target.kind) score += 30;
  if (source.subplotId && target.subplotId && source.subplotId === target.subplotId) score += 20;
  if (source.parentId && target.parentId && source.parentId === target.parentId) score += 5;
  if (source.label && target.label && source.label === target.label) score += 3;

  return score;
}

function semanticFanoutTargets(
  source: ManifestObject,
  targetManifest: Manifest | null | undefined,
  prop: string | undefined,
): ManifestObject[] {
  const targets = objectList(targetManifest)
    .filter(candidate => supportsProp(candidate, prop))
    .filter(candidate => candidate.kind === source.kind)
    .filter(candidate => !source.role || !candidate.role || source.role === candidate.role)
    .filter(candidate => {
      if (source.kind !== 'spine') return true;
      const sourceSide = source.id.match(/^spine\.([^.]+)\./)?.[1];
      const targetSide = candidate.id.match(/^spine\.([^.]+)\./)?.[1];
      return Boolean(sourceSide && targetSide && sourceSide === targetSide);
    });

  if (targets.length <= 1) return targets;

  // One target per subplot for subplot-bound objects. This avoids duplicate
  // legend handles or child artists while still applying frame/tick/line style
  // from a single-panel source figure to every panel in a multi-panel target.
  const seenSubplots = new Set<string>();
  const scoped: ManifestObject[] = [];
  for (const target of targets) {
    const scope = target.subplotId || target.id;
    if (seenSubplots.has(scope)) continue;
    seenSubplots.add(scope);
    scoped.push(target);
  }
  return scoped;
}

export function mapPatchToTargetFigure(
  patch: PatchLike,
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): PatchLike | null {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return null;
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return null;

  const targetObjects = objectList(targetManifest);
  if (isStyleFanoutCandidate(sourceObject, sourceManifest, targetManifest, patch.prop)) {
    const targets = semanticFanoutTargets(sourceObject, targetManifest, patch.prop);
    if (targets.length > 1) {
      return { ...patch, gid: targets[0].id };
    }
  }

  const exactTarget = targetObjects.find(object => object.id === patch.gid && supportsProp(object, patch.prop));
  if (exactTarget) {
    return { ...patch, gid: exactTarget.id };
  }

  let best: { object: ManifestObject; score: number } | null = null;
  for (const candidate of targetObjects) {
    const score = scoreSemanticMatch(sourceObject, candidate, patch.prop);
    if (score < 50) continue;
    if (!best || score > best.score) {
      best = { object: candidate, score };
    }
  }

  return best ? { ...patch, gid: best.object.id } : null;
}

export function mapPatchToTargetFigureMany(
  patch: PatchLike,
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): PatchLike[] {
  if (patch.type === 'code_patch' || patch.gid === 'code_patch') {
    return [];
  }

  const sourceObject = findSourceObject(sourceManifest, patch.gid);
  if (!sourceObject) return [];

  if (isStyleFanoutCandidate(sourceObject, sourceManifest, targetManifest, patch.prop)) {
    const targets = semanticFanoutTargets(sourceObject, targetManifest, patch.prop);
    if (targets.length > 1) {
      return targets.map(target => ({ ...patch, gid: target.id }));
    }
  }

  const mapped = mapPatchToTargetFigure(patch, sourceManifest, targetManifest);
  return mapped ? [mapped] : [];
}

export function mapPatchesToTargetFigure(
  patches: PatchLike[],
  sourceManifest: Manifest | null | undefined,
  targetManifest: Manifest | null | undefined,
): { patches: PatchLike[]; skipped: PatchLike[] } {
  const mapped: PatchLike[] = [];
  const skipped: PatchLike[] = [];

  for (const patch of patches) {
    const next = mapPatchToTargetFigureMany(patch, sourceManifest, targetManifest);
    if (next.length > 0) {
      mapped.push(...next);
    } else {
      skipped.push(patch);
    }
  }

  return { patches: mapped, skipped };
}
