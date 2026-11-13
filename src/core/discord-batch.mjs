// 訊息批次：同一個會話短時間內的多則訊息合成一個模型回合。
//
// 為什麼要合批：頻道開「自由參與」後，每一則訊息都送一個回合，模型會被迫每則都表態，
// 花費也跟訊息數成正比。合成一批之後，模型一次看到一段對話，再決定要不要接話。
// 等待時間有上限（maxWaitMs）：頻道一直有人講話時，也不會無限延後。

const clean = (value) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\u0085]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ★、【】與 ⊘ 都是橋接自己加的結構標記，persona 靠它們判斷段落、「有沒有 @／回覆你」「是不是管理員」、
// 「這個人是不是退出了」；群友寫在暱稱或內文裡的同樣字樣要改掉，不然就能偽造段落。零寬字元也要剝掉，
// 否則「【管\u200b理員】」看起來一樣、比對卻不同。
// 不含 U+200C/U+200D（ZWJ）：家處 emoji 靠它連接，剝掉會拆成好幾個獨立的人。
const ZERO_WIDTH = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
export const defang = (value) => String(value ?? '')
  .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
  .replace(/【/g, '[')
  .replace(/】/g, ']')
  .replace(/★/g, '☆')
  .replace(/⊘/g, '∅')
  .replace(ZERO_WIDTH, '');

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

/** 工具回覆只能帶文字：有附件、貼圖、embed（連結預覽、GIF）或 component 的訊息不取，留給正常批次，模型才看得到圖。 */
const hasMedia = (entry) => Boolean(entry.hasImage)
  || (entry.media?.accepted?.length ?? 0) > 0
  || (entry.message?.attachments?.size ?? 0) > 0
  || (entry.message?.stickers?.size ?? 0) > 0
  || (entry.message?.embeds?.length ?? 0) > 0
  || (entry.message?.components?.length ?? 0) > 0
  || (entry.message?.messageSnapshots?.size ?? 0) > 0;

/**
 * 建立批次器。
 *
 * @param options.debounceMs  最後一則之後再等多久
 * @param options.maxWaitMs   從第一則算起最多等多久
 * @param options.maxMessages 一批最多幾則，滿了立刻送
 * @param options.urgentMs    出現 urgent 之後改用的等待時間，預設 8000
 * @param options.typingMs    有人在打字時往後延多久，預設 10000
 * @param options.onFlush     (key, items) => void
 * @param options.now / setTimer / clearTimer  測試用的時鐘注入
 *
 * item.urgent：這則在叫 bot（頻道裡 @ 或回覆）。從這則起整批改用 urgentMs 的短等待，
 * 後面補的句子會併進同一批，分句不會被拆成兩個回合。
 */
export function createBatcher({
  debounceMs,
  maxWaitMs,
  maxMessages,
  urgentMs = 8_000,
  typingMs = 10_000,
  onFlush,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const batches = new Map(); // key -> { items, firstAt, deadline, timer, urgent, typing }
  // 參數可以是數字或 () => 數字：控制台改 batch 設定後不用重啟。
  const setting = (value) => Number(typeof value === 'function' ? value() : value);

  function flush(key) {
    const batch = batches.get(key);
    if (!batch) return;
    batches.delete(key);
    clearTimer(batch.timer);
    onFlush(key, batch.items);
  }

  /** 重排送出時間：base 之後再等 typing 窗口，但不超過第一則之後的 maxWaitMs。 */
  function schedule(key, batch, base) {
    let deadline = base;
    for (const [userId, until] of batch.typing) {
      if (until <= now()) batch.typing.delete(userId);
      else if (until > deadline) deadline = until;
    }
    clearTimer(batch.timer);
    batch.deadline = Math.min(deadline, batch.firstAt + setting(maxWaitMs));
    batch.timer = setTimer(() => flush(key), Math.max(0, batch.deadline - now()));
    batch.timer?.unref?.();
  }

  function add(key, item) {
    let batch = batches.get(key);
    if (!batch) {
      batch = { items: [], firstAt: now(), timer: null, urgent: false, typing: new Map() };
      batches.set(key, batch);
    }
    // 他剛在這批叫過 bot（只 @ 不說話也算）：接著補的那則把整批升成 urgent，
    // 不用等他補完再從頭等 20 秒。私聊每則都 direct，不算補句，照 debounce 合批。
    const followsDirect = Boolean(item.guildId) && item.userId
      && batch.items.some((entry) => entry.direct && String(entry.userId) === String(item.userId));
    if (item.urgent || followsDirect) {
      batch.urgent = true;
      // 從叫 bot 的這則起，只認叫 bot 的人的打字：旁人還沒打完不該拖慢回答。
      for (const userId of batch.typing.keys()) {
        if (!batch.items.some((entry) => String(entry.userId) === userId && entry.direct)) batch.typing.delete(userId);
      }
    }
    // 他已經送出訊息，打字狀態就結束；留著會讓這批白等一個 typing 窗口。
    if (item.userId) batch.typing.delete(String(item.userId));
    batch.items.push(item);
    const waited = now() - batch.firstAt;
    if (batch.items.length >= setting(maxMessages) || waited >= setting(maxWaitMs)) {
      flush(key);
      return;
    }
    const debounce = setting(debounceMs);
    const wait = batch.urgent ? Math.min(debounce, urgentMs) : debounce;
    schedule(key, batch, now() + wait);
  }

  /**
   * 有人在打字：這批裡已經有他的訊息才延長，最多延 typingMs。
   * urgent 批次只認叫 bot 的那個人；回傳有沒有真的排到。
   */
  function extend(key, userId) {
    const batch = batches.get(key);
    if (!batch || !userId) return false;
    const id = String(userId);
    const eligible = batch.items.some((entry) => String(entry.userId) === id
      && (!batch.urgent || entry.direct));
    if (!eligible) return false;
    batch.typing.set(id, now() + typingMs);
    schedule(key, batch, batch.deadline ?? now());
    return true;
  }

  /**
   * 取出還沒送出的項目：只取 userIds 裡的人、而且沒有媒體的訊息。
   * 模型用工具回覆時只能帶文字，補句的圖留給正常批次送。
   * 取完空了就丟掉；還有剩就依剩下的項目重排送出時間，不沿用被取走那則的時間。
   */
  function take(key, userIds) {
    const batch = batches.get(key);
    if (!batch) return [];
    const ids = new Set((Array.isArray(userIds) ? userIds : [userIds]).map(String));
    const taken = batch.items.filter((entry) => ids.has(String(entry.userId)) && !hasMedia(entry));
    if (taken.length === 0) return [];
    batch.items = batch.items.filter((entry) => !taken.includes(entry));
    if (batch.items.length === 0) {
      drop(key);
      return taken;
    }
    // 被取走的人已經不在這批，留著他的打字狀態只會拖慢剩下的訊息。
    for (const userId of batch.typing.keys()) {
      if (!batch.items.some((entry) => String(entry.userId) === userId)) batch.typing.delete(userId);
    }
    // 重新照剩下的項目算 urgent（同一個人先叫 bot 再補句，也算 urgent），
    // 送出時間用最後一則自己的到達時間，別人的訊息才不會被往後拖。
    const directUsers = new Set();
    batch.urgent = batch.items.some((entry) => {
      const followsDirect = Boolean(entry.guildId) && entry.userId && directUsers.has(String(entry.userId));
      if (entry.direct && entry.userId) directUsers.add(String(entry.userId));
      return Boolean(entry.urgent) || followsDirect;
    });
    const debounce = setting(debounceMs);
    const wait = batch.urgent ? Math.min(debounce, urgentMs) : debounce;
    // 批次項目的順序不一定照時間排（handleMessage 有 await），取最晚的那一則。
    const lastAt = Math.max(...batch.items.map((entry) => Number(entry.at) || 0));
    schedule(key, batch, (lastAt || now()) + wait);
    return taken;
  }

  /** 丟掉還沒送出的那批（/reset 時用，不能讓舊訊息進新會話）。 */
  function drop(key) {
    const batch = batches.get(key);
    if (!batch) return;
    clearTimer(batch.timer);
    batches.delete(key);
  }

  return { add, extend, take, drop, flush };
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
    } else if (job?.system) {
      // 系統訊息（例如背景生圖完成）不能跟頻道批次合併，不然 text 會被吃掉。
      queue.push({ job, noStuckRelease });
    } else {
      // 只跟「佇列最後一筆」普通批次合併；最後一筆是指令或系統訊息就新增一筆，
      // 後續訊息才不會被併到它前面、或把它的 text 蓋掉。
      const last = queue.at(-1);
      if (last && !last.job?.ask && !last.job?.system) {
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
 * 生圖參考圖的標記：`[圖 #k7f3ab/1]`。`ref` 是那則訊息的 #編號，`index` 從 1 起算。
 * 模型要拿這張當參考圖時，`generate_image` 的 `inputImage` 就填 `ref:#k7f3ab/1`。
 */
export function imageRefTag(ref, index) {
  return `[圖 #${ref}/${index}]`;
}

/**
 * chatty 頻道的【參與度】提示：不限制發言頻率，沒 ★ 也可以接。
 * 正常頻道不帶這一段，persona 的預設判斷原封不動。
 */
export const CHATTY_HINT_LINES = [
  '【參與度】這一段每批重算，以這一段為準；更早摘要裡的參與規則作廢。',
  '- 標 ⊘ 的人只是不回他；他說的話仍然算對話，也算「有人接手」。',
  '- 如果這則是接著你上一則跟他講的同一件事：先看中間有沒有別人（含 ⊘）插話；有，就是人類接手，這串退出。就算它問「你」也一樣，不要送文字。',
  '- 如果不是接著你上一則（新話題、或有人問全頻道）：可以主動接（叫你名字、聊到你、拿你當梗、回你剛貼的東西、問你），只要還沒有人接手。不用算發言頻率。',
  '- 沒有 ★ 的「你」先當成對前面說話的人；分不清楚就不要接。',
  '- 只有圖片、連結、貼圖，沒有文字時不要接。',
];

/** followup.enabled 才帶這行：工具沒開時叫模型排回訪只會拿到 403。 */
export const CHATTY_FOLLOWUP_HINT = '- 話題收尾或大家安靜下來時，可以順手用 schedule_followup 排 30~90 分鐘後回來看；回來話題冷了，就自己起一個新的。一天最多 6 次，對方沒接的新話題就放下。';

/** @param chatty 這個頻道在 discord.chattyChannels 裡才回傳內容；followup 要 followup.enabled 才帶開話題提示。 */
export function formatParticipationHint(chatty = false, { followup = false } = {}) {
  if (!chatty) return '';
  return [...CHATTY_HINT_LINES, followup ? CHATTY_FOLLOWUP_HINT : ''].filter(Boolean).join('\n');
}

/** 讓位只在 bot 最後一則之後這麼久內生效；超過就當成新話題。 */
export const YIELD_WINDOW_MS = 5 * 60_000;

/**
 * 讓位判斷：bot 最後一則回給 T，T 現在又說話；如果中間有別人（含 ⊘）插話，
 * 而且這批最後一則還是 T，就代表 T 已經被人類接手，不送模型。
 * ★、叫名字、回訪、系統訊息、沒有 reply_to 都不擋。
 *
 * @param options.botLast { id, seenId, at, replyTo: { id, authorId } | null }
 * @param options.recent 最近的人類訊息 { id, authorId }[]
 * @param options.batch 這批訊息 { id, userId }[]
 * @param options.hasStar 這批有 ★
 * @param options.named 這批有人叫 bot 的名字
 * @param options.now
 */
export function shouldYield({ botLast, recent = [], batch = [], hasStar = false, named = false, now = Date.now() } = {}) {
  if (hasStar || named) return false;
  if (!botLast?.id || !botLast?.replyTo?.authorId || !botLast.replyTo.id) return false;
  if (!(Number(now) - Number(botLast.at) <= YIELD_WINDOW_MS)) return false;
  const last = batch.at(-1);
  if (!last?.id || String(last.userId) !== String(botLast.replyTo.authorId)) return false;
  // 用 snowflake 排序，不用本機時鐘，避免 bot 送出時間和 Discord 訊息時間有偏差。
  let start;
  let end;
  try {
    end = BigInt(last.id);
    start = end < BigInt(botLast.id) ? BigInt(botLast.replyTo.id) : BigInt(botLast.id);
  } catch {
    return false;
  }
  // 交錯時，bot 這一輪已經看過的訊息不能算插話，否則會誤擋。
  const seen = /^\d+$/.test(String(botLast.seenId ?? '')) ? BigInt(botLast.seenId) : 0n;
  const startId = start > seen ? start : seen;
  return recent.some((entry) => {
    if (String(entry?.authorId) === String(botLast.replyTo.authorId)) return false;
    try {
      const id = BigInt(entry?.id);
      return id > startId && id < end;
    } catch {
      return false;
    }
  });
}

/** 整批都沒有文字、只有圖片／貼圖：chatty 頻道直接不送模型。 */
export function isMediaOnlyBatch(entries) {
  return Array.isArray(entries) && entries.length > 0 && entries.every((entry) => entry?.mediaOnly);
}

/** 這批文字裡有沒有直接叫 bot 的名字。 */
export function isBotNamed(text) {
  return /(大肥魚|肥魚)/.test(String(text ?? ''));
}

/**
 * 一批訊息 → prompt 裡的【新訊息】區塊。
 * 頻道：每行 `暱稱：內容`，叫 bot 的加 ★；私聊：只有內文（DSH 會話本身就是一對一）。
 *
 * @param entries { author, text, direct, isOwner?, ref?, quote?, preview?, replyName?, imageTags?, hasImage? }[]
 */
export function formatBatch(entries, { guild }) {
  const lines = entries.map((entry) => {
    const tags = entry.imageTags ?? [];
    const media = tags.length > 0 ? tags.join('') : (entry.hasImage ? '[圖片]' : '');
    // 內文保留換行：程式碼、清單壓成一行模型就看不懂了。續行縮排，
    // 群友才不能用換行在行首偽造一則「★【管理員】」。
    const text = defang(entry.text).trim().replace(/\n/g, guild ? '\n  ' : '\n');
    const preview = entry.preview ? `[連結預覽：${defang(entry.preview)}]` : '';
    const body = [text, media, preview, defang(entry.quote).replace(/\n/g, ' ')].filter(Boolean).join(' ');
    // 頻道裡只有叫 bot 的那則才標管理員：管理員跟朋友聊天時也掛著標籤，模型會以為是在對它說話。
    const owner = entry.isOwner && (entry.direct || !guild) ? '【管理員】' : '';
    const ref = entry.ref ? `#${entry.ref} ` : '';
    const replyTo = entry.replyName ? `↪回覆 ${clean(defang(entry.replyName)) || '未知'}` : '';
    if (!guild) return `${ref}${owner}${replyTo ? `${replyTo}：` : ''}${body}`;
    const reply = replyTo ? ` ${replyTo}` : '';
    // 已退出的人 @ 你或回覆你時，這則照正常流程進來；寫清楚，免得模型照 ⊘ 規則跳過。
    const mutedNote = entry.direct && entry.muted ? '（他本人在叫你，可以回）' : '';
    return `${ref}${entry.direct ? '★' : ''}${owner}${clean(defang(entry.author)) || '未知'}${mutedNote}${reply}：${body}`;
  });
  if (!guild) return lines.join('\n');
  // 沒 ★ 的批次還印 ★ 的說明時，模型會自己補出一個 ★，
  // 把別人互相回覆的閒聊當成在叫它（實際遇過）。★ 只寫橋接確定的事實：
  // 「有 @／回覆」不等於「內容在講它」，這句寫明，免得模型把別人講的第三人稱當成在說自己。
  // 「叫名字」、「話題提到你」算不算在叫它，交給 persona 判斷。
  const legend = entries.some((entry) => entry.direct)
    ? '★ = 有 @你或回覆你，不代表內容在講你；'
    : '這批沒有 ★（沒有人 @你或回覆你）；';
  return `【新訊息】（${legend}#編號 用來指定要回覆、查看或按 reaction 的訊息）\n${lines.join('\n')}`;
}

/**
 * 送出前的補句檢查：把同一個觸發者還沒進模型的補句從批次取出來，整理成工具回覆。
 * 圖片留給正常批次，模型才看得到；沒有補句回 null。
 *
 * @param options.batcher  createBatcher 的回傳值
 * @param options.key      會話 key
 * @param options.userIds  這一輪叫 bot 的人
 * @param options.refs     createMessageRefs()：補句要登記 #編號，模型才能 reply_to
 * @returns {{taken: object[], notice: string} | null}
 */
export function takeFollowups({ batcher, key, userIds, refs }) {
  const taken = batcher.take(key, userIds);
  if (taken.length === 0) return null;
  const entries = [...taken].sort((a, b) => a.at - b.at).map((entry) => ({
    author: entry.author,
    text: entry.text,
    direct: entry.direct,
    isOwner: entry.isOwner,
    ref: refs.register(key, entry.id, { authorId: entry.userId, at: entry.at }),
    // 補句如果是回覆別人，模型至少要看得到在回誰；引用內容留給正常批次。
    replyName: entry.message ? repliedName(entry.message) : '',
    hasImage: entry.hasImage,
  }));
  return {
    taken,
    notice: `剛剛有新訊息，這則先沒送出。請看完後重新決定要不要回、怎麼回：\n${formatBatch(entries, { guild: Boolean(taken.at(-1)?.guildId) })}`,
  };
}
