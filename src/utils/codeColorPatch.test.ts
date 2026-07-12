import { describe, expect, it } from 'vitest';
import { applyColorCodePatch } from './codeColorPatch';

describe('applyColorCodePatch', () => {
  it('replaces a named constant and rejects a missing target', () => {
    expect(applyColorCodePatch('BLUE = "#112233"', {
      target_id: 'BLUE',
      new_value: '#445566',
    })).toBe('BLUE = "#445566"');
    expect(() => applyColorCodePatch('BLUE = "#112233"', {
      target_id: 'RED',
      new_value: '#445566',
    })).toThrow('未找到可替换的颜色常量');
  });

  it('replaces a key only inside the named typed dictionary', () => {
    const script = [
      'FIRST = {"Weak": "#111111"}',
      'SERIES_COLORS: dict[str, str] = {',
      '    "Weak": "#222222",',
      '}',
    ].join('\n');
    const updated = applyColorCodePatch(script, {
      target_id: 'dict_SERIES_COLORS__Weak',
      new_value: '#abcdef',
    });
    expect(updated).toContain('FIRST = {"Weak": "#111111"}');
    expect(updated).toContain('"Weak": "#abcdef"');
  });

  it('replaces only the requested inline occurrence', () => {
    const updated = applyColorCodePatch('colors = ["#112233", "#112233"]', {
      target_id: 'inline_1_2_112233',
      new_value: '#abcdef',
    });
    expect(updated).toBe('colors = ["#112233", "#abcdef"]');
  });
});
