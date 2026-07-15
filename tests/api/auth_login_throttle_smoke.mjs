import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-auth-throttle-'));
const dataRoot = path.join(tempRoot, 'data');
const dbPath = path.join(dataRoot, 'scifigure.db');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startServer() {
  const port = await reservePort();
  const output = [];
  const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SCIFIGURE_DATA_DIR: dataRoot,
      SCIFIGURE_DB_PATH: dbPath,
      SCIFIGURE_RENDER_MODE: 'local',
      SCIFIGURE_TEST_ISOLATED: '1',
      SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '0',
      SCIFIGURE_AUTH_THROTTLE_SECRET: 'isolated-login-throttle-secret-2026',
      AUTH_LOGIN_FAILURE_LIMIT_PER_15_MINUTES: '3',
      AUTH_LOGIN_LOCK_MS: '1000',
      AUTH_RATE_LIMIT_PER_15_MINUTES: '100',
      NODE_ENV: 'development',
      DISABLE_HMR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => output.push(String(chunk)));
  server.stderr.on('data', chunk => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited early\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      if (response.ok) return { server, baseUrl, output };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${output.join('')}`);
}

async function stopServer(instance) {
  if (instance.server.exitCode === null) instance.server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => instance.server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (instance.server.exitCode === null) instance.server.kill('SIGKILL');
}

async function request(baseUrl, pathname, body, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { response, data, durationMs: performance.now() - startedAt };
}

let firstInstance = null;
let secondInstance = null;
try {
  firstInstance = await startServer();
  const email = `throttle-${Date.now()}@example.test`;
  const password = 'Auth-Throttle-Test-2026';
  const trustedFingerprint = 'auth-throttle-trusted-device';
  const legacyEmail = `legacy-throttle-${Date.now()}@example.test`;
  const legacyPassword = 'Legacy-Auth-Throttle-2026';
  const registration = await request(firstInstance.baseUrl, '/api/auth/register', {
    email,
    password,
    displayName: 'Throttle Test',
  }, { 'X-Device-Fingerprint': trustedFingerprint, 'X-Device-Name': 'Throttle smoke' });
  assert(registration.response.ok && registration.data?.token, 'Throttle fixture registration failed');
  const legacyRegistration = await request(firstInstance.baseUrl, '/api/auth/register', {
    email: legacyEmail,
    password: legacyPassword,
    displayName: 'Legacy Throttle Test',
  });
  assert(legacyRegistration.response.ok, 'Legacy migration fixture registration failed');

  const unknownFailure = await request(firstInstance.baseUrl, '/api/auth/login', {
    email: `unknown-${Date.now()}@example.test`,
    password: 'Wrong-Password-2026',
  });
  const firstKnownFailure = await request(firstInstance.baseUrl, '/api/auth/login', {
    email,
    password: 'Wrong-Password-2026',
  });
  assert(
    unknownFailure.response.status === 401
      && firstKnownFailure.response.status === 401
      && JSON.stringify(unknownFailure.data) === JSON.stringify(firstKnownFailure.data),
    'Known and unknown identifiers must return the same invalid-credential response',
  );
  assert(
    unknownFailure.durationMs >= 5 && firstKnownFailure.durationMs >= 5,
    `Known and unknown identifiers must both traverse password verification work: ${unknownFailure.durationMs}/${firstKnownFailure.durationMs}`,
  );

  const secondKnownFailure = await request(firstInstance.baseUrl, '/api/auth/login', {
    email,
    password: 'Wrong-Password-2026',
  });
  assert(secondKnownFailure.response.status === 401, 'Second invalid password should remain below the cooldown threshold');
  await stopServer(firstInstance);
  firstInstance = null;

  const migrationDatabase = new Database(dbPath);
  const legacySalt = crypto.randomBytes(16).toString('hex');
  const legacyHash = crypto.pbkdf2Sync(legacyPassword, legacySalt, 120_000, 32, 'sha256').toString('hex');
  migrationDatabase.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, password_algorithm = 'pbkdf2_sha256'
    WHERE email = ?
  `).run(legacyHash, legacySalt, legacyEmail);
  migrationDatabase.close();

  secondInstance = await startServer();
  const legacyLogin = await request(secondInstance.baseUrl, '/api/auth/login', {
    email: legacyEmail,
    password: legacyPassword,
  });
  assert(legacyLogin.response.ok && legacyLogin.data?.token, 'Legacy PBKDF2 login must remain compatible');
  const persistedThirdFailure = await request(secondInstance.baseUrl, '/api/auth/login', {
    email,
    password: 'Wrong-Password-2026',
  });
  assert(
    persistedThirdFailure.response.status === 429
      && Number(persistedThirdFailure.response.headers.get('retry-after')) >= 1,
    'Third failure after restart must trigger the persisted cooldown',
  );
  const correctDuringCooldown = await request(secondInstance.baseUrl, '/api/auth/login', { email, password });
  assert(correctDuringCooldown.response.status === 429, 'Unknown devices must remain blocked during the cooldown');
  const trustedRecovery = await request(
    secondInstance.baseUrl,
    '/api/auth/login',
    { email, password },
    { 'X-Device-Fingerprint': trustedFingerprint, 'X-Device-Name': 'Throttle smoke' },
  );
  assert(trustedRecovery.response.ok && trustedRecovery.data?.token, 'A known device with the correct password must clear a targeted cooldown');

  const database = new Database(dbPath, { readonly: true });
  const throttleRows = database.prepare(`
    SELECT identifier_hash, failure_count FROM auth_login_throttles
  `).all();
  const migratedLegacy = database.prepare(`
    SELECT password_algorithm FROM users WHERE email = ?
  `).get(legacyEmail);
  database.close();
  assert(throttleRows.every(row => /^[a-f0-9]{64}$/.test(row.identifier_hash)), 'Throttle storage must contain only HMAC identifiers');
  assert(!JSON.stringify(throttleRows).includes(email), 'Throttle storage must not contain plaintext email identifiers');
  assert(!throttleRows.some(row => row.failure_count >= 3), 'Successful login must clear its persisted cooldown state');
  assert(migratedLegacy?.password_algorithm === 'argon2id', 'Successful legacy login must migrate to Argon2id');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'known and unknown accounts return the same invalid-credential response',
      'missing accounts perform dummy Argon2 verification work',
      'login failures persist across a server restart',
      'threshold failures trigger a bounded Retry-After cooldown',
      'unknown devices remain blocked during cooldown',
      'a known device with the correct password clears a targeted cooldown',
      'legacy PBKDF2 login remains compatible and migrates to Argon2id',
      'persistent throttle storage contains HMAC identifiers only',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    serverOutput: [firstInstance, secondInstance].filter(Boolean).flatMap(item => item.output).join('').slice(-10_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (firstInstance) await stopServer(firstInstance);
  if (secondInstance) await stopServer(secondInstance);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
