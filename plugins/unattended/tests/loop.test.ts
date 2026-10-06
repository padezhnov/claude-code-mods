import { describe, expect, mock, test } from 'claude-code/testing'

import { MIN, SESSION, T0, typed, windowOf, worldOf } from './world'

const bash = (command: string) => ({ tool: 'Bash', command }) as const
const failing = (text: string) => () => ({ isError: true, text })

describe('loop breaker', () => {
  test('the third identical failing call is refused without running', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('Error: Cannot find module "./config" at 2026-10-06T10:00:00Z')

    await $.session.start(SESSION)
    const first = await $.tool.call(bash('node app.js'))
    const second = await $.tool.call(bash('node  app.js'))
    const third = await $.tool.call(bash('node app.js'))

    expect(world.runs, 'the third never ran').toBe(2)
    expect(first.isError, 'first failed').toBe(true)
    expect(second.context, 'warned one step early').toEqual([expect.stringContaining('will be refused')])
    expect(third.deny ?? third.text, 'third refused, with the reason').toContain('loop breaker')
    expect(world.toasts.some(t => t.includes('stopped a loop'))).toBe(true)
  })

  test('repeated successes are never counted', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    for (let i = 0; i < 6; i++) await $.tool.call(bash('git status'))
    expect(world.runs).toBe(6)
  })

  test('a change in between (an edit that worked) makes the next retry legitimate', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = call => (call.tool === 'Edit' ? { isError: false, text: 'ok' } : { isError: true, text: 'tests failed: 3' })

    await $.session.start(SESSION)
    await $.tool.call(bash('npm test'))
    await $.tool.call(bash('npm test'))
    await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call(bash('npm test'))
    expect(world.runs, 'the test run after the fix ran').toBe(4)
  })

  test('nothing changed in between: the third run is refused even if it might pass', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = () => ({ isError: true, text: 'tests failed: 3' })

    await $.session.start(SESSION)
    for (let i = 0; i < 3; i++) await $.tool.call(bash('npm test'))
    expect(world.runs).toBe(2)
  })

  test('a different error is progress, not a loop', async ($, on) => {
    const world = worldOf(on)
    const errors = ['ENOENT: no such file', 'EACCES: permission denied', 'SyntaxError: unexpected token']
    world.toolOutcome = () => ({ isError: true, text: errors[world.runs - 1] ?? 'other' })

    await $.session.start(SESSION)
    for (let i = 0; i < 3; i++) await $.tool.call(bash('./deploy.sh'))
    expect(world.runs).toBe(3)
  })

  test('a prompt from the person forgets the counts', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('boom')

    await $.session.start(SESSION)
    await $.tool.call(bash('make'))
    await $.tool.call(bash('make'))
    await $.prompt.submit(typed('I fixed the Makefile, try again'))
    await $.tool.call(bash('make'))
    expect(world.runs).toBe(3)
  })

  test("the plugin's own resume does not forget them", async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.toolOutcome = failing('boom')
    world.rateLimits = [windowOf('five_hour', 100, 60 * MIN)]

    await $.session.start(SESSION)
    await $.tool.call(bash('make'))
    await $.tool.call(bash('make'))
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(62 * MIN)
    expect(world.submits).toEqual([{ text: 'continue', own: true }])

    await $.tool.call(bash('make'))
    expect(world.runs, 'still refused after the resume').toBe(2)
  })

  test('edits: the same failing edit is a loop, a different one is not', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('String to replace not found in file.')
    const edit = (n: string) => ({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'const a = 1', new_string: n }) as const

    await $.session.start(SESSION)
    await $.tool.call(edit('const a = 2'))
    await $.tool.call(edit('const a = 3'))
    await $.tool.call(edit('const a = 4'))
    expect(world.runs).toBe(3)
    await $.tool.call(edit('const a = 4'))
    await $.tool.call(edit('const a = 4'))
    expect(world.runs).toBe(4)
  })

  test('warn mode never refuses, it tells the model', { options: { loopBreaker: 'warn' } }, async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('boom')

    await $.session.start(SESSION)
    let last
    for (let i = 0; i < 5; i++) last = await $.tool.call(bash('make'))
    expect(world.runs).toBe(5)
    expect(last?.context?.some(c => c.includes('unlikely to help'))).toBe(true)
    expect(world.statuses.some(s => s?.startsWith('loop:'))).toBe(true)
  })

  test('off mode does nothing', { options: { loopBreaker: 'off' } }, async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('boom')
    await $.session.start(SESSION)
    for (let i = 0; i < 5; i++) await $.tool.call(bash('make'))
    expect(world.runs).toBe(5)
  })

  test('a higher threshold waits longer', { options: { loopThreshold: 5 } }, async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('boom')
    await $.session.start(SESSION)
    for (let i = 0; i < 6; i++) await $.tool.call(bash('make'))
    expect(world.runs).toBe(4)
  })

  test('/loop-breaker status and reset', async ($, on) => {
    const world = worldOf(on)
    world.toolOutcome = failing('boom')
    await $.session.start(SESSION)
    await $.tool.call(bash('make'))
    await $.tool.call(bash('make'))

    const status = await $.command.run({ command: 'loop-breaker', args: '' } as never)
    expect(status.text).toContain('2× make')

    await $.command.run({ command: 'loop-breaker', args: 'reset' } as never)
    await $.tool.call(bash('make'))
    expect(world.runs).toBe(3)
  })
})
