import { useEffect, useMemo, useState } from 'react';
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
import { ProjectsPage } from './components/ProjectsPage';
import { DataFilesPage } from './components/DataFilesPage';
import { SettingsPage } from './components/SettingsPage';
import { FigureSpec, defaultSpec, DatasetEntry, FigureEntry } from './types';
import { useFigureSession } from './hooks/useFigureSession';
import type { FigureSession, EditEntry, PatchEntry } from './schemas/manifest';
import './index.css';

export type ViewState = 'home' | 'templates' | 'data_import' | 'editor' | 'workspace' | 'export_settings' | 'projects' | 'data' | 'settings';

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
  datasets?: DatasetEntry[];
}

function cloneSpec(spec: FigureSpec): FigureSpec {
  return JSON.parse(JSON.stringify(spec)) as FigureSpec;
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
    };
  }
}

export default function App() {
  const initialState = useMemo(() => loadInitialState(), []);
  const [spec, setSpec] = useState<FigureSpec>(initialState.spec);
  const [currentView, setCurrentView] = useState<ViewState>('home');
  const [subView, setSubView] = useState<string>('home');
  const [selectedObject, setSelectedObject] = useState<string>('Figure');
  const [projectId, setProjectId] = useState<string | null>(initialState.projectId);
  const [projectName, setProjectName] = useState<string>(initialState.projectName);
  const [specHistory, setSpecHistory] = useState<FigureSpec[]>(initialState.history);
  const [historyIndex, setHistoryIndex] = useState<number>(initialState.historyIndex);
  const [lockedObjects, setLockedObjects] = useState<Set<string>>(new Set());

  // V3.2A Project Layer States
  const [projectFigures, setProjectFigures] = useState<Record<string, FigureEntry>>(initialState.projectFigures ?? {});
  const [activeFigureId, setActiveFigureId] = useState<string>(initialState.activeFigureId ?? 'fig_1');
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

  // Virtual active session wrapper for project mode
  const activeFig = projectId && projectFigures[activeFigureId] ? projectFigures[activeFigureId] : null;
  const figSession: FigureSession | null = projectId 
    ? (activeFig ? {
        sessionId: `${projectId}_${activeFigureId}`,
        script: spec.custom_script || '',
        dataPayload: { datasets } as any,
        editLog: activeFig.editLog,
        revision: activeFig.revision,
        svg: activeFig.svg || '',
        manifest: activeFig.manifest || { objects: [], palettes: [], groups: [], bindings: [] },
        createdAt: Date.now(),
        updatedAt: Date.now()
      } : null)
    : hookSession;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const nextState: PersistedAppState = {
      spec,
      history: specHistory,
      historyIndex,
      projectId,
      projectName,
      figSession: hookSession,
      renderLog,
      projectFigures,
      activeFigureId,
      datasets,
    };
    window.sessionStorage.setItem(SPEC_STORAGE_KEY, JSON.stringify(nextState));
  }, [spec, specHistory, historyIndex, projectId, projectName, hookSession, renderLog, projectFigures, activeFigureId, datasets]);

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
    if (projectId) {
      // Direct patch post to leverage transparent project-session mapping on backend
      try {
        const res = await fetch('/api/figure/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: `${projectId}_${activeFigureId}`,
            patches
          })
        });
        const data = await res.json();
        if (data.status === 'success') {
          setProjectFigures(prev => {
            const next = { ...prev };
            const active = next[activeFigureId];
            if (active) {
              next[activeFigureId] = {
                ...active,
                svg: data.svg || active.svg,
                manifest: data.manifest || active.manifest,
                editLog: data.editLog || active.editLog,
                revision: data.revision || active.revision + 1
              };
            }
            return next;
          });

          // Handle color mapping update inside spec for AST sync
          const codePatches = patches.filter((p: any) => p.type === 'code_patch');
          if (codePatches.length > 0) {
            const nextSpec = cloneSpec(spec);
            if (!nextSpec.colors) nextSpec.colors = {};
            codePatches.forEach((cp: any) => {
              const palettes = projectFigures[activeFigureId]?.manifest?.palettes || [];
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
        }
        return data;
      } catch (err: any) {
        return { status: 'error', message: err.message };
      }
    } else {
      const res = await patch(patches);
      if (res.status === 'success') {
        const codePatches = patches.filter((p: any) => p.type === 'code_patch');
        if (codePatches.length > 0) {
          const nextSpec = cloneSpec(spec);
          if (!nextSpec.colors) {
            nextSpec.colors = {};
          }
          nextSpec.colors = { ...nextSpec.colors };
          codePatches.forEach((cp: any) => {
            const palettes = figSession?.manifest?.palettes || [];
            const palette = palettes.find(p => p.id === cp.target_id);
            if (palette && palette.label) {
              nextSpec.colors[palette.label] = cp.new_value as string;
            }
          });

          if (res.script) {
            nextSpec.custom_script = res.script;
          } else if (figSession?.script) {
            nextSpec.custom_script = figSession.script;
          }

          applySpecChange(nextSpec);
        }
      }
      return res;
    }
  };

  const handleCodePatch = async (script: string, force?: boolean) => {
    if (projectId) {
      try {
        const res = await fetch('/api/figure/code-patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: `${projectId}_${activeFigureId}`,
            script,
            force
          })
        });
        const data = await res.json();
        if (data.status === 'success') {
          setProjectFigures(prev => {
            const next = { ...prev };
            const active = next[activeFigureId];
            if (active) {
              next[activeFigureId] = {
                ...active,
                svg: data.svg || active.svg,
                manifest: data.manifest || active.manifest,
                editLog: data.editLog || active.editLog,
                revision: data.revision || active.revision + 1
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
        }
        return data;
      } catch (err: any) {
        return { status: 'error', message: err.message };
      }
    } else {
      const res = await codePatch(script, force);
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

  const handleUndo = async () => {
    if (historyIndex > 0) {
      const prevSpec = specHistory[historyIndex - 1];
      setHistoryIndex(prev => prev - 1);
      setSpec(cloneSpec(prevSpec));

      const payload = prevSpec.raw_data?.custom_data
        ? { custom_data: prevSpec.raw_data.custom_data }
        : null;

      if (prevSpec.plot_type === 'custom' && prevSpec.custom_script) {
        void render(prevSpec.custom_script, payload);
      }
    } else {
      await undoFigureEdit();
    }
  };

  const handleRedo = async () => {
    if (historyIndex < specHistory.length - 1) {
      const nextSpec = specHistory[historyIndex + 1];
      setHistoryIndex(prev => prev + 1);
      setSpec(cloneSpec(nextSpec));

      const payload = nextSpec.raw_data?.custom_data
        ? { custom_data: nextSpec.raw_data.custom_data }
        : null;

      if (nextSpec.plot_type === 'custom' && nextSpec.custom_script) {
        void render(nextSpec.custom_script, payload);
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
        revision: f.revision || 1
      };
    });
    setProjectFigures(nextFigs);

    if (figList.length > 0) {
      setActiveFigureId(figList[0].figureId);
    } else {
      setActiveFigureId('fig_1');
    }

    handleNavigate('editor');

    // Trigger render to fetch SVGs and manifests
    setRenderLog(['> 项目已加载，正在调用渲染引擎重建多图...']);
    setTimeout(() => {
      void handleProjectRender(cleanSpec.custom_script);
    }, 100);
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

  // V3.2A Project Render Handler
  const handleProjectRender = async (customScriptToUse?: string) => {
    if (!projectId) return;
    // Set mock hook states for UI compatibility
    setSpec(prev => {
      const next = cloneSpec(prev);
      if (customScriptToUse !== undefined) {
        next.custom_script = customScriptToUse;
      }
      return next;
    });
    
    // Set isRendering local logic (since hook is bypassed)
    // We can simulate rendering logs on App
    const startedAt = new Date();
    setRenderLog(prev => [...prev, `> [开始] 调用 Python 引擎进行多图渲染... ${startedAt.toLocaleTimeString()}`]);
    
    const scriptToRender = customScriptToUse ?? spec.custom_script ?? '';
    
    // Construct editLogs map
    const editLogs: Record<string, any[]> = {};
    Object.keys(projectFigures).forEach(figId => {
      editLogs[figId] = projectFigures[figId].editLog;
    });

    try {
      const res = await fetch(`/api/projects/${projectId}/figures/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: scriptToRender,
          editLogs
        })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setRenderLog(prev => [...prev, `> [引擎] 渲染成功，共捕获 ${data.figures?.length || 0} 张 Figure`]);
        
        const nextFigures: Record<string, FigureEntry> = {};
        const figuresList = data.figures || [];
        figuresList.forEach((f: any) => {
          nextFigures[f.figureId] = {
            figureId: f.figureId,
            index: f.figureId === 'fig_1' ? 0 : parseInt(f.figureId.split('_')[1]) - 1,
            manifest: f.manifest,
            svg: f.svg,
            editLog: editLogs[f.figureId] || [],
            revision: 1
          };
        });
        setProjectFigures(nextFigures);
        if (figuresList.length > 0 && !nextFigures[activeFigureId]) {
          setActiveFigureId(figuresList[0].figureId);
        }
      } else {
        // Bubble rendering error
        setRenderLog(prev => [...prev, `> [错误] ${data.message}`]);
      }
    } catch (err: any) {
      setRenderLog(prev => [...prev, `> [异常] ${err.message}`]);
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
  };

  const handleRenderLog = (lines: string[]) => {
    setRenderLog(prev => [...prev, ...lines]);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white text-slate-900 font-sans selection:bg-blue-100">
      <Navbar currentView={currentView} onNavigate={handleNavigate} />
      
      <div className="flex flex-1 overflow-hidden relative">
        {(currentView === 'editor' || currentView === 'workspace') && (
          <>
            <IconSidebar />
             <LeftSidebar
              spec={spec}
              selectedObject={selectedObject}
              onSelectObject={setSelectedObject}
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
              onSelectObject={setSelectedObject}
              projectId={projectId}
              projectName={projectName}
              onProjectChange={(id, name) => { setProjectId(id); setProjectName(name); }}
              specHistory={specHistory}
              historyIndex={historyIndex}
              canUndoFigure={canUndoFigure}
              canRedoFigure={canRedoFigure}
              onUndo={handleUndo}
              onRedo={handleRedo}
              figSession={figSession}
              isRendering={isRendering}
              renderError={renderError}
              renderTraceback={renderTraceback}
              renderLog={renderLog}
              onRenderLog={handleRenderLog}
              onRender={render}
              onPatch={handlePatch}
              onCodePatch={handleCodePatch}
              projectFigures={projectFigures}
              activeFigureId={activeFigureId}
              onSelectFigure={(figId) => setActiveFigureId(figId)}
              onProjectRender={handleProjectRender}
            />
            <RightSidebar
              figSession={figSession}
              selectedObject={selectedObject}
              onSelectObject={setSelectedObject}
              onPatch={handlePatch}
              lockedObjects={lockedObjects}
            />
          </>
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
              onSelectObject={setSelectedObject}
              figSession={figSession}
            />
            <ExportSettingsPage spec={spec} onNavigate={(v) => handleNavigate(v)} onSpecChange={applySpecChange} figSession={figSession} />
          </>
        )}
      </div>
    </div>
  );
}
