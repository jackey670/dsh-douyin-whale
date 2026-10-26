/**
 * scheduler/memory.test.mjs —— 记忆模块的自测（纯本地，不联网）
 *
 * 运行：node scheduler/memory.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mergeDmMemory, loadDmMemory, dmContext, addFacts, safeKey } from './memory.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-'))
const NICK = '示例主人'
let pass = 0
const ok = (name) => { pass++; console.log(`[PASS] ${name}`) }

try {
  // 1. 首次合并
  const r1 = mergeDmMemory(home, NICK, [
    { from: 'them', text: '你好', kind: 'text' },
    { from: 'me', text: '主人好', kind: 'text' },
  ])
  assert.equal(r1.added, 2)
  assert.equal(r1.total, 2)
  ok('首次合并写入 2 条')

  // 2. 重复读取不会重复写入（抖音只给最近 60 条，会反复读到同样的内容）
  const r2 = mergeDmMemory(home, NICK, [
    { from: 'them', text: '你好', kind: 'text' },
    { from: 'me', text: '主人好', kind: 'text' },
  ])
  assert.equal(r2.added, 0)
  assert.equal(r2.total, 2)
  ok('重复内容按 from|正文 去重')

  // 3. 新增一条
  const r3 = mergeDmMemory(home, NICK, [
    { from: 'them', text: '你好', kind: 'text' },
    { from: 'them', text: '今天吃什么', kind: 'text' },
  ])
  assert.equal(r3.added, 1)
  assert.equal(r3.total, 3)
  ok('只有新内容才计数')

  // 4. 上限 80 条
  const many = Array.from({ length: 120 }, (_, i) => ({ from: 'them', text: `消息${i}` }))
  const r4 = mergeDmMemory(home, NICK, many)
  assert.equal(r4.total, 80)
  assert.equal(r4.messages.at(-1).text, '消息119')
  ok('超过 80 条只保留最近 80 条')

  // 5. 上下文只给最近 N 条
  const ctx = dmContext(home, NICK, { recent: 5 })
  assert.equal(ctx.recent.length, 5)
  assert.equal(ctx.recent.at(-1).text, '消息119')
  assert.equal(ctx.total_remembered, 80)
  ok('dmContext 只返回最近 5 条')

  // 6. 长期事实去重
  mergeDmMemory(home, NICK, [{ from: 'them', text: '补一条' }])
  addFacts(home, NICK, ['他住在杭州', '他住在杭州', '他养了一只猫'])
  const m = loadDmMemory(home, NICK)
  assert.deepEqual(m.facts, ['他住在杭州', '他养了一只猫'])
  ok('facts 去重且保序')

  // 7. 文件名安全
  assert.equal(safeKey('a/b\\c:d*e'), 'a_b_c_d_e')
  assert.equal(safeKey(''), 'unknown')
  ok('文件名转义')

  // 8. 空正文不写
  const before = loadDmMemory(home, NICK).messages.length
  mergeDmMemory(home, NICK, [{ from: 'them', text: '   ' }, { from: 'them' }])
  assert.equal(loadDmMemory(home, NICK).messages.length, before)
  ok('空正文/缺字段不写入')

  console.log(`\nALL PASSED (${pass})`)
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}
