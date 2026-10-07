# Changelog

## anti-slop 0.1.0 — 2026-10-07

- First release: comment nudges, phrase avoidance and rewriting, `/anti-slop`.

## unattended 0.1.0 — 2026-10-06

- Auto-resume: after a usage-limit error, waits for the reported reset of the five-hour window (optionally the weekly one) and sends the resume prompt; band, status line, `/auto-resume`; typing cancels; at most `maxResumes` in a row; `/auto-resume test [minutes]` dry run.
- Loop breaker: refuses the Nth identical failing tool call with the same error (default 3rd); warns the model one step earlier; counts restart after any state-changing success or your next prompt; `warn` and `off` modes; `/loop-breaker`.
