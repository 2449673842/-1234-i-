/**
 * R/ggplot2 property and layout center browser acceptance.
 *
 * This is intentionally narrower than the R semantic-center golden flow. It
 * exercises the two remaining center-level gaps through the real page:
 * selecting renderer objects, staging controls, applying a patch, and
 * confirming the resulting edit log after a refresh.
 *
 * Run through scripts/testing/run_with_isolated_server.mjs only.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || '';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `r-property-layout-centers-${RUN_ID}`);

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
let authToken = '';

const singleScript = [
  'library(ggplot2)',
  'df <- data.frame(x=1:5, y=c(2, 4, 3, 6, 5), group=factor(c("A", "A", "B", "B", "A")))',
  'p <- ggplot(df, aes(x=x, y=y, color=group)) + geom_line(linewidth=0.8) + geom_point(size=3) +',
  '  labs(title="R property center", x="X axis", y="Y axis") + theme_minimal()',
  'p',
].join('\n');

const facetScript = [
  'library(ggplot2)',
  'df <- data.frame(panel=factor(c("F1", "F2")), x=1:4, y=c(1, 3, 2, 4))',
  'p <- ggplot(df, aes(x=x, y=y)) + geom_line(linewidth=0.8) + geom_point(size=3) +',
  '  facet_wrap(~panel, scales="free") + theme_minimal()',
  'p',
].join('\n');

function assertIsolatedEnvironment() {
  if (process.env.SCIFIGURE_TEST_ISOLATED !== '1') throw new Error('R property/layout smoke requires isolated server');
  if (!BASE_URL || !process.env.SCIFIGURE_DATA_DIR || !process.env.SCIFIGURE_DB_PATH) {
    throw new Error('isolated URL/data/db environment is required');
  }
  const url = new URL(BASE_URL);
  if (url.hostname !== '127.0.0.1' || url.port === '3000') throw new Error(`unsafe smoke URL: ${BASE_URL}`);
  const dataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const dbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  if (!path.basename(path.dirname(dataDir)).startsWith('scifigure-isolated-smoke-')) throw new Error(`unsafe data dir: ${dataDir}`);
  if (!dbPath.startsWith(`${dataDir}${path.sep}`)) throw new Error(`DB is outside isolated data dir: ${dbPath}`);
  if (dataDir === path.resolve(ROOT, 'data')) throw new Error('smoke refuses repository data directory');
}

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
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

function patchValueEquals(left, right) {
  if (left && typeof left === 'object' || right && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function hasEdit(editLog, expected) {
  return Array.isArray(editLog) && editLog.some(entry => (
    entry.gid === expected.gid
      && entry.prop === expected.prop
      && patchValueEquals(entry.value, expected.value)
      && entry.mode === 'backend_patch'
  ));
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter(project => String(project?.name || '').startsWith('R property/layout centers smoke'))
    .map(project => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function bodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await bodyText(page);
    const rendering = body.includes('正在重新渲染当前图形')
      || body.includes('等待 Python 渲染结果')
      || body.includes('正在恢复项目预览');
    const svgCount = await page.locator('[data-scifigure-canvas-svg="true"] > svg').count().catch(() => 0);
    if (!rendering && svgCount > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

async function clickText(page, text) {
  const candidates = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(text, { exact: false }).first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 4000 }).catch(() => false)) {
      await candidate.click();
      await page.waitForTimeout(450);
      return true;
    }
  }
  return false;
}

async function readFigureState(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      revision: figure?.revision || null,
      editLog: figure?.editLog || [],
      manifest: figure?.manifest || null,
      projectDrafts: state.projectDrafts || {},
    };
  });
}

async function prepareProject(page, script, label) {
  return page.evaluate(async ({ baseUrl, script, label }) => {
    const spec = {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'r',
      figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
    };
    const createResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `R property/layout centers smoke ${label} ${Date.now()}`, spec }),
    });
    const created = await createResponse.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');
    const renderResponse = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'r', requestId: `r-property-layout-${Date.now()}` }),
    });
    const rendered = await renderResponse.json();
    if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');
    const figure = rendered.figures?.[0];
    const projectFigures = {
      fig_1: {
        figureId: 'fig_1',
        index: 0,
        manifest: figure.manifest,
        editLog: figure.editLog || [],
        revision: figure.revision || 1,
        svg: figure.svg,
        fingerprint: figure.fingerprint,
        codeSlice: figure.codeSlice || null,
        renderStatus: 'success',
      },
    };
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId: created.id,
      projectName: `R property/layout centers smoke ${label}`,
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: [`> R ${label} fixture ready`],
      figSession: null,
    }));
    return {
      projectId: created.id,
      generatedBy: figure.manifest?.generatedBy,
      objectIds: (figure.manifest?.objects || []).map(object => object.id),
    };
  }, { baseUrl: BASE_URL, script, label });
}

async function selectComponentObject(page, gid) {
  await clickText(page, '组件中心');
  const object = page.locator(`[data-component-object-id="${gid}"]`).first();
  if (!(await object.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await object.click();
  await page.waitForTimeout(400);
  return true;
}

async function applyDraft(page) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/figure/patch'
  ), { timeout: 90000 }).catch(() => null);
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, requestPatches: [], responseBody: null, successful: false };
  const response = await responsePromise;
  await waitForPreviewReady(page);
  const request = apiRequests.slice(start).find(item => item.url.includes('/api/figure/patch'));
  const requestPatches = patchList(parseJson(request?.postData));
  const responseBody = await response?.json().catch(() => null);
  const rejected = Array.isArray(responseBody?.rejected) ? responseBody.rejected : [];
  const skipped = Array.isArray(responseBody?.skipped) ? responseBody.skipped : [];
  const applied = Array.isArray(responseBody?.applied) ? responseBody.applied : [];
  const successful = Boolean(
    response
      && response.status() >= 200
      && response.status() < 300
      && responseBody?.status === 'success'
      && rejected.length === 0
      && skipped.length === 0
      && requestPatches.every(patch => applied.some(entry => (
        entry.gid === patch.gid && entry.prop === patch.prop && patchValueEquals(entry.value, patch.value)
      ))),
  );
  return { clicked: true, requestPatches, responseBody, successful };
}

async function saveAndRefresh(page) {
  const save = page.getByRole('button', { name: /^保存$/ }).first();
  if (!(await save.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  const response = page.waitForResponse(item => (
    item.request().method() === 'PUT'
      && /\/api\/projects\/[^/]+$/.test(new URL(item.url()).pathname)
  ), { timeout: 40000 }).catch(() => null);
  await save.click();
  const saved = await response;
  if (!saved || saved.status() < 200 || saved.status() >= 300) return false;
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  return waitForPreviewReady(page);
}

async function run() {
  assertIsolatedEnvironment();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'R property/layout centers');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('[vite]')) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || '' }));
  page.on('request', request => {
    if (request.url().includes('/api/figure') || request.url().includes('/api/projects')) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });
  page.on('response', response => {
    if (response.url().includes('/api/figure') || response.url().includes('/api/projects')) {
      apiResponses.push({ method: response.request().method(), url: response.url(), status: response.status() });
    }
  });

  let singleProjectId = null;
  let facetProjectId = null;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });

    const singleFixture = await prepareProject(page, singleScript, 'single');
    singleProjectId = singleFixture.projectId;
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    const singleReady = await waitForPreviewReady(page);
    const initialSingle = await readFigureState(page);
    const singleObjectIds = new Set(initialSingle.manifest?.objects?.map(object => object.id) || []);
    const fixtureOk = singleReady
      && singleFixture.generatedBy === 'r_svg'
      && singleObjectIds.has('axis.x.0')
      && singleObjectIds.has('grid.0')
      && singleObjectIds.has('subplot.0');
    record('R-PROP-0-single-fixture', fixtureOk ? 'PASS' : 'FAIL', `ready=${singleReady}, generatedBy=${singleFixture.generatedBy}, objects=${JSON.stringify([...singleObjectIds].filter(id => ['axis.x.0', 'grid.0', 'subplot.0'].includes(id)))}`);

    const axisSelected = await selectComponentObject(page, 'axis.x.0');
    await clickText(page, '属性编辑');
    const tickPad = page.locator('input[data-param-gid="axis.x.0"][data-param-prop="tick_pad"]').first();
    const tickWidth = page.locator('input[data-param-gid="axis.x.0"][data-param-prop="tick_width"]').first();
    const tickColor = page.locator('input[data-color-role="text"][data-color-scope="axis.x.0:tick_color"]').first();
    const axisControlsVisible = axisSelected
      && await tickPad.isVisible({ timeout: 5000 }).catch(() => false)
      && await tickWidth.isVisible({ timeout: 5000 }).catch(() => false)
      && await tickColor.isVisible({ timeout: 5000 }).catch(() => false);
    if (axisControlsVisible) {
      await tickPad.fill('11.5');
      await tickWidth.fill('1.9');
      await tickColor.fill('#2C7FB8');
      await tickColor.press('Enter');
    }
    const axisDraftVisible = (await bodyText(page)).includes('已暂存');

    const gridSelected = await selectComponentObject(page, 'grid.0');
    await clickText(page, '属性编辑');
    const gridToggle = page.getByRole('checkbox', { name: '开启网格', exact: true }).first();
    const gridToggleVisible = gridSelected && await gridToggle.isVisible({ timeout: 5000 }).catch(() => false);
    // The checkbox is intentionally visually hidden beneath the switch track;
    // force the interaction on that same control instead of clicking a random
    // sibling and losing the real component-center path.
    if (gridToggleVisible && await gridToggle.isChecked()) await gridToggle.uncheck({ force: true });
    const propertyDraftVisible = (await bodyText(page)).includes('已暂存');
    const propertyApply = (axisControlsVisible && gridToggleVisible && propertyDraftVisible)
      ? await applyDraft(page)
      : { clicked: false, requestPatches: [], responseBody: null, successful: false };
    const propertyPatches = propertyApply.requestPatches;
    const propertyExpected = [
      { gid: 'axis.x.0', prop: 'tick_pad', value: 11.5 },
      { gid: 'axis.x.0', prop: 'tick_width', value: 1.9 },
      { gid: 'axis.x.0', prop: 'tick_color', value: '#2C7FB8' },
      { gid: 'grid.0', prop: 'visible', value: false },
    ];
    const propertyState = await readFigureState(page);
    const propertyOk = axisControlsVisible
      && gridToggleVisible
      && propertyDraftVisible
      && propertyApply.successful
      && propertyExpected.every(expected => propertyPatches.some(patch => patch.gid === expected.gid && patch.prop === expected.prop && patchValueEquals(patch.value, expected.value)))
      && propertyExpected.every(expected => hasEdit(propertyState.editLog, expected))
      && propertyPatches.every(patch => propertyExpected.some(expected => expected.gid === patch.gid && expected.prop === patch.prop));
    record('R-PROP-1-axis-grid-apply', propertyOk ? 'PASS' : 'FAIL', `axisSelected=${axisSelected}, axisControls=${axisControlsVisible}, gridSelected=${gridSelected}, gridToggle=${gridToggleVisible}, draft=${propertyDraftVisible}, patches=${JSON.stringify(propertyPatches)}`);

    const subplotSelected = await selectComponentObject(page, 'subplot.0');
    await clickText(page, '布局中心');
    const layoutText = await page.locator('.scifig-editor-panel-right').innerText().catch(() => '');
    const aspect = page.locator('select[data-param-gid="subplot.0"][data-param-prop="aspect"]').first();
    const singleLayoutVisible = subplotSelected
      && layoutText.includes('真实绘图区 / 坐标轴框')
      && layoutText.includes('不支持独立调整绘图区边框宽高')
      && await aspect.isVisible({ timeout: 5000 }).catch(() => false)
      && await page.locator('input[data-param-gid="subplot.0"][data-param-prop="left"]').count() === 0
      && await page.locator('input[data-param-gid="subplot.0"][data-param-prop="width"]').count() === 0;
    if (singleLayoutVisible) await aspect.selectOption('equal');
    const singleLayoutDraft = (await bodyText(page)).includes('已暂存');
    const singleLayoutApply = singleLayoutVisible && singleLayoutDraft ? await applyDraft(page) : { clicked: false, requestPatches: [], responseBody: null, successful: false };
    const singleLayoutOk = singleLayoutVisible
      && singleLayoutDraft
      && singleLayoutApply.successful
      && singleLayoutApply.requestPatches.some(patch => patch.gid === 'subplot.0' && patch.prop === 'aspect' && patch.value === 'equal');
    record('R-LAYOUT-1-single-aspect', singleLayoutOk ? 'PASS' : 'FAIL', `selected=${subplotSelected}, controls=${singleLayoutVisible}, draft=${singleLayoutDraft}, patches=${JSON.stringify(singleLayoutApply.requestPatches)}`);

    const refreshed = await saveAndRefresh(page);
    const refreshedState = await readFigureState(page);
    const refreshOk = refreshed
      && propertyExpected.every(expected => hasEdit(refreshedState.editLog, expected))
      && hasEdit(refreshedState.editLog, { gid: 'subplot.0', prop: 'aspect', value: 'equal' });
    record('R-LAYOUT-2-save-refresh', refreshOk ? 'PASS' : 'FAIL', `refreshed=${refreshed}, revision=${refreshedState.revision}, editCount=${refreshedState.editLog.length}`);

    const facetFixture = await prepareProject(page, facetScript, 'facet');
    facetProjectId = facetFixture.projectId;
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    const facetReady = await waitForPreviewReady(page);
    await clickText(page, '布局中心');
    const facetLayoutText = await page.locator('.scifig-editor-panel-right').innerText().catch(() => '');
    const facetAspect = page.locator('select[data-param-gid="r.facet.layout.0"][data-param-prop="aspect"]').first();
    const facetBounds = await page.locator('input[data-param-prop="left"], input[data-param-prop="bottom"], input[data-param-prop="width"], input[data-param-prop="height"]').count();
    const facetReadonlyOk = facetReady
      && facetLayoutText.includes('共享多面板布局')
      && facetLayoutText.includes('不能作为独立坐标轴框交换、重排或修改物理边界')
      && await facetAspect.isVisible({ timeout: 5000 }).catch(() => false)
      && facetBounds === 0;
    if (facetReadonlyOk) await facetAspect.selectOption('equal');
    const facetDraft = (await bodyText(page)).includes('已暂存');
    const facetApply = facetReadonlyOk && facetDraft ? await applyDraft(page) : { clicked: false, requestPatches: [], responseBody: null, successful: false };
    const facetOk = facetReadonlyOk
      && facetDraft
      && facetApply.successful
      && facetApply.requestPatches.length === 1
      && facetApply.requestPatches[0]?.gid === 'r.facet.layout.0'
      && facetApply.requestPatches[0]?.prop === 'aspect'
      && facetApply.requestPatches[0]?.value === 'equal';
    record('R-LAYOUT-3-facet-shared-boundary', facetOk ? 'PASS' : 'FAIL', `ready=${facetReady}, readonly=${facetReadonlyOk}, bounds=${facetBounds}, draft=${facetDraft}, patches=${JSON.stringify(facetApply.requestPatches)}`);

    const facetRefreshed = await saveAndRefresh(page);
    const facetState = await readFigureState(page);
    const facetRefreshOk = facetRefreshed && hasEdit(facetState.editLog, { gid: 'r.facet.layout.0', prop: 'aspect', value: 'equal' });
    record('R-LAYOUT-4-facet-save-refresh', facetRefreshOk ? 'PASS' : 'FAIL', `refreshed=${facetRefreshed}, revision=${facetState.revision}, editCount=${facetState.editLog.length}`);

    const runtimeOk = consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0;
    record('R-PROP-LAYOUT-N1-runtime', runtimeOk ? 'PASS' : 'FAIL', `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}, failedRequests=${failedRequests.length}`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'r-property-layout-centers.png'), fullPage: true });
  } finally {
    await browser.close();
    if (singleProjectId) await requestJson(`/api/projects/${singleProjectId}`, { method: 'DELETE' }).catch(() => null);
    if (facetProjectId) await requestJson(`/api/projects/${facetProjectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    record('HARNESS', 'FAIL', error?.message || String(error));
  }
  const passCount = results.filter(result => result.status === 'PASS').length;
  const failCount = results.filter(result => result.status === 'FAIL').length;
  const report = {
    runId: RUN_ID,
    conclusion: failCount > 0 ? 'FAIL' : 'PASS',
    passCount,
    failCount,
    results,
    apiResponses,
    consoleErrors,
    pageErrors,
    failedRequests,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report: ${path.join(OUTPUT_DIR, 'report.json')}`);
  console.log(`Conclusion: ${report.conclusion}, PASS=${passCount}, FAIL=${failCount}`);
  if (failCount > 0) process.exitCode = 1;
}

main();
