import Database from 'better-sqlite3';
import path from 'node:path';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
} from '../playwright/smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || '';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must use the isolated server wrapper');
  assert(BASE_URL, 'SCIFIGURE_URL is required');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
  const dataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const dbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert(path.basename(path.dirname(dataDir)).startsWith('scifigure-isolated-smoke-'), `non-isolated data dir: ${dataDir}`);
  assert(dbPath.startsWith(`${dataDir}${path.sep}`), `DB is outside isolated data dir: ${dbPath}`);
  assert(dataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data directory');
}

async function requestJson(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  assert(response.ok, `${options.method || 'GET'} ${route} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function requestJsonResponse(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  return {
    response,
    data: await response.json().catch(() => null),
  };
}

function openDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH);
  db.pragma('busy_timeout = 5000');
  return db;
}

function readStoredFigure(projectId) {
  const db = openDb();
  try {
    return db.prepare(`
      SELECT session_id, revision, edit_log, preview_svg, manifest, code_slice, fingerprint
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
  } finally {
    db.close();
  }
}

function setStoredSessionBinding(projectId, sessionId) {
  const db = openDb();
  try {
    db.prepare(`
      UPDATE project_figures
      SET session_id = ?
      WHERE project_id = ? AND figure_index = 0
    `).run(sessionId, projectId);
  } finally {
    db.close();
  }
}

function readProjectSessionRows(projectId) {
  const db = openDb();
  try {
    return db.prepare(`
      SELECT id, revision, edit_log
      FROM sessions
      WHERE id LIKE ?
      ORDER BY id
    `).all(`${projectId}_fig_%`);
  } finally {
    db.close();
  }
}

function clearStoredManifest(projectId) {
  const db = openDb();
  try {
    db.prepare(`
      UPDATE project_figures
      SET preview_svg = NULL, manifest = NULL, preview_updated_at = NULL
      WHERE project_id = ? AND figure_index = 0
    `).run(projectId);
  } finally {
    db.close();
  }
}

function identityFields(object) {
  return {
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: object.identity,
  };
}

async function patch(projectId, revision, object, prop, value, requestSuffix) {
  return requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision: revision,
      requestId: `manifest-recovery-${requestSuffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      patches: [{
        op: 'set',
        mode: 'backend_patch',
        gid: object.id,
        prop,
        value,
        ...identityFields(object),
      }],
    }),
  });
}

const script = [
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots(figsize=(4, 3))',
  'ax.plot([0, 1, 2], [1, 2, 1], color="#225577", linewidth=1.2, label="Series A")',
  'ax.plot([0, 1, 2], [2, 1, 2], color="#cc6677", linewidth=1.4, label="Series B")',
  'ax.legend()',
].join('\n');

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'local patch manifest recovery');
  let projectId = null;
  try {
    const spec = {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'python',
      figure: { width: 120, height: 90, unit: 'mm', dpi: 150 },
    };
    const created = await requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: `Manifest recovery ${Date.now()}`, spec }),
    });
    projectId = created.id;
    assert(projectId, `project creation failed: ${JSON.stringify(created)}`);

    const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
      method: 'POST',
      body: JSON.stringify({
        script,
        language: 'python',
        editLogs: { fig_1: [] },
        requestId: `manifest-recovery-render-${Date.now()}`,
      }),
    });
    assert(rendered.status === 'success', `initial render failed: ${JSON.stringify(rendered)}`);
    const figure = rendered.figures?.find(item => item.figureId === 'fig_1');
    const lines = figure?.manifest?.objects?.filter(object => (
      object.kind === 'line'
      && object.role !== 'legend_marker'
      && object.editable?.includes('color')
      && object.editable?.includes('linewidth')
    )) || [];
    assert(lines.length >= 2, `expected two editable lines: ${JSON.stringify(lines)}`);

    const initialStored = readStoredFigure(projectId);
    assert(initialStored?.manifest && initialStored?.code_slice && initialStored?.fingerprint, 'initial render did not persist trusted figure metadata');

    const canonicalSessionId = `${projectId}_fig_1`;
    const corruptedSessionId = `${projectId}_fig_2`;
    const sessionRowsBeforeCorruptionCheck = readProjectSessionRows(projectId);
    setStoredSessionBinding(projectId, corruptedSessionId);
    try {
      const corruptedStoredBinding = await requestJsonResponse('/api/figure/patch', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          figureId: 'fig_1',
          baseRevision: 1,
          requestId: `manifest-recovery-corrupted-stored-binding-${Date.now()}`,
          patches: [{
            op: 'set',
            mode: 'backend_patch',
            gid: lines[0].id,
            prop: 'color',
            value: '#7755aa',
            ...identityFields(lines[0]),
          }],
        }),
      });
      assert(corruptedStoredBinding.response.status === 400, `corrupted stored Figure binding was not rejected: ${JSON.stringify(corruptedStoredBinding.data)}`);
      const storedAfterCorruptionCheck = readStoredFigure(projectId);
      assert(storedAfterCorruptionCheck?.revision === initialStored.revision, 'corrupted stored Figure binding changed revision');
      assert(storedAfterCorruptionCheck?.edit_log === initialStored.edit_log, 'corrupted stored Figure binding changed Figure editLog');
      assert(
        JSON.stringify(readProjectSessionRows(projectId)) === JSON.stringify(sessionRowsBeforeCorruptionCheck),
        'corrupted stored Figure binding changed session rows',
      );
    } finally {
      setStoredSessionBinding(projectId, canonicalSessionId);
    }

    const mismatchedIdentity = await requestJsonResponse('/api/figure/patch', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_2',
        baseRevision: 1,
        requestId: `manifest-recovery-mismatched-identity-${Date.now()}`,
        patches: [{
          op: 'set',
          mode: 'backend_patch',
          gid: lines[0].id,
          prop: 'color',
          value: '#663399',
          ...identityFields(lines[0]),
        }],
      }),
    });
    assert(mismatchedIdentity.response.status === 400, `mismatched Figure identity was not rejected: ${JSON.stringify(mismatchedIdentity.data)}`);
    assert(readStoredFigure(projectId)?.revision === 1, 'mismatched Figure identity changed revision');

    const first = await patch(projectId, 1, lines[0], 'color', '#114488', 'first-local');
    assert(first.status === 'success', `first local patch failed: ${JSON.stringify(first)}`);
    assert(first.applied?.[0]?.mode === 'local_patch', `first color patch was not authoritative local_patch: ${JSON.stringify(first.applied)}`);
    const afterFirst = readStoredFigure(projectId);
    const firstManifest = JSON.parse(afterFirst.manifest || 'null');
    const firstObject = firstManifest?.objects?.find(object => object.id === lines[0].id);
    assert(afterFirst.preview_svg === null, 'local patch left a stale persisted SVG preview');
    assert(afterFirst.code_slice === initialStored.code_slice, 'local patch discarded the unchanged code slice');
    assert(afterFirst.fingerprint === initialStored.fingerprint, 'local patch discarded the structural figure fingerprint');
    assert(firstObject?.currentProps?.color === '#114488', `stored manifest did not receive the local patch: ${JSON.stringify(firstObject?.currentProps)}`);

    const stale = await patch(projectId, 1, lines[1], 'color', '#aa3377', 'stale-local');
    assert(stale.status === 'conflict' && stale.code === 'REVISION_MISMATCH', `stale local patch was not rejected: ${JSON.stringify(stale)}`);
    assert(readStoredFigure(projectId)?.revision === first.revision, 'stale local patch changed revision');

    const second = await patch(projectId, first.revision, lines[1], 'color', '#aa3377', 'second-local');
    assert(second.status === 'success', `second local patch failed: ${JSON.stringify(second)}`);
    assert(second.applied?.[0]?.mode === 'local_patch', `second color patch lost the trusted manifest: ${JSON.stringify(second.applied)}`);

    clearStoredManifest(projectId);
    const recovered = await patch(projectId, second.revision, lines[0], 'linewidth', 2.8, 'missing-manifest');
    assert(recovered.status === 'success', `missing-manifest recovery failed: ${JSON.stringify(recovered)}`);
    assert(recovered.applied?.[0]?.mode === 'backend_patch', `missing manifest did not force backend verification: ${JSON.stringify(recovered.applied)}`);
    assert(recovered.manifest?.objects?.length > 0, 'renderer recovery did not return a fresh manifest');
    assert(recovered.revision === second.revision + 1, `recovery revision changed incorrectly: ${second.revision} -> ${recovered.revision}`);
    const recoveredStored = readStoredFigure(projectId);
    assert(recoveredStored?.manifest, 'recovery did not restore the persisted manifest');

    console.log(JSON.stringify({
      status: 'PASS',
      localPatchRevisions: [first.revision, second.revision],
      recoveredRevision: recovered.revision,
    }, null, 2));
  } finally {
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
