# 控制台放大彈窗（detail modal）

> 狀態：**已實作**（branch `feat/knowledge-modal`，尚未 commit／部署）。
> 這份記的是設計與還沒做的取捨；使用者面向的說明在 `docs/guides/DISCORD.md`。

## 目的

控制台表格在窄螢幕塞不下完整內容。把「放大」做成一個共用彈窗，不要每個區塊各寫一個。

目前套用在：

| 區塊 | 入口 | 內容 |
| --- | --- | --- |
| 群知識 | 標題旁的「放大」 | 全文、狀態、範圍、觸發、來源、原訊息連結 |
| 梗圖 | 縮圖或右側「放大」 | 大圖、來源、使用次數、尺寸、標籤、使用情境 |
| 股盤訂單 | 點整列 | 時間、帳戶、標的、方向、股數、狀態、成交價、手續費、稅、原因 |
| 日誌 | 標題旁「放大」 | 等寬全文、寬版、開啟後捲到最新 |

黑話／頻道風格、群友記憶、頻道筆記沒有做：內容短或本來就看得到全部。

## 行為

- `openDetail({ title, meta, body, imageUrl, mono, wide })`
  - `meta` 是 `[[標籤, 字串或 DOM 節點], ...]`
  - `body` 純文字，`white-space: pre-wrap`
  - `mono` 給日誌，`wide` 給 960px
- 關閉：右上按鈕、Esc、在背景按下並放開（卡片內拖選到背景不會誤關）。
- `[hidden] { display:none !important }`：大圖與 meta 用 `hidden` 屬性控制，作者樣式不能蓋掉。
- `detailToken`：每次開／關都遞增；梗圖是非同步載入，回來時 token 對不上就丟掉，避免 A 圖出现在 B 的彈窗。
- 梗圖 blob 走既有的 `memeThumbs` 快取；`fetchMemeThumb()` 回傳 URL，modal 自己決定何時塞進 `<img>`。
- 切分頁時自動關閉。

## 還沒做（留底）

### 1. 焦點鎖定與返回

**現況**：Tab 會跑到背景；關閉時原本的按鈕可能已被 5 秒刷新換掉，焦點掉回頁面。

**建議**：開啟時對 `main` 設 `inert` 或做 Tab 循環；關閉時用選擇器（例如 `[data-meme-view="m_03"]`）重新找元素再 focus。

**預期效果**：鍵盤使用者不會跑到彈窗後面，關閉後回到原本那一列。滑鼠使用者無感。成本約 15 行。

### 2. 彈窗內容是快照

**現況**：訂單從「排隊中」變「已成交」、日誌長新行、知識被改，開著的彈窗都不會更新。

**建議**：每次 refresh 後用 id 重新找同一筆更新；找不到就關。日誌可另外做「跟隨最新」。

**取捨**：閱讀中內容跳動會干擾。建議只更新狀態類欄位，或保留快照加一行提示。先不做。

### 3. 梗圖 blob 只增不減

**現況**：翻過的每一頁梗圖 blob 都留在 `memeThumbs`，只有梗圖被刪才釋放。

**建議**：超過 60 張淘汰最久沒用的（LRU），或離開該頁就釋放。

**預期效果**：長時間開著控制台記憶體不會一直長。目前一張幾十 KB，實務影響小。

## 相關位置

- `public/discord-console.html`
  - `.modal` / `.modal-card` / `.detail-image` / `.modal-head`（sticky）
  - `openDetail()` / `closeDetail()` / `showKnowledgeModal()` / `openMemeDetail()` / `openOrderDetail()`
  - `fetchMemeThumb()` / `loadMemeThumb()`
- `src/discord-bridge.js`：控制台 `trade` handler 補 `accountName`
- `scripts/test-console-ui.mjs`：放大、Esc／背景關閉、刷新不換內容、梗圖 404、訂單 index、手機寬度
