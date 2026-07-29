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
    expect(prompt).toContain('_scifigure_semantic_gid');
    expect(prompt).toContain('diagram_type` 只能使用 `network`、`path` 或 `sem`');
    expect(prompt).toContain('不得按绘制顺序、颜色、屏幕位置或显示文字猜测身份');
    expect(prompt).toContain('系数文字、显著性和拟合指标保持原始内容');
    expect(prompt).toContain('用作分组、节点、路径、标签或语义 GID 身份的列必须先检查缺失值');
    expect(prompt).toContain('不得对可能为 `None`/`NaN` 的值直接调用 `.lower()`');
    expect(prompt).toContain('df = df.dropna(subset=["group"]).copy()');
    expect(prompt).toContain('不得对整表无条件 `dropna()` 或伪造分组名');
    expect(prompt).toContain('用所有节点、路径和标签的实际最小/最大边界加 padding 设置 `xlim/ylim`');
    expect(prompt).toContain('禁止固定写 `ax.set_ylim(0, 1)`');
    expect(prompt).toContain('扩大 Figure 或白底画布不能恢复已经被 axes clip 的内容');
  });
});
