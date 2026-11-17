---
name: discord-history-quota
description: read_history／search_history／recall_history 每回合合計最多 3 次的配額與長距查詢限制
---

`read_history` 與 `search_history` 共用每回合 3 次配額（`HISTORY_PER_TURN_LIMIT = 3`，`src/core/discord-agent.mjs`）。

- `recall_history`（2026-11-17 新增）也透過相同歷史查詢路徑，與 `read_history`、`search_history` 共用這 3 次，不另開配額。

- 第 4 次回 429。
- `search_history` 每次掃 300 則（3 頁）。
- persona 規則：長距懶人包類請求（例如「昨天晚上八點到現在」）要拒絕或限制在 1–2 次搜尋，避免卡住其他對話。
- 兩個工具都支援 `date` 參數（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，bridge 主機時區，`parseHistoryDate` 在 `src/core/discord-context.mjs`）；`date` 與 `before` 互斥。`date` 轉成 snowflake（`SnowflakeUtil.generate`，時間夾到 Discord epoch 以上）當起點。`read_history` 有 `date` 時往前（舊→新）讀；沒有時往回讀。`search_history` 有 `date` 時從該時間起掃。
- `date` 在未來直接回「還沒有訊息」；無效日期回 400。
- `search_history` 只比對內文、貼圖名稱、連結預覽標題，**不含發言者名字**；要用人篩選請用 `from=#編號`（編號必須本輪 prompt 或 read_history 出現過）。
- bot 訊息不被 `\//` 跳過規則過濾，搜得到；但只發連結預覽／圖片的 bot（ermiana、修復 bot）`content` 為空，只有 embed 標題能比對。
- 熱門頻道一天可能 900 則，300 則窗口可能只涵蓋幾小時；`date` 只給到日會漏掉，應給到小時。回傳文字目前只寫「最近 300 則」，沒標窗口起點（已知缺口）。
- 配額打滿回 429，下一輪自動歸零；測試時別把正式頻道額度打滿。

使用量量測（2026-11-17 測試機 DSH session logs；早於 `recall_history` 上線）：

- 45,966 回合中，`read_history` + `search_history` 共 3,699 次（每 100 回合約 8 次）；沒有找到「一輪已經翻歷史紀錄 3 次」的配額錯誤。
- 1,716 次 `search_history` 中，零結果 8 次（0.5%）。因此當時沒有提高配額或新增 guild 搜尋零結果後的 OR 掃描；原先假設 AND 搜尋常失敗不符合量測。
- 歷史超過一個月查不到的根因是資料保留期：每日摘要 7 天、事件筆記 30 天。當時的量測早於 Qdrant 歸檔核准；目前歸檔決策見 [[discord-history-archive]]。

相關：[[discord-skip-marker]]、[[discord-mention-names]]、[[discord-hindsight-evaluation]]。
