import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const thumbnail = color => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="white"/><rect x="35" y="25" width="250" height="120" fill="${color}" opacity="0.22"/><path d="M35 145H285M35 25V145" stroke="#263b36" stroke-width="3"/></svg>`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.setItem('scifigure:auth-token', 'asset-smoke-token');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => {
      if (!/\[vite\]|WebSocket/i.test(error.message)) errors.push(error.message);
    });
    page.on('console', message => {
      if (message.type() === 'error' && !/\[vite\]|WebSocket/i.test(message.text())) errors.push(message.text());
    });
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'asset-smoke-user', email: 'asset@example.test' } }),
    }));
    await page.route('**/api/export-assets', async route => {
      assert(
        (await route.request().headerValue('authorization')) === 'Bearer asset-smoke-token',
        'Export asset library request did not include the access token',
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          assets: [
            { assetId: 'exp_a', projectId: 'project_a', projectName: '项目甲', figureId: 'fig_1', name: '项目甲 Figure 1', format: 'png', dpi: 300, filePath: 'a.png', thumbnailSvg: thumbnail('#176b5b'), metadata: {}, tags: [], createdAt: '2026-07-10 10:00:00', sizeBytes: 20480, fileExists: true },
            { assetId: 'exp_b', projectId: 'project_b', projectName: '项目乙', figureId: 'fig_2', name: '项目乙 Figure 2', format: 'svg', dpi: null, filePath: 'b.svg', thumbnailSvg: thumbnail('#c9a227'), metadata: {}, tags: [], createdAt: '2026-07-09 10:00:00', sizeBytes: 10240, fileExists: true },
          ],
        }),
      });
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '历史导出资产' }).click();
    await page.getByRole('heading', { name: '导出资产库' }).waitFor();
    assert(await page.getByText('项目甲 Figure 1').isVisible(), 'First project asset is missing');
    assert(await page.getByText('项目乙 Figure 2').isVisible(), 'Second project asset is missing');
    const projectFilter = page.getByLabel('按来源项目筛选');
    await projectFilter.selectOption('project_a');
    assert(await page.getByText('项目甲 Figure 1').isVisible(), 'Selected project asset disappeared');
    assert(await page.getByText('项目乙 Figure 2').count() === 0, 'Project filter did not hide other project assets');
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
