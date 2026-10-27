// 訊息批次：同一個會話短時間內的多則訊息合成一個模型回合。
//
// 為什麼要合批：頻道開「自由參與」後，每一則訊息都送一個回合，模型會被迫每則都表態，
// 花費也跟訊息數成正比。合成一批之後，模型一次看到一段對話，再決定要不要接話。
// 等待時間有上限（maxWaitMs）：頻道一直有人講話時，也不會無限延後。

const clean = (value) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ★ 與【管理員】是橋接自己加的標記，persona 靠它們判斷「有沒有在叫你」「是不是管理員」；
// 群友寫在暱稱或內文裡的同樣字樣要改掉，不然就能冒充。
export const defang = (value) => String(value ?? '').replace(/【管理員】/g, '[管理員]').replace(/★/g, '☆');

/**
 * 建立批次器。
 *
 * @param options.debounceMs  最後一則之後再等多久
 * @param options.maxWaitMs   從第一則算起最多等多久
 * @param options.maxMessages 一批最多幾則，滿了立刻送
 * @param options.onFlush     (key, items) => void
 * @param options.now / setTimer / clearTimer  測試用的時鐘注入
 */
export function createBatcher({
  debounceMs,
  maxWaitMs,
  maxMessages,
  onFlush,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const batches = new Map(); // key -> { items, firstAt, timer }

  function flush(key) {
    const batch = batches.get(key);
    if (!batch) return;
    batches.delete(key);
    clearTimer(batch.timer);
    onFlush(key, batch.items);
  }

  function add(key, item) {
    let batch = batches.get(key);
    if (!batch) {
      batch = { items: [], firstAt: now(), timer: null };
      batches.set(key, batch);
    }
    batch.items.push(item);
    clearTimer(batch.timer);
    const waited = now() - batch.firstAt;
    if (batch.items.length >= maxMessages || waited >= maxWaitMs) {
      flush(key);
      return;
    }
    batch.timer = setTimer(() => flush(key), Math.min(debounceMs, maxWaitMs - waited));
    batch.timer?.unref?.();
  }

  /** 丟掉還沒送出的那批（/reset 時用，不能讓舊訊息進新會話）。 */
  function drop(key) {
    const batch = batches.get(key);
    if (!batch) return;
    clearTimer(batch.timer);
    batches.delete(key);
  }

  return { add, drop };
}

/** 兩批合成一批。超過上限先丟最舊的閒聊；★（有人叫 bot）那幾則一定留著。 */
function mergeJobs(held, job, maxEntries) {
  // 代次不同表示中間 /reset 過，舊的那批屬於舊對話。
  if (!held || held.epoch !== job.epoch) return job;
  const all = [...held.entries, ...job.entries].sort((a, b) => a.at - b.at);
  let extra = all.length - maxEntries;
  const entries = all.filter((entry) => entry.direct || extra-- <= 0);
  return {
    ...job,
    entries,
    direct: entries.some((entry) => entry.direct),
    dropped: (held.dropped ?? 0) + (job.dropped ?? 0) + all.length - entries.length,
  };
}

/**
 * 回合閘門：同一個會話一次只讓一批進 DSH。
 *
 * 為什麼要有：DSH 的 queue 模式每個回合只接一則排隊訊息。群組聊得比模型回得快時
 * （回合 12~35 秒、每 10 秒一批），DSH 的佇列只會越排越長，模型永遠在回很久以前的話。
 * 改成回合還沒結束就先壓在這裡、合成一筆，回合結束再送，DSH 那邊最多排一則。
 *
 * @param options.deliver    (key, job) => void，真的送進 DSH
 * @param options.maxEntries 壓住的那批最多幾則
 * @param options.releaseMs  等不到回合結束時，最久壓多久就放行
 * @param options.onStuck    (key) => void，保險計時器觸發時呼叫（記日誌用）
 */
export function createTurnGate({
  deliver,
  maxEntries,
  releaseMs,
  onStuck = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const busy = new Map(); // key -> 保險計時器
  const held = new Map(); // key -> 回合進行中先壓住的那批

  function submit(key, job) {
    if (busy.has(key)) {
      held.set(key, mergeJobs(held.get(key), job, maxEntries));
      return;
    }
    const timer = setTimer(() => { onStuck(key); release(key); }, releaseMs);
    timer?.unref?.();
    busy.set(key, timer);
    deliver(key, job);
  }

  /** 回合結束（或確定不會有回合）：放行壓住的那批。 */
  function release(key) {
    if (!busy.has(key)) return;
    clearTimer(busy.get(key));
    busy.delete(key);
    const next = held.get(key);
    if (!next) return;
    held.delete(key);
    submit(key, next);
  }

  /** /reset：壓住的批次屬於舊對話，連同忙碌狀態一起清掉。 */
  function drop(key) {
    clearTimer(busy.get(key));
    busy.delete(key);
    held.delete(key);
  }

  const releaseAll = () => { for (const key of [...busy.keys()]) release(key); };

  return { submit, release, drop, releaseAll };
}

/**
 * 一批訊息 → prompt 裡的【新訊息】區塊。
 * 頻道：每行 `暱稱：內容`，叫 bot 的加 ★；私聊：只有內文（DSH 會話本身就是一對一）。
 *
 * @param entries { author, text, direct, isOwner?, ref?, quote?, imageTags?, hasImage? }[]
 */
export function formatBatch(entries, { guild }) {
  const lines = entries.map((entry) => {
    const tags = entry.imageTags ?? [];
    const media = tags.length > 0 ? tags.join('') : (entry.hasImage ? '[圖片]' : '');
    // 內文保留換行：程式碼、清單壓成一行模型就看不懂了。續行縮排，
    // 群友才不能用換行在行首偽造一則「★【管理員】」。
    const text = defang(entry.text).trim().replace(/\n/g, guild ? '\n  ' : '\n');
    const body = [text, media, defang(entry.quote)].filter(Boolean).join(' ');
    // 頻道裡只有叫 bot 的那則才標管理員：管理員跟朋友聊天時也掛著標籤，模型會以為是在對它說話。
    const owner = entry.isOwner && (entry.direct || !guild) ? '【管理員】' : '';
    const ref = entry.ref ? `#${entry.ref} ` : '';
    if (!guild) return `${ref}${owner}${body}`;
    return `${ref}${entry.direct ? '★' : ''}${owner}${clean(defang(entry.author)) || '未知'}：${body}`;
  });
  if (!guild) return lines.join('\n');
  return `【新訊息】（★ = 在叫你：@你或回覆你；#編號 用來指定要回覆或按 reaction 的訊息）\n${lines.join('\n')}`;
}
