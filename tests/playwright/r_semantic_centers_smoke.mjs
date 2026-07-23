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
  'df <- data.frame(x=1:4, y=c(1, 3, 2, 5), group=c("A", "A", "B", "B"), facet=c("F1", "F1", "F2", "F2"), weight=c(1.2, 2.4, 3.6, 4.8))',
  'bars <- data.frame(x=1:4, y=c(0.45, 0.7, 0.55, 0.8), group=c("A", "A", "B", "B"))',
  'err <- data.frame(x=1:4, y=c(1.4, 3.1, 2.2, 4.7), ymin=c(1.0, 2.6, 1.7, 4.1), ymax=c(1.8, 3.6, 2.7, 5.3))',
  'dist <- data.frame(x=rep(c(5, 6), each=12), value=c(1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 18, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 20), group=rep(c("C", "D"), each=12))',
  'band <- data.frame(x=rep(7:10, 2), ymin=c(0.8, 1.2, 1.0, 1.5, 1.4, 1.9, 1.6, 2.2), ymax=c(1.5, 2.0, 1.8, 2.4, 2.1, 2.8, 2.5, 3.2), group=rep(c("E", "F"), each=4))',
  'area <- data.frame(x=rep(7:10, 2), y=c(0.7, 1.1, 0.9, 1.4, 1.2, 1.7, 1.5, 2.0), group=rep(c("E", "F"), each=4))',
  'step_data <- data.frame(x=11:14, y=c(1.2, 2.6, 1.9, 3.1))',
  'bin_data <- data.frame(x=c(11.1, 11.4, 11.8, 12.2, 12.7, 13.1, 13.5, 13.8))',
  'tile_data <- expand.grid(x=15:17, y=1:3)',
  'tile_data$value <- seq_len(nrow(tile_data)) / 10',
  'rect_data <- data.frame(xmin=c(18.1, 18.9), xmax=c(18.7, 19.5), ymin=c(1.1, 2.1), ymax=c(1.9, 2.9))',
  'contour_data <- expand.grid(x=seq(20, 22, length.out=11), y=seq(1, 3, length.out=11))',
  'contour_data$z <- with(contour_data, sin(x * 1.3) + cos(y * 2.1))',
  'p <- ggplot(df, aes(x, y, color=group)) +',
  '  geom_point(size=3, shape=21, fill="#FFFFFF", stroke=0.6) +',
  '  geom_point(aes(size=weight), shape=21, fill="#A6CEE3", stroke=0.7, alpha=0.8) +',
  '  geom_line(linewidth=0.8) +',
  '  geom_col(data=bars, aes(x=x, y=y, fill=group), inherit.aes=FALSE, width=0.5, colour="#333333", linewidth=0.45, alpha=0.3) +',
  '  geom_errorbar(data=err, aes(x=x, y=y, ymin=ymin, ymax=ymax), inherit.aes=FALSE, width=0.18, colour="#444444", linewidth=0.6) +',
  '  geom_pointrange(data=err, aes(x=x, y=y, ymin=ymin, ymax=ymax), inherit.aes=FALSE, shape=21, fill="#FDBF6F", colour="#B15928", size=2.4, linewidth=0.7) +',
  '  geom_violin(data=dist, aes(x=x, y=value, group=group, fill=group), inherit.aes=FALSE, alpha=0.25, colour="#238B45", linewidth=0.6, draw_quantiles=0.5) +',
  '  geom_boxplot(data=dist, aes(x=x, y=value, group=group, fill=group), inherit.aes=FALSE, width=0.22, alpha=0.75, colour="#333333", linewidth=0.55, outlier.shape=21, outlier.fill="white") +',
  '  geom_ribbon(data=band, aes(x=x, ymin=ymin, ymax=ymax, group=group, fill=group), inherit.aes=FALSE, position="identity", alpha=0.3, colour="#2166AC", linewidth=0.55) +',
  '  geom_area(data=area, aes(x=x, y=y, group=group, fill=group), inherit.aes=FALSE, position="identity", alpha=0.2, colour="#4D9221", linewidth=0.45) +',
  '  geom_step(data=step_data, aes(x=x, y=y), inherit.aes=FALSE, direction="vh", colour="#756BB1", linewidth=0.75) +',
  '  geom_histogram(data=bin_data, aes(x=x), inherit.aes=FALSE, binwidth=0.5, boundary=11, fill="#9ECAE1", colour="#2171B5", linewidth=0.45, alpha=0.65) +',
  '  geom_freqpoly(data=bin_data, aes(x=x), inherit.aes=FALSE, bins=6, boundary=11, colour="#E6550D", linewidth=0.8) +',
  '  geom_tile(data=tile_data, aes(x=x, y=y), inherit.aes=FALSE, fill="#C7E9C0", colour="#238B45", linewidth=0.35, alpha=0.85) +',
  '  geom_raster(data=tile_data, aes(x=x + 0.18, y=y + 0.18), inherit.aes=FALSE, fill="#9ECAE1", alpha=0.55) +',
  '  geom_rect(data=rect_data, aes(xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax), inherit.aes=FALSE, fill="#FDAE6B", colour="#E6550D", linewidth=0.25, alpha=0.35) +',
  '  geom_contour(data=contour_data, aes(x=x, y=y, z=z), inherit.aes=FALSE, bins=5, colour="#54278F", linewidth=0.65, linetype="solid", alpha=0.9) +',
  '  geom_contour_filled(data=contour_data, aes(x=x, y=y, z=z), inherit.aes=FALSE, bins=5, fill="#CBC9E2", colour="#6A51A3", linewidth=0.3, alpha=0.55) +',
  '  scale_fill_manual(values=c(A="#80B1D3", B="#FDB462", C="#B3DE69", D="#FCCDE5", E="#92C5DE", F="#A6D96A")) +',
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

function patchValueEquals(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right);
  }
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function patchTripletMatches(entry, expected) {
  return entry?.gid === expected?.gid
    && entry?.prop === expected?.prop
    && patchValueEquals(entry?.value, expected?.value);
}

function allPatchesApplied(responseBody, patches) {
  const applied = Array.isArray(responseBody?.applied) ? responseBody.applied : [];
  return patches.every((patch) => applied.some((entry) => patchTripletMatches(entry, patch)));
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

async function setComponentSelectByGroup(page, groupId, prop, value) {
  const select = page.locator(
    `[data-component-group-id="${groupId}"] select[data-param-role="select"][data-param-prop="${prop}"]`,
  ).first();
  if (!(await select.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await select.selectOption(String(value));
  await page.waitForTimeout(700);
  return true;
}

async function setRangeInComponentGroup(page, groupId, prop, value) {
  const input = page.locator(
    `[data-component-group-id="${groupId}"] input[data-param-role="range"][data-param-prop="${prop}"]`,
  ).first();
  if (!(await input.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await input.fill(String(value));
  await page.waitForTimeout(700);
  return Number(await input.inputValue()) === Number(value);
}

async function selectComponentObject(page, groupId, gid) {
  const objectButton = page.locator(`[data-component-group-id="${groupId}"] [data-component-object-id="${gid}"]`).first();
  if (!(await objectButton.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await objectButton.click();
  await page.waitForTimeout(400);
  return true;
}

async function selectComponentGroup(page, groupId) {
  const groupButton = page.locator(`[data-component-group-id="${groupId}"]`).getByRole('button', { name: '选中整组' }).first();
  if (!(await groupButton.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await groupButton.click();
  await page.waitForTimeout(400);
  return true;
}

async function countComponentParamControls(page, groupId, props) {
  const counts = {};
  for (const prop of props) {
    counts[prop] = await page.locator(`[data-component-group-id="${groupId}"] [data-param-prop="${prop}"]`).count();
  }
  return counts;
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
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/figure/patch'
  ), { timeout: 90000 }).catch(() => null);
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchBody: null, successful: false };
  const patchResponse = await responsePromise;
  await waitForApiSettle(start, 90000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const responseBody = await patchResponse?.json().catch(() => null);
  const requestPatches = patchList(patchBody);
  const rejected = Array.isArray(responseBody?.rejected) ? responseBody.rejected : [];
  const skipped = Array.isArray(responseBody?.skipped) ? responseBody.skipped : [];
  const successful = Boolean(
    patchResponse
    && patchResponse.status() >= 200
    && patchResponse.status() < 300
    && responseBody?.status === 'success'
    && rejected.length === 0
    && skipped.length === 0
    && allPatchesApplied(responseBody, requestPatches)
  );
  return { clicked, patchBody, responseBody, successful };
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

async function saveProjectAndReadPut(page) {
  const start = apiRequests.length;
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
  if (!(await saveButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    return { clicked: false, putBody: null, successful: false };
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
    && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
  ), { timeout: 40000 }).catch(() => null);
  await saveButton.click();
  const putResponse = await responsePromise;
  await waitForApiSettle(start, 40000);
  const putRequest = apiRequests.slice(start).find((request) => (
    request.method === 'PUT' && /\/api\/projects\/[^/]+$/.test(new URL(request.url).pathname)
  )) || null;
  return {
    clicked: true,
    putBody: parseJson(putRequest?.postData),
    successful: Boolean(putResponse && putResponse.status() >= 200 && putResponse.status() < 300),
  };
}

async function readFigureState(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      revision: figure?.revision || null,
      editLog: figure?.editLog || [],
      projectDrafts: state.projectDrafts || {},
    };
  });
}

function hasEdit(editLog, expected) {
  return Array.isArray(editLog) && editLog.some((entry) => (
    entry.gid === expected.gid
    && entry.prop === expected.prop
    && String(entry.value).toLowerCase() === String(expected.value).toLowerCase()
    && entry.mode === (expected.mode || 'backend_patch')
  ));
}

async function waitForEdits(page, expectedEdits, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await readFigureState(page);
    if (expectedEdits.every((edit) => hasEdit(state.editLog, edit))) return state;
    await page.waitForTimeout(500);
  }
  return readFigureState(page);
}

async function clickHistoryButton(page, label) {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  if (!(await button.isVisible({ timeout: 4000 }).catch(() => false))) {
    return { clicked: false, reason: 'not-visible', renderOk: false };
  }
  if (!(await button.isEnabled().catch(() => false))) {
    return { clicked: false, reason: 'disabled', renderOk: false };
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/figures/render')
  ), { timeout: 60000 }).catch(() => null);
  await button.click();
  const response = await responsePromise;
  await waitForPreviewReady(page);
  return { clicked: true, reason: '', renderOk: Boolean(response && response.status() >= 200 && response.status() < 300) };
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
      pointLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.kind === 'collection').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      errorbarLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.kind === 'errorbar_container').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      barLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'bar').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      boxplotLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'boxplot').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      violinLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'violin').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      bandLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && ['ribbon', 'area'].includes(obj.currentProps?.adapterFamily)).map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      stepLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'step').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      histogramLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'histogram').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      freqpolyLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'freqpoly').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      tileLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'tile').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      rasterLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'raster').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      rectLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.currentProps?.adapterFamily === 'rect').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      contourLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.kind === 'contour').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      contourfLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.kind === 'contourf').map((obj) => ({
        id: obj.id,
        kind: obj.kind,
        role: obj.role,
        editable: obj.editable,
        currentProps: obj.currentProps,
        source: obj.source,
      })),
      lineLayers: objects.filter((obj) => String(obj.id).startsWith('r.layer.') && obj.kind === 'line').map((obj) => ({
        id: obj.id,
        editable: obj.editable,
        currentProps: obj.currentProps,
      })),
      fillGroups: (figure.manifest?.groups || []).filter((group) => group.aesthetic === 'fill'),
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
      fixture.generatedBy === 'r_svg'
        && fixture.axisEditable.some((axis) => axis.editable?.includes('tick_labelsize'))
        && fixture.pointLayers.some((layer) => layer.editable?.includes('size_scale'))
        && fixture.pointLayers.some((layer) => layer.editable?.includes('marker') && Number(layer.currentProps?.marker) === 21)
        && fixture.errorbarLayers.some((layer) => layer.editable?.includes('capsize') && layer.currentProps?.capUnit === 'data')
        && fixture.errorbarLayers.some((layer) => layer.editable?.includes('marker') && layer.editable?.includes('markersize'))
        && fixture.barLayers.some((layer) => layer.editable?.includes('linewidth') && layer.currentProps?.fillMapped === true)
        && fixture.boxplotLayers.some((layer) => layer.editable?.includes('outlier_shape') && !layer.editable?.includes('median_color') && layer.currentProps?.componentRoles?.includes('median'))
        && fixture.violinLayers.some((layer) => !layer.editable?.includes('color') && !layer.editable?.includes('quantile_color') && layer.currentProps?.componentRoles?.includes('quantile_lines'))
        && fixture.bandLayers.length === 2
        && fixture.bandLayers.every((layer) => layer.editable?.includes('facecolor') && layer.editable?.includes('edgecolor') && layer.currentProps?.componentRoles?.includes('boundary_lines'))
        && fixture.stepLayers.length === 1
        && fixture.stepLayers.every((layer) => layer.kind === 'line' && layer.role === 'ggplot_GeomStep' && layer.source?.adapterClass === 'GeomStep' && layer.currentProps?.stepDirection === 'vh' && !layer.editable?.includes('stepDirection'))
        && fixture.histogramLayers.length === 1
        && fixture.histogramLayers.every((layer) => layer.kind === 'patch' && layer.role === 'ggplot_GeomBar' && layer.source?.adapterClass === 'GeomHistogram' && Number(layer.currentProps?.binwidth) === 0.5 && !layer.editable?.includes('binwidth'))
        && fixture.freqpolyLayers.length === 1
        && fixture.freqpolyLayers.every((layer) => layer.kind === 'line' && layer.role === 'ggplot_GeomPath' && layer.source?.adapterClass === 'GeomFreqpoly' && Number(layer.currentProps?.bins) === 6 && !layer.editable?.includes('bins'))
        && fixture.tileLayers.length === 1
        && fixture.tileLayers.every((layer) => layer.kind === 'patch' && layer.role === 'ggplot_GeomTile' && layer.source?.adapterClass === 'GeomTile' && layer.editable?.includes('facecolor') && layer.editable?.includes('edgecolor') && layer.editable?.includes('linewidth') && layer.editable?.includes('alpha') && !layer.editable?.includes('cmap'))
        && fixture.rasterLayers.length === 1
        && fixture.rasterLayers.every((layer) => layer.kind === 'patch' && layer.role === 'ggplot_GeomRaster' && layer.source?.adapterClass === 'GeomRaster' && layer.editable?.includes('facecolor') && layer.editable?.includes('alpha') && !layer.editable?.includes('edgecolor') && !layer.editable?.includes('linewidth') && !layer.editable?.includes('cmap'))
        && fixture.rectLayers.length === 1
        && fixture.rectLayers.every((layer) => layer.kind === 'patch' && layer.role === 'ggplot_GeomRect' && layer.source?.adapterClass === 'GeomRect' && layer.editable?.includes('facecolor') && layer.editable?.includes('edgecolor') && layer.editable?.includes('linewidth') && layer.editable?.includes('alpha') && !layer.editable?.includes('cmap'))
        && fixture.contourLayers.length === 1
        && fixture.contourLayers.every((layer) => layer.kind === 'contour' && layer.role === 'ggplot_GeomContour' && layer.source?.adapterClass === 'GeomContour' && layer.editable?.includes('linewidth') && layer.editable?.includes('linestyle') && layer.editable?.includes('alpha') && Array.isArray(layer.currentProps?.levels) && !layer.editable?.includes('levels') && !layer.editable?.includes('bins') && !layer.editable?.includes('breaks'))
        && fixture.contourfLayers.length === 1
        && fixture.contourfLayers.every((layer) => layer.kind === 'contourf' && layer.role === 'ggplot_GeomContourFilled' && layer.source?.adapterClass === 'GeomContourFilled' && layer.editable?.includes('facecolor') && layer.editable?.includes('edgecolor') && layer.editable?.includes('linewidth') && layer.editable?.includes('linestyle') && layer.editable?.includes('alpha') && Array.isArray(layer.currentProps?.levels) && !layer.editable?.includes('levels') && !layer.editable?.includes('bins') && !layer.editable?.includes('breaks'))
        && fixture.fillGroups.some((group) => group.kind === 'distribution' && group.geomFamilies?.includes('GeomBoxplot') && group.geomFamilies?.includes('GeomViolin'))
        && fixture.fillGroups.some((group) => group.kind === 'band' && group.geomFamilies?.includes('GeomRibbon') && group.geomFamilies?.includes('GeomArea'))
        ? 'PASS' : 'FAIL',
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
    const familyLineIds = [...fixture.stepLayers, ...fixture.freqpolyLayers].map((layer) => layer.id);
    const componentOk = componentChanged
      && componentDraft
      && componentApply.successful
      && componentPatches.some((patch) => String(patch.gid).startsWith('r.layer.') && patch.prop === 'linewidth' && Number(patch.value) === 2.2)
      && familyLineIds.every((gid) => componentPatches.some((patch) => patch.gid === gid && patch.prop === 'linewidth' && Number(patch.value) === 2.2));
    record('R2-component-center', componentOk ? 'PASS' : 'FAIL', `changed=${componentChanged}, draft=${componentDraft}, patches=${JSON.stringify(componentPatches)}`);

    await clickText(page, '组件中心');
    const pointSizeValue = 1.7;
    const pointSizeChanged = await setComponentNumberByGroup(page, 'points', 'size_scale', pointSizeValue);
    const pointSizeDraft = (await getBodyText(page)).includes('已暂存');
    const pointSizeApply = pointSizeChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const pointSizePatches = patchList(pointSizeApply.patchBody);
    const pointSizeExpectedEdits = pointSizePatches.map((patch) => ({
      gid: patch.gid,
      prop: 'size_scale',
      value: pointSizeValue,
    }));
    const pointSizeState = await waitForEdits(page, pointSizeExpectedEdits);
    const pointSizeOk = pointSizeChanged
      && pointSizeDraft
      && pointSizeApply.successful
      && pointSizePatches.length >= 1
      && pointSizePatches.every((patch) => (
        String(patch.gid).startsWith('r.layer.')
        && patch.prop === 'size_scale'
        && Number(patch.value) === pointSizeValue
      ))
      && pointSizeExpectedEdits.every((edit) => hasEdit(pointSizeState.editLog, edit));
    record('R2b-point-size-scale', pointSizeOk ? 'PASS' : 'FAIL', `changed=${pointSizeChanged}, draft=${pointSizeDraft}, stateRevision=${pointSizeState.revision}, patches=${JSON.stringify(pointSizePatches)}`);

    await clickText(page, '组件中心');
    const markerValue = 24;
    const markerChanged = await setComponentSelectByGroup(page, 'points', 'marker', markerValue);
    const markerDraft = (await getBodyText(page)).includes('已暂存');
    const markerApply = markerChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const markerPatches = patchList(markerApply.patchBody);
    const markerExpectedEdits = markerPatches.map((patch) => ({
      gid: patch.gid,
      prop: 'marker',
      value: markerValue,
    }));
    const markerState = await waitForEdits(page, markerExpectedEdits);
    const markerOk = markerChanged
      && markerDraft
      && markerApply.successful
      && markerPatches.length >= 1
      && markerPatches.every((patch) => (
        String(patch.gid).startsWith('r.layer.')
        && patch.prop === 'marker'
        && Number(patch.value) === markerValue
      ))
      && markerExpectedEdits.every((edit) => hasEdit(markerState.editLog, edit));
    record('R2c-point-marker', markerOk ? 'PASS' : 'FAIL', `changed=${markerChanged}, draft=${markerDraft}, stateRevision=${markerState.revision}, patches=${JSON.stringify(markerPatches)}`);

    await clickText(page, '组件中心');
    const tileSelected = await selectComponentObject(page, 'patches', fixture.tileLayers[0]?.id);
    const rasterSelected = await selectComponentObject(page, 'patches', fixture.rasterLayers[0]?.id);
    const rectSelected = await selectComponentObject(page, 'patches', fixture.rectLayers[0]?.id);
    const contourSelected = await selectComponentObject(page, 'contours', fixture.contourLayers[0]?.id);
    const contourfSelected = await selectComponentObject(page, 'contours', fixture.contourfLayers[0]?.id);
    const contourGroupSelected = await selectComponentGroup(page, 'contours');
    const contourReadonlyControls = await countComponentParamControls(page, 'contours', ['levels', 'x', 'y', 'z', 'bins', 'breaks']);
    const contourReadonlyTextVisible = await page.locator('[data-component-group-id="contours"]').getByText('levels（只读）', { exact: true }).count() > 0;
    const family8PatchTargetKey = [
      ...fixture.barLayers,
      ...fixture.histogramLayers,
      ...fixture.tileLayers,
      ...fixture.rasterLayers,
      ...fixture.rectLayers,
    ].map((layer) => layer.id).join('|');
    const family8PatchEdgeChanged = await setColorByScope(page, `component:patches:${family8PatchTargetKey}:edgecolor`, '#1b7837');
    const family8PatchAlphaChanged = await setRangeInComponentGroup(page, 'patches', 'alpha', 0.6);
    const family8ContourLineChanged = await setNumberByParam(page, 'component-contours', 'linewidth', 1.75);
    const family8ContourStyleChanged = await setSelectByParam(page, 'component-contours', 'linestyle', 'dashed');
    const family8Draft = (await getBodyText(page)).includes('已暂存');
    const family8Apply = family8PatchEdgeChanged
      && family8PatchAlphaChanged
      && family8ContourLineChanged
      && family8ContourStyleChanged
      ? await applyDraftAndReadPatch(page)
      : { patchBody: null, successful: false };
    const family8Patches = patchList(family8Apply.patchBody);
    const family8ExpectedEdits = family8Patches.map((patch) => ({
      gid: patch.gid,
      prop: patch.prop,
      value: patch.value,
    }));
    const family8State = await waitForEdits(page, family8ExpectedEdits);
    const family8TileOk = fixture.tileLayers.every((layer) => (
      family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'edgecolor' && String(patch.value).toLowerCase() === '#1b7837')
      && family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'alpha' && Number(patch.value) === 0.6)
    ));
    const family8RectOk = fixture.rectLayers.every((layer) => (
      family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'edgecolor' && String(patch.value).toLowerCase() === '#1b7837')
      && family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'alpha' && Number(patch.value) === 0.6)
    ));
    const family8RasterOk = fixture.rasterLayers.every((layer) => (
      family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'alpha' && Number(patch.value) === 0.6)
      && !family8Patches.some((patch) => patch.gid === layer.id && ['edgecolor', 'linewidth'].includes(patch.prop))
    ));
    const family8ContourOk = [...fixture.contourLayers, ...fixture.contourfLayers].every((layer) => (
      family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'linewidth' && Number(patch.value) === 1.75)
      && family8Patches.some((patch) => patch.gid === layer.id && patch.prop === 'linestyle' && String(patch.value) === 'dashed')
    ));
    const family8ReadonlyOk = Object.values(contourReadonlyControls).every((count) => count === 0);
    const family8SelectionOk = tileSelected && rasterSelected && rectSelected && contourSelected && contourfSelected && contourGroupSelected;
    const family8Ok = family8SelectionOk
      && family8ReadonlyOk
      && family8PatchEdgeChanged
      && family8PatchAlphaChanged
      && family8ContourLineChanged
      && family8ContourStyleChanged
      && family8Draft
      && family8Apply.successful
      && family8TileOk
      && family8RectOk
      && family8RasterOk
      && family8ContourOk
      && family8ExpectedEdits.every((edit) => hasEdit(family8State.editLog, edit));
    record('R2e-family8-tile-contour-components', family8Ok ? 'PASS' : 'FAIL', `selection=${JSON.stringify({ tileSelected, rasterSelected, rectSelected, contourSelected, contourfSelected, contourGroupSelected })}, readonly=${JSON.stringify(contourReadonlyControls)}, readonlyText=${contourReadonlyTextVisible}, changed=${JSON.stringify({ family8PatchEdgeChanged, family8PatchAlphaChanged, family8ContourLineChanged, family8ContourStyleChanged })}, draft=${family8Draft}, patches=${JSON.stringify(family8Patches)}`);

    await clickText(page, '组件中心');
    const componentSvgBefore = await page.locator('[data-scifigure-canvas-svg="true"] > svg').first().evaluate((node) => node.outerHTML).catch(() => '');
    const barLineChanged = await setComponentNumberByGroup(page, 'patches', 'linewidth', 1.25);
    const errorbarLineChanged = await setComponentNumberByGroup(page, 'errorbars', 'elinewidth', 1.45);
    const errorbarCapChanged = await setComponentNumberByGroup(page, 'errorbars', 'capsize', 0.35);
    const errorbarMarkerChanged = await setComponentSelectByGroup(page, 'errorbars', 'marker', 25);
    const errorbarMarkerSizeChanged = await setComponentNumberByGroup(page, 'errorbars', 'markersize', 4.5);
    const boxplotTargetKey = fixture.boxplotLayers.map((layer) => layer.id).join('|');
    const violinTargetKey = fixture.violinLayers.map((layer) => layer.id).join('|');
    const bandTargetKey = fixture.bandLayers.map((layer) => layer.id).join('|');
    const lineTargetKey = fixture.lineLayers.map((layer) => layer.id).join('|');
    const patchTargetKey = [
      ...fixture.barLayers,
      ...fixture.histogramLayers,
      ...fixture.tileLayers,
      ...fixture.rasterLayers,
      ...fixture.rectLayers,
    ].map((layer) => layer.id).join('|');
    const legacyMedianControlHidden = await page.locator('[data-component-group-id="boxplots"]').getByText('中位线颜色', { exact: true }).count() === 0;
    const familyLineColorChanged = await setColorByScope(page, `component:lines:${lineTargetKey}:color`, '#08519c');
    const familyPatchFillChanged = await setColorByScope(page, `component:patches:${patchTargetKey}:color`, '#fdd0a2');
    const boxplotOutlierColorChanged = await setColorByScope(page, `component:boxplots:${boxplotTargetKey}:outlier_color`, '#de2d26');
    const boxplotOutlierShapeChanged = await setComponentSelectByGroup(page, 'boxplots', 'outlier_shape', 24);
    const boxplotOutlierSizeChanged = await setComponentNumberByGroup(page, 'boxplots', 'outlier_size', 3.2);
    const violinEdgeChanged = await setColorByScope(page, `component:violins:${violinTargetKey}:edgecolor`, '#54278f');
    const violinLineChanged = await setComponentNumberByGroup(page, 'violins', 'linewidth', 1.35);
    const bandFillChanged = await setColorByScope(page, `component:bands:${bandTargetKey}:color`, '#8c510a');
    const bandLineChanged = await setComponentNumberByGroup(page, 'bands', 'linewidth', 1.15);
    const errorbarDraft = (await getBodyText(page)).includes('已暂存');
    const componentBatchApply = barLineChanged
      && errorbarLineChanged
      && errorbarCapChanged
      && errorbarMarkerChanged
      && errorbarMarkerSizeChanged
      && legacyMedianControlHidden
      && familyLineColorChanged
      && familyPatchFillChanged
      && boxplotOutlierColorChanged
      && boxplotOutlierShapeChanged
      && boxplotOutlierSizeChanged
      && violinEdgeChanged
      && violinLineChanged
      && bandFillChanged
      && bandLineChanged
      ? await applyDraftAndReadPatch(page)
      : { patchBody: null, successful: false };
    const componentBatchPatches = patchList(componentBatchApply.patchBody);
    const componentBatchExpectedEdits = componentBatchPatches.map((patch) => ({
      gid: patch.gid,
      prop: patch.prop,
      value: patch.value,
    }));
    const componentBatchState = await waitForEdits(page, componentBatchExpectedEdits);
    const componentSvgAfter = await page.locator('[data-scifigure-canvas-svg="true"] > svg').first().evaluate((node) => node.outerHTML).catch(() => '');
    const errorbarProps = new Set(componentBatchPatches
      .filter((patch) => patch.prop !== 'linewidth')
      .map((patch) => patch.prop));
    const barPatch = componentBatchPatches.find((patch) => patch.prop === 'linewidth' && Number(patch.value) === 1.25);
    const boxplotProps = new Set(componentBatchPatches
      .filter((patch) => patch.gid === fixture.boxplotLayers[0]?.id)
      .map((patch) => patch.prop));
    const violinProps = new Set(componentBatchPatches
      .filter((patch) => patch.gid === fixture.violinLayers[0]?.id)
      .map((patch) => patch.prop));
    const bandPatchCoverage = fixture.bandLayers.every((layer) => {
      const props = new Set(componentBatchPatches
        .filter((patch) => patch.gid === layer.id)
        .map((patch) => patch.prop));
      return props.has('facecolor') && props.has('linewidth');
    });
    const familyLineColorCoverage = [...fixture.stepLayers, ...fixture.freqpolyLayers].every((layer) => (
      componentBatchPatches.some((patch) => patch.gid === layer.id && patch.prop === 'color' && String(patch.value).toLowerCase() === '#08519c')
    ));
    const histogramPatchCoverage = fixture.histogramLayers.every((layer) => {
      const props = new Set(componentBatchPatches
        .filter((patch) => patch.gid === layer.id)
        .map((patch) => patch.prop));
      return props.has('facecolor') && props.has('linewidth');
    });
    const componentBatchOk = barLineChanged
      && errorbarLineChanged
      && errorbarCapChanged
      && errorbarMarkerChanged
      && errorbarMarkerSizeChanged
      && legacyMedianControlHidden
      && familyLineColorChanged
      && familyPatchFillChanged
      && boxplotOutlierColorChanged
      && boxplotOutlierShapeChanged
      && boxplotOutlierSizeChanged
      && violinEdgeChanged
      && violinLineChanged
      && bandFillChanged
      && bandLineChanged
      && errorbarDraft
      && componentBatchApply.successful
      && Boolean(barPatch)
      && ['elinewidth', 'capsize', 'marker', 'markersize'].every((prop) => errorbarProps.has(prop))
      && ['outlier_color', 'outlier_shape', 'outlier_size'].every((prop) => boxplotProps.has(prop))
      && ['edgecolor', 'linewidth'].every((prop) => violinProps.has(prop))
      && bandPatchCoverage
      && familyLineColorCoverage
      && histogramPatchCoverage
      && componentSvgBefore !== componentSvgAfter
      && componentSvgAfter.toLowerCase().includes('#de2d26')
      && componentSvgAfter.toLowerCase().includes('#8c510a')
      && componentSvgAfter.toLowerCase().includes('#08519c')
      && componentSvgAfter.toLowerCase().includes('#fdd0a2')
      && componentBatchPatches.every((patch) => String(patch.gid).startsWith('r.layer.'))
      && componentBatchExpectedEdits.every((edit) => hasEdit(componentBatchState.editLog, edit));
    record('R2d-r-layer-components', componentBatchOk ? 'PASS' : 'FAIL', `changed=${JSON.stringify({ barLineChanged, errorbarLineChanged, errorbarCapChanged, errorbarMarkerChanged, errorbarMarkerSizeChanged, legacyMedianControlHidden, familyLineColorChanged, familyPatchFillChanged, boxplotOutlierColorChanged, boxplotOutlierShapeChanged, boxplotOutlierSizeChanged, violinEdgeChanged, violinLineChanged, bandFillChanged, bandLineChanged })}, draft=${errorbarDraft}, patches=${JSON.stringify(componentBatchPatches)}`);

    const expectedCoreEdits = [
      ...pointSizeExpectedEdits,
      ...markerExpectedEdits,
      ...family8ExpectedEdits,
      ...componentBatchExpectedEdits,
    ];
    const saveResult = await saveProjectAndReadPut(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForPreviewReady(page);
    const refreshedState = await waitForEdits(page, expectedCoreEdits);
    const refreshOk = saveResult.successful
      && expectedCoreEdits.length >= 6
      && expectedCoreEdits.every((edit) => hasEdit(refreshedState.editLog, edit));
    record('R3b-save-refresh-component-edits', refreshOk ? 'PASS' : 'FAIL', `save=${JSON.stringify({ clicked: saveResult.clicked, successful: saveResult.successful })}, refreshedRevision=${refreshedState.revision}, expected=${JSON.stringify(expectedCoreEdits)}`);

    const undoResult = await clickHistoryButton(page, '撤销');
    const undoState = await readFigureState(page);
    const undoOk = undoResult.clicked
      && undoResult.renderOk
      && componentBatchExpectedEdits.length >= 5
      && componentBatchExpectedEdits.every((edit) => !hasEdit(undoState.editLog, edit))
      && [...pointSizeExpectedEdits, ...markerExpectedEdits, ...family8ExpectedEdits].every((edit) => hasEdit(undoState.editLog, edit));
    record(
      'R3c-undo-bar-errorbar-batch',
      undoResult.clicked ? (undoOk ? 'PASS' : 'FAIL') : 'BLOCKED',
      `undo=${JSON.stringify(undoResult)}, editLog=${JSON.stringify(undoState.editLog)}`,
    );

    const redoResult = await clickHistoryButton(page, '重做');
    const redoState = await waitForEdits(page, expectedCoreEdits);
    const redoOk = redoResult.clicked
      && redoResult.renderOk
      && componentBatchExpectedEdits.length >= 5
      && expectedCoreEdits.every((edit) => hasEdit(redoState.editLog, edit));
    record(
      'R3d-redo-bar-errorbar-batch',
      redoResult.clicked ? (redoOk ? 'PASS' : 'FAIL') : 'BLOCKED',
      `redo=${JSON.stringify(redoResult)}, revision=${redoState.revision}`,
    );

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
    const fillPaletteChanged = await setColorByScope(page, 'palette:r.scale.fill.0.2', '#fb9a99')
      || await setColorControl(page, 'C', '填充色', '#fb9a99');
    const paletteDraft = (await getBodyText(page)).includes('已暂存');
    const paletteApply = paletteChanged && fillPaletteChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const palettePatches = patchList(paletteApply.patchBody);
    const paletteOk = paletteChanged
      && fillPaletteChanged
      && paletteDraft
      && paletteApply.successful
      && palettePatches.some((patch) => String(patch.gid).startsWith('r.group.color.') && patch.prop === 'color' && String(patch.value).toLowerCase() === '#2ca02c')
      && palettePatches.some((patch) => String(patch.gid).startsWith('r.group.fill.') && patch.prop === 'facecolor' && String(patch.value).toLowerCase() === '#fb9a99');
    record('R3-palette-center', paletteOk ? 'PASS' : 'FAIL', `changed=${JSON.stringify({ paletteChanged, fillPaletteChanged })}, draft=${paletteDraft}, response=${JSON.stringify(paletteApply.responseBody)}, patches=${JSON.stringify(palettePatches)}`);

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
      && exportedEdits.some((patch) => String(patch.gid).startsWith('r.group.color.') && patch.prop === 'color')
      && exportedEdits.some((patch) => String(patch.gid).startsWith('r.group.fill.') && patch.prop === 'facecolor')
      && expectedCoreEdits.every((edit) => hasEdit(exportedEdits, edit));
    record('R5-export-state', exportOk ? 'PASS' : 'FAIL', `environment=${exported?.bundle?.metadata?.environment}, edits=${JSON.stringify(exportedEdits)}`);

    const snapshotSave = await saveProjectAndReadPut(page);
    const projectExported = snapshotSave.successful ? await requestJson(`/api/projects/${projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
    }) : null;
    const exportAsset = projectExported?.figures?.[0]?.asset || projectExported?.asset || null;
    await clickText(page, '组件中心');
    const postExportLineValue = 0.95;
    const postExportChanged = exportAsset?.assetId ? await setNumberByParam(page, 'component-contours', 'linewidth', postExportLineValue) : false;
    const postExportApply = postExportChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const postExportPatches = patchList(postExportApply.patchBody);
    const postExportExpectedEdits = postExportPatches.map((patch) => ({
      gid: patch.gid,
      prop: patch.prop,
      value: patch.value,
    }));
    const postExportState = await waitForEdits(page, postExportExpectedEdits);
    const postExportSave = postExportApply.successful ? await saveProjectAndReadPut(page) : { successful: false };
    const restored = postExportSave.successful ? await requestJson(`/api/projects/${projectId}/export-assets/${exportAsset.assetId}/restore`, {
      method: 'POST',
    }) : null;
    const restoredProject = restored?.status === 'success' ? await requestJson(`/api/projects/${projectId}`) : null;
    const restoredFigures = restoredProject?.project?.figures || restoredProject?.figures || [];
    const restoredFigure = restoredFigures.find((item) => item.figureId === 'fig_1') || null;
    const restoredEditLog = restoredFigure?.editLog || [];
    const snapshotRestoreOk = snapshotSave.successful
      && projectExported?.status === 'success'
      && projectExported?.figures?.[0]?.figureId === 'fig_1'
      && exportAsset?.assetId
      && exportAsset?.hasEditingSnapshot === true
      && postExportChanged
      && postExportApply.successful
      && postExportPatches.length >= 1
      && postExportExpectedEdits.every((edit) => hasEdit(postExportState.editLog, edit))
      && postExportSave.successful
      && restored?.status === 'success'
      && restored?.targetFigureId === 'fig_1'
      && expectedCoreEdits.every((edit) => hasEdit(restoredEditLog, edit))
      && postExportExpectedEdits.every((edit) => !hasEdit(restoredEditLog, edit));
    record('R4b-export-snapshot-restore', snapshotRestoreOk ? 'PASS' : 'FAIL', `asset=${JSON.stringify(exportAsset)}, postExport=${JSON.stringify(postExportPatches)}, restored=${JSON.stringify({ status: restored?.status, targetFigureId: restored?.targetFigureId, editCount: restoredEditLog.length })}`);

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
