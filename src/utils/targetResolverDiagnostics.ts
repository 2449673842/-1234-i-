import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest } from '../schemas/manifest';
import {
  compareTargetResolverWithCurrentCompiler,
  type TargetResolverShadowComparison,
} from './targetResolver';
import { EDITING_FEATURE_FLAGS } from './editingFeatureFlags';

export interface TargetResolverShadowDiagnostic {
  schemaVersion: 1;
  resolverVersion: 'v2';
  releaseCandidateId: string;
  id: string;
  createdAt: number;
  source: string;
  generatedBy: Manifest['generatedBy'];
  intent: EditingIntent['intent'];
  prop: string;
  selectionMode: EditingIntent['scope']['selectionMode'];
  targetRole?: EditingIntent['scope']['targetRole'];
  requestedObjectIds: string[];
  equivalent: boolean;
  currentPatchKeys: string[];
  shadowPatchKeys: string[];
  currentOnlyPatchKeys: string[];
  shadowOnlyPatchKeys: string[];
  ambiguousCount: number;
  skippedCount: number;
}

interface RecordDiagnosticOptions {
  enabled?: boolean;
  log?: boolean;
}

export interface TargetResolverShadowEvidence {
  schemaVersion: 1;
  generatedAt: number;
  releaseCandidateId: string;
  total: number;
  equivalent: number;
  divergent: number;
  diagnostics: TargetResolverShadowDiagnostic[];
}

export const TARGET_RESOLVER_SHADOW_STORAGE_KEY = 'scifigure:target-resolver-shadow:v1';
const MAX_DIAGNOSTICS = 500;
const diagnostics: TargetResolverShadowDiagnostic[] = [];
let hydrated = false;

function persistentStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return globalThis.localStorage as Storage;
    }
  } catch {
    return null;
  }
  return null;
}

function isStoredDiagnostic(value: unknown): value is TargetResolverShadowDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TargetResolverShadowDiagnostic>;
  return item.schemaVersion === 1
    && item.resolverVersion === 'v2'
    && typeof item.releaseCandidateId === 'string'
    && typeof item.id === 'string'
    && typeof item.createdAt === 'number'
    && typeof item.source === 'string'
    && typeof item.prop === 'string'
    && typeof item.equivalent === 'boolean'
    && Array.isArray(item.requestedObjectIds)
    && Array.isArray(item.currentPatchKeys)
    && Array.isArray(item.shadowPatchKeys)
    && Array.isArray(item.currentOnlyPatchKeys)
    && Array.isArray(item.shadowOnlyPatchKeys);
}

function hydrateDiagnostics(): void {
  if (hydrated) return;
  hydrated = true;
  const storage = persistentStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(TARGET_RESOLVER_SHADOW_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { diagnostics?: unknown[] };
    const stored = Array.isArray(parsed?.diagnostics)
      ? parsed.diagnostics
        .filter(isStoredDiagnostic)
        .filter(item => item.releaseCandidateId === EDITING_FEATURE_FLAGS.releaseCandidateId)
        .slice(0, MAX_DIAGNOSTICS)
      : [];
    diagnostics.push(...stored);
  } catch {
    storage.removeItem(TARGET_RESOLVER_SHADOW_STORAGE_KEY);
  }
}

function persistDiagnostics(): void {
  const storage = persistentStorage();
  if (!storage) return;
  try {
    storage.setItem(TARGET_RESOLVER_SHADOW_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      updatedAt: Date.now(),
      diagnostics,
    }));
  } catch {
    // Diagnostics are non-blocking and must never interrupt editing.
  }
}

function environmentEnabled(): boolean {
  return EDITING_FEATURE_FLAGS.targetResolverShadow;
}

function toDiagnostic(
  manifest: Manifest,
  intent: EditingIntent,
  source: string,
  comparison: TargetResolverShadowComparison,
): TargetResolverShadowDiagnostic {
  return {
    schemaVersion: 1,
    resolverVersion: 'v2',
    releaseCandidateId: EDITING_FEATURE_FLAGS.releaseCandidateId,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    source,
    generatedBy: manifest.generatedBy,
    intent: intent.intent,
    prop: intent.operation.prop,
    selectionMode: intent.scope.selectionMode,
    targetRole: intent.scope.targetRole,
    requestedObjectIds: [...(intent.scope.objectIds ?? [])],
    equivalent: comparison.equivalent,
    currentPatchKeys: comparison.currentPatchKeys,
    shadowPatchKeys: comparison.shadowPatchKeys,
    currentOnlyPatchKeys: comparison.currentOnlyPatchKeys,
    shadowOnlyPatchKeys: comparison.shadowOnlyPatchKeys,
    ambiguousCount: comparison.resolution.ambiguous.length,
    skippedCount: comparison.resolution.skipped.length,
  };
}

export function recordTargetResolverShadowDiagnostic(
  manifest: Manifest,
  intent: EditingIntent,
  source: string,
  options: RecordDiagnosticOptions = {},
): TargetResolverShadowDiagnostic | null {
  const enabled = options.enabled ?? environmentEnabled();
  if (!enabled) return null;

  hydrateDiagnostics();
  const comparison = compareTargetResolverWithCurrentCompiler(manifest, intent);
  const diagnostic = toDiagnostic(manifest, intent, source, comparison);
  diagnostics.unshift(diagnostic);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS;
  persistDiagnostics();

  if ((options.log ?? true) && !diagnostic.equivalent) {
    console.info('[TargetResolverShadow] target difference', diagnostic);
  }
  return diagnostic;
}

export function getTargetResolverShadowDiagnostics(): TargetResolverShadowDiagnostic[] {
  hydrateDiagnostics();
  return diagnostics
    .filter(item => item.releaseCandidateId === EDITING_FEATURE_FLAGS.releaseCandidateId)
    .map(item => ({
    ...item,
    requestedObjectIds: [...item.requestedObjectIds],
    currentPatchKeys: [...item.currentPatchKeys],
    shadowPatchKeys: [...item.shadowPatchKeys],
    currentOnlyPatchKeys: [...item.currentOnlyPatchKeys],
    shadowOnlyPatchKeys: [...item.shadowOnlyPatchKeys],
    }));
}

export function getTargetResolverShadowEvidence(): TargetResolverShadowEvidence {
  const items = getTargetResolverShadowDiagnostics();
  const equivalent = items.filter(item => item.equivalent).length;
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    releaseCandidateId: EDITING_FEATURE_FLAGS.releaseCandidateId,
    total: items.length,
    equivalent,
    divergent: items.length - equivalent,
    diagnostics: items,
  };
}

export function clearTargetResolverShadowDiagnostics(): void {
  hydrateDiagnostics();
  diagnostics.length = 0;
  const storage = persistentStorage();
  if (storage) {
    try {
      storage.removeItem(TARGET_RESOLVER_SHADOW_STORAGE_KEY);
    } catch {
      // Clearing diagnostics remains best-effort in restricted browsers.
    }
  }
}
