/* ===== 主题外观变量（B9）=====
 * 后台「皮肤 → 外观变量」可调颜色 / 字体 / 正文字号 / 圆角，不动主题代码。
 * 机制：settings.appearance 存一份扁平 JSON（角色键 → 色值，另有 font / fontSize），
 * 渲染期 appearanceHeadStyle() 按当前主题把语义角色映射回该主题自己的 CSS 变量，产出一小段
 * 覆盖 <style> 挂在主题样式之后（同特异性后者胜）。未设置时输出空串——不配置 = 输出与
 * 历史版本字节级一致；主题不支持的角色（如 minimal 无主色）自动跳过。
 * 安全面：<style> 里的一切都由本模块生成——颜色只收 #rgb / #rrggbb；字体栈逐段白名单
 * 字符集校验后重新包裹双引号（generic 关键词不加引号），站长输入到不了 CSS 语法位。
 * 深浅衍生色（bitcoin / rednote 的 accent-deep 与 soft 底）用 color-mix 从主色推导，
 * 不支持的旧浏览器丢弃该声明、回落主题原值，属优雅降级。
 * 默认值镜像守卫：THEME_APPEARANCE 里每个默认值由 tests/appearance.test.ts 对着主题 CSS
 * 的 :root 块逐一核对——主题改色忘了同步这张表，测试会红。
 */
import type { SettingsMap } from './types'

export const APPEARANCE_ROLES = [
  { key: 'accent', label: '主色' },
  { key: 'ink', label: '正文文字' },
  { key: 'sub', label: '次要文字' },
  { key: 'bg', label: '页面背景' },
  { key: 'card', label: '卡片底色' },
  { key: 'line', label: '分隔线' },
  { key: 'link', label: '正文链接' },
] as const
export type AppearanceRoleKey = (typeof APPEARANCE_ROLES)[number]['key']

/** 深浅衍生色：shade = 向黑压深 amount%；tint = 向透明冲淡 amount%（color-mix，旧浏览器降级回落原值） */
type DerivedVar = { varName: string; kind: 'shade' | 'tint'; amount: number }
type RoleEntry = { vars: string[]; default: string; derived?: DerivedVar[] }
/** 圆角旋钮：主题 CSS :root 里 --<p>-radius 为基准值，--<p>-radius-lg 用 calc(var * 系数) 派生，
 * 覆盖样式只需重写基准变量一枚，大小两级成比例走 */
type ThemeRadius = { var: string; default: number; lgFactor: number }
type ThemeAppearance = { roles: Partial<Record<AppearanceRoleKey, RoleEntry>>; richSize: number; radius?: ThemeRadius }

/* 各主题语义角色 → CSS 变量映射。default 必须与主题 CSS :root 里的值一致（镜像守卫盯着）；
 * 变量缺失的角色不写条目（minimal 黑白设计无主色/卡片底，链接色仅 wechat 有专用变量） */
export const THEME_APPEARANCE: Record<string, ThemeAppearance> = {
  wechat: {
    richSize: 17,
    roles: {
      accent: { vars: ['--wx-accent'], default: '#b23a29' },
      link: { vars: ['--wx-link'], default: '#576b95' },
      ink: { vars: ['--wx-text'], default: '#333333' },
      sub: { vars: ['--wx-sub'], default: '#9e9e9e' },
      bg: { vars: ['--wx-bg'], default: '#f6f4f0' },
      card: { vars: ['--wx-card'], default: '#ffffff' },
      line: { vars: ['--wx-line'], default: '#e8e2d9' },
    },
    radius: { var: '--wx-radius', default: 8, lgFactor: 1.75 },
  },
  paper: {
    richSize: 17,
    roles: {
      accent: { vars: ['--pp-accent'], default: '#a03c2e' },
      ink: { vars: ['--pp-ink'], default: '#2b2a26' },
      sub: { vars: ['--pp-sub'], default: '#8a857a' },
      bg: { vars: ['--pp-bg'], default: '#f7f4ee' },
      card: { vars: ['--pp-card'], default: '#fffdf8' },
      line: { vars: ['--pp-line'], default: '#e2dccc' },
    },
    radius: { var: '--pp-radius', default: 4, lgFactor: 1.5 },
  },
  midnight: {
    richSize: 16.5,
    roles: {
      accent: { vars: ['--md-accent'], default: '#58a6ff' },
      ink: { vars: ['--md-ink'], default: '#d7dde5' },
      sub: { vars: ['--md-sub'], default: '#7d8590' },
      bg: { vars: ['--md-bg'], default: '#0f1115' },
      card: { vars: ['--md-card'], default: '#161a22' },
      line: { vars: ['--md-line'], default: '#232936' },
    },
    radius: { var: '--md-radius', default: 8, lgFactor: 1.5 },
  },
  minimal: {
    richSize: 17,
    roles: {
      ink: { vars: ['--mn-ink'], default: '#111111' },
      sub: { vars: ['--mn-sub'], default: '#888888' },
      bg: { vars: ['--mn-bg'], default: '#ffffff' },
      line: { vars: ['--mn-line'], default: '#eaeaea' },
    },
    radius: { var: '--mn-radius', default: 2, lgFactor: 2 },
  },
  journal: {
    richSize: 17,
    roles: {
      accent: { vars: ['--jrn-accent'], default: '#e06a3c', derived: [{ varName: '--jrn-hl', kind: 'tint', amount: 14 }] },
      ink: { vars: ['--jrn-ink'], default: '#3f3a31' },
      sub: { vars: ['--jrn-ink-soft'], default: '#94897a' },
      bg: { vars: ['--jrn-paper'], default: '#faf5ea' },
      card: { vars: ['--jrn-card'], default: '#fffdf6' },
      line: { vars: ['--jrn-line'], default: '#e7ddc9' },
    },
    radius: { var: '--jrn-radius', default: 10, lgFactor: 1.6 },
  },
  bitcoin: {
    richSize: 16.5,
    roles: {
      accent: {
        vars: ['--bt-accent'],
        default: '#f7931a',
        derived: [
          { varName: '--bt-accent-deep', kind: 'shade', amount: 13 },
          { varName: '--bt-accent-soft', kind: 'tint', amount: 12 },
        ],
      },
      ink: { vars: ['--bt-ink'], default: '#191714' },
      sub: { vars: ['--bt-muted'], default: '#6d6a63' },
      bg: { vars: ['--bt-bg'], default: '#faf9f6' },
      card: { vars: ['--bt-surface'], default: '#ffffff' },
      line: { vars: ['--bt-border'], default: '#e7e4dc' },
    },
    radius: { var: '--bt-radius', default: 10, lgFactor: 1.6 },
  },
  rednote: {
    richSize: 16,
    roles: {
      accent: {
        vars: ['--rn-red'],
        default: '#ff2442',
        derived: [
          { varName: '--rn-red-deep', kind: 'shade', amount: 15 },
          { varName: '--rn-red-soft', kind: 'tint', amount: 8 },
        ],
      },
      ink: { vars: ['--rn-ink'], default: '#333333' },
      sub: { vars: ['--rn-sub'], default: '#666666' },
      bg: { vars: ['--rn-bg'], default: '#f7f8fa' },
      card: { vars: ['--rn-surface'], default: '#ffffff' },
      line: { vars: ['--rn-line'], default: '#f0f0f0' },
    },
    radius: { var: '--rn-radius', default: 12, lgFactor: 1.33 },
  },
}

/* 正文字体预设：存库时解析成完整字体栈（自定义输入同理归一化），渲染端只认栈字符串 */
export const FONT_PRESETS = [
  {
    id: 'sans',
    label: '黑体（系统默认观感）',
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  {
    id: 'serif',
    label: '衬线（宋体观感）',
    stack: 'Georgia, "Nimbus Roman", "Songti SC", "Noto Serif SC", SimSun, serif',
  },
]

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-rounded',
  'math',
  'fangsong',
])

/* 字体段白名单：字母数字下划线、空格括号连字符点、CJK 与带变音符的拉丁字母。
 * 引号 / 分号 / 花括号 / 反斜杠 / 斜杠一律拒绝——段落重新包引号由本函数负责，绝不透传 */
const FONT_SEG_RE = /^[\w\-. ()·、（）\u00c0-\u024f\u0370-\u04ff\u3040-\u30ff\u3400-\u9fff]+$/
/* 严格 CSS 标识符形态的段可裸通过（-apple-system / BlinkMacSystemFont 这类带连字符的系统字体名
 * 在部分浏览器必须不带引号才能命中系统字体）；单连字符开头、不含空格，注入面与包引号段同安全 */
const BARE_IDENT_RE = /^-?[A-Za-z][A-Za-z0-9_-]*$/
/* CSS 全局关键字强制包引号成普通字体名，防 font-family:inherit 之类的语义劫持 */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'default', 'none'])

/** 自定义字体栈归一化：逗号切段、逐段校验，非 generic 段——裸标识符原样通过，其余重包双引号
 * （已带引号的段剥壳复验，可幂等回放） */
export function normalizeFontStack(raw: string): string | null {
  const segs = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!segs.length || segs.length > 8) return null
  const out: string[] = []
  for (let seg of segs) {
    if (seg.length > 60) return null
    if (GENERIC_FAMILIES.has(seg.toLowerCase())) {
      out.push(seg.toLowerCase())
      continue
    }
    // 已带引号的段（存库栈回放）剥壳后再验字符集
    if ((seg.startsWith('"') && seg.endsWith('"')) || (seg.startsWith("'") && seg.endsWith("'"))) seg = seg.slice(1, -1)
    if (!seg || seg.length > 60 || !FONT_SEG_RE.test(seg)) return null
    if (!CSS_WIDE_KEYWORDS.has(seg.toLowerCase()) && BARE_IDENT_RE.test(seg)) {
      out.push(seg)
      continue
    }
    out.push('"' + seg + '"')
  }
  const stack = out.join(', ')
  return stack.length <= 400 ? stack : null
}

/** 色值归一化：只收 #rgb / #rrggbb，三位的展开成六位，统一小写 */
function normalizeColor(v: string): string | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (!m) return null
  const hex = m[1]
  return hex.length === 3 ? '#' + hex.split('').map((ch) => ch + ch).join('') : '#' + hex
}

const ROLE_KEYS: string[] = APPEARANCE_ROLES.map((r) => r.key)

/** settings.appearance 净化：合法返回规范化紧凑 JSON（空配置返回 ''），非法返回 null（调用方 400）。
 * 不感知当前主题——角色是否被主题支持、是否等于主题默认值，留给渲染端按当前主题过滤，
 * 这样先调外观再换皮肤（或反之）顺序无关 */
export function cleanAppearanceSettings(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.length > 2000) return null
  let obj: unknown
  try {
    obj = JSON.parse(s)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === 'fontSize') {
      if (v === '' || v == null) continue
      const n = Number(v)
      if (!Number.isFinite(n)) return null
      if (n === 0) continue // 0 = 清除字号（14-22 是合法区间，0 不会是正常选择）
      out[k] = Math.round(Math.min(22, Math.max(14, n)) * 2) / 2
      continue
    }
    if (k === 'font') {
      const fs = String(v ?? '').trim()
      if (!fs) continue
      const preset = FONT_PRESETS.find((p) => p.id === fs)
      const stack = preset ? preset.stack : normalizeFontStack(fs)
      if (!stack) return null
      out[k] = stack
      continue
    }
    if (k === 'radius') {
      if (v === '' || v == null) continue
      // 只收 number（Number([]) 会隐式变 0，放宽 typeof 会放数组穿透）
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
      // 0 = 直角风格（合法值，与 fontSize 的「0 = 清除」语义不同：清除 radius 靠省键）
      out[k] = Math.round(Math.min(24, Math.max(0, v)))
      continue
    }
    if (!ROLE_KEYS.includes(k)) return null
    if (typeof v !== 'string') return null
    const color = normalizeColor(v)
    if (!color) return null
    out[k] = color
  }
  const ordered: Record<string, string | number> = {}
  for (const r of ROLE_KEYS) if (r in out) ordered[r] = out[r]
  if ('font' in out) ordered.font = out.font
  if ('fontSize' in out) ordered.fontSize = out.fontSize
  if ('radius' in out) ordered.radius = out.radius
  return Object.keys(ordered).length ? JSON.stringify(ordered) : ''
}

/** 渲染期：按当前主题把外观配置转成覆盖 <style>。无配置 / 主题未知 / 净化后为空 → ''（输出字节级不变） */
export function appearanceHeadStyle(settings: SettingsMap): string {
  // 查表必须过 hasOwnProperty:theme='constructor' 等原型链键会取到 truthy 的继承属性,
  // 随后 theme.roles 取 undefined 的属性直接 TypeError(设置页 PUT 已拦,这里防旁路写库)
  const themeKey = settings.theme || ''
  if (!Object.prototype.hasOwnProperty.call(THEME_APPEARANCE, themeKey)) return ''
  const theme = THEME_APPEARANCE[themeKey]
  if (!theme) return ''
  const cleaned = cleanAppearanceSettings(settings.appearance || '')
  if (!cleaned) return ''
  let obj: Record<string, string | number>
  try {
    obj = JSON.parse(cleaned)
  } catch {
    return ''
  }
  const picks: string[] = []
  for (const r of APPEARANCE_ROLES) {
    const entry = theme.roles[r.key]
    const pick = typeof obj[r.key] === 'string' ? (obj[r.key] as string) : ''
    if (!entry || !pick) continue
    if (pick === normalizeColor(entry.default)) continue // 与主题默认同值 = 没改，不出声明
    for (const v of entry.vars) picks.push(`${v}:${pick}`)
    if (entry.derived) {
      for (const d of entry.derived) {
        const pct = Math.max(0, Math.min(100, d.amount))
        picks.push(
          d.kind === 'shade'
            ? `${d.varName}:color-mix(in srgb, ${pick} ${100 - pct}%, #000 ${pct}%)`
            : `${d.varName}:color-mix(in srgb, ${pick} ${pct}%, transparent)`
        )
      }
    }
  }
  // 圆角：只重写主题的基准变量，--<p>-radius-lg 在主题 CSS 里用 calc 派生成比例走；同默认值不输出
  if (theme.radius && typeof obj.radius === 'number' && obj.radius !== theme.radius.default) {
    picks.push(`${theme.radius.var}:${Math.round(Math.min(24, Math.max(0, obj.radius)))}px`)
  }
  const rules: string[] = []
  if (picks.length) rules.push(`:root{${picks.join(';')}}`)
  if (typeof obj.font === 'string' && obj.font) {
    // 渲染端二次校验：即便库里的数据被别处写脏，到不了 CSS 语法位
    const stack = normalizeFontStack(obj.font)
    if (stack) rules.push(`body{font-family:${stack}}`)
  }
  if (typeof obj.fontSize === 'number' && obj.fontSize && obj.fontSize !== theme.richSize) {
    rules.push(`.rich{font-size:${obj.fontSize}px}`)
  }
  if (!rules.length) return ''
  return `<style data-appearance>${rules.join('')}</style>`
}

/** /meta/themes 出参：当前主题支持的角色、默认值、正文字号基线与字体预设（后台外观面板用） */
export function appearanceMeta(themeId: string) {
  if (!Object.prototype.hasOwnProperty.call(THEME_APPEARANCE, themeId)) return null
  const t = THEME_APPEARANCE[themeId]
  if (!t) return null
  return {
    roles: APPEARANCE_ROLES.filter((r) => t.roles[r.key]).map((r) => ({
      key: r.key,
      label: r.label,
      default: (t.roles[r.key] as RoleEntry).default,
      /** 该角色映射的主题 CSS 变量名（后台实时预览用它构造同款覆盖样式） */
      vars: (t.roles[r.key] as RoleEntry).vars,
    })),
    richSize: t.richSize,
    radius: t.radius ? { var: t.radius.var, default: t.radius.default, lgFactor: t.radius.lgFactor } : null,
    fontPresets: FONT_PRESETS.map((p) => ({ id: p.id, label: p.label, stack: p.stack })),
  }
}
