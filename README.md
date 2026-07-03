# SciFigure Studio 4.0

SciFigure Studio 是一款面向科研人员的智能绘图与可视化排版工具。它通过真实的 Python / Matplotlib 渲染引擎、多子图内省分析（Matpector）、组件字体配色中心、组合图工作台以及统一的导出资产库，让科研图表的设计、美化与拼图过程变得前所未有的直观与高效。

---

## 1. 核心特性

- **Matplotlib 引擎真实渲染**：拒绝前端模拟与猜测，直接调用 Python 后端 Matplotlib 渲染，确保 100% 科研级精度。
- **多子图内省与 editLog 重放**：基于 Python AST 校验与 Matplotlib 树形图元（Artist Tree）扫描，智能抓取文本、折线、散点、误差棒、箱线图、热图、色阶与色条，在不损坏数据与代码的前提下支持实时交互式属性编辑。
- **本地撤销与重做时间线 (Undo/Redo)**：在属性编辑与组合图排版中提供了极速的本地状态回退历史栈。
- **对齐辅助与水平均分拼图工作台**：专门针对论文多面板图（如 Fig 1a, 1b）排版设计的 Composer 工作台，提供网格磁吸对齐、边缘对齐及水平/垂直等距重排功能。
- **统一导出资产库**：一站式管理已导出的所有格式（SVG, PNG 等）素材，支持快速多选、批量清退、重新编辑组合。
- **商业化防滥用账号与授权**：内置轻量级的用户登录、注册、设备指纹检测及 Pro 版兑换码激活服务。

---

## 2. 环境依赖

### 前端与服务端 (Node.js)
* **Node.js**：建议使用 Node.js v20.x 或 v22.x LTS 版本。

### 渲染后端 (Python)
* **Python**：建议使用 Python 3.10 及以上版本。
* **必要科学计算库**：包含于 `requirements.txt`：
  ```bash
  matplotlib>=3.8
  numpy>=1.24
  pandas>=2.0
  Pillow>=10.0
  scipy>=1.10
  seaborn>=0.13
  ```

---

## 3. 本地快速启动

### Step 1: 克隆与安装依赖
1. 安装前端及服务端依赖：
   ```bash
   npm install
   ```
2. 安装 Python 渲染环境依赖：
   ```bash
   pip install -r requirements.txt
   ```

### Step 2: 环境变量配置
在项目根目录下复制 `.env.example` 并重命名为 `.env`。
- 如果您的系统 `python` 指向正确的科学计算环境，可直接保持默认值；
- 如果使用的是 Windows 虚拟环境（如 conda）或特定的 Python 安装路径，请取消注释并指定 `PYTHON_BIN`：
  ```ini
  PYTHON_BIN="C:\\Users\\YourUsername\\.conda\\envs\\YourEnvName\\python.exe"
  ```

### Step 3: 启动开发服务器
在根目录下运行以下命令启动开发环境：
```bash
npm run dev
```
启动后可在浏览器中访问：`http://localhost:3000`

---

## 4. 生产环境构建与部署

### Step 1: 执行静态资源打包
运行打包命令以生成前端优化包及压缩的后端 server 单文件：
```bash
npm run build
```
这将在根目录下生成 `dist/` 资源目录及打包后的 Node 后端执行入口 `dist/server.cjs`。

### Step 2: 启动生产服务器
运行以下命令启动生产级别服务：
```bash
npm run start
```

---

## 5. 数据目录架构与备份策略

所有持久化数据均归档于项目根目录下的 `data/` 目录中：
- **数据库**：`data/scifigure.db` (SQLite 数据库文件，记录用户、项目列表、修订版本号与导出资产元数据)。
- **物理文件存储**：`data/projects/` (按照 UUID 分类存放用户上传的数据 CSV 临时副本、自动保存的 `figure_spec.json` 及导出图片资产物理文件)。

### 备份策略
由于整个系统数据文件高度内聚，当进行日常备份、容灾或多服务器迁移时，**仅需将整个 `data` 文件夹打包保存/复制即可**。
