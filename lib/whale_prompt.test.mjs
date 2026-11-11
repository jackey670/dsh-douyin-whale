/**
 * lib/whale_prompt.test.mjs —— 共享任务提示词的两种模式。
 *
 * tools：值班大脑（无 shell/文件工具，全走插件工具）
 * shell：独立调度器（Bash/Read + 日记）
 *
 * 运行：node lib/whale_prompt.test.mjs
 */
import assert from 'node:assert/strict';

import { buildWhaleTaskMessage, buildProactiveShareMessage } from './whale_prompt.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const build = (mode, item, extra = {}) => buildWhaleTaskMessage({
  mode, item, ownerNick: '主人', pendingCount: 1, mem: null,
  root: 'C:/plugin', home: 'C:/dsh', cfg: { persona: { name: '大肥鱼' } }, ...extra,
});

try {
  // ── tools：文字 ──
  {
    const s = build('tools', { kind: 'text', text: '在吗' });
    assert.match(s, /【值班任务】/);
    assert.match(s, /douyin_dm_send 工具发送：\{"to": "主人"/);
    assert.doesNotMatch(s, /node "C:\/plugin\/douyin\.mjs"/);
    assert.doesNotMatch(s, /写日记/);
    ok('tools 文字走 douyin_dm_send');
  }

  // ── shell：文字（含表情命令与发完确认）──
  {
    const s = build('shell', { kind: 'text', text: '在吗' });
    assert.match(s, /【抖音私信】/);
    assert.match(s, /node "C:\/plugin\/douyin\.mjs" send --to "主人"/);
    assert.match(s, /emoji send --to "主人" --label/);
    assert.doesNotMatch(s, /douyin_dm_send/);
    ok('shell 文字走 node douyin.mjs send');
  }

  // ── tools：视频（帧图 + 日记工具 + 私信）──
  {
    const s = build('tools', { kind: 'video', item_id: 'V1', title: '标题' });
    assert.match(s, /内容 ID：V1/);
    assert.match(s, /douyin_frames \{"aweme_id": "V1", "n": 5\}/);
    assert.match(s, /douyin_diary_write \{"kind": "public"/);
    assert.match(s, /douyin_diary_write \{"kind": "private"/);
    assert.match(s, /douyin_dm_send/);
    assert.doesNotMatch(s, /frames V1 --n 6/);
    assert.doesNotMatch(s, /日记值班环境写不了/);
    ok('tools 视频走 douyin_frames + 日记工具');
  }

  // ── shell：视频（frames 命令 + Read + 日记）──
  {
    const s = build('shell', { kind: 'video', item_id: 'V1', title: '标题' });
    assert.match(s, /【抖音观看】/);
    assert.match(s, /内容 ID：V1/);
    assert.match(s, /frames V1 --n 6/);
    assert.match(s, /用 \*\*Read\*\* 打开/);
    assert.match(s, /whale-diary\.md/);
    assert.doesNotMatch(s, /douyin_frames/);
    ok('shell 视频走 frames + Read + 日记');
  }

  // ── sticker：两种模式都要「先看图」──
  {
    const t = build('tools', { kind: 'sticker', image_path: 'C:/img/a.webp' });
    assert.match(t, /douyin_sticker_look/);
    assert.match(t, /douyin_meme_pick/);
    assert.match(t, /image 是硬性要求/);
    const s = build('shell', { kind: 'sticker', image_path: 'C:/img/a.webp' });
    assert.match(s, /用 \*\*Read\*\* 打开/);
    assert.match(s, /meme pick/);
    assert.match(s, /--image/);
    assert.doesNotMatch(s, /douyin_sticker_look/);
    ok('sticker 两种模式都先看图再回敬');
  }

  // ── note：两种模式都声明「拿不到画面」──
  {
    const t = build('tools', { kind: 'note', title: '标题', text: '正文' });
    const s = build('shell', { kind: 'note', title: '标题', text: '正文' });
    assert.match(t, /拿不到画面/);
    assert.match(s, /拿不到画面/);
    assert.match(t, /douyin_dm_send/);
    assert.match(s, /send --to "主人"/);
    ok('note 两种模式行为一致');
  }

  // ── 主动分享：tools 用插件工具，shell 用命令 ──
  {
    const t = buildProactiveShareMessage({ mode: 'tools', ownerNick: '主人', cfg: {}, root: 'C:/plugin' });
    assert.match(t, /douyin_hot/);
    assert.match(t, /douyin_dm_share \{"aweme_id"/);
    assert.doesNotMatch(t, /node "C:\/plugin\/douyin\.mjs"/);
    const s = buildProactiveShareMessage({ mode: 'shell', ownerNick: '主人', cfg: {}, root: 'C:/plugin' });
    assert.match(s, /node "C:\/plugin\/douyin\.mjs" trending/);
    assert.match(s, /share --aweme "<视频ID>" --to "主人" --send/);
    assert.match(s, /不用写日记/);
    ok('主动分享提示词两种模式');
  }

  // ── 人设与心情：改了下一轮就生效 ──
  {
    const mood = { enabled: true, sleeping: false, energy: 70, social: 30, boredom: 20 };
    const t = build('tools', { kind: 'text', text: '在吗' }, {
      cfg: { persona: { name: '大肥鱼', ownerTitle: '主人', text: '性格：好奇' } },
      mood,
    });
    assert.match(t, /［人设］性格：好奇/);
    assert.match(t, /［现在的状态］精神/);
    assert.match(t, /不要报数值/);
    const s = buildProactiveShareMessage({
      mode: 'shell', ownerNick: '主人', root: 'C:/plugin',
      cfg: { persona: { text: '喜欢白饭' } }, mood,
    });
    assert.match(s, /［人设］喜欢白饭/);
    assert.match(s, /［现在的状态］/);
    const off = buildProactiveShareMessage({
      mode: 'shell', ownerNick: '主人', root: 'C:/plugin', cfg: {},
      mood: { ...mood, enabled: false },
    });
    assert.doesNotMatch(off, /［现在的状态］/);
    ok('人设与心情注入（关闭时不注入）');
  }

  // ── 长期记忆块：挂在 mem.layers 上 ──
  {
    const s = build('tools', { kind: 'text', text: '在吗' }, {
      mem: { layers: '【主人档案】\n・喜欢白饭' },
    });
    assert.match(s, /【长期记忆】/);
    assert.match(s, /喜欢白饭/);
    ok('长期记忆块注入');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('FAILED');
  throw e;
}
