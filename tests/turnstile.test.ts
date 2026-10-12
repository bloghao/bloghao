import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyTurnstile } from '../src/turnstile.ts'

// ── 注册人机验证（Turnstile，A2 根治）：siteverify 固定端点直连，fetch 注入桩测 ──

/** 桩：记录请求形状，按脚本回响应；URL/方法/头与体都要核对（占位符错位式的真 bug 靠这个拦） */
function stubFetch(respond: () => { status: number; body: unknown } | null) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = respond()
    if (!r) throw new TypeError('network down')
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('verifyTurnstile：成功结论返回 true，请求形状正确（POST + form 编码 + 三参数）', async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: { success: true } }))
  assert.equal(await verifyTurnstile('sec-key', 'tok-value', '203.0.113.9', impl), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded')
  const body = String(calls[0].init.body)
  assert.ok(body.includes('secret=sec-key'), 'body 应带 secret')
  assert.ok(body.includes('response=tok-value'), 'body 应带 response=token')
  assert.ok(body.includes('remoteip=203.0.113.9'), '带 remoteip 时应透传')
})

test('verifyTurnstile：不传 remoteip 则 body 不带该参数', async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: { success: true } }))
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, impl), true)
  assert.ok(!String(calls[0].init.body).includes('remoteip'))
})

test('verifyTurnstile：secret 或 token 为空直接 false，不打 siteverify', async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: { success: true } }))
  assert.equal(await verifyTurnstile('', 'tok', undefined, impl), false)
  assert.equal(await verifyTurnstile('sec', '', undefined, impl), false)
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, impl), true) // 对照组：正常放行
  assert.equal(calls.length, 1, '前两次空参数不应发出请求')
})

test('verifyTurnstile：siteverify 明确拒绝（success:false）与未知响应形状都判失败', async () => {
  const no = stubFetch(() => ({ status: 200, body: { success: false, 'error-codes': ['invalid-input-response'] } }))
  assert.equal(await verifyTurnstile('sec', 'bad-token', undefined, no.impl), false)
  const weird = stubFetch(() => ({ status: 200, body: { ok: 1 } }))
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, weird.impl), false, '非 success===true 一律 false')
  const str = stubFetch(() => ({ status: 200, body: { success: 'true' } }))
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, str.impl), false, '字符串 true 不算数')
})

test('verifyTurnstile：HTTP 非 2xx 与网络异常一律 false（fail closed）', async () => {
  const err = stubFetch(() => ({ status: 503, body: { success: false } }))
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, err.impl), false)
  const down = stubFetch(() => null)
  assert.equal(await verifyTurnstile('sec', 'tok', undefined, down.impl), false, 'fetch 抛错按未通过处理')
})
