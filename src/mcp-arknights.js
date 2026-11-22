#!/usr/bin/env node
// 明日方舟幹員練度統計 MCP server（stdio）。只讀公開資料，沒有金鑰、沒有本機檔案。
//
// 資料來自一圖流（yituliu）全服持有者的專精／模組分布；回答「這隻要專幾、開哪個模組」。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { lookupTraining, warmupAliases } from './core/arknights-training.mjs';

const server = new McpServer({ name: 'arknights', version: '0.1.0' });

server.tool(
  'get_operator_training',
  '查一位明日方舟幹員的專精與模組建議：用一圖流（yituliu）全服持有者的練度統計，回每個技能（M1／M2／M3）的專三率、精二人數，以及每個模組的階段 3 率與開啟率（≥1）。`operator` 可以填遊戲內名稱、群裡的綽號（銀老闆、42、飛天貓）或 charId；別名表第一次抓到就存進 state/arknights-aliases.json，控制台「別名」分頁可以拒絕或刪除。有人問「這隻要專幾」「該開哪個模組」「練度統計」「大家怎麼練」時用。這是玩家實際練度，不是官方推薦，回話要說「大家通常…」。查不到幹員時先把候選名稱給對方；要查幹員技能數值或劇情，改用 mcp__prts__*。',
  {
    operator: z.string().max(40).describe('幹員名稱（簡體或繁體都可以）或 charId，例如 能天使、阿米娅、char_103_angel'),
  },
  async ({ operator }) => {
    try {
      const text = await lookupTraining(operator);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `查詢失敗：${error?.message ?? error}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
// DSH 啟動時先抓幹員表與 PRTS 別名；第一次查詢就不用等 10 幾個請求。
if (process.env.DC_ARKNIGHTS_NO_WARMUP !== '1') void warmupAliases();
