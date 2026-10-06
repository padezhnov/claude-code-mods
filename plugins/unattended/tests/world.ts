import type { On, SessionRateLimit, SessionStartInput } from 'claude-code'

/** What the plugin asked the engine to do, recorded beneath it. */
export type World = {
  submits: { text: string; own: boolean }[]
  toasts: string[]
  statuses: (string | undefined)[]
  commands: string[]
  /** What `$.session.usage()` reports; tests change it as the limit moves. */
  rateLimits: SessionRateLimit[]
  /** How the next tool call ends beneath the plugin. */
  toolOutcome: (call: Record<string, unknown>) => { isError: boolean; text: string }
  runs: number
}

export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

/** 2026-10-06 10:00 UTC. */
export const T0 = Date.parse('2026-10-06T10:00:00Z')
export const MIN = 60_000

export function worldOf(on: On): World {
  const world: World = {
    submits: [],
    toasts: [],
    statuses: [],
    commands: [],
    rateLimits: [],
    toolOutcome: () => ({ isError: false, text: 'ok' }),
    runs: 0,
  }

  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 200_000 }, rateLimits: world.rateLimits },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  on('prompt.submit', ($, e) => {
    world.submits.push({ text: e.text, own: e.origin.kind === 'plugin' && e.origin.name === 'unattended' })
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    world.runs += 1
    const outcome = world.toolOutcome(e as unknown as Record<string, unknown>)
    return outcome.isError
      ? { isError: true, result: outcome.text, text: outcome.text }
      : ({ result: outcome.text, text: outcome.text } as never)
  })

  return world
}

/** A subscription window, used up or not, resetting `inMs` after T0. */
export const windowOf = (kind: string, percentUsed: number, inMs: number): SessionRateLimit => ({
  kind,
  percentUsed,
  resetsAt: new Date(T0 + inMs).toISOString(),
})

/** A prompt the person typed at the terminal. */
export const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
