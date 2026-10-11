import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mdToHtml } from '../src/markdown.ts'

// ── 行内转义只做一次（回归：escAttr 二次转义曾把含 & 的 URL 打成坏链）──
test('链接 URL 含 & 单次转义，不再出现 &amp;amp;', () => {
  const out = mdToHtml('[x](https://e.com/?a=1&b=2)')
  assert.ok(out.includes('href="https://e.com/?a=1&amp;b=2"'), out)
  assert.ok(!out.includes('&amp;amp;'), out)
})

test('图片 URL 带参数同样单次转义', () => {
  const out = mdToHtml('![图](https://e.com/i.png?v=1&w=2)')
  assert.ok(out.includes('src="https://e.com/i.png?v=1&amp;w=2"'), out)
})

test('行内代码里的 & 正常显示', () => {
  assert.ok(mdToHtml('`a & b`').includes('<code>a &amp; b</code>'))
})

test('标题里的 < 被转义', () => {
  assert.ok(mdToHtml('# a < b').includes('<h1>a &lt; b</h1>'))
})

// ── 危险协议（回归：jav\tascript: 混淆曾绕过）──
test('tab 混淆的 javascript: 链接不生成锚点', () => {
  const out = mdToHtml('[点我](java\tscript:alert(1))')
  assert.ok(!out.includes('<a '), out)
})

test('javascript: 链接不生成锚点，https 正常', () => {
  assert.ok(!mdToHtml('[点我](javascript:alert(1))').includes('<a '))
  assert.ok(mdToHtml('[点我](https://e.com)').includes('rel="noopener noreferrer"'))
})

// ── 基础结构（防改坏渲染主链路）──
test('标题/加粗/代码块基础渲染', () => {
  const out = mdToHtml('## 标题\n\n**粗体** 普通文本\n\n```js\nconst a = "<b>";\n```')
  assert.ok(out.includes('<h2>标题</h2>'))
  assert.ok(out.includes('<strong>粗体</strong>'))
  assert.ok(out.includes('&lt;b&gt;'), '代码块内容转义')
})

// ── GFM 管道表格 ──
test('表格：表头/正文/对齐/单元格内转义与行内格式', () => {
  const out = mdToHtml(
    '| 名称 | 数量 | 备注 |\n| --- | :---: | ---: |\n| **苹果** | 3 | a & b |\n| 香蕉 | 12 | `x<y` |'
  )
  assert.ok(out.includes('<table><thead><tr>'), out)
  assert.ok(out.includes('<th>名称</th>'), out)
  assert.ok(out.includes('<th style="text-align:center">数量</th>'), out)
  assert.ok(out.includes('<th style="text-align:right">备注</th>'), out)
  assert.ok(out.includes('<td><strong>苹果</strong></td>'), out)
  assert.ok(out.includes('<td style="text-align:right">a &amp; b</td>'), out)
  assert.ok(out.includes('<td style="text-align:right"><code>x&lt;y</code></td>'), out)
  assert.ok(out.includes('</tbody></table>'), out)
})

test('表格：列数不齐按表头列数截断/补空，单元格缺省为空', () => {
  const out = mdToHtml('| A | B |\n| --- | --- |\n| 只有一列 |\n| 多 | 出 | 来 |')
  assert.ok(out.includes('<td>只有一列</td><td></td>'), out)
  assert.ok(out.includes('<td>多</td><td>出</td>'), out)
  assert.ok(!out.includes('<td>来</td>'), out)
})

test('只有竖线没有分隔行：当普通段落不产表格', () => {
  const out = mdToHtml('a | b\nc | d')
  assert.ok(!out.includes('<table>'), out)
  assert.ok(out.includes('<p>a | b<br>c | d</p>'), out)
})

test('表格后面的普通段落正常衔接（表格 flush 不吞段）', () => {
  const out = mdToHtml('| A |\n| --- |\n| 1 |\n\n正文段落')
  assert.ok(out.includes('</table>'), out)
  assert.ok(out.includes('<p>正文段落</p>'), out)
})

// ── safeUrlMd 拒绝列表（回归覆盖面补齐：此前只测了 javascript:）──
test('safeUrlMd：data / vbscript / file / blob 协议的链接与图片全拒', () => {
  const cases = [
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    '[x](vbscript:msgbox(1))',
    '[x](file:///etc/passwd)',
    '![x](blob:https://x.test/uuid)',
    '[x](JaVaScRiPt:alert(1))',
    '[x](jav\tascript:alert(1))', // 制表符混淆：解析器忽略 \t，前缀判断必须先剥
  ]
  for (const md of cases) {
    const html = mdToHtml(md)
    assert.ok(!/href|src/.test(html.replace(/&lt;/g, '<')), `${md} 不应产出链接/图片：${html}`)
  }
})

test('safeUrlMd：相对路径 / https 放行，mailto 等其余协议不链接化，alt 含引号正常转义', () => {
  assert.match(mdToHtml('[a](/post/x)'), /href="\/post\/x"/)
  assert.match(mdToHtml('[a](https://example.com/p?a=1&b=2)'), /&amp;/) // & 单次转义
  // safeUrlMd 对带协议的 URL 只认 http(s)（sanitize 的 safeUrl 才放 mailto）：其余一律不产出链接
  assert.ok(!/href/.test(mdToHtml('[a](mailto:a@b.test)')))
  // alt 里的双引号必须经 escQuote（&quot;），不能破属性结构
  assert.equal(mdToHtml('!["hi"](https://e.test/a.png)'), '<p><img src="https://e.test/a.png" alt="&quot;hi&quot;"></p>')
})
