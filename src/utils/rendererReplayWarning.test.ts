import { describe, expect, it } from 'vitest';

import { isRendererReplayConflictWarning } from './rendererReplayWarning';

describe('isRendererReplayConflictWarning', () => {
  it.each([
    'Duplicated aesthetics after name standardisation: colour',
    'Duplicated `override.aes` is ignored.',
    'R process exited with code 3221225477 after producing JSON output.',
    'font family Times New Roman not found; using fallback',
  ])('does not treat an ordinary runtime warning as an edit replay conflict: %s', (warning) => {
    expect(isRendererReplayConflictWarning(warning)).toBe(false);
  });

  it.each([
    { type: 'missing_gid', gid: 'line.0', prop: 'color' },
    { type: 'identity_mismatch', gid: 'line.0', prop: 'color' },
    { type: 'ambiguous_identity', gid: 'line.0', prop: 'color' },
    { type: 'unsupported_prop', gid: 'line.0', prop: 'color' },
    { type: 'no_setter', gid: 'line.0', prop: 'color' },
    { type: 'unsupported_collection', gid: 'collection.0', prop: 'color' },
    { type: 'apply_error:ValueError', gid: 'line.0', prop: 'color' },
  ])('blocks structured renderer replay failures: $type', (warning) => {
    expect(isRendererReplayConflictWarning(warning)).toBe(true);
  });

  it('does not infer a replay failure from the message of a structured runtime diagnostic', () => {
    expect(isRendererReplayConflictWarning({
      type: 'missing_font',
      message: 'Font family was not found and the fallback was used.',
    })).toBe(false);
  });

  it.each([
    'missing_gid: line.0',
    '[unsupported_prop] line.0.color',
    'apply_error:ValueError while applying line.0.color',
  ])('keeps explicit legacy replay-warning strings fail-closed: %s', (warning) => {
    expect(isRendererReplayConflictWarning(warning)).toBe(true);
  });
});
