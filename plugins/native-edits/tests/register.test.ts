import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/w' }
const STRICT =
  'Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.'
const AUTO_MODE = `## Auto Mode Active\n\nBias toward working without stopping.\n\n${STRICT}`

type World = { runs: string[]; store: Map<string, unknown>; cwd: string; root: string; tools: string[]; fail: boolean; agents: (string | undefined)[] }

function worldOf(on: On): World {
  const world: World = { runs: [], store: new Map(), cwd: '/w', root: '/w', tools: ['Bash', 'Read', 'Edit', 'Write'], fail: false, agents: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.root', () => ({ value: world.root }))
  on('session.id', () => ({ value: 'session-1' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : e.name === 'TMPDIR' ? '/var/folders/xy/T' : undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: world.store.get(e.key) as never }))
  on('store.set', ($, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: world.tools.map(name => ({ name, description: name, mcp: false })) }))
  on('tool.call', ($, e) => {
    world.runs.push(e.tool === 'Bash' ? (e as { command: string }).command : e.tool)
    world.agents.push(e.agentId)
    if (world.fail) return { isError: true, result: 'exit 1', text: 'exit 1' } as never
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  return world
}

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const BASH_FIRST = 'Executes a given bash command and returns its output.\n\nThe working directory persists between commands.\n\n# Instructions\n - Quote paths.'

const bash = (command: string) => ({ tool: 'Bash', command }) as const
const refusal = (r: { deny?: string; text?: string }) => r.deny ?? r.text ?? ''

describe('native-edits: the guard', () => {
  test('sed -i on a project file is refused, with the file and the way forward; nothing runs', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/old/new/' src/app.ts"))
    expect(world.runs).toEqual([])
    expect(refusal(r)).toContain('native-edits: not run')
    expect(refusal(r)).toContain('src/app.ts')
    expect(refusal(r)).toContain('Edit tool')
  })

  test('a heredoc into a new project file is refused too', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("cat > docs/notes.md <<'EOF'\n# Notes\nEOF"))
    expect(world.runs).toEqual([])
    expect(refusal(r)).toContain('docs/notes.md')
  })

  test('reading, searching, scratch files, logs, build output and other machines all run', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const allowed = [
      'cat src/app.ts',
      "sed -n '1,40p' src/app.ts",
      "grep -rn 'TODO' src | head",
      "cat > /tmp/probe.py <<'EOF'\nprint(1)\nEOF",
      "echo '{}' > /var/folders/xy/T/x.json",
      'npm run build 2>&1 > build.log',
      "echo 'x' > dist/stamp.txt",
      'git diff > changes.patch',
      "ssh prod \"sed -i 's/a/b/' /etc/app.conf\"",
      "sudo sed -i 's/a/b/' /etc/hosts",
    ]
    for (const c of allowed) await $.tool.call(bash(c))
    expect(world.runs).toEqual(allowed)
  })

  test('relative paths follow the shell\'s directory; the project is the root and that directory', async ($, on) => {
    const world = worldOf(on)
    world.cwd = '/w/packages/api'
    await $.session.start(SESSION)
    const r = await $.tool.call(bash('echo "export const x = 1" >> src/index.ts'))
    expect(refusal(r)).toContain('packages/api/src/index.ts')
  })

  test('scope everywhere also refuses files outside the project', { options: { scope: 'everywhere' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sudo sed -i 's/a/b/' /etc/hosts"))
    expect(world.runs).toEqual([])
    expect(refusal(r)).toContain('/etc/hosts')
    await $.tool.call(bash('echo a > /tmp/x'))
    expect(world.runs).toEqual(['echo a > /tmp/x'])
  })

  test('allowPaths replaces the default list', { options: { allowPaths: 'docs/**' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call(bash('echo a >> docs/log.md'))
    const r = await $.tool.call(bash('echo a > build.log'))
    expect(world.runs).toEqual(['echo a >> docs/log.md'])
    expect(refusal(r)).toContain('build.log')
  })

  test('warn runs the command and tells the model afterwards', { options: { mode: 'warn' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toEqual(["sed -i 's/a/b/' src/app.ts"])
    expect(r.text).toBe('ok')
    expect(r.context?.[0]).toContain('native-edits: this command changed src/app.ts through the shell (sed -i)')
  })

  test('warn does not point Claude to Edit when it has no Edit or Write (NE-2)', { options: { mode: 'warn' } }, async ($, on) => {
    const world = worldOf(on)
    world.tools = ['Bash']
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toHaveLength(1)
    expect(r.context ?? []).toEqual([])
  })

  test('warn says nothing about a change when the command failed (NE-7)', { options: { mode: 'warn' } }, async ($, on) => {
    const world = worldOf(on)
    world.fail = true
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toHaveLength(1)
    expect(r.isError).toBe(true)
    expect(r.context ?? []).toEqual([])
    const status = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(status.text).toContain('Warned: 0 this session')
  })

  test('without Edit and Write the write runs: a refusal would leave no way to make the change (NE-2)', async ($, on) => {
    const world = worldOf(on)
    world.tools = ['Bash', 'Read']
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/red/blue/' file.txt"))
    expect(world.runs).toEqual(["sed -i 's/red/blue/' file.txt"])
    expect(refusal(r)).toBe('ok')
    const status = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(status.text).toContain('Let through because Claude had no Edit or Write tool: 1 this session')
    world.tools = ['Bash', 'Read', 'Write']
    const again = await $.tool.call(bash("sed -i 's/red/blue/' file.txt"))
    expect(refusal(again), 'Write alone is a way forward').toContain('native-edits: not run')
  })

  test("a subagent, whose tools are not known, is refused once per file, then the same write runs (NE-2)", async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const sub = (command: string) => ({ tool: 'Bash', command, agentId: 'agent-7' }) as const
    const first = await $.tool.call(sub("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toEqual([])
    expect(refusal(first)).toContain('If you have no Edit or Write tool, run the same command again')
    const second = await $.tool.call(sub("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toEqual(["sed -i 's/a/b/' src/app.ts"])
    expect(world.agents).toEqual(['agent-7'])
    expect(second.context?.[0]).toContain('native-edits: run on the second try')
    const other = await $.tool.call(sub("sed -i 's/a/b/' src/other.ts"))
    expect(refusal(other), 'another file is refused again').toContain('native-edits: not run')
    // The main loop, which has Edit, is refused every time and gets no hint to retry.
    const main = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(refusal(main)).toContain('native-edits: not run')
    expect(refusal(main)).not.toContain('run the same command again')
  })

  test('an invalid allowPaths glob is set aside and named; the guard still refuses (NE-3)', { options: { allowPaths: '[z-a],**/*.log' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(refusal(r)).toContain('native-edits: not run')
    await $.tool.call(bash('echo a > out.log'))
    expect(world.runs).toEqual(['echo a > out.log'])
    const status = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(status.text).toContain('Ignored invalid allowPaths glob: [z-a].')
    expect(status.text).toContain('always allowed: **/*.log,')
  })

  test('a write to a scratch directory through a shell variable runs (NE-1)', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const cmd = "S=/tmp/claude-0/-root/s1/scratchpad; python3 - <<EOF\nopen('$S/probe.txt','w').write('hello')\nEOF"
    await $.tool.call(bash(cmd))
    expect(world.runs).toEqual([cmd])
  })

  test('off leaves every command alone', { options: { mode: 'off' } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    expect(world.runs).toHaveLength(1)
    expect(r.context).toBe(undefined)
  })

  test('other tools pass untouched', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: '/w/src/app.ts', old_string: 'a', new_string: 'b' })
    expect(world.runs).toEqual(['Edit'])
  })
})

describe('native-edits: the auto-mode note', () => {
  test('the engine\'s auto_mode attachment is rewritten: reading stays, changes go to Edit and Write', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.prompt.attachment({ type: 'auto_mode', text: AUTO_MODE, origin: { kind: 'engine' } })
    expect(r.text).toContain('read files with cat, head, or sed -n')
    expect(r.text).toContain('Make every file change with the Edit tool')
    expect(r.text).not.toContain('make file changes with sed')
    expect(r.text).toStartWith('## Auto Mode Active')
  })

  test('other attachments, and text a settings hook added, are left alone', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const todo = await $.prompt.attachment({ type: 'todo_reminder', text: STRICT, origin: { kind: 'engine' } })
    expect(todo.text).toBe(STRICT)
    const hooked = await $.prompt.attachment({ type: 'auto_mode', text: STRICT, origin: { kind: 'hook', event: 'SessionStart' } })
    expect(hooked.text).toBe(STRICT)
  })

  test('rewritePrompt off keeps the note as Claude Code wrote it', { options: { rewritePrompt: false } }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.prompt.attachment({ type: 'auto_mode', text: AUTO_MODE, origin: { kind: 'engine' } })
    expect(r.text).toBe(AUTO_MODE)
  })

  test("the Bash tool's description gets back the lines sending edits to Edit and Write (NE-6)", async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const first = await $.tool.describe({ tool: 'Bash', description: BASH_FIRST, provider: ENGINE })
    expect(first.description).toContain('change a file with Edit (NOT sed -i')
    expect(first.description).toContain('rewrite one with Write (NOT echo >, cat <<EOF or tee)')
    expect(first.description).toEndWith('# Instructions\n - Quote paths.')
    const status = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(status.text).toContain('Bash tool description: the lines sending edits to Edit and Write were missing and are added.')

    const classic = `${BASH_FIRST.replace('\n\n# Instructions', '\n\n - Edit files: Use Edit (NOT sed/awk)\n\n# Instructions')}`
    expect((await $.tool.describe({ tool: 'Bash', description: classic, provider: ENGINE })).description).toBe(classic)
    const read = 'Reads a file.'
    expect((await $.tool.describe({ tool: 'Read', description: read, provider: ENGINE })).description).toBe(read)
  })

  test('rewritePrompt off leaves the Bash description too', { options: { rewritePrompt: false } }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect((await $.tool.describe({ tool: 'Bash', description: BASH_FIRST, provider: ENGINE })).description).toBe(BASH_FIRST)
  })

  test('a build with other wording: the note is left as is', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const other = 'While auto mode is active:\n\nMake small file changes with sed or heredocs when it is simpler.'
    const r = await $.prompt.attachment({ type: 'auto_mode', text: other, origin: { kind: 'engine' } })
    expect(r.text).toBe(other)
    const status = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(status.text).toContain('not the one this version knows')
  })
})

describe('native-edits: /native-edits', () => {
  test('counts refusals and says whether the note was rewritten', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const before = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(before.text).toContain('Guard: deny, scope project')
    expect(before.text).toContain('Shell writes refused: 0 this session')
    expect(before.text).toContain('not seen in this session yet')

    await $.prompt.attachment({ type: 'auto_mode', text: AUTO_MODE, origin: { kind: 'engine' } })
    await $.tool.call(bash("sed -i 's/a/b/' src/app.ts"))
    await $.tool.call(bash('echo x >> .gitignore'))
    const after = await $.command.run({ command: 'native-edits', args: '' } as never)
    expect(after.text).toContain('Shell writes refused: 2 this session, 2 in all')
    expect(after.text).toContain('Auto-mode note: rewritten')
    expect(after.text).toContain('Last: .gitignore (redirect); src/app.ts (sed -i).')
  })
})
