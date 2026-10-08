# Security

Mods run inside Claude Code with your permissions and no sandbox, so what they can do matters.

## What these mods do and do not do

| Mod | Reads | Changes | Network |
|---|---|---|---|
| unattended | tool calls and their results, usage-limit info Claude Code reports | refuses a repeated failing call; may send your resume prompt after a limit or a transient API error | none |
| anti-slop | your edits (to count comments), Claude's replies | adds a note for Claude after an edit; rewrites listed phrases in stored replies | none |
| native-edits | Bash commands (to spot file writes) | refuses Bash writes to project files; rewrites one sentence of Claude Code's auto-mode instructions | none |

None of them send data anywhere, write telemetry, or approve permission prompts. Each is a few small TypeScript files — read `plugins/<name>/hooks/` before installing, and pin a release tag.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. You will get an answer within a week.
