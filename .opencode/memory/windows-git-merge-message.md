---
name: windows-git-merge-message
description: PowerShell 下傳 Git merge commit message 的可用寫法
---

2026-11-24 在 PowerShell 執行 `git merge --no-ff -F - <branch>` 得到 `could not read file '-'`；`git merge --no-ff -m "<subject>" -m "<body>" <branch>` 可成功傳入標題與內文。
