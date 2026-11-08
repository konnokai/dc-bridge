---
name: discord-jev-decision-gate
description: Jev (typesafe/jev) decision gate analysis: model details, cost data, conclusion not worth it, shadow mode plan, provider switch verification
---

## Jev model facts

- Model: `typesafe/jev` (Command Code Provider API). Endpoint `POST https://api.commandcode.ai/provider/v1/systemone`, Bearer key from Studio (separate from DSH credential store; pass via env var, never read DSH credentials).
- Request: `{model:"typesafe/jev", state:"<text>", questions:{name:{type:"noul"|"choice"|"score", instructions, criteria}}}`. Response is `answers` with probabilities only, no text output.
- Limits: up to 100 questions per request, shared 64K context (state + all questions), 32K per question. No streaming. No ZDR (sending `x-cmd-zdr` returns 422).
- Pricing: $0.042/M input tokens, $0 output. GOAT monthly quota for Jev is $20 (~595k requests/month estimated).
- Only reachable via headless (`cmd -p`) or Provider API; not in `/model` picker. GOAT has API access; API usage counts against plan quota.

## Data analysis (2026-10-27 to 11-07, 3 channels)

Channels analyzed: `ch:1305879940746580011`, `ch:1073905098457108551`, `ch:1354000283629518919`. 80 sessions, 10,958 turns, DeepSeek V4.1 Flash pricing.

| Turn type | Count | Share | Total cost | Per turn |
|---|---|---|---|---|
| Silent free participation | 8,481 | 77% | $3.20 | $0.00038 |
| Spoke free participation | 1,562 | 14% | $1.32 | $0.00085 |
| Spoke direct (@/reply) | 764 | 7% | $0.70 | $0.00092 |
| Silent direct | 8 | 0.1% | ~$0 | — |
| Other (reminders/system) | 143 | 1% | $0.53 | $0.00374 |

- Direct (@/reply) turns: only 772 total (7%). 93% are free participation where model decides to speak or not.
- Silent free cost is much lower than opus estimated ($0.001-0.0025): model outputs ~25 tokens when silent, cost is mostly cache read + small input.
- Misblock risk: 1,562 free-participation turns (16% of free turns) where model did speak. Jev must not block these.
- Daily: ~900 turns across 3 channels, ~$0.50/day. GOAT 5-hour $20 quota is far from exhausted.

## Conclusion

Jev gate not worth it. Max savings ~$8/month, minus Jev's own cost and misblock losses. Misblock risk is real (16% of free turns speak). Third-party data sharing (no ZDR). Better alternatives: lengthen debounce for chatty channels (fewer turns, no external service, no data sharing).

## Shadow mode plan (if ever needed)

1. In `deliverPrompt`, after quiet check and before `buildBatchPrompt`, call Jev asynchronously (do not await). Log `{key, lastMessageId, p_yes}`.
2. At turn end (`agentSender.finishTurn` returns `sent`/`reacted`), log `{key, lastMessageId, sent, reacted}`.
3. Correlate offline by message id. Calculate false-block rate (model spoke but p_yes below threshold) and savings rate (model silent and p_yes below threshold).
4. Collect 300+ batches. Open gate only if false-block < 5% and savings > 40%.
5. Threshold: block only `p_yes < 0.15` (start wide, tune from data).
6. Fail-open: timeout 3s, HTTP error, quota exhausted, unparseable response all pass through. Pause gate 10 min after N consecutive failures.
7. State content: one-line bot intro (name/aliases/topics), last 6-8 messages including bot's (tagged "bot"), this batch. Images as "[image]", voice as "[voice]". No group memory/notes/slang (no ZDR, not helpful for decision).
8. Bypass gate entirely for: direct turns, @-mode follow-ups, system messages, image completion, NO_TOOL reminders, followups, quiet periods, messages containing bot name/alias, channels where bot spoke in last 2-3 min.
9. Blocked batch handling: `primedKeys.delete(key)`, return false. `deliverPrompt` already documents "false means no turn dispatched, gate must release itself". Next batch's `buildBatchPrompt` sees `!primedKeys.has(key)` and auto-reloads channel context (12 messages, 3000 chars). Same mechanism as `/blacklist` `silentPending`. Add "skipped N messages" line if needed (like `job.dropped` at discord-bridge.js:4191). No separate buffer (would be mistaken as new messages).
10. Jev key: separate Studio key, passed via env var, never read DSH credential store.

## Provider switch verification (commandcode)

- DSH plugin: `@mars-sea/dsh-commandcode-provider` (MIT, dsh 0.2.1-rc.2+). Provider id `commandcode`. Model format `deepseek/deepseek-v4.1-flash`. Supports reasoning effort. Images only on Vision models.
- Verification after switch: `cacheReadTokens > 0` in a long session (most important; if cache not forwarded, cost 3-5x). Plugin has `offloadSeenImagesForCache` to mitigate cache eviction from new images.
- Usage field names must match price table.
- Plugin issue #84: GOAT rejects `claude-haiku-5-5` calls; DeepSeek unaffected.
- Plugin issue #105: multi-account auto-switch has bugs; single account unaffected.
- Code changes needed: `src/discord-bridge.js:789` (quota dispatch hardcoded to `opencode-go`), `src/model-prices.js:98-127` (peak multiplier is global, not provider-specific).

Handoff: `docs/design/HANDOFF_COMMANDCODE_PROVIDER.md` (2026-11-07; provider switch only, Jev rejected).

See [[discord-commandcode-provider]], [[discord-codex-quota]], [[discord-usage-pricing]].