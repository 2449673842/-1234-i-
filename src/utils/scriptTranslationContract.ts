export type DataRow = Record<string, unknown>;

const STRICT_NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const CATEGORY_HEADER_RE = /(time|date|group|class|category|condition|treatment|stage|phase|时间|日期|处理|组|分组|类别|类型|阶段|批次)/i;
const TIME_HEADER_RE = /(time|date|hour|day|week|month|year|时间|日期|小时|天|周|月|年)/i;
const ID_HEADER_RE = /(^|_|\b)(id|index)(\b|$)|编号|序号/i;
const ERROR_HEADER_RE = /(sd|se|sem|std|stderr|error|err|ci|lower|upper|pvalue|p_value|padj|fdr|误差|标准差|标准误|置信区间)/i;

export interface InferredFieldTypes {
  numericFields: string[];
  stringFields: string[];
}

export interface DefaultFieldSelection {
  xField: string;
  yField: string;
  groupField: string;
  errField: string;
}

export interface TranslationPromptInput {
  headers: string[];
  rows: DataRow[];
  previewRows?: DataRow[];
  primaryDataFileName?: string;
  additionalDatasets?: TranslationPromptDataset[];
  xField?: string;
  yField?: string;
  groupField?: string;
  errField?: string;
  originalScript: string;
}

export interface TranslationPromptDataset {
  fileName: string;
  headers: string[];
  rows: DataRow[];
  previewRows?: DataRow[];
  mapping?: DefaultFieldSelection;
}

export function normalizeValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function isStrictNumericLike(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim().replace(/,/g, '');
  if (!trimmed) {
    return false;
  }
  return STRICT_NUMBER_RE.test(trimmed);
}

export function inferFieldTypes(rows: DataRow[], headers: string[]): InferredFieldTypes {
  const numericFields: string[] = [];
  const stringFields: string[] = [];

  for (const header of headers) {
    const nonEmptyValues = rows
      .slice(0, 100)
      .map(row => row[header])
      .filter(value => normalizeValue(value) !== '');
    const numericCount = nonEmptyValues.filter(isStrictNumericLike).length;

    if (nonEmptyValues.length > 0 && numericCount / nonEmptyValues.length >= 0.8) {
      numericFields.push(header);
    } else {
      stringFields.push(header);
    }
  }

  return { numericFields, stringFields };
}

function getUniqueNonEmptyValues(rows: DataRow[], header: string, limit = 100): string[] {
  return Array.from(
    new Set(
      rows
        .slice(0, limit)
        .map(row => normalizeValue(row[header]))
        .filter(Boolean),
    ),
  );
}

export function chooseDefaultFields(
  headers: string[],
  rows: DataRow[],
  numericFields: string[],
  stringFields: string[],
): DefaultFieldSelection {
  const orderedStringFields = [...stringFields].sort((a, b) => {
    const aScore = TIME_HEADER_RE.test(a) ? 2 : CATEGORY_HEADER_RE.test(a) ? 1 : 0;
    const bScore = TIME_HEADER_RE.test(b) ? 2 : CATEGORY_HEADER_RE.test(b) ? 1 : 0;
    if (aScore !== bScore) return bScore - aScore;
    return getUniqueNonEmptyValues(rows, a).length - getUniqueNonEmptyValues(rows, b).length;
  });

  const orderedNumericFields = [...numericFields].sort((a, b) => {
    const aPenalty = ID_HEADER_RE.test(a) ? 1 : 0;
    const bPenalty = ID_HEADER_RE.test(b) ? 1 : 0;
    if (aPenalty !== bPenalty) return aPenalty - bPenalty;
    return a.localeCompare(b);
  });

  const xField = orderedStringFields[0] || headers[0] || '';
  const groupField =
    orderedStringFields.find(field => field !== xField && CATEGORY_HEADER_RE.test(field))
    || orderedStringFields.find(field => field !== xField && getUniqueNonEmptyValues(rows, field).length <= 8)
    || '';
  const yField = orderedNumericFields[0] || headers[0] || '';
  const errField =
    orderedNumericFields.find(field => field !== yField && ERROR_HEADER_RE.test(field))
    || orderedNumericFields.find(field => field !== yField && !ID_HEADER_RE.test(field))
    || '';

  return { xField, yField, groupField, errField };
}

function buildNumericStatsLines(rows: DataRow[], numericFields: string[]): string[] {
  return numericFields
    .map(field => {
      const values = rows
        .map(row => {
          const raw = row[field];
          if (typeof raw === 'number') {
            return raw;
          }
          return parseFloat(String(raw));
        })
        .filter(value => !Number.isNaN(value));

      if (values.length === 0) {
        return null;
      }

      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
      const zeroCount = values.filter(value => value === 0).length;

      return `${field}: 范围 [${min}, ${max}]，均值 ${avg.toFixed(2)}，${values.length} 个非空值${zeroCount > 0 ? `，含 ${zeroCount} 个零值` : ''}`;
    })
    .filter((line): line is string => Boolean(line));
}

function buildSingleDatasetSummary(dataset: {
  fileName?: string;
  headers: string[];
  rows: DataRow[];
  previewRows?: DataRow[];
}, mapping?: DefaultFieldSelection): string {
  const previewRows = dataset.previewRows && dataset.previewRows.length > 0 ? dataset.previewRows : dataset.rows.slice(0, 5);
  const { numericFields, stringFields } = inferFieldTypes(dataset.rows, dataset.headers);
  const statsLines = buildNumericStatsLines(dataset.rows, numericFields);

  return [
    `文件名: ${dataset.fileName || '未选择'}`,
    `行数: ${dataset.rows.length}`,
    `列名: ${JSON.stringify(dataset.headers)}`,
    mapping?.xField ? `推荐 X 字段: ${mapping.xField}` : '',
    mapping?.yField ? `推荐 Y 字段: ${mapping.yField}` : '',
    mapping?.groupField ? `推荐分组字段: ${mapping.groupField}` : '推荐分组字段: 无',
    mapping?.errField ? `推荐误差字段: ${mapping.errField}` : '推荐误差字段: 无',
    previewRows.length > 0
      ? `数据预览（前 5 行）:\n${previewRows.map(row => JSON.stringify(row, null, 0)).join('\n')}`
      : '',
    stringFields.length > 0 ? `文本列: ${stringFields.join(', ')}` : '文本列: 无',
    numericFields.length > 0 ? `数值列: ${numericFields.join(', ')}` : '数值列: 无',
    statsLines.length > 0 ? `数值列统计:\n${statsLines.join('\n')}` : '数值列统计: 无',
  ].filter(Boolean).join('\n\n');
}

function buildDataSummary(input: TranslationPromptInput): string {
  const mapping: DefaultFieldSelection = {
    xField: input.xField || '',
    yField: input.yField || '',
    groupField: input.groupField || '',
    errField: input.errField || '',
  };
  const primarySummary = [
    `主数据文件: ${input.primaryDataFileName || '未选择'}`,
    buildSingleDatasetSummary({
      fileName: input.primaryDataFileName,
      headers: input.headers,
      rows: input.rows,
      previewRows: input.previewRows,
    }, mapping),
  ].join('\n\n');

  const additionalSummaries = (input.additionalDatasets || [])
    .map((dataset, index) => [
      `辅助数据文件 ${index + 1}: ${dataset.fileName}`,
      buildSingleDatasetSummary(dataset, dataset.mapping),
    ].join('\n\n'));

  if (additionalSummaries.length === 0) {
    return primarySummary;
  }

  return [
    primarySummary,
    '### 其他已上传数据文件',
    '以下文件与主数据一起上传。每个文件都有独立字段识别和独立推荐映射；不要把主数据的列名强行套到其他文件上，不能编造列名。',
    ...additionalSummaries,
  ].join('\n\n');
}

export function buildTranslationPrompt(input: TranslationPromptInput): string {
  return `## SciFigure 平台 — Matplotlib 脚本转译契约 v2

你是 SciFigure 的脚本转译器。你的任务不是自由改写，而是把“用户原始 Matplotlib 脚本”稳定转成“平台可执行、可复现、可继续编辑”的标准脚本。输出必须满足固定结构，不能输出解释文字，不能遗漏任何必需段落。

---

### 一、运行环境
- Python 3.x, matplotlib（Agg 后端）, numpy, pandas, scipy
- 字体回退链：SimHei, Microsoft YaHei, Noto Sans CJK SC, Times New Roman, Arial
- 默认画幅 100mm × 80mm, 150 DPI

### 二、数据接入（硬约束 — 单文件和多文件分开处理）

**1）单文件任务：** 数据注入到 \`_uploaded_data\`（list[dict]）
\`\`\`python
df = pd.DataFrame(_uploaded_data)
\`\`\`

**2）多文件任务：** 所有上传文件的路径都会注入到 \`_uploaded_file_paths\`（dict[str, str]），键包括原始文件名（含扩展名）和去扩展名文件名，值是服务器存储路径。
\`\`\`python
# 正确：按文件名读取每个已上传文件
df_stats = pd.read_csv(_uploaded_file_paths["FL9_机制变量统计表.csv"])
df_matrix = pd.read_csv(_uploaded_file_paths["FL9_机制重绘输入矩阵.csv"])
df_excel = pd.read_excel(_uploaded_file_paths["OPR_FeP二维交互响应图_绘图数据.xlsx"], sheet_name="输入数据与预测")

# _uploaded_data 只代表用户标记的主数据，不要把它假定成某个辅助 CSV 或统计表
\`\`\`
**多文件脚本规则：** 如果原始脚本或任务里出现了明确文件名，必须通过 \`_uploaded_file_paths["文件名"]\` 读取该文件。不要把 \`_uploaded_data\` 当成任意表的替代品。

**3）规则总结**

| 文件类型 | 数据在哪 | 如何读取 |
|---------|---------|---------|
| 单文件主数据 | \`_uploaded_data\` 已注入 | \`pd.DataFrame(_uploaded_data)\` |
| 任意已上传具名文件 | 路径在 \`_uploaded_file_paths\` | \`pd.read_csv/read_excel(_uploaded_file_paths["文件名"])\` |
| 未上传的文件 | ❌ 无法访问 | — |

**严禁**：\`open\` / \`Path(...)\` / 任意本地绝对路径 / 网络路径 / \`plt.savefig\` / \`plt.show\`

### 三、多 Figure 支持（脚本可生成任意数量 Figure）

平台自动捕获脚本中创建的所有 **matplotlib Figure**，不需要手动注册、不需要返回对象、不需要 savefig。

**捕获机制：** \`Figure.__init__\` 钩子 + \`plt.get_fignums()\` 双重保障。脚本里每调一次 \`plt.subplots()\` 或 \`plt.figure()\` 就创建一个独立 Figure。

**每张 Figure 的行为：**
- 分配唯一 ID（\`fig_1\`, \`fig_2\`, ...）
- 拥有独立的 Manifest / EditLog / SVG / Revision
- 在前端以独立 Tab 展示，可单独编辑、撤销、导出
- 互不影响

**多 Figure 脚本的结构：**
\`\`\`python
# Figure 1
fig1, ax1 = plt.subplots(figsize=(100/25.4, 80/25.4), dpi=150)
ax1.plot(...)
ax1.set_title("Figure 1 Title")
ax1.legend()

# Figure 2（可以用不同数据、不同图表类型）
fig2, ax2 = plt.subplots(figsize=(100/25.4, 80/25.4), dpi=150)
ax2.scatter(...)
ax2.set_title("Figure 2 Title")

# 不需要任何额外代码，平台会自动捕获所有 Figure
\`\`\`

**如果脚本只生成一张图，就只写一张。** 多图脚本适用场景：同一个项目需要展示不同维度（如 SHAP 重要性图 + 模型指标表 + 分类散点图），每张图的配色和风格应该保持一致。

### 四、输出格式（必须逐段出现，函数名必须一致）
输出脚本必须严格包含以下 6 个区块，顺序不可变：
1. \`from __future__ import annotations\`
2. 必要 imports
3. 常量区
4. \`configure_matplotlib() -> None\`
5. \`load_data() -> pd.DataFrame\`
6. \`build_figure(df: pd.DataFrame) -> None\`

文件结尾必须严格是：
\`\`\`python
df = load_data()
build_figure(df)
\`\`\`

### 五、推荐骨架（按此格式输出）
\`\`\`python
from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

PRIMARY_COLOR = "#1F78B4"
SECONDARY_COLOR = "#D62728"

def configure_matplotlib() -> None:
    ...

def load_data() -> pd.DataFrame:
    df = pd.DataFrame(_uploaded_data)
    # 多文件任务必须按文件名读取 _uploaded_file_paths 中的各数据表
    ...
    return df

def build_figure(df: pd.DataFrame) -> None:
    configure_matplotlib()
    fig, ax = plt.subplots(figsize=(100 / 25.4, 80 / 25.4), dpi=150)
    ...
    plt.tight_layout()

df = load_data()
build_figure(df)
\`\`\`

### 六、可识别图元与可编辑属性
| 图元 | GID 格式 | 可编辑属性 |
|------|----------|-----------|
| 标题 | title.{ax_idx} | text, fontsize, color, fontfamily |
| X/Y 轴标签 | xlabel.{idx} / ylabel.{idx} | text, fontsize, color, fontfamily |
| 刻度标签 | xtick.{idx}.{i} / ytick.{idx}.{i} | text, fontsize, color, fontfamily, rotation |
| 脊柱 | spine.{side}.{idx} | visible, color, linewidth |
| 折线 | line.{idx}.{i} | color, linewidth, linestyle, alpha |
| 散点/填充 | collection.{idx}.{i} | facecolor, edgecolor, alpha, linewidth |
| 图例 | legend.{idx} | visible, fontsize, facecolor |

### 七、样式约定（推荐）
- 白色背景，无网格线
- 四边脊柱全显示
- 配色使用十六进制色值
- 尽量使用标准 API：\`ax.plot\` / \`ax.bar\` / \`ax.scatter\` / \`ax.barh\` / \`ax.boxplot\`
- 图例优先使用 \`ax.legend()\`，避免复杂锚点

### 八、安全限制（会被拦截）
os / sys / subprocess / builtins / shutil / socket / urllib / requests / eval / exec / compile / __import__ / globals / locals / open / Path / 网络请求 / 任何未上传文件路径

### 九、转译要求（必须满足）
1. 只返回纯 Python 代码，不要 markdown 包裹，不要解释文字
2. 输出必须是完整脚本，不是 diff、不是片段、不是伪代码
3. 列名必须与真实数据精确匹配；如果原脚本列名不对，直接修正
4. \`.str\` 访问器只能用于真实字符串列，不能对数值列使用
5. 随机过程必须固定 seed，避免同一输入每次渲染结果漂移
6. 不要写 \`if __name__ == "__main__":\`
7. 不要写 \`open\`、\`Path\`、本地绝对路径或网络路径；已上传文件只能通过 \`_uploaded_file_paths\` + pandas 读取
8. 多文件脚本必须按文件名读取每个具名数据表；不要把 \`_uploaded_data\` 当成某个 CSV/Excel 的替代品
9. 保留原图科研意图：图类型、分组逻辑、排序逻辑、统计逻辑、标题和配色语义
10. \`set_xticks\` / \`set_xticklabels\` 数量必须一致
11. 如果脚本只需要一张图，就只创建一张图；不要无故拆成多图

### 十、自检清单（这些条件必须在代码层面成立）
- 单文件数据可来自 \`_uploaded_data\`；多文件具名数据表必须来自 \`_uploaded_file_paths\`
- 脚本可以直接运行
- 没有文件 I/O / 网络 / savefig / show
- 列名与数据一致
- figure 由 matplotlib 正常创建
- 同一输入可重复渲染

---

### 本次任务数据
${buildDataSummary(input)}

### 用户原始脚本
${input.originalScript}`;
}
