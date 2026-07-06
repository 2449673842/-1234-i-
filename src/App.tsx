import React, { useEffect, useMemo, useState, useRef, type ReactNode, type ErrorInfo } from 'react';
import { Navbar } from './components/Navbar';
import { IconSidebar } from './components/IconSidebar';
import { LeftSidebar } from './components/LeftSidebar';
import { RightSidebar } from './components/RightSidebar';
import { MainWorkspace } from './components/MainWorkspace';
import { HomeDashboard } from './components/HomeDashboard';
import { TemplatesPage } from './components/TemplatesPage';
import { AppSidebar } from './components/AppSidebar';
import { DataImportPage } from './components/DataImportPage';
import { ExportSettingsPage } from './components/ExportSettingsPage';
import { ComposerPage } from './components/ComposerPage';
import { ExportLibraryPage } from './components/ExportLibraryPage';
import { ProjectsPage } from './components/ProjectsPage';
import { DataFilesPage } from './components/DataFilesPage';
import { SettingsPage } from './components/SettingsPage';
import { ProjectCreatePage } from './components/ProjectCreatePage';
import { LandingPage } from './components/LandingPage';
import { FigureSpec, defaultSpec, DatasetEntry, FigureEntry } from './types';
import { useFigureSession } from './hooks/useFigureSession';
import { buildReproduciblePython } from './utils/reproduciblePython';
import { applyRuntimePatchesToManifest, applyRuntimePatchesToSvg } from './utils/svgEditor';
import { mapPatchesToTargetFigure } from './utils/semanticPatchMapping';
import type { FigureSession, EditEntry, PatchEntry, HistorySnapshot, ProjectHistoryState } from './schemas/manifest';
import type { DraftPatch } from './schemas/draftPatchBatch';
import './index.css';

class EditorErrorBoundary extends React.Component<
  Record<string, unknown>,
  { hasError: boolean; error: Error | null }
> {
  state: { hasError: boolean; error: Error | null } = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error('Editor crashed:', error, _info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center bg-slate-50 p-8">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 max-w-lg text-center space-y-4">
            <div className="text-4xl">⚠️</div>
            <h2 className="text-lg font-semibold text-slate-800">编辑器出现异常</h2>
            <p className="text-sm text-slate-500">{this.state.error?.message || '未知错误'}</p>
            <p className="text-xs text-slate-400">请检查浏览器控制台（F12）查看详细错误信息</p>
          </div>
        </div>
      );
    }
    return (this as any).props.children as ReactNode;
  }
}

export type ViewState = 'home' | 'templates' | 'data_import' | 'editor' | 'workspace' | 'export_settings' | 'composer' | 'projects' | 'data' | 'settings' | 'project_create' | 'landing' | 'export_library';

const SPEC_STORAGE_KEY = 'scifigure:app-state:v2';

interface PersistedAppState {
  spec: FigureSpec;
  history: FigureSpec[];
  historyIndex: number;
  projectId: string | null;
  projectName: string;
  figSession: FigureSession | null;
  renderLog: string[];
  projectFigures?: Record<string, FigureEntry>;
  activeFigureId?: string;
  selectedFigureIds?: string[];
  datasets?: DatasetEntry[];
  selectedGids?: string[];
  projectHistory?: Record<string, ProjectHistoryState>;
  projectDrafts?: Record<string, Record<string, DraftPatch>>;
  currentView?: ViewState;
  subView?: string;
}

function cloneSpec(spec: FigureSpec): FigureSpec {
  return JSON.parse(JSON.stringify(spec)) as FigureSpec;
}

function cloneEditLog(editLog: EditEntry[]): EditEntry[] {
  return JSON.parse(JSON.stringify(editLog || [])) as EditEntry[];
}

function makeHistorySnapshot(editLog: EditEntry[], label: string, script?: string): HistorySnapshot {
  return {
    editLog: cloneEditLog(editLog),
    script,
    label,
    timestamp: Date.now(),
  };
}

function normalizeHistorySnapshot(value: unknown, fallbackLabel: string): HistorySnapshot {
  if (Array.isArray(value)) {
    return makeHistorySnapshot(value as EditEntry[], fallbackLabel);
  }
  const candidate = value as Partial<HistorySnapshot> | null;
  if (candidate && Array.isArray(candidate.editLog)) {
    return {
      editLog: cloneEditLog(candidate.editLog),
      script: typeof candidate.script === 'string' ? candidate.script : undefined,
      label: typeof candidate.label === 'string' && candidate.label ? candidate.label : fallbackLabel,
      timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now(),
    };
  }
  return makeHistorySnapshot([], fallbackLabel);
}

function normalizeProjectHistory(raw: unknown): Record<string, ProjectHistoryState> {
  const result: Record<string, ProjectHistoryState> = {};
  if (!raw || typeof raw !== 'object') return result;
  Object.entries(raw as Record<string, any>).forEach(([figureId, value]) => {
    const pastRaw = Array.isArray(value?.past) ? value.past : [];
    const futureRaw = Array.isArray(value?.future) ? value.future : [];
    result[figureId] = {
      past: pastRaw.map((entry: unknown, index: number) => normalizeHistorySnapshot(entry, index === 0 ? '初始图' : `历史步骤 ${index}`)),
      future: futureRaw.map((entry: unknown, index: number) => normalizeHistorySnapshot(entry, `重做步骤 ${index + 1}`)),
    };
  });
  return result;
}

function loadInitialState(): PersistedAppState {
  if (typeof window === 'undefined') {
    return {
      spec: cloneSpec(defaultSpec),
      history: [cloneSpec(defaultSpec)],
      historyIndex: 0,
      projectId: null,
      projectName: '未命名项目',
      figSession: null,
      renderLog: ['> 日志待机中... 点击"同步至引擎并预览 SVG"开始渲染'],
      currentView: 'home',
      subView: 'home',
    };
  }

  try {
    const raw = window.sessionStorage.getItem(SPEC_STORAGE_KEY);
    if (!raw) throw new Error('missing session');
    const parsed = JSON.parse(raw) as Partial<PersistedAppState>;
    const parsedSpec = parsed.spec ? cloneSpec(parsed.spec) : cloneSpec(defaultSpec);
    const parsedHistory = Array.isArray(parsed.history) && parsed.history.length > 0
      ? parsed.history.map(cloneSpec)
      : [cloneSpec(parsedSpec)];
    const nextIndex = typeof parsed.historyIndex === 'number'
      ? Math.max(0, Math.min(parsed.historyIndex, parsedHistory.length - 1))
      : parsedHistory.length - 1;

    return {
      spec: parsedSpec,
      history: parsedHistory,
      historyIndex: nextIndex,
      projectId: parsed.projectId ?? null,
      projectName: parsed.projectName ?? '未命名项目',
      figSession: parsed.figSession ?? null,
      renderLog: parsed.renderLog?.length ? parsed.renderLog : ['> 日志待机中... 点击"同步至引擎并预览 SVG"开始渲染'],
      projectFigures: parsed.projectFigures ?? {},
      activeFigureId: parsed.activeFigureId ?? 'fig_1',
      datasets: parsed.datasets ?? [],
      selectedGids: parsed.selectedGids ?? [],
      projectHistory: normalizeProjectHistory(parsed.projectHistory),
      currentView: parsed.currentView ?? 'home',
      subView: parsed.subView ?? 'home',
    };
  } catch {
    return {
      spec: cloneSpec(defaultSpec),
      history: [cloneSpec(defaultSpec)],
      historyIndex: 0,
      projectId: null,
      projectName: '未命名项目',
      figSession: null,
      renderLog: ['> 日志待机中... 点击"同步至引擎并预览 SVG"开始渲染'],
      projectFigures: {},
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'home',
      subView: 'home',
    };
  }
}

export default function App() {
  const initialState = useMemo(() => loadInitialState(), []);
  const hasRestoredProjectFiguresRef = useRef(false);
  const [spec, setSpec] = useState<FigureSpec>(initialState.spec);
  const [currentView, setCurrentView] = useState<ViewState>(initialState.currentView ?? 'home');
  const [subView, setSubView] = useState<string>(initialState.subView ?? 'home');
  const [selectedObject, setSelectedObject] = useState<string>('Figure');
  const [projectId, setProjectId] = useState<string | null>(initialState.projectId);
  const [projectName, setProjectName] = useState<string>(initialState.projectName);
  const [specHistory, setSpecHistory] = useState<FigureSpec[]>(initialState.history);
  const [historyIndex, setHistoryIndex] = useState<number>(initialState.historyIndex);
  const [lockedObjects, setLockedObjects] = useState<Set<string>>(new Set());
  const [selectedGids, setSelectedGids] = useState<string[]>(initialState.selectedGids ?? []);
  const [projectHistory, setProjectHistory] = useState<Record<string, ProjectHistoryState>>(initialState.projectHistory ?? {});

  const handleSelectGids = (gids: string[]) => {
    setSelectedGids(gids);
    setSelectedObject(gids.length === 0 ? 'Figure' : gids[0]);
  };

  const handleSelectObject = (obj: string) => {
    setSelectedObject(obj);
    setSelectedGids(obj === 'Figure' ? [] : [obj]);
  };

  // V3.2A Project Layer States
  const [projectFigures, setProjectFigures] = useState<Record<string, FigureEntry>>(initialState.projectFigures ?? {});
  const [activeFigureId, setActiveFigureId] = useState<string>(initialState.activeFigureId ?? 'fig_1');
  const [selectedFigureIds, setSelectedFigureIds] = useState<string[]>(initialState.selectedFigureIds ?? []);
  const [datasets, setDatasets] = useState<DatasetEntry[]>(initialState.datasets ?? []);
  const [activeResourceFile, setActiveResourceFile] = useState<string>('figure_spec.json');

  const handleToggleLock = (gid: string) => {
    setLockedObjects(prev => {
      const next = new Set(prev);
      if (next.has(gid)) {
        next.delete(gid);
      } else {
        next.add(gid);
      }
      return next;
    });
  };
  
  const {
    session: hookSession,
    isRendering,
    renderError,
    renderTraceback,
    canUndoFigure,
    canRedoFigure,
    render,
    patch,
    codePatch,
    undoFigureEdit,
    redoFigureEdit,
    reset,
  } = useFigureSession(initialState.figSession);
  const [renderLog, setRenderLog] = useState<string[]>(initialState.renderLog);
  const [projectIsRendering, setProjectIsRendering] = useState(false);
  const [renderProgressText, setRenderProgressText] = useState<string | null>(null);
  const latestRequestIdByFigure = useRef<Record<string, string>>({});

  const [projectDrafts, setProjectDrafts] = useState<Record<string, Record<string, DraftPatch>>>(initialState.projectDrafts ?? {});

  const handleUpdateDraft = (figId: string, patch: DraftPatch) => {
    setProjectDrafts(prev => {
      const figBucket = { ...(prev[figId] || {}) };
      const key = `${patch.gid}:${patch.prop}`;
      figBucket[key] = patch;
      return { ...prev, [figId]: figBucket };
    });
  };

  const handleUpdateDraftsBatch = (figId: string, patches: DraftPatch[]) => {
    setProjectDrafts(prev => {
      const figBucket = { ...(prev[figId] || {}) };
      patches.forEach(p => {
        const key = `${p.gid}:${p.prop}`;
        figBucket[key] = p;
      });
      return { ...prev, [figId]: figBucket };
    });
  };

  const handleDiscardDraft = (figId: string) => {
    setProjectDrafts(prev => {
      const next = { ...prev };
      delete next[figId];
      return next;
    });
  };

  // Virtual active session wrapper for project mode
  const activeFig = projectId && projectFigures[activeFigureId] ? projectFigures[activeFigureId] : null;
  const activeProjectHistory = projectId ? projectHistory[activeFigureId] : null;
  const canUndoActiveFigure = projectId ? Boolean(activeProjectHistory?.past?.length || activeFig?.editLog?.length) : canUndoFigure;
  const canRedoActiveFigure = projectId ? Boolean(activeProjectHistory?.future?.length) : canRedoFigure;
  
  const figSession: FigureSession | null = useMemo(() => {
    if (projectId) {
      if (!activeFig) return null;
      
      const figDrafts = (projectDrafts[activeFigureId] || {}) as Record<string, DraftPatch>;
      const localPatches = Object.values(figDrafts)
        .filter(d => d.mode === 'local_patch')
        .map(d => ({ gid: d.gid, prop: d.prop, value: d.value }));

      let previewSvg = activeFig.svg || '';
      let previewManifest = activeFig.manifest || { objects: [], palettes: [], groups: [], bindings: [] };
      if (localPatches.length > 0) {
        previewSvg = applyRuntimePatchesToSvg(activeFig.svg || '', localPatches);
        previewManifest = applyRuntimePatchesToManifest(activeFig.manifest || null, localPatches) || previewManifest;
      }

      return {
        sessionId: `${projectId}_${activeFigureId}`,
        script: spec.custom_script || '',
        language: spec.script_language || 'python',
        dataPayload: { datasets } as any,
        editLog: activeFig.editLog,
        revision: activeFig.revision,
        svg: previewSvg,
        manifest: previewManifest,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }
    return hookSession;
  }, [projectId, activeFig, activeFigureId, projectDrafts, spec.custom_script, spec.script_language, datasets, hookSession]);

  useEffect(() => {
    const availableFigureIds = new Set(Object.keys(projectFigures));
    setSelectedFigureIds(prev => prev.filter(figId => availableFigureIds.has(figId)));
  }, [projectFigures]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Strip heavy svg from projectFigures for session storage
    const serializedFigures: Record<string, any> = {};
    if (projectFigures) {
      Object.entries(projectFigures as Record<string, any>).forEach(([id, fig]) => {
        serializedFigures[id] = {
          figureId: fig.figureId,
          index: fig.index,
          manifest: fig.manifest,
          editLog: fig.editLog,
          revision: fig.revision,
          fingerprint: (fig as any).fingerprint,
          codeSlice: fig.codeSlice ?? null,
        };
      });
    }

    const nextState: PersistedAppState = {
      spec,
      history: specHistory,
      historyIndex,
      projectId,
      projectName,
      figSession: hookSession,
      renderLog,
      projectFigures: serializedFigures as any,
      activeFigureId,
      selectedFigureIds,
      datasets,
      selectedGids,
      projectHistory,
      currentView,
      subView,
    };
    window.sessionStorage.setItem(SPEC_STORAGE_KEY, JSON.stringify(nextState));
  }, [spec, specHistory, historyIndex, projectId, projectName, hookSession, renderLog, projectFigures, activeFigureId, selectedFigureIds, datasets, selectedGids, projectHistory, currentView, subView]);

  // Auto-rebuild project figures on mount/refresh if SVGs are missing
  useEffect(() => {
    const figsArray = Object.values(projectFigures as Record<string, any>);
    if (projectId && figsArray.length > 0 && !figsArray[0].svg) {
      if (hasRestoredProjectFiguresRef.current) return;
      hasRestoredProjectFiguresRef.current = true;
      const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      
      const figIds = Object.keys(projectFigures);
      figIds.forEach(fid => {
        latestRequestIdByFigure.current[fid] = reqId;
      });
      setProjectFigures(prev => {
        const next = { ...prev };
        figIds.forEach(fid => {
          if (next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'rendering',
              error: undefined
            };
          }
        });
        return next;
      });
      setProjectIsRendering(true);
      setRenderProgressText('正在恢复项目预览：读取服务端编辑历史并重建 SVG...');

      (async () => {
        try {
          const latestProjectRes = await fetch(`/api/projects/${projectId}`);
          const latestProject = await latestProjectRes.json();
          const latestFigures = latestProject.status === 'success' ? (latestProject.project?.figures || []) : [];
          const latestScript = latestProject.status === 'success'
            ? (latestProject.project?.script || spec.custom_script || '')
            : (spec.custom_script || '');
          const renderScript = spec.plot_type === 'custom'
            ? (latestScript || buildReproduciblePython(spec))
            : buildReproduciblePython(spec);
          if (!renderScript) return;

          const editLogs: Record<string, any[]> = {};
          if (latestFigures.length > 0) {
            latestFigures.forEach((fig: any) => {
              editLogs[fig.figureId] = fig.editLog || [];
            });
          } else {
            Object.keys(projectFigures).forEach(figId => {
              editLogs[figId] = projectFigures[figId]?.editLog || [];
            });
          }

          const renderRes = await fetch(`/api/projects/${projectId}/figures/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script: renderScript, editLogs, language: spec.script_language || 'python', requestId: reqId })
          });
          const data = await renderRes.json();
          
          setProjectFigures(prev => {
            const next = { ...prev };
            const returnedFigs = data.figures || [];
            
            figIds.forEach(fid => {
              if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                const matched = returnedFigs.find((rf: any) => rf.figureId === fid);
                if (matched && data.status === 'success') {
                  next[fid] = {
                    ...next[fid],
                    svg: matched.svg,
                    manifest: matched.manifest,
                    editLog: editLogs[fid] || [],
                    revision: projectFigures[fid]?.revision || 1,
                    fingerprint: matched.fingerprint,
                    codeSlice: matched.codeSlice ?? null,
                    renderStatus: 'success',
                    error: undefined
                  };
                } else {
                  next[fid] = {
                    ...next[fid],
                    renderStatus: 'error',
                    error: data.message || '恢复失败'
                  };
                }
              }
            });
            return next;
          });
          
          if (data.status === 'success') {
            setRenderLog((prev: string[]) => [...prev, `> [自动] 已从服务端编辑历史重建项目多图预览`]);
          }
        } catch (err: any) {
          console.error('Auto render failed:', err);
          setProjectFigures(prev => {
            const next = { ...prev };
            figIds.forEach(fid => {
              if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                next[fid] = {
                  ...next[fid],
                  renderStatus: 'error',
                  error: err.message || '网络异常'
                };
              }
            });
            return next;
          });
        } finally {
          if (latestRequestIdByFigure.current[activeFigureId] === reqId) {
            setProjectIsRendering(false);
            setRenderProgressText(null);
          }
        }
      })();
    }
  }, [projectId]);

  const applySpecChange = (nextSpec: FigureSpec, options?: { recordHistory?: boolean }) => {
    const recordHistory = options?.recordHistory !== false;
    const clonedSpec = cloneSpec(nextSpec);
    setSpec(clonedSpec);

    if (recordHistory) {
      setSpecHistory(prev => {
        const next = prev.slice(0, historyIndex + 1);
        next.push(clonedSpec);
        return next;
      });
      setHistoryIndex(prev => prev + 1);
    }
  };

  const handlePatch = async (patches: PatchEntry[]) => {
    const figureId = projectId ? activeFigureId : 'fig_1';
    const draftPatches = patches.map((patch: any) => {
      const gid = patch.gid || 'code_patch';
      const prop = patch.prop || patch.target_id || '';
      return {
        gid,
        prop,
        value: patch.value !== undefined ? patch.value : patch.new_value,
        mode: patch.mode || 'backend_patch',
        type: patch.type,
        target_id: patch.target_id,
        new_value: patch.new_value,
        gids: patch.gids,
      };
    });
    handleUpdateDraftsBatch(figureId, draftPatches);
    return {
      status: 'success' as const,
      sessionId: `${projectId || 'project'}_${figureId}`,
      applied: patches,
    };
  };

  const executeSingleFigurePatch = async (targetFigureId: string, patches: any[]) => {
    const needsBackendRender = patches.some((patchItem: any) => patchItem.type === 'code_patch' || patchItem.mode !== 'local_patch');
    const patchSummary = patches.length === 1
      ? `${(patches[0] as any).gid || (patches[0] as any).target_id || '对象'} / ${(patches[0] as any).prop || '代码'}`
      : `${patches.length} 个参数`;

    if (projectId) {
      const prevEditLog = projectFigures[targetFigureId]?.editLog || [];
      const localPatchTimestamp = Date.now();
      const localPatchEntries = patches
        .filter((patchItem: any) => patchItem.mode === 'local_patch' && patchItem.gid && patchItem.prop)
        .map((patchItem: any) => ({
          gid: patchItem.gid,
          prop: patchItem.prop,
          value: patchItem.value,
          mode: patchItem.mode as any,
          timestamp: localPatchTimestamp,
        }));

      if (!needsBackendRender && localPatchEntries.length > 0) {
        setProjectFigures(prev => {
          const active = prev[targetFigureId];
          if (!active) return prev;
          const runtimePatches = localPatchEntries.map(({ gid, prop, value }) => ({ gid, prop, value }));
          return {
            ...prev,
            [targetFigureId]: {
              ...active,
              svg: applyRuntimePatchesToSvg(active.svg || '', runtimePatches),
              manifest: applyRuntimePatchesToManifest(active.manifest || null, runtimePatches) || active.manifest,
              editLog: [...(active.editLog || []), ...localPatchEntries],
              revision: active.revision || 1,
            },
          };
        });
        pushProjectHistory(targetFigureId, prevEditLog, patchSummary);
      }

      const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      latestRequestIdByFigure.current[targetFigureId] = reqId;

      try {
        if (needsBackendRender) {
          setProjectFigures(prev => {
            const next = { ...prev };
            if (next[targetFigureId]) {
              next[targetFigureId] = {
                ...next[targetFigureId],
                renderStatus: 'rendering',
                error: undefined
              };
            }
            return next;
          });
          setProjectIsRendering(true);
          setRenderProgressText(`正在应用 ${patchSummary}：重放并重新渲染...`);
          setRenderLog(prev => [...prev, `> [应用] ${targetFigureId} 正在重渲染 ${patchSummary}...`]);
        }
        
        const res = await fetch('/api/figure/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: `${projectId}_${targetFigureId}`,
            projectId,
            figureId: targetFigureId,
            patches,
            requestId: reqId,
            baseRevision: projectFigures[targetFigureId]?.revision || 1,
          })
        });
        const data = await res.json();
        
        if (reqId !== latestRequestIdByFigure.current[targetFigureId]) {
          return;
        }

        if (data.status === 'success') {
          if (needsBackendRender) {
            setRenderLog(prev => [...prev, `> [完成] ${targetFigureId} 参数已应用，预览已更新`]);
          }
          setProjectFigures(prev => {
            const next = { ...prev };
            const active = next[targetFigureId];
            if (active) {
              if (data.revision !== undefined && data.revision < active.revision) {
                return prev;
              }
              next[targetFigureId] = {
                ...active,
                svg: data.svg || active.svg,
                manifest: data.manifest || active.manifest,
                editLog: data.editLog || active.editLog,
                revision: data.revision || active.revision,
                codeSlice: data.codeSlice ?? active.codeSlice ?? null,
                renderStatus: 'success',
                error: undefined
              };
            }
            return next;
          });

          // Record history snapshot
          if (needsBackendRender) {
            pushProjectHistory(targetFigureId, prevEditLog, patchSummary);
          }

          // Handle color mapping update inside spec for AST sync
          const codePatches = patches.filter((p: any) => p.type === 'code_patch');
          if (codePatches.length > 0) {
            const nextSpec = cloneSpec(spec);
            if (!nextSpec.colors) nextSpec.colors = {};
            codePatches.forEach((cp: any) => {
              const palettes = projectFigures[targetFigureId]?.manifest?.palettes || [];
              const palette = palettes.find(pl => pl.id === cp.target_id);
              if (palette && palette.label) {
                nextSpec.colors[palette.label] = cp.new_value as string;
              }
            });
            if (data.script) {
              nextSpec.custom_script = data.script;
            }
            applySpecChange(nextSpec);
          }
        } else {
          setProjectFigures(prev => {
            const next = { ...prev };
            if (next[targetFigureId]) {
              next[targetFigureId] = {
                ...next[targetFigureId],
                renderStatus: 'error',
                error: data.message || '应用失败'
              };
            }
            return next;
          });
          setRenderLog(prev => [...prev, `> [错误] ${targetFigureId} 应用失败: ${data.message}`]);
        }
      } catch (err: any) {
        setProjectFigures(prev => {
          const next = { ...prev };
          if (next[targetFigureId]) {
            next[targetFigureId] = {
              ...next[targetFigureId],
              renderStatus: 'error',
              error: err.message || '网络异常'
            };
          }
          return next;
        });
        setRenderLog(prev => [...prev, `> [异常] ${targetFigureId} 应用异常: ${err.message}`]);
      } finally {
        if (latestRequestIdByFigure.current[targetFigureId] === reqId) {
          setProjectIsRendering(false);
          setRenderProgressText(null);
        }
      }
    } else {
      // Single figure mode fallback
      if (needsBackendRender) {
        setRenderProgressText(`正在应用 ${patchSummary}：生成新预览...`);
        setRenderLog(prev => [...prev, `> [应用] 正在重渲染 ${patchSummary}...`]);
      }
      try {
        const res = await patch(patches);
        if (res.status === 'success') {
          if (needsBackendRender) {
            setRenderLog(prev => [...prev, `> [完成] 参数已应用，预览已更新`]);
          }
          const codePatches = patches.filter((p: any) => p.type === 'code_patch');
          if (codePatches.length > 0) {
            const nextSpec = cloneSpec(spec);
            if (!nextSpec.colors) nextSpec.colors = {};
            codePatches.forEach((cp: any) => {
              const palettes = figSession?.manifest?.palettes || [];
              const palette = palettes.find(p => p.id === cp.target_id);
              if (palette && palette.label) {
                nextSpec.colors[palette.label] = cp.new_value as string;
              }
            });
            if (res.script) {
              nextSpec.custom_script = res.script;
            }
            applySpecChange(nextSpec);
          }
        }
      } finally {
        if (needsBackendRender) {
          setRenderProgressText(null);
        }
      }
    }
  };

  const handleApplyDraft = async (figId: string, scope: 'current' | 'all' | 'selected') => {
    let targetIds: string[] = [];
    if (scope === 'current') {
      targetIds = [figId];
    } else if (scope === 'selected') {
      targetIds = projectId
        ? selectedFigureIds.filter(targetId => projectFigures[targetId])
        : [figId];
    } else if (scope === 'all') {
      targetIds = projectId ? Object.keys(projectFigures) : [figId];
    }

    if (targetIds.length === 0) {
      setRenderLog(prev => [
        ...prev,
        `> [提示] 请先在 Figure 切换条中勾选要应用的目标图。`
      ]);
      return;
    }

    const draftSourceBucket = (projectDrafts[figId] || {}) as Record<string, DraftPatch>;
    const patches = Object.values(draftSourceBucket).map(d => {
      if (d.type === 'code_patch') {
        return {
          type: 'code_patch' as const,
          target_id: d.target_id!,
          new_value: d.new_value!,
          gids: d.gids || []
        };
      }
      return {
        op: 'set' as const,
        mode: d.mode,
        gid: d.gid,
        prop: d.prop,
        value: d.value
      };
    });

    if (patches.length === 0) return;

    const sourceManifest = projectFigures[figId]?.manifest || null;
    const skippedByTarget: Record<string, number> = {};
    const targetPatchJobs = targetIds
      .map((targetId) => {
        if (scope === 'current' || targetId === figId) {
          const currentPatches = scope === 'current'
            ? patches
            : patches.filter((patch: any) => patch.type !== 'code_patch' && patch.gid !== 'code_patch');
          skippedByTarget[targetId] = patches.length - currentPatches.length;
          return { targetId, patches: currentPatches };
        }

        const targetManifest = projectFigures[targetId]?.manifest || null;
        const { patches: mappedPatches, skipped } = mapPatchesToTargetFigure(patches, sourceManifest, targetManifest);
        skippedByTarget[targetId] = skipped.length;
        return { targetId, patches: mappedPatches };
      })
      .filter(job => job.patches.length > 0);

    if (targetPatchJobs.length === 0) {
      setRenderLog(prev => [
        ...prev,
        `> [提示] 没有可安全跨图应用的暂存修改：code_patch 或无法匹配的图元已跳过。`
      ]);
      return;
    }

    if (scope !== 'current') {
      const skippedTotal = Object.values(skippedByTarget).reduce((sum, count) => sum + count, 0);
      setRenderLog(prev => [
        ...prev,
        `> [跨图应用] 已按语义映射准备 ${targetPatchJobs.length} 张图；跳过 ${skippedTotal} 项无法安全映射或 code_patch 修改。`
      ]);
    }

    // Clear drafts for all target figures first
    setProjectDrafts(prev => {
      const next = { ...prev };
      delete next[figId];
      return next;
    });

    const concurrency = 3;
    const queue = [...targetPatchJobs];

    const executeNext = async (): Promise<void> => {
      if (queue.length === 0) return;
      const nextJob = queue.shift()!;
      try {
        await executeSingleFigurePatch(nextJob.targetId, nextJob.patches);
      } catch (err) {
        console.error(`Failed to apply patches to ${nextJob.targetId}:`, err);
      }
      return executeNext();
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, targetPatchJobs.length); i++) {
      workers.push(executeNext());
    }
    await Promise.all(workers);
  };

  const handleImmediatePatch = async (patches: PatchEntry[]) => {
    const figureId = projectId ? activeFigureId : 'fig_1';
    await executeSingleFigurePatch(figureId, patches);
    return { status: 'success' as const, sessionId: `${projectId || 'project'}_${figureId}`, applied: patches };
  };

  const handleCodePatch = async (script: string, force?: boolean) => {
    if (projectId) {
      const targetFigureId = activeFigureId;
      const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      latestRequestIdByFigure.current[targetFigureId] = reqId;

      try {
        setProjectFigures(prev => {
          const next = { ...prev };
          if (next[targetFigureId]) {
            next[targetFigureId] = {
              ...next[targetFigureId],
              renderStatus: 'rendering',
              error: undefined
            };
          }
          return next;
        });
        setProjectIsRendering(true);
        setRenderProgressText('正在应用代码修改：校验脚本、检测漂移并重新渲染...');
        setRenderLog(prev => [...prev, `> [代码补丁] 正在校验并重渲染 ${targetFigureId}...`]);
        const res = await fetch('/api/figure/code-patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: `${projectId}_${targetFigureId}`,
            projectId,
            figureId: targetFigureId,
            script,
            force,
            requestId: reqId
          })
        });
        const data = await res.json();
        
        if (reqId !== latestRequestIdByFigure.current[targetFigureId]) {
          return data;
        }

        if (data.status === 'success') {
          setProjectFigures(prev => {
            const next = { ...prev };
            const active = next[targetFigureId];
            if (active) {
              if (data.revision !== undefined && data.revision < active.revision) {
                return prev;
              }
              next[targetFigureId] = {
                ...active,
                svg: data.svg || active.svg,
                manifest: data.manifest || active.manifest,
                editLog: data.editLog || active.editLog,
                revision: data.revision || active.revision + 1,
                codeSlice: data.codeSlice ?? active.codeSlice ?? null,
                renderStatus: 'success',
                error: undefined
              };
            }
            return next;
          });

          const nextSpec = cloneSpec(spec);
          nextSpec.custom_script = script;
          if (data.manifest?.palettes) {
            nextSpec.colors = { ...nextSpec.colors };
            data.manifest.palettes.forEach((p: any) => {
              if (p.label) {
                nextSpec.colors[p.label] = p.color;
              }
            });
          }
          applySpecChange(nextSpec);
        } else {
          setProjectFigures(prev => {
            const next = { ...prev };
            if (next[targetFigureId]) {
              next[targetFigureId] = {
                ...next[targetFigureId],
                renderStatus: 'error',
                error: data.message || '代码补丁应用失败'
              };
            }
            return next;
          });
          setRenderLog(prev => [...prev, `> [代码错误] ${data.message || '未知错误'}`]);
        }
        return data;
      } catch (err: any) {
        if (reqId === latestRequestIdByFigure.current[targetFigureId]) {
          setProjectFigures(prev => {
            const next = { ...prev };
            if (next[targetFigureId]) {
              next[targetFigureId] = {
                ...next[targetFigureId],
                renderStatus: 'error',
                error: err.message || '网络异常'
              };
            }
            return next;
          });
          setRenderLog(prev => [...prev, `> [代码异常] ${err.message}`]);
        }
        return { status: 'error', message: err.message };
      } finally {
        if (reqId === latestRequestIdByFigure.current[targetFigureId]) {
          setProjectIsRendering(false);
          setRenderProgressText(null);
        }
      }
    } else {
      setRenderProgressText('正在应用代码修改：校验脚本、检测漂移并重新渲染...');
      const res = await codePatch(script, force);
      setRenderProgressText(null);
      if (res.status === 'success') {
        const nextSpec = cloneSpec(spec);
        nextSpec.custom_script = script;
        if (res.manifest?.palettes) {
          nextSpec.colors = { ...nextSpec.colors };
          res.manifest.palettes.forEach((p: any) => {
            if (p.label) {
              nextSpec.colors[p.label] = p.color;
            }
          });
        }
        applySpecChange(nextSpec);
      }
      return res;
    }
  };

  const rerenderProjectWithEditLogs = async (editLogs: Record<string, any[]>, scriptOverride?: string): Promise<void> => {
    if (!projectId) return;
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const figIds = Object.keys(projectFigures);
    figIds.forEach(fid => {
      latestRequestIdByFigure.current[fid] = reqId;
    });
    setProjectFigures(prev => {
      const next = { ...prev };
      figIds.forEach(fid => {
        if (next[fid]) {
          next[fid] = {
            ...next[fid],
            renderStatus: 'rendering',
            error: undefined
          };
        }
      });
      return next;
    });

    try {
      const scriptToReplay = scriptOverride ?? spec.custom_script ?? '';
      setProjectIsRendering(true);
      setRenderProgressText('正在撤销/重做：重放当前项目编辑历史并刷新 SVG...');
      setRenderLog(prev => [...prev, `> [历史] 正在重放项目编辑历史...`]);
      const res = await fetch(`/api/projects/${projectId}/figures/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: scriptToReplay, editLogs, language: spec.script_language || 'python', requestId: reqId })
      });
      const data = await res.json();
      
      setProjectFigures(prev => {
        const next = { ...prev };
        const returnedFigs = data.figures || [];
        
        figIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            const matched = returnedFigs.find((rf: any) => rf.figureId === fid);
            if (matched && data.status === 'success') {
              next[fid] = {
                ...next[fid],
                svg: matched.svg,
                manifest: matched.manifest,
                editLog: matched.editLog || editLogs[fid] || next[fid]?.editLog || [],
                revision: matched.revision || next[fid]?.revision || 1,
                fingerprint: matched.fingerprint,
                codeSlice: matched.codeSlice ?? next[fid]?.codeSlice ?? null,
                renderStatus: 'success',
                error: undefined
              };
            } else {
              next[fid] = {
                ...next[fid],
                renderStatus: 'error',
                error: data.message || '重放失败'
              };
            }
          }
        });
        return next;
      });

      if (data.status === 'success') {
        if (scriptOverride !== undefined && scriptOverride !== spec.custom_script) {
          const nextSpec = cloneSpec(spec);
          nextSpec.custom_script = scriptOverride;
          applySpecChange(nextSpec, { recordHistory: false });
        }
        setRenderLog(prev => [...prev, `> [历史] 撤销/重做已应用，预览已刷新`]);
      }
    } catch (err: any) {
      setRenderLog(prev => [...prev, `> [历史异常] ${err.message || '重放失败'}`]);
      setProjectFigures(prev => {
        const next = { ...prev };
        figIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'error',
              error: err.message || '网络异常'
            };
          }
        });
        return next;
      });
    } finally {
      if (latestRequestIdByFigure.current[activeFigureId] === reqId) {
        setProjectIsRendering(false);
        setRenderProgressText(null);
      }
    }
  };

  const handleProjectUndo = async (figureId: string) => {
    const history = projectHistory[figureId];
    const currentEditLog = projectFigures[figureId]?.editLog || [];
    const currentScript = spec.custom_script || '';
    if (currentEditLog.length === 0 && !history?.past?.length) return;

    let prevSnapshot: HistorySnapshot;
    let nextPast: HistorySnapshot[];
    let nextFuture: HistorySnapshot[];

    if (history?.past?.length) {
      prevSnapshot = history.past[history.past.length - 1];
      nextPast = history.past.slice(0, -1);
      nextFuture = [makeHistorySnapshot(currentEditLog, '撤销前状态', currentScript), ...history.future];
    } else {
      const lastTimestamp = currentEditLog[currentEditLog.length - 1]?.timestamp;
      const fallbackIndex = lastTimestamp == null
        ? currentEditLog.length - 1
        : currentEditLog.findIndex(entry => entry.timestamp === lastTimestamp);
      prevSnapshot = makeHistorySnapshot(currentEditLog.slice(0, Math.max(0, fallbackIndex)), '撤销上一步', currentScript);
      nextPast = [];
      nextFuture = [makeHistorySnapshot(currentEditLog, '撤销前状态', currentScript)];
    }

    setProjectHistory(prev => ({ ...prev, [figureId]: { past: nextPast, future: nextFuture } }));
    setProjectFigures(prev => {
      const fig = prev[figureId];
      if (!fig) return prev;
      return { ...prev, [figureId]: { ...fig, editLog: prevSnapshot.editLog } };
    });
    const editLogs: Record<string, any[]> = {};
    Object.keys(projectFigures).forEach(fid => {
      editLogs[fid] = fid === figureId ? prevSnapshot.editLog : projectFigures[fid].editLog;
    });
    await rerenderProjectWithEditLogs(editLogs, prevSnapshot.script);
  };

  const handleProjectRedo = async (figureId: string) => {
    const history = projectHistory[figureId];
    if (!history || history.future.length === 0) return;
    const currentEditLog = projectFigures[figureId]?.editLog || [];
    const currentScript = spec.custom_script || '';
    const nextSnapshot = history.future[0];
    const nextPast = [...history.past, makeHistorySnapshot(currentEditLog, '重做前状态', currentScript)];
    const nextFuture = history.future.slice(1);
    setProjectHistory(prev => ({ ...prev, [figureId]: { past: nextPast, future: nextFuture } }));
    setProjectFigures(prev => {
      const fig = prev[figureId];
      if (!fig) return prev;
      return { ...prev, [figureId]: { ...fig, editLog: nextSnapshot.editLog } };
    });
    const editLogs: Record<string, any[]> = {};
    Object.keys(projectFigures).forEach(fid => {
      editLogs[fid] = fid === figureId ? nextSnapshot.editLog : projectFigures[fid].editLog;
    });
    await rerenderProjectWithEditLogs(editLogs, nextSnapshot.script);
  };

  // Call after each successful patch in project mode to record history
  const MAX_HISTORY = 50;
  const pushProjectHistory = (figureId: string, prevEditLog: EditEntry[], label: string) => {
    setProjectHistory(prev => {
      const entry = prev[figureId] || { past: [], future: [] };
      const snapshot = makeHistorySnapshot(
        prevEditLog,
        entry.past.length === 0 && prevEditLog.length === 0 ? '初始图' : label,
        spec.custom_script || ''
      );
      return {
        ...prev,
        [figureId]: {
          past: [...entry.past, snapshot].slice(-MAX_HISTORY),
          future: []
        }
      };
    });
  };

  const handleProjectHistoryJump = async (figureId: string, targetIndex: number) => {
    const history = projectHistory[figureId] || { past: [], future: [] };
    const currentEditLog = projectFigures[figureId]?.editLog || [];
    const currentSnapshot = makeHistorySnapshot(currentEditLog, '当前状态', spec.custom_script || '');
    const currentIndex = history.past.length;
    const timeline = [...history.past, currentSnapshot, ...history.future];
    const targetSnapshot = timeline[targetIndex];
    if (!targetSnapshot || targetIndex === currentIndex) return;

    const nextPast = timeline.slice(0, targetIndex);
    const nextFuture = timeline.slice(targetIndex + 1);
    setProjectHistory(prev => ({ ...prev, [figureId]: { past: nextPast, future: nextFuture } }));
    setProjectFigures(prev => {
      const fig = prev[figureId];
      if (!fig) return prev;
      return { ...prev, [figureId]: { ...fig, editLog: targetSnapshot.editLog } };
    });
    const editLogs: Record<string, any[]> = {};
    Object.keys(projectFigures).forEach(fid => {
      editLogs[fid] = fid === figureId ? targetSnapshot.editLog : projectFigures[fid].editLog;
    });
    await rerenderProjectWithEditLogs(editLogs, targetSnapshot.script);
  };

  const handleUndo = async () => {
    if (projectId) {
      await handleProjectUndo(activeFigureId);
      return;
    }
    if (historyIndex > 0) {
      const prevSpec = specHistory[historyIndex - 1];
      setHistoryIndex(prev => prev - 1);
      setSpec(cloneSpec(prevSpec));

      const payload = prevSpec.raw_data?.custom_data
        ? { custom_data: prevSpec.raw_data.custom_data }
        : null;

      if (prevSpec.plot_type === 'custom' && prevSpec.custom_script) {
        void render(prevSpec.custom_script, payload, undefined, prevSpec.script_language || 'python');
      }
    } else {
      await undoFigureEdit();
    }
  };

  const handleRedo = async () => {
    if (projectId) {
      await handleProjectRedo(activeFigureId);
      return;
    }
    if (historyIndex < specHistory.length - 1) {
      const nextSpec = specHistory[historyIndex + 1];
      setHistoryIndex(prev => prev + 1);
      setSpec(cloneSpec(nextSpec));

      const payload = nextSpec.raw_data?.custom_data
        ? { custom_data: nextSpec.raw_data.custom_data }
        : null;

      if (nextSpec.plot_type === 'custom' && nextSpec.custom_script) {
        void render(nextSpec.custom_script, payload, undefined, nextSpec.script_language || 'python');
      }
    } else {
      await redoFigureEdit();
    }
  };

  const handleLoadProject = (id: string, name: string, projectData: any) => {
    const loadedSpec: FigureSpec = typeof projectData.spec === 'string' ? JSON.parse(projectData.spec) : projectData.spec;
    const cleanSpec = { ...loadedSpec };
    cleanSpec.custom_script = projectData.script || loadedSpec.custom_script || '';

    setProjectId(id);
    setProjectName(name);
    setSpec(cleanSpec);
    setSpecHistory([cloneSpec(cleanSpec)]);
    setHistoryIndex(0);
    reset();

    // Set project datasets
    setDatasets(projectData.datasets || []);

    // Set project figures
    const nextFigs: Record<string, FigureEntry> = {};
    const figList = projectData.figures || [];
    figList.forEach((f: any) => {
      nextFigs[f.figureId] = {
        figureId: f.figureId,
        index: f.index,
        manifest: f.manifest || null,
        editLog: f.editLog || [],
        revision: f.revision || 1,
        fingerprint: f.fingerprint,
        codeSlice: f.codeSlice ?? null,
      };
    });
    setProjectFigures(nextFigs);

    if (figList.length > 0) {
      setActiveFigureId(figList[0].figureId);
    } else {
      setActiveFigureId('fig_1');
    }

    const initialEditLogs: Record<string, any[]> = {};
    const initialRevisions: Record<string, number> = {};
    figList.forEach((f: any) => {
      initialEditLogs[f.figureId] = f.editLog || [];
      initialRevisions[f.figureId] = f.revision || 1;
    });

    handleNavigate('editor');

    // Trigger initial render
    setRenderLog(['> 项目已加载，正在调用渲染引擎重建多图...']);
    try {
      const renderScript = cleanSpec.plot_type === 'custom'
        ? (cleanSpec.custom_script || buildReproduciblePython(cleanSpec))
        : buildReproduciblePython(cleanSpec);
      if (renderScript) {
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const figIds = Object.keys(nextFigs);
        figIds.forEach(fid => {
          latestRequestIdByFigure.current[fid] = reqId;
        });
        setProjectFigures(prev => {
          const next = { ...prev };
          figIds.forEach(fid => {
            if (next[fid]) {
              next[fid] = {
                ...next[fid],
                renderStatus: 'rendering',
                error: undefined
              };
            }
          });
          return next;
        });
        setProjectIsRendering(true);
        setTimeout(() => {
          fetch(`/api/projects/${id}/figures/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script: renderScript, editLogs: initialEditLogs, language: cleanSpec.script_language || 'python', requestId: reqId })
          }).then(r => r.json()).then(data => {
            setProjectFigures(prev => {
              const next = { ...prev };
              const returnedFigs = data.figures || [];
              
              figIds.forEach(fid => {
                if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                  const matched = returnedFigs.find((rf: any) => rf.figureId === fid);
                  if (matched && data.status === 'success') {
                    next[fid] = {
                      ...next[fid],
                      svg: matched.svg,
                      manifest: matched.manifest,
                      editLog: matched.editLog || initialEditLogs[fid] || [],
                      revision: matched.revision || initialRevisions[fid] || 1,
                      fingerprint: matched.fingerprint,
                      codeSlice: matched.codeSlice ?? null,
                      renderStatus: 'success',
                      error: undefined
                    };
                  } else {
                    next[fid] = {
                      ...next[fid],
                      renderStatus: 'error',
                      error: data.message || '渲染失败'
                    };
                  }
                }
              });
              return next;
            });
            
            if (data.status === 'success') {
              setRenderLog((prev: string[]) => [...prev, `> 渲染成功，已捕获 ${data.figures?.length || 0} 张 Figure`]);
            } else {
              setRenderLog((prev: string[]) => [...prev, `> [渲染错误] ${data.message || '未知错误'}`]);
            }
          }).catch((err) => {
            setRenderLog((prev: string[]) => [...prev, `> [渲染异常] ${err.message}`]);
            setProjectFigures(prev => {
              const next = { ...prev };
              figIds.forEach(fid => {
                if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                  next[fid] = {
                    ...next[fid],
                    renderStatus: 'error',
                    error: err.message || '网络异常'
                  };
                }
              });
              return next;
            });
          }).finally(() => {
            const activeFigIdToCompare = figList.length > 0 ? figList[0].figureId : 'fig_1';
            if (latestRequestIdByFigure.current[activeFigIdToCompare] === reqId) {
              setProjectIsRendering(false);
            }
          });
        }, 100);
      }
    } catch (err: any) {
      setRenderLog((prev: string[]) => [...prev, `> [错误] 生成渲染脚本失败: ${err.message}`]);
      setProjectIsRendering(false);
    }
  };

  // V3.2A File Handlers
  const handleUploadFile = async (file: File) => {
    if (!projectId) return;
    setRenderLog(prev => [...prev, `> [开始] 上传数据文件: ${file.name}...`]);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.status === 'success') {
        setRenderLog(prev => [...prev, `> [完成] 文件上传成功: ${file.name}`]);
        const resList = await fetch(`/api/projects/${projectId}/files`);
        const dataList = await resList.json();
        if (dataList.status === 'success') {
          setDatasets(dataList.datasets);
        }
      } else {
        alert('上传失败: ' + data.message);
        setRenderLog(prev => [...prev, `> [错误] ${data.message}`]);
      }
    } catch (err: any) {
      alert('上传异常: ' + err.message);
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!projectId) return;
    setRenderLog(prev => [...prev, `> [开始] 删除数据文件...`]);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.status === 'success') {
        setRenderLog(prev => [...prev, `> [完成] 文件已成功删除`]);
        const resList = await fetch(`/api/projects/${projectId}/files`);
        const dataList = await resList.json();
        if (dataList.status === 'success') {
          setDatasets(dataList.datasets);
        }
      } else {
        alert('删除失败: ' + data.message);
      }
    } catch (err: any) {
      alert('删除异常: ' + err.message);
    }
  };

  const handleProjectRender = async (customScriptToUse?: string) => {
    if (!projectId) return;
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const figIds = Object.keys(projectFigures);
    figIds.forEach(fid => {
      latestRequestIdByFigure.current[fid] = reqId;
    });
    setProjectFigures(prev => {
      const next = { ...prev };
      figIds.forEach(fid => {
        if (next[fid]) {
          next[fid] = {
            ...next[fid],
            renderStatus: 'rendering',
            error: undefined
          };
        }
      });
      return next;
    });

    setProjectIsRendering(true);
    const engineName = (spec.script_language || 'python') === 'r' ? 'R 引擎' : 'Python 引擎';
    setRenderProgressText(`正在调用 ${engineName}：执行脚本、捕获 Figure、生成 SVG...`);
    setSpec(prev => {
      const next = cloneSpec(prev);
      if (customScriptToUse !== undefined) {
        next.custom_script = customScriptToUse;
      }
      return next;
    });
    
    const startedAt = new Date();
    setRenderLog(prev => [...prev, `> [开始] 调用 ${engineName}进行多图渲染... ${startedAt.toLocaleTimeString()}`]);
    
    let scriptToRender: string;
    try {
      scriptToRender = spec.plot_type === 'custom'
        ? (customScriptToUse ?? spec.custom_script ?? '')
        : buildReproduciblePython(spec);
      if (spec.plot_type === 'custom' && !scriptToRender) {
        scriptToRender = buildReproduciblePython(spec);
      }
    } catch (err: any) {
      setRenderLog(prev => [...prev, `> [错误] 生成渲染脚本失败: ${err.message}`]);
      setProjectFigures(prev => {
        const next = { ...prev };
        figIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'error',
              error: err.message
            };
          }
        });
        return next;
      });
      setProjectIsRendering(false);
      setRenderProgressText(null);
      return;
    }
    
    const editLogs: Record<string, any[]> = {};
    Object.keys(projectFigures).forEach(figId => {
      editLogs[figId] = projectFigures[figId].editLog;
    });

    try {
      const res = await fetch(`/api/projects/${projectId}/figures/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: scriptToRender, editLogs, language: spec.script_language || 'python', requestId: reqId })
      });
      const data = await res.json();
      
      setProjectFigures(prev => {
        const next = { ...prev };
        const returnedFigs = data.figures || [];
        
        figIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            const matched = returnedFigs.find((rf: any) => rf.figureId === fid);
            if (matched && data.status === 'success') {
              next[fid] = {
                ...next[fid],
                svg: matched.svg,
                manifest: matched.manifest,
                editLog: matched.editLog || editLogs[fid] || [],
                revision: matched.revision || projectFigures[fid]?.revision || 1,
                fingerprint: matched.fingerprint,
                codeSlice: matched.codeSlice ?? null,
                renderStatus: 'success',
                error: undefined
              };
            } else {
              next[fid] = {
                ...next[fid],
                renderStatus: 'error',
                error: data.message || '渲染失败'
              };
            }
          }
        });
        return next;
      });

      if (data.status === 'success') {
        setRenderLog(prev => [...prev, `> [引擎] 渲染成功，共捕获 ${data.figures?.length || 0} 张 Figure`]);
        const returnedFigs = data.figures || [];
        if (returnedFigs.length > 0) {
          const matchedActive = returnedFigs.find((rf: any) => rf.figureId === activeFigureId);
          if (!matchedActive) {
            setActiveFigureId(returnedFigs[0].figureId);
          }
        }
      } else {
        setRenderLog(prev => [...prev, `> [错误] ${data.message}`]);
      }
    } catch (err: any) {
      setRenderLog(prev => [...prev, `> [异常] ${err.message}`]);
      setProjectFigures(prev => {
        const next = { ...prev };
        figIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'error',
              error: err.message || '网络异常'
            };
          }
        });
        return next;
      });
    } finally {
      if (latestRequestIdByFigure.current[activeFigureId] === reqId) {
        setProjectIsRendering(false);
        setRenderProgressText(null);
      }
    }
  };

  const handleImportSpec = (nextSpec: FigureSpec) => {
    const cloned = cloneSpec(nextSpec);
    setSpec(cloned);
    setSpecHistory([cloneSpec(cloned)]);
    setHistoryIndex(0);
    setProjectId(null);
    setProjectName('未命名项目');
    reset();
    setRenderLog(['> 数据已导入，日志待机中...']);
  };

  const handleNavigate = (view: ViewState, sub?: string) => {
    setCurrentView(view);
    if (sub !== undefined) {
      setSubView(sub);
    }
    // Synchronously persist navigation so refresh after a crash restores the right view
    try {
      const prev = JSON.parse(window.sessionStorage.getItem(SPEC_STORAGE_KEY) || '{}');
      prev.currentView = view;
      if (sub !== undefined) prev.subView = sub;
      window.sessionStorage.setItem(SPEC_STORAGE_KEY, JSON.stringify(prev));
    } catch {}
  };

  const handleRenderLog = (lines: string[]) => {
    setRenderLog(prev => [...prev, ...lines]);
  };

  const handleEditSourceFigureFromComposer = (figureId: string) => {
    if (!figureId || figureId === 'composite' || !projectFigures[figureId]) {
      return false;
    }
    setActiveFigureId(figureId);
    setSelectedGids([]);
    setSelectedObject('Figure');
    handleNavigate('editor');
    setRenderLog(prev => [...prev, `> [组合图] 已切换到源图 ${figureId}，可在单图编辑器中修改图元。`]);
    return true;
  };

  const canEditSourceFigureFromComposer = (figureId: string) => {
    return Boolean(figureId && figureId !== 'composite' && projectFigures[figureId]);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white text-slate-900 font-sans selection:bg-blue-100">
      <Navbar currentView={currentView} onNavigate={handleNavigate} />
      
      <div className="flex flex-1 overflow-hidden relative">
        {(currentView === 'editor' || currentView === 'workspace') && (
          <EditorErrorBoundary>
            <IconSidebar />
             <LeftSidebar
              spec={spec}
              selectedObject={selectedObject}
              onSelectObject={handleSelectObject}
              selectedGids={selectedGids}
              onSelectGids={handleSelectGids}
              figSession={figSession}
              lockedObjects={lockedObjects}
              onToggleLock={handleToggleLock}
              onPatch={handlePatch}
              projectId={projectId}
              datasets={datasets}
              onUploadFile={handleUploadFile}
              onDeleteFile={handleDeleteFile}
              onSelectResourceFile={(f) => setActiveResourceFile(f)}
              activeResourceFile={activeResourceFile}
            />
            <MainWorkspace
              spec={spec}
              onSpecChange={applySpecChange}
              onNavigate={(v) => handleNavigate(v)}
              selectedObject={selectedObject}
              onSelectObject={handleSelectObject}
              selectedGids={selectedGids}
              onSelectGids={handleSelectGids}
              projectId={projectId}
              projectName={projectName}
              onProjectChange={(id, name) => { setProjectId(id); setProjectName(name); }}
              specHistory={specHistory}
              historyIndex={historyIndex}
              canUndoFigure={canUndoActiveFigure}
              canRedoFigure={canRedoActiveFigure}
              onUndo={handleUndo}
              onRedo={handleRedo}
              figSession={figSession}
              isRendering={isRendering || projectIsRendering}
              renderProgressText={renderProgressText}
              renderError={renderError}
              renderTraceback={renderTraceback}
              renderLog={renderLog}
              datasets={datasets}
              onRenderLog={handleRenderLog}
              onRender={render}
              onPatch={handlePatch}
              onImmediatePatch={handleImmediatePatch}
              onCodePatch={handleCodePatch}
              projectFigures={projectFigures}
              activeFigureId={activeFigureId}
              onSelectFigure={(figId) => setActiveFigureId(figId)}
              selectedFigureIds={selectedFigureIds}
              onSelectedFigureIdsChange={setSelectedFigureIds}
              onProjectRender={handleProjectRender}
              projectHistory={projectHistory}
              onProjectUndo={handleProjectUndo}
              onProjectRedo={handleProjectRedo}
              onProjectHistoryJump={handleProjectHistoryJump}
            />
             <RightSidebar
              figSession={figSession}
              activeFigureId={activeFigureId}
              selectedFigureIds={selectedFigureIds}
              selectedObject={selectedObject}
              onSelectObject={handleSelectObject}
              selectedGids={selectedGids}
              onSelectGids={handleSelectGids}
              onPatch={handlePatch}
              lockedObjects={lockedObjects}
              projectDrafts={projectDrafts}
              onUpdateDraft={handleUpdateDraft}
              onUpdateDraftsBatch={handleUpdateDraftsBatch}
              onDiscardDraft={handleDiscardDraft}
              onApplyDraft={handleApplyDraft}
            />
          </EditorErrorBoundary>
        )}
        
        {currentView === 'home' && (
          <>
            <AppSidebar currentView="home" subView={subView} onNavigate={handleNavigate} />
            <HomeDashboard onNavigate={(v) => handleNavigate(v)} />
          </>
        )}

        {currentView === 'templates' && (
          <>
            <AppSidebar currentView="templates" subView={subView} onNavigate={handleNavigate} />
            <TemplatesPage onNavigate={(v) => handleNavigate(v)} />
          </>
        )}

        {currentView === 'projects' && (
          <>
            <AppSidebar currentView="projects" subView={subView} onNavigate={handleNavigate} />
            <ProjectsPage
              subView={subView}
              onNavigate={handleNavigate}
              onLoadProject={handleLoadProject}
            />
          </>
        )}

        {currentView === 'project_create' && (
          <ProjectCreatePage onNavigate={handleNavigate} onLoadProject={handleLoadProject} />
        )}

        {currentView === 'data' && (
          <>
            <AppSidebar currentView="data" subView={subView} onNavigate={handleNavigate} />
            <DataFilesPage spec={spec} />
          </>
        )}

        {currentView === 'settings' && (
          <>
            <AppSidebar currentView="settings" subView={subView} onNavigate={handleNavigate} />
            <SettingsPage subView={subView} />
          </>
        )}

        {currentView === 'data_import' && (
          <DataImportPage onNavigate={(v) => handleNavigate(v)} spec={spec} onSpecChange={handleImportSpec} />
        )}

        {currentView === 'export_settings' && (
          <>
            <IconSidebar />
            <LeftSidebar
              spec={spec}
              selectedObject={selectedObject}
              onSelectObject={handleSelectObject}
              figSession={figSession}
            />
            <ExportSettingsPage
              spec={spec}
              onNavigate={(v) => handleNavigate(v)}
              onSpecChange={applySpecChange}
              figSession={figSession}
              projectId={projectId}
              activeFigureId={activeFigureId}
              isRendering={isRendering || projectIsRendering}
            />
          </>
        )}

        {currentView === 'composer' && (
          <>
            <AppSidebar currentView="composer" subView={subView} onNavigate={handleNavigate} />
            <ComposerPage
              projectId={projectId}
              onNavigate={(v) => handleNavigate(v)}
              onEditSourceFigure={handleEditSourceFigureFromComposer}
              canEditSourceFigure={canEditSourceFigureFromComposer}
            />
          </>
        )}

        {currentView === 'export_library' && (
          <ExportLibraryPage
            projectId={projectId}
            onNavigate={(v) => handleNavigate(v)}
          />
        )}

        {currentView === 'landing' && (
          <LandingPage onNavigate={(v) => handleNavigate(v)} />
        )}
      </div>
    </div>
  );
}
