---
name: discord-video-subtitles
description: view_message 的 YouTube 連結影片字幕支援：yt-dlp、VTT 解析、章節、直連網址、縮排、白名單
---

`view_message` 訊息文字裡有白名單 YouTube 連結（YouTube、`m.youtube.com`、`youtu.be`、`music.youtube.com`、`youtube-nocookie.com`）且 `videoLinks.enabled` 時，橋接跑一次 yt-dlp（`--skip-download --write-subs --write-auto-subs --print ... --no-simulate`）。

- 取字幕檔（VTT）、標題、長度、章節、簡介，以及直連串流網址（360p）；再用同一套 ffmpeg 抽 6 格拼圖。
- 字幕與影片資訊是文字，不受 `media.enabled` 與圖片名額限制；只有抽格受這兩個條件管。不會把整支影片下載下來；抽格窗口跟影片附件一樣（`media.maxVideoSeconds`）。
- `--print` 用欄位子集語法，缺章節的影片不會印出 `NA` 讓整份 JSON 壞掉；`--ignore-config` 擋掉使用者設定檔的 `-P`；`-I 1` 讓純清單網址只處理第一支；`--ignore-no-formats-error` 讓抽格選不到格式時字幕仍拿得到。
- VTT 解析：`parseVtt` 去掉時間軸與標籤、YouTube 自動字幕的滾動重複句只留一次；語言偏好依序 `zh-TW` → `zh-Hant` → `zh-CN` → `zh-Hans` → `en`（逗號分隔才會照這個順序下載）。
- 字幕每行縮排（defang + `\n` → `\n  `）避免偽造橋接的結構行；超過 12000 字只取前段並註明；字幕區塊以「影片字幕結束」結尾。
- 部分字幕被 YouTube 429 擋下時退出碼不是 0，但已寫出的字幕照用。
- yt-dlp 整支失敗（私人影片、會員限定、地區鎖、直播、沒裝）只多一行「影片連結看不了：原因」。
- 白名單是防 SSRF：yt-dlp 會連原站，不能讓群友丟任何網址就讓伺服器去抓。抓 YouTube 違反其服務條款，要不要開由管理員決定；預設關閉，yt-dlp 要自己定期更新。
- 部署：2026-11-07 部署，遠端 yt-dlp 2026.10.21 實測抓到 `zh-TW` 6254 字字幕 + 10 章節 + 直連網址；MCP `listTools` 30 個工具，`view_message` 描述含「字幕」。
- 測試：`scripts/test-discord-bridge.mjs`（`parseVideoMeta`、`pickSubtitleFile`、`parseVtt`、`clipTranscript`）。
- 相關：[[discord-message-preview]]、[[discord-web-fetch]]。