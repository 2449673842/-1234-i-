import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateCapabilitySmokeUser, bearerHeaders } from '../playwright/smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/python/quiver_streamplot.py');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const TEST_PROJECT_PREFIX = 'Python vector field persistence smoke';

let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');
  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated test requires SCIFIGURE_DATA_DIR and SCIFIGURE_DB_PATH');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `test refuses non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `test refuses DB outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/ directory');
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
    .filter((project) => String(project?.name || '').startsWith(TEST_PROJECT_PREFIX))
    .map((project) => requestJson(`/api/projects/${project.id || project.projectId}`, { method: 'DELETE' }).catch(() => null)));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readPersistenceState(projectId, assetId) {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    const sessions = db.prepare(`
      SELECT id, revision, edit_log
      FROM sessions
      WHERE id LIKE ?
      ORDER BY id
    `).all(`${projectId}_%`);
    const figures = db.prepare(`
      SELECT figure_index, revision, edit_log, history, preview_svg, manifest, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ?
      ORDER BY figure_index
    `).all(projectId);
    const asset = assetId
      ? db.prepare('SELECT id, metadata FROM export_assets WHERE id = ?').get(assetId)
      : null;
    const snapshot = assetId
      ? db.prepare('SELECT asset_id, schema_version, snapshot_json, snapshot_hash FROM export_asset_snapshots WHERE asset_id = ?').get(assetId)
      : null;
    return JSON.stringify({
      sessions,
      figures,
      asset,
      snapshot,
    });
  } finally {
    db.close();
  }
}

function findRequiredManifestObjects(manifest) {
  const objects = manifest?.objects || [];
  const quiver = objects.find((object) => object.kind === 'quiver' && object.role === 'quiver_field');
  const stream = objects.find((object) => object.kind === 'streamplot' && object.role === 'streamplot_field');
  const streamLine = objects.find((object) => object.role === 'streamplot_child_line');
  const streamArrow = objects.find((object) => object.role === 'streamplot_child_arrow');
  assert(quiver?.id === 'collection.0.0', `missing dedicated quiver parent: ${JSON.stringify(quiver)}`);
  assert(stream?.id === 'container.streamplot.1.0', `missing dedicated streamplot parent: ${JSON.stringify(stream)}`);
  assert(stream.children?.includes(streamLine?.id), `stream line child is not parent-owned: ${JSON.stringify({ stream, streamLine })}`);
  assert(stream.children?.includes(streamArrow?.id), `stream arrow child is not parent-owned: ${JSON.stringify({ stream, streamArrow })}`);
  assert(streamLine.parentId === stream.id && streamArrow.parentId === stream.id, 'stream children do not link back to parent');
  assert(streamLine.currentProps?.parentOwned === true && streamArrow.currentProps?.parentOwned === true, 'stream children are not marked parentOwned');
  for (const prop of ['scale', 'angles', 'pivot', 'width', 'headwidth', 'headlength', 'headaxislength']) {
    assert(!quiver.editable?.includes(prop), `quiver structural prop ${prop} is editable`);
    assert(!(quiver.propertyCapabilities || []).some((capability) => capability.prop === prop), `quiver structural prop ${prop} has a capability`);
  }
  for (const prop of ['density', 'start_points', 'integration_direction', 'maxlength', 'minlength', 'broken_streamlines']) {
    assert(!stream.editable?.includes(prop), `stream structural prop ${prop} is editable`);
    assert(!(stream.propertyCapabilities || []).some((capability) => capability.prop === prop), `stream structural prop ${prop} has a capability`);
  }
  return { quiver, stream };
}

async function createFixtureProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: SCRIPT,
    script: SCRIPT,
    script_language: 'python',
    figure: { width: 150, height: 80, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${TEST_PROJECT_PREFIX} ${Date.now()}`, spec }),
  });
  assert(created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const rendered = await requestJson(`/api/projects/${created.data.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `python-vector-field-render-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial render returned no manifest objects');
  return { projectId: created.data.id, figure };
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2 ? { fingerprint: object.fingerprint, fingerprintVersion: 2 } : {}),
    ...(object.identity !== undefined ? { identity: object.identity } : {}),
  };
}

function assertNoRejectedTriplet(label, value, rejected) {
  const leaked = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.gid === rejected.gid
      && node.prop === rejected.prop
      && JSON.stringify(node.value) === JSON.stringify(rejected.value)
    ) {
      leaked.push(node);
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  assert(leaked.length === 0, `${label} leaked rejected patch: ${JSON.stringify(leaked)}`);
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python vector field persistence');
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const fixture = await createFixtureProject();
    projectId = fixture.projectId;
    const { quiver, stream } = findRequiredManifestObjects(fixture.figure.manifest);
    const baselineRevision = Number(fixture.figure.revision || 1);
    const exported = await requestJson(`/api/projects/${projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `baseline export failed: ${JSON.stringify(exported.data)}`);
    const asset = exported.data.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `baseline export missing editing snapshot: ${JSON.stringify(asset)}`);

    const beforeState = readPersistenceState(projectId, asset.assetId);
    const rejectedPatches = [
      {
        op: 'set',
        mode: 'backend_patch',
        gid: quiver.id,
        prop: 'scale',
        value: 4.5,
        ...identityFields(quiver),
      },
      {
        op: 'set',
        mode: 'backend_patch',
        gid: stream.id,
        prop: 'density',
        value: 1.9,
        ...identityFields(stream),
      },
    ];
    for (const [index, rejectedPatch] of rejectedPatches.entries()) {
      const rejected = await requestJson('/api/figure/patch', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: `${projectId}_fig_1`,
          projectId,
          figureId: 'fig_1',
          requestId: `python-vector-field-reject-${index}-${Date.now()}`,
          baseRevision: baselineRevision,
          patches: [rejectedPatch],
        }),
      });
      assert(rejected.response.status === 409 || rejected.data?.status === 'conflict', `structural ${rejectedPatch.gid}.${rejectedPatch.prop} patch was not rejected: ${JSON.stringify(rejected.data)}`);
      assert(Number(rejected.data?.revision) === baselineRevision, `rejected structural patch changed revision: ${JSON.stringify(rejected.data)}`);
      assert(Array.isArray(rejected.data?.applied) && rejected.data.applied.length === 0, `rejected structural patch applied edits: ${JSON.stringify(rejected.data)}`);
      assertNoRejectedTriplet('rejected patch response editLog', rejected.data?.editLog || [], rejectedPatch);
      const responseObject = rejected.data?.manifest?.objects?.find((object) => object.id === rejectedPatch.gid);
      if (responseObject) {
        assert(
          Number(responseObject.currentProps?.[rejectedPatch.prop]) !== rejectedPatch.value,
          `response manifest applied rejected ${rejectedPatch.prop}: ${JSON.stringify(responseObject.currentProps)}`,
        );
      }
      assert(
        readPersistenceState(projectId, asset.assetId) === beforeState,
        `rejected ${rejectedPatch.gid}.${rejectedPatch.prop} changed persistence state`,
      );
    }

    const afterState = readPersistenceState(projectId, asset.assetId);
    assert(afterState === beforeState, 'rejected structural vector-field patch changed session/history/cache/export anchor/snapshot state');

    const project = await requestJson(`/api/projects/${projectId}`);
    const persistedFigure = project.data?.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(Number(persistedFigure?.revision || 0) === baselineRevision, `project revision changed after rejected patch: ${JSON.stringify(persistedFigure)}`);
    rejectedPatches.forEach((rejectedPatch) => {
      assertNoRejectedTriplet('project API figure editLog', persistedFigure?.editLog || [], rejectedPatch);
    });

    const dbState = parseJson(afterState, {});
    const previewManifest = parseJson(dbState.figures?.[0]?.manifest, null);
    const cachedQuiver = previewManifest?.objects?.find((object) => object.id === quiver.id);
    const cachedStream = previewManifest?.objects?.find((object) => object.id === stream.id);
    assert(cachedQuiver && Number(cachedQuiver.currentProps?.scale) !== 4.5, 'preview cache manifest applied rejected quiver scale');
    assert(cachedStream && Number(cachedStream.currentProps?.density) !== 1.9, 'preview cache manifest applied rejected streamplot density');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      assetId: asset.assetId,
      rejected: rejectedPatches.map((patch) => ({ gid: patch.gid, prop: patch.prop, revision: baselineRevision })),
      checked: [
        'dedicated quiver and streamplot parents exist',
        'streamplot children are parent-owned',
        'quiver scale and streamplot density structural patches are rejected',
        'session, history, preview cache, export anchor, and export snapshot are unchanged',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
