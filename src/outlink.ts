/**
 * 外链中间页（/go）与外链包装：站内出现的第三方链接，白名单域名直接跳转，
 * 其余一律包一层 /go?u=<url> 确认页——提醒「即将离开本站」并附免责声明，
 * 由访客自行决定是否继续（钓鱼 / 仿冒站点的最后一道提醒）。
 *
 * 包装的两个收口（新增公开面时二选一过一遍，别在别处手搓判断）：
 * - 文章 / 页面 / 关于我正文：sanitizeHtml(html, { origin })（src/sanitize.ts，仅渲染时包装，
 *   存库 / RSS / 导出保持原始 URL）
 * - 微博正文：render.ts weiboTextHtml（服务端）与 public/site.js wbTextHtml（前台编辑就地重渲染，
 *   白名单表在客户端有一份手工同步的镜像）
 *
 * 本模块被 Node 测试直接导入（同 protect.ts / trash.ts 理由），不依赖 Workers 运行时。
 */
import { esc } from './utils'

/** 直跳白名单（主域名，子域名自动跟随：www.apple.com 命中 apple.com）。
 *  前四项是站长自有域名（官方版挑洗时按 docs/RELEASING.md 个人定制台账处理），
 *  其余为主流官方大站；客户端 site.js 有一份同表镜像，改动两边同步 */
export const TRUSTED_OUT_DOMAINS: readonly string[] = [
  // 站长自有
  'bloghao.com',
  'xiaowuleyi.com',
  'habfut.com',
  'btchao.com',
  // 国际主流 / 大厂
  'apple.com',
  'icloud.com',
  'google.com',
  'youtube.com',
  'android.com',
  'microsoft.com',
  'live.com',
  'office.com',
  'bing.com',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'npmjs.com',
  'wikipedia.org',
  'wikimedia.org',
  'mozilla.org',
  'cloudflare.com',
  'amazon.com',
  'x.com',
  'twitter.com',
  'twimg.com',
  'facebook.com',
  'instagram.com',
  'threads.net',
  'linkedin.com',
  'reddit.com',
  'pinterest.com',
  'tiktok.com',
  'telegram.org',
  't.me',
  'discord.com',
  'medium.com',
  'substack.com',
  'openai.com',
  'anthropic.com',
  'huggingface.co',
  // 国内主流
  'weibo.com',
  'weibo.cn',
  'sina.com.cn',
  'baidu.com',
  'zhihu.com',
  'bilibili.com',
  'b23.tv',
  'qq.com',
  'tencent.com',
  '163.com',
  '126.com',
  'netease.com',
  'jd.com',
  'taobao.com',
  'tmall.com',
  'alipay.com',
  'aliyun.com',
  'alibaba.com',
  'douyin.com',
  'kuaishou.com',
  'xiaohongshu.com',
  'sohu.com',
  'csdn.net',
  'juejin.cn',
  'cnblogs.com',
  'segmentfault.com',
  'v2ex.com',
  'gitee.com',
  'oschina.net',
  'jianshu.com',
  'sspai.com',
  'ithome.com',
  '36kr.com',
  'mi.com',
  'xiaomi.com',
  'huawei.com',
]

/** 主域名命中：host 恰为白名单项或其子域（尾部点归一化，大小写不敏感） */
export function isTrustedOutHost(host: string): boolean {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '')
  if (!h) return false
  for (const d of TRUSTED_OUT_DOMAINS) {
    if (h === d || h.endsWith('.' + d)) return true
  }
  return false
}

/** 中间页包装的 URL 长度上限：超长 URL 不包（编码后可能撑爆请求行），保持原样直出 */
const MAX_OUT_URL_CHARS = 1000

/**
 * 外链跳转地址：白名单 / 同源 / 非 http(s) / 解析失败 / 超长一律原样返回，
 * 其余包成 /go?u=<encodeURIComponent>。文章正文、微博文本、后台出参等所有
 * 「想给外链加中间页」的地方都走这一个函数。
 */
export function outHref(url: string, origin?: string): string {
  const raw = String(url ?? '').trim()
  if (!raw || raw.length > MAX_OUT_URL_CHARS) return raw
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  if (origin && u.origin === String(origin).replace(/\/+$/, '')) return raw
  if (isTrustedOutHost(u.hostname)) return raw
  return `/go?u=${encodeURIComponent(u.href)}`
}

/**
 * 净化器 href 属性值 → 绝对 URL（escAttr 产物先做实体解码再解析，含 &amp; 的查询串才不会断）。
 * 仅接受 http(s) 绝对地址；其余（相对路径 / mailto / 解析失败）返回 null，由调用方保持原样。
 */
export function attrHrefToUrl(raw: string): string | null {
  const v = String(raw ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
  if (!/^https?:\/\//i.test(v)) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** 渲染期包装：返回 /go 中间页地址；不该包（白名单 / 同源 / 超长 / 非 http(s)）返回 null 保持原 href。
 *  origin 传当前请求源（pages 层有），同源链接不打弯 */
export function wrapAnchorHref(rawHref: string, origin?: string): string | null {
  const abs = attrHrefToUrl(rawHref)
  if (!abs || abs.length > MAX_OUT_URL_CHARS) return null
  const wrapped = outHref(abs, origin)
  return wrapped === abs ? null : wrapped
}

/** /go 中间页：脱离主题的极简独立页（同闭站页口径），无 JS——「继续访问」就是普通链接。
 *  必带 noindex；URL 与域名全部过 esc，目标 URL 来自查询串，任何字符都进不了标记结构 */
export function goPageHtml(target: URL, siteName: string, en = false): string {
  const site = siteName || 'BlogHao'
  if (en) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>External link notice - ${esc(site)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:light dark}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:#f4f4f5;color:#52525b}
.card{max-width:520px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:16px;
  padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.badge{width:44px;height:44px;border:1.5px solid #f59e0b;border-radius:50%;display:flex;
  align-items:center;justify-content:center;color:#f59e0b;margin-bottom:18px}
h1{font-size:19px;font-weight:600;color:#18181b;margin-bottom:10px}
p{font-size:14px;line-height:1.8}
.host{display:inline-block;max-width:100%;margin:14px 0 4px;padding:4px 12px;border-radius:999px;
  background:#fef3c7;color:#92400e;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  word-break:break-all}
.url{margin:12px 0 0;padding:10px 12px;border:1px dashed #d4d4d8;border-radius:8px;background:#fafafa;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;
  word-break:break-all;color:#71717a;user-select:all}
.warn{margin-top:18px;padding:12px 14px;border-radius:8px;background:#fafafa;border:1px solid #e4e4e7;
  font-size:13px;line-height:1.9;color:#71717a}
.actions{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
.btn{flex:1;min-width:140px;text-align:center;padding:11px 18px;border-radius:999px;font-size:14px;
  text-decoration:none;font-weight:500}
.btn-go{background:#b23a29;color:#fff}
.btn-back{border:1px solid #d4d4d8;color:#52525b}
.hint{margin-top:16px;font-size:12px;color:#a1a1aa;text-align:center}
@media (prefers-color-scheme:dark){
  body{background:#18181b;color:#a1a1aa}
  .card{background:#1d1d21;border-color:#2e2e33}
  h1{color:#f4f4f5}
  .url{background:#26262b;border-color:#3f3f46;color:#a1a1aa}
  .warn{background:#26262b;border-color:#3f3f46;color:#a1a1aa}
  .btn-back{border-color:#3f3f46;color:#d4d4d8}
}
</style>
</head>
<body>
<div class="card">
<div class="badge" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
<h1>You are leaving "${esc(site)}"</h1>
<p>The link you clicked points to a third-party website: <span class="host">${esc(target.hostname)}</span></p>
<div class="url">${esc(target.href)}</div>
<div class="warn"><b>Disclaimer</b>: this link does not belong to this site. The third-party website's content, privacy policy and security are unrelated to this site, and this site makes no guarantee about them. Verify the information yourself, watch out for phishing and scams, and never enter this site's password or sensitive personal information on an unfamiliar website.</div>
<div class="actions">
<a class="btn btn-go" href="${esc(target.href)}" rel="nofollow noopener noreferrer" target="_blank">Continue</a>
<a class="btn btn-back" href="/">Back to Home</a>
</div>
<p class="hint">Opens in a new window; use your browser's Back button to return to this page</p>
</div>
</body>
</html>`
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>外部链接提醒 - ${esc(site)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:light dark}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;
  background:#f4f4f5;color:#52525b}
.card{max-width:520px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:16px;
  padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.badge{width:44px;height:44px;border:1.5px solid #f59e0b;border-radius:50%;display:flex;
  align-items:center;justify-content:center;color:#f59e0b;margin-bottom:18px}
h1{font-size:19px;font-weight:600;color:#18181b;margin-bottom:10px}
p{font-size:14px;line-height:1.8}
.host{display:inline-block;max-width:100%;margin:14px 0 4px;padding:4px 12px;border-radius:999px;
  background:#fef3c7;color:#92400e;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  word-break:break-all}
.url{margin:12px 0 0;padding:10px 12px;border:1px dashed #d4d4d8;border-radius:8px;background:#fafafa;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;
  word-break:break-all;color:#71717a;user-select:all}
.warn{margin-top:18px;padding:12px 14px;border-radius:8px;background:#fafafa;border:1px solid #e4e4e7;
  font-size:13px;line-height:1.9;color:#71717a}
.actions{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
.btn{flex:1;min-width:140px;text-align:center;padding:11px 18px;border-radius:999px;font-size:14px;
  text-decoration:none;font-weight:500}
.btn-go{background:#b23a29;color:#fff}
.btn-back{border:1px solid #d4d4d8;color:#52525b}
.hint{margin-top:16px;font-size:12px;color:#a1a1aa;text-align:center}
@media (prefers-color-scheme:dark){
  body{background:#18181b;color:#a1a1aa}
  .card{background:#1d1d21;border-color:#2e2e33}
  h1{color:#f4f4f5}
  .url{background:#26262b;border-color:#3f3f46;color:#a1a1aa}
  .warn{background:#26262b;border-color:#3f3f46;color:#a1a1aa}
  .btn-back{border-color:#3f3f46;color:#d4d4d8}
}
</style>
</head>
<body>
<div class="card">
<div class="badge" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div>
<h1>即将离开「${esc(site)}」</h1>
<p>你点击的链接指向第三方网站：<span class="host">${esc(target.hostname)}</span></p>
<div class="url">${esc(target.href)}</div>
<div class="warn"><b>免责声明</b>：该链接不属于本站，第三方网站的内容、隐私政策与安全性与本站无关，本站对其不作任何担保。请自行核实信息真伪，谨防钓鱼与诈骗，不要在陌生网站输入本站密码或敏感个人信息。</div>
<div class="actions">
<a class="btn btn-go" href="${esc(target.href)}" rel="nofollow noopener noreferrer" target="_blank">继续访问</a>
<a class="btn btn-back" href="/">返回首页</a>
</div>
<p class="hint">新窗口打开目标网站；返回本页可用浏览器的「后退」键</p>
</div>
</body>
</html>`
}
