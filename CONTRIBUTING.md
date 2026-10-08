# Contributing

Issues and pull requests are welcome.

- **A false positive or a miss** is the most useful report: use the issue templates and paste the command or edit (redact anything private) plus the mod's `/<mod>` status output.
- **Code:** each mod lives in `plugins/<name>/`. Pure logic sits in its own file without `$` and is unit-tested directly; `hooks/register.ts(x)` stays thin.
- **Checks** (the same ones CI runs):
  ```
  npx -y @anthropic-ai/claude-code@latest plugin validate plugins/<name>
  npx -y @anthropic-ai/claude-code@latest plugin test plugins/<name>
  ```
  `./scripts/check.sh` runs both plus `tsc` for every plugin.
- No network calls, no telemetry, no new dependencies without a good reason.
- Never put real tokens in tests; build fake ones from parts so secret scanners stay strict.

By contributing you agree your work is released under the MIT license.
