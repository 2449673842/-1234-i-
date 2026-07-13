import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const observationDir = path.join(repoRoot, 'tmp', 'unified-editing-staging', 'legacy-retire-observation');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(candidatePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExit(server, timeoutMs) {
  if (!server || server.exitCode !== null) return true;
  return Promise.race([
    new Promise(resolve => server.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function startServer(envOverrides) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-legacy-retire-observation-'));
  const port = 34_000 + Math.floor(Math.random() * 2_000);
  const output = [];
  const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      SCIFIGURE_DB_PATH: path.join(tempDir, 'scifigure-test.db'),
      SCIFIGURE_DATA_DIR: path.join(tempDir, 'data'),
      SCIFIGURE_RENDER_MODE: 'local',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => output.push(chunk.toString()));
  server.stderr.on('data', chunk => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.ok) return { baseUrl, server, output, tempDir };
    } catch {}
    await delay(250);
  }
  server.kill('SIGKILL');
  throw new Error(`Server did not start. Output:\n${output.join('')}`);
}

async function stopServer(server, tempDir) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    const exited = await waitForExit(server, 5_000);
    if (!exited && server.exitCode === null) {
      server.kill('SIGKILL');
      await waitForExit(server, 5_000);
    }
  }
  if (tempDir) {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

async function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function register(baseUrl) {
  const response = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `legacy-retire-observation-${Date.now()}@example.test`,
      password: 'Legacy-Retire-Observation-2026',
      displayName: 'Legacy Retire Observation Smoke',
    }),
  });
  const data = await response.json().catch(() => null);
  assert(response.ok && data?.token, `Registration failed: ${response.status} ${JSON.stringify(data)}`);
  return data.token;
}

function validEvent(extra = {}) {
  return {
    eventType: 'legacy_resolver_path',
    source: 'component-center',
    center: 'components',
    intent: 'style.component',
    prop: 'object-secret-id',
    selectionMode: 'explicit_objects',
    targetRole: 'component',
    strategy: 'legacy',
    fallbackReason: 'missing_identity',
    patchCount: 1,
    skippedCount: 2,
    ambiguousCount: 3,
    missingIdentityCount: 4,
    missingCapabilityCount: 5,
    ...extra,
  };
}

async function testDisabled404() {
  const { baseUrl, server, tempDir } = await startServer({
    SCIFIGURE_STAGING_INSTANCE: '',
    SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY: '',
  });
  try {
    const response = await request(baseUrl, '/api/internal/legacy-retire-observation', {
      method: 'POST',
      body: JSON.stringify({ events: [validEvent()] }),
    });
    assert(response.status === 404, `Disabled endpoint should return 404, got ${response.status}`);
  } finally {
    await stopServer(server, tempDir);
  }
}

async function testEnabledContract() {
  fs.mkdirSync(observationDir, { recursive: true });
  const buildSuffix = `${process.pid}-${Date.now()}`;
  const buildId = `smoke/..\\unsafe:build?${buildSuffix}`;
  const expectedBuildId = `smoke_.._unsafe_build_${buildSuffix}`;
  const expectedFileName = `${expectedBuildId}-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const expectedFilePath = path.join(observationDir, expectedFileName);
  fs.rmSync(expectedFilePath, { force: true });
  const { baseUrl, server, tempDir } = await startServer({
    SCIFIGURE_STAGING_INSTANCE: 'unified-editing',
    SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY: '1',
    SCIFIGURE_STAGING_BUILD_ID: buildId,
  });
  try {
    const unauthenticated = await request(baseUrl, '/api/internal/legacy-retire-observation', {
      method: 'POST',
      body: JSON.stringify({ events: [validEvent()] }),
    });
    assert(unauthenticated.status === 401, `Enabled endpoint must reject unauthenticated requests, got ${unauthenticated.status}`);

    const token = await register(baseUrl);
    const tooMany = await request(baseUrl, '/api/internal/legacy-retire-observation', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: Array.from({ length: 101 }, () => validEvent()) }),
    });
    assert(tooMany.status === 413, `More than 100 events should be rejected with 413, got ${tooMany.status}`);

    const oversized = await request(baseUrl, '/api/internal/legacy-retire-observation', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [validEvent({ padding: 'x'.repeat(70 * 1024) })] }),
    });
    assert(oversized.status === 413, `Payloads over 64KB should be rejected with 413, got ${oversized.status}`);

    const sensitiveValue = 'secret-object-123';
    const accepted = await request(baseUrl, '/api/internal/legacy-retire-observation', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'sensitive-user-agent',
        'X-Forwarded-For': '203.0.113.10',
      },
      body: JSON.stringify({
        events: [validEvent({
          userId: 'sensitive-user-id',
          ip: '198.51.100.10',
          userAgent: 'sensitive-user-agent',
          objectId: sensitiveValue,
        })],
      }),
    });
    const acceptedData = await accepted.json().catch(() => null);
    assert(accepted.ok && acceptedData?.accepted === 1, `Observation submit failed: ${accepted.status} ${JSON.stringify(acceptedData)}`);

    const files = fs.readdirSync(observationDir);
    assert(files.includes(expectedFileName), `Expected observation file ${expectedFileName}, got: ${files.join(', ')}`);
    const fileName = expectedFileName;
    assert(/^[A-Za-z0-9._-]+\.jsonl$/.test(fileName), `Observation filename is not safe: ${fileName}`);
    const filePath = path.join(observationDir, fileName);
    assert(isInside(filePath, observationDir), `Observation file escaped target directory: ${filePath}`);
    assert(!isInside(filePath, path.join(repoRoot, 'data')), 'Observation file must not be written under data/');
    assert(!filePath.includes(`${path.sep}admin`), 'Observation file must not be written under admin audit paths');

    const content = fs.readFileSync(filePath, 'utf8');
    for (const forbidden of [
      sensitiveValue,
      'sensitive-user-id',
      '198.51.100.10',
      '203.0.113.10',
      'sensitive-user-agent',
      'object-secret-id',
    ]) {
      assert(!content.includes(forbidden), `Observation JSONL leaked forbidden value: ${forbidden}`);
    }
    const lines = content.trim().split('\n');
    assert(lines.length === 1, `Expected one JSONL record, got ${lines.length}`);
    const record = JSON.parse(lines[0]);
    assert(record.receivedAt && !Number.isNaN(Date.parse(record.receivedAt)), 'Observation record missing receivedAt');
    assert(record.buildId === expectedBuildId, `Observation record buildId was not sanitized: ${record.buildId}`);
    assert(record.prop === 'other', `Unsafe property should be sanitized to "other", got ${record.prop}`);
    assert(record.eventType === 'legacy_resolver_path', `Unexpected event type: ${record.eventType}`);
  } finally {
    await stopServer(server, tempDir);
    fs.rmSync(expectedFilePath, { force: true });
  }
}

await testDisabled404();
await testEnabledContract();
console.log('Legacy retire observation API smoke passed');
