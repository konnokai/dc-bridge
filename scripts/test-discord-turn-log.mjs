// 回合決策紀錄的離線回歸：不需要 Discord、不需要 DSH。
//   node scripts/test-discord-turn-log.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TURN_DECISIONS,
  TURN_MAX_BYTES,
  TURN_SCOPES,
  TURN_SKIP_REASONS,
  createTurnLog,
  normalizeTurnRecord,
  turnRecord,
} from '../src/core/discord-turns.mjs';
import { createTurnGate, isMediaOnlyBatch, shouldYield, YIELD_WINDOW_MS } from '../src/core/discord-batch.mjs';
import { createTokenLedger } from '../src/token-ledger.js';
import { DEFAULT_PRICE_TABLE } from '../src/model-prices.js';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-turns-'));
const file = path.join(tmp, 'discord-turns.jsonl');
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const readLines = (target = file) => fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

const A = '111111111111111111';
const B = '222222222222222222';

console.log('## 1. schema');
{
  const log = createTurnLog({ file });
  const job = { direct: true, merged: 2, entries: [{ userId: A, direct: true, rawText: '@bot 你看' }] };
  ok(log.write(turnRecord({
    key: 'ch:1', job, meta: { chatty: true }, decision: 'sent', turn: 7,
    sent: 2, tools: ['send_message', 'add_reaction'], tokens: 1234, ttftMs: 820, model: 'deepseek-chat', now: NOW,
  })), 'sent 可以寫入');

  const [row] = readLines();
  const keys = Object.keys(row);
  ok(keys.join(',') === [
    'at', 'key', 'turn', 'decision', 'reason', 'direct', 'named', 'chatty', 'mediaOnly',
    'yielded', 'merged', 'users', 'sent', 'tools', 'tokens', 'ttftMs', 'model', 'scope',
  ].join(','), '欄位固定且順序一致');
  ok(row.at === '2026-11-19T12:00:00.000Z' && row.key === 'ch:1' && row.turn === 7, '時間、key、turn');
  ok(row.direct === true && row.chatty === true && row.merged === 2, '批次旗標');
  ok(row.users.join() === A && row.sent === 2 && row.tools.join() === 'send_message,add_reaction', 'users、sent、tools');
  ok(row.tokens === 1234 && row.ttftMs === 820 && row.model === 'deepseek-chat', 'tokens、ttft、model');
  ok(row.scope === 'batch', '預設是批次列');

  // 橋接呼叫時不會傳 now：預設值必須真的產生 ISO 時間，不能把 Date.now 函式丟給 Date。
  const defaultNow = turnRecord({ key: 'ch:1', decision: 'sent' });
  ok(Number.isFinite(Date.parse(defaultNow.at)), '沒傳 now 時用當下時間');
  const defaultLog = createTurnLog({ file: path.join(tmp, 'default-now.jsonl') });
  ok(defaultLog.write(defaultNow), '預設 now 的紀錄可以寫入');
}

console.log('## 2. decision / reason 的允許值');
{
  ok(TURN_DECISIONS.join() === 'sent,silent,skipped', 'decision 三個值');
  ok(TURN_SKIP_REASONS.length === 9 && TURN_SKIP_REASONS.includes('media-only'), 'reason 九個值');
  ok(TURN_SCOPES.join() === 'batch,message', 'scope 兩個值');
  const messageRow = normalizeTurnRecord(turnRecord({
    key: 'ch:1', decision: 'skipped', reason: 'empty', scope: 'message', now: NOW,
  }));
  ok(messageRow?.scope === 'message', '單則訊息列可以標成 message');
  ok(normalizeTurnRecord({ ...messageRow, scope: 'nope' }) === null, '未知 scope 不寫');

  for (const reason of TURN_SKIP_REASONS) {
    const row = normalizeTurnRecord(turnRecord({ key: 'ch:1', decision: 'skipped', reason, now: NOW }));
    ok(row?.reason === reason, `skipped/${reason} 合法`);
  }
  ok(normalizeTurnRecord(turnRecord({ key: 'ch:1', decision: 'skipped', reason: 'nope', now: NOW })) === null,
    '未知 reason 不寫');
  ok(normalizeTurnRecord(turnRecord({ key: 'ch:1', decision: 'sent', reason: 'quiet', now: NOW })) === null,
    '非 skipped 帶 reason 不寫');
  ok(normalizeTurnRecord(turnRecord({ key: 'ch:1', decision: 'bogus', now: NOW })) === null, '未知 decision 不寫');
  ok(normalizeTurnRecord(turnRecord({ key: '', decision: 'sent', now: NOW })) === null, '沒有 key 不寫');

  const before = readLines().length;
  const log = createTurnLog({ file, log: () => {} });
  ok(log.write({ at: 'x', key: 'ch:1', decision: 'skipped', reason: 'bogus' }) === false, '寫入器擋掉不合法的紀錄');
  ok(readLines().length === before, '不合法的紀錄沒有進檔');
}

console.log('## 3. 20 MB 輪替');
{
  const rotateFile = path.join(tmp, 'rotate.jsonl');
  const maxBytes = 300;
  const log = createTurnLog({ file: rotateFile, maxBytes });
  for (let i = 0; i < 20; i += 1) {
    log.write(turnRecord({ key: 'ch:1', decision: 'silent', turn: i, now: NOW }));
  }
  ok(fs.existsSync(`${rotateFile}.1`), '超過上限後輪替成 .1');
  ok(fs.statSync(`${rotateFile}.1`).size > 0, '.1 有內容');
  const before = fs.readdirSync(tmp).filter((name) => name.startsWith('rotate.jsonl')).sort();
  ok(before.join() === 'rotate.jsonl,rotate.jsonl.1', '只留一份舊檔');

  for (let i = 0; i < 20; i += 1) {
    log.write(turnRecord({ key: 'ch:1', decision: 'silent', turn: i, now: NOW }));
  }
  ok(fs.readdirSync(tmp).filter((name) => name.startsWith('rotate.jsonl')).length === 2, '再輪替一次也只有兩份');
  ok(TURN_MAX_BYTES === 20 * 1024 * 1024, '預設上限 20 MB');
}

console.log('## 4. 整合：被閘門擋下的批次');
{
  const log = createTurnLog({ file, log: () => {} });
  const at = 2_000_000;
  const yieldBatch = {
    direct: false,
    entries: [
      { id: '1001', userId: B, rawText: '插話' },
      { id: '1010', userId: A, direct: true, rawText: '回你' },
    ],
  };
  const yields = shouldYield({
    botLast: { ids: ['1000'], at: 1_900_000, replyTo: { id: '999', authorId: A } },
    recent: [{ id: '1005', authorId: B }],
    batch: yieldBatch.entries.map((entry) => ({ id: entry.id, userId: entry.userId })),
    replyToId: '1000',
    named: false,
    othersStar: false,
    botAfter: true,
    now: at,
  });
  ok(yields, '測資真的會讓位');
  const yieldRow = turnRecord({
    key: 'ch:1', job: yieldBatch, meta: { chatty: true, yielded: yields, merged: 1 },
    decision: 'skipped', reason: 'yield', now: NOW,
  });
  ok(log.write(yieldRow) && yieldRow.reason === 'yield' && yieldRow.yielded === true, 'yield 寫成 skipped/yield');
  ok(yieldRow.users.join() === A && yieldRow.merged === 1, 'yield 保留觸發者與合併數');

  const mediaBatch = { direct: false, entries: [{ userId: A, mediaOnly: true, rawText: '' }] };
  ok(isMediaOnlyBatch(mediaBatch.entries), '測資真的是純媒體');
  const mediaRow = turnRecord({
    key: 'ch:1', job: mediaBatch, meta: { chatty: true },
    decision: 'skipped', reason: 'media-only', now: NOW,
  });
  ok(log.write(mediaRow) && mediaRow.reason === 'media-only' && mediaRow.mediaOnly === true, '純媒體寫成 skipped/media-only');

  ok(YIELD_WINDOW_MS === 5 * 60_000, '讓位窗口仍是 5 分鐘');
}

console.log('## 4b. 合批計數');
{
  const delivered = [];
  const gate = createTurnGate({
    deliver: (key, job) => delivered.push({ key, job }),
    maxEntries: 10,
    releaseMs: 60_000,
  });
  const ticket = gate.submit('ch:1', { entries: [{ at: 1, id: '1' }], epoch: 1 });
  gate.submit('ch:1', { entries: [{ at: 2, id: '2' }], epoch: 1 });
  gate.submit('ch:1', { entries: [{ at: 3, id: '3' }], epoch: 1 });
  gate.release('ch:1', ticket);
  ok(delivered.length === 2 && delivered[0].job.merged === undefined, '第一批沒有合併');
  ok(delivered[1]?.job.entries.length === 2 && delivered[1].job.merged === 1, '第二批記下先前壓住的 1 則');
}

console.log('## 5. 整合：sent 的 tokens 對得上帳本');
{
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  const at = Date.parse('2026-03-02T20:00:00+08:00'); // 週一晚上，離峰
  const ledger = createTokenLedger({
    file: ledgerFile,
    priceTable: DEFAULT_PRICE_TABLE,
    resolveKey: (sessionId) => (sessionId === 's1' ? 'ch:1' : undefined),
    now: () => at,
  });
  ledger.ingestEvent({
    sessionId: 's1',
    model: 'deepseek-flash',
    event: { seq: 1, time: at, type: 'assistant/message', data: { turn: 8, step: 1, usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 } } },
  });
  ledger.ingestEvent({
    sessionId: 's1',
    event: { seq: 2, time: at, type: 'assistant/message', data: { turn: 8, step: 2, usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100 } } },
  });
  const usageRow = ledger.turnUsage('s1', 8);
  ok(usageRow?.tokens === 1200, `turnUsage 加總同一輪的所有 step（實得 ${usageRow?.tokens}）`);
  ok(usageRow?.model === 'deepseek-flash', 'turnUsage 帶回模型');
  ok(ledger.turnUsage('s1', 9) === null, '不存在的回合回 null');

  const log = createTurnLog({ file, log: () => {} });
  const sentRow = turnRecord({
    key: 'ch:1', job: { direct: true, entries: [{ userId: A, direct: true, rawText: 'hi' }] },
    decision: 'sent', turn: 8, sent: 1, tools: ['send_message'],
    tokens: usageRow.tokens, ttftMs: 640, model: usageRow.model, now: NOW,
  });
  ok(log.write(sentRow), 'sent 可以寫入');
  const written = readLines().find((row) => row.decision === 'sent' && row.turn === 8);
  ok(written?.tokens === usageRow.tokens && written.tokens === 1200, 'sent 的 tokens 對得上帳本');
}

console.log('## 6. 內部提示（system）');
{
  const row = normalizeTurnRecord(turnRecord({
    key: 'ch:1', decision: 'skipped', reason: 'system', sent: 1, tools: ['send_image'], now: NOW,
  }));
  ok(row?.reason === 'system' && row.sent === 1, '系統訊息記 skipped/system，不混進對話回覆率');
}

if (failures > 0) {
  console.error(`\n${failures} 項失敗`);
  process.exit(1);
}
console.log('\n全部通過');
