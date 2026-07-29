import Database from 'better-sqlite3';
import path from 'node:path';
import { authenticateCapabilitySmokeUser, bearerHeaders } from '../playwright/smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const TEST_PROJECT_PREFIX = 'Python diagram code patch compatibility smoke';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test requires the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe test URL: ${BASE_URL}`);
  const dataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR || '');
  const dbPath = path.resolve(process.env.SCIFIGURE_DB_PATH || '');
  assert(path.basename(path.dirname(dataDir)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(dbPath.startsWith(`${dataDir}${path.sep}`), `unsafe DB path: ${dbPath}`);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok && response.status !== 409) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return { response, data };
}

async function cleanupSmokeProjects() {
  const { data } = await requestJson('/api/projects');
  await Promise.all((data.projects || [])
    .filter(project => String(project?.name || '').startsWith(TEST_PROJECT_PREFIX))
    .map(project => requestJson(`/api/projects/${project.id || project.projectId}`, { method: 'DELETE' }).catch(() => null)));
}

function diagramScript(items) {
  return `
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4, 3))
items = ${JSON.stringify(items)}
for index, item in enumerate(items):
    text = ax.text(
        0.25 + index * 0.45,
        0.55,
        item["label"],
        ha="center",
        va="center",
    )
    text.set_gid(_scifigure_semantic_gid(
        "diagram.compat",
        "node_label",
        item["object_id"],
        diagram_type="network",
        node_id=item["node_id"],
    ))
ax.set_xlim(0, 1)
ax.set_ylim(0, 1)
ax.axis("off")
`;
}

const INITIAL_SCRIPT = diagramScript([
  { object_id: 'label.A', node_id: 'node.A', label: 'Node A' },
  { object_id: 'label.B', node_id: 'node.B', label: 'Node B' },
]);

const REORDERED_SCRIPT = diagramScript([
  { object_id: 'label.B', node_id: 'node.B', label: 'Node B updated' },
  { object_id: 'label.A', node_id: 'node.A', label: 'Node A updated' },
]);

const TOPOLOGY_DRIFT_SCRIPT = diagramScript([
  { object_id: 'label.B', node_id: 'node.B', label: 'Node B updated' },
  { object_id: 'label.A', node_id: 'node.Z', label: 'Node A changed topology' },
]);

const AMBIGUOUS_SCRIPT = diagramScript([
  { object_id: 'label.B', node_id: 'node.B', label: 'Node B updated' },
  { object_id: 'label.A', node_id: 'node.A', label: 'Node A duplicate 1' },
  { object_id: 'label.A', node_id: 'node.A', label: 'Node A duplicate 2' },
]);

function relationObject(manifest, objectId) {
  return manifest?.objects?.find(object => (
    object.role === 'diagram_node_label'
    && object.identity?.relation?.diagramObjectId === objectId
  ));
}

function buildPatch(object, prop, value) {
  return {
    op: 'set',
    gid: object.id,
    prop,
    value,
    mode: 'backend_patch',
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: object.identity,
  };
}

function readPersistenceState(projectId) {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    return JSON.stringify({
      project: db.prepare('SELECT script, spec, updated_at FROM projects WHERE id = ?').get(projectId),
      session: db.prepare('SELECT revision, script, edit_log, updated_at FROM sessions WHERE id = ?').get(`${projectId}_fig_1`),
      figure: db.prepare(`
        SELECT revision, edit_log, history, preview_svg, manifest, fingerprint, preview_updated_at
        FROM project_figures WHERE project_id = ? AND figure_index = 0
      `).get(projectId),
      assets: db.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId),
      snapshots: db.prepare(`
        SELECT COUNT(*) AS count FROM export_asset_snapshots
        WHERE asset_id IN (SELECT id FROM export_assets WHERE project_id = ?)
      `).get(projectId),
    });
  } finally {
    db.close();
  }
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python diagram code patch compatibility');
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const spec = {
      plot_type: 'custom',
      custom_script: INITIAL_SCRIPT,
      script: INITIAL_SCRIPT,
      script_language: 'python',
    };
    const created = await requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: `${TEST_PROJECT_PREFIX} ${Date.now()}`, spec }),
    });
    projectId = created.data?.id;
    assert(projectId, `project creation failed: ${JSON.stringify(created.data)}`);

    const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
      method: 'POST',
      body: JSON.stringify({ script: INITIAL_SCRIPT, editLogs: { fig_1: [] }, language: 'python' }),
    });
    assert(rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
    const initialFigure = rendered.data.figures?.[0];
    const initialA = relationObject(initialFigure?.manifest, 'label.A');
    assert(initialA, `initial A label missing: ${JSON.stringify(initialFigure?.manifest)}`);

    const fontPatch = buildPatch(initialA, 'fontsize', 16);
    const styled = await requestJson('/api/figure/patch', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: initialFigure.revision,
        requestId: `diagram-style-${Date.now()}`,
        patches: [fontPatch],
      }),
    });
    assert(styled.data?.status === 'success', `initial style patch failed: ${JSON.stringify(styled.data)}`);
    const staleEditLog = structuredClone(styled.data.editLog);

    const codePatched = await requestJson('/api/figure/code-patch', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        script: REORDERED_SCRIPT,
      }),
    });
    assert(codePatched.data?.status === 'success', `safe diagram code patch failed: ${JSON.stringify(codePatched.data)}`);
    const currentA = relationObject(codePatched.data.manifest, 'label.A');
    assert(currentA, `reordered A label missing: ${JSON.stringify(codePatched.data.manifest)}`);
    assert(currentA.id !== initialA.id, `fixture did not change raw gid: ${initialA.id}`);
    assert(Number(currentA.currentProps?.fontsize) === 16, `reordered A label lost fontsize: ${JSON.stringify(currentA.currentProps)}`);
    const canonicalEdit = codePatched.data.editLog?.find(entry => entry.prop === 'fontsize');
    assert(canonicalEdit?.gid === currentA.id, `editLog gid was not canonicalized: ${JSON.stringify(canonicalEdit)}`);
    assert(canonicalEdit?.stableKey === currentA.stableKey, `editLog stableKey was not refreshed: ${JSON.stringify(canonicalEdit)}`);
    assert(canonicalEdit?.fingerprint === currentA.fingerprint, `editLog fingerprint was not refreshed: ${JSON.stringify(canonicalEdit)}`);
    assert(JSON.stringify(canonicalEdit?.identity) === JSON.stringify(currentA.identity), `editLog identity was not refreshed: ${JSON.stringify(canonicalEdit)}`);

    // Recreate the exact legacy state seen in the user's project: current
    // script/manifest plus an old still-existing raw gid in the session editLog.
    const db = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      db.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?')
        .run(JSON.stringify(staleEditLog), `${projectId}_fig_1`);
    } finally {
      db.close();
    }

    const reopened = await requestJson(`/api/projects/${projectId}/figures/render`, {
      method: 'POST',
      body: JSON.stringify({ script: REORDERED_SCRIPT, language: 'python' }),
    });
    assert(reopened.data?.status === 'success', `legacy project reopen failed: ${JSON.stringify(reopened.data)}`);
    const reopenedFigure = reopened.data.figures?.[0];
    const reopenedA = relationObject(reopenedFigure?.manifest, 'label.A');
    assert(Number(reopenedA?.currentProps?.fontsize) === 16, `project reopen lost reconciled style: ${JSON.stringify(reopenedA)}`);
    const reopenedEdit = reopenedFigure?.editLog?.find(entry => entry.prop === 'fontsize');
    assert(reopenedEdit?.gid === reopenedA?.id, `project reopen did not persist canonical identity: ${JSON.stringify(reopenedEdit)}`);

    const staleDb = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      staleDb.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?')
        .run(JSON.stringify(staleEditLog), `${projectId}_fig_1`);
    } finally {
      staleDb.close();
    }

    const resized = await requestJson('/api/figure/patch', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: codePatched.data.revision,
        requestId: `diagram-resize-${Date.now()}`,
        patches: [
          { op: 'set', gid: 'global', prop: 'figure.width_in', value: 5, mode: 'backend_patch' },
          { op: 'set', gid: 'global', prop: 'figure.height_in', value: 4, mode: 'backend_patch' },
        ],
      }),
    });
    assert(resized.data?.status === 'success', `canvas resize after stale identity failed: ${JSON.stringify(resized.data)}`);
    const resizedA = relationObject(resized.data.manifest, 'label.A');
    assert(Number(resizedA?.currentProps?.fontsize) === 16, `reconciled label style was not replayed: ${JSON.stringify(resizedA)}`);
    assert(Number(resized.data.manifest?.globals?.['figure.width_in']?.value) === 5, 'canvas width did not apply');
    assert(Number(resized.data.manifest?.globals?.['figure.height_in']?.value) === 4, 'canvas height did not apply');

    for (const [label, driftScript] of [
      ['topology', TOPOLOGY_DRIFT_SCRIPT],
      ['ambiguous', AMBIGUOUS_SCRIPT],
    ]) {
      const before = readPersistenceState(projectId);
      const rejected = await requestJson('/api/figure/code-patch', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: `${projectId}_fig_1`,
          projectId,
          figureId: 'fig_1',
          script: driftScript,
        }),
      });
      assert(rejected.data?.status === 'drift_warning', `${label} drift did not fail closed: ${JSON.stringify(rejected.data)}`);
      assert(rejected.data?.code === 'CODE_PATCH_EDIT_REPLAY_REJECTED', `${label} drift returned wrong code: ${JSON.stringify(rejected.data)}`);
      assert(readPersistenceState(projectId) === before, `${label} drift changed persisted state`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      checked: [
        'label text and draw-order code changes remap by unique explicit diagram relation',
        'canonical gid/stableKey/fingerprint/identity persist after renderer confirmation',
        'legacy project reopen reconciles stale diagram identity before persistence',
        'legacy stale session identity no longer blocks global canvas width/height',
        'topology drift and duplicate relations fail closed with zero persistence',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
