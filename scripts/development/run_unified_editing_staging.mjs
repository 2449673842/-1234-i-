import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_PORT = 3200;
const GIT_COMMON_DIR = path.resolve(ROOT, execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim());
const STABLE_ROOT = path.dirname(GIT_COMMON_DIR);
const PROTECTED_DATA_DIRS = Array.from(new Set([
  path.resolve(ROOT, 'data'),
  path.resolve(STABLE_ROOT, 'data'),
  process.env.SCIFIGURE_STABLE_DATA_DIR ? path.resolve(process.env.SCIFIGURE_STABLE_DATA_DIR) : null,
].filter(Boolean)));
const STAGING_DATA_DIR = path.resolve(
  process.env.SCIFIGURE_STAGING_DATA_DIR || path.join(ROOT, 'tmp', 'unified-editing-staging', 'data'),
);
const STAGING_DB_PATH = path.resolve(
  process.env.SCIFIGURE_STAGING_DB_PATH || path.join(STAGING_DATA_DIR, 'scifigure.db'),
);
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const STAGING_NODE_ENV = process.env.SCIFIGURE_STAGING_NODE_ENV || 'production';
const STAGING_BUILD_ROOT = path.join(ROOT, 'tmp', 'unified-editing-builds');
const STAGING_BUILD_POINTER = path.join(ROOT, 'tmp', 'unified-editing-staging', 'current-build.json');
let stagingDistDir = path.join(ROOT, 'dist');
const ALLOWED_STAGING_ROOT = path.resolve(
  process.env.SCIFIGURE_STAGING_ALLOWED_ROOT || path.join(ROOT, 'tmp', 'unified-editing-staging'),
);
const SAFE_RENDER_ENV_KEYS = [
  'PYTHON_BIN', 'RSCRIPT_BIN', 'R_BIN',
  'SCIFIGURE_RENDER_MODE', 'SCIFIGURE_RENDERER_IMAGE',
  'SCIFIGURE_RENDER_MEMORY', 'SCIFIGURE_RENDER_CPUS', 'SCIFIGURE_RENDER_PIDS',
  'SCIFIGURE_RENDER_OUTPUT_MB', 'SCIFIGURE_R_TIMEOUT_MS',
  'SCIFIGURE_ALLOW_UNSAFE_LOCAL_RENDERER', 'SCIFIGURE_R_RISK_ENFORCE',
  'SCIFIGURE_TABULAR_TIMEOUT_MS', 'SCIFIGURE_TABULAR_OUTPUT_MB',
  'SCIFIGURE_TABULAR_MEMORY', 'SCIFIGURE_TABULAR_CPUS', 'SCIFIGURE_TABULAR_PIDS',
];

function parseArgs(argv) {
  const options = { check: false, help: false, port: DEFAULT_PORT };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--check' || arg === '--dry-run') {
      options.check = true;
      continue;
    }
    if (arg === '--port') {
      const value = argv[index + 1];
      if (!value) throw new Error('--port requires a value');
      options.port = Number(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/development/run_unified_editing_staging.mjs [--port <port>] [--dry-run]

Starts the unified editing staging server with isolated repo-local staging data.

Options:
  --port <port>  Port to bind. Defaults to ${DEFAULT_PORT}.
  --dry-run      Validate paths, local tsx, and port availability without starting.
  --check        Alias for --dry-run.
  --help         Show this help text.`);
}

function comparable(resolvedPath) {
  const normalized = path.resolve(resolvedPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isEqualOrInside(candidatePath, parentPath) {
  const candidate = comparable(candidatePath);
  const parent = comparable(parentPath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertStagingDataIsIsolated() {
  if (!isEqualOrInside(STAGING_DATA_DIR, ALLOWED_STAGING_ROOT)) {
    throw new Error(
      `Staging data must stay inside the allowed staging root.\n` +
      `Allowed root: ${ALLOWED_STAGING_ROOT}\n` +
      `Rejected path: ${STAGING_DATA_DIR}`
    );
  }
  for (const protectedDir of PROTECTED_DATA_DIRS) {
    for (const candidate of [STAGING_DATA_DIR, STAGING_DB_PATH]) {
      if (isEqualOrInside(candidate, protectedDir)) {
        throw new Error(
          `Refusing to use staging path inside protected data directory.\n` +
          `Protected data directory: ${protectedDir}\n` +
          `Rejected path: ${candidate}`
        );
      }
    }
  }
  if (!isEqualOrInside(STAGING_DB_PATH, STAGING_DATA_DIR)) {
    throw new Error(`Staging database must stay inside staging data directory: ${STAGING_DB_PATH}`);
  }
}

function assertLocalTsxExists() {
  if (!fs.existsSync(TSX_CLI)) {
    throw new Error(`Local tsx CLI not found: ${TSX_CLI}`);
  }
}

function assertProductionAssetsExist() {
  if (STAGING_NODE_ENV !== 'production') return;
  if (!fs.existsSync(STAGING_BUILD_POINTER)) {
    throw new Error(
      `Production-like staging requires a descriptor-enabled candidate build.\n` +
      `Run: npm run build:unified-editing-staging\n` +
      `Missing pointer: ${STAGING_BUILD_POINTER}`
    );
  }
  const pointer = JSON.parse(fs.readFileSync(STAGING_BUILD_POINTER, 'utf8'));
  const resolvedDistDir = path.resolve(String(pointer?.distDir || ''));
  if (!isEqualOrInside(resolvedDistDir, STAGING_BUILD_ROOT)) {
    throw new Error(`Candidate build is outside the staging build root: ${resolvedDistDir}`);
  }
  const markerPath = path.join(resolvedDistDir, '.unified-editing-staging.json');
  const publicMarkerPath = path.join(resolvedDistDir, 'unified-editing-build.json');
  const indexPath = path.join(resolvedDistDir, 'index.html');
  if (!fs.existsSync(indexPath) || !fs.existsSync(markerPath) || !fs.existsSync(publicMarkerPath)) {
    throw new Error(`Candidate build is incomplete: ${resolvedDistDir}`);
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker?.kind !== 'unified-editing-staging'
    || marker?.propertyDescriptorV1 !== true
    || marker?.propertyInspectorV2 !== true
    || marker?.buildId !== pointer?.buildId) {
    throw new Error(`Invalid unified editing staging build marker: ${markerPath}`);
  }
  stagingDistDir = resolvedDistDir;
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      if (error && error.code === 'EADDRINUSE') {
        reject(new Error(`Refusing to start: port ${port} is already occupied.`));
        return;
      }
      reject(error);
    });
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

function safeStableRenderEnv() {
  const stableEnvPath = path.join(STABLE_ROOT, '.env');
  const parsed = fs.existsSync(stableEnvPath)
    ? parseDotenv(fs.readFileSync(stableEnvPath))
    : {};
  return Object.fromEntries(SAFE_RENDER_ENV_KEYS.flatMap(key => {
    const value = process.env[key] ?? parsed[key];
    return value ? [[key, value]] : [];
  }));
}

function stagingEnv(port) {
  return {
    ...process.env,
    ...safeStableRenderEnv(),
    NODE_ENV: STAGING_NODE_ENV,
    PORT: String(port),
    SCIFIGURE_DATA_DIR: STAGING_DATA_DIR,
    SCIFIGURE_DB_PATH: STAGING_DB_PATH,
    SCIFIGURE_DIST_DIR: stagingDistDir,
    SCIFIGURE_STAGING_INSTANCE: 'unified-editing',
    SCIFIGURE_RENDER_CONCURRENCY: process.env.SCIFIGURE_STAGING_RENDER_CONCURRENCY || '1',
    DISABLE_HMR: 'true',
    VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1: '1',
    VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2: '1',
  };
}

function printConfig(port) {
  console.log('Unified editing staging configuration OK');
  console.log(`Root: ${ROOT}`);
  console.log(`Port: ${port}`);
  console.log(`Data: ${STAGING_DATA_DIR}`);
  console.log(`DB: ${STAGING_DB_PATH}`);
  console.log(`Candidate build: ${stagingDistDir}`);
  console.log(`Protected data roots: ${PROTECTED_DATA_DIRS.join(', ')}`);
  console.log(`Allowed staging root: ${ALLOWED_STAGING_ROOT}`);
  console.log('Renderer concurrency: 1 (override with SCIFIGURE_STAGING_RENDER_CONCURRENCY)');
  console.log(`Node environment: ${STAGING_NODE_ENV}`);
  console.log(`Vite HMR: ${STAGING_NODE_ENV === 'production' ? 'not started' : 'disabled'}`);
  console.log('Feature flags: VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1=1, VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2=1');
}

async function startServer(port) {
  const child = spawn(process.execPath, [TSX_CLI, 'server.ts'], {
    cwd: ROOT,
    env: stagingEnv(port),
    stdio: 'inherit',
    shell: false,
  });

  let forwarding = false;
  const forwardSignal = signal => {
    if (forwarding) return;
    forwarding = true;
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 5000).unref();
  };

  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  const exitCode = await new Promise(resolve => {
    child.once('exit', (code, signal) => {
      if (code !== null) resolve(code);
      else resolve(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
    });
    child.once('error', error => {
      console.error(error);
      resolve(1);
    });
  });

  process.exitCode = exitCode;
}

async function main() {
  const { check, help, port } = parseArgs(process.argv.slice(2));
  if (help) {
    printUsage();
    return;
  }
  assertStagingDataIsIsolated();
  assertLocalTsxExists();
  assertProductionAssetsExist();
  await assertPortFree(port);

  if (check) {
    printConfig(port);
    return;
  }

  console.log(`Starting unified editing staging server on http://localhost:${port}`);
  console.log(`Using staging data directory: ${STAGING_DATA_DIR}`);
  await startServer(port);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
