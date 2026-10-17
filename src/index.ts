import { Hono, type Context } from 'hono'
import { scheduledBackup } from './backup'
import { runScheduledPublish } from './scheduler'
import { api } from './api'
import { cleanBotPath, identifyBot, purgeBots, recordBot, shouldRecordBot } from './bots'
import { siteClosedResponse } from './closed'
import { clientIp, getCookie, getSessionUser, rateLimit } from './auth'
import { ensureSchema, getPostBySlug, getSettings, listCategories, listPages, listPosts, listSitemapCategoryLastmod, listSitemapPages, listSitemapPosts, listWeiboLastmod } from './db'
import { isEn, recordEditionFailure } from './i18n'
import { buildLlmsFullTxt, buildLlmsStub, buildLlmsTxt } from './llms'
import { mcpRoutes } from './mcp'
import { goPageHtml, isTrustedOutHost } from './outlink'
import { imageCacheMatch, imageCachePut, pageCacheMiddleware } from './pagecache'
import { renderAbout, renderArchive, renderCategory, renderGuestbook, renderHome, renderLinks, renderMember, renderNotFound, renderPage, renderPost, renderRank, renderSearch, renderWeibo } from './pages'
import { mergeUnlockCookie, PP_COOKIE, PP_TTL_MS, verifyPostPassword } from './protect'
import { installedManifest, pluginFileKey, readInstalled } from './pluginpkg'
import { buildJsonFeed, buildRss, buildSitemap } from './rss'
import { siteBase } from './render'
import { buildRobotsTxt, readAiPolicy } from './seo'
import { purgeVisits } from './stats'
import { purgeTrash } from './trash'
import { refreshFootStats } from './db'
import type { Env, SessionUser } from './types'
import { fmtDate, isDemo, siteVisibleCutoff } from './utils'

const app = new Hono<{ Bindings: Env; Variables: { user: SessionUser | null } }>()

// 外链中间页的 CSP（/go 路由专用）：无脚本需求，比前台更收紧——default-src 'none' 只留内联样式
const CSP_GO = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// 老库缺列自动补齐（幂等），每个 isolate 只执行一次
let schemaReady: Promise<void> | null = null
function ensureSchemaOnce(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = ensureSchema(db).catch((err) => {
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}
app.use('*', async (c, next) => {
  // 演示站：先幂等建表再自播种（空库冷启动要抢在 ensureSchema 之前——ensureSchema 是增量
  // 迁移层，基础表不存在时自己会先炸）；播种期间并发请求短暂等待
  if (isDemo(c.env)) {
    const demo = await import('./demo')
    await demo.demoEnsureSeeded(c.env)
  }
  await ensureSchemaOnce(c.env.DB)
  await next()
})

// 一键闭站（后台「设置 → 站点状态」，逻辑在 src/closed.ts）
app.use('*', async (c, next) => {
  const res = await siteClosedResponse(c.env.DB, c.req.raw, c.req.path)
  if (res) return res
  await next()
})

/* ---------------- 爬虫 / AI 抓取识别（src/bots.ts，统计页新维度） ----------------
 * 爬虫不执行 JS、进不了 visit_log，只能在服务端按 User-Agent 识别后旁路记录。
 * 只拦公开面：/admin、/api、/images、/mcp 不算「抓内容」；识别不命中（浏览器/未知脚本）
 * 直接放行零开销。记录走 waitUntil 异步写，绝不阻塞响应；写入闸（去抖 + 预算）在
 * shouldRecordBot 内部，防穷举路径刷 D1 写配额——见 bots.ts 文件头注释。 */
const BOT_SKIP_PREFIX = ['/admin', '/api', '/images', '/mcp']
app.use('*', async (c, next) => {
  const ua = c.req.header('User-Agent') || ''
  if (ua) {
    const bot = identifyBot(ua)
    if (bot && !BOT_SKIP_PREFIX.some((p) => c.req.path === p || c.req.path.startsWith(p + '/'))) {
      const qi = c.req.url.indexOf('?')
      const path = cleanBotPath(qi >= 0 ? c.req.path + c.req.url.slice(qi) : c.req.path)
      if (path && shouldRecordBot(bot.name, path)) {
        const country = (c.req.header('CF-IPCountry') || '').slice(0, 8)
        c.executionCtx.waitUntil(
          recordBot(c.env.DB, { name: bot.name, kind: bot.kind, path, country }).catch(() => {})
        )
      }
    }
  }
  await next()
})

/* ---------------- 页面边缘缓存（src/pagecache.ts）：公开页 / 订阅源 / 公开只读 API · 匿名访客 · 30 分钟副本 ----------------
 * 命中直接吐响应跳过 SSR/API 与 D1。登录 Cookie / 演示站 / 灰度一律不进缓存；带 query 走受控
 * 白名单（page/limit/wb/topic/q/sort/tag 镜像服务端 clamp 语义进键，未知参数 / sort=random 回源）。
 * 注册位必须在所有页面路由与 /api、/mcp 子应用之前（终点 handler 不调 next），且在闭站 /
 * 爬虫统计之后；设置变更 saveSettings 自动换代作废，后台「概览 → 系统」可一键清理 */
app.use('*', pageCacheMiddleware())

app.route('/api', api)
// MCP 服务器（AI 助手接入，src/mcp.ts）：复用 externalToken 鉴权；闭站中间件自动覆盖（不进白名单）
app.route('/mcp', mcpRoutes)

/* ---------------- 英文测试版守卫（English 0.1，机制见 src/i18n.ts） ----------------
 * 英文版渲染抛错时：落库 editionEnStatus=fallback（下一次 getSettings 起 isEn=false，全站自动
 * 回到中文版）并当场用中文重渲染同一请求——访客无感，后台横幅提醒 + 记录错误摘要，人工重新开启 */
type PublicHandler = (c: Context<{ Bindings: Env; Variables: { user: SessionUser | null } }>) => Promise<Response>
function enGuard(h: PublicHandler): PublicHandler {
  return async (c) => {
    const settings = await getSettings(c.env.DB)
    if (!isEn(settings)) return h(c)
    try {
      return await h(c)
    } catch (err) {
      console.error('[en-edition] render failed, falling back to zh:', err)
      await recordEditionFailure(c.env.DB, err)
      return h(c)
    }
  }
}

/* ---------------- 公开页面（SSR + 主题渲染） ---------------- */
// WordPress 风格订阅盲猜（/?feed=rss2 / rss / atom 等）：统一 302 到规范订阅地址
// （须注册在 renderHome 之前——终点 handler 不调 next，后注册的中间件不会再被执行）
app.get('/', async (c, next) => {
  if (c.req.query('feed')) return c.redirect('/rss.xml')
  await next()
})
app.get('/', enGuard(renderHome))
app.get('/tag/:tag', enGuard(renderHome))
app.get('/category/:slug', enGuard(renderCategory))
app.get('/post/:slug', enGuard(renderPost))
app.get('/page/:slug', enGuard(renderPage))
app.get('/about', enGuard(renderAbout))
app.get('/archives', enGuard(renderArchive))
app.get('/guestbook', enGuard(renderGuestbook))
app.get('/weibo', enGuard((c) => renderWeibo(c)))
app.get('/links', enGuard(renderLinks))
app.get('/member', enGuard(renderMember))
app.get('/rank', enGuard(renderRank))
app.get('/search', enGuard(renderSearch))

// 随机来一篇：从已发布文章里随机挑一篇跳过去（加密文章不进随机池——落上去就是一堵密码墙）
app.get('/random', async (c) => {
  // 站点可见窗口：随机入口同样只在窗口内抽（抽到窗口外文章 = 直链 404 死链）
  const settings = await getSettings(c.env.DB)
  const cutoff = siteVisibleCutoff(settings)
  const vis = cutoff ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const row = await c.env.DB.prepare(
    `SELECT slug FROM posts WHERE status = 'published' AND deleted_at IS NULL ${vis} AND (password_hash IS NULL OR password_hash = '') ORDER BY RANDOM() LIMIT 1`
  )
    .bind(...(cutoff ? [cutoff] : []))
    .first<{
      slug: string
    }>()
  if (!row) return renderNotFound(c)
  return c.redirect(`/post/${encodeURIComponent(row.slug)}`)
})

/* ---------------- 外链中间页（/go?u=<url>，机制在 src/outlink.ts） ----------------
 * 白名单域名（TRUSTED_OUT_DOMAINS）与同源链接 302 直跳不经过确认；其余第三方地址渲染
 * 「即将离开本站」提醒页（免责声明 + 访客自行决定），绝不自动跳转——不构成开放重定向。
 * 目标必须 http(s) 且 ≤2048 字符，缺失/非法一律回首页；正文外链在渲染层包装进来
 * （sanitize opts / weiboTextHtml），直接访问 /go 只是兜底入口 */
app.get('/go', async (c) => {
  const raw = (c.req.query('u') || '').trim()
  let target: URL | null = null
  try {
    target = raw ? new URL(raw) : null
  } catch {
    target = null
  }
  if (target && (target.protocol === 'http:' || target.protocol === 'https:') && target.href.length <= 2048) {
    if (target.origin === new URL(c.req.url).origin || isTrustedOutHost(target.hostname)) {
      return c.redirect(target.href)
    }
    const settings = await getSettings(c.env.DB)
    c.header('Content-Security-Policy', CSP_GO)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    return c.html(goPageHtml(target, settings.siteName || 'BlogHao', isEn(settings)))
  }
  return c.redirect('/')
})

/* ---------------- 文章解锁（表单 POST + 303 回跳，无 JS 依赖；表单由 src/protect.ts 渲染） ----------------
 * 组合语义（与 A 序列付费墙对齐）：密码墙优先——解锁 Cookie 通过前不进会员档判定；
 * 成功：签 HMAC 解锁 Cookie（key = 该文 password_hash，改密即全端失效）后 303 回文章页；
 * 失败：303 带 ?pwerr= 回文章页由表单展示错误；目标不存在/未加密一律静默回跳，不透露存在性 */
app.post('/post/:slug/unlock', async (c) => {
  // 与 api.ts 同源校验同口径：浏览器跨站表单 POST 必带 Origin，不一致直接拒绝（防 CSRF）
  const origin = c.req.header('Origin')
  if (origin && origin !== new URL(c.req.url).origin) return c.text('跨站请求被拒绝', 403)
  const slug = (c.req.param('slug') || '').slice(0, 100)
  const back = `/post/${encodeURIComponent(slug)}`
  const row = await getPostBySlug(c.env.DB, slug)
  if (!row || row.status !== 'published' || !row.password_hash) return c.redirect(back, 303)
  // 按文章 + IP 限流：PBKDF2 校验是慢操作，防爆破（10 次 / 10 分钟，与登录同量级）
  if (!rateLimit(`unlock:${clientIp(c.req.raw)}:${row.id}`, 10, 10 * 60_000)) {
    return c.redirect(`${back}?pwerr=slow`, 303)
  }
  const body = await c.req.parseBody().catch(() => null)
  const password = body && typeof body === 'object' ? String((body as Record<string, unknown>)['password'] ?? '').slice(0, 64) : ''
  if (!(await verifyPostPassword(row.password_hash, password))) return c.redirect(`${back}?pwerr=1`, 303)
  const token = await mergeUnlockCookie(getCookie(c.req.raw, PP_COOKIE), row.id, row.password_hash, Date.now())
  c.header('Set-Cookie', `${PP_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PP_TTL_MS / 1000}`)
  return c.redirect(back, 303)
})

/* ---------------- RSS 订阅（规范地址 /rss.xml，别名路径盲猜兜底） ----------------
 * 主题页脚 / head rel=alternate / sitemap 只展示规范地址；别名是纯服务端路由，不出现在任何
 * 前端出口。内容同 buildRss 一份输出——阅读器按内容嗅探格式，atom.xml 等文件名不影响解析，
 * atom:link rel=self 恒指规范地址（顺带把订阅器引回 /rss.xml）。闭站中间件对别名同样 503 */
const RSS_ALIASES = [
  '/rss',
  '/rss/',
  '/feed',
  '/feed/',
  '/feed.xml',
  '/feed/rss.xml',
  '/feed/rss',
  '/atom',
  '/atom/',
  '/atom.xml',
  '/index.xml',
  '/feeds/posts/default', // Blogger 惯例路径
]
const rssHandler: PublicHandler = async (c) => {
  const settings = await getSettings(c.env.DB)
  // 站点可见窗口：窗口外文章不进订阅源（比会员锁文的「试读段」更彻底——直接不出现）
  const { items } = await listPosts(c.env.DB, { status: 'published', limit: 50, afterTs: siteVisibleCutoff(settings) })
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/rss+xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  return c.body(buildRss(settings, items, siteUrl))
}
app.get('/rss.xml', rssHandler)
for (const p of RSS_ALIASES) app.get(p, rssHandler)

// JSON Feed 1.1（C12，buildJsonFeed 与 RSS 同一份防泄漏口径）：只有规范地址不设别名，
// 闭站中间件同样覆盖（订阅面随闭站 503）
const jsonFeedHandler: PublicHandler = async (c) => {
  const settings = await getSettings(c.env.DB)
  // 站点可见窗口：与 RSS 同一份口径（buildJsonFeed 防泄漏清单）
  const { items } = await listPosts(c.env.DB, { status: 'published', limit: 50, afterTs: siteVisibleCutoff(settings) })
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/json; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  return c.body(buildJsonFeed(settings, items, siteUrl))
}
app.get('/feed.json', jsonFeedHandler)

app.get('/sitemap.xml', async (c) => {
  const settings = await getSettings(c.env.DB)
  const [posts, categories, catLastmod, pages, wbLastmod] = await Promise.all([
    listSitemapPosts(c.env.DB, siteVisibleCutoff(settings)),
    listCategories(c.env.DB),
    listSitemapCategoryLastmod(c.env.DB),
    listSitemapPages(c.env.DB),
    listWeiboLastmod(c.env.DB),
  ])
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  const lastmodBySlug = new Map(catLastmod.map((r) => [r.slug, r.lastmod]))
  c.header('Content-Type', 'application/xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  return c.body(
    buildSitemap(
      settings,
      posts,
      siteUrl,
      categories.map((cat) => {
        const ts = lastmodBySlug.get(cat.slug) || 0
        return { ...cat, lastmod: ts ? fmtDate(ts) : '' }
      }),
      pages,
      wbLastmod || undefined
    )
  )
})

/** robots.txt（B20）：内置段 + 后台「设置 → 站点」的 robots 追加段（src/seo.ts buildRobotsTxt）；
 *  演示站固定整站 Disallow（种子数据与闭站状态不该进索引），追加段不参与 */
app.get('/robots.txt', async (c) => {
  const settings = await getSettings(c.env.DB)
  return c.text(buildRobotsTxt(settings, new URL(c.req.url).origin, isDemo(c.env)))
})

/* ---------------- AI 索引导读（llms.txt / llms-full.txt，B28）----------------
 * 新兴 AI 抓取导读约定（llmstxt.org；Cloudflare 阻止响应的内置放行路径）。文章清单走 listPosts
 * 的同一份公开口径（status=published + 站点可见窗口 + 软删过滤），防泄漏清单在 src/llms.ts 头注；
 * 演示站 / siteNoindex / AI 策略 deny 档出桩（与 robots.txt 整站 Disallow 同口径）；两路径已进
 * pagecache 数据白名单 */
const llmsHandler = (full: boolean): PublicHandler => async (c) => {
  const settings = await getSettings(c.env.DB)
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  // AI 策略 deny 档：llms 面本就是给 AI 看的导读，robots 全拒时整体关闭（桩文案指向策略而非演示）
  const aiDenied = readAiPolicy(settings.aiPolicy) === 'deny'
  if (isDemo(c.env) || settings.siteNoindex === '1' || aiDenied) return c.body(buildLlmsStub(settings, siteUrl, aiDenied))
  const [feed, pages] = await Promise.all([
    listPosts(c.env.DB, { status: 'published', limit: full ? 50 : 100, afterTs: siteVisibleCutoff(settings) }),
    listPages(c.env.DB, { status: 'published' }),
  ])
  return c.body(
    full
      ? buildLlmsFullTxt(settings, feed.items, siteUrl)
      : buildLlmsTxt(settings, feed.items, pages.map((p) => ({ slug: p.slug, title: p.title })), siteUrl)
  )
}
app.get('/llms.txt', llmsHandler(false))
app.get('/llms-full.txt', llmsHandler(true))

/* ---------------- 编辑器远程插件下发（B8 插件半边，安装端点在 api.ts） ----------------
 * /plugins/installed.json 与 /plugin-files/:id 都要求管理员会话（编辑器带着 Cookie 加载），
 * 未登录 / 未安装一律 404 不透露存在性；静态资源由 wrangler assets 先行，这里只接动态面。
 * 注意：/plugins/manifest.json 仍是 assets 静态文件，与本路由无关。 */
app.get('/plugins/installed.json', async (c) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.text('Not found', 404)
  const list = readInstalled((await getSettings(c.env.DB)).pluginsInstalled)
  return c.json(installedManifest(list))
})

app.get('/plugin-files/:id', async (c) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return c.text('Not found', 404)
  const id = c.req.param('id')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.text('Not found', 404)
  const list = readInstalled((await getSettings(c.env.DB)).pluginsInstalled)
  if (!list.some((p) => p.id === id)) return c.text('Not found', 404)
  const obj = await c.env.IMAGES.get(pluginFileKey(id))
  if (!obj) return c.text('Not found', 404)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cache-Control', 'no-store')
  return c.body(obj.body, 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
})

/* ---------------- R2 图床 ---------------- */
app.get('/images/*', async (c) => {
  const raw = c.req.path.slice('/images/'.length)
  let key = raw
  try {
    key = decodeURIComponent(raw)
  } catch {
    /* 保持原样 */
  }
  if (!key.startsWith('u/') && !key.startsWith('og/')) return c.text('Not found', 404)
  // 图床边缘缓存（src/pagecache.ts imageCacheMatch）：键内容寻址（saveUpload 时间戳+随机数，
  // 同键永不覆盖），colo 副本命中直接返回，省一次 Worker→R2 的跨境回源；404 不缓存，
  // If-None-Match 复验也先在边缘层做
  const hit = await imageCacheMatch(c.req.raw)
  if (hit) return hit
  const obj = await c.env.IMAGES.get(key)
  if (!obj) return c.text('Not found', 404)
  // 缓存指令尊重 R2 对象自带的 httpMetadata.cacheControl（favicon 等「同键可覆盖」目录
  // 写的是短 TTL，刷新才能收敛）；没写才兜底内容寻址媒体的 1y immutable
  const cacheControl = obj.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable'
  if (obj.httpEtag && c.req.header('If-None-Match') === obj.httpEtag) {
    return new Response(null, {
      status: 304,
      // 304 也要带缓存指令：浏览器拿 304 续用本地副本时需要知道 TTL
      headers: { ETag: obj.httpEtag, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' },
    })
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream')
  headers.set('ETag', obj.httpEtag)
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', cacheControl)
  // 禁止浏览器嗅探内容类型：图床里只允许真正的图片被当图片渲染
  headers.set('X-Content-Type-Options', 'nosniff')
  const res = new Response(obj.body, { headers })
  imageCachePut(c.req.raw, res, c.executionCtx)
  return res
})

/* ---------------- 后台入口 ---------------- */
app.get('/admin', (c) => c.redirect('/admin/'))

/* ---------------- 404 / 500 ---------------- */
app.notFound((c) => renderNotFound(c))

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.text('服务开小差了，请稍后再试。', 500)
})

// fetch：站点与 API；scheduled：Cron Trigger——先扫定时发布（每分钟），
// 每晚备份时间点顺带跑备份（见 wrangler.jsonc triggers.crons）
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // 备份 cron 是 "30 16 * * *"（北京时间 00:30）；其余每分钟触发只做定时发布扫描。
    // cron 可能落在从未处理过请求的 isolate：先补齐 schema，否则冷启动库上
    // 定时发布/备份会因缺列缺表而报错。
    const isBackupCron = controller.cron === '30 16 * * *'
    return ctx.waitUntil(
      (async () => {
        try {
          await ensureSchemaOnce(env.DB)
        } catch (e) {
          // 迁移失败不阻塞 cron：后续查询自会报错并走各自的兜底提醒
          console.error('ensureSchema (cron) failed:', e)
        }
        // 演示站的重置 cron（每 2 小时）优先处理：清库重灌种子数据，之后本轮到此为止
        if (isDemo(env)) {
          try {
            const demo = await import('./demo')
            if (await demo.demoScheduled(controller, env)) return
          } catch (e) {
            console.error('demo scheduled failed:', e)
          }
        }
        await runScheduledPublish(env)
        if (isBackupCron) {
          await scheduledBackup(controller, env)
          // 访客日志滚动清理：visit_log 是日志类数据不进备份，只在这里按保留期删
          await purgeVisits(env.DB).catch((e) => console.error('purgeVisits failed:', e))
          // 爬虫日志滚动清理：bot_log 同为日志类数据不进备份（src/bots.ts）
          await purgeBots(env.DB).catch((e) => console.error('purgeBots failed:', e))
          // 回收站滚动清理：到期（30 天）的软删行彻底删除并级联评论（src/trash.ts）
          await purgeTrash(env.DB).catch((e) => console.error('purgeTrash failed:', e))
          // 页脚「站点足迹」统计夜更（db.ts refreshFootStats，页脚名片读 settings.siteFoot）
          await refreshFootStats(env.DB).catch((e) => console.error('refreshFootStats failed:', e))
        }
      })()
    )
  },
}
