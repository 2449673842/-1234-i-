import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateCapabilitySmokeUser, bearerHeaders } from '../playwright/smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/python/network_path_sem.py');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const TEST_PROJECT_PREFIX = 'Python diagram semantics persistence smoke';

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

function readPersistenceState(projectId) {
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
    const assets = db.prepare(`
      SELECT id, figure_id, name, format, dpi, file_path, metadata, tags, created_at
      FROM export_assets
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId);
    const snapshots = db.prepare(`
      SELECT asset_id, figure_id, schema_version, snapshot_json, snapshot_hash, created_at
      FROM export_asset_snapshots
      WHERE project_id = ?
      ORDER BY asset_id
    `).all(projectId);
    return JSON.stringify({
      sessions,
      figures,
      assets,
      snapshots,
    });
  } finally {
    db.close();
  }
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2 ? { fingerprint: object.fingerprint, fingerprintVersion: 2 } : {}),
    ...(object.identity !== undefined ? { identity: object.identity } : {}),
  };
}

function capabilityProps(object) {
  return Array.isArray(object?.propertyCapabilities)
    ? object.propertyCapabilities.map((capability) => capability?.prop)
    : [];
}

function objectByRoleAndDiagramId(objects, role, diagramObjectId) {
  return objects.find((object) => (
    object.role === role
    && object.identity?.relation?.diagramObjectId === diagramObjectId
  ));
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

function containsPatchTriplet(editLog, patch) {
  return Array.isArray(editLog) && editLog.some((entry) => (
    entry.gid === patch.gid
    && entry.prop === patch.prop
    && JSON.stringify(entry.value) === JSON.stringify(patch.value)
  ));
}

function hexToRgba(hex) {
  const normalized = String(hex).replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
    1,
  ];
}

function colorMatches(actual, expectedHex) {
  if (!String(expectedHex).startsWith('#')) return false;
  if (Array.isArray(actual)) {
    const expected = hexToRgba(expectedHex);
    return expected.every((value, index) => Math.abs(Number(actual[index]) - value) < 0.01);
  }
  return String(actual).toLowerCase() === String(expectedHex).toLowerCase();
}

function valueMatches(actual, expected) {
  if (typeof expected === 'string' && expected.startsWith('#')) return colorMatches(actual, expected);
  if (typeof expected === 'number') return Math.abs(Number(actual) - expected) < 0.03;
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return Object.entries(expected).every(([key, value]) => valueMatches(actual?.[key], value));
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function assertPatchApplied(manifest, patch, label) {
  const object = manifest?.objects?.find((candidate) => candidate.id === patch.gid);
  assert(object, `${label} target missing after patch: ${patch.gid}`);
  const actual = patch.prop === 'position'
    ? {
        x: object.currentProps?.x,
        y: object.currentProps?.y,
        coord_system: object.currentProps?.coord_system,
      }
    : object.currentProps?.[patch.prop];
  assert(
    valueMatches(actual, patch.value),
    `${label} did not apply ${patch.prop}: expected ${JSON.stringify(patch.value)}, got ${JSON.stringify(actual)}`,
  );
}

function assertReadonlyProps(object, props, label) {
  const capabilities = capabilityProps(object);
  for (const prop of props) {
    assert(!object.editable?.includes(prop), `${label} exposes protected ${prop} as editable`);
    assert(!capabilities.includes(prop), `${label} exposes protected ${prop} in propertyCapabilities`);
  }
}

function assertDiagramSemantics(manifest) {
  const objects = manifest?.objects || [];
  const expected = {
    latent: objectByRoleAndDiagramId(objects, 'diagram_node', 'latent_a'),
    observed: objectByRoleAndDiagramId(objects, 'diagram_node', 'observed_b'),
    edge: objectByRoleAndDiagramId(objects, 'diagram_edge', 'latent_a_to_observed_b'),
    arrow: objectByRoleAndDiagramId(objects, 'diagram_arrow', 'arrow_a_b'),
    nodeLabel: objectByRoleAndDiagramId(objects, 'diagram_node_label', 'label_latent_a'),
    coefficient: objectByRoleAndDiagramId(objects, 'diagram_coefficient_label', 'coef_a_b'),
    fitAnnotation: objectByRoleAndDiagramId(objects, 'diagram_fit_annotation', 'fit_summary'),
    group: objectByRoleAndDiagramId(objects, 'diagram_group', 'measurement_model'),
  };
  for (const [label, object] of Object.entries(expected)) {
    assert(object, `missing explicit diagram object ${label}; roles=${JSON.stringify(objects.map(item => ({ id: item.id, kind: item.kind, role: item.role, relation: item.identity?.relation })))}`);
    const relation = object.identity?.relation || {};
    assert(relation.diagramId === 'sem.demo', `${label} has wrong diagramId: ${JSON.stringify(relation)}`);
    assert(relation.diagramType === 'sem', `${label} has wrong diagramType: ${JSON.stringify(relation)}`);
    assert(object.source?.callName === 'SciFigure.semantic_gid', `${label} lost semantic gid source: ${JSON.stringify(object.source)}`);
    assert(object.semanticCoverage?.family === 'diagram', `${label} is not diagram coverage: ${JSON.stringify(object.semanticCoverage)}`);
    assert(object.semanticCoverage?.status === 'dedicated', `${label} is not dedicated: ${JSON.stringify(object.semanticCoverage)}`);
    assert(object.propertyCapabilities?.length > 0, `${label} has no property capabilities`);
    assert(
      object.propertyCapabilities.every((capability) => capability.patchMode === 'backend_patch'),
      `${label} exposes non-backend style patch capability: ${JSON.stringify(object.propertyCapabilities)}`,
    );
  }
  assert(expected.latent.kind === 'patch', `latent node kind changed: ${JSON.stringify(expected.latent)}`);
  assert(expected.observed.kind === 'collection', `observed node kind changed: ${JSON.stringify(expected.observed)}`);
  assert(expected.edge.kind === 'line', `edge kind changed: ${JSON.stringify(expected.edge)}`);
  assert(expected.arrow.kind === 'patch', `arrow kind changed: ${JSON.stringify(expected.arrow)}`);
  assert(expected.group.kind === 'patch', `group kind changed: ${JSON.stringify(expected.group)}`);
  for (const textObject of [expected.nodeLabel, expected.coefficient, expected.fitAnnotation]) {
    assert(textObject.kind === 'text', `diagram text kind changed: ${JSON.stringify(textObject)}`);
    assert(textObject.currentProps?.textContentReadonly === true, `diagram text content is not marked readonly: ${JSON.stringify(textObject.currentProps)}`);
    assert(textObject.editable?.includes('fontsize'), `diagram text missing typography edit: ${JSON.stringify(textObject.editable)}`);
    assert(textObject.editable?.includes('position'), `diagram text missing position edit: ${JSON.stringify(textObject.editable)}`);
  }
  assert(expected.latent.identity?.relation?.nodeId === 'latent_a', `latent node relation wrong: ${JSON.stringify(expected.latent.identity)}`);
  assert(expected.edge.identity?.relation?.edgeId === 'latent_a_to_observed_b', `edge relation wrong: ${JSON.stringify(expected.edge.identity)}`);
  assert(expected.edge.identity?.relation?.sourceNodeId === 'latent_a', `edge source relation wrong: ${JSON.stringify(expected.edge.identity)}`);
  assert(expected.edge.identity?.relation?.targetNodeId === 'observed_b', `edge target relation wrong: ${JSON.stringify(expected.edge.identity)}`);
  assert(expected.arrow.identity?.relation?.edgeId === 'latent_a_to_observed_b', `arrow edge relation wrong: ${JSON.stringify(expected.arrow.identity)}`);
  assert(expected.nodeLabel.identity?.relation?.nodeId === 'latent_a', `node label relation wrong: ${JSON.stringify(expected.nodeLabel.identity)}`);
  assert(expected.coefficient.identity?.relation?.edgeId === 'latent_a_to_observed_b', `coefficient relation wrong: ${JSON.stringify(expected.coefficient.identity)}`);

  assertReadonlyProps(expected.latent, ['diagram_id', 'diagram_type', 'node_id', 'x', 'y'], 'diagram_node');
  assertReadonlyProps(expected.edge, ['edge_id', 'source_node_id', 'target_node_id', 'direction', 'path', 'vertices', 'control_points'], 'diagram_edge');
  assertReadonlyProps(expected.arrow, ['edge_id', 'source_node_id', 'target_node_id', 'direction', 'path', 'vertices', 'control_points'], 'diagram_arrow');
  assertReadonlyProps(expected.nodeLabel, ['text', 'node_id'], 'diagram_node_label');
  assertReadonlyProps(expected.coefficient, ['text', 'edge_id', 'coefficient', 'value', 'p_value', 'pvalue', 'significance'], 'diagram_coefficient_label');
  assertReadonlyProps(expected.fitAnnotation, ['text', 'fit', 'fit_indices', 'cfi', 'rmsea', 'p_value'], 'diagram_fit_annotation');
  assertReadonlyProps(expected.group, ['diagram_id', 'diagram_type', 'members', 'node_ids'], 'diagram_group');

  const ordinary = {
    scatter: objects.find((object) => object.label === 'ordinary scatter'),
    line: objects.find((object) => object.label === 'ordinary line'),
    arrow: objects.find((object) => object.label === 'ordinary arrow'),
    text: objects.find((object) => object.kind === 'text' && object.currentProps?.text === 'ordinary text'),
  };
  for (const [label, object] of Object.entries(ordinary)) {
    assert(object, `missing ordinary lookalike ${label}`);
    assert(!String(object.role || '').startsWith('diagram_'), `${label} lookalike was promoted to diagram role: ${JSON.stringify(object)}`);
    assert(!object.identity?.relation?.diagramId, `${label} lookalike gained diagram relation: ${JSON.stringify(object.identity)}`);
  }

  return expected;
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
      requestId: `python-diagram-render-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial render returned no manifest objects');
  return { projectId: created.data.id, figure };
}

async function renderWithEditLog(projectId, editLog) {
  const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: editLog },
      language: 'python',
      requestId: `python-diagram-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `replay render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'replay render returned no manifest objects');
  return figure;
}

async function submitPatchBatch(projectId, patches, label, baseRevision) {
  const result = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `python-diagram-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches,
    }),
  });
  assert(result.response.ok, `${label} patch request failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

function buildPatch(object, prop, value) {
  const identity = object.kind === 'text' && String(object.role || '').startsWith('diagram_')
    ? (object.identity !== undefined ? { identity: object.identity } : {})
    : identityFields(object);
  return {
    op: 'set',
    mode: 'backend_patch',
    gid: object.id,
    prop,
    value,
    ...identity,
  };
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python diagram semantics persistence');
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const fixture = await createFixtureProject();
    projectId = fixture.projectId;
    const diagram = assertDiagramSemantics(fixture.figure.manifest);
    const baselineRevision = Number(fixture.figure.revision || 1);
    const validPatches = [
      buildPatch(diagram.latent, 'facecolor', '#228833'),
      buildPatch(diagram.edge, 'color', '#1166aa'),
      buildPatch(diagram.arrow, 'edgecolor', '#1166aa'),
      buildPatch(diagram.nodeLabel, 'fontsize', 13),
      buildPatch(diagram.coefficient, 'fontweight', 'bold'),
      buildPatch(diagram.fitAnnotation, 'position', { x: 0.10, y: 0.13, coord_system: 'axes' }),
      buildPatch(diagram.group, 'alpha', 0.55),
    ];
    for (const patch of validPatches) {
      const sourceObject = Object.values(diagram).find((object) => object.id === patch.gid);
      const capability = sourceObject?.propertyCapabilities?.find((item) => item.prop === patch.prop);
      assert(capability?.patchMode === 'backend_patch', `valid style patch is not backend replay: ${JSON.stringify({ patch, capability })}`);
    }
    const styled = await submitPatchBatch(projectId, validPatches, 'valid-style-batch', baselineRevision);
    assert(styled.status === 'success', `valid style patch batch failed: ${JSON.stringify(styled)}`);
    assert(Number(styled.revision) === baselineRevision + 1, `valid style batch did not advance one revision: ${JSON.stringify(styled)}`);
    assert(Array.isArray(styled.applied) && styled.applied.length === validPatches.length, `valid style batch did not report all applied edits: ${JSON.stringify(styled.applied)}`);
    for (const patch of validPatches) {
      assertPatchApplied(styled.manifest, patch, `valid ${patch.gid}.${patch.prop}`);
    }

    const replayed = await renderWithEditLog(projectId, styled.editLog);
    for (const patch of validPatches) {
      assertPatchApplied(replayed.manifest, patch, `replayed ${patch.gid}.${patch.prop}`);
    }
    const projectAfterStyle = await requestJson(`/api/projects/${projectId}`);
    const persistedFigure = projectAfterStyle.data?.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(Number(persistedFigure?.revision || 0) === baselineRevision + 1, `valid styles did not persist revision: ${JSON.stringify(persistedFigure)}`);
    for (const patch of validPatches) {
      assert(containsPatchTriplet(persistedFigure?.editLog || [], patch), `project API editLog lost valid style patch: ${JSON.stringify(patch)}`);
    }

    const exported = await requestJson(`/api/projects/${projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `baseline export failed: ${JSON.stringify(exported.data)}`);
    const asset = exported.data.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `baseline export missing editing snapshot: ${JSON.stringify(asset)}`);

    const styledRevision = Number(styled.revision);
    const atomicValidPatch = buildPatch(diagram.group, 'alpha', 0.61);
    const topologyDriftPatch = structuredClone(buildPatch(diagram.edge, 'color', '#aa3377'));
    topologyDriftPatch.identity.relation.sourceNodeId = 'observed_b';
    const missingRelationPatch = structuredClone(buildPatch(diagram.arrow, 'edgecolor', '#aa3377'));
    delete missingRelationPatch.identity.relation.targetNodeId;
    const beforeIdentityRejectedState = readPersistenceState(projectId);
    const identityRejected = await submitPatchBatch(
      projectId,
      [atomicValidPatch, topologyDriftPatch, missingRelationPatch],
      'reject-topology-drift-mixed-batch',
      styledRevision,
    );
    assert(identityRejected.status === 'conflict', `diagram topology drift batch was not rejected: ${JSON.stringify(identityRejected)}`);
    assert(Number(identityRejected.revision) === styledRevision, `diagram topology drift changed revision: ${JSON.stringify(identityRejected)}`);
    assert(Array.isArray(identityRejected.applied) && identityRejected.applied.length === 0, `diagram topology drift partially applied: ${JSON.stringify(identityRejected)}`);
    for (const patch of [topologyDriftPatch, missingRelationPatch]) {
      assert(
        identityRejected.warnings?.some((warning) => (
          warning.type === 'identity_mismatch'
          && warning.gid === patch.gid
          && warning.field === 'identity.relation'
        )),
        `diagram relationship mismatch was not reported for ${patch.gid}: ${JSON.stringify(identityRejected.warnings)}`,
      );
    }
    for (const patch of [atomicValidPatch, topologyDriftPatch, missingRelationPatch]) {
      assertNoRejectedTriplet('diagram identity conflict response editLog', identityRejected.editLog || [], patch);
    }
    assert(
      readPersistenceState(projectId) === beforeIdentityRejectedState,
      'diagram identity conflict changed revision/session/history/cache/export/snapshot state',
    );

    const snapshotDb = new Database(process.env.SCIFIGURE_DB_PATH);
    let originalSnapshotJson = '';
    let originalSnapshotHash = '';
    try {
      snapshotDb.pragma('busy_timeout = 5000');
      const stored = snapshotDb.prepare(`
        SELECT snapshot_json, snapshot_hash
        FROM export_asset_snapshots
        WHERE asset_id = ?
      `).get(asset.assetId);
      assert(stored?.snapshot_json && stored?.snapshot_hash, 'diagram export snapshot row is missing');
      originalSnapshotJson = stored.snapshot_json;
      originalSnapshotHash = stored.snapshot_hash;
      const tampered = JSON.parse(stored.snapshot_json);
      const edgeEdit = tampered.figures?.[0]?.editLog?.find((entry) => (
        entry.gid === diagram.edge.id && entry.prop === 'color'
      ));
      assert(edgeEdit?.identity?.relation, `diagram export snapshot has no edge relationship identity: ${stored.snapshot_json}`);
      edgeEdit.identity.relation.targetNodeId = 'latent_a';
      const tamperedJson = JSON.stringify(tampered);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');
      snapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(tamperedJson, tamperedHash, asset.assetId);
    } finally {
      snapshotDb.close();
    }

    const beforeSnapshotRejectedState = readPersistenceState(projectId);
    const snapshotRejected = await requestJson(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      { method: 'POST' },
    );
    assert(
      snapshotRejected.response.status === 409
        && snapshotRejected.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `diagram topology drift snapshot was not rejected: ${JSON.stringify(snapshotRejected.data)}`,
    );
    assert(
      snapshotRejected.data?.issues?.some((issue) => (
        issue.type === 'identity_mismatch' && issue.gid === diagram.edge.id
      )),
      `diagram topology drift snapshot did not report identity_mismatch: ${JSON.stringify(snapshotRejected.data?.issues)}`,
    );
    assert(
      readPersistenceState(projectId) === beforeSnapshotRejectedState,
      'rejected diagram snapshot changed project/session/history/cache/export state',
    );

    const restoreSnapshotDb = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      restoreSnapshotDb.pragma('busy_timeout = 5000');
      restoreSnapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(originalSnapshotJson, originalSnapshotHash, asset.assetId);
    } finally {
      restoreSnapshotDb.close();
    }

    const beforeRejectedState = readPersistenceState(projectId);
    const rejectedPatches = [
      buildPatch(diagram.latent, 'node_id', 'latent_renamed'),
      buildPatch(diagram.latent, 'x', 0.91),
      buildPatch(diagram.edge, 'source_node_id', 'observed_b'),
      buildPatch(diagram.edge, 'target_node_id', 'latent_a'),
      buildPatch(diagram.edge, 'direction', 'reverse'),
      buildPatch(diagram.arrow, 'direction', 'reverse'),
      buildPatch(diagram.coefficient, 'text', 'beta = 9.99'),
      buildPatch(diagram.coefficient, 'value', 9.99),
      buildPatch(diagram.coefficient, 'p_value', 0.91),
      buildPatch(diagram.coefficient, 'significance', 'ns'),
      buildPatch(diagram.fitAnnotation, 'text', 'CFI = 0.10; RMSEA = 0.99'),
      buildPatch(diagram.fitAnnotation, 'fit_indices', { cfi: 0.10, rmsea: 0.99 }),
      buildPatch(diagram.fitAnnotation, 'cfi', 0.10),
    ];
    for (const [index, rejectedPatch] of rejectedPatches.entries()) {
      const rejected = await submitPatchBatch(projectId, [rejectedPatch], `reject-${index}-${rejectedPatch.prop}`, styledRevision);
      assert(rejected.status === 'conflict', `protected ${rejectedPatch.gid}.${rejectedPatch.prop} patch was not rejected: ${JSON.stringify(rejected)}`);
      assert(Number(rejected.revision) === styledRevision, `rejected protected patch changed revision: ${JSON.stringify(rejected)}`);
      assert(Array.isArray(rejected.applied) && rejected.applied.length === 0, `rejected protected patch applied edits: ${JSON.stringify(rejected)}`);
      assert(
        Array.isArray(rejected.rejected) && rejected.rejected.some((entry) => (
          entry.gid === rejectedPatch.gid
          && entry.prop === rejectedPatch.prop
          && JSON.stringify(entry.value) === JSON.stringify(rejectedPatch.value)
        )),
        `conflict response did not identify rejected protected patch: ${JSON.stringify(rejected)}`,
      );
      assert(
        Array.isArray(rejected.warnings) && rejected.warnings.some((warning) => warning.type === 'unsupported_prop' && warning.gid === rejectedPatch.gid && warning.prop === rejectedPatch.prop),
        `protected patch was not rejected by manifest preflight unsupported_prop: ${JSON.stringify(rejected.warnings)}`,
      );
      assertNoRejectedTriplet('rejected patch response editLog', rejected.editLog || [], rejectedPatch);
      assert(
        readPersistenceState(projectId) === beforeRejectedState,
        `rejected ${rejectedPatch.gid}.${rejectedPatch.prop} changed revision/session/history/cache/export/snapshot state`,
      );
    }
    assert(readPersistenceState(projectId) === beforeRejectedState, 'protected diagram semantics rejection changed persisted state');

    const dbState = parseJson(beforeRejectedState, {});
    const cachedManifest = parseJson(dbState.figures?.[0]?.manifest, null);
    for (const rejectedPatch of rejectedPatches) {
      assertNoRejectedTriplet('preview cache manifest', cachedManifest, rejectedPatch);
      const cachedObject = cachedManifest?.objects?.find((object) => object.id === rejectedPatch.gid);
      if (cachedObject && rejectedPatch.prop in (cachedObject.currentProps || {})) {
        assert(
          !valueMatches(cachedObject.currentProps?.[rejectedPatch.prop], rejectedPatch.value),
          `preview cache applied rejected protected value ${rejectedPatch.gid}.${rejectedPatch.prop}`,
        );
      }
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      assetId: asset.assetId,
      roles: Object.fromEntries(Object.entries(diagram).map(([label, object]) => [label, { gid: object.id, role: object.role, kind: object.kind }])),
      validBackendStyles: validPatches.map((patch) => ({ gid: patch.gid, prop: patch.prop, revision: styledRevision })),
      rejectedProtectedProps: rejectedPatches.map((patch) => ({ gid: patch.gid, prop: patch.prop, revision: styledRevision })),
      checked: [
        'explicit diagram roles, relations, and backend capabilities render correctly',
        'ordinary lookalike scatter/line/arrow/text stay generic',
        'node, edge, arrow, label typography/position, and group style edits persist and replay through backend patches',
        'diagram relation drift, missing relations, mixed batches, and tampered export snapshots fail closed without persistence',
        'node identity/topology, edge direction/topology, coefficient text/value/p-value/significance, and fit text/indices are rejected before persistence',
        'revision, session, history, preview cache, export anchor, and export snapshot state stay unchanged after each rejection',
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
