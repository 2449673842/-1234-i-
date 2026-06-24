import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Editor from '@monaco-editor/react';
import { ChartPreview } from './ChartPreview';
import { ManifestViewer } from './ManifestViewer';
import { FigureSpec } from '../types';
import { Home, ChevronRight, PenLine, Maximize, Settings, UploadCloud, Minus, Baseline, Download, Loader2, Save, Eye } from 'lucide-react';
import { ViewState } from '../App';
import { buildReproduciblePython } from '../utils/reproduciblePython';
import { sanitizeSvg } from '../utils/svgEditor';
import { FigureSession, RenderResponse, PatchEntry, PatchResponse, EditEntry } from '../schemas/manifest';

interface MainWorkspaceProps {
  spec: FigureSpec;
  onSpecChange: (spec: FigureSpec, options?: { recordHistory?: boolean }) => void;
  onNavigate: (view: ViewState) => void;
  selectedObject: string;
  onSelectObject: (obj: string) => void;
  selectedGids?: string[];
  onSelectGids?: (gids: string[]) => void;
  projectId: string | null;
  projectName: string;
  onProjectChange: (id: string | null, name: string) => void;
  specHistory: FigureSpec[];
  historyIndex: number;
  canUndoFigure: boolean;
  canRedoFigure: boolean;
  onUndo: () => void;
  onRedo: () => void;
  figSession: FigureSession | null;
  isRendering: boolean;
  renderError: string | null;
  renderTraceback: string | null;
  renderLog: string[];
  onRenderLog: (lines: string[]) => void;
  onRender: (script: string, dataPayload?: any) => Promise<RenderResponse>;
  onPatch: (patches: PatchEntry[]) => Promise<PatchResponse>;
  onCodePatch: (script: string, force?: boolean) => Promise<any>;

  // V3.2A Project Layer
  projectFigures?: Record<string, any>;
  activeFigureId?: string;
  onSelectFigure?: (figureId: string) => void;
  onProjectRender?: (script?: string) => Promise<void>;

  // V3.2B Selection & Undo
  projectHistory?: Record<string, { past: EditEntry[][]; future: EditEntry[][] }>;
  onProjectUndo?: (figureId: string) => Promise<void>;
  onProjectRedo?: (figureId: string) => Promise<void>;
}

export function MainWorkspace({
  spec,
  onSpecChange,
  onNavigate,
  selectedObject,
  onSelectObject,
  selectedGids = [],
  onSelectGids = () => {},
  projectId,
  projectName,
  onProjectChange,
  specHistory,
  historyIndex,
  canUndoFigure,
  canRedoFigure,
  onUndo,
  onRedo,
  figSession,
  isRendering,
  renderError,
  renderTraceback,
  renderLog,
  onRenderLog,
  onRender,
  onPatch,
  onCodePatch,
  projectFigures = {},
  activeFigureId = 'fig_1',
  onSelectFigure,
  onProjectRender,
  projectHistory,
  onProjectUndo,
  onProjectRedo,
}: MainWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'data' | 'spec'>('preview');
  const [bottomTab, setBottomTab] = useState<'python' | 'spec' | 'log'>('python');
  const [showSvgModal, setShowSvgModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName);
  const [scriptDragOver, setScriptDragOver] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generatePythonCode = (nextSpec: FigureSpec) => buildReproduciblePython(nextSpec);

  const generateThumbnail = (svg: string | undefined): Promise<string | undefined> => {
    if (!svg) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const img = new Image();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 150;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 200, 150);
          ctx.drawImage(img, 0, 0, 200, 150);
          resolve(canvas.toDataURL('image/png'));
        } else {
          resolve(undefined);
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(undefined);
      };
      img.src = url;
    });
  };
  const canUndoAny = canUndoFigure || historyIndex > 0;
  const canRedoAny = canRedoFigure || historyIndex < specHistory.length - 1;
  const currentDataPayload = spec.raw_data?.custom_data
    ? { custom_data: spec.raw_data.custom_data }
    : null;

  const handleRender = async () => {
    if (projectId && onProjectRender) {
      const script = spec.custom_script || '';
      await onProjectRender(script);
      return;
    }

    const startedAt = new Date();
    const startTime = Date.now();
    const script = spec.plot_type === 'custom' && spec.custom_script 
      ? spec.custom_script 
      : generatePythonCode(spec);

    if (spec.plot_type === 'custom') {
      const boundRows = currentDataPayload?.custom_data;
      if (!Array.isArray(boundRows) || boundRows.length === 0) {
        onRenderLog([
          `> [错误] 当前自定义脚本未绑定任何上传数据`,
          `> [提示] 请回到“数据导入”页面重新上传，并点击“直接应用代码”或“应用 AI 结果并打开编辑器”。`,
        ]);
        return;
      }
    }
      
    onRenderLog([`> [开始] 调用 Python 引擎... ${startedAt.toLocaleTimeString()}`]);
    const res = await onRender(script, currentDataPayload);
    const elapsed = Date.now() - startTime;
    if (res.status === 'success') {
      onRenderLog([
        `> [引擎] Rendered successfully`,
        `> [SVG] 长度 ${res.svg.length} 字符`,
        `> [完成] 耗时 ${elapsed}ms ✔`,
      ]);
    } else {
      onRenderLog([
        `> [错误] ${res.message || '渲染失败'}`,
        res.traceback ? '> [调试] 已返回 Python traceback，见下方展开面板。' : '> [调试] 未返回 traceback。',
      ]);
    }
  };

  const handleCodePatch = async () => {
    const startedAt = new Date();
    const startTime = Date.now();
    const script = spec.custom_script || '';

    if (!projectId && spec.plot_type === 'custom') {
      const boundRows = currentDataPayload?.custom_data;
      if (!Array.isArray(boundRows) || boundRows.length === 0) {
        onRenderLog([
          `> [代码错误] 当前自定义脚本未绑定任何上传数据`,
          `> [提示] 请先回到数据导入页重新应用一次当前数据和脚本。`,
        ]);
        return;
      }
    }
    
    onRenderLog([`> [代码补丁] 开始 AST 校验与渲染... ${startedAt.toLocaleTimeString()}`]);
    let res = await onCodePatch(script, false);
    
    if (res.status === 'drift_warning') {
      const confirmForce = window.confirm(
        `检测到代码修改导致部分原有的属性覆盖失效（比如您删除了之前修改过颜色的图层）。\n` +
        `失效的图层对象: ${res.orphanedGids?.join(', ')}\n\n是否丢弃这些旧的属性覆盖并继续？`
      );
      if (!confirmForce) {
        onRenderLog([`> [代码补丁] 用户取消（检测到对象漂移）`]);
        return;
      }
      res = await onCodePatch(script, true);
    }
    
    const elapsed = Date.now() - startTime;
    if (res.status === 'success') {
      onRenderLog([
        `> [代码补丁] 渲染成功并更新代码上下文`,
        `> [完成] 耗时 ${elapsed}ms ✔`,
      ]);
    } else {
      onRenderLog([
        `> [代码错误] ${res.message || '渲染失败'}`,
        res.traceback ? '> [调试] 返回了 traceback。' : '',
        res.errors ? `> [AST 拦截] ${res.errors.join(', ')}` : ''
      ].filter(Boolean));
    }
  };

  useEffect(() => {
    setNameInput(projectName);
  }, [projectName]);

  useEffect(() => {
    return () => {
      if (autoSyncTimer.current) clearTimeout(autoSyncTimer.current);
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const previewSvg = await generateThumbnail(figSession?.svg);
      if (projectId) {
        await fetch(`/api/projects/${projectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projectName,
            spec: {
              ...spec,
              _preview: previewSvg,
              editLog: figSession?.editLog ?? [],
              script: figSession?.script ?? undefined,
            },
          }),
        });
      } else {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projectName,
            spec: {
              ...spec,
              _preview: previewSvg,
              editLog: figSession?.editLog ?? [],
              script: figSession?.script ?? undefined,
            },
          }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          onProjectChange(data.id, projectName);
        }
      }
      setLastSaved(new Date());
    } catch {
      alert('保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRename = () => {
    setEditingName(false);
    const newName = nameInput.trim() || projectName;
    setNameInput(newName);
    onProjectChange(projectId, newName);
  };

  useEffect(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      if (projectId) {
        void handleSave();
      }
    }, 5000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [spec, figSession, projectId]);

  const onRenderRef = useRef(onRender);
  useEffect(() => {
    onRenderRef.current = onRender;
  }, [onRender]);

  useEffect(() => {
    if (autoSyncTimer.current) clearTimeout(autoSyncTimer.current);
    if (spec.plot_type === 'custom') return;
    const script = generatePythonCode(spec);
    const dataPayload = spec.raw_data?.custom_data
      ? { custom_data: spec.raw_data.custom_data }
      : null;
    autoSyncTimer.current = setTimeout(async () => {
      try {
        await onRenderRef.current(script, dataPayload);
      } catch {
        // Keep autosync best-effort so it never blocks editing.
      }
    }, 800);
    return () => {
      if (autoSyncTimer.current) clearTimeout(autoSyncTimer.current);
    };
  }, [spec]);

  return (
    <div className="flex-1 flex flex-col bg-slate-50 overflow-hidden min-w-0 relative">
      <div className="h-14 flex items-center justify-between px-4 sm:px-6 shrink-0 bg-white border-b border-slate-200">
        <div className="flex items-center text-sm text-slate-500 font-medium">
          <Home className="w-4 h-4 hover:text-slate-700 cursor-pointer" onClick={() => onNavigate('home')} />
          <ChevronRight className="w-4 h-4 mx-1" />
          <span className="hover:text-blue-600 cursor-pointer" onClick={() => onNavigate('projects')}>项目</span>
          <ChevronRight className="w-4 h-4 mx-1" />
          {editingName ? (
            <input
              autoFocus
              value={nameInput}
              onChange={event => setNameInput(event.target.value)}
              onBlur={handleRename}
              onKeyDown={event => { if (event.key === 'Enter') handleRename(); }}
              className="text-sm font-semibold text-slate-800 border border-blue-300 rounded px-1.5 py-0.5 bg-blue-50 outline-none w-48"
            />
          ) : (
            <span className="text-slate-800 font-semibold flex items-center gap-2">
              {projectName}
              <PenLine className="w-3.5 h-3.5 text-slate-400 cursor-pointer hover:text-blue-600" onClick={() => setEditingName(true)} />
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndoAny}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${canUndoAny ? 'text-slate-600 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
            title={canUndoFigure ? '撤销图形编辑' : '撤销规格编辑'}
          >
            撤销
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedoAny}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${canRedoAny ? 'text-slate-600 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
            title={canRedoFigure ? '重做图形编辑' : '重做规格编辑'}
          >
            重做
          </button>
          <div className="w-px h-4 bg-slate-200 mx-2"></div>
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded shadow-sm transition-colors flex items-center gap-1.5"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            保存
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 bg-blue-50 focus:ring-2 focus:ring-blue-200 rounded transition-colors flex items-center gap-2"
            onClick={handleRender}
            disabled={isRendering}
          >
            {isRendering ? '渲染中...' : '同步至引擎并预览 SVG'}
          </button>
          {spec.plot_type === 'custom' && (
            <div className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded">
              自定义脚本修改需重新渲染后生效
            </div>
          )}
          <div className="w-px h-4 bg-slate-200 mx-2"></div>
          <button type="button" className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-2.5 py-1.5 rounded border border-emerald-100">
            <div className={`w-2 h-2 rounded-full ${projectId ? 'bg-emerald-500' : 'bg-amber-400'}`}></div>
            {projectId ? (lastSaved ? `已保存 ${lastSaved.toLocaleTimeString()}` : '已保存') : '未保存'}
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col px-4 sm:px-6 pb-2 pt-4 min-h-0 overflow-hidden">
        <div className="flex items-center justify-between bg-white px-2 py-1.5 rounded-t-lg border border-slate-200 border-b-0">
          <div className="flex gap-4 px-2">
            {[
              { id: 'preview', label: '预览' },
              { id: 'code', label: '代码' },
              { id: 'data', label: '数据' },
              { id: 'spec', label: 'Spec' },
            ].map(tab => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id as 'preview' | 'code' | 'data' | 'spec')}
                className={`text-sm font-medium pb-1.5 border-b-2 pt-1 transition-colors ${activeTab === tab.id ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100 mr-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              实时渲染
              <div className="w-3.5 h-3.5 rounded-full border border-emerald-300 text-emerald-500 flex items-center justify-center ml-0.5 text-[9px]">?</div>
            </div>
            {spec.plot_type === 'custom' && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full">
                真实 SVG 对象可直接编辑；全局参数改完后再重新渲染
              </div>
            )}
            {isRendering && <div className="text-xs text-blue-600 font-medium">Python 引擎运行中...</div>}
            {figSession?.updatedAt && <div className="text-xs text-slate-500">最近渲染 {new Date(figSession.updatedAt).toLocaleTimeString()}</div>}
          </div>
        </div>

        <div
          className="flex-1 bg-[#e5e5f7] border-l border-r border-b border-slate-200 relative overflow-auto rounded-b-lg flex items-center justify-center p-8 custom-scrollbar min-h-[300px]"
          style={{ backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', backgroundSize: '20px 20px' }}
        >
          {activeTab === 'preview' && (
            <div className="relative w-full h-full flex flex-col items-center">
              {projectId && projectFigures && Object.keys(projectFigures).length > 0 && (
                <div className="flex items-center gap-1.5 self-start bg-white border border-slate-200 rounded-lg p-1 mb-4 shadow-sm z-10">
                  {Object.keys(projectFigures).map(figId => (
                    <button
                      key={figId}
                      onClick={() => onSelectFigure?.(figId)}
                      className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${activeFigureId === figId ? 'bg-blue-50 text-blue-700 shadow-sm border border-blue-100' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Figure {figId.split('_')[1]}
                    </button>
                  ))}
                </div>
              )}
              <ChartPreview
                spec={spec}
                onSpecChange={onSpecChange}
                selectedObject={selectedObject}
                onSelectObject={onSelectObject}
                selectedGids={selectedGids}
                onSelectGids={onSelectGids}
                renderedSVG={figSession?.svg ?? null}
                onPatch={onPatch}
                figSession={figSession}
              />
              {spec.plot_type === 'custom' && (
                <div className="absolute left-4 top-4 max-w-sm bg-white/95 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg shadow-sm text-xs leading-relaxed">
                  选中真实 SVG 文本、线条或图形后，可在右侧直接修改。图尺寸、全局字体等参数改完后，再点击「同步至引擎并预览 SVG」重渲染。
                </div>
              )}
              {selectedObject !== 'Figure' && (
                <div className="absolute -top-12 left-1/2 transform -translate-x-1/2 bg-slate-800 text-white px-3 py-1.5 rounded-lg shadow-xl flex items-center gap-3 text-xs z-50">
                  <span className="font-semibold text-blue-300 truncate max-w-[120px]" title={selectedObject}>{selectedObject}</span>
                  <div className="w-px h-3 bg-slate-600"></div>
                  <button type="button" className="hover:text-blue-400 transition-colors" title="快速设置样式">
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="hover:text-blue-400 transition-colors" title="文字/字体">
                    <Baseline className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="hover:text-red-400 transition-colors" title="隐藏">
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'code' && (
            spec.plot_type === 'custom' ? (
              <div
                className="w-full h-full flex flex-col bg-[#1e1e1e] rounded shadow-xl overflow-hidden relative"
                onDragOver={(e) => { e.preventDefault(); setScriptDragOver(true); }}
                onDragLeave={() => setScriptDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setScriptDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (!file || !file.name.endsWith('.py')) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    onSpecChange({ ...spec, custom_script: ev.target?.result as string || '' });
                  };
                  reader.readAsText(file);
                }}
              >
                {scriptDragOver && (
                  <div className="absolute inset-0 z-20 bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
                    <span className="text-blue-700 font-semibold text-lg bg-white/80 px-4 py-2 rounded shadow">松开以上传 .py 文件</span>
                  </div>
                )}
                <Editor
                  height="100%"
                  defaultLanguage="python"
                  theme="vs-dark"
                  value={spec.custom_script || ''}
                  onChange={value => onSpecChange({ ...spec, custom_script: value || '' })}
                  options={{ minimap: { enabled: false }, fontSize: 13 }}
                />
                <div className="flex justify-end gap-2 p-3 bg-slate-800 border-t border-slate-700 shrink-0 z-10">
                  <input
                    type="file"
                    accept=".py"
                    className="hidden"
                    id="py-upload-editor"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        onSpecChange({ ...spec, custom_script: ev.target?.result as string || '' });
                      };
                      reader.readAsText(file);
                      e.target.value = '';
                    }}
                  />
                  <label
                    htmlFor="py-upload-editor"
                    className="px-3 py-1.5 bg-slate-600 text-white rounded text-sm font-medium hover:bg-slate-500 transition-colors cursor-pointer"
                  >
                    上传 .py 文件
                  </label>
                  <button
                    type="button"
                    onClick={handleCodePatch}
                    disabled={isRendering}
                    className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {isRendering ? '应用中...' : '同步至引擎并预览 SVG'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="w-full h-full bg-[#1e1e1e] text-slate-300 p-6 rounded font-mono text-sm whitespace-pre-wrap CustomScrollbar flex justify-start items-start text-left overflow-auto shadow-xl">
                <pre><code className="language-python">{figSession?.script || generatePythonCode(spec)}</code></pre>
              </div>
            )
          )}

          {activeTab === 'spec' && (
            <div className="w-full h-full bg-[#1e1e1e] text-green-400 p-6 rounded font-mono text-sm whitespace-pre-wrap CustomScrollbar flex justify-start items-start text-left overflow-auto shadow-xl">
              {JSON.stringify(spec, null, 2)}
            </div>
          )}
        </div>

        <div className="h-64 mt-4 bg-white border border-slate-200 rounded-lg flex flex-col shrink-0 overflow-hidden shadow-sm">
          <div className="flex items-center justify-between px-4 border-b border-slate-100 bg-slate-50/50">
            <div className="flex gap-4">
              {[
                { id: 'python', label: 'Python Code' },
                { id: 'spec', label: 'Figure Spec' },
                { id: 'log', label: '日志' },
                { id: 'manifest', label: 'Manifest (v2)' },
              ].map(tab => (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => setBottomTab(tab.id as 'python' | 'spec' | 'log' | 'manifest')}
                  className={`text-sm font-medium py-2.5 border-b-2 transition-colors ${bottomTab === tab.id ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-slate-400">
              <button type="button" className="hover:text-slate-600 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></svg>
              </button>
              <button type="button" className="hover:text-slate-600 transition-colors"><Maximize className="w-4 h-4" /></button>
              <button
                type="button"
                onClick={() => { navigator.clipboard.writeText(generatePythonCode(spec)); }}
                className="hover:text-slate-600 transition-colors text-xs px-2 py-0.5 border border-slate-200 rounded bg-white text-slate-500"
                title="复制代码"
              >
                Copy
              </button>
              <button type="button" className="hover:text-slate-600 transition-colors"><Settings className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="flex-1 flex bg-[#fafafa] font-mono text-sm overflow-hidden relative">
            {bottomTab === 'python' && (
              <div className="w-1/2 border-r border-slate-200 flex overflow-hidden">
                <div className="w-10 bg-slate-100 text-slate-400 text-right pr-2 py-3 select-none text-xs border-r border-slate-200 shrink-0 space-y-1">
                  {(figSession?.script || generatePythonCode(spec)).split('\n').map((_, index) => <div key={index}>{index + 1}</div>)}
                </div>
                <div className="p-3 text-slate-800 overflow-auto font-mono text-xs leading-relaxed whitespace-pre">
                  {figSession?.script || generatePythonCode(spec)}
                </div>
              </div>
            )}

            {bottomTab === 'python' && (
              <div className="w-1/2 flex overflow-hidden bg-white">
                <div className="w-10 bg-slate-50 text-slate-400 text-right pr-2 py-3 select-none text-xs border-r border-slate-100 shrink-0 space-y-1">
                  {JSON.stringify(spec, null, 2).split('\n').slice(0, 20).map((_, index) => <div key={index}>{index + 1}</div>)}
                </div>
                <div className="p-3 text-slate-800 overflow-auto whitespace-pre font-mono text-xs leading-relaxed">
                  {JSON.stringify(spec, null, 2)}
                </div>
              </div>
            )}

            {bottomTab === 'spec' && (
              <div className="w-full h-full bg-[#1e1e1e] text-[#d4d4d4] p-4 text-xs font-mono overflow-auto">
                <pre>{JSON.stringify(spec, null, 2)}</pre>
              </div>
            )}

            {bottomTab === 'log' && (
              <div className="w-full h-full bg-[#1e1e1e] text-emerald-400 p-4 text-xs font-mono overflow-auto space-y-3">
                {renderLog.map((line, index) => (
                  <div key={index} className={line.includes('错误') || line.includes('异常') ? 'text-red-400' : line.includes('完成') ? 'text-emerald-300 font-bold' : 'text-emerald-400'}>
                    {line}
                  </div>
                ))}
                {renderError && (
                  <div className="border border-red-900/60 bg-red-950/30 rounded p-3 space-y-2">
                    <div className="text-red-300 font-semibold">错误说明</div>
                    <div className="text-red-200 whitespace-pre-wrap">{renderError}</div>
                    {renderError.includes('not supported between instances') && (
                      <div className="text-amber-200">
                        提示：这通常是 CSV 列类型混杂导致的。检查数值列是否混入了字符串、空值或单位文本。
                      </div>
                    )}
                    {(renderError.includes('does not match the number of labels') || renderError.includes('FixedLocator')) && (
                      <div className="text-amber-200">
                        提示：坐标轴刻度位置(set_xticks)和刻度标签(set_xticklabels)数量不一致。请检查自定义脚本中 tick 设置。
                      </div>
                    )}
                    {renderError.includes("Weights sum to zero") && (
                      <div className="text-amber-200">
                        提示：直方图/加权操作中所有权重之和为零。检查数据列是否全为 0、空值或选中了错误的列作为权重。
                      </div>
                    )}
                    {renderTraceback && (
                      <details className="text-slate-200">
                        <summary className="cursor-pointer text-slate-100">展开 Python traceback</summary>
                        <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed">{renderTraceback}</pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}
            {bottomTab === 'manifest' && (
              <ManifestViewer manifest={figSession?.manifest ?? null} />
            )}
          </div>
        </div>
      </div>

      <div className="h-8 shrink-0 bg-white border-t border-slate-200 flex items-center justify-between px-4 text-xs font-medium text-slate-500">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          <span>已连接</span>
        </div>
        <div className="flex items-center gap-4">
          <span>{lastSaved ? `最后保存: ${lastSaved.toLocaleString()}` : '尚未保存'}</span>
          <span className="flex items-center gap-1"><UploadCloud className="w-3 h-3" /> 自动保存已开启 (5s)</span>
        </div>
      </div>

      {showSvgModal && figSession?.svg && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-8 backdrop-blur-sm">
          <div className="bg-[#e5e5f7] rounded-lg shadow-2xl flex flex-col max-w-4xl w-full max-h-[90vh] overflow-hidden" style={{ backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
            <div className="p-4 border-b flex justify-between items-center bg-white shadow-sm z-10">
              <h2 className="font-semibold text-lg flex items-center gap-2"><span className="text-blue-600">{`</>`}</span> 引擎渲染结果 (Python)</h2>
              <button
                type="button"
                onClick={() => setShowSvgModal(false)}
                className="text-slate-500 hover:text-slate-800 font-bold"
              >
                关闭
              </button>
            </div>
            <div className="p-8 overflow-auto flex-1 flex justify-center items-center">
              <div
                className="bg-white shadow-xl border border-slate-200"
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(figSession.svg) }}
              />
            </div>
            <div className="p-4 border-t bg-white flex justify-end gap-3 z-10 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
              <button
                type="button"
                onClick={() => setShowSvgModal(false)}
                className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded shadow-sm hover:bg-slate-50 font-medium"
              >
                返回编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  const svgForExport = figSession.svg;
                  const blob = new Blob([svgForExport], { type: 'image/svg+xml' });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `figure_matplotlib_${Date.now()}.svg`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded shadow-sm hover:bg-blue-700 font-medium flex items-center gap-2"
              >
                <Download className="w-4 h-4" />保存发行级 SVG
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
