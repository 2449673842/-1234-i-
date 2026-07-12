import React, { useEffect, useState } from 'react';
import type { ProjectedPropertyDescriptor } from '../schemas/propertyDescriptor';

const FONT_OPTIONS = [
  'sans-serif',
  'serif',
  'monospace',
  'DejaVu Sans',
  'Arial',
  'Times New Roman',
  'Helvetica',
  'Courier New',
  'Verdana',
  'Georgia',
] as const;

const VALUE_LABELS: Record<string, string> = {
  normal: '常规',
  bold: '粗体',
  semibold: '半粗体',
  light: '细体',
  italic: '斜体',
  oblique: '倾斜',
  left: '左对齐',
  center: '居中',
  right: '右对齐',
  top: '顶部',
  baseline: '基线',
  bottom: '底部',
};

export interface PropertyControlProps {
  projection: ProjectedPropertyDescriptor;
  objectId: string;
  dirty?: boolean;
  onChange: (value: unknown, prop: string) => void;
}

export function isProjectedPropertyInteractive(projection: ProjectedPropertyDescriptor): boolean {
  return projection.state === 'editable'
    || projection.state === 'mixed'
    || projection.state === 'partial';
}

function pickerColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.slice(0, 7))) {
    return value.slice(0, 7);
  }
  if (Array.isArray(value) && value.length >= 3) {
    const channels = value.slice(0, 3).map(channel => {
      const numeric = Number(channel);
      const normalized = numeric <= 1 ? numeric * 255 : numeric;
      return Math.max(0, Math.min(255, Math.round(normalized))).toString(16).padStart(2, '0');
    });
    return `#${channels.join('')}`;
  }
  return '#000000';
}

function PropertyStateBadge({ projection }: { projection: ProjectedPropertyDescriptor }) {
  if (projection.state === 'editable' && projection.counts.conditional === 0) {
    return null;
  }
  const labels: Partial<Record<ProjectedPropertyDescriptor['state'], string>> = {
    mixed: '混合值',
    partial: '部分支持',
    readonly: '只读',
    unsupported: '不支持',
  };
  const label = labels[projection.state] || '条件写回';
  return (
    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
      {label}
    </span>
  );
}

export function PropertyControl({ projection, objectId, dirty = false, onChange }: PropertyControlProps) {
  const { descriptor } = projection;
  const prop = projection.propByObjectId[objectId];
  const value = projection.valuesByObjectId[objectId];
  const interactive = Boolean(prop) && isProjectedPropertyInteractive(projection);
  const mixed = projection.mixed || projection.state === 'mixed';
  const displayValue = value === undefined || mixed
    ? ''
    : descriptor.control === 'color'
      ? pickerColor(value)
      : String(value);
  const [inputValue, setInputValue] = useState(displayValue);

  useEffect(() => {
    setInputValue(displayValue);
  }, [displayValue]);

  if (!prop) return null;

  const commitNumber = () => {
    const numeric = Number(inputValue);
    if (!interactive || !inputValue.trim() || !Number.isFinite(numeric)) {
      setInputValue(value === undefined || mixed ? '' : String(value));
      return;
    }
    if (numeric !== value) onChange(numeric, prop);
  };
  const statusReason = Object.values(projection.unsupportedReasons).find(Boolean);
  const label = (
    <span className="flex min-w-0 items-center gap-1.5 text-slate-600">
      <span className="truncate">{descriptor.label}</span>
      {descriptor.unit && descriptor.unit !== 'none' && (
        <span className="text-[9px] text-slate-400">{descriptor.unit}</span>
      )}
      {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="已暂存" />}
      <PropertyStateBadge projection={projection} />
    </span>
  );
  const sharedProps = {
    'data-property-control': descriptor.key,
    'data-param-gid': objectId,
    'data-param-prop': prop,
  };

  let control: React.ReactNode;
  if (descriptor.control === 'number') {
    control = (
      <input
        {...sharedProps}
        data-param-role="number"
        type="number"
        aria-label={descriptor.label}
        min={descriptor.min}
        max={descriptor.max}
        step={descriptor.step ?? 1}
        placeholder={mixed ? '混合值' : undefined}
        disabled={!interactive}
        value={inputValue}
        onChange={event => setInputValue(event.target.value)}
        onBlur={commitNumber}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setInputValue(value === undefined || mixed ? '' : String(value));
          }
        }}
        className="w-full rounded border border-slate-200 bg-white p-1.5 text-xs text-slate-700 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
      />
    );
  } else if (descriptor.control === 'select') {
    control = (
      <select
        {...sharedProps}
        data-param-role="select"
        aria-label={descriptor.label}
        disabled={!interactive}
        value={mixed ? '' : String(value ?? '')}
        onChange={event => onChange(event.target.value, prop)}
        className="w-full rounded border border-slate-200 bg-white p-1.5 text-xs text-slate-700 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
      >
        {mixed && <option value="">混合值</option>}
        {(descriptor.options ?? []).map(option => (
          <option key={option} value={option}>{VALUE_LABELS[option] ?? option}</option>
        ))}
      </select>
    );
  } else if (descriptor.control === 'toggle') {
    control = (
      <label className="relative inline-flex items-center justify-self-end">
        <input
          {...sharedProps}
          data-param-role="toggle"
          type="checkbox"
          aria-label={descriptor.label}
          className="peer sr-only"
          disabled={!interactive}
          checked={Boolean(value)}
          onChange={event => onChange(event.target.checked, prop)}
        />
        <span className="h-5 w-9 rounded-full bg-slate-200 transition-colors peer-checked:bg-blue-600 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 peer-checked:[&>span]:translate-x-4">
          <span className="block h-4 w-4 translate-x-0.5 translate-y-0.5 rounded-full border border-slate-200 bg-white transition-transform" />
        </span>
      </label>
    );
  } else if (descriptor.control === 'color') {
    const color = pickerColor(value);
    control = (
      <div className="grid grid-cols-[32px_1fr] gap-2">
        <input
          {...sharedProps}
          data-param-role="color"
          type="color"
          aria-label={`${descriptor.label}选择器`}
          disabled={!interactive}
          value={color}
          onChange={event => onChange(event.target.value, prop)}
          className="h-8 w-8 cursor-pointer rounded border border-slate-200 bg-white p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <input
          data-property-control={`${descriptor.key}-text`}
          type="text"
          aria-label={descriptor.label}
          disabled={!interactive}
          value={inputValue}
          placeholder={mixed ? '混合值' : '#000000'}
          onChange={event => setInputValue(event.target.value)}
          onBlur={() => {
            const next = inputValue.trim();
            if (/^#[0-9a-f]{6}$/i.test(next) && next.toLowerCase() !== String(value).toLowerCase()) {
              onChange(next, prop);
            }
          }}
          className="w-full rounded border border-slate-200 bg-white p-1.5 font-mono text-xs uppercase text-slate-700 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
        />
      </div>
    );
  } else {
    const knownFont = FONT_OPTIONS.includes(String(value) as typeof FONT_OPTIONS[number]);
    const customFontValue = !knownFont || inputValue !== String(value ?? '') ? inputValue : '';
    control = (
      <div className="space-y-1.5">
        <select
          {...sharedProps}
          data-param-role="font"
          aria-label={descriptor.label}
          disabled={!interactive}
          value={mixed ? '' : knownFont ? String(value) : '__custom__'}
          onChange={event => {
            if (event.target.value && event.target.value !== '__custom__') onChange(event.target.value, prop);
          }}
          className="w-full rounded border border-slate-200 bg-white p-1.5 text-xs text-slate-700 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
        >
          {mixed && <option value="">混合值</option>}
          {FONT_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
          {!knownFont && !mixed && <option value="__custom__">自定义: {String(value ?? '')}</option>}
        </select>
        <input
          type="text"
          aria-label="自定义字体"
          disabled={!interactive}
          value={!mixed ? customFontValue : ''}
          placeholder="输入自定义字体"
          onChange={event => setInputValue(event.target.value)}
          onBlur={() => {
            const next = inputValue.trim();
            if (next && next !== value) onChange(next, prop);
          }}
          className="w-full rounded border border-slate-200 bg-white p-1.5 text-xs text-slate-700 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
        />
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2 text-sm"
      data-property-state={projection.state}
      data-property-protocol={projection.counts.legacyFallback > 0 ? 'legacy-fallback' : 'capability'}
      title={statusReason}
    >
      {label}
      {control}
    </div>
  );
}
