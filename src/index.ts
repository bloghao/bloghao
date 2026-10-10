import { Hono, type Context } from 'hono'
import { scheduledBackup } from './backup'
import { runScheduledPublish } from './scheduler'
import { api } from './api'
import { siteClosedResponse } from './closed'
import { clientIp, getCookie, rateLimit } from './auth'
import { ensureSchema, getPostBySlug, getSettings, listCategories, listPublishedTags, listPosts, listSitemapPages, listSitemapPosts } from './db'
import { isEn, recordEditionFailure } from './i18n'
import { goPageHtml, isTrustedOutHost } from './outlink'
import { renderAbout, renderArchive, renderCategory, renderGuestbook, renderHome, renderLinks, renderMember, renderNotFound, renderPage, renderPost, renderRank, renderSearch, renderWeibo } from './pages'
import { mergeUnlockCookie, PP_COOKIE, PP_TTL_MS, verifyPostPassword } from './protect'
import { buildRss, buildSitemap } from './rss'
import { siteBase } from './render'
import { purgeVisits } from './stats'
import { purgeTrash } from './trash'
import type { Env, SessionUser } from './types'
import { isDemo } from './utils'

const app = new Hono<{ Bindings: Env; Variables: { user: SessionUser | null } }>()

// 外链中间页的 CSP（/go 路由专用）：无脚本需求，比前台更收紧——default-src 'none' 只留内联样式
const CSP_GO = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

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

app.route('/api', api)

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
  const row = await c.env.DB.prepare("SELECT slug FROM posts WHERE status = 'published' AND deleted_at IS NULL AND (password_hash IS NULL OR password_hash = '') ORDER BY RANDOM() LIMIT 1").first<{
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

app.get('/rss.xml', async (c) => {
  const settings = await getSettings(c.env.DB)
  const { items } = await listPosts(c.env.DB, { status: 'published', limit: 50 })
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/rss+xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  return c.body(buildRss(settings, items, siteUrl))
})

app.get('/sitemap.xml', async (c) => {
  const settings = await getSettings(c.env.DB)
  const [posts, categories, tags, pages] = await Promise.all([
    listSitemapPosts(c.env.DB),
    listCategories(c.env.DB),
    listPublishedTags(c.env.DB),
    listSitemapPages(c.env.DB),
  ])
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  c.header('Content-Type', 'application/xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=600')
  return c.body(buildSitemap(settings, posts, siteUrl, categories, tags, pages))
})

app.get('/robots.txt', (c) =>
  isDemo(c.env)
    ? // 演示站：不希望被搜索引擎收录（内容是种子数据，且闭站页等状态不该进索引）
      c.text('User-agent: *\nDisallow: /\n')
    : c.text(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${new URL(c.req.url).origin}/sitemap.xml\n`)
)

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
  const obj = await c.env.IMAGES.get(key)
  if (!obj) return c.text('Not found', 404)
  if (obj.httpEtag && c.req.header('If-None-Match') === obj.httpEtag) {
    return new Response(null, {
      status: 304,
      // 304 也要带缓存指令：浏览器拿 304 续用本地副本时需要知道 TTL
      headers: { ETag: obj.httpEtag, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
    })
  }
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream')
  headers.set('ETag', obj.httpEtag)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  // 禁止浏览器嗅探内容类型：图床里只允许真正的图片被当图片渲染
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(obj.body, { headers })
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
          // 回收站滚动清理：到期（30 天）的软删行彻底删除并级联评论（src/trash.ts）
          await purgeTrash(env.DB).catch((e) => console.error('purgeTrash failed:', e))
        }
      })()
    )
  },
}
