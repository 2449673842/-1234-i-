import { describe, expect, it } from 'vitest';
import {
  sanitizeLegacyRetireObservationBatch,
  sanitizeLegacyRetireObservationEvent,
} from './legacyRetireObservation';

describe('legacy retire observation privacy boundary', () => {
  it('keeps only aggregate descriptor metadata and redacts unknown keys and object kinds', () => {
    const event = sanitizeLegacyRetireObservationEvent({
      eventType: 'legacy_descriptor_projection',
      generatedBy: 'introspection',
      center: 'fonts',
      scope: 'group',
      objectCount: 4,
      protocolCompleteCount: 3,
      objectKindCounts: { text: 4, 'private-project-title': 1 },
      properties: [{
        key: 'private-secret-prop',
        state: 'partial',
        editableCount: 3,
        readonlyCount: 1,
        unsupportedCount: 0,
        legacyFallbackCount: 1,
        objectId: 'title.0',
        value: '#cc0000',
      }],
      projectId: 'private-project',
      script: 'do not collect',
    });

    expect(event).toEqual({
      eventType: 'legacy_descriptor_projection',
      generatedBy: 'introspection',
      center: 'fonts',
      scope: 'group',
      objectCount: 4,
      protocolCompleteCount: 3,
      objectKindCounts: { text: 4 },
      properties: [{
        key: 'other',
        state: 'partial',
        editableCount: 3,
        readonlyCount: 1,
        unsupportedCount: 0,
        legacyFallbackCount: 1,
      }],
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('title.0');
    expect(serialized).not.toContain('#cc0000');
    expect(serialized).not.toContain('private-project');
    expect(serialized).not.toContain('do not collect');
  });

  it('redacts resolver values and clamps counts', () => {
    const event = sanitizeLegacyRetireObservationEvent({
      eventType: 'legacy_resolver_path',
      source: 'font-center',
      center: 'fonts',
      intent: 'style.text.title',
      prop: 'fontsize',
      selectionMode: 'role_in_figure',
      targetRole: 'title',
      strategy: 'strict',
      fallbackReason: 'missing_identity',
      patchCount: -3,
      skippedCount: 2,
      ambiguousCount: 0,
      missingIdentityCount: Number.POSITIVE_INFINITY,
      missingCapabilityCount: 1,
      requestedObjectIds: ['title.0'],
      operationValue: 17,
    });

    expect(event).toMatchObject({
      prop: 'fontsize',
      patchCount: 0,
      skippedCount: 2,
      missingIdentityCount: 0,
      missingCapabilityCount: 1,
    });
    expect(JSON.stringify(event)).not.toContain('title.0');
    expect(JSON.stringify(event)).not.toContain('operationValue');
  });

  it('rejects unknown event shapes and caps batch size', () => {
    expect(sanitizeLegacyRetireObservationEvent({ eventType: 'unknown', value: 'secret' })).toBeNull();
    const events = Array.from({ length: 120 }, () => ({
      eventType: 'legacy_ui_surface_rendered',
      surface: 'font_controls_rollback',
      center: 'fonts',
      controlFamily: 'common',
      renderedControlCount: 5,
    }));
    expect(sanitizeLegacyRetireObservationBatch(events)).toHaveLength(100);
  });
});
