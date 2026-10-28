// 一次 /ask 的私人回合：只認「這次提問之後才開始」的那一輪，並決定什麼時候可以解除保護。
//
// 為什麼要這個狀態機：
//   回合閘門閒著不代表 DSH 閒著（TTFT 保底放行、事件流重連、DSH WebUI 直接開的回合）。
//   如果照學習會話的做法用 assistant/message 補一個起點，會把上一輪的 turn/end 當成答案。
//   所以 baselineTurn 之前的事件一律不碰，交給公開路徑。
//
// 收尾也比照「先保護、後放行」：
//   逾時或失敗時先給使用者結果，但 waiter 留在 closing 繼續吞這一輪的事件，
//   等 turn/end（或取消後的寬限）才 onClose。避免晚到的工具呼叫把私人回答送到頻道。
import { createTurnCollector } from '../dsh-client.js';

const ANSWER_TEXT_MAX = 8_000; // 只是保險；正常回答遠小於這個

/**
 * /ask 進閘門前的守門條件。回傳 null 表示可以問，否則回原因。
 * 這些條件分開檢查會被「檢查完才 await」的競態鑽過去，所以在同一個地方一次判完。
 */
export function askBlockReason({
  snapshotReady,
  queued = 0,
  gateBusy = false,
  collectorActive = false,
  openTurns = 0,
  askActive = false,
} = {}) {
  if (!snapshotReady) return 'syncing';
  if (queued) return 'queued';
  if (gateBusy || collectorActive || openTurns > 0 || askActive) return 'busy';
  return null;
}

/**
 * 從 `session/follow` 快照的 records 重建回合狀態。
 * open = 有 start 沒有 end；ended = 看過 end（給 abandoned 判斷用，不能只看「不在 open」，
 * 因為 records 只有最近 200 筆，久一點的 start 可能已經被截掉）。
 */
export function turnsFromRecords(records = []) {
  const open = new Set();
  const ended = new Set();
  for (const entry of records ?? []) {
    const event = entry?.type === 'event' ? entry.event : entry;
    const turn = event?.data?.turn;
    if (typeof turn !== 'number') continue;
    if (event.type === 'turn/start') {
      open.add(turn);
      ended.delete(turn);
    } else if (event.type === 'turn/end') {
      open.delete(turn);
      ended.add(turn);
    }
  }
  return { open, ended };
}

/** 把 collector 的結束結果轉成 onSettle 的格式。 */
function settleValue(ended) {
  if (ended.reason?.kind === 'completed') {
    return { kind: 'answer', text: String(ended.text ?? '').trim().slice(0, ANSWER_TEXT_MAX) };
  }
  return { kind: 'ended', reason: ended.reason };
}

/**
 * @param options.baselineTurn  這次提問之前已經看過的最大 turn；小於等於它的事件都不算
 * @param options.timeoutMs     等答案的上限
 * @param options.closeGraceMs  逾時／失敗後，最多再等多久才解除 mute 與閘門
 * @param options.onStart       (turn, { late })：第一次認領到這一輪（晚到的也算）
 * @param options.onSettle      ({ kind, text?, reason?, error? })：只呼叫一次，給使用者結果
 * @param options.onClose       可以解除 mute、放行閘門了；只呼叫一次
 * @param options.onTimeout     逾時當下要取消 DSH 那一輪（只呼叫一次）
 */
export function createAskTurn({
  baselineTurn = 0,
  timeoutMs,
  closeGraceMs = 10_000,
  hardCloseMs = 10 * 60_000,
  onStart = () => {},
  onSettle = () => {},
  onClose = () => {},
  onTimeout = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!(Number(timeoutMs) > 0)) throw new Error('timeoutMs 必須大於 0');
  if (!(Number(closeGraceMs) >= 0)) throw new Error('closeGraceMs 不能是負數');
  if (!(Number(hardCloseMs) > 0)) throw new Error('hardCloseMs 必須大於 0');

  const collector = createTurnCollector();
  let phase = 'waiting'; // waiting | running | closing | closed
  let turn = null;
  let ended = false;
  let settled = false;
  let closed = false;
  let graceTimer = null;
  let hardTimer = null;

  const settle = (value) => {
    if (settled) return;
    settled = true;
    onSettle(value);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    phase = 'closed';
    clearTimer(timeoutTimer);
    clearTimer(graceTimer);
    clearTimer(hardTimer);
    onClose({ turn, ended });
  };

  /**
   * 收尾寬限：已經認領到回合時不能直接關，一定要等它自己的 turn/end。
   * 真的等不到就交給 hardCloseMs 的保底，onClose 會帶 ended=false，
   * 外面據此把這一輪記成 abandoned、繼續吞事件。
   */
  const startGrace = (ms) => {
    if (graceTimer) clearTimer(graceTimer);
    graceTimer = setTimer(() => {
      if (closed) return;
      if (turn !== null && !ended) return;
      close();
    }, Math.max(0, ms));
    graceTimer?.unref?.();
  };

  const claim = (eventTurn, late) => {
    turn = eventTurn;
    phase = 'running';
    onStart(eventTurn, { late });
  };

  const beginClosing = (value, graceMs, { timeout = false } = {}) => {
    settle(value);
    if (closed) return;
    if (timeout) onTimeout();
    phase = 'closing';
    startGrace(graceMs);
    if (!hardTimer) {
      hardTimer = setTimer(() => {
        if (!closed) close();
      }, hardCloseMs);
      hardTimer?.unref?.();
    }
  };

  const timeoutTimer = setTimer(() => {
    beginClosing({ kind: 'timeout' }, closeGraceMs, { timeout: true });
  }, timeoutMs);
  timeoutTimer?.unref?.();

  return {
    get phase() {
      return phase;
    },
    /** 有沒有認領到回合（取消成功後，還在等 turn/end 的那種也算）。 */
    get hasTurn() {
      return turn !== null;
    },
    /** 認領到的 turn 編號；還沒認領時是 null。 */
    get turn() {
      return turn;
    },
    /** 有沒有真的看到這一輪的 turn/end。 */
    get ended() {
      return ended;
    },
    /** 回傳 true 表示這個事件屬於這次提問，外面不要再走公開回合。 */
    push(event) {
      if (closed) return false;
      const type = event?.type;
      const eventTurn = event?.data?.turn;
      const hasTurn = typeof eventTurn === 'number';

      if (phase === 'closing') {
        // 收尾中只吞我們這一輪；別的回合照常走公開路徑。
        // 沒有 turn 編號的事件（工具進度、壓縮）分不出是誰的，先吞掉不外露。
        if (!hasTurn) return true;
        if (turn === null) {
          // 逾時時問題可能還排在 DSH 佇列裡，後來才開始跑：認領它、取消它，不能讓它變公開回合。
          if (type === 'turn/end') return false;
          if (type === 'turn/start') {
            claim(eventTurn, true);
            collector.push(event);
            return true;
          }
          if (eventTurn <= baselineTurn) return false;
          claim(eventTurn, true);
          collector.push({ type: 'turn/start', data: { turn: eventTurn } });
          collector.push(event);
          return true;
        }
        if (eventTurn !== turn) return false;
        if (type === 'turn/end') {
          ended = true;
          close();
          return true;
        }
        collector.push(event);
        return true;
      }

      if (phase === 'running') {
        if (hasTurn && eventTurn !== turn) return false;
        const endedTurn = collector.push(event);
        if (endedTurn) {
          ended = true;
          settle(settleValue(endedTurn));
          close();
        }
        return true;
      }

      // waiting：閘門放行時已經確認沒有別的回合在跑，第一個 turn/start 就是我們的
      // （DSH 重啟後 turn 編號可能歸零，不能只靠 baselineTurn 判斷）。
      // 沒有 start 的訊息才用 baselineTurn 擋掉提問前就存在的回合。
      if (type === 'turn/start') {
        claim(eventTurn, false);
        collector.push(event);
        return true;
      }
      if (!hasTurn) return true;
      if (eventTurn <= baselineTurn) return false;
      claim(eventTurn, false);
      collector.push({ type: 'turn/start', data: { turn: eventTurn } });
      const endedLate = collector.push(event);
      if (endedLate) {
        ended = true;
        settle(settleValue(endedLate));
        close();
      }
      return true;
    },
    /** 外部失敗（斷線、prompt 送不出去、/reset）：先給結果，進入 closing。 */
    abort(error, graceMs = closeGraceMs) {
      if (closed) return;
      if (phase === 'closing') {
        startGrace(graceMs);
        return;
      }
      beginClosing({ kind: 'aborted', error }, graceMs);
    },
    /** 取消失敗時把寬限拉長，不要立刻解除 mute。 */
    extendGrace(ms) {
      if (phase === 'closing' && !closed) startGrace(ms);
    },
    close,
  };
}
