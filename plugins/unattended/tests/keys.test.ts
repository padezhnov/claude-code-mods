import { describe, expect, test } from 'claude-code/testing'

import { durationLabel, errorSignature, keyOf, normalize, planResume } from '../hooks/keys'

const T0 = Date.parse('2026-10-06T10:00:00Z')
const H = 3_600_000
const at = (ms: number) => new Date(T0 + ms).toISOString()

describe('call identity', () => {
  test('the same command run at different times is one attempt', () => {
    const a = keyOf({ tool: 'Bash', command: 'curl -s http://localhost:4123/health --max-time 5 # 2026-10-06T10:00:01Z' })
    const b = keyOf({ tool: 'Bash', command: 'curl  -s http://localhost:4123/health --max-time 5 # 2026-10-06T10:07:44Z' })
    expect(a.key).toBe(b.key)
  })

  test('different commands, files or edits are different attempts', () => {
    expect(keyOf({ tool: 'Bash', command: 'npm test' }).key).not.toBe(keyOf({ tool: 'Bash', command: 'npm run build' }).key)
    const edit = (n: string) => keyOf({ tool: 'Edit', file_path: '/a.ts', old_string: 'x', new_string: n }).key
    expect(edit('y')).not.toBe(edit('z'))
    expect(edit('y')).toBe(edit('y'))
  })

  test('subagents keep their own counts', () => {
    expect(keyOf({ tool: 'Bash', command: 'ls', agentId: 'a1' }).key).not.toBe(keyOf({ tool: 'Bash', command: 'ls' }).key)
  })

  test('other tools are keyed by their whole input, in any key order', () => {
    const a = keyOf({ tool: 'mcp__db__query', tool_use_id: '1', sql: 'select 1', db: 'x' })
    const b = keyOf({ tool: 'mcp__db__query', tool_use_id: '2', db: 'x', sql: 'select 1' })
    expect(a.key).toBe(b.key)
  })

  test('errors that differ only by timestamps, pids and durations read the same', () => {
    expect(errorSignature('Error at 2026-10-06 10:00:01: pid 48213 timed out after 1500ms')).toBe(
      errorSignature('Error at 2026-10-06 10:03:59: pid 51007 timed out after 1502ms'),
    )
    expect(errorSignature('ENOENT: no such file')).not.toBe(errorSignature('EACCES: permission denied'))
    expect(normalize('  a\n\tb  ')).toBe('a b')
  })
})

describe('when to resume', () => {
  test('waits for the used-up window, plus the grace', () => {
    const plan = planResume([{ kind: 'five_hour', percentUsed: 100, resetsAt: at(2 * H) }], ['five_hour'], T0, 60_000, 0)
    expect(plan).toEqual({ kind: 'wait', at: T0 + 2 * H + 60_000, window: 'five_hour' })
  })

  test('a window not used up does not count', () => {
    const plan = planResume([{ kind: 'five_hour', percentUsed: 80, resetsAt: at(2 * H) }], ['five_hour'], T0, 60_000, 0)
    expect(plan).toEqual({ kind: 'none' })
  })

  test('when both ran out, the later reset decides', () => {
    const windows = [
      { kind: 'five_hour', percentUsed: 100, resetsAt: at(1 * H) },
      { kind: 'seven_day', percentUsed: 100, resetsAt: at(30 * H) },
    ]
    expect(planResume(windows, ['five_hour', 'seven_day'], T0, 0, 0)).toEqual({ kind: 'wait', at: T0 + 30 * H, window: 'seven_day' })
    expect(planResume(windows, ['five_hour'], T0, 0, 0)).toEqual({ kind: 'skip', window: 'seven_day' })
  })

  test('no reset time known: the fallback, or nothing', () => {
    expect(planResume([], ['five_hour'], T0, 60_000, 15 * 60_000)).toEqual({ kind: 'wait', at: T0 + 15 * 60_000, window: 'unknown' })
    expect(planResume([], ['five_hour'], T0, 60_000, 0)).toEqual({ kind: 'none' })
  })

  test('a reset already past resumes right after the grace', () => {
    const plan = planResume([{ kind: 'five_hour', percentUsed: 100, resetsAt: at(-5 * 60_000) }], ['five_hour'], T0, 60_000, 0)
    expect(plan).toEqual({ kind: 'wait', at: T0 + 60_000, window: 'five_hour' })
  })

  test('durations read like a person would say them', () => {
    expect(durationLabel(102 * 60_000)).toBe('1h 42m')
    expect(durationLabel(7 * 60_000)).toBe('7m')
    expect(durationLabel(10_000)).toBe('<1m')
    expect(durationLabel(120 * 60_000)).toBe('2h')
  })
})
