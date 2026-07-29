/**
 * Multi-Figure UI state isolation smoke.
 *
 * Verifies that selection and drag-preview lifecycle are scoped to the active
 * Figure even when separate figures reuse the same raw gid values.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `multi-figure-ui-state-${RUN_ID}`);
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

function makeFigure(figureId, index) {
  const accent = ['#2f6fed', '#d65a31', '#218c74'][index];
  const uniqueId = `text.unique.${index}`;
  const objects = [
    {
      id: 'subplot.0',
      kind: 'subplot',
      label: `Panel ${index + 1}`,
      editable: ['left', 'bottom', 'width', 'height'],
      currentProps: { label: `Panel ${index + 1}`, subplotIndex: 0, left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
    },
    {
      id: 'title.0',
      kind: 'text',
      label: `Figure ${index + 1} title`,
      editable: ['text', 'fontsize', 'color', 'position'],
      currentProps: { text: `Figure ${index + 1} title`, fontsize: 14, color: accent, position: [180, 38], visible: true },
      role: 'axes_title',
      subplotId: 'subplot.0',
      identity: { semanticKey: 'axes-title', instanceKey: `${figureId}:title`, scope: 'subplot', coordinateSpace: 'axes', relation: { subplotId: 'subplot.0' } },
    },
    {
      id: uniqueId,
      kind: 'text',
      label: `Unique label ${index + 1}`,
      editable: ['text', 'fontsize', 'color', 'position'],
      currentProps: { text: `Unique label ${index + 1}`, fontsize: 10, color: '#223344', x: 0.5, y: 0.5, coord_system: 'axes', position: [0.5, 0.5], visible: true },
      role: 'annotation_text',
      subplotId: 'subplot.0',
      identity: { semanticKey: `unique-${index}`, instanceKey: `${figureId}:unique`, scope: 'subplot', coordinateSpace: 'axes', relation: { subplotId: 'subplot.0' } },
    },
  ];
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects,
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260" viewBox="0 0 420 260"><rect id="subplot.0" data-fig-id="subplot.0" x="30" y="20" width="360" height="210" fill="white" stroke="#222"/><text id="title.0" data-fig-id="title.0" x="180" y="38" fill="${accent}" font-size="14">Figure ${index + 1} title</text><text id="${uniqueId}" data-fig-id="${uniqueId}" x="180" y="120" fill="#223344" font-size="10">Unique label ${index + 1}</text></svg>`;
  return {
    figureId,
    index,
    manifest,
    editLog: [],
    revision: 1,
    svg,
    fingerprint: `fixture-${figureId}`,
    codeSlice: null,
    renderStatus: 'success',
  };
}

function buildFixture() {
  const spec = {
    plot_type: 'custom',
    custom_script: '',
    script: '',
    script_language: 'python',
    figure: { width: 120, height: 80, unit: 'mm', dpi: 300 },
  };
  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: 'multi-figure-ui-fixture',
    projectName: 'Multi Figure UI fixture',
    figSession: null,
    renderLog: ['> Multi Figure UI fixture ready'],
    projectFigures: {
      fig_1: makeFigure('fig_1', 0),
      fig_2: makeFigure('fig_2', 1),
      fig_3: makeFigure('fig_3', 2),
    },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: ['title.0'],
    projectHistory: {},
    projectDrafts: {},
    currentView: 'workspace',
    subView: 'home',
  };
}

async function selectedNode(page, gid) {
  return page.locator(`[data-layer-node-id="${gid}"][data-selected="true"]`).count();
}

async function sanitizeCount(page) {
  return Number(await page.locator('[data-svg-sanitize-count]').getAttribute('data-svg-sanitize-count'));
}

async function dragSvgObject(page, gid, dx, dy) {
  const target = page.locator(`[data-svg-sanitize-count] [data-fig-id="${gid}"]`).first();
  const box = await target.boundingBox();
  if (!box) return false;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
  return true;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(fixture => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(fixture));
  }, buildFixture());
  const page = await context.newPage();
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'multi-figure-ui-user', email: 'multi-figure-ui@example.test' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/projects**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === '/api/projects'
      ? { status: 'success', projects: [] }
      : pathname.endsWith('/export-assets')
        ? { status: 'success', assets: [] }
        : pathname.endsWith('/figures')
          ? { status: 'success', figures: [] }
          : { status: 'success', project: { figures: [] } };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const layerSearch = page.getByTestId('layer-tree-search');
    const workspaceReady = await page.getByText('图层结构', { exact: true })
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!workspaceReady) {
      const bodyText = ((await page.textContent('body').catch(() => '')) || '').slice(0, 1200);
      throw new Error(`Workspace did not load at ${page.url()}: ${bodyText}`);
    }
    await page.locator('[data-svg-sanitize-count]').waitFor({ state: 'visible', timeout: 30000 });

    await page.getByRole('button', { name: '图层结构与搜索' }).click();
    const layerSearchFocused = await layerSearch.evaluate(element => document.activeElement === element);
    record('RAIL-1', layerSearchFocused ? 'PASS' : 'FAIL', `图层结构按钮聚焦搜索框：${layerSearchFocused}`);

    await page.getByRole('button', { name: '字体中心' }).first().click();
    const fontTab = page.getByRole('button', { name: '字体中心' }).last();
    const fontTabClass = await fontTab.getAttribute('class');
    record('RAIL-2', fontTabClass?.includes('border-blue-500') ? 'PASS' : 'FAIL', '字体按钮切换右侧字体中心');

    const initialCount = await sanitizeCount(page);
    const fig1Selected = await selectedNode(page, 'title.0');
    record('FIG-STATE-1', fig1Selected === 1 ? 'PASS' : 'FAIL', `Figure 1 恢复 title.0 选择：${fig1Selected}`);

    await page.getByRole('button', { name: /^Figure\s*2$/ }).click();
    await page.getByText('Figure 2 title', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    const fig2InheritedTitle = await selectedNode(page, 'title.0');
    const fig2Count = await sanitizeCount(page);
    record('FIG-STATE-2', fig2InheritedTitle === 0 ? 'PASS' : 'FAIL', `首次进入 Figure 2 未继承 Figure 1 的同名 title.0：${fig2InheritedTitle}`);
    record('FIG-STATE-3', fig2Count === initialCount + 1 ? 'PASS' : 'FAIL', `切换 Figure 只新增一次 sanitize：${initialCount} -> ${fig2Count}`);

    const fig2Unique = page.locator('[data-layer-node-id="text.unique.1"]').first();
    await fig2Unique.click();
    const fig2UniqueSelected = await selectedNode(page, 'text.unique.1');
    record('FIG-STATE-4', fig2UniqueSelected === 1 ? 'PASS' : 'FAIL', `Figure 2 独立选择已记录：${fig2UniqueSelected}`);

    await page.getByRole('button', { name: /^Figure\s*1$/ }).click();
    await page.getByText('Figure 1 title', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    const fig1Restored = await selectedNode(page, 'title.0');
    const fig1ReturnCount = await sanitizeCount(page);
    record('FIG-STATE-5', fig1Restored === 1 ? 'PASS' : 'FAIL', `返回 Figure 1 恢复原选择：${fig1Restored}`);
    record('FIG-STATE-6', fig1ReturnCount === fig2Count + 1 ? 'PASS' : 'FAIL', `返回 Figure 1 只清洗活动 SVG 一次：${fig2Count} -> ${fig1ReturnCount}`);

    await page.getByRole('button', { name: /^Figure\s*2$/ }).click();
    await page.getByText('Figure 2 title', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
    const fig2Restored = await selectedNode(page, 'text.unique.1');
    const previewCount = await page.locator('[data-svg-sanitize-count]').count();
    record('FIG-STATE-7', fig2Restored === 1 ? 'PASS' : 'FAIL', `再次进入 Figure 2 恢复独立选择：${fig2Restored}`);
    record('FIG-STATE-8', previewCount === 1 ? 'PASS' : 'FAIL', `页面始终只挂载一个活动 Figure SVG：${previewCount}`);

    await page.getByRole('button', { name: /拖拽微调 关/ }).click();
    const dragged = await dragSvgObject(page, 'text.unique.1', 45, 20);
    const pendingVisible = await page.getByText('已累计移动 1 个文本对象', { exact: false }).isVisible({ timeout: 10000 }).catch(() => false);
    await page.getByRole('button', { name: /^Figure\s*3$/ }).click();
    const guardVisible = await page.getByTestId('figure-switch-drag-guard').isVisible({ timeout: 5000 }).catch(() => false);
    const stillOnFigure2 = await page.getByText('Figure 2 title', { exact: true }).first().isVisible().catch(() => false);
    record('FIG-STATE-9', dragged && pendingVisible && guardVisible && stillOnFigure2 ? 'PASS' : 'FAIL',
      `pending=${pendingVisible}, guard=${guardVisible}, stillFigure2=${stillOnFigure2}`);

    await page.getByRole('button', { name: '取消' }).click();
    await page.getByRole('button', { name: /^Figure\s*3$/ }).click();
    const switchedAfterCancel = await page.getByText('Figure 3 title', { exact: true }).first().isVisible({ timeout: 10000 }).catch(() => false);
    const guardCleared = await page.getByTestId('figure-switch-drag-guard').count() === 0;
    record('FIG-STATE-10', switchedAfterCancel && guardCleared ? 'PASS' : 'FAIL',
      `switchedAfterCancel=${switchedAfterCancel}, guardCleared=${guardCleared}`);

    await page.screenshot({ path: path.join(OUTPUT_DIR, 'multi-figure-state.png'), fullPage: true });
    record('FIG-STATE-11', pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
      `pageErrors=${pageErrors.length}, consoleErrors=${consoleErrors.length}`);
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify({ baseUrl: BASE_URL, results }, null, 2));
  const failures = results.filter(result => result.status === 'FAIL');
  if (failures.length > 0) throw new Error(`${failures.length} multi-Figure UI checks failed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
