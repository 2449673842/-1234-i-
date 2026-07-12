import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedPropertyDescriptor } from '../schemas/propertyDescriptor';
import { PropertyControl, isProjectedPropertyInteractive } from './PropertyControl';

function projection(overrides: Partial<ProjectedPropertyDescriptor> = {}): ProjectedPropertyDescriptor {
  return {
    descriptor: {
      key: 'fontsize',
      label: '字号',
      family: 'typography',
      valueType: 'number',
      control: 'number',
      unit: 'pt',
      min: 1,
      max: 200,
      step: 0.5,
      centers: ['properties'],
      props: ['fontsize'],
    },
    key: 'fontsize',
    state: 'editable',
    counts: { total: 1, editable: 1, readonly: 0, unsupported: 0, conditional: 0, legacyFallback: 0 },
    scope: 'object',
    mixed: false,
    stateByObjectId: { 'title.0': 'editable' },
    propByObjectId: { 'title.0': 'fontsize' },
    value: 12,
    valuesByObjectId: { 'title.0': 12 },
    unsupportedReasons: {},
    ...overrides,
  };
}

describe('PropertyControl', () => {
  it('renders descriptor limits and the resolved renderer property', () => {
    const html = renderToStaticMarkup(
      <PropertyControl projection={projection()} objectId="title.0" onChange={vi.fn()} />,
    );

    expect(html).toContain('data-property-control="fontsize"');
    expect(html).toContain('data-param-prop="fontsize"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="200"');
    expect(html).toContain('step="0.5"');
  });

  it('disables unsupported capabilities and exposes their state', () => {
    const unsupported = projection({
      state: 'unsupported',
      counts: { total: 1, editable: 0, readonly: 0, unsupported: 1, conditional: 0, legacyFallback: 0 },
      unsupportedReasons: { 'title.0': 'renderer cannot replay fontsize' },
    });
    const html = renderToStaticMarkup(
      <PropertyControl projection={unsupported} objectId="title.0" onChange={vi.fn()} />,
    );

    expect(isProjectedPropertyInteractive(unsupported)).toBe(false);
    expect(html).toContain('data-property-state="unsupported"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('renderer cannot replay fontsize');
  });

  it('shows mixed state without inventing a first value', () => {
    const mixed = projection({
      state: 'mixed',
      mixed: true,
      value: undefined,
      valuesByObjectId: { 'title.0': undefined },
    });
    const html = renderToStaticMarkup(
      <PropertyControl projection={mixed} objectId="title.0" onChange={vi.fn()} />,
    );

    expect(isProjectedPropertyInteractive(mixed)).toBe(true);
    expect(html).toContain('placeholder="混合值"');
    expect(html).toContain('混合值');
  });

  it('renders a contextual label and stable control scope', () => {
    const html = renderToStaticMarkup(
      <PropertyControl
        projection={projection()}
        objectId="title.0"
        label="统一修改代码颜色"
        controlScope="palette:SERIES"
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain('统一修改代码颜色');
    expect(html).toContain('data-property-scope="palette:SERIES"');
  });
});
