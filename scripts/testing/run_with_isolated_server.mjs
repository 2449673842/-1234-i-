import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const separator = process.argv.indexOf('--');
const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
if (command.length === 0) {
  console.error('Usage: node scripts/testing/run_with_isolated_server.mjs -- <command> [args...]');
  process.exit(2);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, serverProcess, logLines) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Isolated server exited early (${serverProcess.exitCode})\n${logLines.join('')}`);
    }
    try {
      const response = await fetch(`${url}/api/auth/me`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for isolated server\n${logLines.join('')}`);
}

function runChild(executable, args, env) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: ROOT, env, stdio: 'inherit', shell: false });
    child.once('exit', code => resolve(code ?? 1));
    child.once('error', error => {
      console.error(error);
      resolve(1);
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-isolated-smoke-'));
  const dataRoot = path.join(tempRoot, 'data');
  const port = await reservePort();
  const hmrPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    SCIFIGURE_URL: baseUrl,
    SCIFIGURE_DATA_DIR: dataRoot,
    SCIFIGURE_DB_PATH: path.join(dataRoot, 'scifigure.db'),
    SCIFIGURE_LEGACY_OWNER_EMAIL: '',
    SCIFIGURE_TEST_ISOLATED: '1',
    SCIFIGURE_VITE_HMR_PORT: String(hmrPort),
    // Browser acceptance checks do not exercise Vite's development transport.
    // Disable it so fixed HMR websocket ports cannot masquerade as app errors.
    DISABLE_HMR: 'true',
    RENDER_RATE_LIMIT_PER_MINUTE: process.env.RENDER_RATE_LIMIT_PER_MINUTE || '120',
  };
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const logLines = [];
  const serverProcess = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', chunk => logLines.push(String(chunk)));
  serverProcess.stderr.on('data', chunk => logLines.push(String(chunk)));

  let exitCode = 1;
  try {
    await waitForServer(baseUrl, serverProcess, logLines);
    exitCode = await runChild(command[0], command.slice(1), env);
  } finally {
    serverProcess.kill('SIGTERM');
    const exited = await waitForExit(serverProcess, 3000);
    if (!exited && serverProcess.exitCode === null) {
      serverProcess.kill('SIGKILL');
      await waitForExit(serverProcess, 3000);
    }
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`) && path.basename(resolvedTemp).startsWith('scifigure-isolated-smoke-')) {
      fs.rmSync(resolvedTemp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }
  process.exitCode = exitCode;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
