import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-r-security-'));
const dbPath = path.join(tempDir, 'scifigure-test.db');
const port = 34_000 + Math.floor(Math.random() * 2_000);
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/auth/me');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start. Output:\n${serverOutput.join('')}`);
}

async function assertNonDevelopmentLocalRendererRejected(nodeEnv, portOffset) {
  const output = [];
  const child = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port + portOffset),
      SCIFIGURE_DB_PATH: path.join(tempDir, `${nodeEnv}-guard.db`),
      SCIFIGURE_RENDER_MODE: 'local',
      SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '1',
      SCIFIGURE_EMAIL_PROVIDER: 'resend',
      SCIFIGURE_EMAIL_VERIFICATION_SECRET: 'r-security-email-verification-secret-32-plus',
      SCIFIGURE_RESEND_API_KEY: 're_r_security_startup_only',
      SCIFIGURE_EMAIL_FROM: 'SciFigure <noreply@example.test>',
      SCIFIGURE_AUTH_THROTTLE_SECRET: 'r-security-auth-throttle-secret-32-plus',
      DISABLE_HMR: 'true',
      NODE_ENV: nodeEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
  ]);
  if (exitCode === 'timeout') child.kill();
  assert(exitCode !== 'timeout', `${nodeEnv} local-renderer process did not exit: ${output.join('')}`);
  assert(exitCode !== 0, `${nodeEnv} local-renderer process must fail: ${output.join('')}`);
  assert(output.join('').includes('require SCIFIGURE_RENDER_MODE=docker'), `${nodeEnv} guard should explain the Docker requirement`);
}

const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_R_RISK_ENFORCE: '1',
    DISABLE_HMR: 'true',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));

try {
  await waitForServer();
  await assertNonDevelopmentLocalRendererRejected('production', 1);
  await assertNonDevelopmentLocalRendererRejected('staging', 2);
  const registerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `r-security-${Date.now()}@example.test`,
      password: 'R-Security-Test-Password-2026',
    }),
  });
  const registerData = await registerResponse.json();
  assert(registerResponse.ok && registerData?.token, `Registration failed: ${registerResponse.status} ${JSON.stringify(registerData)}`);
  const headers = { Authorization: `Bearer ${registerData.token}` };

  const pathResponse = await request('/api/figure/render', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language: 'r',
      script: 'plot(1, 1)',
      cwd: repoRoot,
      uploaded_file_paths: { secret: dbPath },
    }),
  });
  const pathData = await pathResponse.json().catch(() => null);
  assert(pathResponse.status === 400, `Client path injection must return 400, got ${pathResponse.status} ${JSON.stringify(pathData)}`);
  assert(String(pathData?.message || '').includes('不接受客户端文件路径'), 'Path rejection should explain the project upload requirement');

  const commandResponse = await request('/api/figure/render', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language: 'r',
      script: 'system2("sh", c("-c", "id"))',
    }),
  });
  const commandData = await commandResponse.json().catch(() => null);
  assert(commandData?.status === 'error', `High-risk R command must be blocked: ${commandResponse.status} ${JSON.stringify(commandData)}`);
  assert(Array.isArray(commandData?.riskFindings) && commandData.riskFindings.some((finding) => finding.symbol === 'system2'), 'Blocked response should include system2 finding');

  const packageResponse = await request('/api/figure/render', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language: 'r',
      script: 'library(parallel)\nplot(1, 1)',
    }),
  });
  const packageData = await packageResponse.json().catch(() => null);
  assert(packageData?.status === 'success', `Capability package loading should remain compatible: ${packageResponse.status} ${JSON.stringify(packageData)}`);

  const namespaceResponse = await request('/api/figure/render', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language: 'r',
      script: 'processx::run("id")',
    }),
  });
  const namespaceData = await namespaceResponse.json().catch(() => null);
  assert(namespaceData?.status === 'error', `Namespaced process execution must be blocked: ${namespaceResponse.status} ${JSON.stringify(namespaceData)}`);
  assert(namespaceData.riskFindings.some((finding) => finding.symbol === 'processx::run'), 'Blocked response should include processx::run finding');

  const dynamicResponse = await request('/api/figure/render', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language: 'r',
      script: 'get("system2")("id")',
    }),
  });
  const dynamicData = await dynamicResponse.json().catch(() => null);
  assert(dynamicData?.status === 'error', `Dynamic process dispatch must be blocked: ${dynamicResponse.status} ${JSON.stringify(dynamicData)}`);

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'client-supplied R paths rejected',
      'production local renderer rejected at startup',
      'system commands blocked before R execution',
      'capability package loading remains compatible',
      'namespaced and dynamic process calls blocked before R execution',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    serverOutput: serverOutput.join('').slice(-8_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
