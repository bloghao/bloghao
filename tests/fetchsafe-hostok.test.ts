import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPublicResource } from '../src/fetchsafe.ts'

// ── fetchsafe 的 opts.hostOk 域名白名单钩子（src/fetchsafe.ts）──
// 防线（AGENTS「出网安全」/ 2026-10-12 审计 B4 修复）：白名单代理（douban/img 封面代理等）
// 的每一跳——含起点——都必须在 fetchableUrl 之外再过 hostOk，白名单域 302 出白名单同样算越界。
// fetchsafe.test.ts 覆盖 fetchableUrl/重定向/限长的基线，本文件专钉 hostOk 钩子（此前零覆盖）。

/** 临时替换全局 fetch：路由表 url → Response；记录每次实际请求的 URL（逐跳复查的观测点） */
function stubFetch(routes: Map<string, Response>): { hits: string[]; restore: () => void } {
  const hits: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input instanceof URL ? input : input instanceof Request ? input.url : input)
    hits.push(u)
    const r = routes.get(u)
    if (!r) return new Response('not found', { status: 404 })
    return r
  }) as typeof fetch
  return { hits, restore: () => (globalThis.fetch = orig) }
}

const redirect = (loc: string) => new Response(null, { status: 302, headers: { location: loc } })

test('hostOk：起点域名不在白名单直接拒绝，一次请求都不发', async () => {
  const s = stubFetch(new Map())
  try {
    const r = await fetchPublicResource('https://evil.example/x', {
      maxBytes: 1024,
      timeoutMs: 1000,
      hostOk: (h) => h === 'cdn.doubanio.com',
    })
    assert.equal(r, null)
    assert.equal(s.hits.length, 0, '白名单外起点不得发出任何请求')
  } finally {
    s.restore()
  }
})

test('hostOk：白名单起点 302 出白名单，逐跳复检拦下（第二跳不发出）', async () => {
  const s = stubFetch(
    new Map([['https://cdn.doubanio.com/cover', redirect('https://evil.example/payload')]])
  )
  try {
    const r = await fetchPublicResource('https://cdn.doubanio.com/cover', {
      maxBytes: 1024,
      timeoutMs: 1000,
      hostOk: (h) => /^(cdn\.doubanio\.com|img\d?\.doubanio\.com)$/.test(h),
    })
    assert.equal(r, null)
    assert.deepEqual(s.hits, ['https://cdn.doubanio.com/cover'], '越界落点不得发请求')
  } finally {
    s.restore()
  }
})

test('hostOk：白名单域之间 302 跟跳放行，返回末跳响应', async () => {
  const s = stubFetch(
    new Map([
      ['https://cdn.doubanio.com/cover', redirect('https://img1.doubanio.com/real.jpg')],
      ['https://img1.doubanio.com/real.jpg', new Response('JPEGBYTES', { status: 200, headers: { 'content-type': 'image/jpeg' } })],
    ])
  )
  try {
    const r = await fetchPublicResource('https://cdn.doubanio.com/cover', {
      maxBytes: 1024,
      timeoutMs: 1000,
      hostOk: (h) => /^(cdn\.doubanio\.com|img1\.doubanio\.com)$/.test(h),
    })
    assert.ok(r, '白名单内跟跳应放行')
    assert.equal(new TextDecoder().decode(r.buf), 'JPEGBYTES')
    assert.deepEqual(s.hits, ['https://cdn.doubanio.com/cover', 'https://img1.doubanio.com/real.jpg'])
  } finally {
    s.restore()
  }
})

test('hostOk 放行不豁免 fetchableUrl：白名单钩子放行私网地址仍被起点校验拒绝', async () => {
  const s = stubFetch(new Map())
  try {
    const r = await fetchPublicResource('http://169.254.169.254/latest/meta-data', {
      maxBytes: 1024,
      timeoutMs: 1000,
      hostOk: () => true, // 恶意/错误的白名单钩子不能架空 SSRF 基线
    })
    assert.equal(r, null)
    assert.equal(s.hits.length, 0)
  } finally {
    s.restore()
  }
})
