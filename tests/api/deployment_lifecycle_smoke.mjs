import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const roleScript = path.join(repoRoot, 'scripts', 'security', 'set-user-role.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-deployment-lifecycle-'));
const dataRoot = path.join(tempDir, 'data');
const dbPath = path.join(dataRoot, 'scifigure-test.db');
const port = 34_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const email = `deployment-lifecycle-${Date.now()}@example.test`;
const password = 'Deployment-Lifecycle-Test-2026';
const serverOutput = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(pathname, options = {}) {
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

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/health/live');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not start. Output:\n${serverOutput.join('')}`);
}

async function waitForActiveJob(token) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await request('/api/admin/deployment-state', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await jsonResponse(response);
    if (data?.deployment?.activeJobsTotal > 0 || data?.deployment?.renderer?.active > 0) return data.deployment;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for an active render job');
}

async function waitForDeploymentIdle(token) {
  const deadline = Date.now() + 20_000;
  let observedPrematureIdle = false;
  while (Date.now() < deadline) {
    const response = await request('/api/admin/deployment-state', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await jsonResponse(response);
    const deployment = data?.deployment;
    if (deployment?.activeJobsTotal === 0 && (deployment?.renderer?.active > 0 || deployment?.renderer?.workers > 0)) {
      observedPrematureIdle = true;
    }
    if (deployment?.activeJobsTotal === 0
      && deployment?.renderer?.active === 0
      && deployment?.renderer?.queued === 0
      && deployment?.renderer?.workers === 0) {
      return { deployment, observedPrematureIdle };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for deployment jobs to become idle');
}

function waitForServerExit(timeoutMs = 20_000) {
  if (server.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => server.once('close', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function setAdminRole() {
  const result = spawnSync(process.execPath, [
    tsxCli,
    roleScript,
    '--email', email,
    '--role', 'admin',
    '--reason', 'deployment_lifecycle_smoke',
  ], {
    cwd: repoRoot,
    env: { ...process.env, SCIFIGURE_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert(result.status === 0, `Role provisioning failed: ${result.stderr || result.stdout}`);
}

const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_DATA_DIR: dataRoot,
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_GRACEFUL_SHUTDOWN_MS: '15000',
    SCIFIGURE_VITE_HMR_PORT: String(port + 1_000),
    NODE_ENV: 'development',
    DISABLE_HMR: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', chunk => serverOutput.push(chunk.toString()));
server.stderr.on('data', chunk => serverOutput.push(chunk.toString()));

try {
  await waitForServer();

  const live = await request('/api/health/live');
  const ready = await request('/api/health/ready');
  assert(live.ok && ready.ok, `Initial health failed: live=${live.status}, ready=${ready.status}`);
  assert(live.headers.get('cache-control') === 'no-store' && ready.headers.get('cache-control') === 'no-store', 'Health responses must not be cached');

  const registerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName: 'Deployment Lifecycle Test' }),
  });
  const registerData = await jsonResponse(registerResponse);
  assert(registerResponse.ok && registerData?.token, `Registration failed: ${registerResponse.status} ${JSON.stringify(registerData)}`);
  const token = registerData.token;

  const ordinaryState = await request('/api/admin/deployment-state', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(ordinaryState.status === 403, `Ordinary user must not read deployment state: ${ordinaryState.status}`);
  setAdminRole();

  const initialStateResponse = await request('/api/admin/deployment-state', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const initialState = await jsonResponse(initialStateResponse);
  assert(initialStateResponse.ok && initialState?.deployment?.mode === 'accepting', `Expected accepting state: ${JSON.stringify(initialState)}`);

  const projectResponse = await request('/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Deployment lifecycle fixture',
      spec: { plot_type: 'custom', custom_script: 'import matplotlib.pyplot as plt\nplt.figure()' },
    }),
  });
  const projectData = await jsonResponse(projectResponse);
  assert(projectResponse.ok && projectData?.id, `Fixture project creation failed: ${projectResponse.status} ${JSON.stringify(projectData)}`);
  const projectId = projectData.id;
  const assetIds = [];
  for (const [index, color] of ['#225577', '#cc5544'].entries()) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="${color}"/></svg>`;
    const importResponse = await request(`/api/projects/${projectId}/export-assets/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'svg', svg, name: `asset-${index + 1}` }),
    });
    const importData = await jsonResponse(importResponse);
    assert(importResponse.ok && importData?.asset?.assetId, `Fixture asset import failed: ${importResponse.status} ${JSON.stringify(importData)}`);
    assetIds.push(importData.asset.assetId);
  }

  const zipResponse = await request(`/api/projects/${projectId}/export-assets/zip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assetIds }),
  });
  const zipBytes = new Uint8Array(await zipResponse.arrayBuffer());
  assert(zipResponse.ok && zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, `ZIP stream did not complete correctly: ${zipResponse.status}, bytes=${zipBytes.length}`);

  const composeResponse = await request(`/api/projects/${projectId}/compose`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assetIds, name: 'deployment-compose-fixture' }),
  });
  const composeData = await jsonResponse(composeResponse);
  assert(composeResponse.ok && composeData?.status === 'success' && composeData?.asset?.assetId, `Composition task failed: ${composeResponse.status} ${JSON.stringify(composeData)}`);

  const invalidStateResponse = await request('/api/admin/deployment-state', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'invalid', reason: 'manual' }),
  });
  assert(invalidStateResponse.status === 400, `Invalid deployment mode must return 400: ${invalidStateResponse.status}`);

  const slowScript = [
    'import time',
    'import matplotlib.pyplot as plt',
    'time.sleep(2)',
    'fig, ax = plt.subplots(figsize=(4, 3))',
    'ax.plot([0, 1], [0, 1])',
  ].join('\n');
  const firstRender = request('/api/figure/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ script: slowScript }),
  });

  const activeState = await waitForActiveJob(token);
  assert(activeState.activeJobsByKind?.render >= 1, `Render route was not counted: ${JSON.stringify(activeState)}`);

  const drainResponse = await request('/api/admin/deployment-state', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'draining', reason: 'deployment' }),
  });
  const drainData = await jsonResponse(drainResponse);
  assert(drainResponse.ok && drainData?.deployment?.mode === 'draining', `Drain transition failed: ${drainResponse.status} ${JSON.stringify(drainData)}`);

  const drainingReady = await request('/api/health/ready');
  const drainingReadyData = await jsonResponse(drainingReady);
  assert(drainingReady.status === 503 && drainingReadyData?.status === 'draining', `Readiness must fail while draining: ${drainingReady.status} ${JSON.stringify(drainingReadyData)}`);

  const rejectedRender = await request('/api/figure/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ script: 'import matplotlib.pyplot as plt\nplt.figure()' }),
  });
  const rejectedData = await jsonResponse(rejectedRender);
  assert(rejectedRender.status === 503 && rejectedData?.code === 'INSTANCE_DRAINING', `New render must be rejected while draining: ${rejectedRender.status} ${JSON.stringify(rejectedData)}`);

  const rejectedArchive = await request(`/api/projects/${projectId}/export-assets/zip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assetIds }),
  });
  const rejectedArchiveData = await jsonResponse(rejectedArchive);
  assert(rejectedArchive.status === 503 && rejectedArchiveData?.code === 'INSTANCE_DRAINING', `New archive must be rejected while draining: ${rejectedArchive.status} ${JSON.stringify(rejectedArchiveData)}`);

  const rejectedComposition = await request(`/api/projects/${projectId}/compose`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ assetIds, name: 'must-not-compose' }),
  });
  const rejectedCompositionData = await jsonResponse(rejectedComposition);
  assert(rejectedComposition.status === 503 && rejectedCompositionData?.code === 'INSTANCE_DRAINING', `New composition must be rejected while draining: ${rejectedComposition.status} ${JSON.stringify(rejectedCompositionData)}`);

  const firstRenderResponse = await firstRender;
  const firstRenderData = await jsonResponse(firstRenderResponse);
  assert(firstRenderResponse.ok && firstRenderData?.status === 'success', `Existing render did not finish: ${firstRenderResponse.status} ${JSON.stringify(firstRenderData)}`);

  const resumeResponse = await request('/api/admin/deployment-state', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'accepting', reason: 'manual' }),
  });
  const resumeData = await jsonResponse(resumeResponse);
  assert(resumeResponse.ok && resumeData?.deployment?.activeJobsTotal === 0, `Resume failed or active job leaked: ${JSON.stringify(resumeData)}`);
  const resumedReady = await request('/api/health/ready');
  assert(resumedReady.ok, `Readiness did not recover after resume: ${resumedReady.status}`);

  const disconnectedController = new AbortController();
  const disconnectedRender = request('/api/figure/render', {
    method: 'POST',
    signal: disconnectedController.signal,
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ script: slowScript }),
  });
  await waitForActiveJob(token);
  disconnectedController.abort();
  await disconnectedRender.catch(() => null);
  const disconnectedIdle = await waitForDeploymentIdle(token);
  assert(!disconnectedIdle.observedPrematureIdle, `Request lease reached zero before renderer worker stopped: ${JSON.stringify(disconnectedIdle.deployment)}`);

  const auditResponse = await request('/api/admin/audit-logs?limit=50', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const auditData = await jsonResponse(auditResponse);
  const deploymentAudits = Array.isArray(auditData?.logs)
    ? auditData.logs.filter(entry => entry.action === 'deployment.mode.change' && entry.success === true)
    : [];
  const rejectedDeploymentAudits = Array.isArray(auditData?.logs)
    ? auditData.logs.filter(entry => entry.action === 'deployment.mode.change' && entry.success === false && entry.statusCode === 400)
    : [];
  assert(auditResponse.ok && deploymentAudits.length >= 2, `Deployment state changes were not audited: ${JSON.stringify(auditData)}`);
  assert(rejectedDeploymentAudits.length >= 1, `Rejected deployment state change was not audited: ${JSON.stringify(auditData)}`);

  let signalCheck = 'SIGTERM drain requires Linux verification';
  if (process.platform !== 'win32') {
    const shutdownRender = request('/api/figure/render', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ script: slowScript }),
    });
    await waitForActiveJob(token);
    const shutdownStartedAt = Date.now();
    server.kill('SIGTERM');
    const shutdownRenderResponse = await shutdownRender;
    const shutdownRenderData = await jsonResponse(shutdownRenderResponse);
    assert(shutdownRenderResponse.ok && shutdownRenderData?.status === 'success', `SIGTERM interrupted the in-flight render: ${shutdownRenderResponse.status} ${JSON.stringify(shutdownRenderData)}`);
    const exitedGracefully = await waitForServerExit();
    assert(exitedGracefully && server.exitCode === 0, `Server did not exit cleanly after draining: exit=${server.exitCode}, signal=${server.signalCode}`);
    assert(Date.now() - shutdownStartedAt >= 1_000, 'Server exited before the in-flight render had time to finish');
    signalCheck = 'SIGTERM drains an in-flight render before clean exit';
  }

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'liveness and readiness are public but minimal',
      'health responses are not cacheable',
      'deployment state requires database admin role',
      'archive stream and composition task complete without lease leaks',
      'active render is counted',
      'draining rejects new render with 503',
      'draining rejects new archive and composition tasks with 503',
      'in-flight render finishes during draining',
      'explicit resume restores readiness',
      'client disconnect cancels renderer before releasing its request lease',
      'deployment mode changes are audited',
      'invalid deployment state changes are audited',
      signalCheck,
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
  if (server.exitCode === null) server.kill('SIGTERM');
  await waitForServerExit();
  if (server.exitCode === null) server.kill('SIGKILL');
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
