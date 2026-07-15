import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const roleScript = path.join(repoRoot, 'scripts', 'security', 'set-user-role.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-admin-auth-'));
const dbPath = path.join(tempDir, 'scifigure-test.db');
const port = 32_000 + Math.floor(Math.random() * 2_000);
const baseUrl = `http://127.0.0.1:${port}`;
const email = `admin-security-${Date.now()}@example.test`;
const password = 'Admin-Security-Test-2026';
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

function setRole(role) {
  const result = spawnSync(process.execPath, [
    tsxCli,
    roleScript,
    '--email', email,
    '--role', role,
    '--reason', 'admin_authorization_smoke',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCIFIGURE_DB_PATH: dbPath,
    },
    encoding: 'utf8',
  });
  assert(result.status === 0, `Role provisioning failed: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert(payload?.user?.role === role, `Expected role ${role}, got ${result.stdout}`);
}

async function jsonResponse(response) {
  return response.json().catch(() => null);
}

const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_ADMIN_CONSOLE_ENABLED: '1',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));

try {
  await waitForServer();

  const registerResponse = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName: 'Admin Security Test' }),
  });
  const registerData = await jsonResponse(registerResponse);
  assert(registerResponse.ok && registerData?.token, `Registration failed: ${registerResponse.status} ${JSON.stringify(registerData)}`);
  assert(registerData?.user?.role === 'user', `New users must default to user role: ${JSON.stringify(registerData)}`);
  const token = registerData.token;

  const secretOnlyResponse = await request('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { 'x-admin-secret': 'legacy-secret-must-not-work' },
    body: JSON.stringify({ count: 1 }),
  });
  assert(secretOnlyResponse.status === 401, `Legacy secret-only access must return 401, got ${secretOnlyResponse.status}`);

  const ordinaryResponse = await request('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ count: 1 }),
  });
  assert(ordinaryResponse.status === 403, `Ordinary user must return 403, got ${ordinaryResponse.status}`);

  setRole('admin');

  const meResponse = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(meResponse.status === 401, `Role promotion must revoke pre-promotion sessions, got ${meResponse.status}`);
  const adminLoginResponse = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const adminLogin = await jsonResponse(adminLoginResponse);
  assert(adminLoginResponse.ok && adminLogin?.token && adminLogin?.user?.role === 'admin', `Fresh administrator login failed: ${adminLoginResponse.status} ${JSON.stringify(adminLogin)}`);
  const adminToken = adminLogin.token;

  const adminResponse = await request('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      count: 2,
      durationDays: 31,
      maxUses: 1,
      label: 'admin-smoke',
    }),
  });
  const adminData = await jsonResponse(adminResponse);
  assert(adminResponse.ok && adminData?.codes?.length === 2, `Admin creation failed: ${adminResponse.status} ${JSON.stringify(adminData)}`);

  const auditResponse = await request('/api/admin/audit-logs?limit=100', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const auditData = await jsonResponse(auditResponse);
  assert(auditResponse.ok && Array.isArray(auditData?.logs), `Audit read failed: ${auditResponse.status} ${JSON.stringify(auditData)}`);
  assert(auditData.logs.some((entry) => entry.action === 'redeem_codes.create' && entry.success === true && entry.actorUserId === registerData.user.id), 'Successful admin action was not audited');
  assert(auditData.logs.some((entry) => entry.action === 'redeem_codes.create' && entry.success === false && entry.statusCode === 403), 'Forbidden admin attempt was not audited');
  const auditJson = JSON.stringify(auditData.logs);
  for (const code of adminData.codes) {
    assert(!auditJson.includes(code), 'Audit logs must not contain raw redeem codes');
  }

  setRole('user');

  const demotedResponse = await request('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ count: 1 }),
  });
  assert(demotedResponse.status === 401, `Role change must revoke the administrator session immediately, got ${demotedResponse.status}`);

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'new users default to user',
      'legacy x-admin-secret rejected',
      'ordinary user rejected',
      'role promotion revokes old sessions and requires fresh login',
      'audit logs omit redeem codes',
      'role revocation applies to existing token',
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
