/**
 * API smoke test for broad Matplotlib component-kind patch coverage.
 *
 * Verifies that representative recognized component kinds can be rendered,
 * addressed by gid, patched through /api/figure/patch, and replayed without
 * falling back to full project render.
 */

import { authenticateCapabilitySmokeUser, bearerHeaders } from '../playwright/smokeAuth.mjs';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hexToRgba(hex) {
  const normalized = String(hex).replace('#', '');
  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
    1,
  ];
}

function colorMatches(actual, expectedHex) {
  if (Array.isArray(actual)) {
    const actualRow = Array.isArray(actual[0]) ? actual[0] : actual;
    const expected = hexToRgba(expectedHex);
    return expected.slice(0, 3).every((value, index) => Math.abs(Number(actualRow[index]) - value) < 0.01);
  }
  return String(actual).toLowerCase() === String(expectedHex).toLowerCase();
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

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
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
    .filter((project) => String(project?.name || '').startsWith('Component kind matrix smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'fig, axes = plt.subplots(4, 3, figsize=(10, 10))',
  'ax0, ax1, ax2, ax3, ax4, ax5, ax6, ax7, ax8, ax9, ax10, ax11 = axes.ravel()',
  'ax0.plot([0, 1, 2], [1, 3, 2], color="#225577", linewidth=1.2, marker="o", label="line")',
  'ax0.scatter([0, 1, 2], [1.2, 2.6, 2.1], c="#cc5500", s=55, label="scatter")',
  'ax0.legend(title="Legend")',
  'ax0.grid(True)',
  'ax0.set_title("Line Scatter")',
  'ax0.set_xlabel("X0")',
  'ax0.set_ylabel("Y0")',
  'ax1.bar(["A", "B", "C"], [2, 3, 1], color="#88aadd", edgecolor="#222222", linewidth=0.8, label="bar")',
  'ax1.errorbar([0, 1, 2], [2.2, 3.1, 1.4], yerr=[0.2, 0.3, 0.1], color="#333333", capsize=4, label="err")',
  'ax1.legend()',
  'ax1.set_title("Bar Error")',
  'rng = np.random.default_rng(42)',
  'ax2.boxplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], patch_artist=True)',
  'ax2.set_title("Box")',
  'ax3.violinplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], showmeans=True)',
  'ax3.set_title("Violin")',
  'data = np.arange(25).reshape(5, 5)',
  'im = ax4.imshow(data, cmap="viridis")',
  'fig.colorbar(im, ax=ax4, label="Scale")',
  'ax4.set_title("Heatmap")',
  'ax5.stem([0, 1, 2], [1, 2, 1])',
  'ax5.text(0.5, 0.7, "Matrix Text", transform=ax5.transAxes, ha="center")',
  'ax5.set_title("Stem Text")',
  'grid_x = np.linspace(-2, 2, 24)',
  'grid_y = np.linspace(-2, 2, 24)',
  'X, Y = np.meshgrid(grid_x, grid_y)',
  'Z = np.sin(X) + np.cos(Y)',
  'cf = ax6.contourf(X, Y, Z, levels=4, cmap="viridis", alpha=0.65)',
  'fig.colorbar(cf, ax=ax6, label="Contourf scale")',
  'ax6.set_title("Contourf")',
  'ax7.contour(X, Y, Z, levels=[-1, 0, 1], cmap="magma", linewidths=1.2)',
  'ax7.set_title("Contour")',
  'ax8.hist([0, 1, 1, 2, 2, 2], bins=[0, 1, 2, 3], color="#4477aa", alpha=0.6, label="hist")',
  'ax8.legend()',
  'ax8.set_title("Histogram")',
  'ax9.stairs([1, 2, 1], [0, 1, 2, 3], color="#cc6677", label="stairs")',
  'ax9.legend()',
  'ax9.set_title("Stairs")',
  'ax10.step([0, 1, 2], [2, 1, 3], where="mid", color="#228833", label="step")',
  'ax10.legend()',
  'ax10.set_title("Step")',
  'ax11.axis("off")',
  'fig.tight_layout()',
].join('\n');

const checks = [
  { id: 'line', kind: 'line', gidPrefix: 'line.', prop: 'linewidth', value: 2.4, expected: (props) => Number(props.linewidth) === 2.4 },
  { id: 'collection', kind: 'collection', excludeRole: 'legend_marker', prop: 'linewidth', value: 1.65, expected: (props) => Math.abs(Number(props.linewidth) - 1.65) < 0.01 },
  { id: 'bar-container', kind: 'bar_container', prop: 'linewidth', value: 1.8, expected: (props) => Number(props.linewidth) === 1.8 },
  { id: 'errorbar-container', kind: 'errorbar_container', prop: 'elinewidth', value: 2.1, expected: (props) => Number(props.elinewidth) === 2.1 },
  { id: 'errorbar-capsize', kind: 'errorbar_container', prop: 'capsize', value: 7, expected: (props) => Math.abs(Number(props.capsize) - 7) < 0.01 },
  { id: 'stem-container', kind: 'stem_container', prop: 'stem_linewidth', value: 2.6, expected: (props) => Math.abs(Number(props.stem_linewidth) - 2.6) < 0.01 },
  { id: 'boxplot-container', kind: 'boxplot_container', prop: 'median_color', value: '#d62728', expected: (props) => String(props.median_color).toLowerCase() === '#d62728' },
  { id: 'violinplot-container', kind: 'violinplot_container', prop: 'linewidth', value: 1.55, expected: (props) => Math.abs(Number(props.linewidth) - 1.55) < 0.01 },
  { id: 'heatmap', kind: 'heatmap', prop: 'vmax', value: 20, expected: (props) => Math.abs(Number(props.vmax) - 20) < 0.01 },
  { id: 'contourf', kind: 'contourf', prop: 'vmax', value: 1.75, expected: (props) => Math.abs(Number(props.vmax) - 1.75) < 0.01 },
  { id: 'contour-linewidth', kind: 'contour', prop: 'linewidth', value: 2.5, expected: (props) => Math.abs(Number(props.linewidth) - 2.5) < 0.01 },
  { id: 'contour-linestyle', kind: 'contour', prop: 'linestyle', value: 'dashed', expected: (props) => String(props.linestyle) === 'dashed' },
  { id: 'colorbar', kind: 'colorbar', prop: 'label', value: 'Updated Scale', expected: (props) => String(props.label) === 'Updated Scale' },
  { id: 'legend', kind: 'legend', prop: 'title', value: 'Updated Legend', expected: (props) => String(props.title) === 'Updated Legend' },
  { id: 'legend-position', kind: 'legend', prop: 'position', value: { x: 0.72, y: 0.34, coord_system: 'figure' }, expected: (props) => Math.abs(Number(props.x) - 0.72) < 0.03 && Math.abs(Number(props.y) - 0.34) < 0.03 && props.coord_system === 'figure' },
  { id: 'spine-group', kind: 'spine_group', prop: 'linewidth', value: 1.7, expected: (props) => Number(props.linewidth) === 1.7 },
  { id: 'axis-x', kind: 'axis_x', prop: 'tick_labelsize', value: 13, expected: (props) => Number(props.tick_labelsize) === 13 },
  { id: 'histogram-series', kind: 'bar_container', role: 'histogram_series', prop: 'facecolor', value: '#339966', expectedSvgColor: '#339966', expected: (props) => colorMatches(props.facecolor, '#339966') },
  { id: 'stairs-series', kind: 'patch', role: 'stairs_series', prop: 'edgecolor', value: '#114488', expected: (props) => colorMatches(props.edgecolor, '#114488') },
  { id: 'step-series', kind: 'line', role: 'step_series', prop: 'color', value: '#1166aa', expected: (props) => colorMatches(props.color, '#1166aa') },
];

async function createAndRenderProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 180, height: 120, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Component kind matrix smoke ${Date.now()}`, spec }),
  });
  assert(created.status === 'success' && created.id, 'Project creation did not return an id');

  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `component-kind-render-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success', `Initial render failed: ${rendered.message || 'unknown'}`);
  assert(Array.isArray(rendered.figures) && rendered.figures.length > 0, 'Initial render returned no figures');
  return { projectId: created.id, rendered };
}

function findObject(rendered, check) {
  const objects = rendered.figures?.[0]?.manifest?.objects || [];
  return objects.find((object) => (
    object?.kind === check.kind &&
    (!check.role || object.role === check.role) &&
    (!check.excludeRole || object.role !== check.excludeRole) &&
    (!check.gidPrefix || String(object.id || '').startsWith(check.gidPrefix)) &&
    Array.isArray(object.editable) &&
    object.editable.length > 0
  ));
}

function findObjectInResponse(response, gid) {
  return (manifestFromResponse(response)?.objects || []).find((object) => object.id === gid);
}

function manifestFromResponse(response) {
  return response?.manifest
    || response?.figures?.find((figure) => figure.figureId === 'fig_1')?.manifest
    || response?.figures?.[0]?.manifest
    || null;
}

function capabilityProps(object) {
  return Array.isArray(object?.propertyCapabilities)
    ? object.propertyCapabilities.map((capability) => capability?.prop)
    : [];
}

function assertReadonlyStructuralProps(object, props, label) {
  for (const prop of props) {
    assert(!object.editable?.includes(prop), `${label} exposes structural ${prop} as editable`);
    assert(!capabilityProps(object).includes(prop), `${label} exposes structural ${prop} in propertyCapabilities`);
  }
}

function assertHistoricalSeriesObjects(objects) {
  const byRole = new Map(objects.map((object) => [object.role, object]));
  const expected = [
    { role: 'histogram_series', kind: 'bar_container', callName: 'Axes.hist', structuralProps: ['bins', 'counts', 'values', 'edges', 'density', 'orientation'] },
    { role: 'stairs_series', kind: 'patch', callName: 'Axes.stairs', structuralProps: ['values', 'edges', 'baseline'] },
    { role: 'step_series', kind: 'line', callName: 'Axes.step', structuralProps: ['x', 'y', 'xdata', 'ydata', 'where', 'drawstyle'] },
  ];
  for (const item of expected) {
    const object = byRole.get(item.role);
    assert(object, `Missing ${item.role}; roles=${JSON.stringify(objects.map(candidate => ({ id: candidate.id, kind: candidate.kind, role: candidate.role })))}`);
    assert(object.kind === item.kind, `${item.role} should keep historical kind ${item.kind}: ${JSON.stringify(object)}`);
    assert(object.source?.callName === item.callName, `${item.role} did not preserve trusted call source ${item.callName}: ${JSON.stringify(object.source)}`);
    assert(object.semanticCoverage?.status === 'dedicated', `${item.role} is not marked dedicated: ${JSON.stringify(object.semanticCoverage)}`);
    assertReadonlyStructuralProps(object, item.structuralProps, item.role);
  }
  return Object.fromEntries(expected.map(item => [item.role, byRole.get(item.role).id]));
}

async function renderWithEditLog(projectId, editLog) {
  const replayed = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: editLog },
      language: 'python',
      requestId: `component-kind-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(replayed.status === 'success', `Replay render failed: ${replayed.message || JSON.stringify(replayed)}`);
  assert(Array.isArray(replayed.figures) && replayed.figures.length > 0, 'Replay render returned no figures');
  return replayed;
}

async function patchObject(projectId, gid, prop, value, label, baseRevision) {
  const patched = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `component-kind-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches: [{
        op: 'set',
        mode: 'backend_patch',
        gid,
        prop,
        value,
      }],
    }),
  });
  assert(patched.status === 'success', `Patch ${label} failed: ${JSON.stringify(patched)}`);
  assert(Array.isArray(patched.applied) && patched.applied.some((entry) => entry.gid === gid && entry.prop === prop), `Patch ${label} was not reported in applied edits`);
  return patched;
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'component kind matrix');
  await cleanupSmokeProjects();
  let projectId = null;
  const summary = [];
  try {
    const created = await createAndRenderProject();
    projectId = created.projectId;
    let rendered = created.rendered;
    let revision = 1;

    const objects = rendered.figures?.[0]?.manifest?.objects || [];
    const historicalSeries = assertHistoricalSeriesObjects(objects);
    const kindCounts = objects.reduce((acc, object) => {
      acc[object.kind] = (acc[object.kind] || 0) + 1;
      return acc;
    }, {});
    const containerKinds = new Set(['bar_container', 'errorbar_container', 'stem_container', 'boxplot_container', 'violinplot_container']);
    const containerOwnership = objects
      .filter((object) => containerKinds.has(object.kind))
      .map((container) => ({
        id: container.id,
        kind: container.kind,
        children: container.children || [],
      }));
    containerOwnership.forEach((container) => {
      assert(container.children.length > 0, `${container.id} has no owned children`);
      container.children.forEach((childId) => {
        const child = objects.find((object) => object.id === childId);
        assert(child?.parentId === container.id, `${childId} is not linked back to ${container.id}`);
        if (container.id === historicalSeries.histogram_series) {
          assert(child?.role === 'histogram_child_patch', `${childId} is not marked as a histogram child patch`);
          assert(child?.currentProps?.parentOwned === true, `${childId} is not parentOwned under ${container.id}`);
        }
      });
    });
    const contourParents = objects.filter((object) => object.kind === 'contour' || object.kind === 'contourf');
    assert(contourParents.length === 2, `Expected contour and contourf parents, got ${JSON.stringify(contourParents.map((object) => ({ id: object.id, kind: object.kind, role: object.role })))}`);
    contourParents.forEach((parent) => {
      assert(Array.isArray(parent.children) && parent.children.length > 0, `${parent.id} has no owned contour children`);
      assert(!parent.editable.includes('levels'), `${parent.id} exposes levels as editable`);
      assert(!parent.editable.includes('paths'), `${parent.id} exposes geometry paths as editable`);
      assert(!parent.editable.includes('segments'), `${parent.id} exposes geometry segments as editable`);
      parent.children.forEach((childId) => {
        const child = objects.find((object) => object.id === childId);
        assert(child?.parentId === parent.id, `${childId} is not linked back to ${parent.id}`);
        assert(child?.role === 'contour_child_collection', `${childId} is not marked as a contour child collection`);
      });
    });
    const contourChildIds = new Set(contourParents.flatMap((parent) => parent.children || []));
    const replayEditLog = [];

    for (const check of checks) {
      const target = findObject(rendered, check);
      assert(target?.id, `No editable ${check.kind} object found`);
      assert(!contourChildIds.has(target.id), `${check.id} targeted contour child collection ${target.id} instead of the parent object`);
      assert(target.editable.includes(check.prop), `${target.id} does not list ${check.prop} as editable`);
      const patched = await patchObject(projectId, target.id, check.prop, check.value, check.id, revision);
      revision = patched.revision || revision + 1;
      const updated = findObjectInResponse(patched, target.id);
      const patchedManifest = manifestFromResponse(patched);
      if (check.expectedSvgColor) {
        const svg = String(patched.svg || '').toLowerCase();
        const targetIds = target.children?.length ? target.children : [target.id];
        assert(targetIds.every((targetId) => {
          const start = svg.indexOf(String(targetId).toLowerCase());
          return start >= 0 && svg.slice(start, start + 600).includes(check.expectedSvgColor.toLowerCase());
        }), `${check.id} response SVG did not apply ${check.expectedSvgColor} to ${JSON.stringify(targetIds)}`);
      }
      if (Array.isArray(patchedManifest?.objects) && patchedManifest.objects.length > 0) {
        assert(updated, `Patched response does not contain ${target.id}; objects=${JSON.stringify((patchedManifest?.objects || []).map((object) => ({ id: object.id, kind: object.kind, role: object.role })))}`);
        assert(check.expected(updated.currentProps || {}), `${check.id} did not persist ${check.prop}=${check.value}; got ${JSON.stringify(updated.currentProps)}`);
        rendered = { figures: [{ manifest: patchedManifest }] };
      }
      replayEditLog.push({
        gid: target.id,
        prop: check.prop,
        value: check.value,
        mode: 'backend_patch',
      });
      summary.push({ id: check.id, gid: target.id, prop: check.prop, value: check.value, revision });
    }

    const replayed = await renderWithEditLog(projectId, replayEditLog);
    for (const check of checks) {
      const replayedTarget = findObject(replayed, check);
      assert(replayedTarget?.id, `Replay did not expose ${check.id}`);
      assert(check.expected(replayedTarget.currentProps || {}), `Replay did not preserve ${check.id} ${check.prop}=${check.value}; got ${JSON.stringify(replayedTarget.currentProps)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      kindCounts,
      historicalSeries,
      containerOwnership,
      checks: summary,
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
