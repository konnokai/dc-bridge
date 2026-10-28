#!/usr/bin/env node
// 黑話與頻道標籤 MCP server（stdio）。
// 由 DSH 的 MCP 客戶端 spawn（setup-dsh 寫進 cordis.patch.yml）。
//
// 給聊天 agent 自己用的三個動作：
//   lookup_slang       —— 查一個詞在詞庫裡有沒有、意思是什麼（語意確認）
//   record_slang       —— 把確認過意思的詞收進候選；已經有就回「已收錄過」
//   record_channel_tag —— 記一條這個頻道的風格標籤；同標籤也會回「已收錄過」
//
// 真正的權限與資料都在橋接端：這裡只把呼叫帶回 loopback 的 agent API。
// 端點跟 mcp-discord 共用 state/discord-agent.json（重啟後埠會變，所以每次呼叫都重讀）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT_FILE = process.env.DC_AGENT_FILE || path.join(ROOT, 'state', 'discord-agent.json');

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

async function post(pathname, body, timeoutMs = 10_000) {
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
  if (parsed?.ok === false) throw new Error(String(parsed?.error ?? '橋接拒絕（未說明原因）'));
  return parsed ?? {};
}

/** 呼叫橋接；失敗回 isError，模型才不會以為收進去了。 */
function tool(name, description, schema, pathname, success) {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await post(pathname, args);
      return { content: [{ type: 'text', text: success(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `失敗：${error?.message ?? error}` }] };
    }
  });
}

const server = new McpServer({ name: 'slang', version: '0.1.0' });
const sessionToken = z.string().describe('會話令牌（提示最後的【發送】行會給；照抄，不要自己編）');

tool(
  'lookup_slang',
  '查這個詞在橋接的黑話詞庫裡有沒有、意思是什麼。聊天時看到看不懂的詞先查；查到就照詞庫的意思理解，不用再問。',
  {
    token: sessionToken,
    term: z.string().max(40).describe('要查的詞，或包含那個詞的一小句（40 字內，例如「這操作太難繃了」）'),
  },
  '/slang-lookup',
  (result) => String(result.text ?? ''),
);

tool(
  'record_slang',
  '把確認過意思的群內黑話收進詞庫（候選，管理員確認後才會出現在提示裡）。先 lookup_slang；已經有就不要再送。橋接回「已收錄過」就停，不要改意思重送。',
  {
    token: sessionToken,
    term: z.string().max(24).describe('詞本身，短一點（例如「難繃」）'),
    meaning: z.string().max(120).describe('繁體中文的簡短意思'),
    usage: z.string().max(120).optional().describe('什麼時候用，20 字內，可省略'),
    examples: z.array(z.string().max(80)).max(3).optional().describe('對話裡的原文短句，最多 3 句'),
  },
  '/slang-record',
  (result) => String(result.text ?? ''),
);

tool(
  'record_channel_tag',
  '記一條這個頻道的說話風格標籤（候選，管理員確認後才會出現在提示裡）。只記多數人、多則訊息都看得出來的事（回覆長短、語氣、常聊話題），不記個人。同一個標籤送過會回「已收錄過」。',
  {
    token: sessionToken,
    tag: z.string().max(24).describe('標籤，10 字內（例如「回覆長度」）'),
    description: z.string().max(120).describe('描述，40 字內（例如「大家都一兩句話」）'),
  },
  '/tag-record',
  (result) => String(result.text ?? ''),
);

await server.connect(new StdioServerTransport());
