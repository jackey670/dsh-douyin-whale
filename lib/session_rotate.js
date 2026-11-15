/**
 * lib/session_rotate.js —— 值班会话轮换（记忆分层 Phase 2B）。
 *
 * 只解决「长生命周期会话上下文顶满」这一件事：
 *   · 用量估算：优先读会话里最近一次 assistant/message 的 usage，
 *     读不到就按可见消息字数估；
 *   · 触发：窗口占比、会话年龄、轮数三选一；
 *   · 交接简报：从四层记忆拼一份 ≤1400 字的 briefing，不调模型；
 *   · 轮换前顺手跑固化/反思，输出留在旧会话，马上被新会话替换。
 *
 * 状态文件 `memory/session-epochs.json` 只记 id/时间/轮数，不记正文。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadDmMemory } from '../scheduler/memory.mjs';
import { readMemoryStore } from './memory_layers.js';

const DAY_MS = 86_400_000;
const oneLine = (s, max = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '??'
    : `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
};

export const DEFAULT_ROTATE = {
  enabled: true,
  contextRatio: 0.7,
  maxAgeDays: 7,
  maxTurns: 200,
};

export function sessionStatePath(home) {
  return path.join(home, 'memory', 'session-epochs.json');
}

export function readSessionState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

export function writeSessionState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 触发判断：开关 → 手动 → 窗口占比 → 会话年龄 → 轮数。 */
export function shouldRotate({
  context = {}, startedAt = '', turns = 0, now = new Date(), cfg = {}, force = false,
} = {}) {
  const c = { ...DEFAULT_ROTATE, ...(cfg.duty?.rotate || {}) };
  if (c.enabled === false && !force) return { ok: false, reason: 'disabled' };
  if (force) return { ok: true, reason: 'manual' };
  const ratio = Number(context.ratio) || 0;
  if (ratio >= Number(c.contextRatio ?? DEFAULT_ROTATE.contextRatio)) {
    return { ok: true, reason: 'usage', ratio };
  }
  const started = Date.parse(startedAt || '') || 0;
  const ageDays = started ? (now.getTime() - started) / DAY_MS : 0;
  if (Number(c.maxAgeDays) > 0 && ageDays >= Number(c.maxAgeDays)) {
    return { ok: true, reason: 'age', ageDays: Number(ageDays.toFixed(1)) };
  }
  if (Number(c.maxTurns) > 0 && Number(turns) >= Number(c.maxTurns)) {
    return { ok: true, reason: 'turns', turns: Number(turns) };
  }
  return { ok: false, reason: 'ok', ratio };
}

/**
 * 交接简报：档案 ≤8、里程碑 ≤2、叙事线 ≤3、重要情节 ≤8、最近 5 句、当前状态。
 * 私人事实/日记一律不进；总长 ≤1400 字。
 */
export function buildHandoffBriefing({
  home, nick = '', mood = null, now = new Date(), maxChars = 1400,
} = {}) {
  const store = readMemoryStore(home);
  const profile = store.profile || {};
  const lines = [
    '【交接简报】刚换了一个新会话，上一段上下文要收了。下面是仍要记住的事；不要复述这份简报，也不要向主人提「换会话」。',
  ];
  const push = (title, rows) => {
    if (!rows.length) return;
    const block = [title, ...rows];
    const used = lines.join('\n').length;
    const room = maxChars - used - 2;
    if (room <= title.length + 1) return;
    const clipped = [];
    let chars = 0;
    for (const row of block) {
      if (chars + row.length + 1 > room) break;
      clipped.push(row);
      chars += row.length + 1;
    }
    lines.push(...clipped, '');
  };

  const facts = (profile.facts || [])
    .filter((f) => f && f.text && !f.deleted && !f.superseded_by && f.visibility !== 'private')
    .sort((a, b) => (Number(b.pinned) || 0) - (Number(a.pinned) || 0)
      || (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, 8)
    .map((f) => `・${oneLine(f.text, 90)}`);
  push('【主人档案】', facts);

  const milestones = (profile.relationship?.milestones || [])
    .filter((m) => m?.text && m.visibility !== 'private')
    .slice(-2)
    .map((m) => `・${fmtDate(m.at)} ${oneLine(m.text, 80)}`);
  push('【我们之间】', milestones);

  const arcs = [...(store.arcs?.arcs || [])]
    .filter((a) => a && a.title && a.summary && a.visibility !== 'private')
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))
    .slice(0, 3)
    .map((a) => `・${oneLine(a.period, 24)} ${oneLine(a.title, 16)}：${oneLine(a.summary, 80)}`);
  push('【最近这几周】', arcs);

  const recent = (store.episodes || [])
    .filter((e) => e && e.summary && e.visibility !== 'private')
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
      || (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0))
    .slice(0, 8)
    .map((e) => {
      const q = oneLine(e.evidence?.[0]?.quote, 40);
      return `・${fmtDate(e.ts)} ${oneLine(e.summary, 80)}${q ? `（「${q}」）` : ''}`;
    });
  push('【重要回忆】', recent);

  const dm = nick ? loadDmMemory(home, nick) : null;
  const chats = (dm?.messages || []).slice(-5)
    .filter((m) => m?.text)
    .map((m) => `・${m.from === 'me' ? '大肥鱼' : '主人'}：${oneLine(m.text, 60)}`);
  push('【最近聊过】', chats);

  if (mood?.label) {
    lines.push(`【现在状态】${mood.label}`
      + `（精力 ${Math.round(Number(mood.energy) || 0)}／`
      + `想念 ${Math.round(Number(mood.social) || 0)}／`
      + `无聊 ${Math.round(Number(mood.boredom) || 0)}）`);
  }
  lines.push('继续按 system prompt 值班；新任务马上来。');
  return lines.join('\n').trim().slice(0, maxChars);
}
