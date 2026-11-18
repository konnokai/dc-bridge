---
name: discord-console-mobile-layout
description: 控制台手機表單縮寬、iOS WebKit 修正與 Android 原生欄位實測
---

`public/discord-console.html` 的原生表單控制項在窄螢幕上需要允許縮到欄寬內。這些規則於 2026-11-18 部署並在實機 iPhone Chrome 驗證。

- `input`、`select`、`textarea` 設 `min-width: 0; max-width: 100%`；`.grid > *` 也設 `min-width: 0`。巢狀 `.provider-picker` 用 `grid-template-columns: minmax(0, 1fr)`，避免模型選單最長選項撐開卡片。
- `input[type="checkbox"]` 和 `input[type="radio"]` 要重設 `min-width: auto; max-width: none`。全域 `min-width: 0` 會讓 flex label 內的勾選框跟文字一起縮小。
- iOS WebKit 的 [bug 301648](https://bugs.webkit.org/show_bug.cgi?id=301648) 會讓有 padding 的 date/time 類欄位實際寬過 `width: 100%`。目前只在 WebKit 觸控裝置套 `width: calc(100% - 20px)`。這個 20px 偏移配合目前 `padding: 7px 9px` 和 1px 邊框；調整欄位樣式時要重新量。
- `scripts/test-console-ui.mjs` 的 360px 測試刻意把模型 `select` 設成 `width: max-content`、時間欄位設成 420px；先確認模擬的 select 原寬確實超過卡片，再檢查頁面不橫向溢出、欄位留在卡片內、可見 checkbox 寬度至少 12px。
- 供應商的 `<select size="8">` 不要再固定 `height`：桌機由 `size` 決定清單高度；iPhone WebKit 會顯示約 27px 的原生下拉按鈕。思考強度欄位用 `.provider-picker label { display: inline-flex; gap: 8px }`，避免選單貼著標籤。
- `test-console-ui` 的觸控模擬仍把 `<select size>` 畫成約 140px 的清單，所以回歸斷言用 `< 160px` 排除舊的固定 168px；這不是 iOS 原生控制項的高度測試。
- 2026-11-18 iPhone WebKit 實測：選單 27px、思考強度間距 8px、復盤時間欄位貼齊卡片且沒有橫向捲動；桌機 Chromium 顯示約 140px。`test-console-ui` 15/15、`test-console-static` 通過、Discord suite 34/34；變更已部署。
- iPad 接滑鼠或觸控板時仍可能符合 `hover: hover`，因此 WebKit 時間欄位的 20px 寬度修正不會套用；可能比卡片寬 20px。iPad 實機仍未驗證。
- 2026-11-18 的 S25 Android Chrome 測試頁（360 CSS px）實測：`scrollWidth=360`；供應商篩選與模型選單寬 268px、右緣 314px，貼齊卡片內容右緣；`<select size>` 顯示 135px 可捲動清單；思考強度選單高 28px、與標籤間距 8px；復盤時間欄位寬 294px、右緣 327px，貼齊卡片內容右緣，原生下拉可用；checkbox 大小正常。長選項名稱在 Android 原生清單中會被右側裁切；要完整顯示需加寬選單。

測試流程見 [[dc-bridge-tests]]；相關設定版面見 [[discord-console-settings]]。
