import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Baseline, Lock, Layout, Palette, Sliders } from 'lucide-react';
import { FigureSession, PatchEntry, ManifestObject, ManifestField, Binding } from '../schemas/manifest';
import { normalizeFigureModel } from '../utils/standardFigureModel';
import { resolveFigureId } from '../utils/figureIdentity';
import { compileEditingIntent } from '../utils/editingIntentCompiler';
import { compileEditingIntentWithControlledResolver } from '../utils/targetResolver';
import { recordTargetResolverShadowDiagnostic } from '../utils/targetResolverDiagnostics';
import { recordPropertyProjectionShadowDiagnostic } from '../utils/propertyProjectionDiagnostics';
import { projectPropertyDescriptors } from '../utils/propertyDescriptors';
import { resolvePropertyPatchMode } from '../utils/propertyPatchMode';
import { buildPaletteObjectPatches, resolvePaletteTargets } from '../utils/paletteTargetResolver';
import { computeEqualAxesPhysicalLayout } from '../utils/subplotPhysicalLayout';
import { resolveExplicitColorbarOwner } from '../utils/colorbarOwnership';
import type { StandardFigureModel, StandardFigureObject } from '../schemas/standardFigureModel';
import type { EditingIntent, SemanticTargetRole } from '../schemas/editingIntent';
import type { EditingIntentApplyReport, EditingIntentSkippedTarget } from '../schemas/editingIntent';
import type { EditingCenterId } from '../schemas/propertyDescriptor';
import { PropertyControl } from './PropertyControl';

import type { DraftPatch } from '../schemas/draftPatchBatch';

interface RightSidebarProps {
  figSession: FigureSession | null;
  activeFigureId?: string;
  selectedFigureIds?: string[];
  selectedObject?: string;
  onSelectObject: (obj: string) => void;
  selectedGids?: string[];
  onSelectGids?: (gids: string[]) => void;
  onPatch: (patches: PatchEntry[]) => void;
  onImmediatePatch?: (patches: PatchEntry[]) => void | Promise<unknown>;
  lockedObjects?: Set<string>;
  
  // Draft props
  projectDrafts: Record<string, Record<string, DraftPatch>>;
  onUpdateDraft: (figId: string, patch: DraftPatch) => void;
  onUpdateDraftsBatch: (figId: string, patches: DraftPatch[]) => void;
  onDiscardDraft: (figId: string) => void;
  onApplyDraft: (figId: string, scope: 'current' | 'all' | 'selected') => void;
  editingIntentReports?: EditingIntentApplyReport[];
}

const LOCAL_PROPS = new Set(['text', 'color', 'visible', 'facecolor', 'edgecolor', 'alpha']);
const FONT_TARGET_RESOLVER_V2_ENABLED = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2 === '1';
const COMPONENT_TARGET_RESOLVER_V2_ENABLED = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2 !== '0';
const PALETTE_TARGET_RESOLVER_V2_ENABLED = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2 === '1';
const PROPERTY_INSPECTOR_V2_ENABLED = (
  import.meta as ImportMeta & { env?: Record<string, string | undefined> }
).env?.VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2 === '1';
const DEFAULT_PRESETS: Record<string, string[]> = {
  Nature: ['#1F78B4', '#D95F02', '#7570B3', '#E7298A', '#66A61E'],
  Science: ['#E41A1C', '#377EB8', '#4DAF4A', '#984EA3', '#FF7F00'],
  Cell: ['#A6CEE3', '#1F78B4', '#B2DF8A', '#33A02C', '#FB9A99'],
  PNAS: ['#332288', '#117733', '#44AA99', '#88CCEE', '#DDCC77'],
  IEEE: ['#0072B2', '#009E73', '#D55E00', '#CC79A7', '#F0E442'],
};
const PRESET_STORAGE_KEY = 'scifigure:palette-presets:v1';
const FONT_PRESET_STORAGE_KEY = 'scifigure:font-presets:v1';
const STYLE_PRESET_STORAGE_KEY = 'scifigure:style-presets:v1';
const LEGEND_LOCATIONS = ['best', 'upper right', 'upper left', 'lower left', 'lower right', 'right', 'center left', 'center right', 'lower center', 'upper center', 'center'];
const TICK_DIRECTIONS = ['out', 'in', 'inout'];
const DEFAULT_FONT_PRESETS: Record<string, { family: string; title: number; label: number; tick: number; legend: number }> = {
  Nature: { family: 'Arial', title: 14, label: 11, tick: 9, legend: 9 },
  'Times 论文': { family: 'Times New Roman', title: 15, label: 12, tick: 10, legend: 10 },
  '中文兼容': { family: 'Microsoft YaHei', title: 14, label: 11, tick: 9, legend: 9 },
};

type FontPreset = { family: string; title: number; label: number; tick: number; legend: number };
type FigureStylePreset = {
  family: string;
  title: number;
  label: number;
  tick: number;
  legend: number;
  fontWeight: string;
  fontStyle: string;
  textColor: string;
  tickDirection: string;
  tickLength: number;
  tickWidth: number;
  tickColor: string;
  spineWidth: number;
  spineColor: string;
};

const DEFAULT_STYLE_PRESETS: Record<string, FigureStylePreset> = {
  'Nature 紧凑': {
    family: 'Arial',
    title: 12,
    label: 10,
    tick: 8,
    legend: 8,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textColor: '#111827',
    tickDirection: 'out',
    tickLength: 3,
    tickWidth: 0.8,
    tickColor: '#000000',
    spineWidth: 0.8,
    spineColor: '#000000',
  },
  'Times 投稿': {
    family: 'Times New Roman',
    title: 13,
    label: 11,
    tick: 9,
    legend: 9,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textColor: '#000000',
    tickDirection: 'out',
    tickLength: 3.5,
    tickWidth: 0.9,
    tickColor: '#000000',
    spineWidth: 1,
    spineColor: '#000000',
  },
};

type SubplotLayoutSettings = {
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  gapX: number;
  gapY: number;
};

const DEFAULT_SUBPLOT_LAYOUT_SETTINGS: SubplotLayoutSettings = {
  marginLeft: 0.12,
  marginRight: 0.06,
  marginTop: 0.09,
  marginBottom: 0.11,
  gapX: 0.08,
  gapY: 0.12,
};

type PhysicalAxesLayoutSettings = {
  targetWidthIn: number;
  targetHeightIn: number;
  leftIn: number;
  rightIn: number;
  topIn: number;
  bottomIn: number;
  wspaceIn: number;
  hspaceIn: number;
};

type ColorbarAlignSettings = {
  pad: number;
  width: number;
  matchHeight: boolean;
  alignBottom: boolean;
};

type SubplotWidthAlignMode = 'keep-left' | 'keep-right' | 'center';

type SubplotWidthAlignSettings = {
  referenceId: string;
  targetId: string;
  includeColorbar: boolean;
  mode: SubplotWidthAlignMode;
};

type NormalizedBounds = {
  left: number;
  bottom: number;
  width: number;
  height: number;
  right: number;
  top: number;
};

type LayoutPreset = {
  rows: number;
  cols: number;
  label: string;
  hint: string;
};

const DEFAULT_PHYSICAL_AXES_LAYOUT: PhysicalAxesLayoutSettings = {
  targetWidthIn: 2.2,
  targetHeightIn: 2.2,
  leftIn: 0.7,
  rightIn: 0.3,
  topIn: 0.35,
  bottomIn: 0.55,
  wspaceIn: 0.45,
  hspaceIn: 0.45,
};

const DEFAULT_COLORBAR_ALIGN_SETTINGS: ColorbarAlignSettings = {
  pad: 0.025,
  width: 0.018,
  matchHeight: true,
  alignBottom: true,
};

const DEFAULT_SUBPLOT_WIDTH_ALIGN_SETTINGS: SubplotWidthAlignSettings = {
  referenceId: '',
  targetId: '',
  includeColorbar: true,
  mode: 'keep-left',
};

const PROP_LABELS: Record<string, string> = {
  text: '文字内容',
  title: '标题',
  label: '轴标签文字',
  visible: '显示',
  color: '颜色',
  facecolor: '填充色',
  edgecolor: '边框色',
  linewidth: '线宽',
  linestyle: '线型',
  alpha: '透明度',
  fontsize: '字号',
  fontfamily: '字体',
  fontweight: '字重',
  fontstyle: '字形',
  rotation: '旋转角度',
  ha: '水平对齐',
  va: '垂直对齐',
  x: 'X 位置',
  y: 'Y 位置',
  position: '位置',
  anchor_position: '箭头锚点位置',
  marker: '点形状',
  markersize: '点大小',
  size: '散点面积',
  zorder: '图层顺序',
  xlim: 'X 轴范围',
  ylim: 'Y 轴范围',
  limits: '坐标范围',
  label_fontsize: '轴标签字号',
  label_color: '轴标签颜色',
  tick_rotation: '刻度文字旋转',
  tick_direction: '刻度方向',
  tick_length: '主刻度长度',
  tick_width: '主刻度线宽',
  tick_color: '刻度线颜色',
  tick_pad: '刻度间距',
  show_minor_ticks: '显示副刻度',
  minor_tick_length: '副刻度长度',
  minor_tick_width: '副刻度线宽',
  minor_tick_color: '副刻度颜色',
  tick_labelsize: '刻度文字字号',
  tick_labelcolor: '刻度文字颜色',
  tick_labelfamily: '刻度文字字体',
  tick_label_dx: '刻度文字水平偏移(pt)',
  tick_label_dy: '刻度文字垂直偏移(pt)',
  sci_notation: '科学计数法',
  use_math_text: '数学字体',
  offset_text_size: '偏移文字字号',
  x_tick_rotation: 'X 刻度旋转',
  frameon: '显示图例背景框',
  loc: '图例位置',
  ncol: '图例列数',
  markerscale: '图例点缩放',
  marker_yoffset: '图例符号垂直偏移',
  handletextpad: '图例符号文字间距',
  labelspacing: '图例行距',
  width_in: '画布宽度(in)',
  height_in: '画布高度(in)',
  dpi: '分辨率 DPI',
  'figure.width_in': '画布宽度(in)',
  'figure.height_in': '画布高度(in)',
  'figure.dpi': '分辨率 DPI',
  left: '左边距',
  bottom: '下边距',
  width: '宽度',
  height: '高度',
  aspect: '比例',
  elinewidth: '误差线线宽',
  capsize: '误差帽宽度',
  capthick: '误差端点线宽',
  ecolor: '误差棒颜色',
  stem_color: '茎线颜色',
  stem_linewidth: '茎线宽度',
  marker_color: '标记颜色',
  baseline_color: '基线颜色',
  baseline_linewidth: '基线宽度',
  baseline_visible: '显示基线',
  box_color: '箱体颜色',
  median_color: '中位线颜色',
  cmap: '色带',
  vmin: '色阶最小值',
  vmax: '色阶最大值',
  tick_fontsize: '刻度字号',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  tick_direction: {
    out: '朝外',
    in: '朝内',
    inout: '内外双向',
  },
  loc: {
    best: '自动最佳',
    'upper right': '右上',
    'upper left': '左上',
    'lower left': '左下',
    'lower right': '右下',
    right: '右侧',
    'center left': '左中',
    'center right': '右中',
    'lower center': '下中',
    'upper center': '上中',
    center: '居中',
  },
  linestyle: {
    '-': '实线',
    '--': '虚线',
    '-.': '点划线',
    ':': '点线',
    none: '无线',
    None: '无线',
  },
};

function isLocalPatch(kind: string, prop: string) {
  if (!LOCAL_PROPS.has(prop)) {
    return false;
  }
  if (prop === 'visible') {
    return true;
  }
  if (kind === 'text') {
    return prop === 'color';
  }
  if (kind === 'line' || kind === 'patch' || kind === 'collection' || kind === 'spine') {
    return prop === 'color' || prop === 'facecolor' || prop === 'edgecolor' || prop === 'alpha';
  }
  return false;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readNormalizedBounds(obj: Pick<StandardFigureObject, 'currentProps'>): NormalizedBounds | null {
  const props = obj.currentProps || {};
  const left = Number(props.left);
  const bottom = Number(props.bottom);
  const width = Number(props.width);
  const height = Number(props.height);
  if (![left, bottom, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    left,
    bottom,
    width,
    height,
    right: left + width,
    top: bottom + height,
  };
}

function unionNormalizedBounds(boundsList: NormalizedBounds[]): NormalizedBounds | null {
  if (boundsList.length === 0) return null;
  const left = Math.min(...boundsList.map(bounds => bounds.left));
  const bottom = Math.min(...boundsList.map(bounds => bounds.bottom));
  const right = Math.max(...boundsList.map(bounds => bounds.right));
  const top = Math.max(...boundsList.map(bounds => bounds.top));
  return {
    left,
    bottom,
    right,
    top,
    width: right - left,
    height: top - bottom,
  };
}

function normalizeTickTextPatch(gid: string, prop: string) {
  if (prop !== 'fontsize' && prop !== 'fontfamily' && prop !== 'color') {
    return null;
  }
  const match = gid.match(/^([xy])tick\.(\d+)\./);
  if (!match) {
    return null;
  }
  const axis = match[1] === 'x' ? 'x' : 'y';
  const axisIndex = match[2];
  const axisProp = prop === 'fontsize'
    ? 'tick_labelsize'
    : prop === 'fontfamily'
      ? 'tick_labelfamily'
      : 'tick_labelcolor';
  return {
    gid: `axis.${axis}.${axisIndex}`,
    prop: axisProp,
  };
}

export function RightSidebar({
  figSession,
  activeFigureId,
  selectedFigureIds = [],
  selectedObject,
  onSelectObject,
  selectedGids = [],
  onSelectGids,
  onPatch,
  onImmediatePatch,
  lockedObjects,
  projectDrafts,
  onUpdateDraft,
  onUpdateDraftsBatch,
  onDiscardDraft,
  onApplyDraft,
  editingIntentReports = [],
}: RightSidebarProps) {
  const [activeTab, setActiveTab] = useState<'properties' | 'layout' | 'groups' | 'palette' | 'fonts'>('properties');
  const [subplotLayoutSettings, setSubplotLayoutSettings] = useState<SubplotLayoutSettings>(DEFAULT_SUBPLOT_LAYOUT_SETTINGS);
  const [physicalAxesLayout, setPhysicalAxesLayout] = useState<PhysicalAxesLayoutSettings>(DEFAULT_PHYSICAL_AXES_LAYOUT);
  const [colorbarAlignSettings, setColorbarAlignSettings] = useState<ColorbarAlignSettings>(DEFAULT_COLORBAR_ALIGN_SETTINGS);
  const [subplotWidthAlignSettings, setSubplotWidthAlignSettings] = useState<SubplotWidthAlignSettings>(DEFAULT_SUBPLOT_WIDTH_ALIGN_SETTINGS);
  const [selectedLayout, setSelectedLayout] = useState<{ rows: number; cols: number } | null>(null);
  const [swapSubplotIds, setSwapSubplotIds] = useState<{ first: string; second: string }>({ first: '', second: '' });
  const [layoutSnapshotAvailable, setLayoutSnapshotAvailable] = useState(false);
  const originalLayoutSnapshotRef = useRef<PatchEntry[] | null>(null);
  const [showDraftDetails, setShowDraftDetails] = useState(false);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [colorDraftValues, setColorDraftValues] = useState<Record<string, string>>({});
  const [customPresets, setCustomPresets] = useState<Record<string, string[]>>({});
  const [customFontPresets, setCustomFontPresets] = useState<Record<string, FontPreset>>({});
  const [customStylePresets, setCustomStylePresets] = useState<Record<string, FigureStylePreset>>({});
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [lastSelectedGroupId, setLastSelectedGroupId] = useState<string | null>(null);
  const [componentSubplotScope, setComponentSubplotScope] = useState<string>('all');
  const [fontSubplotScope, setFontSubplotScope] = useState<string>('all');
  const textInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [textSelections, setTextSelections] = useState<Record<string, { start: number; end: number }>>({});

  useEffect(() => {
    const handleRailAction = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'fonts') setActiveTab('fonts');
    };
    window.addEventListener('scifigure:editor-rail-action', handleRailAction);
    return () => window.removeEventListener('scifigure:editor-rail-action', handleRailAction);
  }, []);

  useEffect(() => {
    setSelectedGroupIds(new Set());
    setLastSelectedGroupId(null);
  }, [figSession?.revision]);

  useEffect(() => {
    setDraftValues({});
    setColorDraftValues({});
  }, [figSession?.revision, selectedObject]);

  useEffect(() => {
    setSelectedLayout(null);
    originalLayoutSnapshotRef.current = null;
    setLayoutSnapshotAvailable(false);
  }, [figSession?.sessionId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PRESET_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        setCustomPresets(parsed);
      }
    } catch {
      setCustomPresets({});
    }
    try {
      const raw = window.localStorage.getItem(FONT_PRESET_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FontPreset>;
        setCustomFontPresets(parsed);
      }
    } catch {
      setCustomFontPresets({});
    }
    try {
      const raw = window.localStorage.getItem(STYLE_PRESET_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FigureStylePreset>;
        setCustomStylePresets(parsed);
      }
    } catch {
      setCustomStylePresets({});
    }
  }, []);

  const debugModel = useMemo(() => {
    if (!figSession?.manifest) return null;
    return normalizeFigureModel({
      figureId: activeFigureId || 'fig_1',
      language: figSession.language,
      svg: figSession.svg || '',
      manifest: figSession.manifest,
      revision: figSession.revision ?? 0,
      editLog: figSession.editLog ?? []
    });
  }, [figSession, activeFigureId]);

  const currentFigureId = resolveFigureId(activeFigureId);

  const isDirty = (gid: string, prop: string) => {
    return Boolean(projectDrafts[currentFigureId]?.[`${gid}:${prop}`]);
  };

  const isColorDirty = (gidVal: string, scopeVal: string) => {
    if (scopeVal.startsWith('palette:')) {
      const palId = scopeVal.split(':')[1];
      return isDirty('code_patch', palId);
    }
    const parts = scopeVal.split(':');
    if (parts.length === 2) {
      return isDirty(parts[0], parts[1]);
    }
    return isDirty(gidVal, scopeVal);
  };

  const objects = useMemo(() => {
    const rawObjects = debugModel?.objects || [];
    const figDrafts = projectDrafts[currentFigureId] || {};
    
    return rawObjects.map(obj => {
      const currentPropsProxy = new Proxy(obj.currentProps || {}, {
        get(target, propKey) {
          if (typeof propKey === 'string') {
            const draftKey = `${obj.id}:${propKey}`;
            if (figDrafts[draftKey]) {
              return figDrafts[draftKey].value;
            }
          }
          return Reflect.get(target, propKey);
        }
      });
      return {
        ...obj,
        currentProps: currentPropsProxy
      };
    });
  }, [debugModel, projectDrafts, currentFigureId]);

  const selectedObj = useMemo(
    () => objects.find(o => o.id === selectedObject) || objects[0],
    [objects, selectedObject]
  );

  useEffect(() => {
    const manifest = figSession?.manifest;
    if (!manifest) return;
    const center: EditingCenterId = activeTab === 'groups' ? 'components' : activeTab;
    const rawObjects = manifest.objects ?? [];
    const selectedIds = new Set(selectedGids.length > 0
      ? selectedGids
      : selectedObject
        ? [selectedObject]
        : []);
    let shadowObjects = rawObjects;
    if (center === 'properties') {
      shadowObjects = selectedIds.size > 0
        ? rawObjects.filter(object => selectedIds.has(object.id))
        : rawObjects.slice(0, 1);
    } else if (center === 'layout') {
      shadowObjects = rawObjects.filter(object => (
        selectedIds.has(object.id)
        || ['subplot', 'colorbar', 'legend'].includes(object.kind)
      ));
    }
    recordPropertyProjectionShadowDiagnostic(manifest, center, shadowObjects);
  }, [activeTab, figSession?.manifest, figSession?.revision, selectedGids, selectedObject]);

  const getObjectSubplotId = (obj: Pick<StandardFigureObject, 'id' | 'kind' | 'subplotId' | 'source' | 'identity'>) => {
    if (obj.kind === 'subplot') return obj.id;
    const relation = obj.identity?.relation;
    if (typeof relation?.subplotId === 'string') return relation.subplotId;
    if ((relation?.subplotIds?.length ?? 0) > 1) return null;
    if (relation?.subplotIds?.length === 1) return relation.subplotIds[0];
    if (typeof obj.subplotId === 'string') return obj.subplotId;
    if (obj.kind === 'colorbar' || relation?.colorbarId) {
      return typeof obj.source?.ownerAxesIndex === 'number' ? `subplot.${obj.source.ownerAxesIndex}` : null;
    }
    if (typeof obj.source?.axesIndex === 'number') return `subplot.${obj.source.axesIndex}`;
    return null;
  };

  const allSubplotOptions = useMemo(() => objects
    .filter(obj => obj.kind === 'subplot')
    .sort((a, b) => Number(a.currentProps.subplotIndex ?? a.source?.axesIndex ?? 0) - Number(b.currentProps.subplotIndex ?? b.source?.axesIndex ?? 0)), [objects]);
  const subplotOptions = useMemo(() => allSubplotOptions.filter(subplot => {
    const twinIds = subplot.identity?.relation?.twinSubplotIds ?? [];
    if (twinIds.length === 0) return true;
    const groupIds = [subplot.id, ...twinIds].sort((left, right) => (
      Number(left.match(/\d+$/)?.[0] ?? 0) - Number(right.match(/\d+$/)?.[0] ?? 0)
    ));
    return groupIds[0] === subplot.id;
  }), [allSubplotOptions]);

  const colorbarOptions = useMemo(() => objects
    .filter(obj => obj.kind === 'colorbar')
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })), [objects]);

  const proxiedPalettes = useMemo(() => {
    const rawPalettes = debugModel?.palettes || [];
    const bindings = debugModel?.bindings || [];
    const figDrafts = projectDrafts[currentFigureId] || {};
    return rawPalettes.map(p => {
      const draftKey = `code_patch:${p.id}`;
      if (figDrafts[draftKey]) {
        return {
          ...p,
          color: figDrafts[draftKey].value as string
        };
      }
      const binding = bindings.find((b: Binding) => b.paletteId === p.id);
      const gid = Array.isArray(binding?.gids) ? binding.gids[0] : null;
      const prop = Array.isArray(binding?.props) ? binding.props[0] : null;
      if (gid && prop) {
        const objectDraftKey = `${gid}:${prop}`;
        if (figDrafts[objectDraftKey]) {
          return {
            ...p,
            color: figDrafts[objectDraftKey].value as string
          };
        }
      }
      return p;
    });
  }, [debugModel, projectDrafts, currentFigureId]);

  if (!figSession || !figSession.manifest) {
    return (
      <div className="w-full border-l border-slate-200 bg-white flex flex-col p-4 text-sm text-slate-500">
        Waiting for introspection...
      </div>
    );
  }

  const { manifest } = figSession;
  const isLocked = Boolean(selectedObject && lockedObjects?.has(selectedObject));
  const presetMap = { ...DEFAULT_PRESETS, ...customPresets };
  const fontPresetMap: Record<string, FontPreset> = { ...DEFAULT_FONT_PRESETS, ...customFontPresets };
  const stylePresetMap: Record<string, FigureStylePreset> = { ...DEFAULT_STYLE_PRESETS, ...customStylePresets };

  const getDraftKey = (gid: string, prop: string) => `${gid}::${prop}`;
  const getPropLabel = (prop: string) => PROP_LABELS[prop] || prop.replace(/_/g, ' ');
  const getValueLabel = (prop: string, value: string) => VALUE_LABELS[prop]?.[value] || value;
  const getUnsupportedProps = (obj: ManifestObject | undefined) => {
    const unsupported = obj?.currentProps?.unsupportedProps;
    return Array.isArray(unsupported) ? unsupported.map(String) : [];
  };
  const getSemanticObjectLabel = (obj: ManifestObject) => {
    const id = obj.id;
    if (id.startsWith('title.')) return '主标题';
    if (id.startsWith('suptitle.')) return '总标题';
    if (id.startsWith('xlabel.')) return 'X 轴标签';
    if (id.startsWith('ylabel.')) return 'Y 轴标签';
    if (id.startsWith('supxlabel.')) return '全局 X 轴标签';
    if (id.startsWith('supylabel.')) return '全局 Y 轴标签';
    if (id.startsWith('xtick.')) return 'X 轴刻度文字';
    if (id.startsWith('ytick.')) return 'Y 轴刻度文字';
    if (id.startsWith('legend_text.')) return '图例文字';
    if (id.startsWith('legend.')) return '图例';
    if (id.startsWith('axis.x.')) return 'X 轴系统';
    if (id.startsWith('axis.y.')) return 'Y 轴系统';
    if (id.startsWith('axes.')) return '坐标轴面板';
    if (id.startsWith('grid.')) return '网格线';
    if (id.startsWith('spine_group.')) return '四边框组';
    if (id.startsWith('spine.left.')) return '左边框';
    if (id.startsWith('spine.right.')) return '右边框';
    if (id.startsWith('spine.top.')) return '上边框';
    if (id.startsWith('spine.bottom.')) return '下边框';
    if (id.startsWith('series.line.')) return '线条系列';
    if (id.startsWith('series.collection.')) return '散点/集合系列';
    if (id.startsWith('patch.')) return '图形块';
    return '';
  };
  const getReadableObjectLabel = (obj: ManifestObject) => {
    const semantic = getSemanticObjectLabel(obj);
    const rawLabel = obj.label && obj.label !== obj.id ? obj.label : '';
    return rawLabel || semantic || `${getObjectTypeLabel(obj.kind)} · ${obj.id}`;
  };

  const handlePatch = (gid: string, prop: string, value: unknown) => {
    const currentObject = manifest.objects.find((item) => item.id === gid);
    const figureId = currentFigureId;

    const mode = resolvePropertyPatchMode({
      generatedBy: manifest.generatedBy,
      object: currentObject,
      prop,
      legacyLocal: isLocalPatch(currentObject?.kind || '', prop),
    });
    onUpdateDraft(figureId, { gid, prop, value, mode });
  };

  const buildPatchEntry = (gid: string, prop: string, value: unknown): PatchEntry => {
    const currentObject = manifest.objects.find((item) => item.id === gid);
    const mode = resolvePropertyPatchMode({
      generatedBy: manifest.generatedBy,
      object: currentObject,
      prop,
      legacyLocal: isLocalPatch(currentObject?.kind || '', prop),
    });
    return { op: 'set', gid, prop, value, mode };
  };

  const compileIntentPatches = (intent: EditingIntent): PatchEntry[] => {
    const result = compileEditingIntent(manifest, intent);
    recordTargetResolverShadowDiagnostic(manifest, intent, 'right-sidebar');
    if (result.skipped.length > 0) {
      console.warn('[EditingIntent] skipped targets', result.skipped);
    }
    return result.patches.map(patch => ({ ...patch, intent } as unknown as PatchEntry));
  };

  const compileFontIntentPatches = (intent: EditingIntent): PatchEntry[] => {
    const result = compileEditingIntentWithControlledResolver(
      manifest,
      intent,
      FONT_TARGET_RESOLVER_V2_ENABLED,
    );
    recordTargetResolverShadowDiagnostic(manifest, intent, 'font-center');
    if (result.fallbackReason && result.fallbackReason !== 'feature_disabled') {
      console.info('[FontTargetResolverV2] compatibility fallback', {
        reason: result.fallbackReason,
        missingIdentityCount: result.readiness.missingIdentityObjectIds.length,
        missingCapabilityCount: result.readiness.missingPropertyCapabilityObjectIds.length,
      });
    }
    if (result.skipped.length > 0) {
      console.warn('[FontTargetResolverV2] skipped targets', result.skipped);
    }
    return result.patches.map(patch => ({ ...patch, intent } as unknown as PatchEntry));
  };

  const compileComponentIntentPatches = (intent: EditingIntent): PatchEntry[] => {
    const result = compileEditingIntentWithControlledResolver(
      manifest,
      intent,
      COMPONENT_TARGET_RESOLVER_V2_ENABLED,
    );
    recordTargetResolverShadowDiagnostic(manifest, intent, 'component-center');
    if (result.fallbackReason && result.fallbackReason !== 'feature_disabled') {
      console.info('[ComponentTargetResolverV2] compatibility fallback', {
        reason: result.fallbackReason,
        missingIdentityCount: result.readiness.missingIdentityObjectIds.length,
        missingCapabilityCount: result.readiness.missingPropertyCapabilityObjectIds.length,
      });
    }
    if (result.skipped.length > 0) {
      console.warn('[ComponentTargetResolverV2] skipped targets', result.skipped);
    }
    return result.patches.map(patch => ({ ...patch, intent } as unknown as PatchEntry));
  };

  const skippedReasonLabel = (reason: EditingIntentSkippedTarget['reason']) => {
    switch (reason) {
      case 'not_found':
        return '未匹配';
      case 'unsupported_prop':
        return '属性不支持';
      case 'unsupported_scope':
        return '作用域不安全';
      case 'unsupported_engine':
        return '引擎不支持';
      default:
        return '已跳过';
    }
  };

  const buildSubplotLayoutPatches = (rows: number, cols: number, settings: SubplotLayoutSettings = subplotLayoutSettings): PatchEntry[] => {
    const ordered = subplotOptions.slice(0, rows * cols);
    if (ordered.length === 0) return [];
    const margin = {
      left: cols === 1 ? Math.max(settings.marginLeft, 0.18) : settings.marginLeft,
      right: settings.marginRight,
      bottom: rows === 1 ? Math.max(settings.marginBottom, 0.18) : settings.marginBottom,
      top: settings.marginTop,
    };
    const gapX = cols <= 1 ? 0 : settings.gapX;
    const gapY = rows <= 1 ? 0 : settings.gapY;
    const cellWidth = Math.max(0.005, (1 - margin.left - margin.right - gapX * (cols - 1)) / cols);
    const cellHeight = Math.max(0.005, (1 - margin.top - margin.bottom - gapY * (rows - 1)) / rows);
    const patches: PatchEntry[] = [];

    ordered.forEach((subplot, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const left = margin.left + col * (cellWidth + gapX);
      const bottom = 1 - margin.top - (row + 1) * cellHeight - row * gapY;
      patches.push(
        buildPatchEntry(subplot.id, 'left', Number(left.toFixed(4))),
        buildPatchEntry(subplot.id, 'bottom', Number(bottom.toFixed(4))),
        buildPatchEntry(subplot.id, 'width', Number(cellWidth.toFixed(4))),
        buildPatchEntry(subplot.id, 'height', Number(cellHeight.toFixed(4))),
      );
    });
    return patches;
  };

  const buildEqualAxesPhysicalLayoutPatches = (
    rows: number,
    cols: number,
    settings: PhysicalAxesLayoutSettings = physicalAxesLayout,
  ): PatchEntry[] => {
    const ordered = subplotOptions.slice(0, rows * cols);
    if (ordered.length === 0) return [];
    const layout = computeEqualAxesPhysicalLayout({
      rows,
      cols,
      targetAxesWidthIn: settings.targetWidthIn,
      targetAxesHeightIn: settings.targetHeightIn,
      margins: {
        left: settings.leftIn,
        right: settings.rightIn,
        top: settings.topIn,
        bottom: settings.bottomIn,
        wspace: cols <= 1 ? 0 : settings.wspaceIn,
        hspace: rows <= 1 ? 0 : settings.hspaceIn,
      },
    });
    const patches: PatchEntry[] = [
      buildPatchEntry('global', 'figure.width_in', layout.figureWidthIn),
      buildPatchEntry('global', 'figure.height_in', layout.figureHeightIn),
    ];
    ordered.forEach((subplot, index) => {
      const bounds = layout.bounds[index];
      if (!bounds) return;
      patches.push(
        buildPatchEntry(subplot.id, 'left', bounds.left),
        buildPatchEntry(subplot.id, 'bottom', bounds.bottom),
        buildPatchEntry(subplot.id, 'width', bounds.width),
        buildPatchEntry(subplot.id, 'height', bounds.height),
      );
    });
    return patches;
  };

  const resolveOwnerSubplotsForColorbar = (colorbar: StandardFigureObject) => {
    const explicit = resolveExplicitColorbarOwner(colorbar, objects);
    if (explicit.status === 'resolved') {
      return {
        subplots: subplotOptions.filter(subplot => explicit.subplotIds.includes(subplot.id)),
        source: 'relation' as const,
      };
    }
    if (explicit.status === 'resolved_shared') {
      return {
        subplots: subplotOptions.filter(subplot => explicit.subplotIds.includes(subplot.id)),
        source: 'relation' as const,
      };
    }
    if (explicit.status === 'invalid') {
      return { subplots: [], source: 'invalid' as const };
    }

    const colorbarBounds = readNormalizedBounds(colorbar);
    if (!colorbarBounds) return { subplots: [], source: 'geometry' as const };
    let best: { subplot: StandardFigureObject; score: number } | null = null;

    subplotOptions.forEach((subplot) => {
      const subplotBounds = readNormalizedBounds(subplot);
      if (!subplotBounds) return;
      const verticalOverlap = Math.max(
        0,
        Math.min(colorbarBounds.top, subplotBounds.top) - Math.max(colorbarBounds.bottom, subplotBounds.bottom),
      );
      const overlapRatio = verticalOverlap / Math.max(0.0001, Math.min(colorbarBounds.height, subplotBounds.height));
      const rightDistance = Math.abs(colorbarBounds.left - subplotBounds.right);
      const centerDistance = Math.abs(
        (colorbarBounds.bottom + colorbarBounds.height / 2) - (subplotBounds.bottom + subplotBounds.height / 2),
      );
      const sidePenalty = colorbarBounds.left >= subplotBounds.right ? 0 : 1;
      const score = rightDistance * 3 + centerDistance + sidePenalty + (1 - overlapRatio) * 2;
      if (!best || score < best.score) {
        best = { subplot, score };
      }
    });

    return { subplots: best?.subplot ? [best.subplot] : [], source: 'geometry' as const };
  };

  const getColorbarAlignmentTargets = () => colorbarOptions
    .map((colorbar) => {
      const owner = resolveOwnerSubplotsForColorbar(colorbar);
      const ownerBounds = unionNormalizedBounds(
        owner.subplots
          .map(subplot => readNormalizedBounds(subplot))
          .filter((bounds): bounds is NormalizedBounds => Boolean(bounds)),
      );
      return { colorbar, subplots: owner.subplots, ownerBounds, source: owner.source };
    })
    .filter((target): target is {
      colorbar: StandardFigureObject;
      subplots: StandardFigureObject[];
      ownerBounds: NormalizedBounds;
      source: 'relation' | 'geometry' | 'invalid';
    } => target.subplots.length > 0 && Boolean(target.ownerBounds));

  const buildColorbarAlignPatches = (
    settings: ColorbarAlignSettings = colorbarAlignSettings,
  ): PatchEntry[] => {
    const patches: PatchEntry[] = [];
    const width = clampNumber(settings.width, 0.005, 0.12);
    getColorbarAlignmentTargets().forEach(({ colorbar, ownerBounds }) => {
      const colorbarBounds = readNormalizedBounds(colorbar);
      if (!colorbarBounds) return;
      const nextLeft = clampNumber(ownerBounds.right + settings.pad, 0, Math.max(0, 1 - width));
      patches.push(
        buildPatchEntry(colorbar.id, 'left', Number(nextLeft.toFixed(4))),
        buildPatchEntry(colorbar.id, 'width', Number(width.toFixed(4))),
      );
      if (settings.alignBottom) {
        patches.push(buildPatchEntry(colorbar.id, 'bottom', Number(ownerBounds.bottom.toFixed(4))));
      }
      if (settings.matchHeight) {
        patches.push(buildPatchEntry(colorbar.id, 'height', Number(ownerBounds.height.toFixed(4))));
      }
    });
    return patches;
  };

  const getSubplotOuterBounds = (subplotId: string, includeColorbar: boolean): NormalizedBounds | null => {
    const subplot = subplotOptions.find(item => item.id === subplotId);
    const subplotBounds = subplot ? readNormalizedBounds(subplot) : null;
    if (!subplotBounds) return null;

    if (!includeColorbar) {
      return subplotBounds;
    }

    const ownedColorbarBounds = colorbarOptions
      .filter(colorbar => resolveOwnerSubplotsForColorbar(colorbar).subplots.some(subplot => subplot.id === subplotId))
      .map(colorbar => readNormalizedBounds(colorbar))
      .filter((bounds): bounds is NormalizedBounds => Boolean(bounds));

    if (ownedColorbarBounds.length === 0) {
      return subplotBounds;
    }

    const right = Math.max(subplotBounds.right, ...ownedColorbarBounds.map(bounds => bounds.right));
    return {
      ...subplotBounds,
      width: right - subplotBounds.left,
      right,
    };
  };

  const buildAlignSubplotWidthToReferencePatches = (
    referenceId: string,
    targetId: string,
    settings: SubplotWidthAlignSettings = subplotWidthAlignSettings,
  ): PatchEntry[] => {
    if (!referenceId || !targetId || referenceId === targetId) return [];
    const target = subplotOptions.find(item => item.id === targetId);
    const targetBounds = target ? readNormalizedBounds(target) : null;
    const referenceBounds = getSubplotOuterBounds(referenceId, settings.includeColorbar);
    if (!target || !targetBounds || !referenceBounds) return [];

    const referenceWidth = clampNumber(referenceBounds.width, 0.005, 0.995);
    let nextLeft = targetBounds.left;
    let nextWidth = targetBounds.width;

    if (settings.mode === 'keep-left') {
      nextWidth = referenceBounds.right - targetBounds.left;
    } else if (settings.mode === 'keep-right') {
      nextWidth = referenceWidth;
      nextLeft = targetBounds.right - referenceWidth;
    } else {
      nextWidth = referenceWidth;
      nextLeft = targetBounds.left + targetBounds.width / 2 - referenceWidth / 2;
    }

    nextLeft = clampNumber(nextLeft, 0, 0.995);
    nextWidth = clampNumber(nextWidth, 0.005, 1 - nextLeft);

    const patches: PatchEntry[] = [];
    if (Math.abs(nextLeft - targetBounds.left) > 0.00005) {
      patches.push(buildPatchEntry(target.id, 'left', Number(nextLeft.toFixed(4))));
    }
    if (Math.abs(nextWidth - targetBounds.width) > 0.00005) {
      patches.push(buildPatchEntry(target.id, 'width', Number(nextWidth.toFixed(4))));
    }
    return patches;
  };

  const buildCurrentLayoutSnapshotPatches = (): PatchEntry[] => {
    const patches: PatchEntry[] = [];
    const globalFields = manifest.globals || {};
    const figureWidth = (globalFields as Record<string, ManifestField>)['figure.width_in'];
    const figureHeight = (globalFields as Record<string, ManifestField>)['figure.height_in'];
    if (figureWidth?.type === 'number') {
      patches.push(buildPatchEntry('global', 'figure.width_in', figureWidth.value));
    }
    if (figureHeight?.type === 'number') {
      patches.push(buildPatchEntry('global', 'figure.height_in', figureHeight.value));
    }
    subplotOptions.forEach((subplot) => {
      const props = subplot.currentProps as Record<string, unknown>;
      (['left', 'bottom', 'width', 'height'] as const).forEach((prop) => {
        const value = Number(props[prop]);
        if (Number.isFinite(value)) {
          patches.push(buildPatchEntry(subplot.id, prop, value));
        }
      });
      if (typeof props.aspect === 'string' || typeof props.aspect === 'number') {
        patches.push(buildPatchEntry(subplot.id, 'aspect', props.aspect));
      }
    });
    colorbarOptions.forEach((colorbar) => {
      const props = colorbar.currentProps as Record<string, unknown>;
      (['left', 'bottom', 'width', 'height'] as const).forEach((prop) => {
        const value = Number(props[prop]);
        if (Number.isFinite(value)) {
          patches.push(buildPatchEntry(colorbar.id, prop, value));
        }
      });
    });
    return patches;
  };

  const rememberOriginalLayout = () => {
    if (!originalLayoutSnapshotRef.current) {
      originalLayoutSnapshotRef.current = buildCurrentLayoutSnapshotPatches();
      setLayoutSnapshotAvailable(true);
    }
  };

  const applySubplotLayout = (rows: number, cols: number, settings: SubplotLayoutSettings = subplotLayoutSettings) => {
    rememberOriginalLayout();
    setSelectedLayout({ rows, cols });
    const patches = buildSubplotLayoutPatches(rows, cols, settings);
    if (patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
  };

  const applyEqualAxesPhysicalLayout = (rows: number, cols: number, settings: PhysicalAxesLayoutSettings = physicalAxesLayout) => {
    rememberOriginalLayout();
    setSelectedLayout({ rows, cols });
    const patches = buildEqualAxesPhysicalLayoutPatches(rows, cols, settings);
    if (patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
  };

  const applyColorbarAlignment = (settings: ColorbarAlignSettings = colorbarAlignSettings) => {
    rememberOriginalLayout();
    const patches = buildColorbarAlignPatches(settings);
    if (patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
  };

  const applySubplotWidthAlignment = (
    referenceId: string,
    targetId: string,
    settings: SubplotWidthAlignSettings = subplotWidthAlignSettings,
  ) => {
    rememberOriginalLayout();
    const patches = buildAlignSubplotWidthToReferencePatches(referenceId, targetId, settings);
    if (patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
  };

  const buildSwapSubplotPositionPatches = (firstId: string, secondId: string): PatchEntry[] => {
    if (!firstId || !secondId || firstId === secondId) return [];
    const first = subplotOptions.find(subplot => subplot.id === firstId);
    const second = subplotOptions.find(subplot => subplot.id === secondId);
    if (!first || !second) return [];
    const firstBounds = readNormalizedBounds(first);
    const secondBounds = readNormalizedBounds(second);
    if (!firstBounds || !secondBounds) return [];

    const patches: PatchEntry[] = [
      buildPatchEntry(first.id, 'left', Number(secondBounds.left.toFixed(4))),
      buildPatchEntry(first.id, 'bottom', Number(secondBounds.bottom.toFixed(4))),
      buildPatchEntry(second.id, 'left', Number(firstBounds.left.toFixed(4))),
      buildPatchEntry(second.id, 'bottom', Number(firstBounds.bottom.toFixed(4))),
    ];

    colorbarOptions.forEach((colorbar) => {
      const owners = resolveOwnerSubplotsForColorbar(colorbar).subplots;
      const owner = owners.length === 1 ? owners[0] : null;
      const colorbarBounds = readNormalizedBounds(colorbar);
      if (!owner || !colorbarBounds) return;
      if (owner.id === first.id) {
        patches.push(
          buildPatchEntry(colorbar.id, 'left', Number((colorbarBounds.left + secondBounds.left - firstBounds.left).toFixed(4))),
          buildPatchEntry(colorbar.id, 'bottom', Number((colorbarBounds.bottom + secondBounds.bottom - firstBounds.bottom).toFixed(4))),
        );
      }
      if (owner.id === second.id) {
        patches.push(
          buildPatchEntry(colorbar.id, 'left', Number((colorbarBounds.left + firstBounds.left - secondBounds.left).toFixed(4))),
          buildPatchEntry(colorbar.id, 'bottom', Number((colorbarBounds.bottom + firstBounds.bottom - secondBounds.bottom).toFixed(4))),
        );
      }
    });

    return patches;
  };

  const applySwapSubplotPositions = (firstId: string, secondId: string) => {
    rememberOriginalLayout();
    const patches = buildSwapSubplotPositionPatches(firstId, secondId);
    if (patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
  };

  const restoreOriginalLayout = () => {
    const patches = originalLayoutSnapshotRef.current;
    if (!patches || patches.length === 0) return;
    void (onImmediatePatch || onPatch)(patches);
    originalLayoutSnapshotRef.current = null;
    setLayoutSnapshotAvailable(false);
  };

  const handlePaletteColorChange = (paletteId: string, newColor: string) => {
    const resolution = resolvePaletteTargets(
      manifest,
      paletteId,
      PALETTE_TARGET_RESOLVER_V2_ENABLED,
    );
    const gids = Array.from(new Set(resolution.targets.map(target => target.objectId)));
    const figureId = currentFigureId;

    if (resolution.fallbackReason && resolution.fallbackReason !== 'feature_disabled') {
      console.info('[PaletteTargetResolverV2] compatibility fallback', {
        paletteId,
        reason: resolution.fallbackReason,
      });
    }
    if (resolution.skipped.length > 0 || resolution.ambiguous.length > 0) {
      console.warn('[PaletteTargetResolverV2] unresolved targets', {
        paletteId,
        skipped: resolution.skipped,
        ambiguous: resolution.ambiguous,
      });
    }

    if (manifest.generatedBy === 'r_svg') {
      const draftPatchesList = buildPaletteObjectPatches(resolution, newColor).map((patch) => {
        const object = manifest.objects.find(item => item.id === patch.gid);
        const intent: EditingIntent = {
          intent: 'style.component',
          scope: {
            selectionMode: 'explicit_objects',
            objectIds: [patch.gid],
            targetKinds: object ? [object.kind] : undefined,
            crossFigure: 'deny',
          },
          operation: { prop: patch.prop, value: newColor },
          commit: { mode: 'draft', applyAsOneHistoryStep: true },
          fallback: { onUnsupported: 'skip_with_warning' },
        };
        return { ...patch, intent };
      });
      if (draftPatchesList.length === 0) return;
      onUpdateDraftsBatch(figureId, draftPatchesList);
      return;
    }
    
    onUpdateDraft(figureId, {
      gid: 'code_patch',
      prop: paletteId,
      value: newColor,
      mode: 'backend_patch',
      type: 'code_patch',
      target_id: paletteId,
      new_value: newColor,
      gids
    });
  };

  const getObjectTypeLabel = (kind: string) => {
    const labels: Record<string, string> = {
      text: '文本',
      spine: '边框',
      spine_group: '边框组',
      legend: '图例',
      line: '线条',
      collection: '散点/集合',
      patch: '图形块',
      figure: '画布',
      subplot: '子图',
      axes: '坐标轴',
      grid: '网格',
      axis_x: 'X轴',
      axis_y: 'Y轴',
      boxplot_container: '箱线图',
      violinplot_container: '小提琴图',
      stem_container: '茎叶图',
    };
    return labels[kind] || kind;
  };

  const selectPaletteTargets = (gids: string[]) => {
    if (gids.length === 0) return;
    onSelectGids?.(gids);
  };

  const updateDraft = (gid: string, prop: string, value: string) => {
    const key = getDraftKey(gid, prop);
    setDraftValues(prev => ({ ...prev, [key]: value }));
  };

  const clearDraft = (gid: string, prop: string) => {
    const key = getDraftKey(gid, prop);
    setDraftValues(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const commitNumberDraft = (
    gid: string,
    prop: string,
    currentValue: number | undefined,
    rawValue: string,
    onValue?: (nextValue: number) => void
  ) => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const nextValue = Number(trimmed);
    if (!Number.isFinite(nextValue)) return;
    if (nextValue !== currentValue) {
      if (onValue) {
        onValue(nextValue);
      } else {
        handlePatch(gid, prop, nextValue);
      }
    }
    clearDraft(gid, prop);
  };

  const commitRangeDraft = (
    gid: string,
    prop: string,
    currentValues: number[],
    rawMin: string,
    rawMax: string,
  ) => {
    const low = Number(rawMin.trim());
    const high = Number(rawMax.trim());
    if (!Number.isFinite(low) || !Number.isFinite(high) || low === high) {
      clearDraft(gid, `${prop}.min`);
      clearDraft(gid, `${prop}.max`);
      return;
    }
    if (low !== currentValues[0] || high !== currentValues[1]) {
      handlePatch(gid, prop, [low, high]);
    }
    clearDraft(gid, `${prop}.min`);
    clearDraft(gid, `${prop}.max`);
  };

  const resolvePickerColor = (val: unknown): string => {
    if (typeof val === 'string' && val.startsWith('#')) {
      return val.slice(0, 7);
    }
    if (Array.isArray(val) && val.length >= 3) {
      const r = Math.round(val[0] * 255).toString(16).padStart(2, '0');
      const g = Math.round(val[1] * 255).toString(16).padStart(2, '0');
      const b = Math.round(val[2] * 255).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    return '#000000';
  };

  const renderPanelTitle = (title: string) => (
    <div className="flex justify-between items-center border-b border-slate-100 pb-2 mb-4">
      <h3 className="font-semibold text-slate-800 text-sm">{title}</h3>
    </div>
  );

  const renderNumberInput = (
    gid: string,
    label: string,
    value: number | undefined,
    onValue: (nextValue: number) => void,
    options?: { min?: number; max?: number; step?: number; displayLabel?: string }
  ) => {
    const key = getDraftKey(gid, label);
    const inputValue = draftValues[key] ?? (value ?? '').toString();
    const dirty = isDirty(gid, label);
    const displayLabel = options?.displayLabel || getPropLabel(label);
    return (
      <div className="grid grid-cols-[104px_1fr] items-center gap-2 text-sm" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          {displayLabel}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <input
          type="number"
          aria-label={displayLabel}
          data-param-role="number"
          data-param-gid={gid}
          data-param-prop={label}
          min={options?.min}
          max={options?.max}
          step={options?.step ?? 1}
          className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white text-slate-700 focus:border-blue-500"
          value={inputValue}
          onChange={(event) => updateDraft(gid, label, event.target.value)}
          onBlur={(event) => commitNumberDraft(gid, label, value, event.target.value, onValue)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitNumberDraft(gid, label, value, (event.target as HTMLInputElement).value, onValue);
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === 'Escape') {
              clearDraft(gid, label);
            }
          }}
        />
      </div>
    );
  };

  const renderTextInput = (gid: string, label: string, value: string, onValue: (nextValue: string) => void) => {
    const key = getDraftKey(gid, label);
    const inputValue = draftValues[key] ?? value;
    const dirty = isDirty(gid, label);
    const displayLabel = getPropLabel(label);
    const rememberSelection = (input: HTMLTextAreaElement) => {
      setTextSelections(prev => ({
        ...prev,
        [key]: {
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        },
      }));
    };
    const insertTextFragment = (fragmentFactory: (selected: string) => { fragment: string; cursorOffset: number }) => {
      const input = textInputRefs.current[key];
      const baseValue = draftValues[key] ?? value ?? '';
      const saved = textSelections[key];
      const start = input?.selectionStart ?? saved?.start ?? baseValue.length;
      const end = input?.selectionEnd ?? saved?.end ?? start;
      const selected = baseValue.slice(start, end);
      const { fragment, cursorOffset } = fragmentFactory(selected);
      const nextValue = `${baseValue.slice(0, start)}${fragment}${baseValue.slice(end)}`;
      updateDraft(gid, label, nextValue);
      window.requestAnimationFrame(() => {
        const nextInput = textInputRefs.current[key];
        if (!nextInput) return;
        nextInput.focus();
        const cursor = selected ? start + fragment.length : start + cursorOffset;
        nextInput.setSelectionRange(cursor, cursor);
        rememberSelection(nextInput);
      });
    };
    const insertScriptFragment = (scriptType: 'sub' | 'sup') => {
      insertTextFragment((selected) => {
        const fragment = scriptType === 'sub'
          ? selected ? `$_{${selected}}$` : '$_{}$'
          : selected ? `$^{${selected}}$` : '$^{}$';
        return { fragment, cursorOffset: 3 };
      });
    };
    const insertLineBreak = () => {
      insertTextFragment(() => ({ fragment: '\n', cursorOffset: 1 }));
    };
    const commitTextDraft = (nextVal: string) => {
      if (nextVal !== value) {
        onValue(nextVal);
      }
      clearDraft(gid, label);
    };
    const applyTextImmediately = (nextVal: string) => {
      if (nextVal === value) {
        clearDraft(gid, label);
        return;
      }
      clearDraft(gid, label);
      void (onImmediatePatch || onPatch)([buildPatchEntry(gid, label, nextVal)]);
    };
    return (
      <div className="text-sm space-y-1.5" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          {displayLabel}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <textarea
          ref={(node) => {
            textInputRefs.current[key] = node;
          }}
          aria-label={displayLabel}
          data-param-role="text"
          data-param-gid={gid}
          data-param-prop={label}
          className="min-h-[34px] resize-y whitespace-pre-wrap border border-slate-200 rounded p-1.5 outline-none focus:border-blue-500 w-full bg-white text-slate-700"
          rows={Math.max(1, Math.min(4, String(inputValue || '').split('\n').length))}
          value={inputValue}
          onChange={(event) => updateDraft(gid, label, event.target.value)}
          onSelect={(event) => rememberSelection(event.currentTarget)}
          onKeyUp={(event) => rememberSelection(event.currentTarget)}
          onClick={(event) => rememberSelection(event.currentTarget)}
          onBlur={(event) => {
            const nextVal = event.target.value;
            commitTextDraft(nextVal);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              if (event.shiftKey) {
                event.preventDefault();
                insertLineBreak();
                return;
              }
              const nextVal = (event.target as HTMLTextAreaElement).value;
              commitTextDraft(nextVal);
              (event.target as HTMLTextAreaElement).blur();
            }
            if (event.key === 'Escape') {
              clearDraft(gid, label);
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertScriptFragment('sup')}
            className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            title="把选中的字符设为上标，使用 Matplotlib mathtext 语法"
          >
            上标 x²
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertScriptFragment('sub')}
            className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            title="把选中的字符设为下标，使用 Matplotlib mathtext 语法"
          >
            下标 x₂
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={insertLineBreak}
            className="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            title="在当前光标位置插入换行；也可以按 Shift+Enter"
          >
            换行 ↵
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => commitTextDraft(draftValues[key] ?? value)}
            className="px-2 py-1 rounded border border-amber-200 bg-amber-50 text-[11px] font-semibold text-amber-700 hover:bg-amber-100"
            title="只暂存修改，稍后用底部按钮统一应用"
          >
            暂存文本
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyTextImmediately(draftValues[key] ?? value)}
            className="px-2 py-1 rounded border border-blue-200 bg-blue-50 text-[11px] font-semibold text-blue-700 hover:bg-blue-100"
            title="立即写入当前 Figure 并重渲染"
          >
            立即应用
          </button>
        </div>
        <div className="text-[10px] text-slate-400 leading-relaxed">
          Enter/失焦只会暂存到草稿；Shift+Enter 或“换行”按钮可插入换行。要马上看到文本变化，请点“立即应用”，或用底部“应用当前图”批量提交。
        </div>
      </div>
    );
  };

  const renderColorInput = (label: string, value: string, onValue: (nextValue: string) => void, draftScope = label, gid = '', prop = label) => {
    const hexColor = resolvePickerColor(value);
    const draftKey = `color::${draftScope}`;
    const textValue = colorDraftValues[draftKey] ?? (typeof value === 'string' ? value : hexColor);
    const dirty = isColorDirty(gid, draftScope);
    const commitColor = (raw: string) => {
      const trimmed = raw.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
        onValue(trimmed);
        setColorDraftValues(prev => ({ ...prev, [draftKey]: trimmed }));
      }
    };

    return (
      <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-sm" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          {getPropLabel(label)}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <div className="w-8 h-8 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
          <input
            type="color"
            aria-label={label}
            data-color-role="picker"
            data-color-scope={draftScope}
            data-color-label={label}
            className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
            value={hexColor}
            onChange={(event) => {
              setColorDraftValues(prev => ({ ...prev, [draftKey]: event.target.value }));
              onValue(event.target.value);
            }}
          />
        </div>
        <input
          type="text"
          aria-label={label}
          data-color-role="text"
          data-color-scope={draftScope}
          data-color-label={label}
          className="border border-slate-200 rounded p-1.5 uppercase text-slate-600 outline-none w-full text-xs font-mono"
          value={textValue.toUpperCase()}
          onChange={(event) => {
            const next = event.target.value;
            setColorDraftValues(prev => ({ ...prev, [draftKey]: next }));
            if (/^#[0-9A-Fa-f]{6}$/.test(next.trim())) {
              commitColor(next);
            }
          }}
          onBlur={(event) => commitColor(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitColor((event.target as HTMLInputElement).value);
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === 'Escape') {
              setColorDraftValues(prev => {
                const next = { ...prev };
                delete next[draftKey];
                return next;
              });
            }
          }}
        />
      </div>
    );
  };

  const renderBoolInput = (label: string, value: boolean, onValue: (nextValue: boolean) => void, gid = '', prop = label) => {
    const dirty = gid && isDirty(gid, prop);
    return (
      <div className="flex items-center justify-between mb-3 text-sm" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          {getPropLabel(label)}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={value}
            onChange={(event) => onValue(event.target.checked)}
          />
          <div className="w-8 h-4 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-600"></div>
        </label>
      </div>
    );
  };

  const FONT_OPTIONS = [
    'sans-serif', 'serif', 'monospace', 'DejaVu Sans', 'Arial',
    'Times New Roman', 'Helvetica', 'Courier New', 'Verdana', 'Georgia',
  ];

  const renderFontSelect = (gid: string, label: string, value: string, onValue: (nextValue: string) => void) => {
    const key = getDraftKey(gid, label);
    const inputValue = draftValues[key] ?? value;
    const dirty = isDirty(gid, label);
    return (
      <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          字体家族
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <div className="relative">
          <select
            className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white appearance-none text-slate-700 text-xs"
            value={FONT_OPTIONS.includes(inputValue) ? inputValue : '__custom__'}
            onChange={(event) => {
              if (event.target.value === '__custom__') return;
              updateDraft(gid, label, event.target.value);
              onValue(event.target.value);
            }}
          >
            {FONT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
            {!FONT_OPTIONS.includes(inputValue) && (
              <option value="__custom__" disabled>自定义: {inputValue}</option>
            )}
          </select>
          <input
            type="text"
            className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white mt-1 text-xs"
            placeholder="或输入自定义字体..."
            value={!FONT_OPTIONS.includes(inputValue) ? inputValue : ''}
            onChange={(event) => {
              updateDraft(gid, label, event.target.value);
            }}
            onBlur={(event) => {
              const trimmed = event.target.value.trim();
              if (trimmed && trimmed !== value) {
                onValue(trimmed);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const trimmed = (event.target as HTMLInputElement).value.trim();
                if (trimmed && trimmed !== value) {
                  onValue(trimmed);
                }
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      </div>
    );
  };

  const renderSelectInput = (label: string, value: string, options: string[], onValue: (nextValue: string) => void, gid = '', prop = label) => {
    const dirty = gid && isDirty(gid, prop);
    return (
      <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-sm" key={label}>
        <span className="text-slate-600 flex items-center gap-1 select-none">
          {getPropLabel(label)}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="已修改（未保存至引擎）" />}
        </span>
        <select
          className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white text-slate-700 text-xs"
          value={value}
          onChange={(event) => onValue(event.target.value)}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{getValueLabel(label, opt)}</option>
          ))}
        </select>
      </div>
    );
  };

  const renderRangePair = (objId: string, label: string, values: number[], prop: string) => {
    const safeValues = Array.isArray(values) && values.length >= 2 ? values : [0, 1];
    const minKey = getDraftKey(objId, `${prop}.min`);
    const maxKey = getDraftKey(objId, `${prop}.max`);
    const minValue = draftValues[minKey] ?? String(safeValues[0]);
    const maxValue = draftValues[maxKey] ?? String(safeValues[1]);
    const commit = () => commitRangeDraft(objId, prop, safeValues, minValue, maxValue);
    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        commit();
        (event.target as HTMLInputElement).blur();
      }
      if (event.key === 'Escape') {
        clearDraft(objId, `${prop}.min`);
        clearDraft(objId, `${prop}.max`);
      }
    };
    return (
      <div key={prop} className="space-y-1.5">
        <span className="text-xs text-slate-500 font-semibold block">{label}</span>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            step="any"
            className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white focus:border-blue-500 outline-none"
            value={minValue}
            placeholder="min"
            onChange={(event) => updateDraft(objId, `${prop}.min`, event.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
          />
          <input
            type="number"
            step="any"
            className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white focus:border-blue-500 outline-none"
            value={maxValue}
            placeholder="max"
            onChange={(event) => updateDraft(objId, `${prop}.max`, event.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="text-[10px] text-slate-400">输入后按 Enter 或移出输入框应用。</div>
      </div>
    );
  };

  const renderCmapSelect = (gid: string, prop: string, currentValue: string, onChange: (value: string) => void) => {
    const cmaps = ['viridis', 'plasma', 'inferno', 'magma', 'cividis', 'coolwarm', 'seismic', 'bwr', 'rainbow', 'jet', 'gray', 'hot'];
    return (
      <div key={`${gid}-${prop}`} className="flex flex-col gap-1.5 text-sm">
        <span className="text-slate-600 font-medium">{PROP_LABELS[prop] || prop}</span>
        <select
          className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white focus:border-blue-500 outline-none w-full"
          value={currentValue || 'viridis'}
          onChange={(e) => onChange(e.target.value)}
        >
          {cmaps.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
    );
  };

  const renderField = (gid: string, prop: string, fieldType: string, currentValue: unknown) => {
    if (fieldType === 'number' || typeof currentValue === 'number') {
      let step = 0.1;
      if (prop.includes('size') || prop.includes('width')) {
        step = 0.5;
      }
      if ((gid.startsWith('colorbar.') || gid.startsWith('subplot.')) && ['left', 'bottom', 'width', 'height'].includes(prop)) {
        step = 0.01;
      }
      return renderNumberInput(gid, prop, currentValue as number, (v) => handlePatch(gid, prop, v), { step });
    }
    if (fieldType === 'boolean' || typeof currentValue === 'boolean') {
      return renderBoolInput(prop, currentValue as boolean, (v) => handlePatch(gid, prop, v), gid, prop);
    }
    if (fieldType === 'color' || prop.includes('color')) {
      return renderColorInput(prop, currentValue as string, (v) => handlePatch(gid, prop, v), `${gid}:${prop}`, gid, prop);
    }
    if (prop === 'fontfamily') {
      return renderFontSelect(gid, prop, currentValue as string, (v) => handlePatch(gid, prop, v));
    }
    if (prop === 'fontweight') {
      return renderSelectInput('字重', String(currentValue || 'normal'), ['normal', 'bold', 'semibold', 'light'], (v) => handlePatch(gid, prop, v), gid, prop);
    }
    if (prop === 'fontstyle') {
      return renderSelectInput('字形', String(currentValue || 'normal'), ['normal', 'italic', 'oblique'], (v) => handlePatch(gid, prop, v), gid, prop);
    }
    if (prop === 'aspect') {
      return renderSelectInput('子图比例', String(currentValue || 'auto'), ['auto', 'equal', '1'], (v) => handlePatch(gid, prop, v), gid, prop);
    }
    if (prop === 'cmap') {
      return renderCmapSelect(gid, prop, currentValue as string, (v) => handlePatch(gid, prop, v));
    }
    if (fieldType === 'string' || typeof currentValue === 'string') {
      return renderTextInput(gid, prop, currentValue as string, (v) => handlePatch(gid, prop, v));
    }
    return null;
  };

  const getGlobalNumberValue = (key: string): number | null => {
    const field = manifest.globals?.[key];
    if (!field || field.type !== 'number') return null;
    const value = Number(field.value);
    return Number.isFinite(value) ? value : null;
  };

  const renderSubplotPanel = (obj: ManifestObject) => {
    const props = obj.currentProps as any;
    const unsupportedProps = getUnsupportedProps(obj);
    const boundsProps = ['left', 'bottom', 'width', 'height'];
    const editable = Array.isArray(obj.editable) ? obj.editable : [];
    const canEditBounds = boundsProps.some(prop => editable.includes(prop) && !unsupportedProps.includes(prop));
    const canEditAspect = editable.includes('aspect') || props.aspect !== undefined;
    const unsupportedReason = typeof props.unsupportedReason === 'string'
      ? props.unsupportedReason
      : '当前图形引擎没有提供独立坐标轴框位置映射。';
    const width = Number(props.width);
    const height = Number(props.height);
    const ratio = Number.isFinite(width) && Number.isFinite(height) && height > 0 ? width / height : null;
    const figureWidthIn = getGlobalNumberValue('figure.width_in');
    const figureHeightIn = getGlobalNumberValue('figure.height_in');
    const physicalWidthIn = ratio !== null && figureWidthIn !== null ? width * figureWidthIn : null;
    const physicalHeightIn = ratio !== null && figureHeightIn !== null ? height * figureHeightIn : null;
    const physicalWidthMm = physicalWidthIn !== null ? physicalWidthIn * 25.4 : null;
    const physicalHeightMm = physicalHeightIn !== null ? physicalHeightIn * 25.4 : null;
    return (
      <div className="space-y-6">
        {renderPanelTitle('真实绘图区 / 坐标轴框')}
        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs leading-relaxed text-blue-700">
          <div className="font-semibold text-blue-800">{props.label || obj.label || obj.id}</div>
          <div className="mt-1">
            调整的是白色画布里的坐标轴边框和数据绘图区，不改变整张输出画布尺寸。
          </div>
        </div>
        {ratio !== null && (
          <div className="rounded-lg border border-slate-100 bg-white p-3">
            <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] font-semibold text-slate-400">框宽</div>
              <div className="mt-1 font-mono text-sm font-bold text-slate-800">{width.toFixed(3)}</div>
              <div className="text-[10px] text-slate-400">{(width * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-400">框高</div>
              <div className="mt-1 font-mono text-sm font-bold text-slate-800">{height.toFixed(3)}</div>
              <div className="text-[10px] text-slate-400">{(height * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-400">宽高比</div>
              <div className="mt-1 font-mono text-sm font-bold text-blue-700">{ratio.toFixed(2)}:1</div>
              <div className="text-[10px] text-slate-400">{ratio > 1 ? '横向' : ratio < 1 ? '纵向' : '正方形'}</div>
            </div>
            </div>
            {physicalWidthIn !== null && physicalHeightIn !== null && physicalWidthMm !== null && physicalHeightMm !== null && (
              <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 px-2.5 py-2 text-[11px] leading-relaxed text-blue-800">
                <div className="font-semibold">按当前白色画布换算的真实绘图区尺寸</div>
                <div className="mt-1 font-mono">
                  {physicalWidthIn.toFixed(2)} × {physicalHeightIn.toFixed(2)} in
                  <span className="mx-1 text-blue-300">/</span>
                  {physicalWidthMm.toFixed(1)} × {physicalHeightMm.toFixed(1)} mm
                </div>
                <div className="mt-1 text-[10px] text-blue-600">
                  当前画布：{figureWidthIn?.toFixed(2)} × {figureHeightIn?.toFixed(2)} in。修改画布尺寸会同步改变这里的物理尺寸；修改绘图区宽高只改变框线在画布内的占比。
                </div>
              </div>
            )}
          </div>
        )}
        <div className="space-y-4">
          {canEditBounds ? (
            <div className="space-y-2 rounded-lg border border-slate-100 bg-white p-3">
              <div className="text-[11px] font-semibold text-slate-500">坐标轴框在白色画布内的位置和大小（0-1 归一化）</div>
              <div className="grid grid-cols-2 gap-2">
                {!unsupportedProps.includes('left') && renderNumberInput(obj.id, 'left', props.left ?? 0, (v) => handlePatch(obj.id, 'left', v), { min: 0, max: 1, step: 0.01, displayLabel: '绘图区左边距' })}
                {!unsupportedProps.includes('bottom') && renderNumberInput(obj.id, 'bottom', props.bottom ?? 0, (v) => handlePatch(obj.id, 'bottom', v), { min: 0, max: 1, step: 0.01, displayLabel: '绘图区下边距' })}
                {!unsupportedProps.includes('width') && renderNumberInput(obj.id, 'width', props.width ?? 0.5, (v) => handlePatch(obj.id, 'width', v), { min: 0.005, max: 1, step: 0.01, displayLabel: '绘图区宽度' })}
                {!unsupportedProps.includes('height') && renderNumberInput(obj.id, 'height', props.height ?? 0.5, (v) => handlePatch(obj.id, 'height', v), { min: 0.005, max: 1, step: 0.01, displayLabel: '绘图区高度' })}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
              当前对象不支持独立调整绘图区边框宽高。{unsupportedReason}
            </div>
          )}
          {canEditAspect && renderSelectInput('子图比例', String(props.aspect || 'auto'), ['auto', 'equal', '1'], (v) => handlePatch(obj.id, 'aspect', v), obj.id, 'aspect')}
          <div className="text-[11px] leading-relaxed text-slate-500">
            固定最终出图大小时，先在下方“整张白色画布 / 输出尺寸”设置画布宽高，再在这里调坐标轴框的宽高和边距。标签跑到白色区域外时，通常需要增大画布或缩小/移动绘图区。
          </div>
        </div>
      </div>
    );
  };

  const renderSubplotLayoutPanel = () => {
    const count = subplotOptions.length;
    if (count === 0) return null;
    if (count <= 1 && colorbarOptions.length === 0) return null;
    const autoCols = Math.ceil(Math.sqrt(count));
    const autoRows = Math.ceil(count / autoCols);
    const twoCols = Math.min(2, count);
    const twoColRows = Math.ceil(count / twoCols);
    const basePresets: LayoutPreset[] = [
      { rows: 1, cols: count, label: `一行 ${count} 列`, hint: '适合横向论文宽图' },
      { rows: count, cols: 1, label: `${count} 行一列`, hint: '适合 Word 纵向检查' },
      { rows: autoRows, cols: autoCols, label: `${autoRows}×${autoCols} 自动网格`, hint: '接近方形紧凑布局' },
      { rows: twoColRows, cols: twoCols, label: `${twoColRows}×${twoCols} 双列`, hint: '常见多面板布局' },
    ];
    const factorPresets: LayoutPreset[] = [];
    for (let rows = 1; rows <= count; rows += 1) {
      const cols = Math.ceil(count / rows);
      if (rows * cols >= count) {
        factorPresets.push({
          rows,
          cols,
          label: `${rows}×${cols}`,
          hint: rows === 1 ? '单行横排' : cols === 1 ? '单列竖排' : '自定义多面板网格',
        });
      }
    }
    const presets = [...basePresets, ...factorPresets].filter(item => item.rows * item.cols >= count);
    const uniquePresets = Array.from(
      new Map(presets.map(item => [`${item.rows}x${item.cols}`, item])).values()
    ).sort((a, b) => {
      const aAuto = a.rows === autoRows && a.cols === autoCols ? -1 : 0;
      const bAuto = b.rows === autoRows && b.cols === autoCols ? -1 : 0;
      if (aAuto !== bAuto) return aAuto - bAuto;
      return (a.rows * a.cols) - (b.rows * b.cols) || a.rows - b.rows || a.cols - b.cols;
    });
    const selectedRows = selectedLayout && selectedLayout.rows * selectedLayout.cols >= count
      ? selectedLayout.rows
      : autoRows;
    const selectedCols = selectedLayout && selectedLayout.rows * selectedLayout.cols >= count
      ? selectedLayout.cols
      : autoCols;
    const selectedPreset: LayoutPreset = uniquePresets.find(item => item.rows === selectedRows && item.cols === selectedCols)
      || { rows: selectedRows, cols: selectedCols, label: `${selectedRows}×${selectedCols}`, hint: '当前版式' };
    const selectedSubplotId = selectedObject?.startsWith('subplot.') ? selectedObject : '';
    const swapFirstId = swapSubplotIds.first || selectedSubplotId || subplotOptions[0]?.id || '';
    const swapSecondId = swapSubplotIds.second || subplotOptions.find(subplot => subplot.id !== swapFirstId)?.id || '';
    const canSwapSubplots = count > 1 && Boolean(swapFirstId && swapSecondId && swapFirstId !== swapSecondId);
    const colorbarAlignmentTargets = getColorbarAlignmentTargets();
    const explicitColorbarPairCount = colorbarAlignmentTargets.filter(target => target.source === 'relation').length;
    const legacyColorbarPairCount = colorbarAlignmentTargets.filter(target => target.source === 'geometry').length;
    const sharedColorbarCount = colorbarAlignmentTargets.filter(target => target.subplots.length > 1).length;
    const subplotIdsWithColorbar = new Set(colorbarAlignmentTargets.flatMap(target => target.subplots.map(subplot => subplot.id)));
    const getSubplotLayoutLabel = (subplot: StandardFigureObject) => (
      `${String(subplot.currentProps.label || subplot.label || subplot.id)}${subplotIdsWithColorbar.has(subplot.id) ? ' · 含色条' : ''}`
    );
    const defaultWidthReferenceId = subplotWidthAlignSettings.referenceId
      || colorbarAlignmentTargets[0]?.subplots[0]?.id
      || subplotOptions[0]?.id
      || '';
    const defaultWidthTargetId = subplotWidthAlignSettings.targetId
      || (selectedSubplotId && selectedSubplotId !== defaultWidthReferenceId ? selectedSubplotId : '')
      || subplotOptions.find(subplot => subplot.id !== defaultWidthReferenceId)?.id
      || '';
    const effectiveWidthAlignSettings: SubplotWidthAlignSettings = {
      ...subplotWidthAlignSettings,
      referenceId: defaultWidthReferenceId,
      targetId: defaultWidthTargetId,
    };
    const widthReferenceBounds = getSubplotOuterBounds(
      effectiveWidthAlignSettings.referenceId,
      effectiveWidthAlignSettings.includeColorbar,
    );
    const widthTargetBounds = readNormalizedBounds(
      subplotOptions.find(subplot => subplot.id === effectiveWidthAlignSettings.targetId) || { currentProps: {} },
    );
    const widthAlignRight = widthReferenceBounds ? widthReferenceBounds.right : null;
    const widthAlignNextWidth = widthReferenceBounds && widthTargetBounds
      ? clampNumber(widthReferenceBounds.right - widthTargetBounds.left, 0.005, 1 - widthTargetBounds.left)
      : null;
    const canAlignSubplotWidth = count > 1
      && Boolean(effectiveWidthAlignSettings.referenceId)
      && Boolean(effectiveWidthAlignSettings.targetId)
      && effectiveWidthAlignSettings.referenceId !== effectiveWidthAlignSettings.targetId
      && Boolean(widthReferenceBounds)
      && Boolean(widthTargetBounds);
    const updateLayoutSetting = (key: keyof SubplotLayoutSettings, value: number) => {
      const safeValue = Number.isFinite(value) ? value : DEFAULT_SUBPLOT_LAYOUT_SETTINGS[key];
      setSubplotLayoutSettings(prev => ({
        ...prev,
        [key]: Number(Math.min(0.35, Math.max(0, safeValue)).toFixed(3)),
      }));
    };
    const updatePhysicalAxesSetting = (key: keyof PhysicalAxesLayoutSettings, value: number) => {
      const fallback = DEFAULT_PHYSICAL_AXES_LAYOUT[key];
      const safeValue = Number.isFinite(value) ? value : fallback;
      const max = key === 'targetWidthIn' || key === 'targetHeightIn' ? 12 : 4;
      const min = key === 'targetWidthIn' || key === 'targetHeightIn' ? 0.2 : 0;
      setPhysicalAxesLayout(prev => ({
        ...prev,
        [key]: Number(Math.min(max, Math.max(min, safeValue)).toFixed(3)),
      }));
    };
    const updateColorbarAlignSetting = (key: keyof ColorbarAlignSettings, value: number | boolean) => {
      setColorbarAlignSettings(prev => {
        if (typeof value === 'boolean') {
          return { ...prev, [key]: value };
        }
        const fallback = DEFAULT_COLORBAR_ALIGN_SETTINGS[key];
        const numericFallback = typeof fallback === 'number' ? fallback : 0;
        const safeValue = Number.isFinite(value) ? value : numericFallback;
        const max = key === 'width' ? 0.12 : 0.15;
        const min = 0;
        return {
          ...prev,
          [key]: Number(clampNumber(safeValue, min, max).toFixed(4)),
        };
      });
    };
    const renderLayoutControl = (
      key: keyof SubplotLayoutSettings,
      label: string,
      max = 0.25,
      step = 0.01,
    ) => (
      <label className="space-y-1 text-[10px] font-semibold text-slate-600">
        <div className="flex items-center justify-between gap-2">
          <span>{label}</span>
          <span className="font-mono text-slate-400">{subplotLayoutSettings[key].toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={step}
          value={subplotLayoutSettings[key]}
          onChange={(event) => updateLayoutSetting(key, Number(event.target.value))}
          className="w-full accent-blue-600"
        />
      </label>
    );
    const physicalPreview = selectedPreset
      ? computeEqualAxesPhysicalLayout({
        rows: selectedPreset.rows,
        cols: selectedPreset.cols,
        targetAxesWidthIn: physicalAxesLayout.targetWidthIn,
        targetAxesHeightIn: physicalAxesLayout.targetHeightIn,
        margins: {
          left: physicalAxesLayout.leftIn,
          right: physicalAxesLayout.rightIn,
          top: physicalAxesLayout.topIn,
          bottom: physicalAxesLayout.bottomIn,
          wspace: selectedPreset.cols <= 1 ? 0 : physicalAxesLayout.wspaceIn,
          hspace: selectedPreset.rows <= 1 ? 0 : physicalAxesLayout.hspaceIn,
        },
      })
      : null;
    const renderPhysicalInput = (key: keyof PhysicalAxesLayoutSettings, label: string, step = 0.05) => (
      <label className="space-y-1 text-[10px] font-semibold text-slate-600">
        <span>{label}</span>
        <input
          type="number"
          min={key === 'targetWidthIn' || key === 'targetHeightIn' ? 0.2 : 0}
          max={key === 'targetWidthIn' || key === 'targetHeightIn' ? 12 : 4}
          step={step}
          value={physicalAxesLayout[key]}
          onChange={(event) => updatePhysicalAxesSetting(key, Number(event.target.value))}
          className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-800 focus:border-blue-400 focus:outline-none"
        />
      </label>
    );
    const compactSettings: SubplotLayoutSettings = {
      marginLeft: 0.10,
      marginRight: 0.04,
      marginTop: 0.06,
      marginBottom: 0.09,
      gapX: 0.04,
      gapY: 0.06,
    };
    const roomySettings: SubplotLayoutSettings = {
      marginLeft: 0.16,
      marginRight: 0.08,
      marginTop: 0.12,
      marginBottom: 0.15,
      gapX: 0.12,
      gapY: 0.16,
    };
    const activeCellWidth = selectedPreset
      ? (1 - subplotLayoutSettings.marginLeft - subplotLayoutSettings.marginRight - subplotLayoutSettings.gapX * Math.max(0, selectedPreset.cols - 1)) / selectedPreset.cols
      : 0;
    const activeCellHeight = selectedPreset
      ? (1 - subplotLayoutSettings.marginTop - subplotLayoutSettings.marginBottom - subplotLayoutSettings.gapY * Math.max(0, selectedPreset.rows - 1)) / selectedPreset.rows
      : 0;
    const layoutTooTight = activeCellWidth < 0.08 || activeCellHeight < 0.08;
    const unmatchedColorbars = Math.max(0, colorbarOptions.length - colorbarAlignmentTargets.length);
    const colorbarCompactSettings: ColorbarAlignSettings = {
      ...colorbarAlignSettings,
      pad: 0.012,
      width: 0.014,
    };
    const colorbarStandardSettings: ColorbarAlignSettings = {
      ...colorbarAlignSettings,
      pad: DEFAULT_COLORBAR_ALIGN_SETTINGS.pad,
      width: DEFAULT_COLORBAR_ALIGN_SETTINGS.width,
    };
    const colorbarRoomySettings: ColorbarAlignSettings = {
      ...colorbarAlignSettings,
      pad: 0.04,
      width: 0.022,
    };

    return (
      <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/60 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-bold text-blue-900">多子图版面重排</div>
            <div className="text-[11px] leading-relaxed text-blue-700 mt-1">
              已识别 {count} 个子图坐标轴框。这里会重排 `subplot.*` 的真实绘图区位置，写入 EditLog 后重渲染；不改原始绘图数据。
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelectGids?.(subplotOptions.map(subplot => subplot.id))}
            className="shrink-0 rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50"
          >
            选中全部
          </button>
          <button
            type="button"
            onClick={restoreOriginalLayout}
            disabled={!layoutSnapshotAvailable}
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${
              layoutSnapshotAvailable
                ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                : 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
            }`}
            title="只回退本次布局中心应用前的画布和子图框位置，不改字体、颜色、线宽等编辑"
          >
            原图布局
          </button>
        </div>
        {count > 1 && (
          <div className="mb-3 rounded-xl border border-indigo-100 bg-white p-3">
            <div className="mb-2">
              <div className="text-xs font-bold text-slate-800">交换子图位置</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                像交换 B 图和 C 图一样，只互换两个子图当前所在位置；不套用新网格，不改字号、颜色、线宽和子图自身大小。色条会跟随对应子图移动。
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <select
                className="min-w-0 rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1.5 text-xs font-semibold text-indigo-900 outline-none focus:border-indigo-300"
                value={swapFirstId}
                onChange={(event) => setSwapSubplotIds(prev => ({ ...prev, first: event.target.value }))}
              >
                {subplotOptions.map(subplot => (
                  <option key={subplot.id} value={subplot.id}>
                    {getSubplotLayoutLabel(subplot)}
                  </option>
                ))}
              </select>
              <span className="text-xs font-bold text-indigo-400">↔</span>
              <select
                className="min-w-0 rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1.5 text-xs font-semibold text-indigo-900 outline-none focus:border-indigo-300"
                value={swapSecondId}
                onChange={(event) => setSwapSubplotIds(prev => ({ ...prev, second: event.target.value }))}
              >
                {subplotOptions.map(subplot => (
                  <option key={subplot.id} value={subplot.id}>
                    {getSubplotLayoutLabel(subplot)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={!canSwapSubplots}
              onClick={() => applySwapSubplotPositions(swapFirstId, swapSecondId)}
              className={`mt-3 w-full rounded-lg border px-2 py-1.5 text-[11px] font-semibold shadow-sm ${
                canSwapSubplots
                  ? 'border-indigo-200 bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
              }`}
            >
              交换这两个子图的位置
            </button>
            <div className="mt-2 text-[10px] leading-relaxed text-indigo-700">
              如果要交换 panel label 的字母含义，建议后续单独改标签文本；本按钮默认交换两个图块的位置，不自动重命名 a/b/c/d。
            </div>
          </div>
        )}
        {count > 1 && (
          <div className="mb-3 rounded-xl border border-cyan-100 bg-white p-3">
            <div className="mb-2">
              <div className="text-xs font-bold text-slate-800">对齐到参考外沿</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                适合“左下图右边界对齐左上热图+色条外边界”：只修改目标子图的宽度，默认保持左边界和高度不变，不移动其他子图。
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[10px] font-semibold text-slate-600">
                <span>参考子图</span>
                <select
                  className="w-full rounded-lg border border-cyan-100 bg-cyan-50 px-2 py-1.5 text-xs font-semibold text-cyan-900 outline-none focus:border-cyan-300"
                  value={effectiveWidthAlignSettings.referenceId}
                  onChange={(event) => setSubplotWidthAlignSettings(prev => ({ ...prev, referenceId: event.target.value }))}
                >
                  {subplotOptions.map(subplot => (
                    <option key={subplot.id} value={subplot.id}>
                      {getSubplotLayoutLabel(subplot)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-[10px] font-semibold text-slate-600">
                <span>要调整的子图</span>
                <select
                  className="w-full rounded-lg border border-cyan-100 bg-cyan-50 px-2 py-1.5 text-xs font-semibold text-cyan-900 outline-none focus:border-cyan-300"
                  value={effectiveWidthAlignSettings.targetId}
                  onChange={(event) => setSubplotWidthAlignSettings(prev => ({ ...prev, targetId: event.target.value }))}
                >
                  {subplotOptions.map(subplot => (
                    <option key={subplot.id} value={subplot.id}>
                      {getSubplotLayoutLabel(subplot)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600">
                <span>参考范围包含色条</span>
                <input
                  type="checkbox"
                  checked={effectiveWidthAlignSettings.includeColorbar}
                  onChange={(event) => setSubplotWidthAlignSettings(prev => ({ ...prev, includeColorbar: event.target.checked }))}
                  className="accent-cyan-600"
                />
              </label>
              <label className="space-y-1 text-[10px] font-semibold text-slate-600">
                <span>调整方式</span>
                <select
                  className="w-full rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-cyan-300"
                  value={effectiveWidthAlignSettings.mode}
                  onChange={(event) => setSubplotWidthAlignSettings(prev => ({
                    ...prev,
                    mode: event.target.value as SubplotWidthAlignMode,
                  }))}
                >
                  <option value="keep-left">保持目标左边界，只改宽度</option>
                  <option value="keep-right">保持目标右边界，改左边界和宽度</option>
                  <option value="center">保持目标中心，改左边界和宽度</option>
                </select>
              </label>
            </div>
            {widthAlignRight !== null && widthAlignNextWidth !== null && (
              <div className="mt-2 rounded-lg border border-cyan-100 bg-cyan-50 px-2 py-1.5 text-[10px] leading-relaxed text-cyan-800">
                参考外沿 right={widthAlignRight.toFixed(3)}；按当前默认模式，目标宽度将变为 {widthAlignNextWidth.toFixed(3)}。高度不变。
              </div>
            )}
            <button
              type="button"
              disabled={!canAlignSubplotWidth}
              onClick={() => applySubplotWidthAlignment(
                effectiveWidthAlignSettings.referenceId,
                effectiveWidthAlignSettings.targetId,
                effectiveWidthAlignSettings,
              )}
              className={`mt-3 w-full rounded-lg border px-2 py-1.5 text-[11px] font-semibold shadow-sm ${
                canAlignSubplotWidth
                  ? 'border-cyan-200 bg-cyan-600 text-white hover:bg-cyan-700'
                  : 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
              }`}
            >
              让目标子图右边界对齐参考外沿
            </button>
            <div className="mt-2 text-[10px] leading-relaxed text-cyan-700">
              该操作是局部布局 patch：不会套用 2×2/3×3 网格，也不会改变右侧子图、色条位置、字号或颜色。
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {uniquePresets.map(preset => (
            <button
              type="button"
              key={`${preset.rows}x${preset.cols}`}
              onClick={() => {
                setSelectedLayout({ rows: preset.rows, cols: preset.cols });
                applySubplotLayout(preset.rows, preset.cols);
              }}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                selectedPreset.rows === preset.rows && selectedPreset.cols === preset.cols
                  ? 'border-blue-500 bg-blue-100 ring-1 ring-blue-200'
                  : 'border-blue-200 bg-white hover:border-blue-400 hover:bg-blue-50'
              }`}
              title={preset.hint}
            >
              <div className="text-xs font-bold text-slate-800">{preset.label}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{preset.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-blue-100 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-bold text-slate-800">子图间距 / 外边距</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                当前目标版式：{selectedPreset.label}。调整滑块后点击“应用当前版式”写回，避免连续拖动造成重复重绘。
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSubplotLayoutSettings(DEFAULT_SUBPLOT_LAYOUT_SETTINGS)}
              className="shrink-0 rounded border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50"
            >
              重置
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {renderLayoutControl('gapX', '水平间距')}
            {renderLayoutControl('gapY', '垂直间距')}
            {renderLayoutControl('marginLeft', '左外边距', 0.3)}
            {renderLayoutControl('marginRight', '右外边距', 0.3)}
            {renderLayoutControl('marginTop', '上外边距', 0.3)}
            {renderLayoutControl('marginBottom', '下外边距', 0.3)}
          </div>
          <button
            type="button"
            onClick={() => applySubplotLayout(selectedPreset.rows, selectedPreset.cols, subplotLayoutSettings)}
            className="mt-3 w-full rounded-lg border border-blue-200 bg-blue-600 px-2 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            应用当前版式：{selectedPreset.label}
          </button>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => {
                setSubplotLayoutSettings(compactSettings);
                applySubplotLayout(selectedPreset.rows, selectedPreset.cols, compactSettings);
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
            >
              紧凑应用
            </button>
            <button
              type="button"
              onClick={() => {
                setSubplotLayoutSettings(DEFAULT_SUBPLOT_LAYOUT_SETTINGS);
                applySubplotLayout(selectedPreset.rows, selectedPreset.cols, DEFAULT_SUBPLOT_LAYOUT_SETTINGS);
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
            >
              标准应用
            </button>
            <button
              type="button"
              onClick={() => {
                setSubplotLayoutSettings(roomySettings);
                applySubplotLayout(selectedPreset.rows, selectedPreset.cols, roomySettings);
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
            >
              宽松应用
            </button>
          </div>
          {layoutTooTight && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700">
              当前边距/间距可能让单个子图过小，长刻度、图例或色条容易被挤压。建议增大画布或减少间距。
            </div>
          )}
        </div>
        <div className="mt-3 rounded-xl border border-emerald-100 bg-white p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-bold text-slate-800">统一真实绘图区尺寸</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                适合投稿排版：输入每个子图坐标轴框的物理宽高，系统自动反推白色画布大小和所有 `subplot.*` 的位置。
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPhysicalAxesLayout(DEFAULT_PHYSICAL_AXES_LAYOUT)}
              className="shrink-0 rounded border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50"
            >
              默认
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {renderPhysicalInput('targetWidthIn', '单个框宽(in)')}
            {renderPhysicalInput('targetHeightIn', '单个框高(in)')}
            {renderPhysicalInput('wspaceIn', '水平间距(in)')}
            {renderPhysicalInput('hspaceIn', '垂直间距(in)')}
            {renderPhysicalInput('leftIn', '左预留(in)')}
            {renderPhysicalInput('rightIn', '右预留(in)')}
            {renderPhysicalInput('topIn', '上预留(in)')}
            {renderPhysicalInput('bottomIn', '下预留(in)')}
          </div>
          {physicalPreview && (
            <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-2 text-[11px] leading-relaxed text-emerald-800">
              <div className="font-semibold">
                当前 {selectedPreset.rows}×{selectedPreset.cols} 预估画布：{physicalPreview.figureWidthIn.toFixed(2)} × {physicalPreview.figureHeightIn.toFixed(2)} in
              </div>
              <div className="mt-1 text-[10px] text-emerald-700">
                每个坐标轴框固定为 {physicalAxesLayout.targetWidthIn.toFixed(2)} × {physicalAxesLayout.targetHeightIn.toFixed(2)} in；标签、标题、图例需要靠外边距预留空间。
              </div>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {uniquePresets.map(preset => (
              <button
                type="button"
                key={`physical-${preset.rows}x${preset.cols}`}
                onClick={() => {
                  setSelectedLayout({ rows: preset.rows, cols: preset.cols });
                  applyEqualAxesPhysicalLayout(preset.rows, preset.cols);
                }}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  selectedPreset.rows === preset.rows && selectedPreset.cols === preset.cols
                    ? 'border-emerald-500 bg-emerald-100 ring-1 ring-emerald-200'
                    : 'border-emerald-200 bg-emerald-50 hover:border-emerald-400 hover:bg-white'
                }`}
                title="同时更新画布尺寸和所有子图绘图区 bounds"
              >
                <div className="text-xs font-bold text-emerald-900">按 {preset.label} 应用</div>
                <div className="text-[10px] text-emerald-700 mt-0.5">固定每个子图框真实尺寸</div>
              </button>
            ))}
          </div>
        </div>
        {colorbarOptions.length > 0 && (
          <div className="mt-3 rounded-xl border border-cyan-100 bg-white p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-slate-800">色条对齐 / Colorbar</div>
                <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                  已识别 {colorbarOptions.length} 个色条；明确关系匹配 {explicitColorbarPairCount} 个（共享色条 {sharedColorbarCount} 个），旧项目几何兼容匹配 {legacyColorbarPairCount} 个。共享色条按全部归属子图的联合外框对齐。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setColorbarAlignSettings(DEFAULT_COLORBAR_ALIGN_SETTINGS)}
                className="shrink-0 rounded border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50"
              >
                默认
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <label className="space-y-1 text-[10px] font-semibold text-slate-600">
                <div className="flex items-center justify-between gap-2">
                  <span>主图到色条距离</span>
                  <span className="font-mono text-slate-400">{colorbarAlignSettings.pad.toFixed(3)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.15}
                  step={0.001}
                  value={colorbarAlignSettings.pad}
                  onChange={(event) => updateColorbarAlignSetting('pad', Number(event.target.value))}
                  className="w-full accent-cyan-600"
                />
              </label>
              <label className="space-y-1 text-[10px] font-semibold text-slate-600">
                <div className="flex items-center justify-between gap-2">
                  <span>色条宽度</span>
                  <span className="font-mono text-slate-400">{colorbarAlignSettings.width.toFixed(3)}</span>
                </div>
                <input
                  type="range"
                  min={0.005}
                  max={0.12}
                  step={0.001}
                  value={colorbarAlignSettings.width}
                  onChange={(event) => updateColorbarAlignSetting('width', Number(event.target.value))}
                  className="w-full accent-cyan-600"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600">
                <span>底部对齐主图</span>
                <input
                  type="checkbox"
                  checked={colorbarAlignSettings.alignBottom}
                  onChange={(event) => updateColorbarAlignSetting('alignBottom', event.target.checked)}
                  className="accent-cyan-600"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600">
                <span>高度等于主图</span>
                <input
                  type="checkbox"
                  checked={colorbarAlignSettings.matchHeight}
                  onChange={(event) => updateColorbarAlignSetting('matchHeight', event.target.checked)}
                  className="accent-cyan-600"
                />
              </label>
            </div>
            {unmatchedColorbars > 0 && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700">
                有 {unmatchedColorbars} 个色条没有可靠匹配到主图。通常是色条离主图过远或 manifest 缺少 bounds，可先手动移动到主图右侧再对齐。
              </div>
            )}
            <button
              type="button"
              onClick={() => applyColorbarAlignment(colorbarAlignSettings)}
              disabled={colorbarAlignmentTargets.length === 0}
              className={`mt-3 w-full rounded-lg border px-2 py-1.5 text-[11px] font-semibold shadow-sm ${
                colorbarAlignmentTargets.length > 0
                  ? 'border-cyan-200 bg-cyan-600 text-white hover:bg-cyan-700'
                  : 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed'
              }`}
            >
              对齐全部色条
            </button>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setColorbarAlignSettings(colorbarCompactSettings);
                  applyColorbarAlignment(colorbarCompactSettings);
                }}
                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
              >
                紧凑色条
              </button>
              <button
                type="button"
                onClick={() => {
                  setColorbarAlignSettings(colorbarStandardSettings);
                  applyColorbarAlignment(colorbarStandardSettings);
                }}
                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
              >
                标准色条
              </button>
              <button
                type="button"
                onClick={() => {
                  setColorbarAlignSettings(colorbarRoomySettings);
                  applyColorbarAlignment(colorbarRoomySettings);
                }}
                className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-white"
              >
                宽松色条
              </button>
            </div>
            <div className="mt-2 text-[10px] leading-relaxed text-cyan-700">
              该操作只改 `colorbar.*` 的 left / bottom / width / height，不改变热图数据、色阶或主图坐标轴框。
            </div>
          </div>
        )}
        <div className="mt-3 text-[10px] leading-relaxed text-blue-700">
          如果标签或图例被挤出白色画布，先在“整张白色画布 / 输出尺寸”里增大画布，再重新应用版面。
        </div>
      </div>
    );
  };

  // Specialized Panels for Phase 3 Axis, Grid, and detailed Legend
  const renderAxisPanel = (obj: ManifestObject) => {
    const props = obj.currentProps as any;
    const xlim = props.xlim || [0, 1];
    const ylim = props.ylim || [0, 1];
    
    return (
      <div className="space-y-6">
        {renderPanelTitle('坐标轴微调 (Axis)')}
        <div className="space-y-4">
          {renderRangePair(obj.id, 'X 轴范围 (Limits)', xlim, 'xlim')}
          {renderRangePair(obj.id, 'Y 轴范围 (Limits)', ylim, 'ylim')}

          {renderNumberInput(obj.id, 'x_tick_rotation', props.x_tick_rotation, (v) => handlePatch(obj.id, 'x_tick_rotation', v), { min: 0, max: 90 })}
          
          {renderSelectInput('刻度方向', props.tick_direction || 'out', ['out', 'in', 'inout'], (v) => handlePatch(obj.id, 'tick_direction', v))}
          
          {renderBoolInput('显示副刻度', Boolean(props.show_minor_ticks), (v) => handlePatch(obj.id, 'show_minor_ticks', v))}
        </div>
      </div>
    );
  };

  const renderGridPanel = (obj: ManifestObject) => {
    const props = obj.currentProps as any;
    return (
      <div className="space-y-6">
        {renderPanelTitle('网格线微调 (Grid)')}
        <div className="space-y-4">
          {renderBoolInput('开启网格', Boolean(props.visible), (v) => handlePatch(obj.id, 'visible', v))}
          {props.visible !== false && (
            <>
              {renderColorInput('网格线颜色', props.color || '#cccccc', (v) => handlePatch(obj.id, 'color', v), `${obj.id}:color`)}
              {renderNumberInput(obj.id, 'linewidth', props.linewidth || 0.5, (v) => handlePatch(obj.id, 'linewidth', v), { min: 0.1, max: 5, step: 0.1 })}
              {renderSelectInput('线型', props.linestyle || '-', ['-', '--', '-.', ':'], (v) => handlePatch(obj.id, 'linestyle', v))}
              {renderNumberInput(obj.id, 'alpha', props.alpha || 1.0, (v) => handlePatch(obj.id, 'alpha', v), { min: 0.0, max: 1.0, step: 0.1 })}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderSpineGroupPanel = (obj: ManifestObject) => {
    const props = obj.currentProps as any;
    return (
      <div className="space-y-6">
        {renderPanelTitle('统一边框 (Spine Group)')}
        <div className="space-y-4">
          {renderBoolInput('显示四边框', Boolean(props.visible), (v) => handlePatch(obj.id, 'visible', v))}
          {renderColorInput('边框颜色', props.color || '#000000', (v) => handlePatch(obj.id, 'color', v), `${obj.id}:color`)}
          {renderNumberInput(obj.id, 'linewidth', props.linewidth || 1, (v) => handlePatch(obj.id, 'linewidth', v), { min: 0, max: 8, step: 0.1 })}
        </div>
      </div>
    );
  };

  const renderAxisDetailPanel = (obj: ManifestObject, axisName: string) => {
    const props = obj.currentProps as any;
    const limits = Array.isArray(props.limits) ? props.limits : [0, 1];
    const editable = Array.isArray(obj.editable) ? obj.editable : [];
    return (
      <div className="space-y-6">
        {renderPanelTitle(`${axisName} 轴详细控制`)}
        <div className="space-y-4">
          {renderRangePair(obj.id, `${axisName} 范围`, limits, 'limits')}
          {renderTextInput(obj.id, 'label', props.label || '', (v) => handlePatch(obj.id, 'label', v))}
          {renderNumberInput(obj.id, 'label_fontsize', props.label_fontsize || 12, (v) => handlePatch(obj.id, 'label_fontsize', v), { min: 4, max: 40, step: 0.5 })}
          {renderColorInput(`${axisName} 轴标题颜色`, props.label_color || '#000000', (v) => handlePatch(obj.id, 'label_color', v), `${obj.id}:label_color`)}
          {renderNumberInput(obj.id, 'tick_rotation', props.tick_rotation || 0, (v) => handlePatch(obj.id, 'tick_rotation', v), { min: -180, max: 180, step: 1 })}
          {renderSelectInput('tick_direction', props.tick_direction || 'out', TICK_DIRECTIONS, (v) => handlePatch(obj.id, 'tick_direction', v))}
          {renderNumberInput(obj.id, 'tick_length', props.tick_length || 3.5, (v) => handlePatch(obj.id, 'tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'tick_width', props.tick_width || 0.8, (v) => handlePatch(obj.id, 'tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput(`${axisName} 刻度线颜色`, props.tick_color || '#000000', (v) => handlePatch(obj.id, 'tick_color', v), `${obj.id}:tick_color`)}
          {renderNumberInput(obj.id, 'tick_pad', props.tick_pad || 3.5, (v) => handlePatch(obj.id, 'tick_pad', v), { min: 0, max: 20, step: 0.5 })}
          {renderBoolInput('show_minor_ticks', Boolean(props.show_minor_ticks), (v) => handlePatch(obj.id, 'show_minor_ticks', v))}
          {renderNumberInput(obj.id, 'minor_tick_length', props.minor_tick_length || 2, (v) => handlePatch(obj.id, 'minor_tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'minor_tick_width', props.minor_tick_width || 0.6, (v) => handlePatch(obj.id, 'minor_tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput(`${axisName} 副刻度线颜色`, props.minor_tick_color || '#000000', (v) => handlePatch(obj.id, 'minor_tick_color', v), `${obj.id}:minor_tick_color`)}
          {renderNumberInput(obj.id, 'tick_labelsize', props.tick_labelsize || 10, (v) => handlePatch(obj.id, 'tick_labelsize', v), { min: 4, max: 30, step: 0.5 })}
          {renderColorInput(`${axisName} 刻度文字颜色`, props.tick_labelcolor || '#000000', (v) => handlePatch(obj.id, 'tick_labelcolor', v), `${obj.id}:tick_labelcolor`)}
          {renderFontSelect(obj.id, 'tick_labelfamily', props.tick_labelfamily || 'Arial', (v) => handlePatch(obj.id, 'tick_labelfamily', v))}
          {editable.includes('tick_label_dx') && renderNumberInput(obj.id, 'tick_label_dx', props.tick_label_dx || 0, (v) => handlePatch(obj.id, 'tick_label_dx', v), { min: -80, max: 80, step: 0.5 })}
          {editable.includes('tick_label_dy') && renderNumberInput(obj.id, 'tick_label_dy', props.tick_label_dy || 0, (v) => handlePatch(obj.id, 'tick_label_dy', v), { min: -80, max: 80, step: 0.5 })}
          {renderBoolInput('sci_notation', Boolean(props.sci_notation), (v) => handlePatch(obj.id, 'sci_notation', v))}
          {renderBoolInput('use_math_text', Boolean(props.use_math_text), (v) => handlePatch(obj.id, 'use_math_text', v))}
          {renderNumberInput(obj.id, 'offset_text_size', props.offset_text_size || 10, (v) => handlePatch(obj.id, 'offset_text_size', v), { min: 4, max: 30, step: 0.5 })}
        </div>
      </div>
    );
  };

  const renderLegendPanel = (obj: ManifestObject) => {
    const props = obj.currentProps as any;
    return (
      <div className="space-y-6">
        {renderPanelTitle('图例容器微调 (Legend)')}
        <div className="space-y-4">
          {renderBoolInput('显示图例', Boolean(props.visible), (v) => handlePatch(obj.id, 'visible', v))}
          {props.visible !== false && (
            <>
              {renderNumberInput(obj.id, 'fontsize', props.fontsize || 10, (v) => handlePatch(obj.id, 'fontsize', v), { min: 4, max: 30 })}
              {renderFontSelect(obj.id, 'fontfamily', props.fontfamily || 'sans-serif', (v) => handlePatch(obj.id, 'fontfamily', v))}
              {renderTextInput(obj.id, 'title', props.title || '', (v) => handlePatch(obj.id, 'title', v))}
              {renderSelectInput('loc', props.loc || 'best', LEGEND_LOCATIONS, (v) => handlePatch(obj.id, 'loc', v))}
              {renderNumberInput(obj.id, 'ncol', props.ncol || 1, (v) => handlePatch(obj.id, 'ncol', v), { min: 1, max: 8, step: 1 })}
              {renderNumberInput(obj.id, 'markerscale', props.markerscale || 1, (v) => handlePatch(obj.id, 'markerscale', v), { min: 0.1, max: 5, step: 0.1 })}
              {renderNumberInput(obj.id, 'marker_yoffset', props.marker_yoffset || 0, (v) => handlePatch(obj.id, 'marker_yoffset', v), { min: -20, max: 20, step: 0.25, displayLabel: '图例符号垂直偏移' })}
              {renderNumberInput(obj.id, 'handletextpad', props.handletextpad ?? 0.8, (v) => handlePatch(obj.id, 'handletextpad', v), { min: 0, max: 5, step: 0.1, displayLabel: '符号文字间距' })}
              {renderNumberInput(obj.id, 'labelspacing', props.labelspacing ?? 0.5, (v) => handlePatch(obj.id, 'labelspacing', v), { min: 0, max: 5, step: 0.1, displayLabel: '图例行距' })}
              {renderBoolInput('显示背景框 (Border)', Boolean(props.frameon), (v) => handlePatch(obj.id, 'frameon', v))}
              {props.frameon !== false && (
                <>
                  {renderColorInput('背景填充色', props.facecolor || '#ffffff', (v) => handlePatch(obj.id, 'facecolor', v), `${obj.id}:facecolor`)}
                  {renderColorInput('边框颜色', props.edgecolor || '#000000', (v) => handlePatch(obj.id, 'edgecolor', v), `${obj.id}:edgecolor`)}
                  {renderNumberInput(obj.id, 'linewidth', props.linewidth || 1.0, (v) => handlePatch(obj.id, 'linewidth', v), { min: 0.0, max: 5.0, step: 0.1 })}
                  {renderNumberInput(obj.id, 'alpha', props.alpha || 1.0, (v) => handlePatch(obj.id, 'alpha', v), { min: 0.0, max: 1.0, step: 0.1 })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderObjectPanel = (obj: ManifestObject) => {
    if (obj.id.startsWith('subplot.')) {
      return renderSubplotPanel(obj);
    }
    if (obj.id.startsWith('spine_group.')) {
      return renderSpineGroupPanel(obj);
    }
    if (obj.id.startsWith('axis.x.')) {
      return renderAxisDetailPanel(obj, 'X');
    }
    if (obj.id.startsWith('axis.y.')) {
      return renderAxisDetailPanel(obj, 'Y');
    }
    if (obj.id.startsWith('axes.')) {
      return renderAxisPanel(obj);
    }
    if (obj.id.startsWith('grid.')) {
      return renderGridPanel(obj);
    }
    if (obj.id.startsWith('legend.')) {
      return renderLegendPanel(obj);
    }

    const annotationAnchor = obj.role === 'annotation_text'
      && obj.editable.includes('anchor_position')
      && obj.currentProps.anchor_position
      && typeof obj.currentProps.anchor_position === 'object'
      ? obj.currentProps.anchor_position as { x?: unknown; y?: unknown; coord_system?: unknown }
      : null;
    const anchorX = Number(annotationAnchor?.x);
    const anchorY = Number(annotationAnchor?.y);
    const anchorCoordSystem = String(annotationAnchor?.coord_system || 'data');
    const updateAnnotationAnchor = (next: Partial<{ x: number; y: number; coord_system: string }>) => {
      if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;
      handlePatch(obj.id, 'anchor_position', {
        x: anchorX,
        y: anchorY,
        coord_system: anchorCoordSystem,
        ...next,
      });
    };

    const descriptorProjections = PROPERTY_INSPECTOR_V2_ENABLED
      ? projectPropertyDescriptors({ center: 'properties', objects: [obj], scope: 'object' })
        .filter(projection => Boolean(projection.propByObjectId[obj.id]))
      : [];
    const descriptorProps = new Set(descriptorProjections
      .map(projection => projection.propByObjectId[obj.id])
      .filter((prop): prop is string => Boolean(prop)));
    const legacyEditable = obj.editable.filter(prop => (
      prop !== 'position'
      && prop !== 'anchor_position'
      && !descriptorProps.has(prop)
    ));

    return (
      <div className="space-y-6">
        {renderPanelTitle(`对象属性：${getReadableObjectLabel(obj)}`)}
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          <div>类型：{getObjectTypeLabel(obj.kind)}</div>
          <div className="font-mono truncate" title={obj.id}>GID：{obj.id}</div>
        </div>
        <div className="space-y-4">
          {descriptorProjections.length > 0 && (
            <div className="space-y-3" data-property-inspector-version="2">
              {descriptorProjections.map(projection => {
                const prop = projection.propByObjectId[obj.id];
                if (!prop) return null;
                return (
                  <React.Fragment key={projection.key}>
                    <PropertyControl
                      projection={projection}
                      objectId={obj.id}
                      dirty={isDirty(obj.id, prop)}
                      onChange={(value, resolvedProp) => handlePatch(obj.id, resolvedProp, value)}
                    />
                  </React.Fragment>
                );
              })}
            </div>
          )}
          {annotationAnchor && Number.isFinite(anchorX) && Number.isFinite(anchorY) && (
            <div className="space-y-2 rounded-md border border-sky-100 bg-sky-50/60 p-3">
              <div className="text-xs font-semibold text-sky-900">箭头锚点</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-[11px] text-slate-500">
                  <span>X</span>
                  <input
                    type="number"
                    step="any"
                    value={anchorX}
                    onChange={(event) => updateAnnotationAnchor({ x: Number(event.target.value) })}
                    className="w-full rounded border border-sky-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="space-y-1 text-[11px] text-slate-500">
                  <span>Y</span>
                  <input
                    type="number"
                    step="any"
                    value={anchorY}
                    onChange={(event) => updateAnnotationAnchor({ y: Number(event.target.value) })}
                    className="w-full rounded border border-sky-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-sky-500"
                  />
                </label>
              </div>
              <select
                value={anchorCoordSystem}
                onChange={(event) => updateAnnotationAnchor({ coord_system: event.target.value })}
                className="w-full rounded border border-sky-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-sky-500"
              >
                <option value="data">数据坐标</option>
                <option value="axes">子图比例坐标</option>
                <option value="figure">画布比例坐标</option>
              </select>
            </div>
          )}
          {legacyEditable.map((prop) => {
            const val = obj.currentProps[prop];
            return renderField(obj.id, prop, typeof val, val);
          })}
        </div>
      </div>
    );
  };

  const renderGlobalsPanel = () => {
    if (!manifest.globals || Object.keys(manifest.globals).length === 0) return null;
    return (
      <div className="space-y-6 pt-6 border-t border-slate-200 mt-6">
        {renderPanelTitle('整张白色画布 / 输出尺寸')}
        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          控制最终导出的白色画布大小和 DPI。它决定整张图的物理尺寸；坐标轴框/真实绘图区宽高请选中 `subplot.*` 后在“真实绘图区 / 坐标轴框”中调整。
        </div>
        <div className="space-y-4">
          {Object.entries(manifest.globals).map(([key, field]) => {
            const f = field as ManifestField;
            if (f.type === 'number') {
              return renderNumberInput('global', key, f.value, (v) => handlePatch('global', key, v), { min: f.min, max: f.max, step: f.step });
            }
            if (f.type === 'string') {
              return renderTextInput('global', key, f.value, (v) => handlePatch('global', key, v));
            }
            if (f.type === 'color') {
              return renderColorInput(key, f.value, (v) => handlePatch('global', key, v), `global:${key}`);
            }
            if (f.type === 'boolean') {
              return renderBoolInput(key, f.value, (v) => handlePatch('global', key, v));
            }
            if (f.type === 'select') {
              return renderSelectInput(key, f.value, f.options, (v) => handlePatch('global', key, v));
            }
            return null;
          })}
        </div>
      </div>
    );
  };

  const renderGroupsPanel = () => {
    const groups = manifest.groups || [];
    const bindings = manifest.bindings || [];

    if (groups.length === 0) {
      return (
        <div className="text-sm text-slate-500 py-8 text-center">
          未在脚本中检测到逻辑分组（如折线、柱形）。
          <p className="text-xs text-slate-400 mt-2 font-mono">使用 ax.bar 或 ax.plot 并提供 label 参数时会自动在此处生成逻辑分组。</p>
        </div>
      );
    }

    const handleGroupPropertyChange = (groupId: string, prop: string, val: unknown) => {
      const binding = bindings.find((b: Binding) => b.groupId === groupId);
      if (!binding || !Array.isArray(binding.gids)) return;

      const targetObjects = binding.gids
        .map((gid: string) => manifest.objects.find(o => o.id === gid))
        .filter(Boolean) as ManifestObject[];
      const patches = targetObjects.flatMap((obj) => {
        let actualProp = prop;
        if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
          actualProp = 'facecolor';
        }
        if (!supportsBatchProp(obj, actualProp)) return [];
        return compileIntentPatches({
          intent: actualProp === 'visible' ? 'visibility.component' : 'style.component',
          scope: {
            selectionMode: 'explicit_objects',
            objectIds: [obj.id],
            targetKinds: [obj.kind],
          },
          operation: { prop: actualProp, value: val },
          commit: { mode: 'draft', applyAsOneHistoryStep: true },
          fallback: { onUnsupported: 'skip_with_warning' },
        });
      });
      void onPatch(patches);
    };

    const handleBatchGroupPropertyChange = (groupIds: string[], prop: string, val: unknown) => {
      const patches: PatchEntry[] = [];
      groupIds.forEach(groupId => {
        const g = groups.find((group: any) => group.groupId === groupId);
        if (!g) return;

        if (prop === 'color' && g.paletteId && !g.paletteId.startsWith('inferred_')) {
          const binding = bindings.find((b: Binding) => b.paletteId === g.paletteId);
          const gids = binding ? binding.gids : [];
          patches.push({
            type: 'code_patch' as const,
            target_id: g.paletteId,
            new_value: val as string,
            gids
          });
        } else {
          const binding = bindings.find((b: Binding) => b.groupId === groupId);
          if (binding && Array.isArray(binding.gids)) {
            const targetObjects = binding.gids
              .map((gid: string) => manifest.objects.find(o => o.id === gid))
              .filter(Boolean) as ManifestObject[];
            targetObjects.forEach((obj) => {
              let actualProp = prop;
              if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
                actualProp = 'facecolor';
              }
              if (!supportsBatchProp(obj, actualProp)) return;
              patches.push(...compileIntentPatches({
                intent: actualProp === 'visible' ? 'visibility.component' : 'style.component',
                scope: {
                  selectionMode: 'explicit_objects',
                  objectIds: [obj.id],
                  targetKinds: [obj.kind],
                },
                operation: { prop: actualProp, value: val },
                commit: { mode: 'draft', applyAsOneHistoryStep: true },
                fallback: { onUnsupported: 'skip_with_warning' },
              }));
            });
          }
        }
      });
      if (patches.length > 0) {
        void onPatch(patches);
      }
    };

    const handleGroupCheckboxClick = (groupId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const next = new Set(selectedGroupIds);
      if (event.shiftKey && lastSelectedGroupId) {
        const allGroupIds = groups.map((gr: any) => gr.groupId);
        const idx1 = allGroupIds.indexOf(lastSelectedGroupId);
        const idx2 = allGroupIds.indexOf(groupId);
        if (idx1 !== -1 && idx2 !== -1) {
          const start = Math.min(idx1, idx2);
          const end = Math.max(idx1, idx2);
          const shouldAdd = !selectedGroupIds.has(groupId);
          for (let i = start; i <= end; i++) {
            const id = allGroupIds[i];
            if (shouldAdd) next.add(id);
            else next.delete(id);
          }
        }
      } else {
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
      }
      setSelectedGroupIds(next);
      setLastSelectedGroupId(groupId);
    };

    return (
      <div className="space-y-6">
        {renderPanelTitle('分组批量编辑')}
        <p className="text-xs text-slate-400 mb-4">修改组属性将同步应用到该逻辑分组内的所有子元素。支持 Shift 连选多选进行批量编辑。</p>

        {selectedGroupIds.size > 0 && (
          <div className="p-4 border border-blue-200 rounded-lg bg-blue-50/20 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-blue-900 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                批量编辑已选 ({selectedGroupIds.size} 个组)
              </h4>
              <button
                type="button"
                onClick={() => setSelectedGroupIds(new Set())}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                取消选择
              </button>
            </div>
            
            <div className="space-y-3 pt-2 border-t border-blue-100">
              {/* Batch Fill Color */}
              <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-xs">
                <span className="text-slate-600 font-medium">填充颜色</span>
                <div className="w-6 h-6 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
                  <input
                    type="color"
                    className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
                    onChange={(e) => handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'color', e.target.value)}
                  />
                </div>
                <span className="text-[10px] text-slate-400">点击选择并应用</span>
              </div>

              {/* Batch Edge Color */}
              <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-xs">
                <span className="text-slate-600 font-medium">边框颜色</span>
                <div className="w-6 h-6 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
                  <input
                    type="color"
                    className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
                    onChange={(e) => handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'edgecolor', e.target.value)}
                  />
                </div>
                <span className="text-[10px] text-slate-400">点击选择并应用</span>
              </div>

              {/* Batch Linewidth */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
                <span className="text-slate-600 font-medium">线宽/边框</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  className="border border-slate-200 rounded p-1 w-full bg-white text-slate-700"
                  placeholder="批量设置宽度..."
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!isNaN(v)) {
                      handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'linewidth', v);
                    }
                  }}
                />
              </div>

              {/* Batch Alpha */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
                <span className="text-slate-600 font-medium">不透明度</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                  onChange={(e) => handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'alpha', Number(e.target.value))}
                />
              </div>

              {/* Batch Visible */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600 font-medium">显示隐藏</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'visible', true)}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 text-[11px] font-medium"
                  >
                    全部显示
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBatchGroupPropertyChange(Array.from(selectedGroupIds), 'visible', false)}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 text-[11px] font-medium"
                  >
                    全部隐藏
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {groups.map((g: any) => {
            const binding = bindings.find((b: Binding) => b.groupId === g.groupId);
            const gids = binding ? binding.gids : [];
            if (gids.length === 0) return null;

            const firstObj = manifest.objects.find(o => o.id === gids[0]);
            const firstProps = firstObj?.currentProps || {};
            const groupColor = resolvePickerColor(firstProps.facecolor || firstProps.color || '#3b82f6');
            const groupEdgeColor = resolvePickerColor(firstProps.edgecolor || '#000000');
            const groupAlpha = typeof firstProps.alpha === 'number' ? firstProps.alpha : 1.0;
            const groupLinewidth = typeof firstProps.linewidth === 'number' ? firstProps.linewidth : 1.0;
            const groupVisible = firstProps.visible !== false;
            const isChecked = selectedGroupIds.has(g.groupId);

            return (
              <div key={g.groupId} className={`p-3 border rounded-lg space-y-4 hover:border-slate-200 transition-colors ${isChecked ? 'border-blue-200 bg-blue-50/10' : 'border-slate-100 bg-slate-50/50'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={(e) => handleGroupCheckboxClick(g.groupId, e)}
                      onChange={() => {}}
                      className="mt-1 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                    <div>
                      <h4 className="text-sm font-semibold text-slate-800 cursor-pointer" onClick={(e) => handleGroupCheckboxClick(g.groupId, e)}>{g.label}</h4>
                      <span className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded uppercase font-mono font-bold mr-1">
                        {g.kind}
                      </span>
                      <span className="text-[10px] text-slate-400">成员 {gids.length} 处</span>
                    </div>
                  </div>
                  
                  <button
                    type="button"
                    onClick={() => onSelectObject(gids[0])}
                    className="text-xs text-blue-600 hover:text-blue-700 font-semibold"
                  >
                    定位首个
                  </button>
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-100">
                  {/* Fill Color */}
                  <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-xs">
                    <span className="text-slate-500">组填充颜色</span>
                    <div className="w-6 h-6 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
                      <input
                        type="color"
                        className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
                        value={groupColor}
                        onChange={(e) => {
                          if (g.paletteId && !g.paletteId.startsWith('inferred_')) {
                            handlePaletteColorChange(g.paletteId, e.target.value);
                          } else {
                            handleGroupPropertyChange(g.groupId, 'color', e.target.value);
                          }
                        }}
                      />
                    </div>
                    <span className="font-mono text-slate-400 uppercase">{groupColor}</span>
                  </div>

                  {/* Edge Color */}
                  <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-xs">
                    <span className="text-slate-500">组边框颜色</span>
                    <div className="w-6 h-6 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
                      <input
                        type="color"
                        className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
                        value={groupEdgeColor}
                        onChange={(e) => handleGroupPropertyChange(g.groupId, 'edgecolor', e.target.value)}
                      />
                    </div>
                    <span className="font-mono text-slate-400 uppercase">{groupEdgeColor}</span>
                  </div>

                  {/* Linewidth */}
                  <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
                    <span className="text-slate-500">线宽/边框</span>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      className="border border-slate-200 rounded p-1 w-full bg-white text-slate-700"
                      value={groupLinewidth}
                      onChange={(e) => handleGroupPropertyChange(g.groupId, 'linewidth', Number(e.target.value))}
                    />
                  </div>

                  {/* Alpha */}
                  <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
                    <span className="text-slate-500">不透明度</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                      value={groupAlpha}
                      onChange={(e) => handleGroupPropertyChange(g.groupId, 'alpha', Number(e.target.value))}
                    />
                  </div>

                  {/* Visible */}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">显示该组</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={groupVisible}
                        onChange={(e) => handleGroupPropertyChange(g.groupId, 'visible', e.target.checked)}
                      />
                      <div className="w-8 h-4 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const supportsBatchProp = (obj: ManifestObject | undefined, prop: string): boolean => {
    if (!obj) return false;
    const declaredCapability = obj.propertyCapabilities?.find(capability => capability.prop === prop);
    if (declaredCapability) return declaredCapability.replay !== 'unsupported';
    if (obj.editable.includes(prop) && !getUnsupportedProps(obj).includes(prop)) return true;
    if (prop === 'visible') return true;
    if (prop === 'alpha') return ['line', 'patch', 'collection', 'legend', 'grid', 'text', 'figure', 'bar_container', 'errorbar_container', 'boxplot_container', 'violinplot_container'].includes(obj.kind);
    if (prop === 'color') return ['line', 'patch', 'collection', 'text', 'spine', 'spine_group', 'grid', 'xtick', 'ytick', 'bar_container', 'errorbar_container', 'boxplot_container', 'violinplot_container'].includes(obj.kind);
    if (prop === 'facecolor') return ['patch', 'collection', 'legend', 'bar_container', 'violinplot_container'].includes(obj.kind);
    if (prop === 'edgecolor') return ['patch', 'collection', 'legend', 'bar_container', 'violinplot_container'].includes(obj.kind);
    if (prop === 'linewidth') return ['line', 'patch', 'collection', 'spine', 'spine_group', 'grid', 'bar_container', 'errorbar_container', 'boxplot_container', 'violinplot_container'].includes(obj.kind);
    if (['elinewidth', 'capsize', 'capthick'].includes(prop)) return obj.kind === 'errorbar_container';
    if (prop === 'box_color' || prop === 'median_color') return obj.kind === 'boxplot_container';
    if (prop === 'markersize') return obj.kind === 'line';
    if (['markerscale', 'marker_yoffset', 'handletextpad', 'labelspacing'].includes(prop)) return obj.kind === 'legend';
    if (prop === 'size') return obj.kind === 'collection';
    if (prop === 'fontsize') return obj.kind === 'text' || obj.kind === 'legend' || obj.kind === 'xtick' || obj.kind === 'ytick';
    if (prop === 'fontfamily') return obj.kind === 'text' || obj.kind === 'legend' || obj.kind === 'xtick' || obj.kind === 'ytick';
    if (prop === 'fontweight' || prop === 'fontstyle') return obj.kind === 'text' || obj.kind === 'legend' || obj.kind === 'axis_x' || obj.kind === 'axis_y' || obj.kind === 'xtick' || obj.kind === 'ytick';
    if (['left', 'bottom', 'width', 'height', 'aspect'].includes(prop)) {
      return obj.kind === 'subplot' && !getUnsupportedProps(obj).includes(prop);
    }
    if (['left', 'bottom', 'width', 'height', 'tick_fontsize', 'label'].includes(prop)) {
      return obj.kind === 'colorbar';
    }
    if (prop === 'linestyle') return ['line', 'grid', 'spine', 'spine_group'].includes(obj.kind);
    if (['tick_rotation', 'tick_label_dx', 'tick_label_dy'].includes(prop)) {
      return ['axis_x', 'axis_y'].includes(obj.kind);
    }
    if (['tick_direction', 'tick_length', 'tick_width', 'tick_color', 'show_minor_ticks'].includes(prop)) {
      return ['axis_x', 'axis_y', 'axes'].includes(obj.kind);
    }
    return false;
  };

  const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const getLegendContainerId = (obj: ManifestObject | undefined) => {
    if (!obj) return null;
    if (obj.kind === 'legend' && obj.id.startsWith('legend.')) return obj.id;
    if (obj.identity?.relation?.legendId) return obj.identity.relation.legendId;
    const match = obj.id.match(/^legend_(?:text|title|line|patch|collection|marker)\.(figure\.\d+|\d+)(?:\.\d+)?$/);
    return match ? `legend.${match[1]}` : null;
  };

  const buildLegendMarkerScalePatches = (items: ManifestObject[], nextFontSize: unknown): PatchEntry[] => {
    const numericFontSize = Number(nextFontSize);
    if (!Number.isFinite(numericFontSize) || numericFontSize <= 0) return [];

    const legendIds = Array.from(new Set(items.map(getLegendContainerId).filter(Boolean))) as string[];
    return legendIds.flatMap((legendId) => {
      const legend = manifest.objects.find(obj => obj.id === legendId && obj.kind === 'legend');
      if (!legend || !supportsBatchProp(legend, 'markerscale')) return [];

      const legendTextSizes = manifest.objects
        .filter(obj => getLegendContainerId(obj) === legendId)
        .map(obj => Number(obj.currentProps.fontsize))
        .filter(size => Number.isFinite(size) && size > 0);
      const currentFontSize = Number(legend.currentProps.fontsize) || legendTextSizes[0] || 10;
      const currentMarkerScale = Number(legend.currentProps.markerscale) || 1;
      const nextMarkerScale = clampNumber(currentMarkerScale * (numericFontSize / currentFontSize), 0.1, 5);

      return [{
        op: 'set' as const,
        gid: legend.id,
        prop: 'markerscale',
        value: Number(nextMarkerScale.toFixed(3)),
        mode: 'backend_patch' as const,
      }];
    });
  };

  const renderComponentsPanel = () => {
    const hasColorRows = (value: unknown) => {
      if (!Array.isArray(value)) return Boolean(value);
      return value.length > 0;
    };
    const isMarkerLine = (obj: ManifestObject) => {
      const marker = obj.currentProps.marker;
      const linestyle = String(obj.currentProps.linestyle ?? '');
      return obj.kind === 'line'
        && typeof marker === 'string'
        && marker !== ''
        && marker !== 'None'
        && marker !== 'none'
        && linestyle.toLowerCase().includes('none');
    };
    const isScatterCollection = (obj: ManifestObject) => {
      return obj.kind === 'collection'
        && (typeof obj.currentProps.size === 'number' || hasColorRows(obj.currentProps.facecolor));
    };
    const isLegendChild = (obj: ManifestObject) => Boolean(
      obj.identity?.relation?.legendId && ['line', 'patch', 'collection'].includes(obj.kind),
    )
      || /^legend_(?:line|patch|collection|marker)\./.test(obj.id)
      || obj.role === 'legend_marker';
    const scopedObjects = objects.filter(obj => {
      if (componentSubplotScope === 'all') return true;
      return getObjectSubplotId(obj) === componentSubplotScope;
    });
    const barContainerObjects = scopedObjects.filter(obj => obj.kind === 'bar_container');
    const errorbarContainerObjects = scopedObjects.filter(obj => obj.kind === 'errorbar_container');
    const stemContainerObjects = scopedObjects.filter(obj => obj.kind === 'stem_container');
    const boxplotContainerObjects = scopedObjects.filter(obj => obj.kind === 'boxplot_container');
    const violinContainerObjects = scopedObjects.filter(obj => obj.kind === 'violinplot_container');
    const claimedChildIds = new Set(
      [
        ...barContainerObjects,
        ...errorbarContainerObjects,
        ...stemContainerObjects,
        ...boxplotContainerObjects,
        ...violinContainerObjects,
      ].flatMap(container => container.children || []),
    );
    const isClaimedContainerChild = (obj: ManifestObject) => (
      COMPONENT_TARGET_RESOLVER_V2_ENABLED && claimedChildIds.has(obj.id)
    );
    const lineObjects = scopedObjects.filter(obj => obj.kind === 'line' && !isLegendChild(obj) && !isMarkerLine(obj) && !isClaimedContainerChild(obj));
    const pointObjects = scopedObjects.filter(obj => !isLegendChild(obj) && !isClaimedContainerChild(obj) && (isMarkerLine(obj) || isScatterCollection(obj)));
    const legacyErrorbarObjects = scopedObjects.filter(obj => obj.kind === 'collection' && !isLegendChild(obj) && !isScatterCollection(obj) && !isClaimedContainerChild(obj));
    const errorbarObjects = COMPONENT_TARGET_RESOLVER_V2_ENABLED && errorbarContainerObjects.length > 0
      ? errorbarContainerObjects
      : legacyErrorbarObjects;
    const annotationArrowObjects = COMPONENT_TARGET_RESOLVER_V2_ENABLED
      ? scopedObjects.filter(obj => obj.role === 'annotation_arrow')
      : [];
    const patchObjects = scopedObjects.filter(obj => obj.kind === 'patch' && obj.role !== 'annotation_arrow' && !isLegendChild(obj) && !isClaimedContainerChild(obj));
    const textObjects = scopedObjects.filter(obj => obj.kind === 'text');
    const axisObjects = scopedObjects.filter(obj => ['axes', 'axis_x', 'axis_y'].includes(obj.kind));
    const subplotPanelObjects = scopedObjects.filter(obj => obj.kind === 'subplot');
    const legendObjects = scopedObjects.filter(obj => obj.kind === 'legend');
    const heatmapObjects = scopedObjects.filter(obj => obj.kind === 'heatmap');
    const colorbarObjects = scopedObjects.filter(obj => obj.kind === 'colorbar');
    const spineGroupObjects = scopedObjects.filter(obj => obj.kind === 'spine_group');
    const individualSpineObjects = scopedObjects.filter(obj => obj.kind === 'spine');
    const frameObjects = spineGroupObjects.length > 0 ? spineGroupObjects : individualSpineObjects;
    const gridObjects = scopedObjects.filter(obj => obj.kind === 'grid');
    const legendMarkerObjects = scopedObjects.filter(obj => isLegendChild(obj));
    const componentGroups = [
      {
        id: 'subplots',
        label: '子图面板 / 比例',
        description: '每个 Axes 在整张 Figure 中的位置、宽高和比例。适合统一多面板布局。',
        objects: subplotPanelObjects,
        colorProp: null,
        sizeProp: null,
      },
      {
        id: 'texts',
        label: '文本 / 标签 / 刻度文字',
        description: '标题、轴标签、刻度文字、图例文字等 Text 对象。',
        objects: textObjects,
        colorProp: 'color',
        sizeProp: null,
      },
      {
        id: 'axes',
        label: '坐标轴系统',
        description: '坐标范围、刻度、轴标签等坐标轴相关虚拟对象。',
        objects: axisObjects,
        colorProp: null,
        sizeProp: null,
      },
      {
        id: 'legends',
        label: '图例容器',
        description: 'Legend 容器，适合批量控制显隐、透明度、字号和图例符号缩放。',
        objects: legendObjects,
        colorProp: null,
        sizeProp: null,
      },
      {
        id: 'legendMarkers',
        label: '图例符号 / 图例线条',
        description: 'Legend 内部的示例点、示例线和色块。已与真实数据线、散点、柱形分开，避免批量编辑时混淆。',
        objects: legendMarkerObjects,
        colorProp: null,
        sizeProp: null,
      },
      {
        id: 'lines',
        label: '线条 / 拟合线',
        description: 'Line2D 对象，适合调整曲线、均值线、拟合线。',
        objects: lineObjects,
        colorProp: 'color',
        sizeProp: null,
      },
      {
        id: 'points',
        label: '点 / 散点',
        description: 'Marker 或 PathCollection，适合调整点填充色、边框色和点大小。',
        objects: pointObjects,
        colorProp: 'facecolor',
        edgeColorProp: 'edgecolor',
        sizeProp: 'size',
      },
      {
        id: 'bars',
        label: '柱形系列',
        description: 'BarContainer 统一控制整组柱形。容器存在时不再重复修改内部 Rectangle 子对象。',
        objects: COMPONENT_TARGET_RESOLVER_V2_ENABLED ? barContainerObjects : [],
        colorProp: 'facecolor',
        edgeColorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'errorbars',
        label: '误差棒系列',
        description: COMPONENT_TARGET_RESOLVER_V2_ENABLED && errorbarContainerObjects.length > 0
          ? 'ErrorbarContainer 统一控制数据线、误差线和端帽，不重复修改内部 children。'
          : 'LineCollection，适合调整误差棒颜色、线宽和透明度。',
        objects: errorbarObjects,
        colorProp: COMPONENT_TARGET_RESOLVER_V2_ENABLED && errorbarContainerObjects.length > 0 ? 'color' : 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'stems',
        label: '茎叶图系列',
        description: 'StemContainer 统一控制茎线、标记和基线，避免分别修改内部 Line2D/LineCollection。',
        objects: COMPONENT_TARGET_RESOLVER_V2_ENABLED ? stemContainerObjects : [],
        colorProp: 'stem_color',
        sizeProp: null,
      },
      {
        id: 'boxplots',
        label: '箱线图系列',
        description: 'BoxplotContainer 统一控制箱体、须线、中位线和离群点。',
        objects: COMPONENT_TARGET_RESOLVER_V2_ENABLED ? boxplotContainerObjects : [],
        colorProp: 'color',
        sizeProp: null,
      },
      {
        id: 'violins',
        label: '小提琴图系列',
        description: 'ViolinplotContainer 统一控制琴身和统计线。',
        objects: COMPONENT_TARGET_RESOLVER_V2_ENABLED ? violinContainerObjects : [],
        colorProp: 'facecolor',
        edgeColorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'patches',
        label: '柱形 / 面 / 图形块',
        description: 'Bar、Rectangle、Patch 等对象。',
        objects: patchObjects,
        colorProp: 'facecolor',
        edgeColorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'frames',
        label: '子图边框 / 坐标轴框线',
        description: spineGroupObjects.length > 0
          ? '每个子图的四边框组。适合一键统一 8 个子图边框线宽、颜色和显隐。'
          : '单独的坐标轴边框线。适合统一边框线宽、颜色和显隐。',
        objects: frameObjects,
        colorProp: 'color',
        sizeProp: null,
      },
      {
        id: 'annotationArrows',
        label: '标注箭头',
        description: 'Annotation 的箭头样式子对象。只修改箭头，不改变数据线、普通图形块或文字锚点。',
        objects: annotationArrowObjects,
        colorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'grids',
        label: '网格线',
        description: '坐标网格线。适合统一网格线颜色、线宽、线型和显隐。',
        objects: gridObjects,
        colorProp: 'color',
        sizeProp: null,
      },
      {
        id: 'heatmaps',
        label: '热图 (Heatmap)',
        description: 'AxesImage 或 QuadMesh，可调整色阶与色带。',
        objects: heatmapObjects,
        colorProp: null,
        sizeProp: null,
      },
      {
        id: 'colorbars',
        label: '色条 (Colorbar)',
        description: 'Colorbar 容器，可调整标签文字、刻度字号与显示隐藏。',
        objects: colorbarObjects,
        colorProp: null,
        sizeProp: null,
      },
    ].filter(group => group.objects.length > 0);

    const commonComponentProp = (items: ManifestObject[], prop: string, fallback: unknown) => {
      const values = items.map(item => item.currentProps[prop]).filter(value => value !== undefined && value !== null && value !== '');
      return values.length > 0 && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : fallback;
    };

    const componentRoleForItems = (items: ManifestObject[]): SemanticTargetRole | undefined => {
      if (items.length === 0) return undefined;
      if (items.every(obj => obj.kind === 'bar_container' || obj.role === 'bar_series')) return 'data_bar';
      if (items.every(obj => obj.kind === 'errorbar_container' || obj.role === 'errorbar_series')) return 'data_errorbar';
      if (items.every(obj => obj.kind === 'stem_container' || obj.role === 'stem_series')) return 'data_stem';
      if (items.every(obj => obj.kind === 'boxplot_container' || obj.role === 'boxplot_group')) return 'data_boxplot';
      if (items.every(obj => obj.kind === 'violinplot_container' || obj.role === 'violin_group')) return 'data_violin';
      if (items.every(obj => obj.kind === 'spine' || obj.kind === 'spine_group')) return 'axis_frame';
      if (items.every(obj => obj.kind === 'grid')) return 'grid';
      if (items.every(isLegendChild)) return 'legend_marker';
      if (items.every(obj => obj.kind === 'line' && !isLegendChild(obj))) return 'data_line';
      if (items.every(obj => obj.kind === 'collection' && !isLegendChild(obj))) return 'data_point';
      if (items.every(obj => obj.role === 'annotation_arrow')) return 'annotation_arrow';
      if (items.every(obj => obj.kind === 'patch' && !isLegendChild(obj))) return 'data_patch';
      if (items.every(obj => obj.kind === 'legend')) return 'legend_container';
      if (items.every(obj => obj.kind === 'heatmap')) return 'heatmap';
      if (items.every(obj => obj.kind === 'colorbar')) return 'colorbar';
      return undefined;
    };

    const patchComponentGroup = (items: ManifestObject[], prop: string, value: unknown) => {
      const supportedItems = items.filter(obj => supportsBatchProp(obj, prop));
      const migratedRole = componentRoleForItems(supportedItems);
      const intent: EditingIntent = {
        intent: prop === 'visible' ? 'visibility.component' : 'style.component',
        scope: {
          selectionMode: 'explicit_objects',
          objectIds: supportedItems.map(obj => obj.id),
          targetKinds: Array.from(new Set(supportedItems.map(obj => obj.kind))),
          ...(COMPONENT_TARGET_RESOLVER_V2_ENABLED && migratedRole ? { targetRole: migratedRole } : {}),
        },
        operation: { prop, value },
        commit: { mode: 'draft', applyAsOneHistoryStep: true },
        fallback: { onUnsupported: 'skip_with_warning' },
      };
      const patches = COMPONENT_TARGET_RESOLVER_V2_ENABLED && migratedRole
        ? compileComponentIntentPatches(intent)
        : compileIntentPatches(intent);
      if (prop === 'fontsize') {
        patches.push(...buildLegendMarkerScalePatches(supportedItems, value));
      }
      if (patches.length > 0) void onPatch(patches);
    };

    const patchPointFillColor = (items: ManifestObject[], value: unknown) => {
      const patches = items.flatMap(obj => {
        const prop = obj.kind === 'line' ? 'color' : obj.kind === 'collection' ? 'facecolor' : null;
        if (!prop || !supportsBatchProp(obj, prop)) return [];
        const targetRole: SemanticTargetRole = obj.kind === 'collection' ? 'data_point' : 'data_line';
        const intent: EditingIntent = {
          intent: 'style.component',
          scope: {
            selectionMode: 'explicit_objects',
            objectIds: [obj.id],
            targetKinds: [obj.kind],
            ...(COMPONENT_TARGET_RESOLVER_V2_ENABLED ? { targetRole } : {}),
          },
          operation: { prop, value },
          commit: { mode: 'draft', applyAsOneHistoryStep: true },
          fallback: { onUnsupported: 'skip_with_warning' },
        };
        return COMPONENT_TARGET_RESOLVER_V2_ENABLED
          ? compileComponentIntentPatches(intent)
          : compileIntentPatches(intent);
      });
      if (patches.length > 0) void onPatch(patches);
    };

    if (componentGroups.length === 0) {
      return (
        <div className="text-sm text-slate-500 py-8 text-center">
          当前图中没有可批量编辑的图形组件。
          <p className="text-xs text-slate-400 mt-2">渲染后会自动识别线条、误差棒、散点集合、柱形和边框。</p>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        {renderPanelTitle('组件中心')}
        <p className="text-xs text-slate-400">按真实 matplotlib 图元聚合，不依赖脚本 label。线、点、误差棒分开控制，避免改错对象。</p>
        {allSubplotOptions.length > 0 && (
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 space-y-2">
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-xs font-semibold text-blue-900">作用范围</div>
                <div className="text-[11px] text-blue-700">选择某个子图后，下方所有批量控件只作用于该子图内部对象。</div>
              </div>
              <select
                className="w-full rounded-md border border-blue-200 bg-white px-2 py-1 text-xs text-blue-900 outline-none"
                value={componentSubplotScope}
                onChange={(event) => setComponentSubplotScope(event.target.value)}
              >
                <option value="all">全部子图</option>
                {allSubplotOptions.map(subplot => (
                  <option key={subplot.id} value={subplot.id}>
                    {String(subplot.currentProps.label || subplot.label || subplot.id)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {componentGroups.map(group => {
          const selectedTargets = group.objects.filter(obj => selectedGids.includes(obj.id) || selectedObject === obj.id);
          const targetObjects = selectedTargets.length > 0 ? selectedTargets : group.objects;
          const isSubsetEditing = selectedTargets.length > 0 && selectedTargets.length < group.objects.length;
          const colorValue = group.colorProp
            ? resolvePickerColor(commonComponentProp(targetObjects, group.colorProp, '#000000'))
            : null;
          const edgeColorValue = group.edgeColorProp
            ? resolvePickerColor(commonComponentProp(targetObjects, group.edgeColorProp, '#000000'))
            : null;
          const linewidth = commonComponentProp(targetObjects, 'linewidth', undefined) as number | undefined;
          const markerSize = commonComponentProp(targetObjects, 'markersize', undefined) as number | undefined;
          const legendMarkerScale = commonComponentProp(targetObjects, 'markerscale', undefined) as number | undefined;
          const legendMarkerYOffset = commonComponentProp(targetObjects, 'marker_yoffset', undefined) as number | undefined;
          const legendHandleTextPad = commonComponentProp(targetObjects, 'handletextpad', undefined) as number | undefined;
          const legendLabelSpacing = commonComponentProp(targetObjects, 'labelspacing', undefined) as number | undefined;
          const pointSize = commonComponentProp(targetObjects, 'size', undefined) as number | undefined;
          const errorbarLineWidth = commonComponentProp(targetObjects, 'elinewidth', undefined) as number | undefined;
          const errorbarCapSize = commonComponentProp(targetObjects, 'capsize', undefined) as number | undefined;
          const errorbarCapThickness = commonComponentProp(targetObjects, 'capthick', undefined) as number | undefined;
          const stemLineWidth = commonComponentProp(targetObjects, 'stem_linewidth', undefined) as number | undefined;
          const stemMarkerColor = resolvePickerColor(commonComponentProp(targetObjects, 'marker_color', '#000000'));
          const stemBaselineColor = resolvePickerColor(commonComponentProp(targetObjects, 'baseline_color', '#000000'));
          const stemBaselineLineWidth = commonComponentProp(targetObjects, 'baseline_linewidth', undefined) as number | undefined;
          const stemBaselineVisible = Boolean(commonComponentProp(targetObjects, 'baseline_visible', true));
          const boxColor = resolvePickerColor(commonComponentProp(targetObjects, 'box_color', '#000000'));
          const medianColor = resolvePickerColor(commonComponentProp(targetObjects, 'median_color', '#000000'));
          const alpha = commonComponentProp(targetObjects, 'alpha', 1) as number | undefined;
          const visible = targetObjects.every(obj => obj.currentProps.visible !== false);
          const previewObjects = group.objects.slice(0, 8);
          const targetKey = targetObjects.map(obj => obj.id).join('|');
          const linewidthLabel = group.id === 'frames'
            ? '边框线宽'
            : group.id === 'grids'
              ? '网格线宽'
              : '线宽';
          const axisOffsetTargets = selectedTargets.length > 0 ? targetObjects : group.objects;
          const xAxisOffsetTargets = axisOffsetTargets.filter(obj => obj.kind === 'axis_x');
          const yAxisOffsetTargets = axisOffsetTargets.filter(obj => obj.kind === 'axis_y');
          return (
            <div
              key={group.id}
              data-component-group-id={group.id}
              data-component-group-label={group.label}
              className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{group.label}</div>
                  <div className="text-[11px] text-slate-400 leading-relaxed">{group.description}</div>
                  <div className="mt-1 text-[10px] text-slate-400">
                    对象 {group.objects.length} 个
                    {selectedTargets.length > 0 && (
                      <span className="ml-1 text-blue-600">· 当前只编辑选中 {selectedTargets.length} 个</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const gids = group.objects.map(obj => obj.id);
                    onSelectGids?.(gids);
                  }}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-700 whitespace-nowrap"
                >
                  选中整组
                </button>
              </div>

              <div className="rounded-md border border-slate-100 bg-white/75 p-2">
                <div className="mb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">包含对象</div>
                <div className="space-y-1">
                  {previewObjects.map(obj => (
                    <button
                      type="button"
                      key={obj.id}
                      onClick={() => {
                        onSelectGids?.([obj.id]);
                        onSelectObject(obj.id);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                        selectedGids.includes(obj.id) || selectedObject === obj.id
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                      title={obj.id}
                    >
                      <span className="truncate">{getReadableObjectLabel(obj)}</span>
                      <span className="shrink-0 text-slate-400">{getObjectTypeLabel(obj.kind)}</span>
                    </button>
                  ))}
                  {group.objects.length > previewObjects.length && (
                    <button
                      type="button"
                      onClick={() => {
                        const gids = group.objects.map(obj => obj.id);
                        onSelectGids?.(gids);
                      }}
                      className="w-full rounded px-2 py-1 text-left text-[11px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      查看/选中其余 {group.objects.length - previewObjects.length} 个对象
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-3 border-t border-slate-100 pt-3">
                {isSubsetEditing && (
                  <div className="rounded-md border border-blue-100 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700">
                    当前控件只作用于本分类中已选中的 {selectedTargets.length} 个对象；点击“选中整组”才会修改整组。
                  </div>
                )}
                {!isSubsetEditing && group.id === 'frames' && (
                  <div className="rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">
                    当前将统一修改 {targetObjects.length} 个子图边框组；不会改变数据点、拟合线或网格线。
                  </div>
                )}
                {group.colorProp && colorValue && (
                  renderColorInput(['points', 'patches', 'bars', 'violins'].includes(group.id) ? '填充色' : '颜色', colorValue, (value) => {
                    if (group.id === 'points') {
                      patchPointFillColor(targetObjects, value);
                      return;
                    }
                    patchComponentGroup(targetObjects, group.colorProp!, value);
                  }, `component:${group.id}:${targetKey}:color`)
                )}
                {group.edgeColorProp && edgeColorValue && (
                  renderColorInput('边框色', edgeColorValue, (value) => patchComponentGroup(targetObjects, group.edgeColorProp!, value), `component:${group.id}:${targetKey}:edgecolor`)
                )}
                {group.id === 'boxplots' && targetObjects.some(obj => supportsBatchProp(obj, 'box_color')) && (
                  renderColorInput('箱体颜色', boxColor, (value) => patchComponentGroup(targetObjects, 'box_color', value), `component:${group.id}:${targetKey}:box_color`)
                )}
                {group.id === 'boxplots' && targetObjects.some(obj => supportsBatchProp(obj, 'median_color')) && (
                  renderColorInput('中位线颜色', medianColor, (value) => patchComponentGroup(targetObjects, 'median_color', value), `component:${group.id}:${targetKey}:median_color`)
                )}
                {group.id === 'errorbars' && targetObjects.some(obj => supportsBatchProp(obj, 'elinewidth')) && (
                  renderNumberInput(`component-${group.id}`, 'elinewidth', errorbarLineWidth, (value) => patchComponentGroup(targetObjects, 'elinewidth', value), { min: 0, max: 20, step: 0.25, displayLabel: '误差线宽' })
                )}
                {group.id === 'errorbars' && targetObjects.some(obj => supportsBatchProp(obj, 'capsize')) && (
                  renderNumberInput(`component-${group.id}`, 'capsize', errorbarCapSize, (value) => patchComponentGroup(targetObjects, 'capsize', value), { min: 0, max: 30, step: 0.5, displayLabel: '端帽长度' })
                )}
                {group.id === 'errorbars' && targetObjects.some(obj => supportsBatchProp(obj, 'capthick')) && (
                  renderNumberInput(`component-${group.id}`, 'capthick', errorbarCapThickness, (value) => patchComponentGroup(targetObjects, 'capthick', value), { min: 0, max: 10, step: 0.1, displayLabel: '端帽线宽' })
                )}
                {group.id === 'stems' && targetObjects.some(obj => supportsBatchProp(obj, 'stem_linewidth')) && (
                  renderNumberInput(`component-${group.id}`, 'stem_linewidth', stemLineWidth, (value) => patchComponentGroup(targetObjects, 'stem_linewidth', value), { min: 0, max: 20, step: 0.25, displayLabel: '茎线宽度' })
                )}
                {group.id === 'stems' && targetObjects.some(obj => supportsBatchProp(obj, 'marker_color')) && (
                  renderColorInput('标记颜色', stemMarkerColor, (value) => patchComponentGroup(targetObjects, 'marker_color', value), `component:${group.id}:${targetKey}:marker_color`)
                )}
                {group.id === 'stems' && targetObjects.some(obj => supportsBatchProp(obj, 'baseline_color')) && (
                  renderColorInput('基线颜色', stemBaselineColor, (value) => patchComponentGroup(targetObjects, 'baseline_color', value), `component:${group.id}:${targetKey}:baseline_color`)
                )}
                {group.id === 'stems' && targetObjects.some(obj => supportsBatchProp(obj, 'baseline_linewidth')) && (
                  renderNumberInput(`component-${group.id}`, 'baseline_linewidth', stemBaselineLineWidth, (value) => patchComponentGroup(targetObjects, 'baseline_linewidth', value), { min: 0, max: 20, step: 0.25, displayLabel: '基线宽度' })
                )}
                {group.id === 'stems' && targetObjects.some(obj => supportsBatchProp(obj, 'baseline_visible')) && (
                  renderBoolInput('显示基线', stemBaselineVisible, (value) => patchComponentGroup(targetObjects, 'baseline_visible', value))
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'fontsize')) && (
                  renderNumberInput(`component-${group.id}`, 'fontsize', commonComponentProp(targetObjects, 'fontsize', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'fontsize', value), { min: 4, max: 48, step: 0.5 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'linewidth')) && (
                  renderNumberInput(`component-${group.id}`, 'linewidth', linewidth, (value) => patchComponentGroup(targetObjects, 'linewidth', value), { min: 0, max: 20, step: 0.25, displayLabel: linewidthLabel })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'markersize')) && (
                  renderNumberInput(`component-${group.id}`, 'markersize', markerSize, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'line' || obj.kind === 'stem_container'), 'markersize', value), { min: 1, max: 60, step: 0.5 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'markerscale')) && (
                  renderNumberInput(`component-${group.id}`, 'markerscale', legendMarkerScale, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'legend'), 'markerscale', value), { min: 0.1, max: 5, step: 0.1, displayLabel: '图例符号缩放' })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'marker_yoffset')) && (
                  renderNumberInput(`component-${group.id}`, 'marker_yoffset', legendMarkerYOffset, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'legend'), 'marker_yoffset', value), { min: -20, max: 20, step: 0.25, displayLabel: '图例符号垂直偏移' })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'handletextpad')) && (
                  renderNumberInput(`component-${group.id}`, 'handletextpad', legendHandleTextPad, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'legend'), 'handletextpad', value), { min: 0, max: 5, step: 0.1, displayLabel: '符号文字间距' })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'labelspacing')) && (
                  renderNumberInput(`component-${group.id}`, 'labelspacing', legendLabelSpacing, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'legend'), 'labelspacing', value), { min: 0, max: 5, step: 0.1, displayLabel: '图例行距' })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'size')) && (
                  renderNumberInput(`component-${group.id}`, 'size', pointSize, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'collection'), 'size', value), { min: 1, max: 2000, step: 1 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'fontweight')) && (
                  renderSelectInput('字重', commonComponentProp(targetObjects, 'fontweight', 'normal') as string, ['normal', 'bold', 'semibold', 'light'], (value) => patchComponentGroup(targetObjects, 'fontweight', value))
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'fontstyle')) && (
                  renderSelectInput('字形', commonComponentProp(targetObjects, 'fontstyle', 'normal') as string, ['normal', 'italic', 'oblique'], (value) => patchComponentGroup(targetObjects, 'fontstyle', value))
                )}
                {targetObjects.some(obj => obj.kind === 'subplot' && supportsBatchProp(obj, 'width')) && (
                  <div className="space-y-2 rounded-md border border-slate-100 bg-white/80 p-2">
                    <div className="text-[11px] font-semibold text-slate-500">真实绘图区 / 坐标轴框</div>
                    <div className="text-[11px] leading-relaxed text-slate-400">批量统一多个子图坐标轴框的位置和宽高，不改变整张白色画布。</div>
                    {renderNumberInput(`component-${group.id}`, 'left', commonComponentProp(targetObjects, 'left', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'left', value), { min: 0, max: 1, step: 0.01, displayLabel: '绘图区左边距' })}
                    {renderNumberInput(`component-${group.id}`, 'bottom', commonComponentProp(targetObjects, 'bottom', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'bottom', value), { min: 0, max: 1, step: 0.01, displayLabel: '绘图区下边距' })}
                    {renderNumberInput(`component-${group.id}`, 'width', commonComponentProp(targetObjects, 'width', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'width', value), { min: 0.005, max: 1, step: 0.01, displayLabel: '绘图区宽度' })}
                    {renderNumberInput(`component-${group.id}`, 'height', commonComponentProp(targetObjects, 'height', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'height', value), { min: 0.005, max: 1, step: 0.01, displayLabel: '绘图区高度' })}
                    {renderSelectInput('比例', commonComponentProp(targetObjects, 'aspect', 'auto') as string, ['auto', 'equal', '1'], (value) => patchComponentGroup(targetObjects, 'aspect', value))}
                  </div>
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'linestyle')) && (
                  renderSelectInput('线型', commonComponentProp(targetObjects, 'linestyle', '-') as string, ['-', '--', '-.', ':'], (value) => patchComponentGroup(targetObjects, 'linestyle', value))
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'tick_direction')) && (
                  renderSelectInput('刻度方向', commonComponentProp(targetObjects, 'tick_direction', 'out') as string, ['out', 'in', 'inout'], (value) => patchComponentGroup(targetObjects, 'tick_direction', value))
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'tick_length')) && (
                  renderNumberInput(`component-${group.id}`, 'tick_length', commonComponentProp(targetObjects, 'tick_length', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'tick_length', value), { min: 0, max: 20, step: 0.5 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'tick_width')) && (
                  renderNumberInput(`component-${group.id}`, 'tick_width', commonComponentProp(targetObjects, 'tick_width', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'tick_width', value), { min: 0, max: 10, step: 0.1 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'tick_color')) && (
                  renderColorInput('刻度线颜色', commonComponentProp(targetObjects, 'tick_color', '#000000') as string, (value) => patchComponentGroup(targetObjects, 'tick_color', value), `component:${group.id}:${targetKey}:tick_color`)
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'show_minor_ticks')) && (
                  renderBoolInput('显示副刻度', Boolean(commonComponentProp(targetObjects, 'show_minor_ticks', false)), (value) => patchComponentGroup(targetObjects, 'show_minor_ticks', value))
                )}
                {group.id === 'axes' && (xAxisOffsetTargets.length > 0 || yAxisOffsetTargets.length > 0) && (
                  <div className="space-y-3 rounded-md border border-sky-100 bg-sky-50/60 p-2">
                    <div>
                      <div className="text-[11px] font-semibold text-sky-900">刻度文字旋转 / 整体平移</div>
                      <div className="mt-0.5 text-[10px] leading-relaxed text-sky-700">
                        直接作用于轴系统对象，不需要逐个选中 `xtick.*` 或 `ytick.*`。旋转单位为度；正数水平向右，正数垂直向上。
                      </div>
                    </div>
                    {xAxisOffsetTargets.length > 0 && (
                      <div className="space-y-2 rounded-md border border-white/80 bg-white/75 p-2">
                        <div className="text-[10px] font-bold text-slate-500">X 轴刻度文字 · {xAxisOffsetTargets.length} 组</div>
                        {renderNumberInput(`component-${group.id}-x-rotation`, 'tick_rotation', commonComponentProp(xAxisOffsetTargets, 'tick_rotation', undefined) as number | undefined, (value) => patchComponentGroup(xAxisOffsetTargets, 'tick_rotation', value), { min: -180, max: 180, step: 1, displayLabel: '旋转角度(°)' })}
                        {renderNumberInput(`component-${group.id}-x-offset`, 'tick_label_dx', commonComponentProp(xAxisOffsetTargets, 'tick_label_dx', undefined) as number | undefined, (value) => patchComponentGroup(xAxisOffsetTargets, 'tick_label_dx', value), { min: -80, max: 80, step: 0.5, displayLabel: '水平偏移(pt)' })}
                        {renderNumberInput(`component-${group.id}-x-offset`, 'tick_label_dy', commonComponentProp(xAxisOffsetTargets, 'tick_label_dy', undefined) as number | undefined, (value) => patchComponentGroup(xAxisOffsetTargets, 'tick_label_dy', value), { min: -80, max: 80, step: 0.5, displayLabel: '垂直偏移(pt)' })}
                      </div>
                    )}
                    {yAxisOffsetTargets.length > 0 && (
                      <div className="space-y-2 rounded-md border border-white/80 bg-white/75 p-2">
                        <div className="text-[10px] font-bold text-slate-500">Y 轴刻度文字 · {yAxisOffsetTargets.length} 组</div>
                        {renderNumberInput(`component-${group.id}-y-rotation`, 'tick_rotation', commonComponentProp(yAxisOffsetTargets, 'tick_rotation', undefined) as number | undefined, (value) => patchComponentGroup(yAxisOffsetTargets, 'tick_rotation', value), { min: -180, max: 180, step: 1, displayLabel: '旋转角度(°)' })}
                        {renderNumberInput(`component-${group.id}-y-offset`, 'tick_label_dx', commonComponentProp(yAxisOffsetTargets, 'tick_label_dx', undefined) as number | undefined, (value) => patchComponentGroup(yAxisOffsetTargets, 'tick_label_dx', value), { min: -80, max: 80, step: 0.5, displayLabel: '水平偏移(pt)' })}
                        {renderNumberInput(`component-${group.id}-y-offset`, 'tick_label_dy', commonComponentProp(yAxisOffsetTargets, 'tick_label_dy', undefined) as number | undefined, (value) => patchComponentGroup(yAxisOffsetTargets, 'tick_label_dy', value), { min: -80, max: 80, step: 0.5, displayLabel: '垂直偏移(pt)' })}
                      </div>
                    )}
                  </div>
                )}
                {group.id === 'colorbars' && (
                  <div className="space-y-2 rounded-md border border-slate-100 bg-white/80 p-2">
                    <div className="text-[11px] font-semibold text-slate-500">色条位置与尺寸</div>
                    {renderNumberInput(`component-${group.id}`, 'left', commonComponentProp(targetObjects, 'left', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'left', value), { min: 0, max: 1, step: 0.01 })}
                    {renderNumberInput(`component-${group.id}`, 'bottom', commonComponentProp(targetObjects, 'bottom', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'bottom', value), { min: 0, max: 1, step: 0.01 })}
                    {renderNumberInput(`component-${group.id}`, 'width', commonComponentProp(targetObjects, 'width', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'width', value), { min: 0.005, max: 1, step: 0.01 })}
                    {renderNumberInput(`component-${group.id}`, 'height', commonComponentProp(targetObjects, 'height', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'height', value), { min: 0.005, max: 1, step: 0.01 })}
                    {renderNumberInput(`component-${group.id}`, 'tick_fontsize', commonComponentProp(targetObjects, 'tick_fontsize', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'tick_fontsize', value), { min: 4, max: 48, step: 0.5 })}
                  </div>
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'alpha')) && (
                  <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm">
                    <span className="text-xs text-slate-500 font-medium">透明度</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={typeof alpha === 'number' ? alpha : 1}
                      className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                      onChange={(event) => patchComponentGroup(targetObjects, 'alpha', Number(event.target.value))}
                    />
                  </div>
                )}
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">{selectedTargets.length > 0 ? '显示选中对象' : '显示整组'}</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={visible}
                      onChange={(event) => patchComponentGroup(targetObjects, 'visible', event.target.checked)}
                    />
                    <div className="w-8 h-4 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderBatchPanel = () => {
    const batchObjects = objects.filter(o => selectedGids.includes(o.id));
    const commonColor = (() => {
      const colors = batchObjects.map(o => o.currentProps.color || o.currentProps.facecolor).filter(Boolean);
      return colors.length > 0 && colors.every(c => c === colors[0]) ? resolvePickerColor(colors[0]) : '#000000';
    })();
    const commonAlpha = (() => {
      const alphas = batchObjects.map(o => o.currentProps.alpha).filter(a => a !== undefined);
      return alphas.length > 0 && alphas.every(a => a === alphas[0]) ? alphas[0] : undefined;
    })();
    const fontObjects = batchObjects.filter(o =>
      supportsBatchProp(o, 'fontsize') ||
      supportsBatchProp(o, 'fontfamily') ||
      supportsBatchProp(o, 'fontweight') ||
      supportsBatchProp(o, 'fontstyle')
    );
    const commonFontSize = (() => {
      const sizes = fontObjects.map(o => o.currentProps.fontsize).filter(v => typeof v === 'number');
      return sizes.length > 0 && sizes.every(size => size === sizes[0]) ? sizes[0] as number : undefined;
    })();
    const commonFontFamily = (() => {
      const families = fontObjects.map(o => o.currentProps.fontfamily).filter(v => typeof v === 'string' && v);
      return families.length > 0 && families.every(family => family === families[0]) ? families[0] as string : 'Arial';
    })();

    const handleBatchPatch = (prop: string, value: unknown) => {
      const selectedObjects = selectedGids
        .map(gid => objects.find(o => o.id === gid))
        .filter(Boolean) as ManifestObject[];
      if (prop === 'fontsize' || prop === 'fontfamily' || prop === 'color') {
        const tickPatches = selectedObjects
          .map(obj => normalizeTickTextPatch(obj.id, prop))
          .filter(Boolean) as Array<{ gid: string; prop: string }>;
        if (tickPatches.length > 0) {
          const deduped = Array.from(
            new Map(tickPatches.map(patch => [`${patch.gid}:${patch.prop}`, patch])).values()
          );
          if (deduped.length === selectedObjects.length || selectedObjects.every(obj => Boolean(normalizeTickTextPatch(obj.id, prop)))) {
            void onPatch(deduped.map(patch => ({
              op: 'set' as const,
              mode: 'backend_patch' as const,
              gid: patch.gid,
              prop: patch.prop,
              value,
            })));
            return;
          }
        }
      }
      const allXTicks = selectedObjects.length > 0 && selectedObjects.every(obj => obj.id.startsWith('xtick.'));
      const allYTicks = selectedObjects.length > 0 && selectedObjects.every(obj => obj.id.startsWith('ytick.'));
      const hasAxisTick = selectedObjects.some(obj => obj.id.startsWith('xtick.') || obj.id.startsWith('ytick.'));
      if ((allXTicks || allYTicks) && (prop === 'fontsize' || prop === 'fontfamily' || prop === 'color')) {
        const regex = allXTicks ? /^xtick\.(\d+)\./ : /^ytick\.(\d+)\./;
        const axisPrefix = allXTicks ? 'axis.x.' : 'axis.y.';
        const axisProp = prop === 'fontsize'
          ? 'tick_labelsize'
          : prop === 'fontfamily'
            ? 'tick_labelfamily'
            : 'tick_labelcolor';
        const axisIndexes = Array.from(new Set(selectedObjects.map(obj => obj.id.match(regex)?.[1]).filter(Boolean))) as string[];
        const patches = axisIndexes.map(index => ({
          op: 'set' as const,
          mode: 'backend_patch' as const,
          gid: `${axisPrefix}${index}`,
          prop: axisProp,
          value,
        }));
        if (patches.length > 0) void onPatch(patches);
        return;
      }
      // Mixed selection: route tick objects to axis, patch non-tick objects below
      if (hasAxisTick && (prop === 'fontsize' || prop === 'fontfamily' || prop === 'color')) {
        const xTickRegex = /^xtick\.(\d+)\./;
        const yTickRegex = /^ytick\.(\d+)\./;
        const axisProp = prop === 'fontsize' ? 'tick_labelsize' : prop === 'fontfamily' ? 'tick_labelfamily' : 'tick_labelcolor';
        const xIndexes = Array.from(new Set(
          selectedObjects.filter(o => o.id.startsWith('xtick.')).map(o => o.id.match(xTickRegex)?.[1]).filter(Boolean)
        )) as string[];
        const yIndexes = Array.from(new Set(
          selectedObjects.filter(o => o.id.startsWith('ytick.')).map(o => o.id.match(yTickRegex)?.[1]).filter(Boolean)
        )) as string[];
        const axisPatches = [
          ...xIndexes.map(i => ({ op: 'set' as const, mode: 'backend_patch' as const, gid: `axis.x.${i}`, prop: axisProp, value })),
          ...yIndexes.map(i => ({ op: 'set' as const, mode: 'backend_patch' as const, gid: `axis.y.${i}`, prop: axisProp, value })),
        ];
        if (axisPatches.length > 0) void onPatch(axisPatches);
        // fall through: non-tick objects handled by the loop below
      }

      const patches: PatchEntry[] = selectedGids.map(gid => {
        const obj = objects.find(o => o.id === gid);
        // Skip tick objects that were already routed to axis.x/axis.y above
        if (hasAxisTick && (prop === 'fontsize' || prop === 'fontfamily' || prop === 'color')
          && (gid.startsWith('xtick.') || gid.startsWith('ytick.'))) return null;
        if (!supportsBatchProp(obj, prop)) return null;
        let actualProp = prop;
        if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
          actualProp = 'facecolor';
        }
        if (actualProp !== prop && !supportsBatchProp(obj, actualProp)) return null;
        return {
          op: 'set' as const,
          mode: manifest.generatedBy === 'r_svg' || !LOCAL_PROPS.has(actualProp) ? 'backend_patch' as const : 'local_patch' as const,
          gid,
          prop: actualProp,
          value
        };
      }).filter(Boolean) as PatchEntry[];
      if (patches.length > 0) void onPatch(patches);
    };

    return (
      <div className="mb-6 p-4 border border-indigo-200 rounded-lg bg-indigo-50/30 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
            批量编辑已选图元 ({selectedGids.length} 个)
          </h3>
          <button
            type="button"
            onClick={() => onSelectGids?.([])}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            取消选择
          </button>
        </div>
        <div className="space-y-3 pt-2 border-t border-indigo-100">
          {fontObjects.length > 0 && (
            <div className="rounded-md border border-indigo-100 bg-white/70 p-3 space-y-3">
              <div className="text-[11px] font-semibold text-indigo-900">字体批量编辑（文本/标签 {fontObjects.length} 个）</div>
              {renderNumberInput('batch', 'fontsize', commonFontSize, (v) => handleBatchPatch('fontsize', v), { min: 4, max: 48, step: 0.5 })}
              {/* key based on selected gids forces select to remount on selection change, so onChange always fires */}
              <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm" key={`batch-ff-${selectedGids.join('|')}`}>
                <span className="text-slate-600">字体家族</span>
                <select
                  className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white appearance-none text-slate-700 text-xs"
                  defaultValue={FONT_OPTIONS.includes(commonFontFamily) ? commonFontFamily : '__mixed__'}
                  onChange={(e) => {
                    if (e.target.value && e.target.value !== '__mixed__') {
                      handleBatchPatch('fontfamily', e.target.value);
                    }
                  }}
                >
                  {!FONT_OPTIONS.includes(commonFontFamily) && <option value="__mixed__" disabled>（多种字体）</option>}
                  {FONT_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              {renderSelectInput('字重', String(commonProp(fontObjects, 'fontweight', 'normal')), ['normal', 'bold', 'semibold', 'light'], (v) => handleBatchPatch('fontweight', v))}
              {renderSelectInput('字形', String(commonProp(fontObjects, 'fontstyle', 'normal')), ['normal', 'italic', 'oblique'], (v) => handleBatchPatch('fontstyle', v))}
            </div>
          )}
          {renderColorInput('颜色', commonColor, (v) => handleBatchPatch('color', v), `batch:${selectedGids.join('|')}:color`)}
          {/* Bug 3: edgecolor picker for multi-selected patch/collection objects */}
          {batchObjects.some(o => supportsBatchProp(o, 'edgecolor')) && (
            renderColorInput(
              '边框色',
              (() => {
                const edgeColors = batchObjects
                  .filter(o => supportsBatchProp(o, 'edgecolor'))
                  .map(o => o.currentProps.edgecolor as string)
                  .filter(Boolean);
                return edgeColors.length > 0 && edgeColors.every(c => c === edgeColors[0])
                  ? resolvePickerColor(edgeColors[0])
                  : '#000000';
              })(),
              (v) => handleBatchPatch('edgecolor', v),
              `batch:${selectedGids.join('|')}:edgecolor`
            )
          )}
          <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
            <span className="text-slate-600 font-medium">不透明度</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              defaultValue={commonAlpha ?? 1}
              className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer"
              onChange={(e) => handleBatchPatch('alpha', Number(e.target.value))}
            />
          </div>
          <div className="grid grid-cols-[80px_1fr] items-center gap-3 text-xs">
            <span className="text-slate-600 font-medium">线宽</span>
            <input
              type="number"
              step="0.5"
              min="0"
              className="border border-slate-200 rounded p-1 w-full bg-white text-slate-700"
              placeholder="批量设置线宽..."
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!isNaN(v)) handleBatchPatch('linewidth', v);
              }}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600 font-medium">显示</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleBatchPatch('visible', true)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 text-[11px] font-medium"
              >
                全部显示
              </button>
              <button
                type="button"
                onClick={() => handleBatchPatch('visible', false)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 text-[11px] font-medium"
              >
                全部隐藏
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const getFontRole = (obj: StandardFigureObject): { id: string; label: string; presetKey: 'title' | 'label' | 'tick' | 'legend' } | null => {
    if (obj.role) {
      if (obj.role === 'figure_title' || obj.role === 'axes_title') {
        return { id: 'titles', label: '标题 / 图内主文本', presetKey: 'title' };
      }
      if (obj.role === 'x_axis_label') {
        return { id: 'xlabels', label: 'X 轴标签', presetKey: 'label' };
      }
      if (obj.role === 'y_axis_label') {
        return { id: 'ylabels', label: 'Y 轴标签', presetKey: 'label' };
      }
      if (obj.role === 'x_tick_label' || obj.role === 'x_axis') {
        return { id: 'xticks', label: 'X 轴刻度文字', presetKey: 'tick' };
      }
      if (obj.role === 'y_tick_label' || obj.role === 'y_axis') {
        return { id: 'yticks', label: 'Y 轴刻度文字', presetKey: 'tick' };
      }
      if (obj.role === 'legend_text' || obj.role === 'legend') {
        return { id: 'legend_text', label: '图例文字', presetKey: 'legend' };
      }
      if (obj.role === 'annotation' || obj.role === 'annotation_text' || obj.role === 'ggplot_text_annotation' || obj.role === 'text') {
        return { id: 'other_text', label: '其它文本标注', presetKey: 'label' };
      }
    }

    if (obj.kind === 'axis_x') {
      return { id: 'xticks', label: 'X 轴刻度文字', presetKey: 'tick' };
    }
    if (obj.kind === 'axis_y') {
      return { id: 'yticks', label: 'Y 轴刻度文字', presetKey: 'tick' };
    }
    if (obj.kind !== 'text' && obj.kind !== 'legend') return null;
    if (obj.id.startsWith('title.') || obj.id.startsWith('fig_text.')) {
      return { id: 'titles', label: '标题 / 图内主文本', presetKey: 'title' };
    }
    if (obj.id.startsWith('xlabel.')) {
      return { id: 'xlabels', label: 'X 轴标签', presetKey: 'label' };
    }
    if (obj.id.startsWith('ylabel.')) {
      return { id: 'ylabels', label: 'Y 轴标签', presetKey: 'label' };
    }
    if (obj.id.startsWith('xtick.')) {
      return { id: 'xticks', label: 'X 轴刻度文字', presetKey: 'tick' };
    }
    if (obj.id.startsWith('ytick.')) {
      return { id: 'yticks', label: 'Y 轴刻度文字', presetKey: 'tick' };
    }
    if (obj.id.startsWith('legend_text.') || obj.id.startsWith('legend_title.') || obj.kind === 'legend') {
      return { id: 'legend_text', label: '图例文字', presetKey: 'legend' };
    }
    if (obj.kind === 'text') {
      return { id: 'other_text', label: '其它文本标注', presetKey: 'label' };
    }
    return null;
  };

  const getFontGroups = () => {
    const groups = new Map<string, { id: string; label: string; presetKey: 'title' | 'label' | 'tick' | 'legend'; objects: ManifestObject[] }>();
    const scopedFontObjects = objects.filter(obj => {
      if (fontSubplotScope === 'all') return true;
      return getObjectSubplotId(obj) === fontSubplotScope;
    });
    const hasAxisX = scopedFontObjects.some(obj => obj.kind === 'axis_x');
    const hasAxisY = scopedFontObjects.some(obj => obj.kind === 'axis_y');
    scopedFontObjects.forEach((obj) => {
      // Tick Text artists are regenerated by matplotlib. Prefer the stable
      // virtual Axis objects so font edits survive backend rerenders.
      if (hasAxisX && obj.id.startsWith('xtick.')) return;
      if (hasAxisY && obj.id.startsWith('ytick.')) return;
      const role = getFontRole(obj);
      if (!role) return;
      const current = groups.get(role.id) || { ...role, objects: [] };
      current.objects.push(obj);
      groups.set(role.id, current);
    });
    return Array.from(groups.values()).filter(group => group.objects.length > 0);
  };

  const commonProp = (items: ManifestObject[], prop: string, fallback: unknown) => {
    const values = items.map(item => item.currentProps[prop]).filter(value => value !== undefined && value !== null && value !== '');
    return values.length > 0 && values.every(value => value === values[0]) ? values[0] : fallback;
  };

  type FontGroupPatchProp = 'fontsize' | 'fontfamily' | 'color' | 'fontweight' | 'fontstyle';

  const fontGroupProp = (roleId: string, prop: FontGroupPatchProp) => {
    if (roleId === 'xticks' || roleId === 'yticks') {
      if (prop === 'fontsize') return 'tick_labelsize';
      if (prop === 'fontfamily') return 'tick_labelfamily';
      if (prop === 'color') return 'tick_labelcolor';
      if (prop === 'fontweight') return 'tick_fontweight';
      if (prop === 'fontstyle') return 'tick_fontstyle';
    }
    return prop;
  };

  const commonFontGroupProp = (
    roleId: string,
    items: ManifestObject[],
    prop: FontGroupPatchProp,
    fallback: unknown,
  ) => commonProp(items, fontGroupProp(roleId, prop), fallback);

  const buildFontGroupPatches = (
    roleId: string,
    items: ManifestObject[],
    prop: FontGroupPatchProp,
    value: unknown,
  ): PatchEntry[] => {
    const roleMap: Record<string, SemanticTargetRole> = {
      titles: 'title',
      xlabels: 'x_axis_label',
      ylabels: 'y_axis_label',
      xticks: 'x_tick_label',
      yticks: 'y_tick_label',
      legend_text: 'legend_text',
    };
    const targetRole = roleMap[roleId];
    const patches = compileFontIntentPatches({
      intent: roleId === 'xticks' || roleId === 'yticks'
        ? 'style.text.tick_label'
        : roleId === 'legend_text'
          ? 'style.text.legend'
          : roleId === 'titles'
            ? 'style.text.title'
            : 'style.text.axis_label',
      scope: {
        selectionMode: 'role_in_figure',
        objectIds: items.map(obj => obj.id),
        ...(targetRole ? { targetRole } : {}),
      },
      operation: { prop, value },
      commit: { mode: 'draft', applyAsOneHistoryStep: true },
      fallback: { onUnsupported: 'skip_with_warning' },
    });

    // Preserve the previous durable-render behavior for text styling except
    // color, while the intent compiler owns target selection and prop mapping.
    const durablePatches = patches.map(patch => (
      'type' in patch
        ? patch
        : { ...patch, mode: prop === 'color' ? patch.mode : 'backend_patch' as const }
    ));
    if (roleId === 'legend_text' && prop === 'fontsize') {
      durablePatches.push(...buildLegendMarkerScalePatches(items, value));
    }
    return durablePatches;
  };

  const handleFontGroupPatch = (roleId: string, items: ManifestObject[], prop: FontGroupPatchProp, value: unknown) => {
    const patches = buildFontGroupPatches(roleId, items, prop, value);
    if (patches.length > 0) void onPatch(patches);
  };

  const renderFontCenterPanel = () => {
    const fontGroups = getFontGroups();

    if (fontGroups.length === 0) {
      return (
        <div className="text-sm text-slate-500 py-8 text-center">
          当前图中没有可识别的文本或标签对象。
          <p className="text-xs text-slate-400 mt-2">渲染后会自动识别标题、坐标轴标签、刻度文字和图例文字。</p>
        </div>
      );
    }

    const applyFontPreset = (name: string) => {
      const preset = fontPresetMap[name];
      if (!preset) return;
      const patches: PatchEntry[] = [];
      fontGroups.forEach(group => {
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontfamily', preset.family));
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontsize', preset[group.presetKey]));
      });
      if (patches.length > 0) void onPatch(patches);
    };

    const saveFontPreset = () => {
      const name = window.prompt('输入字体预设名称');
      if (!name) return;
      const titleGroup = fontGroups.find(group => group.presetKey === 'title');
      const labelGroup = fontGroups.find(group => group.presetKey === 'label');
      const tickGroup = fontGroups.find(group => group.presetKey === 'tick');
      const legendGroup = fontGroups.find(group => group.presetKey === 'legend');
      const firstTextGroup = fontGroups[0];
      const nextPreset = {
        family: String(commonFontGroupProp(firstTextGroup.id, firstTextGroup.objects, 'fontfamily', 'Arial')),
        title: Number(commonFontGroupProp(titleGroup?.id || firstTextGroup.id, titleGroup?.objects || firstTextGroup.objects, 'fontsize', 14)),
        label: Number(commonFontGroupProp(labelGroup?.id || firstTextGroup.id, labelGroup?.objects || firstTextGroup.objects, 'fontsize', 11)),
        tick: Number(commonFontGroupProp(tickGroup?.id || firstTextGroup.id, tickGroup?.objects || firstTextGroup.objects, 'fontsize', 9)),
        legend: Number(commonFontGroupProp(legendGroup?.id || firstTextGroup.id, legendGroup?.objects || firstTextGroup.objects, 'fontsize', 9)),
      };
      const next = { ...customFontPresets, [name]: nextPreset };
      setCustomFontPresets(next);
      window.localStorage.setItem(FONT_PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    const deleteFontPreset = (name: string) => {
      if (!window.confirm(`确定删除字体预设"${name}"？`)) return;
      const next = { ...customFontPresets };
      delete next[name];
      setCustomFontPresets(next);
      window.localStorage.setItem(FONT_PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    const axisObjects = objects.filter(obj => obj.kind === 'axis_x' || obj.kind === 'axis_y') as ManifestObject[];
    const spineObjects = objects.filter(obj => obj.kind === 'spine_group' || obj.kind === 'spine') as ManifestObject[];
    const firstAxis = axisObjects[0];
    const firstSpine = spineObjects[0];

    const buildStylePresetPatches = (preset: FigureStylePreset): PatchEntry[] => {
      const patches: PatchEntry[] = [];
      fontGroups.forEach(group => {
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontfamily', preset.family));
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontsize', preset[group.presetKey]));
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontweight', preset.fontWeight));
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'fontstyle', preset.fontStyle));
        patches.push(...buildFontGroupPatches(group.id, group.objects, 'color', preset.textColor));
      });
      axisObjects.forEach(axis => {
        patches.push(
          { op: 'set', mode: 'backend_patch', gid: axis.id, prop: 'tick_direction', value: preset.tickDirection },
          { op: 'set', mode: 'backend_patch', gid: axis.id, prop: 'tick_length', value: preset.tickLength },
          { op: 'set', mode: 'backend_patch', gid: axis.id, prop: 'tick_width', value: preset.tickWidth },
          { op: 'set', mode: 'backend_patch', gid: axis.id, prop: 'tick_color', value: preset.tickColor },
        );
      });
      spineObjects.forEach(spine => {
        patches.push(
          { op: 'set', mode: 'backend_patch', gid: spine.id, prop: 'linewidth', value: preset.spineWidth },
          { op: 'set', mode: 'backend_patch', gid: spine.id, prop: 'color', value: preset.spineColor },
        );
      });
      return patches;
    };

    const applyStylePreset = (name: string) => {
      const preset = stylePresetMap[name];
      if (!preset) return;
      const patches = buildStylePresetPatches(preset);
      if (patches.length > 0) void onPatch(patches);
    };

    const saveStylePreset = () => {
      const name = window.prompt('输入图形风格预设名称');
      if (!name) return;
      const titleGroup = fontGroups.find(group => group.presetKey === 'title');
      const labelGroup = fontGroups.find(group => group.presetKey === 'label');
      const tickGroup = fontGroups.find(group => group.presetKey === 'tick');
      const legendGroup = fontGroups.find(group => group.presetKey === 'legend');
      const firstTextGroup = fontGroups[0];
      const axisProps = (firstAxis?.currentProps || {}) as Record<string, any>;
      const spineProps = (firstSpine?.currentProps || {}) as Record<string, any>;
      const nextPreset: FigureStylePreset = {
        family: String(commonFontGroupProp(firstTextGroup.id, firstTextGroup.objects, 'fontfamily', 'Arial')),
        title: Number(commonFontGroupProp(titleGroup?.id || firstTextGroup.id, titleGroup?.objects || firstTextGroup.objects, 'fontsize', 14)),
        label: Number(commonFontGroupProp(labelGroup?.id || firstTextGroup.id, labelGroup?.objects || firstTextGroup.objects, 'fontsize', 11)),
        tick: Number(commonFontGroupProp(tickGroup?.id || firstTextGroup.id, tickGroup?.objects || firstTextGroup.objects, 'fontsize', 9)),
        legend: Number(commonFontGroupProp(legendGroup?.id || firstTextGroup.id, legendGroup?.objects || firstTextGroup.objects, 'fontsize', 9)),
        fontWeight: String(commonFontGroupProp(firstTextGroup.id, firstTextGroup.objects, 'fontweight', 'normal')),
        fontStyle: String(commonFontGroupProp(firstTextGroup.id, firstTextGroup.objects, 'fontstyle', 'normal')),
        textColor: resolvePickerColor(commonFontGroupProp(firstTextGroup.id, firstTextGroup.objects, 'color', '#000000')),
        tickDirection: String(axisProps.tick_direction || 'out'),
        tickLength: Number(axisProps.tick_length ?? 3.5),
        tickWidth: Number(axisProps.tick_width ?? 0.8),
        tickColor: resolvePickerColor(axisProps.tick_color || '#000000'),
        spineWidth: Number(spineProps.linewidth ?? 1),
        spineColor: resolvePickerColor(spineProps.color || '#000000'),
      };
      const next = { ...customStylePresets, [name]: nextPreset };
      setCustomStylePresets(next);
      window.localStorage.setItem(STYLE_PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    const deleteStylePreset = (name: string) => {
      if (!window.confirm(`确定删除图形风格预设"${name}"？`)) return;
      const next = { ...customStylePresets };
      delete next[name];
      setCustomStylePresets(next);
      window.localStorage.setItem(STYLE_PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    return (
      <div className="space-y-6">
        <div>
          {renderPanelTitle('字体中心')}
          <p className="text-xs text-slate-400 mb-4">按真实 matplotlib 文本对象自动分组，统一修改标题、轴标签、刻度和图例字体。</p>
          {allSubplotOptions.length > 0 && (
            <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 space-y-2 mb-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-blue-900">作用范围</div>
                  <div className="text-[11px] text-blue-700">选择某个子图后，下方字体控件只作用于该子图的标题、轴标签、刻度和图例文字。</div>
                </div>
                <select
                  className="border border-blue-200 rounded-md bg-white px-2 py-1 text-xs text-blue-900 outline-none"
                  value={fontSubplotScope}
                  onChange={(event) => setFontSubplotScope(event.target.value)}
                >
                  <option value="all">全部子图</option>
                  {allSubplotOptions.map(subplot => (
                    <option key={subplot.id} value={subplot.id}>
                      {String(subplot.currentProps.label || subplot.label || subplot.id)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="space-y-4">
            {fontGroups.map(group => {
              const family = String(commonFontGroupProp(group.id, group.objects, 'fontfamily', 'Arial'));
              const size = commonFontGroupProp(group.id, group.objects, 'fontsize', undefined) as number | undefined;
              const color = resolvePickerColor(commonFontGroupProp(group.id, group.objects, 'color', '#000000'));
              const weight = String(commonFontGroupProp(group.id, group.objects, 'fontweight', 'normal'));
              const style = String(commonFontGroupProp(group.id, group.objects, 'fontstyle', 'normal'));
              return (
                <div key={group.id} className="p-3 rounded-lg border border-slate-100 bg-slate-50/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{group.label}</div>
                      <div className="text-[10px] text-slate-400">对象 {group.objects.length} 个</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectGids?.(group.objects.map(obj => obj.id))}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                    >
                      选中整组
                    </button>
                  </div>
                  <div className="space-y-3 pt-2 border-t border-slate-100">
                    {renderNumberInput(`font-center-${group.id}`, 'fontsize', size, (v) => handleFontGroupPatch(group.id, group.objects, 'fontsize', v), { min: 4, max: 48, step: 0.5 })}
                    {renderFontSelect(`font-center-${group.id}`, 'fontfamily', family, (v) => handleFontGroupPatch(group.id, group.objects, 'fontfamily', v))}
                    {renderSelectInput('字重', weight, ['normal', 'bold', 'semibold', 'light'], (v) => handleFontGroupPatch(group.id, group.objects, 'fontweight', v))}
                    {renderSelectInput('字形', style, ['normal', 'italic', 'oblique'], (v) => handleFontGroupPatch(group.id, group.objects, 'fontstyle', v))}
                    {renderColorInput('文字颜色', color, (v) => handleFontGroupPatch(group.id, group.objects, 'color', v), `font-center:${group.id}:color`)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="pt-5 border-t border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">字体预设</h4>
            <button
              type="button"
              onClick={saveFontPreset}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
            >
              保存当前预设
            </button>
          </div>
          <div className="space-y-2">
            {Object.entries(fontPresetMap).map(([name, preset]) => {
              const isCustom = Object.hasOwn(customFontPresets, name);
              return (
                <div key={name} className="relative group">
                  <button
                    type="button"
                    onClick={() => applyFontPreset(name)}
                    className="w-full flex items-center justify-between rounded border border-slate-200 bg-white p-2 text-left hover:bg-slate-50 transition-colors"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-700">{name}</div>
                      <div className="text-[10px] text-slate-400">{preset.family} · 标题 {preset.title} / 标签 {preset.label} / 刻度 {preset.tick}</div>
                    </div>
                    <Baseline className="w-4 h-4 text-slate-400" />
                  </button>
                  {isCustom && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteFontPreset(name); }}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                      title="删除此预设"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="pt-5 border-t border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">图形风格预设</h4>
              <p className="text-[10px] text-slate-400 mt-0.5">保存字体、字号、字重、刻度线和边框偏好；应用后先进入暂存，不会立即多次重绘。</p>
            </div>
            <button
              type="button"
              onClick={saveStylePreset}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
            >
              保存当前风格
            </button>
          </div>
          <div className="space-y-2">
            {Object.entries(stylePresetMap).map(([name, preset]) => {
              const isCustom = Object.hasOwn(customStylePresets, name);
              return (
                <div key={name} className="relative group">
                  <button
                    type="button"
                    onClick={() => applyStylePreset(name)}
                    className="w-full rounded border border-slate-200 bg-white p-2 text-left hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-700">{name}</div>
                      <Sliders className="w-4 h-4 text-slate-400 shrink-0" />
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      {preset.family} · 标题 {preset.title} / 标签 {preset.label} / 刻度 {preset.tick} · 框线 {preset.spineWidth} · 刻度线 {preset.tickWidth}
                    </div>
                  </button>
                  {isCustom && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteStylePreset(name); }}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                      title="删除此预设"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderPalettePanel = () => {
    const palettes = proxiedPalettes;
    const bindings = debugModel?.bindings || [];
    const paletteGroups = palettes.map((palette: any) => {
      const binding = bindings.find((b: any) => b.paletteId === palette.id);
      const resolution = resolvePaletteTargets(
        manifest,
        palette.id,
        PALETTE_TARGET_RESOLVER_V2_ENABLED,
      );
      const gids = Array.from(new Set(resolution.targets.map(target => target.objectId)));
      const targetObjects = gids
        .map((gid: string) => objects.find(obj => obj.id === gid))
        .filter(Boolean) as any[];
      const selectedCount = gids.filter((gid: string) => selectedGids.includes(gid)).length;
      return {
        palette,
        binding,
        resolution,
        gids,
        targetObjects,
        selectedCount,
        isActive: selectedCount > 0,
      };
    });
    
    if (palettes.length === 0) {
      return (
        <div className="text-sm text-slate-500 py-8 text-center">
          未在脚本中检测到颜色常量或字典定义。
          <p className="text-xs text-slate-400 mt-2 font-mono">CK_COLOR = "#1F78B4"</p>
        </div>
      );
    }

    const handleApplyPreset = (presetName: string) => {
      const colors = presetMap[presetName];
      if (!colors) return;
      if (manifest.generatedBy === 'r_svg') {
        const patchArray = palettes.flatMap((p: any, idx: number) => {
          const resolution = resolvePaletteTargets(
            manifest,
            p.id,
            PALETTE_TARGET_RESOLVER_V2_ENABLED,
          );
          return buildPaletteObjectPatches(resolution, colors[idx % colors.length]);
        });
        void onPatch(patchArray);
        return;
      }
      const patchArray = palettes.map((p: any, idx: number) => {
        const resolution = resolvePaletteTargets(
          manifest,
          p.id,
          PALETTE_TARGET_RESOLVER_V2_ENABLED,
        );
        return {
          type: 'code_patch' as const,
          target_id: p.id,
          new_value: colors[idx % colors.length],
          gids: Array.from(new Set(resolution.targets.map(target => target.objectId))),
        };
      });
      void onPatch(patchArray);
    };

    const handleSavePreset = () => {
      const name = window.prompt('输入预设名称');
      if (!name) return;
      const colors = palettes.map((p: any) => p.color);
      const next = { ...customPresets, [name]: colors };
      setCustomPresets(next);
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    const handleDeletePreset = (name: string) => {
      if (!window.confirm(`确定删除预设"${name}"？`)) return;
      const next = { ...customPresets };
      delete next[name];
      setCustomPresets(next);
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
    };

    return (
      <div className="space-y-6">
        <div>
          {renderPanelTitle('配色中心')}
          <p className="text-xs text-slate-400 mb-4">按脚本颜色常量/字典分组，先看命中的真实图元，再统一改色。</p>
          
          <div className="space-y-4">
            {paletteGroups.map(({ palette: p, binding, resolution, gids, targetObjects, selectedCount, isActive }) => {
              const count = targetObjects.length;
              const source = typeof p.source === 'string' ? p.source : 'script';
              const propText = resolution.targets.length > 0
                ? Array.from(new Set(resolution.targets.map(target => target.prop))).join(' / ')
                : binding?.props?.length ? binding.props.join(' / ') : '未绑定';
              const previewObjects = targetObjects.slice(0, 6);
              const getPalettePatchProp = (obj: StandardFigureObject) => {
                const strictTarget = resolution.targets.find(target => target.objectId === obj.id);
                if (strictTarget) return strictTarget.prop;
                const boundProp = Array.isArray(binding?.props) && binding.props.length > 0 ? binding.props[0] : '';
                if (boundProp && ['color', 'facecolor', 'edgecolor'].includes(boundProp)) return boundProp;
                if (obj.kind === 'patch' || obj.kind === 'collection') return 'facecolor';
                return 'color';
              };
              const selectedGidsOfPalette = gids.filter((gid: string) => selectedGids.includes(gid));
              const selectedObjectsOfPalette = selectedGidsOfPalette
                .map((gid: string) => objects.find(obj => obj.id === gid))
                .filter(Boolean) as StandardFigureObject[];
              const subsetPreviewObject = selectedObjectsOfPalette[0];
              const subsetPreviewProp = subsetPreviewObject ? getPalettePatchProp(subsetPreviewObject) : 'color';
              const subsetPreviewColor = subsetPreviewObject?.currentProps?.[subsetPreviewProp] || p.color;
              const bindingBlocked = resolution.strategy === 'strict' && resolution.ambiguous.length > 0;
              return (
                <div
                  key={p.id}
                  className={`p-3 rounded-lg border space-y-3 transition-colors ${
                    isActive
                      ? 'border-blue-300 bg-blue-50/70 shadow-sm'
                      : count > 0
                        ? 'border-slate-100 bg-slate-50/50 hover:bg-slate-50'
                        : 'border-amber-100 bg-amber-50/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={() => selectPaletteTargets(gids)}
                        disabled={count === 0}
                        className="w-9 h-9 rounded shrink-0 shadow-sm border border-white ring-1 ring-slate-200 disabled:opacity-60 disabled:cursor-not-allowed"
                        style={{ backgroundColor: resolvePickerColor(p.color) }}
                        title={count > 0 ? '选中这组颜色影响的对象' : '当前 Figure 未使用此颜色'}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">{p.label}</div>
                        <div className="text-[10px] text-slate-400 font-mono truncate">{p.id}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                          }`}>
                            {count > 0 ? `命中 ${count} 个对象` : '当前图未使用'}
                          </span>
                          {selectedCount > 0 && (
                            <span className="inline-flex px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-medium">
                              已选 {selectedCount} 个
                            </span>
                          )}
                          <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-medium">
                            {propText}
                          </span>
                          {PALETTE_TARGET_RESOLVER_V2_ENABLED && (
                            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              bindingBlocked
                                ? 'bg-red-100 text-red-700'
                                : resolution.targetMode === 'conditional'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-emerald-100 text-emerald-700'
                            }`}>
                              {bindingBlocked ? '绑定歧义' : resolution.targetMode === 'conditional' ? '条件绑定' : '精确绑定'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => selectPaletteTargets(gids)}
                      disabled={count === 0}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-300 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      选中整组
                    </button>
                  </div>

                  <div className="grid grid-cols-[64px_1fr] gap-2 text-[11px] text-slate-500">
                    <span className="font-medium text-slate-400">来源</span>
                    <span className="font-mono truncate">{source}{p.line ? ` : line ${p.line}` : ''}</span>
                  </div>

                  {count > 0 && (
                    <div className="space-y-2 pt-2 border-t border-slate-100">
                      {selectedCount > 0 ? (
                        <>
                          {renderColorInput(
                            `仅修改已选的 ${selectedCount} 个图元`,
                            resolvePickerColor(String(subsetPreviewColor || p.color)),
                            (value) => {
                              const selectedResolution = resolvePaletteTargets(
                                manifest,
                                p.id,
                                PALETTE_TARGET_RESOLVER_V2_ENABLED,
                                selectedGidsOfPalette,
                              );
                              const patches = buildPaletteObjectPatches(selectedResolution, value).map((patch) => {
                                const object = manifest.objects.find(item => item.id === patch.gid);
                                const intent: EditingIntent = {
                                  intent: 'style.component',
                                  scope: {
                                    selectionMode: 'selected_only',
                                    objectIds: [patch.gid],
                                    targetKinds: object ? [object.kind] : undefined,
                                    crossFigure: 'deny',
                                  },
                                  operation: { prop: patch.prop, value },
                                  commit: { mode: 'draft', applyAsOneHistoryStep: true },
                                  fallback: { onUnsupported: 'skip_with_warning' },
                                };
                                return { ...patch, intent };
                              });
                              if (patches.length > 0) void onPatch(patches);
                            },
                            `palette-subset:${p.id}`
                          )}
                          {renderColorInput(
                            `统一修改代码全局常量 (整组同步: ${count} 个图元)`,
                            resolvePickerColor(p.color),
                            (value) => handlePaletteColorChange(p.id, value),
                            `palette:${p.id}`
                          )}
                        </>
                      ) : (
                        renderColorInput(
                          `修改组颜色代码常量 (整组同步: ${count} 个图元)`,
                          resolvePickerColor(p.color),
                          (value) => handlePaletteColorChange(p.id, value),
                          `palette:${p.id}`
                        )
                      )}
                      <div className="rounded-md bg-white/70 border border-slate-100 p-2">
                        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">影响对象</div>
                        <div className="space-y-1">
                          {previewObjects.map((obj) => (
                            <button
                              type="button"
                              key={obj.id}
                              onClick={() => {
                                onSelectGids?.([obj.id]);
                                onSelectObject(obj.id);
                              }}
                              className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                                selectedGids.includes(obj.id)
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                              }`}
                            >
                              <span className="truncate">{obj.label || obj.id}</span>
                              <span className="shrink-0 text-slate-400">{getObjectTypeLabel(obj.kind)}</span>
                            </button>
                          ))}
                          {targetObjects.length > previewObjects.length && (
                            <button
                              type="button"
                              onClick={() => selectPaletteTargets(gids)}
                              className="w-full rounded px-2 py-1 text-left text-[11px] text-blue-600 hover:bg-blue-50"
                            >
                              还有 {targetObjects.length - previewObjects.length} 个对象，点击选中整组查看
                            </button>
                          )}
                        </div>
                      </div>
                      {bindingBlocked && (
                        <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-700">
                          当前颜色绑定存在歧义，平台不会按相同颜色猜测影响对象。Python 代码常量仍可按唯一变量名修改；R 图元修改已阻止。
                        </div>
                      )}
                    </div>
                  )}

                  {count === 0 && bindingBlocked && (
                    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] leading-relaxed text-red-700">
                      <div>当前颜色绑定存在歧义，平台不会按相同颜色猜测影响对象。</div>
                      {manifest.generatedBy !== 'r_svg' && (
                        renderColorInput(
                          '仅修改明确的 Python 代码常量',
                          resolvePickerColor(p.color),
                          (value) => handlePaletteColorChange(p.id, value),
                          `palette:${p.id}`,
                        )
                      )}
                      {manifest.generatedBy === 'r_svg' && (
                        <div>R 图元没有可安全区分的 scale 目标，本次修改已阻止。</div>
                      )}
                    </div>
                  )}

                  {count === 0 && !bindingBlocked && (
                    <div className="rounded-md border border-amber-100 bg-white/70 p-2 text-[11px] leading-relaxed text-amber-700">
                      当前 Figure 没有使用这个脚本颜色。修改它不会改变当前画布；请切换到使用该颜色的 Figure，或检查脚本里该颜色是否只用于其它图。
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="pt-5 border-t border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">科研绘图预设配色</h4>
            <button
              type="button"
              onClick={handleSavePreset}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
            >
              保存当前预设
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {Object.keys(presetMap).map((name) => {
              const isCustom = Object.hasOwn(customPresets, name);
              return (
              <div key={name} className="relative group">
                <button
                  type="button"
                  onClick={() => handleApplyPreset(name)}
                  className="flex items-center justify-between p-2 rounded border border-slate-200 bg-white hover:bg-slate-50 transition-colors text-left w-full"
                >
                  <span className="text-xs font-medium text-slate-700">{name}</span>
                  <div className="flex -space-x-1 overflow-hidden">
                    {presetMap[name].slice(0, 3).map((col, idx) => (
                      <div
                        key={idx}
                        className="w-3 h-3 rounded-full ring-1 ring-white"
                        style={{ backgroundColor: col }}
                      />
                    ))}
                  </div>
                </button>
                {isCustom && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeletePreset(name); }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                    title="删除此预设"
                  >
                    ×
                  </button>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="scifig-editor-panel scifig-editor-panel-right w-full flex flex-col h-full overflow-hidden shrink-0 select-none">
      <div className="flex shrink-0 overflow-x-auto border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('properties')}
          aria-label="属性编辑"
          className={`flex min-w-16 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 py-3 text-center text-xs font-semibold transition-colors ${
            activeTab === 'properties'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          属性<span className="sr-only">编辑</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('layout')}
          aria-label="布局中心"
          className={`flex min-w-16 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 py-3 text-center text-xs font-semibold transition-colors ${
            activeTab === 'layout'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Layout className="w-3.5 h-3.5" />
          布局<span className="sr-only">中心</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('groups')}
          aria-label="组件中心"
          className={`flex min-w-16 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 py-3 text-center text-xs font-semibold transition-colors ${
            activeTab === 'groups'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Layout className="w-3.5 h-3.5" />
          组件<span className="sr-only">中心</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('palette')}
          aria-label="配色中心"
          className={`flex min-w-16 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 py-3 text-center text-xs font-semibold transition-colors ${
            activeTab === 'palette'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Palette className="w-3.5 h-3.5" />
          配色<span className="sr-only">中心</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('fonts')}
          aria-label="字体中心"
          className={`flex min-w-16 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap border-b-2 py-3 text-center text-xs font-semibold transition-colors ${
            activeTab === 'fonts'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Baseline className="w-3.5 h-3.5" />
          字体<span className="sr-only">中心</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar relative">
        {isLocked && activeTab === 'properties' && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3 mb-4 flex items-center gap-2 font-medium">
            <Lock className="w-4 h-4 text-amber-600 shrink-0" />
            <span>当前对象已被锁定。请在左侧图层大纲中解锁后编辑。</span>
          </div>
        )}

        <div className={isLocked && activeTab === 'properties' ? 'opacity-55 pointer-events-none' : ''}>
          {activeTab === 'properties' && (
            <>
              {selectedGids.length > 1 && renderBatchPanel()}
              {selectedObj ? renderObjectPanel(selectedObj) : (
                <div className="text-sm text-slate-500">未选择任何对象。</div>
              )}
              {renderGlobalsPanel()}
              <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                数值类参数在失焦或按 Enter 时提交后端重渲染，避免敲字卡顿。
              </div>
            </>
          )}

          {activeTab === 'layout' && (
            renderSubplotLayoutPanel() || (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                当前 Figure 只识别到 0 或 1 个子图，不需要多子图布局中心。选中单个 `subplot.*` 后可在属性编辑里调整真实绘图区尺寸。
              </div>
            )
          )}

          {activeTab === 'groups' && renderComponentsPanel()}

          {activeTab === 'palette' && renderPalettePanel()}

          {activeTab === 'fonts' && renderFontCenterPanel()}
        </div>
      </div>

      {(() => {
        const figureId = currentFigureId;
        const figDrafts = projectDrafts[figureId] || {};
        const draftKeys = Object.keys(figDrafts);
        const totalDraftCount = draftKeys.length;
        const pendingFigureIds = Array.from(new Set(
          draftKeys.flatMap(key => figDrafts[key]?.pendingFigureIds || []),
        )).sort();

        if (totalDraftCount === 0) return null;

        return (
          <div className="border-t border-slate-200 bg-slate-50 p-3 space-y-2 shrink-0 shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-20">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowDraftDetails(!showDraftDetails)}
                className="text-xs font-semibold text-slate-700 hover:text-slate-900 flex items-center gap-1 select-none"
              >
                <span>已暂存 {totalDraftCount} 项修改</span>
                <span className="text-[10px] text-slate-400">{showDraftDetails ? '▲' : '▼'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (totalDraftCount > 1) {
                    if (!window.confirm(`确定要放弃这 ${totalDraftCount} 项修改吗？`)) return;
                  }
                  onDiscardDraft(figureId);
                }}
                className="text-xs text-red-600 hover:text-red-700 font-medium"
              >
                取消
              </button>
            </div>

            {pendingFigureIds.length > 0 && (
              <div
                role="status"
                className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-800"
              >
                上次应用部分失败，仅待重试：{pendingFigureIds.join('、')}
              </div>
            )}

            {showDraftDetails && (
              <div className="max-h-32 overflow-y-auto border border-slate-200 rounded bg-white p-2 text-xs divide-y divide-slate-100 custom-scrollbar">
                {draftKeys.map((key) => {
                  const item = figDrafts[key];
                  return (
                    <div key={key} className="py-1 flex items-center justify-between gap-2">
                      <span className="text-slate-500 font-mono truncate max-w-[120px]" title={item.gid}>
                        {item.gid === 'code_patch' ? '代码常量' : item.gid}
                      </span>
                      <span className="text-slate-400 font-mono truncate max-w-[80px]" title={item.prop}>
                        {item.prop}
                      </span>
                      <span className="text-slate-700 truncate max-w-[80px] font-semibold" title={String(item.value)}>
                        {String(item.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                onClick={() => onApplyDraft(figureId, 'current')}
                className="bg-blue-600 hover:bg-blue-700 text-white rounded text-[11px] font-semibold py-1.5 transition-colors shadow-sm"
              >
                应用当前图
              </button>
              <button
                type="button"
                onClick={() => onApplyDraft(figureId, 'selected')}
                disabled={selectedFigureIds.length === 0}
                title={selectedFigureIds.length > 0 ? `应用到已勾选的 ${selectedFigureIds.length} 张 Figure` : '请先在 Figure 切换条勾选目标图'}
                className={`${selectedFigureIds.length > 0 ? 'bg-amber-600 hover:bg-amber-700 text-white' : 'bg-slate-300 text-slate-500 cursor-not-allowed'} rounded text-[11px] font-semibold py-1.5 transition-colors shadow-sm`}
              >
                应用选中图{selectedFigureIds.length > 0 ? ` (${selectedFigureIds.length})` : ''}
              </button>
              <button
                type="button"
                onClick={() => onApplyDraft(figureId, 'all')}
                title="按语义映射应用到全部 Figure；无法安全匹配的图元和 code_patch 会跳过"
                className="bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-semibold py-1.5 transition-colors shadow-sm"
              >
                应用全部图
              </button>
            </div>
          </div>
        );
      })()}

      {(() => {
        const latestReport = editingIntentReports.find(report => (
          report.sourceFigureId === currentFigureId
          || report.targetReports.some(item => item.figureId === currentFigureId)
        ));
        if (!latestReport) return null;
        const appliedTotal = latestReport.targetReports.reduce((sum, item) => sum + item.appliedCount, 0);
        const skippedTotal = latestReport.targetReports.reduce((sum, item) => sum + item.skippedCount, 0);
        const scopeLabel = latestReport.scope === 'current'
          ? '当前图'
          : latestReport.scope === 'selected'
            ? '选中图'
            : '全部图';
        const skippedDetails = latestReport.targetReports.flatMap(target => (
          target.skipped.slice(0, 2).map(item => ({
            ...item,
            figureId: target.figureId,
          }))
        )).slice(0, 4);

        return (
          <div className="border-t border-slate-200 bg-white p-3 text-xs shadow-[0_-2px_10px_rgba(0,0,0,0.04)]">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-800">最近语义应用结果</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {scopeLabel} · 修改 {appliedTotal} 项 · 跳过 {skippedTotal} 项
                </div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${skippedTotal > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                {skippedTotal > 0 ? '部分跳过' : '全部应用'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1">
              {latestReport.targetReports.slice(0, 4).map(target => (
                <div key={target.figureId} className="flex items-center justify-between rounded border border-slate-100 bg-slate-50 px-2 py-1">
                  <span className="font-mono text-[11px] text-slate-600">{target.figureId}</span>
                  <span className="text-[11px] text-slate-500">改 {target.appliedCount} · 跳 {target.skippedCount}</span>
                </div>
              ))}
            </div>
            {skippedDetails.length > 0 && (
              <div className="mt-2 rounded-lg border border-amber-100 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800">
                <div className="mb-1 font-semibold">跳过原因</div>
                {skippedDetails.map((item, index) => (
                  <div key={`${item.figureId}-${item.gid || 'unknown'}-${index}`} className="truncate" title={item.detail}>
                    {item.figureId} · {skippedReasonLabel(item.reason)} · {item.gid || item.role || '目标对象'}：{item.detail}
                  </div>
                ))}
                {skippedTotal > skippedDetails.length && (
                  <div className="mt-1 text-amber-700">还有 {skippedTotal - skippedDetails.length} 项跳过，可在渲染日志中继续核对。</div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
