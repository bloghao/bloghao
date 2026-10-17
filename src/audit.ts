import { sha256Hex } from './utils'
import type { Env } from './types'

/* ---------------- 媒体体检（后台「媒体 → 体检」的服务端逻辑） ----------------
 * 独立成模块是为了 Node 测试能直接导入（与 closed.ts / hooks.ts 同理）。三个能力：
 *  1. 未引用扫描：uploads 全量 key 与库内全部引用源比对，差集即「站内无引用」；
 *  2. 重复检测：按内容 SHA-256 指纹分组（新上传在 saveUpload 时写入，存量走 backfillHashes 回填）；
 *  3. 安全清理 / 合并：执行前重新校验引用（防「体检完又改了文章」的时间差），合并先把引用
 *     改写到保留项再删文件，前台内容始终有图可用。
 *
 * 引用源清单（新增存图片地址的字段时必须同步 pullReferenceTexts）：
 *   posts.content（含 <meta data-og-image>）与 posts.cover、pages.content、weibo.images、
 *   weibo.video（视频地址与封面帧，B19）、
 *   users.avatar、friend_links.icon、settings.value（favicon/头像/OG 默认图）、tg_buffer（待合并的 TG 相册）。
 *   评论正文是纯文本不存 HTML，不构成引用源。
 */

/** 媒体库可管理的目录前缀：与 /images 路由、DELETE /admin/uploads 的白名单同口径 */
export function isMediaKey(key: string): boolean {
  return key.startsWith('u/') || key.startsWith('og/')
}

export interface UploadRow {
  id: number
  key: string
  name: string
  mime: string
  size: number
  created_at: number
  hash: string
}

export interface AuditItem {
  key: string
  name: string
  mime: string
  size: number
  created_at: number
  /** 仅报告里的条目带：当前是否被站内引用（未引用列表恒为 false） */
  referenced?: boolean
}

/** 「图床里已不存在、只剩库记录」的失踪文件哨兵（回填时写入，永不与真实指纹混淆） */
export const HASH_MISSING = 'missing'
/** 真实指纹是 64 位十六进制 SHA-256，重复分组只认这种形态 */
const HEX64 = /^[0-9a-f]{64}$/

/** 库内引用媒体的统一形态是 /images/<key>（外链绝对 URL 也含这一段）。
 *  线性扫一遍把候选串抠出来，再对 key 全集做精确命中——不做子串包含判断，
 *  天然规避两个 key 互为前缀的误判。候选字符集收紧到 key 的真实形态
 *  （saveUpload 生成的 key 只含 [a-z0-9/._-]）：中文等非 URL 字符与 &、引号
 *  相邻时自然截断（「见图/images/u/a.jpg即可」、HTML 属性结尾 &amp; 都不会把
 *  尾巴吸进候选串造成漏识别），?query/#hash 与中英文尾随标点再兜底剥一层 */
export function collectReferencedKeys(keys: string[], texts: readonly string[]): Set<string> {
  const candidates = new Set(keys)
  const found = new Set<string>()
  if (!candidates.size) return found
  const re = /\/images\/[\w./-]+/g
  for (const text of texts) {
    if (!text || !text.includes('/images/')) continue
    for (const m of text.matchAll(re)) {
      const key = m[0]
        .replace(/[.,;:!?'")\]}>、，。！？；：」』）】]+$/, '')
        .split(/[?#&]/)[0]
        .slice('/images/'.length)
      if (candidates.has(key)) found.add(key)
    }
  }
  return found
}

export interface DupGroup {
  hash: string
  items: UploadRow[]
  /** 冗余体积：同内容副本里多出来的 n-1 份 */
  wasteBytes: number
}

/** 按内容指纹分组找重复：只认 64 位十六进制指纹，''（未回填）与 missing（失踪）不参与 */
export function groupDuplicates(uploads: UploadRow[]): DupGroup[] {
  const byHash = new Map<string, UploadRow[]>()
  for (const u of uploads) {
    if (!HEX64.test(u.hash)) continue
    const list = byHash.get(u.hash)
    if (list) list.push(u)
    else byHash.set(u.hash, [u])
  }
  return [...byHash.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([hash, items]) => ({ hash, items, wasteBytes: (items.length - 1) * (items[0]?.size ?? 0) }))
}

/* ---------------- 引用源拉取 ----------------
 * 大字段（posts/pages 正文、weibo 配图）按字节预算分桶查询：单条查询的响应体积可控，
 * 也不至于把整库正文拉进内存；含图行先用 LIKE 预筛，纯文字文章不进候选。
 * 桶大小对齐 D1 单语句 100 个绑定变量的上限（每桶 ≤ 50 个 id）。 */

/** 单条查询响应的保守字节预算（正文单篇上限 1MB，超预算的大行会独占一条查询） */
const QUERY_BYTE_BUDGET = 700_000
/** db.batch 单批语句数上限（保守分片，防子请求超限） */
const BATCH_CHUNK = 25

/** table/column 只来自本文件字面量，无注入面 */
async function bucketedColumnScan(db: D1Database, table: string, column: string): Promise<string[]> {
  const probe = await db
    .prepare(`SELECT id, length(CAST(${column} AS BLOB)) AS len FROM ${table} WHERE ${column} LIKE '%/images/%'`)
    .all<{ id: number; len: number }>()
  const buckets: number[][] = []
  let cur: number[] = []
  let bytes = 0
  for (const r of probe.results ?? []) {
    const len = r.len || 0
    if (cur.length && (bytes + len > QUERY_BYTE_BUDGET || cur.length >= 50)) {
      buckets.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(r.id)
    bytes += len
  }
  if (cur.length) buckets.push(cur)

  const texts: string[] = []
  for (let i = 0; i < buckets.length; i += BATCH_CHUNK) {
    const res = await db.batch(
      buckets.slice(i, i + BATCH_CHUNK).map((ids) => {
        const ph = ids.map(() => '?').join(',')
        return db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id IN (${ph})`).bind(...ids)
      })
    )
    for (const r of res) for (const row of (r.results ?? []) as { v: string }[]) if (row.v) texts.push(row.v)
  }
  return texts
}

/** 小字段一次批查拿全：行数与单值体积都被产品设计封顶（用户表个位数、友链 ≤500、设置 ≤50 条） */
async function pullReferenceTexts(db: D1Database): Promise<string[]> {
  const texts: string[] = []
  for (const [table, column] of [
    ['posts', 'content'],
    ['pages', 'content'],
    ['weibo', 'images'],
    // 视频列存 JSON（url + poster 都是 /images/ 地址）：不进引用源会被体检误判为「未被引用」（B19）
    ['weibo', 'video'],
  ] as const) {
    texts.push(...(await bucketedColumnScan(db, table, column)))
  }
  const small = await db.batch([
    db.prepare("SELECT cover AS v FROM posts WHERE cover LIKE '%/images/%' LIMIT 20000"),
    db.prepare("SELECT avatar AS v FROM users WHERE avatar LIKE '%/images/%'"),
    db.prepare("SELECT icon AS v FROM friend_links WHERE icon LIKE '%/images/%' LIMIT 20000"),
    db.prepare("SELECT value AS v FROM settings WHERE value LIKE '%/images/%'"),
    db.prepare("SELECT content AS v FROM tg_buffer WHERE content LIKE '%/images/%'"),
    db.prepare("SELECT images AS v FROM tg_buffer WHERE images LIKE '%/images/%'"),
  ])
  for (const r of small) for (const row of (r.results ?? []) as { v: string }[]) if (row.v) texts.push(row.v)
  return texts
}

/** 对给定 key 集合做一次引用判定（审计全量扫、清理/合并执行前复验共用同一口径） */
async function scanReferencedKeys(env: Env, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set()
  return collectReferencedKeys(keys, await pullReferenceTexts(env.DB))
}

/* ---------------- 体检报告 ---------------- */

export interface AuditReport {
  scanned: number
  /** 指纹尚未回填的数量（>0 时前端先跑回填再重扫） */
  missingHash: number
  unreferenced: AuditItem[]
  unreferencedBytes: number
  duplicateGroups: { hash: string; items: AuditItem[]; wasteBytes: number }[]
  duplicateBytes: number
  /** 图床里已不存在、只剩库记录的失踪文件（多半是手动清过 R2） */
  ghosts: AuditItem[]
}

export async function runAudit(env: Env): Promise<AuditReport> {
  const { results } = await env.DB.prepare(
    'SELECT id, key, name, mime, size, created_at, hash FROM uploads ORDER BY created_at DESC'
  ).all<UploadRow>()
  const uploads = results ?? []
  const referenced = await scanReferencedKeys(
    env,
    uploads.map((u) => u.key)
  )

  const unreferenced: AuditItem[] = []
  const ghosts: AuditItem[] = []
  let missingHash = 0
  for (const u of uploads) {
    const item: AuditItem = { key: u.key, name: u.name, mime: u.mime, size: u.size, created_at: u.created_at }
    if (u.hash === HASH_MISSING) {
      // 失踪文件单独呈现：对象已 404，引用它的正文本来就是死链，与「未引用」分开处置
      ghosts.push({ ...item, referenced: referenced.has(u.key) })
      continue
    }
    if (!u.hash) missingHash++
    if (!referenced.has(u.key)) unreferenced.push(item)
  }

  const duplicateGroups = groupDuplicates(uploads).map((g) => ({
    hash: g.hash,
    wasteBytes: g.wasteBytes,
    items: g.items.map((u) => ({ key: u.key, name: u.name, mime: u.mime, size: u.size, created_at: u.created_at, referenced: referenced.has(u.key) })),
  }))
  return {
    scanned: uploads.length,
    missingHash,
    unreferenced,
    unreferencedBytes: unreferenced.reduce((s, u) => s + u.size, 0),
    duplicateGroups,
    duplicateBytes: duplicateGroups.reduce((s, g) => s + g.wasteBytes, 0),
    ghosts,
  }
}

/* ---------------- 指纹回填 ---------------- */

export interface BackfillResult {
  /** 本轮真正算出指纹的数量（失踪文件不计入） */
  processed: number
  /** 本轮发现图床里已不存在的数量（写入 HASH_MISSING 哨兵，下次不再重复读） */
  missing: number
  /** 还剩多少未定指纹（0 = 回填完成） */
  remaining: number
}

/** 增量回填一批指纹：每轮读 ≤ limit 个 R2 对象（Workers 子请求预算内），前端循环到 remaining=0 */
export async function backfillHashes(env: Env, limit = 25): Promise<BackfillResult> {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 25))
  const { results } = await env.DB.prepare("SELECT key FROM uploads WHERE hash = '' LIMIT ?")
    .bind(n)
    .all<{ key: string }>()
  const rows = results ?? []
  if (!rows.length) return { processed: 0, missing: 0, remaining: 0 }

  const stmts: D1PreparedStatement[] = []
  let missing = 0
  for (const r of rows) {
    const obj = await env.IMAGES.get(r.key)
    if (!obj) {
      missing++
      stmts.push(env.DB.prepare('UPDATE uploads SET hash = ? WHERE key = ?').bind(HASH_MISSING, r.key))
      continue
    }
    stmts.push(env.DB.prepare('UPDATE uploads SET hash = ? WHERE key = ?').bind(await sha256Hex(await obj.arrayBuffer()), r.key))
  }
  await env.DB.batch(stmts)
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE hash = ''").first<{ n: number }>()
  return { processed: rows.length - missing, missing, remaining: left?.n ?? 0 }
}

/* ---------------- 合并重复 ---------------- */

export interface MergeResult {
  /** 被改写的引用处数（跨所有表的行数合计） */
  updated: number
  freedBytes: number
  /** 被合并删除的 key（调用方据此清图床边缘缓存，审计 F2） */
  removed: string[]
}

const REF_TABLES: [table: string, cols: string[]][] = [
  ['posts', ['content', 'cover']],
  ['pages', ['content']],
  ['weibo', ['images']],
  ['users', ['avatar']],
  ['friend_links', ['icon']],
  ['settings', ['value']],
  ['tg_buffer', ['content', 'images']],
]

/** 把 remove 组的引用改写到 keep 并删除 remove。
 *  安全闸：所有 key 必须是媒体库可管理的目录、必须真实存在、内容指纹必须完全一致——
 *  指纹未回填或不一致一律拒绝，宁可让用户重扫也不能改错内容 */
export async function mergeDuplicate(env: Env, keep: string, remove: string[]): Promise<MergeResult> {
  const rm = [...new Set(remove.map(String))]
  if (!isMediaKey(keep) || !rm.length || rm.length > 20 || rm.includes(keep) || rm.some((k) => !isMediaKey(k))) {
    throw new Error('非法的文件 Key')
  }
  const ph = [...rm, keep].map(() => '?').join(',')
  const { results } = await env.DB
    .prepare(`SELECT key, hash, size FROM uploads WHERE key IN (${ph})`)
    .bind(...rm, keep)
    .all<{ key: string; hash: string; size: number }>()
  const byKey = new Map((results ?? []).map((r) => [r.key, r]))
  const keepRow = byKey.get(keep)
  if (!keepRow) throw new Error('要保留的文件不存在，请重新体检')
  if (rm.some((k) => !byKey.has(k))) throw new Error('部分文件不存在，请重新体检')
  if (!HEX64.test(keepRow.hash) || rm.some((k) => byKey.get(k)!.hash !== keepRow.hash)) {
    throw new Error('文件内容指纹不一致或尚未计算，请重新体检后再合并')
  }

  // 引用改写：/images/<rm> → /images/<keep>。needle 是完整 key（时间戳+随机串），
  // 不存在互为前缀的 key，REPLACE 字面替换不会误伤；绝对 URL 同样命中这一子串
  const stmts: D1PreparedStatement[] = []
  for (const k of rm) {
    const from = `/images/${k}`
    const to = `/images/${keep}`
    for (const [table, cols] of REF_TABLES) {
      const sets = cols.map((c) => `${c} = REPLACE(${c}, ?, ?)`).join(', ')
      const conds = cols.map((c) => `instr(${c}, ?) > 0`).join(' OR ')
      // 占位符 3n 个：每列 SET 两个（from/to）+ WHERE 每列一个（from）
      stmts.push(env.DB.prepare(`UPDATE ${table} SET ${sets} WHERE ${conds}`).bind(...cols.flatMap(() => [from, to]), ...cols.map(() => from)))
    }
  }
  let updated = 0
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
    const res = await env.DB.batch(stmts.slice(i, i + BATCH_CHUNK))
    for (const r of res) updated += r.meta.changes || 0
  }

  await env.IMAGES.delete(rm)
  await env.DB.prepare(`DELETE FROM uploads WHERE key IN (${rm.map(() => '?').join(',')})`)
    .bind(...rm)
    .run()
  return { updated, freedBytes: keepRow.size * rm.length, removed: rm }
}

/* ---------------- 清理未引用 ---------------- */

export interface CleanupResult {
  deleted: number
  freedBytes: number
  /** 执行时发现已被内容引用而保留下来的 key（体检与清理之间内容可能变过） */
  blocked: string[]
  /** 真正删除的 key（调用方据此清图床边缘缓存，审计 F2） */
  deletedKeys: string[]
}

/** 删除一批未引用媒体。执行前对这批 key 重新做一遍引用判定：期间新写的文章若用上了
 *  其中某张图，只删其余的，被引用的原样保留并回告（前端提示重新体检） */
export async function cleanupUnreferenced(env: Env, keys: string[]): Promise<CleanupResult> {
  const ks = [...new Set(keys.map(String))]
  if (!ks.length || ks.length > 100 || ks.some((k) => !isMediaKey(k))) throw new Error('非法的文件 Key')

  const referenced = await scanReferencedKeys(env, ks)
  const deletable = ks.filter((k) => !referenced.has(k))
  const blocked = ks.filter((k) => referenced.has(k))
  if (!deletable.length) return { deleted: 0, freedBytes: 0, blocked, deletedKeys: [] }

  const ph = deletable.map(() => '?').join(',')
  const { results } = await env.DB
    .prepare(`SELECT key, size FROM uploads WHERE key IN (${ph})`)
    .bind(...deletable)
    .all<{ key: string; size: number }>()
  const freedBytes = (results ?? []).reduce((s, r) => s + r.size, 0)
  await env.IMAGES.delete(deletable)
  await env.DB.prepare(`DELETE FROM uploads WHERE key IN (${ph})`)
    .bind(...deletable)
    .run()
  return { deleted: deletable.length, freedBytes, blocked, deletedKeys: deletable }
}
