import { describe, expect, test } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

import { DEFAULT_PHRASES, settingsOf } from '../hooks/register'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/w' }

function worldOf(on: On, files: Record<string, string> = {}, reads: string[] = []) {
  const store = new Map<string, unknown>()
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store.get(e.key) as never }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    return e.path in files ? ({ value: files[e.path] } as never) : ({ deny: 'ENOENT' } as never)
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return store
}

const NARRATING = 'const a = get()\n// Added a null check as requested\nif (!a) return'
const CAPTIONED = '// Get it\nconst a = get()\n// Check it\ncheck(a)\n// Return it\nreturn a'
const edit = (new_string: string, file_path = '/w/a.ts', agentId?: string) => ({ tool: 'Edit', file_path, old_string: 'x', new_string, ...(agentId ? { agentId } : {}) }) as const

describe('anti-slop', () => {
  test('a narrating comment gets a note for the model; the edit itself runs untouched', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(edit(NARRATING))
    expect(r.text).toBe('ok')
    expect(r.context?.[0]).toContain('anti-slop: this edit to /w/a.ts added comment lines that tell the history of the edit')
    expect(r.context?.[0]).toContain('"// Added a null check as requested"')
    expect(r.context?.[0], 'narrow: rephrase those lines, keep the rest').toContain('Leave the other comments as they are')
    expect(r.context?.[0]).not.toContain('Remove comments')
  })

  test('by default, captioned code and clean edits get nothing', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect((await $.tool.call(edit(CAPTIONED))).context).toBe(undefined)
    expect((await $.tool.call(edit('const a = get()\ncheck(a)'))).context).toBe(undefined)
  })

  test('comments=density also notes captioned code', { options: { comments: 'density' } }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.tool.call(edit(CAPTIONED))
    expect(r.context?.[0]).toContain('added 3 one-line comments captioning 3 lines of code')
    expect(r.context?.[0]).toContain('Remove comments that restate the code')
  })

  test('scratch files are not judged', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect((await $.tool.call(edit(NARRATING, '/tmp/x/cart.js'))).context).toBe(undefined)
  })

  test('Write of a prose or scratch file does not read the old file', async ($, on) => {
    const reads: string[] = []
    worldOf(on, {}, reads)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Write', file_path: '/w/data.json', content: '{}' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/x/a.ts', content: NARRATING })
    expect(reads).toEqual([])
    await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: NARRATING })
    expect(reads).toEqual(['/w/a.ts'])
  })

  test('Write compares against the file as it was', async ($, on) => {
    worldOf(on, { '/w/a.ts': NARRATING })
    await $.session.start(SESSION)
    const r = await $.tool.call({ tool: 'Write', file_path: '/w/a.ts', content: `${NARRATING}\nlog(a)` })
    expect(r.context, 'the comment was already there').toBe(undefined)
  })

  test('one note per file per agent, three per session', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect((await $.tool.call(edit(NARRATING, '/w/a.ts'))).context).toHaveLength(1)
    expect((await $.tool.call(edit(NARRATING, '/w/a.ts'))).context, 'same file again').toBe(undefined)
    expect((await $.tool.call(edit(NARRATING, '/w/a.ts', 'sub-1'))).context, 'a subagent editing it').toHaveLength(1)
    expect((await $.tool.call(edit(NARRATING, '/w/b.ts'))).context).toHaveLength(1)
    expect((await $.tool.call(edit(NARRATING, '/w/c.ts'))).context, 'fourth note in the session').toBe(undefined)
    await $.session.start(SESSION)
    expect((await $.tool.call(edit(NARRATING, '/w/c.ts'))).context, 'a new session starts over').toHaveLength(1)
  })

  test('/clear (session.end, no session.start) starts the caps and the session count over', async ($, on) => {
    worldOf(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await $.session.start(SESSION)
    for (const f of ['a', 'b', 'c']) await $.tool.call(edit(NARRATING, `/w/${f}.ts`))
    expect((await $.tool.call(edit(NARRATING, '/w/d.ts'))).context, 'capped').toBe(undefined)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect((await $.tool.call(edit(NARRATING, '/w/a.ts'))).context, 'after /clear').toHaveLength(1)
    const r = await $.command.run({ command: 'anti-slop', args: '' } as never)
    expect(r.text).toContain('This session: 1 comment notes, 0 phrases rewritten.')
  })

  test('comments=off: no notes', { options: { comments: 'off' } }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect((await $.tool.call(edit(NARRATING))).context).toBe(undefined)
  })

  test('the style section is added to the system prompt, after the engine\'s own', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(r.sections.map(s => s.id)).toEqual(['intro', 'anti-slop:style'])
    expect(r.sections[1]?.text).toContain('"load-bearing"')
    expect(r.sections[1]?.text).toContain('"Ты прав"')
    expect(r.sections[1]?.scope).toBe('session')
  })

  test('/anti-slop reports this session and the approximate machine-wide count', async ($, on) => {
    const store = worldOf(on)
    store.set('stats', { nudges: 5, rewrites: 4, phrases: { 'Хороший вопрос': 3, "You're absolutely right": 1 } })
    await $.session.start(SESSION)
    await $.tool.call(edit(NARRATING))
    const r = await $.command.run({ command: 'anti-slop', args: '' } as never)
    expect(r.text).toContain('This session: 1 comment notes, 0 phrases rewritten.')
    expect(r.text).toContain('All sessions on this machine (approximate): 6 comment notes, 4 phrases rewritten ("Хороший вопрос" 3, "You\'re absolutely right" 1).')
    expect(r.text).toContain('narrating comments only; at most 1 per file and 3 per session')
  })

  test('/anti-slop: a total from 0.1 that has no phrase is shown as such', async ($, on) => {
    const store = worldOf(on)
    store.set('stats', { nudges: 0, rewrites: 3, phrases: { 'Хороший вопрос': 2 } })
    await $.session.start(SESSION)
    const r = await $.command.run({ command: 'anti-slop', args: '' } as never)
    expect(r.text).toContain('0 comment notes, 3 phrases rewritten ("Хороший вопрос" 2, 1 before 0.2).')
  })

  test('/anti-slop reads the 0.1 stats record', async ($, on) => {
    const store = worldOf(on)
    store.set('stats', { nudges: 2, rewrites: 1 })
    await $.session.start(SESSION)
    const r = await $.command.run({ command: 'anti-slop', args: '' } as never)
    expect(r.text).toContain('All sessions on this machine (approximate): 2 comment notes, 1 phrases rewritten.')
  })
})

describe('settings', () => {
  test('defaults: narration only; openers dropped, the rest only avoided', () => {
    const s = settingsOf({})
    expect(s.comments).toBe('narration')
    expect(s.rules).toEqual({ density: false, minComments: 3, ratio: 0.3, beforeNow: false })
    expect(s.replace.map(r => r.phrase)).toEqual(['Хороший вопрос', 'Отличный вопрос', "You're absolutely right", 'You are absolutely right'])
    expect(s.avoid).toContain('load-bearing')
    expect(s.replace.every(r => r.with === '')).toBe(true)
    expect(DEFAULT_PHRASES).toContain('Вы правы')
  })

  test('0.1\'s "nudge" maps to narration; density, beforeNow and the numbers are read', () => {
    expect(settingsOf({ comments: 'nudge' }).comments).toBe('narration')
    const s = settingsOf({ comments: 'density', minComments: 4.4, commentPercent: 250, beforeNow: true })
    expect(s.rules).toEqual({ density: true, minComments: 4, ratio: 1, beforeNow: true })
  })
})
