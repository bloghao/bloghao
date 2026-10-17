# AI 协作约定（一个人 + 多个 AI 开发 xwblog）

> **这份文档是给「干活的 AI」看的操作手册**，不是给访客看的介绍，也不进官网文档站。
> **用法**：每开一个新会话 / 换一个模型，把**根目录 `AGENTS.md`（全文）+ 这一页**先发给它。
> **定位**：`AGENTS.md` 是项目的**宪法**（写死了每条防线与红线），这一页是**协作手册**（写死了开工、干活、收工的标准动作）。

## 0. 一句话总纲

**先读 AGENTS.md，再动手；改完跑测试、贴原始输出；收工更新 AGENTS.md 并留残留项。**

---

## 1. 开工前（三件事，缺一不可）

1. **读文档**：`AGENTS.md` 全文（它是唯一真相源）+ 与本任务相关的 `docs/*`（改广场读 `docs/PLAZA.md`，改主题读 `docs/THEMES.md`，改插件读 `docs/PLUGINS.md`）。
2. **跑基线**：
   ```bash
   npm run typecheck
   npm test
   ```
   确认「**现在是绿的**」。若一开始就红，**先停下来查清**是不是环境问题，别在红基线上叠改动。
3. **说清范围**：用 3–5 句话说明「这次要改什么、**不碰什么**、怎么验证」，等确认后再动手。

> 为什么这么严：这个仓库**推送即上线**（见 §2 第 1 条），没有缓冲带。

---

## 2. 干活时的 8 条红线（本项目专属）

### 红线 1 · 推送即上线，测试是唯一的刹车
`git push origin main` → Cloudflare **Workers Builds** 自动构建部署主站 `blog.xiaowuleyi.com`。
**CI 报红不会拦下部署**（CI 与部署是两个并行工作流）。所以「`typecheck` + `test` 全绿」是推送的**前置条件**，不能省。
- 不推 `upstream`（官方仓冻结，只有站长明确说「发布」才走 `docs/RELEASING.md`）。
- 提交信息用中文前缀：`fix:` / `feat:` / `docs:` / `theme:` / `security:` …

### 红线 2 · 新功能先想「归宿三档」，默认不进内核
顺序：**① 客户端能做（前台 `site.js` / 后台原生 JS）→ ② 插件形态（`src/hooks.ts` 总线 / `public/plugins/`）→ ③ 确需进内核才新增文件**。
- 运行时依赖只有 `hono` 一个，**别加 npm 包**（`exif.ts` / `zip.ts` / `qrcode.ts` 都是零依赖手写先例）。
- **禁止为开发便利引入打包步骤**；前台 `site.js` 保持 ES5。这是产品定位，不是技术债。

### 红线 3 · 新「公开面」必过防泄漏清单
站里有**会员付费墙**（`min_tier`）、**文章访问密码**（`password_hash`）、**锁文**。
新增 RSS / 接口 / 导出 / 主题字段 / JSON-LD 时，必须逐条问：**锁着的内容会不会从这里漏出去？**
- 已有口径：`utils.ts teaserHtml`（服务端截断）、`points.ts canRead`、`rss.ts`（锁文只出试读段）。
- 已登记漏点最常出现在：摘要、`content:encoded`、JSON-LD 描述、OG 卡图。

### 红线 4 · 查 posts / weibo / pages 三张表，必带 `deleted_at IS NULL`
三张表是**软删除（回收站）**。漏一个条件 = 回收站内容从那个页面漏出来。
改完自查：
```bash
grep -n "FROM posts\|FROM weibo\|FROM pages" src/
```
（已知**故意不过滤**的例外：`backup.ts`、`trash.ts` 自身、`getPostById/getPageById`、`uniqueSlugIn`——见 AGENTS.md。）

### 红线 5 · 时间一律北京时间口径
禁止 `new Date(ts).getHours()`（Worker 是 UTC，凌晨 0–8 点发布的内容会显示成前一天）与裸 `toISOString()`。
- 显示用 `utils.ts` 的 `cstDate` / `fmtDate` / `fmtDateCN` / `fmtDateTime`；
- 机器可读（JSON-LD）用 `isoDate`；
- SQL 按天/年聚合用 `strftime(..., ts/1000 + 28800, 'unixepoch')`；
- 客户端 `site.js` 同口径（+8h + `getUTC*`）。

### 红线 6 · 密钥 / 令牌不进日志、不进 URL、不进接口出参
- settings 的敏感键进 `SECRET_SETTINGS`，**GET 与 PUT 都打码**，明文只在生成时返回一次；
- 后台文章出参一律过 `api.ts postAdminView`（`password_hash` 永不出参，只给 `hasPassword`）；
- 长期令牌**只认请求头**，别塞 query（会落进代理 / 访问日志 / Referer）。

### 红线 7 · 改 schema / 加 src 文件，必须「两处同步 + 登记」
- **加列 / 加表**：`schema.sql` 与 `db.ts` 的 `SCHEMA_COLUMNS` / `SCHEMA_TABLES` **两处同步**，且 `SCHEMA_TABLES` 的建表语句要**自带本表全部列**（冷启动靠它）。
- **加 `src/` 文件**：必须在 `AGENTS.md` 文末「结构速查」登记一行；新增表 / settings 键同理要有明确理由。

### 红线 8 · 写了 settings，就要失效缓存
settings 有 colo 级共享快照层。一切**写 settings 的路径**，写完必须 `await invalidateSharedSettings(db)`（`saveSettings` 已内置；散在 `db.ts` 之外的裸写点各自负责）。
忘了 = 改完设置最多 60 秒读旧值。

---

## 3. 收工前（四件事）

1. **全绿并贴原始输出**：`npm run typecheck` + `npm test`（涉及 SQL 拼接 / 渲染 / 路由时再跑 `npm run smoke`）。
2. **更新 `AGENTS.md`**：新增的文件 / 表 / settings 键 / 防线，逐条登记。**不更新 = 下一个模型不知道 = 迟早重复劳动或踩坏。**
3. **写「残留项」**：没做完的、有疑问的、需要站长拍板的、已知的取舍——像 `docs/SECURITY-AUDIT-*.md` 那样留档。
4. **单独 git 提交**（一个模型一块改动一个提交，方便出问题 `git revert` 单条回退）。

---

## 4. 多模型并行的分工原则

- **按「文件 / 模块」切分，不按「功能」切分**——两个功能碰同一文件照样冲突。
- **一次只让一个模型改同一批文件**；要并行，就分到互不相交的文件上。
- **每个模型收工必须留下 `AGENTS.md` 更新 + 残留项**，这是给下一个模型的交接单。
- **用 git 提交做检查点**：模型 A 提交完，模型 B 再从新起点开工。
- **只信证据**：测试输出、实测响应码，别信「看起来对 / 应该没问题」。

---

## 5. 直接复制的话术模板

**① 开工（每次新会话先发这段）**
```
请先读根目录 AGENTS.md（全文）和 docs/AI-COLLAB.md，然后：
1) 跑 npm run typecheck 与 npm test，把原始输出贴出来（确认基线是绿的）；
2) 用 3-5 句话说明你这次要改什么、不碰什么、怎么验证；
3) 等我确认后再动手。
```

**② 验收（改完后要这段）**
```
改完了请给我：
1) 改了哪些文件、每处为什么这么改；
2) npm run typecheck 与 npm test 的原始输出（必须全绿）；
3) 这次有没有新增「公开面 / 数据库列 / settings 键 / src 文件」？有的话说明你在 AGENTS.md 哪里登记了；
4) 还没做、或有疑问的地方（残留项）。
```

**③ 交接（收工前要这段）**
```
收工前请写一段「交接说明」：这次改动的摘要、未完成项、下一个会话需要知道的坑。
我会存下来发给下一个模型。
```

---

## 6. 最容易翻车的 12 个场景（速查表）

| 你可能想做 | 别这么做 | 正确做法 |
|---|---|---|
| 加一个设置项 | 直接裸写 `settings` | 走 `saveSettings`，或写完补 `await invalidateSharedSettings(db)` |
| 加一个数据库列 | 只改 `schema.sql` | 同时改 `db.ts` 的 `SCHEMA_COLUMNS`（且 `SCHEMA_TABLES` 建表语句自带该列） |
| 加一个后台页面 | 只写模板 | 同时登记 `MENU`、`navigate()`、`MOBILE_TAB_IDS` |
| 加一个前台导航项 | 只测默认配置 | 四种站点模式（`siteMode`）+ 会员开/关都过一遍，390px 验证 |
| 服务器要抓一个外部网址 | 直接 `fetch()` | 走 `fetchPublicResource`（逐跳复查，防 302 到内网） |
| 加一个动态 `<input type="file">` | 直接创建节点 | 走 `pickFiles` 助手（否则 iOS Safari 选完图不回填） |
| 改前台 `site.js` | 用箭头函数 / 模板字符串 / 裸 `localStorage` | 保持 ES5、禁 lookbehind；存储走 `storeGet/storeSet` |
| 改列表排序 | 只改 SQL | 排序表达式要对齐部分索引（`schema.sql` + `db.ts SCHEMA_INDEXES` 两处同步） |
| 删一条记录 | 直接 `DELETE` 行 | 三表是软删（回收站）；彻底删除只走 `/admin/trash/*` |
| 加一种评论/留言形态 | 抄一整段流程 | 复用 `api.ts` 的 `publicComment` 公共核心，只写细路由 + opts |
| 新增对外出口（RSS/接口/导出） | 直接输出全部字段 | 过防泄漏清单（付费墙 / 密码文 / 锁文），摘要截断、锁文只出试读 |
| 改主题 / 编辑器样式 | 只改一侧 | `.ed-editor`（编辑器）与 `.rich`（文章页）要**镜像同改** |

---

## 7. 这份文档怎么维护

站长（人）在每次发现「AI 又踩了同一个坑」时，往 §6 速查表加一行即可。
**它越用越值钱**——每一条都是真金白银踩出来的。
