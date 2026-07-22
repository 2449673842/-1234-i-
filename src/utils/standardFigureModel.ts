import type { FigureEntry, SavedEditEntry } from '../types';
import type { EditEntry, Manifest, ManifestObject, RenderDiagnostic, RenderDiagnostics, RenderResponse } from '../schemas/manifest';
import type {
  FigureEngine,
  FigureLanguage,
  StandardFigureCapabilityDetail,
  StandardFigureCapabilityDetailStatus,
  StandardFigureCapabilityState,
  StandardFigureCapabilitySummary,
  StandardFigureInput,
  StandardFigureModel,
  StandardFigureObject,
  StandardFigureProjectModel,
  StandardFigureScientificImpactProp,
} from '../schemas/standardFigureModel';

const SCIENTIFIC_IMPACT_PROP_LABELS: Record<string, string> = {
  limits: '坐标轴范围',
  log: '对数坐标',
  norm: '色阶归一化',
  scale: '比例与刻度',
  levels: '等高线级别',
  vmin: '色阶下限',
  vmax: '色阶上限',
  xlim: 'X 轴范围',
  xscale: 'X 轴刻度',
  ylim: 'Y 轴范围',
  yscale: 'Y 轴刻度',
};

const GENERIC_UNSUPPORTED_NOTE = '部分对象存在额外限制；未通过稳定重放验证的属性不会开放编辑。';

function normalizeDiagnosticWarnings(value: unknown): RenderDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter((warning): warning is RenderDiagnostic => (
    Boolean(warning)
    && typeof warning === 'object'
    && typeof (warning as RenderDiagnostic).type === 'string'
    && typeof (warning as RenderDiagnostic).message === 'string'
  ));
}

export function normalizeRenderDiagnostics(value: Partial<RenderDiagnostics> | undefined): RenderDiagnostics {
  const layoutDiagnosticsMs = Number(value?.layoutDiagnosticsMs);
  return {
    determinismWarnings: normalizeDiagnosticWarnings(value?.determinismWarnings),
    layoutWarnings: normalizeDiagnosticWarnings(value?.layoutWarnings),
    ...(Array.isArray(value?.warningDiagnostics)
      ? { warningDiagnostics: normalizeDiagnosticWarnings(value.warningDiagnostics) }
      : {}),
    ...(value?.runtimeInventory && typeof value.runtimeInventory === 'object'
      ? { runtimeInventory: value.runtimeInventory as Record<string, unknown> }
      : {}),
    ...(Number.isFinite(layoutDiagnosticsMs)
      ? { layoutDiagnosticsMs: Math.max(0, Math.round(layoutDiagnosticsMs)) }
      : {}),
  };
}

function userFacingCapabilityCopy(status: StandardFigureCapabilityDetailStatus): Pick<StandardFigureCapabilityDetail, 'reason' | 'suggestion'> {
  switch (status) {
    case 'flattened':
      return {
        reason: '该对象以简化方式识别，部分专属设置不会显示为独立控件。',
        suggestion: '可继续使用已显示的属性；若需专属参数，请在代码面板中调整后重新渲染。',
      };
    case 'ambiguous':
      return {
        reason: '该对象的类型或归属无法唯一确定，为避免误改，部分设置不可用。',
        suggestion: '请在图层中选择更具体的对象，或在代码面板中调整后重新渲染。',
      };
    case 'unsupported':
      return {
        reason: '该对象暂未提供可视化编辑。',
        suggestion: '可尝试选择其他对象；若需修改该元素，请在代码面板中调整后重新渲染。',
      };
  }
}

function buildScientificImpactProps(objects: ManifestObject[]): StandardFigureScientificImpactProp[] {
  const objectIdsByProp = new Map<string, Set<string>>();
  for (const object of objects) {
    const availableProps = new Set([
      ...Object.keys(object.currentProps ?? {}),
      ...(object.editable ?? []),
      ...(object.propertyCapabilities ?? []).map(capability => capability.prop),
    ]);
    for (const prop of availableProps) {
      if (!SCIENTIFIC_IMPACT_PROP_LABELS[prop]) continue;
      const objectIds = objectIdsByProp.get(prop) ?? new Set<string>();
      objectIds.add(object.id);
      objectIdsByProp.set(prop, objectIds);
    }
  }
  return [...objectIdsByProp.entries()]
    .map(([prop, objectIds]) => ({
      prop,
      label: SCIENTIFIC_IMPACT_PROP_LABELS[prop],
      objectCount: objectIds.size,
    }))
    .sort((a, b) => a.prop.localeCompare(b.prop));
}

function buildCapabilityDetails(manifest: Manifest): StandardFigureCapabilityDetail[] {
  const details = new Map<string, StandardFigureCapabilityDetail>();
  const addDetail = (
    key: string,
    status: StandardFigureCapabilityDetailStatus,
    source: Pick<StandardFigureCapabilityDetail, 'family' | 'sourceClass' | 'sourceCall' | 'editableProps'>,
    count = 1,
  ) => {
    const existing = details.get(key);
    if (existing) {
      existing.count += count;
      return;
    }
    details.set(key, {
      status,
      count,
      editableProps: [...source.editableProps].sort(),
      ...source,
      ...userFacingCapabilityCopy(status),
    });
  };

  for (const object of manifest.objects ?? []) {
    const coverage = object.semanticCoverage;
    if (coverage?.status === 'flattened' || coverage?.status === 'ambiguous') {
      addDetail(
        `semantic:${object.id}`,
        coverage.status,
        {
          family: coverage.family,
          sourceClass: object.source?.artistClass,
          sourceCall: object.source?.callName,
          editableProps: coverage.preservedEditable ?? object.editable ?? [],
        },
      );
    }
    if (objectIsUnsupported(object)) {
      addDetail(
        `unsupported-object:${object.id}`,
        'unsupported',
        {
          family: object.kind,
          sourceClass: object.source?.artistClass,
          sourceCall: object.source?.callName,
          editableProps: [],
        },
      );
    }
  }

  for (const artist of manifest.coverageReport?.complexArtists ?? []) {
    if (artist.status !== 'flattened' && artist.status !== 'ambiguous') continue;
    const key = `semantic:${artist.id}`;
    if (details.has(key)) continue;
    addDetail(
      key,
      artist.status,
      {
        family: artist.family,
        sourceClass: artist.class,
        sourceCall: artist.sourceCall,
        editableProps: artist.preservedEditable ?? [],
      },
    );
  }

  for (const artist of manifest.coverageReport?.unsupportedArtists ?? []) {
    addDetail(
      `unsupported-artist:${artist.class}`,
      'unsupported',
      { sourceClass: artist.class, editableProps: [] },
      Number(artist.count) || 0,
    );
  }

  return [...details.values()].sort((a, b) => (
    a.status.localeCompare(b.status)
    || (a.sourceClass ?? a.family ?? '').localeCompare(b.sourceClass ?? b.family ?? '')
  ));
}

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

function buildKindCapabilitySummary(manifest: Manifest, objects: ManifestObject[]) {
  const objectsByKind = new Map<string, ManifestObject[]>();
  for (const object of objects) {
    const kindObjects = objectsByKind.get(object.kind) ?? [];
    kindObjects.push(object);
    objectsByKind.set(object.kind, kindObjects);
  }

  const reportByKind = manifest.coverageReport?.byKind ?? {};
  const kinds = [
    ...Object.keys(reportByKind),
    ...[...objectsByKind.keys()].filter(kind => !Object.prototype.hasOwnProperty.call(reportByKind, kind)),
  ];
  return kinds
    .map((kind) => {
      const kindObjects = objectsByKind.get(kind) ?? [];
      const propSets = kindObjects.map(object => new Set((object.editable ?? []).map(String)));
      const union = new Set<string>();
      for (const props of propSets) {
        for (const prop of props) union.add(prop);
      }
      const intersection = propSets.length > 0
        ? new Set([...propSets[0]].filter(prop => propSets.slice(1).every(props => props.has(prop))))
        : new Set<string>();
      const variantKeys = new Set(propSets.map(props => [...props].sort().join('\u0000')));
      const detail = reportByKind[kind];
      return {
        kind,
        count: Number(detail?.count) || kindObjects.length,
        editableProps: [...(detail?.editableProps ?? union)].sort(),
        commonEditableProps: [...(detail?.editablePropsIntersection ?? intersection)].sort(),
        variants: detail?.editablePropVariants?.length ?? variantKeys.size,
      };
    });
}

type CapabilityStateInput = Pick<
  StandardFigureCapabilitySummary,
  | 'totalObjects'
  | 'editableObjects'
  | 'readonlyObjects'
  | 'unsupportedObjects'
  | 'unsupportedArtistCount'
  | 'flattenedObjects'
  | 'ambiguousObjects'
>;

function deriveCapabilityState(summary: CapabilityStateInput): StandardFigureCapabilityState {
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
  const semanticObjects = Math.max(
    dedicatedObjects,
    Number(manifest.coverageReport?.summary.semantic) || 0,
  );
  const byKind = buildKindCapabilitySummary(manifest, objects);
  const notes = (manifest.unsupportedNotes ?? []).some(note => String(note).trim().length > 0)
    ? [GENERIC_UNSUPPORTED_NOTE]
    : [];

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
    semanticObjects,
    details: buildCapabilityDetails(manifest),
    scientificImpactProps: buildScientificImpactProps(objects),
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
    diagnostics: normalizeRenderDiagnostics(input.diagnostics ?? manifest.renderDiagnostics),
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
    diagnostics: response.diagnostics ?? response.manifest.renderDiagnostics ?? {
      determinismWarnings: response.determinismWarnings,
      layoutWarnings: response.layoutWarnings,
      warningDiagnostics: response.warningDiagnostics,
      runtimeInventory: response.runtimeInventory,
      layoutDiagnosticsMs: response.timingBreakdown?.layoutDiagnosticsMs,
    },
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
    diagnostics: (figure.manifest as Manifest).renderDiagnostics,
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
