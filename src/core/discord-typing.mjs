/**
 * @ 模式頻道的補句窗口：叫過 bot 的人 60 秒內，他沒 @ 的訊息也算補句。
 *
 * 為什麼不把 typing 當必要條件：實測 Discord 送出一則訊息後，TYPING_START 大約 3~8 秒
 * 才會再送一次；快速接著打的補句根本等不到事件。typing 只用來延長窗口，最多延到
 * maxMs（從 @ 的那一刻算），不然一直打字就永遠不會關。
 */
export function createUrgentTyping({ authorMs = 60_000, maxMs = 2 * 60_000, typingMs = 10_000, now = Date.now } = {}) {
  const authors = new Map(); // key -> Map<userId, { until, cap }>

  function set(key, userId, until, cap) {
    let users = authors.get(key);
    if (!users) {
      users = new Map();
      authors.set(key, users);
    }
    // 順手清過期的，map 才不會一直長。
    const at = now();
    for (const [id, entry] of users) if (entry.until <= at) users.delete(id);
    users.set(String(userId), { until, cap });
  }

  function live(key, userId) {
    const users = authors.get(key);
    const id = String(userId);
    const entry = users?.get(id);
    if (!entry || entry.until <= now()) {
      users?.delete(id);
      return null;
    }
    return entry;
  }

  return {
    /** 有人 @／回覆 bot：開一個 authorMs 的窗口，硬上限是 maxMs。 */
    sawAuthor(key, userId) {
      const at = now();
      set(key, userId, at + authorMs, at + maxMs);
    },
    /** 打字事件；在窗口內就延長，但不能超過硬上限。回傳有沒有延到。 */
    sawTyping(key, userId) {
      const entry = live(key, userId);
      if (!entry) return false;
      entry.until = Math.min(entry.cap, Math.max(entry.until, now() + typingMs));
      return true;
    },
    /** 這則沒 @ 的訊息算不算補句；窗口內可以連收多則。 */
    takeFollowUp(key, userId) {
      return Boolean(live(key, userId));
    },
    /** /reset：舊對話的窗口不要留。 */
    drop(key) {
      authors.delete(key);
    },
  };
}
