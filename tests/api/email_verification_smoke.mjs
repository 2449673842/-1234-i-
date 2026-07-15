import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
const emailDeliveries = [];
let failNextEmailDelivery = false;
let delayNextEmailDeliveryMs = 0;
let auditDatabase = null;

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

const emailWebhookPort = await reservePort();
const emailWebhook = http.createServer(async (req, res) => {
  let rawBody = '';
  for await (const chunk of req) rawBody += String(chunk);
  let payload = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {}
  emailDeliveries.push({
    authorization: req.headers.authorization || '',
    payload,
  });
  if (failNextEmailDelivery) {
    failNextEmailDelivery = false;
    res.statusCode = 503;
    res.end('isolated delivery failure');
    return;
  }
  if (delayNextEmailDeliveryMs > 0) {
    const delayMs = delayNextEmailDeliveryMs;
    delayNextEmailDeliveryMs = 0;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"status":"accepted"}');
});
await new Promise((resolve, reject) => {
  emailWebhook.once('error', reject);
  emailWebhook.listen(emailWebhookPort, '127.0.0.1', resolve);
});

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
    SCIFIGURE_EMAIL_PROVIDER: 'webhook',
    SCIFIGURE_EMAIL_WEBHOOK_URL: `http://127.0.0.1:${emailWebhookPort}/verification`,
    SCIFIGURE_EMAIL_WEBHOOK_TOKEN: 'isolated-email-webhook-token',
    SCIFIGURE_EMAIL_VERIFICATION_SECRET: 'email-verification-smoke-secret-2026-at-least-32',
    SCIFIGURE_TEST_EXPOSE_EMAIL_CODE: '1',
    EMAIL_VERIFICATION_RATE_LIMIT_PER_15_MINUTES: '100',
    DISABLE_HMR: 'true',
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
  const deliveriesBeforeInvalidPassword = emailDeliveries.length;
  const oversizedPasswordRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `oversized-${Date.now()}@example.test`, password: 'x'.repeat(1025) }),
  });
  assert(oversizedPasswordRegistration.response.status === 400, 'Oversized registration password must be rejected');
  assert(emailDeliveries.length === deliveriesBeforeInvalidPassword, 'Invalid passwords must be rejected before email delivery');

  const registration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName: 'Verified User' }),
  });
  assert(registration.response.status === 202, `Registration should require verification: ${registration.response.status} ${JSON.stringify(registration.data)}`);
  assert(registration.data?.verificationRequired === true && !registration.data?.token, 'Unverified registration must not issue an access token');
  const firstChallenge = registration.data?.verification;
  assert(/^evc_[0-9a-f-]{36}$/i.test(firstChallenge?.challengeId || ''), `Missing challenge id: ${JSON.stringify(registration.data)}`);
  assert(/^\d{6}$/.test(firstChallenge?.testCode || ''), 'Isolated test provider did not expose a six-digit code');
  assert(emailDeliveries.some(delivery => delivery.payload?.to === email), 'Registration must use the configured email provider');
  const pendingDatabase = new Database(dbPath, { readonly: true });
  assert(pendingDatabase.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0, 'Registration must not create a user before email verification');
  assert(pendingDatabase.prepare('SELECT COUNT(*) AS count FROM pending_email_registrations WHERE email = ? AND consumed_at IS NULL').get(email).count === 1, 'Registration must create one pending challenge');
  pendingDatabase.close();

  const preVerificationLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  assert(preVerificationLogin.response.status === 401 && preVerificationLogin.data?.message === '邮箱或密码错误', 'Pending registration must not be enumerable through login');

  const wrong = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({
      challengeId: firstChallenge.challengeId,
      code: '000000' === firstChallenge.testCode ? '000001' : '000000',
      password,
    }),
  });
  assert(wrong.response.status === 400, `Wrong verification code should fail: ${wrong.response.status}`);

  const verified = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST',
    headers: { 'X-Device-Fingerprint': 'email-smoke-device', 'X-Device-Name': 'Email smoke' },
    body: JSON.stringify({ challengeId: firstChallenge.challengeId, code: firstChallenge.testCode, password }),
  });
  assert(verified.response.ok && verified.data?.token, `Verification failed: ${verified.response.status} ${JSON.stringify(verified.data)}`);
  assert(verified.data?.user?.emailVerified === true && verified.data?.user?.emailVerificationRequired === false, 'Verified user payload is incorrect');
  const refreshCookie = verified.response.headers.get('set-cookie');
  assert(refreshCookie?.includes('HttpOnly') && refreshCookie.includes('SameSite=Strict'), 'Verification response must issue a protected refresh cookie');

  const reuse = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: firstChallenge.challengeId, code: firstChallenge.testCode, password }),
  });
  assert(reuse.response.status === 400, 'Verification challenge must be single-use');

  const me = await jsonRequest(baseUrl, '/api/auth/me', { headers: { Authorization: `Bearer ${verified.data.token}` } });
  assert(me.response.ok && me.data?.user?.email === email, 'Verified access token must authenticate');
  const refresh = await jsonRequest(baseUrl, '/api/auth/refresh', { method: 'POST', headers: { Cookie: refreshCookie.split(';')[0] } });
  assert(refresh.response.ok && refresh.data?.token, `Verified refresh session failed: ${refresh.response.status} ${JSON.stringify(refresh.data)}`);

  const existingRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email, password: 'Different-Password-2026' }),
  });
  assert(existingRegistration.response.status === 202 && existingRegistration.data?.verificationRequired === true, 'Existing email registration must use the same generic response');
  assert(/^\d{6}$/.test(existingRegistration.data?.verification?.testCode || ''), 'Existing accounts must traverse the same provider-backed challenge path');
  assert(emailDeliveries.filter(delivery => delivery.payload?.to === email).length === 2, 'Existing and new accounts must both invoke the email provider');
  const existingVerification = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: existingRegistration.data.verification.challengeId,
      code: existingRegistration.data.verification.testCode,
      password: 'Different-Password-2026',
    }),
  });
  assert(
    existingVerification.response.status === 400
      && existingVerification.data?.errorCode === 'EMAIL_VERIFICATION_ALREADY_REGISTERED',
    'A provider-backed challenge for an existing verified account must never replace its password',
  );

  const deliveryFailureEmail = `delivery-failure-${Date.now()}@example.test`;
  const preservedPassword = 'Preserved-Password-2026';
  const preservedRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: deliveryFailureEmail, password: preservedPassword }),
  });
  const preservedChallenge = preservedRegistration.data?.verification;
  failNextEmailDelivery = true;
  const failedReplacement = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: deliveryFailureEmail, password: 'Replacement-Password-2026' }),
  });
  assert(failedReplacement.response.status === 503, 'Provider failure must be surfaced as a temporary delivery failure');
  const deliveryFailureDatabase = new Database(dbPath, { readonly: true });
  const activeAfterDeliveryFailure = deliveryFailureDatabase.prepare(`
    SELECT id FROM pending_email_registrations
    WHERE email = ? AND consumed_at IS NULL
  `).get(deliveryFailureEmail);
  deliveryFailureDatabase.close();
  assert(activeAfterDeliveryFailure?.id === preservedChallenge.challengeId, 'Failed delivery must preserve the previous usable challenge');
  const preservedVerification = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: preservedChallenge.challengeId,
      code: preservedChallenge.testCode,
      password: preservedPassword,
    }),
  });
  assert(preservedVerification.response.ok, 'The previous challenge must remain usable after replacement delivery fails');

  const occupiedEmail = `occupied-${Date.now()}@example.test`;
  const attackerPassword = 'Attacker-Password-2026';
  const victimPassword = 'Victim-Password-2026';
  const attackerRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: occupiedEmail, password: attackerPassword, displayName: 'Attacker input' }),
  });
  const victimRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: occupiedEmail, password: victimPassword, displayName: 'Email owner' }),
  });
  const attackerChallenge = attackerRegistration.data?.verification;
  const victimChallenge = victimRegistration.data?.verification;
  assert(attackerRegistration.response.status === 202 && victimRegistration.response.status === 202, 'Repeated pending registration must not return an account-existence conflict');
  assert(attackerChallenge?.challengeId !== victimChallenge?.challengeId, 'Repeated registration must replace the pending challenge');
  const staleAttackerVerification = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: attackerChallenge.challengeId, code: attackerChallenge.testCode, password: attackerPassword }),
  });
  assert(staleAttackerVerification.response.status === 400, 'Replaced pending challenge must not create an account');
  const victimVerification = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: victimChallenge.challengeId, code: victimChallenge.testCode, password: victimPassword }),
  });
  assert(victimVerification.response.ok && victimVerification.data?.user?.email === occupiedEmail, 'Email owner must be able to complete the replacement registration');
  const attackerLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: occupiedEmail, password: attackerPassword }),
  });
  const victimLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: occupiedEmail, password: victimPassword }),
  });
  assert(attackerLogin.response.status === 401 && victimLogin.response.ok, 'Only the password submitted with the verified challenge may authenticate');

  const concurrentEmail = `concurrent-${Date.now()}@example.test`;
  const concurrentPassword = 'Concurrent-Registration-2026';
  const deliveriesBeforeConcurrent = emailDeliveries.length;
  delayNextEmailDeliveryMs = 250;
  const [concurrentA, concurrentB] = await Promise.all([
    jsonRequest(baseUrl, '/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: concurrentEmail, password: concurrentPassword }),
    }),
    jsonRequest(baseUrl, '/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: concurrentEmail, password: concurrentPassword }),
    }),
  ]);
  assert(concurrentA.response.status === 202 && concurrentB.response.status === 202, 'Concurrent registration requests must both keep the generic accepted response');
  assert(
    concurrentA.data?.verification?.challengeId === concurrentB.data?.verification?.challengeId,
    'Concurrent registration requests must converge on the same in-flight challenge',
  );
  assert(
    concurrentA.data?.verification?.testCode === concurrentB.data?.verification?.testCode,
    'Concurrent registration requests must expose the same isolated-test code',
  );
  assert(emailDeliveries.length === deliveriesBeforeConcurrent + 1, 'Concurrent registration must invoke the provider only once');
  const concurrentVerified = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: concurrentA.data.verification.challengeId,
      code: concurrentA.data.verification.testCode,
      password: concurrentPassword,
    }),
  });
  assert(concurrentVerified.response.ok, 'The converged concurrent challenge must remain verifiable');

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
      method: 'POST', body: JSON.stringify({ challengeId: lockedChallenge.challengeId, code: wrongCode, password }),
    });
  }
  assert(lastAttempt.response.status === 400 && lastAttempt.data?.errorCode === 'EMAIL_VERIFICATION_LOCKED', 'Challenge must lock after five failed attempts');
  const lockedCorrect = await jsonRequest(baseUrl, '/api/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ challengeId: lockedChallenge.challengeId, code: lockedChallenge.testCode, password }),
  });
  assert(lockedCorrect.response.status === 400, 'Locked challenge must reject the original correct code');
  const resent = await jsonRequest(baseUrl, '/api/auth/resend-verification', {
    method: 'POST', body: JSON.stringify({ email: lockedEmail }),
  });
  assert(resent.response.ok && resent.data?.verification?.challengeId !== lockedChallenge.challengeId, 'Resend must create a new challenge');

  const database = new Database(dbPath);
  auditDatabase = database;
  const rows = database.prepare(`
    SELECT code_hash FROM email_verification_challenges
    UNION ALL
    SELECT code_hash FROM pending_email_registrations
  `).all();
  const lockedUser = database.prepare('SELECT id FROM users WHERE email = ?').get(lockedEmail);
  const activeIndex = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_pending_email_registration_active_email'
  `).get();
  const stagedIndex = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_pending_email_registration_staged_email'
  `).get();
  assert(/CREATE UNIQUE INDEX/i.test(activeIndex?.sql || '') && /consumed_at IS NULL/i.test(activeIndex?.sql || ''), 'Pending registration uniqueness must be enforced by a partial unique index');
  assert(/deliverable_at IS NOT NULL/i.test(activeIndex?.sql || ''), 'Only delivered challenges may occupy the verifiable-email uniqueness boundary');
  assert(/deliverable_at IS NULL/i.test(stagedIndex?.sql || ''), 'Database must enforce at most one staged delivery per normalized email');
  let duplicateActiveRejected = false;
  try {
    database.prepare(`
      INSERT INTO pending_email_registrations (
        id, email, display_name, code_hash, expires_at, max_attempts, deliverable_at
      ) VALUES (?, ?, NULL, ?, datetime('now', '+10 minutes'), 5, datetime('now'))
    `).run('evc_00000000-0000-4000-8000-000000000001', lockedEmail, '0'.repeat(64));
  } catch {
    duplicateActiveRejected = true;
  }
  assert(duplicateActiveRejected, 'Database must reject a second active challenge for the same normalized email');
  const stagedEmail = `staged-unique-${Date.now()}@example.test`;
  database.prepare(`
    INSERT INTO pending_email_registrations (
      id, email, display_name, code_hash, expires_at, max_attempts, deliverable_at
    ) VALUES (?, ?, NULL, ?, datetime('now', '+10 minutes'), 5, NULL)
  `).run('evc_00000000-0000-4000-8000-000000000002', stagedEmail, '1'.repeat(64));
  let duplicateStagedRejected = false;
  try {
    database.prepare(`
      INSERT INTO pending_email_registrations (
        id, email, display_name, code_hash, expires_at, max_attempts, deliverable_at
      ) VALUES (?, ?, NULL, ?, datetime('now', '+10 minutes'), 5, NULL)
    `).run('evc_00000000-0000-4000-8000-000000000003', stagedEmail, '2'.repeat(64));
  } catch {
    duplicateStagedRejected = true;
  }
  assert(duplicateStagedRejected, 'Database must reject a second staged delivery for the same normalized email');
  const outboxColumns = database.prepare('PRAGMA table_info(email_verification_outbox)').all().map(column => column.name);
  const emailBudgetRows = database.prepare(`
    SELECT scope_hash FROM auth_request_budgets WHERE category = 'email_send'
  `).all();
  assert(
    !outboxColumns.some(name => ['email', 'recipient', 'code', 'payload', 'body'].includes(String(name).toLowerCase())),
    `Outbox schema must not contain plaintext content columns: ${outboxColumns.join(',')}`,
  );
  assert(emailBudgetRows.length >= 3, 'Email delivery must persist multiple abuse-control scopes');
  assert(
    emailBudgetRows.every(row => /^[a-f0-9]{64}$/i.test(row.scope_hash))
      && !JSON.stringify(emailBudgetRows).includes(concurrentEmail),
    'Email delivery budgets must store only HMAC scope identifiers',
  );
  database.close();
  auditDatabase = null;
  assert(!lockedUser, 'Locked pending registration must not create a user');
  assert(rows.length >= 4, `Expected persisted verification audit rows, got ${rows.length}`);
  assert(
    rows.every(row => /^[a-f0-9]{64}$/i.test(row.code_hash)),
    `Verification challenges must store only SHA-256 HMAC values: ${JSON.stringify(rows)}`,
  );
  assert(!JSON.stringify(rows).includes(firstChallenge.testCode), 'Database must not contain plaintext verification codes');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'registration does not issue a session before verification',
      'registration does not create a user before verification',
      'pending registration does not occupy or enumerate an email address',
      'existing and new accounts use the same provider-backed response path',
      'failed replacement delivery preserves the previous usable challenge',
      'database enforces one active challenge per normalized email',
      'concurrent registration converges on one provider delivery and challenge',
      'database enforces one staged delivery per normalized email',
      'password policy is enforced before email delivery',
      'only the password submitted with the verified challenge is accepted',
      'wrong codes fail and attempts are bounded',
      'verification challenge is single-use',
      'verified access and refresh sessions work',
      'resend replaces a locked challenge',
      'database stores only keyed code hashes',
      'outbox schema stores no email or code payload',
      'email delivery budgets store only HMAC recipient and network scopes',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, serverOutput: serverOutput.join('').slice(-10_000) }, null, 2));
  process.exitCode = 1;
} finally {
  if (auditDatabase) {
    try { auditDatabase.close(); } catch {}
    auditDatabase = null;
  }
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
  if (server.exitCode === null) {
    await Promise.race([
      new Promise(resolve => server.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3_000)),
    ]);
  }
  await new Promise(resolve => emailWebhook.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
