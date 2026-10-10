/**
 * 上传图片元数据剥离（EXIF / GPS / XMP / IPTC / 文本块）：纯 ArrayBuffer 字节手术，
 * 不解码像素、零画质损失、ICC 颜色配置保留。saveUpload 落库前统一调用——api 手动上传 /
 * collect 采集转存 / external 外部发布 / TG 转存共用这一处；客户端 canvas 重编码的产物
 * 本就无元数据，这里兜住「小图直通」「GIF 直传」「远端转存」三条原样入库的路，
 * 手机照片的 GPS 坐标与拍摄设备信息不再随图落库。
 *
 * 两条铁律：
 * - 任何解析异常（截断 / 越界 / 结构不符）一律原样返回——剥离绝不阻塞或弄坏上传；
 * - JPEG 方向守卫——EXIF orientation ≠ 1 的文件整体跳过：浏览器靠这个标记摆正显示，
 *   剥了会横竖颠倒，宁可保留元数据也不破坏显示（orientation=1 / 缺省照常剥离；
 *   大图走客户端压缩链路时像素已摆正、元数据已天然不存在，不受此限）。
 * 存量图不回溯，只对本次上传生效。
 */

/** 按魔数识别并剥离元数据；非 JPEG / PNG / WebP（GIF、视频、ico 等）或不含元数据时原样返回 */
export function stripImageMetadata(buf: ArrayBuffer): ArrayBuffer {
  try {
    const b = new Uint8Array(buf)
    if (b.length < 12) return buf
    if (b[0] === 0xff && b[1] === 0xd8) return stripJpeg(buf, b)
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return stripPng(buf, b)
    if (
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
    )
      return stripWebp(buf, b)
    return buf
  } catch {
    return buf
  }
}

/** 按保留区间拼新缓冲；区间外字节（含 IEND 后的尾部杂项）原样保留 */
function buildFromRanges(b: Uint8Array, ranges: Array<[number, number]>): ArrayBuffer {
  const total = ranges.reduce((n, [s, e]) => n + (e - s), 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const [s, e] of ranges) {
    out.set(b.subarray(s, e), off)
    off += e - s
  }
  return out.buffer
}

/* ---------------- JPEG：摘 APP1（Exif/XMP）/ APP13（IPTC）/ COM，ICC（APP2）保留防偏色 ---------------- */

function stripJpeg(buf: ArrayBuffer, b: Uint8Array): ArrayBuffer {
  if (jpegOrientation(b) > 1) return buf
  let i = 2
  let keepStart = 0
  let dropped = false
  const ranges: Array<[number, number]> = []
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return buf
    const m = b[i + 1]
    if (m === 0xff) {
      i += 1 // 段间的填充 FF
    } else if (m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xd8) {
      i += 2 // 无长度字段的独立段（RST/TEM/SOI）
    } else if (m === 0xd9 || m === 0xda) {
      break // EOI / SOS：SOS 之后是扫描数据，不再有元数据段
    } else {
      if (i + 4 > b.length) return buf
      const len = (b[i + 2] << 8) | b[i + 3] // 段长度含长度字段自身
      if (len < 2 || i + 2 + len > b.length) return buf
      if (m === 0xe1 || m === 0xed || m === 0xfe) {
        dropped = true
        ranges.push([keepStart, i])
        keepStart = i + 2 + len
      }
      i += 2 + len
    }
  }
  if (!dropped) return buf
  ranges.push([keepStart, b.length])
  return buildFromRanges(b, ranges)
}

/** 读 EXIF orientation；无 / 缺省 / 解析不动一律按 1（正常摆正）处理 */
function jpegOrientation(b: Uint8Array): number {
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return 1
    const m = b[i + 1]
    if (m === 0xff) {
      i += 1
    } else if (m === 0x01 || (m >= 0xd0 && m <= 0xd9) || m === 0xd8) {
      i += 2
    } else if (m === 0xd9 || m === 0xda) {
      return 1
    } else {
      if (i + 4 > b.length) return 1
      const len = (b[i + 2] << 8) | b[i + 3]
      if (len < 2 || i + 2 + len > b.length) return 1
      if (
        m === 0xe1 &&
        len > 8 &&
        b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && // "Exif"
        b[i + 8] === 0 && b[i + 9] === 0
      ) {
        const o = tiffOrientation(b, i + 10, i + 2 + len)
        if (o > 1) return o
      }
      i += 2 + len
    }
  }
  return 1
}

/** TIFF 头（"II"/"MM" + 42 + IFD0 偏移）→ IFD0 条目里找 0x0112 orientation（SHORT） */
function tiffOrientation(b: Uint8Array, tiffStart: number, segEnd: number): number {
  if (tiffStart + 8 > segEnd) return 1
  const le = b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49
  if (!le && !(b[tiffStart] === 0x4d && b[tiffStart + 1] === 0x4d)) return 1
  const u16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1])
  const u32 = (p: number) => (le ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24) : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0)
  if (u16(tiffStart + 2) !== 42) return 1
  const ifd0 = tiffStart + u32(tiffStart + 4)
  if (ifd0 + 2 > segEnd) return 1
  const n = u16(ifd0)
  if (n === 0 || ifd0 + 2 + n * 12 > segEnd) return 1
  for (let k = 0; k < n; k++) {
    const e = ifd0 + 2 + k * 12
    if (u16(e) === 0x0112) {
      // SHORT 内联在值字段前两字节
      return u16(e + 8) || 1
    }
  }
  return 1
}

/* ---------------- PNG：摘 eXIf / tEXt / zTXt / iTXt / tIME 辅助块，iCCP 等保留 ---------------- */

function stripPng(buf: ArrayBuffer, b: Uint8Array): ArrayBuffer {
  let i = 8
  let keepStart = 0 // 保留区间从 0 起（含 8 字节签名）
  let dropped = false
  const ranges: Array<[number, number]> = []
  while (i + 12 <= b.length) {
    // chunk：4B 大端长度 + 4B 类型 + data + 4B CRC，共 12 + len
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
    if (i + 12 + len > b.length) return buf
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    if (type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'tIME') {
      dropped = true
      ranges.push([keepStart, i])
      keepStart = i + 12 + len
    }
    i += 12 + len
    if (type === 'IEND') break
  }
  if (!dropped) return buf
  ranges.push([keepStart, b.length])
  return buildFromRanges(b, ranges)
}

/* ---------------- WebP：摘 RIFF 顶层 EXIF / XMP 块，同步清 VP8X 标志位、修 RIFF 尺寸 ---------------- */

/** 读 WebP EXIF chunk 里的 orientation：chunk data 以 "Exif\0\0" 开头时 TIFF 头在其后，
 *  历史文件也可能直接以 TIFF 头开始（两种都探测，解析不动按 1） */
function webpOrientation(b: Uint8Array, exifDataStart: number): number {
  if (b[exifDataStart] === 0x45 && b[exifDataStart + 1] === 0x78 && b[exifDataStart + 2] === 0x69 && b[exifDataStart + 3] === 0x66 && b[exifDataStart + 4] === 0 && b[exifDataStart + 5] === 0) {
    return tiffOrientation(b, exifDataStart + 6, b.length)
  }
  if (b[exifDataStart] === 0x49 || b[exifDataStart] === 0x4d) {
    return tiffOrientation(b, exifDataStart, b.length)
  }
  return 1
}

function stripWebp(buf: ArrayBuffer, b: Uint8Array): ArrayBuffer {
  // 方向守卫（与 JPEG 同款）：EXIF orientation ≠ 1 的文件整体跳过——浏览器靠它摆正显示，
  // 剥了 EXIF 块横竖就颠倒了
  let scan = 12
  while (scan + 8 <= b.length) {
    const size = ((b[scan + 4] | (b[scan + 5] << 8) | (b[scan + 6] << 16) | (b[scan + 7] << 24)) >>> 0)
    const total = 8 + size + (size & 1)
    if (size > 0x7fffffff || scan + total > b.length) break
    if (b[scan] === 0x45 && b[scan + 1] === 0x58 && b[scan + 2] === 0x49 && b[scan + 3] === 0x46) {
      if (webpOrientation(b, scan + 8) > 1) return buf
      break // EXIF 块只取第一份
    }
    scan += total
  }
  let i = 12
  let keepStart = 0 // 保留区间从 0 起（含 "RIFF"+尺寸+"WEBP" 12 字节头）
  let dropped = false
  const ranges: Array<[number, number]> = []
  while (i + 8 <= b.length) {
    // chunk：fourcc(4) + 4B LE size + data + 奇数长度补 1 字节
    const size = ((b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0)
    const total = 8 + size + (size & 1)
    if (size > 0x7fffffff || i + total > b.length) return buf
    const cc = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3])
    if (cc === 'EXIF' || cc === 'XMP ') {
      dropped = true
      ranges.push([keepStart, i])
      keepStart = i + total
    }
    i += total
  }
  if (!dropped) return buf
  ranges.push([keepStart, b.length])
  const out = new Uint8Array(buildFromRanges(b, ranges))
  // VP8X 的标志字节里 EXIF(0x08) / XMP(0x04) 位清零，防解析器按标志找不到块而困惑；ICC(0x20)/ALPHA(0x10) 不动
  const u32le = (p: number) => out[p] | (out[p + 1] << 8) | (out[p + 2] << 16) | (out[p + 3] << 24)
  let j = 12
  while (j + 8 <= out.length) {
    const size = u32le(j + 4) >>> 0
    const total = 8 + size + (size & 1)
    if (size > 0x7fffffff || j + total > out.length) break
    if (out[j] === 0x56 && out[j + 1] === 0x50 && out[j + 2] === 0x38 && out[j + 3] === 0x58) {
      out[j + 8] &= ~(0x08 | 0x04) // "VP8X"
    }
    j += total
  }
  // RIFF 尺寸字段 = 文件总长 - 8
  const riffSize = out.length - 8
  out[4] = riffSize & 0xff
  out[5] = (riffSize >>> 8) & 0xff
  out[6] = (riffSize >>> 16) & 0xff
  out[7] = (riffSize >>> 24) & 0xff
  return out.buffer
}
