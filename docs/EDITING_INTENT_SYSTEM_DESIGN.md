# SciFig “编辑意图系统 (Editing Intent System)” 架构与升级设计文档

本文件详述了 SciFig 平台从基于物理图元（GID + Prop + Value）的底层修改模式，升级为基于语义意图（Intent + Scope + Operation）的“编辑意图系统”的整体设计方案与演进路线。

---

## 一、 核心升级背景与动机

### 1. 现有 GID 修改机制的瓶颈
当前 SciFig 编辑器主要采用“物理图元驱动”协议：
1. **交互逻辑**：用户点击画布图元 $\rightarrow$ 获取其物理 ID (如 `rect.4`) $\rightarrow$ 修改属性并发送 Patch 缓存。
2. **跨图应用机制**：当把图 1 的样式应用到图 2 时，系统在后端通过 `scoreSemanticMatch` 打分算法，事后猜测图 2 上的哪个 GID 对应图 1 的 `rect.4`。
3. **数据重载易损性**：当用户更新 CSV 数据源时，图表重新渲染会导致 GID 发生位移，导致历史 Edit Log 被应用到错误的图元上，引起排版错乱。

### 2. 什么是“编辑意图系统”？
升级后的意图系统将“操作意图”作为核心契约。用户在前端点击图例并拖动时，系统不再记录“修改物理图元 `legend.0`”，而是记录一个**“修改图例容器位置”的意图**。意图系统通过统一的语义编译器，将该意图翻译为对应图表的 GID Patch 或直接回写到后端的代码参数中。

---

## 二、 用户体验 (UX) 提升与痛点解决

| 痛点场景 | 以前（物理 GID 模式） | 以后（语义意图系统） |
|---|---|---|
| **跨图同步排版** | 基于物理图元打分猜测。如果目标图子图结构不同，容易出现“对齐失效”或“只同步了部分图元”。 | 意图包含明确角色。目标图编译器直接检索其 Manifest 中符合该角色的元素，实现 **100% 精准同步**。 |
| **更新 CSV 数据源** | 数据行数变化导致 GID 错位，用户花费数小时调整的排版在重新导入数据后**瞬间乱套**。 | 意图绑定的是语义角色。新数据渲染后，意图重新编译，**完美保留用户之前的调整位置与配色**。 |
| **隐性/未暴露参数修改**<br>*(例如热图色条宽度)* | 无法修改。因为色条宽度在 Python 中是代码参数（`fraction`），系统无法将“SVG 像素宽”换算回代码。 | 意图直接映射至代码 AST。拖拽宽度产生“改变色条 fraction”的意图，直接回写代码，**彻底解锁隐性参数修改**。 |
| **局部修改“误伤”** | 修改 Y 轴标题时，可能会因为底层代码变量共享导致 Y 轴刻度字也一起变色。 | 语义角色隔离。Y 轴标题与刻度字是完全独立的两个语义对象，**绝不发生连带误伤**。 |

---

## 三、 意图协议定义 (Intent Protocol Schema)

一个标准的意图 Payload 结构如下：

```json
{
  "intent": "style.text.axis_label",
  "scope": {
    "figureIds": ["fig_1", "fig_2"],
    "subplotIds": ["*"],
    "targetRole": "y_axis_label",
    "selectionMode": "selected_only"
  },
  "operation": {
    "prop": "fontsize",
    "value": 12
  },
  "commit": {
    "mode": "draft",
    "applyAsOneHistoryStep": true
  },
  "fallback": {
    "onUnsupported": "degrade_gracefully"
  }
}
```

### 字段释义：
* **`intent`**：层级化意图标识（格式：`动作大类.图元分类.语义子类`）。
* **`scope`**：作用域边界。支持跨子图（`subplotIds`）、跨单图（`figureIds`），并根据 `targetRole`（语义角色，如 `y_axis_label`、`legend_container`）实现动态检索。
* **`operation`**：操作载荷。对应要修改的代码/图元属性及目标值。
* **`fallback`**：引擎不兼容时的降级策略（如 R 引擎不支持任意坐标拖拽时，自动降级为 loc 位置对齐）。

---

## 四、 语义编译管道与 AST 回写机制

以**“修改热图色条 (Colorbar) 宽度”**为例，展示意图系统如何精准修改未暴露的参数：

```
 用户在前端拖拽色条宽度 (比如拉宽了 10 像素)
                │
                ▼
 前端生成意图载荷：
 { "intent": "layout.size.colorbar", "targetRole": "heatmap_colorbar", "operation": { "prop": "fraction", "value": 0.06 } }
                │
                ▼
 后端“意图编译器 (Semantic Compiler)”接收并解析
                │
         ┌──────┴──────┐
         ▼             ▼
  [Python 引擎分支]  [R 引擎分支]
         │             │
         ▼             ▼
  解析代码 AST，定位   解析 R 脚本，定位
  `plt.colorbar()`    `theme()` 语句，
  添加/更新参数：      添加/更新参数：
  `fraction=0.06`     `legend.key.width = unit(1.5, 'cm')`
```

---

## 五、 平滑迁移路线图 (Migration Roadmap)

为了不影响现有核心功能的稳定性，系统升级将分为三个阶段进行：

### 阶段 1：前端编译适配层 (Frontend Wrapper)
* **目标**：不修改后端接口和数据库结构，仅在前端引入 `src/utils/semanticCompiler.ts`。
* **实现**：当前端产生交互时，由 `semanticCompiler.ts` 读取当前 Manifest，在前端将 `Intent` 翻译为具体的物理 `Gid + Prop + Value` 数组，再通过原有的 `DraftBatch` 和 `/api/figure/patch` 发送给后端。
* **收益**：以零后端风险换取跨图应用精确度提升。

### 阶段 2：后端语义路由与 AST 回写集成 (Backend Native AST Integration)
* **目标**：后端提供 `/api/figure/intent` 接口。
* **实现**：前端直接发送 Intent 载荷。Node.js 后端服务调用 `introspector.py` 内部的 AST 语法分析器，直接根据语义角色定位并修改 Python/R 代码源文件，重新编译生成 SVG。
* **收益**：网络载荷减少 90% 以上，实现对隐性参数（如热图色条、复杂子图边距）的完美控制。

### 阶段 3：意图级历史日志与崩溃防范 (Semantic Replay & Audit)
* **目标**：数据库 `sessions` 的 `edit_log` 字段改存 Intent 序列，实现不可逆的数据防损坏。
* **实现**：撤销/重做、更新数据源操作完全基于 Intent 历史链重放。
* **收益**：数据源即使发生更新，用户的图表排版样式依然能完美自动重构，达到学术出版级别的稳定性保障。
