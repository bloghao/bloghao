/**
 * 上传常量与 R2 图床落库：api.ts 手动上传 / collect.ts 公众号采集转存 / external.ts 外部发布共用。
 * 常量与白名单只此一份——此前三份拷贝曾漂移出行为差异（image/jpg 别名、ico），改口径一处生效。
 */
import type { Env } from './types'
import { sha256Hex } from './utils'
import { stripImageMetadata } from './exif'

/** 上传体积上限（手动上传与各转存链路同口径） */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** 图片 mime → 扩展名白名单。ico 供 favicon 上传；image/jpg 是部分客户端发的
 *  非标准别名一并放行；不放行 SVG——同源直接打开 SVG 可执行脚本，有存储 XSS 风险 */
export const IMAGE_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

/** 白名单查表：必须走 hasOwnProperty（IMAGE_MIMES['constructor'] 是继承属性，truthy 可穿透校验） */
export function imageExtOf(mime: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIMES, mime) ? IMAGE_MIMES[mime] : undefined
}

/** 字节进 R2 图床并登记 uploads 表，返回站内地址。
 *  ext/mime 由调用方先过白名单（imageExtOf）或魔数识别（sniffImageExt）；
 *  dir 为图床目录（普通上传 u/，OG 卡图 og/），年月子目录由这里统一拼。
 *  落库前统一剥 EXIF/GPS 元数据（src/exif.ts，纯字节手术；GIF/视频/带旋转标记的
 *  JPEG 原样返回）——哈希与登记 size 都取剥离后的字节，媒体查重与体检查重口径一致 */
export async function saveUpload(
  env: Env,
  buf: ArrayBuffer,
  mime: string,
  name: string,
  ext: string,
  dir = 'u'
): Promise<string> {
  const now = new Date()
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const key = `${dir}/${ym}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`
  const clean = stripImageMetadata(buf)
  await env.IMAGES.put(key, clean, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  })
  await env.DB.prepare('INSERT INTO uploads (key, name, mime, size, created_at, hash) VALUES (?, ?, ?, ?, ?, ?)')
    // SHA-256 指纹随登记入库（媒体「体检」查重用，见 src/audit.ts）；老数据由 hash-backfill 端点增量回填
    .bind(key, name.slice(0, 120), mime, clean.byteLength, Date.now(), await sha256Hex(clean))
    .run()
  return `/images/${key}`
}

/* ---------------- 远程图片转存（collect 公众号采集 / 编辑器粘贴净化共用） ---------------- */

/** 单篇内容转存外链图的数量上限：Workers 免费档单请求 50 个子请求，预留余量 */
export const MAX_REMOTE_IMAGES = 30

/** 单次远程抓取（图片）超时 */
const REMOTE_FETCH_TIMEOUT_MS = 15_000

/** 部分源站（mmbiz.qpic.cn 等）对无浏览器特征的请求回防盗链占位图，带 UA + 微信 Referer */
const REMOTE_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 从文件魔数识别图片真实类型；识别不出返回 null（HTML/SVG/其它一律拒收） */
export function sniffImageExt(buf: ArrayBuffer): 'jpg' | 'png' | 'gif' | 'webp' | null {
  const b = new Uint8Array(buf, 0, Math.min(16, buf.byteLength))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif' // GIF87a / GIF89a
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  )
    return 'webp'
  return null
}

/** 抓远程图片 → 魔数识别 → R2 图床落库，返回站内地址；失败返回 null，回退策略由调用方定。
 *  类型只认文件魔数，不信任源站 Content-Type / URL 参数（如 wx_fmt）：声明成图片但内容
 *  是 HTML/SVG 的响应一律拒收，存储的 Content-Type 由识别出的扩展名反推，
 *  保证 /images/ 回源时永远是安全的图片类型 */
/** 远程图转存：进 R2 图床返回站内地址。referer 缺省沿用公众号场景（有防盗链的源
 *  各自定义，如豆瓣图床要求豆瓣域 Referer）；只认文件魔数，声明长度与实际字节双限 */
export async function transferImage(env: Env, url: string, name: string, referer?: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': REMOTE_FETCH_UA, Referer: referer || 'https://mp.weixin.qq.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    // 先看声明长度再读体：超大响应直接放弃（有些服务器不回 Content-Length，兜底仍靠读后的字节数检查）
    if (Number(res.headers.get('content-length') || 0) > MAX_UPLOAD_BYTES) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_UPLOAD_BYTES) return null
    const ext = sniffImageExt(buf)
    if (!ext) return null
    return saveUpload(env, buf, `image/${ext === 'jpg' ? 'jpeg' : ext}`, name, ext)
  } catch {
    return null
  }
}
