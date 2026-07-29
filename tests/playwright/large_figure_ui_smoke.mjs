/**
 * Large-figure browser regression smoke.
 *
 * Uses an in-memory session fixture so it never creates, changes, or deletes
 * real project data. The fixture proves that UI bounding does not remove
 * manifest semantics or force repeated SVG sanitization during selection.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `large-figure-ui-${RUN_ID}`);
const OBJECT_COUNT = 620;
const results = [];

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || message.includes('WebSocket connection to')
    || message.includes('WebSocket closed without opened');
}

function buildFixture() {
  const textObjects = Array.from({ length: OBJECT_COUNT }, (_, index) => ({
    id: `text.${index}`,
    kind: 'text',
    label: `Layer Label ${index}`,
    editable: ['text', 'fontsize', 'fontfamily', 'color', 'position'],
    currentProps: {
      text: `Layer Label ${index}`,
      fontsize: 8,
      color: '#223344',
      position: [20 + (index % 20) * 35, 25 + Math.floor(index / 20) * 18],
      visible: true,
    },
    role: 'annotation_text',
    subplotId: 'subplot.0',
    identity: {
      semanticKey: `annotation:layer-${index}`,
      instanceKey: `subplot.0:text.${index}`,
      scope: 'subplot',
      coordinateSpace: 'data',
      relation: { subplotId: 'subplot.0' },
    },
  }));

  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects: [
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'Panel A',
        editable: ['left', 'bottom', 'width', 'height'],
        currentProps: {
          label: 'Panel A',
          subplotIndex: 0,
          left: 0.1,
          bottom: 0.1,
          width: 0.8,
          height: 0.8,
        },
        identity: {
          semanticKey: 'subplot:0',
          instanceKey: 'subplot.0',
          scope: 'subplot',
          coordinateSpace: 'figure',
        },
      },
      ...textObjects,
    ],
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };

  const svgTexts = textObjects.map((object, index) => {
    const x = 20 + (index % 20) * 35;
    const y = 25 + Math.floor(index / 20) * 18;
    return `<text id="${object.id}" data-fig-id="${object.id}" x="${x}" y="${y}" font-size="8" fill="#223344">${object.currentProps.text}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="620" viewBox="0 0 720 620"><rect id="subplot.0" data-fig-id="subplot.0" x="12" y="12" width="696" height="596" fill="white" stroke="#222"/>${svgTexts}</svg>`;

  const spec = {
    plot_type: 'custom',
    custom_script: '',
    script: '',
    script_language: 'python',
    figure: { width: 190, height: 164, unit: 'mm', dpi: 300 },
  };
  const figSession = {
    sessionId: 'large-figure-ui-fixture',
    script: '',
    language: 'python',
    dataPayload: {},
    editLog: [],
    revision: 1,
    svg,
    manifest,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: null,
    projectName: 'Large figure UI fixture',
    figSession,
    renderLog: ['> Large figure UI fixture ready'],
    projectFigures: {},
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: [],
    projectHistory: {},
    projectDrafts: {},
    currentView: 'workspace',
    subView: 'home',
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(fixture => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(fixture));
  }, buildFixture());
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'large-figure-ui-user', email: 'large-figure-ui@example.test' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/projects**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', projects: [] }),
  }));
  await page.route('**/api/export-assets', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', assets: [] }),
  }));

  try {
    const loadStartedAt = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const layerSearch = page.getByTestId('layer-tree-search');
    await layerSearch.waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('[data-svg-sanitize-ms]').waitFor({ state: 'visible', timeout: 30000 });
    const firstReadyMs = Date.now() - loadStartedAt;
    const svgBytes = Number(await page.locator('[data-svg-bytes]').getAttribute('data-svg-bytes'));
    const renderedLayerNodes = await page.locator('[data-layer-node-id]').count();
    const renderMode = await page.locator('[data-layer-node-id="text.0"]').evaluate(element => ({
      contentVisibility: getComputedStyle(element.parentElement || element).contentVisibility,
      marker: element.parentElement?.getAttribute('data-layer-render-mode') || '',
    }));
    record('LARGE-UI-0A', firstReadyMs < 5000 ? 'PASS' : 'FAIL', `首个可交互画布 ${firstReadyMs}ms，SVG ${svgBytes} bytes`);
    record('LARGE-UI-0B', renderedLayerNodes <= 260 ? 'PASS' : 'FAIL', `图层 DOM 节点 ${renderedLayerNodes}，manifest 对象 621`);
    record('LARGE-UI-0C', renderMode.contentVisibility === 'auto' && renderMode.marker === 'content-visibility' ? 'PASS' : 'FAIL',
      `contentVisibility=${renderMode.contentVisibility}, marker=${renderMode.marker}`);

    const scrollMetric = await layerSearch.evaluate(async element => {
      const container = element.parentElement;
      if (!container) return { ms: Infinity, scrollTop: 0, scrollHeight: 0 };
      const startedAt = performance.now();
      container.scrollTop = container.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        ms: performance.now() - startedAt,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
      };
    });
    record('LARGE-UI-0D', scrollMetric.ms < 250 && scrollMetric.scrollTop > 0 ? 'PASS' : 'FAIL',
      `滚动双帧响应 ${scrollMetric.ms.toFixed(1)}ms，scrollTop=${scrollMetric.scrollTop}`);

    const hiddenNotice = page.getByTestId('layer-tree-hidden-count').filter({ hasText: '已隐藏 400 个对象' });
    const noticeVisible = await hiddenNotice.isVisible().catch(() => false);
    record('LARGE-UI-1', noticeVisible ? 'PASS' : 'FAIL', noticeVisible
      ? '620 个文本对象仅渲染 220 个列表节点，完整对象仍保留'
      : '未观察到预期的 400 个隐藏节点提示');

    const searchStartedAt = Date.now();
    await layerSearch.fill('Layer Label 599');
    const hiddenTarget = page.getByText('Layer Label 599', { exact: true }).first();
    await hiddenTarget.waitFor({ state: 'visible', timeout: 10000 });
    const searchReadyMs = Date.now() - searchStartedAt;
    record('LARGE-UI-2', searchReadyMs < 1000 ? 'PASS' : 'FAIL', `第 599 个对象通过完整树搜索定位：${searchReadyMs}ms`);

    const sanitizeCountBeforeSelection = Number(await page.locator('[data-svg-sanitize-count]').getAttribute('data-svg-sanitize-count'));
    await hiddenTarget.click();
    await layerSearch.fill('');
    await hiddenTarget.waitFor({ state: 'visible', timeout: 10000 });
    const sanitizeCountAfterSelection = Number(await page.locator('[data-svg-sanitize-count]').getAttribute('data-svg-sanitize-count'));
    const selectionPreserved = await hiddenTarget.isVisible().catch(() => false);
    record('LARGE-UI-3', selectionPreserved ? 'PASS' : 'FAIL', selectionPreserved
      ? '选中窗口外对象后，清除搜索仍保留该对象可见'
      : '窗口外选中对象在清除搜索后丢失');
    record('LARGE-UI-4', sanitizeCountAfterSelection === sanitizeCountBeforeSelection ? 'PASS' : 'FAIL',
      `选择前后 SVG sanitize 计数 ${sanitizeCountBeforeSelection} -> ${sanitizeCountAfterSelection}`);

    const svgTarget = page.locator('[data-svg-sanitize-ms] svg [data-fig-id="text.598"]');
    await svgTarget.click({ force: true });
    const sanitizeCountAfterSvgClick = Number(await page.locator('[data-svg-sanitize-count]').getAttribute('data-svg-sanitize-count'));
    record('LARGE-UI-5', sanitizeCountAfterSvgClick === sanitizeCountAfterSelection ? 'PASS' : 'FAIL',
      `SVG 图元点击后 sanitize 计数保持 ${sanitizeCountAfterSvgClick}`);

    await page.getByRole('button', { name: '代码面板' }).click();
    const manifestTab = page.getByRole('button', { name: 'Manifest (v2)' });
    await manifestTab.click();
    const manifestSearch = page.getByTestId('manifest-object-search');
    await manifestSearch.waitFor({ state: 'visible', timeout: 10000 });
    const initialRows = await page.locator('[data-manifest-object-id]').count();
    await manifestSearch.fill('annotation:layer-619');
    const filteredRow = page.locator('[data-manifest-object-id="text.619"]');
    await filteredRow.waitFor({ state: 'visible', timeout: 10000 });
    const filterSummary = await page.getByTestId('manifest-filter-summary').textContent();
    record('LARGE-UI-6', initialRows === 250 ? 'PASS' : 'FAIL', `Manifest 默认渲染 ${initialRows} 行`);
    record('LARGE-UI-7', filterSummary?.includes('匹配 1 / 621') ? 'PASS' : 'FAIL', filterSummary || '缺少筛选摘要');

    await page.screenshot({ path: path.join(OUTPUT_DIR, 'large-figure-ui.png'), fullPage: true });
    record('LARGE-UI-8', pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
      `pageErrors=${pageErrors.length}, consoleErrors=${consoleErrors.length}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter(result => result.status === 'FAIL');
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'report.json'),
    JSON.stringify({ baseUrl: BASE_URL, objectCount: OBJECT_COUNT, results }, null, 2),
  );
  if (failed.length > 0) {
    throw new Error(`${failed.length} large-figure UI checks failed`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
