// Small shared helpers: paths into objects, templates, environment expansion, statistics, a worker pool.

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
export const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places

/** A usage mistake (bad flag, missing file). The CLI prints the message without a stack and exits 2. */
export class UsageError extends Error {}

/** getPath({a:[{b:1}]}, 'a[0].b') -> 1. An empty path returns the object itself. */
export function getPath(obj, path) {
  if (path === undefined || path === null || path === '') return obj
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur = obj
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[part]
  }
  return cur
}

const SLOT = /\{\{\s*([\w.[\]]+)\s*\}\}/g

/**
 * Fill {{name}} slots in every string of a JSON-like value. A string that is only one slot
 * keeps the slot's type, so "{{messages}}" becomes the array itself.
 */
export function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/)
    if (whole) return getPath(vars, whole[1]) ?? ''
    return value.replace(SLOT, (_, key) => {
      const v = getPath(vars, key)
      if (v === undefined || v === null) return ''
      return typeof v === 'string' ? v : JSON.stringify(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars))
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]))
  return value
}

const ENV_SLOT = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Names of the environment variables a config value refers to as ${NAME}. */
export function envNames(value) {
  const names = new Set()
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(ENV_SLOT)) names.add(m[1])
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isObj(v)) Object.values(v).forEach(walk)
  }
  walk(value)
  return [...names]
}

/** Replace ${NAME} with the environment value in every string. A missing variable is an error. */
export function expandEnv(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(ENV_SLOT, (_, name) => {
      if (env[name] === undefined || env[name] === '') throw new Error(`environment variable ${name} is not set`)
      return env[name]
    })
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env))
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]))
  return value
}

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}
export const median = (values) => percentile(values, 50)

/** Run fn over items with at most `limit` running at once. Results keep the order of items. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

const BOOLEAN_FLAGS = new Set(['judge', 'json', 'strict', 'offline', 'frozen', 'help', 'no-compare', 'no-gate', 'quiet'])

/** parseArgs(['run', 'dir', '--repeat', '3', '--judge']) -> { rest: ['run', 'dir'], flags: { repeat: '3', judge: true } } */
export function parseArgs(argv) {
  const rest = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-C') flags.dir = argv[++i]
    else if (arg === '-h') flags.help = true
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
      if (eq >= 0) flags[key] = arg.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[key] = true
      else flags[key] = argv[++i]
    } else rest.push(arg)
  }
  return { rest, flags }
}

/** A whole-number flag inside [min, max], or the fallback when the flag is absent. */
export function intFlag(flags, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (flags[key] === undefined) return fallback
  const n = Number(flags[key])
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${key} must be a whole number from ${min} to ${max}`)
  return n
}

export function numFlag(flags, key, fallback) {
  if (flags[key] === undefined) return fallback
  const n = Number(flags[key])
  if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number`)
  return n
}
