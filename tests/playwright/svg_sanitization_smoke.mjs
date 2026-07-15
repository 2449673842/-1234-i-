import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://127.0.0.1:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { sanitizeSvg } = await import('/src/utils/svgEditor.ts');
    window.__scifigureSvgXss = 0;
    const payload = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" onload="window.__scifigureSvgXss=1">
        <defs><clipPath id="safe_clip"><rect width="20" height="20" /></clipPath></defs>
        <script>window.__scifigureSvgXss=2</script>
        <foreignObject><iframe src="https://evil.invalid"></iframe></foreignObject>
        <a href="&#x6a;avascript:window.__scifigureSvgXss=3"><text>unsafe link</text></a>
        <image href="https://evil.invalid/pixel.png" width="1" height="1" />
        <rect id="unsafe_style" style="fill:url(https://evil.invalid/pixel)" width="10" height="10" />
        <rect id="safe_shape" clip-path="url(#safe_clip)" width="20" height="20" fill="#176b5b" />
        <image id="safe_image" href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1" />
      </svg>`;
    const sanitized = sanitizeSvg(payload);
    const host = document.createElement('div');
    host.innerHTML = sanitized;
    document.body.appendChild(host);
    await new Promise(resolve => setTimeout(resolve, 50));
    const svg = host.querySelector('svg');
    const unsafeStyle = host.querySelector('#unsafe_style');
    const safeShape = host.querySelector('#safe_shape');
    const externalImage = Array.from(host.querySelectorAll('image')).find(item => item.id !== 'safe_image');
    return {
      xss: window.__scifigureSvgXss,
      hasSvg: Boolean(svg),
      hasScript: Boolean(host.querySelector('script')),
      hasForeignObject: Boolean(host.querySelector('foreignObject')),
      rootOnload: svg?.hasAttribute('onload') || false,
      anchorHref: host.querySelector('a')?.getAttribute('href') || null,
      externalImageHref: externalImage?.getAttribute('href') || null,
      unsafeStyle: unsafeStyle?.getAttribute('style') || null,
      safeClipPath: safeShape?.getAttribute('clip-path') || null,
      safeImageHref: host.querySelector('#safe_image')?.getAttribute('href') || null,
    };
  });

  assert(result.xss === 0, `Sanitized SVG executed active content: ${JSON.stringify(result)}`);
  assert(result.hasSvg, 'Sanitizer removed the valid SVG root');
  assert(!result.hasScript && !result.hasForeignObject && !result.rootOnload, `Blocked SVG nodes survived: ${JSON.stringify(result)}`);
  assert(result.anchorHref === null && result.externalImageHref === null && result.unsafeStyle === null, `External SVG references survived: ${JSON.stringify(result)}`);
  assert(result.safeClipPath === 'url(#safe_clip)', `Internal clip path was removed: ${JSON.stringify(result)}`);
  assert(result.safeImageHref?.startsWith('data:image/png;base64,'), `Embedded raster image was removed: ${JSON.stringify(result)}`);

  console.log(JSON.stringify({ status: 'PASS', result }, null, 2));
} finally {
  await browser.close();
}
