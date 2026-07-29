import Database from 'better-sqlite3';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

const radarScript = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  '',
  'labels = ["Quality", "Speed", "Cost", "Reliability", "Support"]',
  'angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)',
  'angles_closed = np.r_[angles, angles[0]]',
  'model_a = np.array([0.82, 0.64, 0.48, 0.91, 0.73])',
  'model_b = np.array([0.58, 0.76, 0.69, 0.62, 0.88])',
  '',
  'fig, ax = plt.subplots(figsize=(4.2, 4.2), subplot_kw={"projection": "polar"})',
  'fig.subplots_adjust(left=0.20, right=0.80, bottom=0.20, top=0.80)',
  'ax.set_ylim(0, 1)',
  'ax.set_xticks(angles)',
  'ax.set_xticklabels(labels)',
  'ax.plot(angles_closed, np.r_[model_a, model_a[0]], color="#3366cc", linewidth=2.0, label="Model A")',
  'ax.fill(angles_closed, np.r_[model_a, model_a[0]], color="#3366cc", alpha=0.22)',
  'ax.plot(angles_closed, np.r_[model_b, model_b[0]], color="#cc6633", linewidth=2.0, label="Model B")',
  'ax.fill(angles_closed, np.r_[model_b, model_b[0]], color="#cc6633", alpha=0.18)',
  'ax.text(',
  '    0.5,',
  '    0.94,',
  '    "Radar note",',
  '    transform=ax.transAxes,',
  '    ha="center",',
  '    va="center",',
  '    bbox={',
  '        "boxstyle": "round,pad=0.30",',
  '        "facecolor": "#ffeeaa",',
  '        "edgecolor": "#333333",',
  '        "alpha": 0.8,',
  '        "linewidth": 1.2,',
  '    },',
  ')',
  'ax.legend(loc="center", bbox_to_anchor=(0.78, 0.82))',
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
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
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
      email: `radar-chart-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Radar-Chart-Persistence-2026',
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
    ...(object.identity !== undefined ? { identity: clone(object.identity) } : {}),
  };
}

function isSamePatch(left, right) {
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function assertDeepValue(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertEditLogHasPatch(label, editLog, expectedPatch) {
  const matched = Array.isArray(editLog)
    ? editLog.find((entry) => isSamePatch(entry, expectedPatch))
    : null;
  assert(matched, `${label} is missing ${JSON.stringify(expectedPatch)}: ${JSON.stringify(editLog)}`);
  assert(
    matched.mode === expectedPatch.mode,
    `${label} persisted mode ${matched.mode} instead of ${expectedPatch.mode}: ${JSON.stringify(matched)}`,
  );
  return matched;
}

function assertManifestHasPatch(label, manifest, patch) {
  const object = objects(manifest).find((item) => item.id === patch.gid);
  assert(object, `${label} manifest is missing ${patch.gid}: ${JSON.stringify(manifest)}`);
  if (patch.prop === 'position') {
    const expected = patch.value;
    const actual = object.currentProps || {};
    assert(
      Math.abs(Number(actual.x) - Number(expected.x)) < 1e-6
        && Math.abs(Number(actual.y) - Number(expected.y)) < 1e-6
        && actual.coord_system === expected.coord_system,
      `${label} ${patch.gid}.position expected ${JSON.stringify(expected)}, got ${JSON.stringify({
        x: actual.x,
        y: actual.y,
        coord_system: actual.coord_system,
      })}`,
    );
    return;
  }
  assertDeepValue(object.currentProps?.[patch.prop], patch.value, `${label} ${patch.gid}.${patch.prop}`);
}

function findObject(manifest, predicate, label) {
  const object = objects(manifest).find(predicate);
  assert(object?.id, `${label} was not exposed in radar manifest: ${JSON.stringify(objects(manifest).map((item) => ({
    id: item.id,
    kind: item.kind,
    role: item.role,
    label: item.label,
    currentProps: item.currentProps,
  })))}`);
  return object;
}

function findRadarTargets(manifest) {
  const dimensionLabel = findObject(
    manifest,
    (object) => String(object.id || '').startsWith('xtick.')
      && object.currentProps?.text === 'Quality'
      && object.currentProps?.radarSemanticRole === 'dimension_label',
    'radar dimension label',
  );
  const legend = findObject(
    manifest,
    (object) => object.id === 'legend.0'
      && Array.isArray(object.editable)
      && object.editable.includes('position'),
    'radar legend container',
  );
  const legendText = findObject(
    manifest,
    (object) => object.id === 'legend_text.0.0'
      && object.role === 'legend_text'
      && object.currentProps?.text === 'Model A'
      && Array.isArray(object.editable)
      && object.editable.includes('text'),
    'radar legend text',
  );
  const line = findObject(
    manifest,
    (object) => String(object.id || '').startsWith('line.')
      && object.kind === 'line'
      && object.label === 'Model A'
      && object.currentProps?.radarSemanticRole === 'series',
    'radar line',
  );
  const fill = findObject(
    manifest,
    (object) => String(object.id || '').startsWith('patch.')
      && object.kind === 'patch'
      && object.currentProps?.radarSemanticRole === 'fill'
      && Number(object.currentProps?.alpha) === 0.22,
    'radar fill',
  );
  const ordinaryText = findObject(
    manifest,
    (object) => String(object.id || '').startsWith('text.')
      && object.currentProps?.text === 'Radar note'
      && object.currentProps?.bbox_visible === true,
    'ordinary radar text',
  );
  return { dimensionLabel, legend, legendText, line, fill, ordinaryText };
}

function makePatch(object, prop, value) {
  const capability = Array.isArray(object.propertyCapabilities)
    ? object.propertyCapabilities.find((item) => item?.prop === prop)
    : null;
  assert(capability?.patchMode, `${object.id}.${prop} has no authoritative property capability: ${JSON.stringify(object)}`);
  return {
    op: 'set',
    mode: capability.patchMode,
    gid: object.id,
    prop,
    value,
    ...identityFields(object),
  };
}

function readDatabaseState(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const session = database.prepare('SELECT id, revision, edit_log FROM sessions WHERE id = ?').get(`${projectId}_fig_1`);
    const figure = database.prepare(`
      SELECT revision, edit_log, manifest, preview_svg
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    return {
      session: session ? {
        id: session.id,
        revision: Number(session.revision),
        editLog: parseJson(session.edit_log, []),
      } : null,
      figure: figure ? {
        revision: Number(figure.revision),
        editLog: parseJson(figure.edit_log, []),
        manifest: parseJson(figure.manifest, null),
        previewSvg: figure.preview_svg,
      } : null,
    };
  } finally {
    database.close();
  }
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Radar chart persistence ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: radarScript,
        script: radarScript,
        script_language: 'python',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: radarScript,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `radar-chart-initial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial radar render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `initial radar render returned no fig_1 manifest: ${JSON.stringify(rendered.data)}`);
  return { projectId, figure };
}

async function submitPatchBatch(token, projectId, patches, baseRevision) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `radar-chart-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches,
    }),
  });
  assert(result.response.ok, `radar patch request failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function loadProjectFigure(token, projectId) {
  const loaded = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `project reload failed: ${JSON.stringify(loaded.data)}`);
  const figure = loaded.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure, `project reload did not include fig_1: ${JSON.stringify(loaded.data)}`);
  assert(figure.previewSource === 'cache', `project reload did not reuse the persisted radar preview: ${JSON.stringify(figure)}`);
  return figure;
}

async function exportSvg(token, projectId) {
  const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      saveToLibrary: true,
      name: `radar-chart-persistence-${Date.now()}`,
    }),
  });
  assert(exported.response.ok && exported.data?.status === 'success', `radar SVG export failed: ${JSON.stringify(exported.data)}`);
  const exportedFigure = exported.data?.figures?.[0];
  assert(String(exportedFigure?.svg || '').includes('<svg'), `radar SVG export did not return SVG: ${JSON.stringify(exported.data)}`);
  assert(exportedFigure?.asset?.assetId, `radar SVG export did not create an asset: ${JSON.stringify(exported.data)}`);
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const created = await createProject(token);
    projectId = created.projectId;
    const baselineRevision = Number(created.figure.revision || 1);
    const targets = findRadarTargets(created.figure.manifest);
    const patches = [
      makePatch(targets.dimensionLabel, 'radar_label_offset', { dx: 8.0, dy: -3.5 }),
      makePatch(targets.legend, 'position', { x: 0.70, y: 0.76, coord_system: 'figure' }),
      makePatch(targets.legendText, 'text', 'Model A edited'),
      makePatch(targets.line, 'color', '#118855'),
      makePatch(targets.fill, 'alpha', 0.44),
      makePatch(targets.ordinaryText, 'bbox_facecolor', '#ddeeff'),
      makePatch(targets.ordinaryText, 'bbox_edgecolor', '#112233'),
      makePatch(targets.ordinaryText, 'bbox_alpha', 0.55),
    ];
    assert(patches[0].mode === 'backend_patch', `radar label offset must require renderer replay: ${JSON.stringify(patches[0])}`);
    assert(patches[1].mode === 'backend_patch', `radar legend movement must require renderer replay: ${JSON.stringify(patches[1])}`);

    const patched = await submitPatchBatch(token, projectId, patches, baselineRevision);
    assert(patched?.status === 'success', `radar patch batch failed: ${JSON.stringify(patched)}`);
    assert(Number(patched?.revision) === baselineRevision + 1, `radar patch batch did not increment revision once: ${JSON.stringify(patched)}`);
    for (const patch of patches) {
      assertEditLogHasPatch('radar patch response', patched.editLog, patch);
      assertManifestHasPatch('radar patch response', patched.manifest, patch);
    }

    const reloadedFigure = await loadProjectFigure(token, projectId);
    assert(Number(reloadedFigure.revision) === baselineRevision + 1, `project reload revision mismatch: ${JSON.stringify(reloadedFigure)}`);
    for (const patch of patches) {
      assertEditLogHasPatch('project reload', reloadedFigure.editLog, patch);
      assertManifestHasPatch('project reload', reloadedFigure.manifest, patch);
    }

    const stored = readDatabaseState(projectId);
    assert(Number(stored.session?.revision) === baselineRevision + 1, `DB session revision mismatch: ${JSON.stringify(stored)}`);
    assert(Number(stored.figure?.revision) === baselineRevision + 1, `DB figure revision mismatch: ${JSON.stringify(stored)}`);
    for (const patch of patches) {
      assertEditLogHasPatch('DB session', stored.session?.editLog, patch);
      assertEditLogHasPatch('DB project figure', stored.figure?.editLog, patch);
      assertManifestHasPatch('DB project figure', stored.figure?.manifest, patch);
    }

    await exportSvg(token, projectId);
    console.log('PASS radar chart edits persist through patch, reload, manifest cache, and SVG export');
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
