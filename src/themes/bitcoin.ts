import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,
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
} from '../render'
import css from './bitcoin.css'

const id = 'bitcoin'

/**
 * 比特币官方圆形 ₿ 标（bitcoin.org 版式，品牌素材站按 MIT 分发）：
 * 橙圆 #f7931a + 白色倾斜 ₿，双色按官方规范写死（不用 currentColor——白字进别的底色就不成立）。
 * 没设站点头像时作为默认站点标志，尺寸由主题 CSS 按场景塑形。
 */
const BTC_LOGO =
  '<svg class="bt-btclogo" viewBox="0 0 64 64" aria-hidden="true"><path fill="#f7931a" d="M63.04 39.741c-4.274 17.143-21.638 27.575-38.783 23.301C7.117 58.768-3.313 41.404.962 24.262 5.234 7.117 22.597-3.315 39.737.959c17.144 4.274 27.576 21.64 23.302 38.782z"/><path fill="#fff" d="M46.11 27.441c.636-4.258-2.606-6.547-7.039-8.074l1.438-5.768-3.512-.875-1.4 5.616c-.923-.23-1.871-.447-2.813-.662l1.41-5.653-3.51-.875-1.439 5.766c-.745-.17-1.478-.338-2.192-.514l.004-.018-4.842-1.209-.934 3.75s2.605.597 2.55.634c1.422.355 1.68 1.296 1.636 2.042l-1.638 6.571c.098.025.225.061.365.117l-.371-.092-2.297 9.209c-.174.432-.615 1.08-1.609.834.035.051-2.552-.637-2.552-.637l-1.743 4.02 4.569 1.139c.85.213 1.683.436 2.503.646l-1.454 5.835 3.507.875 1.44-5.772c.958.26 1.888.5 2.797.726l-1.434 5.745 3.511.875 1.454-5.824c5.987 1.133 10.49.676 12.384-4.739 1.527-4.36-.076-6.875-3.226-8.515 2.294-.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38.594 10.012 1.77 8.878 6.317zm1.086-11.312c-.99 3.966-7.1 1.951-9.081 1.457l1.748-7.01c1.98.494 8.365 1.416 7.333 5.553z"/></svg>'

/** 页脚公共件：八个页面只差链接组，结构统一在这里；末行 mono 小字是主题签名句 */
function foot(s: SettingsMap, links: string): string {
  const en = isEn(s)
  return `<footer class="bt-footer">
  ${footCardHtml(s, en)}<div class="bt-footer-row"><span>${esc(tr(en, s.footerText || ''))}</span><span class="bt-footer-links">${footLinks(s, links)}</span></div>
  <p class="bt-footer-motto">${BTC_LOGO}Don&#39;t trust, verify.</p>
</footer>`
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

/** 站点标志：设置过 avatarUrl 用头像，否则用 ₿ 标（比特币主题的默认门面） */
function mark(s: SettingsMap): string {
  return s.avatarUrl ? `<img class="bt-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">` : BTC_LOGO
}

/** 眉题（品牌站的等宽小字标签，中文 · 英文大写），段落/区块的第一声 */
function eyebrow(text: string): string {
  return `<p class="bt-eyebrow">${esc(text)}</p>`
}

/** 搜索框：微博卡与列表之间（比特币主题默认文案本就是英文，两种语言共用） */
function searchForm(q: string | undefined, en: boolean): string {
  return `<form class="bt-search" action="/search" method="get" role="search">
  <input class="bt-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="Search…" maxlength="60" aria-label="${en ? 'Search posts' : '搜索文章'}">
  <button class="bt-search-btn" type="submit">${en ? 'Search' : '搜索'}</button>
</form>`
}

export function home(d: HomeData): string {
  const s = d.settings
  const en = isEn(s)
  const items = d.posts
    .map(
      (p) => `<a class="bt-item" href="/post/${esc(p.slug)}">
  <div class="bt-item-main">
    <p class="bt-item-meta"><time>${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</time><i>·</i><span>${p.readingMinutes} min</span>${p.commentCount ? `<i>·</i><span>${en ? `${p.commentCount} ${plural(p.commentCount, 'comment', 'comments')}` : `${p.commentCount} 评`}</span>` : ''}</p>
    <h2 class="bt-item-title">${esc(p.title)}${p.pinned ? `<span class="bt-pin">${tr(en, '置顶')}</span>` : ''}</h2>
    <p class="bt-item-abs">${esc(p.summary)}</p>
  </div>
  ${p.cover ? `<div class="bt-thumb"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>` : ''}
</a>`
    )
    .join('\n')
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="bt-hero">
    <div class="bt-hero-mark">${mark(s)}</div>
    ${eyebrow(d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'post', 'posts')} · always growing` : `共 ${d.total} 篇 · 持续更新`) : 'EMPTY MEMPOOL · 虚位以待')}
    <h1 class="bt-hero-title">${esc(tr(en, s.siteName))}</h1>
    <p class="bt-hero-lead">${esc(tr(en, s.siteDescription))}</p>
  </header>
  ${d.notice ? `<div class="bt-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml(en) : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: mark(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo, en }) : ''}
  ${onThisDayCard(d.onThisDay, en)}
  ${searchForm(d.q, en)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }, en)}
  <main class="bt-list">
    ${items || `<p class="bt-empty">${d.emptyText || 'Nothing here yet. Start writing.'}</p>`}
  </main>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  }, en)}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: mark(s) }) : ''}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export function post(d: PostData): string {
  const en = isEn(d.settings)
  const p = d.post
  const related = d.related.length
    ? `<aside class="bt-related">${eyebrow(en ? 'READ MORE' : '继续读 · READ MORE')}${d.related
        .map((r) => `<a href="/post/${esc(r.slug)}">${esc(r.title)}</a>`)
        .join('')}</aside>`
    : ''
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">← ${esc(tr(en, d.settings.siteName))}</a>
  </header>
  <article class="bt-article">
    ${eyebrow(d.category ? `${d.category.name} · POST` : en ? 'ARTICLE' : '文章 · ARTICLE')}
    <h1 class="bt-title">${esc(p.title)}</h1>
    <div class="bt-meta"><time>${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</time><i>·</i><span>${p.readingMinutes} min</span><i>·</i><span>${fmtViews(p.views, en)}</span>${p.aiGenerated ? `<i>·</i><span>${en ? 'AI-generated' : 'AI 生成'}</span>` : ''}</div>
    ${p.cover ? `<div class="bt-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier, en) : ''}
    <div class="bt-foot">
      ${likesBtn(p.slug, p.likes, en)}
      ${d.share ? shareBtn(d.share.url, d.share.qr, en) : ''}
      <div class="bt-tags">${d.category ? `<a href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''}${p.tags.map((t) => `<a href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
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
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="bt-header"><a class="bt-logo" href="/">← ${esc(tr(en, d.settings.siteName))}</a></header>
  <article class="bt-article">
    ${eyebrow(en ? 'PAGE' : '页面 · PAGE')}
    <h1 class="bt-title">${esc(d.title)}</h1>
    <div class="rich">${d.contentHtml}</div>
  </article>
  ${foot(d.settings, en ? FOOT_LINKS_EN.about : FOOT_LINKS.about)}
</div>`
}

/** 文章归档页：全部文章按年份分组，年份橙色等宽 + 圆点时间线 */
export function archives(d: ArchivesData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link is-active" href="/archives">${tr(en, '归档')}</a><a class="bt-nav-link" href="/guestbook">${tr(en, '留言板')}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="bt-title bt-page-title">${tr(en, '归档')}</h1>
  <p class="bt-page-sub">${d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'post', 'posts')} · newest year first` : `共 ${d.total} 篇 · 按年份倒序`) : en ? 'Every post lands here.' : '写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats, en)}</p>
  ${heatmapHtml(d.heatmap, en)}
  <main class="bt-archives">${archiveListHtml(d.groups, en) || '<p class="bt-empty">Nothing here yet. Start writing.</p>'}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 留言板页：独立留言墙（复用 .cmt-* 结构与样式） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link" href="/archives">${tr(en, '归档')}</a><a class="bt-nav-link is-active" href="/guestbook">${tr(en, '留言板')}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="bt-title bt-page-title">${tr(en, '留言板')}</h1>
  <p class="bt-page-sub">${d.count > 0 ? (en ? `${d.count} ${plural(d.count, 'message', 'messages')} so far · say anything` : `已有 ${d.count} 条留言 · 随便聊聊`) : en ? 'Write whatever you would like to say' : '想说点什么，就在这里写下来'}</p>
  <main>${d.html}</main>
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
    avatarHtml: mark(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link is-active" href="/weibo">${tr(en, '微博')}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  ${topicBar}
  ${composer}
  <main class="wb-list">
    ${cards || `<p class="bt-empty">${d.adminName ? 'Nothing here yet — post the first one above.' : 'Nothing here yet.'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic, en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 友情链接页：友链卡片 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link is-active" href="/links">${en ? 'Links' : '友链'}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  ${eyebrow(en ? 'LINKS' : '友情链接 · LINKS')}
  <main class="fl-grid">
    ${friendLinkCards(d.items, en) || '<p class="bt-empty">No links yet.</p>'}
  </main>
  ${friendLinkApply(en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link is-active" href="/rank">${tr(en, '排行榜')}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="bt-title bt-page-title">${tr(en, '排行榜')}</h1>
  <p class="bt-page-sub">${d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'member', 'members')} · sorted by points` : `共 ${d.total} 位会员 · 按积分倒序`) : en ? 'The top spot is up for grabs' : '榜首虚位以待'}</p>
  <main class="bt-rank">${rankListHtml(d.entries, en) || (en ? '<p class="bt-empty">No members on the board yet.</p>' : '<p class="bt-empty">还没有会员上榜。</p>')}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="bt-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'bt-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member', en })}
  <header class="bt-header">
    <a class="bt-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="bt-nav"><a class="bt-nav-link" href="/rank">${tr(en, '排行榜')}</a><a class="bt-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="bt-title bt-page-title">${en ? 'Membership' : '会员中心'}</h1>
  <p class="bt-page-sub">${d.member ? (en ? 'Points, comments and members-only posts live here' : '留言、常回来，积分与专属内容都在这里') : en ? 'Log in or create an account to join' : '登录或注册，加入本站会员'}</p>
  <main class="bt-member">${d.member ? memberCardHtml(d.member, en) : memberAuthHtml(en)}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export { id, css }
