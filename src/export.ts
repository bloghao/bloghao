/**
 * 数据导出（roadmap A1）：Markdown 包（zip）与 WordPress WXR 单文件。
 *
 * - Markdown 包：全部文章（含草稿，front-matter 带 status）+ 微博 + 独立页面 + 被引用的图片。
 *   正文服务端 HTML→MD（src/html-md.ts），图片从 R2 流式打进 zip（src/zip.ts），整包不过内存。
 * - WXR：WordPress eXtended RSS 1.2，文章（HTML 正文）+ 分类 + 标签，供 WordPress / emlog 等导入器使用；
 *   微博不进 WXR（两边无对应模型），用 Markdown 包携带。
 * 挂载于 /api/admin/export（api.ts），受登录中间件保护，GET + 会话 Cookie 即下载。
 */
import { Hono } from 'hono'
import { getSettings, listPages, parseTags } from './db'
import { htmlToMd } from './html-md'
import { siteBase } from './render'
import { extractOgImage, sanitizeHtml } from './sanitize'
import type { Env, PageRow, PostRow, SessionUser, WeiboRow } from './types'
import { cstDate, fmtDate } from './utils'
import { cdata, rfc822, xmlEsc } from './xml'
import { ZipWriter } from './zip'

type ExportEnv = { Bindings: Env; Variables: { user: SessionUser } }

export const exportRoutes = new Hono<ExportEnv>()

const MAX_ROWS = 100_000 // 与备份的 TABLE_ROW_LIMIT 同口径（D1 单查询返回上限）

/** 站内 /images/ 地址 → R2 key；外链与其余一律返回 null。
 *  与 /images 路由同一白名单口径（u/ / og/ 前缀）：.. 与目录外 key 拒收——
 *  真实 R2 无所谓，docker-poc 的 r2disk 落盘时会把 .. 拼进文件路径，自己的文章
 *  不能让导出功能炸掉或写出租户目录 */
function keyOf(url: string): string | null {
  if (!url.startsWith('/images/')) return null
  const raw = url.slice('/images/'.length)
  let key: string
  try {
    key = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!key.startsWith('u/') && !key.startsWith('og/')) return null
  if (key.includes('..') || key.includes('\\') || key.includes('\0')) return null
  return key
}

/** Markdown 包内相对地址（front-matter/正文里用）：/images/u/x.png → images/u/x.png，外链不动 */
function relativeOf(url: string): string {
  return url.startsWith('/images/') ? 'images/' + url.slice('/images/'.length) : url
}

/** 从净化后的正文 HTML 收集站内图片 key（正文 img + OG 卡图；外链跳过） */
export function collectImageKeysFromHtml(html: string): string[] {
  const keys: string[] = []
  for (const m of html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) keys.push(m[1])
  const og = extractOgImage(html)
  if (og) keys.push(og)
  return keys.map(keyOf).filter((k): k is string => !!k)
}

/** Markdown 正文里的站内图片链接改写为包内相对路径 images/…（外链不动） */
export function rewriteImageLinks(md: string): string {
  return md.replace(/\]\(\/images\//g, '](images/')
}

/** YAML front-matter：值统一双引号包裹，内部引号转义 */
export function frontMatter(f: {
  title: string
  slug: string
  date: string
  status: string
  tags: string[]
  category?: string
  cover?: string
  summary?: string
}): string {
  const q = (s: string) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const lines = [
    '---',
    `title: ${q(f.title)}`,
    `slug: ${q(f.slug)}`,
    `date: ${q(f.date)}`,
    `status: ${q(f.status)}`,
    `tags: [${f.tags.map(q).join(', ')}]`,
  ]
  if (f.category) lines.push(`category: ${q(f.category)}`)
  if (f.cover) lines.push(`cover: ${q(relativeOf(f.cover))}`)
  if (f.summary) lines.push(`summary: ${q(f.summary)}`)
  lines.push('---')
  return lines.join('\n')
}

/** 北京时间 YYYY-MM-DD HH:mm:ss（与全站 +8h 口径一致，比 fmtDateTime 多秒位供 front-matter 用） */
function fmtDateTimeCst(ts: number | null): string {
  if (!ts) return ''
  const d = cstDate(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

function attachmentHeaders(filename: string, contentType: string): Headers {
  // 文件名固定 ASCII（xwblog-<格式>-<北京日期>），无需 RFC 5987 编码
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache',
  })
  return headers
}

exportRoutes.get('/markdown', async (c) => {
  const db = c.env.DB
  const [postsRes, catRes, weiboRes] = await Promise.all([
    // 回收站里的已删行不进导出包（导出是用户产物；备份仍是全表含回收站）
    db.prepare('SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ?').bind(MAX_ROWS).all<PostRow>(),
    db
      .prepare('SELECT pc.post_id, c.name AS name FROM post_categories pc JOIN categories c ON c.id = pc.category_id')
      .all<{ post_id: number; name: string }>(),
    db.prepare('SELECT * FROM weibo WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ?').bind(MAX_ROWS).all<WeiboRow>(),
  ])
  const posts = postsRes.results ?? []
  const weibo = weiboRes.results ?? []
  const pages: PageRow[] = await listPages(db)
  const catByName = new Map((catRes.results ?? []).map((r) => [r.post_id, r.name]))

  // 净化只跑一遍：图片清单收集与 Markdown 生成共用同一份结果（10 万行上限下两遍是 CPU 翻倍）
  const postsHtml = posts.map((p) => sanitizeHtml(p.content))
  const pagesHtml = pages.map((pg) => sanitizeHtml(pg.content))

  // 图片 key 清单：正文 img / OG 卡图 / 封面 + 微博图 + 独立页面正文图
  // （pages 的 MD 同样引用配图，不进清单则导出包里页面配图全是死链）
  const keys = new Set<string>()
  postsHtml.forEach((html, i) => {
    for (const k of collectImageKeysFromHtml(html)) keys.add(k)
    const cover = keyOf(posts[i].cover)
    if (cover) keys.add(cover)
  })
  for (const html of pagesHtml) {
    for (const k of collectImageKeysFromHtml(html)) keys.add(k)
  }
  for (const w of weibo) {
    try {
      for (const src of JSON.parse(w.images || '[]') as string[]) {
        const k = keyOf(src)
        if (k) keys.add(k)
      }
    } catch {
      /* images 列损坏就跳过这条微博的图 */
    }
  }

  const stream = new TransformStream<Uint8Array>()
  const zip = new ZipWriter(stream.writable.getWriter())
  const missing: string[] = []

  const pump = (async () => {
    try {
      const now = Date.now()
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i]
        const md =
          frontMatter({
            title: p.title,
            slug: p.slug,
            date: fmtDateTimeCst(p.published_at ?? p.created_at),
            status: p.status,
            tags: parseTags(p),
            category: catByName.get(p.id),
            cover: p.cover,
            summary: p.summary,
          }) +
          '\n\n' +
          rewriteImageLinks(htmlToMd(postsHtml[i]))
        await zip.add(`posts/${p.slug}.md`, new TextEncoder().encode(md), p.updated_at)
      }
      if (weibo.length) {
        const lines = weibo.map((w) => {
          let imgs = ''
          try {
            imgs = (JSON.parse(w.images || '[]') as string[])
              .map((s) => `![](${relativeOf(s)})`)
              .join(' ')
          } catch {
            /* 同上，损坏跳过 */
          }
          return `## ${fmtDateTimeCst(w.published_at ?? w.created_at)}\n\n${w.content}${imgs ? '\n\n' + imgs : ''}`
        })
        await zip.add('weibo.md', new TextEncoder().encode('# 微博\n\n' + lines.join('\n\n') + '\n'), now)
      }
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i]
        const md =
          frontMatter({
            title: pg.title,
            slug: pg.slug,
            date: fmtDateTimeCst(pg.created_at),
            status: pg.status,
            tags: [],
          }) +
          '\n\n' +
          rewriteImageLinks(htmlToMd(pagesHtml[i]))
        await zip.add(`pages/${pg.slug}.md`, new TextEncoder().encode(md), pg.updated_at)
      }
      // 图片：R2 逐个流式写入（store 模式不压缩，边流边算 CRC），缺失记入 manifest
      for (const key of keys) {
        const obj = await c.env.IMAGES.get(key)
        if (!obj) {
          missing.push(key)
          continue
        }
        await zip.add(`images/${key}`, obj.body, obj.uploaded?.getTime?.() ?? now)
      }
      await zip.add(
        'manifest.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              app: 'xwblog',
              version: 1,
              exportedAt: now,
              posts: posts.length,
              weibo: weibo.length,
              pages: pages.length,
              images: keys.size - missing.length,
              missingImages: missing,
            },
            null,
            2
          )
        ),
        now
      )
      await zip.close()
    } catch (e) {
      // 生成中途失败：中断流让下载端明确失败，而不是挂住等超时
      await zip.abort()
      throw e
    }
  })()
  c.executionCtx.waitUntil(pump.catch((e) => console.error('导出 zip 失败', e)))

  return new Response(stream.readable, {
    headers: attachmentHeaders(`xwblog-markdown-${fmtDate(Date.now())}.zip`, 'application/zip'),
  })
})

exportRoutes.get('/wxr', async (c) => {
  const db = c.env.DB
  const settings = await getSettings(db)
  const [postsRes, catRes] = await Promise.all([
    db.prepare('SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ?').bind(MAX_ROWS).all<PostRow>(),
    db
      .prepare('SELECT pc.post_id, c.name AS name FROM post_categories pc JOIN categories c ON c.id = pc.category_id')
      .all<{ post_id: number; name: string }>(),
  ])
  const siteUrl = siteBase(settings, new URL(c.req.url).origin)
  const posts = postsRes.results ?? []
  const catByName = new Map((catRes.results ?? []).map((r) => [r.post_id, r.name]))
  const tagSet = new Set<string>()
  for (const p of posts) for (const t of parseTags(p)) tagSet.add(t)

  // xmlEsc/cdata/rfc822 与 RSS 同一套（src/xml.ts）：控制字符剥离等口径不允许分叉
  const items = posts
    .map((p) => {
      const tags = parseTags(p)
      const cat = catByName.get(p.id)
      return `    <item>
      <title>${xmlEsc(p.title)}</title>
      <link>${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</link>
      <guid isPermaLink="true">${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</guid>
      <pubDate>${rfc822(p.published_at ?? p.created_at)}</pubDate>
      <dc:creator>${xmlEsc(settings.siteName)}</dc:creator>
      <content:encoded>${cdata(sanitizeHtml(p.content))}</content:encoded>
      <excerpt:encoded>${cdata(p.summary)}</excerpt:encoded>
      <wp:post_id>${p.id}</wp:post_id>
      <wp:post_date>${xmlEsc(fmtDateTimeCst(p.published_at ?? p.created_at))}</wp:post_date>
      <wp:post_name>${xmlEsc(p.slug)}</wp:post_name>
      <wp:status>${xmlEsc(p.status === 'published' ? 'publish' : 'draft')}</wp:status>
      <wp:post_type>post</wp:post_type>
      ${cat ? `<category domain="category">${cdata(cat)}</category>` : ''}
      ${tags.map((t) => `<category domain="post_tag">${cdata(t)}</category>`).join('\n      ')}
    </item>`
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>${xmlEsc(settings.siteName)}</title>
    <link>${xmlEsc(siteUrl)}</link>
    <description>${xmlEsc(settings.siteDescription)}</description>
    <pubDate>${rfc822(Date.now())}</pubDate>
    <language>zh-CN</language>
    <wp:wxr_version>1.2</wp:wxr_version>
${[...tagSet].map((t) => `    <wp:tag><wp:tag_name>${cdata(t)}</wp:tag_name></wp:tag>`).join('\n')}
${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: attachmentHeaders(`xwblog-wxr-${fmtDate(Date.now())}.xml`, 'application/xml; charset=utf-8'),
  })
})
