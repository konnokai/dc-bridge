// Discord 入口事件：訊息、reaction、typing 與 slash 命令。
// 拆自 discord-bridge.js 的 main()；這層只做准入判斷與分派，
// 批次組裝在 turns 層、工具在 agent-tools 層。
import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import {
  INVITE_PERMISSIONS,
  adminLinks,
  buildInviteUrl,
  canResetConversation,
  conversationKeyFor,
  isChattyChannel,
  isConversationAllowed,
  isSkippedMessage,
  parseSlashCommand,
  presetForChannelKey,
  runSlashCommand,
  shouldHandleGuildMessage,
  slashInputAction,
  splitDiscordMessage,
  stripBotMention,
  withSelfMutedUser,
} from './discord-core.mjs';
import { unwrap } from '../dsh-client.js';
import { bumpEmojiUsage, labelEmojiTags } from './discord-emoji.mjs';
import { collectMediaAttachments, stickerImages, stickerLabel } from './discord-media.mjs';
import { forgetUser, formatUserMemory, userFacts } from './discord-memory.mjs';
import { formatCodexQuota } from './discord-codex-quota.mjs';
import { formatQuota } from './discord-usage.mjs';
import { isQuietBatchSkipped } from './discord-quiet.mjs';
import { messageParts, promptBody } from './discord-context.mjs';
import { resolveMentions } from './discord-batch.mjs';
import { playerAccountId } from './discord-trade.mjs';

export function createInbound({
  cfg,
  log,
  api,
  client,
  sessions,
  sessionPresets,
  archive,
  archiveQueue,
  archiveEntry,
  queueArchive,
  activity,
  agentSender,
  answerPending,
  authorName,
  batcher,
  codexQuotaInfo,
  collectSlangSample,
  DSH_COMMAND_TIMEOUT_MS,
  flat,
  forgetTradeAccount,
  forgetTriggerUser,
  formatPortfolioResult,
  getTradeService,
  ignoredUser,
  lastActive,
  markEmojiUsageDirty,
  markMemoryDirty,
  maybeReact,
  memoryStore,
  noteHuman,
  ownerIds,
  pending,
  primedKeys,
  quietUntil,
  quotaInfo,
  reactionInbox,
  reloadSystemPrompt,
  requireMentionFor,
  requireMentionInGuild,
  resetConversation,
  sendLong,
  silentPending,
  slashCommandData,
  turnGate,
  updateConfig,
  urgentTyping,
  writeTurn,
  emojiUsage,
  getArchiveFlushing,
  getConsoleTokenValue,
  getEmojiCatalogs,
}) {
  /** 自己的訊息收到 reaction：只記下來，下一批 prompt 再講；不觸發回合。 */
  async function handleReaction(reaction, user) {
    if (!reaction || !user || user.bot) return;
    // 模型自己不理的人，他的 reaction 也不收：整個人的輸入都不進來。
    if (ignoredUser(user.id)) return;
    // 先查這則是不是模型自己送的，才決定要不要打 API 抓訊息：白名單外的 reaction 直接丟掉。
    const key = agentSender.ownedKey(reaction.message?.id);
    if (!key) return;
    try {
      if (reaction.partial) await reaction.fetch();
      const message = reaction.message;
      if (message?.partial) await message.fetch();
      const emoji = reaction.emoji?.id ? `:${reaction.emoji.name}:` : reaction.emoji?.name;
      if (!emoji) return;
      reactionInbox.add(key, message.id, emoji, reaction.count ?? 1);
      log(`收到 reaction ${key}（${emoji}×${reaction.count ?? 1}）`);
    } catch (error) {
      log(`讀取 reaction 失敗：${error?.message ?? error}`);
    }
  }

  /**
   * `/` 開頭的訊息：橋接支援的 DSH 指令直接執行，其餘只回提示。
   * 一律不進批次：批次會包成【新訊息】，模型只會把它當一般文字回答。
   */
  async function handleSlashText(key, text) {
    let result;
    try {
      result = await runSlashCommand({
        text,
        sessionId: sessions[key] ?? null,
        executeCommand: async (sessionId, line) => unwrap(
          await api.commands.execute({
            agentId: sessionId,
            line,
            submittedAttachments: [],
          }, AbortSignal.timeout(DSH_COMMAND_TIMEOUT_MS)),
          'commands.execute',
        ),
      });
    } catch (error) {
      log(`斜線指令失敗 ${key}：${error?.stack ?? error}`);
      await sendLong(key, '指令執行失敗，詳情看橋接日誌。');
      return;
    }
    const gui = '請到 DSH Web GUI 操作';
    if (result.kind === 'executed') {
      const outcome = result.outcome;
      await sendLong(key, outcome?.kind === 'success'
        ? (outcome.text || `/${result.name} 完成。`)
        : (outcome?.text || `/${result.name} 失敗。`));
      return;
    }
    if (result.kind === 'no-session') {
      await sendLong(key, `這個頻道還沒有會話，沒有東西可以執行 /${result.name}；先傳一則訊息。`);
      return;
    }
    if (result.kind === 'unknown') {
      await sendLong(key, `這個 DSH 沒有 /${result.name} 指令；${gui}。`);
      return;
    }
    const name = result.name ? `/${result.name}` : '這則訊息';
    await sendLong(key, `「${name}」不能在 Discord 訊息裡直接執行；${gui}。如果是這個 bot 的指令，請用 Discord 的斜線指令選單，打字送出的 / 不會執行。`);
  }

  async function handleMessage(message) {
    if (!message || message.author?.bot || message.webhookId) return;
    const guildId = message.guildId ?? null;
    const ids = {
      guildId,
      channelId: message.channelId,
      parentId: message.channel?.isThread?.() ? message.channel.parentId : null,
      userId: message.author.id,
    };
    // 模型自己的不理名單：@ 也不處理，沒有例外。管理員永遠不受這份名單影響。
    if (ignoredUser(message.author.id)) {
      // 頻道白名單外不記：bot 看得到全部頻道，全記會灌爆檔案。
      if (isConversationAllowed(cfg.discord, ids)) {
        writeTurn(
          guildId ? `ch:${message.channelId}` : `dm:${message.author.id}`,
          { chatty: isChattyChannel(cfg.discord, message.channelId) },
          'skipped',
          { reason: 'ignored', users: [message.author.id], scope: 'message' },
        );
      }
      return;
    }
    const mentioned = message.mentions?.users ? [...message.mentions.users.keys()] : [];
    const repliedUserId = message.mentions?.repliedUser?.id ?? null;
    // 自己用 /blacklist 退出的人：@bot 或回覆 bot 才照正常流程，其他訊息只當頻道背景。
    const addressedToBot = Boolean(guildId)
      && shouldHandleGuildMessage({ mentionedUserIds: mentioned, repliedUserId }, client.user.id, true);
    if (!isConversationAllowed(cfg.discord, ids)) {
      // 頻道白名單外的訊息不記：bot 看得到全部頻道，全記會灌爆檔案。
      // 私聊只有使用者這一層；伺服器頻道另外用空的使用者 id 判斷頻道本身是否允許。
      const id = String(message.author.id);
      const blocked = cfg.discord.deny.users.includes(id) || (!guildId && cfg.discord.deny.self.includes(id));
      const channelAllowed = guildId ? isConversationAllowed(cfg.discord, { ...ids, userId: '' }) : blocked;
      if (blocked && channelAllowed) {
        writeTurn(
          guildId ? `ch:${message.channelId}` : `dm:${message.author.id}`,
          { chatty: isChattyChannel(cfg.discord, message.channelId) },
          'skipped',
          { reason: 'denied', users: [message.author.id], scope: 'message' },
        );
      }
      return;
    }
    const key = conversationKeyFor(ids);
    // 讓位緩衝：所有允許的訊息都記，含 ⊘ 與 //；讓位要看到誰插話。
    noteHuman(key, message);
    if (!addressedToBot && cfg.discord.deny.self.includes(message.author.id)) {
      // 記下這則還沒被上下文帶到：下一批若沒涵蓋它（它在批次最後一則之後），會再重帶一次。
      primedKeys.delete(key);
      silentPending.set(key, message.id);
      log(`略過 ${key} user=${message.author.id}（/blacklist 退出，只當上下文）`);
      writeTurn(key, { chatty: isChattyChannel(cfg.discord, message.channelId) }, 'skipped', {
        reason: 'denied', users: [message.author.id], scope: 'message',
      });
      return;
    }
    // 發言頻率：這則在 handleMessage 最前面就記，早於 // 與空訊息的 return。
    activity.record(key);
    // 表情使用次數：同樣早於 // 與空訊息的 return，// 訊息也算（那只是叫模型不要回，不是不存在）。
    const usageCatalog = guildId ? getEmojiCatalogs().get(String(guildId)) : null;
    if (cfg.discord.emoji.enabled && usageCatalog
      && bumpEmojiUsage(emojiUsage, guildId, message.content, { entries: usageCatalog.entries }) > 0) markEmojiUsageDirty();
    const quietAt = quietUntil(key);

    const parts = messageParts(message);
    const rawText = stripBotMention(parts.content, client.user.id);
    const text = resolveMentions(rawText, message);
    // 轉發的文字是別人貼進來的內容：給模型看，但不當成這一位群友說的話（黑話、提問回答、斜線指令都不算）。
    const fullText = resolveMentions(stripBotMention(parts.text, client.user.id), message);
    // 給模型看的內文保留 @你的位置：只剩 ★ 的話，模型會以為標錯人而跳過（2026-11-19 實際遇過）。
    const promptText = fullText ? promptBody(parts, message, client.user.id) : '';
    // `\//`（畫面顯示 `//`）開頭＝這則只給人看。標記優先於 @ 和提問回答。
    if (isSkippedMessage(message.content, client.user.id)) {
      log(`跳過 ${key} user=${message.author.id}（// 標記）`);
      return;
    }
    // 歷史歸檔掛在 // 之後：@ 模式的頻道沒 @ 的訊息（下面會 return）也要收，
    // 但 // 與 /blacklist 退出的人不收。文字跟編輯後重存用同一種寫法（bot 的名字留著），
    // 不然同一則在 recall_history 會有兩種長相。
    if (archive && guildId) queueArchive(archiveEntry(message, flat(resolveMentions(parts.text, message), 1000)), parts.text);
    // 有沒有在叫 bot：私聊一律算；頻道看 @ 或回覆。自由參與時沒叫 bot 的訊息也會進批次，
    // 但提問的回答只認叫 bot 的訊息。
    const direct = !guildId || addressedToBot;
    // @ 模式頻道：記住叫過 bot 的人，他 60 秒內的補句（沒 @）也收。
    if (addressedToBot) urgentTyping.sawAuthor(key, message.author.id);

    // 黑話語料：允許的頻道訊息都收（含沒叫 bot 的），才有足夠樣本。
    if (text) collectSlangSample(message, text);

    if (!direct) {
      // 沒叫 bot：偶爾留一個 reaction。預設模式到此為止；自由參與才送進批次讓模型決定。
      // 安靜期間連自動 reaction 都停，批次也直接丟掉（黑話語料上面已經收過）。
      if (!quietAt && text) await maybeReact(message, key, rawText).catch((error) => log(`表情反應失敗：${error?.message ?? error}`));
      // @ 模式：叫過 bot 的人 60 秒內，補句照收（不用再 @）；別人照舊丟掉。
      if (requireMentionFor(key) && !urgentTyping.takeFollowUp(key, message.author.id)) return;
      if (isQuietBatchSkipped({ direct, quietUntil: quietAt })) {
        writeTurn(key, { direct, chatty: isChattyChannel(cfg.discord, message.channelId) }, 'skipped', {
          reason: 'quiet', users: [message.author.id], scope: 'message',
        });
        return;
      }
    }

    const stickers = stickerLabel(parts.stickers);
    const media = cfg.discord.media.enabled
      ? collectMediaAttachments([...parts.attachments, ...stickerImages(parts.stickers)], cfg.discord.media)
      : { accepted: [], skipped: [] };
    // 只有 @bot／回覆 bot、沒有其他內容：不能當空訊息丟掉，模型要知道有人在叫它。
    const emptyDirect = direct && !fullText && !stickers && media.accepted.length === 0;
    if (!fullText && !stickers && media.accepted.length === 0) {
      if (direct && parts.attachments.length) {
        // 只有語音時說人話；其他附件維持原本的技術說明（含是哪一種格式被擋）。
        const audioOnly = media.skipped.length > 0 && media.skipped.every((item) => item.kind === 'audio');
        const reason = media.skipped[0]?.reason ?? '附件沒有送進模型';
        await sendLong(key, audioOnly ? '這則是語音或音訊，我聽不到；打字告訴我內容好嗎' : `附件沒有送進模型：${reason}`);
        return;
      }
      if (!direct) {
        writeTurn(key, { direct, chatty: isChattyChannel(cfg.discord, message.channelId) }, 'skipped', {
          reason: 'empty', users: [message.author.id], scope: 'message',
        });
        return;
      }
    }

    const isOwner = ownerIds.has(message.author.id);
    const author = authorName(message);
    log(`收到 ${key}${guildId ? ` guild=${guildId}` : ''} user=${message.author.id}${direct ? '' : '（沒叫 bot）'}`);

    // `/` 開頭不進批次：批次會包成【新訊息】，模型只會把它當一般文字回答。
    // 沒叫 bot 的 `/` 開頭直接丟掉、不公開回覆；只有管理員打的 /compact 例外。
    const slashName = parseSlashCommand(text)?.name ?? null;
    if (direct) {
      const hanging = pending.get(key);
      // 提問回答優先；只有管理員明確打 /compact 時先執行壓縮。
      const compactFirst = slashName === 'compact' && isOwner;
      if (!compactFirst && hanging && text && await answerPending(hanging, text, key, isOwner, message.author.id)) {
        writeTurn(key, { direct, chatty: isChattyChannel(cfg.discord, message.channelId) }, 'skipped', {
          reason: hanging.kind === 'approval' ? 'gate' : 'ask',
          users: [message.author.id], scope: 'message',
        });
        return;
      }
    }
    const slashAction = slashInputAction({
      text,
      direct,
      isOwner,
      executable: slashName === 'compact',
    });
    if (slashAction === 'ignore') return;
    if (slashAction === 'deny') {
      await sendLong(key, slashName === 'compact'
        ? '壓縮是管理指令，只有管理員能執行；管理員可以在 DSH Web GUI 的壓縮控制項操作。'
        : '管理指令僅管理員可用。');
      return;
    }
    if (slashAction === 'handle') {
      await handleSlashText(key, text);
      return;
    }

    batcher.add(key, {
      id: message.id,
      message,
      channel: message.channel,
      guildId,
      userId: message.author.id,
      author,
      text: [labelEmojiTags(promptText, getEmojiCatalogs()), stickers, emptyDirect ? '[沒有文字，只有叫你]' : ''].filter(Boolean).join(' '),
      // 黑話比對用原文：表情描述是目錄產生的字，不該被當成群友講的話。
      rawText: [fullText, stickers, emptyDirect ? '[沒有文字，只有叫你]' : ''].filter(Boolean).join(' '),
      direct,
      // 頻道裡有人 @ 或回覆 bot：這批改用短等待（urgentMs，8 秒），不用等滿 debounce。
      // 只 @ 不說話的那則不算：他補下一則時整批才升成 urgent（discord-batch.mjs 的 followsDirect）。
      // 私聊每則都算 direct；跟著 urgent 的話每則各自開回合，反而把分句拆開。
      urgent: addressedToBot && !emptyDirect,
      isOwner,
      media,
      hasImage: parts.hasImage,
      // 整則沒有文字、只有圖片／貼圖：chatty 頻道的純媒體閘門用。
      mediaOnly: !fullText && (media.accepted.length > 0 || parts.stickers.length > 0),
      at: message.createdTimestamp,
    });
    lastActive.set(key, Date.now());
  }

  /**
   * 有人在打字：這批裡已經有他的訊息就延長合批（最多 typingMs），
   * 分句還沒打完就不會被 debounce 或 urgent 的 timer 切掉；@ 模式的補句窗口也一起延。
   */
  function handleTyping(typing) {
    const channel = typing?.channel;
    const user = typing?.user;
    if (!channel || !user || user.bot) return;
    const ids = {
      guildId: channel.guildId ?? null,
      channelId: channel.id,
      parentId: channel.isThread?.() ? channel.parentId : null,
      userId: user.id,
    };
    if (!isConversationAllowed(cfg.discord, ids)) return;
    const key = conversationKeyFor(ids);
    batcher.extend(key, user.id);
    // @ 模式：叫過 bot 的人還在打字，補句窗口再往後延。
    urgentTyping.sawTyping(key, user.id);
  }

  async function handleSlashCommand(interaction) {
    // 私聊只開放 forget/reset/reload-system-prompt/status（其餘指令在 DM 沒有意義）。
    if (!interaction.inGuild() && !['forget', 'reset', 'reload-system-prompt', 'status', 'portfolio'].includes(interaction.commandName)) {
      await interaction.reply({ content: '這個指令只能在伺服器頻道使用。', flags: MessageFlags.Ephemeral });
      return;
    }
    // 看、刪記憶是自己的事，不需要管理員權限。
    if (interaction.commandName === 'memory') {
      const facts = userFacts(memoryStore, { userId: interaction.user.id });
      const profile = memoryStore.users?.[String(interaction.user.id)]?.profile;
      await interaction.reply({
        content: facts.length
          ? `我記得你的事（所有伺服器共用）：\n${formatUserMemory(facts)}`
            + `${profile ? `\n\n側寫（我從這些事歸納的，不是你說的話）：\n${profile}` : ''}`
            + '\n\n要全部刪掉用 /forget。'
          : '我沒有記住你的事。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'forget') {
      const removed = forgetUser(memoryStore, { userId: interaction.user.id });
      if (removed) markMemoryDirty();
      // 歷史歸檔：先拿走佇列裡這個人還沒送的，再等正在送的那批，最後才刪，避免刪完又被寫回去。
      let archiveFailed = false;
      if (archive) {
        for (let i = archiveQueue.length - 1; i >= 0; i -= 1) {
          if (archiveQueue[i].authorId === interaction.user.id) archiveQueue.splice(i, 1);
        }
        try {
          await getArchiveFlushing();
          await archive.forgetUser(interaction.user.id);
        } catch (error) {
          archiveFailed = true;
          log(`/forget 刪除歷史歸檔失敗：${error?.message ?? error}`);
        }
      }
      const statsRemoved = forgetTriggerUser(interaction.user.id);
      let tradeRemoved = false;
      try {
        tradeRemoved = forgetTradeAccount(interaction.user.id);
      } catch (error) {
        log(`/forget 刪除模擬帳戶失敗：${error?.message ?? error}`);
      }
      await interaction.reply({
        content: removed || statsRemoved || tradeRemoved || archive
          ? `已刪除我記下的關於你的事與模擬股票帳戶，所有伺服器一起刪${archive ? '，以及你在頻道歷史紀錄裡發過的訊息' : ''}`
            + `${archiveFailed ? '（歷史紀錄沒刪成功，晚點再試一次 /forget）' : ''}（目前頻道的對話上下文不受影響）。`
          : '我沒有你的記憶或模擬帳戶。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'portfolio') {
      const tradeSvc = getTradeService();
      if (!tradeSvc) {
        await interaction.reply({ content: '模擬股票沒有開啟（config.json 的 discord.trade.enabled）。', flags: MessageFlags.Ephemeral });
        return;
      }
      try {
        const portfolio = await tradeSvc.portfolio(playerAccountId(interaction.user.id));
        const text = formatPortfolioResult(portfolio);
        await interaction.reply({ content: splitDiscordMessage(text, 1900)[0], flags: MessageFlags.Ephemeral });
      } catch (error) {
        await interaction.reply({ content: `查不到模擬帳戶：${error?.message ?? error}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (interaction.commandName === 'blacklist') {
      // 管理員封鎖不能自己解除，否則擁有者的名單形同虛設。
      if (cfg.discord.deny.users.includes(interaction.user.id)) {
        await interaction.reply({ content: '你在管理員的黑名單裡，只有管理員能移除。', flags: MessageFlags.Ephemeral });
        return;
      }
      const muted = cfg.discord.deny.self.includes(interaction.user.id);
      try {
        await updateConfig({ deny: withSelfMutedUser(cfg.discord.deny, interaction.user.id, !muted) });
      } catch (error) {
        await interaction.reply({ content: `更新失敗：${error?.message ?? error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      log(`slash /blacklist ${muted ? 'leave' : 'join'} user=${interaction.user.id}`);
      await interaction.reply({
        content: muted
          ? '已把你移出黑名單，bot 又會處理你的訊息了。'
          : '已把你加入黑名單：bot 不會回你的訊息、也不會按你訊息的表情（所有伺服器共用），只有 @我 或回覆我時才會回。你的訊息仍會當頻道背景，讓它看懂上下文。再跑一次 /blacklist 可以移出。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const key = conversationKeyFor({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    // 選單的 default_member_permissions 只是讓一般成員看不到（Discord 沒辦法只開給某一個人），
    // 執行時再判斷一次：/reset 與 /reload-system-prompt 開給這個伺服器的管理者
    // （只限白名單裡的頻道，其他頻道本來就沒有 bot 的會話），其他管理指令只認 ownerIds。
    if (!ownerIds.has(interaction.user.id)) {
      const canControlConversation = interaction.commandName === 'reset'
        || interaction.commandName === 'reload-system-prompt';
      const allowed = canControlConversation
        && canResetConversation({ isOwner: false, guildId: interaction.guildId, permissions: interaction.memberPermissions })
        && isConversationAllowed(cfg.discord, {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          parentId: interaction.channel?.isThread?.() ? interaction.channel.parentId : null,
          // 這裡問的是「頻道有沒有開放」，不是這個人有沒有退出；他的名單狀態不影響頻道判定。
          userId: '',
        });
      if (!allowed) {
        await interaction.reply({
          content: canControlConversation
            ? (interaction.guildId
              ? '重置／重載提示只有 bot 擁有者或這個伺服器裡有 Administrator 權限的人能用，而且頻道要有開放 bot。'
              : '重置／重載提示只有 bot 擁有者能用。')
            : '這個指令只有 bot 擁有者能用。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    log(`slash /${interaction.commandName} ${key} user=${interaction.user.id}`);

    if (interaction.commandName === 'ask') {
      const question = String(interaction.options.getString('text', true) ?? '').trim();
      if (!question) {
        await interaction.editReply('問題是空的。');
        return;
      }
      const hasSession = Boolean(sessions[key]);
      const channelAllowed = isConversationAllowed(cfg.discord, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        parentId: interaction.channel?.isThread?.() ? interaction.channel.parentId : null,
        userId: interaction.user.id,
      });
      if (!hasSession && !channelAllowed) {
        await interaction.editReply('這個頻道沒有開放 bot，沒有可以問的會話。');
        return;
      }
      // 排進同一條會話佇列：前面有回合就等它跑完，不直接拒絕；之前的訊息也先排進去。
      batcher.flush(key);
      try {
        const answer = await new Promise((resolve, reject) => {
          turnGate.submit(
            key,
            { ask: { question, resolve, reject } },
            { noStuckRelease: true },
          );
        });
        const parts = splitDiscordMessage(answer, cfg.discord.maxMessageChars);
        await interaction.editReply(parts[0] ?? answer);
        for (const part of parts.slice(1)) {
          await interaction.followUp({ content: part, flags: MessageFlags.Ephemeral });
        }
      } catch (error) {
        await interaction.editReply(`後台提問失敗：${error?.message ?? error}`);
      }
      return;
    }

    if (interaction.commandName === 'invite') {
      const url = buildInviteUrl(client.user.id);
      await interaction.editReply({
        content: [
          '邀請連結（內含目前功能所需權限，只有你看得到）：',
          url,
          `權限：${INVITE_PERMISSIONS.map((permission) => permission.label).join('、')}`,
          '保留 `applications.commands` scope，slash command 才會生效。',
        ].join('\n'),
      });
      return;
    }
    if (interaction.commandName === 'console') {
      const links = adminLinks({ dshBaseUrl: cfg.dsh.baseUrl, console: cfg.discord.console, consoleToken: getConsoleTokenValue() });
      await interaction.editReply({
        content: '後台連結（只有你看得到；控制台連結含 token，不要轉貼）：',
        components: [{
          type: ComponentType.ActionRow,
          components: links.map(({ label, url }) => ({ type: ComponentType.Button, style: ButtonStyle.Link, label, url })),
        }],
      });
      return;
    }
    if (interaction.commandName === 'reset') {
      try {
        const done = await resetConversation(key);
        await interaction.editReply(done
          ? '已重置會話，下一則訊息會開新上下文。'
          : '目前沒有可重置的會話（下一則訊息會開新的）。');
      } catch (error) {
        await interaction.editReply(`重置失敗：${error?.message ?? error}`);
      }
      return;
    }
    if (interaction.commandName === 'reload-system-prompt') {
      try {
        const result = await reloadSystemPrompt(key);
        await interaction.editReply(result.message);
      } catch (error) {
        await interaction.editReply(`重載提示失敗：${error?.message ?? error}`);
      }
      return;
    }
    if (interaction.commandName === 'status') {
      const [subscriptionUsage, codexUsage] = await Promise.all([quotaInfo(), codexQuotaInfo()]);
      const sessionId = sessions[key];
      const configuredPreset = presetForChannelKey(cfg.discord, key);
      const actualPreset = sessionId ? sessionPresets[sessionId] : '';
      const presetLine = actualPreset
        ? `preset ${actualPreset}${actualPreset !== configuredPreset ? `｜下次 ${configuredPreset}` : ''}`
        : sessionId
          ? `preset 未知（舊會話）｜下次 ${configuredPreset}`
          : `preset ${configuredPreset}（下次建立）`;
      const lines = [`會話 ${sessionId ?? '未建立'}｜${presetLine}｜${interaction.guildId ? '頻道' : '私聊'}`];
      const subscriptionLine = formatQuota(subscriptionUsage);
      if (subscriptionLine) lines.push(subscriptionLine);
      const codexLine = formatCodexQuota(codexUsage);
      if (codexLine) lines.push(codexLine);
      await interaction.editReply(lines.join('\n'));
      return;
    }
    if (interaction.commandName === 'mention') {
      // 沒開意圖時跟控制台一樣不寫入：寫了 false，日後開意圖重啟就會突然變自由參與。
      if (!cfg.discord.messageContentIntent) {
        await interaction.editReply('沒開 Message Content 意圖，收不到沒 @bot 的訊息內容，所以一律要 @bot，不能切換。');
        return;
      }
      try {
        await updateConfig({ requireMentionInGuild: !requireMentionInGuild() });
      } catch (error) {
        await interaction.editReply(`切換失敗：${error?.message ?? error}`);
        return;
      }
      const mode = requireMentionInGuild() ? '頻道要 @bot 或回覆 bot 才回' : '自由參與（模型自己決定要不要接話）';
      await interaction.editReply(`已切換成：${mode}。這個設定所有伺服器共用；個別頻道的 requireMentionInChannel 優先。`);
      return;
    }
    await interaction.editReply('未知的指令。');
  }

  async function registerSlashCommands() {
    const application = client.application;
    if (!application) return;
    // 只註冊全域指令。伺服器指令會和全域指令同時出現在 `/` 選單（實測會重複兩份），
    // 所以不做 per-guild 註冊。代價是全域指令在 Discord 端最多要等一小時才生效。
    try {
      await application.commands.set(slashCommandData);
      log(`已註冊全域 slash command：${slashCommandData.map((c) => c.name).join(', ')}`);
    } catch (error) {
      log(`註冊全域 slash command 失敗（邀請連結需要 applications.commands scope）：${error?.message ?? error}`);
    }
  }
  return {
    handleReaction,
    handleMessage,
    handleTyping,
    handleSlashCommand,
    registerSlashCommands,
  };
}
