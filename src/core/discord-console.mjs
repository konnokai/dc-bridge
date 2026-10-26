// Discord 橋接控制台：預設只綁 127.0.0.1、只認 token、只做四件事
// （狀態、會話重置、白名單/媒體設定、日誌尾巴）。
//
// 允許在 config 指定 host（例如 LAN IP 或 0.0.0.0）方便從別台開，但那就等於把
// 管理介面放到網路上：token 是唯一的門，啟動時會印警告。沒有 CORS，只服務同源請求。
//
// 刻意不重用 QQ 版控制台：那頁綁了 102 個 QQ 專用端點（模式、角色、黑話、表情包、
// 語音、令牌帳本），Discord 版沒有那些概念。這裡的 HTML 是獨立一頁，介面只打
// 下面這幾個 JSON 端點。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CONSOLE_DEFAULT_PORT = 3110;
const MAX_BODY_BYTES = 64 * 1024;

/** 讀既有 token，沒有就產生一個並寫進 state 檔（0600）。 */
export function resolveConsoleToken({ configured, file } = {}) {
  const given = typeof configured === 'string' ? configured.trim() : '';
  if (given) return { token: given, created: false };
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return { token: existing, created: false };
  } catch { /* 第一次啟動 */ }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function authorized(req, url, token) {
  const header = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const supplied = header || String(req.headers['x-console-token'] ?? '') || (url.searchParams.get('token') ?? '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object');
  return value;
}

/**
 * 啟動控制台。
 * @param options.host 監聽位址（預設 127.0.0.1；可填 LAN IP 或 0.0.0.0）
 * @param options.port 監聽埠
 * @param options.token 存取 token
 * @param options.htmlPath 控制台 HTML
 * @param options.handlers { status, invite, usage, usageTurns, usageReset, sessions, resetSession, config, updateConfig, rebuildEmojis, slang, slangConfirm, slangReject, slangUpdate, slangDelete, logs }
 * @returns {Promise<{server: http.Server, close: () => Promise<void>}>}
 */
export async function startConsole({ host = '127.0.0.1', port, token, htmlPath, handlers, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html;
      try {
        html = fs.readFileSync(htmlPath, 'utf8');
      } catch (error) {
        sendJson(res, 500, { error: `讀不到控制台頁面：${error?.message ?? error}` });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!authorized(req, url, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, handlers.status());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/invite') {
        sendJson(res, 200, handlers.invite());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/usage') {
        const range = (url.searchParams.get('range') ?? '24h').trim();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        sendJson(res, 200, handlers.usage({ range, limit }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/usage/turns') {
        const key = (url.searchParams.get('key') ?? '').trim();
        if (!key) {
          sendJson(res, 400, { error: '缺少會話 key' });
          return;
        }
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const detail = handlers.usageTurns(key, limit);
        sendJson(res, detail ? 200 : 404, detail ?? { error: '找不到會話' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/usage/reset') {
        await readJson(req); // 把 body 讀完，避免 keep-alive 連線上留下未消費的位元組
        handlers.usageReset();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: handlers.sessions() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/reset') {
        const body = await readJson(req);
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!/^(dm|ch):\d+$/.test(key)) {
          sendJson(res, 400, { error: 'key 必須是 dm:<id> 或 ch:<id>' });
          return;
        }
        const reset = await handlers.resetSession(key);
        sendJson(res, 200, { ok: true, reset });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        sendJson(res, 200, handlers.config());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJson(req);
        try {
          sendJson(res, 200, { ok: true, config: await handlers.updateConfig(body) });
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/emojis/rebuild') {
        const body = await readJson(req);
        const started = await handlers.rebuildEmojis({
          guildId: typeof body.guildId === 'string' ? body.guildId.trim() : '',
          force: body.force === true,
        });
        sendJson(res, 200, { ok: true, started: started === true });
        return;
      }
      if (url.pathname === '/api/slang' || url.pathname.startsWith('/api/slang/')) {
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          sendJson(res, 200, handlers.slang());
          return;
        }
        if (req.method === 'POST' && url.pathname.startsWith('/api/slang/')) {
          const action = url.pathname.slice('/api/slang/'.length);
          const body = await readJson(req);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (!id) {
            sendJson(res, 400, { error: '缺少詞條 id' });
            return;
          }
          if (action === 'delete') {
            const removed = handlers.slangDelete(id);
            sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: '找不到詞條' });
            return;
          }
          let entry = null;
          if (action === 'confirm') entry = handlers.slangConfirm(id);
          else if (action === 'reject') entry = handlers.slangReject(id);
          else if (action === 'update') {
            entry = handlers.slangUpdate(id, {
              term: body.term,
              meaning: body.meaning,
              usage: body.usage,
              examples: body.examples,
            });
          } else {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          sendJson(res, entry ? 200 : 404, entry ? { ok: true, entry } : { error: '找不到詞條' });
          return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        sendJson(res, 200, { logs: handlers.logs(limit) });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      log(`控制台請求失敗 ${req.method} ${url.pathname}：${error?.message ?? error}`);
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      server.on('error', (error) => log(`控制台錯誤：${error?.message ?? error}`));
      resolve();
    });
  });

  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
