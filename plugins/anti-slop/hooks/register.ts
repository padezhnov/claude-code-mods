import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { avoidSection, commentNote, isScratch, judgeComments, parsePhrases, rewriteBlocks, syntaxOf } from './slop'
import type { CommentRules, Replacement } from './slop'

/** Openers are dropped; the rest are only asked to be avoided, so agent JSON and articles are never rewritten. */
export const DEFAULT_PHRASES = "Хороший вопрос=>, Отличный вопрос=>, You're absolutely right=>, You are absolutely right=>, Ты прав, Вы правы, load-bearing"
const STATS = 'stats'
/** At most this many comment notes in one session, and one per file. */
const SESSION_CAP = 3

type Settings = {
  comments: 'narration' | 'density' | 'off'
  rules: CommentRules
  avoid: string[]
  replace: Replacement[]
  rewrite: boolean
}

/** Kept in the plugin store, shared by every session on this machine, without locking. */
type Stats = { nudges: number; rewrites: number; phrases: Record<string, number> }

const EMPTY: Stats = { nudges: 0, rewrites: 0, phrases: {} }

export function settingsOf(options: PluginOptions): Settings {
  const spec = typeof options.phrases === 'string' ? options.phrases : DEFAULT_PHRASES
  const { avoid, replace } = parsePhrases(spec)
  const min = typeof options.minComments === 'number' && Number.isFinite(options.minComments) ? options.minComments : 3
  const pct = typeof options.commentPercent === 'number' && Number.isFinite(options.commentPercent) ? options.commentPercent : 30
  // 0.1's "nudge" (narration and density together) maps to the new default.
  const comments = options.comments === 'off' ? 'off' : options.comments === 'density' ? 'density' : 'narration'
  return {
    comments,
    rules: {
      density: comments === 'density',
      minComments: Math.max(1, Math.round(min)),
      ratio: Math.min(100, Math.max(1, pct)) / 100,
      beforeNow: options.beforeNow === true,
    },
    avoid,
    replace,
    rewrite: options.rewrite !== false,
  }
}

async function statsOf($: EngineInterface): Promise<Stats> {
  const raw = (await $.store.get(STATS)) as Partial<Stats> | undefined
  return { nudges: raw?.nudges ?? 0, rewrites: raw?.rewrites ?? 0, phrases: raw?.phrases ?? {} }
}

async function record($: EngineInterface, nudges: number, by: Record<string, number>) {
  const stats = await statsOf($)
  const phrases = { ...stats.phrases }
  let rewrites = 0
  for (const [p, n] of Object.entries(by)) {
    phrases[p] = (phrases[p] ?? 0) + n
    rewrites += n
  }
  await $.store.set(STATS, { nudges: stats.nudges + nudges, rewrites: stats.rewrites + rewrites, phrases })
}

async function previousText($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  // Per session: the files already nudged (per agent) and how many notes went out.
  const nudgedFiles = new Set<string>()
  const session = { nudges: 0, rewrites: 0 }
  const resetSession = () => {
    nudgedFiles.clear()
    session.nudges = 0
    session.rewrites = 0
  }

  on('session.start', async ($, e, next) => {
    resetSession()
    await $.command.register({ name: 'anti-slop', description: 'Anti-slop: what it caught so far, and the settings', immediate: true })
    return next(e)
  })

  // /clear and a resume end the session but keep the process: no session.start follows.
  on('session.end', async ($, e, next) => {
    resetSession()
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
  if (settings.comments !== 'off') {
    on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
      const input = e as unknown as { tool: string; agentId?: string; file_path: string; old_string?: string; new_string?: string; content?: string }
      if (isScratch(input.file_path) || syntaxOf(input.file_path) === null) return next(e)
      const key = `${input.agentId ?? 'main'}:${input.file_path}`
      if (session.nudges >= SESSION_CAP || nudgedFiles.has(key)) return next(e)
      const before = input.tool === 'Write' ? await previousText($, input.file_path) : (input.old_string ?? '')
      const after = input.tool === 'Write' ? (input.content ?? '') : (input.new_string ?? '')

      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran

      const verdict = judgeComments(input.file_path, before, after, settings.rules)
      if (verdict === null || session.nudges >= SESSION_CAP || nudgedFiles.has(key)) return ran
      nudgedFiles.add(key)
      session.nudges += 1
      await record($, 1, {})
      return { ...ran, context: [...(ran.context ?? []), commentNote(input.file_path, verdict)] }
    }).catch(($, e, next) => next(e))
  }

  // The phrases: rewritten in the reply as stored, which is what the model
  // reads back on later turns (so it stops echoing itself).
  if (settings.rewrite && settings.replace.length > 0) {
    on('session.append', { door: 'response' }, async ($, e, next) => {
      const content = e.message.content
      if (!Array.isArray(content)) return next(e)
      const r = rewriteBlocks(content, settings.replace)
      if (r.hits === 0) return next(e)
      session.rewrites += r.hits
      await record($, 0, r.by)
      return next({ ...e, message: { ...e.message, content: r.content as typeof content } })
    }).catch(($, e, next) => next(e))
  }

  on('command.run', { command: 'anti-slop' }, async $ => {
    const stats = await statsOf($)
    const rule =
      settings.comments === 'off'
        ? 'off'
        : `${settings.comments === 'density' ? `narrating comments, or ${settings.rules.minComments}+ one-line captions at ${Math.round(settings.rules.ratio * 100)}%+ of the code lines` : 'narrating comments only'}; at most 1 per file and ${SESSION_CAP} per session`
    const counted = Object.entries(stats.phrases).sort((a, b) => b[1] - a[1])
    // 0.1 kept only the total: the rest of it has no phrase to name.
    const before02 = stats.rewrites - counted.reduce((sum, [, n]) => sum + n, 0)
    const perPhrase = [...counted.map(([p, n]) => `"${p}" ${n}`), ...(before02 > 0 && counted.length > 0 ? [`${before02} before 0.2`] : [])].join(', ')
    return {
      text: [
        `This session: ${session.nudges} comment notes, ${session.rewrites} phrases rewritten.`,
        `All sessions on this machine (approximate): ${stats.nudges} comment notes, ${stats.rewrites} phrases rewritten${perPhrase ? ` (${perPhrase})` : ''}.`,
        `Comments: ${rule}.`,
        `Rewritten in stored replies: ${settings.rewrite ? settings.replace.map(r => `"${r.phrase}" → ${r.with === '' ? 'dropped' : `"${r.with}"`}`).join(', ') || 'nothing' : 'off'}.`,
        `Asked to avoid: ${settings.avoid.map(a => `"${a}"`).join(', ') || 'nothing'}.`,
      ].join('\n'),
    }
  })
}
