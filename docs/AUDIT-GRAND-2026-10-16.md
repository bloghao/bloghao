# 夜间大巡检 · 总报告 — 2026-10-16 深夜（跨 10-17 凌晨收尾）

> **〇、与主线的合并说明（2026-10-17 同步时补记，先读这节再看正文）**
> 本报告是本地夜班针对同一份 10-16 审计的独立实现记录；同一批 L1–L7 已由另一条会话以**另一套实现**先一步推上主线（`60db6e8`，fetchsafe 扩 method/body/expectBody、beacon 限频 10/分 + 单站单字段单日封顶、maskPlazaToken、反斜杠全剥等），主线现已带 2.6.0 与后续功能批。2026-10-17 同步时：本地三笔提交收进备份分支 `backup/audit-local-20261017`（保留备查，未重放）；从本地实现**只移植了主线真正缺的两件**——N1 修复（`/admin/plaza-stats` 代理出网加固）与 L1①注释分词防重组。逐项对照：L1① = 本报告版（已移植）；L1② 主线用「反斜杠全剥」替代本地「含反斜杠即拒」（同效，剥除型更贴幂等设计）；L2/L4/L5/L6/L7 主线 `60db6e8` 已等价落地；L3 主线用限频+封顶替代本地 per-IP 天级预算表（`beacon_budget` 未采用，如后续 hub 灌量再起可重启此案）。下文「修法」栏描述的是本地实现，与主线代码细节不一致处以上述对照为准；EXPLAIN 实测、死代码扫描、新增面抽查与实现选择无关，结论继续有效。

> **定位**：应站长「安全审计 / 效率提升 / 优化 / 代码精简」大巡检指令的一次夜班。以 `docs/SECURITY-AUDIT-2026-10-12.md`（基线终态）、`docs/SECURITY-AUDIT-2026-10-15.md`、`docs/SECURITY-AUDIT-2026-10-16.md` 为先验，本轮主线是**把 10-16 报告登记的 L1–L7 待办全部落地**，并做增量扫漏（出网点 / SQL 执行计划 / 死代码 / 文档漂移 / 新增面抽查）。
> **基线**：`8380e30`（v2.5.1），typecheck ✓ / npm test 715/715 ✓。
> **方法与覆盖面（如实声明）**：原计划 11 路子代理全文件深读，当晚子代理通道被平台拦截，改为**主会话内联推进**——优先级给到「已登记待办落地 + 定向扫漏 + 实测验证」，未做 30+ 文件的逐行全文复读（那是 10-12/10-15 两轮全量审计已完成的地基，本轮不重复烧）。发现纪律沿用：说不出具体后果不定级，宁报勿漏不编造。
> **纪律**：全部修复只在本地 commit（`8627e32` 与本报告提交），**未推送任何远程**——推送即上线，留站长晨间复核后自行推送。

## 一、落地修复（P2 × 8，全部验证）

| 项 | 位置 | 修法 | 验证 |
|---|---|---|---|
| L1 皮肤包 CSS 转义绕过 | `src/skinpack.ts` | ① 注释先剥且位置落成**空格**——浏览器解析时会零宽丢弃注释重组分词（`@im/**/port` → `@import`），先剥掉并落空格让分词永远拼不回去；② **含反斜杠（CSS 转义序列）一律拒绝**（`@\69 mport` / `expr\65 ssion(` 这类绕过明文剥除的写法整根掐断，皮肤 CSS 配色/字体/间距用途合法场景用不到反斜杠，宁拒勿漏） | tests/skinpack.test.ts +4 |
| L2 出站 Webhook 事件清单失败开放 | `src/hooks.ts` | `outboundEventList` 改**三态**：空 = null = 全部放行；合法 = 白名单；**含坏项 = 空数组 = 一律拒发**（失败封闭）。`configValidate` 对含坏项与纯逗号清单均拒绝保存（旧口径 `' , '` 会静默变「全部放行」） | tests/hooks.test.ts +2 |
| L3 `/api/beacon` 无凭据灌量 | `plaza/src/index.ts` | 新增**每 IP 每日计数预算** `BEACON_IP_DAILY = 2000`：`beacon_budget` 表（day, ip_hash 天级盐哈希记账、accepted 累计、cron 清 7 天前行、schema.sql 两处同步）。单 IP 单日灌量从「近 3 万请求 × 单批 ≤1000 计数」封顶到常量；正常访客一天逛广场远用不满，NAT 共享同量纲内不受影响。隐私口径与 likes 相同（不存原始 IP） | typecheck + 既有 beacon 用例 |
| L4 `/api/site-stats` 接受 `?token=` | `plaza/src/index.ts` | 改 **header-only**（`x-plaza-token`）；「浏览器直开」场景由博客端 `/api/admin/plaza-stats` 服务端代理承担（该代理本就走 header，**无破坏面**）；PLAZA.md 协议同步 | typecheck + 消费方核对 |
| L5 `maskToken` 位宽偏弱 | `plaza/src/index.ts` | 只回**末 4 位**（`…xxxx`），前缀不再回显 | typecheck |
| L6 `needsFontSrc` 读未净化值 | `src/skinpack.ts` | 判据改为 `cleanCustomCss` 结果非空——库里被旁路写脏（净化会拒）的 customCss 不再触发 CSP `font-src` 放宽 | tests/skinpack.test.ts +2 |
| L7 出网点裸 `fetch` ×3 | `src/fetchsafe.ts` + `src/hooks.ts` | fetchsafe 新增 **`postPublicResource`**（POST 型出站助手：同套 `fetchableUrl` 起点校验 + `redirect:'manual'` 逐跳复查 + `hostOk` 钩子；跟跳后仍按 POST 重发载荷（webhook 语义是「载荷要送达目标」）；不读响应体、返回前取消未读流；返回最终 Response 含非 2xx 供状态记账）。commentWebhook / plazaIngest / outboundSend 三处统一改走；commentWebhook 顺带补运行时 `fetchableUrl` 复核（此前只查前缀，落库校验不是最后防线） | tests/fetchsafe-post.test.ts 新建 6 用例（透传 / 逐跳 / 越界放弃 / 私网拒 / 非 2xx 返回 / opaqueredirect / hostOk） |
| **N1（本轮新发现，L7 同类漏网）** | `src/api.ts:630` `/admin/plaza-stats` 代理 | 广场数据卡代理此前裸 fetch 自动跟跳且运行时只查 https 前缀——改走 `fetchableUrl` 运行时复核 + `fetchPublicResource`（maxBytes 256KB）；失败文案合并（网络异常与非 2xx 在该通道不区分） | typecheck + 全量测试 |

**自托管取舍（如实登记）**：Node（undici）下 manual 重定向返回 opaqueredirect，`postPublicResource` 直接放弃——docker-poc 形态下带重定向的 webhook 目标会投递失败，与 `fetchPublicResource` 既有口径一致（Workers 正常跟跳）。

## 二、增量扫漏记录

**出网点全仓清点**（grep `fetch(` 全量定性）：`fetchPublicResource`/`postPublicResource`/`fetchPullTarget` 已覆盖全部用户/第三方可控 URL；剩余裸 fetch 均为**固定可信端点**（api.telegram.org ×2、q1/q2.qlogo.cn QQ 头像、api.buffer.com ×3）或进程内接线（app.fetch），与 AGENTS 出网安全防线豁免清单一致。**本轮后仓库内已无「用户可控 URL + 裸 fetch」组合。**

**SQL 执行计划实测**（本地 D1，`EXPLAIN QUERY PLAN`）：

| 查询 | 计划 | 结论 |
|---|---|---|
| listPosts 默认时间线（pinned DESC, COALESCE… DESC） | `SEARCH posts USING INDEX idx_posts_feed (status=?)` | ✅ 无 TEMP B-TREE |
| listWeibo 两形态 | `idx_weibo_feed` / `idx_weibo_feed_pinned` | ✅ 无 TEMP B-TREE |
| 评论计数（INDEXED BY 强制） | `SEARCH cm USING INDEX idx_comments_post (post_id=?)` | ✅ 读放大防线在位 |
| FTS 回连 | `SCAN f VIRTUAL TABLE INDEX 0:M3` + rowid 直取 | ✅ |

（审计中手写「稻草人」查询曾报 TEMP B-TREE，均系排序片段与真实 SQL 不符所致，排除；10-15 登记 C6 三处已知 TEMP B-TREE——adjacentPosts / listSitemapPosts / listAllPublishedArchives——维持「登记不改」口径。）

**死代码扫描**（全仓导出引用计数）：**零真死代码**。23 个导出仅同文件使用（P3 信息项，多为常量语义导出，不强求收拢：`appearance.ts` ×4、`audit.ts` ×0、`mcp.ts` PROTOCOL_VERSIONS、`pagecache.ts` PAGE_CACHE_TTL_S、`points.ts` ×3、`render.ts` ×6、`seo.ts` ×2、`skinpack.ts` CUSTOM_CSS_MAX、`utils.ts` NICKNAME_MAX_LEN、`xml.ts` XML_CTRL_RE、`demo-content.ts` ×7）。符合「复杂度预算」口径，不做无价值 churn。

**新增面抽查**（10-16 审计未逐条覆盖的最后三面）：onboarding 两键（PUT 归一化 + 设置页保存清单排除，smoke 首装段守着）✅；文章 AI 生成申报（缺键即保留语义接线正确 `p.has.aiGenerated`、公开面仅文章页 meta 行展示）✅；评论 IP 属地（API.md 32/44 行契约齐备）✅。

**文档漂移**：`docs/API.md` 文章契约补记 `aiGenerated` 字段（GUIDE §已有用户面说明，API 契约漏登记——本轮补齐）。

## 三、验证与提交

- `npm run typecheck` ✓；`npm test` **726/726** ✓（基线 715，净增 11：fetchsafe-post 6 + skinpack 4 + hooks 2 − 合并重叠 1）；smoke 见提交记录（渲染/SQL 无行为变更，回归口径以全量测试为准）。
- 本地 commit：`8627e32`（L1–L7 主体 + 文档回写）+ 本报告与 N1 修复批。**未推送**——站长复核后自行 `git push`（推送即上线主站）。

## 四、遗留与建议（待站长拍板）

1. **L3 残余**（既定取舍内）：beacon 预算挡得住单 IP，换 IP 脚本仍可灌——无凭据匿名端点的物理上限，如需根治须上 Turnstile 或签名票据（B25 拍板时已评估「重放价值低」，维持）。
2. **hub 部署提醒**：L3/L4/L5 在 hub 端，需与 M1–M4 一起**重建甲骨文 `plaza-hub` 容器**（`demo/hub-node` 构建）方生效；主内核 L1/L2/L6/L7/N1 随 Workers Builds 推送即上线。
3. **覆盖面**：本轮定向扫漏 + 待办清零已完成；若要再做一轮「30+ 文件逐行全文复读」式全量深审（上两轮各隔约 3 天），建议等下一批功能落地后随批做增量，成本收益更好。
4. 23 个 self-only 导出与 C6 三处 TEMP B-TREE 维持登记，不建议为精简而精简。
