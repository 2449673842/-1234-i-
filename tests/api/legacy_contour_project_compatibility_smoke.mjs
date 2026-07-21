import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { projectFigureSaveBase } from '../helpers/project_save_hash.mjs';
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
      email: `legacy-contour-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Legacy-Contour-Smoke-2026',
      displayName: 'Legacy contour compatibility smoke',
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

function findFigure(project, figureId = 'fig_1') {
  return project?.figures?.find(figure => figure.figureId === figureId) || null;
}

function hasEdit(editLog, expected) {
  return Array.isArray(editLog) && editLog.some(entry => (
    entry?.gid === expected.gid
    && entry?.prop === expected.prop
    && Number(entry?.value) === Number(expected.value)
  ));
}

function getDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH);
  db.pragma('busy_timeout = 5000');
  return db;
}

function readStoredFigure(projectId) {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT revision, edit_log, history, manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
  } finally {
    db.close();
  }
}

function readSnapshot(assetId) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT schema_version, snapshot_json
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId);
    return row ? { ...row, snapshot: parseJson(row.snapshot_json, {}) } : null;
  } finally {
    db.close();
  }
}

function replaceSnapshotEditLog(assetId, editLog) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT snapshot_json
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId);
    assert(row?.snapshot_json, `snapshot is missing: ${assetId}`);
    const snapshot = parseJson(row.snapshot_json, {});
    assert(Array.isArray(snapshot.figures) && snapshot.figures[0], 'snapshot has no Figure state');
    snapshot.figures[0].editLog = editLog;
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex');
    db.prepare(`
      UPDATE export_asset_snapshots
      SET snapshot_json = ?, snapshot_hash = ?
      WHERE asset_id = ?
    `).run(snapshotJson, snapshotHash, assetId);
  } finally {
    db.close();
  }
}

function downgradeStoredManifestForLegacyContourChild(projectId, legacyChildGid) {
  const db = getDb();
  try {
    const row = db.prepare(`
      SELECT manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    assert(row?.manifest, 'render did not persist a manifest to downgrade');
    const manifest = parseJson(row.manifest, {});
    const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
    for (const object of objects) {
      delete object.propertyCapabilities;
      if (object.kind === 'contourf' || object.kind === 'contour') {
        object.editable = [];
        delete object.children;
      }
    }
    const legacyChild = objects.find(object => object.id === legacyChildGid);
    assert(legacyChild, `downgrade target child is missing: ${legacyChildGid}`);
    legacyChild.editable = Array.from(new Set([...(legacyChild.editable || []), 'alpha', 'zorder']));
    delete legacyChild.propertyCapabilities;
    assert(!Object.prototype.hasOwnProperty.call(legacyChild, 'propertyCapabilities'), 'legacy child still declares propertyCapabilities');
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

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  'import numpy as np',
  '',
  'grid = np.linspace(-1.5, 1.5, 28)',
  'X, Y = np.meshgrid(grid, grid)',
  'Z = np.sin(X * 1.8) + np.cos(Y * 1.4)',
  'fig, ax = plt.subplots(figsize=(4, 3))',
  'filled = ax.contourf(X, Y, Z, levels=[-1.5, -0.75, 0, 0.75, 1.5], cmap="viridis", alpha=0.8)',
  'ax.contour(X, Y, Z, levels=[-1, 0, 1], cmap="magma", linewidths=1.1)',
  'fig.colorbar(filled, ax=ax, label="Legacy scale")',
  'ax.set_title("Legacy contour compatibility")',
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
        name: `Legacy contour compatibility ${Date.now()}`,
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
    const contourf = objects.find(object => object.kind === 'contourf' && object.role === 'contourf_series');
    assert(contourf?.children?.length, `rendered manifest has no contourf children: ${JSON.stringify(objects.map(object => ({ id: object.id, kind: object.kind, role: object.role })))}`);
    const legacyChildGid = contourf.children[0];
    const modernChild = objects.find(object => object.id === legacyChildGid);
    assert(modernChild?.role === 'contour_child_collection', `target is not a contour child collection: ${JSON.stringify(modernChild)}`);
    assert(Array.isArray(modernChild.propertyCapabilities) && modernChild.propertyCapabilities.length === 0, 'modern contour child unexpectedly declares capabilities');

    const legacyEdit = {
      gid: legacyChildGid,
      prop: 'alpha',
      value: 0.35,
      mode: 'local_patch',
      timestamp: 101,
    };
    const otherArtistClass = modernChild.source?.artistClass === 'PathCollection'
      ? 'QuadContourSet'
      : 'PathCollection';
    const crossVersionFingerprint = createHash('sha256')
      .update(`${modernChild.stableKey}|${otherArtistClass}`)
      .digest('hex');
    const identityLegacyEdit = {
      gid: legacyChildGid,
      prop: 'zorder',
      value: 6,
      mode: 'local_patch',
      timestamp: 102,
      stableKey: modernChild.stableKey,
      fingerprint: crossVersionFingerprint,
      fingerprintVersion: 2,
      identity: { seriesKey: modernChild.identity?.seriesKey },
    };
    const legacyEdits = [legacyEdit, identityLegacyEdit];
    const beforeModernRejection = readStoredFigure(projectId);
    const modernRejected = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: { fig_1: legacyEdits }, language: 'python' }),
    });
    assert(
      modernRejected.response.ok && modernRejected.data?.status === 'conflict',
      `modern contour child edit bypassed propertyCapabilities: ${JSON.stringify(modernRejected.data)}`,
    );
    assert(
      modernRejected.data?.warnings?.some(warning => warning?.type === 'unsupported_prop' && warning?.gid === legacyChildGid),
      `modern contour child rejection did not report unsupported_prop: ${JSON.stringify(modernRejected.data)}`,
    );
    assert(
      JSON.stringify(readStoredFigure(projectId)) === JSON.stringify(beforeModernRejection),
      'rejected modern contour child edit changed persisted Figure state',
    );

    const modernExport = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 200, saveToLibrary: true }),
    });
    assert(modernExport.response.ok && modernExport.data?.status === 'success', `modern export failed: ${JSON.stringify(modernExport.data)}`);
    const modernAsset = modernExport.data.figures?.[0]?.asset;
    assert(modernAsset?.assetId, `modern export did not create an asset: ${JSON.stringify(modernExport.data)}`);
    const modernSnapshot = readSnapshot(modernAsset.assetId);
    assert(modernSnapshot?.schema_version === 5, `unexpected modern snapshot schema: ${JSON.stringify(modernSnapshot)}`);
    assert(
      Array.isArray(modernSnapshot.snapshot?.figures?.[0]?.legacyReplaySignatures)
        && modernSnapshot.snapshot.figures[0].legacyReplaySignatures.length === 0,
      `modern snapshot unexpectedly authorized legacy replay: ${JSON.stringify(modernSnapshot.snapshot)}`,
    );
    replaceSnapshotEditLog(modernAsset.assetId, legacyEdits);
    const beforeForgedRestore = readStoredFigure(projectId);
    const forgedRestore = await jsonRequest(`/api/projects/${projectId}/export-assets/${modernAsset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(
      forgedRestore.response.status === 409 && forgedRestore.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `modern snapshot bypassed capability authority: ${JSON.stringify(forgedRestore.data)}`,
    );
    assert(
      forgedRestore.data?.issues?.some(issue => issue?.type === 'unsupported_prop' && issue?.gid === legacyChildGid),
      `modern snapshot rejection did not report unsupported_prop: ${JSON.stringify(forgedRestore.data)}`,
    );
    assert(
      JSON.stringify(readStoredFigure(projectId)) === JSON.stringify(beforeForgedRestore),
      'rejected modern snapshot restore changed persisted Figure state',
    );

    const legacyManifest = downgradeStoredManifestForLegacyContourChild(projectId, legacyChildGid);
    const legacyChild = legacyManifest.objects.find(object => object.id === legacyChildGid);
    assert(legacyChild.editable.includes('alpha'), 'downgraded legacy child does not expose alpha through editable');
    assert(legacyChild.editable.includes('zorder'), 'downgraded legacy child does not expose zorder through editable');
    assert(!legacyManifest.objects.some(object => Object.prototype.hasOwnProperty.call(object, 'propertyCapabilities')), 'downgraded legacy manifest still contains propertyCapabilities');
    assert(legacyManifest.objects.filter(object => object.kind === 'contourf' || object.kind === 'contour').every(object => (object.editable || []).length === 0), 'downgraded contour parent still declares modern abilities');

    const legacyBaseline = await jsonRequest(`/api/projects/${projectId}`, token);
    const legacyBaselineFigure = findFigure(legacyBaseline.data?.project);
    const seededLegacySave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Legacy contour compatibility seeded',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{
          figureId: 'fig_1',
          ...projectFigureSaveBase(legacyBaselineFigure),
          revision: legacyBaselineFigure.revision,
          editLog: legacyEdits,
          history: legacyBaselineFigure.history,
        }],
      }),
    });
    assert(
      seededLegacySave.response.ok && seededLegacySave.data?.status === 'success',
      `legacy contour fixture could not preserve historical child edits: ${JSON.stringify(seededLegacySave.data)}`,
    );

    const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
    assert(loaded.response.ok && loaded.data?.status === 'success', `legacy project load failed: ${JSON.stringify(loaded.data)}`);
    const loadedFigure = findFigure(loaded.data.project);
    assert(hasEdit(loadedFigure?.editLog, legacyEdit), `legacy child alpha edit missing on load: ${JSON.stringify(loadedFigure)}`);
    assert(hasEdit(loadedFigure?.editLog, identityLegacyEdit), `identity-bearing legacy child edit missing on load: ${JSON.stringify(loadedFigure)}`);

    const unchangedLegacySave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Legacy contour compatibility unchanged',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{
          figureId: 'fig_1',
          revision: loadedFigure.revision,
          editLog: legacyEdits,
          history: loadedFigure.history,
        }],
      }),
    });
    assert(
      unchangedLegacySave.response.ok && unchangedLegacySave.data?.status === 'success',
      `unchanged legacy PUT was rejected: ${unchangedLegacySave.response.status} ${JSON.stringify(unchangedLegacySave.data)}`,
    );

    const putHistory = {
      past: [{
        label: 'legacy child alpha checkpoint',
        timestamp: Date.now(),
        editLog: legacyEdits,
      }],
      future: [],
    };
    const saved = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Legacy contour compatibility saved',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{
          figureId: 'fig_1',
          ...projectFigureSaveBase(loadedFigure),
          revision: loadedFigure.revision,
          editLog: legacyEdits,
          history: putHistory,
        }],
      }),
    });
    assert(saved.response.ok && saved.data?.status === 'success', `legacy PUT failed: ${saved.response.status} ${JSON.stringify(saved.data)}`);

    const afterPut = await jsonRequest(`/api/projects/${projectId}`, token);
    const savedFigure = findFigure(afterPut.data?.project);
    assert(hasEdit(savedFigure?.editLog, legacyEdit), `legacy child edit was not preserved by PUT: ${JSON.stringify(savedFigure)}`);
    assert(hasEdit(savedFigure?.editLog, identityLegacyEdit), `identity-bearing legacy child edit was not preserved by PUT: ${JSON.stringify(savedFigure)}`);
    assert(savedFigure?.history?.past?.some(snapshot => hasEdit(snapshot.editLog, legacyEdit)), `legacy child edit did not enter history: ${JSON.stringify(savedFigure?.history)}`);
    const storedAfterPut = readStoredFigure(projectId);
    assert(hasEdit(parseJson(storedAfterPut.edit_log, []), legacyEdit), 'project_figures.edit_log lost the legacy child edit');
    assert(hasEdit(parseJson(storedAfterPut.edit_log, []), identityLegacyEdit), 'project_figures.edit_log lost the identity-bearing legacy child edit');
    assert(parseJson(storedAfterPut.history, { past: [] }).past.some(snapshot => hasEdit(snapshot.editLog, legacyEdit)), 'project_figures.history lost the legacy child edit');

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 200, saveToLibrary: true }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `legacy export failed: ${exported.response.status} ${JSON.stringify(exported.data)}`);
    const exportedFigure = exported.data.figures?.[0];
    const asset = exportedFigure?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `export did not create an editing snapshot: ${JSON.stringify(asset)}`);
    assert(
      typeof exportedFigure.svg === 'string' && exportedFigure.svg.includes('fill-opacity: 0.35'),
      `exported SVG does not include legacy contour child alpha state: ${JSON.stringify(exportedFigure?.warnings || [])}`,
    );
    const snapshot = readSnapshot(asset.assetId);
    assert(snapshot?.schema_version === 5, `unexpected snapshot schema: ${JSON.stringify(snapshot)}`);
    assert(hasEdit(snapshot.snapshot?.figures?.[0]?.editLog, legacyEdit), 'export snapshot did not capture legacy child alpha edit');
    assert(hasEdit(snapshot.snapshot?.figures?.[0]?.editLog, identityLegacyEdit), 'export snapshot did not capture identity-bearing legacy child edit');
    assert(
      Array.isArray(snapshot.snapshot?.figures?.[0]?.legacyReplaySignatures)
        && snapshot.snapshot.figures[0].legacyReplaySignatures.length === legacyEdits.length,
      `legacy export snapshot did not capture exact replay signatures: ${JSON.stringify(snapshot.snapshot)}`,
    );

    const laterEdit = { ...legacyEdit, value: 0.82, timestamp: 202 };
    const laterSave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Legacy contour compatibility later edit',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{
          figureId: 'fig_1',
          ...projectFigureSaveBase(savedFigure),
          revision: Number(savedFigure.revision || 1) + 1,
          editLog: [laterEdit, identityLegacyEdit],
        }],
      }),
    });
    assert(laterSave.response.ok && laterSave.data?.status === 'success', `later legacy PUT failed: ${laterSave.response.status} ${JSON.stringify(laterSave.data)}`);
    const afterLater = await jsonRequest(`/api/projects/${projectId}`, token);
    assert(hasEdit(findFigure(afterLater.data?.project)?.editLog, laterEdit), 'later legacy child edit was not persisted before restore');
    assert(hasEdit(findFigure(afterLater.data?.project)?.editLog, identityLegacyEdit), 'identity-bearing legacy child edit was lost before restore');

    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `snapshot restore failed: ${restored.response.status} ${JSON.stringify(restored.data)}`);
    assert(restored.data.targetFigureId === 'fig_1', `restore targeted wrong figure: ${JSON.stringify(restored.data)}`);

    const afterRestore = await jsonRequest(`/api/projects/${projectId}`, token);
    const restoredFigure = findFigure(afterRestore.data?.project);
    assert(hasEdit(restoredFigure?.editLog, legacyEdit), `restored editLog lost export-time legacy child alpha: ${JSON.stringify(restoredFigure)}`);
    assert(hasEdit(restoredFigure?.editLog, identityLegacyEdit), `restored editLog lost identity-bearing cross-version child edit: ${JSON.stringify(restoredFigure)}`);
    assert(!hasEdit(restoredFigure?.editLog, laterEdit), `later legacy child alpha leaked through restore: ${JSON.stringify(restoredFigure?.editLog)}`);
    const restoreCheckpoint = restoredFigure?.history?.past?.at(-1);
    assert(hasEdit(restoreCheckpoint?.editLog, laterEdit), `restore did not checkpoint later legacy child edit: ${JSON.stringify(restoredFigure?.history)}`);

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      legacyChildGid,
      assetId: asset.assetId,
      checks: [
        'isolated runner and temp DB were enforced',
        'modern contour child edit was rejected by authoritative propertyCapabilities without persistence',
        'modern v5 snapshot could not replay an unlisted legacy contour child edit',
        'legacy contour child alpha edit loaded from downgraded manifest without propertyCapabilities',
        'identity-bearing contour child edit tolerated fingerprint-only Matplotlib class drift',
        'unchanged PUT preserved the legacy edit and stored it in history',
        'export produced SVG state and an editing snapshot containing the legacy edit',
        'restore returned to the export snapshot and checkpointed the later legacy edit',
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
