import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeHtml } from '../src/sanitize.ts'

// ── 危险协议拦截（回归：jav\tascript: 混淆曾绕过前缀正则）──
test('javascript: href 被剥除', () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
})

test('tab 混淆的 javascript: 被剥除（URL 解析器会忽略 tab）', () => {
  assert.equal(sanitizeHtml('<a href="java\tscript:alert(1)">y</a>'), '<a>y</a>')
})

test('数字实体混淆（java&#9;script:）被整体剥除：实体解码还原出 tab 后按 javascript: 拒绝', () => {
  // 属性值先做一轮实体解码（编辑器序列化的 href 恒是 &amp; 形态，见 A1 修复），
  // &#9; 在解码后还原成真 tab，safeUrl 剥 tab 识别出 javascript: 协议——
  // 整体剥除比旧行为（字面放行 &amp;#9;）更严，浏览器端两种都不可执行
  assert.equal(sanitizeHtml('<a href="java&#9;script:alert(1)">z</a>'), '<a>z</a>')
  assert.equal(sanitizeHtml('<a href="java&#x9;script:alert(1)">z</a>'), '<a>z</a>')
  assert.ok(!sanitizeHtml('<a href="java&#9;script:alert(1)">z</a>').includes('\t'), '输出中不得存在原始 tab')
})

// ── href/src 双重转义（A1 回归：含 & 的链接存库即坏、逐次编辑加码）──
test('href 里的查询参数 & 不再双重转义：存库一次正确、重复净化幂等', () => {
  // 编辑器 contenteditable 序列化出的 href 恒是 &amp; 形态：解码一轮得到真实 URL 再校验输出
  const once = sanitizeHtml('<a href="https://example.com/s?wd=a&amp;b=1">x</a>')
  assert.equal(once, '<a href="https://example.com/s?wd=a&amp;b=1" rel="noopener noreferrer">x</a>')
  // 「编辑→保存」循环：上一轮的输出是下一轮的输入，结果必须稳定（历史行为会逐轮多加 amp;）
  const twice = sanitizeHtml(once)
  assert.equal(twice, once)
})

test('裸 & 与未知实体按原样保留（只解码序列化器会产出的白名单实体）', () => {
  const out = sanitizeHtml('<a href="https://example.com/?a=1&b=2&nosuch=x">x</a>')
  assert.equal(out, '<a href="https://example.com/?a=1&amp;b=2&amp;nosuch=x" rel="noopener noreferrer">x</a>')
})

test('src/poster/title 等属性值同样解码一轮，解码后过 safeUrl', () => {
  assert.equal(sanitizeHtml('<img src="/images/u/a.png?v=1&amp;w=2">'), '<img src="/images/u/a.png?v=1&amp;w=2">')
  // 解码暴露出的危险协议照常拒绝
  assert.equal(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeHtml('<img src="&quot; onerror=&quot;alert(1)">'), '<img src="&quot; onerror=&quot;alert(1)">')
})

test('data:/vbscript: 等协议一律拒绝，http(s) 保留并带 rel', () => {
  assert.equal(sanitizeHtml('<a href="data:text/html,<b>">x</a>'), '<a>x</a>')
  assert.equal(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>'), '<a>x</a>')
  assert.equal(
    sanitizeHtml('<a href="https://example.com">ok</a>'),
    '<a href="https://example.com" rel="noopener noreferrer">ok</a>'
  )
})

// ── id 剥除（回归：全局放行 id 曾可 DOM clobbering 打瘫评论区）──
test('id 属性一律剥除，class 保留', () => {
  assert.equal(sanitizeHtml('<p id="comment-form" class="keep">x</p>'), '<p class="keep">x</p>')
  assert.equal(sanitizeHtml('<img id="like-btn" src="/images/u/a.png">'), '<img src="/images/u/a.png">')
})

// ── 危险标签（回归：script 内容曾可能被保留）──
test('script 连同内容整体丢弃', () => {
  assert.equal(sanitizeHtml('前<script>alert(1)</script>后'), '前后')
})

test('事件属性剥除、未知标签剥壳留字', () => {
  assert.equal(sanitizeHtml('<p onclick="alert(1)">x</p>'), '<p>x</p>')
  assert.equal(sanitizeHtml('<custom-tag>内容</custom-tag>'), '内容')
})

// ── OG 卡图例外（回归：文档曾未说明，测试防误删该功能）──
test('meta data-og-image 站内路径原样保留', () => {
  const tag = '<meta data-og-image="/images/og/abc.png" content="/images/og/abc.png">'
  assert.equal(sanitizeHtml(tag), '<meta data-og-image="/images/og/abc.png" content="/images/og/abc.png">')
})

test('meta 无 data-og-image 仍被丢弃', () => {
  assert.equal(sanitizeHtml('<meta charset="utf-8">'), '')
})

// ── void 元素只丢弃标签本身（回归：微信剪贴板以 <meta charset='utf-8'> 开头，
//    「丢弃到结束标签」的扫描找不到 </meta>，曾把其后整段粘贴内容吞光——
//    编辑器里表现为「粘贴没反应」）──
test('meta/link/base/input/embed 等 void 元素不吞后续内容', () => {
  assert.equal(sanitizeHtml("<meta charset='utf-8'><p>正文</p>"), '<p>正文</p>')
  assert.equal(sanitizeHtml('<meta charset="utf-8"/>尾'), '尾')
  assert.equal(sanitizeHtml('<link rel="stylesheet" href="https://x.example/a.css"><p>hi</p>'), '<p>hi</p>')
  assert.equal(sanitizeHtml('<base href="https://evil.example/">ok'), 'ok')
  assert.equal(sanitizeHtml('<input type="text" onfocus="alert(1)"><p>hi</p>'), '<p>hi</p>')
  assert.equal(sanitizeHtml('<embed src="x.swf">尾'), '尾')
})

test('非 void 的未闭合丢弃标签仍吞到结尾（script/style 语义不变）', () => {
  assert.equal(sanitizeHtml('a<style>b'), 'a')
  assert.equal(sanitizeHtml('a<iframe src="x"></iframe>b'), 'ab')
})

// ── 回归（2026-10 安全复查）：未终结的标签前缀 / 未闭合注释曾被原样透传 ——
// 浏览器会把后续页面标记当成该 img 的属性（onerror 内联事件复活）或把整页吞进注释 ──
test('未终结的标签前缀与未闭合注释被转义，正常文本里的 < 不误伤', () => {
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)'), '&lt;img src=x onerror=alert(1)')
  assert.equal(sanitizeHtml('a <!-- b'), 'a &lt;!-- b')
  assert.equal(sanitizeHtml('a </b'), 'a &lt;/b')
  assert.equal(sanitizeHtml('3 < 5 且 <3 心形'), '3 < 5 且 <3 心形')
  // 完整标签仍走既有白名单路径，不受影响
  assert.equal(sanitizeHtml('<p onclick=alert(1)>hi</p>'), '<p>hi</p>')
  assert.equal(sanitizeHtml('<b>ok</b>'), '<b>ok</b>')
})
