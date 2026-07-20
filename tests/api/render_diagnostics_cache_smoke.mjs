import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', 'test must target an isolated server');
  assert(path.resolve(process.env.SCIFIGURE_DATA_DIR || '').includes('scifigure-isolated-smoke-'), 'test must use isolated data');
}

async function requestJson(route, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

const script = [
  'import random',
  'import matplotlib.pyplot as plt',
  '_unused_random_probe = random.random()',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'line1, = ax1.plot([0, 1, 2], [1, 2, 1], label="series")',
  'ax1.text(0.5, 0.7, "CACHE_DIAGNOSTICS", transform=ax1.transAxes, ha="center", va="center")',
  'fig1.legend([line1], ["first figure legend"], loc="upper left", bbox_to_anchor=(1.35, 1.2))',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 2], label="second")',
  'ax2.set_ylabel("SECOND_FIGURE_LAYOUT_LABEL", labelpad=80)',
].join('\n');

async function renderProject(projectId, requestId) {
  const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({ script, editLogs: { fig_1: [], fig_2: [] }, language: 'python', requestId }),
  });
  assert(rendered.status === 'success' && rendered.figures?.length === 2, `project render failed: ${JSON.stringify(rendered)}`);
  return rendered;
}

function figureById(figures, figureId) {
  const figure = figures.find((candidate) => candidate.figureId === figureId);
  assert(figure, `missing ${figureId}: ${JSON.stringify(figures)}`);
  return figure;
}

function textGid(rendered, figureId) {
  const target = figureById(rendered.figures, figureId).manifest.objects.find((object) => (
    object?.kind === 'text' && String(object.currentProps?.text || '').includes('CACHE_DIAGNOSTICS')
  ));
  assert(target?.id, 'diagnostic cache fixture did not expose its text object');
  return target.id;
}

function assertFigureDiagnostics(figure, figureId, expectedElement, absentElement, source) {
  const warnings = figure.manifest?.renderDiagnostics?.layoutWarnings;
  assert(Array.isArray(warnings), `${source} ${figureId} omitted persisted layout diagnostics`);
  assert(warnings.some((warning) => warning.element === expectedElement), `${source} ${figureId} omitted ${expectedElement}: ${JSON.stringify(warnings)}`);
  assert(!warnings.some((warning) => warning.element === absentElement), `${source} ${figureId} received ${absentElement}: ${JSON.stringify(warnings)}`);
  assert(warnings.every((warning) => warning.figureId === figureId), `${source} ${figureId} received another Figure warning: ${JSON.stringify(warnings)}`);
}

function assertIsolatedDiagnostics(figures, source) {
  assertFigureDiagnostics(figureById(figures, 'fig_1'), 'fig_1', 'figure.legend.0', 'axes.0.ylabel', source);
  assertFigureDiagnostics(figureById(figures, 'fig_2'), 'fig_2', 'axes.0.ylabel', 'figure.legend.0', source);
}

async function patch(projectId, gid, label, baseRevision) {
  const response = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      requestId: `diagnostic-cache-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      patches: [{ op: 'set', mode: 'backend_patch', gid, prop: 'fontsize', value: 15 }],
    }),
  });
  assert(response.status === 'success', `patch ${label} failed: ${JSON.stringify(response)}`);
  assert(Array.isArray(response.diagnostics?.determinismWarnings), `patch ${label} omitted determinism diagnostics`);
  assert(Array.isArray(response.diagnostics?.layoutWarnings), `patch ${label} omitted layout diagnostics`);
  assert(response.diagnostics?.layoutDiagnosticsMs >= 0, `patch ${label} omitted layout diagnostics timing`);
  assertFigureDiagnostics(response, 'fig_1', 'figure.legend.0', 'axes.0.ylabel', `patch ${label}`);
  assert(response.diagnostics.layoutWarnings.every((warning) => warning.element !== 'axes.0.ylabel'), `patch ${label} diagnostics leaked figure two: ${JSON.stringify(response.diagnostics)}`);
  return response;
}

async function main() {
  assertIsolatedEnvironment();
  const auth = await requestJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `render-diagnostics-${Date.now()}@example.test`,
      password: 'Render-Diagnostics-2026',
    }),
  });
  authToken = auth.token;
  assert(authToken, 'registration did not return a token');

  let projectId;
  try {
    const created = await requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: `Render diagnostics ${Date.now()}`, spec: { plot_type: 'custom', script, custom_script: script } }),
    });
    projectId = created.id;
    assert(projectId, 'project creation did not return an id');

    const initial = await renderProject(projectId, `diagnostic-initial-${Date.now()}`);
    assertIsolatedDiagnostics(initial.figures, 'project render');
    const gid = textGid(initial, 'fig_1');
    const first = await patch(projectId, gid, 'first', figureById(initial.figures, 'fig_1').revision);
    assert(first.cache?.hit === false, `first patch should miss cache: ${JSON.stringify(first.cache)}`);

    const reset = await renderProject(projectId, `diagnostic-reset-${Date.now()}`);
    assertIsolatedDiagnostics(reset.figures, 'project rerender');
    const second = await patch(projectId, gid, 'cached', figureById(reset.figures, 'fig_1').revision);
    assert(second.cache?.hit === true, `repeated patch should hit cache: ${JSON.stringify(second.cache)}`);
    assert(second.diagnostics.determinismWarnings.some(warning => warning.symbol === 'random'), 'cache hit did not replay determinism warning');

    const figures = await requestJson(`/api/projects/${projectId}/figures?includePreview=1`);
    assert(figures.previewSource === 'cache', `project reopen should use cached previews: ${JSON.stringify(figures)}`);
    assertIsolatedDiagnostics(figures.figures, 'project reopen cache');
    const persistedDiagnostics = figureById(figures.figures, 'fig_1').manifest?.renderDiagnostics;
    assert(persistedDiagnostics?.layoutDiagnosticsMs >= 0, 'project preview manifest did not retain diagnostics');
    assert(persistedDiagnostics?.determinismWarnings?.some(warning => warning.symbol === 'random'), 'project preview manifest did not retain determinism warning');

    const refreshed = await requestJson(`/api/projects/${projectId}/figures?includePreview=1&forcePreview=1`);
    assert(refreshed.previewSource !== 'cache', `forced project reopen did not rerender previews: ${JSON.stringify(refreshed)}`);
    assertIsolatedDiagnostics(refreshed.figures, 'forced project reopen');

    console.log(JSON.stringify({ status: 'PASS', cache: second.cache, diagnostics: persistedDiagnostics }, null, 2));
  } finally {
    if (projectId) await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
