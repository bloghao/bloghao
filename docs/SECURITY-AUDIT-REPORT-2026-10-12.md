# xwblog 安全审计(修复)报告 — 2026-10-12

| | |
|---|---|
| **审计对象** | xwblog(博客号 BlogHao 二次开发)开发线 main,基线 `b8d21f5`(bloghao 2.4.0 开发版) |
| **修复提交** | `b250ad0`(22 文件,+516/−44) |
| **审计方法** | cloudflare/security-audit-skill 方法论裁剪版:侦察 → 覆盖台账 → 7 猎手按攻击类别并行猎捕 → 独立验证者复核(与发现者不同代理)→ 三态结论 → 修复 → 报告 |
| **覆盖范围** | src/ 全部 35 个 TS 模块、七主题、后台 SPA(app.js/editor.js/emoji.js)、前台 site.js/share-card.js、plaza hub Worker、docker-poc shim、wrangler×2、CI/供应链、演示站引擎 |
| **回归验证** | `tsc --noEmit` ✓;`npm test` 545/545 ✓;`npm run smoke` 189/189 ✓;GitHub CI(CI + Deploy)双流水线 success |
| **全程记录** | 过程台账/断点见 [SECURITY-AUDIT-2026-10-12.md](SECURITY-AUDIT-2026-10-12.md);AGENTS.md 已登记全部新防线 |

## 一、执行摘要

本轮「必要核心档」审计共产生 **27 条候选发现**(medium 8、low 19),经独立验证 **8 条 medium 全部成立**,无 critical/high 级问题。**21 项已修复并带回归测试**,2 项 medium 做了限流层缓解(根治属产品决策,见遗留),4 项 low 登记为已接受取舍或待站长核实。审计同时确认了大批面的干净状态:SQL/HTML/XML 注入**零发现**、site.js 与服务端镜像**零漂移**、CSRF 三层纵深无遗漏、87 条 API 路由鉴权顺序无漏、备份/演示清库表清单全覆盖。

三个最值得记录的问题(均已修):

1. **积分日上限竞态**(medium):记账的 SUM 预查与写入不在同一事务,并发可刷穿「每日 20 分」上限刷高排行榜——改为 batch 内条件写(条件 UPDATE + 超额条件 DELETE 谓词互斥),新增竞态回归用例。
2. **密码文摘要泄漏**(medium):发布后补设访问密码时,编辑器恒回传的旧自动摘要短路了清空逻辑,正文前 80 字继续经 RSS/meta/列表公开——违背「密码文只出作者自填摘要」契约,现与旧正文摘要比对自动清空,存量泄漏行下次保存自愈。
3. **广场锁文生命周期缺口**(medium ×2):hub 的 RSS pull 补漏路把锁文标题摘要捞上公开广场,且事后加锁/删文后 hub 永不下架——协议闭环:RSS 加 `<bloghao:locked>` 机器可读标志、pull 过滤、新增 `firePlazaRetract` 推 `deleted` 下架广播。

## 二、发现统计与处置

| 严重度 | 候选 | 已修复 | 部分缓解 | 登记接受/待核实 |
|---|---|---|---|---|
| critical / high | 0 | — | — | — |
| medium | 8 | 6 | 2(A2 注册零验证、A4 打点写入面) | 0 |
| low | 19 | 15 | 1(A10 入口收敛/运行时取舍) | 3(A11 权衡、C2 待核实、C3 接受) |
| **合计** | **27** | **21** | **3** | **3** |

> 判级纪律(方法论口径):说不出具体后果不定级;纵深防御缺失只算加固建议;「已知取舍」(AGENTS.md 在案)不重复计入。

## 三、重点发现与修复(8 条 medium)

| ID | 发现 | 攻击链(摘要) | 修复 | 状态 |
|---|---|---|---|---|
| A1 | 积分日上限 check-then-act 竞态 | 并发评论记账全部读到同一 SUM 快照,10 连发可突破每日 20 分刷 /rank 与会员档位 | points.ts 日上限守卫下沉 batch:②条件 UPDATE(SUM 含本批)+ ③超额条件 DELETE(refId 定位),adminAdjust 保留原路径;members.test 补「预查后并发抢占被批内摘除」用例 | ✅ 修复 |
| A2 | 会员经济零 Sybil 成本 | 批量注册小号(注册零验证)×每号每日 20 分,挤掉 /rank 真实会员并灌即时上屏 spam | 会员评论限流叠加 IP 桶(20/10min);**根治(注册验证/Turnstile)待站长拍板** | ◐ 缓解 |
| A3 | 公开写端点无入站体积预检 | ~99MB JSON 不触平台 413,`json()` 整读(字符串+parse 双份内存)可 OOM 128MB isolate,连坐同 isolate 并发请求 | api.ts 全局中间件:非 GET 先看 Content-Length,常规 2MB/上传与外部微博 multipart 30MB,超限 413 | ✅ 修复 |
| A4 | /api/public/track 无鉴权 D1 写入面 | 代理池 17,280 行/日/IP 可烧穿 D1 日写配额,全站写路径(发文/评论/登录)当日失败 | 限流 120→30 次/10min/IP(正常访客到不了);**根治(聚合/抽样写)待设计** | ◐ 收口 |
| B4 | douban/img 封面代理绕过 fetchsafe | redirect:'follow' 跟跳不过五域白名单(白名单域一出现可滥用 302 即引 Worker 抓任意 URL);arrayBuffer 整读后才查 1MB,chunked 大响应撑爆内存 | fetchsafe 新增 `opts.hostOk` 每跳白名单钩子;代理改走 `fetchPublicResource`(manual 逐跳复查 + 流式限长 1MB);Node 下 opaqueredirect 放弃属既有取舍 | ✅ 修复 |
| B7 | 补设密码残留自动摘要泄漏 | 编辑器恒回传 summary(预填旧自动摘要)短路与 willLock 的清空逻辑,残留 80 字经 RSS `<description>`/meta/JSON-LD/列表公开 | PUT 在 willLock 下与旧正文 `excerpt(content, 80)` 比对命中即清(不限定本次新设,存量自愈;手填撞自动摘要误清方向更安全) | ✅ 修复 |
| B8 | 广场 pull 路不滤锁文 | push 路「加密文不上广场」(hooks.ts locked 检查)被 pull 路整体绕过:RSS 条目(标题+摘要+链接)直接入库公开 feed | RSS 加 `<bloghao:locked>` 机器可读标志(bloghao 命名空间);plaza parseRssItems 解析 + pull 跳过(非 https link 同跳) | ✅ 修复 |
| B9 | 广场条目生命周期缺口 | `deleted` 协议字段无任何发送方;事后加锁/升档/转草稿/软删均不同步 hub,「已加密/已删」条目无限期滞留公开广场 | hooks.ts 新增 `firePlazaRetract`(尊重插件停用开关与 demo 门控),api.ts 三路接线(PUT 补密/升档/转草稿、posts 软删、weibo 软删);解锁/恢复后 6h 内 pull 自愈补回 | ✅ 修复 |

low 级 19 条的完整清单与逐条终态见断点记录「四·一」,要点:membersEnabled 关闭后存量会员会话仍可评论计分、封禁会员过审照常记分、恢复微博绕过置顶名额、TG webhook 无 update_id 幂等(超时重投重复发博)、demo 出网面 5 处未短路(备份/导出/粘贴转存/采集/友链抓图)、commentWebhookUrl 明文回显、编辑器预览缺 noopener、/go 缺 frame-ancestors、外观查表原型链键 500、导出 zip 条目名无二次校验、卡片 href 生成时无 scheme 白名单——均已修复。

## 四、修复清单(按文件)

| 文件 | 改动 |
|---|---|
| `src/points.ts` | 日上限批内条件守卫(②条件 UPDATE / ③条件 DELETE) |
| `src/api.ts` | 入站 Content-Length 预检中间件;B7 摘要清空;会员分支 membersEnabled 门控;会员评论 IP 桶;track 限流收紧;恢复微博置顶名额条件更新;过审前查 active;commentWebhookUrl 进 SECRET_SETTINGS;自配出网 URL 落配置过 fetchableUrl;demo 门控×5;douban/img 改走 fetchsafe;firePlazaRetract 三路接线 |
| `src/fetchsafe.ts` | fetchPublicResource 新增 `opts.hostOk`(每跳含起点复检) |
| `src/external.ts` | TG webhook update_id 内存 5 分钟幂等 |
| `src/rss.ts` | bloghao:locked 锁标志 + 命名空间声明 |
| `src/hooks.ts` | firePlazaRetract(deleted 下架广播) |
| `plaza/src/core.ts` / `plaza/src/index.ts` | parseRssItems 解析锁标志;pull 跳过锁文与非 https;注册/pull 双重内网主机防线 |
| `src/index.ts` / `src/appearance.ts` / `src/export.ts` / `src/linkmeta.ts` / `src/douban.ts` / `src/collect.ts` / `public/admin/editor.js` | 加固位:/go frame-ancestors、查表 hasOwnProperty×2、zip 条目名防线、卡片 href/img scheme、collect demo 门控、预览 noopener |

**测试与文档**:members.test(桩升级 + 竞态用例)、rss.test(锁标志)、plaza-hub.test(locked 解析)、hooks.test(firePlazaRetract);PLAZA.md(锁标志/下架同步/pull 口径);AGENTS.md 登记 5 处新防线;本报告 + 断点记录。

## 五、已知接受与遗留事项

**已接受的取舍**(威胁模型内可容忍,登记在案):

- 入站预检对 chunked(无 Content-Length)请求放行——正常客户端与 curl 均带 CL,热点端点另有限流/鉴权在前
- A10 运行时侧:commentWebhook/plazaIngest 保持 POST 裸 fetch(fetchPublicResource 不支持 POST);配置入口已过 fetchableUrl 挡私网,Workers 私网本不可达
- C3:TG webhook 兼容旧绑定的 `?secret=` query 通道(secret 会进 observability 日志;可轮换凭证)——建议重绑后移除
- B6:hub RSS pull 的 redirect follow 保留——hub 跑 Node,manual 重定向返回 opaqueredirect 会整体断流,属平台取舍(注册+pull 双重内网防线已补)

**需站长决策/操作**(4 项):

1. ⚠ **重建广场 hub**:plaza/ 改动要在服务器重建 demo/hub-node 容器后才生效;未重建前旧 hub 忽略未知命名空间标签,pull 仍会收录锁文条目(源站侧 retract 与锁标志已即时生效)
2. 注册环节人机验证(Turnstile/邮箱验证)——A2 的根治,产品决策
3. CF dashboard 核实 `*.workers.dev` 平行入口,不用则下个发布加 `workers_dev: false`
4. A4 根治(track 打点聚合/批量写)与 A11(游客评论内容聚合)列入下轮产品设计权衡

## 六、审计确认的干净面(抽样)

- **注入面(H2,93 次工具调用逐点核对)**:全部 `prepare` 参数化、LIKE 全带 ESCAPE、渲染链转义齐、xmlEsc 统一出口、R2 key 前缀白名单——零 confirmed 发现
- **鉴权(H1)**:87 条 API 路由×鉴权中间件注册顺序逐条核对无漏;Origin 中间件覆盖全部非 GET;clientIp=CF-Connecting-IP 不可伪造;token 全部 safeEqual + header-only
- **客户端(H6)**:site.js 2086 行全读,ES5 零违规;76 域外链白名单与服务端**零漂移**;emoji 镜像逐字符一致;CSRF 三层纵深(HttpOnly/Secure/SameSite=Lax + Origin 中间件 + token 面)无缺口
- **配置/供应链(H7)**:BACKUP_TABLES 13/17 表逐核(排除项均有依据)、WIPE_TABLES 全覆盖、凭据 grep 零命中、CI 无 secrets 无 pull_request_target、plaza HMAC 双端镜像规范

## 七、结论

当前版本(开发线 `b250ad0`)未发现 critical/high 级问题;8 条 medium 与 15 条 low 已修复并通过 545 项单元回归与 189 项冒烟断言;3 项部分缓解与 3 项登记事项均有明确归属与跟进口径。剩余动作中只有「重建广场 hub」影响已发布修复的完整生效,建议尽快执行;其余为产品层决策。方法论口径下单轮审计约为多轮总覆盖的一半,建议以本报告为先验(confirmed 根因不再猎捕)按季度复跑。
