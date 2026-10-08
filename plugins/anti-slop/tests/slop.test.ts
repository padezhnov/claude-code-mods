import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, addedText, countComments, isScratch, judgeComments, looksLikeData, narrates, parsePhrases, rewriteBlocks, rewritePhrases, syntaxOf } from '../hooks/slop'

const DENSITY = { ...DEFAULT_RULES, density: true }
const CAPTIONED = ['// Get the user', 'const user = await db.users.find(id)', '// Check it exists', 'if (!user) return null', '// Return the name', 'return user.name'].join('\n')

describe('narration', () => {
  test('comments that talk about the edit are caught', () => {
    for (const line of [
      '// Added total calculation as requested',
      '# Removed the old retry loop',
      '// Updated to handle nulls',
      '// Changed from map to forEach',
      '// I added a guard for empty input',
      '// New: handles empty input',
      '// Now uses the cache',
      '// Previously this returned null',
      '* Until now the plan was composed in the browser',
      '// It used to land in the account as it was',
      '// per your request, no cache here',
      '-- This change makes the index partial',
      "// I've added a check for empty input",
      '// Added: retry on 429',
      '// Used to return null; throws instead',
      '// Updated to handle nulls',
      '// Replaced with fetch() so no axios',
    ]) expect(narrates(line), line).toBe(true)
  })

  test('the same words describing the code are not narration', () => {
    for (const line of [
      '// Lock used to serialize writes to the journal',
      '// This helper is used to call the API',
      '/** Markdown body without the H1, the draft line and the «Last updated» line. */',
      ' *   customer.subscription.updated / .deleted → status',
      '*   fixed — по таймауту',
      '-- ai_admin_log — who changed what in this section',
      '/** The main model this answer replaced, when a fallback wrote it. */',
      '/** Lines of `after` that are not in `before`: what an edit added, roughly. */',
      '// Items removed from the cache are re-fetched',
      '// Removed items stay in the list until GC',
      '// changed files are re-linted',
      '// Updated by cron every 5 minutes',
      '// Fixed-size buffer',
      '// New users get a trial',
      '# Now: the current state per host',
      '// promo block can be added later',
      // AS2-3: quotes are someone else's words.
      '// retry logic", "as requested", "used to return null") rather than the code.',
      '// … followed by what was changed.',
      '# the bot answers «as requested» when it is done',
      // AS2-3: "used to" describing what a thing is for.
      '// Token used to call the API',
      '// Helper used to run migrations',
      '# Key used to send alerts',
      // AS2-3: the verbs describing what the code does.
      '// Added to the queue when the user clicks',
      '// Removed from the DOM by the parent',
      '// Replaced with a stub in tests',
      '// Switched off in production',
      '// Fixed window rate limit',
      '// Moved permanently (301) when the slug changes',
      '// Previously computed totals are cached here',
      '// Returns the value as requested by the caller',
      '// this change handler fires twice',
    ]) expect(narrates(line), line).toBe(false)
  })

  test('the narration found in our own transcripts', () => {
    for (const line of [
      '* Until now the plan was composed in the browser',
      '-- On upgrade: Until now autopilot was a per-schedule cron',
      '* when a fallback answered. It used to land in the account as it was',
    ]) expect(narrates(line), line).toBe(true)
  })

  test('Russian: the high-precision forms only', () => {
    for (const line of [
      '// Добавил проверку на пустой ответ',
      '# Исправлено: таймаут',
      '// Убрал старый фолбэк',
      '// по просьбе владельца без кэша',
      '// как ты просил, без повторов',
      '# Добавлена проверка на пустой ответ',
      '# Исправлена гонка при рестарте',
      '// Добавлено ограничение на размер',
    ])
      expect(narrates(line), line).toBe(true)
    for (const line of [
      '// Добавленные строки идут первыми',
      '// Исправленный текст уходит модератору',
      '// Сравниваем раньше, чем отправляем',
      '// Теперь шагов девять',
      '// Добавлено в v2 API, старые клиенты не шлют',
      '// Убрал бы, но API требует поле',
      '// бот отвечает «по просьбе клиента» в шаблоне',
    ])
      expect(narrates(line), line).toBe(false)
  })

  test('"раньше…" / "теперь…" only with beforeNow', () => {
    expect(narrates('// Раньше тут был тихий фолбэк', true)).toBe(true)
    expect(narrates('# Теперь один скрипт на обоих серверах', true)).toBe(true)
    expect(narrates('// Сравниваем раньше, чем отправляем', true)).toBe(false)
    expect(judgeComments('/w/a.js', '', '// Теперь шагов девять\nrun(9)')).toBe(null)
    expect(judgeComments('/w/a.js', '', '// Теперь шагов девять\nrun(9)', { ...DEFAULT_RULES, beforeNow: true })?.kind).toBe('narration')
  })

  test('one narrating comment is enough, and the note quotes it', () => {
    expect(judgeComments('/w/app.py', 'x = 1', 'x = 1\n# Added retry logic as requested\nretry(fn)')).toEqual({ kind: 'narration', narrating: ['# Added retry logic as requested'] })
  })
})

describe('density (opt-in)', () => {
  test('off by default: captioned code is left alone', () => {
    expect(judgeComments('/w/src/user.ts', '', CAPTIONED)).toBe(null)
  })

  test('with density on, one-line captions over the code are caught', () => {
    expect(judgeComments('/w/src/user.ts', '', CAPTIONED, DENSITY)).toEqual({ kind: 'density', captions: 3, code: 3 })
  })

  test('explanations are not captions: long lines, runs of lines, doc blocks', () => {
    const why = ['// The API rejects batches over 100 items, so split them before sending.', 'for (const b of chunk(items, 100)) send(b)'].join('\n')
    const run = ['# Rotate first: the old file is still open', '# by the writer until it reopens on HUP.', 'rotate()'].join('\n')
    const doc = '/** Adds. */\nfunction add(a, b) { return a + b }'
    for (const src of [why, run, doc, `${why}\n${run}\n${doc}`]) expect(judgeComments('/w/x.ts', '', src, DENSITY)).toBe(null)
    expect(countComments(run, syntaxOf('/w/x.sh')!)).toEqual({ comments: 2, code: 1, captions: 0, narrating: [] })
  })

  test('minComments and the ratio apply to captions', () => {
    expect(judgeComments('/w/src/user.ts', '', CAPTIONED, { ...DENSITY, minComments: 4 })).toBe(null)
    const sparse = `${CAPTIONED}\n${Array.from({ length: 10 }, (_, i) => `log(${i})`).join('\n')}`
    expect(judgeComments('/w/src/user.ts', '', sparse, DENSITY)).toBe(null)
  })
})

describe('what is judged', () => {
  test('scratch files are never judged', () => {
    expect(isScratch('/tmp/cart.js')).toBe(true)
    expect(isScratch('/tmp/claude-0/-root/abc/scratchpad/x.ts')).toBe(true)
    expect(isScratch('/private/var/folders/xy/T/a.py')).toBe(true)
    expect(isScratch('/root/projects/app/tmp.ts')).toBe(false)
    expect(judgeComments('/tmp/cart.js', '', '// Added total calculation as requested\ntotal()')).toBe(null)
  })

  test('comments that were already there are not counted', () => {
    const before = '// Added a\nconst x = 1'
    expect(judgeComments('/w/a.ts', before, `${before}\nconst y = 2`)).toBe(null)
    expect(addedText('a\nb', 'a\nb\nc')).toBe('c')
  })

  test('tool directives, shebangs and prose files do not count', () => {
    expect(judgeComments('/w/x.py', '', '#!/usr/bin/env python\n# noqa: E501\n# type: ignore\nimport os', DENSITY)).toBe(null)
    expect(judgeComments('/w/README.md', '', '<!-- Added a section -->')).toBe(null)
    expect(syntaxOf('/w/notes.txt')).toBe(null)
    expect(syntaxOf('/w/Dockerfile')).not.toBe(null)
  })
})

describe('phrases', () => {
  const { replace, avoid } = parsePhrases("load-bearing=>critical, You're absolutely right=>, Хороший вопрос=>, Ты прав, delve")

  test('the spec parses into replacements and an avoid list', () => {
    expect(avoid).toEqual(['load-bearing', "You're absolutely right", 'Хороший вопрос', 'Ты прав', 'delve'])
    expect(replace).toEqual([
      { phrase: 'load-bearing', with: 'critical' },
      { phrase: "You're absolutely right", with: '' },
      { phrase: 'Хороший вопрос', with: '' },
    ])
  })

  test('words are replaced, keeping a capital at the start, and counted per phrase', () => {
    expect(rewritePhrases('This check is load-bearing. Load-bearing code moved.', replace)).toEqual({
      text: 'This check is critical. Critical code moved.',
      hits: 2,
      by: { 'load-bearing': 2 },
    })
  })

  test('a hyphen or a letter next to the phrase is part of another word', () => {
    expect(rewritePhrases('the load-bearing-wall test, unload-bearing', replace).hits).toBe(0)
  })

  test('an opening phrase is dropped with its punctuation or dash, the next word capitalized', () => {
    expect(rewritePhrases("You're absolutely right! the test was flaky.", replace).text).toBe('The test was flaky.')
    expect(rewritePhrases('You’re absolutely right — I missed it.', replace).text).toBe('I missed it.')
    expect(rewritePhrases('Хороший вопрос — сейчас туда не идёт ничего.', replace).text).toBe('Сейчас туда не идёт ничего.')
    expect(rewritePhrases('Ок.\n\nХороший вопрос, и ответ зависит от базы.', replace).text).toBe('Ок.\n\nИ ответ зависит от базы.')
  })

  test('Cyrillic boundaries: a longer word is not the phrase', () => {
    expect(rewritePhrases('Хороший вопросник лежит в папке.', replace).hits).toBe(0)
    expect(rewritePhrases('Он задал хороший вопрос — и ушёл.', replace).hits).toBe(0)
  })

  test('trailing punctuation runs, ellipses and an emoji go with the opener', () => {
    expect(rewritePhrases('Хороший вопрос!!! Ответ: да.', replace).text).toBe('Ответ: да.')
    expect(rewritePhrases('Хороший вопрос?! Да.', replace).text).toBe('Да.')
    expect(rewritePhrases('Хороший вопрос…  Да.', replace).text).toBe('Да.')
    expect(rewritePhrases('Хороший вопрос 🙂 Да.', replace).text).toBe('Да.')
    expect(rewritePhrases("You're absolutely right! 👍 the test was flaky.", replace).text).toBe('The test was flaky.')
  })

  test('an opener that carries the sentence is left whole', () => {
    for (const text of ["You're absolutely right that the cache is stale.", "You're absolutely right about the race.", "You're absolutely right to ask."])
      expect(rewritePhrases(text, replace)).toEqual({ text, hits: 0, by: {} })
  })

  test('code spans and fences are left alone', () => {
    const text = 'Rename `load-bearing` here:\n```\nconst loadBearing = "load-bearing"\n```\nIt is load-bearing.'
    expect(rewritePhrases(text, replace).text).toBe('Rename `load-bearing` here:\n```\nconst loadBearing = "load-bearing"\n```\nIt is critical.')
  })
})

describe('stored reply blocks', () => {
  const { replace } = parsePhrases("You're absolutely right=>, load-bearing=>critical")

  test('text blocks are rewritten; tool calls and thinking stay as they are', () => {
    const content = [
      { type: 'thinking', thinking: "You're absolutely right, load-bearing" },
      { type: 'text', text: "You're absolutely right. it is load-bearing." },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo load-bearing' } },
    ]
    const r = rewriteBlocks(content, replace)
    expect(r.content).toEqual([content[0], { type: 'text', text: 'It is critical.' }, content[2]])
    expect(r.by).toEqual({ "You're absolutely right": 1, 'load-bearing': 1 })
  })

  test('JSON-looking text is never rewritten', () => {
    const json = { type: 'text', text: '{"verdict": "load-bearing", "note": "You\'re absolutely right"}' }
    expect(looksLikeData(json.text)).toBe(true)
    expect(rewriteBlocks([json], replace)).toEqual({ content: [json], hits: 0, by: {} })
  })

  test('a block that would be left empty keeps its text', () => {
    const only = { type: 'text', text: "You're absolutely right!" }
    expect(rewriteBlocks([only], replace)).toEqual({ content: [only], hits: 0, by: {} })
  })
})
