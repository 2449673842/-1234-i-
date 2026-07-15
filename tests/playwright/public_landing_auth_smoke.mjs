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
      const body = route.request().postDataJSON();
      if (body.email === 'direct-registration@example.test') {
        authenticated = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            token: 'direct-registration-smoke-token',
            user: { id: 'direct-registration-user', email: body.email, displayName: 'Direct Registration' },
            license: { status: 'free', isPro: false },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          verificationRequired: true,
          verification: {
            challengeId: 'evc_12345678-1234-1234-1234-123456789abc',
            maskedEmail: 'ui******@example.test',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        }),
      });
    });
    await page.route('**/api/auth/verify-email', async route => {
      const body = route.request().postDataJSON();
      assert(
        body.challengeId === 'evc_12345678-1234-1234-1234-123456789abc'
          && body.code === '123456'
          && body.password === 'Public-Landing-Smoke-2026',
        `Unexpected verification payload: ${JSON.stringify(body)}`,
      );
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          token: 'public-landing-smoke-token',
          user: { id: 'ui-smoke-user', email: 'ui-smoke@example.test', displayName: 'UI Smoke', emailVerified: true },
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
    assert(await page.getByText('填写账号信息，完成注册后即可进入工作区。', { exact: true }).isVisible(), 'Registration guidance is not neutral');
    assert(await page.getByText('注册免费账号后，验证邮箱即可进入工作区。', { exact: true }).count() === 0, 'Registration guidance still promises email verification');
    assert(await page.getByRole('button', { name: '注册并发送验证码', exact: true }).count() === 0, 'Registration action still promises a verification email');
    await page.getByLabel('昵称').fill('UI Smoke');
    await page.getByLabel('邮箱').fill('ui-smoke@example.test');
    await page.getByLabel('密码', { exact: true }).fill('Public-Landing-Smoke-2026');
    await page.getByLabel('确认密码').fill('Public-Landing-Smoke-2026');
    await page.getByRole('button', { name: '注册并继续' }).click();
    await page.getByLabel('邮箱验证码').fill('123456');
    await page.getByRole('button', { name: '验证并进入平台' }).click();

    await page.getByRole('button', { name: '项目与资源' }).waitFor();
    assert(await page.getByRole('button', { name: '新建图形项目' }).isVisible(), 'Authenticated workspace did not open after registration');
    const tokenStorage = await page.evaluate(() => ({
      local: window.localStorage.getItem('scifigure:auth-token'),
      session: window.sessionStorage.getItem('scifigure:auth-token'),
    }));
    assert(tokenStorage.local === null && tokenStorage.session === 'public-landing-smoke-token', 'Access token was not migrated to session-only storage');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '项目与资源' }).waitFor();

    await page.getByRole('button', { name: '账号设置' }).click();
    await page.getByRole('button', { name: '退出登录' }).waitFor();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '项目与资源' }).count() === 0, 'Workspace navigation remains visible after logout');

    await page.locator('header').getByRole('button', { name: '免费注册', exact: true }).click();
    await page.getByLabel('昵称').fill('Direct Registration');
    await page.getByLabel('邮箱').fill('direct-registration@example.test');
    await page.getByLabel('密码', { exact: true }).fill('Direct-Registration-Smoke-2026');
    await page.getByLabel('确认密码').fill('Direct-Registration-Smoke-2026');
    await page.getByRole('button', { name: '注册并继续' }).click();
    await page.getByRole('button', { name: '项目与资源' }).waitFor();
    assert(await page.getByLabel('邮箱验证码').count() === 0, 'Direct registration unexpectedly opened the verification step');
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
