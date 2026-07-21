/**
 * R/ggplot semantic centers browser smoke test.
 *
 * Verifies that the frontend semantic centers can edit R-generated manifests
 * through the same draft/apply flow used by Python figures.
 *
 * Run through scripts/testing/run_with_isolated_server.mjs. Direct execution
 * fails closed so this smoke cannot target port 3000 or repository data.
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
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `r-semantic-centers-${RUN_ID}`);

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const diagnostics = {};
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'R semantic smoke must use the isolated server wrapper');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe R semantic smoke URL: ${BASE_URL}`);
  const resolvedDataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const resolvedDbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(`${resolvedDataDir}${path.sep}`), `DB is outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(ROOT, 'data'), 'R semantic smoke refuses the repository data directory');
}

const script = [
  'library(ggplot2)',
  'df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"), facet=c("F1", "F1", "F2", "F2"))',
  'p <- ggplot(df, aes(x, y, color=group)) +',
  '  geom_point(size=3) +',
  '  geom_line(linewidth=0.8) +',
  '  labs(title="R Semantic Centers", x="R X Axis", y="R Y Axis") +',
  '  facet_wrap(~facet) +',
  '  theme_classic()',
  'p',
].join('\n');

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
    || /WebSocket connection to 'ws:\/\/[^']+:24678\//.test(message)
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
    .filter((project) => String(project?.name || '').startsWith('R semantic centers smoke'))
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
    const svgCount = await page.locator('svg').count().catch(() => 0);
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

async function findControlInRightSidebar(page, options) {
  return page.evaluateHandle(({ sectionText, labelText, selector }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const containers = Array.from(document.querySelectorAll('div'))
      .filter((node) => visible(node) && rightSide(node) && normalize(node.textContent).includes(normalize(sectionText)))
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    for (const container of containers) {
      const controls = Array.from(container.querySelectorAll(selector)).filter((node) => visible(node) && !node.disabled);
      if (!labelText) return controls[0] || null;
      for (const control of controls) {
        let current = control.parentElement;
        while (current && current !== container.parentElement) {
          if (
            current.contains(control) &&
            normalize(current.textContent).includes(normalize(labelText)) &&
            visible(current)
          ) {
            return control;
          }
          if (current === container) break;
          current = current.parentElement;
        }
      }
    }
    return null;
  }, options);
}

async function setNumberControl(page, sectionText, labelText, value) {
  const handle = await findControlInRightSidebar(page, { sectionText, labelText, selector: 'input[type="number"]' });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setComponentNumberByGroup(page, groupId, prop, value) {
  const input = page.locator(
    `[data-component-group-id="${groupId}"] input[data-param-role="number"][data-param-prop="${prop}"]`,
  ).first();
  if (!(await input.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await input.fill(String(value));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setColorControl(page, sectionText, labelText, value) {
  const handle = await findControlInRightSidebar(page, { sectionText, labelText, selector: 'input[type="text"]' });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(value);
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setColorByScope(page, scope, value) {
  const propertyInput = page.locator(`input[data-property-control="color-text"][data-property-scope="${scope}"]`).first();
  if (await propertyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await propertyInput.fill(value);
    await propertyInput.press('Enter').catch(() => {});
    await propertyInput.evaluate((node) => node.blur());
    await page.waitForTimeout(700);
    return true;
  }
  const textInput = page.locator(`input[data-color-role="text"][data-color-scope="${scope}"]`).first();
  if (await textInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await textInput.fill(value);
    await textInput.press('Enter').catch(() => {});
    await textInput.evaluate((node) => node.blur());
    await page.waitForTimeout(700);
    return true;
  }
  const pickerInput = page.locator(`input[data-color-role="picker"][data-color-scope="${scope}"]`).first();
  if (await pickerInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await pickerInput.evaluate((node, nextValue) => {
      const input = node;
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(700);
    return true;
  }
  return false;
}

async function applyDraftAndReadPatch(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchBody: null, successful: false };
  await waitForApiSettle(start, 90000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const successful = apiResponses.slice(start).some((response) => response.url.includes('/api/figure/patch') && response.status >= 200 && response.status < 300);
  return { clicked, patchBody, successful };
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
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
      body: JSON.stringify({ name: `R semantic centers smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'r', requestId: `r-semantic-${Date.now()}` }),
    });
    const rendered = await renderRes.json();
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
      projectName: 'R semantic centers smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> R semantic centers fixture ready'],
      figSession: null,
    }));
    const objects = figure.manifest?.objects || [];
    return {
      projectId: created.id,
      generatedBy: figure.manifest?.generatedBy,
      objectIds: objects.map((obj) => obj.id),
      axisEditable: objects.filter((obj) => obj.id === 'axis.x.0' || obj.id === 'axis.y.0').map((obj) => ({ id: obj.id, editable: obj.editable })),
      layerObjects: objects.filter((obj) => String(obj.id).startsWith('r.layer.')).map((obj) => ({ id: obj.id, kind: obj.kind, editable: obj.editable })),
      paletteCount: figure.manifest?.palettes?.length || 0,
    };
  }, { baseUrl: BASE_URL, script });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPreviewReady(page);
  return fixture;
}

async function run() {
  assertIsolatedEnvironment();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'R semantic centers');
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
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const fixture = await prepareProject(page);
    projectId = fixture.projectId;
    diagnostics.fixture = fixture;
    record(
      'R0-fixture',
      fixture.generatedBy === 'r_svg' && fixture.axisEditable.some((axis) => axis.editable?.includes('tick_labelsize')) ? 'PASS' : 'FAIL',
      JSON.stringify(fixture),
    );

    await clickText(page, '字体中心');
    const fontChanged = await setNumberControl(page, 'X 轴刻度文字', '字号', 13);
    const fontDraft = (await getBodyText(page)).includes('已暂存');
    const fontApply = fontChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const fontPatches = patchList(fontApply.patchBody);
    const fontOk = fontChanged && fontDraft && fontApply.successful && fontPatches.some((patch) => patch.gid === 'axis.x.0' && patch.prop === 'tick_labelsize' && Number(patch.value) === 13);
    record('R1-font-center', fontOk ? 'PASS' : 'FAIL', `changed=${fontChanged}, draft=${fontDraft}, patches=${JSON.stringify(fontPatches)}`);

    await clickText(page, '组件中心');
    const componentChanged = await setComponentNumberByGroup(page, 'lines', 'linewidth', 2.2);
    const componentDraft = (await getBodyText(page)).includes('已暂存');
    const componentApply = componentChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const componentPatches = patchList(componentApply.patchBody);
    const componentOk = componentChanged && componentDraft && componentApply.successful && componentPatches.some((patch) => String(patch.gid).startsWith('r.layer.') && patch.prop === 'linewidth' && Number(patch.value) === 2.2);
    record('R2-component-center', componentOk ? 'PASS' : 'FAIL', `changed=${componentChanged}, draft=${componentDraft}, patches=${JSON.stringify(componentPatches)}`);

    await clickText(page, '配色中心');
    const paletteV2Expected = process.env.VITE_SCIFIGURE_PALETTE_CONTROLS_V2 !== '0';
    const paletteV2Count = await page.locator('[data-palette-controls-version="2"]').count();
    record(
      'R3a-palette-descriptor-controls',
      (paletteV2Expected ? paletteV2Count > 0 : paletteV2Count === 0) ? 'PASS' : 'FAIL',
      `expected=${paletteV2Expected}, controls=${paletteV2Count}`,
    );
    const paletteChanged = await setColorByScope(page, 'palette:r.scale.color.0.0', '#2ca02c')
      || await setColorControl(page, 'A', '颜色', '#2ca02c')
      || await setColorControl(page, '配色', '颜色', '#2ca02c');
    const paletteDraft = (await getBodyText(page)).includes('已暂存');
    const paletteApply = paletteChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const palettePatches = patchList(paletteApply.patchBody);
    const paletteOk = paletteChanged && paletteDraft && paletteApply.successful && palettePatches.some((patch) => String(patch.gid).startsWith('r.group.color.') && patch.prop === 'color' && String(patch.value).toLowerCase() === '#2ca02c');
    record('R3-palette-center', paletteOk ? 'PASS' : 'FAIL', `changed=${paletteChanged}, draft=${paletteDraft}, patches=${JSON.stringify(palettePatches)}`);

    await clickText(page, '布局中心');
    const layoutV2Expected = process.env.VITE_SCIFIGURE_LAYOUT_CONTROLS_V2 !== '0';
    const layoutPanel = page.locator('[data-layout-controls-version="2"]').first();
    const layoutPanelCount = await layoutPanel.count();
    const aspectControl = layoutPanel.locator('[data-property-control="aspect"]').first();
    const unsupportedBounds = ['left', 'bottom', 'width', 'height'];
    const unsupportedBoundStates = layoutPanelCount > 0
      ? await Promise.all(unsupportedBounds.map(async prop => {
        const control = layoutPanel.locator(`[data-property-control="${prop}"]`).first();
        return {
          prop,
          count: await control.count(),
          disabled: await control.isDisabled().catch(() => false),
        };
      }))
      : [];
    const facetBoundsBlocked = await page.locator('[data-layout-subplot-bounds="unsupported"]').count();
    const layoutOk = layoutV2Expected
      ? layoutPanelCount === 1
        && await aspectControl.isEnabled().catch(() => false)
        && unsupportedBoundStates.every(item => item.count === 1 && item.disabled)
        && facetBoundsBlocked === 1
      : layoutPanelCount === 0;
    record(
      'R4-layout-capability-isolation',
      layoutOk ? 'PASS' : 'FAIL',
      `expected=${layoutV2Expected}, panel=${layoutPanelCount}, bounds=${JSON.stringify(unsupportedBoundStates)}, blocked=${facetBoundsBlocked}`,
    );

    const exported = await requestJson('/api/figure/export', {
      method: 'POST',
      body: JSON.stringify({ sessionId: `${projectId}_fig_1`, format: 'svg', dpi: 300 }),
    });
    const exportedEdits = exported?.bundle?.editLog || [];
    const exportOk = exported?.status === 'success'
      && String(exported?.svg || '').includes('<svg')
      && exported?.bundle?.metadata?.environment === 'R + SVG renderer'
       && exportedEdits.some((patch) => patch.gid === 'axis.x.0' && patch.prop === 'tick_labelsize')
       && exportedEdits.some((patch) => String(patch.gid).startsWith('r.group.color.') && patch.prop === 'color');
     record('R5-export-state', exportOk ? 'PASS' : 'FAIL', `environment=${exported?.bundle?.metadata?.environment}, edits=${JSON.stringify(exportedEdits)}`);

    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}`,
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
    '# R Semantic Centers Smoke Report',
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
