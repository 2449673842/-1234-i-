import { memo, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Editor from '@monaco-editor/react';
import { ChartPreview } from './ChartPreview';
import { WordA4Preview } from './WordA4Preview';
import { ManifestViewer } from './ManifestViewer';
import { DatasetEntry, FigureSpec } from '../types';
import { Home, ChevronRight, PenLine, Maximize, Settings, UploadCloud, Download, Loader2, Save, Eye, Copy, Plus, X, Search, GripVertical, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react';
import { ViewState } from '../App';
import { buildReproduciblePython } from '../utils/reproduciblePython';
import { sanitizeSvg } from '../utils/svgEditor';
import { FigureSession, RenderResponse, PatchEntry, PatchResponse, EditEntry, HistorySnapshot, ProjectHistoryState } from '../schemas/manifest';
import { normalizeFigureModel } from '../utils/standardFigureModel';
import { fnv1a, stableStringify } from '../utils/stableJson';
import type { StandardFigureModel } from '../schemas/standardFigureModel';
import type { DraftPatch } from '../schemas/draftPatchBatch';
import { buildCompositionRisks, planCompositionLayout } from '../utils/compositionPlanner';
import { draftsEligibleForDirectPersistence, draftsRequiringEngineApply } from '../utils/draftTransaction';
import { copyTextToClipboard } from '../utils/clipboard';
import { isTextContentPatchProp } from '../utils/propertyPatchMode';

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
  onLoadProject?: (id: string, name: string, data: any) => void;
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
  onRender: (script: string, dataPayload?: any, initialEditLog?: EditEntry[], language?: 'python' | 'r') => Promise<RenderResponse>;
  onPatch: (patches: PatchEntry[]) => Promise<PatchResponse>;
  onImmediatePatch?: (patches: PatchEntry[]) => Promise<any>;
  onCodePatch: (script: string, force?: boolean) => Promise<any>;

  // V3.2A Project Layer
  projectFigures?: Record<string, any>;
  activeFigureId?: string;
  projectDrafts?: Record<string, Record<string, DraftPatch>>;
  onProjectLocalDraftsPersisted?: (draftsByFigure: Record<string, DraftPatch[]>) => void;
  onSelectFigure?: (figureId: string) => void;
  selectedFigureIds?: string[];
  onSelectedFigureIdsChange?: (figureIds: string[]) => void;
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

interface ProjectPickerSummary {
  id: string;
  name: string;
  updated_at?: string;
  figure_count?: number;
  project_type?: 'single_figure' | 'multi_figure' | 'composition_code';
  project_type_label?: string;
}

interface FigurePickerSummary {
  figureId: string;
  index: number;
  revision?: number;
  svg?: string | null;
  codeSlice?: any;
  manifest?: any;
  previewError?: string;
  language?: 'python' | 'r';
  subplotCount?: number;
  aspectRatio?: number;
  hasLegend?: boolean;
  hasColorbar?: boolean;
  dataFileCount?: number;
  dependencyStatus?: 'complete' | 'unknown' | 'missing';
  missingDataFiles?: string[];
}

const sanitizedSvgPreviewCache = new Map<string, string>();
const SANITIZED_SVG_PREVIEW_CACHE_LIMIT = 64;
const COMPOSITION_RECENT_PROJECTS_KEY = 'scifigure:composition-recent-projects:v1';

function loadRecentCompositionProjectIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPOSITION_RECENT_PROJECTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function formatCompositionProjectUpdatedAt(value?: string): string {
  if (!value) return '更新时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '更新时间未知';
  return `更新 ${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}`;
}

const SanitizedSvgPreview = memo(function SanitizedSvgPreview({
  svg,
  className,
  defer = false,
}: {
  svg: string;
  className: string;
  defer?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(!defer);

  useEffect(() => {
    if (!defer) {
      setShouldRender(true);
      return;
    }
    setShouldRender(false);
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setShouldRender(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [defer, svg]);

  const sanitized = useMemo(() => {
    if (!shouldRender) return null;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    const cached = sanitizedSvgPreviewCache.get(svg);
    const html = cached || sanitizeSvg(svg);
    if (!cached) {
      sanitizedSvgPreviewCache.set(svg, html);
      if (sanitizedSvgPreviewCache.size > SANITIZED_SVG_PREVIEW_CACHE_LIMIT) {
        const oldest = sanitizedSvgPreviewCache.keys().next().value;
        if (oldest) sanitizedSvgPreviewCache.delete(oldest);
      }
    }
    const sanitizeMs = typeof performance !== 'undefined'
      ? cached ? 0 : Math.max(0, performance.now() - startedAt)
      : 0;
    return { html, sanitizeMs };
  }, [shouldRender, svg]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={defer ? { contentVisibility: 'auto', containIntrinsicSize: '112px' } : undefined}
      data-svg-bytes={svg.length}
      data-svg-preview-rendered={sanitized ? 'true' : 'false'}
      data-svg-sanitize-ms={sanitized ? sanitized.sanitizeMs.toFixed(2) : 'deferred'}
      dangerouslySetInnerHTML={sanitized ? { __html: sanitized.html } : undefined}
    />
  );
});

interface ExportHistoryAsset {
  assetId: string;
  figureId?: string;
  name: string;
  format: string;
  createdAt: string;
  revision?: number;
  editCount?: number;
  editLogHash?: string;
}

type ExportHistoryMark = ExportHistoryAsset & {
  exportNumber: number;
};

function normalizeEditLogForExportAnchor(editLog: EditEntry[]): unknown[] {
  return (editLog || []).map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const {
      timestamp: _timestamp,
      requestId: _requestId,
      intent: _intent,
      ...semanticEntry
    } = entry as unknown as Record<string, unknown>;
    return semanticEntry;
  });
}

function buildEditLogAnchorHash(editLog: EditEntry[]): string {
  return fnv1a(stableStringify(normalizeEditLogForExportAnchor(editLog)));
}

interface CompositionSourceDraft {
  projectId: string;
  projectName: string;
  figureId: string;
  codeSlice?: any;
  svg?: string | null;
  projectType?: 'single_figure' | 'multi_figure' | 'composition_code';
  language?: 'python' | 'r';
  subplotCount?: number;
  aspectRatio?: number;
  hasLegend?: boolean;
  hasColorbar?: boolean;
  dataFileCount?: number;
  dependencyStatus?: 'complete' | 'unknown' | 'missing';
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
  onLoadProject,
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
  onImmediatePatch,
  onCodePatch,
  projectFigures = {},
  activeFigureId = 'fig_1',
  projectDrafts = {},
  onProjectLocalDraftsPersisted,
  onSelectFigure,
  selectedFigureIds = [],
  onSelectedFigureIdsChange,
  onProjectRender,
  projectHistory,
  onProjectUndo,
  onProjectRedo,
  onProjectHistoryJump,
}: MainWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'data' | 'spec'>('preview');
  const [showWordA4Preview, setShowWordA4Preview] = useState(false);
  const [showWordA4ReadingPreview, setShowWordA4ReadingPreview] = useState(false);
  const [bottomTab, setBottomTab] = useState<'python' | 'spec' | 'log'>('python');
  const [showBottomPanel, setShowBottomPanel] = useState(false);
  const [showSvgModal, setShowSvgModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName);
  const [scriptDragOver, setScriptDragOver] = useState(false);
  const [showHistoryMenu, setShowHistoryMenu] = useState(false);
  const [exportHistoryAssets, setExportHistoryAssets] = useState<ExportHistoryAsset[]>([]);
  const [dragEditMode, setDragEditMode] = useState(false);
  const [pendingDragCount, setPendingDragCount] = useState(0);
  const [figureSwitchWarning, setFigureSwitchWarning] = useState<string | null>(null);
  const [showCompositionDialog, setShowCompositionDialog] = useState(false);
  const [compositionSources, setCompositionSources] = useState<CompositionSourceDraft[]>([]);
  const [compositionProjects, setCompositionProjects] = useState<ProjectPickerSummary[]>([]);
  const [compositionFigures, setCompositionFigures] = useState<FigurePickerSummary[]>([]);
  const [compositionFiguresLoading, setCompositionFiguresLoading] = useState(false);
  const [compositionPreviewWarning, setCompositionPreviewWarning] = useState<string | null>(null);
  const [compositionProjectPick, setCompositionProjectPick] = useState('');
  const [compositionFigurePick, setCompositionFigurePick] = useState('');
  const [compositionAxesWidth, setCompositionAxesWidth] = useState(2.2);
  const [compositionAxesHeight, setCompositionAxesHeight] = useState(2.2);
  const [compositionLayout, setCompositionLayout] = useState('auto');
  const [compositionName, setCompositionName] = useState('');
  const [compositionPrompt, setCompositionPrompt] = useState('');
  const [compositionCreatedProject, setCompositionCreatedProject] = useState<{ id: string; name: string } | null>(null);
  const [compositionLoading, setCompositionLoading] = useState(false);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [compositionCopyStatus, setCompositionCopyStatus] = useState<string | null>(null);
  const [compositionProjectSearch, setCompositionProjectSearch] = useState('');
  const [compositionProjectType, setCompositionProjectType] = useState<'all' | 'single_figure' | 'multi_figure' | 'composition_code'>('all');
  const [compositionRecentOnly, setCompositionRecentOnly] = useState(false);
  const [compositionRecentProjectIds, setCompositionRecentProjectIds] = useState(loadRecentCompositionProjectIds);
  const [compositionSourceNotice, setCompositionSourceNotice] = useState<string | null>(null);
  const [compositionDraggingKey, setCompositionDraggingKey] = useState<string | null>(null);
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
  const scriptLanguage = spec.script_language || 'python';
  const isRScript = scriptLanguage === 'r';

  // Task A2: Derive StandardFigureModel for debug display (read-only)
  const debugModel: StandardFigureModel | null = useMemo(() => {
    // In project mode, use the active figure's manifest
    const activeFig = projectFigures[activeFigureId];
    const manifest = activeFig?.manifest ?? figSession?.manifest ?? null;
    if (!manifest) return null;
    try {
      return normalizeFigureModel({
        figureId: activeFigureId,
        language: scriptLanguage as 'python' | 'r',
        svg: activeFig?.svg ?? figSession?.svg ?? '',
        manifest,
        revision: activeFig?.revision ?? figSession?.revision ?? 0,
        editLog: activeFig?.editLog ?? figSession?.editLog ?? [],
        fingerprint: activeFig?.fingerprint,
        codeSlice: activeFig?.codeSlice ?? null,
      });
    } catch {
      return null;
    }
  }, [projectFigures, activeFigureId, figSession, scriptLanguage]);

  const updateScriptLanguageFromFile = (fileName: string): 'python' | 'r' => (
    fileName.toLowerCase().endsWith('.r') ? 'r' : 'python'
  );

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
  const handleFigureTabSelect = (figureId: string) => {
    if (figureId === activeFigureId) return;
    if (pendingDragCount > 0) {
      setFigureSwitchWarning(`当前 Figure 有 ${pendingDragCount} 个未确认位移，请先在画布上确认位置或取消。`);
      return;
    }
    setFigureSwitchWarning(null);
    onSelectFigure?.(figureId);
  };

  useEffect(() => {
    if (pendingDragCount === 0) setFigureSwitchWarning(null);
  }, [pendingDragCount]);
  const toggleSelectedFigure = (figureId: string) => {
    if (!onSelectedFigureIdsChange) return;
    const selected = selectedFigureIds.includes(figureId);
    onSelectedFigureIdsChange(selected
      ? selectedFigureIds.filter(id => id !== figureId)
      : [...selectedFigureIds, figureId]
    );
  };
  const makeSourceKey = (source: Pick<CompositionSourceDraft, 'projectId' | 'figureId'>) => `${source.projectId}:${source.figureId}`;
  const compositionPlan = useMemo(() => planCompositionLayout({
    count: compositionSources.length,
    requestedLayout: compositionLayout,
    axesWidthIn: compositionAxesWidth,
    axesHeightIn: compositionAxesHeight,
  }), [compositionAxesHeight, compositionAxesWidth, compositionLayout, compositionSources.length]);
  const compositionRisks = useMemo(() => buildCompositionRisks({
    count: compositionSources.length,
    plan: compositionPlan,
    sources: compositionSources.map(source => ({
      key: makeSourceKey(source),
      hasPreview: Boolean(source.svg),
      hasCodeSlice: Boolean(source.codeSlice),
      projectType: source.projectType,
      language: source.language,
      dependencyStatus: source.dependencyStatus,
    })),
  }), [compositionPlan, compositionSources]);
  const compositionHasBlockingRisk = compositionRisks.some(risk => risk.level === 'error');
  const filteredCompositionProjects = useMemo(() => {
    const query = compositionProjectSearch.trim().toLocaleLowerCase();
    return compositionProjects
      .filter(project => (
        (compositionProjectType === 'all' || project.project_type === compositionProjectType)
        && (!compositionRecentOnly || compositionRecentProjectIds.includes(project.id))
        && (!query || project.name.toLocaleLowerCase().includes(query))
      ))
      .sort((left, right) => {
        const leftRecent = compositionRecentProjectIds.indexOf(left.id);
        const rightRecent = compositionRecentProjectIds.indexOf(right.id);
        if (leftRecent !== rightRecent) {
          if (leftRecent < 0) return 1;
          if (rightRecent < 0) return -1;
          return leftRecent - rightRecent;
        }
        return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime();
      });
  }, [compositionProjectSearch, compositionProjectType, compositionProjects, compositionRecentOnly, compositionRecentProjectIds]);
  const selectCompositionProject = (nextProjectId: string) => {
    setCompositionProjectPick(nextProjectId);
    setCompositionRecentProjectIds(previous => {
      const next = [nextProjectId, ...previous.filter(id => id !== nextProjectId)].slice(0, 8);
      try {
        window.localStorage.setItem(COMPOSITION_RECENT_PROJECTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const openCompositionProjectDialog = () => {
    const initialFigureIds = selectedFigureIds.length > 0
      ? selectedFigureIds.filter(figId => projectFigures[figId])
      : (projectId && projectFigures[activeFigureId] ? [activeFigureId] : []);
    const initialSources = projectId
      ? initialFigureIds.map(figId => ({
          projectId,
          projectName,
          figureId: figId,
          codeSlice: projectFigures[figId]?.codeSlice ?? null,
          svg: projectFigures[figId]?.svg ?? null,
          projectType: (spec as FigureSpec & { composition?: { kind?: string } }).composition?.kind === 'code_composition_project'
            ? 'composition_code' as const
            : Object.keys(projectFigures).length > 1 ? 'multi_figure' as const : 'single_figure' as const,
          language: spec.script_language || 'python',
          subplotCount: (projectFigures[figId]?.manifest?.objects || []).filter((object: any) => object.kind === 'subplot').length,
          hasLegend: (projectFigures[figId]?.manifest?.objects || []).some((object: any) => String(object.kind || '').includes('legend')),
          hasColorbar: (projectFigures[figId]?.manifest?.objects || []).some((object: any) => String(object.kind || '').includes('colorbar')),
          dataFileCount: datasets.length,
          dependencyStatus: 'unknown' as const,
        }))
      : [];
    setCompositionSources(initialSources);
    setCompositionName(projectName ? `${projectName} - 组合代码项目` : '组合代码项目');
    setCompositionPrompt('');
    setCompositionCreatedProject(null);
    setCompositionError(null);
    setCompositionCopyStatus(null);
    setCompositionProjectSearch('');
    setCompositionProjectType('all');
    setCompositionSourceNotice(null);
    setShowCompositionDialog(true);
  };

  const addCompositionSource = (source: CompositionSourceDraft) => {
    if (!source.projectId || !source.figureId) return;
    setCompositionSources(prev => {
      const key = makeSourceKey(source);
      if (prev.some(item => makeSourceKey(item) === key)) {
        setCompositionSourceNotice(`${source.projectName} / ${source.figureId} 已在已选列表中。`);
        return prev;
      }
      setCompositionSourceNotice(null);
      return [...prev, source];
    });
  };

  const removeCompositionSource = (source: CompositionSourceDraft) => {
    const key = makeSourceKey(source);
    setCompositionSources(prev => prev.filter(item => makeSourceKey(item) !== key));
  };

  const moveCompositionSource = (fromIndex: number, toIndex: number) => {
    setCompositionSources(previous => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= previous.length || toIndex >= previous.length) return previous;
      const next = [...previous];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const dropCompositionSource = (targetIndex: number) => {
    if (!compositionDraggingKey) return;
    const fromIndex = compositionSources.findIndex(source => makeSourceKey(source) === compositionDraggingKey);
    moveCompositionSource(fromIndex, targetIndex);
    setCompositionDraggingKey(null);
  };

  const addPickedCompositionSource = () => {
    const project = compositionProjects.find(item => item.id === compositionProjectPick);
    const figure = compositionFigures.find(item => item.figureId === compositionFigurePick);
    if (!project || !figure) return;
    addCompositionSource({
      projectId: project.id,
      projectName: project.name,
      figureId: figure.figureId,
      codeSlice: figure.codeSlice ?? null,
      svg: figure.svg ?? null,
      projectType: project.project_type,
      language: figure.language,
      subplotCount: figure.subplotCount,
      aspectRatio: figure.aspectRatio,
      hasLegend: figure.hasLegend,
      hasColorbar: figure.hasColorbar,
      dataFileCount: figure.dataFileCount,
      dependencyStatus: figure.dependencyStatus,
    });
  };

  const readJsonResponse = async (res: Response, fallbackMessage: string) => {
    const text = await res.text();
    if (!text.trim()) {
      throw new Error(`${fallbackMessage}：服务端返回空响应（HTTP ${res.status}）。如果刚升级过代码，请重启后端服务。`);
    }
    try {
      return JSON.parse(text);
    } catch {
      const preview = text.slice(0, 240).replace(/\s+/g, ' ').trim();
      throw new Error(`${fallbackMessage}：服务端没有返回 JSON（HTTP ${res.status}）。${preview ? `响应片段：${preview}` : '响应为空。'}`);
    }
  };

  const copyCompositionPrompt = async (prompt = compositionPrompt) => {
    if (!prompt) return;
    const copied = await copyTextToClipboard(prompt);
    setCompositionCopyStatus(copied ? '已复制到剪贴板' : '复制失败，请手动选中文本复制');
    window.setTimeout(() => setCompositionCopyStatus(null), 2400);
  };

  const copyWorkspaceText = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      window.alert('自动复制失败，请手动选中文本复制。');
    }
  };

  const createCompositionProject = async () => {
    if (compositionSources.length === 0) {
      setCompositionError('请至少加入一张 Figure');
      return;
    }
    if (compositionHasBlockingRisk) {
      setCompositionError('请先处理“创建前检查”中的阻断问题。');
      return;
    }
    setCompositionLoading(true);
    setCompositionError(null);
    try {
      const res = await fetch('/api/projects/create-composition-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: compositionName.trim() || undefined,
          targetAxesWidthIn: compositionAxesWidth,
          targetAxesHeightIn: compositionAxesHeight,
          layout: compositionPlan.layoutKey,
          sources: compositionSources.map(source => ({
            projectId: source.projectId,
            figureId: source.figureId,
            codeSlice: source.codeSlice || undefined,
          })),
        }),
      });
      const data = await readJsonResponse(res, '创建组合代码项目失败');
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || '创建组合代码项目失败');
      }
      setCompositionPrompt(data.prompt || '');
      setCompositionCreatedProject({ id: data.projectId, name: data.projectName || compositionName || '组合代码项目' });
      if (data.prompt) {
        void copyCompositionPrompt(data.prompt);
      }
      onRenderLog([
        `> [组合代码项目] 已创建 ${data.projectName || data.projectId}`,
        `> [组合代码项目] 已复制 ${data.copiedFiles?.length || 0} 个数据文件，AI 提示词已生成。`,
      ]);
    } catch (err: any) {
      setCompositionError(err?.message || '创建组合代码项目失败');
    } finally {
      setCompositionLoading(false);
    }
  };

  const openCreatedCompositionProject = async () => {
    if (!compositionCreatedProject || !onLoadProject) return;
    setCompositionLoading(true);
    try {
      const res = await fetch(`/api/projects/${compositionCreatedProject.id}`);
      const data = await readJsonResponse(res, '加载新项目失败');
      if (data.status !== 'success') {
        throw new Error(data.message || '加载新项目失败');
      }
      onLoadProject(compositionCreatedProject.id, compositionCreatedProject.name, data.project);
      setShowCompositionDialog(false);
    } catch (err: any) {
      setCompositionError(err?.message || '加载新项目失败');
    } finally {
      setCompositionLoading(false);
    }
  };
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
    if (!showCompositionDialog) return;
    let cancelled = false;
    fetch('/api/projects')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const projects = Array.isArray(data.projects) ? data.projects : [];
        setCompositionProjects(projects.map((project: any) => ({
          id: project.id || project.projectId,
          name: project.name || project.id || '未命名项目',
          updated_at: project.updated_at,
          figure_count: Number(project.figure_count || 0),
          project_type: project.project_type,
          project_type_label: project.project_type_label,
        })).filter((project: ProjectPickerSummary) => project.id));
        if (!compositionProjectPick && projectId) {
          setCompositionProjectPick(projectId);
        }
      })
      .catch(() => {
        if (!cancelled) setCompositionProjects([]);
      });
    return () => { cancelled = true; };
  }, [showCompositionDialog, projectId, compositionProjectPick]);

  useEffect(() => {
    if (!showCompositionDialog || !compositionProjectPick) {
      setCompositionFigures([]);
      setCompositionFigurePick('');
      setCompositionFiguresLoading(false);
      setCompositionPreviewWarning(null);
      return;
    }
    let cancelled = false;
    setCompositionFiguresLoading(true);
    setCompositionPreviewWarning(null);
    fetch(`/api/projects/${compositionProjectPick}/figures?includePreview=1`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const figures = Array.isArray(data.figures) ? data.figures : [];
        setCompositionFigures(figures);
        setCompositionPreviewWarning(data.previewWarning || null);
        setCompositionFigurePick(prev => figures.some((fig: FigurePickerSummary) => fig.figureId === prev)
          ? prev
          : (figures[0]?.figureId || '')
        );
      })
      .catch(() => {
        if (!cancelled) {
          setCompositionFigures([]);
          setCompositionFigurePick('');
          setCompositionPreviewWarning('Figure 预览加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setCompositionFiguresLoading(false);
      });
    return () => { cancelled = true; };
  }, [showCompositionDialog, compositionProjectPick]);

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
  const historyItems: HistorySnapshot[] = projectId
    ? [
        ...(activeHistory?.past || []),
        {
          editLog: figSession?.editLog || [],
          script: spec.custom_script || '',
          label: '当前状态',
          timestamp: Date.now(),
        },
        ...(activeHistory?.future || []),
      ]
    : specHistory.map((_, index) => ({
        editLog: [],
        script: specHistory[index]?.custom_script || '',
        label: index === 0 ? '初始规格' : `规格步骤 ${index}`,
        timestamp: Date.now(),
      }));

  useEffect(() => {
    const handleRailAction = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'history' && historyMenuEnabled && historyItems.length > 1) {
        setShowHistoryMenu(true);
      }
    };
    window.addEventListener('scifigure:editor-rail-action', handleRailAction);
    return () => window.removeEventListener('scifigure:editor-rail-action', handleRailAction);
  }, [historyItems.length, historyMenuEnabled]);

  const exportMarksByHistoryIndex = useMemo<Map<number, ExportHistoryMark[]>>(() => {
    const marks = new Map<number, ExportHistoryMark[]>();
    if (!projectId || historyItems.length === 0) return marks;
    const normalizeFigureId = (value?: string) => String(value || '').split(':')[0];
    const activeExports = exportHistoryAssets
      .filter(asset => normalizeFigureId(asset.figureId) === activeFigureId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const historyIndexByHash = new Map<string, number>();
    const historyIndexByEditCount = new Map<number, number>();
    historyItems.forEach((item, index) => {
      historyIndexByHash.set(buildEditLogAnchorHash(item.editLog || []), index);
      historyIndexByEditCount.set((item.editLog || []).length, index);
    });
    activeExports.forEach((asset, sequenceIndex) => {
      const markedAsset: ExportHistoryMark = {
        ...asset,
        exportNumber: sequenceIndex + 1,
      };
      let index = typeof asset.editLogHash === 'string'
        ? historyIndexByHash.get(asset.editLogHash)
        : undefined;
      if (index === undefined && typeof asset.editCount === 'number') {
        index = historyIndexByEditCount.get(asset.editCount);
      }
      if (index === undefined && typeof asset.revision === 'number' && Number.isFinite(asset.revision)) {
        index = Math.min(Math.max(0, Math.round(asset.revision) - 1), historyItems.length - 1);
      }
      if (index === undefined) return;
      const existing = marks.get(index) || [];
      existing.push(markedAsset);
      marks.set(index, existing);
    });
    return marks;
  }, [activeFigureId, exportHistoryAssets, historyItems, projectId]);
  const latestExportAssetId = useMemo(() => {
    const allMarks: ExportHistoryMark[] = [];
    exportMarksByHistoryIndex.forEach(group => {
      allMarks.push(...group);
    });
    if (allMarks.length === 0) return null;
    return allMarks
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.assetId || null;
  }, [exportMarksByHistoryIndex]);
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
      `\`\`\`${scriptLanguage === 'r' ? 'r' : 'python'}`,
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

    if (spec.plot_type === 'custom' && !isRScript) {
      const boundRows = currentDataPayload?.custom_data;
      if (!Array.isArray(boundRows) || boundRows.length === 0) {
        onRenderLog([
          `> [错误] 当前自定义脚本未绑定任何上传数据`,
          `> [提示] 请回到“数据导入”页面重新上传，并点击“直接应用代码”或“应用 AI 结果并打开编辑器”。`,
        ]);
        return;
      }
    }
      
    onRenderLog([`> [开始] 调用 ${isRScript ? 'R' : 'Python'} 引擎... ${startedAt.toLocaleTimeString()}`]);
    const res = await onRender(script, currentDataPayload, undefined, scriptLanguage);
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
        res.traceback ? `> [调试] 已返回 ${isRScript ? 'R' : 'Python'} traceback，见下方展开面板。` : '> [调试] 未返回 traceback。',
      ]);
    }
  };

  const handleCodePatch = async () => {
    const startedAt = new Date();
    const startTime = Date.now();
    const script = spec.custom_script || '';

    if (!projectId && spec.plot_type === 'custom' && !isRScript) {
      const boundRows = currentDataPayload?.custom_data;
      if (!Array.isArray(boundRows) || boundRows.length === 0) {
        onRenderLog([
          `> [代码错误] 当前自定义脚本未绑定任何上传数据`,
          `> [提示] 请先回到数据导入页重新应用一次当前数据和脚本。`,
        ]);
        return;
      }
    }
    
    if (isRScript) {
      onRenderLog([`> [R 渲染] 开始执行 R 脚本并预览 SVG... ${startedAt.toLocaleTimeString()}`]);
      if (projectId && onProjectRender) {
        await onProjectRender(script);
        return;
      }
      const res = await onRender(script, currentDataPayload, [], 'r');
      const elapsed = Date.now() - startTime;
      if (res.status === 'success') {
        onRenderLog([
          `> [R 渲染] 渲染成功`,
          `> [完成] 耗时 ${elapsed}ms ✔`,
        ]);
      } else {
        onRenderLog([
          `> [R 错误] ${res.message || '渲染失败'}`,
          res.traceback ? '> [调试] 返回了 R traceback。' : '',
        ].filter(Boolean));
      }
      return;
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

  useEffect(() => {
    if (!projectId || !showHistoryMenu) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/export-assets`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const assets = Array.isArray(data.assets) ? data.assets : [];
        setExportHistoryAssets(assets
          .map((asset: any) => ({
            assetId: String(asset.assetId || asset.id || ''),
            figureId: asset.figureId ? String(asset.figureId) : undefined,
            name: String(asset.name || '未命名导出'),
            format: String(asset.format || '').toUpperCase(),
            createdAt: String(asset.createdAt || asset.exportedAt || ''),
            revision: typeof asset.metadata?.revision === 'number'
              ? asset.metadata.revision
              : typeof asset.revision === 'number'
                ? asset.revision
                : undefined,
            editCount: typeof asset.metadata?.editCount === 'number'
              ? asset.metadata.editCount
              : undefined,
            editLogHash: typeof asset.metadata?.editLogHash === 'string'
              ? asset.metadata.editLogHash
              : undefined,
          }))
          .filter((asset: ExportHistoryAsset) => asset.assetId)
          .sort((a: ExportHistoryAsset, b: ExportHistoryAsset) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
      })
      .catch(() => {
        if (!cancelled) setExportHistoryAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, showHistoryMenu]);

  const handleSave = async ({ silentIfBlocked = false }: { silentIfBlocked?: boolean } = {}) => {
    if (silentIfBlocked && Object.values(projectDrafts).some(drafts => Object.keys(drafts || {}).length > 0)) {
      return;
    }
    const normalizeDraftForFigure = (figId: string, draft: DraftPatch): DraftPatch => {
      if (draft.type === 'code_patch') return draft;
      const object = projectFigures[figId]?.manifest?.objects?.find((item: any) => item.id === draft.gid);
      if (isTextContentPatchProp(draft.prop, object) && draft.mode !== 'backend_patch') {
        return { ...draft, mode: 'backend_patch' };
      }
      return draft;
    };
    const engineDrafts = Object.entries(projectDrafts).flatMap(([figId, drafts]) => (
      draftsRequiringEngineApply(Object.values(drafts || {}).map(draft => normalizeDraftForFigure(figId, draft)))
    ));
    if (engineDrafts.length > 0) {
      if (!silentIfBlocked) {
        alert(`还有 ${engineDrafts.length} 项修改需要先应用并重新渲染；应用完成后才能保存。`);
      }
      return;
    }
    setIsSaving(true);
    try {
      const previewSvg = await generateThumbnail(figSession?.svg);
      const shouldPersistLocalDrafts = !silentIfBlocked;
      const localDraftsByFigure = projectId && shouldPersistLocalDrafts
        ? Object.fromEntries(Object.entries(projectDrafts).map(([figId, drafts]) => [
          figId,
          draftsEligibleForDirectPersistence(Object.values(drafts || {}).map(draft => normalizeDraftForFigure(figId, draft))),
        ]).filter(([, drafts]) => drafts.length > 0))
        : {};
      const figuresToPersist = projectId
        ? Object.entries(projectFigures || {}).map(([figId, figure]: [string, any]) => {
          const localDrafts = localDraftsByFigure[figId] || [];
          const draftEditLog = localDrafts.map(draft => ({
            gid: draft.gid,
            prop: draft.prop,
            value: draft.value,
            mode: draft.mode,
            timestamp: Date.now(),
          }));
          return {
            figureId: figId,
            index: typeof figure.index === 'number' ? figure.index : Number(String(figId).replace(/^fig_/, '')) - 1,
            editLog: [...(figure.editLog || []), ...draftEditLog],
            revision: figure.revision || 1,
            history: projectHistory?.[figId] || { past: [], future: [] },
          };
        })
        : undefined;
      if (projectId) {
        const saveRes = await fetch(`/api/projects/${projectId}`, {
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
            figures: figuresToPersist,
          }),
        });
        const saveData = await saveRes.json().catch(() => null);
        if (!saveRes.ok || saveData?.status === 'error') {
          throw new Error(saveData?.message || '保存失败');
        }
        if (Object.keys(localDraftsByFigure).length > 0) {
          onProjectLocalDraftsPersisted?.(localDraftsByFigure);
        }
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
        void handleSave({ silentIfBlocked: true });
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
    <div className="scifig-main-workspace flex-1 flex flex-col overflow-hidden min-w-0 relative">
      <div className="scifig-workspace-commandbar min-h-14 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-5 shrink-0">
        <div className="flex min-w-0 items-center text-sm text-slate-500 font-medium">
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
            <span className="min-w-0 text-slate-800 font-semibold flex items-center gap-2">
              <span className="max-w-48 truncate">{projectName}</span>
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
                  const isCodeVersion = item.changeType === 'code';
                  const exportMarks = exportMarksByHistoryIndex.get(index) || [];
                  const hasLatestExport = exportMarks.some(asset => asset.assetId === latestExportAssetId);
                  const latestMark = exportMarks
                    .slice()
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
                  const exportNumbers = exportMarks
                    .map(asset => asset.exportNumber)
                    .filter(number => Number.isFinite(number))
                    .sort((a, b) => a - b);
                  const exportNumbersLabel = exportNumbers.length > 0
                    ? exportNumbers.map(number => `第${number}次`).join(' / ')
                    : '已导出';
                  const exportLabel = hasLatestExport
                    ? '上次导出'
                    : exportNumbers.length > 1
                      ? exportNumbersLabel
                      : exportMarks.length === 1
                        ? `第 ${exportNumbers[0] || 1} 次导出`
                        : null;
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
                          {index === 0 && !isCodeVersion ? '0 初始图' : `${index} ${item.label}`}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {isCodeVersion && (
                            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                              代码版本
                            </span>
                          )}
                          {exportLabel && (
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                hasLatestExport
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-slate-100 text-slate-500'
                              }`}
                              title={latestMark
                                ? `${exportNumbersLabel} · ${latestMark.name} · ${latestMark.format} · ${latestMark.createdAt ? new Date(latestMark.createdAt).toLocaleString() : '未知时间'}`
                                : '这个编辑版本曾经导出过'}
                            >
                              {exportLabel}
                            </span>
                          )}
                          {isCurrent && <span className="text-[10px] font-medium text-blue-600">当前</span>}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">
                        {isCodeVersion && item.codeSummary
                          ? `代码 +${item.codeSummary.addedLines}/-${item.codeSummary.removedLines} 行 · `
                          : ''}
                        {editCount} 条图元编辑记录
                        {latestMark && (
                          <span className="ml-1">
                            · {latestMark.format} · {latestMark.createdAt ? new Date(latestMark.createdAt).toLocaleString() : '未知导出时间'}
                          </span>
                        )}
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
            className="scifig-workspace-primary px-3 py-1.5 text-sm font-medium rounded transition-colors flex items-center gap-1.5"
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            保存
          </button>
          <button
            type="button"
            className="scifig-workspace-secondary px-3 py-1.5 text-sm font-medium rounded transition-colors flex items-center gap-2 whitespace-nowrap"
            onClick={handleRender}
            disabled={isRendering}
          >
            {isRendering ? '渲染中...' : '同步至引擎并预览 SVG'}
          </button>
          {spec.plot_type === 'custom' && (
            <div className="hidden 2xl:block px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded whitespace-nowrap">
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
        <div data-testid="workspace-view-tabs" className="scifig-workspace-tabs relative z-10 flex items-center gap-2 px-2 py-1.5 rounded-t-lg border border-b-0 overflow-hidden">
          <div className="relative z-10 flex shrink-0 items-center gap-3 bg-white px-2">
            <div className="flex shrink-0 gap-4">
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
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-x-auto overscroll-x-contain pl-2">
            {selectedObject !== 'Figure' && (
              <div
                className="flex max-w-[300px] shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-slate-200 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white shadow-sm"
                title={`当前选中对象：${selectedObject}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-blue-300" />
                <span className="truncate text-blue-100">{selectedObject}</span>
                <span className="shrink-0 font-normal text-slate-300">右侧编辑</span>
              </div>
            )}
            <div className="hidden xl:flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100 mr-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              实时渲染
              <div className="w-3.5 h-3.5 rounded-full border border-emerald-300 text-emerald-500 flex items-center justify-center ml-0.5 text-[9px]">?</div>
            </div>
            {spec.plot_type === 'custom' && (
              <div className="hidden 2xl:block shrink-0 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full whitespace-nowrap">
                真实 SVG 对象可直接编辑；全局参数改完后再重新渲染
              </div>
            )}
            {figSession?.svg && (
              <button
                type="button"
                onClick={() => setDragEditMode(prev => !prev)}
                className={`text-xs font-semibold rounded-full border px-2 py-1 transition-colors ${
                  dragEditMode
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                title="开启后，可拖动已选文本/标签；确认后再重渲染写回。"
              >
                拖拽微调 {dragEditMode ? '开' : '关'}
              </button>
            )}
            {activeTab === 'preview' && (
              <>
                <button
                  type="button"
                  onClick={() => setShowWordA4Preview(prev => !prev)}
                  className={`text-xs font-semibold rounded-full border px-2 py-1 transition-colors ${
                    showWordA4Preview
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  title="打开/关闭 Word A4 旁路预览；不影响当前图元编辑。"
                >
                  A4旁览 {showWordA4Preview ? '开' : '关'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowWordA4ReadingPreview(true)}
                  className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                  title="打开接近 Word 打印布局的大页面预览，用于判断真实字号和版面。"
                >
                  Word真实预览
                </button>
              </>
            )}
            {figSession?.updatedAt && <div className="hidden xl:block shrink-0 text-xs text-slate-500 whitespace-nowrap">最近渲染 {new Date(figSession.updatedAt).toLocaleTimeString()}</div>}
            <button
              type="button"
              onClick={() => setShowBottomPanel(prev => !prev)}
              className={`rounded-full border px-2 py-1 text-xs font-semibold transition-colors ${
                showBottomPanel
                  ? 'border-slate-300 bg-slate-100 text-slate-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
              title={showBottomPanel ? '收起底部代码 / 日志面板，扩大画布' : '展开底部代码 / 日志面板'}
            >
              {showBottomPanel ? '收起代码面板' : '代码面板'}
            </button>
          </div>
        </div>

        {activeTab === 'preview' && projectId && projectFigures && Object.keys(projectFigures).length > 0 && (
          <div className="flex min-h-0 items-center gap-2 border-x border-t border-slate-200 bg-white px-3 py-1.5">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Figure</span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50/80 p-0.5">
              {Object.keys(projectFigures).map(figId => (
                <div
                  key={figId}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold transition-colors ${activeFigureId === figId ? 'bg-white text-blue-700 shadow-sm ring-1 ring-blue-100' : 'text-slate-500 hover:bg-white hover:text-slate-700'}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`选择 Figure ${figId.split('_')[1]} 作为批量应用目标`}
                    checked={selectedFigureIds.includes(figId)}
                    onChange={() => toggleSelectedFigure(figId)}
                    onClick={(event) => event.stopPropagation()}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => handleFigureTabSelect(figId)}
                    className="font-semibold"
                  >
                    Figure {figId.split('_')[1]}
                  </button>
                </div>
              ))}
            </div>
            {figureSwitchWarning && (
              <div
                data-testid="figure-switch-drag-guard"
                className="min-w-0 max-w-[360px] truncate rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800"
                title={figureSwitchWarning}
              >
                {figureSwitchWarning}
              </div>
            )}
            <button
              type="button"
              onClick={openCompositionProjectDialog}
              className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
              title="把当前勾选 Figure 和其他项目 Figure 一起生成新组合代码项目，并复制数据文件。"
            >
              组合代码项目
            </button>
          </div>
        )}

        <div
          className={`scifig-canvas-stage flex-1 border-l border-r border-b relative overflow-auto rounded-b-lg flex items-center justify-center custom-scrollbar min-h-[300px] ${
            activeTab === 'preview' ? 'p-0' : 'p-8'
          }`}
        >
          {activeTab === 'preview' && (
            <div className="flex h-full w-full min-w-0 overflow-hidden">
              <div className="relative h-full min-w-0 flex-1">
                <ChartPreview
                  spec={spec}
                  onSpecChange={onSpecChange}
                  selectedObject={selectedObject}
                  onSelectObject={onSelectObject}
                  selectedGids={selectedGids}
                  onSelectGids={onSelectGids}
                  renderedSVG={figSession?.svg ?? null}
                  onPatch={onPatch}
                  onImmediatePatch={onImmediatePatch}
                  figSession={figSession}
                  dragMode={dragEditMode}
                  onPendingPositionCountChange={setPendingDragCount}
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
              </div>
              {showWordA4Preview && (
                <div className="h-full w-[520px] max-w-[45%] shrink-0 border-l border-slate-200 bg-white shadow-[-8px_0_18px_rgba(15,23,42,0.08)]">
                  <WordA4Preview spec={spec} figSession={figSession} compact />
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
                  if (!file || !/\.(py|r)$/i.test(file.name)) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    onSpecChange({
                      ...spec,
                      script_language: updateScriptLanguageFromFile(file.name),
                      custom_script: ev.target?.result as string || '',
                    });
                  };
                  reader.readAsText(file);
                }}
              >
                {scriptDragOver && (
                  <div className="absolute inset-0 z-20 bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
                    <span className="text-blue-700 font-semibold text-lg bg-white/80 px-4 py-2 rounded shadow">松开以上传 .py / .R 文件</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 border-b border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200">
                  <div className="font-semibold">脚本语言</div>
                  <select
                    value={scriptLanguage}
                    onChange={(e) => onSpecChange({ ...spec, script_language: e.target.value as 'python' | 'r' })}
                    className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white outline-none"
                  >
                    <option value="python">Python / Matplotlib</option>
                    <option value="r">R / ggplot2 或 base plot</option>
                  </select>
                </div>
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
                        onClick={() => { void copyWorkspaceText(activeCodeSlice.code || ''); }}
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
                    defaultLanguage={isRScript ? 'r' : 'python'}
                    language={isRScript ? 'r' : 'python'}
                    theme="vs-dark"
                    value={spec.custom_script || ''}
                    onChange={value => onSpecChange({ ...spec, custom_script: value || '' }, { recordHistory: false })}
                    options={{ minimap: { enabled: false }, fontSize: 13 }}
                  />
                </div>
                <div className="flex justify-end gap-2 p-3 bg-slate-800 border-t border-slate-700 shrink-0 z-10">
                  <input
                    type="file"
                    accept=".py,.r,.R"
                    className="hidden"
                    id="py-upload-editor"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        onSpecChange({
                          ...spec,
                          script_language: updateScriptLanguageFromFile(file.name),
                          custom_script: ev.target?.result as string || '',
                        }, { recordHistory: false });
                      };
                      reader.readAsText(file);
                      e.target.value = '';
                    }}
                  />
                  <label
                    htmlFor="py-upload-editor"
                    className="px-3 py-1.5 bg-slate-600 text-white rounded text-sm font-medium hover:bg-slate-500 transition-colors cursor-pointer"
                  >
                    上传 .py / .R 文件
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

        {showBottomPanel && (
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
                onClick={() => { void copyWorkspaceText(activeScript); }}
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
              <ManifestViewer manifest={figSession?.manifest ?? null} debugModel={debugModel} />
            )}
          </div>
        </div>
        )}
      </div>

      <div className="h-8 shrink-0 bg-white border-t border-slate-200 flex items-center justify-between px-4 text-xs font-medium text-slate-500">
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          <span>已连接</span>
        </div>
        <div className="flex items-center gap-4">
          <span>{lastSaved ? `最后保存: ${lastSaved.toLocaleString()}` : '尚未保存'}</span>
          <span className="flex items-center gap-1"><UploadCloud className="w-3 h-3" /> 自动保存已开启 (5s)</span>
        </div>
      </div>

      {showCompositionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-sm">
          <div data-testid="composition-project-dialog" className="flex max-h-[94vh] w-[min(1500px,96vw)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">创建组合代码项目</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  可从多个项目加入 Figure。系统会复制源数据文件，生成给网页 AI 的转写提示词，要求组合图中每个子图绘图区尺寸一致。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCompositionDialog(false)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="关闭组合代码项目弹窗"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(620px,0.95fr)_minmax(520px,1.05fr)] lg:overflow-hidden">
              <div className="shrink-0 space-y-4 border-b border-slate-200 bg-slate-50 p-5 lg:min-h-0 lg:overflow-auto lg:border-b-0 lg:border-r">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-600">新项目名称</label>
                  <input
                    value={compositionName}
                    onChange={event => setCompositionName(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder="组合代码项目"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-2 text-xs font-semibold text-slate-600">
                    子图框宽(in)
                    <input
                      type="number"
                      min={0.5}
                      max={12}
                      step={0.1}
                      value={compositionAxesWidth}
                      onChange={event => setCompositionAxesWidth(Number(event.target.value))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <label className="space-y-2 text-xs font-semibold text-slate-600">
                    子图框高(in)
                    <input
                      type="number"
                      min={0.5}
                      max={12}
                      step={0.1}
                      value={compositionAxesHeight}
                      onChange={event => setCompositionAxesHeight(Number(event.target.value))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-slate-600">布局要求</label>
                  <select
                    value={compositionLayout}
                    onChange={event => setCompositionLayout(event.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="auto">自动推荐：{compositionPlan.layoutKey}</option>
                    <option value={`1x${Math.max(1, compositionSources.length)}`}>单行 {`1x${Math.max(1, compositionSources.length)}`}</option>
                    <option value={`${Math.max(1, compositionSources.length)}x1`}>单列 {`${Math.max(1, compositionSources.length)}x1`}</option>
                    <option value="2x2">2x2</option>
                    <option value="2x3">2x3</option>
                    <option value="3x2">3x2</option>
                    <option value="2x4">2x4</option>
                    <option value="4x2">4x2</option>
                    <option value="3x3">3x3</option>
                  </select>
                  <div className="text-[11px] text-slate-500">
                    实际提交：<span className="font-semibold text-emerald-700">{compositionPlan.layoutKey}</span>
                    {' · '}预计 {compositionPlan.estimatedWidthIn} × {compositionPlan.estimatedHeightIn} in
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="mb-3 text-xs font-bold text-slate-700">从其他项目加入 Figure</div>
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        value={compositionProjectSearch}
                        onChange={event => setCompositionProjectSearch(event.target.value)}
                        placeholder="搜索来源项目"
                        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-2 text-xs outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div className="flex gap-1 overflow-x-auto pb-1">
                      {[
                        ['all', '全部'],
                        ['single_figure', '单图'],
                        ['multi_figure', '多图'],
                        ['composition_code', '组合项目'],
                      ].map(([value, label]) => (
                        <button
                          type="button"
                          key={value}
                          onClick={() => setCompositionProjectType(value as typeof compositionProjectType)}
                          className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${compositionProjectType === value ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500 hover:text-slate-700'}`}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setCompositionRecentOnly(value => !value)}
                        className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${compositionRecentOnly ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500 hover:text-slate-700'}`}
                      >
                        最近使用
                      </button>
                    </div>
                    <div className="grid max-h-32 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                      {filteredCompositionProjects.map(project => (
                        <button
                          type="button"
                          key={project.id}
                          data-composition-project-id={project.id}
                          onClick={() => selectCompositionProject(project.id)}
                          className={`min-w-0 rounded-md border px-2 py-2 text-left ${compositionProjectPick === project.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                        >
                          <div className="truncate text-[11px] font-semibold text-slate-800" title={project.name}>{project.name}</div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                            <span>{project.project_type_label || '项目'} · {formatCompositionProjectUpdatedAt(project.updated_at)}</span>
                            <span>{project.figure_count || 0} Figure</span>
                          </div>
                        </button>
                      ))}
                      {filteredCompositionProjects.length === 0 && (
                        <div className="col-span-2 rounded-md border border-dashed border-slate-300 px-3 py-4 text-center text-[11px] text-slate-400">没有匹配的项目</div>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold text-slate-600">可视化选择 Figure</div>
                        {compositionFiguresLoading && <div className="text-[11px] text-blue-600">生成预览中...</div>}
                      </div>
                      {compositionPreviewWarning && (
                        <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-relaxed text-amber-700">
                          {compositionPreviewWarning}
                        </div>
                      )}
                      {!compositionFiguresLoading && compositionFigures.length === 0 && (
                        <div className="rounded border border-dashed border-slate-300 bg-white px-3 py-5 text-center text-[11px] text-slate-400">
                          当前项目还没有可选择的 Figure；请先打开项目并渲染。
                        </div>
                      )}
                      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-auto pr-1">
                        {compositionFigures.map(figure => {
                          const selected = compositionFigurePick === figure.figureId;
                          return (
                            <button
                              type="button"
                              key={`${compositionProjectPick}:${figure.figureId}`}
                              data-composition-figure-id={figure.figureId}
                              onClick={() => setCompositionFigurePick(figure.figureId)}
                              className={`overflow-hidden rounded-lg border bg-white text-left transition-all ${
                                selected
                                  ? 'border-blue-400 ring-2 ring-blue-100'
                                  : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-2 py-1.5">
                                <span className="text-[11px] font-bold text-slate-700">{figure.figureId}</span>
                                <span className="text-[10px] text-slate-400">{figure.language?.toUpperCase() || 'CODE'} · rev {figure.revision || 1}</span>
                              </div>
                              <div className="flex h-28 items-center justify-center bg-[radial-gradient(#d7dce5_1px,transparent_1px)] bg-[length:12px_12px] p-2">
                                {figure.svg ? (
                                  <SanitizedSvgPreview
                                    svg={figure.svg}
                                    defer
                                    className="pointer-events-none max-h-full max-w-full overflow-hidden rounded bg-white shadow-sm [&>svg]:h-24 [&>svg]:w-full [&>svg]:max-w-full"
                                  />
                                ) : (
                                  <div className="text-center text-[11px] leading-relaxed text-slate-400">
                                    无预览
                                    <br />
                                    仍可加入
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1 border-t border-slate-100 px-2 py-1.5 text-[9px] text-slate-500">
                                <span>{figure.subplotCount || 0} 子图</span>
                                {Number.isFinite(figure.aspectRatio) && <span>· 比例 {Number(figure.aspectRatio).toFixed(2)}:1</span>}
                                {figure.hasLegend && <span>· 图例</span>}
                                {figure.hasColorbar && <span>· 色条</span>}
                                <span>· {figure.dataFileCount || 0} 文件</span>
                                <span>· {figure.codeSlice ? '代码片段' : '脚本回退'}</span>
                                {figure.dependencyStatus === 'missing' && <span className="font-semibold text-red-600">· 缺数据</span>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={addPickedCompositionSource}
                      disabled={!compositionProjectPick || !compositionFigurePick}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      加入来源 Figure
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-bold text-slate-700">已加入来源 ({compositionSources.length})</div>
                  {compositionSourceNotice && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-medium text-amber-800">{compositionSourceNotice}</div>
                  )}
                  <div className="space-y-2">
                    {compositionSources.length === 0 && (
                      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-400">
                        尚未加入 Figure
                      </div>
                    )}
                    {compositionSources.map((source, sourceIndex) => (
                      <div
                        key={makeSourceKey(source)}
                        data-composition-source-key={makeSourceKey(source)}
                        data-composition-source-index={sourceIndex}
                        draggable
                        onDragStart={() => setCompositionDraggingKey(makeSourceKey(source))}
                        onDragEnd={() => setCompositionDraggingKey(null)}
                        onDragOver={event => event.preventDefault()}
                        onDrop={() => dropCompositionSource(sourceIndex)}
                        className={`flex gap-2 rounded-lg border bg-white p-2 ${compositionDraggingKey === makeSourceKey(source) ? 'border-emerald-400 opacity-60' : 'border-slate-200'}`}
                      >
                        <div className="flex w-5 shrink-0 cursor-grab flex-col items-center gap-1 text-slate-400" title="拖动调整组合顺序">
                          <GripVertical className="h-4 w-4" />
                          <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-900 text-[10px] font-bold text-white">
                            {String.fromCharCode(97 + Math.min(sourceIndex, 25))}
                          </span>
                        </div>
                        <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-100 bg-slate-50">
                          {source.svg ? (
                            <SanitizedSvgPreview
                              svg={source.svg}
                              defer
                              className="pointer-events-none max-h-full max-w-full [&>svg]:h-12 [&>svg]:w-full"
                            />
                          ) : (
                            <span className="text-[10px] text-slate-400">无预览</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold text-slate-800">{source.projectName}</div>
                          <div className="text-[11px] text-slate-500">{source.figureId}{source.codeSlice ? ' · 使用代码片段' : ' · 使用项目脚本回退'}</div>
                          <div className="mt-1 text-[10px] text-slate-400">
                            位置 {Math.floor(sourceIndex / compositionPlan.cols) + 1} 行 {(sourceIndex % compositionPlan.cols) + 1} 列
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-0.5">
                          <button type="button" disabled={sourceIndex === 0} onClick={() => moveCompositionSource(sourceIndex, sourceIndex - 1)} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-25" aria-label={`上移 ${source.projectName} ${source.figureId}`}><ArrowUp className="h-3 w-3" /></button>
                          <button type="button" disabled={sourceIndex === compositionSources.length - 1} onClick={() => moveCompositionSource(sourceIndex, sourceIndex + 1)} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-25" aria-label={`下移 ${source.projectName} ${source.figureId}`}><ArrowDown className="h-3 w-3" /></button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeCompositionSource(source)}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          aria-label={`移除 ${source.projectName} ${source.figureId}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex min-h-[620px] shrink-0 flex-col p-5 lg:min-h-0">
                <div className="mb-4 grid shrink-0 gap-3 xl:grid-cols-[minmax(280px,0.8fr)_minmax(240px,1fr)]">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-bold text-slate-800">组合意图预览</div>
                        <div className="mt-0.5 text-[10px] text-slate-500">阅读顺序决定提示词位置与 panel label</div>
                      </div>
                      <span data-testid="composition-resolved-layout" className="rounded bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-800">{compositionPlan.layoutKey}</span>
                    </div>
                    <div
                      className="mt-3 grid gap-1.5"
                      style={{ gridTemplateColumns: `repeat(${compositionPlan.cols}, minmax(0, 1fr))` }}
                    >
                      {Array.from({ length: compositionPlan.rows * compositionPlan.cols }, (_, index) => {
                        const source = compositionSources[index];
                        return (
                          <div key={index} className="relative flex aspect-[1.2] min-h-12 items-center justify-center overflow-hidden rounded border border-slate-200 bg-white">
                            {source?.svg ? (
                              <SanitizedSvgPreview svg={source.svg} defer className="pointer-events-none h-full w-full [&>svg]:h-full [&>svg]:w-full" />
                            ) : source ? (
                              <span className="px-1 text-center text-[9px] text-slate-500">{source.figureId}</span>
                            ) : (
                              <span className="text-[9px] text-slate-300">空位</span>
                            )}
                            {source && (
                              <span className="absolute left-1 top-1 rounded bg-slate-950 px-1 py-0.5 text-[8px] font-bold text-white">
                                ({String.fromCharCode(97 + Math.min(index, 25))})
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-600">
                      <div className="rounded border border-slate-200 bg-white px-2 py-1.5">绘图区 {compositionAxesWidth} × {compositionAxesHeight} in</div>
                      <div className="rounded border border-slate-200 bg-white px-2 py-1.5">整体约 {compositionPlan.estimatedWidthIn} × {compositionPlan.estimatedHeightIn} in</div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                      创建前检查
                    </div>
                    <div data-testid="composition-risk-list" className="mt-2 max-h-36 space-y-1.5 overflow-y-auto">
                      {compositionRisks.length === 0 && (
                        <div className="rounded bg-emerald-50 px-2 py-2 text-[10px] font-semibold text-emerald-700">未检测到明显冲突</div>
                      )}
                      {compositionRisks.map(risk => (
                        <div key={risk.code} className={`rounded border px-2 py-1.5 text-[10px] leading-relaxed ${risk.level === 'error' ? 'border-red-200 bg-red-50 text-red-700' : risk.level === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                          {risk.message}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 border-t border-slate-100 pt-2 text-[10px] leading-5 text-slate-500">
                      {compositionSources.length} Figure · {new Set(compositionSources.map(source => source.projectId)).size} 项目 · {compositionSources.reduce((sum, source) => sum + (source.dataFileCount || 0), 0)} 个来源数据文件
                    </div>
                  </div>
                </div>
                {compositionError && (
                  <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                    {compositionError}
                  </div>
                )}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-slate-900">AI 转写提示词</div>
                    <div className="mt-1 text-xs text-slate-500">
                      创建后会自动复制到剪贴板；也可以手动复制。
                      {compositionCopyStatus && (
                        <span className={`ml-2 font-semibold ${compositionCopyStatus.startsWith('已') ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {compositionCopyStatus}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {compositionPrompt && (
                      <button
                        type="button"
                        onClick={() => void copyCompositionPrompt()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制提示词
                      </button>
                    )}
                    {compositionCreatedProject && onLoadProject && (
                      <button
                        type="button"
                        onClick={openCreatedCompositionProject}
                        disabled={compositionLoading}
                        className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                      >
                        打开新项目
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={createCompositionProject}
                      data-testid="create-composition-project"
                      disabled={compositionLoading || compositionSources.length === 0 || compositionHasBlockingRisk}
                      className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {compositionLoading ? '处理中...' : '创建并生成提示词'}
                    </button>
                  </div>
                </div>
                <textarea
                  value={compositionPrompt || '点击“创建并生成提示词”后，这里会显示可交给网页 AI 的完整提示词。'}
                  readOnly
                  className="min-h-0 flex-1 resize-none rounded-xl border border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100 outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {showWordA4ReadingPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-5 backdrop-blur-sm">
          <div className="flex h-[94vh] w-[min(1280px,96vw)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
              <div>
                <div className="text-sm font-bold text-slate-900">Word 真实阅读预览</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  用大页面视图校准 Word 100% 视觉大小；关闭后回到编辑器，当前图仍保持同步。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWordA4ReadingPreview(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              >
                <X className="h-3.5 w-3.5" />
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <WordA4Preview spec={spec} figSession={figSession} readingMode />
            </div>
          </div>
        </div>
      )}

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
              <SanitizedSvgPreview
                svg={figSession.svg}
                className="bg-white shadow-xl border border-slate-200"
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
