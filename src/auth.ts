import type { MemberSessionUser, SessionUser } from './types'
import { sha256Hex } from './utils'

const enc = new TextEncoder()
const PBKDF2_ITERATIONS = 100_000 // Workers 上限即 10 万次

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** 会话 token 落库一律存 SHA-256：D1 里的 sessions / member_sessions 不再有可直接
 *  重放的明文 token（库泄露 ≠ 会话被冒用）；查询时对 Cookie 里的 token 同样哈希后比对 */
function tokenHash(token: string): Promise<string> {
  return sha256Hex(enc.encode(token).buffer as ArrayBuffer)
}

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const s = salt ?? randomToken(16)
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(s), iterations: PBKDF2_ITERATIONS },
    key,
    256
  )
  const hash = Array.from(new Uint8Array(bits), (x) => x.toString(16).padStart(2, '0')).join('')
  return { hash, salt: s }
}

/** 常量时间字符串比较：长度不等时同样扫完（时间与等长情形一致，不泄露长度差） */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let r = a.length === b.length ? 0 : 1
  for (let i = 0; i < len; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return r === 0
}

export const SESSION_COOKIE = 'bloghao_session'
const SESSION_TTL = 30 * 24 * 3600 * 1000 // 30 天

export function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get('Cookie') || ''
  for (const part of h.split(/; */)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return part.slice(i + 1).trim()
      }
    }
  }
  return null
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken(32)
  const expires = Date.now() + SESSION_TTL
  await db
    .prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await tokenHash(token), userId, expires, Date.now())
    .run()
  return token
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export async function getSessionUser(db: D1Database, req: Request): Promise<SessionUser | null> {
  const token = getCookie(req, SESSION_COOKIE)
  if (!token) return null
  return db
    .prepare(
      'SELECT u.id, u.username, u.display_name, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
    )
    .bind(await tokenHash(token), Date.now())
    .first<SessionUser>()
}

export async function destroySession(db: D1Database, req: Request): Promise<void> {
  const token = getCookie(req, SESSION_COOKIE)
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await tokenHash(token)).run()
}

/** 清理已过期会话（随每晚备份 cron 跑一次即可），防止 sessions 表无限增长 */
export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run()
}

/* ---------------- 会员会话（访客注册身份，与管理员 sessions 彻底分离，契约见 docs/DEVPLAN-2026-10-07.md 附录 A） ---------------- */

export const MEMBER_SESSION_COOKIE = 'xw_member_session'

export async function createMemberSession(db: D1Database, memberId: number): Promise<string> {
  const token = randomToken(32)
  await db
    .prepare('INSERT INTO member_sessions (token, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await tokenHash(token), memberId, Date.now() + SESSION_TTL, Date.now())
    .run()
  return token
}

export function memberSessionCookie(token: string): string {
  return `${MEMBER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
}

export function clearMemberSessionCookie(): string {
  return `${MEMBER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/** 当前登录会员；banned 在查询层即视为未登录（封禁即刻失去会话能力，无需等后台清会话） */
export async function getMemberUser(db: D1Database, req: Request): Promise<MemberSessionUser | null> {
  const token = getCookie(req, MEMBER_SESSION_COOKIE)
  if (!token) return null
  return db
    .prepare(
      "SELECT m.id, m.username, m.display_name, m.avatar, m.tier, m.points FROM member_sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ? AND s.expires_at > ? AND m.status = 'active'"
    )
    .bind(await tokenHash(token), Date.now())
    .first<MemberSessionUser>()
}

export async function destroyMemberSession(db: D1Database, req: Request): Promise<void> {
  const token = getCookie(req, MEMBER_SESSION_COOKIE)
  if (token) await db.prepare('DELETE FROM member_sessions WHERE token = ?').bind(await tokenHash(token)).run()
}

/** 后台拉黑时清空该会员全部会话（双保险：查询层已挡 banned，这里把 token 也删掉） */
export async function destroyMemberSessionsByMember(db: D1Database, memberId: number): Promise<void> {
  await db.prepare('DELETE FROM member_sessions WHERE member_id = ?').bind(memberId).run()
}

/** 改密码后踢掉其他设备：保留当前会话（改密码的人自己不能被登出去），其余全部失效 */
export async function destroyOtherMemberSessions(db: D1Database, memberId: number, keepToken: string): Promise<void> {
  await db
    .prepare('DELETE FROM member_sessions WHERE member_id = ? AND token <> ?')
    .bind(memberId, await tokenHash(keepToken))
    .run()
}

/** 清理过期会员会话（随每晚备份 cron，与 purgeExpiredSessions 并排） */
export async function purgeExpiredMemberSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM member_sessions WHERE expires_at < ?').bind(Date.now()).run()
}

/**
 * 简单内存限流（按隔离实例生效，尽力而为）。
 * key => 每窗口最多 limit 次。
 */
const buckets = new Map<string, { n: number; reset: number }>()
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  // 淘汰在插入时执行：先清过期项；仍超容量则丢最旧的，保证 Map 有界
  if (buckets.size >= 5000) {
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k)
    while (buckets.size >= 5000) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
  }
  const e = buckets.get(key)
  if (!e || e.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs })
    return true
  }
  if (e.n >= limit) return false
  e.n++
  return true
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  )
}
