// Lint: what is wrong with the cases and the target before anything is run.
// An issue is { level: 'error' | 'warn' | 'info', rule, where, message }.
import { validateCheck, isModelJudged } from './checks/index.mjs'
import { GATE_DEFAULTS } from './compare.mjs'
import { isObj } from './util.mjs'

const CASE_FIELDS = new Set(['id', 'input', 'tags', 'weight', 'checks', 'expected', 'note', 'vars', 'messages', 'threshold'])
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const issue = (level, rule, where, message) => ({ level, rule, where, message })

function lintCase(c, index) {
  const where = c.id || `case ${index + 1}`
  const out = []
  if (!c.id) out.push(issue('error', 'id', where, 'has no id'))
  else if (!ID_SHAPE.test(c.id)) out.push(issue('warn', 'id', where, 'id should use only letters, digits, dot, dash and underscore'))
  if (!c.input.trim() && !Array.isArray(c.messages)) out.push(issue('error', 'input', where, 'has no input (the question to ask)'))
  if (!(Number.isFinite(c.weight) && c.weight > 0)) out.push(issue('error', 'weight', where, 'weight must be a number above 0'))
  if (c.threshold !== undefined && !(Number.isFinite(c.threshold) && c.threshold > 0 && c.threshold <= 1)) out.push(issue('error', 'threshold', where, 'threshold must be above 0 and at most 1'))
  if (!c.checks.length) out.push(issue('error', 'no-check', where, 'has no check, so it can never fail'))
  c.checks.forEach((check, i) => {
    const unknown = isObj(check) && typeof check.type === 'string' && /unknown check type/.test(validateCheck(check)[0] ?? '')
    for (const problem of validateCheck(check)) out.push(issue('error', unknown ? 'unknown-check' : 'check', `${where} checks[${i}]`, problem))
  })
  if (c.checks.length && c.checks.every((k) => isModelJudged(k?.type))) out.push(issue('warn', 'judge-only', where, 'has only model-judged checks; add at least one plain check'))
  for (const key of Object.keys(c)) if (!CASE_FIELDS.has(key)) out.push(issue('warn', 'field', where, `unknown field "${key}"`))
  return out
}

/** Checks on the cases alone. options: { judgeEnabled, mustPassTag } */
export function lintCases(cases, options = {}) {
  const mustPassTag = options.mustPassTag ?? GATE_DEFAULTS.mustPassTag
  const out = []
  if (!cases.length) return [issue('error', 'empty', 'cases', 'there are no cases')]
  const seen = new Map()
  cases.forEach((c, i) => {
    if (c.id && seen.has(c.id)) out.push(issue('error', 'duplicate-id', c.id, `id is used twice (cases ${seen.get(c.id) + 1} and ${i + 1})`))
    else if (c.id) seen.set(c.id, i)
    out.push(...lintCase(c, i))
  })
  const judged = cases.filter((c) => c.checks.some((k) => isModelJudged(k?.type))).length
  if (judged && !options.judgeEnabled) out.push(issue('info', 'judge-off', 'cases', `${judged} case(s) have a model-judged check; these are skipped because the judge is off`))
  if (!cases.some((c) => c.tags.includes(mustPassTag))) out.push(issue('info', 'must-pass', 'cases', `no case is tagged "${mustPassTag}"; tag the few that must never fail`))
  return out
}

/** Checks on the target: config shape, environment variables it needs, and whether it answers. */
export async function lintTarget({ adapter, adapterError, env = process.env, offline = false, judge }) {
  if (adapterError) return [issue('error', 'target', 'target', adapterError)]
  const out = []
  const missing = adapter.envNames.filter((name) => !env[name])
  for (const name of missing) out.push(issue('error', 'env', 'target', `environment variable ${name} is not set`))
  if (judge?.enabled) {
    if (!judge.baseUrl || !judge.model) out.push(issue('error', 'judge', 'judge', 'judge is on but judge.baseUrl or judge.model is missing'))
    if (judge.apiKeyEnv && !env[judge.apiKeyEnv]) out.push(issue('error', 'env', 'judge', `environment variable ${judge.apiKeyEnv} is not set`))
  }
  if (offline) return [...out, issue('info', 'reach', 'target', 'not checked whether the target answers (--offline)')]
  if (missing.length) return out
  const probe = await adapter.probe()
  return probe.ok ? out : [...out, issue('error', 'unreachable', 'target', probe.reason)]
}

export const countLevel = (issues, level) => issues.filter((i) => i.level === level).length

export function formatIssues(issues) {
  if (!issues.length) return 'lint: no problems found'
  const lines = issues.map((i) => `${i.level.padEnd(5)} ${i.where}: ${i.message}  [${i.rule}]`)
  return [...lines, `lint: ${countLevel(issues, 'error')} error(s), ${countLevel(issues, 'warn')} warning(s)`].join('\n')
}
