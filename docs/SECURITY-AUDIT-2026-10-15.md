# 安全复审（夜间自动审计）— 2026-10-15

> **夜间自动审计（2026-10-15）· 未经人工复核，结论仅供参考。**
>
> 范围：以 docs/SECURITY-AUDIT-2026-10-12.md 的「四·一终态」为先验（confirmed 根因只做回归验证、不再猎捕），重点扫描 2026-10-12 审计**之后**新增/改动的攻击面。基线：`ead3d8f`（main），typecheck ✓ / npm test 636/636 ✓。
>
> 方法：只读审计（未修改任何代码）。每条发现给出 文件:行 证据与推理链，按 P0/P1/P2 分级；拿不准的标「存疑」。纪律同上轮：说不出具体后果不定级，宁报勿漏不编造。

## 一、先验与范围

- 上轮审计（2026-10-12）修复终态 A1-A13 / B1-B11 / C1-C3 视为已知防线，本轮只验证未回归、不重复猎捕。
- 本轮主查的**新攻击面**（10-12 后新增）：
  1. 微博视频（B19）：上传链路、`prepareVideo` ftyp 归一化（客户端）、渲染 `weiboVideoHtml` / `weiboVideoView`
  2. 页面边缘缓存 `src/pagecache.ts`（P0-2 扩面）+ `/images/*` 图床边缘缓存（imageCacheMatch/imageCachePut）
  3. settings 共享快照层（db.ts `getSettings`/`invalidateSharedSettings`）
  4. 站长 SEO `src/seo.ts`（B20/B23/B24）
  5. MCP `src/mcp.ts`（B10）
  6. Turnstile `src/turnstile.ts`（A2 根治）
  7. 积分批内条件写 `src/points.ts`（A1 修复本体）
  8. AI 爬虫统计 `src/bots.ts`（识别 + 写入闸）
  9. 前台删评论链路（2026-10-14）
  10. api.ts 入站体积预检（A3 修复本体 + 10-13 修复的 `/api` 前缀豁免清单）

## 二、发现登记（终态）

> 格式：`ID | 严重度 | 状态 | 一句话 | 位置`。P0=可直接利用/数据面损坏，P1=需条件或纵深击穿/防线声明与实现不符，P2=加固位/低危。

| ID | 严重度 | 状态 | 一句话 | 位置 |
|---|---|---|---|---|
| F1 | P1 | 存疑（Cache API 跨部署隔离语义待站长在 CF 侧验证） | settings 共享快照缓存键是全部署固定 URL、不含实例标识，同 zone 多实例可能互串含密钥的设置快照 | src/db.ts:118。**处置（2026-10-16）**：止血落地——快照 TTL 300→60s，暴露窗口缩至 1/5；键带实例维度的完整修复需 host 穿过 getSettings/invalidateSharedSettings 全部调用链（且会把「改设置全 colo 即时失效」弱化为 per-host），维持「先核实 Cache API 隔离语义再专项设计」 |
| F2 | P1 | 确认 | `/images` 图床边缘缓存的两个前提被打破：媒体删除不失效（已删图最长一年可访问）+ favicon 键可覆盖（刷新图标后最长一年取旧图） | src/index.ts:269-302、src/api.ts:1558-1567/1031-1055 |
| F3 | P1 | 确认 | 演示站 `/api/admin/export/*` 未短路——2026-10-12 审计 B11 标「已修」但修复清单只落了 backup/sanitize/fetch-icon/refresh-icon/approve 五处，export 漏掉；AGENTS.md「export 全部 isDemo 短路」的防线声明与实现不符 | src/export.ts:115/262（对照 api.ts:1907 备份守卫在位） |
| F4 | P2 | 确认 | /mcp 与 /post/:slug/unlock 不在入站体积预检覆盖内（预检注册在 /api 子应用）；两者 body 解析分别在鉴权 / 限流之后，残余风险仅「持 token 者超大 JSON-RPC 打爆 isolate」 | src/mcp.ts:451、src/index.ts:184 |
| F5 | P2 | 确认 | settings PUT 对 `siteUrl` 无 scheme 校验（对照 commentWebhookUrl/plazaEndpoint 均过 fetchableUrl）：脏 siteUrl 会流进 canonical / og:url / RSS `<link>` / JSON-LD——全部是管理员自配的元数据位，无脚本执行面，属一致性加固 | src/api.ts:1883（default 分支）、src/db.ts:24 |
| F6 | P2 | 确认 | `DELETE /admin/tags/:name` 改写 posts.tags 但不挂 purgePageCache：`/tag/:x` 聚合页副本最长 30 分钟滞留旧内容（文档已备案的「装饰性滞后」口径，刷新极低频，登记不改） | src/api.ts:1499-1516 |

## 三、逐面核验记录（证据与推理链）

### F1 · settings 共享快照键无实例维度（P1，存疑）

- 证据：`src/db.ts:118` `const SETTINGS_SHARED_URL = 'https://xwblog-internal.invalid/__settings-snapshot'`，getSettings（db.ts:140-179）以该 URL 在 `caches.default` 读/写整站 settings 快照（含 `externalToken`/`telegramBotToken`/`turnstileSecret`/`bufferAccessToken`/`plazaToken` 等敏感键，SECRET_SETTINGS 见 api.ts:1731）。
- 对照：同仓库对 Cache API 键的作用域认知是「只由 URL 决定、不按 Worker 隔离」——pagecache.ts:161-163 注释明说「workers.dev 预览域名与绑定域名共享同一 colo 缓存」并把 `u.host` 编进键；imageCacheKeyFor（pagecache.ts:232）同样带 host。唯独 settings 快照键不含任何实例标识。
- 推理链：若 Cache API 条目按「colo + URL」共享（而非按 zone/Worker 隔离），则同一 colo 内的另一套博客号部署（同一站长在自有 zone 下两个子域各跑一套、或 "Deploy to Cloudflare" 多租户共用 zone 的形态）的 getSettings 会互相命中对方快照——轻则站点设置串台（站名/主题），重则 A 实例的 externalToken 成为 B 实例的有效令牌、A 的 Turnstile secret 注入 B 的渲染流程。本仓库自身实测记录（pagecache 注释）支持「URL 定键」这一前提，故按宁报勿漏列 P1；**存疑点**：Cloudflare 官方对 Cache API 跨 zone/跨 Worker 隔离的表述含糊，若实际按 zone 隔离，风险收窄到「同一 zone 跑两套博客号」。
- 修复建议（一行级）：快照 URL 拼入部署自身标识，如 `__settings-snapshot/${hostname 或环境派生 ID}`；与 pagecache/imageCache 的 host 维度对齐。

### F2 · /images 图床边缘缓存的失效前提缺口（P1，确认）

- 前提声明：pagecache.ts:39-42「R2 键内容寻址（saveUpload 时间戳+随机数，同键永不覆盖），键不带 epoch，内容寻址永不失效」。经核验 `saveUpload`（store.ts:47）确为 `${dir}/${ym}/${Date.now().toString(36)}${随机}.${ext}`——**手动上传、转存、OG 卡图三条路成立**（og-image 端点 api.ts:1622 也走 saveUpload）。
- 破口一（删除不失效）：`DELETE /api/admin/uploads`（api.ts:1558-1567）与媒体体检 `cleanupUnreferenced`（api.ts:1597-1606）删 R2 对象，但 /images 路由的边缘副本（imageCachePut 存的是带 `Cache-Control: public, max-age=31536000, immutable` 的响应，index.ts:296）不受影响——**已删除的图片/视频在边缘最长一年内仍可被任何持旧 URL 者访问**。对「删图即应不可达」的隐私/下架预期是实打实的缺口；R2 键不覆盖的前提（不失效的前提）只约束「写」，不约束「删」。
- 破口二（favicon 键可覆盖）：`storeLinkIcon`（api.ts:1047）用 `u/fav/${host}.${ext}` 固定键写 R2，`refresh-icon`/`approve` 都会重写同键；而 index.ts:296 无条件下发 1y immutable（无视 R2 对象自带的 604800 头，api.ts:1049）——站长换友链图标后，边缘与浏览器最长一年仍显示旧图。这是「内容寻址永不覆盖」前提的第二个反例（只影响图标时效性，无安全后果）。
- 修复建议：① 删除/清理媒体成功后对受影响键做一次 `cache.delete`（imageCacheKeyFor 现成）；② favicon 改内容寻址键（saveUpload dir='u' 即可）或 /images 对 `u/fav/` 前缀改用 R2 对象自带的 cacheControl。

### F3 · 演示站导出面未短路（P1，确认）

- 证据：exportRoutes 两条 GET（/api/admin/export/markdown、/wxr，src/export.ts:115/262）全程无 isDemo 判定；export.ts 全文 grep `isDemo|demo` 零命中。对照 AGENTS.md 演示站节：「`/api/admin/backup`、`/api/admin/export/*` 全部 isDemo 短路」，以及 2026-10-12 审计 B11（「demo 下 /api/admin/backup 与 /api/admin/export/* 无 isDemo 门控」终态「✅ 已修：并入 A6/C1」）——但 A6/C1 的修复清单是「demo 门控×5（backup/sanitize/fetch-icon/refresh-icon/approve 抓图跳过）」，**不含 export**。备份守卫在位（api.ts:1909），导出没有。
- 攻击链：演示站登录页公示管理员凭据 → 体验者登录后台 → GET /api/admin/export/markdown → 整包下载演示站全部内容（含草稿、微博、独立页面、被引用图片）。损害限于每 2 小时重置的种子数据，无真实用户数据；但它是「演示站禁外泄敏感面」防线声明与实现的实证偏差，且属于上轮审计误报「已修」项。
- 修复建议：exportRoutes 两条 GET 开头补 `if (isDemo(c.env)) return jsonError('演示站不开放导出', 404)`（同 collect.ts:345 形状）；AGENTS 防线无需改动（描述本就要求短路）。

### 其余核验通过项（回归验证 + 新面确认）

- **积分批内条件写**（A1 修复本体）：points.ts:79-99 ②条件 UPDATE / ③条件 DELETE 谓词互斥、以 changes 判定、UNIQUE 撞库静默——与 AGENTS 防线一致；tests/members.test.ts「批内守卫」在位。
- **Turnstile**：verifyTurnstile fail-closed（非 success===true/异常一律 false，10s 超时），仅在 /api/member/register 校验、先于字段校验，演示站跳过（api.ts:253-256）。
- **出网纪律**：全仓裸 fetch 共 10 处，全部归类——固定可信端点（api.telegram.org / api.buffer.com / q1.qlogo.cn / challenges.cloudflare.com）+ 配置时过 fetchableUrl 的 commentWebhookUrl/plazaEndpoint（运行时裸 fetch 为 A10 登记接受的残余）。无新增漏网点。
- **MCP**：鉴权复用 externalToken（header-only + safeEqual）、失败限流 10/10min、成功 30/min；`get_post`/`list_posts` 过 postAdminView（password_hash 不出）；`list_comments` 显式列清单（email/qq/ip/avatar 不出，mcp.ts:246-253）；publish_post 双段净化 + locked 透传 + via:'mcp'；演示站 404；闭站随全局中间件覆盖。协议层错误与工具错误分离正确。
- **站长 SEO**：验证 meta 白名单 + 值形态 + 只认 name/content（seo.ts:79-92）；统计脚本只收 https src + 属性白名单、内联体整体拒绝（seo.ts:157-180）；输出全部过 esc；`analyticsOrigin` 进 CSP 由 buildCsp 单点组装（pages.ts，tests 守）；SPECULATION_RULES 为静态 JSON 不含 `<`。后台无裸 HTML 注入口达成。
- **爬虫统计**：识别单表 + 未命中不落库；写入闸（30s 去抖 + 10min 300 条预算 + 表清空兜底）在位；recordBot 只落 name/kind/path/country（IP/UA 原文不落库，index.ts:72 country 头截 8 字符）；cleanBotPath 剥控制字符。隐私口径达标。
- **api.ts 体积预检**：UPLOAD_PATH_PREFIXES 三条全带 /api 前缀（api.ts:119），冒烟守着；本中间件是 api 子应用第一条，先于鉴权与 body 解析。
- **微博视频**：写侧 parseWeiboVideo（scheme 白名单 + 限幅 + 未知键丢弃）、读侧 weiboVideoView（脏 JSON 一律 null）双道在位（db.ts:735-759）；`video` 键缺键即保留（api.ts:855-860/936）；渲染 weiboVideoHtml 单行 + 转义，site.js wbVideoHtmlJs 镜像逐字节比对（tests/weibo-admin.test.ts 在位）；prepareVideo 只认文件头、qt→isom 归一化不改白名单口径；上传魔数白名单不放宽（sniffUploadExt）；`/api/external/weibo` 在 30MB 豁免清单内。
- **前台删评论**：render.ts:1363-1367 adminBtns 由 `o.isAdmin` 门控、site.js:957 同门控，访客 HTML 无 data-cmt-del（冒烟「前台删评论链路」守着）；写端点 DELETE /api/admin/comments/:id 带楼中楼级联 + purgePageCache（api.ts:1718-1726）。
- **净化链**：safeUrl/safeUrlMd 先剥 \t\r\n（sanitize.ts:104、markdown.ts:42）；markdown 属性上下文只 escQuote（markdown.ts:54）；escapeStrayLt 在透传段两处生效（sanitize.ts:217/253）；id 不在白名单（GLOBAL_ATTRS 无 id）；decodeAttrEntities 一轮解码后立即 safeUrl、输出前 escAttr 的安全不变式注释与实现一致。
- **会话**：sessions/member_sessions 全链路 tokenHash（auth.ts）；会员与管理员 Cookie/表分离；封禁查询层即视为未登录；改密踢其他设备保留当前会话。
- **TG webhook 幂等**：update_id 内存 5 分钟去重（external.ts:32-40/473）；secret 双通道（header + query 兼容）为 C3 登记接受项。
- **闭站白名单**：/admin、/api/admin、/api/auth、/api/meta、/api/health、/images 前缀放行（closed.ts:16-22），与 AGENTS 一致；/api/health 精确路径在 17 行附近放行（`/api/health` 不在列出的 grep 行内，经closed.ts:20-22 上下文确认在位）。
- **/random**：排除 password_hash + deleted_at（index.ts:134）；锁文（min_tier）进随机池属契约内（前台有试读卡）。
- **导出/备份防穿越**：keyOf 拒 `..`/`\`/`\0` 且只认 u/ og/ 前缀（export.ts:30-42），zipEntrySlug 脏 slug 回退 id 命名（export.ts:51-54）。
- **公开出参面**：/api/public/posts 走 toHomePost（无 content，render.ts:646-660）；/api/public/weibo 只出封面帧当缩略图、视频文件不出站（api.ts:2156-2174）；后台 links 列表不回传提交者 IP（api.ts:1095-1105）。

## 四、结论

1. 上轮 17 项修复中 16 项复验在位，唯一例外是 B11 的 export 半边（F3）——修复清单与终态声明不符，建议本轮补一行守卫后把 B11 终态改注「部分修复，2026-10-15 补齐」。
2. 新增面（pagecache/seo/mcp/turnstile/points/bots/视频/删评论/体积预检）整体质量高，AGENTS 防线与实现基本逐条对得上；系统性风险集中在**缓存失效的完整性**（F1 快照键作用域、F2 图床删除/覆盖），二者都源于「Cache API 的键只由 URL 决定」这一平台事实与模块内「内容寻址永不失效」的建模假设之间的缝隙。
3. 无 P0。P1 三条（F1 存疑、F2/F3 确认）修复成本都在几行到几十行；建议站长复核后随下个发布窗口处理。
