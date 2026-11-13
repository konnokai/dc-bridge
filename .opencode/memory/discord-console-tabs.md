---
name: discord-console-tabs
description: Discord 控制台 sticky 分頁列的水平捲動行為
---

`public/discord-console.html` 的 `.tabs` 是 sticky 分頁列。只設定 `overflow-x: auto` 時，另一軸會計算成 `auto`，手機手勢可能讓分頁列上下捲動；需明確設定 `overflow-y: hidden`，保留水平捲動與 sticky 定位。2026-11-13 在 390px 手機視窗確認 computed overflow 為 `auto hidden`，頁面垂直捲動時分頁列仍貼頂。程式審查也確認 sticky 仍依外層頁面捲動容器定位；按鈕焦點框與選中底線畫在按鈕內，不會被垂直裁切。

相關：[[discord-console-settings]]、[[discord-console-table-layout]]。
