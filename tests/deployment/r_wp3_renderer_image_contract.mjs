import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const attributesPath = path.join(root, '.gitattributes');
const dockerfilePath = path.join(root, 'Dockerfile.renderer');
const dockerignorePath = path.join(root, 'Dockerfile.renderer.dockerignore');
const rendererPath = path.join(root, 'renderer', 'r_renderer.R');
const fontconfigPath = path.join(root, 'renderer', 'fontconfig-local.conf');
const lockPath = path.join(root, 'requirements.renderer.lock');
const source = fs.readFileSync(dockerfilePath, 'utf8').replaceAll('\r\n', '\n');
const dockerignoreSource = fs.readFileSync(dockerignorePath, 'utf8').replaceAll('\r\n', '\n');
const fontconfigSource = fs.readFileSync(fontconfigPath, 'utf8').replaceAll('\r\n', '\n');
const rendererSourceSha = createHash('sha256').update(fs.readFileSync(rendererPath)).digest('hex');
const lockSourceBytes = fs.readFileSync(lockPath);
const lockSourceSha = createHash('sha256').update(lockSourceBytes).digest('hex');
const attributesSource = fs.readFileSync(attributesPath, 'utf8').replaceAll('\r\n', '\n');

const expectText = (text, message) => assert.match(source, text, message);

expectText(/^FROM docker\.m\.daocloud\.io\/library\/python:3\.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de$/m, 'renderer base image must preserve the digest-pinned production runtime');
expectText(/DEBIAN_MIRROR=https:\/\/mirrors\.aliyun\.com\/debian/);
expectText(/PIP_INDEX_URL=https:\/\/mirrors\.aliyun\.com\/pypi\/simple/);
expectText(/PYTHONDONTWRITEBYTECODE=1/);
expectText(/PYTHONUNBUFFERED=1/);
expectText(/MPLBACKEND=Agg/);
expectText(/MPLCONFIGDIR=\/tmp\/scifigure\/matplotlib/);
expectText(/TZ=UTC/);
expectText(/LANG=C\.UTF-8/);
expectText(/LC_ALL=C\.UTF-8/);
expectText(/HOME=\/tmp\/scifigure\/home/);
expectText(/TMPDIR=\/tmp\/scifigure\/tmp/);
expectText(/XDG_CACHE_HOME=\/tmp\/scifigure\/cache/);
expectText(/RUN install -d -m 0755[\s\S]*\/tmp\/scifigure\/tmp[\s\S]*&& apt-get update/);

for (const packagePin of [
  'r-base=4.5.0-3',
  'r-cran-ggplot2=3.5.1+dfsg-1',
  'r-cran-jsonlite=1.9.1+dfsg-1',
  'r-cran-readxl=1.4.5-1',
  'r-cran-svglite=2.1.3-2',
  'r-cran-systemfonts=1.2.1-1',
  'r-cran-textshaping=0.3.7-2',
  'fonts-liberation=1:2.1.5-3',
  'fonts-noto-cjk=1:20240730+repack1-1',
  'fonts-freefont-ttf=20211204+svn4273-2',
]) {
  assert.ok(source.includes(packagePin), `missing pinned package: ${packagePin}`);
}

expectText(/org\.scifigure\.renderer\.python="3\.12\.13"/);
expectText(/org\.scifigure\.renderer\.python-packages="matplotlib=3\.11\.1;numpy=2\.5\.1;/);
expectText(/org\.scifigure\.renderer\.r-packages="ggplot2=3\.5\.1;jsonlite=1\.9\.1;readxl=1\.4\.5;svglite=2\.1\.3;systemfonts=1\.2\.1;textshaping=0\.3\.7"/);
expectText(/org\.scifigure\.renderer\.svg-device="svglite"/);
expectText(
  new RegExp(`^ARG SCIFIGURE_R_RENDERER_SHA256=${rendererSourceSha}$`, 'm'),
  'renderer image build must pin the exact checked-in r_renderer.R SHA256',
);
expectText(
  new RegExp(`^ARG SCIFIGURE_PYTHON_LOCK_SHA256=${lockSourceSha}$`, 'm'),
  'renderer image build must pin the exact checked-in dependency lock SHA256',
);
expectText(
  /org\.scifigure\.renderer\.r-source-sha256="?\$\{?SCIFIGURE_R_RENDERER_SHA256\}?"?/,
  'renderer image must publish the pinned R source SHA as an image label',
);
expectText(
  /sha256sum\s+\/opt\/scifigure\/renderer\/r_renderer\.R/,
  'renderer image build must verify the copied R source bytes',
);
expectText(/NotoSansCJK-Regular\.ttc/);
expectText(/FreeSans\.ttf/);
expectText(/Times_New_Roman\.ttf/);
expectText(/COPY renderer\/fontconfig-local\.conf/);
expectText(/test -r \/usr\/share\/fonts\/opentype\/noto\/NotoSansCJK-Regular\.ttc/);
expectText(/test -r \/usr\/share\/fonts\/truetype\/freefont\/FreeSans\.ttf/);
expectText(/fc-match[^\n]*'Times New Roman'[^\n]*grep -qi 'Times New Roman'/);
expectText(/COPY [^\n]*requirements\.renderer\.lock/);
expectText(/pip install --no-cache-dir --only-binary=:all: --require-hashes/);
expectText(/packageVersion/);
expectText(/svglite::svglite/);
expectText(/SCIFIGURE_R_SVG_DEVICE/);
expectText(/USER 65532:65532/);
expectText(/groupadd --gid 65532 renderer/);
expectText(/exec \\\"\$@\\\"/);

assert.doesNotMatch(source, /install\.packages\s*\(/, 'R packages must not be downloaded at runtime');
assert.doesNotMatch(source, /download\.packages\s*\(/, 'R packages must not be downloaded at runtime');
assert.doesNotMatch(source, /\bcurl\b|\bwget\b/, 'the renderer image contract must not add download helpers');
assert.match(
  fontconfigSource,
  /<family>Times<\/family>[\s\S]*<family>Times New Roman<\/family>/,
  'generic Times must prefer the installed Times New Roman family',
);
assert.match(
  attributesSource,
  /^requirements\.renderer\.lock text eol=lf$/m,
  'the hash-bound dependency lock must retain LF bytes across platforms',
);
assert.match(
  attributesSource,
  /^renderer\/r_renderer\.R text eol=lf$/m,
  'the hash-bound R renderer source must retain LF bytes across platforms',
);
assert.ok(fs.existsSync(lockPath), 'renderer dependency lock is missing');
assert.match(dockerignoreSource, /^!requirements\.renderer\.lock$/m, 'renderer build context excludes the dependency lock');
const lockSource = fs.readFileSync(lockPath, 'utf8').replaceAll('\r\n', '\n');
for (const requirement of [
  'matplotlib==3.11.1',
  'numpy==2.5.1',
  'pandas==3.0.3',
  'pillow==12.3.0',
  'cairosvg==2.9.0',
  'scipy==1.18.0',
  'seaborn==0.13.2',
  'openpyxl==3.1.5',
  'xlrd==2.0.2',
]) {
  const start = lockSource.toLowerCase().indexOf(requirement);
  assert.ok(start >= 0, `renderer lock omitted ${requirement}`);
  const nextRequirement = lockSource.indexOf('\n\n', start);
  const block = lockSource.slice(start, nextRequirement >= 0 ? nextRequirement : undefined);
  assert.match(block, /--hash=sha256:[a-f0-9]{64}/, `${requirement} is not hash-pinned`);
}

console.log('R-WP3 renderer image contract: PASS');
