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

// 有人故意把暱稱設成看不見的字，trim() 去不掉，畫面上卻是空白：U+17B5、U+3164、點字空白 U+2800、
// Discord 常見的 U+1CBC、只有組合符號（\p{M}）沒有本字的名字。組合符號只在判斷時拿掉，泰文這類名字本字還在。
const INVISIBLE = /[\s\p{Default_Ignorable_Code_Point}\p{M}\p{C}\u2800\u1cbc\u{1d159}]/gu;
export const stripInvisible = (value) => String(value ?? '').replace(INVISIBLE, '');
export const isVisible = (value) => typeof value === 'string' && stripInvisible(value) !== '';

/** 依序取第一個看得到的名字（伺服器暱稱 → 顯示名稱 → 使用者名稱）；全都看不到回空字串。 */
export const visibleName = (...names) => names.find(isVisible) ?? '';

/** discord.js 的 ChannelType.PrivateThread：權限跟著母頻道，沒加入的人不該看到名字。 */
const PRIVATE_THREAD_TYPE = 12;

/**
 * 訊息文字裡的 mention 換成名字：`<@id>`／`<@!id>` → `@暱稱`、`<#id>` → `#頻道名`、
 * `<@&id>` → `@身分組名`。名字只從這則訊息自己的 mentions 拿，不打 API。
 * 查不到名字時寫「未知」，不把數字 id 留給模型。
 */
export function resolveMentions(value, message) {
  const text = String(value ?? '');
  if (!text.includes('<')) return text;
  const mentions = message?.mentions;
  const named = (name) => clean(defang(name)) || '未知';
  return text.replace(/<@!?(\d+)>|<#(\d+)>|<@&(\d+)>/g, (match, userId, channelId, roleId) => {
    if (userId) {
      const user = mentions?.users?.get?.(userId);
      if (!user) return '@未知';
      const member = mentions?.members?.get?.(userId);
      return `@${named(visibleName(member?.displayName, user.displayName, user.username))}`;
    }
    if (channelId) {
      const channel = mentions?.channels?.get?.(channelId);
      // mentions.channels 是 discord.js 從 bot 的全域頻道快取撈的：可能撈到別的伺服器或群友看不到的頻道。
      // 只認同一個伺服器；私密討論串的權限看母頻道，沒加入的人也拿得到名字，一律不換。
      if (!channel || channel.guildId !== message?.guildId || channel.type === PRIVATE_THREAD_TYPE) return '#未知';
      // 查不到成員（舊訊息、已退伺服器）時用 @everyone 判斷：Guilds intent 一定快取得到，
      // 拿不到權限就當看不到（fail closed）。
      const permissions = channel.permissionsFor?.(message?.member ?? channel.guild?.roles?.everyone);
      return permissions?.has('ViewChannel') ? `#${named(channel.name)}` : '#未知';
    }
    const role = mentions?.roles?.get?.(roleId);
    return role ? `@${named(role.name)}` : '@未知';
  });
}

/** 沒有引用內容的回覆：回覆對象的名字，只讀 mentions 與成員快取，不打 API。 */
export function repliedName(message) {
  const user = message?.mentions?.repliedUser;
  if (!user) return '';
  const member = message?.mentions?.members?.get?.(user.id) ?? message?.guild?.members?.cache?.get?.(user.id);
  return visibleName(member?.displayName, user.displayName, user.username) || '未知';
}

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

  return { add, drop, flush };
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
 * 改成回合還沒結束就先壓在這裡：普通批次合成一筆，指令（/ask、重載提示）照順序排隊，
 * 回合結束再送，DSH 那邊最多排一則。
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
  const busy = new Map(); // key -> { ticket, timer, job, hold }
  const pending = new Map(); // key -> [{ job, noStuckRelease }]

  function start(key, job, noStuckRelease = false) {
    const ticket = {};
    // /ask 自己用 tracker 的 hardClose 保底；不吃 5 分鐘保險絲，否則會提早放掉它的閘門。
    const timer = noStuckRelease ? null : setTimer(() => { onStuck(key); release(key); }, releaseMs);
    timer?.unref?.();
    busy.set(key, { ticket, timer, job, hold: false, released: false });
    deliver(key, job, ticket);
    return ticket;
  }

  function next(key) {
    const queue = pending.get(key);
    if (!queue?.length) {
      pending.delete(key);
      return;
    }
    const item = queue.shift();
    if (!queue.length) pending.delete(key);
    start(key, item.job, item.noStuckRelease);
  }

  function enqueue(key, job, noStuckRelease) {
    const queue = pending.get(key) ?? [];
    if (job?.ask) {
      // 指令（/ask、重載提示）獨佔一輪，不能跟頻道批次合併；照到達順序排。
      queue.push({ job, noStuckRelease });
    } else {
      // 只跟「佇列最後一筆」普通批次合併；最後一筆是指令就新增一筆，後續訊息才不會
      // 被併到指令前面的舊批次、提早進舊會話。
      const last = queue.at(-1);
      if (last && !last.job?.ask) {
        queue[queue.length - 1] = {
          job: mergeJobs(last.job, job, maxEntries),
          noStuckRelease: last.noStuckRelease,
        };
      } else {
        queue.push({ job, noStuckRelease });
      }
    }
    pending.set(key, queue);
  }

  function submit(key, job, { noStuckRelease = false } = {}) {
    if (busy.has(key)) {
      enqueue(key, job, noStuckRelease);
      return null;
    }
    return start(key, job, noStuckRelease);
  }

  /**
   * 回合結束（或確定不會有回合）：放行排隊的下一筆。
   * 帶 ticket 時只放行自己持有的那一輪：/reset、重連的 releaseAll 之後，
   * 舊的收尾不能把下一批的 busy 放掉。
   */
  function release(key, ticket) {
    const entry = busy.get(key);
    if (!entry) return;
    if (ticket !== undefined && entry.ticket !== ticket) return;
    clearTimer(entry.timer);
    // 重載提示要等舊會話收乾淨、排隊的批次換成新代次後才放行。
    // hold 期間保留 busy：否則新訊息會看到「閘門閒著」直接插隊，繞過排隊中的批次。
    if (entry.hold) {
      entry.released = true;
      return;
    }
    busy.delete(key);
    next(key);
  }

  /** 重載摘要拿到答案後先鎖住佇列，避免 turn/end 太早把下一批送進舊會話。 */
  function hold(key, ticket) {
    const entry = busy.get(key);
    if (!entry) return false;
    if (ticket !== undefined && entry.ticket !== ticket) return false;
    entry.hold = true;
    return true;
  }

  /** 解除 hold；force 用於舊會話已經退役，直接放行下一筆。ticket 用來確認是自己持有的那一輪。 */
  function resume(key, { force = false, ticket } = {}) {
    const entry = busy.get(key);
    if (!entry) {
      // 帶 ticket 表示這是某一輪自己的收尾；閘門已經不是它持有的，就不要碰別人的佇列。
      if (ticket === undefined) next(key);
      return;
    }
    if (ticket !== undefined && entry.ticket !== ticket) return;
    // 只處理被 hold 住的舊工作；不能把重新開始的下一筆誤放掉。
    if (!entry.hold && !entry.released) return;
    if (!entry.released && !force) {
      entry.hold = false;
      return;
    }
    clearTimer(entry.timer);
    busy.delete(key);
    next(key);
  }

  /** /reset 換代次後，排隊中的批次要跟著新會話走；不換的話 deliverPrompt 會把它們當舊對話丟掉。 */
  function rebase(key, epoch) {
    for (const item of pending.get(key) ?? []) item.job.epoch = epoch;
  }

  function cancel(job, error) {
    if (!job?.ask) return;
    try { job.ask.cancel?.(error); } catch { /* 已經收尾 */ }
    try { job.ask.reject?.(error); } catch { /* 已經收尾 */ }
  }

  /** /reset：壓住的批次屬於舊對話，連同忙碌狀態一起清掉；排隊中的命令也要結束等待。 */
  function drop(key) {
    const entry = busy.get(key);
    if (entry) {
      clearTimer(entry.timer);
      cancel(entry.job, new Error('會話已重置'));
      busy.delete(key);
    }
    const queue = pending.get(key);
    if (queue) {
      for (const item of queue) cancel(item.job, new Error('會話已重置'));
      pending.delete(key);
    }
  }

  /** 公開回合的 turn/end 只能放行普通批次，不能放掉剛開始的指令回合。 */
  function releaseNormal(key) {
    const entry = busy.get(key);
    if (!entry || entry.job?.ask) return;
    release(key, entry.ticket);
  }

  const releaseAll = () => {
    for (const key of [...busy.keys()]) {
      const entry = busy.get(key);
      // 斷線時等待中的 ask 還沒有 tracker，不能只放掉閘門讓下一個 ask 跑起來，
      // 否則兩個 runner 會同時搶同一個會話；先取消它，再放行下一筆。
      if (entry?.job?.ask) {
        clearTimer(entry.timer);
        cancel(entry.job, new Error('DSH 事件流中斷'));
        // hold 中的重載還在退役：保留 busy，等它的 resume 用原 ticket 放行。
        // 直接刪掉會讓下一個訊息看到「閘門閒著」而插隊。
        if (entry.hold) continue;
        busy.delete(key);
        next(key);
      } else {
        release(key);
      }
    }
  };

  /** 這個會話有沒有回合正在跑（回訪到點時用來決定要不要延後一分鐘）。 */
  const isBusy = (key) => busy.has(key);

  /** 有沒有回合在跑或排隊；重載提示沒有現成會話時用來判斷要不要排。 */
  const hasPending = (key) => busy.has(key) || (pending.get(key)?.length ?? 0) > 0;

  return { submit, release, releaseNormal, hold, resume, rebase, drop, releaseAll, isBusy, hasPending };
}

/**
 * 一批訊息裡真正在叫 bot 的人；沒有 ★（自由參與）就記整批的發言者。
 * 同一個人出現好幾則只算一次，名稱用最後一則的顯示名稱。
 *
 * @param entries { userId, author, direct }[]
 * @returns {{userId: string, name: string}[]}
 */
export function triggerUsers(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.userId) : [];
  const direct = list.filter((entry) => entry.direct);
  const source = direct.length ? direct : list;
  const seen = new Map();
  for (const entry of source) {
    const userId = String(entry.userId);
    seen.set(userId, { userId, name: entry.author ?? '' });
  }
  return [...seen.values()];
}

/**
 * 一批訊息 → prompt 裡的【新訊息】區塊。
 * 頻道：每行 `暱稱：內容`，叫 bot 的加 ★；私聊：只有內文（DSH 會話本身就是一對一）。
 *
 * @param entries { author, text, direct, isOwner?, ref?, quote?, replyName?, imageTags?, hasImage? }[]
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
    const replyTo = entry.replyName ? `↪回覆 ${clean(defang(entry.replyName)) || '未知'}` : '';
    if (!guild) return `${ref}${owner}${replyTo ? `${replyTo}：` : ''}${body}`;
    const reply = replyTo ? ` ${replyTo}` : '';
    return `${ref}${entry.direct ? '★' : ''}${owner}${clean(defang(entry.author)) || '未知'}${reply}：${body}`;
  });
  if (!guild) return lines.join('\n');
  return `【新訊息】（★ = 在叫你：@你或回覆你；#編號 用來指定要回覆或按 reaction 的訊息）\n${lines.join('\n')}`;
}
