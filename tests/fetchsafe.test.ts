import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchableUrl, isPrivateHost } from '../src/fetchsafe.ts'

// ── 出网 SSRF 防线（src/fetchsafe.ts）：私网判定与统一入口 ──
// fetchableUrl 的基础口径回归在 tests/linkmeta.test.ts（历史导入路径），这里补
// 「黑名单表示法绕过」增强面：IPv6 字面量、整数/十六进制/八进制 IPv4 写法。

test('isPrivateHost：点分 IPv4 私网段', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.1.2.3', '100.64.0.1', '239.1.2.3']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '1.2.3.4']) {
    assert.equal(isPrivateHost(h), false, h)
  }
})

test('isPrivateHost：整数 / 十六进制 / 八进制 IPv4 表示（URL 解析器认，黑名单必须同样认）', () => {
  // 2130706433 = 127.0.0.1；0x7f000001 = 127.0.0.1；0177.0.0.1 = 127.0.0.1；127.1 = 127.0.0.1
  for (const h of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1', '0x7f.1', '2852039166']) {
    assert.equal(isPrivateHost(h), true, h)
  }
})

test('isPrivateHost：IPv6 字面量（含 IPv4-mapped / NAT64 / ULA / link-local）', () => {
  for (const h of ['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'fc00::1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  assert.equal(isPrivateHost('2606:4700::1'), false)
})

test('isPrivateHost：主机名与可疑形态', () => {
  for (const h of ['localhost', 'a.localhost', 'x.local', 'y.internal', '']) {
    assert.equal(isPrivateHost(h), true, h)
  }
  // 真域名不能被数字形态判定误杀（cafe 全是 hex 字母）
  assert.equal(isPrivateHost('cafe.example.com'), false)
  assert.equal(isPrivateHost('example.com'), false)
})

test('fetchableUrl：私网与可疑表示一律拒绝，公网放行', () => {
  assert.equal(fetchableUrl('http://2130706433/'), null)
  assert.equal(fetchableUrl('http://[::1]/x'), null)
  assert.equal(fetchableUrl('http://[::ffff:169.254.169.254]/x'), null)
  assert.equal(fetchableUrl('http://0x7f.0.0.1/x'), null)
  assert.equal(fetchableUrl('http://metadata.google.internal/x'), null)
  assert.equal(fetchableUrl('http://example.com:9000/x'), null)
  assert.ok(fetchableUrl('http://example.com:8443/x'))
  assert.ok(fetchableUrl('https://bloghao.com/post/x'))
})
