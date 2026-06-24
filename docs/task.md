# SciFigure IFC V3.1 — 任务清单

- `[x]` **LeftSidebar 修复**
  - `[x]` 导入 React，修复 `React.DragEvent` namespace 编译错误
  - `[x]` 将 `spine_group` 匹配加入 `axesObjects` 过滤，归类到坐标系中
- `[x]` **RightSidebar 修复**
  - `[x]` 修复 `renderTextInput` 缺参数导致的 4 处 TS2554 编译错误与同步问题
  - `[x]` 实现 GroupPanel 多选状态、Shift/Click 连选及卡片复选框
  - `[x]` 实现 GroupPanel 顶部的 “批量编辑已选分组” 批量控制面板 (修改填充、边框色、线宽、不透明度、可见性)
  - `[x]` 为分组卡片增加 EdgeColor (组边框颜色) 独立控制器
  - `[x]` 实现自定义配色预设的删除按钮及其 `localStorage` 同步逻辑
- `[x]` **验证**
  - `[x]` 运行 `npx tsc --noEmit` 进行 TypeScript 编译校验
  - `[x]` 启动预览或检查功能是否正常运作
