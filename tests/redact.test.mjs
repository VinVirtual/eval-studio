// Redaction: secrets must not reach a run file or a report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactDeep, secretValues, MASK } from '../engine/lib/redact.mjs'

// Made-up values in the shape of real keys. None of them works anywhere.
const FAKE = {
  openai: 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  github: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'c2lnbmF0dXJlLXBhcnQ'].join('.'),
}

test('common key formats are masked', () => {
  for (const [name, value] of Object.entries(FAKE)) {
    const out = redactText(`the ${name} key is ${value} ok`)
    assert.ok(!out.includes(value), name); assert.ok(out.includes(MASK), name)
  }
})

test('authorization headers, key=value pairs and URL passwords are masked, the rest is kept', () => {
  assert.equal(redactText('Authorization: Bearer abcdef123456.xyz-789'), `Authorization: Bearer ${MASK}`)
  assert.equal(redactText('api_key=supersecretvalue1&page=2'), `api_key=${MASK}&page=2`)
  assert.equal(redactText('{"password": "hunter2hunter2"}'), `{"password": "${MASK}"}`)
  assert.equal(redactText('postgres://admin:s3cr3tpass@db.internal/app'), `postgres://admin:${MASK}@db.internal/app`)
  assert.equal(redactText('The late fee is 2 dollars per tool per day.'), 'The late fee is 2 dollars per tool per day.')
  assert.equal(redactText('token count: 12'), 'token count: 12')
})

test('words such as password or secret in ordinary sentences are not masked', () => {
  for (const text of ['The password: must be at least 8 characters.', 'Your secret: everything is fine', 'token: expired', 'Password = required for login', 'The api key: ask the front desk'])
    assert.equal(redactText(text), text)
  assert.equal(redactText('token: abcdefghijklmnopqrstuvwxyz'), `token: ${MASK}`)
  assert.equal(redactText('secret=Zx81kq0pL'), `secret=${MASK}`)
})

test('private key blocks are masked whole', () => {
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----'
  assert.equal(redactText(`key:\n${block}\nend`), `key:\n${MASK}\nend`)
})

test('values of secret-looking and named environment variables are masked wherever they appear', () => {
  const env = { BOT_API_KEY: 'plain-words-not-a-pattern', MY_ENDPOINT_PASS: 'zzzzzzzzzz', HOME: '/home/someone', SHORT_TOKEN: 'abc' }
  const secrets = secretValues(env, ['MY_ENDPOINT_PASS'])
  assert.deepEqual(secrets.sort(), ['plain-words-not-a-pattern', 'zzzzzzzzzz'])
  assert.equal(redactText('echo: plain-words-not-a-pattern and zzzzzzzzzz', secrets), `echo: ${MASK} and ${MASK}`)
  assert.deepEqual(secretValues({ CUSTOM: 'named-by-config-1' }, ['CUSTOM']), ['named-by-config-1'])
})

test('redactDeep cleans every string in a run and leaves numbers and keys alone', () => {
  const run = { cases: [{ id: 'c', attempts: [{ answer: `use ${FAKE.openai}`, latencyMs: 12, toolCalls: [{ name: 'call', arguments: { header: 'Bearer abcdefghijklmnop' } }] }] }] }
  const clean = redactDeep(run)
  assert.equal(clean.cases[0].attempts[0].answer, `use ${MASK}`)
  assert.equal(clean.cases[0].attempts[0].toolCalls[0].arguments.header, `Bearer ${MASK}`)
  assert.equal(clean.cases[0].attempts[0].latencyMs, 12)
  assert.ok(run.cases[0].attempts[0].answer.includes(FAKE.openai)) // the input is not changed
})
