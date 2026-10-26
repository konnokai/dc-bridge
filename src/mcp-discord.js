#!/usr/bin/env node
// Discord 發送 MCP server（stdio）。
// 由 DSH 的 MCP 客戶端 spawn（cordis.patch.yml 裡的 mcp-discord 行）。
//
// 為什麼只有一個工具：橋接原本在回合結束時自動把模型文字送到頻道，模型沒有「不說話」
// 的選擇。改成由模型呼叫 send_message 之後，說不說話、什麼時候說、分幾條，都是模型的
// 決定；這裡只負責把話帶回橋接，真正的權限（會話令牌、白名單、敏感資訊、切段）在橋接端。
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

server.tool(
  'send_message',
  '把一則訊息送進目前的 Discord 會話。這是唯一能把文字送到 Discord 的方法：不呼叫就不會發出任何東西。',
  {
    token: z.string().describe('會話令牌（提示最後的【發送】行會給；照抄，不要自己編）'),
    content: z.string().describe('要送出的訊息本體（Discord Markdown；:名稱: 會換成伺服器表情；太長會自動分段）'),
  },
  async ({ token, content }) => {
    try {
      const result = await post('/send', { token, content }, 30_000);
      return { content: [{ type: 'text', text: `已送出到 ${result.channel ?? 'Discord'}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `送出失敗：${error?.message ?? error}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
