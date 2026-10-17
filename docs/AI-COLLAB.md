# 开发手册（一个人 + 多个 AI 协作 xwblog）

> **这份文档是给「干活的 AI」看的唯一入口手册**，不进官网文档站。
> **用法**：每开一个新会话 / 换一个模型，把根目录 `AGENTS.md`（宪法，全文）+ **这一页**先发给它，然后就可以开工——不用再读别的「必读文档」，需要哪份按 §1 的地图按任务取用。

## 0. 一句话总纲

**先读 AGENTS.md 再动手；改完跑测试贴原始输出；收工更新 AGENTS.md 并留残留项。**

---

## 1. 文档地图（哪份文档管什么）

| 任务场景 | 读哪份 | 说明 |
| --- | --- | --- |
| 任何改动（每次） | `AGENTS.md` + 本页 | AGENTS.md 是宪法：防线、红线、结构速查全在里面 |
| 改 UI（前台 / 后台 / 编辑器） | `docs/MOBILE-UX.md` | 移动端是硬要求，改前读检查清单 |
| 前台「微信同款」阅读增强 | `docs/WECHAT-PLAYBOOK.md` | 设计语言拆解 + 能力门槛红线，做这类功能才读 |
| 发布新版本 | `docs/RELEASING.md` | 版本号规则、挑洗、CHANGELOG 回填 |
| 用户功能口径 | `docs/GUIDE.md` | 使用手册；功能怎么用以它为准 |
| 接口契约 | `docs/API.md` | 端点出参 / 净化白名单摘要 |
| 部署 / 自托管 | `docs/DEPLOY.md`、`docs/UPDATING.md` | Cloudflare 与 Docker 两条路 + 更新中心 |
| 广场 / 主题 / 插件 / 演示站 | `docs/PLAZA.md`、`docs/THEMES.md`、`docs/PLUGINS.md`、`docs/DEMO.md` | 各子系统的协议与规矩 |
| 下一批做什么 | `docs/ROADMAP.md` | 已折叠：保留的待办 + 已上线大事记 + 不做清单 |
| 历史审计 / 提案 / 契约 | `docs/archive/` | 只在考古时读，日常不用管 |

---

## 2. 开工前（三件事，缺一不可）

1. **读文档**：`AGENTS.md` 全文 + 本页 + 与任务相关的那份（查 §1 地图）。
2. **跑基线**：`npm run typecheck` + `npm test`，确认**现在是绿的**。一开始就红，先查清是不是环境问题，别在红基线上叠改动。
3. **说清范围**：3–5 句话说明「这次改什么、不碰什么、怎么验证」，再动手。

> 为什么这么严：这个仓库**推送即上线**（Cloudflare Workers Builds 自动部署主站），没有缓冲带。

## 3. 干活红线（8 条，本项目专属）

1. **推送即上线，测试是唯一的刹车**——`git push origin main` 自动部署主站，CI 报红拦不住部署，所以 typecheck + test 全绿是推送前置条件；不推 `upstream`（官方仓冻结，站长明确说「发布」才走 RELEASING.md）；提交信息用中文前缀（`fix:` / `feat:` / `docs:` / `theme:`…）。
2. **新功能先想「归宿三档」，默认不进内核**——① 客户端能做（site.js / 后台原生 JS）→ ② 插件形态（hooks 总线 / 编辑器插件）→ ③ 确需进内核才新增文件；运行时依赖只有 hono，**别加 npm 包**；**禁止引入打包步骤**，前台 site.js 保持 ES5。
3. **新「公开面」必过防泄漏清单**——站里有会员付费墙、文章密码、锁文；新增 RSS / 接口 / 导出 / 主题字段时逐条问：**锁着的内容会不会从这里漏出去？**（摘要、content:encoded、JSON-LD 描述、OG 卡图是最常见的漏点）
4. **查 posts / weibo / pages 三表必带 `deleted_at IS NULL`**——三表是软删（回收站），漏一个条件就是泄漏；改完自查 `grep -n "FROM posts\|FROM weibo\|FROM pages" src/`（故意不过滤的例外见 AGENTS.md）。
5. **时间一律北京时间口径**——禁止 `new Date(ts).getHours()` 与裸 `toISOString()`（Worker 是 UTC，凌晨发布显示成前一天）；显示用 `cstDate/fmtDate*`，机器可读用 `isoDate`，SQL 聚合用 `strftime(..., ts/1000 + 28800, 'unixepoch')`，site.js 同口径。
6. **密钥 / 令牌不进日志、不进 URL、不进出参**——敏感键进 `SECRET_SETTINGS` 双向打码；文章出参过 `postAdminView`（`password_hash` 永不出参）；长期令牌只认请求头。
7. **改 schema / 加 src 文件必须「两处同步 + 登记」**——加列 / 表：`schema.sql` 与 `db.ts` 的 `SCHEMA_COLUMNS` / `SCHEMA_TABLES` 两处同步（建表语句要自带全部列）；加 `src/` 文件：在 AGENTS.md「结构速查」登记一行。
8. **写了 settings 就要失效缓存**——写完必须 `await invalidateSharedSettings(db)`（`saveSettings` 已内置），忘了 = 改完设置最多 60 秒读旧值。

## 4. 收工前（四件事）

1. **全绿并贴原始输出**：`npm run typecheck` + `npm test`（动了 SQL 拼接 / 渲染 / 路由再跑 `npm run smoke`）。
2. **更新 `AGENTS.md`**：新增的文件 / 表 / settings 键 / 防线逐条登记。不更新 = 下一个模型不知道 = 迟早重复劳动或踩坏。
3. **写「残留项」**：没做完的、有疑问的、需要站长拍板的，单独留档说明。
4. **单独 git 提交**：一个模型一块改动一个提交，方便出问题单条 revert。

## 5. 多模型并行的分工原则

- 按「文件 / 模块」切分，不按「功能」切分——两个功能碰同一文件照样冲突。
- 一次只让一个模型改同一批文件；要并行就分到互不相交的文件上。
- 每个模型收工必须留下 AGENTS.md 更新 + 残留项，这是交接单。
- 用 git 提交做检查点：模型 A 提交完，模型 B 再开工。
- 只信证据：测试输出、实测响应码，别信「看起来对」。

## 6. 最容易翻车的场景速查表

| 你可能想做 | 别这么做 | 正确做法 |
| --- | --- | --- |
| 加一个设置项 | 直接裸写 `settings` | 走 `saveSettings`，或写完补 `await invalidateSharedSettings(db)` |
| 加一个数据库列 | 只改 `schema.sql` | 同时改 `db.ts` 的 `SCHEMA_COLUMNS`（且 `SCHEMA_TABLES` 建表语句自带该列） |
| 加一个后台页面 | 只写模板 | 同时登记 `MENU`、`navigate()`、`MOBILE_TAB_IDS` |
| 加一个前台导航项 | 只测默认配置 | 四种站点模式 + 会员开/关都过一遍，390px 验证 |
| 服务器要抓一个外部网址 | 直接 `fetch()` | 走 `fetchPublicResource`（逐跳复查，防 302 到内网） |
| 加一个动态 `<input type="file">` | 直接创建节点 | 走 `pickFiles` 助手（否则 iOS Safari 选完图不回填） |
| 改前台 `site.js` | 箭头函数 / 模板字符串 / 裸 `localStorage` | 保持 ES5、禁 lookbehind；存储走 `storeGet/storeSet` |
| 改列表排序 | 只改 SQL | 排序表达式对齐部分索引（`schema.sql` + `db.ts SCHEMA_INDEXES` 两处同步） |
| 删一条记录 | 直接 `DELETE` 行 | 三表是软删（回收站）；彻底删除只走 `/admin/trash/*` |
| 加一种评论/留言形态 | 抄一整段流程 | 复用 `api.ts` 的 `publicComment` 公共核心，只写细路由 + opts |
| 新增对外出口（RSS/接口/导出） | 直接输出全部字段 | 过防泄漏清单（付费墙 / 密码文 / 锁文） |
| 改主题 / 编辑器样式 | 只改一侧 | `.ed-editor`（编辑器）与 `.rich`（文章页）镜像同改 |
| 给分站加「更新」按钮 | 做成自动拉代码 / 自动迁移 | 更新中心**只告知 + 记录选择**，升级是一次显式部署动作（docs/UPDATING.md） |
| 批量替换文本（sed 全仓） | `git ls-files` 不加过滤直接 sed | 先按扩展名过滤（`*.md` `*.ts` `*.js`…）——sed 会把 PNG / SVG 等二进制改坏几字节，还会给全仓文件留「幻影改动」（status 显示 M、diff 为空），清理很费劲（2026-10-17 实踩） |
| 改版本清单结构 | 只改生成脚本 / 只改校验器 | 三处同步：`scripts/build-release.mjs`、`src/update.ts` 校验器、`tests/update.test.ts` 守卫 |
| 发布回填 CHANGELOG 之后 | 忘了重生成 `version.json` | 跑 `npm run build:release` 并随发布提交 |

## 7. 话术模板（站长直接复制）

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

## 8. 这份文档怎么维护

- 站长（人）发现「AI 又踩了同一个坑」→ 往 §6 速查表加一行。
- 红线有增删 → §3 与 AGENTS.md 对应防线节**同改**，两处不许漂移。
- 文档地图有新成员（新增 / 归档 / 删除 docs 文件）→ §1 表同步。
