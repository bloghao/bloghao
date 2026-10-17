# 广场（博客号内容聚合）

广场是官网 **[bloghao.com/plaza](https://bloghao.com/plaza/)** 上的内容聚合流：所有开通同步的博客号，其公开文章与微博在这里汇成一片可逛的广场——**双视图**（桌面默认卡片墙瀑布流、手机默认河流式）、按「**权重 + 新文推荐 + 随机展示**」混排、**匿名点赞**与近 7 日活跃榜，新站入驻有 7 天聚光扶持。新文有曝光，权重高的站靠前，随机抖动让每次刷新都可能撞见新东西。

```
┌─ 你的博客号 ────────────┐         ┌─ 广场 hub（独立 Worker）─┐         ┌─ 官网 bloghao.com ─┐
│ 发布文章 / 微博          │  push   │ 签名校验 → 入库          │  feed   │ /plaza/ 页面        │
│ 「广场同步」插件自动上报  │ ──────→ │ RSS pull 补漏（cron）    │ ──────→ │ 拉取渲染（ES5）      │
│ 加密/会员锁文自动跳过    │         │ 混排评分 → /api/feed     │  CORS   │                     │
└────────────────────────┘         └─────────────────────────┘         └────────────────────┘
```

## 给博客号站长：三步接入

1. **联系官方**（[GitHub Issues](https://github.com/bloghao/bloghao/issues) 或社区群）提供你的站点地址，审核通过后拿到一枚 **32 位站点 Token**
2. **后台填配置**：「设置 → 服务端插件」→ 广场站点 Token 粘贴进去，保存（广场地址**留空即官方 hub** `https://bloghao.com/plaza`——唯一官方入口，稳定版 / 开发版一律由此接入；自建 hub 才改）
3. **开启插件**：「插件」页 → 服务端插件 → **广场同步（bloghao.com）** 打开

之后**每次发布**（文章 / 微博，后台、定时、开放 API、TG 机器人四条路都算）会自动推一条到广场；重复编辑已发布内容不重推。不想同步了，把插件关掉即可，hub 里的历史内容可请管理员清除。

**不会上广场的内容**：加密访问的文章、会员专属（付费墙）文章——这两类在发布事件里带锁标志，插件直接跳过，标题摘要也不出；RSS 条目同带机器可读锁标志（`<bloghao:locked>1</bloghao:locked>`，bloghao 命名空间），pull 补漏据此跳过。微博配图取首图（站内图自动补站点域名转绝对地址）。

**下架同步（生命周期闭环）**：已收录的文章事后**补设密码 / 升档锁文 / 转回草稿 / 删除**、微博删除时，源站同路推一条 `deleted` 给 hub 摘除条目；解锁或恢复发布后，6 小时内的 pull 补漏自愈补回（未接插件的站只有 pull 一条路，锁标志同样把锁文挡在外面）。

## 广场 hub（自建 / 运维）

hub 是独立服务，源码在仓库 `plaza/` 目录（`src/core.ts` 纯函数 + `src/index.ts` 路由，零 npm 依赖，hono 单文件），Workers（D1 库）与 Node 容器（`demo/hub-node/`，D1→node:sqlite）两种形态都能跑。**官方部署**跑在自有服务器上的 Node 容器，由服务器 Caddy 在 `bloghao.com` 站点块内把 `/plaza/api/*` 路径反代给 hub（去掉 `/plaza` 前缀）——**唯一官方入口 `https://bloghao.com/plaza`**，广场页（`/plaza/` 静态页）与数据面（`/plaza/api/*`）同域，没有独立子域名；**与博客主站完全独立**，不部署也不影响博客系统。

```bash
# 部署自己的 hub（自托管场景）
npx wrangler d1 create plaza-db          # database_id 填进 plaza/wrangler.jsonc
npx wrangler d1 execute DB --remote --file plaza/schema.sql
npx wrangler secret put PLAZA_ADMIN_TOKEN
npx wrangler secret put PLAZA_HASH_SECRET   # 可选但建议：点赞/曝光天级哈希私盐（不配则退化弱隐私）
npx wrangler deploy -c plaza/wrangler.jsonc
```

自建 hub 的博客站把「设置 → 服务端插件 → 广场地址」改成自己的 hub 域名即可，协议完全一致。

### 管理端点（Bearer PLAZA_ADMIN_TOKEN）

| 端点 | 说明 |
| --- | --- |
| `POST /api/admin/sites` | 注册站点 `{"url":"https://…","name":"显示名"}`，**token 明文只在此返回一次** |
| `GET /api/admin/sites` | 站点列表（含 token、心跳、条数） |
| `PATCH /api/admin/sites/:id` | 局部更新：`name` / `avatar`（站点头像 https，空串清除）/ `verified`（认证徽标）/ `weight`（0-10）/ `disabled` / `pullEnabled` / `rotateToken:true` |
| `GET /api/admin/stats` | 全局统计：站点 / 内容 / 今日与累计调用（feed≈广场页访问、ingest 上报）/ 近 14 天趋势（ops 控制面消费） |
| `DELETE /api/admin/sites/:id` | 删站并级联清内容 |
| `PATCH /api/admin/items/:kind/:ref?siteId=N` | body `{"hidden":true}` 下架单条（违规处置） |

### 公开端点

- `GET /api/feed?limit=30&kind=post|weibo&site=N`——混排 feed（CORS 全开，官网直接消费）。`site=N` 进站点视图（B25 P0.1）：出参多一个 `site` 块（`{id, name, url, avatar, verified, createdAt}`）供页头渲染；站点不存在 / 已停用 404。每条条目带 `id`（hub 侧主键，点赞目标）与 `likes`（点赞累计）
- `GET /api/sites`——站点名录（认证标、总条数、`recentItems` 近 7 日条数——侧栏活跃榜 / 最新入驻 / 新站「新」标的数据面）
- `POST /api/ingest`——博客端上报（协议见下）
- `POST /api/like`——匿名点赞（B25 P2.1）：`{"itemId": <feed 条目 id>, "vid": "<32hex>"}`；防重 = localStorage 记已赞 + hub 端天级去重（每 IP 每条 1 次/天、每会话 60 次/天、每 IP 全场 200 次/天）；返回 `{ok, likes}` / `{ok, duplicate:true}`；限流 429。hub 不存原始 IP / vid，只存「北京日 + 服务端私盐」的哈希（`PLAZA_HASH_SECRET` 非空时走 HMAC-SHA256，库泄露也无法枚举还原 IP/vid；未配则退化为 sha256(day:value) 兼容兜底）；跨日不可串联，去重日志 7 天前由 cron 清掉
- `POST /api/beacon`——曝光/点击批量回传（B25 P2.2）：`{"events":[{"s":<siteId>,"k":"v"|"c","n":<次数>}]}`，≤50 条、单条 n≤20；官网页攒批（10 条 / 30 秒 / 离页 sendBeacon）匿名计数，无 IP 无指纹；hub 校验站点存在性后按（北京日，站点）聚合进 site_stats。**防刷口径**：限流 10 次/分/IP + 单站单字段**单日增量封顶 50000**（匿名无凭据，只能把「无限灌」压成有界值；该数据只站长自己看得到，不进公开 feed 排序）
- `GET /api/site-stats`——站长数据卡（B25 P2.3）：**只认 `X-Plaza-Token` 头**（长期令牌不进 URL / 代理日志 / Referer，与 ingest 同口径；无 query 兜底），响应 no-store；出参只含本站：`{site:{id,name,url}, items, totals:{views,clicks,likes}, days:[{day,views,clicks,likes}](近 7 日)}`。曝光/点击自 P2.2 上线起计数，点赞累计以 items.likes 为权威

> **入站体积预检**（与博客内核 `api.ts` 同款闸）：所有非 GET/HEAD/OPTIONS 请求先看 `Content-Length`，超 512KB 直接 413；公开写入口（`/api/like`、`/api/beacon` 无需凭据）再用流式限长兜底无 `Content-Length` 的 chunked 超大体——防超大请求整读进内存打爆进程。
>
> **Node 形态的实际防线**：`demo/hub-node` 适配层把 `content-length` 当 hop-by-hop 头剥掉（body 走流），所以 CL 预检在 Node 形态**恒不触发**；此时三道公开写入口（`/api/like`、`/api/beacon`、`/api/ingest`）各自走 `readTextLimited` → `readBodyLimited`（**边读边限**，累计超 512KB 立即 `reader.cancel()` 返回 413，内存有界）——防护等价，只是从「预检短路」退化为「流式兜底」。Workers 形态两道都在。

### 管理端点（Bearer PLAZA_ADMIN_TOKEN）补充

| 端点 | 说明 |
| --- | --- |
| `POST /api/admin/pull` | 手动触发全站补漏（RSS + 微博口），不等 6 小时 cron——新接入站点 / 新补漏口上线时立即对齐 |

> 站点 token 是长期 Bearer，管理列表 / 详情回显一律打码（**只露后 4 位**，`maskPlazaToken`）——明文只在创建时返回一次；丢了就 rotate。

### 微博补漏（站点可选提供）

RSS 只有文章，微博漏推（发布瞬间的推送失败即永久丢失）没有自愈路——站点可以提供
`GET /api/public/weibo?limit=20` 补漏口，hub 的 pull cron 会顺带拉取（**只补 30 天内**、
`source='pull'`、不覆盖 push）。出参就是 ingest 条目的同形数组（少 kind，hub 固定按 weibo 收）：

```json
{ "weibo": [{ "ref": "微博id", "title": "前 80 字", "summary": "前 500 字",
              "url": "https://…/weibo#wb-<id>", "image": "https://…（可空）", "publishedAt": 1718000000000 }] }
```

博客号内核（2026-10 起的版本）已内置该接口，无需配置；第三方系统可选实现，没有该接口的站点
hub 静默跳过，不影响其余补漏。管理端 `POST /api/admin/pull` 可立即触发一次。

### 混排口径

`score = recency + weight + jitter`，三项分别压在 1 / 0.5 / 0.3 以内（总分上限 1.8），没有谁能一票定序：

- **recency** `1/(1 + 龄期天数/2)`：今天 ≈ 1，一周 ≈ 0.22，一月 ≈ 0.06（衰减平缓，老文不永沉）
- **weight**：站点权重 0-10 × 0.05/档（管理员按内容质量定档）；**新站聚光**（B25 P0.4）——注册 7 天内的站 weight 临时 +2 档（封顶 10），到期自动回落，冷启动扶持不改动管理员定的档
- **jitter**：0~0.3 随机抖动（每次刷新换序，「逛」的感觉）

官网广场页消费 feed 的完整口径（双视图卡片墙 / 卡片三型 / 站点视图 / 侧栏活跃榜 / 匿名点赞 / 曝光点击回传 / `utm_source=bloghao-plaza` 出站标记）见 **docs/archive/PLAZA-2.0-PLAN.md** 与 `website/public/plaza/plaza.js`。

## ingest 协议（第三方博客系统也能接）

请求：`POST {hub}/api/ingest`，头三件套 + JSON body：

```
X-Plaza-Token: <32位站点token>
X-Plaza-Timestamp: <毫秒时间戳，±10分钟窗口>
X-Plaza-Signature: <hex(HMAC-SHA256(token, timestamp + "." + rawBody))>
```

```json
{
  "avatar": "https://…",       // 可选，站点头像（后台「站点头像」），随上报更新站点级
  "items": [{
    "kind": "post",            // post | weibo
    "ref": "slug 或微博 id",    // 站内唯一引用，重发同一 ref = 更新（幂等）
    "title": "标题（≤200字）",
    "summary": "摘要（≤500字）",
    "url": "https://…",        // 必须 https 绝对地址
    "image": "https://…",      // 可选封面，https
    "publishedAt": 1728000000000
  }],
  "deleted": [{ "kind": "post", "ref": "…" }]   // 源站删除时通知 hub 下架
}
```

- 单次最多 50 条 items / 50 条 deleted，body 超 256KB 拒收（更严于全局 512KB 预检闸）
- 形状不对的字段按没传处理，url 非 https 的条目丢弃
- 签名算法与校验都在 `plaza/src/core.ts`（`hmacHex` / `verifyPlazaSignature`），Node 18+ 与 Workers 通用，`tests/plaza-hub.test.ts` 有双端镜像用例可对照

## pull 补漏路

hub cron（每 6 小时）会抓各站 `/rss.xml` 给没接插件的老站兜底：只灌 **30 天内**的文章（RSS 没有微博）、单站单次 20 条、`source='pull'` 标记且**绝不覆盖** push 数据；站点注册时默认开启，管理端点可按站关闭。180 天无 push 心跳的站点 cron 自动休眠（不删站，重新启用即恢复）。pull 只收 https 链接、跳过带锁标志的条目（与 push 路同口径）。**出网 SSRF 防线**：被 pull 站点是第三方可控的——起始地址与**每一跳重定向目标**都要过公网主机判定（内网后缀 / IPv6 字面量 / 私有段 IPv4 含整数·十六进制·八进制写法一律拒，判定与内核 `fetchsafe.isPrivateHost` 同口径），只跟 https 跳不降级；注册时的站点地址校验同口径。**站点名自动补全**（B25 P0.2）：站没起名（空或还是注册时的裸域名默认值）时，从 RSS channel `<title>` 回填 `site_name`——站长起过的名字绝不覆盖。

## schema 与部署

hub 的表定义唯一来源 `plaza/schema.sql`（sites / items / likes / site_stats / stats），Workers D1 与 Node（demo/hub-node，启动即 `exec(schema.sql)`）双形态共用。**升级自动迁移**：hub 路由的 `ensureSchemaExtras` 对存量库惰性补列/补表（`sites.avatar`、`items.likes`、`likes`、`site_stats`，全部幂等），两种形态都不需要手工 `d1 execute`。`likes` 是点赞去重日志（7 天前的行 cron 清掉），`site_stats` 是站点级互动日聚合（几百站量级一年 ~11 万行），`stats` 仍是全局调用计数。

**两个安全配置**（未配也能跑，但建议配齐）：

- `PLAZA_HASH_SECRET`：点赞/曝光的 IP/vid 天级哈希私盐。设了走 `HMAC-SHA256`（库泄露也无法枚举还原）；Workers 用 `wrangler secret put` 注入，**Node 形态（demo/hub-node）未设时会自动生成一枚并落盘到数据目录**（`<DB 目录>/hash-secret`，重启不变），所以自托管形态默认即私盐。改它只影响「当天」去重（一天内可能重复计 1 次），属可接受代价。
- `TRUST_PROXY`（Node 形态）：访客 IP 信任档位，与 docker-poc 同口径同默认——`proxy`（默认，Caddy/Nginx 反代后取 XFF 末跳，**剥掉客户端自带的 `cf-connecting-ip` / `x-real-ip`**）、`cf`（前有 Cloudflare）、`off`（Node 直接暴露）。**档位必须与真实部署一致**，否则客户端伪造转发头即可重置按 IP 的点赞去重与限流桶。**官方 hub 用 `cf`**（bloghao.com 走 Cloudflare 代理、Caddy 回源，Caddy 末跳会落到 CF 边缘 IP，同边缘用户会互相挤掉点赞——所以取 CF 写入的 `cf-connecting-ip` 才是真客户端 IP）；官方部署的 compose 里显式设 `TRUST_PROXY=cf`。**注意**：官方源站 IP 可被直连（绕过 CF），`cf` 档下 `cf-connecting-ip` 理论上可被直连请求伪造——建议用防火墙把源站 80/443 收窄到 Cloudflare 回源段（与本仓库无关的服务器运维项）。

## docker-poc 自托管分站的自动收录（2026-10-16）

docker-poc 控制面配置了 `PLAZA_HUB_URL` + `PLAZA_ADMIN_TOKEN`（指向自己的 hub）后，
分站与广场自动保持同步，零人工步骤：

- **开通即收录**：控制面开站（非演示租户）自动调 hub `POST /api/admin/sites` 注册，
  返回的站点 token 直接写进该站 `settings.plazaToken`——「广场同步」服务端插件默认开启，
  有 token 即自动 push（发布实时进广场、删除/锁文自动下架），hub 的 6 小时 pull 继续兜底
- **生命周期联动**：停用分站 → hub 站点同步隐藏；启用 → 自动补注册；彻底删除 → hub 删站并级联清内容
- **存量站对齐**：控制面仪表盘「广场 hub」卡片有「分站收录进广场」按钮——把全部真实分站
  （演示/停用站除外）对齐进 hub 并触发一次 `POST /api/admin/pull` 立即补漏；日常无需手动点
- 演示租户（种子假数据）一律不收录：广场只收真实公开内容，宁缺毋假
- 未配置这两个 env 的自托管环境行为不变：进官方广场仍走「三步接入」的人工审核流程
  （站点 token 只有 hub 管理员能发，自动收录的前提是持有 PLAZA_ADMIN_TOKEN）

## 与认证（ROADMAP B18）的关系

`sites.verified` 徽标位与 feed / 名录出参的 `siteVerified` 已就位（官网展示「✔︎ 认证」），v1 由 hub 管理员在站点所有权验证通过后手工打开；签名凭据自动化签发（token 化验证文件 / DNS 校验）是 B18 的启动范围，届时只扩 hub 管理端点，协议与出参形状不变。

## 演进方向（B25 广场 2.0：P0/P1/P2 已随 v2.6.0 上线）

广场 2.0 的第一批（P0 地基 / P1 双视图卡片墙 / P2 匿名点赞与数据回流）已随 v2.6.0 上线（交互细节与红线见 **[docs/archive/PLAZA-2.0-PLAN.md](./archive/PLAZA-2.0-PLAN.md)**）；剩 P3 留存（本地关注 / 周刊精选）、P4 话题与搜索、P5 信任治理按广场活跃度里程碑触发，方案见同文档。本文档只承载已落地协议，各阶段落地后回写。

## 隐私与边界

- 广场只收**公开内容**的标题 / 摘要 / 链接 / 封面，不收正文、不收评论、不收任何访客身份
- hub 的 items 表是**派生数据**：源站删了推 `deleted` 即清，hub 被删也不影响任何博客站
- 官网广场页所有动态字段走 `esc` / `textContent` 渲染，feed 内容属半可信（来自各站站长），hub 端另有 https-only 与长度截断两道闸
- **轻互动是匿名聚合计数，不是行为档案**（B25 P2）：点赞与曝光/点击回传无账号无 Cookie 面，hub 不存原始 IP / vid，只存「北京日 + 服务端私盐」的 HMAC-SHA256（配了 `PLAZA_HASH_SECRET` 时库泄露也无法枚举还原 IP/vid；同 IP 跨日哈希不同，无法跨天串联）；曝光/点击在 hub 侧只落（北京日，站点）两维聚合，没有条目级、没有访客级记录；官网页的 vid 是纯随机串（localStorage），仅作客户端防重，不掺任何设备信息
