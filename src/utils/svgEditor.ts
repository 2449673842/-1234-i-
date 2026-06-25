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

export function sanitizeSvg(svg: string) {
  return svg
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\s(on[a-z0-9:_-]+)=(".*?"|'.*?')/gi, '')
    .trim();
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
