/**
 * 出网安全（SSRF 防线 + 响应体大小上限）：服务端所有「抓用户/第三方提供的 URL」
 * 共用的统一入口——linkmeta 链接卡抓页面、store 转存远程图、collect 采抓正文。
 *
 * 三道闸：
 * 1. fetchableUrl —— 只放行 http(s) 公网地址。私有网段判定覆盖点分 IPv4 之外
 *    的整数/十六进制/八进制表示（http://2130706433/、http://0x7f.1/ 这类绕过写法）
 *    与 IPv6 字面量（::1、IPv4-mapped、NAT64、ULA、link-local）；解析不动的可疑
 *    形态一律按私有拒绝（宁拒勿漏）。已知局限：DNS rebinding 防不了（Workers 平台
 *    出口公网、私网不可达，不构成攻击面；自托管部署在内网的机器不应把管理面暴露
 *    给不可信调用方，见 docker-poc 文档）。
 * 2. 重定向逐跳复查 —— redirect: 'manual' 自行跟跳（默认最多 5 跳），每一跳
 *    重新过 fetchableUrl，防「公网 URL 302 到 169.254.169.254」绕过。注意 Node
 *    (undici) 下 manual 重定向返回 opaqueredirect（拿不到目标与状态码），此时
 *    直接放弃该次抓取——Workers 下返回真实 3xx 可正常跟跳。
 * 3. readBodyLimited —— 响应体流式累计，超限立即断流（gzip 炸弹 / 超大文件不再
 *    整读进内存；content-length 缺失的响应只能靠它兜底）。
 */

/** WHATWG IPv4 number 解析：0x 前缀十六进制、0 前缀八进制、其余十进制；非法返回 null */
function parseIpv4Number(s: string): number | null {
  if (/^0[xX]/.test(s)) {
    if (s.length <= 2) return null
    const n = parseInt(s.slice(2), 16)
    return Number.isFinite(n) ? n : null
  }
  if (s.length > 1 && s[0] === '0') {
    const n = parseInt(s.slice(1), 8)
    return Number.isFinite(n) ? n : null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 数字形态主机名 → 4 字节（WHATWG 规则：末段是聚数段，吃掉剩余全部字节）；
 *  不是合法 IPv4 表示返回 null（调用方按可疑拒绝） */
function ipv4BytesFromHost(h: string): number[] | null {
  const parts = h.split('.')
  if (parts.length > 4 || parts[parts.length - 1] === '') return null
  const nums: number[] = []
  for (const p of parts) {
    if (p === '') return null
    const n = parseIpv4Number(p)
    if (n === null || n < 0) return null
    nums.push(n)
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  if (nums[nums.length - 1] >= Math.pow(256, 5 - nums.length)) return null
  const bytes: number[] = []
  for (let i = 0; i < nums.length - 1; i++) bytes.push(nums[i])
  const rest = 4 - bytes.length
  for (let i = rest - 1; i >= 0; i--) bytes.push(Math.floor(nums[nums.length - 1] / Math.pow(256, i)) % 256)
  return bytes
}

function isPrivateIpv4Bytes(b: number[]): boolean {
  const [a, c] = b
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && c >= 64 && c <= 127) return true // 100.64/10 CGNAT
  if (a === 169 && c === 254) return true // 含 169.254.169.254 云 metadata
  if (a === 172 && c >= 16 && c <= 31) return true
  if (a === 192 && c === 168) return true
  if (a >= 224) return true // 组播 / 保留
  return false
}

/** IPv6 字面量 → 16 字节；解析不动返回 null。尾部点分 IPv4（::ffff:1.2.3.4）先转成两个 hex 组；
 *  URL.hostname 传进来的都是标准化十六进制形态，这里兼容直接调用 */
function ipv6Bytes(h: string): number[] | null {
  if (h.includes('.')) {
    const idx = h.lastIndexOf(':')
    if (idx === -1) return null
    const b4 = ipv4BytesFromHost(h.slice(idx + 1))
    if (!b4) return null
    h = `${h.slice(0, idx + 1)}${((b4[0] << 8) | b4[1]).toString(16)}:${((b4[2] << 8) | b4[3]).toString(16)}`
  }
  const dc = h.indexOf('::')
  let groups: string[]
  if (dc !== -1) {
    const left = h.slice(0, dc)
    const right = h.slice(dc + 2)
    if (h.indexOf('::', dc + 1) !== -1) return null // 只允许一处压缩
    const head = left ? left.split(':') : []
    const tail = right ? right.split(':') : []
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill('0'), ...tail]
  } else {
    groups = h.split(':')
  }
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const v = parseInt(g, 16)
    bytes.push(v >> 8, v & 0xff)
  }
  return bytes
}

function isPrivateIpv6Bytes(b: number[]): boolean {
  if (b.every((x) => x === 0)) return true // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true // ::1
  // IPv4-mapped ::ffff:0:0/96（第 6 组 = ffff）与 NAT64 64:ff9b::/96：末 4 字节按 IPv4 判
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4Bytes(b.slice(12))
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0))
    return isPrivateIpv4Bytes(b.slice(12))
  if (b[0] >= 0xfc && b[0] <= 0xfd) return true // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // link-local fe80::/10
  return false
}

/** 私有 / 保留主机判定；解析不动的数字与 IPv6 形态按私有处理（宁拒勿漏） */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.includes(':')) {
    const b = ipv6Bytes(h)
    return b ? isPrivateIpv6Bytes(b) : true
  }
  // 全部段都是数字（含 0x / 0 前缀）才是 IPv4 数字形态，避免误杀 cafe.example.com 这类真域名
  if (h.split('.').every((p) => /^(?:0[xX][0-9a-fA-F]+|0+[0-7]*|[1-9][0-9]*)$/.test(p))) {
    const bytes = ipv4BytesFromHost(h)
    return bytes ? isPrivateIpv4Bytes(bytes) : true
  }
  return false
}

/** 只放行 http(s) 公网地址；返回 null 表示不可抓（调用方退化处理，不阻塞主流程） */
export function fetchableUrl(raw: string): URL | null {
  const t = raw.replace(/[\t\r\n]/g, '').trim()
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  if (isPrivateHost(u.hostname)) return null
  if (u.port && !/^(80|443|8080|8443)$/.test(u.port)) return null
  return u
}

/** 响应体流式读入并限长：超限断流返回 null（防 gzip 炸弹 / content-length 缺失的超大响应） */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out.buffer
}

export interface FetchPublicResult {
  res: Response
  buf: ArrayBuffer
}

/** 抓公网资源：fetchableUrl 起点校验 + 逐跳重定向复查 + 流式大小上限。
 *  任何失败（非法地址、重定向越界、超限、超时、非 2xx）返回 null，调用方按抓不到处理 */
export async function fetchPublicResource(
  rawUrl: string,
  opts: { maxBytes: number; timeoutMs: number; headers?: Record<string, string>; maxRedirects?: number }
): Promise<FetchPublicResult | null> {
  let u = fetchableUrl(rawUrl)
  if (!u) return null
  const maxRedirects = opts.maxRedirects ?? 5
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetch(u, {
        headers: opts.headers,
        // 自行跟跳，每一跳重新过 fetchableUrl（公网 URL 302 到私网是经典绕过）
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch {
      return null
    }
    // Node(undici) 的 manual 重定向返回 opaqueredirect（status 0、headers 拿不到）：
    // 无法复查目标就放弃；Workers 下这里是真实 3xx，走正常跟跳。
    // Workers 的 Response 类型联合里没有 opaqueredirect，运行时防御按字符串比
    if ((res as { type?: string }).type === 'opaqueredirect') return null
    if (res.status >= 300 && res.status < 400) {
      if (hop >= maxRedirects) return null
      const loc = res.headers.get('location')
      if (!loc) return null
      let next: URL
      try {
        next = new URL(loc, u)
      } catch {
        return null
      }
      const nu = fetchableUrl(next.href)
      if (!nu) return null
      u = nu
      continue
    }
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') || 0) > opts.maxBytes) return null
    const buf = await readBodyLimited(res, opts.maxBytes)
    if (!buf) return null
    return { res, buf }
  }
}
