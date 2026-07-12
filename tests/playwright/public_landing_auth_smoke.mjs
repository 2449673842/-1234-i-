import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => {
      if (!/\[vite\]|WebSocket/i.test(error.message)) errors.push(error.message);
    });
    page.on('console', message => {
      const text = message.text();
      if (message.type() === 'error' && !/\[vite\]|WebSocket/i.test(text)) errors.push(text);
    });

    let authenticated = false;
    await page.route('**/api/auth/me', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(authenticated
          ? { status: 'success', user: { id: 'ui-smoke-user', email: 'ui-smoke@example.test' }, license: { status: 'free' } }
          : { status: 'anonymous', user: null, license: { status: 'free' } }),
      });
    });
    await page.route('**/api/auth/refresh', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'no test refresh session' }),
    }));
    await page.route('**/api/auth/register', async route => {
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          token: 'public-landing-smoke-token',
          user: { id: 'ui-smoke-user', email: 'ui-smoke@example.test', displayName: 'UI Smoke' },
          license: { status: 'free', isPro: false },
        }),
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).waitFor();
    assert(await page.getByText('SciFigure Studio', { exact: true }).first().isVisible(), 'Public landing brand is not visible');
    assert(await page.getByRole('button', { name: '项目与资源' }).count() === 0, 'Anonymous visitor can see authenticated navigation');

    const revealTarget = page.locator('[data-landing-reveal]').nth(2);
    await revealTarget.scrollIntoViewIfNeeded();
    await page.waitForFunction(element => element?.getAttribute('data-visible') === 'true', await revealTarget.elementHandle());
    await page.locator('.landing-page').evaluate(element => { element.scrollTop = 0; });
    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).waitFor();

    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).click();
    await page.getByLabel('昵称').fill('UI Smoke');
    await page.getByLabel('邮箱').fill('ui-smoke@example.test');
    await page.getByLabel('密码', { exact: true }).fill('Public-Landing-Smoke-2026');
    await page.getByLabel('确认密码').fill('Public-Landing-Smoke-2026');
    await page.getByRole('button', { name: '注册并进入平台' }).click();

    await page.getByRole('button', { name: '项目与资源' }).waitFor();
    assert(await page.getByRole('button', { name: '新建图形项目' }).isVisible(), 'Authenticated workspace did not open after registration');
    assert(await page.evaluate(() => window.localStorage.getItem('scifigure:auth-token')) === 'public-landing-smoke-token', 'Access token was not persisted');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '项目与资源' }).waitFor();

    await page.getByRole('button', { name: '账号设置' }).click();
    await page.getByRole('button', { name: '退出登录' }).waitFor();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '项目与资源' }).count() === 0, 'Workspace navigation remains visible after logout');
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
