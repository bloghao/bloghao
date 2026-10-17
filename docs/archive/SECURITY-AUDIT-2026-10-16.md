# 增量安全复审（新面扫描）— 2026-10-16

> **范围**：以 `docs/archive/SECURITY-AUDIT-2026-10-12.md`（基线终态）与 `docs/archive/SECURITY-AUDIT-2026-10-15.md` 为先验，只扫描两轮之后**新增/改动的攻击面**，重点落在广场 2.0（B25）与「皮肤包（B8）/插件安装（B8）/出站 Webhook/服务端钩子」这批新模块。
> **基线**：`ad7e8f8`（v2.5.1），typecheck ✓ / npm test 701/701 ✓。
> **方法**：只读审计（逐条给 `文件:行` 证据与推理链，按 P 级分级）。**本轮落地了 4 个中危项（M1–M4）与 7 个低危项（L1–L7）的修复**（L1–L7 见 §四）。
> **纪律**：说不出具体后果不定级，宁报勿漏不编造。

## 一、范围与基线

本轮主查的**新攻击面**（2026-10-15 之后新增或大改）：

1. 广场 hub（`plaza/`，B25）：`/api/like`、`/api/beacon`、`/api/site-stats`、`daySaltedHash`、RSS pull 补漏
2. Node 运行器 `demo/hub-node/`（甲骨文 plaza-hub 容器）：`ipOf` 的 IP 信任边界
3. 皮肤包 / 自定义 CSS `src/skinpack.ts`（B8）
4. 编辑器插件远程安装 `src/pluginpkg.ts`（B8）
5. 服务端钩子总线 `src/hooks.ts`：广场同步 / Buffer / 评论 webhook / 通用出站 Webhook / 八个事件槽
6. 站长 SEO `src/seo.ts` 的新增位（本轮未被新面覆盖到的部分沿用上轮结论）

## 二、发现登记（终态）

> 格式：`ID | 严重度 | 状态 | 一句话 | 位置`。P0=可直接利用/数据面损坏，P1=需条件或纵深击穿/防线声明与实现不符，P2=加固位/低危。

| ID | 严重度 | 状态 | 一句话 | 位置 |
|---|---|---|---|---|
| M1 | P1 | **已修（2026-10-16）** | pull 补漏路裸 `fetch`（自动跟跳重定向）且 `pullHostOk` 判定弱——已注册站点 302 到内网地址即 SSRF（官方 hub 跑在甲骨文 Node 容器，内网可达） | plaza/src/index.ts `pullSiteRss`/`pullSiteWeibo`（修前 ~720/771）；修法见 §三 |
| M2 | P1 | **已修（2026-10-16）** | Node hub 把客户端可伪造的 `cf-connecting-ip` 原样透传，而 `ipOf` 优先读它——伪造 IP 重置按 IP 的点赞去重与限流（自托管 hub 生效） | plaza/src/index.ts `ipOf` + demo/hub-node/server.ts 头部复制循环 |
| M3 | P1 | **已修（2026-10-16）** | 广场公开端点（like/beacon/ingest）缺入站体积预检，`c.req.text()` 全量读体——chunked 超大体整读进内存放大 DoS（内核 api.ts 有这道闸，hub 没有） | plaza/src/index.ts `/api/like` `/api/beacon` `/api/ingest` |
| M4 | P1 | **已修（2026-10-16）** | `daySaltedHash` 的「盐」是公开的日期字符串——IPv4 空间可枚举，库泄露即还原原始 IP/vid，隐私声明与实现不符 | plaza/src/core.ts `daySaltedHash` |
| L1 | P2 | **已修（2026-10-16）** | `cleanCustomCss` 的关键字剥离是明文正则，CSS 转义序列可绕过（`@\69 mport`、`expr\65 ssion(`）；`@import "https://…"` 用字符串不走 `url()` 白名单 | src/skinpack.ts（修法见 §四） |
| L2 | P2 | **已修（2026-10-16）** | 出站 Webhook 的事件清单**失败开放**：清单留空=全部放行，但清单含坏项也返回 null（被当成全部放行）——配置写脏即「本应只发某事件」变成「全事件都发」 | src/hooks.ts（修法见 §四） |
| L3 | P2 | **已修（2026-10-16）** | `/api/beacon` 无需凭据、无天级去重，仅 20 次/分/IP——可对任意真实站点灌 views/clicks（单请求 ≤1000 计数，站点存在性校验拦不住伪造来源） | plaza/src/index.ts（修法见 §四） |
| L4 | P2 | **已修（2026-10-16）** | `/api/site-stats` 接受 `?token=`——长期站点 token 进 URL 会落入代理/访问日志与 Referer | plaza/src/index.ts（修法见 §四） |
| L5 | P2 | **已修（2026-10-16）** | `maskToken` 回显 token 前 8 + 后 4（48 bit），打码口径偏弱；建议只出后 4 或布尔「已设置」 | plaza/src/core.ts + plaza/src/index.ts（修法见 §四） |
| L6 | P2 | **已修（2026-10-16）** | `needsFontSrc` 读**未净化**的 `settings.customCss`——脏值（净化会拒）仍触发 CSP 放宽 `font-src https://data:` | src/skinpack.ts（修法见 §四） |
| L7 | P2 | **已修（2026-10-16）** | 三个新出网点用裸 `fetch`（自动跟跳重定向），未走项目自己的 `fetchPublicResource` 逐跳复查——与「出网安全」防线声明不符 | src/fetchsafe.ts + src/hooks.ts（修法见 §四） |

## 三、本轮修复（M1–M4）

### M1 · pull 补漏 SSRF（已修）

- 证据（修前）：`pullSiteRss` 用 `fetch(\`${site.site_url}/rss.xml\`)`（默认可跟跳），`pullHostOk` 只挡 `.internal/.local/.localhost` 与点分 IPv4 / 含 `:` 主机——**整数 / 十六进制 / 八进制 IPv4 写法可绕过**，`pullSiteWeibo` 更是**完全没调** `pullHostOk`。
- 攻击链：向 hub 注册一个自己控制的 https 站点（审核后拿到 token 或仅靠 pull）→ 该站 `/rss.xml` 返回 `302 Location: http://169.254.169.254/latest/meta-data/` → pull 跟随取回内网内容。Workers 形态私网不可达（无实际影响），但**官方 hub 部署在甲骨文 Node 容器**，内网可达，构成真实 SSRF。
- 修法：`core.ts` 新增导出纯函数 `pullHostOk`（公网主机判定，覆盖内网后缀 / IPv6 字面量 / 私有段 IPv4 含整数·十六进制·八进制·短写，与内核 `fetchsafe.isPrivateHost` 同口径；解析不动的可疑形态一律拒）；`index.ts` 新增 `fetchPullTarget`——`redirect:'manual'` 手动跟跳、**每跳重过 `pullHostOk`**、只跟 https 不降级、上限 5 跳；`pullSiteRss`/`pullSiteWeibo` 都改走它（后者顺带补上此前缺失的校验）。Node(undici) 下 manual 返回 opaqueredirect → 放弃该次抓取（与内核 fetchsafe 同取舍；pull 本就是补漏，丢失重定向站可接受）。
- 验证：`tests/plaza-hub.test.ts` 新增 `pullHostOk` 用例（公网放行 / 内网后缀拒 / 各写法私有 IPv4 拒 / IPv6 拒 / 非绝对地址拒）。

### M2 · Node hub 信任客户端 `cf-connecting-ip`（已修）

- 证据：`demo/hub-node/server.ts` 把 `req.headers` 全量复制进 `Headers`（含客户端自带的 `cf-connecting-ip`），`plaza/src/index.ts ipOf` 又**优先**读 `cf-connecting-ip`。
- 攻击链：直接对 Node hub 发请求、自带 `cf-connecting-ip: <随机>`（或经反代的 `/api/like`），即可让每次点赞都算作不同 IP，绕过「每 IP 每条 1 次/天」去重与限流桶。
- 修法：`server.ts` 新增 `applyTrustProxy`（与 docker-poc 同口径同默认 `proxy`/`cf`/`off`，布尔 `1`/`0` 简写）：默认档**先剥掉客户端自带的 `cf-connecting-ip` / `x-real-ip`**，再把可信来源（XFF 末跳 / socket 远端）写回 `cf-connecting-ip` 供 `ipOf` 读取；`Dockerfile` 显式声明 `TRUST_PROXY=proxy`。Workers 形态不变（CF 边缘强制写入）。
- 验证：起真实 hub-node 黑盒——「同 XFF 末跳、换 `cf-connecting-ip` → 判重复」「换 XFF 末跳 → 新点赞」，并直读 `likes.ip_hash` 与 `HMAC(secret, day:XFF末跳)` 比对一致。

### M3 · 入站体积预检缺失（已修）

- 证据：三个公开写入口直接 `await c.req.text()` 全量读体，无 Content-Length 闸（内核 `api.ts` 有此中间件，hub 没有）。
- 攻击链：无凭据的 `/api/like`、`/api/beacon` 发超大 body（chunked 无 CL 时平台闸也不看）→ 整读进内存放大 DoS。
- 修法：`index.ts` 新增全局中间件——非 GET/HEAD/OPTIONS 先看 `Content-Length`，超 512KB 直接 413；`readBodyLimited` 入参放宽到任意带 body 对象、新增 `readTextLimited` 流式限长，`/api/like`、`/api/beacon`、`/api/ingest` 三处改用（chunked 无 CL 也拦得住）。
- 验证：黑盒——带 CL 的 1MB 体 → 413；chunked 无 CL 的 1MB 体 → 流式限长 413；断流后 hub 仍存活；正常小请求不受影响。

### M4 · 天级哈希可枚举的公开盐（已修）

- 证据（修前）：`daySaltedHash(day, value)` = `sha256(\`${day}:${value}\`)`，`day` 是公开的北京日字符串——拿到 `likes` 表即可 IPv4 全空间枚举还原原始 IP / vid。
- 修法：`daySaltedHash(day, value, secret?)`，`secret` 非空走 `HMAC-SHA256`（私盐，库泄露不可枚举还原），空则退化 `sha256(day:value)` 兼容兜底；新增 `Env.PLAZA_HASH_SECRET`（Workers 用 `wrangler secret put`），**Node 形态未设时 hub-node 自动生成一枚并落盘 `<DB目录>/hash-secret`**（重启不变，落盘失败仅告警降级）——自托管默认即私盐。改盐只影响「当天」去重（一天内可能重复计 1 次），属可接受代价。
- 验证：测试新增「私盐走 HMAC / 同日稳定 / 跨日跨密钥不同 / 与无盐口径不同」；黑盒直读 `likes.ip_hash` 与 `HMAC(secret, day:XFF末跳)` 比对一致。

## 四、L1–L7 修复（本轮，2026-10-16）

> 均为 P2（加固位 / 低危），集中在主内核（`src/skinpack.ts`、`src/fetchsafe.ts`、`src/hooks.ts`）与广场 hub（`plaza/src/index.ts`、`plaza/src/core.ts`）。改前先跑 `npm test`；改后 typecheck ✓ / `npm test` 720/720 ✓ / `npm run smoke` 240/241（唯一失败项为**既有环境性**用例，见 §五）/ esbuild 打包 ✓。

- [x] **L1 皮肤包 CSS 转义绕过**（`src/skinpack.ts`）——修法：`cleanCustomCss` 在剥 `<` 之后、剥关键字之前**全剥反斜杠**（`s.replace(/\\/g, '')`）。反斜杠是 CSS 转义生效的唯一条件，剥净后转义写法退化成普通文本（`@\69 mport` → `@69 mport`，不再是可解析 at-rule），且**输出不含 `\`**（浏览器无从还原）；顺序不可颠倒（`@im\port` 剥完 == `@import`，仍要被关键字规则收掉）。`@import "https://…"`（字符串形态）由既有 `/@import\b/gi` 剥除覆盖。代价：内容里真用 `\XXXX` 转义的字符按字面输出（`content:"\201C"` 显示 201C，极少见）；剥除型仍幂等。
- [x] **L2 出站 Webhook 事件清单失败开放**（`src/hooks.ts`）——修法：`outboundEventList` 改三态返回 `'all' | 'invalid' | string[]`（留空=全部 / 合法=白名单 / 非空含坏项=`'invalid'`）；`outboundSend` 遇 `'invalid'` **拒发**（失败关闭），`configValidate` 保持 PUT 收口。
- [x] **L3 `/api/beacon` 无凭据无去重**（`plaza/src/index.ts`）——修法：保留「重放价值低」既定口径（不引凭据 / 额外表），**限流收紧到 10 次/分/IP** + `bumpSiteStats` 对单站单字段**单日增量封顶** `BEACON_DAY_CAP = 50000`（UPDATE 路 `MAX(旧值, MIN(旧值+n, 封顶))` 单调——存量已超封顶的日子不被下调）——把「无限灌」压成有界值（该数据只站长自己看得到，不进公开 feed 排序）。
- [x] **L4 `/api/site-stats` 接受 `?token=`**（`plaza/src/index.ts`）——修法：**只认 `X-Plaza-Token` 头**（与 ingest 同口径），去掉 query 兜底；长期令牌不进 URL / 代理日志 / Referer。消费方 `api.ts /admin/plaza-stats` 本就走头，无破坏。
- [x] **L5 `maskToken` 位宽偏弱**（`plaza/src/core.ts` + `plaza/src/index.ts`）——修法：抽为 core 纯函数 `maskPlazaToken`，**只露后 4 位**（`…abcd`，短 token 一律 `…`），不再回显前 8 位。
- [x] **L6 `needsFontSrc` 读未净化值**（`src/skinpack.ts`）——修法：判据改为 `!!cleanCustomCss(customCss)`——净化不过（脏值 / 超长 / 花括号不配平）时渲染端根本不出 `<style>`，就不该放宽 CSP。
- [x] **L7 出网点裸 `fetch`**（`src/fetchsafe.ts` + `src/hooks.ts`）——修法：`fetchPublicResource` 扩展 `method` / `body` / `expectBody`（向后兼容，现有调用零影响）；commentWebhook / plazaIngest / outboundSend 三处改走它——起点 + 每一跳重过 `fetchableUrl`，`expectBody:false` 表示「只发不收」（204 / 空体也算成功）。三处 URL 本就在配置时过 `fetchableUrl`，故不引入新的端口 / 形态限制。
- 验证：`tests/skinpack.test.ts`（转义面 + 脏值不放宽 CSP）、`tests/hooks.test.ts`（坏清单拒发）、`tests/fetchsafe.test.ts`（method/body 透传 + `expectBody:false`）、`tests/plaza-hub.test.ts`（`maskPlazaToken`）；L3/L4/L5 在 hub 运行时，靠 hub-node 黑盒 e2e 复核（部署提醒见 §五）。

### 本轮确认的既有强项（未改动）

- 插件安装走 `fetchPublicResource`；`pluginFileKey` 的 id 白名单把 R2 键穿越拦死；`/plugin-files/:id` 管理员会话门槛 + nosniff + no-store。
- `/images/*` 的 `u/`、`og/` 前缀白名单挡住了备份文件外泄。
- `likes` 主键（day, item_id, ip_hash）数据库级去重；`validateBeaconEvents` 唯一入口 + 站点存在性 IN 校验；`/api/beacon` 的 site_id 伪造已被拦（L3 是「灌真实站」的不同问题）。
- 后台会员/管理接口鉴权中间件顺序正确；新后台 UI 出参过 `esc`；`_headers` 与 docker-poc serveStatic 镜像一致。

## 五、结论

1. 新面（广场 2.0 / 皮肤包 / 插件安装 / 服务端钩子）整体质量高，但**广场 hub 是独立的第二攻击面**：它跑在 Node 上（内网可达）、代码出自不同模块，内核已有的三道闸（体积预检、SSRF 逐跳、IP 信任档位）它此前都缺——本轮 M1/M2/M3 正是把这三道闸补齐到 hub；M4 补齐隐私声明与实现的一致性。
2. 本轮 4 项 P1（M1–M4）+ 7 项 P2（L1–L7）全部落地并验证（typecheck ✓ / npm test 720/720 ✓ / esbuild 打包 ✓ / 本地 smoke 240/241）。L 批把「防线声明与实现不符」的残余（出网逐跳复查、事件清单失败开放、CSS 转义绕过、token 进 URL、隐私打码）逐条对齐到文档口径。
3. 本地 smoke 唯一失败项是**既有的环境性用例**「评论属地：开启后 SSR 出披露 + 属地标签（dev 样本 cf=美国）」——同环境 `微博 JSON 出 ip_region（内蒙古）` 通过，说明本机 wrangler 注入的 cf 样本是 `CN/内蒙古` 而非 `US`，该断言写死了「美国」；在干净树（stash 后）复跑结果相同，与本批改动无关。
4. 剩余 0 项 P0/P1，登记在册项已清零。
5. **部署提醒**：官方 hub 无 Workers Builds 自动上线，M1–M4 与 L3/L4/L5 需**重建甲骨文 `plaza-hub` 容器**（`demo/hub-node` 构建）方生效；`TRUST_PROXY` 需按「hub 前是否挂了 Cloudflare」在 `proxy`（默认，Caddy 反代直连）/ `cf` 之间选定（官方 hub 已取 `cf`）。
