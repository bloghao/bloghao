# B26 · 整站打包与还原（Site Bundle）— 设计提案（2026-10-16）

> **状态：设计提案，待站长批准后实施。**
> 范围经站长 2026-10-16 拍板：**A 档（一键导出整站包）+ B 档（一键导入，仅允许还原到空站）**；
> **不做覆盖、不做合并**。目的：给用户"随时能原样搬走、也能原样搬回"的确定性——换服务器 / 换域名 /
> 重新部署时，一条路把整站搬过去。
>
> 本文不含代码改动；批准后按 §五「实现清单」落地。

## 一、需求与定位

站长原话（2026-10-16）：

1. 给已有用户或新用户一个放心的感觉——随时可以把自己的文章导走，不爽就换。
2. 更换服务器、更换域名、重新部署，正好可以把旧站导出的包一键导入。
3. 不做覆盖、不做叠加——降低系统复杂度。
4. 文档上说清楚；未来更新版本时也提示版本兼容问题。

**定位澄清（两条路各管一件事，互不替代）：**

| 场景 | 现有能力 | 本方案 |
|---|---|---|
| 换去 WordPress / emlog / 别家博客系统 | Markdown 包 / WXR（已有，`/api/admin/export/*`） | — |
| 换到另一个 BlogHao、换机器、换域名 | **无** | **整站包（A+B）** |

Markdown/WXR 是"**带走文章**"（丢评论 / 会员 / 点赞 / 设置）；整站包是"**原样搬家**"（无损）。
所以 A+B 补的是那个更强的承诺：**我不但能走，还能原封不动地回来 / 搬走**。

## 二、现状盘点（代码证据）

**已有零件（可复用）：**

- `src/backup.ts` `runBackup()`：**全表 JSON → R2 `backups/`**，13 张表（`BACKUP_TABLES`），
  `TABLE_ROW_LIMIT = 100_000`，滚动保留 30 份（`KEEP_FILES`）。**只导出、无导入**。
- `src/export.ts` `exportRoutes`：Markdown 包 / WXR，**zip 流式打包**——`ZipWriter`（store 模式 +
  数据描述符），图片从 R2 边流边算 CRC，**整包不过内存**；含可复用纯函数
  `keyOf()` / `collectImageKeysFromHtml()` / `zipEntrySlug()`。
- `src/zip.ts`：流式 zip **写入器**（约 150 行，无读取器）。
- `src/index.ts` `/images/*` 路由：**只放行 `u/`、`og/` 前缀** → 包放 `bundles/` **不会被公开下载**。
- `docker-poc/shims/r2disk.ts`：R2 磁盘适配（`put` 只收 string/ArrayBuffer、`get` **忽略 `range`**）。
- 后台「设置 → 数据导出」区（`public/admin/app.js` ≈3468）已有两个导出按钮；上方「订阅与备份」区
  （≈3451）有「立即备份」按钮与状态行——新 UI 就挂在这个形态里。

**缺口：**

1. 没有"数据 + 图片 → 一个可导入文件"的打包；
2. 没有导入（解包 + 分批写入 + 空站守卫 + 版本校验）；
3. 没有 zip 读取器（`zip.ts` 只写不读）；
4. docker shim 不支持流式 `put` / `range` `get`（整站包必须流式读写，见 §4.5）。

## 三、语义边界（核心契约 —— 也是"降低复杂度"的落点）

**C1. 只还原到空站。**
目标实例的 `posts` / `weibo` / `pages` 三表**行数必须全为 0**，否则**明确拒绝**
（400 + 文案："本站已有内容，导入只允许还原到空站；请换一个全新实例，或先清空本站内容"）。
**永不覆盖、永不合并**——不处理 id / slug 冲突，不做字段级合并，不做部分更新。
这一条守住，功能就是"小文件级"的；守不住，就得处理冲突矩阵与部分失败回滚，是无底洞。

> **实现修正（2026-10-16，端到端实测发现，见 §十二.4）**：判定的"0 行"必须取
> **未删除**（`deleted_at IS NULL`）的行——全新装好的站**必然自带两条种子**（欢迎示例文章 +
> 「关于我」页面），按"一行都没有"判定会让"换服务器"的主用例**永远用不了**（新站刚装好就被自己拦下）。
> 现口径 = "没有未删除的内容"，报错会说明挡路的是几篇文章 / 几条微博 / 几个页面。

**C2. 包只装"内容"，不装"实例身份"。**

- ✅ 打包与还原（12 张表）：`posts` `pages` `comments` `categories` `post_categories` `weibo`
  `tags` `uploads` `friend_links` `members` `member_points_log` `settings`
- ❌ **排除 `users`**（管理员账号属于**实例**而非内容）：目标实例用它**自己**的登录，
  导入后照样进后台。若把包里的 `users` 灌进去，反而会被"包里那个早忘了的密码"锁在外面。
- ❌ 排除 `sessions` / `member_sessions`（临时凭证，本来就不备份）
- ❌ `settings` **按键排除**：
  - `SECRET_SETTINGS`（api.ts:1895）= `externalToken` / `telegramBotToken` / `telegramWebhookSecret` /
    `bufferAccessToken` / `plazaToken` / `commentWebhookUrl` / `turnstileSecret`
  - 实例态键：`siteUrl`（换域名后以新实例为准）/ `pageCacheEpoch` / `lastBackupAt` /
    `lastBackupKey` / `lastBackupBytes`
  - 理由：**密钥不进包** → 包不再是"带机密的文件"；换机器后密钥本就该重配。

**C3. 版本不匹配一律拒绝，不猜（照站长第 4 条）。**
包内 `manifest.json` 带 `format` / `appVersion` / `schemaHash`；导入判据：

- `format` 必须等于当前读取器支持的版本；
- **降版拒绝**：包里出现当前 schema 没有的表 / 列 → 明确报错（旧版不认识新列）；
- **升版允许**：包里缺当前新增的列 → 按目标默认值补。
  （这是主用例：旧站 2.5.1 导出 → 新机部署最新版导入。）
- 报错文案带两边版本号与具体差异，例：
  `这个包是 BlogHao 2.5.1 导出的，当前系统是 2.6.0；包内含有当前版本不认识的数据列（posts.new_col），无法导入。请把系统升级到与包相同或更高的版本。`

**C4. 导入的正文重新过净化。**
落库前 `posts.content` / `pages.content` 过 `sanitizeHtml`（**不带 `origin`**，保持原始外链，与存库口径一致），
URL 类字段过 `safeUrl`，异常值丢弃。理由：导入是"整站数据灌入"的口子，防"包被改过 / 来自别处"把 XSS 带进来。
`settings` 不清洗——渲染端本就有二次校验（`cleanCustomCss` 兜底、analytics 脏值静默当没配、`verifyMetas` 同），
无需在导入侧再维护一份清洗清单。

## 四、技术设计

### 4.1 包格式

```
xwblog-site-<YYYY-MM-DD>.zip          # 整站包（store 模式，可双击打开查看）
├── manifest.json                     # { format:1, app:'xwblog', appVersion, schemaHash, exportedAt,
│                                     #   tables:[{name, rows}], images:{count, bytes} }
├── tables/posts.json                 # 每表一个 JSON 数组（与 backup.ts 口径一致）
├── tables/comments.json
├── …（共 12 张表）
└── images/u/xxxx.png                 # 原始图片字节，key 与 R2 键一致（含 u/ og/ 前缀）
```

- **一表一文件**（不是一个大 JSON）：导入可**逐表处理**，内存有界（`comments` 表可能很大）。
- **图片独立条目**：直接 `IMAGES.put(key, stream)`；key 内容寻址（`saveUpload` 时间戳 + 随机数，
  **同键永不覆盖**）→ 导入**天然无冲突**。
- 边界：单包 ≤ 2GB / ≤ 65535 个条目（`zip.ts` 写入器已注明的既有上限），超限在 `start` 阶段明确拒绝。

### 4.2 导出（A 档）—— 直接流式下载

`GET /api/admin/bundle/export`（管理员鉴权）→ **直接流式吐 zip 给浏览器**
（`Content-Disposition: attachment`），**复用现有 Markdown 导出的整套模式**
（`ZipWriter` + R2 流式读 + 边流边算 CRC）。

**为什么不像备份那样先落 R2 再给链接**：导出是"用户要带走"，落 R2 需要流式 `put`（shim 要改）、
要下载代理端点、要体积与保留管理，收益只有"可重复下载"；直接流式与现有两个导出按钮**体验一致、代码最少**。
大站下载中断重来即可。

### 4.3 导入（B 档）—— 从存储读包，前端分步驱动

**为什么包必须先落到存储（R2）**：zip 的中央目录在**文件末尾**，读取需要**随机访问**；
而 HTTP 请求体是单向流，整包读进内存又会打爆 Worker（128MB）与平台请求体上限（CF ≈100MB）。
所以导入 = **先让包进存储，再按 Range 读**。

来源三条，都归一到"R2 里的一个 key"：

| 来源 | 谁用 | 怎么做 |
|---|---|---|
| **后台上传** | CF 小 / 中站（≤100MB） | 后台选文件 → `POST /api/admin/bundle/upload` **流式**写 R2 `bundles/`（`IMAGES.put(key, c.req.raw.body)`，不缓冲）→ 一键 |
| **已在 R2** | CF 大站 | `npx wrangler r2 object put xwblog-images/bundles/xxx.zip --file=xxx.zip`，再在后台从 `bundles/` 列表选 |
| **已在磁盘** | Docker | 把文件放进 uploads 目录（= R2 shim 根），后台从列表选 |

**分步导入（前端循环，每步一次小请求）** —— 这是"稳定性"的落点：单次请求都很小，可重试、有进度条、
超时风险可控。

```
POST /api/admin/bundle/import/start   { key }
   → 校验 manifest（format / 版本 / 降版拒绝）→ 校验空站（C1）→ 清空目标表 → 置状态 running
   → 返回 { units: ['posts','comments',…,'images'], total: { rows, images } }
POST /api/admin/bundle/import/step    { key, unit, cursor }
   → 导入一个单元（一张表的一批 ≤N 行 / 一批 ≤50 张图）→ 返回 { cursor | null }
POST /api/admin/bundle/import/finish  { key }
   → 收尾：invalidateSharedSettings(db) + purgePageCache + 状态 done + 删除包（可选）
```

- **清空在 `start` 阶段完成**（C1 已确认空站，清空无害），使 **重试 = 重来**，不会出现"灌一半"的烂摊子。
- **失败恢复**：settings 记账位 `bundleImport = { state:'idle'|'running'|'failed'|'done', key, at, error? }`；
  空站判定额外允许 `state==='failed'` 的残留（否则重试会被自己的半成品挡住）。
  约 10 行，换掉一个"半残站卡死"的坑。
- **分批口径**照 `demo.ts` 的既有教训：**单条 SQL 变量上限 100** → 多行 INSERT 每批行数
  = `floor(100 / 列数)`；D1 `batch()` 每批条数另设上限。
- 插入**带显式 id**（`post_categories.post_id`、`comments.post_id` 等外键完整性所必需；
  SQLite 的 `sqlite_sequence` 会自动跟到 max，后续新建不自撞）。

### 4.4 ZIP 读取器（零依赖，符合项目先例）

在 `src/zip.ts` 增一个读取器（与写入器同文件、同"零依赖手写"先例——`exif.ts` / `qrcode.ts` 同类）：

- 读**末尾 64KB** 找 EOCD → 解析**中央目录**（拿每个条目的 name / offset / size / method）。
  中央目录是唯一权威——写入器用数据描述符，本地头尺寸为 0。
- 逐条目 **Range 读**（`IMAGES.get(key, { range: { offset, length } })`）→ `method 0`（store）直接切片；
  `method 8`（用户用普通压缩工具重打包过）走 **`DecompressionStream('deflate-raw')`**
  （Workers 与 Node ≥18 都提供）。
- **内存有界**：任何时候只持有"一个条目"或"一个批次"。
- 不支持 zip64（>4GB），与写入器同边界；超限在 `start` 阶段明确拒绝。

### 4.5 平台适配（必须同步，否则 Docker 形态炸）

`docker-poc/shims/r2disk.ts` 现状：`put` 只收 string / ArrayBuffer，`get` 忽略 `range`。整站包**必须**：

1. `put(key, ReadableStream)` → 流式落盘（`pipeline`），不整包缓冲；
2. `get(key, { range })` → `fs.createReadStream(file, { start, end })`。

两处小改（约 40 行），**改完跑 `docker-poc/smoke.sh`**（AGENTS「改 Workers 专有 API 面必须同步 shim」）。

### 4.6 安全清单

- 四个端点（export / upload / import\*）**注册在 `api.use('/admin/*')` 鉴权之后**
  —— AGENTS 明令：hono 按注册顺序执行，注册在前 = 未登录可整表读。
- **限流**：导出 / 上传 / start 各 3 次/10 分钟/IP（重操作），用现成 `rateLimit(key, n, windowMs)`
  （参照 `backup:global`）。
- **演示站短路**：`isDemo()` → 404（与 `/api/admin/backup`、`/api/admin/export/*` 同口径）。
- **闭站**：`/api/admin` 在闭站白名单内 → 闭站时可导入（先导入再开站，符合直觉）。
- **包不公开**：`bundles/` 不在 `/images/*` 白名单内（已核实）；`bundles/` 也不进媒体体检
  （`isMediaKey` 只认 `u/` `og/`）。
- **体积预检**：`/api/admin/bundle/upload` **必须进 `UPLOAD_PATH_PREFIXES`**
  （否则按 2MB 预检 → 大包 413）；该路径单独设上限（100MB，平台上限），预检从"布尔"改成
  "路径 → 上限"映射。**曾因少写 `/api/` 前缀让三个端点一直按 2MB 预检**（api.ts 注释原文），别重蹈。
- **导入正文净化**：见 C4。
- **包含隐私**（评论邮箱 / IP 属地、会员数据）→ 后台下载 / 查看一律走鉴权端点 + `Cache-Control: no-store`。

### 4.7 后台入口

「设置 → 数据导出」区（`public/admin/app.js` ≈3468）**下方新增「整站搬家」小节**：

- **「导出整站包」按钮** → `/api/admin/bundle/export`（同现有两个导出按钮的形态）
- **「导入整站包」卡片**：上传框（≤100MB）+ 从 `bundles/` 列表选 + 「开始还原」（**二次确认**）
  + **进度条**（前端按 `step` 循环）+ 结果统计
- 文案照站长第 4 条：**"只允许还原到空站；不做覆盖、不做合并；包与系统版本不匹配会明确报错。"**
- 若独立成页，记得同时登记 `MENU` 与 `navigate()`（AGENTS 后台约定）。

## 五、实现清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/zip.ts` | + ZIP 读取器（EOCD / 中央目录 / Range / `DecompressionStream`），纯函数可 Node 导入 |
| `src/sitebundle.ts` | **新增自洽小文件**：`BUNDLE_TABLES`、manifest 构造 / 校验、`buildBundle`（流式写）、`importUnit`（分批写）、空站判定、版本比对、净化钩子 |
| `src/api.ts` | 挂 4 个端点（鉴权之后）+ 预检"路径 → 上限"改造 + 限流 |
| `src/export.ts` | 复用 `keyOf` / `collectImageKeysFromHtml` / `zipEntrySlug`（收图片 key） |
| `src/db.ts` | `bundleImport` 记账位（如新增 settings 键则进 `DEFAULT_SETTINGS`） |
| `public/admin/app.js` | 「整站搬家」小节 + 进度循环（+ `MENU`/`navigate` 登记，若独立成页） |
| `docker-poc/shims/r2disk.ts` | 流式 `put` + `range` `get` |
| `tests/sitebundle.test.ts` | **新增**：manifest 往返、版本判据（降版拒绝 / 升版补列）、空站守卫、zip 读取器（store + deflate 两种 method、往返逐字节）、分批行数口径、净化钩子 |
| `AGENTS.md` | 「结构速查」登记 `src/sitebundle.ts` + 「回归防线」新增一节 |
| `docs/GUIDE.md` §19 | 「升级、备份与数据导出」增补整站搬家用法 |
| `docs/DEPLOY.md` | 迁移路径增补"整站包"（与 `wrangler d1 export` 并列） |
| `docs/ROADMAP.md` | 登记 B26 |
| `scripts/smoke.sh` | 新增「整站包链路」：导出 200 + 空站导入通过 + 非空站拒绝 400 + 未登录 401 |

## 六、工作量估计

| 部分 | 量级 |
|---|---|
| `sitebundle.ts` + zip 读取器（核心） | 约 350–450 行 |
| api 端点 + 预检改造 + 限流 | 约 120 行 |
| shim | 约 40 行 |
| 后台 UI | 约 150 行 |
| 测试 | 约 250 行 |
| 文档 | 约 100 行 |

**总量约 1000 行上下**：一个自洽小文件 + 三处接线，符合"进内核的正确姿势是一个自洽小文件"。

## 七、被否掉的替代形态（备案）

| 方案 | 否决理由 |
|---|---|
| 直接 POST 整包（不经存储） | zip 需随机访问；整包进内存打爆 Worker；CF 请求体上限 ≈100MB |
| 覆盖 / 合并导入 | id / slug 冲突、字段版本差异、部分失败回滚 → 复杂度失控（站长明确否决） |
| 把 `users` 打进包 | 目标实例的登录会被旧密码覆盖 → 可能把自己锁在外面 |
| 密钥类 settings 进包 | 包变成"带机密的文件"；换域名 / 换机器后密钥本就该重配 |
| tar 容器（顺序可解析、免 Range） | 用户不熟、不能双击查看；zip 是既有格式与既有写入器 |
| 代码进包 | CF 与 Docker 用同一份 git 仓库，进包会造成"包内代码 ≠ 仓库代码" |
| 导出先落 R2 再给链接 | 收益仅"可重复下载"，代价是流式 put + 下载代理 + 体积管理 |
| 一次性导入（单请求全灌） | 大站在 Worker CPU / 时长上不可控；分步可重试、有进度 |

## 八、版本兼容策略（照站长第 4 条）

- 包内 `manifest.json` 的 `appVersion` 与 `schemaHash` 是"可读的版本说明"，**后台导入前先展示**。
- 判据：`format` 严格相等；**降版拒绝**、**升版补默认列**（§三 C3）。
- 报错文案见 C3 模板（带两边版本号与具体差异列）。
- 未来每次改 schema（加列 / 加表）时，`tests/sitebundle.test.ts` 的兼容用例跟着改——
  **这条要写进 AGENTS 防线节**。

## 九、验收标准

- `npm run typecheck` ✓ / `npm test` ✓（含新 `tests/sitebundle.test.ts`）/ `npm run smoke` 全绿
- `docker-poc/smoke.sh` ✓（shim 改动后必跑）
- 手工端到端：本地起 dev → 建内容（文章 + 微博 + 页面 + 评论 + 会员 + 图片）→ 导出包 →
  清库（或起新实例）→ 导入 → 逐页比对（首页 / 文章 / 微博 / 评论 / 图片 / 后台统计）
- 反例：非空站导入 → 400；版本不匹配 → 明确报错；未登录 → 401；演示站 → 404

## 十、遗留与风险（诚实登记）

1. **超大站导出 / 导入耗时**：CF Worker 单请求 CPU / 时长有限。分步导入已把导入侧切碎；
   **导出**仍是单请求流式（与现有 Markdown 导出同形）。若将来有超大站需求，再考虑"导出也分步 / 后台任务"。
2. **`bundles/` 会累积**：导入成功后自动删除该包；另设保留策略（如保留最近 3 份）。
3. **`ftsSeeded` 随 settings 导入可能不准** → `ensureSchema` 的空索引自愈探测兜底（已有机制）；
   且 FTS 触发器随 INSERT 自动建索引，无需额外动作。
4. **导入不做"图片去重"**：key 内容寻址天然不冲突，但重复导入同一包会产生重复图片条目
   （不会覆盖已有文件，只多占空间）。

## 十一、批准即开工

范围（A+B）、边界（只还原空站 / 不含 users / 不含密钥）、版本策略（降版拒绝、升版补列）、
格式（zip）、来源（上传或 R2）、后台入口（数据导出区下方）均已按 2026-10-16 拍板口径落定。

**站长点头 → 按 §五 实现清单落地；有任何一条想改，先改本文再动代码。**

---

## 十二、落地结果与实现期加固（2026-10-16，回填）

按 §五 清单全部落地。与提案的差异是四处**加固 / 修正**（都是实现期与端到端实测发现的缺口，已写进 AGENTS.md「整站包」防线节 + tests/sitebundle.test.ts）：

1. **`runBundleImportStep` / `finishBundleImport` 都必须校验会话**（`bundleImport.state==='running'` 且 key 对得上）。提案只写了「必须先 start」的流程，但没把它做成服务端硬约束——不校验时直接调 `step` 就能绕开空站守卫往有内容的站里灌。冒烟「无会话直接调 step 被拒」守着。
2. **`markBundleImportFailed` 只允许把 `running` 标成 `failed`**。因为空站判定对 `failed` 残留放行（「重试 = 重来」），若 `done` 能被一次杂散 `step` 调用翻成 `failed`，就等于给出「覆盖有内容站点」的口子。反过来 `failed` 残留是安全的：要到达 `failed` 必须先 `running`，而 `running` 只能从空站开始 —— 即存在 `failed` 残留时，站里那些行**全部是上次自己灌了一半的**。
3. **图片 key 收集改成 keyset 分页扫**（原提案写法是整表 `SELECT content`）。正文单篇上限 1MB，整表读进 isolate 会打爆 128MB 内存——「内存有界」是硬要求，改成与表导出同一套 `rowid > ?` 分页。
4. **C1 的判定口径修正为「没有未删除的内容」（`deleted_at IS NULL`）**——这是**端到端实测**才暴露的：全新装好的站必然自带两条种子（`/api/auth/setup` 的欢迎示例文章 + `ensureSchema` 的「关于我」页面），按提案字面的「三表行数全为 0」判定，**「换服务器」的主用例（新站导入）永远用不了**——新实例刚装好就被自己的守卫拦下。现口径 = 软删进回收站的不算内容，站长把两条种子删进回收站即可导入；报错文案也改成直接说明「挡路的是几篇文章 / 几条微博 / 几个页面」。**安全性不降级**：`start` 仍要求「没有活内容」，`failed` 残留的放行仍受 `markBundleImportFailed` 守卫（见第 2 条），且导入本身会清空全站（含回收站），不存在「回收站旧内容成为漏网损失」。
5. **`settings` 必须走 upsert（`ON CONFLICT(key) DO UPDATE SET value = excluded.value`）**——同样是**端到端实测**才暴露：`settings` 是唯一**不清空**的表（密钥 / 实例态键必须留住），而目标站自己已有的同名键（`siteName`/`theme`/`onboarding`/`pagesSeeded`…）会与包里的键撞 `UNIQUE(key)`，裸多行 INSERT 直接 500（单测当时没撞上，因为目标站夹具的键与包里的键恰好不重名）。语义仍是「包里的键覆盖目标站同名键、目标站独有的键（密钥 / 实例态）原样保留」。

另外两处**实现细节定型**（提案未细到这一层）：

- 包文件名固定 ASCII `xwblog-site-<北京日期>.zip`（无需 RFC 5987 编码），上传落 R2 的 key 追加 6 位随机后缀防同日覆盖。
- 单表触到 100,000 行上限时，先探一行确认「确实还有数据」才记入 `manifest.truncated`（刚好 10 万行不该误报）。

验证口径（全部本机跑过）：`npm run typecheck` ✓、`npm test` **740/740** ✓、`npm run smoke` **248/249**（唯一失败项是既有的环境性用例「评论属地 dev 样本 cf」——本机 wrangler 注入 `CN/内蒙古` 而断言写死「美国」，与本功能无关）✓、docker-poc 的 `r2disk` 新增面（流式 put + range get）用 Node 直测 9 项全过 ✓。

**docker-poc（Node/Docker 形态）端到端实跑**：本机无 Docker，但 docker-poc 就是「同一份代码跑在 Node 上」，于是用 esbuild 打出与镜像里完全相同的 `dist/server.js`，起两个非演示租户跑完整搬家链路——源站建管理员 → 传图 → 发带图文章 → 导出整站包 → 目标站建管理员 → **守卫先挡下新站自带的两条种子并报出「1 篇文章 / 1 个页面」** → 按提示删进回收站 → 上传包（**流式落盘**）→ `start` → 逐 `step` → `finish` → 校验文章 / 标签 / 图片（逐字节）都在、非空站二次导入被拒。**第 4、5 两条修正都是这一步发现的**——单测当时全绿，却漏掉了「新站自带种子」与「settings 同名键撞 UNIQUE」这两个只有真实首装链路才会遇到的场景（也顺带验证了 r2disk 的流式 put 与 Range get 在真实链路里可用）。`docker-poc/smoke.sh` 本身未跑（需要 Docker），待有 Docker 的机器补一次。

---

## 十三、后续补丁：「清空本站内容」（2026-10-16 同日，站长拍板）

**站长原话**：「那直接增加一个，重置（清空）本站，不就行了吗？这个功能就是把不管是新站还是老站，立刻恢复到一个空站，就可以导入了，对吧。」

**要解决的问题**：C1 的空站守卫是必要的（永不覆盖、永不合并），但配套的「准备动作」在真机上很别扭——老站要整体换新，得先手动把文章 / 微博 / 页面一条条删进回收站；新站也得先删两条种子。于是补一个「一键变空站」。

**设计（与 §三 三条契约不冲突，是守卫的配套而非豁免）**：

- **清的表 = `BUNDLE_CLEAR_TABLES`**（= `BUNDLE_TABLES` 去掉 `settings`，11 张业务表），**与 `startBundleImport` 共用同一份常量、同一个顺序**——两处永远不会漂移，清完必然通过空站守卫（这是「清空后一定能导入」的结构性保证，不靠约定）。清的是**硬删**，含回收站残留（`deleted_at IS NOT NULL` 的行也一并清掉）。
- **图片一并清**：删的对象 = `collectBundleImageKeys` 收集的集合（与**整站包会打包哪些图**同一份口径：媒体库 ∪ 正文 / 封面 / 微博引用）**减去**被保留表引用的图（`preservedImageKeys`：`users.avatar` 与 `settings` 里的图片地址——站点头像 / 管理员头像 / 页脚自定义 HTML / 自定义 CSS 的 `url()`；引用识别复用 audit.ts `collectReferencedKeys`，与媒体体检同一份口径）——等于「把这个包会带走、且清空后不会再被用到的图删掉」。**「留在 R2 让媒体体检清」这条路走不通**：体检的「未引用」列表是「`uploads` 全量 key − 库内引用」的差集，`uploads` 表清空后那些孤儿对象在后台**根本看不见**，只能自己敲 wrangler 删。顺序是硬要求：先收集图片 key（清表后就查不到）→ 清表 → **最后** best-effort 删 R2 对象，中途失败最坏只留孤儿（`imagesDone:false` 如实上报），绝不会出现「图没了、文章还在」的破站状态；收集 / 排除任何一步抛错则跳过图片清理、照常清站（宁少删不错删）。
- **保留**：`settings`（站点设置 / 密钥 / 实例态键）、`users`（管理员账号与登录态）、会话，以及 R2 里 `bundles/` 下**已上传的整站包**（不在图片 key 白名单内，不会误删要用来还原的包）。记账位 `bundleImport` 一并归 `idle`（清空后「上次失败 / 跑一半」的残留已无意义，顺带把在跑的导入会话作废）。
- **不可撤销 → 强确认**：服务端硬校验确认语 `resetConfirmOk`（`RESET_CONFIRM_PHRASE = '清空本站'`，`src/sitebundle.ts` 是唯一来源）；后台弹窗要求**原样输入这句话**才放行（输入框只是引导，绕过 UI 直接打接口同样过不去）。`isDemo` → 404、按 IP 3 次/10 分钟、端点注册在 `/admin/*` 鉴权之后。
- **后台位置**：「设置 → 数据导出 → 整站搬家」面板内、导入按钮下方（`btn-site-reset`，`btn-danger` 危险色）。`start` 的空站报错文案也改成引导这两条路（删种子 / 清空本站）。
- **为什么不做成「软删进回收站」**：三表（posts/weibo/pages）能软删，其余表（评论 / 分类 / 标签 / 友链 / 会员）没有 `deleted_at`——半软半硬反而让「空站」不彻底（分类页、标签页还会留在前台），与「立刻恢复到一个空站」的目标不符。代价用强确认 + 保留身份配置来对冲。

**验证**：`tests/sitebundle.test.ts` 新增 2 例（确认语判定；清空 → 内容表全空（含回收站残留）→ 设置 / 管理员账号留住 → 图片删净（**被保留表引用的头像不删**）且不误删要用的整站包 → 记账位归 idle → **导入不再被守卫拦**，新站的图随包回来）；冒烟「整站包链路」加 2 条（未登录 401 / 确认语错 400 且内容分毫未动）。冒烟**不执行真清空**——会毁掉本地开发库的内容，happy path 由单测覆盖。

**Node/docker-poc 形态真机全链路**（与镜像同一份 `dist/server.js` 做法 + 临时租户，39 项断言全绿）：建站 → 传图 → 发文（正文图 + 封面）→ 发微博（配图）→ 改站名 → 导出整站包 → **确认语错 400 且文章页 / 图片分毫未动** → 确认语对 200（`posts≥2`（含欢迎示例文章）/ `weibo=1` / `images=1` / `imagesDone=true`）→ 文章页 404、**图片 404（图床文件真的从盘上删了）**、微博流空、后台仍可访问（会话没掉）、站名仍是改过的值（设置保住）、记账位归 `idle`、**已上传的整站包没被误删** → 上传包 → `start` 过空站守卫 → 6 步全过 → `finish` → 文章 / 微博 / 页面 / 图片**逐字节**全部回来。这是「老站 → 一键清空 → 一键还原」这条主用例的完整证据（不再需要「手动把内容一条条删进回收站」）。
