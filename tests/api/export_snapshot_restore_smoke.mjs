import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { projectFigureSaveBase } from '../helpers/project_save_hash.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'snapshot restore smoke requires the isolated wrapper');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
}

function readRestoreState(projectId) {
  const databasePath = process.env.SCIFIGURE_DB_PATH;
  assert(databasePath, 'isolated snapshot smoke requires SCIFIGURE_DB_PATH');
  const database = new Database(databasePath, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const project = database.prepare(
      'SELECT id, spec, script, updated_at FROM projects WHERE id = ?',
    ).get(projectId);
    const sessions = database.prepare(`
      SELECT id, script, edit_log, revision, updated_at
      FROM sessions
      WHERE id LIKE ?
      ORDER BY id
    `).all(`${projectId}_%`);
    const figures = database.prepare(`
      SELECT figure_index, revision, edit_log, history, preview_svg, manifest,
             code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ?
      ORDER BY figure_index
    `).all(projectId);
    return JSON.stringify({ project, sessions, figures });
  } finally {
    database.close();
  }
}

async function jsonRequest(path, token, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
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

async function uploadCsv(projectId, token, fileName, contents) {
  const form = new FormData();
  form.append('file', new Blob([contents], { type: 'text/csv' }), fileName);
  const response = await fetch(`${BASE_URL}/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function register(label) {
  const result = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `export-restore-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Export-Restore-Test-Password-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed for ${label}: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const script = `
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1, 2], [1, 3, 2], color="#176b5b")
grid = np.linspace(-1.5, 1.5, 24)
x_grid, y_grid = np.meshgrid(grid, grid)
surface = np.sin(x_grid) + np.cos(y_grid)
filled = ax.contourf(
    x_grid,
    y_grid,
    surface,
    levels=[-1.5, -0.75, 0.0, 0.75, 1.5],
    cmap="viridis",
    alpha=0.8,
)
ax.contour(
    x_grid,
    y_grid,
    surface,
    levels=[-1.0, 0.0, 1.0],
    cmap="magma",
    linewidths=1.2,
)
ax.hist([0, 0.5, 1, 1, 1.5, 2], bins=[0, 0.75, 1.5, 2.25], color="#4477aa", alpha=0.45, label="Snapshot hist")
ax.stairs([0.5, 1.4, 0.8], [0, 0.75, 1.5, 2.25], color="#cc6677", label="Snapshot stairs")
ax.step([0, 0.75, 1.5, 2.25], [0.2, 1.0, 0.4, 1.2], where="mid", color="#228833", label="Snapshot step")
fig.colorbar(filled, ax=ax, label="Response")
ax.legend(loc="lower right")
ax.set_title("Export snapshot smoke")
ax.set_xlabel("Time")

fig_second, ax_second = plt.subplots(figsize=(4, 3))
ax_second.plot([0, 1, 2], [2, 1, 4], color="#2f6db0")
ax_second.set_title("Second Figure original script")
plt.show()
`;

const secondFigureScript = script.replace(
  'Second Figure original script',
  'Second Figure independent script',
);

const singleFigureScript = `
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1, 2], [2, 4, 3], color="#176b5b")
ax.set_title("Legacy snapshot dry-run")
plt.show()
`;

async function main() {
  assertIsolatedEnvironment();
  const ownerToken = await register('owner');
  const otherToken = await register('other');
  const created = await jsonRequest('/api/projects', ownerToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Export snapshot restore smoke',
      spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  let originalFileId = '';
  let legacyProjectId = null;

  try {
    const originalUpload = await uploadCsv(projectId, ownerToken, 'snapshot-data.csv', 'x,y\n0,1\n1,3\n2,2\n');
    assert(originalUpload.response.ok && originalUpload.data?.fileId, `initial data upload failed: ${JSON.stringify(originalUpload.data)}`);
    originalFileId = originalUpload.data.fileId;

    const initialRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: {}, language: 'python' }),
    });
    assert(initialRender.response.ok && initialRender.data?.status === 'success', `initial render failed: ${JSON.stringify(initialRender.data)}`);
    const figure = initialRender.data.figures?.[0];
    assert(figure?.figureId === 'fig_1', 'initial render did not create fig_1');
    assert(initialRender.data.figures?.[1]?.figureId === 'fig_2', 'initial render did not create fig_2');
    const target = figure.manifest?.objects?.find(object => (
      Array.isArray(object.editable) && object.editable.includes('color') && object.kind === 'text'
    )) || figure.manifest?.objects?.find(object => Array.isArray(object.editable) && object.editable.includes('color'));
    assert(target?.id, 'rendered manifest has no editable color target');
    const contourFill = figure.manifest?.objects?.find(object => (
      object.kind === 'contourf' && object.role === 'contourf_series'
    ));
    const contourLine = figure.manifest?.objects?.find(object => (
      object.kind === 'contour' && object.role === 'contour_series'
    ));
    const histogram = figure.manifest?.objects?.find(object => object.role === 'histogram_series');
    const stairs = figure.manifest?.objects?.find(object => object.role === 'stairs_series');
    const step = figure.manifest?.objects?.find(object => object.role === 'step_series');
    assert(contourFill?.id, 'rendered manifest has no editable contourf target');
    assert(contourLine?.id, 'rendered manifest has no editable contour target');
    assert(histogram?.kind === 'bar_container', 'rendered manifest has no historical-kind histogram target');
    assert(stairs?.kind === 'patch', 'rendered manifest has no historical-kind stairs target');
    assert(step?.kind === 'line', 'rendered manifest has no historical-kind step target');

    const exportedEdit = {
      gid: target.id,
      prop: 'color',
      value: '#b42318',
      mode: 'backend_patch',
      timestamp: 100,
    };
    const exportedContourAlphaEdit = {
      gid: contourFill.id,
      prop: 'alpha',
      value: 0.35,
      mode: 'backend_patch',
      timestamp: 101,
    };
    const exportedContourVmaxEdit = {
      gid: contourFill.id,
      prop: 'vmax',
      value: 1.25,
      mode: 'backend_patch',
      timestamp: 102,
    };
    const exportedContourLineWidthEdit = {
      gid: contourLine.id,
      prop: 'linewidth',
      value: 2.4,
      mode: 'backend_patch',
      timestamp: 103,
    };
    const exportedHistogramEdit = {
      gid: histogram.id,
      prop: 'facecolor',
      value: '#6f42c1',
      mode: 'local_patch',
      timestamp: 104,
    };
    const exportedStairsEdit = {
      gid: stairs.id,
      prop: 'edgecolor',
      value: '#d97706',
      mode: 'local_patch',
      timestamp: 105,
    };
    const exportedStepEdit = {
      gid: step.id,
      prop: 'color',
      value: '#0e7490',
      mode: 'local_patch',
      timestamp: 106,
    };
    const editedRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        script,
        editLogs: {
          fig_1: [
            exportedEdit,
            exportedContourAlphaEdit,
            exportedContourVmaxEdit,
            exportedContourLineWidthEdit,
            exportedHistogramEdit,
            exportedStairsEdit,
            exportedStepEdit,
          ],
        },
        language: 'python',
      }),
    });
    assert(editedRender.response.ok && editedRender.data?.status === 'success', `edited render failed: ${JSON.stringify(editedRender.data)}`);
    const editedFigure = editedRender.data.figures?.find(item => item.figureId === 'fig_1');
    assert(editedFigure, 'edited render did not return fig_1 state');

    const databasePath = process.env.SCIFIGURE_DB_PATH;
    assert(databasePath, 'isolated snapshot smoke requires SCIFIGURE_DB_PATH');
    const beforeExportDb = new Database(databasePath);
    try {
      beforeExportDb.pragma('busy_timeout = 5000');
      beforeExportDb.prepare('UPDATE sessions SET script = ? WHERE id = ?').run(
        secondFigureScript,
        `${projectId}_fig_2`,
      );
      const missingPath = path.relative(
        process.cwd(),
        path.join(process.env.SCIFIGURE_DATA_DIR, 'projects', projectId, 'files', 'missing-unrelated.csv'),
      ).replace(/\\/g, '/');
      beforeExportDb.prepare(`
        INSERT INTO project_files (id, project_id, original_name, stored_path, columns, row_count, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `missing-${projectId}`,
        projectId,
        'missing-unrelated.csv',
        missingPath,
        JSON.stringify(['unused']),
        0,
        '2099-01-01 00:00:00',
      );
    } finally {
      beforeExportDb.close();
    }

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `export failed: ${JSON.stringify(exported.data)}`);
    const asset = exported.data.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `export did not persist a restorable snapshot: ${JSON.stringify(asset)}`);
    assert(
      typeof exported.data.figures?.[0]?.svg === 'string' && exported.data.figures[0].svg.includes('fill-opacity: 0.35'),
      `exported SVG does not contain the export-time contourf alpha style: ${JSON.stringify(exported.data.figures?.[0]?.warnings || [])}`,
    );
    const exportedSvg = String(exported.data.figures?.[0]?.svg || '').toLowerCase();
    for (const color of ['#6f42c1', '#d97706', '#0e7490']) {
      assert(exportedSvg.includes(color), `exported SVG does not contain WP6 export-time color ${color}`);
    }
    assert(
      asset.metadata?.snapshotWarnings?.some(message => message.includes('missing-unrelated.csv')),
      `unrelated missing data record was not reported without blocking export: ${JSON.stringify(asset.metadata)}`,
    );

    const postExportEdit = {
      gid: target.id,
      prop: 'fontsize',
      value: 21,
      mode: 'backend_patch',
      timestamp: 200,
    };
    const postExportContourAlphaEdit = {
      gid: contourFill.id,
      prop: 'alpha',
      value: 0.9,
      mode: 'backend_patch',
      timestamp: 201,
    };
    const postExportContourLineWidthEdit = {
      gid: contourLine.id,
      prop: 'linewidth',
      value: 0.7,
      mode: 'backend_patch',
      timestamp: 202,
    };
    const postExportHistogramEdit = {
      gid: histogram.id,
      prop: 'facecolor',
      value: '#111111',
      mode: 'local_patch',
      timestamp: 203,
    };
    const postExportStairsEdit = {
      gid: stairs.id,
      prop: 'edgecolor',
      value: '#222222',
      mode: 'local_patch',
      timestamp: 204,
    };
    const postExportStepEdit = {
      gid: step.id,
      prop: 'color',
      value: '#333333',
      mode: 'local_patch',
      timestamp: 205,
    };
    const updated = await jsonRequest(`/api/projects/${projectId}`, ownerToken, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Export snapshot restore smoke',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{
          figureId: 'fig_1',
          ...projectFigureSaveBase(editedFigure),
          editLog: [
            postExportEdit,
            postExportContourAlphaEdit,
            postExportContourLineWidthEdit,
            postExportHistogramEdit,
            postExportStairsEdit,
            postExportStepEdit,
          ],
          revision: 2,
        }],
      }),
    });
    assert(updated.response.ok, `post-export edit persistence failed: ${JSON.stringify(updated.data)}`);

    const changedScript = script.replace('Export snapshot smoke', 'Changed after export');
    const afterExportDb = new Database(databasePath);
    try {
      afterExportDb.pragma('busy_timeout = 5000');
      afterExportDb.prepare('UPDATE sessions SET script = ? WHERE id = ?').run(changedScript, `${projectId}_fig_1`);
      afterExportDb.prepare('UPDATE sessions SET script = ? WHERE id = ?').run(changedScript, `${projectId}_fig_2`);
    } finally {
      afterExportDb.close();
    }

    const snapshotDb = new Database(databasePath);
    let originalSnapshotJson;
    let originalSnapshotHash;
    try {
      snapshotDb.pragma('busy_timeout = 5000');
      const stored = snapshotDb.prepare(`
        SELECT snapshot_json, snapshot_hash
        FROM export_asset_snapshots
        WHERE asset_id = ?
      `).get(asset.assetId);
      assert(stored?.snapshot_json && stored?.snapshot_hash, 'export snapshot row is missing');
      originalSnapshotJson = stored.snapshot_json;
      originalSnapshotHash = stored.snapshot_hash;
      const tampered = JSON.parse(stored.snapshot_json);
      tampered.figures[0].editLog = [
        ...(tampered.figures[0].editLog || []),
        {
          gid: 'missing.snapshot.gid',
          prop: 'color',
          value: '#ff00aa',
          mode: 'backend_patch',
          timestamp: 999,
        },
      ];
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

    const beforeRejectedRestore = readRestoreState(projectId);
    const rejectedRestore = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      ownerToken,
      { method: 'POST' },
    );
    assert(
      rejectedRestore.response.status === 409
        && rejectedRestore.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `tampered snapshot should fail renderer dry-run: ${JSON.stringify(rejectedRestore.data)}`,
    );
    assert(
      readRestoreState(projectId) === beforeRejectedRestore,
      'rejected snapshot restore changed project, session, history, or preview state',
    );

    const restoreSnapshotDb = new Database(databasePath);
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

    const denied = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, otherToken, { method: 'POST' });
    assert(denied.response.status === 404, `other user restore should be hidden with 404, got ${denied.response.status}`);

    const slowScript = `import time\ntime.sleep(1.5)\n${script}`;
    const slowRenderPromise = jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        script: slowScript,
        editLogs: {
          fig_1: [postExportEdit, postExportContourAlphaEdit, postExportContourLineWidthEdit],
        },
        language: 'python',
      }),
    });
    await delay(150);
    const restorePromise = jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, ownerToken, { method: 'POST' });
    await delay(150);
    const blockedRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: { fig_1: [postExportEdit] }, language: 'python' }),
    });
    assert(
      blockedRender.response.status === 409 && blockedRender.data?.code === 'PROJECT_STATE_BUSY',
      `new render should be blocked during restore: ${JSON.stringify(blockedRender.data)}`,
    );
    const slowRender = await slowRenderPromise;
    assert(slowRender.response.ok && slowRender.data?.status === 'success', `slow render failed: ${JSON.stringify(slowRender.data)}`);
    const restored = await restorePromise;
    assert(restored.response.ok && restored.data?.status === 'success', `snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data.targetFigureId === 'fig_1', 'restore returned the wrong target Figure');

    const projectAfterRestore = await jsonRequest(`/api/projects/${projectId}`, ownerToken);
    const restoredFigure = projectAfterRestore.data?.project?.figures?.find(item => item.figureId === 'fig_1');
    assert(restoredFigure, 'restored Figure is missing from project load');
    assert(restoredFigure.editLog.some(entry => entry.gid === target.id && entry.prop === 'color' && entry.value === '#b42318'), 'export-time edit is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'export-time contourf alpha is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'export-time contourf vmax is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === contourLine.id && entry.prop === 'linewidth' && Number(entry.value) === 2.4), 'export-time contour linewidth is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === histogram.id && entry.prop === 'facecolor' && entry.value === '#6f42c1'), 'export-time histogram style is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === stairs.id && entry.prop === 'edgecolor' && entry.value === '#d97706'), 'export-time stairs style is missing after restore');
    assert(restoredFigure.editLog.some(entry => entry.gid === step.id && entry.prop === 'color' && entry.value === '#0e7490'), 'export-time step style is missing after restore');
    assert(!restoredFigure.editLog.some(entry => entry.gid === target.id && entry.prop === 'fontsize' && entry.value === 21), 'post-export edit leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.9), 'post-export contourf alpha leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === contourLine.id && entry.prop === 'linewidth' && Number(entry.value) === 0.7), 'post-export contour linewidth leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === histogram.id && entry.prop === 'facecolor' && entry.value === '#111111'), 'post-export histogram style leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === stairs.id && entry.prop === 'edgecolor' && entry.value === '#222222'), 'post-export stairs style leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === step.id && entry.prop === 'color' && entry.value === '#333333'), 'post-export step style leaked into restored state');
    const checkpoint = restoredFigure.history?.past?.at(-1);
    assert(checkpoint?.editLog?.some(entry => entry.gid === target.id && entry.prop === 'fontsize' && entry.value === 21), 'restore did not save the current state as a history checkpoint');
    assert(checkpoint?.editLog?.some(entry => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.9), 'restore checkpoint did not preserve the newer contourf style');
    assert(checkpoint?.editLog?.some(entry => entry.gid === histogram.id && entry.prop === 'facecolor' && entry.value === '#111111'), 'restore checkpoint did not preserve the newer histogram style');
    assert(checkpoint?.editLog?.some(entry => entry.gid === stairs.id && entry.prop === 'edgecolor' && entry.value === '#222222'), 'restore checkpoint did not preserve the newer stairs style');
    assert(checkpoint?.editLog?.some(entry => entry.gid === step.id && entry.prop === 'color' && entry.value === '#333333'), 'restore checkpoint did not preserve the newer step style');

    const restoredDb = new Database(databasePath, { readonly: true });
    try {
      const restoredScripts = restoredDb.prepare(`
        SELECT id, script FROM sessions WHERE id IN (?, ?) ORDER BY id
      `).all(`${projectId}_fig_1`, `${projectId}_fig_2`);
      const scriptsById = Object.fromEntries(restoredScripts.map(row => [row.id, row.script]));
      assert(scriptsById[`${projectId}_fig_1`] === script, 'fig_1 did not restore its own export-time script');
      assert(
        scriptsById[`${projectId}_fig_2`] === secondFigureScript,
        'fig_2 was overwritten with the target Figure script instead of its own script',
      );
      const restoredPreviewRows = restoredDb.prepare(`
        SELECT figure_index, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
        FROM project_figures
        WHERE project_id = ?
        ORDER BY figure_index
      `).all(projectId);
      assert(
        restoredPreviewRows.every(row => (
          row.preview_svg === null
          && row.manifest === null
          && row.code_slice === null
          && row.fingerprint === null
          && row.preview_updated_at === null
        )),
        'restore retained a stale preview or manifest instead of invalidating it',
      );
    } finally {
      restoredDb.close();
    }

    const regenerated = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, ownerToken);
    assert(
      regenerated.response.ok && regenerated.data?.status === 'success',
      `restored preview regeneration failed: ${JSON.stringify(regenerated.data)}`,
    );
    const regeneratedFigure = regenerated.data.figures?.find(item => item.figureId === 'fig_1');
    assert(regeneratedFigure?.previewSource === 'rendered', 'restore reused a stale cached preview');
    assert(
      typeof regeneratedFigure.svg === 'string' && regeneratedFigure.svg.toLowerCase().includes('#b42318'),
      'regenerated preview does not contain the export-time color edit',
    );
    assert(
      typeof regeneratedFigure.svg === 'string' && regeneratedFigure.svg.includes('fill-opacity: 0.35'),
      'regenerated preview does not contain the export-time contourf alpha style',
    );
    const regeneratedSvg = String(regeneratedFigure.svg || '').toLowerCase();
    for (const color of ['#6f42c1', '#d97706', '#0e7490']) {
      assert(regeneratedSvg.includes(color), `regenerated preview does not contain WP6 export-time color ${color}`);
    }
    for (const color of ['#111111', '#222222', '#333333']) {
      assert(!regeneratedSvg.includes(color), `regenerated preview leaked WP6 post-export color ${color}`);
    }
    assert(
      !regeneratedFigure.svg.includes('Changed after export'),
      'regenerated preview still contains the post-export script state',
    );

    const extraUpload = await uploadCsv(projectId, ownerToken, 'snapshot-data.csv', 'x,y\n0,9\n1,8\n');
    assert(extraUpload.response.ok && extraUpload.data?.fileId, `same-name extra upload failed: ${JSON.stringify(extraUpload.data)}`);
    const mismatchedRestore = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, ownerToken, { method: 'POST' });
    assert(
      mismatchedRestore.response.status === 409
        && mismatchedRestore.data?.code === 'EXPORT_SNAPSHOT_DATA_MISMATCH'
        && mismatchedRestore.data?.issues?.some(issue => String(issue).includes('导出后新增')),
      `restore should reject an extra same-name dataset: ${JSON.stringify(mismatchedRestore.data)}`,
    );
    const extraDeleted = await jsonRequest(`/api/projects/${projectId}/files/${extraUpload.data.fileId}`, ownerToken, { method: 'DELETE' });
    assert(extraDeleted.response.ok, `extra data cleanup failed: ${JSON.stringify(extraDeleted.data)}`);

    const imported = await jsonRequest(`/api/projects/${projectId}/export-assets/import`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'composite',
        name: 'legacy imported asset',
        format: 'svg',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="white"/></svg>',
      }),
    });
    assert(imported.response.ok && imported.data?.asset?.assetId, `legacy asset import failed: ${JSON.stringify(imported.data)}`);
    const legacyRestore = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${imported.data.asset.assetId}/restore`,
      ownerToken,
      { method: 'POST' },
    );
    assert(
      legacyRestore.response.status === 409 && legacyRestore.data?.code === 'EXPORT_SNAPSHOT_UNAVAILABLE',
      `legacy asset should remain downloadable but not restorable: ${JSON.stringify(legacyRestore.data)}`,
    );

    const legacyProject = await jsonRequest('/api/projects', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Legacy v1 snapshot restore smoke',
        spec: { plot_type: 'custom', custom_script: singleFigureScript, script_language: 'python' },
      }),
    });
    assert(legacyProject.response.ok && legacyProject.data?.id, `legacy project creation failed: ${JSON.stringify(legacyProject.data)}`);
    legacyProjectId = legacyProject.data.id;
    const legacyRender = await jsonRequest(`/api/projects/${legacyProjectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ script: singleFigureScript, editLogs: {}, language: 'python' }),
    });
    assert(legacyRender.response.ok && legacyRender.data?.status === 'success', `legacy project render failed: ${JSON.stringify(legacyRender.data)}`);
    const legacyExport = await jsonRequest(`/api/projects/${legacyProjectId}/export`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    const legacySnapshotAsset = legacyExport.data?.figures?.[0]?.asset;
    assert(legacyExport.response.ok && legacySnapshotAsset?.assetId, `legacy fixture export failed: ${JSON.stringify(legacyExport.data)}`);

    const legacySnapshotDb = new Database(databasePath);
    try {
      legacySnapshotDb.pragma('busy_timeout = 5000');
      const stored = legacySnapshotDb.prepare(`
        SELECT snapshot_json FROM export_asset_snapshots WHERE asset_id = ?
      `).get(legacySnapshotAsset.assetId);
      assert(stored?.snapshot_json, 'legacy fixture snapshot is missing');
      const legacyV1 = JSON.parse(stored.snapshot_json);
      legacyV1.schemaVersion = 1;
      legacyV1.figures = legacyV1.figures.map(({ script: _script, scriptLanguage: _language, ...figure }) => figure);
      const legacyV1Json = JSON.stringify(legacyV1);
      legacySnapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET schema_version = 1, snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(
        legacyV1Json,
        crypto.createHash('sha256').update(legacyV1Json).digest('hex'),
        legacySnapshotAsset.assetId,
      );
    } finally {
      legacySnapshotDb.close();
    }
    const legacyV1Restore = await jsonRequest(
      `/api/projects/${legacyProjectId}/export-assets/${legacySnapshotAsset.assetId}/restore`,
      ownerToken,
      { method: 'POST' },
    );
    assert(
      legacyV1Restore.response.ok && legacyV1Restore.data?.status === 'success',
      `single-Figure v1 snapshot should remain restorable: ${JSON.stringify(legacyV1Restore.data)}`,
    );

    const slowSession = await jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ script: slowScript, editLogs: { fig_1: [exportedEdit] }, language: 'python' }),
    });
    assert(slowSession.response.ok && slowSession.data?.status === 'success', `slow export fixture render failed: ${JSON.stringify(slowSession.data)}`);
    const slowExportPromise = jsonRequest(`/api/projects/${projectId}/export`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
    });
    await delay(150);
    const blockedUpload = await uploadCsv(projectId, ownerToken, 'during-export.csv', 'x,y\n0,4\n');
    assert(
      blockedUpload.response.status === 409 && blockedUpload.data?.code === 'PROJECT_STATE_BUSY',
      `data upload should be blocked during export: ${JSON.stringify(blockedUpload.data)}`,
    );
    const blockedDelete = await jsonRequest(`/api/projects/${projectId}/files/${originalFileId}`, ownerToken, { method: 'DELETE' });
    assert(
      blockedDelete.response.status === 409 && blockedDelete.data?.code === 'PROJECT_STATE_BUSY',
      `data deletion should be blocked during export: ${JSON.stringify(blockedDelete.data)}`,
    );
    const slowExport = await slowExportPromise;
    assert(slowExport.response.ok && slowExport.data?.status === 'success', `slow export failed: ${JSON.stringify(slowExport.data)}`);
    const originalDeleted = await jsonRequest(`/api/projects/${projectId}/files/${originalFileId}`, ownerToken, { method: 'DELETE' });
    assert(originalDeleted.response.ok, `data deletion after export failed: ${JSON.stringify(originalDeleted.data)}`);

    console.log('PASS project export stores an immutable editing-state snapshot');
    console.log('PASS restore reinstates export-time edits and checkpoints the newer state');
    console.log('PASS restore drains an in-flight render and blocks new project mutations');
    console.log('PASS restore rejects extra same-name datasets and export blocks concurrent upload/deletion');
    console.log('PASS contour and contourf export-time styles survive snapshot restore');
    console.log('PASS hist, stairs, and step export-time styles survive snapshot restore');
    console.log('PASS multi-Figure restore preserves each Figure script independently');
    console.log('PASS restore invalidates stale previews and regenerates the export-time visual state');
    console.log('PASS unrelated missing data records warn without blocking export');
    console.log('PASS restore enforces ownership and keeps legacy assets compatible');
    console.log('PASS single-Figure schema v1 snapshots remain restorable through dry-run');
  } finally {
    if (legacyProjectId) {
      await jsonRequest(`/api/projects/${legacyProjectId}`, ownerToken, { method: 'DELETE' }).catch(() => null);
    }
    await jsonRequest(`/api/projects/${projectId}`, ownerToken, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
