import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under the isolated server wrapper');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
  const resolvedDataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const resolvedDbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `DB is outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data directory');
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
      email: `legacy-legend-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Legacy-Legend-Smoke-2026',
      displayName: 'Legacy legend collection fingerprint smoke',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH);
  db.pragma('busy_timeout = 5000');
  return db;
}

function readStoredFigure(projectId) {
  const db = getDb();
  try {
    const figure = db.prepare(`
      SELECT session_id, revision, edit_log, history, manifest, preview_svg, fingerprint
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const session = figure?.session_id
      ? db.prepare('SELECT id, revision, edit_log FROM sessions WHERE id = ?').get(figure.session_id)
      : null;
    return {
      figure: figure ? {
        ...figure,
        editLog: parseJson(figure.edit_log, []),
        history: parseJson(figure.history, { past: [], future: [] }),
        manifest: parseJson(figure.manifest, null),
      } : null,
      session: session ? {
        ...session,
        editLog: parseJson(session.edit_log, []),
      } : null,
    };
  } finally {
    db.close();
  }
}

function replacePersistedEditLog(projectId, editLog, revision = 7) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT session_id FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    assert(row?.session_id, 'project figure session is missing');
    const editLogJson = JSON.stringify(editLog);
    db.transaction(() => {
      db.prepare('UPDATE sessions SET edit_log = ?, revision = ? WHERE id = ?')
        .run(editLogJson, revision, row.session_id);
      db.prepare(`
        UPDATE project_figures
        SET edit_log = ?, revision = ?, preview_svg = NULL, fingerprint = NULL, preview_updated_at = NULL
        WHERE project_id = ? AND figure_index = 0
      `).run(editLogJson, revision, projectId);
    })();
  } finally {
    db.close();
  }
}

function readSnapshot(assetId) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT schema_version, snapshot_json, snapshot_hash
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId);
    return row ? { ...row, snapshot: parseJson(row.snapshot_json, {}) } : null;
  } finally {
    db.close();
  }
}

function writeSnapshot(assetId, snapshot) {
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex');
  const db = getDb();
  try {
    db.prepare(`
      UPDATE export_asset_snapshots
      SET snapshot_json = ?, snapshot_hash = ?
      WHERE asset_id = ?
    `).run(snapshotJson, snapshotHash, assetId);
  } finally {
    db.close();
  }
}

function identityFields(object, fingerprint = object.fingerprint) {
  return {
    stableKey: object.stableKey,
    fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: clone(object.identity),
  };
}

function staleFingerprintFor(object, suffix = 'layout-offsets-v1') {
  return createHash('sha256')
    .update(`${object.id}|${object.stableKey}|${suffix}`)
    .digest('hex');
}

function hasPatch(editLog, expected) {
  return Array.isArray(editLog) && editLog.some(entry => (
    entry?.gid === expected.gid
    && entry?.prop === expected.prop
    && JSON.stringify(entry?.value) === JSON.stringify(expected.value)
  ));
}

function hexToRgb01(hex) {
  const normalized = String(hex || '').replace('#', '');
  return [0, 2, 4].map(offset => parseInt(normalized.slice(offset, offset + 2), 16) / 255);
}

function manifestObjectHasFacecolor(manifest, gid, hex) {
  const object = (manifest?.objects || []).find(item => item?.id === gid);
  const facecolor = object?.currentProps?.facecolor;
  const rgba = Array.isArray(facecolor?.[0]) ? facecolor[0] : facecolor;
  if (!Array.isArray(rgba) || rgba.length < 3) return false;
  const expected = hexToRgb01(hex);
  return expected.every((value, index) => Math.abs(Number(rgba[index]) - value) < 0.01);
}

function assertLegendCollectionIdentity(object, label) {
  const relation = object?.identity?.relation || {};
  assert(String(object?.id || '').startsWith('legend_collection.'), `${label} is not a legend collection: ${JSON.stringify(object)}`);
  assert(object?.kind === 'collection', `${label} is not a collection: ${JSON.stringify(object)}`);
  for (const field of ['legendId', 'legendTextId']) {
    assert(typeof relation[field] === 'string' && relation[field], `${label} missing ${field}: ${JSON.stringify(object)}`);
  }
  assert(typeof object.stableKey === 'string' && object.stableKey, `${label} missing stableKey`);
  assert(object.fingerprintVersion === 2 && typeof object.fingerprint === 'string', `${label} missing v2 fingerprint`);
  assert(typeof object.identity?.seriesKey === 'string' && object.identity.seriesKey, `${label} missing seriesKey`);
}

function supportsObjectProp(object, prop) {
  return Array.isArray(object?.propertyCapabilities)
    && object.propertyCapabilities.some(capability => (
      capability?.prop === prop
      && capability.replay !== 'unsupported'
      && Array.isArray(capability.scopes)
      && capability.scopes.includes('object')
    ));
}

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  '',
  'fig, ax = plt.subplots(figsize=(4.6, 3.2))',
  'pos = ax.scatter([0, 1, 2], [1.0, 2.2, 2.8], s=[38, 72, 110], color="#1f77b4", label="Positive")',
  'neg = ax.scatter([0, 1, 2], [2.6, 1.8, 1.2], s=[44, 70, 96], color="#d62728", label="Negative")',
  'main_legend = ax.legend(handles=[pos], labels=["Positive"], loc="upper left", title="Main")',
  'ax.add_artist(main_legend)',
  'ax.legend(handles=[neg], labels=["Negative"], loc="lower right", title="Extra")',
  'ax.set_title("Legacy legend collection fingerprint")',
  'ax.set_xlabel("x")',
  'ax.set_ylabel("response")',
  'fig.tight_layout()',
].join('\n');

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;

  try {
    const created = await jsonRequest('/api/projects', token, {
      method: 'POST',
      body: JSON.stringify({
        name: `Legacy legend collection fingerprint ${Date.now()}`,
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
      }),
    });
    assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
    projectId = created.data.id;

    const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'python' }),
    });
    assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
    const objects = rendered.data.figures?.[0]?.manifest?.objects || [];
    const legendCollections = objects.filter(object => String(object?.id || '').startsWith('legend_collection.'));
    assert(legendCollections.length >= 2, `expected at least two legend collections: ${JSON.stringify(objects.map(object => object.id))}`);
    const [firstLegendCollection, secondLegendCollection] = legendCollections;
    assertLegendCollectionIdentity(firstLegendCollection, 'first legend collection');
    assertLegendCollectionIdentity(secondLegendCollection, 'second legend collection');
    assert(
      firstLegendCollection.identity.relation.legendId !== secondLegendCollection.identity.relation.legendId,
      `test needs two separate legend containers: ${JSON.stringify(legendCollections)}`,
    );
    assert(supportsObjectProp(firstLegendCollection, 'facecolor'), `legend collection facecolor is not replayable: ${JSON.stringify(firstLegendCollection.propertyCapabilities)}`);

    const dataCollection = objects.find(object => (
      String(object?.id || '').startsWith('collection.')
      && object?.kind === 'collection'
      && object?.fingerprintVersion === 2
      && supportsObjectProp(object, 'facecolor')
    ));
    assert(dataCollection?.id, `expected a normal data collection target: ${JSON.stringify(objects.map(object => ({ id: object.id, kind: object.kind, props: object.propertyCapabilities })))}`);

    let revision = Number(readStoredFigure(projectId).figure?.revision || 1);
    const staleLegendPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: firstLegendCollection.id,
      prop: 'facecolor',
      value: '#3A86FF',
      ...identityFields(firstLegendCollection, staleFingerprintFor(firstLegendCollection)),
    };
    const accepted = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `legacy-legend-accepted-${Date.now()}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: revision,
        patches: [staleLegendPatch],
      }),
    });
    assert(accepted.response.ok && accepted.data?.status === 'success', `trusted stale legend collection fingerprint was rejected: ${JSON.stringify(accepted.data)}`);
    revision = Number(accepted.data.revision);
    assert(hasPatch(readStoredFigure(projectId).figure?.editLog, staleLegendPatch), 'accepted stale legend edit was not persisted');

    const badRelationPatch = {
      ...staleLegendPatch,
      value: '#FF006E',
      identity: {
        ...clone(staleLegendPatch.identity),
        relation: {
          ...clone(staleLegendPatch.identity.relation),
          legendId: secondLegendCollection.identity.relation.legendId,
          legendTextId: secondLegendCollection.identity.relation.legendTextId,
        },
      },
    };
    const beforeBadRelation = JSON.stringify(readStoredFigure(projectId));
    const badRelation = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `legacy-legend-bad-relation-${Date.now()}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: revision,
        patches: [badRelationPatch],
      }),
    });
    assert(badRelation.response.ok && badRelation.data?.status === 'conflict', `legend relation drift was not rejected: ${JSON.stringify(badRelation.data)}`);
    assert(
      badRelation.data?.warnings?.some(warning => warning?.field === 'identity.relation'),
      `legend relation rejection did not report identity.relation: ${JSON.stringify(badRelation.data)}`,
    );
    assert(JSON.stringify(readStoredFigure(projectId)) === beforeBadRelation, 'rejected legend relation drift changed persisted state');

    const staleDataCollectionPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: dataCollection.id,
      prop: 'facecolor',
      value: '#00AA00',
      ...identityFields(dataCollection, staleFingerprintFor(dataCollection)),
    };
    const beforeDataMismatch = JSON.stringify(readStoredFigure(projectId));
    const dataRejected = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `legacy-legend-data-reject-${Date.now()}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: revision,
        patches: [staleDataCollectionPatch],
      }),
    });
    assert(dataRejected.response.ok && dataRejected.data?.status === 'conflict', `normal data collection stale fingerprint was not rejected: ${JSON.stringify(dataRejected.data)}`);
    assert(JSON.stringify(readStoredFigure(projectId)) === beforeDataMismatch, 'rejected normal collection fingerprint drift changed persisted state');

    replacePersistedEditLog(projectId, [staleLegendPatch], revision + 3);
    const reopened = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script, language: 'python' }),
    });
    assert(reopened.response.ok && reopened.data?.status === 'success', `old project render rejected stale legend editLog: ${JSON.stringify(reopened.data)}`);
    assert(
      manifestObjectHasFacecolor(reopened.data.figures?.[0]?.manifest, firstLegendCollection.id, staleLegendPatch.value),
      'project render did not replay stale legend editLog',
    );

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 180,
        saveToLibrary: true,
        name: 'legacy legend collection fingerprint export',
      }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `export rejected stale legend editLog: ${JSON.stringify(exported.data)}`);
    const asset = exported.data.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `export did not create an editing snapshot: ${JSON.stringify(exported.data)}`);

    const snapshotRow = readSnapshot(asset.assetId);
    assert(snapshotRow?.snapshot?.figures?.[0], `snapshot row missing: ${JSON.stringify(snapshotRow)}`);
    const staleSnapshot = clone(snapshotRow.snapshot);
    staleSnapshot.figures[0].editLog = [staleLegendPatch];
    writeSnapshot(asset.assetId, staleSnapshot);
    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `snapshot restore rejected stale legend editLog: ${JSON.stringify(restored.data)}`);
    assert(hasPatch(readStoredFigure(projectId).figure?.editLog, staleLegendPatch), 'restored snapshot lost stale legend edit');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      legendCollectionGids: legendCollections.map(object => object.id),
      dataCollectionGid: dataCollection.id,
      checks: [
        'trusted legend_collection v2 fingerprint drift is accepted when stableKey, seriesKey, legendId, and legendTextId match, with parent/series relation fields enforced when present',
        'legend_collection relation drift is rejected without persistence changes',
        'normal data collection v2 fingerprint drift remains rejected',
        'old project render, export, and export-snapshot restore replay stale legend_collection records',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
