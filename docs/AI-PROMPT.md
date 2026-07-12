# SciFigure 平台 AI 改写提示词（标准版）

> 给外部 AI（ChatGPT / Claude / Gemini / DeepSeek）使用。将用户提供的原始 matplotlib 脚本改写为平台兼容版本。
> 每次使用时复制全文，末尾追加用户脚本即可。

---

## SciFigure 平台 — Matplotlib 脚本改写规范

你正在帮助用户改写一段 Matplotlib 脚本。改写后的脚本将在 SciFigure 平台的运行时内省引擎上执行。平台会原样运行脚本，通过内省 Matplotlib artist tree 自动识别可编辑图元，无需用户手动注册。

---

### 一、运行环境

| 项目 | 说明 |
|------|------|
| Python | 3.x |
| 后端 | `Agg`（无头，不显示窗口） |
| 预装库 | `matplotlib`, `numpy`, `pandas`, `scipy` |
| 字体 | `sans-serif` 回退链：SimHei, Microsoft YaHei, Noto Sans CJK SC, Times New Roman, Arial |
| 图片尺寸 | 默认 100mm × 80mm, 150 DPI（可根据需求调整） |

---

### 二、数据接入

用户上传的数据文件分为两类，读取方式完全不同。**单文件脚本**可以使用 `_uploaded_data`；**多文件脚本必须按文件名显式读取每个数据表**，不要猜测 `_uploaded_data` 代表哪一张表。

**1）单文件 / 主数据文件：** 数据直接注入到 `_uploaded_data`（list[dict]）
```python
df = pd.DataFrame(_uploaded_data)   # ✅ 仅适合单文件或用户明确指定主表的场景
```

**2）多文件 / 辅助数据文件：** 路径注入到 `_uploaded_file_paths`（dict[str, str]），键 = 原始文件名
```python
df_matrix = pd.read_csv(_uploaded_file_paths["机制输入矩阵.csv"])
df_stats = pd.read_csv(_uploaded_file_paths["变量统计表.csv"])
df_pred = pd.read_excel(_uploaded_file_paths["二维交互预测.xlsx"], sheet_name="输入数据与预测")
```

**多文件硬性要求：**
- 每一张表都必须用 `_uploaded_file_paths["原始文件名"]` 显式读取。
- 不允许把 `pd.DataFrame(_uploaded_data)` 当成统计表、映射表、预测表或任意辅助表使用。
- `load_data()` 必须返回语义清晰的数据对象，例如 `return df_matrix, df_stats, df_pred`。
- `build_figure(...)` 的参数名必须和真实表含义一致，例如 `build_figure(df_matrix, df_stats, df_pred)`。
- 每次读取后必须做列名自检，缺列时抛出带文件名和缺失列的清晰错误。

推荐结构：
```python
def require_columns(df: pd.DataFrame, required: list[str], file_label: str) -> None:
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise KeyError(f"{file_label} 缺失列: {', '.join(missing)}; 当前列: {', '.join(map(str, df.columns))}")


def load_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    df_matrix = pd.read_csv(_uploaded_file_paths["机制输入矩阵.csv"])
    df_stats = pd.read_csv(_uploaded_file_paths["变量统计表.csv"])
    df_pred = pd.read_excel(_uploaded_file_paths["二维交互预测.xlsx"], sheet_name="输入数据与预测")
    require_columns(df_matrix, ["LNRR", "Response_Group"], "机制输入矩阵.csv")
    require_columns(df_stats, ["feature", "spearman_rho_with_LNRR", "spearman_p"], "变量统计表.csv")
    require_columns(df_pred, ["OPR", "FeP", "LNRR"], "二维交互预测.xlsx")
    return df_matrix, df_stats, df_pred
```

**严禁**（会被 AST 安全门拦截）：
- `open()` / `pathlib.Path().read_text()` / 任何磁盘文件读写
- `plt.savefig()` / `plt.show()`
- `import shutil` / `shutil.copy()` / `shutil.copy2()` / 复制、归档、保存任何输入文件
- `Path(__file__)` / `__file__` / `Path(...).resolve().parents[...]` / 根据脚本所在目录反推项目根目录
- 任何本机绝对路径、历史工程目录、桌面/OneDrive 路径、网络路径或未上传文件路径

**本地路径迁移规则：**
- 如果原脚本包含 `SOURCE_DIR`、`SOURCE_RUN_DIR`、`PROJECT_ROOT`、`Path(__file__).resolve()` 等路径逻辑，必须删除。
- 如果原脚本从历史目录读取 CSV/XLSX，必须改成 `_uploaded_file_paths["原始文件名.csv"]` 或 `_uploaded_file_paths["原始文件名.xlsx"]`。
- 如果原脚本有 `preserve_inputs()`、`copy2()`、复制参考图、写运行说明等归档逻辑，必须删除；平台只负责绘图和内省，不允许脚本操作文件系统。
- 不要让脚本依赖当前工作目录、脚本文件位置或用户电脑目录。平台脚本是在受控 `exec()` 环境中执行，`__file__` 不可靠。

---

### 三、Figure 捕获机制（多图支持）

脚本可以生成**任意数量**的 Figure，平台会自动捕获它们，无需手动注册或指定返回值：
- 推荐使用 `fig, ax = plt.subplots(...)` 形式创建
- 不需要写 `plt.gcf()`、`plt.savefig()` 或 `plt.show()`
- 单张图保持单图即可，不要无故拆成多图

---

### 四、平台可识别图元（内省清单）

平台支持对以下 matplotlib 原生图元进行只读解析或属性交互编辑，请**优先使用原生高阶 API 绘制**：

| 图元种类 | GID 格式 | 对应 Matplotlib API / 识别规则 | 支持的可编辑属性 |
|:---|:---|:---|:---|
| **标题** | `title.{ax_idx}` | `ax.set_title()` | `text`, `fontsize`, `color`, `fontfamily` |
| **X/Y 轴标签** | `xlabel.{ax_idx}`, `ylabel.{ax_idx}` | `ax.set_xlabel()`, `ax.set_ylabel()` | `text`, `fontsize`, `color`, `fontfamily` |
| **X/Y 轴刻度** | `xtick.{ax_idx}.{i}`, `ytick.{ax_idx}.{i}` | `ax.get_xticklabels()`, `ax.get_yticklabels()` | `text`, `fontsize`, `color`, `rotation` |
| **边框脊柱** | `spine.{side}.{ax_idx}` | `ax.spines['left']` (left/right/top/bottom) | `visible`, `color`, `linewidth` |
| **网格线** | `grid.{ax_idx}` | `ax.grid()` | `visible`, `color`, `linewidth`, `linestyle`, `alpha` |
| **折线** | `line.{ax_idx}.{i}` | `ax.plot()` | `color`, `linewidth`, `linestyle`, `alpha`, `marker`, `markersize` |
| **散点/集合** | `collection.{ax_idx}.{i}` | `ax.scatter()` | `facecolor`, `edgecolor`, `alpha`, `linewidth` |
| **柱状图** | `container.bar.{ax_idx}.{c_idx}` | `ax.bar()` | `color`, `facecolor`, `edgecolor`, `alpha`, `linewidth` |
| **误差棒** | `container.errorbar.{ax_idx}.{c_idx}` | `ax.errorbar()` | `color`, `linewidth`, `elinewidth`, `capsize`, `capthick`, `alpha` |
| **箱线图** | `container.boxplot.{ax_idx}.{c_idx}` | `ax.boxplot()` | `color`, `linewidth`, `alpha`, `box_color`, `median_color` |
| **小提琴图** | `container.violinplot.{ax_idx}.{c_idx}`| `ax.violinplot()` | `color`, `facecolor`, `edgecolor`, `linewidth`, `alpha` |
| **热图** | `heatmap.image.{ax_idx}.{i}` 或 `.mesh.`| `ax.imshow()`, `ax.pcolormesh()` | `cmap`, `vmin`, `vmax`, `alpha` (目前为只读/patch) |
| **色条** | `colorbar.{ax_idx}` | `fig.colorbar()` | `label`, `tick_fontsize`, `visible`, `left`, `bottom`, `width`, `height` (目前为只读/patch) |
| **图例** | `legend.{ax_idx}` | `ax.legend()` | `visible`, `fontsize`, `facecolor`, `frameon`, `edgecolor`, `loc` |

---

### 五、编写规范与样式约定（大模型必读）

遵循以下规则可大幅提升脚本在平台中的识别精准度与用户的修图体验：

1. **绝对禁止“手写图元”**：
   - ❌ 禁止通过 `for` 循环与手动创建 `matplotlib.patches.Rectangle` / `Polygon` 来手写绘制柱状图或直方图，必须调用 `ax.bar()` 或 `ax.barh()`。
   - ❌ 禁止通过循环绘制单个像素小方块来画热图，必须使用 `ax.imshow()` 或 `ax.pcolormesh()`。
   - ❌ 禁止手写线段（多条 `ax.plot`）来拼接成误差棒，必须使用 `ax.errorbar()`。
   - 否则内省引擎将无法将其合并为正确的 Container，用户无法进行组属性统一修改。

2. **使用命名颜色常量**：
   - 推荐在脚本开头使用清晰的变量指定颜色常数，例如：
     ```python
     COLOR_GROUP_A = "#1f77b4"
     COLOR_GROUP_B = "#ff7f0e"
     ```
     配色中心可以识别这些常量定义并在右侧一键更新代码变量值。
   - 每个语义组只能保留一个权威颜色常量或颜色字典条目，不要再定义同色但未使用的别名。
   - 使用 `c=df["Color"]` 等逐点颜色数组时，该列必须直接由上述权威常量生成；不要另建一套重复常量，否则平台无法可靠区分颜色归属。

3. **Colorbar 的绑定规范**：
   - 绘制色条时，务必将绘图 API 返回的 mappable 对象传递给 colorbar 函数：
     ```python
     im = ax.imshow(data, cmap="viridis")
     fig.colorbar(im, ax=ax)  # ✅ 推荐：显式绑定 mappable 和 axes
     ```

4. **剔除展示与导出操作**：
   - ❌ 绝对不要包含 `plt.show()`（会阻塞无头后端）。
   - ❌ 绝对不要包含 `plt.savefig()`（平台会自动在内存中捕获高 DPI 的 SVG/PDF 进行持久化与库导出）。

---

### 六、安全与限制

* **禁止模块**：`os`, `sys`, `subprocess`, `builtins`, `shutil`, `socket`, `urllib`, `requests`，以及任何形式的 `eval()` / `exec()`，脚本必须是安全的科学绘图纯逻辑。
* **禁止本地路径依赖**：不得使用 `__file__`、`Path(__file__)`、本机绝对路径、历史工程目录或未上传文件路径。所有数据来源必须来自 `_uploaded_data` 或 `_uploaded_file_paths`。

---

### 七、输出格式要求

1. **只返回纯 Python 代码**，不要用 ```python 或 ``` 包裹。
2. 不要添加任何说明文字或前导解释。
3. 确保代码结构缩进完全正确，可在 `exec()` 中直接执行。

---

### 八、本次任务数据

```
数据集列名：{列名 JSON}
推荐 X 字段：{x 字段}
推荐 Y 字段：{y 字段}
推荐分组字段：{group 字段}
数据预览（前 5 行）：
{预览数据}
文本列：{string 列名}
数值列：{numeric 列名}
数值列统计：
{统计信息}
```

### 用户原始脚本

```python
{用户脚本}
```
