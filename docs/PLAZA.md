# 广场（博客号内容聚合）

广场是官网 **[bloghao.com/plaza](https://bloghao.com/plaza/)** 上的内容聚合流：所有开通同步的博客号，其公开文章与微博在这里汇成一条河，按「**权重 + 新文推荐 + 随机展示**」混排——新文有曝光，权重高的站靠前，随机抖动让每次刷新都可能撞见新东西。

```
┌─ 你的博客号 ────────────┐         ┌─ 广场 hub（独立 Worker）─┐         ┌─ 官网 bloghao.com ─┐
│ 发布文章 / 微博          │  push   │ 签名校验 → 入库          │  feed   │ /plaza/ 页面        │
│ 「广场同步」插件自动上报  │ ──────→ │ RSS pull 补漏（cron）    │ ──────→ │ 拉取渲染（ES5）      │
│ 加密/会员锁文自动跳过    │         │ 混排评分 → /api/feed     │  CORS   │                     │
└────────────────────────┘         └─────────────────────────┘         └────────────────────┘
```

## 给博客号站长：三步接入

1. **联系官方**（[GitHub Issues](https://github.com/bloghao/bloghao/issues) 或社区群）提供你的站点地址，审核通过后拿到一枚 **32 位站点 Token**
2. **后台填配置**：「设置 → 服务端插件」→ 广场站点 Token 粘贴进去，保存（广场地址**留空即官方 hub** `https://plaza.bloghao.com`——唯一官方入口，稳定版 / 开发版一律由此接入；自建 hub 才改）
3. **开启插件**：「插件」页 → 服务端插件 → **广场同步（bloghao.com）** 打开

之后**每次发布**（文章 / 微博，后台、定时、开放 API、TG 机器人四条路都算）会自动推一条到广场；重复编辑已发布内容不重推。不想同步了，把插件关掉即可，hub 里的历史内容可请管理员清除。

**不会上广场的内容**：加密访问的文章、会员专属（付费墙）文章——这两类在发布事件里带锁标志，插件直接跳过，标题摘要也不出。微博配图取首图（站内图自动补站点域名转绝对地址）。

## 广场 hub（自建 / 运维）

hub 是独立 Worker，源码在仓库 `plaza/` 目录（`src/core.ts` 纯函数 + `src/index.ts` 路由，零 npm 依赖，hono 单文件）。官方部署在 `https://plaza.bloghao.com`（D1 库 `plaza-db`），**与博客主站完全独立**，不部署也不影响博客系统。

```bash
# 部署自己的 hub（自托管场景）
npx wrangler d1 create plaza-db          # database_id 填进 plaza/wrangler.jsonc
npx wrangler d1 execute DB --remote --file plaza/schema.sql
npx wrangler secret put PLAZA_ADMIN_TOKEN
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

- `GET /api/feed?limit=30&kind=post|weibo`——混排 feed（CORS 全开，官网直接消费）
- `GET /api/sites`——站点名录（认证标、条数）
- `POST /api/ingest`——博客端上报（协议见下）

### 混排口径

`score = recency + weight + jitter`，三因素都压在 0~1.5 区间，没有谁能一票定序：

- **recency** `1/(1 + 龄期天数/2)`：今天 ≈ 1，一周 ≈ 0.22，一月 ≈ 0.06（衰减平缓，老文不永沉）
- **weight**：站点权重 0-10 × 0.05/档（管理员按内容质量定档）
- **jitter**：0~0.3 随机抖动（每次刷新换序，「逛」的感觉）

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

- 单次最多 50 条 items / 50 条 deleted，body 超 256KB 拒收
- 形状不对的字段按没传处理，url 非 https 的条目丢弃
- 签名算法与校验都在 `plaza/src/core.ts`（`hmacHex` / `verifyPlazaSignature`），Node 18+ 与 Workers 通用，`tests/plaza-hub.test.ts` 有双端镜像用例可对照

## pull 补漏路

hub cron（每 6 小时）会抓各站 `/rss.xml` 给没接插件的老站兜底：只灌 **30 天内**的文章（RSS 没有微博）、单站单次 20 条、`source='pull'` 标记且**绝不覆盖** push 数据；站点注册时默认开启，管理端点可按站关闭。180 天无 push 心跳的站点 cron 自动休眠（不删站，重新启用即恢复）。

## 与认证（ROADMAP B18）的关系

`sites.verified` 徽标位与 feed / 名录出参的 `siteVerified` 已就位（官网展示「✔︎ 认证」），v1 由 hub 管理员在站点所有权验证通过后手工打开；签名凭据自动化签发（token 化验证文件 / DNS 校验）是 B18 的启动范围，届时只扩 hub 管理端点，协议与出参形状不变。

## 隐私与边界

- 广场只收**公开内容**的标题 / 摘要 / 链接 / 封面，不收正文、不收评论、不收任何访客数据
- hub 的 items 表是**派生数据**：源站删了推 `deleted` 即清，hub 被删也不影响任何博客站
- 官网广场页所有动态字段走 `esc` / `textContent` 渲染，feed 内容属半可信（来自各站站长），hub 端另有 https-only 与长度截断两道闸
