/**
 * 流式 ZIP 写入器（store 模式，不压缩）—— 纯 TS 无依赖，供「数据导出」打包用。
 *
 * 为什么这样写：
 * - Workers 内存有限（128MB），图片整包缓冲不现实，所以文件数据走「数据描述符」模式
 *   （general purpose flag bit 3）：本地头先写 0 尺寸/CRC，数据写完后补一笔 descriptor，
 *   数据即可从 R2 ReadableStream 逐块流入、边流边算 CRC，整包不过内存。
 * - store 模式对图片（本就压缩过的字节）没有体积损失，换来 ~150 行的极简实现。
 * - 文件名统一按 UTF-8（flag bit 11），支持中文 slug。
 * - 不支持 >4GB 单包 / >65535 个文件（博客规模远远用不到，超限会产出损坏包，调用方需自行控制）。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC32 增量计算：首块 seed 传 0，后续块传上一块的返回值 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = ~seed
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

const ENC = new TextEncoder()

/** DOS 时间（本地分量 2s 粒度）；zip 元数据对时区不敏感，直接用调用方给定时间 */
function dosDateTime(ts: number): { time: number; date: number } {
  // +8h 取 UTC 分量 = 北京时间（与全站口径一致）
  const d = new Date(ts + 8 * 3600_000)
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2)
  const date = Math.max(0, d.getUTCFullYear() - 1980) << 9 | (d.getUTCMonth() + 1) << 5 | d.getUTCDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

interface ZipEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  time: number
  date: number
  offset: number
}

export class ZipWriter {
  private offset = 0
  private entries: ZipEntry[] = []

  constructor(private writer: WritableStreamDefaultWriter<Uint8Array>) {}

  /** 加入一个文件。data 传 Uint8Array 或 ReadableStream（如 R2 get() 的 obj.body），流式时不缓冲 */
  async add(name: string, data: Uint8Array | ReadableStream<Uint8Array>, mtime = Date.now()): Promise<void> {
    if (this.entries.length >= 65535) throw new Error('zip 文件数超出 65535 上限')
    const nameBytes = ENC.encode(name)
    const { time, date } = dosDateTime(mtime)
    const header = new Uint8Array(30 + nameBytes.length)
    const v = new DataView(header.buffer)
    v.setUint32(0, 0x04034b50, true) // local file header sig
    v.setUint16(4, 20, true) // version needed
    v.setUint16(6, 0x0808, true) // flag: bit3 数据描述符 + bit11 UTF-8 文件名
    v.setUint16(8, 0, true) // method: store
    v.setUint16(10, time, true)
    v.setUint16(12, date, true)
    // crc / sizes 为 0，真实值在数据后的 descriptor 与中央目录里
    v.setUint16(26, nameBytes.length, true)
    v.setUint16(28, 0, true)
    header.set(nameBytes, 30)
    await this.writer.write(header)
    this.offset += header.length

    let crc = 0
    let size = 0
    if (data instanceof Uint8Array) {
      crc = crc32(data)
      size = data.length
      await this.writer.write(data)
    } else {
      const reader = data.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) {
          crc = crc32(value, crc)
          size += value.length
          await this.writer.write(value)
        }
      }
    }
    const desc = new Uint8Array(16)
    const dv = new DataView(desc.buffer)
    dv.setUint32(0, 0x08074b50, true) // data descriptor sig
    dv.setUint32(4, crc, true)
    dv.setUint32(8, size, true)
    dv.setUint32(12, size, true)
    await this.writer.write(desc)
    this.offset += size + desc.length
    this.entries.push({ nameBytes, crc, size, time, date, offset: this.offset - size - desc.length - header.length })
  }

  /** 收尾：写中央目录 + EOCD，然后关闭底层 writer */
  async close(): Promise<void> {
    const cdOffset = this.offset
    let cdSize = 0
    for (const e of this.entries) {
      const h = new Uint8Array(46 + e.nameBytes.length)
      const v = new DataView(h.buffer)
      v.setUint32(0, 0x02014b50, true) // central directory sig
      v.setUint16(4, 20, true) // version made by
      v.setUint16(6, 20, true) // version needed
      v.setUint16(8, 0x0808, true) // flags（与本地头一致）
      v.setUint16(10, 0, true) // method: store
      v.setUint16(12, e.time, true)
      v.setUint16(14, e.date, true)
      v.setUint32(16, e.crc, true)
      v.setUint32(20, e.size, true)
      v.setUint32(24, e.size, true)
      v.setUint16(28, e.nameBytes.length, true)
      v.setUint32(42, e.offset, true)
      h.set(e.nameBytes, 46)
      await this.writer.write(h)
      cdSize += h.length
    }
    const eocd = new Uint8Array(22)
    const v = new DataView(eocd.buffer)
    v.setUint32(0, 0x06054b50, true) // EOCD sig
    v.setUint16(8, this.entries.length, true)
    v.setUint16(10, this.entries.length, true)
    v.setUint32(12, cdSize, true)
    v.setUint32(16, cdOffset, true)
    await this.writer.write(eocd)
    await this.writer.close()
  }

  /** 异常收尾：中断底层流，让下载端立刻失败而不是挂到超时 */
  async abort(): Promise<void> {
    try {
      await this.writer.abort()
    } catch {
      /* 已关闭/已中断则忽略 */
    }
  }
}

/* ---------------- ZIP 读取器（整站包还原用，B26） ----------------
 * 与写入器配对：写入器用「数据描述符」模式（本地头里的尺寸/CRC 全是 0），所以读取一律
 * **以中央目录为准**——读末尾找 EOCD → 解析中央目录 → 逐条目按 Range 读数据。
 *
 * 为什么这样写（整站包可能几百 MB，Worker 只有 128MB 内存）：
 * - 全程通过 ZipSource.read(start, end) 做**区间读**（R2 的 range get / 磁盘的 createReadStream），
 *   任意时刻只持有一个条目的一段或一个批次，**整包永不进内存**；
 * - store（method 0）直出字节；deflate（method 8，用户用普通压缩工具重打包过）走
 *   DecompressionStream('deflate-raw')（Workers 与 Node ≥18 都提供）；
 * - 不支持 zip64（>4GB / >65535 条目）——与写入器同一取舍，调用方在打包/还原前自行控边界。
 */

const DEC = new TextDecoder()

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** 小端读取（手工拼，避开 DataView 对偏移对齐的讲究） */
function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8)
}
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
}

/** 随机访问数据源：整站包在 R2 里（range get）或在磁盘上（区间读文件） */
export interface ZipSource {
  /** 包总字节数 */
  size: number
  /** 读 [start, end) 区间（end 不含） */
  read(start: number, end: number): Promise<Uint8Array>
}

export interface ZipEntryMeta {
  name: string
  /** 0 = store（本系统写入器），8 = deflate（用户重打包过） */
  method: number
  /** 本地文件头偏移（数据起点 = 本地头 + 30 + 文件名长 + 扩展区长） */
  offset: number
  compSize: number
  size: number
}

/** 读中央目录：拿到全部条目的名字 / 压缩方式 / 偏移 / 尺寸 */
export async function readZipIndex(src: ZipSource): Promise<ZipEntryMeta[]> {
  if (src.size < 22) throw new Error('不是有效的 zip 包（体积过小）')
  // EOCD 在文件末尾，注释区最长 65535，所以回扫窗口 22 + 65535
  const tailLen = Math.min(src.size, 22 + 65535)
  const tail = await src.read(src.size - tailLen, src.size)
  let p = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG) {
      p = i
      break
    }
  }
  if (p < 0) throw new Error('不是有效的 zip 包（找不到中央目录结尾）')
  const count = u16(tail, p + 10)
  const cdSize = u32(tail, p + 12)
  const cdOffset = u32(tail, p + 16)
  if (cdSize === 0xffffffff || cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('不支持 zip64 整站包（请用本系统导出的包）')
  }
  if (cdOffset + cdSize > src.size) throw new Error('zip 中央目录越界（包已损坏）')
  const cd = await src.read(cdOffset, cdOffset + cdSize)
  const entries: ZipEntryMeta[] = []
  let q = 0
  while (q + 46 <= cd.length) {
    if (u32(cd, q) !== CEN_SIG) break
    const method = u16(cd, q + 10)
    const compSize = u32(cd, q + 20)
    const size = u32(cd, q + 24)
    const nameLen = u16(cd, q + 28)
    const extraLen = u16(cd, q + 30)
    const commentLen = u16(cd, q + 32)
    const offset = u32(cd, q + 42)
    if (q + 46 + nameLen > cd.length) throw new Error('zip 中央目录损坏')
    const name = DEC.decode(cd.subarray(q + 46, q + 46 + nameLen))
    entries.push({ name, method, offset, compSize, size })
    q += 46 + nameLen + extraLen + commentLen
  }
  if (!entries.length) throw new Error('zip 包里没有任何文件')
  return entries
}

/** 按名字取条目（不存在返回 null） */
export function zipFind(entries: ZipEntryMeta[], name: string): ZipEntryMeta | null {
  return entries.find((e) => e.name === name) ?? null
}

const READ_CHUNK = 1 << 20

/** 条目「未解压」的原始字节流（区间读，内存有界） */
async function zipRawStream(src: ZipSource, e: ZipEntryMeta): Promise<ReadableStream<Uint8Array>> {
  const head = await src.read(e.offset, e.offset + 30)
  if (head.length < 30 || u32(head, 0) !== LOC_SIG) throw new Error(`zip 条目「${e.name}」本地头损坏`)
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28)
  const end = start + e.compSize
  if (end > src.size) throw new Error(`zip 条目「${e.name}」数据越界（包已损坏）`)
  let pos = start
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos >= end) {
        controller.close()
        return
      }
      const to = Math.min(pos + READ_CHUNK, end)
      const bytes = await src.read(pos, to)
      pos = to
      if (bytes.length) controller.enqueue(bytes)
    },
  })
}

/** 条目内容流（按 method 自动解压：store 直出，deflate 走 DecompressionStream） */
export async function zipEntryStream(src: ZipSource, e: ZipEntryMeta): Promise<ReadableStream<Uint8Array>> {
  const raw = await zipRawStream(src, e)
  if (e.method === 0) return raw
  if (e.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'))
  throw new Error(`zip 条目「${e.name}」使用了不支持的压缩方式（${e.method}）`)
}

/** 条目内容整块读入内存（只用于小文件：manifest 与表分片；图片走 zipEntryStream 直传 R2） */
export async function readZipEntry(src: ZipSource, e: ZipEntryMeta): Promise<Uint8Array> {
  const reader = (await zipEntryStream(src, e)).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
