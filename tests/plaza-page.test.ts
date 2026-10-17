/* 官网广场页（website/public/plaza/plaza.js）纯函数段的镜像守卫：
 * plaza.js 是 ES5 无构建的浏览器脚本，测试用例无法直接 import——与 outlink.test.ts 切 site.js
 * 同一手法，把「纯函数段开始/结束」标记之间的源码原样切片、包装成工厂在 Node 执行，
 * 守 esc / 截断 / 摘要抑制 / utm 拼参 / localStorage 包装的行为口径。改 plaza.js 纯函数段先跑它。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../website/public/plaza/plaza.js', import.meta.url), 'utf8')

function slicePureSection(): () => Record<string, unknown> {
  const start = SRC.indexOf('// ── 纯函数段开始')
  const end = SRC.indexOf('// ── 纯函数段结束')
  assert.ok(start > 0 && end > start, 'plaza.js 切片失败：纯函数段标记不在预期位置')
  const seg = SRC.slice(start, end)
  assert.ok(seg.includes('function esc') && seg.includes('function appendUtm'), '切片内容不完整')
  // 切片是 IIFE 内的 var/function 声明序列：包装成工厂在 Node 执行后把函数全部取出来
  return new Function(`${seg}\n;return { esc: esc, fmtDate: fmtDate, initialOf: initialOf, truncate: truncate, summaryOf: summaryOf, appendUtm: appendUtm, storeGet: storeGet, storeSet: storeSet }`)
}

function loadHelpers(): {
  esc: (s: unknown) => string
  truncate: (s: unknown, n: number) => string
  summaryOf: (it: { title?: unknown; summary?: unknown }, maxLen: number) => string
  appendUtm: (url: unknown) => string
  initialOf: (name: unknown) => string
} {
  return slicePureSection()() as never
}

test('appendUtm：出站链接统一带 utm_source=bloghao-plaza（P2.4 回访观测口径）', () => {
  const { appendUtm } = loadHelpers()
  // 无 query：? 接；已有 query：& 接；#fragment：插在 fragment 前
  assert.equal(appendUtm('https://x.test/post/a'), 'https://x.test/post/a?utm_source=bloghao-plaza')
  assert.equal(appendUtm('https://x.test/post/a?from=rss'), 'https://x.test/post/a?from=rss&utm_source=bloghao-plaza')
  assert.equal(appendUtm('https://x.test/weibo#wb-1'), 'https://x.test/weibo?utm_source=bloghao-plaza#wb-1')
  assert.equal(
    appendUtm('https://x.test/post/a?x=1#top'),
    'https://x.test/post/a?x=1&utm_source=bloghao-plaza#top'
  )
  // 幂等：已带 utm 不重复追加（重复净化/二次渲染安全）
  assert.equal(appendUtm('https://x.test/post/a?utm_source=bloghao-plaza'), 'https://x.test/post/a?utm_source=bloghao-plaza')
  // 脏输入原样返回，不抛错
  assert.equal(appendUtm(''), '')
  assert.equal(appendUtm(null), '')
  assert.equal(appendUtm(undefined), '')
})

test('truncate / summaryOf：截断补省略号；summary 与 title 同文截断时不重复渲染', () => {
  const { truncate, summaryOf } = loadHelpers()
  assert.equal(truncate('短文本', 10), '短文本')
  assert.equal(truncate('一二三四五', 3), '一二…')
  // 边界：n=1 也至少保留一个字符
  assert.equal(truncate('很长很长', 1), '很…')
  assert.equal(truncate(null, 5), '')

  // 微博卡：title=前80字摘录、summary=前500字——summary 去掉尾部省略号后以 title 开头 → 抑制
  assert.equal(summaryOf({ title: '今天天气不错，出门走走…', summary: '今天天气不错，出门走走，顺便拍了些照片，' + '很'.repeat(100) + '…' }, 120), '')
  // 文章卡：真标题 + 真摘要 → 正常截断到 maxLen
  const s = summaryOf({ title: '一篇正经文章', summary: '这是摘要内容，' + '长'.repeat(200) }, 60)
  assert.equal(s.length, 60)
  assert.ok(s.endsWith('…'))
  // 空摘要 → 空串（不渲染 p 标签）
  assert.equal(summaryOf({ title: '标题', summary: '' }, 120), '')
  // 垃圾输入不抛错
  assert.equal(summaryOf(null, 60), '')
  assert.equal(summaryOf({}, 60), '')
})

test('esc：五实体转义（feed 内容属半可信，渲染前最后一道墙）', () => {
  const { esc } = loadHelpers()
  assert.equal(esc(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
  assert.equal(esc(null), '')
  assert.equal(esc(123), '123')
})

test('initialOf：站名首字兜底，空名回落「博」', () => {
  const { initialOf } = loadHelpers()
  assert.equal(initialOf('张三的小站'), '张')
  assert.equal(initialOf('abc'), 'A')
  assert.equal(initialOf(''), '博')
  assert.equal(initialOf('   '), '博')
})

test('storeGet/storeSet：localStorage 包装在异常环境（隐私模式）退化不抛错', () => {
  const start = SRC.indexOf('// ── 纯函数段开始')
  const end = SRC.indexOf('// ── 纯函数段结束')
  const seg = SRC.slice(start, end)
  // 注入一个读写即抛的 localStorage（隐私加固浏览器口径），storeGet 走默认值、storeSet 静默
  const evil = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('SecurityError')
    },
  }
  const factory = new Function('localStorage', `${seg}\n;return { storeGet: storeGet, storeSet: storeSet }`)
  const h = factory(evil) as { storeGet: (k: string, d: string) => string; storeSet: (k: string, v: string) => void }
  assert.equal(h.storeGet('plaza-view', 'river'), 'river')
  assert.doesNotThrow(() => h.storeSet('plaza-view', 'wall'))
})
