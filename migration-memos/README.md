# Memos → xwblog 微博 数据迁移记录

> 本文档是迁移工作的**唯一事实来源**，任何接手的 AI/人都应先读这里。
> 每完成一步必须更新「执行状态」一节（包括失败与回滚）。

## 目标

把旧微博客 `https://wb.xiaowuleyi.com`（[usememos/memos](https://github.com/usememos/memos) 自托管实例）
的全部 PUBLIC memo 导入当前博客（xwblog）的「微博 / 随手记」功能。

- 旧站：Memos 新版（前端 rolldown 构建，gRPC-gateway REST API）
- 新站：本仓库，生产环境 Cloudflare Workers + D1（`xwblog-db`）+ R2（`xwblog-images`）
- 工作目录：`migration-memos/`（`data/` 已 gitignore，脚本与本文档进 git）

## 两侧数据结构（已核实）

### 旧站 Memos

| 项目 | 结论 |
|---|---|
| 列表 API | `GET https://wb.xiaowuleyi.com/api/v1/memos?pageSize=50`（未登录可读，仅返回 PUBLIC） |
| 分页 | 游标式：响应 `nextPageToken`（base64，如 `CDIQMg==`），循环取到空为止；**不支持** `state`/`orderBy` 查询参数（会返回 code 5 Not Found） |
| 附件下载 | `GET /file/attachments/{attachment.uid}/{filename}`（复数 attachments；单数/其他格式 404） |
| 附件字段 | `attachments[].name = "attachments/{uid}"`、`filename`、`type`(MIME)、`size`(字符串)、`memo` |
| 内容 | `content` 为 **Markdown 文本**；`tags` 为标签数组（Memos 风格 `#tag`，含层级如 `软件/apple/mac`）；`createTime`/`updateTime` 为 RFC3339 UTC |
| 可见性 | `visibility: PUBLIC`。未认证只能拉到 PUBLIC；如有 PRIVATE/ARCHIVED 需在旧站后台生成 Access Token 后加 `Authorization: Bearer <token>` 重跑 |

### 新站 xwblog 微博

| 项目 | 结论 |
|---|---|
| 表 | `weibo`（见 `schema.sql`）：`content`、`images`(JSON 数组)、`topics`(JSON 数组)、`status`(draft/published)、`pinned`、`likes`、`published_at`、`created_at`、`updated_at` |
| 时间戳 | **毫秒**（`Date.now()`） |
| 正文渲染 | `src/render.ts` 的 `weiboTextHtml()`：**纯文本 esc 转义 + 话题高亮**，**不支持 Markdown** → 导入前必须把 Markdown 转纯文本 |
| 话题提取 | `src/utils.ts` `extractWeiboTopics()`：正则兼容 `#话题`（单井号，句读即停）与 `#话题#`（成对）两种写法，Memos 标签可直接保留 |
| 图片存储 | R2 key `u/{YYYYMM}/{base36时间戳}{随机}.{ext}`，URL 为 `/images/{key}`，同时登记 `uploads` 表（`src/api.ts` `/api/admin/upload`） |
| 图片限制 | 仅 JPG/PNG/WebP/GIF 图片与 MP4/WebM 视频，单文件 ≤25MB（`IMAGE_MIMES`/`VIDEO_MIMES`） |
| 置顶 | `pinned` 最多 3 条（应用层限制），导入一律 0 |

## 关键环境事实

- wrangler 已登录（OAuth，邮箱 0471666@gmail.com），权限有 **d1 (write)**、workers 等，
  **没有 r2 scope** → 不能用 `wrangler r2 object put` 上传图片。
  图片入 R2 需要以下之一：① 博客管理员密码走 `/api/admin/upload`（session cookie 认证）；
  ② 用户提供带 R2 写权限的 Cloudflare API Token（`CLOUDFLARE_API_TOKEN` + `wrangler r2 object put`）。
- node 在 `/usr/local/bin/node`；npm/npx 不在 PATH，pnpm/wrangler 在 `/usr/local/bin`。
- D1：`xwblog-db`（database_id `0e71821c-7eac-4713-8ba3-21af7cca0631`），远程执行：
  `wrangler d1 execute xwblog-db --remote --file=xxx.sql`

## 方案（两阶段）

1. **阶段一（文字为主，本次完成）**：导出全量 memo → Markdown 转纯文本 →
   图片先以**旧站外链**（`https://wb.xiaowuleyi.com/file/attachments/...`）写入 `images` 字段 →
   生成 SQL → `wrangler d1 execute --remote` 导入。文字与时间线立即可用。
2. **阶段二（图片落 R2，待凭证）**：附件已全部下载到 `migration-memos/data/files/`，
   拿到上传凭证后批量上传 R2（沿用 `u/{YYYYMM}/…` key 规则并登记 `uploads` 表），
   再执行一条 UPDATE 把 `images` 里的外链替换为 `/images/u/...`。

## 转换规则（Markdown → 微博纯文本）

- 行内代码/加粗/斜体等修饰符去掉，保留文字；链接 `[text](url)` → `text (url)`
- `![alt](url)` 图片语法：若指向本站附件则提取进 `images` 数组，正文中移除
- 代码块保留原样（缩进呈现）；`#标签` 原样保留（新站话题正则兼容）
- 待办 `- [ ]`/`- [x]` → `☐ `/`☑ `；标题 `#`、引用 `>` 去符号保留文字
- 时间：RFC3339 → 毫秒时间戳；`published_at = created_at`，`status='published'`，`pinned=0`，`likes=0`
- `topics` 字段按新站 `extractWeiboTopics` 同款正则预计算写入

## 脚本

| 脚本 | 作用 | 状态 |
|---|---|---|
| `export.mjs` | 全量拉取 memos → `data/memos.json` | ✅ 已执行（285 条） |
| `download.mjs` | 附件下载 → `data/files/{uid}/{filename}`，字节数校验 | ✅ 已执行（108/108） |
| `transform.mjs` | 脱敏+转换 → `weibo_import.json` / `import_weibo.sql` / `image_manifest.json` | ✅ 已执行 |
| `upload-images.mjs` | 阶段二：图片上传 R2/admin + 生成 `replace_urls.sql` | 📝 已写好，待凭证执行 |

## 执行状态（追加式日志，倒序）

- 2026-10-04 **收尾 ✅**。站主确认后清理：本地 `data/` 工件（63MB：memos.json 原始导出、
  files/ 附件备份、生成的 SQL/清单）已删除——附件均已落 R2 并线上验证、原始导出可随时用
  `export.mjs` 从旧站重拉（旧站当前仍在线）。脚本与本文档已按下方交接事项以 `docs:` 提交进 git。

- 2026-10-04 **阶段二完成 ✅ 迁移全部结束**。图片已全部落到 R2（xwblog-images），新站不再依赖旧站：
  - 站主提供了后台密码（用户 `wu`），走 `/api/admin/upload` 上传：**107 张图 + 1 个视频全部成功，0 失败**
    （登录端点为 `/api/auth/login`；脚本加了 1.1s/张限速，避开后台 60 次/分钟的限流；mapping 持久化在
    `data/upload_mapping.json`，重跑安全）。
  - 执行 `data/replace_urls.sql`（107 组 images/content 替换 + 视频正文链接 1 处）。
  - **id 64** 的旧站分享链接（`/memos/HGj2dvW6UpGyHgv8XBmG53`）替换为站内锚 `/weibo#wb-58`（该 memo 即现在的 id 58）。
  - **id 12** 正文中「博客：blog.xiaowuleyi.com / 微博：wb.xiaowuleyi.com」为历史叙述性文本，**有意保留**未替换。
  - 验证：`weibo` 表 images/content 中旧站附件 URL 残留 **0**；线上 /weibo 页旧站图片引用 0 处、
    新图床引用 19 处；抽验配图（png 736KB）与视频（mp4 3.4MB）均 200；uploads 表新增 108 条记录
    （另有站主自己上传的少数文件，如 favicon ico，与迁移无关）。
  - 安全处理：登录 session 临时文件已删除；密码曾出现在对话中，建议站主如在意可在后台修改密码。
- 2026-10-04 **阶段一完成 ✅**。285 条已全部导入并在线上可见。细节：
  - 远程导入结果：weibo 表 287 条（原 2 + 导入 285），id 3~287，时间跨度 2025-07-30 ~ 2026-10-01，
    images JSON 总计 108（原 1 + 导入 107）。`changes: 286` 中的 1 是 sqlite_sequence 计数，非多余数据行。
  - **部署**：线上 Worker 原本是微博功能之前的旧版本（/weibo 302 回首页），已重新部署
    （git stash 未提交的友链开发 → deploy 已提交的 main `bc83894` → stash pop 恢复，
    部署前 typecheck 通过，Version `7d950859`）。
  - **重要发现：域名分裂**。`blog.xiaowuleyi.com`（标题「小吴乐意Blog」）绑定的是**另一个旧博客部署**（无微博功能），
    不是本仓库的 xwblog；xwblog 目前访问地址为 **https://xwblog.0471666.workers.dev**（标题「小吴乐意」），
    微博页 https://xwblog.0471666.workers.dev/weibo 已验证：卡片/话题条/翻页/置顶/图片全部正常。
    wrangler.jsonc 未配置自定义域路由；是否把 xiaowuleyi.com 切到 xwblog 由站主决定（旧 Worker 名单因 token 权限未能列出）。
  - 图片现阶段为旧站外链（已验证 200 可访问）。**旧站下线前务必完成阶段二**。
- 2026-10-04 阶段二脚本就绪：`upload-images.mjs`（未执行，等凭证）。两种模式：
  - `CLOUDFLARE_API_TOKEN=<带R2写权限的token> node upload-images.mjs`（直传 R2）
  - `node upload-images.mjs --blog https://xwblog.0471666.workers.dev --user <用户名> --pass <密码>`（走 /api/admin/upload）
  - 执行后自动生成 `data/replace_urls.sql`（uploads 表登记 + images/content 旧链替换），
    再 `wrangler d1 execute xwblog-db --remote --file=migration-memos/data/replace_urls.sql` 完成替换。
  - 图片文件本地完整备份在 `data/files/`（62MB），即使旧站消失也能完成阶段二。
- 2026-10-04 验证/回滚备忘：
  - 验证 SQL：`SELECT COUNT(*), SUM(json_array_length(images)) FROM weibo;`（应为 287 / 108，替换 URL 后 images 里不应再有 `wb.xiaowuleyi.com`）
  - 回滚本次导入：`DELETE FROM weibo WHERE id > 2;`（阶段一基线 max_id=2；若已发评论/点赞需一并处理 comments）
- 2026-10-04 远程导入执行：`wrangler d1 execute xwblog-db --remote --file=migration-memos/data/import_weibo.sql`（成功）。
- 2026-10-04 视频附件处理：唯一 1 个 mp4（`memos/nN5o23k9AfATMGoAjvD9Gj`，3.4MB）不进 images 字段（微博图网格只支持 `<img>`），正文追加「▶ 视频：<旧站外链>」，阶段二会一并替换为新地址。
- 2026-10-04 SQL 预验证：本地 wrangler D1 因旧版本地 state 报内部表 `_cf_ALARM` 错误（与 SQL 无关，未动本地开发数据），改用系统 `sqlite3` + `schema.sql` 建库验证：285 条全部插入成功，时间戳（毫秒）与 images JSON 正确。
- 2026-10-04 转换完成：`transform.mjs` 产出 `weibo_import.json`（285 条，103 条带图共 107 图，31 个话题）、`import_weibo.sql`（127KB）、`image_manifest.json`（阶段二上传清单）。层级标签（如 `#比特币/认知`）按原样保留——新站话题正则天然兼容，如需扁平化可在后台手动改。
- 2026-10-04 **敏感信息处理**（transform.mjs 脱敏 9 处）：
  - 8 处正文图片引用指向 `api.telegram.org/file/bot…/photos/…`，**带 bot token 且已验证 404 失效** → 移除引用，正文补「（原 Telegram 配图已失效）」；
  - 1 处明文「临时访问密码：xiaowuleyi」（第三方网站 btcmove.btchao.com 的临时密码）→ 改为「密码：已隐藏」；
  - 扫描了 bot token / password / bearer / 十六进制串 / 私钥 / 手机号 / 邮箱等模式，除上述外无其他命中。
- 2026-10-04 附件下载完成：`download.mjs` 下载 **108/108**（62MB，png 78 / jpeg 29 / mp4 1），存 `data/files/{uid}/{filename}`，字节数与 API size 全部校验一致。
- 2026-10-04 导出完成：`export.mjs` 拉取 **285 条**（2025-07-30 ~ 2026-10-01，全部 PUBLIC/NORMAL），存 `data/memos.json`。
- 2026-10-04 导入前基线：线上 `weibo` 表现有 **2 条**（max_id=2）。回滚方法：`DELETE FROM weibo WHERE id > 2;`
- 2026-10-04 完成双侧调研：确认旧站为 Memos、API/附件 URL 格式、新站 weibo 表与渲染逻辑；建立本工作区。

## 未尽事项（接手清单）

1. ~~阶段二图片落 R2~~ ✅ 已完成（2026-10-04，107 图 + 1 视频全部落 R2 并替换 URL）。
2. ~~域名决策：blog.xiaowuleyi.com 当前指向旧博客，是否切到 xwblog 由站主定~~ ✅ 已完成（2026-10-04：
   站主已把 `blog.xiaowuleyi.com` 绑定到本仓库的 xwblog Worker，该域名即 xwblog 正式访问地址；
   说明文档 README/GUIDE/DEPLOY 已同步以此为站点地址）。
3. （可选）Memos 层级标签扁平化（如 `#比特币/认知` → `#认知`），现按原样保留。
4. （可选）如果旧站有 PRIVATE/ARCHIVED memo：未认证导出只含 PUBLIC。如需全量，去旧站设置生成 Access Token，
   加 `Authorization: Bearer <token>` 头重跑 `export.mjs`（注意：私密内容是否公开导入需站主确认）。
5. （可选）建议站主修改后台密码（密码曾出现在迁移对话中）。
6. ~~迁移工件（migration-memos/，data/ 已 gitignore）尚未 git 提交~~ ✅ 已提交（2026-10-04，
   `docs:` 风格；`data/` 本地工件已清理，重跑脚本会自行重建）。
