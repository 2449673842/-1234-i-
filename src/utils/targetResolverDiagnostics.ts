import type { EditingIntent } from '../schemas/editingIntent';
import type { Manifest } from '../schemas/manifest';
import {
  compareTargetResolverWithCurrentCompiler,
  type TargetResolverShadowComparison,
} from './targetResolver';

export interface TargetResolverShadowDiagnostic {
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

const MAX_DIAGNOSTICS = 100;
const diagnostics: TargetResolverShadowDiagnostic[] = [];

function environmentEnabled(): boolean {
  const env = (import.meta as ImportMeta & {
    env?: { DEV?: boolean; VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW?: string };
  }).env;
  return Boolean(
    env?.DEV
    && env.VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW === '1',
  );
}

function toDiagnostic(
  manifest: Manifest,
  intent: EditingIntent,
  source: string,
  comparison: TargetResolverShadowComparison,
): TargetResolverShadowDiagnostic {
  return {
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

  const comparison = compareTargetResolverWithCurrentCompiler(manifest, intent);
  const diagnostic = toDiagnostic(manifest, intent, source, comparison);
  diagnostics.unshift(diagnostic);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS;

  if ((options.log ?? true) && !diagnostic.equivalent) {
    console.info('[TargetResolverShadow] target difference', diagnostic);
  }
  return diagnostic;
}

export function getTargetResolverShadowDiagnostics(): TargetResolverShadowDiagnostic[] {
  return diagnostics.map(item => ({
    ...item,
    requestedObjectIds: [...item.requestedObjectIds],
    currentPatchKeys: [...item.currentPatchKeys],
    shadowPatchKeys: [...item.shadowPatchKeys],
    currentOnlyPatchKeys: [...item.currentOnlyPatchKeys],
    shadowOnlyPatchKeys: [...item.shadowOnlyPatchKeys],
  }));
}

export function clearTargetResolverShadowDiagnostics(): void {
  diagnostics.length = 0;
}
