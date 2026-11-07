# Handoff：把 bridge 的模型呼叫換到 Command Code provider

- 日期：2026-11-07
- 狀態：**已決定只換 provider。** Jev 決策閘門**不做**（理由見下）。
- 範圍：Discord 路徑（`src/discord-bridge.js`）。QQ 端不用管，也不用保持相容。

## 一句話

DSH 已經裝好社群外掛 `@mars-sea/dsh-commandcode-provider` 並登入 Command Code GOAT 訂閱。
要做的事：讓 bridge 的所有模型呼叫改用 provider `commandcode`，帳本與 `/status` 不要因此壞掉，
然後驗證 cache 有命中。

## 為什麼不做 Jev

用伺服器上三個已 archive 的頻道實測（`1305879940746580011`、`1073905098457108551`、`1354000283629518919`，
2026-10-27 到 11-07，80 個 session，10,958 個回合，價格用 DeepSeek V4.1 Flash 牌價算）：

| 回合類型 | 數量 | 占比 | 總花費 | 每回合 |
| --- | --- | --- | --- | --- |
| 沒人叫 bot、模型沒說話 | 8,481 | 77% | $3.20 | $0.00038 |
| 沒人叫 bot、模型有說話 | 1,562 | 14% | $1.32 | $0.00085 |
| 有人叫 bot（★）、有說話 | 764 | 7% | $0.70 | $0.00092 |
| 有人叫 bot、沒說話 | 8 | 0.1% | 約 $0 | — |
| 其他（提醒、系統） | 143 | 1% | $0.53 | $0.00374 |

- Jev 只能擋第一列：12 天 $3.20，一個月約 $8，還沒扣 Jev 自己的成本與誤擋。
- 模型沉默時只輸出約 25 個 token，成本幾乎都是 cache 讀取。
- 第二列（沒叫 bot 但模型有回）有 1,562 個，是群友喊名字、接話的情況，誤擋代價比省的錢大。
- Jev 不支援 ZDR，群組內容會送到第三方。
- 結論：不做。要再省就拉長自由參與頻道的 debounce，那是另一件事。
- 「叫 bot」的判斷用 `#編號 ★名字` 比對，沒有逐筆核對；沉默的原因（例如別的回合補回應）也沒查。

## 現況（已讀過程式碼）

- bridge 自己不打任何 LLM API，全部經 DSH。模型由 `config.json` 的 `dsh.provider` / `dsh.model` /
  `dsh.reasoningEffort` 決定，目前是 `opencode-go` / `deepseek-v4.1-flash` / `max`。
- 這三個值用在：
  - `src/discord-bridge.js:1057` `applyModel`：每個會話第一次投遞時呼叫 `api.sessions.selectModel`。
    重啟 bridge 後，既有會話也會重選一次，所以**舊會話會中途換 provider**。
  - `src/discord-bridge.js:4714`、`:5880`、`:6060`：背景會話（黑話學習、頻道摘要等）。
  - `src/discord-bridge.js:762-763`：`createUsageTracker` 的保底 `nominalModel` / `provider`。
  - `src/discord-bridge.js:399`：config 載入時 `provider` 的預設值是 `'opencode-go'`。
  - `scripts/build-discord-emojis.mjs:52`：同樣的預設值。
  - `config.example.json:4-5`。
- `src/discord-bridge.js:789` `quotaInfo()`：provider 不是 `opencode-go` 就回 `skipped`，
  `/status` 與控制台的 OpenCode Go 額度卡片自然消失。這是預期行為，不用改。
- 價目表 `src/model-prices.js` 的 `DEFAULT_PRICE_TABLE.models` 用「model id 字串」當鍵。
  Command Code 的 model id 帶前綴（`deepseek/deepseek-v4.1-flash`），目前表裡沒有，
  會被當成未登記模型、用 `deepseek-flash` 兜底並標 `estimated=true`。

## 外掛事實（從 repo 與 README 讀到的）

來源：<https://github.com/Mars-Sea/dsh-commandcode-provider>（MIT，`gh` 看過）。

- provider id 是 `commandcode`；model id 格式 `deepseek/deepseek-v4.1-flash`。
- 支援的 dsh：`>=0.2.1-rc.2 <0.2.2-0` 與 `>=0.2.2-alpha.2 <0.2.3-0`。伺服器跑 `0.2.1-rc.2`，在範圍內。
- Node 要 `>=24.9`。伺服器 node 是 v26，沒問題。
- API key 存在 DSH 憑證庫；也可用 `COMMANDCODE_API_KEY` 或 `~/.commandcode/auth.json`。
- 圖片只有 Vision 模型能收；README 說新圖片會讓 CLI 傳輸的 prompt cache 退回，
  可開 `offloadSeenImagesForCache: true` 緩解（預設關）。bridge 會送圖，要看實際影響。
- ZDR 預設關。**不要開**：多數模型沒有 ZDR 上游，開了會 422。
- 已知 issue：#84（GOAT 呼叫 `claude-haiku-5-5` 被 permission_error 拒絕）、
  #105（多帳號自動切換有 bug）。只用 DeepSeek 且單帳號，暫時不受影響。
- 價格：Command Code 網站列 DeepSeek V4.1 Flash 離峰 $0.15 / $0.60 / cache read $0.003，
  尖峰 $0.30 / $1.20，尖峰是 UTC 01–04 與 06–10、週一到週五（等於北京 9–12、14–18）。
  跟 bridge 現有價目表一樣。**中國法定假日是否算離峰，網站沒寫，未驗證。**

## 要做的事

照 AGENTS.md 的順序：文件 → 測試（先看它失敗）→ 最小實作 → 清理。

1. **先在伺服器上驗證（唯讀，不要改任何東西）**
   - `~/.dsh/profiles/web/cordis.patch.yml` 或 profile `package.json` 有沒有 `llm-commandcode`；
     bridge 用的 DSH profile 是哪一個（看 `/home/jun/dsh/run.sh`）。
   - 取得 `session.modelCatalog`（可參考 `src/bridge.js:2387` 的 `api.callUnary('session.modelCatalog', {})`，
     或 `scripts/` 裡現有的 probe）。確認：
     provider 有 `commandcode`、`deepseek/deepseek-v4.1-flash` 在 `routableProviders`、
     reasoning effort 可用的值有沒有 `max`。
   - 要的是 **DSH 實際回報的 model 字串**，不是文件上的。
2. **文件**：`docs/guides/DISCORD.md:203` 的預設值與 `:570` 的 OpenCode Go 額度段，
   改成說明「provider 是 `commandcode` 時沒有額度卡片」。`docs/guides/TOKEN_USAGE_CONSOLE.md` 的價目表段補上 Command Code 的 model id。
3. **測試**：`scripts/test-discord-bridge.mjs` 約 `:1663-1746` 有帳本的測試。
   加一個：以 `commandcode` / `deepseek/deepseek-v4.1-flash` 記帳，金額要跟 `deepseek-v4.1-flash` 一樣、
   且不標 `estimated`。先看它失敗，再改。
4. **價目表**：`src/model-prices.js` 的 `DEFAULT_PRICE_TABLE.models` 加 `deepseek/deepseek-v4.1-flash` 別名
   （價格同 `deepseek-v4.1-flash`）。鍵用步驟 1 查到的實際字串。`PRICE_TABLE_VERSION` 一起更新。
5. **預設值**：`config.example.json`、`src/discord-bridge.js:399`、`scripts/build-discord-emojis.mjs:52`
   的 provider / model 預設改成 `commandcode` / `deepseek/deepseek-v4.1-flash`
   （專案規則：不留舊相容；但步驟 1 發現 model id 不同就以實際為準）。
6. **跑測試**：`npm run test:discord`，貼真實輸出。
7. **部署前先備份帳本**：`state/discord-usage.jsonl`（見 AGENTS.md 的回退段）。

不要做的事：

- 不要寫 Jev 或任何閘門。
- 不要刪 `createGoQuota` 與相關測試。provider 換回 `opencode-go` 還用得到，列在 Found 就好。
- 不要碰 `.agents/loops/dream.md`（它自己的 `opencode-go/beam-free`，跟 bridge 無關）。
- 不要把 DSH 的 Command Code 憑證讀出來給 bridge 用；bridge 不需要這把 key。

## 部署

用 `node scripts/deploy-discord.mjs`（流程見 AGENTS.md「部署到 Discord 測試伺服器」）。

- `config.json` 是 gitignore 的，**腳本不會改它**。要手動在伺服器改 `dsh.provider` / `dsh.model`
  （只改這兩行，備份原檔再改；`reasoningEffort` 依步驟 1 的結果決定）。
- 改 config 不用 `setup:discord`；`pm2 restart dc-bridge` 就夠（腳本在只改 `src` 時會做）。
- 重啟後既有會話會中途換 provider：第一個回合會完全 cache miss，歷史裡的 reasoning 格式能不能被新 provider 接受**未驗證**。
  用一個測試頻道先看一回合再看全部。
- 想先只讓新會話走新 provider：不是現成功能，不要為此寫新機制；有疑慮就在測試頻道先跑。

## 驗證（部署後，自己跑、貼數字）

1. `pm2 logs dc-bridge` 看到 `會話 <id> 模型 → commandcode/deepseek/deepseek-v4.1-flash`，沒有 `設定模型失敗`。
2. 在測試頻道叫 bot 一次，確認有回、沒有 error log。
3. **最重要：cache。** 用 `state/discord-usage.jsonl` 或 DSH session log 的 `assistant/message.usage`：
   同一個長會話的 `cacheReadTokens` 要大於 0，而且占輸入大宗。
   基準（換之前，三個頻道的沒說話回合）：平均每回合 cache 讀約 5.5 萬、未命中約 1.3–2.7 千、輸出約 25，約 $0.00038。
   如果換完 cache 讀幾乎是 0，成本會變 3–5 倍，要先停下來回報，不要繼續部署。
4. 發一張圖給 bot，看下一回合的 `cacheReadTokens` 有沒有掉到接近 0（外掛 README 提到的問題）。
5. 控制台「令牌與花費」頁：新回合的模型不是「未登記」、金額合理。
6. `/status`：沒有 OpenCode Go 額度那行是預期的。
7. 撞額度的行為（GOAT 5 小時 $20、每週 $50）**沒有驗證過**，也沒做降級；先觀察用量，每天約 $0.5。

## 回退

- 伺服器 `config.json` 的兩行改回 `opencode-go` / `deepseek-v4.1-flash`，`pm2 restart dc-bridge`。
- 程式碼回退照 AGENTS.md：`node scripts/deploy-discord.mjs --sha <上一個 commit>`。
- 跨過 2026-11-07 幣別變更回退時，先還原 `state/discord-usage.jsonl` 備份（AGENTS.md 有說明）。

## 風險與未知

- Command Code 的代理有沒有把 prompt cache 傳下去：**未驗證**，是最大風險。
- GOAT 訂閱的服務條款允不允許給 Discord 群組 bot 使用：**未查**。
- 外掛是社群專案，不是官方；Command Code 或 DSH 改版時可能壞。
- 價目表的尖峰是否排除中國假日：Command Code 沒寫，帳本在假日可能偏高。
- 帳本單位：`evict` 行會寫 `cur`，不受 provider 影響。

## 檔案

- `src/model-prices.js`：價目表與模型別名。
- `src/core/discord-usage.mjs`：用量追蹤（`rememberModel` 從 `model/selection` 事件記 provider 與 model）。
- `src/discord-bridge.js`：`:399`、`:762`、`:789`、`:1057`、`:4714`、`:5880`、`:6060`。
- `scripts/build-discord-emojis.mjs:52`、`config.example.json`。
- `scripts/test-discord-bridge.mjs` 約 `:1663-1801`。
- `docs/guides/DISCORD.md`（`:203`、`:346`、`:570`）、`docs/guides/TOKEN_USAGE_CONSOLE.md`。

## 實作結果（2026-11-07）

步驟 1 在伺服器上查到的實際值（`session/modelCatalog`，唯讀）：

- bridge 用的是 `web` profile（`/home/jun/dsh/run.sh` 跑 `dsh web --port 2815`），
  `~/.dsh/profiles/web/package.json` 的 bundles 有 `@mars-sea/dsh-commandcode-provider` `^0.17.2`。
- `routableProviders` = `["commandcode", "opencode-go"]`。
- 群組 `commandcode` 的 model id 是 `deepseek/deepseek-v4.1-flash`（`Go · Half · Image · 1M`），
  reasoning efforts = `off, low, high, max` → `max` 可用。
- `catalog.default` 還是 `opencode-go` / `deepseek-v4.1-flash` / `low`；bridge 每個會話都顯式選模型，
  不吃這個預設值。

已改：價目表加 `deepseek/deepseek-v4.1-flash` 別名（同價）、`PRICE_TABLE_VERSION` → `2026-11-07b`、
三處預設值、兩份 guide、一條帳本測試（先看它失敗再修）。

部署後要多驗一項：DSH 的 `assistant/message.usage` 如果自己帶 `model` 欄位
（`src/core/discord-usage.mjs:74` 優先取它），字串可能和 `deepseek/deepseek-v4.1-flash` 不同，
帳本會整批標 `estimated`。金額不會錯（兜底價同價），但要在 session log 確認一次。
