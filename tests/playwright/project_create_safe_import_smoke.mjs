import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://127.0.0.1:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferredWorkbookFixture(seed) {
  const entries = [
    { name: '[Content_Types].xml', compressedSize: 0, uncompressedSize: 0 },
    { name: 'xl/workbook.xml', compressedSize: 0, uncompressedSize: 0 },
    { name: `xl/worksheets/sheet${seed}.xml`, compressedSize: 400_000, uncompressedSize: 40 * 1024 * 1024 },
    { name: `xl/sharedStrings${seed}.xml`, compressedSize: 300_000, uncompressedSize: 30 * 1024 * 1024 },
  ];
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.compressedSize === entry.uncompressedSize ? 0 : 8;
    const local = Buffer.alloc(30 + name.length + entry.compressedSize);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let createPayload = null;
  let updatePayload = null;
  let uploadCount = 0;

  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/vite|WebSocket/i.test(message.text())) errors.push(message.text());
  });

  try {
    await page.addInitScript(() => {
      sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({ currentView: 'project_create', subView: 'home' }));
      const originalArrayBuffer = File.prototype.arrayBuffer;
      window.__scifigureWorkbookReads = { active: 0, maxActive: 0, total: 0 };
      File.prototype.arrayBuffer = async function patchedArrayBuffer() {
        const state = window.__scifigureWorkbookReads;
        state.active += 1;
        state.total += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise(resolve => setTimeout(resolve, 80));
        try {
          return await originalArrayBuffer.call(this);
        } finally {
          state.active -= 1;
        }
      };
    });
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        user: { id: 'safe-import-user', email: 'safe-import@example.test' },
        license: { status: 'free' },
      }),
    }));
    await page.route('**/api/auth/refresh', route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'no refresh session' }),
    }));
    await page.route('**/api/projects/safe-import-project/files/dataset-deferred-a/preview?limit=100', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        rows: Array.from({ length: 100 }, (_, index) => ({ category: `G${index % 4}`, value: index * 3 })),
        returnedRows: 100,
        totalRows: 150,
        limit: 100,
      }),
    }));
    await page.route('**/api/projects/safe-import-project/files', async route => {
      if (route.request().method() === 'POST') {
        uploadCount += 1;
        const fixtures = [
          { fileId: 'dataset-deferred-a', fileName: 'deferred_a.xlsx', columns: ['category', 'value'], rowCount: 150 },
          { fileId: 'dataset-deferred-b', fileName: 'deferred_b.xlsx', columns: ['group', 'score'], rowCount: 2 },
          { fileId: 'dataset-safe', fileName: 'measurements.csv', columns: ['sample', 'value'], rowCount: 150 },
        ];
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', ...fixtures[uploadCount - 1] }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', datasets: [] }) });
    });
    await page.route('**/api/projects/safe-import-project', async route => {
      const method = route.request().method();
      if (method === 'PUT') {
        updatePayload = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' }) });
      }
      if (method === 'DELETE') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success' }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          project: {
            id: 'safe-import-project',
            name: 'Safe import fixture',
            spec: updatePayload?.spec || {},
            script: updatePayload?.spec?.custom_script || '',
            datasets: [],
            figures: [],
          },
        }),
      });
    });
    await page.route('**/api/projects', async route => {
      if (route.request().method() === 'POST') {
        createPayload = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', id: 'safe-import-project' }) });
      }
      return route.continue();
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('heading', { name: '新建图形项目' }).waitFor();
    const dataInput = page.locator('input[type="file"][multiple][accept*=".csv"]').first();
    await dataInput.setInputFiles({
      name: 'deferred_a.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: deferredWorkbookFixture(1),
    });
    await page.waitForFunction(() => window.__scifigureWorkbookReads?.active === 1);
    await dataInput.setInputFiles({
      name: 'deferred_b.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: deferredWorkbookFixture(2),
    });
    const rows = Array.from({ length: 150 }, (_, index) => `${index + 1},${index * 3}`).join('\n');
    await dataInput.setInputFiles({
      name: 'measurements.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`sample,value\n${rows}\n`),
    });
    await page.getByText('deferred_a.xlsx', { exact: true }).first().waitFor();
    await page.getByText('deferred_b.xlsx', { exact: true }).first().waitFor();
    await page.getByText(/工作簿超过浏览器安全预览预算/).first().waitFor();
    await page.getByText('分析前 100 行样本', { exact: true }).waitFor();
    const workbookReads = await page.evaluate(() => window.__scifigureWorkbookReads);
    assert(workbookReads.total === 2, `Each selected workbook should be read once, got ${JSON.stringify(workbookReads)}`);
    assert(workbookReads.maxActive === 1, `Workbook parsing must remain single-concurrency, got ${JSON.stringify(workbookReads)}`);
    const boundedPrompt = await page.locator('textarea[readonly]').last().inputValue();
    assert(boundedPrompt.includes('100 个非空值'), 'Browser prompt statistics must include exactly the bounded 100-row sample');
    assert(!boundedPrompt.includes('150 个非空值'), 'Browser prompt must not analyze rows beyond the 100-row sample');
    const createButton = page.getByRole('button', { name: '创建项目并进入编辑器' });
    await createButton.waitFor();
    await createButton.click();
    const deadline = Date.now() + 10_000;
    while (!updatePayload && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));

    assert(createPayload, 'Project create request was not sent');
    assert(updatePayload, 'Project update request was not sent');
    assert(!('raw_data' in createPayload.spec), 'Initial project spec must not persist browser-parsed rows');
    assert(!('raw_data' in updatePayload.spec), 'Updated project spec must not persist browser-parsed rows');
    assert(updatePayload.spec.source.row_count === 150, `Server row count was not written back: ${JSON.stringify(updatePayload.spec.source)}`);
    assert(updatePayload.spec.source.preview_rows_analyzed === 100, 'Project metadata must record the bounded browser sample size');
    assert(updatePayload.spec.data.x === 'category' && updatePayload.spec.data.y === 'value', `Deferred workbook mapping must come from the server preview: ${JSON.stringify(updatePayload.spec.data)}`);
    assert(uploadCount === 3, `Each selected file should upload exactly once, got ${uploadCount}`);
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);

    console.log(JSON.stringify({
      status: 'PASS',
      baseUrl: BASE_URL,
      browserSampleRows: 100,
      serverVerifiedRows: updatePayload.spec.source.row_count,
      workbookReads,
      rawDataPersisted: false,
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
