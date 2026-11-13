---
name: discord-emoji-catalog
description: 自訂表情目錄的離開伺服器清理時機與失敗處理
---

- 表情目錄依伺服器存成 `state/discord-emoji/<guildId>.json`。橋接在 `ClientReady`、真正離開時的 `GuildDelete`，以及重新載入目錄後清理不在 `client.guilds.cache` 的伺服器；`available=false` 的暫時不可用不算離開。
- 全量執行 `scripts/build-discord-emojis.mjs` 也會刪除已離開伺服器的數字檔名目錄；指定 `--guild` 更新單一伺服器時不做全量清理。
- 檔案刪除失敗要記錄錯誤，不要假裝成功。下一次載入可能再次帶回舊目錄，因此載入後要再 prune。
- `pruneCatalogs(catalogs, guildIds)` 負責從記憶體目錄移除離開的 guild；`scripts/test-discord-bridge.mjs` 覆蓋該純函式。
