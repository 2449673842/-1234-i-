/**
 * API smoke test for cross-figure concurrent patch isolation.
 *
 * Verifies that concurrent patches to two figures in one project:
 * - both succeed,
 * - update only their target figure sessions,
 * - preserve distinct editLogs/revisions,
 * - do not require project-wide /figures/render.
 */

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
    .filter((project) => String(project?.name || '').startsWith('Cross figure concurrency smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import matplotlib.pyplot as plt',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'ax1.plot([0, 1, 2], [1, 3, 2], linewidth=1.2, label="A")',
  'ax1.set_title("Concurrent Figure One")',
  'ax1.set_xlabel("Original X One")',
  'ax1.set_ylabel("Y One")',
  'ax1.legend(loc="upper left")',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 4], linewidth=1.2, label="B")',
  'ax2.set_title("Concurrent Figure Two")',
  'ax2.set_xlabel("Original X Two")',
  'ax2.set_ylabel("Y Two")',
  'ax2.legend(loc="upper left")',
  'for fig in [fig1, fig2]:',
  '    fig.tight_layout()',
].join('\n');

async function createAndRenderProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Cross figure concurrency smoke ${Date.now()}`, spec }),
  });
  assert(created.status === 'success' && created.id, 'Project creation did not return an id');

  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [], fig_2: [] },
      language: 'python',
      requestId: `cross-concurrency-render-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success', `Initial render failed: ${rendered.message || 'unknown'}`);
  assert(Array.isArray(rendered.figures) && rendered.figures.length === 2, `Expected 2 figures, got ${rendered.figures?.length || 0}`);
  return { projectId: created.id, rendered };
}

function findAxisLabel(response, expectedText) {
  const axis = (response.manifest?.objects || []).find((object) => (
    object.kind === 'axis_x' &&
    String(object.currentProps?.label || '') === expectedText
  ));
  return axis;
}

async function patchFigureLabel(projectId, figureId, value) {
  const patched = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_${figureId}`,
      projectId,
      figureId,
      requestId: `cross-concurrency-${figureId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision: 1,
      patches: [{
        op: 'set',
        mode: 'backend_patch',
        gid: 'axis.x.0',
        prop: 'label',
        value,
      }],
    }),
  });
  assert(patched.status === 'success', `${figureId} patch failed: ${patched.message || 'unknown'}`);
  assert(findAxisLabel(patched, value), `${figureId} response did not contain updated X axis label ${value}`);
  assert(Array.isArray(patched.editLog) && patched.editLog.some((entry) => entry.gid === 'axis.x.0' && entry.prop === 'label' && entry.value === value), `${figureId} editLog missing target label patch`);
  return patched;
}

async function main() {
  const registered = await requestJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `cross-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Cross-Concurrency-Test-Password-2026',
    }),
  });
  assert(registered.token, 'Registration did not return an access token');
  authToken = registered.token;
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const created = await createAndRenderProject();
    projectId = created.projectId;

    const [fig1, fig2] = await Promise.all([
      patchFigureLabel(projectId, 'fig_1', 'Concurrent X One'),
      patchFigureLabel(projectId, 'fig_2', 'Concurrent X Two'),
    ]);

    assert(fig1.revision === 2, `fig_1 expected revision 2, got ${fig1.revision}`);
    assert(fig2.revision === 2, `fig_2 expected revision 2, got ${fig2.revision}`);
    assert(!JSON.stringify(fig1.manifest || {}).includes('Concurrent X Two'), 'fig_1 response leaked fig_2 label');
    assert(!JSON.stringify(fig2.manifest || {}).includes('Concurrent X One'), 'fig_2 response leaked fig_1 label');

    const listed = await requestJson(`/api/projects/${projectId}/figures`);
    const figures = Array.isArray(listed.figures) ? listed.figures : [];
    const row1 = figures.find((figure) => figure.figureId === 'fig_1');
    const row2 = figures.find((figure) => figure.figureId === 'fig_2');
    assert(row1?.revision === 2, `persisted fig_1 expected revision 2, got ${row1?.revision}`);
    assert(row2?.revision === 2, `persisted fig_2 expected revision 2, got ${row2?.revision}`);
    assert(Array.isArray(row1.editLog) && row1.editLog.length === 1 && row1.editLog[0].value === 'Concurrent X One', 'persisted fig_1 editLog was not isolated');
    assert(Array.isArray(row2.editLog) && row2.editLog.length === 1 && row2.editLog[0].value === 'Concurrent X Two', 'persisted fig_2 editLog was not isolated');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      patches: [
        { figureId: 'fig_1', revision: fig1.revision, label: 'Concurrent X One' },
        { figureId: 'fig_2', revision: fig2.revision, label: 'Concurrent X Two' },
      ],
      persisted: [
        { figureId: row1.figureId, revision: row1.revision, editLog: row1.editLog },
        { figureId: row2.figureId, revision: row2.revision, editLog: row2.editLog },
      ],
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
