import { useCallback, useRef, useState } from 'react';
import type {
  CodePatchResponse,
  EditEntry,
  FigureSession,
  PatchEntry,
  LocalPatchEntry,
  PatchResponse,
  RenderResponse,
} from '../schemas/manifest';
import { applyRuntimePatchesToManifest, applyRuntimePatchesToSvg } from '../utils/svgEditor';

interface FigureHistoryState {
  past: EditEntry[][];
  future: EditEntry[][];
}

interface UseFigureSessionReturn {
  session: FigureSession | null;
  isRendering: boolean;
  renderError: string | null;
  renderTraceback: string | null;
  canUndoFigure: boolean;
  canRedoFigure: boolean;
  render: (script: string, dataPayload?: Record<string, unknown> | null, initialEditLog?: EditEntry[]) => Promise<RenderResponse>;
  patch: (patches: PatchEntry[]) => Promise<PatchResponse>;
  codePatch: (script: string, force?: boolean) => Promise<CodePatchResponse>;
  undoFigureEdit: () => Promise<boolean>;
  redoFigureEdit: () => Promise<boolean>;
  reset: () => void;
}

function cloneEditLog(editLog: EditEntry[]) {
  return editLog.map((entry) => ({ ...entry }));
}

function buildPatchedSession(
  session: FigureSession,
  patches: LocalPatchEntry[],
  nextEditLog: EditEntry[],
): FigureSession {
  const runtimePatches = patches.map(({ gid, prop, value }) => ({ gid, prop, value }));
  return {
    ...session,
    editLog: nextEditLog,
    manifest: applyRuntimePatchesToManifest(session.manifest, runtimePatches),
    svg: applyRuntimePatchesToSvg(session.svg, runtimePatches),
    revision: session.revision + 1,
    updatedAt: Date.now(),
  };
}

export function useFigureSession(initialSession?: FigureSession | null): UseFigureSessionReturn {
  const [session, setSession] = useState<FigureSession | null>(initialSession ?? null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderTraceback, setRenderTraceback] = useState<string | null>(null);
  const [history, setHistory] = useState<FigureHistoryState>({ past: [], future: [] });
  const abortRef = useRef<AbortController | null>(null);

  const resolveDataPayload = useCallback(
    (incoming?: Record<string, unknown> | null) => {
      if (incoming !== undefined) {
        return incoming;
      }
      return session?.dataPayload ?? null;
    },
    [session]
  );

  const syncFigureState = useCallback(async (targetEditLog: EditEntry[]) => {
    if (!session) {
      return false;
    }

    setIsRendering(true);
    setRenderError(null);
    setRenderTraceback(null);

    try {
      const res = await fetch('/api/figure/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: session.script,
          dataPayload: session.dataPayload,
          editLog: targetEditLog,
        }),
      });
      const data: RenderResponse & { traceback?: string } = await res.json();
      if (data.status !== 'success') {
        setRenderError(data.message || 'Render failed');
        setRenderTraceback(data.traceback || null);
        return false;
      }

      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sessionId: data.sessionId || prev.sessionId,
          editLog: data.editLog || targetEditLog,
          manifest: data.manifest,
          svg: data.svg,
          revision: data.revision,
          updatedAt: Date.now(),
        };
      });
      return true;
    } catch (err: any) {
      setRenderError(err?.message || 'Network error');
      return false;
    } finally {
      setIsRendering(false);
    }
  }, [session]);

  const render = useCallback(async (script: string, dataPayload?: Record<string, unknown> | null, initialEditLog?: EditEntry[]): Promise<RenderResponse> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRendering(true);
    setRenderError(null);
    setRenderTraceback(null);
    const effectiveDataPayload = resolveDataPayload(dataPayload);
    const pendingEditLog = initialEditLog || session?.editLog || [];

    try {
      const res = await fetch('/api/figure/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script,
          dataPayload: effectiveDataPayload,
          editLog: pendingEditLog,
        }),
        signal: controller.signal,
      });
      const data: RenderResponse & { traceback?: string } = await res.json();
      if (data.status === 'success') {
        setSession((prev) => prev ? {
          ...prev,
          sessionId: data.sessionId,
          script,
          dataPayload: effectiveDataPayload,
          editLog: data.editLog || pendingEditLog,
          manifest: data.manifest,
          svg: data.svg,
          revision: data.revision,
          updatedAt: Date.now(),
        } : {
          sessionId: data.sessionId,
          script,
          dataPayload: effectiveDataPayload,
          editLog: data.editLog || pendingEditLog,
          revision: data.revision,
          manifest: data.manifest,
          svg: data.svg,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setHistory((prev) => (session ? prev : { past: [], future: [] }));
      } else {
        setRenderError(data.message || 'Render failed');
        setRenderTraceback(data.traceback || null);
      }
      return data;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { status: 'error', message: 'Cancelled' } as RenderResponse;
      }
      setRenderError(err?.message || 'Network error');
      return { status: 'error', message: err?.message } as RenderResponse;
    } finally {
      setIsRendering(false);
      abortRef.current = null;
    }
  }, [resolveDataPayload, session]);

  const patch = useCallback(async (patches: PatchEntry[]): Promise<PatchResponse> => {
    if (!session) {
      return { status: 'error', message: 'No active session' } as PatchResponse;
    }

    // --- Code patch intercept: send with full metadata, bypass EditEntry transform ---
    const hasCodePatch = patches.some((p: any) => p.type === 'code_patch');
    if (hasCodePatch) {
      try {
        const res = await fetch('/api/figure/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            patches,
          }),
        });
        const data: PatchResponse & { script?: string } = await res.json();
        if (data.status === 'success') {
          setSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              svg: data.svg || prev.svg,
              manifest: data.manifest || prev.manifest,
              editLog: data.editLog || prev.editLog,
              script: data.script || prev.script,
              revision: data.revision || prev.revision + 1,
              updatedAt: Date.now(),
            };
          });
        }
        return data;
      } catch (err: any) {
        setRenderError(err?.message || 'Network error');
        return { status: 'error', message: err?.message } as PatchResponse;
      }
    }

    const localPatches = patches as LocalPatchEntry[];
    const allLocal = localPatches.length > 0 && localPatches.every((patchItem) => patchItem.mode === 'local_patch');
    const timestamp = Date.now();
    const nextEditEntries: EditEntry[] = localPatches.map((patchItem) => ({
      gid: patchItem.gid,
      prop: patchItem.prop,
      value: patchItem.value,
      mode: patchItem.mode,
      timestamp,
    }));

    if (allLocal) {
      const previousEditLog = cloneEditLog(session.editLog);
      const nextEditLog = [...session.editLog, ...nextEditEntries];
      setSession((prev) => (prev ? buildPatchedSession(prev, localPatches, nextEditLog) : prev));
      setHistory((prev) => ({
        past: [...prev.past, previousEditLog],
        future: [],
      }));

      try {
        const res = await fetch('/api/figure/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            patches,
          }),
        });
        const data: PatchResponse = await res.json();
        if (data.status === 'success') {
          const authoritativeEditLog = data.editLog || nextEditLog;
          setSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              editLog: authoritativeEditLog,
              revision: data.revision || prev.revision,
              updatedAt: Date.now(),
            };
          });
          setHistory((prev) => {
            if (prev.past.length === 0) {
              return prev;
            }
            const nextPast = [...prev.past];
            nextPast[nextPast.length - 1] = previousEditLog;
            return { past: nextPast, future: [] };
          });
        } else {
          setRenderError(data.message || 'Patch failed');
          await syncFigureState(previousEditLog);
        }
        return data;
      } catch (err: any) {
        setRenderError(err?.message || 'Network error');
        await syncFigureState(previousEditLog);
        return { status: 'error', message: err?.message } as PatchResponse;
      }
    }

    setIsRendering(true);
    setRenderError(null);
    const previousEditLog = cloneEditLog(session.editLog);

    try {
      const res = await fetch('/api/figure/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          patches,
        }),
      });
      const data: PatchResponse & { traceback?: string; script?: string } = await res.json();
      if (data.status === 'success') {
        const nextEditLog = data.editLog || [...session.editLog, ...nextEditEntries];
        setSession((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            sessionId: data.sessionId || prev.sessionId,
            revision: data.revision || prev.revision + 1,
            editLog: nextEditLog,
            manifest: data.manifest || prev.manifest,
            svg: data.svg || prev.svg,
            script: data.script || prev.script,
            updatedAt: Date.now(),
          };
        });
        setHistory((prev) => ({
          past: [...prev.past, previousEditLog],
          future: [],
        }));
      } else if (data.message === 'Session not found') {
        setRenderError(null);
        await syncFigureState(session.editLog);
        return { status: 'error', message: '会话已恢复，请重新提交' } as PatchResponse;
      } else {
        setRenderError(data.message || 'Patch failed');
      }
      return data;
    } catch (err: any) {
      setRenderError(err?.message || 'Network error');
      return { status: 'error', message: err?.message } as PatchResponse;
    } finally {
      setIsRendering(false);
    }
  }, [session, syncFigureState]);

  const codePatch = useCallback(async (script: string, force?: boolean): Promise<CodePatchResponse> => {
    if (!session) {
      return { status: 'error', message: 'No active session' } as CodePatchResponse;
    }

    setIsRendering(true);
    setRenderError(null);
    setRenderTraceback(null);

    try {
      const res = await fetch('/api/figure/code-patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          script,
          force,
        }),
      });
      const data: CodePatchResponse = await res.json();

      if (data.status === 'success') {
        setSession((prev) => {
          if (!prev) return prev;
          const nextEditLog = data.editLog || prev.editLog;
          return {
            ...prev,
            sessionId: data.sessionId || prev.sessionId,
            script,
            revision: data.revision || prev.revision + 1,
            editLog: nextEditLog,
            manifest: data.manifest || prev.manifest,
            svg: data.svg || prev.svg,
            updatedAt: Date.now(),
          };
        });
        setHistory({ past: [], future: [] });
      } else if (data.status === 'drift_warning') {
        // UI handles confirmation.
      } else {
        setRenderError(data.message || 'Code patch failed');
        setRenderTraceback(data.traceback || null);
      }
      return data;
    } catch (err: any) {
      setRenderError(err?.message || 'Network error');
      return { status: 'error', message: err?.message } as CodePatchResponse;
    } finally {
      setIsRendering(false);
    }
  }, [session]);

  const undoFigureEdit = useCallback(async () => {
    if (!session || history.past.length === 0) {
      return false;
    }

    const targetEditLog = history.past[history.past.length - 1];
    const currentEditLog = cloneEditLog(session.editLog);
    const ok = await syncFigureState(targetEditLog);
    if (!ok) return false;

    setHistory((prev) => ({
      past: prev.past.slice(0, -1),
      future: [currentEditLog, ...prev.future],
    }));
    return true;
  }, [history.past, session, syncFigureState]);

  const redoFigureEdit = useCallback(async () => {
    if (!session || history.future.length === 0) {
      return false;
    }

    const targetEditLog = history.future[0];
    const currentEditLog = cloneEditLog(session.editLog);
    const ok = await syncFigureState(targetEditLog);
    if (!ok) return false;

    setHistory((prev) => ({
      past: [...prev.past, currentEditLog],
      future: prev.future.slice(1),
    }));
    return true;
  }, [history.future, session, syncFigureState]);

  const reset = useCallback(() => {
    setSession(null);
    setIsRendering(false);
    setRenderError(null);
    setRenderTraceback(null);
    setHistory({ past: [], future: [] });
  }, []);

  return {
    session,
    isRendering,
    renderError,
    renderTraceback,
    canUndoFigure: history.past.length > 0,
    canRedoFigure: history.future.length > 0,
    render,
    patch,
    codePatch,
    undoFigureEdit,
    redoFigureEdit,
    reset,
  };
}
