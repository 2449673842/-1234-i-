import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installAnonymousAuthRoutes(page) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'anonymous', user: null, license: { status: 'free' } }),
  }));
  await page.route('**/api/auth/refresh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', message: 'no test refresh session' }),
  }));
}

async function verifyHeader(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  try {
    await installAnonymousAuthRoutes(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    const header = page.locator('header');
    const targets = [
      header.locator('[aria-label="SciFigure Studio"]'),
      header.getByRole('button', { name: '帮助中心', exact: true }),
      header.getByRole('button', { name: '登录', exact: true }),
      header.getByRole('button', { name: '免费注册', exact: true }),
    ];
    await targets[3].waitFor();

    const boxes = [];
    for (const target of targets) {
      assert(await target.isVisible(), `Header target is hidden at ${viewport.width}px`);
      const box = await target.boundingBox();
      assert(box, `Header target has no layout box at ${viewport.width}px`);
      boxes.push(box);
    }

    for (const box of boxes) {
      assert(box.x >= 0 && box.x + box.width <= viewport.width + 0.5, `Header target overflows ${viewport.width}px viewport: ${JSON.stringify(box)}`);
    }
    for (let index = 0; index < boxes.length - 1; index += 1) {
      assert(boxes[index].x + boxes[index].width <= boxes[index + 1].x + 0.5, `Header targets overlap at ${viewport.width}px: ${JSON.stringify(boxes)}`);
    }

    const headerMetrics = await header.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert(headerMetrics.scrollWidth <= headerMetrics.clientWidth + 1, `Header overflows horizontally at ${viewport.width}px: ${JSON.stringify(headerMetrics)}`);
    return boxes;
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const compactMobile = await verifyHeader(browser, { width: 320, height: 720 });
    const mobile = await verifyHeader(browser, { width: 390, height: 844 });
    const desktop = await verifyHeader(browser, { width: 1440, height: 900 });
    console.log(JSON.stringify({ status: 'PASS', baseUrl: BASE_URL, compactMobile, mobile, desktop }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
