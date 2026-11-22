// Adapters and the runner, against a local stub server. Nothing here calls a real service.
import { test, after } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAdapter, targetTypes } from '../engine/lib/adapters/index.mjs'
import { shapeOutput } from '../engine/lib/adapters/shape.mjs'
import { costOf } from '../engine/lib/adapters/openai.mjs'
import { createJudge, parseVerdict } from '../engine/lib/checks/judge.mjs'
import { runChecks } from '../engine/lib/checks/index.mjs'
import { runCases } from '../engine/lib/run.mjs'
import { fillTemplate, expandEnv, envNames, getPath, mapLimit, percentile, parseArgs } from '../engine/lib/util.mjs'
import { stubServer, chatReply, attempt } from './helpers.mjs'

const dir = mkdtempSync(join(tmpdir(), 'evals-adapters-'))
const servers = []
const serve = async (handler) => { const s = await stubServer(handler); servers.push(s); return s }
after(() => Promise.all(servers.map((s) => s.close())))
const aCase = (extra) => ({ id: 'c1', input: 'How long is a "loan"?', tags: [], weight: 1, checks: [], ...extra })

test('helpers: paths, templates, environment slots, pool, percentiles, flags', async () => {
  assert.equal(getPath({ a: [{ b: 1 }] }, 'a[0].b'), 1); assert.equal(getPath({ a: 1 }, 'x.y'), undefined)
  assert.deepEqual(fillTemplate({ q: 'Q: {{input}}', m: '{{messages}}', n: 3, v: '{{vars.k}}' }, { input: 'hi', messages: [{ role: 'user' }], vars: { k: 'z' } }), { q: 'Q: hi', m: [{ role: 'user' }], n: 3, v: 'z' })
  assert.deepEqual(envNames({ h: 'Bearer ${A_KEY}', u: ['${B}'] }), ['A_KEY', 'B'])
  assert.equal(expandEnv('x ${A}', { A: '1' }), 'x 1'); assert.throws(() => expandEnv('${NOPE}', {}), /NOPE is not set/)
  let running = 0, peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => { peak = Math.max(peak, ++running); await new Promise((r) => setTimeout(r, 5)); running--; return n * 2 })
  assert.deepEqual(out, [2, 4, 6, 8, 10]); assert.equal(peak, 2)
  assert.equal(percentile([5, 1, 3], 50), 3); assert.equal(percentile([5, 1, 3], 95), 5); assert.equal(percentile([], 50), null)
  assert.deepEqual(parseArgs(['run', 'dir', '--repeat', '3', '--judge', 'x', '--tag=a', '-C', 'd']), { rest: ['run', 'dir', 'x'], flags: { repeat: '3', judge: true, tag: 'a', dir: 'd' } })
  assert.deepEqual(targetTypes(), ['http', 'openai', 'command', 'module'])
  assert.throws(() => createAdapter({ type: 'carrier-pigeon' }), /unknown target type/)
})

test('shapeOutput accepts a string, common field names, or mapped paths', () => {
  assert.deepEqual(shapeOutput('hello'), { answer: 'hello', sources: [], toolCalls: [], usage: {} })
  const common = shapeOutput({ output: 'a', documents: ['fees', { title: 'hours', content: 'Open.', similarity: 0.9 }], tool_calls: [{ function: { name: 'f', arguments: '{"x":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })
  assert.deepEqual(common, { answer: 'a', sources: [{ id: 'fees' }, { id: 'hours', text: 'Open.', score: 0.9 }], toolCalls: [{ name: 'f', arguments: { x: 1 } }], usage: { inputTokens: 3, outputTokens: 4 } })
  const mapped = shapeOutput({ data: { reply: { text: 'b' }, docs: [{ doc_id: 7, chunk: 'c' }], calls: [{ tool_name: 't', params: { y: 2 } }] }, meta: { in: 9, usd: 0.01 } },
    { answer: 'data.reply.text', sources: 'data.docs', sourceId: 'doc_id', sourceText: 'chunk', toolCalls: 'data.calls', toolName: 'tool_name', toolArgs: 'params', inputTokens: 'meta.in', cost: 'meta.usd' })
  assert.deepEqual(mapped, { answer: 'b', sources: [{ id: '7', text: 'c' }], toolCalls: [{ name: 't', arguments: { y: 2 } }], usage: { inputTokens: 9, cost: 0.01 } })
  assert.equal(shapeOutput({ answer: { a: 1 } }).answer, '{"a":1}')
})

test('http target: fills the body template, sends the key from the environment, reads the response by path', async () => {
  const server = await serve(() => ({ body: { result: { text: '7 days' }, hits: [{ id: 'borrowing', text: 'The loan period is 7 days.' }] } }))
  const adapter = createAdapter({
    type: 'http', url: `${server.url}/ask?v=\${API_VERSION}`, headers: { authorization: 'Bearer ${BOT_KEY}' },
    body: { question: '{{input}}', session: 'eval-{{id}}', history: '{{messages}}' }, response: { answer: 'result.text', sources: 'hits' },
  }, { env: { BOT_KEY: 'local-test-key-123', API_VERSION: '2' } })
  const out = await adapter.call(aCase())
  assert.deepEqual(out, { answer: '7 days', sources: [{ id: 'borrowing', text: 'The loan period is 7 days.' }], toolCalls: [], usage: {} })
  const sent = server.requests[0]
  assert.equal(sent.method, 'POST'); assert.equal(sent.url, '/ask?v=2'); assert.equal(sent.headers.authorization, 'Bearer local-test-key-123')
  assert.deepEqual(sent.body, { question: 'How long is a "loan"?', session: 'eval-c1', history: [{ role: 'user', content: 'How long is a "loan"?' }] })
  assert.deepEqual(adapter.envNames.sort(), ['API_VERSION', 'BOT_KEY'])
  assert.ok(!JSON.stringify(adapter.describe()).includes('local-test-key-123'))
  assert.deepEqual(await adapter.probe(), { ok: true })
})

test('http target: GET with the question in the URL, a plain-text reply, and an error status', async () => {
  const server = await serve((req) => (req.url.startsWith('/fail') ? { status: 503, body: 'overloaded' } : { body: 'plain answer' }))
  const get = createAdapter({ type: 'http', method: 'GET', url: `${server.url}/q?text={{input}}` })
  assert.equal((await get.call(aCase({ input: 'a b&c' }))).answer, 'plain answer')
  assert.equal(server.requests[0].url, '/q?text=a%20b%26c')
  await assert.rejects(createAdapter({ type: 'http', url: `${server.url}/fail` }).call(aCase()), /HTTP 503 from the target: overloaded/)
  await assert.rejects(createAdapter({ type: 'http', url: `${server.url}/x`, headers: { k: '${MISSING_KEY}' } }, { env: {} }).call(aCase()), /MISSING_KEY is not set/)
})

test('openai-compatible target: sends chat messages, reads the answer, tool calls, tokens and cost', async () => {
  const server = await serve(() => ({ body: chatReply(null, { tool_calls: [{ type: 'function', function: { name: 'reserve_tool', arguments: '{"tool":"ladder"}' } }] }) }))
  const adapter = createAdapter({ type: 'openai', baseUrl: `${server.url}/v1/`, model: 'stub-model', apiKeyEnv: 'STUB_KEY', system: 'Be brief.', temperature: 0, tools: [{ type: 'function', function: { name: 'reserve_tool' } }], price: { inputPerMTok: 1, outputPerMTok: 2 } }, { env: { STUB_KEY: 'stub-key-0000000' } })
  const out = await adapter.call(aCase())
  assert.deepEqual(out, { answer: '', sources: [], toolCalls: [{ name: 'reserve_tool', arguments: { tool: 'ladder' } }], usage: { inputTokens: 12, outputTokens: 5, cost: 0.000022 } })
  const sent = server.requests[0]
  assert.equal(sent.url, '/v1/chat/completions'); assert.equal(sent.headers.authorization, 'Bearer stub-key-0000000')
  assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'How long is a "loan"?' }])
  assert.equal(sent.body.model, 'stub-model'); assert.equal(sent.body.temperature, 0); assert.equal(sent.body.tools.length, 1)
  assert.deepEqual(adapter.describe(), { type: 'openai', baseUrl: `${server.url}/v1`, model: 'stub-model' })
  assert.equal(costOf({ inputTokens: 1 }, { inputPerMTok: 1 }), undefined)
})

test('openai-compatible target: multi-turn cases, no key for local servers, clear errors', async () => {
  const server = await serve((req) => (req.body.model === 'broken' ? { status: 401, body: { error: { message: 'bad key' } } } : req.body.model === 'empty' ? { body: {} } : { body: chatReply('Seven days.') }))
  const local = createAdapter({ type: 'openai', baseUrl: `${server.url}/v1`, model: 'local' })
  const turns = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Loan period?' }]
  assert.equal((await local.call(aCase({ messages: turns }))).answer, 'Seven days.')
  assert.deepEqual(server.requests[0].body.messages, turns); assert.equal(server.requests[0].headers.authorization, undefined)
  await assert.rejects(createAdapter({ type: 'openai', baseUrl: `${server.url}/v1`, model: 'broken' }).call(aCase()), /HTTP 401 from the model endpoint/)
  await assert.rejects(createAdapter({ type: 'openai', baseUrl: `${server.url}/v1`, model: 'empty' }).call(aCase()), /without choices/)
  await assert.rejects(createAdapter({ type: 'openai', baseUrl: `${server.url}/v1`, model: 'm', apiKeyEnv: 'NO_SUCH' }, { env: {} }).call(aCase()), /NO_SUCH is not set/)
})

test('command target: question on stdin, answer on stdout, as text or JSON', async () => {
  const text = createAdapter({ type: 'command', command: 'tr a-z A-Z' })
  assert.equal((await text.call(aCase({ input: 'shout' }))).answer, 'SHOUT')
  writeFileSync(join(dir, 'bot.mjs'), `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);console.log(JSON.stringify({reply:'re: '+q.input,docs:[q.id]}))})`)
  const json = createAdapter({ type: 'command', command: process.execPath, args: ['bot.mjs'], input: 'json', output: 'json', response: { answer: 'reply', sources: 'docs' } }, { baseDir: dir })
  assert.deepEqual(await json.call(aCase({ input: 'ping' })), { answer: 're: ping', sources: [{ id: 'c1' }], toolCalls: [], usage: {} })
  assert.deepEqual(await json.probe(), { ok: true })
  await assert.rejects(createAdapter({ type: 'command', command: 'echo oops >&2; exit 3' }).call(aCase()), /exited with code 3: oops/)
  await assert.rejects(createAdapter({ type: 'command', command: 'echo not-json', output: 'json' }).call(aCase()), /did not print valid JSON/)
})

test('command target: shell syntax in case text is passed as data and never run', async () => {
  const marks = ['subshell', 'backtick', 'semicolon', 'argv'].map((name) => join(dir, `pwned-${name}`))
  const hostile = `$(touch ${marks[0]}) \`touch ${marks[1]}\`; touch ${marks[2]} && echo pwned`
  const nasty = aCase({ input: hostile, vars: { v: hostile }, messages: [{ role: 'user', content: hostile }] })
  // shell mode: the question arrives on stdin, byte for byte
  assert.equal((await createAdapter({ type: 'command', command: 'cat' }).call(nasty)).answer, hostile)
  const asJson = await createAdapter({ type: 'command', command: 'cat', input: 'json' }).call(nasty)
  assert.equal(JSON.parse(asJson.answer).input, hostile)
  // args mode: slots become whole argv entries, with no shell in between
  writeFileSync(join(dir, 'argv.mjs'), `console.log(JSON.stringify(process.argv.slice(2)))`)
  const argv = createAdapter({ type: 'command', command: process.execPath, args: ['argv.mjs', '{{input}}', 'v={{vars.v}}', `$(touch ${marks[3]})`] }, { baseDir: dir })
  assert.deepEqual(JSON.parse((await argv.call(nasty)).answer), [hostile, `v=${hostile}`, `$(touch ${marks[3]})`])
  for (const mark of marks) assert.equal(existsSync(mark), false, `${mark} was created: case text ran as a command`)
})

test('module target: calls the exported function with the question and options', async () => {
  writeFileSync(join(dir, 'target.mjs'), `export const ask = (input, ctx) => ({ answer: input + '/' + ctx.options.mode + '/' + ctx.id, sources: ['d1'] })\nexport default () => 'plain'\nexport const notFn = 1`)
  const named = createAdapter({ type: 'module', path: './target.mjs', export: 'ask', options: { mode: 'fast' } }, { baseDir: dir })
  assert.deepEqual(await named.call(aCase({ input: 'q' })), { answer: 'q/fast/c1', sources: [{ id: 'd1' }], toolCalls: [], usage: {} })
  assert.equal((await createAdapter({ type: 'module', path: './target.mjs' }, { baseDir: dir }).call(aCase())).answer, 'plain')
  assert.match((await createAdapter({ type: 'module', path: './target.mjs', export: 'notFn' }, { baseDir: dir }).probe()).reason, /does not export a function named "notFn"/)
})

test('runner: keeps case order, repeats, retries after a failure, and records what could not be answered', async () => {
  const seen = new Map()
  const adapter = { call: async (c) => {
    const n = (seen.get(c.id) ?? 0) + 1; seen.set(c.id, n)
    if (c.id === 'flaky-net' && n === 1) throw new Error('socket hang up')
    if (c.id === 'dead') throw new Error('HTTP 500')
    return { answer: `${c.id}#${n}`, sources: [], toolCalls: [], usage: {} }
  } }
  const progress = []
  const cases = ['a', 'flaky-net', 'dead'].map((id) => aCase({ id, expected: 'e', checks: [{ type: 'refusal' }] }))
  const out = await runCases({ cases, adapter, settings: { repeat: 2, retries: 1, retryDelayMs: 1, concurrency: 2 }, onAttempt: (p) => progress.push(p.done) })
  assert.deepEqual(out.map((c) => c.id), ['a', 'flaky-net', 'dead'])
  assert.deepEqual(out.map((c) => c.attempts.length), [2, 2, 2])
  assert.deepEqual(out[1].attempts.map((a) => a.retries).sort(), [0, 1])
  assert.deepEqual(out[2].attempts.map((a) => [a.error, a.answer, a.retries]), [['HTTP 500', '', 1], ['HTTP 500', '', 1]])
  assert.equal(seen.get('dead'), 4); assert.deepEqual(progress, [1, 2, 3, 4, 5, 6])
  assert.ok(out[0].attempts.every((a) => typeof a.latencyMs === 'number' && !a.error))
  assert.deepEqual(Object.keys(out[0]), ['id', 'input', 'tags', 'weight', 'expected', 'checks', 'attempts'])
})

test('runner: a call that takes too long is stopped and recorded as an error', async () => {
  let aborted = false
  const adapter = { call: (c, { signal }) => new Promise((done) => { signal.addEventListener('abort', () => { aborted = true }); setTimeout(() => done({ answer: 'late' }), 300) }) }
  const [slow] = await runCases({ cases: [aCase()], adapter, settings: { timeoutMs: 30, retries: 0 } })
  assert.match(slow.attempts[0].error, /no answer within 30 ms/); assert.equal(aborted, true)
  const sleeper = createAdapter({ type: 'command', command: 'sleep 5' })
  const started = Date.now()
  const [killed] = await runCases({ cases: [aCase()], adapter: sleeper, settings: { timeoutMs: 100, retries: 0 } })
  assert.ok(killed.attempts[0].error); assert.ok(Date.now() - started < 3000)
})

test('command target: a timeout stops the whole pipeline, not just the shell, and nothing is left running', async () => {
  const marker = `sleep 7.${process.pid % 1000}`
  const pipeline = createAdapter({ type: 'command', command: `${marker} | cat` })
  const started = Date.now()
  const [out] = await runCases({ cases: [aCase()], adapter: pipeline, settings: { timeoutMs: 200, retries: 0 } })
  assert.match(out.attempts[0].error, /no answer within 200 ms|stopped/)
  assert.ok(Date.now() - started < 3000, 'the call returned promptly')
  await new Promise((r) => setTimeout(r, 300))
  const left = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim()
  assert.equal(left, '', `processes left running: ${left}`)
})

test('model judge: asks a local stub endpoint, reads the score, and never stores the key', async () => {
  const server = await serve((req) => {
    const prompt = req.body.messages[1].content
    return { body: chatReply(prompt.includes('ANSWER:\nrude') ? 'Verdict: {"score": 0.1, "reason": "It is rude."}' : '{"score": 1.4, "reason": "Polite and correct."}') }
  })
  const judge = createJudge({ enabled: true, baseUrl: `${server.url}/v1`, model: 'stub-judge', apiKeyEnv: 'JUDGE_KEY' }, { env: { JUDGE_KEY: 'judge-key-abcdefgh' } })
  const caseDef = aCase({ checks: [{ type: 'judge', rubric: 'Polite.' }] })
  const [good] = await runChecks(caseDef, attempt('kind words', { sources: [{ id: 'doc', text: 'passage' }] }), { judge, secrets: ['judge-key-abcdefgh'] })
  assert.equal(good.pass, true); assert.equal(good.score, 1); assert.equal(good.modelJudged, true); assert.equal(good.detail, 'stub-judge scored 1: Polite and correct.')
  const [bad] = await runChecks(caseDef, attempt('rude'), { judge })
  assert.equal(bad.pass, false); assert.equal(bad.score, 0.1)
  const sent = server.requests[0]
  assert.equal(sent.url, '/v1/chat/completions'); assert.equal(sent.headers.authorization, 'Bearer judge-key-abcdefgh'); assert.equal(sent.body.temperature, 0)
  assert.match(sent.body.messages[1].content, /RUBRIC:\nPolite\.[\s\S]*QUESTION:[\s\S]*RETRIEVED SOURCES:\n1\. \[doc\] passage/)
  assert.equal(createJudge({ baseUrl: 'x', model: 'm' }).enabled, false); assert.equal(createJudge({}, { force: true }).enabled, true)
  const [unset] = await runChecks(caseDef, attempt('x'), { judge: createJudge({}, { force: true }) })
  assert.equal(unset.pass, false); assert.match(unset.detail, /judge.baseUrl and judge.model are not set/)
  assert.throws(() => parseVerdict('I think it is fine'), /did not reply with JSON/); assert.throws(() => parseVerdict('{"reason":"x"}'), /no numeric score/)
})
