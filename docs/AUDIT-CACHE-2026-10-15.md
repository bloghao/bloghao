# 缓存与数据层正确性审计（夜间自动审计）— 2026-10-15

> **夜间自动审计（2026-10-15）· 未经人工复核，结论仅供参考。**
>
> 范围：src/pagecache.ts（页面边缘缓存 + /images 图床边缘缓存）、settings 共享快照层（db.ts）、失效链路完整性、数据层索引与查询形态。基线 `ead3d8f`；本地 D1（db:init:local）EXPLAIN QUERY PLAN 已实测。与安全审计重复的发现此处只留交叉引用。

## 一、发现登记

| ID | 级别 | 一句话 | 位置 |
|---|---|---|---|
| C1 | P2（正确性/可被低价值投毒） | `normalizeCacheQuery` 的 `tag` 参数做了 trim，服务端 `?tag=` 消费点**不 trim**——键空间碰撞可让带空白的 tag 请求把「空结果」缓存到干净键上（/ 与 /api/public/posts 两处受影响，TTL 30 分钟） | src/pagecache.ts:94-98 vs src/pages.ts:234、src/api.ts:2137 |
| C2 | P2（失效链路漏网） | **作者回复评论的两条路都不清页面缓存**：面板回复端点与前台作者发言分支都插 approved 行但不挂 purgePageCache（作者回复刻意不触发 fireCommentCreated，purge 搭车落空）——访客最长 30 分钟看不到新回复（作者本人有 Cookie 恒回源，自己看不出问题） | src/api.ts:1663-1690、src/api.ts:2230-2253 |
| C3 | P2（失效链路漏网） | **友链全部管理端点不清页面缓存**：新建（直接 approved）/编辑/删除/收录/排序都改变公开 /links 页，均无 purge——/links 在 CACHEABLE_PAGE_RE 白名单内，副本最长 30 分钟滞留 | src/api.ts:1112-1209 |
| C4 | P2（失效链路漏网） | 分类三个端点（POST/PUT/DELETE）不清缓存：分类名进导航与 /category/:slug 页头（B23 描述），改动滞留最长 30 分钟 | src/api.ts:1225-1271 |
| C5 | P2（低频登记） | `DELETE /admin/tags/:name` 改写 posts.tags 不清缓存，/tag/:x 聚合页滞留；积分 dailyLogin 变化不影响 /rank 清理（点赞数同级的装饰性滞后，文档已备案口径） | src/api.ts:1499-1516 |
| C6 | P2（查询形态，均在缓存后面） | EXPLAIN 实测三处「全表扫 + TEMP B-TREE」：adjacentPosts（文章页 prev/next）、listSitemapPosts（ORDER BY updated_at）、listAllPublishedArchives（ORDER BY COALESCE 别名）；数据量级与 30 分钟匿名缓存 + 浏览器 600s 下可接受，登记不改 | src/db.ts:393-410/413-418/355-362 |
| C7 | 交叉引用 | /images 图床边缘缓存失效缺口（删除不失效 + favicon 键可覆盖）：详见 SECURITY-AUDIT-2026-10-15.md F2 | src/index.ts:269-302 |
| C8 | 交叉引用 | settings 共享快照键无实例维度：详见 SECURITY-AUDIT-2026-10-15.md F1 | src/db.ts:118 |

## 二、① normalizeCacheQuery ↔ 服务端语义逐参数比对

| 参数 | 缓存侧（pagecache.ts:72-101） | 服务端 | 结论 |
|---|---|---|---|
| page | parseInt；NaN→省略；clamp 1..1000 | pages.ts:240 / api.ts:2141 / 2157 均 clampInt(_,1,1000,1) | ✅ 一致 |
| limit | 同上 1..50 | /api/public/posts clampInt(1,50,10)、/api/public/weibo clampInt(1,50,20)（默认值不同但默认=省略键，无碰撞） | ✅ 一致 |
| wb | `/^\d{1,12}$/` 否则省略 | pages.ts:871-873 同款正则（trim 后判定） | ✅ 一致 |
| topic | trim().slice(0,24) 再 encode | pages.ts:866 同序同长 | ✅ 一致 |
| q | trim().slice(0,60) 再 encode | pages.ts:238 同序同长 | ✅ 一致 |
| sort | random→回源；白名单四值；未知→省略 | pages.ts:243-244 HOME_SORTS 白名单（latest/views/likes/comments/random），未知回落 latest；random 的 seed 参数不在缓存白名单→整请求回源（无键碰撞） | ✅ 一致 |
| tag | **trim()**；>64 回源；否则进键 | **pages.ts:234 与 api.ts:2137 都是 `get('tag') \|\| undefined` 原样使用，无 trim 无截断** | ⚠️ C1 |

C1 推理链：请求 `/?tag=%20foo%20`（或 `/api/public/posts?tag=%20foo%20`）在缓存侧归一为键 `tag=foo`，服务端却按 `' foo '` 查（jsonItemLikePattern 生成 `%" foo "%` 形态，通常空结果）→ 该响应（200 + JSON/HTML）被回填到 `tag=foo` 键上；随后任何访客的正常请求 `?tag=foo` 命中这份错误副本，最长 30 分钟。攻击者只能使键「收敛」（trim 后碰撞），无法给任意键投毒，且内容只可能是「服务端真实算出的某个结果」，故定 P2。修复取一侧即可：缓存侧去掉 trim（与服务端同用原值，仍保留 ≤64 回源），或服务端补 trim（顺带修齐两处消费点）。

其余键判定核验通过：键带 `u.host`（pagecache.ts:163）防多域名串副本；重复参数/未知参数一律回源；`_r` 旁路靠未知参数规则生效；只回填 200 + 无 Set-Cookie + 白名单 content-type（pagecache.ts:169-173）；浏览器侧响应保持 SSR no-cache（只改 clone 出来的副本头，pagecache.ts:210-214）；posts.views 自增在 renderPost handler 内（pages.ts:550），边缘命中不进 handler，结构性不计数；灰度/演示站/三类登录 Cookie 判定全走单点 pageCacheKeyFor。

## 三、② 失效链路完整性清点（会改变匿名访客可见内容的全部写端点）

**hooks 四出口（自动覆盖）**：firePostPublished / fireWeiboPublished / fireCommentCreated / firePlazaRetract 均在出口开头 purgePageCache（hooks.ts:414-450），覆盖后台发布、开放 API（external.ts:193）、TG（external.ts:557）、MCP（mcp.ts:447-448）、定时发布（scheduler.ts:62）、访客三路评论。

**api.ts 散口逐点核对**：

| 写端点 | 清理 | 证据 |
|---|---|---|
| POST /admin/posts（published） | ✅ 经 firePostPublished | api.ts:659-670 |
| PUT /admin/posts/:id（已发布编辑） | ✅ 显式 purge；草稿/定时→发布经 firePostPublished | api.ts:765、776-787 |
| POST/PUT posts pin | ✅ | api.ts:816 |
| DELETE posts/weibo（软删） | ✅ 经 firePlazaRetract（内含 purge） | api.ts:827、987 |
| POST/PUT/DELETE weibo + pin | ✅ 同上两路 | api.ts:943、946-950、971/977 |
| 页面 POST/PUT/DELETE/reorder | ✅ | api.ts:1299、1324、1334、1350 |
| 回收站恢复（三表） | ✅ | api.ts:1402 |
| 回收站彻底删除/purge | ✅ 无需（软删时已消失） | — |
| 评论审核 PUT | ✅ | api.ts:1705 |
| 评论删除 DELETE | ✅ | api.ts:1724 |
| 媒体合并 | ✅ | api.ts:1590 |
| 设置 PUT / 备份回写 | ✅ saveSettings 自动换 epoch | db.ts:185-190 |
| **评论回复（面板端点）** | ❌ C2 | api.ts:1663-1690 |
| **作者前台回复（publicComment admin 分支）** | ❌ C2 | api.ts:2230-2253 |
| **友链五端点** | ❌ C3 | api.ts:1112-1209 |
| **分类三端点** | ❌ C4 | api.ts:1225-1271 |
| 标签删除 | ❌ C5（低频登记） | api.ts:1499-1516 |

补充说明：作者回复不触发 onCommentCreated 是**刻意设计**（hooks.ts:70-71「作者自己的回复不触发，避免同步场景里自我刷屏」），purge 搭在钩子出口上于是被一起跳过——修法是在两条回复路径插库成功后补 `purgePageCache`（与评论审核同形状），钩子语义不用动。

## 四、③ /images 图床边缘缓存

- 回填判据 `isImageStorable`（pagecache.ts:237-241）：200 + 无 Set-Cookie + image|video mime（R2 兜底 octet-stream 不缓存）✅。
- If-None-Match 先在边缘复验 304（pagecache.ts:257-266），304 只带回 ETag/Cache-Control/nosniff ✅；R2 侧 ETag 复验在回源路（index.ts:285-291）✅。
- 键带 host、query 不进键（/images 不读 query，?v= 破缓存参数同键同字节）✅。
- **免 epoch 前提核验**：saveUpload 键 = `dir/年月/时间戳36进制+随机6位.ext`（store.ts:47），手动上传/转存/OG 卡图三条路全部内容寻址 ✅；**两个反例**（favicon 固定键可覆盖、删除不失效）见安全审计 F2/C7。
- 304/200 响应统一无条件下发 `max-age=31536000, immutable`（index.ts:289/296）——无视 R2 对象自带 cacheControl（favicon 写的是 604800，api.ts:1049），是 F2 破口二的放大器。

## 五、③ settings 共享快照失效清点

全仓 settings 表写入点共 11 处，逐一核对：

| 写点 | 失效 | 证据 |
|---|---|---|
| saveSettings | ✅ 内置 | db.ts:200 |
| refreshFootStats（siteFoot） | ✅ | db.ts:1232 |
| ensureSchema（ftsSeeded / pagesSeeded / 冷启动 siteFoot） | ✅ 收尾统一清 | db.ts:1217 |
| setupLock INSERT（/auth/setup） | ✅ 写后即清 | api.ts:164 |
| setupLock DELETE（建号失败回滚） | ⚠️ 不清——无害：该键无 getSettings 消费方，仅作原子锁标记 | api.ts:180 |
| recordEditionFailure（editionEnError/Status/At） | ✅ | i18n.ts:248 |
| demo 播种收尾（认领位/完成位等） | ✅ | demo.ts:332 |
| 备份回写 lastBackupAt/Bytes | ✅ 走 saveSettings | backup.ts:85 |

只读直查是否误入快照：ensureSchema 读 ftsSeeded/pagesSeeded/siteFoot 记账位用裸 SELECT（db.ts:1172/1192/1213），不经快照 ✅（正确——若走快照会读到播种前的空值死循环）。getSettings 的 in-flight 去重按 db 实例 WeakMap 隔离（db.ts:120/173-178）✅。快照键作用域问题见安全审计 F1。

## 六、④ 数据层索引与查询形态

**三条表达式索引双表达比对（schema.sql ↔ db.ts SCHEMA_INDEXES）**：逐字符一致 ✅——
- idx_posts_feed `ON posts (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL`（schema.sql:95 = db.ts:1124）
- idx_weibo_feed（schema.sql:153 = db.ts:1122）、idx_weibo_feed_pinned（schema.sql:154 = db.ts:1123）同。
- 排序片段：listPosts 默认 `ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC`（db.ts:268/283，为索引前缀，id 隐式 tiebreak）；listWeibo 两种形态（db.ts:821-823）与索引一一对应。tests/feed-index.test.ts 在位。

**EXPLAIN QUERY PLAN 实测（本地 D1，db:init:local 后 wrangler d1 execute --local）**：

| 查询 | 计划 |
|---|---|
| listPosts 默认排序 | `SEARCH posts USING INDEX idx_posts_feed (status=?)`——无 TEMP B-TREE ✅ |
| listWeibo（pinnedFirst 两形态） | `idx_weibo_feed` / `idx_weibo_feed_pinned`——无 TEMP B-TREE ✅ |
| 搜索 LIKE 路（q 命中时） | `idx_posts_feed`——无 TEMP B-TREE ✅ |
| listWeiboLastmod（MAX COALESCE） | `idx_weibo_feed`——MAX 直接吃索引序 ✅ |
| adjacentPosts prev/next | `idx_posts_status` + **TEMP B-TREE**（C6） |
| listSitemapPosts（ORDER BY updated_at） | 索引取 status + **TEMP B-TREE**（C6；idx_posts_updated 在场但规划器弃用） |
| listAllPublishedArchives（别名排序） | `idx_posts_status` + **TEMP B-TREE**（C6） |

**评论计数 INDEXED BY 四处**：db.ts weiboCommentCountMap:877 / postCommentCountMap:891 / listPosts sort=comments 子查询:280、pages.ts commentCount:156——全部在位 ✅。

**LIKE ESCAPE 全量抽查**：用户输入参与的全部 LIKE（listPosts q/tag、listMembersAdmin、relatedPosts、weiboConditions topic、标签清理扫描 api.ts:1504、fts.ts:96 微博 LIKE 兜底）都带 `ESCAPE '\'` 且模式经 likePattern/jsonItemLikePattern ✅；不带 ESCAPE 的 LIKE（audit.ts 体检预筛 7 处）模式均为字面量 `'%/images/%'`，无用户输入，无需转义 ✅。

## 七、结论

1. 缓存键的六参数镜像精确，唯一偏差是 tag 的 trim（C1）——一行修复。
2. 失效链路的主干（hooks 四出口 + 文档点名的散口）完整；漏网集中在**文档没点名的散口**：作者回复（C2，最值得修——站长自己回复后访客看不到）、友链、分类、标签删除。
3. 索引双表达与 P0-1/P0-3 修复全部复验在位；EXPLAIN 证实时间线与搜索路无临时排序，剩余三处全表扫+排序都在匿名缓存后面，量级可接受。
