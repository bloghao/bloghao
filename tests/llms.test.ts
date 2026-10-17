import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLlmsFullTxt, buildLlmsStub, buildLlmsTxt } from '../src/llms'
import type { PostRow, SettingsMap } from '../src/types'

const S: SettingsMap = {
  siteName: '测试站',
  siteDescription: '一个测试站点',
  theme: 'wechat',
} as SettingsMap
const SITE = 'https://blog.example.com'

function post(over: Partial<PostRow>): PostRow {
  return {
    id: 1,
    slug: 'hello-world',
    title: '你好世界',
    summary: '第一篇文章的摘要',
    content: '<h2>正文标题</h2>\n<p>这是正文内容，含 smoke-llms-body-marker。</p>',
    status: 'published',
    password_hash: null,
    min_tier: 'all',
    published_at: 1790000000000,
    updated_at: 1790000000000,
    ...over,
  } as PostRow
}

test('llms.txt：H1 站名 + blockquote 描述 + 文章条目（标题/链接/摘要）与机器可读清单', () => {
  const out = buildLlmsTxt(S, [post({})], [{ slug: 'about', title: '关于本站' }], SITE)
  assert.ok(out.startsWith('# 测试站\n\n> 一个测试站点\n'))
  assert.ok(out.includes('- [你好世界](https://blog.example.com/post/hello-world): 第一篇文章的摘要'))
  assert.ok(out.includes('- [关于本站](https://blog.example.com/about)'), 'about 走 /about 短链')
  assert.ok(out.includes('(https://blog.example.com/rss.xml)'))
  assert.ok(out.includes('(https://blog.example.com/feed.json)'))
  assert.ok(out.includes('(https://blog.example.com/sitemap.xml)'))
  assert.ok(out.includes('.md`'), 'Markdown 镜像约定要写进导读')
  assert.ok(!out.includes('smoke-llms-body-marker'), '索引不出现正文')
})

test('llms.txt：中文 slug 百分号编码；摘要/标题内嵌换行单行化；无摘要省略冒号', () => {
  const out = buildLlmsTxt(
    S,
    [post({ slug: '中文 slug', title: '标题\n第二行', summary: '摘要一\n摘要二' }), post({ slug: 'no-summary', summary: '' })],
    [],
    SITE
  )
  assert.ok(out.includes('(https://blog.example.com/post/%E4%B8%AD%E6%96%87%20slug)'))
  assert.ok(out.includes('标题 第二行'))
  assert.ok(!out.includes('标题\n第二行'), '标题换行压平')
  assert.ok(out.includes(': 摘要一 摘要二'))
  assert.ok(!/\)\s*:\s*$/m.test(out), '空摘要不出冒号尾巴')
  assert.ok(!out.includes('## 独立页面'), '无页面时整节省略')
})

test('llms-full.txt：正文是库存 HTML，经 htmlToMd 转换出干净 Markdown（标签不透出）', () => {
  const out = buildLlmsFullTxt(S, [post({})], SITE)
  assert.ok(out.includes('## [你好世界](https://blog.example.com/post/hello-world)'))
  assert.ok(out.includes('发布：'))
  assert.ok(out.includes('## 正文标题'), 'h2 转 markdown 标题')
  assert.ok(out.includes('smoke-llms-body-marker'), '正文文本保留')
  assert.ok(!out.includes('<h2>') && !out.includes('<p>'), 'HTML 标签不原样透出')
  assert.ok(out.includes('---'), '条目以分隔线收尾')
})

test('llms-full.txt：会员锁文只出摘要 + 引导，正文一个字不出（契约 A2 防泄漏）', () => {
  const out = buildLlmsFullTxt(S, [post({ min_tier: 'gold' })], SITE)
  assert.ok(out.includes('第一篇文章的摘要'), '摘要照常出（作者公开的导读面）')
  assert.ok(!out.includes('smoke-llms-body-marker'), '正文不出')
  assert.ok(out.includes('会员专属'))
})

test('llms-full.txt：密码文只出作者摘要 + 加密说明（与 RSS description 同口径）', () => {
  const out = buildLlmsFullTxt(S, [post({ password_hash: 'salt:hash' })], SITE)
  assert.ok(out.includes('第一篇文章的摘要'))
  assert.ok(!out.includes('smoke-llms-body-marker'))
  assert.ok(out.includes('访问密码'))
})

test('llms 桩：演示站 / siteNoindex 只出站名与说明，不列任何内容', () => {
  const out = buildLlmsStub(S, SITE)
  assert.ok(out.startsWith('# 测试站'))
  assert.ok(out.includes('不向 AI 爬虫暴露内容'))
  assert.ok(!out.includes('rss.xml') && !out.includes('##'))
})

test('llms 桩：AI 策略 deny 档文案指向策略而非演示', () => {
  const out = buildLlmsStub(S, SITE, true)
  assert.ok(out.startsWith('# 测试站'))
  assert.ok(out.includes('不允许 AI 抓取'))
  assert.ok(!out.includes('演示'), '真实站点的拒绝文案不冒充演示站')
  assert.ok(!out.includes('rss.xml') && !out.includes('##'))
})
