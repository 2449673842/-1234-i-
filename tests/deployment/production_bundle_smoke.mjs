import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const bundle = path.join(root, 'dist', 'server.cjs');
assert.ok(fs.existsSync(bundle), 'Run npm run build before the production bundle smoke');

const bundleSource = fs.readFileSync(bundle, 'utf8');
assert.doesNotMatch(bundleSource.slice(0, 20_000), /require\(["']vite["']\)/, 'Production bundle must not load Vite eagerly');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-production-bundle-'));
const dataRoot = path.join(tempRoot, 'data');
const port = 37_000 + Math.floor(Math.random() * 1_000);
const output = [];
const child = spawn(process.execPath, [bundle], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    SCIFIGURE_BIND_HOST: '127.0.0.1',
    SCIFIGURE_DATA_DIR: dataRoot,
    SCIFIGURE_DB_PATH: path.join(dataRoot, 'scifigure.db'),
    SCIFIGURE_RENDER_MODE: 'docker',
    SCIFIGURE_GRACEFUL_SHUTDOWN_MS: '5000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', chunk => output.push(chunk.toString()));
child.stderr.on('data', chunk => output.push(chunk.toString()));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/live`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Production bundle did not become healthy:\n${output.join('').slice(-8000)}`);
}

try {
  const health = await waitForHealth();
  assert.equal(health.status, 'live');
  assert.match(output.join(''), new RegExp(`Server running on http://127\\.0\\.0\\.1:${port}`));
  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'production CJS bundle starts without eager Vite dependency',
      'loopback bind setting is honored',
      'public liveness endpoint responds',
    ],
  }, null, 2));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
