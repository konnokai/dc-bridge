// 交易域 SQLite 的離線回歸：不需要 Discord、不需要 DSH、不需要網路。
//   node scripts/test-discord-trade-db.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTradeDb } from '../src/core/discord-trade-db.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const NOW = '2026-11-05T02:00:00.000Z';
const db = openTradeDb(':memory:');
db.ensureAccount('user:1', { kind: 'player', startingCashCents: 100_000_000, now: NOW });

console.log('## 1. 帳戶與 schema');
{
  const again = db.ensureAccount('user:1', { kind: 'player', startingCashCents: 1, now: NOW });
  ok(again.cash_cents === 100_000_000, '重複 ensureAccount 不會重置帳戶');
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const name of ['accounts', 'positions', 'orders', 'cash_ledger', 'account_guilds', 'bot_runs']) {
    ok(tables.includes(name), `資料表 ${name} 存在`);
  }
}

function sampleOrder(overrides = {}) {
  return {
    id: `ORD-${Math.random().toString(36).slice(2)}`,
    requestId: `msg:${Math.random().toString(36).slice(2)}`,
    accountId: 'user:1',
    actor: 'player',
    market: 'TW',
    symbol: '2330',
    side: 'buy',
    qty: 10,
    currency: 'TWD',
    tradeDate: '2026-11-05',
    guildId: 'g1',
    channelId: 'c1',
    sourceMessageId: `m-${Math.random().toString(36).slice(2)}`,
    reservedCents: 0,
    reservedQty: 0,
    feeRatePpm: 1425,
    taxRatePpm: 3000,
    minFeeCents: 0,
    createdAt: NOW,
    ...overrides,
  };
}

console.log('## 2. 買進排隊與成交');
{
  const order = db.insertOrder(sampleOrder({ reservedCents: 1_100_000 }));
  db.reserveBuy('user:1', order.reserved_cents);
  ok(db.getAccount('user:1').reserved_cents === 1_100_000, '買單保留現金');
  ok(db.getPosition('user:1', '2330') === null, '排隊時還沒有持倉');

  const filled = db.fillBuy(order, {
    priceCents: 100_000,
    grossCents: 1_000_000,
    feeCents: 1_425,
    quote: { source: 'test', asOf: '2026-11-05 13:30' },
    settledAt: '2026-11-05T06:05:00.000Z',
  });
  const account = db.getAccount('user:1');
  const position = db.getPosition('user:1', '2330');
  ok(filled.status === 'filled', '訂單變成 filled');
  ok(account.cash_cents === 98_998_575, `現金扣掉成交金額與手續費（${account.cash_cents}）`);
  ok(account.reserved_cents === 0, '成交後釋放保留現金');
  ok(position.qty === 10 && position.cost_basis_cents === 1_001_425, '持倉股數與成本正確');
  const ledger = db.db.prepare('SELECT * FROM cash_ledger WHERE order_id = ? ORDER BY id').all(order.id);
  ok(ledger.length === 2, '現金流水買入與手續費各一筆');
  ok(ledger.at(-1).balance_after_cents === account.cash_cents, '流水最後餘額等於帳戶現金');
}

console.log('## 3. 部分賣出');
{
  const order = db.insertOrder(sampleOrder({ side: 'sell', qty: 5, reservedQty: 5, sourceMessageId: 'm-sell' }));
  db.reserveSell('user:1', '2330', 5);
  ok(db.getPosition('user:1', '2330').reserved_qty === 5, '賣單保留股票');
  const filled = db.fillSell(order, {
    priceCents: 100_000,
    grossCents: 500_000,
    feeCents: 713,
    taxCents: 1_500,
    quote: { source: 'test', asOf: '2026-11-05 13:30' },
    settledAt: '2026-11-05T06:06:00.000Z',
  });
  const position = db.getPosition('user:1', '2330');
  ok(filled.status === 'filled' && filled.net_cents === 497_787, '賣出淨收入正確');
  ok(position.qty === 5 && position.reserved_qty === 0, '賣出後股數與保留正確');
  ok(position.cost_basis_cents === 500_712, '按比例扣掉成本');
}

console.log('## 4. 拒絕與釋放');
{
  const order = db.insertOrder(sampleOrder({ side: 'buy', qty: 1, reservedCents: 1_100_000, sourceMessageId: 'm-reject' }));
  db.reserveBuy('user:1', order.reserved_cents);
  const before = db.getAccount('user:1').cash_cents;
  const rejected = db.rejectOrder(order, { reason: '測試', settledAt: NOW });
  ok(rejected.status === 'rejected', '訂單變成 rejected');
  ok(db.rejectOrder(order, { reason: '重複', settledAt: NOW }) === null, '已不是 pending 的單回 null，不重複釋放');
  ok(db.getAccount('user:1').reserved_cents === 0, '拒絕後釋放保留現金');
  ok(db.getAccount('user:1').cash_cents === before, '拒絕不改現金餘額');
}

console.log('## 4b. 結算不能動到別筆保留');
{
  db.ensureAccount('user:2', { kind: 'player', startingCashCents: 1_000_000, now: NOW });
  const first = db.insertOrder(sampleOrder({ accountId: 'user:2', reservedCents: 400_000, sourceMessageId: 'm-r1' }));
  db.reserveBuy('user:2', 400_000);
  const second = db.insertOrder(sampleOrder({ accountId: 'user:2', reservedCents: 500_000, sourceMessageId: 'm-r2' }));
  db.reserveBuy('user:2', 500_000);
  assert.throws(() => db.fillBuy(first, {
    priceCents: 100_000,
    grossCents: 600_000,
    feeCents: 0,
    quote: { source: 'test', asOf: NOW },
    settledAt: NOW,
  }), /現金不足/);
  ok(db.getAccount('user:2').cash_cents === 1_000_000, '現金不足時整筆 rollback');
  ok(db.getAccount('user:2').reserved_cents === 900_000, '兩筆保留都還在');
  ok(db.getOrder(first.id).status === 'pending', '訂單仍是 pending');
  db.deleteAccount('user:2');
}

console.log('## 5. 唯一鍵');
{
  const order = sampleOrder({ requestId: 'msg:unique', sourceMessageId: 'm-unique' });
  db.insertOrder(order);
  assert.throws(() => db.insertOrder({ ...order, id: 'ORD-other' }), /UNIQUE|constraint/i);
  ok(true, '同一個 request_id 不能重複插入');
  assert.throws(() => db.insertOrder({ ...order, id: 'ORD-other2', requestId: 'msg:unique2' }), /UNIQUE|constraint/i);
  ok(true, '同一帳戶同一則訊息不能重複下單');
}

console.log('## 6. Bot 回合');
{
  db.insertBotRun({ id: 'br-1', startedAt: NOW, market: 'TW', status: 'running' });
  const updated = db.updateBotRun('br-1', { endedAt: NOW, status: 'hold', tokens: 123, reason: 'HOLD' });
  ok(updated.status === 'hold' && updated.tokens === 123, 'bot_runs 可更新狀態與 token');
  ok(db.botRunsSince('2026-11-05T00:00:00.000Z').length === 1, 'botRunsSince 查得到當日紀錄');

  db.saveDailyReview({ date: '2026-11-04', createdAt: NOW, summary: '昨天的復盤', tokens: 99 });
  const review = db.latestReviewBefore('2026-11-05');
  ok(review?.summary === '昨天的復盤' && review.tokens === 99, 'daily_reviews 可存與讀上一天');
  ok(db.latestReviewBefore('2026-11-04') === null, '只抓日期之前的復盤');
  db.saveDailyReview({ date: '2026-11-04', createdAt: NOW, summary: '覆蓋後', tokens: 100 });
  ok(db.getDailyReview('2026-11-04').summary === '覆蓋後', '同一天重存會覆蓋');
}

console.log('## 7. /forget');
{
  ok(db.deleteAccount('user:1'), '刪除帳戶');
  ok(db.getAccount('user:1') === null, '帳戶消失');
  ok(db.listPositions('user:1').length === 0, '持倉消失');
  ok(db.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE account_id = ?').get('user:1').n === 0, '訂單消失');
  ok(db.db.prepare('SELECT COUNT(*) AS n FROM cash_ledger WHERE account_id = ?').get('user:1').n === 0, '流水消失');
}

console.log('## 8. 備份');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-trade-db-'));
  const file = path.join(dir, 'backup.sqlite');
  ok(db.backup(file) && fs.existsSync(file), 'VACUUM INTO 產生備份檔');
  fs.rmSync(dir, { recursive: true, force: true });
}

db.close();
console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exitCode = failures ? 1 : 0;
