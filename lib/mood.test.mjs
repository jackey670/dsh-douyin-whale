/**
 * lib/mood.test.mjs —— 心情状态的漂移、事件、标签与作息窗口。
 *
 * 运行：node lib/mood.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  MOOD_DEFAULTS, applyMoodEvent, applyRoundMood, inQuietHours,
  moodHint, moodLabel, readMood,
} from './mood.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mood-'));
const file = path.join(home, 'whale-mood.json');
const cfg = { mood: { enabled: true, sleepWindows: [{ start: '23:30', end: '07:30' }] } };
const at = (h, m = 0) => new Date(2026, 10, 10, h, m, 0);
const write = (obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
};
const clear = () => { try { fs.unlinkSync(file); } catch { /* ignore */ } };
let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };

try {
  // 1) 没有文件 → 默认值；72/48/35 落在「平静」
  {
    clear();
    const v = readMood({ file, now: at(14), cfg });
    assert.equal(v.energy, MOOD_DEFAULTS.energy);
    assert.equal(v.social, MOOD_DEFAULTS.social);
    assert.equal(v.boredom, MOOD_DEFAULTS.boredom);
    assert.equal(v.sleeping, false);
    assert.equal(moodLabel(v), '平静');
    ok('默认值 + 平静标签');
  }

  // 2) 醒着漂移：2 小时 = 精力 −2.4、想念 +3、无聊 +4
  {
    write({
      updatedAt: new Date(at(12).getTime()).toISOString(),
      energy: 50, social: 40, boredom: 30,
    });
    const v = readMood({ file, now: at(14), cfg });
    assert.equal(v.energy, 47.6);
    assert.equal(v.social, 43);
    assert.equal(v.boredom, 34);
    assert.equal(v.driftedHours, 2);
    assert.equal(v.sleeping, false);
    ok('醒着漂移');
  }

  // 3) 睡眠窗口内：精力回、无聊降
  {
    write({
      updatedAt: at(1).toISOString(),
      energy: 60, social: 40, boredom: 30,
    });
    const v = readMood({ file, now: at(2), cfg });
    assert.equal(v.sleeping, true);
    assert.equal(v.energy, 66);
    assert.equal(v.social, 40.8);
    assert.equal(v.boredom, 29);
    assert.equal(moodLabel(v), '睡着');
    assert.equal(moodLabel(v, { awake: true }), '迷迷糊糊');
    ok('睡眠漂移 + 睡着/迷迷糊糊标签');
  }

  // 4) 跨午夜作息边界
  {
    const w = cfg.mood.sleepWindows;
    assert.equal(inQuietHours(w, at(23, 45)), true);
    assert.equal(inQuietHours(w, at(0, 0)), true);
    assert.equal(inQuietHours(w, at(7, 29)), true);
    assert.equal(inQuietHours(w, at(7, 30)), false);
    assert.equal(inQuietHours(w, at(12, 0)), false);
    assert.equal(inQuietHours([], at(2)), false, '空窗口 = 不睡');
    assert.equal(inQuietHours([{ start: 'bad', end: '07:00' }], at(2)), false, '畸形串跳过');
    ok('跨午夜作息窗口（含空/畸形）');
  }

  // 5) 回复事件：想念和无聊都降，记互动时间
  {
    write({ updatedAt: at(14).toISOString(), energy: 70, social: 50, boredom: 40 });
    const v = applyMoodEvent({ file, event: 'reply', now: at(14), cfg });
    assert.equal(v.energy, 66);
    assert.equal(v.social, 35);
    assert.equal(v.boredom, 28);
    assert.equal(v.lastInteractionAt, at(14).toISOString());
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.energy, 66, '事件落盘');
    ok('reply 事件落盘 + 互动时间');
  }

  // 6) 摸摸头：想念明显降、精力回一点
  {
    write({ updatedAt: at(14).toISOString(), energy: 70, social: 50, boredom: 40 });
    const v = applyMoodEvent({ file, event: 'poke', now: at(14), cfg });
    assert.equal(v.energy, 72);
    assert.equal(v.social, 32);
    assert.equal(v.boredom, 26);
    ok('poke 事件');
  }

  // 7) 钳制：怎么叠都不出 0–100
  {
    write({ updatedAt: at(14).toISOString(), energy: 2, social: 3, boredom: 1 });
    const v = applyMoodEvent({ file, event: 'reply', now: at(14), cfg });
    assert.equal(v.energy, 0);
    assert.equal(v.social, 0);
    assert.equal(v.boredom, 0);
    const high = applyMoodEvent({
      file, event: 'poke',
      now: new Date(at(14).getTime() + 1000),
      cfg,
    });
    assert.ok(high.energy <= 100 && high.social <= 100 && high.boredom <= 100);
    ok('三条轴钳制 0–100');
  }

  // 8) 标签阈值
  {
    const base = { enabled: true, sleeping: false };
    assert.equal(moodLabel({ ...base, energy: 20, social: 50, boredom: 50 }), '困');
    assert.equal(moodLabel({ ...base, energy: 60, social: 80, boredom: 50 }), '黏人');
    assert.equal(moodLabel({ ...base, energy: 60, social: 50, boredom: 80 }), '无聊');
    assert.equal(moodLabel({ ...base, energy: 70, social: 30, boredom: 30 }), '精神');
    assert.equal(moodLabel({ ...base, energy: 60, social: 50, boredom: 50 }), '平静');
    ok('状态标签阈值');
  }

  // 9) 心情关闭：只读不写，不睡
  {
    clear();
    const off = { mood: { enabled: false, sleepWindows: cfg.mood.sleepWindows } };
    const v = readMood({ file, now: at(2), cfg: off });
    assert.equal(v.enabled, false);
    assert.equal(v.sleeping, false);
    assert.equal(moodHint(v), '');
    const after = applyMoodEvent({ file, event: 'reply', now: at(2), cfg: off });
    assert.equal(after.enabled, false);
    assert.equal(fs.existsSync(file), false, '关闭时事件不落盘');
    ok('心情关闭时只读不写');
  }

  // 10) 坏文件兜底；提示词包含三条轴
  {
    fs.writeFileSync(file, '{not json', 'utf8');
    const v = readMood({ file, now: at(14), cfg });
    assert.equal(v.energy, MOOD_DEFAULTS.energy);
    const h = moodHint(v, { awake: true });
    assert.match(h, /现在的状态/);
    assert.match(h, /精力 72/);
    assert.match(h, /不要报数值/);
    ok('坏文件兜底 + 提示词格式');
  }

  // 11) round 结果映射：只记实质动作
  {
    write({ updatedAt: at(14).toISOString(), energy: 70, social: 50, boredom: 40 });
    const v = applyRoundMood({ file, round: 'delivered', now: at(14), cfg });
    assert.equal(v.social, 35);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(applyRoundMood({ file, round: 'empty', now: at(14), cfg }), null);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '空转不写盘');
    ok('round 结果映射');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
