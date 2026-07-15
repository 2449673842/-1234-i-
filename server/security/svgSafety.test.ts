import { describe, expect, it } from 'vitest';
import { assertSafeSvgDocument, UnsafeSvgError } from './svgSafety';

const safeSvg = `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 80">
  <defs>
    <clipPath id="clip_1"><rect width="100" height="80" /></clipPath>
    <path id="glyph_1" d="M0 0 L1 1" />
    <style>* { stroke-linejoin: round; }</style>
  </defs>
  <g clip-path="url(#clip_1)" style="fill: #112233">
    <use xlink:href="#glyph_1" />
    <image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2" />
    <text>javascript: is harmless as text</text>
  </g>
</svg>`;

describe('SVG import safety boundary', () => {
  it('allows common Matplotlib internal references and embedded raster images', () => {
    expect(assertSafeSvgDocument(safeSvg)).toBe(safeSvg);
  });

  it('strips the fixed Matplotlib SVG 1.1 doctype before persistence', () => {
    const matplotlibSvg = `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
 "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text></svg>`;
    const normalized = assertSafeSvgDocument(matplotlibSvg);
    expect(normalized).not.toContain('<!DOCTYPE');
    expect(normalized).toContain('<svg');
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" onload=alert(1)></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.invalid" /></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.invalid/a.svg#x" /></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)"><text>x</text></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.invalid/pixel)" /></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://evil.invalid/svg.dtd"><svg xmlns="http://www.w3.org/2000/svg" />',
  ])('rejects active or external SVG content', (payload) => {
    expect(() => assertSafeSvgDocument(payload)).toThrow(UnsafeSvgError);
  });

  it('rejects oversized SVG content before persistence', () => {
    expect(() => assertSafeSvgDocument(safeSvg, 32)).toThrow('超过允许大小');
  });
});
