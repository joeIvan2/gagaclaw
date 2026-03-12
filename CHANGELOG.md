# Changelog

## v1.3.2 (2026-03-13)

### Bug Fixes
- **`/new` cascade switch state leak**: `telegram.js` and `cli.js` now use `switchCascade(newId)` instead of manually setting `cascadeId` and reopening the stream, so polling state resets correctly and new-conversation steps are no longer skipped.

## v1.3.1 (2026-03-12)

### Bug Fixes
- **Premature turnDone** — Thinking message disappeared immediately because `USER_INPUT(DONE)` triggered turnDone. Now requires new content steps after send point and last step must not be `USER_INPUT`.
- **Duplicate YOLO approve** — Same WAITING step approved multiple times because server hadn't updated status yet. Added `_pollApprovedSteps` tracking to skip already-approved steps.
- **write_to_file path=null** — Added `FilePath`/`filePath` to permission path extraction, fixing empty `absolutePathUri` in approve payload.
- **"interaction channel is full" (500)** — Caused by duplicate approves flooding the server. Fixed by the approved-steps tracking above.

## v1.3.0 (2026-03-12)

### Bug Fixes
- **Polling response lag** — Fixed bot answering with previous turn's response. Polling now tracks step count at `send()` time and only processes steps after that point.
- **Slow turnDone detection** — Reduced idle threshold from 10→4 polls and debounce from 2s→1s. Total reaction time from ~7s to ~3s.

## v1.2.0 (2026-03-11)

### Breaking: Antigravity 1.20.5+ Compatibility
Antigravity IDE v1.20.5 disabled `StreamCascadeReactiveUpdates` (protobuf diff streaming). Gagaclaw now **auto-detects** the IDE version and seamlessly falls back to polling `GetCascadeTrajectory` when streaming is unavailable.

- Old versions (streaming works) → unchanged behavior
- New versions (streaming disabled) → automatic polling fallback, no config needed

### New Features
- **Polling fallback engine** — Adaptive polling (500ms active / 3000ms idle) via `GetCascadeTrajectory`. Supports full delta tracking for thinking, response, tool calls, permission detection, and turn-done. Scans all steps for WAITING permissions (not just the last step).
- **`/usage` command** — Real-time model quota monitoring via `GetUserStatus` API. Shows per-model remaining percentage with visual progress bars (CLI) and emoji indicators (Telegram: 🟢 >50%, 🟡 20-50%, 🔴 <20%). Includes reset time when available.
- **`/sync` command** — Syncs IDE UI to the current Gagaclaw conversation by navigating Antigravity's chat panel via CDP.

### Improvements
- **Permission debounce** — 1-second delay before emitting WAITING approval, preventing false triggers when the server auto-resolves.
- **Approve retry enhancement** — Increased from 5 retries (escalating delay) to 12 retries with fixed 1s delay (~12s total), handling slow browser-action steps.
- **Stream `_updateIndex` tracking** — Processes `updateRepeated.updateIndices` in the protobuf parser to correctly resolve stepIndex from array positions when metadata doesn't include it.
- **Trailer frame forwarding** — `nodeStreamFetch` now forwards trailer frame payloads to the frame handler, enabling error detection (e.g. "reactive state is disabled") that was previously silently discarded.
- **Rapid reconnection detection** — If the stream disconnects twice within 3 seconds, automatically switches to polling (backup for trailer-based errors).
- **Telegram bot command registration** — `/usage` and `/sync` now appear in Telegram's command autocomplete menu.

### Bug Fixes
- **Permission type misclassification** — Fixed `run_command` and `file` permissions being incorrectly classified as `browser` when cross-diff re-resolve overwrote walk()'s correct result. Added `_stepPathMap` cache for `permissionPath` persistence across diffs.
- **YOLO approve failure notification** — `approvePermission()` now returns boolean; failed auto-approves emit `yoloError` event and notify via Telegram.
- **MCP config renamed** — `mcp_config.json` → `mcp_config.example.json` with `<ABSOLUTE_PATH>` placeholder. Setup docs updated to copy-and-configure workflow.

## v1.1.0 (2026-03-05)

### New Features
- **Linux & macOS support** — Setup prompts now support Linux (Host mode, Docker B1/B2 mode) and macOS. The AI-guided installer detects the platform and generates appropriate launch scripts.
- **Cron prompt visibility** — Cron job prompts now appear as visible messages in Telegram before AI processing.
- **Startup version check** — Compares local version with GitHub on startup, notifies if update is available.
- **Server error detection** — Detects 503 and other server errors in the stream, reports to user when no response is produced.

### Improvements
- **Telegram HTML rendering** — Added `fixTgHtml()` to auto-close unclosed/misnested HTML tags during streaming. Added `<tg-spoiler>`, `<tg-emoji>`, `<blockquote expandable>` support.
- **Rate limit handling** — Respects Telegram 429 `retry_after`, auto-retries instead of failing.
- **Streaming display** — Thinking and response show last 3000 chars with continuous updates. At turn end, streaming message is deleted and full response is sent as new messages.
- **"Message not modified" fix** — Skips edits when content hasn't changed, eliminating spam.

### Config Changes
- `defaults.model` now requires the full model ID (e.g. `MODEL_PLACEHOLDER_M37`), not shorthand keys like `high`.
- `gagaclaw.example.json` updated with `adminChatId` field and correct model ID.

### Bug Fixes
- Fixed `<a>` tag missing from `fixTgHtml`, causing HTML parse failures.
- Fixed `<br>` tag (unsupported by Telegram) converted to `\n`.
- Fixed `processCronQueue` missing `async` keyword for `await tgSend`.
- Fixed MCP `adminChatId` fallback to `allowedUsers[0]`.

## v1.0.0 (2026-03-01)

Initial release.
- Telegram bot interface with inline keyboard buttons
- CLI interactive terminal interface
- Multi-model support (Gemini, Claude, GPT)
- Cron scheduler for recurring AI tasks
- MCP server (groq_transcribe + telegram_send_file)
- Permission system with YOLO auto-approve mode
- Workspace system with soul.md and memory.md
