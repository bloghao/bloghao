import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awardPoints, awardCommentPoints, canRead, cstDayStart, normalizeMinTier, POINTS_RULES } from '../src/points.ts'
import { createMember, listApprovedComments, listGuestbookComments, listMembersAdmin, listRankTop, updateMemberAdmin, updateMemberNickname, updateMemberQQ } from '../src/db.ts'
import { cleanNickname, isValidQQ, NICKNAME_CHANGE_COOLDOWN_MS, nicknameCooldown, teaserHtml } from '../src/utils.ts'

// ── 会员体系（契约见 docs/archive/DEVPLAN-2026-10-07.md 附录 A）：积分引擎 / 会员查询 SQL 形状 ──

// ── 积分规则常量表：2026-10-07 拍板数值（评论 +2、每日登录 +1），数值只许改 points.ts 一处 ──

test('POINTS_RULES：拍板数值与关键字段', () => {
  assert.equal(POINTS_RULES.comment.delta, 2)
  assert.equal(POINTS_RULES.dailyLogin.delta, 1)
  assert.equal(POINTS_RULES.dailyLogin.dailyCap, 1, '每日登录当天只计一次')
  assert.equal(POINTS_RULES.adminAdjust.dailyCap, 0, '管理员调整不受日上限约束')
})

test('cstDayStart：北京时间当日 0 点（UTC 分量 + 去掉 +8 偏移）', () => {
  // 2026-10-07 02:00 UTC = 北京时间 10:00 → 当日 0 点 = 2026-10-06 16:00 UTC
  const ts = Date.UTC(2026, 9, 7, 2, 30, 0)
  assert.equal(cstDayStart(ts), Date.UTC(2026, 9, 7) - 8 * 3600_000)
  // 北京时间 0:30（UTC 前一天 16:30）归当日（北京 10-08）0 点
  const early = Date.UTC(2026, 9, 7, 16, 30, 0)
  assert.equal(cstDayStart(early), Date.UTC(2026, 9, 8) - 8 * 3600_000)
})

// ── awardPoints：日上限 / 幂等 / adminAdjust 旁路 / 非法 reason 拒绝 ──

function fakePointsDb(initial = 0) {
  const log: { member_id: number; delta: number; reason: string; ref_id: number }[] = []
  let balance = initial
  // 当日累计(桩内所有账本行都视为当天)
  const daySum = (memberId: number, reason: string) =>
    log.filter((l) => l.member_id === memberId && l.reason === reason).reduce((x, l) => x + l.delta, 0)
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      // 占位符数 = 绑定数严格校验（AGENTS 教训：占位符错位真 bug 曾靠桩数差拦住，桩不校验就漏）
      const need = (sql.replace(/'(?:[^']|'')*'/g, '').match(/\?/g) ?? []).length
      const stmt = {
        bind: (...a: unknown[]) => {
          assert.equal(a.length, need, `SQL 占位符数不匹配：${sql}`)
          args = a
          return stmt
        },
        run: async () => {
          if (sql.includes('INSERT INTO member_points_log')) {
            log.push({
              member_id: args[0] as number,
              delta: args[1] as number,
              reason: args[2] as string,
              ref_id: args[3] as number,
            })
          } else if (sql.includes('UPDATE members SET points')) {
            // 三语句条件批的②:SUM 子查询守卫,超当日上限 changes=0 不入账(与 points.ts 同谓词)
            if (sql.includes('created_at >= ?) <= ?') && daySum(args[3] as number, args[4] as string) > (args[6] as number)) {
              return { success: true, meta: { changes: 0 } }
            }
            balance += args[0] as number
          } else if (sql.includes('DELETE FROM member_points_log')) {
            // 三语句条件批的③:SUM 超上限时按 ref_id 摘除本行(与②谓词互斥)
            if (daySum(args[3] as number, args[4] as string) > (args[6] as number)) {
              const idx = log.findIndex((l) => l.member_id === args[0] && l.reason === args[1] && l.ref_id === args[2])
              if (idx >= 0) log.splice(idx, 1)
            }
          }
          return { success: true, meta: { changes: 1 } }
        },
        first: async <T>(): Promise<T | null> => {
          if (sql.includes('SUM(delta)')) {
            const s = log
              .filter((l) => l.member_id === args[0] && l.reason === args[1])
              .reduce((x, l) => x + l.delta, 0)
            return { s } as T
          }
          if (sql.includes('SELECT 1 AS x FROM member_points_log')) {
            const hit = log.some((l) => l.reason === 'comment' && l.member_id === args[0] && l.ref_id === args[1])
            return (hit ? { x: 1 } : null) as T
          }
          if (sql.includes('SELECT points FROM members')) return { points: balance } as T
          return null
        },
        all: async () => ({ results: [] }),
      }
      return stmt
    },
    batch: async (stmts: { run(): Promise<unknown> }[]) => {
      const out: unknown[] = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  }
  return { db: db as unknown as D1Database, log, balance: () => balance }
}

test('awardPoints：评论 +2 落账本并加余额，refId 入账', async () => {
  const { db, log, balance } = fakePointsDb()
  const r = await awardPoints(db, 7, 'comment', { refId: 42 })
  assert.ok(r.ok)
  assert.equal(r.delta, 2)
  assert.equal(r.balance, 2)
  assert.equal(balance(), 2)
  assert.deepEqual(log, [{ member_id: 7, delta: 2, reason: 'comment', ref_id: 42 }])
})

test('awardPoints：每日登录当天只计一次（cap=1 幂等）', async () => {
  const { db, log, balance } = fakePointsDb()
  const first = await awardPoints(db, 1, 'dailyLogin')
  assert.ok(first.ok)
  const second = await awardPoints(db, 1, 'dailyLogin')
  assert.equal(second.ok, false)
  assert.equal(second.delta, 0)
  assert.equal(log.length, 1)
  assert.equal(balance(), 1)
})

test('awardPoints：评论单日上限 10 条（第 11 条起拦下），账本不落', async () => {
  const { db, log } = fakePointsDb()
  for (let i = 1; i <= 10; i++) {
    const r = await awardPoints(db, 3, 'comment', { refId: i })
    assert.ok(r.ok, `第 ${i} 条应计分`)
  }
  const overflow = await awardPoints(db, 3, 'comment', { refId: 11 })
  assert.equal(overflow.ok, false)
  assert.equal(log.length, 10)
})

test('awardPoints：日上限批内守卫——SUM 预查后并发抢占的额度被条件批摘除', async () => {
  const { db, log, balance } = fakePointsDb()
  for (let i = 1; i <= 9; i++) await awardPoints(db, 8, 'comment', { refId: i })
  assert.equal(balance(), 18)
  // 模拟并发竞态:让 SUM 预查读到旧快照(18,判定可过),随后另一路抢先把当日额度顶满
  const realPrepare = db.prepare.bind(db)
  let hijacked = false
  ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = realPrepare(sql)
    if (!hijacked && sql.includes('AS s FROM member_points_log')) {
      hijacked = true
      return {
        bind: (...a: unknown[]) => {
          ;(stmt as { bind: (...b: unknown[]) => unknown }).bind(...a)
          return {
            first: async () => {
              log.push({ member_id: 8, delta: 2, reason: 'comment', ref_id: 999 })
              return { s: 18 }
            },
          }
        },
      }
    }
    return stmt
  }
  const r = await awardPoints(db, 8, 'comment', { refId: 100 })
  assert.equal(r.ok, false, '批内 SUM 已超上限,条件 UPDATE 不入账')
  assert.equal(r.delta, 0)
  assert.equal(balance(), 18, '余额不动')
  assert.ok(!log.some((l) => l.ref_id === 100), '超额账本行被条件 DELETE 摘除')
  assert.equal(log.length, 10, '账本回到 10 行(9 条 + 并发抢占 1 条)')
})

test('awardPoints：adminAdjust 用给定 delta（可负）且不受日上限约束', async () => {
  const { db, log, balance } = fakePointsDb(100)
  const r = await awardPoints(db, 5, 'adminAdjust', { delta: -30, note: '作弊扣回' })
  assert.ok(r.ok)
  assert.equal(r.delta, -30)
  assert.equal(balance(), 70)
  const bump = await awardPoints(db, 5, 'adminAdjust', { delta: 500 })
  assert.ok(bump.ok, '管理员调整不受日上限')
  assert.equal(log.length, 2)
})

test('awardPoints：非法 reason（含原型链属性）拒绝且不落账', async () => {
  const { db, log } = fakePointsDb()
  for (const reason of ['toString', 'constructor', 'hasOwnProperty', 'commentX', '']) {
    const r = await awardPoints(db, 1, reason)
    assert.equal(r.ok, false, reason)
  }
  assert.equal(log.length, 0)
})

test('awardCommentPoints：同一评论 ref_id 去重，反复通过不重复记', async () => {
  const { db, log } = fakePointsDb()
  await awardCommentPoints(db, 9, 1001)
  await awardCommentPoints(db, 9, 1001) // 后台「通过↔待审」再通过
  await awardCommentPoints(db, 9, 1002)
  assert.equal(log.length, 2)
  assert.deepEqual(
    log.map((l) => l.ref_id).sort(),
    [1001, 1002]
  )
})

// ── db.ts 会员查询：SQL 形状守卫（防泄漏/防注入面回退） ──

function fakeCaptureDb(firstResult: Record<string, unknown> = { n: 0 }) {
  const sqls: string[] = []
  const allBinds: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqls.push(sql)
      let args: unknown[] = []
      // 占位符数 = 绑定数严格校验（防 createMember 类占位符错位 bug 复发）
      const need = (sql.replace(/'(?:[^']|'')*'/g, '').match(/\?/g) ?? []).length
      const stmt = {
        bind: (...a: unknown[]) => {
          assert.equal(a.length, need, `SQL 占位符数不匹配：${sql}`)
          args = a
          allBinds.push(a)
          return stmt
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async <T>(): Promise<T | null> => firstResult as T,
        all: async <T>(): Promise<{ results: T[] }> => ({ results: [] as T[] }),
      }
      return stmt
    },
    batch: async () => [],
  }
  return { db: db as unknown as D1Database, sqls, allBinds }
}

test('listRankTop：只含 active 且积分 > 0，积分倒序', async () => {
  const { db, sqls } = fakeCaptureDb()
  await listRankTop(db, 10)
  assert.match(sqls[0], /status = 'active'/, '排行榜不得泄漏封禁会员')
  assert.match(sqls[0], /points > 0/)
  assert.match(sqls[0], /ORDER BY points DESC, id ASC/)
  assert.match(sqls[0], /LIMIT \?/)
})

test('listMembersAdmin：搜索走 LIKE + ESCAPE 转义，分页 clamp 在合法页码', async () => {
  const { db, sqls, allBinds } = fakeCaptureDb({ n: 55 })
  await listMembersAdmin(db, 'a_b%c', 99)
  assert.match(sqls[0], /username LIKE \? ESCAPE '\\' OR email LIKE \? ESCAPE '\\'/, '搜索必须 ESCAPE（likePattern 同口径）')
  assert.equal(allBinds[0][0], '%a\\_b\\%c%')
  // 55 条 → 3 页，page=99 clamp 到 3：OFFSET = 40
  assert.match(sqls[1], /LIMIT 20 OFFSET \?/)
  assert.equal(allBinds[1][allBinds[1].length - 1], 40)
  const empty = fakeCaptureDb({ n: 0 })
  await listMembersAdmin(empty.db, '', 0)
  assert.ok(!empty.sqls[0].includes('LIKE'), '无关键词时不带 LIKE 条件')
})

test('updateMemberAdmin：缺键即保留（只更新传入列），命中行看 changes', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ status: 'banned' }, /SET status = \?, updated_at = \? WHERE id = \?/],
    [{ tier: 'coffee', status: 'active' }, /SET tier = \?, status = \?, updated_at = \? WHERE id = \?/],
  ]
  for (const [patch, re] of cases) {
    const { db, sqls } = fakeCaptureDb()
    const ok = await updateMemberAdmin(db, 1, patch)
    assert.ok(ok)
    assert.match(sqls[0], re)
  }
  const empty = fakeCaptureDb()
  assert.ok(await updateMemberAdmin(empty.db, 1, {}), '空 patch 视为无操作成功')
  assert.equal(empty.sqls.length, 0, '空 patch 不得发 UPDATE')
})

// ── 会员个人资料（/member 页会员卡）：昵称清洗 / 30 天修改窗口 / 条件更新 ──

test('cleanNickname：trim、剥控制字符、限长，空值返回空串', () => {
  assert.equal(cleanNickname('  小王  '), '小王')
  assert.equal(cleanNickname('Bob'), 'Bob')
  assert.equal(cleanNickname('中英 mix_01'), '中英 mix_01')
  // 控制字符（含换行/制表）剥除：渲染层防怪异换行，也不会把昵称当换行注入
  assert.equal(cleanNickname('a\n\tb\r'), 'ab')
  assert.equal(cleanNickname('a\u0000b\u007f'), 'ab')
  // 超长截断到 24（与展示层 (display_name || username).slice(0, 24) 同口径）
  assert.equal(cleanNickname('x'.repeat(30)).length, 24)
  assert.equal(cleanNickname(''.padStart(5)), '')
  assert.equal(cleanNickname(undefined), '')
  assert.equal(cleanNickname(null), '')
})

test('nicknameCooldown：NULL 首改不受限，30 天内挡下，30 天外解禁（边界含等于）', () => {
  const now = Date.now()
  assert.deepEqual(nicknameCooldown(null, now), { allowed: true, nextAt: 0 }, '从未改过，首次修改不受限')
  assert.deepEqual(nicknameCooldown(undefined, now), { allowed: true, nextAt: 0 })
  // 改完 29 天：冷却中，nextAt = 改的时间 + 30 天
  const changedAt = now - NICKNAME_CHANGE_COOLDOWN_MS + 86_400_000
  assert.deepEqual(nicknameCooldown(changedAt, now), { allowed: false, nextAt: changedAt + NICKNAME_CHANGE_COOLDOWN_MS })
  // 恰好 30 天：解禁（<= 判定，与 SQL 条件 display_name_changed_at <= now - cooldown 同口径）
  const edge = now - NICKNAME_CHANGE_COOLDOWN_MS
  assert.equal(nicknameCooldown(edge, now).allowed, true)
  assert.equal(nicknameCooldown(edge - 1000, now).allowed, true)
})

test('updateMemberNickname：窗口判定下沉 SQL 条件更新（防并发双开），changes=0 报 false', async () => {
  const { db, sqls, allBinds } = fakeCaptureDb()
  const ok = await updateMemberNickname(db, 7, '小王', 1_000)
  assert.ok(ok)
  assert.match(
    sqls[0],
    /SET display_name = \?, display_name_changed_at = \?, updated_at = \? WHERE id = \? AND \(display_name_changed_at IS NULL OR display_name_changed_at <= \?\)/,
    '窗口判定必须是原子条件更新：并发双开同时过应用层检查时只有一动能落库'
  )
  assert.deepEqual(allBinds[0], ['小王', 1_000, 1_000, 7, 1_000 - NICKNAME_CHANGE_COOLDOWN_MS])
  // 冷却窗口内：SQL 条件不命中（changes=0）→ false，调用方提示解禁日期
  const blockedDb = {
    prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }),
  } as unknown as D1Database
  assert.equal(await updateMemberNickname(blockedDb, 7, '小王', 1_000), false)
})

test('createMember：注册昵称进 INSERT（选填，空串占位），列序与值序对齐', async () => {
  const sqls: string[] = []
  const allBinds: unknown[][] = []
  const db = {
    prepare: (sql: string) => {
      sqls.push(sql)
      const stmt = {
        bind: (...a: unknown[]) => {
          allBinds.push(a)
          return stmt
        },
        run: async () => ({ meta: { last_row_id: 42 } }),
      }
      return stmt
    },
  } as unknown as D1Database
  const id = await createMember(db, { username: 'bob', hash: 'h', salt: 's', email: '', displayName: '小明' })
  assert.equal(id, 42)
  assert.match(sqls[0], /INSERT INTO members/)
  assert.match(sqls[0], /display_name/)
  assert.equal(allBinds[0].length, 7, 'username/hash/salt/email/display_name/created_at/updated_at')
  assert.equal(allBinds[0][4], '小明')
})

// ── 可见档位（契约 A0/A2）与付费墙试读段 ──

test('canRead：档位判定矩阵（游客/normal/coffee/top × all/member/coffee/top）', () => {
  // 游客只看得懂 all
  for (const tier of ['all', 'member', 'coffee', 'top']) {
    assert.equal(canRead(tier, null), tier === 'all', `游客看 ${tier}`)
  }
  // normal 登录即可看 all 与 member 档，够不着 coffee/top
  assert.deepEqual(
    ['all', 'member', 'coffee', 'top'].map((t) => canRead(t, 'normal')),
    [true, true, false, false]
  )
  assert.equal(canRead('coffee', 'coffee'), true)
  assert.equal(canRead('coffee', 'top'), true)
  assert.equal(canRead('top', 'coffee'), false)
  assert.equal(canRead('top', 'top'), true)
})

test('normalizeMinTier：脏值一律归 all（不锁死站长自有内容）', () => {
  for (const dirty of [null, undefined, '', 'ALL', 'vip', 'constructor']) {
    assert.equal(normalizeMinTier(dirty), 'all', String(dirty))
  }
  assert.equal(normalizeMinTier('member'), 'member')
})

test('teaserHtml：按可见文本截断、闭合未关标签、标签本身不计数', () => {
  const html = '<p>' + '一'.repeat(150) + '</p><p>' + '二'.repeat(150) + '</p><p>结尾绝密内容</p>'
  const t = teaserHtml(html, 200)
  assert.ok(!t.includes('绝密'), '正文必须截在试读段内')
  assert.ok(t.endsWith('</p>'), '截断后要闭合未关标签')
  assert.ok(t.startsWith('<p>'), '标签原样保留')
  // 标签不占可见文本额度：200 字预算全部给正文
  const noTags = 'x'.repeat(300)
  assert.equal(teaserHtml(noTags, 200).length, 200)
  // 短于预算原样返回
  assert.equal(teaserHtml('<p>短文</p>', 200), '<p>短文</p>')
  // void 标签不进栈，不会产出多余的闭合
  assert.equal(teaserHtml('<p>a<br>b<img src="/images/x.jpg">c</p>', 200), '<p>a<br>b<img src="/images/x.jpg">c</p>')
})

// ── 评论头像（C2）：QQ 绑定链路，机制见 src/exif.ts 同批的 saveUpload / render.ts commentAvatarHtml ──

test('isValidQQ：5-11 位数字、不以 0 开头；其余一律拒绝', () => {
  assert.ok(isValidQQ('12345'))
  assert.ok(isValidQQ('10000'))
  assert.ok(isValidQQ('12345678901'), '11 位是上限')
  assert.equal(isValidQQ('01234'), false, '0 开头拒绝')
  assert.equal(isValidQQ('1234'), false, '不足 5 位')
  assert.equal(isValidQQ('123456789012'), false, '超 11 位')
  assert.equal(isValidQQ(''), false)
  assert.equal(isValidQQ('abc'), false)
  assert.equal(isValidQQ(null), false)
})

test('updateMemberQQ：qq 与头像回写；avatar=null 只存 qq（qlogo 抓取失败容忍，重试补抓）', async () => {
  const { db, sqls, allBinds } = fakeCaptureDb()
  await updateMemberQQ(db, 7, '12345', '/images/u/202610/abc.png', 1_000)
  assert.match(
    sqls[0],
    /UPDATE members SET qq = \?, updated_at = \?, avatar = COALESCE\(\?, avatar\) WHERE id = \?/,
    'COALESCE 保证抓取失败时不清掉已有头像'
  )
  assert.deepEqual(allBinds[0], ['12345', 1_000, '/images/u/202610/abc.png', 7])
  await updateMemberQQ(db, 7, '12345', null, 2_000)
  assert.deepEqual(allBinds[1], ['12345', 2_000, null, 7])
})

test('评论列表 SQL 带出 m.avatar AS member_avatar，且 qq 号本体永不进评论出参', async () => {
  const { db, sqls } = fakeCaptureDb()
  await listApprovedComments(db, 1)
  await listGuestbookComments(db)
  assert.match(sqls[0], /m\.avatar AS member_avatar/)
  assert.match(sqls[1], /m\.avatar AS member_avatar/)
  assert.doesNotMatch(sqls[0], /m\.qq/, '隐私红线：qq 只进本人视角')
  assert.doesNotMatch(sqls[1], /m\.qq/)
})
