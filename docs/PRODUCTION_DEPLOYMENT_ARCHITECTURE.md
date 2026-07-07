# SciFig 线上生产环境部署与运维架构设计

本文件详述了 SciFig 平台从单机 Docker 走向云端多节点、分布式高可用生产环境的物理部署方案、网络拓扑、CI/CD 流程及监控告警设计。

---

## 1. 生产环境物理部署拓扑 (Deployment Topology)

为保证高并发下的系统稳定及资产物理隔离，生产环境采用**“计算与 Web 服务解耦、数据持久化共享”**的云原生架构。

```mermaid
graph TD
    Client[客户端浏览器] -->|HTTPS TLS 1.3| CF[Cloudflare CDN / WAF]
    CF -->|安全清洗流量| ALB[应用负载均衡器 ALB]
    
    subgraph Web 节点集群 (Stateless Node.js Cluster)
      ALB --> Node1[Node.js Pod 1]
      ALB --> Node2[Node.js Pod 2]
    end
    
    subgraph 共享存储与数据库
      Node1 -->|挂载/NFS 协议| EFS[(AWS EFS / 共享分布式文件系统)]
      Node2 -->|挂载/NFS 协议| EFS
      EFS --> DBs[(用户数据库 data/users/:userId/user.db)]
      EFS --> CSVs[(用户数据集 data/users/:userId/projects/)]
      
      Node1 -->|读写| GlobalDB[(AWS RDS / PostgreSQL 全局用户库)]
      Node2 -->|读写| GlobalDB
    end

    subgraph 消息队列与无服务器画图沙箱
      Node1 -->|写入任务| Queue[Redis / AWS SQS 渲染任务队列]
      Node2 -->|写入任务| Queue
      Queue --> WorkerPool[云端 Serverless 运行池 / AWS Lambda]
      WorkerPool -->|拉取 python/R 镜像执行绘图| S3[(AWS S3 / 静态导出资产桶)]
      Node1 -->|读取导出的二进制| S3
    end
```

---

## 2. 核心架构设计

### 2.1 Web 服务节点无状态化 (Stateless Web Nodes)
* **全局数据迁移**：单机版中存储在 `scifigure.db` 内的全局用户数据（`users`, `subscriptions`, `redeem_codes` 等）在生产环境迁移至高可用的关系型数据库（如 **Amazon RDS PostgreSQL** 或 **MySQL Cluster**）。
* **分布式文件挂载**：使用云端分布式共享文件系统（如 **AWS EFS** 或阿里云 **NAS**）挂载在容器的 `/app/data` 目录。
  * 确保所有 Node.js 节点共享 `data/users/:userId/db/user.db`（SQLite 数据库文件）及上传的原始 CSV 数据。
  * 针对 SQLite over NFS/EFS，必须在启动时执行 `db.pragma('journal_mode = WAL')`，并开启文件系统锁协议，防止多节点并发连接时的文件损坏。

### 2.2 渲染计算解耦（无服务器画图沙箱）
* **痛点**：如果在 Node.js 容器内直接 `spawn` 执行 Python/R 脚本，密集绘图会导致 Web 容器 CPU 暴涨，直接导致健康检查失败及节点频繁重启。同时，恶意代码可能会读取服务器系统文件。
* **解耦方案**：
  * **API 网关/队列**：Node.js 接收到渲染请求后，将 spec 载荷写入 Redis 或 AWS SQS 队列。
  * **Serverless 绘图**：由独立的 **AWS Lambda** 或 **Google Cloud Run** 从队列拉取任务。绘图容器预装了 Python/R 镜像，并处于**完全断网（No Internet Access）**的沙箱运行态。
  * **S3 静态分发**：Worker 绘制完成后的 SVG/PDF 直接上传到 **AWS S3**，并将 S3 URL 写入用户的专属 SQLite 数据库。Node.js 收到任务完成通知后返回给前端。
  * **优势**：Web 容器保持极轻量（不需安装 Python/R 等 1.5GB 环境），秒级启动。

---

## 3. 生产环境 Docker 容器优化

在生产环境，我们将 Dockerfile 拆分为**多阶段构建**。Web 节点镜像中剥离 Python/R 运行环境，仅保留 Node.js 服务。

```dockerfile
# ==========================================
# 阶段 1: 前端静态资源构建
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ==========================================
# 阶段 2: 生产环境 Stateless Node.js 运行节点
# ==========================================
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# 仅拷贝构建完成的前端静态资产和后端服务
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY server.ts ./
COPY db.ts ./

# 安装生产依赖 (排除了 devDependencies 且不需要安装编译工具)
RUN npm ci --omit=dev

EXPOSE 3000
CMD ["node", "dist/server.cjs"]
```
* **效果**：镜像大小从 1.8GB（含 Python 解释器、Noto 字体及编译依赖）压缩至 **180MB**，发布与冷启动性能提升 10 倍。

---

## 4. 网络安全与流量治理 (WAF & Cloudflare)

1. **Cloudflare WAF 规则**：
   * 阻止非 HTTPS/1.3 流量访问。
   * 配置速率限制规则：限制单个 IP 访问 `/api/auth/login` 的速率（防止爆破）。
   * 开启恶意 Bot 阻断与 JS 挑战，过滤所有来自已知机房 IP 的爬虫探针。
2. **Nginx 反向代理配置**：
   * 在 Node.js 前端部署 Nginx 充当反向代理与 TLS 终结：
   ```nginx
   server {
       listen 443 ssl http2;
       server_name app.scifigure.com;

       ssl_certificate /etc/ssl/certs/scifigure.crt;
       ssl_certificate_key /etc/ssl/private/scifigure.key;
       ssl_protocols TLSv1.3;

       # 静态文件直接由 Nginx 缓存分发，不经过 Node 进程
       location /assets/ {
           root /app/dist;
           expires 1y;
           add_header Cache-Control "public, no-transform";
       }

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

---

## 5. CI/CD 自动化流水线 (GitHub Actions / GitLab CI)

自动化流水线在每次合并至 `main` 分支时自动触发：

```yaml
name: Production Deployment Pipeline

on:
  push:
    branches: [ main ]

jobs:
  test-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm ci
      - name: Run Type Check & Lint
        run: |
          npx tsc --noEmit
          npm run lint
      - name: Run Jest/Vitest
        run: npm run test

  build-and-push:
    needs: test-and-lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Log in to Registry (AWS ECR)
        uses: aws-actions/amazon-ecr-login@v2
      - name: Build and Push Docker Image
        run: |
          docker build -t scifigure-web:latest .
          docker tag scifigure-web:latest ${{ secrets.ECR_REGISTRY }}/scifigure-web:latest
          docker push ${{ secrets.ECR_REGISTRY }}/scifigure-web:latest

  rolling-update:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Kubernetes Cluster (EKS)
        run: |
          kubectl set image deployment/scifigure-web web=${{ secrets.ECR_REGISTRY }}/scifigure-web:latest --record
          kubectl rollout status deployment/scifigure-web
```

---

## 6. 日志、监控与指标告警 (Observability)

1. **分布式日志收集 (ELK / AWS CloudWatch)**：
   * Node.js 服务使用 `winston` 将所有结构化日志（JSON 格式）输出至 `stdout`。
   * 使用 `Logstash` 或 `Fluent-Bit` 代理自动收集控制台日志并汇总。
2. **Prometheus 系统监控指标**：
   * 在 Express 中引入 `/metrics` 端点，收集指标：
     * `http_requests_total` （请求吞吐量）
     * `nodejs_memory_heap_used_bytes` （内存占用，防止 OOM）
     * `active_renders_waiting_count` （渲染队列积压排队数）
3. **Sentry 实时崩溃捕捉**：
   * 前端与后端均接入 Sentry。当触发 React 异常边界（ErrorBoundary）或 Node 进程 `uncaughtException` 时，秒级上报至 Sentry，并推送到飞书/钉钉报警群。
