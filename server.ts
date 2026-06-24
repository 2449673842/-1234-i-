import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { 
  listProjects, 
  getProject, 
  createProject, 
  updateProject, 
  deleteProject, 
  getDb, 
  saveSession, 
  getSession as getDbSession, 
  deleteSession, 
  cleanExpiredSessions,
  addProjectFile,
  listProjectFiles,
  getProjectFile,
  deleteProjectFile,
  addProjectFigure,
  listProjectFigures,
  deleteProjectFigures,
  type DatasetEntry,
  type FigureEntry
} from './db';
async function startServer() {
  const app = express();
  const PORT = 3000;

  // --- Multer Storage Setup for Project Files ---
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const projectId = req.params.id;
        // Validate projectId before using it for path construction
        assertSafeProjectId(projectId);
        const root = path.resolve(process.cwd(), 'data', 'projects');
        const projectDir = path.resolve(root, projectId);
        if (!projectDir.startsWith(root + path.sep)) {
          return cb(new Error('项目路径逃逸'), '');
        }
        const uploadDir = path.join(projectDir, 'files');
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (err: any) {
        cb(err, '');
      }
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
      const safeBase = base.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '');
      cb(null, `${Date.now()}_${safeBase}${ext}`);
    }
  });
  const upload = multer({
    storage,
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 20,
    },
    fileFilter: (_req, file, cb) => {
      const allowed = ['.csv', '.tsv', '.txt', '.xlsx', '.xls'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`不支持的文件格式: ${ext}，仅允许 CSV/TSV/TXT/XLSX`));
      }
    },
  });

  function assertSafeProjectId(projectId: string): void {
    if (!projectId || !/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) {
      throw new Error('无效的项目 ID');
    }
    // 二次校验：确保最终路径在 data/projects 下
    const root = path.resolve(process.cwd(), 'data', 'projects');
    const projectDir = path.resolve(root, projectId);
    if (!projectDir.startsWith(root + path.sep)) {
      throw new Error('项目路径逃逸');
    }
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function validateAst(script: string): Promise<{ ok: boolean; message?: string; errors?: string[] }> {
    try {
      const resultStr = await spawnPythonWithPayload('ast_validator.py', { script });
      const result = JSON.parse(resultStr);
      if (result.status !== 'success') {
        return { ok: false, message: result.message, errors: result.errors };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: 'AST 校验执行失败' };
    }
  }

  app.use(express.json({ limit: '50mb' }));
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }
    next(err);
  });

  // --- IFC v2 Introspection-based Render API ---

  interface EditEntry {
    gid: string;
    prop: string;
    value: unknown;
    mode: 'local_patch' | 'backend_patch';
    timestamp: number;
  }

  interface FigureSession {
    sessionId: string;
    script: string;
    dataPayload: Record<string, unknown> | null;
    editLog: EditEntry[];
    revision: number;
    createdAt: number;
    updatedAt: number;
  }

  // Clean expired sessions on startup (older than 2h)
  cleanExpiredSessions(120);

  function loadSession(sessionId: string): FigureSession | null {
    const row = getDbSession(sessionId);
    if (!row) return null;
    return {
      sessionId: row.id,
      script: row.script,
      dataPayload: row.data_payload ? JSON.parse(row.data_payload) : null,
      editLog: JSON.parse(row.edit_log),
      revision: row.revision,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }

  function persistSession(s: FigureSession): void {
    saveSession(s.sessionId, s.script, s.dataPayload, s.editLog, s.revision);
  }

  function spawnPythonWithPayload(scriptName: string, payload: any): Promise<string> {
    return new Promise((resolve, reject) => {
      const pythonBin = /^win/.test(process.platform) ? 'python' : 'python3';
      const scriptPath = path.join(process.cwd(), 'renderer', scriptName);
      const proc = spawn(pythonBin, [scriptPath]);
      let stdout = '';
      let stderr = '';
      const script = typeof payload?.script === 'string' ? payload.script : '';
      const rowCount = Array.isArray(payload?.dataPayload?.custom_data) ? payload.dataPayload.custom_data.length : 0;
      const timeoutMs = scriptName === 'introspector.py' ? 45000 : 20000;
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Python process timed out (${Math.round(timeoutMs / 1000)}s) [script=${scriptName}, scriptLen=${script.length}, rows=${rowCount}]${stderr ? ` stderr=${stderr.slice(0, 400)}` : ''}`));
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Python exited ${code}: ${stderr}`));
        else resolve(stdout);
      });
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    });
  }

  function cleanScript(script: string): string {
    return script.replace(/^```[a-z]*\n?/im, '').replace(/\n?```\s*$/i, '');
  }

  function applyCodePatch(script: string, patch: any): string {
    const lines = script.split('\n');
    if (!/^#[0-9A-Fa-f]{6}$/.test(patch.new_value)) {
      throw new Error(`无效的颜色值: ${patch.new_value}`);
    }
    const safeTarget = escapeRegExp(patch.target_id);
    const regexConstant = new RegExp(`^(${safeTarget})\\s*=\\s*["\'](#[0-9A-Fa-f]{6})["\']`);
    const cleanKey = patch.target_id.replace(/^dict_/, '');
    const safeKey = escapeRegExp(cleanKey);
    const regexDict = new RegExp(`(["\']${safeKey}["\']\\s*:\\s*)["\'](#[0-9A-Fa-f]{6})["\']`);

    const updatedLines = lines.map(line => {
      const trimmed = line.trim();
      if (regexConstant.test(trimmed)) {
        return line.replace(/(#[0-9A-Fa-f]{6})/, patch.new_value);
      }
      if (regexDict.test(trimmed)) {
        return line.replace(/(#[0-9A-Fa-f]{6})/, patch.new_value);
      }
      return line;
    });
    
    return updatedLines.join('\n');
  }

  // POST /api/figure/render — introspection-based render
  app.post('/api/figure/render', async (req, res) => {
    try {
      let { script, dataPayload, editLog, renderOptions } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);

      // AST gate
      const astCheck = await validateAst(script);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败', details: astCheck.message, errors: astCheck.errors });
      }
      const existingSession = req.body.sessionId ? loadSession(req.body.sessionId) : null;
      const effectiveDataPayload = dataPayload !== undefined
        ? dataPayload
        : existingSession?.dataPayload || null;
      const result = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload: effectiveDataPayload,
        editLog: editLog || [],
        renderOptions: renderOptions || { dpi: 150 },
      });
      const parsed = JSON.parse(result);
      if (parsed.status === 'success') {
        const sessionId = parsed.sessionId || `fig_${Date.now()}`;
        const nextEditLog = editLog || [];
        persistSession({
          sessionId,
          script,
          dataPayload: effectiveDataPayload,
          editLog: nextEditLog,
          revision: parsed.revision || 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        parsed.sessionId = sessionId;
        parsed.editLog = nextEditLog;
      }
      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // POST /api/figure/patch — apply edits and re-render
  app.post('/api/figure/patch', async (req, res) => {
    try {
      const { sessionId, patches } = req.body;
      const session = loadSession(sessionId);
      if (!session) {
        return res.status(404).json({ status: 'error', message: 'Session not found' });
      }

      const codePatches = (patches || []).filter((p: any) => p.type === 'code_patch');
      const regularPatches = (patches || []).filter((p: any) => p.type !== 'code_patch');

      // Apply code patches if any
      if (codePatches.length > 0) {
        codePatches.forEach((cp: any) => {
          session.script = applyCodePatch(session.script, cp);
          if (cp.gids && Array.isArray(cp.gids)) {
            session.editLog = session.editLog.filter((e: any) => {
              const isColorProp = e.prop === 'facecolor' || e.prop === 'color' || e.prop === 'edgecolor';
              const isTargetGid = cp.gids.includes(e.gid);
              return !(isTargetGid && isColorProp);
            });
          }
        });
      }

      const newEdits: EditEntry[] = regularPatches.map((p: any) => ({
        gid: p.gid,
        prop: p.prop,
        value: p.value,
        mode: p.mode || 'backend_patch',
        timestamp: Date.now(),
      }));

      const backendPatches = newEdits.filter(e => e.mode === 'backend_patch');
      const localPatches = newEdits.filter(e => e.mode === 'local_patch');

      // If it's purely local patches and no code patches, only append to editLog
      if (backendPatches.length === 0 && codePatches.length === 0) {
        session.editLog.push(...localPatches);
        session.revision++;
        persistSession(session);
        return res.json({
          status: 'success',
          sessionId,
          applied: newEdits,
          revision: session.revision,
          editLog: session.editLog,
          script: session.script
        });
      }

      // Check if session is linked to a project figure to supply sandbox metadata
      const figRow = getDb().prepare('SELECT * FROM project_figures WHERE session_id = ?').get(sessionId) as any;
      let cwd: string | undefined;
      let uploaded_file_paths: Record<string, string> | undefined;

      if (figRow) {
        const projectId = figRow.project_id;
        const datasets = listProjectFiles(projectId);
        uploaded_file_paths = {};
        datasets.forEach(d => {
          uploaded_file_paths![d.fileName] = d.filePath;
          const ext = path.extname(d.fileName);
          const base = path.basename(d.fileName, ext);
          uploaded_file_paths![base] = d.filePath;
        });
        cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files').replace(/\\/g, '/');
      }

      // Otherwise, re-render with updated script and editLog
      const mergedEditLog = [...session.editLog, ...backendPatches];
      const result = await spawnPythonWithPayload('introspector.py', {
        script: session.script,
        dataPayload: session.dataPayload || null,
        editLog: mergedEditLog,
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: figRow ? { [`fig_${figRow.figure_index + 1}`]: mergedEditLog } : undefined
      });
      const parsed = JSON.parse(result);
      if (parsed.status === 'success') {
        session.editLog = mergedEditLog;
        session.revision++;
        persistSession(session);
        parsed.sessionId = session.sessionId;
        parsed.revision = session.revision;
        parsed.editLog = session.editLog;
        parsed.script = session.script;

        if (figRow) {
          const targetFigId = `fig_${figRow.figure_index + 1}`;
          const matchedFig = parsed.figures?.find((f: any) => f.figureId === targetFigId);
          if (matchedFig) {
            parsed.svg = matchedFig.svg;
            parsed.manifest = matchedFig.manifest;
          }
        }
      }
      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // POST /api/figure/code-patch — update script with AST gate & drift detection
  app.post('/api/figure/code-patch', async (req, res) => {
    try {
      let { sessionId, script, force } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);

      // 1. AST Quality Gate
      const astResultStr = await spawnPythonWithPayload('ast_validator.py', { script });
      const astResult = JSON.parse(astResultStr);
      if (astResult.status !== 'success') {
        return res.status(400).json({
          status: 'error',
          message: 'AST 校验失败',
          details: astResult.message,
          errors: astResult.errors
        });
      }

      let session = null;
      let editLog: EditEntry[] = [];
      let dataPayload: Record<string, unknown> | null = null;

      if (sessionId) {
        session = loadSession(sessionId);
        if (session) {
          editLog = session.editLog;
          dataPayload = session.dataPayload;
        }
      }

      // Determine sandbox configurations if project figure session is processed
      const figRow = sessionId ? getDb().prepare('SELECT * FROM project_figures WHERE session_id = ?').get(sessionId) as any : null;
      let cwd: string | undefined;
      let uploaded_file_paths: Record<string, string> | undefined;

      if (figRow) {
        const projectId = figRow.project_id;
        const datasets = listProjectFiles(projectId);
        uploaded_file_paths = {};
        datasets.forEach(d => {
          uploaded_file_paths![d.fileName] = d.filePath;
          const ext = path.extname(d.fileName);
          const base = path.basename(d.fileName, ext);
          uploaded_file_paths![base] = d.filePath;
        });
        cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files').replace(/\\/g, '/');
      }

      // 2. Re-render via introspector with new script + old editLog
      const resultStr = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload,
        editLog,
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: figRow ? { [`fig_${figRow.figure_index + 1}`]: editLog } : undefined
      });
      const parsed = JSON.parse(resultStr);

      if (parsed.status !== 'success') {
        return res.json(parsed); // Returns python error directly
      }

      if (figRow) {
        const targetFigId = `fig_${figRow.figure_index + 1}`;
        const matchedFig = parsed.figures?.find((f: any) => f.figureId === targetFigId);
        if (matchedFig) {
          parsed.svg = matchedFig.svg;
          parsed.manifest = matchedFig.manifest;
        } else {
          return res.json({
            status: 'drift_warning',
            message: '目标 Figure 在重渲染后不存在',
            figureId: targetFigId,
            availableFigures: (parsed.figures || []).map((f: any) => f.figureId)
          });
        }
      }

      // 3. Detect drift
      const returnedGids = new Set(parsed.manifest.objects.map((o: any) => o.id));
      const requestedGids = new Set(editLog.map(e => e.gid));
      const orphanedGids = [...requestedGids].filter(gid => !returnedGids.has(gid));

      if (orphanedGids.length > 0 && !force) {
        return res.json({
          status: 'drift_warning',
          message: '检测到代码修改导致部分原有样式目标丢失',
          orphanedGids
        });
      }

      // 4. Update session
      if (session) {
        session.script = script;
        if (orphanedGids.length > 0) {
          // Clean up orphaned edits
          session.editLog = session.editLog.filter(e => returnedGids.has(e.gid));
        }
        session.revision++;
        session.updatedAt = Date.now();
        persistSession(session);
        parsed.revision = session.revision;
        parsed.sessionId = session.sessionId;
        parsed.editLog = session.editLog;
      } else {
        const newSessionId = parsed.sessionId || `fig_${Date.now()}`;
        persistSession({
          sessionId: newSessionId,
          script,
          dataPayload,
          editLog: [],
          revision: parsed.revision || 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        parsed.sessionId = newSessionId;
        parsed.editLog = [];
      }

      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // POST /api/figure/export — export SVG/PNG/PDF and reproducible bundle
  app.post('/api/figure/export', async (req, res) => {
    try {
      const { sessionId, format, dpi } = req.body;
      const session = loadSession(sessionId);
      if (!session) {
        return res.status(404).json({ status: 'error', message: 'Session not found' });
      }

      const reqFormat = (format || 'svg').toLowerCase();

      // AST gate before executing script
      const astCheck = await validateAst(session.script);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败', details: astCheck.message, errors: astCheck.errors });
      }

      // 1. Ensure we have the latest SVG and export if necessary
      const resultStr = await spawnPythonWithPayload('introspector.py', {
        script: session.script,
        dataPayload: session.dataPayload || null,
        editLog: session.editLog,
        renderOptions: { dpi: dpi || 300 },
        export_format: reqFormat !== 'svg' ? reqFormat : undefined,
      });
      const parsed = JSON.parse(resultStr);
      if (parsed.status !== 'success') {
        return res.json(parsed);
      }
      
      const svg = parsed.svg;
      let binary_b64 = parsed.binary_b64 || null;
      let format_note = '';

      // Fallback if binary_b64 wasn't produced
      if (reqFormat !== 'svg' && !binary_b64) {
        format_note = `无法导出 ${reqFormat}，可能缺少依赖 (例如 PIL)，已回退为 SVG`;
      }

      // 3. Reproducible bundle
      const dataSnapshot = session.dataPayload || null;
      const dataFingerprint = crypto.createHash('sha256').update(JSON.stringify(dataSnapshot ?? null)).digest('hex');
      const bundle = {
        script: session.script,
        editLog: session.editLog,
        dataSnapshot,
        dataFingerprint,
        metadata: {
          generatedAt: new Date().toISOString(),
          revision: session.revision,
          appVersion: '2.0',
          exportFormat: reqFormat,
          dpi: dpi || 300,
          environment: 'Python 3 + Matplotlib'
        }
      };

      res.json({
        status: 'success',
        format: reqFormat,
        svg,
        binary_b64,
        bundle,
        format_note
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // --- Project CRUD API ---

  app.get('/api/projects', (_req, res) => {
    try {
      const projects = listProjects();
      res.json({ status: 'success', projects });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) return res.status(404).json({ status: 'error', message: 'Project not found' });
      
      const datasets = listProjectFiles(req.params.id);
      const figRows = listProjectFigures(req.params.id);
      const figures = figRows.map(f => {
        const session = loadSession(f.session_id);
        return {
          figureId: `fig_${f.figure_index + 1}`,
          index: f.figure_index,
          editLog: session?.editLog || [],
          revision: session?.revision || 1
        };
      });

      res.json({ 
        status: 'success', 
        project: {
          projectId: project.id,
          name: project.name,
          spec: project.spec,
          script: project.script || '',
          datasets,
          figures
        }
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects', (req, res) => {
    try {
      const { name, spec } = req.body;
      if (!name || !spec) return res.status(400).json({ status: 'error', message: 'name and spec required' });
      const id = randomUUID();
      createProject(id, name, spec);
      
      const script = spec.custom_script || spec.script || '';
      if (script) {
        updateProject(id, name, spec, script);
      }
      
      res.json({ status: 'success', id });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.put('/api/projects/:id', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const { name, spec } = req.body;
      if (!name) return res.status(400).json({ status: 'error', message: 'name required' });
      const existing = getProject(projectId);
      if (!existing) return res.status(404).json({ status: 'error', message: 'Project not found' });
      if (spec) {
        const script = spec.custom_script || spec.script || '';
        updateProject(req.params.id, name, spec, script);
      } else {
        getDb().prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, req.params.id);
      }
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      deleteProjectFigures(projectId);
      deleteProject(projectId);

      // Physically delete project directories
      const projectDir = path.join(process.cwd(), 'data', 'projects', projectId);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // --- Project Dataset Files API ---
  app.get('/api/projects/:id/files', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const datasets = listProjectFiles(projectId);
      res.json({ status: 'success', datasets });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/files', upload.single('file'), (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const file = req.file;
      if (!file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded' });
      }

      let columns: string[] = [];
      let rowCount = 0;

      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
        const fileContent = fs.readFileSync(file.path, 'utf8');
        const delimiter = ext === '.tsv' ? '\t' : ',';
        const parsed = Papa.parse(fileContent, {
          header: false,
          skipEmptyLines: true,
          delimiter
        });
        const rows = parsed.data as string[][];
        columns = rows.length > 0 ? rows[0] : [];
        rowCount = rows.length > 0 ? Math.max(0, rows.length - 1) : 0;
      } else if (ext === '.xlsx' || ext === '.xls') {
        const workbook = XLSX.readFile(file.path);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        columns = jsonData.length > 0 ? jsonData[0].map(String) : [];
        rowCount = jsonData.length > 0 ? Math.max(0, jsonData.length - 1) : 0;
      } else {
        fs.unlinkSync(file.path);
        return res.status(400).json({ status: 'error', message: 'Unsupported file format' });
      }

      const fileId = randomUUID();
      const storedPath = path.relative(process.cwd(), file.path).replace(/\\/g, '/');

      addProjectFile(fileId, projectId, file.originalname, storedPath, columns, rowCount);

      res.json({
        status: 'success',
        fileId,
        fileName: file.originalname,
        columns,
        rowCount
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.delete('/api/projects/:id/files/:fileId', (req, res) => {
    try {
      const { id: projectId, fileId } = req.params;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const fileRecord = getProjectFile(fileId);
      if (fileRecord && fileRecord.project_id === projectId) {
        const absPath = path.resolve(process.cwd(), fileRecord.stored_path);
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
        }
      }
      deleteProjectFile(projectId, fileId);
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // --- Project Figures Render API ---
  app.post('/api/projects/:id/figures/render', async (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      let { script, editLogs } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);

      // AST gate
      const astCheck = await validateAst(script);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败', details: astCheck.message, errors: astCheck.errors });
      }

      // Update script in projects table
      const projectRow = getProject(projectId);
      if (projectRow) {
        updateProject(projectId, projectRow.name, JSON.parse(projectRow.spec), script);
      }

      const datasets = listProjectFiles(projectId);
      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        uploaded_file_paths[d.fileName] = d.filePath;
        const ext = path.extname(d.fileName);
        const base = path.basename(d.fileName, ext);
        uploaded_file_paths[base] = d.filePath;
      });

      const cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files');
      fs.mkdirSync(cwd, { recursive: true });

      const resultStr = await spawnPythonWithPayload('introspector.py', {
        script,
        cwd: cwd.replace(/\\/g, '/'),
        uploaded_file_paths,
        editLogs: editLogs || {},
        renderOptions: { dpi: 150 }
      });
      const parsed = JSON.parse(resultStr);

      if (parsed.status === 'success') {
        // Read existing figure bindings to preserve editLogs
        const oldFigRows = listProjectFigures(projectId);
        const oldEditLogMap: Record<string, any[]> = {};
        const oldSessionMap: Record<string, any> = {};
        for (const row of oldFigRows) {
          const key = `fig_${row.figure_index + 1}`;
          const sess = loadSession(row.session_id);
          if (sess) {
            oldEditLogMap[key] = sess.editLog;
            oldSessionMap[key] = sess;
          }
        }

        // Detect figure count drift
        const newFigures = parsed.figures || [];
        const oldCount = oldFigRows.length;
        const newCount = newFigures.length;
        const figureCountChanged = oldCount > 0 && oldCount !== newCount;

        // Clear old bindings, re-create with preserved editLogs
        deleteProjectFigures(projectId);

        for (let i = 0; i < newFigures.length; i++) {
          const fig = newFigures[i];
          const figKey = `fig_${i + 1}`;
          const figSessionId = `${projectId}_${figKey}`;

          // Preserve old editLog if frontend didn't pass new ones
          const incomingEditLog = editLogs?.[fig.figureId];
          const preservedEditLog = incomingEditLog !== undefined
            ? incomingEditLog
            : (oldEditLogMap[figKey] || []);

          persistSession({
            sessionId: figSessionId,
            script,
            dataPayload: { datasets } as any,
            editLog: preservedEditLog,
            revision: oldSessionMap[figKey]?.revision || 1,
            createdAt: oldSessionMap[figKey]?.createdAt || Date.now(),
            updatedAt: Date.now()
          });

          addProjectFigure(figSessionId, projectId, i, figSessionId);
        }

        // Attach figure count drift warning
        if (figureCountChanged) {
          parsed._warnings = parsed._warnings || [];
          parsed._warnings.push({
            type: 'figure_count_changed',
            message: `Figure 数量从 ${oldCount} 变为 ${newCount}，部分编辑可能无法完全重放`,
            oldCount,
            newCount
          });
        }
      }

      res.json(parsed);
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // GET /api/projects/:id/figures — list project figures metadata
  app.get('/api/projects/:id/figures', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const figures = listProjectFigures(projectId);
      const resultFigures = [];
      for (const fig of figures) {
        const session = loadSession(fig.session_id);
        if (session) {
          resultFigures.push({
            figureId: `fig_${fig.figure_index + 1}`,
            index: fig.figure_index,
            editLog: session.editLog,
            revision: session.revision
          });
        }
      }
      res.json({ status: 'success', figures: resultFigures });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // POST /api/projects/:id/export — export single or all project figures
  app.post('/api/projects/:id/export', async (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const { figureId, format, dpi } = req.body;
      const reqFormat = (format || 'svg').toLowerCase();

      const figRows = listProjectFigures(projectId);
      const targetFigs = figureId
        ? figRows.filter(f => `fig_${f.figure_index + 1}` === figureId)
        : figRows;

      if (figureId && targetFigs.length === 0) {
        return res.status(404).json({
          status: 'error',
          message: `目标 Figure "${figureId}" 不存在`,
          availableFigures: figRows.map(f => `fig_${f.figure_index + 1}`)
        });
      }

      const results = [];
      const projectData = getProject(projectId);
      const script = projectData?.script || '';

      // AST gate
      if (script) {
        const astCheck = await validateAst(script);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败', details: astCheck.message, errors: astCheck.errors });
        }
      }
      const datasets = listProjectFiles(projectId);

      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        uploaded_file_paths[d.fileName] = d.filePath;
        const ext = path.extname(d.fileName);
        const base = path.basename(d.fileName, ext);
        uploaded_file_paths[base] = d.filePath;
      });

      const cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files');

      for (const fig of targetFigs) {
        const session = loadSession(fig.session_id);
        if (!session) continue;

        const targetFigId = `fig_${fig.figure_index + 1}`;
        const resultStr = await spawnPythonWithPayload('introspector.py', {
          script: session.script,
          cwd: cwd.replace(/\\/g, '/'),
          uploaded_file_paths,
          editLogs: { [targetFigId]: session.editLog },
          renderOptions: { dpi: dpi || 300 },
          export_format: reqFormat !== 'svg' ? reqFormat : undefined,
        });

        const parsed = JSON.parse(resultStr);
        if (parsed.status === 'success') {
          const matchedFig = parsed.figures?.find((f: any) => f.figureId === targetFigId) || parsed;
          results.push({
            figureId: targetFigId,
            svg: matchedFig.svg,
            binary_b64: matchedFig.binary_b64 || null,
            format: reqFormat
          });
        }
      }

      res.json({
        status: 'success',
        figures: results
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
