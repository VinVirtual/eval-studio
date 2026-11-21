// CSV in, test cases out. One row is one case; the column names pick the checks.
import { UsageError } from './util.mjs'

/** RFC 4180 style parser: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF, a leading BOM. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += ch
  }
  if (quoted) throw new UsageError('CSV: a quoted field is never closed')
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

const split = (cell, sep = '|') => cell.split(sep).map((s) => s.trim()).filter(Boolean)
const truthy = (cell) => /^(1|true|yes|y)$/i.test(cell.trim())
const number = (cell, column) => {
  const n = Number(cell)
  if (!Number.isFinite(n)) throw new UsageError(`CSV: column ${column} needs a number, got "${cell}"`)
  return n
}
const json = (cell, column) => {
  try { return JSON.parse(cell) } catch { throw new UsageError(`CSV: column ${column} needs JSON, got "${cell}"`) }
}

/** column name -> how it changes the case being built. `|` separates several values in one cell. */
const COLUMNS = {
  id: (c, v) => ({ ...c, id: v.trim() }),
  input: (c, v) => ({ ...c, input: v }),
  expected: (c, v) => ({ ...c, expected: v }),
  note: (c, v) => ({ ...c, note: v }),
  tags: (c, v) => ({ ...c, tags: v.split(/[;|,]/).map((s) => s.trim()).filter(Boolean) }),
  weight: (c, v) => ({ ...c, weight: number(v, 'weight') }),
  contains: (c, v) => addCheck(c, split(v).length > 1 ? { type: 'contains', all: split(v) } : { type: 'contains', value: v.trim() }),
  contains_any: (c, v) => addCheck(c, { type: 'contains', any: split(v) }),
  not_contains: (c, v) => addCheck(c, split(v).length > 1 ? { type: 'not-contains', any: split(v) } : { type: 'not-contains', value: v.trim() }),
  regex: (c, v) => addCheck(c, { type: 'regex', pattern: v }),
  exact: (c, v) => addCheck(c, { type: 'exact', value: v }),
  json_shape: (c, v) => addCheck(c, { type: 'json', shape: json(v, 'json_shape') }),
  number: (c, v) => addCheck(c, { type: 'number', value: number(v, 'number') }),
  tolerance: (c, v) => patchCheck(c, 'number', { tolerance: number(v, 'tolerance') }, 'tolerance needs a number column before it'),
  source: (c, v) => {
    const [id, rank] = v.split('@').map((s) => s.trim())
    return addCheck(c, rank ? { type: 'source', id, maxRank: number(rank, 'source') } : { type: 'source', id })
  },
  tool: (c, v) => addCheck(c, { type: 'tool-call', name: v.trim() }),
  tool_args: (c, v) => patchCheck(c, 'tool-call', { args: json(v, 'tool_args') }, 'tool_args needs a tool column before it'),
  no_tool: (c, v) => addCheck(c, /^(\*|any|all)$/i.test(v.trim()) ? { type: 'no-tool-call' } : { type: 'no-tool-call', name: v.trim() }),
  refusal: (c, v) => addCheck(c, { type: 'refusal', expected: truthy(v) }),
  max_latency_ms: (c, v) => addCheck(c, { type: 'max-latency', ms: number(v, 'max_latency_ms') }),
  max_chars: (c, v) => addCheck(c, { type: 'max-length', chars: number(v, 'max_chars') }),
  max_words: (c, v) => addCheck(c, { type: 'max-length', words: number(v, 'max_words') }),
  judge: (c, v) => addCheck(c, { type: 'judge', rubric: v }),
}
const ALIASES = { question: 'input', prompt: 'input', query: 'input', tag: 'tags', must_contain: 'contains', must_not_contain: 'not_contains', expected_source: 'source', rubric: 'judge' }

const addCheck = (c, check) => ({ ...c, checks: [...c.checks, check] })
function patchCheck(c, type, patch, complaint) {
  const at = c.checks.findLastIndex((k) => k.type === type)
  if (at < 0) throw new UsageError(`CSV: ${complaint}`)
  return { ...c, checks: c.checks.map((k, i) => (i === at ? { ...k, ...patch } : k)) }
}

export const csvColumns = () => Object.keys(COLUMNS)

/** -> { cases, warnings }. Empty cells are skipped. Rows with no id are numbered row-2, row-3, ... */
export function csvToCases(text) {
  const [header, ...rows] = parseCsv(text)
  if (!header) return { cases: [], warnings: ['the CSV file is empty'] }
  const names = header.map((name) => {
    const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_')
    return ALIASES[key] ?? key
  })
  const warnings = names.filter((n) => n && !COLUMNS[n]).map((n) => `column "${n}" is not known and was ignored`)
  if (!names.includes('input')) throw new UsageError('CSV: there is no "input" column (also accepted: question, prompt, query)')
  const cases = rows.map((cells, r) => {
    const built = names.reduce((c, name, i) => {
      const cell = cells[i] ?? ''
      return COLUMNS[name] && cell.trim() !== '' ? COLUMNS[name](c, cell) : c
    }, { id: '', input: '', checks: [] })
    return built.id ? built : { ...built, id: `row-${r + 2}` }
  })
  return { cases, warnings }
}
