# SciFigure 语义编辑意图层升级计划

## 1. 目标边界

本文档定义 SciFigure 当前“语义编辑意图层”的现状、升级目标、阶段任务与验收标准。该层的目标不是 AI 自动改图，也不是替代 Python/R 渲染器，而是在前端编辑行为与底层 `PatchEntry` 之间增加一层稳定、安全、可诊断的语义路由。

核心目标：

- 用户说“改 y 轴标题颜色”，系统只改 y 轴标题，不误改 y 轴刻度。
- 用户说“改单个 tick 文本”，系统只改这个 tick，不扩展到同组全部 tick。
- 用户说“把 X tick 字号应用到全部 Figure”，系统按目标图自己的语义对象匹配，而不是复制源图 raw gid。
- 用户拖动文字或图例时，位置修改只作用于当前 Figure，不跨图套用。
- Python/R 两条渲染路径共用前端语义协议，但仍允许各自后端用自己的安全 patch 实现。

非目标：

- 不做 AI 改图助手。
- 不让前端猜任意 SVG 节点语义。
- 不把所有编辑强行映射成代码级 AST 改写。
- 不为了“看似能改”而放开不可稳定回放的图元。

## 2. 当前实现状态

当前已落地第一版中间层：

| 模块 | 文件 | 当前状态 |
|---|---|---|
| 意图协议 | `src/schemas/editingIntent.ts` | 已定义 `EditingIntent`、`scope`、`operation`、`fallback`、`diagnostics` |
| 意图编译器 | `src/utils/editingIntentCompiler.ts` | 已支持按 role/kind/object/subplot 选择目标并编译为 `PatchEntry[]` |
| 侧边栏接入 | `src/components/RightSidebar.tsx` | 字体中心、组件中心、配色中心部分入口已带 `intent` |
| 拖拽接入 | `src/components/ChartPreview.tsx` | 文本/图例位置 patch 已带 `layout.position.*` intent，并禁止跨图 |
| 应用调度 | `src/App.tsx` | draft 保留 intent；跨 Figure 应用时先 `retargetEditingIntentForFigure()`；发后端前剥离 metadata |
| 单元测试 | `src/utils/editingIntentCompiler.test.ts` | 已覆盖 axis label/tick 隔离、tick group 映射、R unsupported skip、跨图 retarget、拖拽禁止跨图 |

已验证命令：

```bash
npm test -- --run src\utils\editingIntentCompiler.test.ts src\utils\subplotPhysicalLayout.test.ts
npx tsc --noEmit
npm run build
```

## 3. 当前协议说明

### 3.1 Intent 结构

典型结构：

```ts
{
  intent: 'style.text.axis_label',
  scope: {
    selectionMode: 'role_in_subplot',
    targetRole: 'y_axis_label',
    subplotIds: ['subplot.0'],
    crossFigure: 'allow'
  },
  operation: {
    prop: 'color',
    value: '#cc0000'
  },
  commit: {
    mode: 'draft',
    applyAsOneHistoryStep: true
  },
  fallback: {
    onUnsupported: 'skip_with_warning'
  }
}
```

### 3.2 当前支持的 intent

| Intent | 用途 | 当前覆盖 |
|---|---|---|
| `content.text` | 修改单个文本内容 | 单文本、tick 文本、普通文本 |
| `style.text.axis_label` | 修改坐标轴标签样式 | xlabel/ylabel |
| `style.text.tick_label` | 修改刻度文字样式 | xtick/ytick，组编辑映射到 `axis.x/y.*` |
| `style.text.legend` | 修改图例文字样式 | 图例文本基础路径 |
| `style.text.title` | 修改标题样式 | title/suptitle |
| `style.component` | 修改组件样式 | line/patch/collection/container 基础路径 |
| `layout.subplot.axes_box` | 修改子图绘图区位置和尺寸 | subplot bounds，R 不支持时跳过 |
| `layout.colorbar` | 修改 colorbar | 协议已预留，覆盖仍需补齐 |
| `layout.position.text` | 拖动普通文本 | 当前 Figure 内可用 |
| `layout.position.legend` | 拖动图例容器 | 当前 Figure 内可用 |
| `visibility.component` | 显隐组件 | 基础路径 |

### 3.3 Selection mode 语义

| selectionMode | 含义 | 应用场景 |
|---|---|---|
| `explicit_objects` | 只改明确选中的 objectIds | 单个文本、单个 tick、拖拽 |
| `selected_only` | 只改当前选中子集 | 配色中心“仅修改已选图元” |
| `role_in_subplot` | 改某个子图内的语义角色 | 某个子图内所有 x tick 或 y label |
| `role_in_figure` | 改整张 Figure 的语义角色 | 字体中心整组修改、跨图 retarget |

## 4. 已解决的问题

### 4.1 y 轴标签和 y tick 误伤

旧问题：

- 修改 `ylabel.0 color` 时，可能因为前端只知道“y 轴相关文字”而把 `axis.y.0 tick_labelcolor` 也改掉。

当前处理：

- `targetRole: 'y_axis_label'` 只匹配 `ylabel.*`。
- `targetRole: 'y_tick_label'` 才匹配 tick 或 axis tick props。

验收测试：

- `editingIntentCompiler.test.ts` 中 `keeps y-axis label color separate from y tick label color`。

### 4.2 单个 tick 文本被扩展为整组 tick

旧问题：

- 用户双击或选择某个 tick 文本修改内容，结果整组 tick 一起变。

当前处理：

- `content.text + explicit_objects` 禁止走 tick group 映射。
- 只有样式类 group 编辑才把 `fontsize/color/fontfamily` 映射到 `axis.x/y.*` 的 `tick_label*` 属性。

验收测试：

- `compiles explicit text content edits without expanding to sibling tick labels`。
- `keeps explicit tick color edits on the selected tick object`。

### 4.3 跨 Figure raw gid 复制

旧问题：

- 源图 `ylabel.0` 直接复制到目标图，目标图结构不同就错改或漏改。

当前处理：

- 有 `targetRole` / `targetKinds` 的 intent 允许 retarget。
- 没有语义角色的 source-only intent 跳过。
- `crossFigure: 'deny'` 的拖拽和单文本内容修改禁止跨图。

验收测试：

- `retargets explicit source objects by semantic role for cross-figure apply`。
- `does not retarget source-only intents without a semantic role or kind`。
- `does not retarget drag position intents across figures`。

## 5. 当前不足

### 5.1 诊断不可见

当前编译器会返回 `skipped` 和 `diagnostics`，但 UI 主要只在 console 输出：

```ts
console.warn('[EditingIntent] skipped targets', result.skipped);
```

问题：

- 用户不知道“应用到全部图”到底改了哪些对象。
- 用户不知道哪些对象因为 R/unsupported/不匹配被跳过。
- Gemini 或其他开发者容易误以为“按钮没反应”，实际是安全跳过。

### 5.2 语义角色覆盖不足

当前角色覆盖了标题、轴标签、tick、legend、subplot、line/patch/collection、heatmap/colorbar 预留等基础对象，但仍不足：

- legend 容器、legend 文本、legend marker/line/patch 之间缺少绑定关系。
- colorbar label、tick、bounds、mappable heatmap 之间的联动语义仍需强化。
- spine、grid、tick line、axis frame 的批量处理还不够直观。
- 多子图中“左上/右下子图”的可视化选择和 role scope 仍需增强。
- R/ggplot facet、guide、scale 与 Python Matplotlib artist 的能力矩阵还没有完全对齐。

### 5.3 跨图应用仍偏保守

当前策略是安全优先：

- 有语义角色才 retarget。
- 无法确认就跳过。

这能避免误改，但会造成“应用全部图后有些图没变化”。后续需要通过更强 manifest 语义补齐命中率，而不是降低安全阈值。

### 5.4 测试矩阵还不完整

当前已有单元测试和部分浏览器 smoke，但还需要固定真实项目矩阵：

- Python 单图。
- Python 多 Figure。
- Python 单 Figure 多子图。
- R ggplot 单图。
- R facet 多子图。
- heatmap + colorbar。
- legend 移动和 legend 样式。
- boxplot / violinplot / grouped bar / errorbar。
- 配色中心 subset vs whole group。

## 6. 升级路线

### Phase A：稳定现有中间层

目标：不扩展功能，先保证已有语义层不会破坏原有编辑体验。

任务：

1. 保留所有原有直接 patch 能力，intent 只是 metadata 和编译辅助，不改变后端接口。
2. 所有 `PatchEntry.intent` 在发送 `/api/figure/patch` 前必须剥离。
3. 所有 `content.text`、`layout.position.*` 默认 `crossFigure: 'deny'`。
4. 所有 unsupported 对象必须 `skip_with_warning`，不能生成危险 patch。
5. 修复所有因中间层引入导致的 UI 回归，例如适配按钮、单击选中、属性编辑面板响应。

验收：

```bash
npx tsc --noEmit
npm test -- --run src\utils\editingIntentCompiler.test.ts
npm run test:semantic-smoke
npm run test:multisubplot-smoke
npm run test:cross-figure-smoke
```

### Phase B：诊断可视化

目标：让用户看见每次语义编译结果。

新增 UI：

- Draft 应用后显示“已修改 X 个对象，跳过 Y 个对象”。
- 跨 Figure 应用后按 Figure 展示结果：
  - `fig_1`：修改 6 项，跳过 0 项。
  - `fig_2`：修改 4 项，跳过 2 项。
  - `fig_3`：跳过 colorbar bounds，因为目标图无 colorbar。
- RightSidebar 底部增加可折叠“本次修改目标”面板。
- 对 skipped reason 做中文解释：
  - `not_found`：目标图没有匹配对象。
  - `unsupported_prop`：该对象不支持此属性。
  - `unsupported_scope`：该作用域不能安全批量修改。
  - `unsupported_engine`：当前语言引擎不支持。

实现建议：

- 新增 `EditingIntentReport` 类型。
- `compileIntentPatches()` 不只返回 patches，也返回 diagnostics。
- `App.tsx` 在 `applyDrafts()` 后聚合 per-figure report。
- UI 不阻断操作，只提供明确反馈。

验收：

- 手动应用到全部图时，能看见每张图的修改/跳过数量。
- 对 R facet 修改 unsupported bounds 时，UI 显示跳过原因。
- 不再只依赖 console warning。

### Phase C：语义角色补齐

目标：提高可安全批量修改的对象覆盖率。

优先级：

1. 文本角色：
   - title
   - subtitle/suptitle
   - x/y axis label
   - x/y tick label
   - legend title
   - legend text
   - annotation
   - panel label

2. 轴与框线：
   - axis frame
   - top/right/bottom/left spine
   - tick line
   - grid line
   - axis bounds

3. 图例：
   - legend container
   - legend text
   - legend marker/line/patch
   - legend title
   - legend layout props

4. 色条：
   - colorbar container
   - colorbar label
   - colorbar tick label
   - colorbar bounds
   - linked mappable heatmap

5. 数据图元：
   - line
   - scatter collection
   - bar container
   - errorbar container
   - boxplot container
   - violinplot container
   - heatmap / quadmesh / image

要求：

- 每类对象必须在 manifest 中有稳定 `role` / `subplotId` / `kind` / `editable`。
- 前端不得根据 SVG 外观猜测语义。
- 对不可稳定回放的对象，不开放编辑或只读展示。

验收：

- `SEMANTIC_CAPABILITY_MATRIX.md` 更新每类对象的 recognized/editable/readonly/unsupported 状态。
- `component_kind_matrix_smoke` 覆盖代表性对象。

### Phase D：跨 Figure 应用增强

目标：跨图批量修改既安全又有更高命中率。

规则：

- 样式类 intent 可以跨图：
  - 字体族、字号、颜色、粗细、斜体。
  - 线宽、线型、框线、tick、grid。
  - 组件颜色和透明度。

- 内容类 intent 默认不能跨图：
  - 单个文本内容。
  - 单个 tick 文本。
  - 单个 annotation 内容。

- 位置类 intent 默认不能跨图：
  - 拖拽文本。
  - 拖拽图例。
  - colorbar 手动 bounds。

- 布局类 intent 只有明确 opt-in 才跨图：
  - 统一子图真实绘图区尺寸。
  - 统一 subplot bounds。
  - 统一画布尺寸。

实现建议：

- 给 `EditingIntentName` 增加分类 helper：
  - `isStyleIntent()`
  - `isContentIntent()`
  - `isPositionIntent()`
  - `isLayoutIntent()`
- `retargetEditingIntentForFigure()` 使用分类策略，而不是只看 `crossFigure`。
- 对 `role_in_subplot` 跨图应用时，如果目标图子图数量不同，默认扩展为 `role_in_figure` 或要求用户选择。

验收：

- 单图样式应用到 2x2 多子图目标时，能 fan out 到所有对应子图。
- 单个文本内容不跨图。
- 拖拽位置不跨图。
- 用户能看见每张图的命中和跳过情况。

### Phase E：R/Python 能力对齐

目标：前端协议统一，后端能力如实声明。

原则：

- Python 和 R 不需要共享同一个内省实现。
- Python/R 必须输出同一前端可理解的 StandardFigureModel / Manifest 协议。
- 每个对象必须声明 `editable` 和 `unsupportedProps`，前端按能力显示。

对齐表：

| 能力 | Python Matplotlib | R ggplot2 | 前端策略 |
|---|---|---|---|
| title/xlabel/ylabel | 可编辑 | 可编辑 | 共用 text role |
| tick 字号/字体/颜色 | axis 级稳定 patch | theme/scale 级 patch | 共用 tick role，后端各自实现 |
| 单个 tick 文本 | 部分可编辑 | 取决于 scale labels | 只在可稳定回放时开放 |
| legend 文本 | 可编辑 | guide/scale 相关 | 优先整体 legend role |
| legend 位置 | 可编辑 | theme legend.position | 共用 legend container |
| facet/subplot bounds | 可编辑 | 多数不稳定 | R facet 默认 unsupported |
| heatmap/colorbar | 已有基础能力 | ggplot tile/raster 基础能力 | 继续补能力矩阵 |
| 拖拽 annotation | 可编辑 | 已有基础能力 | 只支持 position 稳定对象 |

验收：

```bash
npm run test:semantic-smoke
npm run test:r-semantic-smoke
npm run test:multisubplot-smoke
```

### Phase F：回归测试矩阵

目标：每次升级都能证明没有破坏旧功能。

必须覆盖：

1. 单击选中图元后，属性编辑面板可编辑。
2. 双击单个文本，只改自身内容。
3. 改 y label 颜色，不改 y tick。
4. 改单个 y tick 颜色，不改全部 y tick。
5. 字体中心整组改 x tick 字号，映射为 axis-level patch。
6. 组件中心改某条线宽，只改该线。
7. 配色中心“仅修改已选图元”不影响整组。
8. 配色中心“修改整组代码常量”只走 code_patch。
9. 多子图中选择左上/右下子图，作用域正确。
10. 跨 Figure 应用样式，目标图按语义匹配。
11. 跨 Figure 应用单文本内容，被禁止或跳过。
12. 拖拽文本后确认，只记录当前 Figure 当前对象。
13. R 路径 unsupported 属性被跳过并显示原因。
14. 适配按钮、100%、滚轮缩放、平移不受语义层影响。

建议新增测试：

```bash
npm run test:editing-intent-ui-smoke
npm run test:editing-intent-cross-figure-smoke
npm run test:editing-intent-r-compat-smoke
```

## 7. Gemini / 外部 AI 开发约束

如果将本文档交给 Gemini 或其他 AI 开发，必须附带以下约束：

1. 不允许实现 AI 改图功能。
2. 不允许新增后端 `/api/figure/intent`，除非单独审批。
3. 不允许删除现有 `PatchEntry` / Draft Batch / `/api/figure/patch` 路径。
4. 不允许让前端根据 SVG 外观猜语义；语义必须来自 manifest / StandardFigureModel。
5. 不允许因为某对象不能编辑就静默失败；必须返回 skipped diagnostic。
6. 不允许把 `intent` 原样发给后端现有 patch API；发送前必须剥离 metadata。
7. 不允许把 `content.text` 和 `layout.position.*` 默认跨图应用。
8. 不允许为“看起来功能完整”开放不可稳定回放的 R facet bounds 或 Matplotlib tick 自由拖拽。
9. 每个新 role 必须同时更新测试和能力矩阵。
10. 任何 UI 回归，例如适配按钮、单击选中、属性面板响应，必须按 P0 回归处理。

## 8. 成功标准

本升级完成后，应达到以下状态：

- 用户能清楚知道一次编辑会修改哪些对象。
- 批量修改和跨图应用不再依赖 raw gid。
- 单对象编辑、组编辑、跨图编辑三者边界明确。
- Python/R 前端操作入口一致，后端能力差异通过 `editable/unsupported` 明确表达。
- 不支持的对象不会乱改，而是跳过并给出可读原因。
- 语义层不影响画布缩放、适配、选中、导出等非 patch 功能。
- 所有关键路径都有自动化测试和真实浏览器 smoke test。

## 9. 推荐实施顺序

优先级建议：

1. Phase A：稳定已有中间层和 UI 回归。
2. Phase B：诊断可视化。
3. Phase C：补 legend / colorbar / axis frame / grid / tick line 语义角色。
4. Phase D：增强跨 Figure 应用策略。
5. Phase E：R/Python 能力矩阵对齐。
6. Phase F：固化完整回归测试矩阵。

不要先做后端 AST intent API，也不要先做 AI 改图。当前最有价值的路线是把“前端语义路由 + 可见诊断 + 能力矩阵 + 回归测试”做稳定。

## 10. 实施进度记录

### 2026-07-07：Phase A/B 首轮收敛

已完成：

- 修复编辑器画布 `适配` 按钮：点击时强制重新测量容器、重置平移、退出手动缩放并回到 fit 模式，避免已处于 fit 状态时视觉无响应。
- 新增 `EditingIntentApplyReport` / `EditingIntentApplyTargetReport` 类型，用于记录每次应用草稿后的 per-Figure 修改/跳过结果。
- `App.tsx` 在 `handleApplyDraft()` 中聚合语义应用报告：
  - 当前图、选中图、全部图均记录报告。
  - code_patch 跨图跳过会归一化为 `unsupported_scope`。
  - 无匹配对象会归一化为 `not_found`。
  - 最近 5 次报告保留在前端状态中。
- `RightSidebar.tsx` 新增“最近语义应用结果”面板：
  - 显示应用范围、总修改数、总跳过数。
  - 按 Figure 展示 `改 X · 跳 Y`。
  - 对跳过项显示中文原因：未匹配、属性不支持、作用域不安全、引擎不支持。
- `tests/playwright/cross_figure_apply_smoke.mjs` 增加 `X1-report-visible` 断言，确保应用全部图后右侧可见“最近语义应用结果”。
- `editingIntentCompiler.ts` 增加 intent 分类 helper：
  - `isStyleIntent()`
  - `isContentIntent()`
  - `isPositionIntent()`
  - `isLayoutIntent()`
- 跨 Figure retarget 默认只允许样式类意图；内容类、位置类和布局类意图除非显式 `crossFigure: 'allow'`，否则安全跳过。
- `editingIntentCompiler.test.ts` 增加内容类和布局类默认禁止跨图的断言，防止后续误放开。
- 修复跨图应用中的旧 fallback 漏洞：只要 draft 携带 `intent`，目标 Figure 必须以 intent 编译结果为准；即使编译结果为空，也不能退回 raw gid 映射。该修复防止 `content.text` 在目标图中同名 `title.0` 上被误套用。
- `tests/playwright/cross_figure_apply_smoke.mjs` 增加 `X1-content-deny-cross-figure`：注入 `content.text` 草稿后点击“应用全部图”，验证只修改源 Figure，目标 Figure 被跳过且 UI 显示“部分跳过 / 跳过 2”。
- Phase C 前端协议细分已推进：
  - 新增 `legend_title`、`legend_marker`、`colorbar_label`、`colorbar_tick_label`、`axis_spine`、`tick_line` 语义角色。
  - `inferRole()` 已区分 legend 标题、legend 正文、legend 符号/线段、colorbar 标签、colorbar tick、具体 spine。
  - `axis_frame` 保持向后兼容，可匹配具体 `spine` 对象。
  - 新增单元测试覆盖 legend 三类角色隔离、colorbar label/tick 隔离、axis_frame 与 spine 兼容。
- `docs/SEMANTIC_CAPABILITY_MATRIX.md` 新增“前端语义编辑意图角色”表，记录角色、对象来源、状态和跨图策略。

已验证：

```bash
npx tsc --noEmit
npm test
npm run build
npm run test:semantic-smoke
npm run test:multisubplot-smoke
npm run test:cross-figure-smoke
```

最新 smoke 证据：

- `output/playwright/semantic-centers-2026-07-07T15-10-51-168Z/report.md`
- `output/playwright/multisubplot-semantics-2026-07-07T15-10-51-361Z/report.md`
- `output/playwright/cross-figure-apply-2026-07-07T15-11-50-988Z/report.md`
- `output/playwright/cross-figure-apply-2026-07-07T15-14-00-348Z/report.md`
- `output/playwright/cross-figure-apply-2026-07-07T15-26-12-392Z/report.md`
- `output/playwright/semantic-centers-2026-07-07T15-27-35-064Z/report.md`
- `output/playwright/multisubplot-semantics-2026-07-07T15-27-35-360Z/report.md`
- `output/playwright/cross-figure-apply-2026-07-07T15-27-35-536Z/report.md`

仍未完成：

- Phase C：前端协议角色已补一轮；后续还需要真实浏览器 smoke 覆盖 legend/colorbar 角色，并等待后端稳定输出 `tick_line` manifest 后开放。
- Phase D：跨 Figure 应用策略 helper 已建立；单文本内容跨图跳过已加入浏览器 smoke。后续还需要覆盖位置类和布局类跨图跳过。
- Phase E：R/Python 能力矩阵进一步对齐。
- Phase F：新增独立 `editing-intent-ui-smoke`、R 兼容专项和更多 skipped diagnostic 场景。
