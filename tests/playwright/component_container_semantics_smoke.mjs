import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
let authToken = '';
const OUTPUT_DIR = path.resolve('output', 'playwright', 'component-container');

const script = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'from matplotlib.colors import Normalize',
  'fig, axes = plt.subplots(2, 2, figsize=(7, 6))',
  'ax0, ax1, ax2, ax3 = axes.ravel()',
  'ax0.bar(["A", "B", "C"], [2, 3, 1], color="#88aadd", edgecolor="#222222", label="Bars")',
  'ax0.legend(title="Groups")',
  'ax0_twin = ax0.twinx()',
  'ax0_twin.plot([0, 1, 2], [10, 14, 12], color="#cc6677", label="Twin")',
  'ax0_twin.set_ylabel("Twin scale")',
  'ax0.set_title("Bar")',
  'ax1.errorbar([0, 1, 2], [2.2, 3.1, 1.4], yerr=[0.2, 0.3, 0.1], color="#333333", capsize=4, label="Error")',
  'ax1.set_title("Errorbar")',
  'shared_scale = plt.cm.ScalarMappable(norm=Normalize(0, 1), cmap="viridis")',
  'shared_scale.set_array([])',
  'fig.colorbar(shared_scale, ax=[ax0, ax1], label="Shared scale")',
  'rng = np.random.default_rng(42)',
  'ax2.boxplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], patch_artist=True)',
  'ax2.set_title("Boxplot")',
  'ax3.violinplot([rng.normal(0, 1, 40), rng.normal(1, 1, 40)], showmeans=True)',
  'ax3.stem([1, 2], [1.4, 1.9], label="Stem signal")',
  'ax3.annotate("Arrow note", xy=(1, 0), xytext=(1.55, 1.6), arrowprops=dict(arrowstyle="->"))',
  'ax3.set_title("Violin Stem")',
  'fig.tight_layout()',
].join('\n');

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || message.includes("WebSocket connection to 'ws://localhost:24678/")
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
    const heading = semanticCard || Array.from(document.querySelectorAll('span, div, p, h4'))
      .find((node) => rendered(node) && rightSide(node) && normalize(node.textContent) === normalize(cardText));
    if (!heading) return null;
    let current = semanticCard || heading.parentElement;
    while (current && rightSide(current)) {
      const control = Array.from(current.querySelectorAll(selector))
        .find((node) => {
          if (!rendered(node) || node.disabled) return false;
          const actual = String(node.getAttribute(attribute) || '');
          return endsWith ? actual.endsWith(expected) : actual === expected;
        });
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
  let element = handle.asElement();
  if (!element) {
    const fallback = page.locator(`input[data-param-role="number"][data-param-prop="${prop}"]`);
    if (await fallback.count() > 0) {
      element = await fallback.first().elementHandle();
    }
  }
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
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(600);
  return true;
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
  const responseOk = apiResponses.slice(start).some(item => item.url.includes('/api/figure/patch') && item.status >= 200 && item.status < 300);
  const body = request?.postData ? JSON.parse(request.postData) : null;
  return {
    successful: responseOk,
    patches: body?.patches || [],
    requestCount: apiRequests.slice(start).length,
    responseCount: apiResponses.slice(start).length,
  };
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'component containers');
  await cleanupSmokeProjects();
  const fixture = await createFixture();
  const manifest = fixture.rendered.figures[0].manifest;
  const containerKinds = ['bar_container', 'errorbar_container', 'stem_container', 'boxplot_container', 'violinplot_container'];
  const containers = manifest.objects.filter(object => containerKinds.includes(object.kind));
  const childIds = new Set(containers.flatMap(container => container.children || []));
  const annotationText = manifest.objects.find(object => object.role === 'annotation_text');
  const annotationArrow = manifest.objects.find(object => object.role === 'annotation_arrow');
  const sharedColorbar = manifest.objects.find(object => object.kind === 'colorbar');
  const sharedColorbarChildren = manifest.objects.filter(object => (
    object.identity?.relation?.colorbarId === sharedColorbar?.id
    && object.source?.axesIndex === sharedColorbar?.source?.axesIndex
  ));
  const legend = manifest.objects.find(object => object.kind === 'legend');
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
    if (request.url().includes('/api/figure/patch')) apiRequests.push({ url: request.url(), postData: request.postData() });
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/figure/patch')) apiResponses.push({ url: response.url(), status: response.status() });
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await installFixtureState(page, fixture);
    const componentTabClicked = await clickText(page, '组件中心');
    const initialComponentText = await getBodyText(page);
    const rightPanelLabels = await page.locator('.scifig-editor-panel-right [data-component-group-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-component-group-label')));
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'component-center.png'), fullPage: true });
    const initialStemControlCount = await page.locator('input[data-param-role="number"][data-param-prop="stem_linewidth"]').count();
    record(
      'C0f-stem-component-controls',
      initialComponentText.includes('茎叶图系列') && initialStemControlCount > 0 && initialComponentText.includes('双轴') ? 'PASS' : 'FAIL',
      `clicked=${componentTabClicked}, card=${initialComponentText.includes('茎叶图系列')}, controls=${initialStemControlCount}, labels=${JSON.stringify(rightPanelLabels.slice(0, 20))}`,
    );
    const cases = [
      { id: 'C1-bar-container', card: '柱形系列', prop: 'linewidth', value: 1.8, prefix: 'container.bar.' },
      { id: 'C2-errorbar-container', card: '误差棒系列', prop: 'capsize', value: 7, prefix: 'container.errorbar.' },
      { id: 'C2b-stem-container', card: '茎叶图系列', prop: 'stem_linewidth', value: 2.6, prefix: 'container.stem.' },
      { id: 'C3-boxplot-container', card: '箱线图系列', prop: 'median_color', value: '#cc2255', prefix: 'container.boxplot.', color: true },
      { id: 'C4-violin-container', card: '小提琴图系列', prop: 'linewidth', value: 2.4, prefix: 'container.violinplot.' },
      { id: 'C5-annotation-arrow', card: '标注箭头', prop: 'linewidth', value: 2.2, prefix: 'annotation_arrow.' },
      { id: 'C5b-legend-container', card: '图例容器', prop: 'markerscale', value: 1.8, prefix: 'legend.' },
    ];
    for (const item of cases) {
      await clickText(page, '组件中心');
      const changed = item.color
        ? await setColorInCard(page, item.card, `:${item.prop}`, item.value)
        : await setNumberInCard(page, item.card, item.prop, item.value);
      const draftVisible = (await getBodyText(page)).includes('已暂存');
      const applied = changed ? await applyAndRead(page) : { successful: false, patches: [] };
      const correct = changed
        && draftVisible
        && applied.successful
        && applied.patches.length === 1
        && String(applied.patches[0]?.gid || '').startsWith(item.prefix)
        && applied.patches[0]?.prop === item.prop
        && !childIds.has(applied.patches[0]?.gid);
      record(item.id, correct ? 'PASS' : 'FAIL', `changed=${changed}, draft=${draftVisible}, requests=${applied.requestCount || 0}, responses=${applied.responseCount || 0}, patches=${JSON.stringify(applied.patches)}`);
    }
    await clickText(page, '布局中心');
    const layoutText = await getBodyText(page);
    const sharedDetected = layoutText.includes('共享色条 1 个');
    const physicalPanelCountCorrect = layoutText.includes('已识别 4 个子图坐标轴框');
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
    record('N1', consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL', `console=${consoleErrors.length}, page=${pageErrors.length}`);
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
console.log(`Conclusion: ${failed.length === 0 ? 'PASS' : 'FAIL'}, PASS=${results.length - failed.length}, FAIL=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;
