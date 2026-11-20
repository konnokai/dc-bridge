# Firecrawl：需要 JS 才長出內容的頁面

這是獨立的 compose，跟 `deploy/alloy` 一樣不屬於其他 stack。Firecrawl 用 Chromium 渲染頁面，
把 markdown 正文交回 `web_fetch`；只在直接抓只拿到「只有標題」時才會用到。

## 跑

```bash
cd /home/jun/dc-bridge/deploy/firecrawl
cp .env.example .env       # 改 POSTGRES_PASSWORD
chmod 600 .env
docker compose up -d
docker compose ps
```

第一次啟動要拉映像和建資料庫，等 1～2 分鐘。`api` 會等 RabbitMQ 與 PostgreSQL 都健康才啟動；
如果它一直重啟，先看 `docker compose logs api`，最常見的原因是 `.env` 沒填
`POSTGRES_PASSWORD` 或 `RABBITMQ_PASSWORD`。

## 驗證

```bash
curl -fsS http://127.0.0.1:3002/v0/health/readiness
curl -fsS -X POST http://127.0.0.1:3002/v2/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

第二個指令要回 `{"success":true,"data":{"markdown":"..."}}`。只有 heartbeat 不算通過。

接著把端點填進 `config.json`：

```json
"webSearch": {
  "firecrawlURL": "http://127.0.0.1:3002"
}
```

重啟 `dc-bridge` 後，`web_fetch` 抓到只有框架的頁面時會自動改走 Firecrawl，結果多一個
`"source": "firecrawl"`。沒有設定這個欄位就維持原本行為，不會偷偷把網址送出去。

## 注意

- API 只綁 `127.0.0.1:3002`，而且沒有認證。**不要**加反向代理或開放防火牆；
  要對外就要另外做一整套認證與 TLS，不在這份設定裡。
- SSRF 的邊界在這條路上交給 Firecrawl：Chromium 會自己跟隨轉址、自己解析 DNS，
  `safeFetch` 的檢查不會帶過去。所以映像固定在上面那個 digest（2026-11-20 的 latest，
  在 Firecrawl 修掉 DNS rebinding 之後），而且只給本機用。設定完先反向驗證：
  `curl -X POST http://127.0.0.1:3002/v2/scrape -H 'content-type: application/json' -d '{"url":"http://192.168.98.21:3110"}'`
  要回空 markdown 和 `Blocked insecure target URL … private/internal address`，不能有正文
  （2026-11-20 實測）。升級映像前先確認目標版本沒有新的 SSRF advisory。
- 這是信任網路的評估設定：Redis、RabbitMQ 沒有落盤，重建容器就清空；只有
  `nuq-postgres-data` 有 volume。抓取結果本身只是即時回傳，不依賴這些資料。
- `POSTGRES_DB` 保持 `postgres`：`nuq-postgres` 映像裡的 `pg_cron` 設定寫死這個名字。
- 映像沒有版本 tag，只發佈 `latest`；compose 已固定 digest。升級時換 digest，
  再跑一次上面的健康檢查與 scrape。
- 這台 31 GB RAM；這份設定的上限是 api 4 GB、Playwright 3 GB、其餘各 0.5～1 GB。
  機器同時跑很多服務時，先看 `docker stats` 再調整。
- 預設 `BLOCK_MEDIA=true`：只抓文字，不抓圖片與影片。需要截圖或頁面操作的功能
  自架版沒有，要另外接 Fire-engine 或改用 Firecrawl Cloud。

## 停掉

```bash
docker compose down          # 保留 PostgreSQL volume
docker compose down -v       # 連 volume 一起刪，下次重建資料庫
```
