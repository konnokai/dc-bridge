// /ask 私人回合的狀態機：只認提問後的回合、逾時後等到 turn/end 才解除保護。
//   node scripts/test-discord-ask.mjs
import { askBlockReason, createAskTurn, turnsFromRecords } from '../src/core/discord-ask.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✓ ${label}`);
  else { failures += 1; console.error(`✗ ${label}`); }
}

/** 假時鐘：只跑已到期且還活著的 timer，回呼新排的 timer 也會在同一輪檢查。 */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimer(fn, ms) {
      const timer = { fn, at: now + Math.max(0, ms), live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.live = false; },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.find((timer) => timer.live && timer.at <= now);
        if (!due) return;
        due.live = false;
        due.fn();
      }
    },
  };
}

function harness({ baselineTurn = 0, timeoutMs = 1000, closeGraceMs = 100, hardCloseMs = 60_000 } = {}) {
  const clock = fakeClock();
  const starts = [];
  const settles = [];
  const closes = [];
  const timeouts = [];
  const turn = createAskTurn({
    baselineTurn,
    timeoutMs,
    closeGraceMs,
    hardCloseMs,
    onStart: (value, info) => starts.push({ turn: value, ...info }),
    onSettle: (value) => settles.push(value),
    onClose: (info) => closes.push(info),
    onTimeout: () => timeouts.push(true),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { turn, clock, starts, settles, closes, timeouts };
}

const start = (turnNo) => ({ type: 'turn/start', data: { turn: turnNo } });
const message = (turnNo, text) => ({
  type: 'assistant/message',
  data: { turn: turnNo, message: { content: [{ type: 'text', text }] } },
});
const end = (turnNo, kind = 'completed') => ({ type: 'turn/end', data: { turn: turnNo, reason: { kind } } });

// 1. 提問前就在跑的回合不能當答案
{
  const h = harness({ baselineTurn: 7 });
  ok(h.turn.push(message(7, '上一輪的想法')) === false, 'baseline 以前（含）的 assistant/message 不碰');
  ok(h.turn.push(end(7)) === false, 'baseline 以前的 turn/end 不碰');
  ok(h.starts.length === 0 && h.settles.length === 0, '舊回合不會被認領或結算');
  ok(h.turn.phase === 'waiting', '還在等自己的回合');
  // DSH 重啟後 turn 編號可能歸零：閘門已確認沒有別的回合時，第一個 turn/start 就是我們的。
  ok(h.turn.push(start(3)) === true, 'turn/start 編號比 baseline 小也會認領（DSH 重啟）');
  ok(h.starts.length === 1 && h.starts[0].turn === 3, '認領到重啟後的回合');
}

// 2. 正常回答：turn/start → 文字 → turn/end
{
  const h = harness({ baselineTurn: 7 });
  ok(h.turn.push(start(8)) === true, '自己的 turn/start 被吃掉');
  ok(h.starts.length === 1 && h.starts[0].turn === 8 && h.starts[0].late === false, 'onStart 帶回合編號');
  ok(h.turn.hasTurn === true && h.turn.phase === 'running', '回合進行中');
  ok(h.turn.push(message(8, '我的想法')) === true, '自己的 assistant/message 被吃掉');
  ok(h.turn.push(end(8)) === true, '自己的 turn/end 被吃掉');
  ok(h.settles.length === 1 && h.settles[0].kind === 'answer' && h.settles[0].text === '我的想法', '結算成 answer');
  ok(h.closes.length === 1, '收尾一次');
  ok(h.timeouts.length === 0, '正常回答不會觸發取消');
  ok(h.turn.phase === 'closed', '關閉後不再收事件');
}

// 3. 事件流接得晚：沒有 turn/start，assistant/message 也要認得是自己的回合
{
  const h = harness({ baselineTurn: 7 });
  ok(h.turn.push(message(8, '遲到的文字')) === true, '沒有 start 的訊息，turn 大於 baseline 就認領');
  ok(h.starts.length === 1 && h.starts[0].late === false, '補一個非 late 的起點');
  ok(h.turn.push(end(8)) === true && h.settles[0]?.text === '遲到的文字', '仍然收得到完整回答');
}

// 4. 逾時時先給結果，但等 turn/end 才解除保護
{
  const h = harness({ timeoutMs: 1000, closeGraceMs: 100 });
  h.turn.push(start(1));
  h.clock.advance(1000);
  ok(h.settles.length === 1 && h.settles[0].kind === 'timeout', '逾時先結算 timeout');
  ok(h.timeouts.length === 1, '逾時要取消 DSH 那一輪');
  ok(h.closes.length === 0, 'turn/end 之前不解除 mute／閘門');
  h.clock.advance(100);
  ok(h.closes.length === 0, '已認領但還沒結束：寬限到了也不收');
  ok(h.turn.push(message(1, '晚到的文字')) === true, '收尾中仍然吞掉自己的事件');
  ok(h.turn.push(end(1)) === true, '收到 turn/end');
  ok(h.closes.length === 1, 'turn 真的結束才收尾');
  ok(h.settles.length === 1, '不會重複結算');
}

// 5. 逾時時根本沒開始：寬限到了才收尾
{
  const h = harness({ timeoutMs: 1000, closeGraceMs: 100 });
  h.clock.advance(1000);
  ok(h.settles[0]?.kind === 'timeout' && h.timeouts.length === 1, '沒回合也先回報逾時');
  ok(h.closes.length === 0, '還在寬限期');
  h.clock.advance(99);
  ok(h.closes.length === 0, '寬限沒到不收尾');
  h.clock.advance(1);
  ok(h.closes.length === 1, '寬限到了才收尾');
}

// 6. 逾時後排隊的問題才開始跑：認領、取消、等它結束
{
  const h = harness({ timeoutMs: 1000, closeGraceMs: 100 });
  h.clock.advance(1000);
  ok(h.turn.push(start(3)) === true, '逾時後才開始的回合仍然被吃掉');
  ok(h.starts.length === 1 && h.starts[0].late === true, 'onStart 標成 late（外面要再取消一次）');
  ok(h.turn.hasTurn === true, 'late 回合也算自己的回合');
  h.turn.push(end(3));
  ok(h.closes.length === 1, 'late 回合結束後收尾');
}

// 7. 收尾中不吞別的回合
{
  const h = harness({ timeoutMs: 1000, closeGraceMs: 100 });
  h.turn.push(start(4));
  h.clock.advance(1000);
  ok(h.turn.push(start(5)) === false, '收尾中看到別的 turn/start 不碰');
  ok(h.turn.push(end(5)) === false, '別的 turn/end 不碰');
  ok(h.closes.length === 0, '不會被別的回合提早收尾');
  h.turn.push(end(4));
  ok(h.closes.length === 1, '自己的回合結束才收尾');
}

// 8. 進行中不吞別的回合
{
  const h = harness({ baselineTurn: 9 });
  h.turn.push(start(10));
  ok(h.turn.push(start(11)) === false, '進行中看到更大的 turn/start 不碰');
  ok(h.turn.push(message(11, '別人的')) === false, '別人的訊息不碰');
  ok(h.turn.push(end(11)) === false, '別人的結束不碰');
  ok(h.settles.length === 0 && h.closes.length === 0, '自己的回合還沒結束就不結算');
  h.turn.push(end(10));
  ok(h.closes.length === 1, '自己的回合結束才收尾');
}

// 9. abort 只結算一次，寬限可以延長
{
  const h = harness({ timeoutMs: 10_000, closeGraceMs: 100 });
  h.turn.push(start(1));
  h.turn.abort(new Error('斷線'), 100);
  ok(h.settles.length === 1 && h.settles[0].kind === 'aborted', 'abort 先結算錯誤');
  h.turn.abort(new Error('再一次'), 100);
  ok(h.settles.length === 1, '重複 abort 不會重複結算');
  h.turn.extendGrace(500);
  h.clock.advance(600);
  ok(h.closes.length === 0, '已認領回合時，寬限到了也不會收尾');
  h.turn.push(end(1));
  ok(h.closes.length === 1 && h.closes[0].ended === true, '真的 turn/end 才收尾');
}

// 9b. 一直等不到 turn/end：hardClose 收尾，並回報 ended=false 讓外面繼續擋
{
  const h = harness({ timeoutMs: 1000, closeGraceMs: 100, hardCloseMs: 5000 });
  h.turn.push(start(1));
  h.clock.advance(1000);
  h.clock.advance(100);
  ok(h.closes.length === 0, '寬限不會收掉未結束的回合');
  h.clock.advance(4900);
  ok(h.closes.length === 1 && h.closes[0].ended === false && h.closes[0].turn === 1,
    'hardClose 回報未結束的回合');
  ok(h.turn.phase === 'closed', 'hardClose 後不再收事件');
}

// 10. 結束理由不是 completed 時回報 ended，不是答案
{
  const h = harness({ baselineTurn: 0 });
  h.turn.push(start(1));
  h.turn.push(end(1, 'error'));
  ok(h.settles.length === 1 && h.settles[0].kind === 'ended', '錯誤回合回報 ended');
  ok(h.closes.length === 1, '錯誤回合也要收尾');
}

// 11. 沒有 turn 編號的事件也不能外露
{
  const h = harness({ baselineTurn: 2, timeoutMs: 1000, closeGraceMs: 100 });
  ok(h.turn.push({ type: 'tool/call', data: { name: 'mcp__discord__send_message' } }) === true,
    '等回合時，沒有 turn 的工具事件先吞掉');
  ok(h.starts.length === 0 && h.settles.length === 0, '吞掉但不認領回合');
  h.clock.advance(1000);
  ok(h.turn.push({ type: 'tool/call', data: { name: 'x' } }) === true, '收尾中也吞掉沒有 turn 的事件');
  h.clock.advance(100);
  ok(h.closes.length === 1, '寬限到了照常收尾');
}

// 12. 進閘門前的守門條件
{
  ok(askBlockReason({ snapshotReady: false }) === 'syncing', '快照還沒到不能問');
  ok(askBlockReason({ snapshotReady: true, queued: 1 }) === 'queued', 'DSH 佇列非空不能問');
  ok(askBlockReason({ snapshotReady: true, gateBusy: true }) === 'busy', '閘門忙不能問');
  ok(askBlockReason({ snapshotReady: true, collectorActive: true }) === 'busy', '公開回合還在收集不能問');
  ok(askBlockReason({ snapshotReady: true, openTurns: 1 }) === 'busy', '有沒結束的回合不能問');
  ok(askBlockReason({ snapshotReady: true, askActive: true }) === 'busy', '已經有一個 /ask 不能問');
  ok(askBlockReason({ snapshotReady: true }) === null, '都沒問題才放行');
}

// 13. 從快照 records 重建回合狀態
{
  const records = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { turn: 2 } },
    { type: 'event', event: { type: 'turn/start', data: { turn: 3 } } },
    { type: 'event', event: { type: 'turn/end', data: { turn: 3 } } },
    { type: 'turn/start', data: { turn: 4 } }, // 還在跑
    { type: 'tool/call', data: { name: 'x' } },
  ];
  const { open, ended } = turnsFromRecords(records);
  ok(ended.has(1) && ended.has(3), '看到 turn/end 的回合進 ended');
  ok(open.has(2) && open.has(4) && !open.has(1) && !open.has(3), '只有 start 的回合留在 open');
  ok(!ended.has(2) && !ended.has(4), '還在跑的回合不算 ended');
  const truncated = turnsFromRecords([{ type: 'assistant/message', data: { turn: 9 } }]);
  ok(truncated.open.size === 0 && truncated.ended.size === 0, 'records 被截掉時不會亂判');
}

console.log(failures === 0 ? `\n✓ /ask 私人回合測試全過（14 組）` : `\n✗ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
