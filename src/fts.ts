/**
 * FTS5 全文搜索（ROADMAP B4，2026-10-07 落地）。
 *
 * posts_fts / weibo_fts 两张 trigram 分词虚表（external content 挂 posts / weibo 原表，
 * 增量同步靠 db.ts ensureSchema 挂的 AFTER INSERT/DELETE/UPDATE 触发器），替换 /search
 * 页对 title/summary/content 的 LIKE 全表扫描；微博正文顺势纳入搜索（此前搜不到）。
 *
 * 三条铁律（改这里先跑 tests/fts.test.ts）：
 * 1. trigram 至少要 3 个字符才能成窗（2 字中文词「博客」凑不出一个三元组）——任一分词
 *    短于 3 字符就整体退回 listPosts 的 LIKE 老路，保住 2 字词的既有行为，两套结果口径一致；
 * 2. 加密文章整体退出关键词搜索（与 listPosts q 分支同口径）：FTS 命中本身会泄露
 *    「正文含此词」，可被用来探测加密内容；回收站 / 草稿 / 定时文同样不得出现在公开搜索里；
 * 3. MATCH 表达式只由本模块构造：用户输入按空白切词后逐词加双引号（内部 " 翻倍），
 *    FTS5 查询语法（AND/OR/NOT/NEAR/列过滤）永远到不了引擎，防注入面收敛在这一处。
 *
 * 老库升级：FTS 虚表建出来时倒排索引是空的（external content 不含词条），ensureSchema
 * 用 settings 记账位 ftsSeeded 保证「建表后重建一次全量索引」只跑一回；demo 重置走
 * DELETE/INSERT 会触发同款触发器，索引天然跟着长。
 */

import { listPosts } from './db'
import type { ListPostsResult } from './db'
import { likePattern } from './utils'
import type { PostRow, WeiboRow } from './types'

/** 用户关键词 → FTS5 MATCH 表达式；null = 用不上索引（含短词），调用方退回 LIKE。
 *  按空白切词、词间 AND（与「整句连续子串」的旧 LIKE 语义略有放宽：多词只要求都出现），
 *  逐词双引号包裹成短语（trigram 下等价于连续子串匹配），内部双引号翻倍转义。 */
export function ftsMatchExpr(q: string): string | null {
  const terms = q.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (!terms.length) return null
  // [...t] 按码点数（trigram 按字符成窗，emoji 这类代理对要算 1 个字符而不是 2 个 UTF-16 单元）
  if (terms.some((t) => [...t].length < 3)) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}

/** /search 页文章搜索：FTS 命中按 bm25 相关度排序（好匹配在前），短词或 FTS 异常退回
 *  listPosts 的 LIKE 路径（时间序）——调用方拿到的都是同构 ListPostsResult，无感切换。
 *  加密文 / 回收站 / 非公开状态在 FTS 查询层直接排除（防线 2），locked 文章照常参与搜索、
 *  由渲染层的摘要口径兜底（与旧搜索同口径）。 */
export async function searchPosts(db: D1Database, q: string, limit = 50, afterTs = 0): Promise<ListPostsResult> {
  const expr = ftsMatchExpr(q)
  if (!expr) return listPosts(db, { status: 'published', q, page: 1, limit, afterTs })
  // 与 listPosts q 分支同口径的过滤条件（防线 2）；matches 必须回连原表过这些业务过滤；
  // 站点可见窗口（afterTs）同 listPosts 口径——窗口外文章不参与搜索，防「命中本身即泄露」
  const vis = afterTs > 0 ? 'AND COALESCE(p.published_at, p.created_at) >= ?' : ''
  const where =
    `posts_fts MATCH ? AND p.deleted_at IS NULL AND p.status = 'published' AND (p.password_hash IS NULL OR p.password_hash = '') ${vis}`
  const binds = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  try {
    const [itemsRes, countRes] = await Promise.all([
      db
        .prepare(
          `SELECT p.* FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid WHERE ${where} ORDER BY bm25(posts_fts) LIMIT ?`
        )
        .bind(...binds([expr]), limit)
        .all<PostRow>(),
      db
        .prepare(`SELECT COUNT(*) AS n FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid WHERE ${where}`)
        .bind(...binds([expr]))
        .first<{ n: number }>(),
    ])
    return { items: itemsRes.results ?? [], total: countRes?.n ?? 0, page: 1, totalPages: 1 }
  } catch {
    // FTS 虚表缺失（迁移未跑完的冷启动窗口）等异常：退回 LIKE，搜索不能因索引挂掉而 500
    return listPosts(db, { status: 'published', q, page: 1, limit, afterTs })
  }
}

export interface WeiboSearchResult {
  items: WeiboRow[]
  total: number
}

/** /search 页微博搜索：长词走 weibo_fts（bm25），短词走 LIKE 扫微博表（微博行数少，扫表够快）。
 *  微博无加密 / 档位概念，只需排除回收站与草稿；站点可见窗口（afterTs）两条路都收口。 */
export async function searchWeibo(db: D1Database, q: string, limit = 20, afterTs = 0): Promise<WeiboSearchResult> {
  const vis = afterTs > 0 ? 'AND COALESCE(w.published_at, w.created_at) >= ?' : ''
  const tail = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  const expr = ftsMatchExpr(q)
  if (expr) {
    const where = `weibo_fts MATCH ? AND w.deleted_at IS NULL AND w.status = 'published' ${vis}`
    try {
      const [itemsRes, countRes] = await Promise.all([
        db
          .prepare(
            `SELECT w.* FROM weibo_fts JOIN weibo w ON w.id = weibo_fts.rowid WHERE ${where} ORDER BY bm25(weibo_fts), w.id DESC LIMIT ?`
          )
          .bind(...tail([expr]), limit)
          .all<WeiboRow>(),
        db
          .prepare(`SELECT COUNT(*) AS n FROM weibo_fts JOIN weibo w ON w.id = weibo_fts.rowid WHERE ${where}`)
          .bind(...tail([expr]))
          .first<{ n: number }>(),
      ])
      return { items: itemsRes.results ?? [], total: countRes?.n ?? 0 }
    } catch {
      /* 虚表缺失等异常：落到底下的 LIKE 兜底 */
    }
  }
    // vis 恒置句尾与 tail() 的追加式 bind 顺序对齐（vis 插中间会把 cutoff 绑成 LIKE 模式——0 行静默漏配）
  const where = `w.deleted_at IS NULL AND w.status = 'published' AND w.content LIKE ? ESCAPE '\\' ${vis}`
  const [itemsRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT w.* FROM weibo w WHERE ${where} ORDER BY w.pinned DESC, COALESCE(w.published_at, w.created_at) DESC LIMIT ?`
      )
      .bind(...tail([likePattern(q)]), limit)
      .all<WeiboRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM weibo w WHERE ${where}`).bind(...tail([likePattern(q)])).first<{ n: number }>(),
  ])
  return { items: itemsRes.results ?? [], total: countRes?.n ?? 0 }
}
