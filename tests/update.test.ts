import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  cleanManifestText,
  compareSemver,
  parseSemver,
  updateStatus,
  validateUpdateManifest,
  UPDATE_MANIFEST_URL,
  type UpdateManifest,
} from '../src/update.ts'

// ── 更新中心纯函数守卫（src/update.ts）：版本比对 / 清单校验 / 更新状态。
// 事实源是官网发布的机器可读清单（website/public/version.json），清单按不可信输入处理 ──

/* ---------------- 版本号解析与比对 ---------------- */

test('parseSemver：只认三段纯数字，可带前导 v', () => {
  assert.deepEqual(parseSemver('2.6.0'), [2, 6, 0])
  assert.deepEqual(parseSemver('v2.6.0'), [2, 6, 0])
  assert.deepEqual(parseSemver(' 2.6.1 '), [2, 6, 1])
  assert.equal(parseSemver('2.6'), null)
  assert.equal(parseSemver('2.6.0-dev'), null)
  assert.equal(parseSemver('v2.6.0.1'), null)
  assert.equal(parseSemver(''), null)
  assert.equal(parseSemver(260), null)
  assert.equal(parseSemver(null), null)
})

test('compareSemver：逐段比较，非法输入返回 null', () => {
  assert.equal(compareSemver('2.6.0', '2.6.0'), 0)
  assert.equal(compareSemver('2.6.0', '2.5.1'), 1)
  assert.equal(compareSemver('2.5.1', '2.6.0'), -1)
  assert.equal(compareSemver('2.10.0', '2.9.9'), 1)
  assert.equal(compareSemver('3.0.0', '2.99.99'), 1)
  assert.equal(compareSemver('2.6.0', 'nope'), null)
})

/* ---------------- 文本净化 ---------------- */

test('cleanManifestText：剥控制字符、折叠空白、限长', () => {
  assert.equal(cleanManifestText(' a\u0000b\tc\n d ', 40), 'a b c d')
  assert.equal(cleanManifestText('x'.repeat(50), 10), 'x'.repeat(10))
  assert.equal(cleanManifestText(123, 10), '')
})

/* ---------------- 清单校验（不可信输入） ---------------- */

test('validateUpdateManifest：正常清单规范化，latest 与 releases 保留', () => {
  const m = validateUpdateManifest({
    app: 'bloghao',
    generatedAt: '2026-10-17T00:00:00.000Z',
    latest: '2.6.0',
    date: '2026-10-17',
    releases: [
      { version: '2.6.0', date: '2026-10-17', notes: ['新增 A', '修复 B'] },
      { version: '2.5.1', date: '2026-10-12', notes: ['新增 C'] },
    ],
  })
  assert.ok(m)
  assert.equal(m!.latest, '2.6.0')
  assert.equal(m!.releases.length, 2)
  assert.deepEqual(m!.releases[0].notes, ['新增 A', '修复 B'])
})

test('validateUpdateManifest：结构不符一律 null', () => {
  assert.equal(validateUpdateManifest(null), null)
  assert.equal(validateUpdateManifest('x'), null)
  assert.equal(validateUpdateManifest([]), null)
  assert.equal(validateUpdateManifest({ releases: 'nope' }), null)
  assert.equal(validateUpdateManifest({ releases: [] }), null)
  // app 字段存在但不是本项目 → 拒绝（防误配到别人的 JSON）
  assert.equal(validateUpdateManifest({ app: 'other', releases: [{ version: '1.0.0' }] }), null)
})

test('validateUpdateManifest：单条脏数据只丢该条、不连坐整份清单', () => {
  const m = validateUpdateManifest({
    latest: 'garbage',
    releases: [
      { version: 'nope', notes: ['脏'] },
      { version: '2.6.0', notes: ['好', 123, '', '  '] },
      { version: '2.6.0', notes: ['重复版本丢弃'] },
      null,
      42,
    ],
  })
  assert.ok(m)
  assert.equal(m!.releases.length, 1, '非法/重复条目应被丢弃')
  // notes 里的非字符串与空串被过滤
  assert.deepEqual(m!.releases[0].notes, ['好'])
  // latest 非法时回退到 releases 里最高版本
  assert.equal(m!.latest, '2.6.0')
})

test('validateUpdateManifest：latest 未在 releases 也接受（以声明为准，形状合法即可）', () => {
  const m = validateUpdateManifest({ latest: '2.7.0', releases: [{ version: '2.6.0', notes: [] }] })
  assert.ok(m)
  assert.equal(m!.latest, '2.7.0')
})

/* ---------------- 更新状态计算 ---------------- */

const MANIFEST: UpdateManifest = {
  app: 'bloghao',
  generatedAt: '',
  latest: '2.7.0',
  date: '2026-10-20',
  releases: [
    { version: '2.6.0', date: '2026-10-17', notes: ['旧'] },
    { version: '2.5.1', date: '2026-10-12', notes: ['更旧'] },
    { version: '2.7.0', date: '2026-10-20', notes: ['新'] },
  ],
}

test('updateStatus：新版本可用，releases 只留比当前新的、且新→旧排序', () => {
  const st = updateStatus('2.5.1', MANIFEST)
  assert.equal(st.hasUpdate, true)
  assert.equal(st.latest, '2.7.0')
  assert.deepEqual(st.releases.map((r) => r.version), ['2.7.0', '2.6.0'])
  assert.equal(st.kept, false)
})

test('updateStatus：已是最新 → 无更新、无条目', () => {
  const st = updateStatus('2.7.0', MANIFEST)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.releases.length, 0)
})

test('updateStatus：选择「保持当前版本」= 忽略的正是当前最新版', () => {
  const st = updateStatus('2.5.1', MANIFEST, '2.7.0')
  assert.equal(st.hasUpdate, true, '有更新仍旧 true，只是提示已选择保持')
  assert.equal(st.kept, true)
  assert.equal(st.ignored, '2.7.0')
})

test('updateStatus：出现更高新版本后，旧的「保持」记录自动失效', () => {
  const st = updateStatus('2.5.1', MANIFEST, '2.6.0')
  assert.equal(st.kept, false)
  assert.equal(st.ignored, '')
})

test('updateStatus：当前版本非法 → 当作无更新（宁可不打扰）', () => {
  const st = updateStatus('dev-build', MANIFEST)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.releases.length, 0)
})

test('updateStatus：忽略值脏形态不接受', () => {
  assert.equal(updateStatus('2.5.1', MANIFEST, '不存在的版本').kept, false)
})

/* ---------------- 契约守卫：清单端点与生成产物 ---------------- */

test('清单端点固定为官网 version.json（别改到用户可控地址）', () => {
  assert.equal(UPDATE_MANIFEST_URL, 'https://bloghao.com/version.json')
})

test('生成产物 website/public/version.json 能被同一份校验器接受且 latest 为最高版本', () => {
  const raw = JSON.parse(readFileSync(new URL('../website/public/version.json', import.meta.url), 'utf8'))
  const m = validateUpdateManifest(raw)
  assert.ok(m, 'version.json 校验不过——跑 npm run build:release 重新生成')
  const max = m!.releases.map((r) => r.version).sort((a, b) => compareSemver(b, a) ?? 0)[0]
  assert.equal(m!.latest, max, 'latest 应等于 releases 里的最高版本')
})

test('构建脚本与 npm 命令登记在场（发布流程要跑它）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(pkg.scripts['build:release'], 'node scripts/build-release.mjs')
})
