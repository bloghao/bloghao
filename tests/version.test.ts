import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/version.ts'

// ── 系统版本镜像守卫：事实源 package.json，src/version.ts 是运行时镜像（Workers 无 fs 读不了
// JSON），发版改版本号漏改镜像时这里红——后台「系统」卡展示的版本不许和事实源漂移 ──

test('APP_VERSION 与 package.json version 同步', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(APP_VERSION, pkg.version, 'src/version.ts 的 APP_VERSION 漏跟 package.json 同步了')
})

test('APP_VERSION 是合法的 semver 三段式', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/)
})

test('镜像文件的注释口径：提醒了「两处同步」的存在', () => {
  const src = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('两处同步'), 'version.ts 头注释丢了同步提醒，下个改版本的人会漏改')
})
