---
name: discord-agent-extras
description: Discord 代理額外工具與行為：收回 reaction、常用表情統計、回訪排程、發言頻率與送出回饋
---

- `remove_reaction`：只收回 bot 自己按的 reaction，額度獨立（一輪 3 次）；persona 統一「通常 1 個，最多 3 個」。
- 常用表情（K）：`search_emojis` 的 `query` 留空按使用次數排序；只記目錄裡的表情；同一則訊息同一表情算一次；每伺服器上限 500 個 id；計數 gated on `cfg.discord.emoji.enabled`（關閉時不記）；持久化 `state/discord-emoji-usage.json`（version 1，存檔時丟掉目錄已沒有的表情）。
- 回訪（I）：`schedule_followup` 2–43200 分鐘（2 分鐘～1 個月，1 個月以 30 天算），每個 key 每天最多 6 個；已拿掉「同一個 key 同時最多 2 個」與 chatty 頻道每天 2 次的特殊上限；另外加 `FOLLOWUP_MAX_ENTRIES = 500` 的總筆數保險（避免排程檔長到 1MB 讀檔上限、重啟時整份備份重建）。`/reset` 取消，但 `/reload-system-prompt` 不取消（回訪跟著 key 留著）；安靜期間延後；DSH 暫時不可用就放棄。到點只送【回訪】提示，模型自己決定要不要說話。伺服器 `followup.enabled: true`。`note` 經 `defang`；`runFollowups` await 後 race check（`isBusy` 或 `remove` 失敗就跳過）；`resolveChannel` 失敗丟掉並 log 一次；安靜時 `deliverPrompt` restore 並重試。回訪 prompt 尾端加一行 `formatTimeContext()`（【現在】），隔幾天的回訪才判斷得出今天日期。時間顯示統一走 `formatFollowupDelay`（分鐘／小時／天）；控制台 `fmtWait` 同步。MCP schema 2~43200。已部署 commit b70a545（2026-11-10）。
  - 持久化：`state/discord-followups.json`（version 1），啟動時 `loadFollowupFile` 載入；每次 add/remove/restore/forget 觸發 `onChange` → `saveFollowupFile`。壞檔／版本不符／`null` 會先 rename 成 `.corrupt-*` 再從空的重建；讀檔失敗（非 ENOENT，如 EACCES）回 warning、從空的開始，不讓橋接啟動時當掉。檔案上限 1MB。停機超過 30 分鐘的回訪重啟後丟掉（含安靜期間延後的）。
  - `nextId` 會從存檔的 `nextId` 接續（`Math.max`），避免全部送完再重啟時 id 從 f1 重跑、讓控制台舊分頁按取消誤刪新回訪。
  - 提示文字：`formatFollowupPrompt({ minutes, note, at }, { openTopic, now })`；停機後補送時用 `at` 重算實際經過分鐘數（`Math.max(1)` 擋時鐘倒退）。chatty 頻道回訪 `openTopic=true`，可直接開新話題。
  - 每輪可見性：`formatFollowupStatus(entries, { now, max=3 })` 注入批次與回訪回合（reminder/system 回合不帶），最多 3 筆、note 截 24 字，讓模型知道還排著哪些。
  - 控制台：`GET /api/followups` 回 `{ enabled, items }`（id/key/where/note/minutes/at/scheduledAt/remainingMinutes）；`POST /api/followups/delete` body `{ id }`，id 須 `/^f\d+$/`（否則 400）、找不到 404；取消按鈕在「回訪排程」卡片，按前 confirm，404 視為已取消只 refresh、不 alert。HTML 每次請求重讀，不用重啟 bridge。
  - 已知缺口：`restore` 不檢查名額（安靜延後可能暫時 3 個）；取消只單筆，要清整個會話仍用 `/reset`。
- 發言頻率與回饋（B）：
  - B1 發言頻率：每 key 一個 10 分鐘滑動視窗，記時間與是否 bot；在 `handleMessage` 最頂端（所有 early return 之前）記入站訊息；bot 訊息在 `send`／`poll` 成功時記。批次 prompt 的【現在】後加 `你最近 10 分鐘送了 N 則；這段時間頻道共 M 則`，M < 3 不顯示。
  - B2 安靜：MCP `set_quiet(token, minutes, reason?)`，minutes 0 提早結束、1~120；安靜期間非 ★ 批次不投遞（省 token）、★ 照常；黑話語料仍收、橋接自動 reaction 暫停；結束時清 `primedKeys` 讓下一批重新帶頻道上下文；prompt 顯示 `（你設了安靜到 HH:MM）`；控制台會話列表顯示安靜截止；狀態只在記憶體，bridge 重啟清掉。`/reset` 也應 `quiet.forget`（已知缺口：目前沒呼叫）。
  - B3 送出回饋：`send_message`／`send_sticker`／`create_poll` 回 `已送出到 #頻道名。這則的訊息編號是 #xxxx（之後改、收回、看反應用這個）`（多則列出每個編號）。bot 自己送出訊息上的 reaction 存 per key（最多 10 則，同則合併），下一批 prompt 開頭加 `【你的訊息收到的反應】#xxxx 😂×2、:kekw:×1`，只出現一次、不觸發回合。需 `GuildMessageReactions`+`DirectMessageReactions` intent 與 `Message`/`Reaction` partial；`createAgentSender.ownedKey(messageId)` 判斷是否 bot 自己送的。
  - 已知缺口（review 未修）：reaction 處理先 `reaction.fetch()` 才查 `ownedKey`，高流量伺服器可能被 rate limit；`Partials.Message` 會讓引用訊息變成 partial（`referencedMessage` 要 `!cached.partial` 才用）；`quiet.forget`／`activity.forget` 目前無呼叫端（dead code）；自由參與模式下安靜期間被 @ 的批次仍缺頻道上下文（條件應加 `quietAt`）；reaction 清單可能少報（peek→clear 競態）。
- A：訊息帶「誰在對誰說話」標記（commit 99e2c99）。
- A 守衛：`send()` 遇到 content 只有一個可解析的 #編號回 400，擋掉把訊息編號當正文送出；persona 第 23 行與 `docs/guides/DISCORD.md` 同步；測試 4 項（純編號擋、連 reply_to 一起擋、正文夾編號放行、查不到的編號放行）。

相關：[[discord-quiet-gate]]、[[discord-trigger-stats]]。