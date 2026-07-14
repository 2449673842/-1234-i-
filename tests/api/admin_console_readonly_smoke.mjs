import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const localTsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const roleScript = path.join(repoRoot, 'scripts', 'security', 'set-user-role.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-admin-console-'));
const dataRoot = path.join(tempDir, 'data');
const dbPath = path.join(dataRoot, 'scifigure-test.db');
const basePort = 35_000 + Math.floor(Math.random() * 1_000);
const serverOutput = [];
const adminEmail = `admin-console-admin-${Date.now()}@example.test`;
const userEmail = `admin-console-user-${Date.now()}@example.test`;
const password = 'Admin-Console-Test-2026';

function tsxCommand(script, args = []) {
  if (fs.existsSync(localTsxCli)) {
    return { command: process.execPath, args: [localTsxCli, script, ...args], shell: false };
  }
  const packageJson = require.resolve('tsx/package.json', { paths: [repoRoot] });
  const resolvedTsxCli = path.resolve(path.dirname(packageJson), 'dist', 'cli.mjs');
  return { command: process.execPath, args: [resolvedTsxCli, script, ...args], shell: false };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function forbiddenJsonFields(value) {
  const forbidden = new Set(['password', 'password_hash', 'password_salt', 'token', 'stored_path', 'file_path', 'script', 'data_payload', 'traceback', 'stacktrace', 'authorization', 'content']);
  const hits = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.has(key.toLowerCase())) hits.add(key);
      visit(child);
    }
  };
  visit(value);
  return [...hits];
}

function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function jsonResponse(response) {
  return response.json().catch(() => null);
}

async function waitForServer(baseUrl, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(baseUrl, '/api/health/live');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not start. Output:\n${output.join('')}`);
}

function startServer(port, enabled) {
  const output = [];
  const command = tsxCommand('server.ts');
  const server = spawn(command.command, command.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SCIFIGURE_DATA_DIR: dataRoot,
      SCIFIGURE_DB_PATH: dbPath,
      SCIFIGURE_RENDER_MODE: 'docker',
      SCIFIGURE_ADMIN_CONSOLE_ENABLED: enabled ? '1' : '0',
      SCIFIGURE_ADMIN_REAUTH_TTL_MS: '1000',
      SCIFIGURE_VITE_HMR_PORT: String(port + 1_000),
      NODE_ENV: 'production',
      DISABLE_HMR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: command.shell,
  });
  server.stdout.on('data', chunk => {
    output.push(chunk.toString());
    serverOutput.push(chunk.toString());
  });
  server.stderr.on('data', chunk => {
    output.push(chunk.toString());
    serverOutput.push(chunk.toString());
  });
  return { server, output, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  const waitForClose = (timeoutMs) => {
    if (server.exitCode !== null) return Promise.resolve(true);
    return Promise.race([
      new Promise(resolve => server.once('close', () => resolve(true))),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  };
  if (server.exitCode === null) server.kill('SIGTERM');
  const closedGracefully = await waitForClose(5_000);
  if (!closedGracefully && server.exitCode === null) {
    server.kill('SIGKILL');
    await waitForClose(5_000);
  }
  await new Promise(resolve => setTimeout(resolve, 300));
}

async function removeTempDir() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`Warning: failed to remove temp dir ${tempDir}: ${error.message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function setRole(email, role) {
  const command = tsxCommand(roleScript, [
    '--email', email,
    '--role', role,
    '--reason', 'admin_console_readonly_smoke',
  ]);
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    env: { ...process.env, SCIFIGURE_DB_PATH: dbPath },
    encoding: 'utf8',
    shell: command.shell,
  });
  assert(result.status === 0, `Role provisioning failed: ${result.stderr || result.stdout}`);
}

async function register(baseUrl, email, displayName) {
  const response = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
  const data = await jsonResponse(response);
  assert(response.ok && data?.token && data?.user?.id, `Registration failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

let disabledServer;
let enabledServer;

try {
  const disabled = startServer(basePort, false);
  disabledServer = disabled.server;
  await waitForServer(disabled.baseUrl, disabled.output);
  const disabledOverview = await request(disabled.baseUrl, '/api/admin/overview');
  assert(disabledOverview.status === 404, `Disabled admin console must return 404, got ${disabledOverview.status}`);
  await stopServer(disabledServer);

  const enabled = startServer(basePort + 1, true);
  enabledServer = enabled.server;
  await waitForServer(enabled.baseUrl, enabled.output);

  const adminData = await register(enabled.baseUrl, adminEmail, 'Admin Console Admin');
  const userData = await register(enabled.baseUrl, userEmail, 'Admin Console User');
  const adminToken = adminData.token;
  const userToken = userData.token;

  const projectResponse = await request(enabled.baseUrl, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: 'Subscription safety project', spec: { script_language: 'python', custom_script: 'print("safe")' } }),
  });
  assert(projectResponse.ok, `User project fixture failed: ${projectResponse.status} ${JSON.stringify(await jsonResponse(projectResponse))}`);

  const anonymousOverview = await request(enabled.baseUrl, '/api/admin/overview');
  assert(anonymousOverview.status === 401, `Anonymous admin read must return 401, got ${anonymousOverview.status}`);

  const userOverview = await request(enabled.baseUrl, '/api/admin/overview', {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert(userOverview.status === 403, `Ordinary user admin read must return 403, got ${userOverview.status}`);

  const anonymousIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    body: JSON.stringify({ source: 'client', severity: 'error', message: 'anonymous should fail' }),
  });
  assert(anonymousIngest.status === 401, `Anonymous error report ingest must return 401, got ${anonymousIngest.status}`);

  const reportBody = {
      source: 'render',
    severity: 'error',
    title: 'Render failed in preview',
    message: 'Preview render failed with a bounded sanitized message',
    component: 'ChartPreview',
    operation: 'render.preview',
    errorName: 'RenderError',
    errorCode: 'RENDER_PREVIEW_FAILED',
    route: '/projects/demo',
    projectId: 'project-demo',
    figureId: 'fig_2',
    clientVersion: 'smoke-test',
    metadata: { browser: 'node-fetch', retryable: true },
  };
  const firstIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(reportBody),
  });
  const firstReport = await jsonResponse(firstIngest);
  assert(firstIngest.ok && firstReport?.report?.occurrenceCount === 1, `First ingest failed: ${firstIngest.status} ${JSON.stringify(firstReport)}`);

  const secondIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(reportBody),
  });
  const secondReport = await jsonResponse(secondIngest);
  assert(secondIngest.ok && secondReport?.report?.id === firstReport.report.id, 'Dedupe must return the same report id');
  assert(secondReport?.report?.occurrenceCount === 2, `Dedupe must increment occurrence_count: ${JSON.stringify(secondReport)}`);

  const sensitiveIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({
      source: 'client',
      severity: 'error',
      script: 'print("must not store")',
      traceback: 'C:\\Users\\example\\private.py',
    }),
  });
  assert(sensitiveIngest.status === 400, `Sensitive error report fields must be rejected, got ${sensitiveIngest.status}`);

  const emptyIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ source: 'client', severity: 'error', title: '', message: '' }),
  });
  assert(emptyIngest.status === 400, `Empty error reports must be rejected, got ${emptyIngest.status}`);

  setRole(adminEmail, 'admin');

  const overviewResponse = await request(enabled.baseUrl, '/api/admin/overview', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const overviewData = await jsonResponse(overviewResponse);
  assert(overviewResponse.ok && overviewData?.overview?.counts?.users >= 2, `Admin overview failed: ${overviewResponse.status} ${JSON.stringify(overviewData)}`);
  assert(typeof overviewData.overview.process.uptimeSeconds === 'number', 'Overview must include process uptime');
  assert(typeof overviewData.overview.renderer.active === 'number', 'Overview must include renderer snapshot');
  assert(overviewData.overview.counts.errorReports === 1 && overviewData.overview.counts.openErrors === 1, `Overview error counts mismatch: ${JSON.stringify(overviewData.overview.counts)}`);

  const usersResponse = await request(enabled.baseUrl, '/api/admin/users?page=1&pageSize=100&query=admin-console', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const usersData = await jsonResponse(usersResponse);
  assert(usersResponse.ok && Array.isArray(usersData?.items) && usersData.total >= 2, `Admin users failed: ${usersResponse.status} ${JSON.stringify(usersData)}`);
  assert(usersData.items.some(item => item.email === userEmail && item.aggregates), 'Users response must include safe aggregates');
  const userLeaks = forbiddenJsonFields(usersData);
  assert(userLeaks.length === 0, `Users response leaked sensitive fields: ${userLeaks.join(', ')}`);

  const reportsResponse = await request(enabled.baseUrl, '/api/admin/error-reports?source=renderer&severity=error&status=open&query=Preview&pageSize=100', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const reportsData = await jsonResponse(reportsResponse);
  assert(reportsResponse.ok && Array.isArray(reportsData?.items) && reportsData.total === 1, `Admin error reports failed: ${reportsResponse.status} ${JSON.stringify(reportsData)}`);
  assert(reportsData.items[0].occurrenceCount === 2, 'Admin error report list must show deduped occurrence count');
  assert(reportsData.items[0].projectId === 'project-demo' && reportsData.items[0].figureId === 'fig_2', 'Error report must preserve project/Figure identifiers');
  assert(!('fingerprint' in firstReport.report), 'Submitted error response must not expose fingerprint');
  assert(!('userEmail' in firstReport.report), 'Submitted error response must not expose user email');
  const reportLeaks = forbiddenJsonFields(reportsData);
  assert(reportLeaks.length === 0, `Error reports response leaked sensitive fields: ${reportLeaks.join(', ')}`);

  const detailResponse = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const detailData = await jsonResponse(detailResponse);
  assert(detailResponse.ok && detailData?.report?.id === reportsData.items[0].id, `Error report detail failed: ${detailResponse.status} ${JSON.stringify(detailData)}`);

  const anonymousHandoff = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}/ai-handoff`);
  assert(anonymousHandoff.status === 401, `Anonymous AI handoff must return 401, got ${anonymousHandoff.status}`);
  const userHandoff = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}/ai-handoff`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert(userHandoff.status === 403, `Ordinary user AI handoff must return 403, got ${userHandoff.status}`);
  const handoffResponse = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}/ai-handoff`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const handoffData = await jsonResponse(handoffResponse);
  assert(handoffResponse.ok && handoffData?.repairPackage?.schemaVersion === 'scifigure.error-handoff.v1', `AI handoff failed: ${handoffResponse.status} ${JSON.stringify(handoffData)}`);
  assert(handoffData.repairPackage.component === 'ChartPreview' && handoffData.repairPackage.operation === 'render.preview', 'AI handoff must preserve sanitized component and operation');
  assert(!('userEmail' in handoffData.repairPackage) && !('userId' in handoffData.repairPackage), 'AI handoff must not expose account identity');
  assert(forbiddenJsonFields(handoffData).length === 0, `AI handoff leaked forbidden fields: ${forbiddenJsonFields(handoffData).join(', ')}`);
  const handoffText = JSON.stringify(handoffData);
  assert(!/C:\\Users|\/srv\/|\/home\//i.test(handoffText), 'AI handoff must not expose absolute paths');

  const markdownResponse = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}/ai-handoff?format=markdown`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const markdown = await markdownResponse.text();
  assert(markdownResponse.ok && markdown.includes('# SciFigure AI Repair Handoff') && markdown.includes('ChartPreview'), 'Markdown AI handoff must be readable and structured');
  assert(!markdown.includes(userEmail) && !/C:\\Users|\/srv\/|\/home\//i.test(markdown), 'Markdown AI handoff must not expose user identity or absolute paths');

  const anonymousSubscriptions = await request(enabled.baseUrl, '/api/admin/subscriptions');
  assert(anonymousSubscriptions.status === 401, `Anonymous subscription read must return 401, got ${anonymousSubscriptions.status}`);
  const userSubscriptions = await request(enabled.baseUrl, '/api/admin/subscriptions', { headers: { Authorization: `Bearer ${userToken}` } });
  assert(userSubscriptions.status === 403, `Ordinary user subscription read must return 403, got ${userSubscriptions.status}`);
  const subscriptionsBeforeResponse = await request(enabled.baseUrl, `/api/admin/subscriptions?query=${encodeURIComponent(userEmail)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const subscriptionsBefore = await jsonResponse(subscriptionsBeforeResponse);
  assert(subscriptionsBeforeResponse.ok && subscriptionsBefore?.items?.[0]?.userId === userData.user.id, 'Admin subscription list must include target user');

  const wrongReauth = await request(enabled.baseUrl, '/api/admin/reauth', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  assert(wrongReauth.status === 401, `Wrong administrator password must return 401, got ${wrongReauth.status}`);

  const missingReason = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ plan: 'pro', status: 'active', requestId: 'subscription-missing-reason', reauthToken: `sfr_${'a'.repeat(43)}` }),
  });
  assert(missingReason.status === 400, `Missing subscription reason must return 400, got ${missingReason.status}`);
  const missingRequestId = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ plan: 'pro', status: 'active', reason: 'test reason', reauthToken: `sfr_${'a'.repeat(43)}` }),
  });
  assert(missingRequestId.status === 400, `Missing requestId must return 400, got ${missingRequestId.status}`);

  const expiringReauthResponse = await request(enabled.baseUrl, '/api/admin/reauth', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password }),
  });
  const expiringReauth = await jsonResponse(expiringReauthResponse);
  assert(expiringReauthResponse.ok && expiringReauth?.reauthToken, 'Administrator reauth must return a short-lived token');
  await new Promise(resolve => setTimeout(resolve, 1_150));
  const expiredAdjustment = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      plan: 'pro', status: 'active', endsAt: null, reason: 'verify token expiry',
      requestId: 'subscription-expired-token', reauthToken: expiringReauth.reauthToken,
    }),
  });
  assert(expiredAdjustment.status === 401, `Expired reauth token must return 401, got ${expiredAdjustment.status}`);

  const reauthResponse = await request(enabled.baseUrl, '/api/admin/reauth', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password }),
  });
  const reauth = await jsonResponse(reauthResponse);
  assert(reauthResponse.ok && reauth?.reauthToken && reauth?.expiresAt, 'Valid administrator password must create a reauth token');
  const requestId = `subscription-${Date.now()}`;
  const adjustmentBody = {
    plan: 'pro', status: 'active', endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    reason: 'Grant a seven-day test subscription', adminNote: 'Smoke test only', requestId,
    reauthToken: reauth.reauthToken,
  };
  const adjustmentResponse = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(adjustmentBody),
  });
  const adjustment = await jsonResponse(adjustmentResponse);
  assert(adjustmentResponse.ok && adjustment?.subscription?.plan === 'pro' && adjustment?.license?.isPro === true, `Subscription adjustment failed: ${adjustmentResponse.status} ${JSON.stringify(adjustment)}`);
  assert(adjustment.replayed === false, 'First subscription request must not be marked as replayed');

  const replayResponse = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(adjustmentBody),
  });
  const replay = await jsonResponse(replayResponse);
  assert(replayResponse.ok && replay?.replayed === true && replay?.subscription?.id === adjustment.subscription.id, 'Duplicate requestId must replay the original result without another change');

  const mismatchedReplay = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ...adjustmentBody, plan: 'free' }),
  });
  assert(mismatchedReplay.status === 409, `Reused requestId with different parameters must return 409, got ${mismatchedReplay.status}`);

  const tokenReuseResponse = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ...adjustmentBody, requestId: `${requestId}-different` }),
  });
  assert(tokenReuseResponse.status === 409 || tokenReuseResponse.status === 401, `Consumed reauth token must be rejected, got ${tokenReuseResponse.status}`);

  const subscriptionsAfterResponse = await request(enabled.baseUrl, `/api/admin/subscriptions?query=${encodeURIComponent(userEmail)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const subscriptionsAfter = await jsonResponse(subscriptionsAfterResponse);
  assert(subscriptionsAfterResponse.ok && subscriptionsAfter?.items?.[0]?.plan === 'pro' && subscriptionsAfter.items[0].historyCount === 1, 'Subscription list must show one idempotent Pro adjustment');
  const usersAfterResponse = await request(enabled.baseUrl, `/api/admin/users?pageSize=100&query=${encodeURIComponent(userEmail)}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const usersAfter = await jsonResponse(usersAfterResponse);
  const { subscriptions: _beforeSubscriptions, ...beforeAggregates } = usersData.items.find(item => item.email === userEmail).aggregates;
  const { subscriptions: _afterSubscriptions, ...afterAggregates } = usersAfter.items.find(item => item.email === userEmail).aggregates;
  assert(JSON.stringify(beforeAggregates) === JSON.stringify(afterAggregates), `Subscription adjustment modified user resources: ${JSON.stringify({ beforeAggregates, afterAggregates })}`);

  setRole(adminEmail, 'user');

  const demotedResponse = await request(enabled.baseUrl, '/api/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(demotedResponse.status === 403, `Demoted admin token must lose admin console access immediately, got ${demotedResponse.status}`);

  setRole(adminEmail, 'admin');
  const auditResponse = await request(enabled.baseUrl, '/api/admin/audit-logs?limit=100', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const auditData = await jsonResponse(auditResponse);
  assert(auditResponse.ok && Array.isArray(auditData?.logs), `Audit read failed: ${auditResponse.status} ${JSON.stringify(auditData)}`);
  assert(auditData.logs.some(entry => entry.action === 'admin_console.overview.read' && entry.success === true), 'Successful overview read must be audited');
  assert(auditData.logs.some(entry => entry.action === 'admin_console.overview.read' && entry.success === false && entry.statusCode === 401), 'Anonymous admin read failure must be audited');
  assert(auditData.logs.some(entry => entry.action === 'admin_console.users.read' && entry.success === false && entry.statusCode === 403), 'Demoted admin read failure must be audited');
  assert(auditData.logs.some(entry => entry.action === 'admin_console.reauth' && entry.success === false && entry.statusCode === 401), 'Failed administrator reauth must be audited');
  assert(auditData.logs.some(entry => entry.action === 'admin_console.subscription.adjust' && entry.success === true), 'Successful subscription adjustment must be audited');
  assert(auditData.logs.some(entry => entry.action === 'admin_console.error_reports.ai_handoff' && entry.success === true), 'AI repair handoff generation must be audited');
  const auditSerialized = JSON.stringify(auditData);
  assert(!auditSerialized.includes(password) && !auditSerialized.includes(reauth.reauthToken), 'Audit output must not contain administrator password or reauth token');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'disabled admin console returns 404',
      'anonymous and ordinary users cannot read admin console',
      'authenticated users can ingest sanitized error reports',
      'error reports dedupe by server fingerprint',
      'empty reports are rejected and project/Figure identifiers persist',
      'admin overview matches frontend contract',
      'users pagination omits sensitive fields',
      'error report list/detail omit sensitive fields',
      'AI repair JSON and Markdown are structured, sanitized and access controlled',
      'subscription reads and writes are admin-only',
      'subscription writes require password reauth, reason and requestId',
      'reauth tokens expire and are single-use',
      'subscription requestId replay is idempotent',
      'subscription changes preserve user project and asset aggregates',
      'admin role demotion applies immediately',
      'admin read successes and failures are audited',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    stack: error.stack,
    serverOutput: serverOutput.join('').slice(-10_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (disabledServer) await stopServer(disabledServer);
  if (enabledServer) await stopServer(enabledServer);
  await removeTempDir();
}
