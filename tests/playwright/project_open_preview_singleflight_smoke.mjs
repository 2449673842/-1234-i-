import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280" viewBox="0 0 420 280"><rect width="420" height="280" fill="white"/><path d="M40 220 L130 130 L220 175 L320 70" fill="none" stroke="#176b5b" stroke-width="4"/><text x="40" y="35">Cached preview</text></svg>';
const manifest = {
  generatedBy: 'introspection',
  globals: {},
  objects: [{
    id: 'line.0',
    kind: 'line',
    label: 'Cached line',
    editable: ['color', 'linewidth'],
    currentProps: { color: '#176b5b', linewidth: 4 },
  }],
  palettes: [],
  groups: [],
  bindings: [],
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
};
const script = 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2, 3])';

function projectFigure({ withSvg = false } = {}) {
  return {
    figureId: 'fig_1',
    index: 0,
    revision: 7,
    editLog: [],
    manifest: withSvg ? manifest : null,
    svg: withSvg ? svg : undefined,
    renderStatus: withSvg ? 'success' : 'idle',
  };
}

function spec(language = 'python') {
  return {
    plot_type: 'custom',
    custom_script: script,
    script_language: language,
    figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
  };
}

function appState(overrides = {}) {
  return {
    spec: spec(),
    history: [spec()],
    historyIndex: 0,
    projectId: null,
    projectName: '未命名项目',
    projectFigures: {},
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: [],
    projectHistory: {},
    projectDrafts: {},
    renderLog: [],
    currentView: 'projects',
    subView: 'my-projects',
    ...overrides,
  };
}

function projectPayload({ empty = false, language = 'python' } = {}) {
  return {
    projectId: 'preview-project',
    name: 'Cached preview project',
    spec: spec(language),
    script,
    datasets: [],
    figures: empty ? [] : [projectFigure()],
  };
}

async function installRoutes(page, counters, {
  emptyProject = false,
  cacheMiss = false,
  language = 'python',
} = {}) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', user: { id: 'preview-user' } }),
  }));
  await page.route('**/api/projects/preview-project/figures?includePreview=1&cacheOnly=1', route => {
    counters.previewGets += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cacheMiss
        ? { status: 'success', previewSource: 'miss', figures: [projectFigure()] }
        : {
            status: 'success',
            previewSource: 'cache',
            figures: [{ ...projectFigure({ withSvg: true }), previewSource: 'cache' }],
          }),
    });
  });
  await page.route('**/api/projects/preview-project/figures/render', route => {
    counters.renderPosts += 1;
    counters.renderLanguages.push(route.request().postDataJSON()?.language || null);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', figures: [projectFigure({ withSvg: true })] }),
    });
  });
  await page.route('**/api/projects/preview-project/export-assets', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', assets: [] }),
  }));
  await page.route('**/api/projects/preview-project', route => {
    if (route.request().method() === 'GET') counters.projectGets += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', project: projectPayload({ empty: emptyProject, language }) }),
    });
  });
  await page.route('**/api/projects', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      projects: [{
        id: 'preview-project',
        name: 'Cached preview project',
        created_at: '2026-08-01 10:00:00',
        updated_at: '2026-08-01 10:01:00',
        group_count: 1,
        sample_count: 3,
        figure_count: 1,
        project_type: 'single_figure',
        project_type_label: '单图项目',
        preview: null,
      }],
    }),
  }));
}

async function waitForPreview(page, counters, scenario) {
  const preview = page.getByText('Cached preview', { exact: true });
  try {
    await preview.waitFor({ timeout: 10_000 });
  } catch (error) {
    const body = ((await page.textContent('body').catch(() => '')) || '').slice(0, 1800);
    throw new Error(`${scenario} did not show SVG. Counters=${JSON.stringify(counters)} Body=${body} Cause=${error.message}`);
  }
}

async function assertCachedProjectOpen(browser) {
  const counters = { previewGets: 0, renderPosts: 0, projectGets: 0, renderLanguages: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript(value => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
  }, appState());
  const page = await context.newPage();
  await installRoutes(page, counters);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByText('Cached preview project', { exact: true }).click();
  await waitForPreview(page, counters, 'project open');
  await page.waitForTimeout(150);

  assert(counters.projectGets === 1, `project metadata should load once, got ${counters.projectGets}`);
  assert(counters.previewGets === 1, `project open should hydrate preview once, got ${counters.previewGets}`);
  assert(counters.renderPosts === 0, `cached project open issued ${counters.renderPosts} render POST request(s)`);
  await context.close();
}

async function assertRefreshRestore(browser) {
  const counters = { previewGets: 0, renderPosts: 0, projectGets: 0, renderLanguages: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript(value => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
  }, appState({
    projectId: 'preview-project',
    projectName: 'Cached preview project',
    projectFigures: { fig_1: projectFigure() },
    currentView: 'editor',
  }));
  const page = await context.newPage();
  await installRoutes(page, counters);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForPreview(page, counters, 'refresh restore');
  await page.waitForTimeout(150);

  assert(counters.projectGets === 0, `refresh should not reload heavy project metadata, got ${counters.projectGets}`);
  assert(counters.previewGets === 1, `refresh should hydrate preview once, got ${counters.previewGets}`);
  assert(counters.renderPosts === 0, `cached refresh issued ${counters.renderPosts} render POST request(s)`);
  await context.close();
}

async function assertNewProjectFirstRender(browser) {
  const counters = { previewGets: 0, renderPosts: 0, projectGets: 0, renderLanguages: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript(value => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
  }, appState());
  const page = await context.newPage();
  await installRoutes(page, counters, { emptyProject: true });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByText('Cached preview project', { exact: true }).click();
  await waitForPreview(page, counters, 'new project first render');
  await page.waitForTimeout(150);

  assert(counters.previewGets === 0, `new project should not request a missing preview row, got ${counters.previewGets}`);
  assert(counters.renderPosts === 1, `new project should render exactly once, got ${counters.renderPosts}`);
  await context.close();
}

async function assertExistingProjectCacheMiss(browser, language) {
  const counters = { previewGets: 0, renderPosts: 0, projectGets: 0, renderLanguages: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  await context.addInitScript(value => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
  }, appState());
  const page = await context.newPage();
  await installRoutes(page, counters, { cacheMiss: true, language });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByText('Cached preview project', { exact: true }).click();
  await waitForPreview(page, counters, `${language} project cache miss`);
  await page.waitForTimeout(150);

  assert(counters.previewGets === 1, `${language} cache miss should probe cache once, got ${counters.previewGets}`);
  assert(counters.renderPosts === 1, `${language} cache miss should rebuild through one POST, got ${counters.renderPosts}`);
  assert(counters.renderLanguages[0] === language, `${language} cache miss used ${JSON.stringify(counters.renderLanguages)}`);
  await context.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    await assertCachedProjectOpen(browser);
    await assertRefreshRestore(browser);
    await assertNewProjectFirstRender(browser);
    await assertExistingProjectCacheMiss(browser, 'python');
    await assertExistingProjectCacheMiss(browser, 'r');
    console.log('PASS cached opens avoid rendering; new and cache-miss Python/R projects rebuild exactly once');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
