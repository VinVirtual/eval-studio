// Loads test cases from .jsonl, .json or .csv and puts them in one shape.
import { readFileSync, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { csvToCases } from './csv.mjs'
import { isObj, UsageError } from './util.mjs'

function parseJsonl(text) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) return []
    try { return [JSON.parse(trimmed)] } catch (e) { throw new UsageError(`cases line ${i + 1}: not valid JSON (${e.message})`) }
  })
}

function parseJson(text) {
  let data
  try { data = JSON.parse(text) } catch (e) { throw new UsageError(`cases file: not valid JSON (${e.message})`) }
  const list = Array.isArray(data) ? data : data?.cases
  if (!Array.isArray(list)) throw new UsageError('cases file: expected an array of cases, or an object with a "cases" array')
  return list
}

const toTags = (tags) => (Array.isArray(tags) ? tags.map(String) : typeof tags === 'string' ? tags.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [])

/** One shape for every case. Nothing is checked here; lint reports what is wrong. */
export function normalizeCase(raw) {
  const c = isObj(raw) ? raw : {}
  return {
    ...c,
    id: c.id === undefined || c.id === null ? '' : String(c.id),
    input: typeof c.input === 'string' ? c.input : '',
    tags: toTags(c.tags),
    weight: c.weight === undefined ? 1 : c.weight,
    checks: Array.isArray(c.checks) ? c.checks : [],
  }
}

/** -> { cases, warnings } */
export function loadCases(file) {
  if (!existsSync(file)) throw new UsageError(`cases file not found: ${file}`)
  const text = readFileSync(file, 'utf8')
  const ext = extname(file).toLowerCase()
  if (ext === '.csv') {
    const { cases, warnings } = csvToCases(text)
    return { cases: cases.map(normalizeCase), warnings }
  }
  const list = ext === '.jsonl' || ext === '.ndjson' ? parseJsonl(text) : parseJson(text)
  return { cases: list.map(normalizeCase), warnings: [] }
}

export const toJsonl = (cases) => cases.map((c) => JSON.stringify(c)).join('\n') + '\n'

/** Keep only the cases that carry one of the tags, or every case when no tag is asked for. */
export function filterByTags(cases, tags) {
  if (!tags?.length) return cases
  return cases.filter((c) => c.tags.some((t) => tags.includes(t)))
}
