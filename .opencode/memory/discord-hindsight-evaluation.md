---
name: discord-hindsight-evaluation
description: Hindsight 與 dc-bridge 記憶及歷史檢索的適配評估
---

評估結論（2026-11-17）：不導入 Hindsight，也不以它取代橋接的記憶。當時測試機資料量約 49 位群友、105 條事實（20 KB）、106 條頻道筆記、3 條群知識；現有 JSON 記憶沒有額外模型呼叫。

- 既有記憶的資料邊界在橋接：封鎖／忽略名單、私聊限制、敏感資訊閘門、使用者 keying 與標記清洗。Hindsight 的 bank/tag 隔離不能取代這些規則。
- Hindsight 的 retain 會再用 LLM 抽取事實、實體與關係；可能增加延遲與成本，也多一層內容歸納。它較適合需要語意、BM25、圖與時間檢索的長期記憶，不適合直接替換現有明確、可控的短事實。
- Hindsight MCP 預設無認證，單一 bank endpoint 會註冊大量工具；若之後試用，必須先設定認證並限制工具面，不能把開放端點直接暴露。
- 歷史檢索量測顯示當時配額未撞、`search_history` 零結果率低；摘要 7 天、事件筆記 30 天後過期是長期檢索缺口。使用者於 2026-11-17 後續核准另做 Qdrant 原始訊息歸檔，保留 360 天；這不代表採用 Hindsight，詳見 [[discord-history-archive]]。
- 2026-11-17 驗證 oMLX embedding 模型 `bge-m3-mlx-fp16`，向量維度 1024；API key 僅在安全呼叫的環境變數使用，未記錄憑證。
- 2026-11-17 在測試機確認 Qdrant 1.19.1 可用，已有 `personal_memory_v2` collection；歸檔需用獨立 collection。當時 Qdrant 監聽所有介面且無認證，未見後續加固紀錄；啟用前先重查並限制存取。

Hindsight 部署細節會隨版本變動；實作前應查專案內 `hindsight-docs` skill 的最新 `installation.md`、`configuration.md`、`mcp-server.md`。相關：[[discord-memory]]、[[discord-history-quota]]、[[discord-channel-notes]]、[[discord-history-archive]]。
