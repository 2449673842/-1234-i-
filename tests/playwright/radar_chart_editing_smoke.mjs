import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || '';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `radar-chart-editing-${RUN_ID}`);

const RADAR_SCRIPT = [
  'from __future__ import annotations',
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  '',
  'labels = ["Quality", "Speed", "Cost", "Reliability"]',
  'angles = np.linspace(0, 2 * np.pi, len(labels), endpoint=False)',
  'angles_closed = np.r_[angles, angles[0]]',
  'model_a = np.array([0.82, 0.64, 0.48, 0.91])',
  'model_b = np.array([0.58, 0.76, 0.69, 0.62])',
  '',
  'fig, ax = plt.subplots(figsize=(4.4, 4.4), subplot_kw={"projection": "polar"})',
  'fig.subplots_adjust(left=0.18, right=0.82, bottom=0.18, top=0.82)',
  'ax.set_ylim(0, 1)',
  'ax.set_xticks(angles)',
  'ax.set_xticklabels(labels)',
  'ax.plot(angles_closed, np.r_[model_a, model_a[0]], color="#3366cc", linewidth=2.0, label="Model A")',
  'ax.fill(angles_closed, np.r_[model_a, model_a[0]], color="#3366cc", alpha=0.22)',
  'ax.plot(angles_closed, np.r_[model_b, model_b[0]], color="#cc6633", linewidth=2.0, label="Model B")',
  'ax.fill(angles_closed, np.r_[model_b, model_b[0]], color="#cc6633", alpha=0.18)',
  'ax.text(',
  '    0.5,',
  '    0.94,',
  '    "Radar note",',
  '    transform=ax.transAxes,',
  '    ha="center",',
  '    va="center",',
  '    bbox={',
  '        "boxstyle": "round,pad=0.30",',
  '        "facecolor": "#ffeeaa",',
  '        "edgecolor": "#333333",',
  '        "alpha": 0.8,',
  '        "linewidth": 1.2,',
  '    },',
  ')',
  'ax.legend(loc="center", bbox_to_anchor=(0.78, 0.82))',
].join('\n');

const R_RADAR_SCRIPT = [
  'library(ggplot2)',
  'dimensions <- c("Quality", "Speed", "Cost", "Reliability", "Safety")',
  'radar <- data.frame(',
  '  series = rep(c("Control", "Treatment"), each = length(dimensions) + 1L),',
  '  dimension = rep(c(dimensions, dimensions[[1]]), 2L),',
  '  value = c(0.72, 0.58, 0.66, 0.81, 0.63, 0.72, 0.84, 0.76, 0.52, 0.88, 0.79, 0.84)',
  ')',
  'radar$dimension <- factor(radar$dimension, levels = dimensions)',
  'p <- ggplot(radar, aes(dimension, value, group = series, colour = series, fill = series)) +',
  '  geom_polygon(alpha = 0.20, linewidth = 0.8) +',
  '  geom_line(linewidth = 1.0) +',
  '  geom_point(size = 2.0) +',
  '  scale_color_manual(values = c(Control = "#006D5B", Treatment = "#D55E00"), name = "Group") +',
  '  scale_fill_manual(values = c(Control = "#6FCF97", Treatment = "#E69F00"), name = "Group") +',
  '  coord_polar() + scale_y_continuous(limits = c(0, 1)) +',
  '  labs(title = "R radar editing") + theme_minimal(base_size = 10)',
  'p',
].join('\n');

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};
let authToken = '';

function assertIsolatedEnvironment() {
  assert.equal(process.env.SCIFIGURE_TEST_ISOLATED, '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  assert.ok(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert.equal(url.hostname, '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert.notEqual(url.port, '3000', 'test refuses localhost:3000/default port');
  assert.ok(process.env.SCIFIGURE_DATA_DIR, 'isolated test requires SCIFIGURE_DATA_DIR');
  assert.ok(process.env.SCIFIGURE_DB_PATH, 'isolated test requires SCIFIGURE_DB_PATH');
  const resolvedDataDir = path.resolve(process.env.SCIFIGURE_DATA_DIR);
  const resolvedDbPath = path.resolve(process.env.SCIFIGURE_DB_PATH);
  assert.ok(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `test refuses non-isolated data dir: ${resolvedDataDir}`);
  assert.ok(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `test refuses DB outside isolated data dir: ${resolvedDbPath}`);
  assert.notEqual(resolvedDataDir, path.resolve(ROOT, 'data'), 'test refuses repository data/ directory');
}

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  assert.ok(response.ok, `${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function objects(manifest) {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
}

function findObject(manifest, predicate, label) {
  const object = objects(manifest).find(predicate);
  assert.ok(object?.id, `${label} missing from manifest: ${JSON.stringify(objects(manifest).map(item => ({
    id: item.id,
    kind: item.kind,
    role: item.role,
    props: item.currentProps,
    editable: item.editable,
  })))}`);
  return object;
}

function findRadarTargets(manifest) {
  return {
    dimensionLabel: findObject(
      manifest,
      object => String(object.id || '').startsWith('xtick.')
        && object.currentProps?.text === 'Quality'
        && object.currentProps?.radarSemanticRole === 'dimension_label'
        && Array.isArray(object.editable)
        && object.editable.includes('radar_label_offset'),
      'radar dimension label',
    ),
    legend: findObject(
      manifest,
      object => object.id === 'legend.0'
        && Array.isArray(object.editable)
        && object.editable.includes('position'),
      'radar legend container',
    ),
    legendText: findObject(
      manifest,
      object => object.id === 'legend_text.0.0'
        && object.role === 'legend_text'
        && object.currentProps?.text === 'Model A'
        && Array.isArray(object.editable)
        && object.editable.includes('text'),
      'radar legend text',
    ),
    ordinaryText: findObject(
      manifest,
      object => String(object.id || '').startsWith('text.')
        && object.currentProps?.text === 'Radar note'
        && object.currentProps?.bbox_visible === true
        && Array.isArray(object.editable)
        && object.editable.includes('bbox_facecolor'),
      'ordinary text with bbox',
    ),
    radarLine: findObject(
      manifest,
      object => object.kind === 'line'
        && object.currentProps?.radarSemanticRole === 'series'
        && object.label === 'Model A',
      'radar line',
    ),
    radarFill: findObject(
      manifest,
      object => object.kind === 'patch'
        && object.currentProps?.radarSemanticRole === 'fill'
        && Number(object.currentProps?.alpha) === 0.22,
      'radar fill',
    ),
  };
}

function findRRadarTargets(manifest) {
  const radarGroup = (role, groupKey) => findObject(
    manifest,
    object => object.currentProps?.radarSemanticRole === role
      && object.currentProps?.groupKey === groupKey,
    `R radar ${role} ${groupKey}`,
  );
  return {
    dimensionLabel: findObject(
      manifest,
      object => object.currentProps?.radarSemanticRole === 'dimension_label'
        && object.currentProps?.text === 'Quality'
        && object.editable?.includes('radar_label_offset'),
      'R radar dimension label',
    ),
    legendText: findObject(
      manifest,
      object => object.currentProps?.radarSemanticRole === 'legend_text'
        && object.currentProps?.radarSeriesLabel === 'Control'
        && object.editable?.includes('text'),
      'R radar legend text',
    ),
    controlLine: radarGroup('series', 'Control'),
    treatmentLine: radarGroup('series', 'Treatment'),
    controlFill: radarGroup('fill', 'Control'),
    treatmentFill: radarGroup('fill', 'Treatment'),
  };
}

async function createRadarProject() {
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `Radar chart editing smoke ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: RADAR_SCRIPT,
        script: RADAR_SCRIPT,
        script_language: 'python',
        figure: { width: 120, height: 120, unit: 'mm', dpi: 300 },
      },
    }),
  });
  assert.ok(created?.id, `project creation returned no id: ${JSON.stringify(created)}`);

  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: RADAR_SCRIPT,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `radar-chart-editing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert.equal(rendered?.status, 'success', `radar render failed: ${JSON.stringify(rendered)}`);
  const figure = rendered.figures?.find(item => item.figureId === 'fig_1');
  assert.ok(figure?.svg && figure?.manifest?.objects?.length > 0, `render returned no fig_1 SVG/manifest: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, figure };
}

async function createRRadarProject() {
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `R radar chart editing smoke ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: R_RADAR_SCRIPT,
        script: R_RADAR_SCRIPT,
        script_language: 'r',
        figure: { width: 120, height: 100, unit: 'mm', dpi: 300 },
      },
    }),
  });
  assert.ok(created?.id, `R radar project creation returned no id: ${JSON.stringify(created)}`);
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: R_RADAR_SCRIPT,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-radar-chart-editing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert.equal(rendered?.status, 'success', `R radar render failed: ${JSON.stringify(rendered)}`);
  const figure = rendered.figures?.find(item => item.figureId === 'fig_1');
  assert.ok(figure?.svg && figure?.manifest?.objects?.length > 0, 'R radar render returned no fig_1 SVG/manifest');
  return { projectId: created.id, figure };
}

async function installProjectState(page, projectId, figure, selectedGids = []) {
  const spec = {
    plot_type: 'custom',
    custom_script: RADAR_SCRIPT,
    script: RADAR_SCRIPT,
    script_language: 'python',
    figure: { width: 120, height: 120, unit: 'mm', dpi: 300 },
  };
  await page.evaluate(({ spec, projectId, figure, selectedGids }) => {
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
      projectId,
      projectName: 'Radar chart editing smoke fixture',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: [],
      datasets: [],
      selectedGids,
      projectHistory: {},
      projectDrafts: {},
      figSession: null,
      renderLog: ['> Radar chart editing fixture ready'],
      currentView: 'workspace',
      subView: 'home',
    }));
  }, { spec, projectId, figure, selectedGids });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPreviewReady(page);
}

async function installRRadarProjectState(page, projectId, figure) {
  const spec = {
    plot_type: 'custom',
    custom_script: R_RADAR_SCRIPT,
    script: R_RADAR_SCRIPT,
    script_language: 'r',
    figure: { width: 120, height: 100, unit: 'mm', dpi: 300 },
  };
  await page.evaluate(({ spec, projectId, figure }) => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'R radar chart editing smoke fixture',
      projectFigures: {
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
      },
      activeFigureId: 'fig_1',
      selectedFigureIds: [],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      figSession: null,
      renderLog: ['> R radar chart editing fixture ready'],
      currentView: 'workspace',
      subView: 'home',
    }));
  }, { spec, projectId, figure });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPreviewReady(page);
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('正在重新渲染当前图形')
      || body.includes('等待 Python 渲染结果')
      || body.includes('正在恢复项目预览')
      || body.includes('渲染中')
      || body.includes('应用中');
    const svgCount = await page.locator('div[data-svg-bytes] > svg, [data-scifigure-canvas-svg="true"] > svg').count().catch(() => 0);
    if (!rendering && svgCount > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(500);
  }
  throw new Error('timed out waiting for radar preview');
}

async function clickVisibleText(page, text, timeout = 5000) {
  const candidates = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(new RegExp(text)).first(),
  ];
  for (const locator of candidates) {
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(300);
      return true;
    }
  }
  return false;
}

async function clickTab(page, name) {
  const clicked = await clickVisibleText(page, name, 5000);
  assert.ok(clicked, `could not click tab/button: ${name}`);
}

async function ensureDragMode(page, enabled) {
  const button = page.getByRole('button', { name: /拖拽微调/ }).first();
  await button.waitFor({ state: 'visible', timeout: 10000 });
  const text = (await button.textContent().catch(() => '')) || '';
  const isEnabled = text.includes('开');
  if (isEnabled !== enabled) {
    await button.click();
    await page.waitForTimeout(400);
  }
  const nextText = (await button.textContent().catch(() => '')) || '';
  assert.equal(nextText.includes('开'), enabled, `drag mode did not become ${enabled ? 'enabled' : 'disabled'}: ${nextText}`);
}

async function svgBoxForGid(page, gid) {
  return page.evaluate((targetGid) => {
    const escaped = CSS.escape(targetGid);
    const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return null;
    return {
      id: node.id || node.getAttribute('data-fig-id') || targetGid,
      text: node.textContent || '',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  }, gid);
}

async function svgLocalGeometryForGid(page, gid) {
  return page.evaluate((targetGid) => {
    const escaped = CSS.escape(targetGid);
    const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
    if (!(node instanceof SVGGraphicsElement)) return null;
    const box = node.getBBox();
    return {
      id: node.id || node.getAttribute('data-fig-id') || targetGid,
      text: node.textContent || '',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      width: box.width,
      height: box.height,
    };
  }, gid);
}

async function clickGid(page, gid) {
  const box = await svgBoxForGid(page, gid);
  assert.ok(box, `missing SVG element for ${gid}`);
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(500);
  await page.waitForFunction((targetGid) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) && state.selectedGids.includes(targetGid);
  }, gid);
  return box;
}

async function selectLayerNode(page, gid) {
  const locator = page.locator(`[data-layer-node-id="${gid}"]`).first();
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click();
  await page.waitForFunction((targetGid) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) && state.selectedGids.includes(targetGid);
  }, gid);
}

async function dragGid(page, gid, dx, dy) {
  const box = await svgBoxForGid(page, gid);
  assert.ok(box, `missing SVG element for ${gid}`);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(600);
  return box;
}

async function waitForPatchAfter(startIndex, predicate, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = apiRequests.slice(startIndex)
      .filter(request => request.url.includes('/api/figure/patch'))
      .find(request => predicate(parseJson(request.postData, {}), request));
    if (match) {
      await pageWait(1000);
      return match;
    }
    await pageWait(250);
  }
  return null;
}

function pageWait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPatchResponseAfter(startIndex, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = apiResponses.slice(startIndex).find(item => item.url.includes('/api/figure/patch'));
    if (response) return response;
    await pageWait(250);
  }
  return null;
}

function patchesFromRequest(request) {
  const body = parseJson(request?.postData, {});
  return Array.isArray(body?.patches) ? body.patches : [];
}

async function applyCurrentDraft(page) {
  const startRequests = apiRequests.length;
  const startResponses = apiResponses.length;
  const clicked = await clickVisibleText(page, '应用当前图', 5000);
  assert.ok(clicked, 'could not click 应用当前图');
  const response = await waitForPatchResponseAfter(startResponses);
  assert.ok(response?.ok, `draft patch did not return success: ${JSON.stringify(response)}`);
  await waitForPreviewReady(page);
  const request = apiRequests.slice(startRequests).find(item => item.url.includes('/api/figure/patch'));
  assert.ok(request, 'applying draft did not send /api/figure/patch');
  return request;
}

async function fillTextAndApplyImmediately(page, gid, value) {
  const input = page.locator(`[data-param-gid="${gid}"][data-param-prop="text"]`).first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  const startRequests = apiRequests.length;
  const startResponses = apiResponses.length;
  await input.fill(value);
  await page.locator('button', { hasText: '立即应用' }).first().click();
  const response = await waitForPatchResponseAfter(startResponses);
  assert.ok(response?.ok, `immediate text patch failed: ${JSON.stringify(response)}`);
  await waitForPreviewReady(page);
  const request = apiRequests.slice(startRequests).find(item => item.url.includes('/api/figure/patch'));
  assert.ok(request, `immediate text edit for ${gid} did not send patch`);
  return request;
}

async function selectRadarComponentObject(page, groupId, gid) {
  await clickTab(page, '组件中心');
  const group = page.locator(`[data-component-group-id="${groupId}"]`).first();
  await group.waitFor({ state: 'visible', timeout: 10000 });
  const target = group.locator(`button[data-component-object-id="${gid}"]`).first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.click();
  await page.waitForFunction((targetGid) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids)
      && state.selectedGids.length === 1
      && state.selectedGids[0] === targetGid;
  }, gid);
  return group;
}

async function stageRadarComponentColor(page, groupId, gid, value) {
  const group = await selectRadarComponentObject(page, groupId, gid);
  const input = group.locator(
    `input[data-color-role="text"][data-color-scope^="component:${groupId}:"][data-color-scope$=":color"]`,
  ).first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(value);
  await input.press('Enter').catch(() => {});
  await input.evaluate(node => node.blur());
  await page.waitForTimeout(350);
}

function normalizedColor(value) {
  return String(value || '').toLowerCase();
}

async function latestState(page) {
  return page.evaluate(() => JSON.parse(window.sessionStorage.getItem('scifigure:app-state:v2') || '{}'));
}

function findStateObject(state, gid) {
  return state.projectFigures?.fig_1?.manifest?.objects?.find(object => object.id === gid);
}

function stateEditLogHas(state, gid, prop, valuePredicate = () => true) {
  const editLog = state.projectFigures?.fig_1?.editLog || [];
  return Array.isArray(editLog) && editLog.some(entry => (
    entry?.gid === gid
    && entry?.prop === prop
    && valuePredicate(entry?.value)
  ));
}

async function main() {
  assertIsolatedEnvironment();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'radar chart editing');
  let projectId = null;
  const projectIds = [];

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1540, height: 1000 } });
    await installBrowserAuthentication(context, authToken);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    page.on('console', (message) => {
      if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => {
      if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
    });
    page.on('request', (request) => {
      if (request.url().includes('/api/figure') || request.url().includes('/api/projects')) {
        apiRequests.push({ url: request.url(), method: request.method(), postData: request.postData() });
      }
    });
    page.on('response', async (response) => {
      if (response.url().includes('/api/figure') || response.url().includes('/api/projects')) {
        const body = await response.json().catch(() => null);
        apiResponses.push({ url: response.url(), status: response.status(), ok: response.ok(), body });
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const created = await createRadarProject();
    projectId = created.projectId;
    projectIds.push(projectId);
    const targets = findRadarTargets(created.figure.manifest);
    diagnostics.pythonTargets = Object.fromEntries(Object.entries(targets).map(([key, value]) => [key, value.id]));
    await installProjectState(page, projectId, created.figure);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'initial.png'), fullPage: true });

    await clickGid(page, targets.dimensionLabel.id);
    await clickTab(page, '属性编辑');
    await page.locator('[data-radar-label-offset-panel="true"]').waitFor({ state: 'visible', timeout: 10000 });
    record('PY1-radar-label-panel', 'PASS', `selected ${targets.dimensionLabel.id} and saw radar label offset panel`);

    await ensureDragMode(page, true);
    const radarDragStart = apiRequests.length;
    const radarDragResponseStart = apiResponses.length;
    const radarLabelBeforeDrag = await dragGid(page, targets.dimensionLabel.id, 44, -18);
    await page.getByRole('button', { name: /确认位置/ }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: /确认位置/ }).click();
    const radarPatch = await waitForPatchAfter(radarDragStart, body => (
      Array.isArray(body?.patches)
      && body.patches.some(patch => patch.gid === targets.dimensionLabel.id && patch.prop === 'radar_label_offset')
    ));
    assert.ok(radarPatch, 'radar dimension label drag did not send radar_label_offset patch');
    const radarPatches = patchesFromRequest(radarPatch);
    assert.ok(radarPatches.some(patch => patch.gid === targets.dimensionLabel.id && patch.prop === 'radar_label_offset'), JSON.stringify(radarPatches));
    assert.ok(!radarPatches.some(patch => patch.gid === targets.dimensionLabel.id && patch.prop === 'position'), JSON.stringify(radarPatches));
    const radarDragResponse = await waitForPatchResponseAfter(radarDragResponseStart);
    assert.ok(radarDragResponse?.ok, `radar dimension drag patch failed: ${JSON.stringify(radarDragResponse)}`);
    await waitForPreviewReady(page);
    const radarLabelAfterConfirm = await svgBoxForGid(page, targets.dimensionLabel.id);
    assert.ok(radarLabelAfterConfirm, `backend preview lost ${targets.dimensionLabel.id}`);
    assert.ok(
      radarLabelAfterConfirm.x - radarLabelBeforeDrag.x > 5,
      `backend preview did not replay horizontal radar label drag: ${JSON.stringify({ radarLabelBeforeDrag, radarLabelAfterConfirm })}`,
    );
    assert.ok(
      radarLabelAfterConfirm.y - radarLabelBeforeDrag.y < -2,
      `backend preview did not replay vertical radar label drag: ${JSON.stringify({ radarLabelBeforeDrag, radarLabelAfterConfirm })}`,
    );
    diagnostics.radarLabelGeometry = { before: radarLabelBeforeDrag, afterConfirm: radarLabelAfterConfirm };
    record('PY2-radar-label-drag-prop', 'PASS', `drag patch prop=${radarPatches.map(patch => patch.prop).join(',')} and backend SVG geometry moved`);

    await clickGid(page, targets.dimensionLabel.id);
    await clickTab(page, '属性编辑');
    const dimensionTextRequest = await fillTextAndApplyImmediately(page, targets.dimensionLabel.id, 'Quality edited');
    assert.deepEqual(
      patchesFromRequest(dimensionTextRequest).map(patch => [patch.gid, patch.prop, patch.value]),
      [[targets.dimensionLabel.id, 'text', 'Quality edited']],
    );
    await page.waitForFunction((targetGid) => {
      const escaped = CSS.escape(targetGid);
      const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
      return String(node?.textContent || '').includes('Quality edited');
    }, targets.dimensionLabel.id);
    record('PY3-radar-label-text', 'PASS', `edited ${targets.dimensionLabel.id} text`);

    await selectLayerNode(page, targets.legendText.id);
    await clickTab(page, '属性编辑');
    const legendTextRequest = await fillTextAndApplyImmediately(page, targets.legendText.id, 'Model A edited');
    assert.deepEqual(
      patchesFromRequest(legendTextRequest).map(patch => [patch.gid, patch.prop, patch.value]),
      [[targets.legendText.id, 'text', 'Model A edited']],
    );
    record('PY4-legend-text-edit', 'PASS', `edited ${targets.legendText.id} text`);

    await ensureDragMode(page, true);
    const legendDragStart = apiRequests.length;
    const legendDragResponseStart = apiResponses.length;
    await dragGid(page, targets.legendText.id, -34, 28);
    await page.getByRole('button', { name: /确认位置/ }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: /确认位置/ }).click();
    const legendPatch = await waitForPatchAfter(legendDragStart, body => (
      Array.isArray(body?.patches)
      && body.patches.some(patch => patch.gid === targets.legend.id && patch.prop === 'position')
    ));
    assert.ok(legendPatch, 'legend text drag did not write legend.0 position');
    const legendPatches = patchesFromRequest(legendPatch);
    assert.ok(legendPatches.some(patch => patch.gid === targets.legend.id && patch.prop === 'position'), JSON.stringify(legendPatches));
    assert.ok(!legendPatches.some(patch => patch.gid === targets.legendText.id && patch.prop === 'position'), JSON.stringify(legendPatches));
    const legendDragResponse = await waitForPatchResponseAfter(legendDragResponseStart);
    assert.ok(legendDragResponse?.ok, `legend drag patch failed: ${JSON.stringify(legendDragResponse)}`);
    assert.equal(legendDragResponse?.body?.status, 'success', `legend drag patch was not applied: ${JSON.stringify(legendDragResponse)}`);
    assert.ok(
      Array.isArray(legendDragResponse?.body?.applied)
        && legendDragResponse.body.applied.some(patch => patch.gid === targets.legend.id && patch.prop === 'position'),
      `legend drag response omitted applied position: ${JSON.stringify(legendDragResponse)}`,
    );
    await waitForPreviewReady(page);
    record('PY5-legend-text-drag-target', 'PASS', `drag from ${targets.legendText.id} wrote ${targets.legend.id} position`);

    await clickGid(page, targets.ordinaryText.id);
    await clickTab(page, '属性编辑');
    await page.locator(`[data-param-gid="${targets.ordinaryText.id}"][data-param-prop="bbox_visible"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-param-gid="${targets.ordinaryText.id}"][data-param-prop="bbox_alpha"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-param-gid="${targets.ordinaryText.id}"][data-param-prop="bbox_linewidth"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-param-gid="${targets.ordinaryText.id}"][data-param-prop="bbox_pad"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-param-gid="${targets.ordinaryText.id}"][data-param-prop="bbox_boxstyle"]`).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator(`[data-color-role="text"][data-color-scope="${targets.ordinaryText.id}:bbox_facecolor"]`).waitFor({ state: 'visible', timeout: 10000 });
    const colorInput = page.locator(`[data-color-role="text"][data-color-scope="${targets.ordinaryText.id}:bbox_facecolor"]`).first();
    await colorInput.fill('#DDEEFF');
    await colorInput.press('Enter');
    const bboxRequest = await applyCurrentDraft(page);
    assert.ok(
      patchesFromRequest(bboxRequest).some(patch => patch.gid === targets.ordinaryText.id && patch.prop === 'bbox_facecolor' && String(patch.value).toLowerCase() === '#ddeeff'),
      JSON.stringify(patchesFromRequest(bboxRequest)),
    );
    record('PY6-text-bbox-controls', 'PASS', `exposed bbox visibility/style/alpha/linewidth/pad and edited ${targets.ordinaryText.id} bbox_facecolor`);

    await clickTab(page, '组件中心');
    const componentPanelText = await page.locator('.scifig-editor-panel-right').innerText();
    assert.ok(componentPanelText.includes('雷达图数据线'), `component center missing radarLines/雷达图数据线 group: ${componentPanelText}`);
    assert.ok(componentPanelText.includes('雷达图填充区域'), `component center missing radarFills/雷达图填充区域 group: ${componentPanelText}`);
    record('PY7-component-center-radar-groups', 'PASS', `component center exposes ${targets.radarLine.id} and ${targets.radarFill.id} groups`);

    const radarLabelBeforeRefresh = await svgLocalGeometryForGid(page, targets.dimensionLabel.id);
    assert.ok(radarLabelBeforeRefresh, `preview lost ${targets.dimensionLabel.id} before refresh`);
    assert.ok(radarLabelBeforeRefresh.text.includes('Quality edited'), JSON.stringify(radarLabelBeforeRefresh));

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForPreviewReady(page);
    const state = await latestState(page);
    const reloadedDimension = findStateObject(state, targets.dimensionLabel.id);
    const reloadedLegend = findStateObject(state, targets.legend.id);
    const reloadedLegendText = findStateObject(state, targets.legendText.id);
    const reloadedOrdinaryText = findStateObject(state, targets.ordinaryText.id);
    assert.equal(reloadedDimension?.currentProps?.text, 'Quality edited');
    assert.ok(reloadedDimension?.currentProps?.radar_label_offset, 'refreshed state lost radar_label_offset');
    assert.ok(
      reloadedLegend?.currentProps?.position || stateEditLogHas(state, targets.legend.id, 'position'),
      `refreshed state lost legend position edit: ${JSON.stringify({ currentProps: reloadedLegend?.currentProps, editLog: state.projectFigures?.fig_1?.editLog })}`,
    );
    assert.equal(reloadedLegendText?.currentProps?.text, 'Model A edited');
    assert.equal(String(reloadedOrdinaryText?.currentProps?.bbox_facecolor).toLowerCase(), '#ddeeff');
    assert.ok(stateEditLogHas(state, targets.dimensionLabel.id, 'radar_label_offset'), 'refreshed state editLog lost radar_label_offset');
    assert.ok(!stateEditLogHas(state, targets.dimensionLabel.id, 'position'), 'refreshed state incorrectly contains dimension label position edit');
    const radarLabelAfterRefresh = await svgLocalGeometryForGid(page, targets.dimensionLabel.id);
    assert.ok(radarLabelAfterRefresh, `refreshed preview lost ${targets.dimensionLabel.id}`);
    assert.ok(
      Math.abs(radarLabelAfterRefresh.x - radarLabelBeforeRefresh.x) < 1
        && Math.abs(radarLabelAfterRefresh.y - radarLabelBeforeRefresh.y) < 1,
      `refresh changed replayed radar label geometry: ${JSON.stringify({ radarLabelBeforeRefresh, radarLabelAfterRefresh })}`,
    );
    diagnostics.radarLabelGeometry.afterRefresh = radarLabelAfterRefresh;
    record('PY8-refresh-state', 'PASS', 'refresh retained radar label SVG geometry, legend, legend text, and bbox edits');

    await page.screenshot({ path: path.join(OUTPUT_DIR, 'python-final.png'), fullPage: true });

    const rCreated = await createRRadarProject();
    projectId = rCreated.projectId;
    projectIds.push(projectId);
    const rTargets = findRRadarTargets(rCreated.figure.manifest);
    diagnostics.rTargets = Object.fromEntries(Object.entries(rTargets).map(([key, value]) => [key, value.id]));
    diagnostics.rBaselineColors = {
      controlLine: rTargets.controlLine.currentProps.color,
      treatmentLine: rTargets.treatmentLine.currentProps.color,
      controlFill: rTargets.controlFill.currentProps.facecolor,
      treatmentFill: rTargets.treatmentFill.currentProps.facecolor,
    };
    await installRRadarProjectState(page, projectId, rCreated.figure);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'r-initial.png'), fullPage: true });

    await clickTab(page, '组件中心');
    const rLineGroup = page.locator('[data-component-group-id="radarLines"]').first();
    const rFillGroup = page.locator('[data-component-group-id="radarFills"]').first();
    await rLineGroup.waitFor({ state: 'visible', timeout: 10000 });
    await rFillGroup.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await rLineGroup.locator('button[data-component-object-id]').count(), 2, 'R radar line group must expose two series');
    assert.equal(await rFillGroup.locator('button[data-component-object-id]').count(), 2, 'R radar fill group must expose two series');
    assert.equal(await rLineGroup.locator(`button[data-component-object-id="${rTargets.controlLine.id}"]`).count(), 1);
    assert.equal(await rFillGroup.locator(`button[data-component-object-id="${rTargets.treatmentFill.id}"]`).count(), 1);
    record('R1-component-groups', 'PASS', 'R scale-backed line and fill series are independently listed in component center');

    const controlLineColor = '#1A73E8';
    await stageRadarComponentColor(page, 'radarLines', rTargets.controlLine.id, controlLineColor);
    const lineRequest = await applyCurrentDraft(page);
    assert.deepEqual(
      patchesFromRequest(lineRequest).map(patch => [patch.gid, patch.prop, normalizedColor(patch.value)]),
      [[rTargets.controlLine.id, 'color', normalizedColor(controlLineColor)]],
    );
    let rState = await latestState(page);
    assert.equal(normalizedColor(findStateObject(rState, rTargets.controlLine.id)?.currentProps?.color), normalizedColor(controlLineColor));
    assert.equal(
      normalizedColor(findStateObject(rState, rTargets.treatmentLine.id)?.currentProps?.color),
      normalizedColor(rTargets.treatmentLine.currentProps.color),
      'Control line edit leaked to Treatment line',
    );
    record('R2-single-line-color', 'PASS', `only ${rTargets.controlLine.id}.color was patched`);

    const treatmentFillColor = '#4DAF4A';
    await stageRadarComponentColor(page, 'radarFills', rTargets.treatmentFill.id, treatmentFillColor);
    const fillRequest = await applyCurrentDraft(page);
    assert.deepEqual(
      patchesFromRequest(fillRequest).map(patch => [patch.gid, patch.prop, normalizedColor(patch.value)]),
      [[rTargets.treatmentFill.id, 'facecolor', normalizedColor(treatmentFillColor)]],
    );
    rState = await latestState(page);
    assert.equal(normalizedColor(findStateObject(rState, rTargets.treatmentFill.id)?.currentProps?.facecolor), normalizedColor(treatmentFillColor));
    assert.equal(
      normalizedColor(findStateObject(rState, rTargets.controlFill.id)?.currentProps?.facecolor),
      normalizedColor(rTargets.controlFill.currentProps.facecolor),
      'Treatment fill edit leaked to Control fill',
    );
    record('R3-single-fill-color', 'PASS', `only ${rTargets.treatmentFill.id}.facecolor was patched`);

    await selectLayerNode(page, rTargets.legendText.id);
    await clickTab(page, '属性编辑');
    const rLegendRequest = await fillTextAndApplyImmediately(page, rTargets.legendText.id, 'Control edited');
    assert.deepEqual(
      patchesFromRequest(rLegendRequest).map(patch => [patch.gid, patch.prop, patch.value]),
      [[rTargets.legendText.id, 'text', 'Control edited']],
    );
    record('R4-legend-text', 'PASS', `edited only ${rTargets.legendText.id}`);

    await clickGid(page, rTargets.dimensionLabel.id);
    await clickTab(page, '属性编辑');
    await page.locator('[data-radar-label-offset-panel="true"]').waitFor({ state: 'visible', timeout: 10000 });
    await ensureDragMode(page, true);
    const rDragStart = apiRequests.length;
    const rDragResponseStart = apiResponses.length;
    const rLabelBeforeDrag = await dragGid(page, rTargets.dimensionLabel.id, 36, -16);
    await page.getByRole('button', { name: /确认位置/ }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: /确认位置/ }).click();
    const rDragRequest = await waitForPatchAfter(rDragStart, body => (
      Array.isArray(body?.patches)
      && body.patches.some(patch => patch.gid === rTargets.dimensionLabel.id && patch.prop === 'radar_label_offset')
    ));
    assert.ok(rDragRequest, 'R radar dimension drag did not send radar_label_offset');
    const rDragPatches = patchesFromRequest(rDragRequest);
    assert.ok(rDragPatches.some(patch => patch.gid === rTargets.dimensionLabel.id && patch.prop === 'radar_label_offset'));
    assert.ok(!rDragPatches.some(patch => patch.gid === rTargets.dimensionLabel.id && patch.prop === 'position'));
    const rDragResponse = await waitForPatchResponseAfter(rDragResponseStart);
    assert.ok(rDragResponse?.ok, `R radar dimension drag patch failed: ${JSON.stringify(rDragResponse)}`);
    await waitForPreviewReady(page);
    const rLabelAfterDrag = await svgBoxForGid(page, rTargets.dimensionLabel.id);
    assert.ok(rLabelAfterDrag, `R preview lost ${rTargets.dimensionLabel.id}`);
    assert.ok(rLabelAfterDrag.x - rLabelBeforeDrag.x > 4, 'R dimension label did not move horizontally after replay');
    assert.ok(rLabelAfterDrag.y - rLabelBeforeDrag.y < -2, 'R dimension label did not move vertically after replay');
    diagnostics.rRadarLabelGeometry = { before: rLabelBeforeDrag, afterConfirm: rLabelAfterDrag };
    record('R5-dimension-drag', 'PASS', 'R dimension drag used radar_label_offset and changed backend SVG geometry');

    await clickGid(page, rTargets.dimensionLabel.id);
    await clickTab(page, '属性编辑');
    const rDimensionTextRequest = await fillTextAndApplyImmediately(page, rTargets.dimensionLabel.id, 'Quality R edited');
    assert.deepEqual(
      patchesFromRequest(rDimensionTextRequest).map(patch => [patch.gid, patch.prop, patch.value]),
      [[rTargets.dimensionLabel.id, 'text', 'Quality R edited']],
    );
    record('R6-dimension-text', 'PASS', `edited only ${rTargets.dimensionLabel.id}`);

    const rLabelBeforeRefresh = await svgLocalGeometryForGid(page, rTargets.dimensionLabel.id);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForPreviewReady(page);
    rState = await latestState(page);
    assert.equal(normalizedColor(findStateObject(rState, rTargets.controlLine.id)?.currentProps?.color), normalizedColor(controlLineColor));
    assert.equal(normalizedColor(findStateObject(rState, rTargets.treatmentLine.id)?.currentProps?.color), normalizedColor(rTargets.treatmentLine.currentProps.color));
    assert.equal(normalizedColor(findStateObject(rState, rTargets.treatmentFill.id)?.currentProps?.facecolor), normalizedColor(treatmentFillColor));
    assert.equal(normalizedColor(findStateObject(rState, rTargets.controlFill.id)?.currentProps?.facecolor), normalizedColor(rTargets.controlFill.currentProps.facecolor));
    assert.equal(findStateObject(rState, rTargets.legendText.id)?.currentProps?.text, 'Control edited');
    assert.equal(findStateObject(rState, rTargets.dimensionLabel.id)?.currentProps?.text, 'Quality R edited');
    assert.ok(stateEditLogHas(rState, rTargets.dimensionLabel.id, 'radar_label_offset'));
    assert.ok(!stateEditLogHas(rState, rTargets.dimensionLabel.id, 'position'));
    const rLabelAfterRefresh = await svgLocalGeometryForGid(page, rTargets.dimensionLabel.id);
    assert.ok(rLabelBeforeRefresh && rLabelAfterRefresh, 'R dimension label geometry missing across refresh');
    assert.ok(
      Math.abs(rLabelAfterRefresh.x - rLabelBeforeRefresh.x) < 1
        && Math.abs(rLabelAfterRefresh.y - rLabelBeforeRefresh.y) < 1,
      `R refresh changed dimension label geometry: ${JSON.stringify({ rLabelBeforeRefresh, rLabelAfterRefresh })}`,
    );
    diagnostics.rRadarLabelGeometry.afterRefresh = rLabelAfterRefresh;
    record('R7-refresh-isolation', 'PASS', 'R edits survived refresh while unselected line and fill retained baseline colors');

    assert.equal(pageErrors.length, 0, `page errors: ${JSON.stringify(pageErrors)}`);
    assert.equal(consoleErrors.length, 0, `console errors: ${JSON.stringify(consoleErrors)}`);
    record('N1-browser-errors', 'PASS', 'no unexpected console/page errors');

    await page.screenshot({ path: path.join(OUTPUT_DIR, 'r-final.png'), fullPage: true });
  } finally {
    await browser.close();
    for (const temporaryProjectId of projectIds.reverse()) {
      await requestJson(`/api/projects/${temporaryProjectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }

  const failed = results.filter(result => result.status !== 'PASS');
  const report = [
    '# Radar Chart Editing Smoke Report',
    '',
    `Run: ${RUN_ID}`,
    `Conclusion: ${failed.length === 0 ? 'PASS' : 'FAIL'}`,
    '',
    '| ID | Status | Note |',
    '|---|---|---|',
    ...results.map(result => `| ${result.id} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify({ ...diagnostics, apiRequests, apiResponses, consoleErrors, pageErrors }, null, 2),
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report, 'utf8');
  console.log(`Report: ${path.join(OUTPUT_DIR, 'report.md')}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
