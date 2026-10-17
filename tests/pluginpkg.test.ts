import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanPluginId,
  installedManifest,
  pluginFileKey,
  readInstalled,
  removeInstalled,
  sanityCheckPluginSource,
  upsertInstalled,
  PLUGIN_SRC_MAX_BYTES,
} from '../src/pluginpkg.ts'

// ── cleanPluginId：白名单字符（R2 键由 id 拼接，穿越面在此拦死）──

test('cleanPluginId：字母数字_- 合法；空/超长/路径穿越/原型链字符拒绝', () => {
  assert.equal(cleanPluginId('quote-of-day'), 'quote-of-day')
  assert.equal(cleanPluginId('a_1'), 'a_1')
  assert.equal(cleanPluginId(''), null)
  assert.equal(cleanPluginId('  '), null)
  assert.equal(cleanPluginId('x'.repeat(65)), null)
  assert.equal(cleanPluginId('../etc'), null)
  assert.equal(cleanPluginId('a/b'), null)
  assert.equal(cleanPluginId('a.js'), null, '扩展名不进 id（键拼接时统一加 .js）')
  assert.equal(cleanPluginId('constructor'), 'constructor', '普通词放行——R2 键是字面量拼接，无查表面')
})

test('pluginFileKey：固定前缀 + .js 后缀', () => {
  assert.equal(pluginFileKey('hello'), 'plugins/hello.js')
})

// ── sanityCheckPluginSource：内容安检 ──

test('sanity：含 registerPlugin 的文本 JS 放行；HTML 错误页 / JSON / 二进制 / 空内容拒绝', () => {
  const js = `window.BlogHao && window.BlogHao.registerPlugin({ name: 'x', onClick(ctx) { ctx.insertHTML('<p>x</p>') } })`
  assert.equal(sanityCheckPluginSource(js), true)
  assert.equal(sanityCheckPluginSource('<!DOCTYPE html><html>Not Found</html>'), false)
  assert.equal(sanityCheckPluginSource('{"ok":true}'), false)
  assert.equal(sanityCheckPluginSource(''), false)
  assert.equal(sanityCheckPluginSource('   '), false)
  assert.equal(sanityCheckPluginSource('const x = 1;\n'.repeat(30000) + 'registerPlugin'), false, '超 256KB 拒绝')
  assert.ok(PLUGIN_SRC_MAX_BYTES === 256 * 1024)
  assert.equal(sanityCheckPluginSource('registerPlugin\u0000'), false, 'NUL 字节（二进制特征）拒绝')
})

// ── 登记表：脏 JSON 回空、upsert 覆盖同 id、remove 删除、manifest 只出 id/at ──

test('readInstalled：脏数据一律回空数组；正常条目字段收敛', () => {
  assert.deepEqual(readInstalled(''), [])
  assert.deepEqual(readInstalled('dirty{{'), [])
  assert.deepEqual(readInstalled('{}'), [])
  assert.deepEqual(readInstalled('[{"id":"../x"}]'), [], '非法 id 条目剔除')
  assert.deepEqual(readInstalled('[1, "x", null]'), [])
  const list = readInstalled('[{"id":"a","url":"https://x/a.js","at":5,"bytes":10},{"id":"b"}]')
  assert.deepEqual(list, [
    { id: 'a', url: 'https://x/a.js', at: 5, bytes: 10 },
    { id: 'b', url: '', at: 0, bytes: 0 },
  ])
})

test('upsertInstalled：新装追加、同 id 覆盖原位；removeInstalled 精确删除', () => {
  const a = { id: 'a', url: 'u1', at: 1, bytes: 1 }
  const a2 = { id: 'a', url: 'u2', at: 2, bytes: 2 }
  const b = { id: 'b', url: 'u3', at: 3, bytes: 3 }
  assert.deepEqual(upsertInstalled([], a), [a])
  assert.deepEqual(upsertInstalled([a], b), [a, b])
  const upd = upsertInstalled([a, b], a2)
  assert.deepEqual(upd, [a2, b], '覆盖保持原位')
  assert.deepEqual(removeInstalled([a, b], 'a'), [b])
  assert.deepEqual(removeInstalled([a], 'nope'), [a])
})

test('installedManifest：只出 id 与 at（url/bytes 是管理面信息）', () => {
  assert.deepEqual(installedManifest([{ id: 'a', url: 'u', at: 9, bytes: 1 }]), [{ id: 'a', at: 9 }])
  assert.deepEqual(installedManifest([]), [])
})
