---
name: discord-upstream-sync
description: 上游對齊基準、空合併清 behind、安全批次吸收
---

- 基準與歷史：`docs/guides/UPSTREAM_SYNC.md`。本機 `main` 已用 `git merge -s ours upstream/main` 空合併，`upstream/main` 是 HEAD 祖先，`git rev-list --count HEAD..upstream/main` 為 0；基準指向空合併後的 HEAD（commit b145a83）。不要按 GitHub Sync fork（會把 QQ 端 commit 拉回來）；要歸零用 `-s ours`。
- 比對流程只跑基準之後的新 commit（`git log <基準>..upstream/main`），先分類 QQ／共用／文件，先寫 UPSTREAM_SYNC 決策再改程式，跑 `test:discord` 與相關 audit，更新基準；必要時再 `-s ours`。
- 已吸收的安全批次（commit 8f918fa）：`src/web-search.js` 搜尋結果遮掉 API key、搜尋端點錯誤不再帶上游回應內容；`src/safe-fetch.js` 擋 Azure WireServer `168.63.129.16`、fake-ip `198.18/15` 給可操作錯誤訊息；`src/dsh-client.js` DSH RPC 禁止跟隨重定向、簽名金鑰讀取失敗可重試；`src/state-acl.mjs` ACL 改成先授權再斷繼承、每步回讀自檢。新增測試 `scripts/test-audit-security.mjs`、`scripts/test-media-search.mjs`、`scripts/test-hardening.mjs`。
- 固定決策：`web_fetch` 只允許 https/443（不套上游放寬的 http + 80/8080/8443）；記憶與黑話維持跨伺服器共用。
- 建議把流程做成 skill `upstream-sync`（使用者已同意），但尚未建立。