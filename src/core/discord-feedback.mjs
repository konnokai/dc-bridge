// 模型自己送出的訊息收到 reaction 時先存著，下一批 prompt 再一起告訴它。
//
// reaction 本身不觸發回合：只記在這裡，等下一批訊息進來才附上。

export const FEEDBACK_MAX_MESSAGES = 10;

/**
 * @param options.maxMessages 每個 key 最多留幾則訊息
 */
export function createReactionInbox({ maxMessages = FEEDBACK_MAX_MESSAGES } = {}) {
  const byKey = new Map(); // key -> Map(messageId -> Map(emoji -> count))

  function add(key, messageId, emoji, count = 1) {
    const id = String(messageId ?? '');
    const label = String(emoji ?? '').trim();
    if (!key || !id || !label) return;
    let messages = byKey.get(key);
    if (!messages) {
      messages = new Map();
      byKey.set(key, messages);
    }
    let emojis = messages.get(id);
    if (!emojis) {
      emojis = new Map();
      messages.set(id, emojis);
    }
    emojis.set(label, Math.max(Number(count) || 1, emojis.get(label) ?? 0));
    // 同一則訊息合併；超過上限丟最舊的訊息。
    while (messages.size > maxMessages) messages.delete(messages.keys().next().value);
  }

  /** 只看不拿：prompt 真的送進 DSH 後才 clear，DSH 失敗重試時不會漏掉。 */
  function peek(key) {
    const messages = byKey.get(key);
    if (!messages) return [];
    return [...messages].map(([messageId, emojis]) => ({
      messageId,
      emojis: [...emojis].map(([emoji, count]) => ({ emoji, count })),
    }));
  }

  /**
   * 清掉已經寫進 prompt 的那幾筆；peek 之後才進來的 reaction（計數變大或新表情）留著，
   * 下一批再報。entries 省略時清掉整個 key。
   */
  function clear(key, entries = null) {
    const messages = byKey.get(key);
    if (!messages) return;
    if (!entries) {
      byKey.delete(key);
      return;
    }
    for (const entry of entries) {
      const emojis = messages.get(entry.messageId);
      if (!emojis) continue;
      for (const { emoji, count } of entry.emojis) {
        if ((emojis.get(emoji) ?? 0) <= count) emojis.delete(emoji);
      }
      if (emojis.size === 0) messages.delete(entry.messageId);
    }
    if (messages.size === 0) byKey.delete(key);
  }

  return { add, peek, clear };
}

/** @param refOf (messageId) => #編號字串 */
export function formatReactionInbox(entries, refOf) {
  if (!entries?.length) return '';
  const lines = entries.map((entry) => {
    const ref = refOf(entry.messageId);
    if (!ref) return '';
    const emojis = entry.emojis.map(({ emoji, count }) => `${emoji}×${count}`).join('、');
    return `#${ref} ${emojis}`;
  }).filter(Boolean);
  return lines.length ? `【你的訊息收到的反應】\n${lines.join('\n')}` : '';
}
