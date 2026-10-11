// 广场入口守护（2026-10-11 拍板）：hub. / plaza. 两个退役的 bloghao.com 子域名已
// 永久下线，广场唯一官方入口是 https://bloghao.com/plaza（页面 /plaza/ 与数据面
// /plaza/api/* 同域，服务器 Caddy 在 bloghao.com 块内路径反代 hub 容器）。
// 本用例全文扫描仓库源码与文档：旧子域名（含字面量）禁止再次出现——任何「恢复 /
// 补全 / 演示化」旧域名的改动（人或 AI）都在这里变红。服务器侧防线：Caddyfile
// 顶部警戒注释 + /etc/caddy 下不留任何历史备份，以线上文件为唯一权威版本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 运行时拼装禁词：本文件与 AGENTS.md 的防线描述都不落字面量，扫描才能做到「全仓绝对禁绝」
const BLOGHAO = ['blogh', 'ao.com'].join('')
const BANNED = ['hub.' + BLOGHAO, 'plaza.' + BLOGHAO]
const CANONICAL = 'bloghao.com/plaza'

const SCAN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.html', '.css', '.txt', '.svg', '.xml',
])
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.wrangler', '.github', 'dist', 'data', 'assets', '.zcode',
])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.')) yield* walk(p)
    } else if (SCAN_EXTS.has(name.slice(name.lastIndexOf('.')))) {
      yield p
    }
  }
}

test('广场旧域名（hub./plaza. bloghao.com）在仓库全文中绝迹', () => {
  const offenders = []
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8')
    for (const banned of BANNED) {
      if (text.includes(banned)) offenders.push(`${file} 含 ${banned}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `发现退役域名引用（唯一官方入口是 https://${CANONICAL}，见 tests/plaza-domain.test.ts 头注）：\n${offenders.join('\n')}`
  )
})

test('广场入口正向锚点：构造点必须仍指向 bloghao.com/plaza', () => {
  // 插件回落默认值（PLAZA_OFFICIAL_HUB）
  assert.ok(
    readFileSync(join(ROOT, 'src/hooks.ts'), 'utf8').includes(`'https://${CANONICAL}'`),
    'src/hooks.ts 的 PLAZA_OFFICIAL_HUB 必须是 https://bloghao.com/plaza'
  )
  // 设置默认值
  assert.ok(
    readFileSync(join(ROOT, 'src/db.ts'), 'utf8').includes(`plazaEndpoint: 'https://${CANONICAL}'`),
    'src/db.ts 的 plazaEndpoint 默认值必须是 https://bloghao.com/plaza'
  )
  // 官网广场页同源取数
  assert.ok(
    readFileSync(join(ROOT, 'website/public/plaza/plaza.js'), 'utf8').includes("var HUB = '/plaza'"),
    "website/public/plaza/plaza.js 必须同源取数（var HUB = '/plaza'）"
  )
  // 官网接入文档
  assert.ok(
    readFileSync(join(ROOT, 'docs/PLAZA.md'), 'utf8').includes(`https://${CANONICAL}`),
    'docs/PLAZA.md 必须指向 https://bloghao.com/plaza'
  )
})
