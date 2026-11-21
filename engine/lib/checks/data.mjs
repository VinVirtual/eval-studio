// Checks on structured answers and measurements: json, number, max-latency.
import { isObj, getPath } from '../util.mjs'

const TYPE_NAMES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null', 'any']
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** The JSON value in an answer: the whole text, a fenced block, or the first {...} or [...] span. */
export function extractJson(text) {
  const src = String(text ?? '').trim()
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const span = src.match(/[{[][\s\S]*[}\]]/)
  for (const candidate of [src, fenced?.[1], span?.[0]]) {
    if (!candidate) continue
    try { return { ok: true, value: JSON.parse(candidate) } } catch { /* try the next candidate */ }
  }
  return { ok: false }
}

/** What is wrong in a shape description itself (for lint). */
export function shapeProblems(shape, path = 'shape') {
  if (typeof shape === 'string') return TYPE_NAMES.includes(shape.replace(/\?$/, '')) ? [] : [`${path}: "${shape}" is not a type (use ${TYPE_NAMES.join(', ')}; add ? for optional)`]
  if (Array.isArray(shape)) return shape.length > 1 ? [`${path}: a list shape takes one item shape`] : shape.flatMap((s) => shapeProblems(s, `${path}[]`))
  if (isObj(shape)) return Object.entries(shape).flatMap(([k, s]) => shapeProblems(s, `${path}.${k}`))
  return [`${path}: use a type name, an object or a one-item list`]
}

/** Where a value does not fit a shape. Shapes: "string", "number?", { key: shape }, [itemShape]. */
export function shapeErrors(value, shape, path = '$') {
  if (typeof shape === 'string') {
    const optional = shape.endsWith('?')
    const want = shape.replace(/\?$/, '')
    if (value === undefined) return optional ? [] : [`${path} is missing`]
    const got = typeOf(value)
    const fits = want === 'any' || got === want || (want === 'integer' && Number.isInteger(value))
    return fits ? [] : [`${path} should be ${want}, is ${got}`]
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${path} should be array, is ${value === undefined ? 'missing' : typeOf(value)}`]
    return shape.length ? value.flatMap((v, i) => shapeErrors(v, shape[0], `${path}[${i}]`)) : []
  }
  if (!isObj(value)) return [`${path} should be object, is ${value === undefined ? 'missing' : typeOf(value)}`]
  return Object.entries(shape).flatMap(([key, s]) => shapeErrors(value[key], s, `${path}.${key}`))
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// A "-" is a minus sign only when it does not follow a letter, digit, underscore or dot, so
// "pages 5-10", "2026-01-31" and "COVID-19" give 5 and 10, 2026, 1 and 31, and 19.
// A comma is read as a thousands separator only before exactly three digits ("2,500" is 2500);
// decimal commas are not understood ("1,5" reads as 1 and 5): write the expected value with a dot.
const NUMBER = /(?:(?<![\w.])-)?(?<![\d.])(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g
export const numbersIn = (text) => (String(text ?? '').match(NUMBER) ?? []).map((n) => Number(n.replace(/,/g, '')))

const MAX_ERRORS_SHOWN = 4

export const dataChecks = {
  json: {
    validate(c) {
      if (c.shape === undefined && c.values === undefined) return ['give shape, values or both']
      const problems = c.shape === undefined ? [] : shapeProblems(c.shape)
      return c.values !== undefined && !isObj(c.values) ? [...problems, 'values must be an object of path: expected value'] : problems
    },
    describe: (c) => `is JSON${c.shape === undefined ? '' : ` shaped like ${JSON.stringify(c.shape)}`}${c.values ? ` with ${JSON.stringify(c.values)}` : ''}`,
    run(c, attempt) {
      const parsed = extractJson(attempt.answer)
      if (!parsed.ok) return { pass: false, detail: 'the answer is not JSON' }
      const shapeFaults = c.shape === undefined ? [] : shapeErrors(parsed.value, c.shape)
      const valueFaults = Object.entries(c.values ?? {})
        .filter(([path, want]) => !sameValue(getPath(parsed.value, path), want))
        .map(([path, want]) => `$.${path} should be ${JSON.stringify(want)}, is ${JSON.stringify(getPath(parsed.value, path))}`)
      const faults = [...shapeFaults, ...valueFaults]
      const shown = faults.slice(0, MAX_ERRORS_SHOWN).join('; ') + (faults.length > MAX_ERRORS_SHOWN ? `; and ${faults.length - MAX_ERRORS_SHOWN} more` : '')
      return { pass: faults.length === 0, detail: faults.length ? shown : 'valid JSON, shape fits' }
    },
  },

  number: {
    validate(c) {
      const problems = []
      if (!Number.isFinite(c.value)) problems.push('value must be a number')
      for (const key of ['tolerance', 'tolerancePct']) if (c[key] !== undefined && !(Number.isFinite(c[key]) && c[key] >= 0)) problems.push(`${key} must be a number of 0 or more`)
      if (c.pick !== undefined && !['any', 'first', 'last'].includes(c.pick)) problems.push('pick must be any, first or last')
      return problems
    },
    describe(c) {
      const band = c.tolerancePct !== undefined ? ` within ${c.tolerancePct}%` : c.tolerance ? ` within ${c.tolerance}` : ''
      return `${c.pick && c.pick !== 'any' ? `${c.pick} number` : 'a number'} is ${c.value}${band}`
    },
    run(c, attempt) {
      const found = numbersIn(attempt.answer)
      if (!found.length) return { pass: false, detail: 'no number in the answer' }
      const allowed = Math.max(c.tolerance ?? 0, c.tolerancePct === undefined ? 0 : Math.abs(c.value) * (c.tolerancePct / 100))
      const pool = c.pick === 'first' ? [found[0]] : c.pick === 'last' ? [found.at(-1)] : found
      const nearest = pool.reduce((best, n) => (Math.abs(n - c.value) < Math.abs(best - c.value) ? n : best))
      const pass = Math.abs(nearest - c.value) <= allowed + Number.EPSILON
      return { pass, detail: pass ? `found ${nearest}` : `nearest number is ${nearest}` }
    },
  },

  'max-latency': {
    validate: (c) => (Number.isFinite(c.ms) && c.ms > 0 ? [] : ['ms must be a number above 0']),
    describe: (c) => `answers within ${c.ms} ms`,
    run: (c, attempt) => ({ pass: attempt.latencyMs <= c.ms, detail: `took ${attempt.latencyMs} ms` }),
  },
}
