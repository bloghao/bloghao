# B21 · IndexNow 即时推送 — 设计提案（夜间自动审计产出，2026-10-15）

> **夜间自动审计（2026-10-15）· 未经人工复核，结论仅供参考。**
>
> 按判定门槛执行的结果：**STOP——纯插件形态无法覆盖全部需求，未做任何代码改动**，本文即设计提案。依据：任务门槛「若必须动 index.ts/api.ts 等内核（如无法注册 /{key}.txt 路由），立即 STOP 改写提案」，而 IndexNow 协议把 key 文件托管定为**强制项**（见下），任何插件形态都绕不开内核路由。

## 一、B21 需求与协议要点（对照 ROADMAP 原文）

ROADMAP（docs/ROADMAP.md:48）原文：「IndexNow 即时推送（2026-10-13 立项，插件形态归宿②）——Bing / Yandex / Seznam 等共用的即时推送协议（Google 不参与——其 ping 接口 2023 已弃用，sitemap 是唯一通道）；归宿插件：src/hooks.ts `onPostPublished` 钩子里 POST `api.indexnow.org`（url + key 参数，key 是站长自生成随机串、无申请门槛），插件市场好选题；**key 文件托管需内核几行**（GET `/{key}.txt` 返回纯文本，读 settings 键，放 index.ts /robots.txt 旁），删除 / 转草稿时 optionalDeletes 端点顺手带上」。

IndexNow 协议要点（官方文档核实）：

1. **key 文件托管是强制前提**：站点必须在**根路径**托管一个 UTF-8 文本文件 `https://站点/{key}.txt`，文件名与文件内容都等于 key，公开可访问、无需登录——这是「URL 归属证明」，缺了它搜索引擎不受理提交（403 key file not found）。
2. 提交：`GET https://api.indexnow.org/indexnow?url=…&key=…`（单条）或 `POST https://api.indexnow.org/indexnow`，JSON body `{ "host": "站点域名", "key": "…", "urlList": ["https://…", …] }`（单次上限 1 万条）；响应 200/202 受理，403 key 无效，422 URL 与 host 不符，429 超频。
3. **协议没有标准的「删除」语义**：ROADMAP 提的「optionalDeletes 端点」在现行协议文档中不存在——删除/转草稿的最务实做法是把 URL 再提交一次让爬虫重抓 404，属设计决策点（见 §四.6）。
4. key 是「自生成随机串、无申请门槛」，通常 32 位十六进制；key 本身会公开托管在 .txt 里，**不是秘密**（不进 SECRET_SETTINGS 打码口径）。

## 二、现状（代码证据）

- **钩子总线能力边界**（src/hooks.ts）：服务端插件只有四个事件槽——`onPostPublished` / `onWeiboPublished` / `onCommentCreated` / `footerHtml`（hooks.ts:66-73）。**没有任何「注册路由」的槽**；footerHtml 只把 HTML 拼进每页 `</body>` 前，不能在站点根产出一个 `/{key}.txt` 文本响应。
- **服务端插件分发方式**（AGENTS「hooks.ts 头注释」）：「第三方服务端插件以『提交进 SERVER_PLUGINS 注册表』的方式分发（与主题注册表同模式，随部署生效、无热加载）」——SERVER_PLUGINS 数组就在 src/hooks.ts:356，**注册本身即内核编辑**，不存在「插件市场安装即用」的服务端通道（插件市场 public/market/catalog.json 只服务前台编辑器插件）。
- **服务端插件配置通道**（api.ts:517/1767）：`PUT /api/admin/settings` 只接受 `SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)` 里的键——插件想拿到自己的配置必须新增 DEFAULT_SETTINGS 键（db.ts，内核）+ 后台设置页 UI。「不新增内核 settings 键」与「服务端插件有配置」在当前架构下不可兼得。
- **对本次有利的现状**（设计可直接复用）：
  - `PostPublishedPayload.locked`（hooks.ts:24-35）已在全部发布入口透传（后台 api.ts:667/784、定时 scheduler.ts:67、MCP mcp.ts:180），定义就是 `password_hash 非空 || min_tier !== 'all'`——需求②「锁文/密码文一律不提交」只需一行 `if (p.locked) return`（广场同步插件同款，hooks.ts:284）。
  - demo 门控在 fireHook 总线内置（hooks.ts:392 `if (isDemo(env)) return`）——需求③零成本。
  - 固定可信端点直连有先例（api.telegram.org、api.buffer.com、challenges.cloudflare.com、q1.qlogo.cn——2026-10-15 安全复审已全量归类），api.indexnow.org 属同一类「协议固定端点、路径无用户输入」，不走 fetchsafe 是既定纪律内的正确形态。
  - urlList 来源：`ctx.base`（settings.siteUrl 回落）+ `p.slug`，slug 落库前过 cleanSlug——**服务端自身数据拼 URL，无用户输入注入面**。

## 三、纯插件形态为何不够（三道硬墙）

1. **key 文件托管（协议强制项）**：`/{key}.txt` 必须是站点根上一个「文件名=key、内容=key」的公开文本响应。插件无路由槽（hooks.ts 四个事件槽 + footerHtml 均不可达）；wrangler assets 只能服务**构建时打进 public/ 的静态文件**，而 key 要求每个部署各不相同——把 key 提交进仓库意味着所有「Deploy to Cloudflare」出来的博客共用一把 key，任何实例都能替任何其他实例提交 URL，架空协议的归属证明语义。**结论：必须内核路由，ROADMAP 自己也标注「key 文件托管需内核几行」。**
2. **配置存储**：`indexnowKey` 需要进 DEFAULT_SETTINGS（db.ts）才能过 PUT 白名单、才能进后台设置页——内核编辑。插件 localStorage 只存在于前台编辑器插件（public/plugins/），那类插件跑在访客/站长浏览器里，**无法在服务端发布钩子里执行**，两条插件线互不相通。
3. **注册本体**：即便前两项都解决，把插件登记进 SERVER_PLUGINS（hooks.ts:356）也是内核文件编辑——「纯插件形态（不进内核文件）」从第一步就不成立。

> 反向验证：客户端编辑器插件形态（public/plugins/*.js，manifest.json 登记）不需要内核编辑，但它只能操作编辑器 DOM（window.BlogHao.insertHTML 等），碰不到发布事件、更产不出服务端路由——同样覆盖不了。

## 四、内核最小改动建议（设计稿，待站长批准后实施）

遵循 AGENTS「进内核的正确姿势是自洽小文件」：业务逻辑收进一个 `src/indexnow.ts`（单文件模块 + Node 可测纯函数），内核只留三处**接线**。

1. **settings 键（1 个）**：`indexnowKey`（TEXT，空 = 功能关闭）——不进 SECRET_SETTINGS（key 本来就要公开托管，打码反而让回显变占位符）。默认值空串。schema 无关（settings 是 KV 表）。
2. **key 文件路由（index.ts，约 10 行，放 /robots.txt 旁）**：
   ```ts
   // 中间件形态而非终点 handler：文件名不匹配 key 时 next() 放行，绝不遮蔽既有根路径路由
   app.get('*', async (c, next) => {
     const m = /^\/([a-f0-9]{16,64})\.txt$/.exec(c.req.path)
     const key = m ? (await getSettings(c.env.DB)).indexnowKey : ''
     if (!key || !m || m[1] !== key) return next()
     c.header('X-Content-Type-Options', 'nosniff')
     return c.body(key, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
   })
   ```
   注册位放在 RSS/sitemap 等具名路由**之后**（hono 具名路由优先命中，`*` 兜底），闭站中间件语义照旧（闭站时 key 文件随全站 503—— IndexNow 校验会暂时失败，属可接受）。
3. **服务端插件（src/indexnow.ts + hooks.ts 注册一行）**：id `indexnow-sync`，`onPostPublished` 处理器：
   - `if (p.locked) return`（锁文/密码文不提交，与 plaza-sync 同口径）；
   - `if (!ctx.base || !ctx.settings.indexnowKey) return`；
   - `urlList = [ctx.base + '/post/' + p.slug]`；POST `https://api.indexnow.org/indexnow`，JSON `{host, key, urlList}`，`AbortSignal.timeout(10_000)`，fire-and-forget（失败 console.error，不影响发布——同 bufferCreatePost 形态）；
   - demo 站由 fireHook 总线自动短路（hooks.ts:392），无需自写。
4. **后台设置 UI（public/admin/app.js，约 40 行）**：「设置 → 站点」SEO 区新增「IndexNow 即时推送」组：密钥输入框 + 「生成密钥」按钮（32 位十六进制，randomToken 同款）+ 帮助文案（生成 → 保存 → 用 `https://站点/{key}.txt` 自检 → 完成）。保存全部提交不带空键即可关闭。
5. **测试**：src/indexnow.ts 的纯函数（提交体构造、locked/host/key 前置条件、URL 拼接）走注入 fetch 的 Node 测试（同 tests/turnstile.test.ts 模式）；key 路由补进 npm run smoke（200 文本、错误 key 404、遮蔽回归：/rss.xml /robots.txt 不受影响）。
6. **删除 / 转草稿（设计决策点，建议最小版不做）**：协议无标准删除语义；若要做，可复用 firePlazaRetract 的触发时机把 URL 再提交一次（爬虫重抓后 404 收敛）。ROADMAP 的「optionalDeletes 端点」提法与现行协议不符，建议 ROADMAP 同步修订。另注意 `onPostPublished` 只在**发布跃迁**触发，编辑已发布文章不重推（与广场同步同语义）——IndexNow 允许重复提交，理想态是编辑也通知，需要扩钩子或接受现状，列为决策点。
7. **文档**：GUIDE（§16 设置表 + SEO 小节）、API.md（settings 可写键 + 新路由）、ROADMAP（B21 落地 + optionalDeletes 修订）、CHANGELOG。

## 五、工作量估计

| 项 | 规模 |
|---|---|
| src/indexnow.ts（纯函数 + 插件体） | ~60 行 |
| index.ts 路由接线 | ~10 行 |
| hooks.ts 注册 | 1 行 |
| db.ts DEFAULT_SETTINGS | 1 行 |
| 后台设置 UI（app.js） | ~40 行 |
| 测试（Node 注入 fetch + smoke 断言） | ~80 行 |
| 文档四处 | ~30 行 |
| 合计 | **约 0.5 个工作日**（含 typecheck/test/smoke 全绿验证） |

## 六、被否掉的替代形态（备案）

- **public/ 提交静态 key 文件**：全部署共用一把 key → 跨实例归属证明失效（任何博客号实例可替任何其他实例提交）；且 key 改动需要发版。否。
- **客户端编辑器插件**：跑在浏览器，无法执行服务端发布钩子与路由。否。
- **站长手动在 CF Dashboard 挂 Worker Route / 用 _headers 伪造**：超出产品自助能力，违背「一个下午能通读」定位。否。

## 七、参考

- IndexNow 官方文档（key 文件强制、提交端点与响应码）：https://www.indexnow.org/documentation 、https://www.indexnow.org/faq 、https://www.bing.com/indexnow/getstarted
- 本仓库先例：固定可信端点直连（src/hooks.ts tgChannel / bufferSync）、locked 透传链（api.ts:667/784、scheduler.ts:67、mcp.ts:180）、demo 短路（hooks.ts:392）、Node 可测纯函数模式（src/turnstile.ts / tests/turnstile.test.ts）。
