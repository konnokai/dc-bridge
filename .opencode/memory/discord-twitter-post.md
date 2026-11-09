---
name: discord-twitter-post
description: X／Twitter 貼文用 FxEmbed 公開 API 解析：模組、整合點、預算、媒體與測試
---

X／Twitter 貼文解析模組：`src/core/twitter-post.mjs`。原站與 fixvx／fixupx 轉址頁拿不到正文，改用 FxEmbed 公開 API `api.fxtwitter.com/2/status/<id>`（不用金鑰，貼文 ID 送第三方；限流 1000 次/分鐘/IP）。管理員指定此做法（回饋 `df_mw7etjk73dae52`）。

- 辨識：`POST_HOSTS` = `x.com`、`twitter.com`、`fixvx.com`、`fixupx.com`、`fxtwitter.com`、`vxtwitter.com`；`www`／`mobile`／`m` 前綴先去掉；路徑 `/status` 或 `/statuses` 後跟 2~20 位數字；`twitterStatusId(input)` 可從單一網址或一整段文字（含 Discord `<...>`／`||...||`）挑第一條；`firstTwitterPost(inputs)` 照傳入順序挑。`t.co` 短連結不解析（shortcut）。
- 抓取：`fetchTwitterPost(input, { fetch })` 固定打 `https://api.fxtwitter.com/2/status/<id>`，`allowHosts: ['api.fxtwitter.com']`、443、自訂 UA `dc-bridge/...`（FxTwitter 後面的 Cloudflare 會擋 Chrome UA）；回應體上限 200000。錯誤碼 401/403/404 → 不存在／已刪除／保護中；429 → 限流；非 200 → 服務錯誤；非 JSON → 沒回傳 JSON。不是 X 網址就不打 API。`fetchTwitterImage(url, maxBytes)` 走 `safeFetchBuffer`，`allowHosts: ['pbs.twimg.com']`。
- 解析：`parseTwitterPost(json)`：`status.type === 'tombstone'` 回原因；作者 `name`/`screen_name`；媒體優先 `media.all`，否則 photos+videos+external；每項 `type`（video/gif 其餘 photo）、`url`、`thumbnail_url`、`altText`/`alt_text`、寬高、duration。`twitterPostLines(post)` 印作者、handle、時間、推文內容、引用推文、敏感標記、每張圖/影片（影片帶長度 `mm:ss` 與縮圖）；敏感只回文字不附圖。`twitterImageUrls(post, max)`：照片用原圖、影片用縮圖；只留 `pbs.twimg.com` 的 https；照片 `name=orig` 改 `name=medium`；去重；上限 `max`；敏感時空陣列。
- `view_message` 整合（`src/discord-bridge.js`）：`tweetSource = firstTwitterPost([target text, replied text, ...fixMessages content])`；`tweetPromise` 與 Discord 附件下載並行；預算剩不到 12 秒就放棄，否則 `withTimeout(tweetPromise, min(20000, 剩餘), 'X 貼文')`；貼文行每行 `flat(..., 1501)` 截斷；敏感處理：連結預覽被 Discord 標敏感或貼文本身敏感時只回文字；有 `media.enabled`、有剩餘圖片名額、非敏感、連結預覽非敏感時，用 `twitterImageUrls(post, room)`（room = maxCount - images.length），檔名去重（修復 bot 預覽可能已附同一張 pbs 圖），`fetchTwitterImage` 抓位元組，`prepareMediaBlock`；圖片總預算 55 秒，剩不到 10 秒不抓。影片只附縮圖不抽格。
- `web_fetch` 整合（`src/mcp-web-search-safe.js`）：若 `twitterStatusId(url)` 有值，先 `fetchTwitterPost(url)`；失敗回 `isError: true`「抓取失败：原因」；成功回 `twitterPostLines(post).join('\n')`，不附圖。X 貼文不會抓 fixvx 轉址頁。測試：`scripts/test-discord-twitter.mjs`（離線）、`scripts/test-audit-security-mcp.mjs` 有 X 路徑與刪除貼文案例。
- 文件：`docs/guides/DISCORD.md`（view_message 與 web_fetch 段）、`docs/design/PLAN_AGENT_GAPS.md` S3 結論。無 config 開關；第三方資料暴露需告知。

相關：[[discord-view-message]]、[[discord-media-handling]]、[[discord-web-fetch]]。