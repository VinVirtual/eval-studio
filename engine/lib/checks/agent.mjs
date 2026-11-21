// Checks for retrieval systems and agents: source (retrieval hit with rank), tool-call, no-tool-call.
import { isObj } from '../util.mjs'
import { norm, quote } from './text.mjs'

const sameId = (a, b) => norm(a) === norm(b)
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Is the id written in the answer as a word of its own, for example "[fees]" or "(see fees.md)"? */
export function citedIn(answer, id) {
  return new RegExp(`(^|[^\\w-])${escapeRegex(norm(id))}($|[^\\w-])`).test(norm(answer))
}

/**
 * Compares tool arguments loosely. A string matches when the actual value contains it (any case),
 * or matches it as a regular expression when written "/like this/". Numbers and booleans must be
 * equal. Objects are compared key by key, and extra keys in the actual call are fine.
 * -> list of mismatches, empty when the arguments fit.
 */
export function argsLike(expected, actual, path = 'arguments') {
  if (typeof expected === 'string') {
    const asRegex = expected.match(/^\/(.+)\/([a-z]*)$/)
    const text = typeof actual === 'string' ? actual : JSON.stringify(actual ?? null)
    const fits = asRegex ? new RegExp(asRegex[1], asRegex[2] || 'i').test(text) : actual !== undefined && norm(text).includes(norm(expected))
    return fits ? [] : [`${path} should be like "${expected}", is ${JSON.stringify(actual)}`]
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path} should be a list, is ${JSON.stringify(actual)}`]
    return expected.flatMap((want, i) => (actual.some((got) => argsLike(want, got).length === 0) ? [] : [`${path}[${i}] has no match for ${JSON.stringify(want)}`]))
  }
  if (isObj(expected)) {
    if (!isObj(actual)) return [`${path} should be an object, is ${JSON.stringify(actual)}`]
    return Object.entries(expected).flatMap(([key, want]) => argsLike(want, actual[key], `${path}.${key}`))
  }
  return expected === actual || (typeof expected === 'number' && Number(actual) === expected) ? [] : [`${path} should be ${JSON.stringify(expected)}, is ${JSON.stringify(actual)}`]
}

const callsNamed = (attempt, name) => (attempt.toolCalls ?? []).filter((call) => sameId(call.name, name))
const namesCalled = (attempt) => [...new Set((attempt.toolCalls ?? []).map((call) => call.name))]

export const agentChecks = {
  source: {
    validate(c) {
      const problems = []
      if (!(typeof c.id === 'string' && c.id.trim())) problems.push('id must be a non-empty string')
      if (c.maxRank !== undefined && !(Number.isInteger(c.maxRank) && c.maxRank >= 1)) problems.push('maxRank must be a whole number of 1 or more')
      if (c.where !== undefined && !['retrieved', 'cited', 'either'].includes(c.where)) problems.push('where must be retrieved, cited or either')
      return problems
    },
    describe(c) {
      const where = { cited: 'cites', either: 'retrieves or cites' }[c.where] ?? 'retrieves'
      return `${where} source "${c.id}"${c.maxRank ? ` in the top ${c.maxRank}` : ''}`
    },
    run(c, attempt) {
      const where = c.where ?? 'retrieved'
      const sources = attempt.sources ?? []
      const rank = sources.findIndex((s) => sameId(s.id, c.id)) + 1
      const cited = where !== 'retrieved' && citedIn(attempt.answer, c.id)
      const hit = rank > 0 && (!c.maxRank || rank <= c.maxRank)
      const got = sources.length ? `retrieved: ${sources.map((s) => s.id).join(', ')}` : 'nothing was retrieved'
      const rankText = rank > 0 ? `retrieved at rank ${rank} of ${sources.length}` : `not retrieved (${got})`
      if (where === 'cited') return { pass: cited, detail: cited ? 'cited in the answer' : 'not cited in the answer' }
      if (where === 'either' && cited) return { pass: true, rank: rank || null, detail: `cited in the answer; ${rankText}` }
      return { pass: hit, rank: rank || null, detail: rankText + (rank > 0 && !hit ? `, needed the top ${c.maxRank}` : '') }
    },
  },

  'tool-call': {
    validate(c) {
      const problems = []
      if (!(typeof c.name === 'string' && c.name.trim())) problems.push('name must be a non-empty string')
      if (c.args !== undefined && !isObj(c.args)) problems.push('args must be an object')
      for (const key of ['min', 'max']) if (c[key] !== undefined && !(Number.isInteger(c[key]) && c[key] >= 0)) problems.push(`${key} must be a whole number of 0 or more`)
      return problems
    },
    describe: (c) => `calls tool ${c.name}${c.args ? ` with arguments like ${JSON.stringify(c.args)}` : ''}`,
    run(c, attempt) {
      const calls = callsNamed(attempt, c.name)
      if (!calls.length) {
        const others = namesCalled(attempt)
        return { pass: false, detail: others.length ? `not called (called: ${others.join(', ')})` : 'no tool was called' }
      }
      const fitting = c.args ? calls.filter((call) => argsLike(c.args, call.arguments).length === 0) : calls
      if (!fitting.length) return { pass: false, detail: argsLike(c.args, calls[0].arguments).join('; ') }
      const count = fitting.length
      if (count < (c.min ?? 1)) return { pass: false, detail: `called ${count} time(s), needed at least ${c.min}` }
      if (c.max !== undefined && count > c.max) return { pass: false, detail: `called ${count} time(s), allowed at most ${c.max}` }
      return { pass: true, detail: `called ${count} time(s)${c.args ? ', arguments fit' : ''}` }
    },
  },

  'no-tool-call': {
    validate(c) {
      if (c.name !== undefined && !(typeof c.name === 'string' && c.name.trim())) return ['name must be a non-empty string']
      if (c.any !== undefined && !(Array.isArray(c.any) && c.any.length)) return ['any must be a list of tool names']
      return []
    },
    describe: (c) => (c.name || c.any ? `does not call ${quote(c.any ?? c.name)}` : 'calls no tool'),
    run(c, attempt) {
      const banned = c.any ?? (c.name ? [c.name] : null)
      const called = banned ? banned.filter((name) => callsNamed(attempt, name).length) : namesCalled(attempt)
      return { pass: called.length === 0, detail: called.length ? `called ${called.join(', ')}` : 'not called' }
    },
  },
}
