#!/usr/bin/env node
// eval-studio command line. Run `evals help` for the list of commands.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, intFlag, numFlag, UsageError } from './lib/util.mjs'
import { loadProject, newRun, saveRun, findRun, findBaseline, listRuns, CONFIG_NAME } from './lib/project.mjs'
import { loadCases, filterByTags, toJsonl } from './lib/cases.mjs'
import { lintCases, lintTarget, formatIssues, countLevel } from './lib/lint.mjs'
import { createAdapter } from './lib/adapters/index.mjs'
import { createJudge } from './lib/checks/judge.mjs'
import { runCases } from './lib/run.mjs'
import { scoreRun } from './lib/score.mjs'
import { compareRuns, mustPassFailures } from './lib/compare.mjs'
import { buildReportData, renderReport } from './lib/report.mjs'
import { redactDeep, secretValues } from './lib/redact.mjs'

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIN_NODE_MAJOR = 18
const EXIT = { ok: 0, failed: 1, usage: 2 }

const HELP = `eval-studio: test a chatbot, a retrieval system or an agent with cases, checks and a report.

  evals check [dir]                 check this machine and, in a project, its config and environment variables
  evals new <dir>                   start a project (evals.config.json, cases.jsonl, target.mjs)
  evals import <file.csv> [out]     turn a CSV of cases into JSONL
  evals lint [dir]                  check the cases and the target before running   [--offline] [--strict] [--json]
  evals run [dir]                   ask the target every case and save a run file   [--label L] [--repeat N] [--tag T]
  evals score [run]                 apply the checks to a run (default: the newest)   [--judge]
  evals compare [base] [new]        what got worse, what was fixed; exits 1 when the gate fails
  evals report [run]                write report.html (one file, no network)   [--baseline R] [--out FILE]
  evals baseline [run]              copy a scored run to the baseline file named in the config
  evals build [dir]                 lint + run + score + compare + report; exits 1 when the gate fails
  evals test                        run the self-tests

A project is the current folder, the [dir] given, or --dir <dir>. A run is a file, a run id or a label.

options
  --config FILE              config file inside the project (default ${CONFIG_NAME})
  --label L, --id ID         name the run; --id sets the file name too
  --repeat N                 ask every case N times, to see answers that change between runs
  --concurrency N            cases asked at once          --retries N       tries after a failed call
  --timeout MS               time allowed per call        --tag T           only cases with this tag (repeatable with commas)
  --judge                    turn on model-judged checks for this command (they are off by default)
  --max-regressions N        gate: cases allowed to get worse (default 0)
  --max-score-drop P         gate: points the score may fall
  --max-latency-increase P   gate: percent the median latency may rise
  --no-gate                  build: write the report but always exit 0
`

process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(EXIT.ok); throw e })
const say = (message) => process.stdout.write(message + '\n')
const note = (message) => process.stderr.write(message + '\n')
const isDir = (path) => existsSync(path) && statSync(path).isDirectory()
const shown = (file) => relative(process.cwd(), file) || '.'
const fmtMs = (ms) => (ms === null || ms === undefined ? 'n/a' : `${ms} ms`)

/** The project folder: --dir, or a first argument that is a folder, or the current folder. */
function openProject(rest, flags) {
  const fromArg = rest[0] !== undefined && isDir(rest[0])
  const project = loadProject(flags.dir ?? (fromArg ? rest[0] : '.'), flags)
  return { project, rest: fromArg ? rest.slice(1) : rest }
}

function gateOptions(project, flags) {
  return {
    ...project.gate,
    maxRegressions: intFlag(flags, 'max-regressions', project.gate.maxRegressions),
    maxScoreDrop: numFlag(flags, 'max-score-drop', project.gate.maxScoreDrop),
    maxLatencyIncreasePct: numFlag(flags, 'max-latency-increase', project.gate.maxLatencyIncreasePct),
  }
}

function runSettings(project, flags) {
  return {
    ...project.runSettings,
    concurrency: intFlag(flags, 'concurrency', project.runSettings.concurrency, 1, 64),
    retries: intFlag(flags, 'retries', project.runSettings.retries, 0, 10),
    timeoutMs: intFlag(flags, 'timeout', project.runSettings.timeoutMs, 1),
    repeat: intFlag(flags, 'repeat', project.runSettings.repeat, 1, 100),
  }
}

function tryAdapter(project) {
  try { return { adapter: createAdapter(project.target, { baseDir: project.dir }) } } catch (e) { return { adapterError: e.message } }
}

/** Everything that must never reach a file: values of the variables the config names, and secret-looking ones. */
function secretsFor(project, adapter) {
  return secretValues(process.env, [...(adapter?.envNames ?? []), project.judge.apiKeyEnv].filter(Boolean))
}

// ---------- commands ----------

function cmdCheck(rest, flags) {
  const major = Number(process.versions.node.split('.')[0])
  let ok = major >= MIN_NODE_MAJOR && typeof fetch === 'function'
  say(`${major >= MIN_NODE_MAJOR ? 'ok  ' : 'FAIL'} node ${process.versions.node} (needs ${MIN_NODE_MAJOR} or newer)`)
  say(`${typeof fetch === 'function' ? 'ok  ' : 'FAIL'} fetch is built in`)
  const dir = flags.dir ?? rest[0] ?? '.'
  if (!existsSync(resolve(dir, flags.config ?? CONFIG_NAME))) {
    say(`note no ${CONFIG_NAME} in ${shown(resolve(dir))}; start a project with: evals new <dir>`)
    return ok ? EXIT.ok : EXIT.failed
  }
  const project = loadProject(dir, flags)
  const { adapter, adapterError } = tryAdapter(project)
  say(`ok   project "${project.name}" (${shown(project.configFile)})`)
  if (adapterError) { say(`FAIL target: ${adapterError}`); ok = false } else say(`ok   target type ${project.target.type}`)
  for (const name of [...(adapter?.envNames ?? []), project.judge.enabled && project.judge.apiKeyEnv].filter(Boolean)) {
    const set = Boolean(process.env[name])
    if (!set) ok = false
    say(`${set ? 'ok  ' : 'FAIL'} environment variable ${name} is ${set ? 'set' : 'not set'}`)
  }
  say(`note model-judged checks are ${project.judge.enabled ? `ON (${project.judge.model ?? 'no model set'})` : 'off'}`)
  say(`note ${listRuns(project).length} saved run(s) in ${shown(project.runsDir)}`)
  return ok ? EXIT.ok : EXIT.failed
}

function cmdNew(rest) {
  if (!rest[0]) throw new UsageError('where? Give a folder name: evals new <dir>')
  const dir = resolve(rest[0])
  if (existsSync(join(dir, CONFIG_NAME))) throw new UsageError(`${shown(dir)} already has ${CONFIG_NAME}`)
  mkdirSync(dir, { recursive: true })
  const templates = join(SKILL, 'templates')
  for (const name of readdirSync(templates)) {
    if (existsSync(join(dir, name))) note(`kept your ${name}`)
    else copyFileSync(join(templates, name), join(dir, name))
  }
  say(`started ${shown(dir)}: ${readdirSync(templates).join(', ')}`)
  say(`next: edit cases.jsonl and the target in ${CONFIG_NAME}, then run: evals lint ${shown(dir)}`)
  return EXIT.ok
}

function cmdImport(rest) {
  if (!rest[0]) throw new UsageError('which file? evals import <file.csv> [out.jsonl]')
  if (!rest[0].toLowerCase().endsWith('.csv')) throw new UsageError('import reads a .csv file')
  const { cases, warnings } = loadCases(resolve(rest[0]))
  warnings.forEach((w) => note(`warn  ${w}`))
  const out = resolve(rest[1] ?? rest[0].replace(/\.csv$/i, '.jsonl'))
  if (existsSync(out)) throw new UsageError(`${shown(out)} already exists; give another name or remove it first`)
  writeFileSync(out, toJsonl(cases.map(({ tags, weight, ...c }) => ({ ...c, ...(tags.length ? { tags } : {}), ...(weight === 1 ? {} : { weight }) }))))
  say(`wrote ${cases.length} case(s) to ${shown(out)}. Run evals lint before using them.`)
  return EXIT.ok
}

async function lintProject(project, flags) {
  const { cases, warnings } = loadCases(project.casesFile)
  const judgeEnabled = Boolean(project.judge.enabled || flags.judge)
  const { adapter, adapterError } = tryAdapter(project)
  const issues = [
    ...warnings.map((message) => ({ level: 'warn', rule: 'csv', where: 'cases', message })),
    ...lintCases(cases, { judgeEnabled, mustPassTag: project.gate.mustPassTag }),
    ...(await lintTarget({ adapter, adapterError, offline: Boolean(flags.offline), judge: { ...project.judge, enabled: judgeEnabled } })),
  ]
  return { cases, issues }
}

async function cmdLint(rest, flags) {
  const { project } = openProject(rest, flags)
  const { cases, issues } = await lintProject(project, flags)
  if (flags.json) say(JSON.stringify({ cases: cases.length, issues }, null, 2))
  else say(`${cases.length} case(s) in ${shown(project.casesFile)}\n${formatIssues(issues)}`)
  const failed = countLevel(issues, 'error') > 0 || (flags.strict && countLevel(issues, 'warn') > 0)
  return failed ? EXIT.failed : EXIT.ok
}

async function doRun(project, flags) {
  const all = loadCases(project.casesFile).cases
  const cases = filterByTags(all, flags.tag ? String(flags.tag).split(',') : null)
  if (!cases.length) throw new UsageError(flags.tag ? `no case has the tag "${flags.tag}"` : 'there are no cases to run')
  const adapter = createAdapter(project.target, { baseDir: project.dir })
  const settings = runSettings(project, flags)
  const total = cases.length * settings.repeat
  await adapter.warm?.()
  note(`running ${cases.length} case(s)${settings.repeat > 1 ? ` x ${settings.repeat}` : ''} against the ${project.target.type} target, ${settings.concurrency} at a time`)
  const results = await runCases({
    cases, adapter, settings,
    onAttempt: ({ caseDef, attempt, done }) => { if (!flags.quiet) note(`  ${String(done).padStart(String(total).length)}/${total} ${attempt.error ? 'ERROR' : 'ok   '} ${caseDef.id} (${attempt.latencyMs} ms)${attempt.error ? `: ${attempt.error}` : ''}`) },
  })
  const label = typeof flags.label === 'string' ? flags.label : undefined
  const id = typeof flags.id === 'string' ? flags.id : undefined
  const run = newRun({ project, id, label, date: new Date(), target: adapter.describe(), settings, cases: results })
  const clean = redactDeep(run, secretsFor(project, adapter))
  return { run: clean, file: saveRun(project, clean) }
}

async function cmdRun(rest, flags) {
  const { project } = openProject(rest, flags)
  const { run, file } = await doRun(project, flags)
  const errors = run.cases.filter((c) => c.attempts.every((a) => a.error)).length
  say(`saved ${shown(file)} (${run.cases.length} cases, ${errors} could not be answered). Next: evals score`)
  return EXIT.ok
}

async function doScore(project, run, file, flags) {
  const judge = createJudge(project.judge, { force: Boolean(flags.judge) })
  const current = flags.frozen || !existsSync(project.casesFile) ? [] : loadCases(project.casesFile).cases
  const scored = redactDeep(await scoreRun(run, current, { judge, secrets: secretsFor(project) }), secretsFor(project))
  writeFileSync(file, JSON.stringify(scored, null, 2) + '\n')
  return scored
}

function printSummary(run) {
  const s = run.summary
  say(`score ${s.score ?? 'n/a'} / 100   pass ${s.pass}/${s.total}   fail ${s.fail}   flaky ${s.flaky}   error ${s.error}   skipped ${s.skipped}   median ${fmtMs(s.latencyP50)}`)
  if (s.modelJudgedChecks) say(`note ${s.modelJudgedChecks} check(s) per run were scored by a model (${run.judge?.model}). Those scores vary between runs.`)
}

async function cmdScore(rest, flags) {
  const { project, rest: args } = openProject(rest, flags)
  const { run, file } = findRun(project, args[0])
  const scored = await doScore(project, run, file, flags)
  say(`scored ${shown(file)}`)
  printSummary(scored)
  for (const c of scored.cases.filter((k) => k.status !== 'pass' && k.status !== 'skipped')) {
    const attempt = c.attempts.find((a) => a.error || a.pass === false) ?? c.attempts[0]
    const why = attempt.error ? `error: ${attempt.error}` : (attempt.checks.find((k) => k.pass === false) ?? {})
    say(`  ${c.status.padEnd(5)} ${c.id}: ${typeof why === 'string' ? why : `${why.type}: ${why.detail}`}`)
  }
  return EXIT.ok
}

function needScored(run, file) {
  if (!run.scored) throw new UsageError(`${shown(file)} has not been scored yet. Run: evals score ${shown(file)}`)
  return run
}

function printComparison(cmp) {
  const name = (r) => r.label ?? r.id
  say(`compare ${name(cmp.base)} -> ${name(cmp.next)}`)
  say(`  score      ${cmp.score.base} -> ${cmp.score.next}${cmp.score.delta === null ? '' : `  (${cmp.score.delta >= 0 ? '+' : ''}${cmp.score.delta})`}`)
  say(`  latency    median ${fmtMs(cmp.latency.base)} -> ${fmtMs(cmp.latency.next)}`)
  say(`  unchanged  ${cmp.unchanged.pass} still passing, ${cmp.unchanged.fail} still failing`)
  say(`  got worse  ${cmp.regressions.length}`)
  for (const r of cmp.regressions) say(`    ${r.id}: ${r.baseStatus} -> ${r.newStatus}  ${r.reason}`)
  say(`  fixed      ${cmp.fixes.length}`)
  for (const r of cmp.fixes) say(`    ${r.id}: ${r.baseStatus} -> ${r.newStatus}`)
  if (cmp.added.length) say(`  new        ${cmp.added.map((r) => r.id).join(', ')}`)
  if (cmp.removed.length) say(`  removed    ${cmp.removed.map((r) => r.id).join(', ')}`)
  say(cmp.gate.ok ? 'gate: passed' : `gate: FAILED\n${cmp.gate.reasons.map((r) => `  ${r}`).join('\n')}`)
}

function cmdCompare(rest, flags) {
  const project = loadProject(flags.dir ?? '.', flags)
  const next = rest.length >= 2 ? findRun(project, rest[1]) : findRun(project)
  const base = findBaseline(project, next.run, rest[0])
  if (!base) throw new UsageError('there is no earlier run to compare with. Name one, or set "baseline" in the config.')
  const cmp = compareRuns(needScored(base.run, base.file), needScored(next.run, next.file), gateOptions(project, flags))
  if (flags.json) say(JSON.stringify(cmp, null, 2))
  else printComparison(cmp)
  return cmp.gate.ok ? EXIT.ok : EXIT.failed
}

function writeReport(project, run, base, flags) {
  const comparison = base ? compareRuns(base, run, gateOptions(project, flags)) : null
  const history = listRuns(project).map((r) => r.run).filter((r) => r.scored)
  const inHistory = history.some((r) => r.id === run.id) ? history : [...history, run]
  const data = buildReportData({ run, baseline: base, comparison, history: inHistory, secrets: secretsFor(project) })
  const out = resolve(typeof flags.out === 'string' ? flags.out : project.reportFile)
  writeFileSync(out, renderReport(data))
  return { out, comparison }
}

function cmdReport(rest, flags) {
  const { project, rest: args } = openProject(rest, flags)
  const next = findRun(project, args[0])
  const base = findBaseline(project, next.run, typeof flags.baseline === 'string' ? flags.baseline : undefined)
  const { out } = writeReport(project, needScored(next.run, next.file), base ? needScored(base.run, base.file) : null, flags)
  say(`wrote ${shown(out)}${base ? ` (compared with ${base.run.label ?? base.run.id})` : ' (no baseline to compare with)'}`)
  return EXIT.ok
}

function cmdBaseline(rest, flags) {
  const { project, rest: args } = openProject(rest, flags)
  if (!project.baselineFile) throw new UsageError(`set "baseline" in ${CONFIG_NAME} first, for example "baseline": "baseline.json"`)
  const { run, file } = findRun(project, args[0])
  mkdirSync(dirname(project.baselineFile), { recursive: true })
  writeFileSync(project.baselineFile, JSON.stringify(needScored(run, file), null, 2) + '\n')
  say(`baseline is now ${run.label ?? run.id} (${shown(project.baselineFile)}). Commit this file so CI compares against it.`)
  return EXIT.ok
}

async function cmdBuild(rest, flags) {
  const { project } = openProject(rest, flags)
  const { issues } = await lintProject(project, flags)
  if (countLevel(issues, 'error')) {
    say(formatIssues(issues))
    note('build stopped: fix the lint errors first')
    return EXIT.failed
  }
  const made = await doRun(project, flags)
  const run = await doScore(project, made.run, made.file, flags)
  say(`run ${shown(made.file)}`)
  printSummary(run)
  const base = findBaseline(project, run, typeof flags.baseline === 'string' ? flags.baseline : undefined)
  const { out, comparison } = writeReport(project, run, base ? needScored(base.run, base.file) : null, flags)
  let ok = true
  if (comparison) {
    printComparison(comparison)
    ok = comparison.gate.ok
  } else {
    const broken = mustPassFailures(run, project.gate.mustPassTag)
    ok = broken.length === 0
    say(`no earlier run to compare with. ${ok ? 'gate: passed' : `gate: FAILED\n  "${project.gate.mustPassTag}" cases not passing: ${broken.join(', ')}`}`)
  }
  say(`report ${shown(out)}`)
  return ok || flags['no-gate'] ? EXIT.ok : EXIT.failed
}

function cmdTest() {
  const tests = readdirSync(join(SKILL, 'tests')).filter((name) => name.endsWith('.test.mjs')).map((name) => join(SKILL, 'tests', name))
  return spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' }).status ?? EXIT.failed
}

const COMMANDS = { check: cmdCheck, new: cmdNew, import: cmdImport, lint: cmdLint, run: cmdRun, score: cmdScore, compare: cmdCompare, report: cmdReport, baseline: cmdBaseline, build: cmdBuild, test: cmdTest }

async function main() {
  const { rest, flags } = parseArgs(process.argv.slice(2))
  const [command, ...args] = rest
  if (!command || command === 'help' || flags.help) { say(HELP); return EXIT.ok }
  if (!COMMANDS[command]) throw new UsageError(`unknown command "${command}". Run: evals help`)
  return COMMANDS[command](args, flags)
}

main().then((code) => { process.exitCode = code }, (e) => {
  note(e instanceof UsageError ? `evals: ${e.message}` : `evals: ${e.stack ?? e}`)
  process.exitCode = e instanceof UsageError ? EXIT.usage : EXIT.failed
})
