import type { FigureEntry, SavedEditEntry } from '../types';
import type { EditEntry, Manifest, ManifestObject, RenderResponse } from '../schemas/manifest';
import type {
  FigureEngine,
  FigureLanguage,
  StandardFigureCapabilityState,
  StandardFigureCapabilitySummary,
  StandardFigureInput,
  StandardFigureModel,
  StandardFigureObject,
  StandardFigureProjectModel,
} from '../schemas/standardFigureModel';

export function inferFigureEngine(manifest: Manifest | null | undefined, language?: FigureLanguage): FigureEngine {
  if (language === 'r' || manifest?.generatedBy === 'r_svg') {
    return 'r_ggplot';
  }
  if (language === 'python' || manifest?.generatedBy === 'introspection') {
    return 'python_matplotlib';
  }
  return 'unknown';
}

export function normalizeFigureObject(object: ManifestObject): StandardFigureObject {
  const currentProps = object.currentProps ?? {};
  return {
    id: object.id,
    kind: object.kind,
    label: object.label,
    editable: object.editable ?? [],
    props: currentProps,
    currentProps,
    role: object.role,
    subplotId: object.subplotId,
    subplotIds: object.subplotIds,
    parentId: object.parentId,
    children: object.children,
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: object.identity,
    propertyCapabilities: object.propertyCapabilities,
    semanticCoverage: object.semanticCoverage,
    source: object.source,
  };
}

function objectHasEditableCapability(object: ManifestObject): boolean {
  if (Array.isArray(object.propertyCapabilities)) {
    return object.propertyCapabilities.some(capability => capability.replay !== 'unsupported');
  }
  return Array.isArray(object.editable) && object.editable.length > 0;
}

function objectIsUnsupported(object: ManifestObject): boolean {
  return object.kind === 'unsupported'
    || object.kind === 'unsupported_axes'
    || Boolean(object.currentProps?.unsupportedReason);
}

function sumUnsupportedArtists(manifest: Manifest): number {
  return (manifest.coverageReport?.unsupportedArtists ?? [])
    .reduce((total, item) => total + (Number(item.count) || 0), 0);
}

function deriveCapabilityState(summary: Omit<StandardFigureCapabilitySummary, 'state'>): StandardFigureCapabilityState {
  if (summary.totalObjects === 0) return 'unsupported';
  if (summary.editableObjects === 0) {
    return summary.unsupportedObjects > 0 || summary.unsupportedArtistCount > 0
      ? 'unsupported'
      : 'readonly';
  }
  if (
    summary.readonlyObjects > 0
    || summary.unsupportedObjects > 0
    || summary.unsupportedArtistCount > 0
    || summary.flattenedObjects > 0
    || summary.ambiguousObjects > 0
  ) {
    return 'partial';
  }
  return 'editable';
}

export function buildCapabilitySummary(manifest: Manifest): StandardFigureCapabilitySummary {
  const objects = manifest.objects ?? [];
  const editableObjects = objects.filter(objectHasEditableCapability).length;
  const unsupportedObjects = objects.filter(objectIsUnsupported).length;
  const readonlyObjects = Math.max(0, objects.length - editableObjects - unsupportedObjects);
  const complexRows = manifest.coverageReport?.complexArtists ?? [];
  const dedicatedObjects = Math.max(
    objects.filter(object => object.semanticCoverage?.status === 'dedicated').length,
    complexRows.filter(row => row.status === 'dedicated').length,
    Number(manifest.coverageReport?.summary.dedicated) || 0,
  );
  const flattenedObjects = Math.max(
    objects.filter(object => object.semanticCoverage?.status === 'flattened').length,
    complexRows.filter(row => row.status === 'flattened').length,
    Number(manifest.coverageReport?.summary.flattened) || 0,
  );
  const ambiguousObjects = Math.max(
    objects.filter(object => object.semanticCoverage?.status === 'ambiguous').length,
    complexRows.filter(row => row.status === 'ambiguous').length,
    Number(manifest.coverageReport?.summary.ambiguous) || 0,
  );
  const unsupportedArtistCount = sumUnsupportedArtists(manifest);
  const byKind = Object.entries(manifest.coverageReport?.byKind ?? {})
    .map(([kind, detail]) => ({
      kind,
      count: Number(detail.count) || 0,
      editableProps: [...(detail.editableProps ?? [])].sort(),
      commonEditableProps: [...(detail.editablePropsIntersection ?? [])].sort(),
      variants: detail.editablePropVariants?.length ?? 0,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const notes = [
    ...(manifest.unsupportedNotes ?? []),
    ...complexRows
      .filter(row => row.status !== 'dedicated')
      .map(row => `${row.family}: ${row.reason}`),
  ].filter(Boolean);

  const partialSummary = {
    totalObjects: objects.length,
    editableObjects,
    readonlyObjects,
    unsupportedObjects,
    dedicatedObjects,
    flattenedObjects,
    ambiguousObjects,
    unsupportedArtistCount,
    byKind,
    notes,
  };

  return {
    state: deriveCapabilityState(partialSummary),
    ...partialSummary,
  };
}

export function normalizeFigureModel(input: StandardFigureInput): StandardFigureModel {
  const manifest = input.manifest;
  return {
    schemaVersion: '1.0',
    figureId: input.figureId ?? 'fig_1',
    engine: inferFigureEngine(manifest, input.language),
    language: input.language,
    revision: input.revision ?? 0,
    svg: input.svg ?? '',
    manifest,
    globals: manifest.globals ?? {},
    objects: (manifest.objects ?? []).map(normalizeFigureObject),
    colorGroups: manifest.colorGroups ?? [],
    palettes: manifest.palettes ?? [],
    groups: manifest.groups ?? [],
    bindings: manifest.bindings ?? [],
    capabilities: manifest.capabilities ?? {
      localPatch: false,
      backendPatch: false,
      codePatch: false,
    },
    capabilitySummary: buildCapabilitySummary(manifest),
    coverageReport: manifest.coverageReport,
    unsupportedNotes: manifest.unsupportedNotes ?? [],
    editLog: input.editLog ?? [],
    fingerprint: input.fingerprint,
    codeSlice: input.codeSlice,
    warnings: input.warnings ?? [],
  };
}

function normalizeSavedEditLog(editLog: SavedEditEntry[] | undefined): EditEntry[] {
  return (editLog ?? []).map((entry) => ({
    gid: entry.gid,
    prop: entry.prop,
    value: entry.value,
    ...(entry.matchColor ? { matchColor: entry.matchColor } : {}),
    mode: entry.mode === 'local_patch' ? 'local_patch' : 'backend_patch',
    timestamp: entry.timestamp ?? 0,
    matchColor: entry.matchColor,
    stableKey: entry.stableKey,
    fingerprint: entry.fingerprint,
    fingerprintVersion: entry.fingerprintVersion,
    identity: entry.identity,
  }));
}

export function normalizeRenderResponse(response: RenderResponse, figureId = 'fig_1'): StandardFigureModel {
  return normalizeFigureModel({
    figureId,
    language: response.language,
    svg: response.svg,
    manifest: response.manifest,
    revision: response.revision,
    editLog: response.editLog,
    warnings: response.message ? [response.message] : [],
  });
}

export function normalizeProjectFigure(
  figure: FigureEntry,
  language?: FigureLanguage,
): StandardFigureModel | null {
  if (!figure.manifest) {
    return null;
  }
  return normalizeFigureModel({
    figureId: figure.figureId,
    language,
    svg: figure.svg,
    manifest: figure.manifest as Manifest,
    revision: figure.revision,
    editLog: normalizeSavedEditLog(figure.editLog),
    fingerprint: figure.fingerprint,
    codeSlice: figure.codeSlice,
  });
}

export function normalizeProjectFigures(
  projectId: string,
  figures: FigureEntry[] | Record<string, FigureEntry>,
  language?: FigureLanguage,
): StandardFigureProjectModel {
  const figureList = Array.isArray(figures) ? figures : Object.values(figures);
  return {
    schemaVersion: '1.0',
    projectId,
    figures: figureList
      .map((figure) => normalizeProjectFigure(figure, language))
      .filter((figure): figure is StandardFigureModel => figure !== null),
  };
}
