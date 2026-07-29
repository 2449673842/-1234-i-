import path from 'node:path';
import Database from 'better-sqlite3';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target 127.0.0.1, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');
  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated test requires SCIFIGURE_DATA_DIR and SCIFIGURE_DB_PATH');
  const resolvedDataDir = path.resolve(dataDir);
  assert(path.resolve(dbPath).startsWith(`${resolvedDataDir}${path.sep}`), 'isolated DB must be under the temp data root');
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/ directory');
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
  const registered = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `replay-warning-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Replay-Warning-2026',
    }),
  });
  assert(registered.response.ok && registered.data?.token, `registration failed: ${JSON.stringify(registered.data)}`);
  return registered.data.token;
}

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  'COLOR = "#336699"',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'ax1.plot([0, 1, 2], [1, 3, 2], color=COLOR, label="first")',
  'ax1.set_title("Replay warning first")',
  'ax1.legend()',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 3], color=COLOR, label="second")',
  'ax2.set_title("Replay warning second")',
  'ax2.legend()',
].join('\n');

function openDatabase(readonly = false) {
  return new Database(process.env.SCIFIGURE_DB_PATH, readonly ? { readonly: true } : undefined);
}

async function createRenderedProject(token, label) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Replay warning ${label} ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [], fig_2: [] },
      language: 'python',
      requestId: `replay-warning-${label}-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `project render failed: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data.figures?.length === 2, `fixture must render two figures: ${JSON.stringify(rendered.data.figures)}`);
  return { projectId, figures: rendered.data.figures };
}

function injectStaleSecondFigureEdit(projectId) {
  const staleEdit = {
    gid: 'missing.fig2.object',
    prop: 'linewidth',
    value: 4.5,
    mode: 'backend_patch',
    timestamp: Date.now(),
  };
  const database = openDatabase();
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(`
      SELECT session_id FROM project_figures
      WHERE project_id = ? AND figure_index = 1
    `).get(projectId);
    assert(row?.session_id, 'fig_2 session row is missing');
    const editLog = JSON.stringify([staleEdit]);
    database.transaction(() => {
      database.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?').run(editLog, row.session_id);
      database.prepare(`
        UPDATE project_figures SET edit_log = ?
        WHERE project_id = ? AND figure_index = 1
      `).run(editLog, projectId);
    })();
    return { staleEdit, sessionId: row.session_id };
  } finally {
    database.close();
  }
}

function readProjectPersistenceState(projectId) {
  const database = openDatabase(true);
  try {
    database.pragma('busy_timeout = 5000');
    return JSON.stringify({
      project: database.prepare('SELECT id, spec, updated_at FROM projects WHERE id = ?').get(projectId),
      figures: database.prepare(`
        SELECT figure_index, session_id, revision, edit_log, history,
               preview_svg, manifest, code_slice, fingerprint, preview_updated_at
        FROM project_figures WHERE project_id = ? ORDER BY figure_index
      `).all(projectId),
      sessions: database.prepare(`
        SELECT id, script, data_payload, edit_log, revision, updated_at
        FROM sessions
        WHERE id IN (SELECT session_id FROM project_figures WHERE project_id = ?)
        ORDER BY id
      `).all(projectId),
      assets: database.prepare('SELECT id, figure_id, name, format FROM export_assets WHERE project_id = ? ORDER BY id').all(projectId),
      snapshots: database.prepare('SELECT asset_id, snapshot_hash FROM export_asset_snapshots WHERE project_id = ? ORDER BY asset_id').all(projectId),
    });
  } finally {
    database.close();
  }
}

async function verifyProjectCodePatchAtomicity(token) {
  const fixture = await createRenderedProject(token, 'code-patch');
  injectStaleSecondFigureEdit(fixture.projectId);
  const before = readProjectPersistenceState(fixture.projectId);
  const firstFigure = fixture.figures.find(figure => figure.figureId === 'fig_1');
  assert(firstFigure, 'fig_1 is missing from render response');

  const patched = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${fixture.projectId}_fig_1`,
      projectId: fixture.projectId,
      figureId: 'fig_1',
      baseRevision: firstFigure.revision,
      requestId: `replay-warning-code-patch-${Date.now()}`,
      patches: [{
        type: 'code_patch',
        target_id: 'COLOR',
        new_value: '#aa3377',
        gids: [],
      }],
    }),
  });

  assert(patched.response.ok && patched.data?.status === 'conflict', `project-wide code patch must conflict: ${JSON.stringify(patched.data)}`);
  assert(
    patched.data.warnings?.some(warning => warning?.figureId === 'fig_2' && warning?.type === 'missing_gid'),
    `conflict must identify the stale fig_2 edit: ${JSON.stringify(patched.data)}`,
  );
  assert(readProjectPersistenceState(fixture.projectId) === before, 'rejected code patch changed project/session/Figure/export persistence state');
  return fixture.projectId;
}

async function verifyExportReplayWarningBlock(token) {
  const fixture = await createRenderedProject(token, 'export');
  injectStaleSecondFigureEdit(fixture.projectId);
  const before = readProjectPersistenceState(fixture.projectId);
  const bulkExported = await jsonRequest(`/api/projects/${fixture.projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      format: 'svg',
      dpi: 300,
      saveToLibrary: true,
      includeSubplots: true,
    }),
  });

  assert(
    bulkExported.response.status === 409
      && bulkExported.data?.status === 'conflict'
      && bulkExported.data?.code === 'EXPORT_REPLAY_CONFLICT'
      && bulkExported.data?.figureId === 'fig_2',
    `bulk export with a stale later Figure must be rejected: ${bulkExported.response.status} ${JSON.stringify(bulkExported.data)}`,
  );
  assert(
    readProjectPersistenceState(fixture.projectId) === before,
    'rejected bulk export persisted an earlier Figure asset/snapshot before discovering the stale Figure',
  );

  const exported = await jsonRequest(`/api/projects/${fixture.projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_2',
      format: 'svg',
      dpi: 300,
      saveToLibrary: true,
      includeSubplots: true,
    }),
  });

  assert(
    exported.response.status === 409
      && exported.data?.status === 'conflict'
      && exported.data?.code === 'EXPORT_REPLAY_CONFLICT',
    `stale export must be rejected before persistence: ${exported.response.status} ${JSON.stringify(exported.data)}`,
  );
  assert(readProjectPersistenceState(fixture.projectId) === before, 'rejected export created an asset/snapshot or changed project state');
  return fixture.projectId;
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const projectIds = [];
  try {
    projectIds.push(await verifyProjectCodePatchAtomicity(token));
    projectIds.push(await verifyExportReplayWarningBlock(token));
    console.log(JSON.stringify({
      status: 'PASS',
      checks: [
        'project-wide code patch rejects replay warnings from another Figure before persistence',
        'rejected code patch leaves project, sessions, figures, exports, and snapshots unchanged',
        'bulk export preflights every target Figure before writing any asset or snapshot',
        'export rejects stale edit replay before writing an asset or restorable snapshot',
      ],
    }, null, 2));
  } finally {
    for (const projectId of projectIds) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
