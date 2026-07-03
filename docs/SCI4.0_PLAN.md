# SciFigure Studio 4.0 Upgrade Plan

> 版本：SciFigure Studio 4.0 Plan  
> 日期：2026-06-29  
> 当前主线：`E:\ai绘图修改编辑`  
> 当前基线：`b65edbf` 本地恢复提交，远端基线仍需按实际 Git 状态确认  
> 目标：先完成产品闭环，再继续扩展图元识别能力。

---

## 0. 执行约束

任何外部 AI 尤其是 Gemini 接手前，必须先阅读：

- `docs/GEMINI_CODING_PROTOCOL.md`
- `docs/RECOVERY_BASELINE_20260628.md`
- `docs/artist_introspection_upgrade_plan.md`

本阶段禁止：

- 无证据大重构。
- 顺手修改 `server.ts`、`renderer/introspector.py`、`RightSidebar.tsx` 的无关逻辑。
- 把数据库运行态文件 `data/scifigure.db*` 当成功能代码提交。
- 宣称“100% 完成”但没有可复现验证。

每个任务必须遵守：

```text
源码证据 -> 最小修改 -> 自动化验证 -> 浏览器验收 -> 记录风险
```

---

## 1. 当前状态

### 已具备的核心能力

- 真实 Python / Matplotlib 渲染。
- 多文件项目。
- 多 Figure Registry。
- Manifest v2 内省。
- editLog 重放。
- 组件中心、字体中心、配色中心。
- 导出资产表 `export_assets`。
- 组合图页面 `ComposerPage.tsx`。
- 用户注册、登录、兑换码基础能力。
- LandingPage 产品介绍页。

### 已支持的图元语义

- text / figure text
- title / xlabel / ylabel
- xtick / ytick
- legend / legend text
- axis / grid / spine / spine group
- line
- scatter / collection
- patch / bar
- errorbar container
- boxplot container
- violinplot container

### 当前高价值缺口

1. 导出资产库还没有完整产品化。
2. 组合图编辑页已有基础，但需要更稳定、更清晰的工作流。
3. 字体中心/配色中心需要真实项目回归和细节补齐。
4. Heatmap / Colorbar 语义识别还未进入实现阶段。
5. AI 转义契约需要根据语义能力矩阵继续升级。

---

## 2. 4.0 总体优先级

```text
P1-1 导出资产库完整上线
P1-2 组合图高级编辑调优
P1-3 字体/配色中心稳定性回归
P2-1 Heatmap / Colorbar 只读识别
P2-2 Heatmap / Colorbar 安全 patch
P2-3 语义能力矩阵文档 + fixture 测试库
P2-4 AI 转义契约升级
P3   上线准备与商业化基础
```

核心判断：

```text
先完成用户交付闭环，再扩展图元识别能力。
```

导出资产库和组合图直接影响用户能否把图整理成论文多面板图，是当前最接近付费价值的功能。因此优先级高于 Heatmap / Colorbar。

---

## 3. P1-1 导出资产库完整上线

### 目标

把项目历史导出的图从“后端文件记录”升级为用户可见、可排序、可过滤、可批量管理的资产库。

### 后端改动

文件：

- `server.ts`
- `db.ts`

任务：

1. 增强 `GET /api/projects/:id/export-assets`：
   - 返回 `sizeBytes`
   - 返回 `downloadUrl`
   - 保留已有字段：`assetId`、`projectId`、`figureId`、`name`、`format`、`dpi`、`thumbnailSvg`、`metadata`、`tags`、`createdAt`

2. 复核 `DELETE /api/projects/:id/export-assets`：
   - 支持 `assetIds: string[]`
   - 删除物理文件
   - 删除数据库记录
   - 不允许路径穿越
   - 文件不存在时不应导致整批删除失败

3. 不新增 ZIP 依赖：
   - MVP 只做批量删除和逐个下载。
   - ZIP 打包后续再做。

### 前端改动

新增：

- `src/components/ExportLibraryPage.tsx`

修改：

- `src/App.tsx`
- 必要时修改导航入口组件

功能：

- 表格视图
- 卡片视图
- 缩略图预览
- 按导出时间排序
- 按文件名排序
- 按格式排序
- 按文件大小排序
- SVG/PNG/PDF/TIFF 格式过滤
- 多选
- 批量删除
- 下载单个文件
- 逐个批量下载
- 从资产库进入组合图

### 验证

自动化：

```bash
npx tsc --noEmit
npm run build
npm run lint
```

建议新增：

```text
scratch/smoke_test_export_library.py
```

测试内容：

- 创建项目
- 生成导出资产
- 查询资产列表
- 验证 `sizeBytes`
- 验证 `downloadUrl`
- 下载文件
- 批量删除
- 验证数据库记录消失
- 验证物理文件消失

浏览器验收：

- 导出 3 张图
- 打开导出资产库
- 切换表格/卡片视图
- 按时间、格式、大小排序
- 多选删除
- 重新导出后确认资产库刷新

---

## 4. P1-2 组合图高级编辑调优

### 目标

让用户可以把多张已导出的科研图组合成论文多面板图，并进行可视化排版。

### 修改文件

- `src/components/ComposerPage.tsx`
- `server.ts`

### 功能增强

1. 模板快捷应用：
   - 2 图：1x2
   - 4 图：2x2
   - 6 图：2x3

2. 拖拽与对齐：
   - 8px 或 16px grid snap
   - 拖动时显示对齐参考
   - 保持子图不越界

3. 子图操作：
   - 拖动位置
   - 修改宽高
   - 交换位置
   - 重置当前子图
   - 重置全部布局

4. 外标编辑：
   - 自动生成 `(a)(b)(c)`
   - 手动修改 label
   - 统一 label 字号
   - 统一 label 字体
   - 统一 label 颜色

5. 子图内字体统一：
   - 保留 `applyInnerFont`
   - 只覆盖 SVG `<text>` 展示样式
   - 不修改原始单图资产
   - 在 UI 上明确说明这是组合图级覆盖

6. 导出：
   - SVG：后端 `/api/projects/:id/compose`
   - PNG：前端 canvas 转换后导入资产库
   - PDF/TIFF：先显示“后续开放”，不要假响应

### 验证

浏览器验收：

- 从资产库选择 2 张图生成 1x2
- 从资产库选择 4 张图生成 2x2
- 拖动一个图，确认 snap 生效
- 修改 label 字体和颜色
- 勾选 `applyInnerFont`
- 导出 SVG
- 导出 PNG
- 新组合图进入资产库

---

## 5. P1-3 字体中心 / 配色中心稳定性回归

### 目标

确保用户在右侧中心化面板中的批量修改行为真实生效，并能持久化、撤销、导出。

### 修改文件

- `src/components/RightSidebar.tsx`
- 必要时检查 `src/hooks/useFigureSession.ts`
- 必要时检查 `renderer/introspector.py`

### 字体中心

检查分组：

- 标题
- X 轴标签
- Y 轴标签
- X tick
- Y tick
- 图例文字
- 注释文字

要求：

- 批量改字号生效
- 批量改字体生效
- 批量改颜色生效
- 写入 editLog
- undo/redo 可恢复
- 导出图一致

### 配色中心

要求：

- 明确显示“正在修改谁”
- 区分单个对象、选中子集、整组
- 改散点子集不能误改整组
- 改整组必须有明确按钮
- 修改写入 editLog
- undo/redo 可恢复
- 导出图一致

### 参数汉化补齐

至少补齐：

```text
elinewidth -> 误差线宽
capthick -> 误差端点线宽
capsize -> 误差端点大小
box_color -> 箱体颜色
median_color -> 中位线颜色
cmap -> 色带
vmin -> 色阶最小值
vmax -> 色阶最大值
```

### 验证

真实图验证：

- bar + errorbar
- scatter
- boxplot
- violinplot
- 多 panel 图

每类至少验证：

- 改颜色
- 改线宽
- 改字体
- 撤销
- 重做
- 导出

---

## 6. P2-1 Heatmap / Colorbar 只读识别

### 目标

补齐 Matplotlib 高价值原生对象，不是给某个用户热图写死适配。

识别对象：

- `AxesImage`：`imshow`
- `QuadMesh`：`pcolormesh` / seaborn heatmap 常见底层对象
- `Colorbar` / colorbar axes
- `ScalarMappable` 绑定关系

### 本阶段只读

禁止：

- 开放 patch
- 修改 `RightSidebar.tsx`
- 修改前端交互
- 大改 `introspector.py` 结构

允许：

- 在 manifest 中新增只读对象
- 输出 `currentProps`
- 输出 `role`
- 输出 `stableKey`
- 输出 `fingerprint`
- 更新 coverageReport
- 新增测试 fixture

### 建议新增 kind

```text
heatmap
colorbar
```

### currentProps 建议

heatmap：

```text
cmap
vmin
vmax
alpha
shape
extent
interpolation
```

colorbar：

```text
label
tick_fontsize
orientation
vmin
vmax
cmap
```

### 测试 fixture

新增：

```text
tests/fixtures/artist_introspection/heatmap_imshow_fixture.py
tests/fixtures/artist_introspection/heatmap_pcolormesh_fixture.py
tests/fixtures/artist_introspection/colorbar_fixture.py
tests/fixtures/artist_introspection/raster_image_not_heatmap_fixture.py
```

验收：

```bash
python tests/test_introspection.py
npx tsc --noEmit
npm run build
```

---

## 7. P2-2 Heatmap / Colorbar 安全 Patch

仅在 P2-1 稳定后开始。

允许开放：

- `cmap`
- `vmin`
- `vmax`
- `alpha`
- colorbar label
- colorbar tick fontsize
- colorbar visible

禁止开放：

- 单个 cell 编辑
- seaborn annotation 全量编辑
- clustering dendrogram
- 复杂 norm 自动推断
- 多 colorbar 隐式同步

要求：

- 修改 heatmap 色阶时 colorbar 必须同步。
- 不允许只改 heatmap 不刷新 colorbar。
- 不允许前端猜 SVG 语义。

---

## 8. P2-3 语义能力矩阵与 Fixture 测试库

### 新增文档

```text
docs/SEMANTIC_CAPABILITY_MATRIX.md
```

记录每类对象：

```text
识别：支持 / 部分 / 不支持
编辑：支持哪些属性
导出一致性：支持 / 风险
前端组件中心：已接入 / 未接入
测试 fixture：有 / 无
已知风险
```

对象范围：

- text
- axis
- tick
- spine
- grid
- legend
- line
- scatter
- bar
- errorbar
- boxplot
- violinplot
- heatmap
- colorbar
- annotation
- multi-panel

### Fixture 测试库

目标：不要再靠真实项目碰运气。

标准图：

- bar
- grouped bar
- scatter
- line
- errorbar
- boxplot
- violinplot
- heatmap
- heatmap + colorbar
- multi-panel
- mixed figure

每个 fixture 流程：

```text
render -> introspect -> patch -> replay -> export
```

---

## 9. P2-4 AI 转义契约升级

### 修改文档

- `docs/AI-PROMPT.md`

### 目标

根据语义能力矩阵约束 AI 生成更容易被平台识别的 Matplotlib 脚本。

要求 AI：

- 优先使用平台可识别的 Matplotlib 原生对象。
- 不要把热图画成手写 rectangles。
- 热图使用 `imshow` / `pcolormesh` / seaborn heatmap 底层可识别路径。
- colorbar 使用 `fig.colorbar()` 或 `plt.colorbar()`。
- errorbar 使用 `ax.errorbar()`。
- boxplot 使用 `ax.boxplot()`。
- violinplot 使用 `ax.violinplot()`。
- 关键颜色使用常量。
- 不要硬编码本地路径。
- 不要 `savefig`。
- 不要 `plt.show()`。
- 保持 `load_data()` + `build_figure(df)` 结构。

---

## 10. P3 上线准备

### LandingPage

补齐：

- 平台解决什么问题
- 与 Origin / 手写 Python 的差异
- 支持图元能力矩阵
- 导出资产库展示
- 组合图展示
- 真实科研图案例

### 用户系统

验证：

- 注册
- 登录
- 退出
- 兑换码
- license check
- 免费版 / Pro 版 UI 区分

### 商业化 MVP

先定义，不急着接支付：

免费版：

- 本地项目数量限制
- 导出次数限制
- 组合图数量限制

Pro 版：

- 无限项目
- 高 DPI 导出
- 组合图工作台
- 批量导出
- AI API 辅助修图

### 部署文档

需要更新：

- `README.md`
- `.env.example`
- Python 依赖
- Node 启动方式
- SQLite 数据目录
- 备份方式

---

## 11. 推荐执行顺序

```text
Step 1: Export Library 后端补齐
Step 2: ExportLibraryPage 前端上线
Step 3: ComposerPage 使用资产库做高级排版
Step 4: 字体/配色中心真实回归修复
Step 5: Heatmap/Colorbar 只读识别
Step 6: Heatmap/Colorbar 安全 patch
Step 7: 语义能力矩阵 + fixture 测试库
Step 8: AI-PROMPT 升级
Step 9: LandingPage / 用户系统 / README 上线准备
```

---

## 12. 给 Gemini 的任务模板

```text
你正在修改 SciFigure Studio。开始前必须先阅读：
- docs/GEMINI_CODING_PROTOCOL.md
- docs/SCI4.0_PLAN.md

本次只做其中一个 Step。不要跨 Step 修改，不要顺手重构。

必须输出：
1. Preflight
2. A-F 阶段报告
3. 源码证据表
4. 影响面分析
5. 最小修复方案
6. 验证结果

没有浏览器或测试验证时，不能写“100% 正常运作”。
```
