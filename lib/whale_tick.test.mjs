/**
 * lib/whale_tick.test.mjs —— 一轮 tick 的离线自测。
 *
 * 值班 agent 用假件（send 记录、awaitIdle 立即返回）；私信读数用一个
 * **假 douyin_im.py**（放在假 root 的 python/ 下，由真实 venv 解释器执行，
 * 按调用次数出罐头 JSON）。全程不碰真实账号、不碰真实调度器状态。
 *
 * 运行：node lib/whale_tick.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createWhaleTick, resolvePy, inWatchWindow } from './whale_tick.js';
import { whalePaths } from './whale_state.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tick-'));
const ROOT = path.resolve('.');
const paths = whalePaths(home);
fs.mkdirSync(paths.memoryDir, { recursive: true });

const today = new Date().toLocaleDateString('sv-SE');
fs.writeFileSync(paths.config, JSON.stringify({
  owner: { nickname: '测试主人' },
  watch: { enabled: true, intervalMinutes: 10, dailyMax: 60,
           windows: [{ start: '00:00', end: '24:00' }] },
  // 假 root 下没有 venv：显式指到本仓库的 venv，让 resolvePy 走「配置优先」
  pythonPath: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
}, null, 2));
fs.writeFileSync(paths.state, JSON.stringify({
  date: today, watches: 0, repliedIds: [], queue: [], loginFails: 0,
}, null, 2));

// ── 假 root：python/douyin_im.py 由真实 venv 执行，脚本自己数调用次数 ──
// tick 会读两次私信（处理前 / 回读确认），罐头必须在两次之间变化——
// 第一次读没有新回复，第二次读多一条「我发的」→ 回读判定才会通过。
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fakeroot-'));
fs.mkdirSync(path.join(fakeRoot, 'python'), { recursive: true });
process.env.STUB_COUNT = path.join(home, 'stub-count.txt');
fs.writeFileSync(path.join(fakeRoot, 'python', 'douyin_im.py'), [
  'import json, sys, os',
  'cfile = os.environ["STUB_COUNT"]',
  'n = int(open(cfile).read() or 0) if os.path.exists(cfile) else 0',
  'open(cfile, "w").write(str(n + 1))',
  'dd = os.environ.get("STUB_DATADIR")',
  'if dd:',
  '    open(dd, "w").write(os.environ.get("DOUYIN_DATA_DIR", ""))',
  'mode = os.environ.get("STUB_MODE")',
  'if mode == "need_login":',
  '    out = {"ok": False, "error": {"code": "NEED_LOGIN", "message": "需要先登录抖音"}}',
  'else:',
  '    extra = [{"from": "me", "text": "新回复文本已发出#" + str(n), "kind": "text", "item_id": "", "title": ""}] if n >= 1 else []',
  '    messages = ["纯文本行（fiber 不可用）"] if mode == "strings" else [',
  '        {"from": "me", "text": "旧回复", "kind": "text", "item_id": "", "title": ""},',
  '        *extra,',
  '        {"from": "them", "text": "主人发的视频", "kind": "video", "item_id": "V1", "title": "待回复视频", "awe": 800},',
  '      ]',
  '    out = {"ok": True, "data": {"target": "测试主人", "message_count": 3, "fiber_diag": {},',
  '      "messages": messages,',
  '      "videos": [{"item_id": "V1", "title": "待回复视频", "kind": "video", "from": "them"}],',
  '      "video_urls": [], "card_authors": []}}',
  'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
].join('\n'), 'utf8');
/** 测试 ② 用：让「新回复」一开始就在 → 回读无新增 */
const presetCounter = (n) => fs.writeFileSync(process.env.STUB_COUNT, String(n));
delete process.env.DOUYIN_PYTHON;            // 走真实 venv 解析

// ── 假值班 agent ──
const mkDuty = ({ sendResult = { ok: true }, idle = { sawRunning: true, elapsedMs: 5 } } = {}) => {
  const sent = [];
  return {
    sent,
    send: async (text) => { sent.push(text); return sendResult; },
    awaitIdle: async () => idle,
    running: () => false,
  };
};

const logLines = [];
const log = (m) => logLines.push(m);

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };

try {
  // ── ① 正常一轮：投递 → 回读发现新消息 → 标记已回复 ──
  {
    const duty = mkDuty();
    const dyData = path.join(home, 'dy-data');
    const dataDirOut = path.join(home, 'datadir.txt');
    process.env.STUB_DATADIR = dataDirOut;
    const tick = createWhaleTick({
      log, dutyAgent: duty, root: fakeRoot, home, dataDir: dyData,
    });
    await tick({ manual: true });
    const st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.deepEqual(st.repliedIds, ['V1']);
    assert.equal(st.watches, 1);
    assert.equal(duty.sent.length, 1);
    assert.match(duty.sent[0], /内容 ID：V1/);
    assert.match(duty.sent[0], /待回复视频/);
    assert.match(duty.sent[0], /frames V1/);
    // 首轮 tick 时本地记忆还是空的（回复成功后才写入），不该有「最近的对话」
    assert.doesNotMatch(duty.sent[0], /最近的对话/);
    // dataDir 必须真的传给 Python（否则读的是插件根下的 data/）
    assert.equal(fs.readFileSync(dataDirOut, 'utf8'), dyData);
    delete process.env.STUB_DATADIR;
    ok('① 投递+回读通过 → 标记已回复（dataDir 生效）');
  }

  // ── ①b 第二轮：上一轮的记忆应该出现在任务消息里 ──
  {
    // 新增一条待回复视频 V2；stub 的计数已让「新回复文本已发出」常驻
    fs.writeFileSync(paths.state, JSON.stringify({
      date: today, watches: 1,
      repliedIds: ['V1'],
      queue: [
        { item_id: 'V1', title: '待回复视频', kind: 'video', seen_at: today },
        { item_id: 'V2', title: '第二条视频', kind: 'video', seen_at: today },
      ],
      loginFails: 0,
    }, null, 2));
    const duty = mkDuty();
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    await tick({ manual: true });
    assert.equal(duty.sent.length, 1);
    assert.match(duty.sent[0], /内容 ID：V2/);
    assert.match(duty.sent[0], /最近聊过/);            // ① 写入的记忆生效
    assert.match(duty.sent[0], /新回复文本已发出/);      // 上一轮的回复内容
    const st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.deepEqual(st.repliedIds.sort(), ['V1', 'V2']);
    ok('①b 第二轮带上一轮记忆');
  }

  // ── ② 已回复的不重复处理（读数重置：没有新消息）──
  {
    presetCounter(0);                          // 两次读都没有新回复
    const duty = mkDuty();
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    await tick({ manual: true });
    assert.equal(duty.sent.length, 0);
    ok('② 已回复的不重复处理');
  }

  // ── ③ 投递失败 → 不标记 ──
  {
    fs.writeFileSync(paths.state, JSON.stringify({
      date: today, watches: 0, repliedIds: [],
      queue: [{ item_id: 'V2', title: 'T', kind: 'video', seen_at: today }],
    }));
    const duty = mkDuty({ sendResult: { ok: false, reason: '值班会话没拉起来' } });
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    await tick({ manual: true });
    const st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.deepEqual(st.repliedIds, []);
    assert.ok(logLines.at(-1).includes('投递失败'));
    ok('③ 投递失败不标记，留给下轮');
  }

  // ── ④ 回读失败（fiber 不可用）→ 不标记 ──
  {
    process.env.STUB_MODE = 'strings';         // 消息是非对象 ⇒ meTextSet 为 null
    presetCounter(0);
    fs.writeFileSync(paths.state, JSON.stringify({
      date: today, watches: 0, repliedIds: [],
      queue: [{ item_id: 'V3', title: 'T', kind: 'video', seen_at: today }],
    }));
    const duty = mkDuty();
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    await tick({ manual: true });
    delete process.env.STUB_MODE;
    const st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.deepEqual(st.repliedIds, []);
    assert.ok(logLines.some((l) => l.includes('无法回读确认')));
    ok('④ fiber 不可用时保守不标记');
  }

  // ── ⑤ 观看时段外不跑 ──
  {
    fs.writeFileSync(paths.config, JSON.stringify({
      owner: { nickname: '测试主人' },
      watch: { enabled: true, windows: [{ start: '03:00', end: '04:00' }] },
      pythonPath: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    }));
    const duty = mkDuty();
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    await tick({ manual: true });
    assert.equal(duty.sent.length, 0);
    assert.ok(logLines.at(-1).includes('观看时段'));
    ok('⑤ 时段外零消耗');
  }

  // ── ⑥ resolvePy 优先级 ──
  {
    const prev = process.env.DOUYIN_PYTHON;
    process.env.DOUYIN_PYTHON = 'C:/env/python.exe';
    assert.equal(resolvePy({ root: fakeRoot }), 'C:/env/python.exe');   // env 最优先
    delete process.env.DOUYIN_PYTHON;
    const venv = resolvePy({ root: path.resolve('.') });
    assert.match(venv, /[\\/]\.venv[\\/]/);                              // venv 次之
    if (prev !== undefined) process.env.DOUYIN_PYTHON = prev;
    ok('⑥ resolvePy env → venv → PATH');
  }

  // ── ⑦ inWatchWindow ──
  {
    assert.equal(inWatchWindow([{ start: '00:00', end: '24:00' }]), true);
    assert.equal(inWatchWindow(undefined), true);
    assert.equal(inWatchWindow([{ start: '03:00', end: '04:00' }],
      new Date(2026, 9, 26, 3, 30)), true);
    assert.equal(inWatchWindow([{ start: '03:00', end: '04:00' }],
      new Date(2026, 9, 26, 5, 0)), false);
    assert.equal(inWatchWindow([{ start: '22:00', end: '24:00' }],
      new Date(2026, 9, 26, 23, 0)), true);
    ok('⑦ 时段判定含 24:00 边界');
  }

  // ── ⑧ 登录失效 → 30 分钟冷却；手动 tick 可跳过；恢复后清空 ──
  {
    fs.writeFileSync(paths.config, JSON.stringify({
      owner: { nickname: '测试主人' },
      watch: { enabled: true, windows: [{ start: '00:00', end: '24:00' }] },
      pythonPath: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    }));
    fs.writeFileSync(paths.state, JSON.stringify({
      date: today, watches: 0, repliedIds: [], queue: [], loginFails: 0,
    }, null, 2));
    const duty = mkDuty();
    const tick = createWhaleTick({ log, dutyAgent: duty, root: fakeRoot, home });
    const calls = () => Number(fs.readFileSync(process.env.STUB_COUNT, 'utf8') || 0);

    process.env.STUB_MODE = 'need_login';
    presetCounter(0);
    await tick();                                  // 非手动 → NEED_LOGIN → 写冷却
    let st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.ok(Date.parse(st.loginBlockedUntil) > Date.now());
    const afterFirst = calls();
    await tick();                                  // 冷却中 → 不再起浏览器
    assert.equal(calls(), afterFirst);
    await tick({ manual: true });                  // 手动跳过冷却
    assert.equal(calls(), afterFirst + 1);

    // 恢复登录后手动成功一轮 → 冷却清空
    delete process.env.STUB_MODE;
    presetCounter(0);
    await tick({ manual: true });
    st = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    assert.equal(st.loginBlockedUntil, '');
    ok('⑧ 登录失效冷却 30 分钟，手动可跳过，成功即清空');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('\n=== 失败，本轮 tick 日志 ===');
  logLines.forEach((l) => console.error(' LOG:', l.slice(0, 300)));
  throw e;
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.STUB_OUT;
}
