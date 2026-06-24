# V3.2A Project Layer Task Checklist

- [x] **A1: 多文件与沙箱**
  - [x] 数据库扩展：添加 `projects.script` 并创建 `project_files` 表
  - [x] 后端文件上传与管理 API (`POST /api/projects/:id/files`, `GET`, `DELETE`)
  - [x] Python 运行时注入 `_uploaded_file_paths` 并切换 `cwd`
  - [x] Python `pd.read_csv` / `pd.read_excel` 的沙箱路径安全校验 Hook
- [x] **A2: Figure 注册与多图**
  - [x] Matplotlib `Figure.__init__` 劫持与 `plt.get_fignums` 兜底注册机制
  - [x] 多图 Replay Render 逻辑（逐图 Introspect 并 Replay EditLogs）
  - [x] 文本 Artist Manifest 属性拓展 (x, y, coord_system, ha, va, rotation)
  - [x] 后端多 Figure JSON 返回结构
  - [x] 前端 Figure Tabs UI 与每图独立状态管理 (svg, manifest, editLog)
- [x] **A3: 项目 Schema 与 API**
  - [x] 数据库创建 `project_figures` 表保存每张图 of session 状态
  - [x] 后端项目渲染接口 (`POST /api/projects/:id/figures/render`)
  - [x] 后端导出接口与物理文件/资源级清理 (ON DELETE CASCADE)
  - [x] 前端项目文件管理界面 (LeftSidebar 数据列表，上传/删除操作)
