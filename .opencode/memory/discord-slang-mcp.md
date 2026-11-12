---
name: discord-slang-mcp
description: 黑話／頻道標籤 MCP（mcp-slang）與候選確認流程
---

獨立的 `mcp-slang` 伺服器，提供 `lookup_slang`、`record_slang`、`record_channel_tag`。

- 記錄為候選，待管理員在控制台確認；已收錄過的回「已收錄過」。每個頻道（候選＋已確認）最多 5 條風格標籤，滿了 `record_channel_tag` 回 409。
- 橋接端點與 store helper、工具白名單、persona 說明已接好。
- 已部署並測試。

行為細節（2026-10-28）：
- 跨伺服器：已確認的詞跨伺服器共用；候選與已拒絕只回同一個伺服器（私聊只看得到已確認）。`record_slang` 遇到別服候選只回「已收錄過」，不帶意思（`hidden`）。
- 子字串比對：兩個方向都用 `saidTerm` 邊界，單字詞要完全相同才中；`gg` 不中 `eggs`。
- 去重：`findSlangEntry`／`findStyleEntry` 同詞多筆時優先回非 rejected；`lookupSlang` 以正規化詞去重，已確認優先；`recordSlang`／`recordChannelTag` 已存在就原樣回傳，不改意思、不累加 seen、不復活 rejected。
- 長度：儲存時 `term`／`tag` 截到 24 字；MCP schema `term` 上限 40 字（對齊橋接 40 字截斷）。
- 一輪最多呼叫 3 次（重送／「已收錄過」也算）。
- 已知限制：候選沒有 `origin`／來源欄位，控制台分不出模型或學習會話收的；`findSlangEntry` 在本服拒絕、別服有候選時仍回候選；敏感字比對沿用 `body.token`（令牌大小寫變體不是真密鑰）。

容量重設計（2026-11-12）：
- `confirmed` 不再裁剪；`rejected` 不過期；只裁候選（`maxCandidates`，預設 200）。`maxConfirmed` 已移除。
- 載入超過 32MB 只警告、照常載入；成功載入後留 `.bak`，壞檔時舊 `.bak` 改名成 `.bak-<timestamp>` 保留。
- 線上事故：500 筆 confirmed（480 黑話 + 20 風格），其中 253 筆 `seen=1`，被新確認的詞擠掉後又回到候選重審。若同一批 confirmed 有重複詞，`seen` 可能加到另一筆，影響可忽略。
- 學習會話 log 有 1356 場，抽出「不在詞庫」的黑話 1640 個、風格 443 個；黑話只有 87 個被提議 ≥2 次。分不出哪些是「曾核准後被丟」，不要整批匯入成候選。

相關：[[discord-console-table-layout]]、[[discord-dev-feedback-console]]、[[discord-channel-notes]]。