#!/usr/bin/env node
// 官网文档生成器：把仓库 docs/*.md 预渲染成与官网同款配色 / 导航 / 页脚的静态文档页，
// 输出到 website/public/docs/（生成结果直接提交，部署仍是零构建纯静态）。
// 用法：仓库根目录 npm run build:docs；docs/ 下的文档改动后重新跑一遍即可。
// 说明：站内互链（GUIDE.md → guide.html）自动改写；指向仓库其他文件的相对链接
// （如 ../docker-poc/DEPLOY.md）回落到 GitHub；外链一律新窗口打开。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Marked } from 'marked'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = path.join(root, 'docs')
const outDir = path.join(root, 'website', 'public', 'docs')

const GITHUB_BLOB = 'https://github.com/bloghao/bloghao/blob/main/'

// 文档清单：slug 决定输出文件名与站内路径，顺序即侧栏与上下篇顺序
const DOCS = [
  { slug: 'deploy', file: 'DEPLOY.md', icon: '🚀', title: '部署教程', desc: '从注册 Cloudflare 到部署 Worker、绑定自定义域名、自动部署、备份与恢复，含 Docker 自托管。' },
  { slug: 'guide', file: 'GUIDE.md', icon: '📖', title: '使用手册', desc: '后台导览、写文章全流程、快捷键、评论与媒体管理、设置逐项说明。' },
  { slug: 'plaza', file: 'PLAZA.md', icon: '🧭', title: '广场', desc: '内容聚合流：三步接入官方广场，让每篇文章与微博被更多博主看到；含混排口径与自建 hub。' },
  { slug: 'themes', file: 'THEMES.md', icon: '🎨', title: '主题开发', desc: '一套主题 = 八个必需渲染函数（+ 可选 member / rank）+ 全局 CSS，三步注册新主题。' },
  { slug: 'plugins', file: 'PLUGINS.md', icon: '🧩', title: '插件开发', desc: '一个 JS 文件扩展编辑器，window.BlogHao 插件 API 与加载机制，无需构建。' },
  { slug: 'api', file: 'API.md', icon: '🔌', title: 'API 参考', desc: '全部公开 / 管理接口与 HTML 净化白名单摘要，写自己的客户端。' },
  { slug: 'typography', file: 'wechat-typography-spec.md', icon: '🩺', title: '排版规范', desc: '微信编辑器插件开发规范的落地对照表与体检规则。' },
  { slug: 'demo', file: 'DEMO.md', icon: '🎪', title: '演示站指南', desc: '官方演示站的机制：仿真数据、每 2 小时重置、DEMO_MODE 门控与体验守卫。' },
  { slug: 'roadmap', file: 'ROADMAP.md', icon: '🗺️', title: '路线图', desc: '已上线能力与近期计划，按 A / B / C 优先级管理的开发方向。' },
]
const byFile = new Map(DOCS.map((d) => [d.file, d]))

// 与 GitHub 一致的标题锚点 slug（文中目录 #1-站点地址一览 这类链接才能照常跳转）
function ghSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 相对链接改写：docs 内互链 → 站内页；仓库内其他文件 → GitHub；其余原样保留
function rewriteHref(href) {
  if (href === 'https://deploy.workers.cloudflare.com/button') return '../assets/deploy-button.svg'
  if (/^(https?:|mailto:|#)/.test(href)) return href
  const clean = href.replace(/^\.\//, '')
  // 跳出 docs/ 的相对链接（如 ../docker-poc/DEPLOY.md）指仓库其他文件，回落 GitHub
  if (clean.startsWith('../')) {
    return GITHUB_BLOB + path.posix.normalize(clean.replace(/^(\.\.\/)+/, ''))
  }
  const m = clean.match(/^([^/]+\.md)(#.*)?$/)
  if (m && byFile.has(m[1])) return byFile.get(m[1]).slug + '.html' + (m[2] || '')
  if (/\.md([#?]|$)/.test(clean)) return GITHUB_BLOB + 'docs/' + clean
  return href
}

// 逐个文档渲染：marked + 渲染器覆盖（标题锚点 / 链接改写 / 代码块外壳），顺手收集「本页目录」
async function renderDoc(doc) {
  const md = await readFile(path.join(docsDir, doc.file), 'utf8')
  const headings = []
  const seen = new Map()
  const used = new Set()

  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens)
        let id = ghSlug(token.text)
        const n = seen.get(id) || 0
        seen.set(id, n + 1)
        if (n > 0) id += '-' + n
        used.add(id)
        if (token.depth >= 2 && token.depth <= 3) headings.push({ depth: token.depth, id, text: inner.replace(/<[^>]+>/g, '') })
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>`
      },
      link(token) {
        const inner = this.parser.parseInline(token.tokens)
        const href = escapeHtml(rewriteHref(token.href))
        const external = /^https?:/.test(token.href)
        return `<a href="${href}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`
      },
      image(token) {
        const href = escapeHtml(rewriteHref(token.href))
        return `<img src="${href}" alt="${escapeHtml(token.text || '')}"${token.title ? ` title="${escapeHtml(token.title)}"` : ''} loading="lazy">`
      },
      code(token) {
        const lang = (token.lang || '').trim().split(/\s+/)[0]
        const body = escapeHtml(token.text)
        return `<div class="codeblock"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><pre><code>${body}</code></pre></div>`
      },
    },
  })

  let html = marked.parse(md)
  // 表格外包一层，窄屏横向滚动；代码围栏里的 <table> 已被转义，不会误伤
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')

  return { html, headings, ids: used }
}

// ---------- 页面模板（导航 / 页脚与官网首页同款） ----------

const NAV = `
<header class="nav" id="nav">
  <div class="nav-inner">
    <a class="nav-logo" href="../index.html">
      <img src="../favicon.svg" alt="博客号 logo">博客号 <span class="nav-logo-en">BlogHao</span>
    </a>
    <nav class="nav-links">
      <a href="index.html">文档中心</a>
      <a href="../index.html">返回官网</a>
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
      <a href="../index.html">官网首页</a>
      <a href="https://github.com/bloghao/bloghao" target="_blank" rel="noopener">GitHub</a>
      <a href="https://demo.bloghao.com" target="_blank" rel="noopener">演示站</a>
      <a href="../llms.txt" target="_blank" rel="noopener">AI 索引</a>
    </span>
  </div>
</footer>`

function sidebar(activeSlug) {
  const items = DOCS.map((d) => {
    const cls = d.slug === activeSlug ? ' class="is-active"' : ''
    return `      <li><a${cls} href="${d.slug}.html">${d.icon} ${d.title}</a></li>`
  }).join('\n')
  return `
    <aside class="docs-sidebar">
      <a class="docs-side-title" href="index.html">📚 文档中心</a>
      <ul class="docs-side-list">
${items}
      </ul>
      <a class="docs-side-extra" href="../llms.txt" target="_blank" rel="noopener">🤖 llms.txt · AI 索引</a>
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

function page({ title, description, body, withToc }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../style.css">
<link rel="stylesheet" href="../docs.css">
</head>
<body>
${NAV}
${body}
${FOOTER}
<script src="../docs.js" defer></script>
</body>
</html>
`
}

function docPage(doc, { html, headings }) {
  const body = `
<div class="docs-shell${headings.length >= 3 ? ' docs-shell-toc' : ''}">
  ${sidebar(doc.slug)}
  <main class="docs-main">
    <div class="docs-crumbs">
      <a href="index.html">文档中心</a><span>/</span><b>${doc.icon} ${doc.title}</b>
      <a class="doc-edit" href="${GITHUB_BLOB}docs/${doc.file}" target="_blank" rel="noopener noreferrer">✏️ 编辑此页</a>
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
  })
}

// 文档中心落地页
function indexPage() {
  const cards = DOCS.map(
    (d) => `
        <a class="card card-link" href="${d.slug}.html">
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
    </div>
  </section>
  <section class="section docs-home-grid">
    <div class="wrap">
      <div class="grid-3 grid-docs">${cards}
        <a class="card card-link" href="../llms.txt" target="_blank" rel="noopener">
          <h3>🤖 AI 索引</h3><p>llms.txt 文档索引：AI 助手与智能体从这里一步读到全部开发文档的 Markdown 源文件。</p>
        </a>
      </div>
      <p class="docs-home-note">没找到想看的？去 <a href="https://github.com/bloghao/bloghao/issues" target="_blank" rel="noopener noreferrer">仓库提 Issue</a>，或先去 <a href="https://demo.bloghao.com" target="_blank" rel="noopener">演示站</a> 转一圈。</p>
    </div>
  </section>
</main>`
  return page({
    title: '文档中心 - 博客号 BlogHao',
    description: '博客号 BlogHao 全部中文文档：部署教程、使用手册、主题开发、插件开发、API 参考、排版规范、演示站指南与路线图。',
    body,
  })
}

// ---------- 主流程 ----------

await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'index.html'), indexPage(), 'utf8')

// 第一遍：全部渲染并收集各页标题锚点；第二遍：跨页锚点若未命中目标页（作者按 GitHub 锚点手写、
// 或目标文档已改名），回落 GitHub 对应文件，避免站内死链
const renderedDocs = new Map()
for (const doc of DOCS) renderedDocs.set(doc.slug, await renderDoc(doc))
for (const doc of DOCS) {
  const r = renderedDocs.get(doc.slug)
  r.html = r.html.replace(/href="([a-z-]+)\.html#([^"]+)"/g, (all, slug, anchor) => {
    const target = DOCS.find((d) => d.slug === slug)
    if (!target || target.slug === doc.slug || renderedDocs.get(slug).ids.has(anchor)) return all
    return `href="${GITHUB_BLOB}docs/${target.file}#${anchor}"`
  })
  await writeFile(path.join(outDir, doc.slug + '.html'), docPage(doc, r), 'utf8')
  console.log(`✓ docs/${doc.slug}.html  ←  docs/${doc.file}（目录 ${r.headings.length} 条）`)
}
console.log(`\n完成：${DOCS.length} 篇文档页 + 文档中心首页 → website/public/docs/`)
