/**
 * 整站打包与还原（B26，设计见 docs/PROPOSAL-B26-SITE-BUNDLE.md）—— 自洽小文件，Node 可直接导入。
 *
 * 一句话：把「全部业务表 + 全部图片」打成一个 zip（A 档导出），并只允许把它还原到**空站**（B 档导入）。
 * 与 Markdown 包 / WXR 的分工：那两条是「带走文章」（换别家博客系统），这里是「原样搬家」
 * （换服务器 / 换域名 / 换 BlogHao 实例，无损）。
 *
 * 配套的 `resetSiteContent`（「清空本站内容」）是「准备导入」的步骤：把任何站变回空站，
 * 清的表与 `startBundleImport` 是同一份常量，清的图与整站包会打包的图是同一份收集口径；
 * 保留设置 / 管理员账号 / 密钥 / R2 里已上传的整站包。
 *
 * 三条不可动摇的契约（AGENTS「整站包」防线节，改这里先读）：
 *   ① **只还原到空站**：posts / weibo / pages 三表的**未删除**行数必须全为 0（软删除进回收站的
 *      内容不算「内容」；新站自带的「示例文章」「关于我」两条种子删进回收站即可导入），
 *      或上次导入失败留下的残留（见 bundleImport 记账位），否则明确拒绝——**永不覆盖、永不合并**
 *      （不做 id/slug 冲突处理）。
 *   ② **只装内容，不装实例身份**：不含 users（管理员账号属于实例，目标站用它自己的登录）、
 *      不含会话、不含密钥类 settings（SECRET_SETTINGS，唯一来源在 db.ts）+ 实例态键。
 *   ③ **版本不匹配一律拒绝，不猜**：format 严格相等；包里出现当前 schema 没有的表/列 → 降版，
 *      拒绝并报出具体差异；包里缺当前新增的列 → 升版，按目标默认值补（主用例：旧站导出 → 新机最新版导入）。
 *
 * 平台约束（决定了导入为什么必须「先把包放进存储」）：
 * zip 的中央目录在文件末尾，读取需要**随机访问**；HTTP 请求体是单向流、整包读进内存又会打爆
 * Worker（128MB 内存 / CF 请求体 ≈100MB 上限）。所以导入 = 包先进 R2（`bundles/`，**不在 /images
 * 公开白名单内**），再按 Range 读（src/zip.ts 的读取器），前端分步驱动（每步一次小请求，可重试）。
 */
import { invalidateSharedSettings, saveSettings, SECRET_SETTINGS, tableColumns } from './db'
import { collectReferencedKeys } from './audit'
import { collectImageKeysFromHtml, keyOf } from './export'
import { purgePageCache } from './pagecache'
import { sanitizeHtml } from './sanitize'
import type { Env } from './types'
import { fmtDate } from './utils'
import { APP_VERSION } from './version'
import {
  readZipEntry,
  readZipIndex,
  ZipWriter,
  zipEntryStream,
  zipFind,
  type ZipEntryMeta,
  type ZipSource,
} from './zip'

/** 包格式版本：容器布局（目录名 / manifest 字段）变了才 +1，导入侧严格相等比对 */
export const BUNDLE_FORMAT = 1
/** 整站包在 R2 里的目录（/images 路由只放行 u/ 与 og/，这里不会被公开下载） */
export const BUNDLE_PREFIX = 'bundles/'
/** 单包体积上限：zip 写入器不支持 zip64（>4GB），且导入要按 Range 读——2GB 是保守边界 */
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** 进包的业务表（= backup.ts BACKUP_TABLES 去掉 users）。users 是**实例身份**：
 *  目标站用自己的管理员登录，把包里的账号灌进去反而可能被旧密码锁在外面 */
export const BUNDLE_TABLES = [
  'members',
  'member_points_log',
  'posts',
  'pages',
  'comments',
  'categories',
  'post_categories',
  'weibo',
  'tags',
  'uploads',
  'friend_links',
  'settings',
] as const

/** settings 里不进包的键：密钥类（SECRET_SETTINGS）+ 实例态/记账位。
 *  bundleImport 是导入自己的状态位（进了包会把自己的进度覆盖掉）；
 *  siteUrl 换域名后应以新实例为准；pageCacheEpoch / lastBackup* 是实例记账。 */
export const BUNDLE_SETTINGS_SKIP: string[] = [
  ...SECRET_SETTINGS,
  'siteUrl',
  'pageCacheEpoch',
  'lastBackupAt',
  'lastBackupKey',
  'lastBackupBytes',
  'bundleImport',
]

/** 清空目标站时要删的业务表（settings 除外：密钥/实例态键要留着，只 upsert 包里带来的键） */
const BUNDLE_CLEAR_TABLES = BUNDLE_TABLES.filter((t) => t !== 'settings')

/** 导入状态记账位（settings 键） */
export const BUNDLE_STATE_KEY = 'bundleImport'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** 单表分片的目标字节数：正文可能很大（单篇上限 1MB），按行数切分不保险，按字节切 */
const PART_TARGET_BYTES = 2 * 1024 * 1024
/** 每次从 D1 取的行数（keyset 分页，rowid > last，避免 OFFSET 的读放大） */
const DB_PAGE_ROWS = 500
/** 单表导出上限（与 backup.ts TABLE_ROW_LIMIT 同口径） */
const TABLE_ROW_LIMIT = 100_000
/** 单个导入步骤最多搬多少张图 */
const IMAGE_BATCH = 50
/** 单条 SQL 变量上限 100（demo.ts 的既有教训）→ 多行 INSERT 每句行数 = floor(100 / 列数) */
const MAX_BIND_PARAMS = 100
/** D1 batch 单次语句条数（保守值） */
const BATCH_STMTS = 50
/** 单次 R2 delete 的 key 数（绑定支持数组形态，500 是保守值） */
const R2_DELETE_BATCH = 500

export interface BundleManifest {
  format: number
  app: 'xwblog'
  /** 导出时系统版本（展示 + 报错文案用；兼容判据走 format 与列差异，见 C3） */
  appVersion: string
  exportedAt: number
  tables: { name: string; rows: number; columns: string[]; parts: number }[]
  images: { count: number; bytes: number }
  /** 打包时 R2 里已缺失、只留库记录的图片 key */
  missingImages: string[]
  /** 触到单表上限、只导了部分数据的表（表名(行数)） */
  truncated: string[]
}

export interface BundleImportState {
  state: 'idle' | 'running' | 'failed' | 'done'
  key: string
  at: number
  error?: string
}

export interface BundleStep {
  /** 表名，或 'images' */
  unit: string
  cursor: number
}

export interface BundlePlan {
  key: string
  bytes: number
  manifest: BundleManifest
  steps: BundleStep[]
}

export type BundleResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number }

/* ---------------- 纯函数（Node 直接测试） ---------------- */

/** 整站包文件名：固定 ASCII（xwblog-site-<北京日期>.zip），无需 RFC 5987 编码 */
export function bundleFileName(now: number): string {
  return `xwblog-site-${fmtDate(now)}.zip`
}

/** 图片 key 白名单：与 /images 路由、export.ts keyOf 同口径（u/ og/ 前缀，无穿越字符） */
export function isBundleImageKey(key: string): boolean {
  if (!key.startsWith('u/') && !key.startsWith('og/')) return false
  return !key.includes('..') && !key.includes('\\') && !key.includes('\0')
}

/** 解析 manifest（脏值一律当作「不是本系统的包」，不透内部细节） */
export function parseBundleManifest(json: unknown): BundleResult<BundleManifest> {
  const bad = (error: string, status = 400): BundleResult<BundleManifest> => ({ ok: false, error, status })
  if (!json || typeof json !== 'object') return bad('整站包缺少有效的 manifest.json')
  const m = json as Partial<BundleManifest>
  if (m.app !== 'xwblog') return bad('这不是博客号（xwblog）导出的整站包')
  if (m.format !== BUNDLE_FORMAT) {
    return bad(`整站包格式版本不匹配（包 v${String(m.format)}，当前支持 v${BUNDLE_FORMAT}），请用相同版本的系统导出`)
  }
  if (!Array.isArray(m.tables) || !m.images || typeof m.images.count !== 'number') return bad('整站包 manifest.json 结构损坏')
  return { ok: true, value: m as BundleManifest }
}

/** 版本兼容判据（C3）：包里出现当前 schema 没有的表/列 = 降版，拒绝并报出具体差异。
 *  currentCols 为 null 表示目标表查不到列（异常形态），此时跳过比对交给 INSERT 报错兜底 */
export function checkBundleCompat(
  manifest: BundleManifest,
  currentCols: Map<string, Set<string>> | null
): string | null {
  if (!currentCols) return null
  for (const t of manifest.tables) {
    const cur = currentCols.get(t.name)
    if (!cur) {
      return `这个包是 BlogHao ${manifest.appVersion} 导出的，当前系统是 ${APP_VERSION}；包内含有当前版本没有的数据表（${t.name}），无法导入。请把系统升级到与包相同或更高的版本。`
    }
    const extra = t.columns.filter((c) => !cur.has(c))
    if (extra.length) {
      return `这个包是 BlogHao ${manifest.appVersion} 导出的，当前系统是 ${APP_VERSION}；包内含有当前版本不认识的数据列（${t.name}.${extra.join('、')}），无法导入。请把系统升级到与包相同或更高的版本。`
    }
  }
  return null
}

/** 行值归一：JSON 里的值 → SQLite 绑定值（脏形态一律转成字符串，不炸导入） */
export function normalizeBindValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return JSON.stringify(v)
}

/** 导入前的正文净化（C4）：只有 posts/pages 的 content 是「会进页面的 HTML」，
 *  过一遍 sanitizeHtml（不带 origin，保持原始外链，与存库口径一致）。
 *  其余字段沿用应用自身的信任模型（渲染端 esc 转义 / 结构化校验 / 同信任级原样），不重复清洗。 */
export function sanitizeImportedRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if ((table === 'posts' || table === 'pages') && typeof row.content === 'string' && row.content) {
    return { ...row, content: sanitizeHtml(row.content) }
  }
  return row
}

/** 单条 SQL 变量上限内一次能插几行 */
export function rowsPerStatement(colCount: number): number {
  return Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, colCount)))
}

/* ---------------- R2 数据源 ---------------- */

/** R2 上的整站包 → ZipSource（range get；Docker 形态由 r2disk shim 提供同语义） */
export function r2ZipSource(bucket: R2Bucket, key: string, size: number): ZipSource {
  return {
    size,
    async read(start: number, end: number): Promise<Uint8Array> {
      const length = Math.max(0, end - start)
      if (!length) return new Uint8Array(0)
      const obj = await bucket.get(key, { range: { offset: start, length } })
      if (!obj) throw new Error('整站包已不存在（可能已被删除）')
      return new Uint8Array(await obj.arrayBuffer())
    },
  }
}

/* ---------------- 导入状态记账位 ---------------- */

export async function getBundleImportState(db: D1Database): Promise<BundleImportState> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(BUNDLE_STATE_KEY).first<{ value: string }>()
  const idle: BundleImportState = { state: 'idle', key: '', at: 0 }
  if (!row?.value) return idle
  try {
    const s = JSON.parse(row.value) as Partial<BundleImportState>
    const st = s.state
    if (st !== 'running' && st !== 'failed' && st !== 'done' && st !== 'idle') return idle
    return { state: st, key: typeof s.key === 'string' ? s.key : '', at: Number(s.at) || 0, error: s.error }
  } catch {
    return idle
  }
}

export async function setBundleImportState(db: D1Database, s: BundleImportState): Promise<void> {
  await saveSettings(db, { [BUNDLE_STATE_KEY]: JSON.stringify(s) })
}

/* ---------------- 清空本站内容（整站搬家的准备步骤，也可独立使用） ---------------- */

/** 清空本站的确认语（服务端硬校验）：后台要求站长原样输入这句话，防误触。
 *  真正的闸在这里——UI 的输入框只是引导，绕过 UI 直接打接口同样必须对得上这句话。 */
export const RESET_CONFIRM_PHRASE = '清空本站'

/** 确认语判定（纯函数，Node 直接测）：两侧空白容忍，其余一律不认（缺省 / 数字 / 只写一半都不行） */
export function resetConfirmOk(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === RESET_CONFIRM_PHRASE
}

export interface ResetResult {
  /** 各表清掉的行数（表名 → 行数，仅用于后台回显） */
  cleared: Record<string, number>
  /** 合计行数 */
  total: number
  /** 已删除的图床文件数量 */
  images: number
  /** 图片清理是否完整跑完（false = 中途失败：站点已清空，剩下的图需要自己在 R2 里清） */
  imagesDone: boolean
}

/** 清空后**仍被保留下来的表**（users / settings）引用到的图片 key——它们不能被删：
 *  `users.avatar`（管理员头像）与 `settings` 里的图片地址（站点头像 `avatarUrl`、页脚自定义 HTML、
 *  自定义 CSS 的 `url()` 等）都随「保留身份与配置」活着，删了就是一片破图。
 *  引用识别复用媒体体检的 `audit.ts collectReferencedKeys`（同一份正则口径，纯函数），
 *  候选集只给要删的 key，命中即排除——不做子串包含判断，天然规避 key 互为前缀的误判。 */
async function preservedImageKeys(db: D1Database, candidates: string[]): Promise<Set<string>> {
  if (!candidates.length) return new Set()
  const texts: string[] = []
  const users = await db.prepare("SELECT avatar AS v FROM users WHERE avatar LIKE '%/images/%'").all<{ v: string }>()
  for (const r of users.results ?? []) if (r.v) texts.push(r.v)
  const settings = await db.prepare("SELECT value AS v FROM settings WHERE value LIKE '%/images/%'").all<{ v: string }>()
  for (const r of settings.results ?? []) if (r.v) texts.push(r.v)
  return collectReferencedKeys(candidates, texts)
}

/**
 * 一键清空本站内容：把任何站（刚装好的新站 / 装满内容的老站）立刻变回「没有内容的站」，
 * 于是整站包可以直接导入——省掉「先手动把内容一条条删进回收站」这一步。
 *
 * 清的就是 `BUNDLE_CLEAR_TABLES`（= 包里的 11 张业务表，`settings` 除外），与 `startBundleImport`
 * 清的是**同一份常量、同一个顺序**——两处永远不会漂移，清完必然通过空站守卫。
 * 图片也一并清：删的对象 = `collectBundleImageKeys` 收集的集合（与**整站包会打包哪些图**同一份
 * 口径：媒体库 ∪ 正文 / 封面 / 微博引用）**减去**被保留表引用的那些（见 `preservedImageKeys`：
 * 站点头像 / 管理员头像），等于「把这个包会带走、且清空后不会再被用到的图删掉」。
 * **保留**：`settings`（站点设置 / 各类密钥 / 实例态键）、`users`（管理员账号与登录态）、会话，
 * 以及 R2 里 `bundles/` 下已上传的整站包（不在图片 key 白名单内，清空不会误删要用的包）。
 * 记账位 `bundleImport` 一并归 `idle`：清空后「上次导入失败 / 跑一半」的残留已无意义
 * （顺带把正在跑的导入会话作废，它的后续 step 会以「会话不存在」正常失败）。
 *
 * 顺序是有讲究的：先收集图片 key（清表后就查不到了）→ 清表 → **最后**才删 R2 对象（best-effort）。
 * 图片删除中途失败最坏只是「图床里留了没人引用的孤儿」（`imagesDone:false` 如实上报），
 * 绝不会出现「图没了、文章还在」的破站状态。
 */
export async function resetSiteContent(env: Env): Promise<ResetResult> {
  const db = env.DB
  const cleared: Record<string, number> = {}
  for (const t of BUNDLE_CLEAR_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>()
    cleared[t] = Number(row?.n ?? 0)
  }
  const total = Object.values(cleared).reduce((a, b) => a + b, 0)

  // 图片 key 先收集（清表后就查不到了）：收集 / 排除任何一步抛错就跳过图片清理
  // ——站点照常清空，宁少删不错删
  let imageKeys: string[] = []
  try {
    const candidates = await collectBundleImageKeys(db)
    const keep = await preservedImageKeys(db, candidates)
    imageKeys = candidates.filter((k) => !keep.has(k))
  } catch {
    imageKeys = []
  }

  // 逐表 DELETE（与 startBundleImport 同一份清单）：D1 没有跨语句事务，中途失败会当场抛错，
  // 后台提示重试即可——本操作幂等，再清一次没有副作用。
  await db.batch(BUNDLE_CLEAR_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)))
  await setBundleImportState(db, { state: 'idle', key: '', at: Date.now() })
  await purgePageCache(db)

  let images = 0
  let imagesDone = true
  try {
    for (let i = 0; i < imageKeys.length; i += R2_DELETE_BATCH) {
      const batch = imageKeys.slice(i, i + R2_DELETE_BATCH)
      await env.IMAGES.delete(batch)
      images += batch.length
    }
  } catch {
    imagesDone = false
  }
  return { cleared, total, images, imagesDone }
}

/* ---------------- 导出（A 档） ---------------- */

/** 表列清单（PRAGMA；查不到返回 null，调用方跳过比对） */
async function bundleTableColumns(db: D1Database, table: string): Promise<string[] | null> {
  try {
    const cols = await tableColumns(db, table)
    return cols.size ? [...cols] : null
  } catch {
    return null
  }
}

/** 按 rowid 分页扫一张表（keyset，rowid > last）：避免把整表（含正文）一次性读进内存。
 *  行数上限由调用方自己数（导出走 TABLE_ROW_LIMIT，图片收集不设上限）。 */
async function scanRows<T extends Record<string, unknown>>(
  db: D1Database,
  table: string,
  cols: string,
  cb: (row: T) => void | Promise<void>
): Promise<void> {
  let last = -1
  for (;;) {
    const { results } = await db
      .prepare(`SELECT rowid AS _rid, ${cols} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(last, DB_PAGE_ROWS)
      .all<T & { _rid: number }>()
    const rows = results ?? []
    if (!rows.length) return
    for (const r of rows) {
      last = Number(r._rid)
      await cb(r)
    }
    if (rows.length < DB_PAGE_ROWS) return
  }
}

/** 要打进包的图片 key：媒体库（uploads 全量）∪ 正文/封面/微博引用（防 uploads 行缺失漏图）。
 *  逐页扫（正文可能很大），只留 key 集合——集合大小受图片总数约束，与正文体量无关。 */
export async function collectBundleImageKeys(db: D1Database): Promise<string[]> {
  const keys = new Set<string>()
  await scanRows<{ key: string }>(db, 'uploads', 'key', (r) => {
    if (isBundleImageKey(r.key)) keys.add(r.key)
  })

  await scanRows<{ content: string; cover: string }>(db, 'posts', 'content, cover', (p) => {
    for (const k of collectImageKeysFromHtml(p.content || '')) keys.add(k)
    const c = keyOf(p.cover || '')
    if (c) keys.add(c)
  })
  await scanRows<{ content: string }>(db, 'pages', 'content', (p) => {
    for (const k of collectImageKeysFromHtml(p.content || '')) keys.add(k)
  })

  await scanRows<{ images: string; video: string }>(db, 'weibo', 'images, video', (w) => {
    try {
      for (const src of JSON.parse(w.images || '[]') as string[]) {
        const k = keyOf(src)
        if (k) keys.add(k)
      }
    } catch {
      /* images 列损坏就跳过这条微博的图 */
    }
    try {
      const v = JSON.parse(w.video || 'null') as { url?: string; poster?: string } | null
      for (const src of [v?.url, v?.poster]) {
        const k = src ? keyOf(src) : null
        if (k) keys.add(k)
      }
    } catch {
      /* video 列损坏同样跳过 */
    }
  })
  return [...keys]
}

/** 组装整站包（流式；内存有界：表按字节切片、图片逐张从 R2 流入 zip） */
export async function buildBundleStream(env: Env, now: number): Promise<ReadableStream<Uint8Array>> {
  const db = env.DB
  const stream = new TransformStream<Uint8Array>()
  const zip = new ZipWriter(stream.writable.getWriter())

  const pump = (async () => {
    try {
      const manifest: BundleManifest = {
        format: BUNDLE_FORMAT,
        app: 'xwblog',
        appVersion: APP_VERSION,
        exportedAt: now,
        tables: [],
        images: { count: 0, bytes: 0 },
        missingImages: [],
        truncated: [],
      }

      for (const table of BUNDLE_TABLES) {
        const columns = await bundleTableColumns(db, table)
        let part = 0
        let total = 0
        let buf: string[] = []
        let bufBytes = 0
        const flush = async () => {
          if (!buf.length) return
          await zip.add(`tables/${table}.${part}.json`, ENC.encode('[' + buf.join(',') + ']'), now)
          part++
          buf = []
          bufBytes = 0
        }

        if (table === 'settings') {
          // settings 按 key 过滤（密钥与实例态键不进包）
          const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
          for (const r of results ?? []) {
            if (BUNDLE_SETTINGS_SKIP.includes(r.key)) continue
            const js = JSON.stringify(r)
            buf.push(js)
            bufBytes += js.length
            total++
            if (bufBytes >= PART_TARGET_BYTES) await flush()
          }
          await flush()
        } else {
          let lastRowid = -1
          for (;;) {
            const { results } = await db
              .prepare(`SELECT rowid AS _rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
              .bind(lastRowid, DB_PAGE_ROWS)
              .all<Record<string, unknown>>()
            const rows = results ?? []
            if (!rows.length) break
            for (const row of rows) {
              lastRowid = Number(row._rid)
              delete row._rid
              const js = JSON.stringify(row)
              buf.push(js)
              bufBytes += js.length
              total++
              if (bufBytes >= PART_TARGET_BYTES) await flush()
            }
            if (rows.length < DB_PAGE_ROWS) break
            if (total >= TABLE_ROW_LIMIT) {
              // 触到单表上限：再探一行确认「确实还有数据」才记 truncated（刚好 100000 行不该报警）
              const more = await db
                .prepare(`SELECT 1 AS x FROM ${table} WHERE rowid > ? LIMIT 1`)
                .bind(lastRowid)
                .first<{ x: number }>()
              if (more) manifest.truncated.push(`${table}(${total})`)
              break
            }
          }
          await flush()
        }
        manifest.tables.push({ name: table, rows: total, columns: columns ?? [], parts: part })
      }

      // 图片：R2 逐张流式打进 zip（store 模式不压缩，边流边算 CRC），缺失记入 manifest
      const imageKeys = await collectBundleImageKeys(db)
      for (const key of imageKeys) {
        const obj = await env.IMAGES.get(key)
        if (!obj) {
          manifest.missingImages.push(key)
          continue
        }
        await zip.add(`images/${key}`, obj.body, obj.uploaded?.getTime?.() ?? now)
        manifest.images.count++
        manifest.images.bytes += obj.size ?? 0
      }

      await zip.add('manifest.json', ENC.encode(JSON.stringify(manifest, null, 2)), now)
      await zip.close()
    } catch (e) {
      // 生成中途失败：中断流让下载端明确失败，而不是挂住等超时
      await zip.abort()
      throw e
    }
  })()
  // 导出是 GET 流式响应，pump 与响应体同生命周期；waitUntil 兜住调用方提前断开时的异常
  void pump.catch((e) => console.error('整站包生成失败', e))

  return stream.readable
}

/* ---------------- 导入（B 档） ---------------- */

interface BundleArchive {
  src: ZipSource
  entries: ZipEntryMeta[]
  manifest: BundleManifest
}

/** 打开包：head 取体积 → 读中央目录 → 读 manifest。任何异常都归成「包不可用」的明确文案 */
async function openBundle(env: Env, key: string): Promise<BundleResult<BundleArchive>> {
  if (!key || !key.startsWith(BUNDLE_PREFIX) || key.includes('..') || key.includes('\\') || key.includes('\0')) {
    return { ok: false, error: '包标识非法', status: 400 }
  }
  const head = await env.IMAGES.head(key)
  if (!head) return { ok: false, error: '找不到这个整站包（可能已被删除）', status: 404 }
  if (head.size > BUNDLE_MAX_BYTES) return { ok: false, error: '整站包超出体积上限（2GB），无法导入', status: 400 }
  const src = r2ZipSource(env.IMAGES, key, head.size)
  let entries: ZipEntryMeta[]
  try {
    entries = await readZipIndex(src)
  } catch (e) {
    return { ok: false, error: '整站包无法解析：' + (e instanceof Error ? e.message : '未知错误'), status: 400 }
  }
  const me = zipFind(entries, 'manifest.json')
  if (!me) return { ok: false, error: '整站包缺少 manifest.json（不是本系统导出的包）', status: 400 }
  let parsed: unknown
  try {
    parsed = JSON.parse(DEC.decode(await readZipEntry(src, me)))
  } catch {
    return { ok: false, error: '整站包 manifest.json 解析失败（包已损坏）', status: 400 }
  }
  const m = parseBundleManifest(parsed)
  if (!m.ok) return m
  return { ok: true, value: { src, entries, manifest: m.value } }
}

/** 空站判定（返回「挡路的活内容」描述，空串 = 可以导入）。
 *  口径 = 三表**未删除**的行数全为 0，不是「一行都没有」——理由见函数内注释（新站自带种子）。
 *  为什么 failed 残留不会变成「覆盖有内容站点」的口子：failed 只能由 markBundleImportFailed 写入，
 *  而它只把 state==='running' 的会话标失败；running 只能由 startBundleImport 写入，而 start 要求空站。
 *  也就是说 —— 存在 failed 残留时，站里那些行**全部是上次自己灌了一半的**，清掉重来正是用户要的。 */
async function importBlocker(db: D1Database): Promise<string> {
  // 上次导入失败留下的残留放行（重试 = 重来），理由见 markBundleImportFailed
  const st = await getBundleImportState(db)
  if (st.state === 'failed') return ''
  // 口径是「没有未删除的内容」而不是「一行都没有」：全新装好的站必然自带两条种子——
  // 欢迎示例文章（/api/auth/setup 的 seedWelcomePost）与「关于我」页面（ensureSchema 的 pagesSeeded）。
  // 若按「一行都没有」判定，换服务器时的**主用例**（新实例导入）永远用不了：
  // 刚装好就被自己拦下（2026-10-16 端到端实测发现）。所以站长把这两条种子删进回收站即可导入；
  // 导入本身会清空全站（含回收站），回收站里的旧内容不会成为漏网的数据损失。
  const c = await db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS p,' +
        ' (SELECT COUNT(*) FROM weibo WHERE deleted_at IS NULL) AS w,' +
        ' (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS g'
    )
    .first<{ p: number; w: number; g: number }>()
  const p = Number(c?.p ?? 0)
  const w = Number(c?.w ?? 0)
  const g = Number(c?.g ?? 0)
  if (!p && !w && !g) return ''
  const parts: string[] = []
  if (p) parts.push(`${p} 篇文章`)
  if (w) parts.push(`${w} 条微博`)
  if (g) parts.push(`${g} 个页面`)
  return parts.join(' / ')
}

/**
 * 导入第一步：校验包 → 校验版本 → 校验空站 → 清空目标表 → 置状态 running，并给出步骤清单。
 * 清空放在这里（已确认是空站，清空无害），使「重试 = 重来」，不会出现灌一半的烂摊子。
 */
export async function startBundleImport(env: Env, key: string): Promise<BundleResult<BundlePlan>> {
  const db = env.DB
  const opened = await openBundle(env, key)
  if (!opened.ok) return opened
  const { entries, manifest } = opened.value

  // 版本判据（C3）：包里出现当前没有的表/列 = 降版 → 拒绝
  const cols = new Map<string, Set<string>>()
  let colsKnown = true
  for (const t of BUNDLE_TABLES) {
    const c = await bundleTableColumns(db, t)
    if (!c) {
      colsKnown = false
      break
    }
    cols.set(t, new Set(c))
  }
  const compatError = checkBundleCompat(manifest, colsKnown ? cols : null)
  if (compatError) return { ok: false, error: compatError, status: 400 }

  // 步骤清单引用的表分片必须都在包里（缺一片就整包拒，别灌到一半才发现）
  for (const t of manifest.tables) {
    for (let p = 0; p < t.parts; p++) {
      if (!zipFind(entries, `tables/${t.name}.${p}.json`)) {
        return { ok: false, error: `整站包不完整（缺少 tables/${t.name}.${p}.json）`, status: 400 }
      }
    }
  }

  const blocker = await importBlocker(db)
  if (blocker) {
    return {
      ok: false,
      error: `本站还有 ${blocker}，导入只允许还原到「没有内容的站」。若是刚装好的新站，把自带的「示例文章」与「关于我」页面删除（移入回收站）即可；老站整体换新，先用下方「清空本站内容」把本站清空。导入会清空全站内容（含回收站）`,
      status: 400,
    }
  }

  // 清空目标表（settings 除外：密钥/实例态键要保留，包里带来的键随后 upsert）
  await db.batch(BUNDLE_CLEAR_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)))
  await invalidateSharedSettings(db)

  const steps: BundleStep[] = []
  for (const t of manifest.tables) for (let p = 0; p < t.parts; p++) steps.push({ unit: t.name, cursor: p })
  const imageCount = entries.filter((e) => e.name.startsWith('images/')).length
  for (let i = 0; i < Math.ceil(imageCount / IMAGE_BATCH); i++) steps.push({ unit: 'images', cursor: i })

  await setBundleImportState(db, { state: 'running', key, at: Date.now() })

  return {
    ok: true,
    value: { key, bytes: opened.value.src.size, manifest, steps },
  }
}

/** 多行 INSERT（受单条 SQL 变量上限约束，按行数切句、按条数切批）。
 *  `settings` 是唯一**不清空**的表（密钥 / 实例态键必须留住），所以它必须走 **upsert**——
 *  目标站自己已有的同名键（siteName / onboarding / pagesSeeded…）会与包里的键撞 UNIQUE(key)，
 *  裸 INSERT 直接 500（2026-10-16 端到端实测踩到）。其余表在 start 时已清空，裸 INSERT 即可。 */
async function insertRows(db: D1Database, table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) return 0
  const cols = Object.keys(rows[0])
  if (!cols.length) return 0
  const per = rowsPerStatement(cols.length)
  const tuple = '(' + cols.map(() => '?').join(',') + ')'
  const upsert =
    table === 'settings' && cols.includes('key') && cols.includes('value')
      ? ' ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      : ''
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const binds: (string | number | null)[] = []
    for (const r of chunk) for (const c of cols) binds.push(normalizeBindValue(r[c]))
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ` + chunk.map(() => tuple).join(',') + upsert
    stmts.push(db.prepare(sql).bind(...binds))
  }
  for (let i = 0; i < stmts.length; i += BATCH_STMTS) await db.batch(stmts.slice(i, i + BATCH_STMTS))
  return rows.length
}

/** 导入一个步骤：一张表的一个分片，或一批图片 */
export async function runBundleImportStep(
  env: Env,
  key: string,
  unit: string,
  cursor: number
): Promise<BundleResult<{ rows: number; images: number }>> {
  const db = env.DB
  if (!Number.isInteger(cursor) || cursor < 0) return { ok: false, error: '步骤参数非法', status: 400 }
  // 必须先 start（会话在场且 key 对得上）：否则直接调 step 就能绕开「只还原到空站」往有内容的站里灌
  const session = await getBundleImportState(db)
  if (session.state !== 'running' || session.key !== key) {
    return { ok: false, error: '导入会话不存在或已结束，请重新开始导入', status: 400 }
  }
  const opened = await openBundle(env, key)
  if (!opened.ok) return opened
  const { src, entries, manifest } = opened.value

  if (unit === 'images') {
    const names = entries.filter((e) => e.name.startsWith('images/'))
    const slice = names.slice(cursor * IMAGE_BATCH, (cursor + 1) * IMAGE_BATCH)
    let n = 0
    for (const e of slice) {
      const imgKey = e.name.slice('images/'.length)
      if (!isBundleImageKey(imgKey)) continue
      await env.IMAGES.put(imgKey, await zipEntryStream(src, e))
      n++
    }
    return { ok: true, value: { rows: 0, images: n } }
  }

  const known = manifest.tables.find((t) => t.name === unit)
  if (!known) return { ok: false, error: `整站包里没有数据表「${unit}」`, status: 400 }
  const entry = zipFind(entries, `tables/${unit}.${cursor}.json`)
  if (!entry) return { ok: false, error: `整站包不完整（缺少 tables/${unit}.${cursor}.json）`, status: 400 }
  let parsed: unknown
  try {
    parsed = JSON.parse(DEC.decode(await readZipEntry(src, entry)))
  } catch {
    return { ok: false, error: `数据表「${unit}」第 ${cursor} 片解析失败（包已损坏）`, status: 400 }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: `数据表「${unit}」第 ${cursor} 片结构非法`, status: 400 }

  let rows = (parsed as Record<string, unknown>[]).filter((r) => r && typeof r === 'object')
  if (unit === 'settings') {
    rows = rows.filter((r) => typeof r.key === 'string' && !BUNDLE_SETTINGS_SKIP.includes(r.key))
  } else {
    rows = rows.map((r) => sanitizeImportedRow(unit, r))
  }
  const n = await insertRows(db, unit, rows)
  // settings 变了要清共享快照（否则最多 60s 读旧值）
  if (unit === 'settings') await invalidateSharedSettings(db)
  return { ok: true, value: { rows: n, images: 0 } }
}

/** 导入收尾：置状态 done + 清页缓存（FTS 由触发器随 INSERT 自动建索引，无需 rebuild）。
 *  必须是「正在进行的这次导入」才允许收尾——中途失败（state=failed）时不许直接 finish 把
 *  半成品标成 done，用户要重新 start（重来语义）。 */
export async function finishBundleImport(env: Env, key: string): Promise<BundleResult<{ state: BundleImportState }>> {
  const db = env.DB
  const st = await getBundleImportState(db)
  if (st.state !== 'running' || st.key !== key) {
    return { ok: false, error: '导入会话不存在或已结束，请重新开始导入', status: 400 }
  }
  await setBundleImportState(db, { state: 'done', key, at: Date.now() })
  await purgePageCache(db)
  await invalidateSharedSettings(db)
  return { ok: true, value: { state: await getBundleImportState(db) } }
}

/** 步骤失败时记一笔（前端据此提示「重试 = 重来」）。
 *  **只允许把「正在进行的这次导入」标成失败**——`importBlocker` 对 failed 残留放行（重试 = 重来），
 *  所以「done → failed」若可被一次杂散调用翻过去，就等于给出「覆盖有内容站点」的口子。
 *  反过来 failed 残留是安全的：要到达 failed 必须先 running，而 running 只可能从空站开始。 */
export async function markBundleImportFailed(env: Env, key: string, error: string): Promise<void> {
  const st = await getBundleImportState(env.DB)
  if (st.state !== 'running' || st.key !== key) return
  await setBundleImportState(env.DB, { state: 'failed', key, at: Date.now(), error: error.slice(0, 500) })
}
