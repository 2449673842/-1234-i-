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

export function propertyCapabilityFor(
  object: ManifestObject | null | undefined,
  prop: string,
): ManifestPropertyCapability | undefined {
  return object?.propertyCapabilities?.find(capability => capability.prop === prop);
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

  const capability = propertyCapabilityFor(object, prop);
  if (capability) {
    return capabilityAllowsExactLocalPreview(capability)
      ? 'local_patch'
      : 'backend_patch';
  }

  if (Array.isArray(object.propertyCapabilities)) return 'backend_patch';
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
