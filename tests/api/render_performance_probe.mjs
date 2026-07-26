const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPerformanceEnvelope(data, language) {
  const perf = data?.performance;
  assert(perf?.schemaVersion === '1.0', `${language} render did not expose performance schema v1.0`);
  assert(perf.cacheHit === false, `${language} direct render unexpectedly reported a cache hit`);
  assert(perf.renderer && perf.renderer.totalMs >= 0, `${language} renderer timing is missing`);
  assert(perf.runtime && perf.runtime.totalMs >= 0, `${language} runtime timing is missing`);
  assert(perf.runtime.mode === 'local' || perf.runtime.mode === 'docker', `${language} runtime mode is invalid`);
  assert(perf.server && perf.server.totalMs >= 0, `${language} server timing is missing`);
  assert(perf.server.totalMs >= perf.runtime.totalMs, `${language} server total is shorter than renderer runtime`);
  if (language === 'r') {
    for (const key of [
      'scriptEvalMs',
      'semanticPreflightMs',
      'editResolutionMs',
      'editApplyMs',
      'ggplotRenderMs',
      'deviceOpenMs',
      'deviceCloseMs',
    ]) {
      assert(Number.isFinite(perf.renderer[key]) && perf.renderer[key] >= 0, `r renderer timing ${key} is missing`);
    }
    assert(!Object.hasOwn(perf.renderer, 'packageLoadMs'), 'r renderer must not fabricate packageLoadMs');
  }
}

async function main() {
  const registered = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `perf-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Performance-Probe-Password-2026',
    }),
  });
  const auth = await registered.json();
  if (!registered.ok || !auth.token) throw new Error(`Registration failed: ${JSON.stringify(auth)}`);

  const run = async (language, script) => {
    const startedAt = performance.now();
    const response = await fetch(`${BASE_URL}/api/figure/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ language, script }),
    });
    const data = await response.json().catch(() => null);
    assert(response.ok && data?.status === 'success', `${language} render failed: ${JSON.stringify(data)}`);
    assertPerformanceEnvelope(data, language);
    return {
      language,
      status: data.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      performance: data.performance,
    };
  };

  const pythonScript = [
    'import matplotlib.pyplot as plt',
    'import numpy as np',
    'x = np.linspace(0, 10, 2000)',
    'fig, ax = plt.subplots(figsize=(5, 3))',
    'ax.plot(x, np.sin(x), label="sin")',
    'ax.scatter(x[::50], np.cos(x[::50]), s=12, label="cos")',
    'ax.legend()',
  ].join('\n');
  const rScript = [
    'library(ggplot2)',
    'df <- data.frame(x = seq(0, 10, length.out = 2000))',
    'df$y <- sin(df$x)',
    'p <- ggplot(df, aes(x, y)) + geom_line() + theme_classic()',
    'print(p)',
  ].join('\n');

  const results = [];
  results.push(await run('python', pythonScript));
  results.push(await run('python', pythonScript));
  results.push(await run('python', pythonScript));
  results.push(await run('r', rScript));
  const concurrentStartedAt = performance.now();
  const concurrent = await Promise.all([
    run('python', pythonScript),
    run('python', pythonScript),
    run('python', pythonScript),
    run('python', pythonScript),
  ]);
  console.log(JSON.stringify({
    status: 'PASS',
    baseUrl: BASE_URL,
    results,
    concurrent,
    concurrentWallMs: Math.round(performance.now() - concurrentStartedAt),
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
