import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import type { ThemeModule } from '../src/themes/registry.ts'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, RankData, WeiboData } from '../src/themes/registry.ts'
import type { HomePostView, MemberView, RankEntryView, WeiboItemView, ArchiveYearGroup, FriendLinkView, CategoryLink, TagCount } from '../src/render.ts'
import type { CommentRow } from '../src/types.ts'
import { commentsHtml, headingAnchors, heatmapHtml, memberCardHtml, postNeighborsHtml, rankListHtml } from '../src/render.ts'
import { esc } from '../src/utils.ts'
import { packMatrix, qrMatrix } from '../src/qrcode.ts'

// 主题模块 import 了 .css（wrangler 部署走 Text rule）——测试环境先用 hook 顶替，再动态加载注册表
register('./tests/css-loader.mjs', pathToFileURL(`${process.cwd()}/`))
const { THEMES } = await import('../src/themes/registry.ts')

// ── 五套主题 × 八类页面渲染回归：任何主题任何页面函数抛错/漏关键结构都会在这里炸 ──
// 页脚由各主题 foot() 公共件渲染，本测试同时守着「八页页脚一个不少」

const settings = {
  siteName: '测试站',
  siteDescription: '一句话描述',
  siteUrl: '',
  footerText: '© 测试站',
  avatarUrl: '',
  pluginsDisabled: '',
}

const TS = 1_700_000_000_000
const cat: CategoryLink = { name: '分类', slug: 'cat' }
const tags: TagCount[] = [
  { name: '生活', count: 3 },
  { name: '技术', count: 1 },
]
const postView: HomePostView = {
  slug: 'hello',
  title: '你好世界',
  summary: '这是摘要',
  cover: '/images/u/a.png',
  tags: ['生活'],
  published_at: TS,
  views: 12,
  likes: 2,
  pinned: false,
  commentCount: 1,
  readingMinutes: 3,
}
const weiboView: WeiboItemView = {
  id: 7,
  content: '随手记一条 #话题#',
  images: ['/images/u/b.png'],
  created_at: TS,
  likes: 1,
  commentCount: 0,
}
const groups: ArchiveYearGroup[] = [{ year: 2026, count: 1, items: [{ slug: 'hello', title: '你好世界', ts: TS }] }]
const friend: FriendLinkView = { name: '朋友', url: 'https://example.com', description: '朋友的站', icon: '' }
const pages = [{ title: '关于页面', href: '/page/about-page', key: 'p:about-page' }]

const homeData = (): HomeData => ({
  settings,
  posts: [postView],
  page: 1,
  totalPages: 1,
  total: 1,
  tags,
  categories: [cat],
  pages,
  weibo: { items: [weiboView], total: 1 },
  onThisDay: null,
})
const postData = (): PostData => ({
  settings,
  post: {
    slug: 'hello',
    title: '你好世界',
    contentHtml: '<p>正文</p>',
    summary: '这是摘要',
    cover: '/images/u/a.png',
    tags: ['生活'],
    published_at: TS,
    views: 12,
    likes: 2,
    readingMinutes: 3,
  },
  category: cat,
  categories: [cat],
  pages,
  tags,
  comments: { html: '<ul class="cmt-list"></ul>', count: 1 },
  related: [postView],
})
const aboutData = (): AboutData => ({ settings, contentHtml: '<p>关于</p>', categories: [cat], pages, navActive: 'about' })
const pageData = (): PageData => ({ settings, title: '自建页', contentHtml: '<p>页面</p>', categories: [cat], pages, navActive: 'p:about-page' })
const archivesData = (): ArchivesData => ({ settings, categories: [cat], pages, total: 1, groups })
const guestbookData = (): GuestbookData => ({ settings, categories: [cat], pages, html: '<div class="gb"></div>', count: 1 })
const weiboData = (): WeiboData => ({
  settings,
  categories: [cat],
  pages,
  tags,
  items: [weiboView],
  page: 1,
  totalPages: 1,
  total: 1,
  allowComments: true,
  adminName: '作者',
  topics: [{ name: '话题', count: 1 }],
})
const linksData = (): LinksData => ({ settings, categories: [cat], pages, items: [friend], total: 1 })

/* 会员 / 排行榜（B 序列 fixture：数据形状见 DEVPLAN-2026-10-07 附录 A） */
const memberView: MemberView = { nickname: '小张', tier: 'coffee', points: 42, createdAt: TS }
const rankEntries: RankEntryView[] = [
  { rank: 1, nickname: '小张', tier: 'coffee', points: 42 },
  { rank: 2, nickname: '阿李', tier: 'normal', points: 18, isMe: true },
]
const memberData = (): MemberData => ({ settings, categories: [cat], pages, navActive: 'member', member: null })
const rankData = (): RankData => ({ settings, categories: [cat], pages, navActive: 'rank', entries: rankEntries, total: 2, me: rankEntries[1] })

/** 每个页面函数的冒烟断言：能渲染 + 页脚 + 导航都在。
 *  页脚链接组按页面类型有变体（部分页面无 RSS），由各主题 foot() 公共件统一承载 */
function checkPage(themeId: string, name: string, html: string): void {
  assert.ok(typeof html === 'string' && html.length > 200, `${themeId}.${name} 应渲染出实质 HTML`)
  assert.ok(html.includes('footer'), `${themeId}.${name} 应含页脚`)
  assert.ok(html.includes(settings.siteName), `${themeId}.${name} 应含站名`)
}

for (const [themeId, theme] of Object.entries(THEMES as Record<string, ThemeModule>)) {
  test(`${themeId}: 模块元数据完整`, () => {
    assert.equal(theme.id, themeId)
    assert.ok(theme.name && theme.description)
    // css 在 Node 测试环境被 loader 顶替为空串（部署侧由 wrangler Text rule 注入真实内容）
    assert.equal(typeof theme.css, 'string')
  })

  test(`${themeId}: home 渲染`, () => {
    const d = homeData()
    const html = theme.home(d)
    checkPage(themeId, 'home', html)
    assert.ok(html.includes('rss.xml'))
    assert.ok(html.includes(postView.title))
  })

  test(`${themeId}: home 渲染（微博+博客模式：微博流先行）`, () => {
    const d = homeData()
    d.weibo = null // 微博流模式下入口卡由服务端省略，两份数据互斥
    d.weiboFeed = { items: [weiboView], total: 12, allowComments: true, adminName: '站长' }
    const html = theme.home(d)
    checkPage(themeId, 'home(weiboFeed)', html)
    assert.ok(html.includes('wb-home-feed'), `${themeId} home 应渲染微博流容器`)
    assert.ok(html.includes('wb-card'), `${themeId} home 应渲染完整微博卡片`)
    assert.ok(html.includes(`id="wb-${weiboView.id}"`))
    assert.ok(html.includes('共 12 条'))
    assert.ok(html.includes('wb-home-head'))
    // 纯博客模式：入口卡与微博流都不出现
    const blogOnly = theme.home({ ...homeData(), weibo: null })
    assert.ok(!blogOnly.includes('wb-home'))
  })

  test(`${themeId}: home 渲染（搜索页微博结果区，ROADMAP B4）`, () => {
    const d = homeData()
    d.searchWeibo = { items: [weiboView], total: 3 }
    const html = theme.home(d)
    checkPage(themeId, 'home(searchWeibo)', html)
    assert.ok(html.includes('wb-home-feed'), `${themeId} search 应渲染微博结果区容器`)
    assert.ok(html.includes('wb-card'), `${themeId} search 应渲染微博卡片`)
    assert.ok(html.includes('命中 3 条'), `${themeId} 应渲染命中计数（与首页微博流的「共 N 条」区分）`)
    // 未命中：结果区（aria-label 微博搜索结果）不出现
    const none = theme.home({ ...homeData(), searchWeibo: null })
    assert.ok(!none.includes('微博搜索结果'))
  })

  test(`${themeId}: post 渲染（正文/点赞/评论区）`, () => {
    const html = theme.post(postData())
    checkPage(themeId, 'post', html)
    assert.ok(html.includes('<p>正文</p>'))
    assert.ok(html.includes('like-btn'))
    assert.ok(html.includes('cmt-list'))
    // 未传 share 不渲染分享按钮
    assert.ok(!html.includes('share-btn'), `${themeId}.post 无 share 数据时不应渲染分享按钮`)
    // 上一篇/下一篇：传了才渲染（结构由 render.ts postNeighborsHtml 共享，样式各主题 .pn-*）
    const withPn = theme.post({ ...postData(), prev: { slug: 'older-post', title: '上一次的旅行' }, next: { slug: 'newer-post', title: '下一次的旅行' } })
    assert.ok(withPn.includes('pn-nav'), `${themeId}.post 传 prev/next 应渲染相邻导航`)
    assert.ok(withPn.includes('href="/post/older-post"'))
    assert.ok(withPn.includes('上一次的旅行'))
    assert.ok(!withPn.includes('pn-empty'), '两侧都有时无占位空格')
    assert.ok(!html.includes('pn-nav'), `${themeId}.post 未传 prev/next 不渲染相邻导航`)
  })

  test(`${themeId}: post 渲染分享按钮（canonical 链接 + QR 矩阵位串无损下发）`, () => {
    const d = postData()
    d.share = { url: 'https://blog.xiaowuleyi.com/post/hello?a=1&b=2', qr: packMatrix(qrMatrix('https://blog.xiaowuleyi.com/post/hello')!) }
    const html = theme.post(d)
    checkPage(themeId, 'post+share', html)
    assert.ok(html.includes('class="share-btn"'), '应渲染 share-btn')
    assert.ok(html.includes('data-share-url="https://blog.xiaowuleyi.com/post/hello?a=1&amp;b=2"'), '链接应转义下发')
    const m = / data-share-qr="([A-Za-z0-9+/=]+)"/.exec(html)
    assert.ok(m, '应带 QR 位串')
    // 位串还原回矩阵应与原矩阵一致（行主序、首字节边长）
    const bin = Buffer.from(m![1], 'base64')
    const origin = qrMatrix('https://blog.xiaowuleyi.com/post/hello')!
    assert.equal(bin[0], origin.length)
    let k = 0
    for (let r = 0; r < origin.length; r++)
      for (let c = 0; c < origin.length; c++) {
        assert.equal((bin[1 + (k >> 3)] >> (7 - (k & 7))) & 1, origin[r][c] ? 1 : 0)
        k++
      }
  })

  test(`${themeId}: post 渲染付费墙遮挡卡（locked）`, () => {
    const d = postData()
    d.post.locked = true
    d.post.minTier = 'coffee'
    const html = theme.post(d)
    checkPage(themeId, 'post+locked', html)
    assert.ok(html.includes('class="paywall"'), 'locked 时应渲染付费墙遮挡卡')
    assert.ok(html.includes('咖啡会员专属内容'), '遮挡文案随档位')
    assert.ok(html.includes('href="/member"'), 'CTA 指向会员中心')
    assert.ok(html.includes('<p>正文</p>'), '试读段照常渲染')
    const top = theme.post({ ...d, post: { ...d.post, minTier: 'top' } })
    assert.ok(top.includes('顶级会员专属内容'), 'top 档位切换文案')
    const mem = theme.post({ ...d, post: { ...d.post, minTier: 'member' } })
    assert.ok(mem.includes('会员专属内容'), 'member 档位文案（契约 A0 四档）')
    assert.ok(!theme.post(postData()).includes('class="paywall"'), '未锁定不出遮挡卡')
  })

  test(`${themeId}: about 与 page 渲染（标题区分）`, () => {
    const about = theme.about(aboutData())
    const page = theme.page(pageData())
    checkPage(themeId, 'about', about)
    checkPage(themeId, 'page', page)
    assert.ok(about.includes('关于我'))
    assert.ok(page.includes('自建页'))
  })

  test(`${themeId}: archives 渲染`, () => {
    const html = theme.archives(archivesData())
    checkPage(themeId, 'archives', html)
    assert.ok(html.includes('你好世界'))
    // 「今年已写」统计后缀：传 yearStats 时出现（七主题同一段共享后缀），不传时不出声
    const withStats = theme.archives({ ...archivesData(), yearStats: { count: 3, chars: 23456 } })
    assert.ok(withStats.includes('今年已写 3 篇'))
    assert.ok(withStats.includes('约 2.3 万字'))
    assert.ok(!html.includes('今年已写'), '未传 yearStats 不产生该后缀')
    // 创作热力图：传了才渲染（结构共享 render.ts heatmapHtml，色阶走各主题 accent 透明度）
    const withHm = theme.archives({ ...archivesData(), heatmap: { days: [{ day: '2026-10-01', count: 2 }], total: 2 } })
    assert.ok(withHm.includes('hm-grid'), `${themeId}.archives 传 heatmap 应渲染热力图`)
    assert.ok(withHm.includes('hm-l2'), 'count=2 落第二档色阶')
    assert.ok(!html.includes('hm-grid'), `${themeId}.archives 未传 heatmap 不渲染热力图`)
  })

  test(`${themeId}: guestbook 渲染`, () => {
    const html = theme.guestbook(guestbookData())
    checkPage(themeId, 'guestbook', html)
    assert.ok(html.includes('gb'))
  })

  test(`${themeId}: weibo 渲染（卡片+发布器）`, () => {
    const html = theme.weibo(weiboData())
    checkPage(themeId, 'weibo', html)
    assert.ok(html.includes('wb-card'), `${themeId} 微博页应含卡片`)
    assert.ok(html.includes('wb-composer'), '管理员可见发布器')
  })

  test(`${themeId}: links 渲染`, () => {
    const html = theme.links(linksData())
    checkPage(themeId, 'links', html)
    assert.ok(html.includes('example.com'))
  })

  test(`${themeId}: rank 渲染（榜单行/名次标记/空态）`, () => {
    const html = theme.rank!(rankData())
    checkPage(themeId, 'rank', html)
    assert.ok(html.includes('rk-list'), '应渲染榜单列表')
    assert.ok(html.includes('小张'))
    assert.ok(html.includes('咖啡会员'), '档位应转成中文标签')
    assert.ok(html.includes('2 位'), '页头应带上榜总数（各主题文案措辞不同，只断数量片段）')
    assert.ok(html.includes('is-top1'), '第一名应有 top1 标记')
    assert.ok(html.includes('is-me'), '本人行应带 is-me 标记')
    const empty = theme.rank!({ ...rankData(), entries: [], total: 0, me: null })
    assert.ok(!empty.includes('rk-list'), '空榜不渲染列表，出空态文案')
  })

  test(`${themeId}: member 渲染（未登录表单/已登录会员卡）`, () => {
    const anon = theme.member!(memberData())
    checkPage(themeId, 'member(anon)', anon)
    assert.ok(anon.includes('data-member-form="login"'), '未登录应有登录表单')
    assert.ok(anon.includes('data-member-form="register"'), '未登录应有注册表单')
    assert.ok((anon.match(/class="cmt-hp"/g) || []).length >= 2, '两个表单都要带蜜罐字段')
    const loggedIn = theme.member!({ ...memberData(), member: memberView })
    checkPage(themeId, 'member(logged)', loggedIn)
    assert.ok(loggedIn.includes('data-member-card'), '已登录应渲染会员卡')
    assert.ok(loggedIn.includes('小张'))
    assert.ok(loggedIn.includes('data-member-logout'), '会员卡应有退出按钮')
    assert.ok(!loggedIn.includes('data-member-form'), '已登录不再渲染登录/注册表单')
  })

  test(`${themeId}: home 无排行挂件（榜单收敛到 /rank 页，不再占首页卡片位）`, () => {
    const html = theme.home(homeData())
    assert.ok(!html.includes('rk-card'), '首页不渲染排行挂件')
    assert.ok(!html.includes('rk-list'), '首页无榜单列表')
    assert.ok(!html.includes('完整榜单'), '首页无榜单入口')
  })

  test(`${themeId}: weibo 评论表单带会员身份（memberName 免填昵称）`, () => {
    const html = theme.weibo({ ...weiboData(), adminName: undefined, memberName: '小张' })
    checkPage(themeId, 'weibo(member)', html)
    assert.ok(html.includes('以会员 <b>小张</b>'), '会员身份行应渲染')
    assert.ok(!html.includes('name="nickname"'), '会员表单免填昵称')
  })

  test(`${themeId}: page 未实现时运行时兜底由 pages.ts 负责（本主题已实现）`, () => {
    assert.equal(typeof theme.page, 'function')
  })
}

test('getTheme：未知主题回退 wechat（hasOwnProperty 挡原型链）', async () => {
  const { getTheme } = await import('../src/themes/registry.ts')
  assert.equal(getTheme('nope').id, 'wechat')
  assert.equal(getTheme('constructor').id, 'wechat')
})

// ── 评论头像（C2）：评论头像位 / 排行榜头像位 / 会员中心 QQ 绑定卡 ──

const cmt = (over: Partial<CommentRow>): CommentRow => ({
  id: 1,
  post_id: 1,
  weibo_id: 0,
  parent_id: 0,
  is_admin: 0,
  nickname: '游客甲',
  email: '',
  website: '',
  content: '留言内容',
  status: 'approved',
  ip: '',
  created_at: TS,
  ...over,
})

test('评论头像位：会员出站内头像图，游客与未绑头像的会员退回昵称首字块', () => {
  const html = commentsHtml({
    comments: [
      cmt({ id: 1, member_avatar: '/images/u/202610/a.png' }),
      cmt({ id: 2, nickname: '游客甲' }),
      cmt({ id: 3, nickname: '小明', member_name: '小明', member_tier: 'normal' }),
    ],
    slug: 'hello',
    allowComments: true,
    count: 3,
  })
  assert.match(html, /<img class="cmt-avatar cmt-avatar-img" src="\/images\/u\/202610\/a\.png"/)
  assert.match(html, /<span class="cmt-avatar" aria-hidden="true">游<\/span>/)
  assert.match(html, /<span class="cmt-avatar" aria-hidden="true">小<\/span>/)
})

test('评论头像位：作者（管理员）评论用站点头像，未设置站点头像退回首字块', () => {
  const withAvatar = commentsHtml({
    comments: [cmt({ id: 1, is_admin: 1, nickname: '站长' })],
    slug: 'hello',
    allowComments: true,
    count: 1,
    adminAvatar: '/images/u/site.png',
  })
  assert.match(withAvatar, /<img class="cmt-avatar cmt-avatar-img" src="\/images\/u\/site\.png"/)
  assert.doesNotMatch(withAvatar, /<span class="cmt-avatar" aria-hidden="true">站<\/span>/, '有站点头像不再落首字块')
  // 会员头像优先于站点头像（is_admin 评论不会有 member_avatar，此条守优先级不回归）
  const both = commentsHtml({
    comments: [cmt({ id: 1, is_admin: 1, nickname: '站长', member_avatar: '/images/u/m.png' })],
    slug: 'hello',
    allowComments: true,
    count: 1,
    adminAvatar: '/images/u/site.png',
  })
  assert.match(both, /src="\/images\/u\/m\.png"/)
  const noAvatar = commentsHtml({
    comments: [cmt({ id: 1, is_admin: 1, nickname: '站长' })],
    slug: 'hello',
    allowComments: true,
    count: 1,
  })
  assert.match(noAvatar, /<span class="cmt-avatar" aria-hidden="true">站<\/span>/, '没设站点头像维持首字块')
})

test('评论区楼层与楼主：顶层评论带 #N 楼层号，作者徽标文章语境叫楼主、留言板沿用作者，楼中楼不占号', () => {
  const html = commentsHtml({
    comments: [
      cmt({ id: 1, nickname: '游客甲' }),
      cmt({ id: 2, is_admin: 1, nickname: '站长', parent_id: 1 }),
      cmt({ id: 3, nickname: '游客乙' }),
      cmt({ id: 9, nickname: '孤儿', parent_id: 999 }),
    ],
    slug: 'hello',
    allowComments: true,
    count: 4,
    adminAvatar: '/images/u/site.png',
  })
  assert.match(html, /cmt-floor"[^>]*>#1</, '顶层评论按序编楼层')
  assert.match(html, /cmt-floor"[^>]*>#2</)
  const kidsBlock = (html.split('<ul class="cmt-children">')[1] || '').split('</ul>')[0]
  assert.ok(kidsBlock.includes('cmt-2'), '切割到的是楼中楼块')
  assert.ok(!kidsBlock.includes('cmt-floor'), '楼中楼不占楼层号')
  assert.match(html, /cmt-badge">楼主</, '文章语境作者徽标 = 楼主')
  assert.ok(!html.includes('>作者<'), '文章语境不出「作者」字样徽标')
  // 孤儿回复按顶层展示也占楼层
  assert.match(html, /id="cmt-9"[\s\S]*?cmt-floor"[^>]*>#3</, '孤儿回复顶层层级占号')
  const gb = commentsHtml({
    comments: [cmt({ id: 1, is_admin: 1, nickname: '站长' })],
    slug: '',
    allowComments: true,
    count: 1,
    guestbook: true,
  })
  assert.match(gb, /cmt-badge">作者</, '留言板语境沿用作者徽标')
})

// site.js 是一个 IIFE，一处解析错误全站交互瘫痪（2026-10 实抓：三元缺 else 半个文件报废）——
// 全文件编译守卫，切片镜像测试拦不住的顶层语法错误在这里见红
test('site.js 全文件语法守卫：可编译（不执行），解析错误即全站交互瘫痪', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  assert.doesNotThrow(() => new Function(src), 'site.js 语法错误——全站交互瘫痪')
})

// site.js 的 renderWeiboComments.avatarHtml 是服务端 commentAvatarHtml 的 ES5 手工镜像（作者评论
// 头像走接口下发的 adminAvatar，游客自填 QQ 走行内 avatar）——把 site.js 源码切片在 Node 里执行，
// 头像位双端同态，漂移当场见红
test('site.js 微博评论头像镜像：会员图 / 作者站点头像 / 游客自填头像 / 首字块与服务端同态', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('function renderWeiboComments'), src.indexOf('function loadWeiboComments'))
  assert.ok(seg.includes('function renderWeiboComments') && seg.includes('adminAvatar'), 'site.js 切片失败：镜像段不在预期位置')
  // esc 注入服务端实现（两端语义一致）；fmtTime / wxqReplace 与头像位无关，stub 掉
  // EN / T 是英文测试版的前台文案开关（site.js 顶部定义，切片外的依赖）：镜像段按中文路径注入
  const factory = new Function('esc', 'fmtTime', 'wxqReplace', 'EN', 'T', seg + '\n;return renderWeiboComments')
  const render = factory(esc, (t: number) => String(t), (s: string) => s, false, (zh: string) => zh)
  const listEl = { innerHTML: '' }
  const rows = [
    { id: 1, parent_id: 0, is_admin: 0, nickname: '会员甲', content: '内容', created_at: TS, member_avatar: '/images/u/202610/a.png' },
    { id: 2, parent_id: 0, is_admin: 0, nickname: '游客甲', content: '内容', created_at: TS },
    { id: 3, parent_id: 0, is_admin: 1, nickname: '站长', content: '内容', created_at: TS },
    { id: 4, parent_id: 0, is_admin: 0, nickname: '游客乙', content: '内容', created_at: TS, avatar: '/images/u/guest.png' },
  ]
  render({ querySelector: () => listEl }, rows, false, '/images/u/site.png')
  assert.match(listEl.innerHTML, /<img class="wb-cmt-avatar wb-cmt-avatar-img" src="\/images\/u\/202610\/a\.png"/, '会员头像位')
  assert.match(listEl.innerHTML, /<img class="wb-cmt-avatar wb-cmt-avatar-img" src="\/images\/u\/site\.png"/, '作者评论用站点头像')
  assert.match(listEl.innerHTML, /<img class="wb-cmt-avatar wb-cmt-avatar-img" src="\/images\/u\/guest\.png"/, '游客自填 QQ 的站内转存头像位')
  assert.match(listEl.innerHTML, /<span class="wb-cmt-avatar" aria-hidden="true">游<\/span>/, '没填 QQ 的游客退首字块')
  // 楼层号与楼主徽标：与 SSR commentsHtml 同构（顶层 #1 起编、作者徽标微博语境叫楼主）
  assert.match(listEl.innerHTML, /wb-cmt-floor"[^>]*>#1</, '楼层号从 #1 起编')
  assert.match(listEl.innerHTML, /wb-cmt-floor"[^>]*>#4</, '四条顶层编到 #4')
  assert.match(listEl.innerHTML, /wb-cmt-badge">楼主</, '作者徽标微博语境 = 楼主')
  // 接口没带 adminAvatar（站点未设头像）时，作者评论退回首字块，与 SSR 同态
  listEl.innerHTML = ''
  render({ querySelector: () => listEl }, [rows[2]], false, '')
  assert.match(listEl.innerHTML, /<span class="wb-cmt-avatar" aria-hidden="true">站<\/span>/)
})

test('排行榜头像位：有 avatarUrl 出图，否则首字块', () => {
  const html = rankListHtml([
    { rank: 1, nickname: '小明', tier: 'top', points: 30, avatarUrl: '/images/u/a.png' },
    { rank: 2, nickname: '小红', tier: 'normal', points: 10 },
  ])
  assert.match(html, /<img class="rk-avatar rk-avatar-img" src="\/images\/u\/a\.png"/)
  assert.match(html, /<span class="rk-avatar" aria-hidden="true">小<\/span>/)
})

test('会员中心 QQ 绑定卡：本人视角出 value；绑了 qq 没抓到头像出重试态', () => {
  const bound = memberCardHtml({ nickname: '小明', tier: 'normal', points: 3, qq: '12345' })
  assert.match(bound, /data-member-qq-form/)
  assert.match(bound, /value="12345"/)
  assert.match(bound, /重试头像/, '有 qq 没头像 = 重试态')
  assert.match(bound, /头像还没抓到/, '绑定态提示与重试入口呼应')
  const withAvatar = memberCardHtml({ nickname: '小明', tier: 'normal', points: 3, qq: '12345', avatarUrl: '/images/u/a.png' })
  assert.match(withAvatar, /已绑定，头像会显示在评论区与排行榜/)
  assert.ok(!withAvatar.includes('重试头像'))
  const unbound = memberCardHtml({ nickname: '小明', tier: 'normal', points: 3 })
  assert.match(unbound, /不会公开展示/)
})

// ── 游客 QQ 头像（C2 扩展）：SSR 评论头像位认游客行内 avatar（站内转存地址），qq 本体不出参 ──

test('SSR 评论头像位：游客自填 QQ 的站内头像出图；与会员头像同现时会员优先', () => {
  const html = commentsHtml({
    comments: [
      cmt({ id: 11, nickname: '游客丙', avatar: '/images/u/202610/guest.png' }),
      cmt({ id: 12, nickname: '小明', member_name: '小明', member_tier: 'normal', member_avatar: '/images/u/m.png', avatar: '/images/u/old.png' }),
    ],
    slug: 'hello',
    allowComments: true,
    count: 2,
  })
  assert.match(html, /<img class="cmt-avatar cmt-avatar-img" src="\/images\/u\/202610\/guest\.png"/, '游客头像位')
  assert.match(html, /<img class="cmt-avatar cmt-avatar-img" src="\/images\/u\/m\.png"/, '会员头像优先于行内 avatar')
  assert.ok(!html.includes('/images/u/old.png'), '行内 avatar 被会员头像遮蔽时不输出')
  assert.ok(!/<img[^>]*src="12345"/.test(html), 'qq 本体永不进公开 HTML')
})

// ── 桌面端增强（wechat 主题先行：≥1024px 两栏布局 + 文章页目录栏；CSS 断点见 wechat.css 桌面段） ──

test('headingAnchors：给净化后正文 h2/h3 注入 toc-N 生成 id（pages.ts 统一调用，七主题受益）', () => {
  const out = headingAnchors('<h2>第一节</h2><p>内容</p><h3 class="k">子标题</h3><h2>第二节 &amp; 收尾</h2>')
  assert.equal(
    out.html,
    '<h2 id="toc-1">第一节</h2><p>内容</p><h3 class="k" id="toc-2">子标题</h3><h2 id="toc-3">第二节 &amp; 收尾</h2>',
    '原属性保留、id 注入、正文其余部分不动'
  )
  assert.deepEqual(
    out.items.map((i) => [i.level, i.id, i.text]),
    [
      [2, 'toc-1', '第一节'],
      [3, 'toc-2', '子标题'],
      [2, 'toc-3', '第二节 &amp; 收尾'],
    ],
    'text 是剥标签后的已转义片段（主题插入时不再 esc）'
  )
  assert.deepEqual(headingAnchors('<p>无标题</p>').items, [])
  assert.equal(headingAnchors('<p>无标题</p>').html, '<p>无标题</p>', '无标题正文原样返回')
  assert.deepEqual(headingAnchors('').items, [])
})

test('wechat 桌面增强：post 按 headings 渲染目录卡（锚点 id 由 pages.ts headingAnchors 注入）', () => {
  const d = postData()
  d.post.contentHtml = '<h2 id="toc-1">第一节</h2><p>内容</p><h3 id="toc-2">子标题</h3><h2 id="toc-3">第二节 &amp; 收尾</h2>'
  d.headings = [
    { level: 2, text: '第一节', id: 'toc-1' },
    { level: 3, text: '子标题', id: 'toc-2' },
    { level: 2, text: '第二节 &amp; 收尾', id: 'toc-3' },
  ]
  const html = THEMES.wechat.post(d)
  assert.ok(html.includes('wx-toc'), '应渲染目录卡')
  assert.ok(html.includes('<h2 id="toc-1">'), '正文里的锚点 id 原样保留')
  assert.ok(html.includes('<h3 id="toc-2">'))
  assert.ok(html.includes('href="#toc-1"'), '目录项链接指向锚点')
  assert.ok(html.includes('第一节'), '目录文本来自标题')
  const one = THEMES.wechat.post({ ...d, headings: d.headings!.slice(0, 1) })
  assert.ok(!one.includes('wx-toc'), '不足 2 条标题不出目录卡')
  assert.ok(!THEMES.wechat.post(postData()).includes('wx-toc'), '无 headings 不出目录卡（密码墙表单同理）')
})

test('wechat 桌面增强：home 有标签/分类时出侧栏，全空则退单栏', () => {
  const html = THEMES.wechat.home(homeData())
  assert.ok(html.includes('wx-side'), '应渲染侧栏')
  assert.ok(html.includes('wx-side-chip'), '话题云带计数')
  assert.ok(html.includes('/tag/%E7%94%9F%E6%B4%BB'), '话题链接指向标签页')
  assert.ok(html.includes('共 1 篇'), '话题卡头带文章总数')
  const bare = THEMES.wechat.home({ ...homeData(), tags: [], categories: [] })
  assert.ok(!bare.includes('wx-side'), '无标签无分类不出侧栏（单栏版式）')
})

// ── 创作热力图（结构共享，色阶 = 各主题 accent 透明度四档） ──

test('heatmapHtml：周列网格 + 月份标签 + 四档色阶 + 图例，无数据出空串', () => {
  // 北京 2026-10-11 00:00 = UTC 2026-10-10 16:00
  const now = Date.UTC(2026, 9, 10, 16)
  const data = {
    days: [
      { day: '2026-10-11', count: 5 },
      { day: '2026-10-05', count: 2 },
      { day: '2025-01-01', count: 1 }, // 窗口外：db 只回传过去一年，渲染端同样不该出格子
    ],
    total: 7,
  }
  const zh = heatmapHtml(data, false, now)
  assert.ok(zh.startsWith('<section class="hm">'), 'section 开场')
  assert.ok(zh.includes('hm-grid'), '网格容器')
  assert.ok(zh.includes('hm-l4'), 'count≥4 落满档')
  assert.ok(zh.includes('title="2026-10-11 · 5 篇"'), '非空格带原生 tooltip')
  assert.ok(zh.includes('10月'), '月份标签（中文口径）')
  assert.ok(zh.includes('过去一年写了 7 篇'), '汇总行')
  assert.ok(zh.includes('hm-legend'), '图例')
  const en = heatmapHtml(data, true, now)
  assert.ok(en.includes('Oct'), '英文月份缩写')
  assert.ok(en.includes('7 posts in the last year'))
  assert.ok(en.includes('title="2026-10-05 · 2 posts"'))
  assert.ok(!zh.includes('2025-01-01'), '窗口外日期不渲染格子（db 只回传窗口内日期，渲染端不补）')
  assert.equal(heatmapHtml(undefined), '', '未传数据')
  assert.equal(heatmapHtml({ days: [], total: 0 }), '', '空数据')
})

// ── 上一篇/下一篇导航（结构共享，样式各主题 .pn-*） ──

test('postNeighborsHtml：两侧齐全/缺一侧/全空三种形态', () => {
  const prev = { slug: 'a', title: '旧文 & 转义' }
  const next = { slug: 'b', title: '新文' }
  const both = postNeighborsHtml(prev, next)
  assert.ok(both.startsWith('<nav class="pn-nav">'), '语义化 nav 开场')
  assert.ok(both.includes('href="/post/a"'), 'slug 直拼（cleanSlug 口径，esc 兜底）')
  assert.ok(both.includes('旧文 &amp; 转义'), '标题转义')
  assert.ok(both.includes('pn-label'), '带「上一篇/下一篇」标签')
  assert.ok(!both.includes('pn-empty'), '两侧齐全无占位')
  const onlyPrev = postNeighborsHtml(prev, null)
  assert.ok(onlyPrev.includes('href="/post/a"'))
  assert.ok(onlyPrev.includes('pn-empty'), '缺的一侧出占位空格保持两端对齐')
  assert.ok(!onlyPrev.includes('href="/post/b"'))
  assert.equal(postNeighborsHtml(null, undefined), '', '两侧全空返回空串')
  assert.equal(postNeighborsHtml(null, next).includes('上一篇'), false, '只传 next 时无上一篇链接')
})
