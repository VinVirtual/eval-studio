// Scoring a run and comparing two runs: statuses, weights, regressions, fixes and the CI gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreRun, summarize, caseStatus } from '../engine/lib/score.mjs'
import { compareRuns, failureReason, mustPassFailures } from '../engine/lib/compare.mjs'
import { attempt } from './helpers.mjs'

const has = (value) => ({ type: 'contains', value })
const stored = (id, answers, extra = {}) => ({ id, input: `q ${id}`, tags: [], weight: 1, checks: [has('yes')], ...extra, attempts: [].concat(answers).map((a) => (typeof a === 'string' ? attempt(a) : a)) })
const run = (id, cases) => ({ id, label: id, createdAt: `2026-01-0${id.length}T00:00:00Z`, cases })
const scored = (id, cases) => scoreRun(run(id, cases), [], { now: new Date('2026-01-01T00:00:00Z') })

test('caseStatus: pass, fail, flaky, error, skipped', () => {
  assert.equal(caseStatus([{ pass: true }, { pass: true }]), 'pass')
  assert.equal(caseStatus([{ pass: false }]), 'fail')
  assert.equal(caseStatus([{ pass: true }, { pass: false }]), 'flaky')
  assert.equal(caseStatus([{ pass: false, error: 'x' }, { pass: false, error: 'y' }]), 'error')
  assert.equal(caseStatus([{ pass: null }]), 'skipped')
})

test('the run score is weighted by case weight and check weight', async () => {
  const out = await scored('a', [
    stored('heavy', 'no', { weight: 3 }),
    stored('light', 'yes'),
    stored('half', 'yes', { checks: [{ ...has('yes'), weight: 3 }, has('never')] }),
  ])
  assert.deepEqual(out.cases.map((c) => [c.status, c.score]), [['fail', 0], ['pass', 1], ['fail', 0.75]])
  assert.equal(out.summary.score, 35) // (0*3 + 1*1 + 0.75*1) / 5
  assert.equal(out.summary.pass, 1); assert.equal(out.summary.fail, 2); assert.equal(out.scored, true)
})

test('a case threshold lets a case pass with part credit', async () => {
  const out = await scored('a', [stored('part', 'yes', { threshold: 0.5, checks: [has('yes'), has('never')] })])
  assert.equal(out.cases[0].status, 'pass'); assert.equal(out.cases[0].score, 0.5)
})

test('repeats: mixed attempts are flaky, errors score zero, skipped cases are left out of the score', async () => {
  const out = await scored('a', [
    stored('wobbly', ['yes', 'no', 'yes']),
    stored('down', [attempt('', { error: 'timeout' })]),
    stored('judged', 'yes', { checks: [{ type: 'judge', rubric: 'r' }] }),
  ])
  assert.deepEqual(out.cases.map((c) => c.status), ['flaky', 'error', 'skipped'])
  assert.equal(out.cases[0].score, 0.6667)
  assert.equal(out.summary.score, 33.3); assert.equal(out.summary.skipped, 1); assert.equal(out.judge, null)
})

test('scoring again uses the checks of the current cases file, matched by id', async () => {
  const first = await scored('a', [stored('c1', 'yes indeed')])
  const again = await scoreRun(first, [{ id: 'c1', input: 'q', tags: ['t'], weight: 1, checks: [has('indeed'), has('nope')] }])
  assert.equal(again.cases[0].status, 'fail'); assert.equal(again.cases[0].attempts[0].checks.length, 2); assert.deepEqual(again.cases[0].tags, ['t'])
  assert.equal(first.cases[0].status, 'pass') // the input run is not changed
})

test('summary adds up latency, tokens, cost and tags', () => {
  const mk = (id, status, score, tags, latencyMs, usage) => ({ id, status, score, tags, weight: 1, attempts: [{ latencyMs, usage, checks: [] }] })
  const s = summarize([mk('a', 'pass', 1, ['x'], 10, { inputTokens: 5, outputTokens: 2, cost: 0.001 }), mk('b', 'fail', 0, ['x', 'y'], 30, { inputTokens: 7, outputTokens: 1, cost: 0.002 })])
  assert.equal(s.latencyP50, 10); assert.equal(s.latencyP95, 30)
  assert.equal(s.inputTokens, 12); assert.equal(s.outputTokens, 3); assert.equal(s.cost, 0.003)
  assert.deepEqual(s.byTag, { x: { total: 2, pass: 1, score: 50 }, y: { total: 1, pass: 0, score: 0 } })
  assert.equal(summarize([mk('a', 'pass', 1, [], 1, {})]).cost, null)
})

test('compare finds regressions, fixes, unchanged, new and removed cases', async () => {
  const base = await scored('a', [stored('keeps', 'yes'), stored('breaks', 'yes'), stored('mends', 'no'), stored('stays-bad', 'no'), stored('gone', 'yes')])
  const next = await scored('bb', [stored('keeps', 'yes'), stored('breaks', 'no'), stored('mends', 'yes'), stored('stays-bad', 'no'), stored('fresh', 'yes')])
  const cmp = compareRuns(base, next)
  assert.deepEqual(cmp.regressions.map((r) => r.id), ['breaks']); assert.deepEqual(cmp.fixes.map((r) => r.id), ['mends'])
  assert.deepEqual(cmp.added.map((r) => r.id), ['fresh']); assert.deepEqual(cmp.removed.map((r) => r.id), ['gone'])
  assert.deepEqual(cmp.unchanged, { pass: 1, fail: 1 })
  assert.equal(cmp.regressions[0].reason, 'contains: missing "yes"'); assert.equal(cmp.regressions[0].scoreDelta, -1)
  assert.equal(cmp.score.base, 60); assert.equal(cmp.score.next, 60); assert.equal(cmp.score.delta, 0)
  assert.equal(cmp.gate.ok, false); assert.match(cmp.gate.reasons[0], /1 case got worse \(allowed: 0\): breaks/)
  assert.equal(compareRuns(base, next, { maxRegressions: 1 }).gate.ok, true)
})

test('a case that turns flaky or errors counts as a regression; a skipped case does not', async () => {
  const base = await scored('a', [stored('f', ['yes', 'yes']), stored('e', 'yes'), stored('s', 'yes')])
  const next = await scored('bb', [stored('f', ['yes', 'no']), stored('e', [attempt('', { error: 'HTTP 500' })]), stored('s', 'yes', { checks: [{ type: 'judge', rubric: 'r' }] })])
  const cmp = compareRuns(base, next)
  assert.deepEqual(cmp.regressions.map((r) => [r.id, r.newStatus]), [['f', 'flaky'], ['e', 'error']])
  assert.equal(failureReason(next.cases[1]), 'error: HTTP 500')
})

test('the gate also watches score drop, latency rise and must-pass cases', async () => {
  const slow = (answer, ms) => attempt(answer, { latencyMs: ms })
  const base = await scored('a', [stored('m', slow('no', 100), { tags: ['must-pass'] }), stored('p', slow('yes', 100), { checks: [has('yes'), has('y')] })])
  const next = await scored('bb', [stored('m', slow('no', 180), { tags: ['must-pass'] }), stored('p', slow('yes', 180), { threshold: 0.5, checks: [has('yes'), has('zzz')] })])
  const cmp = compareRuns(base, next, { maxScoreDrop: 10, maxLatencyIncreasePct: 50 })
  assert.equal(cmp.regressions.length, 0); assert.equal(cmp.score.delta, -25); assert.equal(cmp.latency.delta, 80)
  assert.equal(cmp.gate.reasons.length, 3)
  assert.match(cmp.gate.reasons[0], /fell by 25 points/); assert.match(cmp.gate.reasons[1], /rose by 80%/); assert.match(cmp.gate.reasons[2], /"must-pass" case not passing: m/)
  assert.deepEqual(mustPassFailures(next), ['m']); assert.deepEqual(mustPassFailures(next, 'other'), [])
  assert.equal(compareRuns(base, next, { mustPassTag: 'none' }).gate.ok, true)
})
