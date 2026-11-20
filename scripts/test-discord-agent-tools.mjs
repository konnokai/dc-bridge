// 智能體工具層的行為測試：handler 名稱集合、餅回合閘門、安靜閘門、交易格式化，
// 以及拆檔後「模組內組裝子 factory」的漏接 deps 檢查。
//
// 這裡直接建 createAgentTools（deps 從簽名自動長出 stub），因為 handler 註冊、
// ceobe 包裝與安靜閘門都只在組裝後才存在；分開測子模組看不到這些。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as espree from 'espree';
import { createAgentTools, mergeHandlers } from '../src/core/discord-bridge-agent-tools.mjs';
import { normalizeDiscordConfig, parseMessageLink } from '../src/core/discord-core.mjs';
import { stripPublicLinks } from '../src/core/discord-trade.mjs';
import { formatPortfolioResult, formatQuoteResult, formatSymbolList } from '../src/core/discord-bridge-agent-trade.mjs';
import { factoryCalls, missingDeps } from './lib/factory-wiring.mjs';

let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log(`✓ ${label}`);
  else { failures += 1; console.error(`✗ ${label}`); }
};
const rejects = async (promise, status, re, label) => {
  try {
    await promise;
    ok(false, `${label}（應該要拒絕）`);
  } catch (error) {
    ok(error?.statusCode === status && re.test(String(error?.message ?? error)), label);
  }
};

const TOOLS_FILE = new URL('../src/core/discord-bridge-agent-tools.mjs', import.meta.url);
const toolsSource = fs.readFileSync(TOOLS_FILE, 'utf8');
const toolsAst = espree.parse(toolsSource, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
const toolsFactory = toolsAst.body.find((node) => node.declaration?.id?.name === 'createAgentTools').declaration;
const depKeys = toolsFactory.params[0].properties.map((prop) => prop.key.name).filter(Boolean);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-agent-tools-'));
const discordCfg = normalizeDiscordConfig({ allowAllWhenEmpty: true });
discordCfg.security.blockSensitive = false;

const sessions = { 'ch:100': 'sess-100' };
const reverse = new Map([['sess-100', 'ch:100']]);
const turnMeta = new Map();
const turnSentTexts = new Map();
const sent = [];
const channel = {
  id: '100',
  name: '測試頻道',
  guildId: 'guild-1',
  guild: null,
  messages: { cache: new Map(), fetch: async () => null },
  send: async (payload) => {
    sent.push(payload);
    return { id: `sent-${sent.length}` };
  },
};
const quiet = { at: 0 };

const stubs = {
  cfg: { discord: discordCfg, dsh: {}, giphy: {} },
  log: () => {},
  client: { user: { id: 'bot', username: 'bot', displayName: 'bot' }, channels: { cache: new Map() } },
  sessions,
  reverse,
  resolveChannel: async () => channel,
  sendLong: async () => [],
  quietUntil: () => quiet.at,
  refreshEmojiCatalogs: () => {},
  applyCustomStatus: () => {},
  withTimeout: (promise) => promise,
  AGENT_IMAGE_DIR: path.join(tempDir, 'images'),
  CUSTOM_STATUS_FILE: path.join(tempDir, 'status.json'),
  MEMES_FILES_DIR: path.join(tempDir, 'memes'),
  knowledgeStore: {},
  memeStore: {},
  memoryStore: {},
  notesStore: {},
  devFeedbackStore: {},
  slangStore: {},
  triggerStore: {},
  ignoreStore: {},
  archive: null,
  imageJobs: new Map(),
  pendingDraws: new Map(),
  voiceJobs: new Map(),
  sandboxRuns: new Map(),
  voicePerTurn: new Map(),
  voiceLastAt: new Map(),
  memeSaves: new Map(),
  devFeedbackEdits: new Map(),
  devFeedbackWrites: new Map(),
  knowledgeWrites: new Map(),
  memoryWrites: new Map(),
  noteWrites: new Map(),
  slangWrites: new Map(),
  emojiUsage: new Map(),
  primedKeys: new Set(),
  botLastByUser: new Map(),
  recentHumans: new Map(),
  activity: { record: () => {} },
  followups: { add: () => ({ error: '測試不排回訪' }), pending: () => 0 },
  quietState: { set: () => ({ until: null, ended: false }) },
  refusals: { count: () => 0, note: () => {} },
  ownerIds: new Set(),
  ignoredUser: () => false,
  enqueuePrompt: () => {},
  getBatcher: () => ({ take: () => [] }),
  getTradeService: () => null,
  getBotActiveRun: () => null,
  getConsoleTokenValue: () => '',
  getEmojiCatalogs: () => ({}),
  turnMeta,
  turnUsers: new Map(),
  turnDirectMessages: new Map(),
  turnFollowupHeld: new Set(),
  turnFollowupTaken: new Set(),
  turnLastMessage: new Map(),
  turnSentTexts,
  turnStartedAt: new Map(),
  turnTriggerRecorded: new Set(),
};
// 沒列到的 deps 都是 no-op：新增 deps 不用每次回來改這張表。
const deps = Object.fromEntries(depKeys.map((key) => [key, stubs[key] ?? (() => {})]));
const tools = createAgentTools(deps);
const token = tools.agentSender.tokenIfLive('sess-100');

console.log('## 1. handler 名稱快照');
{
  const expected = ['cancelImage', 'custom-status', 'delete', 'dev-feedback', 'dev-feedback-edit', 'dev-feedback-list', 'edit', 'emojis', 'followup', 'forget-fact', 'gif', 'history', 'ignore', 'imageJob', 'imageRef', 'jobStatus', 'knowledge', 'meme-forget', 'meme-save', 'meme-search', 'note', 'note-forget', 'notes-search', 'poll', 'prtsArtwork', 'prtsImage', 'quiet', 'react', 'recall', 'remember', 'runScript', 'search', 'send', 'sendVoice', 'sendVoiceFile', 'server', 'sessionToken', 'slang-lookup', 'slang-record', 'stats', 'stickers', 'tag-record', 'trade-bot-order', 'trade-bot-portfolio', 'trade-leaderboard', 'trade-order', 'trade-portfolio', 'trade-quote', 'trade-symbols', 'unreact', 'user', 'view'];
  const actual = Object.keys(tools.apiHandlers).sort();
  ok(actual.length === expected.length && actual.every((name, index) => name === expected[index]),
    `apiHandlers 是預期的 ${expected.length} 個名稱（名稱集合沒少）`);
  let duplicate = '';
  try { mergeHandlers({ send: 1 }, { send: 2 }); } catch (error) { duplicate = String(error?.message ?? error); }
  ok(/工具名稱重複：send/.test(duplicate), '合併時同名 handler 會丟錯，不會靜靜蓋掉');
}

console.log('## 2. 餅回合閘門（合併後仍有效）');
{
  turnMeta.set('ch:100', { ceobe: true });
  await rejects(tools.apiHandlers.remember({ token, message: '#abc123', fact: '測試' }), 403, /餅/, '餅回合不能用 remember_user');
  const result = await tools.apiHandlers.send({ token, content: '測試' });
  ok(result?.key === 'ch:100', '餅回合仍可以用 send_message');
  ok(turnSentTexts.get('ch:100')?.at(-1) === '測試', '餅回合記下真的送出的文字');
  await rejects(tools.apiHandlers.imageJob({ sessionId: 'sess-100', jobId: 'job-1', phase: 'start' }), 403, /餅/, '餅回合擋 imageJob start');
  const polled = await tools.apiHandlers.imageJob({ sessionId: 'sess-100', jobId: 'job-1', phase: 'poll' });
  ok(polled?.cancel === true, '餅回合放行 imageJob poll（不然跑中的工作收不了尾）');
  turnMeta.delete('ch:100');
}

console.log('## 3. 安靜閘門');
{
  quiet.at = Date.now() + 60_000;
  await rejects(
    tools.apiHandlers.poll({ token, question: '要不要', answers: ['要', '不要'], hours: 1 }),
    409,
    /安靜中/,
    '安靜中不能發投票',
  );
  quiet.at = 0;
  const before = sent.length;
  const result = await tools.apiHandlers.poll({ token, question: '要不要', answers: ['要', '不要'], hours: 1 });
  ok(result?.key === 'ch:100' && sent.length === before + 1, '安靜結束後可以發投票');
}

console.log('## 4. 交易格式化');
{
  ok(formatQuoteResult({ unlisted: { note: '這檔不開放' } }) === '這檔不開放', 'quote：不開放的標的直接回原因');
  const candidates = formatQuoteResult({ candidates: [{ symbol: '2330', name: '台積電', exchange: 'TWSE' }, { symbol: '2330A', name: '台積電甲', exchange: 'TWSE' }] });
  ok(candidates.includes('2330 台積電') && candidates.includes('不要自己猜'), 'quote：多個候選要模型問清楚');
  const quote = formatQuoteResult({
    entry: { name: '台積電', symbol: '2330', exchange: 'TWSE', type: 'stock' },
    quote: { closeCents: 100_000, asOf: '2026-11-20', changeCents: 2_500, referenceCents: 97_500 },
    market: { open: true, label: '盤中' },
    tradable: true,
  });
  ok(quote.includes('台積電（2330）') && quote.includes('漲跌：+NT$25.00（+2.56%）'), 'quote：正常行情含漲跌');
  const symbols = formatSymbolList({ query: '', etfs: [{ symbol: '0050', name: '元大台灣50', exchange: 'TWSE' }] });
  ok(symbols.includes('ETF（1 檔）') && symbols.includes('0050 元大台灣50'), 'symbols：沒帶 query 只列 ETF');
  ok(formatPortfolioResult({ exists: false }).includes('還沒有模擬帳戶'), 'portfolio：沒有帳戶');
  const portfolio = formatPortfolioResult({
    exists: true,
    cashCents: 100_000,
    reservedCents: 0,
    availableCashCents: 100_000,
    navCents: 100_000,
    returnPct: 0,
    realizedCents: 0,
    unrealizedCents: 0,
    positions: [{ symbol: '2330', name: '台積電', qty: 10, avgCostCents: 100_000, priceCents: 101_000, unrealizedCents: 1_000 }],
    orders: [],
  });
  ok(portfolio.includes('持股：') && portfolio.includes('2330 台積電 10 股'), 'portfolio：持股明細');
}

console.log('## 5. 結構檢查 G 項（模組內 factory）');
{
  const fixture = espree.parse('const tools = createThing({ a, b: 1 });', { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const calls = factoryCalls(fixture);
  ok(calls.length === 1 && calls[0].name === 'createThing' && calls[0].keys.join(',') === 'a,b', 'G 項抓得到 factory 呼叫與 key');
  ok(missingDeps(['a', 'b', 'c'], calls[0].keys).join(',') === 'c', 'G 項抓得到漏接的 dep');
  const spread = espree.parse('createThing({ ...deps });', { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  ok(factoryCalls(spread)[0].spread === true, 'spread 的呼叫標成無法靜態核對');
}

console.log('## 6. 合併後真的進得到子層 handler');
{
  await rejects(tools.apiHandlers['trade-quote']({ token }), 403, /模擬股票沒有開啟/, 'trade 層接上 getTradeService');
  await rejects(tools.apiHandlers.server({ token }), 400, /私聊沒有伺服器/, 'read 層接上目前的頻道（私聊擋下）');
  const stats = await tools.apiHandlers.stats({ token });
  ok(stats?.text === '還沒有對話紀錄。', 'read 層接上 triggerStore');
}

console.log('## 7. 搬出來的純函式');
{
  ok(parseMessageLink('https://discord.com/channels/12345/67890/123456789012345678')?.messageId === '123456789012345678', 'parseMessageLink：一般網址');
  ok(parseMessageLink('https://ptb.discord.com/channels/12345/67890/123456789012345678')?.guildId === '12345', 'parseMessageLink：ptb 網址');
  ok(parseMessageLink('123456789012345678') === null, 'parseMessageLink：裸 id 不收');
  const stripped = stripPublicLinks('看 https://example.com @everyone https://discord.gg/abc');
  ok(!stripped.includes('example.com') && !stripped.includes('discord.gg'), 'stripPublicLinks：一般與邀請連結都去掉');
  ok(stripped.includes('@\u200beveryone'), 'stripPublicLinks：@everyone 加零寬字元');
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ 智能體工具測試通過' : `\n❌ ${failures} 項失敗`);
process.exit(failures === 0 ? 0 : 1);
