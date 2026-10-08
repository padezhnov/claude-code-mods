// Finds the local files a shell command writes. Pure: no `$`, no I/O, never throws on odd input.

// ---------------------------------------------------------------- syntax

/** A piece of a word: literal text, a variable (`$NAME`, `${NAME:-def}`), a leading `~`, or a value only known at run time. */
type Part = { lit: string } | { v: string; def?: string } | { tilde: string } | { dyn: string }

export type Word = {
  /** The value with quotes removed; variables kept as `$NAME`. */
  text: string
  parts: Part[]
  /** Holds a command, arithmetic or other substitution whose value cannot be known. */
  dynamic: boolean
  quoted: boolean
  /** Command and process substitutions inside the word, parsed. */
  subs: List[]
}

export type Redirect = {
  fd: number | null
  op: string
  target: Word | null
  /** A here-document's body, or a here-string's word. */
  body?: string
  verbatim?: boolean
  /** A here-string's word, for what the program reads once the shell filled it in. */
  word?: Word
}

export type Command =
  | { kind: 'simple'; words: Word[]; redirects: Redirect[] }
  | { kind: 'group'; body: List; subshell: boolean; redirects: Redirect[] }

export type Pipeline = Command[]
export type AndOr = Pipeline[]
export type List = AndOr[]

const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const REDIRECT = /^(\d{0,2})(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/
const MAX_DEPTH = 6
/** Nested groups and subshells deeper than this are not read (a stack, not a real command). */
const MAX_NEST = 64
/** `name()` or `function name`: a function definition, whose body is read as a group. */
const FUNCTION_HEAD = /^(?:function[ \t]+[^\s(){};&|<>'"`$]+(?:[ \t]*\([ \t]*\))?|[A-Za-z_][\w.:-]*[ \t]*\([ \t]*\))[ \t]*/

/** Where a nested list ends: a subshell's `)`, a group's `}`, or the end of input. */
type Stop = ')' | '}' | null

class Parser {
  i = 0
  private nest = 0
  private pending: { redirect: Redirect; delim: string; strip: boolean }[] = []

  constructor(
    private readonly s: string,
    private readonly depth = 0,
  ) {}

  parse(): List {
    const list = this.list(null)
    this.readHeredocs()
    return list
  }

  private get eof() {
    return this.i >= this.s.length
  }

  private at(k = 0): string {
    return this.s[this.i + k] ?? ''
  }

  private blanks() {
    for (;;) {
      const c = this.at()
      if (c === ' ' || c === '\t' || c === '\r') this.i++
      else if (c === '\\' && this.at(1) === '\n') this.i += 2
      else return
    }
  }

  private newline() {
    this.i++
    this.readHeredocs()
  }

  private blanksAndNewlines() {
    for (;;) {
      this.blanks()
      if (this.at() === '\n') this.newline()
      else if (this.at() === '#') this.comment()
      else return
    }
  }

  private comment() {
    while (!this.eof && this.at() !== '\n') this.i++
  }

  private reserved(word: string): boolean {
    if (!this.s.startsWith(word, this.i)) return false
    const after = this.s[this.i + word.length]
    return after === undefined || META.has(after)
  }

  private readHeredocs() {
    const pending = this.pending
    this.pending = []
    for (const p of pending) {
      const lines: string[] = []
      while (!this.eof) {
        let end = this.s.indexOf('\n', this.i)
        if (end < 0) end = this.s.length
        const line = this.s.slice(this.i, end).replace(/\r$/, '')
        this.i = Math.min(end + 1, this.s.length)
        if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break
        lines.push(p.strip ? line.replace(/^\t+/, '') : line)
      }
      p.redirect.body = lines.join('\n')
    }
  }

  private list(stop: Stop): List {
    const list: List = []
    for (;;) {
      this.separators(stop)
      if (this.eof) break
      if (stop === ')' && this.at() === ')') break
      if (stop === '}' && this.reserved('}')) break
      const before = this.i
      const ao = this.andOr(stop)
      if (ao.length > 0) list.push(ao)
      if (this.i === before) this.i++
    }
    return list
  }

  private separators(stop: Stop) {
    for (;;) {
      this.blanks()
      const c = this.at()
      if (c === '\n') this.newline()
      else if (c === '#') this.comment()
      else if (c === ';') this.i++
      else if (c === '&' && this.at(1) !== '>') this.i++
      else if (c === '|') this.i++
      else if (c === ')' && stop !== ')') this.i++
      else return
    }
  }

  private andOr(stop: Stop): AndOr {
    const ao: AndOr = []
    for (;;) {
      const p = this.pipeline(stop)
      if (p.length > 0) ao.push(p)
      this.blanks()
      if (this.s.startsWith('&&', this.i) || this.s.startsWith('||', this.i)) {
        this.i += 2
        this.blanksAndNewlines()
        continue
      }
      return ao
    }
  }

  private pipeline(stop: Stop): Pipeline {
    const p: Pipeline = []
    for (;;) {
      this.blanks()
      if (this.at() === '!' && (this.at(1) === ' ' || this.at(1) === '\t')) this.i++
      const cmd = this.command(stop)
      if (cmd !== null) p.push(cmd)
      this.blanks()
      if (this.at() === '|' && this.at(1) !== '|') {
        this.i += this.at(1) === '&' ? 2 : 1
        this.blanksAndNewlines()
        continue
      }
      return p
    }
  }

  private command(stop: Stop): Command | null {
    this.blanks()
    if (this.at() === '(' && this.at(1) === '(') {
      this.skipBalanced('(', ')')
      return { kind: 'simple', words: [], redirects: this.trailingRedirects() }
    }
    const opens = this.at() === '(' || this.reserved('{')
    if (opens && this.nest >= MAX_NEST) {
      this.i = this.s.length
      return null
    }
    if (this.at() === '(') {
      this.i++
      this.nest++
      const body = this.depth < MAX_DEPTH ? this.list(')') : this.skipTo(')')
      this.nest--
      if (this.at() === ')') this.i++
      return { kind: 'group', body, subshell: true, redirects: this.trailingRedirects() }
    }
    if (this.reserved('{')) {
      this.i++
      this.nest++
      const body = this.list('}')
      this.nest--
      if (this.reserved('}')) this.i++
      return { kind: 'group', body, subshell: false, redirects: this.trailingRedirects() }
    }
    // `g() { echo x > f; }`: the body is read as if the function ran.
    const fn = FUNCTION_HEAD.exec(this.s.slice(this.i, this.i + 256))
    if (fn !== null) {
      const at = this.i
      this.i += fn[0].length
      this.blanksAndNewlines()
      if (this.at() === '(' || this.reserved('{')) return this.command(stop)
      this.i = at
    }
    return this.simple(stop)
  }

  private skipTo(close: string): List {
    while (!this.eof && this.at() !== close) this.i++
    return []
  }

  private skipBalanced(open: string, close: string) {
    let depth = 0
    while (!this.eof) {
      const c = this.at()
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth <= 0) {
          this.i++
          return
        }
      } else if (c === "'" || c === '"') {
        const end = this.s.indexOf(c, this.i + 1)
        this.i = end < 0 ? this.s.length : end
      }
      this.i++
    }
  }

  private trailingRedirects(): Redirect[] {
    const out: Redirect[] = []
    for (;;) {
      this.blanks()
      const r = this.redirect()
      if (r === null) return out
      out.push(r)
    }
  }

  private simple(stop: Stop): Command | null {
    const words: Word[] = []
    const redirects: Redirect[] = []
    let inTest = false
    for (;;) {
      this.blanks()
      if (this.eof) break
      const c = this.at()
      if (c === '\n' || c === ';' || c === '|' || c === ')') break
      if (c === '&' && this.at(1) !== '>') break
      if (c === '#') {
        this.comment()
        break
      }
      if (stop === '}' && words.length === 0 && this.reserved('}')) break
      if (inTest && (c === '<' || c === '>')) {
        this.i++
        words.push(literal(c))
        continue
      }
      const r = this.redirect()
      if (r !== null) {
        redirects.push(r)
        continue
      }
      if (c === '(') {
        // `f() {`, `a=(1 2)`: nothing a write hides in.
        if (this.at(1) === ')') this.i += 2
        else this.skipBalanced('(', ')')
        continue
      }
      const before = this.i
      const w = this.word()
      if (this.i === before) {
        this.i++
        continue
      }
      words.push(w)
      if (words.length === 1 && w.text === '[[' && !w.quoted) inTest = true
      else if (inTest && w.text === ']]') inTest = false
    }
    if (words.length === 0 && redirects.length === 0) return null
    return { kind: 'simple', words, redirects }
  }

  private redirect(): Redirect | null {
    const m = REDIRECT.exec(this.s.slice(this.i, this.i + 6))
    if (m === null) return null
    const op = m[2] as string
    if ((op === '<' || op === '>') && this.at(m[0].length) === '(') return null
    this.i += m[0].length
    const fd = m[1] === '' ? null : Number(m[1])
    this.blanks()
    if (op === '<<' || op === '<<-') {
      const delim = this.word()
      const redirect: Redirect = { fd, op, target: null, body: '', verbatim: delim.quoted }
      if (delim.text !== '' || delim.quoted) this.pending.push({ redirect, delim: delim.text, strip: op === '<<-' })
      return redirect
    }
    const target = this.word()
    if (op === '<<<') return { fd, op, target: null, body: target.text, verbatim: !target.dynamic && target.parts.every(p => 'lit' in p), word: target }
    if (target.text === '' && !target.quoted && target.subs.length === 0) return { fd, op, target: null }
    if ((op === '>&' || op === '<&') && /^(\d+-?|-)$/.test(target.text)) return { fd, op, target }
    return { fd, op: op === '>&' ? '&>' : op, target }
  }

  private word(): Word {
    const w: Word = { text: '', parts: [], dynamic: false, quoted: false, subs: [] }
    const c0 = this.at()
    if ((c0 === '<' || c0 === '>') && this.at(1) === '(') {
      this.i += 2
      w.subs.push(this.sub(')'))
      if (this.at() === ')') this.i++
      w.dynamic = true
      w.parts.push({ dyn: `${c0}(…)` })
      return w
    }
    if (c0 === '~') {
      const m = /^~([A-Za-z0-9_.-]*)/.exec(this.s.slice(this.i, this.i + 64))
      const user = m?.[1] ?? ''
      w.parts.push({ tilde: user })
      w.text += `~${user}`
      this.i += 1 + user.length
    }
    while (!this.eof) {
      const c = this.at()
      if (META.has(c)) break
      if (c === '\\') {
        if (this.at(1) !== '\n') {
          add(w, this.at(1))
          w.quoted = true
        }
        this.i += 2
      } else if (c === "'") {
        let end = this.s.indexOf("'", this.i + 1)
        if (end < 0) end = this.s.length
        add(w, this.s.slice(this.i + 1, end))
        w.quoted = true
        this.i = end + 1
      } else if (c === '"') {
        this.i++
        this.double(w)
        w.quoted = true
      } else if (c === '$') {
        this.dollar(w, false)
      } else if (c === '`') {
        this.backtick(w)
      } else {
        add(w, c)
        this.i++
      }
    }
    return w
  }

  private double(w: Word) {
    while (!this.eof) {
      const c = this.at()
      if (c === '"') {
        this.i++
        return
      }
      if (c === '\\') {
        const n = this.at(1)
        if (n === '\n') {
          this.i += 2
          continue
        }
        add(w, '$`"\\'.includes(n) && n !== '' ? n : `\\${n}`)
        this.i += 2
      } else if (c === '$') {
        this.dollar(w, true)
      } else if (c === '`') {
        this.backtick(w)
      } else {
        add(w, c)
        this.i++
      }
    }
  }

  private dollar(w: Word, inDouble: boolean) {
    const n = this.at(1)
    if (n === '(' && this.at(2) === '(') {
      this.i++
      this.skipBalanced('(', ')')
      dynamic(w, '$((…))')
      return
    }
    if (n === '(') {
      this.i += 2
      w.subs.push(this.sub(')'))
      if (this.at() === ')') this.i++
      dynamic(w, '$(…)')
      return
    }
    if (n === '{') {
      const start = this.i + 2
      let depth = 1
      let j = start
      while (j < this.s.length && depth > 0) {
        const ch = this.s[j]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        j++
      }
      const inner = this.s.slice(start, j - 1)
      this.i = j
      const m = /^([A-Za-z_]\w*)(?::?-(.*))?$/.exec(inner)
      if (m !== null) {
        w.parts.push(m[2] === undefined ? { v: m[1] as string } : { v: m[1] as string, def: m[2] })
        w.text += `\${${inner}}`
      } else dynamic(w, `\${${inner}}`)
      return
    }
    if (n === "'" && !inDouble) {
      let j = this.i + 2
      let out = ''
      while (j < this.s.length && this.s[j] !== "'") {
        if (this.s[j] === '\\' && j + 1 < this.s.length) {
          const e = this.s[j + 1] as string
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e
          j += 2
        } else out += this.s[j++]
      }
      add(w, out)
      w.quoted = true
      this.i = j + 1
      return
    }
    if (n === '"' && !inDouble) {
      this.i += 2
      this.double(w)
      w.quoted = true
      return
    }
    const m = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(this.s.slice(this.i + 1, this.i + 65))
    if (m !== null) {
      w.parts.push({ v: m[0] })
      w.text += `$${m[0]}`
      this.i += 1 + m[0].length
      return
    }
    add(w, '$')
    this.i++
  }

  private backtick(w: Word) {
    let j = this.i + 1
    let inner = ''
    while (j < this.s.length && this.s[j] !== '`') {
      if (this.s[j] === '\\' && j + 1 < this.s.length) {
        const e = this.s[j + 1] as string
        inner += '`$\\'.includes(e) ? e : `\\${e}`
        j += 2
      } else inner += this.s[j++]
    }
    this.i = j + 1
    if (this.depth < MAX_DEPTH) w.subs.push(new Parser(inner, this.depth + 1).parse())
    dynamic(w, '`…`')
  }

  private sub(close: ')'): List {
    if (this.depth >= MAX_DEPTH) {
      this.skipBalanced('(', ')')
      this.i--
      return []
    }
    const inner = new Parser(this.s, this.depth + 1)
    inner.i = this.i
    const list = inner.list(close)
    this.i = inner.i
    return list
  }
}

function add(w: Word, text: string) {
  const last = w.parts[w.parts.length - 1]
  if (last !== undefined && 'lit' in last) last.lit += text
  else w.parts.push({ lit: text })
  w.text += text
}

function dynamic(w: Word, text: string) {
  w.parts.push({ dyn: text })
  w.dynamic = true
  w.text += text
}

function literal(text: string): Word {
  return { text, parts: [{ lit: text }], dynamic: false, quoted: false, subs: [] }
}

/** Parses a shell command line into lists, pipelines and simple commands. */
export function parseShell(source: string): List {
  try {
    return new Parser(source).parse()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- paths

/** Joins and normalizes a POSIX path against a base directory. */
export function resolvePath(path: string, base: string): string {
  const joined = path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}


// ---------------------------------------------------------------- writes

export type WriteVia = 'sed -i' | 'perl -i' | 'ruby -i' | 'awk -i inplace' | 'yq -i' | 'redirect' | 'tee' | 'sponge' | 'script' | 'mv' | 'cp'

export type Write = {
  /** The target as the command names it. */
  target: string
  /** Absolute path (a glob when the command names a pattern), or null when a variable or substitution decides it. */
  path: string | null
  via: WriteVia
  /** The command that wrote it: `echo`, `cat`, `python3`... */
  by: string
  /** For `cp`: the file copied, which this command wrote first. */
  from?: string
}

export type ShellContext = { cwd: string; home?: string }

type Found = Omit<Write, 'by' | 'from'> & {
  authored: boolean
  producer: string
  from?: string
  /** The files the producing command read (its operands): a filter that read the file it is moved over edits it. */
  reads?: string[]
}

type State = {
  cwd: string | null
  vars: Map<string, string>
  home: string | undefined
  found: Found[]
  /** Files this command wrote from a literal here-document, by path: a script it may run next. */
  scripts: Map<string, string>
  depth: number
  /** Stand-ins another program replaces at run time (`{}` of find and xargs, `xargs -I X`): a path holding one is unknown. */
  placeholders: string[]
}

/** Stands in code for a value the shell fills in that cannot be known here; a path holding it is unknown. */
const UNKNOWN = '\u0000'

/** Prints content the model wrote itself (not another program's output). */
const AUTHORS = new Set(['echo', 'printf', ':', 'true'])
/** Pass their input through, transformed: authored in, authored out. */
const FILTERS = new Set([
  'cat', 'tr', 'sed', 'awk', 'gawk', 'mawk', 'jq', 'yq', 'sort', 'uniq', 'head', 'tail', 'base64', 'envsubst', 'column',
  'cut', 'fold', 'fmt', 'iconv', 'rev', 'nl', 'expand', 'unexpand', 'xxd', 'tee', 'dos2unix', 'unix2dos', 'perl', 'grep',
])
/** Rewrite another file's content: their output moved over a file is an edit of it. */
const TRANSFORMERS = new Set([
  'sed', 'awk', 'gawk', 'mawk', 'perl', 'jq', 'yq', 'grep', 'sort', 'uniq', 'tr', 'cut', 'head', 'tail', 'cat',
  'column', 'iconv', 'dos2unix', 'unix2dos', 'expand', 'unexpand',
])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])
const PYTHON = /^(python[0-9.]*|pypy3?)$/
const JS = /^(node|nodejs|bun|tsx|ts-node)$/

/** Every local file the command writes with content the model authored or rewrote. */
export function findWrites(command: string, ctx: ShellContext): Write[] {
  const st: State = { cwd: ctx.cwd, vars: new Map(), home: ctx.home, found: [], scripts: new Map(), depth: 0, placeholders: ['{}'] }
  walkList(parseShell(command), st)
  const seen = new Set<string>()
  const out: Write[] = []
  for (const f of st.found) {
    if (!f.authored) continue
    const key = f.path ?? `?${f.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ target: f.target, path: f.path, via: f.via, by: f.producer, ...(f.from === undefined ? {} : { from: f.from }) })
  }
  return out
}

function fork(st: State): State {
  return { ...st, vars: new Map(st.vars) }
}

function walkList(list: List, st: State) {
  for (const ao of list) for (const p of ao) walkPipeline(p, st)
}

/** What a command passes down a pipe: whether it prints text the model wrote, and the files it read. */
type Piped = { authored: boolean; reads: string[]; listed: Listed | null }

function walkPipeline(p: Pipeline, st: State) {
  let up: Piped = { authored: false, reads: [], listed: null }
  for (const cmd of p) {
    if (cmd.kind === 'group') {
      const inner = cmd.subshell ? fork(st) : st
      walkList(cmd.body, inner)
      const authored = groupAuthors(cmd.body, inner)
      const redirected = redirectOutputs(cmd.redirects, authored, 'group', st)
      up = { authored: authored && !redirected, reads: [], listed: null }
      continue
    }
    const listed = listedBy(cmd, st)
    up = { ...walkSimple(cmd, st, up, p.length > 1), listed }
  }
}

/** The file names a command prints, for `| xargs sed -i`: each a path or a `dir/**` pattern. */
type Listed = { paths: string[]; target: string }

function listedBy(cmd: Extract<Command, { kind: 'simple' }>, st: State): Listed | null {
  const argv = unwrap(cmd.words).argv
  const name = nameOf(argv[0])
  if (name === null || st.cwd === null) return null
  const cwd = st.cwd
  const under = (dir: string) => `${dir === '/' ? '' : dir}/**`
  const resolve = (words: Word[]) => {
    const values = words.map(w => expand(w, st))
    return values.some(v => v === null) ? null : (values as string[]).map(v => resolvePath(v, cwd))
  }
  if (name === 'find' || name === 'fd' || name === 'fdfind') {
    const roots: Word[] = []
    if (name === 'find') for (const w of argv.slice(1)) if (w.text.startsWith('-') || w.text === '(' || w.text === '!') break; else roots.push(w)
    else roots.push(...operands(argv).slice(1))
    const dirs = roots.length === 0 ? [cwd] : resolve(roots)
    return dirs === null ? null : { paths: dirs.map(under), target: `files ${name} lists under ${roots.map(w => w.text).join(', ') || '.'}` }
  }
  if (name === 'grep' || name === 'egrep' || name === 'rg' || name === 'ag') {
    const flags = argv.slice(1).filter(w => w.text.startsWith('-')).map(w => w.text)
    const lists = name === 'rg' && flags.includes('--files')
    if (!lists && !flags.some(f => /^-[a-zA-Z]*[lL]|^--files-with(out)?-match/.test(f))) return null
    const pattern = flags.some(f => /^-[a-zA-Z]*[ef]$|^--regexp|^--file/.test(f)) || lists ? 0 : 1
    const where = operands(argv).filter(w => !(w.text.startsWith('-') && w.text !== '-')).slice(pattern)
    const recursive = name !== 'grep' && name !== 'egrep' ? true : flags.some(f => /^-[a-zA-Z]*[rR]|^--recursive|^--dereference-recursive/.test(f))
    if (where.length === 0) return recursive ? { paths: [under(cwd)], target: `files ${name} finds` } : null
    const paths = resolve(where)
    return paths === null ? null : { paths: recursive ? paths.map(under) : paths, target: `files ${name} finds in ${where.map(w => w.text).join(', ')}` }
  }
  if (name === 'ls' || name === 'echo') {
    const words = operands(argv)
    if (words.length === 0) return name === 'ls' ? { paths: [`${cwd === '/' ? '' : cwd}/*`], target: 'files ls lists' } : null
    const paths = resolve(words)
    return paths === null ? null : { paths, target: words.map(w => w.text).join(' ') }
  }
  if (name === 'git' && /^(ls-files|grep|diff)$/.test(argv[1]?.text ?? '')) {
    const sub = argv[1]?.text
    if (sub === 'grep' && !argv.some(w => /^-[a-zA-Z]*l|^--name-only|^--files-with-matches/.test(w.text))) return null
    if (sub === 'diff' && !argv.some(w => w.text === '--name-only')) return null
    return { paths: [under(cwd)], target: `files git ${sub} lists` }
  }
  return null
}

/** A `{ ...; } > f` group prints only what the model wrote when every command in it does. */
function groupAuthors(list: List, st: State): boolean {
  let any = false
  for (const ao of list)
    for (const p of ao)
      for (const cmd of p) {
        if (cmd.kind === 'group') {
          if (!groupAuthors(cmd.body, st)) return false
          any = true
          continue
        }
        const argv = unwrap(cmd.words).argv
        const name = nameOf(argv[0])
        if (name === null) continue
        const input = stdinOf(cmd.redirects, st)
        const prints = AUTHORS.has(name) ? literalWords(argv.slice(1), st) : name === 'cat' && operands(argv).length === 0 && input?.literal === true
        if (!prints) return false
        any = true
      }
  return any
}

function isAssignment(w: Word): boolean {
  const first = w.parts[0]
  return first !== undefined && 'lit' in first && /^[A-Za-z_]\w*=/.test(first.lit)
}

function nameOf(w: Word | undefined): string | null {
  if (w === undefined || w.dynamic) return null
  const base = w.text.split('/').pop() ?? ''
  return base === '' ? null : base
}

function variable(name: string, st: State): string | undefined {
  return st.vars.get(name) ?? (name === 'HOME' ? st.home : name === 'PWD' && st.cwd !== null ? st.cwd : undefined)
}

/** A word's value, or null when the shell fills in something that cannot be known here. */
function expand(w: Word, st: State): string | null {
  if (w.dynamic) return null
  const out = shellText(w, st)
  return out.includes(UNKNOWN) ? null : out
}

/**
 * A word as the program it is passed to reads it (a `-c` or `-e` script):
 * known variables filled in, anything else marked UNKNOWN. Single-quoted text
 * stays as written, as the shell leaves it.
 */
function shellText(w: Word, st: State): string {
  let out = ''
  for (const p of w.parts) {
    if ('lit' in p) out += p.lit
    else if ('tilde' in p) out += p.tilde === '' && st.home !== undefined ? st.home : UNKNOWN
    else if ('dyn' in p) out += UNKNOWN
    else out += variable(p.v, st) ?? p.def ?? UNKNOWN
  }
  return out
}

/**
 * An unquoted here-document's body as the program reads it: `\$`, `` \` `` and
 * `\\` unescaped, known variables filled in, other expansions marked UNKNOWN.
 * `literal`: nothing in it expands, so it reads exactly as the model wrote it.
 */
function expandBody(body: string, st: State): { text: string; literal: boolean } {
  let text = ''
  let literal = true
  for (let j = 0; j < body.length; j++) {
    const c = body[j] as string
    const n = body[j + 1] ?? ''
    if (c === '\\') {
      if (n === '$' || n === '`' || n === '\\') {
        text += n
        j++
      } else if (n === '\n') j++
      else text += c
      continue
    }
    if (c === '`') {
      const end = body.indexOf('`', j + 1)
      j = end < 0 ? body.length : end
      text += UNKNOWN
      literal = false
      continue
    }
    if (c !== '$') {
      text += c
      continue
    }
    if (n === '(') {
      let depth = 0
      let k = j + 1
      for (; k < body.length; k++) {
        if (body[k] === '(') depth++
        else if (body[k] === ')' && --depth === 0) break
      }
      j = k
      text += UNKNOWN
      literal = false
      continue
    }
    if (n === '{') {
      const end = body.indexOf('}', j + 2)
      const inner = body.slice(j + 2, end < 0 ? body.length : end)
      j = end < 0 ? body.length : end
      const m = /^([A-Za-z_]\w*)(?::?-(.*))?$/.exec(inner)
      text += (m === null ? undefined : (variable(m[1] as string, st) ?? m[2])) ?? UNKNOWN
      literal = false
      continue
    }
    const m = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(body.slice(j + 1, j + 65))
    if (m === null) {
      text += c
      continue
    }
    text += variable(m[0], st) ?? UNKNOWN
    j += m[0].length
    literal = false
  }
  return { text, literal }
}

/** Forgets writes in place: substitutions and subshells share the list. */
function drop(st: State, gone: (f: Found) => boolean) {
  for (let k = st.found.length - 1; k >= 0; k--) if (gone(st.found[k] as Found)) st.found.splice(k, 1)
}

function record(st: State, target: string, via: WriteVia, authored: boolean, producer: string, word?: Word, reads?: string[]): string | null {
  const path = pathOf(word === undefined ? target : expand(word, st), st)
  st.found.push({ target, path, via, authored, producer, ...(reads === undefined ? {} : { reads }) })
  return path
}

function pathOf(value: string | null, st: State): string | null {
  if (value === null || value === '' || value.includes(UNKNOWN)) return null
  if (st.placeholders.some(p => value.includes(p))) return null
  if (value.startsWith('/')) return resolvePath(value, '/')
  return st.cwd === null ? null : resolvePath(value, st.cwd)
}

/** The text of a script file the command wrote a moment ago, when it runs it. */
function scriptFile(w: Word | undefined, st: State): string | null {
  if (w === undefined) return null
  const path = pathOf(expand(w, st), st)
  return path === null ? null : (st.scripts.get(path) ?? null)
}

const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>'])

/**
 * Records output redirections; true when stdout goes to a file. `content`: what
 * is written, when known; `reads`: the files the command read.
 */
function redirectOutputs(redirects: Redirect[], authored: boolean, producer: string, st: State, content?: string, reads?: string[]): boolean {
  let stdout = false
  for (const r of redirects) {
    if (r.target !== null) for (const l of r.target.subs) walkList(l, fork(st))
    if (!WRITE_OPS.has(r.op) || r.target === null) continue
    const isStdout = r.fd === null || r.fd === 1 || r.op.startsWith('&')
    if (isStdout) stdout = true
    const path = record(st, r.target.text, 'redirect', authored && isStdout, producer, r.target, isStdout ? reads : undefined)
    if (path !== null && isStdout && content !== undefined && r.op !== '>>' && r.op !== '&>>') st.scripts.set(path, content)
  }
  return stdout
}

/**
 * A here-document or here-string. `body`: as written (a shell reading it fills
 * in its own variables); `code`: as a program reads it, the shell's expansions
 * done; `literal`: the shell leaves it exactly as written.
 */
type Input = { body: string; code: string; literal: boolean }

function stdinOf(redirects: Redirect[], st: State): Input | null {
  for (const r of redirects) {
    if (r.op !== '<<' && r.op !== '<<-' && r.op !== '<<<') continue
    const body = r.body ?? ''
    if (r.op === '<<<') return { body, code: r.word === undefined ? body : shellText(r.word, st), literal: r.verbatim === true }
    if (r.verbatim === true) return { body, code: body, literal: true }
    const { text, literal } = expandBody(body, st)
    return { body, code: text, literal }
  }
  return null
}

/** Words the shell does not fill in at run time: the model knows exactly what they print. */
function literalWords(words: Word[], st: State): boolean {
  return words.every(w => !w.dynamic && expand(w, st) !== null)
}

/** `replace`: the string `xargs -I` replaces with each input line. */
type Unwrapped = { argv: Word[]; xargs: boolean; replace?: string }

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac'])
const DECLARES = new Set(['export', 'local', 'declare', 'typeset', 'readonly'])

const SUDO_ARGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir'])
/** xargs options that take the next word; GNU `-i`, `-e` and `-l` take theirs joined, if at all. */
const XARGS_ARGS = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-a', '-E', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-chars'])

/** Strips the commands that only run another one: sudo, env, nice, timeout, xargs... */
function unwrap(words: Word[]): Unwrapped {
  let argv = words
  let xargs = false
  let replace: string | undefined
  for (let guard = 0; guard < 8; guard++) {
    while (argv.length > 0 && isAssignment(argv[0] as Word)) argv = argv.slice(1)
    const name = nameOf(argv[0])
    if (name === null) break
    let k = 1
    const opt = () => argv[k]?.text ?? ''
    if (KEYWORDS.has(name) && !(argv[0] as Word).quoted) {
      // `if`, `then`, `do`, `!`...: the command follows.
    } else if (name === 'sudo' || name === 'doas' || name === 'runuser') {
      while (k < argv.length && opt().startsWith('-')) {
        if (opt() === '--') {
          k++
          break
        }
        k += SUDO_ARGS.has(opt()) ? 2 : 1
      }
    } else if (name === 'env') {
      while (k < argv.length && (opt().startsWith('-') || /^[A-Za-z_]\w*=/.test(opt()))) k += opt() === '-u' || opt() === '-C' ? 2 : 1
    } else if (name === 'nice' || name === 'ionice') {
      while (k < argv.length && opt().startsWith('-')) k += /^-[nc]$/.test(opt()) ? 2 : 1
    } else if (name === 'timeout') {
      while (k < argv.length && opt().startsWith('-')) k += /^-[sk]$/.test(opt()) ? 2 : 1
      k++
    } else if (name === 'stdbuf' || name === 'setsid' || name === 'nohup' || name === 'time' || name === 'builtin' || name === 'exec' || name === 'chronic' || name === 'unbuffer') {
      while (k < argv.length && opt().startsWith('-')) k += /^-[ioe]$/.test(opt()) ? 2 : 1
    } else if (name === 'command') {
      if (/^-[vV]/.test(opt())) return { argv: [], xargs }
      while (k < argv.length && opt().startsWith('-')) k++
    } else if (name === 'xargs') {
      while (k < argv.length && opt().startsWith('-')) {
        const o = opt()
        if (o === '-I') replace = argv[k + 1]?.text
        else if (o === '-i' || o === '--replace') replace = '{}'
        else if (/^-[Ii]./.test(o)) replace = o.slice(2)
        else if (o.startsWith('--replace=')) replace = o.slice('--replace='.length)
        k += XARGS_ARGS.has(o) ? 2 : 1
      }
      xargs = true
    } else if ((name === 'uv' || name === 'poetry' || name === 'pipenv') && opt() === 'run') {
      k = 2
      while (k < argv.length && opt().startsWith('-')) k++
    } else break
    argv = argv.slice(k)
  }
  return { argv, xargs, ...(replace === undefined || replace === '' ? {} : { replace }) }
}

/** Arguments that are not options (a lone `-` counts as an operand). */
function operands(argv: Word[]): Word[] {
  const out: Word[] = []
  let opts = true
  for (const w of argv.slice(1)) {
    if (opts && w.text === '--') {
      opts = false
      continue
    }
    if (opts && w.text.startsWith('-') && w.text !== '-') continue
    out.push(w)
  }
  return out
}

function assign(words: Word[], st: State) {
  for (const w of words) {
    const value = expand(w, st)
    const name = w.text.slice(0, w.text.indexOf('='))
    if (value === null) st.vars.delete(name)
    else st.vars.set(name, value.slice(value.indexOf('=') + 1))
  }
}

/** Walks one simple command; returns what it passes down the pipe. */
function walkSimple(cmd: Extract<Command, { kind: 'simple' }>, st: State, up: Piped, piped: boolean): Omit<Piped, 'listed'> {
  const none = { authored: false, reads: [] }
  for (const w of cmd.words) for (const l of w.subs) walkList(l, fork(st))

  const words = cmd.words
  // `for f in src/*.ts; do sed -i ... "$f"`: the loop variable stands for the list.
  if (words[0]?.text === 'for' && words[2]?.text === 'in' && words[1] !== undefined) {
    const items = words.slice(3).map(w => expand(w, st))
    const name = words[1].text
    if (items.length === 0 || items.some(v => v === null)) st.vars.delete(name)
    else st.vars.set(name, items.length === 1 ? (items[0] as string) : `{${items.join(',')}}`)
    return none
  }
  if (words.length > 0 && words.every(isAssignment)) assign(words, st)

  const { argv, xargs, replace } = unwrap(words)
  // `xargs -I F sh -c '... > F'`: F is whatever xargs reads, unknown here.
  if (replace !== undefined) st = { ...st, placeholders: [...st.placeholders, replace] }
  const name = nameOf(argv[0])
  const input = stdinOf(cmd.redirects, st)
  const stdin = input?.body ?? null
  const code = input?.code ?? null
  const fedContent = input !== null ? input.literal : up.authored

  if (name === null) {
    // A bare `> file` truncates or creates it.
    const bare = words.length === 0 || words.every(isAssignment)
    redirectOutputs(cmd.redirects, bare && cmd.redirects.some(r => r.op === '>' || r.op === '>|'), '', st)
    return none
  }
  if (DECLARES.has(name) && !(argv[0] as Word).quoted) {
    assign(argv.slice(1).filter(isAssignment), st)
    return none
  }

  if (name === 'cd' || name === 'pushd') {
    const dir = argv[1]
    if (dir === undefined) st.cwd = st.home ?? null
    else {
      const value = dir.text === '-' ? null : expand(dir, st)
      st.cwd = value === null ? null : st.cwd === null && !value.startsWith('/') ? null : resolvePath(value, st.cwd ?? '/')
    }
    return none
  }
  if (name === 'popd') {
    st.cwd = null
    return none
  }

  if (name === 'find') {
    walkFind(argv, st)
    redirectOutputs(cmd.redirects, false, name, st)
    return none
  }

  let authored = false
  if (AUTHORS.has(name)) authored = literalWords(argv.slice(1), st)
  else if (name === 'cat') authored = operands(argv).every(w => w.text === '-') && (fedContent || (!piped && input === null))
  else if (FILTERS.has(name)) authored = fedContent
  // What a filter read, its own files and those piped into it: moved over one of them, its output is an edit.
  const reads = TRANSFORMERS.has(name) ? [...readsOf(argv, st), ...(input === null ? up.reads : [])] : []

  if (name === 'sed') inPlace(argv, st, 'sed -i', xargs, up.listed)
  else if (name === 'perl') {
    inPlace(argv, st, 'perl -i', xargs, up.listed)
    const script = flagValue(argv, ['-e', '-E'], w => shellText(w, st))
    if (script !== null) for (const t of perlWrites(script)) recordScript(st, t, name)
  } else if (name === 'ruby') {
    inPlace(argv, st, 'ruby -i', xargs, up.listed)
    const script = flagValue(argv, ['-e'], w => shellText(w, st)) ?? (operands(argv).length === 0 ? code : null)
    if (script !== null) for (const t of rubyWrites(script)) recordScript(st, t, name)
  } else if (name === 'awk' || name === 'gawk') {
    awkInPlace(argv, st, xargs, up.listed)
  } else if (name === 'yq') {
    yqInPlace(argv, st, xargs, up.listed)
  } else if (name === 'tee') {
    for (const w of operands(argv)) {
      const path = record(st, w.text, 'tee', fedContent, name, w)
      if (path !== null && input?.literal === true && !argv.some(a => a.text === '-a' || a.text === '--append')) st.scripts.set(path, input.body)
    }
  } else if (name === 'sponge') {
    for (const w of operands(argv)) record(st, w.text, 'sponge', true, name, w)
  } else if (SHELLS.has(name)) {
    const script = shellScript(argv, stdin) ?? scriptFile(operands(argv)[0], st)
    if (script !== null && st.depth < MAX_DEPTH) walkList(parseShell(script), { ...fork(st), depth: st.depth + 1 })
  } else if (name === 'eval' && st.depth < MAX_DEPTH) {
    walkList(parseShell(argv.slice(1).map(w => w.text).join(' ')), { ...fork(st), depth: st.depth + 1 })
  } else if (name === 'su' || name === 'flock') {
    const script = flagValue(argv, ['-c', '--command'], w => w.text)
    if (script !== null && st.depth < MAX_DEPTH) walkList(parseShell(script), { ...fork(st), depth: st.depth + 1 })
  } else if (PYTHON.test(name)) {
    const file = operands(argv)[0]
    const written = scriptFile(file, st)
    const run = written !== null ? { code: written, args: operands(argv).map(w => expand(w, st)) } : pythonCode(argv, code, st)
    if (run !== null) for (const t of pythonWrites(run.code, run.args, st.home)) recordScript(st, t, name)
  } else if (JS.test(name) || name === 'deno') {
    const inline = jsCode(argv, code, name, st)
    const script = inline ?? scriptFile(operands(argv)[0], st)
    // `node -e CODE a b`: process.argv is [node, a, b]; `node file.js a`: [node, file.js, a].
    const rest = operands(argv).map(w => expand(w, st))
    const args = [name, ...(inline !== null && argv.some(w => /^(-e|--eval|-p|--print)$/.test(w.text)) ? rest.slice(1) : rest)]
    if (script !== null) for (const t of jsWrites(script, st.home, args)) recordScript(st, t, name)
  } else if (name === 'mv' || name === 'cp') {
    moveOver(argv, st, name)
  } else if (name === 'rm' || name === 'unlink') {
    for (const w of operands(argv)) {
      const v = expand(w, st)
      if (v === null || st.cwd === null) continue
      const path = resolvePath(v, st.cwd)
      drop(st, f => f.path !== null && (f.path === path || f.path.startsWith(`${path}/`)))
    }
  }

  const redirected = redirectOutputs(cmd.redirects, authored, name, st, name === 'cat' && input?.literal === true ? input.body : undefined, reads)
  return { authored: authored && !redirected, reads: redirected ? [] : reads }
}

/** The files a command names as operands, resolved (a pattern or a script among them is harmless). */
function readsOf(argv: Word[], st: State): string[] {
  const out: string[] = []
  for (const w of operands(argv)) {
    const path = pathOf(expand(w, st), st)
    if (path !== null) out.push(path)
  }
  return out
}

function recordScript(st: State, write: ScriptWrite | string, producer: string) {
  const { path, edit } = typeof write === 'string' ? { path: write, edit: true } : write
  if (path === null || path.includes(UNKNOWN)) st.found.push({ target: '(a path the script computes)', path: null, via: 'script', authored: edit || path === null, producer })
  else record(st, path, 'script', edit, producer)
}

type InPlaceVia = 'sed -i' | 'perl -i' | 'ruby -i'

/**
 * How each tool spells its options: `script` letters take the program (next
 * word when last in a bundle), `arg` letters take the next word when last,
 * `stop` letters take the rest of the bundle; `bsd`: `-i ''` or `-i .bak` may follow.
 */
const FLAVORS: Record<InPlaceVia, { script: string; arg: string; stop: string; bsd: boolean }> = {
  'sed -i': { script: 'ef', arg: 'l', stop: '', bsd: true },
  'perl -i': { script: 'eE', arg: 'MIm', stop: 'FCdDx', bsd: false },
  'ruby -i': { script: 'e', arg: 'rICE', stop: 'FWxKT', bsd: false },
}

/** `sed -i`, `perl -i`, `ruby -i`: every file operand is rewritten in place. */
function inPlace(argv: Word[], st: State, via: InPlaceVia, xargs: boolean, listed: Listed | null) {
  const flavor = FLAVORS[via]
  let inplace = false
  let script = false
  const files: Word[] = []
  let opts = true
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k] as Word
    const t = w.text
    if (opts && t === '--') {
      opts = false
      continue
    }
    if (opts && t.startsWith('--')) {
      if (t === '--in-place' || t.startsWith('--in-place=')) inplace = true
      else if (t === '--expression' || t === '--file') {
        script = true
        k++
      } else if (t.startsWith('--expression=') || t.startsWith('--file=')) script = true
      else if (t === '--line-length') k++
      continue
    }
    if (opts && t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j] as string
        const last = j === letters.length - 1
        if (ch === 'i') {
          inplace = true
          // GNU takes the rest as a suffix (`-i.bak`); BSD takes the next word (`-i ''`, `-i .bak`).
          const next = argv[k + 1]
          if (flavor.bsd && last && next !== undefined && (next.text === '' || /^\.[\w.~-]+$/.test(next.text)) && argv.length - k > 3) k++
          break
        }
        if (flavor.script.includes(ch)) {
          script = true
          if (last) k++
          break
        }
        if (flavor.arg.includes(ch)) {
          if (last) k++
          break
        }
        if (flavor.stop.includes(ch)) break
      }
      continue
    }
    if (!script) {
      script = true
      continue
    }
    files.push(w)
  }
  if (inplace) recordInPlace(files, st, via, xargs, listed)
}

/** The files an in-place edit rewrites; with xargs and no file of its own, those the command before it lists. */
function recordInPlace(files: Word[], st: State, via: WriteVia, xargs: boolean, listed: Listed | null) {
  const held = (w: Word) => st.placeholders.some(p => w.text.includes(p))
  for (const w of files) if (!held(w)) record(st, w.text, via, true, via, w)
  if (!xargs || !files.every(held)) return
  if (listed === null) st.found.push({ target: '(files from xargs)', path: null, via, authored: true, producer: via })
  else for (const path of listed.paths) st.found.push({ target: listed.target, path, via, authored: true, producer: via })
}

/** `gawk -i inplace '{...}' f`: the files after the program are rewritten. */
function awkInPlace(argv: Word[], st: State, xargs: boolean, listed: Listed | null) {
  let inplace = false
  let program = false
  const files: Word[] = []
  let opts = true
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k] as Word
    const t = w.text
    if (opts && t === '--') {
      opts = false
      continue
    }
    if (opts && t.startsWith('-') && t !== '-') {
      const lib = t === '-i' || t === '--include' ? argv[++k]?.text : (/^-i(.+)$/.exec(t)?.[1] ?? /^--include=(.+)$/.exec(t)?.[1])
      if (lib !== undefined) {
        if (/^inplace(\.awk)?$/.test(lib)) inplace = true
      } else if (t === '-f' || t === '--file' || t === '-e' || t === '--source') {
        program = true
        k++
      } else if (/^--(file|source)=/.test(t)) program = true
      else if (t === '-v' || t === '-F' || t === '--assign' || t === '--field-separator') k++
      continue
    }
    if (!program) {
      program = true
      continue
    }
    if (/^[A-Za-z_]\w*=/.test(t)) continue
    files.push(w)
  }
  if (inplace) recordInPlace(files, st, 'awk -i inplace', xargs, listed)
}

/** `yq -i '.a = 1' f.yaml` (also `yq e -i`, `--inplace`): the files after the expression are rewritten. */
function yqInPlace(argv: Word[], st: State, xargs: boolean, listed: Listed | null) {
  let k = /^(e|eval|ea|eval-all)$/.test(argv[1]?.text ?? '') ? 2 : 1
  let inplace = false
  let expression = false
  const files: Word[] = []
  for (; k < argv.length; k++) {
    const w = argv[k] as Word
    const t = w.text
    if (t === '--inplace' || t === '--in-place' || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t)) inplace = true
    else if (/^(-o|-p|-I|--output-format|--input-format|--indent|--front-matter)$/.test(t)) k++
    else if (t === '--expression' || t === '--from-file') {
      expression = true
      k++
    } else if (t.startsWith('-') && t !== '-') continue
    else if (!expression) expression = true
    else files.push(w)
  }
  if (inplace) recordInPlace(files, st, 'yq -i', xargs, listed)
}

/** `find DIR ... -exec sed -i ... {} +`: the files under DIR are edited. */
function walkFind(argv: Word[], st: State) {
  const roots: string[] = []
  let k = 1
  for (; k < argv.length; k++) {
    const t = (argv[k] as Word).text
    if (t.startsWith('-') || t === '(' || t === '!') break
    roots.push(t)
  }
  if (roots.length === 0) roots.push('.')
  for (; k < argv.length; k++) {
    const t = (argv[k] as Word).text
    if (t !== '-exec' && t !== '-execdir' && t !== '-ok' && t !== '-okdir') continue
    let end = k + 1
    while (end < argv.length && !/^(;|\+)$/.test((argv[end] as Word).text)) end++
    const inner = argv.slice(k + 1, end)
    const innerName = nameOf(unwrap(inner).argv[0])
    if (innerName === 'sed' || innerName === 'perl') {
      inPlace(unwrap(inner).argv, st, innerName === 'sed' ? 'sed -i' : 'perl -i', false, null)
      if (hasInPlaceFlag(inner, innerName) && inner.some(w => w.text === '{}')) {
        for (const root of roots) {
          const base = st.cwd === null && !root.startsWith('/') ? null : resolvePath(root, st.cwd ?? '/')
          st.found.push({ target: `files found under ${root}`, path: base === null ? null : `${base === '/' ? '' : base}/**`, via: innerName === 'sed' ? 'sed -i' : 'perl -i', authored: true, producer: innerName })
        }
      }
    }
    k = end
  }
}

function hasInPlaceFlag(argv: Word[], name: string): boolean {
  return argv.some(w => (name === 'sed' ? /^-[a-zA-Z]*i|^--in-place/ : /^-[a-zA-Z0-9]*i/).test(w.text))
}

/**
 * `x > f.tmp && mv f.tmp f`: an edit of f made through a temporary file, when
 * the model wrote x, or a filter made it from f itself (`sed ... f > f.tmp`).
 * A filter fed another program's output (`curl ... | jq . > f.tmp`) is not.
 */
function moveOver(argv: Word[], st: State, name: 'mv' | 'cp') {
  const ops = operands(argv)
  if (ops.length < 2 || st.cwd === null) return
  const dest = ops[ops.length - 1] as Word
  const destPath = pathOf(expand(dest, st), st)
  for (const src of ops.slice(0, -1)) {
    const v = expand(src, st)
    if (v === null) continue
    const path = resolvePath(v, st.cwd)
    const made = st.found.find(f => f.path === path)
    if (made === undefined) continue
    const rewrote = TRANSFORMERS.has(made.producer) && destPath !== null && (made.reads ?? []).includes(destPath)
    if (name === 'mv') drop(st, f => f === made)
    record(st, dest.text, name, made.authored || rewrote, made.producer, dest)
    if (name === 'cp') (st.found[st.found.length - 1] as Found).from = path
  }
}

/** The value of an option: `read` turns its word into text (as written, or as the program reads it). */
function flagValue(argv: Word[], flags: string[], read: (w: Word) => string): string | null {
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k] as Word
    const t = w.text
    const next = argv[k + 1]
    if (flags.includes(t)) return next === undefined ? null : read(next)
    for (const f of flags) if (f.startsWith('--') && t.startsWith(`${f}=`)) return read(w).slice(f.length + 1)
    // perl -pe 'code', -ne 'code': the flag ends a bundle.
    if (flags.includes('-e') && /^-[a-zA-Z0-9]+e$/.test(t) && !t.startsWith('--')) return next === undefined ? null : read(next)
  }
  return null
}

function shellScript(argv: Word[], stdin: string | null): string | null {
  for (let k = 1; k < argv.length; k++) {
    const t = (argv[k] as Word).text
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) return argv[k + 1]?.text ?? null
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(t)) return stdin
    if (!t.startsWith('-')) return null
  }
  return stdin
}

/** The code `python -c CODE` or `python - <<EOF` runs, as the shell hands it over. */
function pythonCode(argv: Word[], stdin: string | null, st: State): { code: string; args: (string | null)[] } | null {
  const values = (from: number) => argv.slice(from).map(w => expand(w, st))
  for (let k = 1; k < argv.length; k++) {
    const t = (argv[k] as Word).text
    if (t === '-c') {
      const code = argv[k + 1]
      return { code: code === undefined ? '' : shellText(code, st), args: ['-c', ...values(k + 2)] }
    }
    if (t === '-m') return null
    if (t === '-') return stdin === null ? null : { code: stdin, args: values(k) }
    if (/^-[WX]$/.test(t)) {
      k++
      continue
    }
    if (t.startsWith('-')) continue
    return null
  }
  return stdin === null ? null : { code: stdin, args: [''] }
}

/** The code `node -e CODE`, `deno eval CODE` or `node - <<EOF` runs, as the shell hands it over. */
function jsCode(argv: Word[], stdin: string | null, name: string, st: State): string | null {
  let k = 1
  if (name === 'deno') {
    if (argv[1]?.text !== 'eval') return null
    const code = operands(argv.slice(1))[0]
    return code === undefined ? null : shellText(code, st)
  }
  for (; k < argv.length; k++) {
    const w = argv[k] as Word
    const t = w.text
    if (t === '-e' || t === '--eval' || t === '-p' || t === '--print') {
      const code = argv[k + 1]
      return code === undefined ? null : shellText(code, st)
    }
    if (t.startsWith('--eval=') || t.startsWith('--print=')) return shellText(w, st).slice(t.indexOf('=') + 1)
    if (t === '-') return stdin
    if (t.startsWith('-')) continue
    return null
  }
  return stdin
}

// ---------------------------------------------------------------- scripts

/** The argument list of the call whose `(` is at `open`, split at top-level commas; null when unbalanced. */
export function callArgs(code: string, open: number): string[] | null {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let j = open; j < code.length; j++) {
    const c = code[j] as string
    if (c === '"' || c === "'" || c === '`') {
      const triple = code.startsWith(c.repeat(3), j)
      const close = triple ? code.indexOf(c.repeat(3), j + 3) : findClose(code, j, c)
      if (close < 0) return null
      j = triple ? close + 2 : close
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        args.push(code.slice(start, j).trim())
        return args.filter((a, i) => a !== '' || i === 0)
      }
    } else if (c === ',' && depth === 1) {
      args.push(code.slice(start, j).trim())
      start = j + 1
    }
  }
  return null
}

function findClose(code: string, open: number, quote: string): number {
  for (let j = open + 1; j < code.length; j++) {
    const c = code[j]
    if (c === '\\') j++
    else if (c === quote) return j
    else if (c === '\n' && quote !== '`') return -1
  }
  return -1
}

/** Splits an expression at a top-level operator character. */
function splitTop(expr: string, op: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j] as string
    if (c === '"' || c === "'" || c === '`') {
      const close = findClose(expr, j, c)
      if (close < 0) return [expr]
      j = close
    } else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === op && depth === 0) {
      parts.push(expr.slice(start, j).trim())
      start = j + 1
    }
  }
  parts.push(expr.slice(start).trim())
  return parts
}

type Assign = { at: number; expr: string }
/** What an expression is evaluated against; `at` is where in the code it stands. */
type Env = { vars: Map<string, Assign[]>; args: (string | null)[]; home: string | undefined; depth: number; at: number }

function stringLiteral(expr: string, env: Env): string | null | undefined {
  const m = /^([rRbBuUfF]{0,2})("""|\'\'\'|"|'|`)/.exec(expr)
  if (m === null) return undefined
  const prefix = (m[1] ?? '').toLowerCase()
  const quote = m[2] as string
  const open = (m[1] ?? '').length
  const close = quote.length === 3 ? expr.indexOf(quote, open + 3) : findClose(expr, open, quote)
  if (close !== expr.length - quote.length) return undefined
  let body = expr.slice(open + quote.length, close)
  if (quote === '`' || prefix.includes('f')) {
    const tmpl = quote === '`' ? /\$\{([^}]*)\}/g : /\{([^{}]*)\}/g
    let failed = false
    body = body.replace(tmpl, (_, inner: string) => {
      const v = evaluate(inner.trim(), env)
      if (v === null) failed = true
      return v ?? ''
    })
    if (failed) return null
  }
  return prefix.includes('r') ? body : body.replace(/\\(.)/g, '$1')
}

/** Best-effort value of a path expression in Python or JavaScript; null when it cannot be known. */
function evaluate(expr: string, env: Env): string | null {
  if (env.depth > 6) return null
  const e = expr.trim().replace(/^await\s+/, '')
  const literal = stringLiteral(e, env)
  if (literal !== undefined) return literal
  const deeper: Env = { ...env, depth: env.depth + 1 }
  const plus = splitTop(e, '+')
  if (plus.length > 1) {
    const vals = plus.map(p => evaluate(p, deeper))
    return vals.some(v => v === null) ? null : vals.join('')
  }
  const slash = splitTop(e, '/')
  if (slash.length > 1 && slash.every(s => s !== '')) {
    const vals = slash.map(p => evaluate(p, deeper))
    return vals.some(v => v === null) ? null : vals.join('/')
  }
  if (/^\(.*\)$/s.test(e)) return evaluate(e.slice(1, -1), deeper)
  const call = /^([\w.]+)\s*\(/.exec(e)
  if (call !== null && e.endsWith(')')) {
    const fn = call[1] as string
    const args = callArgs(e, (call[0] as string).length - 1) ?? []
    const vals = () => args.filter(a => a !== '' && !/^\w+\s*=[^=]/.test(a)).map(a => evaluate(a, deeper))
    if (/^(pathlib\.)?(Path|PurePath|PosixPath)$|^(os\.path\.join|path\.join|path\.resolve|join|resolve)$/.test(fn)) {
      const v = vals()
      if (v.length === 0 || v.some(x => x === null)) return null
      return (v as string[]).reduce((acc, part) => (part.startsWith('/') ? part : acc === '' ? part : `${acc}/${part}`), '')
    }
    if (/^(os\.path\.(abspath|realpath|normpath|expanduser)|str|String|path\.normalize)$/.test(fn)) {
      const v = evaluate(args[0] ?? '', deeper)
      if (v === null) return null
      return v.startsWith('~') && env.home !== undefined ? env.home + v.slice(1) : v
    }
    if (/^(Path\.home|os\.homedir|os\.path\.expanduser)$/.test(fn) && args.length <= 1) return env.home ?? null
    const method = /^(.*)\.(resolve|absolute|expanduser)$/.exec(fn)
    if (method !== null && args.length <= 1) return evaluate(`${method[1]}`, deeper)
    return null
  }
  const argv = /^(?:sys|process)\.argv\[(\d+)\]$/.exec(e)
  if (argv !== null) return env.args[Number(argv[1])] ?? null
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    // The assignment in force where the expression stands: the last one before it.
    const all = env.vars.get(e) ?? []
    const before = all.filter(a => a.at < env.at)
    const pick = before[before.length - 1] ?? all[all.length - 1]
    if (pick !== undefined) return evaluate(pick.expr, { ...deeper, at: pick.at })
  }
  return null
}

/** `NAME = value` heads (the RegExp matches up to `=`), with each value read to the end of its statement. */
function assignments(code: string, head: RegExp): Map<string, Assign[]> {
  const vars = new Map<string, Assign[]>()
  for (const m of code.matchAll(head)) {
    const name = m[1] as string
    const at = m.index ?? 0
    vars.set(name, [...(vars.get(name) ?? []), { at, expr: statementFrom(code, at + m[0].length) }])
  }
  return vars
}

/** The rest of a statement: up to a `;` or line end outside brackets and strings. */
function statementFrom(code: string, start: number): string {
  let depth = 0
  for (let j = start; j < code.length; j++) {
    const c = code[j] as string
    if (c === '"' || c === "'" || c === '`') {
      const triple = code.startsWith(c.repeat(3), j)
      const close = triple ? code.indexOf(c.repeat(3), j + 3) : findClose(code, j, c)
      if (close < 0) return code.slice(start, j).trim()
      j = triple ? close + 2 : close
    } else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if ((c === ';' || c === '\n') && depth <= 0) return code.slice(start, j).trim()
  }
  return code.slice(start).trim()
}

/**
 * A file a script writes. `edit`: the script also reads that file (it rewrites it)
 * or writes literal text; either is a change the Edit or Write tool could make.
 * A script that writes what it computed (a report, a data dump) is not.
 */
export type ScriptWrite = { path: string | null; edit: boolean }

const PY_HEAD = /(?<=^|;)[ \t]*([A-Za-z_]\w*)[ \t]*(?::[ \t]*[\w.[\], |]+)?=(?!=)/gm

/** Files a Python script writes. */
export function pythonWrites(code: string, args: (string | null)[] = [], home?: string): ScriptWrite[] {
  const env: Env = { vars: assignments(code, PY_HEAD), args, home, depth: 0, at: 0 }
  const reads = new Set<string>()
  const writes: { paths: (string | null)[]; literal: boolean; arg: string }[] = []
  for (const m of code.matchAll(/(?<![\w.])(?:(?:io|codecs|gzip|bz2|lzma|builtins)\.)?open\s*\(/g)) {
    const at = m.index ?? 0
    const open = at + m[0].length - 1
    const args = callArgs(code, open)
    if (args === null || args.length === 0) continue
    const kw = args.find(a => /^mode\s*=/.test(a))
    const modeExpr = kw !== undefined ? kw.replace(/^mode\s*=\s*/, '') : args[1] !== undefined && !/^\w+\s*=/.test(args[1]) ? args[1] : undefined
    const mode = modeExpr === undefined ? 'r' : stringLiteral(modeExpr, env)
    const paths = pathsOf(args[0] as string, code, { ...env, at })
    if (typeof mode !== 'string') continue
    if (!/[wax+]/.test(mode)) {
      for (const p of paths) if (p !== null) reads.add(p)
      continue
    }
    writes.push({ paths, literal: isLiteral(writtenAfterOpen(code, open), code, { ...env, at }), arg: (args[0] as string).trim() })
  }
  for (const m of code.matchAll(/\.(read_text|read_bytes)\s*\(/g)) {
    const receiver = receiverOf(code, m.index ?? 0)
    if (receiver !== '') for (const p of pathsOf(receiver, code, { ...env, at: m.index ?? 0 })) if (p !== null) reads.add(p)
  }
  for (const m of code.matchAll(/\.(write_text|write_bytes)\s*\(/g)) {
    const at = m.index ?? 0
    const receiver = receiverOf(code, at)
    const content = callArgs(code, at + m[0].length - 1)?.[0]
    writes.push({ paths: receiver === '' ? [null] : pathsOf(receiver, code, { ...env, at }), literal: isLiteral(content, code, { ...env, at }), arg: receiver })
  }
  const out: ScriptWrite[] = []
  for (const w of writes) for (const path of w.paths) out.push({ path, edit: w.literal || path === null || reads.has(path) })
  for (const m of code.matchAll(/(?<![\w.])(?:os\.replace|os\.rename|shutil\.move|shutil\.copy(?:file|2)?)\s*\(/g)) {
    const args = callArgs(code, (m.index ?? 0) + m[0].length - 1)
    const from = writes.find(w => w.arg === args?.[0]?.trim())
    if (args === null || args.length < 2 || from === undefined) continue
    const edit = from.literal || from.paths.some(p => p !== null && reads.has(p))
    out.push({ path: evaluate(args[1] as string, { ...env, at: m.index ?? 0 }), edit })
  }
  return out
}

/** What `open(...)` writes: `.write(x)` on the call itself, or on the name `with ... as f` gives it. */
function writtenAfterOpen(code: string, open: number): string | undefined {
  const args = callArgs(code, open)
  if (args === null) return undefined
  let depth = 0
  let close = open
  for (; close < code.length; close++) {
    const c = code[close]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) break
  }
  const rest = code.slice(close + 1)
  const direct = /^\s*\.write\s*\(/.exec(rest)
  if (direct !== null) return callArgs(rest, direct[0].length - 1)?.[0]
  const alias = /^\s*as\s+(\w+)\s*:/.exec(rest)
  if (alias === null) return undefined
  const use = new RegExp(`\\b${alias[1]}\\.write\\s*\\(`).exec(rest)
  return use === null ? undefined : callArgs(rest, use.index + use[0].length - 1)?.[0]
}

/** Whether an expression is literal text: a string, or a name bound to one. */
function isLiteral(expr: string | undefined, code: string, env: Env): boolean {
  if (expr === undefined) return false
  const e = expr.trim()
  if (/^([rRbBuU]{0,2})("""|\'\'\'|"|'|`)/.test(e) && !/^[fF]/.test(e)) return stringLiteral(e, env) !== undefined
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const pick = (env.vars.get(e) ?? []).filter(a => a.at < env.at).pop()
    return pick !== undefined && env.depth < 3 && isLiteral(pick.expr, code, { ...env, at: pick.at, depth: env.depth + 1 })
  }
  return false
}

/**
 * A path expression's value. A variable a literal list feeds (`for p in ['a', 'b']:`)
 * gives each item; a parameter of a helper (`def edit(p, ...)`) gives what each call passes.
 */
function pathsOf(expr: string, code: string, env: Env): (string | null)[] {
  const value = evaluate(expr, env)
  const name = expr.trim()
  if (value !== null || !/^[A-Za-z_]\w*$/.test(name) || env.depth > 2) return [value]
  return loopItems(name, code, env) ?? helperArgs(name, code, env) ?? [null]
}

function loopItems(name: string, code: string, env: Env): (string | null)[] | null {
  const loops = [...code.slice(0, env.at).matchAll(/for\s+\(?([\w\s,]+?)\)?\s+in\s+/g)]
  const loop = loops.reverse().find(l => (l[1] as string).split(',').some(t => t.trim() === name))
  if (loop === undefined) return null
  const slot = (loop[1] as string).split(',').map(t => t.trim()).indexOf(name)
  const start = (loop.index ?? 0) + loop[0].length
  let iterable = statementFrom(code, start).replace(/:$/, '').trim()
  if (/^[A-Za-z_]\w*$/.test(iterable)) iterable = (env.vars.get(iterable) ?? []).filter(a => a.at < start).pop()?.expr ?? ''
  if (!/^[[(].*[\])]$/s.test(iterable)) return null
  const items = callArgs(`(${iterable.slice(1, -1)})`, 0)
  if (items === null || items.length === 0) return null
  const deeper = { ...env, at: start, depth: env.depth + 1 }
  return items.map(item => {
    if ((loop[1] as string).includes(',')) {
      const parts = /^[([]/.test(item) ? callArgs(`(${item.slice(1, -1)})`, 0) : null
      return parts?.[slot] === undefined ? null : evaluate(parts[slot] as string, deeper)
    }
    return evaluate(item, deeper)
  })
}

function helperArgs(name: string, code: string, env: Env): (string | null)[] | null {
  const defs = [...code.slice(0, env.at).matchAll(/def\s+(\w+)\s*\(([^)]*)\)/g)]
  const def = defs[defs.length - 1]
  if (def === undefined) return null
  const slot = (def[2] as string).split(',').map(p => p.trim().replace(/[:=].*$/, '').trim()).indexOf(name)
  if (slot < 0) return null
  const out: (string | null)[] = []
  for (const call of code.matchAll(new RegExp(`(?<![\\w.])${def[1]}\\s*\\(`, 'g'))) {
    if (code.slice(Math.max(0, (call.index ?? 0) - 4), call.index).endsWith('def ')) continue
    const args = callArgs(code, (call.index ?? 0) + call[0].length - 1)
    const arg = args?.[slot]
    out.push(arg === undefined ? null : evaluate(arg, { ...env, at: call.index ?? 0, depth: env.depth + 1 }))
  }
  return out.length === 0 ? null : out
}

/** The expression a method is called on: `Path('a')` in `Path('a').write_text(`. */
function receiverOf(code: string, dot: number): string {
  let j = dot - 1
  for (;;) {
    while (j >= 0 && /\s/.test(code[j] as string)) j--
    if (code[j] === ')' || code[j] === ']') {
      let depth = 0
      for (; j >= 0; j--) {
        const c = code[j]
        if (c === ')' || c === ']') depth++
        else if (c === '(' || c === '[') {
          depth--
          if (depth === 0) break
        }
      }
      j--
    }
    while (j >= 0 && /[\w.]/.test(code[j] as string)) j--
    let k = j
    while (k >= 0 && /[ \t]/.test(code[k] as string)) k--
    if (code[k] === '/' && k > 0) {
      j = k - 1
      continue
    }
    break
  }
  return code.slice(j + 1, dot).trim()
}

/** Files a JavaScript snippet writes. */
export function jsWrites(code: string, home?: string, args: (string | null)[] = []): ScriptWrite[] {
  const env: Env = { vars: assignments(code, /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g), args, home, depth: 0, at: 0 }
  const reads = new Set<string>()
  for (const m of code.matchAll(/(?<![\w$])(?:[\w$]+\.)*(readFileSync|readFile|readTextFileSync|readTextFile)\s*\(/g)) {
    const at = m.index ?? 0
    const first = callArgs(code, at + m[0].length - 1)?.[0]
    const path = first === undefined ? null : evaluate(first, { ...env, at })
    if (path !== null) reads.add(path)
  }
  const out: ScriptWrite[] = []
  for (const m of code.matchAll(/(?<![\w$])(?:[\w$]+\.)*(writeFileSync|appendFileSync|writeFile|appendFile|writeTextFileSync|writeTextFile|createWriteStream|outputFileSync|outputFile|writeJsonSync|writeJson|write)\s*\(/g)) {
    if (m[1] === 'write' && !/Bun\.write\s*\($/.test(m[0])) continue
    const at = m.index ?? 0
    const args = callArgs(code, at + m[0].length - 1)
    if (args === null || args.length === 0) continue
    const path = evaluate(args[0] as string, { ...env, at })
    out.push({ path, edit: path === null || reads.has(path) || isLiteral(args[1], code, { ...env, at }) })
  }
  return out
}

function rubyWrites(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/File\.write\(\s*(['"])([^'"]+)\1/g)) out.push(m[2] as string)
  for (const m of code.matchAll(/File\.open\(\s*(['"])([^'"]+)\1\s*,\s*['"][wa]/g)) out.push(m[2] as string)
  return out
}

function perlWrites(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/open\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*(['"])\s*(>{1,2})\s*([^'"]+)\1/g)) out.push((m[3] as string).trim())
  for (const m of code.matchAll(/open\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*(['"])>{1,2}\1\s*,\s*(['"])([^'"]+)\2/g)) out.push(m[3] as string)
  return out
}

