# Changelog

## 0.2.0 — 2026-10-08

- Comments: the default (`narration`) notes only comment lines that tell the history of the edit, in English and Russian ("Added X", "I've removed", "as requested", "used to return", "until now", "Добавил", "Исправлено:", "по просьбе"); quoted text and descriptions of what code does are not counted. The note asks to rephrase those lines and leave the rest.
- The comment-count rule is opt-in (`density`) and counts only short one-line captions right above code.
- At most one note per file (per agent) and three per session; `/clear` and a resume start the count over. `/tmp` and scratchpad files are skipped; prose and scratch files are no longer read before a Write.
- `beforeNow`: opt-in for Russian "раньше…" / "теперь…".
- Phrases: Unicode word boundaries; an opener is dropped with any run of punctuation, an ellipsis or an emoji after it, and kept when the sentence needs it ("You're absolutely right that…"). Defaults: "Хороший вопрос", "Отличный вопрос", "You're absolutely right", "You are absolutely right" dropped; "Ты прав", "Вы правы", "load-bearing" only avoided. Text that looks like JSON and blocks the rewrite would empty are left alone.
- `/anti-slop`: this session and an approximate machine-wide count per phrase; totals from 0.1 shown as "before 0.2".

## 0.1.0 — 2026-10-07

- Comment nudges after edits that add many comments or narrate the change; never refuses an edit.
- Phrases: system-prompt section to avoid them; stored replies rewritten (`load-bearing` → `critical`, opening "You're absolutely right" dropped), code left alone.
- `/anti-slop` stats.
