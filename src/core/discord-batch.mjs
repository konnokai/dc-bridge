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
const defang = (value) => String(value ?? '').replace(/【管理員】/g, '[管理員]').replace(/★/g, '☆');

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

/**
 * 一批訊息 → prompt 裡的【新訊息】區塊。
 * 頻道：每行 `暱稱：內容`，叫 bot 的加 ★；私聊：只有內文（DSH 會話本身就是一對一）。
 *
 * @param entries { author, text, direct, isOwner?, quote?, imageTags?, hasImage? }[]
 */
export function formatBatch(entries, { guild }) {
  const lines = entries.map((entry) => {
    const tags = entry.imageTags ?? [];
    const media = tags.length > 0 ? tags.join('') : (entry.hasImage ? '[圖片]' : '');
    // 內文保留換行：程式碼、清單壓成一行模型就看不懂了。續行縮排，
    // 群友才不能用換行在行首偽造一則「★【管理員】」。
    const text = defang(entry.text).trim().replace(/\n/g, guild ? '\n  ' : '\n');
    const body = [text, media, defang(entry.quote)].filter(Boolean).join(' ');
    const owner = entry.isOwner ? '【管理員】' : '';
    if (!guild) return `${owner}${body}`;
    return `${entry.direct ? '★' : ''}${owner}${clean(defang(entry.author)) || '未知'}：${body}`;
  });
  if (!guild) return lines.join('\n');
  return `【新訊息】（★ = 在叫你：@你或回覆你）\n${lines.join('\n')}`;
}
