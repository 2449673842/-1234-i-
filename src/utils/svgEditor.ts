import type { Manifest } from '../schemas/manifest';

export interface SvgEditableObject {
  id: string;
  tagName: string;
  kind: 'text' | 'shape';
  label: string;
  textContent?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  fontSize?: string;
  fontFamily?: string;
  fontWeight?: string;
  x?: string;
  y?: string;
}

export type SvgPatch = Partial<Pick<SvgEditableObject, 'textContent' | 'fill' | 'stroke' | 'strokeWidth' | 'fontSize' | 'fontFamily' | 'fontWeight' | 'x' | 'y'>>;
export type SvgPatchMap = Record<string, SvgPatch>;

const BLOCKED_SVG_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'discard',
  'handler',
  'listener',
  'feimage',
]);

const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const DANGEROUS_STYLE_PATTERN = /(?:@import|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|data\s*:\s*(?:text\/html|application\/xhtml\+xml))/i;
const CSS_URL_PATTERN = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;

function isSafeFragmentReference(value: string): boolean {
  return /^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value.trim());
}

function hasOnlySafeCssReferences(value: string): boolean {
  if (DANGEROUS_STYLE_PATTERN.test(value)) return false;
  CSS_URL_PATTERN.lastIndex = 0;
  for (let match = CSS_URL_PATTERN.exec(value); match; match = CSS_URL_PATTERN.exec(value)) {
    if (!isSafeFragmentReference(String(match[2] || ''))) return false;
  }
  return true;
}

function isSafeUriAttribute(element: Element, value: string): boolean {
  if (isSafeFragmentReference(value)) return true;
  return element.localName.toLowerCase() === 'image' && SAFE_DATA_IMAGE_PATTERN.test(value.trim());
}

export function sanitizeSvg(svg: string) {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return '';
  if (typeof svg !== 'string' || !svg.trim() || svg.length > 50 * 1024 * 1024) return '';

  const source = svg
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim();
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror')) return '';
  const root = document.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') return '';

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    const tagName = element.localName.toLowerCase();
    if (BLOCKED_SVG_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }
    if (tagName === 'style' && !hasOnlySafeCssReferences(element.textContent || '')) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || localName.startsWith('on') || name === 'xml:base') {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (localName === 'href' || localName === 'src') {
        if (tagName === 'a' || !isSafeUriAttribute(element, value)) {
          element.removeAttributeNode(attribute);
        }
        continue;
      }
      if ((name === 'style' || value.toLowerCase().includes('url(')) && !hasOnlySafeCssReferences(value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function setInlineStyle(element: Element, prop: string, value: string) {
  const style = element.getAttribute('style') || '';
  const declarations = style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.split(':')[0]?.trim().toLowerCase() !== prop.toLowerCase());
  declarations.push(`${prop}: ${value}`);
  element.setAttribute('style', declarations.join('; '));
}

function getInlineStyleValue(element: Element, prop: string) {
  const style = element.getAttribute('style') || '';
  const match = style
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.split(':')[0]?.trim().toLowerCase() === prop.toLowerCase());
  return match?.split(':').slice(1).join(':').trim() || '';
}

function patchElementAttribute(element: Element, prop: string, value: unknown) {
  const nextValue = value == null ? '' : String(value);
  const tagName = element.tagName.toLowerCase();
  switch (prop) {
    case 'text':
      element.textContent = nextValue;
      break;
    case 'color':
      if (tagName === 'text' || tagName === 'tspan') {
        element.setAttribute('fill', nextValue);
        setInlineStyle(element, 'fill', nextValue);
      } else if (
        element.hasAttribute('stroke') ||
        (getInlineStyleValue(element, 'stroke') && getInlineStyleValue(element, 'fill') === 'none')
      ) {
        element.setAttribute('stroke', nextValue);
        setInlineStyle(element, 'stroke', nextValue);
      } else {
        element.setAttribute('fill', nextValue);
        setInlineStyle(element, 'fill', nextValue);
      }
      break;
    case 'visible':
      element.setAttribute('visibility', value ? 'visible' : 'hidden');
      break;
    case 'facecolor':
      element.setAttribute('fill', nextValue);
      setInlineStyle(element, 'fill', nextValue);
      break;
    case 'edgecolor':
      element.setAttribute('stroke', nextValue);
      setInlineStyle(element, 'stroke', nextValue);
      break;
    case 'linewidth':
      element.setAttribute('stroke-width', nextValue);
      setInlineStyle(element, 'stroke-width', nextValue);
      break;
    case 'fontsize':
      element.setAttribute('font-size', nextValue);
      setInlineStyle(element, 'font-size', nextValue);
      break;
    case 'fontfamily':
      element.setAttribute('font-family', nextValue);
      setInlineStyle(element, 'font-family', nextValue);
      break;
    case 'alpha':
      element.setAttribute('opacity', nextValue);
      setInlineStyle(element, 'opacity', nextValue);
      break;
    default:
      break;
  }
}

function patchElementTree(root: Element, prop: string, value: unknown) {
  patchElementAttribute(root, prop, value);

  if (root.tagName.toLowerCase() !== 'g') {
    return;
  }

  const selector = prop === 'color'
    ? 'text,tspan,path,use,rect,circle,ellipse,line,polyline,polygon'
    : prop === 'facecolor'
      ? 'path,use,rect,circle,ellipse,polygon,polyline'
      : prop === 'edgecolor' || prop === 'linewidth'
        ? 'path,use,rect,circle,ellipse,line,polyline,polygon'
        : prop === 'fontsize' || prop === 'fontfamily'
          ? 'text,tspan'
          : prop === 'alpha' || prop === 'visible'
            ? '*'
            : '';

  if (!selector) {
    return;
  }

  root.querySelectorAll(selector).forEach((child) => {
    patchElementAttribute(child, prop, value);
  });
}

export interface SvgRuntimePatch {
  gid: string;
  prop: string;
  value: unknown;
}

export function applyRuntimePatchesToSvg(svg: string, patches: SvgRuntimePatch[]) {
  if (!svg || patches.length === 0 || typeof DOMParser === 'undefined') {
    return svg;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');

  for (const patch of patches) {
    const target = doc.getElementById(patch.gid);
    if (!target) continue;
    patchElementTree(target, patch.prop, patch.value);
  }

  return new XMLSerializer().serializeToString(doc);
}

export function applyRuntimePatchesToManifest(manifest: Manifest | null, patches: SvgRuntimePatch[]) {
  if (!manifest || patches.length === 0) {
    return manifest;
  }

  const nextManifest: Manifest = {
    ...manifest,
    globals: { ...manifest.globals },
    objects: manifest.objects.map((obj) => ({
      ...obj,
      currentProps: { ...obj.currentProps },
    })),
  };

  for (const patch of patches) {
    if (patch.gid === 'global') {
      const field = nextManifest.globals[patch.prop];
      if (field) {
        nextManifest.globals[patch.prop] = {
          ...field,
          value: patch.value as never,
        };
      }
      continue;
    }

    const object = nextManifest.objects.find((item) => item.id === patch.gid);
    if (!object) continue;
    object.currentProps[patch.prop] = patch.value;
  }

  return nextManifest;
}
