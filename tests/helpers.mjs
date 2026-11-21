// Shared by the tests: a local stub server, so nothing here ever calls a real service.
import { createServer } from 'node:http'

/** handler(request, bodyText) -> { status?, body, headers? }. -> { url, requests, close() } */
export async function stubServer(handler) {
  const requests = []
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', async () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: text ? safeJson(text) : null }
      requests.push(record)
      const out = await handler(record)
      const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body)
      res.writeHead(out.status ?? 200, { 'content-type': typeof out.body === 'string' ? 'text/plain' : 'application/json', ...(out.headers ?? {}) })
      res.end(body)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((done) => server.close(done)) }
}

const safeJson = (text) => { try { return JSON.parse(text) } catch { return text } }

/** A chat-completions reply in the OpenAI wire format. */
export const chatReply = (content, extra = {}) => ({
  choices: [{ message: { role: 'assistant', content, ...extra } }],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
})

/** An attempt as the runner would record it. */
export const attempt = (answer, extra = {}) => ({ answer, sources: [], toolCalls: [], usage: {}, latencyMs: 10, retries: 0, ...extra })
