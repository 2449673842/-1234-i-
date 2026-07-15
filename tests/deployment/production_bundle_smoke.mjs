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

const rejectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-production-email-gate-'));
const rejectedOutput = [];
const {
  SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: _verificationRequired,
  SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION: _allowUnverified,
  SCIFIGURE_EMAIL_PROVIDER: _emailProvider,
  ...productionEnvWithoutEmail
} = process.env;
const rejected = spawn(process.execPath, [bundle], {
  cwd: root,
  env: {
    ...productionEnvWithoutEmail,
    NODE_ENV: 'production',
    SCIFIGURE_DATA_DIR: path.join(rejectedRoot, 'data'),
    SCIFIGURE_DB_PATH: path.join(rejectedRoot, 'data', 'scifigure.db'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
rejected.stdout.on('data', chunk => rejectedOutput.push(chunk.toString()));
rejected.stderr.on('data', chunk => rejectedOutput.push(chunk.toString()));
const rejectedExitCode = await Promise.race([
  new Promise(resolve => rejected.once('close', resolve)),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Production email gate did not stop startup')), 10_000)),
]);
assert.notEqual(rejectedExitCode, 0, 'Production server must reject missing email verification configuration');
assert.match(rejectedOutput.join(''), /生产环境必须启用邮箱验证/);
fs.rmSync(rejectedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const throttleRejectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-production-auth-throttle-gate-'));
const throttleRejectedOutput = [];
const {
  SCIFIGURE_AUTH_THROTTLE_SECRET: _authThrottleSecret,
  ...productionEnvWithoutThrottleSecret
} = process.env;
const throttleRejected = spawn(process.execPath, [bundle], {
  cwd: root,
  env: {
    ...productionEnvWithoutThrottleSecret,
    NODE_ENV: 'production',
    SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION: '1',
    SCIFIGURE_DATA_DIR: path.join(throttleRejectedRoot, 'data'),
    SCIFIGURE_DB_PATH: path.join(throttleRejectedRoot, 'data', 'scifigure.db'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
throttleRejected.stdout.on('data', chunk => throttleRejectedOutput.push(chunk.toString()));
throttleRejected.stderr.on('data', chunk => throttleRejectedOutput.push(chunk.toString()));
const throttleRejectedExitCode = await Promise.race([
  new Promise(resolve => throttleRejected.once('close', resolve)),
  new Promise((_, reject) => setTimeout(() => reject(new Error('Production auth throttle secret gate did not stop startup')), 10_000)),
]);
assert.notEqual(throttleRejectedExitCode, 0, 'Production server must reject a missing authentication throttle secret');
assert.match(throttleRejectedOutput.join(''), /AUTH_THROTTLE_SECRET/);
fs.rmSync(throttleRejectedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-production-bundle-'));
const dataRoot = path.join(tempRoot, 'data');
const port = 37_000 + Math.floor(Math.random() * 1_000);
const output = [];
const child = spawn(process.execPath, [bundle], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    SCIFIGURE_ALLOW_UNVERIFIED_REGISTRATION_IN_PRODUCTION: '1',
    SCIFIGURE_AUTH_THROTTLE_SECRET: 'production-bundle-auth-throttle-secret-2026',
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
      'production startup fails closed without email verification configuration',
      'production startup fails closed without an authentication throttle secret',
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
