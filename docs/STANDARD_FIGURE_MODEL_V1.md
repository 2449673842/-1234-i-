# StandardFigureModel v1

## 目标

把 Python Matplotlib 与 R ggplot 的运行结果统一成同一套前端可消费协议，降低后续组件中心、字体中心、配色中心、拖拽和导出的重复适配成本。

整体升级进度、已通过测试和剩余差距见 `docs/SCIFIG_EXCELLENT_UPGRADE_STATUS.md`。

## 当前实现范围

当前分支已经从“只新增契约层”推进到“协议层 + UI 读迁移 + Draft Batch 基础验收”：

- 新增 `StandardFigureModel` 类型。
- 新增 `normalizeFigureModel()` / `normalizeRenderResponse()` / `normalizeProjectFigures()`。
- 保留原始 `manifest` 与 `svg`，不改变 Python 或 R 渲染器输出。
- `ManifestViewer` 已接入只读调试信息，并修复对象值直接渲染导致的 React crash。
- `RightSidebar` 的组件中心、字体中心、配色中心已开始读取标准模型视图。
- 项目图形已引入按 `figureId` 的 request guard、draft bucket 和当前图应用入口。
- R 路径中单个 tick 对象保留识别但降为只读，避免把 ggplot 轴级样式能力伪装成单 tick 可编辑。
- R 前端语义中心已通过专项浏览器验收：字体中心、组件中心、配色中心均走 R manifest 的 backend patch。

## 非目标 / 当前仍未完成

当前仍不宣称完成以下事项：

- 不合并 Python 与 R 渲染器。
- 不重写 `RightSidebar`、`ChartPreview` 或 `MainWorkspace`。
- 不新增数据库字段。
- 跨图“应用选中图 / 应用全部图”已完成浏览器基线验收；实现必须继续遵守按 `stableKey/role/kind/subplotId` 语义映射，禁止复制 raw gid。
- 拖拽模式已完成扩展浏览器验收；后续只在新增坐标类型时继续补对应保护测试。
- 导出 revision 一致性、导出完整格式矩阵、组合图资产 revision 一致性和组合图 stale UI 已有专项测试。

## 协议结构

```ts
interface StandardFigureModel {
  schemaVersion: '1.0';
  figureId: string;
  engine: 'python_matplotlib' | 'r_ggplot' | 'unknown';
  language?: 'python' | 'r';
  revision: number;
  svg: string;
  manifest: Manifest;
  globals: Record<string, ManifestField>;
  objects: StandardFigureObject[];
  palettes: Palette[];
  groups: SemanticGroup[];
  bindings: Binding[];
  capabilities: StandardFigureCapabilities;
  editLog: EditEntry[];
}
```

`manifest` 是原始事实来源；`objects/globals/palettes/groups/bindings` 是为了让前端组件少写分支的标准视图。

## 引擎判断

- `manifest.generatedBy === "introspection"` 或 `language === "python"` -> `python_matplotlib`
- `manifest.generatedBy === "r_svg"` 或 `language === "r"` -> `r_ggplot`
- 其他情况 -> `unknown`

## 兼容策略

旧项目的 `SavedEditEntry.mode` 可能为空或不是严格联合类型。归一化时：

- `local_patch` 保留为 `local_patch`
- 其他值统一按 `backend_patch` 处理
- 缺失 `timestamp` 设为 `0`

这样不会破坏旧数据，也不会让前端误以为旧记录可直接本地 patch。

## Migration Status

| Module | Status | Evidence | Notes |
|---|---|---|---|
| Normalizer | Complete | `src/utils/standardFigureModel.test.ts`, `npm test` | Pure TypeScript protocol tests. |
| ManifestViewer | Integrated | `src/components/ManifestViewer.tsx`, strict smoke A1 | No React object-child crash observed. |
| Component Center | Verified extended | `RightSidebar`, `npm run test:semantic-smoke`, `npm run test:multisubplot-smoke`, `npm run test:component-kind-matrix` | Browser smoke changes a component-center line width control and confirms payload contains `line.0.0 / linewidth`; 2x2 multi-subplot smoke confirms scoped edit on `subplot.3` only sends `line.3.0 / linewidth`. API matrix verifies representative patch/replay coverage for line, collection, bar/errorbar/boxplot/violinplot containers, heatmap, colorbar, legend, spine_group, and axis_x. |
| Font Center | Verified baseline | `RightSidebar`, `npm run test:semantic-smoke`, `npm run test:multisubplot-smoke`, Python/R renderer tests | Browser smoke changes X tick group fontsize and confirms payload maps to stable axis-level `axis.x.0 / tick_labelsize`; 2x2 multi-subplot smoke confirms scoped font edit on `subplot.0` only sends `axis.x.0 / tick_labelsize`. |
| Palette Center | Verified baseline | `RightSidebar`, `npm run test:semantic-smoke` | 基础整组 code-patch 路径在 `output/playwright/semantic-centers-2026-07-05T14-42-29-755Z/report.md` 通过；扩展 subset-vs-whole 专项已在 `output/playwright/semantic-centers-2026-07-06T00-48-45-755Z/report.md` 通过。 |
| R Semantic Centers | Verified extended | `npm run test:r-semantic-smoke` | R/ggplot browser smoke verifies font center `axis.x.0 / tick_labelsize`, component center `r.layer.1 / linewidth`, palette center `r.group.color.0.0 / color`, and no console/page errors. |
| Draft Batch current figure | Verified baseline | `npm run test:behavior-smoke` | Proves draft appears, no backend render before apply, one patch/render on apply, undo becomes available. |
| Color edit undo | Verified baseline | `npm run test:behavior-smoke`; `tests/test_introspection.py` | Proves color edits are drafted, applied once, and undo triggers rerender. Python tests also guard axis-label vs tick-label color scope. |
| Cross-figure apply | Verified extended | `src/utils/semanticPatchMapping.test.ts`, `npm test`, `npm run test:cross-figure-smoke` | `应用全部图` maps ordinary object patches by `stableKey/role/kind/subplotId`, skips `code_patch`, sends per-figure `/api/figure/patch`, and does not call project-wide `/figures/render`. Single-panel style patches fan out to all matching subplots in a multi-panel target while content patches stay one-to-one. `应用选中图` uses explicit multi-figure checkbox selection and, when only `fig_2` is checked, sends only the `fig_2` patch. Latest browser report: `output/playwright/cross-figure-apply-2026-07-06T13-16-03-214Z/report.md`. |
| Per-figure current patch | Verified baseline | `npm run test:behavior-smoke` | Proves current draft apply sends `figureId=fig_1` and does not call project-wide `/figures/render`. |
| Per-figure request guard | Verified extended | `npm run test:behavior-smoke`, `npm run test:cross-figure-concurrency`; `App.tsx` requestId guards | Browser test delays the first patch response, sends a second patch, and verifies final SVG keeps the newer value. API concurrency smoke sends simultaneous patches to `fig_1` and `fig_2` and verifies isolated response/persisted revision/editLog state. |
| Backend render cache | Verified baseline | `server.ts`, `src/utils/renderCacheKey.test.ts`, `npm run test:cache-smoke`, `npm run test:behavior-smoke` | Patch responses expose `cache.hit/cache.key`; cache key ignores non-semantic audit fields such as `timestamp`/`requestId`. API smoke proves first semantic patch misses, repeated equivalent patch after editLog reset hits the same key, and changed value misses with a different key. |
| Drag Mode | Verified extended | `ChartPreview.tsx`, `MainWorkspace.tsx`, `npm run test:behavior-smoke`, `npm run test:drag-extended-smoke` | Browser smoke creates controlled draggable text fixtures, verifies drag mode off preserves normal selection, drag mode on shows confirm bar, confirm sends `position` patches, multi-object drag sends one batch with 2 patches, cancel sends no patch, unsupported objects show a hint, and R/native-coordinate text is protected from drag patches. |
| Export consistency | Verified extended | `npm run test:behavior-smoke`, `npm run test:export-matrix-smoke`; `ExportSettingsPage.tsx`; `/api/projects/:id/export`; `/api/projects/:id/export-assets` | Browser/API smoke verifies latest-revision SVG export, selected-figure SVG/PNG/PDF/TIFF export, multi-figure non-contamination, project-wide SVG export, export asset `sizeBytes`/`downloadUrl`, and pending-render export blocking. |
| Composer consistency | Verified extended | `ComposerPage.tsx`, `/api/projects/:id/compose`, `npm run test:composer-smoke`, `npm run test:composer-stale-smoke` | API smoke proves composite assets store source asset/figure revision snapshots and compose does not mutate source asset metadata. Browser smoke verifies stale badge, stale version dialog, and refresh/reload of a newly exported source asset clears the stale state. |

## 验证标准

- `npx tsc --noEmit` 通过。
- `npm run build` 通过。
- Python/R 现有渲染测试不退化。
- `npm test` 通过。
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py` 通过。
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_r_renderer.py` 通过。
- `npm run test:behavior-smoke` 通过，证明 Draft Batch 当前图主链路行为成立。
- `npm run test:multisubplot-smoke` 通过，证明 2x2 多子图的字体中心和组件中心作用范围成立。
- `npm run test:drag-extended-smoke` 通过，证明多对象拖拽、取消路径、unsupported object 提示和 R/native 坐标保护成立。
- `npm run test:component-kind-matrix` 通过，证明代表性 Matplotlib 图元种类可内省、patch、回放并持久化。
- `npm run test:cross-figure-concurrency` 通过，证明并发修改不同 Figure 时响应和持久化状态不串图。
- `npm run test:export-matrix-smoke` 通过，证明 SVG/PNG/PDF/TIFF、选中图不串图、项目级 SVG、资产下载字段和 pending render 阻塞导出成立。
- `npm run test:r-semantic-smoke` 通过，证明 R 前端语义中心可按标准模型驱动字体、组件和配色 backend patch。
- `npm run test:composer-smoke` 通过，证明组合图资产保存源 revision 快照且不反写源资产 metadata。
- `npm run test:composer-stale-smoke` 通过，证明组合图 stale badge、版本说明弹窗、重新导出刷新后清除 stale 状态成立。

## 最新网页行为验收

已新增严格行为测试脚本：

```powershell
npm run test:behavior-smoke
```

该脚本不同于早期“控件存在性测试”，会实际修改右侧属性面板，验证：

- 修改后出现“已暂存”条。
- 应用前不发送后端 patch/render 请求。
- 点击“应用当前图”后只发送一次 patch/render 请求。
- 应用后暂存条清除。
- 应用后撤销按钮变为可用。
- 颜色修改同样进入 draft，应用一次后可通过 Undo 回退。
- 多图项目里当前图 draft apply 请求携带 `figureId`，且不调用项目全量 `/figures/render`。
- Stale response guard：延迟第一次 patch 响应后立即发送第二次 patch，最终 SVG 保留第二次修改，不被旧响应覆盖。
- 导出一致性：修改唯一文本并应用后，项目 SVG 导出响应包含最新文本。
- 导出矩阵：`npm run test:export-matrix-smoke` 证明选中图 SVG/PNG/PDF/TIFF 均可导出且不串图，项目级 SVG 导出包含全部图，资产列表含 `sizeBytes`/`downloadUrl`，渲染 pending 时导出被阻塞且不会发送 `/export` 请求。
- 后端渲染缓存可观测性：当前图 patch 响应包含 `cache.hit` 与 `cache.key`，用于后续验证 hit/miss 和定位重复渲染。
- 后端渲染缓存行为：`npm run test:cache-smoke` 创建受控项目，证明首次 patch miss、恢复空 editLog 后重复同一语义 patch hit、改 value 后 miss。
- 拖拽基线：受控文本 fixture 中，拖拽关闭时普通单击选择可用；拖拽开启后释放出现确认条；确认后只发送一次 `position` patch；Undo 可用。
- 拖拽扩展路径：`npm run test:drag-extended-smoke` 证明多对象拖拽一次确认发送 2 条 `position` patch；取消不发送 patch；line 等 unsupported object 与 R/native 坐标文本只显示保护提示，不生成 patch。
- 语义中心基线：`npm run test:semantic-smoke` 创建受控项目，证明字体中心 X tick 组编辑、组件中心线宽编辑、配色中心颜色常量编辑都会进入 draft，并在“应用当前图”后发送预期 patch payload。
- 页面全程无 console error / pageerror。

最近一次通过报告：

```text
output/playwright/behavior-smoke-2026-07-05T14-33-55-162Z/report.md
Conclusion: PASS, PASS=13, FAIL=0, BLOCKED=0
```

最近一次语义中心通过报告：

```text
output/playwright/semantic-centers-2026-07-05T14-42-29-755Z/report.md
Conclusion: PASS, PASS=4, FAIL=0, BLOCKED=0
```

最近一次语义中心扩展专项报告：

```text
output/playwright/semantic-centers-2026-07-06T00-48-45-755Z/report.md
Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0
配色中心 subset-vs-whole 已验证：selected subset 发送单对象 attribute patch，whole-group 发送 code_patch。
```

最近一次多子图语义范围专项报告：

```text
output/playwright/multisubplot-semantics-2026-07-06T00-56-51-501Z/report.md
Conclusion: PASS, PASS=4, FAIL=0, BLOCKED=0
2x2 多子图已验证：字体中心可按子图范围只修改目标 axis tick，组件中心可按子图范围只修改目标 line。
```
