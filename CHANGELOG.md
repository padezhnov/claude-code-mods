# Changelog

## unattended withdrawn before the first public release — 2026-10-08

- Claude Code now continues after a usage limit on its own ("Continue automatically at usage limit", on by default), and the loop breaker never fired on a month of real sessions, so it is not shipped.

## anti-slop 0.2.0 — 2026-10-08

- Comment notes only for comments that narrate the edit (English and Russian), at most one per file and three per session; the comment-count rule is opt-in. Openers like "You're absolutely right" dropped from stored replies, "load-bearing" only avoided; JSON never rewritten. See `plugins/anti-slop/CHANGELOG.md`.

## native-edits 0.1.0 — 2026-10-07

- The auto-mode note wording it rewrites is unchanged through Claude Code 2.1.294 (checked 2026-10-09).

- First release: the auto-mode note's shell-edit sentence rewritten to send file changes to Edit and Write; Bash commands that write project files refused (`deny`) or noted (`warn`); `scope`, `allowPaths`, `/native-edits`.

## anti-slop 0.1.0 — 2026-10-07

- First release: comment nudges, phrase avoidance and rewriting, `/anti-slop`.

