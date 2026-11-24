// 控制台：HTTP API、供應商設定與所有管理端點。
// 拆自 discord-bridge.js 的 main()；updateConfig／providerSettings／console handlers
// 互引密集，一個模組承載。consoleTokenValue 由模組持有並開 getter 給 inbound。
// 段內有頂層 await（startConsole），factory 是 async，入口接線要 await。
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import {
  INVITE_PERMISSIONS,
  INVITE_SCOPES,
  PROVIDER_KEY_REFS,
  buildInviteUrl,
  catalogView,
  invitePermissionsBitfield,
  normalizeDiscordConfig,
  normalizeHedgeConfig,
  parseKeyAction,
  parseMessageLink,
  validateModelChoice,
  sessionLabelFor,
} from './discord-core.mjs';
import { flat, textArg } from './discord-context.mjs';
import {
  SLANG_STATUS,
  confirmSlang,
  confirmSlangMany,
  deleteSlang,
  rejectSlang,
  rejectSlangMany,
  slangStats,
  updateSlang,
} from './discord-slang.mjs';
import {
  BODY_MAX_CHARS as KNOWLEDGE_BODY_MAX_CHARS,
  MAX_APPROVED,
  TITLE_MAX_CHARS,
  confirmKnowledge,
  deleteKnowledge,
  knowledgeOverview,
  knowledgeStats,
  rejectKnowledge,
  saveCandidate as saveKnowledgeCandidate,
  updateKnowledge,
} from './discord-knowledge.mjs';
import { deleteDevFeedbackById, devFeedbackOverview } from './discord-dev-feedback.mjs';
import { deleteMemeById, memeFileName } from './discord-memes.mjs';
import { deleteNoteById, notesOverview } from './discord-notes.mjs';
import {
  ALIAS_STATUS,
  addManualAlias,
  aliasStats,
  deleteAliases,
  readAliasStore,
  readAliasStoreStatus,
  setAliasStatus,
  writeAliasStore,
} from './arknights-aliases.mjs';
import { loadTable, matchOperator } from './arknights-training.mjs';
import { memoryOverview } from './discord-memory.mjs';
import { ignoreList, unignore } from './discord-ignore.mjs';
import { resolveConsoleToken, startConsole } from './discord-console.mjs';
import { resolveMentions } from './discord-batch.mjs';
import { triggerStats, triggerUserList } from './discord-trigger-stats.mjs';

export async function createConsoleLayer({
  cfg,
  log,
  api,
  client,
  sessions,
  sessionPresets,
  ROOT,
  STATE_DIR,
  CONFIG_FILE,
  LOG_RING,
  MEMES_FILES_DIR,
  startedAt,
  ownerIds,
  archive,
  archiveQueue,
  archiveStatus,
  ceobeState,
  ceobeInfo,
  followups,
  ignoreStore,
  knowledgeStore,
  memeStore,
  memoryStore,
  devFeedbackStore,
  notesStore,
  slangStore,
  triggerStore,
  usage,
  usageInfo,
  quotaInfo,
  codexQuotaInfo,
  turns,
  applyTradeConfig,
  getTradeService,
  lastActive,
  localDayKey,
  persistMemesNow,
  quietUntil,
  reloadSystemPrompt,
  requireMentionInGuild,
  resetCeobeCache,
  resetConversation,
  saveIgnores,
  saveSlangNow,
  getSlangDayCount,
  getSlangDayKey,
  slangQueueInfo,
  startEmojiBuild,
  emojiBuildLogTail,
  warnChattyChannels,
  markDevFeedbackDirty,
  markKnowledgeDirty,
  markNotesDirty,
  offlineQueue,
  modelApplied,
  pending,
  primedKeys,
  silentPending,
  withTimeout,
  getArchiveFlushing,
  getEmojiBuild,
  getEmojiCatalogs,
}) {
  let consoleTokenValue = '';
  // ── 控制台 ───────────────────────────────────────────────────────────────
  /** 邀請連結：slash `/invite` 與控制台共用同一份權限清單。 */
  function inviteInfo() {
    return {
      url: buildInviteUrl(client.user.id),
      scopes: [...INVITE_SCOPES],
      bitfield: invitePermissionsBitfield().toString(),
      permissions: INVITE_PERMISSIONS.map(({ key, label, bit }) => ({ key, label, bit: bit.toString() })),
    };
  }

  function editableConfig() {
    return {
      allow: cfg.discord.allow,
      deny: cfg.discord.deny,
      ownerIds: cfg.discord.ownerIds,
      media: cfg.discord.media,
      tts: cfg.discord.tts,
      stt: {
        enabled: cfg.discord.stt.enabled,
        model: cfg.discord.stt.model,
        maxMediaSeconds: cfg.discord.stt.maxMediaSeconds,
      },
      context: cfg.discord.context,
      batch: cfg.discord.batch,
      security: cfg.discord.security,
      emoji: cfg.discord.emoji,
      memes: cfg.discord.memes,
      reactions: cfg.discord.reactions,
      memory: cfg.discord.memory,
      // 端點與 API key 只留在 config.json；控制台只編開關與保留天數。
      historyArchive: {
        enabled: cfg.discord.historyArchive.enabled,
        retentionDays: cfg.discord.historyArchive.retentionDays,
      },
      notes: cfg.discord.notes,
      knowledge: cfg.discord.knowledge,
      followup: cfg.discord.followup,
      ceobe: cfg.discord.ceobe,
      slang: cfg.discord.slang,
      videoLinks: cfg.discord.videoLinks,
      typing: cfg.discord.typing,
      sendDelayMs: cfg.discord.sendDelayMs,
      maxMessageChars: cfg.discord.maxMessageChars,
      ackMessage: cfg.discord.ackMessage,
      autoCompactTokens: cfg.discord.autoCompactTokens,
      ttftTimeoutMs: cfg.discord.ttftTimeoutMs,
      sandbox: cfg.discord.sandbox,
      requireMentionInGuild: cfg.discord.requireMentionInGuild,
      requireMentionInChannel: cfg.discord.requireMentionInChannel,
      chattyChannels: cfg.discord.chattyChannels,
      openPoliticsChannels: cfg.discord.openPoliticsChannels,
      trade: cfg.discord.trade,
      // 唯讀：改這些要重啟橋接或重生 preset
      messageContentIntent: cfg.discord.messageContentIntent,
      agentPreset: cfg.discord.agentPreset,
      provider: cfg.dsh.provider,
      model: cfg.dsh.model,
      console: { host: cfg.discord.console.host, port: cfg.discord.console.port },
    };
  }

  // ── 供應商（hedge）───────────────────────────────────────────────────────
  // `config.json` 的 `dsh.hedge` 是權威；DSH 的 `llm-hedge` 命名空間只是即時層。
  // 存檔後立刻推一次，橋接啟動與 DSH 重連也會再推，DSH 重啟不會洗掉設定。
  const HEDGE_NS = 'llm-hedge';
  const PROVIDER_LABELS = { 'opencode-go': 'OpenCode Go', commandcode: 'Command Code' };
  let providerCatalogCache = null; // { at, value }

  async function providerCatalog({ refresh = false } = {}) {
    const now = Date.now();
    const ttl = providerCatalogCache?.value?.ok ? 5 * 60_000 : 15_000;
    if (!refresh && providerCatalogCache && now - providerCatalogCache.at < ttl) return providerCatalogCache.value;
    let value;
    try {
      const raw = unwrap(await withTimeout(api.callUnary('session/modelCatalog', {}), 8000, 'session/modelCatalog'), 'session/modelCatalog');
      const view = catalogView(raw);
      value = {
        ...view,
        fetchedAt: now,
        hedgeAvailable: view.routableProviders.includes('hedge'),
        // hedge 是橋接自己，不能拿來當主線或備援。
        groups: view.groups.filter((group) => group.id !== 'hedge'),
        routableProviders: view.routableProviders.filter((provider) => provider !== 'hedge'),
      };
    } catch (error) {
      value = { ok: false, error: String(error?.message ?? error).slice(0, 300), fetchedAt: now, hedgeAvailable: false, groups: [], routableProviders: [], failures: [] };
    }
    providerCatalogCache = { at: now, value };
    return value;
  }

  async function providerKeyStates() {
    const refs = Object.values(PROVIDER_KEY_REFS);
    const described = unwrap(await api.callUnary('credentials/describe', { refs }), 'credentials/describe');
    return Object.entries(PROVIDER_KEY_REFS).map(([provider, ref]) => ({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      configured: described?.[ref]?.configured === true,
      writable: described?.[ref]?.writable === true,
      source: described?.[ref]?.source ?? null,
    }));
  }

  /** 橋接的 `dsh.hedge` 才是權威；DSH 的命名空間只是即時層，重連時會再推一次。 */
  async function providerSettings() {
    const [catalog, keys] = await Promise.all([
      providerCatalog(),
      providerKeyStates().catch((error) => ({ error: String(error?.message ?? error) })),
    ]);
    return {
      primary: {
        provider: cfg.dsh.provider,
        model: cfg.dsh.model,
        reasoningEffort: cfg.dsh.reasoningEffort,
      },
      active: cfg.dsh.provider === 'hedge',
      pluginReady: catalog.hedgeAvailable === true,
      hedge: {
        enabled: cfg.dsh.hedge.enabled,
        afterMs: cfg.dsh.hedge.afterMs,
        primary: {
          provider: cfg.dsh.hedge.primaryProvider,
          model: cfg.dsh.hedge.primaryModel,
          reasoningEffort: cfg.dsh.hedge.primaryEffort,
        },
        fallback: {
          provider: cfg.dsh.hedge.fallbackProvider,
          model: cfg.dsh.hedge.fallbackModel,
          reasoningEffort: cfg.dsh.hedge.fallbackEffort,
        },
      },
      catalog,
      keys,
    };
  }

  function writeDshConfig({ model, reasoningEffort, hedge }) {
    const doc = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    doc.dsh = { ...(doc.dsh ?? {}), provider: 'hedge', model, reasoningEffort, hedge: { ...hedge } };
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** 把橋接的設定推給 DSH 的 `llm-hedge`；回傳錯誤字串（成功回 null）。 */
  async function syncHedgeSettings() {
    if (cfg.dsh.provider !== 'hedge') return null;
    try {
      await api.settings.update({ ns: HEDGE_NS, patch: { ...cfg.dsh.hedge } });
      return null;
    } catch (error) {
      const message = String(error?.message ?? error);
      log(`同步 hedge 設定失敗：${message}`);
      return message;
    }
  }

  async function updateProviders(patch) {
    const primary = patch?.primary ?? {};
    const fallback = patch?.fallback ?? {};
    const enabled = patch?.enabled === true;
    const afterMs = Math.round(Number(patch?.afterMs));
    if (!Number.isFinite(afterMs) || afterMs < 3000 || afterMs > 115000) throw new Error('afterMs 必須在 3000~115000 之間');
    const catalog = await providerCatalog({ refresh: true });
    if (!catalog.ok) throw new Error(`讀不到 DSH 模型目錄：${catalog.error ?? '未知錯誤'}`);
    if (!catalog.hedgeAvailable) throw new Error('DSH 沒有 hedge provider：先跑 npm run setup:discord，再重啟 DSH');
    const primaryChoice = validateModelChoice(catalog, primary);
    const fallbackChoice = enabled
      ? validateModelChoice(catalog, fallback)
      : {
        provider: String(fallback?.provider ?? '').trim(),
        model: String(fallback?.model ?? '').trim(),
        reasoningEffort: String(fallback?.reasoningEffort ?? '').trim(),
      };
    const nextHedge = normalizeHedgeConfig({
      enabled,
      afterMs,
      primaryProvider: primaryChoice.provider,
      primaryModel: primaryChoice.model,
      primaryEffort: primaryChoice.reasoningEffort,
      fallbackProvider: fallbackChoice.provider,
      fallbackModel: fallbackChoice.model,
      fallbackEffort: fallbackChoice.reasoningEffort,
    }, { ttftTimeoutMs: cfg.discord.ttftTimeoutMs });
    writeDshConfig({ model: primaryChoice.model, reasoningEffort: primaryChoice.reasoningEffort, hedge: nextHedge });
    cfg.dsh.provider = 'hedge';
    cfg.dsh.model = primaryChoice.model;
    cfg.dsh.reasoningEffort = primaryChoice.reasoningEffort;
    cfg.dsh.hedge = nextHedge;
    // 下一批 ensureSession 會重新套模型；正在跑的回合不受影響。
    modelApplied.clear();
    const syncError = await syncHedgeSettings();
    log(`供應商設定：主線 ${primaryChoice.provider}/${primaryChoice.model}，備援 ${enabled ? `${fallbackChoice.provider}/${fallbackChoice.model}` : '關閉'}，門檻 ${afterMs}ms`);
    return { ...(await providerSettings()), synced: !syncError, syncError };
  }

  async function updateProviderKey(body) {
    const action = parseKeyAction(body);
    const states = await providerKeyStates();
    const target = states.find((key) => key.provider === action.provider);
    if (!target) throw new Error('未知的 provider');
    if (!target.writable) throw new Error(`${target.label} 的憑證檔不可寫`);
    if (action.action === 'set') {
      unwrap(await api.callUnary('credentials/set', { ref: action.ref, value: action.value }), 'credentials/set');
      log(`控制台：寫入 ${action.ref}`);
    } else {
      unwrap(await api.callUnary('credentials/unset', { ref: action.ref }), 'credentials/unset');
      log(`控制台：清除 ${action.ref}`);
    }
    const next = await providerKeyStates();
    return { ok: true, key: next.find((key) => key.provider === action.provider) };
  }

  async function updateConfig(patch) {
    // 只接受控制台表單會送的白名單與功能設定；其餘欄位（token、console、preset、模型）一律沿用目前值。
    // 每個區塊逐欄白名單：直接打 API 也不能塞 tts.baseUrl、videoLinks.ytDlpPath、emoji.dir 這類
    // 會讓橋接去連網址或執行程式的欄位。
    const pick = (base, incoming, keys) => {
      const out = { ...base };
      if (!incoming || typeof incoming !== 'object') return out;
      for (const key of keys) if (key in incoming) out[key] = incoming[key];
      return out;
    };
    const next = normalizeDiscordConfig({
      ...cfg.discord,
      allow: patch?.allow ?? cfg.discord.allow,
      deny: { ...cfg.discord.deny, ...(patch?.deny ?? {}) },
      ownerIds: patch?.ownerIds ?? cfg.discord.ownerIds,
      media: pick(cfg.discord.media, patch?.media, ['enabled', 'maxBytes', 'maxModelBytes', 'maxLongEdge', 'maxCount', 'timeoutMs', 'maxVideoSeconds']),
      tts: pick(cfg.discord.tts, patch?.tts, ['enabled', 'model', 'accent', 'refAudio', 'refText', 'timeoutMs', 'maxChars', 'cooldownSec', 'maxPerTurn', 'channels']),
      stt: pick(cfg.discord.stt, patch?.stt, ['enabled', 'model', 'maxMediaSeconds']),
      context: pick(cfg.discord.context, patch?.context, ['enabled', 'messages', 'maxChars']),
      batch: pick(cfg.discord.batch, patch?.batch, ['debounceMs', 'maxWaitMs', 'maxMessages']),
      security: pick(cfg.discord.security, patch?.security, ['blockSensitive']),
      emoji: pick(cfg.discord.emoji, patch?.emoji, ['enabled', 'maxCandidates', 'maxChars']),
      memes: pick(cfg.discord.memes, patch?.memes, ['enabled', 'max']),
      reactions: pick(cfg.discord.reactions, patch?.reactions, ['enabled', 'probability', 'cooldownMs', 'maxPerHour']),
      memory: pick(cfg.discord.memory, patch?.memory, ['enabled', 'profiles', 'maxFacts', 'maxChars']),
      // 端點（baseUrl／embedUrl／apiKey）只留在 config.json：和 tts.baseUrl 一樣，
      // 能從控制台改網址就等於讓控制台去連任何地方。這裡只開放開關與保留期。
      historyArchive: pick(cfg.discord.historyArchive, patch?.historyArchive, ['enabled', 'retentionDays']),
      notes: {
        ...pick(cfg.discord.notes, patch?.notes, ['enabled', 'injectMax', 'maxChars']),
        dailySummary: pick(cfg.discord.notes.dailySummary, patch?.notes?.dailySummary, ['enabled', 'hour']),
      },
      knowledge: pick(cfg.discord.knowledge, patch?.knowledge, ['enabled', 'maxChars', 'toolMaxChars']),
      followup: pick(cfg.discord.followup, patch?.followup, ['enabled']),
      // 控制台一次送整份 channels；只送 enabled 時不要把已設定的頻道蓋掉。
      ceobe: {
        ...cfg.discord.ceobe,
        ...(patch?.ceobe ?? {}),
        channels: patch?.ceobe?.channels ?? cfg.discord.ceobe.channels,
      },
      slang: {
        ...pick(cfg.discord.slang, patch?.slang, ['enabled', 'injectMax', 'maxChars']),
        jev: pick(cfg.discord.slang.jev, patch?.slang?.jev, ['mode', 'confirmAt', 'rejectBelow']),
      },
      videoLinks: pick(cfg.discord.videoLinks, patch?.videoLinks, ['enabled']),
      // 純量欄位只認正確型別：normalize 對 boolean 用 `!== false`，字串 "false" 會變成 true。
      typing: typeof patch?.typing === 'boolean' ? patch.typing : cfg.discord.typing,
      sendDelayMs: patch?.sendDelayMs ?? cfg.discord.sendDelayMs,
      maxMessageChars: patch?.maxMessageChars ?? cfg.discord.maxMessageChars,
      ackMessage: typeof patch?.ackMessage === 'string' ? patch.ackMessage : cfg.discord.ackMessage,
      autoCompactTokens: patch?.autoCompactTokens ?? cfg.discord.autoCompactTokens,
      ttftTimeoutMs: patch?.ttftTimeoutMs ?? cfg.discord.ttftTimeoutMs,
      // 控制台只編 enabled 與 channels；image、逾時、上限要改 config.json。
      sandbox: {
        ...cfg.discord.sandbox,
        enabled: typeof patch?.sandbox?.enabled === 'boolean'
          ? patch.sandbox.enabled
          : cfg.discord.sandbox.enabled,
        channels: Array.isArray(patch?.sandbox?.channels)
          ? patch.sandbox.channels
          : cfg.discord.sandbox.channels,
      },
      // 只認真的 boolean：normalize 用 `!== false`，字串 "false" 會被當成 true。
      requireMentionInGuild: typeof patch?.requireMentionInGuild === 'boolean'
        ? patch.requireMentionInGuild
        : cfg.discord.requireMentionInGuild,
      requireMentionInChannel: patch?.requireMentionInChannel ?? cfg.discord.requireMentionInChannel,
      chattyChannels: patch?.chattyChannels ?? cfg.discord.chattyChannels,
      openPoliticsChannels: patch?.openPoliticsChannels ?? cfg.discord.openPoliticsChannels,
      // trade 逐層合併：控制台表單只送有改的欄位，不要把其他費率或 Bot 設定蓋回預設值。
      trade: {
        ...cfg.discord.trade,
        ...(patch?.trade ?? {}),
        fees: { ...cfg.discord.trade.fees, ...(patch?.trade?.fees ?? {}) },
        settlement: { ...cfg.discord.trade.settlement, ...(patch?.trade?.settlement ?? {}) },
        fx: { ...cfg.discord.trade.fx, ...(patch?.trade?.fx ?? {}) },
        bot: {
          ...cfg.discord.trade.bot,
          ...(patch?.trade?.bot ?? {}),
          review: { ...cfg.discord.trade.bot.review, ...(patch?.trade?.bot?.review ?? {}) },
        },
      },
    });

    // 改 ttftTimeoutMs 不能讓現有的 hedge 設定在下次重啟時炸掉：先驗證再寫檔。
    try {
      normalizeHedgeConfig(cfg.dsh.hedge, { ttftTimeoutMs: next.ttftTimeoutMs });
    } catch (error) {
      throw new Error(`這個 ttftTimeoutMs 會讓 dsh.hedge 失效：${error?.message ?? error}`);
    }

    // 先寫檔再改記憶體：寫檔失敗時直接拋錯，設定和檔案都還是舊的。
    // 以前反過來做，toggle（/blacklist、/mention）失敗後重試會切到相反狀態。
    const doc = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    doc.discord = {
      ...(doc.discord ?? {}),
      allow: next.allow,
      deny: next.deny,
      ownerIds: next.ownerIds,
      media: next.media,
      sandbox: next.sandbox,
      requireMentionInGuild: next.requireMentionInGuild,
      requireMentionInChannel: next.requireMentionInChannel,
      chattyChannels: next.chattyChannels,
      openPoliticsChannels: next.openPoliticsChannels,
      trade: next.trade,
    };
    // 新區塊只在這次真的送了才寫回：/blacklist、/mention 不該把 tts、reactions 等
    // 整份 normalize 後的預設值一起寫進 config.json。
    for (const key of ['tts', 'stt', 'context', 'batch', 'security', 'emoji', 'memes', 'reactions', 'memory', 'notes', 'knowledge', 'followup', 'ceobe', 'slang', 'videoLinks', 'historyArchive']) {
      if (patch?.[key] !== undefined) doc.discord[key] = next[key];
    }
    for (const key of ['typing', 'sendDelayMs', 'maxMessageChars', 'ackMessage', 'autoCompactTokens', 'ttftTimeoutMs']) {
      if (patch?.[key] !== undefined) doc.discord[key] = next[key];
    }
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    // config.json 有 Discord token：rename 會換掉原檔，tmp 一定要沿用 0600。
    // 舊版留下的 tmp 可能還是 0644，先刪掉，mode 才會真的套用。
    fs.rmSync(tmp, { force: true });
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }

    // 切到自由參與（或改了單頻道覆寫）：讓受影響的頻道下一批重新帶一次上下文，
    // @ 模式期間沒叫 bot 的閒聊，模型沒看過。這裡一次清全部，設定變更不常發生。
    const mentionMapChanged = JSON.stringify(cfg.discord.requireMentionInChannel)
      !== JSON.stringify(next.requireMentionInChannel);
    if ((cfg.discord.requireMentionInGuild && !next.requireMentionInGuild) || mentionMapChanged) {
      primedKeys.clear();
      silentPending.clear();
    }
    cfg.discord.allow = next.allow;
    cfg.discord.deny = next.deny;
    cfg.discord.ownerIds = next.ownerIds;
    cfg.discord.media = next.media;
    cfg.discord.tts = next.tts;
    cfg.discord.stt = next.stt;
    cfg.discord.context = next.context;
    cfg.discord.batch = next.batch;
    cfg.discord.security = next.security;
    cfg.discord.emoji = next.emoji;
    cfg.discord.memes = next.memes;
    cfg.discord.reactions = next.reactions;
    cfg.discord.memory = next.memory;
    // 歸檔客戶端在啟動時建立；這裡改的是檔案與記憶體設定，開關要重啟才生效。
    cfg.discord.historyArchive = next.historyArchive;
    cfg.discord.notes = next.notes;
    cfg.discord.knowledge = next.knowledge;
    cfg.discord.followup = next.followup;
    // 餅的設定改了：清掉組合與列表快取，下一輪重算；新頻道／新來源靠水位擋住舊餅。
    const ceobeChanged = JSON.stringify(cfg.discord.ceobe) !== JSON.stringify(next.ceobe);
    if (next.ceobe.enabled && !ceobeState.isEnabled()) ceobeState.resetSince();
    cfg.discord.ceobe = next.ceobe;
    ceobeState.setEnabled(next.ceobe.enabled);
    if (ceobeChanged) {
      ceobeState.pruneChannels(next.ceobe.channels);
      // 新 pair 在存檔當下就建水位，不要等到第一次輪詢成功才開始算。
      if (next.ceobe.enabled) {
        for (const [channelId, sourceIds] of Object.entries(next.ceobe.channels)) {
          for (const sourceId of sourceIds) ceobeState.ensurePair(channelId, sourceId);
        }
      }
      resetCeobeCache();
    }
    cfg.discord.slang = next.slang;
    cfg.discord.videoLinks = next.videoLinks;
    cfg.discord.typing = next.typing;
    cfg.discord.sendDelayMs = next.sendDelayMs;
    cfg.discord.maxMessageChars = next.maxMessageChars;
    cfg.discord.ackMessage = next.ackMessage;
    cfg.discord.autoCompactTokens = next.autoCompactTokens;
    cfg.discord.ttftTimeoutMs = next.ttftTimeoutMs;
    cfg.discord.sandbox = next.sandbox;
    cfg.discord.requireMentionInGuild = next.requireMentionInGuild;
    cfg.discord.requireMentionInChannel = next.requireMentionInChannel;
    cfg.discord.chattyChannels = next.chattyChannels;
    cfg.discord.openPoliticsChannels = next.openPoliticsChannels;
    cfg.discord.trade = next.trade;
    ownerIds.clear();
    for (const id of next.ownerIds) ownerIds.add(id);

    applyTradeConfig(next);

    log(`更新設定：allow ${next.allow.guilds.length}/${next.allow.channels.length}/${next.allow.users.length}，ownerIds ${next.ownerIds.length}，${requireMentionInGuild() ? '頻道要 @bot' : '自由參與'}，頻道覆寫 ${Object.keys(next.requireMentionInChannel).length}，chatty ${next.chattyChannels.length}，政治開放 ${next.openPoliticsChannels.length}，sandbox ${next.sandbox.enabled ? `開（${next.sandbox.channels.length} 個頻道）` : '關'}，餅 ${next.ceobe.enabled ? `開（${Object.keys(next.ceobe.channels).length} 個頻道）` : '關'}`);
    warnChattyChannels();
    return editableConfig();
  }

  const sessionsInfo = () => Object.entries(sessions)
    .map(([key, sessionId]) => {
      const id = key.slice(key.indexOf(':') + 1);
      const channel = key.startsWith('ch:') ? client.channels.cache.get(id) : null;
      const user = key.startsWith('dm:') ? client.users.cache.get(id) : null;
      return {
        key,
        sessionId,
        kind: key.startsWith('dm:') ? 'dm' : 'channel',
        label: sessionLabelFor(key, {
          channelName: channel?.name,
          guildName: channel?.guild?.name,
          userName: user?.displayName || user?.username,
        }),
        lastActive: lastActive.get(key) ?? null,
        pending: pending.get(key)?.kind ?? null,
        quietUntil: quietUntil(key),
        preset: sessionPresets[sessionId] ?? null,
      };
    })
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));

  let consoleHandle = null;
  // 控制台股盤顯示名稱：uid -> { name, at }，避免每 5 秒都打 REST。
  const tradeNameCache = new Map();
  const TRADE_NAME_TTL_MS = 10 * 60_000;
  if (cfg.discord.console.enabled) {
    const { token: consoleToken, created } = resolveConsoleToken({
      configured: cfg.discord.console.token || process.env.DISCORD_CONSOLE_TOKEN || '',
      file: path.join(STATE_DIR, 'discord-console-token'),
    });
    consoleTokenValue = consoleToken;
    if (created) log('已產生控制台 token：state/discord-console-token');
    const host = cfg.discord.console.host;
    const port = cfg.discord.console.port;
    try {
      consoleHandle = await startConsole({
        host,
        port,
        token: consoleToken,
        htmlPath: path.join(ROOT, 'public', 'discord-console.html'),
        log,
        handlers: {
          status: () => ({
            bot: {
              tag: client.user.tag,
              id: client.user.id,
              guilds: [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, channels: g.channels.cache.size })),
            },
            dsh: {
              baseUrl: cfg.dsh.baseUrl,
              provider: cfg.dsh.provider,
              model: cfg.dsh.model,
              effort: cfg.dsh.reasoningEffort,
              preset: cfg.discord.agentPreset,
              auth: api.hasAuth(),
              lastFrameAt: turns.lastFrameAt() || null,
            },
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            sessions: Object.keys(sessions).length,
            pending: pending.size,
            queue: [...offlineQueue.values()].reduce((sum, jobs) => sum + jobs.length, 0),
            allow: {
              guilds: cfg.discord.allow.guilds.length,
              channels: cfg.discord.allow.channels.length,
              users: cfg.discord.allow.users.length,
            },
            ownerIds: [...ownerIds],
            media: cfg.discord.media,
            requireMention: requireMentionInGuild(),
            // 沒開意圖時覆寫不生效，算 0，免得總覽看起來有頻道在自由參與。
            mentionOverrides: cfg.discord.messageContentIntent ? Object.keys(cfg.discord.requireMentionInChannel).length : 0,
            emoji: {
              guilds: getEmojiCatalogs().size,
              entries: [...getEmojiCatalogs().values()].reduce((sum, catalog) => sum + (catalog.entries?.length ?? 0), 0),
              items: [...getEmojiCatalogs().entries()].map(([guildId, catalog]) => ({
                guildId,
                guildName: catalog.guildName ?? '',
                entries: catalog.entries?.length ?? 0,
                builtAt: catalog.builtAt ?? null,
              })),
              job: {
                running: getEmojiBuild().running,
                startedAt: getEmojiBuild().startedAt || null,
                finishedAt: getEmojiBuild().finishedAt || null,
                exitCode: getEmojiBuild().exitCode,
                error: getEmojiBuild().error,
                reason: getEmojiBuild().reason,
                log: emojiBuildLogTail(20),
              },
            },
            slang: {
              enabled: cfg.discord.slang.enabled,
              ...slangStats(slangStore),
              ...slangQueueInfo(),
              today: getSlangDayKey() === localDayKey() ? getSlangDayCount() : 0,
              maxPerDay: cfg.discord.slang.maxPerDay,
            },
            knowledge: { enabled: cfg.discord.knowledge.enabled, ...knowledgeStats(knowledgeStore) },
            triggers: triggerStats(triggerStore, { now: Date.now(), top: 3 }),
            ignored: ignoreList(ignoreStore),
            console: { host, port },
          }),
          sessions: sessionsInfo,
          // 沒有會話也要走 retireSession：還在等的第一批要一起丟掉。
          resetSession: (key) => resetConversation(key),
          reloadSystemPrompt: (key) => reloadSystemPrompt(key),
          config: editableConfig,
          updateConfig,
          providers: providerSettings,
          updateProviders,
          updateProviderKey,
          invite: inviteInfo,
          usage: usageInfo,
          quota: () => quotaInfo({ withFallback: true }),
          codexQuota: codexQuotaInfo,
          memory: () => ({
            enabled: cfg.discord.memory.enabled,
            users: memoryOverview(memoryStore),
          }),
          archive: archiveStatus,
          archiveChannels: async () => {
            if (!archive || !cfg.discord.historyArchive.enabled) return { enabled: false, channels: [] };
            const rows = await archive.channels();
            return {
              enabled: true,
              channels: rows.map((row) => ({
                ...row,
                name: client.channels.cache.get(row.channelId)?.name ?? '',
              })),
            };
          },
          archiveList: async (body) => {
            if (!archive || !cfg.discord.historyArchive.enabled) throw new Error('歷史歸檔沒開');
            return archive.list({
              channelId: textArg(body?.channelId, 32),
              before: Number(body?.before) || null,
              skip: Array.isArray(body?.skip) ? body.skip.slice(0, 500) : [],
            });
          },
          archiveSearch: async (body) => {
            if (!archive || !cfg.discord.historyArchive.enabled) throw new Error('歷史歸檔沒開');
            const channelId = textArg(body?.channelId, 32);
            const query = textArg(body?.query, 200);
            // 控制台可以不選頻道跨頻道搜尋；模型用的 search 仍然綁頻道（anyChannel 預設 false）。
            if (!query) throw new Error('搜尋字是空的');
            return archive.search({ query, channelId, limit: 20, minScore: null, anyChannel: !channelId });
          },
          archiveDelete: async (body) => {
            if (!archive || !cfg.discord.historyArchive.enabled) throw new Error('歷史歸檔沒開');
            const id = typeof body?.id === 'string' ? body.id.trim() : '';
            if (!/^\d{17,20}$/.test(id)) throw new Error('訊息 id 格式不對');
            // 佇列或正在寫入的批次還會把這則寫回去：先拿掉，再等批次結束，最後才刪。
            for (let i = archiveQueue.length - 1; i >= 0; i -= 1) {
              if (archiveQueue[i].id === id) archiveQueue.splice(i, 1);
            }
            await getArchiveFlushing();
            await archive.deletePoints([id]);
            return { deleted: id };
          },
          followups: () => ({
            enabled: cfg.discord.followup.enabled,
            items: followups.all().map((entry) => {
              const channelId = entry.key.startsWith('ch:') ? entry.key.slice(3) : '';
              const channel = channelId ? client.channels.cache.get(channelId) : null;
              return {
                id: entry.id,
                key: entry.key,
                where: channelId ? (channel?.name ? `#${channel.name}` : channelId) : '私聊',
                note: entry.note,
                minutes: entry.minutes,
                at: new Date(entry.at).toISOString(),
                scheduledAt: new Date(entry.at - entry.minutes * 60_000).toISOString(),
                remainingMinutes: Math.max(0, Math.round((entry.at - Date.now()) / 60_000)),
              };
            }),
          }),
          // 控制台的逃生門：排錯或不想回訪了，管理員可以直接取消。
          deleteFollowup: (id) => {
            const removed = followups.remove(String(id ?? ''));
            if (removed) log(`控制台取消回訪 ${id}`);
            return removed;
          },
          ceobe: ceobeInfo,
          notes: () => ({
            enabled: cfg.discord.notes.enabled,
            notes: notesOverview(notesStore).map((note) => ({
              ...note,
              channelName: client.channels.cache.get(note.channelId)?.name ?? note.channelId,
            })),
          }),
          deleteNote: (id) => {
            const removed = deleteNoteById(notesStore, id);
            if (removed) markNotesDirty();
            return removed;
          },
          knowledge: () => ({
            enabled: cfg.discord.knowledge.enabled,
            stats: knowledgeStats(knowledgeStore),
            entries: knowledgeOverview(knowledgeStore).map((entry) => {
              const guild = client.guilds.cache.get(entry.guildId);
              const channel = client.channels.cache.get(entry.channelId);
              return {
                ...entry,
                guildName: guild?.name ?? entry.guildId,
                channelName: channel?.name ?? entry.channelId,
              };
            }),
          }),
          // 管理員自己建的：貼訊息連結就抓原文，建完直接生效，不用再按確認。
          knowledgeCreate: async (body) => {
            const link = parseMessageLink(body?.link);
            let title = flat(body?.title, TITLE_MAX_CHARS);
            let text = String(body?.body ?? '').trim();
            let guildId = '';
            let channelId = '';
            let source = null;
            if (link) {
              const channel = await client.channels.fetch(link.channelId).catch(() => null);
              if (!channel?.guildId || channel.guildId !== link.guildId) {
                throw new Error('找不到那個頻道：bot 要看得到，而且要是同一個伺服器');
              }
              if (typeof channel.messages?.fetch !== 'function') {
                throw new Error('這個頻道類型不支援讀單一訊息（論壇／部分討論串），改貼一般頻道的訊息連結');
              }
              const message = await channel.messages.fetch(link.messageId).catch(() => null);
              if (!message) throw new Error('找不到那則訊息（可能刪掉了）');
              guildId = link.guildId;
              channelId = link.channelId;
              source = { channelId, messageId: message.id, at: message.createdTimestamp };
              if (!text) text = resolveMentions(String(message.content ?? '').trim(), message);
              if (!title) title = flat(text, Math.min(30, TITLE_MAX_CHARS));
            } else {
              const channelIdFromBody = String(body?.channelId ?? '').replace(/[^\d]/g, '').slice(0, 25);
              const channel = channelIdFromBody ? client.channels.cache.get(channelIdFromBody) : null;
              if (!channel?.guildId) throw new Error('要貼訊息連結，或指定一個 bot 看得到的頻道');
              guildId = channel.guildId;
              channelId = channel.id;
            }
            if (!title) throw new Error('title 是空的');
            if (!text) throw new Error('沒有內容：貼的訊息是空的，或先在下面的欄位填內容');
            if (text.length > KNOWLEDGE_BODY_MAX_CHARS) {
              throw new Error(`內容超過 ${KNOWLEDGE_BODY_MAX_CHARS} 字，先在下面的欄位刪成重點再送出`);
            }
            if (knowledgeStats(knowledgeStore).approved >= MAX_APPROVED) {
              throw new Error(`已確認的知識最多 ${MAX_APPROVED} 條，先刪掉一條再加`);
            }
            const result = saveKnowledgeCandidate(knowledgeStore, {
              guildId,
              channelId,
              title,
              body: text,
              keywords: body?.keywords,
              tools: body?.tools,
              always: body?.always === true,
              scope: body?.scope,
              by: 'admin',
              byName: '管理員',
              sources: source ? [source] : [],
            });
            if (result.error) throw new Error(result.error);
            confirmKnowledge(knowledgeStore, result.entry.id);
            markKnowledgeDirty();
            log(`控制台新增群知識「${flat(result.entry.title, 40)}」（${result.entry.scope}）`);
            return { ok: true, entry: result.entry };
          },
          knowledgeConfirm: (id, patch = {}) => {
            const entry = knowledgeStore.entries.find((item) => item.id === id);
            if (!entry) return null;
            // 候選可能在這段時間被別人用同一個標題覆寫；管理員審的是舊內容，不能直接確認。
            if (!patch.updatedAt || entry.updatedAt !== patch.updatedAt) {
              throw new Error('這條知識在確認前被改過，請重新整理再確認');
            }
            if (entry.status !== 'approved' && knowledgeStats(knowledgeStore).approved >= MAX_APPROVED) {
              throw new Error(`已確認的知識最多 ${MAX_APPROVED} 條，先刪掉一條再確認`);
            }
            const updated = confirmKnowledge(knowledgeStore, id, patch);
            if (updated) markKnowledgeDirty();
            return updated;
          },
          knowledgeReject: (id) => {
            const entry = rejectKnowledge(knowledgeStore, id);
            if (entry) markKnowledgeDirty();
            return entry;
          },
          knowledgeUpdate: (id, patch = {}) => {
            const entry = updateKnowledge(knowledgeStore, id, patch);
            if (entry) markKnowledgeDirty();
            return entry;
          },
          knowledgeDelete: (id) => {
            const removed = deleteKnowledge(knowledgeStore, id);
            if (removed) markKnowledgeDirty();
            return removed;
          },
          memes: () => ({
            enabled: cfg.discord.memes.enabled,
            memes: memeStore.memes.map((meme) => ({
              id: meme.id,
              name: meme.name,
              when: meme.when,
              tags: meme.tags,
              kind: meme.kind,
              width: meme.width,
              height: meme.height,
              bytes: meme.bytes,
              uses: meme.uses,
              createdAt: meme.createdAt,
              createdBy: meme.authorIsBot ? 'bot' : 'user',
              guildName: client.guilds.cache.get(meme.guildId)?.name ?? meme.guildId,
              channelName: client.channels.cache.get(meme.channelId)?.name ?? meme.channelId,
            })),
          }),
          memeImage: (id) => {
            const meme = memeStore.memes.find((item) => item.id === id);
            if (!meme) return null;
            try {
              return {
                buffer: fs.readFileSync(path.join(MEMES_FILES_DIR, memeFileName(meme))),
                mime: meme.kind === 'gif' ? 'image/gif' : 'image/png',
              };
            } catch {
              return null;
            }
          },
          deleteMeme: (id) => {
            const removed = deleteMemeById(memeStore, id);
            if (!removed) return null;
            persistMemesNow();
            try { fs.rmSync(path.join(MEMES_FILES_DIR, memeFileName(removed)), { force: true }); } catch { /* 檔案本來就不在 */ }
            log(`控制台刪梗圖 ${removed.name}`);
            return removed;
          },
          devFeedback: () => ({ items: devFeedbackOverview(devFeedbackStore) }),
          deleteDevFeedback: (id) => {
            const removed = deleteDevFeedbackById(devFeedbackStore, id);
            if (removed) markDevFeedbackDirty();
            return removed;
          },
          // 控制台的逃生門：模型設錯或設太久時，管理員可以直接解除。
          ignoreRemove: (userId) => {
            const id = String(userId ?? '');
            const previous = ignoreStore.users?.[id] ?? null;
            if (!previous || !unignore(ignoreStore, id)) return false;
            if (!saveIgnores()) {
              ignoreStore.users[id] = previous;
              throw new Error('不理名單存檔失敗');
            }
            log(`控制台解除不理 user=${id}`);
            return true;
          },
          triggers: () => {
            const users = triggerUserList(triggerStore).map((entry) => {
              const [kind, id] = String(entry.lastKey ?? '').split(':');
              const channel = kind === 'ch' ? client.channels.cache.get(id) : null;
              return {
                ...entry,
                channelName: kind === 'dm' ? '私聊' : (channel?.name ? `#${channel.name}` : (id || '—')),
              };
            });
            return { ...triggerStats(triggerStore, { top: 0 }), users };
          },
          usageTurns: (key, limit) => usage.ledger.conversation(key, { turnLimit: limit }),
          usageReset: () => {
            usage.ledger.reset();
            log('控制台清空 token 帳本');
            return true;
          },
          rebuildEmojis: ({ guildId, force }) => startEmojiBuild({ guildId, force, reason: 'console' }),
          slang: () => {
            const rank = (entry) => (entry.status === SLANG_STATUS.CANDIDATE ? 0 : (entry.status === SLANG_STATUS.CONFIRMED ? 1 : 2));
            return {
              entries: [...slangStore.entries].sort((a, b) => rank(a) - rank(b)
                || (b.seen || 0) - (a.seen || 0)
                || String(b.updatedAt).localeCompare(String(a.updatedAt)))
                .map((entry) => (entry.kind === 'style'
                  ? (() => {
                      const channel = client.channels.cache.get(entry.channelId);
                      // 以頻道實際所在的伺服器為準；頻道不在快取（被刪、bot 離開）才退回學到時記的 guildId。
                      return {
                        ...entry,
                        channelName: channel?.name ?? entry.channelId,
                        guildName: channel?.guild?.name ?? client.guilds.cache.get(entry.guildId)?.name ?? '',
                      };
                    })()
                  : entry)),
              stats: slangStats(slangStore),
              learning: {
                enabled: cfg.discord.slang.enabled,
                ...slangQueueInfo(),
                today: getSlangDayKey() === localDayKey() ? getSlangDayCount() : 0,
                maxPerDay: cfg.discord.slang.maxPerDay,
              },
            };
          },
          slangConfirm: (id) => {
            const entry = confirmSlang(slangStore, id);
            if (entry) saveSlangNow();
            return entry;
          },
          slangConfirmMany: (ids) => {
            const result = confirmSlangMany(slangStore, ids);
            if (result.confirmed) {
              saveSlangNow();
              log(`控制台：批次確認黑話 ${result.confirmed} 條，跳過 ${result.skipped} 條`);
            }
            return result;
          },
          slangRejectMany: (ids) => {
            const result = rejectSlangMany(slangStore, ids);
            if (result.rejected) {
              saveSlangNow();
              log(`控制台：批次拒絕黑話 ${result.rejected} 條，跳過 ${result.skipped} 條`);
            }
            return result;
          },
          slangReject: (id) => {
            const entry = rejectSlang(slangStore, id);
            if (entry) saveSlangNow();
            return entry;
          },
          slangUpdate: (id, patch) => {
            const entry = updateSlang(slangStore, id, patch);
            if (entry) saveSlangNow();
            return entry;
          },
          slangDelete: (id) => {
            const removed = deleteSlang(slangStore, id);
            if (removed) saveSlangNow();
            return removed;
          },
          arknightsAliases: () => {
            const status = readAliasStoreStatus();
            if (status.state === 'missing') {
              return { entries: [], stats: { total: 0, active: 0, rejected: 0 }, builtAt: null, source: '', missing: true };
            }
            if (status.state === 'corrupt') {
              return {
                entries: [],
                stats: { total: 0, active: 0, rejected: 0 },
                builtAt: null,
                source: '',
                corrupt: true,
                error: status.error,
              };
            }
            return { ...status.store, stats: aliasStats(status.store) };
          },
          arknightsAliasesSetStatus: (ids, action) => {
            const store = readAliasStore();
            if (!store) return { changed: 0 };
            const status = action === 'reject' ? ALIAS_STATUS.REJECTED : ALIAS_STATUS.ACTIVE;
            const changed = setAliasStatus(store, ids, status);
            if (changed) {
              writeAliasStore(store);
              log(`控制台：別名改為 ${status} ${changed} 條`);
            }
            return { changed };
          },
          arknightsAliasesAdd: async (alias, operator) => {
            const status = readAliasStoreStatus();
            if (status.state === 'missing') return { error: 'MCP 還沒抓到 PRTS 別名，稍後再試', status: 409 };
            if (status.state === 'corrupt') return { error: `別名檔損毀：${status.error}`, status: 409 };
            const text = String(alias ?? '').trim();
            const target = String(operator ?? '').trim();
            if (!text || !target) return { error: '缺少別名或幹員', status: 400 };
            let table;
            try {
              table = await loadTable();
            } catch (error) {
              return { error: `幹員表讀取失敗：${error?.message ?? error}`, status: 503 };
            }
            const matched = matchOperator(target, table);
            if (!matched.operator) return { error: matched.error, status: 400 };
            const result = addManualAlias(status.store, {
              alias: text,
              charId: matched.operator.charId,
              name: matched.operator.name,
            });
            if (result.error) return { ...result, status: 400 };
            writeAliasStore(status.store);
            log(`控制台：新增別名 ${result.entry.alias} → ${result.entry.name}`);
            return result;
          },
          arknightsAliasesDelete: (ids) => {
            const store = readAliasStore();
            if (!store) return { removed: 0 };
            const removed = deleteAliases(store, ids);
            if (removed) {
              writeAliasStore(store);
              log(`控制台：刪除別名 ${removed} 條`);
            }
            return { removed };
          },
          logs: (limit) => LOG_RING.slice(-limit),
          trade: async (name) => {
            const tradeSvc = getTradeService();
            if (!tradeSvc) return { enabled: false, reason: '模擬股票沒有開啟或啟動失敗' };
            const data = await tradeSvc.overview();
            // 設定檔只存 uid；控制台要看得懂是誰，這裡補顯示名稱。
            // 先查快取，再查 guild member／user 快取，都沒有才打一次 REST；同一個 uid 快取 10 分鐘。
            const nameOf = async (userId, guildId = '') => {
              const key = `${guildId}:${userId}`;
              const cached = tradeNameCache.get(key);
              if (cached && Date.now() - cached.at < (cached.name ? TRADE_NAME_TTL_MS : 60_000)) {
                return cached.name;
              }
              const guild = guildId ? client.guilds.cache.get(guildId) : null;
              const member = guild?.members.cache.get(userId)
                ?? [...client.guilds.cache.values()].map((item) => item.members.cache.get(userId)).find(Boolean);
              let display = member?.displayName
                || client.users.cache.get(userId)?.displayName
                || client.users.cache.get(userId)?.username
                || '';
              if (!display) {
                display = (await client.users.fetch(userId).catch(() => null))?.displayName || '';
              }
              tradeNameCache.set(key, { name: display, at: Date.now() });
              return display;
            };
            const withNames = async (list, key, guildKey = '') => {
              const sources = new Map(); // id -> 下單的伺服器（同名 id 只查一次）
              for (const item of list) {
                const id = String(item[key] ?? '');
                if (!id.startsWith('user:') || sources.has(id)) continue;
                sources.set(id, guildKey ? String(item[guildKey] ?? '') : '');
              }
              const names = new Map();
              await Promise.all([...sources].map(async ([id, guildId]) => {
                names.set(id, await nameOf(id.slice('user:'.length), guildId));
              }));
              return list.map((item) => {
                const display = names.get(String(item[key] ?? ''));
                return display ? { ...item, accountName: display } : item;
              });
            };
            const accounts = await withNames(data.accounts ?? [], 'accountId');
            const orders = await withNames(data.orders ?? [], 'account_id', 'guild_id');
            if (name === 'accounts') return { enabled: true, accounts, market: data.market };
            if (name === 'orders') return { enabled: true, orders };
            if (name === 'quotes') return { enabled: true, quotes: data.quotes };
            if (name === 'bot') return { enabled: true, botRuns: data.botRuns, botEnabled: data.botEnabled, botAccount: data.botAccount };
            return { ...data, accounts, orders };
          },
        },
      });
      const shown = host.includes(':') ? `[${host}]` : host;
      log(`控制台：http://${shown}:${port}/?token=${consoleToken}`);
      if (!/^(127\.|localhost$|\[?::1\]?$)/.test(host)) {
        log(`⚠️ 控制台綁在 ${host}（非 loopback）：能連到這個埠又有 token 的人可以重置會話、改白名單`);
        if (consoleToken.length < 16) log('⚠️ 控制台 token 少於 16 字元，綁外網時請換長一點的');
      }
    } catch (error) {
      log(`控制台未啟動（${host}:${port}）：${error?.message ?? error}`);
    }
  }
  return {
    syncHedgeSettings,
    updateConfig,
    getConsoleTokenValue: () => consoleTokenValue,
    stopConsole: () => consoleHandle?.close(),
  };
}
