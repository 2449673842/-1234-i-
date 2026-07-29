import Database from 'better-sqlite3';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'restore concurrency smoke requires the isolated wrapper');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
}

async function jsonRequest(requestPath, token, options = {}) {
  const response = await fetch(`${BASE_URL}${requestPath}`, {
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

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function readState(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    return JSON.stringify({
      project: database.prepare(
        'SELECT spec, script, updated_at FROM projects WHERE id = ?',
      ).get(projectId),
      session: database.prepare(
        'SELECT script, edit_log, revision, updated_at FROM sessions WHERE id = ?',
      ).get(`${projectId}_fig_1`),
      figure: database.prepare(`
        SELECT session_id, revision, edit_log, history, preview_svg, manifest,
               code_slice, fingerprint, preview_updated_at
        FROM project_figures
        WHERE project_id = ? AND figure_index = 0
      `).get(projectId),
    });
  } finally {
    database.close();
  }
}

const slowScript = `
import time
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

time.sleep(1.2)
fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1, 2], [1, 3, 2], color="#176b5b")
ax.set_title("Slow restore snapshot")
plt.show()
`;

const concurrentScript = slowScript.replace('Slow restore snapshot', 'Concurrent edit must survive');

async function main() {
  assertIsolatedEnvironment();
  const registered = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `restore-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Restore-Concurrency-Test-Password-2026',
    }),
  });
  assert(registered.response.ok && registered.data?.token, `registration failed: ${JSON.stringify(registered.data)}`);
  const token = registered.data.token;
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Export restore concurrency smoke',
      spec: { plot_type: 'custom', custom_script: slowScript, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  try {
    const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script: slowScript, editLogs: {}, language: 'python' }),
    });
    assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    const asset = exported.data?.figures?.[0]?.asset;
    assert(exported.response.ok && asset?.assetId, `export failed: ${JSON.stringify(exported.data)}`);

    const restorePromise = jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    await delay(450);

    const database = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      database.pragma('busy_timeout = 5000');
      database.transaction(() => {
        database.prepare(`
          UPDATE projects SET script = ?, updated_at = datetime('now') WHERE id = ?
        `).run(concurrentScript, projectId);
        database.prepare(`
          UPDATE sessions
          SET script = ?, edit_log = '[]', revision = 42, updated_at = datetime('now')
          WHERE id = ?
        `).run(concurrentScript, `${projectId}_fig_1`);
        database.prepare(`
          UPDATE project_figures
          SET revision = 42, edit_log = '[]', preview_svg = 'concurrent-preview',
              preview_updated_at = datetime('now')
          WHERE project_id = ? AND figure_index = 0
        `).run(projectId);
      })();
    } finally {
      database.close();
    }
    const concurrentState = readState(projectId);

    const restored = await restorePromise;
    assert(
      restored.response.status === 409
        && restored.data?.code === 'EXPORT_SNAPSHOT_CONCURRENT_MODIFICATION',
      `restore should reject a concurrent project mutation: ${JSON.stringify(restored.data)}`,
    );
    assert(
      readState(projectId) === concurrentState,
      'rejected concurrent restore overwrote the newer project/session/Figure state',
    );

    console.log('PASS restore detects project/session/Figure mutation during renderer dry-run');
    console.log('PASS concurrent state remains unchanged after restore conflict');
  } finally {
    await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
