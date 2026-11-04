// 出站內容的敏感資訊閘門。
//
// 兩層，跟 QQ 版一致：
//   1. 共用正則（src/sensitive.js）：抓「長得像本機路徑 / 憑證賦值」的文本；
//   2. 已知令牌精確比對：Discord token、DSH launch token、控制台 token、GIPHY API key。
// 這裡只負責判斷，不負責改寫；呼叫端決定要整條攔掉還是打碼。
import { matchSensitive } from '../sensitive.js';

// `:名稱:` 是 Discord 的表情代號，不是憑證的值：`我在省 token :jokerdog:` 緊湊化後
// 會變成 `token:jokerdog:`，長得就像 `token: 值`。判定前拿掉目錄裡真的有的表情代號；
// 自己編的（`:hunter2:`）不算，照樣要擋。
const SHORTCODE_RE = /:[a-zA-Z0-9_]{2,32}:/g;

/**
 * 判斷並說明命中原因；呼叫端要告訴模型「哪個片段被擋」時用這個。
 *
 * @param text 要送出的文字
 * @param secrets 已知的令牌原文（長度 < 8 的會被忽略，避免誤攔短字串）
 * @param emojiTokens 真的存在的表情代號（小寫、含冒號，例如 `:jokerdog:`）；沒有就照原文判定
 * @returns null | { reason: 'sensitive-pattern' | 'known-token', rule: 'path' | 'credential' | 'known-token', match: string }
 */
export function describeSensitive(text, secrets = [], emojiTokens = null) {
  let value = String(text ?? '');
  if (!value) return null;
  if (emojiTokens?.size) {
    value = value.replace(SHORTCODE_RE, (match) => (emojiTokens.has(match.toLowerCase()) ? ' ' : match));
  }
  // 先比對已知令牌：令牌常常就寫在 `token=…` 這種賦值裡，先跑正則的話
  // 回報的片段會把令牌原文一起帶出去。
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim().length >= 8 && value.includes(secret)) {
      return { reason: 'known-token', rule: 'known-token', match: '' };
    }
  }
  const hit = matchSensitive(value);
  if (hit) return { reason: 'sensitive-pattern', ...hit };
  return null;
}

/**
 * @param text 要送出的文字
 * @param secrets 已知的令牌原文（長度 < 8 的會被忽略，避免誤攔短字串）
 * @param emojiTokens 真的存在的表情代號（小寫、含冒號，例如 `:jokerdog:`）
 * @returns null | 'sensitive-pattern' | 'known-token'
 */
export function findSensitive(text, secrets = [], emojiTokens = null) {
  return describeSensitive(text, secrets, emojiTokens)?.reason ?? null;
}

// 用字元切，不要用 UTF-16 長度：切在 emoji 中間會留下半個代理對。
const clipText = (text, max) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
};

/** 命中原因寫成一句給模型看的話：`憑證樣式「token=abc」`、`本機路徑「/home/…」`、`已知令牌`。 */
export function formatSensitiveHit(hit) {
  if (!hit?.match) return '已知令牌';
  return `${hit.rule === 'path' ? '本機路徑' : '憑證樣式'}「${clipText(hit.match, 60)}」`;
}
