const BLOCKED_ELEMENT_PATTERN = /<\s*(?:script|foreignobject|iframe|object|embed|audio|video|animate(?:motion|transform)?|set|discard|handler|listener|feimage)\b/i;
const EVENT_ATTRIBUTE_PATTERN = /\s(?:on[a-z0-9:_-]+)\s*=/i;
const DECLARATION_PATTERN = /<!\s*(?:doctype|entity)\b/i;
const URI_ATTRIBUTE_PATTERN = /\b(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const URL_BEARING_ATTRIBUTE_PATTERN = /\b(?:style|fill|stroke|filter|clip-path|mask|cursor)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const STYLE_ELEMENT_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const CSS_URL_PATTERN = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
const DANGEROUS_CSS_PATTERN = /(?:@import|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|data\s*:\s*(?:text\/html|application\/xhtml\+xml))/i;
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const MATPLOTLIB_SVG_11_DOCTYPE_PATTERN = /^(\s*(?:<\?xml[\s\S]*?\?>\s*)?)<!DOCTYPE\s+svg\s+PUBLIC\s+["']-\/\/W3C\/\/DTD SVG 1\.1\/\/EN["']\s+["']https?:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd["']\s*>\s*/i;

export class UnsafeSvgError extends Error {
  statusCode = 400;

  constructor(message = 'SVG 内容包含不允许的元素或外部资源') {
    super(message);
    this.name = 'UnsafeSvgError';
  }
}

function decodeAsciiNumericEntities(value: string): string {
  return value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hex, decimal) => {
    const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x7f
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function normalizedReference(value: string): string {
  return decodeAsciiNumericEntities(value)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase();
}

function isSafeResourceReference(value: string): boolean {
  const trimmed = decodeAsciiNumericEntities(value).trim();
  if (/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(trimmed)) return true;
  if (SAFE_DATA_IMAGE_PATTERN.test(trimmed)) return true;
  const normalized = normalizedReference(trimmed);
  return !normalized || normalized.startsWith('#');
}

function assertSafeCssValue(value: string): void {
  if (DANGEROUS_CSS_PATTERN.test(decodeAsciiNumericEntities(value))) {
    throw new UnsafeSvgError();
  }
  CSS_URL_PATTERN.lastIndex = 0;
  for (let match = CSS_URL_PATTERN.exec(value); match; match = CSS_URL_PATTERN.exec(value)) {
    const target = String(match[2] || '').trim();
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(decodeAsciiNumericEntities(target))) {
      throw new UnsafeSvgError('SVG 样式只能引用图内资源');
    }
  }
}

export function assertSafeSvgDocument(svg: string, maxBytes = 12 * 1024 * 1024): string {
  if (typeof svg !== 'string' || !svg.trim()) {
    throw new UnsafeSvgError('SVG 内容不能为空');
  }
  if (Buffer.byteLength(svg, 'utf8') > maxBytes) {
    throw new UnsafeSvgError('SVG 内容超过允许大小');
  }
  // Matplotlib emits this fixed public declaration. Remove it before parsing so
  // browsers never resolve the external DTD; all other declarations stay blocked.
  const normalizedSvg = svg.replace(MATPLOTLIB_SVG_11_DOCTYPE_PATTERN, '$1');
  const withoutXml = normalizedSvg.replace(/^\s*<\?xml[\s\S]*?\?>/i, '').trimStart();
  if (!/^(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(withoutXml)) {
    throw new UnsafeSvgError('SVG 根元素无效');
  }
  if (DECLARATION_PATTERN.test(normalizedSvg) || BLOCKED_ELEMENT_PATTERN.test(normalizedSvg) || EVENT_ATTRIBUTE_PATTERN.test(normalizedSvg)) {
    throw new UnsafeSvgError();
  }

  URI_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (let match = URI_ATTRIBUTE_PATTERN.exec(normalizedSvg); match; match = URI_ATTRIBUTE_PATTERN.exec(normalizedSvg)) {
    const value = String(match[1] ?? match[2] ?? match[3] ?? '');
    if (!isSafeResourceReference(value)) {
      throw new UnsafeSvgError('SVG 不能引用外部资源');
    }
  }
  URL_BEARING_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (let match = URL_BEARING_ATTRIBUTE_PATTERN.exec(normalizedSvg); match; match = URL_BEARING_ATTRIBUTE_PATTERN.exec(normalizedSvg)) {
    assertSafeCssValue(String(match[1] ?? match[2] ?? match[3] ?? ''));
  }
  STYLE_ELEMENT_PATTERN.lastIndex = 0;
  for (let match = STYLE_ELEMENT_PATTERN.exec(normalizedSvg); match; match = STYLE_ELEMENT_PATTERN.exec(normalizedSvg)) {
    assertSafeCssValue(String(match[1] || ''));
  }
  return normalizedSvg;
}
