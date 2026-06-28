import 'dotenv/config';
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
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
  replaceProjectFiguresAndSessions,
  addExportAsset,
  listExportAssets,
  getExportAsset,
  deleteExportAssets,
  createUserAccount,
  getUserByEmail,
  getUserByAuthToken,
  touchUserLogin,
  createAuthSession,
  revokeAuthToken,
  verifyPassword,
  upsertDevice,
  getActiveDeviceCount,
  getLicenseState,
  redeemCodeForUser,
  createRedeemCode,
  logLicenseCheck,
  type FigSessionInput,
  type DatasetEntry,
  type FigureEntry,
  type ExportAsset,
  type UserAccount
} from './db';
async function startServer() {
  const app = express();
  const PORT = 3000;
  const processedRequestIdsMap = new Map<string, Set<string>>();
  const responseCacheMap = new Map<string, Map<string, any>>();

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
      const normalizedName = normalizeUploadFileName(file.originalname);
      file.originalname = normalizedName;
      const ext = path.extname(normalizedName);
      const base = path.basename(normalizedName, ext);
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

  function countCjkChars(value: string): number {
    return (value.match(/[\u4e00-\u9fff]/g) || []).length;
  }

  function normalizeUploadFileName(fileName: string): string {
    const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
    if (decoded.includes('\uFFFD')) {
      return fileName;
    }
    return countCjkChars(decoded) > countCjkChars(fileName) ? decoded : fileName;
  }

  function addUploadedFilePathAliases(target: Record<string, string>, fileName: string, filePath: string): void {
    const names = new Set([fileName, normalizeUploadFileName(fileName)]);
    names.forEach(name => {
      target[name] = filePath;
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      if (base) {
        target[base] = filePath;
      }
    });
  }

  function publicUserPayload(user: UserAccount) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  function readBearerToken(req: express.Request): string | null {
    const header = req.headers.authorization || '';
    const match = String(header).match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  function readDeviceFingerprint(req: express.Request): string | null {
    const value = req.headers['x-device-fingerprint'];
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;
  }

  function requireAuth(req: express.Request): { user: UserAccount; token: string; deviceId: string | null } {
    const token = readBearerToken(req);
    if (!token) {
      const err = new Error('未登录或登录已过期');
      (err as any).statusCode = 401;
      throw err;
    }
    const user = getUserByAuthToken(token);
    if (!user) {
      const err = new Error('登录已过期，请重新登录');
      (err as any).statusCode = 401;
      throw err;
    }
    const fingerprint = readDeviceFingerprint(req);
    const deviceId = fingerprint ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null) : null;
    return { user, token, deviceId };
  }

  function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
  }

  function issueToken(): string {
    return `sf_${crypto.randomBytes(32).toString('base64url')}`;
  }

  function safeExportName(name: string): string {
    const trimmed = (name || 'figure').trim();
    return trimmed
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 96) || 'figure';
  }

  function exportMimeType(format: string): string {
    const fmt = format.toLowerCase();
    if (fmt === 'svg') return 'image/svg+xml';
    if (fmt === 'pdf') return 'application/pdf';
    if (fmt === 'png') return 'image/png';
    if (fmt === 'tiff' || fmt === 'tif') return 'image/tiff';
    if (fmt === 'eps') return 'application/postscript';
    return 'application/octet-stream';
  }

  function projectExportsDir(projectId: string): string {
    assertSafeProjectId(projectId);
    const projectDir = path.resolve(process.cwd(), 'data', 'projects', projectId);
    const exportsDir = path.resolve(projectDir, 'exports');
    if (!exportsDir.startsWith(projectDir + path.sep)) {
      throw new Error('导出路径逃逸');
    }
    fs.mkdirSync(exportsDir, { recursive: true });
    return exportsDir;
  }

  function persistProjectExportAsset(args: {
    projectId: string;
    figureId: string | null;
    name: string;
    format: string;
    dpi?: number | null;
    svg?: string;
    binaryB64?: string | null;
    thumbnailSvg?: string | null;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): ExportAsset {
    const assetId = `exp_${randomUUID()}`;
    const fmt = args.format.toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}_${safeExportName(args.figureId || args.name)}.${fmt}`;
    const absPath = path.join(projectExportsDir(args.projectId), filename);
    const relPath = path.relative(process.cwd(), absPath);
    if (args.binaryB64) {
      fs.writeFileSync(absPath, Buffer.from(args.binaryB64, 'base64'));
    } else {
      fs.writeFileSync(absPath, args.svg || '', 'utf8');
    }
    return addExportAsset({
      id: assetId,
      projectId: args.projectId,
      figureId: args.figureId,
      name: args.name,
      format: fmt,
      dpi: args.dpi ?? null,
      filePath: relPath,
      thumbnailSvg: args.thumbnailSvg ?? args.svg ?? null,
      metadata: args.metadata ?? {},
      tags: args.tags ?? [],
    });
  }

  function parseSvgViewBox(svg: string): { x: number; y: number; width: number; height: number } {
    const viewBox = svg.match(/viewBox=["']([^"']+)["']/i)?.[1];
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
    }
    const width = Number(svg.match(/\bwidth=["']([\d.]+)/i)?.[1]) || 800;
    const height = Number(svg.match(/\bheight=["']([\d.]+)/i)?.[1]) || 600;
    return { x: 0, y: 0, width, height };
  }

  function extractSvgInner(svg: string): string {
    return svg
      .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/^[\s\S]*?<svg\b[^>]*>/i, '')
      .replace(/<\/svg>\s*$/i, '');
  }

  interface ComposePanelLayout {
    assetId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  }

  interface ComposeLayout {
    width: number;
    height: number;
    panels: ComposePanelLayout[];
    labelFontSize?: number;
    labelFontFamily?: string;
    labelColor?: string;
    applyInnerFont?: boolean;
    innerFontSize?: number;
    innerFontFamily?: string;
    innerFontColor?: string;
  }

  function composeSvgAssets(assets: ExportAsset[], layout?: ComposeLayout): string {
    const count = assets.length;
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const panelW = 420;
    const panelH = 320;
    const gapX = 36;
    const gapY = 42;
    const labelOffset = 22;
    const width = layout?.width && Number.isFinite(layout.width) ? Math.max(200, Math.min(4000, layout.width)) : cols * panelW + (cols - 1) * gapX;
    const height = layout?.height && Number.isFinite(layout.height) ? Math.max(200, Math.min(4000, layout.height)) : rows * panelH + (rows - 1) * gapY + labelOffset;
    const labels = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const layoutMap = new Map((layout?.panels || []).map(panel => [panel.assetId, panel]));
    const labelFontSize = layout?.labelFontSize && Number.isFinite(layout.labelFontSize) ? Math.max(6, Math.min(72, layout.labelFontSize)) : 18;
    const labelFontFamily = String(layout?.labelFontFamily || 'Arial, sans-serif').replace(/[<>"']/g, '');
    const labelColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.labelColor || '')) ? String(layout?.labelColor) : '#0f172a';
    const applyInnerFont = layout?.applyInnerFont === true;
    const innerFontSize = layout?.innerFontSize && Number.isFinite(layout.innerFontSize) ? Math.max(4, Math.min(96, layout.innerFontSize)) : 10;
    const innerFontFamily = String(layout?.innerFontFamily || 'Times New Roman, serif').replace(/[<>"'{}]/g, '');
    const innerFontColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.innerFontColor || '')) ? String(layout?.innerFontColor) : '#111827';
    const innerFontStyle = applyInnerFont ? `
  <style>
    .composer-subfigure text {
      font-family: ${innerFontFamily} !important;
      font-size: ${innerFontSize}px !important;
      fill: ${innerFontColor} !important;
    }
  </style>` : '';

    const panels = assets.map((asset, idx) => {
      const svg = asset.thumbnailSvg || '';
      const vb = parseSvgViewBox(svg);
      const custom = layoutMap.get(asset.assetId);
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const targetW = custom?.width && Number.isFinite(custom.width) ? Math.max(80, Math.min(2000, custom.width)) : panelW;
      const targetH = custom?.height && Number.isFinite(custom.height) ? Math.max(80, Math.min(2000, custom.height)) : panelH;
      const x = custom?.x && Number.isFinite(custom.x) ? custom.x : col * (panelW + gapX);
      const y = custom?.y && Number.isFinite(custom.y) ? custom.y : row * (panelH + gapY) + labelOffset;
      const scale = Math.min(targetW / vb.width, targetH / vb.height);
      const scaledW = vb.width * scale;
      const scaledH = vb.height * scale;
      const dx = x + (targetW - scaledW) / 2 - vb.x * scale;
      const dy = y + (targetH - scaledH) / 2 - vb.y * scale;
      const label = custom?.label || `(${labels[idx]})`;
      return `
        <g data-export-asset-id="${asset.assetId}">
          <text x="${x}" y="${y - 8}" font-family="${labelFontFamily}" font-size="${labelFontSize}" font-weight="700" fill="${labelColor}">${label}</text>
          <g class="composer-subfigure" transform="translate(${dx.toFixed(3)} ${dy.toFixed(3)}) scale(${scale.toFixed(6)})">
            ${extractSvgInner(svg)}
          </g>
        </g>`;
    }).join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  ${innerFontStyle}
  ${panels}
</svg>`;
  }

  async function validateAst(script: string, req?: express.Request): Promise<{ ok: boolean; message?: string; errors?: string[] }> {
    try {
      const result = await spawnPythonWithPayload('ast_validator.py', { script });
      if (result.status !== 'success') {
        return { ok: false, message: result.message, errors: result.errors };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'AST 校验执行失败' };
    }
  }

  app.use(express.json({ limit: '50mb' }));
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }
    next(err);
  });

  app.post('/api/auth/register', (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim();
      if (!isValidEmail(email)) {
        return res.status(400).json({ status: 'error', message: '请输入有效邮箱' });
      }
      if (password.length < 8) {
        return res.status(400).json({ status: 'error', message: '密码至少需要 8 位' });
      }
      if (getUserByEmail(email)) {
        return res.status(409).json({ status: 'error', message: '该邮箱已注册' });
      }
      const user = createUserAccount(email, password, displayName || email.split('@')[0]);
      const token = issueToken();
      const fingerprint = readDeviceFingerprint(req);
      const deviceId = fingerprint ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null) : null;
      createAuthSession(user.id, token, deviceId);
      touchUserLogin(user.id);
      const license = getLicenseState(user.id);
      res.json({ status: 'success', token, user: publicUserPayload(user), license });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const row = getUserByEmail(email);
      if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
        return res.status(401).json({ status: 'error', message: '邮箱或密码错误' });
      }
      const user = {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
      };
      const token = issueToken();
      const fingerprint = readDeviceFingerprint(req);
      const deviceId = fingerprint ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null) : null;
      createAuthSession(user.id, token, deviceId);
      touchUserLogin(user.id);
      const license = getLicenseState(user.id);
      res.json({ status: 'success', token, user: publicUserPayload(user), license, deviceCount: getActiveDeviceCount(user.id) });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        return res.json({ status: 'anonymous', user: null, license: getLicenseState(null) });
      }
      const user = getUserByAuthToken(token);
      if (!user) {
        return res.status(401).json({ status: 'error', message: '登录已过期，请重新登录' });
      }
      const fingerprint = readDeviceFingerprint(req);
      const deviceId = fingerprint ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null) : null;
      const license = getLicenseState(user.id);
      logLicenseCheck(user.id, deviceId, license.isPro ? 'pro' : 'free', 'auth_me');
      res.json({ status: 'success', user: publicUserPayload(user), license, deviceCount: getActiveDeviceCount(user.id) });
    } catch (err: any) {
      res.status((err as any).statusCode || 500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    try {
      const token = readBearerToken(req);
      const revoked = token ? revokeAuthToken(token) : 0;
      res.json({ status: 'success', revoked });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/license/redeem', (req, res) => {
    try {
      const { user, deviceId } = requireAuth(req);
      const code = String(req.body?.code || '').trim();
      if (!code) {
        return res.status(400).json({ status: 'error', message: '请输入兑换码' });
      }
      const license = redeemCodeForUser(user.id, code, deviceId);
      logLicenseCheck(user.id, deviceId, license.isPro ? 'pro' : 'free', 'redeem_code');
      res.json({ status: 'success', license });
    } catch (err: any) {
      res.status((err as any).statusCode || 400).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/license/check', (req, res) => {
    try {
      const token = readBearerToken(req);
      const user = token ? getUserByAuthToken(token) : null;
      const fingerprint = readDeviceFingerprint(req);
      const deviceId = user && fingerprint ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null) : null;
      const license = getLicenseState(user?.id ?? null);
      logLicenseCheck(user?.id ?? null, deviceId, license.isPro ? 'pro' : 'free', 'explicit_check');
      res.json({ status: 'success', user: user ? publicUserPayload(user) : null, license, deviceCount: user ? getActiveDeviceCount(user.id) : 0 });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/admin/redeem-codes', (req, res) => {
    try {
      const adminSecret = process.env.SCIFIGURE_ADMIN_SECRET;
      if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
        return res.status(403).json({ status: 'error', message: '未授权的管理操作' });
      }
      const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
      const durationDays = Math.max(1, Math.min(3650, Number(req.body?.durationDays || 31)));
      const maxUses = Math.max(1, Math.min(1000, Number(req.body?.maxUses || 1)));
      const label = String(req.body?.label || 'manual').slice(0, 80);
      const codes: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const code = `SF-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        createRedeemCode({ code, label, plan: 'pro', durationDays, maxUses, expiresAt: req.body?.expiresAt || null });
        codes.push(code);
      }
      res.json({ status: 'success', codes, durationDays, maxUses });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
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

  /** Compress editLog: keep only the latest value per (gid, prop).
   *  Preserves full History Log for undo/redo — only the render/export
   *  payload uses the compressed version. */
  function compressEditLog(log: EditEntry[]): EditEntry[] {
    const seen = new Set<string>();
    const result: EditEntry[] = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      const key = `${entry.gid}\0${entry.prop}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.unshift(entry);
      }
    }
    return result;
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

  function syncProjectFigureRevision(sessionId: string, revision: number): void {
    getDb().prepare('UPDATE project_figures SET revision = ? WHERE session_id = ?').run(revision, sessionId);
  }

  function persistProjectScript(projectId: string, script: string): void {
    const project = getProject(projectId);
    if (!project) return;
    let spec: any = {};
    try {
      spec = typeof project.spec === 'string' ? JSON.parse(project.spec) : (project.spec || {});
    } catch {
      spec = {};
    }
    spec.custom_script = script;
    spec.script = script;
    updateProject(projectId, project.name, spec, script);
  }

  function resolvePythonBin(): string {
    if (process.env.PYTHON_BIN) {
      return process.env.PYTHON_BIN;
    }
    const condaPython = 'C:\\Users\\SZC\\.conda\\envs\\Machine-learning\\python.exe';
    if (process.platform === 'win32' && fs.existsSync(condaPython)) {
      return condaPython;
    }
    return /^win/.test(process.platform) ? 'python' : 'python3';
  }

  type SpawnPythonOptions = {
    req?: express.Request;
    timeoutMs?: number;
    label?: string;
  };

  async function spawnPythonWithPayload(
    scriptName: string,
    payload: unknown,
    options: SpawnPythonOptions = {}
  ): Promise<any> {
    const timeoutMs = options.timeoutMs ?? (scriptName === 'introspector.py' ? 45000 : 20000);
    const label = options.label ?? scriptName;
    const scriptLen = typeof (payload as any)?.script === 'string' ? (payload as any).script.length : 0;
    const rowCount = Array.isArray((payload as any)?.dataPayload?.custom_data) ? (payload as any).dataPayload.custom_data.length : 0;

    // Write payload to temp file (prevents stdin buffer deadlock for large payloads)
    const payloadFile = path.join(os.tmpdir(), `scifigure-payload-${randomUUID()}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf-8');

    return new Promise((resolve, reject) => {
      const pythonBin = resolvePythonBin();
      const scriptPath = path.join(process.cwd(), 'renderer', scriptName);
      const child = spawn(pythonBin, [scriptPath, '--payload-file', payloadFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let sigkillTimer: NodeJS.Timeout | null = null;

      const cleanupPayload = () => {
        try { fs.unlinkSync(payloadFile); } catch { /* temp file already gone */ }
      };

      const killChild = (reason: string) => {
        if (settled || child.killed) return;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      };

      const onRequestAborted = () => killChild(`${label}: request aborted`);

      if (options.req && !options.req.destroyed) {
        // Do not listen to req.close here. In Express/Node it can fire for a
        // normally completed request body, which previously killed short-lived
        // validation workers and made every render fail at the AST gate.
        options.req.on('aborted', onRequestAborted);
      }

      const timer = setTimeout(() => {
        killChild(`${label}: timeout after ${timeoutMs}ms`);
        settled = true;
        cleanupPayload();
        options.req?.removeListener('aborted', onRequestAborted);
        reject(new Error(`Python process timed out (${Math.round(timeoutMs / 1000)}s) [script=${scriptName}, scriptLen=${scriptLen}, rows=${rowCount}]${stderr ? ` stderr=${stderr.slice(0, 400)}` : ''}`));
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        cleanupPayload();
        options.req?.removeListener('aborted', onRequestAborted);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        cleanupPayload();
        options.req?.removeListener('aborted', onRequestAborted);

        if (code !== 0) {
          reject(new Error(`Python exited ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse Python JSON output: ${e}\nSTDERR:\n${stderr}`));
        }
      });
    });
  }

  function cleanScript(script: string): string {
    return script.replace(/^```[a-z]*\n?/im, '').replace(/\n?```\s*$/i, '');
  }

  function resolveDatasetAbsolutePath(storedPath: string): string {
    return path.resolve(process.cwd(), storedPath);
  }

  function readWorkbookFromFile(filePath: string): XLSX.WorkBook {
    const buffer = fs.readFileSync(filePath);
    return XLSX.read(buffer, { type: 'buffer' });
  }

  function loadDatasetRows(filePath: string): any[] {
    const absPath = resolveDatasetAbsolutePath(filePath);
    const ext = path.extname(absPath).toLowerCase();

    if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      const fileContent = fs.readFileSync(absPath, 'utf8');
      const delimiter = ext === '.tsv' ? '\t' : ',';
      const parsed = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        delimiter,
        dynamicTyping: true,
      });
      return Array.isArray(parsed.data) ? parsed.data as any[] : [];
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = readWorkbookFromFile(absPath);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet, { defval: null });
      return Array.isArray(json) ? json as any[] : [];
    }

    return [];
  }

  function buildProjectDataPayload(datasets: DatasetEntry[]): Record<string, unknown> | null {
    if (!datasets || datasets.length === 0) {
      return null;
    }

    const firstDataset = datasets[0];
    const customData = loadDatasetRows(firstDataset.filePath);
    return {
      custom_data: customData,
      datasets: datasets.map(dataset => ({
        datasetId: dataset.datasetId,
        fileName: dataset.fileName,
        filePath: dataset.filePath,
        columns: dataset.columns,
        rowCount: dataset.rowCount,
        uploadedAt: dataset.uploadedAt,
      })),
    };
  }

  function applyCodePatch(script: string, patch: any): string {
    const lines = script.split('\n');
    if (!/^#[0-9A-Fa-f]{6}$/.test(patch.new_value)) {
      throw new Error(`无效的颜色值: ${patch.new_value}`);
    }
    const inlineMatch = String(patch.target_id || '').match(/^inline_(\d+)_(\d+)_([0-9a-fA-F]{6})$/);
    if (inlineMatch) {
      const lineIndex = Number(inlineMatch[1]) - 1;
      const occurrenceIndex = Number(inlineMatch[2]);
      const originalHex = `#${inlineMatch[3]}`;
      if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`内联颜色行号无效: ${patch.target_id}`);
      }
      let seen = 0;
      lines[lineIndex] = lines[lineIndex].replace(/#[0-9A-Fa-f]{6}/g, (match) => {
        if (match.toLowerCase() !== originalHex.toLowerCase()) return match;
        seen += 1;
        return seen === occurrenceIndex ? patch.new_value : match;
      });
      if (seen < occurrenceIndex) {
        throw new Error(`未找到内联颜色: ${patch.target_id}`);
      }
      return lines.join('\n');
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
      const astCheck = await validateAst(script, req);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
      }
      const existingSession = req.body.sessionId ? loadSession(req.body.sessionId) : null;
      const effectiveDataPayload = dataPayload !== undefined
        ? dataPayload
        : existingSession?.dataPayload || null;
      const result = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload: effectiveDataPayload,
        editLog: compressEditLog(editLog || []),
        renderOptions: renderOptions || { dpi: 150 },
      }, { req, label: 'render' });
      if (result.status === 'success') {
        const sessionId = result.sessionId || `fig_${Date.now()}`;
        const nextEditLog = editLog || [];
        persistSession({
          sessionId,
          script,
          dataPayload: effectiveDataPayload,
          editLog: nextEditLog,
          revision: result.revision || 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        result.sessionId = sessionId;
        result.editLog = nextEditLog;
        result.revision = result.revision || 1;
      }
      res.json(result);
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

      const requestId = typeof req.body.requestId === 'string'
        ? req.body.requestId
        : `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const baseRevision = typeof req.body.baseRevision === 'number'
        ? req.body.baseRevision
        : session.revision;

      // Idempotency: return cached response if already processed
      if (!processedRequestIdsMap.has(sessionId)) {
        processedRequestIdsMap.set(sessionId, new Set());
        responseCacheMap.set(sessionId, new Map());
      }
      const processedIds = processedRequestIdsMap.get(sessionId)!;
      const cache = responseCacheMap.get(sessionId)!;
      if (processedIds.has(requestId)) {
        const cached = cache.get(requestId);
        if (cached) return res.json(cached);
      }

      const revisionWarning = baseRevision !== session.revision
        ? {
            type: 'revision_mismatch',
            message: 'Client revision was stale; patch was applied to the latest server session.',
            expectedRevision: session.revision,
            receivedRevision: baseRevision,
          }
        : null;

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

      const patchTimestamp = Date.now();
      const newEdits: EditEntry[] = regularPatches.map((p: any) => ({
        gid: p.gid,
        prop: p.prop,
        value: p.value,
        mode: p.mode || 'backend_patch',
        timestamp: patchTimestamp,
      }));

      const backendPatches = newEdits.filter(e => e.mode === 'backend_patch');
      const localPatches = newEdits.filter(e => e.mode === 'local_patch');

      // If it's purely local patches and no code patches, only append to editLog
      if (backendPatches.length === 0 && codePatches.length === 0) {
        session.editLog.push(...localPatches);
        session.revision++;
        persistSession(session);
        syncProjectFigureRevision(session.sessionId, session.revision);
        const response = {
          status: 'success',
          sessionId,
          applied: newEdits,
          revision: session.revision,
          editLog: session.editLog,
          script: session.script,
          requestId,
          warnings: revisionWarning ? [revisionWarning] : undefined,
        };
        processedIds.add(requestId);
        cache.set(requestId, response);
        return res.json(response);
      }

      // Check if session is linked to a project figure to supply sandbox metadata
      const figRow = getDb().prepare('SELECT * FROM project_figures WHERE session_id = ?').get(sessionId) as any;
      let cwd: string | undefined;
      let uploaded_file_paths: Record<string, string> | undefined;

      if (figRow) {
        const projectId = figRow.project_id;
        const datasets = listProjectFiles(projectId);
        const projectDataPayload = buildProjectDataPayload(datasets);
        session.dataPayload = projectDataPayload;
        uploaded_file_paths = {};
        datasets.forEach(d => {
          addUploadedFilePathAliases(uploaded_file_paths!, d.fileName, d.filePath);
        });
        cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files').replace(/\\/g, '/');
      }

      // Otherwise, re-render with updated script and editLog
      const mergedEditLog = [...session.editLog, ...backendPatches];
      const result = await spawnPythonWithPayload('introspector.py', {
        script: session.script,
        dataPayload: session.dataPayload || null,
        editLog: compressEditLog(mergedEditLog),
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: figRow ? { [`fig_${figRow.figure_index + 1}`]: compressEditLog(mergedEditLog) } : undefined
      }, { req, label: 'patch' });
      if (result.status === 'success') {
        session.editLog = mergedEditLog;
        session.revision++;
        persistSession(session);
        syncProjectFigureRevision(session.sessionId, session.revision);
        if (figRow && codePatches.length > 0) {
          persistProjectScript(figRow.project_id, session.script);
        }
        result.sessionId = session.sessionId;
        result.revision = session.revision;
        result.editLog = session.editLog;
        result.script = session.script;

        if (figRow) {
          const targetFigId = `fig_${figRow.figure_index + 1}`;
          const matchedFig = result.figures?.find((f: any) => f.figureId === targetFigId);
          if (matchedFig) {
            result.svg = matchedFig.svg;
            result.manifest = matchedFig.manifest;
            result.codeSlice = matchedFig.codeSlice;
          }
        }
      }
      const response = { ...result, requestId };
      if (revisionWarning) {
        response.warnings = [...(response.warnings || []), revisionWarning];
      }
      processedIds.add(requestId);
      cache.set(requestId, response);
      res.json(response);
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
      const astCheck = await validateAst(script, req);
      if (!astCheck.ok) {
        return res.status(400).json({
          status: 'error',
          message: 'AST 校验失败',
          details: astCheck.message,
          errors: astCheck.errors
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
        dataPayload = buildProjectDataPayload(datasets);
        uploaded_file_paths = {};
        datasets.forEach(d => {
          addUploadedFilePathAliases(uploaded_file_paths!, d.fileName, d.filePath);
        });
        cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files').replace(/\\/g, '/');
      }

      // 2. Re-render via introspector with new script + old editLog
      const result = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload,
        editLog: compressEditLog(editLog),
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: figRow ? { [`fig_${figRow.figure_index + 1}`]: compressEditLog(editLog) } : undefined
      }, { req, label: 'code-patch' });

      if (result.status !== 'success') {
        return res.json(result); // Returns python error directly
      }

      if (figRow) {
        const targetFigId = `fig_${figRow.figure_index + 1}`;
        const matchedFig = result.figures?.find((f: any) => f.figureId === targetFigId);
        if (matchedFig) {
          result.svg = matchedFig.svg;
          result.manifest = matchedFig.manifest;
          result.codeSlice = matchedFig.codeSlice;
        } else {
          return res.json({
            status: 'drift_warning',
            message: '目标 Figure 在重渲染后不存在',
            figureId: targetFigId,
            availableFigures: (result.figures || []).map((f: any) => f.figureId)
          });
        }
      }

      // 3. Detect drift
      const returnedGids = new Set(result.manifest.objects.map((o: any) => o.id));
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
        syncProjectFigureRevision(session.sessionId, session.revision);
        if (figRow) {
          persistProjectScript(figRow.project_id, script);
        }
        result.revision = session.revision;
        result.sessionId = session.sessionId;
        result.editLog = session.editLog;
      } else {
        const newSessionId = result.sessionId || `fig_${Date.now()}`;
        persistSession({
          sessionId: newSessionId,
          script,
          dataPayload,
          editLog: [],
          revision: result.revision || 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        result.sessionId = newSessionId;
        result.editLog = [];
      }

      res.json(result);
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
      const astCheck = await validateAst(session.script, req);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
      }

      // 1. Ensure we have the latest SVG and export if necessary
      const result = await spawnPythonWithPayload('introspector.py', {
        script: session.script,
        dataPayload: session.dataPayload || null,
        editLog: compressEditLog(session.editLog),
        renderOptions: { dpi: dpi || 300 },
        export_format: reqFormat !== 'svg' ? reqFormat : undefined,
      }, { req, label: 'export' });
      if (result.status !== 'success') {
        return res.json(result);
      }
      
      const svg = result.svg;
      let binary_b64 = result.binary_b64 || null;
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
        format_note,
        warnings: result.warnings ?? []
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

  app.get('/api/projects/:id/files/:fileId/preview', (req, res) => {
    try {
      const projectId = req.params.id;
      const fileId = req.params.fileId;
      assertSafeProjectId(projectId);
      const project = getProject(projectId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }

      const datasets = listProjectFiles(projectId);
      const dataset = datasets.find(d => d.datasetId === fileId);
      if (!dataset) {
        return res.status(404).json({
          status: 'error',
          message: `数据文件不存在: ${fileId}`,
          availableFiles: datasets.map(d => ({ datasetId: d.datasetId, fileName: d.fileName }))
        });
      }

      const requestedLimit = Number(req.query.limit || 500);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(2000, Math.floor(requestedLimit)))
        : 500;
      const rows = loadDatasetRows(dataset.filePath);

      res.json({
        status: 'success',
        dataset: {
          datasetId: dataset.datasetId,
          fileName: dataset.fileName,
          columns: dataset.columns,
          rowCount: dataset.rowCount,
          uploadedAt: dataset.uploadedAt,
        },
        rows: rows.slice(0, limit),
        returnedRows: Math.min(rows.length, limit),
        totalRows: rows.length,
        limit,
      });
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
        const workbook = readWorkbookFromFile(file.path);
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
      const astCheck = await validateAst(script, req);
      if (!astCheck.ok) {
        return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
      }

      // Update script in projects table
      const projectRow = getProject(projectId);
      if (projectRow) {
        updateProject(projectId, projectRow.name, JSON.parse(projectRow.spec), script);
      }

      const datasets = listProjectFiles(projectId);
      const projectDataPayload = buildProjectDataPayload(datasets);
      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath);
      });

      const cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files');
      fs.mkdirSync(cwd, { recursive: true });

      // Read existing figure bindings before render so omitted editLogs still
      // participate in the returned SVG/manifest, not only in persisted state.
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
      const effectiveEditLogs = { ...oldEditLogMap, ...(editLogs || {}) };
      const compressedEditLogs: Record<string, EditEntry[]> = {};
      for (const key of Object.keys(effectiveEditLogs)) {
        compressedEditLogs[key] = compressEditLog(effectiveEditLogs[key]);
      }

      const result = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload: projectDataPayload,
        cwd: cwd.replace(/\\/g, '/'),
        uploaded_file_paths,
        editLogs: compressedEditLogs,
        renderOptions: { dpi: 150 }
      }, { req, label: 'project-render' });

      if (result.status === 'success') {
        // Detect figure count drift
        const newFigures = result.figures || [];
        const oldCount = oldFigRows.length;
        const newCount = newFigures.length;
        const figureCountChanged = oldCount > 0 && oldCount !== newCount;

        // Prepare figures and sessions input for transaction helper
        const figInputs: FigSessionInput[] = [];
        for (let i = 0; i < newFigures.length; i++) {
          const fig = newFigures[i];
          const figKey = `fig_${i + 1}`;
          const figSessionIdResolved = `${projectId}_${figKey}`;
          const incomingEditLog = effectiveEditLogs?.[fig.figureId];
          const preservedEditLog = incomingEditLog !== undefined
            ? incomingEditLog
            : (oldEditLogMap[figKey] || []);
          figInputs.push({
            figureIndex: i,
            sessionId: figSessionIdResolved,
            editLog: preservedEditLog,
            revision: oldSessionMap[figKey]?.revision || 1
          });
          fig.revision = oldSessionMap[figKey]?.revision || 1;
          fig.editLog = preservedEditLog;
        }

        // Atomically replace figures and sessions using the database transaction helper
        replaceProjectFiguresAndSessions(projectId, figInputs, script, projectDataPayload);

        // Attach figure count drift warning
        if (figureCountChanged) {
          result._warnings = result._warnings || [];
          result._warnings.push({
            type: 'figure_count_changed',
            message: `Figure 数量从 ${oldCount} 变为 ${newCount}，部分编辑可能无法完全重放`,
            oldCount,
            newCount
          });
        }

        // Figure fingerprint comparison — detect content/structure changes
        const oldFingerprints: Record<string, number> = {};
        for (const row of oldFigRows) {
          const key = `fig_${row.figure_index + 1}`;
          const sess = loadSession(row.session_id);
          if (sess && (sess as any)._fingerprint) {
            oldFingerprints[key] = (sess as any)._fingerprint;
          }
        }
        if (Object.keys(oldFingerprints).length > 0) {
          const mismatchedFigs: string[] = [];
          for (let i = 0; i < newFigures.length; i++) {
            const figKey = `fig_${i + 1}`;
            const newFp = newFigures[i].fingerprint;
            if (oldFingerprints[figKey] !== undefined && oldFingerprints[figKey] !== newFp) {
              mismatchedFigs.push(figKey);
            }
          }
          if (mismatchedFigs.length > 0) {
            result._warnings = result._warnings || [];
            result._warnings.push({
              type: 'figure_fingerprint_mismatch',
              message: `以下 Figure 内容结构变化，编辑可能不完全匹配: ${mismatchedFigs.join(', ')}`,
              mismatchedFigs
            });
          }
        }

        // Persist fingerprints for next comparison
        for (const fig of newFigures) {
          const figKey = fig.figureId;
          const figSessionId = `${projectId}_${figKey}`;
          const sess = loadSession(figSessionId);
          if (sess) {
            (sess as any)._fingerprint = fig.fingerprint;
            persistSession(sess);
          }
        }
      }

      res.json(result);
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

  app.get('/api/projects/:id/export-assets', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      res.json({ status: 'success', assets: listExportAssets(projectId) });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/projects/:id/export-assets/:assetId/file', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const asset = getExportAsset(req.params.assetId);
      if (!asset || asset.projectId !== projectId) {
        return res.status(404).json({ status: 'error', message: '导出资产不存在' });
      }
      const absPath = path.resolve(process.cwd(), asset.filePath);
      const root = projectExportsDir(projectId);
      if (!absPath.startsWith(root + path.sep) || !fs.existsSync(absPath)) {
        return res.status(404).json({ status: 'error', message: '导出文件不存在' });
      }
      res.setHeader('Content-Type', exportMimeType(asset.format));
      res.download(absPath, `${safeExportName(asset.name)}.${asset.format}`);
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.delete('/api/projects/:id/export-assets', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const assetIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const assets = listExportAssets(projectId).filter(asset => assetIds.includes(asset.assetId));
      for (const asset of assets) {
        const absPath = path.resolve(process.cwd(), asset.filePath);
        const root = projectExportsDir(projectId);
        if (absPath.startsWith(root + path.sep) && fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
        }
      }
      const deleted = deleteExportAssets(projectId, assetIds);
      res.json({ status: 'success', deleted });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/export-assets/import', (req, res) => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const format = String(req.body?.format || '').toLowerCase();
      if (!['svg', 'png'].includes(format)) {
        return res.status(400).json({ status: 'error', message: `不支持导入的导出格式: ${format}` });
      }
      const svg = typeof req.body?.svg === 'string' ? req.body.svg : undefined;
      const binaryB64 = typeof req.body?.binary_b64 === 'string' ? req.body.binary_b64 : undefined;
      if (format === 'svg' && !svg) {
        return res.status(400).json({ status: 'error', message: 'SVG 内容不能为空' });
      }
      if (format === 'png' && !binaryB64) {
        return res.status(400).json({ status: 'error', message: 'PNG 二进制内容不能为空' });
      }
      const asset = persistProjectExportAsset({
        projectId,
        figureId: req.body?.figureId || 'composite',
        name: req.body?.name || '组合图',
        format,
        dpi: req.body?.dpi ?? null,
        svg,
        binaryB64,
        thumbnailSvg: req.body?.thumbnailSvg || svg || null,
        metadata: req.body?.metadata || { kind: 'client-imported-export' },
        tags: Array.isArray(req.body?.tags) ? req.body.tags : ['composite'],
      });
      res.json({ status: 'success', asset });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/compose', (req, res) => {
    void (async () => {
    try {
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const assetIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const assetMap = new Map(listExportAssets(projectId).map(asset => [asset.assetId, asset]));
      const selected = assetIds.map(id => assetMap.get(id)).filter(Boolean) as ExportAsset[];
      if (![2, 4, 6].includes(selected.length)) {
        return res.status(400).json({ status: 'error', message: '组合排版 MVP 目前支持选择 2、4 或 6 张图' });
      }
      const missingSvg = selected.filter(asset => !asset.thumbnailSvg);
      if (missingSvg.length > 0) {
        return res.status(400).json({ status: 'error', message: '选中的资产缺少 SVG 预览，无法组合排版' });
      }
      const layout = req.body?.layout && typeof req.body.layout === 'object' ? req.body.layout as ComposeLayout : undefined;
      const dpi = Number(req.body?.dpi || 300);
      const svg = composeSvgAssets(selected, layout);
      const asset = persistProjectExportAsset({
        projectId,
        figureId: 'composite',
        name: req.body?.name || `组合图_${selected.length}张`,
        format: 'svg',
        dpi: null,
        svg,
        thumbnailSvg: svg,
        metadata: {
          kind: 'composite',
          sourceAssetIds: selected.map(item => item.assetId),
          sourceNames: selected.map(item => item.name),
          layout: layout || null,
          createdBy: 'figure-composer',
        },
        tags: ['composite'],
      });
      res.json({ status: 'success', svg, asset, assets: [asset] });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
    })();
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
      const { figureId, format, dpi, name, saveToLibrary = true } = req.body;
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
        const astCheck = await validateAst(script, req);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
        }
      }
      const datasets = listProjectFiles(projectId);
      const projectDataPayload = buildProjectDataPayload(datasets);

      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath);
      });

      const cwd = path.join(process.cwd(), 'data', 'projects', projectId, 'files');

      for (const fig of targetFigs) {
        const session = loadSession(fig.session_id);
        if (!session) continue;

        const targetFigId = `fig_${fig.figure_index + 1}`;
        const result = await spawnPythonWithPayload('introspector.py', {
          script: session.script,
          dataPayload: projectDataPayload || session.dataPayload || null,
          cwd: cwd.replace(/\\/g, '/'),
          uploaded_file_paths,
          editLogs: { [targetFigId]: compressEditLog(session.editLog) },
          renderOptions: { dpi: dpi || 300 },
          export_format: reqFormat !== 'svg' ? reqFormat : undefined,
        }, { req, label: 'project-export' });

        if (result.status === 'success') {
          const matchedFig = result.figures?.find((f: any) => f.figureId === targetFigId) || result;
          const asset = saveToLibrary !== false ? persistProjectExportAsset({
            projectId,
            figureId: targetFigId,
            name: name || targetFigId,
            format: matchedFig.binary_b64 ? reqFormat : 'svg',
            dpi: dpi || 300,
            svg: matchedFig.svg,
            binaryB64: matchedFig.binary_b64 || null,
            thumbnailSvg: matchedFig.svg,
            metadata: {
              exportedFrom: targetFigId,
              requestedFormat: reqFormat,
            },
            tags: ['figure'],
          }) : null;
          results.push({
            figureId: targetFigId,
            svg: matchedFig.svg,
            binary_b64: matchedFig.binary_b64 || null,
            format: matchedFig.binary_b64 ? reqFormat : 'svg',
            asset
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
