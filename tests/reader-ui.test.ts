import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 读者侧「微信同款」交互件（site.js 客户端注入，见 docs/WECHAT-PLAYBOOK.md §3/§4.4、docs/MOBILE-UX.md）：
// 正文缩放（C11）+ 正文页右上角「…」聚合菜单 + 灯箱下拉关闭 / 长按菜单。
// 无服务端镜像可比对，这里守的是「会静默坏掉」的不变量：档位表与标签表对齐、面板不锁死滚动、
// 站点脚本不引入 Safari 解析期崩的 lookbehind 正则（ES5 红线）。

const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')

// 新交互件所在的段（到灯箱模块为止）：含面板/缩放/「…」，供「不锁滚动」这条红线做范围检查
const segStart = src.indexOf('微信同款读者交互件')
const segEnd = src.indexOf('图片灯箱')
const seg = src.slice(segStart, segEnd)

function literalArray(name: string): unknown[] {
  const m = new RegExp('var ' + name + ' = \\[([^\\]]*)\\]').exec(src)
  assert.ok(m, `site.js 找不到 ${name}（档位表被改写了？）`)
  return new Function('return [' + m![1] + ']')() as unknown[]
}

test('site.js 正文缩放：档位表与标签表一一对应、倍率递增、默认档位在范围内', () => {
  assert.ok(segStart > 0 && segEnd > segStart, 'site.js 切片失败：读者交互件段不在预期位置')
  const labels = literalArray('FS_LABELS')
  const mult = literalArray('FS_MULT') as number[]
  assert.ok(labels.length >= 2, '至少要有「小 / 标准」两档')
  assert.equal(labels.length, mult.length, '标签数与倍率数必须一致（否则控件点到越界档位）')
  for (let i = 1; i < mult.length; i++) {
    assert.ok(mult[i] > mult[i - 1], `倍率必须递增：第 ${i} 档 ${mult[i]} 不大于第 ${i - 1} 档 ${mult[i - 1]}`)
  }
  const def = /var FS_DEFAULT = (\d+)/.exec(src)
  assert.ok(def, 'site.js 找不到 FS_DEFAULT')
  const d = Number(def![1])
  assert.ok(d >= 0 && d < mult.length, '默认档位必须落在档位表内')
  assert.equal(mult[d], 1, '默认档位应当是 1 倍（不改动未设置读者的正文大小）')
})

test('site.js 正文缩放：记忆键经 storeGet/storeSet（禁裸 localStorage）', () => {
  assert.match(seg, /var FS_KEY = 'xw:reader:fs:v1'/, '记忆键带版本号')
  assert.match(src, /storeGet\(FS_KEY\)/, '读取走 storeGet（隐私加固浏览器裸读写即抛 SecurityError）')
  assert.match(src, /storeSet\(FS_KEY, String\(i\)\)/, '写入走 storeSet')
})

test('site.js「…」聚合菜单与底部面板：注入口就位', () => {
  assert.match(seg, /var XW_UI_CSS = \[/, '面板样式一次性注入')
  assert.match(seg, /function xwOpenSheet\(/, '通用底部操作面板')
  assert.match(seg, /function xwSheetRow\(/, '面板行构造器')
  assert.match(seg, /xw-more-fab/, '「…」浮动入口')
  // 面板只有「分享 / 复制链接 / 字号」三行：精简口径，别再堆低频动作进来（见 MOBILE-UX §5）
  assert.match(seg, /T\('分享'\)/)
  assert.match(seg, /T\('复制链接'\)/)
  assert.match(seg, /T\('字号'\)/)
  // 字号只作用于正文容器，且优先 zoom（一次覆盖标题/正文/代码）
  assert.match(seg, /querySelectorAll\('\.rich'\)/)
  assert.match(seg, /CSS\.supports\('zoom'/)
})

test('site.js 覆盖层红线：底部面板不锁 body 滚动（与灯箱互相抵消）', () => {
  assert.doesNotMatch(seg, /document\.body\.style\.overflow/, '面板不得锁滚动——灯箱已锁，面板再锁会在关面板时误解锁')
  // 灯箱自身仍按原样锁/解锁
  assert.match(src, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(src, /document\.body\.style\.overflow = ''/)
})

test('site.js 灯箱手势补齐：下拉关闭 + 长按菜单在位', () => {
  assert.match(src, /var dragY = 0/, '下拉关闭位移变量')
  assert.match(src, /dy > 100 && Math\.abs\(dy\) > Math\.abs\(dx\)/, '下拉关闭判定（够远且纵向为主）')
  assert.match(src, /var pressTimer = null/, '长按计时器')
  assert.match(src, /-webkit-touch-callout:none/, '灯箱图不出系统长按菜单（自家长按菜单接管）')
  assert.match(src, /T\('保存图片'\)/)
  assert.match(src, /T\('复制图片地址'\)/)
})

test('site.js 不引入 lookbehind 正则（Safari ≤16.3 解析期抛错、全站交互瘫痪）', () => {
  assert.doesNotMatch(src, /\(\?<[=!]/, 'site.js 出现 lookbehind 正则——旧 Safari 解析期 SyntaxError')
})
