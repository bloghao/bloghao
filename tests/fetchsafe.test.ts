import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchableUrl, isPrivateHost } from '../src/fetchsafe.ts'

// ── 出网 SSRF 防线（src/fetchsafe.ts）：私网判定与统一入口 ──
// fetchableUrl 的基础口径回归在 tests/linkmeta.test.ts（历史导入路径），这里补
// 「黑名单表示法绕过」增强面：IPv6 字面量、整数/十六进制/八进制 IPv4 写法。

test('isPrivateHost：点分 IPv4 私网段', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.1.2.3', '100.64.0.1', '239.1.2.3']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '1.2.3.4']) {
    assert.equal(isPrivateHost(h), false, h)
  }
})

test('isPrivateHost：整数 / 十六进制 / 八进制 IPv4 表示（URL 解析器认，黑名单必须同样认）', () => {
  // 2130706433 = 127.0.0.1；0x7f000001 = 127.0.0.1；0177.0.0.1 = 127.0.0.1；127.1 = 127.0.0.1
  for (const h of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.1', '2852039166']) {
    assert.equal(isPrivateHost(h), true, h)
  }
})

test('isPrivateHost：IPv6 字面量（含 IPv4-mapped / NAT64 / ULA / link-local）', () => {
  for (const h of ['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'fc00::1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  assert.equal(isPrivateHost('2606:4700::1'), false)
})

test('isPrivateHost：主机名与可疑形态', () => {
  for (const h of ['localhost', 'a.localhost', 'x.local', 'y.internal', '']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  // 真域名不能被数字形态判定误杀（cafe 全是 hex 字母）
  assert.equal(isPrivateHost('cafe.example.com'), false)
  assert.equal(isPrivateHost('example.com'), false)
})

test('fetchableUrl：私网与可疑表示一律拒绝，公网放行', () => {
  assert.equal(fetchableUrl('http://2130706433/'), null)
  assert.equal(fetchableUrl('http://[::1]/x'), null)
  assert.equal(fetchableUrl('http://[::ffff:169.254.169.254]/x'), null)
  assert.equal(fetchableUrl('http://0x7f.0.0.1/x'), null)
  assert.equal(fetchableUrl('http://metadata.google.internal/x'), null)
  assert.equal(fetchableUrl('http://example.com:9000/x'), null)
  assert.ok(fetchableUrl('http://example.com:8443/x'))
  assert.ok(fetchableUrl('https://bloghao.com/post/x'))
})

// ── fetchPublicResource：重定向逐跳复查 + 流式限长（此前零覆盖，是 SSRF 防线的核心闸）──
import { fetchPublicResource, readBodyLimited } from '../src/fetchsafe.ts'

/** 临时替换全局 fetch：路由表 url → Response；记录每次实际请求的 URL（逐跳复查的观测点） */
function stubFetch(routes: Map<string, Response | 'timeout'>): { hits: string[]; restore: () => void } {
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

const res = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } })

test('fetchPublicResource：公网 302 落点逐跳复查，落公网放行并返回末跳响应', async () => {
  const s = stubFetch(
    new Map([
      ['https://a.example/start', new Response(null, { status: 302, headers: { location: 'https://b.example/final' } })],
    ])
  )
  try {
    s.hits.length = 0
    const r = await fetchPublicResource('https://a.example/start', { maxBytes: 1024, timeoutMs: 1000 })
    // stub 里 b.example/final 没登记 → 404 → null；关键是第二个请求必须发出且指向落点
    assert.deepEqual(s.hits, ['https://a.example/start', 'https://b.example/final'])
    assert.equal(r, null)
  } finally {
    s.restore()
  }
})

test('fetchPublicResource：302 到私网地址被逐跳复查拦下（公网→169.254.169.254 经典绕过）', async () => {
  const s = stubFetch(
    new Map([
      ['https://a.example/evil', new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })],
    ])
  )
  try {
    const r = await fetchPublicResource('https://a.example/evil', { maxBytes: 1024, timeoutMs: 1000 })
    assert.equal(r, null) // 第二跳根本不该发出去
    assert.equal(s.hits.length, 1)
  } finally {
    s.restore()
  }
})

test('fetchPublicResource：非 2xx / 超过跳数上限 / 起点私网，一律 null', async () => {
  const s = stubFetch(
    new Map([
      ['https://a.example/500', res('x', 500)],
      ['https://a.example/loop', new Response(null, { status: 302, headers: { location: 'https://a.example/loop2' } })],
      ['https://a.example/loop2', new Response(null, { status: 302, headers: { location: 'https://a.example/loop' } })],
    ])
  )
  try {
    assert.equal(await fetchPublicResource('https://a.example/500', { maxBytes: 1024, timeoutMs: 1000 }), null)
    assert.equal(await fetchPublicResource('https://a.example/loop', { maxBytes: 1024, timeoutMs: 1000 }), null)
    assert.equal(await fetchPublicResource('http://127.0.0.1/x', { maxBytes: 1024, timeoutMs: 1000 }), null)
  } finally {
    s.restore()
  }
})

test('fetchPublicResource：超限响应断流返回 null，不整读进内存', async () => {
  const s = stubFetch(new Map([['https://a.example/big', res('x'.repeat(4096))]]))
  try {
    const r = await fetchPublicResource('https://a.example/big', { maxBytes: 1024, timeoutMs: 1000 })
    assert.equal(r, null)
  } finally {
    s.restore()
  }
})

test('fetchPublicResource：method/body 透传 + expectBody:false 不读响应体（204 空体也算成功）', async () => {
  const seen: RequestInit[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init || {})
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    const r = await fetchPublicResource('https://a.example/hook', {
      maxBytes: 1024, timeoutMs: 1000, method: 'POST', body: '{"x":1}', expectBody: false,
    })
    assert.ok(r, '204 空体在 expectBody:false 下算成功（webhook「只发不收」）')
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].body, '{"x":1}')
    assert.equal(seen[0].redirect, 'manual', '逐跳复查口径不变')
    // 默认（expectBody 未设）下无体响应 → null（只读抓取口径字节级不变）
    assert.equal(await fetchPublicResource('https://a.example/x', { maxBytes: 1024, timeoutMs: 1000 }), null)
  } finally {
    globalThis.fetch = orig
  }
})

test('readBodyLimited：限内返回完整字节，超限断流返回 null', async () => {
  assert.ok(await readBodyLimited(res('hello'), 100))
  assert.equal(await readBodyLimited(res('x'.repeat(100)), 10), null)
  assert.equal(await readBodyLimited(new Response(null), 100), null) // 无 body
})

test('isPrivateHost：NAT64 64:ff9b::/96 内嵌私网 IPv4 按私网拒绝', () => {
  assert.equal(isPrivateHost('64:ff9b::192.0.2.1'), false) // 内嵌公网地址不误杀
  assert.equal(isPrivateHost('64:ff9b::10.0.0.1'), true)
  assert.equal(isPrivateHost('64:ff9b::a9fe:a9fe'), true) // 169.254.169.254 十六进制形态
})
