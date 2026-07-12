import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GIT_COMMON_DIR = path.resolve(ROOT, execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim());
const STABLE_ROOT = path.dirname(GIT_COMMON_DIR);
const BUILD_ROOT = path.join(ROOT, 'tmp', 'unified-editing-builds');
const POINTER_PATH = path.join(ROOT, 'tmp', 'unified-editing-staging', 'current-build.json');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const INHERITED_FEATURE_FLAGS = [
  'VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW',
  'VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2',
  'VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2',
  'VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2',
];

function stableFeatureEnv() {
  const stableEnvPath = path.join(STABLE_ROOT, '.env');
  const parsed = fs.existsSync(stableEnvPath)
    ? parseDotenv(fs.readFileSync(stableEnvPath))
    : {};
  return Object.fromEntries(INHERITED_FEATURE_FLAGS.flatMap(key => {
    const value = process.env[key] ?? parsed[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

function runBuild(distDir) {
  const env = {
    ...process.env,
    ...stableFeatureEnv(),
    VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1: '1',
    DISABLE_HMR: 'true',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITE_CLI, 'build', '--outDir', distDir, '--emptyOutDir'], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Staging build failed with exit code ${code}`)));
  });
}

const gitRevision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${gitRevision}`;
const candidateRoot = path.join(BUILD_ROOT, buildId);
const distDir = path.join(candidateRoot, 'dist');
const markerPath = path.join(distDir, '.unified-editing-staging.json');

fs.mkdirSync(candidateRoot, { recursive: true });
await runBuild(distDir);
const marker = {
  kind: 'unified-editing-staging',
  buildId,
  builtAt: new Date().toISOString(),
  gitRevision,
  propertyDescriptorV1: true,
};
fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
fs.mkdirSync(path.dirname(POINTER_PATH), { recursive: true });
fs.writeFileSync(POINTER_PATH, `${JSON.stringify({ ...marker, distDir }, null, 2)}\n`, 'utf8');
console.log(`Unified editing candidate build: ${distDir}`);
console.log(`Unified editing build pointer: ${POINTER_PATH}`);
