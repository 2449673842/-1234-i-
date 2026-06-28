# SciFigure 恢复版基线文档 (2026-06-28)

本文档记录了主线版本在 `E:\ai绘图修改编辑` 目录恢复后的状态、基线测试命令、Smoke Test 验证结果以及已知风险，供后续增量开发参考。

---

## 1. 基础信息

* **基线 Commit**: `b1366a43f3bac69ce05b900f435821d8cfe36be1`
* **恢复时间**: `2026-06-28 23:53`
* **工作区路径**: `E:\ai绘图修改编辑`
* **Python 环境**: `C:\Users\SZC\.conda\envs\Machine-learning\python.exe`

---

## 2. 功能完整性审计表

| 功能模块 | 前端主入口 | 后端 API | 数据库表 | 接入状态 | 运作情况/断链核查 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **组件中心** | `RightSidebar.tsx` (groups 标签页) | `POST /api/figure/patch` | `project_figures.edit_log` | 🟢 已接入 | 运作正常。支持按真实 matplotlib 图元（线条、散点、边框）级联编辑。 |
| **字体中心** | `RightSidebar.tsx` (fonts 标签页) | `POST /api/figure/patch` | `project_figures.edit_log` | 🟢 已接入 | 运作正常。支持一键调整刻度、轴标签、图例字体与大小。 |
| **配色中心** | `RightSidebar.tsx` (palette 标签页) | `POST /api/figure/patch` | `project_figures.edit_log` | 🟢 已接入 | 运作正常。支持对检测出的 runtime/static colors 进行统一修改。 |
| **组合图** | `App.tsx` ➜ `ComposerPage.tsx` | `GET /api/projects/:id/export-assets` | `export_assets` | 🟢 已接入 | 运作正常。支持交互式多图拖拽、缩放及网格辅助线。 |
| **导出资产** | `ExportSettingsPage.tsx` | `POST /api/projects/:id/export` | `export_assets` | 🟢 已接入 | 运作正常。支持 PDF/SVG/TIFF/PNG 格式与自定义 DPI 导出。 |
| **注册/登录/兑换码** | `SettingsPage.tsx` (account 标签页) | `/api/auth/*`, `/api/license/redeem` | `users`, `licenses`, `device_sessions` | 🟢 已接入 | 运作正常。闭环本地验证，未连接假第三方状态。 |
| **介绍页 (Landing)** | `App.tsx` ➜ `LandingPage.tsx` | 无 | 无 | 🟢 已接入 | 运作正常。前端纯展示与导航页。 |

---

## 3. 核心用户流程 Smoke Test 结果 (2026-06-28)

测试脚本：`scratch/smoke_test_core_flow.py`  
运行环境：Conda `Machine-learning` + Node.js TSX dev server (Port 3000)

* **Step 1: 新建项目** ➜ **[PASS]** (成功创建，返回 Project ID)
* **Step 2: 上传单 CSV** ➜ **[PASS]** (成功解析并获取列字段)
* **Step 3: 渲染单图** ➜ **[PASS]** (成功捕获 axes.0, errorbar.0.0, bar.0.1, grid.0 并返回 Session ID)
* **Step 4: 改字体/颜色/坐标范围** ➜ **[PASS]** (成功应用 `title.0.text`, `axis.x.0.limits`, `container.bar.0.0.facecolor` 并更新 editLog)
* **Step 5: 撤销/重做 (History Jump)** ➜ **[PASS]** (成功回退 editLog 长度)
* **Step 6: 导出单图** ➜ **[PASS]** (成功生成 PNG/SVG)
* **Step 7: 组合图导出资产校验** ➜ **[PASS]** (成功在数据库和项目目录校验资产文件)

> [!NOTE]
> 修复了 introspector.py 在读取含误差棒图表颜色时，因 Matplotlib `LineCollection.get_color()` 返回 numpy `ndarray` 导致 JSON 序列化崩溃的 bug。目前所有颜色提取已强制转换为干净的 Hex String。

---

## 4. 已验证的质量保障命令

以下命令在恢复版目录执行，结果全部为 **绿/成功**：

1. **TypeScript 静态检查**:
   ```bash
   npx tsc --noEmit
   # 结果：编译成功，0 错误
   ```
2. **Matplotlib 语义识别单元测试**:
   ```bash
   C:\Users\SZC\.conda\envs\Machine-learning\python.exe -m unittest tests/test_introspection.py
   # 结果：Ran 5 tests in 0.720s. OK (100% 覆盖 Boxplot/Violinplot 容器识别与级联修改)
   ```
3. **前端及服务端构建打包**:
   ```bash
   npm run build
   # 结果：built in 5.37s. dist/server.cjs (85.5kb) 编译完全成功
   ```

---

## 5. 候选未追踪文件归档处理

以下三个文件为从 dangling commit 找回的未追踪资产。为防止造成 TypeScript 类型混淆及路由污染，已将其移动至 `_archive` 目录，并重命名为 `.bak`：

* `src/components/_archive/AuthPage.tsx.bak` (独立登录注册备份)
* `src/components/_archive/ExportLibraryPage.tsx.bak` (旧版导出管理页备份)
* `src/components/_archive/FigureComposerPage.tsx.bak` (旧版 SVG 拼接排版备份)

*注：主线代码中已不再引用这些旧组件。*

---

## 6. 已知风险与后续待办

1. **文本框错位**: 更改文本内容或字号后，Matplotlib 的 Bounding Box 内省位置可能发生偏移。用户需在前端微调或使用 `fig.tight_layout()`。
2. **Palette/Font 中心交互响应**: 调色盘与字体大小一键修改目前在前端有乐观更新，但后端需要重放 editLog 才会更新底层 SVG 文本坐标。后续需进一步优化同步响应速度。
3. **组合图拼合细节**: interactive grid 拖动在大画布边缘可能会有计算漂移，需要在排版器中加入更精准的磁吸对齐逻辑。
