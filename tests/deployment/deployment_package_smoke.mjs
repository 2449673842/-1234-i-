import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const files = [
  'ops/systemd/scifigure.service',
  'ops/env/scifigure-common.env.example',
  'ops/env/scifigure-build.env.example',
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
assert.match(service, /^ProtectHome=read-only$/m, 'Rootless Docker socket under /run/user must remain visible');
assert.doesNotMatch(service, /^ProtectHome=true$/m, 'ProtectHome=true would hide the rootless Docker socket');
assert.match(service, /^InaccessiblePaths=\/home \/root$/m);

const commonEnv = read('ops/env/scifigure-common.env.example');
assert.match(commonEnv, /^SCIFIGURE_BIND_HOST=127\.0\.0\.1$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_MODE=docker$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_CONCURRENCY=1$/m);
assert.match(commonEnv, /^SCIFIGURE_RENDER_MEMORY=896m$/m);
assert.match(commonEnv, /^DOCKER_HOST=unix:\/\/\/run\/user\/__SCIFIGURE_UID__\/docker\.sock$/m);
assert.match(commonEnv, /^TMPDIR=\/var\/lib\/scifigure\/runtime$/m);
assert.match(commonEnv, /^SCIFIGURE_SINGLE_UPLOAD_MAX_MB=50$/m);
assert.match(commonEnv, /^SCIFIGURE_PROJECT_TOTAL_STORAGE_MAX_MB=1024$/m);
assert.match(commonEnv, /^SCIFIGURE_USER_TOTAL_STORAGE_MAX_MB=2048$/m);
assert.match(commonEnv, /^SCIFIGURE_GLOBAL_STORAGE_MAX_MB=20480$/m);
assert.match(commonEnv, /^SCIFIGURE_GLOBAL_UPLOAD_MAX_MB_PER_HOUR=1024$/m);
assert.match(commonEnv, /^SCIFIGURE_GLOBAL_DOWNLOAD_MAX_MB_PER_HOUR=512$/m);
assert.match(commonEnv, /^SCIFIGURE_ALLOW_LEGACY_TABULAR_PARSER=0$/m);

for (const nginxFile of [
  'ops/nginx/scifigure-bootstrap.conf.template',
  'ops/nginx/scifigure-tls.conf.template',
]) {
  const nginx = read(nginxFile);
  const expectedDenyCount = nginxFile.includes('-tls.') ? 2 : 1;
  assert.match(nginx, /server 127\.0\.0\.1:3101;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(nginx, /client_max_body_size 64m;/);
  assert.match(nginx, /client_body_timeout 30s;/);
  assert.match(nginx, /limit_req_zone \$binary_remote_addr zone=scifigure_per_ip:10m rate=15r\/s;/);
  assert.match(nginx, /limit_conn_zone \$binary_remote_addr zone=scifigure_connections:10m;/);
  assert.match(nginx, /limit_req zone=scifigure_per_ip burst=60 nodelay;/);
  assert.match(nginx, /limit_conn scifigure_connections 20;/);
  assert.equal(
    [...nginx.matchAll(/location = \/server\.cjs \{\s*return 404;\s*\}/g)].length,
    expectedDenyCount,
    `${nginxFile} must deny server.cjs in every public server block`,
  );
  assert.equal(
    [...nginx.matchAll(/location = \/server\.cjs\.map \{\s*return 404;\s*\}/g)].length,
    expectedDenyCount,
    `${nginxFile} must deny server.cjs.map in every public server block`,
  );
  assert.doesNotMatch(nginx, /proxy_add_x_forwarded_for/);
  assert.doesNotMatch(nginx, /127\.0\.0\.1:3102/, 'Only one application instance may be routed');
}

const deployScript = read('ops/deployment/deploy-release.sh');
assert.match(deployScript, /Release already exists and will not be overwritten/);
assert.match(deployScript, /runuser -u scifigure/);
assert.match(deployScript, /DOCKER_HOST="\$docker_host"/);
assert.match(deployScript, /SCIFIGURE_RENDERER_DEBIAN_MIRROR/);
assert.match(deployScript, /SCIFIGURE_RENDERER_DEBIAN_SECURITY_MIRROR/);
assert.match(deployScript, /SCIFIGURE_RENDERER_PIP_INDEX_URL/);
assert.match(deployScript, /SCIFIGURE_BUILD_ENV_FILE/);
assert.match(deployScript, /Build environment must be root-owned and not group\/world-writable/);
assert.match(deployScript, /Unsupported build environment key/);
assert.doesNotMatch(deployScript, /source "\$build_env"/);
assert.match(deployScript, /npm_config_registry="\$npm_registry"/);
assert.match(deployScript, /https:\/\/registry\.npmmirror\.com/);
assert.match(deployScript, /https:\/\/mirrors\.aliyun\.com\/debian/);
assert.match(deployScript, /https:\/\/mirrors\.aliyun\.com\/pypi\/simple/);
assert.match(deployScript, /SCIFIGURE_RENDERER_IMAGE=\$\{renderer_image\}/);
assert.match(deployScript, /bash -n "\$release_dir\/ops\/deployment\/deploy-release\.sh" "\$release_dir\/ops\/deployment\/rollback\.sh"/);
assert.match(deployScript, /stop_service\(\)/);
assert.doesNotMatch(deployScript, /systemctl stop scifigure\.service 2>\/dev\/null \|\| true/);
assert.match(deployScript, /refusing to replace the SQLite writer/);
assert.match(deployScript, /failed candidate is still running; release pointers were not restored/);
assert.match(deployScript, /if ! start_and_wait "candidate \$\{build_id\}"/);
assert.match(deployScript, /if restore_previous_state "restored previous release"/);
assert.match(deployScript, /Candidate failed readiness; previous release restored/);
assert.match(deployScript, /previous-release\.env/);
assert.match(deployScript, /previous-service-unit/);
assert.match(deployScript, /systemd-analyze verify "\$candidate_unit"/);
assert.match(deployScript, /install -o root -g root -m 0644 "\$candidate_unit" "\$next_unit"/);
assert.match(deployScript, /mv -Tf "\$next_unit" "\$service_unit"/);
assert.match(deployScript, /mv -Tf "\$next_deploy_tool" "\$deploy_tool"/);
assert.match(deployScript, /mv -Tf "\$next_rollback_tool" "\$rollback_tool"/);
assert.match(deployScript, /install -o root -g root -m 0755 "\$old_deploy_tool" "\$next_deploy_tool"/);
assert.match(deployScript, /install -o root -g root -m 0755 "\$old_rollback_tool" "\$next_rollback_tool"/);
assert.match(deployScript, /handle_deploy_error\(\)/);
assert.match(deployScript, /restore_previous_state\(\)/);
assert.match(deployScript, /metadata-backup/);
assert.match(deployScript, /restore_metadata_snapshot\(\)/);
assert.match(deployScript, /mv -Tf "\$\{previous_unit\}\.next" "\$previous_unit"/);
assert.doesNotMatch(deployScript, /scifigure@(blue|green)/);
assert.match(deployScript, /dist\/public\/unified-editing-build\.json/);
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
assert.match(bootstrap, /SCIFIGURE_UBUNTU_APT_MIRROR/);
assert.match(bootstrap, /SCIFIGURE_DOCKER_REGISTRY_MIRROR/);
assert.match(bootstrap, /registry-mirrors/);
assert.match(bootstrap, /scifigure-build\.env\.example/);
assert.match(bootstrap, /refusing to disable it/);
assert.doesNotMatch(bootstrap, /ufw allow 310[12]/);
assert.match(bootstrap, /dockerd-rootless-setuptool\.sh install/);
assert.match(bootstrap, /build-essential/);
assert.match(bootstrap, /install -d -o scifigure -g scifigure -m 0700 \/var\/lib\/scifigure\/\.config/);
assert.match(bootstrap, /nginx -t\s+systemctl enable --now nginx\s+systemctl reload nginx/);

const rollback = read('ops/deployment/rollback.sh');
assert.match(rollback, /previous-release/);
assert.match(rollback, /Rollback target failed readiness; current release restored/);
assert.match(rollback, /failed rollback target is still running; release pointers were not restored/);
assert.match(rollback, /if ! start_and_wait "rollback target"/);
assert.match(rollback, /if restore_current_state "restored current release"/);
assert.match(rollback, /previous-service-unit/);
assert.match(rollback, /install -o root -g root -m 0644 "\$previous_unit" "\$next_unit"/);
assert.match(rollback, /mv -Tf "\$next_unit" "\$service_unit"/);
assert.match(rollback, /handle_rollback_error\(\)/);
assert.match(rollback, /restore_current_state\(\)/);
assert.match(rollback, /rollback-metadata-backup/);
assert.match(rollback, /restore_metadata_snapshot\(\)/);
assert.match(rollback, /mv -Tf "\$\{current_file\}\.next" "\$current_file"/);
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
assert.match(server, /app\.set\('trust proxy', process\.env\.SCIFIGURE_TRUST_PROXY === 'loopback' \? 'loopback' : false\);/);
assert.match(server, /const secure = req\.secure \? '; Secure' : '';/);
assert.doesNotMatch(server, /process\.env\.NODE_ENV === 'production' \? '; Secure' : ''/);

const rendererDockerfile = read('Dockerfile.renderer');
assert.match(rendererDockerfile, /ARG DEBIAN_MIRROR=https:\/\/mirrors\.aliyun\.com\/debian/);
assert.match(rendererDockerfile, /ARG DEBIAN_SECURITY_MIRROR=https:\/\/mirrors\.aliyun\.com\/debian-security/);
assert.match(rendererDockerfile, /ARG PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple/);

const buildEnv = read('ops/env/scifigure-build.env.example');
assert.match(buildEnv, /^SCIFIGURE_NPM_REGISTRY=https:\/\/registry\.npmmirror\.com$/m);
assert.match(buildEnv, /^SCIFIGURE_RENDERER_DEBIAN_MIRROR=https:\/\/mirrors\.aliyun\.com\/debian$/m);
assert.match(buildEnv, /^SCIFIGURE_RENDERER_PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple$/m);
assert.match(buildEnv, /^SCIFIGURE_DOCKER_REGISTRY_MIRROR=https:\/\/docker\.m\.daocloud\.io$/m);

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
    'bounded upload, slow-request and per-IP edge protection',
    'fixed-host TLS redirect and renewal reload',
  ],
}, null, 2));
