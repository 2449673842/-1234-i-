/**
 * R WP5 scale/guide/facet browser smoke test.
 *
 * Narrowly verifies:
 * - R discrete scale groups expose selectable palette/property UI targets.
 * - The legend container exposes editable guide properties through real UI controls.
 * - R facet panel physical bounds remain read-only and are not offered as UI controls.
 *
 * Run through scripts/testing/run_with_isolated_server.mjs.
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
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `r-wp5-scale-guide-facet-${RUN_ID}`);

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const diagnostics = {};
let authToken = '';

const script = [
  'library(ggplot2)',
  'df <- expand.grid(panel=factor(c("F1", "F2"), levels=c("F1", "F2")), group=factor(c("A", "B"), levels=c("A", "B")), x=1:3)',
  'df$y <- c(1, 2, 3, 2, 3, 4, 20, 40, 60, 30, 50, 70)',
  'p <- ggplot(df, aes(x=x, y=y, color=group, fill=group)) +',
  '  geom_point(shape=21, size=4, stroke=0.8) +',
  '  geom_line(aes(group=group), linewidth=0.8) +',
  '  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Study group") +',
  '  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Study group") +',
  '  facet_wrap(~panel, scales="free", strip.position="bottom") +',
  '  theme_classic() +',
  '  theme(panel.spacing.x=unit(7, "pt"), panel.spacing.y=unit(9, "pt"))',
  'p',
].join('\n');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'R WP5 smoke must use the isolated server wrapper');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  assert(process.env.SCIFIGURE_DATA_DIR && process.env.SCIFIGURE_DB_PATH, 'isolated data dir and DB path are required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
  const resolvedDataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const resolvedDbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(`${resolvedDataDir}${path.sep}`), `DB is outside isolated data dir: ${resolvedDbPath}`);
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

function interestingApi(request) {
  const url = request.url();
  return url.includes('/api/figure') || url.includes('/api/projects');
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

async function requestJson(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith('R WP5 scale guide facet smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('正在重新渲染当前图形') || body.includes('等待 Python 渲染结果') || body.includes('正在恢复项目预览');
    const svgCount = await page.locator('[data-scifigure-canvas-svg="true"] > svg').count().catch(() => 0);
    if (!rendering && svgCount > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function clickText(page, text) {
  const locators = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(text, { exact: false }).first(),
  ];
  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 4000 }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function waitForApiSettle(startIndex, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recent = apiResponses.slice(startIndex);
    const pendingCount = apiRequests.slice(startIndex).length - recent.length;
    if (pendingCount <= 0 && recent.length > 0) return recent;
  }
  return apiResponses.slice(startIndex);
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

function allPatchesApplied(responseBody, patches) {
  const applied = Array.isArray(responseBody?.applied) ? responseBody.applied : [];
  return patches.every((patch) => applied.some((entry) => (
    entry?.gid === patch?.gid
    && entry?.prop === patch?.prop
    && String(entry?.value).toLowerCase() === String(patch?.value).toLowerCase()
  )));
}

async function applyDraftAndReadPatch(page) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/figure/patch'
  ), { timeout: 90000 }).catch(() => null);
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchBody: null, responseBody: null, successful: false };
  const patchResponse = await responsePromise;
  await waitForApiSettle(start, 90000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const responseBody = await patchResponse?.json().catch(() => null);
  const patches = patchList(patchBody);
  const rejected = Array.isArray(responseBody?.rejected) ? responseBody.rejected : [];
  const skipped = Array.isArray(responseBody?.skipped) ? responseBody.skipped : [];
  const successful = Boolean(
    patchResponse
    && patchResponse.status() >= 200
    && patchResponse.status() < 300
    && responseBody?.status === 'success'
    && rejected.length === 0
    && skipped.length === 0
    && allPatchesApplied(responseBody, patches)
  );
  return { clicked, patchBody, responseBody, successful };
}

async function prepareProject(page) {
  const fixture = await page.evaluate(async ({ baseUrl, script }) => {
    const spec = {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'r',
      figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
    };
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `R WP5 scale guide facet smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'r', requestId: `r-wp5-${Date.now()}` }),
    });
    const rendered = await renderRes.json();
    if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');
    const figure = rendered.figures?.[0];
    const manifest = figure?.manifest || {};
    const objects = manifest.objects || [];
    const projectFigures = {
      fig_1: {
        figureId: 'fig_1',
        index: 0,
        manifest,
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
      projectName: 'R WP5 scale guide facet smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> R WP5 fixture ready'],
      figSession: null,
    }));

    const byId = Object.fromEntries(objects.map((object) => [object.id, object]));
    const colorGroups = objects.filter((object) => String(object.id).startsWith('r.group.color.'));
    const fillGroups = objects.filter((object) => String(object.id).startsWith('r.group.fill.'));
    const facetPanels = objects.filter((object) => object.role === 'ggplot_facet_panel');
    const facetLayout = objects.find((object) => object.id === 'r.facet.layout.0') || null;
    const legends = objects.filter((object) => object.kind === 'legend');
    const scales = objects.filter((object) => object.role === 'ggplot_scale_discrete');
    return {
      projectId: created.id,
      generatedBy: manifest.generatedBy,
      colorGroups: colorGroups.map((object) => ({
        id: object.id,
        label: object.label,
        editable: object.editable || [],
        currentProps: object.currentProps || {},
        relation: object.identity?.relation || {},
        scopes: (object.propertyCapabilities || []).find((capability) => capability.prop === 'color')?.scopes || [],
      })),
      fillGroups: fillGroups.map((object) => ({
        id: object.id,
        label: object.label,
        editable: object.editable || [],
        currentProps: object.currentProps || {},
        relation: object.identity?.relation || {},
      })),
      legends: legends.map((object) => ({
        id: object.id,
        editable: object.editable || [],
        currentProps: object.currentProps || {},
        relation: object.identity?.relation || {},
      })),
      scales: scales.map((object) => ({
        id: object.id,
        currentProps: object.currentProps || {},
        relation: object.identity?.relation || {},
      })),
      facetPanels: facetPanels.map((object) => ({
        id: object.id,
        editable: object.editable || [],
        currentProps: object.currentProps || {},
        relation: object.identity?.relation || {},
      })),
      facetLayout: facetLayout ? {
        id: facetLayout.id,
        editable: facetLayout.editable || [],
        currentProps: facetLayout.currentProps || {},
      } : null,
      legendTextIds: objects.filter((object) => object.role === 'legend_text').map((object) => object.id),
      svgHasColorGroups: colorGroups.every((object) => String(figure.svg || '').includes(`data-fig-id="${object.id}"`)),
      objectIds: Object.keys(byId),
    };
  }, { baseUrl: BASE_URL, script });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForPreviewReady(page);
  return fixture;
}

async function setColorByScope(page, scope, value) {
  const textInput = page.locator(`input[data-color-role="text"][data-color-scope="${scope}"]`).first();
  if (!(await textInput.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await textInput.scrollIntoViewIfNeeded().catch(() => {});
  await textInput.fill(value);
  await textInput.press('Enter').catch(() => {});
  await textInput.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setNumberInComponentGroup(page, groupId, prop, value) {
  const input = page.locator(`[data-component-group-id="${groupId}"] input[data-param-role="number"][data-param-prop="${prop}"]`).first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.fill(String(value));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function componentGroupState(page, groupIds) {
  return page.locator('.scifig-editor-panel-right [data-component-group-id]').evaluateAll((nodes, ids) => {
    const wanted = new Set(ids);
    return nodes
      .filter((node) => wanted.has(node.getAttribute('data-component-group-id')))
      .map((node) => ({
        id: node.getAttribute('data-component-group-id'),
        label: node.getAttribute('data-component-group-label'),
        objectIds: Array.from(node.querySelectorAll('[data-component-object-id]')).map((child) => child.getAttribute('data-component-object-id')),
        props: Array.from(node.querySelectorAll('[data-param-prop], select[data-param-prop]')).map((child) => child.getAttribute('data-param-prop')),
      }));
  }, groupIds);
}

async function readFigureState(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      editLog: figure?.editLog || [],
      manifest: figure?.manifest || null,
      selectedGids: state.selectedGids || [],
    };
  });
}

async function run() {
  assertIsolatedEnvironment();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'R WP5 scale guide facet');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableDevServerNoise(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIgnorableDevServerNoise(err.message)) pageErrors.push(err.message);
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({ url: request.url(), errorText: request.failure()?.errorText || '' });
  });
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });
  page.on('response', (response) => {
    if (interestingApi(response.request())) {
      apiResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), postData: response.request().postData() });
    }
  });

  let projectId = null;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const fixture = await prepareProject(page);
    projectId = fixture.projectId;
    diagnostics.fixture = fixture;

    const groupRelationsOk = fixture.generatedBy === 'r_svg'
      && fixture.colorGroups.length === 2
      && fixture.fillGroups.length === 2
      && fixture.legends.length >= 1
      && fixture.scales.some((scale) => scale.id === 'r.scale.color.0' && scale.currentProps?.guideType === 'legend')
      && fixture.colorGroups.every((group) => group.editable.includes('color') && group.relation?.scaleId === 'r.scale.color.0' && group.relation?.guideId === 'legend.0')
      && fixture.colorGroups.some((group) => group.relation?.groupKey === 'B')
      && fixture.svgHasColorGroups
      && fixture.legendTextIds.length >= 2;
    record('WP5-1-discrete-scale-guide-fixture', groupRelationsOk ? 'PASS' : 'FAIL', `colorGroups=${JSON.stringify(fixture.colorGroups)}, legends=${JSON.stringify(fixture.legends)}, scales=${JSON.stringify(fixture.scales)}`);

    const facetBoundsOk = fixture.facetPanels.length === 2
      && fixture.facetPanels.every((panel) => (
        panel.currentProps?.freeX === true
        && panel.currentProps?.freeY === true
        && panel.currentProps?.facetScales === 'free'
        && !panel.editable.includes('left')
        && !panel.editable.includes('bottom')
        && !panel.editable.includes('width')
        && !panel.editable.includes('height')
        && !panel.editable.includes('aspect')
      ))
      && fixture.facetLayout?.currentProps?.physicalPanelBounds === 'readonly'
      && fixture.facetLayout?.editable?.includes('aspect');
    record('WP5-2-facet-bounds-readonly-manifest', facetBoundsOk ? 'PASS' : 'FAIL', `panels=${JSON.stringify(fixture.facetPanels)}, layout=${JSON.stringify(fixture.facetLayout)}`);

    await clickText(page, '配色中心');
    const paletteCard = page.locator('[data-palette-id="r.scale.color.0.1"]').first();
    const paletteCardVisible = await paletteCard.isVisible({ timeout: 5000 }).catch(() => false);
    const paletteObjectIds = paletteCardVisible
      ? await paletteCard.locator('[data-palette-object-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-palette-object-id')))
      : [];
    if (paletteCardVisible) {
      await paletteCard.getByRole('button', { name: '选中整组' }).click();
      await page.waitForTimeout(500);
    }
    const selectedAfterPaletteClick = (await readFigureState(page)).selectedGids || [];
    const colorChanged = await setColorByScope(page, 'palette:r.scale.color.0.1', '#2ca02c');
    const colorDraftVisible = (await getBodyText(page)).includes('已暂存');
    const colorApply = colorChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const colorPatches = patchList(colorApply.patchBody);
    const colorUiOk = paletteCardVisible
      && paletteObjectIds.includes('r.group.color.0.1')
      && selectedAfterPaletteClick.includes('r.group.color.0.1')
      && colorChanged
      && colorDraftVisible
      && colorApply.successful
      && colorPatches.length >= 1
      && colorPatches.some((patch) => patch.gid === 'r.group.color.0.1' && patch.prop === 'color' && String(patch.value).toLowerCase() === '#2ca02c')
      && colorPatches.every((patch) => !String(patch.gid || '').startsWith('r.group.fill.'));
    record('WP5-3-discrete-group-palette-ui', colorUiOk ? 'PASS' : 'FAIL', `visible=${paletteCardVisible}, objects=${JSON.stringify(paletteObjectIds)}, selected=${JSON.stringify(selectedAfterPaletteClick)}, changed=${colorChanged}, patches=${JSON.stringify(colorPatches)}`);

    await clickText(page, '组件中心');
    const componentState = await componentGroupState(page, ['legends', 'subplots']);
    const legendGroup = componentState.find((group) => group.id === 'legends');
    const subplotGroup = componentState.find((group) => group.id === 'subplots');
    const legendScaleChanged = await setNumberInComponentGroup(page, 'legends', 'markerscale', 1.7);
    const legendDraftVisible = (await getBodyText(page)).includes('已暂存');
    const legendApply = legendScaleChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const legendPatches = patchList(legendApply.patchBody);
    const legendUiOk = legendGroup?.objectIds?.includes('legend.0')
      && legendGroup?.props?.includes('markerscale')
      && legendScaleChanged
      && legendDraftVisible
      && legendApply.successful
      && legendPatches.some((patch) => patch.gid === 'legend.0' && patch.prop === 'markerscale' && Number(patch.value) === 1.7);
    record('WP5-4-legend-property-ui', legendUiOk ? 'PASS' : 'FAIL', `groups=${JSON.stringify(componentState)}, changed=${legendScaleChanged}, patches=${JSON.stringify(legendPatches)}`);

    const forbiddenFacetBounds = ['left', 'bottom', 'width', 'height'];
    const subplotBoundControls = Object.fromEntries(await Promise.all(forbiddenFacetBounds.map(async (prop) => [
      prop,
      await page.locator(`[data-component-group-id="subplots"] [data-param-prop="${prop}"]`).count().catch(() => 0),
    ])));
    const attemptedBounds = [];
    for (const prop of forbiddenFacetBounds) {
      attemptedBounds.push(await setNumberInComponentGroup(page, 'subplots', prop, prop === 'width' ? 0.5 : 0.1));
    }
    const boundsDraftVisible = (await getBodyText(page)).includes('已暂存');
    const uiBoundsOk = Object.values(subplotBoundControls).every((count) => count === 0)
      && attemptedBounds.every((attempted) => attempted === false)
      && !boundsDraftVisible;
    record('WP5-5-facet-physical-bounds-not-offered', uiBoundsOk ? 'PASS' : 'FAIL', `subplotGroup=${JSON.stringify(subplotGroup)}, controls=${JSON.stringify(subplotBoundControls)}, attempted=${JSON.stringify(attemptedBounds)}, draft=${boundsDraftVisible}`);

    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0 ? 'PASS' : 'FAIL',
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}, failedRequests=${failedRequests.length}`,
    );
  } finally {
    await browser.close();
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

function generateReport() {
  const passCount = results.filter((result) => result.status === 'PASS').length;
  const failCount = results.filter((result) => result.status === 'FAIL').length;
  const blockedCount = results.filter((result) => result.status === 'BLOCKED').length;
  const conclusion = failCount > 0 ? 'FAIL' : blockedCount > 0 ? 'PARTIAL' : 'PASS';
  const lines = [
    '# R WP5 Scale/Guide/Facet Smoke Report',
    '',
    `Run: ${RUN_ID}`,
    `Conclusion: ${conclusion}, PASS=${passCount}, FAIL=${failCount}, BLOCKED=${blockedCount}`,
    '',
    '| ID | Status | Note |',
    '|---|---|---|',
    ...results.map((result) => `| ${result.id} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify({ diagnostics, consoleErrors, pageErrors, failedRequests }, null, 2),
    '```',
  ];
  const file = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return { file, conclusion, passCount, failCount, blockedCount };
}

try {
  await run();
} catch (error) {
  record('HARNESS', 'FAIL', error?.message || String(error));
}

const report = generateReport();
console.log(`\nReport: ${report.file}`);
console.log(`Conclusion: ${report.conclusion}, PASS=${report.passCount}, FAIL=${report.failCount}, BLOCKED=${report.blockedCount}`);
if (report.conclusion !== 'PASS') process.exitCode = 1;
