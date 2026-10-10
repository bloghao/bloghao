/**
 * 外部发布：开放 API + Telegram 机器人
 *
 * POST /api/external/weibo      Token 鉴权，JSON / multipart 均可，发布或存草稿
 * POST /api/telegram/webhook    Telegram 更新推送：文字 / 图片 / 相册 → 微博（图片转存 R2）
 * POST /api/admin/external/*    后台管理：生成 Token、一键设置 Telegram Webhook
 *
 * 鉴权信息与机器人配置都存在 settings 表（后台「设置 → 外部发布」维护）：
 * - externalToken          开放 API 密钥（空 = 接口关闭）
 * - telegramBotToken       @BotFather 发的 Bot Token
 * - telegramAllowFrom      允许发布的 Chat ID 白名单（逗号分隔）
 * - telegramWebhookSecret  Webhook 地址里的随机密钥（一键设置时自动生成）
 */
import { Hono } from 'hono'
import { randomToken, rateLimit, safeEqual } from './auth'
import { getSettings, getWeiboById, saveSettings, WEIBO_MAX_CHARS, WEIBO_MAX_IMAGES } from './db'
import { fireWeiboPublished } from './hooks'
import { siteBase } from './render'
import { imageExtOf, MAX_UPLOAD_BYTES, saveUpload } from './store'
import type { Env, SessionUser, SettingsMap, WeiboRow } from './types'
import { excerpt, extractWeiboTopics, isDemo } from './utils'

const TG_FILE_LIMIT = 20 * 1024 * 1024 // Bot API getFile 上限 20MB

const TG_API = 'https://api.telegram.org'

type AppEnv = { Bindings: Env; Variables: { user: SessionUser } }

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

function reqOrigin(url: string): string {
  return new URL(url).origin
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/* ---------------- 落库 / 存图（与后台发布器同一套约束） ---------------- */

async function insertWeibo(db: D1Database, content: string, images: string[], status: 'published' | 'draft'): Promise<WeiboRow> {
  const now = Date.now()
  const res = await db
    .prepare('INSERT INTO weibo (content, images, topics, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(content, JSON.stringify(images), JSON.stringify(extractWeiboTopics(content)), status, status === 'published' ? now : null, now, now)
    .run()
  const row = await getWeiboById(db, Number(res.meta.last_row_id))
  if (!row) throw new Error('微博写入失败')
  return row
}

/** 图片字节进 R2 图床并登记 uploads 表，返回站内地址；类型/大小不过关返回 null */
async function storeImage(env: Env, buf: ArrayBuffer, mime: string, name: string): Promise<string | null> {
  mime = (mime || '').split(';')[0].trim().toLowerCase()
  const ext = imageExtOf(mime)
  if (!ext || buf.byteLength === 0 || buf.byteLength > MAX_UPLOAD_BYTES) return null
  return saveUpload(env, buf, mime, name, ext)
}

/** data:image/...;base64 解码，只认图片类型；先按长度预检（base64 恒 4/3 膨胀），
 *  超大 data URL 直接拒绝，防解码前整段进内存 */
function decodeDataUrl(s: string): { buf: ArrayBuffer; mime: string } | null {
  if (s.length > Math.ceil((MAX_UPLOAD_BYTES / 3) * 4) + 1024) return null
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(s.trim())
  if (!m) return null
  try {
    const bin = atob(m[2].replace(/\s+/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { buf: bytes.buffer, mime: m[1].toLowerCase() }
  } catch {
    return null
  }
}

/* ---------------- 开放 API ---------------- */

export const externalRoutes = new Hono<{ Bindings: Env }>()

/** Token 鉴权；通过则返回设置（空 Token = 接口关闭）。
 *  只认 header：query 传 token 会进访问日志/代理日志，造成泄露面 */
async function requireToken(c: { env: Env; req: { header: (k: string) => string | undefined } }) {
  const settings = await getSettings(c.env.DB)
  const expected = settings.externalToken || ''
  if (!expected) return null
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim() || (c.req.header('X-Auth-Token') || '').trim()
  if (!token || !safeEqual(token, expected)) return null
  return settings
}

const TOKEN_ERR = '无效的 API Token，或尚未在后台「设置 → 外部发布」生成'

externalRoutes.get('/weibo', async (c) => {
  const settings = await requireToken(c)
  if (!settings) return c.json({ error: TOKEN_ERR }, 401)
  return c.json({
    ok: true,
    site: siteBase(settings, reqOrigin(c.req.url)),
    usage: 'POST /api/external/weibo  {content, images?, status?}',
  })
})

externalRoutes.post('/weibo', async (c) => {
  const settings = await requireToken(c)
  if (!settings) return c.json({ error: TOKEN_ERR }, 401)
  if (!rateLimit(`ext:${settings.externalToken.slice(0, 12)}`, 30, 60_000)) {
    return c.json({ error: '发布太频繁，请稍后再试' }, 429)
  }

  let content = ''
  let status: 'published' | 'draft' = 'published'
  const images: string[] = []

  const ctype = c.req.header('Content-Type') || ''
  /** parseBody({all:true}) 单值时不是数组，统一收成数组 */
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
  /** 字符串图片：data URL 解码进 R2，其余按站内 / 外链原样收下，落库前统一校验 */
  const pushImageString = async (s: string): Promise<string | null> => {
    if (s.startsWith('data:image/')) {
      const decoded = decodeDataUrl(s)
      if (!decoded) return null
      return storeImage(c.env, decoded.buf, decoded.mime, 'external-base64')
    }
    return s
  }

  if (ctype.includes('multipart/form-data')) {
    const body = await c.req.parseBody({ all: true }).catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: '请求格式错误' }, 400)
    content = String(asArray(body['content'])[0] ?? '')
    if (String(asArray(body['status'])[0] ?? '').trim() === 'draft') status = 'draft'
    const entries = [...asArray(body['images']), ...asArray(body['image'])]
    if (entries.length > WEIBO_MAX_IMAGES) return c.json({ error: `最多 ${WEIBO_MAX_IMAGES} 张图` }, 422)
    for (const item of entries) {
      if (item instanceof File) {
        const url = await storeImage(c.env, await item.arrayBuffer(), item.type || 'application/octet-stream', item.name || 'external')
        if (url) images.push(url)
      } else if (typeof item === 'string' && item.trim()) {
        const url = await pushImageString(item.trim())
        if (url) images.push(url)
      }
    }
  } else {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: '请求格式错误：需要 JSON 或 multipart 表单' }, 400)
    const b = body as Record<string, unknown>
    content = String(b.content ?? '')
    if (b.status === 'draft') status = 'draft'
    const list = Array.isArray(b.images) ? b.images : typeof b.images === 'string' ? [b.images] : []
    if (list.length > WEIBO_MAX_IMAGES) return c.json({ error: `最多 ${WEIBO_MAX_IMAGES} 张图` }, 422)
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue
      const url = await pushImageString(item.trim())
      if (url) images.push(url)
    }
  }

  content = content.trim().slice(0, WEIBO_MAX_CHARS)
  const kept = images.filter((s) => s.startsWith('/images/') || /^https?:\/\//i.test(s)).slice(0, WEIBO_MAX_IMAGES)
  if (!content && !kept.length) return c.json({ error: '文字和图片至少要有一样' }, 422)
  if (kept.length && images.length > kept.length) {
    return c.json({ error: `有 ${images.length - kept.length} 张图片格式不支持（仅 JPG / PNG / WebP / GIF）` }, 422)
  }

  const row = await insertWeibo(c.env.DB, content, kept, status)
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）：开放 API 与 TG 机器人两条路共用
  if (row.status === 'published') {
    c.executionCtx.waitUntil(fireWeiboPublished(c.env, { id: row.id, content: row.content, images: kept, via: 'external' }))
  }
  return c.json({
    ok: true,
    id: row.id,
    url: `${siteBase(settings, reqOrigin(c.req.url))}/weibo?wb=${row.id}#wb-${row.id}`,
    status: row.status,
    images: kept,
  })
})

/* ---------------- Telegram 机器人 ---------------- */

export const telegramRoutes = new Hono<{ Bindings: Env }>()

interface TgPhotoSize {
  file_id: string
  file_size?: number
  width?: number
  height?: number
}

interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  document?: { file_id: string; mime_type?: string; file_size?: number }
  media_group_id?: string
}

interface TgUpdate {
  update_id: number
  message?: TgMessage
}

interface TgApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

/** Telegram Bot API 统一出口：演示站一律短路（DEMO_MODE 下体验者随手配的 Bot Token
 *  不能让官方演示 Worker 变成对外发送中继，见「演示站禁外发」防线） */
async function tgApi<T>(
  env: Env,
  botToken: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<TgApiResponse<T> | null> {
  if (isDemo(env)) return null
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(10_000),
    })
    return (await res.json()) as TgApiResponse<T>
  } catch {
    return null
  }
}

async function tgSend(env: Env, botToken: string, chatId: string, text: string) {
  await tgApi(env, botToken, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
}

/* ---------------- 站内事件推送（新留言 / 备份失败等） ----------------
 * 复用发布机器人的 Bot Token，推送到白名单第一个 Chat ID（即站长本人会话）；
 * 未配置 Token / 白名单或开关关闭时静默跳过，绝不阻塞主流程（调用方请用 waitUntil 包裹）。
 */

/** 白名单第一个 Chat ID：推送目标（站长自己授权发布的那个会话） */
function notifyChatId(settings: SettingsMap): string {
  return (settings.telegramAllowFrom || '')
    .split(/[,\s，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)[0] ?? ''
}

/** 给站长推一条纯文本消息（站点级事件，不受留言推送开关限制）；任何失败都吞掉，只返回是否送达。
 *  演示站短路：备份/评论/定时发布通知也不外发（demo 凭据是公示的，体验者能触达这些链路） */
export async function notifyAdminText(env: Env, text: string): Promise<boolean> {
  try {
    if (isDemo(env)) return false
    const settings = await getSettings(env.DB)
    const botToken = (settings.telegramBotToken || '').trim()
    if (!botToken) return false
    const chatId = notifyChatId(settings)
    if (!chatId) return false
    const res = await tgApi(env, botToken, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
    return !!res?.ok
  } catch {
    return false
  }
}

export interface CommentNotice {
  /** 来源：文章留言 / 微博评论 / 留言板 */
  kind: 'post' | 'weibo' | 'guestbook'
  /** 文章标题或微博正文摘要（weibo/guestbook 可省） */
  context?: string
  nickname: string
  content: string
  /** 先审后展开启时新留言为 pending */
  pending: boolean
  /** 站点对外地址（settings.siteUrl 优先，否则当前请求 origin） */
  siteBase: string
  /** 跳转路径：文章 /post/:slug#comments、微博 /weibo?wb=:id#wb-:id、留言板 /guestbook */
  path: string
}

/** 新留言/评论推送到 Telegram，文案带来源、昵称、内容摘要与直达链接 */
export async function notifyAdminComment(env: Env, n: CommentNotice): Promise<void> {
  try {
    const settings = await getSettings(env.DB)
    if (settings.notifyNewComment === '0') return
    const content = excerpt(n.content, 160)
    const head =
      n.kind === 'post'
        ? `💬《${n.context || '文章'}》有新留言`
        : n.kind === 'weibo'
          ? `💬 微博「${excerpt(n.context || '', 32)}」有新评论`
          : '💬 留言板有新留言'
    const flag = n.pending ? '⏳ 待审核 · ' : ''
    const link = n.siteBase ? `\n\n👉 ${n.siteBase}${n.path}` : ''
    await notifyAdminText(env, `${head}\n${flag}来自 ${n.nickname}\n\n${content}${link}`)
  } catch {
    /* 通知失败不影响留言本身 */
  }
}

function helpText(chatId: string): string {
  return (
    '👋 发布器就绪！直接给我发消息就会发布到微博：\n\n' +
    '· 发文字 → 文字微博\n' +
    '· 发图片（可带 caption）→ 图文微博，最多 9 张\n' +
    '· 一次多选几张发相册 → 自动合并成一条多图微博\n' +
    '· 消息开头写 /draft 可存为草稿\n' +
    '· 正文里写 #话题# 照常归类\n\n' +
    `你的 Chat ID：${chatId}\n` +
    '把它填到后台「设置 → 外部发布 → 允许发布的 Chat ID」即可授权。'
  )
}

/** 从一条消息里取出图片的 file_id（相册里每条消息带一张图，取分辨率最高的尺寸） */
function pickImageFileId(msg: TgMessage): string | null {
  if (msg.photo?.length) {
    const sizes = [...msg.photo].sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
    const fit = [...sizes].reverse().find((p) => (p.file_size ?? 0) <= TG_FILE_LIMIT)
    return (fit ?? sizes[sizes.length - 1]).file_id
  }
  if (msg.document && (msg.document.mime_type || '').startsWith('image/')) return msg.document.file_id
  return null
}

/** 把 Telegram 图片下载下来转存 R2 图床，返回站内地址 */
async function saveTgImage(env: Env, botToken: string, fileId: string): Promise<string | null> {
  try {
    const meta = await tgApi<{ file_path?: string }>(env, botToken, 'getFile', { file_id: fileId })
    const path = meta?.ok && meta.result?.file_path
    if (!path) return null
    const res = await fetch(`${TG_API}/file/bot${botToken}/${path}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (!buf.byteLength || buf.byteLength > MAX_UPLOAD_BYTES) return null
    let mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    let ext = imageExtOf(mime)
    if (!ext) {
      // Telegram 有时不回对 mime：按 file_path 后缀反推（storeImage 会再过一次白名单）
      const byPath = /\.(jpe?g|png|webp|gif)$/i.exec(path)?.[1]?.toLowerCase()
      if (!byPath) return null
      mime = `image/${byPath === 'jpg' || byPath === 'jpeg' ? 'jpeg' : byPath}`
      ext = imageExtOf(mime)
    }
    if (!ext) return null
    return storeImage(env, buf, mime, `telegram-${Date.now().toString(36)}.${ext}`)
  } catch {
    return null
  }
}

/* 相册合并：Telegram 会把一次多选拆成多条消息（同一 media_group_id）。
 * 先原子追加进缓冲表，再等几秒没有新图后一次性发布，避免一张微博一张图。 */
interface TgBufferRow {
  media_group_id: string
  content: string
  images: string
  status: string
  chat_id: string
  updated_at: number
}

const GROUP_QUIET_MS = 2500 // 缓冲这么多毫秒没有新图就发布
const GROUP_RETRY = 8 // 最多轮询次数（3s × 8，远小于 waitUntil 30s）

async function upsertGroupBuffer(db: D1Database, groupId: string, content: string, imageUrl: string, status: 'published' | 'draft', chatId: string) {
  await db
    .prepare(
      `INSERT INTO tg_buffer (media_group_id, content, images, status, chat_id, updated_at)
       VALUES (?, ?, json_array(?), ?, ?, ?)
       ON CONFLICT(media_group_id) DO UPDATE SET
         content = CASE WHEN excluded.content = '' THEN tg_buffer.content
                        WHEN instr(char(10) || tg_buffer.content || char(10), char(10) || excluded.content || char(10)) > 0 THEN tg_buffer.content
                        WHEN tg_buffer.content = '' THEN excluded.content
                        ELSE tg_buffer.content || char(10) || excluded.content END,
         images = json_insert(tg_buffer.images, '$[#]', json_extract(excluded.images, '$[0]')),
         status = CASE WHEN tg_buffer.status = 'draft' THEN 'draft' ELSE excluded.status END,
         chat_id = excluded.chat_id,
         updated_at = excluded.updated_at`
    )
    .bind(groupId, content, imageUrl, status, chatId, Date.now())
    .run()
}

function dedupeLines(s: string): string {
  const seen: string[] = []
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (t && !seen.includes(t)) seen.push(t)
  }
  return seen.join('\n')
}

function parseImageList(json: string): string[] {
  try {
    const a = JSON.parse(json || '[]')
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.startsWith('/images/')) : []
  } catch {
    return []
  }
}

async function flushMediaGroup(env: Env, botToken: string, groupId: string, fallbackOrigin: string) {
  for (let i = 0; i < GROUP_RETRY; i++) {
    await sleep(3000)
    const row = await env.DB.prepare('SELECT * FROM tg_buffer WHERE media_group_id = ?').bind(groupId).first<TgBufferRow>()
    if (!row) return // 已被并发的另一轮 flush 取走
    if (Date.now() - row.updated_at < GROUP_QUIET_MS) continue // 还有新图在路上，再等等
    // 带 updated_at 条件删除 = 抢占锁，防止两轮 flush 同时发布
    const del = await env.DB.prepare('DELETE FROM tg_buffer WHERE media_group_id = ? AND updated_at = ?').bind(groupId, row.updated_at).run()
    if ((del.meta.changes ?? 0) !== 1) continue
    const images = [...new Set(parseImageList(row.images))].slice(0, WEIBO_MAX_IMAGES)
    const content = dedupeLines(row.content).slice(0, WEIBO_MAX_CHARS)
    if (!content && !images.length) return
    const status: 'published' | 'draft' = row.status === 'draft' ? 'draft' : 'published'
    const weibo = await insertWeibo(env.DB, content, images, status)
    const site = siteBase(await getSettings(env.DB), fallbackOrigin)
    const where = `${site}/weibo?wb=${weibo.id}#wb-${weibo.id}`
    await tgSend(
      env, botToken,
      row.chat_id,
      status === 'draft'
        ? `📝 相册已存为草稿（${images.length} 图），到后台「微博」页查看。`
        : `✅ 相册已发布到微博（${images.length} 图）\n${where}`
    )
    return
  }
}

telegramRoutes.post('/webhook', async (c) => {
  // 演示站禁外发：TG webhook 整条路都不存在（tgApi 内部还有兜底短路）
  if (isDemo(c.env)) return c.json({ ok: false }, 404)
  const settings = await getSettings(c.env.DB)
  const botToken = (settings.telegramBotToken || '').trim()
  const secret = settings.telegramWebhookSecret || ''
  if (!botToken || !secret) return c.json({ ok: false }, 403)

  // 一键设置时 secret 同时放在 URL 与 secret_token 里，两处对上一个即可
  const querySecret = c.req.query('secret') || ''
  const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') || ''
  const secretOk =
    (querySecret && safeEqual(querySecret, secret)) || (headerSecret && safeEqual(headerSecret, secret))
  if (!secretOk) return c.json({ ok: false, error: 'bad secret' }, 401)

  const update = await c.req.json<TgUpdate>().catch(() => null)
  const msg = update?.message // edited_message / channel_post 等一律忽略
  if (!msg || !msg.chat) return c.json({ ok: true })
  const chatId = String(msg.chat.id)

  let text = (msg.text || msg.caption || '').trim()
  let status: 'published' | 'draft' = 'published'

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase()
    if (cmd === '/start' || cmd === '/help') {
      await tgSend(c.env, botToken, chatId, helpText(chatId))
      return c.json({ ok: true })
    }
    if (cmd === '/draft') {
      status = 'draft'
      text = text.replace(/^\/draft(@\S+)?\s*/i, '')
    } else {
      await tgSend(c.env, botToken, chatId, '可用指令：/draft 文字（存草稿）。直接发内容就是发布。')
      return c.json({ ok: true })
    }
  }

  // 白名单：只有后台填过的 Chat ID 能真正发布
  const allowed = (settings.telegramAllowFrom || '')
    .split(/[,\s，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!allowed.includes(chatId)) {
    await tgSend(
      c.env, botToken,
      chatId,
      `🔒 这个会话还没有授权发布。\n你的 Chat ID：${chatId}\n到后台「设置 → 外部发布」把它加进白名单即可。`
    )
    return c.json({ ok: true })
  }
  if (!rateLimit(`tg:${chatId}`, 20, 60_000)) {
    await tgSend(c.env, botToken, chatId, '发得太快啦，休息一下再发。')
    return c.json({ ok: true })
  }

  const fileId = pickImageFileId(msg)
  if (msg.document && !fileId) {
    await tgSend(c.env, botToken, chatId, '文件类消息只支持图片，其他类型发到微博显示不了。')
    return c.json({ ok: true })
  }

  // 相册：缓冲合并，由后台任务统一发布
  if (msg.media_group_id) {
    if (!fileId) return c.json({ ok: true })
    const imageUrl = await saveTgImage(c.env, botToken, fileId)
    if (!imageUrl) return c.json({ ok: true })
    await upsertGroupBuffer(c.env.DB, msg.media_group_id, text, imageUrl, status, chatId)
    // 兜底清理：10 分钟前的残留缓冲（正常几秒内就会发布清空）
    c.executionCtx.waitUntil(
      c.env.DB.prepare('DELETE FROM tg_buffer WHERE updated_at < ?').bind(Date.now() - 600_000).run().catch(() => undefined)
    )
    c.executionCtx.waitUntil(
      flushMediaGroup(c.env, botToken, msg.media_group_id, reqOrigin(c.req.url)).catch(() => undefined)
    )
    return c.json({ ok: true })
  }

  const content = text.slice(0, WEIBO_MAX_CHARS)
  if (!fileId && !content) {
    await tgSend(c.env, botToken, chatId, '这条消息里没有文字也没有图片，发点内容给我吧。')
    return c.json({ ok: true })
  }

  const images: string[] = []
  if (fileId) {
    const url = await saveTgImage(c.env, botToken, fileId)
    if (!url) {
      await tgSend(c.env, botToken, chatId, '图片下载失败（仅支持 JPG / PNG / WebP / GIF，≤ 25MB），再试一次？')
      return c.json({ ok: true })
    }
    images.push(url)
  }

  const weibo = await insertWeibo(c.env.DB, content, images, status)
  // 广播微博发布事件（服务端插件钩子，见 src/hooks.ts）；TG 上下文无 executionCtx 也可安全调用（fire 内部自吞错）
  if (weibo.status === 'published') {
    c.executionCtx.waitUntil(fireWeiboPublished(c.env, { id: weibo.id, content: weibo.content, images, via: 'telegram' }))
  }
  const where = `${siteBase(settings, reqOrigin(c.req.url))}/weibo?wb=${weibo.id}#wb-${weibo.id}`
  await tgSend(
    c.env, botToken,
    chatId,
    status === 'draft'
      ? `📝 已存为草稿，到后台「微博」页查看。`
      : `✅ 已发布到微博\n${where}`
  )
  return c.json({ ok: true })
})

/* ---------------- 后台管理接口（需登录，挂载在 /api/admin/external） ---------------- */

export const adminExternalRoutes = new Hono<AppEnv>()

/** 生成并保存新的 API Token（旧的立即失效）；演示站禁用（禁外发守卫同口径） */
adminExternalRoutes.post('/token', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放外部发布配置', 404)
  const token = randomToken(24)
  await saveSettings(c.env.DB, { externalToken: token })
  return c.json({ ok: true, token })
})

/** 校验 Bot Token 并一键设置 Webhook（首次会自动生成 Webhook 密钥）；演示站禁用 */
adminExternalRoutes.post('/telegram/webhook', async (c) => {
  if (isDemo(c.env)) return jsonError('演示站不开放外部发布配置', 404)
  const settings = await getSettings(c.env.DB)
  const botToken = (settings.telegramBotToken || '').trim()
  if (!botToken) return jsonError('先填写并保存 Telegram Bot Token')
  const me = await tgApi<{ username?: string; first_name?: string }>(c.env, botToken, 'getMe')
  if (!me?.ok || !me.result?.username) {
    return jsonError('Bot Token 无效（Telegram 校验未通过），请核对后重试', 400)
  }
  let secret = settings.telegramWebhookSecret
  if (!secret) {
    secret = randomToken(16)
    await saveSettings(c.env.DB, { telegramWebhookSecret: secret })
  }
  // URL 不再带 secret（会进 Telegram 与边缘访问日志）；校验统一走 setWebhook
  // 的 secret_token 对应的官方请求头。仍兼容旧绑定 URL 里的 ?secret=
  const webhookUrl = `${siteBase(settings, reqOrigin(c.req.url))}/api/telegram/webhook`
  const res = await tgApi(c.env, botToken, 'setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  })
  if (!res?.ok) {
    return jsonError('设置 Webhook 失败：' + (res?.description || 'Telegram 无响应'), 502)
  }
  return c.json({ ok: true, bot: '@' + me.result.username, webhookUrl })
})
