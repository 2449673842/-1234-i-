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
