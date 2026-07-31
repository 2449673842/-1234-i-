import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const bundle = path.join(root, 'dist', 'server.cjs');
const publicRoot = path.join(root, 'dist', 'public');
assert.ok(fs.existsSync(bundle), 'Run npm run build before the production bundle smoke');
assert.ok(fs.existsSync(path.join(publicRoot, 'index.html')), 'Production frontend build is missing');
assert.ok(
  !fs.existsSync(path.join(publicRoot, 'server.cjs')),
  'Backend bundle must remain outside the public static directory',
);
assert.ok(
  !fs.existsSync(`${bundle}.map`),
  'Production build must not emit a publicly discoverable backend source map',
);

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
    SCIFIGURE_TRUST_PROXY: 'loopback',
    SCIFIGURE_DATA_DIR: dataRoot,
    SCIFIGURE_DB_PATH: path.join(dataRoot, 'scifigure.db'),
    SCIFIGURE_EMAIL_VERIFICATION_REQUIRED: '0',
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

  const register = async (label, forwardedProto) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedProto ? { 'X-Forwarded-Proto': forwardedProto } : {}),
      },
      body: JSON.stringify({
        email: `${label}-${Date.now()}@example.test`,
        password: 'Production-Cookie-Smoke-2026',
      }),
    });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, 200, `Registration failed: ${JSON.stringify(data)}`);
    const cookie = response.headers.get('set-cookie') || '';
    assert.match(cookie, /^scifigure_refresh=/, 'Registration did not issue a refresh cookie');
    return cookie;
  };

  const httpCookie = await register('http-cookie');
  assert.doesNotMatch(httpCookie, /;\s*Secure/i, 'HTTP deployment issued a browser-rejected Secure cookie');
  const httpsCookie = await register('https-cookie', 'https');
  assert.match(httpsCookie, /;\s*Secure/i, 'Trusted HTTPS proxy must issue a Secure refresh cookie');

  const unauthenticatedAssets = await fetch(`http://127.0.0.1:${port}/api/export-assets`);
  assert.equal(unauthenticatedAssets.status, 401, 'Protected export assets route must preserve auth status');

  const sensitivePaths = [
    '/server.cjs',
    '/server.cjs.map',
    '/SERVER.CJS',
    '/%73erver.cjs',
    '/.env',
    '/%2eenv',
    '/data/scifigure.db',
    '/backup/scifigure.sqlite3',
    '/assets/application.js.map',
    '/secrets/deploy.pem',
  ];
  for (const sensitivePath of sensitivePaths) {
    const response = await fetch(`http://127.0.0.1:${port}${sensitivePath}`);
    assert.equal(
      response.status,
      404,
      `Production static serving must not expose ${sensitivePath}`,
    );
  }

  for (const appPath of ['/', '/admin', '/help']) {
    const appShell = await fetch(`http://127.0.0.1:${port}${appPath}`);
    assert.equal(appShell.status, 200, `SPA route must remain available: ${appPath}`);
    assert.match(await appShell.text(), /<div id="root"><\/div>/);
  }
  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'production CJS bundle starts without eager Vite dependency',
      'loopback bind setting is honored',
      'refresh cookie security follows the trusted request protocol',
      'protected export assets preserve authentication status',
      'public liveness endpoint responds',
      'backend artifacts and sensitive file-shaped paths return 404',
      'frontend application shell remains available',
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
