import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-r-runtime-smoke-'));
const dataDir = path.join(tempRoot, 'data');
const dbPath = path.join(dataDir, 'scifigure.db');
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput = [];
const rscriptBin = discoverRscript();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const selectedPort = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
}

function discoverRscript() {
  const configured = process.env.RSCRIPT_BIN || process.env.R_BIN;
  const windowsConda = 'C:\\Users\\SZC\\.conda\\envs\\Machine-learning\\Scripts\\Rscript.exe';
  const candidate = configured || (process.platform === 'win32' && fs.existsSync(windowsConda) ? windowsConda : 'Rscript');
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [candidate], { encoding: 'utf-8', windowsHide: true });
  const located = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
  assert(located && fs.existsSync(located), `Rscript is required for R-WP3 runtime smoke; candidate=${candidate}`);
  return located;
}

function normalizeRuntimePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function runtimeJobRoot(value) {
  const normalized = normalizeRuntimePath(value);
  const marker = '/scifigure-r-job-';
  const start = normalized.lastIndexOf(marker);
  if (start < 0) return '';
  const tailStart = start + marker.length;
  const nextSlash = normalized.indexOf('/', tailStart);
  return nextSlash < 0 ? normalized : normalized.slice(0, nextSlash);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function waitForServer(server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited early (${server.exitCode})\n${serverOutput.join('')}`);
    }
    try {
      const { response } = await request('/api/auth/me');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start\n${serverOutput.join('')}`);
}

async function register() {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `r-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Runtime-Consistency-2026',
    }),
  });
  assert(response.ok && data?.token, `Registration failed: ${response.status} ${JSON.stringify(data)}`);
  return data.token;
}

async function render(token, script) {
  const { response, data } = await request('/api/figure/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: 'r', script }),
  });
  assert(response.ok && data?.status === 'success', `R render failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function renderFailure(token, script) {
  const { response, data } = await request('/api/figure/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: 'r', script }),
  });
  assert(response.ok && data?.status === 'error', `Expected structured R failure: ${response.status} ${JSON.stringify(data)}`);
  assert(data?.diagnostic?.schemaVersion === '1.0', `R failure omitted diagnostic contract: ${JSON.stringify(data)}`);
  return data;
}

function assertRuntimeContract(result) {
  const inventory = result.runtimeInventory;
  assert(inventory?.schemaVersion === '1.0', `Missing runtime inventory: ${JSON.stringify(inventory)}`);
  assert(path.isAbsolute(path.normalize(inventory.executable?.rscript || '')), `Rscript path is not absolute: ${inventory.executable?.rscript}`);
  assert(inventory.timezone === 'UTC', `Expected UTC timezone, got ${inventory.timezone}`);
  assert(inventory.environment?.tz === 'UTC', `Environment TZ missing: ${JSON.stringify(inventory.environment)}`);
  assert(result.performance?.runtime?.mode === 'local', `Expected local runtime performance: ${JSON.stringify(result.performance)}`);

  const paths = [
    inventory.workingDirectory,
    inventory.temporaryDirectory,
    inventory.environment?.home,
    inventory.environment?.userProfile,
    inventory.environment?.tmpdir,
    inventory.environment?.tmp,
    inventory.environment?.temp,
  ].filter(Boolean);
  assert(paths.length >= 5, `Runtime environment paths are incomplete: ${JSON.stringify(inventory.environment)}`);
  const roots = paths.map(runtimeJobRoot);
  assert(roots.every(Boolean), `Runtime paths are not job-scoped: ${JSON.stringify(paths)}`);
  assert(new Set(roots).size === 1, `Runtime paths do not share one job root: ${JSON.stringify(paths)}`);
  assert(!fs.existsSync(inventory.workingDirectory), `R job working directory leaked: ${inventory.workingDirectory}`);
  assert(!fs.existsSync(inventory.temporaryDirectory), `R job temporary directory leaked: ${inventory.temporaryDirectory}`);
  return roots[0];
}

const server = spawn(process.execPath, [tsxCli, 'server.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_DATA_DIR: dataDir,
    SCIFIGURE_DB_PATH: dbPath,
    SCIFIGURE_LEGACY_OWNER_EMAIL: '',
    SCIFIGURE_TEST_ISOLATED: '1',
    SCIFIGURE_RENDER_MODE: 'local',
    SCIFIGURE_R_TIMEOUT_MS: '5000',
    RSCRIPT_BIN: rscriptBin,
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => serverOutput.push(chunk.toString()));
server.stderr.on('data', chunk => serverOutput.push(chunk.toString()));

try {
  await waitForServer(server);
  const token = await register();
  const unseeded = await render(token, [
    'library(ggplot2)',
    'df <- data.frame(x=1:4, y=runif(4))',
    'p <- ggplot(df, aes(x, y)) + geom_line() + theme_classic()',
    'p',
  ].join('\n'));
  const seeded = await render(token, [
    'library(ggplot2)',
    'set.seed(20260722)',
    'df <- data.frame(x=1:4, y=runif(4))',
    'p <- ggplot(df, aes(x, y)) + geom_line() + theme_classic()',
    'p',
  ].join('\n'));

  const firstRoot = assertRuntimeContract(unseeded);
  const secondRoot = assertRuntimeContract(seeded);
  assert(firstRoot !== secondRoot, `R renders reused a job directory: ${firstRoot}`);
  assert(unseeded.determinismWarnings?.some(warning => warning.symbol === 'runif'), 'Unseeded R render omitted runif warning');
  assert(unseeded.diagnostics?.determinismWarnings?.some(warning => warning.symbol === 'runif'), 'API diagnostics omitted runif warning');
  assert(Array.isArray(seeded.determinismWarnings) && seeded.determinismWarnings.length === 0, 'Fixed set.seed should suppress random warnings');
  assert(Array.isArray(seeded.diagnostics?.determinismWarnings) && seeded.diagnostics.determinismWarnings.length === 0, 'Seeded diagnostics should remain empty');

  const syntaxFailure = await renderFailure(token, 'library(ggplot2)\nx <-');
  assert(syntaxFailure.diagnostic.type === 'syntax_error', `Syntax error was misclassified: ${JSON.stringify(syntaxFailure.diagnostic)}`);
  const packageFailure = await renderFailure(token, 'library(scifigurePackageThatDoesNotExist)\nplot(1, 1)');
  assert(packageFailure.diagnostic.type === 'missing_package', `Missing package was misclassified: ${JSON.stringify(packageFailure.diagnostic)}`);
  const timeoutFailure = await renderFailure(token, 'Sys.sleep(7)\nplot(1, 1)');
  assert(timeoutFailure.diagnostic.type === 'timeout', `Timeout was misclassified: ${JSON.stringify(timeoutFailure.diagnostic)}`);
  const timeoutJobId = timeoutFailure.diagnostic?.details?.jobId;
  assert(/^scifigure-r-job-[A-Za-z0-9_-]+$/.test(String(timeoutJobId || '')), `Timeout omitted safe job id: ${JSON.stringify(timeoutFailure.diagnostic)}`);
  assert(!fs.existsSync(path.join(os.tmpdir(), timeoutJobId)), `Timed-out R job leaked temp directory: ${timeoutJobId}`);

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'absolute Rscript inventory',
      'per-request isolated HOME/TMP/workdir',
      'UTC runtime contract',
      'Rscript --vanilla local execution',
      'warning-only deterministic scan',
      'structured syntax and missing-package diagnostics',
      'structured timeout diagnostics',
      'job cleanup after response',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    serverOutput: serverOutput.join('').slice(-12_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  server.kill();
  await Promise.race([
    new Promise(resolve => server.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
