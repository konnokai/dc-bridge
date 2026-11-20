#!/usr/bin/env node
// Discord ↔ DSH 橋接（聊天模式）。
//
// 這支程式只做一件事：把 Discord 訊息送進 DSH 會話，再把回合結果／提問／審批送回同一個頻道。
// 協定層直接用 src/dsh-client.js（Cookie 鑄造、斜線 RPC、remote.mux 事件流），
// 准入與分條等純邏輯在 src/core/discord-core.mjs。
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { NodeApiClient, createTurnCollector, discoverDshLaunchToken, unwrap } from './dsh-client.js';
import {
  COMPACT_NOTICE,
  formatProgress,
  isTransientDshError,
  loadSessions,
  loadSessionPresets,
  saveSessionPresets,
  requireMentionForChannel,
  normalizeDiscordConfig,
  isSkippedMessage,
  isChattyChannel,
  normalizeHedgeConfig,
  normalizeEffort
} from './core/discord-core.mjs';
import { authorName, flat, messageParts } from './core/discord-context.mjs';
import { createRefusalTracker, isIgnoring, loadIgnoreFile, saveIgnoreFile } from './core/discord-ignore.mjs';
import { createActivityTracker } from './core/discord-activity.mjs';
import { createQuietState } from './core/discord-quiet.mjs';
import { createFollowupStore, loadFollowupFile, saveFollowupFile } from './core/discord-followup.mjs';
import {
  createCeobeClient,
  createCeobeState,
  loadCeobeState,
  saveCeobeState
} from './core/discord-ceobe.mjs';
import { createReactionInbox } from './core/discord-feedback.mjs';
import {
  loadReloadFile,
  saveReloadFile
} from './core/discord-reload.mjs';
import { findSensitive } from './core/discord-security.mjs';
import { catalogFile, loadCatalogs, loadEmojiUsage, pruneCatalogs, saveEmojiUsage } from './core/discord-emoji.mjs';
import { createArchive, worthArchiving } from './core/discord-history-archive.mjs';
import {
  cleanupStaleContainers
} from './core/discord-sandbox.mjs';
import {
  SLANG_STATUS,
  confirmSlang,
  loadSlangFile,
  rejectSlang,
  saveSlangFile
} from './core/discord-slang.mjs';
import { askJev, buildSlangTriage, planTriage } from './core/jev.mjs';
import {
  memeFileName
} from './core/discord-memes.mjs';
import { GIF_RATINGS } from './core/discord-gif.mjs';
import { startAgentApi } from './core/discord-agent.mjs';
import { createRuntimeState } from './core/discord-bridge-runtime-state.mjs';
import { createStores } from './core/discord-bridge-stores.mjs';
import { createTurns } from './core/discord-bridge-turns.mjs';
import { createBatcher, createTurnGate, resolveMentions } from './core/discord-batch.mjs';
import { createUrgentTyping } from './core/discord-typing.mjs';
import { turnsFromRecords } from './core/discord-ask.mjs';
import { createUsageLayer } from './core/discord-bridge-usage.mjs';
import { createDshSessions } from './core/discord-bridge-dsh-sessions.mjs';
import { createOutputLayer } from './core/discord-bridge-output.mjs';
import { createAgentTools } from './core/discord-bridge-agent-tools.mjs';
import { createBackgroundJobs } from './core/discord-bridge-background.mjs';
import { createTradeRuntime } from './core/discord-bridge-trade.mjs';
import { createInbound } from './core/discord-bridge-inbound.mjs';
import { createConsoleLayer } from './core/discord-bridge-console.mjs';
import { loadTriggerFile, saveTriggerFile } from './core/discord-trigger-stats.mjs';
import {
  IMAGE_JOB_STALE_TEXT,
  IMAGE_JOB_TTL_MS,
  loadImageJobs,
  saveImageJobs,
  sweepStaleImageJobs
} from './core/discord-image-jobs.mjs';
import {
  pruneVoiceJobs
} from './core/discord-voice-jobs.mjs';
import { readDshCredential } from './web-search.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'discord-sessions.json');
const SESSION_PRESETS_FILE = path.join(STATE_DIR, 'discord-session-presets.json');
const MEMORY_FILE = path.join(STATE_DIR, 'discord-memory.json');
const TRIGGER_FILE = path.join(STATE_DIR, 'discord-triggers.json');
const IGNORE_FILE = path.join(STATE_DIR, 'discord-ignore.json');
const CUSTOM_STATUS_FILE = path.join(STATE_DIR, 'discord-custom-status.json');
const SLANG_FILE = path.join(STATE_DIR, 'discord-slang.json');
const SLANG_TRIAGE_FILE = path.join(STATE_DIR, 'discord-slang-triage.jsonl');
const NOTES_FILE = path.join(STATE_DIR, 'discord-notes.json');
const KNOWLEDGE_FILE = path.join(STATE_DIR, 'discord-knowledge.json');
const FOLLOWUPS_FILE = path.join(STATE_DIR, 'discord-followups.json');
const CEOBE_FILE = path.join(STATE_DIR, 'discord-ceobe.json');
const DEV_FEEDBACK_FILE = path.join(STATE_DIR, 'discord-dev-feedback.json');
const RELOAD_FILE = path.join(STATE_DIR, 'discord-reload-summaries.json');
const CODEX_RESET_FILE = path.join(STATE_DIR, 'discord-codex-reset.json');
const EMOJI_USAGE_FILE = path.join(STATE_DIR, 'discord-emoji-usage.json');
const USAGE_FILE = path.join(STATE_DIR, 'discord-usage.jsonl');
const TURNS_FILE = path.join(STATE_DIR, 'discord-turns.jsonl');
const AGENT_ENDPOINT_FILE = path.join(STATE_DIR, 'discord-agent.json');
// generate_image 的輸出目錄；dc-draw-image 會把 outputDir 固定到這裡，send_image 也只認這裡。
const AGENT_IMAGE_DIR = path.join(STATE_DIR, 'discord-images');
const IMAGE_JOBS_FILE = path.join(STATE_DIR, 'discord-image-jobs.json');
// 梗圖庫：不放進 discord-images，那個目錄只留最新 100 張、會被 dc-draw-image 清掉。
const MEMES_DIR = path.join(STATE_DIR, 'discord-memes');
const MEMES_INDEX_FILE = path.join(MEMES_DIR, 'index.json');
const MEMES_FILES_DIR = path.join(MEMES_DIR, 'files');
const LOCK_FILE = path.join(STATE_DIR, 'discord-bridge.lock');
const DSH_TIMEOUT_MS = 60_000;
const DSH_COMMAND_TIMEOUT_MS = 180_000; // 手動／自動壓縮可能吃掉整個大 context，60 秒會把 DSH 那邊也取消
const TYPING_REFRESH_MS = 8_000; // Discord 的「正在輸入」一次只維持 10 秒
const ASK_TIMEOUT_MS = 120_000; // /ask 等模型回答的上限：一般回合 12~35 秒，兩分鐘足夠
const PRIVATE_TURN_READY_TIMEOUT_MS = 60_000; // 指令排到最前面時，等 DSH 自己的回合／事件流同步的上限
const PRIVATE_TURN_READY_POLL_MS = 2_000;
const ASK_CANCEL_FAILED_GRACE_MS = 10 * 60_000; // 取消失敗：繼續擋到這一輪真的結束，最多十分鐘
const ASK_ABANDONED_TTL_MS = 30 * 60_000; // 連 hardClose 都等不到 turn/end：記錄下來再擋三十分鐘
// 後台提問的開頭：模型要知道這不是頻道對話、這一輪的工具真的被擋住，而且事後不要在頻道提起。
const PRIVATE_ASK_HEADER = '【後台提問｜只有管理員看得到，不會公開】直接輸出文字回答，不要呼叫任何工具；這一輪所有 Discord 工具都已封鎖，呼叫只會失敗。這段問答之後不要在公開對話提起。';
const PRIVATE_RELOAD_HEADER = '【後台整理｜不會公開】直接輸出文字，不要呼叫任何工具；這一輪所有 Discord 工具都已封鎖，呼叫只會失敗。這段整理之後不要在公開對話提起。';
const TYPING_MAX_MS = 10 * 60 * 1000; // 回合卡住時不要讓「正在輸入」亮一輩子
const TYPING_WINDOW_MS = 10_000; // 有人打字時把補句窗口往後延這麼久
const URGENT_FOLLOWUP_MS = 60_000; // 叫過 bot 之後這麼久內，他的補句都算同一次對話
const URGENT_FOLLOWUP_MAX_MS = 2 * 60_000; // 一直打字最多延到這麼久（從 @ 起算）
const TURN_RELEASE_MS = 5 * 60 * 1000; // 等不到 turn/end 時，最久把下一批壓這麼久
const HELD_MAX = 50; // 回合進行中壓住的訊息最多幾則（★ 那幾則不算在內，一定留著）
const SLANG_WINDOW_MAX = 80; // 每個頻道保留幾則語料（記憶體，重啟就沒了）
const MEMORY_WRITES_PER_TURN = 3; // 記憶會留存、又是群友文字推動的，一輪寫幾次要有上限
const NOTE_WRITES_PER_TURN = 2; // 頻道筆記也是群友文字推動的，一輪最多記 2 條
const KNOWLEDGE_WRITES_PER_TURN = 1; // 知識是長文、又要人審；一輪最多提一條，避免洗版
const MEME_SAVES_PER_TURN = 2; // 每次存都要下載＋跑 ffmpeg，一輪最多 2 次（失敗也算）
const SLANG_WRITES_PER_TURN = 3; // 模型自己收錄黑話／標籤也一樣，避免每一批都往詞庫塞
const SUMMARY_MIN_MESSAGES = 10; // 少於這個量不做每日摘要，省 token
const SUMMARY_MAX_MESSAGES = 100; // 每日摘要最多讀幾則（Discord 單次上限 100）
const SUMMARY_TRANSCRIPT_CHARS = 6000; // 每日摘要的聊天記錄上限
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分鐘檢查一次今天要不要做摘要

/**
 * 橋接指令。`default_member_permissions` 只是 Discord 端的預設顯示條件，
 * 伺服器管理員可以改；真正的邊界是執行時的權限檢查（見 handleSlashCommand）。
 * dmPermission: false —— invite/console/mention/ask/memory/blacklist 只在伺服器頻道有意義。
 * reset/reload-system-prompt/status/forget 開放私聊：沒有訊息指令之後，私聊只剩 slash 這一條路。
 * forget、memory、blacklist 不設管理員權限：任何人都能看、刪自己的記憶，或把自己加入／移出黑名單。
 */
const slashCommandData = [
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('重置這個頻道的會話上下文（伺服器管理者）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('reload-system-prompt')
    .setDescription('先用目前會話產生總結，再重置；下一則訊息套用新的 system prompt（伺服器管理者）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('顯示這個頻道的會話狀態（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('invite')
    .setDescription('產生機器人邀請連結（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('console')
    .setDescription('開啟 DSH 後台和 bridge 控制台（管理員，只有你看得到）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('mention')
    .setDescription('切換頻道要不要 @bot 才回（全部伺服器共用，管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('私下問這個頻道的模型一句話，回答只有你看得到（管理員）')
    .addStringOption((option) => option
      .setName('text')
      .setDescription('要問的內容；模型會用它目前的頻道上下文回答')
      .setRequired(true)
      .setMaxLength(1500))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('列出 bot 記下的關於你的事（所有伺服器共用，只有你看得到）')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('刪除 bot 記下的關於你的事（所有伺服器共用）')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('查自己的模擬股票帳戶（只有你看得到）')
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('切換自己的黑名單狀態（加入／移出，所有伺服器共用，只能改自己）')
    .setDMPermission(false),
].map((command) => command.toJSON());

const LOG_RING = [];
const LOG_RING_MAX = 500;

function log(...args) {
  const line = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} [discord] ${args.join(' ')}`;
  console.log(line);
  LOG_RING.push({ at: new Date().toISOString(), text: line });
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_RING_MAX);
}

/** 子程序已經自帶時間戳的行：不再加 [discord] 前綴，直接進 pm2 與控制台日誌環。 */
function logRaw(text) {
  const line = String(text);
  console.log(line);
  LOG_RING.push({ at: new Date().toISOString(), text: line });
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, LOG_RING.length - LOG_RING_MAX);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 逾時（${ms}ms）`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    throw new Error(`讀不到 ${CONFIG_FILE}（${error?.message ?? error}）。請先從 config.example.json 複製一份`);
  }
  let file;
  try {
    file = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    throw new Error(`${CONFIG_FILE} 不是合法 JSON：${error?.message ?? error}`);
  }
  const dsh = file?.dsh ?? {};
  const authToken = typeof dsh.authToken === 'string' ? dsh.authToken : '';
  const giphy = file?.giphy ?? {};
  const giphyRating = String(giphy.rating || '').trim().toLowerCase();
  const discord = normalizeDiscordConfig(file?.discord);
  let hedge;
  try {
    hedge = normalizeHedgeConfig(dsh.hedge, { ttftTimeoutMs: discord.ttftTimeoutMs });
  } catch (error) {
    // 壞掉的備援設定不該讓橋接起不來；只關掉開關，其他欄位原樣保留給控制台修。
    log(`dsh.hedge 設定無效，已停用：${error?.message ?? error}`);
    const rawHedge = dsh.hedge && typeof dsh.hedge === 'object' && !Array.isArray(dsh.hedge) ? dsh.hedge : {};
    hedge = normalizeHedgeConfig({ ...rawHedge, enabled: false });
  }
  return {
    dsh: {
      baseUrl: String(dsh.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
      provider: String(dsh.provider || 'commandcode'),
      model: String(dsh.model || 'deepseek/deepseek-v4.1-flash'),
      // 空字串是「不指定」；不能變成 max，否則主線不支援時每批都會失敗。
      reasoningEffort: normalizeEffort(dsh.reasoningEffort, 'max'),
      hedge,
      // 顯式填的 token 優先；留空時才去日誌裡找（新版 DSH 通常找不到，改用離線鑄造 Cookie）。
      authToken: authToken || discoverDshLaunchToken(),
      authTokenExplicit: Boolean(authToken),
      allowRemote: dsh.allowRemote === true,
    },
    discord,
    // GIPHY：search_gifs 用。key 留空時讀環境變數；rating 預設 pg（GIPHY 的 MPAA 分級）。
    giphy: {
      apiKey: String(giphy.apiKey || process.env.GIPHY_API_KEY || '').trim(),
      rating: GIF_RATINGS.includes(giphyRating) ? giphyRating : 'pg',
    },
    // 價目表覆蓋項（token 看板用）；沒填就沿用內建 DeepSeek 官方價。
    pricing: file?.pricing,
  };
}

/** 單一實例：兩個橋接搶同一個 bot token 會各自建會話、各自回覆。 */
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  } catch { /* 沒有鎖檔＝沒人跑 */ }
  if (Number.isInteger(pid) && pid > 0) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = error?.code === 'EPERM'; // 有這個 PID，只是沒權限送訊號
    }
    if (alive) {
      log(`已有橋接在執行（PID ${pid}），本次啟動中止`);
      process.exit(2);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  process.on('exit', () => {
    try {
      if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK_FILE, { force: true });
    } catch { /* 收尾失敗不影響結束 */ }
  });
}

async function main() {
  const startedAt = Date.now();
  const cfg = loadConfig();
  const token = cfg.discord.token || String(process.env.DISCORD_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('沒有 Discord bot token：請設定 config.json 的 discord.token，或環境變數 DISCORD_TOKEN');
  }
  if (cfg.discord.openPoliticsChannels.length > 0 && cfg.discord.agentPreset !== 'dc-chat') {
    log(`⚠️ openPoliticsChannels 使用內建的 dc-chat-open（以 dc-chat 為底）；這些頻道不會套用 agentPreset=${cfg.discord.agentPreset}`);
  }

  acquireLock();

  // client 要最先建立：下面好幾個地方在 login 之前就會讀 client.user 與 client.channels，
  // 靠的是「login 前沒有 await」這個前提。搬到最前面就不必再依賴它。
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
    // 有人在打字就用來延長合批。不是特權 intent，不用改 Developer Portal。
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessageTyping,
  ];
  if (cfg.discord.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
  // Partials.Channel：私聊頻道預設不在快取裡，少了它收不到未快取對象的私聊。
  // Message／Reaction：bot 重啟後對舊訊息按的 reaction 也要收得到（B3）。
  const client = new Client({ intents, partials: [Partials.Channel, Partials.Message, Partials.Reaction] });

  const { sessions } = loadSessions(SESSIONS_FILE);
  const reverse = new Map(Object.entries(sessions).map(([key, sessionId]) => [sessionId, key]));
  // Bot 交易的一次性會話只活在記憶體；不要寫進 sessions 檔，否則重啟後會 follow 已歸檔的 session。
  const persistedSessions = () => Object.fromEntries(Object.entries(sessions).filter(([key]) => !key.startsWith('bot:')));

  // sessionId → 建立會話時實際用的 preset。只用來顯示；壞檔不拖垮啟動。
  const sessionPresetsLoaded = loadSessionPresets(SESSION_PRESETS_FILE);
  const sessionPresets = sessionPresetsLoaded.presets;
  if (sessionPresetsLoaded.warning) log(`⚠️ 會話 preset 檔：${sessionPresetsLoaded.warning}`);
  const saveSessionPresetMap = () => {
    try {
      saveSessionPresets(SESSION_PRESETS_FILE, sessionPresets);
    } catch (error) {
      log(`會話 preset 檔寫入失敗：${error?.message ?? error}`);
    }
  };
  // 只留還對得上目前 session 對映的條目；DSH UI 直接歸檔的舊會話不要一直長大。
  let prunedSessionPresets = false;
  for (const sessionId of Object.keys(sessionPresets)) {
    if (!reverse.has(sessionId)) {
      delete sessionPresets[sessionId];
      prunedSessionPresets = true;
    }
  }
  if (prunedSessionPresets) saveSessionPresetMap();

  const botTokenSink = new Map(); // sessionId -> { tokens }：Bot 回合的 token 累計

  // 群友記憶、頻道筆記、群知識、梗圖、開發回饋共用同一套 dirty + 延遲存檔，
  // 實作在 core/discord-bridge-stores.mjs：五份一樣的 timer 程式碼沒有理由各寫一次。
  const fileStores = createStores({
    log,
    files: {
      memory: MEMORY_FILE,
      notes: NOTES_FILE,
      knowledge: KNOWLEDGE_FILE,
      memes: MEMES_INDEX_FILE,
      devFeedback: DEV_FEEDBACK_FILE,
    },
  });
  // 群友記憶：模型用 remember_user 記的；私聊與 NSFW 頻道不記（在工具入口擋）。
  const memoryStore = fileStores.memory.store;
  const markMemoryDirty = fileStores.memory.markDirty;
  const flushMemory = fileStores.memory.flush;

  // 歷史歸檔：把看得到的訊息 embed 後存進 Qdrant。沒開就不連任何外部服務。
  // 佇列在記憶體裡：重啟最多丟一個 flush 間隔的訊息（外部服務不該拖住關機）。
  const archive = cfg.discord.historyArchive.enabled
    ? createArchive({
      qdrantUrl: cfg.discord.historyArchive.baseUrl,
      embedUrl: cfg.discord.historyArchive.embedUrl,
      embedModel: cfg.discord.historyArchive.embedModel,
      apiKey: cfg.discord.historyArchive.apiKey,
      collection: cfg.discord.historyArchive.collection,
      retentionDays: cfg.discord.historyArchive.retentionDays,
    })
    : null;
  const archiveQueue = [];
  const ARCHIVE_QUEUE_MAX = 500;
  let archiveTimer = null;
  let archiveFlushing = null;
  let archivePrunedAt = 0;
  const archiveState = { lastFlushAt: 0, lastError: '', flushed: 0 };
  let archiveCount = { at: 0, count: 0, error: '' };

  /**
   * 值不值得 embed 看原文：mention 在原文裡還是 `<@id>`，`worthArchiving` 才剝得掉。
   * 存進去的文字是換成名字的版本（recall_history 要看得出在叫誰）。
   */
  function queueArchive(entry, raw = entry?.text) {
    if (!archive) return;
    const text = String(entry?.text ?? '').trim();
    if (!text || !worthArchiving(raw)) return;
    if (archiveQueue.length >= ARCHIVE_QUEUE_MAX) archiveQueue.shift();
    archiveQueue.push({ ...entry, text });
    if (archiveQueue.length >= cfg.discord.historyArchive.batch) void flushArchive();
    else if (!archiveTimer) {
      archiveTimer = setTimeout(() => {
        archiveTimer = null;
        void flushArchive();
      }, cfg.discord.historyArchive.flushMs);
      archiveTimer.unref?.();
    }
  }

  /** 一次送一批；失敗只記 log，不能讓外部服務拖垮橋接。 */
  function flushArchive() {
    if (!archive || archiveFlushing || archiveQueue.length === 0) return archiveFlushing ?? Promise.resolve();
    const batch = archiveQueue.splice(0, cfg.discord.historyArchive.batch);
    archiveFlushing = archive.append(batch)
      .then((written) => {
        archiveState.lastFlushAt = Date.now();
        archiveState.flushed += Number(written) || 0;
        archiveState.lastError = '';
      })
      .catch((error) => {
        archiveState.lastError = String(error?.message ?? error).slice(0, 200);
        log(`歷史歸檔失敗（丟掉 ${batch.length} 則）：${error?.message ?? error}`);
      })
      .finally(() => {
        archiveFlushing = null;
        if (archiveQueue.length) void flushArchive();
      });
    return archiveFlushing;
  }

  /** 控制台看得到歸檔活著沒：點數另算（30 秒快取），Qdrant 掛掉時其他欄位照樣回。 */
  async function archiveStatus() {
    if (!archive) return { enabled: false, collection: cfg.discord.historyArchive.collection };
    const status = {
      enabled: true,
      collection: archive.collection,
      retentionDays: cfg.discord.historyArchive.retentionDays,
      queued: archiveQueue.length,
      lastFlushAt: archiveState.lastFlushAt,
      flushed: archiveState.flushed,
      lastError: archiveState.lastError,
      count: null,
      countError: '',
    };
    if (Date.now() - archiveCount.at > 30_000) {
      try {
        archiveCount = { at: Date.now(), count: await archive.count(), error: '' };
      } catch (error) {
        archiveCount = { at: Date.now(), count: null, error: String(error?.message ?? error).slice(0, 200) };
      }
    }
    status.count = archiveCount.count;
    status.countError = archiveCount.error;
    return status;
  }

  async function pruneArchive(now = Date.now()) {
    if (!archive || now - archivePrunedAt < 24 * 60 * 60 * 1000) return;
    archivePrunedAt = now;
    try {
      await archive.prune(now);
      log('歷史歸檔：已清掉超過保留期的點');
    } catch (error) {
      log(`歷史歸檔清理失敗：${error?.message ?? error}`);
    }
  }

  /** 這則訊息要進歸檔的欄位；擋掉的（// 、封鎖）在呼叫端就 return 了。 */
  function archiveEntry(message, text) {
    return {
      id: message.id,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author?.id ?? '',
      author: authorName(message),
      mentionIds: message.mentions?.users ? [...message.mentions.users.keys()] : [],
      repliedUserId: message.mentions?.repliedUser?.id ?? '',
      text,
      at: message.createdTimestamp,
    };
  }

  // 頻道筆記：模型記下的群裡事件，加上每天自動產生的頻道摘要。
  const notesStore = fileStores.notes.store;
  const markNotesDirty = fileStores.notes.markDirty;
  const flushNotes = fileStores.notes.flush;

  // 群知識：群友提供的設定與規則；候選要管理員在控制台確認才會注入。
  const knowledgeStore = fileStores.knowledge.store;
  const markKnowledgeDirty = fileStores.knowledge.markDirty;
  const flushKnowledge = fileStores.knowledge.flush;

  // 梗圖庫：索引在 state/discord-memes/index.json，圖檔在同目錄的 files/。
  const memeStore = fileStores.memes.store;
  const markMemesDirty = fileStores.memes.markDirty;
  const flushMemes = fileStores.memes.flush;

  // 存圖與刪圖改了檔案，索引要跟著立刻寫，不等 2 秒的延遲存檔：崩潰時才不會留下沒有索引的孤兒檔。
  function persistMemesNow() {
    markMemesDirty();
    flushMemes();
  }

  // 開機時清掉索引裡沒有的圖檔（上次存圖途中崩潰留下的）。索引剛因為壞檔重建時不清：舊圖檔還有救回來的機會。
  if (!fileStores.memes.warning) {
    try {
      const known = new Set(memeStore.memes.map((meme) => memeFileName(meme)));
      for (const name of fs.readdirSync(MEMES_FILES_DIR)) {
        if (/^m_[a-z0-9]+\.(png|gif)$/.test(name) && !known.has(name)) fs.rmSync(path.join(MEMES_FILES_DIR, name), { force: true });
      }
    } catch { /* 目錄還不存在就是沒有孤兒檔 */ }
  }

  // 開發回饋：模型用 submit_feedback 送出的意見，只有控制台看得到。
  const devFeedbackStore = fileStores.devFeedback.store;
  const markDevFeedbackDirty = fileStores.devFeedback.markDirty;
  const flushDevFeedback = fileStores.devFeedback.flush;

  // system prompt 重載的交接摘要：舊會話產生、新會話的第一則 prompt 用一次，用量很小所以直接同步存檔。
  const reloadLoaded = loadReloadFile(RELOAD_FILE);
  const reloadStore = reloadLoaded.store;
  if (reloadLoaded.warning) log(`⚠️ 交接摘要：${reloadLoaded.warning}`);

  function saveReloadStore() {
    try {
      saveReloadFile(RELOAD_FILE, reloadStore);
      return true;
    } catch (error) {
      log(`交接摘要存檔失敗：${error?.message ?? error}`);
      return false;
    }
  }

  // 觸發對話統計：模型送出訊息時，記下這批訊息裡叫 bot 的人。
  const triggerLoaded = loadTriggerFile(TRIGGER_FILE);
  const triggerStore = triggerLoaded.store;
  if (triggerLoaded.warning) log(`⚠️ 觸發統計：${triggerLoaded.warning}`);
  let triggerDirty = false;
  let triggerSaveTimer = null;

  function markTriggerDirty() {
    triggerDirty = true;
    if (triggerSaveTimer) return;
    triggerSaveTimer = setTimeout(() => {
      triggerSaveTimer = null;
      flushTriggers();
    }, 2000);
    triggerSaveTimer.unref?.();
  }

  function flushTriggers() {
    if (!triggerDirty) return;
    try {
      const { dropped } = saveTriggerFile(TRIGGER_FILE, triggerStore);
      triggerDirty = false;
      if (dropped > 0) log(`觸發統計已滿，丟棄 ${dropped} 位最久沒觸發的人`);
    } catch (error) {
      log(`觸發統計存檔失敗：${error?.message ?? error}`);
    }
  }

  // 模型自己的不理名單：帶到期時間、重啟後仍然有效；跟管理員封鎖（deny.users）分開。
  const ignoreLoaded = loadIgnoreFile(IGNORE_FILE);
  const ignoreStore = ignoreLoaded.store;
  if (ignoreLoaded.warning) log(`⚠️ 不理名單：${ignoreLoaded.warning}`);

  function saveIgnores() {
    try {
      saveIgnoreFile(IGNORE_FILE, ignoreStore);
      return true;
    } catch (error) {
      log(`不理名單存檔失敗：${error?.message ?? error}`);
      return false;
    }
  }

  // 模型自己設定的自訂狀態：跨伺服器顯示，重啟與重新連線後都要重新套用。

  function applyCustomStatus(text) {
    client.user.setPresence({
      activities: text ? [{ type: ActivityType.Custom, name: 'Custom Status', state: text }] : [],
    });
  }

  // 同一個人在同一個頻道 10 分鐘內被拒絕第 2 次就改按 ❌，不再送同一句。
  const refusals = createRefusalTracker();

  // 執行期的 per-key 狀態集中在 core/discord-bridge-runtime-state.mjs。
  // 這裡拆成同名別名，下面幾百個呼叫點一行都不用改。
  const runtime = createRuntimeState();
  const {
    memoryShown, memoryWrites, notesShown, noteWrites, knowledgeShown, knowledgeWrites,
    memeSaves, devFeedbackWrites, devFeedbackEdits, slangWrites, slangShown, emojiShown,
    pendingUsers, turnUsers, sandboxRuns, voicePerTurn, voiceLastAt, voiceJobs,
    pendingDirect, turnDirect, turnTickets, pendingDirectMessages, turnDirectMessages,
    turnStartedAt, turnFollowupTaken, turnFollowupHeld, pendingLastMessages,
    turnLastMessage, turnMeta, turnSentTexts, turnTools, turnTtftMs,
    turnTriggerRecorded, noToolRemindedAt, ttftTimers, ttftTimeouts, ttftAbandonedTurns,
    offlineQueue, offlineHintAt, primedKeys, silentPending, botLastByUser, recentHumans,
    needsOpening, collectors, modelApplied, lastTurns, openTurns, snapshotReady,
  } = runtime;
  // 背景生圖：jobId -> { key, users, at }；完成後把觸發者掛到檔名上，等 send_image 再記畫圖次數。
  // 工作要存檔：橋接重啟時外掛還在本來那個 DSH 行程裡跑，不能跟著記憶體消失。
  let imageJobsLoaded;
  try {
    imageJobsLoaded = loadImageJobs(IMAGE_JOBS_FILE, {
      ttlMs: IMAGE_JOB_TTL_MS,
      keys: new Set(Object.keys(sessions)),
    });
  } catch (error) {
    // 讀檔失敗（權限、磁碟）不能讓整個橋接起不來；這次從空的工作表開始。
    log(`⚠️ 生圖工作：讀取失敗（${error?.message ?? error}），這次從空的工作表開始`);
    imageJobsLoaded = { jobs: new Map(), pendingDraws: new Map() };
  }
  const imageJobs = imageJobsLoaded.jobs;
  const pendingDraws = imageJobsLoaded.pendingDraws; // 檔名 -> { key, users, at }
  if (imageJobsLoaded.warning) log(`⚠️ 生圖工作：${imageJobsLoaded.warning}`);

  function persistImageJobs() {
    try {
      saveImageJobs(IMAGE_JOBS_FILE, { jobs: imageJobs, pendingDraws });
    } catch (error) {
      log(`生圖工作存檔失敗：${error?.message ?? error}`);
    }
  }
  const NO_TOOL_REMINDER_MS = 10 * 60_000;
  const NO_TOOL_REMINDER = '【提醒】你上一輪只輸出了文字，沒有呼叫工具，群友看不到。要回話就呼叫 send_message 或 send_sticker（回哪一則就加 reply_to=#編號）；不想回就保持安靜，這則提醒不用回。';
  process.on('exit', () => {
    try { flushMemory(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushNotes(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushKnowledge(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushMemes(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushDevFeedback(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushEmojiUsage(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushTriggers(); } catch { /* 收尾失敗不影響結束 */ }
  });

  // 黑話詞庫：候選靠學習會話產生，只有管理員在控制台確認過的才會注入 prompt。
  const slangLoaded = loadSlangFile(SLANG_FILE);
  const slangStore = slangLoaded.store;
  if (slangLoaded.warning) log(`⚠️ 黑話詞庫：${slangLoaded.warning}`);
  const sessionWaiters = new Map(); // sessionId -> 學習回合的 collector（不進公開回覆）
  const askTurns = new Map(); // sessionId -> /ask 的私人回合（見 core/discord-ask.mjs）
  const askAbandonedTurns = new Map(); // sessionId -> Map(turn, { key, muteToken, ticket, timer })
  let slangDirty = false;
  let slangSaveTimer = null;

  // ── Token 用量 ────────────────────────────────────────────────────────────
  // 帳本、回合紀錄與額度查詢在 core/discord-bridge-usage.mjs；這裡只留同名別名，
  // 下面幾百個呼叫點一行都不用改。
  const usageLayer = createUsageLayer({
    cfg,
    log,
    reverse,
    USAGE_FILE,
    TURNS_FILE,
    STATE_DIR,
    ROOT,
    CODEX_RESET_FILE,
  });
  const {
    usage,
    usageInfo,
    writeTurn,
    quotaInfo,
    codexQuotaInfo,
    codexResetPinger,
    rememberLearnerSession,
    rememberSummarySession,
  } = usageLayer;

  function saveSlangNow() {
    try {
      const pruned = saveSlangFile(SLANG_FILE, slangStore, {
        maxCandidates: cfg.discord.slang.maxCandidates,
      });
      slangDirty = false;
      if (pruned.dropped > 0) log(`黑話詞庫：候選超過上限，丟棄 ${pruned.dropped} 條`);
    } catch (error) {
      log(`黑話詞庫存檔失敗：${error?.message ?? error}`);
    }
  }

  function markSlangDirty() {
    slangDirty = true;
    if (slangSaveTimer) return;
    slangSaveTimer = setTimeout(() => {
      slangSaveTimer = null;
      if (slangDirty) saveSlangNow();
    }, 2000);
    slangSaveTimer.unref?.();
  }

  function flushSlang() {
    if (slangSaveTimer) { clearTimeout(slangSaveTimer); slangSaveTimer = null; }
    if (slangDirty) saveSlangNow();
  }

  process.on('exit', () => { try { flushSlang(); } catch { /* 收尾失敗不影響結束 */ } });

  /**
   * Jev 自動分流：只處理這一次新學到的黑話候選。
   * 失敗一律放行（候選維持原狀）；shadow 模式只寫 log，不改狀態。
   */
  async function triageSlang(addedIds, job) {
    const conf = cfg.discord.slang.jev;
    if (conf.mode === 'off') return;
    const entries = (addedIds ?? [])
      .map((id) => slangStore.entries.find((entry) => entry.id === id))
      .filter((entry) => entry?.kind === 'slang' && entry.status === SLANG_STATUS.CANDIDATE);
    if (!entries.length) return;
    const key = process.env.COMMANDCODE_API_KEY?.trim() || readDshCredential('COMMANDCODE_API_KEY');
    if (!key) {
      log('黑話 Jev：沒有 Command Code key，跳過');
      return;
    }
    const triage = buildSlangTriage({ store: slangStore, items: entries });
    let probabilities;
    try {
      probabilities = await askJev({ key, state: triage.state, questions: triage.questions });
    } catch (error) {
      log(`黑話 Jev：${error?.message ?? error}`);
      return;
    }
    // 等回應時管理員可能改過設定：重讀一次，關掉就不要動。
    const latest = cfg.discord.slang.jev;
    if (latest.mode === 'off') return;
    let confirmed = 0;
    let rejected = 0;
    for (const plan of planTriage({ ids: triage.ids, probabilities, conf: latest })) {
      // 等回應的期間管理員可能已經處理掉了：重新查一次，只動還是候選的。
      const entry = slangStore.entries.find((item) => item.id === plan.id);
      if (!entry || entry.status !== SLANG_STATUS.CANDIDATE) continue;
      appendSlangTriage({
        at: new Date().toISOString(),
        id: entry.id,
        channelId: job.channelId,
        term: entry.term,
        p: plan.p,
        action: plan.action,
        mode: latest.mode,
      });
      if (plan.action === 'reject') {
        rejectSlang(slangStore, entry.id);
        rejected += 1;
      } else if (plan.action === 'confirm') {
        // 已確認的詞會注入所有伺服器；自動確認前再過一次敏感閘門，命中就留給人工。
        if (findSensitive(`${entry.term} ${entry.meaning} ${entry.usage ?? ''}`, agentSecrets())) {
          log(`黑話 Jev：${entry.term} 命中敏感閘門，不自動確認`);
          continue;
        }
        confirmSlang(slangStore, entry.id);
        confirmed += 1;
      }
    }
    if (confirmed || rejected) {
      markSlangDirty();
      log(`黑話 Jev：自動確認 ${confirmed}、自動拒絕 ${rejected}（${latest.mode}）`);
    }
  }

  // shortcut: 分流紀錄不輪替，一天最多 40 次抽取 × 5 個詞，量很小。
  function appendSlangTriage(row) {
    try {
      fs.appendFileSync(SLANG_TRIAGE_FILE, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      log(`黑話 Jev 記錄失敗：${error?.message ?? error}`);
    }
  }

  const api = new NodeApiClient(cfg.dsh.baseUrl, DSH_TIMEOUT_MS, {
    token: cfg.dsh.authToken,
    tokenExplicit: cfg.dsh.authTokenExplicit,
    allowRemote: cfg.dsh.allowRemote,
    // 只有 Discord 橋接要算 TTFT；QQ 不需要，別讓它多收一堆串流幀。
    assistantStream: true,
  });
  if (!api.hasAuth()) {
    log(`⚠️ 讀不到 DSH 的鑑權材料（${cfg.dsh.baseUrl}）。確認 ~/.dsh/.credentials.yaml 存在，或設定 dsh.authToken`);
  }

  const ownerIds = new Set(cfg.discord.ownerIds);
  // 管理員永遠不算被不理：就算檔案被手改，也不讓模型或設定把 ownerIds 擋掉。
  const ignoredUser = (userId) => {
    const id = String(userId ?? '');
    return !ownerIds.has(id) && isIgnoring(ignoreStore, id);
  };
  // collectors／modelApplied／lastTurns／openTurns／snapshotReady 在 runtime-state。
  const sessionPromises = new Map(); // key -> 建立中的會話（防併發重複建立）
  const promptChains = new Map(); // key -> 串行化的投遞鏈（閘門可能在上一批還沒送完時就放行）
  const epochs = new Map(); // key -> 重置代次（擋掉「重置後又把舊投遞寫回去」）
  const pending = new Map(); // key -> 掛起的提問／審批
  const typingTimers = new Map(); // key -> interval
  const progress = new Map(); // key -> 這個回合的進度訊息
  const compactNotices = new Map(); // key -> 壓縮提示訊息（送出中的 Promise）
  const channelCache = new Map(); // key -> channel
  const lastActive = new Map(); // key -> 最後活動時間（控制台顯示用）
  const reactionTimes = []; // reaction 的全局時間戳（每小時上限）
  const reactionLastAt = new Map(); // key -> 上次 reaction 時間（頻道冷卻）
  let agentApiHandle = null;
  // 控制台層要等 await 才建好；先給 null，轉發箭頭 null-safe，
  // login 後到控制台起來前的空窗裡 token 跟原版一樣是空字串。
  let consoleLayer = null;
  // 讓位閘門影子模式：只記 log，不真的擋；觀察 1–2 天後改成 false。
  const YIELD_GATE_SHADOW = true;
  const activity = createActivityTracker(); // key -> 最近 10 分鐘的訊息（發言頻率）
  const quietState = createQuietState(); // key -> 安靜到什麼時候
  const followupsLoaded = loadFollowupFile(FOLLOWUPS_FILE);
  if (followupsLoaded.warning) log(`⚠️ 回訪排程：${followupsLoaded.warning}`);
  // 模型自己排的「N 分鐘後回來看」。寫檔失敗只記 log：存不了檔不能連帶讓排回訪失敗。
  const followups = createFollowupStore({
    saved: followupsLoaded.saved,
    onChange: (snapshot) => {
      try {
        saveFollowupFile(FOLLOWUPS_FILE, snapshot);
      } catch (error) {
        log(`回訪排程存檔失敗：${error?.message ?? error}`);
      }
    },
  });
  const reactionInbox = createReactionInbox(); // key -> 自己的訊息收到的 reaction（下一批提示）
  const ceobeLoaded = loadCeobeState(CEOBE_FILE);
  if (ceobeLoaded.warning) log(`⚠️ 小刻食堂：${ceobeLoaded.warning}`);
  // 餅的已讀與水位：排進回合閘門就標已讀，寧可漏一則也不要重複洗版。
  const ceobeState = createCeobeState({
    saved: ceobeLoaded.saved,
    onChange: (snapshot) => {
      try {
        saveCeobeState(CEOBE_FILE, snapshot);
      } catch (error) {
        log(`小刻食堂狀態存檔失敗：${error?.message ?? error}`);
      }
    },
  });
  const ceobeClient = createCeobeClient();
  // 手改 config.json 後重啟：新 pair 從現在開始算，移除的 pair 清掉；停用期間的餅不補。
  ceobeState.pruneChannels(cfg.discord.ceobe.channels);
  if (cfg.discord.ceobe.enabled) {
    if (!ceobeState.isEnabled()) ceobeState.resetSince();
    for (const [channelId, sourceIds] of Object.entries(cfg.discord.ceobe.channels)) {
      for (const sourceId of sourceIds) ceobeState.ensurePair(channelId, sourceId);
    }
  }
  ceobeState.setEnabled(cfg.discord.ceobe.enabled);

  /** 安靜到什麼時候；剛結束就把 primedKeys 拿掉，下一批重新帶上下文。 */
  function quietUntil(key) {
    const state = quietState.state(key);
    if (state.expired) primedKeys.delete(key);
    return state.until;
  }
  // 回合 ↔ 批次對應的狀態（pendingDirect…turnTtftMs）也在 runtime-state，
  // 上面已經別名進來：投遞時排進佇列、回合開始時取出。
  const emojiDir = cfg.discord.emoji.dir ? path.resolve(ROOT, cfg.discord.emoji.dir) : path.join(STATE_DIR, 'discord-emoji');
  let emojiCatalogs = loadCatalogs(emojiDir);
  let emojiLoadedAt = Date.now();
  // 表情使用次數：影響 query 留空時的排序，也是【常用表情】的來源；壞檔就從空的重建。
  const emojiUsage = loadEmojiUsage(EMOJI_USAGE_FILE);
  let emojiUsageDirty = false;
  let emojiUsageTimer = null;
  let emojiBuild = { running: false, startedAt: 0, finishedAt: 0, guildId: '', force: false, pid: null, exitCode: null, error: null, reason: '' };
  let emojiDebounce = null;
  const emojiPending = new Set();

  function markEmojiUsageDirty() {
    emojiUsageDirty = true;
    if (emojiUsageTimer) return;
    emojiUsageTimer = setTimeout(() => {
      emojiUsageTimer = null;
      flushEmojiUsage();
    }, 5000);
    emojiUsageTimer.unref?.();
  }

  function flushEmojiUsage() {
    if (!emojiUsageDirty) return;
    try {
      saveEmojiUsage(EMOJI_USAGE_FILE, emojiUsage, { catalogs: emojiCatalogs });
      emojiUsageDirty = false;
    } catch (error) {
      log(`表情使用次數存檔失敗：${error?.message ?? error}`);
    }
  }

  function refreshEmojiCatalogs() {
    if (Date.now() - emojiLoadedAt < 60_000) return;
    emojiCatalogs = loadCatalogs(emojiDir);
    emojiLoadedAt = Date.now();
    // 磁碟上可能又被 build 寫回來，載入後再清一次。
    pruneEmojiGuilds();
  }

  /** 離開的伺服器不要留在目錄裡：模型挑到那些表情，送出會失敗或變成看不懂的 id。 */
  function pruneEmojiGuilds() {
    const removed = pruneCatalogs(emojiCatalogs, client.guilds.cache.keys());
    if (removed.length === 0) return;
    const kept = [];
    for (const guildId of removed) {
      try {
        fs.rmSync(catalogFile(emojiDir, guildId), { force: true });
      } catch (error) {
        // 刪不掉就別假裝成功：下一輪 refresh 會把它載回來，這裡留 log 才查得到原因。
        kept.push(guildId);
        log(`表情目錄：刪不掉已離開伺服器的檔案 ${guildId}.json（${error?.message ?? error}）`);
      }
    }
    const dropped = removed.length - kept.length;
    if (dropped > 0) log(`表情目錄：移除 ${dropped} 個已離開的伺服器（${removed.filter((id) => !kept.includes(id)).join(', ')}）`);
  }

  /** 建置日誌尾巴：控制台每 5 秒抓一次，建置期間就看得到跑到第幾批。 */
  function emojiBuildLogTail(limit = 20) {
    try {
      const text = fs.readFileSync(path.join(STATE_DIR, 'emoji-build.log'), 'utf8').trimEnd();
      return text ? text.split('\n').slice(-limit) : [];
    } catch {
      return [];
    }
  }

  /** 用既有的 CLI 重建目錄（同一個實作，不在橋接裡再寫一份 vision 流程）。 */
  function startEmojiBuild({ guildId = '', force = false, reason = 'manual' } = {}) {
    if (emojiBuild.running) return false;
    const args = [path.join(ROOT, 'scripts', 'build-discord-emojis.mjs')];
    if (guildId) args.push('--guild', guildId);
    if (force) args.push('--force');
    const token = cfg.discord.token || process.env.DISCORD_TOKEN || '';
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: { ...process.env, ...(token ? { DISCORD_TOKEN: token } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      log(`無法啟動表情索引：${error?.message ?? error}`);
      return false;
    }
    emojiBuild = {
      running: true, startedAt: Date.now(), finishedAt: 0,
      guildId, force, pid: child.pid ?? null, exitCode: null, error: null, reason,
    };
    const logFile = path.join(STATE_DIR, 'emoji-build.log');
    const out = fs.createWriteStream(logFile, { flags: 'w' });
    // 子程序的輸出同時寫檔、進控制台日誌環、進 pm2 log；這樣建置期間就看得到進度。
    const tee = (stream) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      let buffer = '';
      const drain = (final = false) => {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trimEnd();
          buffer = buffer.slice(index + 1);
          if (line) logRaw(line);
        }
        if (final && buffer.trim()) {
          logRaw(buffer.trim());
          buffer = '';
        }
      };
      stream.on('data', (chunk) => {
        out.write(chunk);
        buffer += chunk;
        drain();
      });
      stream.on('end', () => drain(true));
    };
    tee(child.stdout);
    tee(child.stderr);
    child.on('error', (error) => { emojiBuild.error = String(error?.message ?? error); });
    // close 比 exit 晚：等 stdout/stderr 都收完再關檔，日誌尾巴才不會被截掉。
    child.on('close', (code) => {
      out.end();
      emojiBuild = { ...emojiBuild, running: false, finishedAt: Date.now(), exitCode: code };
      emojiCatalogs = loadCatalogs(emojiDir);
      emojiLoadedAt = Date.now();
      pruneEmojiGuilds();
      log(`表情目錄更新結束（${reason}，exit ${code}）`);
    });
    log(`開始更新表情目錄（${reason}${guildId ? `，guild ${guildId}` : ''}）`);
    return true;
  }

  /** emoji 事件會連續來（建立/改名/刪除），合併成一次掃描。 */
  function scheduleEmojiBuild(guildId) {
    if (guildId) emojiPending.add(String(guildId));
    if (emojiDebounce) return;
    emojiDebounce = setTimeout(() => {
      emojiDebounce = null;
      if (emojiBuild.running) { scheduleEmojiBuild(); return; }
      if (emojiPending.size === 0) return;
      const reason = `event:${[...emojiPending].join(',')}`;
      emojiPending.clear();
      startEmojiBuild({ reason });
    }, 15_000);
    emojiDebounce.unref?.();
  }

  // ── DSH ──────────────────────────────────────────────────────────────────
  // preset 檢查、建會話（ensureSession）、退役（retireSession）與交接摘要在
  // core/discord-bridge-dsh-sessions.mjs；epochOf 留在入口：createTurnGate 與
  // createTurns 的接線都要用它。ensureSession 等別名在下面 turns 接線處解出。
  const epochOf = (key) => epochs.get(key) ?? 0;

  // ── Discord 送出 ─────────────────────────────────────────────────────────
  // 會話改名、頻道解析與分條發送在 core/discord-bridge-output.mjs。
  const outputLayer = createOutputLayer({
    api,
    cfg,
    log,
    unwrap,
    client,
    channelCache,
    sleep,
    refreshEmojiCatalogs,
    getEmojiCatalogs: () => emojiCatalogs,
  });
  const { renameSession, resolveChannel, sendLong } = outputLayer;

  // ── 智能體工具（MCP） ────────────────────────────────────────────────────
  // 模型只能透過 mcp__discord__* 工具說話與動作；令牌、白名單、敏感資訊閘門、
  // 每輪上限都在 createAgentSender 裡（scripts/test-discord-bridge.mjs 有測）。
  // 工具定義與 agentHandlers 在 core/discord-bridge-agent-tools.mjs；這裡只留接線。
  const agentTools = createAgentTools({
    cfg,
    log,
    client,
    sessions,
    reverse,
    epochOf,
    resolveChannel,
    sendLong,
    quietUntil,
    refreshEmojiCatalogs,
    applyCustomStatus,
    withTimeout,
    AGENT_IMAGE_DIR,
    CUSTOM_STATUS_FILE,
    MEMES_FILES_DIR,
    KNOWLEDGE_WRITES_PER_TURN,
    MEMORY_WRITES_PER_TURN,
    NOTE_WRITES_PER_TURN,
    MEME_SAVES_PER_TURN,
    SLANG_WRITES_PER_TURN,
    knowledgeStore,
    memeStore,
    memoryStore,
    notesStore,
    devFeedbackStore,
    slangStore,
    triggerStore,
    ignoreStore,
    archive,
    imageJobs,
    pendingDraws,
    persistImageJobs,
    persistMemesNow,
    markMemoryDirty,
    markNotesDirty,
    markKnowledgeDirty,
    markMemesDirty,
    markDevFeedbackDirty,
    markSlangDirty,
    markTriggerDirty,
    saveIgnores,
    turnUsers,
    turnTriggerRecorded,
    turnDirectMessages,
    turnFollowupHeld,
    turnFollowupTaken,
    turnLastMessage,
    turnMeta,
    turnSentTexts,
    turnStartedAt,
    sandboxRuns,
    voicePerTurn,
    voiceLastAt,
    voiceJobs,
    memeSaves,
    devFeedbackEdits,
    devFeedbackWrites,
    knowledgeWrites,
    memoryWrites,
    noteWrites,
    slangWrites,
    emojiUsage,
    primedKeys,
    botLastByUser,
    recentHumans,
    activity,
    followups,
    quietState,
    refusals,
    ownerIds,
    ignoredUser,
    // 宣告在這層之後：直接接值會 TDZ（enqueuePrompt）或拿到不會更新的快照
    enqueuePrompt: (key, options) => enqueuePrompt(key, options),
    getBatcher: () => batcher,
    getTradeService: () => tradeRuntime.getTradeService(),
    getBotActiveRun: () => tradeRuntime.getBotActiveRun(),
    getConsoleTokenValue: () => consoleLayer?.getConsoleTokenValue?.() ?? '',
    getEmojiCatalogs: () => emojiCatalogs,
  });
  const {
    agentSecrets,
    agentSender,
    messageRefs,
    isChannelAllowed,
    noteHuman,
    forgetTriggerUser,
    apiHandlers,
    getCustomStatus,
  } = agentTools;
  // 同一會話短時間內的訊息合成一批，一批只開一個模型回合。
  const batcher = createBatcher({
    debounceMs: () => cfg.discord.batch.debounceMs,
    maxWaitMs: () => cfg.discord.batch.maxWaitMs,
    maxMessages: () => cfg.discord.batch.maxMessages,
    typingMs: TYPING_WINDOW_MS,
    onFlush: (key, items) => {
      // 加 reaction 時 handleMessage 會 await，後到的訊息可能先進批次；按時間排回來。
      const entries = [...items].sort((a, b) => a.at - b.at);
      const last = entries.at(-1);
      enqueuePrompt(key, {
        channel: last.channel,
        guildId: last.guildId,
        entries,
        direct: entries.some((entry) => entry.direct),
        // 在這裡記代次：/reset 之後，已經排進佇列（或離線佇列）的批次一律丟掉。
        epoch: epochOf(key),
      });
    },
  });

  // @ 模式頻道：叫過 bot 的人 60 秒內，補句（沒 @）也收進批次；打字再延長，最多 2 分鐘。
  const urgentTyping = createUrgentTyping({
    authorMs: URGENT_FOLLOWUP_MS,
    maxMs: URGENT_FOLLOWUP_MAX_MS,
    typingMs: TYPING_WINDOW_MS,
  });

  /** 佇列對不上（漏了 turn/start、重連）時的保守預設：私聊與 @ 模式頻道本來就每批都在叫 bot。 */
  const defaultDirect = (key) => requireMentionFor(key);

  function startTyping(key, channel) {
    if (!cfg.discord.typing || !channel) return;
    stopTyping(key);
    const startedAt = Date.now();
    const ping = () => {
      if (Date.now() - startedAt > TYPING_MAX_MS) {
        stopTyping(key);
        return;
      }
      Promise.resolve(channel.sendTyping?.()).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    timer.unref?.();
    typingTimers.set(key, timer);
  }

  function stopTyping(key) {
    const timer = typingTimers.get(key);
    if (!timer) return;
    clearInterval(timer);
    typingTimers.delete(key);
  }

  // 進度訊息：只有「正在輸入」時看不出模型在搜尋還是卡住。每個回合第一次用工具才貼，邊做邊改，結束就刪。
  function startProgress(key) {
    finishProgress(key);
    progress.set(key, { lines: [], message: null, chain: Promise.resolve(), replied: false });
  }

  function addProgress(key, line) {
    const state = progress.get(key);
    // 已經回覆了就不要再貼一則新的：它會出現在回覆下面，然後又消失。
    if (!state || (state.replied && !state.message)) return;
    state.lines = [...state.lines, line];
    const content = formatProgress(state.lines);
    state.chain = state.chain.then(async () => {
      if (progress.get(key) !== state) return;
      if (state.message) {
        await state.message.edit({ content, allowedMentions: { parse: [] } });
        return;
      }
      const channel = await resolveChannel(key);
      state.message = await channel.send({
        content,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications | MessageFlags.SuppressEmbeds,
      });
    }).catch((error) => log(`進度訊息更新失敗（${key}）：${error?.message ?? error}`));
  }

  function finishProgress(key) {
    const state = progress.get(key);
    if (!state) return;
    progress.delete(key);
    // 排在發送後面：還在送的那則送完再刪，不會留在頻道裡。
    state.chain = state.chain
      .then(() => state.message?.delete())
      .catch((error) => log(`進度訊息刪除失敗（${key}）：${error?.message ?? error}`));
  }

  function showCompactNotice(key) {
    if (compactNotices.has(key)) return;
    const sent = resolveChannel(key)
      .then((channel) => channel.send({
        content: COMPACT_NOTICE,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications | MessageFlags.SuppressEmbeds,
      }))
      .catch((error) => {
        log(`壓縮提示送出失敗（${key}）：${error?.message ?? error}`);
        return null;
      });
    compactNotices.set(key, sent);
  }

  function hideCompactNotice(key) {
    const sent = compactNotices.get(key);
    if (!sent) return;
    compactNotices.delete(key);
    // 等送出完成再刪：壓縮很快結束時，提示可能還在路上。
    sent
      .then((message) => message?.delete())
      .catch((error) => log(`壓縮提示刪除失敗（${key}）：${error?.message ?? error}`));
  }

  // ── 回合層（閘門＋turns）──────────────────────────────────────────────────

  // 同一會話一次只送一批：回合還沒結束，新到的批次先壓在橋接合成一筆（見 createTurnGate）。
  const turnGate = createTurnGate({
    maxEntries: HELD_MAX,
    releaseMs: TURN_RELEASE_MS,
    onStuck: (key) => log(`等不到回合結束，先放行下一批 (${key})`),
    deliver: (key, job, ticket) => {
      if (job.ask) {
        void runAskJob(key, job, ticket).catch((error) => {
          log(`後台回合失敗 (${key})：${error?.message ?? error}`);
          turnGate.release(key, ticket);
        });
        return;
      }
      const previous = promptChains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => deliverPrompt(key, job, ticket))
        .then((turnQueued) => { if (!turnQueued) turnGate.release(key, ticket); })
        .catch(async (error) => {
          turnGate.release(key, ticket);
          stopTyping(key);
          if (isTransientDshError(error)) {
            // 回訪與提醒進離線佇列會被後面的批次合併掉（mergeJobs 只看 entries）；時間過了就放棄。
            if (job.followup || job.reminder) {
              log(`DSH 暫時不可用，放棄${job.reminder ? '提醒' : '回訪'} (${key})`);
              writeTurn(key, { chatty: isChattyChannel(cfg.discord, job.channel?.id) }, 'skipped', { reason: 'gate', job });
              return;
            }
            enqueueOffline(key, job);
            return;
          }
          log(`投遞失敗 (${key})：${error?.message ?? error}`);
          writeTurn(key, { chatty: isChattyChannel(cfg.discord, job.channel?.id) }, 'skipped', { reason: 'gate', job });
          if (job.direct) {
            // preset 的安裝細節（可用清單、setup 指令）只寫 log，不貼到公開頻道。
            const publicMessage = error?.code === 'preset-missing' || error?.code === 'preset-broken'
              ? '⚠️ 這個頻道的人格還沒安裝好，請管理員看 bridge log。'
              : `⚠️ 無法送出給 DSH：${error?.message ?? error}`;
            await sendLong(key, publicMessage).catch(() => {});
          }
        });
      promptChains.set(key, next);
      const cleanup = () => { if (promptChains.get(key) === next) promptChains.delete(key); };
      next.then(cleanup, cleanup);
    },
  });

  // 提問審批、事件流、自動壓縮、TTFT 都在 core/discord-bridge-turns.mjs。
  const turns = createTurns({
    api,
    log,
    pending,
    cfg,
    sendLong,
    reverse,
    askTurns,
    askAbandonedTurns,
    turnUsers,
    ASK_CANCEL_FAILED_GRACE_MS,
    DSH_COMMAND_TIMEOUT_MS,
    createTurnCollector,
    unwrap,
    findSensitive,
    sessions,
    sleep,
    turnsFromRecords,
    NO_TOOL_REMINDER,
    NO_TOOL_REMINDER_MS,
    addProgress,
    agentSecrets,
    agentSender,
    botTokenSink,
    clearAbandonedTurn,
    defaultDirect,
    epochOf,
    finishCeobeTurn: (...args) => finishCeobeTurn(...args),
    finishProgress,
    hideCompactNotice,
    lastActive,
    markTurnEnded,
    markTurnOpen,
    progress,
    quietUntil,
    resolveChannel,
    sessionWaiters,
    showCompactNotice,
    startProgress,
    startTyping,
    stopAskSession,
    stopTyping,
    syncHedgeSettings: () => syncHedgeSettings(),
    usage,
    writeTurn,
    collectors,
    compactNotices,
    devFeedbackEdits,
    devFeedbackWrites,
    emojiShown,
    knowledgeWrites,
    lastTurns,
    memeSaves,
    memoryWrites,
    noToolRemindedAt,
    noteWrites,
    openTurns,
    pendingDirect,
    pendingDirectMessages,
    pendingLastMessages,
    pendingUsers,
    sandboxRuns,
    slangWrites,
    snapshotReady,
    ttftAbandonedTurns,
    ttftTimeouts,
    ttftTimers,
    turnDirect,
    turnDirectMessages,
    turnFollowupHeld,
    turnFollowupTaken,
    turnLastMessage,
    turnMeta,
    turnSentTexts,
    turnStartedAt,
    turnTickets,
    turnTools,
    turnTriggerRecorded,
    turnTtftMs,
    typingTimers,
    voicePerTurn,
    turnGate,
    YIELD_GATE_SHADOW,
    activity,
    client,
    collectSlangSample: (...args) => collectSlangSample(...args),
    getEmojiCatalogs: () => emojiCatalogs,
    emojiUsage,
    ensureSession: (...args) => ensureSession(...args),
    followups,
    ignoredUser,
    knowledgeStore,
    markMemoryDirty,
    markNotesDirty,
    memeStore,
    memoryStore,
    messageRefs,
    notesStore,
    reactionInbox,
    reactionLastAt,
    reactionTimes,
    refreshEmojiCatalogs,
    reloadStore,
    saveReloadStore,
    slangStore,
    triggerStore,
    memoryShown,
    notesShown,
    knowledgeShown,
    slangShown,
    primedKeys,
    silentPending,
    botLastByUser,
    recentHumans,
    offlineQueue,
    offlineHintAt,
    needsOpening,
  });
  const {
    cancelPendingEntry,
    registerPending,
    answerPending,
    handleQuestion,
    handleApproval,
    autoCompact,
    clearTtftTimer,
    clearAllTtftTimers,
    armTtftTimer,
    handleSessionEvent,
    handleFrame,
    pumpEvents,
    enqueueOffline,
    enqueuePrompt,
    requireMentionInGuild,
    requireMentionFor,
    deliverPrompt,
    maybeReact,
  } = turns;

  // DSH 會話層在 core/discord-bridge-dsh-sessions.mjs；ensureSession 依賴 turnGate，
  // turnGate 又要 epochOf，所以這層只能在 turns 之後接線。createTurns 拿的是
  // ensureSession 的轉發箭頭：箭頭裡的名字執行期才解析，接線時不會讀到還沒宣告的別名。
  const dshSessions = createDshSessions({
    api,
    cfg,
    log,
    unwrap,
    withTimeout,
    PRIVATE_RELOAD_HEADER,
    SESSIONS_FILE,
    RELOAD_FILE,
    STATE_DIR,
    usage,
    sessions,
    sessionPresets,
    reverse,
    modelApplied,
    needsOpening,
    sessionPromises,
    epochs,
    epochOf,
    sessionWaiters,
    askTurns,
    forgetAbandonedTurns,
    pending,
    cancelPendingEntry,
    turnGate,
    followups,
    batcher,
    urgentTyping,
    refusals,
    agentSender,
    quietState,
    reactionInbox,
    imageJobs,
    pendingDraws,
    voiceJobs,
    persistImageJobs,
    runtime,
    stopTyping,
    finishProgress,
    hideCompactNotice,
    clearTtftTimer,
    client,
    agentSecrets,
    reloadStore,
    saveReloadStore,
    renameSession,
    persistedSessions,
    saveSessionPresetMap,
  });
  const {
    loadPresets,
    requirePreset,
    applyModel,
    ensureSession,
    retireSession,
    resetConversation,
    reloadSystemPrompt,
  } = dshSessions;

  // 訊息入口（離線佇列、批次組裝、投遞、reaction）也在 core/discord-bridge-turns.mjs。

  // ── 背景工作 ──────────────────────────────────────────────────────────────
  // 黑話學習、小刻食堂、回訪、每日摘要與側寫在 core/discord-bridge-background.mjs；
  // stopAskSession 與回合簿記（markTurnOpen 等）留入口，由 deps 接回去。
  const backgroundJobs = createBackgroundJobs({
    cfg,
    log,
    api,
    client,
    sessions,
    reverse,
    sessionPresets,
    STATE_DIR,
    ASK_TIMEOUT_MS,
    ASK_CANCEL_FAILED_GRACE_MS,
    ASK_ABANDONED_TTL_MS,
    PRIVATE_ASK_HEADER,
    PRIVATE_TURN_READY_TIMEOUT_MS,
    PRIVATE_TURN_READY_POLL_MS,
    SLANG_WINDOW_MAX,
    SUMMARY_MIN_MESSAGES,
    SUMMARY_MAX_MESSAGES,
    SUMMARY_TRANSCRIPT_CHARS,
    SUMMARY_INTERVAL_MS,
    turnGate,
    ensureSession,
    requirePreset,
    enqueuePrompt,
    epochOf,
    agentSender,
    agentSecrets,
    isChannelAllowed,
    sendLong,
    renameSession,
    resolveChannel,
    quietUntil,
    sleep,
    withTimeout,
    ceobeState,
    ceobeClient,
    channelCache,
    followups,
    ignoredUser,
    memoryStore,
    notesStore,
    slangStore,
    runtime,
    openTurns,
    lastTurns,
    collectors,
    snapshotReady,
    askTurns,
    askAbandonedTurns,
    sessionWaiters,
    botTokenSink,
    rememberLearnerSession,
    rememberSummarySession,
    markMemoryDirty,
    markNotesDirty,
    markSlangDirty,
    triageSlang,
    stopAskSession,
    clearAbandonedTurn,
    pruneArchive,
  });
  const {
    finishCeobeTurn,
    collectSlangSample,
    ceobeInfo,
    runBackgroundPrompt,
    runAskJob,
    scheduleSummaryCheck,
    scheduleFollowupCheck,
    scheduleCeobeCheck,
    localDayKey,
    getSlangDayKey,
    getSlangDayCount,
    resetCeobeCache,
    slangQueueInfo,
    clearSummaryTimer,
  } = backgroundJobs;

  /**
   * 停掉後台提問那一輪：清掉 DSH inbox 裡還沒跑的問題，再取消正在跑的回合。
   * 失敗時把 waiter 的寬限拉長，不要立刻解除 mute。
   * @param options.closeOnSuccess 斷線時用：事件流收不到 turn/end，取消受理後直接收尾
   */
  async function stopAskSession(sessionId, tracker, { closeOnSuccess = false } = {}) {
    try {
      await api.stopSessionWork(sessionId, { timeoutMs: 15_000 });
      if (tracker?.phase !== 'closing') return;
      // 沒認領到回合也要再等一下：讀佇列到 cancel 之間，回合可能剛好開始跑。
      // 有回合就等它自己的 turn/end；寬限到了不會關，交給 hardClose 保底。
      if (closeOnSuccess) tracker.close();
      else tracker.extendGrace(10_000);
    } catch (error) {
      log(`後台提問取消失敗 ${sessionId}：${error?.message ?? error}`);
      tracker?.extendGrace(ASK_CANCEL_FAILED_GRACE_MS);
    }
  }

  function markTurnOpen(sessionId, turn) {
    const set = openTurns.get(sessionId) ?? new Set();
    set.add(turn);
    openTurns.set(sessionId, set);
  }

  function markTurnEnded(sessionId, turn) {
    const set = openTurns.get(sessionId);
    if (!set) return;
    set.delete(turn);
    if (set.size === 0) openTurns.delete(sessionId);
  }

  function clearAbandonedTurn(sessionId, turn) {
    const turns = askAbandonedTurns.get(sessionId);
    const entry = turns?.get(turn);
    if (!entry) return;
    clearTimeout(entry.timer);
    turns.delete(turn);
    if (turns.size === 0) askAbandonedTurns.delete(sessionId);
    markTurnEnded(sessionId, turn);
    agentSender.clearMuted(entry.key, entry.muteToken);
    turnGate.release(entry.key, entry.ticket);
  }

  /** /reset：這一輪已經不屬於任何活著的會話，清掉計時器就好（mute/閘門另有清理）。 */
  function forgetAbandonedTurns(sessionId) {
    const turns = askAbandonedTurns.get(sessionId);
    if (!turns) return;
    for (const entry of turns.values()) clearTimeout(entry.timer);
    askAbandonedTurns.delete(sessionId);
  }


  // ── Discord 入口事件 ──────────────────────────────────────────────────────
  // 訊息、reaction、typing 與 slash 命令的准入分派在 core/discord-bridge-inbound.mjs；
  // gateway 事件註冊留在入口，handler 走同名別名。
  const inbound = createInbound({
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
    batcher,
    codexQuotaInfo,
    collectSlangSample,
    DSH_COMMAND_TIMEOUT_MS,
    // trade 的別名宣告在這層之後：轉發箭頭執行期才解析
    forgetTradeAccount: (...args) => forgetTradeAccount(...args),
    forgetTriggerUser,
    getTradeService: () => getTradeService(),
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
    // 控制台的 updateConfig 別名宣告在這層之後：轉發箭頭執行期才解析
    updateConfig: (...args) => consoleLayer?.updateConfig?.(...args),
    urgentTyping,
    writeTurn,
    emojiUsage,
    // 入口的 let：值快取會過期，一律走 getter
    getArchiveFlushing: () => archiveFlushing,
    getConsoleTokenValue: () => consoleLayer?.getConsoleTokenValue?.() ?? '',
    getEmojiCatalogs: () => emojiCatalogs,
  });
  const {
    handleReaction,
    handleMessage,
    handleTyping,
    handleSlashCommand,
    registerSlashCommands,
  } = inbound;

  // ── 啟動 ─────────────────────────────────────────────────────────────────

  client.on(Events.MessageCreate, (message) => {
    // bot 自己的訊息在 handleMessage 第一行就被擋掉；歸檔另外收，聊天紀錄才看得到自己說過什麼。
    if (archive && message.guildId && message.author?.id === client.user?.id) {
      const parts = messageParts(message);
      queueArchive(archiveEntry(message, flat(resolveMentions(parts.text, message), 1000)), parts.text);
    }
    handleMessage(message).catch((error) => log(`處理訊息失敗：${error?.stack ?? error}`));
  });
  // 編輯過改存新內容（點 id 固定，upsert 直接覆蓋）；刪掉的就從歸檔刪掉，不留「刪了還查得到」。
  client.on(Events.MessageUpdate, (_old, message) => {
    if (!archive || !message?.guildId || !message.content) return;
    if (message.author?.bot && message.author?.id !== client.user?.id) return;
    if (isSkippedMessage(message.content, client.user.id)) return;
    const parts = messageParts(message);
    queueArchive(archiveEntry(message, flat(resolveMentions(parts.text, message), 1000)), parts.text);
  });
  client.on(Events.MessageDelete, (message) => {
    if (!archive || !message?.guildId) return;
    void archive.deletePoints([message.id]).catch((error) => log(`歷史歸檔刪除失敗：${error?.message ?? error}`));
  });
  client.on(Events.MessageDeleteBulk, (messages) => {
    if (!archive) return;
    void archive.deletePoints([...messages.keys()]).catch((error) => log(`歷史歸檔批次刪除失敗：${error?.message ?? error}`));
  });
  client.on(Events.TypingStart, (typing) => {
    try {
      handleTyping(typing);
    } catch (error) {
      log(`處理輸入中失敗：${error?.message ?? error}`);
    }
  });
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handleReaction(reaction, user).catch((error) => log(`處理 reaction 失敗：${error?.stack ?? error}`));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    handleSlashCommand(interaction).catch((error) => log(`slash command 失敗：${error?.stack ?? error}`));
  });
  // 表情變動 → 15 秒去抖後重掃（hash 快取只會索引新的/換圖的）。
  client.on(Events.GuildDelete, (guild) => {
    // available=false 只是 Discord 暫時連不上，不算離開。
    if (guild.available) pruneEmojiGuilds();
  });
  client.on(Events.GuildEmojiCreate, (emoji) => {
    log(`表情新增：${emoji.name}`);
    scheduleEmojiBuild(emoji.guild?.id ?? emoji.guildId);
  });
  client.on(Events.GuildEmojiUpdate, (_old, emoji) => {
    log(`表情更新：${emoji.name}`);
    scheduleEmojiBuild(emoji.guild?.id ?? emoji.guildId);
  });
  client.on(Events.GuildEmojiDelete, (emoji) => {
    log(`表情刪除：${emoji.name}`);
    scheduleEmojiBuild(emoji.guild?.id ?? emoji.guildId);
  });
  client.on(Events.Error, (error) => log(`Discord 客戶端錯誤：${error?.message ?? error}`));
  client.on(Events.Warn, (warning) => log(`Discord 警告：${warning}`));

  // 自訂狀態：每次 READY（含重新 IDENTIFY）都要重新套用，ClientReady 一個程序只觸發一次。
  client.on(Events.ShardReady, () => {
    const savedStatus = getCustomStatus();
    if (!savedStatus) return;
    try {
      applyCustomStatus(savedStatus);
    } catch (error) {
      log(`套用自訂狀態失敗：${error?.message ?? error}`);
    }
  });

  // ── 模擬股票 ──────────────────────────────────────────────────────────────
  // 服務建立、結算與 Bot 交易排程在 core/discord-bridge-trade.mjs；
  // 啟動（initTrade＋scheduleTradeJobs）與 shutdown（stopTradeJobs）走同名別名。
  const tradeRuntime = createTradeRuntime({
    cfg,
    log,
    client,
    agentSecrets,
    STATE_DIR,
    botTokenSink,
    runBackgroundPrompt,
  });
  const {
    initTrade,
    scheduleTradeJobs,
    stopTradeJobs,
    applyTradeConfig,
    forgetTradeAccount,
    getTradeService,
  } = tradeRuntime;

  client.once(Events.ClientReady, (ready) => {
    log(`已登入：${ready.user.tag}（${ready.user.id}）`);
    pruneEmojiGuilds();
    if (ownerIds.size === 0) log('⚠️ 沒有設定 discord.ownerIds：/reset、/status、工具審批都會不可用');
    const noGuildRules = cfg.discord.allow.guilds.length === 0 && cfg.discord.allow.channels.length === 0;
    if (noGuildRules && !cfg.discord.allowAllWhenEmpty) log('⚠️ 頻道白名單為空：只會回應 allow.users 裡的私聊');
    if (!cfg.discord.messageContentIntent) log('ℹ️ 未申請 Message Content 意圖：頻道裡只會處理 @bot 的訊息');
    warnChattyChannels();
    void registerSlashCommands();
  });

  // chatty 頻道如果還是 @ 模式，【參與度】根本不會出現；啟動與每次改設定都提醒一次。
  function warnChattyChannels() {
    for (const id of cfg.discord.chattyChannels) {
      if (requireMentionForChannel(cfg.discord, id)) {
        log(`⚠️ chattyChannels 的 ${id} 還是要 @bot（requireMentionInChannel 或 messageContentIntent），參與度不會生效`);
      }
    }
  }

  // 已持久化的會話先排進 follow；事件流重連時客戶端會自動重放。
  for (const sessionId of Object.values(sessions)) api.events.follow(sessionId);

  try {
    await client.login(token);
  } catch (error) {
    if (/disallowed intents/i.test(String(error?.message ?? error))) {
      log('提示：Developer Portal → Bot → 開啟 Message Content Intent，或把 discord.messageContentIntent 設為 false');
    }
    throw error;
  }

  // ── 模擬股票 ──────────────────────────────────────────────────────────────
  initTrade();
  scheduleTradeJobs();

  // ── 智能體發送 API（MCP） ────────────────────────────────────────────────
  // 只綁 127.0.0.1 的隨機埠，端點寫在 state/discord-agent.json 給 MCP server 讀。
  // 啟動失敗就讓它失敗：沒有發送端點，模型就完全無法回話，比直接掛掉更難查。
  if (cfg.discord.sandbox.enabled) {
    // 上次橋接被砍掉時，容器可能還留著；背景清掉，不能讓 docker 卡住拖慢聊天。
    void cleanupStaleContainers({ log });
  }
  agentApiHandle = await startAgentApi({ file: AGENT_ENDPOINT_FILE, handlers: apiHandlers, log });
  log('模型發訊息：mcp__discord__*（DSH 要掛 mcp-discord）');
  // 外掛失聯（DSH 重啟、當掉、連不上）：不會再有 poll 或 done，等 2 分鐘就收掉並告訴頻道。
  const imageJobSweep = setInterval(() => {
    for (const job of pruneVoiceJobs({ jobs: voiceJobs })) {
      log(`語音工作逾時，丟棄（${job.key}，job ${job.id}）`);
      void job.notice?.delete().catch(() => {});
    }
    const stale = sweepStaleImageJobs({ jobs: imageJobs });
    if (stale.length === 0) return;
    persistImageJobs();
    for (const job of stale) {
      if (!sessions[job.key]) continue;
      log(`生圖工作失聯，丟棄（${job.key}，job ${job.jobId}）`);
      enqueuePrompt(job.key, {
        entries: [],
        direct: false,
        system: true,
        epoch: epochOf(job.key),
        text: IMAGE_JOB_STALE_TEXT,
      });
    }
  }, 30_000);
  imageJobSweep.unref?.();
  scheduleSummaryCheck();
  scheduleFollowupCheck();
  scheduleCeobeCheck();
  codexResetPinger?.start();

  // ── 控制台 ───────────────────────────────────────────────────────────────
  // HTTP API、供應商設定與管理端點在 core/discord-bridge-console.mjs；
  // syncHedgeSettings 給回合層的接線用（轉發箭頭，別名宣告在後），
  // stopConsole 給 shutdown 用，getConsoleTokenValue 給 agentTools／inbound 用。
  consoleLayer = await createConsoleLayer({
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
    // 入口的 let：控制台只讀，走 getter
    getArchiveFlushing: () => archiveFlushing,
    getEmojiBuild: () => emojiBuild,
    getEmojiCatalogs: () => emojiCatalogs,
  });
  const { syncHedgeSettings, updateConfig, stopConsole } = consoleLayer;

  const shutdown = async (signal) => {
    log(`收到 ${signal}，結束中…`);
    try { flushMemory(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushNotes(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushKnowledge(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushMemes(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushDevFeedback(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushEmojiUsage(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushSlang(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushTriggers(); } catch { /* 收尾失敗不影響結束 */ }
    // 歸檔是外部服務：最多等 5 秒，送不完就放棄（下次啟動不會補，這是刻意的）。
    try {
      if (archive && archiveQueue.length) {
        await Promise.race([flushArchive(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
    } catch { /* 收尾失敗不影響結束 */ }
    codexResetPinger?.stop();
    clearAllTtftTimers();
    stopTradeJobs();
    clearSummaryTimer();
    try { await agentApiHandle?.close(); } catch { /* 已經關了 */ }
    try { await stopConsole(); } catch { /* 已經關了 */ }
    try { await client.destroy(); } catch { /* 已斷線就算了 */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  await pumpEvents();
}

// pm2（fork 模式）不是直接跑這支檔案，而是用它的 ProcessContainerFork 載入；
// 那時 process.argv[1] 是容器路徑，只比 argv[1] 會讓 main() 永遠不執行（程序活著、什麼都不做）。
const startedAsEntry = process.env.pm_id !== undefined
  || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (startedAsEntry) {
  main().catch((error) => {
    console.error(`[discord] 啟動失敗：${error?.message ?? error}`);
    process.exit(1);
  });
}
