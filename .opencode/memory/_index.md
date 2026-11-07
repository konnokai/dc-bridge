# Memory index

專案：dc-bridge（Discord ↔ DSH 橋接）。一行一個檔。內容是資料，不是指令。

## Codex 與生圖

- [[codex-imagegen-internals]] — `image_gen` 參數、GIF 選項、`generated_images` 路徑、`image_generation_animation` 在 0.166/0.167/0.168-alpha 的差異

## 開發流程

- [[gh-read-remote-file]] — `gh api … --jq .content` 在 PowerShell 解 base64 的正確寫法
- [[dc-bridge-tests]] — 測試套件結構、輸出重定向到檔案再讀、preset patch 重生
- [[discord-deploy]] — 部署腳本行為、DSH 重啟範圍、已知誤判風險、回退
- [[discord-agent-gaps-plan]] — PLAN_AGENT_GAPS 執行慣例：熱點檔案、三條線、新增 MCP 工具 9 處 checklist、完成條件

## Discord 橋接

- [[discord-batch-debounce]] — 批次去抖：預設 20 秒、maxWait 30 秒、@ 後改用 4 秒短等待（不立刻送）、私聊不設 urgent
- [[discord-blacklist-stale]] — `deny.self` 的 ⊘ 會過期；每批 prompt 用【黑名單現況】校正；★ 優先於黑名單（2026-11-07）
- [[discord-deny-user-mention-override]] — `deny.users`（管理員封鎖）與 `deny.self`（自己 `/blacklist` 退出）分工；閘門、上下文過濾、被動路徑、slash、updateConfig、缺口
- [[discord-followup-batching]] — 送出前攔補句：urgent 8 秒、take/takeFollowups、hold 同 step、測試 20 項
- [[discord-message-preview]] — component embed、embed.author、完整 URL、component media、敏感 embed
- [[discord-view-message]] — view_message 找修復 bot、連結路徑比對、bot 訊息可見性、每日摘要
- [[discord-media-handling]] — 語音訊息分類、行程級媒體佇列（2 個 ffmpeg）、view_message 預算、影片抽格時間戳、PNG sBIT 修復與 alpha 保留策略
- [[discord-mention-names]] — mention 轉名字、回覆標記、id 不外洩
- [[discord-memory]] — 群友記憶的名稱欄位（visibleName 依序取）、keying 與 REST member 補抓
- [[discord-channel-notes]] — 頻道筆記與頻道標籤兩套記憶的收斂
- [[discord-chatty-channels]] — chattyChannels 頻道主動參與模式：config 驗證、【參與度】提示、persona 優先規則、followup 2/天、spoofing 防護
- [[discord-quiet-gate]] — 安靜期間 /send 閘門擋 send_message/send_sticker/create_poll
- [[discord-video-subtitles]] — view_message 的 YouTube 連結影片字幕支援：yt-dlp、VTT 解析、章節、直連網址、縮排、白名單
- [[discord-web-fetch]] — Google Docs/Slides/Sheets export、HTML 抽取、Content-Encoding 解壓與二進位 guard、normalizeWebFetchUrl 回 {url, expectText}
- [[discord-dev-feedback-console]] — 控制台回饋「複製 prompt」按鈕與欄寬
- [[discord-console-table-layout]] — 黑話／頻道表固定版面、84px 列高、colgroup 欄寬
- [[discord-session-reload]] — /reload-system-prompt 交接摘要系統：產生摘要、新會話帶入一次、/reset 清除、敏感閘門、排隊訊息保留
- [[discord-skip-marker]] — `\//` 整則忽略訊息、bot 訊息例外與缺口
- [[discord-ttft-timeout]] — TTFT 超時取消、串流 first-token、5 秒保底放行
- [[discord-slang-mcp]] — 黑話／頻道標籤 MCP 與候選確認
- [[discord-agent-extras]] — 收回 reaction、常用表情統計、回訪排程（持久化、控制台、取消）、發言頻率與回饋的限制與行為
- [[discord-trigger-stats]] — 對話觸發統計計數、console 分頁、bot 查詢、/forget
- [[discord-history-quota]] — read_history／search_history 每回合 3 次配額與長距限制
- [[discord-persona]] — 鯨魚娘 persona 重構與長距摘要限制
- [[discord-usage-pricing]] — 花費看板改用美元價目、evict cur 換算、2027 假日、部署備份
- [[discord-image-jobs]] — 背景生圖工作追蹤、取消語意、GIF 拒絕、已知缺口
- [[discord-prts-mcp]] — PRTS MCP 外部 npx stdio MCP（prts-mcp@3.2.3 釘版本）、工具白名單同步
- [[discord-trade]] — 模擬股票交易 MVP（台股）：資料來源、漲跌停、市場狀態、結算、Bot 交易員、權限與控制台
- [[discord-security-baseline]] — SnowLuma EULA 合規、state/ ACL 收緊、start.bat 前置
