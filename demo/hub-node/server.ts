/**
 * 广场 hub 的 Node 运行器（甲骨文服务器演示部署用）。
 * plaza/src/index.ts 是 Workers Worker（fetch + scheduled），这里做两层适配：
 *   1. Node http 与 fetch(Request/Response) 互转——照 docker-poc/server.ts 同款
 *   2. D1 到 node:sqlite——照 docker-poc/shims/d1.ts 同款（hub 的 SQL 面完全被覆盖）
 * RSS pull 补漏 cron 按每分钟 tick，命中 UTC 窗口（17 分 + 每 6 小时）时触发。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import hub from '../../plaza/src/index'
import { createD1 } from './d1'
import SCHEMA_SQL from '../../plaza/schema.sql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8790)
// bundle 在 dist/ 里：静态与库的默认路径按 dist 向上推一层
const PUBLIC_ROOT = path.resolve(process.env.PUBLIC_ROOT || path.resolve(__dirname, '../public'))
const DB_FILE = process.env.HUB_DB || path.resolve(process.env.HUB_DATA || path.resolve(__dirname, '../data'), 'plaza.db')
const ADMIN_TOKEN = process.env.PLAZA_ADMIN_TOKEN || ''

const env = {
  DB: createD1(DB_FILE),
  PLAZA_ADMIN_TOKEN: ADMIN_TOKEN,
}
// schema 幂等（IF NOT EXISTS），启动直接刷一遍；库文件放 data/（部署时挂卷）
await env.DB.exec(SCHEMA_SQL as string)

const execCtx = {
  waitUntil(p: Promise<unknown>) {
    Promise.resolve(p).catch((e) => console.error('[waitUntil]', e))
  },
  passThroughOnException() {},
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** 静态直出（演示广场页）：精确文件命中才返回，其余进 hub 应用。search 只用于 301 回填，不参与文件查找 */
function serveStatic(pathname: string, search = ''): Response | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const file = path.resolve(PUBLIC_ROOT, `.${decoded}`)
  if (file !== PUBLIC_ROOT && !file.startsWith(PUBLIC_ROOT + path.sep)) return null
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (!decoded.endsWith('/') && st.isDirectory()) {
    return new Response(null, { status: 301, headers: { Location: decoded + '/' + search } })
  }
  for (const f of [file, path.join(file, 'index.html')]) {
    try {
      if (!fs.statSync(f).isFile()) continue
    } catch {
      continue
    }
    return new Response(fs.readFileSync(f), {
      headers: {
        'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=120',
      },
    })
  }
  return null
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'content-length', 'te', 'trailer'])

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  try {
    // 演示广场页静态直出（API 路径不进静态，落 hub 应用）；query 不参与文件查找（?v=2 破缓存用）
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.url?.startsWith('/api/')) {
      const q = req.url!.indexOf('?')
      const pathname = q >= 0 ? req.url!.slice(0, q) : req.url!
      const search = q >= 0 ? req.url!.slice(q) : ''
      const hit = serveStatic(pathname, search)
      if (hit) {
        res.writeHead(hit.status, Object.fromEntries(hit.headers as never))
        if (req.method === 'HEAD') res.end()
        else res.end(Buffer.from(await hit.arrayBuffer()))
        return
      }
    }
    const hostHeader = req.headers.host || 'localhost'
    const url = new URL(req.url || '/', `http://${hostHeader}`)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key) || value === undefined) continue
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
      else headers.set(key, value)
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    // URL 固定拼 https：生产由 Caddy 终结 TLS，Origin 校验与绝对地址语义都以访客侧为准
    const appReq = new Request(`https://${hostHeader}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as never) : undefined,
      duplex: 'half',
    } as RequestInit)
    const appRes = await hub.fetch(appReq, env as never, execCtx)
    const outHeaders: Record<string, string | string[]> = {}
    appRes.headers.forEach((value, key) => {
      if (key !== 'set-cookie') outHeaders[key] = value
    })
    res.writeHead(appRes.status, outHeaders)
    if (req.method === 'HEAD' || !appRes.body) {
      res.end()
    } else {
      Readable.fromWeb(appRes.body as never).pipe(res)
    }
    console.log(`[http] ${req.method} ${url.pathname} ${appRes.status} ${Date.now() - started}ms`)
  } catch (e) {
    console.error('[http] error', e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('internal error')
  }
})

// 裸机跑默认只绑环回（前面有反代）；容器里必须 HOST=0.0.0.0，否则 docker-proxy 从容器网卡进不来
server.listen(PORT, process.env.HOST || '127.0.0.1', () =>
  console.log(`[hub] plaza hub listening on ${process.env.HOST || '127.0.0.1'}:${PORT} (db: ${DB_FILE})`)
)

/* ---------------- cron：RSS pull 补漏 + 无心跳站点休眠（17 分 + 每 6 小时，对齐 wrangler 节奏） ---------------- */

let firedKey = ''
const timer = setInterval(async () => {
  const now = new Date()
  // wrangler 按 UTC 评估：第 17 分钟 + 每 6 小时（0/6/12/18 点那一小时）
  if (now.getUTCMinutes() !== 17 || now.getUTCHours() % 6 !== 0) return
  const key = now.toISOString().slice(0, 13)
  if (firedKey === key) return
  firedKey = key
  const mod = (hub as { scheduled?: unknown }).scheduled
  if (typeof mod === 'function') {
    console.log('[cron] pull 开始')
    try {
      const r = await (mod as (e: unknown, env: unknown, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<unknown>)(null, env, execCtx)
      console.log('[cron] pull 完成', JSON.stringify(r))
    } catch (e) {
      console.error('[cron] pull 失败', e)
    }
  }
}, 60_000)
timer.unref()
