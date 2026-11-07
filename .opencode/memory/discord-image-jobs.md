---
name: discord-image-jobs
description: 背景生圖工作追蹤、取消語意、GIF 拒絕、send_image 送圖與畫圖外掛路徑鎖
---

橋接的 `generate_image` 實際由 Codex `image_gen` 在背景跑，橋接端用
`src/core/discord-image-jobs.mjs` 追蹤工作（start/poll/done/cancel/stale sweep）。

## 取消語意

- `mcp__discord__cancel_image` 刪掉該頻道所有還在跑／排隊中的工作（`cancelImageJobs`）。
- 外掛下一次 poll 回 `cancel:true`，Codex 中止；取消後才送的 `done` 回 404，不排進會話、不記畫圖歸屬。
- 取消後 `sweepStaleImageJobs` 回空，不會送假的失敗通知。
- 已知缺口：`src/discord-bridge.js:1954` 的 `cancelImage` 仍是行內寫法，只有核心函式測試，沒有端點測試。

## GIF

- Codex 不支援 `image_generation_animation` 時，`animated:true` 在 spawn 前就拒絕，不回報 start。
- 靜態生圖的 `extraArgs` 不含 `--enable`；GIF 才加 `--enable image_generation_animation`。
- `plugins/dc-agent-presets/dc-draw-image.mjs` 用 `spawnSync` 問 GIF feature（最多卡 10 秒，失敗會快取）；
  只看 `result.file` 判斷是否 GIF（0.168 實際輸出格式未確認，屬推測）。

## Codex 額度閘門

- `CODEX_DRAW_MIN_FIVE_HOUR_PERCENT = 15`、`CODEX_DRAW_MIN_WEEKLY_PERCENT = 5`（`src/core/discord-codex-quota.mjs`）；快照寫 `state/discord-codex-quota.json`（可用 env `DC_CODEX_QUOTA_FILE` 覆寫），`plugins/dc-agent-presets/dc-draw-image.mjs` 的 `drawQuotaBlock()` 讀它。
- 快照 10 分鐘內有效；缺檔／壞檔／過期／未來 timestamp 都 fail-open；查詢失敗或快照寫入失敗不影響額度查詢。
- 快照欄位：`fetchedAt`、`drawAllowed`、`drawBlockedReason`、`fiveHour.remainingPercent`、`weekly.remainingPercent`。
- 進 queue 前與真正開 Codex 前各查一次額度。
- Codex 生圖固定 read-only 沙箱、workdir `state/discord-imagegen-work`、extra args 關掉 `shell_tool`／`unified_exec`／`view_image` 並加 `--ignore-user-config --ignore-rules --ephemeral`；`inputImage=self` 換成角色設定圖；`outputDir` 鎖在 `state/discord-images`。
- `plugins/dc-agent-presets/codex-imagegen-wrapper.mjs` 在 exec 前拿掉 adapter 的 `-s`，改用 permission profile：`:root=read`、`/mnt=deny`、`$CODEX_HOME=write`。目前用 `spawn`（PID 未取代）；reviewer 建議改 `process.execve()`，讓 adapter 逾時／取消時殺到的就是真 codex。dotted key 要不帶引號（`filesystem./mnt=deny`），帶引號的路徑 Codex 會拒絕啟動。

## 送圖（send_image）

- MCP 工具 `mcp__discord__send_image`：`file`（完整路徑或檔名）、可選 `content`／`reply_to`；只讀 `state/discord-images`。
- `resolveGeneratedImage(imageDir, file, { maxBytes })`（`src/core/discord-media.mjs`）：只取 basename，拒絕 `..`／絕對路徑逃逸；檢查檔案存在、PNG magic、≤10MB（預設 10MB）；假圖片／超限回明確錯誤。
- 走 `agentSender.send` 同一條佇列與「一輪 5 則」上限；Discord 回 50013（無 Attach Files）會轉成「bot 沒有附加檔案權限」錯誤。
- DSH 與橋接必須在同一台機器：`send_image` 用本機路徑讀圖片目錄。
- `resolveGeneratedImage` 回 `{path, name, buffer}`（lstat + `O_NOFOLLOW` + fstat + Buffer 讀取，拒絕 symlink、非檔案、超 10MB、非圖）；`sendLong` 上傳 `{attachment: buffer, name}`。
- MCP schema `file` 必填；觸發統計計數包含 `send_image`。
- 測試：`scripts/test-discord-bridge.mjs` 有 symlink 拒絕測試與實際 MCP 呼叫測試（`/send` 收到 `file`、結果含 #編號）。

## 畫圖外掛（dc-draw-image）

- `plugins/dc-agent-presets/dc-draw-image.mjs` 在 `tools/execute` 前改寫 `generate_image`：`inputImage` 只認角色代號或中文名（`self`、`大肥魚`、`glm`、`gpt`…），換成 `assets/ai-chan-sheets` 的三視圖；`outputDir` 固定 `state/discord-images`；可逗號帶多個角色（最多 4 個），其餘用 `-i` 依序傳給 Codex。
- `inputImage` 比對前先 NFKC／小寫／去空白與標點（含全形引號）；未知角色或路徑直接拒絕。
- manifest（`characters.json`）缺檔或壞掉時外掛仍可載入，`CHARACTERS` 為空、`SELF_SHEET` 為 null；指定角色時才報錯（`DC_AI_CHAN_MANIFEST` 可覆寫路徑）。
- `loadCodex()` 從 profile 的 `node_modules` 解析 `dsh-generate-image/lib/codex.js`（`createRequire(profileDir/package.json)`），fallback 直接 import；`DC_AI_CODEX_MODULE` 可覆寫供測試。
- `execute` 只認 manifest 裡的設定圖：manifest 白名單 + `realpath` + `isFile()`；`README.md`、`characters.json`、目錄、指向 assets 外的 symlink 都拒絕。
- 11 個角色 × 5 張圖（全板總覽、三視圖、表情、服裝、道具），共 57 檔、45.3MB。
- `setup-dsh.mjs` 在 Discord 模式下檢查 profile 有沒有裝 `dsh-generate-image`，缺就印警告（不自動連網安裝）。
- 設定圖授權 **CC BY-NC-SA 4.0（非商業）**；來源與署名見 `assets/ai-chan-sheets/README.md`。

## 守衛與 scoped 工具可見性

- `dc-draw-image` 註冊的 scoped `generate_image` 與 `dc-tool-restrict` 同屬 preset generation layer。若在 `denyList` 裡 restrict `generate_image`，會連 scoped 安全版一起藏掉 → 所有畫圖失敗。
- 因此 `allowImageGen` 時 **不** restrict `generate_image`；由 guard 檢查 `ctx.tools.get('generate_image', exec.agent)` 的 description marker（含 "shell and file writes disabled"）才放行。
- 外掛沒載入時：global unsafe `generate_image` 仍出現在 schema，但 marker 缺失 → guard fail closed，不會執行。
- `createSerialQueue()` 匯出供測試；所有 `generate_image` 共用一條 queue，`isConcurrencySafe:false`，避免兩個頻道撿到對方的圖。

## 安全邊界（Codex）

- Codex extra args：`--disable shell_tool --disable unified_exec --disable view_image --ignore-user-config --ignore-rules --ephemeral`。
- `plugins/dc-agent-presets/codex-imagegen-wrapper.mjs`：拿掉 adapter 的 `-s`，改用 permission profile（`-c default_permissions="dc-imagegen"`、`:root=read`、`/mnt=deny`、`$CODEX_HOME=write`）；`/mnt` 底下的掛載讀不到，其他本機路徑仍唯讀。
- permission profile 不只管 shell：extension tool 取得 permission-scoped filesystem，`image_gen` 的 `referenced_image_paths` 也受限制。
- prompt deny regex 也擋 `/mnt` 路徑；prompt 結尾追加「只用附圖，不傳 referenced_image_paths、不讀其他本機檔」。
- 殘存風險：`$CODEX_HOME=write` 讓 `apply_patch` 可改 `~/.codex`（reviewer 建議拿掉，image_gen 存圖不需要）；逾時／取消只 SIGKILL wrapper，真正的 Codex 子程序可能繼續跑（建議 `process.execve()`）。其他本機路徑仍是唯讀（`jun` 帳號自己的資料）。
- 文件不可過度承諾「模型碰不到其他本機檔案」；應寫「除 `/mnt` 外，其他本機路徑可能被 Codex 唯讀存取」。

## 邀請權限

- `INVITE_PERMISSIONS` 已加入 `AttachFiles`（`1n << 15n`）；bitfield 變 `563224831691840`（舊 `563224831659072`）。舊 bot 要重開一次 `/invite` 連結或管理員手動給權限。

## 測試

- `scripts/test-discord-bridge.mjs`、`scripts/test-discord-image-jobs.mjs`、`scripts/test-discord-codex-quota.mjs`。

## 多角色設定圖

- `plugins/dc-agent-presets/dc-draw-image.mjs`：`inputImage` 可用逗號帶多個角色代號，最多 4 個（`MAX_REFERENCES`）；第一張走 `inputImage`，其餘用 `-i` 依序傳給 Codex；prompt 補上「image N = 角色名」對照與「外觀衝突時依各自的設定圖」。
- `execute` 只認 manifest 裡的設定圖：manifest 白名單 + `realpath` + `isFile()`，`README.md`、`characters.json`、目錄、指向 assets 外的 symlink 都拒絕；內部用 ASCII 逗號串路徑（路徑含 ASCII 逗號會拆壞，已用 `shortcut:` 註記）。
- `plugins/dc-agent-presets/dc-tool-restrict.mjs`：guard 擋模型填路徑／超過 4 個角色，訊息「一次最多 4 個角色」；外掛沒載入時 fail closed。
- persona（`dsh/agent-presets/dc-chat/agent.cordis.yml` + patch）：多角色用逗號；畫指定角色時 prompt 只寫動作／表情／構圖／場景，長相交給設定圖。

相關：[[codex-imagegen-internals]]、[[discord-codex-quota]]。
