# SciFigure 当前功能不可回退基线

> 状态：当前有效，所有平台功能升级的合并阻断基线
> 最后修改时间：2026-07-30 16:08:23 +08:00
> 证据截止时间：2026-07-30 16:08:23 +08:00
> 代码范围：`deploy/prod-integration-v3`，Python WP3-WP10 与 R-WP0-WP10 源分支能力已合入，当前批次复验待完成
> 部署状态：未推送、未部署；本文件不代表服务器当前版本
> 数据边界：不得删除、迁移、覆盖或用测试数据替换真实 `data/`

## 1. 文档目的

本文件把此前分散在当前主文档、能力架构文档、统一编辑中心升级方案、能力增强方案和错误日志中的回归约束合并为一份可执行基线。

后续任何 Python、R、编辑中心、布局、历史、导出、组合、安全或性能修改，都必须同时满足：

```text
新增能力有直接证据
现有能力没有回退
旧项目和旧 editLog 继续兼容
真实用户数据没有被测试污染
修改可以按能力域独立回滚
```

“新测试通过”不能代替“旧能力未回退”。如果本文件与早期计划冲突，以当前代码、最新可重复测试和本文件为准。

## 2. 当前证据快照

2026-07-28 当前候选已经获得的最新证据：

| 检查项 | 最新结果 | 说明 |
|---|---:|---|
| TypeScript | 通过 | `npm run lint` |
| 完整单元、Python 身份与生产构建 | 通过 | Vitest 214 文件 / 1740 项；Python introspection + 结构漂移 77/77；`npm run build` 与 `git diff --check` 通过 |
| 前端单元测试 | 通过 | 包含 schema v1-v5、特殊 axes relation、图示 resolver、能力、映射、组件分组、identity 捕获、诊断归一化和 fail-closed 回归；本轮 Draft/matchColor/快照直接相关 19 文件、189/189 |
| WP3 定向单元 | 通过 | RightSidebar、ChartPreview、配色、property scope、session 对账和 snapshot v5 |
| WP5 能力报告 | 通过 | `npm run test:capability-report-smoke`：真实 UI 覆盖部分可编辑、无可识别对象和已识别但只读三种状态，并展示 renderer `unsupportedNotes`；不把 fixture 覆盖扩大解释为任意脚本支持 |
| WP9 发布门禁 | 11/11 通过 | `npm run test:wp9-release-gate`：固定/动态 seed、`random`/NumPy 模块别名、`default_rng(None)`、死分支 seed、非阻断诊断、布局风险与大 scatter 分段预算 |
| WP10 默认启用 | 167/167 通过 | 普通编辑、字体、组件、配色和跨 Figure 使用统一构建时开关；V2 默认开启，App Draft 入口使用受控 resolver，身份冲突 fail-closed，Shadow 证据按 release candidate 隔离 |
| 渲染诊断缓存/重开 | 通过 | `npm run test:render-diagnostics-cache`：两 Figure 的首次 miss、重复 hit、缓存重开和强制预览重开均保留各自诊断且不串写 |
| 旧 contour 与快照 v4 | 通过 | 现代 child/未签名 v4 拒绝且零写入；真实旧 editLog 可保存、导出和恢复 |
| 导出恢复事务 | 通过 | snapshot DB、恢复、并发、v1 兼容和完整 SVG/PNG/PDF/TIFF 导出矩阵 |
| 本轮直接浏览器回归 | 组件 41/41；轴样式 8/8 | global 画布比例、组件布局、网格、图例、刻度和边框未回退 |
| R 五个编辑中心真实浏览器验收 | 26/26 PASS | `test:r-semantic-smoke` 19/19 覆盖字体、组件、配色及公共 Draft/应用/保存刷新/撤销重做/拖拽/导出/快照链路；`test:r-property-layout-centers` 7/7 覆盖属性中心轴刻度与网格、布局中心单图 aspect 和 facet 共享布局边界；两次运行均为 0 console/page error 和 0 failed request |
| Python 完整语义链路 | 通过 | 组件中心 set 全部由 backend renderer 验证；饼图切片与图例联动、Draft 失败保留、导出快照恢复通过，并检查响应业务 `status` |
| 文本自动 Draft 与立即应用 | 通过 | B0E/B0F/B0G 覆盖输入即暂存、backend renderer 写回、改回原值删除 no-op Draft、旧请求完成时保留更新文本、批量应用、刷新、导出和快照恢复 |
| 旧项目完整重渲染兼容 | 通过 | durable Figure editLog 在 session 缺失时仍可重放；空文本、旧轴字体和旧 `line.visible=false` 受控兼容；无版本旧图例 marker 缺少后来新增的 relation 字段时只按 stableKey/seriesKey 兼容，v2 relation 篡改仍拒绝；隐藏线已覆盖打开、继续编辑、导出、后续编辑、v4/v5 快照恢复和刷新；伪造、弱化或关系漂移身份均冲突且 persistence state 完全不变 |
| 保存/拖拽/缓存/跨 Figure | 通过 | project save preflight、drag extended、render cache、cross Figure 18/18；均使用隔离随机端口和临时数据目录 |
| 无 left spine introspection | 50/50 | polar axes 回归通过；线上旧镜像仍需部署当前 renderer 才能消除 `KeyError: 'left'` |
| 越界 artist 白底与导出边界 | 通过 | renderer 扩展 SVG canvas 并记录 `renderViewport`；旧 manifest 回退兼容；隐藏 axes/Figure 坐标拖动、PNG/PDF/TIFF 和真实浏览器越界文字均通过 |
| 独立发布审查 | APPROVE，0 HIGH/MEDIUM | 修复后复审继续发现并关闭非同 GID remap、跨 release Shadow 污染、App 跨 Figure Draft 编译旁路，以及无版本图例 marker 缺新 relation 字段时的误拒绝；最终只读复审无剩余高中风险 |
| Python renderer/身份/复杂覆盖 | complex artist 26/26、结构身份漂移 7/7 | 本地既有 renderer 基线；本工作包未修改 Python 或 Matplotlib 版本，也未新增兼容版本声明 |
| 组件中心真实浏览器 | 41/41；向量场专用分组直接回归通过 | 网格、图例、容器、五个 WP6 家族、父层重定向、保存刷新和拖拽模式多选保护 |
| Python 完整用户链路 | 通过 | 选择、Draft、整批应用、刷新、撤销/重做、导出、后续编辑和快照恢复 |
| Python 真实浏览器能力矩阵 | 136 PASS / 0 FAIL / 3 N/A | 11 个已登记 Python fixture 全部完成真实 SVG、五个编辑中心、结构属性边界、Draft、应用、数据库/刷新持久化、撤销/重做和 SVG 导出检查；控件 fallback 不得跨组件组，请求必须包含目标 `gid+prop`，附加对象只允许由双向 identity relation 证明的图例联动。3 个 N/A 分别是无脚本 palette 的双热图/contour 配色中心及无独立 bounds 能力的雷达布局中心，不作为虚假支持。该结论只覆盖当前登记清单，不扩大为任意 Matplotlib/第三方图形均已支持 |
| `fill_between` 专用语义 | 通过 | dedicated kind/role、旧 GID/stableKey、配色、组件、历史和导出恢复均通过 |
| `contour/contourf` 专用语义 | 通过 | 父对象、只读子层、colorbar 关系、属性 scope、跨 Figure、旧项目和导出恢复均通过 |
| `hist/stairs/step` 专用语义 | 通过 | 专用 role、hist 父子关系、普通对象负例、结构只读、配色、组件、历史和导出恢复均通过 |
| `pie/wedge` 专用语义 | 通过 | 扇区/标签/百分比/图例/Wedge 独立 role，`pieId + sliceIndex` 身份隔离，结构只读、跨 Figure、导出和恢复均通过 |
| `quiver/streamplot` 专用语义 | 通过 | 专用父对象/role、旧 GID 兼容、内部 child 只读、可信关系映射、图例联动、结构只读、跨 Figure、导出和恢复均通过；v2 父对象 relation signature 保护 `quiverId/streamplotId/lineCollectionId/legendMarkerIds`，旧无版本 manifest 不比较该新签名 |
| 网络图/路径图/SEM 显式语义 | 通过 | 七类专用 role、完整关系签名、科学结构只读、组件/配色隔离、Draft/backend replay、跨 Figure、导出和恢复均通过 |
| Python 特殊 axes | 通过当前固定运行时门禁 | polar、3D、inset、secondary、parasite 和自定义投影分类；Python 10 项中 8 通过，Cartopy/brokenaxes 因未安装跳过且不得宣称支持 |
| Python 雷达图专用适配 | 本地候选通过 | renderer 16/16；维度 `xtick` 文字/字体/颜色和 `radar_label_offset` 拖动、`legend_text` 改名与拖动归一到整个 legend、文字 bbox、line/fill 专用组件组通过；新增完整 v2 identity 下先改图例文字再移动图例的 relation 回归；隔离 API 覆盖 patch/刷新缓存/数据库/SVG 导出，组合雷达真实浏览器中的 Python 8 项通过；高分辨率闭合普通 polar、混合图例和同样式歧义负例不会误获或错配雷达能力 |
| R/ggplot2 雷达图专用适配 | 本地候选通过 | 严格单 panel 手写 `coord_polar(theta="x")` 雷达输出 `radarId/radarSeriesId/radarSemanticRole/radarDimensionIndex`；系列线、填充、图例文字、维度文字和 `radar_label_offset` 可独立 backend replay。R renderer 7/7、隔离 API、真实浏览器 R 7 项及共享 0 console/page error 检查通过；Control 线和 Treatment 填充分次编辑时各请求仅含一个目标，刷新后未选系列保持原色。旧 fill line-to-patch identity 对 v2 记录要求同 series/scale/group/fingerprint，对 fingerprint 字段均缺失的更早记录要求 stableKey/semanticKey/seriesKey 与 `aesthetic/groupKey/scaleKey` 完整一致；部分版本字段、关系缺失或伪造 radar 字段均 fail-closed。无版本旧 fill 已通过 SVG 导出、导出快照恢复和篡改快照 409/零写入黑盒验证。普通 polar、facet、`ggradar`、`fmsb` 和任意 grob 不在当前稳定支持范围 |
| R-WP0/WP1 基线与 patch 权威 | 已由 R-WP2 继承 | 静态旧 identity/editLog fixture、服务端 mode 权威、renderer acknowledgement 和失败批次零持久化继续作为不可回退合同；历史 expected failure 不再代表当前状态 |
| R-WP2 identity v2 与旧项目兼容 | 通过本地候选门禁 | R renderer 51/51；layer 数据内容摘要区分同列不同 subset，guide 标题/类型不合并，唯一派生键文本稳定、重复无键文本 unsupported；API 返回 remap `resolvedGid` 且不污染持久 editLog；旧项目编辑、刷新、导出和快照恢复通过。本轮复核要求请求 GID 先存在于当前 manifest，并且只在同规范化 GID 家族内唯一 remap；合法 group/layer/tick 序号变化继续允许，missing GID 和现存跨家族 GID 即使复制有效 identity 也冲突且零持久化；`test:r-identity-v2-compatibility` 通过 |
| R-WP3 运行时与生产一致性 | 通过本地候选门禁 | R renderer 54/54、diagnostics 6/6；生产候选 R 4.5.0/ggplot2 3.5.1 与关键依赖、字体、locale、设备固定；37 个语义对象在本地/直接 Docker/Web Docker 一致；同名文件隔离、源码 SHA 和 stale image fail closed 通过 |
| R-WP4 Point/Jitter | 本地候选 | R renderer 定向 10/10、旧兼容定向 5/5、前端 R Point 协议 3/3、隔离浏览器 R semantic 11/11、lint 和 diff-check 通过；覆盖 mapped shape、shape 19/21-25 能力边界、同批 marker+facecolor、`color/edgecolor` latest-value alias、`size_scale` 比例保持、保存刷新、撤销重做和导出状态 |
| R-WP4 Line/Path/Smooth | 本地候选 | R renderer 定向覆盖 layer-local 与 plot-level inherited mapped linewidth/linetype/color；同轮 Point/Jitter/Bar inherited mapping 8/8、隔离浏览器 R semantic 11/11、lint 通过；旧 `r.layer.N` GID、style edit 下 v2 identity/fingerprint、真实 UI 保存刷新、撤销重做和导出状态保持稳定 |
| R-WP4 Bar/Col | 本地候选 | GeomCol + StatCount GeomBar、Point/Bar 复审和旧身份定向通过；覆盖 inherited fill/color、整层样式、PositionStack/Dodge、bar count、mapped override 后 layer-group-panel relation 稳定；隔离浏览器 12/12 覆盖组件 linewidth、单 fill group、保存刷新、撤销重做和导出 |
| R-WP4 Errorbar family | 本地候选 | renderer 2/2、R/Point 前端合同 6/6、相关 capability matrix 5/5、旧身份/多 panel 7/7、隔离浏览器 12/12；覆盖四类 geom 的主线/端帽/点/Crossbar 组件角色、数据单位 capsize、Pointrange marker/markersize、旧 linewidth alias、subplot relation、Draft/历史/导出 |
| R-WP4 Boxplot/Violin | 本地候选 | renderer 6/6、前端合同 7/7、隔离浏览器 12/12、lint 和 diff-check 通过，独立 `gpt-5.5 high` 审查 APPROVE、0 HIGH/MEDIUM；Boxplot 声明 body/median/whiskers/staples/outliers 关系，整体线色、箱体填充和六类 outlier 样式分离，`outlier_fill` 仅对 shape 21-25 开放；旧 `median_color` 仅兼容迁移到整体轮廓并告警；Violin 声明 body/quantile-lines 边界且不开放虚假 quantile setter，旧 `color` 兼容迁移到 `edgecolor`；共享 fill scale 保留 `distribution` 分组关系，Draft、保存刷新、撤销重做、分组配色和导出一致 |
| R-WP4 Ribbon/Area | 本地候选 | 最新 renderer 定向 9/9、前端合同 10/10、隔离浏览器 12/12、R patch authority 11 场景和 identity v2 compatibility 通过；保留旧 `r.layer.N`、`kind=patch`、GeomRibbon/GeomArea role 和 v2 identity，仅开放 `facecolor/edgecolor/linewidth/alpha`，区间、边界拆分、堆叠和 Smooth 置信带保持只读。整层 fill override 导致 scale 训练键缩短时，从同次原始脚本 baseline 恢复 scale/guide 结构身份而不恢复旧样式；`scaleActive=false` 的休眠 group 在任一 edit 顺序、patch 入口和项目 PUT 保存入口均冲突拒绝且零持久化。配色中心响应必须为业务 `status=success`，组颜色已进入 editLog、刷新、撤销重做和导出 bundle；最终独立审查 `APPROVE/CLEAR`、无 HIGH/MEDIUM |
| R-WP4 集成复验 | 通过（本地候选） | 同一集成分支的 R renderer `85/85`、R 合同 `16/16`、隔离浏览器 `14 PASS / 0 FAIL / 0 BLOCKED`、patch authority 11 场景、identity v2 compatibility 和脚本语法均通过；浏览器 console/page error 为 `0/0`，真实生产仍未切换 |
| R-WP4 Step/Histogram/Freqpoly | 本地候选 | renderer 定向 9/9、前端合同 3/3、隔离家族 API、R patch authority、identity v2 compatibility、浏览器 12/12、lint/build/diff-check 通过，独立复审 `CLEAR`、0 HIGH/MEDIUM。保留旧 `r.layer.N` 和 Step/GeomBar/GeomPath role，以共享类型约束的 `adapterClass` 区分 Histogram/Freqpoly；只开放 color/fill/edge/linewidth/linestyle/alpha，step direction 与 bin/stat 结构保持只读。Step scale group 为 line 语义。离散 scale 身份只按唯一的一对一 `aesthetic + scaleId + groupKey` 恢复；重复键对象不合并且明确 readonly/ambiguous，并在 setter 运行前 fail-closed，冲突响应不得改变 SVG/manifest。项目/standalone 伪 local mode 均规范化并以 `backend_patch` 持久化；mixed batch 零持久化、保存刷新、撤销重做、导出后继续编辑与快照恢复均有隔离证据 |
| R-WP4 Tile/Raster/Rect/Contour/ContourFilled | 本地候选 | 审查前 R renderer 全量 98/98；审查修复后 family 8 定向 6/6、capability matrix 2/2、前端合同 6/6、隔离家族 API、浏览器 14/14、lint/build/diff-check 通过，独立复审 `CLOSED`、0 HIGH/MEDIUM。保留 Tile/Raster/Rect 的旧 `kind=patch`、GID 和 role，Contour/ContourFilled 使用专用 kind/adapter；mapped fill/edge 由 scale/mappable 管理，Raster 不开放边框 setter，连续 contour 支持 `cmap/vmin/vmax`，`levels/x/y/z/bins/breaks` 只读。函数型 breaks JSON 安全，旧无版本 manifest/GID-only editLog 可重放；非法结构和 mixed batch 零持久化，保存刷新、撤销重做、导出后继续编辑与快照恢复均有隔离证据 |
| R-WP4 Segment/Curve | 本地候选 | 完整 R renderer 111/111、NA 行与同色前继/后继定向 3/3、隔离家族 API、identity v2 compatibility、浏览器 14/14、lint/build/diff-check 通过。保留旧 `r.layer.N`、line kind、role 和 v2 identity；只开放未被 mapping/scale 控制的线样式，端点、曲率和 arrow 结构只读；有结构化来源时箭头作为父线对象拥有的显式只读 child 输出，不生成猜测的 text relation。SVG 仅对 geom 实际可绘制行按真实 panel 绘制顺序领取完整 body/arrow 序列，统一改色后 `r.layer.18` 的 4 个图元和 `r.layer.19` 的 3 个图元仍保持可选择；候选不足或顺序不完整继续 fail-closed。非法结构、mapped override 和 mixed batch 零持久化，保存刷新、撤销重做、导出后继续编辑与快照恢复均有隔离证据 |
| R-WP5 scale/guide/facet/layout | 本地候选 | 离散 scale 保留 label/limits/breaks/drop/NA/guide 语义，连续 color/fill scale 与 mappable/colorbar 分开关联；字符型 `colourbar/colorbar`、隐藏恢复、多 guide 独立标题及标题 SVG 样式已收敛，显式 scale 的图例条目改名不再因重建 scale 导致身份漂移。旧 continuous absolute-index alias 仅兼容已知旧字段，伪造稳定身份拒绝；R 跨 Figure relation 要求共享稳定字段且 legacy score fallback 不得绕过冲突。facet 独立物理 bounds 明确只读。完整 R renderer 124/124、隔离 API 3/3、浏览器 6/6、R 语义黄金样例 14/14、identity v2 compatibility、TypeScript 216 项、lint 通过，最终独立复审 0 HIGH/MEDIUM。一次 Windows R `0xC0000005` 启动崩溃仅作运行时偶发记录，隔离重跑完整通过，不作为放宽门禁的理由 |
| R-WP6 文本/annotation/复杂坐标 | 本地候选 | `ggplot_text_data/annotation/stat` 身份分离，stat 只读；文本、字体、对齐、旋转、lineheight、plotmath/多行和 mapped-label fill 保持通过。Cartesian/flip/log/panel 内 polar 位置可逆，CoordSf、第三方 coord 和不可逆位置 shadow/readonly。R `currentProps.position` 与 renderer acknowledgement 对齐；后端拒绝时前端保留待确认拖动和视觉位置、零持久化、禁止重复提交，成功后才清空并形成一次历史。R renderer 125 场景、capability matrix 2/2、R semantic 19/19、drag 扩展失败/重试、组件容器 42/42、identity v2、历史/导出/快照恢复、1720 项单测、lint/build/diff-check 通过；未推送、未部署 |
| R-WP7 网络图/路径图/SEM | 本地候选 | 显式 `scifigure-sem-v1` marker 输出七类 `diagram_*` role 和完整 node/edge relation；未标记 lookalike 不升级。GID 的四个身份字段均使用 Base64URL，ASCII `a_` 与非 ASCII `b_` 命名空间分离，字段边界无歧义，重复完整 identity 在 manifest 构建期拒绝；同 marker 多行保留为单个有序 path。科学文本、系数、p 值、拟合指标和拓扑只读，非法 mixed batch renderer/API 原子拒绝且 project/session/history/cache/export anchor/snapshot 零持久化。`clip="off"` 时仅在可证明 panel 范围内按图层顺序绑定，范围不可信则精确唯一或 fail-closed。renderer 10/10、R capability matrix、旧动态批次/fingerprint 4/4、隔离 API 和 Chromium live SVG 正确几何选择均通过；未推送、未部署 |
| R-WP8 扩展包与 base R Shadow 边界 | 本地候选 | 未固定的 ggrepel/ggnewscale/sf/ggraph/igraph/tidygraph/semPlot/DiagrammeR 不虚报可编辑；CoordSf 不可逆位置和 mixed batch setter 前原子拒绝，base R 保持 preview/export only。缺包诊断不泄露路径；R-WP8 7/7、隔离 API、能力矩阵、旧身份、安全和浏览器门禁通过 |
| R-WP9 用户链路、性能与可观测性 | 本地候选 | `test:r-wp9-workflow` 覆盖双 CSV multipart、精确 `uploaded_file_paths`、一次 revision、刷新、四格式导出、导出后编辑和快照恢复。renderer 输出七个新增真实计时段，cache authority schema v2 纳入 source/image/runtime/package contract；导出返回 render/convert/persist/total。`test:r-wp9-performance-persistence` 证明超大直接渲染、patch、导出均返回 413 且 session/revision/history/preview/cache/asset/snapshot/file 零变化；`test:r-wp9-timeout-cleanup` 证明请求创建的 Rscript job、临时目录和容器无残留 |
| R-WP10 默认启用与本地发布门禁 | 本地候选 | 默认 V2 resolver 17 文件/248 项、旧 R identity v2 compatibility、安全预检、R-WP9 三条链路、候选 Docker 镜像 sandbox、用户隔离、性能、缓存、lint、build、diff-check 和 data audit 通过；共享路由下 Python cross-Figure 18/18、patch rejection、semantic workflow 和 export matrix 通过；独立审查 APPROVE/CLEAR、0 HIGH/MEDIUM。旧 adapter 与无版本 identity 读取继续保留；未推送、未部署，生产不可变构建、小范围账号和人工视觉回归仍是发布阻断项 |
| patch/全渲染事务保护 | 通过 | standalone patch、standalone full render 与项目 full render 均由服务端按返回 manifest/renderer 决定；拒绝批次不改变 revision、session、项目脚本、Figure、history、cache 或导出锚点 |
| 导出快照恢复事务 | 通过 | renderer dry-run、事务内并发状态复核、v1 兼容、不安全多 Figure 拒绝和全项目导出先全量预检后持久化均有专项回归 |
| 导出文件事务 | 通过 | DB 创建失败清理新文件；删除失败恢复暂存文件；成功后数据库与文件状态一致 |
| 项目 PUT 保存预检 | 通过 | editLog/history 先预检；revision/hash CAS 阻止旧保存覆盖；GET/PUT 统一旧项目恢复源；排队保存与新 Draft 不丢失 |
| 跨 Figure 目标保护 | 通过 | 无授权显式对象不 fanout；目标 mode 重算；同分语义候选跳过；组件语义组显式授权 fanout 保持 |
| 跨 Figure 浏览器回归 | 18/18 通过 | 字体、内容限制、组件组 fanout、图例隔离、五个 WP6 家族 role 分离、pie/向量场关系映射和部分失败 Draft 保留 |
| 扩展拖拽 | 10/10 通过 | 真实 Ctrl 三选、累计确认、取消、只读命中、annotation 和 R native 保护 |
| Python cache | 通过 | 首次 miss、同语义重复 hit、值变化 miss；只信任本进程已确认 key |
| 生产构建 | 通过 | 保留既有 bundle 体积和 CJS `import.meta` 警告 |
| 数据完整性 | 0 个错误 | 25 用户、128 项目、286 项目文件、112 导出资产；23 条历史测试账号警告未删除；本轮隔离测试未写真实 data |
| 展厅/MCP/脚本拖放候选 | 定向门禁通过 | 展厅单元 5/5、展厅隔离浏览器、MCP origin/产物安全 4/4、MCP 真实 UI、新建项目脚本区/数据区和全工作区 `.py/.R` 拖放、TypeScript 均通过；预览只使用固定模拟数据 |
| 编辑器顶部工具栏可达性 | 组件浏览器 41/41 | 横向内容超过宽度时不得使用产生左侧负溢出的 `justify-end`；固定标签不得覆盖“拖拽微调”等主操作，窄宽度必须向右滚动且保持真实鼠标可点击 |

本轮共享编辑、R、跨 Figure、历史、导出、组合、安全和隔离 smoke 均使用随机 `127.0.0.1` 端口和临时数据库；另对隔离 `3100` 执行 Python 真实 Chromium 用户链路。renderer sandbox 使用独立 `scifigure-renderer:rwp10-candidate` 镜像，只创建并清理本轮临时容器；未停止已有容器、未覆盖 `latest`、未修改 WSL，也未访问 `3000` 或线上服务。

当前结论仅为本地候选验证通过，不等同于生产发布验证。Cartopy 和 brokenaxes 因固定运行时未安装仍为 skipped/不承诺支持；生产不可变构建、线上小账号和生产容器视觉验收尚未执行，部署前必须另行完成。

先前独立代码审查发现的 standalone mode 权威、保存 CAS 绕过、排队保存旧闭包、旧项目 GET/PUT 恢复源不一致，以及 standalone/project full render 在 renderer 拒绝 editLog 后仍可能写入的问题均已修复。当前保存与全渲染入口同时执行可信 manifest 预检、renderer warning 检查和必要的 revision/hash CAS；项目脚本与 Figure/session 在同一事务提交。新增 full render mixed batch、旧 contour、项目 history、R 共享路由、组件容器、扩展拖拽、缓存、导出文件事务、用户隔离和 renderer 沙箱回归均通过。WP5、WP9 和 WP10 已达到当前计划范围的本地候选条件，最终独立复审为 APPROVE、0 HIGH/MEDIUM；但这不构成任意第三方 Matplotlib artist、全部真实科研脚本或性能 SLO 的支持承诺。旧 compiler、palette legacy resolution 和 cross-Figure score mapper 在一个稳定发布周期内继续作为显式适配器保留；必须先形成固定候选提交，才能作为不可变部署输入。

2026-07-21 的兼容性审查进一步确认：任何“已知旧 editLog”例外都必须同时满足数据库中已持久化的值和身份，不能让客户端用相同值替换更弱或伪造的身份。空文本/隐藏对象和旧轴字体兼容均执行完整 `stableKey/fingerprintVersion/fingerprint/identity` 同一性核验；拒绝请求由数据库快照断言证明不会写 project、session、Figure、history 或 preview。文本输入以原始 manifest 作为已提交事实，以项目 Draft 作为待应用事实，不能用 Draft proxy 判断“已经应用”。

默认启用采用逐域回退，而不是一个总开关：`VITE_SCIFIGURE_GENERAL_TARGET_RESOLVER_V2`、`VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2`、`VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2`、`VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2` 和 `VITE_SCIFIGURE_CROSS_FIGURE_IDENTITY_V2` 可分别设为 `0`。这些 `VITE_*` 值在前端构建时固化，逐域回退需要从同一代码提交重建并部署新的不可变 release；紧急回退直接切回上一整版。旧 manifest 兼容由 `VITE_SCIFIGURE_TARGET_RESOLVER_LEGACY_ADAPTER` 控制；弱跨 Figure score mapper 默认关闭，只能通过 `VITE_SCIFIGURE_CROSS_FIGURE_LEGACY_SCORE_ADAPTER=1` 显式启用。

RightSidebar 的 Figure/编辑上下文必须来自 `figSession`、`activeFigureId`、选择和 Draft props，再由 `normalizeFigureModel()` 生成当前模型；组件不得直接读取 `sessionStorage` 决定当前 Figure 或 Draft。2026-07-20 静态检查确认 `src/components/RightSidebar.tsx` 不含 `sessionStorage`，其中保留的 `localStorage` 仅用于用户预设。浏览器 fixture 可以在启动前写入存储以构造隔离状态，但这不构成组件状态读取路径的例外，也不能代替真实控件或 props 驱动的回归。

第一轮隔离浏览器基线补充结果：

| 流程 | 结果 | 结论 |
|---|---:|---|
| 编辑主流程 | PASS | Draft、应用、导出准备和运行时错误检查通过 |
| 语义编辑中心 | PASS | 语义分组、配色和组件编辑通过 |
| 坐标轴样式 | 8/8 PASS | frame、tick line、grid 隔离、数字自动暂存和字体格式刷通过 |
| 扩展拖拽 | 10/10 PASS | Python 多目标、取消、不支持目标、annotation 和 R native 坐标保护通过 |

`D4-r-native-protection` 已改为不依赖伪造项目 ID 的单图 R fixture；测试继续证明 native 坐标文本不会生成错误位置 patch，而不是跳过该能力边界。

2026-07-19 06:19:06 的 contour/拖拽/导出补充证据：

```text
contour/contourf 使用专用父对象；levels/X/Y/Z 保持只读
contour child collection 标记 parentOwned，现代批量面板不再产生子层 editLog
cmap/vmin/vmax 只在属性声明的 scope 内应用，未声明 cross_figure 时保守留在当前对象
明确命中的只读 SVG 图元不会吸附到附近文本；Ctrl/Shift 多选不会被后续单选回调覆盖
旧 identity-bearing contour child editLog 可加载、保存、导出和快照恢复
contour child 点击在普通和拖拽模式下都重定向到父对象，modifier 可保留两个父对象
其他 Figure 的 stale edit 会阻断项目级代码 patch；全项目导出在全部目标通过前零资产写入
```

2026-07-19 16:22:04 的 `hist/stairs/step` 与保存并发补充证据：

```text
histogram/stairs/step 使用专用 role；普通 bar、手工 StepPatch 和 drawstyle line 不误分类
histogram child patch 标记 parentOwned，点击和批量编辑重定向到父系列
结构参数只读；拒绝请求不增加 revision，不写 session/history/cache/export/snapshot
项目保存要求 baseRevision + baseEditLogHash，旧请求不能覆盖新 editLog/history
语义相同的旧项目 payload 可保存名称/spec，但 Figure 状态保持原样
排队保存等待最新 React 状态；旧响应不清除请求期间产生的新 Draft
保存刷新、撤销重做、跨 Figure、四格式导出和导出快照恢复一致
```

版本边界：开发、预发布和生产应使用同一套固定 renderer 镜像及精确依赖。上一生产/验证环境只在升级窗口内作为旧项目迁移门禁，不是长期支持矩阵；历史 manifest/editLog 兼容必须由数据协议测试证明，不能靠同时运行多套 renderer 规避。

2026-07-19 19:51:21 的 `pie/wedge` 补充证据：

```text
Axes.pie 扇区、类别标签、autopct 数值标签和关联 legend marker 使用 pieId + sliceIndex 建立双向关系
手工 Wedge 与 pie slice 分开分类；普通 patch、bar 和普通 legend marker 不被误归类
选中单个扇区跨 Figure 只映射对应扇区及其唯一关联 marker，不扩散到同图其他扇区
不同 pieId、同分重复候选和缺失关系元数据均跳过，不按数组顺序猜测
values/角度/圆心/半径/width/explode 等结构参数只读，拒绝操作不产生 Draft 或持久化副作用
Python 语义工作流、跨 Figure 18/18、26 项定向单测、Matplotlib 3.8.4 定向门禁和生产构建通过
独立 5.5 high 审查 APPROVE，0 HIGH、0 MEDIUM；唯一 LOW 已 fail-closed 修复并回归
```

2026-07-19 21:02:01 的 `quiver/streamplot` 补充证据：

```text
quiver 使用专用 kind=quiver、role=quiver_field，同时保留历史 collection.* GID/stableKey
streamplot 使用 container.streamplot.* 父对象；内部 line collection 和 arrow patch parentOwned/readonly
普通 LineCollection、FancyArrowPatch、scatter 和 patch 不会误分类为向量场
视觉颜色、透明度、线宽、显隐和层级走 backend replay；向量、尺度、箭头几何、密度、起点和积分方向只读
唯一向量场标签可绑定图例 marker；quiver face/edge 与 streamplot line 样式按父对象关系联动
跨 Figure 必须匹配 quiverId/streamplotId；关系缺失、冲突或重复候选 fail-closed
结构参数拒绝不增加 revision，不写 session/history/cache/export anchor/snapshot
Vitest 1035/1035、complex artist 22/22、API、真实浏览器、真实控件跨 Figure、组件 41/41、跨 Figure 18/18、R 5/5、Matplotlib 3.8.4 兼容 5/5、lint/build/diff-check 均通过
独立 gpt-5.5 high 审查 APPROVE，0 HIGH/MEDIUM/LOW
```

2026-07-19 22:46:07 的网络图/路径图/SEM 补充证据：

```text
只接受 _scifigure_semantic_gid(...) 显式关系，不按颜色、形状或标签猜测图示身份
diagram_node/edge/arrow/node_label/coefficient_label/fit_annotation/group 使用独立 role 和组件分组
节点、边、箭头和文字样式走 backend replay；路径系数、p 值、显著性、拟合指标、方向和拓扑只读
跨 Figure 需要完整且唯一的 diagram relation；关系不同、缺失或重复时 fail-closed
renderer、项目 patch 预检与导出快照 dry-run 比较完整 diagram relation signature；端点变化或部分 identity 不回填
scifigure-sem-v1 marker 是用户声明协议，不是认证；合法手写可识别，畸形 marker 保持普通图元
普通 scatter、line、FancyArrowPatch 和 text 保持通用分类，不进入图示组
受保护图示文字的初始 manifest 与重放身份统一使用真实文本标签，完整 v2 身份下字体修改可重放
真实浏览器覆盖 Draft、应用、保存刷新、撤销重做、位置、SVG 导出、后续编辑和快照恢复
Vitest 145 文件、1078/1078；complex artist 26/26、结构身份 7/7、R renderer 31/31；API、浏览器、patch 拒绝、快照恢复、跨 Figure、组合项目、R 5/5、R 风险预检、lint/build/diff-check 均通过
数据审计保持 25 用户、121 项目、263 项目文件、101 导出资产、0 错误
```

2026-07-18 21:03:51 的 WP3/WP4 补充证据：

```text
统一 propertyPatchMode helper 已接入 EditingIntent、target resolver、palette、右侧编辑中心和左侧图层树
项目 PUT 的 editLog/history 保存先预检后单事务写入
显式跨 Figure 对象默认一对一映射；组件语义组通过 crossFigure: allow 保留有意 fanout
现代 manifest 缺少 capability 属性时前端不再生成可应用 patch
```

## 3. 不可触碰边界

### 3.1 用户数据

- 不得删除、清空、重命名、迁移或覆盖真实 `data/`。
- 不得用 fixture、临时账号或测试项目替换真实项目。
- 数据库、项目、Figure、session、上传文件、历史或导出资产相关修改，前后必须运行只读 `npm run data:audit`。
- 恢复脚本默认只能 dry-run；带 `--apply` 的恢复或迁移需要单独授权和备份。
- 任何用户数据数量、项目归属、文件哈希或引用完整性变化都阻断继续执行。

### 3.2 本机服务

- 自动化测试不得使用现有 `http://localhost:3000`。
- 自动化测试必须通过 `scripts/testing/run_with_isolated_server.mjs` 使用临时端口和临时 `SCIFIGURE_DATA_DIR`。
- 不得停止或修改本机 3000、Docker Desktop、WSL 或 sub2api。
- 测试结束后必须确认临时监听端口和临时服务已经退出。

### 3.3 代码和版本

- 不得整线合并旧 `unified-editing`、`security`、`admin-console` 或其他历史工作树。
- 不得用旧版文件覆盖当前主线文件。
- 不得删除现有功能来让新测试通过。
- 不得执行破坏性 Git 历史重写，除非用户单独授权。
- 未经明确要求不得推送或部署。

## 4. 平台功能基线

### 4.1 访问、认证和导航

| 必须保持的行为 | 回归入口 |
|---|---|
| 未登录访问优先进入宣传页；登录或注册后进入平台 | `test:public-auth-smoke` |
| 帮助页可从公开和登录状态访问，内容面向用户而不是开发者 | `test:help-center-smoke` |
| 项目、数据、导出、组合和设置导航保持当前返回关系 | `test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 首页仪表盘、项目列表、模板、数据文件和设置页面保持可进入、可返回且不丢登录状态 | `test:workspace-visual-smoke`、`test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 账号级资产库不能错误显示“未登录”或只查询当前项目 | `test:export-library-global-smoke` |
| 用户只能读取自己的项目、文件、Figure 和导出资产 | `test:user-isolation` |

### 4.2 项目创建、脚本和数据文件

| 必须保持的行为 | 回归入口 |
|---|---|
| 新建项目使用“脚本优先”，先识别脚本引用的数据文件名 | `test:navigation-reconfigure-smoke` |
| 未发现固定文件名时只提示，不限制用户上传其他表 | 项目创建浏览器回归 |
| 首屏脚本上传区支持点击和真实拖放；文案声明支持拖入时必须存在对应 drop 行为 | `test:behavior-smoke`、`test:drag-extended-smoke` |
| 一个项目可上传多张 CSV/Excel，脚本必须按明确文件名读取 | 组合项目/API fixture |
| 重新配置保留 projectId、已有文件、Figure 历史和导出资产 | `test:navigation-reconfigure-smoke` |
| `ProjectCreatePage`、脚本先行导入和 `ProjectReconfigurePage` 保持当前流程；旧 `DataImportPage` 只保留兼容入口，不重新成为默认主流程 | `test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 代码面板支持修改、同步渲染、撤回和代码历史 | `test:code-history-smoke` |

### 4.3 Python/R 渲染与协议

| 必须保持的行为 | 回归入口 |
|---|---|
| Python Matplotlib 与 R ggplot2 保持两套 renderer、一个前端协议 | `test:capability-matrix`、Python/R renderer tests |
| renderer manifest 是对象事实来源，前端不得根据 SVG 距离猜测高风险关系 | introspection/target resolver tests |
| 旧 manifest 缺少 `identity/propertyCapabilities` 时继续可读 | StandardFigureModel tests |
| `gid/editable/currentProps` 和现有 patch wire format继续兼容 | 单元测试和 API smoke |
| unsupported/ambiguous 对象必须跳过并说明，不得伪装可编辑 | capability/target resolver tests |
| 共享前端协议修改必须同时验证 Python 和 R | Python/R 双 renderer gate |
| Monaco 代码编辑器继续使用同源静态资源，不因前端升级恢复为外部 CDN 依赖 | 生产构建、仓库边界检查；当前缺专项 smoke |

### 4.4 图元选择和图层结构

| 必须保持的行为 | 回归入口 |
|---|---|
| 拖拽关闭时，画布单击可精确选择对象并打开属性 | `test:behavior-smoke` |
| 左侧图层树与画布选择同步，搜索使用完整对象集 | `test:large-figure-ui-smoke` |
| Ctrl/Cmd 可取消多选中的单个对象，框选不能丢失目标 | 组件/拖拽 smoke |
| 画布/图层选择后所有编辑中心自动跟随所属子图；跨子图选择回退全部子图；右侧中心内部整组选中不得覆盖用户显式范围 | `test:subplot-scope-follow` |
| figure-level legend、共享 colorbar 和 twin axes 不得错误归入普通子图 | capability/component tests |
| 重叠或歧义对象不得自动选择“最像”的一个 | target resolver tests |

### 4.5 五个编辑中心

#### 属性编辑

- 单对象修改不得扩大到同角色的其他对象。
- 文本、axis label、tick label、tick line、spine、legend 和 colorbar 必须保持职责分离。
- 控件只能在 renderer 声明支持时可编辑；只读状态必须解释原因。

#### 布局中心

- “仅调整上下行间距”只能修改相关 `subplot/colorbar.bottom`。
- 整体网格重排和物理尺寸重建必须继续明确说明会重算宽高或画布。
- 子图交换只交换位置，不交换数据、样式、历史身份。
- 色条对齐继续按真实 owner subplot 和联合边界工作。

#### 组件中心

- line、point、bar、errorbar、stem、boxplot、violin、annotation、legend、grid、spine、heatmap 和 colorbar 继续分组。
- 容器存在时不得重复修改其 children。
- 整组修改必须覆盖全部支持目标；部分支持时明确显示跳过数量。
- 网格显隐与图例边框继续进入 Draft，并在应用时后端重绘。

#### 配色中心

- 同色不同语义组保持隔离。
- 数据列或向量颜色不得把整个 collection 错染为一种颜色。
- palette 常量写回与精确对象 fallback 保持同一批次。
- 作用范围、已绑定/未绑定状态和重渲染后的再次选择能力保持一致。
- 单子图范围下的颜色输入和科研配色预设只能生成该子图对象补丁，不得出现全局 `code_patch` 或其他子图 GID；只有显式“全部子图”允许同步代码常量。

#### 字体中心

- 字体家族、字号、字重、字形和颜色保持可用。
- 组件中心和坐标轴系统的字体投影不得变成只读或无效控件。
- 格式刷只复制字体样式，不复制文本、位置或旋转。
- Times New Roman 等字体必须以 renderer 实际字体为准，不能只回显选择值。

对应入口：`test:semantic-smoke`、`test:axis-style-semantics-smoke`、`test:component-container-smoke`、`test:subplot-scope-follow`。

### 4.6 Draft、应用和渲染调度

- 有效控件输入后自动进入 Draft，不要求 Enter 或失焦。
- 同一 `gid/prop` 保持 last-write-wins。
- 切换编辑中心不得清空或隐藏已有 Draft。
- “应用当前图”默认只重绘当前 Figure。
- local patch 只能用于可精确预览且可直接持久化的属性。
- 创建、删除或重建 renderer artist 的属性必须使用 backend patch。
- 每个 Figure 保持独立 `requestId/baseRevision`；旧响应不得覆盖新结果。
- 部分失败只清除成功目标草稿，失败目标保留并可重试。
- 一次应用形成一个历史动作，不能按底层 patch 数拆成多步。

### 4.7 拖拽和位置

- 拖拽开启后无需按空格。
- 拖动时对象在目标位置实时显示，不只显示选框。
- 松手只累计最终位置，不连续调用 renderer。
- 确认后进入一次 Draft/历史；取消恢复全部目标。
- 多对象累计位移保持各自独立基准。
- 文本、legend container 和 annotation anchor 使用各自坐标契约。
- tick label 等不稳定子对象不得开放独立位置重放。
- callable、offset points 和混合 transform 等不可证明坐标继续拒绝写回。

对应入口：`test:drag-extended-smoke`、`test:behavior-smoke`。

### 4.8 多 Figure、跨 Figure 和组合布局

- 每个 Figure 保留独立 script、manifest、editLog、revision、history 和选择状态。
- 当前 Figure 修改不得串到其他 Figure。
- 内容、位置和布局默认禁止跨 Figure。
- 样式跨图必须唯一匹配；歧义跳过并报告。
- 切换 Figure 时只挂载活动 Figure，其他 Figure 状态不得丢失。
- 组合项目来源排序、物理 axes 尺寸、复制数据文件和提示词保持一致。
- 组合提示词必须使用源 Figure 当前已编辑脚本，而不是初始脚本。

对应入口：`test:multi-figure-ui-state-smoke`、`test:cross-figure-smoke`、`test:cross-figure-concurrency`、`test:composition-code-project`、`test:composition-selector-ui-smoke`、`test:composer-smoke`、`test:composer-stale-smoke`。

### 4.9 历史、保存、导出和恢复

- 保存、刷新、退出重进后恢复同一 Figure revision、editLog、history 和视觉结果。
- 过期自动保存、同 revision 缺 hash 和 hash 漂移请求必须 409 且零写入；旧项目无状态保存不得被误伤。
- 保存请求期间产生的新 Draft 不得被旧响应清除；排队保存必须基于最新提交后的状态。
- 撤销/重做恢复 SVG、manifest、editLog 和 revision 的一致状态。
- 导出必须使用最后一次成功预览状态，不得退回初始脚本尺寸或样式。
- SVG、PNG、PDF、TIFF 和子图导出保持格式、DPI、方向和尺寸一致。
- 导出资产与不可变编辑快照原子关联。
- 恢复导出状态前校验所有权、Figure 结构和数据哈希，并先保存当前检查点。
- 旧资产无快照时保持可下载，但不得虚报可恢复。
- 账号级历史资产、当前项目筛选和物理文件完整性保持一致。

对应入口：`test:project-history-persistence`、`test:export-matrix-smoke`、`test:export-snapshot-db`、`test:export-snapshot-restore`、`test:export-snapshot-restore-ui`、`test:export-library-global-smoke`。

### 4.10 安全、管理员和运行边界

- 认证、所有权、路径边界和 renderer 沙箱不得因功能或性能优化被绕过。
- Python/R 用户代码不得访问主数据库、`.env`、项目根目录或外网。
- 正常科研脚本必须与恶意输入同时测试，不能靠扩大黑名单误伤正常功能。
- 管理员 API 保持独立授权与审计；普通用户不能通过隐藏路由访问。
- 生产密钥、TLS、防火墙、备份恢复等部署事项不以本地测试代替。

对应入口：`test:security-baseline`、`test:user-isolation`、`test:auth-refresh`、`test:admin-authorization`、`test:r-security-precheck`、`test:renderer-sandbox`、`security:repo-boundary`。

### 4.11 页面工具与辅助视图

- `HomeDashboard`、`TemplatesPage`、`DataFilesPage` 和 `SettingsPage` 是现有产品页面，不得在编辑链路升级中被隐藏、改回旧入口或破坏返回关系。
- `ChartPreview` 的选择、拖拽和 Draft 预览，`ManifestViewer` 的图元搜索与能力诊断，均须继续读取当前 Figure，不能串到其他 Figure。
- `WordA4Preview` 保持当前真实尺寸、方向和导出状态投影；编辑器预览、Word/A4 预览与实际导出不得使用三套不同状态。
- `ExportLibraryPage` 保持账号级资产、项目筛选、下载和导出时状态恢复入口。
- `ComposerPage` 与组合项目选择器保持来源排序、物理 axes 尺寸、当前编辑脚本和 stale source 检测。
- 帮助中心的快速上手、科研模板和 AI 提示词面向最终用户；开发者安全细节不得直接暴露为攻击说明。

对应入口：`test:workspace-visual-smoke`、`test:help-center-smoke`、`test:export-matrix-smoke`、`test:export-library-global-smoke`、`test:export-snapshot-restore-ui`、`test:composer-smoke`、`test:composer-stale-smoke`、`test:composition-selector-ui-smoke`。

当前直接证据缺口：Word/A4 物理尺寸数学、帮助页模板数量与复制文本、Monaco 同源加载和工作区视觉 token 尚无各自独立命名的专项 smoke；在补齐前只能引用间接回归，不能宣称专项覆盖已经完成。

## 5. Python 当前不可退化能力

Python renderer 当前已经识别并提供稳定编辑入口的基础对象包括：

```text
Figure / Subplot / Axes
Text / axis label / tick label / tick style
Spine / axes frame / grid
Line / Patch / Collection
Bar / Errorbar / Stem / Boxplot / Violin container
Fill-between / Contour / Histogram / Stairs / Step / Pie / Wedge 专用语义
Legend container / title / text / marker
Heatmap / Colorbar
Annotation text / arrow / anchor
Multi-Figure / twin/shared axes relationship
```

任何 Python 能力增强必须保持：

1. 现有对象数量不因新增 adapter 无故减少。
2. 现有 GID 和旧 editLog 继续可重放。
3. 容器新增关系不能让 children 重复进入批量修改。
4. 同色不同组、向量颜色和数据驱动颜色继续保持隔离。
5. legend、colorbar、annotation 和 twin axes 的关系继续双向一致。
6. 复杂对象若不能稳定写回，必须降级为 readonly/unsupported，而不是错误编辑。
7. Python 增强不得因共享协议变化降低 R 的真实能力或放宽 R 的 unsupported 边界。

当前尚不能宣称完整覆盖的范围包括：

```text
结构变化后的对象身份迁移
任意第三方 Matplotlib Artist
3D、地图投影、broken/inset/secondary axes 的完整位置编辑
stackplot 及未显式声明关系的第三方复杂语义容器
超大数据图的交互性能
全部真实科研项目和全部视觉截图基线
```

这些是后续增强项，不允许为了“完整”宣传而伪装为已支持。

## 6. 回归测试分级与证据复用

验证按改动影响范围分层，避免每写一处代码就重复执行全部历史门禁：

1. 开发循环：只运行改动文件的单元测试，并追加一条直接相关的真实用户工作流。
2. 工作包收敛：运行共享路径门禁，例如 renderer、manifest、target resolver、Draft、跨 Figure 或导出中实际受影响的部分。
3. 阶段或发布候选：集中运行一次完整回归、安全门禁、构建和数据审计。
4. 每条证据记录代码基线 SHA、未提交差异范围、runtime/依赖版本、命令、时间与结果。
5. 上下文切换不使证据自动失效。只有相关文件、依赖版本、基线 SHA 或测试前置条件变化时才重跑。

当前工作包未提交时使用“父 commit SHA + 明确工作包差异”作为候选键；形成提交后，后续工作包直接使用新 commit SHA。不得把较早全量结果冒充为最终改动的新鲜证据，必须同时列出最终改动的 changed-path gate。

### 6.1 `pie/wedge` 证据台账

| 代码键 | Runtime / 版本 | 命令或证据 | 时间 | 结果 |
|---|---|---|---|---|
| `986767c + pie/wedge worktree` | 本地 renderer / Matplotlib 3.7.2 基线 | `npm run test:python-semantic-workflow` | 2026-07-19 | PASS，含导出与快照恢复 |
| `986767c + pie/wedge worktree` | Chromium 隔离服务 | `npm run test:cross-figure-smoke` | 2026-07-19 19:49 +08:00 | 18/18 PASS |
| `986767c + pie/wedge worktree` | Vitest | `npm test -- src/utils/semanticPatchMapping.test.ts` | 2026-07-19 19:49 +08:00 | 4 文件 / 26 项 PASS |
| `986767c + pie/wedge worktree` | Python 3.12 / Matplotlib 3.8.4 临时容器 | 三项 pie identity + Python capability matrix | 2026-07-19 | 4/4 PASS；wheel SHA-256 已核对 |
| `986767c + pie/wedge worktree` | TypeScript / Vite | `npm run lint`、`npm run build`、`git diff --check` | 2026-07-19 | PASS；仅既有 bundle/CJS 警告 |
| `986767c + pie/wedge worktree` | 独立 gpt-5.5 high | 最终代码审查 | 2026-07-19 | APPROVE；0 HIGH、0 MEDIUM；唯一 LOW 已修复并回归 |

pie/wedge 工作包当时的完整 Vitest 基线为 1006/1006；其最终映射改动由上表 26 项单元测试和 18/18 真实跨 Figure 工作流覆盖。随后 quiver/streamplot 工作包已重新运行完整 Vitest 1035/1035，最新证据见下一节；后续仍按 changed-path gate 加阶段候选完整回归的方式复用证据，不在每个对象家族内机械重复无关门禁。

### 6.2 `quiver/streamplot` 证据台账

| 代码键 | Runtime / 版本 | 命令或证据 | 时间 | 结果 |
|---|---|---|---|---|
| `3c448f3 + vector-field worktree` | 本地 Python 3.8.19 / Matplotlib 3.7.2 | capability matrix、complex artist coverage、完整 Python 语义工作流 | 2026-07-19 | PASS；complex artist 22/22 |
| `3c448f3 + vector-field worktree` | 隔离 API / 临时数据目录 | `python_vector_field_persistence_smoke.mjs`、`test:patch-rejection-persistence` | 2026-07-19 | PASS；结构参数拒绝零持久化 |
| `3c448f3 + vector-field worktree` | Chromium 隔离服务 | 向量场语义工作流与真实控件跨 Figure 工作流 | 2026-07-19 | PASS；目标关系不匹配时不扩散 |
| `3c448f3 + vector-field worktree` | Vitest | `npm test` | 2026-07-19 | 144 文件、1035/1035 PASS |
| `3c448f3 + vector-field worktree` | Python 3.12 / Matplotlib 3.8.4 临时容器 | 向量场定向兼容与 capability matrix | 2026-07-19 | 5/5 PASS；固定 wheel SHA-256 已核对 |
| `3c448f3 + vector-field worktree` | TypeScript / Vite | `npm run lint`、`npm run build`、`git diff --check` | 2026-07-19 | PASS；仅既有 bundle/CJS 警告 |
| `3c448f3 + vector-field worktree` | 独立 gpt-5.5 high | 最终代码审查 | 2026-07-19 | APPROVE；0 HIGH/MEDIUM/LOW |

### 6.3 网络图/路径图/SEM 显式语义证据台账

| 代码键 | Runtime / 版本 | 命令或证据 | 时间 | 结果 |
|---|---|---|---|---|
| `b20b103` | 本地既有 Python renderer | complex artist、结构身份漂移 | 2026-07-19 22:26 +08:00 | 26/26 + 7/7 PASS |
| `b20b103` | 隔离 API / 临时数据目录 | `python_diagram_semantics_persistence_smoke.mjs` | 2026-07-19 22:43 +08:00 | PASS；合法样式、科学结构拒绝、拓扑漂移、关系缺失、混合批次与篡改快照零持久化 |
| `b20b103` | Chromium 隔离服务 | `python_diagram_semantics_smoke.mjs`、`python_diagram_cross_figure_smoke.mjs` | 2026-07-19 22:49 +08:00 | PASS；完整用户链路和三类关系 fail-closed 场景通过 |
| 工作区 R-WP7 本地候选 | R renderer / 隔离 API / Chromium | `test_r_wp7_diagram_semantics.py`、`r_wp7_diagram_semantics_persistence_smoke.mjs`、`r_wp7_diagram_semantics_smoke.mjs` | 2026-07-26 18:19 +08:00 | PASS；完整 R diagram identity、ASCII/Unicode 命名空间与字段边界隔离、重复 GID 拒绝、多顶点 path、同样式 decoy 正确 owner、科学字段只读、合法重放和 mixed batch 零持久化通过 |
| `b20b103` | Vitest | `npm test` | 2026-07-19 22:50 +08:00 | 145 文件、1078/1078 PASS |
| `b20b103` | 共享协议与组合链路 | R renderer 31/31、R semantic 5/5、R 风险预检、组合代码项目 | 2026-07-19 22:27 +08:00 | PASS |
| `b20b103` | TypeScript / Vite | `npm run lint`、`npm run build`、`git diff --check` | 2026-07-19 22:50 +08:00 | PASS；仅既有 bundle/CJS 警告 |
| `b20b103` | 独立 gpt-5.5 high | 关系身份修复最终复审 | 2026-07-19 22:47 +08:00 | APPROVE；0 HIGH/MEDIUM |

版本记录按两个维度维护：本机 renderer resolver 当前回退到 Python 3.8.19 / Matplotlib 3.7.2；3.8.4 是 Python 3.12 临时容器中的 Matplotlib 兼容门禁。此前“网页 3.11.0”不能作为 Matplotlib 版本证据；网页 Python runtime 只有在运行时命令或不可变镜像元数据证明后才记录。本工作包未修改 `requirements.txt`、Dockerfile 或任何运行服务。

### Gate A：任何代码修改

```text
npm run lint
改动文件对应的定向单元测试
一条直接相关的真实工作流
git diff --check
```

### Gate B：Python renderer 或图元协议修改

```text
python -m unittest tests.test_introspection
npm run test:capability-matrix
npm run test:component-kind-matrix
npm run test:semantic-smoke
npm run test:component-container-smoke
npm run test:axis-style-semantics-smoke
npm run test:python-semantic-workflow
npm run test:patch-rejection-persistence
npm run test:cache-smoke
npm run build
```

共享 `manifest/identity/propertyCapabilities/EditingIntent/target resolver` 修改还必须追加 R renderer、R semantic smoke 和跨 Figure smoke。

若修改触及共享 patch、session、history、export metadata 或恢复协议，还必须追加：

```text
npm run test:r-semantic-smoke
npm run test:r-security-precheck
npm run test:cross-figure-smoke
npm run test:project-history-persistence
npm run test:export-matrix-smoke
npm run test:composition-code-project
```

### Gate C：Draft、拖拽、历史、布局或导出修改

按影响范围至少追加：

```text
npm run test:behavior-smoke
npm run test:multisubplot-smoke
npm run test:subplot-scope-follow
npm run test:drag-extended-smoke
npm run test:multi-figure-ui-state-smoke
npm run test:cross-figure-smoke
npm run test:code-history-smoke
npm run test:export-matrix-smoke
npm run test:export-snapshot-restore
npm run test:export-snapshot-restore-ui
npm run test:export-library-global-smoke
npm run test:composer-smoke
npm run test:composer-stale-smoke
npm run test:composition-selector-ui-smoke
npm run test:navigation-reconfigure-smoke
npm run test:workspace-visual-smoke
```

### Gate D：候选发布

- 运行一次完整 `npm test`，不得只引用工作包定向结果。
- 运行 Gate A-C 中全部适用项。
- 运行安全、隔离、缓存、组合、导航、帮助和公开认证 smoke。
- 执行生产构建与仓库边界检查。
- 修改前后各执行一次 `npm run data:audit`，问题数必须保持 0。
- 人工检查至少一个 Python、一个 R、一个多 Figure、一个热图色条、一个组合项目。
- 确认临时测试服务退出，3000 和 Docker 状态未被测试改变。

注意：`package.json` 中没有隔离 wrapper 的脚本，在确认其自建临时数据库前不得直接运行；禁止让默认 `SCIFIGURE_URL` 指向 3000。

## 7. 合并阻断条件

出现以下任一情况必须停止合并和部署：

- 现有基线测试失败且无法证明与修改无关。
- 对象数量、identity、relation 或 property capability 无解释退化。
- 控件显示成功但没有 Draft、没有 renderer 写回或刷新后丢失。
- 单对象修改扩大到整组，或整组修改只命中第一个。
- Python 修复导致 R 控件、patch 或导出退化。
- 多 Figure 状态串联、旧响应覆盖新结果或部分失败丢草稿。
- 编辑器预览、导出文件和导出快照不一致。
- 测试访问真实 data、3000、Docker 或创建真实测试账号。
- 数据审计出现新增问题、项目/文件/资产数量异常或所有权变化。
- 新能力缺少关闭开关、独立回滚单位或 unsupported 降级路径。
- renderer 返回 missing gid、unsupported setter、capability mismatch 或其他未应用警告，但服务端仍把该 patch 写入 editLog/history/export snapshot。
- 任一 UI 路径在目标 `propertyCapabilities` 明确要求 backend patch 时仍用硬编码属性表生成 local patch。
- 任一 standalone 或项目 Figure 的服务端 patch 路径仍信任客户端 mode，而未按可信 manifest 分类或保守提升为 backend 验证。
- 导出快照恢复在写数据库前没有证明当前 renderer 可以无错误重放全部目标 Figure。
- 导出文件创建/删除失败时，文件和数据库记录没有补偿清理或回滚语义。
- Python 能力扩展绕过生产 Docker 沙箱或依赖未启用的 AST 检查作为唯一安全边界。

## 8. 基线变更规则

基线不是只增不减的按钮清单，而是经过证据确认的用户合同。只有满足以下条件才允许更新本文件：

1. 代码已经实现，而不是仅存在计划。
2. 单元、API 或真实浏览器测试能够重复证明。
3. 旧项目兼容和数据边界已经验证。
4. 已记录默认启用条件、已知限制和回滚方式。
5. 文档写明实际修改时间和证据截止时间。

删除或改变既有基线行为属于产品兼容性变更，必须单独评审，不能夹带在图元扩展或性能优化中。
