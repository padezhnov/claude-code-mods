// Pure helpers: no `$`, so the tests can pin them down directly.

/** Files where prose is the content: comments are not counted there. */
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org|tex|json|lock|csv|svg)$/i

/** Scratch files: nobody reads their comments later. */
const SCRATCH = /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)\/|\/scratchpad\//

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

// ---------------------------------------------------------------- narration
// A comment narrates the edit when it talks about the change itself ("Added
// retry logic", "as requested", "used to return null") rather than the code.
// Words like "updated" or "removed" also describe what code does ("removed
// items are re-fetched", "customer.subscription.updated"), so a verb only
// counts at the very start of the comment, followed by what was changed.

const MARK = String.raw`(?:\/\/+|#+|--+|\/?\*+|<!--)`
const START = String.raw`^(?:${MARK})?[ \t]*`
const NOT_LETTER = String.raw`(?![\p{L}\p{N}_])`

const DETERMINER = String.raw`(?:the|a|an|its|their|his|her|our|your|each|every|any|all|this|that|these|those)\b`

const EN_VERB = new RegExp(
  `${START}(?:(?:i|we)(?:[ \\t]+(?:have[ \\t]+|just[ \\t]+)?|['’]ve[ \\t]+))?` +
    String.raw`(?:added|removed|changed|updated|renamed|refactored|moved|replaced|fixed|switched)[ \t]+` +
    // "Fixed — …", "Moved = …": a label, not a sentence.
    String.raw`(?![—–=:-])` +
    // "Updated by cron", "Removed on logout", "Switched off in prod", "Fixed window": what the code does.
    String.raw`(?!(?:by|in|on|at|after|before|when|whenever|if|via|during|until|once|here|there|off|only|permanently|window|point|size)\b)` +
    // "Added to the queue", "Removed from the DOM", "Replaced with a stub" — but "Changed from map to forEach" is the edit.
    String.raw`(?!(?:to|from|with|into)[ \t]+${DETERMINER})` +
    // "Removed items stay…", "changed files are re-linted": a participle.
    String.raw`(?![\w-]+[ \t]+(?:are|is|stay|stays|remain|remains|get|gets|go|goes|will|can|must|should|have|has|were|was)\b)` +
    String.raw`\S`,
  'i',
)
const EN_LABEL = new RegExp(String.raw`${START}(?:new|old|changed|fixed|updated|added|removed):`, 'i')
const EN_ANYWHERE = /\b(?:now (?:uses|returns|handles|calls|checks|supports)|until now|as requested(?![ \t]+by\b)|as you asked|per (?:your|the user'?s?) request)\b/i
/** "Previously, …" / "Previously this returned …", at the start of a sentence; not "Previously computed totals". */
const EN_PREVIOUSLY = new RegExp(
  String.raw`(?:${START}|[.;:(—][ \t]*)previously(?:[ \t]*,|[ \t]+(?:this|it|we|i|they|there|that|the|a|an)\b)`,
  'i',
)
/** "This change makes …" at the start of the comment; not "this change handler fires twice". */
const EN_THIS_CHANGE = new RegExp(
  String.raw`${START}this[ \t]+(?:change|edit|update)(?:[ \t]*[,:;.—-]|[ \t]+(?:makes|adds|removes|fixes|changes|moves|replaces|switches|keeps|ensures|means)\b)`,
  'i',
)
/** "It used to land …", "Used to return null": at the start, or after a pronoun; not "Token used to call the API". */
const EN_USED_TO = new RegExp(String.raw`(?:${START}|\b(?:it|this|that|which|we|they|there)[ \t]+)used to (?:be|return|call|land|send|run|go)\b`, 'i')

const NOT_WOULD = String.raw`(?![ \t]+бы${NOT_LETTER})`
const RU_VERB = new RegExp(`${START}(?:добавил|исправил|заменил|убрал|переименовал)${NOT_LETTER}${NOT_WOULD}`, 'iu')
/** "# Добавлена проверка", "Исправлено: таймаут"; not "Добавлено в v2 API" (when it appeared, not this edit). */
const RU_PASSIVE = new RegExp(
  `${START}(?:добавлен[аоы]?|исправлен[аоы]?)${NOT_LETTER}${NOT_WOULD}(?![ \\t]+(?:в|во|на|при|для|после|до|начиная|с|со)${NOT_LETTER})`,
  'iu',
)
const RU_ASKED = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:по просьбе|как (?:ты|вы) просил[аи]?)${NOT_LETTER}`, 'iu')

/** Quoted text is someone else's words ("as requested" in a list of examples), not the comment's. */
function unquoted(line: string): string {
  // An odd number of '"': the line goes on a quote opened on the line before.
  const s = (line.match(/"/g)?.length ?? 0) % 2 === 1 ? line.replace(/^[^"]*"/, '""') : line
  return s.replace(/"[^"\n]*"|«[^»\n]*»|“[^”\n]*”|`[^`\n]*`|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, '""')
}
/** Opt-in: "раньше …" / "теперь …" also describe the code's history on purpose. */
const RU_BEFORE_NOW = new RegExp(
  String.raw`(?:${START}|[.;:!?(—][ \t]*)(?:раньше|прежде|до этого)${NOT_LETTER}(?!,?[ \t]+чем)` + String.raw`|(?<![\p{L}\p{N}_])теперь${NOT_LETTER}`,
  'iu',
)

/** Whether one comment line narrates the edit instead of explaining the code. */
export function narrates(line: string, beforeNow = false): boolean {
  const s = line.trim()
  const own = unquoted(s)
  if (EN_VERB.test(s) || EN_LABEL.test(s) || EN_THIS_CHANGE.test(s)) return true
  if (EN_ANYWHERE.test(own) || EN_PREVIOUSLY.test(own) || EN_USED_TO.test(own)) return true
  if (RU_VERB.test(s) || RU_PASSIVE.test(s) || RU_ASKED.test(own)) return true
  return beforeNow && RU_BEFORE_NOW.test(own)
}

// ------------------------------------------------------------------ counting

export function syntaxOf(path: string): Syntax | null {
  if (PROSE.test(path)) return null
  const base = path.split('/').pop() ?? ''
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : base.toLowerCase()
  return BY_EXT[ext] ?? null
}

/** Whether a file is scratch (/tmp, a session scratchpad): never judged. */
export function isScratch(path: string): boolean {
  return SCRATCH.test(path)
}

type Kind = 'code' | 'comment' | 'directive'

function classify(source: string, syntax: Syntax): { text: string; kind: Kind; opensBlock: boolean; inBlock: boolean }[] {
  const out: { text: string; kind: Kind; opensBlock: boolean; inBlock: boolean }[] = []
  let inBlock = false
  for (const raw of source.split('\n')) {
    const text = raw.trim()
    if (text === '') continue
    let comment = false
    let opensBlock = false
    const wasInBlock = inBlock
    if (inBlock) {
      comment = true
      if (syntax.block?.close.test(text)) inBlock = false
    } else if (syntax.block && syntax.block.open.test(text)) {
      comment = true
      opensBlock = true
      inBlock = !syntax.block.close.test(text.replace(syntax.block.open, ''))
    } else if (syntax.line.some(re => re.test(text))) {
      comment = true
    }
    out.push({ text, kind: !comment ? 'code' : DIRECTIVE.test(text) ? 'directive' : 'comment', opensBlock, inBlock: wasInBlock || inBlock })
  }
  return out
}

export type CommentCount = {
  /** Comment lines, tool directives left out. */
  comments: number
  code: number
  /** One-line comments of at most 64 characters right above a line of code: "// Get the user". */
  captions: number
  narrating: string[]
}

const CAPTION_MAX = 64

/** Counts comment, caption and code lines in a piece of source, by the file's syntax. */
export function countComments(source: string, syntax: Syntax, beforeNow = false): CommentCount {
  const lines = classify(source, syntax)
  let comments = 0
  let code = 0
  let captions = 0
  const narrating: string[] = []
  lines.forEach((l, i) => {
    if (l.kind === 'code') {
      code += 1
      return
    }
    if (l.kind === 'directive') return
    comments += 1
    if (narrates(l.text, beforeNow)) narrating.push(l.text.length > 80 ? `${l.text.slice(0, 79)}…` : l.text)
    const prev = lines[i - 1]
    const next = lines[i + 1]
    const single = (prev === undefined || prev.kind === 'code') && next?.kind === 'code'
    const oneLiner = !l.opensBlock || !l.inBlock
    if (single && oneLiner && l.text.length <= CAPTION_MAX && !l.text.startsWith('/**')) captions += 1
  })
  return { comments, code, captions, narrating }
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

export type CommentRules = {
  /** Also nudge an edit that captions its code line by line. */
  density: boolean
  /** Captions before the density rule applies. */
  minComments: number
  /** …and captions per line of code. */
  ratio: number
  /** Count "раньше …" / "теперь …" as narration. */
  beforeNow: boolean
}

export const DEFAULT_RULES: CommentRules = { density: false, minComments: 3, ratio: 0.3, beforeNow: false }

export type CommentVerdict = { kind: 'narration'; narrating: string[] } | { kind: 'density'; captions: number; code: number } | null

/** Whether an edit added comments that narrate the change, or (opt-in) caption every few lines. */
export function judgeComments(path: string, before: string, after: string, rules: CommentRules = DEFAULT_RULES): CommentVerdict {
  if (isScratch(path)) return null
  const syntax = syntaxOf(path)
  if (syntax === null) return null
  const count = countComments(addedText(before, after), syntax, rules.beforeNow)
  if (count.narrating.length > 0) return { kind: 'narration', narrating: count.narrating }
  if (rules.density && count.captions >= rules.minComments && count.code > 0 && count.captions / count.code >= rules.ratio) {
    return { kind: 'density', captions: count.captions, code: count.code }
  }
  return null
}

export function commentNote(path: string, v: NonNullable<CommentVerdict>): string {
  if (v.kind === 'narration') {
    return (
      `anti-slop: this edit to ${path} added comment lines that tell the history of the edit (${v.narrating.slice(0, 2).map(n => `"${n}"`).join(', ')}). ` +
      `In your next edit, rephrase those lines to describe the code as it is now: keep the why, drop the history of the change. ` +
      `Leave the other comments as they are, and do not mention this note.`
    )
  }
  return (
    `anti-slop: this edit to ${path} added ${v.captions} one-line comments captioning ${v.code} lines of code. ` +
    `Keep a comment only when it says something the code cannot: why it is done this way, a constraint, a workaround. ` +
    `Remove comments that restate the code, narrate the edit ("added", "now uses", "changed to"), or talk to the reader. ` +
    `Fix it in your next edit, without mentioning this note.`
  )
}

// ------------------------------------------------------------------ phrases

export type Replacement = { phrase: string; with: string }

/** "Хороший вопрос=>, load-bearing=>critical, delve" → pairs; a bare phrase means "avoid, no rewrite". */
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

/** A word character for the phrase boundaries, in any script; "-" too, so "load-bearing-wall" is not "load-bearing". */
const W = String.raw`[\p{L}\p{N}_-]`

/** Text that looks like machine-readable data (a JSON answer from an agent): never rewritten. */
export function looksLikeData(text: string): boolean {
  return /^\s*[[{]/.test(text)
}

export type Rewrite = { text: string; hits: number; by: Record<string, number> }

/**
 * Applies the replacements to prose, keeping code spans and fences as they are.
 * A replacement to nothing drops the phrase where it opens a sentence, with
 * its trailing punctuation or dash, and capitalizes what follows.
 */
export function rewritePhrases(text: string, replace: readonly Replacement[]): Rewrite {
  const by: Record<string, number> = {}
  let hits = 0
  if (replace.length === 0) return { text, hits, by }
  const hit = (phrase: string) => {
    hits += 1
    by[phrase] = (by[phrase] ?? 0) + 1
  }
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    let s = part
    for (const r of replace) {
      const word = escape(r.phrase)
      if (r.with === '') {
        const re = new RegExp(
          String.raw`(^|[.!?]\s+|\n[ \t]*)${word}(?!${W})` +
            // "You're absolutely right that the cache is stale": the phrase carries the sentence, leave it.
            String.raw`(?![ \t]+(?:that|about|to|который)(?!${W}))` +
            String.raw`(?:[ \t]*[.!?,:;…]+|[ \t]+[—–])?(?:[ \t]*\p{Extended_Pictographic}[\p{Extended_Pictographic}\u{FE0F}\u{200D}]*)?\s*(\p{L}?)`,
          'giu',
        )
        s = s.replace(re, (_m, lead: string, next: string) => {
          hit(r.phrase)
          return `${lead}${next.toUpperCase()}`
        })
      } else {
        const re = new RegExp(String.raw`(?<!${W})${word}(?!${W})`, 'giu')
        s = s.replace(re, m => {
          hit(r.phrase)
          return m[0] === m[0]?.toUpperCase() && m[0] !== m[0]?.toLowerCase() ? r.with.charAt(0).toUpperCase() + r.with.slice(1) : r.with
        })
      }
    }
    return s
  })
  return { text: out.join(''), hits, by }
}

/**
 * Rewrites the text blocks of one stored reply. Tool calls, thinking and text
 * that looks like JSON stay as they are, and a block the rewrite would empty
 * keeps its text: the API refuses an empty text block.
 */
export function rewriteBlocks<B>(content: readonly B[], replace: readonly Replacement[]): { content: B[]; hits: number; by: Record<string, number> } {
  const by: Record<string, number> = {}
  let hits = 0
  const out = content.map(block => {
    if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') return block
    const text = (block as { text?: unknown }).text
    if (typeof text !== 'string' || looksLikeData(text)) return block
    const r = rewritePhrases(text, replace)
    if (r.hits === 0 || r.text.trim() === '') return block
    hits += r.hits
    for (const [p, n] of Object.entries(r.by)) by[p] = (by[p] ?? 0) + n
    return { ...block, text: r.text }
  })
  return { content: out, hits, by }
}

export function avoidSection(avoid: readonly string[]): string {
  return (
    `Style: do not use these words or phrases in replies, code, comments or commit messages: ${avoid.map(a => `"${a}"`).join(', ')}. ` +
    `Say the plain thing instead. Do not open a reply by agreeing with or praising the user.`
  )
}
