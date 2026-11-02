// 自訂狀態：模型自己改 bot 在 Discord 成員列表顯示的一句話。
//
// 只做純文字與檔案存取，不 import discord.js，方便離線測試。
// 狀態會跨伺服器顯示，呼叫端要先過敏感資訊閘門再存。
import fs from 'node:fs';
import path from 'node:path';
import { defang, isVisible } from './discord-batch.mjs';

export const STATUS_VERSION = 1;
export const STATUS_MAX_CHARS = 128;

/** 整理成一句：defang、控制字元換空白、空白壓成一個、去頭尾。不截斷，長度由 parseStatusText 判斷。 */
export function cleanStatusText(value) {
  return defang(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 工具與讀檔共用的入口：回傳要套用的文字，格式不對就丟錯（呼叫端轉成 400）。
 * 空字串或只有空白 = 清除；只有看不見的字元、非字串、超過 128 字都擋。
 */
export function parseStatusText(value) {
  if (typeof value !== 'string') throw new TypeError('text 必須是字串');
  const text = cleanStatusText(value);
  if (value.trim() && !isVisible(text)) throw new TypeError('text 只有看不見的字元');
  if (text.length > STATUS_MAX_CHARS) throw new TypeError(`text 最多 ${STATUS_MAX_CHARS} 字`);
  return text;
}

/** 壞檔、舊版或不認得的格式都當作沒有狀態；讀出來也再過一次同樣的規則。 */
export function loadStatusFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  try {
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return doc?.version === STATUS_VERSION && typeof doc.text === 'string' ? parseStatusText(doc.text) : '';
  } catch {
    return '';
  }
}

export function saveStatusFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: STATUS_VERSION, text })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已經不在 */ }
    throw error;
  }
}
