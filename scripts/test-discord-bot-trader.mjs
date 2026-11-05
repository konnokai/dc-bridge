// Bot 交易員的離線回歸：排程判斷、prompt 與公告文字。
//   node scripts/test-discord-bot-trader.mjs
import { buildBotPrompt, buildReviewPrompt, canRunBot, canRunReview, formatPlayerNotice, formatReviewNotice, formatTradeNotice } from '../src/core/bot-trader.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const CONFIG = {
  enabled: true,
  market: 'TW',
  maxTurnsPerDay: 1,
  maxTradesPerDay: 1,
  minIntervalMin: 60,
  maxOrderPct: 30,
};
const OPEN = { open: true, label: '盤中（09:00–13:30）', date: '2026-11-05' };
const NOW = Date.parse('2026-11-05T02:00:00.000Z');

console.log('## 1. 排程判斷');
{
  const base = { config: CONFIG, market: OPEN, runsToday: 0, tradesToday: 0, lastRunAt: 0, now: NOW };
  ok(canRunBot(base).ok === true, '盤中、還沒跑過就啟動');
  ok(canRunBot({ ...base, config: { ...CONFIG, enabled: false } }).ok === false, 'Bot 關閉不啟動');
  ok(canRunBot({ ...base, market: { open: false, label: '已收盤' } }).ok === false, '休市不啟動');
  ok(canRunBot({ ...base, runsToday: 1 }).ok === false, '每日決策次數用完不啟動');
  ok(canRunBot({ ...base, tradesToday: 1 }).ok === false, '每日下單次數用完不啟動');
  ok(canRunBot({ ...base, lastRunAt: NOW - 30 * 60_000 }).ok === false, '間隔不到 60 分鐘不啟動');
  ok(canRunBot({ ...base, lastRunAt: NOW - 61 * 60_000 }).ok === true, '間隔夠了可以啟動');
}

console.log('## 2. Prompt');
{
  const prompt = buildBotPrompt({
    portfolio: {
      exists: true,
      cashCents: 98_998_575,
      reservedCents: 0,
      navCents: 99_998_575,
      returnPct: -0.001425,
      positions: [{
        symbol: '2330', name: '台積電', qty: 10,
        avgCostCents: 100_142, priceCents: 100_000,
        unrealizedCents: -1_425,
      }],
    },
    market: OPEN,
    now: new Date(NOW),
    config: CONFIG,
  });
  ok(prompt.includes('台積電') && prompt.includes('2330'), 'Prompt 帶持股');
  ok(prompt.includes('NT$989,985.75'), 'Prompt 帶現金');
  ok(prompt.includes('30%'), 'Prompt 帶單筆上限');
  ok(prompt.includes('HOLD'), 'Prompt 說明不交易要輸出 HOLD');
  ok(prompt.includes('收盤後才結算'), 'Prompt 說明不是即時成交');
  ok(!prompt.includes('user:'), 'Prompt 不帶玩家帳戶 id');

  const withReview = buildBotPrompt({
    portfolio: { exists: true, cashCents: 100, reservedCents: 0, navCents: 100, returnPct: 0, positions: [] },
    market: OPEN,
    now: new Date(NOW),
    config: CONFIG,
    lastReview: { date: '2026-11-04', summary: '昨天外資賣超，今天先觀望' },
  });
  ok(withReview.includes('上一次收盤復盤') && withReview.includes('外資賣超'), '隔天決策會帶上一次復盤');
}

console.log('## 3. 公告文字');
{
  const buy = {
    symbol: '2330', side: 'buy', qty: 10, fill_price_cents: 100_000,
    fee_cents: 1_425, tax_cents: 0, net_cents: -1_001_425, reason: null,
  };
  const notice = formatTradeNotice(buy, '台積電');
  ok(notice.includes('模擬成交') && notice.includes('買入') && notice.includes('NT$1,000.00'), '買進公告');
  ok(notice.includes('模擬交易'), '公告有模擬聲明');
  const sell = { ...buy, side: 'sell', fee_cents: 713, tax_cents: 1_500, net_cents: 497_787 };
  ok(formatTradeNotice(sell, '台積電').includes('證交稅'), '賣出公告有證交稅');
  const rejected = { ...buy, side: 'buy', reject_reason: '收盤漲停，買單不成交' };
  ok(formatPlayerNotice(rejected, '台積電', 'rejected').includes('未成交'), '玩家拒絕公告');
}

console.log('## 4. 沒有帳戶');
{
  const prompt = buildBotPrompt({ portfolio: { exists: false }, market: OPEN, now: new Date(NOW), config: CONFIG });
  ok(prompt.includes('還沒建立'), '沒有帳戶時提示先查');
}

console.log('## 5. 當日復盤');
{
  const review = { enabled: true, after: '19:10' };
  const after = { phase: 'after', open: false, label: '已收盤（13:30）', date: '2026-11-05', minutes: 19 * 60 + 5 };
  ok(canRunReview({ config: review, market: after, runsToday: 0 }).ok === false, '19:05 還沒到 19:10');
  const at1911 = { ...after, minutes: 19 * 60 + 11 };
  ok(canRunReview({ config: review, market: at1911, runsToday: 0 }).ok === true, '19:11 可以復盤');
  ok(canRunReview({ config: review, market: at1911, runsToday: 1 }).ok === false, '一天只復盤一次');
  ok(canRunReview({ config: { ...review, enabled: false }, market: at1911, runsToday: 0 }).ok === false, '關閉就不復盤');
  ok(canRunReview({ config: review, market: OPEN, runsToday: 0 }).ok === false, '盤中不復盤');

  const prompt = buildReviewPrompt({
    portfolio: {
      exists: true, cashCents: 98_998_575, navCents: 99_998_575, returnPct: -0.001425,
      realizedCents: 0, unrealizedCents: -1_425,
      positions: [{ symbol: '2330', name: '台積電', qty: 10, avgCostCents: 100_142, priceCents: 100_000, unrealizedCents: -1_425 }],
    },
    market: at1911,
    institutional: new Map([['2330', { foreignNet: -2_160_000, trustNet: 371_000, dealerNet: 0, totalNet: -1_192_000 }]]),
    material: new Map([['2330', [{ time: '14:05', subject: '公告第三季財報', clause: '第31款' }]]]),
    now: new Date(NOW),
  });
  ok(prompt.includes('【當日復盤】'), '復盤 prompt 有標題');
  ok(prompt.includes('不能下單') && prompt.includes('bot_place_order'), '復盤 prompt 禁止下單');
  ok(prompt.includes('外資 -2,160 張') && prompt.includes('投信 +371 張'), '復盤 prompt 帶法人資料');
  ok(prompt.includes('重大訊息') && prompt.includes('公告第三季財報'), '復盤 prompt 帶重大訊息');
  ok(prompt.includes('web_search'), '復盤 prompt 指示補新聞');
  ok(prompt.includes('4~8 行') && prompt.includes('一行一個重點'), '復盤 prompt 要求一行一個重點');
  ok(prompt.includes('粗體'), '復盤 prompt 要求粗體數字');
  ok(formatReviewNotice('2026-11-05', '今天小賠').startsWith('🤖 當日復盤'), '復盤公告有標題');

  // 2026-11-05 實際復盤的形狀：一整段、沒有換行。
  const blob = '今日大盤重挫，加權指數收在 41,574.72 點，下跌 1,374.19 點、跌幅約 3.2%。我這邊目前是全現金、沒有持股，所以今天損益為 NT$0.00，報酬率 0.00%。法人動向方面，外資賣超約 1,024.6 億元，投信則逆勢買超約 225 億元。';
  const notice = formatReviewNotice('2026-11-05', blob);
  const body = notice.split('\n').slice(1);
  ok(body.length === 3, '一整段復盤拆成一句一行');
  ok(body[0].includes('**41,574.72 點**') && body[0].includes('**3.2%**'), '點數與百分比用粗體');
  ok(body[1]?.includes('**NT$0.00**') === true, '金額用粗體');
  ok(!notice.includes('****'), '粗體標記不會疊在一起');
  ok(notice.replace(/\*\*/g, '').replace(/\n/g, '') === `🤖 當日復盤（2026-11-05）${blob}`, '拆行與加粗沒有增刪文字');

  const kept = formatReviewNotice('2026-11-05', '**今日損益**：NT$0.00\n**持股**：目前全現金\n- 2330 台積電：**+1,425 元**');
  ok(kept === '🤖 當日復盤（2026-11-05）\n**今日損益**：NT$0.00\n**持股**：目前全現金\n- 2330 台積電：**+1,425 元**', '模型已經用粗體時原樣保留');

  // 行首是 ** 或負數時，不能被當成清單記號而整行不拆。
  const boldStart = '**今日損益**：NT$0.00，報酬率 0.00%。今日大盤重挫，加權指數收在 41,574.72 點。法人動向方面，外資賣超約 1,024.6 億元。';
  const boldStartNotice = formatReviewNotice('2026-11-05', boldStart);
  ok(boldStartNotice.split('\n').length === 4, '行首是 ** 的整段還是會拆句');

  const negative = '-1,374 點，大盤收在 41,574.72 點。法人賣超 1,024.6 億元。投信買超 225 億元。';
  const negativeNotice = formatReviewNotice('2026-11-05', negative);
  ok(negativeNotice.split('\n').length === 4, '行首是負數的整段會拆句');
  ok(negativeNotice.includes('**-1,374 點**'), '負數開頭的數字會加粗');

  const quoted = '有人說「今天跌 3%。」然後市場繼續走弱，外資賣超約 1,024.6 億元。投信買超 225 億元。大盤收在 41,574.72 點。';
  const quotedNotice = formatReviewNotice('2026-11-05', quoted);
  ok(quotedNotice.split('\n').every((line) => !line.startsWith('」')), '拆句不會把引號丟到下一行');

  const repeated = '外資狂賣！！！投信也賣。大盤跌破 42K，收在 41,574.72 點。';
  const repeatedNotice = formatReviewNotice('2026-11-05', repeated);
  ok(repeatedNotice.split('\n').every((line) => !/^[。！？]+$/.test(line)), '重複標點不會拆出只有標點的行');
}

console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exitCode = failures ? 1 : 0;
