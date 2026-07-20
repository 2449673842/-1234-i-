import type {
  Binding,
  ColorGroup,
  CoverageReport,
  EditEntry,
  Manifest,
  ManifestField,
  ManifestObject,
  ManifestObjectIdentity,
  ManifestPropertyCapability,
  Palette,
  RenderDiagnostics,
  SemanticGroup,
} from './manifest';
import type { FigureCodeSlice } from '../types';

export type FigureEngine = 'python_matplotlib' | 'r_ggplot' | 'unknown';

export type FigureLanguage = 'python' | 'r';

export interface StandardFigureObject {
  id: string;
  kind: string;
  label: string;
  editable: string[];
  props: Record<string, unknown>;
  currentProps: Record<string, unknown>;
  role?: string;
  subplotId?: string;
  subplotIds?: string[];
  parentId?: string;
  children?: string[];
  stableKey?: string;
  fingerprint?: string;
  fingerprintVersion?: number;
  identity?: ManifestObjectIdentity;
  propertyCapabilities?: ManifestPropertyCapability[];
  semanticCoverage?: ManifestObject['semanticCoverage'];
  source?: ManifestObject['source'];
}

export interface StandardFigureCapabilities {
  localPatch: boolean;
  backendPatch: boolean;
  codePatch: boolean;
}

export type StandardFigureCapabilityState =
  | 'editable'
  | 'partial'
  | 'readonly'
  | 'unsupported';

export interface StandardFigureKindCapabilitySummary {
  kind: string;
  count: number;
  editableProps: string[];
  commonEditableProps: string[];
  variants: number;
}

export type StandardFigureCapabilityDetailStatus = 'flattened' | 'ambiguous' | 'unsupported';

export interface StandardFigureCapabilityDetail {
  status: StandardFigureCapabilityDetailStatus;
  family?: string;
  sourceClass?: string;
  sourceCall?: string;
  count: number;
  editableProps: string[];
  reason: string;
  suggestion: string;
}

export interface StandardFigureScientificImpactProp {
  prop: string;
  label: string;
  objectCount: number;
}

export interface StandardFigureCapabilitySummary {
  state: StandardFigureCapabilityState;
  totalObjects: number;
  editableObjects: number;
  readonlyObjects: number;
  unsupportedObjects: number;
  dedicatedObjects: number;
  flattenedObjects: number;
  ambiguousObjects: number;
  unsupportedArtistCount: number;
  byKind: StandardFigureKindCapabilitySummary[];
  notes: string[];
  semanticObjects: number;
  details: StandardFigureCapabilityDetail[];
  scientificImpactProps: StandardFigureScientificImpactProp[];
}

export interface StandardFigureModel {
  schemaVersion: '1.0';
  figureId: string;
  engine: FigureEngine;
  language?: FigureLanguage;
  revision: number;
  svg: string;
  manifest: Manifest;
  globals: Record<string, ManifestField>;
  objects: StandardFigureObject[];
  colorGroups: ColorGroup[];
  palettes: Palette[];
  groups: SemanticGroup[];
  bindings: Binding[];
  capabilities: StandardFigureCapabilities;
  capabilitySummary: StandardFigureCapabilitySummary;
  coverageReport?: CoverageReport;
  unsupportedNotes: string[];
  editLog: EditEntry[];
  fingerprint?: string;
  codeSlice?: FigureCodeSlice | null;
  warnings: string[];
  diagnostics: RenderDiagnostics;
}

export interface StandardFigureProjectModel {
  schemaVersion: '1.0';
  projectId: string;
  figures: StandardFigureModel[];
}

export interface StandardFigureInput {
  figureId?: string;
  language?: FigureLanguage;
  svg?: string;
  manifest: Manifest;
  revision?: number;
  editLog?: EditEntry[];
  fingerprint?: string;
  codeSlice?: FigureCodeSlice | null;
  warnings?: string[];
  diagnostics?: RenderDiagnostics;
}
