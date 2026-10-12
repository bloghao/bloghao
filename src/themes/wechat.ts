import type { SettingsMap } from '../types'
import type { PostSort } from '../db'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,
  fmtDateCN,
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
import css from './wechat.css'

const id = 'wechat'

/** 页脚公共件：八个页面只差链接组，文案与结构统一在这里 */
function foot(s: SettingsMap, links: string): string {
  const en = isEn(s)
  return `<footer class="wx-footer">${footCardHtml(s, en)}${esc(tr(en, s.footerText || ''))}<span class="wx-footer-links">${footLinks(s, links)}</span></footer>`
}
/** 页脚链接组：微博/留言板/友情链接/关于我已进顶栏（compact 收窄后页脚不再重复），页脚只留次级入口（排行随会员开关，纯微博不出「随机」，与顶栏同口径） */
function footLinksFor(s: SettingsMap, en: boolean): { home: string; archive: string; article: string; about: string } {
  const rank = s.membersEnabled === '1' ? `<a href="/rank">${tr(en, '排行榜')}</a>` : ''
  const random = siteMode(s) === 'weibo' ? '' : `<a href="/random">${tr(en, '随机')}</a>`
  const secondary = `${rank}${random}`
  const admin = `<a href="/admin">${en ? 'Admin' : '管理'}</a>`
  const rss = '<a href="/rss.xml">RSS</a>'
  const back = `<a href="/">${en ? 'Home' : '回主页'}</a>`
  return {
    home: `${secondary}${rss}${admin}`,
    archive: `${back}${secondary}${rss}${admin}`,
    article: `${back}${secondary}${admin}`,
    about: `${back}${secondary}${admin}`,
  }
}

/** 桌面端侧栏公共卡（首页话题/分类、文章页目录/文章信息共用一张卡面） */
function sideCard(title: string, sub: string, body: string): string {
  return `<section class="wx-side-card"><h2 class="wx-side-title">${title}${sub ? `<span class="wx-side-sub">${sub}</span>` : ''}</h2>${body}</section>`
}

/** 站点头像：设置过 avatarUrl 用图片，否则退回站名首字 */
function avatar(s: SettingsMap): string {
  if (s.avatarUrl) {
    return `<img class="wx-avatar wx-avatar-img" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">`
  }
  const en = isEn(s)
  const ch = (s.siteName || (en ? 'B' : '博')).trim().charAt(0) || (en ? 'B' : '博')
  return `<span class="wx-avatar" aria-hidden="true">${esc(ch)}</span>`
}

/** 刊头搜索框：微博卡与文章列表之间（分类、话题收进顶部导航的折叠菜单） */
function searchForm(q: string | undefined, en: boolean): string {
  return `<form class="wx-search" action="/search" method="get" role="search">
  <svg class="wx-search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>
  <input class="wx-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="${en ? 'Search posts…' : '搜一搜站内的文章…'}" maxlength="60" aria-label="${en ? 'Search posts' : '搜索文章'}">
  <button class="wx-search-btn" type="submit">${en ? 'Search' : '搜索'}</button>
</form>`
}

/** 桌面端首页侧栏（≥1024px 显示，移动端 CSS 隐藏）：话题云 + 分类，数据都是 HomeData 现成的；两块都空不出侧栏 */
function homeSide(d: HomeData, en: boolean): string {
  const tagChips = d.tags
    .slice(0, 14)
    .map((t) => `<a class="wx-side-chip" href="${tagLink(t.name)}">${esc(tr(en, t.name))}<i>${t.count}</i></a>`)
    .join('')
  const catRows = d.categories
    .slice(0, 10)
    .map((c) => `<a class="wx-side-row" href="${categoryLink(c)}">${esc(tr(en, c.name))}</a>`)
    .join('')
  if (!tagChips && !catRows) return ''
  const total = en ? `${d.total} ${plural(d.total, 'post', 'posts')}` : `共 ${d.total} 篇`
  const cards: string[] = []
  if (tagChips) cards.push(sideCard(tr(en, '话题'), total, `<div class="wx-side-chips">${tagChips}</div>`))
  if (catRows) cards.push(sideCard(tr(en, '分类'), '', `<div class="wx-side-rows">${catRows}</div>`))
  return cards.join('\n')
}

export function home(d: HomeData): string {
  const s = d.settings
  const en = isEn(s)
  const items = d.posts
    .map((p) => {
      const date = en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)
      const meta: string[] = []
      if (p.readingMinutes) meta.push(en ? `${p.readingMinutes} min read` : `${p.readingMinutes} 分钟`)
      if (p.views > 0) meta.push(en ? `${p.views} views` : `${p.views} 次阅读`)
      if (p.commentCount) meta.push(en ? `${p.commentCount} ${plural(p.commentCount, 'comment', 'comments')}` : `${p.commentCount} 条留言`)
      const dateHtml = date
        ? `<time class="wx-post-date" datetime="${date}">${date.replace(/-/g, '.')}</time>`
        : `<span class="wx-post-date">${en ? fmtDateEn(p.published_at) : fmtDateCN(p.published_at)}</span>`
      const metaHtml =
        p.pinned || meta.length
          ? `<p class="wx-post-meta">${p.pinned ? `<b class="wx-pin">${tr(en, '置顶')}</b>` : ''}${
              meta.length ? `<span>${meta.join(' · ')}</span>` : ''
            }</p>`
          : ''
      return `<a class="wx-post" href="/post/${esc(p.slug)}">
  ${dateHtml}
  <div class="wx-post-main">
    <h2 class="wx-post-title">${esc(p.title)}</h2>
    ${p.summary ? `<p class="wx-post-abs">${esc(p.summary)}</p>` : ''}
    ${metaHtml}
  </div>
  ${p.cover ? `<span class="wx-post-thumb"><img src="${esc(p.cover)}" loading="lazy" alt=""></span>` : ''}
</a>`
    })
    .join('\n')

  const side = homeSide(d, en)
  return `<div class="wx-page${side ? ' wx-page-wide' : ''}">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="wx-masthead">
    ${avatar(s)}
    <h1 class="wx-masthead-name">${esc(tr(en, s.siteName))}</h1>
    ${s.siteDescription ? `<p class="wx-masthead-desc">${esc(tr(en, s.siteDescription))}</p>` : ''}
  </header>
  ${d.notice ? `<div class="wx-notice">${d.notice}</div>` : ''}
  ${d.newSite ? newSiteGuideHtml(en) : ''}
  ${side ? `<div class="wx-cols"><div class="wx-maincol">` : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: avatar(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo, en }) : ''}
  ${onThisDayCard(d.onThisDay, en)}
  ${searchForm(d.q, en)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }, en)}
  <main class="wx-feed">
    ${items || `<p class="wx-empty">${d.emptyText || (en ? 'No posts yet — write your first one in the admin.' : '还没有文章，快去后台写下第一篇吧。')}</p>`}
  </main>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  }, en)}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: avatar(s) }) : ''}
  ${side ? `</div><aside class="wx-side">${side}</aside></div>` : ''}
  ${foot(s, footLinksFor(s, en).home)}
</div>`
}

export function post(d: PostData): string {
  const s = d.settings
  const en = isEn(s)
  const p = d.post
  // 目录数据来自 pages.ts headingAnchors 注入的标题锚点（toc-N id 已在 contentHtml 里）
  const tocItems = d.headings || []
  const tagChips = p.tags
    .map((t) => `<a class="wx-tag" href="${tagLink(t)}"># ${esc(t)}</a>`)
    .join('')
  const catChip = d.category ? `<a class="wx-tag wx-cat" href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''
  const related = d.related.length
    ? `<section class="wx-related">
  <h2 class="wx-related-title">${en ? 'More like this' : '喜欢此内容的人还喜欢'}</h2>
  <div class="wx-related-grid">
    ${d.related
      .map(
        (r) => `<a class="wx-related-item" href="/post/${esc(r.slug)}">
  ${r.cover ? `<div class="wx-related-cover"><img src="${esc(r.cover)}" loading="lazy" alt=""></div>` : ''}
  <h3>${esc(r.title)}</h3><span>${en ? fmtDateEn(r.published_at) : fmtDateCN(r.published_at)}</span>
</a>`
      )
      .join('')}
  </div>
</section>`
    : ''
  // 桌面端右栏：目录（≥2 条标题才值得挂）+ 文章信息卡；移动端 CSS 隐藏，版式不变
  const tocCard =
    tocItems.length >= 2
      ? sideCard(
          tr(en, '目录'),
          '',
          `<nav class="wx-toc">${tocItems
            .map((i) => `<a class="wx-toc-lv${i.level}" href="#${i.id}">${i.text}</a>`)
            .join('')}</nav>`
        )
      : ''
  const infoRows = [
    d.category
      ? `<div class="wx-side-row"><span>${tr(en, '分类')}</span><a href="${categoryLink(d.category)}">${esc(d.category.name)}</a></div>`
      : '',
    `<div class="wx-side-row"><span>${tr(en, '发布于')}</span><b>${en ? fmtDateEn(p.published_at) : fmtDateCN(p.published_at)}</b></div>`,
    `<div class="wx-side-row"><span>${tr(en, '阅读时长')}</span><b>${en ? `${p.readingMinutes} min` : `${p.readingMinutes} 分钟`}</b></div>`,
    `<div class="wx-side-row"><span>${tr(en, '阅读量')}</span><b>${p.views}</b></div>`,
  ]
    .filter(Boolean)
    .join('')
  const side = `${tocCard}${sideCard(tr(en, '文章信息'), '', `<div class="wx-side-rows">${infoRows}</div>`)}`

  return `<div class="wx-article wx-article-wide">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, en })}
  <div class="wx-cols"><div class="wx-maincol">
  <h1 class="wx-title">${esc(p.title)}</h1>
  <div class="wx-meta">
    <a class="wx-meta-avatar" href="/" aria-label="${en ? 'Back to home' : '返回首页'}">${avatar(s)}</a>
    <div class="wx-meta-main">
      <a class="wx-account" href="/">${esc(tr(en, s.siteName))}</a>
      <span class="wx-date">${en ? `${fmtDateEn(p.published_at)} · ${p.readingMinutes} min read` : `${fmtDateCN(p.published_at)} · ${p.readingMinutes} 分钟`}</span>
    </div>
  </div>
  ${p.cover ? `<div class="wx-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
  <article class="rich" id="rich-content">${p.contentHtml}</article>
  ${p.locked ? paywallHtml(p.minTier, en) : ''}
  ${tagChips || catChip ? `<div class="wx-tags">${catChip}${tagChips}</div>` : ''}
  <div class="wx-actions">
    ${likesBtn(p.slug, p.likes, en)}
    <a class="wx-action" href="#comments">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M21 11.5c0 4.1-4 7.5-9 7.5-1 0-2-.1-2.9-.4L4 20l1.2-3.2C3.8 15.4 3 13.5 3 11.5 3 7.4 7 4 12 4s9 3.4 9 7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      ${tr(en, '留言')} <b data-count>${d.comments.count}</b>
    </a>
    ${d.share ? shareBtn(d.share.url, d.share.qr, en) : ''}
  </div>
  ${related}
  ${postNeighborsHtml(d.prev, d.next, en)}
  ${d.comments.html}
  </div><aside class="wx-side">${side}</aside></div>
  ${foot(s, footLinksFor(s, en).article)}
</div>`
}

export function about(d: AboutData): string {
  const en = isEn(d.settings)
  return `<div class="wx-article">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <h1 class="wx-title">${tr(en, '关于我')}</h1>
  <div class="wx-meta"><a class="wx-meta-avatar" href="/" aria-label="${en ? 'Back to home' : '返回首页'}">${avatar(d.settings)}</a>
    <div class="wx-meta-main"><a class="wx-account" href="/">${esc(tr(en, d.settings.siteName))}</a></div>
  </div>
  <article class="rich">${d.contentHtml}</article>
  ${foot(d.settings, footLinksFor(d.settings, en).about)}
</div>`
}

/** 独立页面页（/page/:slug，slug='about' 时渲染 /about）：结构同关于我，标题由页面数据决定 */
export function page(d: PageData): string {
  const en = isEn(d.settings)
  return `<div class="wx-article">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <h1 class="wx-title">${esc(d.title)}</h1>
  <article class="rich">${d.contentHtml}</article>
  ${foot(d.settings, footLinksFor(d.settings, en).about)}
</div>`
}

/** 文章归档页：全部文章按年份分组，日期外置的细线列表 */
export function archives(d: ArchivesData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${tr(en, '归档')}</h1>
    <p class="wb-page-sub">${d.total > 0 ? (en ? `Everything written here · ${d.total} ${plural(d.total, 'post', 'posts')} in all` : `写下的每一篇 · 共 ${d.total} 篇`) : en ? 'Every post lands here.' : '写下的每一篇都会收进这里'}${yearStatsSuffix(d.yearStats, en)}</p>
  </header>
  ${heatmapHtml(d.heatmap, en)}
  <main class="wx-archives">${archiveListHtml(d.groups, en) || `<p class="wb-empty">${en ? 'No posts yet — write your first one in the admin.' : '还没有文章，去后台写下第一篇吧。'}</p>`}</main>
  ${foot(s, footLinksFor(s, en).archive)}
</div>`
}

/** 留言板页：独立留言墙（复用 .cmt-* 结构与样式） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${tr(en, '留言板')}</h1>
    <p class="wb-page-sub">${d.count > 0 ? (en ? `${d.count} ${plural(d.count, 'message', 'messages')} so far · say anything` : `已有 ${d.count} 条留言 · 随便聊聊`) : en ? 'Write whatever you would like to say' : '想说点什么，就在这里写下来'}</p>
  </header>
  <main class="wx-guestbook">${d.html}</main>
  ${foot(s, footLinksFor(s, en).archive)}
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
    avatarHtml: avatar(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${tr(en, '微博')}</h1>
    <p class="wb-page-sub">${d.topic ? (en ? `Topic #${esc(d.topic)} · ${d.total} ${plural(d.total, 'note', 'notes')}` : `话题 #${esc(d.topic)} · 共 ${d.total} 条`) : d.total > 0 ? (en ? `Notes · ${d.total} ${plural(d.total, 'note', 'notes')} in total` : `随手记 · 共 ${d.total} 条`) : en ? 'Short notes — write as you please' : '随手记，想写就写'}</p>
  </header>
  ${topicBar}
  ${composer}
  <main class="wb-list">
    ${cards || `<p class="wb-empty">${d.adminName ? (en ? 'No notes yet — post the first one above.' : '还没有微博，在上面发第一条吧。') : en ? 'No notes yet.' : '还没发过微博，去后台随手写一条吧。'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic, en)}
  ${foot(s, footLinksFor(s, en).archive)}
</div>`
}

/** 友情链接页：友链卡片 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'links', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${tr(en, '友情链接')}</h1>
    <p class="wb-page-sub">${d.total > 0 ? (en ? `Friend sites · ${d.total} ${plural(d.total, 'link', 'links')} in all` : `朋友站点 · 共 ${d.total} 个`) : en ? 'A place to trade links with friends' : '和朋友交换链接的地方'}</p>
  </header>
  <main class="fl-grid">
    ${friendLinkCards(d.items, en) || (en ? '<p class="wb-empty">No links yet — add some in the admin, or submit yours below.</p>' : '<p class="wb-empty">还没有友链，去后台添加，或在下方申请收录。</p>')}
  </main>
  ${friendLinkApply(en)}
  ${foot(s, footLinksFor(s, en).archive)}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${tr(en, '排行榜')}</h1>
    <p class="wb-page-sub">${d.total > 0 ? (en ? `All-time points board · ${d.total} ${plural(d.total, 'member', 'members')}` : `会员积分总榜 · 共 ${d.total} 位`) : en ? 'Comment and come back often to make the board' : '发留言、常回来，就能上榜'}</p>
  </header>
  <main class="wx-rank">${rankListHtml(d.entries, en) || (en ? '<p class="wb-empty">No members on the board yet — claim the top spot.</p>' : '<p class="wb-empty">还没有会员上榜，抢个头名吧。</p>')}</main>
  ${foot(s, footLinksFor(s, en).archive)}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="wx-page">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: s.membersEnabled === '1', cls: 'wx-snav', compact: true, sticky: true, categories: d.categories, tags: d.tags, pages: d.pages, active: 'member', en })}
  <header class="wb-page-head">
    <h1 class="wb-page-title">${en ? 'Membership' : '会员中心'}</h1>
    <p class="wb-page-sub">${d.member ? (en ? 'Points, comments and members-only posts live here' : '留言、常回来，积分与专属内容都在这里') : en ? 'Log in or create an account to join' : '登录或注册，加入本站会员'}</p>
  </header>
  <main class="wx-member">${d.member ? memberCardHtml(d.member, en) : memberAuthHtml(en)}</main>
  ${foot(s, footLinksFor(s, en).archive)}
</div>`
}

export { id, css }
