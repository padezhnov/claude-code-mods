import { describe, expect, test } from 'claude-code/testing'

import { addedText, judgeComments, parsePhrases, rewritePhrases, syntaxOf } from '../hooks/slop'

const judge = (path: string, before: string, after: string) => judgeComments(path, before, after, 3, 0.3)

describe('comments', () => {
  test('a block of restating comments is caught', () => {
    const after = [
      '// Get the user from the database',
      'const user = await db.users.find(id)',
      '// Check if the user exists',
      'if (!user) return null',
      '// Return the user name',
      'return user.name',
    ].join('\n')
    expect(judge('/w/src/user.ts', '', after)).toEqual({ comments: 3, lines: 6, narrating: [] })
  })

  test('a single comment that narrates the edit is caught at once', () => {
    const v = judge('/w/app.py', 'x = 1', 'x = 1\n# Added retry logic as requested\nretry(fn)')
    expect(v?.narrating).toEqual(['# Added retry logic as requested'])
  })

  test('a lone "why" comment in a bigger edit is fine', () => {
    const after = ['// The API rejects batches over 100, so split them.', 'for (const b of chunk(items, 100)) {', '  await send(b)', '}', 'log(items.length)'].join('\n')
    expect(judge('/w/send.ts', '', after)).toBe(null)
  })

  test('comments that were already there are not counted', () => {
    const before = '// a\n// b\n// c\nconst x = 1'
    expect(judge('/w/a.ts', before, `${before}\nconst y = 2`)).toBe(null)
    expect(addedText('a\nb', 'a\nb\nc')).toBe('c')
  })

  test('tool directives, shebangs and prose files do not count', () => {
    const after = '#!/usr/bin/env python\n# noqa: E501\n# type: ignore\n# pylint: disable=x\nimport os'
    expect(judge('/w/x.py', '', after)).toBe(null)
    expect(judge('/w/README.md', '', '<!-- a -->\n<!-- b -->\n<!-- c -->')).toBe(null)
    expect(syntaxOf('/w/notes.txt')).toBe(null)
    expect(syntaxOf('/w/Dockerfile')).not.toBe(null)
  })

  test('block comments count line by line', () => {
    const after = '/**\n * Adds two numbers.\n * @param a first\n */\nfunction add(a, b) { return a + b }'
    expect(judge('/w/m.js', '', after)?.comments).toBe(4)
  })
})

describe('phrases', () => {
  const { replace, avoid } = parsePhrases("load-bearing=>critical, You're absolutely right=>, delve")

  test('the spec parses into replacements and an avoid list', () => {
    expect(avoid).toEqual(['load-bearing', "You're absolutely right", 'delve'])
    expect(replace).toEqual([
      { phrase: 'load-bearing', with: 'critical' },
      { phrase: "You're absolutely right", with: '' },
    ])
  })

  test('words are replaced, keeping a capital at the start', () => {
    expect(rewritePhrases('This check is load-bearing. Load-bearing code moved.', replace)).toEqual({
      text: 'This check is critical. Critical code moved.',
      hits: 2,
    })
  })

  test('an opening "You\'re absolutely right" is dropped and the next word capitalized', () => {
    expect(rewritePhrases("You're absolutely right! the test was flaky.", replace).text).toBe('The test was flaky.')
    expect(rewritePhrases('You’re absolutely right — I missed it.', replace).text).toBe('— I missed it.')
  })

  test('code spans and fences are left alone', () => {
    const text = 'Rename `load-bearing` here:\n```\nconst loadBearing = "load-bearing"\n```\nIt is load-bearing.'
    expect(rewritePhrases(text, replace).text).toBe('Rename `load-bearing` here:\n```\nconst loadBearing = "load-bearing"\n```\nIt is critical.')
  })
})
