import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://127.0.0.1:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/vite|WebSocket/i.test(message.text())) errors.push(message.text());
  });

  try {
    await page.addInitScript(() => {
      sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
        currentView: 'project_create',
        subView: 'home',
      }));
    });
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        user: { id: 'script-drop-user', email: 'script-drop@example.test' },
        license: { status: 'free' },
      }),
    }));
    await page.route('**/api/auth/refresh', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'no refresh session' }),
    }));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('heading', { name: '新建图形项目' }).waitFor();
    const dropZone = page.getByLabel('脚本上传区域');
    await dropZone.waitFor();

    const script = [
      'library(ggplot2)',
      'stats <- read.csv("stats.csv")',
      'ggplot(stats, aes(x = x, y = y)) + geom_point()',
    ].join('\n');
    const dataTransfer = await page.evaluateHandle(({ contents }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([contents], 'analysis.R', { type: 'text/plain' }));
      return transfer;
    }, { contents: script });

    await dropZone.dispatchEvent('dragenter', { dataTransfer });
    await page.getByText('松开以上传 Python / R 绘图脚本', { exact: true }).waitFor();
    await dropZone.dispatchEvent('dragover', { dataTransfer });
    await dropZone.dispatchEvent('drop', { dataTransfer });

    await page.getByText('R / ggplot2', { exact: true }).first().waitFor();
    const editor = page.getByPlaceholder('粘贴或编写 Python/R 脚本，或拖入 .py / .R 文件');
    await page.waitForFunction(
      ({ expected }) => document.querySelector('textarea[placeholder*="粘贴或编写 Python/R 脚本"]')?.value === expected,
      { expected: script },
    );
    assert(await editor.inputValue() === script, 'Dropped R script did not populate the script editor');
    await page.getByText('stats.csv', { exact: false }).first().waitFor();
    await page.getByText('待上传', { exact: true }).waitFor();
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

    await page.screenshot({ path: 'output/playwright/project-create-script-drop.png', fullPage: true });
    console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL, scriptLanguage: 'r', dependency: 'stats.csv' }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
