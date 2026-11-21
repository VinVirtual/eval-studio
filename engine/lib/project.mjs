// A project is a folder with evals.config.json, a cases file and a runs/ folder.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { UsageError } from './util.mjs'
import { RUN_DEFAULTS } from './run.mjs'
import { GATE_DEFAULTS } from './compare.mjs'

export const CONFIG_NAME = 'evals.config.json'
export const RUN_FILE_VERSION = 1

function readJson(file, what) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new UsageError(`${what} is not valid JSON: ${file} (${e.message})`) }
}

export function loadProject(dir = '.', flags = {}) {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`folder not found: ${dir}`)
  const file = resolve(root, flags.config ?? CONFIG_NAME)
  if (!existsSync(file)) throw new UsageError(`no ${basename(file)} in ${root}. Start a project with: evals new <dir>`)
  const config = readJson(file, 'the config')
  return {
    dir: root,
    configFile: file,
    name: config.name ?? basename(root),
    config,
    target: config.target,
    judge: config.judge ?? {},
    runSettings: { ...RUN_DEFAULTS, ...(config.run ?? {}) },
    gate: { ...GATE_DEFAULTS, ...(config.gate ?? {}) },
    casesFile: resolve(root, config.cases ?? 'cases.jsonl'),
    runsDir: resolve(root, config.runs ?? 'runs'),
    baselineFile: config.baseline ? resolve(root, config.baseline) : null,
    reportFile: resolve(root, config.report ?? 'report.html'),
  }
}

const pad = (n) => String(n).padStart(2, '0')
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** 20260131-140502-label, in UTC, so run files sort by time. */
export function runId(date, label) {
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  return label && slug(label) ? `${stamp}-${slug(label)}` : stamp
}

export function newRun({ project, id, label, date, target, settings, cases }) {
  return {
    version: RUN_FILE_VERSION,
    id: id ?? runId(date, label),
    label: label ?? null,
    name: project.name,
    createdAt: date.toISOString(),
    target,
    settings: { concurrency: settings.concurrency, retries: settings.retries, timeoutMs: settings.timeoutMs, repeat: settings.repeat, ...(settings.tags?.length ? { tags: settings.tags } : {}) },
    scored: false,
    cases,
  }
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** A run id chosen with --id must be a plain file name: no folders, no "..". */
export function checkRunId(id) {
  if (!SAFE_RUN_ID.test(id) || id.includes('..')) throw new UsageError(`--id "${id}" is not allowed: use letters, digits, dot, dash and underscore (no folders), at most 100 characters`)
  return id
}

export const runFile = (project, id) => join(project.runsDir, `${id}.json`)

/**
 * The id to save a new run under. A chosen id that is taken is an error unless overwrite is set;
 * a generated id that is taken (two runs in the same second) gets -2, -3, ...
 */
export function freeRunId(project, id, { chosen = false, overwrite = false } = {}) {
  if (chosen) {
    if (existsSync(runFile(project, id)) && !overwrite) throw new UsageError(`a run called "${id}" already exists in ${project.runsDir}; pick another --id or add --force to replace it`)
    return id
  }
  let candidate = id
  for (let n = 2; existsSync(runFile(project, candidate)); n++) candidate = `${id}-${n}`
  return candidate
}

export function saveRun(project, run) {
  mkdirSync(project.runsDir, { recursive: true })
  const file = runFile(project, checkRunId(run.id))
  writeFileSync(file, JSON.stringify(run, null, 2) + '\n')
  return file
}

export function loadRun(file) {
  const run = readJson(file, 'the run file')
  if (!Array.isArray(run.cases)) throw new UsageError(`not a run file: ${file}`)
  return run
}

/** Every run in runs/, oldest first: [{ file, run }]. Files that are not runs are skipped. */
export function listRuns(project) {
  if (!existsSync(project.runsDir)) return []
  return readdirSync(project.runsDir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const file = join(project.runsDir, name)
      try { return [{ file, run: loadRun(file) }] } catch { return [] }
    })
    .sort((a, b) => String(a.run.createdAt).localeCompare(String(b.run.createdAt)) || a.file.localeCompare(b.file))
}

/** A run by file path, id or label. With no reference: the newest run. -> { file, run } */
export function findRun(project, ref) {
  const runs = listRuns(project)
  if (ref === undefined) {
    if (!runs.length) throw new UsageError(`no runs in ${project.runsDir} yet. Make one with: evals run`)
    return runs.at(-1)
  }
  for (const candidate of [resolve(ref), resolve(project.dir, ref)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate, run: loadRun(candidate) }
  }
  const match = runs.filter(({ run }) => run.id === ref || run.label === ref).at(-1)
  if (!match) throw new UsageError(`no run called "${ref}" (it is not a project folder, a run file, a run id or a label)`)
  return match
}

/**
 * The run to compare against: the one named, else the baseline file from the config,
 * else the newest scored run that is older than `next`. -> { file, run } or null
 */
export function findBaseline(project, next, ref) {
  if (ref !== undefined) return findRun(project, ref)
  if (project.baselineFile && existsSync(project.baselineFile)) {
    const run = loadRun(project.baselineFile)
    return run.id === next.id ? null : { file: project.baselineFile, run }
  }
  const older = listRuns(project).filter(({ run }) => run.scored && run.id !== next.id && String(run.createdAt) <= String(next.createdAt))
  return older.at(-1) ?? null
}
