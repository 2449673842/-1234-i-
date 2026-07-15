/**
 * Public editing regressions smoke.
 *
 * Requires SCIFIGURE_URL to point at a non-production unified-editing staging
 * target. This intentionally refuses localhost:3000 and production builds.
 */

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
const BASE_URL = process.env.SCIFIGURE_URL || '';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `public-editing-regressions-${RUN_ID}`);
const ALLOW_PRODUCTION_TARGET = process.env.SCIFIGURE_ALLOW_PRODUCTION_TARGET === '1';
const EXPECTED_BUILD_ID = process.env.SCIFIGURE_EXPECTED_BUILD_ID || '';

const results = [];
const consoleErrors = [];
const pageErrors = [];
const apiRequests = [];
let authToken = '';

const fixtureScript = [
  'import matplotlib as mpl',
  'mpl.rcParams["svg.fonttype"] = "none"',
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots(figsize=(5, 3.5))',
  'ax.plot([0, 1, 2, 3], [1, 3, 2, 4], color="#225577", linewidth=1.5, marker="o", label="Signal")',
  'ax.scatter([0, 1, 2, 3], [1.2, 2.8, 2.2, 3.7], c="#cc5500", s=45, label="Points")',
  'ax.set_title("Public Editing Regression")',
  'ax.set_xlabel("Dose")',
  'ax.set_ylabel("Response")',
  'ax.legend(loc="upper left")',
  'plt.tight_layout()',
].join('\n');

function record(id, ok, evidence) {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ id, status, evidence });
  console.log(`${status} ${id}: ${evidence}`);
}

function fail(id, evidence) {
  record(id, false, evidence);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/[^']+:24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

function isPatchOrRenderUrl(url) {
  return url.includes('/api/figure/patch') || /\/api\/projects\/[^/]+\/figures\/render$/.test(new URL(url).pathname);
}

function assertSafeTarget() {
  if (!BASE_URL) {
    throw new Error('SCIFIGURE_URL is required; refusing to default to localhost.');
  }
  const url = new URL(BASE_URL);
  const host = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  if (host === 'localhost:3000' || host === '127.0.0.1:3000' || host === '[::1]:3000') {
    throw new Error(`Refusing forbidden local target ${BASE_URL}`);
  }
}

async function verifyTargetProvenance() {
  assertSafeTarget();
  const runtime = await fetch(BASE_URL, { cache: 'no-store' });
  const profile = runtime.headers.get('x-scifigure-runtime-profile') || '';
  const markerResponse = await fetch(`${BASE_URL}/unified-editing-build.json`, { cache: 'no-store' });
  const marker = await markerResponse.json().catch(() => null);
  const productionLike = /production/i.test(profile)
    || /production/i.test(String(marker?.kind || ''))
    || /prod/i.test(String(marker?.runtime || ''));
  const stagingLike = profile === 'unified-editing-staging'
    || marker?.kind === 'unified-editing-staging'
    || marker?.propertyInspectorV2 === true
    || marker?.fontControlsV2 === true;
  const allowedProduction = productionLike
    && ALLOW_PRODUCTION_TARGET
    && Boolean(EXPECTED_BUILD_ID)
    && marker?.buildId === EXPECTED_BUILD_ID;
  if ((!allowedProduction && (productionLike || !stagingLike)) || !runtime.ok || !markerResponse.ok) {
    throw new Error(`Refusing unverified or production target: profile=${profile}, marker=${JSON.stringify(marker)}`);
  }
  return { profile, marker };
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: bearerHeaders(authToken, {
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

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter(project => String(project?.name || '').startsWith('Public editing regressions smoke'))
    .map(project => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function createFixture() {
  const spec = {
    plot_type: 'custom',
    custom_script: fixtureScript,
    script: fixtureScript,
    script_language: 'python',
    figure: { width: 125, height: 90, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Public editing regressions smoke ${Date.now()}`, spec }),
  });
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: fixtureScript,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `public-editing-regressions-${Date.now()}`,
    }),
  });
  const first = rendered.figures?.[0];
  if (rendered.status !== 'success' || !first?.manifest || !first?.svg) {
    throw new Error(`Fixture render failed: ${JSON.stringify(rendered).slice(0, 500)}`);
  }
  const objects = first.manifest.objects || [];
  const title = objects.find(object => object.id?.startsWith('title.') && supportsProp(object, 'text') && supportsProp(object, 'fontfamily'))
    || objects.find(object => object.kind === 'text' && supportsProp(object, 'fontfamily'));
  const axisObjects = objects.filter(object => object.kind === 'axis_x' || object.kind === 'axis_y');
  if (!title) throw new Error('Fixture has no editable text object with fontfamily support');
  if (axisObjects.length < 2) throw new Error(`Fixture has insufficient axis objects: ${axisObjects.map(item => item.id).join(',')}`);
  return { projectId: created.id, spec, first, title, axisObjects };
}

function supportsProp(object, prop) {
  return object?.editable?.includes(prop)
    || object?.propertyCapabilities?.some(capability => capability.prop === prop && capability.replay !== 'unsupported')
    || Object.prototype.hasOwnProperty.call(object?.currentProps || {}, prop);
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ projectId, spec, first }) => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'Public editing regressions smoke',
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
      selectedFigureIds: [],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Public editing regressions fixture ready'],
      figSession: null,
    }));
  }, fixture);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspace(page);
}

async function waitForWorkspace(page) {
  await page.waitForFunction(() => (
    document.body.textContent?.includes('属性编辑')
    && document.querySelectorAll('svg').length > 0
  ), undefined, { timeout: 90000 });
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function readRuntimeFigure(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return null;
    const state = JSON.parse(raw);
    const figureId = state.activeFigureId || 'fig_1';
    return state.projectFigures?.[figureId] || null;
  });
}

async function clickCenter(page, accessibleName) {
  const button = page.getByRole('button', { name: accessibleName, exact: true }).last();
  if (!(await button.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(500);
  return true;
}

async function selectObject(page, gid) {
  await page.waitForFunction((targetId) => Boolean(document.getElementById(targetId)), gid, { timeout: 10000 });
  await page.evaluate((targetId) => {
    document.getElementById(targetId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, gid);
  await page.locator(`[data-param-gid="${gid}"], [data-property-inspector-version="2"]`).first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

async function applyCurrentDraft(page) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse(response => (
    response.url().includes('/api/figure/patch')
    && response.status() >= 200
    && response.status() < 300
  ), { timeout: 90000 });
  await page.getByRole('button', { name: /应用当前图/ }).first().click();
  const response = await responsePromise;
  const responseData = await response.json().catch(() => null);
  await waitForWorkspace(page);
  const recent = apiRequests.slice(start);
  const patchRequest = recent.find(request => request.url.includes('/api/figure/patch')) || null;
  return {
    patchBody: parseJson(patchRequest?.postData),
    responseData,
    patchRequests: recent.filter(request => request.url.includes('/api/figure/patch')),
    renderRequests: recent.filter(request => /\/api\/projects\/[^/]+\/figures\/render$/.test(new URL(request.url).pathname)),
    patchRenderRequests: recent.filter(request => isPatchOrRenderUrl(request.url)),
  };
}

async function clickImmediateTextApply(page) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse(response => (
    response.url().includes('/api/figure/patch')
    && response.status() >= 200
    && response.status() < 300
  ), { timeout: 90000 });
  await page.getByRole('button', { name: '立即应用', exact: true }).first().click();
  const response = await responsePromise;
  const responseData = await response.json().catch(() => null);
  await waitForWorkspace(page);
  const recent = apiRequests.slice(start);
  const patchRequest = recent.find(request => request.url.includes('/api/figure/patch')) || null;
  return {
    patchBody: parseJson(patchRequest?.postData),
    responseData,
    patchRequests: recent.filter(request => request.url.includes('/api/figure/patch')),
    renderRequests: recent.filter(request => /\/api\/projects\/[^/]+\/figures\/render$/.test(new URL(request.url).pathname)),
    patchRenderRequests: recent.filter(request => isPatchOrRenderUrl(request.url)),
  };
}

function timesLike(value) {
  return /times|nimbus\s*roman|liberation\s*serif|(^|[,;"'\s])serif([,;"'\s]|$)/i.test(String(value || ''))
    && !/dejavu/i.test(String(value || ''));
}

function svgGroupByGid(svg, gid) {
  const escapedGid = String(gid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(svg || '').match(new RegExp(`<g id="${escapedGid}">[\\s\\S]*?</g>`))?.[0] || '';
}

async function runFontFamilyRegression(page, fixture) {
  await clickCenter(page, '属性编辑');
  await selectObject(page, fixture.title.id);
  const familyControl = page.locator(`[data-property-control="fontfamily"][data-param-gid="${fixture.title.id}"]`).first();
  await familyControl.waitFor({ state: 'visible', timeout: 10000 });
  await familyControl.selectOption('Times New Roman');
  await page.waitForTimeout(500);
  const draftVisible = (await getBodyText(page)).includes('已暂存');
  const applied = await applyCurrentDraft(page);
  const patches = patchList(applied.patchBody);
  const responseFigure = {
    manifest: applied.responseData?.manifest,
    svg: applied.responseData?.svg || '',
  };
  if (responseFigure.svg) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'times-fontfamily-response.svg'), responseFigure.svg, 'utf8');
  }
  const responseObject = responseFigure.manifest?.objects?.find(object => object.id === fixture.title.id);
  const runtimeFigure = await readRuntimeFigure(page);
  const runtimeObject = runtimeFigure?.manifest?.objects?.find(object => object.id === fixture.title.id);
  const requestedTimes = patches.some(patch => (
    patch.gid === fixture.title.id
    && patch.prop === 'fontfamily'
    && patch.value === 'Times New Roman'
  ));
  const manifestTimes = timesLike(responseObject?.currentProps?.fontfamily || runtimeObject?.currentProps?.fontfamily);
  const resolvedFamily = responseObject?.currentProps?.resolvedFontfamily || runtimeObject?.currentProps?.resolvedFontfamily || '';
  const resolvedActualTimes = /Times New Roman/i.test(resolvedFamily);
  const targetSvg = svgGroupByGid(responseFigure.svg || runtimeFigure?.svg || '', fixture.title.id);
  const svgRequestedTimes = /Times New Roman/i.test(targetSvg);
  const svgTimesCompatible = timesLike(targetSvg);
  record(
    'PUB-1-times-fontfamily',
    draftVisible && requestedTimes && manifestTimes && resolvedActualTimes && svgRequestedTimes && svgTimesCompatible,
    `draft=${draftVisible}, patches=${JSON.stringify(patches)}, manifestFamily=${responseObject?.currentProps?.fontfamily || runtimeObject?.currentProps?.fontfamily}, resolvedFamily=${resolvedFamily}, resolvedActualTimes=${resolvedActualTimes}, svgRequestedTimes=${svgRequestedTimes}, svgTimesCompatible=${svgTimesCompatible}, targetSvg=${JSON.stringify(targetSvg.slice(0, 300))}, patchRequests=${applied.patchRequests.length}`,
  );
}

async function runTextToolbarRegression(page, fixture) {
  await clickCenter(page, '属性编辑');
  await selectObject(page, fixture.title.id);
  const textarea = page.locator(`textarea[data-param-role="text"][data-param-gid="${fixture.title.id}"][data-param-prop="text"]`).first();
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  await textarea.fill('Rate CO2 x2');
  await textarea.evaluate(node => {
    const at = node.value.indexOf('2');
    node.focus();
    node.setSelectionRange(at, at + 1);
  });
  await page.getByRole('button', { name: '下标 x₂', exact: true }).first().click();
  await page.waitForTimeout(100);
  await textarea.evaluate(node => {
    const at = node.value.lastIndexOf('2');
    node.focus();
    node.setSelectionRange(at, at + 1);
  });
  await page.getByRole('button', { name: '上标 x²', exact: true }).first().click();
  await page.waitForTimeout(100);
  await textarea.evaluate(node => {
    const at = node.value.indexOf('Rate') + 'Rate'.length;
    node.focus();
    node.setSelectionRange(at, at);
  });
  await page.getByRole('button', { name: '换行 ↵', exact: true }).first().click();
  await page.waitForTimeout(100);
  const changedValue = await textarea.inputValue();
  const localDraftVisible = await page.locator('[title="已修改（未保存至引擎）"]').count() > 0;
  const toolbarDraftVisible = (await getBodyText(page)).includes('已暂存');
  const applied = await clickImmediateTextApply(page);
  const patches = patchList(applied.patchBody);
  const runtimeFigure = await readRuntimeFigure(page);
  const runtimeObject = runtimeFigure?.manifest?.objects?.find(object => object.id === fixture.title.id);
  const responseObject = applied.responseData?.manifest?.objects?.find(object => object.id === fixture.title.id);
  const manifestText = responseObject?.currentProps?.text || runtimeObject?.currentProps?.text || '';
  const svgText = applied.responseData?.svg || runtimeFigure?.svg || '';
  const responseHasManifestSvg = Boolean(applied.responseData?.manifest?.objects?.length && applied.responseData?.svg);
  const controlsChangedTextarea = changedValue.includes('\n') && changedValue.includes('$^{2}$') && changedValue.includes('$_{2}$');
  const immediateSinglePatchRender = applied.patchRenderRequests.length === 1
    && applied.patchRequests.length === 1
    && patches.length === 1;
  const textUpdated = patches[0]?.gid === fixture.title.id
    && patches[0]?.prop === 'text'
    && patches[0]?.value === changedValue
    && manifestText === changedValue
    && svgText.includes('Rate');
  record(
    'PUB-2-text-toolbar-immediate-apply',
    controlsChangedTextarea && localDraftVisible && toolbarDraftVisible && responseHasManifestSvg && immediateSinglePatchRender && textUpdated,
    `changed=${JSON.stringify(changedValue)}, localDraft=${localDraftVisible}, toolbarDraft=${toolbarDraftVisible}, responseManifestSvg=${responseHasManifestSvg}, patchRender=${applied.patchRenderRequests.length}, patches=${JSON.stringify(patches)}, manifestText=${JSON.stringify(manifestText)}`,
  );
}

async function runCrossCenterDraftRegression(page, fixture) {
  await clickCenter(page, '属性编辑');
  await selectObject(page, fixture.title.id);
  const fontSize = page.locator(`input[data-param-role="number"][data-param-gid="${fixture.title.id}"][data-param-prop="fontsize"]`).first();
  await fontSize.waitFor({ state: 'visible', timeout: 10000 });
  await fontSize.fill('18');
  await fontSize.evaluate(node => node.blur());
  await page.waitForTimeout(500);
  const initialDraftVisible = (await getBodyText(page)).includes('已暂存');
  await page.waitForTimeout(5500);
  const survivedAutosaveDelay = (await getBodyText(page)).includes('已暂存');
  const centers = ['字体中心', '组件中心', '配色中心', '属性编辑'];
  const visibility = [];
  for (const center of centers) {
    await clickCenter(page, center);
    visibility.push({ center, draft: (await getBodyText(page)).includes('已暂存') });
  }
  const applyEnabled = await page.getByRole('button', { name: /应用当前图/ }).first().isEnabled().catch(() => false);
  const applied = await applyCurrentDraft(page);
  const patches = patchList(applied.patchBody);
  const applicable = applied.patchRequests.length === 1
    && patches.some(patch => patch.gid === fixture.title.id && patch.prop === 'fontsize' && Number(patch.value) === 18);
  record(
    'PUB-3-draft-survives-center-switches',
    initialDraftVisible && survivedAutosaveDelay && visibility.every(item => item.draft) && applyEnabled && applicable,
    `initial=${initialDraftVisible}, after5s=${survivedAutosaveDelay}, visibility=${JSON.stringify(visibility)}, enabled=${applyEnabled}, patches=${JSON.stringify(patches)}`,
  );
}

async function runAxisSystemTypographyControlsRegression(page, fixture) {
  await clickCenter(page, '组件中心');
  const axesCard = page.locator('[data-component-group-id="axes"]').first();
  await axesCard.waitFor({ state: 'visible', timeout: 10000 });
  const expectedControls = [
    { key: 'fontfamily', prop: 'tick_labelfamily' },
    { key: 'fontsize', prop: 'tick_labelsize' },
    { key: 'fontweight', prop: 'tick_fontweight' },
    { key: 'color', prop: 'tick_labelcolor' },
  ];
  const contracts = [];
  for (const expected of expectedControls) {
    const selector = expected.key === 'color'
      ? `[data-property-control="color"][data-param-prop="${expected.prop}"], [data-property-control="color-text"][data-param-prop="${expected.prop}"]`
      : `[data-property-control="${expected.key}"][data-param-prop="${expected.prop}"]`;
    const controls = axesCard.locator(selector);
    const count = await controls.count();
    const enabled = count > 0 && await controls.first().isEnabled().catch(() => false);
    const state = count > 0 ? await controls.first().locator('xpath=ancestor::*[@data-property-state][1]').getAttribute('data-property-state').catch(() => null) : null;
    contracts.push({ ...expected, count, enabled, state });
  }
  const tickDirectionCount = await axesCard.locator('[data-param-prop="tick_direction"]').count();
  const allTypographyControlsEnabled = contracts.every(item => item.enabled);
  const typographyControlCount = contracts.reduce((sum, item) => sum + item.count, 0);
  const weightControl = axesCard.locator('[data-property-control="fontweight"][data-param-prop="tick_fontweight"]').first();
  await weightControl.selectOption('bold');
  const draftVisible = (await getBodyText(page)).includes('已暂存');
  const applied = await applyCurrentDraft(page);
  const patches = patchList(applied.patchBody);
  const expectedAxisIds = fixture.axisObjects.map(object => object.id).sort();
  const typographyPatches = patches.filter(patch => patch.prop === 'tick_fontweight');
  const patchedAxisIds = typographyPatches.map(patch => patch.gid).sort();
  const preciseAxisFanout = JSON.stringify(patchedAxisIds) === JSON.stringify(expectedAxisIds)
    && typographyPatches.every(patch => patch.value === 'bold')
    && patches.every(patch => !String(patch.gid).startsWith('spine.') && !String(patch.gid).startsWith('grid.'));
  record(
    'PUB-4-axis-system-typography-controls',
    allTypographyControlsEnabled && contracts.every(item => item.state !== 'readonly') && typographyControlCount >= expectedControls.length && draftVisible && preciseAxisFanout,
    `expectedAxisIds=${JSON.stringify(expectedAxisIds)}, patchedAxisIds=${JSON.stringify(patchedAxisIds)}, contracts=${JSON.stringify(contracts)}, typographyControls=${typographyControlCount}, tickDirection=${tickDirectionCount}, patches=${JSON.stringify(patches)}`,
  );
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const provenance = await verifyTargetProvenance();
  record('PUB-0-target-provenance', true, `profile=${provenance.profile}, marker=${JSON.stringify(provenance.marker)}`);
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'public editing regressions');
  await cleanupSmokeProjects();
  const fixture = await createFixture();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', message => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('request', request => {
    if (request.url().includes('/api/figure') || request.url().includes('/api/projects')) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await installFixtureState(page, fixture);
    await runFontFamilyRegression(page, fixture);
    await runTextToolbarRegression(page, fixture);
    await runCrossCenterDraftRegression(page, fixture);
    await runAxisSystemTypographyControlsRegression(page, fixture);
    record('PUB-5-runtime-errors', consoleErrors.length === 0 && pageErrors.length === 0, `console=${JSON.stringify(consoleErrors)}, page=${JSON.stringify(pageErrors)}`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'public-editing-regressions.png'), fullPage: true });
  } finally {
    await browser.close();
    await requestJson(`/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

try {
  await run();
} catch (error) {
  fail('HARNESS', error?.stack || error?.message || String(error));
}

const passCount = results.filter(result => result.status === 'PASS').length;
const failCount = results.filter(result => result.status === 'FAIL').length;
const conclusion = failCount === 0 ? 'PASS' : 'FAIL';
const reportLines = [
  '# Public Editing Regressions Smoke Report',
  '',
  `- Time: ${new Date().toISOString()}`,
  `- URL: ${BASE_URL || '(unset)'}`,
  `- Conclusion: ${conclusion}`,
  `- PASS: ${passCount}`,
  `- FAIL: ${failCount}`,
  '',
  '| ID | Status | Evidence |',
  '|---|---|---|',
  ...results.map(result => `| ${result.id} | ${result.status} | ${String(result.evidence).replace(/\|/g, '\\|')} |`),
  '',
  '## Runtime Diagnostics',
  '',
  '```json',
  JSON.stringify({ consoleErrors, pageErrors }, null, 2),
  '```',
];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const reportPath = path.join(OUTPUT_DIR, 'report.md');
fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
console.log(`Report: ${reportPath}`);
console.log(`Conclusion: ${conclusion}, PASS=${passCount}, FAIL=${failCount}`);
if (failCount > 0) process.exitCode = 1;
