#!/usr/bin/env node
/**
 * 从根目录 CHANGELOG.md 生成机器可读版本清单 website/public/version.json。
 *
 * 用途：官网 bloghao.com/version.json 是「更新中心」的唯一事实源（src/update.ts 校验后比对当前
 * 版本，给分站 / 自托管用户看「更新了什么 / 优化了什么」，让他们自己选择更新还是保持当前版本）。
 *
 * 何时跑：发布流程里回填 CHANGELOG 之后（见 docs/RELEASING.md「回填版本档案」）——
 *   ① 更新 CHANGELOG.md：Unreleased 整段移入新版本小节
 *   ② npm run build:release   → 重新生成 website/public/version.json
 *   ③ 与 CHANGELOG 一起提交，随官网部署生效
 *
 * 零依赖纯 Node：解析 CHANGELOG 的 Keep a Changelog 结构（## [版本] - 日期 + ### 分类 + - 条目）。
 * 只取顶层 `- ` 条目，去掉 **加粗** / `代码` / [链接](url) 等 markdown 记号，截断到适合展示的长度。
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const PKG = path.join(ROOT, 'package.json')
const OUT = path.join(ROOT, 'website', 'public', 'version.json')

const MAX_NOTE_LEN = 160
const MAX_NOTES_PER_RELEASE = 24
const MAX_RELEASES = 40

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/)

/** markdown → 纯文本：去链接记号保留文字、去加粗/行内代码/段落标记，折叠空白 */
function toPlain(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_]/g, '')
    .replace(/[（(]?\s*(?:见|详见)\s*(?:docs|src|tests|public|scripts)\/[^\s，。；)）]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(s) {
  if (s.length <= MAX_NOTE_LEN) return s
  return s.slice(0, MAX_NOTE_LEN - 1).trimEnd() + '…'
}

const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/
function parseVersion(v) {
  const m = SEMVER.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/** 解析出 [{ version, date, notes: [] }]，跳过 Unreleased（那是开发线，不是给用户「升级到」的版本） */
const releases = []
let cur = null
for (const raw of lines) {
  const head = /^##\s+\[([^\]]+)\]\s*(?:-\s*(.+))?/.exec(raw)
  if (head) {
    const tag = head[1].trim()
    const ver = parseVersion(tag)
    cur = ver ? { version: `${ver[0]}.${ver[1]}.${ver[2]}`, sem: ver, date: (head[2] || '').trim().slice(0, 20), notes: [] } : null
    if (cur) releases.push(cur)
    continue
  }
  if (!cur) continue
  if (cur.notes.length >= MAX_NOTES_PER_RELEASE) continue
  // 只收顶层条目（- 开头），子项（缩进的 - / *）与前缀符号不当要点
  const bullet = /^-\s+(.+)/.exec(raw)
  if (!bullet) continue
  const note = clip(toPlain(bullet[1]))
  if (note) cur.notes.push(note)
}

if (!releases.length) {
  console.error('✗ CHANGELOG.md 里没解析到任何 [x.y.z] 版本小节，检查格式')
  process.exit(1)
}

releases.sort((a, b) => cmp(b.sem, a.sem))
const trimmed = releases.slice(0, MAX_RELEASES)
const latest = trimmed[0]

const manifest = {
  app: 'bloghao',
  generatedAt: new Date().toISOString(),
  latest: latest.version,
  date: latest.date,
  releases: trimmed.map((r) => ({ version: r.version, date: r.date, notes: r.notes })),
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// 与 package.json 版本一致性提示（开发线版本号可能领先于最新 CHANGELOG 小节，属正常，只提示不报错）
const pkgVer = parseVersion(pkg.version)
const drift = pkgVer && cmp(pkgVer, latest.sem) > 0
console.log(`✓ 写入 ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`)
console.log(`  最新版本 v${manifest.latest}（${manifest.date}） · ${manifest.releases.length} 个版本条目`)
if (drift) console.log(`  提示：package.json 版本 v${pkg.version} 高于最新 CHANGELOG 小节 v${manifest.latest}——若已发布请补 CHANGELOG 小节后重跑`)
