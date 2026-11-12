#!/usr/bin/env node
// 模擬股票交易 MCP server（stdio）。
//
// 跟 mcp-slang 一樣，只把呼叫帶回橋接的 loopback 端點；帳戶、訂單、成交價與權限
// 全部在橋接。模型看不到 token，DSH 外掛會自動帶入。
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
    throw new Error('橋接的端點還沒就緒（state/discord-agent.json 不存在）：確認 dc-bridge 正在執行');
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw new Error('端點檔損毀：重啟 dc-bridge 會重寫');
  }
  if (!doc?.url || !doc?.token) throw new Error('端點檔缺少 url/token：重啟 dc-bridge');
  return doc;
}

async function post(pathname, body, timeoutMs = 30_000) {
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

function tool(name, description, schema, pathname) {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await post(pathname, args);
      return { content: [{ type: 'text', text: String(result.text ?? '') }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `失敗：${error?.message ?? error}` }] };
    }
  });
}

const server = new McpServer({ name: 'trade', version: '0.1.0' });
// 欄位要留著（選填）：MCP SDK 會剝掉 schema 沒宣告的參數，DSH 外掛補的令牌就進不去。
const sessionToken = z.string().optional().describe('不用填：DSH 外掛會自動帶入會話令牌');

tool(
  'get_quote',
  '查台股最近一次官方收盤價、報價時間與市場狀態。這不是盤中即時報價；回答時要說清楚「最近收盤」與 asOf。查不到或名稱對到多個標的時，照工具回傳的候選清單問人，不要自己猜代號；名稱不確定或想看有哪些商品時先用 list_symbols。回「不在可交易範圍」時代表官方行情有這支，但不是一般上市／上櫃普通股，或不在 ETF 主檔；照實講不能下單，不要自己加碼。',
  {
    token: sessionToken,
    query: z.string().max(40).describe('股票或 ETF 代號、名稱，例如 2330、台積電、0050'),
  },
  '/trade-quote',
);

tool(
  'list_symbols',
  '列出可交易商品（代號＋名稱）。不帶 query 回可交易範圍與 ETF 清單；帶代號、名稱或別名則查主檔與官方行情的一般普通股。下單前先用這裡確認代號可交易；查不到就代表目前不開放，不要一支一支試，也不要猜。群友問「有哪些商品」時直接照清單回答。',
  {
    token: sessionToken,
    query: z.string().max(40).optional().describe('可省略；代號、名稱或別名，例如 2330、台積、0050'),
  },
  '/trade-symbols',
);

tool(
  'place_order',
  '幫目前這一輪的觸發者排隊買入或賣出模擬股票。只建立 pending 訂單，當日或下一交易日收盤後才成交；不要說「已成交」。message 必須填觸發這一輪的那則訊息 #編號（★ 的那則），quantity 是股數。同一輪只能成功一筆。',
  {
    token: sessionToken,
    message: z.string().max(20).describe('觸發這一輪的訊息 #編號，例如 #k7f3ab；不是股票代號'),
    side: z.enum(['buy', 'sell']).describe('buy 或 sell'),
    symbol: z.string().max(12).describe('台股代號，例如 2330；一般上市／上櫃普通股或 ETF 主檔'),
    quantity: z.number().int().positive().max(10_000_000).describe('股數（整數，第一版不支援金額下單）'),
  },
  '/trade-order',
);

tool(
  'get_portfolio',
  '查目前這一輪觸發者的模擬帳戶：現金、保留現金、持股、損益、淨值、報酬率與最近訂單。message 可省略；同一輪有多個觸發者時要填其中一人的訊息 #編號。',
  {
    token: sessionToken,
    message: z.string().max(20).optional().describe('可省略；多人同時觸發時填其中一人的訊息 #編號'),
  },
  '/trade-portfolio',
);

tool(
  'get_leaderboard',
  '查這個伺服器的模擬投資排行榜（依總報酬率，最多 10 名）。Bot 會標 🤖。不要在私聊使用。',
  { token: sessionToken },
  '/trade-leaderboard',
);

tool(
  'get_bot_portfolio',
  '唯讀查 Bot 交易員自己的模擬帳戶。玩家問「你自己賺多少」「你買了什麼」時使用；不能改任何人的資料。',
  { token: sessionToken },
  '/trade-bot-portfolio',
);

tool(
  'bot_place_order',
  'Bot 交易員專用：替自己的模擬帳戶排隊一筆買或賣。只有 Bot 排程回合可以呼叫，一輪最多一筆；參數跟玩家下單一樣會過現金、持股、單筆上限與市場狀態檢查。不下單就不要呼叫。',
  {
    token: sessionToken,
    side: z.enum(['buy', 'sell']).describe('buy 或 sell'),
    symbol: z.string().max(12).describe('台股代號，例如 2330；一般上市／上櫃普通股或 ETF 主檔'),
    quantity: z.number().int().positive().max(10_000_000).describe('股數'),
    reason: z.string().max(300).optional().describe('為什麼下這筆單，給控制台稽核看'),
    note: z.string().max(200).optional().describe('一句話備註；目前不會公開'),
  },
  '/trade-bot-order',
);

await server.connect(new StdioServerTransport());
