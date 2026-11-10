// 模擬股票交易規則的離線回歸：不需要 Discord、不需要 DSH、不需要網路。
//   node scripts/test-discord-trade.mjs
import assert from 'node:assert/strict';
import { openTradeDb } from '../src/core/discord-trade-db.mjs';
import {
  createTradeService,
  feeCents,
  formatTwd,
  limitPrices,
  marketState,
  pickPlayerIdentity,
  playerAccountId,
  taxCents,
  tickCents,
} from '../src/core/discord-trade.mjs';
import { resolveSymbol } from '../src/core/trade-symbols.mjs';
import { apply as applyToolRestrict } from '../plugins/dc-agent-presets/dc-tool-restrict.mjs';
import { createQuoteProvider } from '../src/core/quote-provider.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const TRADE = {
  enabled: true,
  allowedGuilds: [],
  allowedChannels: [],
  startingCash: 1_000_000,
  maxOrderPct: 30,
  reserveBufferPct: 5,
  fees: { twFeeRate: 0.001425, twTaxRate: 0.003, minFee: 0 },
  slippageRate: 0,
  fx: { source: 'daily', spreadRate: 0.001 },
  settlement: { twCheckMinutes: 10, twSettleAfter: '00:00' },
  bot: {
    enabled: true,
    market: 'TW',
    announceChannelId: '',
    preset: 'dc-trader',
    maxTurnsPerDay: 1,
    maxTradesPerDay: 1,
    minIntervalMin: 60,
    maxOutputTokens: 500,
    maxTokensPerDay: 20_000,
    maxWebSearchesPerTurn: 3,
    maxWebFetchesPerTurn: 2,
    review: { enabled: true, after: '19:10' },
  },
};

function harness({ holidays = new Set(), config = TRADE } = {}) {
  const db = openTradeDb(':memory:');
  let clock = new Date('2026-11-05T02:00:00.000Z'); // 台北 10:00，盤中
  let quote = {
    symbol: '2330',
    name: '台積電',
    exchange: 'TWSE',
    source: 'test',
    date: '2026-11-05',
    closeCents: 100_000,
    changeCents: 0,
    referenceCents: 100_000,
    asOf: '2026-11-05 13:30',
  };
  const quotes = {
    async getLatest() { return quote; },
    async getForDate(_entry, date) { return quote.date === date ? quote : null; },
    async getHolidays() { return new Set(); },
    status() { return []; },
  };
  const service = createTradeService({ db, config, quotes, now: () => clock, holidays, botId: '999' });
  return {
    db,
    service,
    quotes,
    setClock: (iso) => { clock = new Date(iso); },
    setQuote: (patch) => { quote = { ...quote, ...patch }; },
  };
}

const BUY = {
  actorKind: 'player',
  actorId: '42',
  side: 'buy',
  symbol: '2330',
  quantity: 10,
  requestId: 'msg:m1',
  messageId: 'm1',
  guildId: 'g1',
  channelId: 'c1',
};

console.log('## 1. 商品主檔與報價');
{
  ok(resolveSymbol('2330').match?.symbol === '2330', '代號精確命中');
  ok(resolveSymbol('台積').match?.symbol === '2330', '別名命中');
  ok(resolveSymbol('台').candidates.length > 1, '多個候選時回清單');
  ok(resolveSymbol('不存在的股票').candidates.length === 0, '查不到就沒有候選');
}

console.log('## 2. 費用、tick 與漲跌停');
{
  ok(tickCents(999) === 1, '未滿 10 元 tick 0.01');
  ok(tickCents(100_000) === 500, '1000 元以上 tick 5 元');
  const limit = limitPrices(100_000);
  ok(limit.up === 110_000 && limit.down === 90_000, '漲跌停價對齊 tick');
  const ten = limitPrices(1_020); // 10.20 元
  ok(ten.up === 1_120 && ten.down === 918, '漲跌停的 tick 用漲跌停價自己的級距（10.20）');
  const nine = limitPrices(960); // 9.60 元
  ok(nine.up === 1_055 && nine.down === 864, '漲跌停的 tick 用漲跌停價自己的級距（9.60）');
  ok(feeCents(1_000_000, 1425) === 1_425, '手續費無條件進位到分');
  ok(feeCents(1, 1425) === 1, '極小金額至少 1 分');
  ok(feeCents(0, 1425) === 0, '零金額不收費');
  ok(feeCents(100, 1425, 2_000) === 2_000, '最低手續費生效');
  ok(taxCents(500_000, 3000) === 1_500, '證交稅計算');
  ok(formatTwd(100_000) === 'NT$1,000.00', '金額顯示到分');
}

console.log('## 3. 市場狀態');
{
  ok(marketState(new Date('2026-11-05T02:00:00Z')).open === true, '台北 10:00 盤中');
  ok(marketState(new Date('2026-11-05T05:40:00Z')).open === false, '台北 13:40 已收盤');
  ok(marketState(new Date('2026-11-07T02:00:00Z')).open === false, '週六休市');
  ok(marketState(new Date('2026-11-07T02:00:00Z')).nextOpen === '2026-11-09 09:00', '週六休市時給下一次開盤');
  ok(marketState(new Date('2026-11-05T05:40:00Z')).nextOpen === '2026-11-06 09:00', '收盤後給下一次開盤');
  const newYear = marketState(new Date('2026-12-31T05:40:00Z'));
  ok(newYear.nextOpen === '2027-01-04 09:00', '跨年跳過 01-01 休市');
  ok(marketState(new Date('2026-11-05T02:00:00Z'), new Set(['2026-11-05'])).open === false, '行事曆休市');
  const gap = marketState(new Date('2026-11-05T06:10:00Z')); // 14:10
  ok(gap.canOrder === false && gap.nextOrderAt === '2026-11-05 14:50', '13:30–14:50 不能下單，下一段是 14:50');
  const evening = marketState(new Date('2026-11-05T07:00:00Z')); // 15:00
  ok(evening.canOrder === true && evening.orderDate === '2026-11-06', '14:50 後可以預約下一交易日');
  const early = marketState(new Date('2026-11-05T00:30:00Z')); // 08:30
  ok(early.canOrder === true && early.orderDate === '2026-11-05', '09:00 前是當日預約單');
  const weekend = marketState(new Date('2026-11-07T03:00:00Z')); // 週六 11:00
  ok(weekend.canOrder === true && weekend.orderDate === '2026-11-09', '週末預約單排到週一');
  ok(marketState(new Date('2026-11-05T00:59:00Z')).canOrder === true, '08:59 仍是預約單');
  ok(marketState(new Date('2026-11-05T01:00:00Z')).phase === 'open', '09:00 開盤');
  ok(marketState(new Date('2026-11-05T05:29:00Z')).phase === 'open', '13:29 盤中');
  ok(marketState(new Date('2026-11-05T05:30:00Z')).canOrder === false, '13:30 起停止下單');
  ok(marketState(new Date('2026-11-05T06:49:00Z')).canOrder === false, '14:49 還不能下單');
  ok(marketState(new Date('2026-11-05T06:50:00Z')).orderDate === '2026-11-06', '14:50 開始預約');
  ok(marketState(new Date('2026-11-06T15:59:00Z')).orderDate === '2026-11-09', '週五 23:59 預約排到週一');
  ok(marketState(new Date('2026-12-31T07:00:00Z')).orderDate === '2027-01-04', '跨年預約跳過 01-01');
}

console.log('## 4. 排隊買入');
const h = harness();
{
  const result = await h.service.placeOrder(BUY);
  const order = result.order;
  const account = h.db.getAccount(playerAccountId('42'));
  ok(result.duplicate === false && order.status === 'pending', '建立 pending 訂單');
  ok(order.qty === 10 && order.reserved_cents > 1_000_000, '買單用漲停價保留現金');
  ok(account.reserved_cents === order.reserved_cents, '帳戶保留現金與訂單一致');
  ok(account.cash_cents === 100_000_000, '排隊不扣現金');
  ok(h.db.getPosition(playerAccountId('42'), '2330') === null, '排隊不增加持倉');
  const again = await h.service.placeOrder(BUY);
  ok(again.duplicate === true && again.order.id === order.id, '同一筆訊息重送回原訂單');
}

console.log('## 4b. 預約單');
{
  const pre = harness();
  pre.setClock('2026-11-05T07:00:00.000Z'); // 台北 15:00，已收盤
  const result = await pre.service.placeOrder(BUY);
  ok(result.order.trade_date === '2026-11-06', '15:00 的預約單排到下一交易日');
  pre.setQuote({ date: '2026-11-06' }); // 來源先偷跑週五資料，也不能提早結算
  pre.setClock('2026-11-05T11:05:00.000Z'); // 當天 19:05
  const tonight = await pre.service.settleDue();
  ok(tonight.length === 0 && pre.db.findOrderByRequest('msg:m1').status === 'pending', '當天晚上不結算下一交易日的預約單');
  pre.setClock('2026-11-06T11:05:00.000Z'); // 隔天 19:05
  const events = await pre.service.settleDue();
  ok(events[0]?.type === 'filled', '下一交易日收盤後才成交');
  ok(pre.db.findOrderByRequest('msg:m1').status === 'filled', '預約單成交狀態正確');

  const replay = harness();
  replay.setClock('2026-11-05T05:29:00.000Z'); // 13:29 下單
  const firstOrder = await replay.service.placeOrder(BUY);
  replay.setClock('2026-11-05T05:35:00.000Z'); // 13:35 重送同一則
  const again = await replay.service.placeOrder(BUY);
  ok(again.duplicate === true && again.order.id === firstOrder.order.id, '重送已存在的單不會被時間窗擋下');

  const early = harness();
  early.setClock('2026-11-05T00:30:00.000Z'); // 台北 08:30
  ok((await early.service.placeOrder(BUY)).order.trade_date === '2026-11-05', '早上 09:00 前是當日預約單');

  const closed = harness();
  closed.setClock('2026-11-05T06:10:00.000Z'); // 台北 14:10
  await assert.rejects(closed.service.placeOrder(BUY), /14:50/);
  ok(true, '13:30–14:50 不能下單，訊息指向 14:50');

  const weekend = harness();
  weekend.setClock('2026-11-07T03:00:00.000Z'); // 週六 11:00
  ok((await weekend.service.placeOrder(BUY)).order.trade_date === '2026-11-09', '週末預約單排到週一');

  const ref = harness();
  ref.setClock('2026-11-05T07:00:00.000Z'); // 週四 15:00，預約週五
  ref.setQuote({ date: '2026-11-05', closeCents: 109_000, changeCents: 9_000, referenceCents: 100_000 });
  const refOrder = await ref.service.placeOrder(BUY);
  ok(refOrder.order.trade_date === '2026-11-06', '預約單記在週五');
  ok(refOrder.order.reserved_cents === 1_196_703, `保留額用週五的參考價（${refOrder.order.reserved_cents}）`);

  const stalePre = harness();
  stalePre.setClock('2026-11-05T07:00:00.000Z');
  stalePre.setQuote({ date: '2026-11-03', closeCents: 100_000, changeCents: 0, referenceCents: 100_000 });
  await assert.rejects(stalePre.service.placeOrder(BUY), /資料太舊/);
  ok(true, '預約單的報價基準看下一個交易日（只到週二就拒絕）');

  const typhoonSet = new Set();
  const typhoon = harness({ holidays: typhoonSet });
  typhoon.setClock('2026-11-05T07:00:00.000Z');
  ok((await typhoon.service.placeOrder(BUY)).order.trade_date === '2026-11-06', '週四晚上先預約週五');
  typhoonSet.add('2026-11-06'); // 週五當天才宣布颱風假
  typhoon.setClock('2026-11-06T11:05:00.000Z'); // 週五 19:05
  const typhoonEvents = await typhoon.service.settleDue();
  ok(typhoonEvents[0]?.type === 'rejected' && /休市/.test(typhoonEvents[0].order.reject_reason), '預約日後來變休市就失效');
  ok(typhoon.db.getAccount(playerAccountId('42')).reserved_cents === 0, '休市失效後釋放保留');
}

console.log('## 5. 收盤結算（買）');
{
  h.setClock('2026-11-05T06:05:00.000Z'); // 台北 14:05
  const events = await h.service.settleDue();
  const account = h.db.getAccount(playerAccountId('42'));
  const position = h.db.getPosition(playerAccountId('42'), '2330');
  ok(events.length === 1 && events[0].type === 'filled', '收盤資料到了才成交');
  ok(account.cash_cents === 98_998_575, `現金扣成交金額與手續費（${account.cash_cents}）`);
  ok(account.reserved_cents === 0, '成交後釋放保留現金');
  ok(position.qty === 10 && position.cost_basis_cents === 1_001_425, '持倉成本含手續費');
  ok((await h.service.settleDue()).length === 0, '已成交的單不會重複結算');
}

console.log('## 5b. 19:00 前不結算');
{
  const late = harness({ config: { ...TRADE, settlement: { twCheckMinutes: 10, twSettleAfter: '19:00' } } });
  await late.service.placeOrder(BUY);
  late.setClock('2026-11-05T06:05:00.000Z'); // 台北 14:05，資料已可用
  const early = await late.service.settleDue();
  ok(early.length === 0, '19:00 前就算有資料也不結算');
  late.setClock('2026-11-05T11:05:00.000Z'); // 台北 19:05
  const evening = await late.service.settleDue();
  ok(evening[0]?.type === 'filled', '19:00 後才結算');
}

console.log('## 6. 資產與損益');
{
  const portfolio = await h.service.portfolio(playerAccountId('42'));
  ok(portfolio.navCents === 99_998_575, '淨值 = 現金 + 持股市值');
  ok(portfolio.unrealizedCents === -1_425, '未實現損益扣掉買進成本');
  ok(portfolio.realizedCents === 0, '還沒賣出，已實現為 0');
  ok(portfolio.returnPct < 0, '報酬率為負（手續費）');
}

console.log('## 7. 賣出與已實現損益');
{
  h.setClock('2026-11-05T02:30:00.000Z'); // 回到盤中才能排隊賣單
  const result = await h.service.placeOrder({ ...BUY, side: 'sell', quantity: 5, requestId: 'msg:m2', messageId: 'm2' });
  ok(result.order.status === 'pending' && result.order.reserved_qty === 5, '賣單保留股票');
  h.setClock('2026-11-05T06:06:00.000Z');
  const events = await h.service.settleDue();
  const position = h.db.getPosition(playerAccountId('42'), '2330');
  ok(events[0]?.type === 'filled', '賣單成交');
  ok(position.qty === 5 && position.reserved_qty === 0, '賣出後股數正確');
  const portfolio = await h.service.portfolio(playerAccountId('42'));
  ok(portfolio.realizedCents === -2_926, `已實現損益正確（${portfolio.realizedCents}）`);
}

console.log('## 8. 限制');
{
  h.setClock('2026-11-05T02:40:00.000Z');
  await assert.rejects(
    h.service.placeOrder({ ...BUY, quantity: 400, requestId: 'msg:m3', messageId: 'm3' }),
    /30%/,
  );
  ok(true, '單筆超過 30% 淨值被拒絕');
  const h10 = harness();
  await assert.rejects(
    h10.service.placeOrder({ ...BUY, actorId: '99', quantity: 400, requestId: 'msg:m10', messageId: 'm10' }),
    /30%/,
  );
  ok(h10.db.getAccount(playerAccountId('99')) === null, '被拒絕的單不會留下空帳戶');

  await assert.rejects(
    h.service.placeOrder({ ...BUY, side: 'sell', quantity: 100, requestId: 'msg:m4', messageId: 'm4' }),
    /持股不足/,
  );
  ok(true, '賣出超過可用持股被拒絕');

  await assert.rejects(
    h.service.placeOrder({ ...BUY, quantity: 0, requestId: 'msg:m5', messageId: 'm5' }),
    /股數/,
  );
  ok(true, '股數 0 被拒絕');

  await assert.rejects(
    h.service.placeOrder({ ...BUY, symbol: '9999', requestId: 'msg:m6', messageId: 'm6' }),
    /可交易清單/,
  );
  ok(true, '白名單外的代號被拒絕');
}

console.log('## 9. 反向 pending 與休市');
{
  const buy = await h.service.placeOrder({ ...BUY, quantity: 1, requestId: 'msg:m7', messageId: 'm7' });
  ok(buy.order.status === 'pending', '先排一筆買單');
  await assert.rejects(
    h.service.placeOrder({ ...BUY, side: 'sell', quantity: 1, requestId: 'msg:m8', messageId: 'm8' }),
    /反向/,
  );
  ok(true, '同標的同日反向單被拒絕');
  h.setClock('2026-11-05T05:40:00.000Z'); // 13:40
  await assert.rejects(
    h.service.placeOrder({ ...BUY, quantity: 1, requestId: 'msg:m9', messageId: 'm9' }),
    /不能下單/,
  );
  ok(true, '收盤後不接受新單');
}

console.log('## 9b. 盤中參考價用前一日收盤');
{
  const h7 = harness();
  // 昨天從 1000 漲到 1090；今天的參考價是 1090，今天漲停 1195（不是昨天的 1100）。
  h7.setQuote({ date: '2026-11-04', closeCents: 109_000, changeCents: 9_000, referenceCents: 100_000 });
  const placed = await h7.service.placeOrder(BUY);
  const reserved = placed.order.reserved_cents;
  ok(reserved > 1_101_568, `保留額用今天的參考價估算（${reserved} > 昨天的 1101568）`);
  // 今天收 1150，高於昨天算出來的漲停 1100，但低於今天的漲停 1195 → 應該成交。
  h7.setQuote({ date: '2026-11-05', closeCents: 115_000, changeCents: 6_000, referenceCents: 109_000 });
  h7.setClock('2026-11-05T06:05:00.000Z');
  const events = await h7.service.settleDue();
  ok(events[0]?.type === 'filled', '收盤價高於昨天的漲停價仍然成交（沒有用錯參考價）');
}

console.log('## 9b2. 連假後與資料落後');
{
  const holidays = new Set(['2026-02-12', '2026-02-13', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']);
  const holidayHarness = harness({ holidays });
  holidayHarness.setClock('2026-02-23T02:00:00.000Z'); // 春節後第一個交易日
  holidayHarness.setQuote({ date: '2026-02-11', closeCents: 100_000, changeCents: 0, referenceCents: 100_000 });
  const placed = await holidayHarness.service.placeOrder(BUY);
  ok(placed.order.status === 'pending', '連假後用節前收盤價可以下單');

  const stale = harness();
  stale.setClock('2026-11-06T02:00:00.000Z');
  stale.setQuote({ date: '2026-11-02', closeCents: 100_000, changeCents: 0, referenceCents: 100_000 });
  await assert.rejects(stale.service.placeOrder(BUY), /資料太舊/);
  ok(true, '落後超過兩個交易日就拒絕');

  const extra = harness({ config: { ...TRADE, extraHolidays: ['2026-11-05'] } });
  const extraState = await extra.service.state();
  ok(extraState.phase === 'holiday', 'config 的 extraHolidays 算休市日');
  ok(extraState.canOrder === true && extraState.orderDate === '2026-11-06', '臨時休市日照樣可以預約下一交易日');
}

console.log('## 9b3. 名稱比對與 rollback');
{
  const partial = harness();
  await assert.rejects(
    partial.service.placeOrder({ ...BUY, symbol: '環球', requestId: 'msg:partial', messageId: 'partial' }),
    /可交易清單/,
  );
  ok(true, '下單只接受代號、完整名稱或唯一別名');

  const sell = harness();
  await assert.rejects(
    sell.service.placeOrder({ ...BUY, actorId: '97', side: 'sell', quantity: 1, requestId: 'msg:sell-new', messageId: 'sell-new' }),
    /持股不足/,
  );
  ok(sell.db.getAccount(playerAccountId('97')) === null, '交易內失敗不會留下空帳戶');
}

console.log('## 9c. 盤中不結算');
{
  const h8 = harness();
  await h8.service.placeOrder(BUY);
  const events = await h8.service.settleDue();
  ok(events.length === 0, '盤中就算來源先有今天的資料也不結算');
  ok(h8.db.findOrderByRequest('msg:m1').status === 'pending', '訂單仍是 pending');
}

console.log('## 9d. 停牌／當天沒資料');
{
  const h9 = harness();
  await h9.service.placeOrder(BUY);
  h9.quotes.getForDate = async () => null;
  h9.quotes.dataDate = async () => '2026-11-06';
  h9.setClock('2026-11-06T06:05:00.000Z');
  const events = await h9.service.settleDue();
  ok(events[0]?.type === 'rejected' && /逾期/.test(events[0].order.reject_reason), '來源日期已前進但這檔沒資料 → 拒絕');
  ok(h9.db.getAccount(playerAccountId('42')).reserved_cents === 0, '拒絕後釋放保留');
}

console.log('## 10. 漲停與逾期');
{
  const h2 = harness();
  await h2.service.placeOrder(BUY);
  h2.setQuote({ closeCents: 110_000 });
  h2.setClock('2026-11-05T06:05:00.000Z');
  const events = await h2.service.settleDue();
  ok(events[0]?.type === 'rejected' && /漲停/.test(events[0].order.reject_reason), '收盤漲停買單不成交');
  ok(h2.db.getAccount(playerAccountId('42')).reserved_cents === 0, '漲停拒絕後釋放保留');

  const h3 = harness();
  await h3.service.placeOrder(BUY);
  h3.setClock('2026-11-06T06:05:00.000Z'); // 隔天收盤後
  h3.setQuote({ date: '2026-11-06' });
  const stale = await h3.service.settleDue();
  ok(stale[0]?.type === 'rejected' && /逾期/.test(stale[0].order.reject_reason), '超過一個交易日未結算就拒絕');
  ok(h3.db.getAccount(playerAccountId('42')).reserved_cents === 0, '逾期拒絕後釋放保留');
}

console.log('## 11. 排行榜');
{
  const h4 = harness();
  await h4.service.placeOrder(BUY);
  h4.setClock('2026-11-05T06:05:00.000Z');
  await h4.service.settleDue();
  h4.db.ensureAccount(playerAccountId('7'), { kind: 'player', startingCashCents: 100_000_000, now: '2026-11-05T00:00:00.000Z' });
  h4.db.touchGuild(playerAccountId('7'), 'g1', '2026-11-05T00:00:00.000Z');
  const board = await h4.service.leaderboard({ guildId: 'g1' });
  ok(board.rows.length === 3, '排行榜含兩個玩家與 Bot');
  ok(board.rows[0].accountId === playerAccountId('7'), '報酬率 0 的玩家排第一');
  ok(board.rows.some((row) => row.kind === 'bot'), 'Bot 也在榜上');
}

console.log('## 12. Bot 下單與停用');
{
  const h5 = harness();
  const result = await h5.service.placeOrder({
    actorKind: 'bot', actorId: '999', side: 'buy', symbol: '2330', quantity: 1,
    requestId: 'run:br-1', reason: '測試',
  });
  ok(result.order.account_id === 'bot:999', 'Bot 訂單記在自己的帳戶');
  const first = await h5.service.placeOrder({
    actorKind: 'bot', actorId: '999', side: 'buy', symbol: '2330', quantity: 1,
    requestId: 'run:br-2',
  });
  ok(first.order.status === 'pending', '第二輪 Bot 可以再下一筆（排程次數由上層管）');

  const disabled = createTradeService({
    db: openTradeDb(':memory:'),
    config: { ...TRADE, enabled: false },
    quotes: h5.quotes,
    now: () => new Date('2026-11-05T02:00:00.000Z'),
  });
  await assert.rejects(disabled.placeOrder(BUY), /沒有開啟/);
  ok(true, '功能關閉時拒絕下單');
}

console.log('## 13. /forget');
{
  const h6 = harness();
  await h6.service.placeOrder(BUY);
  ok(h6.service.forgetAccount('42') === true, '刪除玩家交易資料');
  ok(h6.db.getAccount(playerAccountId('42')) === null, '帳戶已刪除');
  ok(h6.db.getAccount('bot:999') !== null, 'Bot 帳戶不受影響');
}

console.log('## 14. 下單身分');
{
  const users = [{ userId: '42', name: '小明' }, { userId: '43', name: '小美' }];
  const directs = [{ id: 'm1', userId: '42' }, { id: 'm2', userId: '43' }];
  const lookup = (ref) => ({ '#m1': 'm1', m1: 'm1', '#m2': 'm2', m2: 'm2' }[ref] ?? null);

  const one = pickPlayerIdentity({ users, directs, message: '#m1', lookup });
  ok(one.userId === '42' && one.messageId === 'm1', '指定 ★ 訊息可以下單');

  assert.throws(() => pickPlayerIdentity({ users, directs, message: '', lookup, requireMessage: true }), /#編號/);
  ok(true, '下單沒帶訊息就拒絕');

  assert.throws(() => pickPlayerIdentity({ users, directs, message: '', lookup }), /多個觸發者/);
  ok(true, '多人合批沒指定訊息就拒絕');

  assert.throws(() => pickPlayerIdentity({ users, directs, message: '#nope', lookup }), /不是這一輪/);
  ok(true, '指到不存在的訊息就拒絕');

  assert.throws(
    () => pickPlayerIdentity({ users: [{ userId: '42' }], directs: [{ id: 'm2', userId: '43' }], message: '#m2', lookup }),
    /不是這一輪的觸發者/,
  );
  ok(true, '訊息作者不在觸發者名單就拒絕');

  const single = pickPlayerIdentity({ users: [{ userId: '42' }], directs: [{ id: 'm1', userId: '42' }], lookup });
  ok(single.userId === '42' && single.messageId === 'm1', '只有一個觸發者時可省略訊息');

  assert.throws(() => pickPlayerIdentity({ users: [], directs: [], lookup }), /沒有明確的觸發者/);
  ok(true, '沒有觸發者就拒絕（自由參與／回訪）');
}

console.log('## 15. 工具權限');
{
  function restrictHarness(config) {
    const denied = [];
    let guard = null;
    applyToolRestrict({
      tools: {
        restrict: ({ deny }) => { denied.push(...deny); },
        guard: (fn) => { guard = fn; },
      },
    }, config);
    return { denied, guard };
  }
  const player = restrictHarness({ trade: 'player', allowDiscordSend: false });
  ok(!player.denied.includes('mcp__trade__get_quote'), '玩家放行查價');
  ok(player.denied.includes('mcp__trade__bot_place_order'), '玩家看不到 Bot 下單');
  ok(player.guard({ name: 'mcp__trade__bot_place_order' }) !== undefined, '玩家 guard 擋 Bot 下單');
  ok(player.guard({ name: 'mcp__trade__get_quote' }) === undefined, '玩家 guard 放行查價');

  const bot = restrictHarness({ trade: 'bot', allowDiscordSend: false });
  ok(!bot.denied.includes('mcp__trade__bot_place_order'), 'Bot 放行自己的下單');
  ok(bot.denied.includes('mcp__trade__place_order'), 'Bot 看不到玩家下單');
  ok(bot.guard({ name: 'mcp__trade__place_order' }) !== undefined, 'Bot guard 擋玩家下單');
  ok(bot.guard({ name: 'mcp__trade__bot_place_order' }) === undefined, 'Bot guard 放行自己的下單');

  const none = restrictHarness({ trade: 'none' });
  ok(none.denied.includes('mcp__trade__get_quote'), '沒有開交易時全部藏起來');
  ok(none.guard({ name: 'mcp__trade__get_quote' }) !== undefined, '沒有開交易時 guard 也擋');
}

console.log('## 16. 報價來源快取與重試');
{
  let calls = 0;
  let fail = true;
  const rows = [{ Date: '1151104', Code: '2330', Name: '台積電', ClosingPrice: '1000.00', Change: '0.00' }];
  const provider = createQuoteProvider({
    log: () => {},
    fetchImpl: () => {
      calls += 1;
      if (fail) throw new Error('boom');
      return Promise.resolve(rows);
    },
  });
  const first = await provider.getLatest({ symbol: '2330', exchange: 'TWSE' });
  ok(first === null && calls === 1, '來源失敗回 null，不編價格');
  fail = false;
  const second = await provider.getLatest({ symbol: '2330', exchange: 'TWSE' });
  ok(second?.closeCents === 100_000 && calls === 2, '失敗後會重試（inflight 沒有卡住）');
  const third = await provider.getLatest({ symbol: '2330', exchange: 'TWSE' });
  ok(third?.closeCents === 100_000 && calls === 2, '成功後 5 分鐘內用快取');
}

console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exitCode = failures ? 1 : 0;
