/**
 * scheduler/memory.mjs —— 私信上下文记忆（每人一份，只存本机）
 * ============================================================================
 * 为什么要有：
 *   每次唤醒都是一个全新会话，agent 不知道上次聊到哪、说过什么。没有记忆，
 *   回复会重复、会跑题，或者把聊天对象当陌生人。
 *
 * 三条约束：
 *   ① **只存本机**：`$DSH_HOME/memory/dm-<key>.json`，不上传任何地方。
 *      私信内容是最私密的东西之一，不能进仓库、日志或报告。
 *   ② **有上限**：每人最多 80 条、每条 200 字、20 条长期事实。
 *   ③ **不编造**：没有记录就是没有，调用方不要拿"记忆里似乎说过"来填空。
 *
 * 存储形状：
 *   { who: {nick}, updatedAt, rounds, facts: [], messages: [{at, from, text, kind}] }
 *   messages 按时间**旧 → 新**。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_MESSAGES = 80
const MAX_TEXT = 200
const MAX_FACTS = 20

/** 把昵称变成安全文件名 */
export function safeKey(s) {
  return String(s || '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 60) || 'unknown'
}

const nowIso = () => new Date().toISOString()

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonSafe(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 1), 'utf8')
    return true
  } catch { return false }
}

export const memoryDir = (home) => path.join(home, 'memory')
const dmFile = (home, nick) => path.join(memoryDir(home), `dm-${safeKey(nick)}.json`)

export function loadDmMemory(home, nick) {
  if (!nick) return null
  const j = readJsonSafe(dmFile(home, nick), null)
  if (!j || typeof j !== 'object') return null
  return {
    who: j.who || { nick },
    updatedAt: j.updatedAt || '',
    rounds: Number(j.rounds) || 0,
    facts: Array.isArray(j.facts) ? j.facts.filter(x => typeof x === 'string').slice(0, MAX_FACTS) : [],
    messages: Array.isArray(j.messages) ? j.messages.filter(m => m && m.text) : [],
  }
}

/**
 * 把一次读到的会话**合并**进记忆。
 * 合并而不是覆盖：抖音只给最近 60 条，整段覆盖会把更早的记忆冲掉。
 * 去重键用 `from|正文前 60 字`——DOM 里没有稳定的消息 id。
 */
export function mergeDmMemory(home, nick, msgs) {
  if (!nick || !Array.isArray(msgs)) return null
  const prev = loadDmMemory(home, nick) || { who: { nick }, rounds: 0, facts: [], messages: [] }
  const seen = new Set(prev.messages.map(m => `${m.from}|${String(m.text).slice(0, 60)}`))
  const merged = [...prev.messages]
  let added = 0
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const text = String(m.text || '').trim()
    if (!text) continue
    const from = m.from === 'me' ? 'me' : (m.from === 'them' ? 'them' : 'unknown')
    const key = `${from}|${text.slice(0, 60)}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      at: nowIso(),
      from,
      text: text.slice(0, MAX_TEXT),
      kind: m.kind || (Number(m.awe) === 800 ? 'video' : 'text'),
      item_id: m.item_id || '',
    })
    added++
  }
  const trimmed = merged.slice(-MAX_MESSAGES)
  const out = {
    who: { nick },
    updatedAt: nowIso(),
    rounds: (Number(prev.rounds) || 0) + (added ? 1 : 0),
    facts: (prev.facts || []).slice(0, MAX_FACTS),
    messages: trimmed,
  }
  writeJsonSafe(dmFile(home, nick), out)
  return { ...out, added, total: trimmed.length }
}

/** 往记忆里加长期事实（住哪、养什么、在意什么） */
export function addFacts(home, nick, facts) {
  if (!nick || !Array.isArray(facts) || !facts.length) return null
  const prev = loadDmMemory(home, nick)
  if (!prev) return null
  const set = new Set(prev.facts)
  for (const f of facts) {
    const s = String(f || '').trim()
    if (s) set.add(s.slice(0, 80))
  }
  prev.facts = [...set].slice(0, MAX_FACTS)
  prev.updatedAt = nowIso()
  writeJsonSafe(dmFile(home, nick), prev)
  return prev
}

/**
 * 给模型看的上下文摘要：**只给最近几条 + 事实**。
 * 不要把 80 条全塞进提示词——那是白烧 token。
 */
export function dmContext(home, nick, { recent = 12, mine = 5 } = {}) {
  const m = loadDmMemory(home, nick)
  if (!m || !m.messages.length) return null
  return {
    who: m.who,
    rounds: m.rounds,
    facts: m.facts,
    recent: m.messages.slice(-recent),
    // 最近自己说过的话：提示词里用来禁止重复开头/句式
    mine: m.messages.filter(x => x.from === 'me' && x.text).slice(-mine).map(x => x.text),
    total_remembered: m.messages.length,
  }
}

/** 统计占用（调试用） */
export function memoryStats(home) {
  const dir = memoryDir(home)
  const out = { dir, files: 0, bytes: 0 }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/.test(f)) continue
      out.files++
      try { out.bytes += fs.statSync(path.join(dir, f)).size } catch { /* skip */ }
    }
  } catch { /* 目录不存在 */ }
  return out
}
