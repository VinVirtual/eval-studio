// Turns whatever a target returns into one shape:
// { answer, sources: [{ id, text?, score? }], toolCalls: [{ name, arguments }], usage: { inputTokens?, outputTokens?, cost? } }
import { getPath, isObj } from '../util.mjs'

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null)
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const asNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined)

function parseMaybe(value) {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return value }
}

function toSource(item, map, index) {
  if (!isObj(item)) return { id: String(item) }
  const id = firstDefined(item[map.sourceId ?? 'id'], item.source, item.title, item.name, item.url, index + 1)
  const text = firstDefined(item[map.sourceText ?? 'text'], item.content, item.passage, item.snippet)
  const score = asNumber(firstDefined(item[map.sourceScore ?? 'score'], item.similarity))
  return { id: String(id), ...(text === undefined ? {} : { text: String(text) }), ...(score === undefined ? {} : { score }) }
}

function toToolCall(item, map) {
  if (!isObj(item)) return { name: String(item), arguments: {} }
  const name = firstDefined(item[map.toolName ?? 'name'], item.function?.name, item.tool, '')
  const args = firstDefined(item[map.toolArgs ?? 'arguments'], item.args, item.input, item.function?.arguments, {})
  return { name: String(name), arguments: parseMaybe(args) }
}

function toUsage(raw, map) {
  const u = isObj(raw.usage) ? raw.usage : {}
  const pick = (path, ...fallbacks) => asNumber(path ? getPath(raw, path) : firstDefined(...fallbacks))
  const usage = {
    inputTokens: pick(map.inputTokens, u.inputTokens, u.input_tokens, u.prompt_tokens),
    outputTokens: pick(map.outputTokens, u.outputTokens, u.output_tokens, u.completion_tokens),
    cost: pick(map.cost, u.cost, raw.cost),
  }
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined))
}

/**
 * raw: a string (the answer) or an object. map: optional paths into the object, for example
 * { answer: 'data.reply', sources: 'data.docs', sourceId: 'doc_id', sourceText: 'chunk', toolCalls: 'data.calls' }.
 * Without a map the common field names are tried.
 */
export function shapeOutput(raw, map = {}) {
  if (!isObj(raw)) return { answer: raw === undefined || raw === null ? '' : String(raw), sources: [], toolCalls: [], usage: {} }
  const answer = map.answer ? getPath(raw, map.answer) : firstDefined(raw.answer, raw.output, raw.text, raw.response, raw.content, raw.message)
  const sources = map.sources ? getPath(raw, map.sources) : firstDefined(raw.sources, raw.documents, raw.contexts, raw.citations)
  const toolCalls = map.toolCalls ? getPath(raw, map.toolCalls) : firstDefined(raw.toolCalls, raw.tool_calls, raw.tools)
  return {
    answer: answer === undefined || answer === null ? '' : typeof answer === 'string' ? answer : JSON.stringify(answer),
    sources: asList(sources).map((item, i) => toSource(item, map, i)),
    toolCalls: asList(toolCalls).map((item) => toToolCall(item, map)),
    usage: toUsage(raw, map),
  }
}

/** The values a request template can use: {{input}}, {{id}}, {{vars.name}}, {{messages}}. */
export function templateVars(caseDef) {
  return {
    input: caseDef.input,
    id: caseDef.id,
    vars: caseDef.vars ?? {},
    messages: caseDef.messages ?? [{ role: 'user', content: caseDef.input }],
  }
}
