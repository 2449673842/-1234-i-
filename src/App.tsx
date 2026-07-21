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
import { ProjectReconfigurePage } from './components/ProjectReconfigurePage';
import { HelpCenterPage } from './components/HelpCenterPage';
import { FigureSpec, defaultSpec, DatasetEntry, FigureEntry } from './types';
import { useFigureSession } from './hooks/useFigureSession';
import { buildReproduciblePython } from './utils/reproduciblePython';
import { applyRuntimePatchesToManifest, applyRuntimePatchesToSvg } from './utils/svgEditor';
import { mapPatchesToTargetFigure } from './utils/semanticPatchMapping';
import {
  isExplicitlyDeniedCrossFigure,
  isContentIntent,
  isLayoutIntent,
  isPositionIntent,
  retargetEditingIntentForFigure,
} from './utils/editingIntentCompiler';
import { compileEditingIntentWithControlledResolver } from './utils/targetResolver';
import { EDITING_FEATURE_FLAGS } from './utils/editingFeatureFlags';
import {
  draftAppliesToFigure,
  draftsEligibleForDirectPersistence,
  isSameDraftPatch,
  mergeDraftSettlement,
  settleDraftTransaction,
} from './utils/draftTransaction';
import { summarizeCodeChange } from './utils/codeHistory';
import { getAccessToken, setAccessToken } from './utils/authenticatedFetch';
import { reportClientError } from './utils/clientErrorReporter';
import { figureDpiFromPatches, synchronizeFigureDpiSpec } from './utils/exportPreviewState';
import { enrichDraftPatchWithIdentity, enrichPatchEntriesWithIdentity } from './utils/patchIdentity';
import { isTextContentPatchProp, resolvePatchModeById } from './utils/propertyPatchMode';
import { fnv1a, stableStringify } from './utils/stableJson';
import { removeMatchingPersistedDrafts } from './utils/projectSaveConcurrency';
import type { FigureSession, EditEntry, PatchEntry, HistorySnapshot, ProjectHistoryState } from './schemas/manifest';
import type { DraftPatch } from './schemas/draftPatchBatch';
import type { EditingIntentApplyReport, EditingIntentSkippedTarget } from './schemas/editingIntent';
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
    void reportClientError({
      source: 'editor',
      severity: 'critical',
      title: '编辑器组件崩溃',
      message: error.message || '编辑器发生未知错误',
      component: 'EditorErrorBoundary',
      operation: 'editor.render',
      errorCode: 'editor_error_boundary',
    });
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

export type ViewState = 'home' | 'templates' | 'data_import' | 'editor' | 'workspace' | 'export_settings' | 'composer' | 'projects' | 'data' | 'settings' | 'project_create' | 'project_reconfigure' | 'landing' | 'export_library' | 'help';

const SPEC_STORAGE_KEY = 'scifigure:app-state:v2';
const EDITOR_PANEL_WIDTHS_KEY = 'scifigure:editor-panel-widths:v1';

interface FigurePatchExecutionResult {
  figureId: string;
  success: boolean;
  status: 'success' | 'error' | 'stale' | 'conflict';
  message?: string;
}

const clampPanelWidth = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function loadEditorPanelWidths() {
  if (typeof window === 'undefined') return { left: 256, right: 320 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EDITOR_PANEL_WIDTHS_KEY) || '{}');
    return {
      left: clampPanelWidth(Number(parsed.left) || 256, 220, 420),
      right: clampPanelWidth(Number(parsed.right) || 320, 280, 560),
    };
  } catch {
    return { left: 256, right: 320 };
  }
}

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

function draftPatchStorageKey(patch: Pick<DraftPatch, 'gid' | 'prop' | 'matchColor'>): string {
  const matchColor = typeof patch.matchColor === 'string' ? patch.matchColor.trim().toLowerCase() : '';
  return matchColor
    ? `${patch.gid}:${patch.prop}:match:${matchColor}`
    : `${patch.gid}:${patch.prop}`;
}

function patchEntryStorageKey(patch: PatchEntry): string {
  if (!('gid' in patch)) return `code:${patch.target_id}`;
  return draftPatchStorageKey(patch);
}

function makeHistorySnapshot(
  editLog: EditEntry[],
  label: string,
  script?: string,
  metadata?: Pick<HistorySnapshot, 'changeType' | 'codeSummary'>,
): HistorySnapshot {
  return {
    editLog: cloneEditLog(editLog),
    script,
    label,
    timestamp: Date.now(),
    changeType: metadata?.changeType,
    codeSummary: metadata?.codeSummary,
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
      changeType: candidate.changeType,
      codeSummary: candidate.codeSummary,
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

function rebuildHistoryFromEditLog(editLog: EditEntry[], script?: string): ProjectHistoryState {
  const entries = cloneEditLog(editLog || []);
  if (entries.length === 0) return { past: [], future: [] };

  const groups: EditEntry[][] = [];
  entries.forEach((entry, index) => {
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : index;
    const previous = groups[groups.length - 1];
    const previousTimestamp = previous?.length
      ? (typeof previous[0].timestamp === 'number' ? previous[0].timestamp : index - 1)
      : null;
    if (previous && previousTimestamp === timestamp) {
      previous.push(entry);
    } else {
      groups.push([entry]);
    }
  });

  const past: HistorySnapshot[] = [makeHistorySnapshot([], '初始图（从保存记录恢复）', script)];
  let accumulated: EditEntry[] = [];
  groups.slice(0, -1).forEach((group, index) => {
    accumulated = [...accumulated, ...group];
    past.push(makeHistorySnapshot(accumulated, `恢复步骤 ${index + 1}`, script));
  });
  return { past, future: [] };
}

function sameDraftValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeReturnedProjectFigures(
  previous: Record<string, FigureEntry>,
  returnedFigures: any[],
  fallbacks: {
    editLogs?: Record<string, any[]>;
    revisions?: Record<string, number>;
  } = {}
): Record<string, FigureEntry> {
  const next: Record<string, FigureEntry> = {};
  returnedFigures.forEach((figure: any, index: number) => {
    const figureId = typeof figure.figureId === 'string' && figure.figureId ? figure.figureId : `fig_${index + 1}`;
    const existing = previous[figureId];
    next[figureId] = {
      figureId,
      index,
      manifest: figure.manifest || existing?.manifest || null,
      editLog: figure.editLog || fallbacks.editLogs?.[figureId] || existing?.editLog || [],
      revision: figure.revision || fallbacks.revisions?.[figureId] || existing?.revision || 1,
      svg: figure.svg || existing?.svg,
      fingerprint: figure.fingerprint || existing?.fingerprint,
      codeSlice: figure.codeSlice ?? existing?.codeSlice ?? null,
      renderStatus: 'success',
      error: undefined,
    };
  });
  Object.entries(previous).forEach(([figureId, figure]) => {
    if (!next[figureId] && figure?.renderStatus === 'rendering') {
      next[figureId] = {
        ...figure,
        renderStatus: 'success',
        error: undefined,
      };
    }
  });
  return next;
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
      projectDrafts: parsed.projectDrafts ?? {},
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
      projectDrafts: {},
      currentView: 'home',
      subView: 'home',
    };
  }
}

function renderErrorDiagnosticSummary(renderError: string, language: string | undefined) {
  const messageLength = renderError.length;
  return {
    title: `${language === 'r' ? 'R' : 'Python'} 渲染失败`,
    message: `Renderer failed with a client-side diagnostic summary (${messageLength} characters).`,
    metadata: {
      language: language || 'python',
      messageLength,
      hasMessage: messageLength > 0,
    },
  };
}

export default function App() {
  const initialState = useMemo(() => loadInitialState(), []);
  const hasRestoredProjectFiguresRef = useRef(false);
  const [spec, setSpec] = useState<FigureSpec>(initialState.spec);
  const committedScriptRef = useRef(initialState.spec.custom_script || '');
  const [currentView, setCurrentView] = useState<ViewState>(initialState.currentView ?? 'home');
  const [subView, setSubView] = useState<string>(initialState.subView ?? 'home');
  const exportLibraryReturnViewRef = useRef<ViewState>('home');
  const [authStatus, setAuthStatus] = useState<'checking' | 'authenticated' | 'anonymous'>('checking');

  useEffect(() => {
    const handleAuthRequired = () => {
      setAuthStatus('anonymous');
      setCurrentView('landing');
      setSubView('home');
    };
    const handleAuthChanged = (event: Event) => {
      const authenticated = Boolean((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated);
      setAuthStatus(authenticated ? 'authenticated' : 'anonymous');
      setCurrentView(authenticated ? 'home' : 'landing');
      setSubView('home');
    };
    window.addEventListener('scifigure:auth-required', handleAuthRequired);
    window.addEventListener('scifigure:auth-changed', handleAuthChanged);
    return () => {
      window.removeEventListener('scifigure:auth-required', handleAuthRequired);
      window.removeEventListener('scifigure:auth-changed', handleAuthChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolveAuth = async () => {
      try {
        let response = await fetch('/api/auth/me');
        let data = await response.json().catch(() => null);
        if (data?.status === 'anonymous' && !getAccessToken()) {
          const refreshed = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'same-origin',
          });
          const refreshedData = await refreshed.json().catch(() => null);
          if (refreshed.ok && typeof refreshedData?.token === 'string') {
            setAccessToken(refreshedData.token);
            response = await fetch('/api/auth/me');
            data = await response.json().catch(() => null);
          }
        }
        if (!cancelled) {
          const authenticated = Boolean(response.ok && data?.status === 'success' && data?.user);
          setAuthStatus(authenticated ? 'authenticated' : 'anonymous');
          if (!authenticated) {
            setCurrentView('landing');
            setSubView('home');
          }
        }
      } catch {
        if (!cancelled) {
          setAuthStatus('anonymous');
          setCurrentView('landing');
          setSubView('home');
        }
      }
    };
    void resolveAuth();
    return () => {
      cancelled = true;
    };
  }, []);
  const [selectedObject, setSelectedObject] = useState<string>('Figure');
  const [projectId, setProjectId] = useState<string | null>(initialState.projectId);
  const [projectName, setProjectName] = useState<string>(initialState.projectName);
  const [specHistory, setSpecHistory] = useState<FigureSpec[]>(initialState.history);
  const [historyIndex, setHistoryIndex] = useState<number>(initialState.historyIndex);
  const [lockedObjects, setLockedObjects] = useState<Set<string>>(new Set());
  const [selectedGids, setSelectedGids] = useState<string[]>(initialState.selectedGids ?? []);
  const activeFigureIdRef = useRef(initialState.activeFigureId ?? 'fig_1');
  const figureSelectionsRef = useRef<Record<string, string[]>>({
    [initialState.activeFigureId ?? 'fig_1']: initialState.selectedGids ?? [],
  });
  const [projectHistory, setProjectHistory] = useState<Record<string, ProjectHistoryState>>(initialState.projectHistory ?? {});
  const [editorPanelWidths, setEditorPanelWidths] = useState(loadEditorPanelWidths);
  const editorPanelWidthsRef = useRef(editorPanelWidths);

  const handleSelectGids = (gids: string[]) => {
    figureSelectionsRef.current[activeFigureIdRef.current] = gids;
    setSelectedGids(gids);
    setSelectedObject(gids.length === 0 ? 'Figure' : gids[0]);
  };

  const handleSelectObject = (obj: string) => {
    const gids = obj === 'Figure' ? [] : [obj];
    figureSelectionsRef.current[activeFigureIdRef.current] = gids;
    setSelectedObject(obj);
    setSelectedGids(gids);
  };

  useEffect(() => {
    editorPanelWidthsRef.current = editorPanelWidths;
    try {
      window.localStorage.setItem(EDITOR_PANEL_WIDTHS_KEY, JSON.stringify(editorPanelWidths));
    } catch {}
  }, [editorPanelWidths]);

  const startEditorPanelResize = (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = editorPanelWidthsRef.current;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setEditorPanelWidths(prev => {
        const base = prev || startWidths;
        const next = side === 'left'
          ? { ...base, left: clampPanelWidth(startWidths.left + delta, 220, 420) }
          : { ...base, right: clampPanelWidth(startWidths.right - delta, 280, 560) };
        return next;
      });
    };
    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  };

  // V3.2A Project Layer States
  const [projectFigures, setProjectFigures] = useState<Record<string, FigureEntry>>(initialState.projectFigures ?? {});
  const [activeFigureId, setActiveFigureId] = useState<string>(initialState.activeFigureId ?? 'fig_1');
  const [selectedFigureIds, setSelectedFigureIds] = useState<string[]>(initialState.selectedFigureIds ?? []);
  const [datasets, setDatasets] = useState<DatasetEntry[]>(initialState.datasets ?? []);
  const [activeResourceFile, setActiveResourceFile] = useState<string>('figure_spec.json');

  const handleSelectFigure = (figureId: string) => {
    if (!figureId || figureId === activeFigureIdRef.current) return;
    const nextSelection = figureSelectionsRef.current[figureId] || [];
    activeFigureIdRef.current = figureId;
    setActiveFigureId(figureId);
    setSelectedGids(nextSelection);
    setSelectedObject(nextSelection[0] || 'Figure');
  };

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
  const activeProjectRenderRequests = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!renderError) return;
    const diagnostic = renderErrorDiagnosticSummary(renderError, spec.script_language);
    void reportClientError({
      source: 'render',
      severity: 'error',
      title: diagnostic.title,
      message: diagnostic.message,
      component: 'FigureSession',
      operation: 'figure.render',
      errorCode: 'figure_render_failed',
      projectId,
      figureId: activeFigureId,
      metadata: diagnostic.metadata,
    });
  }, [activeFigureId, projectId, renderError, spec.script_language]);

  const beginProjectRenderRequest = (requestId: string) => {
    activeProjectRenderRequests.current.add(requestId);
    setProjectIsRendering(true);
  };

  const finishProjectRenderRequest = (requestId: string) => {
    activeProjectRenderRequests.current.delete(requestId);
    if (activeProjectRenderRequests.current.size === 0) {
      setProjectIsRendering(false);
      setRenderProgressText(null);
    }
  };

  const [projectDrafts, setProjectDraftsState] = useState<Record<string, Record<string, DraftPatch>>>(initialState.projectDrafts ?? {});
  const projectDraftsRef = useRef<Record<string, Record<string, DraftPatch>>>(initialState.projectDrafts ?? {});
  const setProjectDrafts = (nextValue: React.SetStateAction<Record<string, Record<string, DraftPatch>>>) => {
    const previous = projectDraftsRef.current;
    const next = typeof nextValue === 'function'
      ? (nextValue as (prevState: Record<string, Record<string, DraftPatch>>) => Record<string, Record<string, DraftPatch>>)(previous)
      : nextValue;
    projectDraftsRef.current = next;
    setProjectDraftsState(next);
  };
  const [editingIntentReports, setEditingIntentReports] = useState<EditingIntentApplyReport[]>([]);

  const normalizeDraftForFigure = (figId: string, draft: DraftPatch): DraftPatch => {
    if (draft.type === 'code_patch') return draft;
    const manifest = projectFigures[figId]?.manifest
      || (!projectId && figId === 'fig_1' ? hookSession?.manifest : null);
    const object = manifest?.objects?.find((item: any) => item.id === draft.gid);
    const normalized = isTextContentPatchProp(draft.prop, object) && draft.mode !== 'backend_patch'
      ? { ...draft, mode: 'backend_patch' as const }
      : draft;
    return enrichDraftPatchWithIdentity(normalized, manifest);
  };

  const handleUpdateDraft = (figId: string, patch: DraftPatch) => {
    const normalizedPatch = normalizeDraftForFigure(figId, patch);
    const manifest = projectFigures[figId]?.manifest
      || (!projectId && figId === 'fig_1' ? hookSession?.manifest : null);
    const committedValue = normalizedPatch.type === 'code_patch'
      ? undefined
      : normalizedPatch.gid === 'global'
        ? manifest?.globals?.[normalizedPatch.prop]?.value
        : manifest?.objects?.find(object => object.id === normalizedPatch.gid)?.currentProps?.[normalizedPatch.prop];
    const removesNoopDraft = normalizedPatch.type !== 'code_patch'
      && sameDraftValue(normalizedPatch.value, committedValue);
    setProjectDrafts(prev => {
      const figBucket = { ...(prev[figId] || {}) };
      const key = draftPatchStorageKey(normalizedPatch);
      if (removesNoopDraft) {
        delete figBucket[key];
      } else {
        const { pendingFigureIds: _pendingFigureIds, ...freshPatch } = normalizedPatch;
        figBucket[key] = freshPatch;
      }
      const next = { ...prev };
      if (Object.keys(figBucket).length > 0) next[figId] = figBucket;
      else delete next[figId];
      return next;
    });
  };

  const handleUpdateDraftsBatch = (figId: string, patches: DraftPatch[]) => {
    setProjectDrafts(prev => {
      const figBucket = { ...(prev[figId] || {}) };
      patches.forEach(p => {
        const normalizedPatch = normalizeDraftForFigure(figId, p);
        const key = draftPatchStorageKey(normalizedPatch);
        const { pendingFigureIds: _pendingFigureIds, ...freshPatch } = normalizedPatch;
        figBucket[key] = freshPatch;
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

  const handleProjectLocalDraftsPersisted = (draftsByFigure: Record<string, DraftPatch[]>) => {
    const timestamp = Date.now();
    setProjectFigures(prev => {
      const next = { ...prev };
      Object.entries(draftsByFigure).forEach(([figId, drafts]) => {
        const figure = next[figId];
        const persistableDrafts = draftsEligibleForDirectPersistence(drafts.map(draft => normalizeDraftForFigure(figId, draft)));
        if (!figure || persistableDrafts.length === 0) return;
        const runtimePatches = persistableDrafts.map(draft => ({ gid: draft.gid, prop: draft.prop, value: draft.value }));
        const enrichedPatches = enrichPatchEntriesWithIdentity(
          persistableDrafts.map(draft => ({
            op: 'set' as const,
            gid: draft.gid,
            prop: draft.prop,
            value: draft.value,
            mode: resolvePatchModeById(figure.manifest, draft.gid, draft.prop),
            ...(draft.matchColor ? { matchColor: draft.matchColor } : {}),
          })),
          figure.manifest,
        );
        const editEntries = enrichedPatches
          .filter((patch): patch is Extract<PatchEntry, { op: 'set' }> => !('type' in patch))
          .map(patch => ({
            gid: patch.gid,
            prop: patch.prop,
            value: patch.value,
            mode: patch.mode,
            timestamp,
            ...(patch.matchColor ? { matchColor: patch.matchColor } : {}),
            stableKey: patch.stableKey,
            fingerprint: patch.fingerprint,
            fingerprintVersion: patch.fingerprintVersion,
            identity: patch.identity,
          }));
        next[figId] = {
          ...figure,
          svg: applyRuntimePatchesToSvg(figure.svg || '', runtimePatches),
          manifest: applyRuntimePatchesToManifest(figure.manifest || null, runtimePatches) || figure.manifest,
          editLog: [...(figure.editLog || []), ...editEntries],
        };
      });
      return next;
    });
    setProjectDrafts(prev => removeMatchingPersistedDrafts(prev, Object.fromEntries(
      Object.entries(draftsByFigure).map(([figId, drafts]) => [
        figId,
        draftsEligibleForDirectPersistence(drafts.map(draft => normalizeDraftForFigure(figId, draft))),
      ]),
    ), draftPatchStorageKey));
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
        .map(d => normalizeDraftForFigure(activeFigureId, d))
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
    activeFigureIdRef.current = activeFigureId;
    if (!projectId) return;

    const validIds = new Set((projectFigures[activeFigureId]?.manifest?.objects || []).map(object => object.id));
    const storedSelection = figureSelectionsRef.current[activeFigureId] || [];
    const nextSelection = storedSelection.filter(gid => validIds.has(gid));
    figureSelectionsRef.current[activeFigureId] = nextSelection;
    setSelectedGids(current => (
      current.length === nextSelection.length && current.every((gid, index) => gid === nextSelection[index])
        ? current
        : nextSelection
    ));
    setSelectedObject(nextSelection[0] || 'Figure');
  }, [activeFigureId, projectFigures, projectId]);

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
      projectDrafts,
      currentView,
      subView,
    };
    window.sessionStorage.setItem(SPEC_STORAGE_KEY, JSON.stringify(nextState));
  }, [spec, specHistory, historyIndex, projectId, projectName, hookSession, renderLog, projectFigures, activeFigureId, selectedFigureIds, datasets, selectedGids, projectHistory, projectDrafts, currentView, subView]);

  // Auto-rebuild project figures on mount/refresh if SVGs are missing
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
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
      beginProjectRenderRequest(reqId);
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
            const returnedFigs = data.figures || [];
            if (data.status === 'success' && returnedFigs.length > 0) {
              if (figIds.some(fid => latestRequestIdByFigure.current[fid] !== reqId)) {
                return prev;
              }
              return mergeReturnedProjectFigures(prev, returnedFigs, { editLogs });
            }
            const next = { ...prev };
            figIds.forEach(fid => {
              if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                next[fid] = {
                  ...next[fid],
                  renderStatus: 'error',
                  error: data.message || '恢复失败'
                };
              }
            });
            return next;
          });
          
          if (data.status === 'success') {
            setRenderLog((prev: string[]) => [...prev, `> [自动] 已从服务端编辑历史重建项目多图预览`]);
            const returnedIds = (data.figures || []).map((fig: any) => fig.figureId).filter(Boolean);
            if (returnedIds.length > 0) {
              setActiveFigureId(prev => returnedIds.includes(prev) ? prev : returnedIds[0]);
              setSelectedFigureIds(prev => prev.filter(id => returnedIds.includes(id)));
            }
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
          finishProjectRenderRequest(reqId);
        }
      })();
    }
  }, [authStatus, projectId]);

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

  const stripPatchMetadata = (items: PatchEntry[]): PatchEntry[] => items.map((patchItem) => {
    if ('type' in patchItem) {
      return {
        type: 'code_patch' as const,
        target_id: patchItem.target_id,
        new_value: patchItem.new_value,
        gids: patchItem.gids || [],
      };
    }
    return {
      op: 'set' as const,
      mode: patchItem.mode,
      gid: patchItem.gid,
      prop: patchItem.prop,
      value: patchItem.value,
      matchColor: patchItem.matchColor,
      stableKey: patchItem.stableKey,
      fingerprint: patchItem.fingerprint,
      fingerprintVersion: patchItem.fingerprintVersion,
      identity: patchItem.identity,
    };
  });

  const handlePatch = async (patches: PatchEntry[]) => {
    const figureId = projectId ? activeFigureId : 'fig_1';
    const draftPatches = patches.map((patch) => {
      const gid = 'gid' in patch ? patch.gid : 'code_patch';
      const prop = 'prop' in patch ? patch.prop : patch.target_id;
      return {
        gid,
        prop,
        value: 'value' in patch ? patch.value : patch.new_value,
        matchColor: 'matchColor' in patch ? patch.matchColor : undefined,
        mode: 'mode' in patch ? patch.mode : 'backend_patch',
        type: 'type' in patch ? patch.type : undefined,
        target_id: 'target_id' in patch ? patch.target_id : undefined,
        new_value: 'new_value' in patch ? patch.new_value : undefined,
        gids: 'gids' in patch ? patch.gids : undefined,
        intent: patch.intent,
      };
    });
    handleUpdateDraftsBatch(figureId, draftPatches);
    return {
      status: 'success' as const,
      sessionId: `${projectId || 'project'}_${figureId}`,
      applied: patches,
    };
  };

  const executeSingleFigurePatch = async (
    targetFigureId: string,
    patches: PatchEntry[],
  ): Promise<FigurePatchExecutionResult> => {
    const needsBackendRender = patches.some((patchItem: any) => patchItem.type === 'code_patch' || patchItem.mode !== 'local_patch');
    const patchSummary = patches.length === 1
      ? `${(patches[0] as any).gid || (patches[0] as any).target_id || '对象'} / ${(patches[0] as any).prop || '代码'}`
      : `${patches.length} 个参数`;
    const targetManifest = projectId
      ? projectFigures[targetFigureId]?.manifest || null
      : figSession?.manifest || null;
    const requestPatches = enrichPatchEntriesWithIdentity(patches, targetManifest);

    if (projectId) {
      const prevEditLog = projectFigures[targetFigureId]?.editLog || [];
      const localPatchTimestamp = Date.now();
      const localPatchEntries = requestPatches
        .filter((patchItem: any) => patchItem.mode === 'local_patch' && patchItem.gid && patchItem.prop)
        .map((patchItem: any) => ({
          gid: patchItem.gid,
          prop: patchItem.prop,
          value: patchItem.value,
          mode: patchItem.mode as any,
          timestamp: localPatchTimestamp,
          ...(patchItem.matchColor ? { matchColor: patchItem.matchColor } : {}),
          stableKey: patchItem.stableKey,
          fingerprint: patchItem.fingerprint,
          fingerprintVersion: patchItem.fingerprintVersion,
          identity: patchItem.identity,
        }));

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
          beginProjectRenderRequest(reqId);
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
            patches: stripPatchMetadata(requestPatches),
            requestId: reqId,
            baseRevision: projectFigures[targetFigureId]?.revision || 1,
          })
        });
        const data = await res.json();
        
        if (reqId !== latestRequestIdByFigure.current[targetFigureId]) {
          return {
            figureId: targetFigureId,
            success: false,
            status: 'stale',
            message: '较新的请求已替代本次修改。',
          };
        }

        if (data.status === 'success') {
          const appliedNeedsBackendRender = needsBackendRender || (
            Array.isArray(data.applied)
            && data.applied.some((patchItem: any) => patchItem?.type === 'code_patch' || patchItem?.mode === 'backend_patch')
          );
          const appliedDpi = figureDpiFromPatches(patches);
          if (appliedDpi !== null) {
            setSpec(current => synchronizeFigureDpiSpec(current, appliedDpi));
          }
          if (appliedNeedsBackendRender) {
            setRenderLog(prev => [...prev, `> [完成] ${targetFigureId} 参数已应用，预览已更新`]);
          }
          setProjectFigures(prev => {
            const next = { ...prev };
            const active = next[targetFigureId];
            if (active) {
              if (data.revision !== undefined && data.revision < active.revision) {
                return prev;
              }
              const runtimePatches = localPatchEntries.map(({ gid, prop, value }) => ({ gid, prop, value }));
              const nextSvg = !appliedNeedsBackendRender && runtimePatches.length > 0
                ? applyRuntimePatchesToSvg(active.svg || '', runtimePatches)
                : data.svg || active.svg;
              const nextManifest = !appliedNeedsBackendRender && runtimePatches.length > 0
                ? applyRuntimePatchesToManifest(active.manifest || null, runtimePatches) || active.manifest
                : data.manifest || active.manifest;
              next[targetFigureId] = {
                ...active,
                svg: nextSvg,
                manifest: nextManifest,
                editLog: data.editLog || [...(active.editLog || []), ...localPatchEntries],
                revision: data.revision || active.revision,
                codeSlice: data.codeSlice ?? active.codeSlice ?? null,
                renderStatus: 'success',
                error: undefined
              };
            }
            return next;
          });

          pushProjectHistory(targetFigureId, prevEditLog, patchSummary);

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
          return { figureId: targetFigureId, success: true, status: 'success' };
        } else if (data.status === 'conflict') {
          const rejectedCount = Array.isArray(data.rejected) ? data.rejected.length : 0;
          const message = data.message || `${rejectedCount || '部分'}项修改未通过目标确认，已保留在暂存区。`;
          setProjectFigures(prev => {
            const next = { ...prev };
            if (next[targetFigureId]) {
              next[targetFigureId] = {
                ...next[targetFigureId],
                renderStatus: 'success',
                error: undefined,
              };
            }
            return next;
          });
          setRenderLog(prev => [...prev, `> [未应用] ${targetFigureId} ${message}`]);
          return {
            figureId: targetFigureId,
            success: false,
            status: 'conflict',
            message,
          };
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
          return {
            figureId: targetFigureId,
            success: false,
            status: 'error',
            message: data.message || '应用失败',
          };
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
        return {
          figureId: targetFigureId,
          success: false,
          status: 'error',
          message: err.message || '网络异常',
        };
      } finally {
          finishProjectRenderRequest(reqId);
      }
    } else {
      // Single figure mode fallback
      if (needsBackendRender) {
        setRenderProgressText(`正在应用 ${patchSummary}：生成新预览...`);
        setRenderLog(prev => [...prev, `> [应用] 正在重渲染 ${patchSummary}...`]);
      }
      try {
        const res = await patch(stripPatchMetadata(requestPatches));
        if (res.status === 'success') {
          const appliedDpi = figureDpiFromPatches(patches);
          if (appliedDpi !== null) {
            setSpec(current => synchronizeFigureDpiSpec(current, appliedDpi));
          }
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
          return { figureId: targetFigureId, success: true, status: 'success' };
        }
        if (res.status === 'conflict') {
          const rejectedCount = Array.isArray(res.rejected) ? res.rejected.length : 0;
          const message = res.message || `${rejectedCount || '部分'}项修改未通过目标确认，已保留在暂存区。`;
          setRenderLog(prev => [...prev, `> [未应用] ${message}`]);
          return {
            figureId: targetFigureId,
            success: false,
            status: 'conflict',
            message,
          };
        }
        return {
          figureId: targetFigureId,
          success: false,
          status: 'error',
          message: res.message || '应用失败',
        };
      } catch (err: any) {
        setRenderLog(prev => [...prev, `> [异常] 参数应用失败: ${err.message || '网络异常'}`]);
        return {
          figureId: targetFigureId,
          success: false,
          status: 'error',
          message: err.message || '网络异常',
        };
      } finally {
        if (needsBackendRender) {
          setRenderProgressText(null);
        }
      }
    }
  };

  const normalizeSkippedTarget = (item: unknown): EditingIntentSkippedTarget => {
    const value = item as Record<string, any> | null;
    if (value && typeof value === 'object' && typeof value.reason === 'string' && typeof value.detail === 'string') {
      return {
        gid: typeof value.gid === 'string' ? value.gid : undefined,
        role: value.role,
        reason: value.reason,
        detail: value.detail,
      } as EditingIntentSkippedTarget;
    }

    const gid = value && typeof value.gid === 'string'
      ? value.gid
      : value && typeof value.target_id === 'string'
        ? value.target_id
        : 'unknown';
    const prop = value && typeof value.prop === 'string'
      ? value.prop
      : value && typeof value.target_id === 'string'
        ? value.target_id
        : 'unknown';
    const isCodePatch = Boolean(value && (value.type === 'code_patch' || value.gid === 'code_patch' || value.target_id));

    return {
      gid,
      reason: isCodePatch ? 'unsupported_scope' : 'not_found',
      detail: isCodePatch
        ? `代码常量修改 ${prop} 不能安全跨 Figure 自动套用。`
        : `目标 Figure 没有找到可安全匹配的对象 ${gid}/${prop}。`,
    };
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

    const draftSourceBucket = (projectDraftsRef.current[figId] || {}) as Record<string, DraftPatch>;
    const draftEntries = Object.entries(draftSourceBucket);
    if (draftEntries.length === 0) return;

    const sourceManifest = projectFigures[figId]?.manifest || null;
    const skippedByTarget: Record<string, number> = {};
    const reportByTarget: Record<string, { appliedCount: number; skipped: EditingIntentSkippedTarget[] }> = {};
    const patchFromDraft = (draft: DraftPatch): PatchEntry => {
      const normalizedDraft = normalizeDraftForFigure(figId, draft);
      if (draft.type === 'code_patch') {
        return {
          type: 'code_patch' as const,
          target_id: draft.target_id!,
          new_value: draft.new_value!,
          gids: draft.gids || []
        };
      }
      return {
        op: 'set' as const,
        mode: normalizedDraft.mode,
        gid: normalizedDraft.gid,
        prop: normalizedDraft.prop,
        value: normalizedDraft.value,
        ...(normalizedDraft.matchColor ? { matchColor: normalizedDraft.matchColor } : {}),
        intent: normalizedDraft.intent,
        stableKey: normalizedDraft.stableKey,
        fingerprint: normalizedDraft.fingerprint,
        fingerprintVersion: normalizedDraft.fingerprintVersion,
        identity: normalizedDraft.identity,
      };
    };
    const compileDraftForTarget = (draft: DraftPatch, targetId: string): { patches: PatchEntry[]; skipped: EditingIntentSkippedTarget[] } => {
      if (!draftAppliesToFigure(draft, targetId)) {
        return { patches: [], skipped: [] };
      }
      const plainPatch = patchFromDraft(draft);
      if (targetId === figId) {
        return { patches: [plainPatch], skipped: [] };
      }
      if (draft.type === 'code_patch' || draft.gid === 'code_patch') {
        return { patches: [], skipped: [normalizeSkippedTarget(plainPatch)] };
      }
      const targetManifest = projectFigures[targetId]?.manifest || null;
      if (draft.intent && targetManifest) {
        const explicitSelection = draft.intent.scope.selectionMode === 'explicit_objects'
          || draft.intent.scope.selectionMode === 'selected_only';
        const crossFigureDenied = isContentIntent(draft.intent.intent)
          || isPositionIntent(draft.intent.intent)
          || isLayoutIntent(draft.intent.intent);
        const identityRelation = draft.identity?.relation;
        const targetRole = String(draft.intent.scope.targetRole);
        const diagramTargetRoles = [
          'diagram_node',
          'diagram_edge',
          'diagram_arrow',
          'diagram_node_label',
          'diagram_coefficient_label',
          'diagram_fit_annotation',
          'diagram_group',
        ];
        const diagramIdentityConstrainedSelection = explicitSelection
          && draft.intent.scope.crossFigure === 'allow'
          && draft.intent.scope.objectIds?.length === 1
          && diagramTargetRoles.includes(targetRole);
        const identityConstrainedSelection = explicitSelection
          && draft.intent.scope.crossFigure === 'allow'
          && draft.intent.scope.objectIds?.length === 1
          && (
            diagramIdentityConstrainedSelection
            ||
            (
              ['data_pie_slice', 'pie_label', 'pie_value_label', 'pie_legend_marker'].includes(targetRole)
              && Boolean(identityRelation?.pieId)
              && typeof identityRelation?.sliceIndex === 'number'
            )
            || (targetRole === 'data_quiver' && Boolean(identityRelation?.quiverId))
            || (targetRole === 'data_streamplot' && Boolean(identityRelation?.streamplotId))
            || (
              targetRole === 'legend_marker'
              && Boolean(identityRelation?.quiverId || identityRelation?.streamplotId)
            )
          );
        if (identityConstrainedSelection) {
          const mapped = mapPatchesToTargetFigure([plainPatch], sourceManifest, targetManifest);
          return {
            patches: mapped.patches as PatchEntry[],
            skipped: mapped.skipped.map(normalizeSkippedTarget),
          };
        }
        if (
          explicitSelection
          && !isExplicitlyDeniedCrossFigure(draft.intent)
          && draft.intent.scope.crossFigure !== 'allow'
          && !crossFigureDenied
        ) {
          const mapped = mapPatchesToTargetFigure([plainPatch], sourceManifest, targetManifest);
          return {
            patches: mapped.patches as PatchEntry[],
            skipped: mapped.skipped.map(normalizeSkippedTarget),
          };
        }
        const compiled = compileEditingIntentWithControlledResolver(
          targetManifest,
          retargetEditingIntentForFigure(draft.intent),
          {
            enabled: EDITING_FEATURE_FLAGS.generalTargetResolverV2,
            legacyAdapterEnabled: EDITING_FEATURE_FLAGS.targetResolverLegacyAdapter,
          },
        );
        return { patches: compiled.patches, skipped: compiled.skipped };
      }
      const mapped = mapPatchesToTargetFigure([plainPatch], sourceManifest, targetManifest);
      return {
        patches: mapped.patches as PatchEntry[],
        skipped: mapped.skipped.map(normalizeSkippedTarget),
      };
    };
    const dedupeCompiledPatches = (
      compiled: Array<{ draftKey: string; patches: PatchEntry[] }>,
    ): { patches: PatchEntry[]; draftKeys: string[] } => {
      const byTargetProp = new Map<string, PatchEntry>();
      const consumedDraftKeys = new Set<string>();
      compiled.forEach(({ draftKey, patches: compiledPatches }) => {
        if (compiledPatches.length > 0) consumedDraftKeys.add(draftKey);
        compiledPatches.forEach((item) => {
          const key = patchEntryStorageKey(item);
          byTargetProp.set(key, item);
        });
      });
      return {
        patches: Array.from(byTargetProp.values()),
        draftKeys: Array.from(consumedDraftKeys),
      };
    };
    const targetPatchJobs = targetIds
      .map((targetId) => {
        const compiled = draftEntries.map(([draftKey, draft]) => ({
          draftKey,
          ...compileDraftForTarget(draft, targetId),
        }));
        const deduped = dedupeCompiledPatches(compiled);
        const skipped = compiled.flatMap(item => item.skipped);
        skippedByTarget[targetId] = skipped.length;
        reportByTarget[targetId] = { appliedCount: deduped.patches.length, skipped };
        return { targetId, patches: deduped.patches, draftKeys: deduped.draftKeys };
      })
      .filter(job => job.patches.length > 0);

    if (targetPatchJobs.length === 0) {
      setEditingIntentReports(prev => [{
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sourceFigureId: figId,
        scope,
        createdAt: Date.now(),
        targetReports: targetIds.map(targetId => {
          const skipped = (reportByTarget[targetId]?.skipped || Object.values(draftSourceBucket).map(draft => normalizeSkippedTarget(patchFromDraft(draft))));
          return {
            figureId: targetId,
            appliedCount: 0,
            skippedCount: skipped.length,
            skipped,
          };
        }),
      }, ...prev].slice(0, 5));
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

    setEditingIntentReports(prev => [{
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sourceFigureId: figId,
      scope,
      createdAt: Date.now(),
      targetReports: targetIds.map(targetId => {
        const targetReport = reportByTarget[targetId] || { appliedCount: 0, skipped: [] };
        return {
          figureId: targetId,
          appliedCount: targetReport.appliedCount,
          skippedCount: targetReport.skipped.length,
          skipped: targetReport.skipped,
        };
      }),
    }, ...prev].slice(0, 5));

    const concurrency = 3;
    const queue = [...targetPatchJobs];
    const executionResults: FigurePatchExecutionResult[] = [];

    const executeNext = async (): Promise<void> => {
      if (queue.length === 0) return;
      const nextJob = queue.shift()!;
      try {
        const result = await executeSingleFigurePatch(nextJob.targetId, nextJob.patches);
        executionResults.push(result);
        if (scope === 'current' && result.success) {
          setProjectDrafts(prev => {
            const currentBucket = prev[figId] || {};
            const nextBucket = { ...currentBucket };
            nextJob.draftKeys.forEach((draftKey) => {
              const snapshotDraft = draftSourceBucket[draftKey];
              if (snapshotDraft && isSameDraftPatch(currentBucket[draftKey], snapshotDraft)) {
                delete nextBucket[draftKey];
              }
            });
            const next = { ...prev };
            if (Object.keys(nextBucket).length > 0) {
              next[figId] = nextBucket;
            } else {
              delete next[figId];
            }
            return next;
          });
        }
      } catch (err: any) {
        console.error(`Failed to apply patches to ${nextJob.targetId}:`, err);
        executionResults.push({
          figureId: nextJob.targetId,
          success: false,
          status: 'error',
          message: err?.message || '应用失败',
        });
      }
      return executeNext();
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, targetPatchJobs.length); i++) {
      workers.push(executeNext());
    }
    await Promise.all(workers);

    const settlement = settleDraftTransaction(
      draftSourceBucket,
      targetPatchJobs.map(job => ({ targetId: job.targetId, draftKeys: job.draftKeys })),
      executionResults.map(result => ({ targetId: result.figureId, success: result.success })),
    );
    setProjectDrafts(prev => {
      const currentBucket = prev[figId] || {};
      const mergedBucket = mergeDraftSettlement(
        currentBucket,
        draftSourceBucket,
        settlement.nextBucket,
      );
      const next = { ...prev };
      if (Object.keys(mergedBucket).length > 0) {
        next[figId] = mergedBucket;
      } else {
        delete next[figId];
      }
      return next;
    });

    if (settlement.failedTargetIds.length > 0) {
      setRenderLog(prev => [
        ...prev,
        `> [部分失败] ${settlement.failedTargetIds.join('、')} 应用失败；相关草稿已保留，仅重试失败 Figure。`,
      ]);
    } else if (settlement.pendingDraftKeys.length > 0) {
      setRenderLog(prev => [
        ...prev,
        `> [提示] ${settlement.pendingDraftKeys.length} 项草稿没有找到可安全应用的目标，已保留。`,
      ]);
    }
  };

  const handleImmediatePatch = async (patches: PatchEntry[]) => {
    const figureId = projectId ? activeFigureId : 'fig_1';
    const draftSnapshot = projectDraftsRef.current[figureId] || {};
    const matchingDrafts = new Map(patches.flatMap((patch) => {
      if (!('gid' in patch) || !('prop' in patch)) return [];
      const key = patchEntryStorageKey(patch);
      const draft = draftSnapshot[key];
      if (!draft) return [];
      return [[key, draft] as const];
    }));
    const result = await executeSingleFigurePatch(figureId, patches);
    if (result.success) {
      setProjectDrafts(prev => {
        const bucket = { ...(prev[figureId] || {}) };
        patches.forEach((patch) => {
          if (!('gid' in patch)) return;
          const key = patchEntryStorageKey(patch);
          const currentDraft = bucket[key];
          const submittedDraft = matchingDrafts.get(key);
          if (!currentDraft || !submittedDraft || !isSameDraftPatch(currentDraft, submittedDraft)) return;
          const normalizedCurrent = normalizeDraftForFigure(figureId, currentDraft);
          if (
            normalizedCurrent.gid === patch.gid
            && normalizedCurrent.prop === patch.prop
            && normalizedCurrent.mode === patch.mode
            && sameDraftValue(normalizedCurrent.value, patch.value)
          ) {
            delete bucket[key];
          }
        });
        const next = { ...prev };
        if (Object.keys(bucket).length > 0) {
          next[figureId] = bucket;
        } else {
          delete next[figureId];
        }
        return next;
      });
    }
    return {
      status: result.success ? 'success' as const : 'error' as const,
      sessionId: `${projectId || 'project'}_${figureId}`,
      applied: result.success ? patches : [],
      message: result.message,
    };
  };

  const handleCodePatch = async (script: string, force?: boolean) => {
    if (projectId) {
      const targetFigureId = activeFigureId;
      const previousScript = committedScriptRef.current;
      const previousEditLog = cloneEditLog(projectFigures[targetFigureId]?.editLog || []);
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
        beginProjectRenderRequest(reqId);
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
          const codeSummary = summarizeCodeChange(previousScript, script);
          if (codeSummary.changed) {
            pushProjectHistory(
              targetFigureId,
              previousEditLog,
              `代码更新前（${codeSummary.label}）`,
              {
                script: previousScript,
                changeType: 'code',
                codeSummary,
              },
            );
            setRenderLog(prev => [...prev, `> [代码历史] 已记录代码版本，可从历史中撤回（${codeSummary.label}）`]);
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
          committedScriptRef.current = script;
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
        finishProjectRenderRequest(reqId);
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
        committedScriptRef.current = script;
      }
      return res;
    }
  };

  const rerenderProjectWithEditLogs = async (editLogs: Record<string, any[]>, scriptOverride?: string): Promise<void> => {
    if (!projectId) return;
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const figIds = Object.keys(projectFigures);
    const trackedFigIds = figIds.length > 0 ? figIds : [activeFigureId || 'fig_1'];
    trackedFigIds.forEach(fid => {
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
      beginProjectRenderRequest(reqId);
      setRenderProgressText('正在撤销/重做：重放当前项目编辑历史并刷新 SVG...');
      setRenderLog(prev => [...prev, `> [历史] 正在重放项目编辑历史...`]);
      const res = await fetch(`/api/projects/${projectId}/figures/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: scriptToReplay, editLogs, language: spec.script_language || 'python', requestId: reqId })
      });
      const data = await res.json();
      
      setProjectFigures(prev => {
        const returnedFigs = data.figures || [];
        if (data.status === 'success' && returnedFigs.length > 0) {
          if (trackedFigIds.some(fid => latestRequestIdByFigure.current[fid] !== reqId)) {
            return prev;
          }
          return mergeReturnedProjectFigures(prev, returnedFigs, { editLogs });
        }
        const next = { ...prev };
        trackedFigIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'error',
              error: data.message || '重放失败'
            };
          }
        });
        return next;
      });

      if (data.status === 'success') {
        const returnedIds = (data.figures || []).map((fig: any) => fig.figureId).filter(Boolean);
        if (returnedIds.length > 0) {
          setActiveFigureId(prev => returnedIds.includes(prev) ? prev : returnedIds[0]);
          setSelectedFigureIds(prev => prev.filter(id => returnedIds.includes(id)));
        }
        if (scriptOverride !== undefined && scriptOverride !== spec.custom_script) {
          const nextSpec = cloneSpec(spec);
          nextSpec.custom_script = scriptOverride;
          applySpecChange(nextSpec, { recordHistory: false });
        }
        committedScriptRef.current = scriptToReplay;
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
      finishProjectRenderRequest(reqId);
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
      nextFuture = [makeHistorySnapshot(
        currentEditLog,
        prevSnapshot.changeType === 'code' ? '代码更新后状态' : '撤销前状态',
        currentScript,
        { changeType: prevSnapshot.changeType, codeSummary: prevSnapshot.codeSummary },
      ), ...history.future];
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
    const nextPast = [...history.past, makeHistorySnapshot(
      currentEditLog,
      nextSnapshot.changeType === 'code' ? '代码更新前状态' : '重做前状态',
      currentScript,
      { changeType: nextSnapshot.changeType, codeSummary: nextSnapshot.codeSummary },
    )];
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
  const pushProjectHistory = (
    figureId: string,
    prevEditLog: EditEntry[],
    label: string,
    options?: {
      script?: string;
      changeType?: HistorySnapshot['changeType'];
      codeSummary?: HistorySnapshot['codeSummary'];
    },
  ) => {
    setProjectHistory(prev => {
      const entry = prev[figureId] || { past: [], future: [] };
      const snapshotLabel = entry.past.length === 0 && prevEditLog.length === 0 && options?.changeType !== 'code'
        ? '初始图'
        : label;
      const snapshot = makeHistorySnapshot(
        prevEditLog,
        snapshotLabel,
        options?.script ?? spec.custom_script ?? '',
        {
          changeType: options?.changeType || 'figure',
          codeSummary: options?.codeSummary,
        },
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

  const handleLoadProject = (id: string, name: string, projectData: any, preferredFigureId?: string) => {
    const loadedSpec: FigureSpec = typeof projectData.spec === 'string' ? JSON.parse(projectData.spec) : projectData.spec;
    const cleanSpec = { ...loadedSpec };
    cleanSpec.custom_script = projectData.script || loadedSpec.custom_script || '';

    setProjectId(id);
    setProjectName(name);
    setSpec(cleanSpec);
    committedScriptRef.current = cleanSpec.custom_script || '';
    setSpecHistory([cloneSpec(cleanSpec)]);
    setHistoryIndex(0);
    setProjectDrafts({});
    figureSelectionsRef.current = {};
    setSelectedGids([]);
    setSelectedObject('Figure');
    reset();

    // Set project datasets
    setDatasets(projectData.datasets || []);

    // Set project figures
    const nextFigs: Record<string, FigureEntry> = {};
    const figList = projectData.figures || [];
    const restoredHistory: Record<string, ProjectHistoryState> = {};
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
      const persistedHistory = normalizeProjectHistory({ [f.figureId]: f.history })[f.figureId];
      restoredHistory[f.figureId] = persistedHistory && (persistedHistory.past.length > 0 || persistedHistory.future.length > 0)
        ? persistedHistory
        : rebuildHistoryFromEditLog(f.editLog || [], cleanSpec.custom_script || '');
    });
    setProjectFigures(nextFigs);
    setProjectHistory(restoredHistory);

    if (figList.length > 0) {
      setActiveFigureId(
        preferredFigureId && nextFigs[preferredFigureId]
          ? preferredFigureId
          : figList[0].figureId,
      );
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
    const recoveredFigureCount = figList.filter((f: any) => f.recoverySource === 'legacy_spec' || f.recoverySource === 'project_figure').length;
    const recoveryLines = [
      '> 项目已加载，正在调用渲染引擎重建多图...',
      ...(recoveredFigureCount > 0 ? [`> [历史恢复] 已从项目持久化记录恢复 ${recoveredFigureCount} 张 Figure 的 editLog。`] : []),
      ...(projectData.historyRecovery?.message ? [`> [需要确认] ${projectData.historyRecovery.message}`] : []),
    ];
    setRenderLog(recoveryLines);
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
        beginProjectRenderRequest(reqId);
        setTimeout(() => {
          fetch(`/api/projects/${id}/figures/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ script: renderScript, editLogs: initialEditLogs, language: cleanSpec.script_language || 'python', requestId: reqId })
          }).then(r => r.json()).then(data => {
            setProjectFigures(prev => {
              const returnedFigs = data.figures || [];
              if (data.status === 'success' && returnedFigs.length > 0) {
                if (figIds.some(fid => latestRequestIdByFigure.current[fid] !== reqId)) {
                  return prev;
                }
                return mergeReturnedProjectFigures(prev, returnedFigs, { editLogs: initialEditLogs, revisions: initialRevisions });
              }
              const next = { ...prev };
              figIds.forEach(fid => {
                if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
                  next[fid] = {
                    ...next[fid],
                    renderStatus: 'error',
                    error: data.message || '渲染失败'
                  };
                }
              });
              return next;
            });
            
            if (data.status === 'success') {
              setRenderLog((prev: string[]) => [...prev, `> 渲染成功，已捕获 ${data.figures?.length || 0} 张 Figure`]);
              const returnedIds = (data.figures || []).map((fig: any) => fig.figureId).filter(Boolean);
              if (returnedIds.length > 0) {
                setActiveFigureId(prev => returnedIds.includes(prev) ? prev : returnedIds[0]);
                setSelectedFigureIds(prev => prev.filter(id => returnedIds.includes(id)));
              }
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
            finishProjectRenderRequest(reqId);
          });
        }, 100);
      }
    } catch (err: any) {
      setRenderLog((prev: string[]) => [...prev, `> [错误] 生成渲染脚本失败: ${err.message}`]);
      if (activeProjectRenderRequests.current.size === 0) {
        setProjectIsRendering(false);
        setRenderProgressText(null);
      }
    }
  };

  const handleExportSnapshotRestored = async (restoredProjectId: string, targetFigureId: string) => {
    const response = await fetch(`/api/projects/${restoredProjectId}`);
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status !== 'success' || !data.project) {
      throw new Error(data?.message || '恢复成功，但重新加载项目失败');
    }
    handleLoadProject(
      restoredProjectId,
      data.project.name || projectName || '未命名项目',
      data.project,
      targetFigureId,
    );
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

  const handleProjectRender = async (customScriptToUse?: string, languageToUse?: 'python' | 'r') => {
    if (!projectId) return;
    const previousScript = committedScriptRef.current;
    const historyOwnerFigureId = activeFigureId;
    const previousEditLog = cloneEditLog(projectFigures[historyOwnerFigureId]?.editLog || []);
    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const figIds = Object.keys(projectFigures);
    const trackedFigIds = figIds.length > 0 ? figIds : [activeFigureId || 'fig_1'];
    trackedFigIds.forEach(fid => {
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

    beginProjectRenderRequest(reqId);
    const effectiveLanguage = languageToUse || spec.script_language || 'python';
    const engineName = effectiveLanguage === 'r' ? 'R 引擎' : 'Python 引擎';
    setRenderProgressText(`正在调用 ${engineName}：执行脚本、捕获 Figure、生成 SVG...`);
    setSpec(prev => {
      const next = cloneSpec(prev);
      if (customScriptToUse !== undefined) {
        next.custom_script = customScriptToUse;
      }
      if (languageToUse !== undefined) {
        next.script_language = languageToUse;
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
        trackedFigIds.forEach(fid => {
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
      finishProjectRenderRequest(reqId);
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
        body: JSON.stringify({ script: scriptToRender, editLogs, language: effectiveLanguage, requestId: reqId })
      });
      const data = await res.json();
      
      setProjectFigures(prev => {
        const returnedFigs = data.figures || [];
        if (data.status === 'success' && returnedFigs.length > 0) {
          if (trackedFigIds.some(fid => latestRequestIdByFigure.current[fid] !== reqId)) {
            return prev;
          }
          const revisions = Object.fromEntries(
            Object.entries(projectFigures as Record<string, FigureEntry>).map(([fid, fig]) => [fid, fig.revision || 1])
          );
          return mergeReturnedProjectFigures(prev, returnedFigs, { editLogs, revisions });
        }
        const next = { ...prev };
        trackedFigIds.forEach(fid => {
          if (latestRequestIdByFigure.current[fid] === reqId && next[fid]) {
            next[fid] = {
              ...next[fid],
              renderStatus: 'error',
              error: data.message || '渲染失败'
            };
          }
        });
        return next;
      });

      if (data.status === 'success') {
        const codeSummary = summarizeCodeChange(previousScript, scriptToRender);
        if (codeSummary.changed) {
          pushProjectHistory(
            historyOwnerFigureId,
            previousEditLog,
            `项目代码更新前（${codeSummary.label}）`,
            {
              script: previousScript,
              changeType: 'code',
              codeSummary,
            },
          );
          setRenderLog(prev => [...prev, `> [代码历史] 已记录项目代码版本，可从 ${historyOwnerFigureId} 历史中撤回（${codeSummary.label}）`]);
        }
        committedScriptRef.current = scriptToRender;
        setRenderLog(prev => [...prev, `> [引擎] 渲染成功，共捕获 ${data.figures?.length || 0} 张 Figure`]);
        const returnedFigs = data.figures || [];
        if (returnedFigs.length > 0) {
          const returnedIds = returnedFigs.map((fig: any) => fig.figureId).filter(Boolean);
          setActiveFigureId(prev => returnedIds.includes(prev) ? prev : returnedIds[0]);
          setSelectedFigureIds(prev => prev.filter(id => returnedIds.includes(id)));
        }
      } else {
        setRenderLog(prev => [...prev, `> [错误] ${data.message}`]);
      }
    } catch (err: any) {
      setRenderLog(prev => [...prev, `> [异常] ${err.message}`]);
      setProjectFigures(prev => {
        const next = { ...prev };
        trackedFigIds.forEach(fid => {
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
      finishProjectRenderRequest(reqId);
    }
  };

  const handleProjectReconfigure = async ({
    script: nextScript,
    language,
    files,
  }: {
    script: string;
    language: 'python' | 'r';
    files: File[];
  }) => {
    if (!projectId) throw new Error('当前没有可重新配置的项目');

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await fetch(`/api/projects/${projectId}/files`, {
        method: 'POST',
        body: formData,
      });
      const uploadData = await uploadRes.json().catch(() => null);
      if (!uploadRes.ok || uploadData?.status !== 'success') {
        throw new Error(uploadData?.message || `上传失败：${file.name}`);
      }
    }

    const nextSpec = cloneSpec({
      ...spec,
      plot_type: 'custom',
      custom_script: nextScript,
      script_language: language,
    });
    const figuresToPersist = Object.entries(projectFigures as Record<string, FigureEntry>).map(([figureId, figure]) => ({
      figureId,
      index: figure.index,
      editLog: figure.editLog || [],
      baseRevision: figure.revision || 1,
      baseEditLogHash: fnv1a(stableStringify(figure.editLog || [])),
      revision: figure.revision || 1,
      history: projectHistory[figureId] || { past: [], future: [] },
    }));
    const saveRes = await fetch(`/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: projectName,
        spec: nextSpec,
        figures: figuresToPersist,
      }),
    });
    const saveData = await saveRes.json().catch(() => null);
    if (!saveRes.ok || saveData?.status === 'error') {
      throw new Error(saveData?.message || '保存重新配置失败');
    }

    const filesRes = await fetch(`/api/projects/${projectId}/files`);
    const filesData = await filesRes.json().catch(() => null);
    if (filesRes.ok && filesData?.status === 'success') {
      setDatasets(filesData.datasets || []);
    }
    setSpec(nextSpec);
    setRenderLog(prev => [
      ...prev,
      `> [重新配置] 保留现有项目与历史，新增 ${files.length} 个数据文件。`,
      '> [重新配置] 已保存脚本，开始重新渲染项目 Figure。',
    ]);
    await handleProjectRender(nextScript, language);
    handleNavigate('editor');
  };

  const handleImportSpec = (nextSpec: FigureSpec) => {
    const cloned = cloneSpec(nextSpec);
    setSpec(cloned);
    committedScriptRef.current = cloned.custom_script || '';
    setSpecHistory([cloneSpec(cloned)]);
    setHistoryIndex(0);
    setProjectId(null);
    setProjectName('未命名项目');
    reset();
    setRenderLog(['> 数据已导入，日志待机中...']);
  };

  const handleNavigate = (requestedView: ViewState, sub?: string) => {
    const view = requestedView === 'project_reconfigure' && !projectId ? 'project_create' : requestedView;
    if (view === 'export_library' && currentView !== 'export_library') {
      exportLibraryReturnViewRef.current = currentView;
    }
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

  const handleExportLibraryBack = () => {
    const target = exportLibraryReturnViewRef.current === 'export_library'
      ? (projectId ? 'editor' : 'home')
      : exportLibraryReturnViewRef.current;
    handleNavigate(target);
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

  const pendingProjectDraftCount = Object.keys(projectDrafts).reduce(
    (total, figureId) => total + Object.keys(projectDrafts[figureId] || {}).length,
    0,
  );

  if (authStatus === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center bg-[#071018] text-white">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center bg-cyan-200 text-xl font-black text-slate-950">S</div>
          <div className="mt-4 text-sm font-bold tracking-wide text-slate-300">正在检查登录状态...</div>
        </div>
      </div>
    );
  }

  if (authStatus === 'anonymous') {
    if (currentView === 'help') {
      return (
        <div className="flex h-screen overflow-hidden bg-[#071018]">
          <HelpCenterPage
            publicMode
            onNavigate={handleNavigate}
            onAuthenticated={() => {
              setAuthStatus('authenticated');
              setCurrentView('home');
              setSubView('home');
            }}
          />
        </div>
      );
    }
    return (
      <div className="flex h-screen overflow-hidden bg-[#071018]">
        <LandingPage
          publicMode
          onNavigate={handleNavigate}
          onAuthenticated={() => {
            setAuthStatus('authenticated');
            setCurrentView('home');
            setSubView('home');
          }}
        />
      </div>
    );
  }

  return (
    <div className="scifig-app-shell flex flex-col h-screen overflow-hidden text-slate-900 selection:bg-emerald-100">
      {currentView !== 'help' && <Navbar currentView={currentView} onNavigate={handleNavigate} />}
      
      <div className="scifig-app-body flex flex-1 overflow-hidden relative">
        {(currentView === 'editor' || currentView === 'workspace') && (
          <EditorErrorBoundary>
            <IconSidebar onNavigate={handleNavigate} />
            <div
              className="hidden md:flex h-full shrink-0 min-w-0"
              style={{ width: editorPanelWidths.left }}
            >
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
            </div>
            <div
              role="separator"
              aria-label="调整左侧栏宽度"
              title="拖动调整左侧栏宽度，双击恢复默认"
              onPointerDown={(event) => startEditorPanelResize('left', event)}
              onDoubleClick={() => setEditorPanelWidths(prev => ({ ...prev, left: 256 }))}
              className="scifig-panel-resizer group hidden md:flex relative z-30 w-2 shrink-0 cursor-col-resize items-center justify-center"
            >
              <div className="h-12 w-0.5 rounded-full bg-slate-300 group-hover:bg-emerald-500" />
            </div>
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
              onLoadProject={handleLoadProject}
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
              projectDrafts={projectDrafts}
              onProjectLocalDraftsPersisted={handleProjectLocalDraftsPersisted}
              onSelectFigure={handleSelectFigure}
              selectedFigureIds={selectedFigureIds}
              onSelectedFigureIdsChange={setSelectedFigureIds}
              onProjectRender={handleProjectRender}
              projectHistory={projectHistory}
              onProjectUndo={handleProjectUndo}
              onProjectRedo={handleProjectRedo}
              onProjectHistoryJump={handleProjectHistoryJump}
            />
            <div
              role="separator"
              aria-label="调整右侧栏宽度"
              title="拖动调整右侧栏宽度，双击恢复默认"
              onPointerDown={(event) => startEditorPanelResize('right', event)}
              onDoubleClick={() => setEditorPanelWidths(prev => ({ ...prev, right: 320 }))}
              className="scifig-panel-resizer group hidden md:flex relative z-30 w-2 shrink-0 cursor-col-resize items-center justify-center"
            >
              <div className="h-12 w-0.5 rounded-full bg-slate-300 group-hover:bg-emerald-500" />
            </div>
            <div
              className="hidden md:flex h-full shrink-0 min-w-0"
              style={{ width: editorPanelWidths.right }}
            >
              <RightSidebar
                figSession={figSession}
                activeFigureId={activeFigureId}
                selectedFigureIds={selectedFigureIds}
                selectedObject={selectedObject}
                onSelectObject={handleSelectObject}
                selectedGids={selectedGids}
                onSelectGids={handleSelectGids}
                onPatch={handlePatch}
                onImmediatePatch={handleImmediatePatch}
                lockedObjects={lockedObjects}
                projectDrafts={projectDrafts}
                onUpdateDraft={handleUpdateDraft}
                onUpdateDraftsBatch={handleUpdateDraftsBatch}
                onDiscardDraft={handleDiscardDraft}
                onApplyDraft={handleApplyDraft}
                editingIntentReports={editingIntentReports}
              />
            </div>
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

        {currentView === 'project_reconfigure' && projectId && (
          <ProjectReconfigurePage
            projectId={projectId}
            projectName={projectName}
            spec={spec}
            datasets={datasets}
            onNavigate={handleNavigate}
            onApply={handleProjectReconfigure}
          />
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
            <IconSidebar onNavigate={handleNavigate} />
            <div className="hidden md:flex h-full w-64 shrink-0">
              <LeftSidebar
                spec={spec}
                selectedObject={selectedObject}
                onSelectObject={handleSelectObject}
                figSession={figSession}
              />
            </div>
            <ExportSettingsPage
              spec={spec}
              onNavigate={(v) => handleNavigate(v)}
              onSpecChange={applySpecChange}
              figSession={figSession}
              projectId={projectId}
              activeFigureId={activeFigureId}
              isRendering={isRendering || projectIsRendering}
              pendingDraftCount={Object.keys(projectDrafts[activeFigureId] || {}).length}
              pendingProjectDraftCount={pendingProjectDraftCount}
              onRestoreSnapshot={handleExportSnapshotRestored}
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
            onBack={handleExportLibraryBack}
            onRestoreSnapshot={handleExportSnapshotRestored}
          />
        )}

        {currentView === 'landing' && (
          <LandingPage onNavigate={(v) => handleNavigate(v)} />
        )}

        {currentView === 'help' && (
          <HelpCenterPage onNavigate={(v) => handleNavigate(v)} />
        )}
      </div>
    </div>
  );
}
