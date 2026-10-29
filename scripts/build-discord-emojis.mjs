#!/usr/bin/env node
// 建立 / 更新 Discord 自訂表情目錄（每個伺服器一份，存到 state/discord-emoji/<guildId>.json）。
//
// 做法：抓伺服器的 emoji 圖（Discord CDN）→ 一次 4~5 張丟給 DSH 的視覺模型 →
// 讓它自己寫「外觀、情緒、使用時機、tags」→ 存檔。只重做新的或換圖的（hash 比對）。
//
// 用法：
//   node scripts/build-discord-emojis.mjs                # 所有 bot 所在的伺服器
//   node scripts/build-discord-emojis.mjs --guild 123    # 只做一個
//   node scripts/build-discord-emojis.mjs --force        # 全部重做
//   node scripts/build-discord-emojis.mjs --batch 4      # 每批幾張（預設 5）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { normalizeDiscordConfig } from '../src/core/discord-core.mjs';
import { fetchDiscordMedia, prepareMediaBlock } from '../src/core/discord-media.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const CATALOG_DIR = path.join(STATE_DIR, 'discord-emoji');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const BATCH_TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const onlyGuild = valueOf('guild', '');
const force = flag('force');
const limit = Math.max(0, Number(valueOf('limit', '0')) || 0);
const batchSize = Math.min(6, Math.max(1, Number(valueOf('batch', '5')) || 5));

const log = (...parts) => console.log(new Date().toLocaleTimeString('zh-TW', { hour12: false }), '[emoji]', ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadConfig() {
  let file;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`讀不到 ${CONFIG_FILE}：${error?.message ?? error}`);
  }
  const dsh = file.dsh ?? {};
  return {
    dsh: {
      baseUrl: String(dsh.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, ''),
      provider: String(dsh.provider || 'opencode-go'),
      model: String(dsh.model || 'deepseek-v4.1-flash'),
      authToken: typeof dsh.authToken === 'string' ? dsh.authToken : '',
      allowRemote: dsh.allowRemote === true,
    },
    discord: normalizeDiscordConfig(file.discord),
  };
}

function readCatalog(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && Array.isArray(doc.entries) ? doc : null;
  } catch {
    return null;
  }
}

function writeCatalog(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function extractJsonArray(text) {
  const raw = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('模型輸出沒有 JSON 陣列');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('模型輸出不是陣列');
  return parsed;
}

const prompt = (names) => `你在建立 Discord 表情目錄。以下 ${names.length} 張圖依序對應名稱：${names.join(', ')}。
對每一張輸出一個物件：{"name":"對應名稱","description":"外觀與情緒，20字內","tags":["3到5個中文關鍵詞"],"usage":"適合使用的時機，20字內"}
描述、標籤、用途一律用繁體中文。只輸出 JSON 陣列，不要程式碼圍欄、不要解釋。看不到就照實描述你實際看到的。`;

async function runBatch(api, cfg, items) {
  const workspace = unwrap(await api.workspace.create({ path: path.join(STATE_DIR, 'discord-agents') }), 'workspace.create');
  const created = unwrap(await api.sessions.create({
    workspaceId: workspace.workspace.workspaceId,
    agentPreset: cfg.discord.agentPreset,
  }), 'session.create');
  const sessionId = created.sessionId;

  try {
    unwrap(await api.sessions.selectModel({
      sessionId,
      provider: cfg.dsh.provider,
      model: cfg.dsh.model,
      // 索引不需要深度推理；low 比較便宜，模型不支援時 DSH 會拒絕，下面會記 log。
      reasoningEffort: 'low',
    }), 'session.selectModel');

    api.events.follow(sessionId);
    const ac = new AbortController();
    const collector = createTurnCollector();
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const timer = setTimeout(() => { finish({ timeout: true }); ac.abort(); }, BATCH_TIMEOUT_MS);

    let prompted = false;
    const sendPrompt = () => {
      if (prompted) return;
      prompted = true;
      api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt(items.map((item) => item.emoji.name)) }, ...items.map((item) => item.block)],
      }).then((response) => {
        if (!response.result?.ok) finish({ error: `prompt 被拒絕：${response.result?.error?.code ?? '未知'}` });
      }).catch((error) => finish({ error: String(error?.message ?? error) }));
    };
    setTimeout(sendPrompt, 8000);

    (async () => {
      try {
        for await (const envelope of api.events.mux({}, ac.signal)) {
          const frame = envelope.payload;
          if (frame.type === 'session/snapshot' && frame.sessionId === sessionId) { setTimeout(sendPrompt, 300); continue; }
          if (frame.type !== 'session/event' || frame.sessionId !== sessionId) continue;
          const ended = collector.push(frame.event);
          if (ended) { finish(ended); ac.abort(); return; }
        }
      } catch (error) {
        if (!ac.signal.aborted) finish({ error: String(error?.message ?? error) });
      }
    })();

    const result = await finished;
    clearTimeout(timer);
    if (result.error) throw new Error(result.error);
    if (result.timeout) throw new Error('回合逾時');
    if (result.reason?.kind !== 'completed') throw new Error(`回合失敗：${result.reason?.kind ?? 'unknown'}`);
    return extractJsonArray(result.text);
  } finally {
    try { await api.stopSessionWork(sessionId); } catch { /* 已結束 */ }
    try { await api.workspace.archiveSession({ sessionId }); } catch { /* 已歸檔 */ }
  }
}

async function main() {
  const cfg = loadConfig();
  const token = cfg.discord.token || String(process.env.DISCORD_TOKEN ?? '').trim();
  if (!token) throw new Error('沒有 Discord token（config.json 的 discord.token 或 DISCORD_TOKEN）');

  const api = new NodeApiClient(cfg.dsh.baseUrl, 60_000, {
    token: cfg.dsh.authToken,
    tokenExplicit: Boolean(cfg.dsh.authToken),
    allowRemote: cfg.dsh.allowRemote,
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });
  await client.login(token);
  // `login()` 可能在 READY 之前就 resolve；那時 guild 物件只有 id，name/emojis 都還是 undefined。
  if (!client.isReady()) {
    await new Promise((resolve) => client.once(Events.ClientReady, resolve));
  }
  log(`已登入 ${client.user.tag}，伺服器 ${client.guilds.cache.size} 個`);

  let changedGuilds = 0;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (onlyGuild && guild.id !== onlyGuild) continue;
      log(`== ${guild.name}（${guild.id}）==`);
      const file = path.join(CATALOG_DIR, `${guild.id}.json`);
      const existing = readCatalog(file);
      const previous = new Map((existing?.entries ?? []).map((entry) => [String(entry.id), entry]));

      let emojis;
      try {
        emojis = [...(await guild.emojis.fetch()).values()];
      } catch (error) {
        log(`讀不到表情：${error?.message ?? error}`);
        continue;
      }
      if (emojis.length === 0) { log('沒有自訂表情，跳過'); continue; }
      log(`表情 ${emojis.length} 個`);

      const pending = [];
      for (const emoji of emojis) {
        const url = emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 128 });
        let buffer;
        try {
          buffer = await fetchDiscordMedia(url, cfg.discord.media);
        } catch (error) {
          log(`下載 ${emoji.name} 失敗：${error?.message ?? error}`);
          continue;
        }
        const hash = createHash('sha256').update(buffer).digest('hex');
        const old = previous.get(String(emoji.id));
        if (!force && old?.hash === hash && old?.description) {
          pending.push({ emoji, hash, entry: old, cached: true });
          continue;
        }
        pending.push({ emoji, hash, buffer });
      }

      const need = pending.filter((item) => !item.cached).slice(0, limit > 0 ? limit : undefined);
      log(`需要索引 ${need.length} 個（沿用 ${pending.length - pending.filter((item) => !item.cached).length} 個）`);
      const entries = new Map(pending.filter((item) => item.cached).map((item) => [String(item.emoji.id), item.entry]));

      for (let i = 0; i < need.length; i += batchSize) {
        const batch = need.slice(i, i + batchSize);
        const prepared = [];
        for (const item of batch) {
          const image = await prepareMediaBlock(item.buffer, `${item.emoji.name}.${item.emoji.animated ? 'gif' : 'png'}`, cfg.discord.media);
          if (image.block) prepared.push({ ...item, block: image.block });
          else log(`${item.emoji.name} 跳過：${image.error}`);
        }
        if (prepared.length === 0) continue;
        log(`索引 ${i + 1}-${i + prepared.length}/${need.length}：${prepared.map((item) => item.emoji.name).join(', ')}`);
        let result;
        try {
          result = await runBatch(api, cfg, prepared);
        } catch (error) {
          log(`批次失敗（保留舊資料）：${error?.message ?? error}`);
          continue;
        }
        for (const row of result) {
          const name = String(row?.name ?? '').toLowerCase();
          const item = prepared.find((candidate) => candidate.emoji.name.toLowerCase() === name);
          if (!item) continue;
          entries.set(String(item.emoji.id), {
            id: item.emoji.id,
            name: item.emoji.name,
            animated: Boolean(item.emoji.animated),
            hash: item.hash,
            description: String(row.description ?? '').slice(0, 60),
            tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t).slice(0, 20)).slice(0, 6) : [],
            usage: String(row.usage ?? '').slice(0, 60),
            updatedAt: new Date().toISOString(),
          });
        }
        await sleep(300);
      }

      // 索引失敗或這次沒做的，保留舊資料（不要因為一次失敗就從目錄消失）
      for (const item of pending) {
        const id = String(item.emoji.id);
        if (!entries.has(id) && previous.has(id)) entries.set(id, previous.get(id));
      }

      // 刪掉的 emoji 不留在目錄裡
      const alive = new Set(emojis.map((emoji) => String(emoji.id)));
      for (const id of [...entries.keys()]) if (!alive.has(id)) entries.delete(id);

      const doc = {
        version: 1,
        guildId: guild.id,
        guildName: guild.name,
        model: `${cfg.dsh.provider}/${cfg.dsh.model}`,
        builtAt: new Date().toISOString(),
        entries: [...entries.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
      };
      writeCatalog(file, doc);
      changedGuilds += 1;
      log(`寫入 ${path.relative(ROOT, file)}：${doc.entries.length} 條`);
    }
  } finally {
    await client.destroy();
  }
  log(`完成：更新 ${changedGuilds} 個伺服器的目錄`);
}

main().catch((error) => {
  console.error(`[emoji] 失敗：${error?.message ?? error}`);
  process.exit(1);
});
