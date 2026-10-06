# unattended — a Claude Code mod for leaving it alone

Two things go wrong when you walk away from Claude Code:

1. **It hits the usage limit and just sits there.** The window resets at 3 pm, you come back at 7 pm, and nothing happened for four hours because nobody typed `continue` ([#13354](https://github.com/anthropics/claude-code/issues/13354)).
2. **It gets stuck repeating the same failing call** — the same command, the same error, over and over — and burns the window you were waiting for.

`unattended` fixes both, inside Claude Code, with no daemon, no network calls and no tmux scripts.

```
Usage limit (five-hour): resuming at 15:01, in 1h 42m · 1/3   [Cancel]
Loop stopped: npm run migrate failed 2× the same way            [Dismiss]
```

## Install

```
/plugin marketplace add padezhnov/claude-code-mods
/plugin install unattended@padezhnov
```

Needs Claude Code **2.1.287 or newer** (mods). To try it from a clone without installing:

```
claude --plugin-dir ./plugins/unattended
```

## What it does

### Auto-resume

- When a turn ends on a **usage limit** (`rate_limit`), it reads the reset time Claude Code itself reports for the five-hour window and waits.
- One minute after the reset it sends `continue` (or your own prompt) as if you had typed it.
- A band above the prompt and the status line show when; **typing anything cancels it** — you are back, you decide.
- At most 3 resumes in a row without you typing (setting `maxResumes`), so a session can never spin on its own forever.
- Weekly (`seven_day`) limits are **not** waited for by default — a toast tells you instead. Opt in with `resumeWindows`.
- No reset time reported (API keys, gateways): retries once after 15 minutes (`fallbackMinutes`, `0` turns it off).

`/auto-resume` shows the state; `/auto-resume now` sends it now; `/auto-resume cancel` drops it.

### Loop breaker

- Watches every tool call. The same call (same command, or same edit to the same file) failing **with the same error** is counted; timestamps, PIDs, durations and temp paths are ignored when comparing.
- After 2 identical failures, the model is told that repeating it will be refused. The 3rd identical attempt **is not run**: the model gets a refusal asking it to read the error and change approach or ask you.
- It is not fooled by legitimate retries: any call that **changed something** (an edit, a build, an install) starts all counts again, so "tests fail → fix → run tests" is never blocked. A different error counts as progress. Your next prompt clears everything.
- `warn` mode never refuses — it only tells the model and you. `off` disables it.

`/loop-breaker` lists what is failing repeatedly; `/loop-breaker reset` forgets it.

## Settings

`/plugin` → unattended → configure, or `pluginConfigs.unattended` in settings.

| Setting | Default | |
|---|---|---|
| `autoResume` | `true` | Auto-resume on/off |
| `resumePrompt` | `continue` | What is sent at the reset |
| `resumeWindows` | `five_hour` | `five_hour+seven_day` also waits out weekly limits |
| `maxResumes` | `3` | Resumes in a row without you typing |
| `fallbackMinutes` | `15` | Retry when no reset time is known; `0` = off |
| `loopBreaker` | `stop` | `stop`, `warn` or `off` |
| `loopThreshold` | `3` | The identical failing attempt that is refused |

## What it never does

- No network requests, no telemetry, no files written. Read `plugins/unattended/hooks/register.tsx` — it is one file.
- It never approves permission prompts and never runs a command of its own. The only thing it ever sends is your resume prompt, and only after a usage-limit error.
- It does not bypass limits. It waits for the reset Anthropic reports.

## Where it works

| | Auto-resume | Loop breaker | Band and toasts |
|---|---|---|---|
| CLI (interactive), desktop app | yes | yes | yes |
| VS Code extension | hooks run | yes | no (mods draw no UI there) |
| `claude -p`, SDK | no — the process exits after the turn | yes | no |

## Status

0.1.0, early. 38 tests run against Claude Code's own plugin test harness (`claude plugin test`), and the loop breaker was checked in a live session. Auto-resume has not yet been observed on a real usage-limit hit — if you see it fire (or not), please open an issue with what the band said.

## Development

```
./scripts/check.sh   # claude plugin validate + tsc + claude plugin test
```

MIT licensed.
