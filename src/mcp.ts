/**
 * MCP 服务器（Model Context Protocol）：AI 助手（Claude Code / Cursor 等）直接发文、查评论
 *
 * POST /mcp      Streamable HTTP 无状态模式：JSON-RPC 2.0 进、application/json 出，不开 SSE
 * GET /mcp       405（不做服务端推送流与会话保持——Workers isolate 短生命周期，无状态最贴合）
 *
 * 鉴权复用开放 API 的 externalToken（后台「设置 → 外部发布」生成；空 Token = 接口关闭）：
 * 同一枚令牌，能发微博就能发文章，权限层级一致（token = 发布权限，见 GUIDE §8）。
 *
 * 独立成模块（同 src/closed.ts 的理由）：协议层 dispatchRpc 是纯函数、工具处理器 db 第一参数
 * 依赖注入，Node 测试可直接导入（tests/mcp.test.ts）。闭站不进白名单——与 /api/external、
 * /api/telegram 同口径「闭站连写入一起关死」，index.ts 的全局闭站中间件自动覆盖本路由。
 */
import { Hono } from 'hono'
import { clientIp, rateLimit, safeEqual } from './auth'
import {
  getPostById,
  getPostBySlug,
  getSettings,
  listPosts,
  MAX_CONTENT_BYTES,
  parseTags,
  parseWeiboImages,
  postAdminView,
  uniqueSlug,
  WEIBO_MAX_CHARS,
  WEIBO_MAX_IMAGES,
} from './db'
import { insertWeibo } from './external'
import { firePostPublished, fireWeiboPublished } from './hooks'
import type { PostPublishedPayload, WeiboPublishedPayload } from './hooks'
import { mdToHtml } from './markdown'
import { siteBase } from './render'
import { sanitizeHtml } from './sanitize'
import type { Env, PostRow } from './types'
import { clampInt, cleanSlug, excerpt, isDemo, slugify } from './utils'

/* ---------------- 协议层（纯函数，Node 可测） ---------------- */

/** 支持并协商的 MCP 协议版本（Streamable HTTP 自 2025-03-26 起） */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]

const SERVER_INFO = { name: 'bloghao', title: '博客号 BlogHao', version: '0.1.0' }

const RPC_PARSE_ERROR = -32700
const RPC_INVALID_REQUEST = -32600
const RPC_METHOD_NOT_FOUND = -32601
const RPC_INVALID_PARAMS = -32602

export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpDeps {
  db: D1Database
  /** 站点基址（siteUrl 优先，回落请求 origin），供出参拼文章/微博直达链接 */
  siteUrl: string
  /** 发布广播（路由层用 waitUntil 包 fireHook；测试注入收集器） */
  hooks: {
    postPublished: (p: PostPublishedPayload) => void
    weiboPublished: (p: WeiboPublishedPayload) => void
  }
}

interface ToolContent {
  type: 'text'
  text: string
}

interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  run: (deps: McpDeps, args: Record<string, unknown>) => Promise<ToolResult>
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** 协议层错误（未知工具 / 缺参数等），dispatchRpc 捕获后转 JSON-RPC error 响应 */
class RpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

function rpcResult(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ---------------- 工具层 ---------------- */

async function runPublishPost(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const title = String(args.title ?? '')
    .slice(0, 150)
    .trim()
  const raw = String(args.content ?? '')
  if (!title) return fail('缺少 title（文章标题）')
  if (!raw.trim()) return fail('缺少 content（正文）')
  // 正文两段净化：Markdown 先转 HTML（= 后台编辑器 MD 模式保存链路），两种格式统一过净化器
  const content = args.format === 'html' ? sanitizeHtml(raw) : sanitizeHtml(mdToHtml(raw))
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return fail('正文过长（上限约 1MB）')
  const status = args.status === 'published' ? 'published' : 'draft'
  const tags = Array.isArray(args.tags)
    ? args.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 8)
    : []
  const summary = String(args.summary ?? '')
    .trim()
    .slice(0, 500)
  const rawCover = String(args.cover ?? '')
    .trim()
    .slice(0, 500)
  const cover = rawCover.startsWith('/') || /^https?:\/\//i.test(rawCover) ? rawCover : ''
  const base = cleanSlug(String(args.slug ?? '')) || slugify(title)
  const slug = await uniqueSlug(deps.db, base)
  const now = Date.now()
  const res = await deps.db
    .prepare(
      `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, publish_at, min_tier, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      slug,
      title,
      content,
      // 摘要口径同后台创建：手填优先，否则净化后正文截 80 字（excerpt 吃 HTML，标签不进导读面）
      summary || excerpt(content, 80),
      cover,
      JSON.stringify(tags),
      status,
      0,
      null, // author_id：无管理员会话，留空
      status === 'published' ? now : null,
      null, // publish_at：v1 不支持定时发布（时区易错），防 scheduled 空时间卡死
      'all',
      '',
      now,
      now
    )
    .run()
  const row = await getPostById(deps.db, Number(res.meta.last_row_id))
  if (!row) return fail('文章写入失败，请重试')
  if (row.status === 'published') {
    // 与后台发布同路广播（广场同步等插件据此消费）；locked 必须透传，防加密/锁文泄漏广场
    deps.hooks.postPublished({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      via: 'mcp',
      locked: !!row.password_hash || (!!row.min_tier && row.min_tier !== 'all'),
    })
  }
  return ok({ id: row.id, slug: row.slug, status: row.status, url: `${deps.siteUrl}/post/${row.slug}` })
}

async function runListPosts(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const statusArg = String(args.status ?? 'all')
  const status = statusArg === 'published' || statusArg === 'draft' || statusArg === 'scheduled' ? statusArg : 'all'
  const q = typeof args.q === 'string' ? args.q.trim().slice(0, 50) : ''
  const r = await listPosts(deps.db, {
    status,
    q: q || undefined,
    page: clampInt(args.page, 1, 1000, 1),
    limit: clampInt(args.limit, 1, 50, 20),
  })
  return ok({
    total: r.total,
    page: r.page,
    totalPages: r.totalPages,
    items: r.items.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      summary: p.summary,
      tags: parseTags(p),
      minTier: p.min_tier,
      hasPassword: !!p.password_hash,
      createdAt: p.created_at,
      publishedAt: p.published_at,
      url: `${deps.siteUrl}/post/${p.slug}`,
    })),
  })
}

async function runGetPost(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const slug = typeof args.slug === 'string' ? args.slug.trim() : ''
  const id = Number(args.id)
  let row: PostRow | null = null
  if (Number.isInteger(id) && id > 0) row = await getPostById(deps.db, id)
  else if (slug) row = await getPostBySlug(deps.db, slug)
  else return fail('需要提供 id 或 slug 之一')
  if (!row) return fail('文章不存在')
  // postAdminView 剥 password_hash，只给 hasPassword 布尔（口令字段永不出参的老规矩）
  return ok({ ...postAdminView(row), tagList: parseTags(row), url: `${deps.siteUrl}/post/${row.slug}` })
}

async function runListComments(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const statusArg = String(args.status ?? 'pending')
  const typeArg = String(args.type ?? 'all')
  const limit = clampInt(args.limit, 1, 50, 20)
  const where: string[] = []
  const binds: unknown[] = []
  if (statusArg === 'approved' || statusArg === 'pending') {
    where.push('c.status = ?')
    binds.push(statusArg)
  }
  if (typeArg === 'post') where.push('c.post_id > 0')
  else if (typeArg === 'weibo') where.push('c.weibo_id > 0')
  else if (typeArg === 'guestbook') where.push('c.post_id = 0 AND c.weibo_id = 0')
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  // 出参只给审核需要的列：email / qq / ip / avatar 不出（qq 是内部记账列，ip 与头像无审核用途）
  const [listRes, countRes] = await Promise.all([
    deps.db
      .prepare(
        `SELECT c.id, c.post_id, c.weibo_id, c.parent_id, c.is_admin, c.member_id, c.nickname, c.website,
                c.content, c.status, c.created_at,
                p.title AS post_title, p.slug AS post_slug, w.content AS weibo_content, pc.nickname AS parent_nickname
         FROM comments c
         LEFT JOIN posts p ON p.id = c.post_id
         LEFT JOIN weibo w ON w.id = c.weibo_id
         LEFT JOIN comments pc ON pc.id = c.parent_id
         ${whereSql} ORDER BY c.created_at DESC LIMIT ?`
      )
      .bind(...binds, limit)
      .all(),
    deps.db.prepare(`SELECT COUNT(*) AS n FROM comments c ${whereSql}`).bind(...binds).first<{ n: number }>(),
  ])
  return ok({ total: countRes?.n ?? 0, items: listRes.results ?? [] })
}

async function runPublishWeibo(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const content = String(args.content ?? '')
    .trim()
    .slice(0, WEIBO_MAX_CHARS)
  const rawImages = Array.isArray(args.images)
    ? args.images.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []
  if (rawImages.length > WEIBO_MAX_IMAGES) return fail(`图片最多 ${WEIBO_MAX_IMAGES} 张`)
  const images = parseWeiboImages(rawImages)
  if (rawImages.length > images.length) {
    return fail('图片地址无效（仅接受站内 /images/… 或 http(s) 外链；MCP 暂不支持传文件）')
  }
  if (!content && !images.length) return fail('文字和图片至少要有一样')
  const status = args.status === 'draft' ? 'draft' : 'published'
  const row = await insertWeibo(deps.db, content, images, status)
  if (row.status === 'published') {
    deps.hooks.weiboPublished({ id: row.id, content: row.content, images, via: 'external' })
  }
  return ok({ id: row.id, status: row.status, images, url: `${deps.siteUrl}/weibo?wb=${row.id}#wb-${row.id}` })
}

/** 工具注册表：tools/list 出 name/title/description/inputSchema，tools/call 按 name 派发 */
export const MCP_TOOLS: ToolDef[] = [
  {
    name: 'publish_post',
    title: '发布文章',
    description:
      '新建一篇博客文章。content 默认按 Markdown 解析（format 可选 html），存库前统一过净化器；' +
      'status 默认 draft（存草稿），确认后再传 published 立即发布。定时发布 / 访问密码 / 会员档位 v1 不支持。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文章标题（必填，≤150 字）' },
        content: { type: 'string', description: '正文（必填，≤1MB）。默认 Markdown' },
        format: { type: 'string', enum: ['markdown', 'html'], description: '正文格式，默认 markdown' },
        status: { type: 'string', enum: ['draft', 'published'], description: '默认 draft 存草稿' },
        slug: { type: 'string', description: '自定义短链（选填；只留字母/数字/中文/_/-），不填由标题自动生成' },
        summary: { type: 'string', description: '自填摘要（选填，≤500 字），不填自动截正文前 80 字' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（选填，≤8 个，每个 ≤20 字）' },
        cover: { type: 'string', description: '封面图（选填，站内 /images/… 或 http(s) 外链）' },
      },
      required: ['title', 'content'],
    },
    run: runPublishPost,
  },
  {
    name: 'list_posts',
    title: '文章列表',
    description: '按状态/关键词分页列出文章（不含正文），返回 id、slug、标题、摘要、标签、时间。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'published', 'draft', 'scheduled'], description: '默认 all' },
        q: { type: 'string', description: '关键词（搜标题/摘要/正文；加密文不参与关键词命中）' },
        page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '每页条数，默认 20' },
      },
    },
    run: runListPosts,
  },
  {
    name: 'get_post',
    title: '读取文章',
    description: '按 id 或 slug 读取单篇文章全文（存库 HTML），供修改前核对内容。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '文章 id（与 slug 二选一）' },
        slug: { type: 'string', description: '文章短链（与 id 二选一）' },
      },
    },
    run: runGetPost,
  },
  {
    name: 'list_comments',
    title: '评论列表',
    description: '按状态/归属列出评论（含文章标题、微博摘要、父评论昵称上下文），默认拉待审（pending）。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'all'], description: '默认 pending（待审优先）' },
        type: { type: 'string', enum: ['all', 'post', 'weibo', 'guestbook'], description: '留言归属，默认 all' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 20' },
      },
    },
    run: runListComments,
  },
  {
    name: 'publish_weibo',
    title: '发布微博',
    description: '发一条随手记微博（≤5000 字，#话题 自动提取）。images 只收站内 / 外链地址（≤9 张），与开放 API 同口径。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '微博文字（≤5000 字；与 images 至少有一样）' },
        images: { type: 'array', items: { type: 'string' }, description: '图片地址数组（站内 /images/… 或 http(s)，≤9 张）' },
        status: { type: 'string', enum: ['published', 'draft'], description: '默认 published 立即发布' },
      },
    },
    run: runPublishWeibo,
  },
]

function toolView(t: ToolDef) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }
}

/* ---------------- JSON-RPC 派发 ---------------- */

function initializeResult(params: unknown) {
  const requested = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
  return {
    // 版本协商：客户端请求的版本在支持清单内就原样回，否则回服务端最新（规范口径）
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      '博客号 BlogHao 站点。publish_post 默认 Markdown 正文、默认存草稿，确认无误后再 status=published；' +
      'list_comments 默认拉待审评论；加密文章内容不参与关键词搜索。',
  }
}

async function callTool(deps: McpDeps, params: unknown): Promise<ToolResult> {
  if (!isObject(params) || typeof params.name !== 'string') {
    throw new RpcProtocolError(RPC_INVALID_PARAMS, '缺少工具名 name')
  }
  const tool = MCP_TOOLS.find((t) => t.name === params.name)
  if (!tool) throw new RpcProtocolError(RPC_INVALID_PARAMS, `未知工具：${params.name}`)
  const args = isObject(params.arguments) ? params.arguments : {}
  return tool.run(deps, args)
}

/** 派发一条 JSON-RPC 消息。请求（有 id）→ 响应对象；通知 → null（HTTP 202） */
export async function dispatchRpc(deps: McpDeps, msg: unknown): Promise<RpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method) {
    // 非法信封：带合法 id 才有得回，否则按通知吞掉
    const id = isObject(msg) && 'id' in msg && (typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null) ? msg.id : null
    return rpcError(id, RPC_INVALID_REQUEST, 'Invalid Request')
  }
  if (msg.method.startsWith('notifications/')) return null
  if (typeof msg.id !== 'string' && typeof msg.id !== 'number' && msg.id !== null) return null // 无 id 按通知处理
  const id = msg.id
  if (msg.method === 'initialize') return rpcResult(id, initializeResult(msg.params))
  if (msg.method === 'ping') return rpcResult(id, {})
  if (msg.method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS.map(toolView) })
  if (msg.method === 'tools/call') {
    try {
      return rpcResult(id, await callTool(deps, msg.params))
    } catch (e) {
      if (e instanceof RpcProtocolError) return rpcError(id, e.code, e.message)
      // 内部错误不透堆栈；按 MCP 工具错误结果回（客户端按 isError 展示）
      return rpcResult(id, { content: [{ type: 'text', text: '工具执行失败，请稍后重试' }], isError: true })
    }
  }
  return rpcError(id, RPC_METHOD_NOT_FOUND, `未知方法：${msg.method}`)
}

/* ---------------- HTTP 路由（薄壳：鉴权 + 限流 + 派发） ---------------- */

export const mcpRoutes = new Hono<{ Bindings: Env }>()

const MCP_TOKEN_ERR = '无效的 API Token，或尚未在后台「设置 → 外部发布」生成'

mcpRoutes.post('/', async (c) => {
  // 演示站关闭：对齐 /api/admin/external/* 口径（演示体验者凭据公示，不给写入面）
  if (isDemo(c.env)) return c.json({ error: '演示站不开放 MCP 接入' }, 404)
  const settings = await getSettings(c.env.DB)
  const expected = settings.externalToken || ''
  const auth = c.req.header('Authorization') || ''
  // 只认 header（同 requireToken 口径）：query 传 token 会进访问/代理日志，造成泄露面
  const token = auth.replace(/^Bearer\s+/i, '').trim() || (c.req.header('X-Auth-Token') || '').trim()
  if (!expected || !token || !safeEqual(token, expected)) {
    // 鉴权失败按 IP 限流（照登录防爆破口径），防 token 猜测
    if (!rateLimit(`mcpfail:${clientIp(c.req.raw)}`, 10, 10 * 60_000)) {
      return c.json({ error: '尝试太频繁，请 10 分钟后再试' }, 429)
    }
    return c.json({ error: MCP_TOKEN_ERR }, 401)
  }
  if (!rateLimit(`mcp:${token.slice(0, 12)}`, 30, 60_000)) {
    return c.json({ error: '请求太频繁，请稍后再试' }, 429)
  }
  const deps: McpDeps = {
    db: c.env.DB,
    siteUrl: siteBase(settings, new URL(c.req.url).origin),
    hooks: {
      postPublished: (p) => c.executionCtx.waitUntil(firePostPublished(c.env, p)),
      weiboPublished: (p) => c.executionCtx.waitUntil(fireWeiboPublished(c.env, p)),
    },
  }
  const payload = await c.req.json().catch(() => undefined)
  if (payload === undefined) {
    return c.json(rpcError(null, RPC_PARSE_ERROR, 'Parse error'), 400)
  }
  // 数组批处理（2025-03-26 规范遗留，个别客户端仍会发）：逐条派发，全通知则 202
  if (Array.isArray(payload)) {
    if (!payload.length) return c.json(rpcError(null, RPC_INVALID_REQUEST, 'Invalid Request'), 400)
    const out: RpcResponse[] = []
    for (const m of payload) {
      const r = await dispatchRpc(deps, m)
      if (r) out.push(r)
    }
    if (!out.length) return c.body(null, 202)
    return c.json(out)
  }
  const r = await dispatchRpc(deps, payload)
  if (!r) return c.body(null, 202) // 通知不回 body（规范：202 Accepted）
  return c.json(r)
})

mcpRoutes.on(['GET', 'DELETE'], '/', (c) => {
  c.header('Allow', 'POST')
  return c.json({ error: 'Method Not Allowed：MCP 端点只接受 POST（无状态模式，不开 SSE 流）' }, 405)
})
