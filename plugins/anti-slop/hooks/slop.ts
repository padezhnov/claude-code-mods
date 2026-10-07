// Pure helpers: no `$`, so the tests can pin them down directly.

/** Files where prose is the content: comments are not counted there. */
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org|tex|json|lock|csv|svg)$/i

type Syntax = { line: RegExp[]; block?: { open: RegExp; close: RegExp } }

const C_LIKE: Syntax = { line: [/^\s*\/\//], block: { open: /^\s*\/\*/, close: /\*\/\s*$/ } }
const HASH: Syntax = { line: [/^\s*#(?![!\[])/] }
const DASHES: Syntax = { line: [/^\s*--(?!-)/] }
const MARKUP: Syntax = { line: [], block: { open: /^\s*<!--/, close: /-->\s*$/ } }

const BY_EXT: Record<string, Syntax> = {}
for (const ext of 'js jsx ts tsx mjs cjs mts cts java c h cc cpp hpp cs go rs swift kt kts scala dart php groovy zig sol css scss less'.split(' ')) BY_EXT[ext] = C_LIKE
for (const ext of 'py rb sh bash zsh fish pl r ex exs yaml yml toml tf hcl nix ps1 cmake makefile dockerfile conf ini'.split(' ')) BY_EXT[ext] = HASH
for (const ext of 'sql lua hs elm ada'.split(' ')) BY_EXT[ext] = DASHES
for (const ext of 'html htm xml vue svelte astro'.split(' ')) BY_EXT[ext] = MARKUP

/** Comments that are instructions to tools, not prose for people. */
const DIRECTIVE =
  /(eslint-|prettier-ignore|@ts-(ignore|expect-error|nocheck)|noqa|type:\s*ignore|pylint:|istanbul|c8 ignore|nolint|SPDX-License|#region|#endregion|biome-ignore|rubocop:|shellcheck|-\*- coding|@flow|@jsx|@vite-ignore|webpackChunkName|NOSONAR|TODO\(|FIXME\()/i

/** Comments that narrate the edit instead of explaining the code. */
const NARRATION =
  /\b(added|adding|removed|changed|updated|renamed|refactored|moved|replaced|now (uses|returns|handles|calls|checks|supports)|previously|used to|was changed|new:|old:|fix(ed)? (for|the)|as requested|per (your|the user'?s?) request|this (change|edit|update))\b/i

export function syntaxOf(path: string): Syntax | null {
  if (PROSE.test(path)) return null
  const base = path.split('/').pop() ?? ''
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : base.toLowerCase()
  return BY_EXT[ext] ?? null
}

export type CommentCount = { comments: number; code: number; narrating: string[] }

/** Counts comment and code lines in a piece of source, by the file's syntax. */
export function countComments(source: string, syntax: Syntax): CommentCount {
  let comments = 0
  let code = 0
  const narrating: string[] = []
  let inBlock = false
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let isComment = false
    if (inBlock) {
      isComment = true
      if (syntax.block?.close.test(line)) inBlock = false
    } else if (syntax.block && syntax.block.open.test(line)) {
      isComment = true
      inBlock = !syntax.block.close.test(line.replace(syntax.block.open, ''))
    } else if (syntax.line.some(re => re.test(line))) {
      isComment = true
    }
    if (!isComment) {
      code += 1
      continue
    }
    if (DIRECTIVE.test(line)) continue
    comments += 1
    if (NARRATION.test(line)) narrating.push(line.length > 80 ? `${line.slice(0, 79)}…` : line)
  }
  return { comments, code, narrating }
}

/** Lines of `after` that are not in `before`: what an edit added, roughly. */
export function addedText(before: string, after: string): string {
  const old = new Map<string, number>()
  for (const l of before.split('\n')) old.set(l.trim(), (old.get(l.trim()) ?? 0) + 1)
  const added: string[] = []
  for (const l of after.split('\n')) {
    const k = l.trim()
    const n = old.get(k) ?? 0
    if (n > 0) old.set(k, n - 1)
    else added.push(l)
  }
  return added.join('\n')
}

export type CommentVerdict = { comments: number; lines: number; narrating: string[] } | null

/** Whether an edit added too many comments, or comments that narrate the change. */
export function judgeComments(path: string, before: string, after: string, minComments: number, ratio: number): CommentVerdict {
  const syntax = syntaxOf(path)
  if (syntax === null) return null
  const count = countComments(addedText(before, after), syntax)
  const lines = count.comments + count.code
  if (count.narrating.length > 0) return { comments: count.comments, lines, narrating: count.narrating }
  if (count.comments >= minComments && lines > 0 && count.comments / lines >= ratio) return { comments: count.comments, lines, narrating: [] }
  return null
}

export function commentNote(path: string, v: NonNullable<CommentVerdict>): string {
  const what =
    v.narrating.length > 0
      ? `comments that narrate the change instead of explaining the code (${v.narrating.slice(0, 2).map(n => `"${n}"`).join(', ')})`
      : `${v.comments} comment lines out of ${v.lines} new lines`
  return (
    `anti-slop: this edit to ${path} added ${what}. ` +
    `Keep a comment only when it says something the code cannot: why it is done this way, a constraint, a workaround. ` +
    `Remove comments that restate the code, narrate the edit ("added", "now uses", "changed to"), or talk to the reader. ` +
    `Fix it in your next edit, without mentioning this note.`
  )
}

// ------------------------------------------------------------------ phrases

export type Replacement = { phrase: string; with: string }

/** "load-bearing=>critical, You're absolutely right=>" → pairs; a bare phrase means "avoid, no rewrite". */
export function parsePhrases(spec: string): { avoid: string[]; replace: Replacement[] } {
  const avoid: string[] = []
  const replace: Replacement[] = []
  for (const item of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const [phrase, to] = item.split('=>').map(s => s.trim())
    if (!phrase) continue
    avoid.push(phrase)
    if (to !== undefined) replace.push({ phrase, with: to })
  }
  return { avoid, replace }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]")

/**
 * Applies the replacements to prose, keeping code spans and fences as they are.
 * A replacement to nothing drops the phrase with its trailing punctuation and
 * capitalizes what follows when it started a sentence.
 */
export function rewritePhrases(text: string, replace: readonly Replacement[]): { text: string; hits: number } {
  if (replace.length === 0) return { text, hits: 0 }
  let hits = 0
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    let s = part
    for (const r of replace) {
      const word = escape(r.phrase)
      if (r.with === '') {
        const re = new RegExp(`(^|[.!?]\\s+|\\n\\s*)${word}[.!,:;]?\\s*(\\w?)`, 'gi')
        s = s.replace(re, (_m, lead: string, next: string) => {
          hits += 1
          return `${lead}${next.toUpperCase()}`
        })
      } else {
        const re = new RegExp(`\\b${word}\\b`, 'gi')
        s = s.replace(re, m => {
          hits += 1
          return m[0] === m[0]?.toUpperCase() && m[0] !== m[0]?.toLowerCase() ? r.with.charAt(0).toUpperCase() + r.with.slice(1) : r.with
        })
      }
    }
    return s
  })
  return { text: out.join(''), hits }
}

export function avoidSection(avoid: readonly string[]): string {
  return (
    `Style: do not use these words or phrases in replies, code, comments or commit messages: ${avoid.map(a => `"${a}"`).join(', ')}. ` +
    `Say the plain thing instead. Do not open a reply by agreeing with or praising the user.`
  )
}
