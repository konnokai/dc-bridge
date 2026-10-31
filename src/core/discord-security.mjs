// 出站內容的敏感資訊閘門。
//
// 兩層，跟 QQ 版一致：
//   1. 共用正則（src/sensitive.js）：抓「長得像本機路徑 / 憑證賦值」的文本；
//   2. 已知令牌精確比對：Discord token、DSH launch token、控制台 token、GIPHY API key。
// 這裡只負責判斷，不負責改寫；呼叫端決定要整條攔掉還是打碼。
import { SENSITIVE_RE } from '../sensitive.js';

/**
 * @param text 要送出的文字
 * @param secrets 已知的令牌原文（長度 < 8 的會被忽略，避免誤攔短字串）
 * @returns null | 'sensitive-pattern' | 'known-token'
 */
export function findSensitive(text, secrets = []) {
  const value = String(text ?? '');
  if (!value) return null;
  // SENSITIVE_RE 沒有 g flag，test() 不會有 lastIndex 狀態。
  if (SENSITIVE_RE.test(value)) return 'sensitive-pattern';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim().length >= 8 && value.includes(secret)) return 'known-token';
  }
  return null;
}
