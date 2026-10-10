import { type Context, Hono } from 'hono'
import { runBackup } from './backup'
import {
  clearMemberSessionCookie,
  clearSessionCookie,
  clientIp,
  createMemberSession,
  createSession,
  destroyMemberSession,
  destroyMemberSessionsByMember,
  destroyOtherMemberSessions,
  destroySession,
  getCookie,
  getMemberUser,
  getSessionUser,
  hashPassword,
  MEMBER_SESSION_COOKIE,
  rateLimit,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
  memberSessionCookie,
} from './auth'
import {
  countUsers,
  createCategory,
  categoryNameMap,
  createMember,
  DEFAULT_SETTINGS,
  getCategoryById,
  getFriendLinkById,
  getMemberById,
  getMemberByUsername,
  getPostById,
  getPostBySlug,
  getPostCategoryId,
  getSettings,
  getWeiboById,
  listCategories,
  listFriendLinks,
  listMembersAdmin,
  listPages,
  getPageById,
  uniquePageSlug,
  listPosts,
  listWeibo,
  parseTags,
  parseWeiboImages,
  saveSettings,
  seedWelcomePost,
  setPostCategory,
  uniqueSlug,
  updateMemberAdmin,
  updateMemberNickname,
  updateMemberQQ,
  weiboCommentCountMap,
  weiboImageList,
  weiboTopicList,
  WEIBO_MAX_CHARS,
} from './db'
import { mdToHtml } from './markdown'
import { EMOJI_BASE, WECHAT_EMOJI } from './emoji'
import { awardCommentPoints, awardPoints, normalizeMinTier } from './points'
import { collectRoutes } from './collect'
import { exportRoutes } from './export'
import { adminExternalRoutes, externalRoutes, notifyAdminComment, telegramRoutes } from './external'
import { fireCommentCreated, firePostPublished, fireWeiboPublished, listBufferChannels, listServerPlugins } from './hooks'
import { SITE_MODE_VALUES, siteBase, toHomePost, type SiteMode } from './render'
import { sanitizeHtml } from './sanitize'
import { cleanupUnreferenced, backfillHashes, mergeDuplicate, runAudit } from './audit'
import { imageExtOf, MAX_REMOTE_IMAGES, MAX_UPLOAD_BYTES, saveUpload, sniffImageExt, sniffUploadExt, transferImage } from './store'
import { hashPostPassword } from './protect'
import { listTrash, restorePostStatus, trashTable, type TrashTable } from './trash'
import { classifyBrowser, classifyDevice, cleanPath, cleanRef, cleanTitle, cleanVid, getVisitStats, recordVisit } from './stats'
import { fetchLinkMeta } from './linkmeta'
import { BROWSER_UA, buildCardHtml, coverProxyHostOk, coverReferer, fetchDoubanDetail, probeRelay, resolveCardCover, sanitizeMediaItem, searchMedia, subjectIdFromUrl, validateRelay, type MediaItem } from './douban'
import { THEMES } from './themes/registry'
import type { CommentRow, Env, MemberRow, MemberTier, PostRow, SessionUser } from './types'
import { clampInt, cleanDisabledPlugins, cleanNickname, cleanSlug, excerpt, extractWeiboTopics, fmtDateCN, isDemo, isValidQQ, jsonItemLikePattern, nicknameCooldown, normalizeLinkUrl, slugify } from './utils'

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } }

const MAX_CONTENT_BYTES = 1_000_000 // 正文 ~1MB
const VIDEO_MIMES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

export const api = new Hono<AppEnv>()

/* ---------------- 全局：同源校验（防 CSRF） ---------------- */
api.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin) {
      return jsonError('跨站请求被拒绝', 403)
    }
  }
  await next()
})

api.get('/health', (c) => c.json({ ok: true, time: Date.now() }))

/* ---------------- 认证 ---------------- */
api.get('/auth/state', async (c) => {
  const [user, n] = await Promise.all([getSessionUser(c.env.DB, c.req.raw), countUsers(c.env.DB)])
  // demo 标记给后台前端用：登录页公示演示账号、禁用改密码与闭站开关
  return c.json({ needsSetup: n === 0, user, demo: isDemo(c.env) })
})

api.post('/auth/setup', async (c) => {
  if ((await countUsers(c.env.DB)) > 0) return jsonError('管理员已存在', 403)
  if (!rateLimit(`setup:${clientIp(c.req.raw)}`, 5, 10 * 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; displayName?: string }>().catch(() => null)
  const username = (body?.username || '').trim()
  const password = body?.password || ''
  if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return jsonError('用户名需为 2-24 位字母、数字、_ 或 -')
  if (password.length < 8 || password.length > 64) return jsonError('密码长度需为 8-64 位')
  // 原子占位锁：countUsers 是 check-then-insert，并发首个请求都能通过检查，
  // 靠 settings 一次性 INSERT 的 changes 判定唯一归属，杜绝双管理员
  const lock = await c.env.DB
    .prepare("INSERT INTO settings (key, value) VALUES ('setupLock', '1') ON CONFLICT(key) DO NOTHING")
    .run()
  if ((lock.meta.changes ?? 0) !== 1) return jsonError('管理员已存在', 403)
  try {
    const { hash, salt } = await hashPassword(password)
    const now = Date.now()
    const res = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, salt, display_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(username, hash, salt, (body?.displayName || username).slice(0, 32), '', now, now)
      .run()
    const userId = Number(res.meta.last_row_id)
    await seedWelcomePost(c.env.DB, userId)
    const token = await createSession(c.env.DB, userId)
    c.header('Set-Cookie', sessionCookie(token))
    return c.json({ ok: true, user: { id: userId, username, display_name: body?.displayName || username, avatar: '' } })
  } catch (e) {
    // 建号中途失败要释放锁，否则首次安装被永久卡死
    await c.env.DB.prepare("DELETE FROM settings WHERE key = 'setupLock'").run().catch(() => undefined)
    throw e
  }
})

api.post('/auth/login', async (c) => {
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`login:${ip}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null)
  const username = (body?.username || '').trim()
  const password = body?.password || ''
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<{
    id: number
    username: string
    password_hash: string
    salt: string
    display_name: string
    avatar: string
  }>()
  if (user) {
    const { hash } = await hashPassword(password, user.salt)
    if (safeEqual(hash, user.password_hash)) {
      const token = await createSession(c.env.DB, user.id)
      c.header('Set-Cookie', sessionCookie(token))
      return c.json({
        ok: true,
        user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar },
      })
    }
  } else {
    // 用户不存在也跑一次等开销的哈希：响应耗时对齐，防时序侧信道枚举用户名
    await hashPassword(password, 'timing-equalizer-salt-0000')
  }
  return jsonError('用户名或密码错误', 401)
})

api.post('/auth/logout', async (c) => {
  await destroySession(c.env.DB, c.req.raw)
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

/* ---------------- 会员（访客注册/登录，契约见 docs/DEVPLAN-2026-10-07.md 附录 A） ---------------- */

/** 对外视图裁剪：公开口径只有昵称/档位/积分；self = 本人视角（另给 email/username/createdAt），管理口径走 listMembersAdmin 原始行 */
function memberView(m: MemberRow, self = false) {
  const v: Record<string, unknown> = {
    nickname: (m.display_name || m.username).slice(0, 24),
    tier: m.tier,
    points: m.points,
  }
  if (m.avatar) v.avatarUrl = m.avatar
  if (self) {
    v.username = m.username
    v.email = m.email
    v.qq = m.qq
    v.createdAt = m.created_at
    v.displayNameChangedAt = m.display_name_changed_at ?? null
  }
  return v
}

api.post('/member/register', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`mreg:${ip}`, 5, 10 * 60_000)) return jsonError('注册太频繁，请稍后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string; email?: string; nickname?: string; link?: string }>().catch(() => null)
  // 蜜罐字段 link：正常用户看不到、机器人会填 —— 静默丢弃（同 publicComment 口径）
  if (body?.link) return c.json({ ok: true })
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const email = String(body?.email || '').trim().slice(0, 100)
  // 昵称选填（中英文均可，仅展示不做唯一约束）；注册时填写不占用 30 天修改窗口
  const nickname = cleanNickname(body?.nickname)
  if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return jsonError('用户名需为 2-24 位字母、数字、_ 或 -')
  if (password.length < 8 || password.length > 64) return jsonError('密码长度需为 8-64 位')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('邮箱格式不正确')
  if (await getMemberByUsername(c.env.DB, username)) return jsonError('用户名已被占用')
  const { hash, salt } = await hashPassword(password)
  let memberId: number
  try {
    memberId = await createMember(c.env.DB, { username, hash, salt, email, displayName: nickname })
  } catch {
    return jsonError('用户名已被占用') // 并发注册撞 UNIQUE 约束的兜底
  }
  const token = await createMemberSession(c.env.DB, memberId)
  c.header('Set-Cookie', memberSessionCookie(token))
  await awardPoints(c.env.DB, memberId, 'dailyLogin')
  const row = await getMemberById(c.env.DB, memberId)
  return c.json({ ok: true, member: row ? memberView(row, true) : null })
})

api.post('/member/login', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`mlogin:${ip}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null)
  const username = String(body?.username || '').trim()
  const password = String(body?.password || '')
  const m = await getMemberByUsername(c.env.DB, username)
  if (m) {
    const { hash } = await hashPassword(password, m.salt)
    if (safeEqual(hash, m.password_hash)) {
      // 先验口令再报封禁：不向未持有口令的人泄露账号状态（契约 A5：403 {error:'banned'}）
      if (m.status === 'banned') return jsonError('banned', 403)
      const token = await createMemberSession(c.env.DB, m.id)
      c.header('Set-Cookie', memberSessionCookie(token))
      await awardPoints(c.env.DB, m.id, 'dailyLogin')
      await c.env.DB.prepare('UPDATE members SET last_login_at = ? WHERE id = ?').bind(Date.now(), m.id).run()
      return c.json({ ok: true, member: memberView(m, true) })
    }
  } else {
    // 用户不存在也跑一次等开销哈希：响应耗时对齐，防时序侧信道枚举用户名（同 /auth/login 口径）
    await hashPassword(password, 'timing-equalizer-salt-0000')
  }
  return jsonError('用户名或密码错误', 401)
})

api.post('/member/logout', async (c) => {
  await destroyMemberSession(c.env.DB, c.req.raw)
  c.header('Set-Cookie', clearMemberSessionCookie())
  return c.json({ ok: true })
})

api.get('/member/me', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return c.json({ member: null })
  const row = await getMemberById(c.env.DB, session.id)
  return c.json({ member: row ? memberView(row, true) : null })
})

/* 会员个人资料（/member 页会员卡，契约见 docs/DEVPLAN-2026-10-07.md）：改昵称（30 天一次）与改密码 */

/** 抓取 QQ 头像并转存进站内图床，返回站内地址；失败返回 null（调用方容忍只存 qq 号，
 *  会员中心「重试头像」重跑同一请求补抓）。q1 主端点、q2 备用镜像，s=140 档（100 略糊、
 *  640 浪费流量）；只认文件魔数（同 collect 转存口径），落库统一走 saveUpload（EXIF 剥离同款兜底） */
async function fetchQQAvatar(env: Env, qq: string): Promise<string | null> {
  for (const host of ['q1.qlogo.cn', 'q2.qlogo.cn']) {
    try {
      const res = await fetch(`https://${host}/g?b=qq&nk=${encodeURIComponent(qq)}&s=140`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Referer: 'https://q.qlogo.cn/' },
        signal: AbortSignal.timeout(6_000),
      })
      if (!res.ok) continue
      if (Number(res.headers.get('content-length') || 0) > 1024 * 1024) continue
      const buf = await res.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > 1024 * 1024) continue
      const ext = sniffImageExt(buf)
      if (!ext || ext === 'gif') continue // 头像只收 jpg/png/webp
      return await saveUpload(env, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`, `qq-${qq}.${ext}`, ext)
    } catch {
      /* 单镜像失败换下一个，最终失败由调用方容忍 */
    }
  }
  return null
}

api.post('/member/profile', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return jsonError('请先登录', 401)
  const body = await c.req.json<{ nickname?: string; qq?: string }>().catch(() => null)
  const hasNickname = !!body && typeof body.nickname === 'string'
  const nickname = hasNickname ? cleanNickname(body?.nickname) : ''
  // qq 只在显式携带时处理：带键即意图（绑定/重试头像），不带键不碰
  const qq = body && typeof body.qq === 'string' ? body.qq.trim() : undefined
  if (!hasNickname && qq === undefined) return jsonError('没有要修改的内容')
  if (hasNickname && !nickname) return jsonError('昵称不能为空')
  const res: Record<string, unknown> = { ok: true }
  const now = Date.now()

  if (hasNickname) {
    const row = await getMemberById(c.env.DB, session.id)
    if (!row) return jsonError('请先登录', 401)
    const cd = nicknameCooldown(row.display_name_changed_at)
    if (!cd.allowed) return jsonError(`昵称每 30 天只能修改一次，${fmtDateCN(cd.nextAt)}后可再改`, 403)
    // 条件更新把窗口判定下沉进 SQL：并发双开同时过上面的前置检查时，只有一动能落库
    if (!(await updateMemberNickname(c.env.DB, session.id, nickname, now))) {
      return jsonError(`昵称每 30 天只能修改一次，${fmtDateCN(nicknameCooldown(now).nextAt)}后可再改`, 403)
    }
    res.nickname = nickname
    res.displayNameChangedAt = now
  }

  if (qq !== undefined) {
    // 评论头像（C2）：qq 号仅作头像抓取记账位，任何公开出参不携带；绑过再绑 = 幂等重试头像
    if (!isValidQQ(qq)) return jsonError('QQ 号格式不对（5-11 位数字，不以 0 开头）')
    if (!rateLimit(`qqbind:${session.id}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
    const avatarUrl = await fetchQQAvatar(c.env, qq)
    await updateMemberQQ(c.env.DB, session.id, qq, avatarUrl, now)
    res.qq = qq
    if (avatarUrl) res.avatarUrl = avatarUrl
    else res.avatarFailed = true
  }

  return c.json(res)
})

api.post('/member/password', async (c) => {
  const settings = await getSettings(c.env.DB)
  if (settings.membersEnabled !== '1') return jsonError('会员功能未开放', 404)
  const session = await getMemberUser(c.env.DB, c.req.raw)
  if (!session) return jsonError('请先登录', 401)
  // PBKDF2 是慢操作：按 IP 限流防滥用（口径同 /member/login）
  if (!rateLimit(`mpwd:${clientIp(c.req.raw)}`, 10, 10 * 60_000)) return jsonError('尝试次数过多，请 10 分钟后再试', 429)
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => null)
  const current = String(body?.currentPassword || '')
  const next = String(body?.newPassword || '')
  if (next.length < 8 || next.length > 64) return jsonError('新密码长度需为 8-64 位')
  const row = await getMemberById(c.env.DB, session.id)
  if (!row) return jsonError('请先登录', 401)
  const { hash } = await hashPassword(current, row.salt)
  if (!safeEqual(hash, row.password_hash)) return jsonError('当前密码不正确')
  const { hash: newHash, salt: newSalt } = await hashPassword(next)
  await c.env.DB
    .prepare('UPDATE members SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, newSalt, Date.now(), row.id)
    .run()
  // 改密即其他设备全部下线（当前会话保留——改密码的人自己不能被登出去）
  const token = getCookie(c.req.raw, MEMBER_SESSION_COOKIE) || ''
  await destroyOtherMemberSessions(c.env.DB, row.id, token)
  return c.json({ ok: true })
})

/* ---------------- 需要登录的 /admin/* ---------------- */
/* 注意：本中间件必须注册在所有 /admin/* 路由之前（hono 按注册顺序执行，路由先命中即终止链条） */
api.use('/admin/*', async (c, next) => {
  const user = await getSessionUser(c.env.DB, c.req.raw)
  if (!user) return jsonError('请先登录', 401)
  c.set('user', user)
  await next()
})

/* 后台会员管理（PUT 缺键即保留，同 posts PUT 语义） */

const MEMBER_TIERS: MemberTier[] = ['normal', 'coffee', 'top']

api.get('/admin/members', async (c) => {
  const page = clampInt(c.req.query('page'), 1, 1_000_000, 1)
  const q = (c.req.query('q') || '').trim().slice(0, 50)
  return c.json(await listMembersAdmin(c.env.DB, q, page))
})

api.put('/admin/members/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('会员不存在', 404)
  const body = await c.req.json<{ tier?: string; status?: string }>().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError('请求格式错误')
  const patch: { tier?: string; status?: string } = {}
  if ('tier' in body) {
    if (!MEMBER_TIERS.includes(body.tier as MemberTier)) return jsonError('未知档位')
    patch.tier = body.tier
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'banned') return jsonError('未知状态')
    patch.status = body.status
  }
  if (!(await updateMemberAdmin(c.env.DB, id, patch))) return jsonError('会员不存在', 404)
  // 拉黑即踢下线（getMemberUser 查询层已挡 banned，这里把会话 token 一并清掉）
  if (patch.status === 'banned') await destroyMemberSessionsByMember(c.env.DB, id)
  return c.json({ ok: true })
})

/* 采集插件（公众号文章 → 草稿），见 src/collect.ts */
api.route('/admin/collect', collectRoutes)
api.route('/admin/export', exportRoutes)

/* 外部发布：开放 API / Telegram 机器人（自鉴权）与后台管理端点，见 src/external.ts */
api.route('/admin/external', adminExternalRoutes)
api.route('/external', externalRoutes)
api.route('/telegram', telegramRoutes)

api.get('/admin/stats', async (c) => {
  const db = c.env.DB
  const [pub, drafts, pending, uploads, recent, pendingLinks] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(views),0) AS v, COALESCE(SUM(likes),0) AS l FROM posts WHERE status = 'published' AND deleted_at IS NULL")
      .first<{ n: number; v: number; l: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'draft' AND deleted_at IS NULL").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS s FROM uploads').first<{ n: number; s: number }>(),
    db.prepare("SELECT * FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC LIMIT 5").all<PostRow>(),
    db.prepare("SELECT COUNT(*) AS n FROM friend_links WHERE status = 'pending'").first<{ n: number }>(),
  ])
  return c.json({
    posts: pub?.n ?? 0,
    views: pub?.v ?? 0,
    likes: pub?.l ?? 0,
    drafts: drafts?.n ?? 0,
    pendingComments: pending?.n ?? 0,
    pendingLinks: pendingLinks?.n ?? 0,
    uploads: { count: uploads?.n ?? 0, bytes: uploads?.s ?? 0 },
    recent: (recent.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      views: r.views,
      published_at: r.published_at,
    })),
  })
})

/* 访客统计（后台「统计」页），聚合见 src/stats.ts */
api.get('/admin/visits', async (c) => {
  const days = clampInt(c.req.query('days'), 1, 365, 30)
  return c.json(await getVisitStats(c.env.DB, days))
})

/* ---------------- 文章管理 ---------------- */
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS)

/** 路由 :id 参数 → 正整数；非法返回 null（调用方 404），防 NaN 直传 D1 变 500 */
function parseId(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function readPostPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const title = String(b.title ?? '').slice(0, 150).trim()
  const content = String(b.content ?? '')
  // 上限按 UTF-8 字节数（与常量名、collect 一致）：100 万个 CJK 字符实际可存 ~3MB
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return { tooBig: true as const }
  const status = b.status === 'published' ? 'published' : b.status === 'scheduled' ? 'scheduled' : 'draft'
  // 定时发布目标时间（毫秒）：不填或非法时由 PUT 沿用旧值；已过去的时间等价于「到点即发」。
  // 上限钳制在 [-24h, +5y]：防 1e300 之类异常值入库（超出 int64，定时扫描永不命中卡死在 scheduled）
  const rawPublishAt = Number(b.publishAt)
  const publishAt =
    Number.isFinite(rawPublishAt) && rawPublishAt > 0
      ? Math.floor(Math.min(Math.max(rawPublishAt, Date.now() - 86_400_000), Date.now() + 5 * 365 * 86_400_000))
      : null
  // PUT 部分更新语义：字段缺失 ≠ 空值。文章列表接口不带回 content/tags/categoryId，
  // 列表页的状态切换只发 {status}——缺这些键时 PUT 必须保留旧值而不是清空（has 记录来源）
  const has = {
    title: 'title' in b,
    slug: 'slug' in b,
    content: 'content' in b,
    summary: 'summary' in b,
    cover: 'cover' in b,
    tags: 'tags' in b,
    status: 'status' in b,
    pinned: 'pinned' in b,
    categoryId: 'categoryId' in b,
    minTier: 'minTier' in b,
    password: 'password' in b,
  }
  const tags = Array.isArray(b.tags)
    ? b.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 8)
    : []
  const cover = String(b.cover ?? '').slice(0, 500)
  const rawCategoryId = b.categoryId
  const categoryId =
    rawCategoryId == null || rawCategoryId === '' ? null : Number.isFinite(Number(rawCategoryId)) ? Number(rawCategoryId) : null
  return {
    title,
    content,
    summary: String(b.summary ?? '').slice(0, 500),
    cover: cover.startsWith('/') || /^https?:\/\//i.test(cover) ? cover : '',
    tags,
    status,
    pinned: b.pinned ? 1 : 0,
    // 自定义 slug 清洗：只留字母/数字/中文/_/-，空白转连字符，防坏链与异常路由
    slug: cleanSlug(String(b.slug ?? '')),
    categoryId,
    publishAt,
    // 可见档位（契约 DEVPLAN 附录 A A7）：脏值归一为 all
    minTier: normalizeMinTier(typeof b.minTier === 'string' ? b.minTier : null),
    // 访问密码（src/protect.ts）：仅在键存在时参与写入；空串 = 解除加密，缺键 = 保持现状。
    // 明文只在本次请求内存在，落库前即转 PBKDF2，响应里永远只有 hasPassword 布尔
    password: String(b.password ?? '').slice(0, 64),
    has,
  }
}

// 服务端插件列表（后台「插件」页展示与启停，见 src/hooks.ts）
api.get('/admin/server-plugins', (c) => c.json({ plugins: listServerPlugins() }))

/** 后台文章出参：password_hash 永不出接口（明文不可逆，哈希也不该喂给前端），只给 hasPassword 布尔 */
function postAdminView(row: PostRow & { tagList?: string[]; categoryId?: number | null }) {
  return { ...row, password_hash: undefined, hasPassword: !!row.password_hash }
}

api.get('/admin/posts', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'published' || statusParam === 'draft' || statusParam === 'scheduled' ? statusParam : 'all'
  const r = await listPosts(c.env.DB, {
    status,
    q: c.req.query('q') || undefined,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 100, 20),
  })
  const catNames = await categoryNameMap(c.env.DB, r.items.map((p) => p.id))
  return c.json({
    items: r.items.map((p) => ({
      ...postAdminView(p),
      content: undefined,
      tagList: parseTags(p),
      categoryName: catNames.get(p.id) || '',
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

api.post('/admin/posts', async (c) => {
  const p = await readPostPayload(c)
  if (!p) return jsonError('请求格式错误')
  if ('tooBig' in p) return jsonError('正文过长（上限约 1MB）')
  // 定时发布必须带时间（编辑器有校验，这里拦 API 直调）——否则 publish_at 落 NULL，
  // scheduler 只扫有时间的行，该文会无提示地永远卡在 scheduled
  if (p.status === 'scheduled' && p.publishAt == null) return jsonError('定时发布必须填写发布时间')
  const title = p.title || '无标题'
  const base = p.slug || slugify(title)
  const slug = await uniqueSlug(c.env.DB, base)
  const now = Date.now()
  // 访问密码：随创建一并写入（空 = 不加密）
  const passwordHash = p.password ? await hashPostPassword(p.password) : ''
  // 自动摘要取净化后的正文（与 PUT 更新同口径：粘贴内容里的标签/实体不进导读面）
  const clean = sanitizeHtml(p.content)
  const res = await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, publish_at, min_tier, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      slug,
      title,
      clean,
      // 密码文的自动摘要留空：summary 列是对外导读面（RSS description / meta / 公开列表），
      // 不能拿加密正文截前 80 字泄出去；作者手填的摘要照常保留（作者主动公开的导读）
      p.summary || (passwordHash ? '' : excerpt(clean, 80)),
      p.cover,
      JSON.stringify(p.tags),
      p.status,
      p.pinned,
      c.get('user').id,
      p.status === 'published' ? now : null,
      p.status === 'scheduled' ? (p.publishAt ?? null) : null,
      p.minTier,
      passwordHash,
      now,
      now
    )
    .run()
  const row = await getPostById(c.env.DB, Number(res.meta.last_row_id))
  if (p.categoryId != null && row) {
    const cat = await getCategoryById(c.env.DB, p.categoryId)
    if (cat) await setPostCategory(c.env.DB, row.id, cat.id)
  }
  // 广播发布事件（服务端插件钩子，见 src/hooks.ts）：新建即发布也算跃迁
  if (p.status === 'published' && row) {
    c.executionCtx.waitUntil(
      firePostPublished(c.env, {
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        via: 'admin',
        // 加密/会员锁文标志：广场同步插件据此跳过（防泄漏清单同口径）
        locked: !!row.password_hash || (!!row.min_tier && row.min_tier !== 'all'),
      })
    )
  }
  const categoryId = row ? await getPostCategoryId(c.env.DB, row.id) : null
  return c.json({ ok: true, post: row ? { ...postAdminView(row), tagList: parseTags(row), categoryId } : null })
})

/** 站内文章选择器（编辑器「插入站内文章」）：轻出参——只给标题/slug/摘要/封面/时间，
 *  无正文无口令；q 走 likePattern 模糊匹配标题（与后台列表搜索同口径） */
api.get('/admin/posts/lookup', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 50)
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const r = await listPosts(c.env.DB, { status: 'published', q: q || undefined, page, limit: 8 })
  return c.json({
    items: r.items.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: (p.summary || '').slice(0, 80),
      cover: p.cover || '',
      published_at: p.published_at,
      hasPassword: !!p.password_hash,
      minTier: normalizeMinTier(p.min_tier),
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

api.get('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const row = await getPostById(c.env.DB, id)
  if (!row) return jsonError('文章不存在', 404)
  const categoryId = await getPostCategoryId(c.env.DB, row.id)
  return c.json({ post: { ...postAdminView(row), tagList: parseTags(row), categoryId } })
})

api.put('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const existing = await getPostById(c.env.DB, id)
  if (!existing) return jsonError('文章不存在', 404)
  const p = await readPostPayload(c)
  if (!p) return jsonError('请求格式错误')
  if ('tooBig' in p) return jsonError('正文过长（上限约 1MB）')
  // 缺键即保留（编辑器恒发全量；列表页状态切换只发 status——缺 content/tags 等键时不能清空）
  const title = p.has.title ? p.title || '无标题' : existing.title
  const slug = p.has.slug && p.slug && p.slug !== existing.slug ? await uniqueSlug(c.env.DB, p.slug, id) : existing.slug
  const content = p.has.content ? sanitizeHtml(p.content) : existing.content
  // status 先解析（部分更新语义：缺键沿用库里状态），summary 兜底按解析后的状态算，别用 payload 默认值。
  // 密码文的自动摘要同样留空（同 POST 创建口径）：summary 是公开导读面，加密正文不出前 80 字
  const status = p.has.status ? p.status : existing.status
  const willLock = p.has.password ? !!p.password : !!existing.password_hash
  const summary = p.has.summary ? p.summary || (willLock ? '' : status === 'published' ? excerpt(content, 80) : '') : existing.summary
  const cover = p.has.cover ? p.cover : existing.cover
  const tags = p.has.tags ? JSON.stringify(p.tags) : existing.tags
  const pinned = p.has.pinned ? p.pinned : existing.pinned
  const minTier = p.has.minTier ? p.minTier : normalizeMinTier(existing.min_tier)
  // 草稿也保留已有 published_at：采集插件会把原文发布时间写入草稿，
  // 自动保存不能把它抹掉；发布时若草稿已有时间则沿用。
  // publish_at 只在 scheduled 状态下有意义：定时保存写入目标时间，
  // 转发布/草稿时清空；scheduled 但没给时间则保留旧值（自动保存场景）
  const publishedAt = status === 'published' ? (existing.published_at ?? Date.now()) : existing.published_at
  const publishAt = status === 'scheduled' ? (p.publishAt ?? existing.publish_at ?? null) : null
  // scheduled 但新旧都没有时间：拒绝而不是落 NULL 卡死在定时态（编辑器有校验，这里拦 API 直调）
  if (status === 'scheduled' && publishAt == null) return jsonError('定时发布必须填写发布时间')
  // 访问密码：键存在才参与（空串解除、非空设置/更换），缺键保持原值——自动安全永远不误清
  const passwordHash = p.has.password ? (p.password ? await hashPostPassword(p.password) : '') : existing.password_hash || ''
  await c.env.DB.prepare(
    `UPDATE posts SET slug = ?, title = ?, content = ?, summary = ?, cover = ?, tags = ?, status = ?, pinned = ?, published_at = ?, publish_at = ?, min_tier = ?, password_hash = ?, updated_at = ? WHERE id = ?`
  )
    .bind(
      slug,
      title,
      content,
      summary,
      cover,
      tags,
      status,
      pinned,
      publishedAt,
      publishAt,
      minTier,
      passwordHash,
      Date.now(),
      id
    )
    .run()
  const row = await getPostById(c.env.DB, id)
  if (p.categoryId != null) {
    const cat = await getCategoryById(c.env.DB, p.categoryId)
    if (cat) await setPostCategory(c.env.DB, id, cat.id)
  } else if (p.has.categoryId) {
    // 显式传了 null/空 = 清除分类；完全没传这个键 = 保持现有分类不动
    await setPostCategory(c.env.DB, id, null)
  }
  const categoryId = await getPostCategoryId(c.env.DB, id)
  // 广播发布事件：只在草稿/定时 → 已发布的跃迁时触发，重复编辑已发布文章不重推
  if (status === 'published' && existing.status !== 'published' && row) {
    c.executionCtx.waitUntil(
      firePostPublished(c.env, {
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        via: 'admin',
        // 加密/会员锁文标志：广场同步插件据此跳过（防泄漏清单同口径）
        locked: !!row.password_hash || (!!row.min_tier && row.min_tier !== 'all'),
      })
    )
  }
  return c.json({ ok: true, post: row ? { ...postAdminView(row), tagList: parseTags(row), categoryId } : null })
})

api.post('/admin/posts/:id/pin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  const body = await c.req.json<{ pinned?: boolean }>().catch(() => null)
  // 与 weibo 置顶同口径：存在性检查（不存在的 id 不能假装 ok）+ 草稿拒绝；
  // 多篇文章可同时置顶是产品语义，不加 weibo 的单置顶占位
  const existing = await getPostById(c.env.DB, id)
  if (!existing) return jsonError('文章不存在', 404)
  if (body?.pinned && !existing.pinned && existing.status !== 'published') return jsonError('草稿不能置顶，先发布吧')
  await c.env.DB.prepare('UPDATE posts SET pinned = ?, updated_at = ? WHERE id = ?')
    .bind(body?.pinned ? 1 : 0, Date.now(), id)
    .run()
  return c.json({ ok: true })
})

api.delete('/admin/posts/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('文章不存在', 404)
  // 软删进回收站（src/trash.ts）：评论与分类关联保留，恢复时一并跟回；彻底删除才级联清掉
  await c.env.DB.prepare('UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  return c.json({ ok: true })
})

/* ---------------- 微博管理（随手记） ---------------- */
const WEIBO_MAX_PINNED = 3

async function readWeiboPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const content = String(b.content ?? '').trim().slice(0, WEIBO_MAX_CHARS)
  return {
    content,
    // 话题从正文 #话题# 自动提取，不接受客户端直传
    topics: extractWeiboTopics(content),
    images: parseWeiboImages(b.images),
    status: b.status === 'published' ? 'published' : 'draft',
  }
}

api.get('/admin/weibo', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'published' || statusParam === 'draft' ? statusParam : 'all'
  const r = await listWeibo(c.env.DB, {
    status,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 100, 20),
    pinnedFirst: true,
  })
  const cmtCounts = await weiboCommentCountMap(c.env.DB, r.items.map((w) => w.id))
  return c.json({
    items: r.items.map((w) => ({
      ...w,
      imageList: weiboImageList(w),
      topicList: weiboTopicList(w),
      commentCount: cmtCounts.get(w.id) || 0,
    })),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

/* 单条取原稿（前台卡片「编辑」用：正文要拿未转义原文，DOM 里的渲染文本反解不可靠） */
api.get('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const row = await getWeiboById(c.env.DB, id)
  if (!row) return jsonError('这条微博不存在', 404)
  return c.json({ weibo: { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row) } })
})

api.post('/admin/weibo', async (c) => {
  const p = await readWeiboPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.content && !p.images.length) return jsonError('写点什么，或者配张图吧')
  const now = Date.now()
  const res = await c.env.DB.prepare(
    'INSERT INTO weibo (content, images, topics, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(p.content, JSON.stringify(p.images), JSON.stringify(p.topics), p.status, p.status === 'published' ? now : null, now, now)
    .run()
  const row = await getWeiboById(c.env.DB, Number(res.meta.last_row_id))
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）：新建即发布才算
  if (p.status === 'published' && row) {
    c.executionCtx.waitUntil(fireWeiboPublished(c.env, { id: row.id, content: row.content, images: weiboImageList(row), via: 'admin' }))
  }
  return c.json({ ok: true, weibo: row ? { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row) } : null })
})

api.put('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const existing = await getWeiboById(c.env.DB, id)
  if (!existing) return jsonError('这条微博不存在', 404)
  const p = await readWeiboPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.content && !p.images.length) return jsonError('写点什么，或者配张图吧')
  const publishedAt = p.status === 'published' ? (existing.published_at ?? Date.now()) : null
  // 转回草稿时自动取消置顶
  const pinned = p.status === 'published' ? existing.pinned : 0
  await c.env.DB.prepare(
    'UPDATE weibo SET content = ?, images = ?, topics = ?, status = ?, pinned = ?, published_at = ?, updated_at = ? WHERE id = ?'
  )
    .bind(p.content, JSON.stringify(p.images), JSON.stringify(p.topics), p.status, pinned, publishedAt, Date.now(), id)
    .run()
  const row = await getWeiboById(c.env.DB, id)
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）：仅草稿 → 发布的跃迁，编辑已发布微博不触发
  if (p.status === 'published' && row && existing.status !== 'published') {
    c.executionCtx.waitUntil(fireWeiboPublished(c.env, { id: row.id, content: row.content, images: weiboImageList(row), via: 'draft' }))
  }
  return c.json({ ok: true, weibo: row ? { ...row, imageList: weiboImageList(row), topicList: weiboTopicList(row) } : null })
})

api.post('/admin/weibo/:id/pin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  const body = await c.req.json<{ pinned?: boolean }>().catch(() => null)
  const existing = await getWeiboById(c.env.DB, id)
  if (!existing) return jsonError('这条微博不存在', 404)
  if (body?.pinned && !existing.pinned) {
    if (existing.status !== 'published') return jsonError('草稿不能置顶，先发布吧')
    // 条件更新原子占位：并发置顶时只有凑满名额的那次生效（count-then-update 有竞态窗口）；
    // 名额统计排除回收站行，已删微博不占坑
    const res = await c.env.DB.prepare(
      `UPDATE weibo SET pinned = 1, updated_at = ? WHERE id = ?
       AND (SELECT COUNT(*) FROM weibo WHERE pinned = 1 AND deleted_at IS NULL AND id != ?) < ?`
    )
      .bind(Date.now(), id, id, WEIBO_MAX_PINNED)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError(`最多置顶 ${WEIBO_MAX_PINNED} 条微博，先取消一条吧`)
    return c.json({ ok: true })
  }
  await c.env.DB.prepare('UPDATE weibo SET pinned = ?, updated_at = ? WHERE id = ?')
    .bind(body?.pinned ? 1 : 0, Date.now(), id)
    .run()
  return c.json({ ok: true })
})

api.delete('/admin/weibo/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('这条微博不存在', 404)
  // 软删进回收站（src/trash.ts）：评论保留，恢复时一并跟回；彻底删除才级联清掉
  await c.env.DB.prepare('UPDATE weibo SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  return c.json({ ok: true })
})

/** 服务端插件「微博同步 Buffer」的渠道拉取：设置页一键填充渠道 ID（src/hooks.ts listBufferChannels） */
api.post('/admin/buffer/channels', async (c) => {
  // 演示站禁外发：Buffer 渠道拉取是出网请求，demo 下不存在（体验者填的 Key 不能打出去）
  if (isDemo(c.env)) return jsonError('演示站不开放服务端插件外呼', 404)
  const body = await c.req.json<{ token?: string }>().catch(() => null)
  // token 缺省时用已保存的（打码占位符提交 = 保持原值，与 SECRET_SETTINGS 同口径）
  const saved = (await getSettings(c.env.DB)).bufferAccessToken || ''
  const token = (body?.token || '').trim()
  const using = token || (saved && saved !== SECRET_MASK ? saved : '')
  if (!using) return jsonError('先填写 Buffer API Key，再拉取渠道')
  const r = await listBufferChannels(using)
  if (!r.ok) return jsonError(r.error, 502)
  return c.json({ ok: true, channels: r.channels })
})

/* ---------------- 友情链接管理 ---------------- */
const LINK_ICON_MAX_BYTES = 300 * 1024
const ICON_FETCH_UA = 'Mozilla/5.0 (compatible; BlogHaoBot/1.0; +https://github.com/bloghao/bloghao)'

/** 校验友链图标地址：只收站内 /images/ 与 http(s) 外链，防 javascript: 注入 */
function normalizeLinkIcon(input: unknown): string {
  const s = String(input ?? '').trim().slice(0, 500)
  return s.startsWith('/images/') || /^https?:\/\//i.test(s) ? s : ''
}

async function readLinkPayload(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  return {
    name: String(b.name ?? '').trim().slice(0, 40),
    url: normalizeLinkUrl(String(b.url ?? '')),
    description: String(b.description ?? '').trim().slice(0, 120),
    icon: normalizeLinkIcon(b.icon),
    status: b.status === 'pending' ? 'pending' : 'approved',
    sort: clampInt(b.sort, 0, 9999, 0),
  }
}

/** 把抓到的 favicon 存进 R2 图床，返回站内地址；类型/大小不对或抓取失败返回空串 */
async function storeLinkIcon(env: Env, iconUrl: string, host: string): Promise<string> {
  try {
    const res = await fetch(iconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': ICON_FETCH_UA },
    })
    if (!res.ok) return ''
    const buf = await res.arrayBuffer()
    if (!buf.byteLength || buf.byteLength > LINK_ICON_MAX_BYTES) return ''
    // 只认文件魔数、不信任源站 Content-Type（同 collect 转存口径）：favicon 常是 ICO（sniffImageExt 不认），单独判魔数
    const h = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
    const ext = h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0 ? 'ico' : sniffImageExt(buf)
    if (!ext) return ''
    const mime = ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const key = `u/fav/${host.replace(/[^a-z0-9.-]/gi, '')}.${ext}`
    await env.IMAGES.put(key, buf, {
      httpMetadata: { contentType: mime, cacheControl: 'public, max-age=604800' },
    })
    return `/images/${key}`
  } catch {
    return ''
  }
}

/** 到目标站抓图标：先试 /favicon.ico，再解析首页 <link rel="…icon…"> 兜底 */
async function fetchLinkIcon(env: Env, siteUrl: string): Promise<string> {
  let origin = ''
  let host = ''
  try {
    const u = new URL(siteUrl)
    origin = u.origin
    host = u.host
  } catch {
    return ''
  }
  const direct = await storeLinkIcon(env, `${origin}/favicon.ico`, host)
  if (direct) return direct
  try {
    const res = await fetch(origin + '/', {
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': ICON_FETCH_UA, accept: 'text/html' },
    })
    if (res.ok) {
      const html = (await res.text()).slice(0, 200_000)
      const tag = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]
      const href = tag?.match(/href=["']([^"']+)["']/i)?.[1]
      if (href) return storeLinkIcon(env, new URL(href, res.url || origin).toString(), host)
    }
  } catch {
    /* 超时 / 网络不通，按拿不到处理 */
  }
  return ''
}

api.get('/admin/links', async (c) => {
  const statusParam = c.req.query('status')
  const status = statusParam === 'approved' || statusParam === 'pending' ? statusParam : 'all'
  const r = await listFriendLinks(c.env.DB, { status })
  return c.json({
    // 不回传提交者 ip
    items: r.items.map((l) => ({
      id: l.id,
      name: l.name,
      url: l.url,
      description: l.description,
      icon: l.icon,
      status: l.status,
      sort: l.sort,
      source: l.source,
      created_at: l.created_at,
      updated_at: l.updated_at,
    })),
    total: r.total,
    pending: r.pending,
  })
})

api.post('/admin/links', async (c) => {
  const p = await readLinkPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.name || !p.url) return jsonError('站名和网址不能为空')
  const now = Date.now()
  const res = await c.env.DB.prepare(
    "INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'admin', '', ?, ?)"
  )
    .bind(p.name, p.url, p.description, p.icon, p.status, p.sort, now, now)
    .run()
  return c.json({ ok: true, link: await getFriendLinkById(c.env.DB, Number(res.meta.last_row_id)) })
})

api.post('/admin/links/fetch-icon', async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null)
  const url = normalizeLinkUrl(String(body?.url ?? ''))
  if (!url) return jsonError('网址格式不对，填一下要抓图标的站点地址')
  const icon = await fetchLinkIcon(c.env, url)
  if (!icon) return jsonError('没能取到该站的图标，可以手动填图标地址')
  return c.json({ ok: true, icon })
})

/** 收录（pending → approved）；没图标的转到后台异步抓，不卡响应 */
api.post('/admin/links/:id/approve', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  await c.env.DB.prepare("UPDATE friend_links SET status = 'approved', updated_at = ? WHERE id = ?")
    .bind(Date.now(), id)
    .run()
  if (!existing.icon) {
    c.executionCtx.waitUntil(
      fetchLinkIcon(c.env, existing.url).then((icon) =>
        icon
          ? c.env.DB.prepare('UPDATE friend_links SET icon = ?, updated_at = ? WHERE id = ?').bind(icon, Date.now(), id).run()
          : undefined
      )
    )
  }
  return c.json({ ok: true })
})

api.post('/admin/links/:id/refresh-icon', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  const icon = await fetchLinkIcon(c.env, existing.url)
  if (!icon) return jsonError('没能取到该站的图标，可在编辑里手动填图标地址')
  await c.env.DB.prepare('UPDATE friend_links SET icon = ?, updated_at = ? WHERE id = ?').bind(icon, Date.now(), id).run()
  return c.json({ ok: true, icon })
})

/** 上移 / 下移：按当前顺序交换后整体回写 sort = 下标（幂等，不怕历史脏数据） */
api.post('/admin/links/reorder', async (c) => {
  const body = await c.req.json<{ id?: number; dir?: string }>().catch(() => null)
  const id = Number(body?.id)
  const dir = body?.dir === 'down' ? 'down' : 'up'
  const items = (await listFriendLinks(c.env.DB, { status: 'approved' })).items
  const idx = items.findIndex((l) => l.id === id)
  if (idx < 0) return jsonError('友链不存在', 404)
  const to = dir === 'up' ? idx - 1 : idx + 1
  if (to < 0 || to >= items.length) return c.json({ ok: true })
  ;[items[idx], items[to]] = [items[to], items[idx]]
  await c.env.DB.batch(
    items.map((l, i) => c.env.DB.prepare('UPDATE friend_links SET sort = ? WHERE id = ?').bind(i, l.id))
  )
  return c.json({ ok: true })
})

api.put('/admin/links/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  const existing = await getFriendLinkById(c.env.DB, id)
  if (!existing) return jsonError('友链不存在', 404)
  const p = await readLinkPayload(c)
  if (!p) return jsonError('请求格式错误')
  if (!p.name || !p.url) return jsonError('站名和网址不能为空')
  await c.env.DB.prepare(
    'UPDATE friend_links SET name = ?, url = ?, description = ?, icon = ?, status = ?, sort = ?, updated_at = ? WHERE id = ?'
  )
    .bind(p.name, p.url, p.description, p.icon, p.status, p.sort, Date.now(), id)
    .run()
  return c.json({ ok: true, link: await getFriendLinkById(c.env.DB, id) })
})

api.delete('/admin/links/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('友链不存在', 404)
  await c.env.DB.prepare('DELETE FROM friend_links WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

/* ---------------- 分类管理 ---------------- */

/** 校验并规整分类的 slug：留空则用名称本身（中文可作 slug，URL 会编码） */
function normalizeCategorySlug(input: string, name: string): string {
  const s = (input || name).trim().slice(0, 80)
  if (!s || /[\/\\#?%\s]/.test(s)) return ''
  return s
}

api.get('/admin/categories', async (c) => {
  const categories = await listCategories(c.env.DB, { withCount: true })
  return c.json({ categories })
})

api.post('/admin/categories', async (c) => {
  const body = await c.req.json<{ name?: string; slug?: string; sort?: number }>().catch(() => null)
  const name = String(body?.name ?? '').trim().slice(0, 20)
  if (!name) return jsonError('分类名称不能为空')
  const slug = normalizeCategorySlug(String(body?.slug ?? ''), name)
  if (!slug) return jsonError('分类标识只能用字母、数字、中文和短横线')
  const dup = await c.env.DB.prepare('SELECT id FROM categories WHERE name = ? OR slug = ?').bind(name, slug).first<{ id: number }>()
  if (dup) return jsonError('同名或同标识的分类已存在')
  const sort = clampInt(body?.sort, 0, 9999, 0)
  const cat = await createCategory(c.env.DB, name, slug, sort)
  return c.json({ ok: true, category: cat })
})

api.put('/admin/categories/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('分类不存在', 404)
  const existing = await getCategoryById(c.env.DB, id)
  if (!existing) return jsonError('分类不存在', 404)
  const body = await c.req.json<{ name?: string; slug?: string; sort?: number }>().catch(() => null)
  const name = String(body?.name ?? existing.name).trim().slice(0, 20)
  if (!name) return jsonError('分类名称不能为空')
  const slug = normalizeCategorySlug(String(body?.slug ?? existing.slug), name)
  if (!slug) return jsonError('分类标识只能用字母、数字、中文和短横线')
  const dup = await c.env.DB
    .prepare('SELECT id FROM categories WHERE (name = ? OR slug = ?) AND id != ?')
    .bind(name, slug, id)
    .first<{ id: number }>()
  if (dup) return jsonError('同名或同标识的分类已存在')
  const sort = clampInt(body?.sort, 0, 9999, existing.sort)
  await c.env.DB.prepare('UPDATE categories SET name = ?, slug = ?, sort = ? WHERE id = ?').bind(name, slug, sort, id).run()
  return c.json({ ok: true, category: await getCategoryById(c.env.DB, id) })
})

api.delete('/admin/categories/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('分类不存在', 404)
  // 分类删除后文章变为未分类，文章本身不受影响
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM post_categories WHERE category_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
  ])
  return c.json({ ok: true })
})

/* ---------------- 独立页面 ---------------- */

api.get('/admin/pages', async (c) => {
  return c.json({ pages: await listPages(c.env.DB) })
})

api.post('/admin/pages', async (c) => {
  const body = await c.req
    .json<{ title?: string; slug?: string; content?: string; status?: string; show_in_nav?: boolean | string }>()
    .catch(() => null)
  const title = String(body?.title ?? '').trim().slice(0, 60)
  if (!title) return jsonError('页面标题不能为空')
  // slug 留空由标题生成（posts 同款 slugify），中文标题回退 dateSlug（北京日期 + 随机位）
  const base = cleanSlug(String(body?.slug ?? '')) || slugify(title)
  const slug = await uniquePageSlug(c.env.DB, base.slice(0, 80))
  const content = sanitizeHtml(String(body?.content ?? '').slice(0, 100_000))
  const status = body?.status === 'published' ? 'published' : 'draft'
  const showInNav = body?.show_in_nav === true || body?.show_in_nav === '1' ? 1 : 0
  const now = Date.now()
  const res = await c.env.DB
    .prepare(
      'INSERT INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    )
    .bind(title, slug, content, status, showInNav, now, now)
    .run()
  return c.json({ ok: true, page: await getPageById(c.env.DB, Number(res.meta.last_row_id)) })
})

api.put('/admin/pages/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('页面不存在', 404)
  const existing = await getPageById(c.env.DB, id)
  if (!existing) return jsonError('页面不存在', 404)
  const body = await c.req
    .json<{ title?: string; slug?: string; content?: string; status?: string; show_in_nav?: boolean | string }>()
    .catch(() => null)
  const title = String(body?.title ?? existing.title).trim().slice(0, 60)
  if (!title) return jsonError('页面标题不能为空')
  const base = cleanSlug(String(body?.slug ?? '')) || existing.slug
  const slug = await uniquePageSlug(c.env.DB, base.slice(0, 80), id)
  const content = sanitizeHtml(String(body?.content ?? existing.content).slice(0, 100_000))
  // 部分更新语义：status / show_in_nav 未提供时沿用旧值，不做静默重置
  const status = body?.status === 'published' ? 'published' : body?.status === 'draft' ? 'draft' : existing.status
  const showInNav = body?.show_in_nav == null ? existing.show_in_nav : body?.show_in_nav === true || body?.show_in_nav === '1' ? 1 : 0
  await c.env.DB
    .prepare('UPDATE pages SET title = ?, slug = ?, content = ?, status = ?, show_in_nav = ?, updated_at = ? WHERE id = ?')
    .bind(title, slug, content, status, showInNav, Date.now(), id)
    .run()
  return c.json({ ok: true, page: await getPageById(c.env.DB, id) })
})

api.delete('/admin/pages/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('页面不存在', 404)
  // 软删进回收站（src/trash.ts）；about 页删除后 /about 走 legacy settings 回退分支
  await c.env.DB.prepare('UPDATE pages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), id).run()
  return c.json({ ok: true })
})

// 上移 / 下移：按当前顺序交换后整体回写 sort = 下标（照 friend_links/reorder 模式，幂等不怕脏数据）
api.post('/admin/pages/reorder', async (c) => {
  const body = await c.req.json<{ id?: number; dir?: string }>().catch(() => null)
  const id = Number(body?.id)
  const items = await listPages(c.env.DB)
  const idx = items.findIndex((p) => p.id === id)
  if (idx < 0) return jsonError('页面不存在', 404)
  const to = body?.dir === 'up' ? idx - 1 : idx + 1
  if (to < 0 || to >= items.length) return c.json({ ok: true })
  ;[items[idx], items[to]] = [items[to], items[idx]]
  await c.env.DB.batch(items.map((p, i) => c.env.DB.prepare('UPDATE pages SET sort = ? WHERE id = ?').bind(i, p.id)))
  return c.json({ ok: true })
})

/* ---------------- 回收站（三表软删，机制与清理见 src/trash.ts） ---------------- */
api.get('/admin/trash', async (c) => {
  const typeParam = c.req.query('type')
  const table = typeParam ? trashTable(typeParam) : null
  if (typeParam && !table) return jsonError('未知的回收站类型')
  return c.json(await listTrash(c.env.DB, { type: table, page: clampInt(c.req.query('page'), 1, 1000, 1) }))
})

api.post('/admin/trash/:type/:id/restore', async (c) => {
  const table = trashTable(c.req.param('type'))
  const id = parseId(c.req.param('id'))
  if (!table || !id) return jsonError('内容不存在', 404)
  if (table === 'posts') {
    const row = await getPostById(c.env.DB, id)
    if (!row || row.deleted_at == null) return jsonError('回收站里没有这条内容', 404)
    // 过期的定时文恢复为草稿（restorePostStatus），防「恢复即撞发」；顺带清掉 publish_at，
    // 回到「非 scheduled 不留定时点」，防止这条草稿之后被切回 scheduled 时按旧时间立即撞发
    const status = restorePostStatus(row.status, row.publish_at, Date.now())
    const expiredScheduled = row.status === 'scheduled' && status === 'draft'
    const res = await c.env.DB
      .prepare(
        expiredScheduled
          ? 'UPDATE posts SET deleted_at = NULL, status = ?, publish_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'
          : 'UPDATE posts SET deleted_at = NULL, status = ? WHERE id = ? AND deleted_at IS NOT NULL'
      )
      .bind(status, id)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
  } else {
    const res = await c.env.DB
      .prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`)
      .bind(id)
      .run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
  }
  return c.json({ ok: true })
})

api.delete('/admin/trash/:type/:id', async (c) => {
  const table = trashTable(c.req.param('type'))
  const id = parseId(c.req.param('id'))
  if (!table || !id) return jsonError('内容不存在', 404)
  // 彻底删除只作用于已在回收站的行（deleted_at IS NOT NULL 防误删存活数据），batch 事务内级联清评论。
  // 级联必须在主行 DELETE 之前、且用「xx_id IN (回收站行)」子查询守卫：主行先删的话子查询就看不到它了；
  // 行还活着时子查询匹配不到，级联不动任何数据，主 DELETE 0 行 → 404
  if (table === 'posts') {
    const cascade = 'AND post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'
    const res = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM comments WHERE post_id = ? ${cascade}`).bind(id),
      c.env.DB.prepare(`DELETE FROM post_categories WHERE post_id = ? ${cascade}`).bind(id),
      c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND deleted_at IS NOT NULL').bind(id),
    ])
    // 用 < 1 而非 !== 1：DELETE 触发器（FTS 索引同步，db.ts SCHEMA_TRIGGERS）会让 meta.changes
    // 把触发器内的 FTS 删除命令也计进去，单行删除的 changes 可能是 1 也可能是 2+（D1 实测为 2）；
    // 0 行匹配时触发器不运行、changes 恒为 0，所以「< 1 = 什么都没删」在两种计数口径下都成立
    if ((res[2].meta.changes ?? 0) < 1) return jsonError('回收站里没有这条内容', 404)
  } else if (table === 'weibo') {
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM comments WHERE weibo_id = ? AND weibo_id IN (SELECT id FROM weibo WHERE deleted_at IS NOT NULL)'
      ).bind(id),
      c.env.DB.prepare('DELETE FROM weibo WHERE id = ? AND deleted_at IS NOT NULL').bind(id),
    ])
    // 同 posts：< 1 口径（weibo_fts 删除触发器会把 changes 计成 2）
    if ((res[1].meta.changes ?? 0) < 1) return jsonError('回收站里没有这条内容', 404)
  } else {
    const res = await c.env.DB.prepare('DELETE FROM pages WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run()
    if ((res.meta.changes ?? 0) !== 1) return jsonError('回收站里没有这条内容', 404)
  }
  return c.json({ ok: true })
})

/** 清空回收站（body 可选 {type} 定向清空一类）；级联子查询在一个 batch 事务内完成 */
api.post('/admin/trash/purge', async (c) => {
  const body = await c.req.json<{ type?: string }>().catch(() => null)
  let table: TrashTable | null = null
  if (body?.type) {
    table = trashTable(body.type)
    if (!table) return jsonError('未知的回收站类型')
  }
  const stmts: D1PreparedStatement[] = []
  if (!table || table === 'posts') {
    stmts.push(
      c.env.DB.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM post_categories WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM posts WHERE deleted_at IS NOT NULL')
    )
  }
  if (!table || table === 'weibo') {
    stmts.push(
      c.env.DB.prepare('DELETE FROM comments WHERE weibo_id IN (SELECT id FROM weibo WHERE deleted_at IS NOT NULL)'),
      c.env.DB.prepare('DELETE FROM weibo WHERE deleted_at IS NOT NULL')
    )
  }
  if (!table || table === 'pages') {
    stmts.push(c.env.DB.prepare('DELETE FROM pages WHERE deleted_at IS NOT NULL'))
  }
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

api.get('/admin/tags', async (c) => {
  // 文章里实际用到的标签（含草稿，不含回收站）+ 分类页预建的标签（count 为 0）
  const [postsRes, extraRes] = await Promise.all([
    c.env.DB.prepare('SELECT tags FROM posts WHERE deleted_at IS NULL LIMIT 2000').all<{ tags: string }>(),
    c.env.DB.prepare('SELECT name FROM tags').all<{ name: string }>(),
  ])
  const count = new Map<string, number>()
  for (const r of postsRes.results ?? []) {
    for (const t of parseTags({ tags: r.tags } as PostRow)) count.set(t, (count.get(t) || 0) + 1)
  }
  for (const r of extraRes.results ?? []) if (!count.has(r.name)) count.set(r.name, 0)
  return c.json({
    tags: [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 200)
      .map(([name, n]) => ({ name, count: n })),
  })
})

api.post('/admin/tags', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null)
  const name = String(body?.name ?? '').trim().slice(0, 20)
  if (!name) return jsonError('标签名不能为空')
  const dup = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first<{ id: number }>()
  if (dup) return jsonError('这个标签已存在')
  await c.env.DB.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)').bind(name, Date.now()).run()
  return c.json({ ok: true })
})

api.delete('/admin/tags/:name', async (c) => {
  const name = c.req.param('name').trim().slice(0, 20)
  if (!name) return jsonError('参数错误')
  // 从所有文章的标签里移除该标签（LIKE 预筛后再精确过滤）
  const { results } = await c.env.DB
    .prepare("SELECT id, tags FROM posts WHERE tags LIKE ? ESCAPE '\\'")
    .bind(jsonItemLikePattern(name))
    .all<{ id: number; tags: string }>()
  const stmts = (results ?? [])
    .filter((r) => parseTags({ tags: r.tags } as PostRow).includes(name))
    .map((r) => {
      const kept = parseTags({ tags: r.tags } as PostRow).filter((t) => t !== name)
      return c.env.DB.prepare('UPDATE posts SET tags = ? WHERE id = ?').bind(JSON.stringify(kept), r.id)
    })
  stmts.push(c.env.DB.prepare('DELETE FROM tags WHERE name = ?').bind(name))
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

/* ---------------- 媒体库（R2 图床） ---------------- */
api.post('/admin/upload', async (c) => {
  if (!rateLimit(`upload:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('上传太频繁，请稍后再试', 429)
  const body = await c.req.parseBody().catch(() => null)
  const file = body && typeof body === 'object' ? ((body as Record<string, unknown>)['file'] as unknown) : null
  if (!(file instanceof File)) return jsonError('缺少文件字段 file')
  const mime = file.type || 'application/octet-stream'
  // 白名单查表统一走 imageExtOf（内部 hasOwnProperty 挡原型链穿透）
  const declared =
    imageExtOf(mime) ??
    (Object.prototype.hasOwnProperty.call(VIDEO_MIMES, mime) ? VIDEO_MIMES[mime] : undefined)
  if (!declared) return jsonError('仅支持 JPG / PNG / WebP / GIF 图片与 MP4 / WebM 视频')
  if (file.size > MAX_UPLOAD_BYTES) return jsonError('文件超过 25MB 限制')
  const buf = await file.arrayBuffer()
  // 类型只认文件魔数（与转存链路同口径）：声明成图片但内容是 HTML/SVG/其它的一律拒收；
  // 魔数与声明不符时按魔数落库（mime 取识别出的真实类型）
  const ext = sniffUploadExt(buf)
  if (!ext) return jsonError('文件内容不是支持的格式（仅认文件魔数）')
  const realMime =
    ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const url = await saveUpload(c.env, buf, realMime, file.name, ext)
  return c.json({ ok: true, url, key: url.slice('/images/'.length), mime: realMime, size: buf.byteLength })
})

api.get('/admin/uploads', async (c) => {
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const limit = 24
  const [listRes, countRes] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM uploads ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, (page - 1) * limit)
      .all<{ id: number; key: string; name: string; mime: string; size: number; created_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first<{ n: number }>(),
  ])
  return c.json({
    items: (listRes.results ?? []).map((u) => ({ ...u, url: `/images/${u.key}` })),
    total: countRes?.n ?? 0,
    page,
  })
})

api.delete('/admin/uploads', async (c) => {
  const key = c.req.query('key') || ''
  // og/ 与 u/ 同为媒体库可管理的图床目录（OG 分享卡图），前缀白名单挡住 backups/ 等其余 key
  if (!key.startsWith('u/') && !key.startsWith('og/')) return jsonError('非法的文件 Key')
  await Promise.all([
    c.env.IMAGES.delete(key),
    c.env.DB.prepare('DELETE FROM uploads WHERE key = ?').bind(key).run(),
  ])
  return c.json({ ok: true })
})

/* ---------------- 媒体体检：未引用 / 重复文件扫描与安全清理（逻辑在 src/audit.ts） ---------------- */

api.get('/admin/uploads/audit', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  return c.json(await runAudit(c.env))
})

api.post('/admin/uploads/hash-backfill', async (c) => {
  // 前端回填是循环连发（每批最多 50 个），不能与 audit 的 10/分钟共桶；独立桶放宽到 60/分钟仍有界
  if (!rateLimit(`backfill:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ limit?: number }>().catch(() => null)
  return c.json(await backfillHashes(c.env, Number(b?.limit) || 25))
})

api.post('/admin/uploads/merge', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ keep?: unknown; remove?: unknown }>().catch(() => null)
  if (!b || typeof b.keep !== 'string' || !Array.isArray(b.remove)) return jsonError('参数不完整')
  try {
    return c.json({ ok: true, ...(await mergeDuplicate(c.env, b.keep, b.remove)) })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '合并失败')
  }
})

api.post('/admin/uploads/cleanup', async (c) => {
  if (!rateLimit(`audit:${clientIp(c.req.raw)}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const b = await c.req.json<{ keys?: unknown }>().catch(() => null)
  if (!b || !Array.isArray(b.keys)) return jsonError('参数不完整')
  try {
    return c.json({ ok: true, ...(await cleanupUnreferenced(c.env, b.keys)) })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : '清理失败')
  }
})

/* ---------------- OG 分享卡图 ----------------
 * 编辑器用 canvas 把标题+封面绘成 1200x630 PNG 上传到这里，R2 og/ 目录。
 * 独立于普通上传：key 前缀 og/，删除文章卡图的入口在编辑器里。
 */
api.post('/admin/og-image', async (c) => {
  if (!rateLimit(`upload:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('上传太频繁，请稍后再试', 429)
  const body = await c.req.parseBody().catch(() => null)
  const file = body && typeof body === 'object' ? ((body as Record<string, unknown>)['file'] as unknown) : null
  if (!(file instanceof File)) return jsonError('缺少文件字段 file')
  if (file.type !== 'image/png') return jsonError('OG 卡图仅支持 PNG')
  if (file.size > MAX_UPLOAD_BYTES) return jsonError('文件超过 25MB 限制')
  const buf = await file.arrayBuffer()
  // 魔数复核（与上传同口径）：声明 PNG 但内容不是 PNG 的一律拒收
  if (sniffUploadExt(buf) !== 'png') return jsonError('文件内容不是 PNG')
  const url = await saveUpload(c.env, buf, 'image/png', 'og-card.png', 'png', 'og')
  return c.json({ ok: true, url, key: url.slice('/images/'.length) })
})

/* ---------------- 评论管理 ---------------- */
api.get('/admin/comments', async (c) => {
  const status = c.req.query('status')
  const type = c.req.query('type') // post = 文章评论，weibo = 微博评论，guestbook = 留言板
  const page = clampInt(c.req.query('page'), 1, 1000, 1)
  const limit = 20
  const where: string[] = []
  const binds: unknown[] = []
  if (status === 'approved' || status === 'pending') {
    where.push('c.status = ?')
    binds.push(status)
  }
  if (type === 'post') where.push('c.post_id > 0')
  else if (type === 'weibo') where.push('c.weibo_id > 0')
  else if (type === 'guestbook') where.push('c.post_id = 0 AND c.weibo_id = 0')
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [listRes, countRes, pendingRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.*, p.title AS post_title, p.slug AS post_slug, w.content AS weibo_content, pc.nickname AS parent_nickname
       FROM comments c
       LEFT JOIN posts p ON p.id = c.post_id
       LEFT JOIN weibo w ON w.id = c.weibo_id
       LEFT JOIN comments pc ON pc.id = c.parent_id
       ${whereSql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, (page - 1) * limit)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM comments c ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>(),
    // 全局待审数：侧栏「评论」角标在审核操作后随本接口刷新
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").first<{ n: number }>(),
  ])
  return c.json({ items: listRes.results ?? [], total: countRes?.n ?? 0, page, pending: pendingRes?.n ?? 0 })
})

/** 后台回复评论（文章/微博通用）：挂在同一条顶层评论下，直接展示并带「作者」徽标 */
api.post('/admin/comments/:id/replies', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  const body = await c.req.json<{ content?: string }>().catch(() => null)
  const content = String(body?.content || '').trim().slice(0, 1000)
  if (!content) return jsonError('回复内容不能为空')
  const target = await c.env.DB
    .prepare('SELECT * FROM comments WHERE id = ?')
    .bind(id)
    .first<CommentRow>()
  if (!target) return jsonError('评论不存在', 404)
  const user = c.get('user')
  await c.env.DB.prepare(
    'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, content, status, ip, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)'
  )
    .bind(
      target.post_id,
      target.weibo_id,
      target.parent_id || target.id,
      (user.display_name || user.username).slice(0, 24),
      content,
      'approved',
      '',
      Date.now()
    )
    .run()
  return c.json({ ok: true })
})

api.put('/admin/comments/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  const body = await c.req.json<{ status?: string }>().catch(() => null)
  // status 白名单：拼错值/空 body 不得隐式过审（同 theme/siteMode 枚举口径）
  if (body?.status !== 'approved' && body?.status !== 'pending') return jsonError('status 只允许 approved / pending')
  // 先查后改：目标不存在回 404（同 pin/restore 口径），顺带带出 member_id 供计分
  const target = await c.env.DB.prepare('SELECT member_id FROM comments WHERE id = ?').bind(id).first<{ member_id: number | null }>()
  if (!target) return jsonError('评论不存在', 404)
  const status = body.status
  // 会员评论过审才计积分（awardCommentPoints 按 ref_id 去重，反复 通过↔待审 不重复记）
  await c.env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(status, id).run()
  if (status === 'approved' && target.member_id) {
    c.executionCtx.waitUntil(awardCommentPoints(c.env.DB, target.member_id, id))
  }
  return c.json({ ok: true })
})

api.delete('/admin/comments/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('评论不存在', 404)
  // 回复（楼中楼）一并删除
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ? OR parent_id = ?').bind(id, id).run()
  return c.json({ ok: true })
})

/* ---------------- 设置 ---------------- */
// 敏感项只写不读：GET 一律打码返回（明文只在生成 Token / 保存后不再回显）；
// PUT 收到打码占位符视为「保持原值」，这样前端整表提交不会把占位符写进库
const SECRET_SETTINGS = ['externalToken', 'telegramBotToken', 'telegramWebhookSecret', 'bufferAccessToken', 'plazaToken']
const SECRET_MASK = '••••••••'
// 布尔开关统一收口：'1'/'true' → '1'，其余一律 '0'（新增布尔键加进表即可，别再抄判断分支）
const BOOL_SETTINGS = [
  'allowComments',
  'moderateComments',
  'notifyNewComment',
  'rssFullText',
  'backupEnabled',
  'statsEnabled',
  'siteGrayscale',
  'siteClosed',
  'membersEnabled',
]

api.get('/admin/settings', async (c) => {
  const settings = await getSettings(c.env.DB)
  for (const key of SECRET_SETTINGS) {
    if (settings[key]) settings[key] = SECRET_MASK
  }
  return c.json({ settings })
})

api.put('/admin/settings', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object') return jsonError('请求格式错误')
  const patch: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    if (!(key in body)) continue
    const v = String((body as Record<string, unknown>)[key] ?? '')
    // 打码占位符原样提交 = 用户没改这一项，跳过以免覆盖真实值
    if (SECRET_SETTINGS.includes(key) && v === SECRET_MASK) continue
    // hasOwnProperty 挡住 constructor/toString 等原型链属性穿透成「合法主题」导致全站 500
    if (key === 'theme' && !Object.prototype.hasOwnProperty.call(THEMES, v)) return jsonError('未知主题：' + v)
    if (key === 'siteMode') {
      // 站点模式四值白名单，脏值回退默认（前台 siteMode() 同口径兜底）
      patch[key] = SITE_MODE_VALUES.includes(v as SiteMode) ? v : 'blog-weibo'
      continue
    }
    if (key === 'postsPerPage') {
      patch[key] = String(clampInt(v, 1, 50, 10))
      continue
    }
    if (key === 'about') {
      patch[key] = sanitizeHtml(v.slice(0, 100_000))
      continue
    }
    if (key === 'faviconUrl' || key === 'avatarUrl' || key === 'ogImageDefault') {
      // 只接受站内 /images/ 地址或 http(s) 外链，防止 javascript: 之类注入
      const u = v.trim().slice(0, 500)
      patch[key] = u.startsWith('/images/') || /^https?:\/\//i.test(u) ? u : ''
      continue
    }
    if (key === 'pluginsDisabled') {
      const cleaned = cleanDisabledPlugins(v)
      if (cleaned === null) return jsonError('插件 ID 只能包含字母、数字、_ 或 -')
      patch[key] = cleaned
      continue
    }
    if (key === 'serverPluginsDisabled') {
      const cleaned = cleanDisabledPlugins(v)
      if (cleaned === null) return jsonError('插件 ID 只能包含字母、数字、_ 或 -')
      patch[key] = cleaned
      continue
    }
    if (key === 'tgChannelChatId') {
      patch[key] = v.trim().slice(0, 100)
      continue
    }
    if (key === 'commentWebhookUrl') {
      // 只接受 http(s) 完整地址（webhook 目标），其余清空
      const u = v.trim().slice(0, 500)
      patch[key] = /^https?:\/\//i.test(u) ? u : ''
      continue
    }
    if (key === 'footerHtmlCode') {
      // 站长自定义页脚 HTML（挂件/徽章），与主题 CSS 同信任级：仅管理员可写，渲染时不转义
      patch[key] = v.slice(0, 5000)
      continue
    }
    if (key === 'siteClosedMessage') {
      patch[key] = v.slice(0, 1000)
      continue
    }
    if (BOOL_SETTINGS.includes(key)) {
      patch[key] = v === '1' || v === 'true' ? '1' : '0'
      continue
    }
    if (key === 'rankTopN') {
      // 排行榜展示条数：1-50，脏值回退 10
      patch[key] = String(clampInt(v, 1, 50, 10))
      continue
    }
    if (key === 'edition') {
      // 英文测试版（English 0.1）开关：二值白名单；重新开启即重置回退状态与错误记录
      patch[key] = v === 'en' ? 'en' : 'zh'
      if (patch[key] === 'en') {
        patch.editionEnStatus = 'active'
        patch.editionEnError = ''
        patch.editionEnAt = ''
      }
      continue
    }
    patch[key] = v.slice(0, 500)
  }
  // 演示站不允许闭站：有人开了开关，整个重置周期内所有体验者都会看到 503
  if (isDemo(c.env)) patch.siteClosed = '0'
  await saveSettings(c.env.DB, patch)
  const saved = await getSettings(c.env.DB)
  // 与 GET 同口径：密钥只在生成时返回一次明文，此后任何回显都打码（防代理/扩展被动收集）
  for (const key of SECRET_SETTINGS) {
    if (saved[key]) saved[key] = SECRET_MASK
  }
  return c.json({ ok: true, settings: saved })
})

/* ---------------- 订阅与备份 ---------------- */

/** 手动触发一次全量备份（与每晚 Cron 同一逻辑），返回文件 Key 与体积 */
api.post('/admin/backup', async (c) => {
  // 全表导出整包进内存，连点可在同一 isolate 堆叠多个全量导出（128MB 上限）——全局窗口内只放一次
  if (!rateLimit('backup:global', 1, 10 * 60_000)) return jsonError('备份刚刚执行过，请 10 分钟后再试', 429)
  const r = await runBackup(c.env)
  if (!r.skipped && !r.ok) return jsonError('备份失败：' + (r.error || '未知错误'), 500)
  return c.json({ ok: r.ok, skipped: !!r.skipped, key: r.key, bytes: r.bytes, error: r.error })
})

/* ---------------- 密码 ---------------- */
api.put('/admin/password', async (c) => {
  // 演示站密码公示在登录页，改掉会导致整个重置周期内其他体验者进不了后台
  if (isDemo(c.env)) return jsonError('演示站不支持修改密码', 403)
  const user = c.get('user')
  const body = await c.req.json<{ oldPassword?: string; newPassword?: string }>().catch(() => null)
  const oldPassword = body?.oldPassword || ''
  const newPassword = body?.newPassword || ''
  if (newPassword.length < 8 || newPassword.length > 64) return jsonError('新密码长度需为 8-64 位')
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<{
    password_hash: string
    salt: string
  }>()
  if (!row) return jsonError('用户不存在', 404)
  const { hash } = await hashPassword(oldPassword, row.salt)
  if (!safeEqual(hash, row.password_hash)) return jsonError('旧密码不正确')
  const { hash: newHash, salt: newSalt } = await hashPassword(newPassword)
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, newSalt, Date.now(), user.id)
    .run()
  // 改密后其余会话全部失效（保留当前会话，不把自己踢下线），被盗的旧 token 立即作废
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .bind(user.id, getCookie(c.req.raw, SESSION_COOKIE) ?? '')
    .run()
  return c.json({ ok: true })
})

/* ---------------- 写作工具 ---------------- */
api.post('/admin/tools/md', async (c) => {
  const body = await c.req.json<{ md?: string }>().catch(() => null)
  const md = String(body?.md ?? '')
  // 与正文接口同口径按 UTF-8 字节计（length 是 UTF-16 码元数，全 emoji 输入会虚增 3-4 倍余量）
  if (new TextEncoder().encode(md).length > MAX_CONTENT_BYTES) return jsonError('内容过长')
  return c.json({ html: mdToHtml(md) })
})

/** 链接卡元数据抓取（编辑器「插入链接」卡片风格）：只抓 http(s) 公网页面，
 *  抓不到/解析不到返回空字段，编辑器据已有字段组卡（title 缺失时用域名兜底）。
 *  用户输入的 URL 按用户输入频控；fetch 本身限长限时（src/linkmeta.ts） */
api.post('/admin/tools/linkmeta', async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null)
  const url = String(body?.url ?? '').trim().slice(0, 2048)
  if (!url) return jsonError('请填写链接地址')
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`linkmeta:${ip}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  const meta = await fetchLinkMeta(url)
  return c.json({ meta })
})

/** 书影音组卡用的中转基地址（转存失败时豆瓣封面退中转 /img 兜底）；配置不完整回 null */
function validateRelayBase(relay: string, relayToken: string): string | null {
  return validateRelay(relay, relayToken)?.base ?? null
}

/** 组卡前把外链封面转存进站内图床（卡片永久自持——豆瓣图床有防盗链，浏览器直连必挂）；
 *  转存失败时豆瓣图退中转 /img 或省略（resolveCardCover），非豆瓣源 CDN 无防盗链保留直连 */
async function buildCardWithCover(env: Env, item: MediaItem, relayBase: string | null): Promise<string> {
  const cover = (item.cover || '').trim()
  let transferred: string | null = null
  if (cover && !cover.startsWith('/images/')) {
    transferred = await transferImage(env, cover, '书影音封面', coverReferer(cover) || undefined)
  }
  const resolved = resolveCardCover(cover, transferred, relayBase)
  return buildCardHtml({ ...item, cover: resolved.cover })
}

/** 编辑器结果列表的封面缩略图代理（<img> 自动带同源会话 Cookie，注册在鉴权之后）：
 *  豆瓣图床防盗链（无 Referer 418、外站 403），浏览器直连必挂；白名单限常用封面 CDN，
 *  限频 + 体积上限。仅供编辑器预览——正式卡片走转存（buildCardWithCover），不烘代理地址 */
api.get('/admin/tools/douban/img', async (c) => {
  const raw = c.req.query('u') || ''
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return jsonError('链接不合法')
  }
  if (u.protocol !== 'https:' || !coverProxyHostOk(u.hostname)) return jsonError('域名不在白名单', 403)
  if (!rateLimit(`doubanimg:${clientIp(c.req.raw)}`, 60, 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': BROWSER_UA, Referer: coverReferer(raw) || `${u.origin}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return jsonError('封面拉取失败', 502)
    const ct = String(res.headers.get('content-type') || '').split(';')[0]
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return jsonError('非图片响应', 502)
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > 1_000_000) return jsonError('图片过大', 502)
    c.header('Cache-Control', 'private, max-age=86400')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(buf, 200, { 'Content-Type': ct })
  } catch {
    return jsonError('封面拉取失败', 502)
  }
})

/** 书影音卡片（第三方编辑器插件 douban-media 的数据面），见 src/douban.ts 与 douban-relay/。
 *  中转地址/令牌由插件随请求携带（存插件自己的 localStorage，不进 settings），
 *  本端点只认代码构造的豆瓣地址（粘贴链接仅提取条目 id 重组），不构成开放代理；
 *  插件停用即端点 404（与编辑器侧开关一致），限频同 linkmeta。
 *  封面在组卡时转存进站内图床（buildCardWithCover），零配置即可用；
 *  中转可选，提升豆瓣详情（尤其电影条目页，sec 风控最紧）的成功率 */
api.post('/admin/tools/douban', async (c) => {
  const settings = await getSettings(c.env.DB)
  const disabled = cleanDisabledPlugins(String(settings.pluginsDisabled ?? ''))
  if (disabled === null || disabled.split(',').includes('douban-media')) return jsonError('书影音插件已停用', 404)
  const body = await c.req
    .json<{
      action?: string
      type?: string
      q?: string
      id?: string
      url?: string
      relay?: string
      relayToken?: string
      tmdbKey?: string
      item?: unknown
    }>()
    .catch(() => null)
  const action = String(body?.action ?? '')
  const type = String(body?.type ?? '')
  if (!['search', 'detail', 'card', 'test'].includes(action)) return jsonError('未知操作')
  if (action !== 'test' && action !== 'card' && !['book', 'movie', 'music'].includes(type)) return jsonError('未知类型')
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`douban:${ip}`, 10, 60_000)) return jsonError('操作太频繁，请稍后再试', 429)
  // 外部携带的中转配置收敛长度；TMDB key 是 32 位十六进制（douban.ts 内再校验）
  const relay = String(body?.relay ?? '').trim().slice(0, 2048)
  const relayToken = String(body?.relayToken ?? '').trim().slice(0, 256)
  const tmdbKey = String(body?.tmdbKey ?? '').trim().slice(0, 64)
  try {
    if (action === 'test') return c.json(await probeRelay(relay, relayToken))
    if (action === 'search') {
      const q = String(body?.q ?? '').trim().slice(0, 80)
      if (!q) return jsonError('请输入书名 / 影名 / 曲名')
      return c.json(await searchMedia({ type: type as 'book' | 'movie' | 'music', q, relay, relayToken, tmdbKey }))
    }
    // detail：条目 id 优先（搜索结果点选），也接受粘贴的豆瓣链接（只提取数字 id）；
    // blocked 时插件用搜索结果走 card 动作补卡。卡片封面在此转存进站内图床
    if (action === 'detail') {
      const id = /^\d{1,14}$/.test(String(body?.id ?? '')) ? String(body?.id) : subjectIdFromUrl(String(body?.url ?? ''))
      if (!id) return jsonError('缺少条目 id（或粘贴的链接不含豆瓣 subject）')
      const r = await fetchDoubanDetail({ type: type as 'book' | 'movie' | 'music', id, relay, relayToken })
      const card = r.item ? await buildCardWithCover(c.env, r.item, validateRelayBase(relay, relayToken)) : null
      return c.json({ item: r.item, blocked: r.blocked, card })
    }
    // card：详情被风控时的补卡路径——插件回传搜索结果条目，服务端校验重建后组卡（封面同样转存）
    const item = sanitizeMediaItem(body?.item)
    if (!item) return jsonError('条目数据不完整')
    return c.json({ card: await buildCardWithCover(c.env, item, validateRelayBase(relay, relayToken)) })
  } catch {
    return jsonError('抓取失败，请稍后再试', 502)
  }
})

/** 粘贴净化配套：外链图（公众号 mmbiz.qpic.cn 等有防盗链/随时失效的风险）转存站内图床并改写 src。
 *  转存上限与 collect 同口径（MAX_REMOTE_IMAGES）；单张失败保留原 src 不影响整篇——
 *  但 http:// 的图在 https 站上是混合内容会被浏览器拦，兜底升级成 https:// 再交给浏览器 */
async function rehostPasteImages(env: Env, html: string): Promise<{ html: string; transferred: number }> {
  const srcs = [...new Set([...html.matchAll(/<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]))]
  if (!srcs.length) return { html, transferred: 0 }
  const map = new Map<string, string>()
  let transferred = 0
  for (const src of srcs.slice(0, MAX_REMOTE_IMAGES)) {
    const local = await transferImage(env, src, `粘贴配图-${transferred + 1}`)
    if (local) {
      map.set(src, local)
      transferred++
    }
  }
  const out = html.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/gi, (m, pre: string, src: string, post: string) => {
    const local = map.get(src)
    if (local) return pre + local + post
    if (/^http:\/\//i.test(src)) return pre + `https://${src.slice(7)}` + post
    return m
  })
  return { html: out, transferred }
}

api.post('/admin/tools/sanitize', async (c) => {
  const body = await c.req.json<{ html?: string }>().catch(() => null)
  const html = String(body?.html ?? '')
  if (new TextEncoder().encode(html).length > MAX_CONTENT_BYTES) return jsonError('内容过长')
  const clean = sanitizeHtml(html)
  const r = await rehostPasteImages(c.env, clean)
  return c.json({ html: r.html, transferred: r.transferred })
})

/* ---------------- 公开接口 ---------------- */

/* 微信表情映射表（src/emoji.ts 单一来源）：编辑器/发布器面板与 site.js 客户端渲染共用，
 * 静态数据 + 一天浏览器缓存；闭站时 503——编辑器面板降级为空、文本码插入渲染不受影响 */
api.get('/public/emoji', (c) => {
  c.header('Cache-Control', 'public, max-age=86400')
  return c.json({ base: EMOJI_BASE, codes: WECHAT_EMOJI })
})

api.get('/public/posts', async (c) => {
  const tag = c.req.query('tag') || undefined
  const r = await listPosts(c.env.DB, {
    status: 'published',
    tag,
    page: clampInt(c.req.query('page'), 1, 1000, 1),
    limit: clampInt(c.req.query('limit'), 1, 50, 10),
  })
  return c.json({
    items: r.items.map((p) => toHomePost(p, parseTags(p))),
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
  })
})

/* ---------------- 公开留言公共核心（文章评论 / 留言板 / 微博评论三路共用） ----------------
 * 开关检查、限流、蜜罐、作者回复、先审后展入库、TG 通知与插件广播全在这里；
 * 三路的差异（称呼文案、归属列、是否收 email/website、通知上下文）由 opts 描述。
 * 目标校验在限流/蜜罐/内容校验之后执行，与三条路的原有顺序一致 */
type CommentBody = {
  slug?: string
  nickname?: string
  content?: string
  email?: string
  website?: string
  parentId?: number
  link?: string
  /** 游客选填 QQ（评论头像 C2 扩展）：仅头像抓取记账位，任何公开出参不携带 */
  qq?: string
}

async function publicComment(
  c: Context<AppEnv>,
  o: {
    kind: 'post' | 'guestbook' | 'weibo'
    /** 文案称呼：「留言」/「评论」（内容为空、回复不存在等） */
    noun: string
    closedMessage: string
    freqMessage: string
    /** 文章评论接收 email/website，其余两路不收 */
    withContact?: boolean
    /** 归属与通知上下文；目标不存在返回 Response（404） */
    target: (body: CommentBody | null) => Promise<{ postId: number; weiboId: number; context?: string; path: string } | Response>
  }
): Promise<Response> {
  const db = c.env.DB
  const settings = await getSettings(db)
  const user = await getSessionUser(db, c.req.raw)
  if (!user && settings.allowComments !== '1') return jsonError(o.closedMessage, 403)
  // 会员身份（与管理员互斥取一路；banned 已在 getMemberUser 查询层视为未登录）
  const member = user ? null : await getMemberUser(db, c.req.raw)
  const ip = clientIp(c.req.raw)
  // 管理员发言不受留言频率限制；会员是登录身份，放宽到 10 条/10 分钟（仍防滥用），游客维持 5 条
  if (!user && !member && !rateLimit(`cmt:${ip}`, 5, 10 * 60_000)) return jsonError(o.freqMessage, 429)
  if (member && !rateLimit(`mcmt:${member.id}`, 10, 10 * 60_000)) return jsonError(o.freqMessage, 429)
  const body = await c.req.json<CommentBody>().catch(() => null)
  // 蜜罐字段：正常用户不会填写，机器人会 —— 静默丢弃
  if (body?.link) return c.json({ ok: true })
  const content = String(body?.content || '').trim().slice(0, 1000)
  if (!content) return jsonError(`${o.noun}内容不能为空`)

  const t = await o.target(body)
  if (t instanceof Response) return t

  const parentId = Number(body?.parentId) || 0
  const now = Date.now()
  if (user) {
    // 作者发言（回复或自己留言）：直接展示，带「作者」徽标；parent 按同一归属过滤
    const scopeCond = o.kind === 'post' ? 'post_id = ?' : o.kind === 'weibo' ? 'weibo_id = ?' : 'post_id = 0 AND weibo_id = 0'
    const scopeBind = o.kind === 'guestbook' ? [] : [o.kind === 'post' ? t.postId : t.weiboId]
    const parent = parentId
      ? await db.prepare(`SELECT * FROM comments WHERE id = ? AND ${scopeCond}`).bind(parentId, ...scopeBind).first<CommentRow>()
      : null
    if (parentId && !parent) return jsonError(`要回复的${o.noun}不存在`, 404)
    await db
      .prepare(
        "INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, content, status, ip, created_at) VALUES (?, ?, ?, 1, ?, ?, 'approved', ?, ?)"
      )
      .bind(
        t.postId,
        t.weiboId,
        parent ? parent.parent_id || parent.id : 0,
        (user.display_name || user.username).slice(0, 24),
        content,
        ip,
        now
      )
      .run()
    return c.json({ ok: true })
  }

  if (parentId) return jsonError(`只有作者可以回复${o.noun}`, 403)
  const pending = settings.moderateComments === '1'
  if (member) {
    // 会员发言：身份来自会话，表单昵称/邮箱/网站字段一律忽略（契约 A5）；先审后展口径与游客一致
    const nickname = (member.display_name || member.username).slice(0, 24)
    const ins = await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, member_id, is_admin, nickname, content, status, ip, created_at) VALUES (?, ?, 0, ?, 0, ?, ?, ?, ?, ?)'
      )
      .bind(t.postId, t.weiboId, member.id, nickname, content, pending ? 'pending' : 'approved', ip, now)
      .run()
    // 新留言推送 TG 与插件广播（与游客同路，见下方游客分支注释）
    const base = siteBase(settings, new URL(c.req.url).origin)
    c.executionCtx.waitUntil(
      notifyAdminComment(c.env, { kind: o.kind, context: t.context, nickname, content, pending, siteBase: base, path: t.path })
    )
    c.executionCtx.waitUntil(
      fireCommentCreated(c.env, { kind: o.kind, context: t.context, nickname, content, url: base + t.path, pending })
    )
    // 评论积分：过审才计（awardCommentPoints 内按 ref_id 去重，反复切换状态不重复记）
    const commentId = Number(ins.meta.last_row_id)
    if (!pending && commentId) c.executionCtx.waitUntil(awardCommentPoints(db, member.id, commentId))
    return c.json({ ok: true, pending })
  }
  const nickname = String(body?.nickname || '').trim().slice(0, 24)
  if (!nickname) return jsonError(`昵称和${o.noun}内容不能为空`)
  // 游客 QQ 头像（评论头像 C2 扩展）：选填，格式不对按「没填」处理——选填字段不拦评论。
  // 先查同号历史头像直接复用（抓取次数 = 唯一 QQ 数，且被评论限流再压一层），未命中才出站抓取；
  // qq 本体只落库内部列，任何公开出参不携带，头像一律站内转存同源输出
  const qqRaw = String(body?.qq || '').trim()
  const guestQQ = qqRaw && isValidQQ(qqRaw) ? qqRaw : ''
  const guestAvatar = guestQQ
    ? (await db
        .prepare("SELECT avatar FROM comments WHERE qq = ? AND avatar != '' ORDER BY created_at DESC LIMIT 1")
        .bind(guestQQ)
        .first<{ avatar: string }>())?.avatar || (await fetchQQAvatar(c.env, guestQQ)) || ''
    : ''
  if (o.withContact) {
    await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, email, website, qq, avatar, content, status, ip, created_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        t.postId,
        t.weiboId,
        nickname,
        String(body?.email || '').slice(0, 100),
        String(body?.website || '').slice(0, 200),
        guestQQ,
        guestAvatar,
        content,
        pending ? 'pending' : 'approved',
        ip,
        now
      )
      .run()
  } else {
    await db
      .prepare(
        'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, nickname, qq, avatar, content, status, ip, created_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(t.postId, t.weiboId, nickname, guestQQ, guestAvatar, content, pending ? 'pending' : 'approved', ip, now)
      .run()
  }
  // 新留言推送到 Telegram（异步，不阻塞回复；开关在后台「设置 → 外部发布」）
  const base = siteBase(settings, new URL(c.req.url).origin)
  c.executionCtx.waitUntil(
    notifyAdminComment(c.env, { kind: o.kind, context: t.context, nickname, content, pending, siteBase: base, path: t.path })
  )
  // 广播评论事件给服务端插件（评论 webhook 等，见 src/hooks.ts）
  c.executionCtx.waitUntil(
    fireCommentCreated(c.env, { kind: o.kind, context: t.context, nickname, content, url: base + t.path, pending })
  )
  return c.json({ ok: true, pending })
}

api.post('/public/comments', async (c) =>
  publicComment(c, {
    kind: 'post',
    noun: '留言',
    closedMessage: '作者已关闭留言',
    freqMessage: '留言太频繁，休息一下吧',
    withContact: true,
    target: async (body) => {
      const slug = String(body?.slug || '').slice(0, 100)
      const post = await getPostBySlug(c.env.DB, slug)
      if (!post || post.status !== 'published') return jsonError('文章不存在', 404)
      return { postId: post.id, weiboId: 0, context: post.title, path: `/post/${encodeURIComponent(post.slug)}#comments` }
    },
  })
)
/* ---------------- 留言板（公开，post_id 与 weibo_id 均为 0 即留言板留言） ---------------- */
api.post('/public/guestbook', async (c) =>
  publicComment(c, {
    kind: 'guestbook',
    noun: '留言',
    closedMessage: '作者已关闭留言',
    freqMessage: '留言太频繁，休息一下吧',
    target: async () => ({ postId: 0, weiboId: 0, path: '/guestbook' }),
  })
)
/* ---------------- 微博互动（点赞 + 评论，公开） ---------------- */
/** 点赞公共件（posts 按 slug / weibo 按 id 两路共用）：条件更新防负数，
 *  回读同口径只认已发布——草稿/不存在的统一返回 0（草稿历史点赞数不外泄）。
 *  table/col 只来自两个调用点的字面量，无注入面 */
async function likeDelta(
  db: D1Database,
  table: 'posts' | 'weibo',
  col: 'slug' | 'id',
  key: string,
  delta: number
): Promise<number> {
  await db
    .prepare(
      `UPDATE ${table} SET likes = CASE WHEN likes + ? < 0 THEN 0 ELSE likes + ? END WHERE ${col} = ? AND status = 'published' AND deleted_at IS NULL`
    )
    .bind(delta, delta, key)
    .run()
  const row = await db
    .prepare(`SELECT likes FROM ${table} WHERE ${col} = ? AND status = 'published' AND deleted_at IS NULL`)
    .bind(key)
    .first<{ likes: number }>()
  return row?.likes ?? 0
}

api.post('/public/like/weibo/:id', async (c) => {
  // 限流防脚本刷赞刷踩（正常用户连点几条微博远够用）
  if (!rateLimit(`like:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('操作太频繁了，休息一下吧', 429)
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  const body = await c.req.json<{ delta?: number }>().catch(() => null)
  const delta = body?.delta === -1 ? -1 : 1
  return c.json({ ok: true, likes: await likeDelta(c.env.DB, 'weibo', 'id', String(id), delta) })
})

api.get('/public/weibo/:id/comments', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  const wb = await getWeiboById(c.env.DB, id)
  if (!wb || wb.status !== 'published') return jsonError('这条微博不存在', 404)
  const settings = await getSettings(c.env.DB)
  const { results } = await c.env.DB
    .prepare(
      "SELECT cm.id, cm.parent_id, cm.is_admin, cm.nickname, cm.content, cm.created_at, cm.avatar, m.display_name AS member_name, m.tier AS member_tier, m.avatar AS member_avatar FROM comments cm LEFT JOIN members m ON m.id = cm.member_id WHERE cm.weibo_id = ? AND cm.status = 'approved' ORDER BY cm.created_at ASC LIMIT 200"
    )
    .bind(id)
    .all()
  return c.json({ comments: results ?? [], allowComments: settings.allowComments === '1', adminAvatar: settings.avatarUrl || '' })
})

api.post('/public/weibo/:id/comments', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return jsonError('参数错误')
  return publicComment(c, {
    kind: 'weibo',
    noun: '评论',
    closedMessage: '作者已关闭评论',
    freqMessage: '评论太频繁，休息一下吧',
    target: async () => {
      const wb = await getWeiboById(c.env.DB, id)
      if (!wb || wb.status !== 'published') return jsonError('这条微博不存在', 404)
      return { postId: 0, weiboId: id, context: excerpt(wb.content, 40), path: `/weibo?wb=${id}#wb-${id}` }
    },
  })
})
api.post('/public/like/:slug', async (c) => {
  if (!rateLimit(`like:${clientIp(c.req.raw)}`, 30, 10 * 60_000)) return jsonError('操作太频繁了，休息一下吧', 429)
  const slug = c.req.param('slug').slice(0, 100)
  const body = await c.req.json<{ delta?: number }>().catch(() => null)
  const delta = body?.delta === -1 ? -1 : 1
  return c.json({ ok: true, likes: await likeDelta(c.env.DB, 'posts', 'slug', slug, delta) })
})

/* ---------------- 访客统计打点（公开，site.js 上报，见 src/stats.ts） ---------------- */
api.post('/public/track', async (c) => {
  if (!rateLimit(`track:${clientIp(c.req.raw)}`, 120, 10 * 60_000)) return jsonError('请求过于频繁，请稍后再试', 429)
  const settings = await getSettings(c.env.DB)
  if (settings.statsEnabled === '0') return c.json({ ok: true })
  const body = await c.req.json<{ p?: string; r?: string; v?: string; t?: string }>().catch(() => null)
  const path = cleanPath(body?.p)
  // 正常页面路径必然以 / 开头，不合法的一律丢弃（裸 curl 刷接口拿不到有效数据）
  if (!path) return c.json({ ok: true })
  const ua = c.req.header('User-Agent') || ''
  // 打点失败不影响页面（表未就绪等极端情况也走这里）
  c.executionCtx.waitUntil(
    recordVisit(c.env.DB, {
      path,
      title: cleanTitle(body?.t),
      ref: cleanRef(body?.r),
      vid: cleanVid(body?.v),
      dev: classifyDevice(ua),
      br: classifyBrowser(ua),
      country: (c.req.header('CF-IPCountry') || '').slice(0, 8),
    }).catch(() => {})
  )
  return c.json({ ok: true })
})

/* ---------------- 友链申请（公开，进入待审核） ---------------- */
api.post('/public/links/apply', async (c) => {
  const ip = clientIp(c.req.raw)
  if (!rateLimit(`flapply:${ip}`, 3, 10 * 60_000)) return jsonError('提交太频繁了，请稍后再试', 429)
  const body = await c.req
    .json<{ name?: string; url?: string; description?: string; link?: string }>()
    .catch(() => null)
  // 蜜罐字段：正常用户不会填写，机器人会 —— 静默丢弃
  if (body?.link) return c.json({ ok: true })
  const name = String(body?.name || '').trim().slice(0, 40)
  const url = normalizeLinkUrl(String(body?.url || ''))
  const description = String(body?.description || '').trim().slice(0, 120)
  if (!name || !url) return jsonError('站名和网址不能为空')
  const dup = await c.env.DB.prepare('SELECT id FROM friend_links WHERE url = ?').bind(url).first<{ id: number }>()
  if (dup) return jsonError('这个网址已经在友链列表里啦')
  await c.env.DB.prepare(
    "INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', 0, 'user', ?, ?, ?)"
  )
    .bind(name, url, description, ip, Date.now(), Date.now())
    .run()
  return c.json({ ok: true })
})

api.get('/meta/themes', (c) =>
  c.json({
    themes: Object.values(THEMES).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      colors: t.colors ?? null,
    })),
  })
)
