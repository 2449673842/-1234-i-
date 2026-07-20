import type {
  EditMode,
  Manifest,
  ManifestObject,
  ManifestPropertyCapability,
} from '../schemas/manifest';

const TEXT_CONTENT_PROPS = new Set(['text', 'content']);
const TEXT_CONTENT_ALIAS_PROPS = new Set(['label', 'title']);
const TEXT_CONTENT_ALIAS_KINDS = new Set(['text', 'legend', 'axis_x', 'axis_y', 'colorbar']);
const LEGACY_LOCAL_PROPS = new Set([
  'text',
  'color',
  'facecolor',
  'edgecolor',
  'alpha',
  'visible',
]);

export interface PropertyPatchModeRequest {
  generatedBy?: string;
  object?: ManifestObject;
  prop: string;
  legacyLocal: boolean;
}

export function isTextContentPatchProp(prop: string, object?: Pick<ManifestObject, 'kind'>): boolean {
  if (TEXT_CONTENT_PROPS.has(prop)) return true;
  return TEXT_CONTENT_ALIAS_PROPS.has(prop) && Boolean(object && TEXT_CONTENT_ALIAS_KINDS.has(object.kind));
}

function unsupportedProps(object: ManifestObject): string[] {
  const value = object.currentProps?.unsupportedProps;
  return Array.isArray(value) ? value.map(String) : [];
}

export function isContourObject(object: ManifestObject | null | undefined): boolean {
  return object?.kind === 'contour' || object?.kind === 'contourf';
}

export function isContourStructuralProp(prop: string): boolean {
  return ['levels', 'x', 'y', 'z'].includes(prop.toLowerCase());
}

const PYTHON_STRUCTURAL_SERIES_PROPS: Record<string, Set<string>> = {
  histogram_series: new Set([
    'bins',
    'counts',
    'values',
    'edges',
    'density',
    'cumulative',
    'orientation',
    'weights',
    'weighted',
    'histtype',
    'stacked',
    'bottom',
    'range',
    'align',
    'rwidth',
    'log',
  ]),
  stairs_series: new Set([
    'values',
    'edges',
    'baseline',
  ]),
  step_series: new Set([
    'x',
    'y',
    'xdata',
    'ydata',
    'where',
    'drawstyle',
    'interpolation',
  ]),
  pie_slice: new Set([
    'values',
    'value',
    'fraction',
    'center',
    'radius',
    'theta1',
    'theta2',
    'width',
    'explode',
    'startangle',
    'counterclock',
    'normalize',
    'labeldistance',
    'pctdistance',
  ]),
  wedge_slice: new Set([
    'center',
    'radius',
    'theta1',
    'theta2',
    'width',
  ]),
  quiver_field: new Set([
    'x',
    'y',
    'u',
    'v',
    'c',
    'scale',
    'scale_units',
    'angles',
    'pivot',
    'units',
    'width',
    'headwidth',
    'headlength',
    'headaxislength',
    'minshaft',
    'minlength',
  ]),
  streamplot_field: new Set([
    'x',
    'y',
    'u',
    'v',
    'density',
    'start_points',
    'integration_direction',
    'maxlength',
    'minlength',
    'broken_streamlines',
  ]),
  diagram_node: new Set([
    'diagram_id',
    'diagram_type',
    'node_id',
    'data',
    'x',
    'y',
  ]),
  diagram_edge: new Set([
    'diagram_id',
    'diagram_type',
    'edge_id',
    'source_node_id',
    'target_node_id',
    'direction',
    'path',
    'vertices',
    'control_points',
  ]),
  diagram_arrow: new Set([
    'diagram_id',
    'diagram_type',
    'edge_id',
    'source_node_id',
    'target_node_id',
    'direction',
    'path',
    'vertices',
    'control_points',
  ]),
  diagram_node_label: new Set(['text', 'node_id']),
  diagram_coefficient_label: new Set([
    'text',
    'edge_id',
    'coefficient',
    'value',
    'p_value',
    'pvalue',
    'significance',
    'confidence_interval',
    'ci_low',
    'ci_high',
  ]),
  diagram_fit_annotation: new Set([
    'text',
    'fit',
    'fit_indices',
    'cfi',
    'tli',
    'rmsea',
    'srmr',
    'aic',
    'bic',
    'chi_square',
    'p_value',
    'pvalue',
  ]),
  diagram_group: new Set([
    'diagram_id',
    'diagram_type',
    'members',
    'node_ids',
  ]),
};

export function isPythonStructuralSeriesProp(
  object: ManifestObject | null | undefined,
  prop: string,
): boolean {
  const role = object?.role;
  if (!role) return false;
  return PYTHON_STRUCTURAL_SERIES_PROPS[role]?.has(prop.toLowerCase()) === true;
}

export function isParentOwnedManifestObject(
  object: ManifestObject | null | undefined,
): boolean {
  return object?.role === 'contour_child_collection'
    || object?.currentProps?.parentOwned === true;
}

export function propertyCapabilityFor(
  object: ManifestObject | null | undefined,
  prop: string,
): ManifestPropertyCapability | undefined {
  if (isPythonStructuralSeriesProp(object, prop)) return undefined;
  return object?.propertyCapabilities?.find(capability => capability.prop === prop);
}

export function hasAuthoritativePropertyCapabilities(
  object: ManifestObject | null | undefined,
): boolean {
  return Array.isArray(object?.propertyCapabilities);
}

export function resolveCrossFigurePolicy(
  objects: Array<ManifestObject | null | undefined>,
  prop: string,
): 'allow' | 'deny' {
  if (objects.length === 0) return 'deny';
  return objects.every((object) => {
    if (isPythonStructuralSeriesProp(object, prop)) return false;
    const capability = propertyCapabilityFor(object, prop);
    return capability?.replay !== 'unsupported'
      && capability?.scopes.includes('cross_figure') === true;
  }) ? 'allow' : 'deny';
}

function capabilityAllowsExactLocalPreview(capability: ManifestPropertyCapability): boolean {
  return capability.patchMode === 'local_patch'
    && capability.preview === 'exact'
    && capability.replay === 'stable';
}

function legacyLocalPatchAllowed(object: ManifestObject, prop: string): boolean {
  if (!LEGACY_LOCAL_PROPS.has(prop)) return false;
  if (!object.editable.includes(prop)) return false;
  if (unsupportedProps(object).includes(prop)) return false;
  if (object.kind === 'grid' && prop === 'visible') return false;
  if (prop === 'text') return ['text', 'xtick', 'ytick'].includes(object.kind);
  if (['text', 'xtick', 'ytick'].includes(object.kind)) return prop === 'color';
  if (prop === 'visible') return true;
  return ['line', 'patch', 'collection', 'spine'].includes(object.kind);
}

export function resolvePatchMode(
  manifest: Manifest | null | undefined,
  object: ManifestObject | null | undefined,
  prop: string,
): EditMode {
  if (!manifest || !object || manifest.generatedBy === 'r_svg') return 'backend_patch';
  if (isTextContentPatchProp(prop, object)) return 'backend_patch';
  if (object.kind === 'grid' && prop === 'visible') return 'backend_patch';
  if (isContourObject(object)) return 'backend_patch';
  if (isPythonStructuralSeriesProp(object, prop)) return 'backend_patch';

  const capability = propertyCapabilityFor(object, prop);
  if (capability) {
    return capabilityAllowsExactLocalPreview(capability)
      ? 'local_patch'
      : 'backend_patch';
  }

  // Once an object advertises the v2 capability protocol, an omitted property
  // is intentionally not editable through the local compatibility path.
  if (hasAuthoritativePropertyCapabilities(object)) return 'backend_patch';
  return legacyLocalPatchAllowed(object, prop) ? 'local_patch' : 'backend_patch';
}

export function resolveAuthoritativeProjectPatchMode(
  manifest: Manifest | null | undefined,
  object: ManifestObject | null | undefined,
  prop: string,
): EditMode {
  if (!manifest || manifest.generatedBy === 'r_svg' || !object) return 'backend_patch';
  if (!Array.isArray(object.propertyCapabilities)) return 'backend_patch';
  if (isTextContentPatchProp(prop, object)) return 'backend_patch';
  if (object.kind === 'heatmap' && prop === 'alpha') return 'backend_patch';

  const capability = propertyCapabilityFor(object, prop);
  return capability && capabilityAllowsExactLocalPreview(capability)
    ? 'local_patch'
    : 'backend_patch';
}

export function resolvePatchModeById(
  manifest: Manifest | null | undefined,
  gid: string,
  prop: string,
): EditMode {
  const object = manifest?.objects?.find(candidate => candidate.id === gid);
  return resolvePatchMode(manifest, object, prop);
}

export function resolvePropertyPatchMode({
  generatedBy,
  object,
  prop,
  legacyLocal,
}: PropertyPatchModeRequest): EditMode {
  if (isTextContentPatchProp(prop, object)) return 'backend_patch';
  const capability = propertyCapabilityFor(object, prop);
  if (capability) return capability.patchMode;
  if (generatedBy === 'r_svg') return 'backend_patch';
  return legacyLocal ? 'local_patch' : 'backend_patch';
}
