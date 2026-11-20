// Discord 送出：會話改名、頻道解析與分條發送。
// 拆自 discord-bridge.js 的 main()；emoji 目錄用 getter 拿，快照會停在舊目錄。
import { AttachmentBuilder, MessageFlags } from 'discord.js';
import { splitDiscordMessage, sessionTitleFor } from './discord-core.mjs';
import { substituteEmojiNames } from './discord-emoji.mjs';
import { visibleName } from './discord-batch.mjs';

export function createOutputLayer({
  api,
  cfg,
  log,
  unwrap,
  client,
  channelCache,
  sleep,
  refreshEmojiCatalogs,
  getEmojiCatalogs,
}) {
  // ── Discord 送出 ─────────────────────────────────────────────────────────

  /** 在第一批送進去之前設好標題；失敗只記日誌，標題不值得擋住投遞。 */
  async function renameSession(sessionId, key = null, fallbackTitle = 'Discord 黑話學習') {
    let title = fallbackTitle;
    try {
      if (key) {
        const channel = await resolveChannel(key).catch(() => null);
        const user = channel?.recipient;
        title = sessionTitleFor(key, {
          channelName: channel?.name,
          guildName: channel?.guild?.name,
          userName: visibleName(user?.globalName, user?.username),
        });
      }
      unwrap(await api.sessions.rename({ sessionId, title }), 'session.rename');
    } catch (error) {
      log(`會話改名失敗（${title}）：${error?.message ?? error}`);
    }
  }

  async function resolveChannel(key) {
    if (channelCache.has(key)) return channelCache.get(key);
    const [kind, id] = key.split(':');
    const channel = kind === 'ch'
      ? await client.channels.fetch(id)
      : await (await client.users.fetch(id)).createDM();
    if (!channel) throw new Error(`找不到 ${key} 對應的頻道`);
    channelCache.set(key, channel);
    return channel;
  }

  /**
   * replyTo 和檔案只掛在第一段，sticker 只掛在最後一段。file 是 {buffer, name}；
   * voice 的檔案多帶 waveform/duration，而且整則要掛 IsVoiceMessage。
   */
  async function sendLong(key, text, { replyTo = null, stickerId = null, file = null, voice = false } = {}) {
    const channel = await resolveChannel(key);
    refreshEmojiCatalogs();
    // 模型輸出 `:名稱:`，這裡換成真正的 emoji tag；找不到就保留原文。
    const rendered = substituteEmojiNames(text, { guildId: channel.guildId ?? null, catalogs: getEmojiCatalogs() });
    const parts = splitDiscordMessage(rendered, cfg.discord.maxMessageChars);
    if (parts.length === 0 && (stickerId || file)) parts.push('');
    const sent = [];
    for (const [index, part] of parts.entries()) {
      sent.push(await channel.send({
        ...(part ? { content: part } : {}),
        ...(index === 0 && replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
        ...(index === 0 && file ? { files: [fileAttachment(file)] } : {}),
        ...(index === 0 && voice ? { flags: MessageFlags.IsVoiceMessage } : {}),
        ...(index === parts.length - 1 && stickerId ? { stickers: [stickerId] } : {}),
        // parse: [] —— 模型輸出不會意外 @everyone 或 @某人；回覆也不額外 ping 對方
        allowedMentions: { parse: [], repliedUser: false },
      }));
      if (cfg.discord.sendDelayMs > 0) await sleep(cfg.discord.sendDelayMs);
    }
    return sent;
  }

  /** 一般附件直接丟物件；語音要 waveform 與 duration 才走 AttachmentBuilder。 */
  function fileAttachment(file) {
    if (!file?.waveform) return { attachment: file.buffer, name: file.name };
    const attachment = new AttachmentBuilder(file.buffer, { name: file.name });
    attachment.setWaveform(file.waveform);
    if (Number(file.duration) > 0) attachment.setDuration(Number(file.duration));
    return attachment;
  }
return {
    renameSession,
    resolveChannel,
    sendLong,
  };
}
