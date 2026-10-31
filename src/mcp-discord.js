#!/usr/bin/env node
// Discord MCP server（stdio）。
// 由 DSH 的 MCP 客戶端 spawn（cordis.patch.yml 裡的 mcp-discord 行）。
//
// 說不說話、回覆誰、按什麼 reaction 都是模型的決定；這裡只負責把呼叫帶回橋接。
// 真正的權限（會話令牌、白名單、敏感資訊、每輪上限、#編號只查自己頻道）都在橋接端，
// 所以每個工具都只是一行 post。
//
// 端點由橋接寫在 state/discord-agent.json（重啟後埠會變，所以每次呼叫都重讀）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT_FILE = process.env.DC_AGENT_FILE || path.join(ROOT, 'state', 'discord-agent.json');
const PING_INTERVAL_MS = 10_000;

function readEndpoint() {
  let text;
  try {
    text = fs.readFileSync(ENDPOINT_FILE, 'utf8');
  } catch {
    throw new Error('橋接的發送端點還沒就緒（state/discord-agent.json 不存在）：確認 dc-bridge 正在執行');
  }
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw new Error('發送端點檔損毀：重啟 dc-bridge 會重寫');
  }
  if (!doc?.url || !doc?.token) throw new Error('發送端點檔缺少 url/token：重啟 dc-bridge');
  return doc;
}

async function post(pathname, body, timeoutMs) {
  const { url, token } = readEndpoint();
  let res;
  try {
    res = await fetch(`${url}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`連不上橋接（${url}）：${error?.message ?? error}`);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) throw new Error(String(parsed?.error ?? `橋接回應 HTTP ${res.status}`));
  if (parsed?.ok === false) throw new Error(String(parsed?.error ?? '橋接拒絕送出（未說明原因）'));
  return parsed ?? {};
}

/**
 * 握手：通知橋接 mcp-discord 已啟動，橋接在日誌留一行，方便確認 DSH 有載入它。
 * 只影響日誌，不影響送不送。定時重送是因為橋接重啟後換了端點，要再報到一次。
 */
async function hello() {
  await post('/hello', {}, 5000);
}

void hello().catch(() => {});
const pingTimer = setInterval(() => { void hello().catch(() => {}); }, PING_INTERVAL_MS);
pingTimer.unref?.();

const server = new McpServer({ name: 'discord', version: '0.2.1-r1' });

// 正常由 DSH 外掛（plugins/dc-agent-presets/dc-session-token.mjs）自動帶入，模型看不到令牌。
// token 必須留在 schema 裡：MCP SDK 用 zod 驗參數，沒宣告的欄位會被剝掉，外掛補的值就進不去。
// 沒有外掛的呼叫端會被橋接拒絕（fail closed），不會退化成某個預設會話。
const sessionToken = z.string().optional().describe('不用填：DSH 外掛會自動帶入會話令牌');
const messageRef = (what) => z.string().describe(`${what}：訊息前面的 #編號（例如 #k7f3ab），只能用這個頻道出現過的`);

/** 送出結果帶上 #編號：edit_message／delete_message／看反應都用這些。 */
function sentDetail(result, verb) {
  if (result?.notice) return String(result.notice);
  const where = result.channel === '私聊' ? '私聊' : `#${result.channel ?? 'Discord'}`;
  const refs = result.refs ?? [];
  if (refs.length === 1) return `已${verb}到 ${where}。這則的訊息編號是 #${refs[0]}（之後改、收回、看反應用這個）`;
  if (refs.length > 1) return `已${verb}到 ${where}。訊息編號：${refs.map((ref) => `#${ref}`).join('、')}（之後改、收回、看反應用這些）`;
  return `已${verb}到 ${where}`;
}

/**
 * 每個工具都是：post 到橋接 → 成功回文字，失敗回 isError（模型才不會以為做成了）。
 * success 也可以回 content 陣列（文字加圖片）。
 */
function tool(name, description, schema, pathname, success, timeoutMs = 30_000) {
  server.tool(name, description, schema, async (args) => {
    try {
      const result = await post(pathname, args, timeoutMs);
      const out = success(result);
      return { content: Array.isArray(out) ? out : [{ type: 'text', text: out }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `失敗：${error?.message ?? error}` }] };
    }
  });
}

tool(
  'send_message',
  '把一則訊息送進目前的 Discord 會話。這是唯一能把文字送到 Discord 的方法：不呼叫就不會發出任何東西。',
  {
    token: sessionToken,
    content: z.string().describe('要送出的訊息本體（Discord Markdown；:名稱: 會換成伺服器表情；太長會自動分段）'),
    reply_to: messageRef('要用 Discord「回覆」功能接的那則訊息').optional(),
  },
  '/send',
  (result) => sentDetail(result, '送出'),
);

tool(
  'send_image',
  '把 generate_image 畫好的圖送進目前的 Discord 會話。file 填【生圖完成】提示裡的 path（或那個檔名）；可以順便帶一句話。只送得出放在橋接圖片目錄裡的圖。',
  {
    token: sessionToken,
    file: z.string().describe('【生圖完成】提示裡的 path（完整路徑或檔名都可以）'),
    content: z.string().optional().describe('跟圖片一起送的文字，可省略'),
    reply_to: messageRef('要回覆的那則訊息').optional(),
  },
  '/send',
  (result) => sentDetail(result, '送出圖片'),
  60_000,
);

tool(
  'send_sticker',
  '送一張這個伺服器的貼圖（名稱先用 search_stickers 查）。私聊與別的伺服器的貼圖送不了。',
  {
    token: sessionToken,
    sticker: z.string().describe('貼圖名稱（search_stickers 回傳的）'),
    content: z.string().optional().describe('跟貼圖一起送的文字，可省略'),
    reply_to: messageRef('要回覆的那則訊息').optional(),
  },
  '/send',
  (result) => sentDetail(result, '送出貼圖'),
);

tool(
  'edit_message',
  '改你自己送出的一則訊息（打錯字、說錯話）。只能改你用 send_message／send_sticker／create_poll 送出、回傳過 #編號的訊息；投票不能改。',
  {
    token: sessionToken,
    message: messageRef('要改的那則（你送出後回傳的編號）'),
    content: z.string().describe('改成的完整內容（一則放得下；:名稱: 會換成伺服器表情）'),
  },
  '/edit',
  () => '已修改',
);

tool(
  'delete_message',
  '收回你自己送出的一則訊息。只能收回你用工具送出、回傳過 #編號的訊息；一輪最多 2 則。',
  {
    token: sessionToken,
    message: messageRef('要收回的那則（你送出後回傳的編號）'),
  },
  '/delete',
  () => '已收回',
);

tool(
  'create_poll',
  '在這個頻道發一個 Discord 投票。大家在討論要選哪個、要約時間時才用，很少用。',
  {
    token: sessionToken,
    question: z.string().max(300).describe('投票題目，最多 300 字'),
    answers: z.array(z.string().max(55)).min(2).max(10).describe('選項，2~10 個，每個最多 55 字'),
    hours: z.number().int().min(1).max(168).optional().describe('投票開多久（小時），預設 24，最多 168'),
    multi: z.boolean().optional().describe('可不可以複選，預設不行'),
  },
  '/poll',
  (result) => sentDetail(result, '發出投票'),
);

tool(
  'add_reaction',
  '對某則訊息按一個表情反應。用在有人接你的梗、誇你、回你的問題這類跟你有關的訊息；沒在找你的閒聊不用按，跳過就好。',
  {
    token: sessionToken,
    message: messageRef('要按 reaction 的那則訊息'),
    emoji: z.string().describe('伺服器表情名稱（例如 kekw；【常用表情】有的就直接用）或一個 Unicode emoji（例如 😂）'),
  },
  '/react',
  () => '已按 reaction',
);

tool(
  'remove_reaction',
  '收回你在某則訊息按過的表情反應。只能收回你自己按的，按錯或想換一個時用。',
  {
    token: sessionToken,
    message: messageRef('要收回 reaction 的那則訊息'),
    emoji: z.string().describe('要收回的表情：跟 add_reaction 用同一個名稱或 Unicode emoji'),
  },
  '/unreact',
  () => '已收回 reaction',
);

tool(
  'set_quiet',
  '讓自己安靜一段時間：這段時間沒叫你的頻道訊息不送進模型（叫你的照常），省 token。頻道很吵或你不想接話時用。',
  {
    token: sessionToken,
    minutes: z.number().int().min(0).max(120).describe('安靜幾分鐘（1~120）；0 = 提早結束安靜'),
    reason: z.string().optional().describe('為什麼安靜，寫給自己看的，可省略'),
  },
  '/quiet',
  (result) => String(result.text ?? ''),
);

tool(
  'schedule_followup',
  '排一個之後的「回訪」：時間到了 bridge 會給你一個提示，你再決定要不要說話（不是預先寫好直接送出）。用在「我等一下回來看結果」「晚點再確認」這種；做不到的事不要拿它敷衍。',
  {
    token: sessionToken,
    minutes: z.number().int().min(5).max(180).describe('幾分鐘後回訪（5~180）'),
    note: z.string().max(200).describe('要提醒自己什麼，例如「回來看比賽結果」'),
  },
  '/followup',
  (result) => String(result.text ?? ''),
);

tool(
  'ignore_user',
  '暫時不理某個人：這段時間他的訊息不會送進來，包括 @ 你。用在有人一直騷擾、洗頻、針對你講不聽的時候；意見不合或一次吵架不要用。管理員不能設。minutes=0 解除；控制台看得到這份名單。',
  {
    token: sessionToken,
    message: messageRef('那個人說過的某一則訊息'),
    minutes: z.number().int().min(0).max(1440).describe('不理幾分鐘（1~1440，最多一天）；0 = 解除不理'),
    reason: z.string().max(100).optional().describe('為什麼不理，寫給管理員看的，可省略'),
  },
  '/ignore',
  (result) => String(result.text ?? ''),
);

tool(
  'search_emojis',
  '用關鍵字查能用的自訂表情（在訊息裡寫 :名稱:、或給 add_reaction）。【常用表情】沒有的、或想找更貼的才查。貼圖不在這裡，用 search_stickers。query 留空就列出這個伺服器的。',
  {
    token: sessionToken,
    query: z.string().optional().describe('想表達的情緒或內容，短一點，例如「笑」「無語」「貓」'),
  },
  '/emojis',
  (result) => String(result.text ?? ''),
  10_000,
);

tool(
  'search_stickers',
  '用關鍵字查這個伺服器的貼圖（send_sticker 用的名稱）。沒有符合的或 query 留空，就列出全部。',
  {
    token: sessionToken,
    query: z.string().optional().describe('想表達的情緒或內容，短一點，例如「笑」「無語」「貓」'),
  },
  '/stickers',
  (result) => String(result.text ?? ''),
  10_000,
);

tool(
  'search_gifs',
  '用關鍵字查 GIF（GIPHY），回幾個候選（標題＋媒體網址）。想用 GIF 接話、貼反應圖時用：挑一個最貼的，再用 send_message 把那一則的網址原樣送出（可以順便帶一句話）。一次只送一個，不要連清單一起貼、不要改網址；一輪最多查 3 次。',
  {
    token: sessionToken,
    query: z.string().max(50).describe('想找的內容或情緒，短一點，英文通常比較準，例如「shocked cat」「笑死」'),
  },
  '/gif',
  (result) => String(result.text ?? ''),
);

tool(
  'read_history',
  '讀這個頻道的訊息：預設從最新往前讀；知道是哪一天就給 date，從那個時間往後讀。只能讀目前這個頻道；date 和 before 只能給一個。和 search_history 合計一輪最多 3 次。',
  {
    token: sessionToken,
    before: messageRef('從哪一則往前讀（不能跟 date 一起給）').optional(),
    date: z.string().optional().describe('從這個時間往後讀：YYYY-MM-DD 或 YYYY-MM-DD HH:mm（跟【現在】同一時區）。不能跟 before 一起給'),
    limit: z.number().int().min(1).max(50).optional().describe('讀幾則，預設 20，最多 50'),
  },
  '/history',
  (result) => String(result.text ?? ''),
);

tool(
  'search_history',
  '在這個頻道找訊息：query 的每個詞都要出現，範圍是整個頻道的歷史；from 給某人說過的一則 #編號，只找他的。兩個至少給一個。date 只找那個時間之後的。和 read_history 合計一輪最多 3 次。',
  {
    token: sessionToken,
    query: z.string().optional().describe('關鍵字，用空白分開，每個都要出現'),
    from: messageRef('只找這則的發言者說過的').optional(),
    date: z.string().optional().describe('從這個時間往後找：YYYY-MM-DD 或 YYYY-MM-DD HH:mm（跟【現在】同一時區），可省略'),
    limit: z.number().int().min(1).max(20).optional().describe('最多回幾則，預設 10，最多 20'),
  },
  '/search',
  (result) => String(result.text ?? ''),
  60_000,
);

tool(
  'view_message',
  '看這個頻道一則訊息的完整內容：全文、附件、連結預覽（含連結修復 bot 換過的完整網址與正文）、被回覆那則的內容、附件與連結預覽、投票票數、回覆的是哪一則、reaction，並附上圖片（本則與被回覆那則的附件、貼圖、連結預覽的圖；YouTube 這類影片連結會抽幾格畫面）。只寫 [圖片]、被問「剛剛那張圖」、或群友丟連結問內容時先用。',
  {
    token: sessionToken,
    message: messageRef('要看的那則訊息'),
  },
  '/view',
  (result) => [
    { type: 'text', text: String(result.text ?? '') },
    ...(result.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
  ],
  60_000,
);

tool(
  'user_info',
  '查某則訊息的發言者：顯示名稱、使用者名稱、身分組、加入伺服器時間、加成與禁言狀態、你記得的關於他的事，並附上他的頭像圖片。',
  {
    token: sessionToken,
    message: messageRef('那個人說過的某一則訊息'),
  },
  '/user',
  (result) => [
    { type: 'text', text: String(result.text ?? '') },
    ...(result.avatar?.data ? [{ type: 'image', data: result.avatar.data, mimeType: result.avatar.mimeType }] : []),
  ],
);

tool(
  'server_info',
  '查目前這個伺服器與頻道：伺服器名稱、簡介、建立日期、擁有者、成員數、加成等級、自訂表情與貼圖數量、你在這裡的暱稱，以及這個頻道的名稱與主題。私聊沒有伺服器。',
  { token: sessionToken },
  '/server',
  (result) => String(result.text ?? ''),
);

tool(
  'conversation_stats',
  '查這個 bot 的對話次數統計：全部伺服器加總的今天人數／總人數／總次數，以及這個伺服器最常找你的人。被問「今天幾個人跟你說話」「你回過幾次」時用。',
  { token: sessionToken },
  '/stats',
  (result) => String(result.text ?? ''),
  10_000,
);

tool(
  'remember_user',
  '記住某個群友的一件事（他自己說的，或你從他的發言看出來的；之後聊天用得到的）。之後他說話時會出現在【你記得的群友】。回傳他目前的整份清單。',
  {
    token: sessionToken,
    message: messageRef('他說這件事的那則訊息（記憶掛在這則的發言者身上）'),
    name: z.string().describe('這件事是誰的：他在 prompt 裡的暱稱。跟那則的發言者對不上會回錯誤'),
    fact: z.string().describe('一句短話，最多 100 字，例如「在準備期末考」「希望大家叫他阿華」；自己推測的開頭加「（推測）」'),
  },
  '/remember',
  (result) => String(result.text ?? ''),
);

tool(
  'forget_user_fact',
  '刪掉某個群友記憶裡的一條（事情變了、記錯了）。編號用最新清單的；回傳刪完的清單。',
  {
    token: sessionToken,
    message: messageRef('那個人說過的某一則訊息'),
    number: z.number().int().min(1).describe('要刪第幾條（清單裡的編號）'),
  },
  '/forget-fact',
  (result) => String(result.text ?? ''),
);

tool(
  'note_event',
  '記一條這個頻道發生的事：約定、決定、反覆被提起的事件、梗的由來。記的是「群裡的事」，關於某個人的事仍用 remember_user。之後的批次會出現在【頻道筆記】。',
  {
    token: sessionToken,
    text: z.string().max(150).describe('一句短話，最多 150 字，例如「週五晚上約好一起打牌」'),
    days: z.number().int().min(1).max(180).optional().describe('幾天後過期，預設 30，最多 180'),
  },
  '/note',
  (result) => String(result.text ?? ''),
);

tool(
  'search_notes',
  '查這個頻道的筆記。query 用空白分開的每個詞都要出現；days 只看最近幾天。回傳的編號給 forget_note 用。',
  {
    token: sessionToken,
    query: z.string().optional().describe('關鍵字，用空白分開，每個都要出現'),
    days: z.number().int().min(1).max(180).optional().describe('只看最近幾天，省略就查全部'),
  },
  '/notes-search',
  (result) => String(result.text ?? ''),
  10_000,
);

tool(
  'forget_note',
  '刪掉這個頻道第 number 條筆記（記錯了、事情變了）。編號用 search_notes 回傳的清單；刪完回傳剩下的。',
  {
    token: sessionToken,
    number: z.number().int().min(1).describe('要刪第幾條（舊→新的編號）'),
  },
  '/note-forget',
  (result) => String(result.text ?? ''),
);

await server.connect(new StdioServerTransport());
