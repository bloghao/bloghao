# 小机部署清单（1GB 内存甲骨文 ARM / E2.1.Micro）

> 与 [DEPLOY.md](DEPLOY.md) 的区别：那份面向 4核8G 舒适跑 100 站的通用机器；
> 这份针对 **1GB 内存小机**（Oracle Always Free E2.1.Micro：2 vCPU 线程 / 1GB 内存 /
> 2GB swap / ~47GB 系统盘），目标 **30~50 个博客二级站**，按「先本地盘、后期逐租户迁 R2」
> 的节奏。容量依据见文末「小机容量账」。

## 0. 重装系统（这台机器曾是 «杂役机» 的话必做）

重装后先做安全底座，再装任何服务：

```bash
# 1) SSH 密钥登录（重装时注入；确认密码登录已关）
sudo grep -E "^PasswordAuthentication" /etc/ssh/sshd_config    # 期望 no

# 2) 防火墙：只放 22/80/443（iptables 与云安全组两层都确认）
sudo iptables -L INPUT -n --line-numbers | head    # Oracle Ubuntu 镜像自带 netfilter 规则
# Oracle 云控制台 → 实例 → 子网 → 安全列表：放行 0.0.0.0/0 的 TCP 80、443

# 3) 确认 swap 在（1GB 机的保险丝，构建期靠它）
free -h     # Swap 应约 2.0Gi；没有就补：见文末「swap」
```

## 1. 装 Docker + 拉代码

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu && newgrp docker   # 免 sudo 跑 docker
git clone https://github.com/bloghao/bloghao.git && cd bloghao/docker-poc
```

1GB 机**不建议在服务器上构建镜像**（esbuild 快，但 npm install 阶段容易撞 swap）。
二选一：

- **A. 直接试**（首次无缓存，可能要几分钟，失败再用 B）：
  `docker compose build`
- **B. 本地构建上传**（推荐，任何云主机都适用）：

  ```bash
  # 本地（仓库根目录）：
  docker build -f docker-poc/Dockerfile -t xwblog:v1 .
  docker save xwblog:v1 | gzip > xwblog-v1.tar.gz
  scp xwblog-v1.tar.gz ubuntu@服务器IP:~/
  # 服务器：
  docker load < ~/xwblog-v1.tar.gz
  # 然后改 docker-compose.yml 的 image: 为 xwblog:v1，并注释掉 build: 段
  ```

## 2. 起服务（关键：绑回环）

公开服务器上容器**永远只绑 127.0.0.1**，公网入口交给反代：

```bash
XWLBLOG_BIND=127.0.0.1 XWLBLOG_PORT=8787 docker compose up -d
docker compose ps      # 状态 up
curl -s -H 'Host: main.localhost' http://127.0.0.1:8787/api/health   # 200
```

> 为什么不直接挂 80：1GB 机建议同时跑一个 Caddy（下一节），80/443 归它；
> 且 `docker compose up` 在环境变量与首启不一致时会**按新变量重建容器**——
> 忘带 `XWLBLOG_BIND=127.0.0.1` 重跑一次 up 就会把容器重建回 0.0.0.0 公网裸奔。
> 养成「起服务永远带全变量」或干脆写进 `.env`（`echo 'XWLBLOG_BIND=127.0.0.1' > .env`）。

## 3. Caddy 反代（HTTPS 终结，比 openresty 省心）

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
{
    # 泛域名按需签证书：来一个租户加一行（或用 on_demand 自动签，见下）
}
# 透传 Host 头是多租户路由的命脉（Caddy 反代默认透传，不用配）
*.你的域名.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:8787
    # 图片直接吐盘、带长缓存，连应用都不过（1GB 机的省内存大招）
    handle /images/* {
        root * /home/ubuntu/bloghao/docker-poc/data/{labels.3}/uploads
        file_server
        header Cache-Control "public, max-age=31536000, immutable"
    }
}
EOF
```

- 泛域名证书用 DNS-01 challenge：Cloudflare 控制台建一个 API Token（Zone.DNS 编辑权限），
  `sudo systemctl edit caddy` 加 `Environment=CF_API_TOKEN=xxx`
- 记得把 `你的域名.com` 和 `*.你的域名.com` 的 NS 托管到 Cloudflare，A 记录 `*` 与 `@`
  指向服务器 IP、**开橙云**；SSL/TLS 模式用「**完全（严格）**」（Caddy 有真证书，别用灵活）
- 访客 IP 档位：Caddy 本机反代形态用默认 `TRUST_PROXY=proxy` 即可（取 XFF 最后一跳，
  客户端伪造不进来）；docker-compose 里别显式设 `TRUST_PROXY=cf`——橙云在 Caddy 之外，
  到达容器时 `CF-Connecting-IP` 已不是 CF 边缘直写，档位语义不成立
- `{labels.3}` 取 `blog1.你的域名.com` 的第一段做目录名，对应 `data/tenants/<域名>/uploads/`——
  Caddy 占位符按 `.` 切片编号，多级域名（`a.b.你的域名.com`）要相应调数字；不放心就把
  `/images/` 直出这条 `handle` 删掉，先全量过应用（功能等价，只是慢一点点）

**不加 Caddy 的替代**：Cloudflare 灵活 SSL + 容器直接挂 80（DEPLOY.md 排练期的做法）。
省一个反代的内存（Caddy 约 30~40MB），代价是 CF 到源站明文、且 80 被容器独占。
1GB 机内存账算得过来，**建议还是上 Caddy**。

## 4. 开租户（日常动作，add-tenant.sh 一条命令）

```bash
./add-tenant.sh blog1.你的域名.com            # 真实站：空库
./add-tenant.sh try.你的域名.com --demo       # 尝鲜体验站：演示种子，每 2 小时清库重灌
./add-tenant.sh blog1.你的域名.com --remove   # 下线（数据保留在盘上）
```

脚本做了什么：tenants.json 登记域名（jq/node 原地改写，**保持 inode 不变**——单文件
bind mount 换 inode 容器会看不到新配置）→ 重启容器 → 容器内按 Host 头探测
`/api/health` 直到 200。DNS 侧因泛域名已解析，**无需再加记录**。

访客打开 `https://blog1.你的域名.com` 即见博客，进 `/admin/` 创建管理员开写。

## 5. 图片存储：先本地盘，后期迁 R2

- 默认即本地盘：`data/tenants/<域名>/uploads/`，随租户目录走
- 1GB 机 / 47GB 盘的软上限约 **40~60 个带图站**（0.5~2GB/站）——到量前开始迁
- 迁移是**逐租户、幂等**的，每天迁几个都行（详细步骤见 README「存储后端」）：

  ```bash
  # 1) Cloudflare 建 R2 桶 + API 令牌（对象读写），tenants.json 顶部加 "r2" 共享配置
  # 2) 存量图片入桶（幂等，本地目录保留作回退）：
  docker compose exec xwblog node docker-poc/dist/server.js --copy-local-to-r2 blog1.你的域名.com
  # 3) 该租户配置改 "storage": "r2"，重启容器
  # 4) 验证旧文章图片全部 200 后，磁盘回收随缘（本地副本是回退保险）
  ```

- 迁 R2 的额外收益：应用每晚 00:30 的备份快照自动变成**异地备份**（落在桶里）

## 6. 小机日常维护

| 事项 | 做法 |
|---|---|
| 升级代码 | 服务器上 `git pull && XWLBLOG_BIND=127.0.0.1 docker compose up -d --build`（撞 swap 就走 §1-B 本地构建） |
| 看日志 | `docker compose logs --tail 100 -f` |
| 备份 | 应用内备份自动跑（各租户 `uploads/backups/` 滚动 30 份）；整机兜底：`tar czf /tmp/tenants-$(date +%F).tgz data/tenants/` 后 scp 拉回本地，每周一次 |
| 恢复一个租户 | 新机起服务后把该租户目录 rsync 回 `data/tenants/` + tenants.json 登记（租户即目录，天然可搬迁） |
| 监控 | Uptime-Kuma / UptimeRobot 拨测各域名 `/api/health`；本机再挂一个 `docker stats` 看内存 |
| 内存紧张时 | `docker stats` 看进程 RSS；swap 用满才需要扩容——日常 50 站内不应触顶 |

## 7. 小机容量账（为什么是 30~50 个）

依据同仓库 REHEARSAL-REPORT.md 实测外推：3 租户单进程 RSS 64MB、**每租户增量 ~7MB**、
单页渲染 1~3ms CPU。

| 资源 | 1GB 机可分 | 50 站需求 | 结论 |
|---|---|---|---|
| 应用内存 | ~600MB（裸系统 + Caddy + Docker 后） | 45MB 进程 + 租户懒建连接 | 富余 |
| swap 2GB | 构建期保险丝，日常空载 | — | 保住即可 |
| CPU（1/8 OCPU 基线，可突发） | 低流量博客无感；每分钟 cron 扫全租户 3~8s | — | 不是瓶颈 |
| **磁盘 ~47GB** | 留 10GB 给系统/日志 → 37GB | 0.5~2GB/站 → **19~37 站** | **真瓶颈，靠迁 R2 解** |

**图片全迁 R2 后，磁盘瓶颈解除，小机内存可支撑到 ~80 站**——下一步是换 4G/24G 的
A1 Flex（Always Free 同样免费），租户目录 rsync 即迁走。

## 附：swap（重装后若被精简）

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
