import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import { cstDate } from '../utils'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDateCN,
  fmtDateEn,
  fmtViews,
  footLinks,
  friendLinkApply,
  friendLinkCards,
  homeListBase,
  homeSortBar,
  isEn,
  likesBtn,
  memberAuthHtml,
  memberCardHtml,
  onThisDayCard,
  pagerHtml,
  paywallHtml,
  plural,
  yearStatsSuffix,
  footCardHtml,
  newSiteGuideHtml,
  postNeighborsHtml,
  heatmapHtml,
  rankListHtml,
  shareBtn,
  siteMode,
  siteNav,
  tagLink,
  tr,
  weiboCards,
  weiboComposer,
  weiboHomeEntry,
  weiboHomeFeed,
  weiboSearchResults,
  weiboPager,
  weiboTopicBar,
  type CategoryLink,
  type NavPage,
  type TagCount,
} from '../render'
import css from './journal.css'

const id = 'journal'

/** 页脚公共件：八个页面只差链接组，结构统一在这里 */
function foot(s: SettingsMap, links: string): string {
  const en = isEn(s)
  return `<footer class="jrn-footer">
    ${footCardHtml(s, en)}<span class="jrn-footer-note">${esc(tr(en, s.footerText || ''))}</span>
    <span class="jrn-footer-links">${footLinks(s, links)}</span>
  </footer>`
}
const FOOT_LINKS = {
  home: '<a href="/weibo">随手记</a><a href="/links">友链</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  archive: '<a href="/weibo">随手记</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  article: '<a href="/">回首页</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
}

/** 页脚链接组的英文测试版镜像（结构同 FOOT_LINKS，只换标签词） */
const FOOT_LINKS_EN = {
  home: '<a href="/weibo">Notes</a><a href="/links">Links</a><a href="/rss.xml">RSS</a><a href="/admin">Admin</a>',
  archive: '<a href="/weibo">Notes</a><a href="/rss.xml">RSS</a><a href="/admin">Admin</a>',
  article: '<a href="/">Home</a><a href="/rss.xml">RSS</a><a href="/admin">Admin</a>',
}

/** 站点头像：设置过 avatarUrl 才展示 */
function avatar(s: SettingsMap): string {
  return s.avatarUrl ? `<img class="jrn-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">` : ''
}

/** 日历牌日期：页码日历式的「日 + 年.月」小牌（数字无语言，中英文共用） */
function dayBadge(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = cstDate(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `<div class="jrn-day" aria-hidden="true"><b>${p(d.getUTCDate())}</b><span>${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}</span></div>`
}

/** 搜索框：刊头下方的小纸片搜索 */
function searchForm(q: string | undefined, en: boolean): string {
  return `<form class="jrn-search" action="/search" method="get" role="search">
  <input class="jrn-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="${en ? 'Leaf through the posts…' : '翻一翻，找篇文章…'}" maxlength="60" aria-label="${en ? 'Search posts' : '搜索文章'}">
  <button class="jrn-search-btn" type="submit">${en ? 'Search' : '找找'}</button>
</form>`
}

export function home(d: HomeData): string {
  const s = d.settings
  const en = isEn(s)
  const items = d.posts
    .map((p) => {
      const stickers = p.tags
        .slice(0, 3)
        .map((t) => `<a class="jrn-sticker" href="${tagLink(t)}">${esc(t)}</a>`)
        .join('')
      return `<article class="jrn-entry">
  <a class="jrn-entry-link" href="/post/${esc(p.slug)}">
    ${dayBadge(p.published_at)}
    <div class="jrn-entry-main">
      <h2 class="jrn-entry-title">${esc(p.title)}${p.pinned ? `<span class="jrn-pin">${tr(en, '置顶')}</span>` : ''}</h2>
      <p class="jrn-entry-abs">${esc(p.summary)}</p>
      <p class="jrn-entry-meta"><span>${en ? `${fmtViews(p.views, en)} views` : `${fmtViews(p.views)} 阅读`}</span><span>${en ? `${p.likes} ${plural(p.likes, 'like', 'likes')}` : `${p.likes} 赞`}</span>${
        p.commentCount ? `<span>${en ? `${p.commentCount} ${plural(p.commentCount, 'comment', 'comments')}` : `${p.commentCount} 评`}</span>` : ''
      }</p>
    </div>
    ${p.cover ? `<div class="jrn-polaroid"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>` : ''}
  </a>
  ${stickers ? `<div class="jrn-entry-tags">${stickers}</div>` : ''}
</article>`
    })
    .join('\n')
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="jrn-masthead">
    <a class="jrn-logo" href="/">${avatar(s)}<span class="jrn-logo-name">${esc(tr(en, s.siteName))}</span></a>
    <p class="jrn-intro">${esc(tr(en, s.siteDescription))}</p>
  </header>
  <main>
  ${d.notice ? `<div class="jrn-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml(en) : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: avatar(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo, en }) : ''}
  ${onThisDayCard(d.onThisDay, en)}
  ${searchForm(d.q, en)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }, en)}
  <section class="jrn-list">
    ${items || `<p class="jrn-empty">${d.emptyText || (en ? 'This page is still empty — go write the first entry.' : '这一页还空着，去写下第一篇吧。')}</p>`}
  </section>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  }, en)}
  </main>
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: avatar(s) }) : ''}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export function post(d: PostData): string {
  const en = isEn(d.settings)
  const p = d.post
  const kicker = d.category
    ? `<a class="jrn-kicker" href="${categoryLink(d.category)}">${esc(d.category.name)}</a>`
    : ''
  const related = d.related.length
    ? `<aside class="jrn-related"><h2 class="jrn-related-title">${en ? 'Keep reading' : '接着读'}</h2>${d.related
        .map(
          (r) => `<a class="jrn-related-item" href="/post/${esc(r.slug)}">
    ${r.cover ? `<span class="jrn-related-thumb"><img src="${esc(r.cover)}" loading="lazy" alt=""></span>` : ''}
    <span class="jrn-related-name">${esc(r.title)}</span>
  </a>`
        )
        .join('')}</aside>`
    : ''
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, en })}
  <main>
  <article class="jrn-article">
    ${kicker}
    <h1 class="jrn-title">${esc(p.title)}</h1>
    <p class="jrn-meta"><time>${en ? fmtDateEn(p.published_at) : fmtDateCN(p.published_at)}</time><span>·</span><span>${en ? `about ${p.readingMinutes} min` : `约 ${p.readingMinutes} 分钟`}</span><span>·</span><span>${en ? `${fmtViews(p.views, en)} views` : `${fmtViews(p.views)} 阅读`}</span></p>
    ${p.cover ? `<figure class="jrn-cover"><img src="${esc(p.cover)}" alt=""><figcaption>${en ? `Taken on ${fmtDateEn(p.published_at)}` : `摄于 ${fmtDateCN(p.published_at)}`}</figcaption></figure>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier, en) : ''}
    <div class="jrn-foot">
      ${likesBtn(p.slug, p.likes, en)}
      ${d.share ? shareBtn(d.share.url, d.share.qr, en) : ''}
      <div class="jrn-tags">${p.tags.map((t) => `<a class="jrn-sticker" href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
    </div>
  </article>
  ${related}
  ${postNeighborsHtml(d.prev, d.next, en)}
  ${d.comments.html}
  </main>
  ${foot(d.settings, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

/** 关于我 / 独立页面共用壳：仅标题与 jrn-about 修饰类不同 */
function aboutPage(o: {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  navActive?: string
  title: string
  contentHtml: string
  about?: boolean
}): string {
  const en = isEn(o.settings)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(o.settings), memberEnabled: o.settings.membersEnabled === '1', cls: 'jrn-snav', categories: o.categories, tags: o.tags, pages: o.pages, active: o.navActive, en })}
  <main>
  <article class="jrn-article${o.about ? ' jrn-about' : ''}">
    <h1 class="jrn-title">${esc(o.title)}</h1>
    <div class="rich">${o.contentHtml}</div>
  </article>
  </main>
  ${foot(o.settings, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

export function about(d: AboutData): string {
  return aboutPage({ ...d, title: isEn(d.settings) ? 'About' : '关于我', about: true })
}

/** 独立页面页（/page/:slug，slug='about' 时渲染 /about）：结构同关于我，标题由页面数据决定 */
export function page(d: PageData): string {
  return aboutPage(d)
}

/** 文章归档页：年份做成胶带标签，列表带日历牌日期 */
export function archives(d: ArchivesData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${tr(en, '归档')}</h1>
  <p class="jrn-intro jrn-page-sub">${d.total > 0 ? (en ? `This journal holds ${d.total} ${plural(d.total, 'entry', 'entries')} in all` : `这本手账一共写了 ${d.total} 篇`) : en ? 'Every post lands here.' : '写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats, en)}</p>
  ${heatmapHtml(d.heatmap, en)}
  <section class="jrn-archives">${archiveListHtml(d.groups, en) || `<p class="jrn-empty">${en ? 'This page is still empty.' : '这一页还空着。'}</p>`}</section>
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.archive : FOOT_LINKS.archive)}
</div>`
}

/** 留言板页：留言墙做成一面粉色便利贴墙 */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${tr(en, '留言板')}</h1>
  <p class="jrn-intro jrn-page-sub">${d.count > 0 ? (en ? `${d.count} ${plural(d.count, 'sticky note', 'sticky notes')} on the wall` : `墙上已经贴了 ${d.count} 张便签`) : en ? 'The wall is empty — stick a note and say hello' : '墙上还空着，贴张便签打个招呼吧'}</p>
  <section class="jrn-gbwall">${d.html}</section>
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.archive : FOOT_LINKS.archive)}
</div>`
}

/** 微博页：随手记时间线，卡片带胶带贴在虚线时间轴上 */
export function weibo(d: WeiboData): string {
  const s = d.settings
  const en = isEn(s)
  const topicBar = weiboTopicBar(d.topics || [], d.topic, en)
  const composer = d.adminName ? weiboComposer({ adminName: d.adminName, en }) : ''
  const cards = weiboCards({
    settings: s,
    items: d.items,
    avatarHtml: avatar(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="jrn-wrap jrn-wrap-weibo">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${tr(en, '微博')}</h1>
  <p class="jrn-intro jrn-page-sub">${en ? `Everyday bits, no titles needed${d.total > 0 ? ` · ${d.total} ${plural(d.total, 'note', 'notes')} in all` : ''}` : `不用起标题的日常，想到什么记什么${d.total > 0 ? ` · 共 ${d.total} 条` : ''}`}</p>
  ${topicBar}
  ${composer}
  <section class="jrn-wbtimeline">
    ${cards || `<p class="wb-empty">${d.adminName ? (en ? 'Still empty — jot the first one above.' : '这里还空着，在上面记下第一条吧。') : en ? 'Still empty — check back in a couple of days.' : '这里还空着，过两天再来看看。'}</p>`}
  </section>
  ${weiboPager(d.page, d.totalPages, d.topic, en)}
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

/** 友情链接页：友链名片墙 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${en ? 'Neighbors' : '友邻'}</h1>
  <p class="jrn-intro jrn-page-sub">${en ? `${d.total} ${plural(d.total, 'card', 'cards')} on the wall, all dear friends` : `挂在墙上的 ${d.total} 张名片，都是交心的朋友`}</p>
  <section class="jrn-flwall">
    ${friendLinkCards(d.items, en) || (en ? '<p class="jrn-empty">No cards on the wall yet — care to trade one?</p>' : '<p class="jrn-empty">墙上还没有名片，来换一张？</p>')}
  </section>
  ${friendLinkApply(en)}
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${tr(en, '排行榜')}</h1>
  <p class="jrn-intro jrn-page-sub">${d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'regular', 'regulars')} in this journal · sorted by points` : `手账上的 ${d.total} 位常客 · 按积分排序`) : en ? 'Comment and come back often — your name will show up here' : '留言、常回来，名字就会出现在这里'}</p>
  <section class="jrn-rank">${rankListHtml(d.entries, en) || (en ? '<p class="jrn-empty">Still empty — claim the top spot.</p>' : '<p class="jrn-empty">这一页还空着，抢个头名吧。</p>')}</section>
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.archive : FOOT_LINKS.archive)}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="jrn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'jrn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member', en })}
  <main>
  <h1 class="jrn-title jrn-page-title">${en ? 'Membership' : '会员中心'}</h1>
  <p class="jrn-intro jrn-page-sub">${d.member ? (en ? 'Points, comments and members-only posts live here' : '留言、常回来，积分与专属内容都在这里') : en ? 'Sign your name and become a regular' : '署个名，成为这本手账的常客'}</p>
  <section class="jrn-member">${d.member ? memberCardHtml(d.member, en) : memberAuthHtml(en)}</section>
  </main>
  ${foot(s, en ? FOOT_LINKS_EN.archive : FOOT_LINKS.archive)}
</div>`
}

export { id, css }
