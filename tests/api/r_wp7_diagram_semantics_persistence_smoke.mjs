import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/r/network_path_sem.R');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableDeep(value) {
  if (Array.isArray(value)) return value.map(stableDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableDeep(value[key])]));
}

function assertSameState(label, before, after) {
  assert(
    JSON.stringify(stableDeep(after)) === JSON.stringify(stableDeep(before)),
    `${label} changed persisted state\nbefore=${JSON.stringify(before, null, 2)}\nafter=${JSON.stringify(after, null, 2)}`,
  );
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
  const result = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `r-wp7-diagram-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP7-Diagram-Semantics-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function readDatabaseState(projectId, exportAssetId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const project = database.prepare(`
      SELECT id, user_id, name, spec, script, file_count, created_at, updated_at
      FROM projects
      WHERE id = ?
    `).get(projectId);
    const session = database.prepare(`
      SELECT id, script, data_payload, edit_log, revision, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(`${projectId}_fig_1`);
    const figure = database.prepare(`
      SELECT session_id, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const renderCache = database.prepare(`
      SELECT cache_key, svg, manifest, code_slice, created_at
      FROM render_cache
      ORDER BY cache_key
    `).all();
    const exportAssets = database.prepare(`
      SELECT id, project_id, figure_id, name, format, dpi, file_path, thumbnail_svg, metadata, tags, created_at
      FROM export_assets
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId);
    const exportSnapshots = database.prepare(`
      SELECT asset_id, project_id, figure_id, schema_version, snapshot_hash, snapshot_json, created_at
      FROM export_asset_snapshots
      WHERE project_id = ?
      ORDER BY asset_id
    `).all(projectId);
    const exportAsset = exportAssetId
      ? database.prepare('SELECT id, metadata FROM export_assets WHERE id = ?').get(exportAssetId)
      : null;
    const exportSnapshot = exportAssetId
      ? database.prepare('SELECT asset_id, schema_version, snapshot_hash, snapshot_json FROM export_asset_snapshots WHERE asset_id = ?').get(exportAssetId)
      : null;

    return {
      project: project ? {
        ...project,
        spec: parseJson(project.spec, null),
      } : null,
      session: session ? {
        ...session,
        dataPayload: parseJson(session.data_payload, null),
        editLog: parseJson(session.edit_log, []),
        revision: Number(session.revision),
      } : null,
      figure: figure ? {
        sessionId: figure.session_id,
        revision: Number(figure.revision),
        editLog: parseJson(figure.edit_log, []),
        history: parseJson(figure.history, { past: [], future: [] }),
        previewSvg: figure.preview_svg,
        manifest: parseJson(figure.manifest, null),
        codeSlice: parseJson(figure.code_slice, null),
        fingerprint: figure.fingerprint,
        previewUpdatedAt: figure.preview_updated_at,
      } : null,
      renderCache: renderCache.map((row) => ({
        ...row,
        manifest: parseJson(row.manifest, null),
        codeSlice: parseJson(row.code_slice, null),
      })),
      exportAssets: exportAssets.map((row) => ({
        ...row,
        metadata: parseJson(row.metadata, {}),
        tags: parseJson(row.tags, []),
      })),
      exportSnapshots: exportSnapshots.map((row) => ({
        ...row,
        schema_version: Number(row.schema_version),
        snapshotJson: parseJson(row.snapshot_json, null),
      })),
      exportAnchor: exportAsset ? {
        id: exportAsset.id,
        metadata: parseJson(exportAsset.metadata, null),
        snapshot: exportSnapshot ? {
          assetId: exportSnapshot.asset_id,
          schemaVersion: Number(exportSnapshot.schema_version),
          snapshotHash: exportSnapshot.snapshot_hash,
          snapshotJson: parseJson(exportSnapshot.snapshot_json, null),
        } : null,
      } : null,
    };
  } finally {
    database.close();
  }
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: clone(object.identity) } : {}),
  };
}

function buildPatch(object, prop, value) {
  return {
    op: 'set',
    mode: 'backend_patch',
    gid: object.id,
    prop,
    value,
    ...identityFields(object),
  };
}

function samePatch(left, right) {
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function containsPatch(editLog, patch) {
  return Array.isArray(editLog) && editLog.some((entry) => samePatch(entry, patch));
}

function objectByRoleAndDiagramId(manifest, role, diagramObjectId) {
  return (manifest?.objects || []).find((object) => (
    object?.role === role
    && object?.identity?.relation?.diagramObjectId === diagramObjectId
  ));
}

function findDiagramObjects(manifest) {
  const expected = {
    latent: objectByRoleAndDiagramId(manifest, 'diagram_node', 'latent_a'),
    edge: objectByRoleAndDiagramId(manifest, 'diagram_edge', 'latent_a_to_observed_b'),
    arrow: objectByRoleAndDiagramId(manifest, 'diagram_arrow', 'arrow_a_b'),
    latentLabel: objectByRoleAndDiagramId(manifest, 'diagram_node_label', 'label_latent_a'),
    coefficient: objectByRoleAndDiagramId(manifest, 'diagram_coefficient_label', 'coef_a_b'),
    group: objectByRoleAndDiagramId(manifest, 'diagram_group', 'measurement_model'),
  };
  for (const [label, object] of Object.entries(expected)) {
    assert(object?.id, `missing R diagram object ${label}: ${JSON.stringify(manifest)}`);
    assert(object.identity?.relation?.diagramId === 'sem.demo', `${label} has wrong diagram identity: ${JSON.stringify(object)}`);
    assert(object.identity?.relation?.diagramType === 'sem', `${label} has wrong diagram type: ${JSON.stringify(object)}`);
    assert(object.semanticCoverage?.family === 'diagram' && object.semanticCoverage?.status === 'dedicated', `${label} lacks dedicated diagram coverage: ${JSON.stringify(object)}`);
  }
  return expected;
}

function assertBackendCapability(object, prop, label) {
  const capability = object?.propertyCapabilities?.find((item) => item?.prop === prop);
  assert(capability?.patchMode === 'backend_patch' && capability.replay !== 'unsupported', `${label} is not a backend-replayable style: ${JSON.stringify({ object, capability })}`);
}

function assertManifestPatchValue(manifest, patch, label) {
  const object = manifest?.objects?.find((candidate) => candidate?.id === patch.gid);
  assert(object, `${label} target disappeared: ${patch.gid}`);
  const actual = object.currentProps?.[patch.prop];
  if (typeof patch.value === 'number') {
    assert(Math.abs(Number(actual) - patch.value) < 0.03, `${label} expected ${patch.value}, got ${JSON.stringify(actual)}`);
  } else {
    assert(String(actual).toLowerCase() === String(patch.value).toLowerCase(), `${label} expected ${patch.value}, got ${JSON.stringify(actual)}`);
  }
}

async function createFixtureProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R WP7 diagram semantics ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spec: {
        plot_type: 'custom',
        custom_script: SCRIPT,
        script: SCRIPT,
        script_language: 'r',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-wp7-initial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial R render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `initial R render returned no manifest: ${JSON.stringify(rendered.data)}`);
  return { projectId, figure };
}

async function submitPatchBatch(token, projectId, patches, baseRevision, label) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      requestId: `r-wp7-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      patches,
    }),
  });
  assert(result.response.ok, `${label} failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function replayProject(token, projectId, editLog) {
  const result = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: editLog },
      language: 'r',
      requestId: `r-wp7-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(result.response.ok && result.data?.status === 'success', `R replay failed: ${JSON.stringify(result.data)}`);
  const figure = result.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `R replay returned no manifest: ${JSON.stringify(result.data)}`);
  return figure;
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const fixture = await createFixtureProject(token);
    projectId = fixture.projectId;
    const diagram = findDiagramObjects(fixture.figure.manifest);
    const baselineRevision = Number(fixture.figure.revision || 1);
    const validPatches = [
      buildPatch(diagram.latent, 'facecolor', '#1188CC'),
      buildPatch(diagram.edge, 'color', '#CC3311'),
      buildPatch(diagram.arrow, 'color', '#228833'),
      buildPatch(diagram.latentLabel, 'fontsize', 12),
      buildPatch(diagram.group, 'edgecolor', '#AA3377'),
    ];
    for (const patch of validPatches) assertBackendCapability(
      diagram[Object.keys(diagram).find((key) => diagram[key].id === patch.gid)],
      patch.prop,
      `valid ${patch.gid}.${patch.prop}`,
    );

    const accepted = await submitPatchBatch(token, projectId, validPatches, baselineRevision, 'valid-style-batch');
    assert(accepted.status === 'success', `legal diagram style batch failed: ${JSON.stringify(accepted)}`);
    assert(Number(accepted.revision) === baselineRevision + 1, `legal diagram style batch did not increment exactly once: ${JSON.stringify(accepted)}`);
    assert(accepted.applied?.length === validPatches.length, `legal diagram style batch applied count drifted: ${JSON.stringify(accepted)}`);
    for (const patch of validPatches) {
      const applied = accepted.applied.find((entry) => samePatch(entry, patch));
      assert(applied?.mode === 'backend_patch', `legal patch was not acknowledged as backend_patch: ${JSON.stringify(applied)}`);
      assertManifestPatchValue(accepted.manifest, patch, `accepted ${patch.gid}.${patch.prop}`);
    }

    const styledState = readDatabaseState(projectId, null);
    assert(Number(styledState.session?.revision) === baselineRevision + 1, `session revision did not persist exactly once: ${JSON.stringify(styledState.session)}`);
    assert(Number(styledState.figure?.revision) === baselineRevision + 1, `Figure revision did not persist exactly once: ${JSON.stringify(styledState.figure)}`);
    for (const patch of validPatches) {
      assert(containsPatch(styledState.session?.editLog, patch), `session edit log lost ${JSON.stringify(patch)}`);
      assert(containsPatch(styledState.figure?.editLog, patch), `Figure edit log lost ${JSON.stringify(patch)}`);
      assertManifestPatchValue(styledState.figure?.manifest, patch, `persisted ${patch.gid}.${patch.prop}`);
    }

    const replayed = await replayProject(token, projectId, styledState.session.editLog);
    assert(Number(replayed.revision) === baselineRevision + 1, `replay changed revision unexpectedly: ${JSON.stringify(replayed)}`);
    for (const patch of validPatches) assertManifestPatchValue(replayed.manifest, patch, `replayed ${patch.gid}.${patch.prop}`);

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 150,
        saveToLibrary: true,
        name: `r-wp7-diagram-export-${Date.now()}`,
      }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `diagram export failed: ${JSON.stringify(exported.data)}`);
    const asset = exported.data?.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `diagram export did not create an editing snapshot: ${JSON.stringify(exported.data)}`);
    const exportedState = readDatabaseState(projectId, asset.assetId);
    assert(typeof exportedState.exportAnchor?.metadata?.editLogHash === 'string', `export anchor is missing editLogHash: ${JSON.stringify(exportedState.exportAnchor)}`);
    assert(exportedState.exportAnchor?.snapshot?.snapshotJson, 'export editing snapshot was not persisted');
    const snapshotFigure = exportedState.exportAnchor.snapshot.snapshotJson.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(snapshotFigure, `export snapshot is missing fig_1: ${JSON.stringify(exportedState.exportAnchor)}`);
    assert(
      exportedState.exportAnchor?.metadata?.editCount === snapshotFigure.editLog?.length,
      `export anchor editCount does not match its editing snapshot: ${JSON.stringify(exportedState.exportAnchor)}`,
    );
    for (const patch of validPatches) assert(containsPatch(snapshotFigure.editLog, patch), `export snapshot lost ${JSON.stringify(patch)}`);

    const legalEdgeColorPatch = buildPatch(diagram.edge, 'color', '#00AA00');
    const illegalCoefficientTextPatch = buildPatch(diagram.coefficient, 'text', 'beta = 9.99, p < 0.001');
    const illegalTopologyPatch = buildPatch(diagram.edge, 'source_node_id', 'observed_b');
    const mixedPatches = [legalEdgeColorPatch, illegalCoefficientTextPatch, illegalTopologyPatch];
    const beforeMixed = readDatabaseState(projectId, asset.assetId);
    const rejected = await submitPatchBatch(token, projectId, mixedPatches, baselineRevision + 1, 'mixed-atomic-rejection');
    assert(rejected.status === 'conflict', `mixed legal/illegal batch did not conflict: ${JSON.stringify(rejected)}`);
    assert(Number(rejected.revision) === baselineRevision + 1, `mixed rejection changed revision: ${JSON.stringify(rejected)}`);
    assert(Array.isArray(rejected.applied) && rejected.applied.length === 0, `mixed rejection partially applied: ${JSON.stringify(rejected)}`);
    for (const patch of mixedPatches) {
      assert(rejected.rejected?.some((entry) => samePatch(entry, patch)), `mixed rejection did not identify ${JSON.stringify(patch)}: ${JSON.stringify(rejected)}`);
    }
    for (const patch of [illegalCoefficientTextPatch, illegalTopologyPatch]) {
      assert(
        rejected.warnings?.some((warning) => warning.type === 'unsupported_prop' && warning.gid === patch.gid && warning.prop === patch.prop),
        `mixed rejection did not report unsupported ${patch.gid}.${patch.prop}: ${JSON.stringify(rejected.warnings)}`,
      );
    }
    assertSameState(
      'mixed diagram style/semantics rejection',
      beforeMixed,
      readDatabaseState(projectId, asset.assetId),
    );

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      assetId: asset.assetId,
      baselineRevision,
      styledRevision: Number(accepted.revision),
      checked: [
        'legal R diagram style batch incremented revision exactly once and persisted in project/session/Figure edit logs',
        'legal R diagram styles replayed through project render with stable diagram identities',
        'mixed legal edge color plus coefficient text/topology rejection was atomic',
        'project/session/history/render cache/export anchor/export snapshot state was unchanged after rejection',
      ],
    }, null, 2));
  } finally {
    if (projectId) await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
