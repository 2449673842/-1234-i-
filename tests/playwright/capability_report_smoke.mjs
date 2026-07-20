import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || '';
const APP_STATE_KEY = 'scifigure:app-state:v2';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run through the isolated server wrapper');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');
}

function capability(prop) {
  return {
    prop,
    patchMode: 'local_patch',
    scopes: ['object'],
    preview: 'exact',
    replay: 'stable',
  };
}

function makeObject({ id, kind, label, editable = [], currentProps = {}, unsupportedReason, semanticCoverage }) {
  return {
    id,
    kind,
    label,
    subplotId: 'subplot.0',
    editable,
    propertyCapabilities: editable.map(capability),
    currentProps: {
      ...currentProps,
      ...(unsupportedReason ? { unsupportedReason } : {}),
    },
    ...(semanticCoverage ? { semanticCoverage } : {}),
  };
}

function makeFixture({ projectId, objects, selectedGids = [] }) {
  const byKind = Object.fromEntries(objects.map(object => [object.kind, {
    count: 1,
    editableProps: object.editable,
    editablePropsIntersection: object.editable,
    editablePropVariants: object.editable.length > 0 ? [object.editable] : [],
  }]));
  const spec = {
    plot_type: 'custom',
    custom_script: '',
    script: '',
    script_language: 'python',
    figure: { width: 160, height: 90, unit: 'mm', dpi: 300 },
  };
  const svgObjects = objects.map((object, index) => (
    `<rect data-fig-id="${object.id}" x="${30 + index * 60}" y="30" width="30" height="30" fill="#b7d5e5" />`
  )).join('');

  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId,
    projectName: 'Capability report smoke fixture',
    figSession: null,
    renderLog: ['> Capability report fixture ready'],
    projectFigures: {
      fig_1: {
        figureId: 'fig_1',
        index: 0,
        manifest: {
          generatedBy: 'introspection',
          globals: {},
          objects,
          palettes: [],
          groups: [],
          bindings: [],
          capabilities: { localPatch: true, backendPatch: true, codePatch: true },
          coverageReport: {
            summary: { dedicated: objects.length, flattened: 0, ambiguous: 0 },
            byKind,
            complexArtists: [],
            unsupportedArtists: [],
          },
          unsupportedNotes: objects
            .filter(object => object.currentProps.unsupportedReason)
            .map(object => `${object.kind}: ${object.currentProps.unsupportedReason}`),
        },
        editLog: [],
        revision: 1,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100">${svgObjects}</svg>`,
        fingerprint: projectId,
        renderStatus: 'success',
      },
    },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids,
    projectHistory: {},
    projectDrafts: {},
    currentView: 'workspace',
    subView: 'home',
  };
}

function mixedFixture() {
  return makeFixture({
    projectId: 'capability-report-mixed',
    selectedGids: ['line.editable'],
    objects: [
      makeObject({ id: 'line.editable', kind: 'line', label: 'Editable line', editable: ['color'] }),
      makeObject({
        id: 'contour.editable',
        kind: 'contourf',
        label: 'Editable contour fill',
        editable: ['vmin', 'vmax'],
        currentProps: { vmin: 0, vmax: 1 },
        semanticCoverage: {
          family: 'contourf',
          status: 'flattened',
          attribution: 'class',
          preservedKind: 'contourf',
          preservedRole: 'contourf_series',
          preservedEditable: ['vmin', 'vmax'],
        },
      }),
      makeObject({ id: 'text.readonly', kind: 'text', label: 'Readonly scientific label' }),
      makeObject({
        id: 'artist.unsupported',
        kind: 'unsupported',
        label: 'Unsupported statistical artist',
        unsupportedReason: 'No safe scientific replay adapter.',
      }),
    ],
  });
}

function emptyFixture() {
  return makeFixture({ projectId: 'capability-report-empty', objects: [] });
}

function readonlyFixture() {
  return makeFixture({
    projectId: 'capability-report-readonly',
    selectedGids: ['text.readonly'],
    objects: [makeObject({ id: 'text.readonly', kind: 'text', label: 'Readonly scientific label' })],
  });
}

async function installFixture(context, fixture) {
  await context.addInitScript(({ key, state }) => {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  }, { key: APP_STATE_KEY, state: fixture });
}

async function installApiStubs(page) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'capability-report-user', email: 'capability-report@example.test' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/projects**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', projects: [], figures: [], assets: [] }),
  }));
}

async function requireTestId(scope, testId, description) {
  const locator = scope.getByTestId(testId);
  await locator.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  const count = await locator.count();
  assert(
    count === 1,
    `Missing required stable selector [data-testid="${testId}"] for ${description}; do not replace it with DOM or style selectors.`,
  );
  return locator;
}

async function openCapabilityDetails(page) {
  const summary = await requireTestId(page, 'figure-capability-summary', 'the capability summary entry point');
  const toggle = await requireTestId(summary, 'figure-capability-details-toggle', 'capability-summary expansion');
  await toggle.click();
  return requireTestId(summary, 'figure-capability-details', 'expanded capability details');
}

async function verifyMixedCapabilityReport(page) {
  const summary = await requireTestId(page, 'figure-capability-summary', 'the capability summary entry point');
  const summaryText = await summary.innerText();
  assert(summaryText.includes('当前 Figure：部分可编辑'), `mixed summary state drifted: ${summaryText}`);
  assert(summaryText.includes('可编辑 2 · 只读 1 · 不支持 1'), `mixed summary counts drifted: ${summaryText}`);

  const details = await openCapabilityDetails(page);
  const expectedKinds = [
    ['line', 'editable'],
    ['contourf', 'editable'],
    ['text', 'readonly'],
    ['unsupported', 'unsupported'],
  ];
  for (const [kind, status] of expectedKinds) {
    const row = await requireTestId(details, `figure-capability-kind-${kind}`, `${kind} object-type capability row`);
    assert(
      await row.getAttribute('data-capability-status') === status,
      `${kind} capability row must expose data-capability-status="${status}"`,
    );
  }
  const detailsText = await details.innerText();
  assert(
    detailsText.includes('编辑能力')
      && detailsText.includes('line：color')
      && detailsText.includes('contourf：')
      && detailsText.includes('vmin')
      && detailsText.includes('vmax'),
    `editable capability report is incomplete: ${detailsText}`,
  );
  const impact = await requireTestId(details, 'figure-capability-scientific-impact', 'scientific-impact guidance');
  assert((await impact.innerText()).includes('色阶上限 1') && (await impact.innerText()).includes('色阶下限 1'), 'scientific-impact guidance is incomplete');
  const notes = await requireTestId(details, 'figure-capability-notes', 'legacy and renderer capability notes');
  const notesText = await notes.innerText();
  assert(
    notesText.includes('未通过稳定重放验证的属性不会开放编辑'),
    'renderer unsupportedNotes must produce a user-facing limitation summary',
  );
  assert(!notesText.includes('No safe scientific replay adapter.'), 'raw renderer unsupportedNotes must not reach the user-facing capability report');
}

async function verifyEmptyObjectPanel(page) {
  const summary = await requireTestId(page, 'figure-capability-summary', 'the empty-figure summary');
  const summaryText = await summary.innerText();
  assert(summaryText.includes('当前 Figure：未识别到对象'), `empty summary state drifted: ${summaryText}`);
  assert(summaryText.includes('0/0 objects'), `empty summary object count drifted: ${summaryText}`);
  const emptyPanel = await requireTestId(summary, 'figure-capability-empty-panel', 'the no-object empty-panel state');
  assert(
    await emptyPanel.getAttribute('data-capability-empty-reason') === 'no-objects',
    'no-object panel must expose data-capability-empty-reason="no-objects"',
  );
  assert((await emptyPanel.innerText()).includes('没有可识别对象，因此没有可编辑属性。'), 'no-object panel copy is incomplete');
  assert(await summary.getByTestId('figure-capability-details-toggle').count() === 0, 'empty summary must not offer a detail disclosure without objects');
}

async function verifyReadonlyObjectPanel(page) {
  const summary = await requireTestId(page, 'figure-capability-summary', 'the readonly-figure summary');
  const summaryText = await summary.innerText();
  assert(summaryText.includes('当前 Figure：只读'), `readonly summary state drifted: ${summaryText}`);
  assert(summaryText.includes('可编辑 0 · 只读 1 · 不支持 0'), `readonly summary counts drifted: ${summaryText}`);
  const emptyPanel = await requireTestId(summary, 'figure-capability-empty-panel', 'the readonly-object empty-panel state');
  assert(
    await emptyPanel.getAttribute('data-capability-empty-reason') === 'readonly-selection',
    'readonly-object panel must expose data-capability-empty-reason="readonly-selection"',
  );
  assert((await emptyPanel.innerText()).includes('已识别到对象，但当前对象为只读或暂不支持编辑。'), 'readonly empty-panel copy is incomplete');
  assert(!summaryText.includes('没有可识别对象'), `readonly summary must not use no-object copy: ${summaryText}`);

  const details = await openCapabilityDetails(page);
  const detailsText = await details.innerText();
  assert(detailsText.includes('对象类型') && detailsText.includes('text 1'), `readonly details must preserve the recognized object type: ${detailsText}`);
  assert(!detailsText.includes('编辑能力'), `readonly details must not invent editable properties: ${detailsText}`);
}

async function runFixture(browser, fixture, verify) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await installFixture(context, fixture);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => {
      if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
    });
    page.on('console', message => {
      if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) {
        consoleErrors.push(message.text());
      }
    });
    await installApiStubs(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await verify(page);
    } catch (error) {
      const pageText = await page.locator('body').innerText().catch(() => 'unavailable');
      throw new Error(`${error.message}\nPage errors: ${JSON.stringify(pageErrors)}\nConsole errors: ${JSON.stringify(consoleErrors)}\nPage text: ${pageText.slice(0, 1200)}`);
    }
    assert(pageErrors.length === 0, `page errors: ${JSON.stringify(pageErrors)}`);
    assert(consoleErrors.length === 0, `console errors: ${JSON.stringify(consoleErrors)}`);
  } finally {
    await context.close();
  }
}

async function run() {
  assertIsolatedEnvironment();
  const browser = await chromium.launch({ headless: true });
  try {
    await runFixture(browser, mixedFixture(), verifyMixedCapabilityReport);
    await runFixture(browser, emptyFixture(), verifyEmptyObjectPanel);
    await runFixture(browser, readonlyFixture(), verifyReadonlyObjectPanel);
    console.log('PASS capability report expands with object types, status distinctions, and scientific-impact guidance');
    console.log('PASS capability report preserves no-object and readonly-object empty-panel semantics');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
