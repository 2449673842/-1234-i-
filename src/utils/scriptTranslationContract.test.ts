import { describe, expect, it } from 'vitest';
import { buildTranslationPrompt } from './scriptTranslationContract';

describe('script translation color contract', () => {
  it('requires one authoritative color source per semantic group', () => {
    const prompt = buildTranslationPrompt({
      headers: ['group', 'value'],
      rows: [{ group: 'A', value: 1 }],
      originalScript: 'import matplotlib.pyplot as plt',
      scriptLanguage: 'python',
    });

    expect(prompt).toContain('每个语义分组只能有一个权威颜色常量');
    expect(prompt).toContain('c=df["Color"]');
    expect(prompt).toContain('修改一个组只重绘该组');
  });
});
