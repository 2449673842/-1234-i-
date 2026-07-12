import { describe, expect, it } from 'vitest';
import { summarizeCodeChange } from './codeHistory';

describe('summarizeCodeChange', () => {
  it('does not create a change for identical scripts', () => {
    expect(summarizeCodeChange('a\nb', 'a\nb')).toMatchObject({
      changed: false,
      addedLines: 0,
      removedLines: 0,
      label: '无代码变化',
    });
  });

  it('summarizes a replacement without counting unchanged prefix and suffix', () => {
    expect(summarizeCodeChange('import x\na = 1\nplot(a)', 'import x\na = 2\nb = 3\nplot(a)')).toMatchObject({
      changed: true,
      addedLines: 2,
      removedLines: 1,
      label: '+2/-1 行',
    });
  });

  it('normalizes Windows line endings', () => {
    expect(summarizeCodeChange('a\r\nb', 'a\nb\nc')).toMatchObject({
      changed: true,
      addedLines: 1,
      removedLines: 0,
    });
  });
});
