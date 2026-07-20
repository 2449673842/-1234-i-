import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const WINDOWS_CONDA_PYTHON = 'C:\\Users\\SZC\\.conda\\envs\\Machine-learning\\python.exe';
const EXPECTED_PYTHON = '3.8.19';
const EXPECTED_MATPLOTLIB = '3.7.2';

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (process.platform === 'win32' && fs.existsSync(WINDOWS_CONDA_PYTHON)) {
    return WINDOWS_CONDA_PYTHON;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const modules = process.argv.slice(2);
if (modules.length === 0) {
  console.error('Usage: node scripts/testing/run_pinned_python_unittest.mjs <module> [...]');
  process.exit(2);
}

const pythonBin = resolvePythonBin();
const probe = spawnSync(
  pythonBin,
  ['-c', 'import matplotlib, sys; print(sys.version.split()[0]); print(matplotlib.__version__)'],
  { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
);
if (probe.status !== 0) {
  console.error(`Unable to start pinned Python runtime: ${pythonBin}`);
  console.error(probe.stderr || probe.error?.message || 'unknown error');
  process.exit(probe.status || 1);
}

const [pythonVersion, matplotlibVersion] = probe.stdout.trim().split(/\r?\n/);
if (pythonVersion !== EXPECTED_PYTHON || matplotlibVersion !== EXPECTED_MATPLOTLIB) {
  console.error(
    `Pinned runtime mismatch: expected Python ${EXPECTED_PYTHON} / Matplotlib ${EXPECTED_MATPLOTLIB}, `
      + `got Python ${pythonVersion || 'unknown'} / Matplotlib ${matplotlibVersion || 'unknown'}.`,
  );
  process.exit(1);
}

const result = spawnSync(
  pythonBin,
  ['-m', 'unittest', ...modules, '-v'],
  { cwd: process.cwd(), stdio: 'inherit', windowsHide: true },
);
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
