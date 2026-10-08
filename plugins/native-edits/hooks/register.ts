import type { EngineInterface, Register } from 'claude-code'

import { denyReason, judge, listFiles, mentionsShellEdits, retryNote, rewriteAutoMode, settingsOf, TEMP_DIRS, warnNote, withEditLines } from './policy'
import type { Settings } from './policy'
import { findWrites } from './shell'

const STATS = 'stats'
const NOTE = 'note'
const DESCRIBED = 'described'

type Stats = { refused: number; warned: number; passed: number; rewritten: number; recent: string[] }
type NoteState = 'rewritten' | 'unrecognized' | 'absent'
type Counter = 'refused' | 'warned' | 'passed' | 'rewritten'
/** Whether the loop that made a call has another way to change files: Edit or Write. */
type Reach = 'yes' | 'no' | 'unknown'

let settings: Settings = settingsOf({})
let env: { home: string | undefined; temp: string[] } | null = null
const session = { refused: 0, warned: 0, passed: 0 }
/** Refusals that may have left an agent without a way forward: the same write again runs. */
const refusedOnce = new Set<string>()

async function environment($: EngineInterface) {
  if (env === null) {
    const [home, tmp] = await Promise.all([$.env.get('HOME'), $.env.get('TMPDIR')])
    env = { home: home || undefined, temp: tmp ? [...TEMP_DIRS, tmp] : [...TEMP_DIRS] }
  }
  return env
}

async function stats($: EngineInterface): Promise<Stats> {
  return { refused: 0, warned: 0, passed: 0, rewritten: 0, recent: [], ...((await $.store.get(STATS)) as Partial<Stats> | undefined) }
}

async function count($: EngineInterface, key: Counter, recent?: string) {
  const s = await stats($)
  await $.store.set(STATS, { ...s, [key]: s[key] + 1, recent: recent === undefined ? s.recent : [...s.recent, recent].slice(-5) })
}

/**
 * The main loop's tools are known: without Edit and Write a refusal leaves it
 * no way to make the change. A subagent's are not (its type may lack them).
 */
async function editReach($: EngineInterface, agentId: string | undefined): Promise<Reach> {
  if (agentId !== undefined) return 'unknown'
  try {
    const names = (await $.tool.list()).map(t => t.name)
    return names.includes('Edit') || names.includes('Write') ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)
  env = null
  session.refused = 0
  session.warned = 0
  session.passed = 0
  refusedOnce.clear()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'native-edits', description: 'native-edits: shell writes refused or warned, and whether the auto-mode note was rewritten', immediate: true })
    return next(e)
  })

  // The cause: auto mode tells the model to make file changes with sed and heredocs.
  // Reading and searching through the shell stays; changes go to Edit and Write.
  if (settings.rewritePrompt) {
    on('prompt.attachment', { type: 'auto_mode' }, async ($, e, next) => {
      if (e.origin.kind !== 'engine') return next(e)
      const out = rewriteAutoMode(e.text, settings.mode)
      const state: NoteState = out.changed ? 'rewritten' : mentionsShellEdits(e.text) ? 'unrecognized' : 'absent'
      await $.store.set(NOTE, { session: await $.session.id(), state })
      if (out.changed) await count($, 'rewritten')
      return next(out.changed ? { ...e, text: out.text } : e)
    }).catch(($, e, next) => next(e))

    // In the same sessions the Bash tool's description loses its "Edit files: Use Edit" lines.
    on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
      const out = await next(e)
      const { description, added } = withEditLines(out.description)
      await $.store.set(DESCRIBED, { session: await $.session.id(), added })
      return added ? { ...out, description } : out
    }).catch(($, e, next) => next(e))
  }

  // The guard: a Bash command that writes a project file is refused (or noted).
  if (settings.mode !== 'off') {
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const [cwd, root, { home, temp }] = await Promise.all([$.session.cwd(), $.session.root(), environment($)])
      const writes = findWrites(e.command, { cwd, home })
      if (writes.length === 0) return next(e)
      const roots = [...new Set([root, cwd])]
      const { refuse } = judge(writes, { roots, temp }, settings)
      if (refuse.length === 0) return next(e)
      const summary = `${listFiles(refuse, roots)} (${[...new Set(refuse.map(w => w.via))].join(', ')})`
      const reach = await editReach($, e.agentId)
      if (reach === 'no') {
        session.passed++
        await count($, 'passed')
        return next(e)
      }
      if (settings.mode === 'deny') {
        const key = `${e.agentId ?? ''}\u0000${refuse.map(w => w.path ?? w.target).sort().join('\u0000')}`
        if (reach === 'unknown' && refusedOnce.has(key)) {
          const ran = await next(e)
          if (ran.deny !== undefined || ran.isError === true) return ran
          session.warned++
          await count($, 'warned', summary)
          return { ...ran, context: [...(ran.context ?? []), retryNote(refuse, roots)] }
        }
        if (reach === 'unknown') refusedOnce.add(key)
        session.refused++
        await count($, 'refused', summary)
        return { deny: denyReason(refuse, roots, reach === 'unknown') }
      }
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      session.warned++
      await count($, 'warned', summary)
      return { ...ran, context: [...(ran.context ?? []), warnNote(refuse, roots)] }
    }).catch(($, e, next) => next(e))
  }

  on('command.run', { command: 'native-edits' }, async $ => {
    const s = await stats($)
    const id = await $.session.id()
    const note = (await $.store.get(NOTE)) as { session?: string; state?: NoteState } | undefined
    const described = (await $.store.get(DESCRIBED)) as { session?: string; added?: boolean } | undefined
    const here = note !== undefined && note.session === id ? note.state : undefined
    const noteLine = !settings.rewritePrompt
      ? 'Auto-mode note: left as is (rewritePrompt is off).'
      : here === 'rewritten'
        ? `Auto-mode note: rewritten — reading through Bash stays, file changes go to Edit and Write (${s.rewritten} time${s.rewritten === 1 ? '' : 's'} in all).`
        : here === 'unrecognized'
          ? 'Auto-mode note: its wording is not the one this version knows, so it was left as is; the guard still applies.'
          : here === 'absent'
            ? 'Auto-mode note: seen, with no shell-edit advice in it; nothing to rewrite.'
            : 'Auto-mode note: not seen in this session yet (Claude Code adds it in auto mode and with bypass permissions).'
    const describedLine =
      !settings.rewritePrompt || described === undefined || described.session !== id
        ? []
        : [described.added ? 'Bash tool description: the lines sending edits to Edit and Write were missing and are added.' : 'Bash tool description: already sends edits to Edit and Write.']
    const guard =
      settings.mode === 'off'
        ? 'Guard: off.'
        : `Guard: ${settings.mode}, scope ${settings.scope}; always allowed: ${settings.allow.join(', ') || 'nothing'}, /tmp and $TMPDIR.`
    return {
      text: [
        guard,
        ...(settings.invalid.length > 0 ? [`Ignored invalid allowPaths glob${settings.invalid.length === 1 ? '' : 's'}: ${settings.invalid.join(', ')}.`] : []),
        `Shell writes refused: ${session.refused} this session, ${s.refused} in all. Warned: ${session.warned} this session, ${s.warned} in all.`,
        ...(s.passed > 0 ? [`Let through because Claude had no Edit or Write tool: ${session.passed} this session, ${s.passed} in all.`] : []),
        noteLine,
        ...describedLine,
        ...(s.recent.length > 0 ? [`Last: ${s.recent.slice().reverse().join('; ')}.`] : []),
      ].join('\n'),
    }
  })
}
