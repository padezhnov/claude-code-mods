# Changelog

## 0.1.2 — 2026-10-14

- The rewritten note no longer claims that commands the user runs with `!` are unaffected: that was never verified, and Claude was passing it on as advice.

## 0.1.1 — 2026-10-13

- The rewritten auto-mode note names the plugin as the one refusing shell writes, says it applies in every permission mode, and that commands the user runs with `!` are not affected — so Claude no longer blames Claude Code or suggests leaving auto mode.

## 0.1.0 — 2026-10-07

- The auto-mode note: the sentence telling Claude to make file changes with sed, heredocs or short scripts is rewritten (Claude Code 2.1.289–2.1.292 wording, strict and relaxed variants); reading and searching through Bash stay; another wording is left as is. Where Claude Code drops the "Edit files: Use Edit" lines from the Bash tool's description, an equivalent line is put back.
- The guard: a Bash command that writes a project file is refused with the file names and a pointer to Edit and Write (`deny`), or run and noted (`warn`; nothing is noted when the command failed). Covers `sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, `yq -i`, heredocs, `echo`/`printf` redirections, `tee`, temp-file-and-move (when the moved file is text Claude wrote or a filter of the target), writes inside shell functions, and Python/Node/Deno snippets that rewrite a file or write literal text, with shell variables in them filled in as the shell would.
- When Claude has no Edit or Write tool, the write runs; a subagent, whose tools the mod cannot see, is refused once per file and the same command then runs.
- Never refused: reading, `/tmp` and `$TMPDIR`, devices, other machines, program output, content or paths only known at run time (`xargs -I{}`, unset variables), `allowPaths`, and (with `scope: project`) files outside the project. An invalid `allowPaths` glob is ignored and named by `/native-edits`.
- `/native-edits`: counts and the state of the auto-mode note and the Bash tool's description.
