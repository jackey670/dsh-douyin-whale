/**
 * lib/diary.test.mjs —— 两本日记读写的离线自测（临时 home，不碰真实 ~/.dsh）。
 *
 * 运行：node lib/diary.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { appendDiary, diaryPath, readDiary } from './diary.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));

try {
  // ── ① 空文件读取：不存在 → exists=false，不抛 ──
  {
    const r = readDiary({ kind: 'public', home });
    assert.equal(r.exists, false);
    assert.equal(r.total_sections, 0);
    assert.equal(r.today_sections.length, 0);
    assert.equal(diaryPath('public', home), path.join(home, 'whale-diary.md'));
    ok('① 空日记读取不抛');
  }

  // ── ② 追加一条：新开当天小节，读取可见 ──
  {
    const w = appendDiary({ kind: 'public', home, text: '主人，这条猫脸先生把本鱼看笑了。' });
    assert.equal(w.len, 16);
    assert.match(w.heading, /^## \d{4}-\d{2}-\d{2} · \d{2}:\d{2}（值班轮）$/);
    const r = readDiary({ kind: 'public', home });
    assert.equal(r.exists, true);
    assert.equal(r.total_sections, 1);
    assert.equal(r.today_sections.length, 1);
    assert.match(r.today_sections[0].body, /猫脸先生/);
    ok('② 追加开新节并可读回');
  }

  // ── ③ 再写一条：仍开新节；read sections=2 带最近两条 ──
  {
    appendDiary({ kind: 'public', home, text: '第二句，节奏散着抛，跟不上也正常。' });
    const r = readDiary({ kind: 'public', home, sections: 2 });
    assert.equal(r.total_sections, 2);
    assert.equal(r.recent.length, 2);
    assert.match(r.recent[1].body, /第二句/);
    // 文件里两节各自带标题
    const raw = fs.readFileSync(path.join(home, 'whale-diary.md'), 'utf8');
    const headingCount = raw.split('\n').filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l)).length;
    assert.equal(headingCount, 2);
    ok('③ 每条一节，read 带最近两节');
  }

  // ── ④ private 是另一份文件，互不串 ──
  {
    appendDiary({ kind: 'private', home, text: '偏好校准：主人吃荒诞冷梗，回复别解释梗。' });
    const r = readDiary({ kind: 'private', home });
    assert.equal(r.total_sections, 1);
    assert.match(r.today_sections[0].body, /偏好校准/);
    const pub = readDiary({ kind: 'public', home });
    assert.equal(pub.total_sections, 2, '公开日记没被动过');
    assert.equal(diaryPath('private', home), path.join(home, 'whale-diary-private.md'));
    ok('④ private/public 各自一份');
  }

  // ── ⑤ 校验：空/超长/控制字符/未知 kind ──
  {
    assert.throws(() => appendDiary({ kind: 'public', home, text: '   ' }));
    assert.throws(() => appendDiary({ kind: 'public', home, text: '长'.repeat(301) }));
    assert.throws(() => appendDiary({ kind: 'public', home, text: '含\u0000控制字符' }));
    assert.throws(() => appendDiary({ kind: 'other', home, text: 'x' }));
    assert.throws(() => readDiary({ kind: 'other', home }));
    ok('⑤ 空值/超长/控制字符/未知 kind 全拒');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
