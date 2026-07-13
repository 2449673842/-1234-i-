import type { ManifestCoordinateSpace, ManifestEditScope, ManifestObjectKind } from './manifest';

export type CanonicalPropertyKey =
  | 'fontfamily'
  | 'fontsize'
  | 'fontweight'
  | 'fontstyle'
  | 'color'
  | 'rotation'
  | 'ha'
  | 'va'
  | 'visible'
  | 'alpha'
  | 'linewidth'
  | 'left'
  | 'bottom'
  | 'width'
  | 'height'
  | 'aspect'
  | 'position';

export type PropertyDescriptorValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'color'
  | 'select'
  | 'object';

export type EditingCenterId =
  | 'properties'
  | 'layout'
  | 'components'
  | 'palette'
  | 'fonts';

export type PropertyFamily =
  | 'typography'
  | 'text_layout'
  | 'appearance'
  | 'visibility'
  | 'stroke'
  | 'layout_geometry'
  | 'position';

export type PropertyControlType =
  | 'font'
  | 'number'
  | 'select'
  | 'color'
  | 'toggle'
  | 'position';

export type ProjectedPropertyState =
  | 'editable'
  | 'partial'
  | 'readonly'
  | 'unsupported'
  | 'mixed';

export type ProjectedObjectPropertyState = 'editable' | 'readonly' | 'unsupported';

export type ProjectedPropertyCoordinateSpace = ManifestCoordinateSpace | 'mixed';

export interface PropertyDescriptor {
  key: CanonicalPropertyKey;
  label: string;
  family: PropertyFamily;
  valueType: PropertyDescriptorValueType;
  control: PropertyControlType;
  unit?: 'pt' | 'deg' | 'ratio' | 'none';
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  centers: readonly EditingCenterId[];
  props: readonly string[];
  coordinateSpace?: ManifestCoordinateSpace;
  aliases?: Partial<Record<ManifestObjectKind | 'text' | 'tick_label', readonly string[]>>;
}

export interface ProjectedPropertyCounts {
  total: number;
  editable: number;
  readonly: number;
  unsupported: number;
  conditional: number;
  legacyFallback: number;
}

export interface ProjectedPropertyDescriptor {
  descriptor: PropertyDescriptor;
  key: CanonicalPropertyKey;
  state: ProjectedPropertyState;
  counts: ProjectedPropertyCounts;
  scope: ManifestEditScope;
  coordinateSpace?: ProjectedPropertyCoordinateSpace;
  mixed: boolean;
  stateByObjectId: Record<string, ProjectedObjectPropertyState>;
  coordinateSpaceByObjectId?: Record<string, ManifestCoordinateSpace | undefined>;
  propByObjectId: Record<string, string | undefined>;
  value: unknown;
  valuesByObjectId: Record<string, unknown>;
  unsupportedReasons: Record<string, string | undefined>;
}

export interface PropertyProjectionRequest {
  center: EditingCenterId;
  objects: readonly import('./manifest').ManifestObject[];
  semanticRole?: import('./editingIntent').SemanticTargetRole;
  scope?: ManifestEditScope;
  allowLegacyFallback?: boolean;
  resolvedPropByKey?: Partial<Record<CanonicalPropertyKey, Readonly<Record<string, string | undefined>>>>;
}
