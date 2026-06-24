import type { Manifest } from '../schemas/manifest';

interface ManifestViewerProps {
  manifest: Manifest | null;
}

export function ManifestViewer({ manifest }: ManifestViewerProps) {
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

  return (
    <div className="w-full h-full bg-[#1e1e1e] text-[13px] font-mono overflow-auto p-4">
      <div className="text-emerald-400 mb-4 font-bold">Manifest ({manifest.generatedBy})</div>

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
          <div className="flex flex-wrap gap-2">
            {Object.entries(manifest.coverageReport).map(([key, val]) => (
              <span key={key} className={`px-2 py-0.5 rounded text-[11px] ${
                val === 'full' ? 'bg-emerald-900/50 text-emerald-300' :
                val === 'partial' ? 'bg-amber-900/50 text-amber-300' :
                'bg-red-900/50 text-red-300'
              }`}>
                {key}: {val}
              </span>
            ))}
          </div>
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
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="text-slate-500 uppercase text-[10px] tracking-wider">
            <th className="text-left p-1 border-b border-slate-700">id</th>
            <th className="text-left p-1 border-b border-slate-700">kind</th>
            <th className="text-left p-1 border-b border-slate-700">editable</th>
          </tr>
        </thead>
        <tbody>
          {manifest.objects.map(obj => (
            <tr key={obj.id} className="hover:bg-slate-800/40 border-b border-slate-800">
              <td className="p-1 text-emerald-300">{obj.id}</td>
              <td className="p-1 text-slate-400">{obj.kind}</td>
              <td className="p-1 text-slate-500">{[...obj.editable].sort().join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
