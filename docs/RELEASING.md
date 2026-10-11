# 发布流程（开发线 → 官方仓库）

> 维护者操作清单。日常开发只推 origin（`bloghao-xwblog`，滚动开发线）；upstream（`bloghao/bloghao`，官方部署入口）**默认冻结——仅当用户明确指示发布时**才按本清单手动执行。约定背景见 AGENTS.md「Git 约定」——两仓历史允许分叉，同步方向永远 dev → stable 单向。
>
> 本文件同时承载两份滚动台账：文末的**个人定制台账**（发布挑洗的依据）与根目录 **CHANGELOG.md**（官方用户的版本说明，发布时回填）。

## 发布时机（仅用户明确指示）

**upstream 默认冻结：未经用户明确指示，任何改动都不同步到 `bloghao/bloghao`。** 开发线攒了 feat 批次、ROADMAP 区段收官、甚至修了影响官方用户的安全问题，都不构成自行发布的理由——只有用户明确说「发布」才执行本清单。用户征询「要不要发一版」时，可参考下列信号给出建议：

- 自上次发布起，开发线累计了成规模的 feat 批次（`git log --oneline vX.Y..main` 一眼可见）
- ROADMAP 一个区段收官（如 A 区清空、B 区挑完一批）
- 修掉了影响官方用户的安全 / 数据问题，值得建议尽快让官方版带上

## 版本号

事实源是 `package.json` 的 `version` 字段：

- **修订号**（2.0.**X**）：hotfix、纯修复批次
- **次版本**（2.**X**.0）：常规功能批次
- **主版本**（**X**.0.0）：破坏性变更（schema 不兼容、配置项废弃等）

对部署用户来说，升级 = 同步本仓库最新代码后重新部署，D1 结构由 ensureSchema 自动增量迁移——若某次发布含**需要手动动作**的条目，必须在 CHANGELOG 对应条目用「⚠️ 升级注意」标出。

## 发布前检查（在 origin main 上）

- [ ] `git status` 干净——工作区不留未提交改动，文档改动同样入库
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿
- [ ] `npm run smoke` 全绿
- [ ] 本次批次的 CHANGELOG 条目已随手记入 Unreleased 区（**日常随手记，别攒到发布日回忆**）

## 发布步骤

### 1. 取上游、切发布分支

```bash
git checkout main
git fetch upstream --tags
git checkout -b release/vX.Y.Z upstream/main   # 发布内容 = 官方现状 + 本次挑洗结果
```

### 2. squash 合入开发线

```bash
git merge --squash main    # 只取内容快照，不带开发历史
```

### 3. 挑洗（关键步骤）

```bash
git diff --staged --stat                  # 总览改动面
git diff --staged -- <path>               # 逐文件细看
git checkout upstream/main -- <path>      # 整个文件退回官方现状（剔除个人定制时用）
grep -rn "<关键词>" . --exclude-dir=node_modules   # 剔除后搜残留引用
```

- 按文末「个人定制台账」逐条剔除个人实例定制与实验内容；**拿不准的宁可不发**——留在开发线不影响官方用户
- 文档口吻检查：README / docs / 官网对官方用户自洽，blog.xiaowuleyi.com 一律表述为「在线示例」
- 剔除动过的文件必须重跑三道闸（typecheck / test / smoke）——挑洗后的内容与 main 已有差异，不能沿用 main 的检查结果

### 4. 回填版本档案（属于本次发布提交的一部分）

- 根目录 CHANGELOG.md：Unreleased 区整段移入新版本小节，写日期与版本号，更新底部 compare 链接
- docs/VERSIONS.md 版本大事记（官网「版本更新说明」页源文件）：新版本补一节要点并同步「版本速览」表
- `package.json`：`version` bump 到本次版本号

### 5. 三道闸 + 单提交推 upstream

```bash
npm run typecheck && npm test && npm run smoke
git add -A
git commit -m "release: vX.Y.Z <一句话概括>"
git push upstream HEAD:main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push upstream vX.Y.Z
```

### 6. 收尾：镜像回开发线

```bash
git checkout main
git branch -D release/vX.Y.Z      # 本地发布分支用完即删
git fetch upstream --tags         # 新 tag 带回本地坐标
```

把 CHANGELOG.md 与 package.json 的版本改动**镜像回 origin main**（同样内容，单独一个 `docs:` 提交推 origin）。这不只是记账习惯——开发线上这两处与官方版同貌，下次 `git merge --squash main` 才不会在 CHANGELOG / package.json 上冲突；镜像完成后开发线 Unreleased 区清空，开始下一轮。

## Hotfix 与回滚

- **tag 只进不退**：已发布版本发现问题，不移动 tag、不改写历史，在 upstream 上以修复提交推进，bump 修订号后重走发布步骤
- 单文件 hotfix 可直接在 upstream 侧修，但**等价改动必须镜像回 origin main**（单独小提交；不要 pull upstream）
- upstream main 永远保持可部署是底线：发布后冒烟发现问题，先 revert 到上一个 tag 再排查

## 个人定制台账

> 滚动维护：任何「只想在自己站上有」的改动，**合入 main 当天在这里登记一行**，发布挑洗照单执行，不靠回忆。
>
> 判断标准：GUIDE / API 里写得出用法文档的是官方功能；写不出文档、只服务于本站（私有集成、实验功能、个人内容人设）的才是个人定制。

| 日期 | 内容（对应 commit / 功能名） | 不进官方版的原因 | 涉及文件 |
| --- | --- | --- | --- |
| 2026-10-07 | 批次核对（会员体系 P1 / 积分 / 排行榜 / 文章访问密码，main 0cb8c0d 集成） | —（**本批无个人定制**：四项均为写得出用法文档的官方功能候选，GUIDE §15 / API 会员节 / CHANGELOG Unreleased 已备；会员「跳队先行」是否随下版发布由发布日定，见 ROADMAP B2。收费配置、站点人设内容等运营属性尚未落地，落地当天在此登记） | — |
| 2026-10-07 | 外链中间页白名单含站长自有域名（批次：外链提醒页 /go + 微博链接超链化 + 会员评论表单贯通 + 首页排行挂件下线） | **部分**：外链提醒页本身是官方功能（GUIDE §5 / API `/go` 已备），但 `src/outlink.ts` `TRUSTED_OUT_DOMAINS`（及 site.js `TRUSTED_OUT` 镜像）前四项是站长自有域名（bloghao.com / xiaowuleyi.com / habfut.com / btchao.com）——发布挑洗时把这两处清单里的自有域名剔除（保留主流大站），其余照发 | src/outlink.ts、public/site.js |
