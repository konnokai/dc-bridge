---
name: discord-console-vue
description: Vue 控制台狀態邊界、建置產物與部署方式
---

- 初始化 API 回應非 401 錯誤時不要登出；保留控制台並讓輪詢重試。只有 token 無效的 401 才顯示登入閘門。
- 未登入時不要載入分頁專屬資料。登出時把歸檔的 `loaded` 標記清掉，否則重新登入後可能不再重抓。
- 供應商目錄讀取失敗時不要覆寫已儲存的模型設定。`reasoningEffort: ''` 代表預設；切換模型時保留新模型仍支援的原強度，且選單顯示值必須等於送出的值。
- Vue `computed` 只推導值；分頁等狀態修正應由事件或 watcher 寫入。2026-11-20 審查指出部分清單的 computed 仍會修改頁碼，當時未列入修正。
- `console/src/` 是 Vue 原始碼，`console/discord-console.html` 是 Vite 入口；本機跑 `npm run build:console` 產生並提交 `public/discord-console.html` 單檔。Bridge 直接服務這個產物，伺服器部署不編譯前端。
- `npm run build:console -- --check` 比對產物內的來源 SHA，不會重建；`npm run test:discord` 會用它抓出忘記重建的產物。開發用 `npm run dev:console`，Vite 將 `/api` 代理到本機控制台。

相關：[[dc-bridge-tests]]、[[discord-console-settings]]、[[discord-console-config]]、[[discord-deploy]]。
