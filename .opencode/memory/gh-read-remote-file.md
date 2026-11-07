---
name: gh-read-remote-file
description: 用 gh api 在 PowerShell 讀 GitHub 上的單一檔案，不必 clone
---

查上游實作（例如 [[codex-imagegen-internals]]）不用 clone。`gh api .../contents/<path> --jq .content`
回的是 base64，而且是多行／字串陣列，直接丟進 `FromBase64String` 會炸
（`Cannot find an overload for "FromBase64String"`，或 `Index and length must refer to...`）。

會動的寫法：

```powershell
$raw = (gh api "repos/openai/codex/contents/codex-rs/ext/image-generation/tool.rs" --jq .content) -join ""
$clean = $raw -replace '\\n', '' -replace '"', ''
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($clean))
```

先 `gh search code "<keyword> repo:<owner>/<repo>"` 找檔案位置，比猜路徑快。
這台機器的 `gh` 已用 keyring 登入（`gh auth status` 可確認）。
