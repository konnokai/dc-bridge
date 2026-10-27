#!/usr/bin/env node
// Discord ↔ DSH 橋接（聊天模式）。
//
// 這支程式只做一件事：把 Discord 訊息送進 DSH 會話，再把回合結果／提問／審批送回同一個頻道。
// 協定層直接用 src/dsh-client.js（Cookie 鑄造、斜線 RPC、remote.mux 事件流），
// 准入與分條等純邏輯在 src/core/discord-core.mjs。
//
// 為什麼不重用 src/bridge.js：那是 QQ 專用單體（一萬兩千行，QQ 發送寫死在 main() 裡）。
// 拆平台介面的成本高於重寫一個只做 chat 的入口，而且上游 DSH 協議還在動。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, SlashCommandBuilder, ChannelType } from 'discord.js';
import { NodeApiClient, createTurnCollector, discoverDshLaunchToken, unwrap } from './dsh-client.js';
import {
  INVITE_PERMISSIONS,
  INVITE_SCOPES,
  buildInviteUrl,
  conversationKeyFor,
  invitePermissionsBitfield,
  isConversationAllowed,
  isTransientDshError,
  loadSessions,
  normalizeDiscordConfig,
  parseApprovalAnswer,
  questionAnswersFor,
  saveSessions,
  shouldHandleGuildMessage,
  splitDiscordMessage,
  stripBotMention,
} from './core/discord-core.mjs';
import { formatQuote, formatRecentContext, formatTimeContext } from './core/discord-context.mjs';
import { findSensitive } from './core/discord-security.mjs';
import { formatEmojiHint, loadCatalogs, retrieveEmojis, substituteEmojiNames } from './core/discord-emoji.mjs';
import {
  forgetUser,
  formatUserMemory,
  loadMemoryFile,
  pruneMemory,
  recordUserMessage,
  saveMemoryFile,
} from './core/discord-memory.mjs';
import {
  SLANG_STATUS,
  buildExtractionPrompt,
  buildSlangHint,
  confirmSlang,
  deleteSlang,
  loadSlangFile,
  parseExtractionJson,
  rejectSlang,
  saveSlangFile,
  slangStats,
  updateSlang,
  upsertCandidates,
} from './core/discord-slang.mjs';
import {
  collectImageAttachments,
  describeSkipped,
  fetchDiscordImage,
  prepareImageBlock,
} from './core/discord-media.mjs';
import { resolveConsoleToken, startConsole } from './core/discord-console.mjs';
import { createAgentSender, startAgentApi } from './core/discord-agent.mjs';
import { createBatcher, formatBatch } from './core/discord-batch.mjs';
import { createUsageTracker, usageReport } from './core/discord-usage.mjs';
import { resolvePriceTable } from './model-prices.js';
import { truncateText } from './md-to-plain.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SESSIONS_FILE = path.join(STATE_DIR, 'discord-sessions.json');
const MEMORY_FILE = path.join(STATE_DIR, 'discord-memory.json');
const SLANG_FILE = path.join(STATE_DIR, 'discord-slang.json');
const USAGE_FILE = path.join(STATE_DIR, 'discord-usage.jsonl');
const AGENT_ENDPOINT_FILE = path.join(STATE_DIR, 'discord-agent.json');
const LOCK_FILE = path.join(STATE_DIR, 'discord-bridge.lock');
const DSH_TIMEOUT_MS = 60_000;
const TYPING_REFRESH_MS = 8_000; // Discord 的「正在輸入」一次只維持 10 秒
const TYPING_MAX_MS = 10 * 60 * 1000; // 回合卡住時不要讓「正在輸入」亮一輩子
const SLANG_WINDOW_MAX = 80; // 每個頻道保留幾則語料（記憶體，重啟就沒了）

/**
 * 橋接指令。`default_member_permissions` 只是 Discord 端的預設顯示條件，
 * 伺服器管理員可以改；真正的邊界是執行時的權限檢查（見 handleSlashCommand）。
 * dmPermission: false —— reset/status 只對伺服器頻道有意義，私聊請用 `!reset` / `!status`。
 * forget 不設管理員權限：任何人都能刪自己的記憶。
 */
const slashCommandData = [
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('重置這個頻道的會話上下文（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('顯示這個頻道的會話狀態（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('invite')
    .setDescription('產生機器人邀請連結（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('mention')
    .setDescription('切換頻道要不要 @bot 才回（全部伺服器共用，管理員）')
    .addBooleanOption((option) => option
      .setName('required')
      .setDescription('true：要 @bot 才回；false：自由參與。不填就只顯示目前設定'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('刪除你在這個伺服器的跨頻道記憶')
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
  return {
    dsh: {
      baseUrl: String(dsh.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
      provider: String(dsh.provider || 'opencode-go'),
      model: String(dsh.model || 'deepseek-v4.1-flash'),
      reasoningEffort: String(dsh.reasoningEffort || 'max'),
      // 顯式填的 token 優先；留空時才去日誌裡找（新版 DSH 通常找不到，改用離線鑄造 Cookie）。
      authToken: authToken || discoverDshLaunchToken(),
      authTokenExplicit: Boolean(authToken),
      allowRemote: dsh.allowRemote === true,
    },
    discord: normalizeDiscordConfig(file?.discord),
    // 價目表覆蓋項（token 看板用）；沒填就沿用內建 DeepSeek 官方價。
    pricing: file?.pricing,
  };
}

/** 單一實例：兩個橋接搶同一個 bot token 會各自建會話、各自回覆。 */
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
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

  acquireLock();
  const { sessions } = loadSessions(SESSIONS_FILE);
  const reverse = new Map(Object.entries(sessions).map(([key, sessionId]) => [sessionId, key]));

  // 跨頻道記憶：只記有叫 bot 的公開頻道訊息；私聊與私密頻道不記。
  const memoryLoaded = loadMemoryFile(MEMORY_FILE);
  const memoryStore = memoryLoaded.store;
  if (memoryLoaded.warning) log(`⚠️ 記憶檔：${memoryLoaded.warning}`);
  let memoryDirty = false;
  let memorySaveTimer = null;

  function markMemoryDirty() {
    memoryDirty = true;
    if (memorySaveTimer) return;
    memorySaveTimer = setTimeout(() => {
      memorySaveTimer = null;
      flushMemory();
    }, 2000);
    // 不要為了等存檔而讓程序多活 2 秒；PM2 停止時會走 shutdown 的同步 flush。
    memorySaveTimer.unref?.();
  }

  function flushMemory() {
    if (!memoryDirty) return;
    try {
      saveMemoryFile(MEMORY_FILE, memoryStore);
      memoryDirty = false;
    } catch (error) {
      log(`記憶存檔失敗：${error?.message ?? error}`);
    }
  }

  if (cfg.discord.memory.enabled) {
    const pruned = pruneMemory(memoryStore, { ...cfg.discord.memory, maxUsers: 200 });
    if (pruned.usersRemoved > 0 || pruned.messagesRemoved > 0) {
      log(`記憶整理：移除 ${pruned.usersRemoved} 人 / ${pruned.messagesRemoved} 則`);
      markMemoryDirty();
    }
  }
  process.on('exit', () => { try { flushMemory(); } catch { /* 收尾失敗不影響結束 */ } });

  // 黑話詞庫：候選靠學習會話產生，只有管理員在控制台確認過的才會注入 prompt。
  const slangLoaded = loadSlangFile(SLANG_FILE);
  const slangStore = slangLoaded.store;
  if (slangLoaded.warning) log(`⚠️ 黑話詞庫：${slangLoaded.warning}`);
  const slangWindows = new Map(); // channelId -> 最近訊息（記憶體 ring buffer）
  const slangQueue = [];
  const slangQueued = new Set();
  const learnerWaiters = new Map(); // sessionId -> 學習回合的 collector（不進 reverse）
  let slangRunning = false;
  let slangTimer = null;
  let slangLastRunAt = 0;
  let slangDayKey = '';
  let slangDayCount = 0;
  let slangWorkspaceId = null;
  let slangDirty = false;
  let slangSaveTimer = null;

  // ── Token 用量 ────────────────────────────────────────────────────────────
  // 權威累計取 DSH 的 tokenUsage 投影（整條會話日誌，含橋接啟動前的歷史），
  // 逐輪明細由 assistant/message 的 usage 折疊；金額在讀取時才按價目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const learnerSessions = new Set(); // 學習會話（用來歸到 internal:黑話學習）
  const usage = createUsageTracker({
    file: USAGE_FILE,
    priceTable,
    log,
    reverse,
    learnerSessions,
    nominalModel: cfg.dsh.model,
    provider: cfg.dsh.provider,
  });

  /** 學習會話只會愈開愈多；記住最近 200 個就夠歸屬，舊的 key 已存在帳本裡。 */
  function rememberLearnerSession(sessionId) {
    learnerSessions.add(sessionId);
    if (learnerSessions.size > 200) learnerSessions.delete(learnerSessions.values().next().value);
  }

  function usageInfo({ range = '24h', limit = 200 } = {}) {
    return usageReport({ ledger: usage.ledger, priceTable, nominalModel: cfg.dsh.model, range, limit });
  }

  function saveSlangNow() {
    try {
      const pruned = saveSlangFile(SLANG_FILE, slangStore, {
        maxCandidates: cfg.discord.slang.maxCandidates,
        maxConfirmed: cfg.discord.slang.maxConfirmed,
      });
      slangDirty = false;
      if (pruned.dropped > 0) log(`黑話詞庫已滿，丟棄 ${pruned.dropped} 條（已確認優先）`);
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

  const api = new NodeApiClient(cfg.dsh.baseUrl, DSH_TIMEOUT_MS, {
    token: cfg.dsh.authToken,
    tokenExplicit: cfg.dsh.authTokenExplicit,
    allowRemote: cfg.dsh.allowRemote,
  });
  if (!api.hasAuth()) {
    log(`⚠️ 讀不到 DSH 的鑑權材料（${cfg.dsh.baseUrl}）。確認 ~/.dsh/.credentials.yaml 存在，或設定 dsh.authToken`);
  }

  const ownerIds = new Set(cfg.discord.ownerIds);
  const collectors = new Map(); // sessionId -> turn collector
  const modelApplied = new Set(); // 本程序內已 selectModel 過的會話
  const sessionPromises = new Map(); // key -> 建立中的會話（防併發重複建立）
  const promptChains = new Map(); // key -> 串行化的投遞鏈
  const epochs = new Map(); // key -> 重置代次（擋掉「重置後又把舊投遞寫回去」）
  const pending = new Map(); // key -> 掛起的提問／審批
  const typingTimers = new Map(); // key -> interval
  const channelCache = new Map(); // key -> channel
  const lastActive = new Map(); // key -> 最後活動時間（控制台顯示用）
  let lastFrameAt = 0; // 事件流最後一幀的時間（控制台顯示用）
  const reactionTimes = []; // reaction 的全局時間戳（每小時上限）
  const reactionLastAt = new Map(); // key -> 上次 reaction 時間（頻道冷卻）
  const offlineQueue = new Map(); // key -> 等待 DSH 恢復的 job
  const offlineHintAt = new Map(); // key -> 上次「已排隊」提示的時間
  let offlineTimer = null;
  let offlineFlushing = false;
  let consoleTokenValue = '';
  let agentApiHandle = null;
  const primedKeys = new Set(); // 自由參與：這次啟動後已經帶過頻道上下文的會話
  // 回合 ↔ 批次對應：DSH 依投遞順序跑回合，所以投遞時排進佇列、回合開始時取出。
  // 用來決定這個回合要不要亮輸入提示、出錯時要不要在頻道說（沒人叫 bot 的那批不說）。
  const pendingDirect = new Map(); // key -> boolean[]（已投遞、回合還沒開始）
  const turnDirect = new Map(); // key -> 目前這個回合的那批有沒有人叫 bot
  const emojiDir = cfg.discord.emoji.dir ? path.resolve(ROOT, cfg.discord.emoji.dir) : path.join(STATE_DIR, 'discord-emoji');
  let emojiCatalogs = loadCatalogs(emojiDir);
  let emojiLoadedAt = Date.now();
  let emojiBuild = { running: false, startedAt: 0, finishedAt: 0, guildId: '', force: false, pid: null, exitCode: null, error: null, reason: '' };
  let emojiDebounce = null;
  const emojiPending = new Set();

  function refreshEmojiCatalogs() {
    if (Date.now() - emojiLoadedAt < 60_000) return;
    emojiCatalogs = loadCatalogs(emojiDir);
    emojiLoadedAt = Date.now();
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

  /**
   * preset 必須存在才准建會話。
   * DSH 對未知 preset 可能套用預設值（帶完整本地工具），對 Discord 頻道等於把機器交出去。
   * 所以清單拿不到、或名字不在清單裡，都直接拒絕 —— 寧可回一句安裝提示，也不建一個高權限會話。
   */
  let presetIds = null;
  async function requirePreset(name) {
    if (presetIds === null) {
      const { presets } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      presetIds = (presets ?? []).map((p) => String(p.id));
    }
    const wanted = String(name ?? '').trim();
    if (!presetIds.includes(wanted)) {
      throw new Error(`preset "${wanted}" 不在 DSH 可用清單（${presetIds.join(', ') || '空'}）。請執行 node scripts/setup-dsh.mjs --discord，然後重啟 DSH`);
    }
  }
  const ensurePresetAvailable = () => requirePreset(cfg.discord.agentPreset);

  async function applyModel(sessionId) {
    if (modelApplied.has(sessionId)) return;
    try {
      const value = unwrap(await api.sessions.selectModel({
        sessionId,
        provider: cfg.dsh.provider,
        model: cfg.dsh.model,
        reasoningEffort: cfg.dsh.reasoningEffort,
      }), 'session.selectModel');
      modelApplied.add(sessionId);
      usage.rememberModel(sessionId, value.selected);
      log(`會話 ${sessionId} 模型 → ${value.selected?.provider}/${value.selected?.model}`);
    } catch (error) {
      // 選模型失敗不該讓訊息送不出去；下一則訊息會再試一次。
      log(`設定模型失敗 ${sessionId}：${error?.message ?? error}`);
    }
  }

  const epochOf = (key) => epochs.get(key) ?? 0;

  async function ensureSession(key) {
    const epoch = epochOf(key);
    const existing = sessions[key];
    if (existing) {
      await applyModel(existing);
      return existing;
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);

    const promise = (async () => {
      await ensurePresetAvailable();
      const dir = cfg.discord.sessionDir || path.join(STATE_DIR, 'discord-agents');
      fs.mkdirSync(dir, { recursive: true });
      const workspace = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      if (workspace.created && cfg.discord.workspaceTitle) {
        await api.workspace.rename({ workspaceId: workspace.workspace.workspaceId, title: cfg.discord.workspaceTitle });
      }
      const created = unwrap(await api.sessions.create({
        workspaceId: workspace.workspace.workspaceId,
        agentPreset: cfg.discord.agentPreset,
      }), 'session.create');
      const sessionId = created.sessionId;
      // 建會話期間有人按了 /reset：丟掉這個新會話，不要讓它復活。
      if (epoch !== epochOf(key)) {
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession'); } catch { /* 已經沒了 */ }
        throw new Error('會話建立期間已重置，本次投遞取消');
      }
      // 新版事件流要顯式 follow，否則收不到 turn 事件（也就永遠不會有回覆）。
      api.events.follow(sessionId);
      sessions[key] = sessionId;
      reverse.set(sessionId, key);
      saveSessions(SESSIONS_FILE, sessions);
      await applyModel(sessionId);
      log(`新會話 ${key} → ${sessionId}（preset ${cfg.discord.agentPreset}）`);
      return sessionId;
    })();

    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  async function retireSession(key) {
    stopTyping(key);
    epochs.set(key, epochOf(key) + 1);
    // 還沒送出的那批（含 DSH 斷線時排著的）屬於舊對話，不能進新會話；新會話要重新帶一次頻道上下文。
    batcher.drop(key);
    offlineQueue.delete(key);
    offlineHintAt.delete(key);
    primedKeys.delete(key);
    pendingDirect.delete(key);
    turnDirect.delete(key);
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(key);
      void cancelPendingEntry(entry);
    }
    const sessionId = sessions[key];
    if (!sessionId) return false;

    api.events.forget(sessionId);
    delete sessions[key];
    reverse.delete(sessionId);
    agentSender.forget(sessionId);
    collectors.delete(sessionId);
    modelApplied.delete(sessionId);
    saveSessions(SESSIONS_FILE, sessions);

    // 佇列要清、回合要取消，最後才歸檔（歸檔只是隱藏，不會停掉還在跑的工作）。
    try {
      await withTimeout(api.stopSessionWork(sessionId), 15_000, 'stopSessionWork');
    } catch (error) {
      log(`⚠️ 停止舊會話失敗 ${key}：${error?.message ?? error}`);
    }
    try {
      await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession');
    } catch (error) {
      log(`⚠️ 歸檔舊會話失敗 ${key}：${error?.message ?? error}`);
    }
    log(`已重置會話 ${key}（舊 ${sessionId}）`);
    return true;
  }

  // ── Discord 送出 ─────────────────────────────────────────────────────────

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

  async function sendLong(key, text) {
    const channel = await resolveChannel(key);
    refreshEmojiCatalogs();
    // 模型輸出 `:名稱:`，這裡換成真正的 emoji tag；找不到就保留原文。
    const rendered = substituteEmojiNames(text, { guildId: channel.guildId ?? null, catalogs: emojiCatalogs });
    const parts = splitDiscordMessage(rendered, cfg.discord.maxMessageChars);
    if (parts.length === 0) return;
    for (const part of parts) {
      // parse: [] —— 模型輸出不會意外 @everyone 或 @某人
      await channel.send({ content: part, allowedMentions: { parse: [] } });
      if (cfg.discord.sendDelayMs > 0) await sleep(cfg.discord.sendDelayMs);
    }
  }

  // ── 智能體發送（MCP） ────────────────────────────────────────────────────
  // 模型只能透過 mcp__discord__send_message 說話；令牌、白名單、敏感資訊閘門、
  // 每輪上限都在 createAgentSender 裡（scripts/test-discord-bridge.mjs 有測）。

  function isChannelAllowed(key, channel) {
    const [kind, id] = key.split(':');
    if (kind === 'dm') return isConversationAllowed(cfg.discord, { userId: id });
    return isConversationAllowed(cfg.discord, {
      guildId: channel.guildId,
      channelId: channel.id,
      parentId: channel.isThread?.() ? channel.parentId : null,
      userId: '',
    });
  }

  const agentSender = createAgentSender({
    sessions,
    reverse,
    resolveChannel,
    isAllowed: isChannelAllowed,
    secrets: () => [process.env.DISCORD_TOKEN, cfg.dsh.authToken, consoleTokenValue],
    blockSensitive: () => cfg.discord.security.blockSensitive,
    deliver: sendLong,
  });

  async function agentSend(request) {
    const result = await agentSender.send(request);
    log(`MCP 送出 ${result.key}（${request.content.length} 字）`);
    return result;
  }

  // 同一會話短時間內的訊息合成一批，一批只開一個模型回合。
  const batcher = createBatcher({
    debounceMs: cfg.discord.batch.debounceMs,
    maxWaitMs: cfg.discord.batch.maxWaitMs,
    maxMessages: cfg.discord.batch.maxMessages,
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

  /** 佇列對不上（漏了 turn/start、重連）時的保守預設：私聊與 @ 模式本來就每批都在叫 bot。 */
  const defaultDirect = (key) => key.startsWith('dm:') || requireMentionInGuild();

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

  // ── 提問與審批 ───────────────────────────────────────────────────────────

  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      await api.respond({
        clientId: entry.clientId,
        eventId: entry.eventId,
        outcome: {
          kind: 'result',
          value: entry.kind === 'approval' ? 'rejected' : { answers: [] },
        },
      });
    } catch (error) {
      log(`取消掛起請求失敗：${error?.message ?? error}`);
    }
  }

  function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      void cancelPendingEntry(existing);
    }
    const timer = setTimeout(() => {
      if (pending.get(key) !== entry) return;
      pending.delete(key);
      void cancelPendingEntry(entry);
      sendLong(key, '⏰ 等待回答逾時，已取消這個請求').catch(() => {});
    }, cfg.discord.questionTimeoutMs);
    timer.unref?.();
    entry.timer = timer;
    pending.set(key, entry);
  }

  async function answerPending(p, text, key, isOwner) {
    if (p.kind === 'question') {
      try {
        await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers: questionAnswersFor(p.questions, text) } },
        });
        if (pending.get(key) === p) {
          clearTimeout(p.timer);
          pending.delete(key);
        }
      } catch (error) {
        log(`回答提問失敗（保留掛起以便重試）：${error?.message ?? error}`);
        await sendLong(key, '⚠️ 回答送出失敗，請再回一次。');
      }
      return;
    }

    if (!isOwner) {
      await sendLong(key, '審批只有管理員能決定。');
      return;
    }
    const outcome = parseApprovalAnswer(text);
    if (!outcome) {
      await sendLong(key, '請回覆「通過」或「拒絕」來決定這個審批。');
      return;
    }
    try {
      await api.respond({ clientId: p.clientId, eventId: p.eventId, outcome: { kind: 'result', value: outcome } });
      if (pending.get(key) === p) {
        clearTimeout(p.timer);
        pending.delete(key);
      }
      await sendLong(key, outcome === 'allowed-once' ? '✅ 已通過審批' : '❌ 已拒絕審批');
    } catch (error) {
      log(`送出審批失敗（保留掛起以便重試）：${error?.message ?? error}`);
      await sendLong(key, '⚠️ 審批送出失敗，請再回一次「通過」或「拒絕」。');
    }
  }

  // ── 事件流 ───────────────────────────────────────────────────────────────

  async function handleQuestion(frame) {
    const key = reverse.get(frame.sessionId);
    if (!key) {
      await cancelPendingEntry({ kind: 'question', clientId: frame.clientId, eventId: frame.eventId });
      return;
    }
    const lines = (frame.questions ?? []).map((q, i) => {
      const text = `${i + 1}. ${String(q.question ?? '')}`;
      const options = q.options ?? [];
      return options.length ? `${text}\n   ${options.map((o) => `「${String(o.label ?? '')}」`).join(' ')}` : text;
    });
    registerPending(key, {
      kind: 'question',
      clientId: frame.clientId,
      eventId: frame.eventId,
      questions: frame.questions ?? [],
    });
    // 先掛起再送出：送出失敗時至少還有一條逾時路徑會取消，不會讓 DSH 一直等。
    try {
      // 頻道裡只有叫 bot 的訊息才算回答（見 handleMessage），提示要講清楚，不然答案會被當成閒聊。
      const how = key.startsWith('dm:') ? '直接回覆' : '@我或回覆這則訊息，';
      await sendLong(key, `❓ agent 需要你回答：\n${lines.join('\n')}\n（${how}寫選項文字或你的回答）`);
    } catch (error) {
      log(`送出提問失敗 (${key})：${error?.message ?? error}`);
    }
  }

  async function handleApproval(frame) {
    const key = reverse.get(frame.sessionId);
    if (!key) {
      await cancelPendingEntry({ kind: 'approval', clientId: frame.clientId, eventId: frame.eventId });
      return;
    }
    const reason = String(frame.reason ?? '');
    registerPending(key, { kind: 'approval', clientId: frame.clientId, eventId: frame.eventId });
    try {
      await sendLong(key, `🔐 agent 請求審批：${String(frame.toolName ?? '未知工具')}${reason ? `\n理由：${reason}` : ''}\n回覆「通過」或「拒絕」`);
    } catch (error) {
      log(`送出審批請求失敗 (${key})：${error?.message ?? error}`);
    }
  }

  async function handleSessionEvent(frame) {
    const event = frame.event;
    if (!event?.type) return;

    // 先記帳再分流：學習會話也要算錢，只是在控制台歸到 internal，不送回 Discord。
    usage.ingestEvent(frame.sessionId, event);

    // 學習會話：不在 reverse 裡，只收文字，不送 Discord。
    const learner = learnerWaiters.get(frame.sessionId);
    if (learner) {
      const turn = event.data?.turn;
      if (!learner.started && event.type === 'assistant/message' && turn !== undefined && turn !== null) {
        learner.started = true;
        learner.collector.push({ type: 'turn/start', data: { turn } });
      }
      if (event.type === 'turn/start') learner.started = true;
      const endedLearning = learner.collector.push(event);
      if (endedLearning) learner.finish(endedLearning);
      return;
    }

    const key = reverse.get(frame.sessionId);
    if (!key) return;

    // 新的一輪開始：清掉上一輪的發送紀錄。
    if (event.type === 'turn/start') agentSender.startTurn(key);
    // 只用來分辨日誌：模型是「試過但失敗」（令牌過期、權限不足）還是根本沒呼叫。
    if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? event.data?.toolName ?? '');
      if (name === 'mcp__discord__send_message') agentSender.noteAttempt(key);
    }

    let collector = collectors.get(frame.sessionId);
    // 事件流接得太晚時，真正的 turn/start 會漏掉（follow 還在排隊、prompt 已經開跑）。
    // assistant/message 帶的是完整正文，所以用它補一個合成的起點；沒有這一步，
    // 該回合的 turn/end 會被當成「沒有對應 turn/start」而整段丟掉，使用者什麼都收不到。
    const turn = event.data?.turn;
    const missedStart = event.type === 'assistant/message' && turn !== undefined && turn !== null;
    if (!collector && (event.type === 'turn/start' || missedStart)) {
      collector = createTurnCollector();
      if (missedStart) collector.push({ type: 'turn/start', data: { turn } });
      collectors.set(frame.sessionId, collector);
      const queued = pendingDirect.get(key);
      turnDirect.set(key, queued?.length ? queued.shift() : defaultDirect(key));
    }
    const ended = collector ? collector.push(event) : null;
    if (!ended) {
      // 佇列裡的下一回合開始：第一回合結束時輸入提示已停掉，這裡要重新亮起來。
      // 沒人叫 bot 的那批不亮：模型多半不會說話，亮了反而像打字打到一半消失。
      if (event.type === 'turn/start' && turnDirect.get(key)) {
        resolveChannel(key).then((channel) => startTyping(key, channel)).catch(() => {});
      }
      // 沒有對應 turn/start 的 turn/end（重連後補發）只需清掉殘留，不能當成新回覆。
      if (event.type === 'turn/end') collectors.delete(frame.sessionId);
      return;
    }
    collectors.delete(frame.sessionId);
    stopTyping(key);
    lastActive.set(key, Date.now());
    const direct = turnDirect.get(key) ?? defaultDirect(key);
    turnDirect.delete(key);

    const reason = ended.reason ?? {};
    if (reason.kind === 'completed') {
      const { sent, attempted } = agentSender.finishTurn(key);
      if (sent > 0) return;
      // 沒有呼叫工具就真的不送。回合文字可能只是思考，不是要發出去的內容，
      // 所以這裡不代送；只留一行日誌方便追「模型忘了用工具」。
      const text = String(ended.text ?? '').trim();
      log(`回合完成但沒有呼叫發送工具（${key}${attempted ? '，工具呼叫失敗' : ''}）${text ? `：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` : ''}`);
      return;
    }
    if (reason.kind === 'error') {
      const message = String(reason.error?.message ?? '未知錯誤').slice(0, 500);
      log(`agent 出錯 (${key})：${message}`);
      // 沒人叫 bot 的那批出錯只記日誌：頻道裡沒人在等回覆，貼錯誤只會吵到人。
      if (direct) await sendLong(key, `⚠️ agent 處理出錯：${message}`);
      return;
    }
    if (reason.kind === 'aborted' && direct) await sendLong(key, '⏹️ 已停止');
  }

  async function handleFrame(frame) {
    switch (frame?.type) {
      case 'session/event':
        await handleSessionEvent(frame);
        break;
      case 'session/snapshot':
        // 開場快照帶整條會話的 tokenUsage 累計與最近事件；只進帳本，不當成新回合。
        usage.ingestSnapshot(frame.sessionId, frame.snapshot);
        break;
      case 'question/requested':
        await handleQuestion(frame);
        break;
      case 'approval/requested':
        await handleApproval(frame);
        break;
      case 'stream/error':
        log(`事件流錯誤：${frame.error?.code ?? '未知'}`);
        break;
      default:
        // session/snapshot 帶的是歷史事件，絕不能當成新回合去回覆。
        break;
    }
  }

  async function pumpEvents() {
    let retryMs = 3_000;
    for (;;) {
      let frames = 0;
      try {
        log('連線 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          frames += 1;
          lastFrameAt = Date.now();
          try {
            await handleFrame(envelope.payload);
          } catch (error) {
            log(`處理事件失敗：${error?.message ?? error}`);
          }
        }
        log(`DSH 事件流結束（本次 ${frames} 幀）`);
      } catch (error) {
        log(`DSH 事件流中斷：${error?.message ?? error}`);
      } finally {
        // 斷線後舊的 collector 不可信：重連快照會補歷史 turn/end，拿它當新回覆會重複發送。
        collectors.clear();
        agentSender.clearTurns();
        // 回合 ↔ 批次的對應也不可信了；之後的回合退回 defaultDirect。
        pendingDirect.clear();
        turnDirect.clear();
        for (const key of [...typingTimers.keys()]) stopTyping(key);
        // 學習會話也一樣：事件流斷了就不會再有回合結束，直接失敗（下次冷卻後再學）。
        for (const waiter of [...learnerWaiters.values()]) {
          waiter.fail(new Error('DSH 事件流中斷，學習回合取消'));
        }
      }
      retryMs = frames > 0 ? 3_000 : Math.min(30_000, retryMs * 2);
      await sleep(retryMs);
    }
  }

  // ── 訊息入口 ─────────────────────────────────────────────────────────────

  function scheduleOfflineFlush() {
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      void flushOffline();
    }, cfg.discord.queue.retryMs);
    offlineTimer.unref?.();
  }

  function enqueueOffline(key, job) {
    const items = offlineQueue.get(key) ?? [];
    if (items.length >= cfg.discord.queue.max) {
      items.shift();
      log(`離線佇列已滿（${cfg.discord.queue.max}），丟棄最舊一則 (${key})`);
    }
    items.push(job);
    offlineQueue.set(key, items);
    log(`DSH 暫時不可用，訊息排隊 (${key})：${items.length} 條`);
    const now = Date.now();
    // 沒人叫 bot 的那批不提示：自由參與時，那等於對著整個頻道廣播系統狀態。
    if (job.direct && (offlineHintAt.get(key) ?? 0) + 60_000 < now) {
      offlineHintAt.set(key, now);
      void sendLong(key, '⏳ 系統服務暫時不可用，訊息已排隊，恢復後會自動送出。').catch(() => {});
    }
    scheduleOfflineFlush();
  }

  async function flushOffline() {
    if (offlineFlushing || offlineQueue.size === 0) return;
    offlineFlushing = true;
    try {
      // 先用一個便宜的一元 RPC 探活；通了才把整批丟回去。
      await api.callUnary('settings/describe', {});
    } catch {
      scheduleOfflineFlush();
      return;
    } finally {
      offlineFlushing = false;
    }
    const pending = [...offlineQueue.entries()];
    offlineQueue.clear();
    let count = 0;
    for (const [key, jobs] of pending) {
      for (const job of jobs) {
        count += 1;
        enqueuePrompt(key, job);
      }
    }
    log(`DSH 恢復，重新投遞 ${count} 條排隊訊息`);
  }

  function enqueuePrompt(key, job) {
    const previous = promptChains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => deliverPrompt(key, job))
      .catch(async (error) => {
        stopTyping(key);
        if (isTransientDshError(error)) {
          enqueueOffline(key, job);
          return;
        }
        log(`投遞失敗 (${key})：${error?.message ?? error}`);
        if (job.direct) await sendLong(key, `⚠️ 無法送出給 DSH：${error?.message ?? error}`).catch(() => {});
      });
    promptChains.set(key, next);
    const cleanup = () => { if (promptChains.get(key) === next) promptChains.delete(key); };
    next.then(cleanup, cleanup);
  }

  // 沒開 Message Content 意圖時，Discord 只會把 @bot 的訊息內容送來，所以強制走 @ 模式。
  const requireMentionInGuild = () => cfg.discord.requireMentionInGuild || !cfg.discord.messageContentIntent;

  /**
   * 一批訊息 → prompt 文字與圖片。附件、引用、上下文都在投遞時才抓：
   * 這樣排在同一條佇列裡，順序不會亂；任何一項失敗只略過那一項。
   */
  async function buildBatchPrompt(key, job) {
    const guild = Boolean(job.guildId);
    const entries = [];
    const images = [];
    const skipped = [];
    for (const entry of job.entries) {
      skipped.push(...(entry.media?.skipped ?? []));
      const imageTags = [];
      for (const item of entry.media?.accepted ?? []) {
        if (images.length >= cfg.discord.media.maxCount) {
          skipped.push({ name: item.name, reason: `一批最多 ${cfg.discord.media.maxCount} 張` });
          continue;
        }
        try {
          const buffer = await fetchDiscordImage(item.url, cfg.discord.media);
          const prepared = await prepareImageBlock(buffer, item.name, cfg.discord.media);
          if (prepared.block) {
            images.push(prepared.block);
            imageTags.push(`[圖${images.length}]`);
            if (prepared.note) log(`圖片 ${item.name}：${prepared.note}`);
          } else {
            skipped.push({ name: item.name, reason: prepared.error });
          }
        } catch (error) {
          skipped.push({ name: item.name, reason: error?.message ?? String(error) });
        }
      }
      // 引用只抓叫 bot 的訊息：自由參與時每則都抓，會被 Discord 的 rate limit 卡住。
      let quote = '';
      if (entry.direct && entry.message?.reference?.messageId) {
        try {
          const referenced = await entry.message.fetchReference();
          quote = formatQuote({
            author: referenced.member?.displayName ?? referenced.author?.displayName ?? referenced.author?.username,
            content: referenced.content,
            hasImage: referenced.attachments?.size > 0,
          });
        } catch (error) {
          log(`讀取引用訊息失敗：${error?.message ?? error}`);
        }
      }
      entries.push({
        author: entry.author,
        text: entry.text,
        direct: entry.direct,
        isOwner: entry.isOwner,
        quote,
        imageTags,
        hasImage: entry.hasImage,
      });
    }
    if (images.length > 0) log(`附加 ${images.length} 張圖 (${key})`);

    // 頻道上下文：預設模式每批都帶（模型看不到沒叫它的訊息）；自由參與只在會話的第一批帶，
    // 之後每一則都已經進過會話，再帶只是重複燒 token。
    let context = '';
    const wantContext = guild && cfg.discord.context.enabled && cfg.discord.context.messages > 0
      && (requireMentionInGuild() || !primedKeys.has(key));
    if (wantContext) {
      try {
        // 從最後一則往前抓，再扣掉批次自己的訊息：@ 模式下兩則 @ 之間的閒聊也要看得到。
        const batchIds = new Set(job.entries.map((entry) => entry.id));
        const fetched = await job.channel.messages.fetch({
          limit: Math.min(100, cfg.discord.context.messages + job.entries.length),
          before: job.entries.at(-1).id,
        });
        const history = [...fetched.values()].filter((entry) => !batchIds.has(entry.id));
        // 抓回來的歷史訊息也餵進黑話語料（去重靠 message.id）。
        for (const entry of history) {
          if (!entry.author?.bot && entry.content) collectSlangSample(entry, entry.content, job.channel);
        }
        context = formatRecentContext(
          history.reverse().map((entry) => ({
            author: entry.member?.displayName ?? entry.author?.displayName ?? entry.author?.username,
            content: entry.content,
            bot: entry.author?.id === client.user.id,
            hasImage: entry.attachments?.size > 0,
          })),
          cfg.discord.context,
        );
      } catch (error) {
        log(`讀取頻道上下文失敗：${error?.message ?? error}`);
      }
    }

    // 跨頻道記憶：只帶這一批裡叫 bot 的人，最多 3 位，避免一批人多時記憶區塊爆長。
    let memory = '';
    if (cfg.discord.memory.enabled && guild) {
      const seen = new Set();
      const blocks = [];
      for (const entry of job.entries) {
        if (!entry.direct || seen.has(entry.userId) || seen.size >= 3) continue;
        seen.add(entry.userId);
        const block = formatUserMemory(memoryStore, {
          guildId: job.guildId,
          userId: entry.userId,
          currentChannelId: job.channel.id,
          currentNsfw: channelIsNsfw(job.channel),
          maxMessages: cfg.discord.memory.injectMessages,
          maxChars: cfg.discord.memory.maxChars,
          ttlDays: cfg.discord.memory.ttlDays,
        });
        if (block) blocks.push(block);
      }
      memory = blocks.join('\n');
    }

    // 表情候選：只給 top N（每伺服器目錄，關鍵字比對；模型用 :名稱: 表示）。
    let emojiHint = '';
    if (cfg.discord.emoji.enabled && guild) {
      refreshEmojiCatalogs();
      emojiHint = formatEmojiHint(retrieveEmojis(emojiCatalogs, {
        guildId: job.guildId,
        text: `${job.entries.map((entry) => entry.text).join('\n')}\n${context}`,
        k: cfg.discord.emoji.maxCandidates,
        maxChars: cfg.discord.emoji.maxChars,
      }));
    }

    // 已確認的黑話：只有管理員在控制台按過「確認」的才會進來。
    let slangHint = '';
    if (cfg.discord.slang.enabled && guild) {
      slangHint = buildSlangHint(slangStore, {
        guildId: job.guildId,
        max: cfg.discord.slang.injectMax,
        maxChars: cfg.discord.slang.maxChars,
      });
    }

    const batch = formatBatch(entries, { guild }) + describeSkipped(skipped);
    const time = formatTimeContext({ messageAt: job.entries[0].at });
    return {
      text: [context, slangHint, memory, emojiHint, batch, time].filter(Boolean).join('\n'),
      images,
    };
  }

  async function deliverPrompt(key, job) {
    const { epoch } = job;
    if (epoch !== epochOf(key)) {
      log(`排隊期間會話已重置，丟棄 (${key})`);
      return;
    }
    const sessionId = await ensureSession(key);
    if (epoch !== epochOf(key)) {
      log(`投遞前會話已重置，丟棄 (${key})`);
      return;
    }
    if (job.direct) startTyping(key, job.channel);

    const prompt = await buildBatchPrompt(key, job);
    if (epoch !== epochOf(key)) {
      log(`整理批次期間會話已重置，丟棄 (${key})`);
      return;
    }

    // 發送提示每輪都給：令牌是模型呼叫 send_message 的唯一依據，壓縮過上下文之後也不能忘。
    const sendHint = `【發送】token=${agentSender.tokenFor(sessionId)}；要說話就呼叫 mcp__discord__send_message（token 照抄，content 放你要說的內容）。不呼叫就是這次不說話；直接輸出文字不會送出。`;
    const text = `${prompt.text}\n${sendHint}`;
    // 先排進去：這一批的 turn/start 可能比 prompt 的回應更早到。沒產生回合時再拿掉。
    const queued = pendingDirect.get(key) ?? [];
    queued.push(job.direct);
    pendingDirect.set(key, queued);
    const unqueue = () => {
      const index = queued.lastIndexOf(job.direct);
      if (index >= 0) queued.splice(index, 1);
    };
    let accepted;
    try {
      accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }, ...prompt.images],
      });
    } catch (error) {
      unqueue();
      throw error;
    }
    if (!accepted.result?.ok) {
      unqueue();
      stopTyping(key);
      const error = accepted.result?.error;
      throw new Error(`${error?.code ?? '未知錯誤'}${error?.message ? `：${error.message}` : ''}`);
    }
    primedKeys.add(key);
    // DSH 的斜線命令會直接回結果，不經過模型、也不會產生回合。
    const command = accepted.result.value?.command;
    if (command) {
      unqueue();
      stopTyping(key);
      if (command.text) await sendLong(key, command.text);
      return;
    }
    if (job.direct && cfg.discord.ackMessage) await sendLong(key, cfg.discord.ackMessage);
    log(`已投遞 ${key}（${job.entries.length} 則${job.direct ? '，有人叫 bot' : ''}）`);
  }

  async function maybeReact(message, key, text) {
    const conf = cfg.discord.reactions;
    if (!conf.enabled || !message.guildId) return false;
    if (/^[!/]/.test(text)) return false;

    const now = Date.now();
    if ((reactionLastAt.get(key) ?? 0) + conf.cooldownMs > now) return false;
    while (reactionTimes.length > 0 && now - reactionTimes[0] > 3_600_000) reactionTimes.shift();
    if (reactionTimes.length >= conf.maxPerHour) return false;

    refreshEmojiCatalogs();
    const candidates = retrieveEmojis(emojiCatalogs, { guildId: message.guildId, text, k: 5, maxChars: 600 });
    const best = candidates
      .filter((entry) => (entry.keywordScore ?? 0) >= conf.minKeywordScore)
      .sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0))[0];
    if (!best) return false;
    if (Math.random() > conf.probability) return false;

    try {
      await message.react(`<${best.animated ? 'a' : ''}:${best.name}:${best.id}>`);
      reactionTimes.push(now);
      reactionLastAt.set(key, now);
      log(`加了 reaction ${best.name}（${key}，score ${best.keywordScore}）`);
      return true;
    } catch (error) {
      // 最常見：bot 沒有 Add Reactions 權限（或頻道權限覆蓋）。
      log(`reaction 失敗（${key}）：${error?.message ?? error}`);
      return false;
    }
  }

  /** 這個頻道的訊息能不能帶到其他頻道：只分享 @everyone 看得到的公開頻道。 */
  function canShareChannel(channel) {
    if (!channel) return false;
    if (channel.isThread?.() && channel.type === ChannelType.PrivateThread) return false;
    const target = channel.isThread?.() ? channel.parent : channel;
    const everyone = target?.guild?.roles?.everyone;
    if (!everyone || typeof target.permissionsFor !== 'function') return false;
    try {
      return target.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) === true;
    } catch {
      return false;
    }
  }

  /** 頻道或母頻道是不是 NSFW。 */
  function channelIsNsfw(channel) {
    if (!channel) return false;
    if (channel.nsfw === true) return true;
    return channel.isThread?.() ? channel.parent?.nsfw === true : false;
  }

  /** 顯示用的頻道名；討論串用討論串名稱。 */
  function channelLabel(message) {
    return message.channel?.name
      || (message.channel?.isThread?.() ? message.channel.parent?.name : '')
      || message.channelId;
  }

  // ── 黑話學習 ─────────────────────────────────────────────────────────────

  function localDayKey(now = Date.now()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function takeSlangSlot() {
    const day = localDayKey();
    if (day !== slangDayKey) { slangDayKey = day; slangDayCount = 0; }
    if (slangDayCount >= cfg.discord.slang.maxPerDay) return false;
    slangDayCount += 1;
    return true;
  }

  function scheduleSlangTimer(ms) {
    if (slangTimer) return;
    slangTimer = setTimeout(() => {
      slangTimer = null;
      void drainSlangQueue();
    }, Math.max(1000, ms));
    slangTimer.unref?.();
  }

  /**
   * 收集一則語料。只收允許的公開頻道；私密討論串、NSFW、指令、機器人都不收。
   * `channelOverride` 給「抓回來的歷史訊息」用（那些 message.channel 可能是 undefined）。
   */
  function collectSlangSample(message, text, channelOverride = null) {
    if (!cfg.discord.slang.enabled || !message?.guildId) return;
    const value = String(text ?? '').trim();
    if (!value || /^[!/]/.test(value)) return;
    // 含本機路徑／憑證特徵的訊息不送進學習會話（也沒有必要學）。
    if (findSensitive(value)) return;
    const channel = channelOverride ?? message.channel;
    if (!canShareChannel(channel) || channelIsNsfw(channel)) return;

    const channelId = String(message.channelId);
    const window = slangWindows.get(channelId) ?? [];
    if (window.some((sample) => sample.id === message.id)) return;
    window.push({
      id: message.id,
      channelId,
      userId: message.author?.id ?? '',
      author: message.member?.displayName ?? message.author?.displayName ?? message.author?.username ?? '',
      text: truncateText(value, 300),
      at: Number(message.createdTimestamp) || Date.now(),
    });
    if (window.length > SLANG_WINDOW_MAX) window.splice(0, window.length - SLANG_WINDOW_MAX);
    slangWindows.set(channelId, window);

    if (window.length >= cfg.discord.slang.extractMinMessages) {
      scheduleSlangExtraction(message.guildId, channelId);
    }
  }

  function scheduleSlangExtraction(guildId, channelId) {
    if (!cfg.discord.slang.enabled) return;
    if (slangQueued.has(channelId)) return;
    slangQueued.add(channelId);
    slangQueue.push({ guildId: String(guildId), channelId: String(channelId) });
    void drainSlangQueue();
  }

  /** 學習會話：建一個獨立 session、只收文字、結束就歸檔（不進 reverse，不會送回 Discord）。 */
  async function runSlangExtraction(samples) {
    const conf = cfg.discord.slang;
    await requirePreset(conf.learnerPreset);

    if (!slangWorkspaceId) {
      const dir = cfg.discord.sessionDir || path.join(STATE_DIR, 'discord-agents');
      fs.mkdirSync(dir, { recursive: true });
      const workspace = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      slangWorkspaceId = workspace.workspace.workspaceId;
    }
    const created = unwrap(await api.sessions.create({
      workspaceId: slangWorkspaceId,
      agentPreset: conf.learnerPreset,
    }), 'session.create');
    const sessionId = created.sessionId;
    rememberLearnerSession(sessionId);

    try {
      // 抽取不需要深度推理；模型不支援 low 時沿用預設，不讓整個學習失敗。
      try {
        unwrap(await api.sessions.selectModel({
          sessionId,
          provider: cfg.dsh.provider,
          model: cfg.dsh.model,
          reasoningEffort: 'low',
        }), 'session.selectModel');
      } catch (error) {
        log(`黑話學習：選模型失敗（沿用預設）：${error?.message ?? error}`);
      }
      api.events.follow(sessionId);

      const collector = createTurnCollector();
      let settled = false;
      let timer = null;
      const ended = new Promise((resolve, reject) => {
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          learnerWaiters.delete(sessionId);
          fn(value);
        };
        timer = setTimeout(() => settle(reject, new Error('學習回合逾時')), conf.timeoutMs);
        timer.unref?.();
        learnerWaiters.set(sessionId, {
          collector,
          started: false,
          finish: (result) => settle(resolve, result),
          fail: (error) => settle(reject, error),
        });
      });
      // 真正的等待在下面；先掛一個 handler，避免收尾時變成 unhandledRejection。
      ended.catch(() => {});

      const accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildExtractionPrompt(samples) }],
      });
      if (!accepted.result?.ok) {
        const error = accepted.result?.error;
        throw new Error(`${error?.code ?? '未知錯誤'}${error?.message ? `：${error.message}` : ''}`);
      }
      const result = await ended;
      if (result.reason?.kind !== 'completed') {
        throw new Error(`學習回合結束於 ${result.reason?.kind ?? 'unknown'}`);
      }
      return parseExtractionJson(result.text, { max: 5 });
    } finally {
      learnerWaiters.get(sessionId)?.fail(new Error('學習回合收尾'));
      try { await withTimeout(api.stopSessionWork(sessionId), 15_000, 'stopSessionWork'); } catch { /* 已結束 */ }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), 15_000, 'archiveSession'); } catch { /* 已歸檔 */ }
    }
  }

  async function drainSlangQueue() {
    if (slangRunning || slangQueue.length === 0) return;
    slangRunning = true;
    try {
      while (slangQueue.length > 0) {
        const conf = cfg.discord.slang;
        const wait = slangLastRunAt + conf.extractCooldownMs - Date.now();
        if (wait > 0) {
          scheduleSlangTimer(wait);
          return;
        }
        const job = slangQueue[0];
        const window = slangWindows.get(job.channelId) ?? [];
        if (window.length < conf.extractMinMessages) {
          slangQueue.shift();
          slangQueued.delete(job.channelId);
          continue;
        }
        if (!takeSlangSlot()) {
          slangQueue.length = 0;
          slangQueued.clear();
          log('黑話學習已達每日上限，今天不再抽取');
          return;
        }
        slangQueue.shift();
        slangQueued.delete(job.channelId);

        const samples = window.slice(-Math.max(conf.extractMinMessages, 40));
        let items;
        try {
          items = await runSlangExtraction(samples);
        } catch (error) {
          // 失敗也吃冷卻：避免 DSH 出問題時每則訊息都重試、燒 token。
          slangLastRunAt = Date.now();
          log(`黑話學習失敗（${job.channelId}）：${error?.message ?? error}`);
          continue;
        }
        slangLastRunAt = Date.now();

        const stats = upsertCandidates(slangStore, { guildId: job.guildId, items, samples });
        const processed = new Set(samples.map((sample) => sample.id));
        const rest = (slangWindows.get(job.channelId) ?? []).filter((sample) => !processed.has(sample.id));
        if (rest.length > 0) slangWindows.set(job.channelId, rest);
        else slangWindows.delete(job.channelId);

        if (stats.added > 0 || stats.updated > 0) {
          markSlangDirty();
          log(`黑話學習：新增 ${stats.added}、更新 ${stats.updated}（${job.channelId}）`);
        } else {
          log(`黑話學習：這次沒有新詞（${job.channelId}）`);
        }
      }
    } finally {
      slangRunning = false;
    }
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
    if (!isConversationAllowed(cfg.discord, ids)) return;
    const key = conversationKeyFor(ids);

    const mentioned = message.mentions?.users ? [...message.mentions.users.keys()] : [];
    const repliedUserId = message.mentions?.repliedUser?.id ?? null;
    const text = stripBotMention(message.content, client.user.id);
    // 有沒有在叫 bot：私聊一律算；頻道看 @ 或回覆。自由參與時沒叫 bot 的訊息也會進批次，
    // 但指令、提問回答、跨頻道記憶都只認叫 bot 的訊息。
    const direct = !guildId
      || shouldHandleGuildMessage({ mentionedUserIds: mentioned, repliedUserId }, client.user.id, true);

    // 黑話語料：所有允許的公開頻道訊息都收（含沒叫 bot 的），才有足夠樣本。
    if (text) collectSlangSample(message, text);

    if (!direct) {
      // 沒叫 bot：偶爾留一個 reaction。預設模式到此為止；自由參與才送進批次讓模型決定。
      if (text) await maybeReact(message, key, text).catch((error) => log(`表情反應失敗：${error?.message ?? error}`));
      if (requireMentionInGuild()) return;
    }

    const media = cfg.discord.media.enabled
      ? collectImageAttachments(message.attachments, cfg.discord.media)
      : { accepted: [], skipped: [] };
    if (!text && media.accepted.length === 0) {
      if (direct && message.attachments?.size) {
        const reason = media.skipped[0]?.reason ?? '附件沒有送進模型';
        await sendLong(key, `附件沒有送進模型：${reason}`);
      }
      return;
    }

    const isOwner = ownerIds.has(message.author.id);
    const author = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    log(`收到 ${key}${guildId ? ` guild=${guildId}` : ''} user=${message.author.id}${direct ? '' : '（沒叫 bot）'}`);

    if (direct) {
      // 橋接指令同時接受 `/` 與 `!`：Discord 客戶端對未註冊的 `/xxx` 會叫出指令選單，
      // 有時根本送不出去；`!reset` 一定送得到。
      const command = /^[!/]/.test(text) ? text.slice(1).trim().toLowerCase() : null;
      if (command === 'forget') {
        if (!guildId) { await sendLong(key, '私聊沒有跨頻道記憶。'); return; }
        const removed = forgetUser(memoryStore, { guildId, userId: message.author.id });
        if (removed) markMemoryDirty();
        await sendLong(key, removed
          ? '已刪除你在這個伺服器的跨頻道記憶（目前頻道的對話上下文不受影響）。'
          : '我這邊沒有你的記憶。');
        return;
      }
      if (command === 'reset' || command === 'new') {
        if (!isOwner) { await sendLong(key, '管理指令僅管理員可用。'); return; }
        if (!(await retireSession(key))) { await sendLong(key, '目前沒有可重置的會話（下一則訊息會開新的）。'); return; }
        await sendLong(key, '已重置會話，下一則訊息會開新上下文。');
        return;
      }
      if (command === 'status') {
        if (!isOwner) { await sendLong(key, '管理指令僅管理員可用。'); return; }
        await sendLong(key, `會話 ${sessions[key] ?? '未建立'}｜preset ${cfg.discord.agentPreset}｜${guildId ? '頻道' : '私聊'}`);
        return;
      }

      const hanging = pending.get(key);
      if (hanging) {
        if (hanging.kind === 'question') {
          await answerPending(hanging, text, key, isOwner);
          return;
        }
        // 審批只有管理員能回；其他人這則訊息照常聊天，不因為「審批掛著」被吃掉。
        if (isOwner) {
          await answerPending(hanging, text, key, isOwner);
          return;
        }
      }

      // 非管理員的斜線指令一律擋掉，不送進模型（模型會把它當一般文字回答）。
      if (text.startsWith('/') && !isOwner) {
        await sendLong(key, '管理指令僅管理員可用。');
        return;
      }

      // 跨頻道記憶：只記有叫 bot 的公開頻道訊息；私聊與私密頻道不記。
      if (cfg.discord.memory.enabled && guildId && text && canShareChannel(message.channel)) {
        const stored = recordUserMessage(memoryStore, {
          guildId,
          userId: message.author.id,
          name: author,
          channelId: message.channelId,
          channelName: channelLabel(message),
          text,
          at: message.createdTimestamp,
          nsfw: channelIsNsfw(message.channel),
        }, { ...cfg.discord.memory, maxUsers: 200 });
        if (stored) markMemoryDirty();
      }
    }

    batcher.add(key, {
      id: message.id,
      message,
      channel: message.channel,
      guildId,
      userId: message.author.id,
      author,
      text,
      direct,
      isOwner,
      media,
      hasImage: (message.attachments?.size ?? 0) > 0,
      at: message.createdTimestamp,
    });
    lastActive.set(key, Date.now());
  }

  async function handleSlashCommand(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: '這個指令只能在伺服器頻道使用。', flags: MessageFlags.Ephemeral });
      return;
    }
    // 刪記憶是自己的事，不需要管理員權限。
    if (interaction.commandName === 'forget') {
      const removed = forgetUser(memoryStore, { guildId: interaction.guildId, userId: interaction.user.id });
      if (removed) markMemoryDirty();
      await interaction.reply({
        content: removed
          ? '已刪除你在這個伺服器的跨頻道記憶（目前頻道的對話上下文不受影響）。'
          : '這個伺服器沒有你的記憶。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 選單用 default_member_permissions: Administrator，只是讓一般成員看不到（Discord 沒辦法
    // 只開給某一個人）。真正能執行的只有 ownerIds：伺服器管理員看得到選單，不代表能重置會話。
    if (!ownerIds.has(interaction.user.id)) {
      await interaction.reply({ content: '這個指令只有 bot 擁有者能用。', flags: MessageFlags.Ephemeral });
      return;
    }

    const key = conversationKeyFor({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    log(`slash /${interaction.commandName} ${key} user=${interaction.user.id}`);

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
    if (interaction.commandName === 'reset') {
      const done = await retireSession(key);
      await interaction.editReply(done
        ? '已重置會話，下一則訊息會開新上下文。'
        : '目前沒有可重置的會話（下一則訊息會開新的）。');
      return;
    }
    if (interaction.commandName === 'status') {
      await interaction.editReply(`會話 ${sessions[key] ?? '未建立'}｜preset ${cfg.discord.agentPreset}｜頻道`);
      return;
    }
    if (interaction.commandName === 'mention') {
      // 沒開意圖時跟控制台一樣不寫入：寫了 false，日後開意圖重啟就會突然變自由參與。
      const required = cfg.discord.messageContentIntent ? interaction.options.getBoolean('required') : null;
      if (required !== null) {
        try {
          await updateConfig({ requireMentionInGuild: required });
        } catch (error) {
          await interaction.editReply(`切換失敗：${error?.message ?? error}`);
          return;
        }
      }
      const mode = requireMentionInGuild() ? '頻道要 @bot 或回覆 bot 才回' : '自由參與（模型自己決定要不要接話）';
      const forced = !cfg.discord.messageContentIntent
        ? '\n沒開 Message Content 意圖，收不到沒 @bot 的訊息內容，所以一律要 @bot。'
        : '';
      await interaction.editReply(`${required === null ? '目前' : '已切換成'}：${mode}。這個設定所有伺服器共用。${forced}`);
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

  // ── 啟動 ─────────────────────────────────────────────────────────────────

  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];
  if (cfg.discord.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
  // Partials.Channel：私聊頻道預設不在快取裡，少了它收不到未快取對象的私聊。
  const client = new Client({ intents, partials: [Partials.Channel] });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((error) => log(`處理訊息失敗：${error?.stack ?? error}`));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    handleSlashCommand(interaction).catch((error) => log(`slash command 失敗：${error?.stack ?? error}`));
  });
  // 表情變動 → 15 秒去抖後重掃（hash 快取只會索引新的/換圖的）。
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

  client.once(Events.ClientReady, (ready) => {
    log(`已登入：${ready.user.tag}（${ready.user.id}）`);
    if (ownerIds.size === 0) log('⚠️ 沒有設定 discord.ownerIds：/reset、/status、工具審批都會不可用');
    const noGuildRules = cfg.discord.allow.guilds.length === 0 && cfg.discord.allow.channels.length === 0;
    if (noGuildRules && !cfg.discord.allowAllWhenEmpty) log('⚠️ 頻道白名單為空：只會回應 allow.users 裡的私聊');
    if (!cfg.discord.messageContentIntent) log('ℹ️ 未申請 Message Content 意圖：頻道裡只會處理 @bot 的訊息');
    void registerSlashCommands();
  });

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

  // ── 智能體發送 API（MCP） ────────────────────────────────────────────────
  // 只綁 127.0.0.1 的隨機埠，端點寫在 state/discord-agent.json 給 MCP server 讀。
  // 啟動失敗就讓它失敗：沒有發送端點，模型就完全無法回話，比直接掛掉更難查。
  agentApiHandle = await startAgentApi({ file: AGENT_ENDPOINT_FILE, send: agentSend, log });
  log('模型發訊息：mcp__discord__send_message（DSH 要掛 mcp-discord）');

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
      requireMentionInGuild: cfg.discord.requireMentionInGuild,
      // 唯讀：改這些要重啟橋接或重生 preset
      messageContentIntent: cfg.discord.messageContentIntent,
      agentPreset: cfg.discord.agentPreset,
      provider: cfg.dsh.provider,
      model: cfg.dsh.model,
      console: { host: cfg.discord.console.host, port: cfg.discord.console.port },
    };
  }

  async function updateConfig(patch) {
    // 只接受白名單、黑名單、ownerIds、media、requireMentionInGuild；其餘欄位一律沿用目前值。
    // 整份候選設定都過一次 normalizeDiscordConfig：ID 格式、數字範圍都在那裡擋。
    const next = normalizeDiscordConfig({
      ...cfg.discord,
      allow: patch?.allow ?? cfg.discord.allow,
      deny: patch?.deny ?? cfg.discord.deny,
      ownerIds: patch?.ownerIds ?? cfg.discord.ownerIds,
      // media 逐欄合併：表單只送數字欄位，不要把 enabled 之類的開關蓋回預設值。
      media: { ...cfg.discord.media, ...(patch?.media ?? {}) },
      // 只認真的 boolean：normalize 用 `!== false`，字串 "false" 會被當成 true。
      requireMentionInGuild: typeof patch?.requireMentionInGuild === 'boolean'
        ? patch.requireMentionInGuild
        : cfg.discord.requireMentionInGuild,
    });

    // 切到自由參與：讓每個頻道下一批重新帶一次上下文，@ 模式期間沒叫 bot 的閒聊，模型沒看過。
    if (cfg.discord.requireMentionInGuild && !next.requireMentionInGuild) primedKeys.clear();
    cfg.discord.allow = next.allow;
    cfg.discord.deny = next.deny;
    cfg.discord.ownerIds = next.ownerIds;
    cfg.discord.media = next.media;
    cfg.discord.requireMentionInGuild = next.requireMentionInGuild;
    ownerIds.clear();
    for (const id of next.ownerIds) ownerIds.add(id);

    const doc = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    doc.discord = {
      ...(doc.discord ?? {}),
      allow: next.allow,
      deny: next.deny,
      ownerIds: next.ownerIds,
      media: next.media,
      requireMentionInGuild: next.requireMentionInGuild,
    };
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
    log(`更新設定：allow ${next.allow.guilds.length}/${next.allow.channels.length}/${next.allow.users.length}，ownerIds ${next.ownerIds.length}，${requireMentionInGuild() ? '頻道要 @bot' : '自由參與'}`);
    return editableConfig();
  }

  const sessionsInfo = () => Object.entries(sessions)
    .map(([key, sessionId]) => ({
      key,
      sessionId,
      kind: key.startsWith('dm:') ? 'dm' : 'channel',
      lastActive: lastActive.get(key) ?? null,
      pending: pending.get(key)?.kind ?? null,
    }))
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));

  let consoleHandle = null;
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
              lastFrameAt: lastFrameAt || null,
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
            emoji: {
              guilds: emojiCatalogs.size,
              entries: [...emojiCatalogs.values()].reduce((sum, catalog) => sum + (catalog.entries?.length ?? 0), 0),
              items: [...emojiCatalogs.entries()].map(([guildId, catalog]) => ({
                guildId,
                guildName: catalog.guildName ?? '',
                entries: catalog.entries?.length ?? 0,
                builtAt: catalog.builtAt ?? null,
              })),
              job: {
                running: emojiBuild.running,
                startedAt: emojiBuild.startedAt || null,
                finishedAt: emojiBuild.finishedAt || null,
                exitCode: emojiBuild.exitCode,
                error: emojiBuild.error,
                reason: emojiBuild.reason,
                log: emojiBuildLogTail(20),
              },
            },
            slang: {
              enabled: cfg.discord.slang.enabled,
              ...slangStats(slangStore),
              running: slangRunning,
              queued: slangQueue.length,
              lastRunAt: slangLastRunAt || null,
              today: slangDayKey === localDayKey() ? slangDayCount : 0,
              maxPerDay: cfg.discord.slang.maxPerDay,
            },
            console: { host, port },
          }),
          sessions: sessionsInfo,
          // 沒有會話也要走 retireSession：還在等的第一批要一起丟掉。
          resetSession: (key) => retireSession(key),
          config: editableConfig,
          updateConfig,
          invite: inviteInfo,
          usage: usageInfo,
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
                || String(b.updatedAt).localeCompare(String(a.updatedAt))),
              stats: slangStats(slangStore),
              learning: {
                enabled: cfg.discord.slang.enabled,
                running: slangRunning,
                queued: slangQueue.length,
                lastRunAt: slangLastRunAt || null,
                today: slangDayKey === localDayKey() ? slangDayCount : 0,
                maxPerDay: cfg.discord.slang.maxPerDay,
              },
            };
          },
          slangConfirm: (id) => {
            const entry = confirmSlang(slangStore, id);
            if (entry) saveSlangNow();
            return entry;
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
          logs: (limit) => LOG_RING.slice(-limit),
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

  const shutdown = async (signal) => {
    log(`收到 ${signal}，結束中…`);
    try { flushMemory(); } catch { /* 收尾失敗不影響結束 */ }
    try { flushSlang(); } catch { /* 收尾失敗不影響結束 */ }
    try { await agentApiHandle?.close(); } catch { /* 已經關了 */ }
    try { await consoleHandle?.close(); } catch { /* 已經關了 */ }
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
