# 主题开发指南

博客号的公开页面（首页 / 文章页 / **微博页** / **友链页** / 关于我页 / **独立页面** / **归档页** / **留言板页** / **会员中心** / **积分排行榜**）由**主题模块**服务端渲染。任何会写 HTML/CSS 的人都可以新增主题，无需理解后端。

## 目录结构

```
src/themes/
├── registry.ts     ← 主题注册表（新主题在这里加一行；ThemeModule 接口也在这里）
├── wechat.ts / wechat.css
├── journal.ts / journal.css
├── paper.ts / paper.css
├── minimal.ts / minimal.css
├── midnight.ts / midnight.css
├── bitcoin.ts / bitcoin.css
└── rednote.ts / rednote.css
```

## 一个主题需要提供什么

一套主题 = **八个必需渲染函数**（`home` / `weibo` / `links` / `post` / `about` / `page` / `archives` / `guestbook`）+ 两个可选函数（`member` 会员中心 / `rank` 排行榜，缺省时 pages.ts 渲染通用版）+ 全局 CSS。新建 `src/themes/mytheme.ts` 与 `src/themes/mytheme.css`：

```ts
import type {
  HomeData, WeiboData, LinksData, PostData, AboutData, PageData, ArchivesData, GuestbookData,
  MemberData, RankData,
} from './registry'
import {
  esc, fmtDate, likesBtn, pagerHtml,
  friendLinkCards, friendLinkApply, siteNav, weiboCards, weiboPager,
  archiveListHtml,
} from '../render'
import css from './mytheme.css'

const id = 'mytheme'

// 入参类型全部来自 registry 的命名类型（HomeData / WeiboData / …，字段含义以 registry.ts 注释为准），
// 七套官方主题（wechat.ts 最完整）是现成参照。这里示范最常用的 home()：
export function home(d: HomeData): string {
  return `<div class="my-page">
    ${siteNav({ cls: 'my-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive })}
    ${d.posts.map(p => `
      <a class="my-item" href="/post/${esc(p.slug)}">
        <h2>${esc(p.title)}</h2>
        <p>${esc(p.summary)}</p>
        <time>${fmtDate(p.published_at)}</time>
      </a>`).join('')}
    ${pagerHtml({ page: d.page, totalPages: d.totalPages, base: '/?' })}
  </div>`
}

export function weibo(d: WeiboData): string {
  // 卡片/翻页复用 render.ts 的 weiboCards / weiboPager（语义化 .wb-* class，样式由你的 CSS 塑形）
  return `<div class="my-page">
    <h1>微博</h1>
    ${weiboCards({ settings: d.settings, items: d.items, avatarHtml: '', allowComments: d.allowComments, adminName: d.adminName })}
    ${weiboPager(d.page, d.totalPages)}
  </div>`
}

export function links(d: LinksData): string {
  // 卡片与「申请收录」表单复用 friendLinkCards / friendLinkApply（语义化 .fl-* class）
  return `<div class="my-page">
    <h1>友情链接</h1>
    ${friendLinkCards(d.items)}
    ${friendLinkApply()}
  </div>`
}

export function post(d: PostData): string {
  return `<div class="my-article">
    <h1>${esc(d.post.title)}</h1>
    <div class="rich">${d.post.contentHtml}</div>
    ${likesBtn(d.post.slug, d.post.likes)}
    ${d.comments.html}
  </div>`
}

export function about(d: AboutData): string {
  return `<div class="my-about"><h1>关于我</h1><div class="rich">${d.contentHtml}</div></div>`
}

export function page(d: PageData): string {
  // 独立页面与 about 同构；漏实现时 pages.ts 有通用兜底（仅正文壳）
  return `<div class="my-page"><h1>${esc(d.title)}</h1><div class="rich">${d.contentHtml}</div></div>`
}

export function archives(d: ArchivesData): string {
  // 归档列表复用 render.ts 的 archiveListHtml（语义化 .ar-* class，样式由你的 CSS 塑形）
  return `<div class="my-page">
    <h1>文章归档</h1>
    ${archiveListHtml(d.groups)}
  </div>`
}

export function guestbook(d: GuestbookData): string {
  // 留言墙 + 表单由 pages 层用 commentsHtml({ guestbook: true }) 拼好，直接输出
  return `<div class="my-page">
    <h1>留言板</h1>
    ${d.html}
  </div>`
}

export { id, css }
```

然后在 `registry.ts` 注册：

```ts
import * as mytheme from './mytheme'

export const THEMES: Record<string, ThemeModule> = {
  // …已有主题
  mytheme: { ...mytheme, id: 'mytheme', name: '我的主题', description: '一句话描述',
    // 可选：后台「皮肤」卡片预览色板 [背景, 强调条, 卡面, 卡面2, 卡面3]
    colors: ['#faf8f4', '#b23a29', '#ffffff', '#f2ede4', '#f7f3ec'],
  },
}
```

保存后（本地 `npm run dev` 即时生效）到后台「皮肤」页（「系统」分组下）就能看到并一键启用；同时可把它登记进 `public/market/catalog.json`，让它出现在「皮肤市场」。**入参的权威定义**是 `registry.ts` 的各 `*Data` 命名类型（字段注释就在那里）与 `pages.ts` 的调用处——改版后以它们为准，抄现成主题（如 `wechat.ts`）最省事。

## 公共积木（来自 `src/render.ts`，鼓励复用）

| 导出 | 用途 |
| --- | --- |
| `esc(s)` | HTML 转义（标题、摘要等所有字符串必须转义后再拼接） |
| `fmtDate / fmtDateCN / fmtViews` | 日期（`2026-10-03` / `2026年10月3日`）与 `1.2w` 阅读数 |
| `page(o)` | 完整 HTML 外壳（head / meta / OG 标签 / 内联 CSS / 挂 site.js），所有页面统一走它 |
| `pagerHtml({page,totalPages,base})` | 标准分页条，class 交给你的 CSS 塑形 |
| `siteNav({cls,categories,tags,pages,active})` | 顶部站点导航（首页 / 微博 / 归档 / 留言板 / 「分类话题」details 折叠菜单 / 友情链接 / 自建页面 / 关于我 / 随机）。`pages` 传 `NavPage[]`（`{title, href, key}`，pages 层的 `navPages` 构建，类型从 `../render` 导入）。菜单面板（`.{cls}-menu/-chips/-caret` 等）由你的 CSS 塑形，参考任一现有主题的同名段落 |
| `homeSortBar({sort,seed,tag,categorySlug,q})` | 首页/分类/搜索共用的排序条（最新 / 最多阅读 / 最多点赞 / 最多留言 / 随机） |
| `commentsHtml({...})` | 完整留言区（列表 + 表单 + 蜜罐 + 楼中楼回复按钮），语义化 class：`.cmt-*`；传 `guestbook: true` 即留言板页的留言墙 |
| `likesBtn(slug, likes)` | 点赞按钮，配 `public/site.js` 自动工作，class `.like-btn` |
| `tagLink(name)` / `categoryLink(c)` | 标签链接 `/tag/<encodeURIComponent(name)>` / 分类链接 `/category/<slug>` |
| `weiboCards({settings,items,avatarHtml,allowComments,adminName})` | 微博卡片列表（头像 + 文字 + 话题高亮 + 图片网格 + 点赞 + 折叠评论），class `.wb-*` |
| `weiboHomeEntry({items,total})` | 首页「微博入口卡」（最新随手记摘要 + 全部链接） |
| `onThisDayCard(items)` | 首页「历史上的今天」时光机卡（`home()` 收到 `onThisDay` 时渲染） |
| `weiboComposer({adminName})` | 微博页顶部发布框（登录管理员才传 `adminName`，访客页不渲染） |
| `weiboPager(page,totalPages,topic?)` | 微博翻页（上一条 / 更早），class `.wb-pager*`；按话题筛选时传 `topic` 以在翻页链接中保留 |
| `weiboImageGrid(images)` | 微博图片网格（1 大图 / 2·4 双列 / 其余三列） |
| `weiboTopicBar(topics, active?)` | 微博话题条（`?topic=` 筛选用） |
| `friendLinkCards(items)` / `friendLinkApply()` | 友链卡片列表 / 访客申请收录表单（含蜜罐），class `.fl-*` |
| `archiveGroups(posts)` / `archiveListHtml(groups)` | 归档按年分组 / 归档列表（年份小节 + 日期外置链接列表），class `.ar-*` |
| `memberCardHtml(v)` / `memberAuthHtml()` | 会员中心：已登录会员卡 / 登录注册双表单（`member()` 可选函数内用） |
| `rankListHtml(entries, me?)` | 积分排行榜列表（/rank 页主体，含本人行高亮），class `.rk-*` |
| `paywallHtml(tierName)` | 会员付费墙遮挡卡（`locked` 文章正文收尾处渲染；`locked` 由 pages 层判定） |

## 交互约定

公开页只挂了一个 `public/site.js`，主题不需要写任何 JS，自动处理：

1. 点击 `.like-btn` → 调 `/api/public/like/:slug`（或微博的 `/api/public/like/weibo/:id`），更新计数与 `.liked` 状态（localStorage 去重）
2. 提交 `#comment-form` / `.wb-cmt-form` / `#guestbook-form` → 调对应评论接口，成功后刷新或就地刷新列表；管理员登录态由服务端渲染进表单（免填昵称）
3. 微博卡片评论区的展开 / 折叠、楼中楼回复按钮、友链申请表单提交
4. 顶部「分类话题」折叠菜单：点击菜单外或按 Esc 收起

想加更多交互？在你的主题 CSS 之外追加一个 JS 文件放 `public/`，并在 `src/render.ts` 的 `page()` 里加一行 `<script src="/你的.js" defer></script>`（CSP 已允许同源脚本）。

## 排版规范（建议遵守）

主题模板与正文渲染遵循《微信公众平台编辑器插件开发规范》要点，完整清单见 [wechat-typography-spec.md](wechat-typography-spec.md)。给主题作者的三条底线：

1. **不写固定像素宽**：容器用 `max-width + 百分比`，横滚等特殊场景在节点上加 `data-ignore-width`
2. **行高 ≥ 字号**：`line-height` 小于 `font-size` 会让多行文字重叠
3. **别在正文容器设 font-family**：跟随默认字体栈，各端观感一致（标题/代码可用）
