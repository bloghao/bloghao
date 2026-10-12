/** Cloudflare Turnstile 注册人机验证（A2 根治：注册零验证成本是会员经济 Sybil 的根）。
 * 独立小文件：verifyTurnstile 纯函数、fetch 可注入（tests/turnstile.test.ts 直接导入）。
 * siteverify 是固定可信端点，直连不fetchsafe（同 api.telegram.org 口径，路径无用户输入）；
 * 拿不到明确 success=true 一律 false（fail closed）——验证服务不可用时宁可挡住注册。 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** 校验前端 Turnstile 令牌。token 为空直接 false（不打 siteverify）；
 * remoteip 选填（与 Cloudflare 文档一致，IP 不一致只扣分不必然失败，失败结论以 success 为准） */
export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!secret || !token) return false
  try {
    const form = new URLSearchParams({ secret, response: token })
    if (remoteIp) form.set('remoteip', remoteIp)
    const r = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // 挑战端点偶发抖动也不许拖住注册请求：10 秒拿不到结论按失败处理
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return false
    const data = (await r.json()) as { success?: unknown }
    return data.success === true
  } catch {
    return false
  }
}
