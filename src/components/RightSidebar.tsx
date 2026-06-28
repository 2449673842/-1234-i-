import React, { useEffect, useMemo, useState } from 'react';
import { Baseline, Lock, Layout, Palette, Sliders } from 'lucide-react';
import { FigureSession, PatchEntry, ManifestObject, ManifestField, Binding } from '../schemas/manifest';

interface RightSidebarProps {
  figSession: FigureSession | null;
  selectedObject?: string;
  onSelectObject: (obj: string) => void;
  selectedGids?: string[];
  onSelectGids?: (gids: string[]) => void;
  onPatch: (patches: PatchEntry[]) => void;
  lockedObjects?: Set<string>;
}

const LOCAL_PROPS = new Set(['text', 'color', 'visible', 'facecolor', 'edgecolor', 'alpha']);
const DEFAULT_PRESETS: Record<string, string[]> = {
  Nature: ['#1F78B4', '#D95F02', '#7570B3', '#E7298A', '#66A61E'],
  Science: ['#E41A1C', '#377EB8', '#4DAF4A', '#984EA3', '#FF7F00'],
  Cell: ['#A6CEE3', '#1F78B4', '#B2DF8A', '#33A02C', '#FB9A99'],
  PNAS: ['#332288', '#117733', '#44AA99', '#88CCEE', '#DDCC77'],
  IEEE: ['#0072B2', '#009E73', '#D55E00', '#CC79A7', '#F0E442'],
};
const PRESET_STORAGE_KEY = 'scifigure:palette-presets:v1';
const FONT_PRESET_STORAGE_KEY = 'scifigure:font-presets:v1';
const LEGEND_LOCATIONS = ['best', 'upper right', 'upper left', 'lower left', 'lower right', 'right', 'center left', 'center right', 'lower center', 'upper center', 'center'];
const TICK_DIRECTIONS = ['out', 'in', 'inout'];
const DEFAULT_FONT_PRESETS: Record<string, { family: string; title: number; label: number; tick: number; legend: number }> = {
  Nature: { family: 'Arial', title: 14, label: 11, tick: 9, legend: 9 },
  'Times 论文': { family: 'Times New Roman', title: 15, label: 12, tick: 10, legend: 10 },
  '中文兼容': { family: 'Microsoft YaHei', title: 14, label: 11, tick: 9, legend: 9 },
};

type FontPreset = { family: string; title: number; label: number; tick: number; legend: number };

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
  rotation: '旋转角度',
  ha: '水平对齐',
  va: '垂直对齐',
  x: 'X 位置',
  y: 'Y 位置',
  position: '位置',
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
  sci_notation: '科学计数法',
  use_math_text: '数学字体',
  offset_text_size: '偏移文字字号',
  x_tick_rotation: 'X 刻度旋转',
  frameon: '显示图例背景框',
  loc: '图例位置',
  ncol: '图例列数',
  markerscale: '图例点缩放',
  width_in: '画布宽度(in)',
  height_in: '画布高度(in)',
  dpi: '分辨率 DPI',
  'figure.width_in': '画布宽度(in)',
  'figure.height_in': '画布高度(in)',
  'figure.dpi': '分辨率 DPI',
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
  selectedObject,
  onSelectObject,
  selectedGids = [],
  onSelectGids,
  onPatch,
  lockedObjects,
}: RightSidebarProps) {
  const [activeTab, setActiveTab] = useState<'properties' | 'groups' | 'palette' | 'fonts'>('properties');
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [colorDraftValues, setColorDraftValues] = useState<Record<string, string>>({});
  const [customPresets, setCustomPresets] = useState<Record<string, string[]>>({});
  const [customFontPresets, setCustomFontPresets] = useState<Record<string, FontPreset>>({});
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [lastSelectedGroupId, setLastSelectedGroupId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedGroupIds(new Set());
    setLastSelectedGroupId(null);
  }, [figSession?.revision]);

  useEffect(() => {
    setDraftValues({});
  }, [figSession?.revision, selectedObject]);

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
  }, []);

  const objects = figSession?.manifest?.objects || [];
  const selectedObj = useMemo(
    () => objects.find(o => o.id === selectedObject) || objects[0],
    [objects, selectedObject]
  );

  if (!figSession || !figSession.manifest) {
    return (
      <div className="w-80 border-l border-slate-200 bg-white flex flex-col p-4 text-sm text-slate-500">
        Waiting for introspection...
      </div>
    );
  }

  const { manifest } = figSession;
  const isLocked = Boolean(selectedObject && lockedObjects?.has(selectedObject));
  const presetMap = { ...DEFAULT_PRESETS, ...customPresets };
  const fontPresetMap: Record<string, FontPreset> = { ...DEFAULT_FONT_PRESETS, ...customFontPresets };

  const getDraftKey = (gid: string, prop: string) => `${gid}::${prop}`;
  const getPropLabel = (prop: string) => PROP_LABELS[prop] || prop.replace(/_/g, ' ');
  const getValueLabel = (prop: string, value: string) => VALUE_LABELS[prop]?.[value] || value;
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
    const tickPatch = normalizeTickTextPatch(gid, prop);
    if (tickPatch) {
      void onPatch([{
        op: 'set',
        mode: 'backend_patch',
        gid: tickPatch.gid,
        prop: tickPatch.prop,
        value,
      }]);
      return;
    }

    const mode = isLocalPatch(currentObject?.kind || '', prop) ? 'local_patch' : 'backend_patch';
    void onPatch([{ op: 'set', mode, gid, prop, value }]);
  };

  const handlePaletteColorChange = (paletteId: string, newColor: string) => {
    const bindings = manifest.bindings || [];
    const binding = bindings.find((b: Binding) => b.paletteId === paletteId);
    const gids = binding ? binding.gids : [];
    void onPatch([{
      type: 'code_patch' as const,
      target_id: paletteId,
      new_value: newColor,
      gids
    }]);
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
      axes: '坐标轴',
      grid: '网格',
      axis_x: 'X轴',
      axis_y: 'Y轴',
    };
    return labels[kind] || kind;
  };

  const selectPaletteTargets = (gids: string[]) => {
    if (gids.length === 0) return;
    onSelectGids?.(gids);
    onSelectObject(gids[0]);
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
    options?: { min?: number; max?: number; step?: number }
  ) => {
    const key = getDraftKey(gid, label);
    const inputValue = draftValues[key] ?? (value ?? '').toString();
    return (
      <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm" key={label}>
        <span className="text-slate-600">{getPropLabel(label)}</span>
        <input
          type="number"
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
    return (
      <div className="text-sm space-y-1.5" key={label}>
        <span className="text-slate-600 block">{getPropLabel(label)}</span>
        <input
          type="text"
          className="border border-slate-200 rounded p-1.5 outline-none focus:border-blue-500 w-full bg-white text-slate-700"
          value={inputValue}
          onChange={(event) => updateDraft(gid, label, event.target.value)}
          onBlur={(event) => {
            const nextVal = event.target.value;
            if (nextVal !== value) {
              onValue(nextVal);
            }
            clearDraft(gid, label);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const nextVal = (event.target as HTMLInputElement).value;
              if (nextVal !== value) {
                onValue(nextVal);
              }
              clearDraft(gid, label);
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

  const renderColorInput = (label: string, value: string, onValue: (nextValue: string) => void, draftScope = label) => {
    const hexColor = resolvePickerColor(value);
    const draftKey = `color::${draftScope}`;
    const textValue = colorDraftValues[draftKey] ?? (typeof value === 'string' ? value : hexColor);
    const commitColor = (raw: string) => {
      const trimmed = raw.trim();
      if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
        onValue(trimmed);
        setColorDraftValues(prev => {
          const next = { ...prev };
          delete next[draftKey];
          return next;
        });
      }
    };

    return (
      <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-sm" key={label}>
        <span className="text-slate-600">{getPropLabel(label)}</span>
        <div className="w-8 h-8 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
          <input
            type="color"
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

  const renderBoolInput = (label: string, value: boolean, onValue: (nextValue: boolean) => void) => (
    <div className="flex items-center justify-between mb-3 text-sm" key={label}>
      <span className="text-slate-600">{getPropLabel(label)}</span>
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

  const FONT_OPTIONS = [
    'sans-serif', 'serif', 'monospace', 'DejaVu Sans', 'Arial',
    'Times New Roman', 'Helvetica', 'Courier New', 'Verdana', 'Georgia',
  ];

  const renderFontSelect = (gid: string, label: string, value: string, onValue: (nextValue: string) => void) => {
    const key = getDraftKey(gid, label);
    const inputValue = draftValues[key] ?? value;
    return (
      <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-sm" key={label}>
        <span className="text-slate-600">字体家族</span>
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

  const renderSelectInput = (label: string, value: string, options: string[], onValue: (nextValue: string) => void) => (
    <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-sm" key={label}>
      <span className="text-slate-600">{getPropLabel(label)}</span>
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

  const renderField = (gid: string, prop: string, fieldType: string, currentValue: unknown) => {
    if (fieldType === 'number' || typeof currentValue === 'number') {
      return renderNumberInput(gid, prop, currentValue as number, (v) => handlePatch(gid, prop, v), { step: prop.includes('size') || prop.includes('width') ? 0.5 : 0.1 });
    }
    if (fieldType === 'boolean' || typeof currentValue === 'boolean') {
      return renderBoolInput(prop, currentValue as boolean, (v) => handlePatch(gid, prop, v));
    }
    if (fieldType === 'color' || prop.includes('color')) {
      return renderColorInput(prop, currentValue as string, (v) => handlePatch(gid, prop, v), `${gid}:${prop}`);
    }
    if (prop === 'fontfamily') {
      return renderFontSelect(gid, prop, currentValue as string, (v) => handlePatch(gid, prop, v));
    }
    if (fieldType === 'string' || typeof currentValue === 'string') {
      return renderTextInput(gid, prop, currentValue as string, (v) => handlePatch(gid, prop, v));
    }
    return null;
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
    return (
      <div className="space-y-6">
        {renderPanelTitle(`${axisName} 轴详细控制`)}
        <div className="space-y-4">
          {renderRangePair(obj.id, `${axisName} 范围`, limits, 'limits')}
          {renderTextInput(obj.id, 'label', props.label || '', (v) => handlePatch(obj.id, 'label', v))}
          {renderNumberInput(obj.id, 'label_fontsize', props.label_fontsize || 12, (v) => handlePatch(obj.id, 'label_fontsize', v), { min: 4, max: 40, step: 0.5 })}
          {renderColorInput('label_color', props.label_color || '#000000', (v) => handlePatch(obj.id, 'label_color', v), `${obj.id}:label_color`)}
          {renderNumberInput(obj.id, 'tick_rotation', props.tick_rotation || 0, (v) => handlePatch(obj.id, 'tick_rotation', v), { min: -180, max: 180, step: 1 })}
          {renderSelectInput('tick_direction', props.tick_direction || 'out', TICK_DIRECTIONS, (v) => handlePatch(obj.id, 'tick_direction', v))}
          {renderNumberInput(obj.id, 'tick_length', props.tick_length || 3.5, (v) => handlePatch(obj.id, 'tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'tick_width', props.tick_width || 0.8, (v) => handlePatch(obj.id, 'tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput('tick_color', props.tick_color || '#000000', (v) => handlePatch(obj.id, 'tick_color', v), `${obj.id}:tick_color`)}
          {renderNumberInput(obj.id, 'tick_pad', props.tick_pad || 3.5, (v) => handlePatch(obj.id, 'tick_pad', v), { min: 0, max: 20, step: 0.5 })}
          {renderBoolInput('show_minor_ticks', Boolean(props.show_minor_ticks), (v) => handlePatch(obj.id, 'show_minor_ticks', v))}
          {renderNumberInput(obj.id, 'minor_tick_length', props.minor_tick_length || 2, (v) => handlePatch(obj.id, 'minor_tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'minor_tick_width', props.minor_tick_width || 0.6, (v) => handlePatch(obj.id, 'minor_tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput('minor_tick_color', props.minor_tick_color || '#000000', (v) => handlePatch(obj.id, 'minor_tick_color', v), `${obj.id}:minor_tick_color`)}
          {renderNumberInput(obj.id, 'tick_labelsize', props.tick_labelsize || 10, (v) => handlePatch(obj.id, 'tick_labelsize', v), { min: 4, max: 30, step: 0.5 })}
          {renderColorInput('tick_labelcolor', props.tick_labelcolor || '#000000', (v) => handlePatch(obj.id, 'tick_labelcolor', v), `${obj.id}:tick_labelcolor`)}
          {renderFontSelect(obj.id, 'tick_labelfamily', props.tick_labelfamily || 'Arial', (v) => handlePatch(obj.id, 'tick_labelfamily', v))}
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

    return (
      <div className="space-y-6">
        {renderPanelTitle(`对象属性：${getReadableObjectLabel(obj)}`)}
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          <div>类型：{getObjectTypeLabel(obj.kind)}</div>
          <div className="font-mono truncate" title={obj.id}>GID：{obj.id}</div>
        </div>
        <div className="space-y-4">
          {obj.editable.map((prop) => {
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
        {renderPanelTitle('画布尺寸与精度')}
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

      const patches: PatchEntry[] = binding.gids.map((gid: string) => {
        const obj = manifest.objects.find(o => o.id === gid);
        let actualProp = prop;
        if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
          actualProp = 'facecolor';
        }
        return {
          op: 'set',
          mode: LOCAL_PROPS.has(actualProp) ? 'local_patch' : 'backend_patch',
          gid,
          prop: actualProp,
          value: val
        };
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
            binding.gids.forEach((gid: string) => {
              const obj = manifest.objects.find(o => o.id === gid);
              let actualProp = prop;
              if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
                actualProp = 'facecolor';
              }
              patches.push({
                op: 'set',
                mode: LOCAL_PROPS.has(actualProp) ? 'local_patch' : 'backend_patch',
                gid,
                prop: actualProp,
                value: val
              });
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
    if (prop === 'visible') return true;
    if (prop === 'alpha') return ['line', 'patch', 'collection', 'legend', 'grid', 'text', 'figure'].includes(obj.kind);
    if (prop === 'color') return ['line', 'patch', 'collection', 'text', 'spine', 'grid'].includes(obj.kind);
    if (prop === 'facecolor') return ['patch', 'collection', 'legend'].includes(obj.kind);
    if (prop === 'edgecolor') return ['patch', 'collection', 'legend'].includes(obj.kind);
    if (prop === 'linewidth') return ['line', 'patch', 'collection', 'spine', 'grid'].includes(obj.kind);
    if (prop === 'markersize') return obj.kind === 'line';
    if (prop === 'size') return obj.kind === 'collection';
    if (prop === 'fontsize') return obj.kind === 'text' || obj.kind === 'legend';
    if (prop === 'fontfamily') return obj.kind === 'text' || obj.kind === 'legend';
    return false;
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
    const lineObjects = objects.filter(obj => obj.kind === 'line' && !obj.id.startsWith('legend_') && !isMarkerLine(obj));
    const pointObjects = objects.filter(obj => isMarkerLine(obj) || isScatterCollection(obj));
    const errorbarObjects = objects.filter(obj => obj.kind === 'collection' && !isScatterCollection(obj));
    const textObjects = objects.filter(obj => obj.kind === 'text');
    const axisObjects = objects.filter(obj => ['axes', 'axis_x', 'axis_y'].includes(obj.kind));
    const legendObjects = objects.filter(obj => obj.kind === 'legend');
    const componentGroups = [
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
        description: 'Legend 容器，适合批量控制显隐、透明度和字号。',
        objects: legendObjects,
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
        id: 'errorbars',
        label: '误差棒 / 集合线',
        description: 'LineCollection，适合调整误差棒颜色、线宽和透明度。',
        objects: errorbarObjects,
        colorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'patches',
        label: '柱形 / 面 / 图形块',
        description: 'Bar、Rectangle、Patch 等对象。',
        objects: objects.filter(obj => obj.kind === 'patch'),
        colorProp: 'facecolor',
        edgeColorProp: 'edgecolor',
        sizeProp: null,
      },
      {
        id: 'frames',
        label: '边框 / 网格',
        description: '坐标轴边框和网格线。',
        objects: objects.filter(obj => ['spine', 'spine_group', 'grid'].includes(obj.kind)),
        colorProp: 'color',
        sizeProp: null,
      },
    ].filter(group => group.objects.length > 0);

    const commonComponentProp = (items: ManifestObject[], prop: string, fallback: unknown) => {
      const values = items.map(item => item.currentProps[prop]).filter(value => value !== undefined && value !== null && value !== '');
      return values.length > 0 && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : fallback;
    };

    const patchComponentGroup = (items: ManifestObject[], prop: string, value: unknown) => {
      const patches = items.map(obj => {
        if (!supportsBatchProp(obj, prop)) return null;
        return {
          op: 'set' as const,
          mode: LOCAL_PROPS.has(prop) ? 'local_patch' as const : 'backend_patch' as const,
          gid: obj.id,
          prop,
          value,
        };
      }).filter(Boolean) as PatchEntry[];
      if (patches.length > 0) void onPatch(patches);
    };

    const patchPointFillColor = (items: ManifestObject[], value: unknown) => {
      const patches = items.map(obj => {
        const prop = obj.kind === 'line' ? 'color' : obj.kind === 'collection' ? 'facecolor' : null;
        if (!prop || !supportsBatchProp(obj, prop)) return null;
        return {
          op: 'set' as const,
          mode: LOCAL_PROPS.has(prop) ? 'local_patch' as const : 'backend_patch' as const,
          gid: obj.id,
          prop,
          value,
        };
      }).filter(Boolean) as PatchEntry[];
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
          const pointSize = commonComponentProp(targetObjects, 'size', undefined) as number | undefined;
          const alpha = commonComponentProp(targetObjects, 'alpha', 1) as number | undefined;
          const visible = targetObjects.every(obj => obj.currentProps.visible !== false);
          const previewObjects = group.objects.slice(0, 8);
          const targetKey = targetObjects.map(obj => obj.id).join('|');
          return (
            <div key={group.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 space-y-3">
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
                    if (gids[0]) onSelectObject(gids[0]);
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
                        if (gids[0]) onSelectObject(gids[0]);
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
                {group.colorProp && colorValue && (
                  renderColorInput(group.id === 'points' || group.id === 'patches' ? '填充色' : '颜色', colorValue, (value) => {
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
                {targetObjects.some(obj => supportsBatchProp(obj, 'fontsize')) && (
                  renderNumberInput(`component-${group.id}`, 'fontsize', commonComponentProp(targetObjects, 'fontsize', undefined) as number | undefined, (value) => patchComponentGroup(targetObjects, 'fontsize', value), { min: 4, max: 48, step: 0.5 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'linewidth')) && (
                  renderNumberInput(`component-${group.id}`, 'linewidth', linewidth, (value) => patchComponentGroup(targetObjects, 'linewidth', value), { min: 0, max: 20, step: 0.25 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'markersize')) && (
                  renderNumberInput(`component-${group.id}`, 'markersize', markerSize, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'line'), 'markersize', value), { min: 1, max: 60, step: 0.5 })
                )}
                {targetObjects.some(obj => supportsBatchProp(obj, 'size')) && (
                  renderNumberInput(`component-${group.id}`, 'size', pointSize, (value) => patchComponentGroup(targetObjects.filter(obj => obj.kind === 'collection'), 'size', value), { min: 1, max: 2000, step: 1 })
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
    const fontObjects = batchObjects.filter(o => supportsBatchProp(o, 'fontsize') || supportsBatchProp(o, 'fontfamily'));
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

      const patches: PatchEntry[] = selectedGids.map(gid => {
        const obj = objects.find(o => o.id === gid);
        if (!supportsBatchProp(obj, prop)) return null;
        let actualProp = prop;
        if (prop === 'color' && obj && (obj.kind === 'patch' || obj.kind === 'collection')) {
          actualProp = 'facecolor';
        }
        if (actualProp !== prop && !supportsBatchProp(obj, actualProp)) return null;
        return {
          op: 'set' as const,
          mode: LOCAL_PROPS.has(actualProp) ? 'local_patch' as const : 'backend_patch' as const,
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
              {renderFontSelect('batch', 'fontfamily', commonFontFamily, (v) => handleBatchPatch('fontfamily', v))}
            </div>
          )}
          {renderColorInput('颜色', commonColor, (v) => handleBatchPatch('color', v), `batch:${selectedGids.join('|')}:color`)}
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

  const getFontRole = (obj: ManifestObject): { id: string; label: string; presetKey: 'title' | 'label' | 'tick' | 'legend' } | null => {
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
    const hasAxisX = objects.some(obj => obj.kind === 'axis_x');
    const hasAxisY = objects.some(obj => obj.kind === 'axis_y');
    objects.forEach((obj) => {
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

  const fontGroupProp = (roleId: string, prop: 'fontsize' | 'fontfamily' | 'color') => {
    if (roleId === 'xticks' || roleId === 'yticks') {
      if (prop === 'fontsize') return 'tick_labelsize';
      if (prop === 'fontfamily') return 'tick_labelfamily';
      return 'tick_labelcolor';
    }
    return prop;
  };

  const commonFontGroupProp = (
    roleId: string,
    items: ManifestObject[],
    prop: 'fontsize' | 'fontfamily' | 'color',
    fallback: unknown,
  ) => commonProp(items, fontGroupProp(roleId, prop), fallback);

  const buildFontGroupPatches = (
    roleId: string,
    items: ManifestObject[],
    prop: 'fontsize' | 'fontfamily' | 'color',
    value: unknown,
  ): PatchEntry[] => {
    const tickAxisMatch = roleId === 'xticks'
      ? { textRegex: /^xtick\.(\d+)\./, axisRegex: /^axis\.x\.(\d+)$/, axisPrefix: 'axis.x.' }
      : roleId === 'yticks'
        ? { textRegex: /^ytick\.(\d+)\./, axisRegex: /^axis\.y\.(\d+)$/, axisPrefix: 'axis.y.' }
        : null;

    if (tickAxisMatch) {
      const axisIndexes = Array.from(new Set(items.map(obj => {
        return obj.id.match(tickAxisMatch.axisRegex)?.[1] || obj.id.match(tickAxisMatch.textRegex)?.[1];
      }).filter(Boolean))) as string[];
      const axisProp = fontGroupProp(roleId, prop);
      return axisIndexes.map(index => ({
        op: 'set' as const,
        mode: 'backend_patch' as const,
        gid: `${tickAxisMatch.axisPrefix}${index}`,
        prop: axisProp,
        value,
      }));
    }

    return items.map((obj) => {
      if (!supportsBatchProp(obj, prop)) return null;
      return {
        op: 'set' as const,
        mode: prop === 'color' ? 'local_patch' as const : 'backend_patch' as const,
        gid: obj.id,
        prop,
        value,
      };
    }).filter(Boolean) as PatchEntry[];
  };

  const handleFontGroupPatch = (roleId: string, items: ManifestObject[], prop: 'fontsize' | 'fontfamily' | 'color', value: unknown) => {
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

    return (
      <div className="space-y-6">
        <div>
          {renderPanelTitle('字体中心')}
          <p className="text-xs text-slate-400 mb-4">按真实 matplotlib 文本对象自动分组，统一修改标题、轴标签、刻度和图例字体。</p>
          <div className="space-y-4">
            {fontGroups.map(group => {
              const family = String(commonFontGroupProp(group.id, group.objects, 'fontfamily', 'Arial'));
              const size = commonFontGroupProp(group.id, group.objects, 'fontsize', undefined) as number | undefined;
              const color = resolvePickerColor(commonFontGroupProp(group.id, group.objects, 'color', '#000000'));
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
      </div>
    );
  };

  const renderPalettePanel = () => {
    const palettes = manifest.palettes || [];
    const bindings = manifest.bindings || [];
    const paletteGroups = palettes.map((palette: any) => {
      const binding = bindings.find((b: Binding) => b.paletteId === palette.id);
      const gids = Array.isArray(binding?.gids) ? binding.gids : [];
      const targetObjects = gids
        .map((gid: string) => objects.find(obj => obj.id === gid))
        .filter(Boolean) as ManifestObject[];
      const selectedCount = gids.filter((gid: string) => selectedGids.includes(gid)).length;
      return {
        palette,
        binding,
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
      const patchArray = palettes.map((p: any, idx: number) => {
        const binding = bindings.find((b: Binding) => b.paletteId === p.id);
        return {
          type: 'code_patch' as const,
          target_id: p.id,
          new_value: colors[idx % colors.length],
          gids: binding ? binding.gids : []
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
            {paletteGroups.map(({ palette: p, binding, gids, targetObjects, selectedCount, isActive }) => {
              const count = targetObjects.length;
              const source = typeof p.source === 'string' ? p.source : 'script';
              const propText = binding?.props?.length ? binding.props.join(' / ') : '未绑定';
              const previewObjects = targetObjects.slice(0, 6);
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
                      {renderColorInput('组颜色', resolvePickerColor(p.color), (value) => handlePaletteColorChange(p.id, value), `palette:${p.id}`)}
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
                    </div>
                  )}

                  {count === 0 && (
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
    <div className="w-80 border-l border-slate-200 bg-white flex flex-col h-full overflow-hidden shrink-0 select-none">
      <div className="flex border-b border-slate-200 shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab('properties')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'properties'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          属性编辑
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('groups')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'groups'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Layout className="w-3.5 h-3.5" />
          组件中心
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('palette')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'palette'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Palette className="w-3.5 h-3.5" />
          配色中心
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('fonts')}
          className={`flex-1 py-3 text-center text-xs font-semibold border-b-2 transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'fonts'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Baseline className="w-3.5 h-3.5" />
          字体中心
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

          {activeTab === 'groups' && renderComponentsPanel()}

          {activeTab === 'palette' && renderPalettePanel()}

          {activeTab === 'fonts' && renderFontCenterPanel()}
        </div>
      </div>
    </div>
  );
}
