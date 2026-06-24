import { Database, FileSpreadsheet, FolderOpen, Info, TableProperties } from 'lucide-react';
import { FigureSpec } from '../types';

export function DataFilesPage({ spec }: { spec: FigureSpec }) {
  const source = spec.source;
  const hasSource = Boolean(source?.file_name);
  const sampleCount = spec.raw_data?.categories?.length
    ?? spec.raw_data?.custom_data?.length
    ?? spec.raw_data?.scatter
      ? Object.values(spec.raw_data?.scatter || {}).reduce((count, group) => count + (group.x?.length || 0), 0)
      : 0;
  const groupCount = spec.raw_data?.groups
    ? Object.keys(spec.raw_data.groups).length
    : spec.raw_data?.scatter
      ? Object.keys(spec.raw_data.scatter).length
      : 0;

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Database className="w-6 h-6 text-blue-600" />
              当前项目数据
            </h1>
            <p className="text-sm text-slate-500 mt-2">
              这里只展示当前项目真正绑定的数据源，不再展示样板 CSV、占位 Excel 或虚构素材库。
            </p>
          </div>
        </div>

        {!hasSource ? (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
            <div className="max-w-xl space-y-4">
              <div className="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center">
                <FolderOpen className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900">当前项目还没有真实数据源</h2>
              <p className="text-sm text-slate-600 leading-6">
                只有在“导入数据”流程里上传过文件，当前项目才会在这里显示文件名、列信息和样本规模。未导入时不再用样板文件占位。
              </p>
            </div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-[1.5fr_1fr] gap-6">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">已绑定数据源</div>
                  <div className="text-xl font-semibold text-slate-900">{source.file_name}</div>
                  <div className="text-sm text-slate-500 mt-1">
                    {source.file_type || 'UNKNOWN'} 文件
                    {source.imported_at ? ` · 导入于 ${new Date(source.imported_at).toLocaleString()}` : ''}
                  </div>
                </div>
                <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100 shrink-0">
                  <FileSpreadsheet className="w-6 h-6" />
                </div>
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500 mb-1">原始行数</div>
                  <div className="text-lg font-semibold text-slate-900">{source.row_count ?? 0}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500 mb-1">原始列数</div>
                  <div className="text-lg font-semibold text-slate-900">{source.column_count ?? 0}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500 mb-1">图中分组</div>
                  <div className="text-lg font-semibold text-slate-900">{groupCount}</div>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-2">
                  <TableProperties className="w-4 h-4 text-slate-500" />
                  检测到的字段
                </div>
                <div className="flex flex-wrap gap-2">
                  {(source.columns || []).map(column => (
                    <span key={column} className="px-3 py-1.5 rounded-full bg-slate-100 border border-slate-200 text-sm text-slate-700 font-mono">
                      {column}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-4">
              <div className="flex items-center gap-2 text-slate-800 font-semibold">
                <Info className="w-4 h-4 text-blue-600" />
                当前图形绑定
              </div>
              <div className="space-y-3 text-sm text-slate-600">
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  图形类型：<span className="font-medium text-slate-900">{spec.plot_type}</span>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  数据维度：<span className="font-medium text-slate-900">{sampleCount}</span> 个样本条目
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  映射字段：X = <span className="font-medium text-slate-900">{spec.data.x || '未设置'}</span>，Y = <span className="font-medium text-slate-900">{spec.data.y || '未设置'}</span>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
                  分组字段：<span className="font-medium text-slate-900">{spec.data.group || '无'}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
