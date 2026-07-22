import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const rendererPath = path.join(repoRoot, 'renderer', 'r_renderer.R');
const rendererSourceSha = createHash('sha256').update(fs.readFileSync(rendererPath)).digest('hex');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const image = process.env.SCIFIGURE_R_PARITY_IMAGE || 'scifigure-renderer:r-wp3-current';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scifigure-r-parity-'));
const directContainerName = `scifigure-r-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const baselineManagedContainers = new Set(listManagedContainers());
const serverOutput = [];
let server = null;

const script = [
  'library(ggplot2)',
  'df <- data.frame(',
  '  x = rep(1:3, 4),',
  '  y = c(1.0, 1.6, 2.1, 1.2, 1.8, 2.4, 0.8, 1.4, 1.9, 1.0, 1.5, 2.2),',
  '  group = rep(c("CK", "TR"), each = 6),',
  '  panel = rep(c("Site A", "Site B"), each = 3, times = 2)',
  ')',
  'p <- ggplot(df, aes(x, y, color = group, group = group)) +',
  '  geom_line(linewidth = 0.9) +',
  '  geom_point(size = 2.8) +',
  '  facet_wrap(~panel, nrow = 1) +',
  '  scale_color_manual(values = c(CK = "#1B9E77", TR = "#D95F02")) +',
  '  labs(title = "R runtime parity", x = "Time", y = "Response (ug/L)", color = "Treatment") +',
  '  theme_classic(base_family = "sans")',
  'p',
].join('\n');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function discoverRscript() {
  const configured = process.env.RSCRIPT_BIN || process.env.R_BIN;
  const windowsConda = 'C:\\Users\\SZC\\.conda\\envs\\Machine-learning\\Scripts\\Rscript.exe';
  const candidate = configured || (process.platform === 'win32' && fs.existsSync(windowsConda) ? windowsConda : 'Rscript');
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [candidate], { encoding: 'utf-8', windowsHide: true });
  const located = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
  assert(located && fs.existsSync(located), `Rscript is unavailable: ${candidate}`);
  return located;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function dockerMountPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function listManagedContainers() {
  const result = spawnSync('docker', [
    'ps', '-a', '--filter', 'label=scifigure.managed=true', '--format', '{{.ID}}',
  ], { encoding: 'utf-8', windowsHide: true });
  assert(result.status === 0, `Cannot inspect managed containers: ${result.stderr || result.stdout}`);
  return String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function inspectParityImage() {
  const result = spawnSync('docker', [
    'image', 'inspect', image,
    '--format', '{{ index .Config.Labels "org.scifigure.renderer.r-source-sha256" }}',
  ], { encoding: 'utf-8', windowsHide: true });
  assert(result.status === 0, `Parity image is missing: ${image}`);
  const imageSourceSha = String(result.stdout || '').trim();
  assert(
    imageSourceSha === rendererSourceSha,
    `Parity image source is stale: image=${imageSourceSha || '<missing>'} worktree=${rendererSourceSha}. Rebuild ${image}.`,
  );
}

function parseRendererOutput(label, stdout, stderr, status) {
  assert(status === 0, `${label} exited ${status}: ${stderr}`);
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error}\nSTDERR=${stderr}\nSTDOUT=${String(stdout).slice(0, 800)}`);
  }
}

function localRPath(rscript) {
  const normalized = path.normalize(rscript);
  const scriptsDir = path.basename(path.dirname(normalized)).toLowerCase() === 'scripts'
    ? path.dirname(normalized)
    : path.dirname(normalized);
  const envRoot = path.basename(scriptsDir).toLowerCase() === 'scripts'
    ? path.dirname(scriptsDir)
    : scriptsDir;
  const extraPaths = [
    envRoot,
    path.join(envRoot, 'Scripts'),
    path.join(envRoot, 'Library', 'bin'),
    path.join(envRoot, 'Library', 'mingw-w64', 'bin'),
    path.join(envRoot, 'Lib', 'R', 'bin'),
    path.join(envRoot, 'Lib', 'R', 'bin', 'x64'),
  ].filter(candidate => fs.existsSync(candidate));
  return `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`;
}

function runLocalRenderer() {
  const rscript = discoverRscript();
  const jobDir = path.join(tempRoot, 'local');
  const filesDir = path.join(jobDir, 'files');
  const tmpDir = path.join(jobDir, 'tmp');
  const cacheDir = path.join(jobDir, 'cache');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const payloadFile = path.join(jobDir, 'payload.json');
  fs.writeFileSync(payloadFile, JSON.stringify({
    script,
    cwd: filesDir,
    renderOptions: { width_in: 7, height_in: 4.5 },
  }), 'utf-8');
  const result = spawnSync(rscript, ['--vanilla', rendererPath, '--payload-file', payloadFile], {
    cwd: jobDir,
    env: {
      ...process.env,
      HOME: jobDir,
      USERPROFILE: jobDir,
      R_USER: jobDir,
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
      XDG_CACHE_HOME: cacheDir,
      TZ: 'UTC',
      SCIFIGURE_RSCRIPT_BIN: rscript,
      PATH: localRPath(rscript),
    },
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return parseRendererOutput('local R renderer', result.stdout, result.stderr, result.status);
}

function runDockerRenderer() {
  const jobDir = path.join(tempRoot, 'docker');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'payload.json'), JSON.stringify({
    script,
    renderOptions: { width_in: 7, height_in: 4.5 },
  }), 'utf-8');
  const result = spawnSync('docker', [
    'run', '--rm', '--name', directContainerName,
    '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '65532:65532', '--pids-limit', '128', '--memory', '1g', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--mount', `type=bind,src=${dockerMountPath(jobDir)},dst=/work,readonly`,
    '--workdir', '/work',
    image,
    'Rscript', '--vanilla', '/opt/scifigure/renderer/r_renderer.R', '--payload-file', '/work/payload.json',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return parseRendererOutput('direct Docker R renderer', result.stdout, result.stderr, result.status);
}

function relationSignature(relation) {
  if (!relation || typeof relation !== 'object') return null;
  return Object.fromEntries([
    'aesthetic', 'groupKey', 'dataKey', 'facetKey', 'axisKey', 'layerKey', 'scaleKey', 'guideKey', 'subplotId',
  ].filter(key => relation[key] !== undefined).map(key => [key, relation[key]]));
}

function semanticSignature(result) {
  return (result.manifest?.objects || []).map(object => ({
    id: object.id,
    kind: object.kind,
    role: object.role || null,
    subplotId: object.subplotId || null,
    stableKey: object.stableKey || null,
    fingerprintVersion: object.fingerprintVersion || null,
    fingerprint: object.fingerprint || null,
    semanticKey: object.identity?.semanticKey || null,
    seriesKey: object.identity?.seriesKey || null,
    relation: relationSignature(object.identity?.relation),
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function svgGeometry(svg) {
  const root = String(svg || '').match(/<svg\b[^>]*>/i)?.[0] || '';
  const attribute = name => root.match(new RegExp(`${name}="([^"]+)"`, 'i'))?.[1] || null;
  return { width: attribute('width'), height: attribute('height'), viewBox: attribute('viewBox') };
}

function assertRendered(label, result) {
  assert(result?.status === 'success', `${label} failed: ${JSON.stringify(result)}`);
  assert(typeof result.svg === 'string' && result.svg.length > 2_000, `${label} SVG is empty`);
  assert(result.manifest?.generatedBy === 'r_svg', `${label} manifest is not R semantic output`);
  assert(result.runtimeInventory?.timezone === 'UTC', `${label} timezone is not UTC`);
  assert(result.runtimeInventory?.graphics?.preferredSvgDevice === 'svglite', `${label} did not use svglite`);
  for (const text of ['R runtime parity', 'Time', 'Response (ug/L)', 'Treatment', 'Site A', 'Site B']) {
    assert(result.svg.includes(text), `${label} SVG omitted ${text}`);
  }
  const lowerSvg = result.svg.toLowerCase();
  assert(lowerSvg.includes('#1b9e77') && lowerSvg.includes('#d95f02'), `${label} SVG omitted manual group colors`);
  const signature = semanticSignature(result);
  assert(signature.length >= 15, `${label} semantic object inventory is unexpectedly small: ${signature.length}`);
  return signature;
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function waitForServer(baseUrl, mode) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`${mode}-mode server exited early\n${serverOutput.join('')}`);
    try {
      const { response } = await request(baseUrl, '/api/auth/me');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${mode}-mode server did not start\n${serverOutput.join('')}`);
}

async function registerWebUser(baseUrl, mode) {
  const registration = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `r-parity-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Runtime-Parity-2026',
    }),
  });
  assert(registration.response.ok && registration.data?.token, `Registration failed: ${JSON.stringify(registration.data)}`);
  return registration.data.token;
}

async function renderDuplicateBasenameProject(baseUrl, token, dataDir, mode) {
  const duplicateScript = [
    'library(ggplot2)',
    'baseline <- read.csv(uploaded_file_paths[["baseline.csv"]])',
    'treatment <- read.csv(uploaded_file_paths[["treatment.csv"]])',
    'baseline_sum <- sum(baseline$value)',
    'treatment_sum <- sum(treatment$value)',
    'plot_data <- data.frame(group = c("baseline", "treatment"), value = c(baseline_sum, treatment_sum))',
    'p <- ggplot(plot_data, aes(group, value, fill = group)) +',
    '  geom_col() +',
    '  labs(title = sprintf("duplicate sums: %s / %s", baseline_sum, treatment_sum)) +',
    '  theme_classic()',
    'p',
  ].join('\n');
  const created = await request(baseUrl, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `R duplicate basename parity ${mode} ${Date.now()}`,
      spec: {
        plot_type: 'custom',
        custom_script: duplicateScript,
        script: duplicateScript,
        script_language: 'r',
        figure: { width: 100, height: 80, unit: 'mm', dpi: 150 },
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `Duplicate fixture project creation failed: ${JSON.stringify(created.data)}`);

  const projectId = created.data.id;
  const filesRoot = path.join(dataDir, 'projects', projectId, 'files');
  const baselinePath = path.join(filesRoot, 'baseline', 'analysis.csv');
  const treatmentPath = path.join(filesRoot, 'treatment', 'analysis.csv');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.mkdirSync(path.dirname(treatmentPath), { recursive: true });
  fs.writeFileSync(baselinePath, 'value\n1\n2\n', 'utf8');
  fs.writeFileSync(treatmentPath, 'value\n10\n20\n', 'utf8');

  const db = new Database(path.join(dataDir, 'scifigure.db'));
  try {
    db.pragma('busy_timeout = 5000');
    const insert = db.prepare(`
      INSERT INTO project_files (id, project_id, original_name, stored_path, columns, row_count, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      `baseline-${projectId}`,
      projectId,
      'baseline.csv',
      path.relative(repoRoot, baselinePath).replace(/\\/g, '/'),
      JSON.stringify(['value']),
      2,
      '2026-07-22 00:00:00',
    );
    insert.run(
      `treatment-${projectId}`,
      projectId,
      'treatment.csv',
      path.relative(repoRoot, treatmentPath).replace(/\\/g, '/'),
      JSON.stringify(['value']),
      2,
      '2026-07-22 00:00:01',
    );
  } finally {
    db.close();
  }

  const rendered = await request(baseUrl, `/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      language: 'r',
      script: duplicateScript,
      editLogs: { fig_1: [] },
      requestId: `duplicate-basename-${mode}-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `${mode} duplicate basename render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.[0];
  assert(figure?.svg?.includes('duplicate sums: 3 / 30'), `${mode} aliased duplicate basenames: ${figure?.svg?.match(/duplicate sums:[^<]*/)?.[0] || '<title missing>'}`);
  return figure;
}

async function runWebRenderer(mode, expectedRendererSha = rendererSourceSha) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(tempRoot, `web-${mode}-${expectedRendererSha.slice(0, 8)}`);
  const rscript = discoverRscript();
  server = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SCIFIGURE_DATA_DIR: dataDir,
      SCIFIGURE_DB_PATH: path.join(dataDir, 'scifigure.db'),
      SCIFIGURE_LEGACY_OWNER_EMAIL: '',
      SCIFIGURE_TEST_ISOLATED: '1',
      SCIFIGURE_RENDER_MODE: mode,
      SCIFIGURE_RENDERER_IMAGE: image,
      SCIFIGURE_R_RENDERER_EXPECTED_SHA256: expectedRendererSha,
      RSCRIPT_BIN: rscript,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => serverOutput.push(chunk.toString()));
  server.stderr.on('data', chunk => serverOutput.push(chunk.toString()));
  await waitForServer(baseUrl, mode);

  const token = await registerWebUser(baseUrl, mode);
  const rendered = await request(baseUrl, '/api/figure/render', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: 'r', script, renderOptions: { width_in: 7, height_in: 4.5 } }),
  });
  if (expectedRendererSha !== rendererSourceSha) {
    assert(rendered.response.ok && rendered.data?.status === 'error', `Stale image render was not rejected: ${JSON.stringify(rendered.data)}`);
    assert(rendered.data?.diagnostic?.type === 'renderer_image_stale', `Stale image diagnostic was not structured: ${JSON.stringify(rendered.data)}`);
    return { staleDiagnostic: rendered.data.diagnostic };
  }
  assert(rendered.response.ok, `Web ${mode} render returned ${rendered.response.status}: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data?.performance?.runtime?.mode === mode, `Web render did not use ${mode}: ${JSON.stringify(rendered.data?.performance)}`);
  const duplicateFigure = await renderDuplicateBasenameProject(baseUrl, token, dataDir, mode);
  return { rendered: rendered.data, duplicateFigure };
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  if (process.platform === 'win32' && server.pid) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (server.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }
  await Promise.race([
    new Promise(resolve => server.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
}

try {
  inspectParityImage();

  const local = runLocalRenderer();
  const directDocker = runDockerRenderer();
  const webLocal = await runWebRenderer('local');
  await stopServer();
  const webDockerResult = await runWebRenderer('docker');
  const webDocker = webDockerResult.rendered;
  await stopServer();
  const staleResult = await runWebRenderer('docker', '0'.repeat(64));

  const localSignature = assertRendered('local renderer', local);
  const directDockerSignature = assertRendered('direct Docker renderer', directDocker);
  const webDockerSignature = assertRendered('Web/API Docker renderer', webDocker);
  assert(JSON.stringify(localSignature) === JSON.stringify(directDockerSignature), 'Local and Docker semantic manifests differ');
  assert(JSON.stringify(directDockerSignature) === JSON.stringify(webDockerSignature), 'Direct Docker and Web/API semantic manifests differ');
  assert(JSON.stringify(svgGeometry(local.svg)) === JSON.stringify(svgGeometry(directDocker.svg)), 'Local and Docker SVG geometry differs');
  assert(JSON.stringify(svgGeometry(directDocker.svg)) === JSON.stringify(svgGeometry(webDocker.svg)), 'Direct Docker and Web/API SVG geometry differs');

  const dockerInventory = directDocker.runtimeInventory;
  const webInventory = webDocker.runtimeInventory;
  assert(dockerInventory.r.version === webInventory.r.version, 'Web/API R version differs from the production image');
  assert(dockerInventory.r.version.includes('4.5.0'), `Docker R version drifted: ${dockerInventory.r.version}`);
  for (const [packageName, expectedVersion] of Object.entries({
    ggplot2: '3.5.1', jsonlite: '1.9.1', readxl: '1.4.5', svglite: '2.1.3',
    systemfonts: '1.2.1', textshaping: '0.3.7',
  })) {
    assert(dockerInventory.packages?.[packageName]?.version === expectedVersion, `Docker ${packageName} version drifted`);
    assert(webInventory.packages?.[packageName]?.version === expectedVersion, `Web/API ${packageName} version drifted`);
  }
  assert(dockerInventory.fonts?.candidates?.['Times New Roman'] === true, 'Docker Times New Roman is unavailable');
  assert(webInventory.fonts?.candidates?.['Times New Roman'] === true, 'Web/API Times New Roman is unavailable');
  assert(dockerInventory.fonts?.candidates?.FreeSans === true, 'Docker FreeSans is unavailable');
  assert(webInventory.fonts?.candidates?.FreeSans === true, 'Web/API FreeSans is unavailable');
  assert(webLocal.duplicateFigure?.svg?.includes('duplicate sums: 3 / 30'), 'Local Web duplicate-basename parity failed');
  assert(webDockerResult.duplicateFigure?.svg?.includes('duplicate sums: 3 / 30'), 'Docker Web duplicate-basename parity failed');
  assert(staleResult.staleDiagnostic?.type === 'renderer_image_stale', 'Stale renderer image guard did not fail closed');

  await stopServer();
  const leakedManaged = listManagedContainers().filter(id => !baselineManagedContainers.has(id));
  assert(leakedManaged.length === 0, `R parity left managed containers: ${JSON.stringify(leakedManaged)}`);

  console.log(JSON.stringify({
    status: 'PASS',
    image,
    objectCount: localSignature.length,
    localR: local.runtimeInventory.r.version,
    dockerR: dockerInventory.r.version,
    checks: [
      'local/direct-Docker/Web semantic identity parity',
      'critical text and manual colors',
      'SVG geometry parity',
      'fixed Docker R/package inventory',
      'duplicate-basename file isolation in local and Docker Web renderers',
      'stale renderer image fail-closed diagnostic',
      'read-only no-network low-privilege Web renderer',
      'no managed container leak',
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    serverOutput: serverOutput.join('').slice(-12_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await stopServer();
  spawnSync('docker', ['rm', '-f', directContainerName], { stdio: 'ignore', windowsHide: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
