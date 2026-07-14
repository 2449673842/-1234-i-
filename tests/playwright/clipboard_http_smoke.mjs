import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://127.0.0.1:3000';
const REAL_HTTP_CLIPBOARD = process.env.SCIFIGURE_REAL_HTTP_CLIPBOARD === '1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installAuthRoutes(page) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'clipboard-http-smoke', email: 'clipboard@example.test' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/auth/refresh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', message: 'no smoke refresh session' }),
  }));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(15_000);

  try {
    await page.addInitScript(() => {
      sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
        currentView: 'project_create',
        subView: 'home',
      }));
    });
    if (!REAL_HTTP_CLIPBOARD) {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'clipboard', {
          configurable: true,
          get: () => undefined,
        });
        Object.defineProperty(Document.prototype, 'execCommand', {
          configurable: true,
          value(command) {
            if (command !== 'copy') return false;
            globalThis.__legacyClipboardText = String(document.activeElement?.value || '');
            return true;
          },
        });
      });
    }
    await installAuthRoutes(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('heading', { name: '新建图形项目' }).waitFor();

    await page.locator('input[accept=".py,.r,.R"]').first().setInputFiles({
      name: 'figure.R',
      mimeType: 'text/plain',
      buffer: Buffer.from([
        'library(ggplot2)',
        'df <- as.data.frame(uploaded_data)',
        'ggplot(df, aes(x = x, y = y)) + geom_point()',
      ].join('\n')),
    });

    await page.getByRole('button', { name: '复制 AI 提示词', exact: true }).click();
    await page.getByText('已复制 ✓', { exact: true }).waitFor({ timeout: 5_000 });
    let copiedText;
    if (REAL_HTTP_CLIPBOARD) {
      const secureContext = await page.evaluate(() => globalThis.isSecureContext);
      assert(secureContext === false, `Expected a real insecure HTTP context, got isSecureContext=${secureContext}`);
      await page.evaluate(() => {
        const textarea = document.createElement('textarea');
        textarea.id = 'clipboard-http-paste-target';
        document.body.appendChild(textarea);
        textarea.focus();
      });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      copiedText = await page.locator('#clipboard-http-paste-target').inputValue();
    } else {
      copiedText = await page.evaluate(() => globalThis.__legacyClipboardText || '');
    }

    assert(copiedText.includes('library(ggplot2)'), 'Copied AI prompt does not contain the uploaded R script');
    assert(copiedText.includes('uploaded_data'), 'Copied AI prompt is missing the platform R data contract');
    assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(' | ')}`);
    console.log(JSON.stringify({
      status: 'PASS',
      baseUrl: BASE_URL,
      mode: REAL_HTTP_CLIPBOARD ? 'real-insecure-http' : 'forced-fallback',
      copiedCharacters: copiedText.length,
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', baseUrl: BASE_URL, message: error.message }, null, 2));
  process.exitCode = 1;
});
