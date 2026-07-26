import { spawnSync } from 'node:child_process';

const target = process.argv[2];
const cases = {
  performance: {
    test: 'tests/api/r_wp9_performance_persistence_smoke.mjs',
    env: { SCIFIGURE_MAX_PERSISTED_SVG_MB: '0.05' },
  },
  timeout: {
    test: 'tests/api/r_wp9_timeout_cleanup_smoke.mjs',
    env: {
      NODE_ENV: 'development',
      SCIFIGURE_RENDER_MODE: 'local',
      SCIFIGURE_R_TIMEOUT_MS: '5000',
    },
  },
};

const selected = cases[target];
if (!selected) {
  console.error('Usage: node scripts/testing/run_r_wp9_smoke.mjs <performance|timeout>');
  process.exit(2);
}

const result = spawnSync(process.execPath, [
  'scripts/testing/run_with_isolated_server.mjs',
  '--',
  process.execPath,
  selected.test,
], {
  cwd: process.cwd(),
  env: { ...process.env, ...selected.env },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
