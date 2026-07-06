/**
 * API smoke test for backend render cache hit/miss behavior.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 *
 * Run:
 *   node tests/api/render_cache_smoke.mjs
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
    .filter((project) => String(project?.name || '').startsWith('Cache smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots(figsize=(4, 3))',
  'ax.plot([0, 1, 2], [1, 2, 1], color="#225577")',
  'ax.text(0.5, 0.7, "CACHE_ME", transform=ax.transAxes, ha="center", va="center", fontsize=10)',
  'ax.set_title("Cache Smoke")',
  'plt.tight_layout()',
].join('\n');

async function createAndRenderProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 120, height: 80, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Cache smoke ${Date.now()}`, spec }),
  });
  assert(created.status === 'success' && created.id, 'Project creation did not return an id');

  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `cache-render-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success', `Initial render failed: ${rendered.message || 'unknown'}`);
  assert(Array.isArray(rendered.figures) && rendered.figures.length > 0, 'Initial render returned no figures');
  return { projectId: created.id, rendered };
}

function findTextGid(rendered) {
  const objects = rendered.figures?.[0]?.manifest?.objects || [];
  const cacheText = objects.find((object) => (
    object?.kind === 'text' &&
    Array.isArray(object.editable) &&
    object.editable.includes('fontsize') &&
    String(object.currentProps?.text || '').includes('CACHE_ME')
  ));
  const fallbackText = objects.find((object) => (
    object?.kind === 'text' &&
    Array.isArray(object.editable) &&
    object.editable.includes('fontsize')
  ));
  const target = cacheText || fallbackText;
  assert(target?.id, 'No editable text object found for cache smoke');
  return target.id;
}

async function resetFigureEditLog(projectId) {
  const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `cache-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.status === 'success', `Reset render failed: ${rendered.message || 'unknown'}`);
}

async function patchFontSize(projectId, gid, value, label) {
  const patched = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `cache-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision: 1,
      patches: [{
        op: 'set',
        mode: 'backend_patch',
        gid,
        prop: 'fontsize',
        value,
      }],
    }),
  });
  assert(patched.status === 'success', `Patch ${label} failed: ${patched.message || 'unknown'}`);
  assert(typeof patched.cache?.hit === 'boolean', `Patch ${label} did not expose cache.hit`);
  assert(typeof patched.cache?.key === 'string' && patched.cache.key.length > 0, `Patch ${label} did not expose cache.key`);
  return patched;
}

async function main() {
  await cleanupSmokeProjects();
  let projectId = null;
  try {
    const created = await createAndRenderProject();
    projectId = created.projectId;
    const gid = findTextGid(created.rendered);

    const first = await patchFontSize(projectId, gid, 16, 'first');
    assert(first.cache.hit === false, `First semantic patch should miss cache, got hit=${first.cache.hit}`);

    await resetFigureEditLog(projectId);
    const second = await patchFontSize(projectId, gid, 16, 'second');
    assert(second.cache.hit === true, `Repeated semantic patch should hit cache, got hit=${second.cache.hit}`);
    assert(second.cache.key === first.cache.key, 'Repeated semantic patch produced a different cache key');

    await resetFigureEditLog(projectId);
    const changed = await patchFontSize(projectId, gid, 17, 'changed');
    assert(changed.cache.hit === false, `Changed semantic patch should miss cache, got hit=${changed.cache.hit}`);
    assert(changed.cache.key !== first.cache.key, 'Changed semantic patch reused the old cache key');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      gid,
      first: first.cache,
      second: second.cache,
      changed: changed.cache,
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
