# SciFigure IFC V3.1 — 语义感知编辑层完整升级实施计划

本计划聚焦于完成并核实 `docs/upgrade-plan.md` 中所有未完成的 SciFigure V3.1 高级编辑能力。

---

## 拟更改文件与模块

### 一、后端与内省引擎

后端目前已全面支持 `zorder` 以及细粒度刻度属性（如 `tick_length`, `tick_width`, `tick_color`, `tick_pad` 等）、统一边框 `spine_group` 的读取与写入，无需修改 `renderer/introspector.py` 逻辑。

---

### 二、大纲图层树 (LeftSidebar.tsx)

#### [MODIFY] [LeftSidebar.tsx](file:///E:/ai绘图修改编辑/src/components/LeftSidebar.tsx)
* **React 命名空间编译修复**:
  - 导入 React：`import React, { useMemo, useState, type ReactNode } from 'react';`，以消除 `React.DragEvent` 的 TS2503 编译错误。
* **统一边框 (`spine_group`) 归类到坐标系**:
  - 在 `axesObjects` 的 filter 规则中增加 `o.id.startsWith('spine_group.')` 匹配，使得统一边框对象正确归类在 “坐标系与网格 (Axes)” 分类下，而不会退化为普通数据图层。

---

### 三、属性编辑区 (RightSidebar.tsx)

#### [MODIFY] [RightSidebar.tsx](file:///E:/ai绘图修改编辑/src/components/RightSidebar.tsx)
* **编译错误修复 (renderTextInput 传参问题)**:
  - 修复 `renderField`、`renderAxisDetailPanel`、`renderLegendPanel` 和 `renderGlobalsPanel` 中调用 `renderTextInput` 时参数遗漏（仅传了 3 个参数，缺少首个 `gid` 参数）导致的 TS2554 编译错误。这一参数错误也是导致双击文本与侧边栏不同步的主因。
* **GroupPanel 多选 (Ctrl/Shift) 与 EdgeColor 批量编辑**:
  - 新增多选状态：`selectedGroupIds` (Set) 以及 `lastSelectedGroupId` (string | null)。
  - 在每个逻辑组卡片中，加入多选复选框，支持 Shift 连选和普通点击多选。
  - 若 `selectedGroupIds.size > 0`，在分组面板顶部渲染一个浮动/常驻的 **“批量编辑已选分组 (Batch Edit)”** 控制卡片，可对所选分组批量修改：填充颜色、边框颜色 (`edgecolor`)、线宽 (`linewidth`)、透明度 (`alpha`) 以及显隐状态 (`visible`)。
  - 在每个逻辑组卡片内，添加单独的 `组边框颜色` 编辑器 (更新 `edgecolor` 属性)。
* **自定义配色预设保存与删除**:
  - 在“科研绘图预设配色”区，渲染自定义预设时，增加 hover 触发的 `×` 按钮，允许用户删除 localStorage 中的自定义预设，并通过 `e.stopPropagation()` 阻止触发应用该预设。

---

## 验证与测试方案

### 自动测试与编译检查
- 运行 `npx tsc --noEmit` 确保整个项目编译通过。

### 手动功能核实
1. **大纲树**:
   - 确认 `axis.x.0`、`axis.y.0` 和 `spine_group.0` 都在 “坐标系与网格” 下渲染。
   - 尝试在“数据图层”中拖拽重新排序分组，验证是否能触发 `onPatch` 发送 `zorder` 的 `backend_patch` 并重新渲染。
2. **分组面板**:
   - 选中多个分组复选框，测试是否能看到顶部的批量编辑卡片。
   - 批量修改边框颜色为红色，填充色为蓝色，线宽为 2，验证图表是否完美重绘。
3. **文本双击同步**:
   - 双击标题修改文本，验证 RightSidebar 面板输入框中的文本是否同步刷新。
4. **自定义配色预设**:
   - 点击“保存当前预设”，然后 hover 在新产生的预设上，点击 `×` 删除它，验证 localStorage 与 UI 同步更新。
