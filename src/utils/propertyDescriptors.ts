import type { SemanticTargetRole } from '../schemas/editingIntent';
import type { ManifestObject, ManifestPropertyCapability } from '../schemas/manifest';
import type {
  CanonicalPropertyKey,
  EditingCenterId,
  PropertyProjectionRequest,
  ProjectedPropertyDescriptor,
  ProjectedPropertyState,
  PropertyDescriptor,
} from '../schemas/propertyDescriptor';

const TEXT_KINDS = new Set(['text', 'legend']);
const TICK_KINDS = new Set(['axis_x', 'axis_y', 'xtick', 'ytick', 'colorbar']);
const TICK_ROLES = new Set<SemanticTargetRole>([
  'x_tick_label',
  'y_tick_label',
  'colorbar_tick_label',
]);

export const PROPERTY_DESCRIPTOR_REGISTRY: readonly PropertyDescriptor[] = [
  {
    key: 'fontfamily',
    label: '字体家族',
    family: 'typography',
    valueType: 'string',
    control: 'font',
    unit: 'none',
    centers: ['properties', 'components', 'fonts'],
    props: ['fontfamily'],
    aliases: { tick_label: ['tick_labelfamily', 'tick_fontfamily'] },
  },
  {
    key: 'fontsize',
    label: '字号',
    family: 'typography',
    valueType: 'number',
    control: 'number',
    unit: 'pt',
    min: 1,
    max: 200,
    step: 0.5,
    centers: ['properties', 'components', 'fonts'],
    props: ['fontsize'],
    aliases: { tick_label: ['tick_labelsize', 'tick_fontsize'] },
  },
  {
    key: 'fontweight',
    label: '字重',
    family: 'typography',
    valueType: 'select',
    control: 'select',
    unit: 'none',
    options: ['normal', 'bold', 'semibold', 'light'],
    centers: ['properties', 'components', 'fonts'],
    props: ['fontweight'],
    aliases: { tick_label: ['tick_fontweight'] },
  },
  {
    key: 'fontstyle',
    label: '字形',
    family: 'typography',
    valueType: 'select',
    control: 'select',
    unit: 'none',
    options: ['normal', 'italic', 'oblique'],
    centers: ['properties', 'components', 'fonts'],
    props: ['fontstyle'],
    aliases: { tick_label: ['tick_fontstyle'] },
  },
  {
    key: 'color',
    label: '颜色',
    family: 'appearance',
    valueType: 'color',
    control: 'color',
    unit: 'none',
    centers: ['properties', 'components', 'palette', 'fonts'],
    props: ['color'],
    aliases: { tick_label: ['tick_labelcolor'] },
  },
  {
    key: 'rotation',
    label: '旋转角度',
    family: 'text_layout',
    valueType: 'number',
    control: 'number',
    unit: 'deg',
    min: -180,
    max: 180,
    step: 1,
    centers: ['properties', 'components', 'fonts'],
    props: ['rotation'],
    aliases: { tick_label: ['tick_rotation'] },
  },
  {
    key: 'ha', label: '水平对齐', family: 'text_layout', valueType: 'select', control: 'select', unit: 'none',
    options: ['left', 'center', 'right'], centers: ['properties', 'fonts'], props: ['ha'],
  },
  {
    key: 'va', label: '垂直对齐', family: 'text_layout', valueType: 'select', control: 'select', unit: 'none',
    options: ['top', 'center', 'baseline', 'bottom'], centers: ['properties', 'fonts'], props: ['va'],
  },
  {
    key: 'visible', label: '可见', family: 'visibility', valueType: 'boolean', control: 'toggle', unit: 'none',
    centers: ['properties', 'components'], props: ['visible'],
  },
  {
    key: 'alpha', label: '不透明度', family: 'appearance', valueType: 'number', control: 'number', unit: 'ratio',
    min: 0, max: 1, step: 0.05, centers: ['properties', 'components', 'palette'], props: ['alpha'],
  },
  {
    key: 'linewidth', label: '线宽', family: 'stroke', valueType: 'number', control: 'number', unit: 'pt',
    min: 0, max: 20, step: 0.1, centers: ['properties', 'components'], props: ['linewidth'],
  },
];

const DESCRIPTORS_BY_KEY = new Map(PROPERTY_DESCRIPTOR_REGISTRY.map(descriptor => [descriptor.key, descriptor]));

function unsupportedProps(object: ManifestObject): Set<string> {
  const unsupported = object.currentProps?.unsupportedProps;
  return new Set(Array.isArray(unsupported) ? unsupported.map(String) : []);
}

function capabilities(object: ManifestObject): ManifestPropertyCapability[] {
  return Array.isArray(object.propertyCapabilities) ? object.propertyCapabilities : [];
}

function capabilityFor(object: ManifestObject, prop: string): ManifestPropertyCapability | undefined {
  return capabilities(object).find(capability => capability.prop === prop);
}

function propIsKnown(object: ManifestObject, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(object.currentProps ?? {}, prop)
    || Array.isArray(object.editable) && object.editable.includes(prop)
    || Boolean(capabilityFor(object, prop));
}

function aliasGroup(object: ManifestObject, semanticRole?: SemanticTargetRole): 'tick_label' | 'text' | undefined {
  if ((semanticRole && TICK_ROLES.has(semanticRole)) || TICK_KINDS.has(object.kind)) return 'tick_label';
  if (TEXT_KINDS.has(object.kind)) return 'text';
  return undefined;
}

function candidateProps(
  descriptor: PropertyDescriptor,
  object: ManifestObject,
  semanticRole?: SemanticTargetRole,
): string[] {
  const group = aliasGroup(object, semanticRole);
  const aliases = group ? descriptor.aliases?.[group] ?? [] : [];
  const kindAliases = descriptor.aliases?.[object.kind] ?? [];
  return [...aliases, ...kindAliases, ...descriptor.props];
}

export function getPropertyDescriptor(key: CanonicalPropertyKey): PropertyDescriptor | undefined {
  return DESCRIPTORS_BY_KEY.get(key);
}

export function getPropertyDescriptorsForCenter(center: EditingCenterId): readonly PropertyDescriptor[] {
  return PROPERTY_DESCRIPTOR_REGISTRY.filter(descriptor => descriptor.centers.includes(center));
}

export function resolveCanonicalPropertyAlias(
  key: CanonicalPropertyKey,
  object: ManifestObject,
  semanticRole?: SemanticTargetRole,
): string | undefined {
  const descriptor = DESCRIPTORS_BY_KEY.get(key);
  if (!descriptor) return undefined;
  const candidates = candidateProps(descriptor, object, semanticRole);
  const unsupported = unsupportedProps(object);

  return candidates.find(prop => {
    const capability = capabilityFor(object, prop);
    return capability && capability.replay !== 'unsupported' && !unsupported.has(prop);
  })
    ?? candidates.find(prop => Boolean(capabilityFor(object, prop)))
    ?? candidates.find(prop => (
      !Array.isArray(object.propertyCapabilities)
      && Array.isArray(object.editable)
      && object.editable.includes(prop)
      && !unsupported.has(prop)
    ))
    ?? candidates.find(prop => propIsKnown(object, prop));
}

type ObjectProjectionState = 'editable' | 'readonly' | 'unsupported';

function projectObjectState(
  object: ManifestObject,
  prop: string | undefined,
  scope: import('../schemas/manifest').ManifestEditScope,
): {
  state: ObjectProjectionState;
  value: unknown;
  unsupportedReason?: string;
  conditional: boolean;
  legacyFallback: boolean;
} {
  if (!prop) return { state: 'unsupported', value: undefined, conditional: false, legacyFallback: false };

  const unsupported = unsupportedProps(object);
  const capability = capabilityFor(object, prop);
  if (unsupported.has(prop) || capability?.replay === 'unsupported') {
    return {
      state: 'unsupported',
      value: object.currentProps?.[prop],
      unsupportedReason: capability?.unsupportedReason,
      conditional: false,
      legacyFallback: false,
    };
  }

  if (capability) {
    if (!capability.scopes.includes(scope)) {
      return {
        state: 'readonly',
        value: object.currentProps?.[prop],
        unsupportedReason: `${prop} 不支持 ${scope} 作用域`,
        conditional: capability.replay === 'conditional',
        legacyFallback: false,
      };
    }
    return {
      state: 'editable',
      value: object.currentProps?.[prop],
      conditional: capability.replay === 'conditional',
      legacyFallback: false,
    };
  }

  if (!Array.isArray(object.propertyCapabilities) && Array.isArray(object.editable) && object.editable.includes(prop)) {
    return {
      state: 'editable',
      value: object.currentProps?.[prop],
      conditional: false,
      legacyFallback: true,
    };
  }

  if (Object.prototype.hasOwnProperty.call(object.currentProps ?? {}, prop)
    || Array.isArray(object.editable) && object.editable.includes(prop)) {
    return {
      state: 'readonly',
      value: object.currentProps?.[prop],
      unsupportedReason: Array.isArray(object.propertyCapabilities) ? `${prop} 缺少属性级 capability` : undefined,
      conditional: false,
      legacyFallback: false,
    };
  }

  return { state: 'unsupported', value: undefined, conditional: false, legacyFallback: false };
}

function stableValueKey(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

function aggregateState(
  total: number,
  editable: number,
  readonly: number,
  unsupported: number,
  editableValueKeys: Set<string>,
): ProjectedPropertyState {
  if (total === 0 || unsupported === total) return 'unsupported';
  if (editable === 0) return readonly > 0 ? 'readonly' : 'unsupported';
  if (editable < total) return 'partial';
  return editableValueKeys.size > 1 ? 'mixed' : 'editable';
}

function defaultScopeForCenter(center: EditingCenterId): import('../schemas/manifest').ManifestEditScope {
  if (center === 'components' || center === 'fonts' || center === 'palette') return 'group';
  return 'object';
}

export function projectPropertyDescriptors({
  center,
  objects: selection,
  semanticRole,
  scope = defaultScopeForCenter(center),
}: PropertyProjectionRequest): ProjectedPropertyDescriptor[] {
  const objects = Array.from(selection);

  return getPropertyDescriptorsForCenter(center).map((descriptor): ProjectedPropertyDescriptor => {
    const propByObjectId: Record<string, string | undefined> = {};
    const valuesByObjectId: Record<string, unknown> = {};
    const unsupportedReasons: Record<string, string | undefined> = {};
    const editableValueKeys = new Set<string>();
    let editable = 0;
    let readonly = 0;
    let unsupported = 0;
    let conditional = 0;
    let legacyFallback = 0;
    let firstEditableValue: unknown;

    for (const object of objects) {
      const prop = resolveCanonicalPropertyAlias(descriptor.key, object, semanticRole);
      const objectState = projectObjectState(object, prop, scope);
      propByObjectId[object.id] = prop;
      valuesByObjectId[object.id] = objectState.value;
      if (objectState.unsupportedReason) unsupportedReasons[object.id] = objectState.unsupportedReason;
      if (objectState.conditional) conditional += 1;
      if (objectState.legacyFallback) legacyFallback += 1;

      if (objectState.state === 'editable') {
        editable += 1;
        if (editable === 1) firstEditableValue = objectState.value;
        editableValueKeys.add(stableValueKey(objectState.value));
      } else if (objectState.state === 'readonly') {
        readonly += 1;
      } else {
        unsupported += 1;
      }
    }

    return {
      descriptor,
      key: descriptor.key,
      state: aggregateState(objects.length, editable, readonly, unsupported, editableValueKeys),
      scope,
      mixed: editableValueKeys.size > 1,
      counts: {
        total: objects.length,
        editable,
        readonly,
        unsupported,
        conditional,
        legacyFallback,
      },
      propByObjectId,
      value: editableValueKeys.size === 1 ? firstEditableValue : undefined,
      valuesByObjectId,
      unsupportedReasons,
    };
  });
}
