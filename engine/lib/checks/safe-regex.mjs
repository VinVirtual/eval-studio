// Patterns come from case files, so a regex check must not be able to hang the run.
// Two guards: patterns with a quantified group that itself repeats (the usual cause of
// catastrophic backtracking, like (a+)+ or (\w*)*) are refused when cases are checked, and every
// regex check runs in a worker thread that is stopped after a time limit.
import { Worker } from 'node:worker_threads'

export const REGEX_TIME_LIMIT_MS = 1000

const WORKER_CODE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', ({ id, pattern, flags, text }) => {
  try {
    const m = String(text).match(new RegExp(pattern, flags))
    parentPort.postMessage({ id, match: m ? m[0] : null })
  } catch (e) {
    parentPort.postMessage({ id, error: e.message })
  }
})`

// A group that contains a quantifier and is itself followed by a quantifier.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/

/** Why a pattern is refused, or null when it may be used. */
export function riskyPattern(pattern) {
  return NESTED_QUANTIFIER.test(pattern) ? 'has a repeated group that itself repeats, which can take forever to match; simplify it (for example (ab+)+ to (ab+)' : null
}

let worker = null
let nextId = 0
const waiting = new Map()

function getWorker() {
  if (worker) return worker
  const w = new Worker(WORKER_CODE, { eval: true })
  w.on('message', ({ id, ...result }) => {
    const job = waiting.get(id)
    if (!job) return
    waiting.delete(id)
    clearTimeout(job.timer)
    job.done(result)
  })
  const stopped = (message) => {
    if (worker === w) worker = null
    for (const [id, job] of waiting) {
      if (job.w !== w) continue
      clearTimeout(job.timer)
      waiting.delete(id)
      job.done({ error: message })
    }
  }
  w.on('error', (e) => stopped(e.message))
  w.on('exit', () => stopped('the regex worker stopped'))
  w.unref() // after the listeners, which would otherwise hold the process open
  worker = w
  return w
}

/**
 * -> { match: string | null } or { error } or { timedOut: true }.
 * On a timeout the worker is stopped (that is the only way to stop a running regex) and a new one
 * starts on the next call.
 */
export function matchWithTimeLimit(pattern, flags, text, limitMs = REGEX_TIME_LIMIT_MS) {
  return new Promise((done) => {
    const id = ++nextId
    const w = getWorker()
    const timer = setTimeout(() => {
      waiting.delete(id)
      if (worker === w) worker = null
      w.terminate()
      done({ timedOut: true })
    }, limitMs)
    waiting.set(id, { done, timer, w })
    w.postMessage({ id, pattern, flags, text })
  })
}
