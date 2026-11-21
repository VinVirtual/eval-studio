// eval-studio report page. Draws everything from the JSON block in this file. Every value is
// written with textContent, never as HTML. Filters, the open case and the theme live in the URL hash.
const DATA = JSON.parse(document.getElementById('eval-data').textContent)
const root = document.documentElement
const byId = (id) => document.getElementById(id)

const STATUS_NAMES = { pass: 'Pass', fail: 'Fail', flaky: 'Flaky', error: 'Error', skipped: 'Skipped' }
const FILTERS = [
  { key: 'all', name: 'All', test: () => true },
  { key: 'failing', name: 'Not passing', test: (c) => ['fail', 'error', 'flaky'].includes(c.status) },
  { key: 'regressed', name: 'Got worse', test: (c) => c.change === 'regressed' },
  { key: 'fixed', name: 'Fixed', test: (c) => c.change === 'fixed' },
  { key: 'passing', name: 'Passing', test: (c) => c.status === 'pass' },
]
const LIMITS = [
  'String checks are blunt: an answer can contain the right words and still be wrong.',
  'Model-judged scores change between runs and are an opinion, not ground truth.',
  'Passing cases show these cases pass. They do not prove the system is right in general.',
]

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue
    if (key === 'class') el.className = value
    else if (key === 'css') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v)
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid)
  return el
}

// ---------- formatting ----------
const fmtMs = (ms) => (ms === null || ms === undefined ? '–' : ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)
const fmtPct = (score) => (score === null || score === undefined ? '–' : `${Math.round(score * 100)}%`)
const fmtScore = (score) => (score === null || score === undefined ? '–' : score.toFixed(1))
const signed = (n, unit = '') => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}${unit}`
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const runName = (run) => run.label || run.id
function fmtDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}
function targetText(target) {
  if (target.type === 'http') return `http · ${target.url}`
  if (target.type === 'openai') return `openai-compatible · ${target.model}`
  if (target.type === 'command') return `command · ${target.command}`
  if (target.type === 'module') return `module · ${target.path}`
  return target.type || 'unknown'
}

// ---------- state in the URL hash ----------
const state = { status: 'all', tag: '', q: '', open: '', theme: '' }
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  for (const key of Object.keys(state)) state[key] = params.get(key) || (key === 'status' ? 'all' : '')
  if (!FILTERS.some((f) => f.key === state.status)) state.status = 'all'
}
function writeHash() {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(state)) if (value && !(key === 'status' && value === 'all')) params.set(key, value)
  const hash = params.toString()
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search)
}

// ---------- theme ----------
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
const effectiveTheme = () => state.theme || (systemDark() ? 'dark' : 'light')
function applyTheme() {
  if (state.theme) root.dataset.theme = state.theme
  else delete root.dataset.theme
  const button = byId('theme-toggle')
  if (button) button.textContent = effectiveTheme() === 'dark' ? 'Light theme' : 'Dark theme'
}

// ---------- masthead ----------
function drawMast() {
  const { run, baseline } = DATA
  const meta = [
    ['Run', runName(run)],
    ['When', fmtDate(run.createdAt)],
    ['Target', targetText(run.target)],
    ['Compared with', baseline ? runName(baseline) : 'nothing yet'],
    run.settings.repeat > 1 && ['Repeats', `${run.settings.repeat} per case`],
    run.judge && ['Judge model', run.judge.model],
  ].filter(Boolean)
  byId('mast').append(
    h('div', { class: 'mast-bar' },
      h('span', { class: 'eyebrow' }, 'eval-studio · report'),
      h('button', { class: 'theme-toggle', id: 'theme-toggle', type: 'button', onclick: () => { state.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; applyTheme(); writeHash() } })),
    h('h1', null, DATA.name),
    h('dl', { class: 'meta' }, meta.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', { class: 'mono' }, v)))))
}

// ---------- verdict ----------
function sentence() {
  const { summary: s, comparison: cmp } = DATA
  const parts = [`${s.pass} of ${plural(s.total, 'case')} pass.`]
  if (!cmp) return h('p', { class: 'sentence' }, parts[0], ' This is the first run, so there is nothing to compare it with yet.')
  const worse = cmp.regressions.length
  const better = cmp.fixes.length
  if (!worse && !better) return h('p', { class: 'sentence' }, parts[0], ' Nothing changed since the baseline.')
  return h('p', { class: 'sentence' }, parts[0], ' ',
    worse ? h('span', { class: 'worse' }, `${worse} got worse`) : 'None got worse',
    ' and ',
    better ? h('span', { class: 'better' }, `${better} ${better === 1 ? 'was' : 'were'} fixed`) : 'none were fixed',
    ' since the baseline.')
}
function gateBlock() {
  const gate = DATA.comparison && DATA.comparison.gate
  if (!gate) return null
  return h('div', { class: 'gate' },
    h('span', { class: `gate-chip ${gate.ok ? 'ok' : 'bad'}` }, gate.ok ? 'Gate passed' : 'Gate failed'),
    gate.reasons.map((reason) => h('span', null, reason)))
}
function trendPanel() {
  const runs = DATA.history.slice(-14)
  const cols = runs.map((p) => {
    const counted = Math.max(1, p.total)
    const isCurrent = p.id === DATA.run.id
    const isBase = DATA.baseline && p.id === DATA.baseline.id
    const height = p.score === null ? 0 : Math.max(2, p.score * 0.8)
    const seg = (cls, n) => (n ? h('i', { class: cls, css: { height: `${(n / counted) * 100}%` } }) : null)
    return h('div', { class: `trend-col${isCurrent ? ' current' : ''}${isBase ? ' base' : ''}`, title: `${p.label || p.id}: score ${fmtScore(p.score)}, ${p.pass} of ${p.total} pass` },
      h('span', { class: 'trend-val num' }, fmtScore(p.score)),
      h('div', { class: 'trend-bar', css: { height: `${height}%` } }, seg('seg-pass', p.pass), seg('seg-flaky', p.flaky), seg('seg-fail', p.fail), seg('seg-skip', p.total - p.pass - p.flaky - p.fail)))
  })
  const names = runs.map((p) => h('span', { class: p.id === DATA.run.id ? 'current' : '', title: p.label || p.id }, p.label || p.id.slice(4, 13)))
  return h('figure', { class: 'trend' },
    h('div', { class: 'trend-head' }, h('span', { class: 'label' }, 'Score across saved runs'), h('span', { class: 'label num' }, plural(DATA.history.length, 'run'))),
    h('div', { class: 'trend-cols', role: 'img', 'aria-label': `Score of the last ${runs.length} runs: ${runs.map((p) => fmtScore(p.score)).join(', ')}` }, cols),
    h('div', { class: 'trend-names', 'aria-hidden': 'true' }, names),
    h('figcaption', { class: 'trend-note' }, runs.length < 2 ? 'One run so far. The trend appears from the second run.' : 'Bar height is the score. The colours split each run into passing, flaky and failing cases.'))
}
function figure(label, value, sub, cls) {
  return h('div', { class: `figure ${cls || ''}` }, h('span', { class: 'label' }, label), h('b', { class: 'num' }, value), sub ? h('span', null, sub) : null)
}
function drawVerdict() {
  const { summary: s, comparison: cmp } = DATA
  const delta = cmp && cmp.score.delta
  const deltaChip = delta === null || delta === undefined ? null
    : h('span', { class: `delta num ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}` }, `${delta > 0 ? '▲' : delta < 0 ? '▼' : '='} ${signed(delta)} vs baseline`)
  const latencyDelta = cmp && cmp.latency.delta
  const figures = [
    figure('Passing', [String(s.pass), h('small', null, ` / ${s.total}`)], s.flaky ? `${s.flaky} flaky` : null),
    cmp && figure('Got worse', String(cmp.regressions.length), 'passed before, not now', cmp.regressions.length ? 'worse' : ''),
    cmp && figure('Fixed', String(cmp.fixes.length), 'failed before, pass now', cmp.fixes.length ? 'better' : ''),
    figure('Median latency', fmtMs(s.latencyP50), latencyDelta === null || latencyDelta === undefined ? `p95 ${fmtMs(s.latencyP95)}` : `${signed(latencyDelta, ' ms')} · p95 ${fmtMs(s.latencyP95)}`),
    s.inputTokens !== null && figure('Tokens', String((s.inputTokens || 0) + (s.outputTokens || 0)), `${s.inputTokens || 0} in · ${s.outputTokens || 0} out`),
    s.cost !== null && figure('Cost', String(s.cost), 'as reported by the target'),
  ]
  const spread = [['seg-pass', s.pass, 'passing'], ['seg-flaky', s.flaky, 'flaky'], ['seg-fail', s.fail, 'failing'], ['seg-fail', s.error, 'errors'], ['seg-skip', s.skipped, 'skipped']].filter(([, n]) => n > 0)
  byId('verdict').append(
    h('div', { class: 'verdict-grid' },
      h('div', null,
        h('span', { class: 'label' }, 'Score, weighted, out of 100'),
        h('div', { class: 'score-line' }, h('span', { class: 'score num' }, fmtScore(s.score)), deltaChip),
        sentence(), gateBlock()),
      trendPanel()),
    h('div', { class: 'figures' }, figures),
    h('div', { class: 'spread' },
      h('div', { class: 'spread-bar', role: 'img', 'aria-label': spread.map(([, n, name]) => `${n} ${name}`).join(', ') }, spread.map(([cls, n]) => h('i', { class: cls, css: { flex: `${n} 1 0` } }))),
      h('div', { class: 'legend' }, spread.map(([cls, n, name]) => h('span', null, h('i', { class: cls }), `${n} ${name}`)))))
}

// ---------- what changed ----------
function openCase(id) {
  state.status = 'all'; state.tag = ''; state.q = ''; state.open = id
  applyFilters()
  const el = byId(`case-${id}`)
  if (!el) return
  el.open = true
  el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
function drawChanges() {
  const cmp = DATA.comparison
  const box = byId('changes')
  if (!cmp) { box.hidden = true; return }
  const inputOf = (id) => (DATA.cases.find((c) => c.id === id) || {}).input
  const column = (cls, title, rows, none) => h('div', { class: `change-col ${cls}` },
    h('h3', null, h('span', null, title), h('span', { class: 'num' }, String(rows.length))),
    h('ul', null, rows.length
      ? rows.map((r) => h('li', null, h('button', { class: 'jump', type: 'button', onclick: () => openCase(r.id) }, r.id), h('p', null, r.reason || inputOf(r.id))))
      : h('li', { class: 'none' }, none)))
  const also = [cmp.added.length && `${plural(cmp.added.length, 'new case')}: ${cmp.added.join(', ')}`, cmp.removed.length && `${plural(cmp.removed.length, 'case')} no longer in the set: ${cmp.removed.join(', ')}`].filter(Boolean)
  box.append(
    h('div', { class: 'section-head' },
      h('h2', null, 'What changed'),
      h('p', null, `against ${runName(DATA.baseline)} · ${cmp.unchanged.pass} still passing, ${cmp.unchanged.fail} still failing`)),
    h('div', { class: 'change-grid' },
      column('worse', 'Got worse', cmp.regressions, 'Nothing that passed before fails now.'),
      column('better', 'Fixed', cmp.fixes, 'Nothing that failed before passes now.')),
    also.length ? h('p', { class: 'also' }, also.join(' · ')) : null)
}

// ---------- case detail ----------
function answerBody(text, error, parts, keep) {
  if (error) return h('div', { class: 'answer-text is-error' }, error)
  if (!text) return h('div', { class: 'answer-text is-empty' }, '(empty answer)')
  if (!parts) return h('div', { class: 'answer-text' }, text)
  return h('div', { class: 'answer-text' }, parts.filter((p) => p.op === 'same' || p.op === keep).flatMap((p, i) => [i ? ' ' : '', p.op === 'same' ? p.text : h(keep === 'del' ? 'del' : 'ins', null, p.text)]))
}
function answersBlock(c, attempt) {
  const base = c.base
  const nowHead = h('h4', null, 'This run', h('span', { class: `status ${attempt.error ? 'error' : attempt.pass === null ? 'skipped' : attempt.pass ? 'pass' : 'fail'}` }, attempt.error ? 'Error' : attempt.pass === null ? 'Skipped' : attempt.pass ? 'Pass' : 'Fail'))
  if (!base) return h('section', { class: 'answer now' }, nowHead, answerBody(attempt.answer, attempt.error))
  const same = !attempt.error && !base.error && attempt.answer === base.answer
  const parts = same || attempt.error || base.error ? null : wordDiff(base.answer, attempt.answer)
  if (same) nowHead.append(h('span', { class: 'same-note' }, 'same text as the baseline'))
  return h('div', { class: 'pair' },
    h('section', { class: 'answer base' },
      h('h4', null, `Baseline · ${runName(DATA.baseline)}`, h('span', { class: `status ${base.status}` }, STATUS_NAMES[base.status])),
      answerBody(base.answer, base.error, parts, 'del')),
    h('section', { class: 'answer now' }, nowHead, answerBody(attempt.answer, attempt.error, parts, 'add')))
}
function checksBlock(c, attempt) {
  const checks = attempt.checks || []
  if (!checks.length) return null
  const baseChecks = (c.base && c.base.checks) || []
  return h('section', null,
    h('h4', null, 'Checks'),
    h('ul', { class: 'checks' }, checks.map((k, i) => {
      const was = baseChecks[i] && baseChecks[i].type === k.type && baseChecks[i].pass !== k.pass && baseChecks[i].pass !== null && k.pass !== null
      return h('li', { class: k.pass === false ? 'failed' : '' },
        h('span', { class: `mark ${k.pass === null ? 'skip' : k.pass ? 'pass' : 'fail'}`, 'aria-label': k.pass === null ? 'skipped' : k.pass ? 'passed' : 'failed' }, k.pass === null ? '–' : k.pass ? '✓' : '✕'),
        h('span', { class: 'check-type' }, k.type, k.modelJudged ? [' ', h('span', { class: 'badge judged' }, 'model-judged')] : null),
        h('span', null, k.expected),
        h('span', { class: 'check-got' }, k.detail, was ? h('span', { class: 'was' }, `baseline: ${baseChecks[i].pass ? 'passed' : 'failed'} (${baseChecks[i].detail})`) : null))
    })))
}
function passagesBlock(c, attempt) {
  const sources = attempt.sources || []
  if (!sources.length) return null
  const wanted = c.expectedSources.map((s) => s.toLowerCase())
  return h('section', null,
    h('h4', null, 'Retrieved passages'),
    h('ol', { class: 'passages' }, sources.map((s, i) => {
      const hit = wanted.includes(String(s.id).toLowerCase())
      return h('li', { class: hit ? 'hit' : '' },
        h('span', { class: 'rank num' }, String(i + 1)),
        h('div', null,
          h('div', { class: 'passage-head' }, s.id, hit ? h('span', { class: 'hitmark' }, 'expected source') : null, s.score !== undefined ? h('span', { class: 'pill' }, `score ${s.score}`) : null),
          s.text ? h('p', { class: 'passage-text' }, s.text) : null))
    })))
}
function toolsBlock(attempt) {
  const calls = attempt.toolCalls || []
  if (!calls.length) return null
  return h('section', null,
    h('h4', null, 'Tool trace'),
    h('ol', { class: 'tools' }, calls.map((call, i) => h('li', null,
      h('span', { class: 'rank num' }, String(i + 1)),
      h('div', null, h('span', { class: 'passage-head' }, call.name), h('pre', null, JSON.stringify(call.arguments, null, 2)))))))
}
function factsBlock(c, attempt) {
  const usage = attempt.usage || {}
  const facts = [
    `latency ${fmtMs(attempt.latencyMs)}`,
    c.base && c.latencyDelta !== null && `baseline ${fmtMs(c.base.latencyMs)}`,
    attempt.retries ? `${plural(attempt.retries, 'retry').replace('retrys', 'retries')}` : null,
    usage.inputTokens !== undefined && `${usage.inputTokens} tokens in`,
    usage.outputTokens !== undefined && `${usage.outputTokens} tokens out`,
    usage.cost !== undefined && `cost ${usage.cost}`,
    `weight ${c.weight}`,
  ].filter(Boolean)
  return h('div', { class: 'facts' }, facts.map((f) => h('span', null, f)))
}
function drawDetail(c, holder, index) {
  const attempt = c.attempts[index] || { checks: [] }
  const picker = c.attempts.length > 1 ? h('div', { class: 'attempts' }, h('span', { class: 'label' }, 'Attempt'),
    c.attempts.map((a, i) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(i === index), onclick: () => drawDetail(c, holder, i) }, `${i + 1}`, h('b', null, a.error ? 'error' : a.pass ? 'pass' : a.pass === null ? 'skip' : 'fail')))) : null
  holder.replaceChildren(
    h('div', { class: 'pair' },
      h('section', null, h('h4', null, 'Question'), h('p', { class: 'question' }, c.input)),
      h('section', null, h('h4', null, 'Expected'), h('p', { class: 'expected' }, c.expected || 'See the checks below.'), c.note ? h('p', { class: 'note' }, c.note) : null)),
    picker,
    answersBlock(c, attempt), checksBlock(c, attempt), passagesBlock(c, attempt), toolsBlock(attempt), factsBlock(c, attempt))
}

// ---------- case list ----------
function caseRow(c) {
  const judged = (c.attempts[0] && c.attempts[0].checks || []).some((k) => k.modelJudged && k.pass !== null)
  const holder = h('div', { class: 'detail' })
  const row = h('details', { class: `case is-${c.change || 'plain'}`, id: `case-${c.id}` },
    h('summary', null,
      h('span', { class: `status ${c.status}` }, STATUS_NAMES[c.status]),
      h('div', { class: 'case-main' }, h('div', { class: 'case-id' }, c.id), h('div', { class: 'case-q' }, c.input)),
      h('div', { class: 'case-side' },
        c.change === 'regressed' ? h('span', { class: 'badge regressed' }, 'Got worse') : null,
        c.change === 'fixed' ? h('span', { class: 'badge fixed' }, 'Fixed') : null,
        c.change === 'new' ? h('span', { class: 'badge new' }, 'New') : null,
        judged ? h('span', { class: 'badge judged' }, 'model-judged') : null,
        c.tags.map((t) => h('span', { class: 'pill' }, t))),
      h('span', { class: `case-score num ${c.score === 1 ? 'full' : ''}`, title: 'Share of the checks passed, by weight' }, fmtPct(c.score)),
      h('span', { class: 'case-ms num' }, fmtMs(c.latencyMs)),
      h('span', { class: 'chev', 'aria-hidden': 'true' })),
    holder)
  row.addEventListener('toggle', () => {
    if (row.open && !holder.childElementCount) drawDetail(c, holder, Math.max(0, c.attempts.findIndex((a) => a.error || a.pass === false)))
    if (row.open) state.open = c.id
    else if (state.open === c.id) state.open = ''
    writeHash()
  })
  return row
}
function matches(c) {
  const filter = FILTERS.find((f) => f.key === state.status)
  if (!filter.test(c)) return false
  if (state.tag && !c.tags.includes(state.tag)) return false
  const q = state.q.trim().toLowerCase()
  return !q || [c.id, c.input, c.expected || '', ...c.attempts.map((a) => a.answer || '')].some((text) => text.toLowerCase().includes(q))
}
function applyFilters() {
  let shown = 0
  for (const c of DATA.cases) {
    const visible = matches(c)
    byId(`case-${c.id}`).hidden = !visible
    if (visible) shown++
  }
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === state.status))
  for (const b of document.querySelectorAll('[data-tag]')) b.setAttribute('aria-pressed', String(b.dataset.tag === state.tag))
  byId('search').value = state.q
  byId('shown').textContent = shown === DATA.cases.length ? `${plural(shown, 'case')}, ordered with what got worse first` : `${shown} of ${plural(DATA.cases.length, 'case')} shown`
  byId('empty').hidden = shown > 0
  writeHash()
}
function drawCases() {
  const order = { regressed: 0, fixed: 1 }
  const rank = (c) => order[c.change] ?? (c.status === 'pass' ? 4 : c.status === 'skipped' ? 5 : 3)
  DATA.cases = DATA.cases.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c)
  const tags = [...new Set(DATA.cases.flatMap((c) => c.tags))].sort()
  const filters = FILTERS.filter((f) => DATA.comparison || !['regressed', 'fixed'].includes(f.key))
  byId('cases').append(
    h('div', { class: 'section-head' }, h('h2', null, 'Cases'), h('p', { id: 'shown', 'aria-live': 'polite' })),
    h('div', { class: 'toolbar' },
      h('div', { class: 'toolbar-row', role: 'group', 'aria-label': 'Filter by result' },
        filters.map((f) => h('button', { class: 'chip', type: 'button', 'data-filter': f.key, onclick: () => { state.status = f.key; applyFilters() } }, f.name, h('b', { class: 'num' }, String(DATA.cases.filter(f.test).length)))),
        h('input', { class: 'search', id: 'search', type: 'search', placeholder: 'Search questions and answers', 'aria-label': 'Search questions and answers', oninput: (e) => { state.q = e.target.value; applyFilters() } })),
      tags.length ? h('div', { class: 'toolbar-row', role: 'group', 'aria-label': 'Filter by tag' },
        h('span', { class: 'label' }, 'Tags'),
        tags.map((t) => h('button', { class: 'chip tag', type: 'button', 'data-tag': t, onclick: () => { state.tag = state.tag === t ? '' : t; applyFilters() } }, t, h('b', { class: 'num' }, `${DATA.summary.byTag[t].pass}/${DATA.summary.byTag[t].total}`)))) : null),
    h('div', { class: 'case-list' }, DATA.cases.map(caseRow)),
    h('p', { class: 'empty', id: 'empty', hidden: true }, 'No case matches these filters.'))
}

function drawFoot() {
  const judged = DATA.summary.modelJudgedChecks
  byId('foot').append(h('div', { class: 'foot-inner' },
    h('div', null, h('h3', null, 'Read this report with care'), h('ul', null, LIMITS.map((t) => h('li', null, t)),
      h('li', null, judged ? `${plural(judged, 'check')} per run in this report ${judged === 1 ? 'was' : 'were'} scored by a model (${DATA.run.judge ? DATA.run.judge.model : 'judge'}) and ${judged === 1 ? 'is' : 'are'} marked "model-judged".` : 'No check in this run was scored by a model.'))),
    h('div', null, h('h3', null, 'About this file'), h('p', null, `Made by eval-studio on ${fmtDate(DATA.generatedAt)}. One file, nothing loaded from the network. Obvious secrets are masked before saving.`))))
}

readHash()
applyTheme()
drawMast()
applyTheme()
drawVerdict()
drawChanges()
drawCases()
drawFoot()
const opened = state.open
applyFilters()
if (opened && byId(`case-${opened}`)) { byId(`case-${opened}`).open = true; state.open = opened; writeHash() }
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
