# Claude Code mods by Evgeny Padezhnov

| Mod | What it does |
|---|---|
| [**unattended**](#unattended) | Resumes on its own after a usage-limit reset; stops the agent burning the new window on the same failing call. |
| [**anti-slop**](#anti-slop) | Fewer narrating comments and stock phrases: nudges Claude right after a comment-heavy edit; keeps "load-bearing" and "You're absolutely right" out of replies. |

```
/plugin marketplace add padezhnov/claude-code-mods
/plugin install unattended@padezhnov
/plugin install anti-slop@padezhnov
```

Needs Claude Code **2.1.287 or newer** (mods). Each mod is one or two small files with no network access — read them before installing.

---

## unattended

Two things go wrong when you walk away from Claude Code:

1. **It hits the usage limit and just sits there.** The window resets at 3 pm, you come back at 7 pm, and nothing happened for four hours because nobody typed `continue` ([#13354](https://github.com/anthropics/claude-code/issues/13354)).
2. **It gets stuck repeating the same failing call** — the same command, the same error, over and over — and burns the window you were waiting for.

`unattended` fixes both, inside Claude Code, with no daemon, no network calls and no tmux scripts.

```
Usage limit (five-hour): resuming at 15:01, in 1h 42m · 1/3   [Cancel]
Loop stopped: npm run migrate failed 2× the same way            [Dismiss]
```

### Install

```
/plugin install unattended@padezhnov
```

To try it from a clone without installing:

```
claude --plugin-dir ./plugins/unattended
```

### What it does

#### Auto-resume

- When a turn ends on a **usage limit** (`rate_limit`), it reads the reset time Claude Code itself reports for the five-hour window and waits.
- One minute after the reset it sends `continue` (or your own prompt) as if you had typed it.
- A band above the prompt and the status line show when; **typing anything cancels it** — you are back, you decide.
- At most 3 resumes in a row without you typing (setting `maxResumes`), so a session can never spin on its own forever.
- Weekly (`seven_day`) limits are **not** waited for by default — a toast tells you instead. Opt in with `resumeWindows`.
- No reset time reported (API keys, gateways): retries once after 15 minutes (`fallbackMinutes`, `0` turns it off).

`/auto-resume` shows the state; `/auto-resume now` sends it now; `/auto-resume cancel` drops it.

**Try it without waiting for a real limit:** `/auto-resume test 1` arms a resume one minute out, exactly as a usage limit would. Leave the session idle and watch the band, the status line and `continue` arriving on their own.

#### Loop breaker

- Watches every tool call. The same call (same command, or same edit to the same file) failing **with the same error** is counted; timestamps, PIDs, durations and temp paths are ignored when comparing.
- After 2 identical failures, the model is told that repeating it will be refused. The 3rd identical attempt **is not run**: the model gets a refusal asking it to read the error and change approach or ask you.
- It is not fooled by legitimate retries: any call that **changed something** (an edit, a build, an install) starts all counts again, so "tests fail → fix → run tests" is never blocked. A different error counts as progress. Your next prompt clears everything.
- `warn` mode never refuses — it only tells the model and you. `off` disables it.

`/loop-breaker` lists what is failing repeatedly; `/loop-breaker reset` forgets it.

### Settings

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

### What it never does

- No network requests, no telemetry, no files written. Read `plugins/unattended/hooks/register.tsx` — it is one file.
- It never approves permission prompts and never runs a command of its own. The only thing it ever sends is your resume prompt, and only after a usage-limit error.
- It does not bypass limits. It waits for the reset Anthropic reports.

### Where it works

| | Auto-resume | Loop breaker | Band and toasts |
|---|---|---|---|
| CLI (interactive), desktop app | yes | yes | yes |
| VS Code extension | hooks run | yes | no (mods draw no UI there) |
| `claude -p`, SDK | no — the process exits after the turn | yes | no |

### Status

0.1.0, early. 39 tests run against Claude Code's own plugin test harness (`claude plugin test`), and the loop breaker was checked in a live session. Auto-resume has not yet been observed on a real usage-limit hit. If you see it fire (or not), please open an issue with the [auto-resume report](../../issues/new?template=auto-resume-report.md) template — `/auto-resume status` output is all it needs.

---

## anti-slop

Two long-running complaints about Claude Code: it piles comments onto code that restate it or narrate the edit, and ignores instructions to stop ([#65961](https://github.com/anthropics/claude-code/issues/65961)); and it cannot stop saying "load-bearing" ([#53454](https://github.com/anthropics/claude-code/issues/53454)).

- **Comments.** After an edit succeeds, it counts the comment lines the edit added. Three or more that make up 30% of the new lines — or any single comment narrating the change ("added X", "now uses Y", "as requested") — and Claude gets a note, right then, to remove the ones that restate the code. The edit is never refused (that only burns tokens). Tool directives (`eslint-disable`, `noqa`, `@ts-expect-error`, shebangs) and prose files (`.md`, `.txt`) are not counted.
- **Phrases.** A short system-prompt section asks Claude to avoid them, and the reply as the conversation stores it is rewritten (`load-bearing` → `critical`, an opening "You're absolutely right!" dropped) so Claude does not keep echoing itself. Code spans and fences are left alone. What already streamed to your screen may still show the original.
- `/anti-slop` shows what it caught. Settings: `comments` (`nudge`/`off`), `minComments`, `commentPercent`, `phrases` (`phrase=>replacement`, `phrase=>` to drop, bare phrase to only avoid), `rewrite`.

Checked in a live session: asked to comment every line, Claude made the edit, got the note, and removed the comments in a second edit; asked to say "load-bearing", the reply read "critical".

---

## Development

```
./scripts/check.sh   # claude plugin validate + tsc + claude plugin test
```

MIT licensed.
