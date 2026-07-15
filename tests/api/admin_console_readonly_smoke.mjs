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
const otherUserEmail = `admin-console-other-${Date.now()}@example.test`;
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
  const forbidden = new Set(['password', 'password_hash', 'password_salt', 'token', 'stored_path', 'file_path', 'script', 'data_payload', 'traceback', 'stacktrace', 'authorization', 'content', 'useremail', 'fingerprint', 'svg', 'image', 'export']);
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

function insertFigureFixture(projectId, userId, figureIndexes) {
  const Database = require('better-sqlite3');
  const database = new Database(dbPath);
  try {
    const insertSession = database.prepare(`
      INSERT INTO sessions (id, user_id, script, data_payload, edit_log, revision)
      VALUES (?, ?, ?, NULL, '[]', 1)
    `);
    const insertFigure = database.prepare(`
      INSERT INTO project_figures (
        id, project_id, figure_index, session_id, revision, preview_svg, manifest, code_slice, fingerprint
      ) VALUES (?, ?, ?, ?, 1, NULL, ?, NULL, ?)
    `);
    database.transaction(() => {
      for (const figureIndex of figureIndexes) {
        const sessionId = `${projectId}_fig_${figureIndex + 1}`;
        insertSession.run(sessionId, userId, 'print("fixture")');
        insertFigure.run(
          `${projectId}_${figureIndex}`,
          projectId,
          figureIndex,
          sessionId,
          JSON.stringify({ objects: [] }),
          `fixture-${figureIndex}`,
        );
      }
    })();
  } finally {
    database.close();
  }
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
      SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION: '1',
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
  const disabledRedeem = await request(disabled.baseUrl, '/api/admin/redeem-codes', { method: 'POST', body: JSON.stringify({ count: 1 }) });
  const disabledAudit = await request(disabled.baseUrl, '/api/admin/audit-logs');
  const disabledDeployment = await request(disabled.baseUrl, '/api/admin/deployment-state');
  assert(
    [disabledRedeem.status, disabledAudit.status, disabledDeployment.status].every(status => status === 404),
    `Disabled admin operations must all return 404, got ${disabledRedeem.status}/${disabledAudit.status}/${disabledDeployment.status}`,
  );
  await stopServer(disabledServer);

  const enabled = startServer(basePort + 1, true);
  enabledServer = enabled.server;
  await waitForServer(enabled.baseUrl, enabled.output);

  const adminData = await register(enabled.baseUrl, adminEmail, 'Admin Console Admin');
  const userData = await register(enabled.baseUrl, userEmail, 'Admin Console User');
  const otherUserData = await register(enabled.baseUrl, otherUserEmail, 'Admin Console Other User');
  const adminToken = adminData.token;
  const userToken = userData.token;
  const otherUserToken = otherUserData.token;

  const projectResponse = await request(enabled.baseUrl, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: 'Subscription safety project', spec: { script_language: 'python', custom_script: 'print("safe")' } }),
  });
  const projectData = await jsonResponse(projectResponse);
  assert(projectResponse.ok && projectData?.id, `User project fixture failed: ${projectResponse.status} ${JSON.stringify(projectData)}`);
  insertFigureFixture(projectData.id, userData.user.id, [0, 1]);

  const otherProjectResponse = await request(enabled.baseUrl, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${otherUserToken}` },
    body: JSON.stringify({ name: 'Other user safety project', spec: { script_language: 'python', custom_script: 'print("other")' } }),
  });
  const otherProjectData = await jsonResponse(otherProjectResponse);
  assert(otherProjectResponse.ok && otherProjectData?.id, `Other user project fixture failed: ${otherProjectResponse.status} ${JSON.stringify(otherProjectData)}`);
  insertFigureFixture(otherProjectData.id, otherUserData.user.id, [0]);

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
    message: `Traceback: print("private") for ${userEmail}; sample,value\nsecret,42`,
    component: 'ChartPreview',
    operation: 'render.preview',
    errorName: 'RenderError',
    errorCode: 'RENDER_PREVIEW_FAILED',
    route: '/projects/demo',
    projectId: projectData.id,
    figureId: 'fig_2',
    clientVersion: 'smoke-test',
    metadata: {
      browser: 'node-fetch',
      retryable: true,
      language: 'python',
      messageLength: 42,
      operation: userEmail,
      step: 'device-fingerprint-must-drop',
      phase: 'C:/Users/SZC/private-dataset.csv',
      engine: 'A'.repeat(64),
      email: userEmail,
      fingerprint: 'device-fingerprint-must-drop',
      svg: '<svg><script>alert(1)</script></svg>',
      image: 'data:image/png;base64,AAAA',
      export: 'exported figure content',
      script: 'print("must drop")',
      dataPayload: 'sample,value\n1,2',
    },
  };
  const firstIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(reportBody),
  });
  const firstReport = await jsonResponse(firstIngest);
  assert(firstIngest.ok && firstReport?.report?.occurrenceCount === 1, `First ingest failed: ${firstIngest.status} ${JSON.stringify(firstReport)}`);
  assert(firstReport.report.projectId === projectData.id && firstReport.report.figureId === 'fig_2', 'Error report must preserve validated project/Figure identifiers');
  assert(firstReport.report.metadata?.browser === 'node-fetch' && firstReport.report.metadata?.retryable === true, 'Allowed metadata diagnostics must be preserved');
  const firstReportText = JSON.stringify(firstReport);
  assert(!firstReportText.includes(userEmail) && !firstReportText.includes('device-fingerprint-must-drop') && !firstReportText.includes('private-dataset.csv') && !firstReportText.includes('A'.repeat(64)) && !firstReportText.includes('<svg') && !firstReportText.includes('data:image') && !firstReportText.includes('sample,value'), 'Submitted report metadata must drop user content and sensitive diagnostics');

  const crossUserProjectIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ ...reportBody, projectId: otherProjectData.id, figureId: 'fig_1' }),
  });
  assert(crossUserProjectIngest.status === 403, `Cross-user project error report must be rejected with 403, got ${crossUserProjectIngest.status}`);

  const missingFigureIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ ...reportBody, figureId: 'fig_99' }),
  });
  assert(missingFigureIngest.status === 404, `Missing figure error report must be rejected with 404, got ${missingFigureIngest.status}`);

  const figureWithoutProjectIngest = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ ...reportBody, projectId: undefined, figureId: 'fig_1' }),
  });
  assert(figureWithoutProjectIngest.status === 400, `Figure report without projectId must be rejected with 400, got ${figureWithoutProjectIngest.status}`);

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
  assert(overviewResponse.ok && overviewData?.overview?.counts?.users >= 3, `Admin overview failed: ${overviewResponse.status} ${JSON.stringify(overviewData)}`);
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
  assert(reportsData.items[0].projectId === projectData.id && reportsData.items[0].figureId === 'fig_2', 'Error report must preserve project/Figure identifiers');
  assert(!('fingerprint' in reportsData.items[0]) && !('userEmail' in reportsData.items[0]), 'Admin error report list must not expose fingerprint or userEmail');
  const reportsText = JSON.stringify(reportsData);
  assert(!reportsText.includes(userEmail) && !reportsText.includes('device-fingerprint-must-drop') && !reportsText.includes('<svg') && !reportsText.includes('data:image') && !reportsText.includes('sample,value'), 'Admin report list metadata must not leak dropped user content');
  assert(!('fingerprint' in firstReport.report), 'Submitted error response must not expose fingerprint');
  assert(!('userEmail' in firstReport.report), 'Submitted error response must not expose user email');
  const reportLeaks = forbiddenJsonFields(reportsData);
  assert(reportLeaks.length === 0, `Error reports response leaked sensitive fields: ${reportLeaks.join(', ')}`);

  const detailResponse = await request(enabled.baseUrl, `/api/admin/error-reports/${reportsData.items[0].id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const detailData = await jsonResponse(detailResponse);
  assert(detailResponse.ok && detailData?.report?.id === reportsData.items[0].id, `Error report detail failed: ${detailResponse.status} ${JSON.stringify(detailData)}`);
  assert(!('fingerprint' in detailData.report) && !('userEmail' in detailData.report), 'Admin error report detail must not expose fingerprint or userEmail');
  const detailText = JSON.stringify(detailData);
  assert(!detailText.includes(userEmail) && !detailText.includes('device-fingerprint-must-drop') && !detailText.includes('<svg') && !detailText.includes('data:image') && !detailText.includes('sample,value'), 'Admin report detail metadata must not leak dropped user content');

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
  assert(!('userEmail' in handoffData.repairPackage) && !('userId' in handoffData.repairPackage) && !('fingerprint' in handoffData.repairPackage), 'AI handoff must not expose account identity or fingerprint');
  assert(forbiddenJsonFields(handoffData).length === 0, `AI handoff leaked forbidden fields: ${forbiddenJsonFields(handoffData).join(', ')}`);
  const handoffText = JSON.stringify(handoffData);
  assert(!handoffText.includes(userEmail) && !handoffText.includes('device-fingerprint-must-drop') && !handoffText.includes('<svg') && !handoffText.includes('data:image') && !handoffText.includes('sample,value'), 'AI handoff metadata must not leak dropped user content');
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
  const pastedSecret = 'A'.repeat(64);
  const adjustmentBody = {
    plan: 'pro', status: 'active', endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    reason: `Grant test access for ${userEmail} from C:\\Users\\Researcher\\private.csv with Bearer ${pastedSecret}`,
    adminNote: 'sample,value\nA,1',
    requestId,
    reauthToken: reauth.reauthToken,
  };
  const adjustmentResponse = await request(enabled.baseUrl, `/api/admin/users/${userData.user.id}/subscription`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(adjustmentBody),
  });
  const adjustment = await jsonResponse(adjustmentResponse);
  assert(adjustmentResponse.ok && adjustment?.subscription?.plan === 'pro' && adjustment?.license?.isPro === true, `Subscription adjustment failed: ${adjustmentResponse.status} ${JSON.stringify(adjustment)}`);
  assert(adjustment.replayed === false, 'First subscription request must not be marked as replayed');
  const adjustmentText = JSON.stringify(adjustment);
  assert(
    adjustment.subscription.changeReason.includes('[redacted-email]')
      && adjustment.subscription.changeReason.includes('[redacted-path]')
      && adjustment.subscription.changeReason.includes('[redacted-secret]')
      && adjustment.subscription.adminNote === '[redacted-content]',
    `Subscription operational text was not sanitized: ${adjustmentText}`,
  );
  assert(!adjustmentText.includes(userEmail) && !adjustmentText.includes('private.csv') && !adjustmentText.includes(pastedSecret), 'Subscription response leaked pasted user content');

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
  const subscriptionsAfterText = JSON.stringify(subscriptionsAfter);
  assert(!subscriptionsAfterText.includes('private.csv') && !subscriptionsAfterText.includes(pastedSecret), 'Subscription list leaked pasted user content');
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
  assert(
    !auditSerialized.includes(password)
      && !auditSerialized.includes(reauth.reauthToken)
      && !auditSerialized.includes('private.csv')
      && !auditSerialized.includes(pastedSecret),
    'Audit output must not contain passwords, tokens, paths or pasted user content',
  );

  const unsafeIdentifierReport = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({
      ...reportBody,
      component: 'ChartPreview',
      operation: 'device-fingerprint-secret',
      errorName: '123e4567-e89b-42d3-a456-426614174000',
      errorCode: 'A'.repeat(64),
      clientVersion: userEmail,
    }),
  });
  const unsafeIdentifierData = await jsonResponse(unsafeIdentifierReport);
  const unsafeIdentifierText = JSON.stringify(unsafeIdentifierData);
  assert(unsafeIdentifierReport.ok, `Unsafe identifier report should be accepted after sanitization: ${unsafeIdentifierReport.status}`);
  assert(
    unsafeIdentifierData.report.component === 'ChartPreview'
      && unsafeIdentifierData.report.operation === null
      && unsafeIdentifierData.report.errorName === null
      && unsafeIdentifierData.report.errorCode === null
      && unsafeIdentifierData.report.clientVersion === null,
    'Sensitive top-level diagnostic identifiers must be dropped',
  );
  assert(!unsafeIdentifierText.includes(userEmail) && !unsafeIdentifierText.includes('123e4567-e89b-42d3-a456-426614174000') && !unsafeIdentifierText.includes('device-fingerprint-secret') && !unsafeIdentifierText.includes('A'.repeat(64)), 'Sanitized top-level identifiers must not be reflected');

  const absolutePathReport = await request(enabled.baseUrl, '/api/error-reports', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ ...reportBody, component: 'C:/Users/SZC/private-component.py' }),
  });
  const absolutePathText = await absolutePathReport.text();
  assert(absolutePathReport.status === 400 && !absolutePathText.includes('private-component.py'), 'Absolute paths in top-level diagnostics must be rejected without reflection');

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
