// Applies the checks to a run and adds up the scores. Returns a new run; the input is not changed.
import { runChecks } from './checks/index.mjs'
import { median, percentile, round } from './util.mjs'

const SCORE_EPSILON = 1e-9
const SCORE_SCALE = 100

const weightedMean = (pairs) => {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0)
  return total > 0 ? pairs.reduce((sum, [value, weight]) => sum + value * weight, 0) / total : null
}

async function scoreAttempt(caseDef, attempt, ctx) {
  if (attempt.error) return { ...attempt, checks: [], score: 0, pass: false }
  const checks = await runChecks(caseDef, attempt, ctx)
  const counted = checks.filter((c) => c.pass !== null)
  if (!counted.length) return { ...attempt, checks, score: null, pass: null }
  const score = weightedMean(counted.map((c) => [c.score, c.weight]))
  // Without a threshold a case passes when every counted check passes. A model-judged check that
  // passes with 0.9 still lowers the score, but does not fail the case.
  const pass = caseDef.threshold === undefined ? counted.every((c) => c.pass) : score >= caseDef.threshold - SCORE_EPSILON
  return { ...attempt, checks, score: round(score, 4), pass }
}

/** pass: every attempt passed. fail: none did. flaky: some did. error: the target never answered. skipped: nothing to count. */
export function caseStatus(attempts) {
  if (attempts.length && attempts.every((a) => a.error)) return 'error'
  const counted = attempts.filter((a) => a.pass !== null)
  if (!counted.length) return 'skipped'
  const passed = counted.filter((a) => a.pass).length
  return passed === counted.length ? 'pass' : passed === 0 ? 'fail' : 'flaky'
}

async function scoreCase(stored, current, ctx) {
  const caseDef = current ? { ...stored, ...current } : stored
  const attempts = []
  for (const attempt of stored.attempts) {
    const { checks: _old, score: _score, pass: _pass, ...raw } = attempt
    attempts.push(await scoreAttempt(caseDef, raw, ctx))
  }
  const status = caseStatus(attempts)
  const counted = attempts.filter((a) => a.score !== null)
  return {
    id: caseDef.id, input: caseDef.input, tags: caseDef.tags ?? [], weight: caseDef.weight ?? 1,
    ...(caseDef.expected === undefined ? {} : { expected: caseDef.expected }),
    ...(caseDef.note === undefined ? {} : { note: caseDef.note }),
    ...(caseDef.threshold === undefined ? {} : { threshold: caseDef.threshold }),
    checks: caseDef.checks ?? [],
    status,
    score: counted.length ? round(counted.reduce((sum, a) => sum + a.score, 0) / counted.length, 4) : null,
    latencyMs: median(attempts.map((a) => a.latencyMs)),
    attempts,
  }
}

const sumUsage = (cases, key) => {
  const values = cases.flatMap((c) => c.attempts.map((a) => a.usage?.[key])).filter((v) => Number.isFinite(v))
  return values.length ? values.reduce((a, b) => a + b, 0) : null
}

/** Totals for a list of scored cases. The score is 0 to 100, weighted by case weight. */
export function summarize(cases) {
  const count = (status) => cases.filter((c) => c.status === status).length
  const counted = cases.filter((c) => c.score !== null)
  const score = weightedMean(counted.map((c) => [c.score, c.weight ?? 1]))
  const latencies = cases.flatMap((c) => c.attempts.filter((a) => !a.error).map((a) => a.latencyMs))
  const cost = sumUsage(cases, 'cost')
  const tags = [...new Set(cases.flatMap((c) => c.tags ?? []))].sort()
  return {
    total: cases.length,
    pass: count('pass'), fail: count('fail'), flaky: count('flaky'), error: count('error'), skipped: count('skipped'),
    score: score === null ? null : round(score * SCORE_SCALE, 1),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    inputTokens: sumUsage(cases, 'inputTokens'),
    outputTokens: sumUsage(cases, 'outputTokens'),
    cost: cost === null ? null : round(cost, 6),
    modelJudgedChecks: cases.reduce((n, c) => n + (c.attempts[0]?.checks ?? []).filter((k) => k.modelJudged && k.pass !== null).length, 0),
    byTag: Object.fromEntries(tags.map((tag) => {
      const tagged = cases.filter((c) => (c.tags ?? []).includes(tag))
      const tagScore = weightedMean(tagged.filter((c) => c.score !== null).map((c) => [c.score, c.weight ?? 1]))
      return [tag, { total: tagged.length, pass: tagged.filter((c) => c.status === 'pass').length, score: tagScore === null ? null : round(tagScore * SCORE_SCALE, 1) }]
    })),
  }
}

/**
 * run: a saved run. currentCases: the cases file as it is now; a case found there by id supplies
 * the checks, so an old run can be scored again after the checks change. ctx: { judge, secrets }.
 */
export async function scoreRun(run, currentCases = [], ctx = {}) {
  const byId = new Map(currentCases.map((c) => [c.id, c]))
  const cases = []
  for (const stored of run.cases) cases.push(await scoreCase(stored, byId.get(stored.id), ctx))
  return { ...run, scored: true, scoredAt: (ctx.now ?? new Date()).toISOString(), judge: ctx.judge?.enabled ? { model: ctx.judge.model } : null, cases, summary: summarize(cases) }
}
