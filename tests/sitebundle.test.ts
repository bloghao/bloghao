import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  BUNDLE_FORMAT,
  BUNDLE_PREFIX,
  BUNDLE_SETTINGS_SKIP,
  BUNDLE_TABLES,
  buildBundleStream,
  bundleFileName,
  checkBundleCompat,
  collectBundleImageKeys,
  finishBundleImport,
  getBundleImportState,
  isBundleImageKey,
  markBundleImportFailed,
  normalizeBindValue,
  parseBundleManifest,
  RESET_CONFIRM_PHRASE,
  resetConfirmOk,
  resetSiteContent,
  rowsPerStatement,
  runBundleImportStep,
  sanitizeImportedRow,
  startBundleImport,
  type BundleManifest,
} from '../src/sitebundle.ts'
import { readZipEntry, readZipIndex, ZipWriter, zipFind, type ZipSource } from '../src/zip.ts'

// ── 整站包（B26：一键导出 / 一键还原到空站）──
// 纯函数直接测；导出→导入的完整往返走 node:sqlite 真 schema + 内存 R2（不依赖 Workers 运行时）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** 极简 D1 适配（同 tests/bots.test.ts） */
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

interface MemoryR2 {
  bucket: R2Bucket
  map: Map<string, Uint8Array>
}

/** 内存 R2：支持 put(字节/流) / get(含 range) / head / delete / list（B26 用到的全部面） */
function memoryR2(): MemoryR2 {
  const map = new Map<string, Uint8Array>()
  const objectOf = (key: string, bytes: Uint8Array, withBody: boolean, range?: { start: number; end: number }) => {
    const slice = range ? bytes.slice(range.start, range.end + 1) : bytes
    return {
      key,
      size: slice.length,
      uploaded: new Date(0),
      httpEtag: '"mem"',
      httpMetadata: {},
      writeHttpMetadata() {
        /* 测试不需要响应头 */
      },
      body: withBody
        ? new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(slice)
              c.close()
            },
          })
        : undefined,
      async arrayBuffer(): Promise<ArrayBuffer> {
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer
      },
      async text(): Promise<string> {
        return DEC.decode(slice)
      },
      async json(): Promise<unknown> {
        return JSON.parse(DEC.decode(slice))
      },
    }
  }
  const bucket = {
    async put(key: string, value: unknown) {
      let bytes: Uint8Array
      if (typeof value === 'string') bytes = ENC.encode(value)
      else if (value instanceof Uint8Array) bytes = value
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
      else if (value && typeof (value as ReadableStream).getReader === 'function') {
        const chunks: Uint8Array[] = []
        const reader = (value as ReadableStream<Uint8Array>).getReader()
        for (;;) {
          const { done, value: v } = await reader.read()
          if (done) break
          if (v?.length) chunks.push(v)
        }
        const total = chunks.reduce((n, c) => n + c.length, 0)
        bytes = new Uint8Array(total)
        let at = 0
        for (const c of chunks) {
          bytes.set(c, at)
          at += c.length
        }
      } else throw new Error('memoryR2.put: 不支持的值类型')
      map.set(key, bytes)
      return { key, size: bytes.length }
    },
    async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
      const bytes = map.get(key)
      if (!bytes) return null
      const r = opts?.range
      if (!r) return objectOf(key, bytes, true)
      const start = typeof r.offset === 'number' ? r.offset : Math.max(0, bytes.length - (r.suffix ?? 0))
      const end = typeof r.length === 'number' ? Math.min(bytes.length - 1, start + r.length - 1) : bytes.length - 1
      if (start < 0 || start > end || start >= bytes.length) return null
      return objectOf(key, bytes, true, { start, end })
    },
    async head(key: string) {
      const bytes = map.get(key)
      return bytes ? objectOf(key, bytes, false) : null
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) map.delete(k)
    },
    async list(opts?: { prefix?: string; limit?: number }) {
      const prefix = opts?.prefix ?? ''
      const objects = [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, opts?.limit ?? 1000)
        .map(([k, v]) => ({ key: k, size: v.length, uploaded: new Date(0) }))
      return { objects, truncated: false }
    },
  }
  return { bucket: bucket as unknown as R2Bucket, map }
}

function freshDb(): { d1: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  return { d1: d1FromSqlite(raw), raw }
}

function envOf(d1: D1Database, images: R2Bucket): { DB: D1Database; IMAGES: R2Bucket } {
  return { DB: d1, IMAGES: images }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** 内存字节 → ZipSource（模拟 R2 range get） */
function bytesSource(bytes: Uint8Array): ZipSource {
  return {
    size: bytes.length,
    async read(start: number, end: number) {
      return bytes.slice(start, Math.min(end, bytes.length))
    },
  }
}

/* ---------------- 纯函数 ---------------- */

test('bundleFileName：固定 ASCII 名 + 北京日期', () => {
  assert.equal(bundleFileName(Date.UTC(2026, 9, 16, 4, 0, 0)), 'xwblog-site-2026-10-16.zip')
  // 北京时间 0-8 点发布/导出的日期不能错位到前一天（与全站时间口径一致）
  assert.equal(bundleFileName(Date.UTC(2026, 9, 15, 17, 30, 0)), 'xwblog-site-2026-10-16.zip')
})

test('isBundleImageKey：只认 u/ 与 og/，穿越字符一律拒', () => {
  assert.equal(isBundleImageKey('u/202601/a.jpg'), true)
  assert.equal(isBundleImageKey('og/202601/a.png'), true)
  for (const k of ['', 'u', 'backups/x.zip', '../u/a.jpg', 'u/../a.jpg', 'u/a\\b.jpg', 'u/a\0b.jpg', 'u//etc/passwd']) {
    assert.equal(isBundleImageKey(k), k === 'u//etc/passwd', k)
  }
})

test('parseBundleManifest：非本系统 / 格式版本不符 / 结构损坏一律拒', () => {
  const ok = { format: BUNDLE_FORMAT, app: 'xwblog', appVersion: '2.5.1', exportedAt: 0, tables: [], images: { count: 0, bytes: 0 } }
  assert.equal(parseBundleManifest(ok).ok, true)
  for (const bad of [null, 'x', 42, {}, { app: 'other', format: 1 }, { app: 'xwblog', format: 99 }, { app: 'xwblog', format: 1, tables: 'x', images: {} }]) {
    assert.equal(parseBundleManifest(bad).ok, false, JSON.stringify(bad))
  }
  const r = parseBundleManifest({ app: 'xwblog', format: 99 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /格式版本不匹配/)
})

test('checkBundleCompat：包里多出的表/列 = 降版，明确拒绝并报出差异', () => {
  const cols = new Map<string, Set<string>>([
    ['posts', new Set(['id', 'title', 'content'])],
  ])
  const base = (tables: BundleManifest['tables']): BundleManifest => ({
    format: BUNDLE_FORMAT,
    app: 'xwblog',
    appVersion: '9.9.9',
    exportedAt: 0,
    tables,
    images: { count: 0, bytes: 0 },
    missingImages: [],
    truncated: [],
  })
  // 同构：通过
  assert.equal(checkBundleCompat(base([{ name: 'posts', rows: 1, columns: ['id', 'title'], parts: 1 }]), cols), null)
  // 包里含当前没有的列：拒绝，且报出列名与两边版本
  const err = checkBundleCompat(base([{ name: 'posts', rows: 1, columns: ['id', 'title', 'brand_new'], parts: 1 }]), cols)
  assert.ok(err)
  assert.match(err!, /brand_new/)
  assert.match(err!, /9\.9\.9/)
  // 包里含当前没有的表：拒绝
  const err2 = checkBundleCompat(base([{ name: 'future_table', rows: 1, columns: ['id'], parts: 1 }]), cols)
  assert.ok(err2)
  assert.match(err2!, /future_table/)
  // 列信息查不到（PRAGMA 失败）时跳过比对，交给 INSERT 报错兜底
  assert.equal(checkBundleCompat(base([{ name: 'posts', rows: 1, columns: ['nope'], parts: 1 }]), null), null)
})

test('normalizeBindValue：JSON 值 → SQLite 绑定值（脏形态不炸导入）', () => {
  assert.equal(normalizeBindValue(null), null)
  assert.equal(normalizeBindValue(undefined), null)
  assert.equal(normalizeBindValue(7), 7)
  assert.equal(normalizeBindValue(NaN), null)
  assert.equal(normalizeBindValue('x'), 'x')
  assert.equal(normalizeBindValue(true), 1)
  assert.equal(normalizeBindValue(false), 0)
  assert.equal(normalizeBindValue({ a: 1 }), '{"a":1}')
})

test('rowsPerStatement：单条 SQL 变量上限 100 内切行', () => {
  assert.equal(rowsPerStatement(10), 10)
  assert.equal(rowsPerStatement(18), 5)
  assert.equal(rowsPerStatement(50), 2)
  assert.equal(rowsPerStatement(200), 1)
  assert.equal(rowsPerStatement(0), 100)
})

test('sanitizeImportedRow：正文过净化，其余字段不动', () => {
  const r = sanitizeImportedRow('posts', { id: 1, content: '<p>ok</p><script>alert(1)</script>', title: 't' })
  assert.equal(r.content, '<p>ok</p>')
  assert.equal(r.title, 't')
  // 非正文表不碰
  const w = sanitizeImportedRow('weibo', { content: '<script>x</script>' })
  assert.equal(w.content, '<script>x</script>')
  // 空正文不炸
  assert.equal(sanitizeImportedRow('pages', { content: '' }).content, '')
})

test('BUNDLE_SETTINGS_SKIP：密钥与实例态键一律不进包', () => {
  for (const k of ['externalToken', 'telegramBotToken', 'telegramWebhookSecret', 'bufferAccessToken', 'plazaToken', 'commentWebhookUrl', 'turnstileSecret']) {
    assert.ok(BUNDLE_SETTINGS_SKIP.includes(k), k)
  }
  for (const k of ['siteUrl', 'pageCacheEpoch', 'bundleImport']) assert.ok(BUNDLE_SETTINGS_SKIP.includes(k), k)
  // users 是实例身份，不进包（备份表清单里有它，整站包故意去掉）
  assert.equal((BUNDLE_TABLES as readonly string[]).includes('users'), false)
  assert.equal((BUNDLE_TABLES as readonly string[]).includes('settings'), true)
})

/* ---------------- ZIP 读取器（与写入器往返） ---------------- */

test('zip 读取器：写入器产出的包能完整读回（store 模式 + 中文名 + 流式条目）', async () => {
  const stream = new TransformStream<Uint8Array>()
  const zip = new ZipWriter(stream.writable.getWriter())
  // 必须并发消费可读端：TransformStream 写端高水位为 1，只写不读会死锁（生产路径由响应体边流边读）
  const drained = drain(stream.readable)
  await zip.add('manifest.json', ENC.encode('{"a":1}'), 0)
  await zip.add('tables/posts.0.json', ENC.encode('[{"标题":"中文"}]'), 0)
  const big = new Uint8Array(300_000).fill(7)
  await zip.add(
    'images/u/202601/a.bin',
    new ReadableStream<Uint8Array>({
      start(c) {
        // 分块流出，验证 Range 读取能跨块拼回
        for (let i = 0; i < big.length; i += 70_000) c.enqueue(big.slice(i, i + 70_000))
        c.close()
      },
    }),
    0
  )
  await zip.close()
  const bytes = await drained

  const src = bytesSource(bytes)
  const entries = await readZipIndex(src)
  assert.deepEqual(
    entries.map((e) => e.name),
    ['manifest.json', 'tables/posts.0.json', 'images/u/202601/a.bin']
  )
  const mf = zipFind(entries, 'manifest.json')
  assert.ok(mf)
  assert.equal(DEC.decode(await readZipEntry(src, mf!)), '{"a":1}')
  const tp = zipFind(entries, 'tables/posts.0.json')
  assert.ok(tp)
  assert.equal(DEC.decode(await readZipEntry(src, tp!)), '[{"标题":"中文"}]')
  const img = zipFind(entries, 'images/u/202601/a.bin')
  assert.ok(img)
  assert.equal(img!.size, big.length)
  const back = await readZipEntry(src, img!)
  assert.equal(back.length, big.length)
  assert.equal(back[0], 7)
  assert.equal(back[back.length - 1], 7)
})

test('zip 读取器：非 zip 字节 / 缺 EOCD 一律明确报错', async () => {
  await assert.rejects(() => readZipIndex(bytesSource(ENC.encode('not a zip at all, really'))), /不是有效的 zip 包/)
})

/* ---------------- 导出 → 导入 完整往返 ---------------- */

/** 造一个有内容的源站：文章 / 页面 / 微博 / 评论 / 分类 / 标签 / 图床 / 会员 / settings */
function seedSource(db: DatabaseSync): void {
  const now = 1_800_000_000_000
  db.exec(`
    INSERT INTO posts (id, slug, title, summary, content, cover, status, created_at, updated_at, published_at, tags, views, likes)
      VALUES (1, 'hello', '你好', '摘要', '<p>正文<img src="/images/u/202601/a.jpg"></p><script>alert(1)</script>', '/images/u/202601/a.jpg', 'published', ${now}, ${now}, ${now}, '["标签一"]', 3, 1);
    INSERT INTO pages (id, slug, title, content, status, created_at, updated_at)
      VALUES (1, 'about', '关于', '<p>关于我</p>', 'published', ${now}, ${now});
    INSERT INTO weibo (id, content, images, status, created_at, updated_at, likes, topics)
      VALUES (1, '一条微博', '["/images/og/202601/b.png"]', 'published', ${now}, ${now}, 0, '[]');
    INSERT INTO comments (id, post_id, nickname, email, content, status, created_at)
      VALUES (1, 1, '访客', 'a@b.c', '评论内容', 'approved', ${now});
    INSERT INTO categories (id, slug, name, description, created_at) VALUES (1, 'cat', '分类', '分类描述', ${now});
    INSERT INTO post_categories (post_id, category_id) VALUES (1, 1);
    INSERT INTO tags (id, name, created_at) VALUES (1, '标签一', ${now});
    INSERT INTO friend_links (id, name, url, description, icon, status, sort, created_at, updated_at)
      VALUES (1, '友链', 'https://example.com', '描述', '', 'approved', 0, ${now}, ${now});
    INSERT INTO members (id, username, display_name, password_hash, salt, tier, points, status, created_at, updated_at)
      VALUES (1, 'demo', '演示会员', 'hash', 'salt', 'normal', 12, 'active', ${now}, ${now});
    INSERT INTO member_points_log (id, member_id, delta, reason, ref_id, created_at)
      VALUES (1, 1, 1, 'daily_login', 0, ${now});
    INSERT INTO uploads (id, key, name, mime, size, created_at, hash)
      VALUES (1, 'u/202601/a.jpg', 'a.jpg', 'image/jpeg', 4, ${now}, 'h1'),
             (2, 'og/202601/b.png', 'b.png', 'image/png', 3, ${now}, 'h2');
    INSERT INTO settings (key, value) VALUES
      ('siteName', '我的旧站'),
      ('theme', 'paper'),
      ('externalToken', 'OLD-SECRET-MUST-NOT-LEAK'),
      ('telegramBotToken', 'TG-SECRET'),
      ('siteUrl', 'https://old.example'),
      ('pageCacheEpoch', '123'),
      ('bundleImport', '{"state":"running"}'),
      ('siteFoot', '{"posts":1}');
  `)
}

test('整站包：导出 → 还原到空站，数据与图片完整回来（且不带走密钥/实例态）', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  srcR2.map.set('og/202601/b.png', new Uint8Array([9, 8, 7]))

  // ── 导出 ──
  const bundleBytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1_800_000_000_000))
  assert.ok(bundleBytes.length > 0)

  const src = bytesSource(bundleBytes)
  const entries = await readZipIndex(src)
  const mfEntry = zipFind(entries, 'manifest.json')
  assert.ok(mfEntry, '包内必须有 manifest.json')
  const manifest = JSON.parse(DEC.decode(await readZipEntry(src, mfEntry!))) as BundleManifest
  assert.equal(manifest.format, BUNDLE_FORMAT)
  assert.equal(manifest.app, 'xwblog')
  assert.equal(manifest.images.count, 2)
  assert.deepEqual(manifest.missingImages, [])
  assert.equal(manifest.tables.find((t) => t.name === 'posts')?.rows, 1)
  assert.equal(manifest.tables.find((t) => t.name === 'settings')?.rows, 3) // siteName / theme / siteFoot（密钥与实例态键已排除）
  // 密钥与实例态键不在包里
  const settingsEntry = zipFind(entries, 'tables/settings.0.json')
  assert.ok(settingsEntry)
  const settingsJson = DEC.decode(await readZipEntry(src, settingsEntry!))
  assert.equal(settingsJson.includes('OLD-SECRET-MUST-NOT-LEAK'), false)
  assert.equal(settingsJson.includes('TG-SECRET'), false)
  assert.equal(settingsJson.includes('pageCacheEpoch'), false)
  assert.equal(settingsJson.includes('bundleImport'), false)
  assert.equal(settingsJson.includes('我的旧站'), true)

  // ── 目标站：全新空站，已经装好自己的一套（管理员登录 + 自己的 siteUrl/密钥）──
  // 故意让 siteName / theme 与包里的键**同名**：settings 是唯一不清空的表，必须走 upsert，
  // 裸 INSERT 会撞 UNIQUE(key) 直接 500（2026-10-16 端到端实测踩到，本用例守着）
  const dstDb = freshDb()
  dstDb.raw.exec(`
    INSERT INTO users (id, username, display_name, password_hash, salt, created_at, updated_at) VALUES (1, 'admin', '站长', 'h', 's', 0, 0);
    INSERT INTO settings (key, value) VALUES ('siteUrl', 'https://new.example'), ('externalToken', 'NEW-SECRET'), ('onboarding', '0'), ('siteName', '目标站自己的站名'), ('theme', 'minimal');
  `)
  const dstR2 = memoryR2()
  const env = envOf(dstDb.d1, dstR2.bucket)

  // 包必须先落在目标站的存储里（导入按 Range 读）
  const bundleKey = `${BUNDLE_PREFIX}${bundleFileName(1_800_000_000_000)}`
  await dstR2.bucket.put(bundleKey, bundleBytes)

  const started = await startBundleImport(env as never, bundleKey)
  assert.equal(started.ok, true)
  if (!started.ok) return
  const plan = started.value
  assert.ok(plan.steps.length > 0)
  assert.ok(plan.steps.some((s) => s.unit === 'images'))
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'running')

  // 分步导入（与后台前端的驱动方式一致）
  for (const s of plan.steps) {
    const r = await runBundleImportStep(env as never, bundleKey, s.unit, s.cursor)
    assert.equal(r.ok, true, `${s.unit}#${s.cursor}: ${r.ok ? '' : r.error}`)
  }
  const fin = await finishBundleImport(env as never, bundleKey)
  assert.equal(fin.ok, true)
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'done')

  // ── 内容回来了 ──
  const post = dstDb.raw.prepare('SELECT id, slug, title, content, status, cover FROM posts WHERE id = 1').get() as Record<string, unknown>
  assert.equal(post.slug, 'hello')
  assert.equal(post.title, '你好')
  assert.equal(post.status, 'published')
  // 正文落库前过净化：script 剥掉，站内图与正文其余部分保留
  assert.equal(String(post.content).includes('<script>'), false)
  assert.equal(String(post.content).includes('/images/u/202601/a.jpg'), true)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM pages').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM weibo').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM comments').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM categories').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM post_categories').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM tags').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM friend_links').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM members').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT points FROM members WHERE id = 1').get()!.points, 12)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM member_points_log').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM uploads').get()!.n, 2)

  // ── 图片回来了（逐字节）──
  assert.deepEqual([...(dstR2.map.get('u/202601/a.jpg') ?? [])], [1, 2, 3, 4])
  assert.deepEqual([...(dstR2.map.get('og/202601/b.png') ?? [])], [9, 8, 7])

  // ── settings：包里的键覆盖，目标站自己的密钥/实例态键保住 ──
  const st = (k: string) => (dstDb.raw.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
  assert.equal(st('siteName'), '我的旧站')
  assert.equal(st('theme'), 'paper')
  assert.equal(st('siteFoot'), '{"posts":1}')
  assert.equal(st('siteUrl'), 'https://new.example')
  assert.equal(st('externalToken'), 'NEW-SECRET')
  assert.equal(st('onboarding'), '0')
  // 导入自己的记账位不被包覆盖
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'done')
  // 管理员账号是实例身份：目标站的用户表原样不动
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT username FROM users WHERE id = 1').get()!.username, 'admin')
})

test('整站包：非空站一律拒绝（永不覆盖、永不合并）', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}test.zip`

  const dstDb = freshDb()
  // 目标站已经有内容
  dstDb.raw.exec(
    "INSERT INTO posts (id, slug, title, content, status, created_at, updated_at) VALUES (9, 'mine', '我的文章', '<p>x</p>', 'published', 1, 1)"
  )
  const dstR2 = memoryR2()
  await dstR2.bucket.put(key, bytes)
  const r = await startBundleImport(envOf(dstDb.d1, dstR2.bucket) as never, key)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /只允许还原到/)
    assert.equal(r.status, 400)
  }
  // 目标站内容分毫未动
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT title FROM posts WHERE id = 9').get()!.title, '我的文章')
})

test('整站包：软删除的内容不算「内容」——新站把示例文章与关于我页删进回收站即可导入', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}seeds.zip`

  const dstDb = freshDb()
  // 全新装好的站自带两条种子：欢迎示例文章（setup 播种）+「关于我」页面（ensureSchema 播种）
  dstDb.raw.exec(
    "INSERT INTO posts (id, slug, title, content, status, created_at, updated_at) VALUES (1, 'hello', '示例文章', '<p>示例</p>', 'published', 1, 1)"
  )
  dstDb.raw.exec(
    "INSERT INTO pages (id, slug, title, content, status, created_at, updated_at) VALUES (1, 'about', '关于我', '<p>关于</p>', 'published', 1, 1)"
  )
  const dstR2 = memoryR2()
  await dstR2.bucket.put(key, bytes)
  const env = envOf(dstDb.d1, dstR2.bucket)

  // 种子还活着 → 拒绝，且报出「挡路的是什么」（后台直接把这句话显示给站长）
  const blocked = await startBundleImport(env as never, key)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.status, 400)
    assert.match(blocked.error, /1 篇文章/)
    assert.match(blocked.error, /1 个页面/)
    assert.match(blocked.error, /移入回收站/)
  }
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)

  // 删进回收站（软删）→ 算空站，可以导入（这是「换服务器」的主用例）
  dstDb.raw.exec('UPDATE posts SET deleted_at = 123 WHERE id = 1')
  dstDb.raw.exec('UPDATE pages SET deleted_at = 123 WHERE id = 1')
  const started = await startBundleImport(env as never, key)
  assert.equal(started.ok, true)
  if (!started.ok) return
  for (const s of started.value.steps) {
    assert.equal((await runBundleImportStep(env as never, key, s.unit, s.cursor)).ok, true)
  }
  assert.equal((await finishBundleImport(env as never, key)).ok, true)

  // 源站内容到位，且目标站原来的回收站残留被清掉（不留 id 冲突的半吊子行）
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT title FROM posts WHERE id = 1').get()!.title, '你好')
  assert.equal(dstDb.raw.prepare('SELECT deleted_at FROM posts WHERE id = 1').get()!.deleted_at, null)
})

test('清空本站：确认语判定（缺省 / 只写一半 / 非字符串一律不认）', () => {
  assert.equal(RESET_CONFIRM_PHRASE, '清空本站')
  assert.equal(resetConfirmOk('清空本站'), true)
  assert.equal(resetConfirmOk(' 清空本站 '), true) // 两侧空白容忍（前端会 trim）
  assert.equal(resetConfirmOk('清空'), false)
  assert.equal(resetConfirmOk('清空本站内容'), false)
  assert.equal(resetConfirmOk(''), false)
  assert.equal(resetConfirmOk(undefined), false)
  assert.equal(resetConfirmOk(null), false)
  assert.equal(resetConfirmOk(123), false)
  assert.equal(resetConfirmOk({ confirm: '清空本站' }), false)
})

test('清空本站：内容清光（含回收站）、设置与管理员账号留住，清完就能导入', async () => {
  // 源站（要搬走的那个站）
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}reset.zip`

  // 目标站：一整套内容 + 管理员 + 密钥 + 实例态键 + 图床里的旧图
  const dstDb = freshDb()
  seedSource(dstDb.raw)
  dstDb.raw.exec(
    "INSERT INTO users (id, username, display_name, password_hash, salt, avatar, created_at, updated_at) VALUES (1, 'admin', '站长', 'h', 's', '/images/u/avatar.png', 0, 0)"
  )
  // 内容里有回收站残留（软删行）：清空必须一并清掉
  dstDb.raw.exec("INSERT INTO posts (id, slug, title, content, status, created_at, updated_at, deleted_at) VALUES (99, 'trashed', '回收站里的', '<p>x</p>', 'published', 1, 1, 123)")
  // 站点头像 / 管理员头像也是图床文件（走 /admin/upload，必有 uploads 行），但它们被**保留**的
  // settings / users 引用着——清空绝不能把这两张删了（否则保留的身份配置全变破图）
  dstDb.raw.exec(
    "INSERT INTO uploads (id, key, name, mime, size, created_at, hash) VALUES (3, 'u/avatar.png', 'avatar.png', 'image/png', 4, 1, 'h3'), (4, 'u/logo.png', 'logo.png', 'image/png', 4, 1, 'h4')"
  )
  dstDb.raw.exec("INSERT INTO settings (key, value) VALUES ('avatarUrl', '/images/u/logo.png')")
  const dstR2 = memoryR2()
  dstR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  dstR2.map.set('u/avatar.png', new Uint8Array([5, 5, 5, 5]))
  dstR2.map.set('u/logo.png', new Uint8Array([6, 6, 6, 6]))
  const env = envOf(dstDb.d1, dstR2.bucket)
  await dstR2.bucket.put(key, bytes)
  const st = (k: string) => (dstDb.raw.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value

  // 清空前：有内容 → 导入被拒（这正是要清空的原因；此时记账位是 seedSource 留的 running）
  const blocked = await startBundleImport(env as never, key)
  assert.equal(blocked.ok, false)
  // 模拟「上次导入失败留下的残留」（那种状态下导入本就允许重试，清空同样要把它归零）
  dstDb.raw.exec("UPDATE settings SET value = '{\"state\":\"failed\",\"key\":\"x\",\"at\":1,\"error\":\"boom\"}' WHERE key = 'bundleImport'")

  // ── 清空 ──
  const r = await resetSiteContent(env as never)
  assert.equal(r.cleared.posts, 2) // 1 篇活着的 + 1 篇回收站残留
  assert.equal(r.cleared.weibo, 1)
  assert.equal(r.cleared.pages, 1)
  assert.equal(r.cleared.comments, 1)
  assert.equal(r.cleared.members, 1)
  assert.equal(r.cleared.uploads, 4) // a.jpg / b.png / avatar.png / logo.png
  assert.equal(r.images, 2) // 只删内容侧的两张：被保留表引用的两张头像排除在外
  assert.equal(r.imagesDone, true)
  assert.ok(r.total >= 11)

  // 内容表（含回收站残留）全空
  for (const t of BUNDLE_TABLES.filter((x) => x !== 'settings')) {
    assert.equal(dstDb.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n, 0, `${t} 应被清空`)
  }
  // settings / 管理员账号留住（换站不必重新填配置，也不会把自己锁在外面）
  assert.equal(st('siteName'), '我的旧站')
  assert.equal(st('theme'), 'paper')
  assert.equal(st('externalToken'), 'OLD-SECRET-MUST-NOT-LEAK')
  assert.equal(st('siteUrl'), 'https://old.example')
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1)
  // 记账位归 idle（failed 残留的放行口子随之消失，界面也不再显示「上次导入失败」）
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'idle')
  // 图床文件：内容侧的图删掉（清的集合 = 整站包会打包的集合），**被保留表引用的头像不删**，
  // 要用的整站包本身也不能误删
  assert.equal(dstR2.map.has('u/202601/a.jpg'), false)
  assert.equal(dstR2.map.has('og/202601/b.png'), false)
  assert.deepEqual([...(dstR2.map.get('u/avatar.png') ?? [])], [5, 5, 5, 5])
  assert.deepEqual([...(dstR2.map.get('u/logo.png') ?? [])], [6, 6, 6, 6])
  assert.equal(dstR2.map.has(key), true)

  // ── 清空后：导入不再被空站守卫拦（这就是这个功能的用途）──
  const started = await startBundleImport(env as never, key)
  assert.equal(started.ok, true, started.ok ? '' : started.error)
  if (!started.ok) return
  for (const s of started.value.steps) assert.equal((await runBundleImportStep(env as never, key, s.unit, s.cursor)).ok, true)
  assert.equal((await finishBundleImport(env as never, key)).ok, true)
  assert.equal(dstDb.raw.prepare('SELECT title FROM posts WHERE id = 1').get()!.title, '你好')
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)
  // 新站的图随包回来（清空 → 导入 = 一次干净的换站）
  assert.deepEqual([...(dstR2.map.get('u/202601/a.jpg') ?? [])], [1, 2, 3, 4])
})

test('整站包：上次导入失败留下的残留允许被重试覆盖（重试 = 重来）', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}retry.zip`

  const dstDb = freshDb()
  const dstR2 = memoryR2()
  await dstR2.bucket.put(key, bytes)
  const env = envOf(dstDb.d1, dstR2.bucket)

  // 第一次：起了个头（留下半成品）后失败
  const first = await startBundleImport(env as never, key)
  assert.equal(first.ok, true)
  await runBundleImportStep(env as never, key, 'posts', 0)
  dstDb.raw.exec(
    "INSERT INTO settings (key, value) VALUES ('bundleImport', '{\"state\":\"failed\",\"key\":\"" + key + "\",\"at\":1,\"error\":\"boom\"}') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1) // 半成品在场

  // 第二次：允许重来（清空后重新灌）
  const again = await startBundleImport(env as never, key)
  assert.equal(again.ok, true, again.ok ? '' : again.error)
  if (!again.ok) return
  for (const s of again.value.steps) assert.equal((await runBundleImportStep(env as never, key, s.unit, s.cursor)).ok, true)
  assert.equal((await finishBundleImport(env as never, key)).ok, true)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT slug FROM posts WHERE id = 1').get()!.slug, 'hello')
})

test('整站包：无 start 会话时 step / finish 一律被拒（守卫不可绕过）', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}nosession.zip`

  const dstDb = freshDb()
  const dstR2 = memoryR2()
  await dstR2.bucket.put(key, bytes)
  const env = envOf(dstDb.d1, dstR2.bucket)

  const step = await runBundleImportStep(env as never, key, 'posts', 0)
  assert.equal(step.ok, false)
  if (!step.ok) assert.equal(step.status, 400)
  const fin = await finishBundleImport(env as never, key)
  assert.equal(fin.ok, false)
  // 一行都没灌进去
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 0)
})

test('整站包：导入成功后，杂散 step 不能把 done 翻成 failed（否则等于给出覆盖有内容站点的口子）', async () => {
  const srcDb = freshDb()
  seedSource(srcDb.raw)
  const srcR2 = memoryR2()
  srcR2.map.set('u/202601/a.jpg', new Uint8Array([1, 2, 3, 4]))
  const bytes = await drain(await buildBundleStream(envOf(srcDb.d1, srcR2.bucket) as never, 1))
  const key = `${BUNDLE_PREFIX}done.zip`

  const dstDb = freshDb()
  const dstR2 = memoryR2()
  await dstR2.bucket.put(key, bytes)
  const env = envOf(dstDb.d1, dstR2.bucket)

  const started = await startBundleImport(env as never, key)
  assert.equal(started.ok, true)
  if (!started.ok) return
  for (const s of started.value.steps) assert.equal((await runBundleImportStep(env as never, key, s.unit, s.cursor)).ok, true)
  assert.equal((await finishBundleImport(env as never, key)).ok, true)
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'done')

  // 杂散调用（后台/脚本/攻击者随手打一发）：step 被拒、finish 被拒、失败记账位不许写
  const stray = await runBundleImportStep(env as never, key, 'posts', 0)
  assert.equal(stray.ok, false)
  await markBundleImportFailed(env as never, key, 'stray')
  assert.equal((await getBundleImportState(dstDb.d1)).state, 'done')

  // 站点现在有内容了 → 再次 start 必须被拒（内容分毫不动）
  const again = await startBundleImport(env as never, key)
  assert.equal(again.ok, false)
  if (!again.ok) assert.match(again.error, /只允许还原到/)
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 1)
  assert.equal(dstDb.raw.prepare('SELECT slug FROM posts WHERE id = 1').get()!.slug, 'hello')
})

test('整站包：包不存在 / 非 zip / 标识穿越一律明确拒绝', async () => {
  const dstDb = freshDb()
  const dstR2 = memoryR2()
  const env = envOf(dstDb.d1, dstR2.bucket)

  const missing = await startBundleImport(env as never, `${BUNDLE_PREFIX}nope.zip`)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.status, 404)

  const traversal = await startBundleImport(env as never, '../etc/passwd')
  assert.equal(traversal.ok, false)
  if (!traversal.ok) assert.equal(traversal.status, 400)

  await dstR2.bucket.put(`${BUNDLE_PREFIX}junk.zip`, ENC.encode('这不是 zip'))
  const junk = await startBundleImport(env as never, `${BUNDLE_PREFIX}junk.zip`)
  assert.equal(junk.ok, false)
  if (!junk.ok) assert.match(junk.error, /无法解析/)
})

test('整站包：降版（包里有当前没有的列）在 start 阶段就被拒，不会灌到一半', async () => {
  const dstDb = freshDb()
  const dstR2 = memoryR2()
  const env = envOf(dstDb.d1, dstR2.bucket)

  // 手工造一个「未来版本」的包：manifest 声明了 posts.brand_new 列
  const stream = new TransformStream<Uint8Array>()
  const zip = new ZipWriter(stream.writable.getWriter())
  const drained = drain(stream.readable)
  const manifest = {
    format: BUNDLE_FORMAT,
    app: 'xwblog',
    appVersion: '9.9.9',
    exportedAt: 0,
    tables: [{ name: 'posts', rows: 1, columns: ['id', 'slug', 'brand_new'], parts: 1 }],
    images: { count: 0, bytes: 0 },
    missingImages: [],
    truncated: [],
  }
  await zip.add('manifest.json', ENC.encode(JSON.stringify(manifest)), 0)
  await zip.add('tables/posts.0.json', ENC.encode('[{"id":1,"slug":"x","brand_new":"y"}]'), 0)
  await zip.close()
  const key = `${BUNDLE_PREFIX}future.zip`
  await dstR2.bucket.put(key, await drained)

  const r = await startBundleImport(env as never, key)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /brand_new/)
    assert.match(r.error, /9\.9\.9/)
  }
  assert.equal(dstDb.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n, 0)
})

test('整站包：包里缺表分片 = 包不完整，start 阶段就拒', async () => {
  const dstDb = freshDb()
  const dstR2 = memoryR2()
  const env = envOf(dstDb.d1, dstR2.bucket)

  const stream = new TransformStream<Uint8Array>()
  const zip = new ZipWriter(stream.writable.getWriter())
  const drained = drain(stream.readable)
  const manifest = {
    format: BUNDLE_FORMAT,
    app: 'xwblog',
    appVersion: '2.5.1',
    exportedAt: 0,
    tables: [{ name: 'posts', rows: 1, columns: ['id'], parts: 2 }], // 声明 2 片
    images: { count: 0, bytes: 0 },
    missingImages: [],
    truncated: [],
  }
  await zip.add('manifest.json', ENC.encode(JSON.stringify(manifest)), 0)
  await zip.add('tables/posts.0.json', ENC.encode('[]'), 0) // 只给 1 片
  await zip.close()
  const key = `${BUNDLE_PREFIX}partial.zip`
  await dstR2.bucket.put(key, await drained)

  const r = await startBundleImport(env as never, key)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /不完整/)
})

test('collectBundleImageKeys：媒体库 ∪ 正文/封面/微博引用，外链与穿越 key 不收', async () => {
  const { d1, raw } = freshDb()
  raw.exec(`
    INSERT INTO uploads (id, key, name, mime, size, created_at, hash) VALUES
      (1, 'u/202601/a.jpg', 'a.jpg', 'image/jpeg', 1, 1, ''),
      (2, 'u/../escape.jpg', 'bad.jpg', 'image/jpeg', 1, 1, ''),
      (3, 'backups/x.zip', 'x.zip', 'application/zip', 1, 1, '');
    INSERT INTO posts (id, slug, title, content, cover, status, created_at, updated_at) VALUES
      (1, 'p', 't', '<p><img src="/images/u/202601/from-content.jpg"></p><img src="https://other.site/x.jpg">', '/images/og/202601/cover.png', 'published', 1, 1);
    INSERT INTO weibo (id, content, images, video, status, created_at, updated_at) VALUES
      (1, 'w', '["/images/u/202601/w.jpg"]', '{"url":"/images/u/202601/v.mp4","poster":"/images/u/202601/vp.jpg"}', 'published', 1, 1);
  `)
  const keys = await collectBundleImageKeys(d1)
  for (const k of ['u/202601/a.jpg', 'u/202601/from-content.jpg', 'og/202601/cover.png', 'u/202601/w.jpg', 'u/202601/v.mp4', 'u/202601/vp.jpg']) {
    assert.ok(keys.includes(k), k)
  }
  assert.equal(keys.includes('u/../escape.jpg'), false)
  assert.equal(keys.includes('backups/x.zip'), false)
  assert.equal(keys.some((k) => k.startsWith('http')), false)
})
