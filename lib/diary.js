/**
 * lib/diary.js —— 大肥鱼的两本日记（公开反应 / 私人偏好校准）。
 *
 * 文件一直由调度器路径（ZCode agent 直接编辑）写在 DSH home：
 *   ~/.dsh/whale-diary.md          公开：一句反应
 *   ~/.dsh/whale-diary-private.md  私人：偏好校准
 * v1.10.0 起值班大脑也能写——通过 douyin_diary_read / douyin_diary_write
 * 工具走本模块，路径固定、不接受任何外部输入的路径。
 *
 * 小节格式（与调度器侧一致，按时间追加）：
 *   ## 2026-11-07 · 21:30（观看轮 | 值班轮）
 *   <正文>
 */

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './whale_state.js';

export const DIARY_FILES = {
  public: 'whale-diary.md',
  private: 'whale-diary-private.md',
};

/** 单条上限：日记是一句话，超长说明模型在往里塞整篇，直接拒。 */
export const DIARY_MAX_WRITE_LEN = 300;
/** read 时每个小节的截断长度（保护模型上下文） */
const SECTION_MAX_CHARS = 900;

const HEADING_RE = /^## (\d{4}-\d{2}-\d{2})/;

export function diaryPath(kind, home = dshHome()) {
  const file = DIARY_FILES[kind];
  if (!file) throw new Error(`unknown diary kind: ${kind}`);
  return path.join(home, file);
}

/** 本地日期（与 scheduler/state.mjs 的 today 同口径） */
const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');

/** 把整份日记按 `## 日期` 切成小节（保持原文顺序） */
function splitSections(raw) {
  const sections = [];
  let cur = null;
  for (const line of String(raw || '').split('\n')) {
    if (HEADING_RE.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({
    heading: s.heading,
    body: s.body.join('\n').trim().slice(0, SECTION_MAX_CHARS),
  }));
}

/** 读日记：今天的全部小节 + 最近 N 个小节（给模型续风格、防重复）。 */
export function readDiary({ kind, home = dshHome(), sections = 2 } = {}) {
  const file = diaryPath(kind, home);
  let raw = '';
  let exists = false;
  try {
    raw = fs.readFileSync(file, 'utf8');
    exists = true;
  } catch {
    raw = '';
  }
  const all = splitSections(raw);
  const today = localDay();
  const todaySections = all.filter((s) => s.heading.startsWith(`## ${today}`));
  return {
    path: file,
    exists,
    today,
    total_sections: all.length,
    today_sections: todaySections,
    recent: all.slice(-Math.max(1, Math.min(3, sections))),
  };
}

/** 追加一条： always 新开一节（## 当天 · HH:MM（tag）），与调度器侧的按轮分节一致。 */
export function appendDiary({ kind, home = dshHome(), text, tag = '值班轮' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('diary text 不能为空');
  if (body.length > DIARY_MAX_WRITE_LEN) {
    throw new Error(`diary text 超过 ${DIARY_MAX_WRITE_LEN} 字上限（一句话就好）`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) {
    throw new Error('diary text 含控制字符');
  }
  const file = diaryPath(kind, home);
  const stamp = new Date();
  const heading = `## ${localDay(stamp)} · ${stamp.toTimeString().slice(0, 5)}（${tag}）`;
  const block = `\n${heading}\n${body}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, block, 'utf8');
  return { path: file, heading, bytes: Buffer.byteLength(block, 'utf8'), len: body.length };
}
