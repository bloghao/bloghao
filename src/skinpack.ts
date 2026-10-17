/* ===== 皮肤包 / 自定义 CSS（B8 · 皮肤可安装形态拍板：CSS 层承接个性化）=====
 * 皮肤包 = 一份外观变量预设（复用 appearance 体系，主题无关、渲染期按当前主题过滤）
 * + 一段可选自定义 CSS。应用皮肤包 = PUT settings 的 appearance / customCss 两键，
 * 免部署、可随时清空还原，无新表无新路由。
 *
 * 安全面（样式安检门）：customCss 以 <style data-custom-css> 拼进每页 <head>，本模块是
 * 唯一注入口——
 *  - `<` 全剥：CSS 语法不需要 <（媒体查询区间语法请用 max-width 形式），剥净后
 *    </style> / <!-- / <script> 等一切标签逃逸花招都不可能成立
 *  - 反斜杠全剥：CSS 转义序列（@\69 mport、@im\port、url(\68 ttps://…)）能绕过明文
 *    关键字剥离，而反斜杠是转义生效的唯一条件——剥净后「转义写法」退化成普通文本
 *    （不再是合法的 @import / expression），且输出不含 `\`（浏览器无从还原）。
 *    代价：内容里真用 \XXXX 转义的字符按字面输出（如 content:"\201C" 显示 201C，极少见）
 *  - 注释先剥（位置落空格）：CSS 注释对剥掉并落成空格，关键字中段藏注释的分词混淆
 *    （@im 与 port 之间插注释那类写法）在净化器正则与浏览器解析之间再无分歧面
 *    （见 cleanCustomCss 内注；字面示例只写在行注释里，块注释里放不得——注释本身含闭合序）
 *  - 剥 @import：外部样式表既是额外请求面，也能整表重排级联
 *  - 剥 expression() / -moz-binding / behavior:（历史脚本面，剥除代价一行）
 *  - url() 白名单：无 scheme = 站内相对放行；有 scheme 只认 https 与 data:image|font
 *  - 花括号必须配平（给作者的手滑反馈，也防手粘半个规则块）
 * PUT 时非法整体 400（cleanCustomCss 返回 null），渲染端 customCssHeadStyle 二次净化幂等兜底
 * （库被旁路写脏时静默当没配，到不了 <style> 的任何脏字节）。净化操作全是「剥除」型，
 * 幂等：clean(clean(x)) === clean(x)。
 * CSP：customCss 非空时 buildCsp 追加 font-src 'self' https: data:（放行外链字体），
 * 否则 CSP 字节级不变（见 pages.ts）。
 */
import type { SettingsMap } from './types'

export const CUSTOM_CSS_MAX = 8000

/** 控制字符（保留 \t \n \r）；CSS 语法位不需要其余控制字符 */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** url() 取值白名单：无 scheme = 站内相对（放行）；有 scheme 只认 https 与 data:image|font，
 * 其余（javascript: / http: / data:text/html 等）一律拒绝（宁拒勿漏） */
function urlAllowed(raw: string): boolean {
  const u = raw.trim()
  if (!u) return true
  if (u.startsWith('//')) return false // 协议相对地址：要求显式写 https:
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(u)
  if (!m) return true
  const scheme = m[1].toLowerCase()
  if (scheme === 'https') return true
  if (scheme === 'data') return /^data:(image|font)\//i.test(u)
  return false
}

/** 自定义 CSS 净化：合法返回净化后的文本（空串 = 清空），非法返回 null（调用方 400）。
 * 幂等——渲染端会再过一遍，返回值必须能原样通过 */
export function cleanCustomCss(raw: string): string | null {
  const s0 = String(raw ?? '')
  if (!s0.trim()) return ''
  if (s0.length > CUSTOM_CSS_MAX) return null
  let s = s0.replace(CONTROL_RE, '')
  // 注释先剥（位置落成空格）：注释内嵌可让关键字在「净化器正则」与「浏览器解析」之间
  // 出现分歧面——老 IE 的 expression() 上下文里 JScript 会无视注释（expr/**/ession(
  // 照样执行）；剥成空格后两边看到同一份文本，@im/**/port / expr/**/ession( / u/**/rl(
  // 分词就再也拼不回去。位置落空格（而非删空）保证相邻 token 不会因剥注释而意外粘合
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // <style> 逃逸面：< 全剥。CSS 语法不需要 <（媒体查询区间语法请用 max-width 形式），
  // 剥净后 </style>、<!--、<script> 等一切标签花招都不可能成立
  s = s.replace(/</g, '')
  // CSS 转义序列面：反斜杠是转义生效的唯一条件，全剥（先剥反斜杠、再剥关键字——顺序
  // 不可颠倒：@im\port 剥完变 @import，仍要被下面的关键字规则收掉；且 url(\68 ttps://evil)
  // 剥完不再含转义，浏览器只能按字面解析）
  s = s.replace(/\\/g, '')
  // 外部样式表 / 历史脚本面：剥关键字（残骸是解析器跳过的无效语句，无害）
  s = s.replace(/@import\b/gi, '')
  s = s.replace(/expression\s*\(/gi, '(')
  s = s.replace(/-moz-binding\s*:/gi, ':')
  s = s.replace(/behavior\s*:/gi, ':')
  // url() 白名单逐个核验
  for (const m of s.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    if (!urlAllowed(m[2])) return null
  }
  // 花括号配平
  let depth = 0
  for (const ch of s) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth < 0) return null
  }
  if (depth !== 0) return null
  return s.trim()
}

/** 渲染期：customCss → <style data-custom-css>。无配置 / 净化不过 → ''（输出字节级不变）。
 * 二次净化是幂等兜底，不走 400 通道——库里脏数据静默当没配 */
export function customCssHeadStyle(settings: SettingsMap): string {
  const css = cleanCustomCss(String(settings.customCss ?? ''))
  if (!css) return ''
  return `<style data-custom-css>${css}</style>`
}

/** CSP 是否需要放宽 font-src（有自定义 CSS 才放行外链字体，无 CSS 的站点 CSP 字节级不变）。
 *  判据走 cleanCustomCss——净化不过（脏值 / 超长 / 花括号不配平）时 customCssHeadStyle 会
 *  当没配处理、根本不出 <style>，就不该为它放宽 CSP（读未净化原值曾让脏值白放宽一档） */
export function needsFontSrc(settings: SettingsMap | null | undefined): boolean {
  return !!cleanCustomCss(String(settings?.customCss ?? ''))
}
