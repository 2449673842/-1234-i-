import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'composition-selector');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || message.includes('WebSocket connection to')
    || message.includes('WebSocket closed without opened');
}

function makeFigure(figureId, index, overrides = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240"><rect x="20" y="20" width="320" height="190" fill="white" stroke="#17332c"/><text x="40" y="55">${figureId}</text></svg>`;
  return {
    figureId,
    index,
    revision: 1,
    svg,
    manifest: {
      generatedBy: 'introspection',
      globals: {},
      objects: [{
        id: `subplot.${index}`,
        kind: 'subplot',
        label: `Panel ${index + 1}`,
        editable: ['left', 'bottom', 'width', 'height'],
        currentProps: {
          label: `Panel ${index + 1}`,
          subplotIndex: index,
          left: 0.08,
          bottom: 0.12,
          width: 0.84,
          height: 0.78,
        },
      }],
      palettes: [],
      groups: [],
      bindings: [],
      capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    },
    codeSlice: { code: `# ${figureId}`, confidence: 'high', mode: 'fixture' },
    language: 'python',
    subplotCount: 1,
    aspectRatio: 1.5,
    hasLegend: index % 2 === 0,
    hasColorbar: false,
    dataFileCount: 1,
    dependencyStatus: 'complete',
    ...overrides,
  };
}

function appFixture() {
  const figure = makeFigure('fig_1', 0);
  return {
    spec: {
      plot_type: 'custom',
      custom_script: 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()',
      script_language: 'python',
      figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
    },
    history: [],
    historyIndex: 0,
    projectId: 'project-current',
    projectName: 'Current multi project',
    projectFigures: { fig_1: { ...figure, editLog: [], renderStatus: 'success' } },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: [],
    projectHistory: {},
    projectDrafts: {},
    renderLog: ['> composition selector fixture'],
    currentView: 'editor',
    subView: 'home',
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await context.addInitScript(value => window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value)), appFixture());
    const page = await context.newPage();
    const errors = [];
    const failedResponses = [];
    let createPayload = null;
    page.on('pageerror', error => {
      if (!isIgnorableDevServerNoise(error.message)) errors.push(error.message);
    });
    page.on('response', response => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    page.on('console', message => {
      if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) errors.push(message.text());
    });

    const currentFigures = Array.from({ length: 30 }, (_, index) => makeFigure(`fig_${index + 1}`, index));
    const nestedFigure = makeFigure('fig_1', 0, { codeSlice: null, language: 'r', dependencyStatus: 'unknown' });
    await page.route('**/api/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', user: { id: 'composition-ui-user' } }) }));
    await page.route('**/api/projects', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        projects: [
          { id: 'project-current', name: 'Current multi project', updated_at: '2026-07-12T02:40:00+08:00', project_type: 'multi_figure', project_type_label: '多 Figure 项目', figure_count: 30 },
          { id: 'project-nested', name: 'Nested composition project', updated_at: '2026-07-11T22:10:00+08:00', project_type: 'composition_code', project_type_label: '组合代码项目', figure_count: 1 },
          { id: 'project-single', name: 'Single source project', updated_at: '2026-07-10T09:00:00+08:00', project_type: 'single_figure', project_type_label: '单图项目', figure_count: 1 },
        ],
      }),
    }));
    await page.route('**/api/projects/project-current/figures?includePreview=1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', figures: currentFigures, previewSource: 'cache' }) }));
    await page.route('**/api/projects/project-nested/figures?includePreview=1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', figures: [nestedFigure], previewSource: 'cache' }) }));
    await page.route('**/api/projects/project-single/figures?includePreview=1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', figures: [makeFigure('fig_1', 0)], previewSource: 'cache' }) }));
    await page.route('**/api/projects/project-current/export-assets', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', assets: [] }),
    }));
    await page.route('**/api/projects/project-current/figures/render', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', figures: [makeFigure('fig_1', 0)] }),
    }));
    await page.route('**/api/projects/project-current', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        project: {
          id: 'project-current',
          name: 'Current multi project',
          script: appFixture().spec.custom_script,
          figures: [{ figureId: 'fig_1', editLog: [] }],
        },
      }),
    }));
    await page.route('**/api/projects/create-composition-project', async route => {
      createPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', projectId: 'created-composition', projectName: 'Created composition', prompt: 'prompt', copiedFiles: [] }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const compositionEntry = page.getByRole('button', { name: '组合代码项目', exact: true });
    const workspaceReady = await compositionEntry.waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!workspaceReady) {
      const bodyText = ((await page.textContent('body').catch(() => '')) || '').slice(0, 1600);
      throw new Error(`Composition workspace did not load at ${page.url()}. Body: ${bodyText}. Browser errors: ${errors.join(' | ')}`);
    }
    await compositionEntry.click();
    await page.getByTestId('composition-project-dialog').waitFor();
    assert(await page.getByText(/更新/).count() > 0, 'Project cards do not show update time');

    await page.getByPlaceholder('搜索来源项目').fill('Nested');
    await page.getByRole('button', { name: '组合项目' }).click();
    assert(await page.locator('[data-composition-project-id="project-nested"]').isVisible(), 'Composition project filter did not show nested project');
    assert(await page.locator('[data-composition-project-id="project-current"]').count() === 0, 'Project filter left unrelated project visible');

    await page.getByPlaceholder('搜索来源项目').fill('');
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.locator('[data-composition-project-id="project-current"]').click();
    await page.locator('[data-composition-figure-id="fig_30"]').waitFor();
    const deferredPreviewCount = await page.locator('[data-composition-figure-id] [style*="content-visibility"]').count();
    assert(deferredPreviewCount === 30, `Expected 30 deferred thumbnails, got ${deferredPreviewCount}`);
    await page.waitForTimeout(150);
    const renderedPreviewCount = await page.locator('[data-composition-figure-id] [data-svg-preview-rendered="true"]').count();
    assert(renderedPreviewCount > 0 && renderedPreviewCount < 30, `Expected visible-area SVG rendering, got ${renderedPreviewCount} of 30`);
    assert(await page.locator('[data-composition-figure-id="fig_1"]').getByText(/比例 1\.50:1/).isVisible(), 'Figure card does not show aspect ratio');
    assert(await page.locator('[data-composition-figure-id="fig_1"]').getByText(/代码片段/).isVisible(), 'Figure card does not show code source state');

    await page.locator('[data-composition-figure-id="fig_2"]').click();
    await page.getByRole('button', { name: '加入来源 Figure' }).click();
    assert(await page.locator('[data-composition-source-key="project-current:fig_2"]').isVisible(), 'Selected Figure was not added');
    await page.getByRole('button', { name: '加入来源 Figure' }).click();
    assert(await page.getByText(/已在已选列表中/).isVisible(), 'Duplicate Figure did not show a visible notice');

    await page.getByRole('button', { name: '下移 Current multi project fig_1' }).click();
    const orderedKeys = await page.locator('[data-composition-source-key]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-composition-source-key')));
    assert(orderedKeys[0] === 'project-current:fig_2' && orderedKeys[1] === 'project-current:fig_1', `Source order was not updated: ${orderedKeys.join(',')}`);
    assert(await page.getByTestId('composition-resolved-layout').textContent() === '1x2', 'Auto layout did not resolve to 1x2 for two figures');

    await page.locator('[data-composition-project-id="project-nested"]').click();
    await page.locator('[data-composition-figure-id="fig_1"]').waitFor();
    await page.getByRole('button', { name: '加入来源 Figure' }).click();
    assert(await page.getByTestId('composition-risk-list').getByText(/包含组合代码项目/).isVisible(), 'Nested composition risk was not shown');
    assert(await page.getByTestId('composition-risk-list').getByText(/同时包含 Python 与 R/).isVisible(), 'Mixed-language risk was not shown');
    await page.getByRole('button', { name: '最近使用', exact: true }).click();
    assert(await page.locator('[data-composition-project-id="project-current"]').isVisible(), 'Recent projects omitted the current project');
    assert(await page.locator('[data-composition-project-id="project-nested"]').isVisible(), 'Recent projects omitted the nested project');
    assert(await page.locator('[data-composition-project-id="project-single"]').count() === 0, 'Recent project filter left an unused project visible');
    await page.getByRole('button', { name: '最近使用', exact: true }).click();
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'compact.png'), fullPage: true });
    const compactCreateAction = page.getByTestId('create-composition-project');
    await compactCreateAction.scrollIntoViewIfNeeded();
    const compactCreateBox = await compactCreateAction.boundingBox();
    assert(
      compactCreateBox && compactCreateBox.y >= 0 && compactCreateBox.y + compactCreateBox.height <= 900,
      'Create action cannot be reached in compact viewport',
    );
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'compact-action.png'), fullPage: true });
    await page.setViewportSize({ width: 1680, height: 1050 });

    const resolvedLayout = await page.getByTestId('composition-resolved-layout').textContent();
    await page.getByTestId('create-composition-project').click();
    await page.getByText('已复制到剪贴板').waitFor().catch(() => null);
    assert(createPayload?.layout === resolvedLayout, `Create payload should send resolved layout ${resolvedLayout}, got ${createPayload?.layout}`);
    assert(createPayload?.sources?.[0]?.figureId === 'fig_2' && createPayload?.sources?.[1]?.figureId === 'fig_1', 'Create payload did not preserve UI source order');
    assert(errors.length === 0 && failedResponses.length === 0, `Browser errors: ${errors.join(' | ')}. Failed responses: ${failedResponses.join(' | ')}`);
    console.log(JSON.stringify({ status: 'PASS', resolvedLayout, orderedSources: createPayload.sources.map(source => `${source.projectId}:${source.figureId}`) }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
