import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');

  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated test requires SCIFIGURE_DATA_DIR and SCIFIGURE_DB_PATH');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `test refuses non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `test refuses DB outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/ directory');
}

function assertTimeoutEnvironment() {
  assert(
    String(process.env.SCIFIGURE_RENDER_MODE || '').toLowerCase() === 'local',
    'test must run with SCIFIGURE_RENDER_MODE=local so the request-created Rscript cleanup path is exercised',
  );
  const timeoutMs = Number(process.env.SCIFIGURE_R_TIMEOUT_MS || 0);
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5_000,
    'test must run with SCIFIGURE_R_TIMEOUT_MS=5000 or lower for a stable bounded timeout',
  );
}

async function jsonRequest(route, token, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function register() {
  const result = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `r-wp9-timeout-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP9-Timeout-Cleanup-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function openReadonlyDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function readRenderPersistenceState() {
  const db = openReadonlyDb();
  try {
    return {
      projects: Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count || 0),
      sessions: Number(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count || 0),
      projectFiles: Number(db.prepare('SELECT COUNT(*) AS count FROM project_files').get().count || 0),
      projectFigures: Number(db.prepare('SELECT COUNT(*) AS count FROM project_figures').get().count || 0),
      exportAssets: Number(db.prepare('SELECT COUNT(*) AS count FROM export_assets').get().count || 0),
      exportSnapshots: Number(db.prepare('SELECT COUNT(*) AS count FROM export_asset_snapshots').get().count || 0),
      renderCache: Number(db.prepare('SELECT COUNT(*) AS count FROM render_cache').get().count || 0),
    };
  } finally {
    db.close();
  }
}

function assertNoRenderPersistence(state, label) {
  const leaked = Object.entries(state).filter(([, count]) => count !== 0);
  assert(leaked.length === 0, `${label} persisted render state: ${JSON.stringify(state)}`);
}

function runProcessListCommand() {
  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop";',
      'Get-CimInstance Win32_Process',
      '| Where-Object { $_.CommandLine -match "Rscript|r_renderer|scifigure-r-job" }',
      '| Select-Object ProcessId,CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
  }
  return spawnSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function listRRendererProcesses() {
  const result = runProcessListCommand();
  if (result.status !== 0) {
    return { available: false, processes: [], error: result.stderr || result.error?.message || 'process listing failed' };
  }
  if (process.platform === 'win32') {
    const parsed = parseJson(result.stdout.trim(), []);
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return {
      available: true,
      processes: rows.map((row) => ({
        pid: String(row.ProcessId || ''),
        command: String(row.CommandLine || ''),
      })).filter((row) => row.command),
      error: '',
    };
  }
  const processes = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return { pid: match?.[1] || '', command: match?.[2] || line };
    })
    .filter((row) => /Rscript|r_renderer|scifigure-r-job/.test(row.command));
  return { available: true, processes, error: '' };
}

function listManagedRendererContainers() {
  const result = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { available: false, names: [], error: result.stderr || result.error?.message || 'docker inspection failed' };
  }
  return {
    available: true,
    names: String(result.stdout || '')
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name.startsWith('scifigure-render-')),
    error: '',
  };
}

async function waitForNoRJobProcesses(jobId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = listRRendererProcesses();
  while (Date.now() < deadline) {
    if (!last.available) return last;
    const matching = last.processes.filter((processInfo) => processInfo.command.includes(jobId));
    if (matching.length === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = listRRendererProcesses();
  }
  return last;
}

const timeoutScript = [
  'library(ggplot2)',
  'Sys.sleep(7)',
  'df <- data.frame(x = 1:3, y = c(1, 4, 2))',
  'p <- ggplot(df, aes(x, y)) + geom_line() + ggtitle("must-timeout-before-persist")',
  'p',
].join('\n');

async function main() {
  assertIsolatedEnvironment();
  assertTimeoutEnvironment();
  const token = await register();
  const before = readRenderPersistenceState();
  assertNoRenderPersistence(before, 'pre-timeout baseline');
  const containersBefore = listManagedRendererContainers();

  const startedAt = Date.now();
  const timedOut = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      language: 'r',
      script: timeoutScript,
      requestId: `r-wp9-timeout-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      renderOptions: { width_in: 7, height_in: 5 },
    }),
  });
  const elapsedMs = Date.now() - startedAt;

  assert(timedOut.response.ok, `timeout render returned HTTP ${timedOut.response.status}: ${JSON.stringify(timedOut.data)}`);
  assert(timedOut.data?.status === 'error', `timeout render unexpectedly succeeded: ${JSON.stringify(timedOut.data)}`);
  assert(timedOut.data?.diagnostic?.type === 'timeout', `R timeout was not classified as timeout: ${JSON.stringify(timedOut.data)}`);
  assert(elapsedMs < 20_000, `R timeout took too long and may be unstable: ${elapsedMs} ms`);

  const jobId = String(timedOut.data?.diagnostic?.details?.jobId || '');
  assert(/^scifigure-r-job-[A-Za-z0-9_-]+$/.test(jobId), `timeout diagnostic omitted safe job id: ${JSON.stringify(timedOut.data?.diagnostic)}`);
  assert(!fs.existsSync(path.join(os.tmpdir(), jobId)), `timed-out R job leaked temp directory: ${jobId}`);

  const processInspection = await waitForNoRJobProcesses(jobId);
  assert(processInspection.available, `unable to inspect local Rscript processes: ${processInspection.error}`);
  const leakedProcesses = processInspection.processes.filter((processInfo) => processInfo.command.includes(jobId));
  assert(leakedProcesses.length === 0, `request-created Rscript process remained for ${jobId}: ${JSON.stringify(leakedProcesses)}`);

  const containerInspection = listManagedRendererContainers();
  if (containerInspection.available) {
    const baselineNames = new Set(containersBefore.available ? containersBefore.names : []);
    const leakedNames = containerInspection.names.filter((name) => !baselineNames.has(name));
    assert(leakedNames.length === 0, `request-created managed renderer containers were left behind: ${leakedNames.join(', ')}`);
  }

  const after = readRenderPersistenceState();
  assertNoRenderPersistence(after, 'post-timeout');

  console.log(JSON.stringify({
    status: 'PASS',
    checked: [
      'isolated random-port wrapper guard',
      'isolated temp DB/data guard',
      'stable local R renderer timeout',
      'request-created Rscript job process cleanup',
      'scifigure-render-* container cleanup when Docker is inspectable',
      'no sessions/projects/figures/files/exports/snapshots/render_cache persisted by the timed-out render',
    ],
    elapsedMs,
    jobId,
    dockerInspection: containerInspection.available ? 'checked' : `unavailable: ${containerInspection.error}`,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    stack: error.stack,
  }, null, 2));
  process.exitCode = 1;
});
