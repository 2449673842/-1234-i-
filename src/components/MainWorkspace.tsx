import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Editor from '@monaco-editor/react';
import { ChartPreview } from './ChartPreview';
import { ManifestViewer } from './ManifestViewer';
import { DatasetEntry, FigureSpec } from '../types';
import { Home, ChevronRight, PenLine, Maximize, Settings, UploadCloud, Minus, Baseline, Download, Loader2, Save, Eye } from 'lucide-react';
import { ViewState } from '../App';
import { buildReproduciblePython } from '../utils/reproduciblePython';
import { sanitizeSvg } from '../utils/svgEditor';
import { FigureSession, RenderResponse, PatchEntry, PatchResponse, EditEntry, ProjectHistoryState } from '../schemas/manifest';

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
  renderProgressText?: string | null;
  renderError: string | null;
  renderTraceback: string | null;
  renderLog: string[];
  datasets?: DatasetEntry[];
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
  projectHistory?: Record<string, ProjectHistoryState>;
  onProjectUndo?: (figureId: string) => Promise<void>;
  onProjectRedo?: (figureId: string) => Promise<void>;
  onProjectHistoryJump?: (figureId: string, targetIndex: number) => Promise<void>;
}

interface DataPreviewState {
  loading: boolean;
  error: string | null;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  returnedRows: number;
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
  renderProgressText,
  renderError,
  renderTraceback,
  renderLog,
  datasets = [],
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
  onProjectHistoryJump,
}: MainWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'data' | 'spec'>('preview');
  const [bottomTab, setBottomTab] = useState<'python' | 'spec' | 'log'>('python');
  const [showSvgModal, setShowSvgModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName);
  const [scriptDragOver, setScriptDragOver] = useState(false);
  const [showHistoryMenu, setShowHistoryMenu] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renderElapsedMs, setRenderElapsedMs] = useState(0);
  const [activeDataFileId, setActiveDataFileId] = useState<string | null>(null);
  const [dataPreview, setDataPreview] = useState<DataPreviewState>({
    loading: false,
    error: null,
    rows: [],
    totalRows: 0,
    returnedRows: 0,
  });

  useEffect(() => {
    if (!isRendering) {
      setRenderElapsedMs(0);
      return;
    }

    const startedAt = Date.now();
    setRenderElapsedMs(0);
    const timer = window.setInterval(() => {
      setRenderElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRendering]);

  const activeRenderProgressText = renderProgressText || 'Python 引擎运行中：正在重放编辑并更新 SVG...';
  const autoSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generatePythonCode = (nextSpec: FigureSpec) => buildReproduciblePython(nextSpec);
  const activeProjectFigure = projectFigures?.[activeFigureId];
  const activeCodeSlice = activeProjectFigure?.codeSlice ?? null;
  const activeScript = spec.custom_script || figSession?.script || generatePythonCode(spec);
  const codeSliceConfidenceClass =
    activeCodeSlice?.confidence === 'high'
      ? 'border-emerald-500/40 bg-emerald-950/35 text-emerald-100'
      : activeCodeSlice?.confidence === 'medium'
        ? 'border-amber-500/40 bg-amber-950/35 text-amber-100'
        : 'border-slate-600 bg-slate-900 text-slate-200';
  const fallbackDataset = spec.source?.columns?.length
    ? [{
        datasetId: 'local_raw_data',
        fileName: spec.source.file_name || '当前导入数据',
        filePath: '',
        columns: spec.source.columns,
        rowCount: spec.source.row_count ?? spec.raw_data?.custom_data?.length ?? 0,
        uploadedAt: spec.source.imported_at || '',
      }]
    : [];
  const dataFiles = datasets.length > 0 ? datasets : fallbackDataset;
  const activeDataFile = dataFiles.find(item => item.datasetId === activeDataFileId) || dataFiles[0] || null;
  const localDataRows = activeDataFile?.datasetId === 'local_raw_data'
    ? (spec.raw_data?.custom_data || [])
    : [];
  const activeDataRows = projectId ? dataPreview.rows : localDataRows;
  const activeDataColumns = activeDataFile?.columns?.length
    ? activeDataFile.columns
    : (activeDataRows[0] ? Object.keys(activeDataRows[0]) : []);
  const visibleDataRows = activeDataRows.slice(0, 500);
  const shownRowCount = projectId ? dataPreview.returnedRows : visibleDataRows.length;
  const totalRowCount = projectId ? dataPreview.totalRows : activeDataRows.length;
  const formatCellValue = (value: unknown) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return String(value);
  };

  useEffect(() => {
    if (dataFiles.length === 0) {
      setActiveDataFileId(null);
      return;
    }
    if (!activeDataFileId || !dataFiles.some(item => item.datasetId === activeDataFileId)) {
      setActiveDataFileId(dataFiles[0].datasetId);
    }
  }, [activeDataFileId, dataFiles]);

  useEffect(() => {
    if (activeTab !== 'data' || !projectId || !activeDataFile || activeDataFile.datasetId === 'local_raw_data') {
      return;
    }

    let cancelled = false;
    setDataPreview(prev => ({ ...prev, loading: true, error: null }));
    fetch(`/api/projects/${projectId}/files/${activeDataFile.datasetId}/preview?limit=500`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.status !== 'success') {
          setDataPreview({
            loading: false,
            error: data.message || '数据预览加载失败',
            rows: [],
            totalRows: 0,
            returnedRows: 0,
          });
          return;
        }
        setDataPreview({
          loading: false,
          error: null,
          rows: Array.isArray(data.rows) ? data.rows : [],
          totalRows: Number(data.totalRows || data.dataset?.rowCount || 0),
          returnedRows: Number(data.returnedRows || data.rows?.length || 0),
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDataPreview({
          loading: false,
          error: err.message,
          rows: [],
          totalRows: 0,
          returnedRows: 0,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, activeDataFile, projectId]);

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
  const activeHistory = projectId ? projectHistory?.[activeFigureId] : null;
  const historyCurrentIndex = activeHistory?.past.length ?? historyIndex;
  const historyMenuEnabled = Boolean(projectId && onProjectHistoryJump);
  const historyItems = projectId
    ? [
        ...(activeHistory?.past || []),
        { editLog: figSession?.editLog || [], label: '当前状态', timestamp: Date.now() },
        ...(activeHistory?.future || []),
      ]
    : specHistory.map((_, index) => ({
        editLog: [],
        label: index === 0 ? '初始规格' : `规格步骤 ${index}`,
        timestamp: Date.now(),
      }));
  const currentDataPayload = spec.raw_data?.custom_data
    ? { custom_data: spec.raw_data.custom_data }
    : null;

  const downloadTextFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const exportActiveDataPreview = () => {
    if (!activeDataFile || activeDataColumns.length === 0) return;
    const escapeCsv = (value: unknown) => {
      const text = formatCellValue(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      activeDataColumns.map(escapeCsv).join(','),
      ...visibleDataRows.map(row => activeDataColumns.map(column => escapeCsv(row[column])).join(',')),
    ].join('\n');
    const safeName = activeDataFile.fileName.replace(/\.[^.]+$/, '') || 'data_preview';
    downloadTextFile(`${safeName}_preview.csv`, csv, 'text/csv;charset=utf-8');
  };

  const buildDiagnosticReport = () => {
    const renderedOrTranslatedScript = spec.custom_script || figSession?.script || generatePythonCode(spec);
    const sourceColumns = spec.source?.columns || [];
    const fallbackDataset = sourceColumns.length > 0
      ? [{
          datasetId: 'current-spec-source',
          fileName: spec.source?.file_name || '当前导入数据',
          filePath: '',
          columns: sourceColumns,
          rowCount: spec.source?.row_count ?? spec.raw_data?.custom_data?.length ?? 0,
          uploadedAt: spec.source?.imported_at || '',
        }]
      : [];
    const datasetEntries = datasets.length > 0 ? datasets : fallbackDataset;
    const errorLines = renderLog.filter(line => /错误|异常|error|failed|traceback/i.test(line));

    return [
      '# SciFigure 渲染诊断记录',
      '',
      `- 导出时间: ${new Date().toLocaleString()}`,
      `- 项目名称: ${projectName}`,
      `- 项目 ID: ${projectId || '未保存/非项目模式'}`,
      `- 当前 Figure: ${activeFigureId || '单图模式'}`,
      `- 图类型: ${spec.plot_type}`,
      '',
      '## 上传数据文件与表头',
      '',
      datasetEntries.length > 0
        ? datasetEntries.map((dataset, index) => [
            `### ${index + 1}. ${dataset.fileName}`,
            '',
            `- datasetId: ${dataset.datasetId}`,
            `- rowCount: ${dataset.rowCount}`,
            dataset.filePath ? `- filePath: ${dataset.filePath}` : '- filePath: 未记录',
            dataset.uploadedAt ? `- uploadedAt: ${dataset.uploadedAt}` : '- uploadedAt: 未记录',
            `- columns (${dataset.columns.length}):`,
            '',
            '```text',
            dataset.columns.join(', '),
            '```',
          ].join('\n')).join('\n\n')
        : '未检测到已上传数据文件或表头。',
      '',
      '## AI 转义后 / 当前平台脚本',
      '',
      '```python',
      renderedOrTranslatedScript || '# 当前没有可导出的脚本',
      '```',
      '',
      '## 当前渲染日志',
      '',
      '```text',
      renderLog.length > 0 ? renderLog.join('\n') : '当前没有日志。',
      '```',
      '',
      '## 实际报错摘要',
      '',
      '```text',
      [
        renderError ? `renderError: ${renderError}` : '',
        errorLines.length > 0 ? errorLines.join('\n') : '',
      ].filter(Boolean).join('\n') || '当前没有捕获到错误摘要。',
      '```',
      '',
      '## Python Traceback',
      '',
      '```text',
      renderTraceback || '当前没有 traceback。',
      '```',
      '',
      '## 当前 Figure 编辑上下文',
      '',
      '```json',
      JSON.stringify({
        sessionId: figSession?.sessionId ?? null,
        revision: figSession?.revision ?? null,
        editLog: figSession?.editLog ?? [],
        manifestSummary: figSession?.manifest ? {
          objectCount: figSession.manifest.objects?.length ?? 0,
          paletteCount: figSession.manifest.palettes?.length ?? 0,
          groupCount: figSession.manifest.groups?.length ?? 0,
          coverageReport: figSession.manifest.coverageReport ?? null,
        } : null,
      }, null, 2),
      '```',
      '',
    ].join('\n');
  };

  const handleExportDiagnosticReport = () => {
    const safeProjectName = projectName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'scifigure';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadTextFile(
      `${safeProjectName}_render_diagnostic_${timestamp}.md`,
      buildDiagnosticReport(),
      'text/markdown;charset=utf-8'
    );
  };

  const handleRender = async () => {
    if (projectId && onProjectRender) {
      const script = spec.plot_type === 'custom'
        ? (spec.custom_script || generatePythonCode(spec))
        : generatePythonCode(spec);
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
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowHistoryMenu(prev => !prev)}
              disabled={!historyMenuEnabled || historyItems.length <= 1}
              className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                historyMenuEnabled && historyItems.length > 1
                  ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  : 'text-slate-300 cursor-not-allowed'
              }`}
              title={historyMenuEnabled ? '查看并跳转到具体历史步骤' : '项目模式下可查看具体编辑历史'}
            >
              历史
            </button>
            {historyMenuEnabled && showHistoryMenu && historyItems.length > 1 && (
              <div className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl z-50 p-2">
                <div className="px-2 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  {projectId ? `${activeFigureId} 编辑历史` : '规格历史'}
                </div>
                {historyItems.map((item, index) => {
                  const isCurrent = index === historyCurrentIndex;
                  const editCount = item.editLog.length;
                  return (
                    <button
                      type="button"
                      key={`${index}-${item.timestamp}-${item.label}`}
                      disabled={isCurrent}
                      onClick={async () => {
                        setShowHistoryMenu(false);
                        if (onProjectHistoryJump) {
                          await onProjectHistoryJump(activeFigureId, index);
                        }
                      }}
                      className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isCurrent
                          ? 'bg-blue-50 text-blue-700 cursor-default'
                          : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold truncate">
                          {index === 0 ? '0 初始图' : `${index} ${item.label}`}
                        </span>
                        {isCurrent && <span className="text-[10px] font-medium text-blue-600">当前</span>}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {editCount} 条编辑记录
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
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
            {isRendering && (
              <div className="flex items-center gap-2 text-xs text-blue-700 font-medium bg-blue-50 border border-blue-100 px-2 py-1 rounded-full">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{activeRenderProgressText}</span>
                <span className="text-blue-400">{(renderElapsedMs / 1000).toFixed(1)}s</span>
              </div>
            )}
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
              {isRendering && (
                <div className="absolute left-1/2 top-20 z-40 w-[min(520px,calc(100%-48px))] -translate-x-1/2 overflow-hidden rounded-xl border border-blue-100 bg-white/95 shadow-xl backdrop-blur">
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-800">正在重新渲染当前图形</div>
                      <div className="mt-1 text-xs leading-relaxed text-slate-500">{activeRenderProgressText}</div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                        <span>执行 Python → 应用 editLog → 生成 SVG → 刷新画布</span>
                        <span>{(renderElapsedMs / 1000).toFixed(1)}s</span>
                      </div>
                    </div>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden bg-blue-50">
                    <div className="h-full w-1/2 animate-[render-progress_1.15s_ease-in-out_infinite] rounded-r-full bg-blue-500" />
                  </div>
                </div>
              )}
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
                {projectId && activeCodeSlice && (
                  <div className={`m-3 mb-0 rounded-lg border ${codeSliceConfidenceClass} shrink-0 overflow-hidden`}>
                    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/10">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">
                          {activeCodeSlice.title || `${activeFigureId} 关联代码`}
                        </div>
                        <div className="text-[11px] opacity-80 truncate">
                          行 {activeCodeSlice.startLine}-{activeCodeSlice.endLine} · {activeCodeSlice.mode} · {activeCodeSlice.reason}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(activeCodeSlice.code || '')}
                        className="shrink-0 rounded border border-white/15 bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/15"
                      >
                        复制本图片段
                      </button>
                    </div>
                    <pre className="max-h-36 overflow-auto p-3 text-[11px] leading-relaxed text-slate-100 whitespace-pre"><code>{activeCodeSlice.code}</code></pre>
                  </div>
                )}
                <div className="flex-1 min-h-0">
                  <Editor
                    height="100%"
                    defaultLanguage="python"
                    theme="vs-dark"
                    value={spec.custom_script || ''}
                    onChange={value => onSpecChange({ ...spec, custom_script: value || '' })}
                    options={{ minimap: { enabled: false }, fontSize: 13 }}
                  />
                </div>
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

          {activeTab === 'data' && (
            <div className="w-full h-full rounded-lg border border-slate-200 bg-white shadow-xl overflow-hidden flex flex-col">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 shrink-0">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800">数据工作表</div>
                  <div className="text-xs text-slate-500 truncate">
                    {activeDataFile
                      ? `${activeDataFile.fileName} · ${activeDataColumns.length} 列 · ${totalRowCount || activeDataFile.rowCount || 0} 行`
                      : '暂无数据文件'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={exportActiveDataPreview}
                    disabled={!activeDataFile || visibleDataRows.length === 0}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="h-3.5 w-3.5" />
                    导出当前预览
                  </button>
                </div>
              </div>

              {dataFiles.length > 1 && (
                <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 shrink-0">
                  {dataFiles.map(file => (
                    <button
                      type="button"
                      key={file.datasetId}
                      onClick={() => setActiveDataFileId(file.datasetId)}
                      className={`max-w-[260px] shrink-0 rounded-md border px-3 py-1.5 text-left text-xs transition-colors ${
                        activeDataFile?.datasetId === file.datasetId
                          ? 'border-blue-300 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                      title={file.fileName}
                    >
                      <div className="truncate font-semibold">{file.fileName}</div>
                      <div className="text-[10px] opacity-70">{file.columns.length} 列 · {file.rowCount} 行</div>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-auto bg-white">
                {dataPreview.loading && projectId && (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在读取数据预览...
                  </div>
                )}

                {!dataPreview.loading && dataPreview.error && projectId && (
                  <div className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {dataPreview.error}
                  </div>
                )}

                {!dataPreview.loading && !dataPreview.error && activeDataFile && activeDataColumns.length > 0 && (
                  <table className="min-w-full border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 shadow-sm">
                      <tr>
                        <th className="sticky left-0 z-20 w-14 border-b border-r border-slate-200 bg-slate-100 px-2 py-2 text-right font-semibold text-slate-400">
                          #
                        </th>
                        {activeDataColumns.map(column => (
                          <th
                            key={column}
                            className="max-w-[260px] border-b border-r border-slate-200 px-3 py-2 text-left font-semibold"
                            title={column}
                          >
                            <div className="truncate">{column}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="font-mono text-slate-800">
                      {visibleDataRows.map((row, rowIndex) => (
                        <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'}>
                          <td className="sticky left-0 z-[1] border-b border-r border-slate-100 bg-inherit px-2 py-1.5 text-right text-slate-400">
                            {rowIndex + 1}
                          </td>
                          {activeDataColumns.map(column => {
                            const cellText = formatCellValue(row[column]);
                            return (
                              <td
                                key={column}
                                className="max-w-[260px] border-b border-r border-slate-100 px-3 py-1.5 align-top"
                                title={cellText}
                              >
                                <div className="truncate">{cellText || <span className="text-slate-300">∅</span>}</div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {!dataPreview.loading && !dataPreview.error && (!activeDataFile || activeDataColumns.length === 0) && (
                  <div className="flex h-full items-center justify-center text-sm text-slate-400">
                    当前项目没有可展示的数据表。请先在新建项目或数据管理中上传 CSV / Excel。
                  </div>
                )}
              </div>

              {activeDataFile && (
                <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500 shrink-0">
                  <span>显示 {shownRowCount} / {totalRowCount || activeDataFile.rowCount || 0} 行，最多预览 500 行</span>
                  <span className="truncate">文件 ID: {activeDataFile.datasetId}</span>
                </div>
              )}
            </div>
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
                onClick={() => { navigator.clipboard.writeText(activeScript); }}
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
                  {activeScript.split('\n').map((_, index) => <div key={index}>{index + 1}</div>)}
                </div>
                <div className="p-3 text-slate-800 overflow-auto font-mono text-xs leading-relaxed whitespace-pre">
                  {activeScript}
                </div>
              </div>
            )}

            {bottomTab === 'python' && (
              <div className="w-1/2 flex overflow-hidden bg-white">
                <div className="w-10 bg-slate-50 text-slate-400 text-right pr-2 py-3 select-none text-xs border-r border-slate-100 shrink-0 space-y-1">
                  {(activeCodeSlice?.code || JSON.stringify(spec, null, 2)).split('\n').slice(0, 80).map((_, index) => (
                    <div key={index}>{activeCodeSlice ? activeCodeSlice.startLine + index : index + 1}</div>
                  ))}
                </div>
                <div className="p-3 text-slate-800 overflow-auto whitespace-pre font-mono text-xs leading-relaxed">
                  {activeCodeSlice ? activeCodeSlice.code : JSON.stringify(spec, null, 2)}
                </div>
              </div>
            )}

            {bottomTab === 'spec' && (
              <div className="w-full h-full bg-[#1e1e1e] text-[#d4d4d4] p-4 text-xs font-mono overflow-auto">
                <pre>{JSON.stringify(spec, null, 2)}</pre>
              </div>
            )}

            {bottomTab === 'log' && (
              <div className="w-full h-full bg-[#1e1e1e] text-emerald-400 text-xs font-mono overflow-hidden flex flex-col">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-700 bg-slate-900/80 shrink-0">
                  <div className="text-slate-300">
                    诊断日志 · 数据文件 {datasets.length || (spec.source?.columns?.length ? 1 : 0)} 个 · 日志 {renderLog.length} 行
                  </div>
                  <button
                    type="button"
                    onClick={handleExportDiagnosticReport}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-100 hover:bg-slate-700 hover:text-white transition-colors"
                    title="导出当前项目数据文件、表头、脚本、日志和报错"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出诊断记录
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-4 space-y-3">
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
