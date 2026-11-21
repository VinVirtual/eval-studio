// Picks the adapter for a target config. To add a target type, add a factory here.
// An adapter is { call(case, { signal }) -> output, probe() -> { ok, reason? }, describe() -> safe summary, envNames }.
import { createHttpAdapter } from './http.mjs'
import { createOpenAiAdapter } from './openai.mjs'
import { createCommandAdapter } from './command.mjs'
import { createModuleAdapter } from './module.mjs'

const FACTORIES = { http: createHttpAdapter, openai: createOpenAiAdapter, command: createCommandAdapter, module: createModuleAdapter }

export const targetTypes = () => Object.keys(FACTORIES)

export function createAdapter(target, options = {}) {
  if (!target || typeof target !== 'object') throw new Error('the config has no "target"')
  const factory = FACTORIES[target.type]
  if (!factory) throw new Error(`unknown target type "${target.type}" (known: ${targetTypes().join(', ')})`)
  return factory(target, options)
}
