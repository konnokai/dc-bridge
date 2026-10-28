// web_fetch 的結果判斷：什麼時候把 body 交給模型、什麼時候只回一句「打不開」。
//
// safeFetch 對 4xx／5xx 不會丟錯，而是回 { url, statusCode, truncated, body }。
// 直接把 Cloudflare 驗證頁的 HTML 當正文交出去，模型就會拿驗證頁的文字拼答案；
// 這裡把「被擋住」「其他錯誤」和「正常內容」分開，讓工具回 isError 而不是一大段 HTML。
// 只做純判斷，測試用假回應，不打真網站。
// 訊息用簡體：這個 MCP 是 Discord 與 QQ 共用的，檔案其他字串也是簡體。

// Cloudflare 的 JavaScript Detections 會把 challenge-platform 的 script 塞進**正常頁面**，
// 所以不能只憑這個字樣判定；只認驗證頁獨有的標記與標題。
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const CHALLENGE_TITLES = [/just a moment/i, /attention required/i, /checking your browser/i];

/** 看起來像 Cloudflare 之類的機器人驗證頁。只看前 6000 字，不整份掃大頁面。 */
export function isChallengePage(body) {
  const head = String(body ?? '').slice(0, 6000);
  if (!head) return false;
  if (head.includes('_cf_chl_opt') || /\bcf-chl\b/i.test(head)) return true;
  const title = TITLE.exec(head)?.[1] ?? '';
  return CHALLENGE_TITLES.some((pattern) => pattern.test(title));
}

/**
 * @param result safeFetch 的回傳 { url, statusCode, truncated, body }
 * @returns {{ isError: boolean, text: string }}
 */
export function fetchVerdict(result) {
  const status = Number(result?.statusCode);
  if (isChallengePage(result?.body)) {
    return {
      isError: true,
      text: `被网站的机器人验证挡住，没有拿到正文（HTTP ${status || '未知'}）。不要用搜索摘要拼出这页的内容；需要就换来源，或直接说打不开。`,
    };
  }
  if (status === 403 || status === 503) {
    return {
      isError: true,
      text: `网站拒绝访问（HTTP ${status}），没有拿到正文。不要用搜索摘要拼出这页的内容；需要就换来源，或直接说打不开。`,
    };
  }
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    const hint = status === 404 ? '页面不存在或已删除。' : '网站没有回正常内容，直接说打不开。';
    return { isError: true, text: `抓取失败：HTTP ${status}。${hint}` };
  }
  return { isError: false, text: JSON.stringify(result, null, 2) };
}
