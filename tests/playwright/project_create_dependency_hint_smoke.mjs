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
        user: { id: 'dependency-hint-user', email: 'dependency-hint@example.test' },
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

    const script = [
      'import pandas as pd',
      'data_path = choose_input_table()',
      'df = pd.read_csv(data_path)',
      'ax = df.plot(x=df.columns[0], y=df.columns[1])',
    ].join('\n');
    const editor = page.getByPlaceholder('粘贴或编写 Python/R 脚本，或拖入 .py / .R 文件');
    await editor.fill(script);

    const genericHint = page.getByText('没有识别到固定数据文件名', { exact: true });
    await genericHint.waitFor();
    await page.getByText(/脚本可能通过变量或动态路径读取数据/).waitFor();
    await page.getByText(/额外表格同样会保留并进入 AI 数据上下文/).waitFor();
    const hintMetrics = await genericHint.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        color: style.color,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });

    const dataInput = page.locator('input[type="file"][multiple][accept*=".csv"]').first();
    await dataInput.setInputFiles([
      {
        name: 'extra_measurements.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('sample,value\nA,1\nB,2\n'),
      },
      {
        name: 'additional_metadata.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('sample,group\nA,control\nB,treatment\n'),
      },
    ]);

    await page.getByText('extra_measurements.csv', { exact: true }).first().waitFor();
    await page.getByText('additional_metadata.csv', { exact: true }).first().waitFor();
    const importedNameCounts = {
      extraMeasurements: await page.getByText('extra_measurements.csv', { exact: true }).count(),
      additionalMetadata: await page.getByText('additional_metadata.csv', { exact: true }).count(),
    };
    const unrestrictedLabelVisible = await page.getByText('仅提示，不限制额外上传', { exact: true }).isVisible();

    assert(unrestrictedLabelVisible, 'The dependency panel does not explain that extra uploads remain allowed');
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

    console.log(JSON.stringify({
      status: 'PASS',
      baseUrl: BASE_URL,
      fixedDependencies: 0,
      genericHint: await genericHint.textContent(),
      hintMetrics,
      extraFilesAccepted: ['extra_measurements.csv', 'additional_metadata.csv'],
      unrestrictedLabelVisible,
      importedNameCounts,
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
