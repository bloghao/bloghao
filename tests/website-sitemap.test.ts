import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ── 官网 SEO 收录守卫：sitemap.xml 的 URL 集合必须与 website/public 真实存在的 html 页面
// 一一对应（sitemap 由 build-docs.mjs 重建时按磁盘扫描自动重生成，新增/下线页面忘跑
// npm run build:docs 时这里就红）；robots.txt 必须声明 Sitemap——源站此前没有 robots.txt，
// 线上那份是 Cloudflare 托管的 content-signals 段，收录入口断了一截；公开页面一律不得携带
// noindex（谷歌收录出过问题，谁要加必须是有意为之并同步改本测试）。──

const SITE = 'https://bloghao.com'
const publicDir = fileURLToPath(new URL('../website/public', import.meta.url))

function listHtml(dir: string = publicDir): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listHtml(full))
    else if (e.name.endsWith('.html')) out.push(path.relative(publicDir, full).split(path.sep).join('/'))
  }
  return out
}

// 与 build-docs.mjs 的 pageUrlOf 同口径：目录页用去 index.html 的规范形态
function expectedUrlOf(relpath: string): string {
  if (relpath === 'index.html') return SITE + '/'
  if (relpath.endsWith('/index.html')) return SITE + '/' + relpath.slice(0, -'index.html'.length)
  return SITE + '/' + relpath
}

function sitemapLocs(): string[] {
  const xml = readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8')
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1])
}

test('sitemap.xml 页面集合与 website/public 的 html 文件一一对应', () => {
  const expected = listHtml().map(expectedUrlOf).sort()
  const actual = sitemapLocs().sort()
  assert.deepEqual(
    actual,
    expected,
    'sitemap 与磁盘页面集合漂移了：新增 / 下线 / 改名页面后重跑 npm run build:docs'
  )
})

test('sitemap 每条记录都是合法形态（本站 https URL + W3C lastmod）', () => {
  const xml = readFileSync(path.join(publicDir, 'sitemap.xml'), 'utf8')
  const blocks = Array.from(xml.matchAll(/<url>([\s\S]*?)<\/url>/g), (m) => m[1])
  for (const b of blocks) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(b)?.[1] ?? ''
    assert.match(loc, /^https:\/\/bloghao\.com\//, 'sitemap 出现了非本站 URL：' + loc)
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(b)?.[1] ?? ''
    assert.match(lastmod, /^\d{4}-\d{2}-\d{2}$/, 'lastmod 不是 W3C 日期：' + lastmod)
  }
})

test('robots.txt 声明了 Sitemap 地址且带爬行规则组', () => {
  const robots = readFileSync(path.join(publicDir, 'robots.txt'), 'utf8')
  assert.match(robots, /^Sitemap: https:\/\/bloghao\.com\/sitemap\.xml$/m, 'robots.txt 丢了 Sitemap 声明，谷歌只能靠猜')
  assert.match(robots, /^User-agent: \*$/m, 'robots.txt 丢了 User-agent 爬行规则组')
})

test('官网公开页面不得携带 noindex', () => {
  for (const rel of listHtml()) {
    const html = readFileSync(path.join(publicDir, rel), 'utf8')
    assert.doesNotMatch(html, /<meta[^>]+noindex/i, rel + ' 带了 noindex——确要屏蔽收录就改本测试并写明理由')
  }
})
