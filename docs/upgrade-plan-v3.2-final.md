# SciFigure IFC V3.2 Final Upgrade Plan

**版本**：V3.2 Final
**状态**：Development Ready
**定位**：从单图语义编辑器升级为项目级科研绘图工作台
**基础**：完整保留 V3.1 Semantic Layer、GID、Manifest、EditLog、CodePatch、Replay Render 体系

---

# 一、升级背景

V3.1 已完成语义感知编辑层，核心能力包括：

* Semantic Scanner
* Binding Engine
* CodePatch
* Palette Center
* GroupPanel
* LayerTree
* Axis / Grid / Spine 编辑
* Legend 增强
* 文本双击编辑

V3.1 解决的是：

```text
单 Figure 编辑
语义颜色管理
图元属性微调
代码颜色常量同步
```

V3.2 的重点不再是继续堆叠单个属性控件，而是解决真实科研绘图项目中的复杂场景：

```text
多个数据文件
一个脚本生成多张 Figure
每张 Figure 独立编辑
批量选择与批量修改
文本对象画布拖拽
项目级保存与导出
```

---

# 二、V3.2 总体目标

V3.2 分为三条主线：

```text
V3.2A：Project Layer
V3.2B：Selection Layer
V3.2C：Text Drag Layer
```

优先级：

```text
先让复杂脚本能跑
再让多个图元能批量选中和批量编辑
最后实现文本拖拽
```

对应关系：

| 主线    | 目标                   | 优先级 |
| ----- | -------------------- | --- |
| V3.2A | 多文件、多 Figure、项目级管理   | P0  |
| V3.2B | 多选、框选、批量编辑、Undo/Redo | P1  |
| V3.2C | 文本拖拽、坐标映射、位置持久化      | P2  |

---

# 三、架构分层

V3.2 后，SciFigure 的架构分为：

```text
Source Layer
  Python Script / CodePatch

Project Layer
  Project / Files / Figures / Exports

Figure Layer
  FigureId / Manifest / EditLog / Revision

Artist Layer
  GID / Props / Groups / Bindings

Selection Layer
  selectedGids / Marquee / Batch Edit / History

Render Layer
  Replay Render / Export
```

V3.2 不替换 V3.1 架构，而是在 V3.1 之上增加 Project Layer 与 Interaction 能力。

---

# 四、V3.2A：Project Layer

## 4.1 目标

V3.2A 的目标是：

```text
让真实复杂科研脚本能够进入平台并稳定运行
```

解决当前限制：

```text
一个数据文件
一个 Figure
一个编辑会话
```

升级为：

```text
多个数据文件
一个脚本生成多个 Figure
每个 Figure 独立编辑
项目级管理
```

---

## 4.2 多文件上传

支持用户在一个项目中上传多个数据文件。

支持格式：

```text
CSV
TSV
XLSX
```

上传后系统生成项目级数据文件清单。

---

## 4.3 Dataset Registry

新增数据结构：

```typescript
interface DatasetEntry {
    datasetId: string
    fileName: string
    filePath: string
    columns: string[]
    rowCount: number
    uploadedAt: string
}
```

用途：

```text
记录项目内所有上传数据文件
给脚本运行时注入文件路径
给前端展示列名和文件信息
支持后续项目恢复与导出
```

---

## 4.4 `_uploaded_file_paths` 注入

执行脚本时，平台向 Python namespace 注入：

```python
_uploaded_file_paths = {
    "summary": "/project/files/summary.csv",
    "matrix": "/project/files/matrix.csv",
    "shap": "/project/files/shap.csv"
}
```

脚本可使用：

```python
pd.read_csv(_uploaded_file_paths["summary"])
```

---

## 4.5 文件读取沙箱

V3.2A 允许脚本使用：

```python
pd.read_csv()
pd.read_excel()
```

但限制读取范围：

```text
只能读取项目上传目录内的文件
```

禁止读取：

```text
项目目录外文件
系统目录文件
任意未经授权的绝对路径文件
```

实现规则：

```text
包装 pd.read_csv / pd.read_excel
对路径执行 os.path.realpath
校验最终路径是否位于 project/files 目录内
不满足则拒绝执行
```

---

## 4.6 相对路径规则

脚本执行时，平台应临时将当前工作目录切换到项目上传文件目录：

```text
cwd = project/files
```

这样可以兼容：

```python
pd.read_csv("summary.csv")
pd.read_csv("./summary.csv")
pd.read_csv(_uploaded_file_paths["summary"])
```

同时继续阻止：

```python
pd.read_csv("../../etc/passwd")
```

路径校验流程：

```text
用户传入路径
↓
转换为 realpath
↓
检查是否位于 project/files 内
↓
允许或拒绝
```

---

## 4.7 原脚本兼容策略

V3.2A 不强制要求脚本改写为：

```python
def build_figures(datasets):
    ...
```

该结构只作为未来推荐格式。

V3.2A 优先支持：

```text
原脚本执行
+
_uploaded_file_paths 注入
+
沙箱 read_csv/read_excel
+
Figure 自动捕获
```

原因：

```text
降低存量科研脚本接入成本
避免复杂脚本被强制重构
保持当前 AI 转义链路轻量
```

---

## 4.8 Figure Registry

V3.2A 支持一个脚本生成多张 Matplotlib Figure。

新增：

```typescript
interface FigureEntry {
    figureId: string
    index: number
    manifest: FinalManifest
    editLog: EditEntry[]
    revision: number
}
```

---

## 4.9 Figure 自动捕获

不能只依赖：

```python
plt.get_fignums()
```

因为脚本可能执行：

```python
plt.close(fig)
```

导致执行结束后 Figure 不再出现在 Matplotlib 管理器中。

V3.2A 采用双机制：

```text
主路径：
patch plt.figure / plt.subplots
创建 Figure 时立即注册

兜底路径：
脚本执行结束后扫描 plt.get_fignums()

去重：
按 Figure 对象 id 去重
```

注册到：

```python
_figure_registry
```

即使脚本调用 `plt.close(fig)`，只要 `_figure_registry` 持有 Figure 引用，平台仍可进行 introspection 与 SVG 渲染。

---

## 4.10 多 Figure 返回结构

单 Figure 时继续兼容旧返回格式：

```json
{
  "status": "success",
  "svg": "<svg>...</svg>",
  "manifest": {}
}
```

多 Figure 时返回：

```json
{
  "status": "success",
  "figures": [
    {
      "figureId": "fig_1",
      "svg": "<svg>...</svg>",
      "manifest": {}
    },
    {
      "figureId": "fig_2",
      "svg": "<svg>...</svg>",
      "manifest": {}
    }
  ]
}
```

---

## 4.11 Figure Tabs

前端新增 Figure Tabs。

示例：

```text
[Figure 1] [Figure 2] [Figure 3]
```

规则：

```text
一个 Matplotlib Figure 实例 = 一个 Figure Tab
```

如果脚本中：

```python
fig, axes = plt.subplots(3, 3)
```

则仍然是：

```text
1 个 Figure Tab
9 个 Axes 节点
```

不是 9 个 Figure。

---

## 4.12 每图独立状态

每个 Figure 独立维护：

```text
Manifest
EditLog
Selection
LayerTree
Revision
SVG
ExportState
```

Figure 之间互不污染。

---

## 4.13 CodePatch 与 EditLog 重放顺序

执行顺序必须固定为：

```text
原始脚本
↓
应用 CodePatch
↓
执行脚本
↓
捕获 Figure
↓
逐图 Introspect
↓
逐图 Replay EditLog
↓
输出 SVG
```

保证：

```text
源码颜色修改生效
图元局部编辑不丢失
多图状态不互相污染
```

---

## 4.14 A2 阶段预留 Text Position Manifest

在 Figure Registry 与 Introspection 改造期间，同步扩展文本类 Artist 的 Manifest 字段，为后续 Text Drag Layer 预留数据基础。

需要提前读取：

```text
x
y
coord_system
ha
va
rotation
```

注意：

```text
A2 只负责读取与输出字段
不实现文本拖拽
不实现 Coordinate Mapper
```

这样后续 V3.2C 实现文本拖拽时，不需要再次大改 Introspector。

---

## 4.15 Project Schema

新增项目级结构：

```typescript
interface SciFigureProject {
    projectId: string
    script: string
    datasets: DatasetEntry[]
    figures: FigureEntry[]
    codePatches: CodePatch[]
    createdAt: string
    updatedAt: string
}
```

---

## 4.16 数据库存储建议

扩展已有 projects 表：

```sql
ALTER TABLE projects ADD COLUMN script TEXT;
ALTER TABLE projects ADD COLUMN file_count INTEGER DEFAULT 0;
```

新增 project_files 表：

```sql
CREATE TABLE project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT,
  stored_path TEXT,
  columns TEXT,
  row_count INTEGER,
  uploaded_at TEXT
);
```

新增 project_figures 表：

```sql
CREATE TABLE project_figures (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  figure_index INTEGER,
  session_id TEXT,
  revision INTEGER DEFAULT 1
);
```

删除项目时，应同步删除：

```text
数据库记录
磁盘物理文件
项目输出文件
```

---

## 4.17 API

新增项目文件接口：

```text
POST   /api/projects/:id/files
GET    /api/projects/:id/files
DELETE /api/projects/:id/files/:fileId
```

新增 Figure 接口：

```text
GET  /api/projects/:id/figures
POST /api/projects/:id/figures/render
```

新增导出接口：

```text
POST /api/projects/:id/export
```

---

## 4.18 V3.2A 实施阶段

### A1：多文件上传与沙箱读取

内容：

```text
多文件上传
Dataset Registry
_uploaded_file_paths 注入
pd.read_csv / pd.read_excel 沙箱
相对路径 cwd 处理
```

目标：

```text
多文件脚本可以在平台内运行
```

---

### A2：Figure Registry 与多图工作区

内容：

```text
patch plt.figure / plt.subplots
plt.get_fignums 兜底
_figure_registry
多 Figure 返回结构
Figure Tabs
每图独立 Manifest / EditLog
Text position Manifest 预留字段
```

目标：

```text
一个脚本生成多张图时，每张图都可独立预览和编辑
```

---

### A3：Project Schema 与 API

内容：

```text
Project Schema
project_files
project_figures
文件 API
Figure API
导出 API
项目恢复
物理文件清理
```

目标：

```text
项目状态可保存、恢复、导出
```

---

# 五、V3.2B：Selection Layer

## 5.1 目标

V3.2B 的目标是：

```text
让用户可以像 PPT / Figma 一样选择多个图元并批量处理
```

---

## 5.2 Selection State

新增：

```typescript
interface SelectionState {
    selectedGids: string[]
    activeGid?: string
    mode: "single" | "multi" | "marquee" | "group"
}
```

---

## 5.3 支持选择方式

支持：

```text
单击选择
Ctrl / Cmd 多选
Shift 多选
框选
LayerTree 多选
GroupPanel 全选
```

---

## 5.4 Marquee Selection

新增框选系统。

流程：

```text
鼠标按下
↓
拖出矩形
↓
读取 SVG 元素 bbox
↓
判断与框选区域是否相交
↓
更新 selectedGids
```

---

## 5.5 选择框数据

Manifest 或前端运行时需要获得：

```json
{
  "gid": "patch.0.0",
  "bbox": {
    "x0": 120,
    "y0": 80,
    "x1": 180,
    "y1": 160
  }
}
```

bbox 可由浏览器端 `getBBox()` 获取。

---

## 5.6 批量编辑

多选后，右侧属性面板显示共同属性。

支持：

```text
visible
alpha
color
linewidth
```

---

## 5.7 批量 EditLog

一次批量编辑生成多条 EditLog。

示例：

```json
[
  {
    "gid": "patch.0.0",
    "prop": "alpha",
    "value": 0.6
  },
  {
    "gid": "line.0.0",
    "prop": "alpha",
    "value": 0.6
  }
]
```

---

## 5.8 属性冲突规则

当某个对象不支持当前属性时：

```text
跳过该对象
```

支持该属性时：

```text
生成对应 EditLog
```

---

## 5.9 Undo / Redo

新增 Undo / Redo。

一次用户操作，无论生成几条 EditLog，都作为一个事务进入 history stack。

```typescript
interface HistoryStep {
    label: string
    patches: EditEntry[]
    timestamp: number
}
```

一次批量操作：

```text
多个 EditLog
=
一个 Undo Step
```

Undo 时回到上一个 EditLog 状态。

Redo 时恢复下一步 EditLog 状态。

---

## 5.10 V3.2B 实施阶段

### B1：Selection State

内容：

```text
selectedGids
activeGid
Ctrl / Cmd 多选
Shift 多选
LayerTree 多选
GroupPanel 全选
```

---

### B2：Marquee Selection

内容：

```text
框选矩形
getBBox
相交检测
selectedGids 更新
```

---

### B3：Batch Edit + Undo / Redo

内容：

```text
共同属性计算
批量 EditLog
一次操作一个 Undo Step
Undo / Redo
```

---

# 六、V3.2C：Text Drag Layer

## 6.1 目标

V3.2C 的目标是：

```text
让文本对象可以在画布中直接拖动并保持重渲染一致
```

---

## 6.2 支持对象

支持：

```text
Title
XLabel
YLabel
Legend Text
Annotation
ax.text
fig.text
```

---

## 6.3 Text Manifest 扩展

文本对象新增或补全：

```json
{
  "x": 0.5,
  "y": 1.02,
  "coord_system": "axes",
  "ha": "center",
  "va": "bottom",
  "rotation": 0
}
```

---

## 6.4 Coordinate Mapper

新增独立模块：

```text
Coordinate Mapper
```

职责：

```text
SVG 坐标
↓
Matplotlib 坐标
```

第一阶段支持：

```text
axes
```

坐标系。

---

## 6.5 TextDragLayer

前端新增：

```text
TextDragLayer
```

支持：

```text
单击选中
拖动实时预览
松手提交
双击编辑文本内容
```

---

## 6.6 Position EditLog

新增：

```json
{
  "gid": "text.0.0",
  "prop": "position",
  "value": {
    "x": 0.5,
    "y": 1.02,
    "coord_system": "axes"
  }
}
```

---

## 6.7 后端应用

新增：

```python
apply_text_position()
```

逻辑：

```text
找到对应 Text Artist
设置 position
设置 transform
重新渲染
```

---

## 6.8 V3.2C 实施阶段

### C1：Text Position Manifest

内容：

```text
读取文本 x/y
读取 transform 类型
读取 ha/va/rotation
```

说明：

```text
该字段读取已在 A2 预留
C1 主要负责补齐和验证
```

---

### C2：Coordinate Mapper

内容：

```text
SVG bbox
Axes bbox
Figure size
像素位移
axes 坐标换算
```

---

### C3：TextDragLayer

内容：

```text
画布选中
拖动预览
松手生成 position EditLog
后端重渲染
```

---

# 七、Minor Enhancements

以下内容不作为 V3.2 主线，但可在开发过程中顺带实现。

---

## 7.1 LineWidth 批量增强

现有对象若已支持 linewidth，则在批量编辑中统一显示：

```text
Line Width
```

后端统一分发：

```text
Line2D
Patch
Collection
Spine
Grid
Tick
```

---

## 7.2 SpinePanel

V3.1 已有 Spine 识别与编辑。

V3.2 不重新设计 Spine 系统。

可选新增图形化面板：

```text
      Top
Left       Right
     Bottom
```

---

## 7.3 批量导出

多 Figure 项目支持：

```text
导出当前 Figure
导出全部 Figure
```

---

# 八、兼容性策略

## 8.1 V3.1 单图兼容

旧流程继续可用：

```text
单数据
单 Figure
单 Manifest
单 EditLog
```

在 V3.2 中自动视为：

```text
Project
 ├ Dataset x1
 └ Figure x1
```

---

## 8.2 旧 API 兼容

V3.1 API 保持可用。

V3.2 只新增项目级 API，不删除旧端点。

---

## 8.3 旧 EditLog 兼容

旧 EditLog 不迁移格式。

在 V3.2 中按默认 figureId 归属：

```text
fig_1
```

---

## 8.4 Semantic Layer 兼容

V3.1 的：

```text
Palette
Binding
CodePatch
GroupPanel
LayerTree
Axis/Grid/Spine
Legend
Text Editing
```

全部保留。

---

# 九、安全边界

## 9.1 文件读取

限制：

```text
pd.read_csv
pd.read_excel
```

只能读取项目上传目录。

---

## 9.2 危险操作

继续拦截：

```text
os.system
subprocess
eval
exec
__import__
网络请求
```

---

## 9.3 资源限制

建议限制：

```text
单文件大小
总项目大小
执行时间
内存使用
Figure 数量
```

---

# 十、总实施路线

| 阶段 | 名称                     | 内容                                                       | 优先级 |
| -- | ---------------------- | -------------------------------------------------------- | --- |
| A1 | 多文件支持                  | 上传、Dataset Registry、文件路径注入、沙箱读取、cwd 处理                   | P0  |
| A2 | Figure Registry        | 多 Figure 捕获、多图返回、Figure Tabs、每图 EditLog、Text Manifest 预留 | P0  |
| A3 | Project Schema         | 项目结构、数据库、API、恢复与导出、物理文件清理                                | P1  |
| B1 | Selection State        | 多选状态、LayerTree 多选、GroupPanel 全选                          | P2  |
| B2 | Marquee Selection      | 框选、bbox 检测、批量选择                                          | P2  |
| B3 | Batch Edit / Undo      | 批量 EditLog、共同属性、Undo/Redo 事务                             | P2  |
| C1 | Text Position Manifest | 文本位置字段、坐标系、对齐方式验证                                        | P3  |
| C2 | Coordinate Mapper      | SVG 到 axes 坐标转换                                          | P3  |
| C3 | TextDragLayer          | 文本拖拽、位置 EditLog、重渲染                                      | P3  |

---

# 十一、V3.2 最终交付状态

V3.2 完成后，平台具备：

```text
多个数据文件
一个脚本多张 Figure
项目级状态管理
Figure Tabs
每图独立编辑
框选
多选
批量编辑
Undo / Redo
文本拖拽
批量导出
```

同时保持：

```text
V3.1 所有语义层与图元编辑能力
```

不破坏现有架构。

---

# 十二、核心结论

V3.2 的核心不是继续增加单个属性控件。

V3.2 的核心是：

```text
Project Layer
+
Selection Layer
+
Text Drag Layer
```

其中优先级为：

```text
先 Project Layer
再 Selection Layer
最后 Text Drag Layer
```

原因：

```text
Project Layer 解决复杂科研脚本能不能进入平台
Selection Layer 解决多个图元能不能批量操作
Text Drag Layer 解决交互体验是否接近 PPT
```

V3.2 完成后，SciFigure 将从：

```text
单图语义编辑器
```

升级为：

```text
项目级科研绘图工作台
```
