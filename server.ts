import 'dotenv/config';
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
import express from 'express';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import { buildFigureRenderCacheKey } from './src/utils/renderCacheKey';
import { fnv1a } from './src/utils/stableJson';
import { diagramRelationSignature, requiresDiagramRelationIdentity } from './src/utils/diagramIdentity';
import {
  hasSpecialAxesMetadata,
  requiresSpecialAxesRelationIdentity,
  specialAxesRelationSignature,
} from './src/utils/specialAxesIdentity';
import { blockingRRisks, scanRScriptRisks, type RRiskFinding } from './src/utils/rRiskScanner';
import { planCompositionLayout } from './src/utils/compositionPlanner';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import { performance } from 'node:perf_hooks';
import Papa from 'papaparse';
import * as archiver from 'archiver';
import { applyColorCodePatch } from './src/utils/codeColorPatch';
import { isDurableVirtualEditGid, mergePreviewGlobalsIntoEditLog } from './src/utils/exportPreviewState';
import { resolveAuthoritativeProjectPatchMode } from './src/utils/propertyPatchMode';
import { sanitizeLegacyRetireObservationBatch } from './src/utils/legacyRetireObservation';
import { KeyedMutationGate } from './src/utils/keyedMutationGate';
import {
  EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  PRE_CAPABILITY_AUTHORITY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
  parseExportEditingSnapshot,
  type ExportDatasetSnapshotV1,
  type ExportEditingSnapshot,
  type ExportEditingSnapshotV4,
  type ExportFigureSnapshotV1,
  type ExportFigureSnapshotV2,
  type ExportFigureSnapshotV4,
} from './src/schemas/exportEditingSnapshot';
import {
  AbortableWorkQueue,
  DeploymentLifecycle,
  type DeploymentDrainReason,
  type DeploymentJobKind,
  type DeploymentMode,
} from './src/utils/deploymentLifecycle';
import { installAdminConsoleRoutes } from './server/admin/console';
import { adminOperationsEnabled } from './server/admin/featureFlags';
import {
  emailVerificationRequired,
  emailVerificationTtlMinutes,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
  maskEmailAddress,
  sendEmailVerificationCode,
} from './server/auth/emailVerification';
import { assertSafeSvgDocument } from './server/security/svgSafety';
import { assertValidUploadedDataFile, decodeAndValidatePngBase64 } from './server/security/fileValidation';
import {
  assertRendererDataPayload,
  assertTabularShape,
  canInlineDataset,
  inspectDelimitedFile,
  loadDelimitedRows,
  tabularInspectionLimits,
  tabularSafetyLimits,
} from './server/security/tabularSafety';
import {
  assertArchiveBudget,
  assertGlobalStorageBudget,
  assertProjectTotalStorageBudget,
  assertProjectStorageBudget,
  assertUserTotalStorageBudget,
  assertUserStorageBudget,
  singleUploadLimitBytes,
} from './server/security/resourceBudgets';
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
  getExportAssetSnapshot,
  deleteExportAssets,
  createUserAccount,
  createEmailVerificationChallenge,
  consumeEmailVerificationChallenge,
  getUserByEmail,
  getUserById,
  getUserByAuthToken,
  touchUserLogin,
  createAuthSession,
  revokeAuthToken,
  verifyPasswordAndMigrate,
  rotateRefreshSession,
  revokeRefreshToken,
  upsertDevice,
  getActiveDeviceCount,
  getLicenseState,
  redeemCodeForUser,
  createRedeemCode,
  logLicenseCheck,
  logAdminAudit,
  consumeScopedHourlyUsageBudget,
  listAdminAuditLogs,
  claimLegacyOwnership,
  type FigSessionInput,
  type DatasetEntry,
  type FigureEntry,
  type ExportAsset,
  type UserAccount
} from './db';

const DATA_ROOT = process.env.SCIFIGURE_DATA_DIR
  ? path.resolve(process.env.SCIFIGURE_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');

async function startServer() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS render_cache (
      cache_key TEXT PRIMARY KEY,
      svg TEXT NOT NULL,
      manifest TEXT NOT NULL,
      code_slice TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  function normalizeDiagnosticWarnings(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    return value.filter((warning): warning is Record<string, unknown> => (
      Boolean(warning)
      && typeof warning === 'object'
      && typeof (warning as any).type === 'string'
      && typeof (warning as any).message === 'string'
    ));
  }

  function renderDiagnosticsFrom(source: any, manifest?: any): Record<string, unknown> | undefined {
    const direct = source?.diagnostics;
    const stored = manifest?.renderDiagnostics;
    const determinismSource = source?.determinismWarnings
      ?? direct?.determinismWarnings
      ?? stored?.determinismWarnings;
    const layoutSource = source?.layoutWarnings
      ?? direct?.layoutWarnings
      ?? stored?.layoutWarnings;
    const layoutDiagnosticsSource = source?.timingBreakdown?.layoutDiagnosticsMs
      ?? direct?.layoutDiagnosticsMs
      ?? stored?.layoutDiagnosticsMs;
    const hasDiagnostics = Array.isArray(determinismSource)
      || Array.isArray(layoutSource)
      || Number.isFinite(Number(layoutDiagnosticsSource));
    if (!hasDiagnostics) return undefined;

    const layoutDiagnosticsMs = Number(layoutDiagnosticsSource);
    return {
      determinismWarnings: normalizeDiagnosticWarnings(determinismSource),
      layoutWarnings: normalizeDiagnosticWarnings(layoutSource),
      ...(Number.isFinite(layoutDiagnosticsMs)
        ? { layoutDiagnosticsMs: Math.max(0, Math.round(layoutDiagnosticsMs)) }
        : {}),
    };
  }

  function withRenderDiagnostics(manifest: any, source: any): any {
    if (!manifest || typeof manifest !== 'object') return manifest;
    const diagnostics = renderDiagnosticsFrom(source, manifest);
    return diagnostics ? { ...manifest, renderDiagnostics: diagnostics } : manifest;
  }

  function renderDiagnosticsSourceForFigure(renderResult: any, figure: any): any {
    const storedLayoutWarnings = figure?.manifest?.renderDiagnostics?.layoutWarnings;
    return {
      ...renderResult,
      layoutWarnings: Array.isArray(figure?.layoutWarnings)
        ? figure.layoutWarnings
        : Array.isArray(storedLayoutWarnings) ? storedLayoutWarnings : [],
    };
  }

  function getCachedRender(cacheKey: string) {
    try {
      const row = getDb().prepare('SELECT svg, manifest, code_slice FROM render_cache WHERE cache_key = ?').get(cacheKey) as any;
      if (row) {
        return {
          svg: row.svg,
          manifest: JSON.parse(row.manifest),
          codeSlice: row.code_slice ? JSON.parse(row.code_slice) : null
        };
      }
    } catch (e) {
      console.error('Failed to read from render cache:', e);
    }
    return null;
  }

  function setCachedRender(cacheKey: string, svg: string, manifest: any, codeSlice?: any, diagnosticsSource?: any) {
    try {
      const cachedManifest = withRenderDiagnostics(manifest, diagnosticsSource);
      getDb().prepare(`
        INSERT OR REPLACE INTO render_cache (cache_key, svg, manifest, code_slice)
        VALUES (?, ?, ?, ?)
      `).run(cacheKey, svg, JSON.stringify(cachedManifest), codeSlice ? JSON.stringify(codeSlice) : null);
    } catch (e) {
      console.error('Failed to write to render cache:', e);
    }
  }

  const validatedPythonPatchCacheKeys = new Set<string>();

  async function computeRenderCacheKey(session: any, projectContext: any, editLogOverride?: any[]): Promise<string> {
    const engine = session.language === 'r' ? 'r_ggplot' : 'python_matplotlib';
    const projectId = projectContext?.projectId || 'single';
    const figureId = projectContext?.figureId || session.sessionId;
    let figureFingerprint = '';
    if (projectContext?.figRow) {
      figureFingerprint = projectContext.figRow.fingerprint || '';
    } else if ((session as any)._fingerprint) {
      figureFingerprint = (session as any)._fingerprint;
    }

    return buildFigureRenderCacheKey({
      engine,
      projectId,
      figureId,
      script: session.script || '',
      dataPayload: session.dataPayload || {},
      figureFingerprint,
      editLog: editLogOverride ?? session.editLog ?? [],
      renderOptions: session.language === 'r' ? { width_in: 7, height_in: 5 } : { dpi: 150 },
    });
  }

  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const BIND_HOST = String(process.env.SCIFIGURE_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
  const processedRequestIdsMap = new Map<string, Set<string>>();
  const responseCacheMap = new Map<string, Map<string, any>>();
  const requestAuthContext = new WeakMap<express.Request, { user: UserAccount; token: string; deviceId: string | null }>();
  const requestWorkAbortSignals = new WeakMap<express.Request, AbortSignal>();
  const deploymentLifecycle = new DeploymentLifecycle();
  const activeRendererAborters = new Set<() => void>();
  const renderWorkQueue = new AbortableWorkQueue(() => renderConcurrencyLimit());
  const figureMutationGate = new KeyedMutationGate();
  const projectMutationGate = new KeyedMutationGate();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.SCIFIGURE_TRUST_PROXY === 'loopback' ? 'loopback' : false);

  type RateLimitBucket = {
    count: number;
    resetAt: number;
  };

  function clientIp(req: express.Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  function createRateLimiter(options: {
    windowMs: number;
    max: number;
    message: string;
    key?: (req: express.Request) => string;
    skip?: (req: express.Request) => boolean;
  }) {
    const buckets = new Map<string, RateLimitBucket>();
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (options.skip?.(req)) return next();
      const now = Date.now();
      const key = options.key ? options.key(req) : clientIp(req);
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs });
        return next();
      }
      existing.count += 1;
      if (existing.count > options.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          status: 'error',
          message: options.message,
          retryAfterSeconds,
        });
      }
      if (buckets.size > 5000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(bucketKey);
        }
      }
      return next();
    };
  }

  const apiRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 240),
    message: '请求过于频繁，请稍后再试。',
    skip: req => !req.path.startsWith('/api/') || req.path.startsWith('/api/health/'),
  });

  const authRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_PER_15_MINUTES || 20),
    message: '登录或注册尝试过于频繁，请稍后再试。',
    key: req => `${clientIp(req)}:${String(req.body?.email || req.body?.identifier || '').trim().toLowerCase()}`,
  });

  const renderRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.RENDER_RATE_LIMIT_PER_MINUTE || 30),
    message: '渲染或导出请求过于频繁，请稍后再试。',
  });

  const adminRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.ADMIN_RATE_LIMIT_PER_15_MINUTES || 60),
    message: '管理操作过于频繁，请稍后再试。',
  });

  const emailVerificationRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.EMAIL_VERIFICATION_RATE_LIMIT_PER_15_MINUTES || 8),
    message: '邮箱验证码请求过于频繁，请稍后再试。',
    key: req => `${clientIp(req)}:${String(req.body?.email || '').trim().toLowerCase()}`,
  });

  const requireAdminOperationsEnabled = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!adminOperationsEnabled()) {
      return res.status(404).json({ status: 'error', message: 'Not found' });
    }
    return next();
  };

  const errorReportRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.ERROR_REPORT_RATE_LIMIT_PER_MINUTE || 30),
    message: '错误上报过于频繁，请稍后再试。',
    key: req => {
      const token = readBearerToken(req);
      const tokenKey = token
        ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 24)
        : 'anonymous';
      return `${clientIp(req)}:${tokenKey}`;
    },
  });

  function authenticatedRequestKey(req: express.Request): string {
    const token = readBearerToken(req);
    const tokenKey = token
      ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 24)
      : 'anonymous';
    return `${clientIp(req)}:${tokenKey}`;
  }

  const uploadRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.UPLOAD_RATE_LIMIT_PER_HOUR || 30),
    message: '数据文件上传过于频繁，请稍后再试。',
    key: authenticatedRequestKey,
  });

  const downloadRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.DOWNLOAD_RATE_LIMIT_PER_HOUR || 120),
    message: '导出文件下载过于频繁，请稍后再试。',
    key: authenticatedRequestKey,
  });

  function assertHourlyByteBudget(
    req: express.Request,
    res: express.Response,
    category: 'upload_bytes' | 'download_bytes',
    bytes: number,
  ): void {
    const configuredMb = category === 'upload_bytes'
      ? boundedNumber(process.env.SCIFIGURE_UPLOAD_MAX_MB_PER_HOUR, 200, 50, 10_240)
      : boundedNumber(process.env.SCIFIGURE_DOWNLOAD_MAX_MB_PER_HOUR, 250, 50, 10_240);
    const globalMb = category === 'upload_bytes'
      ? boundedNumber(process.env.SCIFIGURE_GLOBAL_UPLOAD_MAX_MB_PER_HOUR, 1_024, 100, 10_240)
      : boundedNumber(process.env.SCIFIGURE_GLOBAL_DOWNLOAD_MAX_MB_PER_HOUR, 512, 100, 10_240);
    const result = consumeScopedHourlyUsageBudget(
      authenticatedUserId(req),
      category,
      Math.max(0, Math.floor(bytes)),
      configuredMb * 1024 * 1024,
      globalMb * 1024 * 1024,
    );
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(result.resetAt) - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      const action = category === 'upload_bytes' ? '上传' : '下载';
      const error = new Error(result.blockedScope === 'global'
        ? `平台本小时${action}流量已达到安全上限，请稍后再试`
        : `该账号本小时${action}总量已达到 ${configuredMb} MB 安全上限`);
      (error as any).statusCode = 429;
      throw error;
    }
  }

  function requestBodyByteLength(req: express.Request): number {
    const captured = Number((req as any).scifigureRawBodyBytes);
    if (Number.isFinite(captured) && captured >= 0) return Math.floor(captured);
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared >= 0) return Math.floor(declared);
    const error = new Error('该上传请求必须提供可计量的 Content-Length');
    (error as any).statusCode = 411;
    throw error;
  }

  function meterExportAssetImport(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
      assertHourlyByteBudget(req, res, 'upload_bytes', requestBodyByteLength(req));
      if (!req.is('application/json')) {
        return res.status(415).json({ status: 'error', message: '导出资产导入仅接受 application/json' });
      }
      return next();
    } catch (err: any) {
      return res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  }

  function renderConcurrencyLimit(): number {
    return boundedNumber(process.env.SCIFIGURE_RENDER_CONCURRENCY, 4, 1, 8);
  }

  function deploymentState() {
    return {
      ...deploymentLifecycle.snapshot(),
      renderer: {
        ...renderWorkQueue.snapshot(),
        workers: activeRendererAborters.size,
      },
    };
  }

  function adminConsoleRendererSnapshot() {
    const snapshot = renderWorkQueue.snapshot();
    return {
      active: Number(snapshot.active || 0),
      queued: Number(snapshot.queued || 0),
      workers: activeRendererAborters.size,
      concurrency: renderConcurrencyLimit(),
    };
  }

  function deploymentJobHandler(
    kind: DeploymentJobKind,
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown | Promise<unknown>,
  ) {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        authenticatedUserId(req);
      } catch (err: any) {
        return res.status(Number(err?.statusCode || 401)).json({ status: 'error', message: err.message });
      }
      const lease = deploymentLifecycle.tryStartJob(kind);
      if (!lease.accepted) {
        res.setHeader('Retry-After', '15');
        return res.status(503).json({
          status: 'draining',
          code: 'INSTANCE_DRAINING',
          message: '服务正在进行无感升级，新的渲染和导出任务已暂停，请稍后重试。',
          retryAfterSeconds: 15,
        });
      }
      const workAbortController = new AbortController();
      const abortDisconnectedWork = () => {
        if (!res.writableFinished) workAbortController.abort('client disconnected');
      };
      requestWorkAbortSignals.set(req, workAbortController.signal);
      res.once('close', abortDisconnectedWork);
      try {
        return await handler(req, res, next);
      } catch (err) {
        return next(err);
      } finally {
        res.removeListener('close', abortDisconnectedWork);
        requestWorkAbortSignals.delete(req);
        lease.finish();
      }
    };
  }

  function trackRendererAborter(abort: () => void): () => void {
    activeRendererAborters.add(abort);
    return () => activeRendererAborters.delete(abort);
  }

  function requestWorkAbortSignal(req?: express.Request): AbortSignal | undefined {
    return req ? requestWorkAbortSignals.get(req) : undefined;
  }

  function finalizeArchiveResponse(archive: any, req: express.Request, res: express.Response): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = requestWorkAbortSignal(req);
      const cleanup = () => {
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        archive.removeListener?.('error', onError);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onFinish = () => finish();
      const onClose = () => {
        if (!res.writableFinished) archive.abort?.();
        finish();
      };
      const onAbort = () => {
        archive.abort?.();
        finish();
      };
      const onError = (error: Error) => finish(error);
      res.once('finish', onFinish);
      res.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      archive.once('error', onError);
      archive.pipe(res);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        Promise.resolve(archive.finalize()).catch(onError);
      } catch (error: any) {
        onError(error);
      }
    });
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const cspMode = String(process.env.SCIFIGURE_CSP_MODE || 'report-only').toLowerCase();
    if (cspMode === 'report-only' || cspMode === 'enforce') {
      const policy = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "form-action 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "media-src 'none'",
        "manifest-src 'self'",
      ].join('; ');
      res.setHeader(cspMode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', policy);
    }
    if (process.env.SCIFIGURE_STAGING_INSTANCE === 'unified-editing') {
      res.setHeader('X-SciFigure-Runtime-Profile', 'unified-editing-staging');
    }
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  // --- Multer Storage Setup for Project Files ---
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const projectId = req.params.id;
        const uploadDir = projectFilesDir(projectId);
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
      fileSize: singleUploadLimitBytes(),
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
    // 二次校验：确保最终路径在当前配置的数据根目录下。
    const projectDir = path.resolve(PROJECTS_ROOT, projectId);
    if (!projectDir.startsWith(PROJECTS_ROOT + path.sep)) {
      throw new Error('项目路径逃逸');
    }
  }

  function safeResolveUnder(baseDir: string, targetPath: string): string {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('无效路径');
    }
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    const nativeAbsolutePath = path.isAbsolute(targetPath);
    if (
      targetPath.includes('\0') ||
      (!nativeAbsolutePath && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalizedTarget))
    ) {
      throw new Error('禁止的路径格式');
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(process.cwd(), targetPath);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw new Error('路径越界已拦截');
    }

    const nearestExistingPath = (candidate: string): string => {
      let current = candidate;
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      return current;
    };
    const existingBase = nearestExistingPath(resolvedBase);
    const existingTarget = nearestExistingPath(resolvedTarget);
    const realBase = fs.realpathSync(existingBase);
    const realTarget = fs.realpathSync(existingTarget);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw new Error('符号链接路径越界已拦截');
    }
    return resolvedTarget;
  }

  function projectRootDir(projectId: string): string {
    assertSafeProjectId(projectId);
    return safeResolveUnder(PROJECTS_ROOT, path.join(PROJECTS_ROOT, projectId));
  }

  function projectFilesDir(projectId: string): string {
    const projectRoot = projectRootDir(projectId);
    return safeResolveUnder(projectRoot, path.join(projectRoot, 'files'));
  }

  function resolveSafeRendererCwd(cwd: unknown): string | null {
    if (typeof cwd !== 'string' || !cwd.trim()) return null;
    try {
      const candidate = path.isAbsolute(cwd)
        ? path.resolve(cwd)
        : path.resolve(process.cwd(), cwd);
      const resolved = safeResolveUnder(PROJECTS_ROOT, candidate);
      return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  function resolveAllowedRendererFile(value: unknown, safeCwd: string): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const candidates = [
      path.isAbsolute(value) ? path.resolve(value) : null,
      path.resolve(safeCwd, value),
      path.resolve(process.cwd(), value),
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      try {
        const resolved = safeResolveUnder(safeCwd, candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return resolved;
        }
      } catch {
        // Try the next server-derived candidate.
      }
    }
    return null;
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
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const addNameVariants = (names: Set<string>, rawName: string) => {
      if (!rawName) return;
      names.add(rawName);
      const ext = path.extname(rawName);
      const base = path.basename(rawName, ext);
      if (base) names.add(base);

      const safeBase = base.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '');
      if (safeBase) {
        names.add(`${safeBase}${ext}`);
        names.add(safeBase);
        const trailingNumber = safeBase.match(/^(.*?)(\d+)$/);
        if (trailingNumber) {
          const parenBase = `${trailingNumber[1]}(${trailingNumber[2]})`;
          names.add(`${parenBase}${ext}`);
          names.add(parenBase);
        }
      }

      const noParenBase = base.replace(/[()]/g, '');
      if (noParenBase && noParenBase !== base) {
        names.add(`${noParenBase}${ext}`);
        names.add(noParenBase);
      }
    };

    const names = new Set<string>();
    addNameVariants(names, fileName);
    addNameVariants(names, normalizeUploadFileName(fileName));

    const storedName = path.basename(filePath);
    const storedWithoutStamp = storedName.replace(/^\d+_/, '');
    addNameVariants(names, storedName);
    addNameVariants(names, storedWithoutStamp);

    names.forEach(name => {
      target[name] = normalizedFilePath;
    });
  }

  function prepareUploadedFilePathsForR(paths: Record<string, string> | undefined, cwd?: string): Record<string, string> | undefined {
    if (!paths) return paths;
    const safeCwd = resolveSafeRendererCwd(cwd);
    if (!safeCwd) return undefined;
    const prepared: Record<string, string> = {};
    Object.entries(paths).forEach(([key, value]) => {
      const source = resolveAllowedRendererFile(value, safeCwd);
      if (source) prepared[key] = path.basename(source);
    });
    return prepared;
  }

  function inferScriptLanguage(script: string, requested?: unknown): 'python' | 'r' {
    const explicit = String(requested || '').toLowerCase();
    if (explicit === 'r' || explicit === 'rscript') return 'r';
    if (explicit === 'python' || explicit === 'py') return 'python';
    const trimmed = script.trim();
    if (trimmed.startsWith('# language: r')) return 'r';
    if (/^\s*(library|require)\s*\(/m.test(script)) return 'r';
    if (/<-\s*/.test(script) && /\b(ggplot|read\.csv|read_csv|readxl::|geom_|theme_|labs\s*\()/m.test(script)) return 'r';
    return 'python';
  }

  function rSessionScript(script: string): string {
    return script.trim().startsWith('# language: r') ? script : `# language: r\n${script}`;
  }

  function hashString(value: string): number {
    const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
    return parseInt(digest, 16);
  }

  function stableStringifyForExport(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return '';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringifyForExport).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => {
      const item = stableStringifyForExport(obj[key]);
      return item === '' ? '' : `${JSON.stringify(key)}:${item}`;
    }).filter(Boolean).join(',')}}`;
  }

  function normalizeEditLogForExportAnchor(editLog: unknown[]): unknown[] {
    return (editLog || []).map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const { timestamp: _timestamp, requestId: _requestId, intent: _intent, ...semanticEntry } = entry as Record<string, unknown>;
      return semanticEntry;
    });
  }

  function buildExportEditLogAnchor(editLog: unknown[]) {
    const normalized = normalizeEditLogForExportAnchor(editLog);
    return {
      editCount: Array.isArray(editLog) ? editLog.length : 0,
      editLogHash: fnv1a(stableStringifyForExport(normalized)),
      editLogHashVersion: 1,
    };
  }

  function parseProjectFigureIdentity(input: { sessionId?: string; projectId?: string; figureId?: string }) {
    let projectId = typeof input.projectId === 'string' ? input.projectId : '';
    let figureId = typeof input.figureId === 'string' ? input.figureId : '';

    if ((!projectId || !figureId) && typeof input.sessionId === 'string') {
      const match = input.sessionId.match(/^(.+)_fig_(\d+)$/);
      if (match) {
        projectId = projectId || match[1];
        figureId = figureId || `fig_${match[2]}`;
      }
    }

    const figureMatch = figureId.match(/^fig_(\d+)$/);
    if (!projectId || !figureMatch) {
      return null;
    }
    try {
      assertSafeProjectId(projectId);
    } catch {
      return null;
    }
    return {
      projectId,
      figureId,
      figureIndex: Number(figureMatch[1]) - 1,
      sessionId: `${projectId}_${figureId}`,
    };
  }

  async function buildProjectFigureContext(input: { sessionId?: string; projectId?: string; figureId?: string }, userId: string) {
    const identity = parseProjectFigureIdentity(input);
    const bySession = input.sessionId
      ? getDb().prepare('SELECT * FROM project_figures WHERE session_id = ?').get(input.sessionId) as any
      : null;
    const figRow = bySession || (identity
      ? getDb().prepare('SELECT * FROM project_figures WHERE project_id = ? AND figure_index = ?').get(identity.projectId, identity.figureIndex) as any
      : null);
    const resolvedProjectId = figRow?.project_id || identity?.projectId;
    const resolvedFigureIndex = typeof figRow?.figure_index === 'number' ? figRow.figure_index : identity?.figureIndex;
    if (!resolvedProjectId || resolvedFigureIndex === undefined || resolvedFigureIndex < 0) {
      return null;
    }
    if (!getProject(resolvedProjectId, userId)) {
      return null;
    }

    const datasets = listProjectFiles(resolvedProjectId);
    const uploaded_file_paths: Record<string, string> = {};
    datasets.forEach(d => {
      addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath);
    });

    return {
      projectId: resolvedProjectId,
      figureId: `fig_${resolvedFigureIndex + 1}`,
      figureIndex: resolvedFigureIndex,
      sessionId: figRow?.session_id || `${resolvedProjectId}_fig_${resolvedFigureIndex + 1}`,
      figRow,
      datasets,
      dataPayload: await buildProjectDataPayload(datasets),
      uploaded_file_paths,
      cwd: projectFilesDir(resolvedProjectId).replace(/\\/g, '/'),
    };
  }

  function publicUserPayload(user: UserAccount) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      emailVerified: user.emailVerified,
      emailVerificationRequired: user.emailVerificationRequired,
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

  function authenticatedUserId(req: express.Request): string {
    const existing = requestAuthContext.get(req);
    if (existing) return existing.user.id;
    const auth = requireAuth(req);
    claimLegacyOwnership(auth.user.id);
    requestAuthContext.set(req, auth);
    return auth.user.id;
  }

  function requireAdmin(req: express.Request): { user: UserAccount; token: string; deviceId: string | null } {
    const auth = requireAuth(req);
    if (auth.user.role !== 'admin') {
      const err = new Error('需要管理员权限');
      (err as any).statusCode = 403;
      (err as any).actorUserId = auth.user.id;
      throw err;
    }
    return auth;
  }

  function writeAdminAudit(req: express.Request, input: {
    actorUserId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    success: boolean;
    statusCode: number;
    metadata?: Record<string, unknown>;
  }): void {
    try {
      logAdminAudit({
        ...input,
        ipAddress: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512) || null,
      });
    } catch (error) {
      console.error('Failed to write admin audit log:', error);
    }
  }

  function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
  }

  function issueToken(): string {
    return `sf_${crypto.randomBytes(32).toString('base64url')}`;
  }

  const REFRESH_COOKIE = 'scifigure_refresh';
  const accessTokenMinutes = () => Math.max(5, Math.min(60, Number(process.env.SCIFIGURE_ACCESS_TOKEN_MINUTES || 15)));
  const refreshTokenDays = () => Math.max(1, Math.min(90, Number(process.env.SCIFIGURE_REFRESH_TOKEN_DAYS || 30)));

  function parseCookies(req: express.Request): Record<string, string> {
    const header = String(req.headers.cookie || '');
    return Object.fromEntries(header.split(';').map(part => {
      const separator = part.indexOf('=');
      if (separator < 0) return ['', ''];
      return [decodeURIComponent(part.slice(0, separator).trim()), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([key]) => Boolean(key)));
  }

  function setRefreshCookie(res: express.Response, refreshToken: string): void {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${refreshTokenDays() * 24 * 60 * 60}${secure}`);
  }

  function clearRefreshCookie(res: express.Response): void {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
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

  function issueAuthenticatedSession(req: express.Request, res: express.Response, user: UserAccount) {
    const token = issueToken();
    const refreshToken = issueToken();
    const fingerprint = readDeviceFingerprint(req);
    const deviceId = fingerprint
      ? upsertDevice(user.id, fingerprint, String(req.headers['x-device-name'] || '').slice(0, 80) || null)
      : null;
    createAuthSession(user.id, token, refreshToken, deviceId, accessTokenMinutes(), refreshTokenDays());
    setRefreshCookie(res, refreshToken);
    touchUserLogin(user.id);
    return {
      token,
      user: publicUserPayload(user),
      license: getLicenseState(user.id),
      deviceCount: getActiveDeviceCount(user.id),
    };
  }

  async function issueEmailVerificationChallenge(user: { id: string; email: string }) {
    const challengeId = `evc_${crypto.randomUUID()}`;
    const code = generateEmailVerificationCode();
    const expiresAt = new Date(Date.now() + emailVerificationTtlMinutes() * 60 * 1000).toISOString();
    createEmailVerificationChallenge({
      id: challengeId,
      userId: user.id,
      codeHash: hashEmailVerificationCode(challengeId, code),
      expiresAt,
      maxAttempts: 5,
    });
    try {
      await sendEmailVerificationCode({ email: user.email, code, expiresAt });
    } catch (error) {
      console.error('Email verification delivery failed:', (error as Error)?.message || error);
      const deliveryError = new Error('验证码暂时无法发送，请稍后重试');
      (deliveryError as any).statusCode = 503;
      throw deliveryError;
    }
    const testCode = process.env.SCIFIGURE_TEST_ISOLATED === '1'
      && process.env.SCIFIGURE_TEST_EXPOSE_EMAIL_CODE === '1'
      ? code
      : undefined;
    return { challengeId, expiresAt, maskedEmail: maskEmailAddress(user.email), testCode };
  }

  function rasterExportDpi(format: string, dpi: unknown): number | null {
    const normalized = format.toLowerCase();
    if (!['png', 'tiff', 'tif'].includes(normalized)) return null;
    const parsed = Number(dpi || 300);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
  }

  function projectExportsDir(projectId: string): string {
    const projectDir = projectRootDir(projectId);
    const exportsDir = safeResolveUnder(projectDir, path.join(projectDir, 'exports'));
    fs.mkdirSync(exportsDir, { recursive: true });
    return exportsDir;
  }

  function registeredProjectStorageSizes(scope: { projectId?: string; userId?: string } = {}): number[] {
    const fileRows = scope.projectId
      ? getDb().prepare(`
          SELECT stored_path AS storedPath FROM project_files WHERE project_id = ?
          UNION ALL
          SELECT file_path AS storedPath FROM export_assets WHERE project_id = ?
        `).all(scope.projectId, scope.projectId) as Array<{ storedPath: string }>
      : scope.userId
        ? getDb().prepare(`
            SELECT pf.stored_path AS storedPath
            FROM project_files pf
            INNER JOIN projects p ON p.id = pf.project_id
            WHERE p.user_id = ?
            UNION ALL
            SELECT ea.file_path AS storedPath
            FROM export_assets ea
            INNER JOIN projects p ON p.id = ea.project_id
            WHERE p.user_id = ?
          `).all(scope.userId, scope.userId) as Array<{ storedPath: string }>
        : getDb().prepare(`
            SELECT stored_path AS storedPath FROM project_files
            UNION ALL
            SELECT file_path AS storedPath FROM export_assets
          `).all() as Array<{ storedPath: string }>;
    const fileSizes = fileRows.flatMap(row => {
      try {
        const absPath = safeResolveUnder(PROJECTS_ROOT, row.storedPath);
        return fs.existsSync(absPath) ? [fs.statSync(absPath).size] : [];
      } catch {
        return [];
      }
    });
    const thumbnailRows = scope.projectId
      ? getDb().prepare(`
          SELECT length(CAST(thumbnail_svg AS BLOB)) AS sizeBytes
          FROM export_assets
          WHERE project_id = ? AND thumbnail_svg IS NOT NULL
        `).all(scope.projectId) as Array<{ sizeBytes: number | null }>
      : scope.userId
        ? getDb().prepare(`
            SELECT length(CAST(ea.thumbnail_svg AS BLOB)) AS sizeBytes
            FROM export_assets ea
            INNER JOIN projects p ON p.id = ea.project_id
            WHERE p.user_id = ? AND ea.thumbnail_svg IS NOT NULL
          `).all(scope.userId) as Array<{ sizeBytes: number | null }>
        : getDb().prepare(`
            SELECT length(CAST(thumbnail_svg AS BLOB)) AS sizeBytes
            FROM export_assets
            WHERE thumbnail_svg IS NOT NULL
          `).all() as Array<{ sizeBytes: number | null }>;
    const snapshotRows = scope.projectId
      ? getDb().prepare(`
          SELECT length(CAST(snapshot_json AS BLOB)) AS sizeBytes
          FROM export_asset_snapshots
          WHERE project_id = ?
        `).all(scope.projectId) as Array<{ sizeBytes: number | null }>
      : scope.userId
        ? getDb().prepare(`
            SELECT length(CAST(eas.snapshot_json AS BLOB)) AS sizeBytes
            FROM export_asset_snapshots eas
            INNER JOIN projects p ON p.id = eas.project_id
            WHERE p.user_id = ?
          `).all(scope.userId) as Array<{ sizeBytes: number | null }>
        : getDb().prepare(`
            SELECT length(CAST(snapshot_json AS BLOB)) AS sizeBytes
            FROM export_asset_snapshots
          `).all() as Array<{ sizeBytes: number | null }>;
    return fileSizes.concat(
      thumbnailRows.map(row => Math.max(0, Number(row.sizeBytes || 0))),
      snapshotRows.map(row => Math.max(0, Number(row.sizeBytes || 0))),
    );
  }

  function assertProjectOwnedStorageBudgets(projectId: string, userId: string, incomingSize: number): void {
    assertProjectTotalStorageBudget(registeredProjectStorageSizes({ projectId }), incomingSize);
    assertUserTotalStorageBudget(registeredProjectStorageSizes({ userId }), incomingSize);
    assertGlobalStorageBudget(registeredProjectStorageSizes(), incomingSize);
  }

  function removeNewExportAssets(projectId: string, assets: ExportAsset[]): void {
    if (assets.length === 0) return;
    const root = projectExportsDir(projectId);
    for (const asset of assets) {
      try {
        const absPath = safeResolveUnder(root, asset.filePath);
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } catch {
        // The database delete below still prevents a failed export from entering history.
      }
    }
    deleteExportAssets(projectId, assets.map(asset => asset.assetId));
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
    editingSnapshot?: ExportEditingSnapshot;
  }): ExportAsset {
    const owner = getDb().prepare('SELECT user_id AS userId FROM projects WHERE id = ?').get(args.projectId) as { userId: string | null } | undefined;
    if (!owner?.userId) {
      throw new Error('导出资产缺少有效的项目所有者');
    }
    const assetId = `exp_${randomUUID()}`;
    const fmt = args.format.toLowerCase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}_${safeExportName(args.figureId || args.name)}.${fmt}`;
    const absPath = path.join(projectExportsDir(args.projectId), filename);
    const relPath = path.relative(process.cwd(), absPath);
    const fileBuffer = args.binaryB64
      ? Buffer.from(args.binaryB64, 'base64')
      : Buffer.from(args.svg || '', 'utf8');
    const snapshotJson = args.editingSnapshot ? JSON.stringify(args.editingSnapshot) : null;
    const snapshotHash = snapshotJson
      ? crypto.createHash('sha256').update(snapshotJson).digest('hex')
      : null;
    const thumbnailBytes = Buffer.byteLength(args.thumbnailSvg ?? args.svg ?? '', 'utf8');
    const snapshotBytes = Buffer.byteLength(snapshotJson || '', 'utf8');
    assertProjectOwnedStorageBudgets(args.projectId, owner.userId, fileBuffer.length + thumbnailBytes + snapshotBytes);
    fs.writeFileSync(absPath, fileBuffer);
    try {
      return addExportAsset({
        id: assetId,
        projectId: args.projectId,
        figureId: args.figureId,
        name: args.name,
        format: fmt,
        dpi: args.dpi ?? null,
        filePath: relPath,
        thumbnailSvg: args.thumbnailSvg ?? args.svg ?? null,
        metadata: snapshotHash
          ? {
              ...(args.metadata ?? {}),
              editingSnapshot: {
                available: true,
                schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
                capturedAt: args.editingSnapshot?.capturedAt,
                hash: snapshotHash,
              },
            }
          : args.metadata ?? {},
        tags: args.tags ?? [],
        editingSnapshot: snapshotJson && snapshotHash && args.editingSnapshot
          ? {
              figureId: args.editingSnapshot.targetFigureId,
              schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
              snapshotJson,
              snapshotHash,
            }
          : undefined,
      });
    } catch (error) {
      try { fs.unlinkSync(absPath); } catch { /* failed asset was never registered */ }
      throw error;
    }
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

  function extractSvgNamespaceAttrs(svg: string): string {
    const rootAttrs = svg.match(/<svg\b([^>]*)>/i)?.[1] || '';
    const namespaceAttrs = rootAttrs.match(/\s+xmlns(?::[\w.-]+)?=["'][^"']+["']/gi) || [];
    return namespaceAttrs
      .filter(attr => !/^\s+xmlns\s*=/i.test(attr))
      .join('');
  }

  function buildSubplotSvgExports(svg: string, manifest: any): Array<{ subplotId: string; index: number; svg: string; bounds: any }> {
    const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
    const subplots = objects
      .filter((obj: any) => obj?.kind === 'subplot' && typeof obj?.id === 'string')
      .map((obj: any, fallbackIndex: number) => {
        const props = obj.currentProps || {};
        const left = Number(props.left);
        const bottom = Number(props.bottom);
        const width = Number(props.width);
        const height = Number(props.height);
        if (![left, bottom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
          return null;
        }
        return {
          subplotId: obj.id,
          index: Number.isFinite(Number(props.subplotIndex)) ? Number(props.subplotIndex) : fallbackIndex,
          bounds: { left, bottom, width, height },
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.index - b.index) as Array<{ subplotId: string; index: number; bounds: any }>;

    if (subplots.length === 0) return [];
    const viewBox = parseSvgViewBox(svg);
    const inner = extractSvgInner(svg);
    const namespaceAttrs = extractSvgNamespaceAttrs(svg);
    return subplots.map((subplot, idx) => {
      const cropX = viewBox.x + subplot.bounds.left * viewBox.width;
      const cropY = viewBox.y + (1 - subplot.bounds.bottom - subplot.bounds.height) * viewBox.height;
      const cropW = subplot.bounds.width * viewBox.width;
      const cropH = subplot.bounds.height * viewBox.height;
      const panelSvg = `<svg xmlns="http://www.w3.org/2000/svg"${namespaceAttrs} width="${cropW}" height="${cropH}" viewBox="${cropX} ${cropY} ${cropW} ${cropH}">
${inner}
</svg>`;
      return {
        subplotId: subplot.subplotId,
        index: idx,
        svg: panelSvg,
        bounds: subplot.bounds,
      };
    });
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
    globalFontFamily?: string;
    labelColor?: string;
    applyInnerFont?: boolean;
    innerFontSize?: number;
    innerFontFamily?: string;
    innerFontColor?: string;
    applySemanticTextStyle?: boolean;
    sourceTitleFontSize?: number;
    sourceAxisLabelFontSize?: number;
    sourceTickFontSize?: number;
    sourceLegendFontSize?: number;
    sourceTextColor?: string;
    panelBorderWidth?: number;
    panelBorderColor?: string;
    panelBorderRadius?: number;
    applyInnerLine?: boolean;
    innerLineWidth?: number;
    innerLineColor?: string;
    applyAxisElementStyle?: boolean;
    axisLineWidth?: number;
    axisLineColor?: string;
    tickLineWidth?: number;
    tickLineColor?: string;
  }

  function composeSvgAssets(assets: ExportAsset[], layout?: ComposeLayout): string {
    const count = assets.length;
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const labels = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const layoutMap = new Map((layout?.panels || []).map(panel => [panel.assetId, panel]));
    const labelFontSize = layout?.labelFontSize && Number.isFinite(layout.labelFontSize) ? Math.max(6, Math.min(72, layout.labelFontSize)) : 18;
    const panelW = 420;
    const panelH = 320;
    const gapX = 36;
    const gapY = 42;
    const labelOffset = labelFontSize + 8;
    const width = layout?.width && Number.isFinite(layout.width) ? Math.max(200, Math.min(4000, layout.width)) : cols * panelW + (cols - 1) * gapX;
    const height = layout?.height && Number.isFinite(layout.height) ? Math.max(200, Math.min(4000, layout.height)) : rows * panelH + (rows - 1) * gapY + labelOffset;
    const globalFontFamily = String(layout?.globalFontFamily || layout?.labelFontFamily || 'Arial, sans-serif').replace(/[<>"'{}]/g, '');
    const labelFontFamily = globalFontFamily;
    const labelColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.labelColor || '')) ? String(layout?.labelColor) : '#0f172a';
    const applyInnerFont = layout?.applyInnerFont === true;
    const innerFontSize = layout?.innerFontSize && Number.isFinite(layout.innerFontSize) ? Math.max(4, Math.min(96, layout.innerFontSize)) : 10;
    const innerFontFamily = String(layout?.innerFontFamily || layout?.globalFontFamily || labelFontFamily).replace(/[<>"'{}]/g, '');
    const innerFontColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.innerFontColor || '')) ? String(layout?.innerFontColor) : '#111827';
    const applySemanticTextStyle = layout?.applySemanticTextStyle === true;
    const sourceTitleFontSize = Number.isFinite(layout?.sourceTitleFontSize) ? Math.max(4, Math.min(96, Number(layout?.sourceTitleFontSize))) : 12;
    const sourceAxisLabelFontSize = Number.isFinite(layout?.sourceAxisLabelFontSize) ? Math.max(4, Math.min(96, Number(layout?.sourceAxisLabelFontSize))) : 10;
    const sourceTickFontSize = Number.isFinite(layout?.sourceTickFontSize) ? Math.max(4, Math.min(96, Number(layout?.sourceTickFontSize))) : 8;
    const sourceLegendFontSize = Number.isFinite(layout?.sourceLegendFontSize) ? Math.max(4, Math.min(96, Number(layout?.sourceLegendFontSize))) : 8;
    const sourceTextColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.sourceTextColor || '')) ? String(layout?.sourceTextColor) : '#111827';
    const panelBorderWidth = Number.isFinite(layout?.panelBorderWidth) ? Math.max(0, Math.min(20, Number(layout?.panelBorderWidth))) : 0;
    const panelBorderColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.panelBorderColor || '')) ? String(layout?.panelBorderColor) : '#cbd5e1';
    const panelBorderRadius = Number.isFinite(layout?.panelBorderRadius) ? Math.max(0, Math.min(200, Number(layout?.panelBorderRadius))) : 0;
    const applyInnerLine = layout?.applyInnerLine === true;
    const innerLineWidth = Number.isFinite(layout?.innerLineWidth) ? Math.max(0.1, Math.min(20, Number(layout?.innerLineWidth))) : 1;
    const innerLineColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.innerLineColor || '')) ? String(layout?.innerLineColor) : '#000000';
    const applyAxisElementStyle = layout?.applyAxisElementStyle === true;
    const axisLineWidth = Number.isFinite(layout?.axisLineWidth) ? Math.max(0.1, Math.min(20, Number(layout?.axisLineWidth))) : 1;
    const axisLineColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.axisLineColor || '')) ? String(layout?.axisLineColor) : '#000000';
    const tickLineWidth = Number.isFinite(layout?.tickLineWidth) ? Math.max(0.1, Math.min(20, Number(layout?.tickLineWidth))) : axisLineWidth;
    const tickLineColor = /^#[0-9A-Fa-f]{6}$/.test(String(layout?.tickLineColor || '')) ? String(layout?.tickLineColor) : axisLineColor;
    const innerFontStyle = applyInnerFont ? `
  <style>
    .composer-subfigure text {
      font-family: ${innerFontFamily} !important;
      font-size: ${innerFontSize}px !important;
      fill: ${innerFontColor} !important;
    }
  </style>` : '';
    const innerLineStyle = applyInnerLine ? `
  <style>
    .composer-subfigure line,
    .composer-subfigure path,
    .composer-subfigure polyline,
    .composer-subfigure polygon,
    .composer-subfigure rect {
      stroke-width: ${innerLineWidth}px !important;
      stroke: ${innerLineColor} !important;
    }
  </style>` : '';
    const semanticTextStyle = applySemanticTextStyle ? `
  <style>
    .composer-subfigure [id^="title."] text,
    .composer-subfigure [id^="suptitle."] text {
      font-family: ${globalFontFamily} !important;
      font-size: ${sourceTitleFontSize}px !important;
      fill: ${sourceTextColor} !important;
    }
    .composer-subfigure [id^="xlabel."] text,
    .composer-subfigure [id^="ylabel."] text,
    .composer-subfigure [id^="supxlabel."] text,
    .composer-subfigure [id^="supylabel."] text {
      font-family: ${globalFontFamily} !important;
      font-size: ${sourceAxisLabelFontSize}px !important;
      fill: ${sourceTextColor} !important;
    }
    .composer-subfigure [id^="xtick."] text,
    .composer-subfigure [id^="ytick."] text {
      font-family: ${globalFontFamily} !important;
      font-size: ${sourceTickFontSize}px !important;
      fill: ${sourceTextColor} !important;
    }
    .composer-subfigure [id^="legend_text."] text,
    .composer-subfigure [id^="legend_title."] text {
      font-family: ${globalFontFamily} !important;
      font-size: ${sourceLegendFontSize}px !important;
      fill: ${sourceTextColor} !important;
    }
  </style>` : '';
    const axisElementStyle = applyAxisElementStyle ? `
  <style>
    .composer-subfigure [id^="spine."] path,
    .composer-subfigure [id^="axis.x."] path,
    .composer-subfigure [id^="axis.y."] path {
      stroke-width: ${axisLineWidth}px !important;
      stroke: ${axisLineColor} !important;
    }
    .composer-subfigure [id^="xtick."] line,
    .composer-subfigure [id^="ytick."] line,
    .composer-subfigure [id^="xtick."] path,
    .composer-subfigure [id^="ytick."] path,
    .composer-subfigure [id^="xtick."] use,
    .composer-subfigure [id^="ytick."] use {
      stroke-width: ${tickLineWidth}px !important;
      stroke: ${tickLineColor} !important;
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
      const safeScale = Math.max(0.001, scale);
      const scaledW = vb.width * scale;
      const scaledH = vb.height * scale;
      const dx = x + (targetW - scaledW) / 2 - vb.x * scale;
      const dy = y + (targetH - scaledH) / 2 - vb.y * scale;
      const label = custom?.label || `(${labels[idx]})`;
      const labelY = Math.max(labelFontSize + 2, y - 8);
      const border = panelBorderWidth > 0
        ? `<rect x="${x}" y="${y}" width="${targetW}" height="${targetH}" rx="${panelBorderRadius}" ry="${panelBorderRadius}" fill="none" stroke="${panelBorderColor}" stroke-width="${panelBorderWidth}"/>`
        : '';
      const assetSelectorId = String(asset.assetId).replace(/["\\]/g, '');
      const panelSemanticTextStyle = applySemanticTextStyle ? `
          <style>
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="title."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="suptitle."] text {
              font-family: ${globalFontFamily} !important;
              font-size: ${(sourceTitleFontSize / safeScale).toFixed(3)}px !important;
              fill: ${sourceTextColor} !important;
            }
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="xlabel."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="ylabel."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="supxlabel."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="supylabel."] text {
              font-family: ${globalFontFamily} !important;
              font-size: ${(sourceAxisLabelFontSize / safeScale).toFixed(3)}px !important;
              fill: ${sourceTextColor} !important;
            }
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="xtick."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="ytick."] text {
              font-family: ${globalFontFamily} !important;
              font-size: ${(sourceTickFontSize / safeScale).toFixed(3)}px !important;
              fill: ${sourceTextColor} !important;
            }
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="legend_text."] text,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="legend_title."] text {
              font-family: ${globalFontFamily} !important;
              font-size: ${(sourceLegendFontSize / safeScale).toFixed(3)}px !important;
              fill: ${sourceTextColor} !important;
            }
          </style>` : '';
      const panelAxisElementStyle = applyAxisElementStyle ? `
          <style>
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="spine."] path,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="axis.x."] path,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="axis.y."] path {
              stroke-width: ${(axisLineWidth / safeScale).toFixed(3)}px !important;
              stroke: ${axisLineColor} !important;
            }
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="xtick."] line,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="ytick."] line,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="xtick."] path,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="ytick."] path,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="xtick."] use,
            [data-export-asset-id="${assetSelectorId}"] .composer-subfigure [id^="ytick."] use {
              stroke-width: ${(tickLineWidth / safeScale).toFixed(3)}px !important;
              stroke: ${tickLineColor} !important;
            }
          </style>` : '';
      return `
        <g data-export-asset-id="${asset.assetId}">
          <text x="${x}" y="${labelY}" font-family="${labelFontFamily}" font-size="${labelFontSize}" font-weight="700" fill="${labelColor}">${label}</text>
          ${border}
          ${panelSemanticTextStyle}
          ${panelAxisElementStyle}
          <g class="composer-subfigure" transform="translate(${dx.toFixed(3)} ${dy.toFixed(3)}) scale(${scale.toFixed(6)})">
            ${extractSvgInner(svg)}
          </g>
        </g>`;
    }).join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  ${innerFontStyle}
  ${innerLineStyle}
  ${semanticTextStyle}
  ${axisElementStyle}
  ${panels}
</svg>`;
  }

  function buildCompositionSourceSnapshots(assets: ExportAsset[]) {
    return assets.map(asset => ({
      assetId: asset.assetId,
      figureId: asset.figureId,
      name: asset.name,
      format: asset.format,
      revision: typeof asset.metadata?.revision === 'number' ? asset.metadata.revision : 1,
      createdAt: asset.createdAt,
    }));
  }

  async function validateAst(script: string, req?: express.Request): Promise<{ ok: boolean; message?: string; errors?: string[] }> {
    const enforce = process.env.SCIFIGURE_AST_ENFORCE === '1';
    const reportRisk = (message: string, errors?: string[]) => {
      const pathLabel = req ? `${req.method} ${req.path}` : 'unknown request';
      console.warn(`[AST ${enforce ? 'BLOCK' : 'LOG'}] ${pathLabel}: ${message}${errors?.length ? ` | ${errors.join('; ')}` : ''}`);
      return enforce
        ? { ok: false, message, errors }
        : { ok: true, message, errors };
    };
    try {
      const result = await spawnPythonWithPayload('ast_validator.py', { script }, { req, label: 'ast-validator' });
      if (result.status !== 'success') {
        return reportRisk(result.message || 'AST 风险命中', result.errors);
      }
      return { ok: true };
    } catch (e: any) {
      return reportRisk(e?.message || 'AST 校验执行失败');
    }
  }

  function validateRScriptRisk(script: string, req?: express.Request): {
    ok: boolean;
    findings: RRiskFinding[];
    message?: string;
  } {
    const findings = scanRScriptRisks(script);
    if (findings.length === 0) return { ok: true, findings };
    const blocking = blockingRRisks(findings);
    const enforce = process.env.SCIFIGURE_R_RISK_ENFORCE === '1';
    const pathLabel = req ? `${req.method} ${req.path}` : 'unknown request';
    console.warn(
      `[R-RISK ${enforce ? 'BLOCK_HIGH' : 'LOG'}] ${pathLabel}: `
      + findings.map((finding) => `${finding.severity}:${finding.symbol}@${finding.line}`).join('; '),
    );
    if (enforce && blocking.length > 0) {
      return {
        ok: false,
        findings,
        message: `R script risk precheck blocked: ${blocking.map((finding) => `${finding.symbol} (line ${finding.line})`).join(', ')}`,
      };
    }
    return { ok: true, findings };
  }

  function apiErrorHandler(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
    if (err instanceof SyntaxError && 'body' in err) {
      if (/^\/api\/projects\/[^/]+\/export-assets\/import$/.test(req.path)) {
        try {
          authenticatedUserId(req);
          assertHourlyByteBudget(req, res, 'upload_bytes', requestBodyByteLength(req));
        } catch (budgetError: any) {
          const status = Number(budgetError?.statusCode || 0);
          if (status === 411 || status === 429) {
            return res.status(status).json({ status: 'error', message: budgetError.message });
          }
        }
      }
      return res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }
    if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        status: 'error',
        message: err?.code === 'LIMIT_FILE_SIZE'
          ? '上传文件过大：单个文件最大 50 MB。'
          : '请求体过大：请减少一次性传入的代码片段数量，或不要把超长完整脚本作为 codeSlice 发送。',
      });
    }
    if (err?.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ status: 'error', message: '一次最多上传 20 个文件。' });
    }
    if (req.path.startsWith('/api/')) {
      const status = Number(err?.status || err?.statusCode || 500);
      return res.status(Number.isFinite(status) ? status : 500).json({
        status: 'error',
        message: err?.message || 'API request failed',
      });
    }
    next(err);
  }

  const LEGACY_RETIRE_OBSERVATION_ENDPOINT = '/api/internal/legacy-retire-observation';
  const LEGACY_RETIRE_OBSERVATION_DIR = resolveLegacyRetireObservationDir();
  const LEGACY_RETIRE_OBSERVATION_MAX_EVENTS = 100;

  function resolveLegacyRetireObservationDir(): string {
    const configured = String(process.env.SCIFIGURE_LEGACY_RETIRE_OBSERVATION_DIR || '').trim();
    const resolved = configured
      ? path.resolve(configured)
      : path.resolve(process.cwd(), 'tmp', 'unified-editing-staging', 'legacy-retire-observation');
    const relativeToData = path.relative(DATA_ROOT, resolved);
    if (relativeToData === '' || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData))) {
      throw new Error('Legacy retire observation directory must be outside SCIFIGURE_DATA_DIR');
    }
    return resolved;
  }

  function legacyRetireObservationEnabled(): boolean {
    return process.env.SCIFIGURE_STAGING_INSTANCE === 'unified-editing'
      || process.env.SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY === '1';
  }

  function safeObservationToken(value: unknown, fallback: string): string {
    const safe = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return safe || fallback;
  }

  function assertInsideDirectory(candidatePath: string, parentPath: string): void {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedParent = path.resolve(parentPath);
    const relative = path.relative(resolvedParent, resolvedCandidate);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
    throw new Error('Observation path escaped staging directory');
  }

  function stagingBuildId(): string {
    return safeObservationToken(
      process.env.SCIFIGURE_BUILD_ID || process.env.SCIFIGURE_STAGING_BUILD_ID,
      'unknown-build',
    );
  }

  app.post(
    LEGACY_RETIRE_OBSERVATION_ENDPOINT,
    apiRateLimit,
    express.json({ limit: '64kb' }),
    (req, res) => {
      try {
        if (!legacyRetireObservationEnabled()) {
          return res.status(404).json({ status: 'error', message: 'Not found' });
        }
        requireAuth(req);
        const inputEvents = Array.isArray(req.body) ? req.body : req.body?.events;
        if (!Array.isArray(inputEvents)) {
          return res.status(400).json({ status: 'error', message: 'Observation events must be an array' });
        }
        if (inputEvents.length > LEGACY_RETIRE_OBSERVATION_MAX_EVENTS) {
          return res.status(413).json({ status: 'error', message: 'Too many observation events' });
        }
        const events = sanitizeLegacyRetireObservationBatch(inputEvents, LEGACY_RETIRE_OBSERVATION_MAX_EVENTS);
        if (events.length === 0) {
          return res.status(400).json({ status: 'error', message: 'No valid observation events' });
        }

        const receivedAt = new Date().toISOString();
        const buildId = stagingBuildId();
        const fileName = `${buildId}-${receivedAt.slice(0, 10)}.jsonl`;
        const outputPath = path.join(LEGACY_RETIRE_OBSERVATION_DIR, fileName);
        assertInsideDirectory(outputPath, LEGACY_RETIRE_OBSERVATION_DIR);
        fs.mkdirSync(LEGACY_RETIRE_OBSERVATION_DIR, { recursive: true });
        const jsonl = events.map(event => JSON.stringify({ ...event, receivedAt, buildId })).join('\n') + '\n';
        fs.appendFileSync(outputPath, jsonl, { encoding: 'utf8' });
        res.json({ status: 'success', accepted: events.length });
      } catch (err) {
        apiErrorHandler(err, req, res, () => {});
      }
    },
  );

  app.use(apiRateLimit);
  app.use(express.json({
    limit: '50mb',
    verify: (req, _res, buffer) => {
      (req as any).scifigureRawBodyBytes = buffer.length;
    },
  }));
  app.use(express.urlencoded({ limit: '1mb', extended: false }));
  app.use(apiErrorHandler);

  installAdminConsoleRoutes(app, {
    requireAuth,
    requireAdmin,
    adminRateLimit,
    errorReportRateLimit,
    writeAdminAudit,
    rendererSnapshot: adminConsoleRendererSnapshot,
  });

  app.get('/api/health/live', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'live' });
  });

  app.get('/api/health/ready', (_req, res) => {
    const snapshot = deploymentLifecycle.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.status(snapshot.acceptingNewJobs ? 200 : 503).json({
      status: snapshot.acceptingNewJobs ? 'ready' : 'draining',
      acceptingNewJobs: snapshot.acceptingNewJobs,
    });
  });

  app.post('/api/auth/register', authRateLimit, async (req, res) => {
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
      const verificationRequired = emailVerificationRequired();
      const user = await createUserAccount(
        email,
        password,
        displayName || email.split('@')[0],
        { emailVerificationRequired: verificationRequired },
      );
      if (verificationRequired) {
        const challenge = await issueEmailVerificationChallenge(user);
        return res.status(202).json({
          status: 'success',
          verificationRequired: true,
          verification: challenge,
        });
      }
      return res.json({ status: 'success', ...issueAuthenticatedSession(req, res, user) });
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({
        status: 'error',
        message: Number(err?.statusCode) === 503 ? err.message : '注册失败，请稍后重试',
      });
    }
  });

  app.post('/api/auth/verify-email', emailVerificationRateLimit, (req, res) => {
    try {
      const challengeId = String(req.body?.challengeId || '').trim();
      const code = String(req.body?.code || '').trim();
      if (!/^evc_[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ status: 'error', message: '验证码格式无效' });
      }
      const result = consumeEmailVerificationChallenge(
        challengeId,
        hashEmailVerificationCode(challengeId, code),
      );
      if (result.status !== 'verified') {
        const message = result.status === 'expired'
          ? '验证码已过期，请重新发送'
          : result.status === 'locked'
            ? '验证码尝试次数过多，请重新发送'
            : '验证码错误';
        return res.status(400).json({ status: 'error', errorCode: `EMAIL_VERIFICATION_${result.status.toUpperCase()}`, message });
      }
      return res.json({ status: 'success', ...issueAuthenticatedSession(req, res, result.user) });
    } catch (err: any) {
      console.error('Email verification failed:', err?.message || err);
      return res.status(500).json({ status: 'error', message: '邮箱验证暂时不可用，请稍后重试' });
    }
  });

  app.post('/api/auth/resend-verification', emailVerificationRateLimit, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      return res.status(400).json({ status: 'error', message: '请输入有效邮箱' });
    }
    const genericResponse = {
      status: 'success',
      message: '如果该邮箱存在待验证账号，新的验证码已发送',
      verificationRequired: true,
      verification: {
        challengeId: `evc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + emailVerificationTtlMinutes() * 60 * 1000).toISOString(),
        maskedEmail: maskEmailAddress(email),
      },
    };
    try {
      const row = getUserByEmail(email);
      if (!row || row.email_verification_required !== 1 || row.email_verified_at) {
        return res.json(genericResponse);
      }
      const challenge = await issueEmailVerificationChallenge({ id: row.id, email: row.email });
      return res.json({ ...genericResponse, verification: challenge });
    } catch (err: any) {
      console.error('Email verification resend failed:', err?.message || err);
      return res.status(503).json({ status: 'error', message: '验证码暂时无法发送，请稍后重试' });
    }
  });

  app.post('/api/auth/login', authRateLimit, async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const row = getUserByEmail(email);
      if (!row || !(await verifyPasswordAndMigrate(row, password))) {
        return res.status(401).json({ status: 'error', message: '邮箱或密码错误' });
      }
      const user = getUserById(row.id);
      if (!user) {
        return res.status(401).json({ status: 'error', message: '用户不存在' });
      }
      if (user.emailVerificationRequired) {
        return res.status(403).json({
          status: 'error',
          errorCode: 'EMAIL_VERIFICATION_REQUIRED',
          message: '请先完成邮箱验证',
          verificationRequired: true,
          maskedEmail: maskEmailAddress(user.email),
        });
      }
      return res.json({ status: 'success', ...issueAuthenticatedSession(req, res, user) });
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

  app.post('/api/auth/refresh', authRateLimit, (req, res) => {
    try {
      const refreshToken = parseCookies(req)[REFRESH_COOKIE];
      if (!refreshToken) {
        clearRefreshCookie(res);
        return res.status(401).json({ status: 'error', message: '刷新会话不存在' });
      }
      const token = issueToken();
      const nextRefreshToken = issueToken();
      const user = rotateRefreshSession(refreshToken, token, nextRefreshToken, accessTokenMinutes());
      if (!user) {
        clearRefreshCookie(res);
        return res.status(401).json({ status: 'error', message: '刷新会话已过期，请重新登录' });
      }
      setRefreshCookie(res, nextRefreshToken);
      res.json({ status: 'success', token, user: publicUserPayload(user), license: getLicenseState(user.id) });
    } catch (err: any) {
      clearRefreshCookie(res);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    try {
      const token = readBearerToken(req);
      const refreshToken = parseCookies(req)[REFRESH_COOKIE];
      const revoked = (token ? revokeAuthToken(token) : 0) + (refreshToken ? revokeRefreshToken(refreshToken) : 0);
      clearRefreshCookie(res);
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

  app.post('/api/admin/redeem-codes', requireAdminOperationsEnabled, adminRateLimit, (req, res) => {
    let actorUserId: string | null = null;
    try {
      const auth = requireAdmin(req);
      actorUserId = auth.user.id;
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
      writeAdminAudit(req, {
        actorUserId,
        action: 'redeem_codes.create',
        resourceType: 'redeem_code_batch',
        success: true,
        statusCode: 200,
        metadata: {
          count,
          durationDays,
          maxUses,
          label,
          expiresAt: req.body?.expiresAt || null,
        },
      });
      res.json({ status: 'success', codes, durationDays, maxUses });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode || 500);
      writeAdminAudit(req, {
        actorUserId: actorUserId || err?.actorUserId || null,
        action: 'redeem_codes.create',
        resourceType: 'redeem_code_batch',
        success: false,
        statusCode,
        metadata: {
          reason: statusCode === 401 ? 'unauthenticated' : statusCode === 403 ? 'forbidden' : 'request_failed',
        },
      });
      res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/admin/audit-logs', requireAdminOperationsEnabled, adminRateLimit, (req, res) => {
    let actorUserId: string | null = null;
    try {
      const auth = requireAdmin(req);
      actorUserId = auth.user.id;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const logs = listAdminAuditLogs(limit);
      writeAdminAudit(req, {
        actorUserId,
        action: 'admin_audit_logs.read',
        resourceType: 'admin_audit_log',
        success: true,
        statusCode: 200,
        metadata: { limit, returned: logs.length },
      });
      res.json({ status: 'success', logs });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode || 500);
      writeAdminAudit(req, {
        actorUserId: actorUserId || err?.actorUserId || null,
        action: 'admin_audit_logs.read',
        resourceType: 'admin_audit_log',
        success: false,
        statusCode,
        metadata: {
          reason: statusCode === 401 ? 'unauthenticated' : statusCode === 403 ? 'forbidden' : 'request_failed',
        },
      });
      res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/admin/deployment-state', requireAdminOperationsEnabled, (req, res) => {
    try {
      requireAdmin(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ status: 'success', deployment: deploymentState() });
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/admin/deployment-state', requireAdminOperationsEnabled, adminRateLimit, (req, res) => {
    let actorUserId: string | null = null;
    try {
      const auth = requireAdmin(req);
      actorUserId = auth.user.id;
      const mode = String(req.body?.mode || '') as DeploymentMode;
      const reason = String(req.body?.reason || 'manual') as DeploymentDrainReason;
      const allowedModes: DeploymentMode[] = ['accepting', 'draining'];
      const allowedReasons: DeploymentDrainReason[] = ['deployment', 'maintenance', 'rollback', 'manual'];
      if (!allowedModes.includes(mode)) {
        const err = new Error('mode 必须是 accepting 或 draining');
        (err as any).statusCode = 400;
        throw err;
      }
      if (!allowedReasons.includes(reason)) {
        const err = new Error('reason 不是允许的发布原因');
        (err as any).statusCode = 400;
        throw err;
      }
      const previousMode = deploymentLifecycle.snapshot().mode;
      deploymentLifecycle.setMode(mode, reason);
      writeAdminAudit(req, {
        actorUserId,
        action: 'deployment.mode.change',
        resourceType: 'deployment-instance',
        resourceId: null,
        success: true,
        statusCode: 200,
        metadata: { previousMode, mode, reason },
      });
      res.json({ status: 'success', deployment: deploymentState() });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode || 500);
      writeAdminAudit(req, {
        actorUserId: actorUserId || err?.actorUserId || null,
        action: 'deployment.mode.change',
        resourceType: 'deployment-instance',
        resourceId: null,
        success: false,
        statusCode,
        metadata: { reason: statusCode === 401 ? 'unauthenticated' : statusCode === 403 ? 'forbidden' : 'request_failed' },
      });
      res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.use(['/api/projects', '/api/figure'], (req, res, next) => {
    try {
      authenticatedUserId(req);
      next();
    } catch (err: any) {
      res.status(err?.statusCode || 401).json({ status: 'error', message: err?.message || '未登录' });
    }
  });

  app.param('id', (req, res, next, projectId) => {
    if (!req.path.startsWith('/api/projects/')) return next();
    try {
      assertSafeProjectId(projectId);
      const userId = authenticatedUserId(req);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      return next();
    } catch (err: any) {
      return res.status(err?.statusCode || 400).json({ status: 'error', message: err?.message || '项目访问失败' });
    }
  });

  // --- IFC v2 Introspection-based Render API ---

  interface EditEntry {
    gid: string;
    prop: string;
    value: unknown;
    matchColor?: string;
    stableKey?: string;
    fingerprint?: string;
    fingerprintVersion?: number;
    identity?: any;
    mode: 'local_patch' | 'backend_patch';
    timestamp: number;
  }

  interface FigureSession {
    sessionId: string;
    ownerUserId: string;
    script: string;
    language?: 'python' | 'r';
    dataPayload: Record<string, unknown> | null;
    editLog: EditEntry[];
    revision: number;
    createdAt: number;
    updatedAt: number;
  }

  /** Compress editLog: keep only the latest value per (gid, prop, color subset).
   *  Preserves full History Log for undo/redo — only the render/export
   *  payload uses the compressed version. */
  function compressEditLog(log: EditEntry[]): EditEntry[] {
    const seen = new Set<string>();
    const result: EditEntry[] = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      const matchColor = typeof entry.matchColor === 'string' ? entry.matchColor.trim().toLowerCase() : '';
      const key = `${entry.gid}\0${entry.prop}\0${matchColor}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.unshift(entry);
      }
    }
    return result;
  }

  // Only disposable sessions expire. Sessions referenced by saved projects are durable.
  cleanExpiredSessions(120);

  function parseStoredArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function parseStoredHistory(value: unknown): { past: any[]; future: any[] } {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const candidate = value as any;
      return {
        past: Array.isArray(candidate.past) ? candidate.past : [],
        future: Array.isArray(candidate.future) ? candidate.future : [],
      };
    }
    if (typeof value === 'string' && value.trim()) {
      try {
        return parseStoredHistory(JSON.parse(value));
      } catch {
        return { past: [], future: [] };
      }
    }
    return { past: [], future: [] };
  }

  function resolveProjectFigureEditLog(
    row: any,
    session: FigureSession | null,
    legacySpecEditLog: any[],
    canUseLegacySpecFallback: boolean,
  ): { editLog: any[]; recoverySource: 'session' | 'project_figure' | 'legacy_spec' | 'none' } {
    const sessionEditLog = Array.isArray(session?.editLog) ? session.editLog : [];
    if (sessionEditLog.length > 0) return { editLog: sessionEditLog, recoverySource: 'session' };
    const durableEditLog = parseStoredArray(row?.edit_log);
    if (durableEditLog.length > 0) return { editLog: durableEditLog, recoverySource: 'project_figure' };
    if (canUseLegacySpecFallback && legacySpecEditLog.length > 0) {
      return { editLog: legacySpecEditLog, recoverySource: 'legacy_spec' };
    }
    return { editLog: [], recoverySource: 'none' };
  }

  function resolveProjectFigureRevision(row: any, session: FigureSession | null): number {
    return Math.max(Number(session?.revision || 1), Number(row?.revision || 1));
  }

  function loadSession(sessionId: string, userId: string): FigureSession | null {
    const row = getDbSession(sessionId, userId);
    if (!row) return null;
    return {
      sessionId: row.id,
      ownerUserId: row.user_id,
      script: row.script,
      language: row.script.trim().startsWith('# language: r') ? 'r' : 'python',
      dataPayload: row.data_payload ? JSON.parse(row.data_payload) : null,
      editLog: JSON.parse(row.edit_log),
      revision: row.revision,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }

  function persistSession(s: FigureSession): void {
    const storedScript = s.language === 'r' && !s.script.trim().startsWith('# language: r')
      ? `# language: r\n${s.script}`
      : s.script;
    saveSession(s.sessionId, s.ownerUserId, storedScript, s.dataPayload, s.editLog, s.revision);
  }

  function syncProjectFigureRevision(sessionId: string, revision: number): void {
    getDb().prepare(`
      UPDATE project_figures
      SET revision = ?,
          edit_log = COALESCE((SELECT edit_log FROM sessions WHERE id = ?), edit_log)
      WHERE session_id = ?
    `).run(revision, sessionId, sessionId);
  }

  function syncProjectFigurePreview(args: {
    sessionId: string;
    revision: number;
    svg?: string | null;
    manifest?: unknown;
    codeSlice?: unknown;
    fingerprint?: string | number | null;
    diagnosticsSource?: unknown;
  }): void {
    const manifest = withRenderDiagnostics(args.manifest, args.diagnosticsSource);
    getDb().prepare(`
      UPDATE project_figures
      SET revision = ?,
          preview_svg = ?,
          manifest = ?,
          code_slice = ?,
          fingerprint = ?,
          edit_log = COALESCE((SELECT edit_log FROM sessions WHERE id = ?), edit_log),
          preview_updated_at = datetime('now')
      WHERE session_id = ?
    `).run(
      args.revision,
      args.svg || null,
      manifest ? JSON.stringify(manifest) : null,
      args.codeSlice ? JSON.stringify(args.codeSlice) : null,
      args.fingerprint !== undefined && args.fingerprint !== null ? String(args.fingerprint) : null,
      args.sessionId,
      args.sessionId,
    );
  }

  function invalidateProjectFigurePreview(sessionId: string, revision: number): void {
    getDb().prepare(`
      UPDATE project_figures
      SET revision = ?,
          preview_svg = NULL,
          manifest = NULL,
          code_slice = NULL,
          fingerprint = NULL,
          edit_log = COALESCE((SELECT edit_log FROM sessions WHERE id = ?), edit_log),
          preview_updated_at = NULL
      WHERE session_id = ?
    `).run(revision, sessionId, sessionId);
  }

  function persistProjectScript(projectId: string, userId: string, script: string): void {
    const project = getProject(projectId, userId);
    if (!project) return;
    let spec: any = {};
    try {
      spec = typeof project.spec === 'string' ? JSON.parse(project.spec) : (project.spec || {});
    } catch {
      spec = {};
    }
    spec.custom_script = script;
    spec.script = script;
    updateProject(projectId, userId, project.name, spec, script);
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

  function resolveRscriptBin(): string {
    return process.env.RSCRIPT_BIN || process.env.R_BIN || 'Rscript';
  }

  function buildProcessEnvForBin(executableBin: string): NodeJS.ProcessEnv {
    const rendererTmp = path.join(os.tmpdir(), 'scifigure-renderer');
    const mplConfigDir = path.join(rendererTmp, 'matplotlib');
    fs.mkdirSync(mplConfigDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '',
      HOME: rendererTmp,
      USERPROFILE: rendererTmp,
      TMPDIR: rendererTmp,
      TMP: os.tmpdir(),
      TEMP: os.tmpdir(),
      MPLBACKEND: 'Agg',
      MPLCONFIGDIR: mplConfigDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };
    if (path.basename(executableBin).toLowerCase().startsWith('docker')) {
      (['DOCKER_HOST', 'XDG_RUNTIME_DIR'] as const).forEach((key) => {
        if (process.env[key]) env[key] = process.env[key];
      });
    }
    (['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'R_HOME', 'R_LIBS_USER'] as const).forEach((key) => {
      if (process.env[key]) env[key] = process.env[key];
    });
    const normalizedBin = path.normalize(executableBin);
    const scriptsDir = path.basename(path.dirname(normalizedBin)).toLowerCase() === 'scripts'
      ? path.dirname(normalizedBin)
      : (path.basename(normalizedBin).toLowerCase().startsWith('python')
        ? path.dirname(normalizedBin)
        : '');
    if (!scriptsDir) {
      return env;
    }

    const envRoot = path.basename(scriptsDir).toLowerCase() === 'scripts'
      ? path.dirname(scriptsDir)
      : scriptsDir;
    const extraPaths = [
      envRoot,
      path.join(envRoot, 'Scripts'),
      path.join(envRoot, 'Library', 'bin'),
      path.join(envRoot, 'Library', 'mingw-w64', 'bin'),
      path.join(envRoot, 'Lib', 'R', 'bin'),
      path.join(envRoot, 'Lib', 'R', 'bin', 'x64'),
    ].filter(p => fs.existsSync(p));

    env.PATH = `${extraPaths.join(path.delimiter)}${path.delimiter}${env.PATH || ''}`;
    return env;
  }

  function rendererMode(): 'local' | 'docker' {
    const configured = String(process.env.SCIFIGURE_RENDER_MODE || '').trim().toLowerCase();
    if (configured === 'local' || configured === 'docker') return configured;
    const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
    return nodeEnv === '' || nodeEnv === 'development' || nodeEnv === 'test' ? 'local' : 'docker';
  }

  function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  type RendererRuntimePerformance = {
    mode: 'local' | 'docker';
    queueMs?: number;
    payloadStageMs?: number;
    processMs?: number;
    outputParseMs?: number;
    totalMs: number;
  };

  function roundedDuration(startedAt: number): number {
    return Math.max(0, Math.round(performance.now() - startedAt));
  }

  function rendererPerformanceFrom(result: any): Record<string, number> | null {
    const timing = result?.timingBreakdown;
    if (!timing || typeof timing !== 'object' || !Number.isFinite(Number(timing.totalMs))) {
      return null;
    }
    const allowedKeys = [
      'staticScanMs',
      'scriptExecutionMs',
      'dynamicScanMs',
      'figureDiscoveryMs',
      'editApplyMs',
      'introspectionMs',
      'svgSerializeMs',
      'layoutDiagnosticsMs',
      'binaryExportMs',
      'manifestBuildMs',
      'svgPostprocessMs',
      'totalMs',
    ];
    return Object.fromEntries(allowedKeys
      .filter(key => Number.isFinite(Number(timing[key])))
      .map(key => [key, Math.max(0, Math.round(Number(timing[key]))) ]));
  }

  function attachRuntimePerformance(result: any, runtime: RendererRuntimePerformance): any {
    if (!result || typeof result !== 'object') return result;
    return {
      ...result,
      performance: {
        ...(result.performance || {}),
        runtime,
      },
    };
  }

  function attachServerPerformance(result: any, serverTiming: Record<string, number>): any {
    if (!result || typeof result !== 'object') return result;
    return {
      ...result,
      performance: {
        ...(result.performance || {}),
        server: {
          ...(result.performance?.server || {}),
          ...Object.fromEntries(Object.entries(serverTiming)
            .filter(([, value]) => Number.isFinite(value))
            .map(([key, value]) => [key, Math.max(0, Math.round(value))])),
        },
      },
    };
  }

  app.use((req, res, next) => {
    const isMeasuredRenderRoute = req.path === '/api/figure/render'
      || req.path === '/api/figure/patch'
      || req.path === '/api/figure/code-patch'
      || /^\/api\/projects\/[^/]+\/figures\/render$/.test(req.path);
    if (!isMeasuredRenderRoute) return next();

    const requestStartedAt = performance.now();
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (body && typeof body === 'object') {
        const manifestLayoutWarnings = body.manifest?.renderDiagnostics?.layoutWarnings;
        const diagnostics = renderDiagnosticsFrom(
          Array.isArray(manifestLayoutWarnings)
            ? { ...body, layoutWarnings: manifestLayoutWarnings }
            : body,
          body.manifest,
        );
        if (diagnostics) body.diagnostics = diagnostics;
        const cacheHit = body.cache?.hit === true;
        const existingPerformance = body.performance && typeof body.performance === 'object'
          ? body.performance
          : {};
        const existingServer = existingPerformance.server && typeof existingPerformance.server === 'object'
          ? existingPerformance.server
          : {};
        body.performance = {
          schemaVersion: '1.0',
          cacheHit,
          renderer: cacheHit ? null : rendererPerformanceFrom(body),
          runtime: cacheHit ? null : existingPerformance.runtime || null,
          server: {
            ...existingServer,
            totalMs: roundedDuration(requestStartedAt),
          },
        };
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

  const normalizedNodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  const trustedLocalRuntime = normalizedNodeEnv === ''
    || normalizedNodeEnv === 'development'
    || normalizedNodeEnv === 'test'
    || process.env.SCIFIGURE_ALLOW_UNSAFE_LOCAL_RENDERER === '1';
  if (rendererMode() === 'local' && !trustedLocalRuntime) {
    throw new Error('Non-development environments require SCIFIGURE_RENDER_MODE=docker. Local renderer execution is disabled for security.');
  }

  async function withRenderSlot<T>(
    task: (queueMs: number) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return renderWorkQueue.run(task, signal);
  }

  function dockerMountPath(hostPath: string): string {
    const normalized = path.resolve(hostPath).replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) {
      return `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
    }
    return normalized;
  }

  function copyAllowedRendererFiles(payload: any, filesDir: string): any {
    const nextPayload = { ...(payload || {}) };
    const uploadedPaths = nextPayload.uploaded_file_paths;
    const sourceCwd = typeof nextPayload.cwd === 'string' ? nextPayload.cwd : undefined;
    if (!uploadedPaths || typeof uploadedPaths !== 'object') {
      delete nextPayload.cwd;
      return nextPayload;
    }
    const safeCwd = resolveSafeRendererCwd(sourceCwd);
    if (!safeCwd) {
      nextPayload.uploaded_file_paths = {};
      delete nextPayload.cwd;
      return nextPayload;
    }
    const copiedBySource = new Map<string, string>();
    const mapped: Record<string, string> = {};
    Object.entries(uploadedPaths as Record<string, string>).forEach(([key, value]) => {
      const source = resolveAllowedRendererFile(value, safeCwd);
      if (!source) return;
      let copiedName = copiedBySource.get(source);
      if (!copiedName) {
        copiedName = `${copiedBySource.size}_${path.basename(source)}`;
        const copiedPath = path.join(filesDir, copiedName);
        fs.copyFileSync(source, copiedPath);
        fs.chmodSync(copiedPath, 0o444);
        copiedBySource.set(source, copiedName);
      }
      mapped[key] = `/work/files/${copiedName}`;
      mapped[path.basename(value)] = `/work/files/${copiedName}`;
    });
    nextPayload.uploaded_file_paths = mapped;
    nextPayload.cwd = '/work/files';
    return nextPayload;
  }

  async function spawnDockerRenderer(
    runtime: 'python' | 'r',
    scriptName: string,
    payload: unknown,
    options: SpawnPythonOptions,
  ): Promise<any> {
    const runtimeStartedAt = performance.now();
    const workSignal = requestWorkAbortSignal(options.req);
    return withRenderSlot(async (queueMs) => {
    const payloadStageStartedAt = performance.now();
    const configuredRTimeout = Math.max(5_000, Math.min(120_000, Number(process.env.SCIFIGURE_R_TIMEOUT_MS || 45_000)));
    const timeoutMs = options.timeoutMs ?? (runtime === 'r' ? configuredRTimeout : scriptName === 'introspector.py' ? 45_000 : 20_000);
    const image = process.env.SCIFIGURE_RENDERER_IMAGE || 'scifigure-renderer:latest';
    const containerName = `scifigure-render-${randomUUID().replace(/-/g, '')}`;
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-render-task-'));
    const workDir = path.join(taskRoot, 'work');
    try {
      fs.chmodSync(taskRoot, 0o700);
      fs.mkdirSync(workDir, { mode: 0o755 });
      fs.chmodSync(workDir, 0o755);
      const filesDir = path.join(workDir, 'files');
      fs.mkdirSync(filesDir, { mode: 0o755 });
      fs.chmodSync(filesDir, 0o755);
      const preparedPayload = copyAllowedRendererFiles(payload as any, filesDir);
      const payloadFile = path.join(workDir, 'payload.json');
      fs.writeFileSync(payloadFile, JSON.stringify(preparedPayload), 'utf-8');
      fs.chmodSync(payloadFile, 0o444);
    } catch (error) {
      fs.rmSync(taskRoot, { recursive: true, force: true });
      throw error;
    }
    const payloadStageMs = roundedDuration(payloadStageStartedAt);
    const command = runtime === 'r'
      ? ['Rscript', '/opt/scifigure/renderer/r_renderer.R', '--payload-file', '/work/payload.json']
      : ['python', `/opt/scifigure/renderer/${scriptName}`, '--payload-file', '/work/payload.json'];
    const args = [
      'run', '--rm', '--name', containerName, '--network', 'none', '--read-only',
      '--label', 'scifigure.managed=true', '--label', `scifigure.kind=${runtime}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '65532:65532',
      '--pids-limit', String(process.env.SCIFIGURE_RENDER_PIDS || '128'),
      '--memory', String(process.env.SCIFIGURE_RENDER_MEMORY || '1g'),
      '--cpus', String(process.env.SCIFIGURE_RENDER_CPUS || '1'),
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--mount', `type=bind,src=${dockerMountPath(workDir)},dst=/work,readonly`,
      '--workdir', '/work/files',
      image,
      ...command,
    ];

    const processStartedAt = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildProcessEnvForBin('docker') });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      const maxOutputMb = boundedNumber(options.maxOutputMb ?? process.env.SCIFIGURE_RENDER_OUTPUT_MB, 8, 1, 64);
      const maxOutputBytes = maxOutputMb * 1024 * 1024;
      const forceRemoveContainer = () => {
        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          env: buildProcessEnvForBin('docker'),
          windowsHide: true,
          timeout: 10_000,
        });
      };
      const abort = () => {
        forceRemoveContainer();
        child.kill('SIGKILL');
      };
      const untrackAborter = trackRendererAborter(abort);
      const cleanup = () => {
        try { fs.rmSync(taskRoot, { recursive: true, force: true }); } catch { /* already removed */ }
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      };
      const captureOutput = (kind: 'stdout' | 'stderr', data: Buffer) => {
        if (settled) return;
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) {
          forceRemoveContainer();
          child.kill('SIGKILL');
          finishError(new Error(`Docker renderer output exceeded ${maxOutputMb} MB`));
          return;
        }
        if (kind === 'stdout') stdout += data.toString();
        else stderr += data.toString();
      };
      const timer = setTimeout(() => {
        forceRemoveContainer();
        child.kill('SIGKILL');
        finishError(new Error(`Docker renderer timed out (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      child.stdout.on('data', (data: Buffer) => captureOutput('stdout', data));
      child.stderr.on('data', (data: Buffer) => captureOutput('stderr', data));
      child.on('error', (error) => {
        untrackAborter();
        forceRemoveContainer();
        finishError(error);
      });
      child.on('close', code => {
        untrackAborter();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (code !== 0) {
          reject(new Error(`Docker renderer exited ${code}: ${stderr.slice(0, 1200)}`));
          return;
        }
        const processMs = roundedDuration(processStartedAt);
        const outputParseStartedAt = performance.now();
        try {
          const parsed = JSON.parse(stdout);
          const outputParseMs = roundedDuration(outputParseStartedAt);
          resolve(attachRuntimePerformance(parsed, {
            mode: 'docker',
            queueMs,
            payloadStageMs,
            processMs,
            outputParseMs,
            totalMs: roundedDuration(runtimeStartedAt),
          }));
        } catch (error) {
          reject(new Error(`Failed to parse Docker renderer output: ${error}\n${stderr.slice(0, 1200)}`));
        }
      });
      options.req?.once('aborted', abort);
      workSignal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => {
        options.req?.removeListener('aborted', abort);
        workSignal?.removeEventListener('abort', abort);
      });
    });
    }, workSignal);
  }

  type SpawnPythonOptions = {
    req?: express.Request;
    timeoutMs?: number;
    label?: string;
    maxOutputMb?: number;
  };

  async function spawnPythonWithPayload(
    scriptName: string,
    payload: unknown,
    options: SpawnPythonOptions = {}
  ): Promise<any> {
    assertRendererDataPayload(payload);
    if (rendererMode() === 'docker' && (scriptName === 'introspector.py' || scriptName === 'svg_convert.py')) {
      return spawnDockerRenderer('python', scriptName, payload, options);
    }
    const timeoutMs = options.timeoutMs ?? (scriptName === 'introspector.py' ? 45000 : 20000);
    const label = options.label ?? scriptName;
    const scriptLen = typeof (payload as any)?.script === 'string' ? (payload as any).script.length : 0;
    const rowCount = Array.isArray((payload as any)?.dataPayload?.custom_data) ? (payload as any).dataPayload.custom_data.length : 0;
    const runtimeStartedAt = performance.now();
    const workSignal = requestWorkAbortSignal(options.req);
    if (workSignal?.aborted) throw new Error('Render request aborted before renderer start');
    const payloadStageStartedAt = performance.now();

    // Write payload to temp file (prevents stdin buffer deadlock for large payloads)
    const payloadFile = path.join(os.tmpdir(), `scifigure-payload-${randomUUID()}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(payload), 'utf-8');
    const payloadStageMs = roundedDuration(payloadStageStartedAt);

    return new Promise((resolve, reject) => {
      const pythonBin = resolvePythonBin();
      const scriptPath = path.join(process.cwd(), 'renderer', scriptName);
      const processStartedAt = performance.now();
      const child = spawn(pythonBin, [scriptPath, '--payload-file', payloadFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildProcessEnvForBin(pythonBin),
      });

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let closed = false;
      let sigkillTimer: NodeJS.Timeout | null = null;
      let untrackAborter = () => {};
      const maxOutputMb = boundedNumber(options.maxOutputMb ?? process.env.SCIFIGURE_RENDER_OUTPUT_MB, 8, 1, 64);
      const maxOutputBytes = maxOutputMb * 1024 * 1024;

      const cleanupPayload = () => {
        try { fs.unlinkSync(payloadFile); } catch { /* temp file already gone */ }
      };

      const killChild = (reason: string) => {
        if (settled || closed) return;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 2000);
      };
      untrackAborter = trackRendererAborter(() => killChild(`${label}: deployment shutdown`));

      const onRequestAborted = () => killChild(`${label}: request aborted`);
      const removeAbortListeners = () => {
        options.req?.removeListener('aborted', onRequestAborted);
        workSignal?.removeEventListener('abort', onRequestAborted);
      };

      if (options.req && !options.req.destroyed) {
        // Do not listen to req.close here. In Express/Node it can fire for a
        // normally completed request body, which previously killed short-lived
        // validation workers and made every render fail at the AST gate.
        options.req.on('aborted', onRequestAborted);
      }
      workSignal?.addEventListener('abort', onRequestAborted, { once: true });

      const timer = setTimeout(() => {
        killChild(`${label}: timeout after ${timeoutMs}ms`);
        settled = true;
        cleanupPayload();
        removeAbortListeners();
        reject(new Error(`Python process timed out (${Math.round(timeoutMs / 1000)}s) [script=${scriptName}, scriptLen=${scriptLen}, rows=${rowCount}]${stderr ? ` stderr=${stderr.slice(0, 400)}` : ''}`));
      }, timeoutMs);

      const captureOutput = (kind: 'stdout' | 'stderr', data: Buffer) => {
        if (settled) return;
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) {
          killChild(`${label}: output limit exceeded`);
          settled = true;
          clearTimeout(timer);
          cleanupPayload();
          removeAbortListeners();
          reject(new Error(`Python process output exceeded ${maxOutputMb} MB [script=${scriptName}]`));
          return;
        }
        if (kind === 'stdout') stdout += data.toString();
        else stderr += data.toString();
      };

      child.stdout.on('data', (d: Buffer) => captureOutput('stdout', d));
      child.stderr.on('data', (d: Buffer) => captureOutput('stderr', d));

      child.on('error', (err) => {
        untrackAborter();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        cleanupPayload();
        removeAbortListeners();
        reject(err);
      });

      child.on('close', (code) => {
        untrackAborter();
        closed = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupPayload();
        removeAbortListeners();

        if (code !== 0) {
          reject(new Error(`Python exited ${code}: ${stderr}`));
          return;
        }
        const processMs = roundedDuration(processStartedAt);
        const outputParseStartedAt = performance.now();
        try {
          const parsed = JSON.parse(stdout);
          const outputParseMs = roundedDuration(outputParseStartedAt);
          resolve(attachRuntimePerformance(parsed, {
            mode: 'local',
            payloadStageMs,
            processMs,
            outputParseMs,
            totalMs: roundedDuration(runtimeStartedAt),
          }));
        } catch (e) {
          reject(new Error(`Failed to parse Python JSON output: ${e}\nSTDERR:\n${stderr}`));
        }
      });
    });
  }

  async function spawnRWithPayload(
    payload: unknown,
    options: SpawnPythonOptions = {}
  ): Promise<any> {
    assertRendererDataPayload(payload);
    const script = typeof (payload as any)?.script === 'string' ? (payload as any).script : '';
    const riskCheck = validateRScriptRisk(script, options.req);
    if (!riskCheck.ok) {
      return {
        status: 'error',
        message: riskCheck.message,
        riskFindings: riskCheck.findings,
      };
    }
    const appendRiskWarnings = (result: any) => {
      if (!riskCheck.findings.length || !result || typeof result !== 'object') return result;
      return {
        ...result,
        warnings: [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          {
            type: 'r_risk_precheck',
            mode: process.env.SCIFIGURE_R_RISK_ENFORCE === '1' ? 'block_high' : 'log_only',
            findings: riskCheck.findings,
          },
        ],
      };
    };
    if (rendererMode() === 'docker') {
      return appendRiskWarnings(await spawnDockerRenderer('r', 'r_renderer.R', payload, options));
    }
    const timeoutMs = options.timeoutMs
      ?? Math.max(5_000, Math.min(120_000, Number(process.env.SCIFIGURE_R_TIMEOUT_MS || 45_000)));
    const label = options.label ?? 'r-render';
    const runtimeStartedAt = performance.now();
    const workSignal = requestWorkAbortSignal(options.req);
    if (workSignal?.aborted) throw new Error('R render request aborted before renderer start');
    let mirrorDir: string | null = null;
    const shouldBridgeCsvForR = (filePath: string) => /\.(csv|tsv|txt)$/i.test(filePath);
    const bridgeCsvForR = (source: string, mirroredName: string): string | null => {
      try {
        const content = fs.readFileSync(source, 'utf-8');
        const isTsv = /\.tsv$/i.test(source);
        const parsed = Papa.parse<Record<string, unknown>>(content, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: true,
          delimiter: isTsv ? '\t' : undefined,
          transformHeader: (header) => String(header || '').replace(/^\uFEFF/, '').trim(),
        });
        if (parsed.errors?.length) {
          const blocking = parsed.errors.find((err) => err.type === 'Delimiter' || err.type === 'Quotes');
          if (blocking) return null;
        }
        const columns = (parsed.meta.fields || []).map((field) => String(field));
        if (!columns.length) return null;
        const sidecarName = `${mirroredName}.scifigure-table.json`;
        const sidecarPath = path.join(mirrorDir!, sidecarName);
        fs.writeFileSync(sidecarPath, JSON.stringify({
          columns,
          rows: parsed.data,
        }), 'utf-8');
        return sidecarName;
      } catch {
        return null;
      }
    };
    const preparePayloadForR = (rawPayload: any) => {
      const nextPayload = { ...(rawPayload || {}) };
      const uploadedPaths = nextPayload.uploaded_file_paths;
      if (!uploadedPaths || typeof uploadedPaths !== 'object') {
        delete nextPayload.cwd;
        return nextPayload;
      }

      const safeCwd = resolveSafeRendererCwd(nextPayload.cwd);
      if (!safeCwd) {
        nextPayload.uploaded_file_paths = {};
        nextPayload.csv_json_paths = {};
        delete nextPayload.cwd;
        return nextPayload;
      }

      mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-r-files-'));
      const mirroredPaths: Record<string, string> = {};
      const csvJsonPaths: Record<string, string> = {};
      const copiedBySource = new Map<string, string>();
      const bridgedBySource = new Map<string, string | null>();

      Object.entries(uploadedPaths as Record<string, string>).forEach(([key, value]) => {
        const source = resolveAllowedRendererFile(value, safeCwd);
        if (!source) return;
        let mirroredName = copiedBySource.get(source);
        if (!mirroredName) {
          mirroredName = path.basename(source);
          const dest = path.join(mirrorDir!, mirroredName);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(source, dest);
          }
          copiedBySource.set(source, mirroredName);
        }
        mirroredPaths[key] = mirroredName;
        if (shouldBridgeCsvForR(source)) {
          if (!bridgedBySource.has(source)) {
            bridgedBySource.set(source, bridgeCsvForR(source, mirroredName));
          }
          const sidecarName = bridgedBySource.get(source);
          if (sidecarName) {
            csvJsonPaths[key] = sidecarName;
            csvJsonPaths[mirroredName] = sidecarName;
            csvJsonPaths[path.basename(mirroredName)] = sidecarName;
          }
        }
      });

      nextPayload.uploaded_file_paths = mirroredPaths;
      nextPayload.csv_json_paths = {
        ...(nextPayload.csv_json_paths || {}),
        ...csvJsonPaths,
      };
      nextPayload.cwd = mirrorDir;
      return nextPayload;
    };
    const payloadStageStartedAt = performance.now();
    const rPayload = preparePayloadForR(payload as any);
    const payloadFile = path.join(os.tmpdir(), `scifigure-r-payload-${randomUUID()}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(rPayload), 'utf-8');
    const payloadStageMs = roundedDuration(payloadStageStartedAt);

    return new Promise((resolve, reject) => {
      const rscriptBin = resolveRscriptBin();
      const scriptPath = path.join(process.cwd(), 'renderer', 'r_renderer.R');
      const processStartedAt = performance.now();
      const child = spawn(rscriptBin, [scriptPath, '--payload-file', payloadFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildProcessEnvForBin(rscriptBin),
      });

      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let closed = false;
      let sigkillTimer: NodeJS.Timeout | null = null;
      let untrackAborter = () => {};
      const maxOutputMb = boundedNumber(options.maxOutputMb ?? process.env.SCIFIGURE_RENDER_OUTPUT_MB, 8, 1, 64);
      const maxOutputBytes = maxOutputMb * 1024 * 1024;

      const cleanupPayload = () => {
        try { fs.unlinkSync(payloadFile); } catch { /* temp file already gone */ }
        if (mirrorDir) {
          try { fs.rmSync(mirrorDir, { recursive: true, force: true }); } catch { /* temp mirror already gone */ }
          mirrorDir = null;
        }
      };

      const killChild = () => {
        if (closed) return;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 2000);
      };
      untrackAborter = trackRendererAborter(killChild);

      const onRequestAborted = () => killChild();
      const removeAbortListeners = () => {
        options.req?.removeListener('aborted', onRequestAborted);
        workSignal?.removeEventListener('abort', onRequestAborted);
      };
      if (options.req && !options.req.destroyed) {
        options.req.on('aborted', onRequestAborted);
      }
      workSignal?.addEventListener('abort', onRequestAborted, { once: true });

      const timer = setTimeout(() => {
        killChild();
        settled = true;
        cleanupPayload();
        removeAbortListeners();
        reject(new Error(`R process timed out (${Math.round(timeoutMs / 1000)}s)${stderr ? ` stderr=${stderr.slice(0, 400)}` : ''}`));
      }, timeoutMs);

      const captureOutput = (kind: 'stdout' | 'stderr', data: Buffer) => {
        if (settled) return;
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) {
          killChild();
          settled = true;
          clearTimeout(timer);
          cleanupPayload();
          removeAbortListeners();
          reject(new Error(`R process output exceeded ${maxOutputMb} MB`));
          return;
        }
        if (kind === 'stdout') stdout += data.toString();
        else stderr += data.toString();
      };

      child.stdout.on('data', (d: Buffer) => captureOutput('stdout', d));
      child.stderr.on('data', (d: Buffer) => captureOutput('stderr', d));

      child.on('error', (err: any) => {
        untrackAborter();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        cleanupPayload();
        removeAbortListeners();
        if (err?.code === 'ENOENT') {
          reject(new Error('Rscript not found. Please install R and ensure Rscript is available in PATH, or set RSCRIPT_BIN.'));
          return;
        }
        reject(err);
      });

      child.on('close', (code) => {
        untrackAborter();
        closed = true;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        cleanupPayload();
        removeAbortListeners();
        const processMs = roundedDuration(processStartedAt);
        if (code !== 0) {
          if (stdout.trim().startsWith('{')) {
            const outputParseStartedAt = performance.now();
            try {
              const parsed = JSON.parse(stdout);
              parsed.warnings = [
                ...(parsed.warnings || []),
                `R process exited with code ${code} after producing JSON output.`,
              ];
              const outputParseMs = roundedDuration(outputParseStartedAt);
              resolve(attachRuntimePerformance(appendRiskWarnings(parsed), {
                mode: 'local',
                payloadStageMs,
                processMs,
                outputParseMs,
                totalMs: roundedDuration(runtimeStartedAt),
              }));
              return;
            } catch {
              // Fall through to the explicit non-zero exit error below.
            }
          }
          reject(new Error(`R exited ${code}: ${stderr}`));
          return;
        }
        const outputParseStartedAt = performance.now();
        try {
          const parsed = appendRiskWarnings(JSON.parse(stdout));
          const outputParseMs = roundedDuration(outputParseStartedAt);
          resolve(attachRuntimePerformance(parsed, {
            mode: 'local',
            payloadStageMs,
            processMs,
            outputParseMs,
            totalMs: roundedDuration(runtimeStartedAt),
          }));
        } catch (e) {
          reject(new Error(`Failed to parse R JSON output: ${e}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout.slice(0, 400)}`));
        }
      });
    });
  }

  function cleanScript(script: string): string {
    return script.replace(/^```[a-z]*\n?/im, '').replace(/\n?```\s*$/i, '');
  }

  const PATCH_VIRTUAL_FONT_CENTER_PROPS = new Set([
    'fontsize',
    'fontfamily',
    'color',
    'fontweight',
    'fontstyle',
  ]);

  function parseManifestValue(value: unknown): any | null {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return typeof value === 'object' ? value : null;
  }

  function buildPatchConflictResponse(session: any, requestId: string, rejected: any[], warnings: any[]) {
    return {
      status: 'conflict',
      message: '部分修改未通过目标身份或 renderer 应用确认，本批次未写入。',
      sessionId: session.sessionId,
      revision: session.revision,
      editLog: session.editLog,
      script: session.script,
      applied: [],
      rejected,
      warnings,
      requestId,
    };
  }

  function normalizeProjectFigurePatchModes(figRow: any, patches: any[]) {
    const manifest = parseManifestValue(figRow?.manifest);
    if (!manifest) {
      return patches.map((patch: any) => ({ ...patch, mode: 'backend_patch' }));
    }

    const objectById = new Map<string, any>(
      (Array.isArray(manifest.objects) ? manifest.objects : [])
        .map((object: any) => [String(object.id), object] as const),
    );
    return patches.map((patch: any) => {
      if (patch?.gid === 'global' || isDurableVirtualEditGid(String(patch?.gid || ''))) {
        return { ...patch, mode: 'backend_patch' };
      }
      if (typeof patch?.matchColor === 'string' && patch.matchColor.trim()) {
        return { ...patch, mode: 'backend_patch' };
      }
      const object = objectById.get(String(patch?.gid || ''));
      const mode = resolveAuthoritativeProjectPatchMode(
        manifest,
        object,
        String(patch?.prop || ''),
      );
      return patch?.mode === mode ? patch : { ...patch, mode };
    });
  }

  function precheckManifestPatches(
    manifestValue: unknown,
    patches: any[],
  ) {
    const manifest = parseManifestValue(manifestValue);
    if (!manifest) {
      return { ok: false, warnings: [{ type: 'manifest_unavailable', message: '可信 manifest 不可用。' }] };
    }

    const objectById = new Map<string, any>(
      (Array.isArray(manifest.objects) ? manifest.objects : [])
        .map((object: any) => [String(object.id), object] as const),
    );
    const warnings: any[] = [];

    for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
      const patch = patches[patchIndex];
      const gid = typeof patch?.gid === 'string' ? patch.gid : '';
      const prop = typeof patch?.prop === 'string' ? patch.prop : '';
      const reject = (type: string, message: string, extra: Record<string, unknown> = {}) => {
        warnings.push({ type, gid, prop, patchIndex, message, ...extra });
      };

      if (!gid) {
        reject('missing_gid', 'Patch is missing a gid.');
        continue;
      }
      if (gid === 'global') {
        if (!manifest.globals?.[prop]) reject('unsupported_prop', `Global patch ${gid}.${prop} is not declared.`);
        continue;
      }
      if (isDurableVirtualEditGid(gid)) {
        if (!PATCH_VIRTUAL_FONT_CENTER_PROPS.has(prop)) {
          reject('unsupported_prop', `Virtual patch ${gid}.${prop} is not supported.`);
        }
        continue;
      }

      const object = objectById.get(gid);
      if (!object) {
        reject('missing_gid', `Manifest is missing gid ${gid}.`);
        continue;
      }
      const capability = Array.isArray(object.propertyCapabilities)
        ? object.propertyCapabilities.find((item: any) => item?.prop === prop)
        : undefined;
      const editable = Array.isArray(object.editable) ? object.editable : [];
      const hasAuthoritativeCapabilities = Array.isArray(object.propertyCapabilities);
      const replay = typeof capability?.replay === 'string' ? capability.replay : undefined;
      const scopes = Array.isArray(capability?.scopes) ? capability.scopes.map(String) : [];
      const supported = capability
        ? replay !== 'unsupported' && scopes.includes('object')
        : !hasAuthoritativeCapabilities && editable.includes(prop);
      if (!supported) {
        reject('unsupported_prop', `${gid}.${prop} is not editable or replayable on the current manifest object.`, {
          replay: replay || null,
          scopes,
        });
        continue;
      }
      if (patch.stableKey !== undefined && patch.stableKey !== object.stableKey) {
        reject('identity_mismatch', `${gid} stableKey does not match.`, { field: 'stableKey' });
      }
      if (
        patch.fingerprintVersion === 2
        && object.fingerprintVersion === 2
        && patch.fingerprint !== undefined
        && patch.fingerprint !== object.fingerprint
        && !isCompatibleContourChildSnapshotFingerprint(patch, object, prop)
      ) {
        reject('identity_mismatch', `${gid} fingerprint does not match.`, { field: 'fingerprint' });
      }
      if (patch.identity?.seriesKey !== undefined && patch.identity.seriesKey !== object.identity?.seriesKey) {
        reject('identity_mismatch', `${gid} identity.seriesKey does not match.`, { field: 'identity.seriesKey' });
      }
      if (requiresDiagramRelationIdentity(object)) {
        const expectedRelation = diagramRelationSignature(object.identity);
        const actualRelation = diagramRelationSignature(patch.identity);
        if (expectedRelation === null || actualRelation !== expectedRelation) {
          reject('identity_mismatch', `${gid} diagram relationship does not match the manifest object.`, {
            field: 'identity.relation',
            expected: object.identity?.relation ?? null,
            actual: patch.identity?.relation ?? null,
          });
        }
      }
      if (requiresSpecialAxesRelationIdentity(object)) {
        const expectedRelation = specialAxesRelationSignature(object.identity);
        const actualRelation = specialAxesRelationSignature(patch.identity);
        if (expectedRelation === null || actualRelation !== expectedRelation) {
          reject('identity_mismatch', `${gid} special axes relationship does not match the manifest object.`, {
            field: 'identity.relation',
            expected: object.identity?.relation ?? null,
            actual: patch.identity?.relation ?? null,
          });
        }
      }
    }

    return { ok: warnings.length === 0, warnings };
  }

  function precheckProjectFigurePatches(
    figRow: any,
    patches: any[],
  ) {
    const manifest = parseManifestValue(figRow?.manifest);
    return manifest ? precheckManifestPatches(manifest, patches) : { ok: true, warnings: [] as any[] };
  }

  function precheckRenderedPythonPatches(
    manifest: unknown,
    patches: any[],
  ) {
    const parsedManifest = parseManifestValue(manifest);
    if (!parsedManifest) {
      return {
        ok: false,
        warnings: patches.map((patch: any, patchIndex: number) => ({
          type: 'manifest_unavailable',
          gid: typeof patch?.gid === 'string' ? patch.gid : '',
          prop: typeof patch?.prop === 'string' ? patch.prop : '',
          patchIndex,
          message: 'Renderer 未返回可信 manifest，本批次未写入。',
        })),
      };
    }
    return precheckProjectFigurePatches({ manifest: parsedManifest }, patches);
  }

  function sameProjectEditValue(left: any, right: any): boolean {
    return left?.gid === right?.gid
      && left?.prop === right?.prop
      && stableStringifyForExport(left?.value) === stableStringifyForExport(right?.value);
  }

  function sameProjectEditIdentity(left: any, right: any): boolean {
    return left?.stableKey === right?.stableKey
      && left?.fingerprint === right?.fingerprint
      && left?.fingerprintVersion === right?.fingerprintVersion
      && stableStringifyForExport(left?.identity) === stableStringifyForExport(right?.identity);
  }

  function isCompatibleKnownLegacyContourChildEdit(
    manifestValue: unknown,
    patch: any,
    knownEditLog: any[],
  ): boolean {
    const manifest = parseManifestValue(manifestValue);
    const object = manifest?.objects?.find((candidate: any) => candidate?.id === patch?.gid);
    return isLegacyContourChildSnapshotEdit(object, String(patch?.prop || ''))
      && knownEditLog.some((knownPatch: any) => sameProjectEditValue(knownPatch, patch));
  }

  function isCompatibleKnownLegacySpecialAxesEdit(
    manifestValue: unknown,
    patch: any,
    knownEditLog: any[],
  ): boolean {
    if (!knownEditLog.some(existing => sameProjectEditValue(existing, patch))) return false;
    const manifest = parseManifestValue(manifestValue);
    const object = Array.isArray(manifest?.objects)
      ? manifest.objects.find((candidate: any) => candidate?.id === patch?.gid)
      : null;
    if (!object || !requiresSpecialAxesRelationIdentity(object)) return false;
    if (hasSpecialAxesMetadata(patch?.identity)) return false;
    if (typeof patch?.stableKey !== 'string' || patch.stableKey !== object.stableKey) return false;
    if (patch?.fingerprint !== undefined || patch?.fingerprintVersion !== undefined) {
      if (
        patch?.fingerprintVersion !== 2
        || object?.fingerprintVersion !== 2
        || patch?.fingerprint !== object?.fingerprint
      ) return false;
    }
    const patchSeriesKey = patch?.identity?.seriesKey;
    return patchSeriesKey === undefined || patchSeriesKey === object?.identity?.seriesKey;
  }

  const LEGACY_AXIS_FONT_PROP_MAP: Record<string, string> = {
    fontsize: 'tick_labelsize',
    fontfamily: 'tick_labelfamily',
    color: 'tick_labelcolor',
    fontweight: 'tick_fontweight',
    fontstyle: 'tick_fontstyle',
  };

  function isCompatibleKnownDisappearingEdit(patch: any, knownEditLog: any[]): boolean {
    const isDisappearing = patch?.prop === 'text'
      ? String(patch?.value ?? '') === ''
      : patch?.prop === 'visible' && patch?.value === false;
    if (!isDisappearing) return false;
    return knownEditLog.some(existing => (
      sameProjectEditValue(existing, patch)
        && sameProjectEditIdentity(existing, patch)
    ));
  }

  function isCompatibleKnownLegacyAxisFontEdit(
    manifestValue: unknown,
    patch: any,
    knownEditLog: any[],
  ): boolean {
    if (!knownEditLog.some(existing => (
      sameProjectEditValue(existing, patch)
        && sameProjectEditIdentity(existing, patch)
    ))) return false;
    if (!/^axis\.[xyz]\.\d+$/.test(String(patch?.gid || ''))) return false;
    const canonicalProp = LEGACY_AXIS_FONT_PROP_MAP[String(patch?.prop || '')];
    if (!canonicalProp) return false;
    const manifest = parseManifestValue(manifestValue);
    const object = Array.isArray(manifest?.objects)
      ? manifest.objects.find((candidate: any) => candidate?.id === patch?.gid)
      : null;
    if (!object) return false;
    const capability = Array.isArray(object.propertyCapabilities)
      ? object.propertyCapabilities.find((item: any) => item?.prop === canonicalProp)
      : null;
    if (
      !capability
      || capability.replay === 'unsupported'
      || !Array.isArray(capability.scopes)
      || !capability.scopes.includes('object')
    ) return false;
    if (patch?.stableKey !== undefined && patch.stableKey !== object.stableKey) return false;
    if (
      patch?.fingerprintVersion === 2
      && object?.fingerprintVersion === 2
      && patch?.fingerprint !== undefined
      && patch.fingerprint !== object.fingerprint
    ) return false;
    const seriesKey = patch?.identity?.seriesKey;
    return seriesKey === undefined || seriesKey === object?.identity?.seriesKey;
  }

  function sameProjectEditLogSemantics(left: any[], right: any[]): boolean {
    const canonicalize = (entries: any[]) => entries.map((entry: any) => (
      entry?.type === 'code_patch'
        ? stableStringifyForExport({
          type: 'code_patch',
          target_id: entry?.target_id,
          new_value: entry?.new_value,
          gids: entry?.gids,
        })
        : stableStringifyForExport({
          gid: entry?.gid,
          prop: entry?.prop,
          value: entry?.value,
        })
    )).sort();
    return stableStringifyForExport(canonicalize(left)) === stableStringifyForExport(canonicalize(right));
  }

  function preflightProjectFigureEditLog(
    figRow: any,
    existingEditLog: any[],
    incomingPatches: any[],
    knownEditLog: any[] = existingEditLog,
  ) {
    const normalizedPatches = normalizeProjectFigurePatchModes(figRow, incomingPatches);
    const manifest = parseManifestValue(figRow?.manifest);
    if (manifest) {
      const precheck = precheckManifestPatches(manifest, normalizedPatches);
      const warnings = precheck.warnings.filter((warning: any) => {
        const patch = typeof warning?.patchIndex === 'number'
          ? normalizedPatches[warning.patchIndex]
          : null;
        return !knownEditLog.some(existing => sameProjectEditValue(existing, patch));
      });
      const rejectedIndexes = new Set(
        warnings
          .map((warning: any) => warning.patchIndex)
          .filter((index: unknown): index is number => typeof index === 'number'),
      );
      return {
        patches: normalizedPatches,
        ok: warnings.length === 0,
        warnings,
        rejected: normalizedPatches.filter((_: any, index: number) => rejectedIndexes.has(index)),
      };
    }

    const warnings: any[] = [];
    const rejected: any[] = [];
    normalizedPatches.forEach((patch: any, patchIndex: number) => {
      if (knownEditLog.some(existing => sameProjectEditValue(existing, patch))) return;
      warnings.push({
        type: 'manifest_unavailable',
        gid: typeof patch?.gid === 'string' ? patch.gid : '',
        prop: typeof patch?.prop === 'string' ? patch.prop : '',
        patchIndex,
        message: '当前 Figure 没有可信 manifest，新增编辑必须先经过 renderer 验证。',
      });
      rejected.push(patch);
    });
    return { patches: normalizedPatches, ok: warnings.length === 0, warnings, rejected };
  }

  function preflightProjectFigureHistory(
    figRow: any,
    existingEditLog: any[],
    existingHistory: { past: any[]; future: any[] },
    incomingHistory: { past: any[]; future: any[] },
  ) {
    const knownEditLog = [
      ...existingEditLog,
      ...existingHistory.past.flatMap(snapshot => Array.isArray(snapshot?.editLog) ? snapshot.editLog : []),
      ...existingHistory.future.flatMap(snapshot => Array.isArray(snapshot?.editLog) ? snapshot.editLog : []),
    ];
    const warnings: any[] = [];
    const rejected: any[] = [];
    const history: { past: any[]; future: any[] } = { past: [], future: [] };

    for (const historyKey of ['past', 'future'] as const) {
      const snapshots = Array.isArray(incomingHistory[historyKey]) ? incomingHistory[historyKey] : [];
      history[historyKey] = snapshots.map((snapshot: any, snapshotIndex: number) => {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          warnings.push({ type: 'invalid_history_snapshot', historyKey, snapshotIndex, message: '历史快照格式无效。' });
          return snapshot;
        }
        if (snapshot.editLog === undefined) return { ...snapshot };
        if (!Array.isArray(snapshot.editLog)) {
          warnings.push({ type: 'invalid_history_edit_log', historyKey, snapshotIndex, message: '历史快照 editLog 格式无效。' });
          return { ...snapshot };
        }
        const preflight = preflightProjectFigureEditLog(
          figRow,
          existingEditLog,
          snapshot.editLog,
          knownEditLog,
        );
        preflight.warnings.forEach((warning: any) => warnings.push({ ...warning, historyKey, snapshotIndex }));
        preflight.rejected.forEach((patch: any) => rejected.push({ ...patch, historyKey, snapshotIndex }));
        return { ...snapshot, editLog: preflight.patches };
      });
    }

    return { history, ok: warnings.length === 0 && rejected.length === 0, warnings, rejected };
  }

  function isConflictWarningForPatch(warning: any, patch: any): boolean {
    if (!warning || !patch || typeof warning !== 'object' || typeof patch !== 'object') return false;
    if (warning.gid !== patch.gid || warning.prop !== patch.prop) return false;
    return isSnapshotReplayWarning(warning);
  }

  function precheckRenderedProjectFigureEditLog(
    manifest: unknown,
    patches: any[],
    knownEditLog: any[] = [],
    figureId?: string,
  ) {
    const precheck = precheckRenderedPythonPatches(manifest, patches);
    const warnings: any[] = [];
    precheck.warnings.forEach((warning: any) => {
      const patch = typeof warning?.patchIndex === 'number'
        ? patches[warning.patchIndex]
        : null;
      const compatibleLegacySpecialAxesEdit = warning?.type === 'identity_mismatch'
        && warning?.field === 'identity.relation'
        && isCompatibleKnownLegacySpecialAxesEdit(manifest, patch, knownEditLog);
      const compatibleLegacyContourChildEdit = warning?.type === 'unsupported_prop'
        && isCompatibleKnownLegacyContourChildEdit(manifest, patch, knownEditLog);
      const compatibleDisappearingEdit = warning?.type === 'missing_gid'
        && isCompatibleKnownDisappearingEdit(patch, knownEditLog);
      const compatibleLegacyAxisFontEdit = warning?.type === 'unsupported_prop'
        && isCompatibleKnownLegacyAxisFontEdit(manifest, patch, knownEditLog);
      if (
        !compatibleLegacySpecialAxesEdit
        && !compatibleLegacyContourChildEdit
        && !compatibleDisappearingEdit
        && !compatibleLegacyAxisFontEdit
      ) {
        warnings.push(figureId ? { ...warning, figureId } : warning);
      }
    });
    const rejectedIndexes = new Set(
      warnings
        .map((warning: any) => warning.patchIndex)
        .filter((index: unknown): index is number => typeof index === 'number'),
    );
    return {
      ok: warnings.length === 0,
      warnings,
      rejected: patches.filter((_: any, index: number) => rejectedIndexes.has(index)),
    };
  }

  function collectRendererConflictWarnings(resultWarnings: any, patches: any[], figureId?: string) {
    const warnings: any[] = [];
    for (const patch of patches) {
      for (const warning of Array.isArray(resultWarnings) ? resultWarnings : []) {
        if (figureId && warning?.figureId && warning.figureId !== figureId) continue;
        if (isConflictWarningForPatch(warning, patch)) {
          warnings.push(warning);
        }
      }
    }
    return warnings;
  }

  function collectRendererReplayConflictsByFigure(
    resultWarnings: any,
    editLogs: Record<string, EditEntry[]>,
  ): Array<{ figureId: string; patch: EditEntry; warning: any }> {
    const conflicts: Array<{ figureId: string; patch: EditEntry; warning: any }> = [];
    const warnings = Array.isArray(resultWarnings) ? resultWarnings : [];
    for (const [figureId, patches] of Object.entries(editLogs)) {
      for (const patch of patches) {
        for (const warning of warnings) {
          if (warning?.figureId && warning.figureId !== figureId) continue;
          if (isConflictWarningForPatch(warning, patch)) {
            conflicts.push({ figureId, patch, warning });
          }
        }
      }
    }
    return conflicts;
  }

  function resolveDatasetAbsolutePath(storedPath: string): string {
    return safeResolveUnder(PROJECTS_ROOT, storedPath);
  }

  type WorkbookParseResult = {
    columns: string[];
    rowCount: number;
    rows?: any[];
  };

  const workbookParseCache = new Map<string, WorkbookParseResult>();
  const tabularQueue: Array<() => void> = [];
  let activeTabularJobs = 0;

  async function withTabularSlot<T>(task: () => Promise<T>): Promise<T> {
    const limit = boundedNumber(process.env.SCIFIGURE_TABULAR_CONCURRENCY, 2, 1, 4);
    if (activeTabularJobs >= limit) {
      await new Promise<void>(resolve => tabularQueue.push(resolve));
    }
    activeTabularJobs += 1;
    try {
      return await task();
    } finally {
      activeTabularJobs = Math.max(0, activeTabularJobs - 1);
      tabularQueue.shift()?.();
    }
  }

  async function parseWorkbookIsolated(
    filePath: string,
    mode: 'metadata' | 'records',
    options: { limit?: number; req?: express.Request } = {},
  ): Promise<WorkbookParseResult> {
    return withTabularSlot(async () => {
      const absPath = resolveDatasetAbsolutePath(filePath);
      const stat = await fs.promises.stat(absPath);
      const cacheKey = `${absPath}:${stat.size}:${stat.mtimeMs}:metadata`;
      if (mode === 'metadata') {
        const cached = workbookParseCache.get(cacheKey);
        if (cached) return cached;
      }

      const extension = path.extname(absPath).toLowerCase();
      if (extension !== '.xlsx' && extension !== '.xls') {
        throw new Error('仅支持解析 XLSX/XLS 文件');
      }

      const taskRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scifigure-tabular-task-'));
      const workDir = path.join(taskRoot, 'work');
      const stagedName = `input${extension}`;
      const stagedPath = path.join(workDir, stagedName);
      try {
        await fs.promises.chmod(taskRoot, 0o700);
        await fs.promises.mkdir(workDir, { mode: 0o755 });
        await fs.promises.chmod(workDir, 0o755);
        await fs.promises.copyFile(absPath, stagedPath);
        await fs.promises.chmod(stagedPath, 0o444);
      } catch (error) {
        await fs.promises.rm(taskRoot, { recursive: true, force: true });
        throw error;
      }
      const timeoutMs = boundedNumber(process.env.SCIFIGURE_TABULAR_TIMEOUT_MS, 30_000, 5_000, 120_000);
      const maxOutputMb = boundedNumber(process.env.SCIFIGURE_TABULAR_OUTPUT_MB, 24, 4, 64);
      const maxOutputBytes = maxOutputMb * 1024 * 1024;
      const requestedLimit = options.limit === undefined
        ? undefined
        : Math.floor(boundedNumber(options.limit, 500, 1, 100_000));
      let command: string;
      let args: string[];
      let containerName: string | null = null;

      if (rendererMode() === 'docker') {
        containerName = `scifigure-tabular-${randomUUID().replace(/-/g, '')}`;
        command = 'docker';
        args = [
          'run', '--rm', '--name', containerName,
          '--label', 'scifigure.managed=true', '--label', 'scifigure.kind=tabular',
          '--network', 'none', '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--user', '65532:65532',
          '--pids-limit', String(process.env.SCIFIGURE_TABULAR_PIDS || '64'),
          '--memory', String(process.env.SCIFIGURE_TABULAR_MEMORY || '512m'),
          '--cpus', String(process.env.SCIFIGURE_TABULAR_CPUS || '0.5'),
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
          '--mount', `type=bind,src=${dockerMountPath(workDir)},dst=/work,readonly`,
          process.env.SCIFIGURE_RENDERER_IMAGE || 'scifigure-renderer:latest',
          'python', '/opt/scifigure/renderer/tabular_parser.py',
          '--input', `/work/${stagedName}`,
          '--mode', mode,
        ];
      } else {
        command = resolvePythonBin();
        args = [
          path.join(process.cwd(), 'renderer', 'tabular_parser.py'),
          '--input', stagedPath,
          '--mode', mode,
        ];
      }
      if (requestedLimit !== undefined && mode === 'records') {
        args.push('--limit', String(requestedLimit));
      }
      const safetyLimits = mode === 'metadata' || requestedLimit !== undefined
        ? tabularInspectionLimits()
        : tabularSafetyLimits();
      const safetyArgStart = args.length;
      args.push(
        '--max-rows', String(safetyLimits.maxRows),
        '--max-columns', String(safetyLimits.maxColumns),
        '--max-cells', String(safetyLimits.maxCells),
        '--max-cell-chars', String(safetyLimits.maxCellChars),
        '--max-entries', String(boundedNumber(process.env.SCIFIGURE_XLSX_MAX_ENTRIES, 2_048, 32, 20_000)),
        '--max-uncompressed-bytes', String(
          boundedNumber(process.env.SCIFIGURE_XLSX_MAX_UNCOMPRESSED_MB, 256, 16, 2_048) * 1024 * 1024,
        ),
        '--max-compression-ratio', String(
          boundedNumber(process.env.SCIFIGURE_XLSX_MAX_COMPRESSION_RATIO, 200, 10, 1_000),
        ),
      );

      const forceRemoveContainer = () => {
        if (!containerName) return;
        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          env: buildProcessEnvForBin('docker'),
          windowsHide: true,
          timeout: 10_000,
        });
      };

      try {
        const runParserProcess = (parserArgs: string[]) => new Promise<any>((resolve, reject) => {
          const child = spawn(command, parserArgs, {
            cwd: workDir,
            env: buildProcessEnvForBin(command),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          let outputBytes = 0;
          let settled = false;
          let closed = false;
          const finishError = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.req?.removeListener('aborted', onAborted);
            reject(error);
          };
          const terminate = () => {
            forceRemoveContainer();
            if (!closed) child.kill('SIGKILL');
          };
          const onAborted = () => {
            terminate();
            finishError(new Error('表格解析请求已取消'));
          };
          const timer = setTimeout(() => {
            terminate();
            finishError(new Error(`表格解析超时 (${Math.round(timeoutMs / 1000)}s)`));
          }, timeoutMs);
          options.req?.once('aborted', onAborted);
          const capture = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
            if (settled) return;
            outputBytes += chunk.length;
            if (outputBytes > maxOutputBytes) {
              terminate();
              finishError(new Error(`表格解析输出超过 ${maxOutputMb} MB`));
              return;
            }
            if (kind === 'stdout') stdout += chunk.toString();
            else stderr += chunk.toString();
          };
          child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
          child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
          child.on('error', (error) => {
            terminate();
            finishError(new Error(`表格解析进程失败: ${error.message}`));
          });
          child.on('close', (code) => {
            closed = true;
            if (settled) return;
            if (code !== 0) {
              finishError(new Error(`表格解析进程退出码 ${code}: ${stderr.slice(0, 800)}`));
              return;
            }
            try {
              const value = JSON.parse(stdout || '{}');
              if (value.status !== 'success') {
                finishError(new Error(value.message || '表格解析失败'));
                return;
              }
              settled = true;
              clearTimeout(timer);
              options.req?.removeListener('aborted', onAborted);
              resolve(value);
            } catch (error: any) {
              finishError(new Error(`表格解析输出无效: ${error?.message || error}`));
            }
          });
        });

        let parsed: any;
        try {
          parsed = await runParserProcess(args);
        } catch (error: any) {
          const legacyParserMismatch = rendererMode() === 'docker'
            && /unrecognized arguments:.*--max-/is.test(String(error?.message || error));
          const canRetryLegacyParser = legacyParserMismatch
            && process.env.NODE_ENV !== 'production'
            && process.env.SCIFIGURE_ALLOW_LEGACY_TABULAR_PARSER === '1';
          if (!canRetryLegacyParser) {
            if (legacyParserMismatch) {
              const mismatch = new Error('表格解析镜像版本过旧，缺少资源限制参数；请使用与当前服务同一版本构建 renderer 镜像');
              (mismatch as any).statusCode = 503;
              throw mismatch;
            }
            throw error;
          }
          const legacyArgs = args.slice(0, safetyArgStart);
          containerName = `scifigure-tabular-${randomUUID().replace(/-/g, '')}`;
          const nameIndex = legacyArgs.indexOf('--name');
          if (nameIndex >= 0) legacyArgs[nameIndex + 1] = containerName;
          console.warn('[tabular] development-only legacy parser compatibility is active');
          parsed = await runParserProcess(legacyArgs);
        }

        const value: WorkbookParseResult = {
          columns: Array.isArray(parsed.columns) ? parsed.columns.map(String) : [],
          rowCount: Math.max(0, Number(parsed.row_count || 0)),
          rows: mode === 'records' && Array.isArray(parsed.rows) ? parsed.rows : undefined,
        };
        assertTabularShape(value.columns, value.rowCount);
        if (mode === 'metadata') {
          workbookParseCache.set(cacheKey, value);
          if (workbookParseCache.size > 4) {
            const oldestKey = workbookParseCache.keys().next().value;
            if (oldestKey) workbookParseCache.delete(oldestKey);
          }
        }
        return value;
      } finally {
        forceRemoveContainer();
        try { await fs.promises.rm(taskRoot, { recursive: true, force: true }); } catch { /* temp parser directory */ }
      }
    });
  }

  async function loadDatasetRows(filePath: string, limit?: number, req?: express.Request): Promise<any[]> {
    const absPath = resolveDatasetAbsolutePath(filePath);
    const ext = path.extname(absPath).toLowerCase();

    if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      const delimiter = ext === '.tsv' ? '\t' : ',';
      return loadDelimitedRows(absPath, delimiter, limit);
    }

    if (ext === '.xlsx' || ext === '.xls') {
      return (await parseWorkbookIsolated(absPath, 'records', { limit, req })).rows || [];
    }

    return [];
  }

  async function buildProjectDataPayload(datasets: DatasetEntry[]): Promise<Record<string, unknown> | null> {
    if (!datasets || datasets.length === 0) {
      return null;
    }

    const firstDataset = datasets[0];
    const inline = canInlineDataset(firstDataset.columns, firstDataset.rowCount);
    const customData = inline ? await loadDatasetRows(firstDataset.filePath) : [];
    return {
      custom_data: customData,
      inlineData: {
        status: inline ? 'included' : 'omitted',
        reason: inline ? null : 'safety_budget',
        rowCount: firstDataset.rowCount,
        columnCount: firstDataset.columns.length,
      },
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

  function sha256File(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }

  function captureExportDatasetSnapshots(datasets: DatasetEntry[]): {
    snapshots: ExportDatasetSnapshotV1[];
    warnings: string[];
  } {
    const snapshots: ExportDatasetSnapshotV1[] = [];
    const warnings: string[] = [];
    datasets.forEach(dataset => {
      const absPath = resolveDatasetAbsolutePath(dataset.filePath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        warnings.push(`未记录缺失的数据文件: ${dataset.fileName}`);
        return;
      }
      const stat = fs.statSync(absPath);
      snapshots.push({
        datasetId: dataset.datasetId,
        fileName: dataset.fileName,
        rowCount: dataset.rowCount,
        columns: [...dataset.columns],
        sizeBytes: stat.size,
        sha256: sha256File(absPath),
      });
    });
    return { snapshots, warnings };
  }

  function legacyReplaySignature(entry: any): string {
    return crypto.createHash('sha256').update(stableStringifyForExport({
      gid: String(entry?.gid || ''),
      prop: String(entry?.prop || ''),
      value: entry?.value,
    })).digest('hex');
  }

  function captureLegacyReplaySignatures(manifestValue: unknown, editLog: EditEntry[]): string[] {
    const manifest = parseManifestValue(manifestValue);
    if (!manifest) return [];
    const objectById = new Map<string, any>(
      manifest.objects.map((object: any) => [String(object?.id || ''), object] as const),
    );
    return Array.from(new Set(editLog.flatMap((entry: any) => {
      const object = objectById.get(String(entry?.gid || ''));
      const prop = String(entry?.prop || '');
      const editable = Array.isArray(object?.editable) ? object.editable.map(String) : [];
      const isVerifiedLegacyEdit = !Array.isArray(object?.propertyCapabilities)
        && editable.includes(prop)
        && isLegacyContourChildSnapshotEdit(object, prop);
      return isVerifiedLegacyEdit ? [legacyReplaySignature(entry)] : [];
    })));
  }

  function buildExportEditingSnapshot(args: {
    project: NonNullable<ReturnType<typeof getProject>>;
    userId: string;
    targetFigureId: string;
    targetEditLog: EditEntry[];
    datasets: ExportDatasetSnapshotV1[];
    requestedFormat: string;
    effectiveFormat: string;
    dpi: number | null;
  }): ExportEditingSnapshotV4 {
    const figureRows = listProjectFigures(args.project.id);
    const targetRow = figureRows.find(row => `fig_${row.figure_index + 1}` === args.targetFigureId);
    const targetSession = targetRow ? loadSession(targetRow.session_id, args.userId) : null;
    if (!targetSession) throw new Error(`无法记录 ${args.targetFigureId} 的导出编辑状态`);
    const scriptLanguage = inferScriptLanguage(targetSession.script);
    let projectSpec: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(args.project.spec || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) projectSpec = parsed;
    } catch {
      projectSpec = {};
    }
    projectSpec = { ...projectSpec, custom_script: targetSession.script, script_language: scriptLanguage };

    const figures = figureRows.map((row): ExportFigureSnapshotV4 => {
      const figureId = `fig_${row.figure_index + 1}`;
      const session = loadSession(row.session_id, args.userId);
      if (!session) throw new Error(`无法记录 ${figureId} 的导出编辑状态`);
      const editLog = compressEditLog(
        figureId === args.targetFigureId ? args.targetEditLog : session.editLog,
      );
      return {
        figureId,
        index: row.figure_index,
        sessionId: row.session_id,
        revision: session.revision || row.revision || 1,
        script: session.script,
        scriptLanguage: inferScriptLanguage(session.script),
        editLog,
        legacyReplaySignatures: captureLegacyReplaySignatures(row.manifest, editLog),
      };
    });
    if (!figures.some(figure => figure.figureId === args.targetFigureId)) {
      throw new Error(`导出状态中缺少目标 Figure: ${args.targetFigureId}`);
    }

    return {
      schemaVersion: EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      projectId: args.project.id,
      projectName: args.project.name,
      targetFigureId: args.targetFigureId,
      projectScript: targetSession.script,
      scriptLanguage,
      projectSpec,
      figures,
      datasets: args.datasets.map(dataset => ({ ...dataset, columns: [...dataset.columns] })),
      exportOptions: {
        requestedFormat: args.requestedFormat,
        effectiveFormat: args.effectiveFormat,
        dpi: args.dpi,
      },
    };
  }

  function findExportSnapshotDatasetIssues(
    expectedDatasets: ExportDatasetSnapshotV1[],
    currentDatasets: DatasetEntry[],
  ): string[] {
    const expectedById = new Map(expectedDatasets.map(dataset => [dataset.datasetId, dataset]));
    const currentById = new Map(currentDatasets.map(dataset => [dataset.datasetId, dataset]));
    const issues: string[] = [];
    currentDatasets.forEach(current => {
      const absPath = resolveDatasetAbsolutePath(current.filePath);
      if (
        !expectedById.has(current.datasetId)
        && fs.existsSync(absPath)
        && fs.statSync(absPath).isFile()
      ) {
        issues.push(`${current.fileName}: 导出后新增的数据文件`);
      }
    });
    expectedDatasets.forEach(expected => {
      const current = currentById.get(expected.datasetId);
      if (!current) {
        issues.push(`${expected.fileName}: 文件已删除或替换`);
        return;
      }
      const absPath = resolveDatasetAbsolutePath(current.filePath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        issues.push(`${expected.fileName}: 存储文件不存在`);
        return;
      }
      const stat = fs.statSync(absPath);
      if (stat.size !== expected.sizeBytes || sha256File(absPath) !== expected.sha256) {
        issues.push(`${expected.fileName}: 文件内容已变化`);
      }
    });
    return issues;
  }

  type ExportSnapshotReplayIssue = {
    type: string;
    figureId?: string;
    gid?: string;
    prop?: string;
    message: string;
    warning?: unknown;
  };

  function snapshotManifestObject(manifest: any, gid: string): any | null {
    if (!manifest || !Array.isArray(manifest.objects)) return null;
    return manifest.objects.find((object: any) => String(object?.id || '') === gid) || null;
  }

  const LEGACY_CONTOUR_CHILD_REPLAY_PROPS = new Set([
    'facecolor',
    'edgecolor',
    'alpha',
    'linewidth',
    'size',
    'size_scale',
    'zorder',
  ]);

  function isLegacyContourChildSnapshotEdit(object: any, prop: string): boolean {
    const parentId = object?.parentId || object?.identity?.relation?.parentId;
    return object?.kind === 'collection'
      && object?.role === 'contour_child_collection'
      && typeof parentId === 'string'
      && /^container\.contourf?\./.test(parentId)
      && LEGACY_CONTOUR_CHILD_REPLAY_PROPS.has(prop);
  }

  function isCompatibleContourChildSnapshotFingerprint(entry: any, object: any, prop: string): boolean {
    const entrySeriesKey = entry?.identity?.seriesKey;
    const objectSeriesKey = object?.identity?.seriesKey;
    return isLegacyContourChildSnapshotEdit(object, prop)
      && entry?.stableKey !== undefined
      && entrySeriesKey !== undefined
      && entry.stableKey === object?.stableKey
      && entrySeriesKey === objectSeriesKey;
  }

  function isCompatibleLegacySpecialAxesSnapshotIdentity(
    snapshotSchemaVersion: number,
    entry: any,
    object: any,
  ): boolean {
    return snapshotSchemaVersion <= SCRIPTED_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
      && !hasSpecialAxesMetadata(entry?.identity)
      && typeof entry?.stableKey === 'string'
      && entry.stableKey === object?.stableKey
      && entry?.fingerprintVersion === 2
      && object?.fingerprintVersion === 2
      && typeof entry?.fingerprint === 'string'
      && entry.fingerprint === object?.fingerprint;
  }

  function validateSnapshotEditLogAgainstManifest(
    figureId: string,
    manifest: any,
    editLog: unknown,
    snapshotSchemaVersion: number,
    legacyReplaySignatures: readonly string[] = [],
  ): ExportSnapshotReplayIssue[] {
    const issues: ExportSnapshotReplayIssue[] = [];
    if (!Array.isArray(editLog)) {
      return [{
        type: 'malformed_edit_log',
        figureId,
        message: `${figureId} 快照 editLog 不是数组。`,
      }];
    }

    const globals = manifest?.globals && typeof manifest.globals === 'object'
      ? manifest.globals
      : {};
    editLog.forEach((entry: any, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push({
          type: 'malformed_edit',
          figureId,
          message: `${figureId} 快照第 ${index + 1} 条编辑不是对象。`,
        });
        return;
      }

      const gid = typeof entry.gid === 'string' ? entry.gid : '';
      const prop = typeof entry.prop === 'string' ? entry.prop : '';
      if (!gid || !prop) {
        issues.push({
          type: 'malformed_edit',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照第 ${index + 1} 条编辑缺少 gid 或 prop。`,
        });
        return;
      }

      if (entry.type === 'code_patch') {
        issues.push({
          type: 'unsupported_code_patch',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照包含无法在恢复阶段安全重放的 code patch。`,
        });
        return;
      }

      if (gid === 'global') {
        if (!Object.prototype.hasOwnProperty.call(globals, prop)) {
          issues.push({
            type: 'unsupported_prop',
            figureId,
            gid,
            prop,
            message: `${figureId} 快照引用了当前 renderer 未声明的全局属性 ${prop}。`,
          });
        }
        return;
      }

      if (isDurableVirtualEditGid(gid)) {
        if (!PATCH_VIRTUAL_FONT_CENTER_PROPS.has(prop)) {
          issues.push({
            type: 'unsupported_prop',
            figureId,
            gid,
            prop,
            message: `${figureId} 快照引用了不支持的虚拟字体属性 ${gid}.${prop}。`,
          });
        }
        return;
      }

      const object = snapshotManifestObject(manifest, gid);
      if (!object) {
        issues.push({
          type: 'missing_gid',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照目标 ${gid} 不存在，已停止恢复。`,
        });
        return;
      }

      const capability = Array.isArray(object.propertyCapabilities)
        ? object.propertyCapabilities.find((item: any) => item?.prop === prop)
        : undefined;
      const editable = Array.isArray(object.editable) ? object.editable : [];
      const hasAuthoritativeCapabilities = Array.isArray(object.propertyCapabilities);
      const capabilityScopes = Array.isArray(capability?.scopes) ? capability.scopes.map(String) : [];
      const legacyContourChildReplay = isLegacyContourChildSnapshotEdit(object, prop)
        && (
          snapshotSchemaVersion <= PRE_CAPABILITY_AUTHORITY_EXPORT_EDITING_SNAPSHOT_SCHEMA_VERSION
          || legacyReplaySignatures.includes(legacyReplaySignature(entry))
        );
      if (
        !legacyContourChildReplay
        && (
          (capability && (capability.replay === 'unsupported' || !capabilityScopes.includes('object')))
          || (!capability && (hasAuthoritativeCapabilities || !editable.includes(prop)))
        )
      ) {
        issues.push({
          type: 'unsupported_prop',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照目标 ${gid}.${prop} 当前不可重放。`,
        });
        return;
      }

      if (entry.stableKey !== undefined && object.stableKey !== undefined && entry.stableKey !== object.stableKey) {
        issues.push({
          type: 'identity_mismatch',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照目标 ${gid} 的 stableKey 已变化。`,
        });
        return;
      }
      if (
        entry.fingerprintVersion === 2
        && object.fingerprintVersion === 2
        && entry.fingerprint !== undefined
        && object.fingerprint !== undefined
        && entry.fingerprint !== object.fingerprint
        && !isCompatibleContourChildSnapshotFingerprint(entry, object, prop)
      ) {
        issues.push({
          type: 'identity_mismatch',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照目标 ${gid} 的结构 fingerprint 已变化。`,
        });
        return;
      }
      const entrySeriesKey = entry.identity?.seriesKey;
      const objectSeriesKey = object.identity?.seriesKey;
      if (entrySeriesKey !== undefined && objectSeriesKey !== undefined && entrySeriesKey !== objectSeriesKey) {
        issues.push({
          type: 'identity_mismatch',
          figureId,
          gid,
          prop,
          message: `${figureId} 快照目标 ${gid} 的 seriesKey 已变化。`,
        });
        return;
      }
      if (requiresDiagramRelationIdentity(object)) {
        const expectedRelation = diagramRelationSignature(object.identity);
        const snapshotRelation = diagramRelationSignature(entry.identity);
        if (expectedRelation === null || snapshotRelation !== expectedRelation) {
          issues.push({
            type: 'identity_mismatch',
            figureId,
            gid,
            prop,
            message: `${figureId} 快照目标 ${gid} 的图示关系身份已变化或缺失。`,
          });
        }
      }
      if (requiresSpecialAxesRelationIdentity(object)) {
        const expectedRelation = specialAxesRelationSignature(object.identity);
        const snapshotRelation = specialAxesRelationSignature(entry.identity);
        const legacyIdentityCompatible = isCompatibleLegacySpecialAxesSnapshotIdentity(
          snapshotSchemaVersion,
          entry,
          object,
        );
        if (
          expectedRelation === null
          || (snapshotRelation !== expectedRelation && !legacyIdentityCompatible)
        ) {
          issues.push({
            type: 'identity_mismatch',
            figureId,
            gid,
            prop,
            message: `${figureId} 快照目标 ${gid} 的特殊坐标轴关系身份已变化或缺失。`,
          });
        }
      }
    });
    return issues;
  }

  function isSnapshotReplayWarning(warning: any): boolean {
    if (warning && typeof warning === 'object') {
      const type = String(warning.type || '').toLowerCase();
      return type === 'missing_gid'
        || type === 'identity_mismatch'
        || type === 'unsupported_prop'
        || type === 'no_setter'
        || type.startsWith('unsupported_')
        || type.startsWith('apply_error:');
    }
    if (typeof warning !== 'string') return false;
    return /(unsupported|ignored|could not|cannot|failed|missing|not found|identity|ambiguous|不支持|忽略|无法|失败|缺失|不存在|身份|歧义)/i.test(warning);
  }

  async function dryRunExportEditingSnapshot(args: {
    snapshot: ExportEditingSnapshot;
    projectId: string;
    req: express.Request;
  }): Promise<{ ok: boolean; issues: ExportSnapshotReplayIssue[] }> {
    const issues: ExportSnapshotReplayIssue[] = [];
    let datasets: DatasetEntry[];
    let dataPayload: Record<string, unknown> | null;
    try {
      datasets = listProjectFiles(args.projectId);
      dataPayload = await buildProjectDataPayload(datasets);
    } catch (error: any) {
      return {
        ok: false,
        issues: [{
          type: 'renderer_data_error',
          message: `快照 renderer 数据准备失败: ${error?.message || String(error)}`,
        }],
      };
    }

    const uploadedFilePaths: Record<string, string> = {};
    datasets.forEach(dataset => addUploadedFilePathAliases(uploadedFilePaths, dataset.fileName, dataset.filePath));
    const filesDir = projectFilesDir(args.projectId);
    const cwd = fs.existsSync(filesDir) && fs.statSync(filesDir).isDirectory()
      ? filesDir.replace(/\\/g, '/')
      : undefined;
    const figures = args.snapshot.figures;
    const groups = new Map<string, Array<ExportFigureSnapshotV1 | ExportFigureSnapshotV2>>();
    figures.forEach(figure => {
      const script = 'script' in figure ? figure.script : args.snapshot.projectScript;
      const language = 'scriptLanguage' in figure ? figure.scriptLanguage : args.snapshot.scriptLanguage;
      const key = `${language}\u0000${script}`;
      const group = groups.get(key) || [];
      group.push(figure);
      groups.set(key, group);
    });

    for (const group of groups.values()) {
      const first = group[0];
      const script = 'script' in first ? first.script : args.snapshot.projectScript;
      const language = 'scriptLanguage' in first ? first.scriptLanguage : args.snapshot.scriptLanguage;
      if (language === 'r' && group.length !== 1) {
        issues.push({
          type: 'unsupported_r_multi_figure',
          figureId: first.figureId,
          message: '当前 R renderer 只能验证单 Figure 快照，已停止恢复该多 Figure R 状态。',
        });
        continue;
      }
      let result: any;
      try {
        if (language === 'python') {
          const editLogs: Record<string, EditEntry[]> = {};
          group.forEach(figure => {
            editLogs[figure.figureId] = compressEditLog(figure.editLog || []);
          });
          result = await spawnPythonWithPayload('introspector.py', {
            script,
            dataPayload,
            cwd,
            uploaded_file_paths: uploadedFilePaths,
            editLogs,
            renderOptions: { dpi: 150 },
          }, { req: args.req, label: 'export-snapshot-dry-run' });
        } else {
          // The R renderer currently returns one ggplot Figure per invocation.
          result = await spawnRWithPayload({
            script,
            dataPayload,
            cwd,
            uploaded_file_paths: prepareUploadedFilePathsForR(uploadedFilePaths, filesDir),
            editLog: compressEditLog(first.editLog || []),
            renderOptions: { width_in: 7, height_in: 5 },
          }, { req: args.req, label: 'export-snapshot-r-dry-run' });
        }
      } catch (error: any) {
        issues.push({
          type: 'renderer_error',
          figureId: first.figureId,
          message: `${first.figureId} 快照 renderer 执行失败: ${error?.message || String(error)}`,
        });
        continue;
      }

      if (!result || result.status !== 'success') {
        issues.push({
          type: 'renderer_error',
          figureId: first.figureId,
          message: `${first.figureId} 快照 renderer 未成功完成: ${result?.message || '未知错误'}`,
        });
        continue;
      }

      const renderedFigures = language === 'r'
        ? [{ figureId: first.figureId, manifest: result.manifest }]
        : (Array.isArray(result.figures) ? result.figures : []);
      for (const figure of group) {
        const rendered = renderedFigures.find((candidate: any) => candidate?.figureId === figure.figureId)
          || (group.length === 1 ? renderedFigures[0] : null);
        if (!rendered?.manifest) {
          issues.push({
            type: 'figure_missing',
            figureId: figure.figureId,
            message: `${figure.figureId} 快照 renderer 没有返回可验证的 Figure manifest。`,
          });
          continue;
        }

        issues.push(...validateSnapshotEditLogAgainstManifest(
          figure.figureId,
          rendered.manifest,
          figure.editLog,
          args.snapshot.schemaVersion,
          Array.isArray((figure as any).legacyReplaySignatures)
            ? (figure as any).legacyReplaySignatures
            : [],
        ));

        const figureWarnings = (Array.isArray(result.warnings) ? result.warnings : [])
          .filter((warning: any) => !warning?.figureId || warning.figureId === figure.figureId)
          .filter(isSnapshotReplayWarning);
        figureWarnings.forEach((warning: any) => {
          issues.push({
            type: typeof warning === 'object' ? String(warning.type || 'renderer_warning') : 'renderer_warning',
            figureId: figure.figureId,
            gid: typeof warning === 'object' && typeof warning.gid === 'string' ? warning.gid : undefined,
            prop: typeof warning === 'object' && typeof warning.prop === 'string' ? warning.prop : undefined,
            message: `${figure.figureId} 快照 renderer 拒绝或无法确认一项编辑。`,
            warning,
          });
        });
      }
    }

    return { ok: issues.length === 0, issues };
  }

  interface CompositionProjectSourceInput {
    projectId?: unknown;
    figureId?: unknown;
    codeSlice?: {
      code?: unknown;
      title?: unknown;
      startLine?: unknown;
      endLine?: unknown;
      confidence?: unknown;
      mode?: unknown;
      reason?: unknown;
    } | null;
  }

  interface ResolvedCompositionSource {
    projectId: string;
    projectName: string;
    figureId: string;
    figureIndex: number;
    script: string;
    language: 'python' | 'r';
    editLog: EditEntry[];
    revision: number;
    codeSlice: any | null;
    datasets: DatasetEntry[];
  }

  function normalizeCompositionSources(body: any, fallbackProjectId?: string): CompositionProjectSourceInput[] {
    if (Array.isArray(body?.sources)) {
      return body.sources;
    }
    const figureIds = Array.isArray(body?.figureIds) ? body.figureIds : [];
    if (fallbackProjectId && figureIds.length > 0) {
      return figureIds.map((figureId: unknown) => ({ projectId: fallbackProjectId, figureId }));
    }
    return [];
  }

  function parseFigureIdIndex(figureId: string): number {
    const match = /^fig_(\d+)$/.exec(figureId);
    if (!match) {
      throw new Error(`无效的 Figure ID: ${figureId}`);
    }
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`无效的 Figure ID: ${figureId}`);
    }
    return index;
  }

  function resolveCompositionSources(rawSources: CompositionProjectSourceInput[], userId: string): ResolvedCompositionSource[] {
    if (!Array.isArray(rawSources) || rawSources.length === 0) {
      throw new Error('请至少选择一张 Figure');
    }
    if (rawSources.length > 24) {
      throw new Error('一次最多选择 24 张 Figure 创建组合代码项目');
    }

    const seen = new Set<string>();
    return rawSources.map((raw) => {
      const projectId = String(raw?.projectId || '').trim();
      const figureId = String(raw?.figureId || '').trim();
      assertSafeProjectId(projectId);
      const figureIndex = parseFigureIdIndex(figureId);
      const key = `${projectId}:${figureId}`;
      if (seen.has(key)) {
        throw new Error(`重复选择了 ${projectId}/${figureId}`);
      }
      seen.add(key);

      const project = getProject(projectId, userId);
      if (!project) {
        throw new Error(`源项目不存在: ${projectId}`);
      }
      const figRow = listProjectFigures(projectId).find(row => Number(row.figure_index) === figureIndex);
      if (!figRow) {
        throw new Error(`源项目 ${project.name} 中不存在 ${figureId}`);
      }
      const session = loadSession(figRow.session_id, userId);
      const projectScript = project.script || (() => {
        try {
          const spec = JSON.parse(project.spec || '{}');
          return spec.custom_script || spec.script || '';
        } catch {
          return '';
        }
      })();
      const script = session?.script || projectScript || '';
      if (!script) {
        throw new Error(`源项目 ${project.name}/${figureId} 没有可用于转写的脚本`);
      }
      const datasets = listProjectFiles(projectId);
      const availableFiles = new Set(datasets.map(dataset => String(dataset.fileName || '').toLocaleLowerCase()));
      const missingFiles = extractScriptDataFileNames(script).filter(fileName => !availableFiles.has(fileName.toLocaleLowerCase()));
      if (missingFiles.length > 0) {
        throw new Error(`源项目 ${project.name}/${figureId} 缺少脚本所需数据文件: ${missingFiles.join(', ')}`);
      }

      const clientCodeSlice = raw?.codeSlice && typeof raw.codeSlice === 'object' && typeof raw.codeSlice.code === 'string'
        ? {
            figureId,
            title: typeof raw.codeSlice.title === 'string' ? raw.codeSlice.title : `${figureId} 代码片段`,
            startLine: Number(raw.codeSlice.startLine || 0),
            endLine: Number(raw.codeSlice.endLine || 0),
            code: raw.codeSlice.code,
            confidence: typeof raw.codeSlice.confidence === 'string' ? raw.codeSlice.confidence : 'client',
            mode: typeof raw.codeSlice.mode === 'string' ? raw.codeSlice.mode : 'client_slice',
            reason: typeof raw.codeSlice.reason === 'string' ? raw.codeSlice.reason : 'frontend-provided codeSlice',
          }
        : null;

      return {
        projectId,
        projectName: project.name,
        figureId,
        figureIndex,
        script,
        language: inferScriptLanguage(script),
        editLog: session?.editLog || [],
        revision: session?.revision || figRow.revision || 1,
        codeSlice: clientCodeSlice,
        datasets,
      };
    });
  }

  function copyCompositionProjectFiles(targetProjectId: string, sources: ResolvedCompositionSource[]) {
    const targetDir = projectFilesDir(targetProjectId);
    fs.mkdirSync(targetDir, { recursive: true });
    const copied: Array<{
      sourceProjectId: string;
      sourceProjectName: string;
      sourceDatasetId: string;
      sourceFileName: string;
      copiedDatasetId: string;
      copiedFileName: string;
      columns: string[];
      rowCount: number;
    }> = [];
    const copiedBySourcePath = new Map<string, string>();

    sources.forEach((source) => {
      source.datasets.forEach((dataset) => {
        const sourceAbs = resolveDatasetAbsolutePath(dataset.filePath);
        if (!fs.existsSync(sourceAbs)) return;

        const sourceKey = sourceAbs.toLowerCase();
        if (copiedBySourcePath.has(sourceKey)) return;

        const ext = path.extname(dataset.fileName || path.basename(sourceAbs));
        const base = path.basename(dataset.fileName || path.basename(sourceAbs), ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') || 'dataset';
        const copiedDatasetId = randomUUID();
        const copiedFileName = `${source.projectName.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}_${base}_${copiedDatasetId.slice(0, 8)}${ext}`;
        const destAbs = safeResolveUnder(targetDir, path.join(targetDir, copiedFileName));
        fs.copyFileSync(sourceAbs, destAbs);
        const storedPath = path.relative(process.cwd(), destAbs).replace(/\\/g, '/');
        addProjectFile(copiedDatasetId, targetProjectId, copiedFileName, storedPath, dataset.columns || [], dataset.rowCount || 0);
        copiedBySourcePath.set(sourceKey, copiedDatasetId);
        copied.push({
          sourceProjectId: source.projectId,
          sourceProjectName: source.projectName,
          sourceDatasetId: dataset.datasetId,
          sourceFileName: dataset.fileName,
          copiedDatasetId,
          copiedFileName,
          columns: dataset.columns || [],
          rowCount: dataset.rowCount || 0,
        });
      });
    });

    return copied;
  }

  function makeCompositionScaffold(language: 'python' | 'r', targetAxesWidthIn: number, targetAxesHeightIn: number): string {
    if (language === 'r') {
      return [
        '# language: r',
        '# 组合代码项目脚手架：请把下方 AI 提示词交给网页 AI，让它基于源代码与已复制数据重写组合图代码。',
        '# 要求：组合后的每个子图绘图区尺寸保持一致。',
        `target_axes_width_in <- ${targetAxesWidthIn}`,
        `target_axes_height_in <- ${targetAxesHeightIn}`,
        '',
        '# TODO: paste AI-generated R code here.',
      ].join('\n');
    }
    return [
      '# Composition code project scaffold.',
      '# Paste the web-AI rewritten Matplotlib code below.',
      '# Requirement: every subplot axes box must have the same physical size.',
      `TARGET_AXES_WIDTH_IN = ${targetAxesWidthIn}`,
      `TARGET_AXES_HEIGHT_IN = ${targetAxesHeightIn}`,
      '',
      '# TODO: paste AI-generated Python code here.',
    ].join('\n');
  }

  function makePanelLabelInstruction(count: number): string {
    const safeCount = Math.max(0, Math.min(26, Math.floor(count)));
    if (safeCount <= 1) {
      return '- Panel labels: only one source figure is selected, so do not force multi-panel labels. Add a single `(a)` label only if the final figure needs a visible panel tag for manuscript consistency.';
    }
    const labels = Array.from({ length: safeCount }, (_, index) => `(${String.fromCharCode(97 + index)})`).join(', ');
    return `- Add exactly ${safeCount} panel labels in reading order: ${labels}. Do not add extra labels beyond the selected source figures.`;
  }

  function makePanelPlacementInstruction(sources: ResolvedCompositionSource[], layout: string): string {
    const match = String(layout || '').match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    const cols = match ? Math.max(1, Number(match[2])) : Math.max(1, sources.length);
    const placements = sources.map((source, index) => {
      const label = `(${String.fromCharCode(97 + Math.min(index, 25))})`;
      const row = Math.floor(index / cols) + 1;
      const col = (index % cols) + 1;
      return `- ${label}: Source ${index + 1} (${source.projectName} / ${source.figureId}) -> row ${row}, column ${col}`;
    });
    return ['Panel placement plan (follow this exact order and position):', ...placements].join('\n');
  }

  function extractScriptDataFileNames(script: string): string[] {
    const names = new Set<string>();
    const patterns = [
      /_uploaded_file_paths\s*\[\s*["']([^"']+)["']\s*\]/g,
      /uploaded_file_paths\s*\[\[\s*["']([^"']+)["']\s*\]\]/g,
      /(?:read_csv|read_table|read_excel|read\.csv|read\.table|readxl::read_excel)\s*\(\s*["']([^"']+)["']/g,
    ];
    patterns.forEach(pattern => {
      for (const match of script.matchAll(pattern)) {
        const name = String(match[1] || '').replace(/\\/g, '/').split('/').pop() || '';
        if (/\.(csv|tsv|txt|xlsx|xls)$/i.test(name)) names.add(name);
      }
    });
    return Array.from(names);
  }

  function summarizeFigureForPicker(manifest: any, svg: string | null | undefined) {
    const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
    const subplotIds = new Set<string>();
    objects.forEach((object: any) => {
      if (object?.kind === 'subplot' && object?.id) subplotIds.add(String(object.id));
      else if (object?.subplotId) subplotIds.add(String(object.subplotId));
    });
    const viewBox = svg ? parseSvgViewBox(svg) : null;
    return {
      subplotCount: subplotIds.size,
      aspectRatio: viewBox?.height ? Number((viewBox.width / viewBox.height).toFixed(3)) : undefined,
      hasLegend: objects.some((object: any) => String(object?.kind || '').includes('legend') || String(object?.role || '').includes('legend')),
      hasColorbar: objects.some((object: any) => String(object?.kind || '').includes('colorbar') || String(object?.role || '').includes('colorbar')),
    };
  }

  function buildCompositionPrompt(args: {
    sources: ResolvedCompositionSource[];
    copiedFiles: ReturnType<typeof copyCompositionProjectFiles>;
    targetAxesWidthIn: number;
    targetAxesHeightIn: number;
    layout: string;
    language: 'python' | 'r';
  }): string {
    const panelLabelInstruction = makePanelLabelInstruction(args.sources.length);
    const panelPlacementInstruction = makePanelPlacementInstruction(args.sources, args.layout);
    const isRTarget = args.language === 'r';
    const languageRequirements = isRTarget
      ? [
          '- Keep the final script in R. Do not translate the composition to Python or Matplotlib.',
          '- Build each source panel as a ggplot object, convert it with `ggplot2::ggplotGrob()`, and set every `^panel` row and column to the required physical size with `grid::unit()` before arranging the grobs.',
          '- Do not use only `theme(aspect.ratio=...)`, `coord_fixed()`, `par(mfrow=...)`, or relative patchwork widths/heights as a substitute for physical panel dimensions.',
          '- In a multi-file project, load each required file explicitly by exact copied filename through `uploaded_file_paths[["filename.csv"]]` or `uploaded_file_paths[["filename.xlsx"]]`.',
          '- Do not use `setwd`, absolute paths, historical project directories, Desktop/OneDrive paths, network paths, shell commands, system calls, sockets, or files not listed below.',
        ]
      : [
          '- Use the explicit `fig.add_axes([...])` helper below for the final combined figure. Do not replace it with `plt.subplots`, `GridSpec`, `subplots_adjust`, `tight_layout`, or `constrained_layout` for the final combined figure, because those APIs make physical axes-box size ambiguous.',
          '- In a multi-file project, do not use `_uploaded_data` to guess the active dataset. Always load each required file explicitly by exact copied filename through `_uploaded_file_paths["filename.csv"]` or `_uploaded_file_paths["filename.xlsx"]`.',
          '- Do not use `__file__`, `Path(__file__)`, `Path(...).resolve().parents[...]`, local absolute paths, historical project directories, Desktop/OneDrive paths, network paths, or any file that is not listed as copied data below.',
          '- Do not import or call `shutil`, `shutil.copy`, `shutil.copy2`, `open`, `os`, `sys`, `subprocess`, `requests`, `urllib`, `eval`, or `exec`. Remove any original preserve/copy/archive/save-note logic; this script is only allowed to read uploaded data and draw figures.',
          '- Preserve every existing `_scifigure_semantic_gid(...)` declaration and its exact diagram/node/edge/object identifiers when a source is a network, path, or SEM figure. Do not infer new relations from color, label, draw order, or screen position, and do not alter coefficients, p values, significance, fit indices, direction, or topology.',
        ];
    const dataValidationInstruction = isRTarget
      ? '- Before plotting, assert that every loaded data frame contains the columns required by that panel; if not, stop with an error naming the filename and missing columns.'
      : '- Before plotting, assert that every loaded DataFrame contains the columns required by that panel; if not, raise an error naming the filename and missing columns.';
    const layoutHelper = isRTarget
      ? [
          'Use this exact R panel-sizing helper for the final combined figure:',
          '```r',
          'set_equal_panel_size <- function(plot, panel_w, panel_h) {',
          '  grob <- ggplot2::ggplotGrob(plot)',
          '  panel_cells <- grepl("^panel", grob$layout$name)',
          '  panel_rows <- unique(grob$layout$t[panel_cells])',
          '  panel_cols <- unique(grob$layout$l[panel_cells])',
          '  grob$widths[panel_cols] <- grid::unit(panel_w, "in")',
          '  grob$heights[panel_rows] <- grid::unit(panel_h, "in")',
          '  grob',
          '}',
          '```',
          '',
          'Apply `set_equal_panel_size()` to every source plot, then arrange the resulting grobs in the exact requested rows and columns. Legends and colorbars may expand the outer grob, but must not resize the panel cells.',
        ]
      : [
          'Use this exact Matplotlib layout helper for the final combined figure:',
          '```python',
          'def make_equal_axes_figure(nrows, ncols, ax_w, ax_h, left=0.7, right=0.3, bottom=0.55, top=0.35, wspace=0.45, hspace=0.45):',
          '    fig_w = left + ncols * ax_w + (ncols - 1) * wspace + right',
          '    fig_h = bottom + nrows * ax_h + (nrows - 1) * hspace + top',
          '    fig = plt.figure(figsize=(fig_w, fig_h))',
          '    axes = []',
          '    for r in range(nrows):',
          '        for c in range(ncols):',
          '            x = (left + c * (ax_w + wspace)) / fig_w',
          '            y = (bottom + (nrows - 1 - r) * (ax_h + hspace)) / fig_h',
          '            axes.append(fig.add_axes([x, y, ax_w / fig_w, ax_h / fig_h]))',
          '    return fig, axes',
          '```',
          '',
          'Important: for the final combined figure, draw into the `axes` returned by `make_equal_axes_figure`. Do not call `fig.tight_layout()` or `plt.tight_layout()` afterward.',
        ];
    const sourceSections = args.sources.map((source, index) => {
      const preferredCode = source.codeSlice?.code || source.script;
      const confidence = source.codeSlice
        ? `${source.codeSlice.confidence || 'unknown'} / ${source.codeSlice.mode || 'unknown'}`
        : 'fallback: full source project script';
      const files = args.copiedFiles
        .filter(file => file.sourceProjectId === source.projectId)
        .map(file => `- ${file.sourceFileName} -> ${file.copiedFileName}; columns=${(file.columns || []).join(', ')}; rows=${file.rowCount}`)
        .join('\n') || '- 无上传数据文件';
      return [
        `## Source ${index + 1}: ${source.projectName} / ${source.figureId}`,
        `- sourceProjectId: ${source.projectId}`,
        `- language: ${source.language}`,
        `- revision: ${source.revision}`,
        `- codeSlice: ${confidence}`,
        '',
        '### Copied data files available in the new project',
        files,
        '',
        '### Source plotting code',
        '```' + (source.language === 'r' ? 'r' : 'python'),
        preferredCode.trim(),
        '```',
      ].join('\n');
    }).join('\n\n');

    const fileList = args.copiedFiles.map(file => (
      `- ${file.copiedFileName}: copied from ${file.sourceProjectName}/${file.sourceFileName}; columns=${(file.columns || []).join(', ')}; rows=${file.rowCount}`
    )).join('\n') || '- No uploaded data files were copied.';

    return [
      '# Task: rewrite selected scientific figures into one combined subplot script',
      '',
      'You are rewriting plotting code for SciFigure Studio. Use the copied data files in the new project. Do not invent columns, do not change data meaning, and do not fabricate trends, statistics, labels, or significance marks.',
      '',
      `Target language: ${args.language === 'r' ? 'R' : 'Python / Matplotlib'}`,
      `Target layout: ${args.layout}`,
      `Required axes box size: ${args.targetAxesWidthIn} in × ${args.targetAxesHeightIn} in for every subplot.`,
      '',
      'Hard requirements:',
      '- Create one final multi-panel figure containing all selected source figures.',
      '- Keep each subplot data axes box physically identical in width and height.',
      '- It is acceptable for the outer canvas to grow to fit labels, legends, and colorbars.',
      ...languageRequirements,
      '- Preserve source data transformations and plotted variables.',
      '- Use only copied data files listed below.',
      dataValidationInstruction,
      '- If a source uses only inline data, preserve that inline data exactly.',
      panelLabelInstruction,
      panelPlacementInstruction,
      '- Return runnable code only, with concise comments where needed.',
      '',
      'Copied data files in the new project:',
      fileList,
      '',
      ...layoutHelper,
      '',
      sourceSections,
    ].join('\n');
  }

  function createCompositionCodeProject(body: any, userId: string, fallbackProjectId?: string) {
    const rawSources = normalizeCompositionSources(body, fallbackProjectId);
    const sources = resolveCompositionSources(rawSources, userId);
    const targetAxesWidthIn = Math.max(0.5, Math.min(12, Number(body?.targetAxesWidthIn || 2.2)));
    const targetAxesHeightIn = Math.max(0.5, Math.min(12, Number(body?.targetAxesHeightIn || 2.2)));
    const requestedLayout = typeof body?.layout === 'string' && body.layout.trim() ? body.layout.trim() : 'auto';
    if (requestedLayout.toLowerCase() !== 'auto' && !/^\d+\s*[x×]\s*\d+$/i.test(requestedLayout)) {
      throw new Error('布局格式必须为 auto 或 rows×cols，例如 2x3');
    }
    const layoutPlan = planCompositionLayout({
      count: sources.length,
      requestedLayout,
      axesWidthIn: targetAxesWidthIn,
      axesHeightIn: targetAxesHeightIn,
    });
    const normalizedRequestedLayout = requestedLayout.replace(/×/g, 'x').replace(/\s+/g, '').toLowerCase();
    if (normalizedRequestedLayout !== 'auto' && layoutPlan.layoutKey !== normalizedRequestedLayout) {
      throw new Error(`布局 ${requestedLayout} 无法容纳 ${sources.length} 张 Figure`);
    }
    const layout = layoutPlan.layoutKey;
    const requestedName = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : '';
    const allLanguages = new Set(sources.map(source => source.language));
    const language: 'python' | 'r' = allLanguages.size === 1 && allLanguages.has('r') ? 'r' : 'python';
    const targetProjectId = randomUUID();
    const targetName = requestedName || `组合代码项目 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    const scaffold = makeCompositionScaffold(language, targetAxesWidthIn, targetAxesHeightIn);
    const spec = {
      plot_type: 'custom',
      script_language: language,
      custom_script: scaffold,
      script: scaffold,
      composition: {
        kind: 'code_composition_project',
        targetAxesWidthIn,
        targetAxesHeightIn,
        layout,
        sources: sources.map(source => ({
          projectId: source.projectId,
          projectName: source.projectName,
          figureId: source.figureId,
          revision: source.revision,
          language: source.language,
          codeSliceAvailable: Boolean(source.codeSlice),
        })),
      },
    };

    createProject(targetProjectId, userId, targetName, spec);
    updateProject(targetProjectId, userId, targetName, spec, scaffold);
    const copiedFiles = copyCompositionProjectFiles(targetProjectId, sources);
    const prompt = buildCompositionPrompt({
      sources,
      copiedFiles,
      targetAxesWidthIn,
      targetAxesHeightIn,
      layout,
      language,
    });

    return {
      status: 'success',
      projectId: targetProjectId,
      projectName: targetName,
      language,
      prompt,
      sourceFigures: sources.map(source => ({
        projectId: source.projectId,
        projectName: source.projectName,
        figureId: source.figureId,
        revision: source.revision,
        language: source.language,
        usedCodeSlice: Boolean(source.codeSlice),
      })),
      copiedFiles,
    };
  }

  // POST /api/figure/render — introspection-based render
  app.post('/api/figure/render', renderRateLimit, deploymentJobHandler('render', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      let { script, dataPayload, editLog, renderOptions } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);
      const language = inferScriptLanguage(script, req.body.language || req.body.scriptLanguage);

      const existingSession = req.body.sessionId ? loadSession(req.body.sessionId, userId) : null;
      const effectiveDataPayload = dataPayload !== undefined
        ? dataPayload
        : existingSession?.dataPayload || null;
      const requestedEditLog = Array.isArray(editLog) ? editLog : [];
      const compressedRequestedEditLog = compressEditLog(requestedEditLog);
      let result: any;
      if (language === 'r') {
        const requestedFilePaths = req.body.uploaded_file_paths;
        const hasClientFilePaths = requestedFilePaths
          && typeof requestedFilePaths === 'object'
          && Object.keys(requestedFilePaths).length > 0;
        if (hasClientFilePaths || req.body.cwd) {
          return res.status(400).json({
            status: 'error',
            message: '直接 R 渲染不接受客户端文件路径；请使用项目上传文件和项目渲染接口。',
          });
        }
        result = await spawnRWithPayload({
          script,
          dataPayload: effectiveDataPayload,
          renderOptions: renderOptions || { width_in: 7, height_in: 5 },
        }, { req, label: 'r-render' });
      } else {
        // AST gate applies to Python only. R uses the R renderer contract.
        const astCheck = await validateAst(script, req);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
        }
        result = await spawnPythonWithPayload('introspector.py', {
          script,
          dataPayload: effectiveDataPayload,
          editLog: compressedRequestedEditLog,
          renderOptions: renderOptions || { dpi: 150 },
        }, { req, label: 'render' });
      }
      if (result.status === 'success') {
        if (language === 'python' && compressedRequestedEditLog.length > 0) {
          const knownEditLog = Array.isArray(existingSession?.editLog) ? existingSession.editLog : [];
          const renderedManifest = result.manifest || result.figures?.[0]?.manifest;
          const renderedPrecheck = precheckRenderedProjectFigureEditLog(
            renderedManifest,
            compressedRequestedEditLog,
            knownEditLog,
            'fig_1',
          );
          const precheckWarnings = renderedPrecheck.warnings;
          const rendererConflicts = collectRendererConflictWarnings(
            result.warnings,
            compressedRequestedEditLog,
            'fig_1',
          );
          const conflictWarnings = [...precheckWarnings, ...rendererConflicts];
          if (conflictWarnings.length > 0) {
            return res.json({
              status: 'conflict',
              code: 'RENDERER_EDIT_REPLAY_REJECTED',
              message: '编辑记录未通过当前 Figure 身份或 renderer 重放确认，本次渲染未写入。',
              sessionId: existingSession?.sessionId || null,
              revision: existingSession?.revision || 0,
              editLog: knownEditLog,
              applied: [],
              rejected: compressedRequestedEditLog.filter(patch => (
                conflictWarnings.some(warning => isConflictWarningForPatch(warning, patch))
              )),
              warnings: conflictWarnings,
            });
          }
        }
        const persistStartedAt = performance.now();
        const sessionId = existingSession?.sessionId || result.sessionId || `fig_${Date.now()}`;
        const nextEditLog = requestedEditLog;
        persistSession({
          sessionId,
          ownerUserId: userId,
          script,
          language,
          dataPayload: effectiveDataPayload,
          editLog: nextEditLog,
          revision: result.revision || 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        result.sessionId = sessionId;
        result.editLog = nextEditLog;
        result.revision = result.revision || 1;
        result.language = language;
        result = attachServerPerformance(result, { persistMs: roundedDuration(persistStartedAt) });
      }
      res.json(result);
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  }));

  // POST /api/figure/patch — apply edits and re-render
  app.post('/api/figure/patch', renderRateLimit, deploymentJobHandler('render', async (req, res) => {
    let releaseFigureMutation: (() => void) | null = null;
    let releaseProjectMutation: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const { sessionId, patches } = req.body;
      const projectContext = await buildProjectFigureContext({
        sessionId,
        projectId: typeof req.body.projectId === 'string' ? req.body.projectId : undefined,
        figureId: typeof req.body.figureId === 'string' ? req.body.figureId : undefined,
      }, userId);
      const resolvedSessionId = projectContext?.sessionId || sessionId;
      if (projectContext) {
        releaseProjectMutation = projectMutationGate.tryBegin(projectContext.projectId);
        if (!releaseProjectMutation) {
          return res.status(409).json({
            status: 'error',
            code: 'PROJECT_STATE_BUSY',
            message: '项目正在恢复导出状态，请等待恢复完成后再应用修改。',
          });
        }
      }
      const session = loadSession(resolvedSessionId, userId);
      if (!session) {
        return res.status(404).json({
          status: 'error',
          message: projectContext
            ? `Project figure session not found: ${resolvedSessionId}`
            : 'Session not found'
        });
      }
      const requestId = typeof req.body.requestId === 'string'
        ? req.body.requestId
        : `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const baseRevision = typeof req.body.baseRevision === 'number'
        ? req.body.baseRevision
        : session.revision;

      // Idempotency: return cached response if already processed
      if (!processedRequestIdsMap.has(resolvedSessionId)) {
        processedRequestIdsMap.set(resolvedSessionId, new Set());
        responseCacheMap.set(resolvedSessionId, new Map());
      }
      const processedIds = processedRequestIdsMap.get(resolvedSessionId)!;
      const cache = responseCacheMap.get(resolvedSessionId)!;
      if (processedIds.has(requestId)) {
        const cached = cache.get(requestId);
        if (cached) return res.json(cached);
      }
      releaseFigureMutation = figureMutationGate.begin(resolvedSessionId);

      const revisionWarning = baseRevision !== session.revision
        ? {
            type: 'revision_mismatch',
            message: 'Client revision was stale; patch was applied to the latest server session.',
            expectedRevision: session.revision,
            receivedRevision: baseRevision,
          }
        : null;

      const codePatches = (patches || []).filter((p: any) => p.type === 'code_patch');
      let regularPatches = (patches || []).filter((p: any) => p.type !== 'code_patch');
      if (session.language !== 'r') {
        regularPatches = normalizeProjectFigurePatchModes(projectContext?.figRow, regularPatches);
      }
      const sessionBeforePatch = {
        sessionId: session.sessionId,
        revision: session.revision,
        editLog: [...session.editLog],
        script: session.script,
      };

      if (session.language !== 'r' && projectContext?.figRow && regularPatches.length > 0) {
        const precheck = precheckProjectFigurePatches(projectContext.figRow, regularPatches);
        if (!precheck.ok) {
          const rejectedIndexes = new Set(
            precheck.warnings
              .map((warning: any) => warning.patchIndex)
              .filter((index: unknown): index is number => typeof index === 'number'),
          );
          const rejected = regularPatches.filter((_: any, index: number) => rejectedIndexes.has(index));
          const response = buildPatchConflictResponse(
            sessionBeforePatch,
            requestId,
            rejected,
            [...precheck.warnings, ...(revisionWarning ? [revisionWarning] : [])],
          );
          processedIds.add(requestId);
          cache.set(requestId, response);
          return res.json(response);
        }
      }

      if (session.language === 'r') {
        if (codePatches.length > 0) {
          return res.status(400).json({
            status: 'error',
            message: 'R 图当前不支持代码常量替换；请直接修改 R 脚本后重新渲染。'
          });
        }
        const patchTimestamp = Date.now();
        const newEdits: EditEntry[] = regularPatches.map((p: any) => ({
          gid: p.gid,
          prop: p.prop,
          value: p.value,
          mode: 'backend_patch',
          timestamp: patchTimestamp,
          ...(typeof p.matchColor === 'string' ? { matchColor: p.matchColor } : {}),
        }));
        const mergedEditLog = [...session.editLog, ...newEdits];
        let cwd: string | undefined = projectContext?.cwd;
        let uploaded_file_paths: Record<string, string> | undefined = projectContext?.uploaded_file_paths;
        if (projectContext) {
          session.dataPayload = projectContext.dataPayload;
        }

        // Cache lookup
        const cacheLookupStartedAt = performance.now();
        const cacheKey = await computeRenderCacheKey(session, projectContext, mergedEditLog);
        const cached = getCachedRender(cacheKey);
        const cacheLookupMs = roundedDuration(cacheLookupStartedAt);
        if (cached) {
          const persistStartedAt = performance.now();
          session.editLog = mergedEditLog;
          session.revision++;
          persistSession(session);
          if (projectContext) {
            syncProjectFigureRevision(session.sessionId, session.revision);
          }
          const cachedResponse = attachServerPerformance({
            status: 'success',
            sessionId: session.sessionId,
            revision: session.revision,
            editLog: session.editLog,
            script: session.script,
            svg: cached.svg,
            manifest: cached.manifest,
            applied: newEdits,
            requestId,
            cache: { hit: true, key: cacheKey },
            warnings: revisionWarning ? [revisionWarning] : [],
          }, { cacheLookupMs, persistMs: roundedDuration(persistStartedAt) });
          processedIds.add(requestId);
          cache.set(requestId, cachedResponse);
          return res.json(cachedResponse);
        }

        const result = await spawnRWithPayload({
          script: session.script,
          dataPayload: session.dataPayload || null,
          editLog: compressEditLog(mergedEditLog),
          cwd,
          uploaded_file_paths: prepareUploadedFilePathsForR(uploaded_file_paths, cwd),
          renderOptions: { width_in: 7, height_in: 5 },
        }, { req, label: 'r-patch' });
        let persistMs = 0;
        let cacheWriteMs = 0;
        if (result.status === 'success') {
          const persistStartedAt = performance.now();
          session.editLog = mergedEditLog;
          session.revision++;
          persistSession(session);
          if (projectContext) {
            syncProjectFigureRevision(session.sessionId, session.revision);
          }
          result.sessionId = session.sessionId;
          result.revision = session.revision;
          result.editLog = session.editLog;
          result.script = session.script;
          persistMs = roundedDuration(persistStartedAt);

          const cacheWriteStartedAt = performance.now();
          setCachedRender(cacheKey, result.svg, result.manifest, undefined, result);
          cacheWriteMs = roundedDuration(cacheWriteStartedAt);
        }
        const response = attachServerPerformance({
          ...result,
          applied: newEdits,
          requestId,
          cache: { hit: false, key: cacheKey },
          warnings: [
            ...(result.warnings || []),
            ...(revisionWarning ? [revisionWarning] : []),
          ],
        }, { cacheLookupMs, persistMs, cacheWriteMs });
        processedIds.add(requestId);
        cache.set(requestId, response);
        return res.json(response);
      }

      // Apply code patches if any
      if (codePatches.length > 0) {
        codePatches.forEach((cp: any) => {
          session.script = applyColorCodePatch(session.script, cp);
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
        ...(p.matchColor !== undefined ? { matchColor: p.matchColor } : {}),
        ...(p.stableKey !== undefined ? { stableKey: p.stableKey } : {}),
        ...(p.fingerprint !== undefined ? { fingerprint: p.fingerprint } : {}),
        ...(p.fingerprintVersion !== undefined ? { fingerprintVersion: p.fingerprintVersion } : {}),
        ...(p.identity !== undefined ? { identity: p.identity } : {}),
      }));

      const backendPatches = newEdits.filter(e => e.mode === 'backend_patch');
      const localPatches = newEdits.filter(e => e.mode === 'local_patch');
      const mergedEditLog = [...session.editLog, ...newEdits];

      if (projectContext && codePatches.length === 0) {
        const storedManifest = parseManifestValue(projectContext.figRow?.manifest);
        if (storedManifest) {
          const fullPrecheck = precheckRenderedProjectFigureEditLog(
            storedManifest,
            compressEditLog(mergedEditLog),
            sessionBeforePatch.editLog,
            projectContext.figureId,
          );
          if (!fullPrecheck.ok) {
            const response = buildPatchConflictResponse(
              sessionBeforePatch,
              requestId,
              fullPrecheck.rejected,
              [
                ...fullPrecheck.warnings,
                ...(revisionWarning ? [revisionWarning] : []),
              ],
            );
            processedIds.add(requestId);
            cache.set(requestId, response);
            return res.json(response);
          }
        }
        // A pure local patch intentionally invalidates the stored preview.
        // With no trusted manifest, defer identity/capability confirmation to
        // the backend renderer and validate its returned manifest before write.
      }

      if (backendPatches.length === 0 && codePatches.length === 0) {
        session.editLog.push(...localPatches);
        session.revision++;
        if (projectContext) {
          getDb().transaction(() => {
            persistSession(session);
            invalidateProjectFigurePreview(session.sessionId, session.revision);
          })();
        } else {
          persistSession(session);
        }
        const response = {
          status: 'success',
          sessionId: resolvedSessionId,
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
      const figRow = projectContext?.figRow || null;
      let cwd: string | undefined = projectContext?.cwd;
      let uploaded_file_paths: Record<string, string> | undefined = projectContext?.uploaded_file_paths;

      if (projectContext) {
        session.dataPayload = projectContext.dataPayload;
      }

      // E3 CodePatch project-wide invalidation (V1)
      if (projectContext && codePatches.length > 0) {
        const oldFigRows = listProjectFigures(projectContext.projectId);
        const oldEditLogMap: Record<string, any[]> = {};
        const oldSessionMap: Record<string, any> = {};
        for (const row of oldFigRows) {
          const key = `fig_${row.figure_index + 1}`;
          const sess = loadSession(row.session_id, userId);
          if (sess) {
            oldEditLogMap[key] = sess.editLog;
            oldSessionMap[key] = sess;
          }
        }
        const effectiveEditLogs = { ...oldEditLogMap, [projectContext.figureId]: mergedEditLog };
        const compressedEditLogs: Record<string, EditEntry[]> = {};
        for (const key of Object.keys(effectiveEditLogs)) {
          compressedEditLogs[key] = compressEditLog(effectiveEditLogs[key]);
        }

        const result = await spawnPythonWithPayload('introspector.py', {
          script: session.script,
          dataPayload: session.dataPayload || null,
          editLogs: compressedEditLogs,
          renderOptions: { dpi: 150 },
          cwd,
          uploaded_file_paths,
        }, { req, label: 'patch-project-code' });

        const replayConflicts = collectRendererReplayConflictsByFigure(
          result.warnings,
          compressedEditLogs,
        );
        const manifestPrecheckWarnings: any[] = [];
        const manifestPrecheckRejected: any[] = [];
        if (result.status === 'success') {
          for (const fig of result.figures || []) {
            const figureId = String(fig.figureId || '');
            const patchesForFigure = compressedEditLogs[figureId] || [];
            if (patchesForFigure.length === 0) continue;
            const fullPrecheck = precheckRenderedProjectFigureEditLog(
              fig.manifest,
              patchesForFigure,
              oldEditLogMap[figureId] || [],
              figureId,
            );
            manifestPrecheckWarnings.push(...fullPrecheck.warnings);
            manifestPrecheckRejected.push(...fullPrecheck.rejected.map((patch: any) => ({
              ...patch,
              figureId,
            })));
          }
        }
        if (result.status === 'success' && (replayConflicts.length > 0 || manifestPrecheckWarnings.length > 0)) {
          session.script = sessionBeforePatch.script;
          session.editLog = [...sessionBeforePatch.editLog];
          session.revision = sessionBeforePatch.revision;
          const rendererConflicts = Array.from(new Map(
            replayConflicts.map(conflict => [JSON.stringify(conflict.warning), conflict.warning]),
          ).values());
          const rejected = [
            ...codePatches,
            ...newEdits,
            ...manifestPrecheckRejected,
            ...replayConflicts.map(conflict => ({
              ...conflict.patch,
              figureId: conflict.figureId,
            })),
          ];
          const response = buildPatchConflictResponse(
            sessionBeforePatch,
            requestId,
            rejected,
            [
              ...manifestPrecheckWarnings,
              ...rendererConflicts,
              ...(revisionWarning ? [revisionWarning] : []),
            ],
          );
          processedIds.add(requestId);
          cache.set(requestId, response);
          return res.json(response);
        }

        if (result.status === 'success') {
          const newFigures = result.figures || [];
          const figInputs: FigSessionInput[] = [];
          for (let i = 0; i < newFigures.length; i++) {
            const fig = newFigures[i];
            const figKey = `fig_${i + 1}`;
            const figSessionIdResolved = `${projectContext.projectId}_${figKey}`;
            const incomingEditLog = effectiveEditLogs[figKey] || [];
            
            const figSess = loadSession(figSessionIdResolved, userId);
            const nextRev = (figSess?.revision || 1) + 1;
            figInputs.push({
              figureIndex: i,
              sessionId: figSessionIdResolved,
              editLog: incomingEditLog,
              revision: nextRev,
              previewSvg: fig.svg || null,
              manifest: fig.manifest || null,
              codeSlice: fig.codeSlice ?? null,
              fingerprint: fig.fingerprint ?? null,
            });
            fig.revision = nextRev;
            fig.editLog = incomingEditLog;
          }

          replaceProjectFiguresAndSessions(projectContext.projectId, userId, figInputs, session.script, session.dataPayload);
          persistProjectScript(projectContext.projectId, userId, session.script);

          result.warnings = [
            ...(result.warnings || []),
            "Code patch has triggered project-wide re-rendering of all figures to ensure consistency."
          ];
        }

        const matchedFig = result.figures?.find((f: any) => f.figureId === projectContext.figureId);
        if (matchedFig) {
          result.svg = matchedFig.svg;
          result.manifest = matchedFig.manifest;
          result.codeSlice = matchedFig.codeSlice;
          result.editLog = matchedFig.editLog || effectiveEditLogs[projectContext.figureId] || [];
          result.revision = matchedFig.revision;
        }
        result.script = session.script;

        const response = { ...result, applied: newEdits, requestId };
        processedIds.add(requestId);
        cache.set(requestId, response);
        return res.json(response);
      }

      // Cache lookup for Python figure patch
      const cacheLookupStartedAt = performance.now();
      const cacheKey = await computeRenderCacheKey(session, projectContext, mergedEditLog);
      const cached = validatedPythonPatchCacheKeys.has(cacheKey)
        ? getCachedRender(cacheKey)
        : null;
      const cacheLookupMs = roundedDuration(cacheLookupStartedAt);
      if (cached) {
        const cachedPrecheck = projectContext
          ? precheckRenderedProjectFigureEditLog(
              cached.manifest,
              compressEditLog(mergedEditLog),
              sessionBeforePatch.editLog,
              projectContext.figureId,
            )
          : { ...precheckRenderedPythonPatches(cached.manifest, newEdits), rejected: [] as any[] };
        if (!cachedPrecheck.ok) {
          const rejectedIndexes = new Set(
            cachedPrecheck.warnings
              .map((warning: any) => warning.patchIndex)
              .filter((index: unknown): index is number => typeof index === 'number'),
          );
          const rejected = projectContext
            ? cachedPrecheck.rejected
            : newEdits.filter((_: any, index: number) => rejectedIndexes.has(index));
          const response = buildPatchConflictResponse(
            sessionBeforePatch,
            requestId,
            rejected,
            [
              ...cachedPrecheck.warnings,
              ...(revisionWarning ? [revisionWarning] : []),
            ],
          );
          processedIds.add(requestId);
          cache.set(requestId, response);
          return res.json(response);
        }
        const persistStartedAt = performance.now();
        session.editLog = mergedEditLog;
        session.revision++;
        persistSession(session);
        if (projectContext) {
          syncProjectFigureRevision(session.sessionId, session.revision);
        }
        const cachedResponse = attachServerPerformance({
          status: 'success',
          sessionId: session.sessionId,
          revision: session.revision,
          editLog: session.editLog,
          script: session.script,
          svg: cached.svg,
          manifest: cached.manifest,
          codeSlice: cached.codeSlice,
          applied: newEdits,
          requestId,
          cache: { hit: true, key: cacheKey },
          warnings: revisionWarning ? [revisionWarning] : [],
        }, { cacheLookupMs, persistMs: roundedDuration(persistStartedAt) });
        processedIds.add(requestId);
        cache.set(requestId, cachedResponse);
        return res.json(cachedResponse);
      }

      // Otherwise, re-render with updated script and editLog (cache miss)
      const result = await spawnPythonWithPayload('introspector.py', {
        script: session.script,
        dataPayload: session.dataPayload || null,
        editLog: compressEditLog(mergedEditLog),
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: projectContext ? { [projectContext.figureId]: compressEditLog(mergedEditLog) } : undefined
      }, { req, label: 'patch' });

      const renderedFigure = projectContext
        ? result.figures?.find((figure: any) => figure.figureId === projectContext.figureId)
        : null;
      const renderedPrecheck = result.status === 'success'
        ? (
            projectContext
              ? precheckRenderedProjectFigureEditLog(
                  renderedFigure?.manifest || result.manifest,
                  compressEditLog(mergedEditLog),
                  sessionBeforePatch.editLog,
                  projectContext.figureId,
                )
              : { ...precheckRenderedPythonPatches(result.manifest, newEdits), rejected: [] as any[] }
          )
        : { ok: true, warnings: [] as any[] };
      if (!renderedPrecheck.ok) {
        const rejectedIndexes = new Set(
          renderedPrecheck.warnings
            .map((warning: any) => warning.patchIndex)
            .filter((index: unknown): index is number => typeof index === 'number'),
        );
        const rejected = projectContext
          ? (renderedPrecheck as any).rejected || []
          : newEdits.filter((_: any, index: number) => rejectedIndexes.has(index));
        const response = buildPatchConflictResponse(
          sessionBeforePatch,
          requestId,
          rejected,
          [
            ...renderedPrecheck.warnings,
            ...(revisionWarning ? [revisionWarning] : []),
          ],
        );
        processedIds.add(requestId);
        cache.set(requestId, response);
        return res.json(response);
      }

      const rendererConflicts = collectRendererConflictWarnings(
        result.warnings,
        projectContext ? compressEditLog(mergedEditLog) : newEdits,
        projectContext?.figureId || 'fig_1',
      );
      if (result.status === 'success' && rendererConflicts.length > 0) {
        const conflictCandidatePatches = projectContext ? compressEditLog(mergedEditLog) : newEdits;
        const rejected = conflictCandidatePatches.filter((patch: any) => (
          rendererConflicts.some((warning: any) => isConflictWarningForPatch(warning, patch))
        ));
        const response = buildPatchConflictResponse(
          sessionBeforePatch,
          requestId,
          rejected,
          [...rendererConflicts, ...(revisionWarning ? [revisionWarning] : [])],
        );
        processedIds.add(requestId);
        cache.set(requestId, response);
        return res.json(response);
      }

      let persistMs = 0;
      let cacheWriteMs = 0;
      if (result.status === 'success') {
        const persistStartedAt = performance.now();
        session.editLog = mergedEditLog;
        session.revision++;

        let targetFigSvg = result.svg;
        let targetFigManifest = result.manifest;
        let targetFigCodeSlice = result.codeSlice;
        let targetFigFingerprint = result.fingerprint;

        if (projectContext) {
          const matchedFig = renderedFigure;
          if (matchedFig) {
            result.svg = matchedFig.svg;
            result.manifest = matchedFig.manifest;
            result.codeSlice = matchedFig.codeSlice;
            targetFigSvg = matchedFig.svg;
            targetFigManifest = matchedFig.manifest;
            targetFigCodeSlice = matchedFig.codeSlice;
            targetFigFingerprint = matchedFig.fingerprint;
          }
        }

        const targetDiagnosticsSource = projectContext && renderedFigure
          ? renderDiagnosticsSourceForFigure(result, renderedFigure)
          : result;
        targetFigManifest = withRenderDiagnostics(targetFigManifest, targetDiagnosticsSource);
        result.manifest = targetFigManifest;

        if (projectContext) {
          getDb().transaction(() => {
            persistSession(session);
            syncProjectFigurePreview({
              sessionId: session.sessionId,
              revision: session.revision,
              svg: targetFigSvg,
              manifest: targetFigManifest,
              codeSlice: targetFigCodeSlice,
              fingerprint: targetFigFingerprint ?? projectContext.figRow?.fingerprint ?? null,
              diagnosticsSource: targetDiagnosticsSource,
            });
          })();
        } else {
          persistSession(session);
        }
        result.sessionId = session.sessionId;
        result.revision = session.revision;
        result.editLog = session.editLog;
        result.script = session.script;
        persistMs = roundedDuration(persistStartedAt);

        const cacheWriteStartedAt = performance.now();
        setCachedRender(cacheKey, targetFigSvg, targetFigManifest, targetFigCodeSlice, targetDiagnosticsSource);
        validatedPythonPatchCacheKeys.add(cacheKey);
        cacheWriteMs = roundedDuration(cacheWriteStartedAt);
      }
      const response: any = attachServerPerformance(
        { ...result, applied: newEdits, requestId },
        { cacheLookupMs, persistMs, cacheWriteMs },
      );
      response.cache = { hit: false, key: cacheKey };
      if (revisionWarning) {
        response.warnings = [...(response.warnings || []), revisionWarning];
      }
      processedIds.add(requestId);
      cache.set(requestId, response);
      res.json(response);
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseFigureMutation?.();
      releaseProjectMutation?.();
    }
  }));

  // POST /api/figure/code-patch — update script with AST gate & drift detection
  app.post('/api/figure/code-patch', renderRateLimit, deploymentJobHandler('render', async (req, res) => {
    let releaseFigureMutation: (() => void) | null = null;
    let releaseProjectMutation: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      let { sessionId, script, force } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);

      const projectContext = await buildProjectFigureContext({
        sessionId,
        projectId: typeof req.body.projectId === 'string' ? req.body.projectId : undefined,
        figureId: typeof req.body.figureId === 'string' ? req.body.figureId : undefined,
      }, userId);
      const resolvedSessionId = projectContext?.sessionId || sessionId;
      if (projectContext) {
        releaseProjectMutation = projectMutationGate.tryBegin(projectContext.projectId);
        if (!releaseProjectMutation) {
          return res.status(409).json({
            status: 'error',
            code: 'PROJECT_STATE_BUSY',
            message: '项目正在恢复导出状态，请等待恢复完成后再修改代码。',
          });
        }
      }
      if (resolvedSessionId) {
        releaseFigureMutation = figureMutationGate.begin(resolvedSessionId);
      }
      let session = null;
      let editLog: EditEntry[] = [];
      let dataPayload: Record<string, unknown> | null = null;

      if (resolvedSessionId) {
        session = loadSession(resolvedSessionId, userId);
        if (session) {
          editLog = session.editLog;
          dataPayload = session.dataPayload;
        }
      }

      if (session?.language === 'r') {
        return res.status(400).json({
          status: 'error',
          message: 'R 图当前不支持代码补丁漂移检测；请使用“同步至引擎并预览 SVG”重新渲染 R 脚本。'
        });
      }

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

      // Determine sandbox configurations if project figure session is processed
      const figRow = projectContext?.figRow || null;
      let cwd: string | undefined = projectContext?.cwd;
      let uploaded_file_paths: Record<string, string> | undefined = projectContext?.uploaded_file_paths;

      if (projectContext) {
        dataPayload = projectContext.dataPayload;
      }

      // 2. Re-render via introspector with new script + old editLog
      const result = await spawnPythonWithPayload('introspector.py', {
        script,
        dataPayload,
        editLog: compressEditLog(editLog),
        renderOptions: { dpi: 150 },
        cwd,
        uploaded_file_paths,
        editLogs: projectContext ? { [projectContext.figureId]: compressEditLog(editLog) } : undefined
      }, { req, label: 'code-patch' });

      if (result.status !== 'success') {
        return res.json(result); // Returns python error directly
      }

      if (projectContext) {
        const targetFigId = projectContext.figureId;
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
      const returnedGids = new Set((result.manifest?.objects || []).map((o: any) => o.id));
      const requestedGids = new Set(editLog.map(e => e.gid));
      const orphanedGids = [...requestedGids].filter(gid => (
        !returnedGids.has(gid) && !isDurableVirtualEditGid(gid)
      ));

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
          session.editLog = session.editLog.filter(e => (
            returnedGids.has(e.gid) || isDurableVirtualEditGid(e.gid)
          ));
        }
        session.revision++;
        session.updatedAt = Date.now();
        persistSession(session);
        if (projectContext) {
          syncProjectFigurePreview({
            sessionId: session.sessionId,
            revision: session.revision,
            svg: result.svg || null,
            manifest: result.manifest || null,
            codeSlice: result.codeSlice ?? null,
            fingerprint: result.fingerprint ?? null,
            diagnosticsSource: result,
          });
          persistProjectScript(projectContext.projectId, userId, script);
        } else {
          syncProjectFigureRevision(session.sessionId, session.revision);
        }
        result.revision = session.revision;
        result.sessionId = session.sessionId;
        result.editLog = session.editLog;
      } else {
        const newSessionId = projectContext?.sessionId || result.sessionId || `fig_${Date.now()}`;
        persistSession({
          sessionId: newSessionId,
          ownerUserId: userId,
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
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseFigureMutation?.();
      releaseProjectMutation?.();
    }
  }));

  // POST /api/figure/export — export SVG/PNG/PDF and reproducible bundle
  app.post('/api/figure/export', renderRateLimit, downloadRateLimit, deploymentJobHandler('export', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { sessionId, format, dpi } = req.body;
      const session = loadSession(sessionId, userId);
      if (!session) {
        return res.status(404).json({ status: 'error', message: 'Session not found' });
      }

      const reqFormat = (format || 'svg').toLowerCase();
      const linkedFigure = getDb().prepare('SELECT manifest FROM project_figures WHERE session_id = ?').get(sessionId) as { manifest?: string } | undefined;
      const exportEditLog = compressEditLog(mergePreviewGlobalsIntoEditLog(
        session.editLog,
        linkedFigure?.manifest,
      ));

      let result: any;
      if (session.language === 'r') {
        result = await spawnRWithPayload({
          script: session.script,
          dataPayload: session.dataPayload || null,
          editLog: exportEditLog,
          renderOptions: { width_in: 7, height_in: 5 },
        }, { req, label: 'r-export', maxOutputMb: 64 });
      } else {
        // AST gate before executing Python script
        const astCheck = await validateAst(session.script, req);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
        }

        // 1. Ensure we have the latest SVG and export if necessary
        result = await spawnPythonWithPayload('introspector.py', {
          script: session.script,
          dataPayload: session.dataPayload || null,
          editLog: exportEditLog,
          renderOptions: { dpi: dpi || 300 },
          export_format: reqFormat !== 'svg' ? reqFormat : undefined,
        }, { req, label: 'export', maxOutputMb: 64 });
      }
      if (result.status !== 'success') {
        return res.json(result);
      }
      
      const svg = result.svg;
      let binary_b64 = result.binary_b64 || null;
      let format_note = '';

      if (session.language === 'r' && reqFormat !== 'svg' && !binary_b64) {
        const converted = await spawnPythonWithPayload('svg_convert.py', {
          svg,
          format: reqFormat,
          dpi: dpi || 300,
        }, { req, label: 'r-svg-export', maxOutputMb: 64 });
        if (converted.status === 'success' && converted.binary_b64) {
          binary_b64 = converted.binary_b64;
        } else {
          format_note = converted.message || `无法导出 ${reqFormat}，已回退为 SVG`;
        }
      }

      // Fallback if binary_b64 wasn't produced
      if (reqFormat !== 'svg' && !binary_b64) {
        format_note = format_note || `无法导出 ${reqFormat}，可能缺少依赖 (例如 PIL/Cairo)，已回退为 SVG`;
      }

      // 3. Reproducible bundle
      const dataSnapshot = session.dataPayload || null;
      const dataFingerprint = crypto.createHash('sha256').update(JSON.stringify(dataSnapshot ?? null)).digest('hex');
      const exportAnchor = buildExportEditLogAnchor(exportEditLog);
      const bundle = {
        script: session.script,
        editLog: exportEditLog,
        dataSnapshot,
        dataFingerprint,
        metadata: {
          generatedAt: new Date().toISOString(),
          revision: session.revision,
          ...exportAnchor,
          appVersion: '2.0',
          exportFormat: reqFormat,
          dpi: dpi || 300,
          environment: session.language === 'r' ? 'R + SVG renderer' : 'Python 3 + Matplotlib'
        }
      };

      const responsePayload = {
        status: 'success',
        format: reqFormat,
        svg,
        binary_b64,
        bundle,
        format_note,
        warnings: result.warnings ?? []
      };
      assertHourlyByteBudget(
        req,
        res,
        'download_bytes',
        Buffer.byteLength(JSON.stringify(responsePayload), 'utf8'),
      );

      res.json(responsePayload);
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  }));

  // --- Project CRUD API ---

  app.get('/api/projects', (req, res) => {
    try {
      const projects = listProjects(authenticatedUserId(req));
      res.json({ status: 'success', projects });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) return res.status(404).json({ status: 'error', message: 'Project not found' });
      
      const datasets = listProjectFiles(req.params.id);
      const figRows = listProjectFigures(req.params.id);
      let parsedSpec: any = {};
      try {
        parsedSpec = typeof project.spec === 'string' ? JSON.parse(project.spec) : (project.spec || {});
      } catch {
        parsedSpec = {};
      }
      const legacySpecEditLog = parseStoredArray(parsedSpec.editLog);
      const canUseLegacySpecFallback = figRows.length === 1 && legacySpecEditLog.length > 0;
      const figures = figRows.map(f => {
        const session = loadSession(f.session_id, userId);
        const resolvedEditLog = resolveProjectFigureEditLog(
          f,
          session,
          legacySpecEditLog,
          canUseLegacySpecFallback,
        );
        return {
          figureId: `fig_${f.figure_index + 1}`,
          index: f.figure_index,
          editLog: resolvedEditLog.editLog,
          revision: resolveProjectFigureRevision(f, session),
          history: parseStoredHistory(f.history),
          recoverySource: resolvedEditLog.recoverySource,
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
          figures,
          historyRecovery: !canUseLegacySpecFallback && figRows.length > 1 && legacySpecEditLog.length > 0
            ? {
              status: 'ambiguous',
              editCount: legacySpecEditLog.length,
              message: '检测到旧版项目级 editLog，但无法安全判断属于哪个 Figure，未自动套用。',
            }
            : null,
        }
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const { name, spec } = req.body;
      if (!name || !spec) return res.status(400).json({ status: 'error', message: 'name and spec required' });
      const id = randomUUID();
      createProject(id, userId, name, spec);
      
      const script = spec.custom_script || spec.script || '';
      if (script) {
        updateProject(id, userId, name, spec, script);
      }
      
      res.json({ status: 'success', id });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/create-composition-project', (req, res) => {
    try {
      res.json(createCompositionCodeProject(req.body, authenticatedUserId(req)));
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/create-composition-project', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      res.json(createCompositionCodeProject(req.body, userId, projectId));
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  app.put('/api/projects/:id', (req, res) => {
    let releaseProjectMutation: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const { name, spec, figures } = req.body;
      if (!name) return res.status(400).json({ status: 'error', message: 'name required' });
      const existing = getProject(projectId, userId);
      if (!existing) return res.status(404).json({ status: 'error', message: 'Project not found' });
      releaseProjectMutation = projectMutationGate.tryBegin(projectId);
      if (!releaseProjectMutation) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在恢复导出状态，请等待恢复完成后再保存。',
        });
      }
      const figurePlans: Array<{
        figureId: string;
        row: any;
        session: FigureSession | null;
        nextEditLog: any[];
        nextRevision: number;
        nextHistory: { past: any[]; future: any[] };
      }> = [];
      const rejected: any[] = [];
      const warnings: any[] = [];
      const revisionConflicts: Array<{
        figureId: string;
        reason: 'precondition_required' | 'revision_mismatch' | 'edit_log_mismatch';
        expectedRevision: number;
        receivedRevision?: number;
        expectedEditLogHash?: string;
        receivedEditLogHash?: string;
        missing?: string[];
      }> = [];
      if (Array.isArray(figures)) {
        const figRows = listProjectFigures(projectId);
        let parsedExistingSpec: any = {};
        try {
          parsedExistingSpec = typeof existing.spec === 'string' ? JSON.parse(existing.spec) : (existing.spec || {});
        } catch {
          parsedExistingSpec = {};
        }
        const legacySpecEditLog = parseStoredArray(parsedExistingSpec.editLog);
        const canUseLegacySpecFallback = figRows.length === 1 && legacySpecEditLog.length > 0;
        const rowsByFigureId = new Map<string, any>();
        figRows.forEach((row: any) => {
          rowsByFigureId.set(`fig_${Number(row.figure_index) + 1}`, row);
        });
        figures.forEach((figure: any) => {
          const figureId = typeof figure?.figureId === 'string'
            ? figure.figureId
            : typeof figure?.index === 'number'
              ? `fig_${figure.index + 1}`
              : '';
          const row = rowsByFigureId.get(figureId);
          if (!row) return;
          const session = loadSession(row.session_id, userId);
          const existingEditLog = resolveProjectFigureEditLog(
            row,
            session,
            legacySpecEditLog,
            canUseLegacySpecFallback,
          ).editLog;
          const currentRevision = resolveProjectFigureRevision(row, session);
          const baseRevision = typeof figure?.baseRevision === 'number'
            ? Number(figure.baseRevision)
            : null;
          if (baseRevision !== null && baseRevision !== currentRevision) {
            revisionConflicts.push({
              figureId,
              reason: 'revision_mismatch',
              expectedRevision: currentRevision,
              receivedRevision: baseRevision,
            });
            return;
          }
          const baseEditLogHash = typeof figure?.baseEditLogHash === 'string'
            ? figure.baseEditLogHash
            : null;
          const currentEditLogHash = fnv1a(stableStringifyForExport(existingEditLog));
          if (baseEditLogHash !== null && baseEditLogHash !== currentEditLogHash) {
            revisionConflicts.push({
              figureId,
              reason: 'edit_log_mismatch',
              expectedRevision: currentRevision,
              receivedRevision: baseRevision ?? currentRevision,
              expectedEditLogHash: currentEditLogHash,
              receivedEditLogHash: baseEditLogHash,
            });
            return;
          }
          const existingHistory = parseStoredHistory(row.history);
          const incomingEditLog = Array.isArray(figure.editLog) ? figure.editLog : null;
          let normalizedIncoming: any[] = [];
          if (incomingEditLog) {
            const preflight = preflightProjectFigureEditLog(
              row,
              existingEditLog,
              incomingEditLog,
              existingEditLog,
            );
            normalizedIncoming = preflight.patches;
            preflight.warnings.forEach((warning: any) => warnings.push({ ...warning, figureId }));
            preflight.rejected.forEach((patch: any) => rejected.push({ ...patch, figureId }));
          }
          let nextEditLog = incomingEditLog
            ? compressEditLog(normalizedIncoming)
            : existingEditLog;
          let nextRevision = typeof figure.revision === 'number'
            ? Math.max(figure.revision, session?.revision || row.revision || 1)
            : (session?.revision || row.revision || 1);
          let nextHistory = existingHistory;
          if (figure.history) {
            const historyPreflight = preflightProjectFigureHistory(
              row,
              existingEditLog,
              existingHistory,
              parseStoredHistory(figure.history),
            );
            nextHistory = historyPreflight.history;
            historyPreflight.warnings.forEach((warning: any) => warnings.push({ ...warning, figureId }));
            historyPreflight.rejected.forEach((patch: any) => rejected.push({ ...patch, figureId }));
          }
          const editLogChanged = !sameProjectEditLogSemantics(nextEditLog, existingEditLog);
          const historyChanged = stableStringifyForExport(nextHistory) !== stableStringifyForExport(existingHistory);
          if ((editLogChanged || historyChanged) && (baseRevision === null || baseEditLogHash === null)) {
            revisionConflicts.push({
              figureId,
              reason: 'precondition_required',
              expectedRevision: currentRevision,
              ...(baseRevision === null ? {} : { receivedRevision: baseRevision }),
              expectedEditLogHash: currentEditLogHash,
              ...(baseEditLogHash === null ? {} : { receivedEditLogHash: baseEditLogHash }),
              missing: [
                ...(baseRevision === null ? ['baseRevision'] : []),
                ...(baseEditLogHash === null ? ['baseEditLogHash'] : []),
              ],
            });
            return;
          }
          if (baseRevision === null || baseEditLogHash === null) {
            nextEditLog = existingEditLog;
            nextHistory = existingHistory;
            nextRevision = currentRevision;
          }
          figurePlans.push({ figureId, row, session, nextEditLog, nextRevision, nextHistory });
        });
      }

      if (revisionConflicts.length > 0) {
        const hasMissingPrecondition = revisionConflicts.some(conflict => conflict.reason === 'precondition_required');
        const hasEditLogConflict = revisionConflicts.some(conflict => conflict.reason === 'edit_log_mismatch');
        return res.status(409).json({
          status: 'conflict',
          code: hasMissingPrecondition
            ? 'PROJECT_SAVE_PRECONDITION_REQUIRED'
            : hasEditLogConflict
              ? 'PROJECT_SAVE_EDIT_LOG_CONFLICT'
              : 'PROJECT_SAVE_REVISION_CONFLICT',
          message: '项目 Figure 已被较新的编辑更新，本次旧状态保存未写入。请等待同步完成后重试。',
          projectId,
          conflicts: revisionConflicts,
          applied: [],
        });
      }

      if (rejected.length > 0 || warnings.length > 0) {
        return res.status(409).json({
          status: 'conflict',
          message: '项目保存包含未通过可信 Figure manifest 预检的编辑，本次保存未写入。',
          projectId,
          applied: [],
          rejected,
          warnings,
        });
      }

      getDb().transaction(() => {
        if (spec) {
          const script = spec.custom_script || spec.script || '';
          updateProject(req.params.id, userId, name, spec, script);
        } else {
          getDb().prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?')
            .run(name, req.params.id, userId);
        }
        figurePlans.forEach(({ row, session, nextEditLog, nextRevision, nextHistory }) => {
          saveSession(
            row.session_id,
            userId,
            session?.script || existing.script || '',
            session?.dataPayload || null,
            nextEditLog,
            nextRevision,
          );
          getDb().prepare(`
            UPDATE project_figures
            SET revision = ?, edit_log = ?, history = ?
            WHERE session_id = ?
          `).run(nextRevision, JSON.stringify(nextEditLog), JSON.stringify(nextHistory), row.session_id);
        });
      })();
      res.json({
        status: 'success',
        figures: figurePlans.map(({ figureId, nextEditLog, nextRevision }) => ({
          figureId,
          revision: nextRevision,
          editLogHash: fnv1a(stableStringifyForExport(nextEditLog)),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectMutation?.();
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      if (projectMutationGate.isBlocked(projectId)) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在恢复导出状态，暂时不能删除。',
        });
      }
      deleteProjectFigures(projectId);
      deleteProject(projectId, userId);

      // Physically delete project directories
      const projectDir = projectRootDir(projectId);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // --- Project Dataset Files API ---
  function requireOwnedProjectBeforeUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
    let userId: string;
    try {
      userId = authenticatedUserId(req);
    } catch (err: any) {
      return res.status(401).json({ status: 'error', message: err.message || 'Unauthorized' });
    }
    const projectId = req.params.id;
    try {
      assertSafeProjectId(projectId);
    } catch (err: any) {
      return res.status(400).json({ status: 'error', message: err.message || '无效的项目 ID' });
    }
    if (!getProject(projectId, userId)) {
      return res.status(404).json({ status: 'error', message: '项目不存在' });
    }
    next();
  }

  app.get('/api/projects/:id/files', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const datasets = listProjectFiles(projectId);
      res.json({ status: 'success', datasets });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/projects/:id/files/:fileId/preview', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      const fileId = req.params.fileId;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
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
      const rows = await loadDatasetRows(dataset.filePath, limit, req);

      res.json({
        status: 'success',
        dataset: {
          datasetId: dataset.datasetId,
          fileName: dataset.fileName,
          columns: dataset.columns,
          rowCount: dataset.rowCount,
          uploadedAt: dataset.uploadedAt,
        },
        rows,
        returnedRows: rows.length,
        totalRows: dataset.rowCount,
        limit,
      });
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/files', requireOwnedProjectBeforeUpload, uploadRateLimit, upload.single('file'), async (req, res) => {
    let filePersisted = false;
    let releaseProjectBlock: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const file = req.file;
      if (!file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded' });
      }
      releaseProjectBlock = projectMutationGate.tryBlock(projectId);
      if (!releaseProjectBlock) {
        try { fs.unlinkSync(file.path); } catch { /* rejected upload was not registered */ }
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在导出、恢复或变更数据，请等待完成后再上传。',
        });
      }
      const projectIdle = await projectMutationGate.waitForIdle(projectId, 30_000);
      if (!projectIdle) {
        try { fs.unlinkSync(file.path); } catch { /* timed-out upload was not registered */ }
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目仍有正在执行的渲染、编辑或导出任务，请等待完成后再上传。',
        });
      }
      assertHourlyByteBudget(req, res, 'upload_bytes', file.size);
      assertProjectOwnedStorageBudgets(projectId, userId, file.size);
      await assertValidUploadedDataFile(file.path, file.originalname);
      const existingSizes = listProjectFiles(projectId).map(dataset => {
        try {
          return fs.statSync(resolveDatasetAbsolutePath(dataset.filePath)).size;
        } catch {
          return 0;
        }
      });
      assertProjectStorageBudget(existingSizes, file.size);
      const userSizes = listProjects(userId).flatMap(userProject =>
        listProjectFiles(userProject.id).map(dataset => {
          try {
            return fs.statSync(resolveDatasetAbsolutePath(dataset.filePath)).size;
          } catch {
            return 0;
          }
        }),
      );
      assertUserStorageBudget(userSizes, file.size);

      let columns: string[] = [];
      let rowCount = 0;

      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
        const delimiter = ext === '.tsv' ? '\t' : ',';
        const parsed = await inspectDelimitedFile(file.path, delimiter);
        columns = parsed.columns;
        rowCount = parsed.rowCount;
      } else if (ext === '.xlsx' || ext === '.xls') {
        const parsed = await parseWorkbookIsolated(file.path, 'metadata', { req });
        columns = parsed.columns;
        rowCount = parsed.rowCount;
      } else {
        fs.unlinkSync(file.path);
        return res.status(400).json({ status: 'error', message: 'Unsupported file format' });
      }

      const fileId = randomUUID();
      const storedPath = path.relative(process.cwd(), file.path).replace(/\\/g, '/');

      addProjectFile(fileId, projectId, file.originalname, storedPath, columns, rowCount);
      filePersisted = true;

      res.json({
        status: 'success',
        fileId,
        fileName: file.originalname,
        columns,
        rowCount
      });
    } catch (err: any) {
      if (!filePersisted && req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { /* unregistered upload already absent */ }
      }
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectBlock?.();
    }
  });

  app.delete('/api/projects/:id/files/:fileId', async (req, res) => {
    let releaseProjectBlock: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const { id: projectId, fileId } = req.params;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      releaseProjectBlock = projectMutationGate.tryBlock(projectId);
      if (!releaseProjectBlock) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在导出、恢复或变更数据，暂时不能删除数据文件。',
        });
      }
      const projectIdle = await projectMutationGate.waitForIdle(projectId, 30_000);
      if (!projectIdle) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目仍有正在执行的渲染、编辑或导出任务，请等待完成后再删除数据文件。',
        });
      }
      const fileRecord = getProjectFile(fileId);
      if (fileRecord && fileRecord.project_id === projectId) {
        const absPath = safeResolveUnder(
          projectFilesDir(projectId),
          resolveDatasetAbsolutePath(fileRecord.stored_path),
        );
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
        }
      }
      deleteProjectFile(projectId, fileId);
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectBlock?.();
    }
  });

  // --- Project Figures Render API ---
  app.post('/api/projects/:id/figures/render', renderRateLimit, deploymentJobHandler('render', async (req, res) => {
    let releaseProjectMutation: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const projectRow = getProject(projectId, userId);
      if (!projectRow) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      releaseProjectMutation = projectMutationGate.tryBegin(projectId);
      if (!releaseProjectMutation) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在恢复导出状态，请等待恢复完成后再同步渲染。',
        });
      }
      let { script, editLogs } = req.body;
      if (!script) {
        return res.status(400).json({ status: 'error', message: 'script is required' });
      }
      script = cleanScript(script);
      const language = inferScriptLanguage(script, req.body.language || req.body.scriptLanguage);

      if (language === 'python') {
        // AST gate applies to Python only. R uses the R renderer contract.
        const astCheck = await validateAst(script, req);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
        }
      }

      let projectSpec: Record<string, unknown> = {};
      try {
        projectSpec = typeof projectRow.spec === 'string'
          ? JSON.parse(projectRow.spec)
          : (projectRow.spec || {});
      } catch {
        projectSpec = {};
      }

      const datasets = listProjectFiles(projectId);
      const projectDataPayload = await buildProjectDataPayload(datasets);
      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath);
      });

      const cwd = projectFilesDir(projectId);
      fs.mkdirSync(cwd, { recursive: true });

      // Read existing figure bindings before render so omitted editLogs still
      // participate in the returned SVG/manifest, not only in persisted state.
      const oldFigRows = listProjectFigures(projectId);
      const legacySpecEditLog = parseStoredArray(projectSpec.editLog);
      const canUseLegacySpecFallback = oldFigRows.length === 1 && legacySpecEditLog.length > 0;
      const oldEditLogMap: Record<string, any[]> = {};
      const oldSessionMap: Record<string, any> = {};
      for (const row of oldFigRows) {
        const key = `fig_${row.figure_index + 1}`;
        const sess = loadSession(row.session_id, userId);
        oldEditLogMap[key] = resolveProjectFigureEditLog(
          row,
          sess,
          legacySpecEditLog,
          canUseLegacySpecFallback,
        ).editLog;
        if (sess) {
          oldSessionMap[key] = sess;
        }
      }
      const effectiveEditLogs = { ...oldEditLogMap, ...(editLogs || {}) };
      const compressedEditLogs: Record<string, EditEntry[]> = {};
      for (const key of Object.keys(effectiveEditLogs)) {
        compressedEditLogs[key] = compressEditLog(effectiveEditLogs[key]);
      }

      let result: any;
      if (language === 'r') {
        const activeEditLog = compressedEditLogs.fig_1 || [];
        const rResult = await spawnRWithPayload({
          script,
          dataPayload: projectDataPayload,
          cwd: cwd.replace(/\\/g, '/'),
          uploaded_file_paths: prepareUploadedFilePathsForR(uploaded_file_paths, cwd),
          editLog: activeEditLog,
          renderOptions: { width_in: 7, height_in: 5 }
        }, { req, label: 'project-r-render' });
        result = rResult.status === 'success'
          ? {
              status: 'success',
              figures: [{
                figureId: 'fig_1',
                svg: rResult.svg,
                manifest: rResult.manifest,
                fingerprint: hashString(rResult.svg || ''),
                editLog: activeEditLog,
                revision: 1,
                codeSlice: null,
              }],
              warnings: rResult.warnings || [],
              language: 'r',
            }
          : rResult;
      } else {
        result = await spawnPythonWithPayload('introspector.py', {
          script,
          dataPayload: projectDataPayload,
          cwd: cwd.replace(/\\/g, '/'),
          uploaded_file_paths,
          editLogs: compressedEditLogs,
          renderOptions: { dpi: 150 }
        }, { req, label: 'project-render' });
      }

      if (result.status === 'success') {
        // Detect figure count drift
        const newFigures = result.figures || [];
        const manifestPrecheckWarnings: any[] = [];
        if (language === 'python') {
          for (const fig of newFigures) {
            const figureId = String(fig.figureId || '');
            const patches = compressedEditLogs[figureId] || [];
            if (patches.length === 0) continue;
            const knownEditLog = oldEditLogMap[figureId] || [];
            const precheck = precheckRenderedProjectFigureEditLog(
              fig.manifest,
              patches,
              knownEditLog,
              figureId,
            );
            manifestPrecheckWarnings.push(...precheck.warnings);
          }
        }
        const rendererConflicts = collectRendererReplayConflictsByFigure(
          result.warnings,
          compressedEditLogs,
        );
        const replayWarnings = [
          ...manifestPrecheckWarnings,
          ...rendererConflicts.map(conflict => ({ ...conflict.warning, figureId: conflict.figureId })),
        ];
        if (replayWarnings.length > 0) {
          return res.json({
            status: 'conflict',
            code: 'RENDERER_EDIT_REPLAY_REJECTED',
            message: '项目编辑记录未通过当前 Figure 身份或 renderer 重放确认，本次脚本与 Figure 状态均未写入。',
            figures: [],
            applied: [],
            rejected: [
              ...manifestPrecheckWarnings.map(warning => (
                compressedEditLogs[warning.figureId]?.[warning.patchIndex]
              )).filter(Boolean),
              ...rendererConflicts.map(conflict => conflict.patch),
            ],
            warnings: replayWarnings,
          });
        }
        const oldCount = oldFigRows.length;
        const newCount = newFigures.length;
        const figureCountChanged = oldCount > 0 && oldCount !== newCount;

        // Prepare figures and sessions input for transaction helper
        const figInputs: FigSessionInput[] = [];
        for (let i = 0; i < newFigures.length; i++) {
          const fig = newFigures[i];
          fig.manifest = withRenderDiagnostics(
            fig.manifest,
            renderDiagnosticsSourceForFigure(result, fig),
          );
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
            revision: oldSessionMap[figKey]?.revision || 1,
            previewSvg: fig.svg || null,
            manifest: fig.manifest || null,
            codeSlice: fig.codeSlice ?? null,
            fingerprint: fig.fingerprint ?? null,
          });
          fig.revision = oldSessionMap[figKey]?.revision || 1;
          fig.editLog = preservedEditLog;
        }

        // Atomically replace figures and sessions using the database transaction helper
        replaceProjectFiguresAndSessions(
          projectId,
          userId,
          figInputs,
          language === 'r' ? rSessionScript(script) : script,
          projectDataPayload,
          {
            name: projectRow.name,
            spec: projectSpec,
            script,
          },
        );

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
          const sess = loadSession(row.session_id, userId);
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
          const sess = loadSession(figSessionId, userId);
          if (sess) {
            (sess as any)._fingerprint = fig.fingerprint;
            persistSession(sess);
          }
        }
      }

      res.json(result);
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectMutation?.();
    }
  }));

  // GET /api/projects/:id/figures — list project figures metadata
  app.get('/api/projects/:id/figures', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const figures = listProjectFigures(projectId);
      const pickerDatasets = listProjectFiles(projectId);
      const pickerScript = project.script || (() => {
        try {
          const parsedSpec = JSON.parse(project.spec || '{}');
          return parsedSpec.custom_script || parsedSpec.script || '';
        } catch {
          return '';
        }
      })();
      const pickerLanguage = inferScriptLanguage(pickerScript);
      const referencedDataFiles = extractScriptDataFileNames(pickerScript);
      const availableDataFileNames = new Set(pickerDatasets.map(dataset => dataset.fileName.toLocaleLowerCase()));
      const missingDataFiles = referencedDataFiles.filter(name => !availableDataFileNames.has(name.toLocaleLowerCase()));
      const dependencyStatus = missingDataFiles.length > 0
        ? 'missing'
        : referencedDataFiles.length > 0 ? 'complete' : 'unknown';
      const attachPickerMetadata = (target: any, manifest?: any, svg?: string | null) => {
        Object.assign(target, {
          language: pickerLanguage,
          dataFileCount: pickerDatasets.length,
          dependencyStatus,
          missingDataFiles,
          ...summarizeFigureForPicker(manifest, svg),
        });
      };
      const resultFigures: any[] = [];
      for (const fig of figures) {
        const session = loadSession(fig.session_id, userId);
        if (session) {
          const resultFigure: any = {
            figureId: `fig_${fig.figure_index + 1}`,
            index: fig.figure_index,
            editLog: session.editLog,
            revision: session.revision,
            hasPreview: Boolean(fig.preview_svg),
            previewUpdatedAt: fig.preview_updated_at || null,
          };
          attachPickerMetadata(resultFigure);
          resultFigures.push(resultFigure);
        }
      }

      if (String(req.query.includePreview || '') === '1' && resultFigures.length > 0) {
        const forcePreview = String(req.query.forcePreview || '') === '1';
        const cachedById = new Map(figures.map((fig: any) => [`fig_${fig.figure_index + 1}`, fig]));
        if (!forcePreview) {
          let allCached = true;
          resultFigures.forEach(fig => {
            const row = cachedById.get(fig.figureId) as any;
            if (row?.preview_svg) {
              fig.svg = row.preview_svg;
              fig.manifest = row.manifest ? JSON.parse(row.manifest) : null;
              fig.codeSlice = row.code_slice ? JSON.parse(row.code_slice) : null;
              fig.fingerprint = row.fingerprint ?? null;
              fig.previewUpdatedAt = row.preview_updated_at || null;
              fig.previewSource = 'cache';
              attachPickerMetadata(fig, fig.manifest, fig.svg);
            } else {
              allCached = false;
            }
          });
          if (allCached) {
            return res.json({ status: 'success', figures: resultFigures, previewSource: 'cache' });
          }
        }

        try {
          const firstSession = loadSession(figures[0].session_id, userId);
          const script = firstSession?.script || project.script || (() => {
            try {
              const spec = JSON.parse(project.spec || '{}');
              return spec.custom_script || spec.script || '';
            } catch {
              return '';
            }
          })();
          if (!script) {
            return res.json({ status: 'success', figures: resultFigures, previewWarning: '项目没有可渲染脚本' });
          }

          const language = inferScriptLanguage(script);
          const datasets = listProjectFiles(projectId);
          const projectDataPayload = await buildProjectDataPayload(datasets);
          const uploaded_file_paths: Record<string, string> = {};
          datasets.forEach(d => addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath));
          const cwd = projectFilesDir(projectId);
          fs.mkdirSync(cwd, { recursive: true });

          const editLogs: Record<string, EditEntry[]> = {};
          for (const row of figures) {
            const figureId = `fig_${row.figure_index + 1}`;
            const session = loadSession(row.session_id, userId);
            editLogs[figureId] = compressEditLog(session?.editLog || []);
          }

          let previewResult: any;
          if (language === 'r') {
            const rResult = await spawnRWithPayload({
              script,
              dataPayload: projectDataPayload,
              cwd: cwd.replace(/\\/g, '/'),
              uploaded_file_paths: prepareUploadedFilePathsForR(uploaded_file_paths, cwd),
              editLog: editLogs.fig_1 || [],
              renderOptions: { width_in: 7, height_in: 5 }
            }, { req, label: 'project-figure-preview-r' });
            previewResult = rResult.status === 'success'
              ? {
                  status: 'success',
                  figures: [{
                    figureId: 'fig_1',
                    svg: rResult.svg,
                    manifest: rResult.manifest,
                    codeSlice: null,
                  }],
                }
              : rResult;
          } else {
            previewResult = await spawnPythonWithPayload('introspector.py', {
              script,
              dataPayload: projectDataPayload,
              cwd: cwd.replace(/\\/g, '/'),
              uploaded_file_paths,
              editLogs,
              renderOptions: { dpi: 120 }
            }, { req, label: 'project-figure-preview' });
          }

          if (previewResult.status === 'success') {
            const previewById = new Map((previewResult.figures || []).map((fig: any) => [fig.figureId, fig]));
            const updatePreviewStmt = getDb().prepare(`
              UPDATE project_figures
              SET preview_svg = ?, manifest = ?, code_slice = ?, fingerprint = ?, preview_updated_at = datetime('now')
              WHERE project_id = ? AND figure_index = ?
            `);
            resultFigures.forEach(fig => {
              const preview = previewById.get(fig.figureId) as any;
              if (preview) {
                preview.manifest = withRenderDiagnostics(
                  preview.manifest,
                  renderDiagnosticsSourceForFigure(previewResult, preview),
                );
                fig.svg = preview.svg || null;
                fig.manifest = preview.manifest || null;
                fig.codeSlice = preview.codeSlice ?? null;
                fig.fingerprint = preview.fingerprint;
                fig.previewSource = 'rendered';
                attachPickerMetadata(fig, fig.manifest, fig.svg);
                updatePreviewStmt.run(
                  preview.svg || null,
                  preview.manifest ? JSON.stringify(preview.manifest) : null,
                  preview.codeSlice ? JSON.stringify(preview.codeSlice) : null,
                  preview.fingerprint !== undefined && preview.fingerprint !== null ? String(preview.fingerprint) : null,
                  projectId,
                  fig.index
                );
              }
            });
          } else {
            return res.json({
              status: 'success',
              figures: resultFigures,
              previewWarning: previewResult.message || 'Figure 预览生成失败',
            });
          }
        } catch (previewErr: any) {
          return res.json({
            status: 'success',
            figures: resultFigures,
            previewWarning: previewErr?.message || 'Figure 预览生成失败',
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
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const exportsRoot = projectExportsDir(projectId);
      const assets = listExportAssets(projectId).map(asset => {
        const absPath = safeResolveUnder(exportsRoot, asset.filePath);
        let sizeBytes = 0;
        if (fs.existsSync(absPath)) {
          sizeBytes = fs.statSync(absPath).size;
        }
        return {
          ...asset,
          sizeBytes,
          downloadUrl: `/api/projects/${projectId}/export-assets/${asset.assetId}/file`,
        };
      });
      res.json({ status: 'success', assets });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/export-assets', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const assets = listProjects(userId).flatMap(project => {
        const exportsRoot = projectExportsDir(project.id);
        return listExportAssets(project.id).map(asset => {
          const absPath = safeResolveUnder(exportsRoot, asset.filePath);
          const fileExists = fs.existsSync(absPath);
          return {
            ...asset,
            projectName: project.name,
            fileExists,
            sizeBytes: fileExists ? fs.statSync(absPath).size : 0,
            downloadUrl: `/api/projects/${project.id}/export-assets/${asset.assetId}/file`,
          };
        });
      }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json({ status: 'success', assets });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/export-assets/zip', downloadRateLimit, deploymentJobHandler('archive', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const assetIds = new Set(Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : []);
      if (assetIds.size === 0) {
        return res.status(400).json({ status: 'error', message: '未选择任何导出资产' });
      }
      assertArchiveBudget(assetIds.size, []);
      const selected = listProjects(userId).flatMap(project =>
        listExportAssets(project.id)
          .filter(asset => assetIds.has(asset.assetId))
          .map(asset => ({ project, asset })),
      );
      if (selected.length === 0) {
        return res.status(404).json({ status: 'error', message: '未找到选中的资产' });
      }

      const files = selected.flatMap(({ project, asset }) => {
        const root = projectExportsDir(project.id);
        const absPath = safeResolveUnder(root, asset.filePath);
        if (!fs.existsSync(absPath)) return [];
        return [{
          absPath,
          sizeBytes: fs.statSync(absPath).size,
          archiveName: `${safeExportName(project.name)}/${safeExportName(asset.name)}_${asset.assetId.slice(-8)}.${asset.format}`,
        }];
      });
      if (files.length === 0) {
        return res.status(404).json({ status: 'error', message: '选中的导出文件不存在' });
      }
      assertArchiveBudget(assetIds.size, files.map(file => file.sizeBytes));
      assertHourlyByteBudget(req, res, 'download_bytes', files.reduce((sum, file) => sum + file.sizeBytes, 0));

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename=scifigure_exports.zip');
      const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
      for (const file of files) {
        archive.file(file.absPath, { name: file.archiveName });
      }
      await finalizeArchiveResponse(archive, req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
      }
    }
  }));

  app.delete('/api/export-assets', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const assetIds = new Set(Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : []);
      let deleted = 0;
      for (const project of listProjects(userId)) {
        const assets = listExportAssets(project.id).filter(asset => assetIds.has(asset.assetId));
        if (assets.length === 0) continue;
        const root = projectExportsDir(project.id);
        for (const asset of assets) {
          const absPath = safeResolveUnder(root, asset.filePath);
          if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        }
        deleted += deleteExportAssets(project.id, assets.map(asset => asset.assetId));
      }
      res.json({ status: 'success', deleted });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/projects/:id/export-assets/:assetId/file', downloadRateLimit, (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const asset = getExportAsset(req.params.assetId);
      if (!asset || asset.projectId !== projectId) {
        return res.status(404).json({ status: 'error', message: '导出资产不存在' });
      }
      const root = projectExportsDir(projectId);
      const absPath = safeResolveUnder(root, asset.filePath);
      if (!absPath.startsWith(root + path.sep) || !fs.existsSync(absPath)) {
        return res.status(404).json({ status: 'error', message: '导出文件不存在' });
      }
      assertHourlyByteBudget(req, res, 'download_bytes', fs.statSync(absPath).size);
      res.setHeader('Content-Type', exportMimeType(asset.format));
      res.download(absPath, `${safeExportName(asset.name)}.${asset.format}`);
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/export-assets/:assetId/restore', renderRateLimit, async (req, res) => {
    let releaseProjectBlock: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) return res.status(404).json({ status: 'error', message: '项目不存在' });
      const asset = getExportAsset(req.params.assetId);
      if (!asset || asset.projectId !== projectId) {
        return res.status(404).json({ status: 'error', message: '导出资产不存在' });
      }
      const storedSnapshot = getExportAssetSnapshot(asset.assetId, projectId);
      if (!storedSnapshot) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_UNAVAILABLE',
          message: '该资产由旧版本或外部组合流程生成，没有可恢复的编辑状态。',
        });
      }
      const actualHash = crypto.createHash('sha256').update(storedSnapshot.snapshotJson).digest('hex');
      if (actualHash !== storedSnapshot.snapshotHash) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_INTEGRITY_ERROR',
          message: '导出状态快照完整性校验失败，已停止恢复。',
        });
      }
      let rawSnapshot: unknown;
      try { rawSnapshot = JSON.parse(storedSnapshot.snapshotJson); } catch { rawSnapshot = null; }
      const snapshot = parseExportEditingSnapshot(rawSnapshot);
      if (
        !snapshot
        || snapshot.schemaVersion !== storedSnapshot.schemaVersion
        || snapshot.projectId !== projectId
        || snapshot.targetFigureId !== storedSnapshot.figureId
      ) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_INVALID',
          message: '导出状态快照与当前项目不匹配，已停止恢复。',
        });
      }

      releaseProjectBlock = projectMutationGate.tryBlock(projectId);
      if (!releaseProjectBlock) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_RESTORE_BUSY',
          message: '该项目已有恢复任务正在执行，请等待完成后重试。',
        });
      }
      const projectIdle = await projectMutationGate.waitForIdle(projectId, 30_000);
      if (!projectIdle) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_PROJECT_BUSY',
          message: '项目仍有正在执行的渲染、编辑或导出任务，请等待完成后重试恢复。',
        });
      }

      const currentRows = listProjectFigures(projectId);
      if (snapshot.schemaVersion === 1 && snapshot.figures.length > 1) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_LEGACY_MULTI_FIGURE_UNSAFE',
          message: '该旧版多 Figure 快照没有保存各 Figure 的独立脚本，已停止恢复以避免覆盖项目内容。',
        });
      }
      const expectedByIndex = new Map<number, ExportFigureSnapshotV1 | ExportFigureSnapshotV2>(
        snapshot.figures.map(figure => [
          figure.index,
          figure,
        ] as [number, ExportFigureSnapshotV1 | ExportFigureSnapshotV2]),
      );
      const structureMatches = currentRows.length === snapshot.figures.length
        && currentRows.every(row => expectedByIndex.has(row.figure_index));
      if (!structureMatches) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_FIGURE_STRUCTURE_CHANGED',
          message: '项目的 Figure 数量或结构已变化，无法保证无损恢复。现有项目未被修改。',
        });
      }

      const datasetIssues = findExportSnapshotDatasetIssues(snapshot.datasets, listProjectFiles(projectId));
      if (datasetIssues.length > 0) {
        return res.status(409).json({
          status: 'error',
          code: 'EXPORT_SNAPSHOT_DATA_MISMATCH',
          message: '原始数据文件已变化，无法保证恢复结果与导出时一致。现有项目未被修改。',
          issues: datasetIssues,
        });
      }
      const checkedScripts = new Set<string>();
      for (const figure of snapshot.figures) {
        const figureScript = 'script' in figure ? figure.script : snapshot.projectScript;
        const figureLanguage = 'scriptLanguage' in figure ? figure.scriptLanguage : snapshot.scriptLanguage;
        const checkKey = `${figureLanguage}:${figureScript}`;
        if (checkedScripts.has(checkKey)) continue;
        checkedScripts.add(checkKey);
        if (figureLanguage === 'python') {
          const astCheck = await validateAst(figureScript, req);
          if (!astCheck.ok) {
            return res.status(400).json({
              status: 'error',
              code: 'EXPORT_SNAPSHOT_SCRIPT_REJECTED',
              message: `${figure.figureId} 快照脚本安全校验失败: ${astCheck.message || ''}`,
              errors: astCheck.errors,
            });
          }
        } else {
          const rRisk = validateRScriptRisk(figureScript, req);
          if (!rRisk.ok) {
            return res.status(400).json({
              status: 'error',
              code: 'EXPORT_SNAPSHOT_SCRIPT_REJECTED',
              message: `${figure.figureId}: ${rRisk.message || 'R 脚本风险预检失败'}`,
              findings: rRisk.findings,
            });
          }
        }
      }

      const releases: Array<() => void> = [];
      for (const row of currentRows) {
        const idle = await figureMutationGate.waitForIdle(row.session_id, 30_000);
        if (!idle) {
          releases.reverse().forEach(release => release());
          return res.status(409).json({
            status: 'error',
            code: 'EXPORT_SNAPSHOT_FIGURE_BUSY',
            message: '项目仍有正在执行的编辑请求，请等待完成后重试恢复。',
          });
        }
        releases.push(figureMutationGate.begin(row.session_id));
      }

      try {
        const currentStates = currentRows.map(row => {
          const session = loadSession(row.session_id, userId);
          if (!session) throw new Error(`当前 Figure 会话不存在: fig_${row.figure_index + 1}`);
          return { row, session };
        });
        const replayCheck = await dryRunExportEditingSnapshot({ snapshot, projectId, req });
        if (!replayCheck.ok) {
          return res.status(409).json({
            status: 'error',
            code: 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
            message: '导出状态快照无法被当前 renderer 完整重放，现有项目未被修改。',
            issues: replayCheck.issues,
          });
        }
        const restoredRevisions: Record<string, number> = {};
        const checkpointTimestamp = Date.now();
        const database = getDb();
        database.transaction(() => {
          const restoredSpec = {
            ...snapshot.projectSpec,
            custom_script: snapshot.projectScript,
            script_language: snapshot.scriptLanguage,
          };
          database.prepare(`
            UPDATE projects
            SET spec = ?, script = ?, updated_at = datetime('now')
            WHERE id = ? AND user_id = ?
          `).run(JSON.stringify(restoredSpec), snapshot.projectScript, projectId, userId);

          for (const { row, session } of currentStates) {
            const figureSnapshot = expectedByIndex.get(row.figure_index);
            if (!figureSnapshot) throw new Error(`快照缺少 Figure: fig_${row.figure_index + 1}`);
            const figureScript = 'script' in figureSnapshot
              ? figureSnapshot.script
              : snapshot.projectScript;
            const nextRevision = Math.max(session.revision || 1, row.revision || 1) + 1;
            const currentHistory = parseStoredHistory(row.history);
            const checkpoint = {
              editLog: session.editLog,
              script: session.script,
              label: `恢复导出状态前：${asset.name}`,
              timestamp: checkpointTimestamp,
              changeType: 'system',
            };
            const nextHistory = {
              past: [...currentHistory.past, checkpoint].slice(-50),
              future: [],
            };
            database.prepare(`
              UPDATE sessions
              SET script = ?, edit_log = ?, revision = ?, updated_at = datetime('now')
              WHERE id = ? AND user_id = ?
            `).run(
              figureScript,
              JSON.stringify(figureSnapshot.editLog),
              nextRevision,
              row.session_id,
              userId,
            );
            database.prepare(`
              UPDATE project_figures
              SET revision = ?, edit_log = ?, history = ?,
                  preview_svg = NULL, manifest = NULL, code_slice = NULL,
                  fingerprint = NULL, preview_updated_at = NULL
              WHERE project_id = ? AND figure_index = ?
            `).run(
              nextRevision,
              JSON.stringify(figureSnapshot.editLog),
              JSON.stringify(nextHistory),
              projectId,
              row.figure_index,
            );
            restoredRevisions[figureSnapshot.figureId] = nextRevision;
          }
        })();

        return res.json({
          status: 'success',
          projectId,
          targetFigureId: snapshot.targetFigureId,
          capturedAt: snapshot.capturedAt,
          restoredRevisions,
          message: '已恢复到导出时的编辑状态，并保存恢复前检查点。',
        });
      } finally {
        releases.reverse().forEach(release => release());
      }
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectBlock?.();
    }
  });

  app.delete('/api/projects/:id/export-assets', (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const assetIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const assets = listExportAssets(projectId).filter(asset => assetIds.includes(asset.assetId));
      const root = projectExportsDir(projectId);
      for (const asset of assets) {
        const absPath = safeResolveUnder(root, asset.filePath);
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

  app.post('/api/projects/:id/export-assets/zip', downloadRateLimit, deploymentJobHandler('archive', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      const assetIds = new Set(Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : []);
      if (assetIds.size === 0) {
        return res.status(400).json({ status: 'error', message: '未选择任何导出资产' });
      }
      assertArchiveBudget(assetIds.size, []);
      const assets = listExportAssets(projectId).filter(asset => assetIds.has(asset.assetId));
      if (assets.length === 0) {
        return res.status(404).json({ status: 'error', message: '未找到选中的资产' });
      }

      const root = projectExportsDir(projectId);
      const files = assets.flatMap(asset => {
        const absPath = safeResolveUnder(root, asset.filePath);
        if (!absPath.startsWith(root + path.sep) || !fs.existsSync(absPath)) return [];
        return [{
          absPath,
          sizeBytes: fs.statSync(absPath).size,
          archiveName: `${safeExportName(asset.name)}.${asset.format}`,
        }];
      });
      if (files.length === 0) {
        return res.status(404).json({ status: 'error', message: '选中的导出文件不存在' });
      }
      assertArchiveBudget(assetIds.size, files.map(file => file.sizeBytes));
      assertHourlyByteBudget(req, res, 'download_bytes', files.reduce((sum, file) => sum + file.sizeBytes, 0));

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=exports_${projectId.slice(0, 8)}.zip`);

      const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
      for (const file of files) {
        archive.file(file.absPath, { name: file.archiveName });
      }
      await finalizeArchiveResponse(archive, req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
      }
    }
  }));

  app.post('/api/projects/:id/export-assets/import', uploadRateLimit, meterExportAssetImport, (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
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
      const importedPngLimit = boundedNumber(
        process.env.SCIFIGURE_IMPORTED_PNG_MAX_BYTES,
        32 * 1024 * 1024,
        64 * 1024,
        64 * 1024 * 1024,
      );
      const safeBinaryB64 = binaryB64
        ? decodeAndValidatePngBase64(binaryB64, importedPngLimit).toString('base64')
        : undefined;
      const importedSvgLimit = boundedNumber(
        process.env.SCIFIGURE_IMPORTED_SVG_MAX_BYTES,
        12 * 1024 * 1024,
        64 * 1024,
        32 * 1024 * 1024,
      );
      const safeSvg = svg ? assertSafeSvgDocument(svg, importedSvgLimit) : undefined;
      const rawThumbnailSvg = typeof req.body?.thumbnailSvg === 'string'
        ? req.body.thumbnailSvg
        : safeSvg || null;
      const safeThumbnailSvg = rawThumbnailSvg
        ? assertSafeSvgDocument(rawThumbnailSvg, importedSvgLimit)
        : null;
      const rawMetadata = req.body?.metadata;
      const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
        ? rawMetadata as Record<string, unknown>
        : { kind: 'client-imported-export' };
      if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 64 * 1024) {
        const error = new Error('导出资产元数据不能超过 64 KB');
        (error as any).statusCode = 413;
        throw error;
      }
      const tags = Array.isArray(req.body?.tags)
        ? req.body.tags.slice(0, 32).map((tag: unknown) => String(tag).slice(0, 64))
        : ['composite'];
      const asset = persistProjectExportAsset({
        projectId,
        figureId: req.body?.figureId || 'composite',
        name: req.body?.name || '组合图',
        format,
        dpi: req.body?.dpi ?? null,
        svg: safeSvg,
        binaryB64: safeBinaryB64,
        thumbnailSvg: safeThumbnailSvg,
        metadata,
        tags,
      });
      res.json({ status: 'success', asset });
    } catch (err: any) {
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/projects/:id/compose', renderRateLimit, deploymentJobHandler('composition', async (req, res) => {
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      assertSafeProjectId(projectId);
      if (!getProject(projectId, userId)) {
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
      const sourceAssetSnapshots = buildCompositionSourceSnapshots(selected);
      const sourceFigureRevisions = Object.fromEntries(
        sourceAssetSnapshots
          .filter(item => item.figureId && item.figureId !== 'composite')
          .map(item => [item.figureId, item.revision])
      );
      const sourceAssetRevisions = Object.fromEntries(
        sourceAssetSnapshots.map(item => [item.assetId, item.revision])
      );
      const layoutWithSourceSnapshot = layout ? {
        ...layout,
        sourceAssetIds: selected.map(item => item.assetId),
        sourceAssetSnapshots,
        sourceFigureRevisions,
        sourceAssetRevisions,
      } : null;
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
          sourceAssetSnapshots,
          sourceFigureRevisions,
          sourceAssetRevisions,
          layout: layoutWithSourceSnapshot,
          createdBy: 'figure-composer',
        },
        tags: ['composite'],
      });
      res.json({ status: 'success', svg, asset, assets: [asset] });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  }));

  // POST /api/projects/:id/export — export single or all project figures
  app.post('/api/projects/:id/export', renderRateLimit, downloadRateLimit, deploymentJobHandler('export', async (req, res) => {
    const newlyPersistedAssets: ExportAsset[] = [];
    let cleanupProjectId: string | null = null;
    let releaseProjectBlock: (() => void) | null = null;
    try {
      const userId = authenticatedUserId(req);
      const projectId = req.params.id;
      cleanupProjectId = projectId;
      assertSafeProjectId(projectId);
      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ status: 'error', message: '项目不存在' });
      }
      releaseProjectBlock = projectMutationGate.tryBlock(projectId);
      if (!releaseProjectBlock) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目正在导出、恢复或变更数据，请等待完成后再导出。',
        });
      }
      const projectIdle = await projectMutationGate.waitForIdle(projectId, 30_000);
      if (!projectIdle) {
        return res.status(409).json({
          status: 'error',
          code: 'PROJECT_STATE_BUSY',
          message: '项目仍有正在执行的渲染、编辑或数据任务，请等待完成后再导出。',
        });
      }
      const { figureId, format, dpi, name, saveToLibrary = true, includeSubplots = false } = req.body;
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
      const projectData = getProject(projectId, userId);
      const script = projectData?.script || '';

      // AST gate
      if (script) {
        const astCheck = await validateAst(script, req);
        if (!astCheck.ok) {
          return res.status(400).json({ status: 'error', message: '脚本安全校验失败: ' + (astCheck.message || ''), details: astCheck.message, errors: astCheck.errors });
        }
      }
      const datasets = listProjectFiles(projectId);
      const exportDatasetCapture = saveToLibrary !== false
        ? captureExportDatasetSnapshots(datasets)
        : { snapshots: [], warnings: [] };
      const projectDataPayload = await buildProjectDataPayload(datasets);

      const uploaded_file_paths: Record<string, string> = {};
      datasets.forEach(d => {
        addUploadedFilePathAliases(uploaded_file_paths, d.fileName, d.filePath);
      });

      const cwd = projectFilesDir(projectId);

      const renderedTargets: Array<{
        session: any;
        targetFigId: string;
        exportEditLog: EditEntry[];
        matchedFig: any;
        targetWarnings: any[];
      }> = [];
      for (const fig of targetFigs) {
        const session = loadSession(fig.session_id, userId);
        if (!session) continue;
        const exportEditLog = compressEditLog(mergePreviewGlobalsIntoEditLog(
          session.editLog,
          fig.manifest,
        ));

        const targetFigId = `fig_${fig.figure_index + 1}`;
        const result = await spawnPythonWithPayload('introspector.py', {
          script: session.script,
          dataPayload: projectDataPayload || session.dataPayload || null,
          cwd: cwd.replace(/\\/g, '/'),
          uploaded_file_paths,
          editLogs: { [targetFigId]: exportEditLog },
          renderOptions: { dpi: dpi || 300 },
          export_format: reqFormat !== 'svg' ? reqFormat : undefined,
        }, { req, label: 'project-export', maxOutputMb: 64 });

        if (result.status === 'success') {
          const matchedFig = result.figures?.find((f: any) => f.figureId === targetFigId) || result;
          const targetWarnings = Array.isArray(result.warnings)
            ? result.warnings.filter((warning: any) => !warning?.figureId || warning.figureId === targetFigId)
            : [];
          const replayWarnings = targetWarnings.filter(isSnapshotReplayWarning);
          if (replayWarnings.length > 0) {
            return res.status(409).json({
              status: 'conflict',
              code: 'EXPORT_REPLAY_CONFLICT',
              message: `${targetFigId} 存在未能完整重放的编辑，导出和编辑快照均未保存。`,
              figureId: targetFigId,
              warnings: targetWarnings,
              replayWarnings,
            });
          }
          renderedTargets.push({
            session,
            targetFigId,
            exportEditLog,
            matchedFig,
            targetWarnings,
          });
        }
      }

      for (const renderedTarget of renderedTargets) {
          const {
            session,
            targetFigId,
            exportEditLog,
            matchedFig,
            targetWarnings,
          } = renderedTarget;
          const assetName = figureId ? (name || targetFigId) : targetFigId;
          const exportAnchor = buildExportEditLogAnchor(exportEditLog);
          const effectiveFigureFormat = matchedFig.binary_b64 ? reqFormat : 'svg';
          const effectiveFigureDpi = rasterExportDpi(effectiveFigureFormat, dpi);
          const editingSnapshot = saveToLibrary !== false
            ? buildExportEditingSnapshot({
                project,
                userId,
                targetFigureId: targetFigId,
                targetEditLog: exportEditLog,
                datasets: exportDatasetCapture.snapshots,
                requestedFormat: reqFormat,
                effectiveFormat: effectiveFigureFormat,
                dpi: effectiveFigureDpi,
              })
            : undefined;
          let asset: ExportAsset | null = null;
          if (saveToLibrary !== false) {
            asset = persistProjectExportAsset({
              projectId,
              figureId: targetFigId,
              name: assetName,
              format: effectiveFigureFormat,
              dpi: effectiveFigureDpi,
              svg: matchedFig.svg,
              binaryB64: matchedFig.binary_b64 || null,
              thumbnailSvg: matchedFig.svg,
              metadata: {
                exportedFrom: targetFigId,
                requestedFormat: reqFormat,
                revision: session?.revision || 1,
                ...(exportDatasetCapture.warnings.length > 0
                  ? { snapshotWarnings: exportDatasetCapture.warnings }
                  : {}),
                ...exportAnchor,
              },
              tags: ['figure'],
              editingSnapshot,
            });
            newlyPersistedAssets.push(asset);
          }
          const subplotAssets: ExportAsset[] = [];
          const subplotFormatNotes: string[] = [];
          if (saveToLibrary !== false && includeSubplots) {
            const subplotPanels = buildSubplotSvgExports(matchedFig.svg, matchedFig.manifest);
            for (const [panelIndex, panel] of subplotPanels.entries()) {
              let subplotFormat = 'svg';
              let subplotBinaryB64: string | null = null;
              let subplotFormatNote = '';
              if (effectiveFigureFormat !== 'svg') {
                const converted = await spawnPythonWithPayload('svg_convert.py', {
                  svg: panel.svg,
                  format: effectiveFigureFormat,
                  dpi: dpi || 300,
                }, { req, label: 'subplot-svg-export', maxOutputMb: 64 });
                if (converted.status === 'success' && converted.binary_b64) {
                  subplotFormat = converted.format || effectiveFigureFormat;
                  subplotBinaryB64 = converted.binary_b64;
                } else {
                  subplotFormatNote = converted.message || `子图 ${panel.subplotId} 无法导出 ${effectiveFigureFormat}，已回退为 SVG`;
                  subplotFormatNotes.push(subplotFormatNote);
                }
              }
              const subplotAsset = persistProjectExportAsset({
                projectId,
                figureId: `${targetFigId}:${panel.subplotId}`,
                name: `${assetName}_panel_${panelIndex + 1}`,
                format: subplotFormat,
                dpi: rasterExportDpi(subplotFormat, dpi),
                svg: panel.svg,
                binaryB64: subplotBinaryB64,
                thumbnailSvg: panel.svg,
                metadata: {
                  exportedFrom: targetFigId,
                  subplotId: panel.subplotId,
                  panelIndex,
                  cropMode: 'axes_bounds',
                  requestedFormat: reqFormat,
                  effectiveFormat: subplotFormat,
                  revision: session?.revision || 1,
                  ...exportAnchor,
                  note: 'Subplot export is cropped to the recognized axes bounds. External titles, legends, labels, and colorbars outside the axes box may require a future include-labels crop mode.',
                  formatNote: subplotFormatNote || undefined,
                  bounds: panel.bounds,
                },
                tags: ['subplot', 'axes-bounds'],
                editingSnapshot,
              });
              subplotAssets.push(subplotAsset);
              newlyPersistedAssets.push(subplotAsset);
            }
          }
          results.push({
            figureId: targetFigId,
            svg: matchedFig.svg,
            binary_b64: matchedFig.binary_b64 || null,
            format: effectiveFigureFormat,
            warnings: targetWarnings,
            asset,
            subplotAssets,
            subplot_format_notes: subplotFormatNotes,
          });
      }

      const responsePayload = {
        status: 'success',
        figures: results
      };
      assertHourlyByteBudget(
        req,
        res,
        'download_bytes',
        Buffer.byteLength(JSON.stringify(responsePayload), 'utf8'),
      );
      res.json(responsePayload);
    } catch (err: any) {
      if (cleanupProjectId) removeNewExportAssets(cleanupProjectId, newlyPersistedAssets);
      res.status(Number(err?.statusCode || 500)).json({ status: 'error', message: err.message });
    } finally {
      releaseProjectBlock?.();
    }
  }));

  app.use(apiErrorHandler);

  // Vite middleware for development
  let viteServer: any = null;
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import('vite');
    const requestedHmrPort = Number(process.env.SCIFIGURE_VITE_HMR_PORT);
    const isolatedHmr = Number.isInteger(requestedHmrPort) && requestedHmrPort > 0
      ? { host: '127.0.0.1', port: requestedHmrPort, clientPort: requestedHmrPort }
      : undefined;
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : isolatedHmr,
      },
      appType: "spa",
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.SCIFIGURE_DIST_DIR
      ? path.resolve(process.env.SCIFIGURE_DIST_DIR)
      : path.join(process.cwd(), 'dist', 'public');
    const blockedStaticExtensions = new Set([
      '.cjs', '.map', '.db', '.sqlite', '.sqlite3', '.env', '.pem', '.key', '.ts', '.tsx',
    ]);
    app.use((req, res, next) => {
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(req.path).replace(/\\/g, '/');
      } catch {
        res.sendStatus(404);
        return;
      }
      const segments = decodedPath.split('/').filter(Boolean);
      const basename = (segments.at(-1) || '').toLowerCase();
      if (
        segments.some(segment => segment.startsWith('.'))
        || blockedStaticExtensions.has(path.extname(basename).toLowerCase())
      ) {
        res.sendStatus(404);
        return;
      }
      next();
    });
    app.use(express.static(distPath, { dotfiles: 'deny', fallthrough: true, index: false }));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, BIND_HOST, () => {
    console.log(`Server running on http://${BIND_HOST}:${PORT}`);
  });

  let shutdownStarted = false;
  async function waitForAllDeploymentJobs(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const requestJobsIdle = deploymentLifecycle.waitForIdle(timeoutMs);
    while (Date.now() < deadline) {
      const renderState = renderWorkQueue.snapshot();
      if (renderState.active === 0 && renderState.queued === 0 && activeRendererAborters.size === 0) {
        return await requestJobsIdle;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function gracefulShutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;
    deploymentLifecycle.setMode('draining', 'deployment');
    const timeoutMs = boundedNumber(process.env.SCIFIGURE_GRACEFUL_SHUTDOWN_MS, 180_000, 5_000, 600_000);
    console.log(`[deployment] ${signal}: draining started; active=${JSON.stringify(deploymentState())}`);
    const serverClosed = new Promise<boolean>(resolve => {
      httpServer.close(error => resolve(!error));
    });
    const idle = await waitForAllDeploymentJobs(timeoutMs);
    if (!idle) {
      console.error(`[deployment] graceful timeout after ${timeoutMs}ms; active=${JSON.stringify(deploymentState())}`);
      renderWorkQueue.cancelQueued('Render queue canceled during deployment shutdown');
      for (const abort of [...activeRendererAborters]) {
        try { abort(); } catch { /* worker already stopped */ }
      }
      (httpServer as any).closeAllConnections?.();
    }
    await Promise.race([
      serverClosed,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (viteServer) await viteServer.close().catch(() => {});
    process.exit(idle ? 0 : 1);
  }

  process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
}

startServer().catch((error) => {
  console.error('CRITICAL: Server startup failed:', error);
  process.exitCode = 1;
});
