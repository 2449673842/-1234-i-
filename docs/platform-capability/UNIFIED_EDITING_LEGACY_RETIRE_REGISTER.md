# SciFigure 统一编辑中心 Legacy Retire 登记表

> 状态：Phase 8b 匿名观察候选已完成本地验收；稳定发布观察期未开始，禁止提前删除 legacy
> 创建时间：2026-07-13 12:35:42 +08:00
> 最后更新：2026-07-13 15:43:12 +08:00
> 关联计划：`UNIFIED_EDITING_CENTERS_UPGRADE_PLAN.md`

## 1. 文档目的

本登记表用于逐项决定统一编辑中心的旧代码能否退役。静态搜索、单次测试通过或“默认开关已经启用”都不能单独作为删除依据。

Phase 8b 必须同时回答：

```text
该路径是否仍在真实候选版本中被调用
它是否仍承担 V2 descriptor 尚未覆盖的专用能力
它是否是旧 manifest 或紧急回滚的唯一入口
删除后默认路径、回滚路径、保存、历史和重绘是否仍完整
```

## 2. 隐私边界

观察链路只允许记录固定枚举和聚合计数：

- 允许：build ID、事件类型、Python/R 引擎类型、中心、作用域、对象 kind 计数、规范属性名、strict/legacy 策略、fallback 原因和数量。
- 禁止：用户、项目、Figure、session、对象 ID、patch key、palette ID、label、文本内容、颜色值、属性值、脚本、SVG、数据表、IP 和 User-Agent。
- 观察文件只写入 `tmp/unified-editing-staging/legacy-retire-observation/`，不得写入 `data/`、SQLite、admin audit 或 Git tracked 文件。
- 接收端只在统一编辑 staging 或显式 `SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY=1` 时开放，并继续要求登录认证。

## 3. 路径登记

### A. 重复公共控件候选

以下代码已由 descriptor 控件覆盖，但仍作为显式 UI 回滚存在。观察期内对应 legacy surface 必须为 0，才可进入删除评审。

| 路径 | 当前作用 | 状态 | 删除前证据 |
|---|---|---|---|
| 字体中心旧 fontsize/fontfamily/fontweight/fontstyle/color 控件 | `FONT_CONTROLS_V2=0` 回滚 | 保留观察 | `font_controls_rollback=0`，默认/回滚 smoke 通过 |
| 组件中心旧 linewidth/fontsize/fontweight/fontstyle/alpha/visible 公共控件 | `COMPONENT_CONTROLS_V2=0` 回滚 | 保留观察 | `component_controls_rollback=0`，专用控件已分离 |
| 配色中心旧颜色输入 | `PALETTE_CONTROLS_V2=0` 回滚 | 保留观察 | `palette_controls_rollback=0`，同色不同组与 vector collection 回归通过 |
| 布局中心旧 position/geometry 入口 | `LAYOUT_CONTROLS_V2=0` 回滚 | 保留观察 | `layout_controls_rollback=0`，坐标空间与拖拽回归通过 |
| 属性编辑 descriptor 已覆盖的 `legacyEditable` 字段 | 未迁移专用字段之外的旧通用字段 | 逐属性评审 | `legacyFallback=0` 且 descriptor registry 已覆盖 |

### B. 仍承担专用能力，不可删除

这些路径不是重复公共控件，不能因 V2 默认启用而删除：

| 专用能力 | 当前承载位置 | 删除阻断条件 |
|---|---|---|
| annotation anchor position | 属性编辑专用箭头锚点面板 | descriptor 尚未完整表达双位置关系 |
| axis limits、tick direction/length/width/pad、tick offset | axis 专用面板和组件中心 | 公共 descriptor 只覆盖部分属性 |
| legend markerscale、spacing、frame 与容器位置 | legend 专用面板 | 图例容器、文字、marker 的派生关系仍需专用逻辑 |
| errorbar capsize、stem baseline/stem linewidth | 组件专用控件 | 通用 linewidth 不能表达容器内部子元素语义 |
| boxplot median、violin body/stat line | 组件专用控件 | renderer container capability 已有，但 descriptor 控件未全部迁移 |
| heatmap/colorbar clim、cmap、tick 和 geometry | 热图/色条专用控件 | scale、mappable、共享 owner 关系不能用普通颜色控件代替 |
| subplot physical axes size、grid reflow、swap、colorbar alignment | 布局内容面板 | 属于布局事务，不是单属性通用控件 |
| global canvas width/height/dpi | Figure globals 面板 | 虚拟 `global` target 不属于普通对象 descriptor |

### C. 兼容与紧急回滚路径

| 路径 | 触发条件 | 当前策略 | 退役条件 |
|---|---|---|---|
| `compileEditingIntent` legacy compiler | 显式 resolver `=0` | 可审计应急回滚 | 一个稳定发布周期无 resolver 回滚，旧 manifest 已重渲染 |
| descriptor `allowLegacyFallback` | UI/布局显式回滚 | 旧 `editable/currentProps` 兼容 | 默认项目协议完整率 100%，fallback 计数为 0 |
| palette legacy target resolver | binding/object protocol 缺失或显式 `=0` | strict 默认阻止，显式回滚兼容 | binding target identity/capability 覆盖率 100% |
| legacy errorbar collection grouping | renderer 无 container 对象 | 旧图兼容 | 所有支持版本 renderer 均输出 container identity |
| colorbar geometry owner fallback | 旧 manifest 无 owner relationship | 只用于兼容旧图 | shared/independent colorbar 均有显式 owner 关系 |
| saved edit/session normalizer | 历史保存结构缺字段 | 读取兼容 | 完成数据迁移和可恢复备份后单独评审 |

## 4. 匿名观察事件

```text
legacy_descriptor_projection
legacy_resolver_path
legacy_palette_resolver_path
legacy_ui_surface_rendered
legacy_position_drag_path
```

每个事件必须先经过前端 sanitizer，再由服务端使用同一 sanitizer 二次校验。服务端补充 `receivedAt` 和当前候选 `buildId`，不接受客户端提供身份字段。

## 5. 删除门槛

单条 legacy 路径只有同时满足以下条件才可删除：

1. 至少一个稳定发布观察周期内，默认 V2 路径的对应 legacy 调用计数为 0。
2. 观察期内没有通过关闭该中心控件或 resolver 解决的真实问题。
3. Python/R fixture 与真实项目矩阵均覆盖其替代能力。
4. 默认、UI 回滚、resolver 回滚、Draft、撤销/重做、保存刷新和导出测试全部通过。
5. 对应专用能力已迁移，或代码审查证明该分支无调用且不承担历史读取。
6. 云端 Docker renderer 的禁网、只读、资源限制和 capability manifest 验证通过。
7. 删除提交可独立回滚，不与新绘图功能、数据库迁移或用户数据操作混在一起。

## 6. 放行报告格式

每次候选发布结束后追加一条记录：

| 字段 | 要求 |
|---|---|
| build/commit | 不可变 build ID 和 Git commit |
| 观察时间 | 起止时间与稳定版本 |
| 项目矩阵 | Python/R、单图/多图、复杂对象类型 |
| protocol completeness | identity/capability 完整对象数与总数 |
| legacy events | 按事件、中心、属性和 fallback reason 聚合 |
| 回滚次数 | 控件回滚与 resolver 回滚分开统计 |
| 测试证据 | 单元、浏览器、renderer、Docker、保存/历史/导出 |
| 决策 | 保留、迁移、删除候选或已删除 |

## 7. 当前结论

Phase 8a 已完成默认启用和显式回滚。Phase 8b 的匿名聚合观察链路已完成本地候选验收，默认 strict、显式 UI 回滚和 resolver 回滚均能留下可区分证据；当前没有删除任何 legacy。

本地候选证据（2026-07-13 15:43:12 +08:00）：

| 项目 | 结果 |
|---|---|
| 默认候选事件 | 68 条；五类事件均出现 |
| 隐私扫描 | 禁止字段 0 命中；仅固定枚举、计数、build/time |
| 回滚证据 | semantic resolver/palette legacy 事件与 font/component/palette/layout rollback surface 均出现 |
| API 门禁 | 关闭 404、认证、64 KB、100 events、路径净化通过 |
| 默认浏览器矩阵 | 属性 9、Python 语义 14、组件/布局 18、R 7、拖拽 9，全部通过 |
| UI 回滚矩阵 | 语义 14、组件/布局 18，全部通过 |
| renderer | `scifigure-renderer:phase8b`，Docker sandbox 通过 |

下一步是稳定发布观察，不是删除。只有满足第 5 节全部门槛后，才允许把 A 类路径逐项提交删除评审；B/C 类继续保留。最终 Legacy Retire 必须按路径逐项完成，不能一次性删除全部旧代码。
