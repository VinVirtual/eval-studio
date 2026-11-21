// Case files (JSONL, JSON, CSV) and lint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCsv, csvToCases } from '../engine/lib/csv.mjs'
import { loadCases, normalizeCase, filterByTags, toJsonl } from '../engine/lib/cases.mjs'
import { lintCases, lintTarget, formatIssues, countLevel } from '../engine/lib/lint.mjs'
import { createAdapter } from '../engine/lib/adapters/index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'evals-cases-'))
const file = (name, text) => { const path = join(dir, name); writeFileSync(path, text); return path }
const rules = (issues, level) => issues.filter((i) => !level || i.level === level).map((i) => i.rule)
const good = (extra) => normalizeCase({ id: 'a', input: 'q?', tags: ['must-pass'], checks: [{ type: 'contains', value: 'x' }], ...extra })

test('parseCsv handles quotes, commas, line breaks inside quotes, CRLF and a BOM', () => {
  const rows = parseCsv('﻿id,input,note\r\n1,"Hello, ""world""","two\nlines"\r\n\r\n2,plain,\n')
  assert.deepEqual(rows, [['id', 'input', 'note'], ['1', 'Hello, "world"', 'two\nlines'], ['2', 'plain', '']])
  assert.throws(() => parseCsv('a,"open'), /never closed/)
})

test('CSV columns become checks', () => {
  const csv = [
    'ID,Question,expected,tags,weight,contains,not_contains,regex,exact,source,tool,tool_args,no_tool,refusal,number,tolerance,max_latency_ms,max_words,json_shape,judge,mystery',
    'c1,"How long?",7 days,"core; loans",2,7 days|once,never|twice,\\d+ days,,borrowing@2,,,delete_all,no,7,0.5,900,40,,Is polite.,x',
    ',Reserve it,,,,,,,,,reserve,"{""tool"":""saw""}",any,yes,,,,,"{""ok"":""boolean""}",,',
  ].join('\n')
  const { cases, warnings } = csvToCases(csv)
  assert.deepEqual(warnings, ['column "mystery" is not known and was ignored'])
  assert.equal(cases[0].id, 'c1'); assert.equal(cases[0].input, 'How long?'); assert.equal(cases[0].expected, '7 days')
  assert.deepEqual(cases[0].tags, ['core', 'loans']); assert.equal(cases[0].weight, 2)
  assert.deepEqual(cases[0].checks, [
    { type: 'contains', all: ['7 days', 'once'] }, { type: 'not-contains', any: ['never', 'twice'] }, { type: 'regex', pattern: '\\d+ days' },
    { type: 'source', id: 'borrowing', maxRank: 2 }, { type: 'no-tool-call', name: 'delete_all' }, { type: 'refusal', expected: false },
    { type: 'number', value: 7, tolerance: 0.5 }, { type: 'max-latency', ms: 900 }, { type: 'max-length', words: 40 }, { type: 'judge', rubric: 'Is polite.' },
  ])
  assert.equal(cases[1].id, 'row-3')
  assert.deepEqual(cases[1].checks, [{ type: 'tool-call', name: 'reserve', args: { tool: 'saw' } }, { type: 'no-tool-call' }, { type: 'refusal', expected: true }, { type: 'json', shape: { ok: 'boolean' } }])
  assert.deepEqual(lintCases(cases.map(normalizeCase), { judgeEnabled: true }).filter((i) => i.level === 'error'), [])
})

test('CSV mistakes are named', () => {
  assert.throws(() => csvToCases('id,contains\n1,x'), /no "input" column/)
  assert.throws(() => csvToCases('input,weight\nq,heavy'), /column weight needs a number/)
  assert.throws(() => csvToCases('input,tolerance\nq,1'), /tolerance needs a number column/)
  assert.deepEqual(csvToCases('').cases, [])
})

test('loadCases reads .jsonl with comments, .json in both layouts, and .csv', () => {
  const line = '{"id":"a","input":"q","tags":"x; y","checks":[{"type":"refusal"}]}'
  const jsonl = loadCases(file('c.jsonl', `// a comment\n\n${line}\n# another\n`)).cases
  assert.deepEqual(jsonl, [{ id: 'a', input: 'q', tags: ['x', 'y'], weight: 1, checks: [{ type: 'refusal' }] }])
  assert.equal(loadCases(file('a.json', `[${line}]`)).cases.length, 1)
  assert.equal(loadCases(file('b.json', `{"cases":[${line}]}`)).cases.length, 1)
  assert.equal(loadCases(file('d.csv', 'input,contains\nq,x\n')).cases[0].checks[0].type, 'contains')
  assert.throws(() => loadCases(file('bad.jsonl', `${line}\n{oops}\n`)), /cases line 2: not valid JSON/)
  assert.throws(() => loadCases(file('bad.json', '{"a":1}')), /expected an array/)
  assert.throws(() => loadCases(join(dir, 'missing.jsonl')), /not found/)
  assert.deepEqual(loadCases(file('round.jsonl', toJsonl(jsonl))).cases, jsonl)
  assert.deepEqual(filterByTags(jsonl, ['y']).length, 1); assert.deepEqual(filterByTags(jsonl, ['z']).length, 0); assert.deepEqual(filterByTags(jsonl, null).length, 1)
})

test('lint: a good set is clean', () => assert.deepEqual(lintCases([good()]), []))

test('lint: duplicate ids, cases with no check, unknown check types and bad fields are errors', () => {
  const issues = lintCases([
    good(), good(),
    good({ id: 'no-check', checks: [] }),
    good({ id: 'odd-type', checks: [{ type: 'vibes' }] }),
    good({ id: 'bad-check', checks: [{ type: 'regex', pattern: '(' }] }),
    good({ id: '', input: '' }),
    good({ id: 'w', weight: 0, threshold: 2 }),
  ])
  assert.deepEqual(rules(issues, 'error').sort(), ['check', 'duplicate-id', 'id', 'input', 'no-check', 'threshold', 'unknown-check', 'weight'])
  assert.match(issues.find((i) => i.rule === 'duplicate-id').message, /cases 1 and 2/)
  assert.match(issues.find((i) => i.rule === 'no-check').message, /can never fail/)
  assert.match(formatIssues(issues), /8 error\(s\), 0 warning\(s\)/)
  assert.equal(lintCases([])[0].rule, 'empty')
})

test('lint: warnings and notes', () => {
  const issues = lintCases([good({ id: 'has space', tags: [], extra: 1, checks: [{ type: 'judge', rubric: 'r' }] })])
  assert.deepEqual(rules(issues, 'warn').sort(), ['field', 'id', 'judge-only'])
  assert.deepEqual(rules(issues, 'info').sort(), ['judge-off', 'must-pass'])
  assert.equal(countLevel(lintCases([good({ checks: [{ type: 'judge', rubric: 'r' }, { type: 'refusal' }] })], { judgeEnabled: true }), 'info'), 0)
})

test('lint: a must-pass case with only model-judged checks is an error while the judge is off', () => {
  const judgeOnly = good({ id: 'm', tags: ['must-pass'], checks: [{ type: 'judge', rubric: 'r' }] })
  assert.ok(rules(lintCases([judgeOnly]), 'error').includes('must-pass-skipped'))
  assert.ok(!rules(lintCases([judgeOnly], { judgeEnabled: true }), 'error').includes('must-pass-skipped'))
  assert.ok(!rules(lintCases([good({ id: 'n', tags: [], checks: [{ type: 'judge', rubric: 'r' }] })]), 'error').includes('must-pass-skipped'))
})

test('lint: an unreachable target, a missing key and a broken config are errors', async () => {
  const dead = createAdapter({ type: 'http', url: 'http://127.0.0.1:9/ask' })
  assert.deepEqual(rules(await lintTarget({ adapter: dead, env: {} }), 'error'), ['unreachable'])
  assert.deepEqual(rules(await lintTarget({ adapter: dead, env: {}, offline: true })), ['reach'])
  const keyed = createAdapter({ type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKeyEnv: 'NOPE_KEY' })
  const missing = await lintTarget({ adapter: keyed, env: {} })
  assert.deepEqual(rules(missing), ['env']); assert.match(missing[0].message, /NOPE_KEY is not set/)
  assert.deepEqual(rules(await lintTarget({ adapterError: 'unknown target type "x"' })), ['target'])
  const noCmd = createAdapter({ type: 'command', command: 'surely-not-a-real-program-xyz --flag' })
  assert.match((await lintTarget({ adapter: noCmd, env: {} }))[0].message, /command not found/)
  const noMod = createAdapter({ type: 'module', path: './nope.mjs' }, { baseDir: dir })
  assert.match((await lintTarget({ adapter: noMod, env: {} }))[0].message, /module not found/)
  const judge = await lintTarget({ adapter: dead, env: {}, offline: true, judge: { enabled: true, apiKeyEnv: 'J_KEY' } })
  assert.deepEqual(rules(judge, 'error'), ['judge', 'env'])
})
