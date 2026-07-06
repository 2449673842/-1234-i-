# SciFig 优秀升级版进度状态

更新时间：2026-07-06

## 总体完成度

当前升级计划约完成 **100%**。

已完成的是主架构、当前图 patch、Draft Batch、stale response guard、缓存、拖拽基线与扩展路径、导出 revision 基线与完整格式矩阵、语义中心基线、R 前端语义中心专项、配色中心 subset-vs-whole 专项、2x2 多子图语义范围专项、组合图源资产 revision 一致性基线与 stale UI 验证，以及跨图“应用全部图 / 应用选中图”浏览器基线。

## 已验证完成项

| 模块 | 当前状态 | 已有证据 |
|---|---|---|
| StandardFigureModel 协议层 | Verified baseline | `npm test` 覆盖 normalizer。 |
| ManifestViewer 安全渲染 | Verified baseline | `npm run test:behavior-smoke` A1，无 React object-child crash。 |
| Draft Batch 当前图 | Verified baseline | `npm run test:behavior-smoke` C1/C2，修改进入暂存，应用前无后端请求，应用后一次 patch。 |
| 当前图单独重绘 | Verified baseline | `npm run test:behavior-smoke` E2，请求携带 `figureId=fig_1`，未调用项目全量 `/figures/render`。 |
| stale response guard | Verified baseline | `npm run test:behavior-smoke` E3，延迟旧 patch 响应不会覆盖新结果。 |
| 颜色修改 Undo | Verified baseline | `npm run test:behavior-smoke` H2，颜色应用后 Undo 可触发重渲染。 |
| 后端 render cache | Verified baseline | `npm run test:cache-smoke`，首次 miss、重复同语义 patch hit、改 value 后 miss。 |
| 拖拽基线 | Verified baseline | `npm run test:behavior-smoke` K1/K2，关闭时单击选择正常，开启后确认发送一次 `position` patch，Undo 可用。 |
| 拖拽扩展路径 | Verified extended | `npm run test:drag-extended-smoke`，多对象拖拽一次确认发送 2 条 `position` patch；取消路径不发 patch；unsupported object 与 R/native 坐标对象只显示提示、不生成 patch。 |
| 导出 latest revision | Verified baseline | `npm run test:behavior-smoke` L1，修改唯一文本后导出 SVG 含最新文本。 |
| 导出完整格式矩阵 | Verified extended | `npm run test:export-matrix-smoke`，SVG/PNG/PDF/TIFF 选中图导出均成功，`fig_2` 导出不泄漏 `fig_1` SVG 内容，全项目 SVG 导出包含两张图，资产列表返回 `sizeBytes`/`downloadUrl`，pending render 时导出被阻塞且不发送 `/export` 请求。 |
| 字体中心 | Verified baseline | `npm run test:semantic-smoke` F1，X tick 字号映射为 `axis.x.0 / tick_labelsize`。 |
| 组件中心 | Verified baseline | `npm run test:semantic-smoke` G1，线宽编辑发送 `line.0.0 / linewidth`。 |
| 组件图元矩阵 | Verified extended | `npm run test:component-kind-matrix`，API 验证 line、collection、bar/errorbar/boxplot/violinplot container、heatmap、colorbar、legend、spine_group、axis_x 均可内省、patch、回放并持久化。 |
| 配色中心 subset-vs-whole | Verified baseline | `npm run test:semantic-smoke` H1-subset/H1-whole，选中子集发送单对象 attribute patch，整组发送 `LINE_COLOR` code_patch 并携带绑定 gids。 |
| R 前端语义中心 | Verified extended | `npm run test:r-semantic-smoke`，R/ggplot manifest 中字体中心发送 `axis.x.0 / tick_labelsize`，组件中心发送 `r.layer.1 / linewidth`，配色中心发送 `r.group.color.0.0 / color`，且无 console/page error。 |
| 多子图语义范围 | Verified baseline | `npm run test:multisubplot-smoke`，2x2 fixture 中字体中心选择 `subplot.0` 只发送 `axis.x.0 / tick_labelsize`，组件中心选择 `subplot.3` 只发送 `line.3.0 / linewidth`。 |
| 组合图源资产一致性 | Verified baseline | `npm run test:composer-smoke`，组合资产保存 `sourceAssetSnapshots` / `sourceAssetRevisions` / `sourceFigureRevisions`，并证明 compose 不会修改源资产 metadata。 |
| 组合图 stale UI / 刷新体验 | Verified extended | `npm run test:composer-stale-smoke`，源图 revision 高于导出资产 revision 时显示“源图已更新”；点击徽标弹出版本说明；重新导出源图并刷新后，使用新资产排版不再显示 stale 徽标。 |
| 跨图应用全部图 / 应用选中图 | Verified extended | `src/utils/semanticPatchMapping.test.ts`，`npm test` 42/42；`npm run test:cross-figure-smoke`。浏览器验证“应用全部图”向 `fig_1` / `fig_2` / `fig_3` 分别发送 `/api/figure/patch`；“应用选中图”在只勾选 `fig_2` 时只发送 `fig_2` patch；单图样式应用到多子图目标时会 fan out 到目标全部子图；全程未调用项目全量 `/figures/render`，且无 `code_patch` 混入。 |
| 跨 Figure 并发隔离 | Verified extended | `npm run test:cross-figure-concurrency`，API 并发向 `fig_1` / `fig_2` 写入不同 X 轴标签，两个 patch 同时成功，revision/editLog 分别持久化为各自目标值，响应不串图。 |
| Python introspection 回归 | Verified baseline | `tests/test_introspection.py` 15/15，新增覆盖 `patch_artist=True` boxplot 的 `PathPatch` 颜色读取。 |
| R renderer 回归 | Verified baseline | `tests/test_r_renderer.py` 13/13。 |

## 已通过测试命令

```powershell
npx tsc --noEmit
npm test
npm run build
npm run test:behavior-smoke
npm run test:semantic-smoke
npm run test:r-semantic-smoke
npm run test:multisubplot-smoke
npm run test:cross-figure-smoke
npm run test:component-kind-matrix
npm run test:cross-figure-concurrency
npm run test:export-matrix-smoke
npm run test:cache-smoke
npm run test:composer-smoke
npm run test:composer-stale-smoke
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_r_renderer.py
```

最近稳定证据：

```text
output/playwright/behavior-smoke-2026-07-05T14-42-58-753Z/report.md
Conclusion: PASS, PASS=13, FAIL=0, BLOCKED=0

output/playwright/semantic-centers-2026-07-05T14-42-29-755Z/report.md
Conclusion: PASS, PASS=4, FAIL=0, BLOCKED=0
```

历史扩展专项失败证据：

```text
output/playwright/semantic-centers-2026-07-05T14-49-02-748Z/report.md
Conclusion: FAIL, PASS=3, FAIL=2, BLOCKED=0

失败项：
- H1-subset：选中单对象后发送了 legend_line.0.0 / color / #1F77B4，而不是预期的目标颜色与目标图元。
- H1-whole：整组路径同样退化为 legend_line.0.0 / color / #1F77B4，未形成预期 whole-group code_patch。

结论：
该失败已复核并修复，保留为回归来源。
```

最新扩展专项通过证据：

```text
output/playwright/semantic-centers-2026-07-06T00-48-45-755Z/report.md
Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0

通过项：
- H1-subset：选中单对象后发送单条普通 attribute patch，非 code_patch。
- H1-whole：整组路径发送 `LINE_COLOR` code_patch，并携带绑定 gids。
```

最新多子图专项通过证据：

```text
output/playwright/multisubplot-semantics-2026-07-06T00-56-51-501Z/report.md
Conclusion: PASS, PASS=4, FAIL=0, BLOCKED=0

通过项：
- M0-fixture：2x2 fixture 识别 4 个 subplot、4 个 X axis、4 条 line。
- M1-font-subplot-scope：字体中心选择 `subplot.0` 后，X tick 字号只发送 `axis.x.0 / tick_labelsize`。
- M2-component-subplot-scope：组件中心选择 `subplot.3` 后，线宽只发送 `line.3.0 / linewidth`。
```

最新跨图应用通过证据：

```text
output/playwright/cross-figure-apply-2026-07-06T13-16-03-214Z/report.md
Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0

通过项：
- X0-fixture：项目中存在 `fig_1`、`fig_2`、`fig_3` 三张图，其中 `fig_3` 是 2x2 多子图。
- X1-apply-all：修改当前图 X tick 字号后，“应用全部图”启用并发送 `fig_1` / `fig_2` / `fig_3` 三个 `/api/figure/patch` 请求。
- X1-apply-all：`fig_3` 的 X tick 字号 fan out 到 `axis.x.0`、`axis.x.1`、`axis.x.2`、`axis.x.3`。
- X1-apply-all：未调用项目全量 `/figures/render`。
- X1-apply-all：payload 中无 `code_patch`，只包含普通语义 patch。
- X2-apply-selected：只勾选 `Figure 2` 后，“应用选中图”只向 `fig_2` 发送一个 `/api/figure/patch` 请求。
- X2-apply-selected：未调用项目全量 `/figures/render`。
- X2-apply-selected：payload 中无 `code_patch`，只包含 `axis.x.0 / tick_labelsize / 16` 普通语义 patch。
- X3-single-to-multisubplot-style-fanout：从 `fig_2` 单图修改“边框 / 网格”线宽后，“应用全部图”发送到 `fig_3` 的 patch 覆盖 `grid.0-3` 和四边 `spine.left/right/top/bottom.0-3`，即 2x2 多子图全部生效。
- N1：无 console error / pageerror。
```

最新组件图元矩阵通过证据：

```text
npm run test:component-kind-matrix
Conclusion: PASS

通过项：
- 初始 render 识别 axes、subplot、grid、spine_group、axis_x/y、text、spine、legend、line、collection、bar_container、errorbar_container、patch、boxplot_container、violinplot_container、heatmap、stem_container、colorbar。
- 逐项 patch 并验证回放：`line.0.0 / linewidth`、`collection.0.0 / alpha`、`container.bar.1.0 / linewidth`、`container.errorbar.1.1 / elinewidth`、`container.boxplot.2.0 / median_color`、`container.violinplot.3.0 / alpha`、`heatmap.image.4.0 / alpha`、`colorbar.6 / label`、`legend.0 / title`、`spine_group.0 / linewidth`、`axis.x.0 / tick_labelsize`。
```

最新跨 Figure 并发隔离通过证据：

```text
npm run test:cross-figure-concurrency
Conclusion: PASS

通过项：
- 并发向 `fig_1` 写入 `axis.x.0 / label / Concurrent X One`，向 `fig_2` 写入 `axis.x.0 / label / Concurrent X Two`。
- 两个响应均成功且 revision 均为 2。
- `fig_1` 响应不包含 `fig_2` 标签，`fig_2` 响应不包含 `fig_1` 标签。
- `/api/projects/:id/figures` 回读确认两个 figure 的 revision/editLog 分别独立持久化。
```

最新拖拽扩展路径通过证据：

```text
output/playwright/drag-extended-2026-07-06T02-15-20-379Z/report.md
Conclusion: PASS, PASS=6, FAIL=0, BLOCKED=0

通过项：
- D1-multi-drag：已选中两个文本对象时，拖动其中一个后确认条显示累计 2 个文本对象，确认后只发送 1 个 `/api/figure/patch` 请求，包含 2 条 `position` patch。
- D2-cancel：拖拽后点击“取消”，不发送 `/api/figure/patch`，确认条消失。
- D3-unsupported：拖拽 line 对象时显示“不支持拖拽”提示，不生成 patch。
- D4-r-native-protection：R/native 坐标文本对象被保护，只提示不支持拖拽，不生成 patch。
- N1：无 console error / pageerror。
```

最新导出矩阵通过证据：

```text
output/playwright/export-matrix-2026-07-06T02-29-38-382Z/report.md
Conclusion: PASS, PASS=9, FAIL=0, BLOCKED=0

通过项：
- X1-svg/png/pdf/tiff：选中 `fig_2` 导出四种格式均成功，且 SVG 内容不包含 `fig_1`。
- X2-all-svg：不传 `figureId` 时项目级 SVG 导出包含 `fig_1` 和 `fig_2`。
- X3-assets：导出资产库包含 svg/png/pdf/tiff，且每个资产都有 `sizeBytes` 与 `downloadUrl`。
- X4-pending-block：项目渲染 pending 时点击导出不发送 `/export` 请求，并提示等待渲染完成。
- N1：无 console error / pageerror。
```

最新 R 前端语义中心通过证据：

```text
output/playwright/r-semantic-centers-2026-07-06T02-40-43-177Z/report.md
Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0

通过项：
- R0-fixture：R/ggplot 渲染生成 `r_svg` manifest，包含 `axis.x.0` / `axis.y.0`、`r.layer.0` / `r.layer.1` 和 `r.group.color.0.0` / `r.group.color.0.1`。
- R1-font-center：字体中心 X tick 字号发送 `axis.x.0 / tick_labelsize / 13`。
- R2-component-center：组件中心线宽发送 `r.layer.1 / linewidth / 2.2`。
- R3-palette-center：配色中心发送 `r.group.color.0.0 / color / #2CA02C`。
- N1：无 console error / pageerror。
```

最新 Python 语义中心回归通过证据：

```text
output/playwright/semantic-centers-2026-07-06T02-41-48-271Z/report.md
Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0
```

最新组合图一致性 API 通过证据：

```text
npm run test:composer-smoke
Conclusion: PASS

通过项：
- `/api/projects/:id/compose` 创建独立 composite asset。
- composite metadata 记录 `sourceAssetSnapshots`。
- composite metadata 记录 `sourceAssetRevisions`：源资产 revision 3 / 5 保持一致。
- composite metadata 记录 `sourceFigureRevisions`：`fig_1` revision 3、`fig_2` revision 5。
- compose 后源资产 metadata 未被反向修改。
```

最新组合图 stale UI 通过证据：

```text
output/playwright/composer-stale-ui-2026-07-06T02-51-17-391Z/report.md
Conclusion: PASS, PASS=4, FAIL=0, BLOCKED=0

通过项：
- C1-stale-badge：`fig_1` 项目 revision 变为 v2，而旧导出资产为 v1 时，组合图 panel 显示“源图已更新”。
- C2-stale-dialog：点击徽标弹出说明，包含“当前版本 v2，导出资产版本 v1”。
- C3-refresh-clears-stale：重新导出 `fig_1` 后得到 revision v2 的新资产，刷新并重新拖入后 stale 徽标消失。
- N1：无 console error / pageerror。
```

## 剩余差距

当前目标清单内没有剩余未验收项。

## 结论

当前目标清单已收口。主链路、核心架构、配色 subset-vs-whole、R/Python 语义中心、2x2 多子图语义范围、拖拽扩展路径、导出完整格式矩阵、组合图源资产 revision 一致性和 stale UI，以及跨图“应用全部图 / 应用选中图”均已有验证证据。
