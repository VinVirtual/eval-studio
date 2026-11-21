// Calls the target for every case: a few at a time, with a timeout, retries and optional repeats.
import { mapLimit, sleep, round } from './util.mjs'

export const RUN_DEFAULTS = { concurrency: 4, retries: 1, timeoutMs: 30_000, repeat: 1, retryDelayMs: 300 }

const EMPTY_OUTPUT = { answer: '', sources: [], toolCalls: [], usage: {} }

/** One attempt at one case. Never throws: a failure is recorded as { error }. */
async function attemptCase(adapter, caseDef, { retries, timeoutMs, retryDelayMs }) {
  let last = { error: 'not run', latencyMs: 0 }
  for (let tryNo = 0; tryNo <= retries; tryNo++) {
    if (tryNo > 0) await sleep(retryDelayMs * tryNo)
    const control = new AbortController()
    const started = performance.now()
    let timer
    const timeout = new Promise((_, fail) => {
      timer = setTimeout(() => {
        control.abort()
        fail(new Error(`no answer within ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      const output = await Promise.race([adapter.call(caseDef, { signal: control.signal }), timeout])
      return { ...EMPTY_OUTPUT, ...output, latencyMs: round(performance.now() - started), retries: tryNo }
    } catch (e) {
      last = { error: e?.message ?? String(e), latencyMs: round(performance.now() - started) }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ...EMPTY_OUTPUT, ...last, retries }
}

/** The part of a case that is stored in the run file. */
const snapshot = ({ id, input, tags, weight, expected, note, checks, threshold }) => ({
  id, input, tags, weight,
  ...(expected === undefined ? {} : { expected }),
  ...(note === undefined ? {} : { note }),
  ...(threshold === undefined ? {} : { threshold }),
  checks,
})

/**
 * -> [{ ...case, attempts: [{ answer, sources, toolCalls, usage, latencyMs, retries, error? }] }]
 * With repeat N every case is asked N times, which shows answers that change between runs.
 */
export async function runCases({ cases, adapter, settings = {}, onAttempt }) {
  const opts = { ...RUN_DEFAULTS, ...settings }
  const jobs = cases.flatMap((caseDef) => Array.from({ length: opts.repeat }, () => caseDef))
  let done = 0
  const attempts = await mapLimit(jobs, opts.concurrency, async (caseDef) => {
    const attempt = await attemptCase(adapter, caseDef, opts)
    onAttempt?.({ caseDef, attempt, done: ++done, total: jobs.length })
    return attempt
  })
  return cases.map((caseDef, i) => ({ ...snapshot(caseDef), attempts: attempts.slice(i * opts.repeat, (i + 1) * opts.repeat) }))
}
