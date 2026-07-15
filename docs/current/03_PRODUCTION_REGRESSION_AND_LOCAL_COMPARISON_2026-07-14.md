# SciFigure 生产错误回归与本地 3000 对比报告

- 最后更新：2026-07-16 01:55:49 +08:00（仅隐私脱敏，测试结论仍对应 2026-07-14）
- 生产目标：`http://117.72.208.91`，build `eea68fb-jd7`
- 本地目标：`http://127.0.0.1:3000`，主工作区 Vite 开发服务
- 测试方式：Playwright 真实浏览器、专用 smoke 账号、真实 Python/R renderer、生产 API
- 数据边界：未登录目标真实账号（文档已脱敏），未读取或修改其项目；本轮测试项目清理后 smoke 账号项目数为 0
- 部署边界：未修改生产服务器代码、服务、Docker 或数据库

## 1. 结论

`docs/ERROR_LOG.md` 当前 47 条历史错误中，本轮得到：

| 结果 | 数量 | 说明 |
|---|---:|---|
| PASS | 27 | 线上真实浏览器、真实 renderer 或生产 API 已复测通过 |
| PARTIAL | 15 | 主路径通过，但存在关联回归、测试夹具失配或未覆盖复杂真实项目 |
| MANUAL / BLOCKED | 5 | 需要用户账号、历史项目或特定复杂图人工确认 |

生产版不是整体不可用。Python/R 渲染、精确配色、拖拽、导出、代码历史、多子图和组合项目主链路可用，但发现 3 个当前生产缺陷：

1. 字体/坐标轴 strict 目标解析存在错配或只读：跨 Figure 修改 X 轴刻度字号时实际生成 `title.* / fontsize`，部分轴和组件属性被判为只读。
2. 组件中心连续应用后，后续请求重复携带之前已应用 patch，说明 draft 清理或状态回写没有正确收敛。
3. XLSX 上传在生产 Docker 解析器中因 `UMask=0077` 与容器 UID `65532` 不一致而报 `/work/input.xlsx Permission denied`。

第 3 项已在本地升级分支修复并通过容器回归，但尚未部署。第 1、2 项仅完成定位与证据收集，尚未修改生产代码。

## 2. 3000 与生产升级版差异

生产升级分支相对本地 3000 主线增加约 11,780 行、涉及 97 个文件。主要变化如下：

| 能力 | 本地 3000 | 生产 `eea68fb-jd7` |
|---|---|---|
| 属性控件 | legacy `editable` 推断 | `PropertyDescriptor + propertyCapabilities` V2 |
| 目标选择 | 允许 legacy fallback | strict resolver，缺 capability 时只读 |
| 配色 | legacy 目标匹配 | 精确 target/prop、歧义保护、向量组隔离 |
| 字体/组件/布局 | 旧控件直接生成 patch | 统一投影、作用域、坐标空间和 replay 能力 |
| 保存 | 可保存未应用 engine draft | 阻止假保存，要求先应用并渲染 |
| 生产部署 | 开发服务 | Nginx、systemd、rootless Docker renderer、draining/rollback |
| 管理能力 | 无独立后台 | 管理员后台、错误中心、AI 脱敏交接、订阅授权与审计 |
| 新建项目 | 旧脚本入口 | 首屏 `.py/.R` 拖放、数据依赖提示 |

升级版的安全性和目标精度明显更高，但 strict 协议的代价是：renderer 未声明或前端映射错误的属性会直接变成只读。当前字体/组件问题不是图元识别系统整体失效，而是 V2 capability 投影和目标映射尚未完全覆盖 legacy 控件曾经放行的属性。

## 3. 双端实测

| 测试 | 本地 3000 | 生产 | 结论 |
|---|---:|---:|---|
| Python 语义中心 | 35.3s，11 PASS / 3 FAIL | 104.9s，14/14 PASS | 生产精确配色和保存保护更完整，但约慢 3 倍 |
| 组件容器 | 47.7s，16 PASS / 2 V2 预期失败 | 101.1s，11 PASS / 7 FAIL | 本地每次只发当前 patch；生产重复携带历史 patch |
| 轴样式内存 Figure | 2.4s，5/5 PASS | 11.5s，3/5 PASS | 生产边框组和网格控件被 strict 判只读 |
| 数据依赖提示 | 1.5s | 8.5s | 两端均允许上传两份额外 CSV；旧提示过弱 |

生产 API 首字节约 0.9s；2 核 4 GB 主机还需要逐次启动隔离 renderer。网络往返、容器启动和重复 patch 共同造成远端明显慢于本机，不是单一前端动画问题。

## 4. 线上通过的关键能力

- Python 语义中心：14/14，通过同色不同组隔离、数据驱动颜色、向量颜色、局部保存和未应用草稿阻止保存。
- R 语义中心：7/7，通过 facet、字体、组件、配色和复杂坐标降级。
- 多子图：4/4，通过子图作用域字体和线条编辑。
- 拖拽：连续两个对象、三目标拖拽、取消、annotation、R native 保护全部通过。
- 跨 Figure：单图边框应用到 4 子图 fanout 通过，且没有触发项目全量重绘。
- 导出：SVG/PNG/PDF/TIFF、横向尺寸、全部 Figure、子图同格式、资产入库和渲染中阻止导出全部通过。
- 代码历史：同步代码后 undo/redo 能恢复对应脚本和预览。
- 组合代码项目：跨项目文件复制、Python/R 来源和组合资产 revision 一致性通过。
- 首屏脚本拖放：生产真实 `DataTransfer/drop` 可识别 R 脚本和 `stats.csv`。
- 复制提示词：HTTP 环境 clipboard fallback 通过。

## 5. 当前失败与解释

### 5.1 字体和坐标轴

生产跨 Figure 测试选择“X 轴刻度文字”后，发送的是 `title.0...title.3 / fontsize`，不是 `axis.x.* / tick_labelsize`。轴样式 fixture 中边框与网格 V2 控件没有生成 patch。本地 legacy 控件两项均通过。

这与用户看到“只有刻度方向可改，字体、字重等只读”一致。根因范围已缩小到 `propertyDescriptors`、font/component projection 和 renderer capability 对齐，不应通过重新放开全部 legacy fallback 解决，否则会重新引入改错对象问题。

### 5.2 组件连续应用

生产组件测试第一次柱形线宽只发送 1 条 patch；第二次误差棒请求包含柱形 + 误差棒；后续请求继续累积。功能表面可能仍生效，但会重复渲染旧修改、增加延迟，并可能覆盖后续状态。

### 5.3 Excel 上传

生产报错：

```text
Workbook parsing failed: [Errno 13] Permission denied: '/work/input.xlsx'
```

根因是表格解析器仍直接创建 `0700` 临时目录和 `0600` 文件，再以容器 UID `65532` 读取。绘图 renderer 已在 `20c7c38` 修复同类问题，但 tabular parser 路径被遗漏。

本地修复采用私有 `0700` 外层目录、`0755` 工作目录和 `0444` staged workbook。`UMask=0077` 容器 smoke 已成功读取 `sandbox-results.xlsx`，返回 2 列、2 行。生产尚未部署该修复。

### 5.4 数据依赖提示

原提示只有 12px 灰色单行，实际允许额外上传，但用户很难判断下一步。本地候选已改为 14px 蓝色状态块，说明动态路径无法推断、继续上传实际使用的表格，以及额外表会保留并进入 AI 数据上下文。浏览器测试确认两份额外 CSV 均被接收。

## 6. 47 条历史错误回归矩阵

| # | 历史错误摘要 | 状态 | 本轮证据 |
|---:|---|---|---|
| 1 | 管理员 CSS 未加载 | PASS | 同 build 管理入口与 marker 有效，Admin CSS 构建产物存在 |
| 2 | staging renderer 版本错配 | PARTIAL | build/renderer 主链路对齐；仍有 strict 属性只读新缺口 |
| 3 | R facet Docker 失败 | PASS | R fixture facet 渲染成功 |
| 4 | strict 假可编辑与拖拽回滚 | PASS | strict/拖拽保护通过 |
| 5 | 布局坐标空间误放行 | PASS | R facet bounds 明确禁用 |
| 6 | 配色 strict 与假保存 | PASS | Python/R 配色及保存阻止通过 |
| 7 | 组件 V2 边框只读/错控件 | PARTIAL | 真实 frame fanout 可用；连续 patch 累积且部分 fixture 只读 |
| 8 | R 复杂坐标与未知 geom | PASS | R layout gate、native drag 保护通过 |
| 9 | R 默认离散色标退化 | PASS | R palette 精确 target 通过 |
| 10 | 轴 smoke 被认证拦截 | PARTIAL | 认证已不阻塞；轴边框/网格当前 2 项失败 |
| 11 | 导出返回与重新配置旧流程 | PASS | navigation/reconfigure、export library 通过 |
| 12 | 重复渲染提示/无效工具轨 | PARTIAL | 左侧图层/字体入口通过；移动端视觉 smoke 超时 |
| 13 | 窄画布标签换行 | PARTIAL | 桌面无溢出；移动端仍需人工确认 |
| 14 | 宣传页认证门禁 | PASS | public auth smoke 通过 |
| 15 | 白画布与绘图区入口 | PARTIAL | layout V2 与横向导出通过；复杂项目需人工确认 |
| 16 | tick 拖动后回原位 | PARTIAL | 不稳定 position 已受保护；未用用户项目人工拖动 |
| 17 | tick 文字整体偏移 | MANUAL | 需要真实项目人工验证 dx/dy |
| 18 | 图例内部文字跑左下角 | PARTIAL | legend relation 正确；未直接拖动复杂共享图例 |
| 19 | 超过 3 张 Figure 不显示 | MANUAL | 本轮 fixture 仅 3 Figure |
| 20 | Figure 复选框被遮挡 | PASS | 跨图选择与批量目标交互成功 |
| 21 | R 误走 Python/CSV 失败 | PASS | R 真实渲染和带文件组合来源通过 |
| 22 | 多文件单图绑定错误 | PASS | 跨项目多文件复制和渲染通过 |
| 23 | 配色无法撤销 | PARTIAL | 配色保存通过；未单独执行 palette undo |
| 24 | 拖拽破坏普通选择 | PASS | drag extended 全部通过 |
| 25 | 拖拽跳回且无确认 | PASS | 连续/多选/取消通过 |
| 26 | 应用全部只改多子图左上角 | PASS | 4 个 spine_group fanout 通过 |
| 27 | 第二次拖动仍是第一个对象 | PASS | 两个不同 gid 一次确认通过 |
| 28 | 组合项目数据错配/渲染不停 | PARTIAL | 组合 API 通过；旧 UI stale smoke 认证夹具失配 |
| 29 | 颜色保存刷新丢失 | PASS | local draft 保存并重新读取通过 |
| 30 | Figure-level 共享图例识别 | PARTIAL | legend relation 通过；复杂共享图例需人工确认 |
| 31 | 组件整组只改首个子图 | PASS | frame group 多目标 patch 通过 |
| 32 | session 清理丢历史 | PARTIAL | code history 通过；生产过期清理需时间型验证 |
| 33 | 登录后看不到原项目 | BLOCKED | 未使用用户账号密码，不读取其项目 |
| 34 | Windows 数据目录误判 | MANUAL | 生产是 Linux；该项不适用网页回归 |
| 35 | 代码没有持久撤回 | PASS | code history smoke 通过 |
| 36 | 组合选择器 C1-C5 | PARTIAL | 组合 API 通过；UI smoke 被内部观测 401 污染 |
| 37 | 帮助中心图标崩溃 | PASS | 无 React crash；入口和静态资源可访问 |
| 38 | 模板图片路径错误 | PASS | 7 张模板图均 HTTP 200；测试存在图片加载等待竞态 |
| 39 | 帮助页会话误替换宣传页 | PARTIAL | public auth 通过；完整 help smoke 被图片竞态提前终止 |
| 40 | 帮助受众/热更新 | MANUAL | 内容需人工产品审阅 |
| 41 | 历史导出资产看似丢失 | PASS | 全局资产页和真实导出入库通过 |
| 42 | 测试污染正式数据 | PARTIAL | 发现 1 个清理前缀遗漏并已删除；需修测试清理规则 |
| 43 | 数据驱动颜色组修改无效 | PASS | code patch + backend target 全部通过 |
| 44 | 向量散点配色串组 | PASS | 只改目标向量组，另一组保持不变 |
| 45 | 横图导出变竖图 | PASS | 8x4 in 预览与 576x288 导出一致 |
| 46 | 首屏脚本拖放未绑定 | PASS | 生产真实 R drop 通过；本地 3000 旧版尚无该入口 |
| 47 | 管理错误交接/订阅调整 | PASS | 同 build 管理 API、授权和审计此前已完成生产验收 |

## 7. 下一步优先级

1. P0：部署 XLSX staging 权限修复，使用用户同名文件或等价 workbook 做生产验收。
2. P0：修复 font/component V2 目标映射，要求 X/Y tick 的 family/size/weight/style 均生成 axis tick 属性，不允许落到 title。
3. P0：修复 draft 应用后的清理与响应回写，确保每次请求只包含当前批次。
4. P1：保留 strict 安全边界，不用全局 legacy fallback 掩盖缺 capability。
5. P1：部署增强后的“未识别固定数据文件名”状态提示。
6. P1：对 5+ Figure、共享图例、tick dx/dy 和真实用户历史项目做人工回归。

## 8. 验证命令

```powershell
$env:SCIFIGURE_SANDBOX_WORKBOOK_ONLY='1'
node tests\api\renderer_sandbox_smoke.mjs

node scripts\testing\run_with_isolated_server.mjs -- node tests\playwright\project_create_dependency_hint_smoke.mjs
npm.cmd run build
```

本轮结果：XLSX sandbox PASS，dependency hint PASS，production build PASS。
