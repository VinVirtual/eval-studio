// The check registry. A check type has validate (for lint), describe (for people) and run.
import { textChecks } from './text.mjs'
import { dataChecks } from './data.mjs'
import { agentChecks } from './agent.mjs'
import { judgeChecks } from './judge.mjs'

export const CHECKS = { ...textChecks, ...dataChecks, ...agentChecks, ...judgeChecks }
export const checkTypes = () => Object.keys(CHECKS)
export const isModelJudged = (type) => Boolean(CHECKS[type]?.modelJudged)

/** Problems in one check definition; empty when it is usable. */
export function validateCheck(check) {
  if (check === null || typeof check !== 'object' || Array.isArray(check)) return ['a check must be an object with a "type"']
  const def = CHECKS[check.type]
  if (!def) return [`unknown check type "${check.type}" (known: ${checkTypes().join(', ')})`]
  const problems = def.validate(check)
  return check.weight !== undefined && !(Number.isFinite(check.weight) && check.weight > 0) ? [...problems, 'weight must be a number above 0'] : problems
}

export function describeCheck(check) {
  const def = CHECKS[check?.type]
  return def && def.validate(check).length === 0 ? def.describe(check) : String(check?.type ?? 'check')
}

/**
 * Apply every check of a case to one attempt.
 * -> [{ type, expected, pass (true, false, or null when skipped), score 0..1, weight, detail, modelJudged?, rank? }]
 */
export async function runChecks(caseDef, attempt, ctx = {}) {
  const results = []
  for (const check of caseDef.checks ?? []) {
    const base = { type: check.type, expected: describeCheck(check), weight: check.weight ?? 1, ...(isModelJudged(check.type) ? { modelJudged: true } : {}) }
    const problems = validateCheck(check)
    if (problems.length) {
      results.push({ ...base, pass: false, score: 0, detail: `check is not usable: ${problems.join('; ')}` })
      continue
    }
    const out = await CHECKS[check.type].run(check, attempt, { ...ctx, case: caseDef })
    const score = out.pass === null ? null : out.score ?? (out.pass ? 1 : 0)
    results.push({ ...base, ...out, score })
  }
  return results
}
