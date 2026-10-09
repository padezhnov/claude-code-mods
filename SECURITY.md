# Security

Mods run inside Claude Code with your permissions and no sandbox, so what they can do matters.

## What these mods do and do not do

| Mod | Reads | Changes | Network |
|---|---|---|---|
| anti-slop | your edits (and, before a Write, the file being replaced) to count comments; Claude's replies | adds a note for Claude after an edit; rewrites listed openers in stored replies; adds a short style section to the system prompt; keeps local counters in its plugin store | none |
| native-edits | Bash commands (to spot file writes) | refuses Bash writes to project files; rewrites the shell-edit sentences of Claude Code's auto-mode note and adds one line to the Bash tool's description; keeps counters and the last 5 refused file names in its plugin store | none |

Neither sends data anywhere, writes telemetry, or approves permission prompts. Read `plugins/<name>/hooks/` before installing; each release is a git tag (`anti-slop-v0.2.0`, `native-edits-v0.1.0`) whose code you can read as it was released.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. You will get an answer within a week.
