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

/* 访客 IP 信任档位（与 docker-poc/server.ts 的 TRUST_PROXY 同口径、同默认）：
 *  - 'cf'    hub 前有 Cloudflare 代理：保留 CF-Connecting-IP（CF 边缘强制写入不可伪造），
 *            丢掉客户端自带的 X-Forwarded-For / X-Real-IP
 *  - 'proxy' 默认。hub 在自控反代（Caddy / Nginx）后：剥掉客户端自带的 CF-Connecting-IP /
 *            X-Real-IP，取 X-Forwarded-For 最后一跳作访客 IP（反代把真实客户端 IP 追加在末尾，
 *            客户端伪造值只能排前面），写回 CF-Connecting-IP 供 hub 的 ipOf 读取
 *  - 'off'   Node 直接暴露、无任何反代：只信 socket 远端地址
 * 档位与真实部署不一致 = 可被伪造头重置按 IP 的点赞去重 / 限流桶；默认 'proxy' 对应
 * 官方部署（Caddy 反代）。布尔简写：'1' → proxy、'0' → off。 */
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY ?? 'proxy').toLowerCase()
const TRUST_PROXY: 'cf' | 'proxy' | 'off' =
  TRUST_PROXY_RAW === '1'
    ? 'proxy'
    : TRUST_PROXY_RAW === '0'
      ? 'off'
      : TRUST_PROXY_RAW === 'cf' || TRUST_PROXY_RAW === 'proxy' || TRUST_PROXY_RAW === 'off'
        ? (TRUST_PROXY_RAW as 'cf' | 'proxy' | 'off')
        : 'proxy'

/** 把可信来源的访客 IP 归一写进 cf-connecting-ip（hub 的 ipOf 读它），剥掉客户端可伪造的转发头 */
function applyTrustProxy(headers: Headers, req: http.IncomingMessage): void {
  if (TRUST_PROXY === 'cf') {
    headers.delete('x-forwarded-for')
    headers.delete('x-real-ip')
    return
  }
  headers.delete('x-real-ip')
  headers.delete('cf-connecting-ip')
  if (TRUST_PROXY === 'proxy') {
    const parts = (headers.get('x-forwarded-for') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ip = parts.length ? parts[parts.length - 1] : (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    headers.delete('x-forwarded-for')
    if (ip) headers.set('cf-connecting-ip', ip)
    return
  }
  // off：Node 直接暴露，只认 socket 远端（不认任何转发头）
  headers.delete('x-forwarded-for')
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  if (remote) headers.set('cf-connecting-ip', remote)
}

/* 点赞/曝光的 IP/vid 天级哈希密钥：优先 PLAZA_HASH_SECRET；未设时自动生成一枚并落盘到
 * 数据目录（重启不变），避免退化成「公开日期当盐」的可枚举哈希。落盘失败退进程内随机
 * （仅日志告警）——此时重启会让当天点赞去重清空，属可接受降级。 */
function resolveHashSecret(): string {
  const fromEnv = (process.env.PLAZA_HASH_SECRET || '').trim()
  if (fromEnv) return fromEnv
  const file = path.resolve(path.dirname(DB_FILE), 'hash-secret')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32,}$/.test(existing)) return existing
  } catch {
    /* 不存在：下面生成 */
  }
  const secret = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, secret, { mode: 0o600 })
  } catch (e) {
    console.warn('[hub] 哈希密钥无法落盘，改用进程内随机（重启后当天点赞去重会清空）', e)
  }
  return secret
}

const env = {
  DB: createD1(DB_FILE),
  PLAZA_ADMIN_TOKEN: ADMIN_TOKEN,
  PLAZA_HASH_SECRET: resolveHashSecret(),
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
    // 访客 IP 信任归一：剥掉客户端可伪造的转发头、把可信来源写回 cf-connecting-ip
    applyTrustProxy(headers, req)
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
