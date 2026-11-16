---
name: discord-slang-batch-actions
description: Discord console batch selection and confirm/reject for slang and channel-style candidates
---

The Discord console supports batch confirm/reject for slang and channel-style candidates.

- Selection is limited to visible candidates on the current page. Clear it when page, status, channel, or search changes; refreshes must also discard entries no longer visible.
- The server rechecks that each selected entry is still a candidate before changing it. Do not rely only on the client selection state.
- The feature reduces repeated individual actions when many candidates arrive together. The underlying slang lifecycle remains in [[discord-slang-mcp]].
