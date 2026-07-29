import type { Manifest } from '../schemas/manifest';
import type { StandardFigureModel } from '../schemas/standardFigureModel';
import { useState } from 'react';
import { filterManifestObjects, MANIFEST_OBJECT_RENDER_LIMIT } from '../utils/largeFigureUi';

interface ManifestViewerProps {
  manifest: Manifest | null;
  debugModel?: StandardFigureModel | null;
}

/** Safe value renderer — prevents React "Objects are not valid as a React child" crash */
function renderDebugValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isCoverageSummary(value: unknown): value is { recognized: number; editable: number; readonly: number; unsupported: number } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'recognized' in value &&
    'editable' in value &&
    'readonly' in value &&
    'unsupported' in value
  );
}

function renderCoverageValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (isCoverageSummary(value)) {
    return `recognized ${value.recognized} · editable ${value.editable} · readonly ${value.readonly} · unsupported ${value.unsupported}`;
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)}`)
      .join(' · ');
  }
  return 'none';
}

function coverageBadgeClass(value: unknown) {
  if (value === 'full') return 'bg-emerald-900/50 text-emerald-300';
  if (value === 'partial') return 'bg-amber-900/50 text-amber-300';
  if (isCoverageSummary(value)) {
    return value.unsupported === 0
      ? 'bg-emerald-900/50 text-emerald-300'
      : 'bg-amber-900/50 text-amber-300';
  }
  return 'bg-slate-800 text-slate-300';
}

export function ManifestViewer({ manifest, debugModel }: ManifestViewerProps) {
  const [showAllObjects, setShowAllObjects] = useState(false);
  const [objectQuery, setObjectQuery] = useState('');
  const [objectKind, setObjectKind] = useState('all');

  if (!manifest) {
    return (
      <div className="w-full h-full bg-[#1e1e1e] text-slate-400 p-4 text-xs font-mono flex items-center justify-center">
        尚未运行内省渲染。点击「内省引擎」按钮生成 Manifest。
      </div>
    );
  }

  const objectsByKind: Record<string, number> = {};
  for (const obj of manifest.objects) {
    objectsByKind[obj.kind] = (objectsByKind[obj.kind] || 0) + 1;
  }
  const filteredObjects = filterManifestObjects(manifest.objects, objectQuery, objectKind);
  const visibleObjects = showAllObjects ? filteredObjects : filteredObjects.slice(0, MANIFEST_OBJECT_RENDER_LIMIT);
  const hiddenObjectCount = Math.max(0, filteredObjects.length - visibleObjects.length);

  return (
    <div className="w-full h-full bg-[#1e1e1e] text-[13px] font-mono overflow-auto p-4">
      <div className="text-emerald-400 mb-4 font-bold">Manifest ({manifest.generatedBy})</div>

      {/* StandardFigureModel debug metadata */}
      {debugModel && (
        <div className="mb-4 bg-indigo-950/40 border border-indigo-800/40 rounded-lg p-3">
          <div className="text-indigo-400 text-xs uppercase tracking-wider mb-2">StandardFigureModel v{debugModel.schemaVersion}</div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">engine</div>
              <div className="text-indigo-300">{renderDebugValue(debugModel.engine)}</div>
            </div>
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">figureId</div>
              <div className="text-indigo-300">{renderDebugValue(debugModel.figureId)}</div>
            </div>
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">revision</div>
              <div className="text-indigo-300">{renderDebugValue(debugModel.revision)}</div>
            </div>
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">objects</div>
              <div className="text-indigo-300">{renderDebugValue(debugModel.objects.length)}</div>
            </div>
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">editLog</div>
              <div className="text-indigo-300">{renderDebugValue(debugModel.editLog.length)} entries</div>
            </div>
            <div className="bg-slate-800/60 rounded p-1.5">
              <div className="text-slate-500">capabilities</div>
              <div className="text-indigo-300 text-[10px]">
                {debugModel.capabilities.localPatch && 'L'}
                {debugModel.capabilities.backendPatch && 'B'}
                {debugModel.capabilities.codePatch && 'C'}
              </div>
            </div>
          </div>
          {debugModel.warnings.length > 0 && (
            <div className="mt-2 text-[10px] text-amber-400/80">
              {debugModel.warnings.map((w, i) => <div key={i}>⚠ {renderDebugValue(w)}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Globals */}
      <div className="mb-4">
        <div className="text-blue-400 text-xs uppercase tracking-wider mb-2">Globals</div>
        <div className="grid grid-cols-3 gap-4">
          {Object.entries(manifest.globals).map(([key, field]) => (
            <div key={key} className="bg-slate-800/60 rounded p-2">
              <div className="text-slate-400 text-[11px]">{key}</div>
              <div className="text-white text-sm">{field.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Coverage */}
      {manifest.coverageReport && (
        <div className="mb-4">
          <div className="text-blue-400 text-xs uppercase tracking-wider mb-2">Coverage</div>
          <div className="flex flex-wrap gap-2 mb-2">
            {Object.entries(manifest.coverageReport).map(([key, val]) => (
              <span key={key} className={`px-2 py-0.5 rounded text-[11px] ${coverageBadgeClass(val)}`}>
                {key}: {renderCoverageValue(val)}
              </span>
            ))}
          </div>
          {'byKind' in manifest.coverageReport && manifest.coverageReport.byKind && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(manifest.coverageReport.byKind).map(([kind, detail]) => (
                <span key={kind} className="bg-slate-800/70 text-slate-300 px-2 py-0.5 rounded text-[11px]">
                  {kind}: {detail.count} / {detail.editableProps.length} props
                  {detail.editablePropsIntersection
                    ? ` · common ${detail.editablePropsIntersection.length}`
                    : ''}
                  {detail.editablePropVariants && detail.editablePropVariants.length > 1
                    ? ` · ${detail.editablePropVariants.length} variants`
                    : ''}
                </span>
              ))}
            </div>
          )}
          {'unsupportedArtists' in manifest.coverageReport && manifest.coverageReport.unsupportedArtists?.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-300/80">
              Unsupported: {manifest.coverageReport.unsupportedArtists.map(item => `${item.class}(${item.count})`).join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Objects summary */}
      <div className="mb-4">
        <div className="text-blue-400 text-xs uppercase tracking-wider mb-2">
          Objects ({manifest.objects.length})
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {Object.entries(objectsByKind).map(([kind, count]) => (
            <span key={kind} className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded text-[11px]">
              {kind}: {count}
            </span>
          ))}
        </div>
      </div>

      {/* Object list */}
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_160px] gap-2">
        <input
          data-testid="manifest-object-search"
          type="search"
          value={objectQuery}
          onChange={event => {
            setObjectQuery(event.target.value);
            setShowAllObjects(false);
          }}
          placeholder="搜索 id、角色、标签、文本或语义 identity"
          className="min-w-0 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none focus:border-indigo-500"
        />
        <select
          data-testid="manifest-kind-filter"
          value={objectKind}
          onChange={event => {
            setObjectKind(event.target.value);
            setShowAllObjects(false);
          }}
          className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-100 outline-none focus:border-indigo-500"
        >
          <option value="all">全部类型</option>
          {Object.keys(objectsByKind).sort().map(kind => (
            <option key={kind} value={kind}>{kind} ({objectsByKind[kind]})</option>
          ))}
        </select>
      </div>
      {(objectQuery.trim() || objectKind !== 'all') && (
        <div data-testid="manifest-filter-summary" className="mb-2 text-[11px] text-slate-400">
          匹配 {filteredObjects.length} / {manifest.objects.length} 个对象；筛选只影响调试表显示，不影响选择、编辑或导出。
        </div>
      )}
      {hiddenObjectCount > 0 && (
        <div data-testid="manifest-object-limit" className="mb-2 flex items-center justify-between rounded border border-slate-700/70 bg-slate-900/70 px-3 py-2 text-[11px] text-slate-300">
          <span>
            为保持大图响应，当前仅渲染前 {MANIFEST_OBJECT_RENDER_LIMIT} 个匹配对象；完整 manifest 仍用于选择、写回和导出。
          </span>
          <button
            type="button"
            onClick={() => setShowAllObjects(true)}
            className="rounded bg-slate-700 px-2 py-1 font-semibold text-slate-100 hover:bg-slate-600"
          >
            显示全部 {manifest.objects.length}
          </button>
        </div>
      )}
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-slate-500 uppercase text-[10px] tracking-wider">
            <th className="text-left p-1 border-b border-slate-700">id</th>
            <th className="text-left p-1 border-b border-slate-700">kind</th>
            <th className="text-left p-1 border-b border-slate-700">editable</th>
          </tr>
        </thead>
        <tbody>
          {visibleObjects.map(obj => (
            <tr key={obj.id} data-manifest-object-id={obj.id} className="hover:bg-slate-800/40 border-b border-slate-800">
              <td className="p-1 text-emerald-300">{obj.id}</td>
              <td className="p-1 text-slate-400">{obj.kind}</td>
              <td className="p-1 text-slate-500">{[...obj.editable].sort().join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filteredObjects.length === 0 && (
        <div className="py-8 text-center text-[11px] text-slate-500">没有匹配的 manifest 对象</div>
      )}

      {manifest.unsupportedNotes && manifest.unsupportedNotes.length > 0 && (
        <div className="mt-4">
          <div className="text-amber-400 text-xs uppercase tracking-wider mb-2">限制说明</div>
          <ul className="list-disc list-inside text-amber-300/70 text-[11px] space-y-0.5">
            {manifest.unsupportedNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
