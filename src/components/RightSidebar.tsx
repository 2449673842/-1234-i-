import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Layout, Palette, Sliders } from 'lucide-react';
import { FigureSession, PatchEntry, ManifestObject, ManifestField, Binding } from '../schemas/manifest';

interface RightSidebarProps {
  figSession: FigureSession | null;
  selectedObject?: string;
  onSelectObject: (obj: string) => void;
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
const LEGEND_LOCATIONS = ['best', 'upper right', 'upper left', 'lower left', 'lower right', 'right', 'center left', 'center right', 'lower center', 'upper center', 'center'];
const TICK_DIRECTIONS = ['out', 'in', 'inout'];

function isLocalPatch(kind: string, prop: string) {
  if (!LOCAL_PROPS.has(prop)) {
    return false;
  }
  if (prop === 'visible') {
    return true;
  }
  if (kind === 'text') {
    return prop === 'text' || prop === 'color';
  }
  if (kind === 'line' || kind === 'patch' || kind === 'collection' || kind === 'spine') {
    return prop === 'color' || prop === 'facecolor' || prop === 'edgecolor' || prop === 'alpha';
  }
  return false;
}

export function RightSidebar({
  figSession,
  selectedObject,
  onSelectObject,
  onPatch,
  lockedObjects,
}: RightSidebarProps) {
  const [activeTab, setActiveTab] = useState<'properties' | 'groups' | 'palette'>('properties');
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [customPresets, setCustomPresets] = useState<Record<string, string[]>>({});
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

  const getDraftKey = (gid: string, prop: string) => `${gid}::${prop}`;

  const handlePatch = (gid: string, prop: string, value: unknown) => {
    const currentObject = manifest.objects.find((item) => item.id === gid);
    const isColorProp = prop === 'color' || prop === 'facecolor' || prop === 'edgecolor';
    if (isColorProp && typeof value === 'string' && value.startsWith('#') && Array.isArray(manifest.bindings) && manifest.bindings.length > 0) {
      const binding = manifest.bindings.find((b: Binding) => Array.isArray(b.gids) && b.gids.includes(gid));
      if (binding && binding.paletteId) {
        void onPatch([{
          type: 'code_patch' as const,
          target_id: binding.paletteId,
          new_value: value,
          gids: binding.gids
        }]);
        return;
      }
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

  const commitNumberDraft = (gid: string, prop: string, currentValue: number | undefined, rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const nextValue = Number(trimmed);
    if (!Number.isFinite(nextValue)) return;
    if (nextValue !== currentValue) {
      handlePatch(gid, prop, nextValue);
    }
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
        <span className="text-slate-600 capitalize">{label}</span>
        <input
          type="number"
          min={options?.min}
          max={options?.max}
          step={options?.step ?? 1}
          className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white text-slate-700 focus:border-blue-500"
          value={inputValue}
          onChange={(event) => updateDraft(gid, label, event.target.value)}
          onBlur={(event) => commitNumberDraft(gid, label, value, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitNumberDraft(gid, label, value, (event.target as HTMLInputElement).value);
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
        <span className="text-slate-600 block capitalize">{label}</span>
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
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const nextVal = (event.target as HTMLInputElement).value;
              if (nextVal !== value) {
                onValue(nextVal);
              }
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

  const renderColorInput = (label: string, value: string, onValue: (nextValue: string) => void) => {
    const hexColor = resolvePickerColor(value);
    const textValue = typeof value === 'string' ? value : hexColor;

    return (
      <div className="grid grid-cols-[80px_auto_1fr] items-center gap-3 text-sm" key={label}>
        <span className="text-slate-600 capitalize">{label}</span>
        <div className="w-8 h-8 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
          <input
            type="color"
            className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
            value={hexColor}
            onChange={(event) => onValue(event.target.value)}
          />
        </div>
        <input
          type="text"
          className="border border-slate-200 rounded p-1.5 uppercase text-slate-600 outline-none w-full text-xs font-mono"
          value={textValue.toUpperCase()}
          onChange={(event) => onValue(event.target.value)}
        />
      </div>
    );
  };

  const renderBoolInput = (label: string, value: boolean, onValue: (nextValue: boolean) => void) => (
    <div className="flex items-center justify-between mb-3 text-sm" key={label}>
      <span className="text-slate-600 capitalize">{label}</span>
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
      <span className="text-slate-600 capitalize">{label}</span>
      <select
        className="border border-slate-200 rounded p-1.5 w-full outline-none bg-white text-slate-700 text-xs"
        value={value}
        onChange={(event) => onValue(event.target.value)}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );

  const renderRangePair = (objId: string, label: string, values: number[], prop: string) => (
    <div key={prop} className="space-y-1.5">
      <span className="text-xs text-slate-500 font-semibold block">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          step="any"
          className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
          value={values[0]}
          onChange={(event) => handlePatch(objId, prop, [Number(event.target.value), values[1]])}
        />
        <input
          type="number"
          step="any"
          className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
          value={values[1]}
          onChange={(event) => handlePatch(objId, prop, [values[0], Number(event.target.value)])}
        />
      </div>
    </div>
  );

  const renderField = (gid: string, prop: string, fieldType: string, currentValue: unknown) => {
    if (fieldType === 'number' || typeof currentValue === 'number') {
      return renderNumberInput(gid, prop, currentValue as number, (v) => handlePatch(gid, prop, v), { step: prop.includes('size') || prop.includes('width') ? 0.5 : 0.1 });
    }
    if (fieldType === 'boolean' || typeof currentValue === 'boolean') {
      return renderBoolInput(prop, currentValue as boolean, (v) => handlePatch(gid, prop, v));
    }
    if (fieldType === 'color' || prop.includes('color')) {
      return renderColorInput(prop, currentValue as string, (v) => handlePatch(gid, prop, v));
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
          <div>
            <span className="text-xs text-slate-500 font-semibold mb-2 block">X 轴范围 (Limits)</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="any"
                className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
                value={xlim[0]}
                placeholder="X min"
                onChange={(e) => handlePatch(obj.id, 'xlim', [Number(e.target.value), xlim[1]])}
              />
              <input
                type="number"
                step="any"
                className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
                value={xlim[1]}
                placeholder="X max"
                onChange={(e) => handlePatch(obj.id, 'xlim', [xlim[0], Number(e.target.value)])}
              />
            </div>
          </div>
          
          <div>
            <span className="text-xs text-slate-500 font-semibold mb-2 block">Y 轴范围 (Limits)</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="any"
                className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
                value={ylim[0]}
                placeholder="Y min"
                onChange={(e) => handlePatch(obj.id, 'ylim', [Number(e.target.value), ylim[1]])}
              />
              <input
                type="number"
                step="any"
                className="border border-slate-200 rounded p-1.5 text-xs text-slate-700 bg-white"
                value={ylim[1]}
                placeholder="Y max"
                onChange={(e) => handlePatch(obj.id, 'ylim', [ylim[0], Number(e.target.value)])}
              />
            </div>
          </div>

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
              {renderColorInput('网格线颜色', props.color || '#cccccc', (v) => handlePatch(obj.id, 'color', v))}
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
          {renderColorInput('边框颜色', props.color || '#000000', (v) => handlePatch(obj.id, 'color', v))}
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
          {renderColorInput('label_color', props.label_color || '#000000', (v) => handlePatch(obj.id, 'label_color', v))}
          {renderNumberInput(obj.id, 'tick_rotation', props.tick_rotation || 0, (v) => handlePatch(obj.id, 'tick_rotation', v), { min: -180, max: 180, step: 1 })}
          {renderSelectInput('tick_direction', props.tick_direction || 'out', TICK_DIRECTIONS, (v) => handlePatch(obj.id, 'tick_direction', v))}
          {renderNumberInput(obj.id, 'tick_length', props.tick_length || 3.5, (v) => handlePatch(obj.id, 'tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'tick_width', props.tick_width || 0.8, (v) => handlePatch(obj.id, 'tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput('tick_color', props.tick_color || '#000000', (v) => handlePatch(obj.id, 'tick_color', v))}
          {renderNumberInput(obj.id, 'tick_pad', props.tick_pad || 3.5, (v) => handlePatch(obj.id, 'tick_pad', v), { min: 0, max: 20, step: 0.5 })}
          {renderBoolInput('show_minor_ticks', Boolean(props.show_minor_ticks), (v) => handlePatch(obj.id, 'show_minor_ticks', v))}
          {renderNumberInput(obj.id, 'minor_tick_length', props.minor_tick_length || 2, (v) => handlePatch(obj.id, 'minor_tick_length', v), { min: 0, max: 20, step: 0.5 })}
          {renderNumberInput(obj.id, 'minor_tick_width', props.minor_tick_width || 0.6, (v) => handlePatch(obj.id, 'minor_tick_width', v), { min: 0, max: 10, step: 0.1 })}
          {renderColorInput('minor_tick_color', props.minor_tick_color || '#000000', (v) => handlePatch(obj.id, 'minor_tick_color', v))}
          {renderNumberInput(obj.id, 'tick_labelsize', props.tick_labelsize || 10, (v) => handlePatch(obj.id, 'tick_labelsize', v), { min: 4, max: 30, step: 0.5 })}
          {renderColorInput('tick_labelcolor', props.tick_labelcolor || '#000000', (v) => handlePatch(obj.id, 'tick_labelcolor', v))}
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
                  {renderColorInput('背景填充色', props.facecolor || '#ffffff', (v) => handlePatch(obj.id, 'facecolor', v))}
                  {renderColorInput('边框颜色', props.edgecolor || '#000000', (v) => handlePatch(obj.id, 'edgecolor', v))}
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
        {renderPanelTitle(`对象属性: ${obj.label || obj.id}`)}
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
              return renderColorInput(key, f.value, (v) => handlePatch('global', key, v));
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

  const renderPalettePanel = () => {
    const palettes = manifest.palettes || [];
    const bindings = manifest.bindings || [];
    
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
          <p className="text-xs text-slate-400 mb-4">修改脚本中的颜色常量，同步更新全图绑定元素。</p>
          
          <div className="space-y-4">
            {palettes.map((p: any) => {
              const binding = bindings.find((b: Binding) => b.paletteId === p.id);
              const count = binding ? binding.gids.length : 0;
              return (
                <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors">
                  <div className="w-8 h-8 rounded shrink-0 shadow-sm border border-slate-200 overflow-hidden relative cursor-pointer">
                    <input
                      type="color"
                      className="absolute inset-0 w-[200%] h-[200%] -top-[50%] -left-[50%] cursor-pointer"
                      value={p.color}
                      onChange={(event) => handlePaletteColorChange(p.id, event.target.value)}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-700 truncate">{p.label}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{p.id}</div>
                  </div>
                  <div className="text-right">
                    <span className="inline-block bg-blue-50 text-blue-600 text-[10px] px-1.5 py-0.5 rounded font-medium">
                      引用 {count} 处
                    </span>
                  </div>
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
          分组编辑
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
              {selectedObj ? renderObjectPanel(selectedObj) : (
                <div className="text-sm text-slate-500">未选择任何对象。</div>
              )}
              {renderGlobalsPanel()}
              <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                数值类参数在失焦或按 Enter 时提交后端重渲染，避免敲字卡顿。
              </div>
            </>
          )}

          {activeTab === 'groups' && renderGroupsPanel()}

          {activeTab === 'palette' && renderPalettePanel()}
        </div>
      </div>
    </div>
  );
}
