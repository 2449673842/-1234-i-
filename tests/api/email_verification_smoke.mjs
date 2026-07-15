import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-email-verification-'));
const dataRoot = path.join(tempRoot, 'data');
const dbPath = path.join(dataRoot, 'scifigure.db');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverOutput = [];

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

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited early\n${serverOutput.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready\n${serverOutput.join('')}`);
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, data: await response.json().catch(() => null) };
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_DATA_DIR: dataRoot,
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_TEST_ISOLATED: '1',
    SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '1',
    SCIFIGURE_EMAIL_PROVIDER: 'test',
    SCIFIGURE_EMAIL_VERIFICATION_SECRET: 'email-verification-smoke-secret-2026-at-least-32',
    SCIFIGURE_TEST_EXPOSE_EMAIL_CODE: '1',
    EMAIL_VERIFICATION_RATE_LIMIT_PER_15_MINUTES: '100',
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => serverOutput.push(String(chunk)));
server.stderr.on('data', chunk => serverOutput.push(String(chunk)));

try {
  await waitForServer(baseUrl, server);
  const email = `verified-${Date.now()}@example.test`;
  const password = 'Email-Verification-Test-2026';
  const registration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName: 'Verified User' }),
  });
  assert(registration.response.status === 202, `Registration should require verification: ${registration.response.status} ${JSON.stringify(registration.data)}`);
  assert(registration.data?.verificationRequired === true && !registration.data?.token, 'Unverified registration must not issue an access token');
  const firstChallenge = registration.data?.verification;
  assert(/^evc_[0-9a-f-]{36}$/i.test(firstChallenge?.challengeId || ''), `Missing challenge id: ${JSON.stringify(registration.data)}`);
  assert(/^\d{6}$/.test(firstChallenge?.testCode || ''), 'Isolated test provider did not expose a six-digit code');

  const preVerificationLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  assert(preVerificationLogin.response.status === 403 && preVerificationLogin.data?.errorCode === 'EMAIL_VERIFICATION_REQUIRED', 'Unverified login must be rejected');

  const wrong = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: firstChallenge.challengeId, code: '000000' === firstChallenge.testCode ? '000001' : '000000' }),
  });
  assert(wrong.response.status === 400, `Wrong verification code should fail: ${wrong.response.status}`);

  const verified = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST',
    headers: { 'X-Device-Fingerprint': 'email-smoke-device', 'X-Device-Name': 'Email smoke' },
    body: JSON.stringify({ challengeId: firstChallenge.challengeId, code: firstChallenge.testCode }),
  });
  assert(verified.response.ok && verified.data?.token, `Verification failed: ${verified.response.status} ${JSON.stringify(verified.data)}`);
  assert(verified.data?.user?.emailVerified === true && verified.data?.user?.emailVerificationRequired === false, 'Verified user payload is incorrect');
  const refreshCookie = verified.response.headers.get('set-cookie');
  assert(refreshCookie?.includes('HttpOnly') && refreshCookie.includes('SameSite=Strict'), 'Verification response must issue a protected refresh cookie');

  const reuse = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: firstChallenge.challengeId, code: firstChallenge.testCode }),
  });
  assert(reuse.response.status === 400, 'Verification challenge must be single-use');

  const me = await jsonRequest(baseUrl, '/api/auth/me', { headers: { Authorization: `Bearer ${verified.data.token}` } });
  assert(me.response.ok && me.data?.user?.email === email, 'Verified access token must authenticate');
  const refresh = await jsonRequest(baseUrl, '/api/auth/refresh', { method: 'POST', headers: { Cookie: refreshCookie.split(';')[0] } });
  assert(refresh.response.ok && refresh.data?.token, `Verified refresh session failed: ${refresh.response.status} ${JSON.stringify(refresh.data)}`);

  const lockedEmail = `locked-${Date.now()}@example.test`;
  const lockedRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: lockedEmail, password }),
  });
  const lockedChallenge = lockedRegistration.data?.verification;
  assert(lockedRegistration.response.status === 202 && lockedChallenge?.testCode, 'Locked-account fixture registration failed');
  const wrongCode = lockedChallenge.testCode === '111111' ? '222222' : '111111';
  let lastAttempt;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastAttempt = await jsonRequest(baseUrl, '/api/auth/verify-email', {
      method: 'POST', body: JSON.stringify({ challengeId: lockedChallenge.challengeId, code: wrongCode }),
    });
  }
  assert(lastAttempt.response.status === 400 && lastAttempt.data?.errorCode === 'EMAIL_VERIFICATION_LOCKED', 'Challenge must lock after five failed attempts');
  const lockedCorrect = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: lockedChallenge.challengeId, code: lockedChallenge.testCode }),
  });
  assert(lockedCorrect.response.status === 400, 'Locked challenge must reject the original correct code');
  const resent = await jsonRequest(baseUrl, '/api/auth/resend-verification', {
    method: 'POST', body: JSON.stringify({ email: lockedEmail }),
  });
  assert(resent.response.ok && resent.data?.verification?.challengeId !== lockedChallenge.challengeId, 'Resend must create a new challenge');

  const database = new Database(dbPath, { readonly: true });
  const rows = database.prepare('SELECT code_hash FROM email_verification_challenges').all();
  database.close();
  assert(rows.length >= 3 && rows.every(row => /^[a-f0-9]{64}$/i.test(row.code_hash)), 'Verification challenges must store only SHA-256 HMAC values');
  assert(!JSON.stringify(rows).includes(firstChallenge.testCode), 'Database must not contain plaintext verification codes');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'registration does not issue a session before verification',
      'unverified login is rejected',
      'wrong codes fail and attempts are bounded',
      'verification challenge is single-use',
      'verified access and refresh sessions work',
      'resend replaces a locked challenge',
      'database stores only keyed code hashes',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, serverOutput: serverOutput.join('').slice(-10_000) }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
