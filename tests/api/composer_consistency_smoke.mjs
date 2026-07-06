/**
 * API smoke test for composer asset consistency.
 *
 * Verifies:
 * - /compose stores source asset revision snapshots in composite metadata.
 * - Composite save creates a new asset and does not mutate source assets.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 */

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith('Composer consistency smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

function svg(label, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
  <rect width="160" height="120" fill="white"/>
  <circle cx="80" cy="55" r="30" fill="${color}"/>
  <text x="80" y="105" text-anchor="middle" font-size="14">${label}</text>
</svg>`;
}

async function importAsset(projectId, figureId, revision, label, color) {
  const imported = await requestJson(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    body: JSON.stringify({
      name: `${figureId}_rev${revision}`,
      figureId,
      format: 'svg',
      svg: svg(label, color),
      thumbnailSvg: svg(label, color),
      metadata: {
        exportedFrom: figureId,
        revision,
        requestedFormat: 'svg',
      },
      tags: ['figure'],
    }),
  });
  assert(imported.status === 'success', `Import ${figureId} failed`);
  assert(imported.asset?.assetId, `Import ${figureId} did not return assetId`);
  return imported.asset;
}

async function main() {
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const created = await requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: `Composer consistency smoke ${Date.now()}`,
        spec: { plot_type: 'custom', script_language: 'python' },
      }),
    });
    assert(created.status === 'success' && created.id, 'Project creation did not return id');
    projectId = created.id;

    const sourceA = await importAsset(projectId, 'fig_1', 3, 'A', '#3366cc');
    const sourceB = await importAsset(projectId, 'fig_2', 5, 'B', '#cc6633');
    const beforeAssets = await requestJson(`/api/projects/${projectId}/export-assets`);
    const beforeSourceA = beforeAssets.assets.find((asset) => asset.assetId === sourceA.assetId);
    const beforeSourceB = beforeAssets.assets.find((asset) => asset.assetId === sourceB.assetId);

    const composed = await requestJson(`/api/projects/${projectId}/compose`, {
      method: 'POST',
      body: JSON.stringify({
        assetIds: [sourceA.assetId, sourceB.assetId],
        name: 'composite_consistency',
        layout: {
          width: 360,
          height: 160,
          panels: [
            { assetId: sourceA.assetId, x: 0, y: 30, width: 160, height: 120, label: '(a)' },
            { assetId: sourceB.assetId, x: 190, y: 30, width: 160, height: 120, label: '(b)' },
          ],
        },
      }),
    });
    assert(composed.status === 'success', `Compose failed: ${composed.message || 'unknown'}`);
    const composite = composed.asset;
    assert(composite?.assetId && composite.assetId !== sourceA.assetId && composite.assetId !== sourceB.assetId, 'Compose did not create a distinct composite asset');
    assert(composite.metadata?.kind === 'composite', 'Composite metadata.kind missing');
    assert(Array.isArray(composite.metadata?.sourceAssetSnapshots), 'Composite metadata.sourceAssetSnapshots missing');
    assert(composite.metadata.sourceAssetSnapshots.length === 2, 'Composite source snapshot count mismatch');
    assert(composite.metadata.sourceAssetRevisions[sourceA.assetId] === 3, 'Source A asset revision snapshot mismatch');
    assert(composite.metadata.sourceAssetRevisions[sourceB.assetId] === 5, 'Source B asset revision snapshot mismatch');
    assert(composite.metadata.sourceFigureRevisions.fig_1 === 3, 'fig_1 revision snapshot mismatch');
    assert(composite.metadata.sourceFigureRevisions.fig_2 === 5, 'fig_2 revision snapshot mismatch');
    assert(composite.metadata.layout.sourceAssetRevisions[sourceA.assetId] === 3, 'Layout source A revision snapshot mismatch');
    assert(composite.metadata.layout.sourceAssetRevisions[sourceB.assetId] === 5, 'Layout source B revision snapshot mismatch');

    const afterAssets = await requestJson(`/api/projects/${projectId}/export-assets`);
    const afterSourceA = afterAssets.assets.find((asset) => asset.assetId === sourceA.assetId);
    const afterSourceB = afterAssets.assets.find((asset) => asset.assetId === sourceB.assetId);
    assert(JSON.stringify(afterSourceA.metadata) === JSON.stringify(beforeSourceA.metadata), 'Source A metadata was mutated by compose');
    assert(JSON.stringify(afterSourceB.metadata) === JSON.stringify(beforeSourceB.metadata), 'Source B metadata was mutated by compose');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      compositeAssetId: composite.assetId,
      sourceAssetRevisions: composite.metadata.sourceAssetRevisions,
      sourceFigureRevisions: composite.metadata.sourceFigureRevisions,
    }, null, 2));
  } finally {
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
