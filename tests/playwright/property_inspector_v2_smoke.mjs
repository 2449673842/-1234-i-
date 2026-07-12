import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3200';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `property-inspector-v2-${RUN_ID}`);
const results = [];
const REQUIRE_CAPABILITY_MANIFEST = process.env.SCIFIGURE_REQUIRE_CAPABILITY_MANIFEST === '1';

function record(id, ok, evidence) {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ id, status, evidence });
  console.log(`${status} ${id}: ${evidence}`);
}

async function requestJson(token, pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: bearerHeaders(token, {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function verifyStagingProvenance() {
  const runtime = await fetch(BASE_URL);
  const profile = runtime.headers.get('x-scifigure-runtime-profile');
  const markerResponse = await fetch(`${BASE_URL}/unified-editing-build.json`, { cache: 'no-store' });
  const marker = await markerResponse.json().catch(() => null);
  const valid = runtime.ok
    && profile === 'unified-editing-staging'
    && markerResponse.ok
    && marker?.kind === 'unified-editing-staging'
    && marker?.propertyDescriptorV1 === true
    && marker?.propertyInspectorV2 === true;
  if (!valid) {
    throw new Error(`Refusing non-staging target: profile=${profile}, marker=${JSON.stringify(marker)}`);
  }
  return { profile, marker };
}

async function cleanupFixtureProjects(token) {
  const data = await requestJson(token, '/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter(project => String(project.name || '').startsWith('Property inspector V2 smoke'))
    .map(project => requestJson(token, `/api/projects/${project.id || project.projectId}`, { method: 'DELETE' }).catch(() => null)));
}

async function prepareFixture(token) {
  const script = [
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(5, 3.5))',
    'ax.plot([0, 1, 2], [1, 3, 2], color="#225577", linewidth=1.5)',
    'ax.set_title("Property Inspector V2")',
    'ax.set_xlabel("X axis")',
    'ax.set_ylabel("Y axis")',
    'plt.tight_layout()',
  ].join('\n');
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson(token, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Property inspector V2 smoke ${Date.now()}`, spec }),
  });
  const rendered = await requestJson(token, `/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `property-inspector-v2-${Date.now()}`,
    }),
  });
  const first = rendered.figures?.[0];
  if (!first?.manifest || !first?.svg) throw new Error('Fixture render returned no Figure');
  const title = first.manifest.objects?.find(object => (
    object.id.startsWith('title.')
    && (
      object.propertyCapabilities?.some(capability => capability.prop === 'fontsize')
      || object.editable?.includes('fontsize')
    )
  ));
  if (!title) throw new Error('Fixture has no editable title text');
  return {
    projectId: created.id,
    spec,
    first,
    title,
    capabilityBacked: Array.isArray(title.propertyCapabilities),
  };
}

async function waitForWorkspace(page) {
  await page.waitForFunction(() => (
    document.body.textContent?.includes('属性编辑')
    && document.querySelectorAll('svg').length > 0
  ), undefined, { timeout: 90000 });
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ spec, projectId, first }) => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'Property inspector V2 smoke',
      projectFigures: {
        [first.figureId]: {
          figureId: first.figureId,
          index: 0,
          manifest: first.manifest,
          editLog: first.editLog || [],
          revision: first.revision || 1,
          svg: first.svg,
          fingerprint: first.fingerprint,
          codeSlice: first.codeSlice || null,
          renderStatus: 'success',
        },
      },
      activeFigureId: first.figureId,
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Property inspector V2 fixture ready'],
      figSession: null,
    }));
  }, fixture);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspace(page);
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const provenance = await verifyStagingProvenance();
  record('P2-provenance', true, `profile=${provenance.profile}, buildId=${provenance.marker.buildId}`);
  const token = await authenticateCapabilitySmokeUser(BASE_URL, 'property inspector v2');
  await cleanupFixtureProjects(token);
  const fixture = await prepareFixture(token);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, token);
  const page = await context.newPage();
  const consoleErrors = [];
  const patchRequests = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', request => {
    if (request.url().includes('/api/figure/patch')) {
      patchRequests.push(JSON.parse(request.postData() || '{}'));
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await installFixtureState(page, fixture);
    await page.locator(`[id="${fixture.title.id}"]`).first().click({ force: true });
    await page.locator('[data-property-inspector-version="2"]').waitFor({ state: 'visible', timeout: 10000 });

    const v2Count = await page.locator('[data-property-inspector-version="2"]').count();
    const fontSizeControls = page.locator(`input[data-param-role="number"][data-param-gid="${fixture.title.id}"][data-param-prop="fontsize"]`);
    const fontSizeCount = await fontSizeControls.count();
    const fontFamilyCount = await page.locator(`[data-property-control="fontfamily"][data-param-gid="${fixture.title.id}"]`).count();
    record('P2-visibility', v2Count === 1 && fontSizeCount === 1 && fontFamilyCount === 1,
      `inspector=${v2Count}, fontsize=${fontSizeCount}, fontfamily=${fontFamilyCount}, capabilityBacked=${fixture.capabilityBacked}`);
    record(
      'P2-capability-source',
      fixture.capabilityBacked || !REQUIRE_CAPABILITY_MANIFEST,
      `capabilityBacked=${fixture.capabilityBacked}, required=${REQUIRE_CAPABILITY_MANIFEST}`,
    );

    const fontSize = fontSizeControls.first();
    await fontSize.fill('17');
    await fontSize.blur();
    await page.waitForTimeout(300);
    const draftVisible = (await page.textContent('body') || '').includes('已暂存');
    record('P2-draft', draftVisible, `draftVisible=${draftVisible}`);

    const responsePromise = page.waitForResponse(response => (
      response.url().includes('/api/figure/patch')
      && response.status() >= 200
      && response.status() < 300
    ), { timeout: 90000 });
    await page.getByRole('button', { name: /应用当前图/ }).first().click();
    await responsePromise;
    await waitForWorkspace(page);
    const patches = patchRequests.at(-1)?.patches || [];
    const expectedMode = fixture.title.propertyCapabilities?.find(capability => capability.prop === 'fontsize')?.patchMode
      || 'backend_patch';
    const exactPatch = patches.length === 1
      && patches[0]?.gid === fixture.title.id
      && patches[0]?.prop === 'fontsize'
      && Number(patches[0]?.value) === 17
      && patches[0]?.mode === expectedMode;
    record('P2-exact-patch', exactPatch, `expectedMode=${expectedMode}, patches=${JSON.stringify(patches)}`);
    record('P2-console', consoleErrors.length === 0, `consoleErrors=${consoleErrors.length}`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'property-inspector-v2.png'), fullPage: true });
  } finally {
    await browser.close();
    await requestJson(token, `/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

try {
  await run();
} catch (error) {
  record('HARNESS', false, error?.stack || String(error));
}

const failCount = results.filter(result => result.status === 'FAIL').length;
const report = [
  '# Property Inspector V2 Browser Smoke',
  '',
  `- Time: ${new Date().toISOString()}`,
  `- URL: ${BASE_URL}`,
  `- Conclusion: ${failCount === 0 ? 'PASS' : 'FAIL'}`,
  '',
  '| ID | Status | Evidence |',
  '|---|---|---|',
  ...results.map(result => `| ${result.id} | ${result.status} | ${String(result.evidence).replace(/\|/g, '\\|')} |`),
].join('\n');
fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report, 'utf8');
console.log(`Report: ${path.join(OUTPUT_DIR, 'report.md')}`);
process.exitCode = failCount === 0 ? 0 : 1;
