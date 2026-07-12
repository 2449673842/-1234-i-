export type HelpCategoryId =
  | "quick_start"
  | "templates"
  | "code_rules"
  | "ai_translation"
  | "editing_export";

export interface HelpFaq {
  id: string;
  category: HelpCategoryId;
  question: string;
  answer: string | string[];
}

export interface HelpTemplate {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  image: string;
  pythonCode: string;
  rCode: string;
  csvData: string;
  highlights: string[];
}

export interface QuickStartStep {
  id: string;
  title: string;
  description: string;
  checklist: string[];
}

export type PublicPromptLanguage = "python" | "r";

export const publicAiDrawingPrompts: Record<PublicPromptLanguage, string> = {
  python: `你是一名科研数据可视化工程师。请基于我提供的数据文件和绘图要求，直接生成可在 SciFigure Studio 中运行的 Python 绘图脚本。

我的绘图要求：
[在这里写图形类型、X/Y 字段、分组、统计方法、配色、尺寸和版式要求]

数据文件：
[在这里列出上传给你的原始文件名；请先理解字段和数据结构，但最终只输出代码]

必须遵守以下公开运行规范：
1. 最终只返回完整 Python 代码，不要 Markdown 代码围栏、解释、标题或运行说明。
2. 使用 pandas、numpy、matplotlib、scipy 等常规科研绘图库；优先使用 Matplotlib 原生高阶 API。
3. 单一主数据表可使用 df = pd.DataFrame(_uploaded_data)。
4. 多文件必须按原始文件名显式读取，例如 pd.read_csv(_uploaded_file_paths["原始文件名.csv"]) 或 pd.read_excel(_uploaded_file_paths["原始文件名.xlsx"])；不要猜测 _uploaded_data 代表哪张辅助表。
5. 每张表读取后检查必需列；缺列时抛出包含文件名、缺失列和当前列的清晰错误。
6. 使用 fig, ax = plt.subplots(...) 或明确的多子图结构创建 Figure。不要调用 plt.show()、plt.savefig()，不要在脚本内导出文件。
7. 不使用本机绝对路径、当前工作目录、__file__、open、pathlib 文件读写、os、sys、subprocess、requests、socket 或任何复制归档逻辑。
8. 柱图使用 ax.bar/barh，误差棒使用 ax.errorbar，散点使用 ax.scatter，热图使用 imshow/pcolormesh；不要用大量底层矩形、线段或像素块手工拼图。
9. 色条必须把真实 mappable 显式传给 fig.colorbar(mappable, ax=ax)。
10. 为标题、坐标轴、图例和统计标注设置清晰文本；颜色尽量定义为有语义的命名常量。
11. 代码必须能够直接执行并生成 Figure；不要要求我再手工补充未说明的变量。

现在根据我的数据和要求输出最终纯 Python 代码。`,
  r: `你是一名科研数据可视化工程师。请基于我提供的数据文件和绘图要求，直接生成可在 SciFigure Studio 中运行的 R 绘图脚本。

我的绘图要求：
[在这里写图形类型、X/Y 字段、分组、统计方法、配色、尺寸和版式要求]

数据文件：
[在这里列出上传给你的原始文件名；请先理解字段和数据结构，但最终只输出代码]

必须遵守以下公开运行规范：
1. 最终只返回完整 R 代码，不要 Markdown 代码围栏、解释、标题或运行说明。
2. 优先使用 ggplot2 或基础 R 原生绘图能力；只加载完成绘图确实需要的常规科研包。
3. 所有数据文件必须按原始文件名从 uploaded_file_paths 读取，例如 read.csv(uploaded_file_paths[["原始文件名.csv"]]) 或 readxl::read_excel(uploaded_file_paths[["原始文件名.xlsx"]])。
4. 每张表读取后检查必需列；缺列时 stop()，错误信息包含文件名、缺失列和当前列。
5. ggplot2 图层优先使用 geom_col、geom_errorbar、geom_point、geom_line、geom_boxplot、geom_tile 等原生高阶图层。
6. 不调用 ggsave、png、pdf、jpeg、tiff 或其他设备导出函数；脚本只负责创建图形。
7. 不使用本机绝对路径、setwd、file.choose、系统命令、网络请求或文件复制归档逻辑。
8. 为标题、坐标轴、图例、色条和统计标注设置清晰文本；颜色尽量定义为有语义的命名常量。
9. 多面板优先使用 facet、patchwork 或明确的 grid 布局；不要用大量底层图元手工拼接常规图形。
10. 代码必须能够直接执行并生成最终图形；不要要求我再手工补充未说明的变量。

现在根据我的数据和要求输出最终纯 R 代码。`,
};

export const quickStartSteps: QuickStartStep[] = [
  {
    id: "choose-starting-point",
    title: "选择你的起点",
    description:
      "已有 Codex、Claude Code、DeepSeek 等工具写好的脚本，就直接带脚本和数据导入；没有脚本时，可从帮助页模板复制 Python/R 代码与示例 CSV 开始。",
    checklist: [
      "已有脚本：确认它在本地或原工具中能运行",
      "使用模板：先选择与数据结构最接近的图形",
      "确认准备使用 Python 还是 R",
    ],
  },
  {
    id: "import-script-first",
    title: "先放入绘图脚本",
    description:
      "进入“新建图形项目”，上传、拖入或粘贴 .py/.R。平台只读取代码依赖，不会在这一步执行脚本，并会提示脚本引用了哪些数据文件。",
    checklist: [
      "脚本可直接粘贴，也可上传 .py 或 .R 文件",
      "检查平台识别出的 CSV/Excel 文件名",
      "Python/R 类型识别错误时手动切换语言",
    ],
  },
  {
    id: "complete-data-config",
    title: "补齐数据并检查配置",
    description:
      "按提示上传脚本需要的 CSV/Excel，也可以加入其他分析表。确认主数据文件、字段结构和最终脚本后，再创建项目。",
    checklist: [
      "保留脚本引用的原始文件名",
      "检查必需文件是否全部补齐",
      "确认主数据表和字段预览正确",
    ],
  },
  {
    id: "render-edit-export",
    title: "创建、渲染并精修",
    description:
      "创建项目后进入编辑器，先确认 Figure 正常生成，再点选图元、批量统一字体与配色、调整布局，最后从导出页生成科研格式文件。",
    checklist: [
      "渲染失败时先看缺失文件、列名和报错定位",
      "多项样式修改可暂存后一次应用",
      "导出前检查真实尺寸、字体和图例",
    ],
  },
];

export const helpTemplates: HelpTemplate[] = [
  {
    id: "grouped-bar-error",
    title: "分组柱状图 + 误差棒",
    eyebrow: "Grouped bar",
    description:
      "适合比较不同处理组在多个时间点或条件下的均值，并展示标准误或置信区间。",
    image: "/help-template-grouped-bar.png",
    csvData: `condition,group,mean,se
Control,Low N,4.2,0.35
Control,High N,5.1,0.42
Treatment A,Low N,5.8,0.40
Treatment A,High N,6.7,0.48
Treatment B,Low N,6.3,0.44
Treatment B,High N,7.5,0.51`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

COLOR_LOW_N = "#4C78A8"
COLOR_HIGH_N = "#F58518"

df = pd.DataFrame(_uploaded_data)
required_columns = ["condition", "group", "mean", "se"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

conditions = list(dict.fromkeys(df["condition"]))
groups = list(dict.fromkeys(df["group"]))
x = np.arange(len(conditions))
bar_width = 0.36
colors = [COLOR_LOW_N, COLOR_HIGH_N]

fig, ax = plt.subplots(figsize=(4.8, 3.2), dpi=150)

for index, group in enumerate(groups):
    subset = df[df["group"] == group].set_index("condition").loc[conditions]
    offset = (index - (len(groups) - 1) / 2) * bar_width
    ax.bar(
        x + offset,
        subset["mean"],
        width=bar_width,
        label=group,
        color=colors[index % len(colors)],
        edgecolor="#222222",
        linewidth=0.8,
    )
    ax.errorbar(
        x + offset,
        subset["mean"],
        yerr=subset["se"],
        fmt="none",
        ecolor="#222222",
        elinewidth=1.0,
        capsize=3,
        capthick=1.0,
    )

ax.set_title("Grouped response with standard error")
ax.set_xlabel("Condition")
ax.set_ylabel("Response mean")
ax.set_xticks(x)
ax.set_xticklabels(conditions, rotation=0)
ax.legend(frameon=False, title="Group")
ax.grid(axis="y", color="#DDDDDD", linewidth=0.8, alpha=0.8)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["grouped_bar_error.csv"]], stringsAsFactors = FALSE)
required_columns <- c("condition", "group", "mean", "se")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("grouped_bar_error.csv 缺失列:", paste(missing, collapse = ", ")))
}

COLOR_LOW_N <- "#4C78A8"
COLOR_HIGH_N <- "#F58518"

ggplot(df, aes(x = condition, y = mean, fill = group)) +
  geom_col(position = position_dodge(width = 0.76), width = 0.68, color = "#222222", linewidth = 0.25) +
  geom_errorbar(
    aes(ymin = mean - se, ymax = mean + se),
    position = position_dodge(width = 0.76),
    width = 0.18,
    linewidth = 0.35,
    color = "#222222"
  ) +
  scale_fill_manual(values = c(COLOR_LOW_N, COLOR_HIGH_N)) +
  labs(title = "Grouped response with standard error", x = "Condition", y = "Response mean", fill = "Group") +
  theme_classic(base_size = 11) +
  theme(panel.grid.major.y = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "Python 单文件模板从 _uploaded_data 构建 DataFrame。",
      "R 模板通过 uploaded_file_paths[[\"grouped_bar_error.csv\"]] 读取上传文件。",
      "柱体使用 ax.bar / geom_col，误差棒使用 ax.errorbar / geom_errorbar，便于平台识别为可编辑图元。",
      "示例代码不依赖本机路径，不调用展示窗口，也不在脚本内导出图片。",
    ],
  },
  {
    id: "scatter-regression",
    title: "散点回归",
    eyebrow: "Scatter regression",
    description:
      "适合展示连续变量关系、分组差异和线性趋势，可用于相关性、剂量响应或模型预测检查。",
    image: "/help-template-regression.png",
    csvData: `sample,group,soil_ph,response
S01,A,5.2,11.8
S02,A,5.6,13.1
S03,A,6.1,14.0
S04,A,6.5,15.4
S05,B,5.4,12.6
S06,B,5.9,14.5
S07,B,6.3,16.2
S08,B,6.8,18.0`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import stats

COLOR_GROUP_A = "#54A24B"
COLOR_GROUP_B = "#E45756"
COLOR_REGRESSION = "#222222"

df = pd.DataFrame(_uploaded_data)
required_columns = ["sample", "group", "soil_ph", "response"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

fig, ax = plt.subplots(figsize=(4.6, 3.4), dpi=150)
group_colors = {"A": COLOR_GROUP_A, "B": COLOR_GROUP_B}

for group, subset in df.groupby("group", sort=False):
    ax.scatter(
        subset["soil_ph"],
        subset["response"],
        label=f"Group {group}",
        s=52,
        color=group_colors.get(group, "#777777"),
        edgecolor="#222222",
        linewidth=0.6,
        alpha=0.9,
    )

slope, intercept, r_value, p_value, _ = stats.linregress(df["soil_ph"], df["response"])
x_line = np.linspace(df["soil_ph"].min(), df["soil_ph"].max(), 100)
y_line = intercept + slope * x_line
ax.plot(x_line, y_line, color=COLOR_REGRESSION, linewidth=1.5, label=f"Fit, R²={r_value ** 2:.2f}")

ax.set_title("Response increases with soil pH")
ax.set_xlabel("Soil pH")
ax.set_ylabel("Response")
ax.legend(frameon=False)
ax.grid(color="#DDDDDD", linewidth=0.8, alpha=0.8)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["scatter_regression.csv"]], stringsAsFactors = FALSE)
required_columns <- c("sample", "group", "soil_ph", "response")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("scatter_regression.csv 缺失列:", paste(missing, collapse = ", ")))
}

COLOR_GROUP_A <- "#54A24B"
COLOR_GROUP_B <- "#E45756"

ggplot(df, aes(x = soil_ph, y = response, color = group)) +
  geom_point(size = 2.7, alpha = 0.9) +
  geom_smooth(method = "lm", se = FALSE, color = "#222222", linewidth = 0.55) +
  scale_color_manual(values = c(A = COLOR_GROUP_A, B = COLOR_GROUP_B)) +
  labs(title = "Response increases with soil pH", x = "Soil pH", y = "Response", color = "Group") +
  theme_classic(base_size = 11) +
  theme(panel.grid = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "Python 使用 ax.scatter 和 ax.plot，让点集合与回归线可被平台分别识别。",
      "R 使用 uploaded_file_paths[[\"scatter_regression.csv\"]]，不假设工作目录或本机路径。",
      "回归线由脚本计算或 geom_smooth 生成，图中保留坐标轴、标题和图例语义。",
      "AI 改写此类脚本时应只返回代码，不附加解释文字或 Markdown 代码围栏。",
    ],
  },
  {
    id: "heatmap-colorbar",
    title: "热图 + 色条",
    eyebrow: "Heatmap",
    description:
      "适合展示基因、代谢物、环境变量或模型特征在样本组之间的矩阵模式，并用色条说明数值范围。",
    image: "/help-template-heatmap.png",
    csvData: `feature,Control,Treatment_A,Treatment_B,Treatment_C
nirK,-0.8,0.2,0.6,1.1
nirS,-0.4,0.1,0.5,0.9
nosZ,0.7,0.4,-0.2,-0.6
amoA,1.0,0.3,-0.1,-0.5
narG,-0.6,-0.1,0.4,0.8`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

COLOR_MAP = "RdBu_r"

df = pd.DataFrame(_uploaded_data)
required_columns = ["feature", "Control", "Treatment_A", "Treatment_B", "Treatment_C"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

features = df["feature"].tolist()
sample_columns = [col for col in df.columns if col != "feature"]
matrix = df[sample_columns].to_numpy(dtype=float)
limit = float(np.nanmax(np.abs(matrix)))

fig, ax = plt.subplots(figsize=(4.8, 3.6), dpi=150)
im = ax.imshow(matrix, cmap=COLOR_MAP, vmin=-limit, vmax=limit, aspect="auto")

ax.set_title("Feature z-score heatmap")
ax.set_xlabel("Treatment")
ax.set_ylabel("Feature")
ax.set_xticks(np.arange(len(sample_columns)))
ax.set_xticklabels(sample_columns, rotation=35, ha="right")
ax.set_yticks(np.arange(len(features)))
ax.set_yticklabels(features)

colorbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
colorbar.set_label("Z-score")

for spine in ax.spines.values():
    spine.set_visible(False)
fig.tight_layout()`,
    rCode: `df <- read.csv(uploaded_file_paths[["heatmap_colorbar.csv"]], stringsAsFactors = FALSE)
required_columns <- c("feature", "Control", "Treatment_A", "Treatment_B", "Treatment_C")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("heatmap_colorbar.csv 缺失列:", paste(missing, collapse = ", ")))
}

feature_names <- df$feature
matrix_values <- as.matrix(df[, setdiff(names(df), "feature")])
rownames(matrix_values) <- feature_names

old_mar <- par(mar = c(6, 6, 3, 5))
image(
  x = seq_len(ncol(matrix_values)),
  y = seq_len(nrow(matrix_values)),
  z = t(matrix_values[nrow(matrix_values):1, ]),
  col = hcl.colors(101, "Blue-Red 3", rev = TRUE),
  axes = FALSE,
  xlab = "Treatment",
  ylab = "Feature",
  main = "Feature z-score heatmap"
)
axis(1, at = seq_len(ncol(matrix_values)), labels = colnames(matrix_values), las = 2)
axis(2, at = seq_len(nrow(matrix_values)), labels = rev(rownames(matrix_values)), las = 2)
box()

usr <- par("usr")
legend_values <- seq(min(matrix_values), max(matrix_values), length.out = 101)
legend_x <- usr[2] + 0.25
legend_y <- seq(usr[3], usr[4], length.out = 101)
rect(
  xleft = legend_x,
  ybottom = legend_y[-length(legend_y)],
  xright = legend_x + 0.15,
  ytop = legend_y[-1],
  col = hcl.colors(100, "Blue-Red 3", rev = TRUE),
  border = NA,
  xpd = TRUE
)
axis(4, at = pretty(range(legend_values)), labels = pretty(range(legend_values)), las = 1)
mtext("Z-score", side = 4, line = 3)
par(old_mar)`,
    highlights: [
      "Python 热图使用 ax.imshow，并把返回的 im 显式传给 fig.colorbar。",
      "R 通过 uploaded_file_paths[[\"heatmap_colorbar.csv\"]] 读取矩阵数据。",
      "矩阵列名和 feature 行名在代码内自检，缺列时给出清晰错误。",
      "热图不手写逐像素方块；Python 色条与 mappable 明确绑定，便于平台识别。",
    ],
  },
  {
    id: "boxplot-jitter",
    title: "箱线图 + 抖动散点",
    eyebrow: "Boxplot + jitter",
    description:
      "适合比较多个处理组的分布、中位数、离散程度和原始样本点，常用于组间差异展示。",
    image: "/help-template-boxplot.png",
    csvData: `sample,treatment,value
S01,Control,4.8
S02,Control,5.1
S03,Control,5.4
S04,Control,4.9
S05,Treatment A,6.0
S06,Treatment A,6.4
S07,Treatment A,6.1
S08,Treatment A,6.8
S09,Treatment B,5.6
S10,Treatment B,5.9
S11,Treatment B,6.3
S12,Treatment B,6.0`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

COLOR_BOX = "#8E6C8A"
COLOR_POINTS = "#2F6F73"

df = pd.DataFrame(_uploaded_data)
required_columns = ["sample", "treatment", "value"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

groups = list(dict.fromkeys(df["treatment"]))
values = [df.loc[df["treatment"] == group, "value"].astype(float).to_numpy() for group in groups]
positions = np.arange(1, len(groups) + 1)

fig, ax = plt.subplots(figsize=(4.8, 3.4), dpi=150)
box = ax.boxplot(
    values,
    positions=positions,
    widths=0.55,
    patch_artist=True,
    showfliers=False,
    medianprops={"color": "#222222", "linewidth": 1.2},
    boxprops={"facecolor": COLOR_BOX, "edgecolor": "#222222", "linewidth": 0.8, "alpha": 0.55},
    whiskerprops={"color": "#222222", "linewidth": 0.8},
    capprops={"color": "#222222", "linewidth": 0.8},
)

rng = np.random.default_rng(7)
for index, group in enumerate(groups):
    subset = df[df["treatment"] == group]
    jitter = rng.normal(0, 0.045, size=len(subset))
    ax.scatter(
        np.full(len(subset), positions[index]) + jitter,
        subset["value"],
        s=42,
        color=COLOR_POINTS,
        edgecolor="#222222",
        linewidth=0.5,
        alpha=0.9,
        zorder=3,
    )

ax.set_title("Distribution by treatment")
ax.set_xlabel("Treatment")
ax.set_ylabel("Measured value")
ax.set_xticks(positions)
ax.set_xticklabels(groups)
ax.grid(axis="y", color="#DDDDDD", linewidth=0.8, alpha=0.8)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["boxplot_jitter.csv"]], stringsAsFactors = FALSE)
required_columns <- c("sample", "treatment", "value")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("boxplot_jitter.csv 缺失列:", paste(missing, collapse = ", ")))
}

COLOR_BOX <- "#8E6C8A"
COLOR_POINTS <- "#2F6F73"

ggplot(df, aes(x = treatment, y = value)) +
  geom_boxplot(width = 0.55, outlier.shape = NA, fill = COLOR_BOX, alpha = 0.55, color = "#222222", linewidth = 0.3) +
  geom_jitter(width = 0.08, height = 0, size = 2.3, alpha = 0.9, color = COLOR_POINTS) +
  labs(title = "Distribution by treatment", x = "Treatment", y = "Measured value") +
  theme_classic(base_size = 11) +
  theme(panel.grid.major.y = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "CSV 是长表结构，每行一个样本，treatment 控制分组，value 控制纵轴。",
      "Python 使用 pd.DataFrame(_uploaded_data)，箱线图和散点分别由 ax.boxplot 与 ax.scatter 创建。",
      "R 使用 uploaded_file_paths[[\"boxplot_jitter.csv\"]]，并用 geom_boxplot + geom_jitter 保留原始点。",
      "抖动只用于避免点重叠，不改变原始 value 数值。",
    ],
  },
  {
    id: "multi-time-series",
    title: "多组时间序列",
    eyebrow: "Time series",
    description:
      "适合展示多个处理组随时间变化的趋势，并用误差棒表达重复样本的不确定性。",
    image: "/help-template-time-series.png",
    csvData: `day,group,mean,se
0,Control,2.1,0.18
7,Control,2.5,0.20
14,Control,2.8,0.22
21,Control,3.0,0.25
0,Treatment A,2.0,0.17
7,Treatment A,3.1,0.24
14,Treatment A,3.8,0.28
21,Treatment A,4.6,0.30
0,Treatment B,2.2,0.19
7,Treatment B,2.9,0.21
14,Treatment B,3.4,0.26
21,Treatment B,4.0,0.29`,
    pythonCode: `import pandas as pd
import matplotlib.pyplot as plt

COLOR_CONTROL = "#4C78A8"
COLOR_TREATMENT_A = "#F58518"
COLOR_TREATMENT_B = "#54A24B"

df = pd.DataFrame(_uploaded_data)
required_columns = ["day", "group", "mean", "se"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

color_map = {
    "Control": COLOR_CONTROL,
    "Treatment A": COLOR_TREATMENT_A,
    "Treatment B": COLOR_TREATMENT_B,
}

fig, ax = plt.subplots(figsize=(5.0, 3.4), dpi=150)
for group, subset in df.groupby("group", sort=False):
    subset = subset.sort_values("day")
    ax.errorbar(
        subset["day"],
        subset["mean"],
        yerr=subset["se"],
        marker="o",
        markersize=4.5,
        linewidth=1.5,
        capsize=3,
        color=color_map.get(group, "#777777"),
        label=group,
    )

ax.set_title("Response over time")
ax.set_xlabel("Day")
ax.set_ylabel("Response mean")
ax.legend(frameon=False, title="Group")
ax.grid(color="#DDDDDD", linewidth=0.8, alpha=0.8)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["multi_time_series.csv"]], stringsAsFactors = FALSE)
required_columns <- c("day", "group", "mean", "se")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("multi_time_series.csv 缺失列:", paste(missing, collapse = ", ")))
}

COLOR_CONTROL <- "#4C78A8"
COLOR_TREATMENT_A <- "#F58518"
COLOR_TREATMENT_B <- "#54A24B"

ggplot(df, aes(x = day, y = mean, color = group, group = group)) +
  geom_line(linewidth = 0.6) +
  geom_point(size = 2.3) +
  geom_errorbar(aes(ymin = mean - se, ymax = mean + se), width = 0.8, linewidth = 0.3) +
  scale_color_manual(values = c(Control = COLOR_CONTROL, "Treatment A" = COLOR_TREATMENT_A, "Treatment B" = COLOR_TREATMENT_B)) +
  labs(title = "Response over time", x = "Day", y = "Response mean", color = "Group") +
  theme_classic(base_size = 11) +
  theme(panel.grid = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "CSV 用 day、group、mean、se 表达时间、分组、均值和误差。",
      "Python 单文件模板直接从 _uploaded_data 构建 DataFrame，不读取外部路径。",
      "R 使用 uploaded_file_paths[[\"multi_time_series.csv\"]]，geom_line、geom_point 和 geom_errorbar 都是原生高阶图层。",
      "替换数据时保持 day 为数值列，平台更容易识别连续时间轴。",
    ],
  },
  {
    id: "forest-plot",
    title: "森林图",
    eyebrow: "Forest plot",
    description:
      "适合展示多项研究、亚组或模型变量的效应量和置信区间，并突出零效应参考线。",
    image: "/help-template-forest.png",
    csvData: `term,effect,ci_low,ci_high,group
Overall,0.32,0.12,0.52,Summary
Study A,0.18,-0.05,0.41,Individual
Study B,0.44,0.20,0.68,Individual
Study C,0.27,0.02,0.52,Individual
Study D,0.58,0.31,0.85,Individual
Study E,0.09,-0.18,0.36,Individual`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

COLOR_SUMMARY = "#222222"
COLOR_INDIVIDUAL = "#4C78A8"

df = pd.DataFrame(_uploaded_data)
required_columns = ["term", "effect", "ci_low", "ci_high", "group"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

plot_df = df.iloc[::-1].reset_index(drop=True)
y = np.arange(len(plot_df))
colors = [COLOR_SUMMARY if value == "Summary" else COLOR_INDIVIDUAL for value in plot_df["group"]]
xerr = np.vstack([
    plot_df["effect"].astype(float) - plot_df["ci_low"].astype(float),
    plot_df["ci_high"].astype(float) - plot_df["effect"].astype(float),
])

fig, ax = plt.subplots(figsize=(5.0, 3.6), dpi=150)
ax.axvline(0, color="#777777", linestyle="--", linewidth=1.0)
ax.errorbar(
    plot_df["effect"],
    y,
    xerr=xerr,
    fmt="none",
    ecolor="#222222",
    elinewidth=1.0,
    capsize=3,
)
ax.scatter(plot_df["effect"], y, s=54, color=colors, edgecolor="#222222", linewidth=0.6, zorder=3)

ax.set_title("Effect estimates with 95% CI")
ax.set_xlabel("Effect size")
ax.set_ylabel("")
ax.set_yticks(y)
ax.set_yticklabels(plot_df["term"])
ax.grid(axis="x", color="#DDDDDD", linewidth=0.8, alpha=0.8)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.spines["left"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["forest_plot.csv"]], stringsAsFactors = FALSE)
required_columns <- c("term", "effect", "ci_low", "ci_high", "group")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("forest_plot.csv 缺失列:", paste(missing, collapse = ", ")))
}

df$term <- factor(df$term, levels = rev(df$term))

ggplot(df, aes(x = effect, y = term, color = group)) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "#777777", linewidth = 0.35) +
  geom_errorbarh(aes(xmin = ci_low, xmax = ci_high), height = 0.18, linewidth = 0.35) +
  geom_point(size = 2.7) +
  scale_color_manual(values = c(Summary = "#222222", Individual = "#4C78A8")) +
  labs(title = "Effect estimates with 95% CI", x = "Effect size", y = NULL, color = "Type") +
  theme_classic(base_size = 11) +
  theme(panel.grid.major.x = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "CSV 用 effect、ci_low、ci_high 明确表达点估计和置信区间。",
      "Python 使用 ax.errorbar 绘制水平误差线，ax.scatter 绘制效应点。",
      "R 使用 uploaded_file_paths[[\"forest_plot.csv\"]]，geom_errorbarh 和 geom_point 生成可编辑图层。",
      "零效应参考线来自 ax.axvline / geom_vline，可按论文语境改为 1 或其他基准。",
    ],
  },
  {
    id: "ordination-scatter",
    title: "PCA/PCoA 分组散点",
    eyebrow: "Ordination",
    description:
      "适合展示 PCA、PCoA 或 NMDS 排序结果中的样本分布、组间分离和坐标轴解释度。",
    image: "/help-template-ordination.png",
    csvData: `sample,group,axis1,axis2
S01,Control,-1.20,0.32
S02,Control,-0.95,0.10
S03,Control,-1.08,-0.18
S04,Control,-0.72,0.24
S05,Treatment A,0.34,0.88
S06,Treatment A,0.58,0.64
S07,Treatment A,0.76,1.02
S08,Treatment A,0.42,0.48
S09,Treatment B,0.82,-0.52
S10,Treatment B,1.05,-0.31
S11,Treatment B,1.22,-0.74
S12,Treatment B,0.96,-0.92`,
    pythonCode: `import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse

COLOR_CONTROL = "#4C78A8"
COLOR_TREATMENT_A = "#F58518"
COLOR_TREATMENT_B = "#54A24B"

df = pd.DataFrame(_uploaded_data)
required_columns = ["sample", "group", "axis1", "axis2"]
missing = [col for col in required_columns if col not in df.columns]
if missing:
    raise KeyError("上传数据缺失列: " + ", ".join(missing))

color_map = {
    "Control": COLOR_CONTROL,
    "Treatment A": COLOR_TREATMENT_A,
    "Treatment B": COLOR_TREATMENT_B,
}

fig, ax = plt.subplots(figsize=(4.6, 3.6), dpi=150)
for group, subset in df.groupby("group", sort=False):
    points = subset[["axis1", "axis2"]].astype(float).to_numpy()
    covariance = np.cov(points, rowvar=False)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    order = eigenvalues.argsort()[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]
    angle = np.degrees(np.arctan2(eigenvectors[1, 0], eigenvectors[0, 0]))
    ellipse = Ellipse(
        xy=points.mean(axis=0),
        width=4 * np.sqrt(eigenvalues[0]),
        height=4 * np.sqrt(eigenvalues[1]),
        angle=angle,
        facecolor=color_map.get(group, "#777777"),
        edgecolor=color_map.get(group, "#777777"),
        linewidth=1.0,
        alpha=0.14,
        zorder=1,
    )
    ax.add_patch(ellipse)
    ax.scatter(
        subset["axis1"],
        subset["axis2"],
        s=58,
        color=color_map.get(group, "#777777"),
        edgecolor="#222222",
        linewidth=0.6,
        alpha=0.9,
        label=group,
    )

ax.axhline(0, color="#BBBBBB", linewidth=0.8)
ax.axvline(0, color="#BBBBBB", linewidth=0.8)
ax.set_title("Ordination of samples")
ax.set_xlabel("Axis 1 (42.3%)")
ax.set_ylabel("Axis 2 (18.7%)")
ax.legend(frameon=False, title="Group")
ax.grid(color="#DDDDDD", linewidth=0.8, alpha=0.7)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()`,
    rCode: `library(ggplot2)

df <- read.csv(uploaded_file_paths[["ordination_scatter.csv"]], stringsAsFactors = FALSE)
required_columns <- c("sample", "group", "axis1", "axis2")
missing <- setdiff(required_columns, names(df))
if (length(missing) > 0) {
  stop(paste("ordination_scatter.csv 缺失列:", paste(missing, collapse = ", ")))
}

COLOR_CONTROL <- "#4C78A8"
COLOR_TREATMENT_A <- "#F58518"
COLOR_TREATMENT_B <- "#54A24B"

ggplot(df, aes(x = axis1, y = axis2, color = group)) +
  geom_hline(yintercept = 0, color = "#BBBBBB", linewidth = 0.25) +
  geom_vline(xintercept = 0, color = "#BBBBBB", linewidth = 0.25) +
  stat_ellipse(aes(fill = group), geom = "polygon", level = 0.80, alpha = 0.14, color = NA, show.legend = FALSE) +
  geom_point(size = 2.8, alpha = 0.9) +
  scale_color_manual(values = c(Control = COLOR_CONTROL, "Treatment A" = COLOR_TREATMENT_A, "Treatment B" = COLOR_TREATMENT_B)) +
  scale_fill_manual(values = c(Control = COLOR_CONTROL, "Treatment A" = COLOR_TREATMENT_A, "Treatment B" = COLOR_TREATMENT_B)) +
  labs(title = "Ordination of samples", x = "Axis 1 (42.3%)", y = "Axis 2 (18.7%)", color = "Group") +
  coord_equal() +
  theme_classic(base_size = 11) +
  theme(panel.grid = element_line(color = "#DDDDDD", linewidth = 0.25))`,
    highlights: [
      "CSV 直接存放排序后的 axis1 和 axis2 坐标，模板专注绘图而不重新计算 PCA。",
      "Python 使用 pd.DataFrame(_uploaded_data)，Ellipse 和 ax.scatter 分别生成置信区域与样本点。",
      "R 使用 uploaded_file_paths[[\"ordination_scatter.csv\"]]，stat_ellipse、geom_point 与参考线都是原生 ggplot 图层。",
      "替换为真实 PCA/PCoA 结果时，同步更新坐标轴解释度标签。",
    ],
  },
];

export const helpFaqs: HelpFaq[] = [
  {
    id: "faq-start-workflow",
    category: "quick_start",
    question: "我已经有 Python/R 脚本和数据，应该怎么导入？",
    answer: [
      "进入“新建图形项目”，先上传、拖入或粘贴 .py/.R 脚本。",
      "平台会读取脚本引用的 CSV/Excel 文件名，但此时不会执行代码。",
      "按提示补齐数据文件，同时可上传脚本没有直接引用的其他分析表。",
      "确认脚本语言、主数据文件、字段预览和最终代码后创建项目，再进入编辑器渲染。",
    ],
  },
  {
    id: "faq-start-from-example",
    category: "quick_start",
    question: "我没有现成脚本，可以直接用平台示例开始吗？",
    answer: [
      "可以。在“科研模板”中选择与研究问题和数据结构最接近的图形。",
      "复制 CSV 示例确认所需列，再复制 Python 或 R 代码。",
      "把示例数据替换为自己的数据，并同步修改 required_columns、绘图字段和文件名。",
      "将修改后的代码和数据放入“新建图形项目”，完成配置后渲染。",
    ],
  },
  {
    id: "faq-start-template",
    category: "templates",
    question: "可以直接复用帮助中心模板吗？",
    answer:
      "可以。先复制模板 CSV 的列结构，替换为自己的数据；再按模板代码中的列名自检逻辑同步修改 required_columns、坐标轴字段和图例字段。",
  },
  {
    id: "faq-template-not-limit",
    category: "templates",
    question: "平台只能画帮助中心里列出的模板吗？",
    answer: [
      "不是。模板是常见科研图形的示例和稳定起点，不是平台支持图形的白名单。",
      "只要 Python 或 R 代码能在平台运行环境中正常生成 Figure，平台就可以执行并渲染。",
      "使用标准 Matplotlib、ggplot2 或基础 R 绘图函数，通常可以获得更完整的点选、批量修改和拖拽体验。",
    ],
  },
  {
    id: "faq-template-choice",
    category: "templates",
    question: "怎样选择合适的绘图模板？",
    answer:
      "先按数据结构和研究问题选择：均值比较用分组柱状图，连续变量关系用散点回归，矩阵模式用热图，组间分布用箱线图，时间变化用时间序列，效应量区间用森林图，排序坐标用 PCA/PCoA 分组散点。",
  },
  {
    id: "faq-template-replace-columns",
    category: "templates",
    question: "替换成自己的列名时要改哪里？",
    answer:
      "同步修改三处：CSV 表头、代码里的 required_columns，以及绘图映射字段。Python 中检查 df[\"列名\"]、groupby 字段和坐标轴字段；R 中检查 aes(...)、required_columns 和 uploaded_file_paths[[\"文件名.csv\"]] 是否与上传文件一致。",
  },
  {
    id: "faq-data-single",
    category: "code_rules",
    question: "Python 单文件数据应该怎么读取？",
    answer:
      "单文件或用户明确指定主表时，使用 pd.DataFrame(_uploaded_data)。不要写本机路径，也不要从当前工作目录读取文件。",
  },
  {
    id: "faq-data-multiple",
    category: "code_rules",
    question: "多文件数据为什么必须按文件名读取？",
    answer:
      "多文件脚本里 _uploaded_data 无法表达每张表的语义。应使用 _uploaded_file_paths[\"原始文件名.csv\"] 或对应 Excel 文件名显式读取，并在读取后检查必需列。",
  },
  {
    id: "faq-data-r",
    category: "templates",
    question: "R 脚本怎样读取上传数据？",
    answer:
      "R 模板统一使用 uploaded_file_paths，例如 read.csv(uploaded_file_paths[[\"scatter_regression.csv\"]])。这能避免脚本依赖本机目录或平台工作目录。",
  },
  {
    id: "faq-ai-output",
    category: "ai_translation",
    question: "给 AI 的输出格式要求是什么？",
    answer:
      "要求 AI 只返回纯代码，不要 Markdown 代码围栏、解释文字、运行说明或额外文件操作。平台会直接执行这段绘图代码。",
  },
  {
    id: "faq-ai-direct-prompt",
    category: "ai_translation",
    question: "我有数据和 AI，怎样直接生成平台可用代码？",
    answer: [
      "在“代码规范”区域选择 Python 或 R，复制公开的 AI 绘图提示词。",
      "把提示词、原始数据文件和具体绘图要求一起交给 Codex、Claude、DeepSeek、ChatGPT 或 Gemini。",
      "AI 返回纯代码后，直接粘贴或上传到新建项目；平台会继续检查脚本依赖的数据文件。",
    ],
  },
  {
    id: "faq-ai-forbidden",
    category: "ai_translation",
    question: "哪些代码会破坏平台兼容性？",
    answer: [
      "本机绝对路径、桌面路径、同步盘路径或网络路径。",
      "展示窗口或脚本内保存图片。",
      "open、Path 读写、复制归档、根据脚本位置反推项目根目录。",
      "用手写矩形、线段或小方块替代原生绘图 API。",
    ],
  },
  {
    id: "faq-edit-recognition",
    category: "editing_export",
    question: "怎样提高图元识别准确率？",
    answer:
      "优先使用原生高阶 API：柱状图用 ax.bar，误差棒用 ax.errorbar，散点用 ax.scatter，热图用 ax.imshow 或 ax.pcolormesh，色条用 fig.colorbar 并显式绑定 mappable。",
  },
  {
    id: "faq-edit-colors",
    category: "editing_export",
    question: "为什么推荐把颜色写成命名常量？",
    answer:
      "命名颜色常量能让后续编辑和批量替换更稳定，也能让模板读者快速理解每种颜色对应的组别或语义。",
  },
  {
    id: "faq-export-code",
    category: "editing_export",
    question: "为什么模板代码里不写导出命令？",
    answer:
      "平台负责捕获图像、生成导出文件和保存复现材料。模板代码只负责创建 Figure，避免脚本绕过平台的统一导出流程。",
  },
  {
    id: "faq-export-reproduce",
    category: "editing_export",
    question: "如何保证图件可复现？",
    answer: [
      "保留上传数据、最终代码和平台导出的图件版本。",
      "在代码中固定列名、颜色常量、统计方法和图形尺寸。",
      "导出前检查标题、坐标轴、图例、色条和统计标注是否与论文说明一致。",
    ],
  },
];

export const helpCategoryLabels: Record<HelpCategoryId, string> = {
  quick_start: "快速上手",
  templates: "科研绘图模板",
  code_rules: "平台代码规范",
  ai_translation: "AI 转义规范",
  editing_export: "编辑、导出与故障",
};
