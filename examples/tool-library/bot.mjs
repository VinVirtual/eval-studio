// A tiny question-answer bot for the example. No model, no key, no network.
// It finds the handbook sentence that shares the most (and rarest) words with the question and
// returns it, with the documents it looked at. It is simple on purpose, so some cases fail.
//
// Two builds are kept so the example has something to compare:
//   v1  counts every word, common ones included, and answers whenever any word matches
//   v2  ignores common words and refuses unless at least two meaningful words match
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DOCS_DIR = fileURLToPath(new URL('./docs/', import.meta.url))
const REFUSAL = "I can't answer that from the tool library handbook."
const HELP = 'Ask me about opening hours, borrowing, fees, membership or safety.'
const TOP_SOURCES = 3
const MIN_MATCHES_V2 = 2
const COMMON_WORDS = new Set('a an and are as at be by can do does for from how i if in is it me my of on or the to up what when which who will with you your'.split(' '))
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

const passages = readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md')).sort().flatMap((name) =>
  readFileSync(DOCS_DIR + name, 'utf8').split('\n').filter((line) => line.trim()).map((text) => ({ doc: name.replace(/\.md$/, ''), text: text.trim() })))

const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? []
const stem = (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
const termsOf = (text, variant) => (variant === 'v1' ? words(text) : words(text).filter((w) => !COMMON_WORDS.has(w)).map(stem))

/** Rare words count for more than words found in many passages. */
function weights(variant) {
  const seenIn = new Map()
  for (const p of passages) for (const term of new Set(termsOf(p.text, variant))) seenIn.set(term, (seenIn.get(term) ?? 0) + 1)
  return (term) => (seenIn.has(term) ? Math.log(1 + passages.length / seenIn.get(term)) : 0)
}

function retrieve(question, variant) {
  const weight = weights(variant)
  const asked = new Set(termsOf(question, variant))
  return passages
    .map((p) => {
      const shared = [...new Set(termsOf(p.text, variant))].filter((term) => asked.has(term))
      return { ...p, matches: shared.length, score: Number(shared.reduce((sum, term) => sum + weight(term), 0).toFixed(2)) }
    })
    .filter((p) => p.matches > 0)
    .sort((a, b) => b.score - a.score)
}

/** One entry per document, best passage first. */
function sourcesFrom(ranked) {
  const seen = new Set()
  return ranked.filter((p) => !seen.has(p.doc) && seen.add(p.doc)).slice(0, TOP_SOURCES).map((p) => ({ id: p.doc, text: p.text, score: p.score }))
}

/** "Reserve a ladder for Saturday" -> a reserve_tool call. Only the word "reserve" at the start is understood. */
function reservation(question) {
  const m = question.match(/^\s*(?:please\s+)?reserve\s+(?:a|an|the)?\s*([a-z ]+?)\s+for\s+([a-z]+)/i)
  if (!m || !DAYS.includes(m[2].toLowerCase())) return null
  return { name: 'reserve_tool', arguments: { tool: m[1].toLowerCase(), day: m[2].toLowerCase() } }
}

export function answer(question, context = {}) {
  const variant = context.options?.variant === 'v1' ? 'v1' : 'v2'
  if (/^\s*help\s*$/i.test(question)) return { answer: HELP, sources: [], toolCalls: [] }
  const call = reservation(question)
  if (call) return { answer: `I have asked for the ${call.arguments.tool} to be held for ${call.arguments.day}.`, sources: [], toolCalls: [call] }
  const ranked = retrieve(question, variant)
  const best = ranked[0]
  const enough = variant === 'v1' ? Boolean(best) : best?.matches >= MIN_MATCHES_V2
  if (!enough) return { answer: REFUSAL, sources: sourcesFrom(ranked), toolCalls: [] }
  const text = /\bjson\b/i.test(question) ? JSON.stringify({ answer: best.text, source: best.doc }) : best.text
  return { answer: text, sources: sourcesFrom(ranked), toolCalls: [] }
}
