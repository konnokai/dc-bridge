// 智能體發送 API：MCP（src/mcp-discord.js）把模型要說的話送回橋接的唯一入口。
//
// 為什麼另外開一個 listener，而不是掛在控制台上：
//   控制台綁的是「人」的管理面（可以設成 LAN），模型發訊息是「程式」在動，只需要本機。
//   兩者共用一個埠，等於把發送面一起放上網路，權限也混在一起。這裡固定綁 127.0.0.1
//   的隨機埠，只開 POST /hello 與 POST /send。
//
// 為什麼用檔案傳端點：MCP server 是 DSH 拉起的另一個行程，兩邊唯一的共同點是同一個
// state 目錄。橋接重啟後埠會變，所以 MCP 每次呼叫都重讀這個檔。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { findSensitive } from './discord-security.mjs';

/** 單次工具呼叫的內容上限；sendLong 會再按 Discord 的 2000 字上限切段。 */
export const AGENT_MAX_CONTENT = 8_000;

/** 一輪最多 5 則：夠模型分幾句講完，又洗不了版。 */
export const SEND_PER_TURN_LIMIT = 5;

const statusError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * 發送回端：MCP send_message 送進來之後，決定能不能送、送到哪裡。
 *
 * 工具只收 token，不收 key：令牌綁定一個會話，模型就算被騙也指定不了別的頻道。
 * 白名單、敏感資訊閘門、每輪上限都在這裡判斷。MCP server 是 DSH 拉起的另一個行程，
 * 不該持有這些判斷。
 *
 * @param options.sessions       key -> sessionId（橋接的會話表，會被橋接原地改）
 * @param options.reverse        sessionId -> key
 * @param options.resolveChannel async key => Discord channel
 * @param options.isAllowed      (key, channel) => boolean
 * @param options.secrets        () => 已知令牌清單（會話令牌另外自動加入）
 * @param options.blockSensitive () => boolean
 * @param options.deliver        async (key, content) => void
 */
export function createAgentSender({
  sessions,
  reverse,
  resolveChannel,
  isAllowed,
  secrets = () => [],
  blockSensitive = () => true,
  deliver,
  limit = SEND_PER_TURN_LIMIT,
}) {
  const tokens = new Map(); // sessionId -> 會話令牌（只在記憶體，橋接重啟就換）
  const chains = new Map(); // key -> 串行化（同一輪的多個 tool call 不搶順序）
  const sentCounts = new Map(); // key -> 這一輪已經送出幾則
  const attempted = new Set(); // key -> 這一輪有沒有試過呼叫發送工具

  function tokenFor(sessionId) {
    let value = tokens.get(sessionId);
    if (!value) {
      value = randomBytes(18).toString('base64url');
      tokens.set(sessionId, value);
    }
    return value;
  }

  /** 令牌數量等於會話數（很少），逐一定長比對即可。 */
  function sessionForToken(given) {
    const g = Buffer.from(String(given ?? ''), 'utf8');
    if (g.length === 0) return null;
    for (const [sessionId, token] of tokens) {
      const t = Buffer.from(token, 'utf8');
      if (t.length === g.length && timingSafeEqual(t, g)) return sessionId;
    }
    return null;
  }

  const alive = (key, sessionId) => sessions[key] === sessionId && reverse.get(sessionId) === key;

  async function send({ token, content }) {
    const sessionId = sessionForToken(token);
    // 令牌過期（橋接重啟或 /reset）是模型最可能遇到的失敗。訊息要它去抄最新一行，
    // 否則它會以為「這個會話不能發」，整輪就靜音了。
    if (!sessionId) throw statusError('會話令牌過期或不是最新的：請用最新一則【發送】行的 token 再呼叫一次', 403);
    const key = reverse.get(sessionId);
    if (!key || !alive(key, sessionId)) throw statusError('這個會話已經結束，不送出', 403);
    const kind = key.split(':')[0];
    if (kind !== 'ch' && kind !== 'dm') throw statusError('會話 key 格式不對', 400);

    const channel = await resolveChannel(key);
    if (!isAllowed(key, channel)) throw statusError(`頻道 ${key} 不在白名單內，不送出`, 403);

    const hit = blockSensitive() ? findSensitive(content, [...secrets(), token]) : null;
    if (hit) throw statusError(`內容命中敏感資訊閘門（${hit}），已攔截`, 400);

    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      // 排隊期間可能被 /reset：已經排隊的訊息不能送進新會話。
      if (!alive(key, sessionId)) throw statusError('這個會話已經結束，不送出', 403);
      // 上限放在排隊後才檢查：同一輪的並行 tool call 才不會一起鑽過去。
      if ((sentCounts.get(key) ?? 0) >= limit) {
        throw statusError(`這一輪已經送出 ${limit} 則，不再送出`, 429);
      }
      await deliver(key, content);
      sentCounts.set(key, (sentCounts.get(key) ?? 0) + 1);
    });
    chains.set(key, next);
    const cleanup = () => { if (chains.get(key) === next) chains.delete(key); };
    next.then(cleanup, cleanup);
    await next;
    return { key, channel: kind === 'dm' ? '私聊' : (channel?.name ?? key) };
  }

  return {
    tokenFor,
    send,
    /** /reset：令牌作廢。排隊中的發送由 alive() 擋掉。 */
    forget: (sessionId) => { tokens.delete(sessionId); },
    startTurn: (key) => { sentCounts.delete(key); attempted.delete(key); },
    noteAttempt: (key) => { attempted.add(key); },
    /** 回合結束：回傳這一輪送了幾則、有沒有試過呼叫工具，並歸零。 */
    finishTurn: (key) => {
      const result = { sent: sentCounts.get(key) ?? 0, attempted: attempted.has(key) };
      sentCounts.delete(key);
      attempted.delete(key);
      return result;
    },
    /** 事件流重連：舊回合的 turn/start 可能永遠不會再來，計數不能帶到下一輪。 */
    clearTurns: () => { sentCounts.clear(); attempted.clear(); },
  };
}

const MAX_BODY_BYTES = 64 * 1024;

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
 * 啟動智能體發送 API。
 *
 * @param options.file   端點檔（寫入 { url, token }，0600）
 * @param options.send   async ({ token, content }) => 額外回傳欄位；丟出的錯誤可用 statusCode
 * @param options.log    日誌函式
 */
export async function startAgentApi({ file, send, log = () => {} }) {
  const token = randomBytes(32).toString('base64url');
  // MCP server 有沒有真的掛上：只影響日誌。送不送訊息仍然只由模型有沒有呼叫
  // send_message 決定，橋接不會因為「連上了」或「沒連上」改變行為。
  let announced = false;

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'POST' || (url.pathname !== '/send' && url.pathname !== '/hello')) {
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
          log('mcp-discord 已連上：模型可以自己決定要不要發訊息');
        }
        if (url.pathname === '/hello') {
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
        const content = typeof body?.content === 'string' ? body.content : '';
        if (!sessionToken || sessionToken.length > 128) {
          sendJson(res, 400, { error: '缺少會話令牌' });
          return;
        }
        if (!content.trim()) {
          sendJson(res, 400, { error: 'content 是空的' });
          return;
        }
        if (content.length > AGENT_MAX_CONTENT) {
          sendJson(res, 400, { error: `content 超過 ${AGENT_MAX_CONTENT} 字` });
          return;
        }
        const extra = await send({ token: sessionToken, content });
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
