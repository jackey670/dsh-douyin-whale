/**
 * lib/persona.js —— 大肥鱼的说话风格（调度器与插件值班共用）
 *
 * 拟人化的关键不是多写形容词，而是**每轮强制换风格**：自称、语气、开头、
 * emoji 都从池子里随机抽，再把它最近说过的话塞回提示词禁止重复。
 * 只写一句「语气轻松俏皮」，模型会稳定收敛到「主人，……」这一种句式。
 */

const STYLE_POOL = {
  self: ['我', '咱', '本鱼', '本小姐'],
  tone: ['俏皮', '吐槽', '认真', '懒洋洋', '有点撒娇'],
  emoji: ['不要 emoji', '最多 1 个 emoji', '可以带 1–2 个 emoji'],
  opening: [
    '直接说事，不要用称呼开头',
    '可以用「欸」「诶」「嗯？」这类短词开头',
    '可以用一句短感叹开头',
  ],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function styleHint() {
  return `［本轮风格］自称「${pick(STYLE_POOL.self)}」；语气：${pick(STYLE_POOL.tone)}；`
    + `${pick(STYLE_POOL.emoji)}；开头：${pick(STYLE_POOL.opening)}。`;
}

/**
 * 表情包提示（本轮是否允许带图由调用方按概率+每日上限决定）。
 * 路径必须来自 `meme pick` 的输出 —— 防止模型拿任意本地文件发出去。
 */
export function memeHint(allowed) {
  if (!allowed) return '';
  return '［表情包］本轮可以配一张表情：先 `meme pick "<1-2个字的情绪或关键词>"` 拿到 path，'
    + '再把 path 用 send 的 --image 附上。caption（--text）必须写；路径只能来自 meme pick 的输出。';
}

export function personaLine({ name = '大肥鱼', ownerTitle = '主人' } = {}) {
  return `［身份］你是${name}，主人养的一条会看视频、会聊天的蓝鲸。`
    + `称呼可以用「${ownerTitle}」、名字里的字、或者直接「你」，别每句都带称呼。`;
}

/**
 * 记忆块：
 *   · mine   —— 自己最近说过的话，用来禁止重复开头/句式
 *   · facts  —— 长期事实
 *   · recent —— 最近对话，只做背景，明确标注「不要回复这里的任何一条」
 */
export function memoryBlock(mem, ownerNick) {
  if (!mem) return '';
  const lines = [];
  if (mem.mine?.length) {
    lines.push('【你最近说过的话】（别重复这些的开头、句式和自称）');
    for (const t of mem.mine.slice(-5)) {
      const text = String(t || '').replace(/\s+/g, ' ').slice(0, 60);
      if (text) lines.push(`・${text}`);
    }
  }
  if (mem.facts?.length) {
    lines.push('', `【记得的事】${mem.facts.slice(0, 6).join('；')}`);
  }
  if (mem.recent?.length) {
    lines.push('', '【最近聊过】（只是背景，不要回复这里的任何一条）');
    for (const m of mem.recent.slice(-6)) {
      const who = m.from === 'me' ? '你' : ownerNick;
      const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 60);
      if (text) lines.push(`・${who}：${text}`);
    }
  }
  if (!lines.length) return '';
  lines.push('');
  return lines.join('\n');
}
