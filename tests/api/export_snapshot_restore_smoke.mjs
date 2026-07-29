const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
fig.colorbar(filled, ax=ax, label="Response")
ax.set_title("Export snapshot smoke")
ax.set_xlabel("Time")
plt.show()
`;

async function main() {
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
    assert(contourFill?.id, 'rendered manifest has no editable contourf target');
    assert(contourLine?.id, 'rendered manifest has no editable contour target');

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
    const editedRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        script,
        editLogs: { fig_1: [exportedEdit, exportedContourAlphaEdit, exportedContourVmaxEdit, exportedContourLineWidthEdit] },
        language: 'python',
      }),
    });
    assert(editedRender.response.ok && editedRender.data?.status === 'success', `edited render failed: ${JSON.stringify(editedRender.data)}`);

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
    const updated = await jsonRequest(`/api/projects/${projectId}`, ownerToken, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Export snapshot restore smoke',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
        figures: [{ figureId: 'fig_1', editLog: [postExportEdit, postExportContourAlphaEdit, postExportContourLineWidthEdit], revision: 2 }],
      }),
    });
    assert(updated.response.ok, `post-export edit persistence failed: ${JSON.stringify(updated.data)}`);

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
    assert(!restoredFigure.editLog.some(entry => entry.gid === target.id && entry.prop === 'fontsize' && entry.value === 21), 'post-export edit leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.9), 'post-export contourf alpha leaked into restored state');
    assert(!restoredFigure.editLog.some(entry => entry.gid === contourLine.id && entry.prop === 'linewidth' && Number(entry.value) === 0.7), 'post-export contour linewidth leaked into restored state');
    const checkpoint = restoredFigure.history?.past?.at(-1);
    assert(checkpoint?.editLog?.some(entry => entry.gid === target.id && entry.prop === 'fontsize' && entry.value === 21), 'restore did not save the current state as a history checkpoint');
    assert(checkpoint?.editLog?.some(entry => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.9), 'restore checkpoint did not preserve the newer contourf style');

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
    console.log('PASS restore enforces ownership and keeps legacy assets compatible');
  } finally {
    await jsonRequest(`/api/projects/${projectId}`, ownerToken, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
