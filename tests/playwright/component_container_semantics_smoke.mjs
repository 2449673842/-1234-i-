import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || '';
if (!BASE_URL) {
  throw new Error('SCIFIGURE_URL is required; run through npm run test:component-container-smoke');
}
if (new URL(BASE_URL).port === '3000') {
  throw new Error('component container smoke must use the isolated random-port harness, not port 3000');
}
const results = [];
const apiRequests = [];
const apiResponses = [];
const pendingApiResponseCaptures = [];
const consoleErrors = [];
const pageErrors = [];
let authToken = '';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const CONTROL_MODE = process.env.VITE_SCIFIGURE_COMPONENT_CONTROLS_V2 === '0' ? 'rollback' : 'default';
const OUTPUT_DIR = path.resolve('output', 'playwright', `component-container-${CONTROL_MODE}-${RUN_ID}`);

const script = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'from matplotlib.patches import StepPatch',
  'from matplotlib.colors import Normalize',
  'fig, axes = plt.subplots(3, 2, figsize=(7, 8.5))',
  'ax0, ax1, ax2, ax3, ax4, ax5 = axes.ravel()',
  'ax0.bar(["A", "B", "C"], [2, 3, 1], color="#88aadd", edgecolor="#222222", label="Bars")',
  'ax0.legend(title="Groups")',
  'ax0_twin = ax0.twinx()',
  'ax0_twin.plot([0, 1, 2], [10, 14, 12], color="#cc6677", label="Twin")',
  'ax0_twin.set_ylabel("Twin scale")',
  'ax0.set_title("Bar")',
  'ax1.errorbar([0, 1, 2], [2.2, 3.1, 1.4], yerr=[0.2, 0.3, 0.1], color="#333333", capsize=4, label="Error")',
  'ax1.fill_between([0, 1, 2], [1.8, 2.7, 1.1], [2.6, 3.5, 1.7], color="#4477aa", alpha=0.35, label="Confidence band")',
  'ax1.set_title("Errorbar")',
  'grid_x = np.linspace(-2, 2, 18)',
  'grid_y = np.linspace(-2, 2, 18)',
  'X, Y = np.meshgrid(grid_x, grid_y)',
  'Z = np.sin(X) + np.cos(Y)',
  'shared_scale = plt.cm.ScalarMappable(norm=Normalize(0, 1), cmap="viridis")',
  'shared_scale.set_array([])',
  'fig.colorbar(shared_scale, ax=[ax0, ax1], label="Shared scale")',
  'rng = np.random.default_rng(42)',
  'ax2.boxplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], patch_artist=True)',
  'ax2.scatter([0, 1, 2], [0.8, 1.5, 1.1], s=45, color="#dd8844", label="Points")',
  'ax2.contourf(X, Y, Z, levels=4, cmap="viridis", alpha=0.65)',
  'ax2.set_title("Boxplot")',
  'ax3.violinplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], showmeans=True)',
  'ax3.stem([1, 2], [1.4, 1.9], label="Stem signal")',
  'ax3.contour(X, Y, Z, levels=[-1, 0, 1], cmap="magma", linewidths=1.1)',
  'ax3.annotate("Arrow note", xy=(1, 0), xytext=(1.55, 1.6), arrowprops=dict(arrowstyle="->"))',
  'ax3.set_title("Violin Stem")',
  'ax4.hist([0, 1, 1, 2, 2, 2], bins=[0, 1, 2, 3], color="#44aa88", edgecolor="#113322", alpha=0.55, label="Dedicated hist")',
  'ax4.set_title("Histogram")',
  'ax5.stairs([1, 2, 1], [0, 1, 2, 3], color="#cc6677", linewidth=1.3, label="Dedicated stairs")',
  'ax5.step([0, 1, 2], [2, 1, 3], where="mid", color="#228833", linewidth=1.4, label="Dedicated step")',
  'ax5.add_patch(StepPatch([1, 1.5, 1], [3.4, 4.2, 5.0, 5.8], label="Manual StepPatch"))',
  'ax5.plot([0, 1, 2], [3, 3.5, 3.2], drawstyle="steps-mid", color="#222222", label="Plain drawstyle line")',
  'ax5.set_title("Stairs Step")',
  'fig.tight_layout()',
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

function capabilityProps(object) {
  return (object?.propertyCapabilities || []).map(capability => capability.prop);
}

function supportsProps(object, props) {
  const editable = new Set([...(object?.editable || []), ...capabilityProps(object)]);
  return props.every(prop => editable.has(prop));
}

function excludesProps(object, props) {
  const editable = new Set([...(object?.editable || []), ...capabilityProps(object)]);
  return props.every(prop => !editable.has(prop));
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/[^']+:24678\//.test(message)
    || message.includes('WebSocket closed without opened');
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
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  await Promise.all((data.projects || [])
    .filter((project) => String(project?.name || '').startsWith('Component container smoke'))
    .map((project) => requestJson(`/api/projects/${project.id || project.projectId}`, { method: 'DELETE' }).catch(() => null)));
}

async function createFixture() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 150, height: 120, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Component container smoke ${Date.now()}`, spec }),
  });
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `component-container-${Date.now()}`,
    }),
  });
  if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');
  return { projectId: created.id, spec, rendered };
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ projectId, spec, rendered }) => {
    const projectFigures = {};
    rendered.figures.forEach((figure, index) => {
      projectFigures[figure.figureId] = {
        figureId: figure.figureId,
        index,
        manifest: figure.manifest,
        editLog: figure.editLog || [],
        revision: figure.revision || 1,
        svg: figure.svg,
        fingerprint: figure.fingerprint,
        codeSlice: figure.codeSlice || null,
        renderStatus: 'success',
      };
    });
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'Component container smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Component container fixture ready'],
      figSession: null,
    }));
  }, fixture);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForPreviewReady(page, 20000);
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('正在重新渲染当前图形') || body.includes('正在恢复项目预览');
    if (!rendering && await page.locator('svg').count().catch(() => 0) > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(700);
  }
  return false;
}

async function clickText(page, text) {
  const button = page.getByRole('button', { name: new RegExp(text) }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(500);
  return true;
}

async function controlInExactCard(page, cardText, selector, attribute, expected, endsWith = false) {
  return page.evaluateHandle(({ cardText, selector, attribute, expected, endsWith }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const rendered = (node) => {
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const semanticCard = Array.from(document.querySelectorAll('[data-component-group-label]'))
      .find((node) => node.getAttribute('data-component-group-label') === cardText);
    const findControl = (root) => Array.from(root.querySelectorAll(selector))
      .find((node) => {
        if (!rendered(node) || node.disabled) return false;
        const actual = String(node.getAttribute(attribute) || '');
        return endsWith ? actual.endsWith(expected) : actual === expected;
      });
    if (semanticCard) return findControl(semanticCard) || null;
    const heading = semanticCard || Array.from(document.querySelectorAll('span, div, p, h4'))
      .find((node) => rendered(node) && rightSide(node) && normalize(node.textContent) === normalize(cardText));
    if (!heading) return null;
    let current = heading.parentElement;
    while (current && rightSide(current)) {
      const control = findControl(current);
      if (control) return control;
      current = current.parentElement;
    }
    return null;
  }, { cardText, selector, attribute, expected, endsWith });
}

async function setNumberInCard(page, cardText, prop, value) {
  const handle = await controlInExactCard(
    page,
    cardText,
    'input[data-param-role="number"]',
    'data-param-prop',
    prop,
  );
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(600);
  return true;
}

async function setColorInCard(page, cardText, scopeSuffix, value) {
  const handle = await controlInExactCard(
    page,
    cardText,
    'input[data-color-role="text"]',
    'data-color-scope',
    scopeSuffix,
    true,
  );
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(value);
  await page.waitForTimeout(600);
  return true;
}

async function setBooleanInCard(page, cardText, prop, value) {
  const handle = await controlInExactCard(
    page,
    cardText,
    'input[data-param-role="boolean"]',
    'data-param-prop',
    prop,
  );
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  const current = await element.evaluate(node => Boolean(node.checked));
  if (current !== value) await element.click({ force: true });
  await page.waitForTimeout(600);
  const refreshed = page.locator(
    `[data-component-group-label="${cardText}"] input[data-param-role="boolean"][data-param-prop="${prop}"]`,
  ).first();
  return await refreshed.isChecked().catch(() => false) === value;
}

async function setSelectInCard(page, cardText, prop, value) {
  const handle = await controlInExactCard(
    page,
    cardText,
    'select[data-param-role="select"]',
    'data-param-prop',
    prop,
  );
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.selectOption(value);
  await page.waitForTimeout(600);
  return true;
}

async function inputValueInCard(page, cardText, selector, attribute, expected, endsWith = false) {
  const handle = await controlInExactCard(page, cardText, selector, attribute, expected, endsWith);
  const element = handle.asElement();
  if (!element) return null;
  return element.evaluate(node => node.value);
}

async function svgTargetUsesColor(page, gid, prop, expectedColor, fallbackGids = []) {
  try {
    await page.waitForFunction(({ targetGid, targetProp, color, childGids }) => {
      const targetIds = [targetGid, ...childGids].filter(Boolean);
      const targets = targetIds
        .map(targetId => document.querySelector(`svg #${CSS.escape(targetId)}`))
        .filter(Boolean);
      if (targets.length === 0) return false;
      const attribute = targetProp === 'edgecolor' ? 'stroke' : 'fill';
      const colorContext = document.createElement('canvas').getContext('2d');
      const normalizeColor = (value) => {
        if (!colorContext || !value) return String(value || '').toLowerCase();
        colorContext.fillStyle = '#010203';
        colorContext.fillStyle = String(value);
        return String(colorContext.fillStyle).toLowerCase();
      };
      const expected = normalizeColor(color);
      const candidates = targets.flatMap(target => [target, ...target.querySelectorAll('*')]);
      return candidates.some(node => {
        const values = [
          node.getAttribute(attribute),
          node.style?.getPropertyValue?.(attribute),
        ].filter(Boolean).map(normalizeColor);
        return values.some(value => value === expected);
      });
    }, {
      targetGid: gid,
      targetProp: prop,
      color: expectedColor,
      childGids: fallbackGids,
    }, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function svgColorDiagnostics(page, gid, prop, expectedColor, fallbackGids = []) {
  return page.evaluate(({ targetGid, targetProp, color, childGids }) => {
    const targetIds = [targetGid, ...childGids].filter(Boolean);
    const expected = String(color).toLowerCase();
    const attribute = targetProp === 'edgecolor' ? 'stroke' : 'fill';
    const rawState = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = rawState ? JSON.parse(rawState) : {};
    const storedFigure = state.projectFigures?.fig_1 || {};
    const storedParent = storedFigure.manifest?.objects?.find(object => object.id === targetGid);
    const previewContainer = document.querySelector('[data-svg-bytes]');
    const domSvgs = Array.from(document.querySelectorAll('svg'));
    return {
      targetIds,
      targetNodes: targetIds.map(targetId => {
        const target = document.querySelector(`svg #${CSS.escape(targetId)}`);
        if (!target) return { id: targetId, found: false };
        const candidates = [target, ...target.querySelectorAll('*')];
        return {
          id: targetId,
          found: true,
          values: candidates.flatMap(node => [
            node.getAttribute(attribute),
            node.style?.getPropertyValue?.(attribute),
          ]).filter(Boolean),
        };
      }),
      domSvgHasColor: domSvgs.some(svg => svg.outerHTML.toLowerCase().includes(expected)),
      storedSvgHasColor: String(storedFigure.svg || '').toLowerCase().includes(expected),
      storedRevision: storedFigure.revision,
      storedParentChildren: storedParent?.children || [],
      previewBytes: previewContainer?.getAttribute('data-svg-bytes') || null,
      sanitizeCount: previewContainer?.getAttribute('data-svg-sanitize-count') || null,
      sanitizeCacheHit: previewContainer?.getAttribute('data-svg-sanitize-cache-hit') || null,
    };
  }, {
    targetGid: gid,
    targetProp: prop,
    color: expectedColor,
    childGids: fallbackGids,
  });
}

async function waitForApiSettle(startIndex, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const patchRequests = apiRequests.slice(startIndex).filter(request => request.url.includes('/api/figure/patch'));
    const patchResponses = apiResponses.slice(startIndex).filter(response => response.url.includes('/api/figure/patch'));
    if (patchRequests.length > 0 && patchResponses.length >= patchRequests.length) return;
  }
}

async function applyAndRead(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { successful: false, patches: [] };
  await waitForApiSettle(start);
  await page.waitForTimeout(500);
  const request = apiRequests.slice(start).find(item => item.url.includes('/api/figure/patch'));
  const response = apiResponses.slice(start).find(item => item.url.includes('/api/figure/patch'));
  if (response?.bodyPromise) await response.bodyPromise;
  const responseOk = Boolean(
    response
    && response.status >= 200
    && response.status < 300
    && response.body?.status === 'success',
  );
  const body = request?.postData ? JSON.parse(request.postData) : null;
  const draftKeys = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Object.keys(state.projectDrafts?.fig_1 || {});
  });
  return {
    successful: responseOk,
    patches: body?.patches || [],
    requestCount: apiRequests.slice(start).length,
    responseCount: apiResponses.slice(start).length,
    responseBody: response?.body || null,
    draftKeys,
  };
}

function patchResponseSummary(body) {
  if (!body || typeof body !== 'object') return body;
  return {
    status: body.status,
    code: body.code,
    revision: body.revision,
    rejected: Array.isArray(body.rejected) ? body.rejected.map(item => `${item.gid || item.target_id}:${item.prop || ''}`) : [],
    warnings: Array.isArray(body.warnings) ? body.warnings.map(item => ({
      type: item.type,
      reason: item.reason,
      gid: item.gid,
      prop: item.prop,
      patchIndex: item.patchIndex,
    })) : [],
  };
}

async function saveProject(page) {
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
  if (!(await saveButton.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
    && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
  ), { timeout: 40000 }).catch(() => null);
  await saveButton.click();
  const response = await responsePromise;
  const settleDeadline = Date.now() + 10000;
  while (Date.now() < settleDeadline && !(await saveButton.isEnabled().catch(() => false))) {
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(100);
  return Boolean(response && response.status() >= 200 && response.status() < 300);
}

async function selectedGids(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) ? state.selectedGids : [];
  });
}

async function clickSvgObject(page, gid, options = {}) {
  const target = page.locator(`svg [id="${gid}"], svg [data-fig-id="${gid}"]`).first();
  if (await target.count() === 0) return false;
  const leaf = target.locator('path, rect, use, polygon, polyline').first();
  const clickable = await leaf.count() > 0 ? leaf : target;
  const box = await clickable.boundingBox();
  const event = {
    button: 0,
    ctrlKey: options.ctrlKey === true,
    clientX: box ? box.x + box.width / 2 : 1,
    clientY: box ? box.y + box.height / 2 : 1,
  };
  await clickable.dispatchEvent('click', event);
  await page.waitForTimeout(300);
  return true;
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'component containers');
  await cleanupSmokeProjects();
  const fixture = await createFixture();
  const manifest = fixture.rendered.figures[0].manifest;
  const containerKinds = ['bar_container', 'errorbar_container', 'stem_container', 'boxplot_container', 'violinplot_container'];
  const containers = manifest.objects.filter(object => containerKinds.includes(object.kind) && object.role !== 'histogram_series');
  const childIds = new Set(containers.flatMap(container => container.children || []));
  const spineGroups = manifest.objects.filter(object => object.kind === 'spine_group');
  const frameTargets = spineGroups.length > 0
    ? spineGroups
    : manifest.objects.filter(object => object.kind === 'spine');
  const objectById = new Map(manifest.objects.map(object => [object.id, object]));
  const annotationText = manifest.objects.find(object => object.role === 'annotation_text');
  const annotationArrow = manifest.objects.find(object => object.role === 'annotation_arrow');
  const sharedColorbar = manifest.objects.find(object => object.kind === 'colorbar');
  const sharedColorbarChildren = manifest.objects.filter(object => (
    object.identity?.relation?.colorbarId === sharedColorbar?.id
    && object.source?.axesIndex === sharedColorbar?.source?.axesIndex
  ));
  const legend = manifest.objects.find(object => object.kind === 'legend');
  const grid = manifest.objects.find(object => object.kind === 'grid');
  const fillBetweenBand = manifest.objects.find(object => object.kind === 'fill_between' && object.role === 'fill_between_series');
  const contourParents = manifest.objects.filter(object => object.kind === 'contour' || object.kind === 'contourf');
  const contourLine = contourParents.find(object => object.kind === 'contour');
  const contourFill = contourParents.find(object => object.kind === 'contourf');
  const contourChildIds = new Set(contourParents.flatMap(parent => parent.children || []));
  const histogramSeries = manifest.objects.find(object => object.role === 'histogram_series' && object.label === 'Dedicated hist');
  const histogramChildIds = new Set(histogramSeries?.children || []);
  const histogramChildren = Array.from(histogramChildIds).map(childId => objectById.get(childId)).filter(Boolean);
  const stairsSeries = manifest.objects.find(object => object.role === 'stairs_series' && object.label === 'Dedicated stairs');
  const stepSeries = manifest.objects.find(object => object.role === 'step_series' && object.label === 'Dedicated step');
  const plainBar = manifest.objects.find(object => object.kind === 'bar_container' && object.label === 'Bars');
  const manualStepPatch = manifest.objects.find(object => object.label === 'Manual StepPatch');
  const plainDrawstyleLine = manifest.objects.find(object => object.label === 'Plain drawstyle line');
  const legendText = manifest.objects.find(object => object.id.startsWith('legend_text.'));
  const legendMarker = manifest.objects.find(object => object.role === 'legend_marker');
  const twinSubplots = manifest.objects.filter(object => object.kind === 'subplot' && object.identity?.relation?.twinSubplotIds?.length > 0);
  record('C0-container-ownership', containers.length === 5 && childIds.size > 0 ? 'PASS' : 'FAIL', `containers=${containers.map(item => item.id).join(',')}, children=${childIds.size}`);
  record(
    'C0b-annotation-relationship',
    annotationText?.identity?.relation?.arrowId === annotationArrow?.id
      && annotationArrow?.identity?.relation?.textId === annotationText?.id ? 'PASS' : 'FAIL',
    `text=${annotationText?.id}, arrow=${annotationArrow?.id}`,
  );
  record(
    'C0c-shared-colorbar-relationship',
    JSON.stringify(sharedColorbar?.identity?.relation?.subplotIds) === JSON.stringify(['subplot.0', 'subplot.1'])
      && !sharedColorbar?.identity?.relation?.subplotId
      && sharedColorbarChildren.length > 0
      && sharedColorbarChildren.every(object => JSON.stringify(object.identity?.relation?.subplotIds) === JSON.stringify(['subplot.0', 'subplot.1'])) ? 'PASS' : 'FAIL',
    `colorbar=${sharedColorbar?.id}, subplotIds=${JSON.stringify(sharedColorbar?.identity?.relation?.subplotIds)}, children=${sharedColorbarChildren.length}`,
  );
  record(
    'C0d-legend-entry-relationship',
    legend?.identity?.relation?.legendTextIds?.includes(legendText?.id)
      && legend?.identity?.relation?.legendMarkerIds?.includes(legendMarker?.id)
      && legendText?.identity?.relation?.legendMarkerIds?.includes(legendMarker?.id)
      && legendMarker?.identity?.relation?.legendTextId === legendText?.id ? 'PASS' : 'FAIL',
    `legend=${legend?.id}, text=${legendText?.id}, marker=${legendMarker?.id}`,
  );
  record(
    'C0e-twin-axes-relationship',
    twinSubplots.length === 2
      && twinSubplots.every(subplot => subplot.identity.relation.twinSubplotIds.length === 1)
      && twinSubplots.every(subplot => twinSubplots.some(peer => subplot.identity.relation.twinSubplotIds.includes(peer.id))) ? 'PASS' : 'FAIL',
    `twins=${twinSubplots.map(subplot => `${subplot.id}->${subplot.identity.relation.twinSubplotIds.join(',')}`).join(';')}`,
  );
  record(
    'C0f-fill-between-dedicated',
    fillBetweenBand?.id?.startsWith('collection.1.')
      && fillBetweenBand?.stableKey?.startsWith('ax1.collection.') ? 'PASS' : 'FAIL',
    `id=${fillBetweenBand?.id}, kind=${fillBetweenBand?.kind}, role=${fillBetweenBand?.role}, stableKey=${fillBetweenBand?.stableKey}`,
  );
  record(
    'C0g-contour-dedicated-parents',
    contourLine?.role === 'contour_series'
      && contourFill?.role === 'contourf_series'
      && contourParents.every(parent => Array.isArray(parent.children) && parent.children.length > 0)
      && contourParents.every(parent => !parent.editable?.includes('levels'))
      && contourParents.every(parent => !parent.editable?.includes('paths'))
      && contourParents.every(parent => !parent.editable?.includes('segments'))
      && contourParents.every(parent => (parent.children || []).every(childId => {
        const child = manifest.objects.find(object => object.id === childId);
        return child?.parentId === parent.id && child?.role === 'contour_child_collection';
      })) ? 'PASS' : 'FAIL',
    `parents=${contourParents.map(parent => `${parent.id}:${parent.kind}:${parent.role}`).join(',')}, children=${contourChildIds.size}`,
  );
  const histogramStructuralProps = ['bins', 'counts', 'values', 'edges', 'density', 'cumulative', 'orientation', 'weights'];
  const stairsStructuralProps = ['values', 'edges', 'baseline'];
  const stepStructuralProps = ['x', 'y', 'xdata', 'ydata', 'where', 'drawstyle', 'interpolation'];
  record(
    'C0m-hist-stairs-step-dedicated',
    histogramSeries?.kind === 'bar_container'
      && histogramSeries?.source?.callName === 'Axes.hist'
      && histogramSeries?.semanticCoverage?.status === 'dedicated'
      && histogramSeries?.semanticCoverage?.family === 'hist'
      && stairsSeries?.kind === 'patch'
      && stairsSeries?.source?.callName === 'Axes.stairs'
      && stairsSeries?.semanticCoverage?.status === 'dedicated'
      && stairsSeries?.semanticCoverage?.family === 'stairs'
      && stepSeries?.kind === 'line'
      && stepSeries?.source?.callName === 'Axes.step'
      && stepSeries?.semanticCoverage?.status === 'dedicated'
      && stepSeries?.semanticCoverage?.family === 'step' ? 'PASS' : 'FAIL',
    `hist=${histogramSeries?.id}:${histogramSeries?.label}, stairs=${stairsSeries?.id}:${stairsSeries?.label}, step=${stepSeries?.id}:${stepSeries?.label}`,
  );
  record(
    'C0n-hist-parent-owned-children',
    histogramChildIds.size > 0
      && histogramChildren.every(child => child?.parentId === histogramSeries?.id)
      && histogramChildren.every(child => child?.role === 'histogram_child_patch')
      && histogramChildren.every(child => child?.currentProps?.parentOwned === true || ((child?.editable || []).length === 0 && (child?.propertyCapabilities || []).length === 0)) ? 'PASS' : 'FAIL',
    `parent=${histogramSeries?.id}, children=${histogramChildren.map(child => `${child.id}:${child.role}:${child.currentProps?.parentOwned}`).join(',')}`,
  );
  record(
    'C0o-structural-props-readonly',
    excludesProps(histogramSeries, histogramStructuralProps)
      && excludesProps(stairsSeries, stairsStructuralProps)
      && excludesProps(stepSeries, stepStructuralProps)
      && supportsProps(histogramSeries, ['facecolor', 'edgecolor', 'alpha', 'linewidth'])
      && supportsProps(stairsSeries, ['edgecolor', 'alpha', 'linewidth'])
      && supportsProps(stepSeries, ['color', 'linewidth', 'linestyle', 'alpha']) ? 'PASS' : 'FAIL',
    `histCaps=${JSON.stringify(capabilityProps(histogramSeries))}, stairsCaps=${JSON.stringify(capabilityProps(stairsSeries))}, stepCaps=${JSON.stringify(capabilityProps(stepSeries))}`,
  );
  record(
    'C0p-ordinary-step-hist-negative-roles',
    plainBar?.role !== 'histogram_series'
      && plainBar?.kind === 'bar_container'
      && manualStepPatch?.role !== 'stairs_series'
      && manualStepPatch?.role !== 'step_series'
      && plainDrawstyleLine?.role !== 'step_series'
      && plainDrawstyleLine?.kind === 'line' ? 'PASS' : 'FAIL',
    `plainBar=${plainBar?.kind}:${plainBar?.role}, manualStepPatch=${manualStepPatch?.kind}:${manualStepPatch?.role}, drawstyle=${plainDrawstyleLine?.kind}:${plainDrawstyleLine?.role}`,
  );

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/figure/patch') || /\/api\/projects\/[^/]+$/.test(new URL(request.url()).pathname)) {
      apiRequests.push({ url: request.url(), method: request.method(), postData: request.postData() });
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/figure/patch') || /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)) {
      const entry = {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        postData: response.request().postData(),
        body: null,
        bodyPromise: null,
      };
      apiResponses.push(entry);
      entry.bodyPromise = response.text().then(body => { entry.body = parseJson(body) || body; }).catch(() => null);
      pendingApiResponseCaptures.push(entry.bodyPromise);
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await installFixtureState(page, fixture);
    const componentTabClicked = await clickText(page, '组件中心');
    const initialComponentText = await getBodyText(page);
    const rightPanelLabels = await page.locator('.scifig-editor-panel-right [data-component-group-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-component-group-label')));
    const contourCardState = await page.locator('.scifig-editor-panel-right [data-component-group-id]').evaluateAll((nodes, ids) => {
      const contourChildIdSet = new Set(ids.contourChildIds);
      const histogramChildIdSet = new Set(ids.histogramChildIds);
      return nodes.map((node) => ({
        id: node.getAttribute('data-component-group-id'),
        label: node.getAttribute('data-component-group-label'),
        objectIds: Array.from(node.querySelectorAll('[data-component-object-id]')).map(child => child.getAttribute('data-component-object-id')),
        objectLabels: Array.from(node.querySelectorAll('[data-component-object-id]')).map(child => child.textContent || ''),
        props: Array.from(node.querySelectorAll('[data-param-prop], select[data-param-prop]')).map(child => child.getAttribute('data-param-prop')),
        colorScopes: Array.from(node.querySelectorAll('[data-color-scope]')).map(child => child.getAttribute('data-color-scope')),
        hasEditableColorControl: Array.from(node.querySelectorAll('input[type="color"], input[data-color-role="text"]'))
          .some(child => !child.disabled),
        hasContourChild: Array.from(node.querySelectorAll('[data-component-object-id]')).some(child => contourChildIdSet.has(child.getAttribute('data-component-object-id'))),
        hasHistogramChild: Array.from(node.querySelectorAll('[data-component-object-id]')).some(child => histogramChildIdSet.has(child.getAttribute('data-component-object-id'))),
      }));
    }, {
      contourChildIds: Array.from(contourChildIds),
      histogramChildIds: Array.from(histogramChildIds),
    });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'component-center.png'), fullPage: true });
    const initialStemControlCount = await page.locator('input[data-param-role="number"][data-param-prop="stem_linewidth"]').count();
    record(
      'C0g-stem-component-controls',
      initialComponentText.includes('茎叶图系列') && initialStemControlCount > 0 && initialComponentText.includes('双轴') ? 'PASS' : 'FAIL',
      `clicked=${componentTabClicked}, card=${initialComponentText.includes('茎叶图系列')}, controls=${initialStemControlCount}, labels=${JSON.stringify(rightPanelLabels.slice(0, 20))}`,
    );
    const componentControlsV2Expected = process.env.VITE_SCIFIGURE_COMPONENT_CONTROLS_V2 !== '0';
    const componentControlsV2Count = await page.locator('[data-component-controls-version="2"]').count();
    const barLinewidthControls = page.locator('[data-component-group-id="bars"] input[data-property-control="linewidth"][data-param-prop="linewidth"]');
    const barLinewidthCount = await barLinewidthControls.count();
    const barLinewidthContract = barLinewidthCount === 1
      ? await barLinewidthControls.first().evaluate(node => ({
          min: node.getAttribute('min'),
          max: node.getAttribute('max'),
          step: node.getAttribute('step'),
          state: node.closest('[data-property-state]')?.getAttribute('data-property-state') || null,
        }))
      : null;
    const componentControlsV2Ok = componentControlsV2Expected
      ? componentControlsV2Count > 0
        && barLinewidthCount === 1
        && barLinewidthContract?.min === '0'
        && barLinewidthContract?.max === '20'
        && barLinewidthContract?.step === '0.1'
        && barLinewidthContract?.state === 'editable'
      : componentControlsV2Count === 0;
    record(
      'C0g-component-descriptor-controls',
      componentControlsV2Ok ? 'PASS' : 'FAIL',
      `expected=${componentControlsV2Expected}, groups=${componentControlsV2Count}, barLinewidth=${barLinewidthCount}, contract=${JSON.stringify(barLinewidthContract)}`,
    );
    const contourCard = contourCardState.find(group => group.id === 'contours');
    const pointCard = contourCardState.find(group => group.id === 'points');
    const histogramCard = contourCardState.find(group => group.id === 'histograms');
    const stairsCard = contourCardState.find(group => group.id === 'stairs');
    const stepsCard = contourCardState.find(group => group.id === 'steps');
    const barCard = contourCardState.find(group => group.id === 'bars');
    const lineCard = contourCardState.find(group => group.id === 'lines');
    const patchCard = contourCardState.find(group => group.id === 'patches');
    const requiredContourProps = ['cmap', 'vmin', 'vmax', 'alpha', 'visible', 'zorder', 'linewidth', 'linestyle'];
    record(
      'C0h-contour-component-card',
      initialComponentText.includes('等高线/填充等高线')
        && contourCard?.objectIds?.includes(contourLine?.id)
        && contourCard?.objectIds?.includes(contourFill?.id)
        && requiredContourProps.every(prop => contourCard?.props?.includes(prop))
        && !contourCard?.hasContourChild
        && !pointCard?.hasContourChild ? 'PASS' : 'FAIL',
      `card=${JSON.stringify(contourCard)}, pointHasContourChild=${Boolean(pointCard?.hasContourChild)}`,
    );
    record(
      'C0q-semantic-component-cards',
      initialComponentText.includes('直方图系列')
        && initialComponentText.includes('阶梯填充系列')
        && initialComponentText.includes('阶梯线系列')
        && histogramCard?.objectIds?.includes(histogramSeries?.id)
        && histogramCard?.objectLabels?.some(label => label.includes('Dedicated hist'))
        && stairsCard?.objectIds?.includes(stairsSeries?.id)
        && stairsCard?.objectLabels?.some(label => label.includes('Dedicated stairs'))
        && stepsCard?.objectIds?.includes(stepSeries?.id)
        && stepsCard?.objectLabels?.some(label => label.includes('Dedicated step'))
        && !histogramCard?.objectIds?.includes(plainBar?.id)
        && !stairsCard?.objectIds?.includes(manualStepPatch?.id)
        && !stepsCard?.objectIds?.includes(plainDrawstyleLine?.id)
        && !barCard?.objectIds?.includes(histogramSeries?.id)
        && !lineCard?.objectIds?.includes(stepSeries?.id)
        && !patchCard?.objectIds?.includes(stairsSeries?.id)
        && patchCard?.objectIds?.includes(manualStepPatch?.id)
        && !histogramCard?.hasHistogramChild
        && !barCard?.hasHistogramChild
        && histogramStructuralProps.every(prop => !histogramCard?.props?.includes(prop))
        && stairsStructuralProps.every(prop => !stairsCard?.props?.includes(prop))
        && stepStructuralProps.every(prop => !stepsCard?.props?.includes(prop))
        && histogramStructuralProps.every(prop => !(histogramCard?.colorScopes || []).some(scope => String(scope || '').includes(`:${prop}`)))
        && stairsStructuralProps.every(prop => !(stairsCard?.colorScopes || []).some(scope => String(scope || '').includes(`:${prop}`)))
        && stepStructuralProps.every(prop => !(stepsCard?.colorScopes || []).some(scope => String(scope || '').includes(`:${prop}`)))
        && ['alpha', 'linewidth'].every(prop => histogramCard?.props?.includes(prop))
        && histogramCard?.hasEditableColorControl
        && (histogramCard?.colorScopes || []).some(scope => String(scope || '').endsWith(':edgecolor'))
        && ['alpha', 'linewidth'].every(prop => stairsCard?.props?.includes(prop))
        && stairsCard?.hasEditableColorControl
        && ['linewidth', 'linestyle'].every(prop => stepsCard?.props?.includes(prop))
        && stepsCard?.hasEditableColorControl ? 'PASS' : 'FAIL',
      `hist=${JSON.stringify(histogramCard)}, stairs=${JSON.stringify(stairsCard)}, steps=${JSON.stringify(stepsCard)}, bars=${JSON.stringify(barCard)}, lines=${JSON.stringify(lineCard)}, patches=${JSON.stringify(patchCard)}`,
    );
    let histogramChildHitRetargeted = false;
    const histogramChildSelectionId = histogramSeries?.children?.[0];
    if (histogramChildSelectionId && histogramSeries?.id) {
      const patchCountBefore = apiRequests.length;
      const clickedHistogramChild = await clickSvgObject(page, histogramChildSelectionId);
      const selected = await selectedGids(page);
      histogramChildHitRetargeted = clickedHistogramChild
        && selected.length === 1
        && selected[0] === histogramSeries.id
        && !selected.some(gid => histogramChildIds.has(gid))
        && apiRequests.length === patchCountBefore;
      const cancelSelectionButton = page.getByRole('button', { name: '取消选择', exact: true }).first();
      if (await cancelSelectionButton.isVisible().catch(() => false)) {
        await cancelSelectionButton.click();
        await page.waitForTimeout(200);
      }
      const selectedAfterCancel = await selectedGids(page);
      if (selectedAfterCancel.includes(histogramSeries.id)) {
        const selectedHistogramRow = page.locator(`[data-component-object-id="${histogramSeries.id}"]`).first();
        if (await selectedHistogramRow.count() > 0) {
          await selectedHistogramRow.click({ modifiers: ['Control'] });
          await page.waitForTimeout(200);
        }
      }
      if ((await selectedGids(page)).length > 0) {
        await clickSvgObject(page, histogramChildSelectionId, { ctrlKey: true });
        await page.waitForFunction(() => {
          const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
          const state = raw ? JSON.parse(raw) : {};
          return Array.isArray(state.selectedGids) && state.selectedGids.length === 0;
        }, null, { timeout: 3000 }).catch(() => null);
      }
    }
    record(
      'C0q2-histogram-child-hit-retarget',
      histogramChildHitRetargeted ? 'PASS' : 'FAIL',
      `child=${histogramChildSelectionId}, parent=${histogramSeries?.id}, retargeted=${histogramChildHitRetargeted}`,
    );
    const contourChildSelectionIds = [contourFill?.children?.[0], contourLine?.children?.[0]].filter(Boolean);
    let contourChildHitRetargeted = false;
    if (contourChildSelectionIds.length === 2 && contourFill?.id && contourLine?.id) {
      const firstChild = page.locator(`svg [id="${contourChildSelectionIds[0]}"], svg [data-fig-id="${contourChildSelectionIds[0]}"]`).first();
      const secondChild = page.locator(`svg [id="${contourChildSelectionIds[1]}"], svg [data-fig-id="${contourChildSelectionIds[1]}"]`).first();
      if (await firstChild.count() > 0 && await secondChild.count() > 0) {
        const patchCountBefore = apiRequests.length;
        await firstChild.dispatchEvent('click', { button: 0, ctrlKey: true });
        await page.waitForTimeout(300);
        await secondChild.dispatchEvent('click', { button: 0, ctrlKey: true });
        await page.waitForTimeout(250);
        const selectedGids = await page.evaluate(() => {
          const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
          const state = raw ? JSON.parse(raw) : {};
          return Array.isArray(state.selectedGids) ? state.selectedGids : [];
        });
        contourChildHitRetargeted = selectedGids.length === 2
          && selectedGids.includes(contourFill.id)
          && selectedGids.includes(contourLine.id)
          && selectedGids.every(gid => !contourChildIds.has(gid))
          && apiRequests.length === patchCountBefore;
      }
    }
    record(
      'C0h2-contour-child-hit-retarget',
      contourChildHitRetargeted ? 'PASS' : 'FAIL',
      `children=${contourChildSelectionIds.join(',')}, parents=${contourFill?.id},${contourLine?.id}, retargeted=${contourChildHitRetargeted}`,
    );
    let contourSelectionCleared = false;
    if (contourChildHitRetargeted && contourChildSelectionIds.length === 2) {
      const firstChild = page.locator(`svg [id="${contourChildSelectionIds[0]}"], svg [data-fig-id="${contourChildSelectionIds[0]}"]`).first();
      const secondChild = page.locator(`svg [id="${contourChildSelectionIds[1]}"], svg [data-fig-id="${contourChildSelectionIds[1]}"]`).first();
      await firstChild.dispatchEvent('click', { button: 0, ctrlKey: true });
      await page.waitForTimeout(250);
      await secondChild.dispatchEvent('click', { button: 0, ctrlKey: true });
      await page.waitForTimeout(250);
      contourSelectionCleared = await page.waitForFunction(() => {
        const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
        const state = raw ? JSON.parse(raw) : {};
        return Array.isArray(state.selectedGids) && state.selectedGids.length === 0;
      }, null, { timeout: 5000 }).then(() => true).catch(() => false);
    }
    let contourChildDragModeMultiSelect = false;
    let contourChildDragModeSelectionStates = [];
    if (contourSelectionCleared && contourChildSelectionIds.length === 2 && contourFill?.id && contourLine?.id) {
      const dragModeButton = page.getByRole('button', { name: /拖拽微调/ }).first();
      const dragModeVisible = await dragModeButton.isVisible().catch(() => false);
      if (dragModeVisible) {
        const dragModeText = (await dragModeButton.textContent().catch(() => '')) || '';
        if (!dragModeText.includes('开')) await dragModeButton.click();
        await page.waitForTimeout(250);
        const firstChild = page.locator(`svg [id="${contourChildSelectionIds[0]}"], svg [data-fig-id="${contourChildSelectionIds[0]}"]`).first();
        const secondChild = page.locator(`svg [id="${contourChildSelectionIds[1]}"], svg [data-fig-id="${contourChildSelectionIds[1]}"]`).first();
        const firstLeaf = firstChild.locator('path, use, polygon, polyline').first();
        const secondLeaf = secondChild.locator('path, use, polygon, polyline').first();
        const firstTarget = await firstLeaf.count() > 0 ? firstLeaf : firstChild;
        const secondTarget = await secondLeaf.count() > 0 ? secondLeaf : secondChild;
        if (await firstTarget.count() > 0 && await secondTarget.count() > 0) {
          const dispatchCtrlPointerClick = async (target, pointerId) => {
            const box = await target.boundingBox();
            const clientX = box ? box.x + box.width / 2 : 1;
            const clientY = box ? box.y + box.height / 2 : 1;
            const common = {
              pointerId,
              pointerType: 'mouse',
              isPrimary: true,
              button: 0,
              ctrlKey: true,
              clientX,
              clientY,
            };
            await target.dispatchEvent('pointerdown', { ...common, buttons: 1 });
            await target.dispatchEvent('pointerup', { ...common, buttons: 0 });
            await target.dispatchEvent('click', { button: 0, ctrlKey: true, clientX, clientY });
          };
          await dispatchCtrlPointerClick(firstTarget, 41);
          await page.waitForTimeout(250);
          contourChildDragModeSelectionStates.push(await page.evaluate(() => {
            const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
            const state = raw ? JSON.parse(raw) : {};
            return Array.isArray(state.selectedGids) ? state.selectedGids : [];
          }));
          await dispatchCtrlPointerClick(secondTarget, 42);
          await page.waitForTimeout(250);
          const selectedGids = await page.evaluate(() => {
            const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
            const state = raw ? JSON.parse(raw) : {};
            return Array.isArray(state.selectedGids) ? state.selectedGids : [];
          });
          contourChildDragModeSelectionStates.push(selectedGids);
          contourChildDragModeMultiSelect = selectedGids.length === 2
            && selectedGids.includes(contourFill.id)
            && selectedGids.includes(contourLine.id)
            && selectedGids.every(gid => !contourChildIds.has(gid));
        }
        const enabledText = (await dragModeButton.textContent().catch(() => '')) || '';
        if (enabledText.includes('开')) await dragModeButton.click();
        await page.waitForTimeout(250);
      }
    }
    record(
      'C0h3-contour-child-drag-mode-multiselect',
      contourChildDragModeMultiSelect ? 'PASS' : 'FAIL',
      `cleared=${contourSelectionCleared}, children=${contourChildSelectionIds.join(',')}, parents=${contourFill?.id},${contourLine?.id}, states=${JSON.stringify(contourChildDragModeSelectionStates)}, preserved=${contourChildDragModeMultiSelect}`,
    );
    await clickText(page, '布局中心');
    const layoutSelectAll = page.getByRole('button', { name: '选中全部', exact: true }).first();
    const layoutSelectAllVisible = await layoutSelectAll.isVisible().catch(() => false);
    if (layoutSelectAllVisible) {
      await layoutSelectAll.click();
      await page.waitForTimeout(250);
    }
    await clickText(page, '组件中心');
    const subplotCard = page.locator('[data-component-group-id="subplots"]');
    const subplotRows = subplotCard.locator('button[data-component-object-id]');
    const subplotRowCount = await subplotRows.count();
    let ctrlDeselectCorrect = false;
    let selectedBefore = [];
    let selectedAfter = [];
    if (layoutSelectAllVisible && subplotRowCount > 1) {
      selectedBefore = await subplotRows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed')));
      const selectedIndex = selectedBefore.findIndex((value, index) => index > 0 && value === 'true');
      if (selectedIndex >= 0) {
        await subplotRows.nth(selectedIndex).click({ modifiers: ['Control'] });
        await page.waitForTimeout(250);
        selectedAfter = await subplotRows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed')));
        ctrlDeselectCorrect = selectedBefore.filter(value => value === 'true').length > 1
          && selectedAfter[selectedIndex] === 'false'
          && selectedAfter.filter(value => value === 'true').length === selectedBefore.filter(value => value === 'true').length - 1
          && selectedAfter.every((value, index) => index === selectedIndex || value === selectedBefore[index]);
      }
    }
    record(
      'C0i-component-ctrl-deselect',
      ctrlDeselectCorrect ? 'PASS' : 'FAIL',
      `layoutSelectAll=${layoutSelectAllVisible}, rows=${subplotRowCount}, before=${JSON.stringify(selectedBefore)}, after=${JSON.stringify(selectedAfter)}`,
    );
    const cancelSelection = page.getByRole('button', { name: '取消选择', exact: true }).first();
    if (await cancelSelection.isVisible().catch(() => false)) {
      await cancelSelection.click();
      await page.waitForTimeout(200);
    }
    await clickText(page, '布局中心');
    const preservedHorizontalGapSlider = page.locator('input[data-layout-role="preserve-horizontal-gap"]').first();
    const preservedHorizontalGapVisible = await preservedHorizontalGapSlider.isVisible().catch(() => false);
    let preservedHorizontalGapPatches = [];
    let preservedHorizontalGapTarget = null;
    if (preservedHorizontalGapVisible) {
      const currentGap = Number(await preservedHorizontalGapSlider.inputValue());
      const maxGap = Number(await preservedHorizontalGapSlider.getAttribute('max'));
      await preservedHorizontalGapSlider.focus();
      await preservedHorizontalGapSlider.press(maxGap - currentGap >= 0.005 ? 'ArrowRight' : 'ArrowLeft');
      preservedHorizontalGapTarget = Number(await preservedHorizontalGapSlider.inputValue());
      const start = apiRequests.length;
      const applyPreservedHorizontalGap = page.locator('button[data-layout-action="apply-preserve-horizontal-gap"]').first();
      if (await applyPreservedHorizontalGap.isEnabled().catch(() => false)) {
        await applyPreservedHorizontalGap.click();
        await waitForApiSettle(start);
        await page.waitForTimeout(300);
        const request = apiRequests.slice(start).find(item => item.url.includes('/api/figure/patch'));
        const body = request?.postData ? JSON.parse(request.postData) : null;
        preservedHorizontalGapPatches = body?.patches || [];
      }
    }
    const preservedHorizontalSubplotPatches = preservedHorizontalGapPatches.filter(patch => String(patch.gid).startsWith('subplot.'));
    const preservedHorizontalOnlyMovesLeft = preservedHorizontalGapVisible
      && preservedHorizontalSubplotPatches.length > 0
      && preservedHorizontalGapPatches.every(patch => patch.prop === 'left')
      && preservedHorizontalGapPatches.every(patch => String(patch.gid).startsWith('subplot.') || String(patch.gid).startsWith('colorbar.'))
      && !preservedHorizontalGapPatches.some(patch => patch.gid === 'global' || ['bottom', 'width', 'height'].includes(patch.prop));
    record(
      'C0j-horizontal-gap',
      preservedHorizontalOnlyMovesLeft ? 'PASS' : 'FAIL',
      `visible=${preservedHorizontalGapVisible}, target=${preservedHorizontalGapTarget}, patches=${JSON.stringify(preservedHorizontalGapPatches)}`,
    );
    const preservedGapSlider = page.locator('input[data-layout-role="preserve-vertical-gap"]').first();
    const preservedGapVisible = await preservedGapSlider.isVisible().catch(() => false);
    let preservedGapPatches = [];
    let preservedGapTarget = null;
    if (preservedGapVisible) {
      const currentGap = Number(await preservedGapSlider.inputValue());
      const maxGap = Number(await preservedGapSlider.getAttribute('max'));
      await preservedGapSlider.focus();
      await preservedGapSlider.press(maxGap - currentGap >= 0.005 ? 'ArrowRight' : 'ArrowLeft');
      preservedGapTarget = Number(await preservedGapSlider.inputValue());
      const start = apiRequests.length;
      const applyPreservedGap = page.locator('button[data-layout-action="apply-preserve-vertical-gap"]').first();
      if (await applyPreservedGap.isEnabled().catch(() => false)) {
        await applyPreservedGap.click();
        await waitForApiSettle(start);
        await page.waitForTimeout(300);
        const request = apiRequests.slice(start).find(item => item.url.includes('/api/figure/patch'));
        const body = request?.postData ? JSON.parse(request.postData) : null;
        preservedGapPatches = body?.patches || [];
      }
    }
    const preservedGapSubplotPatches = preservedGapPatches.filter(patch => String(patch.gid).startsWith('subplot.'));
    const preservedGapOnlyMovesBottom = preservedGapVisible
      && preservedGapSubplotPatches.length > 0
      && preservedGapPatches.every(patch => patch.prop === 'bottom')
      && preservedGapPatches.every(patch => String(patch.gid).startsWith('subplot.') || String(patch.gid).startsWith('colorbar.'))
      && !preservedGapPatches.some(patch => patch.gid === 'global' || ['left', 'width', 'height'].includes(patch.prop));
    record(
      'C0j-preserve-vertical-gap',
      preservedGapOnlyMovesBottom ? 'PASS' : 'FAIL',
      `visible=${preservedGapVisible}, target=${preservedGapTarget}, patches=${JSON.stringify(preservedGapPatches)}`,
    );
    await clickText(page, '组件中心');
    const gridVisibleTarget = !(grid?.currentProps?.visible !== false);
    const gridChanged = await setBooleanInCard(page, '网格线', 'visible', gridVisibleTarget);
    const gridDraftVisible = (await getBodyText(page)).includes('已暂存');
    const gridApplied = gridChanged ? await applyAndRead(page) : { successful: false, patches: [] };
    const gridPatch = gridApplied.patches?.find(patch => patch.gid === grid?.id && patch.prop === 'visible');
    record(
      'C0k-grid-visibility-backend-draft',
      gridChanged
        && gridDraftVisible
        && gridApplied.successful
        && gridPatch?.value === gridVisibleTarget
        && gridPatch?.mode === 'backend_patch' ? 'PASS' : 'FAIL',
      `changed=${gridChanged}, draft=${gridDraftVisible}, requests=${gridApplied.requestCount || 0}, patches=${JSON.stringify(gridApplied.patches)}`,
    );
    await clickText(page, '组件中心');
    const legendFrameTarget = !(legend?.currentProps?.frameon !== false);
    const legendFrameChanged = await setBooleanInCard(page, '图例容器', 'frameon', legendFrameTarget);
    const legendFrameDraftVisible = (await getBodyText(page)).includes('已暂存');
    const legendFrameApplied = legendFrameChanged ? await applyAndRead(page) : { successful: false, patches: [] };
    const legendFramePatch = legendFrameApplied.patches?.find(patch => patch.gid === legend?.id && patch.prop === 'frameon');
    record(
      'C0l-legend-frame-component-control',
      legendFrameChanged
        && legendFrameDraftVisible
        && legendFrameApplied.successful
        && legendFramePatch?.value === legendFrameTarget
        && legendFramePatch?.mode === 'backend_patch' ? 'PASS' : 'FAIL',
      `changed=${legendFrameChanged}, draft=${legendFrameDraftVisible}, requests=${legendFrameApplied.requestCount || 0}, patches=${JSON.stringify(legendFrameApplied.patches)}`,
    );
    const cases = [
      { id: 'C1-bar-container', card: '柱形系列', prop: 'linewidth', value: 1.8, prefix: 'container.bar.' },
      { id: 'C2-errorbar-container', card: '误差棒系列', prop: 'capsize', value: 7, prefix: 'container.errorbar.' },
      { id: 'C2a-fill-between-band', card: '置信区间带', prop: 'linewidth', value: 2.15, prefix: 'collection.1.', expectedGid: fillBetweenBand?.id },
      { id: 'C2b-stem-container', card: '茎叶图系列', prop: 'stem_linewidth', value: 2.6, prefix: 'container.stem.' },
      { id: 'C2c-contour-linewidth', card: '等高线/填充等高线', prop: 'linewidth', value: 2.45, prefix: 'container.contour.', expectedGid: contourLine?.id },
      { id: 'C2d-contour-vmax', card: '等高线/填充等高线', prop: 'vmax', value: 1.75, prefix: 'container.contour', expectedCount: 2 },
      { id: 'C2e-contour-cmap', card: '等高线/填充等高线', prop: 'cmap', value: 'plasma', prefix: 'container.contour', select: true, expectedCount: 2 },
      { id: 'C2f-histogram-series-color', card: '直方图系列', prop: 'facecolor', colorScope: ':color', value: '#339966', prefix: 'container.bar.', expectedGid: histogramSeries?.id, svgFallbackGids: Array.from(histogramChildIds), color: true },
      { id: 'C2g-stairs-series-color', card: '阶梯填充系列', prop: 'edgecolor', colorScope: ':color', value: '#114488', prefix: 'patch.', expectedGid: stairsSeries?.id, color: true },
      { id: 'C2h-step-series-linewidth', card: '阶梯线系列', prop: 'linewidth', value: 2.75, prefix: 'line.', expectedGid: stepSeries?.id },
      { id: 'C3-boxplot-container', card: '箱线图系列', prop: 'median_color', value: '#cc2255', prefix: 'container.boxplot.', color: true },
      { id: 'C4-violin-container', card: '小提琴图系列', prop: 'linewidth', value: 2.4, prefix: 'container.violinplot.' },
      { id: 'C5-annotation-arrow', card: '标注箭头', prop: 'linewidth', value: 2.2, prefix: 'annotation_arrow.' },
      { id: 'C5b-legend-container', card: '图例容器', prop: 'markerscale', value: 1.8, prefix: 'legend.' },
      { id: 'C5d-legend-handle-text-gap', card: '图例容器', prop: 'handletextpad', value: 1.1, prefix: 'legend.' },
      { id: 'C5e-legend-column-gap', card: '图例容器', prop: 'columnspacing', value: 1.6, prefix: 'legend.' },
      { id: 'C5f-legend-inner-padding', card: '图例容器', prop: 'borderpad', value: 0.8, prefix: 'legend.' },
      { id: 'C5g-scatter-size-scale', card: '点 / 散点', prop: 'size_scale', value: 1.4, prefix: 'collection.' },
    ];
    for (const item of cases) {
      await clickText(page, '组件中心');
      const changed = item.color
        ? await setColorInCard(page, item.card, item.colorScope || `:${item.prop}`, item.value)
        : item.select
          ? await setSelectInCard(page, item.card, item.prop, item.value)
        : await setNumberInCard(page, item.card, item.prop, item.value);
      const draftVisible = (await getBodyText(page)).includes('已暂存');
      const applied = changed ? await applyAndRead(page) : { successful: false, patches: [] };
      const relevantPatches = (applied.patches || []).filter(patch => (
        String(patch?.gid || '').startsWith(item.prefix)
        && patch?.prop === item.prop
        && (!item.expectedGid || patch?.gid === item.expectedGid)
      ));
      const shouldCheckSvgColor = item.color && ['color', 'facecolor', 'edgecolor'].includes(item.prop);
      const svgColorApplied = !shouldCheckSvgColor || await svgTargetUsesColor(
        page,
        relevantPatches[0]?.gid || item.expectedGid,
        item.prop,
        item.value,
        item.svgFallbackGids,
      );
      const svgColorDebug = shouldCheckSvgColor && !svgColorApplied
        ? await svgColorDiagnostics(
            page,
            relevantPatches[0]?.gid || item.expectedGid,
            item.prop,
            item.value,
            item.svgFallbackGids,
          )
        : null;
      const responseSvgHasColor = shouldCheckSvgColor
        ? String(applied.responseBody?.svg || '').toLowerCase().includes(String(item.value).toLowerCase())
        : true;
      const correct = changed
        && draftVisible
        && applied.successful
        && svgColorApplied
        && applied.patches.length === (item.expectedCount || 1)
        && relevantPatches.length === applied.patches.length
        && applied.patches.every(patch => !childIds.has(patch?.gid))
        && applied.patches.every(patch => !contourChildIds.has(patch?.gid))
        && applied.patches.every(patch => !histogramChildIds.has(patch?.gid));
      record(item.id, correct ? 'PASS' : 'FAIL', `changed=${changed}, draft=${draftVisible}, svgColor=${svgColorApplied}, responseSvgColor=${responseSvgHasColor}, colorDebug=${JSON.stringify(svgColorDebug)}, requests=${applied.requestCount || 0}, responses=${applied.responseCount || 0}, server=${JSON.stringify(patchResponseSummary(applied.responseBody))}, draftKeys=${JSON.stringify(applied.draftKeys || [])}, relevant=${JSON.stringify(relevantPatches)}, patches=${JSON.stringify(applied.patches)}`);
    }
    await clickText(page, '组件中心');
    const frameChanged = await setNumberInCard(page, '子图边框 / 坐标轴框线', 'linewidth', 1.7);
    const frameDraftVisible = (await getBodyText(page)).includes('已暂存');
    const frameApplied = frameChanged ? await applyAndRead(page) : { successful: false, patches: [] };
    const expectedFrameIds = new Set(frameTargets.map(object => object.id));
    const appliedFrameIds = new Set(frameApplied.patches.map(patch => patch.gid));
    const frameFanoutCorrect = frameChanged
      && frameDraftVisible
      && frameApplied.successful
      && frameApplied.patches.length === expectedFrameIds.size
      && frameApplied.patches.every(patch => (
        expectedFrameIds.has(patch.gid)
        && patch.prop === 'linewidth'
        && Number(patch.value) === 1.7
      ))
      && Array.from(expectedFrameIds).every(id => appliedFrameIds.has(id));
    record(
      'C5c-frame-group-fanout',
      frameFanoutCorrect ? 'PASS' : 'FAIL',
      `changed=${frameChanged}, draft=${frameDraftVisible}, expected=${JSON.stringify(Array.from(expectedFrameIds))}, patches=${JSON.stringify(frameApplied.patches)}`,
    );
    const saveOk = await saveProject(page);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForPreviewReady(page, 30000);
    await clickText(page, '组件中心');
    const histogramFacecolorAfterRefresh = await inputValueInCard(page, '直方图系列', 'input[data-color-role="text"]', 'data-color-scope', ':color', true);
    const stairsEdgecolorAfterRefresh = await inputValueInCard(page, '阶梯填充系列', 'input[data-color-role="text"]', 'data-color-scope', ':color', true);
    const stepLinewidthAfterRefresh = await inputValueInCard(page, '阶梯线系列', 'input[data-param-role="number"]', 'data-param-prop', 'linewidth');
    record(
      'C5f-semantic-edits-save-refresh',
      saveOk
        && String(histogramFacecolorAfterRefresh || '').toLowerCase() === '#339966'
        && String(stairsEdgecolorAfterRefresh || '').toLowerCase() === '#114488'
        && Math.abs(Number(stepLinewidthAfterRefresh) - 2.75) < 0.001 ? 'PASS' : 'FAIL',
      `save=${saveOk}, hist=${histogramFacecolorAfterRefresh}, stairs=${stairsEdgecolorAfterRefresh}, stepLinewidth=${stepLinewidthAfterRefresh}`,
    );
    await clickText(page, '布局中心');
    const layoutControlsV2Expected = process.env.VITE_SCIFIGURE_LAYOUT_CONTROLS_V2 !== '0';
    const layoutV2Panel = page.locator('[data-layout-controls-version="2"]').first();
    const layoutV2PanelCount = await layoutV2Panel.count();
    const layoutControlKeys = layoutV2PanelCount > 0
      ? await layoutV2Panel.locator('[data-property-control]').evaluateAll(nodes => (
        Array.from(new Set(nodes.map(node => node.getAttribute('data-property-control')).filter(Boolean)))
      ))
      : [];
    const expectedLayoutKeys = ['left', 'bottom', 'width', 'height', 'aspect'];
    const layoutDescriptorControlsCorrect = layoutControlsV2Expected
      ? layoutV2PanelCount === 1
        && expectedLayoutKeys.every(key => layoutControlKeys.includes(key))
        && ['rotation', 'ha', 'va'].every(key => !layoutControlKeys.includes(key))
      : layoutV2PanelCount === 0;
    record(
      'C6a-layout-descriptor-controls',
      layoutDescriptorControlsCorrect ? 'PASS' : 'FAIL',
      `expected=${layoutControlsV2Expected}, panels=${layoutV2PanelCount}, controls=${JSON.stringify(layoutControlKeys)}`,
    );
    const layoutText = await getBodyText(page);
    const sharedDetected = layoutText.includes('共享色条 1 个');
    const physicalPanelCountCorrect = layoutText.includes('已识别 6 个子图坐标轴框');
    const layoutStart = apiRequests.length;
    const alignClicked = await clickText(page, '对齐全部色条');
    if (alignClicked) {
      await waitForApiSettle(layoutStart);
      await page.waitForTimeout(500);
    }
    const alignRequest = apiRequests.slice(layoutStart).find(item => item.url.includes('/api/figure/patch'));
    const alignBody = alignRequest?.postData ? JSON.parse(alignRequest.postData) : null;
    const alignPatches = alignBody?.patches || [];
    const colorbarPatches = alignPatches.filter(patch => patch.gid === sharedColorbar?.id);
    const colorbarProps = new Set(colorbarPatches.map(patch => patch.prop));
    const sharedAlignmentCorrect = sharedDetected
      && physicalPanelCountCorrect
      && alignClicked
      && colorbarPatches.length === 4
      && ['left', 'bottom', 'width', 'height'].every(prop => colorbarProps.has(prop))
      && alignPatches.every(patch => patch.gid === sharedColorbar?.id);
    record(
      'C6-shared-colorbar-layout',
      sharedAlignmentCorrect ? 'PASS' : 'FAIL',
      `detected=${sharedDetected}, physicalPanels=${physicalPanelCountCorrect}, clicked=${alignClicked}, patches=${JSON.stringify(alignPatches)}`,
    );
    await Promise.all(pendingApiResponseCaptures);
    const failedApiResponses = apiResponses
      .filter(response => response.status >= 400)
      .map(response => ({
        method: response.method,
        path: new URL(response.url).pathname,
        status: response.status,
        body: response.body,
      }));
    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `console=${JSON.stringify(consoleErrors)}, page=${JSON.stringify(pageErrors)}, non2xx=${JSON.stringify(failedApiResponses)}`,
    );
  } finally {
    await browser.close();
    await requestJson(`/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

try {
  await run();
} catch (error) {
  record('HARNESS', 'FAIL', error?.message || String(error));
}

const failed = results.filter(result => result.status === 'FAIL');
const conclusion = failed.length === 0 ? 'PASS' : 'FAIL';
const reportLines = [
  '# Component Container Semantic Smoke Report',
  '',
  `Conclusion: ${conclusion}, PASS=${results.length - failed.length}, FAIL=${failed.length}`,
  '',
  '| ID | Status | Note |',
  '|---|---|---|',
  ...results.map(result => `| ${result.id} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
  '',
];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), reportLines.join('\n'), 'utf8');
console.log(`Conclusion: ${conclusion}, PASS=${results.length - failed.length}, FAIL=${failed.length}`);
console.log(`Report: ${path.join(OUTPUT_DIR, 'report.md')}`);
if (failed.length > 0) process.exitCode = 1;
