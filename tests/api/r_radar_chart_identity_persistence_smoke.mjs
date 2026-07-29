import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || '';

const R_RADAR_SCRIPT = [
  'library(ggplot2)',
  'dimensions <- c("Quality", "Speed", "Cost", "Reliability", "Safety")',
  'radar <- data.frame(',
  '  series = rep(c("Control", "Treatment"), each = length(dimensions) + 1L),',
  '  dimension = rep(c(dimensions, dimensions[[1]]), 2L),',
  '  value = c(0.72, 0.58, 0.66, 0.81, 0.63, 0.72, 0.84, 0.76, 0.52, 0.88, 0.79, 0.84)',
  ')',
  'radar$dimension <- factor(radar$dimension, levels = dimensions)',
  'p <- ggplot(radar, aes(dimension, value, group = series, colour = series, fill = series)) +',
  '  geom_polygon(alpha = 0.20, linewidth = 0.8) +',
  '  geom_line(linewidth = 1.0) +',
  '  geom_point(size = 2.0) +',
  '  scale_color_manual(values = c(Control = "#006D5B", Treatment = "#D55E00"), name = "Group") +',
  '  scale_fill_manual(values = c(Control = "#6FCF97", Treatment = "#E69F00"), name = "Group") +',
  '  coord_polar() + scale_y_continuous(limits = c(0, 1)) + theme_minimal()',
  'p',
].join('\n');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test requires the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test refuses non-loopback server ${BASE_URL}`);
  assert(url.port && url.port !== '3000', `test refuses default port ${BASE_URL}`);
  const dataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR || '');
  const dbPath = path.resolve(process.env.SCIFIGURE_DB_PATH || '');
  assert(path.basename(path.dirname(dataDir)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir ${dataDir}`);
  assert(dbPath.startsWith(dataDir + path.sep), `database is outside isolated data dir ${dbPath}`);
  assert(dataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/');
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
      email: `r-radar-identity-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Radar-Identity-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function objects(manifest) {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
}

function findObject(manifest, predicate, label) {
  const object = objects(manifest).find(predicate);
  assert(object?.id, `${label} missing from R radar manifest`);
  return object;
}

function identityFields(object) {
  return {
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: clone(object.identity),
  };
}

function makePatch(object, prop, value) {
  const capability = object.propertyCapabilities?.find((item) => item?.prop === prop);
  assert(capability?.patchMode === 'backend_patch', `${object.id}.${prop} lacks backend capability`);
  return { op: 'set', mode: 'backend_patch', gid: object.id, prop, value, ...identityFields(object) };
}

function legacyRadarFillPatch(object, value) {
  const legacyStableKey = String(object.stableKey).replace(/^r:patch:/, 'r:line:');
  assert(legacyStableKey !== object.stableKey, `unexpected radar fill stableKey ${object.stableKey}`);
  const payload = JSON.parse(Buffer.from(String(object.fingerprint).slice('r-v2:'.length), 'base64').toString('utf8'));
  payload.kind = 'line';
  payload.stableKey = legacyStableKey;
  const radarFields = ['radarId', 'radarSemanticRole', 'radarSeriesId', 'radarDimensionIndex'];
  for (const field of radarFields) delete payload.relation?.[field];
  const identity = clone(object.identity);
  for (const field of radarFields) delete identity.relation?.[field];
  return {
    op: 'set',
    mode: 'backend_patch',
    gid: object.id,
    prop: 'facecolor',
    value,
    stableKey: legacyStableKey,
    fingerprint: `r-v2:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`,
    fingerprintVersion: 2,
    identity,
  };
}

function legacyUnversionedRadarFillPatch(object, value) {
  const patch = legacyRadarFillPatch(object, value);
  delete patch.fingerprint;
  delete patch.fingerprintVersion;
  return patch;
}

function readSession(sessionId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    const row = database.prepare('SELECT revision, edit_log FROM sessions WHERE id = ?').get(sessionId);
    return row ? { revision: Number(row.revision), editLog: parseJson(row.edit_log, []) } : null;
  } finally {
    database.close();
  }
}

function readProjectFigure(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    const row = database.prepare(`
      SELECT revision, edit_log, history, manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    return row ? {
      revision: Number(row.revision),
      editLog: parseJson(row.edit_log, []),
      history: parseJson(row.history, {}),
      manifest: parseJson(row.manifest, null),
    } : null;
  } finally {
    database.close();
  }
}

function readExportSnapshot(assetId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    return database.prepare(`
      SELECT snapshot_json AS snapshotJson, snapshot_hash AS snapshotHash
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId) || null;
  } finally {
    database.close();
  }
}

function writeExportSnapshot(assetId, snapshotJson) {
  const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex');
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.prepare(`
      UPDATE export_asset_snapshots
      SET snapshot_json = ?, snapshot_hash = ?
      WHERE asset_id = ?
    `).run(snapshotJson, snapshotHash, assetId);
  } finally {
    database.close();
  }
}

function hasPatch(editLog, patch) {
  return editLog.some((entry) => (
    entry?.gid === patch.gid
    && entry?.prop === patch.prop
    && JSON.stringify(entry?.value) === JSON.stringify(patch.value)
  ));
}

async function renderRadar(token, sessionId, editLog = []) {
  return jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      ...(sessionId ? { sessionId } : {}),
      script: R_RADAR_SCRIPT,
      language: 'r',
      editLog,
      dataPayload: null,
      renderOptions: { width_in: 6, height_in: 5, dpi: 150 },
    }),
  });
}

async function submitPatch(token, sessionId, baseRevision, patches, context = {}) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-radar-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      baseRevision,
      patches,
      ...context,
    }),
  });
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const initial = await renderRadar(token);
  assert(initial.response.ok && initial.data?.status === 'success', `initial R radar render failed: ${JSON.stringify(initial.data)}`);
  const { manifest, sessionId } = initial.data;
  const baselineRevision = Number(initial.data.revision || 1);

  const dimension = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'dimension_label'
      && object.currentProps?.text === 'Quality'
  ), 'dimension label');
  const legendText = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'legend_text'
      && object.currentProps?.radarSeriesLabel === 'Control'
  ), 'legend text');
  const controlLine = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'series'
      && object.currentProps?.groupKey === 'Control'
  ), 'Control line');
  const treatmentLine = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'series'
      && object.currentProps?.groupKey === 'Treatment'
  ), 'Treatment line');
  const treatmentFill = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'fill'
      && object.currentProps?.groupKey === 'Treatment'
  ), 'Treatment fill');
  const controlFill = findObject(manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'fill'
      && object.currentProps?.groupKey === 'Control'
  ), 'Control fill');

  const patches = [
    makePatch(dimension, 'radar_label_offset', { dx: 9, dy: 4 }),
    makePatch(legendText, 'text', 'Control edited'),
    makePatch(controlLine, 'color', '#123456'),
    legacyRadarFillPatch(treatmentFill, '#ABCDEF'),
    legacyUnversionedRadarFillPatch(controlFill, '#0BADF0'),
  ];
  const patched = await submitPatch(token, sessionId, baselineRevision, patches);
  assert(patched.response.ok && patched.data?.status === 'success', `R radar patch failed: ${JSON.stringify(patched.data)}`);
  assert(Number(patched.data.revision) === baselineRevision + 1, 'R radar batch did not increment revision once');
  for (const patch of patches) assert(hasPatch(patched.data.editLog, patch), `response lost ${patch.gid}.${patch.prop}`);

  const patchedObjects = objects(patched.data.manifest);
  const byId = (id) => patchedObjects.find((object) => object.id === id);
  assert(byId(dimension.id)?.currentProps?.radar_label_offset?.dx === 9, 'dimension offset was not replayed');
  assert(byId(legendText.id)?.currentProps?.text === 'Control edited', 'legend text was not replayed');
  assert(String(byId(controlLine.id)?.currentProps?.color).toLowerCase() === '#123456', 'Control line color was not replayed');
  assert(String(byId(treatmentFill.id)?.currentProps?.facecolor).toLowerCase() === '#abcdef', 'legacy Treatment fill was not replayed');
  assert(String(byId(controlFill.id)?.currentProps?.facecolor).toLowerCase() === '#0badf0', 'unversioned legacy Control fill was not replayed');
  assert(String(byId(treatmentLine.id)?.currentProps?.color).toLowerCase() === String(treatmentLine.currentProps.color).toLowerCase(), 'Control line edit leaked to Treatment line');
  assert(String(byId(treatmentFill.id)?.currentProps?.facecolor).toLowerCase() !== String(byId(controlFill.id)?.currentProps?.facecolor).toLowerCase(), 'legacy fill edits collapsed distinct radar series colors');
  assert(String(patched.data.svg).includes('Control edited'), 'legend text edit did not reach SVG');
  assert(String(patched.data.svg).includes('translate(9 -4)'), 'dimension offset did not reach SVG');

  const stored = readSession(sessionId);
  assert(stored?.revision === baselineRevision + 1, `stored revision mismatch: ${JSON.stringify(stored)}`);
  for (const patch of patches) assert(hasPatch(stored.editLog, patch), `stored editLog lost ${patch.gid}.${patch.prop}`);
  const storedUnversionedFill = stored.editLog.find((entry) => (
    entry?.gid === controlFill.id && String(entry?.value).toLowerCase() === '#0badf0'
  ));
  assert(storedUnversionedFill && !Object.hasOwn(storedUnversionedFill, 'fingerprint'), 'legacy edit unexpectedly acquired a fingerprint');
  assert(!Object.hasOwn(storedUnversionedFill, 'fingerprintVersion'), 'legacy edit unexpectedly acquired a fingerprint version');

  const replayed = await renderRadar(token, sessionId, stored.editLog);
  assert(replayed.response.ok && replayed.data?.status === 'success', `saved R radar replay failed: ${JSON.stringify(replayed.data)}`);
  assert(String(replayed.data.svg).includes('Control edited'), 'saved legend text disappeared after replay');
  assert(String(replayed.data.svg).includes('translate(9 -4)'), 'saved dimension offset disappeared after replay');
  const replayedControlFill = findObject(replayed.data.manifest, (object) => object.id === controlFill.id, 'replayed Control fill');
  assert(String(replayedControlFill.currentProps?.facecolor).toLowerCase() === '#0badf0', 'unversioned legacy fill disappeared after saved replay');

  const beforeConflict = readSession(sessionId);
  const valid = makePatch(byId(legendText.id), 'color', '#224466');
  const forged = legacyUnversionedRadarFillPatch(byId(treatmentFill.id), '#FF00FF');
  forged.identity.relation.groupKey = 'Control';
  const conflict = await submitPatch(token, sessionId, Number(replayed.data.revision), [valid, forged]);
  assert(conflict.response.ok && conflict.data?.status === 'conflict', `forged mixed batch was not rejected: ${JSON.stringify(conflict.data)}`);
  assert(Array.isArray(conflict.data.applied) && conflict.data.applied.length === 0, 'forged mixed batch applied a partial edit');
  assert(JSON.stringify(readSession(sessionId)) === JSON.stringify(beforeConflict), 'forged mixed batch changed persisted session state');

  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R radar snapshot compatibility ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: R_RADAR_SCRIPT,
        script: R_RADAR_SCRIPT,
        script_language: 'r',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `R radar project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const projectSessionId = `${projectId}_fig_1`;
  const projectContext = { projectId, figureId: 'fig_1' };
  const projectRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: R_RADAR_SCRIPT,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-radar-project-${Date.now()}`,
    }),
  });
  assert(projectRender.response.ok && projectRender.data?.status === 'success', `R radar project render failed: ${JSON.stringify(projectRender.data)}`);
  const projectFigure = projectRender.data.figures?.find((figure) => figure.figureId === 'fig_1');
  assert(projectFigure?.manifest, 'R radar project render returned no fig_1 manifest');
  const projectControlFill = findObject(projectFigure.manifest, (object) => (
    object.currentProps?.radarSemanticRole === 'fill'
      && object.currentProps?.groupKey === 'Control'
  ), 'project Control fill');
  const exportTimePatch = legacyUnversionedRadarFillPatch(projectControlFill, '#135E96');
  const exportTime = await submitPatch(
    token,
    projectSessionId,
    Number(projectFigure.revision || 1),
    [exportTimePatch],
    projectContext,
  );
  assert(exportTime.response.ok && exportTime.data?.status === 'success', `export-time legacy radar patch failed: ${JSON.stringify(exportTime.data)}`);

  const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
  });
  assert(exported.response.ok && exported.data?.status === 'success', `R radar snapshot export failed: ${JSON.stringify(exported.data)}`);
  const exportedFigure = exported.data.figures?.find((figure) => figure.figureId === 'fig_1');
  const asset = exportedFigure?.asset;
  assert(asset?.assetId && asset.hasEditingSnapshot === true, `R radar export has no restorable snapshot: ${JSON.stringify(exportedFigure)}`);
  assert(String(exportedFigure.svg).toLowerCase().includes('#135e96'), 'exported radar SVG lost the unversioned fill edit');

  const exportManifestFill = findObject(exportTime.data.manifest, (object) => object.id === projectControlFill.id, 'export-time Control fill');
  const postExportPatch = makePatch(exportManifestFill, 'facecolor', '#D4351C');
  const postExport = await submitPatch(
    token,
    projectSessionId,
    Number(exportTime.data.revision),
    [postExportPatch],
    projectContext,
  );
  assert(postExport.response.ok && postExport.data?.status === 'success', `post-export radar patch failed: ${JSON.stringify(postExport.data)}`);

  const originalSnapshot = readExportSnapshot(asset.assetId);
  assert(originalSnapshot?.snapshotJson, 'R radar export snapshot row is missing');
  const forgedSnapshot = parseJson(originalSnapshot.snapshotJson, null);
  const forgedSnapshotPatch = forgedSnapshot?.figures?.[0]?.editLog?.find((entry) => (
    entry?.gid === exportTimePatch.gid
      && String(entry?.value).toLowerCase() === '#135e96'
  ));
  assert(forgedSnapshotPatch, 'R radar export snapshot lost the unversioned fill edit');
  assert(!Object.hasOwn(forgedSnapshotPatch, 'fingerprint'), 'snapshot unexpectedly versioned the legacy fill fingerprint');
  assert(!Object.hasOwn(forgedSnapshotPatch, 'fingerprintVersion'), 'snapshot unexpectedly versioned the legacy fill identity');
  forgedSnapshotPatch.identity.relation.scaleKey += ':forged';
  writeExportSnapshot(asset.assetId, JSON.stringify(forgedSnapshot));

  const beforeRejectedRestore = {
    session: readSession(projectSessionId),
    figure: readProjectFigure(projectId),
  };
  const rejectedRestore = await jsonRequest(
    `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
    token,
    { method: 'POST' },
  );
  assert(rejectedRestore.response.status === 409, `forged radar snapshot restore was not rejected: ${JSON.stringify(rejectedRestore.data)}`);
  assert(
    JSON.stringify({ session: readSession(projectSessionId), figure: readProjectFigure(projectId) })
      === JSON.stringify(beforeRejectedRestore),
    'rejected radar snapshot restore changed project or session state',
  );

  writeExportSnapshot(asset.assetId, originalSnapshot.snapshotJson);
  const restored = await jsonRequest(
    `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
    token,
    { method: 'POST' },
  );
  assert(restored.response.ok && restored.data?.status === 'success', `valid radar snapshot restore failed: ${JSON.stringify(restored.data)}`);
  const restoredFigureState = readProjectFigure(projectId);
  assert(hasPatch(restoredFigureState.editLog, exportTimePatch), 'snapshot restore lost the export-time unversioned fill edit');
  assert(!hasPatch(restoredFigureState.editLog, postExportPatch), 'snapshot restore retained the post-export fill edit');
  const restoredLegacyPatch = restoredFigureState.editLog.find((entry) => hasPatch([entry], exportTimePatch));
  assert(!Object.hasOwn(restoredLegacyPatch, 'fingerprint'), 'restored legacy fill unexpectedly acquired a fingerprint');
  assert(!Object.hasOwn(restoredLegacyPatch, 'fingerprintVersion'), 'restored legacy fill unexpectedly acquired a fingerprint version');

  const regenerated = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: R_RADAR_SCRIPT,
      editLogs: { fig_1: restoredFigureState.editLog },
      language: 'r',
      requestId: `r-radar-restored-${Date.now()}`,
    }),
  });
  assert(regenerated.response.ok && regenerated.data?.status === 'success', `restored radar project render failed: ${JSON.stringify(regenerated.data)}`);
  const regeneratedFigure = regenerated.data.figures?.find((figure) => figure.figureId === 'fig_1');
  const regeneratedFill = findObject(regeneratedFigure.manifest, (object) => object.id === projectControlFill.id, 'restored Control fill');
  assert(String(regeneratedFill.currentProps?.facecolor).toLowerCase() === '#135e96', 'restored radar SVG/manifest did not return to the export-time fill color');

  console.log('PASS R radar identity compatibility, independent editing, replay, atomic rejection, and snapshot restore');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
