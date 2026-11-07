---
name: discord-usage-pricing
description: 花費看板改用美元價目：DeepSeek 英文頁 USD、evict cur 換算、2027 假日、部署備份
---

2026-11-07 起花費看板改用 DeepSeek 官方英文價目頁的 USD 單價（commit `fcf82cb`），不再用中文頁的人民幣。

- 單價（空閒时段，每百萬 token）：flash `0.003 / 0.15 / 0.6`，pro `0.022 / 0.66 / 1.98`（cacheHit / cacheMiss / output）；高峰 ×2。
- 高峰时段 = 北京时间周一至周五 9–12、14–18，排除中國法定假日。
- 2027 假日改成國辦發明電〔2026〕10 號的 29 天，不再用推測值。
- 帳本 `state/discord-usage.jsonl` 只存 token 桶、模型、時間；金額在讀取時用價目表重算。例外是 `k:"evict"` 彙總行存淘汰當下的金額與 `cur`（幣別）。
- 舊帳本沒有 `cur` 的 evict 行一律視為此前的人民幣，載入時乘 `LEGACY_CNY_TO_USD = 0.15`；`compact()` 重寫時寫 `cur:"USD"`。
- `resolvePriceTable()` 的 `currency`／`symbol` 固定 USD，config 覆蓋這兩欄會被忽略，避免同一組單價被標成別種貨幣。
- 控制台小額金額（< $0.01）改用 3 位有效數字，避免顯示 `$0.0000`。
- 部署前已備份正式帳本為 `state/discord-usage.jsonl.bak-cny-20261107`；部署後看板顯示 $34.56（高峰 $18.82／空閒 $15.74）。

已知缺口（未處理）：
- `compact()` 超過上限後每個事件都會整檔重寫（`src/token-ledger.js:381`）。
- QQ 控制台與 `scripts/console-ui-fixture.mjs` 仍是 CNY。
- `src/web-search.js` 的用量不進帳本，看板會低估這部分。

相關：[[dc-bridge-tests]]。