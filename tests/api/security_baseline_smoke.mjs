/**
 * API smoke test for the low-risk security baseline.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 *
 * Run:
 *   node tests/api/security_baseline_smoke.mjs
 */

import Database from 'better-sqlite3';

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
  const csp = res.headers.get('content-security-policy-report-only') || '';
  assert(csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), 'Missing CSP Report-Only security boundary');
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

  const spoofedEmail = `xff-spoof-${Date.now()}@example.invalid`;
  let spoofLimited = false;
  for (let i = 0; i < 25; i += 1) {
    const res = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` },
      body: JSON.stringify({ email: spoofedEmail, password: 'wrong-password' }),
    });
    if (res.status === 429) {
      spoofLimited = true;
      break;
    }
  }
  assert(spoofLimited, 'Untrusted X-Forwarded-For values must not bypass auth rate limiting');
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

async function testImportedSvgSafetyBoundary() {
  const projectResponse = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: 'SVG security boundary',
      spec: { plot_type: 'custom', script_language: 'python' },
    }),
  });
  const project = await projectResponse.json().catch(() => null);
  assert(projectResponse.ok && project?.id, `SVG security project failed: ${projectResponse.status} ${JSON.stringify(project)}`);

  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="10" height="10"/></clipPath></defs><rect clip-path="url(#c)" width="10" height="10" fill="#176b5b"/></svg>';
  const metadataWithDangerousKey = JSON.parse('{"kind":"composite","__proto__":{"polluted":true}}');
  const safeResponse = await request(`/api/projects/${project.id}/export-assets/import`, {
    method: 'POST',
    body: JSON.stringify({ format: 'svg', name: 'n'.repeat(500), svg: safeSvg, metadata: metadataWithDangerousKey }),
  });
  const safeAsset = await safeResponse.json().catch(() => null);
  assert(safeResponse.ok, `Safe SVG import failed: ${safeResponse.status} ${JSON.stringify(safeAsset)}`);
  assert(safeAsset?.asset?.name?.length === 160, 'Export asset names must be bounded before persistence');
  assert(!safeAsset?.asset?.metadata?.__proto__?.polluted, 'Dangerous export metadata keys must be removed');
  assert(!/[\\/]/.test(safeAsset?.asset?.filePath || ''), `Export API must not expose server storage paths: ${safeAsset?.asset?.filePath}`);

  const maliciousPayloads = [
    '<svg xmlns="http://www.w3.org/2000/svg" onload=alert(1)></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.invalid"/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.invalid/payload.svg#x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.invalid/pixel)"/></svg>',
  ];
  for (const [index, svg] of maliciousPayloads.entries()) {
    const response = await request(`/api/projects/${project.id}/export-assets/import`, {
      method: 'POST',
      body: JSON.stringify({ format: 'svg', name: `unsafe-${index}`, svg }),
    });
    assert(response.status === 400, `Unsafe SVG ${index} should be rejected with 400, got ${response.status} ${await response.text()}`);
  }
  return project.id;
}

async function testUploadedFileSignatures(projectId) {
  const fakeWorkbook = new FormData();
  fakeWorkbook.append('file', new Blob(['<html>not an xlsx workbook</html>'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'fake.xlsx');
  const fakeWorkbookResponse = await request(`/api/projects/${projectId}/files`, { method: 'POST', body: fakeWorkbook });
  assert(fakeWorkbookResponse.status === 400, `Fake XLSX should be rejected with 400, got ${fakeWorkbookResponse.status} ${await fakeWorkbookResponse.text()}`);

  const fakeText = new FormData();
  fakeText.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])], { type: 'text/csv' }), 'fake.csv');
  const fakeTextResponse = await request(`/api/projects/${projectId}/files`, { method: 'POST', body: fakeText });
  assert(fakeTextResponse.status === 400, `Binary CSV should be rejected with 400, got ${fakeTextResponse.status} ${await fakeTextResponse.text()}`);

  const validText = new FormData();
  validText.append('file', new Blob(['sample,value\nA,1\n'], { type: 'text/csv' }), 'valid.csv');
  const validTextResponse = await request(`/api/projects/${projectId}/files`, { method: 'POST', body: validText });
  assert(validTextResponse.ok, `Valid CSV upload failed: ${validTextResponse.status} ${await validTextResponse.text()}`);
  const listedFilesResponse = await request(`/api/projects/${projectId}/files`);
  const listedFiles = await listedFilesResponse.json().catch(() => null);
  const listedValidFile = listedFiles?.datasets?.find(dataset => dataset.fileName === 'valid.csv');
  assert(listedFilesResponse.ok && listedValidFile, 'Uploaded CSV must remain available after validation');
  assert(listedValidFile.filePath === listedValidFile.fileName, `Dataset API must expose only a logical filename, got ${listedValidFile.filePath}`);

  const wideText = new FormData();
  wideText.append('file', new Blob([`${Array.from({ length: 2049 }, (_, index) => `c${index}`).join(',')}\n`], { type: 'text/csv' }), 'too-wide.csv');
  const wideTextResponse = await request(`/api/projects/${projectId}/files`, { method: 'POST', body: wideText });
  assert(wideTextResponse.status === 413, `Over-wide CSV should be rejected with 413, got ${wideTextResponse.status} ${await wideTextResponse.text()}`);

  const fakePngResponse = await request(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    body: JSON.stringify({ format: 'png', name: 'fake-png', binary_b64: Buffer.from('not png').toString('base64') }),
  });
  assert(fakePngResponse.status === 400, `Fake PNG should be rejected with 400, got ${fakePngResponse.status} ${await fakePngResponse.text()}`);

  const validPngResponse = await request(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    body: JSON.stringify({
      format: 'png',
      name: 'valid-png',
      binary_b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    }),
  });
  assert(validPngResponse.ok, `Valid PNG import failed: ${validPngResponse.status} ${await validPngResponse.text()}`);
}

async function testResourceBudgets(projectId) {
  const tooManyAssetIds = Array.from({ length: 201 }, (_, index) => `asset-${index}`);
  const projectArchive = await request(`/api/projects/${projectId}/export-assets/zip`, {
    method: 'POST',
    body: JSON.stringify({ assetIds: tooManyAssetIds }),
  });
  assert(projectArchive.status === 413, `Project archive count ceiling should return 413, got ${projectArchive.status} ${await projectArchive.text()}`);

  const globalArchive = await request('/api/export-assets/zip', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ assetIds: tooManyAssetIds }),
  });
  assert(globalArchive.status === 413, `Global archive count ceiling should return 413, got ${globalArchive.status} ${await globalArchive.text()}`);

  const tooWideRow = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`c${index}`, index]));
  const render = await request('/api/figure/render', {
    method: 'POST',
    body: JSON.stringify({
      script: 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])',
      dataPayload: { custom_data: [tooWideRow] },
    }),
  });
  assert(render.status === 413, `Renderer custom_data ceiling should return 413 before execution, got ${render.status} ${await render.text()}`);

  const oversizedSessionScript = await request('/api/figure/render', {
    method: 'POST',
    body: JSON.stringify({ script: `#${'x'.repeat(2 * 1024 * 1024)}` }),
  });
  assert(oversizedSessionScript.status === 413, `Oversized session script should return 413 before execution, got ${oversizedSessionScript.status} ${await oversizedSessionScript.text()}`);

  const oversizedProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: 'oversized-project-record',
      spec: { plot_type: 'custom', padding: 'x'.repeat(4 * 1024 * 1024) },
    }),
  });
  assert(oversizedProject.status === 413, `Oversized project record should return 413, got ${oversizedProject.status} ${await oversizedProject.text()}`);
}

async function testExportImportHonorsGlobalUploadBudget(projectId) {
  if (process.env.SCIFIGURE_TEST_ISOLATED !== '1' || !process.env.SCIFIGURE_DB_PATH) return;
  const wrongContentType = await request(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'not-json',
  });
  assert(wrongContentType.status === 415, `Export asset import should require JSON, got ${wrongContentType.status} ${await wrongContentType.text()}`);

  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  const windowStartMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const configuredMb = Number(process.env.SCIFIGURE_GLOBAL_UPLOAD_MAX_MB_PER_HOUR || 1024);
  const globalLimitBytes = Math.max(100, Number.isFinite(configuredMb) ? configuredMb : 1024) * 1024 * 1024;
  const importPayload = {
    format: 'svg',
    name: 'must-not-persist',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
  };
  const compactBody = JSON.stringify(importPayload);
  const paddedBody = `${' '.repeat(4096)}${compactBody}`;
  const compactBytes = Buffer.byteLength(compactBody, 'utf8');
  database.prepare(`
    INSERT INTO global_usage_budgets (category, window_start, amount, updated_at)
    VALUES ('upload_bytes', ?, ?, datetime('now'))
    ON CONFLICT(category, window_start) DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')
  `).run(windowStart, globalLimitBytes - compactBytes - 1);
  const before = database.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId).count;
  database.close();

  const malformedResponse = await request(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    body: `${' '.repeat(4096)}{`,
  });
  assert(malformedResponse.status === 429, `Malformed JSON should still consume captured upload bytes, got ${malformedResponse.status} ${await malformedResponse.text()}`);

  const response = await request(`/api/projects/${projectId}/export-assets/import`, {
    method: 'POST',
    body: paddedBody,
  });
  assert(response.status === 429, `Export asset import should meter original padded JSON bytes, got ${response.status} ${await response.text()}`);

  const verifyDatabase = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  const after = verifyDatabase.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId).count;
  verifyDatabase.close();
  assert(after === before, 'Rejected export asset import must not persist a file record');
}

async function main() {
  await testSecurityHeaders();
  await testLargeJsonRejected();
  await testAuthRateLimit();
  await registerTestUser();
  const securityProjectId = await testImportedSvgSafetyBoundary();
  await testUploadedFileSignatures(securityProjectId);
  await testResourceBudgets(securityProjectId);
  await testExportImportHonorsGlobalUploadBudget(securityProjectId);
  await testAstLogOnlyDefault();
  console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
