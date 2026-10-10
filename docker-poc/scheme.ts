/**
 * 浏览器侧真实 scheme 判定（docker-poc 独立模块）：server.ts 组装 fetch Request 与
 * control.ts 控制面 Cookie Secure 位共用同一份实现，两边口径必须一致。
 */

/**
 * 浏览器侧真实 scheme。优先级：
 *  1. Origin 头（host 与请求一致时）——api.ts 的同源 CSRF 校验拿它和 c.req.url.origin 全等比较，
 *     scheme 不一致就会误判跨站（CF 灵活 SSL 实测被拒）
 *  2. CF-Visitor——Cloudflare 注入的访客侧 scheme（灵活 SSL 下也是 https，X-Forwarded-Proto 则是回源段）
 *  3. X-Forwarded-Proto（常规 TLS 反代）
 *  4. http
 */
export function resolveScheme(headers: Headers, host: string): string {
  const origin = headers.get('origin')
  if (origin) {
    try {
      const o = new URL(origin)
      if (o.host === host) return o.protocol.replace(':', '')
    } catch {
      /* 非法 Origin 走兜底链 */
    }
  }
  try {
    const visitor = JSON.parse(headers.get('cf-visitor') || '{}') as { scheme?: string }
    if (visitor.scheme) return visitor.scheme
  } catch {
    /* 头损坏走兜底链 */
  }
  const xfp = (headers.get('x-forwarded-proto') || '').split(',')[0].trim()
  return xfp || 'http'
}

/** IncomingMessage 头 → Headers（控制面在 http 适配层之前就要按 scheme 决定 Cookie Secure 位） */
export function schemeOfIncoming(
  req: { headers: Record<string, string | string[] | undefined> },
  host: string
): string {
  const h = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach((v) => h.append(key, v))
    else h.set(key, value)
  }
  return resolveScheme(h, host)
}
