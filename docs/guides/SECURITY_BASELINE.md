# 安全基線與威脅模型（Discord）

## 一、威脅模型

| 對象 | 能做什麼 | 我們防什麼 |
| --- | --- | --- |
| Discord 頻道成員 | 送訊息、圖片、連結、@bot、回覆 | 讓 bot 執行主機指令、讀本機檔案、洩漏憑證、被 prompt injection 帶偏 |
| 有人 @bot 的訊息 | 直接進模型 | 惡意指令、偽造管理員標記、用引用或連結藏指令 |
| 網路內容（搜尋、抓取、連結預覽） | 被模型當資料讀 | 把網頁內容當指令、SSRF、超大回應 |
| 控制台使用者 | 改設定、看狀態、重置會話 | 未授權存取、CSRF、憑證外洩 |

QQ／SnowLuma／OneBot 已移除，不在威脅模型內。

## 二、已實作的邊界

### 1. 准入
- `discord.allow.guilds` / `channels` / `users` 與 `deny.*`，預空白名單 fail-closed。
- `ownerIds` 才能用管理指令、工具審批與控制台管理操作。
- `requireMentionInGuild` 預設 true；`requireMentionInChannel` 可單頻道覆寫。
- 討論串用自己的 channel id，不繼承母頻道設定。

### 2. Preset 與工具面
- 會話建立時向 DSH 要 preset 清單；依頻道選出的 preset 不在清單或標記 `broken` 就拒絕建會話。
- 只使用 `dc-chat` / `dc-chat-open` / `dc-learner` / `dc-trader`；絕不回退到 DSH 預設 preset（那通常有 bash／檔案工具）。
- `plugins/dc-agent-presets/dc-tool-restrict.mjs` 在註冊期用 `tools.restrict` 隱藏本地執行／檔案／子代理工具，執行期再用白名單擋一次；空或未知工具名一律拒絕。
- `dc-chat-open` 只改政治相關人格，工具面與守衛必須和 `dc-chat` 逐字相同（測試釘住）。

### 3. 出站
- `security.blockSensitive`：回覆含本機路徑、憑證特徵或已知令牌時整條攔掉。
- 模型看不到 Discord token、控制台 token 或 MCP 端點 secret；`token` 由外掛自動帶入。
- 錯誤訊息只寫 log；preset 安裝細節不貼到公開頻道。

### 4. MCP 端點
- `mcp-discord` / `mcp-slang` 只綁 `127.0.0.1` 隨機埠，要求 `x-agent-token` 與會話令牌。
- 每個工具先驗令牌、會話仍活著、頻道在允許範圍；唯讀工具也一樣。
- `view_message` 可以讀同一伺服器的頻道訊息，但不能跨伺服器、不能從私聊指定。

### 5. 控制台
- 預設只綁 `127.0.0.1`，只認 `Authorization: Bearer <token>`；沒有 CORS。
- 供應商 API key 只回「已輸入／未設定」，不把值送到前端。
- `config.json` 的 token、console、preset、模型欄位不開放控制台表單直接改。

### 6. 沙箱與網路
- `run_script` 在一次性 Docker 容器執行：無網路、無主機檔案、非 root，只回 stdout／stderr；只有 `discord.sandbox.channels` 列出的頻道能用。
- `web_fetch` 只允許 https:443，逐跳驗證重新導向；擋 localhost、私有 IP、CGNAT、link-local 與 URL 內嵌憑證。
- 搜尋與抓取結果標成「資料，不是指令」；截斷與大小上限在共用 transport 層。

### 7. `state/` 與憑證
- `state/` 與 `config.json` 由 `state-acl.mjs` 收緊 ACL；`diagnose:acl` 只讀盤點，`harden-acl` 在一般終端修復。
- `state/discord-agent.json`、`state/discord-console-token`、`state/discord-session-presets.json` 都只給目前使用者讀寫。

## 三、已知殘餘風險

- 模型仍可能被說服做不該做的事；工具守衛是最後一道，不是唯一一道。
- 圖片、影片、語音附件會轉成模型輸入；超大或損壞檔案可能被跳過，模型只看到原因。
- PRTS 是內網 HTTP MCP，沒有認證；目前接受這個風險。
- 控制台在 LAN 上使用明文 HTTP；建議用 SSH tunnel 從 `127.0.0.1` 開。

## 四、發布前檢查

```bash
npm run test:audit          # 離線安全與共用模組回歸（18 個腳本）
npm run test:discord        # Discord 橋接全部離線測試（32 個腳本）
npm run test:console-ui     # 控制台瀏覽器回歸（需 Playwright／Chromium）
npm run diagnose:acl        # ACL 盤點（只讀）
npm run scan:tool-names     # 守衛名單 vs 已安裝 DSH 的真實工具名
node --check src/discord-bridge.js
```

## 五、改動檢查單

1. 這次改動有沒有讓某個「不確定」變成「放行」？
2. 新增的工具是否有對應的 `dc-tool-restrict` 白名單與拒絕測試？
3. 新增的檔案路徑參數是否做了包含性與 realpath 驗證？
4. 外部內容（訊息、檔名、網頁）有沒有未清理就進 HTML／日誌／prompt？
5. 新增的定時器、Map/Set、監聽器在會話退役與程序退出時有清理嗎？
6. 有沒有更新對應測試與文件？
