import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixture() {
  const script = `import pandas as pd
import matplotlib.pyplot as plt
stats = pd.read_csv(_uploaded_file_paths["stats.csv"])
fig, ax = plt.subplots()
ax.plot(stats["x"], stats["y"])
`;
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects: [{
      id: 'title.0',
      kind: 'text',
      label: 'Navigation fixture',
      role: 'axes_title',
      editable: ['text'],
      currentProps: { text: 'Navigation fixture', fontsize: 12 },
    }],
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  return {
    spec: {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'python',
      figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
    },
    history: [],
    historyIndex: 0,
    projectId: 'navigation-reconfigure-fixture',
    projectName: 'Navigation reconfigure fixture',
    projectFigures: {
      fig_1: {
        figureId: 'fig_1',
        index: 0,
        manifest,
        editLog: [],
        revision: 1,
        renderStatus: 'success',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="20" y="20" width="360" height="220" fill="white" stroke="black"/><text id="title.0" data-fig-id="title.0" x="120" y="45">Navigation fixture</text></svg>',
      },
    },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [{ datasetId: 'dataset-stats', fileName: 'stats.csv', filePath: 'fixture/stats.csv' }],
    selectedGids: [],
    projectHistory: {},
    projectDrafts: {},
    renderLog: ['> navigation fixture'],
    currentView: 'editor',
    subView: 'home',
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 960 } });
    await context.addInitScript(value => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
    }, fixture());
    const page = await context.newPage();
    const errors = [];
    const appliedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !/vite|WebSocket/i.test(message.text())) errors.push(message.text());
    });
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'navigation-user' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/projects/navigation-reconfigure-fixture/export-assets', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', assets: [] }),
    }));
    await page.route('**/api/projects/navigation-reconfigure-fixture/files', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', datasets: fixture().datasets }),
    }));
    await page.route('**/api/projects/navigation-reconfigure-fixture/figures/render', async route => {
      appliedRequests.push({ type: 'render', body: route.request().postDataJSON() });
      const figure = fixture().projectFigures.fig_1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', figures: [figure] }),
      });
    });
    await page.route(`${BASE_URL}/api/projects/navigation-reconfigure-fixture`, async route => {
      if (route.request().method() === 'PUT') {
        appliedRequests.push({ type: 'save', body: route.request().postDataJSON() });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', project: fixture() }) });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByText('Navigation reconfigure fixture', { exact: true }).waitFor();

    await page.getByRole('button', { name: '历史导出资产' }).click();
    await page.getByRole('heading', { name: '导出资产库' }).waitFor();
    await page.getByRole('button', { name: '返回上一页' }).click();
    await page.getByText('Navigation reconfigure fixture', { exact: true }).waitFor();
    assert(await page.getByText('预览', { exact: true }).first().isVisible(), 'Export library did not return to the editor origin');

    await page.getByRole('button', { name: '重新配置' }).click();
    await page.getByRole('heading', { name: '重新配置 Navigation reconfigure fixture' }).waitFor();
    assert(await page.getByText('stats.csv', { exact: true }).count() >= 2, 'Existing/referenced data file was not shown');
    assert(await page.getByText('已提供', { exact: true }).isVisible(), 'Referenced file was not marked as supplied');
    const scriptEditor = page.locator('textarea').first();
    assert((await scriptEditor.inputValue()).includes('_uploaded_file_paths["stats.csv"]'), 'Current script was not preserved');
    await page.screenshot({ path: 'output/playwright/navigation-reconfigure.png', fullPage: true });

    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('Navigation reconfigure fixture', { exact: true }).waitFor();
    assert(await page.getByText('预览', { exact: true }).first().isVisible(), 'Cancel did not return to editor');

    await page.getByRole('button', { name: '重新配置' }).click();
    await page.getByRole('heading', { name: '重新配置 Navigation reconfigure fixture' }).waitFor();
    const appliedScript = `${await page.locator('textarea').first().inputValue()}\n# reconfigure-smoke`;
    await page.locator('textarea').first().fill(appliedScript);
    await page.getByRole('button', { name: '应用配置并重新渲染' }).click();
    await page.getByText('Navigation reconfigure fixture', { exact: true }).waitFor();
    const saveRequest = appliedRequests.find(request => request.type === 'save');
    const renderRequest = appliedRequests.find(request => request.type === 'render');
    assert(saveRequest?.body?.spec?.custom_script === appliedScript, 'Reconfigure did not persist the edited script');
    assert(Array.isArray(saveRequest?.body?.figures) && saveRequest.body.figures.length === 1, 'Reconfigure did not preserve figure history payload');
    assert(renderRequest?.body?.script === appliedScript, 'Reconfigure did not render the applied script');
    assert(renderRequest?.body?.language === 'python', 'Reconfigure lost the script language');
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
