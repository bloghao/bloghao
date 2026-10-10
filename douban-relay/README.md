# douban-relay —— 豆瓣中转（书影音卡片插件的自建数据源）

「书影音卡片」编辑器插件（`public/plugins/douban-media.js` + `src/douban.ts`）从豆瓣抓封面与评分。
豆瓣对数据中心 IP（含 Cloudflare Workers 出口）风控很紧，**直连大概率被拒**。这个目录是一个
**零依赖、单文件**的 Node 中转服务，跑在你自己的服务器上（本文以 Oracle Cloud 为例），
给博客一个「固定出口 IP + 持久 Cookie + 低频节奏 + 磁盘缓存」的豆瓣访问通道。

```
编辑器插件 ──同源──▶ 博客 Worker（src/douban.ts，解析+组卡）
                        │  https + Bearer Token
                        ▼
                 douban-relay（本目录，甲骨文服务器）
                        │  白名单代理 / 缓存 / 限速 / Cookie
                        ▼
                  book·movie·music.douban.com
```

中转只做代理与保护，**不做解析**——解析始终在博客端，豆瓣改版只需改一处。
未配中转时 Worker 会直连豆瓣并自动落备用源（Google 图书 / TMDB / iTunes），
所以插件没有中转也能用，只是拿不到豆瓣评分。

## 防封设计（为什么这样不会很快被封）

| 措施 | 说明 |
| --- | --- |
| 磁盘缓存 | 搜索与条目页 6 小时、封面图 30 天——同一本书第二个人搜**不碰豆瓣** |
| 每主机节奏 | 对 douban.com 的请求间隔 ≥1.6s（+随机抖动），同主机严格串行 |
| 指数退避 | 被 sec 挑战 / 403 / 429 即进入冷却 5 分钟 → 封顶 1 小时，冷却期内不再触碰豆瓣 |
| Cookie 维持 | 自动持久化豆瓣下发的 `bid` 等 Cookie（重启不丢）；注入登录态后是风控最低的一档 |
| 浏览器指纹 | 固定真实 Chrome UA + `Referer`/`Accept-Language` 等完整请求头，不玩随机化 |
| 域名白名单 | `/api/fetch` 只代理 `*.douban.com`，`/img` 只代理 `*.doubanio.com`，其余一律 403 |
| 不碰加密接口 | 只用搜索联想接口（`/j/subject_suggest`）与条目页，不解析加密搜索页（那种方案改版即死） |
| 备用源兜底 | 豆瓣失败自动落 Google 图书（书）/ TMDB+iTunes（影）/ iTunes（音），卡片照样能插 |

**已知边界**：豆瓣音乐搜索联想接口已下线（实测恒空），音乐搜索走 iTunes；
豆瓣音乐**条目详情页**不设防，粘贴链接仍可直取评分。电影条目页风控最紧，
建议按下节注入登录 Cookie。

> 豆瓣没有开放 API，本服务是低频个人用途的网页抓取，请保持默认节奏、勿加大并发。

## 部署（Oracle Cloud，Ubuntu 为例）

前提：一台甲骨文 VM（ARM/x64 均可，1GB 内存足够）、一个解析到它的域名子域
（如 `douban.example.com`，TLS 是硬要求——博客端只接受 https 中转地址）。

### 1. 装 Node 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. 放代码 + 生成令牌

```bash
sudo mkdir -p /opt/douban-relay && sudo chown $USER /opt/douban-relay
# 把本目录的 server.cjs 拷到 /opt/douban-relay/
cd /opt/douban-relay
openssl rand -hex 24   # 生成中转令牌，记下来，插件设置里要填
```

### 3. systemd 常驻

`sudo tee /etc/systemd/system/douban-relay.service`：

```ini
[Unit]
Description=douban-relay for bloghao media cards
After=network-online.target

[Service]
User=www-data
WorkingDirectory=/opt/douban-relay
# DOUBAN_RELAY_TOKEN 必填；DOUBAN_COOKIE 可选（强烈建议，见下节）
Environment=DOUBAN_RELAY_TOKEN=把上面生成的令牌贴这里
Environment=DOUBAN_COOKIE=
ExecStart=/usr/bin/node /opt/douban-relay/server.cjs
Restart=always
RestartSec=5
# 数据（缓存/cookie）落 /opt/douban-relay/data，欲迁移整目录打包即可

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now douban-relay
curl -s -H "Authorization: Bearer 你的令牌" http://127.0.0.1:8787/api/health
# {"ok":true,"uptime":…}  即正常
```

### 4. Caddy 反代（自动 HTTPS）

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`：

```
douban.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

甲骨文控制台 → 实例 → 子网 → 安全列表，放行入站 **TCP 443**（80 供 Caddy 签证书）。
DNS 加一条 `douban` A 记录指向实例公网 IP。

### 5. （强烈建议）注入豆瓣登录 Cookie——支持多小号轮换池

浏览器登录豆瓣 → F12 → Network 里任意请求的请求头复制整段 `Cookie:` 值
（或至少含 `dbcl2` / `ck` 的部分）→ 填进 `DOUBAN_COOKIE=`。**注册 2-3 个豆瓣小号、
各登录一次取 Cookie，用 `|||` 分隔**，就是一个轮换池：

```ini
# 三个小号组成池子：某号被风控只冷却该号（5 分钟起指数、封顶 1 小时），
# 请求自动换下一个号，不连累其他号；全部号都在冷却时才整体歇菜
Environment=DOUBAN_COOKIE= Cookie一号 ||| Cookie二号 ||| Cookie三号
```

```bash
sudo systemctl restart douban-relay
curl -s -H "Authorization: Bearer 你的令牌" http://127.0.0.1:8787/api/health
# {"ok":true,...,"cookiePool":{"size":3,"cooling":0}}  ← 池状态在这里看
```

小号使用须知：**要有一定活跃度**（新注册的号高频访问死得快）；查询节奏、缓存、
退避全部由中转统一掌握，账号侧零操作；Cookie 失效（约数月）表现为该号频繁冷却，
换一次即可。登录态是豆瓣风控最松的一档，比裸 IP 稳得多。

## 博客端接线

后台编辑器 → 书影音按钮 → 「设置 · 豆瓣中转与备用源」：

- **中转地址**：`https://douban.example.com`
- **中转令牌**：第 2 步生成的令牌
- 点「测试中转」应显示「中转连通 ✅」

设置存浏览器 localStorage（`bloghao-plugin-douban-media-*`），不进博客 settings，
换浏览器需重填一次。插件的启停在后台「插件」页（`pluginsDisabled`），
**停用即端点同步 404**。

## API

| 路由 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/health` | Bearer | `{ok, uptime, cacheFetch, cacheImg, cooldownUntil}` |
| `GET /api/fetch?u=<douban url>` | Bearer | `{status, body, finalUrl}` 或 `{blocked: true, cooldownUntil?}`，6h 缓存 |
| `GET /img?u=<doubanio url>` | 无（限频 120/分/IP） | 图片字节，30 天缓存。豆瓣 CDN 有防盗链（无 Referer 418、外站 Referer 403）的**兜底通道**——正常情况下封面在插卡时已转存进博客自己的 R2 图床（零配置可用），仅转存失败且配了中转时，卡片封面才退回 `/img` |
