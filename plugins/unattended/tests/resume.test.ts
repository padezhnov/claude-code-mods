import { describe, expect, mock, test } from 'claude-code/testing'

import { MIN, SESSION, T0, typed, windowOf, worldOf } from './world'

const H = 60 * MIN
const GRACE = MIN

describe('auto-resume', () => {
  test('a usage limit with a known reset sends "continue" once, a minute after the reset', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, 2 * H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })

    await clock.advance(2 * H)
    expect(world.submits, 'not before the grace has passed').toEqual([])

    await clock.advance(GRACE)
    expect(world.submits).toEqual([{ text: 'continue', own: true }])
    expect(world.toasts.some(t => t.includes('Resuming at')), 'the person is told when').toBe(true)

    await clock.advance(10 * H)
    expect(world.submits.length, 'only once').toBe(1)
  })

  test('other API errors never resume', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'server_error' })
    await $.classic.StopFailure({ error: 'authentication_failed' })
    await clock.advance(24 * H)

    expect(world.submits).toEqual([])
  })

  test('typing anything cancels the pending resume', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(10 * MIN)
    await $.prompt.submit(typed('never mind, I am back'))
    await clock.advance(2 * H)

    expect(world.submits).toEqual([{ text: 'never mind, I am back', own: false }])
  })

  test('stops after maxResumes in a row, and a prompt from the person starts the count again', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION)
    for (let i = 0; i < 4; i++) {
      world.rateLimits = [windowOf('five_hour', 100, (i + 1) * 6 * H)]
      await $.classic.StopFailure({ error: 'rate_limit' })
      await clock.advance(6 * H + GRACE)
    }
    expect(world.submits.filter(s => s.own).length, 'three resumes, then it waits').toBe(3)
    expect(world.toasts.some(t => t.includes('Waiting for you'))).toBe(true)

    await $.prompt.submit(typed('go on'))
    world.rateLimits = [windowOf('five_hour', 100, 30 * H)]
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(30 * H)
    expect(world.submits.filter(s => s.own).length).toBe(4)
  })

  test('a weekly limit is not waited for unless asked', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 40, H), windowOf('seven_day', 100, 50 * H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(60 * H)

    expect(world.submits).toEqual([])
    expect(world.toasts.some(t => t.includes('seven_day'))).toBe(true)
  })

  test('with five_hour+seven_day it waits for the weekly reset too', { options: { resumeWindows: 'five_hour+seven_day' } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('seven_day', 100, 50 * H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(50 * H + GRACE)

    expect(world.submits).toEqual([{ text: 'continue', own: true }])
  })

  test('no reset time reported: retries after fallbackMinutes; 0 turns that off', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(14 * MIN)
    expect(world.submits).toEqual([])
    await clock.advance(MIN)
    expect(world.submits).toEqual([{ text: 'continue', own: true }])
  })

  test('fallbackMinutes 0: nothing without a reset time', { options: { fallbackMinutes: 0 } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(24 * H)
    expect(world.submits).toEqual([])
  })

  test('autoResume off: nothing at all', { options: { autoResume: false } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(2 * H)
    expect(world.submits).toEqual([])
  })

  test('a custom prompt is sent as written', { options: { resumePrompt: 'Continue where you stopped; re-run the failing test first.' } }, async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, H)]

    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(H + GRACE)
    expect(world.submits).toEqual([{ text: 'Continue where you stopped; re-run the failing test first.', own: true }])
  })

  test('/auto-resume status, now and cancel', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, H)]

    await $.session.start(SESSION)
    expect(world.commands.sort()).toEqual(['auto-resume', 'loop-breaker'])

    const idle = await $.command.run({ command: 'auto-resume', args: '' } as never)
    expect(idle.text).toContain('Nothing is pending')

    await $.classic.StopFailure({ error: 'rate_limit' })
    const status = await $.command.run({ command: 'auto-resume', args: 'status' } as never)
    expect(status.text).toContain('Pending: "continue"')
    expect(status.text).toContain('five_hour 100%')

    await $.command.run({ command: 'auto-resume', args: 'now' } as never)
    await clock.settle()
    expect(world.submits).toEqual([{ text: 'continue', own: true }])

    await $.classic.StopFailure({ error: 'rate_limit' })
    const cancelled = await $.command.run({ command: 'auto-resume', args: 'cancel' } as never)
    expect(cancelled.text).toContain('cancelled')
    await clock.advance(3 * H)
    expect(world.submits.length).toBe(1)
  })

  test('the session measurement is the fallback when usage() reports no windows', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })

    await $.session.start(SESSION)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [windowOf('five_hour', 100, H)], changed: ['rateLimits'] })
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(H + GRACE)
    expect(world.submits).toEqual([{ text: 'continue', own: true }])
  })
})
