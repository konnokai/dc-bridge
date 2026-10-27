#!/usr/bin/env node
// Discord MCP server（stdio）。
// 由 DSH 的 MCP 客戶端 spawn（cordis.patch.yml 裡的 mcp-discord 行）。
//
// 說不說話、回覆誰、按什麼 reaction 都是模型的決定；這裡只負責把呼叫帶回橋接。
// 真正的權限（會話令牌、白名單、敏感資訊、每輪上限、#編號只查自己頻道）都在橋接端，
// 所以每個工具都只是一行 post。
//
// 端點由橋接寫在 state/discord-agent.json（重啟後埠會變，所以每次呼叫都重讀）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT_FILE = process.env.DC_AGENT_FILE || path.join(ROOT, 'state', 'discord-agent.json');
const PING_INTERVAL_MS = 10_000;

function readEndpoint() {
  let text;
  try {
    text = fs.readFileSync(ENDPOINT_FILE, 'utf8');
  } catch {
    throw new Error('橋接的發送端點還沒就緒（state/discord-agent.json 不存在）：確認 dc-bridge 正在執行');
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw new Error('發送端點檔損毀：重啟 dc-bridge 會重寫');
  }
  if (!doc?.url || !doc?.token) throw new Error('發送端點檔缺少 url/token：重啟 dc-bridge');
  return doc;
}

async function post(pathname, body, timeoutMs) {
  const { url, token } = readEndpoint();
  let res;
  try {
    res = await fetch(`${url}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`連不上橋接（${url}）：${error?.message ?? error}`);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) throw new Error(String(parsed?.error ?? `橋接回應 HTTP ${res.status}`));
  if (parsed?.ok === false) throw new Error(String(parsed?.error ?? '橋接拒絕送出（未說明原因）'));
  return parsed ?? {};
}

/**
 * 握手：通知橋接 mcp-discord 已啟動，橋接在日誌留一行，方便確認 DSH 有載入它。
 * 只影響日誌，不影響送不送。定時重送是因為橋接重啟後換了端點，要再報到一次。
 */
async function hello() {
  await post('/hello', {}, 5000);
}

void hello().catch(() => {});
const pingTimer = setInterval(() => { void hello().catch(() => {}); }, PING_INTERVAL_MS);
pingTimer.unref?.();

const server = new McpServer({ name: 'discord', version: '0.2.1-r1' });

const sessionToken = z.string().describe('會話令牌（提示最後的【發送】行會給；照抄，不要自己編）');
const messageRef = (what) => z.string().describe(`${what}：訊息前面的 #編號（例如 #k7f3ab），只能用這個頻道出現過的`);

/** 每個工具都是：post 到橋接 → 成功回文字，失敗回 isError（模型才不會以為做成了）。 */
function tool(name, description, schema, pathname, success, timeoutMs = 30_000) {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await post(pathname, args, timeoutMs);
      return { content: [{ type: 'text', text: success(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `失敗：${error?.message ?? error}` }] };
    }
  });
}

tool(
  'send_message',
  '把一則訊息送進目前的 Discord 會話。這是唯一能把文字送到 Discord 的方法：不呼叫就不會發出任何東西。',
  {
    token: sessionToken,
    content: z.string().describe('要送出的訊息本體（Discord Markdown；:名稱: 會換成伺服器表情；太長會自動分段）'),
    reply_to: messageRef('要用 Discord「回覆」功能接的那則訊息').optional(),
  },
  '/send',
  (result) => `已送出到 ${result.channel ?? 'Discord'}`,
);

tool(
  'send_sticker',
  '送一張這個伺服器的貼圖（名稱先用 search_emojis 查）。私聊與別的伺服器的貼圖送不了。',
  {
    token: sessionToken,
    sticker: z.string().describe('貼圖名稱（search_emojis 回傳的「貼圖」那段）'),
    content: z.string().optional().describe('跟貼圖一起送的文字，可省略'),
    reply_to: messageRef('要回覆的那則訊息').optional(),
  },
  '/send',
  (result) => `已送出貼圖到 ${result.channel ?? 'Discord'}`,
);

tool(
  'add_reaction',
  '對某則訊息按一個表情反應。比回一句話更輕：同意、好笑、看到了，按一下就好。',
  {
    token: sessionToken,
    message: messageRef('要按 reaction 的那則訊息'),
    emoji: z.string().describe('伺服器表情名稱（例如 kekw，先用 search_emojis 查）或一個 Unicode emoji（例如 😂）'),
  },
  '/react',
  () => '已按 reaction',
);

tool(
  'search_emojis',
  '用關鍵字查這個伺服器能用的自訂表情與貼圖。query 留空就列出這個伺服器的。',
  {
    token: sessionToken,
    query: z.string().optional().describe('想表達的情緒或內容，短一點，例如「笑」「無語」「貓」'),
  },
  '/emojis',
  (result) => String(result.text ?? ''),
  10_000,
);

tool(
  'read_history',
  '往前讀這個頻道更早的訊息（被問到之前的事、或想知道前面在聊什麼時用）。只能讀目前這個頻道。',
  {
    token: sessionToken,
    before: messageRef('從哪一則往前讀，省略就從最新的開始').optional(),
    limit: z.number().int().min(1).max(50).optional().describe('讀幾則，預設 20，最多 50'),
  },
  '/history',
  (result) => String(result.text ?? ''),
);

tool(
  'user_info',
  '查某則訊息的發言者：顯示名稱、使用者名稱、身分組、加入伺服器時間，以及你記得的關於他的事。',
  {
    token: sessionToken,
    message: messageRef('那個人說過的某一則訊息'),
  },
  '/user',
  (result) => String(result.text ?? ''),
);

tool(
  'remember_user',
  '記住某個群友的一件事（他自己說的、之後聊天用得到的）。之後他說話時會出現在【你記得的群友】。回傳他目前的整份清單。',
  {
    token: sessionToken,
    message: messageRef('他說這件事的那則訊息（記憶掛在這則的發言者身上）'),
    name: z.string().describe('這件事是誰的：他在 prompt 裡的暱稱。跟那則的發言者對不上會回錯誤'),
    fact: z.string().describe('一句短話，最多 100 字，例如「在準備期末考」「希望大家叫他阿華」'),
  },
  '/remember',
  (result) => String(result.text ?? ''),
);

tool(
  'forget_user_fact',
  '刪掉某個群友記憶裡的一條（事情變了、記錯了）。編號用最新清單的；回傳刪完的清單。',
  {
    token: sessionToken,
    message: messageRef('那個人說過的某一則訊息'),
    number: z.number().int().min(1).describe('要刪第幾條（清單裡的編號）'),
  },
  '/forget-fact',
  (result) => String(result.text ?? ''),
);

await server.connect(new StdioServerTransport());
