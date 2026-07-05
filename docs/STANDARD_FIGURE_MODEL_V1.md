# StandardFigureModel v1

## 目标

把 Python Matplotlib 与 R ggplot 的运行结果统一成同一套前端可消费协议，降低后续组件中心、字体中心、配色中心、拖拽和导出的重复适配成本。

## 当前阶段范围

本阶段只新增契约层和归一化工具：

- 新增 `StandardFigureModel` 类型。
- 新增 `normalizeFigureModel()` / `normalizeRenderResponse()` / `normalizeProjectFigures()`。
- 保留原始 `manifest` 与 `svg`，不改变 Python 或 R 渲染器输出。
- 不修改现有 UI 读写路径。
- 不修改后端 API 返回结构。

## 非目标

本阶段不做以下事项：

- 不合并 Python 与 R 渲染器。
- 不重写 `RightSidebar`、`ChartPreview` 或 `MainWorkspace`。
- 不改变 editLog 语义。
- 不新增数据库字段。
- 不改变导出路径。

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

## 后续迁移顺序

1. 只读接入：让调试面板/日志输出 `StandardFigureModel`，不影响编辑。
2. 组件中心接入：从 `model.objects` 读取对象，不再直接判断 Python/R。
3. 字体/配色中心接入：按 `role/kind/editable` 分组，不再散落 `generatedBy` 分支。
4. 拖拽接入：只处理 `model.objects` 中支持 position/bounds 的对象。
5. 后端可选接入：API 可增加 `standardFigures` 字段，但保留旧字段直到前端完全迁移。

## 验证标准

- `npx tsc --noEmit` 通过。
- `npm run build` 通过。
- Python/R 现有渲染测试不退化。
- 现有 UI 不出现行为变化，因为本阶段没有接管业务路径。
