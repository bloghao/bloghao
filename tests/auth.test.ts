import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSessionCookie,
  clientIp,
  createSession,
  createMemberSession,
  destroyOtherMemberSessions,
  destroySession,
  getCookie,
  getMemberUser,
  getSessionUser,
  hashPassword,
  MEMBER_SESSION_COOKIE,
  memberSessionCookie,
  purgeExpiredSessions,
  randomToken,
  rateLimit,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
} from '../src/auth.ts'
import { sha256Hex } from '../src/utils.ts'

// ── 会话 token 防线（AGENTS「会话 token」节）：sessions 落库的是 SHA-256(token)，
// Cookie 里才是原文——库泄露 ≠ 会话可重放。此前该模块零测试，属安全核心唯一无守卫面 ──

const sha256Of = async (s: string) => sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer)

/** 最小 D1 桩：记录 prepare().bind() 的 SQL 与参数，SELECT 结果由 handler 决定 */
function fakeDb(handler?: (sql: string, binds: unknown[]) => unknown) {
  const calls: { sql: string; binds: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind: (...binds: unknown[]) => {
          calls.push({ sql, binds })
          return stmt
        },
        first: async () => {
          const last = calls[calls.length - 1]
          return handler ? handler(last.sql, last.binds) : null
        },
        run: async () => ({ success: true }),
      }
      return stmt
    },
  } as unknown as D1Database
  return { db, calls }
}

const reqWithCookie = (cookie: string) => new Request('https://x.test/', { headers: { cookie } })

test('randomToken：默认 32 字节 = 64 位十六进制，两次调用不重复', () => {
  const a = randomToken()
  const b = randomToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

test('hashPassword：同盐同口令确定复现，异盐异文不同哈希；盐缺省自动生成', async () => {
  const { hash: h1 } = await hashPassword('correct horse battery staple', 'saltsalt')
  const { hash: h2 } = await hashPassword('correct horse battery staple', 'saltsalt')
  const { hash: h3 } = await hashPassword('correct horse battery staple', 'othersalt')
  assert.equal(h1, h2)
  assert.notEqual(h1, h3)
  assert.match(h1, /^[0-9a-f]{64}$/)
  const auto = await hashPassword('x')
  assert.match(auto.salt, /^[0-9a-f]{32}$/)
  const again = await hashPassword('x', auto.salt)
  assert.equal(auto.hash, again.hash)
})

test('safeEqual：等长比较、长度不等也扫满（不泄露长度差）', async () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', ''), true)
  const sneaky = safeEqual as unknown as (a: unknown, b: unknown) => boolean
  assert.equal(sneaky('abc', 123), false)
})

test('getCookie：多 Cookie 取值、URL 编码解码、缺名与无名值容错', () => {
  const req = reqWithCookie('a=1; bloghao_session=tok%2Ben; c=')
  assert.equal(getCookie(req, SESSION_COOKIE), 'tok+en')
  assert.equal(getCookie(req, 'missing'), null)
  assert.equal(getCookie(reqWithCookie('novalue; b=2'), 'b'), '2')
})

test('createSession：落库 bind 的是 SHA-256(token)，Cookie 里才是原文（核心不变式）', async () => {
  const { db, calls } = fakeDb()
  const token = await createSession(db, 7)
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /INSERT INTO sessions/)
  const [boundToken, userId] = calls[0].binds
  assert.equal(boundToken, await sha256Of(token)) // 库里是哈希
  assert.notEqual(boundToken, token, '明文 token 不得直接落库')
  assert.equal(userId, 7)
})

test('getSessionUser：Cookie 原文哈希后比对，命中返回行、不中返回 null', async () => {
  const token = randomToken()
  const hash = await sha256Of(token)
  const row = { id: 1, username: 'xw', display_name: '小武', avatar: '' }
  const { db } = fakeDb((sql, binds) => {
    assert.match(sql, /WHERE s\.token = \? AND s\.expires_at > \?/)
    return binds[0] === hash ? row : null
  })
  assert.deepEqual(await getSessionUser(db, reqWithCookie(`${SESSION_COOKIE}=${token}`)), row)
  assert.equal(await getSessionUser(db, reqWithCookie(`${SESSION_COOKIE}=${randomToken()}`)), null)
  assert.equal(await getSessionUser(db, reqWithCookie('other=1')), null) // 无会话 Cookie 快路径
})

test('destroySession / purgeExpiredSessions：删除也先过 tokenHash', async () => {
  const token = randomToken()
  const { db, calls } = fakeDb()
  await destroySession(db, reqWithCookie(`${SESSION_COOKIE}=${token}`))
  assert.match(calls[0].sql, /DELETE FROM sessions WHERE token = \?/)
  assert.equal(calls[0].binds[0], await sha256Of(token))
  await purgeExpiredSessions(db)
  assert.match(calls[1].sql, /DELETE FROM sessions WHERE expires_at < \?/)
})

test('会员会话：独立 Cookie、SQL 带 banned 过滤、改密踢其他设备保留当前会话', async () => {
  const token = randomToken()
  const { db, calls } = fakeDb(() => ({ id: 3, username: 'm', display_name: '会员', avatar: '', tier: 'normal', points: 0 }))
  assert.equal(MEMBER_SESSION_COOKIE, 'xw_member_session')
  assert.match(memberSessionCookie(token), /^xw_member_session=/)
  assert.match(clearSessionCookie(), /^bloghao_session=;/)

  const memberRow = await getMemberUser(db, reqWithCookie(`${MEMBER_SESSION_COOKIE}=${token}`))
  assert.ok(memberRow)
  const memberSql = calls[0].sql
  assert.match(memberSql, /JOIN members m ON m\.id = s\.member_id/)
  assert.match(memberSql, /s\.expires_at > \?/)
  assert.match(memberSql, /m\.status = 'active'/) // banned 查询层即未登录
  assert.equal(calls[0].binds[0], await sha256Of(token))

  await createMemberSession(db, 3)
  assert.match(calls[1].sql, /INSERT INTO member_sessions/)
  assert.notEqual(calls[1].binds[0], token)

  await destroyOtherMemberSessions(db, 3, token)
  assert.match(calls[2].sql, /DELETE FROM member_sessions WHERE member_id = \? AND token <> \?/)
  assert.equal(calls[2].binds[0], 3)
  assert.equal(calls[2].binds[1], await sha256Of(token)) // 被保留的当前会话同样按哈希比对
})

test('sessionCookie：HttpOnly + Secure + SameSite=Lax 属性齐全', () => {
  const c = sessionCookie('tok')
  assert.match(c, /^bloghao_session=tok;/)
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(c.includes(flag), `缺 ${flag}`)
})

test('rateLimit：窗口内计满拒绝、换 key 互不影响、窗口过期重置（fake 时钟）', () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    assert.equal(rateLimit('t:a', 2, 60_000), true)
    assert.equal(rateLimit('t:a', 2, 60_000), true)
    assert.equal(rateLimit('t:a', 2, 60_000), false) // 窗口内第 3 次拒绝
    assert.equal(rateLimit('t:b', 2, 60_000), true) // 不同 key 独立计桶
    now += 60_001
    assert.equal(rateLimit('t:a', 2, 60_000), true) // 过窗重建
  } finally {
    Date.now = realNow
  }
})

test('clientIp：CF-Connecting-IP 优先，XFF 取首段，都缺回退 0.0.0.0', () => {
  const mk = (h: Record<string, string>) => new Request('https://x.test/', { headers: h })
  assert.equal(clientIp(mk({ 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '5.6.7.8, 9.9.9.9' })), '1.2.3.4')
  assert.equal(clientIp(mk({ 'X-Forwarded-For': '5.6.7.8, 9.9.9.9' })), '5.6.7.8')
  assert.equal(clientIp(mk({})), '0.0.0.0')
})
