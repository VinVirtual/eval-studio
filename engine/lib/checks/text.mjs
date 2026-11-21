// Checks on the answer text: contains, not-contains, regex, exact, refusal, max-length.

/** Straight quotes, single spaces, trimmed, and lower case unless caseSensitive. */
import { matchWithTimeLimit, riskyPattern, REGEX_TIME_LIMIT_MS } from './safe-regex.mjs'

export function norm(text, caseSensitive = false) {
  const flat = String(text ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return caseSensitive ? flat : flat.toLowerCase()
}

export const quote = (list) => [].concat(list).map((v) => `"${v}"`).join(', ')
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const isTextList = (v) => Array.isArray(v) && v.length > 0 && v.every(isText)

function wanted(check, listKeys) {
  const given = ['value', ...listKeys].filter((k) => check[k] !== undefined)
  if (given.length !== 1) return [`give exactly one of: value, ${listKeys.join(', ')}`]
  const key = given[0]
  if (key === 'value') return isText(check.value) ? [] : ['value must be a non-empty string']
  return isTextList(check[key]) ? [] : [`${key} must be a list of non-empty strings`]
}

export function compileRegex(pattern, flags = 'i') {
  return new RegExp(pattern, flags)
}

const REFUSAL_PHRASES = [
  /\bi (?:can't|cannot|can not|won't|will not|am not able to|am unable to|'m not able to|'m unable to)\b/,
  /\b(?:can't|cannot|unable to|not able to) (?:help|assist|answer|provide|share|do that|discuss)\b/,
  /\bi (?:don't|do not) (?:know|have (?:that|any|enough|the) (?:information|details))\b/,
  /\b(?:i'm sorry|i am sorry|sorry|i apologi[sz]e),? but\b/,
  /\bnot (?:something|a (?:question|topic|request)) i can\b/,
  /\boutside (?:of )?(?:what i|my|the) (?:can|scope|knowledge|remit)\b/,
  /\bnot (?:allowed|permitted|able) to (?:share|help|answer|provide|discuss)\b/,
]

/** The phrase that makes this text read as a refusal, or null. Extra phrases are plain text. */
export function refusalPhrase(text, extra = []) {
  const flat = norm(text)
  for (const pattern of REFUSAL_PHRASES) {
    const m = flat.match(pattern)
    if (m) return m[0]
  }
  return extra.find((p) => flat.includes(norm(p))) ?? null
}

const countWords = (text) => (String(text).trim().match(/\S+/g) ?? []).length

export const textChecks = {
  contains: {
    validate: (c) => wanted(c, ['all', 'any']),
    describe: (c) => (c.any ? `contains any of ${quote(c.any)}` : `contains ${quote(c.all ?? c.value)}`),
    run(c, attempt) {
      const text = norm(attempt.answer, c.caseSensitive)
      const has = (v) => text.includes(norm(v, c.caseSensitive))
      if (c.any) {
        const hit = c.any.find(has)
        return { pass: Boolean(hit), detail: hit ? `found "${hit}"` : 'none of the phrases is in the answer' }
      }
      const all = c.all ?? [c.value]
      const missing = all.filter((v) => !has(v))
      return {
        pass: missing.length === 0,
        score: (all.length - missing.length) / all.length,
        detail: missing.length ? `missing ${quote(missing)}` : `found ${quote(all)}`,
      }
    },
  },

  'not-contains': {
    validate: (c) => wanted(c, ['any']),
    describe: (c) => `does not contain ${quote(c.any ?? c.value)}`,
    run(c, attempt) {
      const text = norm(attempt.answer, c.caseSensitive)
      const found = (c.any ?? [c.value]).filter((v) => text.includes(norm(v, c.caseSensitive)))
      return { pass: found.length === 0, detail: found.length ? `found ${quote(found)}` : 'none found' }
    },
  },

  regex: {
    validate(c) {
      if (!isText(c.pattern)) return ['pattern must be a non-empty string']
      try { compileRegex(c.pattern, c.flags) } catch (e) { return [`pattern is not a valid regular expression: ${e.message}`] }
      const risky = riskyPattern(c.pattern)
      if (risky) return [`pattern ${risky}`]
      if (c.timeoutMs !== undefined && !(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0)) return ['timeoutMs must be a number above 0']
      return []
    },
    describe: (c) => `matches /${c.pattern}/${c.flags ?? 'i'}`,
    async run(c, attempt) {
      const limit = c.timeoutMs ?? REGEX_TIME_LIMIT_MS
      const out = await matchWithTimeLimit(c.pattern, c.flags ?? 'i', String(attempt.answer ?? ''), limit)
      if (out.timedOut) return { pass: false, detail: `the pattern took longer than ${limit} ms and was stopped; simplify it` }
      if (out.error) return { pass: false, detail: `the pattern could not run: ${out.error}` }
      return { pass: out.match !== null, detail: out.match !== null ? `matched "${out.match}"` : 'no match' }
    },
  },

  exact: {
    validate: (c) => (typeof c.value === 'string' ? [] : ['value must be a string']),
    describe: (c) => `is exactly "${c.value}"${c.ignoreCase ? ' (any case)' : ''}`,
    run(c, attempt) {
      const same = norm(attempt.answer, !c.ignoreCase) === norm(c.value, !c.ignoreCase)
      return { pass: same, detail: same ? 'same text' : 'different text' }
    },
  },

  refusal: {
    validate(c) {
      if (c.expected !== undefined && typeof c.expected !== 'boolean') return ['expected must be true or false']
      if (c.phrases !== undefined && !isTextList(c.phrases)) return ['phrases must be a list of non-empty strings']
      return []
    },
    describe: (c) => (c.expected === false ? 'answers, does not refuse' : 'refuses'),
    run(c, attempt) {
      const phrase = refusalPhrase(attempt.answer, c.phrases)
      const expectRefusal = c.expected !== false
      const detail = phrase ? `reads as a refusal ("${phrase}")` : 'no refusal phrase found'
      return { pass: Boolean(phrase) === expectRefusal, detail }
    },
  },

  'max-length': {
    validate(c) {
      const limits = ['chars', 'words'].filter((k) => c[k] !== undefined)
      if (!limits.length) return ['give chars, words or both']
      return limits.filter((k) => !(Number.isFinite(c[k]) && c[k] > 0)).map((k) => `${k} must be a number above 0`)
    },
    describe: (c) => `at most ${[c.chars && `${c.chars} characters`, c.words && `${c.words} words`].filter(Boolean).join(' and ')}`,
    run(c, attempt) {
      const chars = String(attempt.answer ?? '').length
      const words = countWords(attempt.answer ?? '')
      const over = [c.chars !== undefined && chars > c.chars, c.words !== undefined && words > c.words].some(Boolean)
      return { pass: !over, detail: `${chars} characters, ${words} words` }
    },
  },
}
