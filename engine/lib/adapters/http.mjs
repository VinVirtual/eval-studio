// Target: any HTTP endpoint. The request body is a template; the answer is read from the response by path.
import { expandEnv, envNames, fillTemplate } from '../util.mjs'
import { shapeOutput, templateVars } from './shape.mjs'

const PROBE_TIMEOUT_MS = 4000
const ERROR_BODY_CHARS = 200

export async function readBody(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}

/** Can anything be reached at this URL? Any HTTP answer counts, even an error status. */
export async function probeUrl(url, fetchImpl = fetch) {
  try {
    await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `nothing answered at ${new URL(url).origin} (${e.cause?.code ?? e.name})` }
  }
}

export function createHttpAdapter(target, { env = process.env, fetchImpl = fetch } = {}) {
  if (!target.url) throw new Error('an http target needs "url"')
  const method = (target.method ?? 'POST').toUpperCase()
  const bodyTemplate = target.body ?? { input: '{{input}}' }
  return {
    envNames: envNames([target.url, target.headers ?? {}, target.body ?? {}]),
    describe: () => ({ type: 'http', method, url: target.url.replace(/\?.*$/, '') }),
    probe: () => probeUrl(expandEnv(target.url, env), fetchImpl),
    async call(caseDef, { signal } = {}) {
      const vars = templateVars(caseDef)
      const url = fillTemplate(expandEnv(target.url, env), { ...vars, input: encodeURIComponent(caseDef.input) })
      const headers = { 'content-type': 'application/json', ...expandEnv(target.headers ?? {}, env) }
      const body = method === 'GET' ? undefined : JSON.stringify(fillTemplate(expandEnv(bodyTemplate, env), vars))
      const response = await fetchImpl(url, { method, headers, body, signal })
      const data = await readBody(response)
      if (!response.ok) {
        const shown = (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, ERROR_BODY_CHARS)
        throw new Error(`HTTP ${response.status} from the target: ${shown}`)
      }
      return shapeOutput(data, target.response)
    },
  }
}
