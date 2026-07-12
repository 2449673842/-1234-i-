# XLS/XLSX 解析隔离说明

## 1. 风险背景

旧链路由 Express 进程直接调用 JavaScript `xlsx` 解析用户上传文件。解析器与 Web 服务共享进程、文件权限、环境变量和内存空间，一旦遇到恶意工作簿、压缩炸弹或解析器漏洞，影响范围会扩展到整个 API 服务。

## 2. 当前实现

服务端解析已经迁移到 `renderer/tabular_parser.py`：

- `.xlsx` 使用 `openpyxl`，`.xls` 使用 `xlrd`。
- 只读取第一个 worksheet，保持原有平台行为。
- `metadata` 模式只读取表头，并通过只读 workbook 获取行数，不再加载整张表。
- `records` 模式返回标准化记录，日期转 ISO 字符串，NaN/Inf 转 `null`。
- 预览请求把 `limit` 传入 parser，只读取需要展示的行数，同时保留完整 `row_count`。
- 仅 metadata 按文件路径、大小和 mtime 缓存，最多保留 4 项；完整 records 不进入长期缓存。
- parser 使用异步子进程和独立并发队列，不再通过 `spawnSync` 阻塞 Node 事件循环。

生产环境：

```text
只读挂载单个临时文件
network=none
read-only root filesystem
cap-drop=ALL
no-new-privileges
uid/gid 65532
CPU、内存、PID、/tmp、超时和输出限制
```

开发环境继续支持本地运行，但解析发生在独立 Python 进程中，不再加载到 Express 进程。

上传接口在 Multer 落盘前验证项目所有权。解析失败、超时或输出超限时，尚未写入数据库的上传文件会被清理，避免产生不可见孤立文件。

## 3. 数据边界

parser 只能接收 `data/projects` 边界内、由后端数据库记录定位的文件。服务端先复制到单次任务临时目录，再把该目录只读挂载到容器。parser 不接收客户端任意绝对路径，也不能访问主数据库、`.env` 或其他项目目录。

Docker 构建使用专用 `Dockerfile.renderer.dockerignore`，只允许以下内容进入构建上下文：

```text
Dockerfile.renderer
requirements.txt
renderer/**
```

仓库级 `.dockerignore` 同时排除 `data/`、数据库、`tmp/`、`output/`、Playwright 和测试产物。

## 4. 兼容性与限制

当前保持 `.xls`、`.xlsx`、首 worksheet、列名、行数和记录预览兼容。浏览器端仍保留 `xlsx` 包用于本地预览，因此依赖不会立即从 `package.json` 删除；服务端不再使用该包处理用户工作簿。

生产部署后仍需在 Linux 云服务器复测：

- 大型但合法工作簿是否在资源阈值内完成。
- 中文列名、日期、空值和混合类型是否保持一致。
- 超时后是否不存在残留 parser 容器。
- 解析失败是否返回明确错误且不影响后续上传和渲染。

## 5. 验证记录

```text
tests/test_tabular_parser.py：4/4 通过
npx tsc --noEmit：通过
npm test：8 files / 66 tests 通过
npm run test:renderer-sandbox：通过
npm run build：通过
npm run security:repo-boundary：通过
```

本轮未删除、迁移或覆盖 `data/` 下任何用户数据库、项目文件或导出资产。
