// Target: a function exported by a JavaScript module. fn(input, context) -> string or object.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shapeOutput } from './shape.mjs'
import { envNames, expandEnv } from '../util.mjs'

/**
 * The function gets an AbortSignal in context.signal. It should stop its work when the signal
 * aborts (pass it on to fetch, for example): the runner gives up on a call at the timeout, but a
 * function that ignores the signal keeps running in the background until it ends.
 */
export function createModuleAdapter(target, { baseDir = process.cwd(), env = process.env } = {}) {
  if (!target.path) throw new Error('a module target needs "path"')
  const file = resolve(baseDir, target.path)
  const exportName = target.export ?? 'default'
  let loaded
  const load = async () => {
    if (!existsSync(file)) throw new Error(`module not found: ${target.path}`)
    const fn = (await import(pathToFileURL(file).href))[exportName]
    if (typeof fn !== 'function') throw new Error(`${target.path} does not export a function named "${exportName}"`)
    return fn
  }
  return {
    envNames: envNames(target.options ?? {}),
    describe: () => ({ type: 'module', path: target.path, export: exportName }),
    probe: async () => {
      try { await load(); return { ok: true } } catch (e) { return { ok: false, reason: e.message } }
    },
    /** Import the module before timing starts, so the first case is not charged for it. */
    warm: async () => { loaded ??= load(); await loaded },
    async call(caseDef, { signal } = {}) {
      loaded ??= load()
      const fn = await loaded
      const context = { id: caseDef.id, vars: caseDef.vars ?? {}, messages: caseDef.messages, options: expandEnv(target.options ?? {}, env), signal }
      return shapeOutput(await fn(caseDef.input, context), target.response)
    },
  }
}
