// 回合決策紀錄：每個 Discord 批次有結果時，append 一行到 state/discord-turns.jsonl。
//
// 只記判斷結果與計數，不記訊息原文或名字。寫入失敗只留 log，不能影響聊天。
import fs from 'node:fs';
import path from 'node:path';
import { isBotNamed, isMediaOnlyBatch, triggerUsers } from './discord-batch.mjs';

export const TURN_DECISIONS = Object.freeze(['sent', 'silent', 'skipped']);
export const TURN_SKIP_REASONS = Object.freeze([
  'yield', 'media-only', 'quiet', 'ignored', 'denied', 'empty', 'gate', 'ask', 'system',
]);
export const TURN_MAX_BYTES = 20 * 1024 * 1024;

const DECISIONS = new Set(TURN_DECISIONS);
const REASONS = new Set(TURN_SKIP_REASONS);

const nonNegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const stringList = (value) => [...new Set(
  (Array.isArray(value) ? value : []).map((item) => String(item ?? '')).filter(Boolean),
)];

/** 一批 → 一筆紀錄。job 只在投遞前拿得到；回合結束與單則訊息用 meta 帶同樣的欄位。 */
export function turnRecord({
  key,
  job = null,
  meta = {},
  decision,
  reason = '',
  turn = null,
  sent = 0,
  tools = [],
  tokens = null,
  ttftMs = null,
  model = null,
  users,
  now = Date.now,
} = {}) {
  const entries = job?.entries ?? [];
  const timestamp = typeof now === 'function' ? now() : now;
  return {
    at: new Date(timestamp).toISOString(),
    key,
    turn,
    decision,
    reason,
    direct: meta.direct ?? Boolean(job?.direct),
    named: meta.named ?? entries.some((entry) => isBotNamed(entry.rawText)),
    chatty: Boolean(meta.chatty),
    mediaOnly: meta.mediaOnly ?? isMediaOnlyBatch(entries),
    yielded: Boolean(meta.yielded),
    merged: Math.max(0, Math.round(Number(meta.merged ?? job?.merged) || 0)),
    users: stringList(users ?? triggerUsers(entries).map((user) => user.userId)),
    sent: Math.max(0, Math.round(Number(sent) || 0)),
    tools: stringList(tools),
    tokens: nonNegative(tokens),
    ttftMs: nonNegative(ttftMs),
    model: typeof model === 'string' && model ? model : null,
  };
}

/** 檢查並固定欄位；decision／reason 不合法就回 null，呼叫端不寫。 */
export function normalizeTurnRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const decision = String(record.decision ?? '');
  if (!DECISIONS.has(decision)) return null;
  const reason = String(record.reason ?? '');
  if (decision === 'skipped') {
    if (!REASONS.has(reason)) return null;
  } else if (reason) {
    return null;
  }
  const key = String(record.key ?? '');
  const at = String(record.at ?? '');
  if (!key || !at) return null;
  const turn = Number.isInteger(record.turn) && record.turn >= 0 ? record.turn : null;
  return {
    at,
    key,
    turn,
    decision,
    reason,
    direct: Boolean(record.direct),
    named: Boolean(record.named),
    chatty: Boolean(record.chatty),
    mediaOnly: Boolean(record.mediaOnly),
    yielded: Boolean(record.yielded),
    merged: Math.max(0, Math.round(Number(record.merged) || 0)),
    users: stringList(record.users),
    sent: Math.max(0, Math.round(Number(record.sent) || 0)),
    tools: stringList(record.tools),
    tokens: nonNegative(record.tokens),
    ttftMs: nonNegative(record.ttftMs),
    model: typeof record.model === 'string' && record.model ? record.model : null,
  };
}

/**
 * 寫入器：append、20 MB 輪替成 `.1`，只留一份舊檔。
 * @param {object} options
 * @param {string} options.file
 * @param {number} [options.maxBytes]
 * @param {(msg: string, err?: unknown) => void} [options.log]
 */
export function createTurnLog({ file, maxBytes = TURN_MAX_BYTES, log = () => {} } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createTurnLog: file is required');

  // shortcut: 每次寫入都 stat 一次，比自己維護檔案大小簡單，20 MB 的規模看不出成本。
  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    const previous = `${file}.1`;
    try {
      fs.rmSync(previous, { force: true });
      fs.renameSync(file, previous);
    } catch (error) {
      // 輪替失敗（Windows 上檔案被開著）不能連帶丟掉這一行。
      log(`回合紀錄：輪替失敗，先繼續寫 ${error?.message ?? error}`);
    }
  }

  function write(record) {
    const line = normalizeTurnRecord(record);
    if (!line) {
      log('回合紀錄：欄位不合法，略過');
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (error) {
      log(`回合紀錄：寫入失敗 ${error?.message ?? error}`);
      return false;
    }
  }

  return { file, write };
}
