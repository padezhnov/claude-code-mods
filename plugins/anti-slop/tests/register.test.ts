import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/w' }

function worldOf(on: On, files: Record<string, string> = {}) {
  const store = new Map<string, unknown>()
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store.get(e.key) as never }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (e.path in files ? ({ value: files[e.path] } as never) : ({ deny: 'ENOENT' } as never)))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return store
}

const edit = (new_string: string, old_string = 'x') => ({ tool: 'Edit', file_path: '/w/a.ts', old_string, new_string }) as const
const NOISY = '// Get it\nconst a = get()\n// Check it\ncheck(a)\n// Return it\nreturn a'

describe('anti-slop', () => {
  test('a comment-heavy edit gets a note for the model; the edit itself runs untouched', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(edit(NOISY))
    expect(r.text).toBe('ok')
    expect(r.context?.[0]).toContain('anti-slop: this edit to /w/a.ts added 3 comment lines out of 6 new lines')
  })

  test('a clean edit gets nothing', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(edit('const a = get()\ncheck(a)'))
    expect(r.context).toBe(undefined)
  })

  test('Write compares against the file as it was', async ($, on) => {
    worldOf(on, { '/w/a.ts': NOISY })
    await $.session.start(SESSION)
    const r = await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: `${NOISY}\nlog(a)` })
    expect(r.context, 'the comments were already there').toBe(undefined)
  })

  test('comments=off: no notes', { options: { comments: 'off' } }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(edit(NOISY))
    expect(r.context).toBe(undefined)
  })

  test('the style section is added to the system prompt, after the engine\'s own', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(r.sections.map(s => s.id)).toEqual(['intro', 'anti-slop:style'])
    expect(r.sections[1]?.text).toContain('"load-bearing"')
    expect(r.sections[1]?.scope).toBe('session')
  })

  test('/anti-slop reports what it caught', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call(edit(NOISY))
    const r = await $.command.run({ command: 'anti-slop', args: '' } as never)
    expect(r.text).toContain('Comment nudges: 1')
  })
})
