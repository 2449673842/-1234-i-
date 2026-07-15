import { chromium } from 'playwright';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://127.0.0.1:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const token = await authenticateCapabilitySmokeUser(BASE_URL, 'project-create-real-import');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installBrowserAuthentication(context, token);
  await context.addInitScript(() => {
    sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      currentView: 'project_create',
      subView: 'home',
    }));
  });
  const page = await context.newPage();
  const errors = [];
  let projectId = '';

  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/vite|WebSocket/i.test(message.text())) errors.push(message.text());
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('heading', { name: '新建图形项目' }).waitFor();

    const projectName = `Real safe import ${Date.now()}`;
    await page.getByPlaceholder('输入项目名称').fill(projectName);
    const rows = Array.from({ length: 150 }, (_, index) => `${index + 1},${index * 3}`).join('\n');
    await page.locator('input[type="file"][multiple][accept*=".csv"]').first().setInputFiles({
      name: 'real_measurements.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`sample,value\n${rows}\n`),
    });
    await page.getByText('分析前 100 行样本', { exact: true }).waitFor();

    const createResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/projects' && response.request().method() === 'POST';
    });
    const updateResponsePromise = page.waitForResponse(response => (
      /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'PUT'
    ));
    await page.getByRole('button', { name: '创建项目并进入编辑器' }).click();

    const createResponse = await createResponsePromise;
    const created = await createResponse.json().catch(() => null);
    assert(createResponse.ok() && created?.id, `Real project create failed: ${createResponse.status()} ${JSON.stringify(created)}`);
    projectId = created.id;
    const updateResponse = await updateResponsePromise;
    const updated = await updateResponse.json().catch(() => null);
    assert(updateResponse.ok() && updated?.status === 'success', `Real project update failed: ${updateResponse.status()} ${JSON.stringify(updated)}`);

    const loadedResponse = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
      headers: bearerHeaders(token),
    });
    const loaded = await loadedResponse.json().catch(() => null);
    assert(loadedResponse.ok && loaded?.project, `Real project reload failed: ${loadedResponse.status} ${JSON.stringify(loaded)}`);
    const spec = typeof loaded.project.spec === 'string' ? JSON.parse(loaded.project.spec) : loaded.project.spec;
    assert(!spec?.raw_data, 'Real project flow must not persist browser-parsed raw_data');
    assert(spec?.source?.row_count === 150, `Real project flow must persist the server row count: ${JSON.stringify(spec?.source)}`);
    assert(spec?.source?.preview_rows_analyzed === 100, 'Real project flow must use a bounded server preview for field inference');
    assert(loaded.project.datasets?.length === 1, `Real project flow must register one data file: ${JSON.stringify(loaded.project.datasets)}`);
    assert(loaded.project.datasets[0].rowCount === 150, 'Registered dataset row count must come from server inspection');
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

    console.log(JSON.stringify({
      status: 'PASS',
      baseUrl: BASE_URL,
      projectId,
      browserSampleRows: 100,
      serverVerifiedRows: spec.source.row_count,
      rawDataPersisted: false,
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
    if (projectId) {
      await fetch(`${BASE_URL}/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: bearerHeaders(token),
      }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
