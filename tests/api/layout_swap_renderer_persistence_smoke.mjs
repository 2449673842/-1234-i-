import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  '',
  'fig = plt.figure(figsize=(7.0, 3.2))',
  'left = fig.add_axes([0.08, 0.18, 0.36, 0.70])',
  'right = fig.add_axes([0.56, 0.18, 0.36, 0.70])',
  'left.plot([0, 1, 2], [1, 3, 2], color="#176b5b", label="left")',
  'right.scatter([0, 1, 2], [2, 1, 3], color="#c94838", label="right")',
  'left.set_title("Left panel")',
  'right.set_title("Right panel")',
].join('\n');

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

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must use the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target 127.0.0.1, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000');

  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated data and database paths are required');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(
    path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'),
    `test refuses non-isolated data dir: ${resolvedDataDir}`,
  );
  assert(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `database escaped isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/');
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
      email: `layout-swap-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Layout-Swap-Renderer-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function objects(manifest) {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: object.identity } : {}),
  };
}

function makePatch(object, prop, value) {
  const capability = object.propertyCapabilities?.find(item => item?.prop === prop);
  assert(capability?.patchMode === 'backend_patch', `${object.id}.${prop} is not renderer-authoritative`);
  return {
    op: 'set',
    mode: capability.patchMode,
    gid: object.id,
    prop,
    value,
    ...identityFields(object),
  };
}

function makeLegacySubplotPatch(object, prop, value, legacyLabel) {
  const patch = makePatch(object, prop, value);
  const axesIndex = String(object.id).split('.')[1];
  const stableKey = `ax${axesIndex}.subplot.label.${legacyLabel}`;
  const artistClass = String(object.source?.artistClass || '');
  assert(artistClass, `${object.id} is missing source.artistClass`);
  return {
    ...patch,
    stableKey,
    fingerprint: crypto.createHash('sha256').update(`${stableKey}|${artistClass}`).digest('hex'),
    fingerprintVersion: 2,
  };
}

function assertClose(actual, expected, label) {
  assert(Math.abs(Number(actual) - Number(expected)) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

function assertManifestBounds(manifest, expected, label) {
  for (const [gid, bounds] of Object.entries(expected)) {
    const subplot = objects(manifest).find(object => object.id === gid);
    assert(subplot, `${label} is missing ${gid}`);
    assertClose(subplot.currentProps?.left, bounds.left, `${label} ${gid}.left`);
    assertClose(subplot.currentProps?.bottom, bounds.bottom, `${label} ${gid}.bottom`);
  }
}

function assertEditLog(editLog, patches, label) {
  for (const patch of patches) {
    assert(
      editLog?.some(entry => entry.gid === patch.gid
        && entry.prop === patch.prop
        && Number(entry.value) === Number(patch.value)
        && entry.mode === 'backend_patch'),
      `${label} is missing ${patch.gid}.${patch.prop}=${patch.value}`,
    );
  }
}

function readStoredFigure(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    const figure = database.prepare(`
      SELECT revision, edit_log, manifest, preview_svg
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    return figure ? {
      revision: Number(figure.revision),
      editLog: parseJson(figure.edit_log, []),
      manifest: parseJson(figure.manifest, null),
      previewSvg: figure.preview_svg,
    } : null;
  } finally {
    database.close();
  }
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Layout swap renderer ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: script,
        script,
        script_language: 'python',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `layout-swap-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find(item => item.figureId === 'fig_1');
  assert(figure?.manifest && String(figure.svg || '').includes('<svg'), 'initial render returned no editable SVG figure');
  return { projectId, figure };
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const created = await createProject(token);
    projectId = created.projectId;
    const subplots = objects(created.figure.manifest)
      .filter(object => object.kind === 'subplot')
      .sort((a, b) => Number(a.currentProps?.left) - Number(b.currentProps?.left));
    assert(subplots.length === 2, `expected two subplots, got ${JSON.stringify(subplots.map(item => item.id))}`);

    const [left, right] = subplots;
    const original = {
      [left.id]: { left: Number(left.currentProps.left), bottom: Number(left.currentProps.bottom) },
      [right.id]: { left: Number(right.currentProps.left), bottom: Number(right.currentProps.bottom) },
    };
    const expected = {
      [left.id]: { left: original[right.id].left, bottom: original[right.id].bottom },
      [right.id]: { left: original[left.id].left, bottom: original[left.id].bottom },
    };
    const patches = [
      makePatch(left, 'left', expected[left.id].left),
      makePatch(left, 'bottom', expected[left.id].bottom),
      makePatch(right, 'left', expected[right.id].left),
      makePatch(right, 'bottom', expected[right.id].bottom),
    ];

    const baselineRevision = Number(created.figure.revision || 1);
    const patched = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `layout-swap-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: baselineRevision,
        patches,
      }),
    });
    assert(patched.response.ok && patched.data?.status === 'success', `swap patch failed: ${JSON.stringify(patched.data)}`);
    assert(Number(patched.data.revision) === baselineRevision + 1, 'swap batch did not increment revision exactly once');
    assert(String(patched.data.svg || '').includes('<svg'), 'swap patch did not return renderer SVG');
    assertManifestBounds(patched.data.manifest, expected, 'patch response');
    assertEditLog(patched.data.editLog, patches, 'patch response editLog');

    const swappedSubplots = objects(patched.data.manifest)
      .filter(object => object.kind === 'subplot')
      .sort((a, b) => Number(a.source?.axesIndex) - Number(b.source?.axesIndex));
    const legacyPatches = [
      makeLegacySubplotPatch(swappedSubplots[0], 'left', original[left.id].left, '子图 1 (第 1 行，第 1 列)'),
      makeLegacySubplotPatch(swappedSubplots[0], 'bottom', original[left.id].bottom, '子图 1 (第 1 行，第 1 列)'),
      makeLegacySubplotPatch(swappedSubplots[1], 'left', original[right.id].left, '子图 2 (第 1 行，第 2 列)'),
      makeLegacySubplotPatch(swappedSubplots[1], 'bottom', original[right.id].bottom, '子图 2 (第 1 行，第 2 列)'),
    ];
    delete legacyPatches[0].fingerprintVersion;
    legacyPatches[0].fingerprint = 'legacy-fingerprint-is-not-authoritative';
    const restored = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `layout-swap-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: baselineRevision + 1,
        patches: legacyPatches,
      }),
    });
    assert(restored.response.ok && restored.data?.status === 'success', `legacy swap failed: ${JSON.stringify(restored.data)}`);
    assert(Number(restored.data.revision) === baselineRevision + 2, 'legacy swap did not increment revision exactly once');
    assertManifestBounds(restored.data.manifest, original, 'legacy swap response');
    assertEditLog(restored.data.editLog, legacyPatches, 'legacy swap editLog');

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 150,
        saveToLibrary: true,
        name: `layout-swap-snapshot-${Date.now()}`,
      }),
    });
    const asset = exported.data?.figures?.[0]?.asset;
    assert(
      exported.response.ok
        && exported.data?.status === 'success'
        && asset?.assetId
        && asset.hasEditingSnapshot === true,
      `legacy layout export did not create a restorable snapshot: ${JSON.stringify(exported.data)}`,
    );

    const postExportPatch = makePatch(
      objects(restored.data.manifest).find(object => object.id === left.id),
      'left',
      0.20,
    );
    const postExport = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        requestId: `layout-swap-post-export-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: `${projectId}_fig_1`,
        projectId,
        figureId: 'fig_1',
        baseRevision: baselineRevision + 2,
        patches: [postExportPatch],
      }),
    });
    assert(postExport.response.ok && postExport.data?.status === 'success', `post-export patch failed: ${JSON.stringify(postExport.data)}`);
    assert(Number(postExport.data.revision) === baselineRevision + 3, 'post-export patch revision mismatch');
    assertClose(
      objects(postExport.data.manifest).find(object => object.id === left.id)?.currentProps?.left,
      0.20,
      'post-export subplot position',
    );

    const snapshotRestore = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    assert(
      snapshotRestore.response.ok && snapshotRestore.data?.status === 'success',
      `legacy layout snapshot restore failed: ${JSON.stringify(snapshotRestore.data)}`,
    );

    const restoredProject = await jsonRequest(`/api/projects/${projectId}`, token);
    const restoredProjectFigure = restoredProject.data?.project?.figures?.find(item => item.figureId === 'fig_1');
    assert(restoredProject.response.ok && restoredProjectFigure, `restored project load failed: ${JSON.stringify(restoredProject.data)}`);
    assertEditLog(restoredProjectFigure.editLog, legacyPatches, 'restored snapshot editLog');
    assert(
      !restoredProjectFigure.editLog?.some(entry => (
        entry.gid === postExportPatch.gid
        && entry.prop === postExportPatch.prop
        && Number(entry.value) === Number(postExportPatch.value)
      )),
      'post-export layout patch leaked into restored snapshot state',
    );

    const restoredRender = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script,
        editLogs: { fig_1: restoredProjectFigure.editLog },
        language: 'python',
        requestId: `layout-swap-restored-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    });
    const restoredRenderFigure = restoredRender.data?.figures?.find(item => item.figureId === 'fig_1');
    assert(
      restoredRender.response.ok && restoredRender.data?.status === 'success' && restoredRenderFigure,
      `restored layout render failed: ${JSON.stringify(restoredRender.data)}`,
    );
    assertManifestBounds(restoredRenderFigure.manifest, original, 'restored snapshot render');

    const currentLeft = objects(restoredRenderFigure.manifest).find(object => object.id === left.id);
    const validLegacyPatch = makeLegacySubplotPatch(
      currentLeft,
      'left',
      0.24,
      '子图 1 (第 1 行，第 1 列)',
    );
    const missingIdentity = clone(validLegacyPatch);
    delete missingIdentity.identity;
    const missingV2Fingerprint = clone(validLegacyPatch);
    delete missingV2Fingerprint.fingerprint;
    const wrongIdentity = clone(validLegacyPatch);
    wrongIdentity.identity.semanticKey = 'subplot_panel:subplot.1';
    const crossGid = clone(validLegacyPatch);
    crossGid.stableKey = 'ax1.subplot.label.子图 2 (第 1 行，第 2 列)';
    crossGid.fingerprint = crypto
      .createHash('sha256')
      .update(`${crossGid.stableKey}|${currentLeft.source.artistClass}`)
      .digest('hex');
    const nonLayout = makeLegacySubplotPatch(
      currentLeft,
      'zorder',
      Number(currentLeft.currentProps.zorder || 0) + 1,
      '子图 1 (第 1 行，第 1 列)',
    );
    const rejectionCases = [
      ['forged fingerprint', { ...validLegacyPatch, fingerprint: '0'.repeat(64) }],
      ['missing identity', missingIdentity],
      ['missing v2 fingerprint', missingV2Fingerprint],
      ['wrong identity', wrongIdentity],
      ['cross gid', crossGid],
      ['non-layout property', nonLayout],
    ];
    for (const [label, rejectedPatch] of rejectionCases) {
      const rejected = await jsonRequest('/api/figure/patch', token, {
        method: 'POST',
        body: JSON.stringify({
          requestId: `layout-swap-rejected-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          sessionId: `${projectId}_fig_1`,
          projectId,
          figureId: 'fig_1',
          baseRevision: Number(restoredRenderFigure.revision),
          patches: [rejectedPatch],
        }),
      });
      assert(rejected.data?.status === 'conflict', `${label} was not rejected: ${JSON.stringify(rejected.data)}`);
      assert(
        Number(rejected.data.revision) === Number(restoredRenderFigure.revision),
        `${label} changed revision`,
      );
    }

    const reloaded = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    const reloadedFigure = reloaded.data?.figures?.find(item => item.figureId === 'fig_1');
    assert(reloaded.response.ok && reloadedFigure, `figure reload failed: ${JSON.stringify(reloaded.data)}`);
    assert(Number(reloadedFigure.revision) === Number(restoredRenderFigure.revision), 'reloaded revision changed after rejection');
    assertManifestBounds(reloadedFigure.manifest, original, 'reloaded manifest');
    assertEditLog(reloadedFigure.editLog, legacyPatches, 'reloaded legacy editLog');

    const stored = readStoredFigure(projectId);
    assert(stored?.revision === Number(restoredRenderFigure.revision), `stored revision mismatch: ${stored?.revision}`);
    assert(String(stored.previewSvg || '').includes('<svg'), 'stored preview is missing renderer SVG');
    assertManifestBounds(stored.manifest, original, 'stored manifest');
    assertEditLog(stored.editLog, legacyPatches, 'stored legacy editLog');

    console.log('PASS real Matplotlib subplot swap and legacy identity compatibility persist safely');
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
