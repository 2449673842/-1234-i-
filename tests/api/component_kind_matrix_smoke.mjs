/**
 * API smoke test for broad Matplotlib component-kind patch coverage.
 *
 * Verifies that representative recognized component kinds can be rendered,
 * addressed by gid, patched through /api/figure/patch, and replayed without
 * falling back to full project render.
 */

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    .filter((project) => String(project?.name || '').startsWith('Component kind matrix smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'fig, axes = plt.subplots(2, 3, figsize=(9, 6))',
  'ax0, ax1, ax2, ax3, ax4, ax5 = axes.ravel()',
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
  'fig.tight_layout()',
].join('\n');

const checks = [
  { id: 'line', kind: 'line', gidPrefix: 'line.', prop: 'linewidth', value: 2.4, expected: (props) => Number(props.linewidth) === 2.4 },
  { id: 'collection', kind: 'collection', prop: 'alpha', value: 0.55, expected: (props) => Math.abs(Number(props.alpha) - 0.55) < 0.01 },
  { id: 'bar-container', kind: 'bar_container', prop: 'linewidth', value: 1.8, expected: (props) => Number(props.linewidth) === 1.8 },
  { id: 'errorbar-container', kind: 'errorbar_container', prop: 'elinewidth', value: 2.1, expected: (props) => Number(props.elinewidth) === 2.1 },
  { id: 'boxplot-container', kind: 'boxplot_container', prop: 'median_color', value: '#d62728', expected: (props) => String(props.median_color).toLowerCase() === '#d62728' },
  { id: 'violinplot-container', kind: 'violinplot_container', prop: 'alpha', value: 0.45, expected: (props) => Math.abs(Number(props.alpha) - 0.45) < 0.01 },
  { id: 'heatmap', kind: 'heatmap', prop: 'alpha', value: 0.6, expected: (props) => Math.abs(Number(props.alpha) - 0.6) < 0.01 },
  { id: 'colorbar', kind: 'colorbar', prop: 'label', value: 'Updated Scale', expected: (props) => String(props.label) === 'Updated Scale' },
  { id: 'legend', kind: 'legend', prop: 'title', value: 'Updated Legend', expected: (props) => String(props.title) === 'Updated Legend' },
  { id: 'spine-group', kind: 'spine_group', prop: 'linewidth', value: 1.7, expected: (props) => Number(props.linewidth) === 1.7 },
  { id: 'axis-x', kind: 'axis_x', prop: 'tick_labelsize', value: 13, expected: (props) => Number(props.tick_labelsize) === 13 },
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
    (!check.gidPrefix || String(object.id || '').startsWith(check.gidPrefix)) &&
    Array.isArray(object.editable) &&
    object.editable.length > 0
  ));
}

function findObjectInResponse(response, gid) {
  return (response.manifest?.objects || []).find((object) => object.id === gid);
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
  assert(patched.status === 'success', `Patch ${label} failed: ${patched.message || 'unknown'}`);
  assert(Array.isArray(patched.applied) && patched.applied.some((entry) => entry.gid === gid && entry.prop === prop), `Patch ${label} was not reported in applied edits`);
  return patched;
}

async function main() {
  await cleanupSmokeProjects();
  let projectId = null;
  const summary = [];
  try {
    const created = await createAndRenderProject();
    projectId = created.projectId;
    let rendered = created.rendered;
    let revision = 1;

    const objects = rendered.figures?.[0]?.manifest?.objects || [];
    const kindCounts = objects.reduce((acc, object) => {
      acc[object.kind] = (acc[object.kind] || 0) + 1;
      return acc;
    }, {});

    for (const check of checks) {
      const target = findObject(rendered, check);
      assert(target?.id, `No editable ${check.kind} object found`);
      assert(target.editable.includes(check.prop), `${target.id} does not list ${check.prop} as editable`);
      const patched = await patchObject(projectId, target.id, check.prop, check.value, check.id, revision);
      revision = patched.revision || revision + 1;
      const updated = findObjectInResponse(patched, target.id);
      assert(updated, `Patched response does not contain ${target.id}`);
      assert(check.expected(updated.currentProps || {}), `${check.id} did not persist ${check.prop}=${check.value}; got ${JSON.stringify(updated.currentProps)}`);
      rendered = { figures: [{ manifest: patched.manifest }] };
      summary.push({ id: check.id, gid: target.id, prop: check.prop, value: check.value, revision });
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      kindCounts,
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
