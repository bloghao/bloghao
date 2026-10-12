import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// ── 官网文档中心守卫（website/public/docs/，生成物随仓库提交）──
//
// 背景：bloghao.com/docs/index.html 曾因源站缺文件被回退成首页副本，访客点到的是
// 「没样式的首页」；同时生成的文档页资源引用是 ../style.css 这类相对路径，在
// /docs（无斜杠）地址下会解析到 /docs/style.css，同样整页丢样式。
// 这里钉住四件事：① 文档中心与各文档页都在、资源引用一律根绝对；
// ② 搜索索引文件存在、可解析、覆盖全部页面、锚点真实存在（索引是独立文件，页面不各自内联）；
// ③ 每张页面都挂上搜索框与索引脚本；④ 手写页（security-audit.html）同口径。
// 改了 website/build-docs.mjs 或 docs/*.md 之后必须重跑 `npm run build:docs`，
// 否则这些断言会（也应该）红。

const DOCS_DIR = new URL('../website/public/docs/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, DOCS_DIR), 'utf8')

// 生成页清单：除手写的 security-audit.html 外都出自 build-docs.mjs
const allPages = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.html')).sort()
const generated = allPages.filter((f) => f !== 'security-audit.html')

const INDEX_SCRIPT = '/docs/docs-search-index.js'

interface SearchEntry {
  slug: string
  level: number
  anchor: string
  page: string
  pageLink: string
  title: string
  text: string
}
interface SearchIndex {
  v: number
  pages: { slug: string; title: string; link: string }[]
  entries: SearchEntry[]
}

function readIndexFile(): SearchIndex {
  const js = read('docs-search-index.js')
  const marker = 'window.__DOCS_SEARCH__ = '
  const start = js.indexOf(marker)
  assert.ok(start !== -1, 'docs-search-index.js 里找不到 window.__DOCS_SEARCH__（构建脚本没生成？）')
  // 从赋值末尾收尾（前置文件头注释里也有分号，不能用 indexOf(';')）
  const end = js.lastIndexOf(';')
  assert.ok(end > start, 'docs-search-index.js 的赋值语句没有收尾')
  return JSON.parse(js.slice(start + marker.length, end)) as SearchIndex
}

test('文档中心的 index.html 存在且是文档中心（不是被首页副本顶替）', () => {
  const html = read('index.html')
  assert.match(html, /<title>文档中心 - 博客号 BlogHao<\/title>/, 'index.html 的 <title> 不是文档中心')
  assert.ok(html.includes('博客号文档中心'), 'index.html 缺少文档中心的横幅文案')
})

test('每张页面都引用了四件根绝对资源（无 ../ 相对引用）', () => {
  for (const f of allPages) {
    const html = read(f)
    for (const asset of ['/style.css', '/docs.css', '/favicon.svg', '/docs.js']) {
      assert.ok(html.includes(`"${asset}`), `${f} 缺少根绝对引用 ${asset}`)
    }
    const rel = html.match(/(?:href|src)="\.\.\/[^"]*"/g)
    assert.equal(rel, null, `${f} 仍有相对路径引用：${rel?.slice(0, 3).join(', ')}——/docs（无斜杠）访问时会解析错、页面丢样式`)
  }
})

test('每张页面都挂上搜索框与索引脚本（索引为独立文件）', () => {
  for (const f of allPages) {
    const html = read(f)
    assert.ok(html.includes('data-docs-search-input'), `${f} 缺少搜索框（data-docs-search-input）`)
    assert.ok(html.includes(INDEX_SCRIPT), `${f} 缺少索引脚本引用 ${INDEX_SCRIPT}`)
    assert.ok(!html.includes('window.__DOCS_SEARCH__'), `${f} 里出现了内联索引——索引应只在 docs-search-index.js 里`)
  }
  const idx = readIndexFile()
  assert.equal(idx.v, 1, '索引版本号异常')
  assert.ok(idx.entries.length > 100, `索引条目过少（${idx.entries.length}），像是没重建`)
})

test('搜索索引覆盖全部文档页，且每个小节锚点在目标页面里真实存在', () => {
  const idx = readIndexFile()
  const slugs = new Set(idx.entries.map((e) => e.slug))
  // index.html 是文档中心落地页自己，不需要在索引里给自己留记录
  const expected = allPages.filter((f) => f !== 'index.html').map((f) => f.replace('.html', ''))
  for (const slug of expected) {
    assert.ok(slugs.has(slug), `索引缺少 ${slug} 的记录——build-docs.mjs 的 DOCS/EXTRA_PAGES 与生成页不同步`)
  }
  const anchors = idx.entries.filter((e) => e.anchor)
  const byPage = new Map<string, string>()
  for (const e of anchors) if (!byPage.has(e.pageLink)) byPage.set(e.pageLink, read(e.pageLink))
  for (const e of anchors) {
    assert.ok(byPage.get(e.pageLink)!.includes(`id="${e.anchor}"`), `锚点不存在：${e.pageLink}#${e.anchor}（索引与页面脱节，点了会跳到页首）`)
  }
})

test('搜索索引的关键词数据非空（标题/摘要被抽出来了）', () => {
  const idx = readIndexFile()
  const sections = idx.entries.filter((e) => e.level > 0)
  assert.ok(sections.length > 150, `小节级条目只有 ${sections.length} 条，摘要提取可能失效`)
  const withText = sections.filter((e) => e.text && e.text.length > 8)
  assert.ok(withText.length / sections.length > 0.6, '小节摘要大面积为空，正文提取逻辑坏了')
})

test('手写页（security-audit.html）与生成页同口径：资源绝对引用 + 搜索接线 + 标题锚点', () => {
  const html = read('security-audit.html')
  for (const asset of ['/style.css', '/docs.css', '/docs.js', '/favicon.svg']) {
    assert.ok(html.includes(`"${asset}`), `security-audit.html 缺少根绝对引用 ${asset}`)
  }
  assert.equal(html.match(/(?:href|src)="\.\.\/[^"]*"/g), null, 'security-audit.html 仍有相对路径引用')
  assert.ok(html.includes('data-docs-search-input'), 'security-audit.html 缺少搜索框')
  assert.ok(html.includes(INDEX_SCRIPT), 'security-audit.html 缺少索引脚本引用')
  assert.equal((html.match(/<script src="\/docs\.js/g) || []).length, 1, 'security-audit.html 的 docs.js 被重复注入')
  // 索引要能跳到该页的具体小节，标题必须带 id（否则点了只能回到页首）
  const ids = new Set([...html.matchAll(/<h[23]\s[^>]*id="([^"]+)"/g)].map((m) => m[1]))
  const idx = readIndexFile()
  const auditAnchors = idx.entries.filter((e) => e.slug === 'security-audit' && e.anchor)
  assert.ok(auditAnchors.length >= 10, `安全审计页的索引小节只有 ${auditAnchors.length} 条`)
  for (const e of auditAnchors) {
    assert.ok(ids.has(e.anchor), `安全审计页的锚点 ${e.anchor} 在页面标题上不存在`)
  }
})

test('文档中心的卡片与搜索过滤挂钩（data-search-card）', () => {
  const html = read('index.html')
  const cards = (html.match(/data-search-card/g) || []).length
  assert.ok(cards >= 13, `文档中心只有 ${cards} 张带 data-search-card 的卡片，期望覆盖全部文档页`)
  assert.ok(html.includes('data-search-empty'), '文档中心缺少「没有匹配」提示位')
})
