# SciFigure 统一编辑中心与属性能力升级方案

> 状态：Phase 0-8a 已提交；Phase 8b 匿名观察候选与本地发布控制基线已完成验收，Legacy Retire 删除仍等待稳定发布观察期
> 创建时间：2026-07-12 16:10:44 +08:00
> 最后更新：2026-07-13 17:05:09 +08:00
> 适用范围：属性编辑、布局中心、组件中心、配色中心、字体中心
> 实施方式：Baseline -> Shadow -> Scoped Enable -> Default Enable -> Legacy Retire

## 1. 升级目的

当前五个编辑中心已经覆盖大量科研作图能力，但同一对象、同一属性从不同入口进入时，控制深度和行为并不完全一致。

典型表现：

```text
同一个文本对象：
属性编辑可能显示旋转、水平对齐、垂直对齐；
字体中心只显示字体、字号、字重、字形和颜色；
组件中心又只显示它自己的公共属性集合。

同一个刻度文字：
单个 tick、整组 tick 和虚拟 axis 使用不同 prop 名；
部分入口修改 fontsize，部分入口需要 tick_labelsize；
旋转、偏移和颜色在不同中心的可见性不同。

同一个图例：
容器、标题、文字、marker/line/patch 是不同对象；
字号、符号缩放、文字间距、垂直对齐和整体位置分散在不同面板。
```

本次升级的核心不是给每个中心机械补齐所有按钮，而是建立：

```text
一个对象能力事实来源
-> 一套规范属性描述
-> 一套目标解析与 patch 语义
-> 五个中心按各自职责投影
```

中心可以有不同组织方式和默认作用范围，但同一属性一旦在多个中心出现，其控件、单位、范围、能力判断、目标范围、Draft 行为、写回方式和保存结果必须一致。

## 2. 当前实现事实

### 2.1 五个中心

`src/components/RightSidebar.tsx` 当前定义五个标签：

```text
properties  属性编辑
layout      布局中心
groups      组件中心
palette     配色中心
fonts       字体中心
```

| 中心 | 当前入口 | 当前主要职责 |
|---|---|---|
| 属性编辑 | `renderObjectPanel()` | 选中对象的专用面板或遍历 `editable` 生成通用控件 |
| 布局中心 | `renderSubplotLayoutPanel()` | 多子图排列、间距、边距、交换、尺寸和色条布局 |
| 组件中心 | `renderComponentsPanel()` | 按对象类别批量选择和修改公共样式 |
| 配色中心 | `renderPalettePanel()` | 按 palette/binding/series 关系修改颜色 |
| 字体中心 | `renderFontCenterPanel()` | 按标题、轴标签、刻度、图例等角色批量修改字体 |

### 2.2 已有协议基础

当前系统并非从零开始。已有基础包括：

- `ManifestObject.editable`：旧兼容属性列表。
- `ManifestObject.propertyCapabilities`：renderer 输出的属性级能力。
- `ManifestPropertyCapability`：包含 `patchMode`、`scopes`、`preview`、`replay`、`coordinateSpace`、`derivedEffects` 和 `unsupportedReason`。
- `EditingIntent`：表达目标角色、选择范围、属性和值。
- `targetResolver`：严格解析对象、作用域、歧义和跳过原因。
- Draft Patch Batch：同一目标同一属性 last-write-wins，应用后按 Figure 结算。
- Python/R 双 renderer：分别声明真实能力，不要求内部实现相同。

因此本次升级应复用现有协议，不新建平行编辑链路。

### 2.3 当前不一致的直接证据

#### 属性能力被多处重复判断

当前 `supportsBatchProp()` 同时使用：

```text
propertyCapabilities
editable
unsupportedProps
前端 kind 白名单
```

renderer 即使已经声明能力，前端仍可能有另一套规则；旧项目没有新字段时，又进入不同兼容分支。

#### 字体中心使用固定属性集合

字体中心目前固定支持：

```text
fontsize
fontfamily
fontweight
fontstyle
color
```

但 Python 文本 renderer 已声明：

```text
text
fontsize
fontfamily
fontweight
fontstyle
color
ha
va
rotation
position
zorder
```

因此“renderer 能改”与“字体中心展示”不是同一集合。

#### tick 存在属性别名和对象层级差异

当前代码需要在以下属性间转换：

```text
fontsize     <-> tick_labelsize
fontfamily   <-> tick_labelfamily
color        <-> tick_labelcolor
fontweight   <-> tick_fontweight
fontstyle    <-> tick_fontstyle
rotation     <-> tick_rotation
```

映射分别存在于字体中心、target resolver 和 legacy compiler 中。新增属性若只改一处，就可能出现某中心有控件、另一中心无控件，或预览能变但重绘后恢复。

#### 组件中心混合结构与字体逻辑

组件中心目前同时处理：

```text
line/marker/fill/alpha/visible
spine/grid/tick
subplot width/height/aspect
legend markerscale/marker_yoffset/handletextpad/labelspacing
fontsize/fontweight/fontstyle
```

它不只是组件分类器，也承担部分字体和布局编辑。必须明确哪些是共享属性投影，哪些是组件中心专属能力。

#### 配色中心较精确，但控件语义仍未统一

配色中心已通过 palette binding 和 resolver-v2 处理精确目标、子集修改和歧义阻止。它是当前最接近能力驱动 UI 的中心，但颜色控件、属性别名、mixed state、Draft 状态和跨 Figure 报告仍应复用统一属性描述器。

### 2.4 当前重叠属性矩阵

下表描述当前代码形态，不代表升级后的目标状态。“部分”表示只对某些 kind、专用面板或虚拟对象出现。

| 属性能力 | 属性编辑 | 字体中心 | 组件中心 | 配色中心 | 布局中心 | 当前主要问题 |
|---|---:|---:|---:|---:|---:|---|
| 文本内容 | 有 | 无 | 无 | 无 | 无 | 单对象入口较完整，角色批量内容需避免误扩散 |
| 字体家族 | 有 | 有 | 部分 | 无 | 无 | 三处能力判断和 mixed 处理不同 |
| 字号 | 有 | 有 | 有 | 无 | 无 | legend/tick 需要别名或容器 patch |
| 字重 | 有 | 有 | 有 | 无 | 无 | axis 虚拟属性与真实 text prop 不同 |
| 字形 | 有 | 有 | 有 | 无 | 无 | 同上 |
| 文字颜色 | 有 | 有 | 有 | 有 | 无 | 对象颜色与 palette 语义绑定容易混淆 |
| 旋转 | 有/部分 | 无 | 仅 tick 组 | 无 | 无 | renderer 能力未完整投影到字体中心 |
| 水平/垂直对齐 | Python 文本有 | 无 | 无 | 无 | 无 | 当前缺少共享控件与 R 能力说明 |
| 换行/上下标 | 文本专用流程 | 无 | 无 | 无 | 无 | 内容工具与字体属性未形成统一文本能力组 |
| 可见性 | 有 | 无 | 有 | 无 | 部分 | 控件和即时预览策略不统一 |
| 透明度 | 有 | 无 | 有 | 部分 | 无 | mixed state 和 local preview 需统一 |
| 线宽/线型 | 有 | 无 | 有 | 无 | 无 | 不同 kind 的支持依赖前端白名单 |
| marker 大小 | 有 | 无 | 有 | 无 | 无 | `markersize`、`size`、`markerscale` 含义不同 |
| fill/edge color | 有 | 无 | 有 | 有 | 无 | 需要 descriptor 与 binding 各司其职 |
| tick 方向/长度/宽度 | axis 专用 | 风格预设部分涉及 | 有 | tick color 部分 | 无 | 字体预设混入 axis/spine 风格属性 |
| 图例符号缩放/间距 | legend 专用 | 字号联动部分 | 有 | 无 | 位置部分 | 容器、文字和 handle 的职责分散 |
| 子图位置/宽高/比例 | subplot 专用 | 无 | 有 | 无 | 有 | 同一几何属性在属性、组件、布局三处出现 |
| colorbar 位置/尺寸 | 专用面板 | 无 | 有 | cmap 部分 | 有 | mappable、色标容器和文字需分层 |
| 普通文本位置 | capability 支持时 | 无 | 无 | 无 | 不应出现 | 应由属性编辑与拖拽共享 position 语义 |

矩阵说明了两个不同问题：

1. **应统一但尚未统一的重叠能力**：字体五项、旋转、颜色、可见性、线宽、几何数值等。
2. **应保持中心专属的能力**：palette binding、subplot 重排、对象专属内容和坐标、组件容器关系等。

升级不能用“所有中心都显示所有属性”解决第一类问题，否则会破坏第二类职责边界。

## 3. 问题本质

| 层 | 当前问题 | 用户可见结果 |
|---|---|---|
| 对象识别 | 同类对象可能表现为真实 child、虚拟 axis 或 container | 同类内容在不同项目中出现于不同中心 |
| 属性能力 | renderer capability、editable 和前端白名单并存 | 有的入口显示，有的入口不显示 |
| 属性命名 | 文本属性与 axis/tick 虚拟属性存在别名 | 同样的字号生成不同 prop |
| 作用范围 | 单对象、选中组、语义组、子图、Figure 默认范围不同 | 单个修改扩散或整组只改第一个 |
| UI 控件 | 各中心手写控件和默认值 | 范围、步长、mixed state、提示不一致 |

这不是单纯 UI 补按钮问题。只补 UI 会继续扩大重复逻辑，后续每增加一种属性都要修改多个中心、resolver、compiler 和 renderer。

## 4. 目标架构

### 4.1 分离“属性是什么”和“当前对象能不能改”

新增前端规范属性描述器 `PropertyDescriptor`，负责定义属性本身：

```ts
interface PropertyDescriptor {
  id: string;
  family: PropertyFamily;
  label: string;
  valueType: 'number' | 'string' | 'boolean' | 'color' | 'enum' | 'position' | 'range';
  control: 'number' | 'slider' | 'text' | 'font' | 'color' | 'select' | 'toggle' | 'position';
  unit?: 'pt' | 'px' | 'deg' | 'inch' | 'cm' | 'ratio' | 'none';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  aliases?: PropertyAliasRule[];
  centers: EditingCenterId[];
  mixedValuePolicy: 'show_mixed' | 'use_first' | 'not_supported';
  dependencies?: string[];
  conflicts?: string[];
}
```

renderer 返回的 `ManifestPropertyCapability` 继续负责当前对象的真实能力：

```text
是否支持
允许哪些作用域
local_patch 还是 backend_patch
预览是否精确
重放是否稳定
使用什么坐标系
有哪些派生影响
为什么不支持
```

两者关系：

```text
PropertyDescriptor 存在 != 当前对象支持
当前对象支持 = descriptor 存在 + renderer capability 允许
```

### 4.2 统一属性投影层

五个中心不再自行判断 kind 和 prop，而是请求中心投影：

```ts
projectEditingControls({
  center,
  manifest,
  selection,
  scope,
}) -> {
  groups,
  controls,
  resolvedTargets,
  skippedTargets,
  ambiguousTargets,
  mixedValues,
}
```

投影层负责“这个中心如何组织当前可用能力”，不直接执行 patch。

### 4.3 统一执行链路

```text
用户修改控件
-> PropertyDescriptor 校验和规范化值
-> Center Projection 提供目标与默认 scope
-> EditingIntent
-> Target Resolver
-> PatchPlan
-> Draft Patch Batch
-> 按 Figure 调度
-> renderer 写回
-> 成功后保存 revision/history/export anchor
```

任何中心不得绕开 target resolver 按 id 猜测整组对象；任何前端控件不得在 renderer 不支持时伪装为可编辑。

## 5. 五个中心职责边界

### 5.1 属性编辑：选中对象的完整检查器

定位：当前选中对象最完整、最精确的入口。

应展示：

- 当前对象全部可编辑属性。
- readonly/unsupported 属性及原因。
- 对象身份、角色、所属子图、容器关系和坐标系。
- 对象专属属性，如 annotation anchor、legend loc、heatmap clim。

默认范围：`selected_only` / `object`。不得因角色相同自动扩大为整组。

### 5.2 字体中心：按语义角色批量排版

定位：标题、轴标签、刻度、图例和 annotation 的排版中心。

共享文本属性：

```text
内容：text、换行、上下标
字体：family、size、weight、style
外观：color、opacity、visible
排版：rotation、horizontal alignment、vertical alignment、line spacing/wrap
位置：offset/position（仅能力和坐标明确时）
```

默认范围：用户选择的语义组和当前子图；跨 Figure 必须显式触发。控件取所选对象能力交集，并显示“支持 N/M 个对象”。

### 5.3 组件中心：对象类别和结构样式

定位：按图元类型、容器和关系批量修改结构样式。

主要类别：

```text
子图/axes、边框/spine、网格/grid
线、点、柱形、误差棒、茎叶图、箱线图、小提琴图
patch/fill、图例容器与图例符号
heatmap/colorbar、annotation arrow、文本对象
```

组件中心可投影少量共享字体属性，但不得维护另一套字体能力规则。“更多文字设置”应切换到同一选择下的字体中心，而不是复制控件实现。

### 5.4 配色中心：语义色彩绑定

定位：按 series/layer/scale/group/palette 关系修改颜色。

主要属性：

```text
color、facecolor、edgecolor
marker/line/text/spine/grid/tick color
cmap/vmin/vmax、alpha
```

默认范围：精确 binding 命中的语义系列。相同十六进制颜色不构成同组依据。

### 5.5 布局中心：几何与物理尺寸

定位：只处理 Figure、subplot、axes box、colorbar 和容器的几何关系。

主要属性：

```text
画布和绘图区物理宽高
subplot left/bottom/width/height
行列、阅读顺序、水平/垂直间距、外边距
面板交换
colorbar gap/width/height/alignment
legend container position
```

文字 rotation/align 属于文字排版，不进入布局中心；普通文本 position 由属性编辑或拖拽进入，不能与 subplot 布局混为一类。

## 6. 规范属性分类

| 属性族 | 典型属性 | 主要中心 | 备注 |
|---|---|---|---|
| 文本内容 | text、label、title、newline、script | 属性、字体 | 内容默认不跨 Figure |
| 字体 | fontfamily、fontsize、fontweight、fontstyle | 属性、字体、组件投影 | 同一控件定义 |
| 文字排版 | rotation、ha、va、lineheight、wrap | 属性、字体 | renderer 能力决定是否开放 |
| 颜色 | color、facecolor、edgecolor、cmap | 属性、配色、组件 | binding 与对象属性分离 |
| 线条 | linewidth、linestyle、visible、alpha | 属性、组件 | spine/grid/data line 共用描述器 |
| 点 | marker、markersize、marker edge/fill | 属性、组件、配色 | collection size 与 Line2D markersize 有别名 |
| 坐标轴 | limits、tick direction/length/width/pad | 属性、组件 | tick label 与 tick line 分离 |
| 图例 | loc、ncol、markerscale、marker_yoffset、handletextpad、labelspacing | 属性、组件、布局 | 容器与 children 分离 |
| 几何 | position、left、bottom、width、height、aspect | 属性、布局、拖拽 | 必须带 coordinateSpace |
| 可见性 | visible、alpha、frameon | 属性、组件 | local preview 不等于持久化成功 |
| 层级 | zorder | 属性、组件 | 多对象 mixed state 必须可解释 |

## 7. 文本对象能力目标矩阵

目标矩阵不是要求所有对象全绿，而是要求“真实支持什么就一致显示什么”。

| 对象 | 内容 | 字体五项 | 旋转 | H/V 对齐 | 换行/上下标 | 位置 | 批量角色 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Figure 标题 | 应支持 | 应支持 | 按 capability | 按 capability | 应支持 | 按坐标系 | figure title |
| 子图标题 | 应支持 | 应支持 | 按 capability | 按 capability | 应支持 | 按坐标系 | title/subplot |
| X/Y 轴标签 | 应支持 | 应支持 | 按 capability | 按 capability | 应支持 | axis offset | x/y axis label |
| 单个 X/Y tick | 应支持 | 应支持 | 应支持 | 谨慎 | 应支持 | 通常 readonly | explicit tick |
| 整组 X/Y tick | 不默认批改内容 | 应支持 | 应支持 | 谨慎 | 不适用 | dx/dy | tick role |
| 图例标题 | 应支持 | 应支持 | 按 capability | 按 capability | 应支持 | 随容器 | legend title |
| 图例文字 | 应支持 | 应支持 | 谨慎 | 由容器布局 | 应支持 | 随容器 | legend text |
| annotation 文本 | 应支持 | 应支持 | 应支持 | 应支持 | 应支持 | 支持时可拖拽 | annotation text |
| colorbar label/tick | 按对象支持 | 应支持 | 按 capability | 按 capability | 按对象支持 | 随 colorbar | colorbar role |
| R facet strip | 按能力支持 | 应支持 | 按 capability | 按 capability | 按能力支持 | readonly/条件 | facet strip |

“字体五项”指字体族、字号、字重、字形、颜色。下划线、字符级富文本和任意 MathText/WYSIWYG 不在未验证 renderer 上直接开放。

## 8. 跨中心一致性合同

以 `rotation` 为例，不论从属性编辑、字体中心还是组件中心进入，必须共用：

```text
标签：旋转角度
单位：degree
范围：-180..180
步长：1
mixed state：显示“多种值”
目标能力：renderer propertyCapabilities
属性别名：text.rotation / axis.tick_rotation
提交：Draft
历史：一次应用一个历史步骤
失败：保留失败 Figure 草稿并说明原因
```

`fontsize`、`fontfamily`、`fontweight`、`fontstyle`、`color`、`linewidth`、`visible` 等重叠属性同样只能有一个 descriptor。

## 9. 多选与 mixed state

批量编辑不能再用“取第一个对象值”掩盖差异。

统一规则：

```text
所有值相同：显示实际值
值不同：显示 mixed，不自动写入
部分对象支持：显示支持 N/M；默认只修改支持对象
存在歧义：不生成 patch
作用域不允许：禁用并显示原因
用户修改 mixed 控件：向所有支持目标写入新值
```

批量 patch 按 `${figureId}:${gid}:${prop}` 去重，last-write-wins。容器与其 owned children 同时出现时优先容器，避免重复修改。

## 10. Python/R 能力诚实原则

前端属性目录可以统一，但 renderer 能力不能伪统一。

### Python

Matplotlib artist 能提供较完整的 getter/setter、坐标系和容器关系。仍需针对 legend、annotation、colorbar、共享轴和第三方 artist 验证重放稳定性。

### R

ggplot2 的可靠写回主要依赖 theme、scale、layer、guide、facet 和稳定数据键。R 可以对齐前端属性名称和用户操作，但不承诺任意 grob、base R、`ggrepel` 或第三方扩展对象具有 Python 相同颗粒度。

统一规则：

```text
Python 支持、R 不支持：R 控件 readonly/unsupported，并说明原因
R 使用不同原生属性：通过 alias adapter 生成 R 可执行 patch
R 只能组级修改：capability scopes 不声明 object
R 重放不稳定：replay=conditional，不默认批量或跨 Figure
```

## 11. Draft、历史、渲染和保存不变量

1. 需重绘属性先进入 Draft，不因切换中心立即重复渲染。
2. 同一目标同一属性 last-write-wins。
3. 点击应用后只渲染受影响 Figure。
4. 一个成功批次只形成一个撤销步骤。
5. 部分 Figure 失败时，成功 Figure 提交，失败 Figure 保留草稿。
6. stale response 不得覆盖较新 revision。
7. 刷新后恢复 SVG、manifest、editLog、revision、历史和导出锚点。
8. 切换中心不丢失当前选择、子图范围或未应用草稿。
9. local preview 只是预览，最终状态由 renderer 和保存链路确认。

## 12. UI 设计规则

### 控件一致性

- 数字控件统一 label、单位、范围、step 和非法值提示。
- 颜色统一 swatch、颜色输入、mixed state 和语义绑定提示。
- 字体统一字体选择、不可用字体提示和 fallback 展示。
- 布尔值统一 toggle/checkbox。
- 枚举统一 select/segmented control 和可选值集合。

### 能力状态

```text
editable      当前范围全部可编辑
partial       部分目标可编辑，显示 N/M
readonly      可读取但当前不能安全写回
unsupported   renderer 明确不支持
```

React 不得直接渲染 capability 状态对象；状态必须转换为标签、计数或原因字符串，避免再次出现 “Objects are not valid as a React child”。

### 中心间跳转

```text
组件中心文本组 -> 字体中心，保留对象和子图范围
配色中心系列 -> 组件中心，保留系列选择
属性编辑 subplot -> 布局中心，聚焦对应子图
字体中心某角色 -> 属性编辑，定位到具体对象
```

跳转不得清空 Draft，不得改变 Figure，不得扩大选择。

## 13. 升级影响面、功能联动与兼容性合同

### 13.1 能否保证不破坏原功能

不能在实施和回归完成前承诺“绝对不会出现回归”。本次升级位于所有可视化编辑入口与 patch 执行链之间，属于高复用边界；即使不改 renderer，也可能因目标、prop、scope 或 patchMode 变化影响最终行为。

可以建立并执行以下保证方式：

```text
协议只做增量扩展，不删除旧字段
新投影先 Shadow，不接管用户操作
五个中心独立 feature flag，不同时切换
旧 manifest、旧项目、旧预设继续可读
patch wire format、Draft、历史、保存接口保持兼容
每个中心有独立回归证据和即时回滚路径
任一核心不变量失败则停止默认启用
```

因此正确结论是：

> 该架构可以把破坏风险控制在可检测、可隔离、可回滚的范围内；只有基线、影子比对和真实项目回归通过后，才能确认对应中心没有破坏原功能。

### 13.2 直接影响的现有能力

下列能力位于本次升级的直接修改范围：

| 能力 | 当前连接点 | 可能变化 | 必须保持 |
|---|---|---|---|
| 单对象属性编辑 | `renderObjectPanel()`、`renderField()` | 控件由 descriptor 生成 | 选中对象不扩大，专用面板继续可用 |
| 字体中心 | `renderFontCenterPanel()` | 增加能力交集、旋转和对齐等投影 | 现有字体五项、预设和子图范围不退化 |
| 组件中心 | `renderComponentsPanel()`、`supportsBatchProp()` | capability 替代部分 kind 白名单 | 现有分组、容器优先、整组选中不变化 |
| 配色中心 | `renderPalettePanel()`、palette resolver | 统一颜色控件和状态 | 精确 binding、同色不同组隔离继续成立 |
| 布局中心 | `renderSubplotLayoutPanel()` | 几何 descriptor 与中心职责隔离 | 行列、间距、交换、原图和色条布局继续可用 |
| 多选批量编辑 | `selectedGids`、batch panel | mixed/partial 状态更严格 | 任意数量多选、支持对象不漏项 |
| EditingIntent | intent schema/compiler/resolver | alias 和 scope 统一 | 旧 intent 可编译，歧义仍默认拒绝 |
| Python/R 属性展示 | renderer `propertyCapabilities` | UI 按真实能力显示 | Python 不因 R 对齐退化，R 不伪装支持 |

### 13.3 间接影响和联动能力

这些功能不一定修改 UI 代码，但会消费编辑中心产生的 patch、`editLog`、revision 或 SVG，因此必须纳入回归。

#### Draft Patch Batch

当前 `handlePatch()` 把所有中心产生的 patch 转成 Draft，并以对象和属性形成草稿键。若统一层改变规范 prop，可能出现：

```text
同一语义属性生成两个 Draft 键
旧 prop 与新 alias 不能 last-write-wins
切换中心后草稿数量增加而不是覆盖
partial target 的草稿被错误视为全部完成
```

兼容合同：Draft 持久键继续基于最终 renderer prop；descriptor id 只用于 UI，不直接替代已持久化 prop。若必须升级 key，需提供版本化迁移函数。

#### 撤销、重做和历史摘要

历史记录以成功执行后的 `editLog` 快照为基础。统一中心若把一次操作拆成不同数量的 patch，会改变历史步数、摘要和恢复结果。

兼容合同：

```text
草稿阶段不进入历史
一次“应用”仍是一个历史动作
同一规范属性不产生重复 editLog
撤销后 SVG、manifest、editLog 和 revision 一致
代码历史与属性编辑历史继续共存
```

#### 按 Figure 渲染、请求防抖和缓存

`executeSingleFigurePatch()` 根据 `patch.mode` 判断是否后端重绘，并使用 `requestId/baseRevision` 防止旧结果覆盖。缓存键又依赖规范化 `editLog`。

风险包括：

```text
本应 backend_patch 的属性被标成 local_patch，刷新后丢失
本应 local preview 的属性触发多余重绘
同义 alias 形成不同 cache key
一次跨图应用错误调度全部 Figure
```

兼容合同：`patchMode` 以 renderer capability 为最终事实；descriptor 不自行推断持久化模式。保持 per-Figure requestId、baseRevision、并发池和 stale response guard。

#### 保存、刷新和项目恢复

保存链路持久化每个 Figure 的 `editLog`、revision 和 history，并会直接保存可持久化的 local draft。属性名称或 Draft 语义变化会直接影响刷新恢复。

兼容合同：

```text
旧 editLog 无需重写即可重放
新 editLog 继续使用现有 gid/prop/value/mode 结构
保存不能消费等待失败 Figure 重试的草稿
项目重新打开后选择、Figure 数量、SVG 和历史不丢失
```

#### 跨 Figure 应用

跨 Figure 会优先根据 `EditingIntent` 重新解析目标，否则进入 semantic mapping 兼容路径。统一中心会提高 intent 覆盖率，但也可能改变 fanout 范围。

兼容合同：

```text
内容、位置和布局默认禁止跨 Figure
样式跨图必须有角色、kind 或稳定 identity
单图到多子图的 fanout 必须逐 subplot 报告
无法唯一映射时跳过，不选择“最像”的对象
跨图应用报告保留 applied/skipped/ambiguous
```

#### 拖拽和位置确认

拖拽有独立的 `pendingPositionPatches`、identity key、累计位移和确认/取消流程。统一 position descriptor 与拖拽有关，但第一阶段不能直接替换拖拽状态机。

兼容合同：

```text
拖拽关闭时仍可单击选中和属性编辑
拖拽开启时多目标累计不被中心切换清空
拖拽仍只在确认后进入 patch/Draft/历史
position 必须保持 coordinateSpace
普通文本、legend container 和 tick label 不共用位移算法
```

#### 字体、风格和配色预设

当前字体预设、风格预设和配色预设分别存储在版本化 localStorage key 中。控件统一后，旧预设值仍需映射到新 descriptor。

风险包括：预设列表消失、字段被忽略、一次预设拆成多次渲染、图例字号联动符号缩放失效。

兼容合同：

- 保留现有 storage key 的读取能力。
- 新 schema 使用新版本 key，并提供旧值只读迁移。
- 迁移失败时不删除旧预设。
- 应用预设继续形成一个 Draft batch。
- 图例字号与 marker scale 的既有联动必须单独验证，不能由通用 fontsize descriptor 隐式覆盖。

#### 导出、导出历史和组合图资产

导出格式本身不依赖编辑中心，但导出资产记录 revision、edit count 和 `editLogHash`；组合图页面也会根据源 Figure revision 判断资产是否过期。

因此 patch 数量或历史粒度变化会影响：

```text
“第一次导出/上次导出”历史锚点
导出资产对应的编辑步骤
组合图资产过期提示
子图导出的版本一致性
```

兼容合同：同一用户动作的历史事务边界不变化；导出仍锚定成功 revision，而不是控件操作次数或未应用 Draft 数量。

#### A4/Word 真实预览

A4/Word 预览只消费最终 Figure 尺寸、SVG 和字体结果，不应接入 descriptor。但字体、布局修改的输出会改变其显示，因此需验证：

```text
真实物理尺寸没有因单位转换改变
最小字号估算仍读取最终字体
适应版心不改变编辑中的 Figure 尺寸
预览开关不提交 patch
```

### 13.4 原则上不应受影响的能力

以下能力不在本次修改边界内：

| 能力 | 隔离要求 | 最小回归 |
|---|---|---|
| 宣传页、帮助页、登录注册 | 不引用编辑 descriptor | 匿名/登录导航 smoke |
| 项目列表和项目归属 | 不修改 project/user API | 当前账号项目数量和 ownership audit |
| 数据上传与重新配置 | 不修改数据文件契约 | 脚本优先、文件提示和多表上传 smoke |
| 代码编辑和同步渲染 | 不修改 code-patch 协议 | Python/R 各一次代码更新和撤回 |
| renderer 沙箱和安全策略 | 不修改容器、路径、环境变量 | renderer security tests |
| PNG/PDF/TIFF/SVG 导出器 | 不修改格式实现 | 格式和子图导出矩阵 |
| 组合代码项目和 AI 提示词 | 不修改选择器和提示词合同 | 创建项目和复制提示词 smoke |
| 管理员与账号数据 | 不修改认证、订阅和管理接口 | auth/ownership tests |

“原则上不受影响”不等于可以省略回归。共享 `App` 状态、revision 和项目保存使部分功能仍可能受到间接影响。

### 13.5 用户可见变化

升级后允许出现的变化：

```text
同一对象在不同中心的重叠属性变得一致
以前缺失但 renderer 已稳定支持的控件出现
不支持的控件从无反应改为禁用并显示原因
批量对象值不一致时显示 mixed
部分支持时显示 N/M 和跳过报告
中心间跳转保留选择和作用范围
```

不允许出现的变化：

```text
原本可用控件无说明消失
旧项目打开后编辑能力减少
同一操作增加额外重绘次数
单对象自动变为整组
整组只修改首个对象
保存、刷新或撤销后结果变化
预设、导出记录或历史资产丢失
```

### 13.6 主要回归机制和防护

| 回归机制 | 典型表现 | 防护 |
|---|---|---|
| alias 错配 | 字号写到错误 tick/axis prop | registry 单元测试 + old/new patch key shadow diff |
| scope 扩大 | 单文本改成整组 | selected_only 默认 + resolver target count gate |
| scope 缩小 | 八个边框只改第一个 | group projection + supported target count assertion |
| patchMode 错误 | 预览正常，刷新恢复 | capability 为唯一 patchMode 来源 + save-refresh test |
| mixed 值取首项 | 用户未操作就覆盖其它值 | 显式 mixed sentinel，禁止 first-value fallback |
| 容器与 child 重复 | 图例/误差棒样式异常 | owner relation 去重 + container precedence |
| feature flag 耦合 | 一个中心回滚导致其它中心失效 | 每中心独立 flag，resolver 与 UI flag 解耦 |
| 预设 schema 漂移 | 用户预设消失 | versioned reader + 非破坏迁移 |
| history 粒度变化 | 撤销次数和导出锚点错位 | apply transaction 边界快照测试 |
| 计算开销增加 | 侧栏切换卡顿 | 纯投影、按 manifest revision 缓存、性能基线 |

### 13.7 数据和协议兼容策略

本次升级原则上不需要数据库迁移。建议保持：

```text
ManifestPropertyCapability：只增加可选字段，不删除或重命名现有字段
ManifestObject.editable：Legacy Retire 前继续输出和读取
EditingIntent：新增可选语义，不改变旧 intent 结构
PatchEntry：保持 gid/prop/value/mode/type/target_id 合同
DraftPatch：保持现有持久字段，descriptor metadata 不作为执行必需项
EditEntry：保持 renderer 可重放的真实 prop
项目数据：不批量重写旧 manifest/editLog/history
```

旧项目处理顺序：

```text
有 identity + propertyCapabilities -> 严格投影
只有 editable/currentProps -> 兼容 adapter
能力信息矛盾 -> 保留旧行为并记录 shadow 诊断
明确 unsupported -> 不开放控件
```

禁止为了统一属性名称批量改写用户已有 `editLog`。alias 应在读取/编译边界转换，历史数据保持原样可重放。

### 13.8 性能影响

潜在收益：

- 删除五个中心重复扫描和能力白名单。
- 同一 selection/revision 的投影可复用。
- 更准确的 patchMode 和目标范围可减少无效重绘。
- descriptor 校验可在请求前拦截无效操作。

潜在成本：

- 每次选择变化需要计算多对象能力交集。
- 大型 manifest 的全中心预计算可能阻塞侧栏。
- mixed/partial 统计会增加对象遍历。

性能合同：

```text
只计算当前打开中心
以 figureId + revision + selection + center 作为投影缓存边界
中心切换不重新解析 renderer manifest
禁止在每个控件中各自扫描全部 objects
1000+ 图元 fixture 记录投影耗时和交互延迟
```

### 13.9 分阶段影响控制

| 阶段 | 用户行为变化 | 允许影响 | 放行条件 |
|---|---:|---|---|
| Baseline | 无 | 只增加测试和清单 | 当前行为快照稳定 |
| Shadow | 无 | 只产出非敏感差异诊断 | old/new target 和 prop 差异可分类 |
| Scoped Enable | 单中心变化 | 只影响该中心控件生成 | 该中心自动和人工回归通过 |
| Default Enable | 对目标中心默认生效 | 旧路径仍可 flag 回滚 | 真实项目矩阵无阻断回归 |
| Legacy Retire | 删除旧重复逻辑 | 不再支持旧内部实现 | 至少一个稳定发布周期无回滚 |

### 13.10 升级前后验收清单

升级前记录：

```text
账号下项目数、Figure 数和导出资产数
目标项目每个 Figure 的 revision/editLog/history 长度
五个中心的控件和目标数量
字体/风格/配色预设数量
典型项目 SVG、manifest 和能力快照
单次应用的渲染 Figure 数与历史步数
```

升级后必须证明：

```text
项目、Figure、数据文件、导出资产数量不变
旧项目和旧预设可读取
未执行编辑时 editLog/revision 不变化
相同旧操作生成等价 patch target/prop/mode
保存刷新、撤销重做、导出锚点保持一致
Python/R 各自 capability 无降级
拖拽、跨图、布局和代码同步主链路通过
```

### 13.11 联动升级机会

统一属性层稳定后，可以安全支撑以下后续能力，但这些不是本轮默认交付：

- 全局属性搜索：从任一中心检索当前对象可用属性。
- 收藏常用属性：用户建立自己的精简编辑面板。
- 可迁移预设：字体、轴线、图例和布局预设使用同一 descriptor id。
- 批量操作预览：应用前显示将修改哪些 Figure、对象和属性。
- 更精确帮助：根据 readonly/unsupported 原因给出替代操作。
- AI 辅助编辑：未来只能生成 EditingIntent，不直接绕过能力层写 patch。
- 插件式 renderer：新语言只需声明对象 identity 和 property capability，再接入统一前端投影。

这些联动说明本次升级不仅是补齐按钮，而是在不替换现有执行链的前提下，为后续能力建立稳定扩展边界。

### 13.12 独立升级环境与无感切换

本次升级可以在另一个端口和独立代码工作区进行，让当前稳定服务继续用于实际画图。现有代码已经具备必要基础：

```text
server.ts 支持通过 PORT 指定服务端口
SCIFIGURE_DATA_DIR 可指定完整数据根目录
SCIFIGURE_DB_PATH 可指定独立 SQLite 数据库
测试运行器已经能自动选择空闲端口并创建临时 data 目录
编辑中心已有独立 feature flag 迁移经验
```

但“另一个端口”只隔离网络入口，不能单独构成安全升级环境。完整隔离必须包含：

| 隔离层 | 稳定环境 | 升级环境 | 原因 |
|---|---|---|---|
| 代码 | 当前稳定提交/分支 | 独立 Git worktree 和升级分支 | 避免开发文件热更新影响正在使用的服务 |
| 端口 | 例如 `3000` | 例如 `3100` | 浏览器入口、Cookie 和 localStorage origin 分离 |
| 数据根目录 | 当前真实 `data/` | `tmp/staging-data/` 或专用测试目录 | 禁止测试写入真实项目、文件和导出资产 |
| 数据库 | 当前真实 SQLite | 独立 `scifigure-staging.db` | 禁止两个版本并发写同一数据库 |
| 项目文件 | 真实 projects/files/exports | 固定 fixture 或可恢复快照副本 | 测试保存、导出和删除不触碰真实资产 |
| 服务内存 | 稳定 session/cache/request map | 升级服务自己的进程内状态 | 防止 requestId、render cache 和 session 相互影响 |
| renderer 资源 | 稳定任务优先 | 限制更低并发的测试任务 | 避免升级测试抢占当前画图 CPU/内存 |

#### 本地并行开发拓扑

推荐结构：

```text
稳定版：
当前稳定 worktree
http://localhost:3000
SCIFIGURE_DATA_DIR=真实 data

升级版（当前本机 `3100-3102` 已被其它服务占用，因此实际使用 `3200`）：
独立 upgrade worktree
http://localhost:3200
SCIFIGURE_DATA_DIR=独立 staging data
SCIFIGURE_DB_PATH=独立 staging database
VITE_SCIFIGURE_*_V2=按中心开启
```

示意启动方式：

```powershell
$env:PORT='3200'
$env:SCIFIGURE_DATA_DIR='E:\ai绘图修改编辑\tmp\unified-editing-staging\data'
$env:SCIFIGURE_DB_PATH='E:\ai绘图修改编辑\tmp\unified-editing-staging\data\scifigure.db'
$env:VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1='1'
npm run dev
```

实际实施时由启动脚本统一设置环境变量，避免人工漏配。启动前必须检查升级环境解析后的数据路径不等于真实 `data/`。

#### 测试数据策略

升级环境按风险从低到高使用三类数据：

1. 固定自动化 fixture：首先验证属性矩阵、目标解析和 Draft。
2. 人工构造测试项目：验证复杂 legend、colorbar、annotation、多子图和 R facet。
3. 真实项目只读快照副本：最后验证实际图形，不连接真实数据库和真实项目目录。

复制真实项目时必须使用一致性快照，不在 SQLite/WAL 正在写入时直接复制数据库文件。快照应满足：

```text
源数据保持只读
快照输出到独立目录
数据库、project_files、projects、exports 对应一致
测试账号与生产账号隔离
测试结束可整体删除 staging 目录，但不得反向同步覆盖真实 data
```

#### 本地替换流程

```text
1. 当前 3000 稳定服务继续使用
2. 在 upgrade worktree 开发并运行 3200
3. 3200 使用独立数据完成自动测试
4. 使用真实项目快照完成浏览器和人工回归
5. 生成候选提交并执行完整构建/测试/数据审计
6. 先停止向稳定版提交新的编辑和导出任务
7. 等待稳定版正在运行的 render/export 请求结束
8. 备份真实数据并记录当前稳定提交
9. 用候选版本启动新的正式进程并执行只读健康检查
10. 切换正式入口；旧进程暂时保留用于快速回滚
```

本地切换前不把 staging 数据覆盖到真实数据。升级修改的是代码和协议兼容层，真实项目继续由正式服务读取原数据库。

#### 云端蓝绿发布

未来部署后采用 Blue/Green 或小流量 Canary：

```text
Blue  = 当前生产版本
Green = 待验证升级版本
Nginx/负载均衡器 = 对外唯一入口
```

推荐流程：

```text
构建不可变 Green 镜像
在独立 staging 数据上完成迁移和健康检查
只允许管理员/测试账号进入 Green
对固定小流量或固定账号启用 Green，保持会话粘性
观察错误率、渲染耗时、保存成功率、Draft 失败率和 stale response
停止 Blue 接收新渲染任务并等待在途任务排空
将入口切换至 Green
Blue 保持运行一段观察窗口，出现阻断问题立即切回
确认稳定后再释放 Blue
```

当前 Web、API 和 Vite/静态资源由同一 Node 服务提供，发布时应按完整应用版本路由，不能把 Green 前端随机连接 Blue API，否则前端 descriptor 与后端 capability 版本可能不一致。

#### 数据库共享条件

开发和预发布环境禁止与正式服务共享可写数据库。生产蓝绿切换只有在以下条件全部满足时才允许 Blue/Green 短时间共同访问生产数据库：

```text
数据库 schema 向前和向后兼容
升级不执行破坏性迁移
旧版本能忽略新可选字段
新版本能读取旧记录
所有写接口保持相同事务合同
已有备份和恢复演练
```

本次统一编辑中心计划原则上不需要数据库迁移，应保持 `manifest/editLog/history` 兼容。如果未来必须修改数据库，应采用 expand -> dual-read/write -> backfill -> contract 的渐进迁移，不能在切流时直接改表并让旧版本失效。

#### 在途渲染任务处理

无感切换最容易遗漏的是运行中的 Python/R render 和导出任务。当前请求状态包含进程内 request map 和 per-Figure requestId，直接杀掉旧进程会让用户看到任务无响应。

发布控制必须提供：

```text
readiness：新版本是否可以接收流量
draining：旧版本停止接收新 render/export，普通读取仍可完成
active job count：当前在途渲染和导出数量
graceful timeout：等待任务结束，超时后明确失败而不是永久转圈
sticky routing：一个编辑会话在切换完成前保持同一版本
```

本地候选现已实现 readiness、draining、active job count 和 graceful timeout 的应用层基础。sticky routing、Nginx/负载均衡切流以及 Linux `SIGTERM` 实际排空仍属于云端部署验收，不使用 Windows 子进程信号模拟结果代替。

#### 无感升级验收标准

只有满足以下条件才可以替换稳定版：

```text
稳定版开发期间始终可正常使用
升级环境未写入真实 data/ 和真实数据库
候选版本通过统一编辑中心完整测试矩阵
旧项目、旧历史、旧预设和旧导出资产可读取
启动 Green 不会自动迁移或改写生产数据
切流前后同一项目的 Figure 数、revision、editLog 和导出资产一致
在途渲染已排空或有明确恢复结果
回滚只需切换入口和代码版本，不需要回滚用户数据
```

因此，本次升级推荐从一开始就在独立 worktree、独立端口和独立 staging 数据中完成。测试通过后再以蓝绿方式替换当前服务，这比在正在使用的工作目录中边开发边热更新更适合当前平台，也应成为未来云端发布的默认模式。

### 13.13 隔离实施基线（2026-07-12 17:24:57 +08:00）

第一批 Baseline/Shadow 已在独立环境开始实施：

```text
稳定分支：feature/standard-figure-model-v1
稳定服务：http://localhost:3000
升级分支：upgrade/unified-editing-centers
升级 worktree：tmp/worktrees/unified-editing
升级服务：http://localhost:3200
升级数据：升级 worktree 内 tmp/unified-editing-staging/data
```

已落地：

- 增加统一 `PropertyDescriptor` 类型和中心、属性族、控件、单位、范围、选项定义。
- 首批登记字体家族、字号、字重、字形、颜色、旋转、水平/垂直对齐、可见性、透明度和线宽。
- 增加 tick label alias，并明确排除 `tick_color` 作为文字颜色，避免刻度线与刻度文字串改。
- 增加按属性编辑、布局、组件、配色和字体中心过滤的纯投影函数。
- 优先消费 renderer `propertyCapabilities`，旧 manifest 才回退 `editable/currentProps`。
- 输出 editable、partial、readonly、unsupported、mixed、conditional 和 legacy fallback 元数据。
- `RightSidebar` 在 staging flag 下记录无值 Shadow 诊断，不产生 patch、不改变控件、不触发额外渲染。
- staging 启动器固定独立端口、数据库、项目目录和单并发 renderer，并拒绝真实 `data/` 或已占用端口。
- staging 默认运行 production-like 构建，不启动 Vite HMR，接近未来 Green 候选版本。
- staging 构建使用版本化不可变目录；新包完成后更新 build pointer，运行中的旧候选不受下一次构建影响。
- 启动器验证候选目录、buildId、显式 Shadow flag 和 `index.html` 后才允许切换。

验证证据：

```text
属性投影和诊断：14 个针对性 Vitest 通过
全量前端单元测试：20 files / 144 tests 通过
TypeScript：通过
生产构建：通过
语义中心浏览器回归：9 PASS / 0 FAIL
真实数据路径阻断：通过
占用端口阻断：通过
3200 健康检查：HTTP 200
3000 并行健康检查：HTTP 200
staging 数据审计：0 users / 0 projects / 0 assets / 0 issues
独立代码审查：阻断项修复后复审通过，无剩余 blocking finding
```

当前尚未切换任何用户控件，也没有修改 Python/R renderer、Draft、历史、保存、导出或真实项目数据。下一步是 Phase 2 的统一控件渲染器，仍先在属性编辑中按 feature flag 单中心接入，不直接替换字体、组件、配色和布局中心。

### 13.14 Phase 2/3 属性编辑候选状态（2026-07-12 21:34:43 +08:00）

已在 `upgrade/unified-editing-centers` 的 `3200` 候选环境完成首个可见迁移：

- 新增共享 `PropertyControl`，统一渲染 font、number、select、color 和 toggle 控件。
- 普通单对象属性编辑已通过 `VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2` 接入 descriptor 投影。
- 首批接管字体家族、字号、字重、字形、颜色、旋转、水平/垂直对齐、可见性、透明度和线宽。
- descriptor 使用 renderer 解析出的真实 prop 写回；tick label alias 不会把 `tick_color` 当作文字颜色。
- patch mode 优先使用 renderer `propertyCapabilities.patchMode`，只在旧 manifest 中回退 Python/R 旧规则。
- 已接管属性从 legacy 通用循环中排除，避免重复控件和重复 patch。
- 文本内容、上下标、换行、annotation anchor、subplot、axis、grid、legend 等专用面板保持原路径。
- 所有修改继续进入现有 Draft Batch；未建立第二套 patch、历史、保存或重绘链路。
- readonly、unsupported、mixed、partial 和 conditional 状态由同一控件表达；legacy fallback 只保留为 DOM 元数据，不挤占正常标签。
- staging 构建 marker 新增 `propertyInspectorV2: true`，旧候选不满足 marker 时拒绝启动。
- staging 服务仅暴露不含路径和密钥的 runtime profile；浏览器测试在创建测试数据前校验 profile 和公开 build marker，指向 `3000` 会直接拒绝。

验证证据：

```text
全量前端单元测试：22 files / 150 tests 通过
PropertyControl + descriptor + patch mode 针对测试：3 files / 16 tests 通过
TypeScript：通过
普通生产构建：通过
3200 descriptor + inspector V2 候选构建：通过
Python introspector：36 tests 通过
属性编辑 V2 浏览器回归：6 PASS / 0 FAIL
单标题字号修改实际 patch：仅 title.0:fontsize=17、backend_patch 一条
错误目标防护：测试指向 3000 时在认证和数据操作前拒绝
浏览器 console/page error：0
staging 数据审计：0 projects / 0 assets / 0 issues
3000 与 3200 健康检查：均为 HTTP 200
独立代码审查：3 项 finding 修复后复审 PASS，无 blocking finding
```

当前 `3200` 沿用的 renderer Docker 镜像仍输出旧 manifest：对象缺少 `propertyCapabilities`，palette binding 缺少 `targetMode`。因此浏览器候选当前验证的是 legacy fallback；新 renderer 代码的 capability、同色语义绑定、单 tick 精确修改和 tick line/tick label 隔离已由 `tests.test_introspection` 验证。此差异不得被描述为前端 V2 已完成 capability 端到端验证；进入默认启用前必须重建 renderer 候选镜像并复跑同一浏览器矩阵。

下一步按独立 flag 迁移组件中心。属性编辑和字体中心 legacy 面板继续保留，待公共控件逐项通过真实项目回归后再减少重复实现。

### 13.15 Phase 4 字体中心候选状态（2026-07-12 22:33:04 +08:00）

字体中心已在 `VITE_SCIFIGURE_FONT_CONTROLS_V2` 独立开关下迁移：

- 标题、X/Y 轴标签、X/Y 刻度文字、图例文字和其它文本分组继续沿用原语义分类与子图范围。
- 每个分组通过同一 descriptor registry 投影字体家族、字号、字重、字形、颜色、旋转、水平/垂直对齐、可见性和透明度。
- 投影新增逐对象 editable/readonly/unsupported 状态；组控件只选择真实可编辑 representative，mixed 和 partial 不再用第一个值伪装成全组值。
- 组级写回继续经过 EditingIntent 和目标解析器，不直接把 representative 当成唯一目标，避免“选中整组只改第一个”。
- descriptor 投影与 `role_in_figure` 写回统一按 `figure` capability scope 校验，避免控件显示可编辑但应用时被 resolver 跳过。
- tick rotation 统一映射为稳定虚拟轴属性 `tick_rotation`，不写入会在重绘后重建的临时 tick text。
- legacy 字体中心五项控件仍完整保留在 flag 后，可单中心回滚；字体预设和图形风格预设继续使用原 Draft 批处理。
- staging marker 新增 `fontControlsV2: true`，旧候选不能被 staging 启动器误认为 Phase 4 候选。

验证证据：

```text
相关 Vitest：3 files / 37 tests 通过
TypeScript：通过
Phase 4 staging 构建：通过
属性/字体中心联合浏览器回归：9 PASS / 0 FAIL
标题组 mixed 字号状态：通过
X 刻度旋转实际 patch：仅 axis.x.0:tick_rotation=25、backend_patch 一条
浏览器 console/page error：0
3000 与 3200 并行健康检查：HTTP 200
```

当前浏览器候选仍使用 legacy renderer image，因此 capability-backed 强制门尚未放行；`SCIFIGURE_REQUIRE_CAPABILITY_MANIFEST=1` 会在旧镜像下明确失败。重建 renderer 候选镜像后必须复跑同一用例，再决定字体中心默认启用。

### 13.16 Phase 4 热修复同步与不可变候选（2026-07-12 23:27:32 +08:00）

- 稳定分支数据驱动颜色 fallback、向量 collection `code_only` 配色隔离和 legacy ambiguity 保留已同步到升级分支。
- 代码同步不再删除 `global` 等虚拟可重放 GID；导出会从最后成功 preview manifest 恢复画布宽高，避免横向预览导出为脚本原始竖向尺寸。
- 当前不可变候选 build：`phase4-font-palette-export-20260712-2325`，Git revision `077eb81`。
- 3200 provenance、属性/字体联合浏览器回归：9 PASS / 0 FAIL；console/page error 为 0。
- 升级分支 Vitest：25 files / 163 tests；TypeScript 通过。
- 稳定隔离语义回归：11 PASS / 0 FAIL；导出矩阵包含 `8 × 4 in -> 576 × 288` 方向一致性用例并通过。

当前限制不变：3200 renderer image 仍是 legacy capability manifest，因此以上结果不能替代 capability-backed 强制门验证。

### 13.17 Phase 5 组件中心候选状态（2026-07-12 23:56:37 +08:00）

组件中心已在独立 `VITE_SCIFIGURE_COMPONENT_CONTROLS_V2` 开关下接入统一 descriptor：

- `componentGroups` 继续只负责对象分类、子图范围、选中整组和容器优先，不再决定公共属性的可编辑能力。
- 字体家族、字号、字重、字形、颜色、旋转、可见性、透明度和线宽统一通过 capability descriptor 投影，显示 mixed、partial、readonly 和 unsupported 状态。
- V2 写回按每个对象的真实 prop alias 和 editable 状态分桶，再作为一次 Draft batch 提交；代表对象只负责控件显示，不会成为唯一写回目标。
- `facecolor/edgecolor`、误差棒、茎叶图、箱线图、图例符号布局、subplot/colorbar 几何和轴刻度专用参数继续保留 legacy 专用控件。
- container `children` 与 child 自身 `parentId/identity.relation.parentId` 同时参与 owned child 排除，避免容器内部图元重新混入 line/point/patch 分组。
- Python renderer 为 `spine_group.*` 补齐 `role=axis_frame`，其 `linewidth` capability 正确声明 `group` scope；前端不再用 kind 白名单掩盖协议缺口。
- staging marker 增加 `componentControlsV2: true`，旧候选不能被误认为 Phase 5 build；关闭该开关可回退 descriptor UI，目标解析和容器分组仍由既有 `VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2` 独立控制。

验证证据：

```text
全量前端单元测试：25 files / 166 tests 通过
Python introspector：39 tests 通过
TypeScript：通过
Phase 5 production-like staging 构建：通过
组件容器浏览器回归：17 PASS / 0 FAIL
Python 五中心语义回归：12 PASS / 0 FAIL
R 五中心语义回归：5 PASS / 0 FAIL
line 整组线宽：4 个目标全部生成 backend patch
descriptor-only 文本旋转：28 个目标全部生成 backend patch
多子图边框整组线宽：6 个 spine_group 全部生成 backend patch
bar/errorbar/stem/boxplot/violin/annotation/legend 专用控件：全部通过
浏览器 console/page error：0
3000 与 3200：均为 HTTP 200，3000 PID 未变化
3200 build：phase5-component-controls-20260712-2352
```

Phase 5 不包含 `facecolor/edgecolor` 等专用 descriptor 扩展，也不改变配色 binding。下一步进入 Phase 6 时必须继续保留严格歧义阻止、向量 collection `code_only` 和同色不同组隔离。

### 13.18 Phase 6 配色中心候选状态（2026-07-13 01:04:32 +08:00）

配色中心已在独立 `VITE_SCIFIGURE_PALETTE_CONTROLS_V2` 开关下接入统一颜色 descriptor：

- palette binding、series/layer/scale 身份、selected subset、预设批量和 Python/R patch 分流继续由原配色协议负责；descriptor 不重新猜目标。
- `resolvedPropByKey` 允许 palette resolver 把每个 target 的真实 `color/facecolor/edgecolor` 注入 descriptor，默认属性别名不因此扩大。
- 新的 palette 投影适配器统一输出 editable、mixed、partial、readonly、unsupported 和 dirty 状态；向量 `code_only` 使用语义 palette 颜色，不读取整个多色数组作为单一颜色。
- Python 全局颜色仍生成一次 `code_patch + backend object patches`；R 仍只生成 backend object patches；selected subset 仍只生成对象 patch。
- `ambiguous/unresolved` 不回退同色猜测；候选 UI 要求完整 binding target、identity 和 property capability，协议缺失时阻止对象 patch。关闭 palette controls flag 后仍可回到原 legacy UI/resolver 兼容路径。
- `code_only` target 不进入可选对象和 subset 控件，不会把同一个 vector collection 整体染成单色。
- 保存链路不再吞掉 `code_patch/backend_patch` 草稿：手动保存会明确提示先应用，自动保存静默跳过；只有无失败重试的 local patch 可直接持久化。
- staging marker 新增 `paletteResolverV2/paletteControlsV2`，Phase 6 build 会显式开启严格 resolver 和新控件。

验证证据：

```text
全量前端单元测试：26 files / 177 tests 通过
palette/descriptor/draft 定向测试：5 files / 46 tests 通过
Python + R renderer：68 tests 通过
TypeScript 与 production-like build：通过
Python 五中心语义回归：14 PASS / 0 FAIL
R 五中心语义回归：6 PASS / 0 FAIL
同色 Weak/Mixed：目标、patch、runtime 颜色保持隔离
selected subset：仅 1 条对象 patch，不生成 code patch
vector collection：仅 1 条 code patch，不生成 facecolor object patch
保存 engine draft：不发送 PUT、草稿保留并显示先应用提示
浏览器 console/page error：0
独立代码审查：2 轮通过，0 个代码级阻断问题
```

部署门禁：本机 Docker Desktop/BuildKit 在两次构建中均未完成握手，新的 renderer image 尚未生成。3200 当前使用隔离 staging 数据和本地 renderer 验证当前 capability 协议，不能视为生产沙箱验证；3000 保持原 Docker renderer 不变。部署或默认启用前仍必须重建独立 renderer image，并在 Docker 禁网/只读/资源限制模式下复跑同一 Python/R 矩阵。

### 13.19 Phase 7 布局中心候选状态（2026-07-13 02:14:35 +08:00）

布局中心已在独立 `VITE_SCIFIGURE_LAYOUT_CONTROLS_V2` 开关下接入布局 descriptor 和坐标空间协议：

- 新增 `layout_geometry` 与 `position` family；layout center 只包含 `left/bottom/width/height/aspect/position`，不混入文字 `rotation/ha/va`。
- `left/bottom/width/height` 使用 Figure 归一化坐标，`aspect` 使用 container 布局语义；position 从 property capability、当前位置值或 object identity 解析 `axes/figure/data`。
- Python subplot 与 Python/R colorbar 按 renderer capability 开放几何控件；axes 不伪装为布局对象；R facet 独立 bounds 明确显示 unsupported，只保留 figure-scope 的统一 aspect。
- 布局中心 V2 新增当前布局对象选择和统一控件；批量网格、交换、宽度对齐、统一物理尺寸、色条对齐在提交前逐对象检查 prop、scope 与 coordinateSpace。
- 未知或原生坐标系不再默认解释为 axes；`native` 等显式未知值投影为 `none`，阻止错误拖拽。
- 拖拽仍累计多个 position patch，并保留确认/取消状态机；可拖拽性由 position descriptor 判断，最终 patch 通过严格 Target Resolver 编译。
- staging build/run marker 新增 `layoutControlsV2`，可独立关闭布局 V2 并回退 legacy UI。

验证证据：

```text
全量前端单元测试：26 files / 185 tests 通过
layout/target resolver/PropertyControl 定向测试：3 files / 50 tests 通过
Python + R renderer：68 tests 通过
TypeScript、production-like build、staging dry-run 与 diff check：通过
Python 多子图/共享色条浏览器回归：18 PASS / 0 FAIL
R facet 五中心浏览器回归：7 PASS / 0 FAIL
扩展拖拽回归：9 PASS / 0 FAIL
独立代码审查：PASS，0 个 blocking finding
浏览器 console/page error：0
3000 稳定服务 PID 196020 保持不变
```

保留限制：R facet 的独立 left/bottom/width/height 与 R legend position 仍不具备可靠 renderer 映射，V2 会显示 unsupported/readonly 而不是伪装可编辑。Docker renderer 新镜像仍未重建，默认启用和生产切换继续受 Phase 6 部署门禁约束。

### 13.20 Phase 8a 默认启用候选状态（2026-07-13 12:11:40 +08:00）

Phase 8 拆为可独立验收的两个子阶段。本轮完成 Phase 8a，不把尚未满足发布周期条件的 Legacy Retire 伪装为已完成：

- 属性、字体、组件、配色、布局五中心改为默认启用；只有显式设置对应开关为 `0` 才回滚。
- 字体、组件、配色 strict resolver 默认启用。缺少稳定 identity 或 property capability 时不再静默生成 legacy patch，而是返回空 patch、`unsupported_engine` 和可见原因。
- descriptor 投影新增 `allowLegacyFallback` 策略。strict 中心遇到旧 manifest 时显示 readonly，避免“控件可点但应用无效”；显式协议回滚时仍可使用旧 `editable/currentProps`。
- 拖拽 position 不再硬编码 strict。布局 V2 开启时只允许 capability-backed 目标；显式关闭布局 V2 时恢复 legacy position 投影和 patch 编译。
- UI 回滚与 resolver 回滚保持两层语义：`*_CONTROLS_V2=0` 只回退公共控件，继续保留容器识别；`*_TARGET_RESOLVER_V2=0` 是旧 manifest 应急协议回滚，不承诺保留升级后新增的容器语义分组。
- 隔离 smoke 为每次运行分配独立 HTTP 与 Vite HMR 端口，避免连接稳定 3000 的 HMR 端口并产生假 console/page error。

验证证据：

```text
全量 Vitest：26 files / 188 tests 通过
TypeScript：通过
Python introspection + R renderer + 双语言 capability matrix：70 tests 通过
属性编辑 production-like staging：9 PASS / 0 FAIL
Python 语义中心默认路径：14 PASS / 0 FAIL
Python 组件/布局默认路径：18 PASS / 0 FAIL
R 语义中心默认路径：7 PASS / 0 FAIL
扩展拖拽：9 PASS / 0 FAIL，console/page error 为 0
五中心 UI 显式回滚：语义中心 14 PASS；组件/布局 18 PASS
staging build、marker、隔离路径 dry-run 与 git diff check：通过
Docker renderer：scifigure-renderer:phase8a 构建通过
Docker sandbox：Python/R 正常渲染、R 导出、禁网、敏感路径隔离、超时强杀、容器清理通过
Docker capability gate：Python/R 均返回 identity/capability-backed manifest
3000 稳定服务 PID 196020 保持不变；测试未访问真实 data/ 或数据库
```

本机 Docker renderer 代码与沙箱门禁已经通过，但云服务器禁网、只读文件系统、资源限制和真实并发仍需部署后复测，不能用本机证据替代云端放行。

Phase 8b 的删除动作暂不执行：旧控件仍承担 errorbar、stem、legend、colorbar 等专用能力，旧 manifest 仍需要显式回滚入口。只有经过至少一个稳定发布观察期、专用能力完成 descriptor 覆盖且云端 renderer 复测通过后，才能删除无调用 legacy 分支。

### 13.21 Phase 8b 匿名观察候选状态（2026-07-13 15:43:12 +08:00）

本轮只建设退役决策所需的观察证据，不删除 legacy：

- 新增五类固定枚举事件：descriptor 投影、resolver 路径、palette resolver、旧 UI surface、position drag。
- 前端与服务端使用同一 sanitizer 双重白名单；只保留引擎、中心、作用域、规范属性、对象 kind、策略和聚合计数。
- 禁止采集用户、项目、Figure、session、对象 ID、patch key、palette ID、label、文本、颜色值、属性值、脚本、SVG、数据、IP 和 User-Agent。
- 端点只在统一编辑 staging 或显式环境变量下开放，继续要求认证，并限制为 64 KB / 100 events。
- JSONL 只按 build/date 追加到 `tmp/unified-editing-staging/legacy-retire-observation/`；不写 `data/`、SQLite、admin audit 或 Git tracked 文件。
- staging marker 新增 `legacyRetireObservationV1` 和 `rendererImage`。启动器必须使用 marker 绑定的 renderer，禁止再从稳定 `.env` 静默继承旧镜像。
- 拖拽只在松手被协议阻止或用户确认累计位置时记录，不在 pointer move 高频路径上报。
- errorbar 专用控件与总体 specialized controls 分开计数，避免用粗粒度数据误判可删除路径。

本轮同时修复候选验证暴露的 R 协议问题：R list `$subplotId` 会部分匹配 `subplotIds`，facet layer 在 R 4.5 中因此把长度 2 的多面板关系当作单值并中止。renderer 现改为精确字段读取，`subplotIds/layerIds/groupIds/mappableIds` 继续完整保留；新镜像为 `scifigure-renderer:phase8b`。

验证证据：

```text
全量 Vitest：28 files / 194 tests 通过
TypeScript：通过
Python introspection + R renderer + 双语言 capability matrix：70 tests 通过
属性编辑 production-like staging：9 PASS / 0 FAIL
Python 语义中心默认路径：14 PASS / 0 FAIL
Python 组件/布局默认路径：18 PASS / 0 FAIL
R 语义中心默认路径：7 PASS / 0 FAIL
扩展拖拽：9 PASS / 0 FAIL
UI 显式回滚：语义中心 14 PASS；组件/布局 18 PASS
观察 API：关闭 404、认证、64 KB、100 events、路径净化和敏感字段剔除通过
默认候选 JSONL：68 条，五类事件均出现；敏感字段扫描为 0
显式回滚 JSONL：legacy resolver、palette resolver 和各 rollback surface 均出现
Docker renderer phase8b：构建和 sandbox smoke 通过
仓库 data boundary、R 风险预检、staging dry-run、git diff check：通过
独立安全审查：通过，0 个 blocking finding
3000 稳定服务 PID 196020 未改变；3200 使用隔离 staging 数据
```

观察链路完成不等于 Legacy Retire 完成。下一步必须在稳定发布候选上积累观察周期，并按 `UNIFIED_EDITING_LEGACY_RETIRE_REGISTER.md` 逐路径给出保留、迁移或删除结论；本轮不得删除 B/C 类能力。

### 13.22 本地发布控制基线（2026-07-13 16:12:27 +08:00）

为满足 13.12 的无感切换不变量，候选服务新增独立的进程级发布生命周期，不改变 Draft、历史、保存、renderer patch 或用户数据结构：

- `GET /api/health/live` 只报告进程存活；`GET /api/health/ready` 在 accepting 时返回 200，在 draining 时返回 503。健康检查不消耗普通 API 限流额度。
- `GET /api/admin/deployment-state` 仅数据库 `admin` 可读取，返回 render/export/archive/composition 在途数，以及 renderer active/queued/concurrency。
- `POST /api/admin/deployment-state` 仅允许 `accepting/draining` 与固定 reason 枚举；成功和失败都沿用管理员鉴权，状态变更写入 `deployment.mode.change` 审计。
- draining 只阻止新的 render、patch、code-patch、项目重绘、导出、压缩和组合任务；已经取得 lease 的任务继续完成，普通读取不受影响。
- 请求 lease 由实际 route Promise 持有，不因客户端断线提前释放；断线会取消尚未启动的排队任务，并向 Python/R/Docker worker 传播终止信号。ZIP 流会等待 finish 或显式 abort，组合任务不再使用脱离 handler 的异步 IIFE。
- `SIGTERM/SIGINT` 会先进入 draining，等待请求 lease、renderer active/queued/worker 全部归零；超过 `SCIFIGURE_GRACEFUL_SHUTDOWN_MS` 才取消本实例队列和 worker、关闭连接并以失败状态退出。
- 所有状态仅存于当前进程，重启后默认 accepting；不写 SQLite、项目目录、真实 `data/` 或用户历史。

验证证据：

```text
全量 Vitest：29 files / 201 tests 通过
DeploymentLifecycle + AbortableWorkQueue 单元测试：7 PASS
TypeScript：通过（Node 8 GB heap；默认 4 GB 检查进程会 OOM）
发布控制 API smoke：PASS
管理员授权既有 smoke：PASS
已有慢渲染在 draining 中完成：通过
draining 后新渲染 503 + INSTANCE_DRAINING：通过
resume 后 readiness 恢复 200：通过
状态变更管理员审计：通过
客户端断线：renderer 停止后才释放请求 lease，通过
ZIP 流与 composition：正常完成、draining 503、无 lease 泄漏，通过
既有 composer consistency smoke：通过；同时修复其认证升级后的旧匿名测试前提
独立代码复审：APPROVE，0 blocking/high/medium
测试数据库和项目目录：仅系统临时目录，结束后清理
```

本地尚不能证明 Linux 信号排空、Nginx sticky routing、真实云端并发和负载均衡摘除顺序；这些继续作为部署后门槛，不把应用层基础写成完整蓝绿发布已完成。

## 14. 实施阶段

### Phase 0：Baseline 清单和回归锁定

- 导出五个中心当前对象、属性、控件、默认范围和 patch 模式清单。
- 为 Python/R 固定 fixture 记录 UI 可见属性快照。
- 锁定单对象、整组、子图、Figure、跨 Figure 的目标数量。
- 锁定 Draft、撤销、保存刷新和按 Figure 重绘行为。

本阶段不改变功能。

### Phase 1：Canonical Property Registry

新增纯前端 descriptor registry 和 alias registry，不接管现有 UI。

Shadow 诊断：

```text
renderer 声明但无 descriptor
descriptor 存在但 renderer 不支持
同一属性在多个中心控件配置不同
alias 无法解析
旧路径和新路径 patch key 不一致
```

### Phase 2：统一控件渲染器

先替代重复度最高、风险较低的：

```text
fontfamily、fontsize、fontweight、fontstyle、color
rotation、visible、alpha、linewidth
```

旧控件保留 feature flag 回滚。

### Phase 3：属性编辑接入

属性编辑先接 descriptor，但继续按选中对象的 `propertyCapabilities` 展示完整能力。subplot、axis、legend、annotation 专用面板不一次删除，其内部公共控件逐项替换。

### Phase 4：字体中心接入

- 统一字体五项。
- 按 capability 增加 rotation、alignment、visibility/opacity。
- 单对象和角色组严格分离。
- tick alias 只在 registry 中维护一次。
- 显示 mixed、partial、unsupported 状态。

### Phase 5：组件中心接入

- 移除已被 capability 覆盖的 kind 白名单。
- 组件分组只决定对象类别，不决定属性支持。
- 容器优先和 owned children 排除继续保留。
- 文本公共属性复用字体 descriptor。

### Phase 6：配色中心接入

- 保留 palette binding 和严格歧义阻止。
- 颜色控件、Draft、mixed state 使用统一 descriptor。
- series/layer/scale 负责目标，descriptor 负责编辑语义。

### Phase 7：布局中心隔离

- 几何属性使用独立 layout descriptor family。
- 明确 Figure、subplot、axes、colorbar 和 legend container 坐标系。
- 禁止普通文字 rotation/alignment 混入布局中心。
- 拖拽继续走位置确认流程，但复用 position descriptor 和 resolver。

### Phase 8：默认启用与 Legacy Retire

Phase 8a：每个中心独立通过放行证据后逐个默认启用，不用一个总开关同时切换五个中心。默认 strict 不允许缺 identity/capability 的目标静默回退；显式 `=0` 保留可审计回滚路径。

Phase 8b：经过稳定发布观察期后，删除已经由 descriptor 完整覆盖且确认无调用的重复 label/range/options、tick alias、kind 白名单、mixed value 逻辑和 legacy 控件。仍承担专用能力或旧项目兼容的代码不得提前删除。

## 15. Feature Flag 与回滚单位

```text
VITE_SCIFIGURE_PROPERTY_DESCRIPTOR_V1
VITE_SCIFIGURE_PROPERTY_INSPECTOR_V2
VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2
VITE_SCIFIGURE_FONT_CONTROLS_V2
VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2
VITE_SCIFIGURE_COMPONENT_CONTROLS_V2
VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2
VITE_SCIFIGURE_PALETTE_CONTROLS_V2
VITE_SCIFIGURE_LAYOUT_CONTROLS_V2
```

每个中心可单独回滚。`*_CONTROLS_V2=0` 回退 UI 公共控件但保留语义分组；`*_TARGET_RESOLVER_V2=0` 回退旧 manifest 编译协议。Draft、render scheduler 和持久化不与 UI 开关绑定。生产默认启用后，回滚必须记录所关闭的具体开关和原因。

## 16. 测试矩阵

### 单元测试

- descriptor 类型、范围、单位、options 和 alias。
- capability 与 descriptor 合并。
- mixed/partial/readonly/unsupported 状态。
- tick、legend、colorbar、collection 属性别名。
- container/children 去重。
- Python/R 不同 capability 的投影结果。

### 目标解析测试

- 单个文本只改自己。
- 单个 tick 内容不扩散到整组。
- 整组 tick 样式命中全部目标。
- 八个子图边框整组不只改左上角。
- legend container 与 legend text/marker 不混淆。
- palette 同色不同组不互相影响。
- ambiguous identity 不生成 patch。

### 事务测试

- 多中心修改合并为一个 Draft batch。
- 同一属性后写覆盖前写。
- 应用一次只生成一个历史步骤。
- 撤销/重做恢复全部属性。
- 部分失败保留失败草稿。
- 只重绘受影响 Figure。
- 保存刷新后结果不丢失。

### 浏览器测试

- 同一对象从三个中心看到的重叠属性一致。
- 切换中心后选择和 mixed state 保留。
- readonly/unsupported 不生成请求。
- 侧栏窄宽和滚动状态下控件不截断。
- Python/R fixture 分别验证。

### 真实项目人工回归

```text
单图单 axes、多 Figure
2x2、2x4、4x2 多子图
共享/独立 legend、heatmap + colorbar
twin/shared axes、annotation + arrow
line/scatter/bar/errorbar/boxplot/stem
R facet/discrete scale/continuous scale
```

## 17. 验收标准

### 一致性

1. 同一属性在所有中心只有一个 descriptor。
2. 同一对象的重叠属性在不同中心使用相同控件参数。
3. 同一操作从不同中心生成相同目标和规范 prop。
4. 所有控件可解释 editable/partial/readonly/unsupported。

### 精确性

1. 单对象误扩散为 0。
2. 组编辑漏项为 0。
3. 歧义目标默认不写回。
4. tick label、tick line、axis label、spine 互不串改。
5. 图例容器、文字和符号互不拆散。

### 持久化

1. 应用、保存、刷新后结果一致。
2. 撤销/重做完整。
3. 导出锚点仍定位正确历史 revision。
4. 项目归属、Figure 数量和历史记录不变化。

### 双语言

1. Python/R 使用同一前端 descriptor。
2. renderer 可声明不同 capability。
3. unsupported 不伪装为 editable。
4. R 的组级限制和条件重放有明确提示。

## 18. Stop Conditions

出现以下任一情况立即停止默认启用并回滚当前中心：

```text
单对象修改扩散到其它对象
整组修改只命中第一个对象
切换中心丢失选择或 Draft
预览变化但重绘后恢复
保存刷新后编辑丢失
撤销历史被清空或步骤拆散
跨 Figure 映射到错误 subplot/series
Figure 数量、项目归属或导出资产发生变化
Python 原能力因 R 对齐而退化
R 不支持属性被前端伪装为可编辑
坐标或布局出现比例漂移
真实 data/、数据库或用户项目被测试改写
```

## 19. 明确不做

- 不把 Python/R renderer 合并为一套内省器。
- 不新建 AI 自动改图链路。
- 不一次性重写 `RightSidebar.tsx`。
- 不强制所有中心展示相同的全部属性。
- 不用前端 SVG 临时修改代替 renderer 持久化。
- 不隐藏 unsupported 原因。
- 不在没有 fixture 时默认开放第三方 R grob 或 Matplotlib artist。

## 20. 建议第一批执行内容

第一批只做低风险基础，不改变用户行为：

1. 建立 `PropertyDescriptor` 和属性别名清单。
2. 为五个中心生成 shadow capability matrix。
3. 把字体五项、rotation、ha、va、visible、alpha、linewidth 纳入控件快照测试。
4. 比较同一操作在旧中心与新投影中的 target/prop/patchMode。
5. 用真实 Python/R fixture 校准差异。

完成证据后，推荐先迁移属性编辑中的通用控件，再扩展字体中心。组件中心和布局中心对象关系更复杂，不作为第一批默认切换对象。

## 21. 代码证据索引

| 事实 | 文件 |
|---|---|
| 五个中心和当前控件 | `src/components/RightSidebar.tsx` |
| Manifest 对象与属性能力 | `src/schemas/manifest.ts` |
| EditingIntent | `src/schemas/editingIntent.ts` |
| StandardFigureModel | `src/schemas/standardFigureModel.ts`、`src/utils/standardFigureModel.ts` |
| 严格目标解析 | `src/utils/targetResolver.ts` |
| 旧意图编译器 | `src/utils/editingIntentCompiler.ts` |
| 跨 Figure 映射 | `src/utils/semanticPatchMapping.ts` |
| 配色精确目标 | `src/utils/paletteTargetResolver.ts` |
| Python 属性能力与 patch | `renderer/introspector.py` |
| R 属性能力与 patch | `renderer/r_renderer.R` |
| Draft 事务 | `src/schemas/draftPatchBatch.ts`、`src/utils/draftTransaction.ts` |
| 渲染调度 | `src/schemas/renderScheduler.ts` |

## 22. 最终结论

当前几个中心不是能力不足，而是能力来源分散、交叉属性重复实现、展示精细度不统一。

合理升级方向不是合并五个中心，也不是给每个中心复制全部控件，而是：

```text
renderer 提供真实对象能力
PropertyDescriptor 统一属性定义
Target Resolver 统一目标和作用域
各中心只负责不同组织视角
Draft/History/Render/Save 保持一条执行链
```

这样后续增加旋转、对齐、下划线、行距、marker 边框、图例间距等能力时，只需增加一次规范属性定义和对应 renderer 能力，不再逐个中心重复补丁。
