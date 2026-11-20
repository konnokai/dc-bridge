# Discord 控制台離線預覽與回歸

## 前端原始碼與建置

控制台前端在 `console/`（Vite + Vue），伺服器只讀打包後的單一檔案
`public/discord-console.html`。改完原始碼一定要重建：

```bash
npm run build:console          # 產出 public/discord-console.html
npm run build:console -- --check   # 比對產物裡的原始碼指紋，抓「忘了重建」
npm run dev:console            # vite dev server，開 http://localhost:5173/discord-console.html?token=…
```

`/api` 會代理到 `127.0.0.1:3110`，所以本機要先跑著控制台。

`public/discord-console.html` 是產物、要進版控：部署只做 `git checkout` + `npm ci`，
不會在伺服器上 build。`scripts/test-console-static.mjs` 會呼叫 `--check`，
它只比對產物裡的原始碼指紋，不需要 vite，也不需要重建。

`console/discord-console.html` 是 Vite 的入口，檔名刻意跟產物一樣，輸出才不用改名。
JS／CSS 由 `vite-plugin-singlefile` 全部內嵌，維持原本的 CSP（`script-src 'unsafe-inline'`）。

## 瀏覽器回歸

```bash
npm run test:console-ui          # 等於 node scripts/test-console-ui.mjs
```

腳本需要 `playwright` 模組與 Chromium，兩者缺一就在啟動時直接中止，**不會**自動改用本機瀏覽器。先裝：

```bash
npm install --no-save playwright
npx playwright install chromium
```

已經有可用的 Chromium／Chrome／Edge 時，可以用環境變數指定：

- `PLAYWRIGHT_MODULE`：Playwright 模組目錄。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`：Chromium／Chrome／Edge 執行檔。

測試自己起 `startConsole()` mock server，只連 `127.0.0.1` 的隨機埠；不會連真實 Discord、DSH 或正式 `state/`。

## 沒有本機 Chrome 的環境（OpenChamber）

OpenChamber 這台沒有本機 Chrome／Edge 時，`npm run test:console-ui` 會直接中止。這不是測試失敗；目視檢查改用 `openchamber_web`：

1. 照 `scripts/test-console-ui.mjs` 的 `startConsole({ host, port, token, htmlPath: 'public/discord-console.html', handlers: {...} })` 起一個臨時 server。handlers 要包含頁面會打的每一個 `/api/*`，缺一個就 500。
2. `browser.open` 開 `http://127.0.0.1:<port>/?token=t#sessions`，`browser.snapshot` 讀文字與可點元素，要互動就 `browser.click`；看完 `browser.close`。
3. 這種檢查是人工目視，不算回歸。改前端後仍要跑 `scripts/test-console-static.mjs`（ID 唯一、產物與原始碼一致、設定欄位與表格契約）和 `npm run test:discord`。

有 Playwright 時建議直接跑 `npm run test:console-ui`，它涵蓋欄寬、手機溢出、分頁、彈窗與設定讀寫。

## 手機版表單欄位

手機的原生表單控制項常常比容器寬：`<select size>` 在下拉按鈕模式會跟著最長選項，時間欄位在部分瀏覽器也不吃 `width: 100%`。
所以表單控制的容器要能壓縮，欄位自己也要夾住寬度：

- `input, select, textarea` 有 `min-width: 0` 和 `max-width: 100%`；`checkbox`／`radio` 例外，不然放在 flex 的 label 裡會被壓扁。
- iOS 的 `date`／`time` 欄位把 `width` 當內容寬度算，左右的 padding 和邊框會讓它比容器多 20px（WebKit bug 301648）。所以有一段 `@supports (-webkit-touch-callout: none)` 的 `width: calc(100% - 20px)`；改欄位的 padding 或 border 時，這個 20px 要一起改。
- `.grid` 的子項有 `min-width: 0`，容器才不會被其中一個欄位撐寬。
- 放原生控制項的巢狀 grid（例如 `.provider-picker`）要固定欄寬 `minmax(0, 1fr)`。
- `<select size>` 的列高交給 `size` 屬性，不要固定 `height`；手機只畫一行下拉按鈕，固定高度會留下一個空盒子。
- 手機上 `input`／`textarea` 用 16px 避免 iOS 聚焦時放大頁面；`select[size]` 維持 12px，不然清單會變很高。

`scripts/test-console-ui.mjs` 有一條回歸：把下拉選單和時間欄位故意設成比卡片寬，其他欄位和頁面不能跟著變寬；同一條也檢查 checkbox 沒被壓扁。
