# Changelog

## unattended withdrawn from the first public release — 2026-10-08

- Claude Code now continues after a usage limit on its own ("Continue automatically at usage limit", on by default), and the loop breaker never fired on a month of real sessions. The code is kept on the `unattended-wip` branch until it earns its place.

## anti-slop 0.2.0 — 2026-10-08

- Comment notes only for comments that narrate the edit (English and Russian), at most one per file and three per session; the comment-count rule is opt-in. Openers like "You're absolutely right" dropped from stored replies, "load-bearing" only avoided; JSON never rewritten. See `plugins/anti-slop/CHANGELOG.md`.

## native-edits 0.1.0 — 2026-10-07

- First release: the auto-mode note's shell-edit sentence rewritten to send file changes to Edit and Write; Bash commands that write project files refused (`deny`) or noted (`warn`); `scope`, `allowPaths`, `/native-edits`.

## anti-slop 0.1.0 — 2026-10-07

- First release: comment nudges, phrase avoidance and rewriting, `/anti-slop`.

## unattended 0.1.0 — 2026-10-06

- Auto-resume: after a usage-limit error, waits for the reported reset of the five-hour window (optionally the weekly one) and sends the resume prompt; band, status line, `/auto-resume`; typing cancels; at most `maxResumes` in a row; `/auto-resume test [minutes]` dry run.
- Loop breaker: refuses the Nth identical failing tool call with the same error (default 3rd); warns the model one step earlier; counts restart after any state-changing success or your next prompt; `warn` and `off` modes; `/loop-breaker`.
