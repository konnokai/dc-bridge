---
name: discord-group-consensus-memory
description: Proposed group-consensus memory type gap (not implemented) and submitted feedback
---

- Existing memory types: user memory (`remember_user`), channel notes (`note_event`), slang (`record_slang`). None fits a group stance/preference.
- Admin asked where to store "this group's attitude toward a term" (e.g. dislike of 百破). Bot proposed a fourth type "群共識": admin-added one sentence, expirable, injected per turn; block derogatory evaluations; store as "this group dislikes X", not "they are idiots".
- Feedback submitted via `submit_feedback` as `df_mw6f6fbe08b055`.
- Not implemented as of 2026-11-07.

See [[discord-memory]], [[discord-channel-notes]].