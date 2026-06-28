# Gemini Coding Protocol for SciFigure Studio

> Gemini 专用。任何让 Gemini 修改 SciFigure Studio 代码的任务，必须先复制/引用本文件，并要求它按本文执行。目标是防止无证据判断、无边界重构、未验证交付和覆盖既有功能。

---

## 0. Red Lines

Gemini 不允许用经验判断代替源码证据。

禁止：

- 没读源码就判断原因。
- 没查调用链就修改函数。
- 没确认数据结构就改接口。
- 没查所有调用方就改返回值。
- 没有复现路径就说 bug 已确认。
- 没有回归测试就说修复完成。
- 没有证据就把推断写成事实。
- 修一个问题时顺手改无关模块。
- 一次性做大重构。
- 编造项目中不存在的功能、接口、变量、状态或文件。

如果证据不足，必须写：

```text
当前没有足够源码证据，不能下结论。需要继续读取 XXX 文件 / XXX 函数 / XXX 调用链。
```

---

## 1. Mandatory Preflight

开始任何分析、修复、重构、加功能前，Gemini 必须先输出：

```md
# Preflight

## 1. 我理解的任务

## 2. 我不会修改的内容

## 3. 我必须先读取的源码

## 4. 我已有的证据

## 5. 我还缺的证据

## 6. 初步风险判断

## 7. 是否具备开始修改条件
- 是 / 否

如果否：
- 还需要读取什么
- 还需要确认什么
```

Preflight 不通过，不允许改代码。

---

## 2. Six-Phase Workflow

每个任务必须按 A-F 阶段执行。不能跳阶段。

### A. 任务边界确认

```md
## A. 任务边界确认

本次要解决的问题：

本次明确不解决的问题：

禁止顺手修改的内容：

成功标准：

失败标准：
```

### B. 源码证据收集

下结论前必须读取源码，并输出证据表：

```md
## B. 源码证据收集

| 证据编号 | 文件 | 函数/位置 | 关键代码/行为 | 支撑什么结论 |
|---|---|---|---|---|
```

要求：

- 涉及 API：覆盖前端 request、后端 route、response、类型定义。
- 涉及状态：覆盖 state 定义、写入点、读取点、清理点。
- 涉及 Python/子进程：覆盖 Node 调用点、Python 入口、输入输出结构。
- 涉及导出：覆盖预览路径和导出路径。
- 涉及保存/恢复：覆盖序列化和反序列化。

### C. 问题确认与反证

```md
## C. 问题确认与反证

### 当前假设

### 支持证据

### 反证检查
我检查了哪些可能推翻该假设的代码：

### 结论
- Confirmed / Refuted / Suspected / Gap / Regression

### 为什么不是其他原因
```

没有反证检查，不允许修改代码。

### D. 影响面分析

写代码前必须输出：

```md
## D. 影响面分析

| 模块/功能 | 是否可能受影响 | 为什么 | 是否需要回归测试 |
|---|---|---|---|
| render | 是/否 |  |  |
| patch | 是/否 |  |  |
| local_patch | 是/否 |  |  |
| backend_patch | 是/否 |  |  |
| code_patch | 是/否 |  |  |
| export | 是/否 |  |  |
| save | 是/否 |  |  |
| restore | 是/否 |  |  |
| undo/redo | 是/否 |  |  |
| session/revision | 是/否 |  |  |
| error handling | 是/否 |  |  |
| tests/types | 是/否 |  |  |
```

### E. 最小修复方案

```md
## E. 最小修复方案

修复目标：

不采用大重构的原因：

修改文件：

修改函数：

新增/修改类型：

接口结构是否变化：

数据库结构是否变化：

兼容性策略：

回滚方案：

验证方案：
```

原则：

```text
最小正确修复 > 局部重构 > 全局重构 > 风格优化
```

### F. 实现与验证

完成后必须输出：

```md
## F. 实现与验证

### 修改摘要

### 关键 diff

### 原 bug 复现验证

### 回归测试

### 类型检查/构建结果

### 未验证项

### 遗留风险

### 是否可以进入下一步
```

没有验证，不允许说“完成”。

---

## 3. Evidence Levels

每个结论必须标证据等级。

| 等级 | 含义 | 是否可用于修复 |
|---|---|---|
| E0 | 没有证据，只是猜测 | 不可修 |
| E1 | 看到了单点代码，但没查调用链 | 不可修 |
| E2 | 查了调用链，但没复现 | 可提出方案，不建议直接修 |
| E3 | 源码 + 调用链 + 复现路径成立 | 可以修 |
| E4 | 源码 + 调用链 + 复现 + 测试覆盖 | 优先修 |
| E5 | 已修复并通过回归验证 | 可关闭 |

规则：

- E0/E1 不允许写成事实。
- E0/E1 不允许进入修复。
- E2 必须先补复现或明确风险。
- E3 以上才允许改代码。
- 修完必须升到 E5，否则不能宣称完成。

---

## 4. Bug Status and Severity

状态标签：

| 状态 | 含义 |
|---|---|
| Confirmed | 已确认，源码和复现支持 |
| Refuted | 已被源码推翻 |
| Suspected | 有线索，但证据不足 |
| Gap | 功能缺口或产品承诺不清 |
| Regression | 本次或近期改动引入 |
| Won't Fix | 有问题但当前不修 |
| Deferred | 确认存在但排期后移 |

严重级别：

- P0：服务崩溃、OOM、死锁、子进程泄漏、用户编辑结果静默丢失、核心主流程完全不可用、已开放入口点击必然失败、公网高危安全漏洞。
- P1：核心体验明显受损、状态一致性风险、并发/乱序/幂等问题、导出/保存/恢复与预览不一致、性能随使用退化、安全问题需特定条件。
- P2：体验瑕疵、loading/toast/文案、边界状态、可维护性问题、不阻塞主流程。
- Gap：文档说有但代码没有、UI 有入口但后端没有、Phase 未开始、产品承诺不清。

每个严重级别必须写：

```md
为什么是这个级别：
为什么不是更高级别：
为什么不是更低级别：
```

---

## 5. Change Boundary Rules

### 5.1 单任务原则

每次只解决一个明确问题。发现新问题时记录到“遗留风险”，不要混入本次修改。

### 5.2 接口/类型变更审计

只要改函数返回值、类型、接口 response、request body、数据库字段，必须输出：

```md
## 接口/类型变更审计

变更项：

所有调用方：

| 调用方 | 是否已适配 | 证据 |
|---|---|---|

兼容旧数据/旧调用：

是否需要 migration：

是否需要 feature flag：
```

### 5.3 状态变更审计

只要改 state，必须输出：

```md
## 状态变更审计

状态变量：
写入点：
读取点：
清理点：
是否存在双数据源：
是否存在 stale response：
是否影响 undo/redo：
是否影响 export/save/restore：
```

### 5.4 异步行为审计

涉及 async / fetch / subprocess / timer / debounce / abort，必须输出：

```md
## 异步行为审计

异步入口：
取消机制：
超时机制：
并发场景：
乱序场景：
重复请求场景：
失败回滚：
资源清理：
测试方法：
```

### 5.5 文件系统审计

涉及文件写入、上传、临时文件、导出文件，必须输出：

```md
## 文件系统审计

写入路径：
文件名生成：
是否可路径穿越：
是否有大小限制：
是否清理：
异常时是否清理：
并发是否冲突：
Windows/Linux 是否兼容：
```

---

## 6. SciFigure Studio Specific Rules

### 6.1 render 修改必须检查

- `server.ts`
- `spawnPythonWithPayload`
- `/api/figure/render`
- `/api/figure/patch`
- `/api/figure/code-patch`
- `/api/figure/export`
- `renderer/introspector.py`
- `renderer/ast_validator.py`
- `src/hooks/useFigureSession.ts`

### 6.2 patch 修改必须检查

- local_patch
- backend_patch
- editLog
- revision
- requestId
- baseRevision
- stale response
- syncFigureState
- undo/redo
- export 一致性
- Python `apply_edit_log`

### 6.3 export 修改必须检查

- 预览 SVG 来源
- 导出 SVG 来源
- local_patch 是否重放
- backend_patch 是否重放
- warnings 是否透传
- 高 DPI 重渲染
- bundle 结构
- 失败时前端如何提示

### 6.4 前端状态修改必须检查

- `session.svg`
- `session.manifest`
- `session.editLog`
- `session.revision`
- `draftValues`
- `specHistory`
- selected object
- 是否存在双数据源
- 是否存在 stale response
- 是否影响用户正在输入

### 6.5 Python 修改必须检查

- payload 输入
- stdout JSON 输出
- stderr
- exception handling
- Matplotlib artist 类型
- gid 映射
- editLog 重放
- warnings
- 多图 figure
- 导出一致性

---

## 7. Required Verification

每次修复后至少运行：

```bash
npx tsc --noEmit
npm run build
npm run lint
```

如果某项不存在或失败，必须明确说明原因。不得隐藏失败。

还必须写：

```md
修复前复现步骤：
修复后验证步骤：
结果：
```

根据影响面表做回归。与当前任务相关时，必须测试正常路径、错误输入、请求取消、超时、网络失败、重复请求、并发请求、数据为空、数据超大、旧 session、不支持参数。

---

## 8. Completion Definition

只有满足以下条件才能说“完成”：

1. 问题状态是 Confirmed。
2. 证据等级达到 E3 或以上。
3. 已做最小修复。
4. 已检查影响面。
5. 已跑类型检查或说明无法跑。
6. 已验证原 bug 不再复现。
7. 已做相关回归测试。
8. 已列出未验证项。
9. 已列出遗留风险。
10. 已明确是否可以进入下一步。

否则只能说：

```text
当前只是初步修改，尚未完成验证。
```

---

## 9. Gemini Output Template

Gemini 每次交付必须使用：

```md
# 本次任务执行报告

## A. 任务边界确认

## B. 源码证据收集

## C. 问题确认与反证

## D. 影响面分析

## E. 最小修复方案

## F. 实现与验证

## G. 遗留风险

## H. 下一步建议
```

不要只输出“已修复”。

---

## 10. Current Mainline Guardrails

当前安全主线：

```text
commit: b1366a43f3bac69ce05b900f435821d8cfe36be1
branch: master / origin/master
main path: E:\ai绘图修改编辑
backup path: E:\ai绘图修改编辑_事故备份_copy_20260628_233804
```

没有明确任务时，禁止重构这些核心文件：

- `server.ts`
- `renderer/introspector.py`
- `renderer/ast_validator.py`
- `src/App.tsx`
- `src/components/RightSidebar.tsx`
- `src/components/ChartPreview.tsx`
- `src/hooks/useFigureSession.ts`

如果必须修改，先做证据收集和影响面分析，再给最小修复方案。

---

## 11. Gemini Task Prefix

每次给 Gemini 发任务时，建议先贴这段：

```text
你正在修改 SciFigure Studio。开始前必须先阅读 docs/GEMINI_CODING_PROTOCOL.md，并严格执行其中的 Preflight、A-F 阶段、证据等级、影响面分析和验证要求。

本次只解决我指定的问题。不要顺手重构，不要修改无关模块，不要把推断写成事实。没有源码证据时必须标为 Suspected 或 Gap。没有验证时不能说完成。
```
