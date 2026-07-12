import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const OUTPUT_DIR = 'output/playwright/help-center';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installAuthRoutes(page, authenticated) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(authenticated
      ? { status: 'success', user: { id: 'help-smoke-user', email: 'help@example.test' }, license: { status: 'free' } }
      : { status: 'anonymous', user: null, license: { status: 'free' } }),
  }));
  await page.route('**/api/auth/refresh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', message: 'no smoke refresh session' }),
  }));
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert(overflow.body <= 1 && overflow.root <= 1, `Horizontal overflow detected: ${JSON.stringify(overflow)}`);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const publicContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1440, height: 1000 } });
    const publicPage = await publicContext.newPage();
    publicPage.setDefaultTimeout(15_000);
    publicPage.on('pageerror', error => errors.push(error.message));
    publicPage.on('console', message => {
      if (message.type() === 'error' && !/\[vite\]|WebSocket/i.test(message.text())) errors.push(message.text());
    });
    await installAuthRoutes(publicPage, false);
    await publicPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await publicPage.getByRole('button', { name: '帮助中心', exact: true }).click();
    await publicPage.getByRole('heading', { name: /从第一段代码到/ }).waitFor();
    assert(await publicPage.getByRole('button', { name: '返回官网', exact: true }).isVisible(), 'Public help page has no explicit return-to-site action');
    assert(await publicPage.getByText('Scientific figure handbook', { exact: true }).isVisible(), 'Public help hero is missing');
    await publicPage.getByText('模板不是边界', { exact: true }).waitFor();
    assert(await publicPage.getByText(/只要 Python 或 R 脚本能正常生成 Figure/).isVisible(), 'Template capability boundary statement is missing');
    assert(await publicPage.getByText('已经有脚本和数据', { exact: true }).isVisible(), 'Ready-script quick-start path is missing');
    assert(await publicPage.getByText('想直接开始画图', { exact: true }).isVisible(), 'Template-first quick-start path is missing');

    const templateTitles = [
      '分组柱状图 + 误差棒',
      '散点回归',
      '热图 + 色条',
      '箱线图 + 抖动散点',
      '多组时间序列',
      '森林图',
      'PCA/PCoA 分组散点',
    ];
    for (const title of templateTitles) {
      await publicPage.getByRole('button', { name: new RegExp(title.replace(/[+/.]/g, '\\$&')) }).click();
      await publicPage.getByRole('tab', { name: '示例图' }).click();
      const image = publicPage.getByRole('img', { name: `${title}示例图` });
      await image.waitFor();
      const loaded = await image.evaluate(element => element.complete && element.naturalWidth > 0);
      assert(loaded, `Template image failed to load: ${title}`);
    }

    const search = publicPage.getByPlaceholder(/搜索：多文件/);
    await search.fill('色条');
    assert(await publicPage.getByRole('button', { name: /热图 \+ 色条/ }).isVisible(), 'Template search did not retain heatmap template');
    await search.fill('');

    await publicPage.getByRole('button', { name: /热图 \+ 色条/ }).click();
    await publicPage.getByLabel('模板内容').getByRole('tab', { name: 'Python' }).click();
    await publicPage.getByRole('button', { name: '复制代码' }).click();
    await publicPage.getByText('已复制', { exact: true }).waitFor();
    const clipboard = await publicPage.evaluate(() => navigator.clipboard.readText());
    assert(clipboard.includes('fig.colorbar'), 'Copied Python template is not the heatmap template');

    await publicPage.getByRole('button', { name: '复制 Python 提示词' }).click();
    const pythonPrompt = await publicPage.evaluate(() => navigator.clipboard.readText());
    assert(pythonPrompt.includes('_uploaded_data') && pythonPrompt.includes('_uploaded_file_paths'), 'Python public AI prompt is missing required runtime inputs');
    assert(!/semanticKey|instanceKey|GID|patch protocol|sandbox/i.test(pythonPrompt), 'Python public AI prompt exposes internal implementation details');
    await publicPage.getByLabel('AI 绘图提示词语言').getByRole('tab', { name: 'R', exact: true }).click();
    await publicPage.getByRole('button', { name: '复制 R 提示词' }).click();
    const rPrompt = await publicPage.evaluate(() => navigator.clipboard.readText());
    assert(rPrompt.includes('uploaded_file_paths') && rPrompt.includes('ggplot2'), 'R public AI prompt is missing required runtime inputs');
    await publicPage.waitForTimeout(350);
    await publicPage.screenshot({ path: `${OUTPUT_DIR}/ai-prompt.png` });

    await publicPage.getByRole('button', { name: '展开全部' }).click();
    const expandedCount = await publicPage.locator('article button[aria-expanded="true"]').count();
    assert(expandedCount >= 2, `FAQ accordion did not keep multiple entries open: ${expandedCount}`);
    await publicPage.waitForTimeout(750);
    await publicPage.screenshot({ path: `${OUTPUT_DIR}/desktop.png`, fullPage: true });
    await assertNoHorizontalOverflow(publicPage);
    await publicPage.reload({ waitUntil: 'domcontentloaded' });
    await publicPage.locator('header').getByRole('button', { name: '帮助中心', exact: true }).waitFor();
    assert(await publicPage.getByRole('heading', { name: /从第一段代码到/ }).count() === 0, 'Anonymous refresh remained on help instead of returning to the public landing page');
    await publicContext.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    await installAuthRoutes(mobilePage, false);
    await mobilePage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await mobilePage.getByRole('button', { name: '帮助中心', exact: true }).click();
    await mobilePage.getByRole('heading', { name: /从第一段代码到/ }).waitFor();
    await mobilePage.waitForTimeout(900);
    await assertNoHorizontalOverflow(mobilePage);
    await mobilePage.screenshot({ path: `${OUTPUT_DIR}/mobile.png`, fullPage: true });
    await mobilePage.getByText('已经有脚本和数据', { exact: true }).scrollIntoViewIfNeeded();
    await mobilePage.waitForTimeout(450);
    await assertNoHorizontalOverflow(mobilePage);
    await mobilePage.screenshot({ path: `${OUTPUT_DIR}/quick-start-mobile.png` });
    await mobileContext.close();

    const authContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const authPage = await authContext.newPage();
    await installAuthRoutes(authPage, true);
    await authPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await authPage.getByRole('button', { name: '帮助', exact: true }).click();
    await authPage.getByRole('button', { name: '返回工作区', exact: true }).waitFor();
    assert(await authPage.getByRole('button', { name: '免费注册' }).count() === 0, 'Authenticated help page shows public registration CTA');
    await authPage.getByRole('button', { name: '返回工作区', exact: true }).click();
    await authPage.getByRole('button', { name: '项目与资源' }).waitFor();
    await authContext.close();

    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
    console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL, screenshots: OUTPUT_DIR }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
