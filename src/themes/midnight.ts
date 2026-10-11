import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,
  fmtDateEn,
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
} from '../render'
import css from './midnight.css'

const id = 'midnight'

/** 页脚公共件：八个页面只差链接组，结构统一在这里 */
function foot(s: SettingsMap, links: string): string {
  const en = isEn(s)
  return `<footer class="md-footer">${footCardHtml(s, en)}<span>${esc(tr(en, s.footerText || ''))}</span><span>${footLinks(s, links)}</span></footer>`
}
const FOOT_LINKS = {
  home: '<a href="/weibo">微博</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  article: '<a href="/weibo">微博</a><a href="/admin">管理</a><a href="/rss.xml">RSS</a>',
  about: '<a href="/">Home</a><a href="/weibo">微博</a><a href="/admin">管理</a>',
}

/** 页脚链接组的英文测试版镜像（结构同 FOOT_LINKS，只换标签词） */
const FOOT_LINKS_EN = {
  home: '<a href="/weibo">Notes</a><a href="/rss.xml">RSS</a><a href="/admin">Admin</a>',
  article: '<a href="/weibo">Notes</a><a href="/admin">Admin</a><a href="/rss.xml">RSS</a>',
  about: '<a href="/">Home</a><a href="/weibo">Notes</a><a href="/admin">Admin</a>',
}

/** 站点头像：设置过 avatarUrl 用图片，否则退回呼吸圆点 */
function logoMark(s: SettingsMap): string {
  return s.avatarUrl
    ? `<img class="md-logo-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">`
    : '<span class="md-logo-dot"></span>'
}

/** 搜索框：微博卡与正文列表之上（夜航的 grep 眉题两种语言通用） */
function searchForm(q: string | undefined, en: boolean): string {
  return `<form class="md-search" action="/search" method="get" role="search">
  <svg class="md-search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>
  <input class="md-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="${en ? 'grep the posts…' : 'grep 站内文章…'}" maxlength="60" aria-label="${en ? 'Search posts' : '搜索文章'}">
  <button class="md-search-btn" type="submit">${en ? 'Search' : '搜索'}</button>
</form>`
}

export function home(d: HomeData): string {
  const s = d.settings
  const en = isEn(s)
  const items = d.posts
    .map(
      (p) => `<a class="md-card" href="/post/${esc(p.slug)}">
  ${p.cover ? `<div class="md-card-cover"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>` : ''}
  <div class="md-card-body">
    <h2 class="md-card-title">${esc(p.title)}${p.pinned ? `<span class="md-pin">PINNED</span>` : ''}</h2>
    <p class="md-card-abs">${esc(p.summary)}</p>
    <div class="md-card-meta"><time>${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</time><span>·</span><span>${en ? `${p.views} views` : `${p.views} 阅读`}</span>${p.tags.slice(0, 2).map((t) => `<span class="md-chip">${esc(t)}</span>`).join('')}</div>
  </div>
</a>`
    )
    .join('\n')
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero">
    <h1>${esc(tr(en, s.siteName))}</h1>
    <p>${esc(tr(en, s.siteDescription))}</p>
  </section>
  ${d.notice ? `<div class="md-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml(en) : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: logoMark(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo, en }) : ''}
  ${onThisDayCard(d.onThisDay, en)}
  ${searchForm(d.q, en)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }, en)}
  <main class="md-list">
    ${items || `<p class="md-empty">${d.emptyText || (en ? 'The night log is still empty.' : '夜航日志还是空的。')}</p>`}
  </main>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  }, en)}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: logoMark(s) }) : ''}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export function post(d: PostData): string {
  const en = isEn(d.settings)
  const p = d.post
  const related = d.related.length
    ? `<aside class="md-related"><h2>// ${en ? 'Keep flying' : '继续航行'}</h2>${d.related
        .map((r) => `<a href="/post/${esc(r.slug)}"><span>${esc(r.title)}</span><time>${en ? fmtDateEn(r.published_at) : fmtDate(r.published_at)}</time></a>`)
        .join('')}</aside>`
    : ''
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, en })}
  <header class="md-header">
    <a class="md-logo" href="/"><span class="md-logo-dot"></span>${esc(tr(en, d.settings.siteName))}</a>
  </header>
  <article class="md-article">
    <div class="md-crumb"><time>${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</time><span>·</span><span>${en ? `${p.readingMinutes} min` : `${p.readingMinutes} 分钟`}</span><span>·</span><span>${en ? `${p.views} views` : `${p.views} 阅读`}</span></div>
    <h1 class="md-title">${esc(p.title)}</h1>
    ${p.cover ? `<div class="md-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier, en) : ''}
    <div class="md-foot">
      ${likesBtn(p.slug, p.likes, en)}
      ${d.share ? shareBtn(d.share.url, d.share.qr, en) : ''}
      <div class="md-tags">${d.category ? `<a class="md-chip" href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''}${p.tags.map((t) => `<a class="md-chip" href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
    </div>
    ${related}
    ${postNeighborsHtml(d.prev, d.next, en)}
    ${d.comments.html}
  </article>
  ${foot(d.settings, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

export function about(d: AboutData): string {
  return page({ ...d, title: isEn(d.settings) ? 'About' : '关于我' })
}

/** 独立页面页（/page/:slug，slug='about' 时渲染 /about）：结构同关于我，标题由页面数据决定 */
export function page(d: PageData): string {
  const en = isEn(d.settings)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="md-header"><a class="md-logo" href="/">${logoMark(d.settings)}${esc(tr(en, d.settings.siteName))}</a></header>
  <article class="md-article">
    <h1 class="md-title">${esc(d.title)}</h1>
    <div class="rich">${d.contentHtml}</div>
  </article>
  ${foot(d.settings, en ? FOOT_LINKS_EN.about : FOOT_LINKS.about)}
</div>`
}

/** 文章归档页：全部文章按年份分组，等宽字日期 + 细线列表 */
export function archives(d: ArchivesData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link is-active" href="/archives">archives</a><a class="md-nav-link" href="/guestbook">guestbook</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${tr(en, '归档')}</h1>
    <p>${d.total > 0 ? (en ? `// ${d.total} ${plural(d.total, 'post', 'posts')} · newest year first` : `// 共 ${d.total} 篇 · 按年份倒序`) : en ? '// Every post lands here' : '// 写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats, en)}</p>
  </section>
  ${heatmapHtml(d.heatmap, en)}
  <main class="md-archives">${archiveListHtml(d.groups, en) || `<p class="md-empty">${en ? 'The night log is still empty.' : '夜航日志还是空的。'}</p>`}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 留言板页：独立留言墙（复用 .cmt-* 结构与样式） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link" href="/archives">archives</a><a class="md-nav-link is-active" href="/guestbook">guestbook</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${tr(en, '留言板')}</h1>
    <p>${d.count > 0 ? (en ? `// ${d.count} ${plural(d.count, 'message', 'messages')} so far · say anything` : `// 已有 ${d.count} 条留言 · 随便聊聊`) : en ? '// Write whatever you would like to say' : '// 想说点什么，就在这里写下来'}</p>
  </section>
  <main class="md-guestbook">${d.html}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 微博页：随手记时间线 */
export function weibo(d: WeiboData): string {
  const s = d.settings
  const en = isEn(s)
  const topicBar = weiboTopicBar(d.topics || [], d.topic, en)
  const composer = d.adminName ? weiboComposer({ adminName: d.adminName, en }) : ''
  const cards = weiboCards({
    settings: s,
    items: d.items,
    avatarHtml: logoMark(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link is-active" href="/weibo">weibo</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${tr(en, '微博')}</h1>
    <p>${d.topic ? (en ? `Topic #${esc(d.topic)} · ${d.total} ${plural(d.total, 'note', 'notes')}` : `话题 #${esc(d.topic)} · 共 ${d.total} 条`) : d.total > 0 ? (en ? `Notes · ${d.total} ${plural(d.total, 'note', 'notes')} in total` : `随手记 · 共 ${d.total} 条`) : en ? '// Short notes — write as you please' : '随手记，想写就写'}</p>
  </section>
  ${topicBar}
  ${composer}
  <main class="md-list wb-list">
    ${cards || `<p class="md-empty wb-empty">${d.adminName ? (en ? 'The night notes are empty — send the first signal above.' : '夜航微博还是空的，在上面发第一条信号。') : en ? 'The night notes are still empty.' : '夜航微博还是空的。'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic, en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 友情链接页：友链卡片 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link is-active" href="/links">links</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${tr(en, '友情链接')}</h1>
    <p>${d.total > 0 ? (en ? `Friend sites · ${d.total} ${plural(d.total, 'link', 'links')} in all` : `朋友站点 · 共 ${d.total} 个`) : en ? '// A place to trade links with friends' : '和朋友交换链接的地方'}</p>
  </section>
  <main class="fl-grid">
    ${friendLinkCards(d.items, en) || (en ? '<p class="md-empty wb-empty">No links on this night route yet.</p>' : '<p class="md-empty wb-empty">夜航的友链页还是空的。</p>')}
  </main>
  ${friendLinkApply(en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link is-active" href="/rank">rank</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${tr(en, '排行榜')}</h1>
    <p>${d.total > 0 ? (en ? `// ${d.total} ${plural(d.total, 'crew member', 'crew members')} · sorted by points` : `// 共 ${d.total} 位船员 · 按积分倒序`) : en ? '// Comment and come back often — your name will show up here' : '// 留言、常回来，名字就会出现在这里'}</p>
  </section>
  <main class="md-rank">${rankListHtml(d.entries, en) || (en ? '<p class="md-empty">No members on the board yet.</p>' : '<p class="md-empty">还没有会员上榜。</p>')}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="md-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'md-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member', en })}
  <header class="md-header">
    <a class="md-logo" href="/">${logoMark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="md-nav"><a class="md-nav-link" href="/rank">rank</a><a class="md-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <section class="md-hero md-hero-slim">
    <h1>${en ? 'Membership' : '会员中心'}</h1>
    <p>${d.member ? (en ? '// Points, comments and members-only posts live here' : '// 留言、常回来，积分与专属内容都在这里') : en ? '// Log in or sign up and join the night crew' : '// 登录或注册，加入夜航船员'}</p>
  </section>
  <main class="md-member">${d.member ? memberCardHtml(d.member, en) : memberAuthHtml(en)}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export { id, css }
