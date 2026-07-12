# SciFig 生产用户数据安全运行手册

## 1. 安全目标

本手册只处理用户数据、数据库、上传文件、导出资产和备份安全，不改变绘图、编辑、渲染或导出功能。

生产环境必须同时满足：

```text
运行中的数据位于加密云盘或加密块存储
备份在离开服务器前已加密
数据库备份使用 SQLite 一致性快照
应用进程只能访问自己的数据目录
用户数据和渲染诊断不得进入 Git
备份必须定期执行真实恢复验证
```

## 2. 数据边界

需要保护的内容：

```text
/srv/scifigure/data/scifigure.db
/srv/scifigure/data/projects/**
用户上传的 CSV/XLSX/TSV/TXT
保存的项目脚本、编辑记录和 Figure manifest
SVG/PNG/PDF/TIFF 导出资产
认证会话、订阅和兑换记录
备份仓库密码和云存储访问凭据
```

不得放入应用镜像或 Git 的内容：

```text
.env
data/
tmp/
output/
test-results/
.playwright-mcp/
render diagnostic 文件
SQLite 数据库、私钥和云访问密钥
```

仓库门禁命令：

```bash
npm run security:repo-boundary
```

该检查已接入 `.github/workflows/security-baseline.yml`。

## 3. 云盘加密

### 3.1 推荐方案

在创建云服务器数据盘时直接启用云厂商 KMS 加密，并将数据盘挂载到：

```text
/srv/scifigure/data
```

如果 Web 服务运行在 Docker 中，将宿主机加密目录绑定到容器现有数据目录：

```yaml
services:
  scifigure:
    volumes:
      - /srv/scifigure/data:/app/data
```

应用仍使用现有 `/app/data` 读写路径；`SCIFIGURE_DATA_DIR` 仅供宿主机备份脚本定位数据，不改变应用的数据接口。

要求：

```text
系统盘和数据盘均启用静态加密
KMS 密钥与应用账号分权管理
禁止使用未加密的临时云盘保存用户数据
云盘快照必须继承 KMS 加密
生产、测试、开发使用不同密钥
```

应用仍按普通文件系统读写，不需要修改绘图代码。磁盘加密对应用透明。

### 3.2 Linux 权限

示例：

```bash
sudo install -d -o scifigure -g scifigure -m 0700 /srv/scifigure/data
sudo chown -R scifigure:scifigure /srv/scifigure/data
sudo chmod -R u=rwX,go= /srv/scifigure/data
```

挂载参数建议包含：

```text
nodev,nosuid,noexec
```

`noexec` 不影响平台，因为用户 Python/R 代码在独立 renderer 沙箱中执行，不应直接从数据盘执行文件。

## 4. 加密备份

仓库提供：

```text
ops/backup/scifigure-backup.sh
ops/backup/scifigure-restore-verify.sh
ops/systemd/scifigure-backup.service
ops/systemd/scifigure-backup.timer
```

备份工具使用 restic。restic 在客户端完成加密，远端对象存储只能看到加密后的数据块。

### 4.1 依赖

```bash
sudo apt-get install -y restic sqlite3 rsync
```

### 4.2 密钥文件

```bash
sudo install -d -o root -g scifigure -m 0750 /etc/scifigure
sudo sh -c 'umask 077; openssl rand -base64 48 > /etc/scifigure/restic-password'
sudo chown root:scifigure /etc/scifigure/restic-password
sudo chmod 0400 /etc/scifigure/restic-password
```

密钥文件不能放在 Git、应用目录、Docker 镜像或普通备份中。生产环境应将其托管到云密钥服务或机密管理服务，并限制只有备份任务可读取。

### 4.3 备份环境文件

`/etc/scifigure/backup.env` 示例：

```bash
SCIFIGURE_DATA_DIR=/srv/scifigure/data
RESTIC_REPOSITORY=s3:s3.example.com/scifigure-backups/production
RESTIC_PASSWORD_FILE=/etc/scifigure/restic-password
AWS_ACCESS_KEY_ID=replace-with-scoped-backup-account
AWS_SECRET_ACCESS_KEY=replace-with-secret-manager-injected-value
SCIFIGURE_BACKUP_KEEP_DAILY=7
SCIFIGURE_BACKUP_KEEP_WEEKLY=4
SCIFIGURE_BACKUP_KEEP_MONTHLY=6
```

权限：

```bash
sudo chown root:scifigure /etc/scifigure/backup.env
sudo chmod 0640 /etc/scifigure/backup.env
```

备份账号只允许访问指定备份桶，不允许访问计算实例、数据库管理接口或其他用户数据桶。

### 4.4 初始化和定时任务

```bash
sudo -u scifigure --preserve-env=RESTIC_REPOSITORY,RESTIC_PASSWORD_FILE restic init
sudo cp ops/systemd/scifigure-backup.service /etc/systemd/system/
sudo cp ops/systemd/scifigure-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scifigure-backup.timer
sudo systemctl start scifigure-backup.service
sudo systemctl status scifigure-backup.service
```

备份脚本会：

```text
复制项目文件到一次性 staging 目录
通过 sqlite3 .backup 创建一致性数据库快照
执行 PRAGMA integrity_check
将 staging 目录加密上传到 restic 仓库
执行 7 日、4 周、6 月保留策略
清理本地 staging 目录
```

## 5. 恢复验证

至少每月执行一次：

```bash
sudo -u scifigure /opt/scifigure/ops/backup/scifigure-restore-verify.sh
```

该脚本会校验备份仓库、恢复最新快照到临时目录，并对恢复后的 SQLite 数据库执行完整性检查。

生产恢复流程：

```text
停止 Web 写入和渲染队列
创建当前故障数据盘只读快照
恢复到新的空目录，不覆盖原目录
检查 SQLite integrity_check
核对项目数量、上传文件数量和最近导出记录
切换数据目录或挂载点
启动服务并执行用户隔离和正常渲染 smoke test
确认无误后再保留或销毁旧故障副本
```

恢复目标：

```text
RPO：最多丢失 6 小时数据
RTO：单机 8 核 16 GB 环境目标 2 小时内恢复
```

## 6. Git 历史处理

当前版本已将运行时用户数据从 Git 索引解除跟踪，并增加自动门禁。但旧提交历史中仍可能保留这些文件。

如果历史已经推送到远端，必须单独执行历史清理：

```text
冻结仓库写入
建立远端镜像备份
使用 git filter-repo 清除 data/、tmp/、output/、.playwright-mcp/ 和 tmp_* 文件
强制更新受影响分支和标签
通知所有开发者重新 clone
轮换可能出现在历史中的密钥
验证 GitHub/GitLab 缓存和 Release 附件
```

历史重写会改变 commit hash，属于破坏性仓库操作，不能与普通代码修改一起自动执行。

## 7. 云服务器最低安全基线

```text
仅开放 80/443；SSH 仅允许固定管理 IP
SSH 禁止密码登录和 root 登录，只使用密钥
UFW/云防火墙默认拒绝入站
Node 服务不直接暴露公网，只监听 127.0.0.1 或内网
Nginx 负责 TLS，启用 HSTS 和请求体限制
renderer worker 不暴露公网端口
禁止把 /var/run/docker.sock 挂载到公共 Web 容器
生产 .env 权限 0600，归属 scifigure 服务账号
日志不得记录 token、cookie、密码、兑换码和上传文件内容
```

## 8. 验收清单

```text
[ ] npm run security:repo-boundary 通过
[ ] git ls-files data tmp output 无输出
[ ] 数据盘和快照显示 KMS/云盘加密已启用
[ ] /srv/scifigure/data 权限为应用账号独占
[ ] restic backup 成功
[ ] restic restore verify 成功
[ ] 备份桶账号为最小权限
[ ] 最近 30 天内完成过一次真实恢复演练
[ ] 生产防火墙仅开放必要端口
[ ] 历史 Git 数据泄漏已评估并记录处置结论
```
