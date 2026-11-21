// Compares two scored runs case by case and decides whether the new one may pass a CI gate.
import { round } from './util.mjs'

/**
 * maxRegressions      cases allowed to go from passing to not passing (a new case that fails counts, see below)
 * maxScoreDrop        points the weighted score may fall; null turns the rule off
 * maxLatencyIncreasePct  percent the median latency may rise; null turns the rule off
 * maxErrors           cases allowed to get no answer at all from the target
 * mustPassTag         cases with this tag must pass (a skipped one fails)
 * allowRemoved        false: a baseline case missing from the new run fails the gate (renamed or deleted ids)
 * allowNewFailures    false: a case that is new in this run and does not pass counts as a regression
 */
export const GATE_DEFAULTS = {
  maxRegressions: 0, maxScoreDrop: 5, maxLatencyIncreasePct: null, maxErrors: 0,
  mustPassTag: 'must-pass', allowRemoved: false, allowNewFailures: false,
}

const passing = (c) => c?.status === 'pass'
const delta = (a, b, places = 1) => (Number.isFinite(a) && Number.isFinite(b) ? round(b - a, places) : null)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const SHOWN_IDS = 12
const idList = (ids) => ids.slice(0, SHOWN_IDS).join(', ') + (ids.length > SHOWN_IDS ? ` and ${ids.length - SHOWN_IDS} more` : '')

/** The first failed check of a case, as a short reason. */
export function failureReason(caseResult) {
  const attempt = caseResult?.attempts?.find((a) => a.error || a.pass === false) ?? caseResult?.attempts?.[0]
  if (!attempt) return ''
  if (attempt.error) return `error: ${attempt.error}`
  const failed = (attempt.checks ?? []).find((k) => k.pass === false)
  if (failed) return `${failed.type}: ${failed.detail}`
  return caseResult.status === 'skipped' ? 'skipped: no check could run' : ''
}

/** Was this case asked in a run that may have been limited to some tags (evals run --tag)? */
const inScope = (caseResult, run) => {
  const tags = run.settings?.tags
  return !tags?.length || (caseResult.tags ?? []).some((t) => tags.includes(t))
}

function changeOf(base, next, baseRun, nextRun) {
  if (!base) return inScope(next, baseRun) ? 'new' : 'not-in-base'
  if (!next) return inScope(base, nextRun) ? 'removed' : 'not-run'
  if (base.status === 'skipped' || next.status === 'skipped') return 'same'
  if (passing(base) && !passing(next)) return 'regressed'
  if (!passing(base) && passing(next)) return 'fixed'
  return 'same'
}

/**
 * -> { rows, regressions, fixes, added, removed, notRun, unchanged: { pass, fail }, score, latency, gate }
 * A regression is a case that passed in the base run and does not pass now (fail, flaky or error),
 * or, unless allowNewFailures, a new case that does not pass. Baseline cases left out
 * on purpose by a --tag run are "not run", not removed.
 */
export function compareRuns(base, next, gateOptions = {}) {
  const opts = { ...GATE_DEFAULTS, ...gateOptions }
  const baseById = new Map(base.cases.map((c) => [c.id, c]))
  const nextById = new Map(next.cases.map((c) => [c.id, c]))
  const ids = [...new Set([...nextById.keys(), ...baseById.keys()])]
  const rows = ids.map((id) => {
    const b = baseById.get(id)
    const n = nextById.get(id)
    return {
      id,
      change: changeOf(b, n, base, next),
      baseStatus: b?.status ?? null,
      newStatus: n?.status ?? null,
      scoreDelta: delta(b?.score, n?.score, 4),
      latencyDelta: delta(b?.latencyMs, n?.latencyMs),
      reason: n && !passing(n) ? failureReason(n) : '',
    }
  })
  const pick = (...changes) => rows.filter((r) => changes.includes(r.change))
  const newFailing = pick('new', 'not-in-base').filter((r) => r.newStatus !== 'pass')
  const same = pick('same')
  // The score is compared only over cases both runs asked, so a --tag run is not "worse" for asking less.
  const shared = rows.filter((r) => baseById.has(r.id) && nextById.has(r.id)).map((r) => r.id)
  const result = {
    base: { id: base.id, label: base.label ?? null },
    next: { id: next.id, label: next.label ?? null },
    rows,
    regressions: [...pick('regressed'), ...(opts.allowNewFailures ? [] : newFailing.map((r) => ({ ...r, newCase: true })))],
    fixes: pick('fixed'),
    added: pick('new', 'not-in-base'),
    removed: pick('removed'),
    notRun: pick('not-run'),
    unchanged: { pass: same.filter((r) => r.newStatus === 'pass').length, fail: same.filter((r) => r.newStatus !== 'pass' && r.newStatus !== 'skipped').length },
    score: { base: base.summary.score, next: next.summary.score, delta: delta(scoreOver(base, shared), scoreOver(next, shared)) },
    latency: { base: base.summary.latencyP50, next: next.summary.latencyP50, delta: delta(base.summary.latencyP50, next.summary.latencyP50) },
  }
  return { ...result, gate: gate(result, next, opts) }
}

/** Weighted score (0 to 100) of a run over some case ids. */
function scoreOver(run, ids) {
  const wanted = new Set(ids)
  const counted = run.cases.filter((c) => wanted.has(c.id) && c.score !== null && c.score !== undefined)
  const total = counted.reduce((sum, c) => sum + (c.weight ?? 1), 0)
  return total ? round((counted.reduce((sum, c) => sum + c.score * (c.weight ?? 1), 0) / total) * 100, 1) : null
}

/** Must-pass cases that did not pass. A skipped must-pass case counts: nothing proved it passes. */
export function mustPassFailures(run, tag = GATE_DEFAULTS.mustPassTag) {
  return run.cases.filter((c) => (c.tags ?? []).includes(tag) && c.status !== 'pass').map((c) => c.id)
}

/** The rules that need no baseline: must-pass cases, cases with no answer, a run that answered nothing. */
export function standaloneReasons(run, opts = {}) {
  const { mustPassTag, maxErrors } = { ...GATE_DEFAULTS, ...opts }
  const reasons = []
  const errored = run.cases.filter((c) => c.status === 'error').map((c) => c.id)
  const answered = run.cases.filter((c) => c.attempts.some((a) => !a.error && (String(a.answer ?? '').trim() || a.toolCalls?.length)))
  if (run.cases.length && !answered.length) reasons.push(`no case got an answer from the target (${plural(run.cases.length, 'case')} asked)`)
  if (errored.length > maxErrors) reasons.push(`${plural(errored.length, 'case')} got no answer because of an error (allowed: ${maxErrors}): ${idList(errored)}`)
  const broken = mustPassFailures(run, mustPassTag)
  if (broken.length) reasons.push(`"${mustPassTag}" ${broken.length === 1 ? 'case' : 'cases'} not passing: ${idList(broken)}`)
  return reasons
}

/** The gate for a first run, with nothing to compare against. */
export function standaloneGate(run, opts = {}) {
  const reasons = standaloneReasons(run, opts)
  return { ok: reasons.length === 0, reasons }
}

function gate(result, next, opts) {
  const reasons = []
  const worse = result.regressions
  if (worse.length > opts.maxRegressions) {
    const names = worse.map((r) => (r.newCase ? `${r.id} (new, ${r.newStatus})` : r.id))
    reasons.push(`${plural(worse.length, 'case')} got worse (allowed: ${opts.maxRegressions}): ${idList(names)}`)
  }
  if (!opts.allowRemoved && result.removed.length) {
    reasons.push(`${plural(result.removed.length, 'baseline case')} missing from this run, renamed or deleted (allow with --allow-removed): ${idList(result.removed.map((r) => r.id))}`)
  }
  const drop = result.score.delta === null ? 0 : -result.score.delta
  if (opts.maxScoreDrop !== null && drop > opts.maxScoreDrop) reasons.push(`the score fell by ${round(drop)} points (allowed: ${opts.maxScoreDrop})`)
  const { base, delta: slower } = result.latency
  if (opts.maxLatencyIncreasePct !== null && base > 0 && slower !== null && (slower / base) * 100 > opts.maxLatencyIncreasePct) {
    reasons.push(`median latency rose by ${round((slower / base) * 100)}% (allowed: ${opts.maxLatencyIncreasePct}%)`)
  }
  reasons.push(...standaloneReasons(next, opts))
  return { ok: reasons.length === 0, reasons }
}
