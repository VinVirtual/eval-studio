// Compares two scored runs case by case and decides whether the new one may pass a CI gate.
import { round } from './util.mjs'

export const GATE_DEFAULTS = { maxRegressions: 0, maxScoreDrop: null, maxLatencyIncreasePct: null, mustPassTag: 'must-pass' }

const passing = (c) => c?.status === 'pass'
const delta = (a, b, places = 1) => (Number.isFinite(a) && Number.isFinite(b) ? round(b - a, places) : null)

/** The first failed check of a case, as a short reason. */
export function failureReason(caseResult) {
  const attempt = caseResult?.attempts?.find((a) => a.error || a.pass === false) ?? caseResult?.attempts?.[0]
  if (!attempt) return ''
  if (attempt.error) return `error: ${attempt.error}`
  const failed = (attempt.checks ?? []).find((k) => k.pass === false)
  return failed ? `${failed.type}: ${failed.detail}` : ''
}

function changeOf(base, next) {
  if (!base) return 'new'
  if (!next) return 'removed'
  if (base.status === 'skipped' || next.status === 'skipped') return 'same'
  if (passing(base) && !passing(next)) return 'regressed'
  if (!passing(base) && passing(next)) return 'fixed'
  return 'same'
}

/**
 * -> { rows, regressions, fixes, added, removed, unchanged: { pass, fail }, score, latency, gate }
 * A regression is a case that passed in the base run and does not pass now (fail, flaky or error).
 */
export function compareRuns(base, next, gateOptions = {}) {
  const gateOpts = { ...GATE_DEFAULTS, ...gateOptions }
  const baseById = new Map(base.cases.map((c) => [c.id, c]))
  const nextById = new Map(next.cases.map((c) => [c.id, c]))
  const ids = [...new Set([...nextById.keys(), ...baseById.keys()])]
  const rows = ids.map((id) => {
    const b = baseById.get(id)
    const n = nextById.get(id)
    return {
      id,
      change: changeOf(b, n),
      baseStatus: b?.status ?? null,
      newStatus: n?.status ?? null,
      scoreDelta: delta(b?.score, n?.score, 4),
      latencyDelta: delta(b?.latencyMs, n?.latencyMs),
      reason: n && !passing(n) ? failureReason(n) : '',
    }
  })
  const pick = (change) => rows.filter((r) => r.change === change)
  const same = pick('same')
  const result = {
    base: { id: base.id, label: base.label ?? null },
    next: { id: next.id, label: next.label ?? null },
    rows,
    regressions: pick('regressed'),
    fixes: pick('fixed'),
    added: pick('new'),
    removed: pick('removed'),
    unchanged: { pass: same.filter((r) => r.newStatus === 'pass').length, fail: same.filter((r) => r.newStatus !== 'pass' && r.newStatus !== 'skipped').length },
    score: { base: base.summary.score, next: next.summary.score, delta: delta(base.summary.score, next.summary.score) },
    latency: { base: base.summary.latencyP50, next: next.summary.latencyP50, delta: delta(base.summary.latencyP50, next.summary.latencyP50) },
  }
  return { ...result, gate: gate(result, next, gateOpts) }
}

/** The must-pass rule alone, for a first run that has nothing to be compared with. */
export function mustPassFailures(run, tag = GATE_DEFAULTS.mustPassTag) {
  return run.cases.filter((c) => (c.tags ?? []).includes(tag) && c.status !== 'pass' && c.status !== 'skipped').map((c) => c.id)
}

function gate(result, next, opts) {
  const reasons = []
  const worse = result.regressions.length
  if (worse > opts.maxRegressions) reasons.push(`${worse} case${worse === 1 ? '' : 's'} got worse (allowed: ${opts.maxRegressions}): ${result.regressions.map((r) => r.id).join(', ')}`)
  const drop = result.score.delta === null ? 0 : -result.score.delta
  if (opts.maxScoreDrop !== null && drop > opts.maxScoreDrop) reasons.push(`the score fell by ${round(drop)} points (allowed: ${opts.maxScoreDrop})`)
  const { base, delta: slower } = result.latency
  if (opts.maxLatencyIncreasePct !== null && base > 0 && slower !== null && (slower / base) * 100 > opts.maxLatencyIncreasePct) {
    reasons.push(`median latency rose by ${round((slower / base) * 100)}% (allowed: ${opts.maxLatencyIncreasePct}%)`)
  }
  const broken = mustPassFailures(next, opts.mustPassTag)
  if (broken.length) reasons.push(`"${opts.mustPassTag}" case${broken.length === 1 ? '' : 's'} not passing: ${broken.join(', ')}`)
  return { ok: reasons.length === 0, reasons }
}
