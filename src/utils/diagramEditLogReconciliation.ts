import type { Manifest, ManifestObjectIdentity } from '../schemas/manifest';
import { cloneManifestIdentity, diagramRelationSignature, requiresDiagramRelationIdentity } from './diagramIdentity';
import { supportsObjectProp } from './propertyPatchMode';

export interface DiagramEditEntryLike {
  gid: string;
  prop: string;
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
}

export interface DiagramEditLogReconciliation<T extends DiagramEditEntryLike> {
  editLog: T[];
  remapped: T[];
  unresolved: T[];
}

function hasCompleteExplicitDiagramRelation(identity: ManifestObjectIdentity | undefined): boolean {
  const relation = identity?.relation;
  return Boolean(
    relation
    && typeof relation.diagramId === 'string'
    && relation.diagramId.length > 0
    && typeof relation.diagramType === 'string'
    && relation.diagramType.length > 0
    && typeof relation.diagramObjectId === 'string'
    && relation.diagramObjectId.length > 0,
  );
}

function canonicalizeDiagramEdit<T extends DiagramEditEntryLike>(
  edit: T,
  target: NonNullable<Manifest['objects']>[number],
): T {
  const {
    gid: _gid,
    stableKey: _stableKey,
    fingerprint: _fingerprint,
    fingerprintVersion: _fingerprintVersion,
    identity: _identity,
    ...rest
  } = edit;
  return {
    ...rest,
    gid: target.id,
    prop: edit.prop,
    ...(target.stableKey !== undefined ? { stableKey: target.stableKey } : {}),
    ...(target.fingerprint !== undefined ? { fingerprint: target.fingerprint } : {}),
    ...(target.fingerprintVersion !== undefined
      ? { fingerprintVersion: target.fingerprintVersion }
      : {}),
    ...(target.identity ? { identity: cloneManifestIdentity(target.identity) } : {}),
  } as T;
}

function identityMetadataMatchesTarget(
  edit: DiagramEditEntryLike,
  target: NonNullable<Manifest['objects']>[number],
): boolean {
  return edit.gid === target.id
    && edit.stableKey === target.stableKey
    && edit.fingerprint === target.fingerprint
    && edit.fingerprintVersion === target.fingerprintVersion
    && JSON.stringify(edit.identity) === JSON.stringify(target.identity);
}

/**
 * Refresh stale diagram edit identities after a script rewrite.
 *
 * The semantic relation is the only remapping authority. Appearance, draw
 * order, labels, raw gids, and generic stable keys are deliberately ignored.
 */
export function reconcileDiagramEditLogToManifest<T extends DiagramEditEntryLike>(
  editLog: readonly T[],
  manifest: Manifest | null | undefined,
): DiagramEditLogReconciliation<T> {
  const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
  const remapped: T[] = [];
  const unresolved: T[] = [];

  const nextEditLog = editLog.map((edit) => {
    const relationSignature = diagramRelationSignature(edit.identity);
    if (relationSignature === null) return edit;
    if (!hasCompleteExplicitDiagramRelation(edit.identity)) {
      unresolved.push(edit);
      return edit;
    }

    const candidates = objects.filter((object) => (
      requiresDiagramRelationIdentity(object)
      && diagramRelationSignature(object.identity) === relationSignature
      && supportsObjectProp(object, edit.prop)
    ));
    if (candidates.length !== 1) {
      unresolved.push(edit);
      return edit;
    }

    const target = candidates[0];
    if (identityMetadataMatchesTarget(edit, target)) return edit;
    const canonical = canonicalizeDiagramEdit(edit, target);
    remapped.push(canonical);
    return canonical;
  });

  return { editLog: nextEditLog, remapped, unresolved };
}
