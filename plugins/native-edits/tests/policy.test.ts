import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_ALLOW, denyReason, EDIT_LINES, judge, listFiles, matchesGlob, mentionsShellEdits, retryNote, rewriteAutoMode, settingsOf, staticPrefix, TEMP_DIRS, warnNote, withEditLines } from '../hooks/policy'
import type { Write } from '../hooks/shell'

const w = (path: string | null, via: Write['via'] = 'redirect', extra: Partial<Write> = {}): Write => ({ target: path ?? '$X', path, via, by: 'cat', ...extra })
const PLACE = { roots: ['/w'], temp: [...TEMP_DIRS, '/var/folders/xy/T'] }
const DEFAULTS = settingsOf({})

// The two sentences Claude Code 2.1.289-2.1.292 puts in the `auto_mode` attachment, as the model reads them.
const STRICT =
  'Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.'
const RELAXED =
  'You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.'
const AUTO_HEAD = '## Auto Mode Active\n\nBias toward working without stopping for clarifying questions.'

describe('the auto-mode note', () => {
  test('the strict sentence: reading stays in Bash, changes go to Edit and Write', () => {
    const r = rewriteAutoMode(`${AUTO_HEAD}\n\n${STRICT}`, 'deny')
    expect(r.changed).toBe(true)
    expect(r.text).toStartWith(AUTO_HEAD)
    expect(r.text).toContain('read files with cat, head, or sed -n, and search with grep and find')
    expect(r.text).toContain('Make every file change with the Edit tool (Write for a new file or a full rewrite)')
    expect(r.text).not.toContain('make file changes with sed')
    expect(r.text).not.toContain('Fall back to a dedicated tool only')
    expect(r.text).toContain('is refused')
  })

  test('the relaxed sentence, in the bypass-permissions wrapper', () => {
    const r = rewriteAutoMode(`While bypass permissions mode is active:\n\n${RELAXED}`, 'warn')
    expect(r.changed).toBe(true)
    expect(r.text).toStartWith('While bypass permissions mode is active:\n\nYou can do much of your reading and searching through the Bash tool')
    expect(r.text).not.toContain('mechanical file changes with sed')
    expect(r.text).not.toContain('is refused')
  })

  test('tool names are read from the text, not assumed; only Bash is said to be refused (NE-7)', () => {
    const r = rewriteAutoMode(STRICT.replace(/Bash/g, 'PowerShell'), 'deny')
    expect(r.text).toContain('through the PowerShell tool')
    expect(r.text, 'the guard watches Bash only').not.toContain('is refused')
    expect(rewriteAutoMode(STRICT, 'deny').text).toContain('A Bash command that writes to a project file is refused.')
  })

  test('another wording is left exactly as it is', () => {
    const other = `${AUTO_HEAD}\n\nPrefer the shell for file changes with sed and heredocs where it is simpler.`
    expect(rewriteAutoMode(other, 'deny')).toEqual({ text: other, changed: false })
    expect(mentionsShellEdits(other)).toBe(true)
    expect(mentionsShellEdits(AUTO_HEAD)).toBe(false)
  })
})

describe('globs', () => {
  test('the default allow list', () => {
    const allow = DEFAULT_ALLOW.split(',')
    const allowed = (p: string) => allow.some(g => matchesGlob(p, g, ['/w']))
    expect(allowed('/w/build.log')).toBe(true)
    expect(allowed('/w/logs/deep/x.log')).toBe(true)
    expect(allowed('/w/node_modules/pkg/index.js')).toBe(true)
    expect(allowed('/w/packages/a/dist/index.js')).toBe(true)
    expect(allowed('/w/build')).toBe(true)
    expect(allowed('/w/src/distance.ts')).toBe(false)
    expect(allowed('/w/src/builder.ts')).toBe(false)
    expect(allowed('/w/catalog.ts')).toBe(false)
  })

  test('a glob without a slash matches the file name; with one, the path from a root', () => {
    expect(matchesGlob('/w/a/b/notes.txt', '*.txt')).toBe(true)
    expect(matchesGlob('/w/docs/a.md', 'docs/**', ['/w'])).toBe(true)
    expect(matchesGlob('/w/src/docs/a.md', 'docs/**', ['/w'])).toBe(false)
    expect(matchesGlob('/w/a.json', '{a,b}.json')).toBe(true)
    expect(matchesGlob('/w/c.json', '{a,b}.json')).toBe(false)
    expect(matchesGlob('/w/f1.txt', 'f?.txt')).toBe(true)
    expect(matchesGlob('/w/x.lock', '*.[lL]ock')).toBe(true)
  })

  test('the fixed part of a pattern path', () => {
    expect(staticPrefix('/w/src/*.ts')).toBe('/w/src')
    expect(staticPrefix('/w/**')).toBe('/w')
    expect(staticPrefix('/w/a.ts')).toBe('/w/a.ts')
    expect(staticPrefix('/**')).toBe('/')
  })
})

describe('judging', () => {
  test('project files are refused; scratch, devices, logs and unknown paths are not', () => {
    const v = judge([w('/w/a.ts'), w('/tmp/x.py'), w('/var/folders/xy/T/s.json'), w('/dev/null'), w('/w/out.log'), w(null), w('/etc/hosts')], PLACE, DEFAULTS)
    expect(v.refuse.map(x => x.path)).toEqual(['/w/a.ts'])
    expect(v.skipped.map(s => s.why)).toEqual(['temp', 'temp', 'device', 'allowed', 'unresolved', 'outside'])
  })

  test('a project inside /tmp is still a project; the rest of /tmp is scratch', () => {
    const place = { roots: ['/tmp/demo'], temp: TEMP_DIRS }
    const v = judge([w('/tmp/demo/file.txt'), w('/tmp/other.py')], place, DEFAULTS)
    expect(v.refuse.map(x => x.path)).toEqual(['/tmp/demo/file.txt'])
    expect(judge([w('/tmp/a.txt')], { roots: ['/tmp'], temp: TEMP_DIRS }, DEFAULTS).refuse, 'a session in /tmp itself').toHaveLength(0)
    expect(judge([w('/tmp/work/a.txt')], { roots: ['/w', '/tmp/work'], temp: TEMP_DIRS }, DEFAULTS).refuse, 'a shell that cd-ed into /tmp/work').toHaveLength(0)
  })

  test('scope everywhere refuses outside the project too, never in /tmp', () => {
    const v = judge([w('/etc/hosts'), w('/tmp/a')], PLACE, { ...DEFAULTS, scope: 'everywhere' })
    expect(v.refuse.map(x => x.path)).toEqual(['/etc/hosts'])
  })

  test('the session directory counts as the project as well as the root', () => {
    const v = judge([w('/srv/other/a.ts')], { roots: ['/w', '/srv/other'], temp: TEMP_DIRS }, DEFAULTS)
    expect(v.refuse).toHaveLength(1)
  })

  test('patterns are judged by their fixed part', () => {
    expect(judge([w('/w/src/*.ts', 'sed -i')], PLACE, DEFAULTS).refuse).toHaveLength(1)
    expect(judge([w('/tmp/**', 'sed -i')], PLACE, DEFAULTS).refuse).toHaveLength(0)
  })

  test('a copy of a file the command already changes is not named twice', () => {
    const v = judge([w('/w/scripts/x.sh', 'script'), w('/w/deploy/x.sh', 'cp', { from: '/w/scripts/x.sh' })], PLACE, DEFAULTS)
    expect(v.refuse.map(x => x.path)).toEqual(['/w/scripts/x.sh'])
    expect(v.skipped.map(s => s.why)).toEqual(['copy'])
    const kept = judge([w('/w/deploy/x.sh', 'cp', { from: '/tmp/x.sh' })], PLACE, DEFAULTS)
    expect(kept.refuse).toHaveLength(1)
  })
})

describe('messages', () => {
  test('the refusal names the files and the tools, and never sends Claude to the person', () => {
    const text = denyReason([w('/w/src/a.ts', 'sed -i'), w('/w/README.md')], ['/w'])
    expect(text).toContain('src/a.ts and README.md')
    expect(text).toContain('sed -i, a redirection')
    expect(text).toContain('Edit tool')
    expect(text).toContain('Write for a new file')
    expect(text).toContain('/rewind')
    expect(text).not.toMatch(/ask (the )?(user|person|human)/i)
  })

  test('long lists are cut', () => {
    expect(listFiles([w('/w/a'), w('/w/b'), w('/w/c'), w('/w/d'), w('/w/e')], ['/w'])).toBe('a, b, c and 2 more')
    expect(listFiles([w('/etc/x')], ['/w'])).toBe('/etc/x')
    expect(listFiles([w(null)], ['/w'])).toBe('$X')
  })

  test('the warning says what was lost, and claims no missing diff (NE-7)', () => {
    const note = warnNote([w('/w/a.ts', 'tee')], ['/w'])
    expect(note).toContain('a.ts through the shell (tee); /rewind cannot undo that')
    // Claude Code shows a diff of Bash edits in auto and bypass mode inside a git repository.
    expect(note).not.toContain('no diff')
  })

  test('a copy names its source, not a temporary file (NE-7)', () => {
    const text = denyReason([w('/w/conf/x', 'cp', { from: '/etc/x' })], ['/w'])
    expect(text).toContain('conf/x through the shell (a file copied over it from /etc/x)')
    expect(text).not.toContain('temporary')
    expect(denyReason([w('/w/f', 'mv')], ['/w'])).toContain('(a temporary file moved over it)')
  })

  test('files a pattern reaches are named by the command, not by `**` (NE-5)', () => {
    expect(listFiles([w('/w/**', 'sed -i', { target: 'files find lists under src' })], ['/w'])).toBe('files find lists under src')
    expect(listFiles([w('/w/src/*.ts', 'sed -i', { target: '$f' })], ['/w'])).toBe('src/*.ts')
  })

  test('a refusal that may leave an agent stuck says the same command runs again (NE-2)', () => {
    expect(denyReason([w('/w/a.ts')], ['/w'], true)).toContain('If you have no Edit or Write tool, run the same command again')
    expect(denyReason([w('/w/a.ts')], ['/w'])).not.toContain('run the same command again')
    expect(retryNote([w('/w/a.ts')], ['/w'])).toContain('run on the second try; it changed a.ts')
  })
})

describe('the Bash tool description (NE-6)', () => {
  const HEAD = 'Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not.'
  const FIRST = `${HEAD}\n\n# Instructions\n - Always quote file paths that contain spaces.`
  const CLASSIC = `${HEAD}\n\nIMPORTANT: Avoid using this tool to run sed or echo commands:\n\n - Edit files: Use Edit (NOT sed/awk)\n - Write files: Use Write (NOT echo >/cat <<EOF)\n\n# Instructions\n - x`

  test('a bash-first description gets the Edit and Write lines back, before # Instructions', () => {
    const r = withEditLines(FIRST)
    expect(r.added).toBe(true)
    expect(r.description).toStartWith(HEAD)
    expect(r.description).toContain(`${EDIT_LINES}\n\n# Instructions`)
    expect(r.description).toContain('NOT sed -i')
    expect(withEditLines(r.description), 'applied twice, added once').toEqual({ description: r.description, added: false })
  })

  test('a description that has them, or no # Instructions, is handled', () => {
    expect(withEditLines(CLASSIC)).toEqual({ description: CLASSIC, added: false })
    expect(withEditLines(HEAD).description).toBe(`${HEAD}\n\n${EDIT_LINES}`)
  })
})

describe('settings', () => {
  test('defaults and unknown values', () => {
    expect(settingsOf({})).toEqual({ mode: 'deny', scope: 'project', allow: DEFAULT_ALLOW.split(','), invalid: [], rewritePrompt: true })
    expect(settingsOf({ mode: 'ask', scope: 'x' }).mode).toBe('deny')
    expect(settingsOf({ mode: 'warn', scope: 'everywhere', allowPaths: ' a/** , ,b ', rewritePrompt: false })).toEqual({ mode: 'warn', scope: 'everywhere', allow: ['a/**', 'b'], invalid: [], rewritePrompt: false })
    expect(settingsOf({ allowPaths: '' }).allow).toEqual([])
  })

  test('an invalid glob is set aside, and the guard keeps working (NE-3)', () => {
    const s = settingsOf({ allowPaths: '[z-a],**/*.log,**/[b-a]*/**' })
    expect(s.allow).toEqual(['**/*.log'])
    expect(s.invalid).toEqual(['[z-a]', '**/[b-a]*/**'])
    expect(judge([w('/w/a.ts'), w('/w/x.log')], PLACE, s).refuse.map(x => x.path)).toEqual(['/w/a.ts'])
    // Even handed one directly, matching never throws.
    expect(() => judge([w('/w/a.ts')], PLACE, { scope: 'project', allow: ['[z-a]'] })).not.toThrow()
    expect(matchesGlob('/w/a.ts', '[z-a]')).toBe(false)
  })
})
