import type { EditMode, ManifestObject } from '../schemas/manifest';

const TEXT_CONTENT_PROPS = new Set(['text', 'content']);
const TEXT_CONTENT_ALIAS_PROPS = new Set(['label', 'title']);
const TEXT_CONTENT_ALIAS_KINDS = new Set(['text', 'legend', 'axis_x', 'axis_y', 'colorbar']);

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

export function resolvePropertyPatchMode({
  generatedBy,
  object,
  prop,
  legacyLocal,
}: PropertyPatchModeRequest): EditMode {
  if (isTextContentPatchProp(prop, object)) return 'backend_patch';
  const capability = object?.propertyCapabilities?.find(item => item.prop === prop);
  if (capability) return capability.patchMode;
  if (generatedBy === 'r_svg') return 'backend_patch';
  return legacyLocal ? 'local_patch' : 'backend_patch';
}
