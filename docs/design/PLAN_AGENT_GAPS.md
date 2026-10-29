# 計畫：補上模型自己說缺的工具（dc-chat）

> 狀態：**2026-10-29 F1 完成（分支 `feat/discord-embed-gif`，還沒部署）**。D 與 S4 見對應章節；
> A、C、B、E、F1、K、I、G0、G1、J 已完成，H、F2 略過，剩 L、G2。完成度見下表。
> 檔案位置：`docs/design/PLAN_AGENT_GAPS.md`。
> 2026-10-28 起 `docs/design/` 已進版控，worktree 開的 session 也看得到。
>
> 來源：管理員在 DSH 上直接問 dc-chat 四次：「你還缺哪些工具或功能？」本文把四次回答合併，
> 再對照現有程式碼，拆成可以交給其他 session 做的工作包。
> 每個工作包都寫了「現在已經有什麼」，免得重做已經存在的東西。

### 完成度（2026-10-28）

| 工作包 | 狀態 | 依據 |
| --- | --- | --- |
| A 誰在對誰說話 | ✅ 完成 | `99e2c99` |
| C 收回自己的 reaction | ✅ 完成 | `f17d585` |
| D 歷史查詢按日期 | ✅ 完成 | `06ff403`，附帶 `a383f63`；**還沒部署** |
| B 發言頻率／安靜／送出回饋 | ✅ 完成 | `cc46448` |
| H 送固定的圖 | ⏭️ 略過 | 管理員決定不做 |
| E 頻道事件筆記 v1 + v2 | ✅ 完成 | `da12990`；控制台卡片 `ad42d9a` |
| F1 GIF 連結 | ✅ 完成 | 2026-10-29，分支 `feat/discord-embed-gif`，**還沒部署** |
| F2 影片 | ⏭️ 略過 | 管理員決定不做 |
| K 常用表情 | ✅ 完成 | `c590ad8` |
| I 回訪 | ✅ 完成 | `c590ad8` |
| G0 persona（連結先看預覽） | ✅ 完成 | `ad42d9a`、`a383f63` |
| G1 `web_fetch` 失敗講清楚 | ✅ 完成 | `ad42d9a` |
| G2 外部網頁備援來源 | ⬜ 未開始 | 等管理員決定來源 |
| J token 自動帶入 | ✅ 完成 | DSH 外掛 `dc-session-token`；DSH 鎖在 0.2.1-rc.2 |
| L 專門的資料來源 | ⬜ 等管理員 | — |
| S1~S4 探查 | S4 ✅ 完成；S2 有結論（見 F1）；S1 ⬜ 未做；S3 略過 | 見第 2 節 |

額外完成、不在原工作包裡：`556a98f` 擋掉把訊息編號當成 `content` 送出；
`01ff4b3` 專案整理成 Discord 優先並把部署改成 git；`889e2af` 頻道風格只收穩定習慣、每頻道上限 5 條。

---

## 0. 交辦方式（先讀）

### 0.1 熱點檔案與執行順序

幾乎每個工作包都會改到下面這些檔案。兩個 session 同時改，一定會衝突：

- `src/discord-bridge.js`（`agentHandlers`、`buildBatchPrompt`、`handleMessage`）
- `src/mcp-discord.js`
- `src/core/discord-agent.mjs`
- `plugins/dc-agent-presets/dc-tool-restrict.mjs`
- `dsh/agent-presets/dc-chat/agent.cordis.yml`（persona）
- `docs/guides/DISCORD.md`
- `scripts/test-discord-bridge.mjs`

所以分成三條線。**同一條線一次只跑一個 session**。不同線可以同時跑，因為它們不碰同一批檔案。

| 線 | 內容 | 可以同時跑嗎 |
| --- | --- | --- |
| **探查線** | S1~S4（只讀，不改檔） | 可以，四個一起跑 |
| **網頁線** | G1 → G2（`mcp-web-search-safe.js`、`web-search.js` 的設定欄位；不改 `safe-fetch.js`） | 可以，跟 Discord 線不碰同一批檔案 |
| **Discord 線** | A → C → D → B → H → E → F1 → K → I（照這個順序，一次一個） | 不行，全部改熱點檔案 |

網頁線要改 persona 的那一行（G0），併到 Discord 線當下正在跑的那個工作包裡做，不要自己去改 persona。

### 0.2 新增一個 MCP 工具要改的地方（每個都要改，漏一個工具就會靜默失效）

1. `src/mcp-discord.js`：用 `tool()` 註冊。參數說明寫中文，照現有工具的語氣。
2. `src/discord-bridge.js` 的 `agentHandlers`：加路由。一定要先過 `agentSender.resolve(token)`。
3. `src/core/discord-agent.mjs`：有「一輪上限」就加進 `usedLimits`／`withQuota`。
4. `plugins/dc-agent-presets/dc-tool-restrict.mjs` 的 `DISCORD_TOOLS`：加**完整工具名**。
   這裡沒有前綴放行，沒列進去的工具會在執行期被拒絕。
5. `dsh/agent-presets/dc-chat/agent.cordis.yml`：persona 說明什麼時候用、什麼時候不用。
   改完跑 `node scripts/build-agent-preset-patches.mjs` 重新產生 `plugins/dc-agent-presets/presets/dc-chat.patch.yml`。
   **不要手改 patch 檔**。用 `--check` 確認產物和源一致。
6. `docs/guides/DISCORD.md` 的「誰決定要不要發訊息（MCP）」段：加工具說明。
7. 測試：可以離線測的邏輯放 `src/core/*.mjs`，測試寫在 `scripts/test-discord-bridge.mjs`
   或新的 `scripts/test-discord-*.mjs`。新增測試檔要登記進 `package.json` 和 `scripts/test-audit.mjs` 的 `tests[]`。
8. 需要新的 Discord 權限時：加進 `src/core/discord-core.mjs` 的 `INVITE_PERMISSIONS`（測試會對 bit 值）。
   需要新的 gateway intent 時：加進 `discord-bridge.js` 的 `intents`（目前在 2637 行附近）。
9. 部署：改了 persona／preset／MCP，要重跑 `npm run setup:discord`，並照這個順序重啟：
   `pm2 stop dc-bridge` → `pm2 restart dsh` → `pm2 start dc-bridge`。
   只改 bridge 就只重啟 dc-bridge，不用等聊天停下來。

### 0.3 每個工作包的完成條件

- 在自己的 branch 上做，跑過 `npm run test:discord` 和工作包自己的測試，並貼出輸出。
- `node scripts/build-agent-preset-patches.mjs --check` 通過（有改 persona 的工作包）。
- `DISCORD.md` 跟程式碼一致。
- **不 commit、不 push、不部署**，除非管理員明講。做到「branch 上測試通過」就停，回報結果。
  部署會直接改到線上的群聊 bot。
- **不要改這份文件**。這份文件不在 git 裡，好幾個 session 同時改會互相蓋掉。
  結論和「跟計畫不一樣的地方」寫在 session 最後的回報裡；探查結果太長時，寫到
  `docs/design/agent-gaps/<代號>.md`（例如 `S1.md`），一個 session 一個檔案。
  由管理員或主 session 合併回本文。

---

## 1. 需求來源（四次回答合併）

| 主題 | 提到的次數 | 對應工作包 |
| --- | --- | --- |
| 頻道或事件記憶、按日期查歷史 | 4 次中 3 次（第 4 次算「半個」） | E、D |
| 讀不到外部網頁（Cloudflare、X、FB、b23、fandom 都回 403） | 2 | G |
| 時間控制（定時回來看、延遲發送） | 3（第 3 次反對自己排程發言） | I（等管理員決定） |
| 看不到自己的發言頻率，送出後看不到結果 | 3 | B |
| 不知道誰在對誰說話 | 2 | A |
| 送圖 | 2 | H |
| 收回 reaction | 1 | C |
| 歷史查詢一輪 3 次不夠 | 2 | D（日期跳轉）＋第 5 節第 3 點（額度要不要提高） |
| GIF、影片看不到 | 1 | F |
| token 每輪手抄，抄錯整批失敗 | 1 | J（先探查） |
| 常用表情清單 | 1（第 4 次說「不要更多表情」） | K（低優先） |
| 搜尋品質差，想要專門資料源 | 1 | L（等管理員決定） |

### 1.1 不做（模型自己說不要，或成本太高）

- 管理權限：禁言、踢人、改暱稱。
- 更多人格設定、更多統計、更多指令。
- 線上名單／誰在線上：需要特權 intent `GuildPresences`，而且模型自己標為「半個」需求。
- 「誰正在打字」：需要 `GuildMessageTyping`，價值低，先不做。
- 讓模型自己排程發言（定時送出一段預先寫好的文字）：第 3 次回答明確反對。見工作包 I。

### 1.2 先更正一個誤會

第 3 次回答說「送出後的頻道 id 每則都不一樣」。這不是 bug。
`send_message` 回傳的是 `已送出到 <頻道名>（#編號）`（`src/mcp-discord.js` 的 `sentRefs`）。
括號裡是**這則訊息**的 `#編號`，每則本來就不一樣，模型把它當成了頻道 id。
工作包 B3 會把回傳文字改清楚。

---

## 2. 探查線（只讀）

每個探查都不改程式碼。結論寫在 session 的回報裡，或寫到 `docs/design/agent-gaps/S<n>.md`（見 0.3）。

目前狀態：S1、S4 已完成。S1 的結論在 `docs/design/agent-gaps/S1.md`，工作包 J 已照它做完。
S2 有結論，寫在 F1（批次送出時才讀 embed）；S3 等 G2 選來源（第 5 節第 2 點）。

### S1：token 能不能自動帶入（給工作包 J）

- 問題：`mcp-discord` 是 DSH 拉起的**單一** stdio 行程，所有會話共用，它不知道呼叫來自哪個會話。
  所以現在要模型每次手抄 `token`。
- 要查：`dc-tool-restrict.mjs` 裡 `ctx.tools.guard((exec) => …)` 收到的 `exec`：
  1. 有沒有會話 id（sessionId 或同等欄位）？
  2. 能不能改 `exec` 的參數（例如補上 `token`）再放行？
  3. 有沒有其他 DSH 插件掛點，能在 MCP 呼叫前改參數？
- 方法：讀已安裝的 DSH 套件原始碼（`scripts/dsh-modules.mjs` 可以幫忙定位），必要時寫一個只記 log 的 guard 實測。
- 停止條件：三個問題都有答案，或確認 DSH 不提供這個資訊。不要為了這件事改 DSH 本體。
- 現況（不用重做）：`tokenFor` 對同一個會話一直回傳同一個值，直到 bridge 重啟；比對時已經忽略大小寫和前後空白（`sessionForToken`）。

### S2：GIF 連結的預覽什麼時候出現（給工作包 F1）

- 問題：Tenor／Giphy 連結在 Discord 是 `gifv` 類型的 embed。`messageCreate` 當下 embed 可能還是空的，
  Discord 稍後才用 `messageUpdate` 補上。
- 要查：discord.js `^14.27`（看 `package.json`／`node_modules/discord.js/package.json` 的實際版本）
  在 `messageCreate` 時 `message.embeds` 有沒有 gifv；沒有的話，`messageUpdate` 補上的時間通常多久，
  跟目前批次的 debounce（`discord.batch.debounceMs`）比起來來不來得及。
- 方法：在測試伺服器貼幾個 Tenor 連結，記 log。結論寫進 F1。

### S3：外部網頁的替代來源（給工作包 G2）

依照 AGENTS.md，先查官方文件，不要憑記憶寫網址。每個來源都要寫：官方文件連結、條款或限流、需不需要 API key、
會把什麼資訊送給第三方。

- 通用備援：r.jina.ai、archive.today（可不可以程式呼叫、條款是否允許）。
- X／Twitter：有沒有不用登入就能拿推文正文的方式（例如 fxtwitter 類服務）。
- b23.tv 短連結：展開成 bilibili 網址的方法，以及 bilibili 有沒有公開的影片資訊端點。
- fandom：MediaWiki `api.php`（`action=parse`）能不能拿到條目正文。
- 另外確認：Discord 自己產生的連結預覽（embed）對這些網站有多少內容。`view_message` 已經能讀 embed。

### S4：discord.js API 確認（給工作包 B、C、D）

對照實際安裝的 discord.js 版本查文件或原始碼：

- 用時間產生 snowflake：`SnowflakeUtil.generate({ timestamp })` 的寫法與回傳型別。
- `messages.fetch({ after })` 回傳的順序。
- `messageReactionAdd` 需要的 intent（`GuildMessageReactions`）與 partials（`Message`、`Reaction`），
  以及 bot 重啟後對舊訊息的 reaction 還收不收得到。
- 移除自己的 reaction：`reaction.users.remove(client.user.id)` 或同等 API。

**結果（2026-10-28）**：
- `discord.js` 14.27.0 的 `SnowflakeUtil.generate({ timestamp, increment })` 回傳 **bigint**；`increment: 0n` 可用。
- `fetch({ after })` 回「游標後最舊的一批」，但排列仍是新→舊（實測 5 則）。往後翻頁用該批最新的 id，往前翻頁用最舊的 id。
- reaction intent／partials 與 `reaction.users.remove(client.user.id)` 已隨 B、C 上線，實際跑得動，不用另外查。

---

## 3. Discord 線（照順序，一次一個 session）

### A：誰在對誰說話（不新增工具）

**狀態：已完成（2026-10-28，commit `99e2c99`，已部署）。**

**現況**：
- `stripBotMention` 只去掉 @bot。其他人的 @ 會用原文 `<@123456>` 進 prompt，模型只看到數字。
  `<#頻道>`、`<@&身分組>` 也一樣。
- 「回覆了誰」只在引用訊息有快取、或有人叫 bot 時才會出現（`referencedMessage` 不會為沒叫 bot 的訊息打 API）。
  （2026-10-29 起快取沒有就抓那一則，這行是當時的現況記錄。）

**要做**：
1. 把訊息文字裡的 `<@id>`／`<@!id>` 換成 `@暱稱`，`<#id>` 換成 `#頻道名`，`<@&id>` 換成 `@身分組名`。
   名字從 `message.mentions` 取，不另外打 API。純函式放 `src/core/discord-batch.mjs` 或 `discord-context.mjs`。
   新訊息、`【最近頻道訊息】`、`read_history`、`search_history`、`view_message` 都要用同一個函式。
2. 沒有引用內容的回覆，用 `message.mentions.repliedUser`（不用 fetch）在那一行加 `↪回覆 暱稱`。
   有引用內容時，維持現有的 `[引用 X：…]`。
3. 名字要過 `defang`／`clean`，不能讓群友用暱稱偽造 `★` 或 `【管理員】`。

**檔案**：`src/core/discord-batch.mjs`、`src/core/discord-context.mjs`、`src/discord-bridge.js`、
`scripts/test-discord-bridge.mjs`、`docs/guides/DISCORD.md`、persona（加一句「`↪回覆 X` 是這則在回 X」，照 0.2 第 5 項重新產生 patch）。

**驗收**：三種 mention 都換成名字；查不到名字時保留 `@未知`，不顯示數字；暱稱裡有 `★`、`【管理員】` 時被 defang。

### C：收回自己的 reaction

**狀態：已完成（2026-10-28，commit `f17d585`，已部署）。**
- `remove_reaction` 只收回 bot 自己按的，額度獨立算（一輪 3 次）；persona 統一成「通常 1 個，最多 3 個」。

**現況**：只有 `add_reaction`。persona 寫「一輪最多 2 個」，程式碼 `REACT_PER_TURN_LIMIT` 是 3。

**要做**：
1. 新工具 `remove_reaction(token, message, emoji)`：對 `#編號` 那則移除 bot 自己按的那個表情。
   只能移除自己的，這點由 API 本身保證（只移除 `client.user.id`）。
2. 一輪上限：另外算 `unreact`，最多 3 次。
3. 統一 reaction 上限的說法：見第 5 節「待決定」第 4 點。

**檔案**：0.2 節的 1~7 項全部。

**驗收**：移除沒按過的表情回清楚的錯誤；`#編號` 不在這個頻道時拒絕；名額用完回 429。

### D：歷史查詢可以按日期

**狀態：已完成並部署（2026-10-28，commit `06ff403`、`a383f63`；伺服器上線的提交是 `889e2af`，19:19 重啟）。**

**現況**：`read_history` 只能從最新的或 `before=#編號` 往前讀；`search_history` 只掃最近 300 則；
兩個合計一輪 3 次（`HISTORY_PER_TURN_LIMIT`）。

**要做**：
1. `read_history` 加 `date`（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`，用 bridge 主機的時區，跟 `【現在】` 那行一致）。
   有 `date` 時，用該時間產生 snowflake，以 `after` 往**後**讀 `limit` 則，回傳仍是舊→新。
   `date` 和 `before` 同時給時回錯誤。
2. `search_history` 加 `date`：從那天開始往後掃，不再只看最近 300 則。掃描頁數上限不變（`SEARCH_PAGES`）。
3. **額度先不動**（`HISTORY_PER_TURN_LIMIT` 維持 3）。這個值是 commit `6eae4bb`（2026-10-28）才定的：
   原本是 `search_history` 一輪 2 次、`read_history` 不限，改成合計 3 次，理由是每次都可能掃幾百則、會卡住同一個頻道。
   要不要提高見第 5 節第 3 點。
4. 先不做「先給摘要再查細節」的兩段式：有了日期跳轉之後再看需不需要。

**檔案**：0.2 節的 1~7 項（不用新增工具名，但參數 schema 和 persona 都要改）。

**驗收**：日期格式錯回 400；未來的日期回「還沒有訊息」；回傳順序是舊→新。

**結果**：
- 兩個工具都加 `date`；`date` 和 `before` 同時給回 400，格式錯回 400，未來時間回「還沒有訊息」。
- 比 Discord 還早的時間（2015 以前）會夾到紀元，讀頻道最早的訊息，不會回空。
- `search_history` 給 `date` 時往後掃最多 3 頁（300 則），結果一律舊→新；沒給 `date` 的行為不變。
- 新增 `src/core/discord-history.mjs` 放翻頁與排序，`scripts/test-discord-bridge.mjs` 補跨頁、頁中途限額、同毫秒的測試。
- `shortTime` 遇到不是今年的訊息會帶年份，日期跳到去年時分得出來。
- `HISTORY_PER_TURN_LIMIT` 維持 3；讀滿 50 則不會提示「後面還有」，照本節第 4 點 v1 不做兩段式。

### 附帶：D 同一個 session 另外修的兩件事

- `view_message` 看不到修復 bot 的連結預覽：現在看原訊息時，會讀後面 10 則裡「回覆它」或「路徑相同」的 bot 訊息，最多 3 則。
  只換網域（fxtwitter、fixupx、ddinstagram）也算同一條連結；b23 這種整個換路徑的短連結仍要靠回覆關係。
- 模型只回文字、忘記呼叫工具：★ 的回合會補一次提醒（10 分鐘冷卻）。DSH 暫時錯誤時直接放棄，不進離線佇列，避免蓋掉下一批。

### B：發言頻率與送出回饋

**狀態：已完成（2026-10-28，commit `cc46448`，已部署）。**
- B1 發言頻率、B2 `set_quiet`、B3 送出回饋（含 reaction 回饋）都做了。
- 安靜結束時清 `primedKeys`；reaction 先存起來、下一批提示一次、不觸發回合。

**B1 發言頻率**（不新增工具）
- 每個會話 key 記一個記憶體 ring buffer：bridge 看到的每則訊息（時間、是不是 bot 自己）。
  bot 自己送的訊息在 `agentHandlers.send`／`poll` 成功時記。
  群友的訊息要在 `handleMessage` **最前面**記：在 `requireMentionInGuild()` 的 return 之前、
  也在「沒有文字也沒有圖」的 return 之前。記晚了，「頻道共 M 則」只會算到 @bot 的訊息。
- 每批 prompt 的 `【現在】` 那行後面加一句：「你最近 10 分鐘送了 N 則；這段時間頻道共 M 則」。
  M 很小時（例如少於 3）不顯示比例。
- 純函式放 `src/core/`，可以離線測。

**B2 先安靜一下**：新工具 `set_quiet(token, minutes, reason?)`
- 這個 key 在 `minutes` 內（1~120）：**沒叫 bot 的批次不送進模型**（省 token）。叫 bot 的（★）照常送。
  黑話語料照常收集。
- `minutes: 0` 是提早結束安靜。
- 自由參與模式下，`primedKeys` 讓頻道上下文只在會話的第一批帶。安靜期間丟掉的批次之後就看不到了。
  所以安靜結束時，要把這個 key 從 `primedKeys` 拿掉（下一批重新帶上下文），
  或在下一批加一句「安靜期間略過了 N 則，需要的話用 read_history 看」。選一種，寫在回報裡。
- bridge 自己的自動 reaction（`maybeReact`）在安靜期間也暫停。
- 狀態只放記憶體，bridge 重啟就清掉（可以接受）。
- `【現在】` 那行顯示「你設了安靜到 HH:MM」。控制台會話列表顯示同樣資訊（如果改動小）。

**B3 送出回饋**
1. `send_message`／`send_sticker`／`create_poll` 的回傳文字改成：
   `已送出到 #頻道名。這則的訊息編號是 #xxxx（之後改、收回、看反應用這個）`。
2. bot 自己送出的訊息收到 reaction 時，存在這個 key 的待報清單裡；**下一批** prompt 開頭加
   `【你的訊息收到的反應】#xxxx 😂×2、:kekw:×1`。reaction 本身**不觸發**模型回合。
   - 需要 intent `GuildMessageReactions` 和 partials `Message`、`Reaction`（S4 確認）。
   - 「是不是自己的訊息」用 `createAgentSender` 的 `owned` 判斷：要新增一個查詢方法（例如 `isOwned(key, id)`）。
   - 每個 key 最多留 10 筆，同一則訊息合併。
3. 有人回覆 bot 已經會變成 ★，不用另外做。

**檔案**：0.2 節的 1~9 項（新 intent）。

**驗收**：安靜期間沒叫 bot 的批次不投遞、★ 照常投遞；反應區塊只出現一次（送過就清）；
別人的訊息收到的 reaction 不會出現。

### H：送固定的圖

**狀態：⏭️ 略過（2026-10-28，管理員決定不做）。**

**現況**：只能送伺服器貼圖（`send_sticker`，跨伺服器不行）。邀請權限刻意沒有 Attach Files。

**要做**：
1. 新設定 `discord.images`：`{ "enabled": false, "dir": "assets/discord-images" }`，
   目錄裡放圖片和 `catalog.json`：`[{ "name": "白飯臉", "file": "rice.png", "description": "…" }]`。
2. 新工具 `send_image(token, image, content?, reply_to?)`：只送目錄裡有的名稱。名稱錯時，錯誤訊息列出所有可用名稱（目錄很小，不另做查詢工具）。
3. 路徑安全：`file` 只能是目錄內的檔名（不能有 `..`、絕對路徑、符號連結逃出目錄）；只收 png／jpg／gif／webp；有大小上限。
4. 走 `agentSender.send` 同一條佇列和「一輪 5 則」上限，回傳 `#編號`，可以 `delete_message`。
5. 權限：`INVITE_PERMISSIONS` 加 `AttachFiles`（`1n << 15n`），同步改 `discord-core.mjs` 上方「不含 Attach Files」那段註解和 DISCORD.md 的邀請段。
   這只影響**新的**邀請連結。已經加入 bot 的伺服器，要管理員手動給 bot「附加檔案」權限；
   沒有權限時工具要回清楚的錯誤（Discord 錯誤碼 50013），寫進 DISCORD.md。
6. persona：說明有哪些圖、什麼時候用（例如被問長相時）。

**檔案**：0.2 節的 1~8 項、`config.example.json`、`src/core/discord-core.mjs`（設定正規化與權限）。

**驗收**：路徑逃逸被擋；不在目錄的名稱回清單；`enabled: false` 時工具回「沒開」。

### E：頻道事件筆記（最大的一包）

**狀態：✅ v1 與 v2 都已完成（2026-10-28，commit `da12990`；控制台卡片 `ad42d9a`）。**
- v1：`note_event`／`search_notes`／`forget_note`、每批注入、`state/discord-notes.json`、控制台 `GET /api/notes` 與 `POST /api/notes/delete`。
- v2 每日摘要：用 `dc-learner` preset 的背景會話，每個頻道每天一次，寫成一條 7 天過期的筆記。
- 伺服器已開 `notes.enabled` 與 `notes.dailySummary.enabled`（hour 4）；實測三個頻道各寫入一條摘要。

**現況**：`remember_user` 只記「人」（`src/core/discord-memory.mjs`）。沒有地方記「群裡發生過什麼」：約定、梗的由來、昨天的話題。

**要做（v1）**：
1. 新模組 `src/core/discord-notes.mjs`，資料 `state/discord-notes.json`。照 `discord-memory.mjs` 的寫法：
   原子寫、`version` 欄位、壞檔備份 `.corrupt-<timestamp>`、檔案大小上限、啟動時讀、改了延遲寫。
   ```json
   { "version": 1, "notes": [
     { "id": "n_xxx", "guildId": "…", "channelId": "…", "text": "週五晚上約好一起打牌",
       "at": "ISO 時間", "expiresAt": "ISO 時間或 null", "by": "model" } ] }
   ```
2. 工具：
   - `note_event(token, text, days?)`：記一條頻道事件，最多 150 字。`days` 是幾天後過期（預設 30，最多 180）。
     一輪最多 2 次；私聊不記；過敏感資訊閘門（`findSensitive`）；每個頻道最多 100 條，滿了刪最舊的。
   - `search_notes(token, query?, days?)`：查這個頻道的筆記，`days` 限定最近幾天。回傳帶編號。
   - `forget_note(token, number)`：刪一條（記錯、事情變了）。
3. 注入：每批 prompt 帶 `【頻道筆記】`：這個頻道最近 N 條（受 `maxChars` 限制）。
   用跟群友記憶一樣的 `shown` 機制，同一會話帶過、沒變的不重複帶。
4. 設定 `discord.notes`：`{ "enabled": false, "injectMax": 5, "maxChars": 600 }`。預設關閉，理由跟 `memory` 一樣。
5. 控制台：v1 只做 `GET /api/notes` 和 `POST /api/notes/delete`；畫面可以晚點做。
6. persona：什麼時候記（約定、決定、反覆被提起的事件、梗的由來），什麼時候不記（個資、一次性的閒聊、對某個人的評價）。
   「關於某個人」的事仍然用 `remember_user`。

**v2（先不做）**：每天自動產生頻道摘要，寫成一條筆記。要另外開模型會話，會花 token；先看 v1 用了一週的實際效果再決定。

**檔案**：0.2 節的 1~7 項、新模組與新測試檔 `scripts/test-discord-notes.mjs`（登記進 `package.json` 和 `test-audit.mjs`）、
`src/core/discord-console.mjs`（控制台 API）、`config.example.json`。

**驗收**：壞檔不影響聊天；過期的筆記不注入也查不到；敏感內容被擋；A 頻道查不到 B 頻道的筆記；`enabled: false` 時不注入、工具回「沒開」。

**風險**：筆記裡可能寫到人名。`/forget` 目前只刪群友記憶，不刪筆記。v1 先在 DISCORD.md 寫清楚這點，需要的話再加「刪掉提到我的筆記」。

### F：看得到 GIF 和影片

**狀態：F1 ✅ 完成（2026-10-29，分支 `feat/discord-embed-gif`，還沒部署）；F2 ⏭️ 略過（2026-10-28，管理員決定不做）。**

**現況**：
- 批次 prompt 只收**附件**和**貼圖**的圖（`handleMessage` → `collectImageAttachments`），**不收 embed**。
  所以 Tenor／Giphy 的 GIF 連結，模型只看到一串網址。
- `view_message` 已經會收 embed 的 `image`／`thumbnail`（只用 Discord 代理過的 `proxyURL`）。
- `prepareImageBlock` 已經會把 GIF 取 6 格拼成一張圖（`gifFrames: 6`）。
- 影片附件（mp4／webm／mov）會被當成「不是支援的圖片格式」跳過。

**F1 GIF 連結（Discord 線）**
1. 把 `view_message` 裡「從 embed 取圖」那段抽成共用函式（放 `src/core/discord-media.mjs`），批次 prompt 和 `view_message` 一起用。
2. `handleMessage` 收圖時把 embed 的圖也算進去。仍然只收 Discord 代理網址，仍然受 `media.maxCount` 限制。
3. 如果 S2 確認 `messageCreate` 時 embed 常常還沒出來：v1 接受漏掉（模型可以用 `view_message` 再看），
   在 persona 加一句「只看到 tenor／giphy 網址時，用 `view_message` 看圖」。不要為了等 embed 拖慢批次。

**F1 檔案**：`src/core/discord-media.mjs`、`src/discord-bridge.js`（`handleMessage`、`view` handler）、
`scripts/test-discord-bridge.mjs`、`docs/guides/DISCORD.md`、persona（0.2 第 5 項）。

**F2 影片附件（可以跟 Discord 線並行，只改 `src/media-normalize.js` 和 `src/core/discord-media.mjs` 的格式判斷）**
- 用 ffmpeg 從影片取幾格拼圖，做法照 GIF。要有長度、大小、逾時上限。
- QQ 版不再維護（2026-10-29）：動 `media-normalize.js` 不用保住 QQ 的行為；真的讓 QQ 那邊跑不過，就解耦 QQ 端的程式碼。
- F2 改到 `discord-media.mjs` 的那一行格式判斷時，要等 F1 合併後再做，避免衝突。

**驗收**：Tenor 連結（embed 已出現時）會帶圖；非 Discord 代理網址不下載；影片超過上限時有一行說明。

**結果（2026-10-29）**：
- 共用函式是 `embedImages(embeds)`（`src/core/discord-media.mjs`）：只收 `proxyURL`，同一個 embed 只拿一張（有 `image` 就不拿 `thumbnail`，那通常只是縮小版）。
- 跟計畫第 2 點不同：批次不是在 `handleMessage` 收，而是在送出時讀 `entry.message.embeds`。S2 結論：預覽走 `messageUpdate`，discord.js 14.27.0 會 patch 同一個 Message 物件（`MessageUpdate.js` → `Message._patch`），批次本來就等 `batch.debounceMs`（預設 3 秒），所以在送出時讀才拿得到，`messageCreate` 當下多半還是空的。
- 沒開 Message Content 意圖時 `embeds` 一律是空的，只有網址（官方文件警告）；`view_message` 同理。
- persona 加了一句：只看到 tenor／giphy 網址就 `view_message` 看圖。沒實機貼 Tenor 連結驗證過。

### K：常用表情（低優先，可以不做）

**狀態：已完成（2026-10-28，commit `c590ad8`，已部署）。**
- `search_emojis` 的 `query` 留空時按使用次數排序；只記目錄裡的表情，同一則訊息同一個表情算一次，每伺服器上限 500 個 id。

第 4 次回答說「不要更多表情」，所以**不**在 prompt 多塞清單。最小做法：
- `handleMessage` 統計各伺服器訊息裡出現的自訂表情（`<:name:id>`）次數，存進現有的表情狀態。
- `search_emojis` 的 `query` 留空時，按使用次數排序。不增加 prompt 長度，也不新增工具。
- v4（2026-10-28）：prompt 帶所有伺服器加起來前 8 個常用表情（名稱＋使用時機），
  同會話 30 分鐘去重；`search_emojis` 退成找更貼的補充手段。

**檔案**：`src/discord-bridge.js`（`handleMessage`、`emojis` handler）、`src/core/discord-emoji.mjs`（統計與排序）、
`scripts/test-discord-bridge.mjs`、`docs/guides/DISCORD.md` 的表情段。

### I：時間控制（**等管理員決定**，見第 5 節第 1 點）

**狀態：✅ 已完成（2026-10-28，commit `c590ad8`，已部署；伺服器 `followup.enabled: true`）。**
- 選了「回訪」：`schedule_followup` 5~180 分鐘、同時 2 個、每天 6 個、`/reset` 取消、安靜期間延後、DSH 暫時不可用就放棄。
- 到點只送【回訪】提示，模型自己決定要不要說話。

建議做法（「回訪」，不是排程發言）：
- 新工具 `schedule_followup(token, minutes, note)`：`minutes` 後 bridge 對這個會話送一批只有
  `【回訪】你 N 分鐘前說要回來看：<note>` 的 prompt。**模型自己決定**要不要說話，跟一般批次一樣。
- 限制：每個 key 同時最多 2 個；5~180 分鐘（如果要支援「比賽當天提醒」這種以天計的，就要存檔，重啟後還在）；
  每天每個 key 最多 6 個；會話被 `/reset` 時取消；安靜期間（B2）延後到安靜結束。
- 設定 `discord.followup.enabled` 預設 `false`。
- persona 要改「你只能在收到新訊息時說話」那句，加上回訪的例外。

**檔案**：0.2 節的 1~7 項、`config.example.json`、`src/core/discord-core.mjs`（設定正規化）；排程邏輯放新的 `src/core/` 模組以便離線測。

另一個選項是「延遲發送」：`send_message` 加 `delay_minutes`，時間到就送出原本寫好的文字。
缺點是送出時可能已經不合時宜，模型沒有機會重新判斷。

### J：token 自動帶入（看 S1 結果）

**狀態：⬜ 未開始。** S1 沒做；先要決定「bridge 怎麼把 token 給 DSH」，見下面第一條。

- S1 確認 guard 拿得到會話 id **而且**能改參數：在 `dc-tool-restrict` 的 guard 裡，對 `mcp__discord__*`／`mcp__slang__*` 自動補上該會話的 token。
  bridge 需要提供「會話 id → token」的查詢方式，不能把 token 表寫進檔案給 DSH 讀。這部分要另外設計，先跟管理員確認。
- S1 確認做不到：不做，在本文記下原因。

### L：專門的資料來源（**等管理員決定**，見第 5 節第 2 點）

**狀態：⬜ 等管理員決定來源。**

管理員決定要接哪些來源之後，才開工作包。

---

## 4. 網頁線（可以跟 Discord 線並行）

**狀態：✅ 已完成（`ad42d9a`；後續 `a383f63` 補了連結預覽讀取與「忘記用工具」提醒）。**

**G0（persona 一行，併到 Discord 線當下的工作包裡做）**：群友貼的連結先用 `view_message` 看 Discord 自己產生的預覽；
抓不到正文時明講「打不開」，不要用搜尋摘要拼出答案。第 1 次回答提到的兩個錯誤，都是從摘要拼答案造成的。

**現況**：`web_fetch` 是我們自己的工具（`src/mcp-web-search-safe.js` 的 `web_fetch` handler 呼叫 `src/safe-fetch.js` 的 `safeFetch`），
不是 DSH 內建。已有 SSRF 防護：內網／私有 IP 擋掉、DNS 全部解析結果都檢查、手動跟隨轉址、每一跳重新檢查、回應大小上限。
`safeFetch` 遇到 4xx／5xx **不會丟錯**，而是回傳 `{ url, statusCode, truncated, body }`；
現在 handler 把整包 JSON（包括 403 的驗證頁 HTML）原樣給模型。
**QQ 版的 `bridge.js` 和 `web-search.js` 也在用 `safe-fetch.js`**，所以 G **不改 `safe-fetch.js`**。

**狀態：✅ 已完成（`ad42d9a`）。判斷邏輯在 `src/core/fetch-verdict.mjs`。**
- 有驗證頁特徵（`_cf_chl_opt`、`cf-chl`、標題 Just a moment／Attention Required／Checking your browser）→
  任何狀態碼都回「機器人驗證」；其他 403／503 回「網站拒絕訪問」；其他 4xx／5xx 帶狀態碼。
- 正常頁面夾 Cloudflare 的 JSD script 不會被誤判（只看標題與驗證頁專屬標記）。

**G1 讓失敗講清楚**（只改 `web_fetch` handler）
- 拿到 `safeFetch` 的結果後判斷：狀態碼 403／503，或內容看起來是 Cloudflare 驗證頁（例如「Just a moment」標題、
  `challenge-platform` 字樣），就回 `isError` 和一句話：「被網站的機器人驗證擋住，沒有拿到正文」。
  不要把驗證頁的 HTML 當成正文回給模型。其他 4xx／5xx 也回 `isError` 並寫出狀態碼。
- 判斷邏輯寫成純函式（可以放在 `mcp-web-search-safe.js` 旁邊的新模組），用假的回應測，不打真網站。

**狀態：⬜ 未開始（等 S3 與管理員決定來源）。**

**G2 備援來源（等 S3）**
- 設定 `webSearch.fetchFallbacks`，預設空陣列（不啟用）。讀設定沿用 `web-search.js` 的 `loadSearchConfig`（加一個欄位）。
- 開了之後，G1 判定被擋時，handler 依序試設定裡的來源。每個備援請求一樣走 `safeFetch`，SSRF 檢查一個都不少。
- 隱私：備援服務會看到群友貼的網址。這點要寫進 `docs/guides/SECURITY_BASELINE.md` 和 DISCORD.md。
- 針對 X／b23／fandom 的轉接：依 S3 的結論決定做哪些。

**檔案**：`src/mcp-web-search-safe.js`、判斷邏輯的新模組、`src/web-search.js`（只加設定欄位）、`config.example.json` 的 `webSearch` 段、
`scripts/test-audit-security-mcp.mjs`（或新的測試檔，要登記進 `test-audit.mjs`）、`docs/guides/SECURITY_BASELINE.md`、`docs/guides/DISCORD.md`。

**驗收**：`npm run test:audit` 全過（包含 QQ 的安全測試）；`safe-fetch.js` 沒有改動；備援預設關閉；開了之後內網位址仍然被擋。

---

## 5. 待管理員決定

1. **時間控制（工作包 I）**：
   - **已決定（2026-10-28）：選 A，已完成並部署（`c590ad8`，`followup.enabled: true`）。**
   - 選項 A（建議）：「回訪」：時間到了給模型一個回合，模型自己決定要不要說話。預設關閉。
   - 選項 B：延遲發送：時間到了直接送出預先寫好的文字。
   - 也可以都不做。第 3 次回答反對模型排程自己發言。
2. **資料來源（工作包 L）**：要接哪些遊戲／賽事／卡店的資料？從截圖看，大概是遊戲王（YCS）和英雄聯盟賽事，需要管理員確認。
3. **歷史查詢額度**：模型說一輪 3 次不夠，但 3 是 commit `6eae4bb` 今天才定的（理由：每次可能掃幾百則，會卡住頻道）。
   - 現況：D 已完成，額度仍是 3，照選項 A 觀察一週。
   - 選項 A（建議）：維持 3。工作包 D 做完日期跳轉後，同樣的問題可能 1~2 次就查到。用一週後再看。
   - 選項 B：改成 5，persona 的【翻歷史的界線】同步改數字。
4. **reaction 上限**：**已決定（2026-10-28）：已完成（`f17d585`），persona 與程式碼都是「通常 1 個，最多 3 個」。**
   原本 persona 寫一輪 2 個（`agent.cordis.yml` 的 `add_reaction` 那行），程式碼是 3 個（`src/core/discord-agent.mjs:24`）。

---

## 6. 風險

- 熱點檔案衝突：Discord 線一定要一個接一個做。開新 session 前先確認上一個已經合併。
- 每個新工具都會多一點 prompt（工具 schema）。照 PLAN_EMOJI 的經驗，能用參數解決的不另開工具。
- 新 intent（B3 的 reaction）會增加 gateway 事件量。只處理自己的訊息，其餘直接丟掉。
- 事件筆記和回訪都會把頻道內容存檔或多送給模型。兩者預設關閉；測試伺服器 2026-10-28 已明確打開（`notes.enabled`、`notes.dailySummary.enabled`、`followup.enabled`）。
