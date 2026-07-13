import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const files = [
  'ops/systemd/scifigure.service',
  'ops/env/scifigure-common.env.example',
  'ops/env/scifigure-release.env.example',
  'ops/nginx/scifigure-bootstrap.conf.template',
  'ops/nginx/scifigure-tls.conf.template',
  'ops/deployment/bootstrap-ubuntu.sh',
  'ops/deployment/deploy-release.sh',
  'ops/deployment/rollback.sh',
  'ops/deployment/enable-tls.sh',
];

for (const file of files) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment file: ${file}`);
  assert.ok(!read(file).includes('\r\n'), `Deployment file must use LF endings: ${file}`);
}

const service = read('ops/systemd/scifigure.service');
assert.match(service, /^User=scifigure$/m);
assert.match(service, /^EnvironmentFile=\/etc\/scifigure\/common\.env$/m);
assert.match(service, /^EnvironmentFile=\/etc\/scifigure\/release\.env$/m);
assert.match(service, /^WorkingDirectory=\/opt\/scifigure\/current$/m);
assert.match(service, /^KillSignal=SIGTERM$/m);
assert.match(service, /^TimeoutStopSec=210s$/m);
assert.doesNotMatch(service, /^PrivateTmp=true$/m, 'PrivateTmp would hide bind mounts from rootless Docker');

const commonEnv = read('ops/env/scifigure-common.env.example');
assert.match(commonEnv, /^SCIFIGURE_BIND_HOST=127\.0\.0\.1$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_MODE=docker$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_CONCURRENCY=1$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_MEMORY=896m$/m);
assert.match(commonEnv, /^DOCKER_HOST=unix:\/\/\/run\/user\/__SCIFIGURE_UID__\/docker\.sock$/m);
assert.match(commonEnv, /^TMPDIR=\/var\/lib\/scifigure\/runtime$/m);

for (const nginxFile of [
  'ops/nginx/scifigure-bootstrap.conf.template',
  'ops/nginx/scifigure-tls.conf.template',
]) {
  const nginx = read(nginxFile);
  assert.match(nginx, /server 127\.0\.0\.1:3101;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /proxy_add_x_forwarded_for/);
  assert.doesNotMatch(nginx, /127\.0\.0\.1:3102/, 'Only one application instance may be routed');
}

const deployScript = read('ops/deployment/deploy-release.sh');
assert.match(deployScript, /Release already exists and will not be overwritten/);
assert.match(deployScript, /runuser -u scifigure/);
assert.match(deployScript, /DOCKER_HOST="\$docker_host"/);
assert.match(deployScript, /SCIFIGURE_RENDERER_IMAGE=\$\{renderer_image\}/);
assert.match(deployScript, /stop_service\(\)/);
assert.doesNotMatch(deployScript, /systemctl stop scifigure\.service 2>\/dev\/null \|\| true/);
assert.match(deployScript, /refusing to replace the SQLite writer/);
assert.match(deployScript, /failed candidate is still running; release pointers were not restored/);
assert.match(deployScript, /if ! start_and_wait "candidate \$\{build_id\}"/);
assert.match(deployScript, /if start_and_wait "restored previous release"/);
assert.match(deployScript, /Candidate failed readiness; previous release restored/);
assert.match(deployScript, /previous-release\.env/);
assert.doesNotMatch(deployScript, /scifigure@(blue|green)/);
for (const flag of [
  'VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2',
  'VITE_SCIFIGURE_FONT_CONTROLS_V2',
  'VITE_SCIFIGURE_COMPONENT_CONTROLS_V2',
  'VITE_SCIFIGURE_PALETTE_CONTROLS_V2',
  'VITE_SCIFIGURE_LAYOUT_CONTROLS_V2',
]) {
  assert.match(deployScript, new RegExp(`${flag}=1`), `Latest editor flag is missing: ${flag}`);
}
assert.match(deployScript, /unified-editing-build\.json/);

const bootstrap = read('ops/deployment/bootstrap-ubuntu.sh');
assert.match(bootstrap, /fallocate -l 4G \/swapfile/);
assert.match(bootstrap, /SCIFIGURE_ENABLE_UFW/);
assert.match(bootstrap, /sshd -T/);
assert.match(bootstrap, /SCIFIGURE_DISABLE_ROOTFUL_DOCKER/);
assert.match(bootstrap, /SCIFIGURE_DOCKER_APT_BASE_URL/);
assert.match(bootstrap, /refusing to disable it/);
assert.doesNotMatch(bootstrap, /ufw allow 310[12]/);
assert.match(bootstrap, /dockerd-rootless-setuptool\.sh install/);

const rollback = read('ops/deployment/rollback.sh');
assert.match(rollback, /previous-release/);
assert.match(rollback, /Rollback target failed readiness; current release restored/);
assert.match(rollback, /failed rollback target is still running; release pointers were not restored/);
assert.match(rollback, /if ! start_and_wait "rollback target"/);
assert.match(rollback, /if start_and_wait "restored current release"/);
assert.doesNotMatch(rollback, /systemctl stop scifigure\.service 2>\/dev\/null \|\| true/);
assert.doesNotMatch(rollback, /target_slot/);

const tlsTemplate = read('ops/nginx/scifigure-tls.conf.template');
assert.match(tlsTemplate, /return 301 https:\/\/__SERVER_NAME__\$request_uri;/);
assert.doesNotMatch(tlsTemplate, /https:\/\/\$host/);
const tlsScript = read('ops/deployment/enable-tls.sh');
assert.match(tlsScript, /renewal-hooks\/deploy\/20-scifigure-reload-nginx/);

const server = read('server.ts');
assert.match(server, /SCIFIGURE_BIND_HOST/);
assert.match(server, /\['DOCKER_HOST', 'XDG_RUNTIME_DIR'\]/);

let bashSyntax = 'not available on this platform';
if (process.platform !== 'win32') {
  const scripts = files.filter(file => file.endsWith('.sh'));
  const result = spawnSync('bash', ['-n', ...scripts], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  bashSyntax = 'passed';
}

console.log(JSON.stringify({
  status: 'PASS',
  files: files.length,
  bashSyntax,
  checks: [
    'loopback-only Node instance',
    'rootless Docker environment',
    '2-core/4-GB resource profile',
    'single SQLite writer during release replacement',
    'readiness failure restores previous release',
    'last-known-good rollback metadata',
    'opt-in SSH-aware firewall rules',
    'fixed-host TLS redirect and renewal reload',
  ],
}, null, 2));
