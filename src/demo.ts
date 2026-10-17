/**
 * 演示站（体验站）引擎：播种、重置与并发认领。
 *
 * 工作方式（wrangler.demo.jsonc 注入 DEMO_MODE=1，生产 Worker 不带此变量、全程惰性）：
 * - 首次请求发现库里没有 demoSeededAt → 认领（settings.demoSeedClaim，5 分钟 TTL）→ 清库重灌
 * - 重置 cron 每两小时触发一次（DEMO_RESET_CRON，每 2 小时的第 23 分钟）：清空全部业务表 + R2，再按种子计划重建
 * - 种子内容在 src/demo-posts.ts / demo-content.ts / demo-images.ts，确定性生成，重置前后一致
 *
 * 与生产的关系：本文件只在 DEMO_MODE 下被动态 import（生产 Worker 不执行这份数据）；
 * 种子数据是站点自己的内容，不依赖外部服务——TG/webhook 等外发钩子在 DEMO_MODE 下被禁用（src/hooks.ts）。
 */
import { hashPassword } from './auth'
import { DEFAULT_SETTINGS, invalidateSharedSettings } from './db'
import { buildDemoPlan, DEMO_ADMIN, DEMO_RESET_CRON } from './demo-content'
import { demoImages } from './demo-images'
import SCHEMA_SQL from '../schema.sql'
import type { Env } from './types'
import { sha256Hex } from './utils'

export { DEMO_RESET_CRON }

const CLAIM_KEY = 'demoSeedClaim'
const SEEDED_KEY = 'demoSeededAt'
const CLAIM_TTL = 5 * 60_000

const WIPE_TABLES = [
  'posts',
  'comments',
  'weibo',
  'categories',
  'post_categories',
  'tags',
  'uploads',
  'friend_links',
  'pages',
  'tg_buffer',
  'sessions',
  'members',
  'member_sessions',
  'member_points_log',
  'visit_log',
  'bot_log',
  'users',
  'settings',
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 冷启动建表 ----------------
 * 生产站的表由部署时的 `wrangler d1 execute --file schema.sql` 建立，ensureSchema 只是增量迁移；
 * 演示站必须能从一块全新空库自己长出来（本地 dev、一键部署后的首次请求都是空库）。
 * 这里把 schema.sql 原文打进 bundle 逐条执行（全部 CREATE ... IF NOT EXISTS，幂等），
 * 每 isolate 只跑一次；schema 演进仍以 schema.sql 为唯一事实来源，不另抄第二份。
 */
let tablesReady: Promise<void> | null = null
export async function ensureTables(db: D1Database): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      const stmts = SCHEMA_SQL.split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of stmts) await db.prepare(stmt).run()
    })().catch((err) => {
      tablesReady = null
      throw err
    })
  }
  return tablesReady
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** 分批执行批量语句（D1 单次 batch 的语句数留有余量） */
async function batched(db: D1Database, stmts: D1PreparedStatement[], size = 80): Promise<void> {
  for (const group of chunk(stmts, size)) await db.batch(group)
}

/** cron 入口：重置 cron 触发时返回 true（已处理），其余 cron（定时发布扫描）放行 */
export async function demoScheduled(controller: ScheduledController, env: Env): Promise<boolean> {
  if (controller.cron !== DEMO_RESET_CRON) return false
  try {
    await seedAll(env)
  } catch (e) {
    // 重置失败不吞掉日志：下一个 cron 周期会再试，fetch 路径的自播种也能兜底
    console.error('demo reset failed:', e)
  }
  return true
}

/** fetch 路径的自播种：先幂等建表，库为空时认领并播种，播种期间其他请求短暂等待 */
export async function demoEnsureSeeded(env: Env): Promise<void> {
  try {
    const db = env.DB
    await ensureTables(db)
    const seeded = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SEEDED_KEY).first()
    if (seeded) return
    if (!(await tryClaim(db))) {
      // 另一个 isolate 正在播种：稍等它完成；没等到也放行（短暂空站可接受，下次请求即恢复）
      for (let i = 0; i < 4; i++) {
        await sleep(1200)
        if (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SEEDED_KEY).first()) return
      }
      return
    }
    await seedAll(env)
  } catch (e) {
    console.error('demo seed failed:', e)
    // 播种中途失败：立刻让出认领，下个请求就能重试（而不是等认领 TTL 过期）
    try {
      await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CLAIM_KEY).run()
    } catch {
      /* 库异常时放弃，等 TTL 自愈 */
    }
  }
}

/** 认领播种权：settings.demoSeedClaim，值 = 认领时间；超过 TTL 的旧认领可被抢走（播种崩溃自愈） */
async function tryClaim(db: D1Database): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?`
    )
    .bind(CLAIM_KEY, String(Date.now()), Date.now() - CLAIM_TTL)
    .run()
  return (res.meta.changes ?? 0) > 0
}

/** 清空 + 重建整个演示站 */
async function seedAll(env: Env): Promise<void> {
  const db = env.DB
  await ensureTables(db)
  const plan = buildDemoPlan(Date.now())

  // 1) 清空所有业务表，并重置自增序号——演示数据的 id 从 1 开始，评论父子引用因此可预测
  await db.batch(WIPE_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)))
  try {
    await db.prepare('DELETE FROM sqlite_sequence').run()
  } catch {
    /* 库里还没有自增表时 sqlite_sequence 不存在 */
  }
  // 2) 续认领：播种期间挡住其他 isolate 的自播种（清库会连带清掉认领记录）
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(CLAIM_KEY, String(Date.now()))
    .run()

  // 3) R2 清空重建种子图
  await wipeBucket(env.IMAGES)
  await Promise.all(
    demoImages().map((img) => env.IMAGES.put(img.key, img.svg, { httpMetadata: { contentType: img.mime } }))
  )

  // 4) 管理员账号（demo / demo1234，登录页公示）
  const now = Date.now()
  const { hash, salt } = await hashPassword(DEMO_ADMIN.password)
  const userStmt = db
    .prepare(
      'INSERT INTO users (username, password_hash, salt, display_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(DEMO_ADMIN.username, hash, salt, DEMO_ADMIN.displayName, '', now, now)
  await db.batch([userStmt])

  // 4.5) 演示会员（公示账号 demo / demo1234 + 背景板会员）与积分账本；
  //      落库序 = plan.members 数组序（自增已重置，members.id = 下标 + 1，评论按此引用）
  for (const [mi, m] of plan.members.entries()) {
    const { hash, salt } = await hashPassword(m.password)
    await db.batch([
      db
        .prepare(
          `INSERT INTO members (username, password_hash, salt, email, display_name, avatar, tier, points, status, created_at, updated_at, last_login_at)
           VALUES (?, ?, ?, '', ?, '', ?, ?, 'active', ?, ?, ?)`
        )
        .bind(m.username, hash, salt, m.displayName, m.tier, m.points, m.createdAt, m.createdAt, m.createdAt),
    ])
    if (m.log.length) {
      await db.batch(
        m.log.map((r) =>
          db
            .prepare('INSERT INTO member_points_log (member_id, delta, reason, ref_id, note, created_at) VALUES (?, ?, ?, 0, ?, ?)')
            .bind(mi + 1, r.delta, r.reason, r.note, r.createdAt)
        )
      )
    }
  }

  // 5) settings 全量（DEFAULT_SETTINGS 打底 + 演示站人设覆盖）
  const settings = { ...DEFAULT_SETTINGS, ...plan.settings }
  await batched(
    db,
    Object.entries(settings).map(([k, v]) =>
      db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(k, String(v ?? ''))
    )
  )

  // 6) 分类（自增序号已重置，id = 数组下标 + 1）
  await db.batch(
    plan.categories.map((c) =>
      db
        .prepare('INSERT INTO categories (name, slug, sort, created_at) VALUES (?, ?, ?, ?)')
        .bind(c.name, c.slug, c.sort, now)
    )
  )
  const catIds = new Map(plan.categories.map((c, i) => [c.slug, i + 1]))

  // 7) 文章（id = 下标 + 1，评论按此引用）+ 分类关联；密码文先 hash（salt:hash，protect.ts 口径）
  const pwHashes = new Map<string, string>()
  for (const p of plan.posts) {
    if (p.password && !pwHashes.has(p.slug)) {
      const { hash, salt } = await hashPassword(p.password)
      pwHashes.set(p.slug, `${salt}:${hash}`)
    }
  }
  const postStmts = plan.posts.map((p) =>
    db
      .prepare(
        `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, views, likes, author_id, min_tier, password_hash, published_at, publish_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .bind(p.slug, p.title, p.content, p.summary, p.cover, p.tags, p.status, p.pinned, p.views, p.likes, p.minTier, pwHashes.get(p.slug) ?? '', p.publishedAt, p.publishAt, p.createdAt, p.updatedAt)
  )
  const catLinkStmts = plan.posts
    .filter((p) => catIds.has(p.cat))
    .map((p) =>
      db
        .prepare('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)')
        .bind(plan.posts.indexOf(p) + 1, catIds.get(p.cat)!)
    )
  await db.batch(postStmts)
  if (catLinkStmts.length) await db.batch(catLinkStmts)

  // 8) 标签登记表（文章自身的 tags JSON 已随 posts 落库，这里只是分类页的预登记）
  if (plan.tags.length) {
    await db.batch(
      plan.tags.map((t) => db.prepare('INSERT INTO tags (name, created_at) VALUES (?, ?)').bind(t, now))
    )
  }

  // 9) 评论（id = 下标 + 1，parentId 已按计划序号落好；memberId 挂会员徽标）
  await batched(
    db,
    plan.comments.map((c) =>
      db
        .prepare(
          'INSERT INTO comments (post_id, weibo_id, parent_id, is_admin, member_id, nickname, email, website, content, status, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(c.postId, c.weiboId, c.parentId, c.isAdmin, c.memberId, c.nickname, '', c.website, c.content, c.status, '', c.createdAt)
    )
  )

  // 10) 微博
  await batched(
    db,
    plan.weibo.map((w) =>
      db
        .prepare(
          'INSERT INTO weibo (content, images, topics, status, pinned, likes, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(w.content, w.images, w.topics, w.status, w.pinned, w.likes, w.publishedAt, w.createdAt, w.updatedAt)
    )
  )

  // 11) 友链 + 独立页面
  if (plan.links.length) {
    await db.batch(
      plan.links.map((l) =>
        db
          .prepare(
            'INSERT INTO friend_links (name, url, description, icon, status, sort, source, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(l.name, l.url, l.description, l.icon ?? '', l.status, l.sort ?? 0, l.source, l.ip ?? '', l.createdAt, l.updatedAt)
      )
    )
  }
  await db.batch(
    plan.pages.map((p) =>
      db
        .prepare(
          'INSERT INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(p.title, p.slug, p.content, p.status, p.showInNav, p.sort, p.createdAt, p.updatedAt)
    )
  )

  // 12) 媒体库登记（种子图在「后台 → 媒体」里可见可管）；指纹直接算好，演示站体检无需先回填
  const uploadStmts: D1PreparedStatement[] = []
  for (const img of demoImages()) {
    uploadStmts.push(
      db
        .prepare('INSERT INTO uploads (key, name, mime, size, created_at, hash) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(img.key, img.key.slice('u/demo/'.length), img.mime, img.svg.length, now, await sha256Hex(new TextEncoder().encode(img.svg).buffer as ArrayBuffer))
    )
  }
  await db.batch(uploadStmts)

  // 13) 访客统计：多行 INSERT 分批落库——SQLite 单条语句变量上限 100（9 列 × 10 行 = 90，留余量）
  const visitCols = '(ts, day, vid, path, title, ref, dev, br, country)'
  const visitStmts: D1PreparedStatement[] = []
  for (const group of chunk(plan.visits, 10)) {
    const placeholders = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const binds = group.flatMap((v) => [v.ts, v.day, v.vid, v.path, v.title, v.ref, v.dev, v.br, v.country])
    visitStmts.push(db.prepare(`INSERT INTO visit_log ${visitCols} VALUES ${placeholders}`).bind(...binds))
  }
  await batched(db, visitStmts, 40)

  // 13b) 爬虫抓取日志（src/bots.ts bot_log）：6 列 × 15 行 = 90，同样留余量
  const botCols = '(ts, day, name, kind, path, country)'
  const botStmts: D1PreparedStatement[] = []
  for (const group of chunk(plan.bots, 15)) {
    const placeholders = group.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
    const binds = group.flatMap((b) => [b.ts, b.day, b.name, b.kind, b.path, b.country])
    botStmts.push(db.prepare(`INSERT INTO bot_log ${botCols} VALUES ${placeholders}`).bind(...binds))
  }
  await batched(db, botStmts, 40)

  // 14) 记账：播种完成。此后 fetch 路径的自播种直接放行，直到下个 cron 周期重置
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(SEEDED_KEY, String(Date.now()))
    .run()
  // 播种写了一堆 settings（认领位 / 完成位），失效 settings 共享快照——重灌后的请求
  // 必须看到演示站的全新口径，不能拿到重灌前的旧值
  await invalidateSharedSettings(db)
}

/** 清空 R2 桶（分页删光所有对象），随后种子图会原样重建 */
async function wipeBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ cursor })
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}
