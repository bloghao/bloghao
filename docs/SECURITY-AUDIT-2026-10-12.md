# 安全审计断点记录 — 2026-10-12

> **本文件是本轮审计的唯一断点登记**:阶段状态、覆盖台账、发现与修复全部记在这里,中断后据此续做。
> 对外交付的正式报告版见 [SECURITY-AUDIT-REPORT-2026-10-12.md](SECURITY-AUDIT-REPORT-2026-10-12.md)(修复后 `b250ad0`,CI 全绿)。

- **状态**:进行中(阶段:分波猎捕)
- **基线**:origin/main @ `b8d21f5`(mobile: wechat 手机端两处修复;同步自 `ab5c8f5`)
- **方法**:cloudflare/security-audit-skill 方法论裁剪版(侦察 → 覆盖台账 → 按攻击类别并行猎捕 → 独立验证 → 三态结论 confirmed/needs_validation/rejected → 修复 → 报告)。方法论原文本地克隆于 `C:\Users\Administrator\security-audit-skill`(SKILL.md / ATTACK-CLASSES.md 及 11 份专项攻击面文档)
- **纪律**:每个发现必须给出完整攻击链(不可信主体 → 入口 → 失效的控制 → 后果),说不出具体后果不定级;AGENTS.md 防线清单视为已知先验,猎捕只找防线缺口;动态验证只用本地 wrangler dev / npm test / smoke,禁止触碰生产端点

## 一、阶段台账

| 阶段 | 状态 | 备注 |
|---|---|---|
| 0 同步最新代码 | ✅ | `ab5c8f5 → b8d21f5`,fast-forward |
| 1 方法论就位 | ✅ | 本地克隆,关键文档已消化 |
| 2 侦察 | ✅ | 见「二、侦察摘要」 |
| 3 分波猎捕(7 hunter 并行) | ✅ | 结论见「三、Hunter 台账」 |
| 4 候选独立验证 | ✅ | V1/V2 双验证者(与猎手不同代理),medium 全部 confirmed,修复形状已核 |
| 5 修复确认项 | ✅ | 17 项修复落地,见「四·一」终态与「五」 |
| 6 回归 | ✅ | typecheck ✓;`npm test` 545/545 ✓;`npm run smoke` 189/189 ✓ |
| 7 报告定稿 + 提交 | ✅ | 本文件即审计报告,commit 推 origin |

## 二、侦察摘要

- **全局中间件序**(src/index.ts):demo 播种 → ensureSchema → 闭站 503 → `/api`(src/api.ts)与 `/mcp`(src/mcp.ts)→ 公开页(enGuard 包裹,英文版渲染抛错回退中文)→ RSS 别名 15 条 + `/feed.json` + `/sitemap.xml` → `/random` → `/go` 外链中间页 → `/post/:slug/unlock` 表单 → `/images/*`(白名单 `u/`、`og/`,nosniff)→ `/admin` 静态
- **cron**:每分钟定时发布扫描;`30 16 * * *`(北京 00:30)备份 + purgeVisits/purgeTrash/refreshFootStats;demo 优先(每 2h 清库重灌)
- **输入面**:公开 GET 页 14 个、unlock 表单 POST、三路公开评论(文章/留言板/微博)、会员端点 /api/member/*、后台 /api/admin/*、开放 API /api/external/*、TG webhook、MCP /mcp、广场 hub(独立 Worker plaza/,ingest + RSS pull + 管理端点)、上传(admin/og-image)、linkmeta/douban 工具端点
- **侦察备注**:`src/audit.ts`(媒体体检)未登记进 AGENTS.md 结构速查——补登记

## 三、Hunter 台账(覆盖台账)

| 代号 | 攻击类别 | 主查范围 | 结果摘要(完成后回填) |
|---|---|---|---|
| H1 | 访问控制/鉴权 | api.ts 全路由×鉴权序、auth.ts、mcp.ts、external.ts、closed.ts、member 端点 | ✅ 87 条路由鉴权序无漏、Origin 中间件全覆盖、clientIp=CF-Connecting-IP 不可伪造;2 low(见发现登记) |
| H2 | 注入(SQL/HTML/XML/路径) | 全部 prepare 调用点、渲染链(pages/render/themes/markdown/sanitize/rss/xml)、R2 key/zip 条目 | ✅ 全部 prepare/LIKE/渲染链逐点核对,**零 confirmed 注入**;3 条深度防御备注(B1-B3) |
| H3 | SSRF/出网 | 全部 fetch 调用点×fetchsafe、douban 中转、linkmeta/collect/transferImage、plaza RSS pull | ✅ 19 处 fetch 全归类,fetchsafe 实现无绕过;1 medium + 2 low(见 B4-B6) |
| H4 | 信息泄露/隐私 | 锁文/密码文全出口、会员隐私字段、password_hash/salt、SECRET_SETTINGS、错误信息 | ✅ 防泄漏清单逐出口核对;3 medium + 2 low(见 B7-B11) |
| H5 | 业务逻辑/滥用/资源 | 积分幂等/日上限、限流调用点、状态机(trash/scheduler/PUT has 清单)、体积/条数上限 | ✅ 限流调用点全清单核对、状态机/资源上限干净;2 medium + 5 low(见发现登记) |
| H6 | 客户端(site.js/后台 JS/CSRF) | site.js ES5 与 innerHTML 汇点、镜像漂移、admin JS 转义、插件市场信任边界、Cookie flags/Origin 校验覆盖 | ✅ site.js 2086 行全读、ES5 零违规、镜像零漂移、CSRF 三层纵深;2 low 加固位(见发现登记) |
| H7 | 配置/部署/供应链 | wrangler×2、备份表清单、demo WIPE_TABLES、docker-poc shim 一致性、凭据入库、plaza hub 配置 | ✅ BACKUP_TABLES 13/17 表逐核、WIPE_TABLES 全覆盖、凭据 grep 零命中、CI 无 secrets;3 low(C1-C3) |

> 注:首波 7 并发触发子代理并发上限,H2/H3/H4/H7 分两批重派。

## 四、发现登记(猎手原始结论,待独立验证)

- **A1 [medium|confirmed] 积分日上限 check-then-act 竞态**:points.ts:64-71 SUM 预查与 INSERT/UPDATE 不在同一事务,并发可突破每日 20 分上限刷 /rank
- **A2 [medium|confirmed] 会员经济零 Sybil 成本**:注册无验证(蜜罐+5/10m/IP)、会员评论限流只按账号不计 IP、默认即时上屏+即时计分——小号批量刷分刷评
- **A3 [medium|needs_validation] 公开写端点无入站体积预检**:api.ts:2002/2216/2168、index.ts:150 直接整读 body,超大请求可打爆 isolate
- **A4 [medium|needs_validation] /api/public/track 无鉴权 D1 写入面**:120 次/10min/IP,代理池可烧穿 D1 日写配额拖垮全站写
- **A5 [low|confirmed] membersEnabled 关闭后存量会员会话仍可评论计分**:api.ts:1997 getMemberUser 前无开关检查
- **A6 [low|needs_validation] 演示站出网抓取点未按口径短路**:api.ts /admin/tools/sanitize(rehostPasteImages)、/admin/links/fetch-icon|approve|refresh-icon、collect.ts /admin/collect/wechat
- **A7 [low|confirmed] 回收站恢复微博绕过置顶名额**:api.ts:1261 恢复不复核 pinned 名额(置顶端点有原子守卫)
- **A8 [low|confirmed] 后台过审给已封禁会员照常记分**:api.ts:1565 不查 members.status
- **A9 [low|confirmed] TG webhook 无 update_id 幂等**:external.ts:441 重投会重复发微博/重复转存
- **A10 [low|needs_validation] comment-webhook 插件裸 fetch**:hooks.ts:109 全仓唯一未接 fetchsafe 的配置型出网点
- **A11 [low|confirmed] 游客评论无内容/昵称维度聚合**:接近已备案取舍,列为权衡项
- **A12 [low|confirmed] editor.js 预览 window.open 缺 noopener**:editor.js:2215(app.js:1407 已带)
- **A13 [low|confirmed] /go 中间页无 frame-ancestors**:index.ts:24 纯加固位

第二波(H2/H3/H4/H7):
- **B1 [low|needs_validation] 卡片 href 生成时无 scheme 白名单**:linkmeta.ts:144、douban.ts:768 靠存库净化兜底,链路当前闭合——生成时前移校验(加固)
- **B2 [low|needs_validation] 导出 zip 条目名 slug 无二次校验**:export.ts:171,写库侧 cleanSlug 已保证,旁路写脏库才有影响(加固)
- **B3 [low|needs_validation] appearance.ts:253 THEME_APPEARANCE 查表未过 hasOwnProperty**:脏 theme='constructor' 时 TypeError→该页 500(可用性)
- **B4 [medium|needs_validation] douban/img 封面代理绕过 fetchsafe 纪律**:api.ts:1800-1812 redirect:'follow' 跟跳不再过白名单 + arrayBuffer 整读后才查 1MB(chunked 大响应可撑爆 isolate)
- **B5 [low|needs_validation] commentWebhookUrl/plazaEndpoint 落配置只查 scheme 前缀**:hooks.ts:110/302,无私网校验——docker-poc 多租户下租户管理员可盲打宿主内网;与豆瓣 relay 的 fetchableUrl 口径不一致
- **B6 [low|confirmed] plaza hub RSS pull 无私网校验、redirect 默认 follow、pull 路 link 放行 http**:plaza/src/index.ts:486-520、core.ts:255——push 路 https-only 口径被 pull 路漏进公开 feed
- **B7 [medium|confirmed] 已发布文章补设密码,残留自动摘要继续公开**:api.ts:680 `p.summary || (willLock ? '' : …)`,editor.js 恒回传 summary 使清空逻辑短路——正文前 80 字经 RSS/meta/列表继续泄漏,违背「密码文只出作者自填摘要」契约
- **B8 [medium|confirmed] 广场 pull 路不滤锁文**:plaza/src/index.ts:485-510 直接吃源站 RSS(标题+摘要+链接),push 路 `if (p.locked) return`(hooks.ts:279)的「加密文不上广场」契约被绕过
- **B9 [medium|confirmed] 广场条目生命周期缺口**:全仓无 `deleted` 广播发送方(validateIngest 支持、PLAZA.md 明言),PUT 加锁 api.ts:725、软删 api.ts:759 均不同步 hub;pull 只增不删——锁文/删文在广场无限期滞留
- **B10 [low|confirmed] commentWebhookUrl 未进 SECRET_SETTINGS**:api.ts:1583 五键之外,GET/PUT settings 明文回显(拿到即可向站长通知渠道伪造消息)
- **B11 [low|confirmed] demo 下 /api/admin/backup 与 /api/admin/export/* 无 isDemo 门控**:api.ts:1710、export.ts,违背 demo 敏感面短路口径
- **C1 [low|confirmed] demo 下 /api/admin/tools/sanitize 无门控无限频**:api.ts:1906(rehostPasteImages 抓任意 https 图落 demo R2);collect/links 抓图标同族(A6 佐证)
- **C2 [low|needs_validation] 生产 wrangler.jsonc 未显式 workers_dev:false**:xwblog.<account>.workers.dev 或为第二入口——需站长在 dashboard 核实后定性
- **C3 [low|confirmed] TG webhook secret 兼容旧绑定仍收 URL query 通道**:external.ts:449,secret 会进 Workers observability 日志面(header-only 口径的例外)

## 四·一、发现终态(验证后处置结果)

| ID | 终态 |
|---|---|
| A1 | ✅ 已修:points.ts 日上限守卫下沉 batch(条件 UPDATE + 超额条件 DELETE 谓词互斥,refId 定位),members.test 补「预查后并发抢占被批内摘除」用例 |
| A2 | ◐ 部分缓解:会员评论限流补 IP 桶 20/10min;根治(注册验证/Turnstile)属产品决策,见「六」 |
| A3 | ✅ 已修:api.ts 全局 Content-Length 预检(常规 2MB / 上传与外部微博 multipart 30MB,超限 413);chunked 无 CL 放行登记为残余风险 |
| A4 | ✅ 收口:track 限流 120→30 次/10min/IP;根治(打点聚合/抽样)见「六」 |
| A5 | ✅ 已修:publicComment 会员分支挂 membersEnabled 门控(关闭时按游客,与 pages.ts 同口径) |
| A6/C1 | ✅ 已修:demo 下 sanitize/collect/links 抓图标/backup/export 全部短路;sanitize 补限频 30/min;approve 照常走但跳过出网抓图 |
| A7 | ✅ 已修:恢复微博走置顶同名额条件更新(子查询在更新前取数),超额落 pinned=0 |
| A8 | ✅ 已修:过审计分前查 members.status='active',封禁会员不记分 |
| A9 | ✅ 已修:TG webhook 按 update_id 内存 5 分钟去重(窗口故意不盖「抛错后间隔重试」的恢复路,防静默丢消息) |
| A10 | ◐ 入口收敛:commentWebhookUrl/plazaEndpoint 落配置过 fetchableUrl;运行时 POST 裸 fetch 保留(fetchPublicResource 不支持 POST;CF 私网不可达,docker-poc 已被入口校验挡),登记接受 |
| A11 | ◐ 登记权衡:蜜罐+限流+先审后展开关在,聚合维度属产品取舍 |
| A12 | ✅ 已修:editor 预览 window.open 补 noopener |
| A13 | ✅ 已修:/go CSP 补 frame-ancestors 'none' |
| B1 | ✅ 已修:linkmeta/douban 卡 href+img 生成时 scheme 白名单(http(s)/站内相对,其余退化) |
| B2 | ✅ 已修:export zip 条目名过 zipEntrySlug(脏 slug 退回 post-<id> 命名) |
| B3 | ✅ 已修:THEME_APPEARANCE 两处查表过 hasOwnProperty('constructor' 不再 500) |
| B4 | ✅ 已修:fetchsafe 新增 opts.hostOk 每跳白名单钩子;douban/img 改走 fetchPublicResource(manual 逐跳复查五域 + 流式限长 1MB);Node 下 opaqueredirect 放弃属既有取舍 |
| B5 | ✅ 已修:同 A10 入口部分(设置 PUT 对两键过公网校验,非法 400) |
| B6 | ✅ 已修:plaza 注册与 pull 双重内网主机防线(.internal/.local/.localhost/IP 字面量);pull 只收 https link;redirect follow 保留(hub 跑 Node,manual 会 opaqueredirect 断流,平台取舍) |
| B7 | ✅ 已修:PUT 在 willLock 下与旧正文 excerpt 比对清空残留摘要(不限定本次新设,存量自愈;手填撞自动摘要误清方向更安全) |
| B8 | ✅ 已修:RSS 加 `<bloghao:locked>` 机器可读标志 + plaza parseRssItems 解析 + pull 跳过(非 https link 同跳) |
| B9 | ✅ 已修:hooks.ts 新增 firePlazaRetract(带 deleted 协议载荷,尊重插件停用开关与 demo 门控),api.ts 三路接线(PUT 补密/升档/转草稿、posts 软删、weibo 软删);PLAZA.md 已更新 |
| B10 | ✅ 已修:commentWebhookUrl 进 SECRET_SETTINGS(GET/PUT 双向打码) |
| B11 | ✅ 已修:并入 A6/C1 |
| C2 | ⬜ 待站长:dashboard 核实 workers.dev 开关;确认后可在 wrangler.jsonc 显式 workers_dev:false(下一发布) |
| C3 | ◐ 登记接受:TG webhook query secret 兼容旧绑定(observability 日志面;secret 可轮换);建议重绑后由站长移除兼容通道 |

## 四·二、修复登记(文件清单)

- **src/points.ts**:日上限批内条件守卫(②条件 UPDATE / ③条件 DELETE,refId 定位;adminAdjust 保留两语句分支)
- **src/api.ts**:入站体积预检中间件;B7 摘要清空;A5 会员门控;A2 IP 桶;A4 track 30/10min;A7 恢复名额;A8 active 校验;B10 SECRET_SETTINGS;B5 双 URL 落配置校验;demo 门控×5(backup/sanitize/fetch-icon/refresh-icon/approve 抓图跳过);douban/img 改走 fetchPublicResource;firePlazaRetract 三路接线
- **src/fetchsafe.ts**:fetchPublicResource 新增 opts.hostOk(每跳含起点复检)
- **src/external.ts**:TG webhook update_id 短窗幂等
- **src/index.ts**:/go CSP 补 frame-ancestors
- **src/appearance.ts**:THEME_APPEARANCE 两处 hasOwnProperty 守卫
- **src/export.ts**:zipEntrySlug 条目名防线
- **src/linkmeta.ts / src/douban.ts**:卡片 href/img 生成时 scheme 白名单
- **src/collect.ts**:demo 门控
- **src/rss.ts**:bloghao:locked 锁标志 + 命名空间
- **src/hooks.ts**:firePlazaRetract(deleted 广播)
- **plaza/src/core.ts**:parseRssItems 解析 locked
- **plaza/src/index.ts**:pullHostOk(注册+pull 双重)、pull 跳过锁文与非 https link
- **public/admin/editor.js**:预览 noopener
- **tests**:members.test(桩升级 + 批内守卫新用例)、rss.test(锁标志)、plaza-hub.test(locked 解析)、hooks.test(firePlazaRetract)
- **docs**:PLAZA.md(锁标志/下架同步/pull 口径)、本文件
- **回归**:typecheck ✓;npm test 545/545 ✓;npm run smoke 189/189 ✓(含文章密码链路、会员链路、回收站链路)

## 四、发现登记

> 格式:`ID | 严重度 | 终态 | 一句话 | 位置 | 修复`(验证后回填)

(待回填)

## 五、修复登记

见「四·二、修复登记(文件清单)」——全部改动与回归结果都在那里。

## 六、遗留与建议(未在本轮修复的事项)

1. ~~**A2 根治——注册环节人机验证**(CF Turnstile 或邮箱验证):注册零验证成本是会员经济 Sybil 的根,加验证属产品决策,待站长拍板;本轮已补的 IP 桶只是限流层缓解~~ → ✅ **2026-10-12 当日拍板并落地**(Turnstile 方案,src/turnstile.ts + /api/member/register 校验门 + site.js 懒挂载,防线见 AGENTS.md「会员体系」末条;默认关闭,站长在后台填入 Turnstile 两键即启用)
2. **A4 根治——track 打点聚合/批量写**:30/10min 限流已把烧穿量级压到可接受,但根治需要 visit_log 聚合写或抽样,涉及打点口径设计
3. **C2 workers.dev 收敛**:需站长在 CF dashboard 核实 `xwblog.<account>.workers.dev` 是否在用;确认不用后下一发布在 wrangler.jsonc 加 `workers_dev: false`
4. **C3 TG query secret 兼容通道**:现绑定若用 header 通道(2026-10 后一键设置即如此),可安全移除 query 兼容;动 external.ts:449 前先确认线上 webhook 绑定方式
5. **⚠ 广场 hub 重部署**:plaza/src 的改动(hub 侧锁文过滤/内网防线/parseRssItems)要**在站长服务器重建 demo/hub-node 容器**后才生效;未重建前旧 hub 忽略未知命名空间标签,pull 仍会收录锁文条目(源站侧的 retract 下架与 RSS 锁标志已即时生效)
6. **A11 游客评论聚合维度**(昵称/内容短窗去重):接近已备案取舍,列入下轮产品权衡
7. **覆盖度**:单轮审计约为多轮总覆盖的一半(方法论文档原话);本轮属「必要核心档」,建议季度复跑,并把本文件「四·一终态」作为先验输入(confirmed 根因不再猎捕,走复验)

## 七、复跑指引

- 本轮已完结(阶段台账 1-7 全 ✅);下次审计直接以「四·一终态」为先验:A 系/B 系 confirmed 根因从 hunter 排除,只做回归验证
- 方法论文档:`C:\Users\Administrator\security-audit-skill\skills\security-audit\`(SKILL.md 总纲、ATTACK-CLASSES.md 通用九类、WEB-PROTOCOL-AND-AUTH / CLIENT-SIDE / CLOUD-AND-DEPLOYMENT / DATA-ISOLATION-AND-LIFECYCLE / RESOURCE-EXHAUSTION-AND-AVAILABILITY / PROTOCOLS-RPC-AND-MESSAGING / SUPPLY-CHAIN-AND-RELEASE 为本轮适用专项)
- 经验:子代理并发上限约 3-4,hunter 分批派;先验防线(AGENTS.md)喂给侦察阶段可省大量重复猎捕;验证者按「试图推翻」口径独立复核 medium,修复形状让验证者一并给出可少一轮往返
