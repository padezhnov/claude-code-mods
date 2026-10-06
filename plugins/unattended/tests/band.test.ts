import { describe, expect, mock, test } from 'claude-code/testing'
import type { RenderInput } from 'claude-code'

import { MIN, SESSION, T0, windowOf, worldOf } from './world'

const PLUGIN = 'unattended'
const SURFACES = ['terminal', 'desktop'] as const

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}

describe('the band above the prompt', () => {
  test('nothing pending, nothing drawn: the engine keeps its own band', async ($, on) => {
    worldOf(on)
    mock.clock(on, { now: T0 })
    on('ui.render', () => ({ type: 'Text', children: ['engine'] }))
    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, plugin: PLUGIN })
      expect(await ui.find({ type: 'Text', text: /Usage limit|Loop stopped/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a pending resume shows when, and Cancel cancels it', async ($, on) => {
    const world = worldOf(on)
    const clock = mock.clock(on, { now: T0 })
    world.rateLimits = [windowOf('five_hour', 100, 102 * MIN - MIN)]
    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'rate_limit' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, plugin: PLUGIN })
      expect(await ui.find({ type: 'Text', text: /resuming at .*in 1h 42m/ })).toBeDefined()
      if (surface === 'desktop') await ui.press({ key: 'resume-cancel' })
      await ui.unmount()
    }

    await clock.advance(3 * 60 * MIN)
    expect(world.submits).toEqual([])
  })

  test('a stopped loop shows until dismissed', async ($, on) => {
    const world = worldOf(on)
    mock.clock(on, { now: T0 })
    on('ui.render', () => ({ type: 'Text', children: ['engine'] }))
    world.toolOutcome = () => ({ isError: true, text: 'boom' })
    await $.session.start(SESSION)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'make' })

    const ui = await $.ui.mount({ ...BAND, plugin: PLUGIN })
    expect(await ui.find({ type: 'Text', text: /Loop stopped: make failed 2×/ })).toBeDefined()
    await ui.press({ key: 'loop-dismiss' })
    await ui.unmount()

    const after = await $.ui.mount({ ...BAND, plugin: PLUGIN })
    expect(await after.find({ type: 'Text', text: /Loop stopped/ })).toBeUndefined()
    await after.unmount()
  })
})
