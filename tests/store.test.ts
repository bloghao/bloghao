import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageExtOf, MAX_REMOTE_IMAGES, MAX_UPLOAD_BYTES, sniffImageExt, sniffUploadExt } from '../src/store.ts'

// ── 上传常量与白名单（AGENTS「上传常量与落库统一走 src/store.ts」）：
// imageExtOf 必须走 hasOwnProperty——IMAGE_MIMES['constructor'] 是继承属性，直查表可穿透 ──

const buf = (bytes: number[]) => Uint8Array.from(bytes).buffer

test('imageExtOf：白名单查表含 image/jpg 别名，原型链属性穿透不出去', () => {
  assert.equal(imageExtOf('image/jpeg'), 'jpg')
  assert.equal(imageExtOf('image/jpg'), 'jpg')
  assert.equal(imageExtOf('image/png'), 'png')
  assert.equal(imageExtOf('image/webp'), 'webp')
  assert.equal(imageExtOf('image/gif'), 'gif')
  assert.equal(imageExtOf('image/x-icon'), 'ico')
  assert.equal(imageExtOf('image/vnd.microsoft.icon'), 'ico')
  // 原型链上的 Function 属性名：直查表会 truthy 穿透，hasOwnProperty 必须挡住
  assert.equal(imageExtOf('constructor'), undefined)
  assert.equal(imageExtOf('toString'), undefined)
  assert.equal(imageExtOf('hasOwnProperty'), undefined)
  assert.equal(imageExtOf('image/svg+xml'), undefined) // SVG 永不入白名单（存储 XSS）
  assert.equal(imageExtOf(''), undefined)
})

test('sniffUploadExt：手动上传魔数识别覆盖 ico / mp4 / webm（sniffImageExt 不认的三类）', () => {
  assert.equal(sniffUploadExt(buf([0, 0, 1, 0, 1, 0, 16, 16])), 'ico')
  assert.equal(sniffUploadExt(buf([0, 0, 2, 0, 1, 0, 32, 32])), 'ico') // CUR 同魔数族
  // MP4：偏移 4-7 = 'ftyp'
  assert.equal(sniffUploadExt(buf([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])), 'mp4')
  assert.equal(sniffUploadExt(buf([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])), 'webm')
  // 四类图片魔数复用 sniffImageExt 口径
  assert.equal(sniffUploadExt(buf([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  assert.equal(sniffUploadExt(buf([0x89, 0x50, 0x4e, 0x47])), 'png')
})

test('sniffUploadExt：HTML/SVG/文本与空缓冲一律拒收', () => {
  const str = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
  assert.equal(sniffUploadExt(str('<html><script>alert(1)</script></html>')), null)
  assert.equal(sniffUploadExt(str('<?xml version="1.0"?><svg onload="alert(1)">')), null)
  assert.equal(sniffUploadExt(new ArrayBuffer(0)), null)
})

test('转存上限常量：单篇图数与单文件字节在位（防 Workers 子请求 / 内存超限）', () => {
  assert.equal(MAX_REMOTE_IMAGES, 30)
  assert.ok(MAX_UPLOAD_BYTES > 0 && MAX_UPLOAD_BYTES <= 25 * 1024 * 1024)
})
