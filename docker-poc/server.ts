/**
 * xwblog 自托管 POC —— 单进程多租户入口（docker-poc/ 独立目录，不影响仓库主代码）。
 *
 * 职责：
 *  1. Node http ↔ fetch(Request/Response) 适配（waitUntil 注入、Set-Cookie 多值、
 *     会话 cookie 的 Secure 按有无 TLS 反代自动摘除）
 *  2. Host → 租户路由：每个域名一套独立的 node:sqlite 库 + 磁盘图床目录，互不可见
 *  3. 静态资源直出 public/（对齐 wrangler assets「文件优先、其余进 Worker」的行为）
 *  4. cron：每分钟扫定时发布；北京时间 00:30（UTC 16:30）触发备份/清理/回收站滚动
 *
 * 业务代码零改动：直接 import src/index.ts 的默认导出（fetch + scheduled）。
 * 运行方式见同目录 README.md / package.json。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import xwblog from '../src/index'
import { ensureSchema } from '../src/db'
import { DEMO_RESET_CRON } from '../src/demo-content'
import { createD1 } from './shims/d1'
import { createR2Disk } from './shims/r2disk'
import { createR2S3, signAuthorization } from './shims/r2s3'
import { controlApp } from './control'
import { resolveScheme } from './scheme'
// D1 的建表靠部署时 `wrangler d1 execute schema.sql`，ensureSchema 只管增量补列——
// 租户库是全新文件，这里要自己先跑一遍 schema.sql（官方幂等设计，可重复执行），
// 与演示站 src/demo.ts 的 ensureTables 同款思路
import SCHEMA_SQL from '../schema.sql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
/**
 * 访客 IP 信任档位（auth.ts clientIp 优先读 CF-Connecting-IP / X-Forwarded-For，这里决定
 * 哪些入站头可信、哪些剥掉后以可靠来源重新注入）：
 *  - 'cf'    部署在 Cloudflare 橙云后：保留 CF-Connecting-IP（CF 边缘强制写入不可伪造），
 *            剥掉 X-Forwarded-For / X-Real-IP（回落值也可伪造）
 *  - 'proxy' 默认。本机自控反代（Caddy / Nginx）：剥掉入站 CF-Connecting-IP / X-Real-IP，
 *            取 X-Forwarded-For 最后一跳作为访客 IP——反代把真实客户端 IP 追加在末尾，
 *            客户端自己伪造的值都在前面，伪造不进来。要求前面确实有一层自控反代
 *  - 'off'   Node 直接暴露公网：剥掉全部可伪造头，以 socket 远端地址注入
 * 兼容旧值：'1' → proxy、'0' → off。客户端可任意伪造 CF-Connecting-IP 轮换 IP 绕过
 * 登录 / 解锁 / 评论 / 点赞限流——档位与真实部署形态不符时代码帮不了你，见 README「访客 IP」
 */
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY ?? 'proxy').toLowerCase()
const TRUST_PROXY: 'cf' | 'proxy' | 'off' =
  TRUST_PROXY_RAW === '1' ? 'proxy' : TRUST_PROXY_RAW === '0' ? 'off' : TRUST_PROXY_RAW === 'cf' || TRUST_PROXY_RAW === 'proxy' || TRUST_PROXY_RAW === 'off' ? (TRUST_PROXY_RAW as 'cf' | 'proxy' | 'off') : 'proxy'
// 默认值按「打包产物在 docker-poc/dist/server.js」的层级推导：dist/../.. = 仓库根、
// dist/.. = docker-poc/；Docker 里保持同样层级，仅 TENANTS_DIR 用环境变量指到挂载卷
const PUBLIC_ROOT = path.resolve(process.env.PUBLIC_ROOT || path.resolve(__dirname, '../../public'))
const TENANTS_DIR = path.resolve(process.env.TENANTS_DIR || path.resolve(__dirname, '../data/tenants'))
const TENANTS_CONFIG = path.resolve(process.env.TENANTS_CONFIG || path.resolve(__dirname, '../tenants.json'))

interface Tenant {
  host: string
  env: Record<string, unknown>
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/

/** 控制面（多租户管理面板）：CONTROL_HOST + CONTROL_PASSWORD 都设置才启用，缺省整体 404 */
export const CONTROL_HOST = (process.env.CONTROL_HOST || '').toLowerCase()
const CONTROL_ENABLED = Boolean(CONTROL_HOST && process.env.CONTROL_PASSWORD)

export interface TenantConfig {
  demo?: boolean
  storage?: string
  /** 停用：路由摘除（一切请求 404），配置与数据保留，可重新启用 */
  disabled?: boolean
}

interface R2SharedConfig {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** 读 tenants.json（带 mtime 缓存 + 解析失败回落上次成功配置）：
 *  每请求都要查停用状态，不能每次 statSync+readFileSync+JSON.parse；
 *  控制面与业务进程共用一份数据，写入路径 writeTenantsConfig 会同步刷新缓存 */
let tenantsCache: { mtimeMs: number; cfg: { r2?: R2SharedConfig; tenants: Record<string, TenantConfig> } } | null = null
function readTenantsConfig(): { r2?: R2SharedConfig; tenants: Record<string, TenantConfig> } {
  try {
    const st = fs.statSync(TENANTS_CONFIG)
    if (tenantsCache && st.mtimeMs === tenantsCache.mtimeMs) return tenantsCache.cfg
    const raw = JSON.parse(fs.readFileSync(TENANTS_CONFIG, 'utf8'))
    const cfg =
      raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tenants
        ? { r2: raw.r2, tenants: raw.tenants }
        : { tenants: raw }
    tenantsCache = { mtimeMs: st.mtimeMs, cfg }
    return cfg
  } catch (e) {
    // 半截 JSON（并发写窗口）/ 瞬时读失败：回落上次成功配置，别让整站 500 突刺
    if (tenantsCache) return tenantsCache.cfg
    throw e
  }
}

/** 原地截断写回 tenants.json：单文件 bind mount 换 inode 会让容器读不到新内容，
 *  必须保持 inode（与 add-tenant.sh 的 cat > 覆盖同一约束）；运行中进程直写，
 *  配置与内存租户表即同步演进，不再依赖重启。写完主动刷新读缓存 */
function writeTenantsConfig(cfg: { r2?: R2SharedConfig; tenants: Record<string, TenantConfig> }): void {
  const body = cfg.r2 ? { r2: cfg.r2, tenants: cfg.tenants } : cfg.tenants
  fs.writeFileSync(TENANTS_CONFIG, JSON.stringify(body, null, 2) + '\n')
  try {
    tenantsCache = { mtimeMs: fs.statSync(TENANTS_CONFIG).mtimeMs, cfg }
  } catch {
    /* stat 失败下次读会自行恢复 */
  }
}

/** 初始化单个租户：blog.db（WAL）+ 图床存储 + schema，启动加载与控制面热开台共用 */
async function createTenantFor(host: string, cfg: TenantConfig, r2Shared?: R2SharedConfig): Promise<Tenant> {
  const dir = path.join(TENANTS_DIR, host)
  fs.mkdirSync(dir, { recursive: true })
  const { images, label } = createTenantImages(host, cfg, r2Shared)
  const env: Record<string, unknown> = {
    DB: createD1(path.join(dir, 'blog.db')),
    IMAGES: images,
    // 业务代码从不调用 ASSETS（静态资源在适配层直出），兜底防误用
    ASSETS: { fetch: async () => new Response('ASSETS binding is handled by the self-host adapter', { status: 404 }) },
  }
  if (cfg.demo) env.DEMO_MODE = '1'
  const db = env.DB as { exec: (sql: string) => Promise<unknown> }
  await db.exec(SCHEMA_SQL)
  await ensureSchema(env.DB as never)
  console.log(`[tenant] ${host} 就绪（存储: ${label}，${cfg?.demo ? '演示种子' : '空库'}）→ ${dir}`)
  return { host, env }
}

/** 按租户配置初始化存储：storage 缺省/"local" = 本地磁盘目录；"r2" = 共享桶 + 域名前缀 */
function createTenantImages(host: string, cfg: { storage?: string }, r2Shared?: R2SharedConfig): { images: unknown; label: string } {
  if (cfg.storage === 'r2') {
    if (!r2Shared) {
      throw new Error(`租户 ${host} 配置了 storage:"r2"，但 tenants.json 缺少顶层 r2 共享配置（accountId/bucket/accessKeyId/secretAccessKey）`)
    }
    return { images: createR2S3({ ...r2Shared, prefix: host }), label: `R2 桶 ${r2Shared.bucket}（前缀 ${host}/）` }
  }
  return { images: createR2Disk(path.join(TENANTS_DIR, host, 'uploads')), label: '本地磁盘' }
}

/** 逐个初始化租户：域名 → 自己的 blog.db（WAL）+ 图床存储，互不可见 */
async function loadTenants(): Promise<Map<string, Tenant>> {
  const { r2: r2Shared, tenants } = readTenantsConfig()
  const map = new Map<string, Tenant>()
  let r2Used = false
  for (const [host, tc] of Object.entries(tenants)) {
    if (!HOST_RE.test(host)) throw new Error(`tenants.json 里的域名不合法: ${host}`)
    const cfg = (tc ?? {}) as TenantConfig
    if (cfg.disabled) continue // 停用租户不建库不进路由，启用时由控制面 createTenantFor 热加载
    if (cfg.storage === 'r2') r2Used = true
    map.set(host, await createTenantFor(host, cfg, r2Shared))
  }
  // R2 自检：同一共享配置只探测一次（空前缀 LIST），凭据/桶名错误在启动时失败，好过首个请求 500
  if (r2Used && r2Shared) {
    const probe = createR2S3({ ...r2Shared, prefix: '__healthcheck__' })
    const r = await probe.list({ limit: 1 })
    console.log(`[r2] 自检通过：桶 ${r2Shared.bucket} 可达`)
    void r
  }
  return map
}

/** 存量迁移：把租户本地盘 uploads/ 逐个搬到 R2（幂等，跳过已存在的 key），用于 local → r2 切换 */
async function migrateLocalToR2(host: string): Promise<void> {
  const { r2: r2Shared } = readTenantsConfig()
  if (!r2Shared) {
    console.error('tenants.json 缺少顶层 r2 配置，无法迁移')
    process.exit(1)
  }
  const localDir = path.join(TENANTS_DIR, host, 'uploads')
  if (!fs.existsSync(localDir)) {
    console.error(`本地图床目录不存在：${localDir}`)
    process.exit(1)
  }
  const local = createR2Disk(localDir)
  const remote = createR2S3({ ...r2Shared, prefix: host })
  const { objects } = await local.list({ limit: 1_000_000 })
  let copied = 0
  let skipped = 0
  for (const o of objects) {
    if (await remote.head(o.key)) {
      skipped++
      continue
    }
    const src = await local.get(o.key)
    if (!src) continue
    await remote.put(o.key, await src.arrayBuffer(), { httpMetadata: src.httpMetadata as { contentType?: string; cacheControl?: string } })
    copied++
    if (copied % 50 === 0) console.log(`  ... 已上传 ${copied} 个`)
  }
  console.log(`[migrate] ${host}：新上传 ${copied} 个对象到 R2（前缀 ${host}/），已存在跳过 ${skipped} 个；本地目录保留作为回退，确认无误后可自行清理`)
}

/** Workers ExecutionContext 的等价物：waitUntil 的异步任务失败只记日志，不炸请求 */
const execCtx = {
  waitUntil(p: Promise<unknown>) {
    Promise.resolve(p).catch((e) => console.error('[waitUntil]', e))
  },
  passThroughOnException() {},
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** 静态资源直出（对齐 wrangler assets：精确文件命中才返回，其余进应用） */
function serveStatic(pathname: string, search: string): Response | null {
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
  // 目录路径不带斜杠：301 补斜杠（对齐 wrangler assets 的 auto-trailing-slash）。
  // 否则 index.html 在 /admin 下被直出，页面里的相对路径资源 ./admin.css 会解析成
  // /admin.css → 404 → 后台整页空白（甲骨文服务器实测抓出）
  if (!decoded.endsWith('/') && st.isDirectory()) {
    return new Response(null, { status: 301, headers: { Location: `${decoded}/${search}` } })
  }
  const candidates = [file, path.join(file, 'index.html')]
  for (const f of candidates) {
    let fst: fs.Stats
    try {
      fst = fs.statSync(f)
    } catch {
      continue
    }
    if (!fst.isFile()) continue
    return new Response(fs.readFileSync(f), {
      headers: {
        'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=120',
      },
    })
  }
  return null
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'content-length',
  'te',
  'trailer',
])

function sendToNode(req: http.IncomingMessage, res: http.ServerResponse, appRes: Response, isHttps: boolean) {
  const headers: Record<string, string | string[]> = {}
  appRes.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value
  })
  // 会话 cookie 带 Secure：明文 http（本地冒烟 / 未挂 TLS）浏览器和 curl 都不会携带。
  // isHttps 由 resolveScheme 统一判定（CF 灵活 SSL 下 X-Forwarded-Proto 是回源段的 http，不可作数）
  const cookies = appRes.headers.getSetCookie()
  if (cookies.length) {
    headers['set-cookie'] = cookies.map((sc) =>
      isHttps ? sc : sc.split('; ').filter((p) => p !== 'Secure').join('; ')
    )
  }
  res.writeHead(appRes.status, headers)
  if (req.method === 'HEAD' || !appRes.body) {
    res.end()
    return
  }
  Readable.fromWeb(appRes.body as never).pipe(res)
}

/**
 * 访客 IP 档位落地（见顶部 TRUST_PROXY 说明）：剥掉不可信头，以可靠来源重新注入
 * CF-Connecting-IP（auth.ts clientIp 优先读它，业务代码零改动）。
 */
function applyTrustProxy(headers: Headers, req: http.IncomingMessage): void {
  if (TRUST_PROXY === 'cf') {
    // Cloudflare 橙云后：CF-Connecting-IP 由边缘强制写入（保留），回落链上的头剥掉
    headers.delete('x-forwarded-for')
    headers.delete('x-real-ip')
    return
  }
  headers.delete('x-real-ip')
  headers.delete('cf-connecting-ip')
  if (TRUST_PROXY === 'proxy') {
    // 本机自控反代：反代把真实客户端 IP 追加在 XFF 末尾，客户端伪造的值都在前面；
    // 无 XFF（直连）回落 socket 远端
    const parts = (headers.get('x-forwarded-for') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ip = parts.length ? parts[parts.length - 1] : (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    headers.delete('x-forwarded-for')
    if (ip) headers.set('cf-connecting-ip', ip)
    return
  }
  // off：Node 直接暴露公网，只有 socket 远端可信
  headers.delete('x-forwarded-for')
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  if (remote) headers.set('cf-connecting-ip', remote)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, tenants: Map<string, Tenant>) {
  const started = Date.now()
  const hostHeader = req.headers.host || 'localhost'
  const host = hostHeader.split(':')[0].toLowerCase()
  const url = new URL(req.url || '/', `http://${hostHeader}`)

  // 组装转发头（hop-by-hop 剥除 + 访客 IP 档位处理），探活之后的每条路共用
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }
  applyTrustProxy(headers, req)
  const proto = resolveScheme(headers, url.host)

  // 0) 反代（Caddy on_demand_tls ask）按需签证书探活：GET /api/health?domain=<域名>，
  // Host 头是探活方自己（127.0.0.1），进不了租户路由；只在域名确已登记时放行 200，
  // 未登记 404 = Caddy 拒签证书（防白嫖这台机的证书资源给任意域名签）。
  // 必须排在控制面分流之前——探活控制面域名本身时会被控制面鉴权 303 截走，
  // Caddy 就永远签不出它的证书
  if (url.pathname === '/api/health' && url.searchParams.has('domain')) {
    const asked = (url.searchParams.get('domain') || '').toLowerCase()
    if (tenants.has(asked) || (CONTROL_ENABLED && asked === CONTROL_HOST)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, time: Date.now() }))
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('unknown domain')
    }
    return
  }

  // 1) 控制面（多租户管理面板）：按 Host 整体分流，独立于一切租户路由与静态服务
  if (CONTROL_ENABLED && host === CONTROL_HOST) {
    await controlApp({
      req,
      res,
      url,
      host,
      scheme: proto,
      tenants,
      readTenantsConfig,
      writeTenantsConfig,
      createTenantFor,
      log: (msg: string) => console.log(`[control] ${msg}`),
    })
    return
  }

  // 2) 静态资源（/admin/ SPA、插件、favicon 等；public/ 里没有的路径自然落空）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const hit = serveStatic(url.pathname, url.search)
    if (hit) {
      res.writeHead(hit.status, Object.fromEntries(hit.headers as never))
      if (req.method === 'HEAD') res.end()
      else res.end(Buffer.from(await hit.arrayBuffer()))
      console.log(`[http] ${req.method} ${host}${url.pathname} ${hit.status} ${Date.now() - started}ms (static)`)
      return
    }
  }

  // 3) 租户路由：未登记域名直接 404，不落到任何租户
  const tenant = tenants.get(host)
  if (!tenant) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`未登记的站点域名：${host}\n请在 docker-poc/tenants.json 里登记后重启。`)
    return
  }
  // 停用租户（配置保留、数据保留、路由摘除）：对外与未登记完全一致
  if ((readTenantsConfig().tenants[host] as TenantConfig | undefined)?.disabled) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`未登记的站点域名：${host}\n请在 docker-poc/tenants.json 里登记后重启。`)
    return
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const appReq = new Request(`${proto}://${hostHeader}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as never) : undefined,
    duplex: 'half',
  } as RequestInit)
  const appRes = await xwblog.fetch(appReq, tenant.env as never, execCtx)
  sendToNode(req, res, appRes, proto === 'https')
  console.log(`[http] ${req.method} ${host}${url.pathname} ${appRes.status} ${Date.now() - started}ms`)
}

let firedBackupDay = ''
let firedDemoResetHour = ''
const CRON_TICK_MS = 60_000

/**
 * cron：与 wrangler triggers.crons 同口径——每分钟扫定时发布；
 * 北京时间 00:30（UTC 16:30）那一分钟换成备份 cron，备份/visit 清理/回收站滚动一起跑；
 * 演示租户的重置 cron（DEMO_RESET_CRON，每 2 小时的第 23 分钟）清库重灌种子数据——
 * wrangler 按 UTC 评估 cron 表达式，这里用 UTC 时钟判断窗口，controller.cron 原样传给
 * src/index.ts 的 scheduled 分发。
 */
function startCron(tenants: Map<string, Tenant>) {
  const timer = setInterval(async () => {
    const now = new Date()
    const backupWindow = now.getUTCHours() === 16 && now.getUTCMinutes() === 30
    const day = now.toISOString().slice(0, 10)
    if (backupWindow) {
      if (firedBackupDay === day) return // 同一天只触发一次，防 tick 漂移双发
      firedBackupDay = day
    }
    // demo 重置窗口：分钟位 23 + 偶数小时（'23 */2 * * *' 的 UTC 语义）；小时粒度记账防双发
    const resetWindow =
      !backupWindow && now.getUTCMinutes() === 23 && now.getUTCHours() % 2 === 0
    const hourKey = now.toISOString().slice(0, 13)
    if (resetWindow) {
      if (firedDemoResetHour === hourKey) return
      firedDemoResetHour = hourKey
    }
    const controller = {
      cron: backupWindow ? '30 16 * * *' : resetWindow ? DEMO_RESET_CRON : '* * * * *',
      scheduledTime: now.getTime(),
    }
    for (const t of tenants.values()) {
      try {
        await xwblog.scheduled(controller as never, t.env as never, execCtx)
      } catch (e) {
        console.error(`[cron:${t.host}]`, e)
      }
    }
  }, CRON_TICK_MS)
  timer.unref()
}

// 维护模式（不启动 HTTP 服务、不加载租户）：
//   node dist/server.js --selftest                  —— SigV4 签名对照 AWS 官方测试向量
//   node dist/server.js --copy-local-to-r2 <域名>   —— 该租户本地盘图片迁移到 R2（幂等）
const arg1 = process.argv[2]
if (arg1 === '--selftest') {
  // 向量取自 AWS S3 文档「Get Bucket (List Objects)」例子（与签名器的
  // SignedHeaders=host;x-amz-content-sha256;x-amz-date 组合一致，且覆盖查询串签名路径）：
  // GET https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J，时间 20130524T000000Z
  const got = signAuthorization(
    'GET',
    'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
    'AKIAIOSFODNN7EXAMPLE',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'us-east-1',
    new Date('2013-05-24T00:00:00Z')
  )
  const want =
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'
  const ok = got === want
  console.log(ok ? '[selftest] SigV4 签名与 AWS 官方测试向量一致 ✓' : `[selftest] 签名不符\n  got:  ${got}\n  want: ${want}`)
  process.exit(ok ? 0 : 1)
}
if (arg1 === '--copy-local-to-r2') {
  await migrateLocalToR2(process.argv[3] || '')
  process.exit(0)
}

const tenants = await loadTenants()

const server = http.createServer((req, res) => {
  handle(req, res, tenants).catch((e) => {
    console.error('[server] unhandled', e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('服务开小差了，请稍后再试。')
  })
})

server.listen(PORT, () => {
  console.log(`\nxwblog 自托管 POC 已启动：http://127.0.0.1:${PORT}`)
  console.log(`  租户：${[...tenants.keys()].join('  ')}（*.localhost 浏览器自动解析到 127.0.0.1）`)
  console.log(`  静态根：${PUBLIC_ROOT}`)
  console.log(`  数据根：${TENANTS_DIR}\n`)
})

startCron(tenants)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
