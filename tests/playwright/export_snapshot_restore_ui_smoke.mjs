import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const thumbnail = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="white"/><path d="M40 145L120 80L210 110L280 35" fill="none" stroke="#176b5b" stroke-width="5"/></svg>';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('scifigure:auth-token', 'restore-ui-token');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    let restoreRequested = false;
    let projectReloaded = false;
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'restore-user', email: 'restore@example.test' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const authorization = await request.headerValue('authorization');
      assert(authorization === 'Bearer restore-ui-token', `missing access token for ${url.pathname}`);

      if (url.pathname === '/api/auth/me') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', user: { id: 'restore-user', email: 'restore@example.test' }, license: { status: 'free' } }),
        });
      }

      if (url.pathname === '/api/export-assets' && request.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            assets: [{
              assetId: 'exp_restore',
              projectId: 'project_restore',
              projectName: '恢复测试项目',
              figureId: 'fig_2',
              name: 'Figure 2 导出状态',
              format: 'svg',
              dpi: null,
              filePath: 'figure.svg',
              thumbnailSvg: thumbnail,
              metadata: {},
              tags: ['figure'],
              createdAt: '2026-07-16 10:00:00',
              sizeBytes: 2048,
              fileExists: true,
              hasEditingSnapshot: true,
            }],
          }),
        });
      }
      if (url.pathname === '/api/projects/project_restore/export-assets/exp_restore/restore' && request.method() === 'POST') {
        restoreRequested = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            projectId: 'project_restore',
            targetFigureId: 'fig_2',
            capturedAt: '2026-07-16T10:00:00.000Z',
            restoredRevisions: { fig_1: 4, fig_2: 7 },
            message: 'restored',
          }),
        });
      }
      if (url.pathname === '/api/projects/project_restore' && request.method() === 'GET') {
        projectReloaded = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            project: {
              projectId: 'project_restore',
              name: '恢复测试项目',
              spec: JSON.stringify({ plot_type: 'custom', custom_script: '', script_language: 'python' }),
              script: '',
              datasets: [],
              figures: [
                { figureId: 'fig_1', index: 0, editLog: [], revision: 4, history: { past: [], future: [] } },
                { figureId: 'fig_2', index: 1, editLog: [], revision: 7, history: { past: [], future: [] } },
              ],
            },
          }),
        });
      }
      if (url.pathname.endsWith('/export-assets') && request.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', assets: [] }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', projects: [] }) });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '历史导出资产' }).click();
    await page.getByRole('heading', { name: '导出资产库' }).waitFor();
    await page.getByRole('button', { name: '恢复此状态' }).click();
    await page.getByText('恢复测试项目', { exact: true }).first().waitFor();
    await page.getByText('代码面板', { exact: true }).waitFor();

    assert(restoreRequested, 'restore button did not call the snapshot restore API');
    assert(projectReloaded, 'successful restore did not reload the authoritative project state');

    const pendingDraftSpec = {
      plot_type: 'custom',
      custom_script: '',
      script_language: 'python',
      figure: { width: 100, height: 80, unit: 'mm', dpi: 300 },
    };
    await page.addInitScript((state) => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(state));
    }, {
      spec: pendingDraftSpec,
      history: [pendingDraftSpec],
      historyIndex: 0,
      projectId: 'project_restore',
      projectName: '恢复测试项目',
      figSession: null,
      renderLog: [],
      projectFigures: {},
      activeFigureId: 'fig_1',
      selectedFigureIds: [],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {
        fig_1: {},
        fig_2: {
          'title.1:fontsize': { op: 'set', gid: 'title.1', prop: 'fontsize', value: 18, mode: 'backend_patch' },
        },
      },
      currentView: 'export_settings',
      subView: 'home',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const saveAllButton = page.getByRole('button', { name: '保存全部 Figure 到图库' });
    await saveAllButton.waitFor();
    assert(await saveAllButton.isDisabled(), 'save-all should be disabled while any Figure has pending drafts');
    await page.getByText('项目还有 1 项未应用修改，应用后才能保存全部 Figure。', { exact: true }).waitFor();

    console.log('PASS export library restore action confirms, restores, and reloads the target project');
    console.log('PASS save-all export blocks pending drafts from every Figure');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
