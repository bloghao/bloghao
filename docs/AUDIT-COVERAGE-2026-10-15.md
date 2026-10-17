# 防线测试覆盖审计与缺口补齐（夜间自动审计）— 2026-10-15

> **夜间自动审计（2026-10-15）· 未经人工复核，结论仅供参考。**
>
> 方法：把 AGENTS.md 回归防线每条可测断言列成清单，逐一到 tests/ 找对应用例并核实**真断言了该行为**（不是只 import 了名字）；对确认无守卫且现有基建可覆盖的缺口补新测试。基线 636 用例全绿 → 结束时 **662 用例全绿**（typecheck ✓ / npm test 662/662 ✓）。
>
> **纪律声明**：tests/ 只增不改已有文件。唯一的 src 触碰是给 src/export.ts 的两个模块私有纯函数（`keyOf` / `zipEntrySlug`）补了 `export` 关键字与一行注释——纯函数零行为变更，仅为满足「Node 直接导入纯函数」的补测基建；若站长不接受可删掉 tests/export-guard.test.ts 并还原这两行。

## 一、本次新增（5 个新测试文件，26 个用例）

| 文件 | 钉住的防线 | 用例数 |
|---|---|---|
| tests/export-guard.test.ts | 导出包 R2 key 白名单与穿越守卫（`keyOf`：`..`/`\`/`\0`/坏编码/前缀白名单）+ zip 条目名脏 slug 回退（2026-10-12 审计 B2 修复本体，此前零覆盖） | 6 |
| tests/fetchsafe-hostok.test.ts | `fetchPublicResource` 的 `opts.hostOk` 白名单钩子逐跳复检（B4 修复本体：起点拒绝 / 302 出白名单拦下 / 白名单内跟跳放行 / hostOk 不得豁免 fetchableUrl 私网基线）——fetchsafe.test.ts 原本只覆盖 fetchableUrl/重定向/限长，hostOk 零覆盖 | 4 |
| tests/pagecache-normalize.test.ts | `normalizeCacheQuery` 直接单测（此前只经 pageCacheKeyFor 间接覆盖）：page/limit/wb/topic/q/sort/tag 七参数镜像语义、重复与未知参数回源、`_r` 旁路、同渲染结果同键 | 9 |
| tests/points-admin-adjust.test.ts | 积分 adminAdjust 分支：refId 代码层强制归 0（不进幂等唯一索引）、不受日上限、delta 可负、delta=0 与原型链 reason 拒绝、UNIQUE 冲突静默捕获——members.test 覆盖了批内守卫与评论幂等，adminAdjust 的两条 AGENTS 硬约束此前零覆盖 | 4 |
| tests/weibo-images-guard.test.ts | 微博图片写侧 `parseWeiboImages`（scheme 白名单/trim/9 张上限）与读侧 `weiboImageList`（脏 JSON 纵深）——B19 之前的老防线，两侧纯函数此前零直接覆盖 | 3 |

新增用例全部遵循仓库惯例：Node 直接导入纯函数 / fetch 全局 stub（仿 fetchsafe.test 的 stubFetch）/ 最小 D1 桩（仿 members.test 的 fakePointsDb，占位符数与谓词同口径）。**未写任何固化已知缺陷的用例**（见下「疑似缺陷」节）。

## 二、覆盖映射结论（防线 → 测试，抽查核实过「真断言」）

以下防线经核实**有真守卫**（用例断言了行为而非仅执行代码）：

- **XSS / 净化**：sanitize.test（数字实体混淆 java&#9;script:、属性转义、id 剥除、未终结标签前缀与未闭合注释的 escapeStrayLt 行为、`<meta data-og-image>` 唯一例外、未闭合丢弃标签吞到结尾）、markdown.test（safeUrlMd 剥 \t\r\n、escQuote 属性上下文）、outlink.test（wrapAnchorHref 幂等 + site.js wbTextHtml/TRUSTED_OUT/outHrefJs 切片镜像）、emoji.test（wxqReplace 服务端-客户端同表镜像）、jsonld.test（`<` → \u003c）、themes.test（七主题渲染回归 + headingAnchors）。
- **时间口径**：utils.test（cstDate 族、isoDate、dateSlug）、members.test（cstDayStart 北京日窗）、i18n.test（英文日期四件套 + 回退落库）。
- **SQL / 输入**：utils.test（likePattern/jsonItemLikePattern 转义）、feed-index.test（三条表达式索引与排序片段双表达镜像 + INDEXED BY）、member-schema.test（SCHEMA_COLUMNS/SCHEMA_TABLES 与 schema.sql 双表达不变量）、members.test（updateMemberNickname 条件更新、listRankTop active+积分>0）、fts.test（MATCH 构造、防泄漏、schema.sql 无触发器、changes 计数口径）。
- **回收站**：trash.test（软删过滤、级联守卫子查询、恢复过期定时文转草稿清 publish_at、purge 保留期）。
- **访问密码**：protect.test（PBKDF2 哈希/校验、解锁 Cookie HMAC 对当前哈希重算、protectedDescription 不泄正文摘要、表单 HTML）。
- **出网安全**：fetchsafe.test（私网表示法全覆盖、重定向逐跳、限长断流）+ 本次补的 hostOk。
- **会话**：auth.test（tokenHash 落库/Cookie 原文分离双不变量、safeEqual 常量时间、改密踢其他设备保留当前会话、rateLimit 窗口、clientIp）。
- **MCP**：mcp.test（协议层纯函数、node:sqlite 真库工具、hono 薄壳三层；password_hash 永不出参、list_comments 不出 email/qq/ip/avatar、加密文不进关键词搜索、批处理/通知/错误分级）。
- **外链中间页**：outlink.test（/go 白名单直跳、非白名单永不服务端跳转、2048 限长）。
- **站长 SEO**：seo.test（verify meta 白名单、统计脚本属性白名单与内联拒绝、analyticsOrigin、buildRobotsTxt 未配置时逐字节一致、isSpeculativeRequest、breadcrumbJsonLd、分类描述清洗）。
- **微博视频**：weibo-admin.test（parseWeiboVideo/weiboVideoView 双道、weiboVideoHtml 与 site.js 逐字节镜像、25MB 常量同源、patchFtypBrand 字节级、prepareVideo、accept 口径）。
- **演示站**：demo.test（slug 唯一、无 script/id/内联事件、评论树时序、正文图引用存在、WIPE_TABLES）。
- **页面缓存**：pagecache.test（键判定单点：三类登录 Cookie/demo/灰度/非 GET、hostname 键、epoch 失效根、imageCache 键与回填判定）+ 本次补的 normalize 直测。
- **settings 快照**：settings-cache.test（in-flight 去重、写后失效）。
- **其余**：store.test（imageExtOf hasOwnProperty、sniffUploadExt 魔数）、exif.test（orientation≠1 跳过）、zip.test、stats.test（清洗函数与协议相对 URL 拒绝）、bots.test（识别优先级、写入闸预算）、hooks.test（fireHook demo 门控与停用名单、firePlazaRetract）、site-status.test（闭站白名单）、site-mode.test（四口径）、appearance.test（hasOwnProperty 守卫 + 主题默认值镜像）、audit.test（isMediaKey、引用收集不误删、重复分组）、plaza-hub.test（双端签名镜像、locked 解析）、plaza-domain.test（退役子域名全仓扫描）、turnstile.test（fail closed）、version.test、website-sitemap.test、website-docs.test、onthisday/linkmeta/douban/collect/export/html-md/qrcode/comments-badge 各司其职。

## 三、登记未补的缺口（现有基建覆盖不了或不应固化）

| # | 缺口 | 为什么不补 |
|---|---|---|
| G1 | `buildCsp`（pages.ts:94，CSP 唯一组装处）无任何直接测试 | 未导出；SSR 渲染链不可在 Node 单测（补 export 属 src 改动，超本阶段「只增不改」边界）。CSP 头目前靠浏览器/smoke 面。建议下轮把它提为导出纯函数后补测（与 seo.ts 同模式） |
| G2 | TG webhook `update_id` 幂等（external.ts tgSeenUpdates 模块内存态）无测试 | 内部态未导出，Node 不可注入时钟；需要小重构（导出纯函数 + 注入 now）才能测 |
| G3 | `transferImage`（store.ts）魔数拒绝路无直接测试 | 依赖全局 fetch + Env（R2/D1）；其组成件（fetchPublicResource / sniffImageExt / saveUpload）各自有测，组合层留 smoke |
| G4 | 缓存键 tag 参数的**服务端侧**语义（pages.ts/api.ts 消费点不 trim）无测试 | SSR 消费链不可 Node 导入；且该行为本身是缓存审计 C1 登记的镜像缺口——修复后应在 pagecache-normalize.test 补「两侧同 trim」断言，现在写反而固化缺陷 |
| G5 | `memberView`（api.ts 内部）公开出参不带 qq | 未导出；公开面行为由 mcp.test/comments-badge.test 侧面覆盖 |
| G6 | wbr 在 ALLOWED_TAGS 缺失（API.md 声称保留） | 文档漂移 D3 待站长拍板改文档还是补代码——现在写测试会把争议行为固化成契约 |

## 四、疑似缺陷（本阶段发现，不写测试固化，详见各审计报告）

- **F3**（安全审计）：demo 下 /api/admin/export/* 无 isDemo 短路——修复后补一行 demo 门控断言即可。
- **C1**（缓存审计）：tag 键镜像 trim 缺口（见 G4）。
- **F1 / F2**（安全审计）：settings 快照键作用域、/images 缓存删除失效——平台行为，Node 测不了 caches.default，属集成/smoke 面。

## 五、验证结果

- `npm run typecheck` ✓（tsconfig 只含 src，测试由 tsx 运行）
- `npm test`：**662/662 通过**（基线 636 + 新增 26；无跳过、无取消）
- 新增文件清单：tests/export-guard.test.ts、tests/fetchsafe-hostok.test.ts、tests/pagecache-normalize.test.ts、tests/points-admin-adjust.test.ts、tests/weibo-images-guard.test.ts；src 变更仅 export.ts 两处 `export` 关键字 + 注释。
