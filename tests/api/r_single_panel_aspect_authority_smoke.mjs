import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test requires the isolated server wrapper');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
  const dataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  assert(path.basename(path.dirname(dataDir)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(dataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/');
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
      email: `r-aspect-authority-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Aspect-Authority-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const script = [
  'library(ggplot2)',
  'df <- data.frame(x = 1:4, y = c(1, 3, 2, 4), group = c("A", "A", "B", "B"))',
  'p <- ggplot(df, aes(x, y, color = group)) +',
  '  geom_line(linewidth = 0.9) +',
  '  geom_point(size = 2.8) +',
  '  theme_classic() +',
  '  labs(title = "R single-panel aspect authority")',
  'p',
].join('\n');

function identityFields(object) {
  return {
    stableKey: object.stableKey,
    fingerprint: object.fingerprint,
    fingerprintVersion: object.fingerprintVersion,
    identity: object.identity,
  };
}

function aspectPatch(object, value) {
  return {
    op: 'set',
    mode: 'local_patch',
    gid: object.id,
    prop: 'aspect',
    value,
    ...identityFields(object),
  };
}

function sameAspectEdit(entry, value) {
  return entry?.gid === 'subplot.0' && entry?.prop === 'aspect' && entry?.value === value;
}

async function loadFigure(token, projectId) {
  const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `project load failed: ${JSON.stringify(loaded.data)}`);
  const figure = loaded.data.project?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure, 'project load did not return fig_1');
  return figure;
}

async function applyAspect(token, projectId, object, value, baseRevision) {
  const patch = aspectPatch(object, value);
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-aspect-${value}-${Date.now()}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches: [patch],
    }),
  });
  assert(result.response.ok && result.data?.status === 'success', `aspect ${value} patch failed: ${JSON.stringify(result.data)}`);
  assert(Number(result.data.revision) === baseRevision + 1, `aspect ${value} patch did not increment one revision`);
  const applied = result.data.applied?.find((entry) => sameAspectEdit(entry, value));
  assert(applied?.mode === 'backend_patch', `aspect ${value} patch did not use server-authoritative backend mode`);
  return result.data;
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const created = await jsonRequest('/api/projects', token, {
      method: 'POST',
      body: JSON.stringify({
        name: `R single-panel aspect authority ${Date.now()}`,
        spec: { plot_type: 'custom', custom_script: script, script, script_language: 'r' },
      }),
    });
    assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
    projectId = created.data.id;

    const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'r' }),
    });
    assert(rendered.response.ok && rendered.data?.status === 'success', `initial R render failed: ${JSON.stringify(rendered.data)}`);
    const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
    const manifest = figure?.manifest;
    const panel = manifest?.objects?.find((object) => object?.id === 'subplot.0');
    const capability = panel?.propertyCapabilities?.find((item) => item?.prop === 'aspect');
    assert(manifest?.generatedBy === 'r_svg', 'renderer did not return an R manifest');
    assert(panel?.kind === 'subplot' && panel?.role === 'ggplot_panel', `unexpected root panel identity: ${JSON.stringify(panel)}`);
    assert(panel?.fingerprintVersion === 2, 'root panel is missing v2 identity');
    assert(capability?.replay === 'stable', `root aspect is not replayable: ${JSON.stringify(capability)}`);
    assert(JSON.stringify(capability?.scopes) === JSON.stringify(['figure']), `root aspect must remain figure-only: ${JSON.stringify(capability)}`);

    const initialRevision = Number(figure.revision || 1);
    await applyAspect(token, projectId, panel, 'equal', initialRevision);
    const equalFigure = await loadFigure(token, projectId);
    assert(equalFigure.editLog?.some((entry) => sameAspectEdit(entry, 'equal')), 'equal aspect did not persist');

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    const asset = exported.data?.figures?.[0]?.asset;
    assert(exported.response.ok && exported.data?.status === 'success', `R export failed: ${JSON.stringify(exported.data)}`);
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `R export did not save a restorable snapshot: ${JSON.stringify(asset)}`);

    await applyAspect(token, projectId, panel, 1.6, Number(equalFigure.revision));
    const changedFigure = await loadFigure(token, projectId);
    assert(changedFigure.editLog?.some((entry) => sameAspectEdit(entry, 1.6)), 'post-export aspect did not persist');

    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, token, { method: 'POST' });
    assert(restored.response.ok && restored.data?.status === 'success', `R aspect snapshot restore failed: ${JSON.stringify(restored.data)}`);
    const restoredFigure = await loadFigure(token, projectId);
    assert(restoredFigure.editLog?.some((entry) => sameAspectEdit(entry, 'equal')), 'snapshot restore lost export-time aspect');
    assert(!restoredFigure.editLog?.some((entry) => sameAspectEdit(entry, 1.6)), 'snapshot restore retained post-export aspect');

    console.log(JSON.stringify({
      status: 'PASS',
      checked: [
        'R root-panel aspect remains renderer-declared figure scope',
        'figure-scope aspect patch persists through server authority',
        'export snapshot restores the export-time aspect edit',
      ],
    }, null, 2));
  } finally {
    if (projectId) await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
