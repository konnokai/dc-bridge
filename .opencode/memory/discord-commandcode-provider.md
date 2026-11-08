---
name: discord-commandcode-provider
description: Command Code provider switch (commandcode): default model, price alias, quota API and monthly cap shortcut
---

- Bridge default provider/model switched to `commandcode` / `deepseek/deepseek-v4.1-flash` (config default and build-discord-emojis); opencode-go path retained for quota dispatch.
- Plan/handoff: `docs/design/HANDOFF_COMMANDCODE_PROVIDER.md` (provider switch steps, Jev rejection cost table, code locations; Jev not implemented).
- Price table: `deepseek/deepseek-v4.1-flash` aliased to `deepseek-v4.1-flash` at the same rates; `PRICE_TABLE_VERSION` → `2026-11-07b`.
- Command Code quota: `GET https://api.commandcode.ai/alpha/billing/credits` with Bearer key from env `COMMANDCODE_API_KEY` or DSH credential ref `COMMANDCODE_API_KEY`; headers include `accept-encoding: identity`. Returns `credits.monthlyCredits` remaining and `windowLimits.fiveHour`/`weekly` `{used,cap,exceeded,resetAt}`.
- Monthly cap is not reported by the API; bridge hardcodes `GOAT_MONTHLY_CREDITS = 70` for the monthly percentage row (GOAT only; shortcut).
- Pricing reality: GOAT published values are monthly $100 / 5-hour $20 / weekly $50, but this account actually receives 0.7x of each ($70 / $14 / $35). Three windows all consistent at 0.7x. Reason unknown (plan version / region / discount); subscription API exposes no amount or discount field. Only ask Command Code support.
- DSH plugin `@mars-sea/dsh-commandcode-provider` also hardcodes monthlyCredits in a `KNOWN_SUBSCRIPTION_PLANS` table (`lib/index.js`, snapshot "re-verified through command-code@1.73.0"): `individual-goat: monthlyCredits: 70`. Its card reads this constant, so it shows $70 regardless of Command Code changes. Bridge's 70 happens to match the real account value, but both are hardcoded; if Command Code changes pricing, both will be wrong with no warning.
- `quotaInfo()` dispatches by provider (`opencode-go` vs `commandcode`); `formatQuota()` unified with `QUOTA_NAMES`.
- DSH profile `web` bundles `@mars-sea/dsh-commandcode-provider` ^0.17.2; `routableProviders` = `commandcode`, `opencode-go`. Command Code catalog group includes `deepseek/deepseek-v4.1-flash` (`Go · Half · Image · 1M`, reasoning `off`/`high`/`max`) among others.

See [[discord-codex-quota]], [[discord-usage-pricing]].