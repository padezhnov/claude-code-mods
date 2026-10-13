// What to do with the writes shell.ts finds, and the auto-mode note. Pure: no `$`.

import type { PluginOptions } from 'claude-code'

import type { Write } from './shell'

export const DEFAULT_ALLOW = '**/*.log,**/node_modules/**,**/dist/**,**/build/**'

export type Settings = {
  mode: 'deny' | 'warn' | 'off'
  scope: 'project' | 'everywhere'
  allow: string[]
  /** allowPaths entries that are no valid glob (`[z-a]`): left out, and named by /native-edits. */
  invalid: string[]
  rewritePrompt: boolean
}

export function settingsOf(options: PluginOptions): Settings {
  const globs = (typeof options.allowPaths === 'string' ? options.allowPaths : DEFAULT_ALLOW)
    .split(',')
    .map(g => g.trim())
    .filter(g => g !== '')
  const allow: string[] = []
  const invalid: string[] = []
  for (const g of globs) {
    try {
      globToRegExp(g)
      allow.push(g)
    } catch {
      invalid.push(g)
    }
  }
  return {
    mode: options.mode === 'warn' || options.mode === 'off' ? options.mode : 'deny',
    scope: options.scope === 'everywhere' ? 'everywhere' : 'project',
    allow,
    invalid,
    rewritePrompt: options.rewritePrompt !== false,
  }
}

// ---------------------------------------------------------------- globs

/** A glob as a RegExp: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/'
      re += slashAfter ? '(?:.*/)?' : '.*'
      i += slashAfter ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map(a => a.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
          .join('|')})`
        i = end
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) re += '\\['
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  // `dir/**` also matches `dir` itself.
  return new RegExp(`^${re.replace(/\/\.\*$/, '(?:/.*)?')}$`)
}

/** Matches a path against a glob: a glob without a slash matches the file name, like .gitignore. An invalid glob matches nothing. */
export function matchesGlob(path: string, glob: string, roots: readonly string[] = []): boolean {
  let re: RegExp
  try {
    re = globToRegExp(glob)
  } catch {
    return false
  }
  if (!glob.includes('/')) return re.test(path.split('/').pop() ?? '')
  if (re.test(path)) return true
  for (const root of roots) {
    const prefix = root === '/' ? '/' : `${root}/`
    if (path.startsWith(prefix) && re.test(path.slice(prefix.length))) return true
  }
  return false
}

// ---------------------------------------------------------------- judging

export type Place = {
  /** The session's project root, then the shell's current directory: a write inside either is the project's. */
  roots: string[]
  /** Scratch space: /tmp, $TMPDIR. */
  temp: string[]
}

export type Skipped = 'device' | 'temp' | 'outside' | 'allowed' | 'unresolved' | 'copy'

export type Verdict = { refuse: Write[]; skipped: { write: Write; why: Skipped }[] }

const DEVICE = /^\/(dev|proc|sys)(\/|$)/
export const TEMP_DIRS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/folders', '/var/folders', '/dev/shm']

function under(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, '')
  return d === '' || path === d || path.startsWith(`${d}/`)
}

/** The fixed part of a path that may hold a glob: `/w/src/*.ts` → `/w/src`. */
export function staticPrefix(path: string): string {
  const at = path.search(/[*?[{]/)
  if (at < 0) return path
  const cut = path.slice(0, at)
  return cut.slice(0, Math.max(cut.lastIndexOf('/'), 0)) || '/'
}

export function judge(writes: readonly Write[], place: Place, settings: Pick<Settings, 'scope' | 'allow'>): Verdict {
  const verdict: Verdict = { refuse: [], skipped: [] }
  for (const write of writes) {
    const why = skipReason(write, place, settings)
    if (why === null) verdict.refuse.push(write)
    else verdict.skipped.push({ write, why })
  }
  // A copy of a file this command already changes is no second change to name.
  const refused = new Set(verdict.refuse.map(w => w.path))
  for (const copy of verdict.refuse.filter(w => w.from !== undefined && refused.has(w.from))) {
    verdict.refuse.splice(verdict.refuse.indexOf(copy), 1)
    verdict.skipped.push({ write: copy, why: 'copy' })
  }
  return verdict
}

function skipReason(write: Write, place: Place, settings: Pick<Settings, 'scope' | 'allow'>): Skipped | null {
  if (write.path === null) return 'unresolved'
  const fixed = staticPrefix(write.path)
  if (DEVICE.test(fixed)) return 'device'
  // Scratch space, unless the project itself lives inside it (a session started in /tmp/demo);
  // a shell that merely cd'd into /tmp/work is still in scratch space.
  const temp = place.temp.find(t => under(fixed, t))
  const root = place.roots[0]
  if (temp !== undefined && !(root !== undefined && under(fixed, root) && under(root, temp) && !under(temp, root))) return 'temp'
  if (settings.scope === 'project' && !place.roots.some(r => under(fixed, r))) return 'outside'
  if (settings.allow.some(g => matchesGlob(write.path as string, g, place.roots))) return 'allowed'
  return null
}

// ---------------------------------------------------------------- messages

const VIA: Record<Write['via'], string> = {
  'sed -i': 'sed -i',
  'perl -i': 'perl -i',
  'ruby -i': 'ruby -i',
  'awk -i inplace': 'awk -i inplace',
  'yq -i': 'yq -i',
  redirect: 'a redirection',
  tee: 'tee',
  sponge: 'sponge',
  script: 'a script',
  mv: 'a temporary file moved over it',
  cp: 'a file copied over it',
}

/** `a.ts and b.ts`, `a.ts, b.ts and 3 more`, relative to the first root when inside it. */
export function listFiles(writes: readonly Write[], roots: readonly string[] = []): string {
  const names = [...new Set(writes.map(w => shortPath(w, roots)))]
  const shown = names.slice(0, 3)
  const more = names.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  if (shown.length <= 1) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/** A path as the model knows it: relative to the project; for `dir/**` (find, xargs), the command's own words. */
function shortPath(write: Write, roots: readonly string[]): string {
  const path = write.path
  if (path === null || path.endsWith('/**')) return write.target
  return relative(path, roots)
}

function relative(path: string, roots: readonly string[]): string {
  for (const root of roots) if (root !== '/' && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path
}

function vias(writes: readonly Write[], roots: readonly string[]): string {
  return [...new Set(writes.map(w => (w.via === 'cp' && w.from !== undefined ? `${VIA.cp} from ${relative(w.from, roots)}` : VIA[w.via])))].join(', ')
}

/**
 * The refusal. `retry`: the agent may have no Edit or Write tool (a subagent
 * whose tools the plugin cannot see), so the same command runs on a second try.
 */
export function denyReason(writes: readonly Write[], roots: readonly string[], retry = false): string {
  return (
    `native-edits: not run. This command changes ${listFiles(writes, roots)} through the shell (${vias(writes, roots)}). ` +
    'Make file changes with the Edit tool, or Write for a new file or a full rewrite, so they show as a diff, ' +
    'can be undone with /rewind and follow the rules for that path. Run the rest of the command without the write if you still need it. ' +
    'Reading and searching through Bash is fine, and so are files under /tmp, logs and build output.' +
    (retry ? ' If you have no Edit or Write tool, run the same command again: it will run.' : '')
  )
}

export function warnNote(writes: readonly Write[], roots: readonly string[]): string {
  return (
    `native-edits: this command changed ${listFiles(writes, roots)} through the shell (${vias(writes, roots)}); /rewind cannot undo that, and checks on Edit and Write never saw it. ` +
    'Make further changes to files with the Edit tool (Write for new files).'
  )
}

/** After a refusal the agent ran the same write again: it may have no Edit or Write tool. */
export function retryNote(writes: readonly Write[], roots: readonly string[]): string {
  return `native-edits: run on the second try; it changed ${listFiles(writes, roots)} through the shell. If you have the Edit and Write tools, make further file changes with them.`
}

// ---------------------------------------------------------------- the auto-mode note

/**
 * The sentences the auto-mode attachment (`auto_mode`) uses to send file
 * changes through the shell, as Claude Code 2.1.289-2.1.294 words them: the
 * strict variant and the relaxed one. Tool names are captured, not assumed.
 */
const STRICT =
  /Do your work through the (\S+) tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated (\S+), (\S+), or (\S+) tools\. Fall back to a dedicated tool only when \S+ genuinely cannot do the job\./
const RELAXED =
  /You can do much of your work through the (\S+) tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated (\S+), (\S+), or (\S+) tools\. The choice is yours: prefer \S+ or \S+ when a shell edit would be fragile, such as exact or multi-line replacements, or sed\/awk flags that differ between GNU and BSD\/macOS\./

function changeRule(edit: string, write: string, shell: string, mode: Settings['mode']): string {
  // The guard watches the Bash tool only.
  const enforced =
    mode === 'deny' && shell === 'Bash'
      ? ` A ${shell} command that writes to a project file is refused by the native-edits plugin the user installed (in every permission mode; a command the user runs with ! is not affected).`
      : ''
  return (
    `Make every file change with the ${edit} tool (${write} for a new file or a full rewrite), never with sed -i, heredocs, redirection, tee or scripts, ` +
    `so each change shows as a diff, can be undone with /rewind and follows the rules for that path.${enforced} Scratch files under /tmp are fine.`
  )
}

export type Rewrite = { text: string; changed: boolean }

/** Keeps reading and searching through the shell; sends file changes to Edit and Write. */
export function rewriteAutoMode(text: string, mode: Settings['mode']): Rewrite {
  const strict = STRICT.exec(text)
  if (strict !== null) {
    const [, shell, read, edit, write] = strict as unknown as [string, string, string, string, string]
    const replacement =
      `Do your reading and searching through the ${shell} tool wherever it can accomplish the job: read files with cat, head, or sed -n, and search with grep and find, rather than using the dedicated ${read} tool. ` +
      changeRule(edit, write, shell, mode)
    return { text: text.replace(STRICT, () => replacement), changed: true }
  }
  const relaxed = RELAXED.exec(text)
  if (relaxed !== null) {
    const [, shell, read, edit, write] = relaxed as unknown as [string, string, string, string, string]
    const replacement =
      `You can do much of your reading and searching through the ${shell} tool when it is the simpler route: read files with cat, head, or sed -n, and search with grep and find, instead of the dedicated ${read} tool. ` +
      changeRule(edit, write, shell, mode)
    return { text: text.replace(RELAXED, () => replacement), changed: true }
  }
  return { text, changed: false }
}

/** Whether the note speaks of shell file changes at all (another build's wording). */
export function mentionsShellEdits(text: string): boolean {
  return /file changes with sed|heredocs/.test(text)
}

// ---------------------------------------------------------------- the Bash tool's description

/**
 * Where the auto-mode note goes shell-first, Claude Code also drops from the
 * Bash tool's description the lines that send edits to Edit and Write
 * ("Edit files: Use Edit (NOT sed/awk)"). Puts them back, before the
 * description's `# Instructions` when it has one.
 */
export const EDIT_LINES =
  'File changes: when you have the Edit and Write tools, change a file with Edit (NOT sed -i, awk or perl -i) and create or rewrite one with Write (NOT echo >, cat <<EOF or tee). ' +
  'Reading and searching through this tool (cat, head, sed -n, grep, find) is fine.'

export type Described = { description: string; added: boolean }

export function withEditLines(description: string): Described {
  if (/Edit files: Use/i.test(description) || description.includes(EDIT_LINES)) return { description, added: false }
  const at = description.indexOf('\n# Instructions')
  if (at < 0) return { description: `${description.replace(/\s+$/, '')}\n\n${EDIT_LINES}`, added: true }
  return { description: `${description.slice(0, at).replace(/\s+$/, '')}\n\n${EDIT_LINES}\n${description.slice(at)}`, added: true }
}
