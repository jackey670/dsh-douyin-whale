#!/usr/bin/env node
/**
 * dsh-douyin-whale → ZCode 调度器
 *
 * 定时检查主人私信里的视频推荐 → 有新视频才叫醒 agent。
 * agent 不自己刷视频，只看主人发的；token 消耗最小化。
 *
 * 用法：
 *   node scheduler.mjs                    启动常驻调度器
 *   node scheduler.mjs --watch-now        立刻检查 + 看
 *   node scheduler.mjs --status           看状态
 *   node scheduler.mjs --stop             停止
 *
 * 配置：~/.dsh/douyin-whale.config.json（参考 config.example.json）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dmContext, mergeDmMemory } from './memory.mjs'
import { buildTaskPrompt, buildSharePrompt } from './prompt.mjs'
import { beginReplyMarker, endReplyMarker, readReplyMarker } from '../lib/reply_marker.js'
import { judgeDelivery } from '../lib/whale_readback.js'
import { runWatchRound, inWatchWindow, shouldProactiveShare } from '../lib/whale_round.js'
import { readDm } from '../lib/dm_reader.js'
import { applyMoodEvent, applyRoundMood, readMood } from '../lib/mood.js'
import { petNotify, syncPetSleep } from '../lib/pet_bridge.js'
import { ensureMemoryLayers, withMemoryLayers } from '../lib/memory_layers.js'
import {
  MAX_ATTEMPTS, bumpAttempt, capRepliedIds, mergeQueue, pendingOf,
  readState as readStateFile, updateState as updateStateFile, writeState as writeStateFile,
} from './state.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const CFG_FILE = process.env.DOUYIN_WHALE_CONFIG || path.join(DSH_HOME, 'douyin-whale.config.json')
const AGENT_DIR = path.join(HERE, 'agent')
const STATE_FILE = path.join(DSH_HOME, 'douyin-whale-state.json')
const MOOD_FILE = path.join(DSH_HOME, 'whale-mood.json')
const LOG_FILE = path.join(DSH_HOME, 'douyin-whale-scheduler.log')
const PID_FILE = path.join(DSH_HOME, 'douyin-whale-scheduler.pid')
const DENY_FILE = path.join(HERE, 'tools-deny.txt')

const ZCODE_CLI = process.env.ZCODE_CLI || path.join(
  process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
  'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs',
)
const ZCODE_NODE = process.env.ZCODE_NODE || process.execPath
const ZCODE_BUILTIN_PROVIDER = (() => {
  try {
    const p = path.resolve(path.dirname(ZCODE_CLI), '..', 'config', 'provider', 'zcode-builtin.json')
    return fs.existsSync(p) ? p : ''
  } catch { return '' }
})()

// ── 基础 ────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { fs.mkdirSync(DSH_HOME, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
  try { console.log(line) } catch {}
}
function readJson(f, d = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
function writeJson(f, o) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n') } catch (e) { log(`写文件失败: ${e.message}`) } }
function readConfig() { return readJson(CFG_FILE, {}) || {} }
function isAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const defaultPy = () => process.env.DOUYIN_PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe')

// ── 状态 ────────────────────────────────────────────────────────────────────
// 具体规则在 state.mjs（跨天只清计数、队列旧→新、文字消息也入队）
const readState = () => readStateFile(STATE_FILE)
const writeState = (st) => writeStateFile(STATE_FILE, st)
const updateState = (fn) => updateStateFile(STATE_FILE, fn)

// ── ZCode 唤醒 ──────────────────────────────────────────────────────────────
const WAKE_BACKOFF_MS = 5 * 60_000
const WAKE_STUCK_MS = 15 * 60_000
let waking = false
let wakingSince = 0
let lastWakeFailure = 0

function denyTools() {
  try { return fs.readFileSync(DENY_FILE, 'utf8').trim() || '' } catch { return '' }
}

/** 当前可见顶层窗口快照（Windows）。失败返回 null，不影响唤醒。 */
function visibleWindows() {
  if (os.platform() !== 'win32') return null
  try {
    const ps = 'Get-Process | Where-Object {$_.MainWindowHandle -ne 0} '
      + '| ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }'
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch { return null }
}

function logNewWindows(before, tag) {
  if (!before) return
  const after = visibleWindows()
  if (!after) return
  const fresh = [...after].filter((w) => !before.has(w))
  if (fresh.length) {
    log(`[wake:${tag}] ⚠️ 唤醒期间新窗口: ${fresh.join(' ; ').slice(0, 600)}`)
  }
}

function wakeAgent(text, tag = 'wake') {
  if (waking && wakingSince > 0 && Date.now() - wakingSince > WAKE_STUCK_MS) {
    log(`[wake] waking 卡死 ${Math.round((Date.now() - wakingSince) / 60000)} 分钟，强制重置`)
    waking = false; wakingSince = 0
  }
  if (waking) return Promise.resolve({ ok: false, skipped: 'busy' })
  if (Date.now() - lastWakeFailure < WAKE_BACKOFF_MS) return Promise.resolve({ ok: false, skipped: 'backoff' })
  waking = true; wakingSince = Date.now()

  const args = [
    ZCODE_CLI, '-p', text, '--cwd', AGENT_DIR, '--json', '--no-color', '--mode', 'yolo',
    // 关键：不带 surface 时桌面版 CLI 会把 ZCode 窗口顶到前台（大白框）。
    // terminal surface 才是纯后台 headless prompt。
    '--surface', 'terminal',
    // 凭据失效时 CLI 默认会拉起浏览器/桌面窗口做登录；调度器里不能弹窗。
    '--no-browser',
  ]
  const deny = denyTools()
  if (deny) args.push('--disallowed-tools', deny)

  log(`[wake:${tag}] 启动 ZCode（新建会话${deny ? ' · 工具已裁剪' : ''}）`)
  // 白框取证：记下唤醒前后的可见窗口，真冒出窗口时日志能说清是哪个进程。
  const windowsBefore = visibleWindows()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(ZCODE_NODE, args, {
        cwd: AGENT_DIR, windowsHide: true,
        env: {
          ...process.env,
          // ZCode 的 home 不是 ZCODE_HOME（CLI 根本不读），别再设它误导自己。
          // 这里只保证 agent 侧所有抖音命令都走无头浏览器。
          DOUYIN_HEADLESS: '1',
          ...(ZCODE_BUILTIN_PROVIDER ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_BUILTIN_PROVIDER } : {}),
          DOUYIN_WHALE_CONFIG: CFG_FILE,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      waking = false; wakingSince = 0; lastWakeFailure = Date.now()
      log(`[wake:${tag}] 启动失败: ${e.message}`)
      resolve({ ok: false, error: e.message }); return
    }

    let out = '', err = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch {} }, 45 * 60_000)
    child.stdout.on('data', d => { out += String(d); if (out.length > 64e6) out = out.slice(-32e6) })
    child.stderr.on('data', d => { err += String(d); if (err.length > 4e6) err = err.slice(-2e6) })

    const finish = (code) => {
      clearTimeout(timer); waking = false; wakingSince = 0
      logNewWindows(windowsBefore, tag)
      // Bilibili 式多行 JSON 扫描
      const objects = []
      { let depth = 0, start = -1, inStr = false, esc = false
        for (let i = 0; i < out.length; i += 1) {
          const ch = out[i]
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
          if (ch === '"') { inStr = true; continue }
          if (ch === '{') { if (depth === 0) start = i; depth += 1; continue }
          if (ch === '}') { depth -= 1; if (depth === 0 && start >= 0) { try { objects.push(JSON.parse(out.slice(start, i + 1))) } catch {} start = -1 } }
        }
      }
      const parsed = [...objects].reverse().find(o => o && o.sessionId && (o.response !== undefined || o.usage)) || null
      const sid = parsed?.sessionId || (out.match(/"sessionId"\s*:\s*"([^"]+)"/) || [])[1] || null
      const response = String(parsed?.response ?? '')
      const ok = code === 0 && !!sid && !timedOut
      if (ok) { lastWakeFailure = 0; log(`[wake:${tag}] 完成 · ${sid} · response=${response.slice(0, 240).replace(/\n/g, ' ')}`) }
      else { lastWakeFailure = Date.now(); log(`[wake:${tag}] 失败 code=${code}\n${(err || out).slice(-1800)}`) }
      resolve({ ok, code, response, sessionId: sid, timedOut })
    }
    child.on('close', finish)
    child.on('error', (e) => { clearTimeout(timer); waking = false; wakingSince = 0; lastWakeFailure = Date.now(); log(`[wake:${tag}] spawn 失败: ${e.message}`); resolve({ ok: false, error: e.message }) })
  })
}

// ── tick ────────────────────────────────────────────────────────────────────
// 回读判定/标记/队列操作都走共享引擎（lib/whale_round.js + lib/whale_readback.js）
let checking = false
async function tick({ manual = false } = {}) {
  if (checking || waking) return
  const cfg = readConfig()
  if (cfg.watch?.enabled === false) return
  if (!inWatchWindow(cfg.watch?.windows)) {
    if (manual) log('[tick] 当前不在观看时段内')
    return
  }
  const ownerNick = cfg.owner?.nickname
  if (!ownerNick) {
    if (manual) log('[tick] config owner.nickname 未配置')
    return
  }
  // 心情/作息：先让桌宠跟上（到点睡觉/起床），再决定这轮怎么说话
  ensureMemoryLayers({ home: DSH_HOME, nick: ownerNick, log })
  const mood = readMood({ file: MOOD_FILE, cfg })
  void syncPetSleep({ view: mood, home: DSH_HOME, cfg, log })

  checking = true
  try {
    const st = readState()
    const py = defaultPy()
    const dm = readDm({ ownerNick, py, root: ROOT, dataDir: path.join(ROOT, 'data'), log })
    if (!dm || dm.__error) return

    const mem = dmContext(DSH_HOME, ownerNick)
    const result = await runWatchRound({
      cfg, dm, ownerNick, manual,
      state: { read: () => readState(), update: (mutate) => updateState(mutate) },
      ops: { mergeQueue, pendingOf, bumpAttempt, capRepliedIds, maxAttempts: MAX_ATTEMPTS },
      brain: { dispatch: async ({ prompt }) => wakeAgent(prompt, 'watch') },
      buildPrompt: (ctx) => {
        const mem = withMemoryLayers({
          home: DSH_HOME,
          nick: ownerNick,
          query: [ctx.item?.title, ctx.item?.text].filter(Boolean).join(' ').slice(0, 200),
          mem: ctx.mem,
          log,
        })
        return buildTaskPrompt({
          ...ctx, mem, root: ROOT, home: DSH_HOME,
          persona: { name: cfg.persona?.name, ownerTitle: cfg.persona?.ownerTitle, text: cfg.persona?.text },
        })
      },
      checkDm: () => readDm({ ownerNick, py, root: ROOT, dataDir: path.join(ROOT, 'data'), log }),
      log, home: DSH_HOME, mem, root: ROOT, mood,
      mergeMemory: (after) => mergeDmMemory(DSH_HOME, ownerNick, after.messages),
      onEmpty: async ({ merged, manual: isManual }) => {
        // 没有待回复的内容 → 低概率刷一条主动分享（有限流闸，不会烧穿 token）
        if (isManual) {
          log(`[tick] 没有待回复的内容（队列 ${merged.queue.length} 条，已回复 ${(merged.repliedIds ?? []).length} 条）`)
        }
        await maybeShareShell({ cfg, merged, manual: isManual, ownerNick, log })
      },
    })

    applyRoundMood({ file: MOOD_FILE, round: result.round, cfg, log })
    if (result.round === 'delivered') {
      void petNotify({ text: '回完主人一条啦', home: DSH_HOME, cfg, log })
    }

    if (result.round === 'dispatch-failed') {
      // 唤醒失败通常是基础设施问题（CLI/登录/网络），不该把内容记成「这条不行」；
      // 不计 attempts，只靠 backoff 控制频率，日志里能看见。
      const r = result.r
      log(`[tick] watch 未完成（${r.skipped || r.error || 'unknown'}），下轮重试 ${result.next.id}`)
      return
    }

    // 登录失效检测（只有唤醒成功的结果才带 response）
    const resp = String(result.r?.response ?? '')
    if (['请先登录', '登录已失效', '需要登录'].some(p => resp.includes(p))) {
      const fails = (st.loginFails ?? 0) + 1
      writeState({ ...readState(), loginFails: fails })
      log(`[tick] ⚠️ 登录失效（连续 ${fails} 次）`)
    }
  } finally { checking = false }
}

/** 主动分享轮（shell 版）：队列空闲时按概率刷一条视频卡片给主人。
 *  与 duty 版同一套闸门（lib/whale_round.js 的 shouldProactiveShare），多一道
 *  最小间隔闸（proactiveShare.minIntervalMinutes，默认 120 分钟）+ lastShareAt
 *  落盘——不让空队列的唤醒把 token 烧穿。没发出去不计数，下轮重摇。 */
async function maybeShareShell({ cfg, merged, manual, ownerNick, log }) {
  const pc = cfg.proactiveShare ?? {}
  const mood = readMood({ file: MOOD_FILE, cfg })
  const gate = shouldProactiveShare({
    pc, merged, manual, mood,
    lastShareAt: readState().lastShareAt || '',
    minIntervalMinutes: pc.minIntervalMinutes,
  })
  if (!gate.ok) {
    if (gate.reason === 'daily-max') {
      log(`[tick] 今日已分享 ${merged.shares ?? 0} 条，达到上限，明天再刷`)
    }
    return
  }
  const bumpMood = (event) => {
    try { applyMoodEvent({ file: MOOD_FILE, event, cfg }) } catch (e) {
      log(`[mood] 状态写入失败（不影响分享）: ${e?.message ?? e}`)
    }
  }
  try {
    beginReplyMarker(DSH_HOME, { id: `share-${Date.now()}`, kind: 'video' })
    const mem = withMemoryLayers({
      home: DSH_HOME,
      nick: ownerNick,
      query: (cfg.preferences?.like ?? []).join(' '),
      mem: dmContext(DSH_HOME, ownerNick),
      log,
    })
    const r = await wakeAgent(buildSharePrompt({ ownerNick, mem, cfg, root: ROOT, mood }), 'share')
    // 无论成败都记时间戳：这次机会用掉了，限流闸才算数
    updateState((c) => ({ ...c, lastShareAt: new Date().toISOString() }))
    const marker = readReplyMarker(DSH_HOME)
    endReplyMarker(DSH_HOME)
    if (!r.ok) {
      bumpMood('share_failed')
      log(`[tick] 主动分享唤醒失败（${r.skipped || r.error || 'unknown'}），下轮重摇`)
      return
    }
    if (!marker?.sent) {
      log('[tick] 主动分享：agent 没发（没挑到合适的就宁可不发，正常）')
      return
    }
    const after = readDm({ ownerNick, py: defaultPy(), root: ROOT, dataDir: path.join(ROOT, 'data'), log })
    const cardSeen = judgeDelivery({ marker, before: null, after }).cardDelivered
    if (!cardSeen) {
      bumpMood('share_failed')
      log(`[tick] ⚠️ 主动分享卡片未在回读里确认（aweme ${marker.video}）——不计数`)
      return
    }
    const cur = updateState((c) => ({ ...c, shares: (c.shares ?? 0) + 1 }))
    bumpMood('share')
    void petNotify({ text: '刷到一条好玩的，发给主人了', home: DSH_HOME, cfg, log })
    log(`[tick] 主动分享已确认（aweme ${marker.video}），今日第 ${cur.shares ?? 1} 条`)
  } catch (e) {
    try { endReplyMarker(DSH_HOME) } catch { /* 已清理也算成功 */ }
    log(`[tick] 主动分享异常: ${e?.message ?? e}`)
  }
}

function status() {
  const cfg = readConfig()
  const st = readState()
  const pid = daemonPid()
  console.log('douyin-whale 调度器')
  console.log('运行中    :', isAlive(pid) ? `PID ${pid}` : '否')
  console.log('owner     :', cfg.owner?.nickname ?? '未配置')
  console.log('频率      :', `每 ${cfg.watch?.intervalMinutes ?? 5} 分钟检查私信`)
  console.log('今日      :', `已看 ${st.watches ?? 0} 条`)
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-6)
    console.log('\n最近日志:')
    for (const l of lines) console.log('  ' + l)
  } catch {}
}

function daemonPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim()
    const pid = raw.startsWith('{') ? (JSON.parse(raw).pid ?? 0) : Number(raw)
    return isAlive(pid) ? pid : 0
  } catch { return 0 }
}

/** 扫描并杀掉旧的 scheduler.mjs 进程（防多实例叠加消耗模型额度） */
function cleanupOldInstances() {
  if (os.platform() !== 'win32') return
  try {
    const myPid = process.pid
    const psOut = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -like '*scheduler.mjs*' -and $_.ProcessId -ne ${myPid} } | ForEach-Object { Write-Output $_.ProcessId }"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    ).trim()
    for (const pidStr of psOut.split('\n').map(s => s.trim()).filter(Boolean)) {
      const pid = Number(pidStr)
      if (!pid || pid === myPid) continue
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 10000, windowsHide: true })
        log(`[cleanup] 已杀掉旧调度器进程 PID ${pid}`)
      } catch {}
    }
  } catch (e) {
    // 清理失败不阻塞启动
    log(`[cleanup] 清理旧实例失败（不阻塞）: ${String(e.message).slice(0, 100)}`)
  }
}

function startDaemon() {
  // 清理旧实例：扫描所有 scheduler.mjs 进程（排除自己）
  cleanupOldInstances()

  if (daemonPid()) { console.log(`已在运行（PID ${daemonPid()}）`); return }
  log(`调度器启动（PID ${process.pid}）`)
  writeJson(PID_FILE, { pid: process.pid, startedAt: new Date().toISOString() })

  // 预启动 HTTP API
  try {
    const py = process.env.DOUYIN_PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    const serverScript = path.join(ROOT, 'python', 'douyin_http.py')
    if (fs.existsSync(py) && fs.existsSync(serverScript)) {
      const child = spawn(py, [serverScript], {
        cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: 'ignore', detached: false, windowsHide: true,
      })
      child.unref()
      log(`HTTP API 已预启动（PID ${child.pid}）`)
    }
  } catch (e) { log(`HTTP API 预启动失败: ${e.message}`) }

  // 按配置的间隔跑（以前写死 60 秒：待回复多条时会一分钟连发好几条，容易触发风控）。
  // 用自调度 setTimeout 而不是 setInterval，这样一轮跑得比间隔久也不会叠起来。
  const runOnce = async () => {
    try { await tick() } catch (e) { log(`[tick] 异常: ${e.message}`) }
  }
  const scheduleLoop = () => {
    const mins = Math.max(1, Number(readConfig().watch?.intervalMinutes ?? 10) || 10)
    setTimeout(async () => { await runOnce(); scheduleLoop() }, mins * 60_000)
  }
  // 启动后先跑一次，之后按间隔
  setTimeout(async () => { await runOnce(); scheduleLoop() }, 15_000)
  console.log(`douyin-whale 调度器已启动（PID ${process.pid}）`)
}

function stopDaemon() {
  const pid = daemonPid()
  if (!pid) { console.log('没有在运行'); return }
  try { process.kill(pid) } catch {}
  try { fs.rmSync(PID_FILE, { force: true }) } catch {}
  log('调度器已停止'); console.log('已停止')
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = x => argv.includes(x)

process.on('uncaughtException', err => log(`[FATAL] uncaughtException: ${err.message}\n${err.stack?.slice(0, 500)}`))
process.on('unhandledRejection', reason => log(`[FATAL] unhandledRejection: ${reason}`))

if (has('--help') || has('-h')) {
  console.log(`douyin-whale 调度器（只看主人推荐的视频，零浏览消耗）
  node scheduler.mjs               启动
  node scheduler.mjs --watch-now   立刻检查私信 + 看
  node scheduler.mjs --dry-tick    只打印本轮会处理哪条（不唤醒模型）
  node scheduler.mjs --memory-sync 把当前会话灌进本地记忆（不唤醒模型）
  node scheduler.mjs --status      状态
  node scheduler.mjs --stop        停止`)
} else if (has('--status')) {
  status()
} else if (has('--stop')) {
  stopDaemon()
} else if (has('--test-cli')) {
  const r = await wakeAgent('只回复OK', 'test')
  console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1)
} else if (has('--memory-sync')) {
  // 只读：把当前会话灌进本地记忆，不唤醒模型、不发送
  const cfg = readConfig()
  const ownerNick = cfg.owner?.nickname ?? ''
  if (!ownerNick) { console.error('config owner.nickname 未配置'); process.exit(1) }
  const dm = readDm({ ownerNick, py: defaultPy(), root: ROOT, dataDir: path.join(ROOT, 'data'), log })
  if (!dm || dm.__error) { console.log('读私信失败'); process.exit(1) }
  const r = mergeDmMemory(DSH_HOME, ownerNick, dm.messages || [])
  console.log(JSON.stringify({ ok: true, added: r?.added ?? 0, total: r?.total ?? 0 }, null, 2))
  process.exit(0)
} else if (has('--dry-tick')) {
  // 只读：读私信 + 打印本轮会处理哪条，不唤醒模型、不花钱
  const cfg = readConfig()
  const ownerNick = cfg.owner?.nickname ?? ''
  if (!ownerNick) { console.error('config owner.nickname 未配置'); process.exit(1) }
  const dm = readDm({ ownerNick, py: defaultPy(), root: ROOT, dataDir: path.join(ROOT, 'data'), log })
  if (!dm || dm.__error) { console.log('读私信失败'); process.exit(1) }
  const st = readState()
  const all = Array.isArray(dm.messages)
    ? dm.messages.filter(m => m && typeof m === 'object' && m.from !== 'me')
    : []
  const textMsgs = all.filter(m => !m.item_id && m.kind !== 'sticker' && String(m.text || '').trim())
  const keepTexts = new Set(textMsgs.slice(-5))
  const items = all.filter(m => m.item_id || m.kind === 'sticker' || keepTexts.has(m))
  const queued = mergeQueue(st.queue ?? [], items)
  const pending = pendingOf(queued, st.repliedIds)
  console.log(JSON.stringify({
    fiber_diag: dm.fiber_diag,
    visible_now: items.length,
    queue_total: queued.length,
    already_replied: st.repliedIds,
    queue: queued.map(q => ({
      id: q.id, kind: q.kind, attempts: q.attempts,
      title: (q.title || q.text || '').slice(0, 40),
    })),
    next: pending[0] ? { id: pending[0].id, kind: pending[0].kind } : null,
    pending: pending.map(q => `${q.id}(${q.kind})`),
  }, null, 2))
  process.exit(0)
} else if (has('--watch-now')) {
  await tick({ manual: true })
  process.exit(0)
} else {
  startDaemon()
}
