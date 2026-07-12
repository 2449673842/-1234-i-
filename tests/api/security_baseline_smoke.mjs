/**
 * API smoke test for the low-risk security baseline.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 *
 * Run:
 *   node tests/api/security_baseline_smoke.mjs
 */

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(authToken && (path.startsWith('/api/projects') || path.startsWith('/api/figure')) ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
}

async function registerTestUser() {
  const email = `security-owner-${Date.now()}@example.test`;
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Security-Test-Password-2026' }),
  });
  const data = await res.json().catch(() => null);
  assert(res.ok && data?.token, `Security test registration failed: ${res.status} ${JSON.stringify(data)}`);
  authToken = data.token;
}

async function testSecurityHeaders() {
  const res = await request('/api/projects');
  assert(res.headers.get('x-powered-by') === null, 'X-Powered-By header must not be exposed');
  assert(res.headers.get('x-content-type-options') === 'nosniff', 'Missing X-Content-Type-Options');
  assert(res.headers.get('x-frame-options') === 'SAMEORIGIN', 'Missing X-Frame-Options');
  assert(res.headers.get('referrer-policy') === 'no-referrer', 'Missing Referrer-Policy');
  assert((res.headers.get('permissions-policy') || '').includes('camera=()'), 'Missing Permissions-Policy');
}

async function testLargeJsonRejected() {
  const largeScript = 'x'.repeat(51 * 1024 * 1024);
  const res = await request('/api/figure/render', {
    method: 'POST',
    body: JSON.stringify({ script: largeScript }),
  });
  assert(res.status === 413, `Large JSON should be rejected with 413, got ${res.status}`);
  const data = await res.json().catch(() => null);
  assert(data?.status === 'error', 'Large JSON response should keep API error shape');
}

async function testAuthRateLimit() {
  const email = `security-smoke-${Date.now()}@example.invalid`;
  let limited = false;
  for (let i = 0; i < 25; i += 1) {
    const res = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '0');
      assert(retryAfter > 0, '429 response should include Retry-After');
      const data = await res.json().catch(() => null);
      assert(data?.status === 'error', '429 response should keep API error shape');
      limited = true;
      break;
    }
  }
  assert(limited, 'Auth limiter did not return 429 after repeated login attempts');
}

async function testAstLogOnlyDefault() {
  const script = [
    'import subprocess',
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(2, 1.5))',
    'ax.plot([0, 1], [0, 1])',
    'ax.set_title("AST log-only smoke")',
  ].join('\n');
  const res = await request('/api/figure/render', {
    method: 'POST',
    body: JSON.stringify({
      script,
      language: 'python',
      requestId: `security-ast-${Date.now()}`,
    }),
  });
  const data = await res.json().catch(() => null);
  assert(res.ok, `AST log-only render should not be blocked by default, got ${res.status} ${JSON.stringify(data)}`);
  assert(data?.status === 'success', `AST log-only render failed: ${JSON.stringify(data)}`);
}

async function main() {
  await testSecurityHeaders();
  await testLargeJsonRejected();
  await testAuthRateLimit();
  await registerTestUser();
  await testAstLogOnlyDefault();
  console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
