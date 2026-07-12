import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ArrowLeft, Check, FileCode2, FileSpreadsheet, Loader2, Plus, Upload, X } from 'lucide-react';
import type { ViewState } from '../App';
import type { DatasetEntry, FigureSpec } from '../types';
import { extractReferencedDataFiles, matchesReferencedDataFile } from '../utils/scriptDataDependencies';

interface ProjectReconfigurePageProps {
  projectId: string;
  projectName: string;
  spec: FigureSpec;
  datasets: DatasetEntry[];
  onNavigate: (view: ViewState) => void;
  onApply: (input: { script: string; language: 'python' | 'r'; files: File[] }) => Promise<void>;
}

function inferLanguage(fileName: string, fallback: 'python' | 'r'): 'python' | 'r' {
  return fileName.toLowerCase().endsWith('.r') ? 'r' : fileName.toLowerCase().endsWith('.py') ? 'python' : fallback;
}

export function ProjectReconfigurePage({
  projectId,
  projectName,
  spec,
  datasets,
  onNavigate,
  onApply,
}: ProjectReconfigurePageProps) {
  const [script, setScript] = useState(spec.custom_script || '');
  const [language, setLanguage] = useState<'python' | 'r'>(spec.script_language || 'python');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);

  const expectedFiles = useMemo(() => extractReferencedDataFiles(script), [script]);
  const availableNames = useMemo(
    () => [...datasets.map(item => item.fileName), ...pendingFiles.map(file => file.name)],
    [datasets, pendingFiles],
  );
  const missingFiles = expectedFiles.filter(expected => !availableNames.some(actual => matchesReferencedDataFile(expected, actual)));

  const addFiles = (files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const allowed = /\.(?:csv|tsv|txt|xlsx|xls)$/i;
    setPendingFiles(previous => {
      const names = new Set([...datasets.map(item => item.fileName.toLowerCase()), ...previous.map(file => file.name.toLowerCase())]);
      return [
        ...previous,
        ...Array.from(files).filter(file => allowed.test(file.name) && !names.has(file.name.toLowerCase())),
      ];
    });
  };

  const readScript = (file: File) => {
    if (!/\.(?:py|r)$/i.test(file.name)) return;
    const reader = new FileReader();
    reader.onload = () => {
      setScript(String(reader.result || ''));
      setLanguage(inferLanguage(file.name, language));
    };
    reader.readAsText(file);
  };

  const apply = async () => {
    if (!script.trim()) return;
    if (missingFiles.length > 0 && !window.confirm(`脚本仍引用 ${missingFiles.length} 个尚未提供的数据文件：\n${missingFiles.join('\n')}\n\n仍要保存配置并尝试重新渲染吗？`)) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await onApply({ script, language, files: pendingFiles });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新配置失败');
    } finally {
      setApplying(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto bg-[#f3f6f5] px-5 py-6 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => onNavigate('editor')} className="rounded-md border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50" aria-label="返回编辑器" title="返回编辑器">
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-700">Project reconfigure</div>
              <h1 className="mt-1 text-xl font-bold text-slate-900">重新配置 {projectName}</h1>
              <p className="mt-1 text-xs text-slate-500">项目 {projectId.slice(0, 8)} · 已有文件、Figure 编辑历史和导出资产保持不变。</p>
            </div>
          </div>
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
            增量修改 · 不创建新项目
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.45fr,0.55fr]">
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">1. 检查或替换绘图脚本</h2>
                <p className="mt-1 text-xs text-slate-500">保留当前脚本作为起点；只有点击应用后才写回项目。</p>
              </div>
              <select value={language} onChange={event => setLanguage(event.target.value as 'python' | 'r')} className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs">
                <option value="python">Python</option>
                <option value="r">R</option>
              </select>
            </div>
            <textarea value={script} onChange={event => setScript(event.target.value)} spellCheck={false} className="h-[390px] w-full resize-y border-0 bg-[#101b18] p-5 font-mono text-xs leading-6 text-emerald-50 outline-none" />
            <div className="flex items-center gap-2 border-t border-slate-200 px-5 py-3">
              <input ref={scriptInputRef} type="file" accept=".py,.r,.R" className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) readScript(file); event.target.value = ''; }} />
              <button type="button" onClick={() => scriptInputRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                <Upload className="h-3.5 w-3.5" /> 替换脚本文件
              </button>
            </div>
          </div>

          <aside className="space-y-5">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">脚本引用的数据表</h2>
              <div className="mt-3 space-y-2">
                {expectedFiles.length === 0 && <p className="text-xs leading-5 text-slate-500">没有识别到固定文件名。仍可上传脚本运行需要的任意数据表。</p>}
                {expectedFiles.map(fileName => {
                  const supplied = availableNames.some(actual => matchesReferencedDataFile(fileName, actual));
                  return (
                    <div key={fileName} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs ${supplied ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                      {supplied ? <Check className="h-3.5 w-3.5" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                      <span className="min-w-0 flex-1 truncate" title={fileName}>{fileName}</span>
                      <span className="shrink-0 font-semibold">{supplied ? '已提供' : '待上传'}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-900">2. 保留并补充数据文件</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">已有 {datasets.length} 个文件默认全部保留。这里仅添加新文件，不会静默删除旧数据。</p>
              {datasets.length > 0 && (
                <div className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
                  {datasets.map(dataset => (
                    <div key={dataset.datasetId} className="flex items-center gap-2 px-1.5 py-1 text-xs text-slate-600">
                      <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      <span className="min-w-0 flex-1 truncate" title={dataset.fileName}>{dataset.fileName}</span>
                      <span className="shrink-0 text-[10px] font-semibold text-emerald-700">保留</span>
                    </div>
                  ))}
                </div>
              )}
              <div
                className={`mt-3 rounded-md border border-dashed p-4 text-center ${dragOver ? 'border-emerald-500 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}
                onDragOver={(event: DragEvent) => { event.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event: DragEvent) => { event.preventDefault(); setDragOver(false); addFiles(event.dataTransfer.files); }}
              >
                <input ref={fileInputRef} type="file" multiple accept=".csv,.tsv,.txt,.xlsx,.xls" className="hidden" onChange={event => { addFiles(event.target.files); event.target.value = ''; }} />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                  <Plus className="h-4 w-4" /> 添加数据文件
                </button>
              </div>
              {pendingFiles.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {pendingFiles.map(file => (
                    <div key={`${file.name}-${file.size}`} className="flex items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs text-slate-700">
                      <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <button type="button" onClick={() => setPendingFiles(previous => previous.filter(item => item !== file))} aria-label={`移除 ${file.name}`} className="text-slate-400 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
          <div>
            <p className="text-xs text-slate-500">应用后将保存脚本与新增文件，并重新渲染受影响的项目 Figure。</p>
            {error && <p role="alert" className="mt-1 text-xs font-semibold text-red-600">{error}</p>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => onNavigate('editor')} className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">取消</button>
            <button type="button" onClick={apply} disabled={applying || !script.trim()} className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
              {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
              {applying ? '保存并重新渲染...' : missingFiles.length > 0 ? `仍缺 ${missingFiles.length} 个文件，继续应用` : '应用配置并重新渲染'}
            </button>
          </div>
        </footer>
      </div>
    </main>
  );
}
