// Builds the report: one HTML file with its data, styles and script inside, and no network access.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { redactDeep } from './redact.mjs'

const HERE = fileURLToPath(new URL('../report/', import.meta.url))
const HISTORY_LIMIT = 30

const baseView = (base) => {
  if (!base) return null
  const first = base.attempts?.[0] ?? {}
  return {
    status: base.status,
    score: base.score,
    latencyMs: base.latencyMs,
    answer: first.answer ?? '',
    error: first.error ?? null,
    checks: (first.checks ?? []).map(({ type, pass, detail }) => ({ type, pass, detail })),
  }
}

const historyPoint = (run) => ({
  id: run.id,
  label: run.label ?? null,
  createdAt: run.createdAt,
  score: run.summary.score,
  total: run.summary.total,
  pass: run.summary.pass,
  flaky: run.summary.flaky,
  fail: run.summary.fail + run.summary.error,
  latencyP50: run.summary.latencyP50,
})

/**
 * The data the page shows. run: the scored run. baseline: a scored run or null.
 * comparison: the result of compareRuns or null. history: scored runs, oldest first.
 */
export function buildReportData({ run, baseline = null, comparison = null, history = [], generatedAt = new Date(), secrets = [] }) {
  const rowById = new Map((comparison?.rows ?? []).map((r) => [r.id, r]))
  const baseById = new Map((baseline?.cases ?? []).map((c) => [c.id, c]))
  const data = {
    generator: 'eval-studio',
    generatedAt: generatedAt.toISOString(),
    name: run.name ?? 'Evals',
    run: { id: run.id, label: run.label ?? null, createdAt: run.createdAt, target: run.target ?? {}, settings: run.settings ?? {}, judge: run.judge ?? null },
    summary: run.summary,
    baseline: baseline ? { id: baseline.id, label: baseline.label ?? null, createdAt: baseline.createdAt, summary: baseline.summary } : null,
    comparison: comparison && {
      regressions: comparison.regressions.map(({ id, reason }) => ({ id, reason })),
      fixes: comparison.fixes.map(({ id }) => ({ id })),
      added: comparison.added.map((r) => r.id),
      removed: comparison.removed.map((r) => r.id),
      unchanged: comparison.unchanged,
      score: comparison.score,
      latency: comparison.latency,
      gate: comparison.gate,
    },
    history: history.filter((r) => r.scored && r.summary).slice(-HISTORY_LIMIT).map(historyPoint),
    cases: run.cases.map((c) => {
      const row = rowById.get(c.id)
      return {
        id: c.id, input: c.input, expected: c.expected ?? null, note: c.note ?? null, tags: c.tags ?? [], weight: c.weight ?? 1,
        status: c.status, score: c.score, latencyMs: c.latencyMs,
        change: row?.change ?? null, scoreDelta: row?.scoreDelta ?? null, latencyDelta: row?.latencyDelta ?? null,
        expectedSources: (c.checks ?? []).filter((k) => k?.type === 'source').map((k) => k.id),
        attempts: c.attempts,
        base: baseView(baseById.get(c.id)),
      }
    }),
  }
  return redactDeep(data, secrets)
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

/** JSON that is safe inside a <script> element: no "</script>", no "<!--", no raw line separators. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')
export const embedJson = (data) => JSON.stringify(data).replace(/</g, '\\u003c').replace(LINE_SEPARATORS, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`)

const sha256 = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const read = (name) => readFileSync(HERE + name, 'utf8')

/** The report script, with the shared word diff pasted in. */
function pageScript() {
  const diff = readFileSync(new URL('./diff.mjs', import.meta.url), 'utf8').replace(/^export /gm, '')
  return `${diff}\n${read('report.js')}`
}

/** data -> the full HTML page as a string. The page loads nothing: a content security policy forbids it. */
export function renderReport(data) {
  const css = read('report.css')
  const js = pageScript()
  const csp = `default-src 'none'; style-src ${sha256(css)}; script-src ${sha256(js)}; img-src data:; base-uri 'none'; form-action 'none'`
  const fill = { TITLE: escapeHtml(`${data.name}: eval report`), CSP: escapeHtml(csp), CSS: css, JS: js, DATA: embedJson(data) }
  return read('report.html').replace(/<!--(TITLE|CSP|CSS|JS|DATA)-->/g, (_, key) => fill[key])
}
