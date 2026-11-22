---
name: discord-web-search
description: 聯網搜尋 provider 設定、SearXNG 實例踩坑與每回合搜尋上限
---

- `src/web-search.js`：provider 可選 `deepseek`／`bing`／`searxng`／`auto`；SearXNG 實例端點填 `webSearch.searxngURL`（例如 `http://192.168.98.21:58918/search`），LAN 私有位址要設 `webSearch.allowPrivate: true`。
- SearXNG 實例用 `use_default_settings: true` 能搜到相對正常的結果；`search.formats` 要保留 `json`，`server.secret_key` 不留預設 `ultrasecretkey`；備份這份 `settings.yml`（引擎集會跟著 SearXNG 版本走）。
- 引擎：`brave` 偶爾 `too many requests`、`duckduckgo` 偶爾 `CAPTCHA`，但 Bing 等其他引擎補得上，不影響結果。
- SearXNG 實例引擎實測（zh-TW，此 IP）：`sogou` 可用（7-10 筆），可開啟；`bing` 要用 `www.bing.com` + `setlang=zh-hant&cc=TW`（`cn.bing.com` 會 302）；`baidu` CAPTCHA；`quark` unexpected crash；`360search` 只回 3 筆；`mojeek` inactive。Brave 對中文弱，Exa 不適合中文口語／梗，建議中文主力用 Sogou + Bing，付費再加 Serper/Bocha/Z.AI。
- `outgoing.request_timeout` 先維持預設，不要壓到 2 秒；等 log 確實出現慢引擎再調降。`secret_key` 若 instance 非純 LAN 綁定， rotate（對話中曾貼出）。
- DeepSeek key 解析順序：config `webSearch.apiKey` → env（預設 `DEEPSEEK_API_KEY`，可用 `apiKeyEnv` 改）→ DSH `$DSH_HOME/.credentials.yaml` 的 `refs.<ref>`。都沒有時退回 Bing RSS/HTML。
- 2026-11-22 起，`dc-tool-restrict` 對所有會話的 `web_search` 設 DSH 每回合 5 次上限；一般會話的 `web_fetch` 不限次。Bot 預設搜尋／抓取上限仍是 3／2，且 guard 對 Bot 的搜尋和抓取都封頂 5；搜尋設定最多 5，但抓取設定仍可填到 10，文件未說明超過 5 會被封頂。這是 DSH 回合，不是使用者感知的一輪；回訪或「忘了用工具」提醒若開新 DSH 回合，會重新計數。
- 上限依賴 DSH 0.2.2-rc.3 的 `exec.agent.session` 與 `agents.turnBoundaryOf(session).lastTurn`。讀不到回合時採 fail-closed，不重置計數，效果會退化為整個會話最多 5 次，並只記一筆錯誤。
- 這項限制於 2026-11-22 以 `7cda8bf` 部署；當時 `npm run test:discord` 為 40/40，preset patch 檢查通過。部署後尚未用真實搜尋確認 DSH 回合 API 的執行情形。
