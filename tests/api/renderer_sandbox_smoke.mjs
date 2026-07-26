import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

const repoRoot = process.cwd();
const originalUmask = process.umask(0o077);
let BASE_URL = process.env.SCIFIGURE_URL || '';
let ownedServer = null;
let tempDir = null;
const serverOutput = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function assertCapabilityManifest(result, label) {
  const objects = result?.manifest?.objects;
  assert(Array.isArray(objects) && objects.length > 0, `${label} did not return manifest objects`);
  const capabilityBacked = objects.filter((object) => (
    object?.identity?.instanceKey
    && Array.isArray(object?.propertyCapabilities)
    && object.propertyCapabilities.length > 0
  ));
  assert(capabilityBacked.length > 0, `${label} did not return identity/capability-backed objects`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDir() {
  if (!tempDir) return;
  const resolvedTemp = path.resolve(tempDir);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  assert(
    resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`)
      && path.basename(resolvedTemp).startsWith('scifigure-renderer-sandbox-'),
    `Refusing to remove unexpected sandbox test path: ${resolvedTemp}`,
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) throw error;
      await delay(250 * (attempt + 1));
    }
  }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const selectedPort = typeof address === 'object' && address ? address.port : 0;
      listener.close((error) => error ? reject(error) : resolve(selectedPort));
    });
  });
}

function assertIsolatedExternalServer() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'external sandbox server requires the isolated wrapper marker');
  assert(process.env.SCIFIGURE_DATA_DIR, 'external sandbox server requires SCIFIGURE_DATA_DIR');
  assert(process.env.SCIFIGURE_DB_PATH, 'external sandbox server requires SCIFIGURE_DB_PATH');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe sandbox URL: ${BASE_URL}`);
  const resolvedDataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const resolvedDbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert(resolvedDbPath.startsWith(`${resolvedDataDir}${path.sep}`), `sandbox DB is outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(repoRoot, 'data'), 'sandbox test refuses the repository data directory');
}

async function register() {
  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Sandbox-Test-Password-2026',
    }),
  });
  const data = await response.json().catch(() => null);
  assert(response.ok && data?.token, `Registration failed: ${response.status} ${JSON.stringify(data)}`);
  return data.token;
}

async function ensureServer() {
  if (BASE_URL) {
    assertIsolatedExternalServer();
    return;
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-renderer-sandbox-'));
  const port = await reservePort();
  BASE_URL = `http://127.0.0.1:${port}`;
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  ownedServer = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SCIFIGURE_DATA_DIR: path.join(tempDir, 'data'),
      SCIFIGURE_DB_PATH: path.join(tempDir, 'data', 'scifigure-test.db'),
      SCIFIGURE_LEGACY_OWNER_EMAIL: '',
      SCIFIGURE_TEST_ISOLATED: '1',
      SCIFIGURE_RENDER_MODE: 'docker',
      SCIFIGURE_R_RISK_ENFORCE: '0',
      SCIFIGURE_R_TIMEOUT_MS: '15000',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedServer.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  ownedServer.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/auth/me`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Sandbox server did not start. Output:\n${serverOutput.join('')}`);
}

async function cleanupServer() {
  if (ownedServer && ownedServer.exitCode === null) {
    ownedServer.kill('SIGTERM');
    const exited = await waitForExit(ownedServer, 5_000);
    if (!exited && ownedServer.exitCode === null) {
      ownedServer.kill('SIGKILL');
      await waitForExit(ownedServer, 5_000);
    }
  }
  await removeTempDir();
}

async function render(token, script, language = 'python') {
  const response = await fetch(`${BASE_URL}/api/figure/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ script, language }),
  });
  return { response, data: await response.json().catch(() => null) };
}

async function exportFigure(token, sessionId, format = 'png') {
  const response = await fetch(`${BASE_URL}/api/figure/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, format, dpi: 150 }),
  });
  return { response, data: await response.json().catch(() => null) };
}

async function uploadWorkbook(token) {
  const projectResponse = await fetch(`${BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `Sandbox workbook ${Date.now()}`,
      spec: { plot_type: 'custom', script_language: 'python' },
    }),
  });
  const project = await projectResponse.json().catch(() => null);
  assert(projectResponse.ok && project?.id, `Workbook project creation failed: ${projectResponse.status} ${JSON.stringify(project)}`);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['sample', 'value'],
      ['A', 1],
      ['B', 2],
    ]),
    'Results',
  );
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const form = new FormData();
  form.append('file', new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), 'sandbox-results.xlsx');
  const uploadResponse = await fetch(`${BASE_URL}/api/projects/${project.id}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploaded = await uploadResponse.json().catch(() => null);
  assert(
    uploadResponse.ok
      && uploaded?.status === 'success'
      && JSON.stringify(uploaded.columns) === JSON.stringify(['sample', 'value'])
      && uploaded.rowCount === 2,
    `Workbook sandbox parse failed: ${uploadResponse.status} ${JSON.stringify(uploaded)}`,
  );
  return uploaded;
}

async function main() {
  await ensureServer();
  const token = await register();
  const workbook = await uploadWorkbook(token);
  assert(workbook.fileName === 'sandbox-results.xlsx', `Unexpected workbook response: ${JSON.stringify(workbook)}`);
  if (process.env.SCIFIGURE_SANDBOX_WORKBOOK_ONLY === '1') {
    console.log(JSON.stringify({
      status: 'PASS',
      baseUrl: BASE_URL,
      workbook: {
        fileName: workbook.fileName,
        columns: workbook.columns,
        rowCount: workbook.rowCount,
      },
    }, null, 2));
    return;
  }
  const normal = await render(token, [
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(2, 1.5))',
    'ax.plot([0, 1], [0, 1])',
    'ax.set_title("sandbox-ok")',
  ].join('\n'));
  assert(normal.response.ok && normal.data?.status === 'success', `Normal sandbox render failed: ${normal.response.status} ${JSON.stringify(normal.data)}`);
  assertCapabilityManifest(normal.data, 'Python sandbox render');

  const fileProbe = await render(token, [
    'from pathlib import Path',
    'import matplotlib.pyplot as plt',
    'secret = Path("/app/data/scifigure.db").read_bytes()',
    'fig, ax = plt.subplots()',
    'ax.set_title(str(len(secret)))',
  ].join('\n'));
  assert(fileProbe.data?.status === 'error', 'Sandbox unexpectedly read host database path');

  const networkProbe = await render(token, [
    'import urllib.request',
    'import matplotlib.pyplot as plt',
    'payload = urllib.request.urlopen("https://example.com", timeout=2).read()',
    'fig, ax = plt.subplots()',
    'ax.set_title(str(len(payload)))',
  ].join('\n'));
  assert(networkProbe.data?.status === 'error', 'Sandbox unexpectedly accessed the network');

  const rNormal = await render(token, [
    'library(ggplot2)',
    'df <- data.frame(x = c(1, 2, 3), y = c(1, 4, 2))',
    'p <- ggplot(df, aes(x, y)) + geom_line() + geom_point() + ggtitle("r-sandbox-ok")',
    'print(p)',
  ].join('\n'), 'r');
  assert(rNormal.response.ok && rNormal.data?.status === 'success', `Normal R sandbox render failed: ${rNormal.response.status} ${JSON.stringify(rNormal.data)}`);
  assertCapabilityManifest(rNormal.data, 'R sandbox render');

  const rPngExport = await exportFigure(token, rNormal.data?.sessionId, 'png');
  assert(
    rPngExport.response.ok && rPngExport.data?.status === 'success' && rPngExport.data?.binary_b64,
    `R PNG sandbox export failed: ${rPngExport.response.status} ${JSON.stringify(rPngExport.data)}`,
  );

  const timeoutStartedAt = Date.now();
  const rTimeoutProbe = await render(token, 'while (TRUE) {}', 'r');
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert(rTimeoutProbe.data?.status === 'error', 'Infinite R script should be terminated');
  assert(timeoutElapsedMs < 20_000, `R timeout took too long: ${timeoutElapsedMs} ms`);

  const rAfterTimeout = await render(token, [
    'plot(1, 1, main = "r-after-timeout")',
  ].join('\n'), 'r');
  assert(rAfterTimeout.response.ok && rAfterTimeout.data?.status === 'success', `R renderer did not recover after timeout: ${rAfterTimeout.response.status} ${JSON.stringify(rAfterTimeout.data)}`);

  const residualContainers = spawnSync('docker', [
    'ps', '-a', '--filter', 'label=scifigure.managed=true', '--format', '{{.Names}}',
  ], { encoding: 'utf8' });
  assert(residualContainers.status === 0, `Unable to inspect managed containers: ${residualContainers.stderr}`);
  assert(!String(residualContainers.stdout || '').trim(), `Managed renderer containers were left behind: ${residualContainers.stdout}`);

  const rFileProbe = await render(token, [
    'secret <- readLines("/app/data/scifigure.db", warn = FALSE)',
    'plot(1, 1, main = paste(length(secret)))',
  ].join('\n'), 'r');
  assert(rFileProbe.data?.status === 'error', 'R sandbox unexpectedly read host database path');

  const rNetworkProbe = await render(token, [
    'payload <- readLines(url("https://example.com"), warn = FALSE)',
    'plot(1, 1, main = paste(length(payload)))',
  ].join('\n'), 'r');
  assert(rNetworkProbe.data?.status === 'error', 'R sandbox unexpectedly accessed the network');

  console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    serverOutput: serverOutput.join('').slice(-8_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await cleanupServer();
  process.umask(originalUmask);
}
