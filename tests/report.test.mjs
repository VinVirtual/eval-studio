// The report: the data it shows, that it is one self-contained file, and that nothing in it can break out of the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReportData, renderReport, embedJson } from '../engine/lib/report.mjs'
import { scoreRun } from '../engine/lib/score.mjs'
import { compareRuns } from '../engine/lib/compare.mjs'
import { wordDiff } from '../engine/lib/diff.mjs'
import { attempt } from './helpers.mjs'

const FAKE_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwx' // made up, built at run time
const has = (value) => ({ type: 'contains', value })
const stored = (id, answer, extra = {}) => ({ id, input: `q ${id}`, tags: ['t'], weight: 1, checks: [has('yes'), { type: 'source', id: 'doc' }], ...extra, attempts: [attempt(answer, { sources: [{ id: 'doc', text: 'passage' }] })] })
const make = (id, createdAt, cases) => scoreRun({ id, label: id, name: 'Demo', createdAt, target: { type: 'module', path: './bot.mjs' }, settings: { repeat: 1 }, cases }, [], { now: new Date(createdAt) })

async function fixture() {
  const base = await make('one', '2026-01-01T00:00:00Z', [stored('a', 'yes'), stored('b', 'no')])
  const next = await make('two', '2026-01-02T00:00:00Z', [stored('a', 'no </script><script>alert(1)</script>'), stored('b', 'yes ' + FAKE_KEY)])
  const comparison = compareRuns(base, next)
  return { base, next, comparison, data: buildReportData({ run: next, baseline: base, comparison, history: [base, next], generatedAt: new Date('2026-01-03T00:00:00Z') }) }
}

test('report data carries the summary, the comparison, the trend and each case with its baseline', async () => {
  const { data } = await fixture()
  assert.equal(data.name, 'Demo'); assert.equal(data.run.id, 'two'); assert.equal(data.baseline.id, 'one')
  assert.deepEqual(data.comparison.regressions.map((r) => r.id), ['a']); assert.deepEqual(data.comparison.fixes.map((r) => r.id), ['b'])
  assert.equal(data.comparison.gate.ok, false)
  assert.deepEqual(data.history.map((h) => [h.id, h.score, h.pass, h.fail]), [['one', 75, 1, 1], ['two', 75, 1, 1]])
  const a = data.cases.find((c) => c.id === 'a')
  assert.equal(a.change, 'regressed'); assert.equal(a.base.status, 'pass'); assert.equal(a.base.answer, 'yes')
  assert.deepEqual(a.expectedSources, ['doc']); assert.equal(a.attempts[0].sources[0].text, 'passage')
  assert.deepEqual(a.base.checks.map((k) => k.pass), [true, true])
})

test('report data without a baseline has no comparison and keeps the run in the trend', async () => {
  const { next } = await fixture()
  const data = buildReportData({ run: next, history: [next] })
  assert.equal(data.baseline, null); assert.equal(data.comparison, null); assert.equal(data.cases[0].base, null); assert.equal(data.history.length, 1)
})

test('secrets are masked in the report data', async () => {
  const { data } = await fixture()
  const text = JSON.stringify(data)
  assert.ok(!text.includes(FAKE_KEY)); assert.ok(text.includes('[redacted]'))
  const withEnv = buildReportData({ run: { ...data.run, name: 'n', summary: data.summary, cases: [] }, secrets: ['plain-secret-value'] })
  assert.ok(!JSON.stringify(buildReportData({ run: { id: 'x', name: 'uses plain-secret-value', summary: {}, cases: [] }, secrets: ['plain-secret-value'] })).includes('plain-secret-value'))
  assert.equal(withEnv.cases.length, 0)
})

test('the page is one file: no external URL, a strict content security policy, and data that cannot close its script tag', async () => {
  const { data } = await fixture()
  const html = renderReport(data)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Content-Security-Policy" content="default-src &#39;none&#39;/)
  assert.ok(!/(src|href)="https?:/i.test(html)); assert.ok(!/@import|url\(http/i.test(html))
  assert.ok(!html.includes('<!--DATA-->') && !html.includes('<!--JS-->'))
  assert.equal(html.match(/<\/script>/g).length, 2) // the data block and the page script, nothing injected
  assert.ok(html.includes('\\u003c/script>'))
  assert.match(html, /<title>Demo: eval report<\/title>/)
  assert.equal(JSON.parse(embedJson({ a: '</script>\u2028' })).a, '</script>\u2028')
})

test('wordDiff marks removed and added words and joins neighbours', () => {
  assert.deepEqual(wordDiff('up to 5 tools', 'up to 6 tools'), [{ op: 'same', text: 'up to' }, { op: 'del', text: '5' }, { op: 'add', text: '6' }, { op: 'same', text: 'tools' }])
  assert.deepEqual(wordDiff('', 'new'), [{ op: 'add', text: 'new' }])
  assert.equal(wordDiff('a '.repeat(800), 'b '.repeat(800)), null)
})
