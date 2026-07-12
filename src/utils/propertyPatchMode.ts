import type { EditMode, ManifestObject } from '../schemas/manifest';

export interface PropertyPatchModeRequest {
  generatedBy?: string;
  object?: ManifestObject;
  prop: string;
  legacyLocal: boolean;
}

export function resolvePropertyPatchMode({
  generatedBy,
  object,
  prop,
  legacyLocal,
}: PropertyPatchModeRequest): EditMode {
  const capability = object?.propertyCapabilities?.find(item => item.prop === prop);
  if (capability) return capability.patchMode;
  if (generatedBy === 'r_svg') return 'backend_patch';
  return legacyLocal ? 'local_patch' : 'backend_patch';
}
