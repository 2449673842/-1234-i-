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

### 二、数据接入（最重要）

用户上传的数据文件分为两类，读取方式完全不同：

**1）主数据文件（带标记的第一个文件）：** 数据直接注入到 `_uploaded_data`（list[dict]）
```python
df = pd.DataFrame(_uploaded_data)   # ✅ 唯一读取方式，不准对主文件用 read_csv
```

**2）辅助数据文件（其他上传的文件）：** 路径注入到 `_uploaded_file_paths`（dict[str, str]），键 = 原始文件名
```python
df_aux = pd.read_csv(_uploaded_file_paths["文件名.csv"])   # ✅ 必须这样读辅助文件
```

| 文件类型 | 数据在哪 | 如何读取 |
|---------|---------|---------|
| 主文件 | `_uploaded_data` 已注入 | `pd.DataFrame(_uploaded_data)` |
| 辅助文件 | 只有路径在 `_uploaded_file_paths` | `pd.read_csv(_uploaded_file_paths["文件名"])` |
| 未上传的文件 | ❌ 无法访问 | — |

**严禁**（会被 AST 安全门拦截）：
- `open()` / `pathlib.Path().read_text()` / 任何磁盘文件读写
- `plt.savefig()` / `plt.show()`

---

### 三、Figure 捕获机制（多图支持）

平台通过**双重机制**自动捕获脚本生成的所有 Figure，不需要手动注册：

1. **`Figure.__init__` 猴子补丁**：拦截所有 Figure 创建，注册到 `_figure_registry`
2. **`plt.get_fignums()` 回退**：执行结束后扫描所有存活 Figure

脚本可以生成**任意数量**的 Figure，每张 Figure：
- 分配唯一 ID（`fig_1`, `fig_2`, ...）
- 拥有独立的 Manifest / EditLog / Revision / SVG
- 在前端以独立 Tab 展示，可单独编辑

**推荐的模板结构：**

```python
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np

df = pd.DataFrame(_uploaded_data)

# Figure 1
fig1, ax1 = plt.subplots(figsize=(100/25.4, 80/25.4), dpi=150)
ax1.plot(...)
ax1.set_title('Figure 1')

# Figure 2（如果需要，可以用不同数据列）
fig2, ax2 = plt.subplots(figsize=(100/25.4, 80/25.4), dpi=150)
ax2.scatter(...)
ax2.set_title('Figure 2')

# 无需 plt.gcf()、plt.savefig() 或 plt.show()
# 平台自动捕获所有 Figure
```

如果脚本只生成一张图，就保持单图即可，不要无故拆成多图。

---

### 四、平台可识别图元（内省清单）

脚本生成的 Figure 中，以下图元会被自动识别为**可交互编辑对象**：

| 图元种类 | GID 格式 | 可编辑属性 |
|---------|----------|-----------|
| 标题 | `title.{ax_idx}` | `text`, `fontsize`, `color`, `fontfamily` |
| X 轴标签 | `xlabel.{ax_idx}` | `text`, `fontsize`, `color`, `fontfamily` |
| Y 轴标签 | `ylabel.{ax_idx}` | `text`, `fontsize`, `color`, `fontfamily` |
| X 轴刻度 | `xtick.{ax_idx}.{i}` | `text`, `fontsize`, `color`, `rotation` |
| Y 轴刻度 | `ytick.{ax_idx}.{i}` | `text`, `fontsize`, `color`, `rotation` |
| 上脊柱 | `spine.top.{ax_idx}` | `visible`, `color`, `linewidth` |
| 下脊柱 | `spine.bottom.{ax_idx}` | `visible`, `color`, `linewidth` |
| 左脊柱 | `spine.left.{ax_idx}` | `visible`, `color`, `linewidth` |
| 右脊柱 | `spine.right.{ax_idx}` | `visible`, `color`, `linewidth` |
| 折线 | `line.{ax_idx}.{i}` | `color`, `linewidth`, `linestyle`, `alpha` |
| 散点/填充集 | `collection.{ax_idx}.{i}` | `facecolor`, `edgecolor`, `alpha`, `linewidth` |
| 图例 | `legend.{ax_idx}` | `visible`, `fontsize`, `facecolor` |

**说明：**
- `ax_idx` 从 0 开始，对应 Figure 中 axes 的索引顺序
- `i` 从 0 开始，对应 axes.lines 或 axes.collections 中的索引
- `side` 取值 `left` / `right` / `top` / `bottom`

---

### 五、编辑与重放模型

理解平台的编辑模型有助于生成更适合编辑的脚本：

```
脚本执行 → 内省 artist tree → 生成 Manifest + SVG
                                      ↓
用户在前端编辑属性 → 写入 EditLog → 下次渲染时重放
                                      ↓
可同时存在多个 EditLog 条目，支持撤销/重做
```

**对脚本编写的影响：**
- 标题/标签的文本内容**可在前端直接修改**，无需改脚本
- 字体大小、颜色、线宽等**可在右侧面板调整**
- 但**数据逻辑、统计计算、排序**等仍需通过脚本（CodePatch）修改
- GID 集合在脚本修改后会发生**漂移**（missing[] + new[]），平台会自动检测

---

### 六、样式约定

遵循以下约定可让生成的图表在平台中获得最佳编辑体验：

**推荐：**
- ✅ 白色背景，无网格线
- ✅ 四边脊柱全显示（`spines` 默认即可）
- ✅ 字体用 `sans-serif`（自动 CJK 回退）
- ✅ 标题位置默认居中
- ✅ 使用 `ax.plot()` / `ax.bar()` / `ax.scatter()` / `ax.barh()` 等标准绘图 API
- ✅ 图例用 `ax.legend()`，不传 `bbox_to_anchor` 以便前端调整位置
- ✅ 对多组数据用不同颜色区分，配色用十六进制码（如 `#1F78B4`）

**不推荐：**
- ❌ 手写 SVG 或使用 `svg` 库
- ❌ 使用 `seaborn` / `plotly` / `pyecharts` 等非 matplotlib 库
- ❌ 在脚本内硬编码刻度标签角度（前端可调）
- ❌ `plt.tight_layout()` 可保留，不影响编辑
- ❌ 在脚本中调用 `ax.set_aspect('equal')` 可能导致布局异常

---

### 七、安全限制（以下操作会被拦截）

| 类别 | 被禁止的操作 |
|------|------------|
| 文件 I/O | `open()`, `pd.read_csv()`, `pd.read_excel()`, `pickle.load()`, `json.load()` 等 |
| 系统调用 | `os.system()`, `subprocess.*`, `sys.exit()` |
| 网络 | `urllib.*`, `requests.*`, `socket.*` |
| 动态执行 | `eval()`, `exec()`, `compile()`, `__import__`, `globals()`, `locals()` |
| 危险模块 | `os`, `sys`, `subprocess`, `builtins`, `shutil`, `socket`, `urllib`, `requests` |

---

### 八、CodePatch 与 GID 漂移

如果后续用户修改脚本，平台会：
1. 执行新脚本，获取新的 GID 集合
2. 与旧 GID 集合对比 → 输出 `driftedGids: { missing[], new[] }`
3. 用户确认后，保留能匹配的 EditLog 条目，丢弃失效条目

**对初版脚本的影响：** 建议使用稳定的 GID 命名（不要动态生成 GID），确保后续编辑时漂移最小。

---

### 九、输出要求

1. **只返回纯 Python 代码**，不要用 markdown 代码块包裹
2. 不要添加任何说明文字或注释
3. 确保代码可在 `exec()` 中直接运行（无缩进问题、无语法错误）
4. **列名必须和用户提供的真实数据一致**，根据数据预览和统计信息修正用户脚本中的列名拼写、类型误判、缺失值处理等问题
5. 如果脚本里用了 `.str` 访问器，请先确认目标列确实是字符串列；对数值列不要用 `.str`
6. `set_xticks()` / `set_xticklabels()` 的数量必须严格一致

---

### 十、自查清单

改写完成后，逐一确认：

- [ ] 数据读取用的是 `pd.DataFrame(_uploaded_data)`
- [ ] 没有 `pd.read_csv()` / `pd.read_excel()` / `open()`
- [ ] 没有 `plt.savefig()` / `plt.show()`
- [ ] 列名与用户提供的列名精确匹配
- [ ] `plt.subplots()` 创建了显式的 `fig, ax` 变量
- [ ] 脚本是纯 Python，没有 markdown 包裹
- [ ] 不含禁止模块/函数
- [ ] 没有硬编码的文件路径
- [ ] 多组数据用不同颜色区分
- [ ] 中文文本可正常渲染（sans-serif 字体链）

---

### 十一、本次任务数据

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
