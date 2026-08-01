import Database from 'better-sqlite3';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let token = '';

async function requestJson(path, options = {}) {
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

async function main() {
  const registered = await requestJson('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `project-singleflight-${Date.now()}@example.test`,
      password: 'Project-Singleflight-2026',
    }),
  });
  assert(registered.response.ok && registered.data?.token, `registration failed: ${JSON.stringify(registered.data)}`);
  token = registered.data.token;

  let projectId = '';
  try {
    const script = [
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      'x = np.linspace(0, 8, 1200)',
      'fig, ax = plt.subplots(figsize=(5, 3))',
      'ax.plot(x, np.sin(x), color="#176b5b")',
      'ax.set_title("PROJECT_RENDER_SINGLEFLIGHT")',
    ].join('\n');
    const created = await requestJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Project render singleflight',
        spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
      }),
    });
    projectId = created.data?.id || '';
    assert(created.response.ok && projectId, `project creation failed: ${JSON.stringify(created.data)}`);

    const render = requestId => requestJson(`/api/projects/${projectId}/figures/render`, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: {}, language: 'python', requestId }),
    });
    const [first, second] = await Promise.all([
      render(`singleflight-a-${Date.now()}`),
      render(`singleflight-b-${Date.now()}`),
    ]);
    assert(first.response.ok && first.data?.status === 'success', `first render failed: ${JSON.stringify(first.data)}`);
    assert(second.response.ok && second.data?.status === 'success', `second render failed: ${JSON.stringify(second.data)}`);
    const sharedResponses = [first.data, second.data].filter(result => result?.singleFlight?.shared === true);
    assert(sharedResponses.length === 1, `identical concurrent renders were not shared exactly once: ${JSON.stringify([first.data?.singleFlight, second.data?.singleFlight])}`);
    assert(first.data.requestId?.startsWith('singleflight-a-'), `first response leaked requestId: ${JSON.stringify(first.data.requestId)}`);
    assert(second.data.requestId?.startsWith('singleflight-b-'), `second response leaked requestId: ${JSON.stringify(second.data.requestId)}`);
    assert(first.data.figures?.[0]?.svg === second.data.figures?.[0]?.svg, 'shared render responses returned different SVG output');

    const preview = await requestJson(`/api/projects/${projectId}/figures?includePreview=1`);
    assert(preview.response.ok && preview.data?.previewSource === 'cache', `singleflight render did not persist one reusable preview: ${JSON.stringify(preview.data)}`);

    assert(process.env.SCIFIGURE_TEST_ISOLATED === '1' && process.env.SCIFIGURE_DB_PATH, 'test requires an isolated database');
    const database = new Database(process.env.SCIFIGURE_DB_PATH);
    database.prepare('UPDATE project_figures SET preview_svg = NULL, preview_updated_at = NULL WHERE project_id = ?').run(projectId);
    database.close();
    const cacheMiss = await requestJson(`/api/projects/${projectId}/figures?includePreview=1&cacheOnly=1`);
    assert(cacheMiss.response.ok && cacheMiss.data?.previewSource === 'miss', `cache-only probe did not report a miss: ${JSON.stringify(cacheMiss.data)}`);
    assert(cacheMiss.data?.previewMissingFigureIds?.includes('fig_1'), `cache-only probe omitted missing Figure: ${JSON.stringify(cacheMiss.data)}`);
    assert(!cacheMiss.data?.figures?.[0]?.svg, 'cache-only probe unexpectedly rebuilt a missing SVG');

    const sequential = await render(`singleflight-sequential-${Date.now()}`);
    assert(sequential.response.ok && sequential.data?.status === 'success', `sequential render failed: ${JSON.stringify(sequential.data)}`);
    assert(!sequential.data?.singleFlight?.shared, `completed flight leaked into a later request: ${JSON.stringify(sequential.data?.singleFlight)}`);

    const failingScript = `${script}\nraise RuntimeError("SINGLEFLIGHT_EXPECTED_FAILURE")`;
    const renderFailure = requestId => requestJson(`/api/projects/${projectId}/figures/render`, {
      method: 'POST',
      body: JSON.stringify({ script: failingScript, editLogs: {}, language: 'python', requestId }),
    });
    const [failedFirst, failedSecond] = await Promise.all([
      renderFailure(`singleflight-error-a-${Date.now()}`),
      renderFailure(`singleflight-error-b-${Date.now()}`),
    ]);
    assert(failedFirst.data?.status !== 'success' && failedSecond.data?.status !== 'success', 'failing renderer unexpectedly succeeded');
    assert([failedFirst.data, failedSecond.data].filter(result => result?.singleFlight?.shared === true).length === 1, 'renderer failures were not shared exactly once');

    const recovered = await render(`singleflight-recovered-${Date.now()}`);
    assert(recovered.response.ok && recovered.data?.status === 'success', `render did not recover after a failed flight: ${JSON.stringify(recovered.data)}`);
    assert(!recovered.data?.singleFlight?.shared, 'failed flight remained cached after completion');
    console.log('PASS project render single-flight isolates request IDs and clears successful and failed flights');
  } finally {
    if (projectId) await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
