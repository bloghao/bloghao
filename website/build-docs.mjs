#!/usr/bin/env node
// 官网文档生成器：把仓库 docs/*.md 预渲染成与官网同款配色 / 导航 / 页脚的静态文档页，
// 输出到 website/public/docs/（生成结果直接提交，部署仍是零构建纯静态）。
// 用法：仓库根目录 npm run build:docs；docs/ 下的文档改动后重新跑一遍即可。
// 说明：站内互链（GUIDE.md → guide.html）自动改写；指向仓库其他文件的相对链接
// （如 ../docker-poc/DEPLOY.md）回落到 GitHub；外链一律新窗口打开。
// 页面内资源一律**根绝对路径**（/style.css、/docs.js…）——官网部署在域名根目录，
// 这样 /docs、/docs/、/docs/index.html 三种访问方式的相对基准差异不会再把页面打裸
// （/docs 无斜杠时 ../style.css 会解析成 /docs/style.css，整页丢样式）。
// 同时生成站内搜索索引（/docs/docs-search-index.js，一次加载全站缓存，客户端零请求零依赖），
// 搜索 UI 在 public/docs.js、样式在 public/docs.css。
// 还会重生成全站 /sitemap.xml：页面集合 = 扫描 website/public 的真实 html 文件，
// lastmod = 各页在 git 里的最后提交日期——改页面后跑本脚本即同步，谷歌收录入口；
// tests/website-sitemap.test.ts 守着 sitemap 与磁盘页面集合不漂移。
// ⚠️ marked 按 CommonMark 判定加粗定界符的 flanking：** 紧贴中文标点（如 **「词」** 的开头、
// ……）** 的结尾）不会被解析成加粗，星号原样漏到页面上——写文档时让 ** 隔开标点或调整措辞。

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Marked } from 'marked'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = path.join(root, 'docs')
const outDir = path.join(root, 'website', 'public', 'docs')

const GITHUB_BLOB = 'https://github.com/bloghao/bloghao/blob/main/'

// 资源缓存版本：改动 style.css / docs.css / docs.js / docs-search-index.js / favicon.svg 后
// 改这里，重建时统一带上（搜索索引换版本号 = 访客立刻拿到新索引，不必等缓存过期）
const V = '?v=20261014d'

// 文档清单：slug 决定输出文件名与站内路径，顺序即侧栏与上下篇顺序
const DOCS = [
  { slug: 'deploy', file: 'DEPLOY.md', icon: '🚀', title: '部署教程', desc: '从注册 Cloudflare 到部署 Worker、绑定自定义域名、自动部署、备份与恢复，含 Docker 自托管。' },
  { slug: 'cloudflare', file: 'CLOUDFLARE-BASICS.md', icon: '☁️', title: 'Cloudflare 基础', desc: 'Workers、D1、R2、定时任务、域名与 Turnstile：看懂这套博客跑在 Cloudflare 上的每个部件，控制台巡检、常用命令与免费额度速查。' },
  { slug: 'guide', file: 'GUIDE.md', icon: '📖', title: '使用手册', desc: '后台导览、写文章全流程、快捷键、评论与媒体管理、设置逐项说明。' },
  { slug: 'plaza', file: 'PLAZA.md', icon: '🧭', title: '广场', desc: '内容聚合流：三步接入官方广场，让每篇文章与微博被更多博主看到；含混排口径与自建 hub。' },
  { slug: 'themes', file: 'THEMES.md', icon: '🎨', title: '主题开发', desc: '一套主题 = 八个必需渲染函数（+ 可选 member / rank）+ 全局 CSS，三步注册新主题。' },
  { slug: 'plugins', file: 'PLUGINS.md', icon: '🧩', title: '插件开发', desc: '一个 JS 文件扩展编辑器，window.BlogHao 插件 API 与加载机制，无需构建。' },
  { slug: 'api', file: 'API.md', icon: '🔌', title: 'API 参考', desc: '全部公开 / 管理接口与 HTML 净化白名单摘要，写自己的客户端。' },
  { slug: 'typography', file: 'wechat-typography-spec.md', icon: '🩺', title: '排版规范', desc: '微信编辑器插件开发规范的落地对照表与体检规则。' },
  { slug: 'demo', file: 'DEMO.md', icon: '🎪', title: '演示站指南', desc: '官方演示站的机制：仿真数据、每 2 小时重置、DEMO_MODE 门控与体验守卫。' },
  { slug: 'roadmap', file: 'ROADMAP.md', icon: '🗺️', title: '路线图', desc: '已上线能力与近期计划，按 A / B / C 优先级管理的开发方向。' },
  { slug: 'versions', file: 'VERSIONS.md', icon: '🏷️', title: '版本更新说明', desc: '从 2026-10-03 项目诞生到今天的大版本大事记：每个版本带来了什么，博客号一路怎么长成现在这样。' },
  { slug: 'changelog', file: '../CHANGELOG.md', icon: '📜', title: '更新日志', desc: '每个版本更新了哪些细节：新增、变更与修复，官方发布时回填；升级 = 重新部署，D1 自动迁移。' },
]
const byFile = new Map(DOCS.map((d) => [d.file, d]))

// 文档中心里体现、但不在 DOCS 渲染管线内的手写页（构建脚本只维护它的资源引用、搜索框与搜索脚本）。
// 搜索索引要给它们留一条页面级记录，否则搜「安全审计」会落空。
const EXTRA_PAGES = [
  { slug: 'security-audit', icon: '🛡️', title: '安全审计报告', desc: '2026-10 全量安全体检（大众版）：0 高危、27 项发现全部独立复核、21 项已修复上线。', handWritten: true },
]

const PAGE_ORDER = [
  ...DOCS.map((d) => ({ slug: d.slug, icon: d.icon, title: d.title, desc: d.desc, link: d.slug + '.html' })),
  ...EXTRA_PAGES.map((d) => ({ slug: d.slug, icon: d.icon, title: d.title, desc: d.desc, link: d.slug + '.html' })),
]

// 与 GitHub 一致的标题锚点 slug（文中目录 #1-站点地址一览 这类链接才能照常跳转）
function ghSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 标题内联 HTML → 纯文本（搜索索引用；marked 已把 & < > 转义过，这里还原回来）
function htmlToText(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

// ---------- 搜索索引：每篇文档 = 页面级记录（标题 + 描述 + 开篇引言）+ 小节级记录（h2/h3/h4） ----------

const SNIPPET_MAX = 96

// 小节摘要：标题之后、下一个标题之前的第一段可读正文，压成一行纯文本
function sectionSnippet(blocks) {
  const parts = []
  for (const b of blocks) {
    if (b.type === 'space') continue
    if (b.type === 'heading' || b.type === 'code' || b.type === 'table' || b.type === 'html') break
    if (b.type === 'paragraph' || b.type === 'text') {
      parts.push(b.text)
    } else if (b.type === 'blockquote' && Array.isArray(b.tokens)) {
      for (const inner of b.tokens) if (inner.type === 'paragraph' && inner.text) parts.push(inner.text)
    } else if (b.type === 'list' && Array.isArray(b.items)) {
      for (const item of b.items) {
        if (item.type === 'text' && item.text) parts.push(item.text)
        else if (Array.isArray(item.tokens)) for (const inner of item.tokens) if (inner.type === 'text' && inner.text) parts.push(inner.text)
      }
    }
    if (parts.length >= 2) break
  }
  return cleanSnippet(parts.join(' '))
}

function cleanSnippet(raw) {
  let s = String(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/^[#>\-*+\d.\s|:：]+/, '').trim()
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX - 1).trim() + '…'
  return s
}

// 开头的引言段（页面级记录的正文），用于「搜页面名 / 站点简介」也能命中
function pageSnippet(blocks) {
  const parts = []
  for (const b of blocks) {
    if (b.type === 'space') continue
    if (b.type === 'heading' || b.type === 'code' || b.type === 'table' || b.type === 'html') break
    if (b.type === 'paragraph' && b.text) parts.push(b.text)
    if (parts.length >= 2) break
  }
  return cleanSnippet(parts.join(' '))
}

// 把一篇已渲染的文档压成搜索索引条目：页面级 + 小节级（小节正文取标题后第一段）
function parseIndexData(meta, rendered, blocks) {
  const firstHeadingAt = blocks.findIndex((b) => b.type === 'heading')
  const leading = firstHeadingAt > 0 ? blocks.slice(0, firstHeadingAt) : []
  const intro = firstHeadingAt === 0 && blocks[0].depth === 1 ? pageSnippet(leading) : pageSnippet(blocks)

  const heads = []
  blocks.forEach((b, i) => { if (b.type === 'heading') heads.push({ level: b.depth, index: i }) })

  const sections = heads.map((h, n) => {
    const end = n + 1 < heads.length ? heads[n + 1].index : blocks.length
    return {
      level: h.level,
      anchor: rendered.anchorList[n],
      heading: htmlToText(rendered.headingHtml[n]),
      text: sectionSnippet(blocks.slice(h.index + 1, end)),
    }
  })

  return {
    slug: meta.slug,
    icon: meta.icon,
    title: meta.title,
    desc: meta.desc,
    link: meta.slug + '.html',
    intro,
    sections,
  }
}

// 手写页（security-audit.html）的章节：按 h2/h3 切段，逐段保留正文，供搜索直接定位到段落。
// 锚点取页面上的真实 id（构建流程会先给标题注入 chunk-N），不按顺序推算——
// 标题里混着 h4 时，按 h2/h3 序号推算会与注入结果错位、链到不存在的锚点。
function parseHandWrittenChunks(html) {
  const start = html.indexOf('<main>') !== -1 ? html.indexOf('<main>') : html.indexOf('<body>')
  const body = html.slice(start)
  const re = /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g
  const marks = []
  let m
  while ((m = re.exec(body))) {
    const idMatch = /\sid="([^"]+)"/.exec(m[2])
    marks.push({ level: Number(m[1]), id: idMatch ? idMatch[1] : '', text: htmlToText(m[3]), at: m.index })
  }
  if (!marks.length) return []
  const chunks = []
  if (marks[0].at > 0) chunks.push({ level: 1, id: '', heading: '', text: cleanSnippet(body.slice(0, marks[0].at)) })
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length
    chunks.push({ level: mark.level, id: mark.id, heading: mark.text, text: cleanSnippet(body.slice(mark.at, end)) })
  })
  return chunks
}

function buildSearchIndex(parsed, handWritten) {
  const entries = []
  for (const page of handWritten) {
    entries.push({
      slug: page.slug, level: 0, anchor: '', icon: page.icon, page: page.title, pageLink: page.link,
      title: page.title, text: page.desc || '', sec: page.title,
    })
    for (const c of page.chunks) {
      entries.push({
        slug: page.slug, level: c.level, anchor: c.id, icon: page.icon, page: page.title, pageLink: page.link,
        title: c.heading || page.title, text: c.text, sec: c.heading || page.title,
      })
    }
  }
  for (const p of parsed) {
    // 页面级记录的正文带上开篇引言：描述只有一句，只靠它很多常见词（如「备份」）会
    // 命中页面却给不出任何上下文；引言里的原句能让结果更可信，也让片段高亮有东西可显。
    const lead = [p.desc || '', p.intro || ''].filter(Boolean).join(' ')
    entries.push({
      slug: p.slug, level: 0, anchor: '', icon: p.icon, page: p.title, pageLink: p.link,
      title: p.title, text: lead, sec: p.title,
    })
    for (const s of p.sections) {
      entries.push({
        slug: p.slug, level: s.level, anchor: s.anchor, icon: p.icon, page: p.title, pageLink: p.link,
        title: s.heading, text: s.text, sec: s.heading,
      })
    }
  }
  return { v: 1, pages: PAGE_ORDER.map((p) => ({ slug: p.slug, icon: p.icon, title: p.title, desc: p.desc, link: p.link })), entries }
}

// 搜索索引落成独立脚本：全站共用一份、靠 URL 版本号刷新，页面不再各背 58 KB。
// 用普通 <script>（非 module、非 defer）挂在 head，所以 docs.js 执行时它一定已经在。
function searchIndexScript(index) {
  const json = JSON.stringify(index).replace(/<\//g, '<\\/')
  return `/* 由 website/build-docs.mjs 生成，勿手改：官网文档中心的站内搜索索引。
   数据来源：docs/*.md 的标题、描述、开篇引言与每个 h2/h3 小节的首段正文，外加手写的
   security-audit.html（按 h2/h3 切段）。改文档后重跑 npm run build:docs 即可更新。 */
window.__DOCS_SEARCH__ = ${json};
`
}

// 相对链接改写：docs 内互链 → 站内页；仓库内其他文件（../docker-poc/DEPLOY.md、
// CHANGELOG 里的 docs/RELEASING.md、docker-poc/DEPLOY-MICRO.md 这类带路径的）→ GitHub；其余原样保留
function rewriteHref(href) {
  if (href === 'https://deploy.workers.cloudflare.com/button') return '/assets/deploy-button.svg'
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const clean = href.replace(/^\.\//, '')
  // 跳出 docs/ 的相对链接（如 ../docker-poc/DEPLOY.md）指仓库其他文件，回落 GitHub
  if (clean.startsWith('../')) {
    return GITHUB_BLOB + path.posix.normalize(clean.replace(/^(\.\.\/)+/, ''))
  }
  const m = clean.match(/^([^/]+\.md)(#.*)?$/)
  if (m && byFile.has(m[1])) return byFile.get(m[1]).slug + '.html' + (m[2] || '')
  if (/^[^/]+\/.+\.md([#?]|$)/.test(clean)) return GITHUB_BLOB + clean
  if (/\.md([#?]|$)/.test(clean)) return GITHUB_BLOB + 'docs/' + clean
  return href
}

// 逐个文档渲染：marked + 渲染器覆盖（标题锚点 / 链接改写 / 代码块外壳），顺手收集「本页目录」与搜索索引骨架
async function renderDoc(doc) {
  const md = await readFile(path.join(docsDir, doc.file), 'utf8')
  const headings = []
  const seen = new Map()
  const used = new Set()
  const anchorList = []
  const headingHtml = []

  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading(node) {
        const inner = this.parser.parseInline(node.tokens)
        let id = ghSlug(node.text)
        const n = seen.get(id) || 0
        seen.set(id, n + 1)
        if (n > 0) id += '-' + n
        used.add(id)
        anchorList.push(id)
        headingHtml.push(inner)
        if (node.depth >= 2 && node.depth <= 3) headings.push({ depth: node.depth, id, text: htmlToText(inner) })
        return `<h${node.depth} id="${id}">${inner}</h${node.depth}>`
      },
      link(node) {
        const inner = this.parser.parseInline(node.tokens)
        const href = escapeHtml(rewriteHref(node.href))
        const external = /^https?:/.test(node.href)
        return `<a href="${href}"${node.title ? ` title="${escapeHtml(node.title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`
      },
      image(node) {
        const href = escapeHtml(rewriteHref(node.href))
        return `<img src="${href}" alt="${escapeHtml(node.text || '')}"${node.title ? ` title="${escapeHtml(node.title)}"` : ''} loading="lazy">`
      },
      code(node) {
        const lang = (node.lang || '').trim().split(/\s+/)[0]
        const body = escapeHtml(node.text)
        return `<div class="codeblock"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><pre><code>${body}</code></pre></div>`
      },
    },
  })

  const blocks = marked.lexer(md)
  let html = marked.parser(blocks)
  // 表格外包一层，窄屏横向滚动；代码围栏里的 <table> 已被转义，不会误伤
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')

  return { html, headings, ids: used, anchorList, headingHtml, blocks }
}

// ---------- 页面模板（导航 / 页脚与官网首页同款） ----------

const NAV = `
<header class="nav" id="nav">
  <div class="nav-inner">
    <a class="nav-logo" href="/index.html">
      <img src="/favicon.svg${V}" alt="博客号 logo">博客号 <span class="nav-logo-en">BlogHao</span>
    </a>
    <nav class="nav-links">
      <a href="index.html">文档中心</a>
      <a href="/index.html">返回官网</a>
    </nav>
    <div class="nav-cta">
      <a class="nav-demo" href="https://demo.bloghao.com" target="_blank" rel="noopener">在线演示 ↗</a>
      <a class="btn btn-ghost" href="https://github.com/bloghao/bloghao" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</header>`

const FOOTER = `
<footer class="footer">
  <div class="wrap footer-inner">
    <span>© <span id="year">2026</span> 博客号 BlogHao · MIT License</span>
    <span class="footer-links">
      <a href="/index.html">官网首页</a>
      <a href="https://github.com/bloghao/bloghao" target="_blank" rel="noopener">GitHub</a>
      <a href="https://demo.bloghao.com" target="_blank" rel="noopener">演示站</a>
      <a href="/llms.txt" target="_blank" rel="noopener">AI 索引</a>
    </span>
  </div>
</footer>`

function sidebar(activeSlug) {
  const items = DOCS.map((d) => {
    const cls = d.slug === activeSlug ? ' class="is-active"' : ''
    return `        <li><a${cls} href="${d.slug}.html">${d.icon} ${d.title}</a></li>`
  }).join('\n')
  return `
    <aside class="docs-sidebar">
      <div class="docs-search">
        <label class="docs-search-label" for="docs-search-input">🔍 搜索文档</label>
        <input id="docs-search-input" class="docs-search-input" type="search" role="combobox" autocomplete="off"
               aria-expanded="false" aria-controls="docs-search-list" aria-autocomplete="list"
               placeholder="搜标题 / 关键词，回车跳转" data-docs-search-input>
        <ul id="docs-search-list" class="docs-search-list" hidden data-docs-search-list></ul>
      </div>
      <a class="docs-side-title" href="index.html">📚 文档中心</a>
      <ul class="docs-side-list">
${items}
      </ul>
      <a class="docs-side-extra" href="/llms.txt" target="_blank" rel="noopener">🤖 llms.txt · AI 索引</a>
    </aside>`
}

function tocAside(headings) {
  if (headings.length < 3) return ''
  const links = headings
    .map((h) => `<li class="toc-d${h.depth}"><a href="#${h.id}" data-toc="${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('\n        ')
  return `
    <aside class="docs-toc">
      <div class="docs-toc-title">本页目录</div>
      <ul class="docs-toc-list">
        ${links}
      </ul>
    </aside>`
}

function pager(activeSlug) {
  const i = DOCS.findIndex((d) => d.slug === activeSlug)
  const prev = DOCS[i - 1]
  const next = DOCS[i + 1]
  const parts = []
  if (prev) parts.push(`<a class="docs-pager-link is-prev" href="${prev.slug}.html"><span>← 上一篇</span><b>${prev.icon} ${prev.title}</b></a>`)
  else parts.push('<span></span>')
  if (next) parts.push(`<a class="docs-pager-link is-next" href="${next.slug}.html"><span>下一篇 →</span><b>${next.icon} ${next.title}</b></a>`)
  else parts.push('<span></span>')
  return `\n  <nav class="docs-pager">\n    ${parts.join('\n    ')}\n  </nav>`
}

function page({ title, description, body, path }) {
  // SEO（2026-10 审计补齐）：canonical 自指绝对地址、og:url/og:image 绝对地址——
  // 相对 og:image（./assets/…）微信 / X / Telegram 抓不到分享图
  const url = `https://bloghao.com${path}`
  const seo = `<link rel="canonical" href="${url}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://bloghao.com/assets/editor.png">`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
${seo}
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<link rel="icon" href="/favicon.svg${V}" type="image/svg+xml">
<link rel="stylesheet" href="/style.css${V}">
<link rel="stylesheet" href="/docs.css${V}">
<script src="/docs/docs-search-index.js${V}"></script>
</head>
<body>
${NAV}
${body}
${FOOTER}
<script src="/docs.js${V}" defer></script>
</body>
</html>
`
}

function docPage(doc, { html, headings }) {
  const repoPath = doc.file.startsWith('../') ? doc.file.slice(3) : 'docs/' + doc.file
  const body = `
<div class="docs-shell${headings.length >= 3 ? ' docs-shell-toc' : ''}">
  ${sidebar(doc.slug)}
  <main class="docs-main">
    <div class="docs-crumbs">
      <a href="index.html">文档中心</a><span>/</span><b>${doc.icon} ${doc.title}</b>
      <a class="doc-edit" href="${GITHUB_BLOB}${repoPath}" target="_blank" rel="noopener noreferrer">✏️ 编辑此页</a>
    </div>
    <article class="doc-md">
${html}
    </article>
  ${pager(doc.slug)}
  </main>
  ${tocAside(headings)}
</div>`
  return page({
    title: `${doc.title} - 博客号文档`,
    description: doc.desc,
    body,
    path: `/docs/${doc.slug}.html`,
  })
}

// 文档中心落地页
function indexPage() {
  const cards = PAGE_ORDER.map(
    (d) => `
        <a class="card card-link" href="${d.link}" data-search-card data-search-text="${escapeHtml(`${d.title} ${d.desc}`)}">
          <h3>${d.icon} ${d.title}</h3><p>${d.desc}</p>
        </a>`
  ).join('')
  const body = `
<main id="top">
  <section class="hero docs-hero">
    <div class="hero-bg" aria-hidden="true"></div>
    <div class="wrap hero-inner">
      <span class="hero-badge">📖 博客号文档中心 · 与仓库 docs/ 同步</span>
      <h1>文档，读了就会用。</h1>
      <p class="hero-sub">部署、写作、主题、插件、API——全部中文，直接在官网读，不用去 GitHub。<br class="pc-only">想改哪里？每篇右上角「编辑此页」欢迎 PR。</p>
      <div class="docs-search-hero">
        <label class="docs-search-label" for="docs-search-input">🔍 搜索文档</label>
        <input id="docs-search-input" class="docs-search-input" type="search" role="combobox" autocomplete="off"
               aria-expanded="false" aria-controls="docs-search-list" aria-autocomplete="list"
               placeholder="试试：定时任务 / 会员积分 / Turnstile / 部署" data-docs-search-input>
        <ul id="docs-search-list" class="docs-search-list" hidden data-docs-search-list></ul>
      </div>
    </div>
  </section>
  <section class="section docs-home-grid">
    <div class="wrap">
      <div class="grid-3 grid-docs">${cards}
        <a class="card card-link" href="/llms.txt" target="_blank" rel="noopener">
          <h3>🤖 AI 索引</h3><p>llms.txt 文档索引：AI 助手与智能体从这里一步读到全部开发文档的 Markdown 源文件。</p>
        </a>
      </div>
      <p class="docs-home-note" data-search-empty hidden>没有匹配的文档，换个词试试；也可以直接 <a href="https://github.com/bloghao/bloghao/issues" target="_blank" rel="noopener noreferrer">去仓库提 Issue</a>。</p>
      <p class="docs-home-note">没找到想看的？去 <a href="https://github.com/bloghao/bloghao/issues" target="_blank" rel="noopener noreferrer">仓库提 Issue</a>，或先去 <a href="https://demo.bloghao.com" target="_blank" rel="noopener">演示站</a> 转一圈。</p>
    </div>
  </section>
</main>`
  return page({
    title: '文档中心 - 博客号 BlogHao',
    description: '博客号 BlogHao 全部中文文档：部署教程、使用手册、Cloudflare 基础、主题开发、插件开发、API 参考、排版规范、演示站指南、路线图、版本大事记与逐版本更新日志。',
    body,
    path: '/docs/',
  })
}

// 手写页（security-audit.html）维护：资源引用本轮化 + 顶栏搜索框 + 标题锚点 + 搜索脚本。
// 手写页是定点注入，不能按顺序“放过”——每步都归一化到同一目标形态，
// 这样不管上一轮补到哪一步，重新构建都能收敛到正确结果（幂等）。
async function patchHandWrittenPage() {
  const file = path.join(outDir, 'security-audit.html')
  // 先把 CRLF 归一到 LF：手工维护的页面在 Windows 检出时是 CRLF，锚点按 LF 写更稳；
  // 仓库 core.autocrlf=true，提交时统一按 LF 存储，输出一律 LF。
  let src = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
  const before = src

  const navSearch = `\n    <div class="nav-search">\n      <input id="docs-search-input" class="docs-search-input docs-search-input-compact" type="search" role="combobox" autocomplete="off"\n             aria-expanded="false" aria-controls="docs-search-list" aria-autocomplete="list"\n             placeholder="🔍 搜索文档" aria-label="搜索文档" data-docs-search-input>\n      <ul id="docs-search-list" class="docs-search-list docs-search-list-compact" hidden data-docs-search-list></ul>\n    </div>\n  </div>\n</header>`

  const steps = [
    {
      what: '导航搜索框',
      run: () => {
        const head = src.slice(0, src.indexOf('</header>') + '</header>'.length)
        if (head.includes('data-docs-search-input')) return false
        const at = src.lastIndexOf('\n  </div>\n</header>')
        if (at === -1) throw new Error('security-audit.html 结构变了，找不到 </header> 前的导航末尾')
        src = src.slice(0, at) + navSearch + src.slice(at + '\n  </div>\n</header>'.length)
        return true
      },
    },
    {
      what: '样式引用',
      run: () => {
        const before2 = src
        src = src.replace(
          /<link rel="stylesheet" href="(?:\.\.\/|\/)style\.css[^"]*">/,
          `<link rel="stylesheet" href="/style.css${V}">`
        )
        // docs.css 已有引用先归一到当前 V（V 升位重建的幂等性：否则旧版本残留会让自检
        // 误报「注入不完整」，或落入插入分支造成重复注入），从未有过才插入
        src = src.replace(
          /<link rel="stylesheet" href="(?:\.\.\/|\/)docs\.css[^"]*">/,
          `<link rel="stylesheet" href="/docs.css${V}">`
        )
        if (!src.includes('/docs.css')) {
          src = src.replace(
            new RegExp(`<link rel="stylesheet" href="/style\\.css${V}">`),
            `<link rel="stylesheet" href="/style.css${V}">\n<link rel="stylesheet" href="/docs.css${V}">`
          )
        }
        return src !== before2
      },
    },
    {
      what: '站点图标',
      run: () => {
        const before2 = src
        src = src.replace(/(href=")(?:\.\.\/|\/)favicon\.svg[^"]*(")/g, `$1/favicon.svg${V}$2`)
        src = src.replace(/(src=")(?:\.\.\/|\/)favicon\.svg[^"]*(")/g, `$1/favicon.svg${V}$2`)
        return src !== before2
      },
    },
    {
      what: '规范链接与分享图',
      run: () => {
        const before2 = src
        if (!src.includes('<link rel="canonical"')) {
          const seo = `<link rel="canonical" href="https://bloghao.com/docs/security-audit.html">\n<meta property="og:url" content="https://bloghao.com/docs/security-audit.html">\n<meta property="og:image" content="https://bloghao.com/assets/editor.png">`
          src = src.replace('</title>', `</title>\n${seo}`)
        }
        return src !== before2
      },
    },
    {
      what: '回官网 / 文档中心链接',
      run: () => {
        const before2 = src
        src = src.replace(/(href=")(?:\.\.\/|\/)index\.html("|#)/g, (all, pre, tail) => `${pre}/index.html${tail}`)
        return src !== before2
      },
    },
    {
      what: '标题锚点',
      run: () => {
        const before2 = src
        let n = 0
        src = src.replace(/<h([23])([^>]*)>/g, (all, lvl, attrs) => {
          if (/\sid="[^"]*"/.test(attrs)) return all
          n += 1
          return `<h${lvl}${attrs} id="chunk-${n}">`
        })
        if (!src.includes('#nav [id], h2[id], h3[id]')) {
          src = src.replace('</style>', '#nav [id], h2[id], h3[id] { scroll-margin-top: 86px; }\n</style>')
        }
        return src !== before2
      },
    },
    {
      what: '脚本与索引',
      run: () => {
        const before2 = src
        src = src.replace(/<script>window\.__DOCS_SEARCH__ = [\s\S]*?<\/script>\n?/g, '')
        src = src.replace(/<script src="(?:\.\.\/|\/|\/docs\/)(?:docs\/)?docs-search-index\.js[^"]*"[^>]*><\/script>\n?/g, '')
        src = src.replace(/<script src="(?:\.\.\/|\/)docs\.js[^"]*" defer><\/script>\n?/g, '')
        src = src.replace(/<script src="(?:\.\.\/|\/)site\.js[^"]*" defer><\/script>\n?/g, '')
        if (!src.includes('</body>')) throw new Error('security-audit.html 结构变了，找不到 </body>')
        src = src.replace(
          '</body>',
          `<script src="/docs/docs-search-index.js${V}"></script>\n<script src="/site.js${V}" defer></script>\n<script src="/docs.js${V}" defer></script>\n</body>`
        )
        return src !== before2
      },
    },
  ]

  let changed = 0
  for (const s of steps) if (s.run()) changed++

  // 自检：任何 ../ 残留、重复注入、引用缺失都算失败，不静默通过
  if (/href="\.\.\//.test(src) || /src="\.\.\//.test(src)) {
    throw new Error('security-audit.html 仍有 ../ 相对引用：' + (src.match(/\.\.\/[^"']+/g) || []).slice(0, 3).join(', '))
  }
  if (!src.includes('/docs/docs-search-index.js') || !src.includes('/docs.js') || !src.includes(`/docs.css${V}`) || !src.includes('data-docs-search-input')) {
    throw new Error('security-audit.html 注入不完整（索引 / docs.js / docs.css / 搜索框 缺一）')
  }
  if (/window\.__DOCS_SEARCH__/.test(src)) {
    throw new Error('security-audit.html 里出现了内联索引——索引已改为独立文件，页面只引用 /docs/docs-search-index.js')
  }
  const scriptCount = (src.match(/<script src="\/docs\.js/g) || []).length
  const indexScripts = (src.match(/<script src="\/docs\/docs-search-index\.js/g) || []).length
  if (scriptCount !== 1 || indexScripts !== 1) {
    throw new Error(`security-audit.html 注入重复：docs.js ×${scriptCount}、索引脚本 ×${indexScripts}`)
  }

  if (src !== before) await writeFile(file, src, 'utf8')
  const chunks = parseHandWrittenChunks(src)
  if (!chunks.length) throw new Error('security-audit.html 里找不到可索引的小节（h2/h3）')
  return { patched: src !== before, chunks }
}

// ---------- 主流程 ----------

await mkdir(outDir, { recursive: true })

// 渲染全部文档；手写页的搜索记录依赖它先完成注入（标题锚点在补丁里生成），
// 所以顺序是：渲染 → 补手写页（拿 chunks）→ 组索引 → 写索引文件 → 写全部页面。
const renderedDocs = new Map()
const parsedDocs = []
for (const doc of DOCS) {
  const r = await renderDoc(doc)
  renderedDocs.set(doc.slug, r)
  parsedDocs.push(parseIndexData(doc, r, r.blocks))
}

const { patched, chunks } = await patchHandWrittenPage()
const handWritten = EXTRA_PAGES.map((p) => ({ ...p, link: p.slug + '.html', chunks: p.slug === 'security-audit' ? chunks : [] }))
const searchIndex = buildSearchIndex(parsedDocs, handWritten)

await writeFile(path.join(outDir, 'docs-search-index.js'), searchIndexScript(searchIndex), 'utf8')
await writeFile(path.join(outDir, 'index.html'), indexPage(), 'utf8')

for (const doc of DOCS) {
  const r = renderedDocs.get(doc.slug)
  r.html = r.html.replace(/href="([a-z-]+)\.html#([^"]+)"/g, (all, slug, anchor) => {
    const target = DOCS.find((d) => d.slug === slug)
    if (!target || target.slug === doc.slug || renderedDocs.get(slug).ids.has(anchor)) return all
    return `href="${GITHUB_BLOB}docs/${target.file}#${anchor}"`
  })
  await writeFile(path.join(outDir, doc.slug + '.html'), docPage(doc, r), 'utf8')
  const parsed = parsedDocs.find((p) => p.slug === doc.slug)
  const repoPath = doc.file.startsWith('../') ? doc.file.slice(3) : 'docs/' + doc.file
  console.log(`✓ docs/${doc.slug}.html  ←  ${repoPath}（目录 ${r.headings.length} 条，索引 ${parsed.sections.length} 小节）`)
}

console.log(`✓ docs/security-audit.html  ←  手写页（${patched ? '已更新资源引用与搜索框' : '无需变更'}，索引 ${chunks.length} 小节）`)
console.log(`✓ docs/docs-search-index.js  ←  搜索索引（${searchIndex.pages.length} 篇 / ${searchIndex.entries.length} 条记录，独立文件全站共用）`)

// ---------- 全站 sitemap.xml（谷歌收录入口，勿手改） ----------
// 页面集合一律以磁盘扫描为准（website/public 下的全部 html），与部署产物天然一致；
// lastmod 取该页面文件在 git 的最后提交日期（新文件未提交时回落文件修改日期）。

const SITE_URL = 'https://bloghao.com'
const publicDir = path.join(root, 'website', 'public')

async function collectHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...(await collectHtmlFiles(full)))
    else if (e.name.endsWith('.html')) files.push(path.relative(publicDir, full).split(path.sep).join('/'))
  }
  return files
}

// sitemap 里的规范形态：目录页去 index.html（/、/docs/、/plaza/），其余保留文件名
function pageUrlOf(relpath) {
  if (relpath === 'index.html') return SITE_URL + '/'
  if (relpath.endsWith('/index.html')) return SITE_URL + '/' + relpath.slice(0, -'index.html'.length)
  return SITE_URL + '/' + relpath
}

function urlMeta(url) {
  if (url === SITE_URL + '/') return { changefreq: 'weekly', priority: '1.0' }
  if (url === SITE_URL + '/docs/') return { changefreq: 'weekly', priority: '0.9' }
  if (url === SITE_URL + '/plaza/') return { changefreq: 'weekly', priority: '0.8' }
  if (url.startsWith(SITE_URL + '/docs/')) return { changefreq: 'monthly', priority: '0.7' }
  return { changefreq: 'monthly', priority: '0.5' }
}

async function gitLastmod(relpath) {
  try {
    // relpath 相对 website/public，git 命令 cwd 是仓库根——路径必须拼回前缀才能命中，
    // 否则静默回落 mtime，全站 lastmod 恒为构建当天
    const d = execSync(`git log -1 --format=%cs -- ${JSON.stringify(`website/public/${relpath}`)}`, { cwd: root, encoding: 'utf8' }).trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  } catch { /* 无 git 环境时回落 mtime */ }
  const m = await stat(path.join(publicDir, relpath))
  return m.mtime.toISOString().slice(0, 10)
}

const htmlFiles = (await collectHtmlFiles(publicDir)).sort() // '/' 与前缀目录天然排前，输出稳定
const sitemapEntries = []
for (const rel of htmlFiles) {
  const url = pageUrlOf(rel)
  const meta = urlMeta(url)
  sitemapEntries.push(
    `  <url>\n    <loc>${url}</loc>\n    <lastmod>${await gitLastmod(rel)}</lastmod>\n    <changefreq>${meta.changefreq}</changefreq>\n    <priority>${meta.priority}</priority>\n  </url>`
  )
}
await writeFile(
  path.join(publicDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 website/build-docs.mjs 生成，勿手改：页面集合 = 扫描 website/public 的全部 html，
     lastmod = 各页在 git 的最后提交日期；改页面后跑 npm run build:docs 即同步，
     tests/website-sitemap.test.ts 守着与磁盘页面集合一致。 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</urlset>
`,
  'utf8'
)

console.log(`✓ sitemap.xml  ←  全站 ${sitemapEntries.length} 个页面（git lastmod，谷歌收录入口）`)
console.log(`\n完成：${DOCS.length} 篇文档页 + 文档中心首页 + 安全审计页 + 搜索索引 + sitemap → website/public/`)
