import type { SemanticTargetRole } from '../schemas/editingIntent';
import type { Manifest, ManifestEditScope, ManifestObject } from '../schemas/manifest';
import type {
  EditingCenterId,
  ProjectedPropertyCounts,
  ProjectedPropertyState,
} from '../schemas/propertyDescriptor';
import { projectPropertyDescriptors } from './propertyDescriptors';

export interface PropertyProjectionSummary {
  key: string;
  state: ProjectedPropertyState;
  counts: ProjectedPropertyCounts;
  resolvedProps: string[];
}

export interface PropertyProjectionShadowDiagnostic {
  id: string;
  createdAt: number;
  generatedBy: Manifest['generatedBy'];
  center: EditingCenterId;
  scope: ManifestEditScope;
  objectCount: number;
  objectKinds: Record<string, number>;
  protocolCompleteCount: number;
  summaries: PropertyProjectionSummary[];
}

interface RecordPropertyProjectionOptions {
  enabled?: boolean;
  log?: boolean;
  scope?: ManifestEditScope;
  semanticRole?: SemanticTargetRole;
}

const MAX_DIAGNOSTICS = 100;
const diagnostics: PropertyProjectionShadowDiagnostic[] = [];

export function propertyDescriptorShadowEnabled(
  env: { DEV?: boolean; VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1?: string } | undefined = (
    import.meta as ImportMeta & {
      env?: { DEV?: boolean; VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1?: string };
    }
  ).env,
): boolean {
  return env?.VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1 === '1';
}

function defaultScope(center: EditingCenterId): ManifestEditScope {
  return center === 'properties' || center === 'layout' ? 'object' : 'group';
}

function cloneCounts(counts: ProjectedPropertyCounts): ProjectedPropertyCounts {
  return { ...counts };
}

export function recordPropertyProjectionShadowDiagnostic(
  manifest: Manifest,
  center: EditingCenterId,
  objects: readonly ManifestObject[],
  options: RecordPropertyProjectionOptions = {},
): PropertyProjectionShadowDiagnostic | null {
  const enabled = options.enabled ?? propertyDescriptorShadowEnabled();
  if (!enabled) return null;

  const scope = options.scope ?? defaultScope(center);
  const projections = projectPropertyDescriptors({
    center,
    objects,
    semanticRole: options.semanticRole,
    scope,
  });
  const objectKinds = objects.reduce<Record<string, number>>((counts, object) => {
    counts[object.kind] = (counts[object.kind] ?? 0) + 1;
    return counts;
  }, {});
  const diagnostic: PropertyProjectionShadowDiagnostic = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    generatedBy: manifest.generatedBy,
    center,
    scope,
    objectCount: objects.length,
    objectKinds,
    protocolCompleteCount: objects.filter(object => Array.isArray(object.propertyCapabilities)).length,
    summaries: projections.map(projection => ({
      key: projection.key,
      state: projection.state,
      counts: cloneCounts(projection.counts),
      resolvedProps: Array.from(new Set(Object.values(projection.propByObjectId).filter(Boolean) as string[])).sort(),
    })),
  };

  diagnostics.unshift(diagnostic);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS;

  if (options.log ?? true) {
    const partialCount = diagnostic.summaries.filter(summary => summary.state === 'partial').length;
    const legacyCount = diagnostic.summaries.reduce((sum, summary) => sum + summary.counts.legacyFallback, 0);
    if (partialCount > 0 || legacyCount > 0) {
      console.info('[PropertyDescriptorShadow] projection summary', {
        center,
        scope,
        objectCount: diagnostic.objectCount,
        partialCount,
        legacyCount,
      });
    }
  }
  return diagnostic;
}

export function getPropertyProjectionShadowDiagnostics(): PropertyProjectionShadowDiagnostic[] {
  return diagnostics.map(diagnostic => ({
    ...diagnostic,
    objectKinds: { ...diagnostic.objectKinds },
    summaries: diagnostic.summaries.map(summary => ({
      ...summary,
      counts: cloneCounts(summary.counts),
      resolvedProps: [...summary.resolvedProps],
    })),
  }));
}

export function clearPropertyProjectionShadowDiagnostics(): void {
  diagnostics.length = 0;
}
