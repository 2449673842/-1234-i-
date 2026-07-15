import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-storage-atomicity-'));
const dataRoot = path.join(tempRoot, 'data');
const dbPath = path.join(dataRoot, 'scifigure.db');
const password = 'Storage-Atomicity-Test-2026';
const email = `storage-atomicity-${Date.now()}@example.test`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(baseUrl, processHandle, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Server exited early\n${output.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready\n${output.join('')}`);
}

function startServer(port, hmrPort) {
  const output = [];
  const processHandle = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SCIFIGURE_DATA_DIR: dataRoot,
      SCIFIGURE_DB_PATH: dbPath,
      SCIFIGURE_TEST_ISOLATED: '1',
      SCIFIGURE_RENDER_MODE: 'local',
      SCIFIGURE_PROJECT_MAX_FILES: '10',
      SCIFIGURE_PROJECT_TOTAL_STORAGE_MAX_MB: '100',
      SCIFIGURE_VITE_HMR_PORT: String(hmrPort),
      AUTH_RATE_LIMIT_PER_15_MINUTES: '500',
      DISABLE_HMR: 'true',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.stdout.on('data', chunk => output.push(String(chunk)));
  processHandle.stderr.on('data', chunk => output.push(String(chunk)));
  return { processHandle, output, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  if (server.processHandle.exitCode !== null) return;
  server.processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server.processHandle.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (server.processHandle.exitCode === null) server.processHandle.kill('SIGKILL');
}

async function jsonRequest(baseUrl, pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

const ports = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort()]);
const first = startServer(ports[0], ports[2]);
let second = null;

try {
  await waitForServer(first.baseUrl, first.processHandle, first.output);
  second = startServer(ports[1], ports[3]);
  await waitForServer(second.baseUrl, second.processHandle, second.output);

  const registration = await jsonRequest(first.baseUrl, '/api/auth/register', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert(registration.response.ok && registration.data?.token, `Registration failed: ${registration.response.status} ${JSON.stringify(registration.data)}`);
  const token = registration.data.token;
  const project = await jsonRequest(first.baseUrl, '/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Atomic storage budget fixture', spec: { plot_type: 'custom' } }),
  });
  assert(project.response.ok && project.data?.id, `Project creation failed: ${project.response.status} ${JSON.stringify(project.data)}`);
  const projectId = project.data.id;
  const rows = Array.from({ length: 2_000 }, (_, index) => `${index},${index * 2}`).join('\n');
  const csv = `x,y\n${rows}\n`;

  const results = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), `atomic-${index}.csv`);
    const baseUrl = index % 2 === 0 ? first.baseUrl : second.baseUrl;
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }));

  const successes = results.filter(result => result.status === 200);
  const rejected = results.filter(result => result.status === 413);
  const unexpected = results.filter(result => result.status !== 200 && result.status !== 413);
  assert(successes.length === 10, `Exactly ten files must fit the atomic project budget, got ${successes.length}: ${JSON.stringify(results)}`);
  assert(rejected.length === 10, `Remaining uploads must be rejected with 413, got ${rejected.length}`);
  assert(unexpected.length === 0, `Storage contention produced unexpected responses: ${JSON.stringify(unexpected)}`);

  const listed = await jsonRequest(second.baseUrl, `/api/projects/${projectId}/files`, token);
  assert(listed.response.ok && listed.data?.datasets?.length === 10, `Registered file count exceeded the budget: ${JSON.stringify(listed.data)}`);
  const physicalDir = path.join(dataRoot, 'projects', projectId, 'files');
  const physicalFiles = fs.existsSync(physicalDir) ? fs.readdirSync(physicalDir) : [];
  assert(physicalFiles.length === 10, `Rejected uploads left physical residue: ${physicalFiles.length}`);

  const exportsDir = path.join(dataRoot, 'projects', projectId, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const prefillPath = path.join(exportsDir, 'atomic-prefill.svg');
  fs.writeFileSync(prefillPath, '');
  fs.truncateSync(prefillPath, 98 * 1024 * 1024);
  const database = new Database(dbPath);
  database.prepare(`
    INSERT INTO export_assets (
      id, project_id, figure_id, name, format, dpi, file_path, thumbnail_svg, metadata, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'atomic-prefill-export',
    projectId,
    'fig_1',
    'Atomic storage prefill',
    'svg',
    null,
    path.relative(repoRoot, prefillPath).replace(/\\/g, '/'),
    null,
    '{}',
    '[]',
  );
  database.close();

  const largeSafeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><desc>${'x'.repeat(800 * 1024)}</desc><rect width="1" height="1"/></svg>`;
  const exportResults = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const baseUrl = index % 2 === 0 ? first.baseUrl : second.baseUrl;
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/export-assets/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'svg', name: `atomic-export-${index}`, svg: largeSafeSvg }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }));
  const exportSuccesses = exportResults.filter(result => result.status === 200);
  const exportRejected = exportResults.filter(result => result.status === 413);
  const exportUnexpected = exportResults.filter(result => result.status !== 200 && result.status !== 413);
  assert(exportSuccesses.length === 1, `Exactly one export should fit the shared project budget: ${JSON.stringify(exportResults)}`);
  assert(exportRejected.length === 7, `Seven concurrent exports should be rejected with 413: ${JSON.stringify(exportResults)}`);
  assert(exportUnexpected.length === 0, `Export storage contention produced unexpected responses: ${JSON.stringify(exportUnexpected)}`);

  const verifyDatabase = new Database(dbPath, { readonly: true });
  const exportRows = verifyDatabase.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId).count;
  verifyDatabase.close();
  const physicalExports = fs.readdirSync(exportsDir);
  assert(exportRows === 2, `Rejected exports left database records: ${exportRows}`);
  assert(physicalExports.length === 2, `Rejected exports left physical residue: ${physicalExports.length}`);

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'two server processes share one SQLite storage budget safely',
      'project file count cannot oversubscribe under concurrent uploads',
      'rejected multipart uploads leave no registered or physical residue',
      'concurrent export assets cannot oversubscribe the shared project budget',
      'rejected export assets leave no database or physical residue',
    ],
  }, null, 2));
} finally {
  await Promise.all([stopServer(first), ...(second ? [stopServer(second)] : [])]);
  const resolvedTemp = path.resolve(tempRoot);
  if (resolvedTemp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolvedTemp).startsWith('scifigure-storage-atomicity-')) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
