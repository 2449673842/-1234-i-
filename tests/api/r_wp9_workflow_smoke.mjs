import Database from 'better-sqlite3';
import path from 'node:path';
import { projectFigureSaveBase } from '../helpers/project_save_hash.mjs';

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
      email: `r-wp9-workflow-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP9-Workflow-Smoke-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

async function uploadCsv(token, projectId, fileName, csv) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), fileName);
  const response = await fetch(`${BASE_URL}/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => null);
  assert(response.ok && data?.fileId, `multipart CSV upload failed for ${fileName}: ${JSON.stringify(data)}`);
  assert(data.fileName === fileName, `upload response renamed ${fileName}: ${JSON.stringify(data)}`);
  return data;
}

function openReadonlyDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function readExportSnapshot(assetId) {
  const db = openReadonlyDb();
  try {
    const row = db.prepare(`
      SELECT schema_version, snapshot_json
      FROM export_asset_snapshots
      WHERE asset_id = ?
    `).get(assetId);
    assert(row?.snapshot_json, `export snapshot is missing for asset ${assetId}`);
    return {
      schemaVersion: Number(row.schema_version),
      snapshot: JSON.parse(row.snapshot_json),
    };
  } finally {
    db.close();
  }
}

function readPersistedFigure(projectId) {
  const db = openReadonlyDb();
  try {
    const row = db.prepare(`
      SELECT revision, edit_log, history, preview_svg, manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    assert(row, `project figure row missing for ${projectId}`);
    return {
      revision: Number(row.revision),
      editLog: parseJson(row.edit_log, []),
      history: parseJson(row.history, { past: [], future: [] }),
      previewSvg: row.preview_svg,
      manifest: parseJson(row.manifest, null),
    };
  } finally {
    db.close();
  }
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: JSON.parse(JSON.stringify(object.identity)) } : {}),
  };
}

function samePatch(left, right) {
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function assertHasPatch(editLog, patch, message) {
  assert(Array.isArray(editLog) && editLog.some(entry => samePatch(entry, patch)), message);
}

function assertMissingPatch(editLog, patch, message) {
  assert(!Array.isArray(editLog) || !editLog.some(entry => samePatch(entry, patch)), message);
}

function findColorPatchTarget(manifest) {
  const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
  const group = objects.find(object => (
    String(object?.id || '').startsWith('r.group.color.')
    && Array.isArray(object.editable)
    && object.editable.includes('color')
  ));
  const capable = objects.find(object => (
    Array.isArray(object?.propertyCapabilities)
    && object.propertyCapabilities.some(capability => (
      capability?.prop === 'color'
      && capability?.replay !== 'unsupported'
    ))
  ));
  const editable = objects.find(object => Array.isArray(object?.editable) && object.editable.includes('color'));
  const object = group || capable || editable;
  assert(object?.id, `R manifest did not expose a legal color backend patch target: ${JSON.stringify(manifest)}`);
  return object;
}

function makeColorPatch(object, value) {
  return {
    op: 'set',
    mode: 'backend_patch',
    gid: object.id,
    prop: 'color',
    value,
    ...identityFields(object),
  };
}

function bufferFromResponse(format, figure) {
  if (format === 'svg') return Buffer.from(String(figure?.svg || ''), 'utf8');
  return Buffer.from(String(figure?.binary_b64 || ''), 'base64');
}

function assertMagic(format, buffer, label) {
  if (format === 'svg') {
    assert(buffer.toString('utf8').includes('<svg'), `${label} SVG payload is invalid`);
    return;
  }
  if (format === 'png') {
    assert(buffer.length > 8 && buffer.subarray(0, 4).toString('hex') === '89504e47', `${label} PNG magic is invalid`);
    return;
  }
  if (format === 'pdf') {
    assert(buffer.length > 8 && buffer.subarray(0, 4).toString('ascii') === '%PDF', `${label} PDF magic is invalid`);
    return;
  }
  if (format === 'tiff') {
    const header = buffer.subarray(0, 4).toString('hex');
    assert(buffer.length > 8 && (header === '49492a00' || header === '4d4d002a'), `${label} TIFF magic is invalid`);
    return;
  }
  throw new Error(`unsupported format ${format}`);
}

async function downloadAsset(token, projectId, assetId) {
  const response = await fetch(`${BASE_URL}/api/projects/${projectId}/export-assets/${assetId}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  assert(response.ok && buffer.length > 0, `asset download failed for ${assetId}: ${response.status}`);
  return buffer;
}

async function submitPatch(token, projectId, patch, baseRevision, label) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-wp9-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches: [patch],
    }),
  });
}

const primaryCsv = [
  'sample,dose,response,treatment',
  's1,1,2.0,baseline',
  's2,2,3.0,baseline',
  's3,3,5.0,treatment',
].join('\n');

const secondaryCsv = [
  'sample,adjustment',
  's1,10',
  's2,20',
  's3,30',
].join('\n');

const rScript = [
  'library(ggplot2)',
  'primary <- read.csv(uploaded_file_paths[["r_wp9_primary.csv"]], check.names = FALSE)',
  'secondary <- read.csv(uploaded_file_paths[["r_wp9_secondary.csv"]], check.names = FALSE)',
  'plot_data <- merge(primary, secondary, by = "sample")',
  'plot_data$response_adj <- plot_data$response + plot_data$adjustment / 10',
  'p <- ggplot(plot_data, aes(x = dose, y = response_adj, color = treatment, group = treatment)) +',
  '  geom_line(linewidth = 0.9) +',
  '  geom_point(size = 2.8) +',
  '  geom_text(aes(label = sample), vjust = -0.8, size = 3) +',
  '  labs(',
  '    title = sprintf("R-WP9 exact upload sums: %.1f / %.0f", sum(primary$response), sum(secondary$adjustment)),',
  '    x = "Dose",',
  '    y = "Adjusted response",',
  '    color = "Treatment"',
  '  ) +',
  '  theme_classic(base_family = "sans")',
  'p',
].join('\n');

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;

  try {
    const created = await jsonRequest('/api/projects', token, {
      method: 'POST',
      body: JSON.stringify({
        name: `R-WP9 isolated workflow ${Date.now()}`,
        spec: {
          plot_type: 'custom',
          custom_script: rScript,
          script: rScript,
          script_language: 'r',
          figure: { width: 120, height: 90, unit: 'mm', dpi: 300 },
        },
      }),
    });
    assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
    projectId = created.data.id;

    await uploadCsv(token, projectId, 'r_wp9_primary.csv', primaryCsv);
    await uploadCsv(token, projectId, 'r_wp9_secondary.csv', secondaryCsv);

    const files = await jsonRequest(`/api/projects/${projectId}/files`, token);
    assert(files.response.ok && files.data?.datasets?.length === 2, `project files list is wrong: ${JSON.stringify(files.data)}`);
    assert(files.data.datasets.some(dataset => dataset.fileName === 'r_wp9_primary.csv'), 'primary CSV was not persisted as a project file');
    assert(files.data.datasets.some(dataset => dataset.fileName === 'r_wp9_secondary.csv'), 'secondary CSV was not persisted as a project file');

    const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script: rScript,
        editLogs: { fig_1: [] },
        language: 'r',
        requestId: `r-wp9-initial-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    });
    assert(rendered.response.ok && rendered.data?.status === 'success', `initial R render failed: ${JSON.stringify(rendered.data)}`);
    const figure = rendered.data.figures?.find(item => item.figureId === 'fig_1');
    assert(figure?.manifest?.objects?.length > 0, `initial R render returned no manifest: ${JSON.stringify(rendered.data)}`);
    assert(String(figure.svg || '').includes('R-WP9 exact upload sums: 10.0 / 60'), 'R script did not read both uploaded CSV files by exact uploaded_file_paths names');

    const colorTarget = findColorPatchTarget(figure.manifest);
    let revision = Number(figure.revision || 1);
    const exportPatch = makeColorPatch(colorTarget, '#0072B2');
    const patched = await submitPatch(token, projectId, exportPatch, revision, 'export-time-color');
    assert(patched.response.ok && patched.data?.status === 'success', `legal R backend patch failed: ${JSON.stringify(patched.data)}`);
    assert(Number(patched.data.revision) === revision + 1, `R backend patch did not increment revision exactly once: ${JSON.stringify(patched.data)}`);
    assertHasPatch(patched.data.editLog, exportPatch, 'patch response editLog omitted the backend patch');
    revision += 1;

    const refreshed = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(refreshed.response.ok && refreshed.data?.status === 'success', `refresh after patch failed: ${JSON.stringify(refreshed.data)}`);
    const refreshedFigure = refreshed.data.figures?.find(item => item.figureId === 'fig_1');
    assert(Number(refreshedFigure?.revision || 0) === revision, `refresh did not preserve patch revision ${revision}: ${JSON.stringify(refreshedFigure)}`);
    assertHasPatch(refreshedFigure?.editLog, exportPatch, 'refresh did not preserve the backend patch editLog');
    assert(String(refreshedFigure?.svg || '').toLowerCase().includes('#0072b2'), 'refresh preview did not preserve the backend color patch');
    const persistedAfterPatch = readPersistedFigure(projectId);
    assert(Number(persistedAfterPatch.revision) === revision, 'persisted figure revision drifted after one backend patch');
    assert(persistedAfterPatch.previewSvg && persistedAfterPatch.manifest, 'backend patch did not refresh persisted preview/manifest');

    const exportedByFormat = {};
    for (const format of ['svg', 'png', 'pdf', 'tiff']) {
      const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
        method: 'POST',
        body: JSON.stringify({
          figureId: 'fig_1',
          format,
          dpi: 180,
          name: `r-wp9-${format}`,
          saveToLibrary: true,
        }),
      });
      assert(exported.response.ok && exported.data?.status === 'success', `${format} export failed: ${JSON.stringify(exported.data)}`);
      const exportedFigure = exported.data.figures?.[0];
      const asset = exportedFigure?.asset;
      assert(exportedFigure?.figureId === 'fig_1', `${format} export returned the wrong figure: ${JSON.stringify(exportedFigure)}`);
      assert(asset?.assetId && asset.format === format && asset.hasEditingSnapshot === true, `${format} export did not create a restorable asset: ${JSON.stringify(asset)}`);
      assert(Number(asset.metadata?.revision || 0) === revision, `${format} asset metadata revision drifted: ${JSON.stringify(asset.metadata)}`);
      assertMagic(format, bufferFromResponse(format, exportedFigure), `${format} response`);
      assertMagic(format, await downloadAsset(token, projectId, asset.assetId), `${format} asset file`);

      const storedSnapshot = readExportSnapshot(asset.assetId);
      assert(storedSnapshot.schemaVersion >= 1, `${format} snapshot schema is invalid: ${storedSnapshot.schemaVersion}`);
      assert(storedSnapshot.snapshot?.projectId === projectId, `${format} snapshot projectId mismatch`);
      assert(storedSnapshot.snapshot?.targetFigureId === 'fig_1', `${format} snapshot targetFigureId mismatch`);
      assertHasPatch(storedSnapshot.snapshot?.figures?.[0]?.editLog, exportPatch, `${format} snapshot omitted export-time patch`);
      const datasetNames = (storedSnapshot.snapshot?.datasets || []).map(dataset => dataset.fileName).sort();
      assert(
        JSON.stringify(datasetNames) === JSON.stringify(['r_wp9_primary.csv', 'r_wp9_secondary.csv']),
        `${format} snapshot did not capture exactly the two uploaded CSV files: ${JSON.stringify(datasetNames)}`,
      );
      exportedByFormat[format] = { exported, asset, snapshot: storedSnapshot };
    }

    const postExportPatch = makeColorPatch(colorTarget, '#D55E00');
    const postExport = await submitPatch(token, projectId, postExportPatch, revision, 'post-export-color');
    assert(postExport.response.ok && postExport.data?.status === 'success', `post-export R edit failed: ${JSON.stringify(postExport.data)}`);
    assert(Number(postExport.data.revision) === revision + 1, `post-export edit did not increment revision exactly once: ${JSON.stringify(postExport.data)}`);
    assertHasPatch(postExport.data.editLog, postExportPatch, 'post-export editLog omitted newer patch');
    revision += 1;

    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${exportedByFormat.svg.asset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data.targetFigureId === 'fig_1', 'restore returned the wrong target figure');
    assert(Number(restored.data.restoredRevisions?.fig_1 || 0) === revision + 1, `restore revision should increment from newer state: ${JSON.stringify(restored.data)}`);

    const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
    assert(loaded.response.ok && loaded.data?.status === 'success', `project reload after restore failed: ${JSON.stringify(loaded.data)}`);
    const restoredFigure = loaded.data.project?.figures?.find(item => item.figureId === 'fig_1');
    assert(restoredFigure, 'restored project did not include fig_1');
    assertHasPatch(restoredFigure.editLog, exportPatch, 'restored state does not contain the export-time patch');
    assertMissingPatch(restoredFigure.editLog, postExportPatch, 'post-export patch leaked into restored editLog');
    const checkpoint = restoredFigure.history?.past?.at(-1);
    assert(checkpoint?.changeType === 'system', `restore did not append a system history checkpoint: ${JSON.stringify(restoredFigure.history)}`);
    assertHasPatch(checkpoint.editLog, postExportPatch, 'restore checkpoint did not preserve the pre-restore newer edit state');

    const regenerated = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1&forcePreview=1`, token);
    assert(regenerated.response.ok && regenerated.data?.status === 'success', `preview regeneration after restore failed: ${JSON.stringify(regenerated.data)}`);
    const regeneratedFigure = regenerated.data.figures?.find(item => item.figureId === 'fig_1');
    assert(String(regeneratedFigure?.svg || '').toLowerCase().includes('#0072b2'), 'restored preview did not show export-time color');
    assert(!String(regeneratedFigure?.svg || '').toLowerCase().includes('#d55e00'), 'restored preview leaked post-export color');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      exportedAssetIds: Object.fromEntries(Object.entries(exportedByFormat).map(([format, value]) => [format, value.asset.assetId])),
      checked: [
        'isolated wrapper and non-3000/non-data guard',
        'real project creation and two multipart CSV uploads',
        'R script reads both CSV files by exact uploaded_file_paths names',
        'one legal R backend patch increments revision exactly once and survives refresh',
        'SVG/PNG/PDF/TIFF response magic, asset download magic, and export snapshots',
        'post-export edit is checkpointed when restoring the export-time snapshot',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
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
