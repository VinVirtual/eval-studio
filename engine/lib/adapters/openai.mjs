// Target: an OpenAI-compatible /chat/completions endpoint (hosted or local).
import { templateVars } from './shape.mjs'
import { probeUrl, readBody } from './http.mjs'

const ERROR_BODY_CHARS = 200
const TOKENS_PER_PRICE_UNIT = 1_000_000

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? {}
  try { return JSON.parse(raw) } catch { return raw }
}

/** Cost from token counts and a price per million tokens, when the config gives prices. */
export function costOf(usage, price) {
  if (!price || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined
  const cost = (usage.inputTokens * (price.inputPerMTok ?? 0) + usage.outputTokens * (price.outputPerMTok ?? 0)) / TOKENS_PER_PRICE_UNIT
  return Number(cost.toFixed(6))
}

export function createOpenAiAdapter(target, { env = process.env, fetchImpl = fetch } = {}) {
  if (!target.baseUrl || !target.model) throw new Error('an openai target needs "baseUrl" and "model"')
  const base = target.baseUrl.replace(/\/+$/, '')
  return {
    envNames: target.apiKeyEnv ? [target.apiKeyEnv] : [],
    describe: () => ({ type: 'openai', baseUrl: base, model: target.model }),
    probe: () => probeUrl(`${base}/models`, fetchImpl),
    async call(caseDef, { signal } = {}) {
      const key = target.apiKeyEnv ? env[target.apiKeyEnv] : undefined
      if (target.apiKeyEnv && !key) throw new Error(`environment variable ${target.apiKeyEnv} is not set`)
      const messages = [...(target.system ? [{ role: 'system', content: target.system }] : []), ...templateVars(caseDef).messages]
      const body = {
        model: target.model,
        messages,
        ...(target.temperature === undefined ? {} : { temperature: target.temperature }),
        ...(target.tools ? { tools: target.tools } : {}),
        ...(target.extra ?? {}),
      }
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal,
      })
      const data = await readBody(response)
      if (!response.ok) {
        const shown = (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, ERROR_BODY_CHARS)
        throw new Error(`HTTP ${response.status} from the model endpoint: ${shown}`)
      }
      const message = data?.choices?.[0]?.message
      if (!message) throw new Error('the model endpoint replied without choices[0].message')
      const tokens = { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens }
      const usage = Object.fromEntries(Object.entries({ ...tokens, cost: costOf(tokens, target.price) }).filter(([, v]) => v !== undefined))
      return {
        answer: typeof message.content === 'string' ? message.content : message.content ? JSON.stringify(message.content) : '',
        sources: [],
        toolCalls: (message.tool_calls ?? []).map((call) => ({ name: String(call.function?.name ?? ''), arguments: parseArguments(call.function?.arguments) })),
        usage,
      }
    },
  }
}
