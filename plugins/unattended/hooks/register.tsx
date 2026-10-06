import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { BlockedCall, PendingResume } from '../types'
import { clockLabel, durationLabel, errorSignature, keyOf, planResume } from './keys'
import type { Window } from './keys'

const NAME = 'unattended'
const GRACE_MS = 60_000
const MAX_TRACKED = 500

const pending = atom({ plugin: 'unattended', key: 'pending' } as const, null as PendingResume | null)
const resumes = atom({ plugin: 'unattended', key: 'resumes' } as const, 0)
const blocked = atom({ plugin: 'unattended', key: 'blocked' } as const, null as BlockedCall | null)

type Settings = {
  autoResume: boolean
  resumePrompt: string
  windows: readonly string[]
  maxResumes: number
  fallbackMs: number
  loopMode: 'stop' | 'warn' | 'off'
  threshold: number
}

const numberOf = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

export function settingsOf(options: PluginOptions): Settings {
  const prompt = typeof options.resumePrompt === 'string' ? options.resumePrompt.trim() : ''
  const mode = options.loopBreaker
  return {
    autoResume: options.autoResume !== false,
    resumePrompt: prompt === '' ? 'continue' : prompt,
    windows: options.resumeWindows === 'five_hour+seven_day' ? ['five_hour', 'seven_day'] : ['five_hour'],
    maxResumes: numberOf(options.maxResumes, 3, 0, 50),
    fallbackMs: numberOf(options.fallbackMinutes, 15, 0, 24 * 60) * 60_000,
    loopMode: mode === 'warn' || mode === 'off' ? mode : 'stop',
    threshold: numberOf(options.loopThreshold, 3, 2, 20),
  }
}

type Failure = { signature: string; count: number; label: string }

// Module values are lost on a reload; `pending` lives in $.state and the
// timer is re-armed from it in session.start.
let settings: Settings = settingsOf({})
let timer: Timer | undefined
let lastWindows: readonly Window[] = []
const failures = new Map<string, Failure>()

// ---------------------------------------------------------------- resume

function showStatus($: EngineInterface, p: PendingResume | null) {
  $.ui.status(p === null ? undefined : `auto-resume ${clockLabel(p.at)}`)
}

async function disarm($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, pending, () => null)
  showStatus($, null)
}

async function fire($: EngineInterface) {
  timer = undefined
  const due = await read($, pending)
  if (due === null) return

  await update($, pending, () => null)
  await update($, resumes, n => n + 1)
  showStatus($, null)
  await $.prompt.submit({ text: settings.resumePrompt, asUser: true })
}

async function arm($: EngineInterface, p: PendingResume) {
  timer?.cancel()
  await update($, pending, () => p)
  showStatus($, p)
  const now = await $.clock.now()
  timer = $.clock.after(Math.max(0, p.at - now), () => void fire($))
}

async function windowsNow($: EngineInterface): Promise<readonly Window[]> {
  try {
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) return usage.rateLimits
  } catch {
    // Hosts without a usage ledger: fall back to the last measurement.
  }
  return lastWindows
}

async function onUsageLimit($: EngineInterface) {
  const done = await read($, resumes)
  if (done >= settings.maxResumes) {
    $.ui.toast(`${NAME}: usage limit again after ${done} auto-resumes. Waiting for you now.`, { timeoutMs: 10_000 })
    await disarm($)
    return
  }

  const now = await $.clock.now()
  const plan = planResume(await windowsNow($), settings.windows, now, GRACE_MS, settings.fallbackMs)

  if (plan.kind === 'skip') {
    $.ui.toast(`${NAME}: the ${plan.window} limit ran out. Not waiting for it (see the resumeWindows setting).`, { timeoutMs: 10_000 })
    return
  }
  if (plan.kind === 'none') return

  await arm($, { at: plan.at, window: plan.window })
  $.ui.toast(`${NAME}: usage limit. Resuming at ${clockLabel(plan.at)} (in ${durationLabel(plan.at - now)}). Type anything to cancel.`, { timeoutMs: 8_000 })
}


export const register: Register = (on, options) => {
  settings = settingsOf(options)
  timer = undefined
  lastWindows = []
  failures.clear()

  // ------------------------------------------------------------- sessions

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'auto-resume',
      description: 'Auto-resume after a usage limit: show, run now, or cancel the pending resume',
      argumentHint: '[status|now|cancel]',
      immediate: true,
    })
    await $.command.register({
      name: 'loop-breaker',
      description: 'Loop breaker: show repeated failures, or forget them',
      argumentHint: '[status|reset]',
      immediate: true,
    })

    // A reload (or a resumed session) keeps $.state but drops timers.
    const p = await read($, pending)
    if (p !== null && settings.autoResume) await arm($, p)
    else if (p !== null) await disarm($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    lastWindows = e.rateLimits
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (settings.autoResume && e.error === 'rate_limit') await onUsageLimit($)
    return result
  })

  // Anything that is not this plugin's own resume counts as the person being
  // back: drop the pending resume, the resume streak and the loop counts.
  on('prompt.submit', async ($, e, next) => {
    const own = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    if (!own) {
      if (timer !== undefined || (await read($, pending)) !== null) await disarm($)
      await update($, resumes, () => 0)
      failures.clear()
      await update($, blocked, () => null)
    }
    return next(e)
  })

  // ---------------------------------------------------------- loop breaker

  if (settings.loopMode !== 'off') {
    const stopAt = settings.threshold - 1

    on('tool.call', async ($, e, next) => {
      const { key, label } = keyOf(e as unknown as Record<string, unknown>)
      const before = failures.get(key)

      if (settings.loopMode === 'stop' && before !== undefined && before.count >= stopAt) {
        await update($, blocked, () => ({ label, failures: before.count }))
        $.ui.toast(`${NAME}: stopped a loop: ${label} (failed ${before.count}× the same way)`)
        return {
          deny:
            `${NAME} loop breaker: this exact call already failed ${before.count} times in a row with the same error, ` +
            `so it was not run again. Read the whole error, check the assumptions behind the call ` +
            `(paths, names, versions, working directory), then try a different approach or ask the user. ` +
            `Call: ${label}`,
        }
      }

      const ran = await next(e)
      if (ran.deny !== undefined) return ran

      if (ran.isError !== true) {
        // A call that changed something (an edit, a build, an install) means
        // the next retry may well succeed: start every count again. Reads
        // (ls, cat, grep) change nothing, so a loop of read-and-retry still counts.
        if (ran.isReadOnly === true) failures.delete(key)
        else failures.clear()
        return ran
      }

      const signature = errorSignature(ran.text)
      const count = before !== undefined && before.signature === signature ? before.count + 1 : 1
      failures.delete(key)
      failures.set(key, { signature, count, label })
      if (failures.size > MAX_TRACKED) failures.delete(failures.keys().next().value as string)

      if (count < stopAt) return ran

      const note =
        settings.loopMode === 'stop'
          ? `${NAME}: this call has now failed ${count} times in a row with the same error. ` +
            `Repeating it unchanged will be refused. Change the approach instead.`
          : `${NAME}: this call has now failed ${count} times in a row with the same error. ` +
            `Repeating it unchanged is unlikely to help.`
      if (settings.loopMode === 'warn' && count >= settings.threshold) {
        $.ui.status(`loop: ${label} ×${count}`)
      }
      return { ...ran, context: [...(ran.context ?? []), note] }
    })
  }

  // -------------------------------------------------------------- the band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, pending)
    const b = await read($, blocked)
    if (e.props.hasSurvey || (p === null && b === null)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const done = await read($, resumes)

    return (
      <Box flexDirection="column">
        {p !== null && (
          <Box>
            <Text dimColor>
              {`Usage limit${p.window === 'unknown' ? '' : ` (${p.window.replace('_', '-')})`}: resuming at ${clockLabel(p.at)}, in ${durationLabel(p.at - now)}` +
                (settings.maxResumes > 1 ? ` · ${done + 1}/${settings.maxResumes} ` : ' ')}
            </Text>
            <Button key="resume-cancel" label="Cancel" onPress={() => disarm($)} />
          </Box>
        )}
        {b !== null && (
          <Box>
            <Text dimColor>{`Loop stopped: ${b.label} failed ${b.failures}× the same way `}</Text>
            <Button key="loop-dismiss" label="Dismiss" onPress={() => update($, blocked, () => null)} />
          </Box>
        )}
      </Box>
    )
  })

  // ------------------------------------------------------------- commands

  on('command.run', { command: 'auto-resume' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const p = await read($, pending)

    if (arg === 'cancel') {
      if (p === null) return { text: 'Nothing is pending.' }
      await disarm($)
      return { text: 'Pending resume cancelled.' }
    }
    if (arg === 'now') {
      if (p === null) return { text: 'Nothing is pending.' }
      timer?.cancel()
      void fire($)
      return { text: `Sending "${settings.resumePrompt}" now.` }
    }

    const now = await $.clock.now()
    const windows = await windowsNow($)
    const lines = [
      settings.autoResume ? 'Auto-resume is on.' : 'Auto-resume is off (setting autoResume).',
      p === null
        ? 'Nothing is pending.'
        : `Pending: "${settings.resumePrompt}" at ${clockLabel(p.at)} (in ${durationLabel(p.at - now)}), window ${p.window}.`,
      `Resumes in a row: ${await read($, resumes)} of ${settings.maxResumes}. Waits for: ${settings.windows.join(', ')}.`,
      windows.length === 0
        ? 'No usage windows reported yet (none appear on API keys).'
        : `Windows: ${windows.map(w => `${w.kind} ${w.percentUsed}%${w.resetsAt ? `, resets ${clockLabel(Date.parse(w.resetsAt))}` : ''}`).join('; ')}.`,
    ]
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'loop-breaker' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      failures.clear()
      await update($, blocked, () => null)
      return { text: 'Loop breaker counts cleared.' }
    }
    const repeating = [...failures.values()].filter(f => f.count > 1).sort((a, b) => b.count - a.count).slice(0, 5)
    const head =
      settings.loopMode === 'off'
        ? 'Loop breaker is off (setting loopBreaker).'
        : `Loop breaker: ${settings.loopMode}, refuses attempt ${settings.threshold} of the same failing call.`
    return {
      text: [head, ...(repeating.length === 0 ? ['No call is failing repeatedly.'] : repeating.map(f => `  ${f.count}× ${f.label}`))].join('\n'),
    }
  })
}
