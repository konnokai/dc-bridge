// 智能體 API：MCP（src/mcp-discord.js）的所有 Discord 動作（說話、貼圖、reaction、
// 查表情、讀歷史、查成員）都從這裡進橋接。
//
// 為什麼另外開一個 listener，而不是掛在控制台上：
//   控制台綁的是「人」的管理面（可以設成 LAN），模型發訊息是「程式」在動，只需要本機。
//   兩者共用一個埠，等於把發送面一起放上網路，權限也混在一起。這裡固定綁 127.0.0.1
//   的隨機埠，只開 POST /hello 與各工具的 POST 路徑。
//
// 為什麼用檔案傳端點：MCP server 是 DSH 拉起的另一個行程，兩邊唯一的共同點是同一個
// state 目錄。橋接重啟後埠會變，所以 MCP 每次呼叫都重讀這個檔。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { findSensitive } from './discord-security.mjs';

/** 單次工具呼叫的內容上限；sendLong 會再按 Discord 的 2000 字上限切段。 */
export const AGENT_MAX_CONTENT = 8_000;

/** 一輪最多 5 則：夠模型分幾句講完，又洗不了版。 */
export const SEND_PER_TURN_LIMIT = 5;

/** reaction 一輪最多 3 個：真人不會一口氣對一串訊息按表情。 */
export const REACT_PER_TURN_LIMIT = 3;

/** 收回 reaction 一輪最多 3 個：跟按的分開算，按錯想重按不會被自己卡住。 */
export const UNREACT_PER_TURN_LIMIT = 3;

/** 收回一輪最多 2 則：被 prompt injection 也洗不掉自己一整串發言。 */
export const DELETE_PER_TURN_LIMIT = 2;

/** read_history + search_history 一輪合計最多 3 次：每次都可能掃幾百則，連翻會卡住同一個頻道。 */
export const HISTORY_PER_TURN_LIMIT = 3;

/** 每個頻道記住最近幾則「模型自己用工具送出的」訊息；改和收回只認這些。 */
const OWNED_PER_KEY = 200;

const POLL_QUESTION_MAX = 300;
const POLL_ANSWER_MAX = 55;
const POLL_HOURS_MAX = 168;

const statusError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// 會話令牌要讓模型照抄：base64url 大小寫混雜，模型會把 W 抄成 V。
// 只用小寫和數字，拿掉 0/o、1/l/i、v/w 這幾組長得像的字。10 字仍有約 2^48 種，
// 而且敏感資訊閘門只比對 8 字以上的令牌，不能再短。
const SESSION_TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuxyz';
const SESSION_TOKEN_LENGTH = 10;

// 6 字（約 5.9 億種）：一個頻道 500 則裡撞號的機會約萬分之二。撞號時後登記的那則改用更長的編號；
// 只有撞號又剛好在重啟後以相反順序登記時，舊編號才會指到另一則。
// shortcut: 撞號 + 重啟的極端情況沒處理，真的遇到再改成持久化編號表。
const MESSAGE_REF_LENGTH = 6;
const MESSAGE_REFS_PER_KEY = 500;

/**
 * 訊息編號：prompt 裡每則訊息前面的 `#xxxxx`，模型用它指定要回覆／按 reaction 的訊息。
 *
 * 編號由 Discord 訊息 id 雜湊出來，不用流水號：DSH 會話撐過橋接重啟，模型還記得舊編號。
 * 流水號重啟後從頭數，舊的 #3 會指到另一則訊息；雜湊則同一則訊息永遠同一個編號，
 * 重啟後查不到只會回「找不到」，不會指錯。
 */
export function messageRefOf(messageId, length = MESSAGE_REF_LENGTH) {
  const digest = createHash('sha256').update(String(messageId)).digest();
  let out = '';
  for (let i = 0; i < length; i += 1) out += SESSION_TOKEN_ALPHABET[digest[i] % SESSION_TOKEN_ALPHABET.length];
  return out;
}

/** 每個會話 key 各自一張編號表：令牌只能查到自己頻道的訊息。 */
export function createMessageRefs({ perKey = MESSAGE_REFS_PER_KEY } = {}) {
  const tables = new Map(); // key -> Map(ref -> messageId)，插入順序就是新舊順序

  function register(key, messageId) {
    const id = String(messageId ?? '');
    if (!id) return '';
    let table = tables.get(key);
    if (!table) { table = new Map(); tables.set(key, table); }
    // 撞號就加長，直到沒撞或撞到的就是自己。
    let ref = messageRefOf(id);
    for (let length = MESSAGE_REF_LENGTH + 1; table.has(ref) && table.get(ref) !== id; length += 1) {
      ref = messageRefOf(id, length);
    }
    table.delete(ref);
    table.set(ref, id);
    while (table.size > perKey) table.delete(table.keys().next().value);
    return ref;
  }

  function lookup(key, ref) {
    const normalized = String(ref ?? '').trim().replace(/^#/, '').toLowerCase();
    return tables.get(key)?.get(normalized) ?? null;
  }

  return { register, lookup };
}

/**
 * 工具回端：MCP 的每個工具送進來之後，決定能不能做、對哪個頻道做。
 *
 * 工具只收 token，不收 key：令牌綁定一個會話，模型就算被騙也指定不了別的頻道。
 * 白名單、敏感資訊閘門、每輪上限都在這裡判斷。MCP server 是 DSH 拉起的另一個行程，
 * 不該持有這些判斷。唯讀工具（查表情、讀歷史、查成員）也走 resolve()，同一道門。
 *
 * @param options.sessions        key -> sessionId（橋接的會話表，會被橋接原地改）
 * @param options.reverse         sessionId -> key
 * @param options.resolveChannel  async key => Discord channel
 * @param options.isAllowed       (key, channel) => boolean
 * @param options.secrets         () => 已知令牌清單（會話令牌另外自動加入）
 * @param options.blockSensitive  () => boolean
 * @param options.refs            createMessageRefs()：送出的訊息登記成 #編號，改／收回時查回 id
 * @param options.deliver         async (key, { content, replyTo, sticker, file }) => 送出的 Discord 訊息 id 陣列
 * @param options.deliverReaction async (key, { message, emoji }) => void
 * @param options.deliverUnreact  async (key, { message, emoji }) => void
 * @param options.deliverEdit     async (key, { id, content }) => void
 * @param options.deliverDelete   async (key, { id }) => void
 * @param options.deliverPoll     async (key, { question, answers, hours, multi }) => 投票訊息的 id
 */
export function createAgentSender({
  sessions,
  reverse,
  resolveChannel,
  isAllowed,
  secrets = () => [],
  blockSensitive = () => true,
  refs = createMessageRefs(),
  deliver,
  deliverReaction = async () => {},
  deliverUnreact = async () => {},
  deliverEdit = async () => {},
  deliverDelete = async () => {},
  deliverPoll = async () => '',
  limit = SEND_PER_TURN_LIMIT,
  reactLimit = REACT_PER_TURN_LIMIT,
  unreactLimit = UNREACT_PER_TURN_LIMIT,
}) {
  const tokens = new Map(); // sessionId -> 會話令牌（只在記憶體，橋接重啟就換）
  const muted = new Map(); // key -> 後台提問的 token：只有持有者能解除，避免舊收尾解掉新提問
  const chains = new Map(); // key -> 串行化（同一輪的多個 tool call 不搶順序）
  const sentCounts = new Map(); // key -> 這一輪已經送出幾則
  const usedCounts = new Map(); // key -> { react, unreact, remove, history }：這一輪各用了幾次
  const attempted = new Set(); // key -> 這一輪有沒有試過呼叫發送工具
  const owned = new Map(); // key -> Set(訊息 id)：模型自己用工具送出的，插入順序就是新舊順序
  const usedLimits = { react: reactLimit, unreact: unreactLimit, remove: DELETE_PER_TURN_LIMIT, history: HISTORY_PER_TURN_LIMIT };

  function tokenFor(sessionId) {
    let value = tokens.get(sessionId);
    if (!value) {
      value = Array.from({ length: SESSION_TOKEN_LENGTH },
        () => SESSION_TOKEN_ALPHABET[randomInt(SESSION_TOKEN_ALPHABET.length)]).join('');
      tokens.set(sessionId, value);
    }
    return value;
  }

  /** 令牌數量等於會話數（很少），逐一定長比對即可。 */
  function sessionForToken(given) {
    // 模型常多帶空白或改成大寫，這些不算抄錯。
    const g = Buffer.from(String(given ?? '').trim().toLowerCase(), 'utf8');
    if (g.length === 0) return null;
    for (const [sessionId, token] of tokens) {
      const t = Buffer.from(token, 'utf8');
      if (t.length === g.length && timingSafeEqual(t, g)) return sessionId;
    }
    return null;
  }

  const alive = (key, sessionId) => sessions[key] === sessionId && reverse.get(sessionId) === key;

  /** 令牌 → 會話與頻道。每個工具都先過這一關。 */
  async function resolve(token) {
    const given = String(token ?? '').trim();
    const sessionId = sessionForToken(given);
    // 令牌由 DSH 外掛自動帶入（plugins/dc-agent-presets/dc-session-token.mjs），
    // 模型看不到也不該自己填；這裡的訊息要讓它去回報，不是叫它去抄。
    if (!sessionId) {
      if (!given) throw statusError('沒有帶會話令牌（正常由 DSH 外掛自動帶入）：這批送不出去，請回報管理員', 403);
      throw statusError('會話令牌過期或不是最新的：外掛會自動重查一次；還是不行就回報管理員，不要自己填 token', 403);
    }
    const key = reverse.get(sessionId);
    if (!key || !alive(key, sessionId)) throw statusError('這個會話已經結束，不送出', 403);
    // 後台提問（/ask）要獨佔這一輪：模型只能輸出文字，任何工具動作都不該公開。
    if (muted.has(key)) throw statusError('這個會話正在後台提問：這一輪所有 Discord 工具都不能用，直接輸出文字回答', 403);
    const kind = key.split(':')[0];
    if (kind !== 'ch' && kind !== 'dm') throw statusError('會話 key 格式不對', 400);

    const channel = await resolveChannel(key);
    if (!isAllowed(key, channel)) throw statusError(`頻道 ${key} 不在白名單內，不送出`, 403);
    return { sessionId, key, kind, channel };
  }

  /** 用存著的令牌比對：模型傳來的可能是大寫版，拿它比對會漏掉內容裡的小寫原文。 */
  function checkSensitive(sessionId, text) {
    const hit = blockSensitive() ? findSensitive(text, [...secrets(), tokens.get(sessionId)]) : null;
    if (hit) throw statusError(`內容命中敏感資訊閘門（${hit}），已攔截`, 400);
  }

  /** 會出現在頻道裡的動作（送出、投票、修改）排同一條隊，共用「一輪 5 則」。 */
  function visible(key, sessionId, action) {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      // 排隊期間可能被 /reset：已經排隊的訊息不能送進新會話。
      if (!alive(key, sessionId)) throw statusError('這個會話已經結束，不送出', 403);
      // 上限放在排隊後才檢查：同一輪的並行 tool call 才不會一起鑽過去。
      if ((sentCounts.get(key) ?? 0) >= limit) {
        throw statusError(`這一輪已經送出 ${limit} 則，不再送出`, 429);
      }
      const result = await action();
      sentCounts.set(key, (sentCounts.get(key) ?? 0) + 1);
      return result;
    });
    chains.set(key, next);
    const cleanup = () => { if (chains.get(key) === next) chains.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }

  /** 送出的訊息記成「自己的」並登記 #編號，回傳編號給模型。 */
  function own(key, ids) {
    let set = owned.get(key);
    if (!set) { set = new Set(); owned.set(key, set); }
    const out = [];
    for (const id of (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean)) {
      set.add(id);
      while (set.size > OWNED_PER_KEY) set.delete(set.values().next().value);
      out.push(refs.register(key, id));
    }
    return out;
  }

  /** #編號 → 自己送出的訊息 id；查不到或不是自己的就拒絕。 */
  function ownedId(key, message, verb) {
    const id = refs.lookup(key, message);
    if (!id) throw statusError(`找不到訊息 ${message}：用你送出後回傳的 #編號`, 404);
    if (!owned.get(key)?.has(id)) throw statusError(`只能${verb}你自己用工具送出的訊息（送出後回傳的那個 #編號）`, 403);
    return id;
  }

  /** 這則訊息是不是模型自己用工具送出的；是的話回它的會話 key，否則 null。 */
  function ownedKey(messageId) {
    const id = String(messageId ?? '');
    if (!id) return null;
    for (const [key, set] of owned) {
      if (set.has(id)) return key;
    }
    return null;
  }

  /** 先佔名額再 await：並行呼叫才不會一起鑽過上限。失敗就退回名額。 */
  async function withQuota(key, kind, label, action) {
    const counts = usedCounts.get(key) ?? { react: 0, unreact: 0, remove: 0, history: 0 };
    usedCounts.set(key, counts);
    if (counts[kind] >= usedLimits[kind]) throw statusError(`這一輪已經${label} ${usedLimits[kind]} 次，不能再${label}`, 429);
    counts[kind] += 1;
    try {
      return await action();
    } catch (error) {
      counts[kind] -= 1;
      throw error;
    }
  }

  const channelName = (kind, channel, key) => (kind === 'dm' ? '私聊' : (channel?.name ?? key));

  async function send({ token, content = '', replyTo = '', sticker = '', file = '' }) {
    if (typeof content !== 'string' || content.length > AGENT_MAX_CONTENT) {
      throw statusError(`content 超過 ${AGENT_MAX_CONTENT} 字`, 400);
    }
    if (!content.trim() && !sticker && !file) throw statusError('content 是空的', 400);
    const { sessionId, key, kind, channel } = await resolve(token);
    // 模型偶爾把回覆目標塞進 content（其他工具的參數叫 message，send_message 沒有）。
    // 只送一個查得到的 #編號 一定是放錯位置：擋下來，讓它同一輪自己改。
    if (/^#[a-z0-9]{6,}$/i.test(content.trim()) && refs.lookup(key, content.trim())) {
      throw statusError('content 只有一個 #編號：正文放 content，回覆目標放 reply_to；send_message 沒有 message 參數', 400);
    }
    checkSensitive(sessionId, content);
    const ids = await visible(key, sessionId, () => deliver(key, { content, replyTo, sticker, file }));
    return { key, channel: channelName(kind, channel, key), refs: own(key, ids ?? []) };
  }

  async function edit({ token, message, content = '' }) {
    if (typeof content !== 'string' || content.length > AGENT_MAX_CONTENT) {
      throw statusError(`content 超過 ${AGENT_MAX_CONTENT} 字`, 400);
    }
    if (!content.trim()) throw statusError('content 是空的：要收回就用 delete_message', 400);
    const { sessionId, key } = await resolve(token);
    const id = ownedId(key, message, '改');
    checkSensitive(sessionId, content);
    await visible(key, sessionId, () => deliverEdit(key, { id, content }));
    return { key };
  }

  async function remove({ token, message }) {
    const { key } = await resolve(token);
    const id = ownedId(key, message, '收回');
    await withQuota(key, 'remove', '收回', () => deliverDelete(key, { id }));
    owned.get(key)?.delete(id);
    return { key };
  }

  async function poll({ token, question, answers, hours, multi }) {
    const text = String(question ?? '').trim();
    if (!text) throw statusError('投票要有題目', 400);
    if (text.length > POLL_QUESTION_MAX) throw statusError(`題目最多 ${POLL_QUESTION_MAX} 字`, 400);
    const options = [...new Set((Array.isArray(answers) ? answers : []).map((a) => String(a ?? '').trim()).filter(Boolean))];
    if (options.some((a) => a.length > POLL_ANSWER_MAX)) throw statusError(`每個選項最多 ${POLL_ANSWER_MAX} 字`, 400);
    if (options.length < 2 || options.length > 10) throw statusError('選項要 2~10 個（重複的與空的不算）', 400);
    const duration = Math.min(POLL_HOURS_MAX, Math.max(1, Math.round(Number(hours) || 24)));
    const { sessionId, key, kind, channel } = await resolve(token);
    checkSensitive(sessionId, [text, ...options].join('\n'));
    const id = await visible(key, sessionId, () => deliverPoll(key, { question: text, answers: options, hours: duration, multi: Boolean(multi) }));
    return { key, channel: channelName(kind, channel, key), refs: own(key, id) };
  }

  async function react({ token, message, emoji }) {
    const { key } = await resolve(token);
    await withQuota(key, 'react', '按 reaction', () => deliverReaction(key, { message, emoji }));
    return { key };
  }

  async function unreact({ token, message, emoji }) {
    const { key } = await resolve(token);
    await withQuota(key, 'unreact', '收回 reaction', () => deliverUnreact(key, { message, emoji }));
    return { key };
  }

  /** read_history／search_history 的門：同一輪合計最多 3 次；參數錯或 Discord 出錯就退回名額。 */
  async function history(token, scan) {
    const resolved = await resolve(token);
    return withQuota(resolved.key, 'history', '翻歷史紀錄', () => scan(resolved));
  }

  const clearKey = (key) => { sentCounts.delete(key); usedCounts.delete(key); attempted.delete(key); };

  return {
    tokenFor,
    /** DSH 外掛用：只有還活著的會話才發令牌（不會因為亂給 sessionId 就生出新的）。 */
    tokenIfLive: (sessionId) => {
      const key = reverse.get(sessionId);
      return key && sessions[key] === sessionId ? tokenFor(sessionId) : null;
    },
    resolve,
    checkSensitive,
    send,
    edit,
    remove,
    poll,
    react,
    unreact,
    history,
    ownedKey,
    /** /reset：令牌作廢。排隊中的發送由 alive() 擋掉。 */
    forget: (sessionId) => { tokens.delete(sessionId); },
    /** /reset：舊會話送出的訊息不能再改／收回，也不要再回報 reaction。 */
    forgetKey: (key) => { owned.delete(key); muted.delete(key); },
    /** 後台提問：暫停這一輪的工具動作；token 要比對才解得住。 */
    setMuted: (key, token) => { if (token) muted.set(key, token); },
    clearMuted: (key, token) => { if (muted.get(key) === token) muted.delete(key); },
    startTurn: clearKey,
    noteAttempt: (key) => { attempted.add(key); },
    /** 回合結束：回傳這一輪送了幾則、按了幾個 reaction、收回幾則、有沒有試過呼叫工具，並歸零。 */
    finishTurn: (key) => {
      const used = usedCounts.get(key);
      const result = {
        sent: sentCounts.get(key) ?? 0,
        reacted: used?.react ?? 0,
        unreacted: used?.unreact ?? 0,
        removed: used?.remove ?? 0,
        attempted: attempted.has(key),
      };
      clearKey(key);
      return result;
    },
    /** 事件流重連：舊回合的 turn/start 可能永遠不會再來，計數不能帶到下一輪。 */
    clearTurns: () => { sentCounts.clear(); usedCounts.clear(); attempted.clear(); },
  };
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * 這兩個路徑本身不能要求會話令牌：
 * - sessionToken：它就是拿會話令牌的入口。
 * - imageJob：DSH 外掛回報背景生圖狀態；它用 x-agent-token 認身分，帶的是 sessionId。
 * 兩者都仍然要 x-agent-token。
 */
const SESSIONLESS_ROUTES = new Set(['sessionToken', 'imageJob']);

function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('請求體讀取逾時'), { statusCode: 408 }));
    }, 10_000);
    timer.unref?.();
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(Object.assign(new Error('請求體過大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { finish(null, {}); return; }
      try { finish(null, JSON.parse(text)); }
      catch { finish(Object.assign(new Error('請求體不是合法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', (error) => finish(error));
  });
}

/**
 * 啟動智能體 API。
 *
 * @param options.file     端點檔（寫入 { url, token }，0600）
 * @param options.handlers { 路徑名: async (body) => 額外回傳欄位 }，例如 { send, react }；
 *                         body.token（會話令牌）已檢查過是字串；丟出的錯誤可用 statusCode。
 *                         `sessionToken` 例外：它就是用來拿會話令牌的，本身不能要求令牌
 *                         （仍然要 x-agent-token）。`imageJob` 也一樣用 x-agent-token 與 sessionId。
 * @param options.log      日誌函式
 */
export async function startAgentApi({ file, handlers, log = () => {} }) {
  const token = randomBytes(32).toString('base64url');
  // MCP server 有沒有真的掛上：只影響日誌。送不送訊息仍然只由模型有沒有呼叫
  // send_message 決定，橋接不會因為「連上了」或「沒連上」改變行為。
  let announced = false;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const route = url.pathname.slice(1);
        const handler = Object.hasOwn(handlers, route) ? handlers[route] : null;
        if (req.method !== 'POST' || (!handler && route !== 'hello')) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        // 沒有 x-agent-token 一律拒絕。不要寫成「有帶才驗」：那會讓漏帶令牌的呼叫
        // 直接升級成別的權限（QQ 版踩過這個 confused deputy，見 bridge.js 的註解）。
        if (!tokenEquals(req.headers['x-agent-token'], token)) {
          sendJson(res, 401, { error: '未授權' });
          return;
        }
        if (!announced) {
          announced = true;
          log('MCP 已連上橋接端點（mcp-discord／mcp-slang 共用）');
        }
        if (route === 'hello') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!ctype.includes('application/json')) {
          sendJson(res, 415, { error: '請求必須是 application/json' });
          return;
        }
        const body = await readBody(req);
        const sessionToken = typeof body?.token === 'string' ? body.token.trim() : '';
        // sessionToken／imageJob 這類路徑不要求會話令牌（sessionToken 是用來拿令牌的，
        // imageJob 用 x-agent-token 與 sessionId）；其他路徑一定要有。
        if (!SESSIONLESS_ROUTES.has(route) && (!sessionToken || sessionToken.length > 128)) {
          sendJson(res, 400, { error: '沒有帶會話令牌（正常由 DSH 外掛自動帶入）：這批送不出去，回報管理員' });
          return;
        }
        const extra = await handler(sessionToken ? { ...body, token: sessionToken } : body);
        sendJson(res, 200, { ok: true, ...(extra ?? {}) });
      } catch (error) {
        const status = Number(error?.statusCode) || 502;
        sendJson(res, status, { error: String(error?.message ?? error) });
      }
    })();
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const port = server.address().port;
  const endpoint = { url: `http://127.0.0.1:${port}`, token };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  log(`智能體發送端點：127.0.0.1:${port}`);

  let closed = false;
  return {
    port,
    url: endpoint.url,
    close: async () => {
      if (closed) return;
      closed = true;
      try { fs.rmSync(file, { force: true }); } catch { /* 已經沒了 */ }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
