---
name: graphify-query
description: graphify_query 結果截斷時的查詢限制
---

廣泛的 `graphify query` 會做 BFS，預設結果可能被截斷；節點清單不能證明完整呼叫關係。查呼叫端時縮小查詢範圍，再用 `graphify explain "<node>"` 看特定節點的已知連線。Graphify 只用來導航；行號與實際呼叫仍須用 Read／Grep 核對。
