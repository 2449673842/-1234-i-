import type express from 'express';
import crypto from 'crypto';
import os from 'os';
import {
  getDb,
  getErrorReportById,
  getLicenseState,
  getUserByEmail,
  getUserById,
  listErrorReports,
  upsertErrorReport,
  verifyPasswordAndMigrate,
  type UserAccount,
  type ErrorReportSeverity,
  type ErrorReportSummary,
} from '../../db';

type AuthContext = { user: UserAccount; token: string; deviceId: string | null };
type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export interface AdminConsoleDeps {
  requireAuth: (req: express.Request) => AuthContext;
  requireAdmin: (req: express.Request) => AuthContext;
  adminRateLimit: Middleware;
  errorReportRateLimit: Middleware;
  writeAdminAudit: (req: express.Request, input: {
    actorUserId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    success: boolean;
    statusCode: number;
    metadata?: Record<string, unknown>;
  }) => void;
  rendererSnapshot: () => { active: number; queued: number; workers: number; concurrency: number };
}

const ALLOWED_SOURCES = new Set(['client', 'render', 'renderer', 'editor', 'export', 'import']);
const ALLOWED_SEVERITIES = new Set(['info', 'warning', 'error', 'critical']);
const ALLOWED_STATUSES = new Set(['open', 'triaged', 'resolved', 'ignored']);
const SENSITIVE_KEY_PATTERN = /(script|data|dataset|payload|trace|traceback|stack|path|file|content|token|password|secret|cookie|authorization)/i;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|etc|opt|root|mnt|Volumes)\/)/;
const ADMIN_REAUTH_PURPOSE = 'subscription_adjustment';
const ALLOWED_SUBSCRIPTION_PLANS = new Set(['free', 'pro']);
const ALLOWED_SUBSCRIPTION_STATUSES = new Set(['active', 'paused', 'expired']);

function adminConsoleEnabled(): boolean {
  return process.env.SCIFIGURE_ADMIN_CONSOLE_ENABLED === '1';
}

function clampPage(value: unknown): number {
  return Math.max(1, Math.floor(Number(value || 1)));
}

function clampPageSize(value: unknown): number {
  return Math.max(1, Math.min(100, Math.floor(Number(value || 25))));
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutPaths = trimmed.replace(ABSOLUTE_PATH_PATTERN, '[redacted-path]');
  return withoutPaths.slice(0, maxLength);
}

function normalizeSource(value: unknown): string {
  const source = boundedText(value, 32) || 'client';
  if (source === 'renderer') return 'render';
  return ALLOWED_SOURCES.has(source) ? source : 'client';
}

function normalizeSeverity(value: unknown): ErrorReportSeverity {
  const severity = boundedText(value, 16) || 'error';
  return ALLOWED_SEVERITIES.has(severity) ? severity as ErrorReportSeverity : 'error';
}

function queryText(value: unknown, maxLength = 120): string | null {
  const text = boundedText(value, maxLength);
  return text ? text.replace(/[%_]/g, '') : null;
}

function sanitizeRoute(value: unknown): string | null {
  const route = boundedText(value, 160);
  if (!route) return null;
  if (/^https?:\/\//i.test(route)) {
    try {
      const url = new URL(route);
      return `${url.pathname}${url.search}`.slice(0, 160);
    } catch {
      return null;
    }
  }
  if (ABSOLUTE_PATH_PATTERN.test(route)) return null;
  return route;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(output).length >= 16) break;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (typeof raw === 'string') {
      const text = boundedText(raw, 160);
      if (text && !ABSOLUTE_PATH_PATTERN.test(text)) output[key.slice(0, 40)] = text;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key.slice(0, 40)] = raw;
    } else if (typeof raw === 'boolean') {
      output[key.slice(0, 40)] = raw;
    }
  }
  return output;
}

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

function tokenHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function adminReauthTtlMs(): number {
  const configured = Number(process.env.SCIFIGURE_ADMIN_REAUTH_TTL_MS || 5 * 60 * 1000);
  return Math.max(1_000, Math.min(10 * 60 * 1000, Number.isFinite(configured) ? configured : 5 * 60 * 1000));
}

function normalizeIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, '到期时间格式无效');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw httpError(400, '到期时间格式无效');
  return new Date(timestamp).toISOString();
}

function safeRequestId(value: unknown): string {
  const requestId = boundedText(value, 120);
  if (!requestId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(requestId)) {
    throw httpError(400, 'requestId 格式无效');
  }
  return requestId;
}

function userAgentFamily(req: express.Request): string {
  const value = String(req.headers['user-agent'] || '');
  if (/playwright/i.test(value)) return 'Playwright';
  if (/edg\//i.test(value)) return 'Edge';
  if (/chrome\//i.test(value)) return 'Chrome';
  if (/firefox\//i.test(value)) return 'Firefox';
  if (/safari\//i.test(value)) return 'Safari';
  if (/node|undici/i.test(value)) return 'Node client';
  return os.platform();
}

function publicSubmittedErrorReport(report: ReturnType<typeof upsertErrorReport>) {
  return {
    id: report.id,
    source: report.source,
    severity: report.severity,
    status: report.status,
    title: report.title,
    message: report.message,
    component: report.component,
    operation: report.operation,
    errorName: report.errorName,
    errorCode: report.errorCode,
    route: report.route,
    clientVersion: report.clientVersion,
    userAgentFamily: report.userAgentFamily,
    occurrenceCount: report.occurrenceCount,
    metadata: report.metadata,
    firstSeenAt: report.firstSeenAt,
    lastSeenAt: report.lastSeenAt,
  };
}

function rejectSensitiveBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const json = JSON.stringify(body);
  if (json.length > 16_384) return true;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' && ABSOLUTE_PATH_PATTERN.test(value);
    }
    if (Array.isArray(value)) return value.some(visit);
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      if (key !== 'metadata' && SENSITIVE_KEY_PATTERN.test(key)) return true;
      return visit(child);
    });
  };
  return visit(body);
}

function countTable(table: string): number {
  return Number((getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count || 0);
}

function overview(rendererSnapshot: AdminConsoleDeps['rendererSnapshot']) {
  const db = getDb();
  const errorCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
    FROM error_reports
  `).get() as { total: number; open: number | null };
  const activity = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE datetime(COALESCE(last_login_at, created_at)) > datetime('now', '-24 hours')) AS activeUsers24h,
      (SELECT COUNT(*) FROM error_reports WHERE datetime(last_seen_at) > datetime('now', '-24 hours') AND (source IN ('render', 'renderer') OR operation LIKE '%render%')) AS renderFailures24h,
      (SELECT COUNT(*) FROM admin_audit_logs WHERE datetime(created_at) > datetime('now', '-24 hours') AND success = 0) AS adminFailures24h
  `).get() as { activeUsers24h: number; renderFailures24h: number; adminFailures24h: number };
  const memory = process.memoryUsage();
  return {
    counts: {
      users: countTable('users'),
      projects: countTable('projects'),
      figures: countTable('project_figures'),
      files: countTable('project_files'),
      exports: countTable('export_assets'),
      errorReports: Number(errorCounts.total || 0),
      openErrors: Number(errorCounts.open || 0),
    },
    activity: {
      activeUsers24h: Number(activity.activeUsers24h || 0),
      renderFailures24h: Number(activity.renderFailures24h || 0),
      adminFailures24h: Number(activity.adminFailures24h || 0),
    },
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
    renderer: rendererSnapshot(),
    collectedAt: new Date().toISOString(),
  };
}

function suggestedRepairContext(report: ErrorReportSummary): { codeAreas: string[]; checks: string[] } {
  const codeAreas = new Set<string>(['src/utils/clientErrorReporter.ts']);
  const checks = [
    'Use event identifiers and the sanitized summary to reproduce the failure without requesting user scripts or datasets.',
    'Locate the component, operation and errorCode call path, then add a regression test before changing behavior.',
    'Verify that the fix preserves project ownership, file boundaries and existing Python/R behavior.',
  ];
  if (report.source === 'render' || report.source === 'renderer') {
    codeAreas.add('src/hooks/useFigureSession.ts');
    codeAreas.add('renderer/introspector.py');
    codeAreas.add('renderer/r_renderer.R');
    checks.push('Compare Python and R renderer outcomes and inspect manifest generation before changing shared frontend targeting.');
  }
  if (report.source === 'editor') {
    codeAreas.add('src/components/ChartPreview.tsx');
    codeAreas.add('src/components/RightSidebar.tsx');
  }
  if (report.source === 'export') codeAreas.add('src/utils/exportPreviewState.ts');
  return { codeAreas: [...codeAreas], checks };
}

function aiRepairPackage(report: ErrorReportSummary) {
  const suggested = suggestedRepairContext(report);
  return {
    schemaVersion: 'scifigure.error-handoff.v1',
    generatedAt: new Date().toISOString(),
    eventId: report.id,
    source: report.source,
    severity: report.severity,
    status: report.status,
    title: report.title || 'Untitled platform error',
    message: report.message || 'No sanitized message was recorded.',
    errorName: report.errorName,
    errorCode: report.errorCode,
    component: report.component,
    operation: report.operation,
    route: report.route,
    projectId: report.projectId,
    figureId: report.figureId,
    clientVersion: report.clientVersion,
    userAgentFamily: report.userAgentFamily,
    occurrenceCount: report.occurrenceCount,
    firstSeenAt: report.firstSeenAt,
    lastSeenAt: report.lastSeenAt,
    metadata: sanitizeMetadata(report.metadata),
    suggestedCodeAreas: suggested.codeAreas,
    suggestedChecks: suggested.checks,
    privacyBoundary: {
      classification: 'sanitized-diagnostic-only',
      excluded: [
        'user scripts and datasets',
        'traceback and stack content',
        'images, SVG and exported files',
        'passwords, tokens, cookies and authorization headers',
        'absolute server and local filesystem paths',
        'full device fingerprints',
      ],
    },
  };
}

function aiRepairMarkdown(pkg: ReturnType<typeof aiRepairPackage>): string {
  const value = (input: unknown) => input === null || input === undefined || input === '' ? 'Not recorded' : String(input);
  return [
    '# SciFigure AI Repair Handoff',
    '',
    `- Schema: \`${pkg.schemaVersion}\``,
    `- Event: \`${pkg.eventId}\``,
    `- Generated: ${pkg.generatedAt}`,
    `- Source / severity / status: ${pkg.source} / ${pkg.severity} / ${pkg.status}`,
    `- Component / operation: ${value(pkg.component)} / ${value(pkg.operation)}`,
    `- Error code: ${value(pkg.errorCode)}`,
    `- Project / Figure: ${value(pkg.projectId)} / ${value(pkg.figureId)}`,
    `- Occurrences: ${pkg.occurrenceCount} (${pkg.firstSeenAt} to ${pkg.lastSeenAt})`,
    '',
    '## Sanitized Failure',
    '',
    `**${pkg.title}**`,
    '',
    pkg.message,
    '',
    '## Allowed Metadata',
    '',
    '```json',
    JSON.stringify(pkg.metadata, null, 2),
    '```',
    '',
    '## Suggested Code Areas',
    '',
    ...pkg.suggestedCodeAreas.map(item => `- \`${item}\``),
    '',
    '## Verification Checks',
    '',
    ...pkg.suggestedChecks.map(item => `- ${item}`),
    '',
    '## Privacy Boundary',
    '',
    'This package contains sanitized diagnostics only. Do not request or infer excluded user content.',
    ...pkg.privacyBoundary.excluded.map(item => `- Excluded: ${item}`),
    '',
  ].join('\n');
}

function listSubscriptions(req: express.Request) {
  const page = clampPage(req.query.page);
  const pageSize = clampPageSize(req.query.pageSize);
  const query = queryText(req.query.query || req.query.q);
  const whereSql = query ? 'WHERE u.email LIKE ? OR u.display_name LIKE ? OR u.id LIKE ?' : '';
  const params = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
  const total = Number((getDb().prepare(`SELECT COUNT(*) AS count FROM users u ${whereSql}`).get(...params) as { count: number }).count || 0);
  const rows = getDb().prepare(`
    SELECT
      u.id AS user_id, u.email, u.display_name,
      sub.id AS subscription_id, sub.plan, sub.status, sub.starts_at, sub.ends_at,
      sub.source, sub.actor_user_id, sub.change_reason, sub.admin_note, sub.created_at,
      (SELECT COUNT(*) FROM subscriptions history WHERE history.user_id = u.id) AS history_count
    FROM users u
    LEFT JOIN subscriptions sub ON sub.id = (
      SELECT candidate.id FROM subscriptions candidate
      WHERE candidate.user_id = u.id
      ORDER BY CASE WHEN candidate.status = 'active' THEN 0 ELSE 1 END,
        candidate.rowid DESC
      LIMIT 1
    )
    ${whereSql}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return {
    items: rows.map(row => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name ?? null,
      subscriptionId: row.subscription_id ?? null,
      plan: row.plan ?? 'free',
      status: row.status ?? 'none',
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
      source: row.source ?? 'none',
      actorUserId: row.actor_user_id ?? null,
      changeReason: row.change_reason ?? null,
      adminNote: row.admin_note ?? null,
      createdAt: row.created_at ?? null,
      historyCount: Number(row.history_count || 0),
    })),
    total,
    page,
    pageSize,
  };
}

function listUsers(req: express.Request) {
  const page = clampPage(req.query.page);
  const pageSize = clampPageSize(req.query.pageSize);
  const role = req.query.role === 'admin' || req.query.role === 'user' ? String(req.query.role) : null;
  const query = queryText(req.query.query || req.query.q);
  const where: string[] = [];
  const params: unknown[] = [];
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  if (query) {
    where.push('(u.email LIKE ? OR u.display_name LIKE ? OR u.id LIKE ?)');
    const like = `%${query}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM users u
    ${whereSql}
  `).get(...params) as { count: number }).count || 0);
  const rows = getDb().prepare(`
    SELECT
      u.id, u.email, u.display_name, u.role, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projectCount,
      (
        SELECT COUNT(*)
        FROM project_figures fig
        INNER JOIN projects p ON p.id = fig.project_id
        WHERE p.user_id = u.id
      ) AS figureCount,
      (
        SELECT COUNT(*)
        FROM project_files pf
        INNER JOIN projects p ON p.id = pf.project_id
        WHERE p.user_id = u.id
      ) AS fileCount,
      (
        SELECT COUNT(*)
        FROM export_assets ea
        INNER JOIN projects p ON p.id = ea.project_id
        WHERE p.user_id = u.id
      ) AS exportCount,
      (
        SELECT COUNT(*)
        FROM auth_sessions auth
        WHERE auth.user_id = u.id AND datetime(auth.expires_at) > datetime('now')
      ) AS sessionCount,
      (SELECT COUNT(*) FROM subscriptions sub WHERE sub.user_id = u.id) AS subscriptionCount,
      (
        SELECT sub.plan FROM subscriptions sub WHERE sub.user_id = u.id
        ORDER BY CASE WHEN sub.status = 'active' THEN 0 ELSE 1 END,
          sub.rowid DESC
        LIMIT 1
      ) AS subscriptionPlan,
      (
        SELECT sub.status FROM subscriptions sub WHERE sub.user_id = u.id
        ORDER BY CASE WHEN sub.status = 'active' THEN 0 ELSE 1 END,
          sub.rowid DESC
        LIMIT 1
      ) AS subscriptionStatus,
      (
        SELECT sub.ends_at FROM subscriptions sub WHERE sub.user_id = u.id
        ORDER BY CASE WHEN sub.status = 'active' THEN 0 ELSE 1 END,
          sub.rowid DESC
        LIMIT 1
      ) AS subscriptionEndsAt
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize) as any[];
  return {
    items: rows.map(row => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? null,
      role: row.role === 'admin' ? 'admin' : 'user',
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at ?? null,
      projectCount: Number(row.projectCount || 0),
      figureCount: Number(row.figureCount || 0),
      fileCount: Number(row.fileCount || 0),
      exportCount: Number(row.exportCount || 0),
      activeSessionCount: Number(row.sessionCount || 0),
      subscriptionPlan: row.subscriptionPlan ?? null,
      subscriptionStatus: row.subscriptionStatus ?? null,
      subscriptionEndsAt: row.subscriptionEndsAt ?? null,
      aggregates: {
        projects: Number(row.projectCount || 0),
        figures: Number(row.figureCount || 0),
        files: Number(row.fileCount || 0),
        exports: Number(row.exportCount || 0),
        sessions: Number(row.sessionCount || 0),
        subscriptions: Number(row.subscriptionCount || 0),
      },
      subscription: row.subscriptionCount
        ? { plan: row.subscriptionPlan ?? null, status: row.subscriptionStatus ?? null }
        : null,
    })),
    total,
    page,
    pageSize,
  };
}

function auditFailure(
  deps: AdminConsoleDeps,
  req: express.Request,
  err: any,
  action: string,
  resourceType: string,
  actorUserId: string | null,
  resourceId?: string | null,
) {
  const statusCode = Number(err?.statusCode || 500);
  deps.writeAdminAudit(req, {
    actorUserId: actorUserId || err?.actorUserId || null,
    action,
    resourceType,
    resourceId: resourceId ?? null,
    success: false,
    statusCode,
    metadata: { reason: statusCode === 401 ? 'unauthenticated' : statusCode === 403 ? 'forbidden' : 'request_failed' },
  });
  return statusCode;
}

function adminReadHandler(
  deps: AdminConsoleDeps,
  action: string,
  resourceType: string,
  handler: (req: express.Request, auth: AuthContext) => Record<string, unknown>,
) {
  return (req: express.Request, res: express.Response) => {
    if (!adminConsoleEnabled()) {
      return res.status(404).json({ status: 'error', message: 'Not found' });
    }
    let actorUserId: string | null = null;
    try {
      const auth = deps.requireAdmin(req);
      actorUserId = auth.user.id;
      const payload = handler(req, auth);
      deps.writeAdminAudit(req, {
        actorUserId,
        action,
        resourceType,
        resourceId: typeof req.params.id === 'string' ? req.params.id : null,
        success: true,
        statusCode: 200,
        metadata: { query: sanitizeMetadata(req.query) },
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ status: 'success', ...payload });
    } catch (err: any) {
      const statusCode = auditFailure(deps, req, err, action, resourceType, actorUserId, req.params.id);
      return res.status(statusCode).json({ status: 'error', message: err.message });
    }
  };
}

export function installAdminConsoleRoutes(app: express.Express, deps: AdminConsoleDeps): void {
  app.post('/api/error-reports', deps.errorReportRateLimit, (req, res) => {
    try {
      const auth = deps.requireAuth(req);
      if (rejectSensitiveBody(req.body)) {
        return res.status(400).json({ status: 'error', message: 'Error report contains disallowed sensitive fields' });
      }
      const title = boundedText(req.body?.title, 160);
      const message = boundedText(req.body?.message, 600);
      if (!title || !message) {
        return res.status(400).json({ status: 'error', message: 'Error report title and message are required' });
      }
      const report = upsertErrorReport({
        userId: auth.user.id,
        source: normalizeSource(req.body?.source),
        severity: normalizeSeverity(req.body?.severity),
        title,
        message,
        component: boundedText(req.body?.component, 120),
        operation: boundedText(req.body?.operation, 120),
        errorName: boundedText(req.body?.errorName || req.body?.name, 120),
        errorCode: boundedText(req.body?.errorCode || req.body?.code, 80),
        route: sanitizeRoute(req.body?.route),
        projectId: boundedText(req.body?.projectId, 120),
        figureId: boundedText(req.body?.figureId, 120),
        clientVersion: boundedText(req.body?.clientVersion, 80),
        userAgentFamily: userAgentFamily(req),
        metadata: sanitizeMetadata(req.body?.metadata),
      });
      return res.json({ status: 'success', report: publicSubmittedErrorReport(report) });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode || 500);
      return res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/admin/overview', deps.adminRateLimit, adminReadHandler(
    deps,
    'admin_console.overview.read',
    'admin_overview',
    () => ({ overview: overview(deps.rendererSnapshot) }),
  ));

  app.get('/api/admin/users', deps.adminRateLimit, adminReadHandler(
    deps,
    'admin_console.users.read',
    'user',
    (req) => listUsers(req),
  ));

  app.get('/api/admin/error-reports', deps.adminRateLimit, adminReadHandler(
    deps,
    'admin_console.error_reports.read',
    'error_report',
    (req) => {
      const source = queryText(req.query.source, 32);
      const severity = queryText(req.query.severity, 16);
      const status = queryText(req.query.status, 16);
      const result = listErrorReports({
        page: clampPage(req.query.page),
        pageSize: clampPageSize(req.query.pageSize),
        source: source && ALLOWED_SOURCES.has(source) ? (source === 'renderer' ? 'render' : source) : null,
        severity: severity && ALLOWED_SEVERITIES.has(severity) ? severity : null,
        status: status && ALLOWED_STATUSES.has(status) ? status : null,
        query: queryText(req.query.query || req.query.q),
      });
      return { items: result.reports, total: result.total, page: result.page, pageSize: result.pageSize };
    },
  ));

  app.get('/api/admin/error-reports/:id/ai-handoff', deps.adminRateLimit, (req, res) => {
    if (!adminConsoleEnabled()) return res.status(404).json({ status: 'error', message: 'Not found' });
    let actorUserId: string | null = null;
    try {
      const auth = deps.requireAdmin(req);
      actorUserId = auth.user.id;
      const id = boundedText(req.params.id, 120);
      const report = id ? getErrorReportById(id) : null;
      if (!report) throw httpError(404, 'Error report not found');
      const pkg = aiRepairPackage(report);
      const format = req.query.format === 'markdown' ? 'markdown' : 'json';
      deps.writeAdminAudit(req, {
        actorUserId,
        action: 'admin_console.error_reports.ai_handoff',
        resourceType: 'error_report',
        resourceId: report.id,
        success: true,
        statusCode: 200,
        metadata: { format },
      });
      res.setHeader('Cache-Control', 'no-store');
      if (format === 'markdown') {
        res.type('text/markdown; charset=utf-8');
        return res.send(aiRepairMarkdown(pkg));
      }
      return res.json({ status: 'success', repairPackage: pkg });
    } catch (err: any) {
      const statusCode = auditFailure(deps, req, err, 'admin_console.error_reports.ai_handoff', 'error_report', actorUserId, req.params.id);
      return res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/admin/error-reports/:id', deps.adminRateLimit, adminReadHandler(
    deps,
    'admin_console.error_reports.detail',
    'error_report',
    (req) => {
      const id = boundedText(req.params.id, 120);
      const report = id ? getErrorReportById(id) : null;
      if (!report) {
        const err = new Error('Error report not found');
        (err as any).statusCode = 404;
        throw err;
      }
      return { report };
    },
  ));

  app.get('/api/admin/subscriptions', deps.adminRateLimit, adminReadHandler(
    deps,
    'admin_console.subscriptions.read',
    'subscription',
    (req) => listSubscriptions(req),
  ));

  app.post('/api/admin/reauth', deps.adminRateLimit, async (req, res) => {
    if (!adminConsoleEnabled()) return res.status(404).json({ status: 'error', message: 'Not found' });
    let actorUserId: string | null = null;
    try {
      const auth = deps.requireAdmin(req);
      actorUserId = auth.user.id;
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password || password.length > 512) throw httpError(400, '管理员密码不能为空');
      const row = getUserByEmail(auth.user.email);
      if (!row || !(await verifyPasswordAndMigrate(row, password))) {
        throw httpError(401, '管理员密码验证失败');
      }
      const token = `sfr_${crypto.randomBytes(32).toString('base64url')}`;
      const ttlMs = adminReauthTtlMs();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const database = getDb();
      database.transaction(() => {
        database.prepare(`DELETE FROM admin_reauth_tokens WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL`).run();
        database.prepare(`
          INSERT INTO admin_reauth_tokens (id, actor_user_id, token_hash, purpose, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(`art_${crypto.randomUUID()}`, auth.user.id, tokenHash(token), ADMIN_REAUTH_PURPOSE, expiresAt);
      })();
      deps.writeAdminAudit(req, {
        actorUserId,
        action: 'admin_console.reauth',
        resourceType: 'admin_session',
        resourceId: auth.user.id,
        success: true,
        statusCode: 200,
        metadata: { purpose: ADMIN_REAUTH_PURPOSE, expiresInSeconds: ttlMs / 1000 },
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ status: 'success', reauthToken: token, expiresAt });
    } catch (err: any) {
      const statusCode = auditFailure(deps, req, err, 'admin_console.reauth', 'admin_session', actorUserId, actorUserId);
      return res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/admin/users/:userId/subscription', deps.adminRateLimit, (req, res) => {
    if (!adminConsoleEnabled()) return res.status(404).json({ status: 'error', message: 'Not found' });
    let actorUserId: string | null = null;
    let targetUserId: string | null = null;
    try {
      const auth = deps.requireAdmin(req);
      actorUserId = auth.user.id;
      targetUserId = boundedText(req.params.userId, 120);
      if (!targetUserId || !getUserById(targetUserId)) throw httpError(404, '目标用户不存在');
      const plan = boundedText(req.body?.plan, 16);
      const status = boundedText(req.body?.status, 16);
      if (!plan || !ALLOWED_SUBSCRIPTION_PLANS.has(plan)) throw httpError(400, '订阅套餐无效');
      if (!status || !ALLOWED_SUBSCRIPTION_STATUSES.has(status)) throw httpError(400, '订阅状态无效');
      const endsAt = normalizeIsoDate(req.body?.endsAt);
      if (status === 'active' && endsAt && Date.parse(endsAt) <= Date.now()) {
        throw httpError(400, '有效订阅的到期时间必须晚于当前时间');
      }
      const reason = boundedText(req.body?.reason, 500);
      if (!reason || reason.length < 3) throw httpError(400, '必须填写至少 3 个字符的调整原因');
      const adminNote = boundedText(req.body?.adminNote, 500);
      const requestId = safeRequestId(req.body?.requestId);
      const reauthToken = typeof req.body?.reauthToken === 'string' ? req.body.reauthToken : '';
      if (!/^sfr_[A-Za-z0-9_-]{32,}$/.test(reauthToken)) throw httpError(401, '二次验证令牌无效');

      const database = getDb();
      const result = database.transaction(() => {
        const existing = database.prepare(`
          SELECT actor_user_id, resource_id, response_json
          FROM admin_idempotency_requests WHERE request_id = ?
        `).get(requestId) as { actor_user_id: string; resource_id: string; response_json: string } | undefined;
        if (existing) {
          if (existing.actor_user_id !== auth.user.id || existing.resource_id !== targetUserId) {
            throw httpError(409, 'requestId 已用于其他管理操作');
          }
          const replay = JSON.parse(existing.response_json);
          const original = replay?.subscription;
          if (!original
            || original.plan !== plan
            || original.status !== status
            || (original.endsAt ?? null) !== endsAt
            || original.changeReason !== reason
            || (original.adminNote ?? null) !== (adminNote ?? null)) {
            throw httpError(409, 'requestId 对应的订阅参数不一致');
          }
          return { ...replay, replayed: true };
        }

        const reauth = database.prepare(`
          SELECT id, expires_at FROM admin_reauth_tokens
          WHERE actor_user_id = ? AND token_hash = ? AND purpose = ? AND used_at IS NULL
        `).get(auth.user.id, tokenHash(reauthToken), ADMIN_REAUTH_PURPOSE) as { id: string; expires_at: string } | undefined;
        if (!reauth || Date.parse(reauth.expires_at) <= Date.now()) throw httpError(401, '二次验证已过期，请重新验证管理员密码');
        const consumed = database.prepare(`UPDATE admin_reauth_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(reauth.id);
        if (consumed.changes !== 1) throw httpError(409, '二次验证令牌已被使用');

        const previous = database.prepare(`
          SELECT id, plan, status, starts_at, ends_at, source
          FROM subscriptions WHERE user_id = ?
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, rowid DESC LIMIT 1
        `).get(targetUserId) as any | undefined;
        database.prepare(`UPDATE subscriptions SET status = 'paused' WHERE user_id = ? AND status = 'active'`).run(targetUserId);
        const subscriptionId = `sub_${crypto.randomUUID()}`;
        const startsAt = new Date().toISOString();
        database.prepare(`
          INSERT INTO subscriptions (
            id, user_id, plan, status, starts_at, ends_at, source,
            actor_user_id, change_reason, admin_note, request_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'admin_manual', ?, ?, ?, ?)
        `).run(subscriptionId, targetUserId, plan, status, startsAt, endsAt, auth.user.id, reason, adminNote, requestId);
        const payload = {
          subscription: {
            id: subscriptionId,
            userId: targetUserId,
            plan,
            status,
            startsAt,
            endsAt,
            source: 'admin_manual',
            changeReason: reason,
            adminNote,
          },
          previousSubscription: previous ? {
            id: previous.id,
            plan: previous.plan,
            status: previous.status,
            startsAt: previous.starts_at,
            endsAt: previous.ends_at,
            source: previous.source,
          } : null,
          license: getLicenseState(targetUserId),
          replayed: false,
        };
        database.prepare(`
          INSERT INTO admin_idempotency_requests (
            request_id, actor_user_id, resource_type, resource_id, response_json
          ) VALUES (?, ?, 'subscription', ?, ?)
        `).run(requestId, auth.user.id, targetUserId, JSON.stringify(payload));
        return payload;
      })();

      deps.writeAdminAudit(req, {
        actorUserId,
        action: 'admin_console.subscription.adjust',
        resourceType: 'subscription',
        resourceId: targetUserId,
        success: true,
        statusCode: 200,
        metadata: { plan, status, endsAt, reason, requestId, replayed: result.replayed },
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ status: 'success', ...result });
    } catch (err: any) {
      const statusCode = auditFailure(deps, req, err, 'admin_console.subscription.adjust', 'subscription', actorUserId, targetUserId);
      return res.status(statusCode).json({ status: 'error', message: err.message });
    }
  });
}
