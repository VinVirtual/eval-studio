// Every check type: what passes, what fails, and what lint says about a bad definition.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runChecks, validateCheck, describeCheck, checkTypes } from '../engine/lib/checks/index.mjs'
import { refusalPhrase, norm } from '../engine/lib/checks/text.mjs'
import { extractJson, shapeErrors, numbersIn } from '../engine/lib/checks/data.mjs'
import { argsLike, citedIn } from '../engine/lib/checks/agent.mjs'
import { attempt } from './helpers.mjs'

const check = async (def, att) => (await runChecks({ id: 'c', input: 'q', checks: [def] }, typeof att === 'string' ? attempt(att) : att))[0]
const passes = async (def, att) => (await check(def, att)).pass

test('all thirteen check types are registered', () => {
  assert.deepEqual(checkTypes().sort(), ['contains', 'exact', 'json', 'judge', 'max-latency', 'max-length', 'no-tool-call', 'not-contains', 'number', 'refusal', 'regex', 'source', 'tool-call'])
})

test('contains ignores case, spacing and curly quotes; all gives part credit; any needs one', async () => {
  assert.equal(await passes({ type: 'contains', value: "it's 7 DAYS" }, 'Well, it’s   7 days.'), true)
  assert.equal(await passes({ type: 'contains', value: 'Days', caseSensitive: true }, '7 days'), false)
  const part = await check({ type: 'contains', all: ['7 days', 'once'] }, 'for 7 days')
  assert.equal(part.pass, false); assert.equal(part.score, 0.5); assert.match(part.detail, /missing "once"/)
  assert.equal(await passes({ type: 'contains', any: ['nine', '9'] }, 'opens at 9'), true)
  assert.equal(await passes({ type: 'contains', any: ['nine', '9'] }, 'opens at ten'), false)
})

test('not-contains fails when a banned phrase appears', async () => {
  assert.equal(await passes({ type: 'not-contains', value: 'guarantee' }, 'We promise nothing.'), true)
  const bad = await check({ type: 'not-contains', any: ['guarantee', 'refund'] }, 'A full REFUND is certain.')
  assert.equal(bad.pass, false); assert.match(bad.detail, /"refund"/)
})

test('regex matches with flags, and a broken pattern is a lint problem', async () => {
  assert.equal(await passes({ type: 'regex', pattern: '9\\s?am.*1\\s?pm' }, 'Open 9 AM to 1 PM'), true)
  assert.equal(await passes({ type: 'regex', pattern: '^open', flags: '' }, 'Open'), false)
  assert.match(validateCheck({ type: 'regex', pattern: '(' })[0], /not a valid regular expression/)
})

test('exact compares the whole answer after trimming', async () => {
  assert.equal(await passes({ type: 'exact', value: 'Yes.' }, '  Yes.\n'), true)
  assert.equal(await passes({ type: 'exact', value: 'Yes.' }, 'yes.'), false)
  assert.equal(await passes({ type: 'exact', value: 'Yes.', ignoreCase: true }, 'yes.'), true)
  assert.equal(await passes({ type: 'exact', value: 'Yes.' }, 'Yes. And more.'), false)
})

test('json finds JSON in the answer and checks shape and values', async () => {
  assert.deepEqual(extractJson('Here:\n```json\n{"a": 1}\n```').value, { a: 1 })
  assert.deepEqual(extractJson('result: [1, 2] done').value, [1, 2])
  assert.equal(extractJson('no json here').ok, false)
  const shape = { name: 'string', count: 'integer', tags: ['string'], extra: 'number?' }
  assert.equal(await passes({ type: 'json', shape }, '{"name":"x","count":2,"tags":["a"]}'), true)
  const bad = await check({ type: 'json', shape }, '{"name":1,"count":2.5,"tags":["a",3]}')
  assert.equal(bad.pass, false)
  assert.match(bad.detail, /\$\.name should be string, is number/); assert.match(bad.detail, /\$\.tags\[1\]/)
  assert.equal((await check({ type: 'json', shape: {} }, 'plain words')).detail, 'the answer is not JSON')
  assert.equal(await passes({ type: 'json', values: { 'a.b': 2 } }, '{"a":{"b":2}}'), true)
  assert.equal(await passes({ type: 'json', values: { 'a.b': 2 } }, '{"a":{"b":3}}'), false)
  assert.deepEqual(shapeErrors([1], ['string']), ['$[0] should be string, is number'])
  assert.match(validateCheck({ type: 'json', shape: { a: 'text' } })[0], /is not a type/)
})

test('number reads numbers out of text and allows a tolerance', async () => {
  assert.deepEqual(numbersIn('1,250.5 items, -3 and 7'), [1250.5, -3, 7])
  assert.equal(await passes({ type: 'number', value: 5 }, 'Up to 5 tools.'), true)
  assert.equal(await passes({ type: 'number', value: 6 }, 'It is 2 per day.'), false)
  assert.equal(await passes({ type: 'number', value: 100, tolerance: 2 }, 'about 98.5'), true)
  assert.equal(await passes({ type: 'number', value: 100, tolerancePct: 1 }, 'about 98.5'), false)
  assert.equal(await passes({ type: 'number', value: 7, pick: 'first' }, '3 then 7'), false)
  assert.equal(await passes({ type: 'number', value: 7, pick: 'last' }, '3 then 7'), true)
  assert.equal((await check({ type: 'number', value: 1 }, 'none')).detail, 'no number in the answer')
})

test('number: a hyphen between words or digits is not a minus sign', async () => {
  assert.deepEqual(numbersIn('pages 5-10'), [5, 10])
  assert.deepEqual(numbersIn('on 2026-01-31'), [2026, 1, 31])
  assert.deepEqual(numbersIn('COVID-19 cases'), [19])
  assert.deepEqual(numbersIn('it fell by -3, then -2.5 (x=-4)'), [-3, -2.5, -4])
  assert.deepEqual(numbersIn('2,500 and 1,5'), [2500, 1, 5]) // decimal commas are not understood
  assert.equal(await passes({ type: 'number', value: -10 }, 'See pages 5-10.'), false)
  assert.equal(await passes({ type: 'number', value: 10 }, 'See pages 5-10.'), true)
})

test('regex: a pattern that would take forever is stopped after its time limit', async () => {
  const slow = { type: 'regex', pattern: '^(a|aa)+$', timeoutMs: 200 } // not caught by the nested-quantifier rule
  const started = Date.now()
  const out = await check(slow, 'a'.repeat(40) + 'b')
  assert.equal(out.pass, false); assert.match(out.detail, /took longer than 200 ms and was stopped/)
  assert.ok(Date.now() - started < 3000)
  assert.equal(await passes({ type: 'regex', pattern: '^a+b$' }, 'aaab'), true) // a fresh worker takes over after the stop
})

test('regex: nested quantifiers are refused before anything runs, in regex checks and in tool arguments', async () => {
  for (const pattern of ['(a+)+$', '(\\w*)*x', '(ab{1,})+', '(?:x+y)*z']) assert.match(validateCheck({ type: 'regex', pattern })[0] ?? '', /repeated group/, pattern)
  assert.deepEqual(validateCheck({ type: 'regex', pattern: '(ab)+c+' }), [])
  assert.match(validateCheck({ type: 'tool-call', name: 't', args: { q: '/(a+)+/' } })[0], /args pattern/)
  assert.match(validateCheck({ type: 'tool-call', name: 't', args: { q: '/(/' } })[0], /not valid/)
  const out = await check({ type: 'regex', pattern: '(a+)+$' }, 'aaaa')
  assert.equal(out.pass, false); assert.match(out.detail, /not usable/)
})

test('tool-call with min 0 passes when the tool is never called, and still applies max', async () => {
  assert.equal(await passes({ type: 'tool-call', name: 'search', min: 0 }, 'no tools here'), true)
  assert.equal(await passes({ type: 'tool-call', name: 'search', min: 0, max: 1 }, attempt('', { toolCalls: [{ name: 'search', arguments: {} }] })), true)
  assert.equal(await passes({ type: 'tool-call', name: 'search', min: 0, max: 1 }, attempt('', { toolCalls: [{ name: 'search', arguments: {} }, { name: 'search', arguments: {} }] })), false)
  assert.deepEqual(validateCheck({ type: 'tool-call', name: 'search', min: 0 }), [])
})

test('source reports the rank of a retrieval hit', async () => {
  const att = attempt('See [fees].', { sources: [{ id: 'hours' }, { id: 'Fees' }, { id: 'safety' }] })
  const hit = await check({ type: 'source', id: 'fees' }, att)
  assert.equal(hit.pass, true); assert.equal(hit.rank, 2); assert.match(hit.detail, /rank 2 of 3/)
  const low = await check({ type: 'source', id: 'fees', maxRank: 1 }, att)
  assert.equal(low.pass, false); assert.match(low.detail, /needed the top 1/)
  const miss = await check({ type: 'source', id: 'membership' }, att)
  assert.equal(miss.pass, false); assert.match(miss.detail, /not retrieved \(retrieved: hours, Fees, safety\)/)
  assert.equal(await passes({ type: 'source', id: 'fees', where: 'cited' }, att), true)
  assert.equal(await passes({ type: 'source', id: 'hours', where: 'cited' }, att), false)
  assert.equal(await passes({ type: 'source', id: 'membership', where: 'either' }, attempt('From membership.md.')), true)
  assert.equal(await passes({ type: 'source', id: 'membership', where: 'either' }, attempt('Ask about memberships.')), false)
  assert.equal(citedIn('the fees-old page', 'fees'), false)
})

test('tool-call needs the tool, and arguments that are alike', async () => {
  const att = attempt('', { toolCalls: [{ name: 'search', arguments: { q: 'x' } }, { name: 'reserve_tool', arguments: { tool: 'Cordless Drill', day: 'friday', count: 1 } }] })
  assert.equal(await passes({ type: 'tool-call', name: 'reserve_tool' }, att), true)
  assert.equal(await passes({ type: 'tool-call', name: 'reserve_tool', args: { tool: 'drill', count: 1 } }, att), true)
  assert.equal(await passes({ type: 'tool-call', name: 'reserve_tool', args: { day: '/^fri/' } }, att), true)
  const wrong = await check({ type: 'tool-call', name: 'reserve_tool', args: { tool: 'ladder' } }, att)
  assert.equal(wrong.pass, false); assert.match(wrong.detail, /arguments\.tool should be like "ladder"/)
  const none = await check({ type: 'tool-call', name: 'cancel' }, att)
  assert.equal(none.pass, false); assert.match(none.detail, /called: search, reserve_tool/)
  assert.equal(await passes({ type: 'tool-call', name: 'search', min: 2 }, att), false)
  assert.equal(await passes({ type: 'tool-call', name: 'search', max: 0 }, att), false)
  assert.deepEqual(argsLike({ a: [{ b: 'x' }] }, { a: [{ b: 'y' }, { b: 'xx', c: 1 }] }), [])
  assert.equal(argsLike({ a: true }, { a: 'true' }).length, 1)
  assert.equal(argsLike({ a: 'x' }, {}).length, 1)
})

test('no-tool-call fails when the banned tool was called', async () => {
  const att = attempt('', { toolCalls: [{ name: 'delete_account', arguments: {} }] })
  assert.equal(await passes({ type: 'no-tool-call', name: 'delete_account' }, att), false)
  assert.equal(await passes({ type: 'no-tool-call', name: 'send_email' }, att), true)
  assert.equal(await passes({ type: 'no-tool-call', any: ['send_email', 'delete_account'] }, att), false)
  assert.equal(await passes({ type: 'no-tool-call' }, att), false)
  assert.equal(await passes({ type: 'no-tool-call' }, 'just text'), true)
})

test('refusal looks for refusal phrases, and can be expected not to happen', async () => {
  assert.equal(refusalPhrase('I’m sorry, but that is outside what I can help with.'), "i'm sorry, but")
  assert.equal(refusalPhrase('The fee is 2 dollars.'), null)
  assert.equal(await passes({ type: 'refusal' }, "I can't answer that."), true)
  assert.equal(await passes({ type: 'refusal' }, 'Paris.'), false)
  assert.equal(await passes({ type: 'refusal', expected: false }, 'Paris.'), true)
  assert.equal(await passes({ type: 'refusal', phrases: ['ask the front desk'] }, 'Please ask the front desk.'), true)
})

test('max-latency and max-length measure the attempt', async () => {
  assert.equal(await passes({ type: 'max-latency', ms: 50 }, attempt('x', { latencyMs: 49 })), true)
  assert.equal(await passes({ type: 'max-latency', ms: 50 }, attempt('x', { latencyMs: 51 })), false)
  assert.equal(await passes({ type: 'max-length', words: 3 }, 'one two three'), true)
  assert.equal(await passes({ type: 'max-length', words: 3 }, 'one two three four'), false)
  assert.equal(await passes({ type: 'max-length', chars: 5, words: 9 }, 'sixsix'), false)
})

test('a model-judged check is skipped while the judge is off, and marked either way', async () => {
  const off = await check({ type: 'judge', rubric: 'Is polite.' }, 'Hello')
  assert.equal(off.pass, null); assert.equal(off.score, null); assert.equal(off.modelJudged, true); assert.match(off.detail, /off/)
  const judge = { enabled: true, model: 'stub', grade: async () => ({ score: 0.8, reason: 'polite enough' }) }
  const on = (await runChecks({ id: 'c', input: 'q', checks: [{ type: 'judge', rubric: 'Is polite.' }, { type: 'judge', rubric: 'r', threshold: 0.9 }] }, attempt('Hello'), { judge }))
  assert.deepEqual(on.map((r) => [r.pass, r.score, r.modelJudged]), [[true, 0.8, true], [false, 0.8, true]])
  const broken = { enabled: true, model: 'stub', grade: async () => { throw new Error('down') } }
  const failed = (await runChecks({ id: 'c', input: 'q', checks: [{ type: 'judge', rubric: 'r' }] }, attempt('Hello'), { judge: broken }))[0]
  assert.equal(failed.pass, false); assert.match(failed.detail, /judge call failed: down/)
})

test('bad definitions are reported, not run', async () => {
  assert.match(validateCheck({ type: 'similar' })[0], /unknown check type "similar"/)
  assert.match(validateCheck({ type: 'contains' })[0], /exactly one of/)
  assert.match(validateCheck({ type: 'contains', value: 'a', all: ['b'] })[0], /exactly one of/)
  assert.equal(validateCheck({ type: 'max-length' }).length, 1)
  assert.equal(validateCheck({ type: 'contains', value: 'a', weight: 0 }).length, 1)
  assert.equal(validateCheck('contains').length, 1)
  const out = await check({ type: 'similar' }, 'x')
  assert.equal(out.pass, false); assert.match(out.detail, /not usable/)
  assert.equal(describeCheck({ type: 'source', id: 'fees', maxRank: 2 }), 'retrieves source "fees" in the top 2')
  assert.equal(norm('  A  b '), 'a b')
})
