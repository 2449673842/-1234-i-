import type { FigureEntry, SavedEditEntry } from '../types';
import type { EditEntry, Manifest, ManifestObject, RenderResponse } from '../schemas/manifest';
import type {
  FigureEngine,
  FigureLanguage,
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
    identity: object.identity,
    propertyCapabilities: object.propertyCapabilities,
    source: object.source,
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
    mode: entry.mode === 'local_patch' ? 'local_patch' : 'backend_patch',
    timestamp: entry.timestamp ?? 0,
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
