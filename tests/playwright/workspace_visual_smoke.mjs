import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.resolve('output', 'playwright', `workspace-visual-${RUN_ID}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installRoutes(page) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'workspace-visual-user', email: 'workspace-visual@example.test' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/projects**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', projects: [], assets: [] }),
  }));
}

async function verifyViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/vite|WebSocket/i.test(message.text())) errors.push(message.text());
  });
  await installRoutes(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '继续你的科研 Figure 工作流' }).waitFor();

  const metrics = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert(metrics.documentWidth <= metrics.viewportWidth + 1, `${name} document overflows horizontally: ${JSON.stringify(metrics)}`);
  assert(metrics.bodyWidth <= metrics.viewportWidth + 1, `${name} body overflows horizontally: ${JSON.stringify(metrics)}`);
  assert(errors.length === 0, `${name} browser errors: ${errors.join(' | ')}`);

  await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), fullPage: true });
  await context.close();
  return metrics;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await verifyViewport(browser, 'desktop-1440x960', { width: 1440, height: 960 });
    const mobile = await verifyViewport(browser, 'mobile-390x844', { width: 390, height: 844 });
    console.log(JSON.stringify({ status: 'PASS', outputDir: OUTPUT_DIR, desktop, mobile }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
