/**
 * xwblog 自托管控制面（多租户管理面板）——docker-poc 独立模块，不碰仓库主代码。
 *
 * 职责：在 CONTROL_HOST 域名下提供网页化的租户运维：开通（含 DNS 自动记录）、
 * 停用/启用、彻底删除、重置站点管理员密码、操作日志、系统概览。
 *
 * 安全模型（自托管单管理员场景，刻意从简）：
 *  - 主密码走 CONTROL_PASSWORD 环境变量，常时比较；登录限流复用 src/auth.ts rateLimit
 *  - 会话 = 进程内随机 token + HttpOnly Cookie，重启即全失效；Cookie 不设 Domain，
 *    仅 CONTROL_HOST 下生效，Secure 按请求 scheme（server.ts resolveScheme 判定，http 链路不带）
 *  - 所有写操作 POST + 同源 Origin 校验（与 api.ts 同一口径），纯表单无 JS 无内联事件
 *  - 未设 CONTROL_HOST / CONTROL_PASSWORD 时整个控制面不存在（server.ts 不会分流进来）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { randomToken, hashPassword, safeEqual, rateLimit } from '../src/auth'

const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || ''
/** 登录账户名（默认 admin）：带用户名的登录表单方便浏览器密码管理器记住整套凭据 */
const CONTROL_USERNAME = (process.env.CONTROL_USERNAME || 'admin').toLowerCase()
const SESSION_TTL_MS = 12 * 60 * 60_000 // 12 小时
const SESSION_COOKIE = 'xw_control_session'

/** DNS 自动化（可选）：容器注入 CF_API_TOKEN + CF_ZONE_ID 后，开站自动建记录（橙云） */
const CF_API_TOKEN = process.env.CF_API_TOKEN || ''
const CF_ZONE_ID = process.env.CF_ZONE_ID || ''

/**
 * 官网同步（可选）：把官方仓库 website/public/ 的静态官网纳入控制面托管——
 * 容器挂载宿主机站点目录（SITE_DIR，如 /var/www/bloghao:/site）后，
 * 「同步」= 拉 GitHub tarball → tar 解压 → 校验 → 替换站点目录，成功/失败经 flash 返回。
 * 未设 SITE_DIR 时功能整体不存在（卡片不渲染、端点 404），无官网部署的形态不受影响
 */
const SITE_DIR = (process.env.SITE_DIR || '').replace(/\/+$/, '')
const GH_REPO = process.env.SITE_REPO || 'bloghao/bloghao'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''

/**
 * 广场 hub 统计（可选）：PLAZA_HUB_URL + PLAZA_ADMIN_TOKEN 都配置后，
 * 仪表盘显示「广场 hub」卡片（接入站点 / 内容量 / feed≈广场页访问 / ingest 上报）。
 * 两个 env 缺任一即卡片整体不存在；hub 是独立 Worker（协议见 docs/PLAZA.md）
 */
const PLAZA_HUB_URL = (process.env.PLAZA_HUB_URL || '').trim().replace(/\/+$/, '')
const PLAZA_ADMIN_TOKEN = process.env.PLAZA_ADMIN_TOKEN || ''

// 与 server.ts 的 HOST_RE 同口径（bundle 后共享同一份；源码各自声明防循环导入）
const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/

// 域名形态守卫（与 /create 同一正则）：host 会拼进 tenants/<host>/ 路径，
// 不设防的 ../ 会打出 tenants 目录之外（reset / tenant 详情 / 删除都靠它把门）
const HOST_SHAPE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** 浏览器侧真实 scheme（server.ts resolveScheme 的结果经 deps 传入）拼站点地址用 */
function schemeOf(deps: ControlDeps): string {
  return deps.scheme === 'https' ? 'https' : 'http'
}

interface PlazaStats {
  sites?: { total?: number; active?: number; verified?: number }
  items?: { total?: number; posts?: number; weibo?: number; last24h?: number }
  today?: { day?: string; feed?: number; sites?: number; ingest?: number; items?: number }
  total?: { feed?: number; sites?: number; ingest?: number; items?: number }
}

/** 拉 hub 全局统计（管理端点）：失败返回 null，卡片降级显示不可达，绝不拖垮仪表盘 */
async function fetchPlazaStats(): Promise<PlazaStats | null> {
  try {
    const res = await fetch(`${PLAZA_HUB_URL}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${PLAZA_ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return null
    return (await res.json()) as PlazaStats
  } catch {
    return null
  }
}

/* ---------------- 分站广场自动收录（可选：PLAZA_HUB_URL + PLAZA_ADMIN_TOKEN 都配置后生效） ----------------
 * 开站/启用即把分站注册进广场 hub（走 hub 管理端点，与人工审核同一入口，只是由面板代劳——
 * 没有 token 配置就整体不生效，第三方自托管站想进官方广场仍走 docs/PLAZA.md 的人工流程）。
 * 注册返回的站点 token 写进租户库 settings.plazaToken：plaza-sync 服务端插件默认开启，
 * 有 token 即自动 push（发布实时进广场、删除/锁文自动下架），hub 的 6 小时 pull 仍是兜底路。
 * 演示租户（种子假数据）与停用租户一律不收录——广场只收真实公开内容，宁缺毋假。
 * 全部失败都只进 flash 提示，绝不阻塞开站/停用/删除主流程。 */

type PlazaEnsureResult = { ok: 'added' | 'known' | 'skip'; note?: string } | { ok: 'error'; note: string }

/** hub 管理 API：8s 超时，data 解析失败为 null；网络异常 status=0（调用方按不可达处理） */
async function plazaApi(method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`${PLAZA_HUB_URL}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${PLAZA_ADMIN_TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(8_000),
    })
    let data: Record<string, unknown> | null = null
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      /* 非 JSON 响应按 null */
    }
    return { status: res.status, data }
  } catch {
    return { status: 0, data: null }
  }
}

/** 租户站点标题（广场展示名）：只读开库取 siteTitle，拿不到回落域名 */
async function plazaSiteName(host: string): Promise<string> {
  const file = path.join(tenantDir(host), 'blog.db')
  if (!fs.existsSync(file)) return host
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'siteTitle'").get() as { value?: unknown } | undefined
      return String(row?.value || '').trim() || host
    } finally {
      db.close()
    }
  } catch {
    return host
  }
}

/** 站点 token 写进租户库（仅在尚未配置时写，不覆盖站长自己填的）。经租户活连接写，
 *  业务侧下一读即见；写不进只损失 push 路（实时性/下架同步），pull 路不受影响 */
async function plazaSaveToken(deps: ControlDeps, host: string, token: string): Promise<boolean> {
  const db = deps.tenants.get(host)?.env?.DB as
    | { prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown> } } }
    | undefined
  if (!db) return false
  try {
    await db
      .prepare(
        // 条件写：key 已在且值非空则不动（ON CONFLICT … WHERE），按钮连点也安全
        "INSERT INTO settings (key, value) VALUES ('plazaToken', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ''",
      )
      .bind(token)
      .run()
    return true
  } catch {
    return false
  }
}

/** 确保单个租户已收录进广场：注册（409 = 已在广场）+ token 落库 */
async function plazaEnsureSite(deps: ControlDeps, host: string, cfg: TenantConfig): Promise<PlazaEnsureResult> {
  if (!PLAZA_HUB_URL || !PLAZA_ADMIN_TOKEN) return { ok: 'skip' }
  if (cfg.demo || cfg.disabled) return { ok: 'skip' }
  const { status, data } = await plazaApi('POST', '/api/admin/sites', {
    url: `https://${host}`,
    name: (await plazaSiteName(host)).slice(0, 100),
  })
  if (status === 409) return { ok: 'known' }
  if (status === 0) return { ok: 'error', note: '广场 hub 暂不可达，稍后可在仪表盘点「分站收录进广场」重试' }
  if (status !== 200) {
    const msg = data && typeof data.error === 'string' ? data.error : `HTTP ${status}`
    return { ok: 'error', note: `广场收录失败：${msg}` }
  }
  const token = typeof data?.token === 'string' ? data.token : ''
  if (token && (await plazaSaveToken(deps, host, token))) {
    opsLog('广场收录', `${host}（已注册，token 已写入站点设置）`)
    return { ok: 'added', note: '已自动收录进广场：新内容实时推送，删除/锁文自动下架' }
  }
  opsLog('广场收录', `${host}（已注册，token 未落库——hub 补漏路仍生效）`)
  return { ok: 'added', note: '已收录进广场（hub 定时补漏生效；站点 token 未能写入，push 路未启用）' }
}

/** 按站点地址找 hub 站点 id（停用/删除同步用）：hub 没有按 url 查的端点，走列表（≤500 站）比对 */
async function plazaFindSiteId(url: string): Promise<number | null> {
  const { status, data } = await plazaApi('GET', '/api/admin/sites')
  if (status !== 200 || !Array.isArray(data?.sites)) return null
  for (const s of data.sites as Array<Record<string, unknown>>) {
    if (String(s.url || '').replace(/\/+$/, '') === url) return Number(s.id) || null
  }
  return null
}

/** 广场收录同步（仪表盘按钮）：非演示、非停用租户逐个对齐进 hub，最后触发一次立即补漏，
 *  让新收录站点的近 30 天内容马上进广场（不等 6 小时 cron）。返回 flash 一句话 */
async function plazaSyncAll(deps: ControlDeps): Promise<string> {
  if (!PLAZA_HUB_URL || !PLAZA_ADMIN_TOKEN) return '✗ 未配置 PLAZA_HUB_URL / PLAZA_ADMIN_TOKEN，广场收录不可用'
  let added = 0
  let known = 0
  const errors: string[] = []
  for (const [host, cfg] of Object.entries(deps.readTenantsConfig().tenants)) {
    const r = await plazaEnsureSite(deps, host, cfg)
    if (r.ok === 'added') added++
    else if (r.ok === 'known') known++
    else if (r.ok === 'error') errors.push(`${host}：${r.note}`)
  }
  opsLog('广场收录', `全量对齐：新收 ${added}、已在 ${known}、失败 ${errors.length}`)
  const head = added === 0 && known > 0 ? '全部分站均已在广场' : `新收录 ${added} 站`
  if (errors.length) return `✗ 广场收录同步（新收 ${added}、已在 ${known}）有失败项：${errors.join('；')}`
  const pull = await plazaApi('POST', '/api/admin/pull')
  const pulled = pull.status === 200 ? Number(pull.data?.pulled) || 0 : -1
  return pulled >= 0 ? `✓ ${head}，补漏已触发（本轮拉取 ${pulled} 条进广场）` : `✓ ${head}，但补漏触发失败（6 小时内 cron 会自动补）`
}

interface Tenant {
  host: string
  env: Record<string, unknown>
}

interface TenantConfig {
  demo?: boolean
  storage?: string
  disabled?: boolean
}

interface ControlDeps {
  req: import('node:http').IncomingMessage
  res: import('node:http').ServerResponse
  url: URL
  host: string
  /** 浏览器侧真实 scheme（server.ts resolveScheme 判定）：https 时会话 Cookie 带 Secure */
  scheme: string
  tenants: Map<string, Tenant>
  readTenantsConfig(): { r2?: Record<string, string>; tenants: Record<string, TenantConfig> }
  writeTenantsConfig(cfg: { r2?: Record<string, string>; tenants: Record<string, TenantConfig> }): void
  createTenantFor(host: string, cfg: TenantConfig, r2Shared?: Record<string, string>): Promise<Tenant>
  log(msg: string): void
}

// ── 会话 ─────────────────────────────────────────────────────────────────
const sessions = new Map<string, number>() // token → 过期时刻

/** 一次性操作提示（PRG）：POST 处理完 303 回仪表盘，flash 短命 Cookie 送达后即清——
 *  刷新页面永远是干净的 GET，浏览器不再弹「确认重新提交表单」 */
const FLASH_COOKIE = 'xw_control_flash'

function flashRedirect(res: import('node:http').ServerResponse, flash: string): void {
  res.writeHead(303, {
    'Set-Cookie': `${FLASH_COOKIE}=${encodeURIComponent(flash)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=120`,
    Location: '/',
  })
  res.end()
}

/** 读走 flash cookie（返回清障 Set-Cookie，调用方必须带在响应上才算消费掉） */
function takeFlash(req: import('node:http').IncomingMessage): { flash: string; clear: string } | null {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${FLASH_COOKIE}=([^;]*)`))
  if (!m) return null
  let flash = m[1]
  try {
    flash = decodeURIComponent(m[1])
  } catch {
    /* 编码残缺按原文展示，清掉即可 */
  }
  return { flash, clear: `${FLASH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` }
}

function sessionOk(req: import('node:http').IncomingMessage): boolean {
  const cookie = req.headers.cookie || ''
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9]+)`))
  if (!m) return false
  const exp = sessions.get(m[1])
  if (!exp || exp < Date.now()) {
    sessions.delete(m[1])
    return false
  }
  return true
}

function issueSession(): string {
  const token = randomToken(24)
  sessions.set(token, Date.now() + SESSION_TTL_MS)
  // 容量护栏：会话桶异常膨胀（正常单管理员到不了）时丢最旧的
  if (sessions.size > 100) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) sessions.delete(oldest[0])
  }
  return token
}

// ── 操作日志（JSONL，append-only）─────────────────────────────────────────
const OPS_LOG = process.env.OPS_LOG_PATH || path.join(process.env.TENANTS_DIR || 'data/tenants', '..', 'ops.log')

function opsLog(action: string, detail: string): void {
  try {
    fs.appendFileSync(OPS_LOG, JSON.stringify({ ts: new Date().toISOString(), action, detail }) + '\n')
  } catch {
    /* 日志失败不阻塞主流程 */
  }
}

function readOpsLog(limit = 20): { ts: string; action: string; detail: string }[] {
  try {
    return fs
      .readFileSync(OPS_LOG, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l))
      .reverse()
  } catch {
    return []
  }
}

// ── DNS 自动化（Cloudflare）──────────────────────────────────────────────
async function cfApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; errors: string; data?: { id?: string } }> {
  if (!CF_API_TOKEN || !CF_ZONE_ID) return { ok: false, errors: '未配置 CF_API_TOKEN / CF_ZONE_ID' }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}${path}`, {
      method,
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = (await res.json()) as { success: boolean; errors?: { message: string }[]; result?: { id?: string } }
    return { ok: json.success === true, errors: (json.errors || []).map((e) => e.message).join('; '), data: json.result }
  } catch (e) {
    return { ok: false, errors: String(e) }
  }
}

async function dnsCreate(host: string, serverIp: string): Promise<string> {
  const r = await cfApi('POST', '/dns_records', { type: 'A', name: host, content: serverIp, proxied: true })
  return r.ok ? '' : `DNS 创建失败：${r.errors}`
}

async function dnsDelete(host: string): Promise<string> {
  // 先查后删；记录不存在视作成功（幂等）
  const list = await cfApi('GET', `/dns_records?name=${encodeURIComponent(host)}&per_page=5`)
  if (!list.ok) return `DNS 查询失败：${list.errors}`
  const records = (list.data as unknown as { id: string }[]) || []
  for (const rec of Array.isArray(records) ? records : []) {
    await cfApi('DELETE', `/dns_records/${rec.id}`)
  }
  return ''
}

function cfEnabled(): boolean {
  return Boolean(CF_API_TOKEN && CF_ZONE_ID)
}

// ── 官网同步（GitHub tarball → 站点目录）─────────────────────────────────
interface SiteMeta {
  sha: string
  subject: string
  syncedAt: string
}

function readSiteMeta(): SiteMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SITE_DIR, '.deploy-meta.json'), 'utf8')) as SiteMeta
  } catch {
    return null
  }
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'xwblog-control-plane', Accept: 'application/vnd.github+json' }
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`
  return h
}

function execFile(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()))
  })
}

let syncBusy = false

/**
 * 同步官网到 SITE_DIR。安全边界：目标仓库与 URL 全部来自常量/返回值校验（无用户输入），
 * SHA 形态白名单校验后才拼进 tarball 地址；tar 参数固定无注入面。
 * 流程：commits/main 拿 sha → 与已部署 meta 比对（相同免拉）→ 下载 tarball →
 * tar 解压到 /tmp → 校验 index.html → 清空站点目录（保留 meta）→ 复制新内容 → 写回 meta。
 * 「清空→复制」之间是唯一非原子窗口（静态文件 1.4MB 级，毫秒计），期间失败重试即可恢复；
 * 解压与校验全部通过后才动站点目录，旧站要么完整要么新站完整。
 */
async function websiteSync(): Promise<string> {
  const api = `https://api.github.com/repos/${GH_REPO}`
  let sha = ''
  let subject = ''
  try {
    const res = await fetch(`${api}/commits/main`, { headers: ghHeaders(), signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return `✗ 查询 GitHub 最新提交失败：HTTP ${res.status}`
    const j = (await res.json()) as { sha?: string; commit?: { message?: string } }
    sha = j.sha || ''
    subject = (j.commit?.message || '').split('\n')[0] || ''
  } catch (e) {
    return `✗ 连不上 GitHub：${String(e).slice(0, 120)}`
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return '✗ GitHub 返回的提交 SHA 形态异常'
  const cur = readSiteMeta()
  if (cur?.sha === sha) return `✓ 官网已是最新（${cur.sha.slice(0, 7)}），无需同步`

  const stamp = Date.now()
  const tgz = `/tmp/site-${stamp}.tgz`
  const staging = `/tmp/site-src-${stamp}`
  try {
    const res = await fetch(`${api}/tarball/${sha}`, { headers: ghHeaders(), signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return `✗ 下载源码包失败：HTTP ${res.status}`
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))

    fs.mkdirSync(staging, { recursive: true })
    await execFile('tar', ['-xzf', tgz, '-C', staging], 60_000)
    const roots = fs.readdirSync(staging)
    const publicDir = roots.length ? path.join(staging, roots[0], 'website', 'public') : ''
    if (!publicDir || !fs.existsSync(path.join(publicDir, 'index.html'))) {
      return '✗ 源码包里找不到 website/public/index.html（仓库结构变了？）'
    }

    for (const entry of fs.readdirSync(SITE_DIR)) {
      if (entry === '.deploy-meta.json') continue
      fs.rmSync(path.join(SITE_DIR, entry), { recursive: true, force: true })
    }
    fs.cpSync(publicDir, SITE_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(SITE_DIR, '.deploy-meta.json'),
      JSON.stringify({ sha, subject, syncedAt: new Date().toISOString() } satisfies SiteMeta, null, 2) + '\n',
    )
    opsLog('官网同步', `${sha.slice(0, 7)} ${subject.slice(0, 60)}`)
    // '✓!' 前缀 = flash 含可信 HTML（page() 对它跳过 esc），sha/subject 已按需处理
    return `✓!✓ 官网已同步到 <code>${sha.slice(0, 7)}</code> · ${esc(subject.slice(0, 40)) || '（无提交标题）'}`
  } catch (e) {
    return `✗ 同步失败：${String(e).slice(0, 160)}`
  } finally {
    fs.rmSync(tgz, { force: true })
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

// ── 租户详情 ─────────────────────────────────────────────────────────────
function dirSize(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch {
          /* 并发删除时竞态，忽略 */
        }
      }
    }
  }
  walk(dir)
  return total
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function tenantDir(host: string): string {
  return path.join(process.env.TENANTS_DIR || 'data/tenants', host)
}

/** 北京时间日期 / 时刻（与主程序 utils.ts fmtDate/fmtDateTime 同口径：+8h 后取 UTC 分量） */
function bjDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts + 8 * 3600_000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function bjDateTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts + 8 * 3600_000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${bjDate(ts)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 距今的口语化时长：判断「博主有没有认真更新」用 */
function ago(ts: number): string {
  if (!ts) return '从未'
  const days = Math.floor((Date.now() - ts) / 86400_000)
  if (days <= 0) return '今天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

// ── 分站数据统计（只读直查租户 blog.db，供仪表盘「数据」列与分站详情页）─────
// 面板与租户业务进程同机同用户：node:sqlite 只读连接旁路 D1 shim（与 resetAdminPassword
// 同路数），单租户一次连接全量取完；查询逐条兜底——坏库 / 空库只显示「读不到」，不拖垮面板

interface TenantStats {
  posts: number
  drafts: number
  scheduled: number
  weibo: number
  comments: number
  commentsPending: number
  members: number
  visits30d: number
  media: number
  mediaBytes: number
  /** 最近公开发布（文章/微博取最大，含软删过滤与 status='published' 口径） */
  lastContentAt: number
  admin: { username: string; createdAt: number } | null
  siteTitle: string
  /** 收录守卫：整站 noindex / 闭站开着时，搜索引擎与 AI 都抓不到该域名（演示站刻意如此，正常） */
  noindex: boolean
  closed: boolean
}

async function tenantStats(host: string): Promise<TenantStats | null> {
  const file = path.join(tenantDir(host), 'blog.db')
  if (!fs.existsSync(file)) return null
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
  try {
    const one = (sql: string, ...params: (string | number)[]): number => {
      try {
        const r = db.prepare(sql).get(...params) as { n?: unknown } | undefined
        return Number(r?.n) || 0
      } catch {
        return 0
      }
    }
    const lastExpr = 'MAX(COALESCE(published_at, created_at))'
    const last = db
      .prepare(
        `SELECT MAX(t) AS n FROM (
           SELECT ${lastExpr} AS t FROM posts WHERE deleted_at IS NULL AND status = 'published'
           UNION ALL
           SELECT ${lastExpr} AS t FROM weibo WHERE deleted_at IS NULL AND status = 'published'
         )`,
      )
      .get() as { n?: unknown } | undefined
    const admin = db.prepare('SELECT username, created_at FROM users ORDER BY id LIMIT 1').get() as
      | { username: string; created_at: number }
      | undefined
    const siteTitle = db.prepare("SELECT value FROM settings WHERE key = 'siteTitle'").get() as { value?: unknown } | undefined
    // 收录守卫（与 /admin/stats 的 crawl 同口径）：settings 表还没长出来 / 键缺失一律当「可抓取」，
    // 不给新站误报红字
    const setting = (key: string): string => {
      try {
        const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: unknown } | undefined
        return r?.value == null ? '' : String(r.value)
      } catch {
        return ''
      }
    }
    return {
      posts: one(`SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL AND status = 'published'`),
      drafts: one(`SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL AND status = 'draft'`),
      scheduled: one(`SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL AND status = 'scheduled'`),
      weibo: one(`SELECT COUNT(*) AS n FROM weibo WHERE deleted_at IS NULL AND status = 'published'`),
      comments: one(`SELECT COUNT(*) AS n FROM comments WHERE status = 'approved'`),
      commentsPending: one(`SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'`),
      members: one('SELECT COUNT(*) AS n FROM members'),
      visits30d: one('SELECT COUNT(*) AS n FROM visit_log WHERE ts > ?', Date.now() - 30 * 86400_000),
      media: one('SELECT COUNT(*) AS n FROM uploads'),
      mediaBytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM uploads'),
      lastContentAt: Number(last?.n) || 0,
      admin: admin ? { username: String(admin.username), createdAt: Number(admin.created_at) || 0 } : null,
      siteTitle: String(siteTitle?.value || ''),
      noindex: setting('siteNoindex') === '1',
      closed: setting('siteClosed') === '1',
    }
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* 已断开不阻塞 */
    }
  }
}

/** 仪表盘「数据」列：一句话看懂该博主有没有在用（软删与草稿不夸大口径） */
function statsCellHtml(st: TenantStats | null, isDemo = false): string {
  if (!st) return '<td class="tenant-meta">暂无数据<br><span class="muted">库尚未生成</span></td>'
  const bits = [
    `${st.posts} 文`,
    st.drafts ? `${st.drafts} 草稿` : '',
    st.scheduled ? `${st.scheduled} 定时` : '',
    `${st.weibo} 微博`,
    `${st.visits30d} 近30日PV`,
  ].filter(Boolean)
  const never = st.posts + st.weibo === 0
  return `<td class="tenant-meta">${esc(bits.join(' · '))}<br>最近更新 ${esc(never ? '未发布过' : ago(st.lastContentAt))}${
    st.commentsPending ? `<br><span style="color:var(--accent-dark)">${st.commentsPending} 条评论待审</span>` : ''
  }<br>${crawlNoteHtml(st, isDemo)}</td>`
}

/** 收录守卫（2026-10-17）：整站 noindex / 闭站会把这个域名整体切出搜索引擎与 AI 的视野。
 *  面板上直出，等于每开一个二级域名都能一眼看到「它到底能不能被抓到」——
 *  站长口径：整个生态（bloghao.com 的每个二级域名）都要能被 AI 与搜索引擎抓到。
 *  演示站刻意不进索引属于正常设计，不报红。 */
function crawlNoteHtml(st: TenantStats, isDemo = false): string {
  if (isDemo) return '<span class="muted">演示站 · 刻意不进索引</span>'
  if (st.closed) return '<span style="color:#c0392b">⛔ 已闭站 · 抓不到</span>'
  if (st.noindex) return '<span style="color:#c0392b">⛔ 不收录 · 抓不到</span>'
  return '<span class="muted">✓ 可被抓取</span>'
}

/** 分站详情页的收录一句话版（多带一句「去哪关」的指路） */
function crawlDetailHtml(st: TenantStats, isDemo: boolean): string {
  if (isDemo) return '<span class="muted">演示站 · 刻意不进索引（每 2 小时清库重灌，进索引只会变垃圾，属正常）</span>'
  if (st.closed) return '<span style="color:#c0392b">⛔ 已闭站</span> —— 访客只能看到闭站页，搜索引擎与 AI 都抓不到；去该站后台「设置 → 站点 → 关闭站点」恢复'
  if (st.noindex) return '<span style="color:#c0392b">⛔ 全站 noindex 开着</span> —— 该域名已退出搜索引擎与 AI 索引；去该站后台「设置 → 站点 → 禁止搜索引擎收录」关掉'
  return '✓ 可被搜索引擎与 AI 抓取（robots.txt / sitemap.xml 自动生成，无需配置）'
}

/** 分站详情页正文：完整数据 + 最近内容 + 前台/后台入口 */
async function tenantDetailBody(host: string, cfg: TenantConfig, live: boolean, scheme: string): Promise<string> {
  const st = await tenantStats(host)
  const siteUrl = `${scheme}://${host}/`
  const adminUrl = `${siteUrl}admin/`
  const mode = cfg.demo ? '演示种子站' : '正式站'
  const storage = cfg.storage === 'r2' ? 'R2 存储' : '本地盘存储'
  const meta = tenantMeta(host, cfg, live)

  let recentPostsRows = ''
  let recentWeiboRows = ''
  let recentErr = ''
  if (st) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path.join(tenantDir(host), 'blog.db'), { readOnly: true })
      try {
        const posts = db
          .prepare(
            `SELECT title, slug, status, views, COALESCE(published_at, created_at) AS t
             FROM posts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8`,
          )
          .all() as { title: unknown; slug: unknown; status: unknown; views: unknown; t: unknown }[]
        recentPostsRows = posts
          .map((p) => {
            const status = String(p.status)
            const label = status === 'published' ? '已发布' : status === 'scheduled' ? '定时' : '草稿'
            const title =
              status === 'published'
                ? `<a href="${esc(siteUrl)}post/${encodeURIComponent(String(p.slug))}" target="_blank" rel="noopener">${esc(String(p.title))}</a>`
                : esc(String(p.title))
            return `<tr><td>${title}</td><td class="tenant-meta">${label}</td><td class="mono hide-sm">${esc(bjDateTime(Number(p.t)))}</td><td class="mono">${Number(p.views) || 0}</td></tr>`
          })
          .join('')
        const weibo = db
          .prepare(
            `SELECT content, status, COALESCE(published_at, created_at) AS t
             FROM weibo WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5`,
          )
          .all() as { content: unknown; status: unknown; t: unknown }[]
        recentWeiboRows = weibo
          .map((w) => {
            const text = String(w.content || '')
            const label = String(w.status) === 'draft' ? ' <span class="muted">（草稿）</span>' : ''
            return `<tr><td>${esc(text.slice(0, 80))}${text.length > 80 ? '…' : ''}${label}</td><td class="mono hide-sm" style="white-space:nowrap">${esc(bjDateTime(Number(w.t)))}</td></tr>`
          })
          .join('')
      } finally {
        try {
          db.close()
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      recentErr = '最近内容读取失败（库可能正忙），稍后刷新重试。'
    }
  }

  return `
<div class="page-head">
  <h1>${esc(st?.siteTitle || host)} <span class="muted" style="font-size:14px">· ${esc(host)}</span></h1>
  <p class="sub">${mode} · ${storage} · ${live ? '运行中' : cfg.disabled ? '已停用' : '未加载'} · ${esc(meta)}</p>
  <p style="margin-top:12px"><a class="btn btn-primary" href="${esc(siteUrl)}" target="_blank" rel="noopener">打开前台 ↗</a>
  <a class="btn" href="${esc(adminUrl)}" target="_blank" rel="noopener">打开后台管理 ↗</a></p>
</div>

${
  !st
    ? '<div class="card fade fade-1"><p class="tenant-meta">该站点还没有数据库（开通后从未被访问过），首次访问即自动生成。</p></div>'
    : `
<div class="stat-strip fade fade-1">
  <div class="stat accent"><b>${st.posts}<span style="font-size:13px;font-weight:600;color:var(--sub)"> 篇</span></b><span>已发布文章${st.drafts || st.scheduled ? `（另有 ${[st.drafts ? `${st.drafts} 草稿` : '', st.scheduled ? `${st.scheduled} 定时` : ''].filter(Boolean).join('、')}）` : ''}</span></div>
  <div class="stat"><b>${st.weibo}</b><span>微博</span></div>
  <div class="stat"><b>${st.comments}</b><span>评论${st.commentsPending ? `（待审 ${st.commentsPending}）` : ''}</span></div>
  <div class="stat"><b>${st.visits30d}</b><span>近 30 日访问（PV）</span></div>
  <div class="stat"><b>${st.members}</b><span>注册会员</span></div>
  <div class="stat"><b>${esc(fmtBytes(st.mediaBytes))}</b><span>媒体文件 ${st.media} 个</span></div>
</div>

<div class="card fade fade-1">
  <h2>活跃度速览</h2>
  <p class="tenant-meta">最近发布：${
    st.posts + st.weibo
      ? `<b>${esc(ago(st.lastContentAt))}</b>（${esc(bjDateTime(st.lastContentAt))}）`
      : '还没有公开发布过内容'
  }；管理员账号 ${st.admin ? `<code>${esc(st.admin.username)}</code>（${esc(bjDate(st.admin.createdAt))} 创建）` : '<b>尚未创建</b>（博主首次进后台会引导设置）'}。</p>
  <p class="tenant-meta">收录状态：${crawlDetailHtml(st, !!cfg.demo)}</p>
</div>

<div class="card card-flat fade fade-2">
  <h2>最近文章 <span class="muted">· 按更新时间，最多 8 篇</span></h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>标题</th><th>状态</th><th class="hide-sm">时间</th><th>PV</th></tr></thead>
    <tbody>${recentPostsRows || '<tr><td colspan="4" class="empty">还没有文章。</td></tr>'}</tbody>
  </table>
  </div>
</div>

<div class="card card-flat fade fade-2">
  <h2>最近微博 <span class="muted">· 最多 5 条</span></h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>内容</th><th class="hide-sm">时间</th></tr></thead>
    <tbody>${recentWeiboRows || '<tr><td colspan="2" class="empty">还没有微博。</td></tr>'}</tbody>
  </table>
  </div>
</div>`
}
${recentErr ? `<div class="card"><p class="tenant-meta">${esc(recentErr)}</p></div>` : ''}
<p><a class="btn" href="/">← 返回控制台</a></p>`
}

function tenantMeta(host: string, cfg: TenantConfig, live: boolean): string {
  const size = fmtBytes(dirSize(tenantDir(host)))
  const mode = cfg.demo ? '演示种子' : '真实站'
  const storage = cfg.storage === 'r2' ? 'R2' : '本地盘'
  const created = (() => {
    try {
      return new Date(fs.statSync(tenantDir(host)).birthtime).toISOString().slice(0, 10)
    } catch {
      return '—'
    }
  })()
  return `${mode} · ${storage} · ${size} · ${created} 创建`
}

// ── HTML 渲染（纯表单，无 JS 无内联事件）──────────────────────────────────
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** 统计出参兜底：null/undefined/NaN 一律归 0（hub 老版本 / 空库都按 0 展示） */
function num(v: unknown): string {
  return String(Number(v) || 0)
}

function page(title: string, body: string, flash = '', authed = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · 控制面</title>
<style>
  /* ===== 控制面 —— 与官网 bloghao.com 同源「纸墨朱砂」设计语言 ===== */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: light;
    --accent: #b23a29;
    --accent-dark: #962e1e;
    --accent-soft: rgba(178, 58, 41, 0.08);
    --bg: #faf8f4;
    --tint: #f4efe7;
    --card: #ffffff;
    --ink: #211d19;
    --sub: #6e675e;
    --line: #e8e1d6;
    --radius: 18px;
    --shadow: 0 10px 40px rgba(32, 29, 26, 0.08);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", system-ui, sans-serif;
    background: var(--bg); color: var(--ink); line-height: 1.7;
    -webkit-text-size-adjust: 100%;
  }
  /* 页面底纹：官网 hero 同款朱砂晕染 */
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(ellipse 60% 45% at 18% 0%, rgba(178, 58, 41, 0.08), transparent),
      radial-gradient(ellipse 50% 40% at 85% 8%, rgba(178, 58, 41, 0.05), transparent),
      linear-gradient(180deg, #f6efe7 0%, var(--bg) 78%);
  }
  /* 顶栏：官网导航同款毛玻璃 */
  .topbar {
    position: sticky; top: 0; z-index: 100;
    background: rgba(250, 248, 244, 0.85);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
  }
  .topbar-inner {
    max-width: 1080px; margin: 0 auto; padding: 0 24px; height: 62px;
    display: flex; align-items: center; gap: 12px;
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 800; font-size: 16px; color: var(--ink); text-decoration: none; }
  .brand-icon {
    width: 26px; height: 26px; border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), #c25440);
    color: #fff; font-size: 13px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 12px rgba(178, 58, 41, 0.3);
  }
  .brand-en { color: var(--sub); font-weight: 600; font-size: 12.5px; }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    border-radius: 999px; padding: 4px 13px; font-size: 12.5px; font-weight: 600;
    white-space: nowrap;
  }
  .pill.ok { background: rgba(34, 128, 84, 0.09); color: #1e6b47; }
  .pill.ok::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #22a06b; box-shadow: 0 0 0 3px rgba(34, 160, 107, 0.18); }
  .pill.off { background: #fdf0ee; color: var(--accent-dark); }
  .pill.off::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .pill.demo { background: rgba(176, 127, 29, 0.1); color: #8a6215; }
  .pill.wait { background: var(--tint); color: var(--sub); }

  main { max-width: 1080px; margin: 0 auto; padding: 30px 24px 72px; }
  .page-head { margin-bottom: 22px; }
  h1 { font-size: 24px; font-weight: 800; letter-spacing: 0.01em; }
  .sub { color: var(--sub); font-size: 13.5px; margin-top: 4px; }
  h2 { font-size: 16.5px; font-weight: 700; margin: 0 0 12px; letter-spacing: 0.01em; }
  h2 .muted { font-weight: 400; font-size: 12.5px; }

  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 22px 24px; margin-bottom: 18px;
    transition: box-shadow 0.25s ease, border-color 0.25s ease;
  }
  .card:hover { box-shadow: var(--shadow); border-color: rgba(178, 58, 41, 0.22); }
  .card-flat { padding: 0; overflow: hidden; }
  .card-flat > h2 { padding: 16px 22px 0; }

  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid #f0ebe2; vertical-align: middle; }
  tr:last-child > td { border-bottom: none; }
  th { color: var(--sub); font-weight: 600; font-size: 12.5px; letter-spacing: 0.02em; }
  tbody tr { transition: background 0.15s ease; }
  tbody tr:hover { background: #fcfaf6; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  .tenant-meta { color: var(--sub); font-size: 12.5px; line-height: 1.55; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions form { display: inline-block; margin-left: 6px; }
  .table-wrap { overflow-x: auto; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 16px; border-radius: 999px;
    font-size: 13.5px; font-weight: 600; font-family: inherit;
    border: 1.5px solid var(--line); background: var(--card); color: var(--ink);
    transition: all 0.2s ease; cursor: pointer; text-decoration: none; line-height: 1.5;
    white-space: nowrap;
  }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(32, 29, 26, 0.1); border-color: #d6cec2; }
  .btn:active { transform: none; box-shadow: none; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 6px 20px rgba(178, 58, 41, 0.32); }
  .btn-primary:hover { background: var(--accent-dark); border-color: var(--accent-dark); }
  .btn-danger { color: var(--accent-dark); border-color: rgba(178, 58, 41, 0.35); }
  .btn-danger:hover { background: #fdf0ee; border-color: var(--accent); box-shadow: 0 6px 18px rgba(178, 58, 41, 0.15); }
  .btn-lg { padding: 11px 26px; font-size: 15px; }

  label { display: block; font-size: 13px; font-weight: 600; color: #4a443c; margin: 0 0 6px; }
  input[type=text], input[type=password] {
    border: 1.5px solid var(--line); border-radius: 12px; padding: 10px 14px;
    font-size: 16px; font-family: inherit; width: 100%; background: #fff; color: var(--ink);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  input[type=text]:focus, input[type=password]:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 4px rgba(178, 58, 41, 0.12);
  }
  input[type=checkbox] { width: auto; accent-color: var(--accent); }
  .check-label { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1; min-width: 220px; }
  .row > div.fixed { flex: 0 0 auto; min-width: 0; }

  .flash {
    display: flex; gap: 10px; align-items: flex-start;
    background: rgba(34, 128, 84, 0.07); border: 1px solid rgba(34, 160, 107, 0.35); color: #1e6b47;
    border-radius: 14px; padding: 13px 18px; margin-bottom: 18px; font-size: 14px; word-break: break-all;
    animation: slide-in 0.35s ease;
  }
  .flash.err { background: #fdf0ee; border-color: rgba(178, 58, 41, 0.35); color: var(--accent-dark); }
  .flash code.big { font-size: 17px; font-weight: 700; padding: 2px 10px; }
  @keyframes slide-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }

  .muted { color: var(--sub); font-size: 12.5px; }
  .fade { animation: fade-in 0.5s ease both; }
  .fade-1 { animation-delay: 0.05s; } .fade-2 { animation-delay: 0.12s; } .fade-3 { animation-delay: 0.19s; }
  @keyframes fade-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .flash, .fade, .fade-1, .fade-2, .fade-3 { animation: none; }
    .btn:hover, .card:hover { transform: none; }
  }

  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--accent-soft); color: #8f2f1f; border-radius: 5px; padding: 1px 6px; font-size: 0.92em; }
  .stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 14px 18px;
  }
  .stat b { display: block; font-size: 20px; font-weight: 800; letter-spacing: 0.01em; }
  .stat span { font-size: 12.5px; color: var(--sub); }
  .stat.accent b { color: var(--accent); }

  /* 登录页：官网 hero 同款居中卡片 + 朱砂光晕 */
  .login-wrap { min-height: calc(100vh - 62px); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .login-card {
    width: 100%; max-width: 400px;
    background: var(--card); border: 1px solid var(--line); border-radius: 22px;
    padding: 36px 34px 30px; box-shadow: var(--shadow);
    animation: fade-in 0.5s ease both;
  }
  .login-logo { width: 52px; height: 52px; border-radius: 15px; margin: 0 auto 16px;
    background: linear-gradient(135deg, var(--accent), #c25440);
    color: #fff; font-size: 24px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 10px 26px rgba(178, 58, 41, 0.35);
  }
  .login-card h1 { text-align: center; font-size: 21px; }
  .login-card .sub { text-align: center; margin-bottom: 24px; }
  .login-card label { margin-top: 14px; }
  .login-card .btn { width: 100%; margin-top: 22px; padding: 12px 22px; font-size: 15px; }
  .login-tip { text-align: center; margin-top: 16px; }

  .empty { text-align: center; color: var(--sub); font-size: 13.5px; padding: 28px 0; }
  .logout-form { margin: 0; }

  @media (max-width: 640px) {
    .topbar-inner, main { padding-left: 16px; padding-right: 16px; }
    .brand-en { display: none; }
    .brand { font-size: 15px; }
    .topbar-inner { height: 56px; gap: 8px; }
    .topbar-right { gap: 8px; }
    .topbar .pill { padding: 3px 10px; font-size: 11.5px; }
    .topbar .btn { padding: 5px 12px; font-size: 12.5px; }
    .hide-sm { display: none; }
    /* 移动端表格转卡片式堆叠：不横向滚动，按钮 nowrap 不折行 */
    .table-wrap { overflow-x: visible; }
    table, tbody, tr, td { display: block; }
    thead { display: none; }
    tr { padding: 13px 0; border-bottom: 1px solid #f0ebe2; }
    tr:last-child { border-bottom: none; }
    td { padding: 3px 0; border: none; }
    td.mono { font-size: 13.5px; font-weight: 600; }
    td.actions { text-align: left; white-space: normal; }
    td.actions form { display: inline-block; margin: 8px 8px 0 0; }
    /* 移动端数据列藏进详情页：卡片式表格里只留域名/状态/动作 */
    .table-wrap td:nth-child(2) { display: none; }
    .card { padding: 18px 16px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-icon">博</span>博客号控制台 <span class="brand-en">BlogHao Ops</span></a>
    <div class="topbar-right">${authed ? sessionBadgeHtml() + logoutHtml() : ''}</div>
  </div>
</header>
<main>
${flash ? `<div class="flash${flash.startsWith('✗') ? ' err' : ''}">${flash.startsWith('✓!') ? flash.slice(2) : esc(flash)}</div>` : ''}
${body}
</main>
</body>
</html>`
}

/** 顶栏右侧：已登录显示 DNS 状态胶囊 + 退出按钮；未登录（登录页）什么都不出 */
function sessionBadgeHtml(): string {
  return `<span class="pill ${cfEnabled() ? 'ok' : 'off'}">${cfEnabled() ? 'DNS 自动记录' : 'DNS 手动模式'}</span>`
}

function logoutHtml(): string {
  return `<form class="logout-form" method="post" action="/logout"><button class="btn" type="submit">退出登录</button></form>`
}

let startedAt = 0

function loginPage(msg = ''): string {
  return page(
    '控制台登录',
    `<div class="login-wrap">
<div class="login-card">
  <div class="login-logo">博</div>
  <h1>博客号控制台</h1>
  <p class="sub">xwblog 多租户自托管管理面板</p>
  <form method="post" action="/login">
    <label for="username">账户名</label>
    <input type="text" id="username" name="username" value="${esc(CONTROL_USERNAME === 'admin' ? 'admin' : '')}" placeholder="账户名" autofocus autocomplete="username" autocapitalize="none" spellcheck="false" required>
    <label for="password">密码</label>
    <input type="password" id="password" name="password" placeholder="密码" autocomplete="current-password" required>
    <button class="btn btn-primary" type="submit">登 录</button>
    ${msg ? `<p class="muted login-tip">${esc(msg)}</p>` : ''}
  </form>
</div>
</div>`,
  )
}

/** 站点投稿卡：官网目录页「他们也在写博客号」表单的落盘展示（写入端点见 controlApp 的
 *  /showcase-submit，落 TENANTS_DIR/showcase-submissions.json）；上榜 = 人工往主仓库
 *  website/public/data/showcase.json 加一条（随 website-sync 生效），删除仅用于清理无效投稿 */
function showcaseCardHtml(): string {
  const file = path.join(process.env.TENANTS_DIR || 'data/tenants', 'showcase-submissions.json')
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as { ts: number; url: string; name?: string }[]
    if (!Array.isArray(list) || !list.length)
      return '<div class="card fade fade-2"><h2>站点投稿</h2><p class="tenant-meta">还没有收到投稿——官网目录页「他们也在写博客号」的表单会落在这里。</p></div>'
    const rows = list
      .map(
        (s, i) =>
          `<tr><td class="mono hide-sm">${esc(new Date(s.ts).toISOString().slice(0, 16).replace('T', ' '))}</td><td class="mono"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></td><td>${esc(s.name || '')}</td><td class="actions"><form method="post" action="/showcase-submit/del"><input type="hidden" name="idx" value="${i}"><button class="btn" type="submit">删除</button></form></td></tr>`,
      )
      .join('')
    return `<div class="card fade fade-2"><h2>站点投稿 <span class="muted">· ${list.length} 条待处理</span></h2><p class="tenant-meta" style="margin-bottom:10px">官网目录页表单的投稿落在这里；上榜 = 往主仓库 website/public/data/showcase.json 加一条（随 website-sync 生效），删除仅用于清理无效投稿。</p><div class="table-wrap"><table><thead><tr><th class="hide-sm">时间(UTC)</th><th>站点</th><th>名称</th><th style="text-align:right">操作</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
  } catch {
    return '<div class="card fade fade-2"><h2>站点投稿</h2><p class="tenant-meta">投稿数据暂时读不到。</p></div>'
  }
}

async function dashboard(deps: ControlDeps, flash = ''): Promise<string> {
  // 广场统计按需拉取（4s 超时）：hub 不可达时卡片降级，不影响其余面板
  const plazaStats = PLAZA_HUB_URL && PLAZA_ADMIN_TOKEN ? await fetchPlazaStats() : null
  const scheme = deps.scheme === 'https' ? 'https' : 'http'
  // 数据列涉及逐租户开库查询，与广场统计一样在 async 上下文取好再进纯渲染
  const statsMap = new Map<string, TenantStats | null>()
  for (const host of Object.keys(deps.readTenantsConfig().tenants)) {
    statsMap.set(host, await tenantStats(host))
  }
  return page('控制台', dashboardBody(deps, plazaStats, scheme, statsMap), flash, true)
}

/** 仪表盘入口（GET /）：flash 从一次性 Cookie 取（PRG），取到必须带清障头回给浏览器 */
async function dashboardRoute(deps: ControlDeps, inlineFlash = ''): Promise<void> {
  const taken = takeFlash(deps.req)
  const flash = taken?.flash || inlineFlash
  const body = await dashboard(deps, flash)
  const headers: Record<string, string> = taken ? { 'Set-Cookie': taken.clear } : {}
  sendHtml(deps.res, body, 200, headers)
}

function dashboardBody(
  deps: ControlDeps,
  plazaStats: PlazaStats | null,
  scheme = 'https',
  statsMap?: Map<string, TenantStats | null>,
): string {
  const cfgAll = deps.readTenantsConfig()
  const rows = Object.entries(cfgAll.tenants)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([host, cfg]) => {
      const live = deps.tenants.has(host)
      const meta = tenantMeta(host, cfg, live)
      const pill = live ? '<span class="pill ok">运行中</span>' : cfg.disabled ? '<span class="pill off">已停用</span>' : '<span class="pill wait">未加载</span>'
      const frontUrl = `${scheme}://${host}/`
      const actions = [
        `<a class="btn" href="${esc(frontUrl)}" target="_blank" rel="noopener">前台 ↗</a>`,
        `<a class="btn" href="${esc(frontUrl)}admin/" target="_blank" rel="noopener">后台 ↗</a>`,
        `<a class="btn" href="/tenant?host=${encodeURIComponent(host)}">详情</a>`,
        live ? `<form method="post" action="/disable"><input type="hidden" name="host" value="${esc(host)}"><button class="btn" type="submit">停用</button></form>` : '',
        cfg.disabled ? `<form method="post" action="/enable"><input type="hidden" name="host" value="${esc(host)}"><button class="btn" type="submit">启用</button></form>` : '',
        `<form method="post" action="/reset"><input type="hidden" name="host" value="${esc(host)}"><button class="btn" type="submit">重置密码</button></form>`,
        `<form method="get" action="/delete"><input type="hidden" name="host" value="${esc(host)}"><button class="btn btn-danger" type="submit">删除…</button></form>`,
      ]
        .filter(Boolean)
        .join('')
      const st = statsMap?.get(host) ?? null
      return `<tr>
  <td class="mono"><a href="/tenant?host=${encodeURIComponent(host)}" style="color:var(--ink);text-decoration:none;font-weight:600">${esc(host)}</a></td>
  ${statsCellHtml(st, !!cfg.demo)}
  <td class="tenant-meta hide-sm">${esc(meta)}</td>
  <td>${pill}</td>
  <td class="actions">${actions}</td>
</tr>`
    })
    .join('')

  const logs = readOpsLog()
    .map((l) => `<tr><td class="mono hide-sm">${esc(l.ts.slice(0, 16).replace('T', ' '))}</td><td>${esc(l.action)}</td><td class="mono">${esc(l.detail)}</td></tr>`)
    .join('')

  const tenantKeys = Object.keys(cfgAll.tenants)
  const liveCount = tenantKeys.filter((h) => deps.tenants.has(h)).length
  const totalSize = tenantKeys.reduce((n, h) => n + dirSize(tenantDir(h)), 0)
  let diskTotal = 0
  let diskFree = 0
  try {
    const st = fs.statfsSync(process.env.TENANTS_DIR || 'data/tenants')
    diskTotal = Number(st.blocks) * Number(st.bsize)
    diskFree = Number(st.bavail) * Number(st.bsize)
  } catch {
    /* statfs 不可用时略过 */
  }
  const days = ((Date.now() - startedAt) / 86400_000).toFixed(1)
  const mem = fmtBytes(process.memoryUsage().rss)
  const siteMeta = SITE_DIR ? readSiteMeta() : null

  return `
<div class="page-head fade">
  <h1>控制台</h1>
  <p class="sub">xwblog 多租户自托管管理面板 · 开通即自动建 DNS 与证书</p>
</div>

<div class="stat-strip fade fade-1">
  <div class="stat accent"><b>${liveCount}<span style="font-size:13px;font-weight:600;color:var(--sub)"> / ${tenantKeys.length}</span></b><span>运行中 / 租户总数</span></div>
  <div class="stat"><b>${fmtBytes(totalSize)}</b><span>数据占用${diskTotal ? ` · 可用 ${fmtBytes(diskFree)}` : ''}</span></div>
  <div class="stat"><b>${days}<span style="font-size:13px;font-weight:600;color:var(--sub)"> 天</span></b><span>进程运行 · RSS ${esc(mem)}</span></div>
  <div class="stat"><b style="font-size:15px;line-height:30px">${cfEnabled() ? '已启用' : '未配置'}</b><span>DNS 自动记录（Cloudflare）</span></div>
</div>

${
  SITE_DIR
    ? `<div class="card fade fade-1">
  <h2>官网 bloghao.com <span class="muted">· ${esc(GH_REPO)}</span></h2>
  <p class="tenant-meta" style="margin-bottom:12px">当前部署：${
    siteMeta
      ? `<code>${esc(siteMeta.sha.slice(0, 7))}</code> · ${esc(siteMeta.subject.slice(0, 40)) || '（无提交标题）'} · ${esc(siteMeta.syncedAt.slice(0, 10))} 同步（UTC）`
      : '版本未记录（点右侧按钮完成首次同步）'
  }</p>
  <form method="post" action="/website-sync"><button class="btn btn-primary" type="submit">同步 GitHub 最新版本</button></form>
</div>`
    : ''
}

${
  PLAZA_HUB_URL && PLAZA_ADMIN_TOKEN
    ? `<div class="card fade fade-2">
  <h2>广场 hub <span class="muted">· ${esc(PLAZA_HUB_URL).replace(/^https?:\/\//, '')} · <a href="https://bloghao.com/plaza/" style="color:var(--accent)">查看广场 ↗</a></span></h2>
  ${
    plazaStats
      ? `<div class="stat-strip" style="margin-bottom:8px">
    <div class="stat accent"><b>${num(plazaStats.sites?.active)}<span style="font-size:13px;font-weight:600;color:var(--sub)"> / ${num(plazaStats.sites?.total)}</span></b><span>活跃 / 接入站点 · 认证 ${num(plazaStats.sites?.verified)}</span></div>
    <div class="stat"><b>${num(plazaStats.items?.total)}</b><span>广场内容（文章 ${num(plazaStats.items?.posts)} · 微博 ${num(plazaStats.items?.weibo)}）</span></div>
    <div class="stat"><b>${num(plazaStats.today?.feed)}</b><span>今日 feed 拉取 ≈ 广场页访问</span></div>
    <div class="stat"><b>${num(plazaStats.today?.ingest)}<span style="font-size:13px;font-weight:600;color:var(--sub)"> / ${num(plazaStats.total?.ingest)}</span></b><span>今日 / 累计上报 · 今日 ${num(plazaStats.today?.items)} 条</span></div>
  </div>
  <p class="muted">统计来自 hub /api/admin/stats（北京日口径）；24 小时新增内容 ${num(plazaStats.items?.last24h)} 条。</p>`
      : '<p class="tenant-meta">hub 暂时不可达，统计稍后自动恢复。</p>'
  }
  <form method="post" action="/plaza-sync" style="margin-top:12px">
    <button class="btn btn-primary" type="submit">分站收录进广场</button>
    <span class="muted" style="margin-left:8px">全部真实分站对齐进 hub（演示/停用站除外）并触发一次补漏；开通/启用已自动收录，此按钮用于存量站补录与失败重试。</span>
  </form>
</div>`
    : ''
}

${showcaseCardHtml()}

<div class="card fade fade-2">
  <h2>开通新网站</h2>
  <form method="post" action="/create">
    <div class="row">
      <div>
        <label for="host">域名</label>
        <input type="text" id="host" name="host" placeholder="例如 someone.bloghao.com" required>
      </div>
      <div class="fixed">
        <label class="check-label"><input type="checkbox" name="demo" value="1"> 演示种子站</label>
      </div>
      <div class="fixed">
        <button class="btn btn-primary" type="submit">开通</button>
      </div>
    </div>
    <p class="muted" style="margin-top:10px">${cfEnabled() ? 'DNS 将自动创建（橙云代理），证书首次访问自动签发' : '未配置 CF_API_TOKEN：需手动添加 DNS 记录指向本机'}</p>
  </form>
</div>

<div class="card card-flat fade fade-2">
  <h2>租户（${tenantKeys.length}）<span class="muted">· 数据合计 ${fmtBytes(totalSize)} · 域名进详情，前台/后台按钮直接跳转</span></h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th>域名</th><th>数据</th><th class="hide-sm">信息</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
    <tbody>
    ${rows || '<tr><td colspan="5" class="empty">还没有租户，用上面表单开通第一个网站吧。</td></tr>'}
    </tbody>
  </table>
  </div>
</div>

<div class="card card-flat fade fade-3">
  <h2>操作日志<span class="muted"> · 最近 20 条（时间为 UTC）</span></h2>
  <div class="table-wrap">
  <table>
    <thead><tr><th class="hide-sm">时间</th><th>动作</th><th>详情</th></tr></thead>
    <tbody>
    ${logs || '<tr><td colspan="3" class="empty">暂无操作记录。</td></tr>'}
    </tbody>
  </table>
  </div>
</div>`
}

// ── 重置管理员密码 ────────────────────────────────────────────────────────
async function resetAdminPassword(host: string): Promise<string> {
  const cfgFile = path.join(tenantDir(host), 'blog.db')
  if (!fs.existsSync(cfgFile)) return '✗ 该租户还没有数据库（从未被访问过），无需重置'
  // 直接用 node:sqlite 打开租户库（绕过 D1 shim 的长连接缓存），PBKDF2 与 src/auth.ts 同参数
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(cfgFile)
  try {
    const row = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get() as { id: number; username: string } | undefined
    if (!row) return '✗ 该站点还未创建管理员（首装未完成），无需重置'
    const password = randomToken(9) // 12 位 URL 安全字符，作为一次性初始密码足够强
    const { hash, salt } = await hashPassword(password)
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?').run(hash, salt, Date.now(), row.id)
    db.prepare('DELETE FROM sessions').run() // 踢掉所有已登录会话
    opsLog('重置密码', `${host}（${row.username}）`)
    // '✓!' 前缀 = flash 含可信 HTML（page() 对它跳过 esc），密码本体是 randomToken 字符无需转义
    return `✓!✓ ${esc(host)} 管理员 ${esc(row.username)} 的新密码：<br><code style="font-size:18px">${password}</code><br><span class="muted">只显示这一次，请立即复制并到该站后台修改。</span>`
  } finally {
    db.close()
  }
}

// ── 请求主循环 ───────────────────────────────────────────────────────────
/** 摘除租户前关掉 D1 长连接：Windows 上打开中的 SQLite 文件删不掉（rmSync 静默失败），
 *  Linux 下不关也删得掉但 WAL 不 checkpoint——统一先关 */
function closeTenantDb(env: Record<string, unknown> | undefined): void {
  const db = env?.DB as { close?: () => void } | undefined
  try {
    db?.close?.()
  } catch {
    /* 已关闭 / 不可关不阻塞摘除 */
  }
}

function sendHtml(res: import('node:http').ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

function originOk(req: import('node:http').IncomingMessage, url: URL): boolean {
  const origin = req.headers.origin
  if (!origin) return true // 同源表单回退（无 CORS 的普通 POST 允许缺省 Origin）
  try {
    return new URL(origin).host === url.host
  } catch {
    return false
  }
}

async function readBody(req: import('node:http').IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export async function controlApp(deps: ControlDeps): Promise<void> {
  const { req, res, url } = deps
  const method = (req.method || 'GET').toUpperCase()
  const path = url.pathname
  startedAt ||= Date.now() - Number(process.uptime() * 1000)

  // 登录：账户名 + 密码 双字段，限流 10 次 / 10 分钟（复用 src/auth.ts 的进程内限流桶）
  if (method === 'POST' && path === '/login') {
    if (!rateLimit(`control-login:${deps.host}`, 10, 10 * 60_000)) {
      return sendHtml(res, loginPage('尝试次数过多，请 10 分钟后再试。'), 429)
    }
    const body = await readBody(req)
    const user = body.get('username') || ''
    const pass = body.get('password') || ''
    // 账户名/密码都走常时比较，避免组合枚举侧信道
    if (!safeEqual(user.toLowerCase(), CONTROL_USERNAME) || !safeEqual(pass, CONTROL_PASSWORD)) {
      deps.log('登录失败')
      return sendHtml(res, loginPage('账户名或密码不对。'), 403)
    }
    const token = issueSession()
    opsLog('登录', '控制面登录成功')
    // Secure 按请求 scheme：TLS 反代下带上防明文链路窃取；本地 http 冒烟时浏览器/客户端
    // 不收 Secure cookie，按 scheme 摘除（与 sendToNode 对租户会话 cookie 同一策略）
    const securePart = deps.scheme === 'https' ? '; Secure' : ''
    res.writeHead(303, {
      'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${securePart}; Max-Age=${SESSION_TTL_MS / 1000}`,
      Location: '/',
    })
    return res.end()
  }

  // 站点投稿（公开端点，官网目录页表单跨站提交）：Origin 白名单（仅 bloghao.com）+ https
  // 域名校验 + 同 IP 每小时 5 条限流 + 同 URL 去重；落盘 showcase-submissions.json 待人工上架。
  // 必须在会话门之前——投稿人不是面板用户
  if (method === 'POST' && path === '/showcase-submit') {
    res.setHeader('Access-Control-Allow-Origin', 'https://bloghao.com')
    if (req.headers.origin !== 'https://bloghao.com') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: 'bad origin' }))
    }
    const body = await readBody(req)
    const rawUrl = (body.get('url') || '').trim()
    const rawName = (body.get('name') || '').trim().slice(0, 40)
    let submitHost = ''
    try {
      const u = new URL(rawUrl)
      // HOST_RE 与 server.ts 同口径：只收形态合法的主机名，内容真伪由人工上架把关
      if (u.protocol !== 'https:' || !HOST_RE.test(u.hostname)) throw new Error('bad url')
      submitHost = u.hostname
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: '请提交 https:// 开头的博客号地址' }))
    }
    const file = path.join(process.env.TENANTS_DIR || 'data/tenants', 'showcase-submissions.json')
    let list: { ts: number; ip: string; url: string; name?: string }[] = []
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 首次投稿尚无文件 */
    }
    if (!Array.isArray(list)) list = []
    const ip = String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '')
    const now = Date.now()
    if (list.filter((s) => s.ip === ip && now - s.ts < 3600_000).length >= 5) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: '提交太频繁，一小时后再试' }))
    }
    if (list.some((s) => s.url === rawUrl)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, dup: true }))
    }
    list.push({ ts: now, ip, url: rawUrl, name: rawName || submitHost })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(list, null, 2))
    opsLog('站点投稿', rawUrl)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true }))
  }

  // 其余一切路径都要会话；未登录一律 303 到 /（根路径渲染登录页）
  const isRoot = method === 'GET' && path === '/'
  if (!isRoot && !sessionOk(req)) {
    res.writeHead(303, { Location: '/' })
    return res.end()
  }

  if (method === 'GET' && path === '/') {
    if (!sessionOk(req)) return sendHtml(res, loginPage())
    return dashboardRoute(deps)
  }

  if (method === 'POST' && !originOk(req, url)) {
    return sendHtml(res, page('拒绝', '<div class="card">跨站请求被拒绝。</div>', '', true), 403)
  }

  const form = method === 'POST' ? await readBody(req) : null
  const host = (form?.get('host') || '').trim().toLowerCase()

  if (method === 'POST' && path === '/logout') {
    const cookie = req.headers.cookie || ''
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9]+)`))
    if (m) sessions.delete(m[1])
    res.writeHead(303, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`, Location: '/' })
    return res.end()
  }

  if (method === 'POST' && path === '/showcase-submit/del') {
    const idx = parseInt(form?.get('idx') || '', 10)
    const file = path.join(process.env.TENANTS_DIR || 'data/tenants', 'showcase-submissions.json')
    let list: { url: string }[] = []
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 无文件视为空列表 */
    }
    if (Array.isArray(list) && idx >= 0 && idx < list.length) {
      const gone = list.splice(idx, 1)[0]
      fs.writeFileSync(file, JSON.stringify(list, null, 2))
      opsLog('投稿删除', gone.url)
    }
    return flashRedirect(res, '✓ 已处理')
  }

  if (method === 'POST' && path === '/create') {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      return flashRedirect(res, '✗ 域名形态不合法（小写字母数字与连字符，至少两段）')
    }
    const cfgAll = deps.readTenantsConfig()
    if (cfgAll.tenants[host]) return flashRedirect(res, `✗ ${host} 已存在`)
    const demo = form?.get('demo') === '1'
    try {
      cfgAll.tenants[host] = demo ? { demo: true } : {}
      deps.writeTenantsConfig(cfgAll)
      const tenant = await deps.createTenantFor(host, cfgAll.tenants[host], cfgAll.r2)
      deps.tenants.set(host, tenant) // 热加载：免重启立即进路由
    } catch (e) {
      // 开台失败回滚配置，避免留下「配置有、路由无」的中间态
      const cfgAll2 = deps.readTenantsConfig()
      delete cfgAll2.tenants[host]
      deps.writeTenantsConfig(cfgAll2)
      return flashRedirect(res, `✗ 开通失败：${String(e)}`)
    }
    const s = schemeOf(deps)
    let flash = `✓!✓ <b>${esc(host)}</b> 开通成功！两个地址请发给博主：<br>
    前台 <code style="font-size:15px"><a href="${esc(s)}://${esc(host)}/" target="_blank" rel="noopener">${esc(s)}://${esc(host)}/</a></code><br>
    后台管理 <code style="font-size:15px"><a href="${esc(s)}://${esc(host)}/admin/" target="_blank" rel="noopener">${esc(s)}://${esc(host)}/admin/</a></code><br>
    <span class="muted">博主首次打开后台会引导创建管理员账号；证书首次访问自动签发，开箱即写。日常运营情况可在「租户」列表点「详情」查看。</span><br>
    ${demo
      ? '<span class="muted">演示站刻意不进搜索引擎索引（列表「收录」列会标为演示站，属正常）。</span>'
      : '<span class="muted">收录默认已就绪（robots.txt / sitemap.xml 自动生成，搜索引擎与 AI 直接可抓）；日后若在后台开了「禁止搜索引擎收录」，列表「收录」列会立刻标红。</span>'}`
    if (cfEnabled()) {
      const ip = process.env.SERVER_IP || ''
      const err = ip ? await dnsCreate(host, ip) : '已设置 CF_API_TOKEN 但未设 SERVER_IP（面板用它建 A 记录），请手动加 DNS'
      if (err) flash += `；${err}`
      else flash += '；DNS 已自动创建（橙云）'
    } else {
      flash += '；请手动添加 DNS：A 记录指向本机（Cloudflare 橙云）'
    }
    // 广场自动收录（演示租户不收录）：best-effort，失败只提示不回滚开站
    const plaza = await plazaEnsureSite(deps, host, cfgAll.tenants[host] || {})
    if (plaza.ok === 'added' && plaza.note) flash += `；<br>✓ ${esc(plaza.note)}`
    else if (plaza.ok === 'error') flash += `；<br><span style="color:#b45309">✗ ${esc(plaza.note)}</span>`
    opsLog('开通', host + (demo ? '（演示种子）' : ''))
    return flashRedirect(res, flash)
  }

  // 分站详情：完整数据 + 最近内容 + 前台/后台入口（host 白名单校验防路径穿越）
  if (method === 'GET' && path === '/tenant' && url.searchParams.has('host')) {
    const target = (url.searchParams.get('host') || '').toLowerCase()
    if (!HOST_SHAPE_RE.test(target) || !deps.readTenantsConfig().tenants[target]) {
      return sendHtml(res, page('404', '<div class="card">没有这个站点。</div>', '', true), 404)
    }
    const cfg = deps.readTenantsConfig().tenants[target] || {}
    const live = deps.tenants.has(target)
    return sendHtml(res, page('分站详情', await tenantDetailBody(target, cfg, live, deps.scheme), '', true))
  }

  if (method === 'POST' && path === '/disable' && host) {
    const cfgAll = deps.readTenantsConfig()
    let plazaNote = ''
    if (cfgAll.tenants[host]) {
      cfgAll.tenants[host].disabled = true
      deps.writeTenantsConfig(cfgAll)
      closeTenantDb(deps.tenants.get(host)?.env)
      deps.tenants.delete(host) // 路由摘除；库与目录原样保留
      opsLog('停用', host)
      // 广场同步隐藏（best-effort）：站点下线了，广场名录与内容不该继续挂着
      if (PLAZA_HUB_URL && PLAZA_ADMIN_TOKEN) {
        const id = await plazaFindSiteId(`https://${host}`)
        const hid = id ? (await plazaApi('PATCH', `/api/admin/sites/${id}`, { disabled: true })).status === 200 : false
        plazaNote = hid ? '；广场条目已同步隐藏' : '；广场隐藏未完成（hub 不可达或未收录）'
      }
    }
    return flashRedirect(res, `✓ ${host} 已停用（数据保留，可随时启用）${plazaNote}`)
  }

  if (method === 'POST' && path === '/enable' && host) {
    const cfgAll = deps.readTenantsConfig()
    const cfg = cfgAll.tenants[host]
    let flash = `✓ ${host} 已启用`
    if (cfg) {
      delete cfg.disabled
      deps.writeTenantsConfig(cfgAll)
      deps.tenants.set(host, await deps.createTenantFor(host, cfg, cfgAll.r2))
      opsLog('启用', host)
      // 启用即补收录（覆盖「收录功能上线前建的老站」与此前被停用过的站）
      const plaza = await plazaEnsureSite(deps, host, cfg)
      if (plaza.ok === 'added' && plaza.note) flash += `；✓ ${esc(plaza.note)}`
      else if (plaza.ok === 'error') flash += `；✗ ${esc(plaza.note)}`
    }
    return flashRedirect(res, flash)
  }

  if (method === 'POST' && path === '/delete' && host) {
    if (form?.get('confirm') !== host) {
      return flashRedirect(res, '✗ 确认域名不匹配，未删除')
    }
    const cfgAll = deps.readTenantsConfig()
    if (cfgAll.tenants[host]) {
      delete cfgAll.tenants[host]
      deps.writeTenantsConfig(cfgAll)
      closeTenantDb(deps.tenants.get(host)?.env)
      deps.tenants.delete(host)
      fs.rmSync(tenantDir(host), { recursive: true, force: true })
      opsLog('删除', host)
      if (cfEnabled()) await dnsDelete(host)
      // 广场同步移除（best-effort）：hub 删站自带级联清内容；未收录过 = 无需清
      let plazaNote = ''
      if (PLAZA_HUB_URL && PLAZA_ADMIN_TOKEN) {
        const id = await plazaFindSiteId(`https://${host}`)
        const gone = id ? (await plazaApi('DELETE', `/api/admin/sites/${id}`)).status === 200 : true
        plazaNote = gone ? '；广场条目已同步清除' : '；广场清除未完成（hub 不可达，可稍后在 hub 管理端手工删）'
      }
      return flashRedirect(res, `✓ ${host} 已彻底删除（配置 + 数据目录${cfEnabled() ? ' + DNS 记录' : ''}）${plazaNote}`)
    }
    return flashRedirect(res, `✓ ${host} 已彻底删除（配置 + 数据目录${cfEnabled() ? ' + DNS 记录' : ''}）`)
  }

  // 域名形态守卫（与 /create 同一正则，常量 HOST_SHAPE_RE 在模块顶层）：host 直接拼进
  // tenants/<host>/ 路径，不设防的 ../ 会打出 tenants 目录之外（reset 是改密+清会话的毁灭性操作）

  if (method === 'POST' && path === '/reset' && host) {
    if (!HOST_SHAPE_RE.test(host)) {
      return flashRedirect(res, '✗ 域名形态不合法')
    }
    const flash = await resetAdminPassword(host)
    return flashRedirect(res, flash)
  }

  // 广场收录同步（按钮）：全部真实分站对齐进 hub（演示/停用站除外）+ 触发一次立即补漏。
  // 日常无需手动点——开通/启用已自动收录，这里是补收录功能上线前的存量站与失败重试
  if (method === 'POST' && path === '/plaza-sync') {
    return flashRedirect(res, await plazaSyncAll(deps))
  }

  // 官网同步：拉 GitHub 最新 tarball 替换 SITE_DIR；SITE_DIR 未配置时端点不存在
  if (method === 'POST' && path === '/website-sync') {
    if (!SITE_DIR) return sendHtml(res, page('404', '<div class="card">没有这个页面。</div>', '', true), 404)
    if (syncBusy) return flashRedirect(res, '✗ 已有同步在进行中，请稍候')
    syncBusy = true
    try {
      const flash = await websiteSync()
      return flashRedirect(res, flash)
    } finally {
      syncBusy = false
    }
  }

  // 删除确认页（dashboard 的「删除…」先到这里，输入域名二次确认才真删）
  if (method === 'GET' && path === '/delete' && url.searchParams.get('host')) {
    const target = url.searchParams.get('host') || ''
    return sendHtml(
      res,
      page(
        '删除确认',
        `<div class="card">
  <h2>⚠️ 彻底删除 <code>${esc(target)}</code>？</h2>
  <p class="tenant-meta" style="font-size:13.5px;margin-bottom:14px">将删除该站点的配置、数据库与全部图片，<b>不可恢复</b>。DNS 记录${cfEnabled() ? '会一并清除' : '需手动清理'}。</p>
  <form method="post" action="/delete">
    <input type="hidden" name="host" value="${esc(target)}">
    <label for="confirm">输入完整域名以确认</label>
    <input type="text" id="confirm" name="confirm" placeholder="${esc(target)}" required>
    <p style="margin-top:16px"><button class="btn btn-danger" type="submit">永久删除</button> <a class="btn" href="/">取消</a></p>
  </form>
</div>`,
        '',
        true,
      ),
    )
  }

  return sendHtml(res, page('404', '<div class="card">没有这个页面。</div>', '', true), 404)
}
