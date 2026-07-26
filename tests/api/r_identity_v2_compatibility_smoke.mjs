import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

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
      email: `r-identity-v2-compat-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Identity-V2-Compatibility-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const rScript = [
  'library(ggplot2)',
  'df <- data.frame(x=1:4, y=c(1, 3, 2, 4), group=c("A", "A", "B", "B"))',
  'p <- ggplot(df, aes(x, y, color=group)) + geom_point(size=3) + theme_classic()',
  'p',
].join('\n');

const legacyTextScript = [
  'library(ggplot2)',
  'df <- data.frame(id=c("sample-a", "sample-b"), x=c(1, 2), y=c(2, 3), label=c("Alpha", "Beta"))',
  'p <- ggplot(df, aes(x, y, label=label)) + geom_text() + theme_classic()',
  'p',
].join('\n');

const statTextScript = [
  'library(ggplot2)',
  'df <- data.frame(group=c("A", "A", "B", "B"), x=c(1, 1, 2, 2), y=c(2, 4, 3, 5))',
  'p <- ggplot(df, aes(x, y)) + stat_summary(aes(label=after_stat(y)), fun=mean, geom="text") + theme_classic()',
  'p',
].join('\n');

function getDb(readonly = false) {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, readonly ? { readonly: true } : {});
  db.pragma('busy_timeout = 5000');
  return db;
}

function readDatabaseState(projectId, exportAssetId = null) {
  const db = getDb(true);
  try {
    const sessionId = `${projectId}_fig_1`;
    const session = db.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(sessionId);
    const figure = db.prepare(`
      SELECT session_id, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const exportAssets = db.prepare(`
      SELECT id, figure_id, name, format, dpi, metadata, tags, created_at
      FROM export_assets
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId);
    const exportSnapshots = db.prepare(`
      SELECT asset_id, figure_id, schema_version, snapshot_hash, snapshot_json, created_at
      FROM export_asset_snapshots
      WHERE project_id = ?
      ORDER BY asset_id
    `).all(projectId);
    const exportAnchor = exportAssetId
      ? db.prepare('SELECT id, metadata FROM export_assets WHERE id = ?').get(exportAssetId)
      : null;
    const snapshotAnchor = exportAssetId
      ? db.prepare('SELECT asset_id, schema_version, snapshot_hash, snapshot_json FROM export_asset_snapshots WHERE asset_id = ?').get(exportAssetId)
      : null;
    return {
      session: session ? {
        id: session.id,
        revision: Number(session.revision),
        editLog: parseJson(session.edit_log, []),
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
      exportAssets: exportAssets.map((row) => ({
        ...row,
        metadata: parseJson(row.metadata, {}),
        tags: parseJson(row.tags, []),
      })),
      exportSnapshots: exportSnapshots.map((row) => ({
        ...row,
        schemaVersion: Number(row.schema_version),
        snapshotJson: parseJson(row.snapshot_json, null),
      })),
      exportAnchor: exportAnchor ? {
        id: exportAnchor.id,
        metadata: parseJson(exportAnchor.metadata, null),
        snapshot: snapshotAnchor ? {
          assetId: snapshotAnchor.asset_id,
          schemaVersion: Number(snapshotAnchor.schema_version),
          snapshotHash: snapshotAnchor.snapshot_hash,
          snapshotJson: parseJson(snapshotAnchor.snapshot_json, null),
        } : null,
      } : null,
    };
  } finally {
    db.close();
  }
}

function readSessionState(sessionId) {
  const db = getDb(true);
  try {
    const row = db.prepare('SELECT id, script, edit_log, revision, updated_at FROM sessions WHERE id = ?').get(sessionId);
    return row ? {
      id: row.id,
      script: row.script,
      editLog: parseJson(row.edit_log, []),
      revision: Number(row.revision),
      updatedAt: row.updated_at,
    } : null;
  } finally {
    db.close();
  }
}

function readSnapshot(assetId) {
  const db = getDb(true);
  try {
    const row = db.prepare(`
      SELECT schema_version, snapshot_hash, snapshot_json
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId);
    return row ? {
      schemaVersion: Number(row.schema_version),
      snapshotHash: row.snapshot_hash,
      snapshot: parseJson(row.snapshot_json, null),
    } : null;
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

function downgradeStoredManifestToLegacyIdentityV1(projectId) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    assert(row?.manifest, 'render did not persist a manifest to downgrade');
    const manifest = parseJson(row.manifest, {});
    for (const object of manifest.objects || []) {
      delete object.stableKey;
      delete object.fingerprint;
      delete object.fingerprintVersion;
      if (Array.isArray(object.propertyCapabilities)) {
        object.editable = object.propertyCapabilities
          .filter((capability) => capability?.replay !== 'unsupported')
          .map((capability) => capability.prop);
      }
      delete object.propertyCapabilities;
    }
    db.prepare(`
      UPDATE project_figures
      SET manifest = ?
      WHERE project_id = ? AND figure_index = 0
    `).run(JSON.stringify(manifest), projectId);
    return manifest;
  } finally {
    db.close();
  }
}

function legacyIdentityFields(object) {
  return {
    identity: clone(object.identity),
  };
}

function v2IdentityFields(object) {
  return {
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: clone(object.identity),
  };
}

function legacyTextRoleIdentityFields(object) {
  assert(String(object?.fingerprint || '').startsWith('r-v2:'), 'text object is missing an R v2 fingerprint');
  const encoded = String(object.fingerprint).slice('r-v2:'.length).replace(/[\r\n\t ]+/g, '');
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  payload.role = 'ggplot_text_annotation';
  const identity = clone(object.identity);
  const relation = identity.relation || (identity.relation = {});
  delete relation.textSource;
  delete relation.statClass;
  relation.annotationId = object.id;
  return {
    stableKey: object.stableKey,
    fingerprint: `r-v2:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`,
    fingerprintVersion: 2,
    identity,
  };
}

async function createRenderedRProject(token, name, script) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `${name} ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spec: { plot_type: 'custom', custom_script: script, script, script_language: 'r' },
    }),
  });
  assert(created.response.ok && created.data?.id, `${name} project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `${name} initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest, `${name} initial render returned no manifest`);
  return { projectId, figure };
}

function persistLegacyTextProjectState(projectId, manifest, patch) {
  const legacyManifest = clone(manifest);
  const target = (legacyManifest.objects || []).find((object) => object.id === patch.gid);
  assert(target, `legacy text target ${patch.gid} is missing from stored manifest`);
  target.role = 'ggplot_text_annotation';
  target.fingerprint = patch.fingerprint;
  target.identity = clone(patch.identity);
  target.currentProps = { ...(target.currentProps || {}) };
  delete target.currentProps.textSource;
  delete target.currentProps.statClass;
  const db = getDb();
  try {
    const editLogJson = JSON.stringify([patch]);
    db.transaction(() => {
      db.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?').run(editLogJson, `${projectId}_fig_1`);
      db.prepare(`
        UPDATE project_figures
        SET edit_log = ?, manifest = ?
        WHERE project_id = ? AND figure_index = 0
      `).run(editLogJson, JSON.stringify(legacyManifest), projectId);
    })();
  } finally {
    db.close();
  }
}

function patchValueEquals(actual, expected) {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return JSON.stringify(stableDeep(actual)) === JSON.stringify(stableDeep(expected));
}

function hasPatch(editLog, expected) {
  return Array.isArray(editLog) && editLog.some((entry) => (
    entry?.gid === expected.gid
    && entry?.prop === expected.prop
    && patchValueEquals(entry?.value, expected.value)
  ));
}

function findGroup(manifest, groupKey) {
  const object = (manifest?.objects || []).find((candidate) => (
    candidate?.id?.startsWith('r.group.color.')
    && candidate?.identity?.relation?.groupKey === groupKey
    && Array.isArray(candidate?.editable)
    && candidate.editable.includes('color')
  ));
  assert(object?.id, `legacy manifest did not expose editable R group ${groupKey}: ${JSON.stringify(manifest)}`);
  assert(object.stableKey === undefined && object.fingerprintVersion === undefined, `target ${object.id} is not legacy identity-only`);
  return object;
}

async function createLegacyProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R identity v2 compatibility ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: rScript, script: rScript, script_language: 'r' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: rScript,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-identity-initial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial R render failed: ${JSON.stringify(rendered.data)}`);
  return { projectId, legacyManifest: downgradeStoredManifestToLegacyIdentityV1(projectId) };
}

async function submitPatch(token, projectId, patches, baseRevision) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-identity-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches,
    }),
  });
}

async function assertLegacyPatchAccepted(token, projectId, patch, baseRevision, label, options = {}) {
  const result = await submitPatch(token, projectId, [patch], baseRevision);
  assert(result.response.ok && result.data?.status === 'success', `${label} was rejected: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === baseRevision + 1, `${label} did not increment revision once: ${JSON.stringify(result.data)}`);
  const applied = result.data?.applied?.find((entry) => hasPatch([entry], patch));
  assert(applied, `${label} did not report the applied legacy patch: ${JSON.stringify(result.data)}`);
  if (options.expectedResolvedGid) {
    assert(applied.gid === patch.gid, `${label} acknowledgement should preserve requested gid: ${JSON.stringify(applied)}`);
    assert(applied.resolvedGid === options.expectedResolvedGid, `${label} did not expose renderer resolvedGid: ${JSON.stringify(applied)}`);
  }
  const state = readDatabaseState(projectId);
  assert(Number(state.session?.revision) === baseRevision + 1, `${label} session revision was not persisted`);
  assert(Number(state.figure?.revision) === baseRevision + 1, `${label} figure revision was not persisted`);
  assert(hasPatch(state.session?.editLog, patch), `${label} did not persist to session edit_log`);
  assert(hasPatch(state.figure?.editLog, patch), `${label} did not persist to project_figures edit_log`);
  if (options.expectedResolvedGid) {
    const persistedSessionPatch = state.session?.editLog?.find((entry) => hasPatch([entry], patch));
    const persistedFigurePatch = state.figure?.editLog?.find((entry) => hasPatch([entry], patch));
    assert(persistedSessionPatch && !Object.hasOwn(persistedSessionPatch, 'resolvedGid'), `${label} persisted renderer acknowledgement into session edit_log: ${JSON.stringify(persistedSessionPatch)}`);
    assert(persistedFigurePatch && !Object.hasOwn(persistedFigurePatch, 'resolvedGid'), `${label} persisted renderer acknowledgement into project_figures edit_log: ${JSON.stringify(persistedFigurePatch)}`);
  }
  assert(state.figure?.previewSvg && state.figure?.manifest, `${label} did not refresh preview/manifest`);
  return baseRevision + 1;
}

async function assertRejectedWithoutPersistence(token, projectId, exportAssetId, patch, baseRevision, label) {
  const before = readDatabaseState(projectId, exportAssetId);
  const result = await submitPatch(token, projectId, [patch], baseRevision);
  assert(result.response.ok && result.data?.status === 'conflict', `${label} should be a conflict: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data?.applied) && result.data.applied.length === 0, `${label} applied a rejected patch: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === baseRevision, `${label} changed response revision: ${JSON.stringify(result.data)}`);
  assertSameState(label, before, readDatabaseState(projectId, exportAssetId));
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  let positionTextProjectId = null;
  let legacyTextProjectId = null;
  let statTextProjectId = null;

  try {
    const created = await createLegacyProject(token);
    projectId = created.projectId;
    const groupA = findGroup(created.legacyManifest, 'A');
    const groupB = findGroup(created.legacyManifest, 'B');
    let revision = Number(readDatabaseState(projectId).figure?.revision || 1);

    const firstEdit = {
      op: 'set',
      mode: 'backend_patch',
      gid: groupA.id,
      prop: 'color',
      value: '#2CA02C',
      ...legacyIdentityFields(groupA),
    };
    revision = await assertLegacyPatchAccepted(token, projectId, firstEdit, revision, 'first legacy R identity edit');

    const refreshed = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(refreshed.response.ok && refreshed.data?.status === 'success', `legacy project refresh failed: ${JSON.stringify(refreshed.data)}`);
    const refreshedFigure = refreshed.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(['rendered', 'stored', 'cache'].includes(refreshedFigure?.previewSource), `unexpected refresh source: ${refreshedFigure?.previewSource}`);
    assert(hasPatch(refreshedFigure?.editLog, firstEdit), `refresh lost first legacy edit: ${JSON.stringify(refreshedFigure?.editLog)}`);

    const reorderedScript = rScript.replace(
      'p <- ggplot',
      'df$group <- factor(df$group, levels=c("B", "A"))\np <- ggplot',
    );
    const beforeReorder = readDatabaseState(projectId);
    const reordered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script: reorderedScript,
        editLogs: { fig_1: beforeReorder.figure?.editLog || [] },
        language: 'r',
        requestId: `r-identity-reorder-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    });
    assert(reordered.response.ok && reordered.data?.status === 'success', `legacy R factor reorder render failed: ${JSON.stringify(reordered.data)}`);
    const reorderedFigure = reordered.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    const reorderedGroupA = (reorderedFigure?.manifest?.objects || []).find((object) => object?.identity?.relation?.groupKey === 'A');
    const reorderedGroupB = (reorderedFigure?.manifest?.objects || []).find((object) => object?.identity?.relation?.groupKey === 'B');
    assert(reorderedGroupA?.id === 'r.group.color.0.1', `group A was not reordered to the second gid: ${JSON.stringify(reorderedGroupA)}`);
    assert(String(reorderedGroupA?.currentProps?.color).toLowerCase() === firstEdit.value.toLowerCase(), 'legacy group A edit did not follow its semantic identity');
    assert(String(reorderedGroupB?.currentProps?.color).toLowerCase() !== firstEdit.value.toLowerCase(), 'legacy group A edit leaked onto reordered group B');
    revision = Number(readDatabaseState(projectId).figure?.revision || revision);

    const secondEdit = {
      op: 'set',
      mode: 'backend_patch',
      gid: groupB.id,
      prop: 'color',
      value: '#D62728',
      ...legacyIdentityFields(groupB),
    };
    revision = await assertLegacyPatchAccepted(token, projectId, secondEdit, revision, 'second legacy R identity edit after refresh', {
      expectedResolvedGid: reorderedGroupB.id,
    });

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 150,
        saveToLibrary: true,
        name: 'r-identity-v2-compat-export-anchor',
      }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `legacy R export failed: ${JSON.stringify(exported.data)}`);
    const exportedFigure = exported.data?.figures?.[0];
    const exportAsset = exportedFigure?.asset;
    assert(exportAsset?.assetId && exportAsset.hasEditingSnapshot === true, `export did not persist an editing snapshot: ${JSON.stringify(exported.data)}`);
    assert(String(exportedFigure?.svg || '').toLowerCase().includes('#2ca02c'), 'export SVG did not include first legacy color');
    assert(String(exportedFigure?.svg || '').toLowerCase().includes('#d62728'), 'export SVG did not include second legacy color');
    const snapshot = readSnapshot(exportAsset.assetId);
    assert(snapshot?.schemaVersion === 5, `unexpected snapshot schema: ${JSON.stringify(snapshot)}`);
    const snapshotEditLog = snapshot.snapshot?.figures?.[0]?.editLog;
    assert(hasPatch(snapshotEditLog, firstEdit), 'export snapshot lost first legacy edit');
    assert(hasPatch(snapshotEditLog, secondEdit), 'export snapshot lost second legacy edit');

    const laterEdit = {
      ...firstEdit,
      value: '#9467BD',
    };
    revision = await assertLegacyPatchAccepted(token, projectId, laterEdit, revision, 'later legacy edit before restore');
    const beforeTamperSnapshot = readSnapshot(exportAsset.assetId).snapshot;
    const tamperedSnapshot = clone(beforeTamperSnapshot);
    tamperedSnapshot.figures[0].editLog = [
      ...tamperedSnapshot.figures[0].editLog,
      {
        op: 'set',
        mode: 'backend_patch',
        gid: 'missing.r.identity.v2.compat.gid',
        prop: 'color',
        value: '#000000',
      },
    ];
    writeSnapshot(exportAsset.assetId, tamperedSnapshot);
    const beforeRejectedRestore = readDatabaseState(projectId, exportAsset.assetId);
    const rejectedRestore = await jsonRequest(`/api/projects/${projectId}/export-assets/${exportAsset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(
      rejectedRestore.response.status === 409 && rejectedRestore.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `tampered legacy R snapshot restore should be rejected: ${JSON.stringify(rejectedRestore.data)}`,
    );
    assertSameState('tampered legacy R snapshot restore rejection', beforeRejectedRestore, readDatabaseState(projectId, exportAsset.assetId));

    writeSnapshot(exportAsset.assetId, beforeTamperSnapshot);
    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${exportAsset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `legacy R snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data.targetFigureId === 'fig_1', `restore targeted wrong figure: ${JSON.stringify(restored.data)}`);
    const afterRestore = readDatabaseState(projectId, exportAsset.assetId);
    assert(hasPatch(afterRestore.figure?.editLog, firstEdit), 'restore lost first export-time legacy edit');
    assert(hasPatch(afterRestore.figure?.editLog, secondEdit), 'restore lost second export-time legacy edit');
    assert(!hasPatch(afterRestore.figure?.editLog, laterEdit), 'restore leaked later legacy edit into active editLog');
    assert(hasPatch(afterRestore.figure?.history?.past?.at(-1)?.editLog, laterEdit), 'restore did not checkpoint the later legacy edit');

    const missingGidPatch = {
      ...secondEdit,
      gid: 'r.group.color.99.99',
      value: '#111111',
    };
    const postRestorePreview = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(postRestorePreview.response.ok && postRestorePreview.data?.status === 'success', `post-restore R preview refresh failed: ${JSON.stringify(postRestorePreview.data)}`);
    const postRestoreFigure = postRestorePreview.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    const existingCrossFamilyObject = postRestoreFigure?.manifest?.objects?.find((object) => (
      String(object?.id || '').startsWith('r.layer.')
    ));
    assert(existingCrossFamilyObject?.id, 'restored R manifest has no existing cross-family layer gid');
    const existingCrossFamilyGidPatch = {
      ...secondEdit,
      gid: existingCrossFamilyObject.id,
      value: '#181818',
    };
    const unsupportedPropPatch = {
      ...secondEdit,
      prop: 'r_wp2_unsupported_prop',
      value: 'must-not-persist',
    };
    const identityDriftPatch = {
      ...secondEdit,
      value: '#222222',
      identity: {
        ...secondEdit.identity,
        semanticKey: 'ggplot_group:color:DRIFTED',
        seriesKey: 'r-series:color:DRIFTED',
        relation: {
          ...(secondEdit.identity?.relation || {}),
          groupKey: 'DRIFTED',
        },
      },
    };
    const restoredRevision = Number(readDatabaseState(projectId).figure?.revision || revision);
    await assertRejectedWithoutPersistence(token, projectId, exportAsset.assetId, missingGidPatch, restoredRevision, 'legacy R missing gid rejection');
    await assertRejectedWithoutPersistence(token, projectId, exportAsset.assetId, existingCrossFamilyGidPatch, restoredRevision, 'legacy R existing cross-family gid rejection');
    await assertRejectedWithoutPersistence(token, projectId, exportAsset.assetId, unsupportedPropPatch, restoredRevision, 'legacy R unsupported prop rejection');
    await assertRejectedWithoutPersistence(token, projectId, exportAsset.assetId, identityDriftPatch, restoredRevision, 'legacy R semantic identity drift rejection');

    const duplicateLayerScript = [
      'library(ggplot2)',
      'df <- data.frame(x=1:4, y=c(1, 3, 2, 5))',
      'p <- ggplot(df, aes(x, y)) + geom_line() + geom_line() + theme_classic()',
      'p',
    ].join('\n');
    const duplicateRendered = await jsonRequest('/api/figure/render', token, {
      method: 'POST',
      body: JSON.stringify({ script: duplicateLayerScript, language: 'r', editLog: [] }),
    });
    assert(duplicateRendered.response.ok && duplicateRendered.data?.status === 'success', `duplicate-layer baseline render failed: ${JSON.stringify(duplicateRendered.data)}`);
    const duplicateTarget = (duplicateRendered.data?.manifest?.objects || []).find((object) => object?.id === 'r.layer.0');
    assert(duplicateTarget?.fingerprintVersion === 2, `duplicate-layer target lacks v2 identity: ${JSON.stringify(duplicateTarget)}`);
    const duplicateSessionId = duplicateRendered.data.sessionId;
    const beforeAmbiguousPatch = readSessionState(duplicateSessionId);
    const ambiguousPatch = {
      gid: duplicateTarget.id,
      prop: 'color',
      value: '#AA0000',
      mode: 'local_patch',
      stableKey: duplicateTarget.stableKey,
      fingerprint: duplicateTarget.fingerprint,
      fingerprintVersion: duplicateTarget.fingerprintVersion,
      identity: duplicateTarget.identity,
    };
    const ambiguousResult = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `r-identity-ambiguous-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: duplicateSessionId,
        baseRevision: beforeAmbiguousPatch.revision,
        patches: [ambiguousPatch],
      }),
    });
    assert(ambiguousResult.response.ok && ambiguousResult.data?.status === 'conflict', `ambiguous v2 R patch should conflict: ${JSON.stringify(ambiguousResult.data)}`);
    assert(ambiguousResult.data?.warnings?.some((warning) => warning?.type === 'ambiguous_identity'), `ambiguous v2 warning missing: ${JSON.stringify(ambiguousResult.data)}`);
    assertSameState('ambiguous standalone R v2 patch rejection', beforeAmbiguousPatch, readSessionState(duplicateSessionId));

    const positionTextCreated = await createRenderedRProject(token, 'R data text position identity', legacyTextScript);
    positionTextProjectId = positionTextCreated.projectId;
    const positionText = (positionTextCreated.figure.manifest.objects || []).find((object) => (
      object?.role === 'ggplot_text_data'
      && object?.identity?.relation?.dataKey === 'sample-a'
    ));
    assert(positionText?.id, `current renderer did not expose the position text target: ${JSON.stringify(positionTextCreated.figure.manifest)}`);
    const positionPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: positionText.id,
      prop: 'position',
      value: {
        x: Number(positionText.currentProps.x) + 0.05,
        y: Number(positionText.currentProps.y) + 0.03,
        coord_system: positionText.currentProps.coord_system,
      },
      ...v2IdentityFields(positionText),
    };
    const positionRevision = Number(readDatabaseState(positionTextProjectId).figure?.revision || 1);
    const movedText = await submitPatch(token, positionTextProjectId, [positionPatch], positionRevision);
    assert(movedText.response.ok && movedText.data?.status === 'success', `R data text position edit failed identity confirmation: ${JSON.stringify(movedText.data)}`);
    assert(hasPatch(movedText.data?.applied, positionPatch), `R data text position acknowledgement has the wrong value: ${JSON.stringify(movedText.data?.applied)}`);
    assert(hasPatch(readDatabaseState(positionTextProjectId).figure?.editLog, positionPatch), 'R data text position edit was not persisted');
    const reopenedPositionText = await jsonRequest(`/api/projects/${positionTextProjectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script: legacyTextScript, language: 'r' }),
    });
    assert(
      reopenedPositionText.response.ok && reopenedPositionText.data?.status === 'success',
      `R data text position project did not reopen: ${JSON.stringify(reopenedPositionText.data)}`,
    );
    const reopenedPositionFigure = reopenedPositionText.data.figures?.find((item) => item.figureId === 'fig_1');
    const reopenedPositionObject = reopenedPositionFigure?.manifest?.objects?.find((object) => object.id === positionText.id);
    assert(
      patchValueEquals(reopenedPositionObject?.currentProps?.position, positionPatch.value),
      `R data text position changed after refresh: ${JSON.stringify(reopenedPositionObject?.currentProps?.position)}`,
    );
    assert(hasPatch(reopenedPositionFigure?.editLog, positionPatch), 'refreshed R data text project lost the position edit');

    const legacyTextCreated = await createRenderedRProject(token, 'R text role compatibility', legacyTextScript);
    legacyTextProjectId = legacyTextCreated.projectId;
    const dataText = (legacyTextCreated.figure.manifest.objects || []).find((object) => (
      object?.role === 'ggplot_text_data'
      && object?.identity?.relation?.dataKey === 'sample-a'
    ));
    assert(dataText?.id, `current renderer did not expose the data text target: ${JSON.stringify(legacyTextCreated.figure.manifest)}`);
    const legacyTextPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: dataText.id,
      prop: 'color',
      value: '#2CA02C',
      ...legacyTextRoleIdentityFields(dataText),
    };
    persistLegacyTextProjectState(legacyTextProjectId, legacyTextCreated.figure.manifest, legacyTextPatch);
    const reopenedLegacyText = await jsonRequest(`/api/projects/${legacyTextProjectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script: legacyTextScript, language: 'r' }),
    });
    assert(
      reopenedLegacyText.response.ok && reopenedLegacyText.data?.status === 'success',
      `pre-role-split R text project did not reopen: ${JSON.stringify(reopenedLegacyText.data)}`,
    );
    const reopenedFigure = reopenedLegacyText.data.figures?.find((item) => item.figureId === 'fig_1');
    const reopenedText = reopenedFigure?.manifest?.objects?.find((object) => object.id === dataText.id);
    assert(reopenedText?.role === 'ggplot_text_data', `legacy text target did not migrate to the data role: ${JSON.stringify(reopenedText)}`);
    assert(String(reopenedText?.currentProps?.color).toLowerCase() === '#2ca02c', `legacy text color did not replay: ${JSON.stringify(reopenedText)}`);
    assert(hasPatch(reopenedFigure?.editLog, legacyTextPatch), 'reopened R text project lost the persisted legacy edit');

    const legacyTextExport = await jsonRequest(`/api/projects/${legacyTextProjectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    assert(legacyTextExport.response.ok && legacyTextExport.data?.status === 'success', `legacy text export failed: ${JSON.stringify(legacyTextExport.data)}`);
    const legacyTextAsset = legacyTextExport.data.figures?.[0]?.asset;
    assert(legacyTextAsset?.assetId && legacyTextAsset.hasEditingSnapshot === true, `legacy text export snapshot missing: ${JSON.stringify(legacyTextAsset)}`);

    const currentTextPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: reopenedText.id,
      prop: 'color',
      value: '#D62728',
      ...v2IdentityFields(reopenedText),
    };
    const reopenedRevision = Number(readDatabaseState(legacyTextProjectId).figure?.revision || 1);
    const changedText = await submitPatch(token, legacyTextProjectId, [currentTextPatch], reopenedRevision);
    assert(changedText.response.ok && changedText.data?.status === 'success', `post-migration R text edit failed: ${JSON.stringify(changedText.data)}`);
    const restoredText = await jsonRequest(
      `/api/projects/${legacyTextProjectId}/export-assets/${legacyTextAsset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    assert(restoredText.response.ok && restoredText.data?.status === 'success', `legacy text snapshot restore failed: ${JSON.stringify(restoredText.data)}`);
    const restoredTextState = readDatabaseState(legacyTextProjectId, legacyTextAsset.assetId);
    assert(hasPatch(restoredTextState.figure?.editLog, legacyTextPatch), 'legacy text snapshot restore lost the old role edit');
    assert(!hasPatch(restoredTextState.figure?.editLog, currentTextPatch), 'legacy text snapshot restore retained the later replacement edit');

    const statTextCreated = await createRenderedRProject(token, 'R stat text legacy forgery', statTextScript);
    statTextProjectId = statTextCreated.projectId;
    const statText = (statTextCreated.figure.manifest.objects || []).find((object) => object?.role === 'ggplot_text_stat');
    assert(statText?.id && statText.editable?.length === 0, `stat text target is not readonly: ${JSON.stringify(statText)}`);
    const forgedStatPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: statText.id,
      prop: 'text',
      value: 'forged statistic',
      ...legacyTextRoleIdentityFields(statText),
    };
    const beforeForgedStat = readDatabaseState(statTextProjectId);
    const forgedStatRender = await jsonRequest(`/api/projects/${statTextProjectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script: statTextScript,
        language: 'r',
        editLogs: { fig_1: [forgedStatPatch] },
      }),
    });
    assert(forgedStatRender.response.ok && forgedStatRender.data?.status === 'conflict', `forged legacy stat text edit was accepted: ${JSON.stringify(forgedStatRender.data)}`);
    assertSameState('forged legacy stat text rejection', beforeForgedStat, readDatabaseState(statTextProjectId));

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      exportAssetId: exportAsset.assetId,
      checked: [
        'isolated random-port temp DB/data guardrails were enforced',
        'first legacy R identity-only edit persisted through /api/figure/patch',
        'preview refresh preserved the legacy editLog',
        'factor reordering uniquely remapped the old group gid before apply',
        'post-reorder API patch response exposed renderer resolvedGid without persisting it',
        'second legacy R identity-only edit persisted after refresh',
        'export captured both legacy edits in a restorable snapshot',
        'tampered snapshot restore rejected without persistence',
        'snapshot restore returned to export-time legacy edits and checkpointed later edits',
        'missing gid, existing cross-family gid, unsupported prop, and semantic identity drift were rejected without persistence',
        'ambiguous v2 layer identity was rejected before standalone session persistence',
        'pre-role-split v2 R data text reopened, exported, continued editing, and restored from its export snapshot',
        'legacy annotation fingerprints cannot make current stat-generated text editable',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
    if (legacyTextProjectId) {
      await jsonRequest(`/api/projects/${legacyTextProjectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
    if (positionTextProjectId) {
      await jsonRequest(`/api/projects/${positionTextProjectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
    if (statTextProjectId) {
      await jsonRequest(`/api/projects/${statTextProjectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    stack: error.stack,
  }, null, 2));
  process.exitCode = 1;
});
