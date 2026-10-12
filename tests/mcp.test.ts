import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { dispatchRpc, LATEST_PROTOCOL_VERSION, MCP_TOOLS, mcpRoutes, type McpDeps, type RpcResponse } from '../src/mcp.ts'
import { ensureSchema, saveSettings } from '../src/db.ts'
import type { PostPublishedPayload, WeiboPublishedPayload } from '../src/hooks.ts'
import type { Env } from '../src/types.ts'

// ── MCP 服务器（src/mcp.ts，ROADMAP B10）──
// 三层覆盖：协议层 dispatchRpc（纯函数）、工具层（node:sqlite 真 schema 建库）、
// HTTP 薄壳 mcpRoutes（鉴权 / 202 通知 / 批处理 / demo 门控 / 405）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 极简 D1 适配（同 tests/fts.test.ts 的 d1FromSqlite，补 meta.last_row_id 供 INSERT 回读 id） */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  } as unknown as D1Database
}

interface Ctx {
  db: DatabaseSync
  d1: D1Database
  deps: McpDeps
  posted: PostPublishedPayload[]
  weiboed: WeiboPublishedPayload[]
}

async function makeCtx(): Promise<Ctx> {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  const d1 = d1FromSqlite(db)
  await ensureSchema(d1)
  const posted: PostPublishedPayload[] = []
  const weiboed: WeiboPublishedPayload[] = []
  const deps: McpDeps = {
    db: d1,
    siteUrl: 'https://blog.example.com',
    hooks: {
      postPublished: (p) => posted.push(p),
      weiboPublished: (p) => weiboed.push(p),
    },
  }
  return { db, d1, deps, posted, weiboed }
}

/** 纯函数派发后取 result（断言非协议错误并原样返回 result） */
function resultOf(res: RpcResponse | null): any {
  assert.ok(res, '应有响应')
  assert.equal(res.error, undefined, `不应有协议错误：${JSON.stringify(res.error)}`)
  return res.result
}

function errorOf(res: RpcResponse | null): { code: number; message: string } {
  assert.ok(res, '应有响应')
  assert.ok(res.error, `应有错误：${JSON.stringify(res)}`)
  return res.error
}

/** isError 工具错误（业务校验失败走 result.isError，不是 JSON-RPC error） */
async function toolError(deps: McpDeps, params: unknown): Promise<string> {
  const res = await dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/call', params })
  assert.ok(res && res.result && !res.error)
  const r = res.result as { content: { text: string }[]; isError?: boolean }
  assert.equal(r.isError, true, `应为 isError 工具错误：${JSON.stringify(r)}`)
  return r.content[0].text
}

function toolOut(res: any): any {
  assert.equal(res.isError, undefined, '成功结果不应带 isError')
  return JSON.parse(res.content[0].text)
}

/* ---------------- 协议层 ---------------- */

test('initialize：支持清单内的版本原样回，能力位带 tools', async () => {
  const { deps } = await makeCtx()
  const r = resultOf(
    await dispatchRpc(deps, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x' } },
    })
  )
  assert.equal(r.protocolVersion, '2025-03-26')
  assert.deepEqual(r.capabilities.tools, { listChanged: false })
  assert.equal(r.serverInfo.name, 'bloghao')
})

test('initialize：未知 / 缺失版本回服务端最新', async () => {
  const { deps } = await makeCtx()
  const r1 = resultOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }))
  const r2 = resultOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 2, method: 'initialize' }))
  assert.equal(r1.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.equal(r2.protocolVersion, LATEST_PROTOCOL_VERSION)
})

test('通知（notifications/* 与无 id 请求）返回 null，路由层据此回 202', async () => {
  const { deps } = await makeCtx()
  assert.equal(await dispatchRpc(deps, { jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await dispatchRpc(deps, { jsonrpc: '2.0', method: 'tools/list' }), null)
})

test('ping 回空对象；未知方法 -32601', async () => {
  const { deps } = await makeCtx()
  assert.deepEqual(resultOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 'p', method: 'ping' })), {})
  assert.equal(errorOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 9, method: 'resources/list' })).code, -32601)
})

test('非法信封：无 jsonrpc/method 回 -32600；带合法 id 则回显 id', async () => {
  const { deps } = await makeCtx()
  assert.equal(errorOf(await dispatchRpc(deps, { method: 'tools/list' })).code, -32600)
  assert.equal(errorOf(await dispatchRpc(deps, { jsonrpc: '2.0', method: 123 })).code, -32600)
  const r = await dispatchRpc(deps, { jsonrpc: '1.0', id: 'keep-me', method: 'tools/list' })
  assert.equal(r?.id, 'keep-me')
  assert.equal(errorOf(r).code, -32600)
  assert.equal((await dispatchRpc(deps, null))?.id, null, '完全不可解析时 id 为 null')
})

test('tools/list：五个工具，schema 自洽（required 与 properties 对得上）', async () => {
  const { deps } = await makeCtx()
  const r = resultOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  const names = r.tools.map((t: any) => t.name)
  assert.deepEqual(names, ['publish_post', 'list_posts', 'get_post', 'list_comments', 'publish_weibo'])
  for (const t of r.tools) {
    assert.ok(t.title && t.description, 'title/description 必须带（客户端展示用）')
    assert.equal(t.inputSchema.type, 'object')
    for (const req of t.inputSchema.required ?? []) {
      assert.ok(t.inputSchema.properties[req], `${t.name} 的 required 字段 ${req} 必须在 properties 里`)
    }
  }
  assert.deepEqual(r.tools[0].inputSchema.required, ['title', 'content'])
})

test('tools/call：未知工具与缺工具名都是 -32602（协议层错误）', async () => {
  const { deps } = await makeCtx()
  assert.equal(errorOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_site' } })).code, -32602)
  assert.equal(errorOf(await dispatchRpc(deps, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })).code, -32602)
})

/* ---------------- 工具层（真库） ---------------- */

test('publish_post：Markdown 默认格式，存库是净化后的 HTML，默认草稿 + 自动摘要', async () => {
  const { db, deps } = await makeCtx()
  const out = toolOut(
    resultOf(
      await dispatchRpc(deps, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'publish_post', arguments: { title: '我的第一篇', content: '# 大标题\n\n正文段落，含 <script>alert(1)</script> 片段。' } },
      })
    )
  )
  assert.equal(out.status, 'draft', '默认存草稿')
  assert.match(out.slug, /^\d{8}-[a-z0-9]{4}$/, '中文标题自动 slug 走日期口径')
  assert.equal(out.url, `https://blog.example.com/post/${out.slug}`)
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(out.id) as any
  assert.ok(row, '文章已落库')
  assert.match(row.content, /<h1/)
  assert.doesNotMatch(row.content, /<script/, '净化器必须拦掉内联脚本')
  assert.ok(row.summary, '自动摘要非空')
  assert.doesNotMatch(row.summary, /<(h1|p|div)\b/i, '摘要截取自净化正文纯文本，结构标签不进导读面')
  assert.equal(row.status, 'draft')
  assert.equal(row.published_at, null)
})

test('publish_post：published 立即发布 + 钩子同路广播（via=mcp，locked 透传）', async () => {
  const { deps, posted } = await makeCtx()
  const out = toolOut(
    resultOf(
      await dispatchRpc(deps, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'publish_post', arguments: { title: 'Hello MCP', content: '正文', status: 'published', tags: ['  测试 ', ''] } },
      })
    )
  )
  assert.equal(out.status, 'published')
  assert.equal(posted.length, 1, '发布事件必须广播')
  assert.equal(posted[0].via, 'mcp')
  assert.equal(posted[0].locked, false, 'v1 工具面开不了锁，locked 恒 false')
  assert.equal(posted[0].slug, out.slug)
  const row = (await deps.db.prepare('SELECT tags, published_at FROM posts WHERE id = ?').bind(out.id).first<any>())!
  assert.deepEqual(JSON.parse(row.tags), ['测试'], '空标签剔掉、首尾空白修剪')
  assert.ok(row.published_at > 0, '发布时间已落')
})

test('publish_post：自定义 slug 撞名自动加序号（uniqueSlug 兜底）', async () => {
  const { deps } = await makeCtx()
  const call = (status: string) =>
    dispatchRpc(deps, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'publish_post', arguments: { title: 'T', content: 'C', slug: 'my-post', status } },
    }).then(resultOf)
  const a = toolOut(await call('draft'))
  const b = toolOut(await call('published'))
  assert.equal(a.slug, 'my-post')
  assert.equal(b.slug, 'my-post-2')
})

test('publish_post：html 格式走净化器；空标题 / 空正文是 isError 工具错误', async () => {
  const { db, deps } = await makeCtx()
  const out = toolOut(
    resultOf(
      await dispatchRpc(deps, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'publish_post', arguments: { title: 'H', content: '<p>段落</p><script>x()</script>', format: 'html' } },
      })
    )
  )
  const row = db.prepare('SELECT content FROM posts WHERE id = ?').get(out.id) as any
  assert.match(row.content, /<p>段落<\/p>/)
  assert.doesNotMatch(row.content, /script/)

  assert.match(await toolError(deps, { name: 'publish_post', arguments: { title: '', content: 'x' } }), /title/)
  assert.match(await toolError(deps, { name: 'publish_post', arguments: { title: 'T', content: '   ' } }), /content/)
})

/* ---------------- list_posts / get_post ---------------- */

test('list_posts：状态过滤 + 关键词命中 + 加密文不出关键词搜索、带 hasPassword 标志', async () => {
  const { db, deps } = await makeCtx()
  db.exec(`INSERT INTO posts (slug, title, content, summary, status, password_hash, created_at, updated_at, deleted_at)
           VALUES ('a','部署教程入门','正文A','摘要A','published','',1,1,NULL)`)
  db.exec(`INSERT INTO posts (slug, title, content, summary, status, password_hash, created_at, updated_at, deleted_at)
           VALUES ('b','加密的部署教程','正文B','摘要B','published','salt:hash',2,2,NULL)`)
  db.exec(`INSERT INTO posts (slug, title, content, status, created_at, updated_at, deleted_at)
           VALUES ('c','草稿C','正文C','draft',3,3,NULL)`)
  db.exec(`INSERT INTO posts (slug, title, content, status, created_at, updated_at, deleted_at)
           VALUES ('d','回收站D','正文D','published',4,4,99)`)

  const call = (args: any) =>
    dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_posts', arguments: args } }).then(resultOf)
  const all = toolOut(await call({}))
  assert.equal(all.total, 3, '回收站行不出（listPosts 过滤 deleted_at）')
  const pub = toolOut(await call({ status: 'published' }))
  assert.deepEqual(pub.items.map((i: any) => i.slug), ['b', 'a'], 'recency 倒序：created_at 新的在前')
  assert.equal(pub.items.find((i: any) => i.slug === 'b').hasPassword, true)
  const q = toolOut(await call({ q: '部署教程' }))
  assert.deepEqual(q.items.map((i: any) => i.slug), ['a'], '加密文整体退出关键词搜索（命中即泄露）')
  for (const i of all.items) assert.equal(i.content, undefined, '列表不出正文')
})

test('get_post：id / slug 双路取全文，password_hash 永不出参', async () => {
  const { db, deps } = await makeCtx()
  db.exec(`INSERT INTO posts (slug, title, content, summary, status, password_hash, created_at, updated_at, deleted_at)
           VALUES ('gp','标题','<p>全文</p>','摘要','published','salt:hash',1,1,NULL)`)
  const call = (args: any) =>
    dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_post', arguments: args } }).then(resultOf)
  const bySlug = toolOut(await call({ slug: 'gp' }))
  assert.equal(bySlug.content, '<p>全文</p>')
  assert.equal(bySlug.hasPassword, true)
  assert.ok(!('password_hash' in bySlug), '哈希字段不得出现在出参')
  const byId = toolOut(await call({ id: bySlug.id }))
  assert.equal(byId.slug, 'gp')

  assert.match(await toolError(deps, { name: 'get_post', arguments: { slug: 'nope' } }), /不存在/)
  assert.match(await toolError(deps, { name: 'get_post', arguments: {} }), /id 或 slug/)
})

/* ---------------- list_comments ---------------- */

test('list_comments：默认待审优先，type 过滤，敏感列（email/qq/ip/avatar）不出参', async () => {
  const { db, deps } = await makeCtx()
  db.exec(`INSERT INTO posts (slug, title, content, status, created_at, updated_at) VALUES ('p1','被评文章','正文','published',1,1)`)
  db.exec(`INSERT INTO weibo (content, images, topics, status, created_at, updated_at) VALUES ('微博正文','[]','[]','published',1,1)`)
  const now = Date.now()
  db.prepare(
    `INSERT INTO comments (post_id, weibo_id, parent_id, nickname, email, website, qq, avatar, content, status, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(1, 0, 0, '访客A', 'a@x.com', 'https://a.com', '12345', '', '待审评论', 'pending', '1.2.3.4', now)
  db.prepare(`INSERT INTO comments (post_id, weibo_id, parent_id, nickname, email, content, status, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    0,
    1,
    0,
    '访客B',
    'b@x.com',
    '微博评论',
    'approved',
    '1.2.3.4',
    now + 1
  )
  db.prepare(`INSERT INTO comments (post_id, weibo_id, parent_id, nickname, content, status, created_at) VALUES (?,?,?,?,?,?,?)`).run(
    0,
    0,
    0,
    '访客C',
    '留言板留言',
    'approved',
    now + 2
  )

  const call = (args: any) =>
    dispatchRpc(deps, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_comments', arguments: args } }).then(resultOf)
  const pending = toolOut(await call({}))
  assert.equal(pending.total, 1, '默认只拉待审')
  assert.equal(pending.items[0].nickname, '访客A')
  assert.equal(pending.items[0].post_title, '被评文章', '带文章标题上下文')
  for (const key of ['email', 'qq', 'ip', 'avatar']) assert.ok(!(key in pending.items[0]), `敏感列 ${key} 不出参`)

  const approved = toolOut(await call({ status: 'approved', type: 'weibo' }))
  assert.equal(approved.total, 1)
  assert.equal(approved.items[0].weibo_content, '微博正文')
  const gb = toolOut(await call({ status: 'all', type: 'guestbook' }))
  assert.equal(gb.total, 1)
  assert.equal(gb.items[0].content, '留言板留言')
})

/* ---------------- publish_weibo ---------------- */

test('publish_weibo：落库 + 话题提取 + 钩子广播（via=external，与开放 API 同口径）', async () => {
  const { db, deps, weiboed } = await makeCtx()
  const out = toolOut(
    resultOf(
      await dispatchRpc(deps, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'publish_weibo', arguments: { content: '今天写了个 #日常# 记录', images: ['/images/a.png', 'https://cdn.example.com/b.jpg'] } },
      })
    )
  )
  assert.equal(out.status, 'published')
  assert.match(out.url, /\/weibo\?wb=\d+#wb-\d+/)
  assert.equal(out.images.length, 2, '合法站内/外链地址都保留')
  const row = db.prepare('SELECT * FROM weibo WHERE id = ?').get(out.id) as any
  assert.ok(row.topics.includes('日常'), '话题自动提取')
  assert.equal(weiboed.length, 1)
  assert.equal(weiboed[0].via, 'external')
  assert.deepEqual(weiboed[0].images, ['/images/a.png', 'https://cdn.example.com/b.jpg'])
})

test('publish_weibo：图片地址全无效 / 空内容是 isError；draft 不广播', async () => {
  const { deps, weiboed } = await makeCtx()
  assert.match(await toolError(deps, { name: 'publish_weibo', arguments: { content: '文字', images: ['ftp://x'] } }), /无效/)
  assert.match(await toolError(deps, { name: 'publish_weibo', arguments: { images: [] } }), /至少/)
  const draft = toolOut(
    resultOf(
      await dispatchRpc(deps, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'publish_weibo', arguments: { content: '草稿微博', status: 'draft' } },
      })
    )
  )
  assert.equal(draft.status, 'draft')
  assert.equal(weiboed.length, 0, '草稿不广播')
})

/* ---------------- HTTP 薄壳（鉴权 / 202 / 批处理 / demo / 405） ---------------- */

type EcStub = { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void }

async function makeRouteCtx(opts: { demo?: boolean; token?: string } = {}) {
  const ctx = await makeCtx()
  if (opts.token) await saveSettings(ctx.d1, { externalToken: opts.token })
  const env = { DB: ctx.d1, IMAGES: {}, ASSETS: {}, DEMO_MODE: opts.demo ? '1' : undefined } as unknown as Env
  const waited: Promise<unknown>[] = []
  const ec: EcStub = { waitUntil: (p) => waited.push(p), passThroughOnException: () => {} }
  return { ...ctx, env, ec, waited }
}

function post(ctx: { env: Env; ec: EcStub }, body: string | unknown, headers: Record<string, string> = {}) {
  return mcpRoutes.request(
    'https://blog.example.com/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    ctx.env,
    ctx.ec as never
  )
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }
const AUTH = { Authorization: 'Bearer right-token-abcdef' }

test('薄壳：未配 token / 错 token 都 401；GET 与 DELETE 405', async () => {
  const noToken = await makeRouteCtx()
  assert.equal((await post(noToken, INIT)).status, 401, '空 Token = 接口关闭')
  const noToken2 = await makeRouteCtx()
  assert.equal((await post(noToken2, INIT, { 'CF-Connecting-IP': '10.9.0.1' })).status, 401)

  const ctx = await makeRouteCtx({ token: 'right-token-abcdef' })
  assert.equal((await post(ctx, INIT, { Authorization: 'Bearer wrong-token', 'CF-Connecting-IP': '10.9.0.2' })).status, 401, 'Bearer 错 token')

  const g = await mcpRoutes.request('https://blog.example.com/', { method: 'GET' }, ctx.env, ctx.ec as never)
  assert.equal(g.status, 405)
  const d = await mcpRoutes.request('https://blog.example.com/', { method: 'DELETE' }, ctx.env, ctx.ec as never)
  assert.equal(d.status, 405)
})

test('薄壳：正确 Bearer 进协议层；X-Auth-Token 备用头同效', async () => {
  const ctx = await makeRouteCtx({ token: 'right-token-abcdef' })
  const r = await post(ctx, INIT, AUTH)
  assert.equal(r.status, 200)
  assert.equal(((await r.json()) as any).result.protocolVersion, '2025-06-18')
  const r2 = await post(ctx, INIT, { 'X-Auth-Token': 'right-token-abcdef', 'CF-Connecting-IP': '10.9.1.2' })
  assert.equal(r2.status, 200)
})

test('薄壳：通知回 202 空 body；全通知批处理也 202；混合批只回请求的响应', async () => {
  const ctx = await makeRouteCtx({ token: 'right-token-abcdef' })
  const n = await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, AUTH)
  assert.equal(n.status, 202)
  assert.equal(await n.text(), '')
  const n2 = await post(ctx, [{ jsonrpc: '2.0', method: 'notifications/initialized' }], { ...AUTH, 'CF-Connecting-IP': '10.9.2.1' })
  assert.equal(n2.status, 202)
  const mixed = await post(ctx, [INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }], { ...AUTH, 'CF-Connecting-IP': '10.9.2.2' })
  assert.equal(mixed.status, 200)
  const arr: any = await mixed.json()
  assert.equal(arr.length, 1, '批处理里只有请求有响应')
  assert.equal(arr[0].result.protocolVersion, '2025-06-18')
})

test('薄壳：坏 JSON 回 400 parse error；空数组批 -32600；demo 门控 404', async () => {
  const ctx = await makeRouteCtx({ token: 'right-token-abcdef' })
  const bad = await post(ctx, '{not json', AUTH)
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as any).error.code, -32700)

  const empty = await post(ctx, [], { ...AUTH, 'CF-Connecting-IP': '10.9.3.1' })
  assert.equal(empty.status, 400)
  assert.equal(((await empty.json()) as any).error.code, -32600)

  const demo = await makeRouteCtx({ demo: true, token: 'right-token-abcdef' })
  assert.equal((await post(demo, INIT, { ...AUTH, 'CF-Connecting-IP': '10.9.3.2' })).status, 404, '演示站不开放 MCP 接入')
})

test('薄壳：tools/call 全链路真发文落库（waitUntil 接住发布广播不阻塞响应）', async () => {
  const ctx = await makeRouteCtx({ token: 'right-token-abcdef' })
  const r = await post(
    ctx,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'publish_post', arguments: { title: '路由层发布', content: '正文', status: 'published' } } },
    { ...AUTH, 'CF-Connecting-IP': '10.9.4.1' }
  )
  assert.equal(r.status, 200)
  // waitUntil 收到的发布广播跑完（fireHook 吞错，不致悬挂）
  await Promise.allSettled(ctx.waited)
  const row = await ctx.d1.prepare('SELECT title, status FROM posts ORDER BY id DESC').first<any>()
  assert.equal(row?.title, '路由层发布')
  assert.equal(row?.status, 'published')
})
