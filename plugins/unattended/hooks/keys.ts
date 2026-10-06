// Pure helpers: no `$`, so the tests can pin them down directly.

/** FNV-1a, 32 bit, as 8 hex chars: enough to tell two edits apart, not a security hash. */
export function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Strips what changes between two runs of the same attempt: timestamps,
 * long numbers (PIDs, ports, durations), hex ids, temp paths, whitespace.
 */
export function normalize(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\/tmp\/[^\s'"]+/g, '/tmp/<x>')
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '<dur>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Stable JSON: keys sorted, so `{a,b}` and `{b,a}` are one call. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId'])

export type CallKey = {
  /** What identifies the attempt: two calls with one key are the same attempt. */
  key: string
  /** A short form for people: the band, the status line, the refusal. */
  label: string
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * The identity of a tool call. Bash is its command, normalized; the file
 * tools are the path plus a hash of what they write; anything else is its
 * whole input. Subagents keep their own counts.
 */
export function keyOf(call: Record<string, unknown>): CallKey {
  const tool = String(call.tool)
  const agent = typeof call.agentId === 'string' ? `${call.agentId}:` : ''
  const str = (k: string) => (typeof call[k] === 'string' ? (call[k] as string) : '')

  if (tool === 'Bash') {
    const command = normalize(str('command'))
    return { key: `${agent}Bash:${command}`, label: clip(command, 60) }
  }
  if (tool === 'Edit') {
    const path = str('file_path')
    return { key: `${agent}Edit:${path}:${hashOf(str('old_string') + '\u0000' + str('new_string'))}`, label: `Edit ${clip(path, 50)}` }
  }
  if (tool === 'Write') {
    const path = str('file_path')
    return { key: `${agent}Write:${path}:${hashOf(str('content'))}`, label: `Write ${clip(path, 50)}` }
  }

  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(call)) if (!RESERVED.has(k)) input[k] = v
  const json = stableJson(input)
  return { key: `${agent}${tool}:${hashOf(json)}`, label: clip(`${tool} ${json}`, 60) }
}

/** The error as a comparable signature: the same failure reads the same. */
export function errorSignature(text: string | undefined): string {
  return hashOf(normalize(text ?? '').slice(0, 2000))
}

/**
 * When to resume: the reset of the window that ran out, plus a grace period.
 * `null` when the window that ran out is one we were told not to wait for.
 */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

export type ResumePlan =
  | { kind: 'wait'; at: number; window: string }
  | { kind: 'skip'; window: string }
  | { kind: 'none' }

export function planResume(
  windows: readonly Window[],
  allowed: readonly string[],
  now: number,
  graceMs: number,
  fallbackMs: number,
): ResumePlan {
  // The window that blocks is the one used up whose reset is furthest away:
  // resuming at an earlier reset would only fail again.
  const spent = windows
    .filter(w => w.percentUsed >= 100 && w.resetsAt !== undefined && !Number.isNaN(Date.parse(w.resetsAt)))
    .map(w => ({ kind: w.kind, at: Date.parse(w.resetsAt as string) }))
    .sort((a, b) => b.at - a.at)

  const blocking = spent[0]
  if (blocking) {
    if (!allowed.includes(blocking.kind)) return { kind: 'skip', window: blocking.kind }
    return { kind: 'wait', at: Math.max(blocking.at, now) + graceMs, window: blocking.kind }
  }
  if (fallbackMs > 0) return { kind: 'wait', at: now + fallbackMs, window: 'unknown' }
  return { kind: 'none' }
}

/** "1h 42m", "7m", "<1m". */
export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '<1m'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (h >= 48) return `${Math.round(h / 24)}d`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** "14:05" in the machine's local time, without relying on Intl. */
export function clockLabel(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
