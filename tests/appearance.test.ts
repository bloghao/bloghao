import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  APPEARANCE_ROLES,
  appearanceHeadStyle,
  appearanceMeta,
  cleanAppearanceSettings,
  FONT_PRESETS,
  normalizeFontStack,
  THEME_APPEARANCE,
} from '../src/appearance.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// ── cleanAppearanceSettings：形状净化 ──

test('clean：合法配置规范化——三位色展开、统一小写、角色按固定顺序、紧凑 JSON', () => {
  const out = cleanAppearanceSettings('{"accent":"#B23A29","bg":"#f60","fontSize":19,"font":"serif"}')
  assert.ok(out)
  const obj = JSON.parse(out)
  assert.equal(obj.accent, '#b23a29')
  assert.equal(obj.bg, '#ff6600')
  assert.equal(obj.fontSize, 19)
  assert.ok(obj.font.includes('"Songti SC"'), '字体预设解析成完整栈')
  assert.equal(Object.keys(obj)[0], 'accent', '角色按 APPEARANCE_ROLES 顺序落库')
})

test('clean：空/空白返回空串；fontSize 0 与空串 = 清除；fontSize 越界收敛到 14-22、0.5 步进', () => {
  assert.equal(cleanAppearanceSettings(''), '')
  assert.equal(cleanAppearanceSettings('   '), '')
  assert.equal(cleanAppearanceSettings('{"fontSize":0}'), '')
  assert.equal(cleanAppearanceSettings('{"fontSize":""}'), '')
  assert.equal(JSON.parse(cleanAppearanceSettings('{"fontSize":99}')!).fontSize, 22)
  assert.equal(JSON.parse(cleanAppearanceSettings('{"fontSize":14.24}')!).fontSize, 14, '0.5 步进取整')
})

test('clean：非法输入整体拒绝返回 null（坏 JSON / 非对象 / 未知键 / 坏颜色 / 坏字体 / 超长）', () => {
  assert.equal(cleanAppearanceSettings('not json'), null)
  assert.equal(cleanAppearanceSettings('[1,2]'), null)
  assert.equal(cleanAppearanceSettings('{"nope":"#ff0000"}'), null)
  assert.equal(cleanAppearanceSettings('{"accent":"rgb(1,2,3)"}'), null)
  assert.equal(cleanAppearanceSettings('{"accent":"#ff00"}'), null)
  assert.equal(cleanAppearanceSettings('{"accent":"red"}'), null)
  assert.equal(cleanAppearanceSettings('{"accent":123}'), null)
  assert.equal(cleanAppearanceSettings('{"font":"a;b"}'), null)
  assert.equal(cleanAppearanceSettings('{"font":"' + 'x'.repeat(70) + '"}'), null)
  assert.equal(cleanAppearanceSettings('{"' + 'k'.repeat(2100) + '":1}'), null)
})

// ── normalizeFontStack：字体栈是 <style> 注入面，注入尝试必须全被拒 ──

test('font：自定义栈——裸标识符原样通过、带空格/CJK 名重包双引号、generic 不加引号、可幂等回放', () => {
  const stack = normalizeFontStack('HarmonyOS Sans SC, serif')
  assert.equal(stack, '"HarmonyOS Sans SC", serif')
  assert.equal(normalizeFontStack(stack!), stack, '已归一化的栈原样通过（渲染端二次校验幂等）')
  assert.equal(normalizeFontStack('MONO'), 'MONO', '裸标识符形态原样通过（CSS 合法字体名）')
  assert.equal(normalizeFontStack('inherit'), '"inherit"', 'CSS 全局关键字强制包引号，防 font-family:inherit 语义劫持')
  assert.ok(normalizeFontStack('霞鹜文楷 屏幕阅读版')!.startsWith('"霞鹜文楷'), 'CJK 字体名放行并包引号')
})

test('font：注入尝试全部拒绝（分号/花括号/引号壳内坏字符/斜杠/超段/超量）', () => {
  assert.equal(normalizeFontStack('a;b}'), null)
  assert.equal(normalizeFontStack('a}'), null)
  assert.equal(normalizeFontStack('a{'), null)
  assert.equal(normalizeFontStack('a"b'), null)
  assert.equal(normalizeFontStack('"a;b"'), null, '引号壳内的坏字符同样拒绝')
  assert.equal(normalizeFontStack('a/b'), null)
  assert.equal(normalizeFontStack('a\\b'), null)
  assert.equal(normalizeFontStack('url(javascript:alert(1))'), null)
  assert.equal(normalizeFontStack('x'.repeat(61)), null)
  assert.equal(normalizeFontStack(Array.from({ length: 9 }, (_, i) => 'f' + i).join(',')), null)
  assert.equal(normalizeFontStack(''), null)
})

// ── appearanceHeadStyle：渲染期映射与过滤 ──

test('css：未配置 / 未知主题 / 脏数据 → 空串（输出字节级不变）', () => {
  assert.equal(appearanceHeadStyle({ theme: 'wechat', appearance: '' }), '')
  assert.equal(appearanceHeadStyle({ theme: 'wechat' }), '')
  assert.equal(appearanceHeadStyle({ theme: 'nope', appearance: '{"accent":"#ff0000"}' }), '')
  assert.equal(appearanceHeadStyle({ theme: 'wechat', appearance: 'dirty{{{' }), '')
  assert.equal(appearanceHeadStyle({}), '')
})

test('css：色值映射回当前主题自己的变量，默认同值不出声明', () => {
  const html = appearanceHeadStyle({ theme: 'paper', appearance: '{"accent":"#123456","ink":"#2b2a26"}' })
  assert.ok(html.startsWith('<style data-appearance>'))
  assert.ok(html.endsWith('</style>'))
  assert.ok(html.includes('--pp-accent:#123456'), 'paper 的主色落 --pp-accent')
  assert.ok(!html.includes('--wx-'), '不串别的主题的变量')
  assert.ok(!html.includes('--pp-ink:'), '与主题默认同值的角色不出声明')
  // 同一配置换到 wechat：accent 映射到 --wx-accent，且 paper 缺省支持的同名角色照常
  const wx = appearanceHeadStyle({ theme: 'wechat', appearance: '{"accent":"#123456"}' })
  assert.ok(wx.includes('--wx-accent:#123456'))
})

test('css：主题不支持的角色自动跳过（minimal 无主色；wechat 配置切到 minimal 不出未知变量）', () => {
  const html = appearanceHeadStyle({ theme: 'minimal', appearance: '{"accent":"#123456","ink":"#222222"}' })
  assert.ok(html.includes('--mn-ink:#222222'))
  assert.ok(!html.includes('accent'), 'minimal 无主色变量，整个角色跳过')
})

test('css：深浅衍生色——bitcoin 主色带 color-mix 压深与冲淡；journal 高亮 tint；改回默认则无衍生', () => {
  const bt = appearanceHeadStyle({ theme: 'bitcoin', appearance: '{"accent":"#3b82f6"}' })
  assert.ok(bt.includes('--bt-accent:#3b82f6'))
  assert.ok(bt.includes('--bt-accent-deep:color-mix(in srgb, #3b82f6 87%, #000 13%)'))
  assert.ok(bt.includes('--bt-accent-soft:color-mix(in srgb, #3b82f6 12%, transparent)'))
  const jrn = appearanceHeadStyle({ theme: 'journal', appearance: '{"accent":"#3b82f6"}' })
  assert.ok(jrn.includes('--jrn-hl:color-mix(in srgb, #3b82f6 14%, transparent)'))
  const btBack = appearanceHeadStyle({ theme: 'bitcoin', appearance: '{"accent":"#f7931a"}' })
  assert.equal(btBack, '', '全部等于主题默认 → 无任何输出')
})

test('css：font 输出 body 规则、fontSize 与主题基线不同才输出 .rich 规则', () => {
  const html = appearanceHeadStyle({
    theme: 'wechat',
    appearance: JSON.stringify({ font: 'serif', fontSize: 18 }),
  })
  assert.ok(html.includes('body{font-family:Georgia'))
  assert.ok(html.includes('.rich{font-size:18px}'))
  const same = appearanceHeadStyle({ theme: 'wechat', appearance: '{"fontSize":17}' })
  assert.equal(same, '', '与主题正文基线同值不输出')
  const dirty = appearanceHeadStyle({ theme: 'wechat', appearance: '{"font":"a;b"}' })
  assert.equal(dirty, '', '脏字体栈到不了 CSS（渲染端二次校验兜底）')
})

// ── 镜像守卫：映射表默认值必须与主题 CSS :root 实际值一致，richSize 与 .rich 字号一致 ──

test('镜像守卫：THEME_APPEARANCE 默认值与七主题 CSS :root 块逐一核对（主题改色忘同步此处即红）', () => {
  for (const [themeId, t] of Object.entries(THEME_APPEARANCE)) {
    const css = readFileSync(join(ROOT, 'src', 'themes', `${themeId}.css`), 'utf8')
    const rootBlock = /:root\s*{([\s\S]*?)}/.exec(css)
    assert.ok(rootBlock, `${themeId}.css 应有 :root 块`)
    const declared = new Map<string, string>()
    for (const m of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)[;,]?/g)) declared.set(m[1], m[2].trim())
    // CSS 里允许 #333 三位简写，与映射表的六位展开口径一致后再比
    const hex6 = (s: string) => {
      const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s.toLowerCase())
      return m3 ? '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3] : s.toLowerCase()
    }
    const roleKeys = APPEARANCE_ROLES.map((r) => r.key)
    for (const [role, entry] of Object.entries(t.roles)) {
      assert.ok(roleKeys.includes(role), `${themeId} 的角色 ${role} 必须是 APPEARANCE_ROLES 已登记键`)
      for (const v of entry.vars) {
        const actual = declared.get(v)
        assert.ok(actual, `${themeId}.css 缺少变量 ${v}（映射表指向了不存在的变量）`)
        assert.equal(
          hex6(actual),
          hex6(entry.default),
          `${themeId} ${v} 的 CSS 实际值（${actual}）与映射表默认值（${entry.default}）不一致`
        )
      }
    }
    const rich = /\.rich\s*{[^}]*?font-size:\s*([\d.]+)px/.exec(css)
    assert.ok(rich, `${themeId}.css 的 .rich 应显式声明 font-size`)
    assert.equal(Number(rich[1]), t.richSize, `${themeId} 的 richSize 与 .rich 实际字号不一致`)
  }
})

test('镜像守卫：字体预设栈里出现的字体名都能通过本模块自己的白名单（防预设与校验规则脱节）', () => {
  for (const p of FONT_PRESETS) {
    assert.equal(normalizeFontStack(p.stack), p.stack, `预设 ${p.id} 的栈应能幂等通过白名单`)
  }
})

test('appearanceMeta：出参带支持角色 / 默认值 / 基线字号 / 字体预设；七主题全部有外观能力', () => {
  const meta = appearanceMeta('wechat')
  assert.ok(meta)
  assert.ok(meta!.roles.some((r) => r.key === 'link'), 'wechat 有专用链接色角色')
  assert.equal(meta!.richSize, 17)
  assert.ok(meta!.fontPresets.every((p) => p.stack))
  assert.equal(appearanceMeta('nope'), null)
})
