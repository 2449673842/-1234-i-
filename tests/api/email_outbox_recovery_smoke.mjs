import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-email-outbox-'));
const dataRoot = path.join(tempRoot, 'data');
const dbPath = path.join(dataRoot, 'scifigure.db');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const deliveries = [];

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

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForServer(baseUrl, child, output) {
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode})\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      return response.ok;
    } catch {
      return false;
    }
  }, `Server did not become ready\n${output.join('')}`, 30_000);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3_000)),
    ]);
  }
}

async function startServer(webhookPort, crashAfterAccept) {
  const port = await reservePort();
  const output = [];
  const child = spawn(process.execPath, [tsxCli, 'server.ts'], {
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
      SCIFIGURE_EMAIL_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/verification`,
      SCIFIGURE_EMAIL_WEBHOOK_TOKEN: 'isolated-outbox-webhook-token',
      SCIFIGURE_EMAIL_VERIFICATION_SECRET: 'email-outbox-recovery-secret-2026-at-least-32',
      SCIFIGURE_EMAIL_OUTBOX_LEASE_MS: '5000',
      SCIFIGURE_EMAIL_OUTBOX_POLL_MS: '100',
      SCIFIGURE_EMAIL_OUTBOX_RETRY_BASE_MS: '100',
      SCIFIGURE_EMAIL_OUTBOX_MAX_ATTEMPTS: '5',
      SCIFIGURE_TEST_EMAIL_EXIT_AFTER_PROVIDER_ACCEPT: crashAfterAccept ? '1' : '0',
      EMAIL_VERIFICATION_RATE_LIMIT_PER_15_MINUTES: '100',
      DISABLE_HMR: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(String(chunk)));
  child.stderr.on('data', chunk => output.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, output);
  return { child, baseUrl, output };
}

const webhookPort = await reservePort();
const webhook = http.createServer(async (req, res) => {
  let rawBody = '';
  for await (const chunk of req) rawBody += String(chunk);
  const payload = JSON.parse(rawBody);
  deliveries.push(payload);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"status":"accepted"}');
});
await new Promise((resolve, reject) => {
  webhook.once('error', reject);
  webhook.listen(webhookPort, '127.0.0.1', resolve);
});

fs.mkdirSync(dataRoot, { recursive: true });
const legacyDatabase = new Database(dbPath);
legacyDatabase.exec(`
  CREATE TABLE pending_email_registrations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    consumed_at TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
legacyDatabase.prepare(`
  INSERT INTO pending_email_registrations (
    id, email, display_name, code_hash, expires_at
  ) VALUES (?, ?, 'Legacy pending', ?, datetime('now', '+10 minutes'))
`).run(
  'evc_00000000-0000-4000-8000-000000000099',
  'legacy-pending@example.test',
  '9'.repeat(64),
);
legacyDatabase.close();

let firstServer = null;
let recoveryServer = null;
try {
  const email = `outbox-recovery-${Date.now()}@example.test`;
  const password = 'Email-Outbox-Recovery-2026';
  firstServer = await startServer(webhookPort, true);
  await fetch(`${firstServer.baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'Outbox Recovery' }),
  }).catch(() => null);
  await waitFor(() => firstServer.child.exitCode !== null, 'Crash-injected server did not exit');
  assert(firstServer.child.exitCode === 86, `Expected crash injection exit 86, got ${firstServer.child.exitCode}\n${firstServer.output.join('')}`);
  assert(deliveries.length === 1, `Expected one provider-accepted delivery before crash, got ${deliveries.length}`);

  const firstDelivery = deliveries[0];
  assert(/^evc_[0-9a-f-]{36}$/i.test(firstDelivery.deliveryId || ''), 'Webhook delivery must include a stable challenge id');
  assert(/^\d{6}$/.test(firstDelivery.code || ''), 'Webhook delivery must contain a six-digit code');
  const beforeRecovery = new Database(dbPath, { readonly: true });
  const candidate = beforeRecovery.prepare(`
    SELECT id, code_hash, deliverable_at, consumed_at
    FROM pending_email_registrations WHERE id = ?
  `).get(firstDelivery.deliveryId);
  const outbox = beforeRecovery.prepare('SELECT * FROM email_verification_outbox WHERE challenge_id = ?').get(firstDelivery.deliveryId);
  const migratedLegacy = beforeRecovery.prepare(`
    SELECT deliverable_at FROM pending_email_registrations
    WHERE id = 'evc_00000000-0000-4000-8000-000000000099'
  `).get();
  const migratedLegacyOutbox = beforeRecovery.prepare(`
    SELECT challenge_id FROM email_verification_outbox
    WHERE challenge_id = 'evc_00000000-0000-4000-8000-000000000099'
  `).get();
  const usersBeforeRecovery = beforeRecovery.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  beforeRecovery.close();
  assert(candidate && candidate.deliverable_at === null && candidate.consumed_at === null, 'Crash must leave an inactive candidate challenge');
  assert(/^[a-f0-9]{64}$/i.test(candidate.code_hash || '') && candidate.code_hash !== firstDelivery.code, 'Candidate must store only the keyed code hash');
  assert(outbox?.status === 'sending', `Crash must leave a leased outbox row, got ${outbox?.status}`);
  assert(migratedLegacy?.deliverable_at && !migratedLegacyOutbox, 'Legacy active challenges must remain verifiable without a fabricated outbox row');
  assert(Object.values(outbox).every(value => value !== firstDelivery.code && value !== email), 'Outbox must not store plaintext code or recipient email');
  assert(usersBeforeRecovery === 0, 'Crash before activation must not create a permanent user');

  recoveryServer = await startServer(webhookPort, false);
  const prematureVerification = await fetch(`${recoveryServer.baseUrl}/api/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: firstDelivery.deliveryId,
      code: firstDelivery.code,
      password,
    }),
  });
  assert(prematureVerification.status === 400, 'An inactive outbox candidate must not be verifiable before recovery acceptance');

  await waitFor(() => {
    const database = new Database(dbPath, { readonly: true });
    const row = database.prepare(`
      SELECT p.deliverable_at, o.status
      FROM pending_email_registrations AS p
      INNER JOIN email_verification_outbox AS o ON o.challenge_id = p.id
      WHERE p.id = ?
    `).get(firstDelivery.deliveryId);
    database.close();
    return row?.deliverable_at && row?.status === 'accepted';
  }, 'Restarted server did not recover and activate the outbox delivery');

  assert(deliveries.length >= 2, 'Recovery worker must retry the provider delivery');
  const recoveredDelivery = deliveries.find((delivery, index) => (
    index > 0 && delivery.deliveryId === firstDelivery.deliveryId
  ));
  assert(recoveredDelivery?.code === firstDelivery.code, 'Recovery must resend the same challenge id and code');

  const verified = await fetch(`${recoveryServer.baseUrl}/api/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: firstDelivery.deliveryId,
      code: firstDelivery.code,
      password,
    }),
  });
  const verifiedData = await verified.json().catch(() => null);
  assert(verified.ok && verifiedData?.token, `Recovered challenge must verify: ${verified.status} ${JSON.stringify(verifiedData)}`);

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'provider acceptance is preceded by a durable inactive challenge and outbox lease',
      'inactive candidates cannot create users or verify',
      'restart recovery resends the same challenge id and deterministic code',
      'accepted recovery atomically activates the challenge',
      'outbox stores neither plaintext verification code nor recipient email',
      'legacy active challenges migrate without being invalidated or re-sent',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await stopServer(firstServer?.child);
  await stopServer(recoveryServer?.child);
  await new Promise(resolve => webhook.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
