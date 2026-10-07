import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { avoidSection, commentNote, judgeComments, parsePhrases, rewritePhrases } from './slop'
import type { Replacement } from './slop'

const DEFAULT_PHRASES = "load-bearing=>critical, You're absolutely right=>, You are absolutely right=>"
const STATS = 'stats'

type Settings = {
  comments: 'nudge' | 'off'
  minComments: number
  ratio: number
  avoid: string[]
  replace: Replacement[]
  rewrite: boolean
}

type Stats = { nudges: number; rewrites: number }

export function settingsOf(options: PluginOptions): Settings {
  const spec = typeof options.phrases === 'string' ? options.phrases : DEFAULT_PHRASES
  const { avoid, replace } = parsePhrases(spec)
  const min = typeof options.minComments === 'number' && Number.isFinite(options.minComments) ? options.minComments : 3
  const pct = typeof options.commentPercent === 'number' && Number.isFinite(options.commentPercent) ? options.commentPercent : 30
  return {
    comments: options.comments === 'off' ? 'off' : 'nudge',
    minComments: Math.max(1, Math.round(min)),
    ratio: Math.min(100, Math.max(1, pct)) / 100,
    avoid,
    replace,
    rewrite: options.rewrite !== false,
  }
}

let settings: Settings = settingsOf({})

async function bump($: EngineInterface, key: keyof Stats, by: number) {
  const stats = ((await $.store.get(STATS)) as Stats | undefined) ?? { nudges: 0, rewrites: 0 }
  await $.store.set(STATS, { ...stats, [key]: stats[key] + by })
}

async function previousText($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'anti-slop', description: 'Anti-slop: what it caught so far, and the settings', immediate: true })
    return next(e)
  })

  // The words to avoid, as a system prompt section of their own.
  if (settings.avoid.length > 0) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      return { sections: [...composed.sections, { id: 'anti-slop:style', text: avoidSection(settings.avoid), scope: 'session' as const }] }
    })
  }

  // Comments: never refuse an edit (that only burns tokens); tell the model
  // right after it, when the note is most likely to be acted on.
  if (settings.comments === 'nudge') {
    on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
      const input = e as unknown as { tool: string; file_path: string; old_string?: string; new_string?: string; content?: string }
      const before = input.tool === 'Write' ? await previousText($, input.file_path) : (input.old_string ?? '')
      const after = input.tool === 'Write' ? (input.content ?? '') : (input.new_string ?? '')

      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran

      const verdict = judgeComments(input.file_path, before, after, settings.minComments, settings.ratio)
      if (verdict === null) return ran
      await bump($, 'nudges', 1)
      return { ...ran, context: [...(ran.context ?? []), commentNote(input.file_path, verdict)] }
    }).catch(($, e, next) => next(e))
  }

  // The phrases: rewritten in the reply as stored, which is what the model
  // reads back on later turns (so it stops echoing itself).
  if (settings.rewrite && settings.replace.length > 0) {
    on('session.append', { door: 'response' }, async ($, e, next) => {
      const content = e.message.content
      if (!Array.isArray(content)) return next(e)
      let hits = 0
      const blocks = content.map(block => {
        if (block === null || typeof block !== 'object' || (block as { type?: string }).type !== 'text') return block
        const r = rewritePhrases((block as unknown as { text: string }).text, settings.replace)
        if (r.hits === 0) return block
        hits += r.hits
        return { ...(block as object), text: r.text }
      })
      if (hits === 0) return next(e)
      await bump($, 'rewrites', hits)
      return next({ ...e, message: { ...e.message, content: blocks as typeof content } })
    }).catch(($, e, next) => next(e))
  }

  on('command.run', { command: 'anti-slop' }, async $ => {
    const stats = ((await $.store.get(STATS)) as Stats | undefined) ?? { nudges: 0, rewrites: 0 }
    return {
      text: [
        `Comment nudges: ${stats.nudges} (${settings.comments === 'off' ? 'off' : `at ${settings.minComments}+ comment lines and ${Math.round(settings.ratio * 100)}%+ of an edit, or any comment narrating the change`}).`,
        `Phrases rewritten: ${stats.rewrites} (${settings.rewrite ? settings.replace.map(r => `"${r.phrase}" → ${r.with === '' ? 'dropped' : `"${r.with}"`}`).join(', ') || 'none' : 'rewriting off'}).`,
        `Asked to avoid: ${settings.avoid.map(a => `"${a}"`).join(', ') || 'nothing'}.`,
      ].join('\n'),
    }
  })
}
