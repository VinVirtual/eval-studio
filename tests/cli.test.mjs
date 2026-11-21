// The command line, run as a user would, in throwaway projects. Module targets only, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../engine/cli.mjs', import.meta.url))
const FAKE_KEY = 'sk-' + 'Test0000Test0000Test0000'

function evals(args, cwd, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, timeout: 30_000 }, (e, stdout, stderr) =>
      done({ code: e ? e.code : 0, stdout, stderr, out: stdout + stderr }))
  })
}

/** A project whose target is `body` (the body of an answer(input) function). */
function project(body, cases, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evals-cli-'))
  writeFileSync(join(dir, 'target.mjs'), `export function answer(input) {\n${body}\n}\n`)
  writeFileSync(join(dir, 'cases.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
  writeFileSync(join(dir, 'evals.config.json'), JSON.stringify({ name: 'cli test', target: { type: 'module', path: './target.mjs', export: 'answer' }, run: { retries: 0 }, ...config }))
  return dir
}
const caseOf = (id, checks, extra = {}) => ({ id, input: `question ${id}`, checks, ...extra })
const runFiles = (dir) => (existsSync(join(dir, 'runs')) ? readdirSync(join(dir, 'runs')) : [])

test('a run where the target answers nothing exits 1, and build fails its gate even with no baseline', async () => {
  const dir = project(`throw new Error('connection refused')`, [caseOf('a', [{ type: 'contains', value: 'x' }]), caseOf('b', [{ type: 'contains', value: 'x' }])])
  const run = await evals(['run', '--quiet'], dir)
  assert.equal(run.code, 1); assert.match(run.out, /did not answer a single case/)
  const build = await evals(['build', '--quiet'], dir)
  assert.equal(build.code, 1)
  assert.match(build.out, /gate: FAILED/); assert.match(build.out, /no case got an answer/); assert.match(build.out, /2 cases got no answer because of an error/)
  assert.equal((await evals(['build', '--quiet', '--no-gate'], dir)).code, 0)
})

test('checks see the raw answer; only the files on disk are redacted', async () => {
  const dir = project(`return 'Your key is ${FAKE_KEY} and the code is 4471.'`, [caseOf('k', [{ type: 'contains', value: FAKE_KEY }, { type: 'regex', pattern: 'code is \\d+' }])])
  const build = await evals(['build', '--quiet'], dir)
  assert.equal(build.code, 0, build.out); assert.match(build.out, /pass 1\/1/)
  const saved = readFileSync(join(dir, 'runs', runFiles(dir)[0]), 'utf8')
  assert.ok(!saved.includes(FAKE_KEY)); assert.ok(saved.includes('[redacted]')); assert.ok(saved.includes('"pass": true'))
  assert.ok(!readFileSync(join(dir, 'report.html'), 'utf8').includes(FAKE_KEY))
})

test('a value from an environment variable the target names is masked in run files and the report', async () => {
  const dir = project(`return 'echo ' + process.env.MY_BACKEND_PASS`, [caseOf('e', [{ type: 'contains', value: 'echo' }])])
  writeFileSync(join(dir, 'evals.config.json'), JSON.stringify({ name: 'env', target: { type: 'module', path: './target.mjs', export: 'answer', options: { k: '${MY_BACKEND_PASS}' } }, run: { retries: 0 } }))
  const build = await evals(['build', '--quiet'], dir, { MY_BACKEND_PASS: 'plain-words-but-secret' })
  assert.equal(build.code, 0, build.out)
  for (const file of [join(dir, 'runs', runFiles(dir)[0]), join(dir, 'report.html')]) assert.ok(!readFileSync(file, 'utf8').includes('plain-words-but-secret'), file)
})

test('--id must be a plain name and is never overwritten without --force', async () => {
  const dir = project(`return 'ok'`, [caseOf('a', [{ type: 'contains', value: 'ok' }])])
  for (const bad of ['../outside', 'runs/x', '/tmp/x', '.hidden', 'a b']) {
    const out = await evals(['run', '--quiet', '--id', bad], dir)
    assert.equal(out.code, 2, bad); assert.match(out.out, /--id .* is not allowed/)
  }
  assert.equal((await evals(['run', '--quiet', '--id', 'first'], dir)).code, 0)
  const again = await evals(['run', '--quiet', '--id', 'first'], dir)
  assert.equal(again.code, 2); assert.match(again.out, /already exists.*--force/)
  assert.equal((await evals(['run', '--quiet', '--id', 'first', '--force'], dir)).code, 0)
  assert.deepEqual(runFiles(dir), ['first.json'])
  assert.ok(!existsSync(join(dir, '..', 'outside.json')))
})

test('two runs in the same second with the same label do not overwrite each other', async () => {
  const dir = project(`return 'ok'`, [caseOf('a', [{ type: 'contains', value: 'ok' }])])
  await Promise.all([evals(['run', '--quiet', '--label', 'same'], dir), evals(['run', '--quiet', '--label', 'same'], dir)])
  await evals(['run', '--quiet', '--label', 'same'], dir)
  assert.equal(runFiles(dir).length >= 2, true)
})

test('numeric and text flags without a value are usage errors (exit 2)', async () => {
  const dir = project(`return 'ok'`, [caseOf('a', [{ type: 'contains', value: 'ok' }])])
  for (const args of [['run', '--repeat'], ['run', '--timeout', '--quiet'], ['run', '--concurrency'], ['run', '--label'], ['compare', '--max-score-drop'], ['build', '--max-regressions'], ['run', '--quiet=yes']]) {
    const out = await evals(args, dir)
    assert.equal(out.code, 2, args.join(' ')); assert.match(out.out, /needs a value|takes no value/)
  }
  assert.deepEqual(runFiles(dir), [])
})

test('a project folder that does not exist is an error on every command, never a fallback to the current folder', async () => {
  const dir = project(`return 'ok'`, [caseOf('a', [{ type: 'contains', value: 'ok' }])])
  assert.equal((await evals(['build', '--quiet'], dir)).code, 0)
  const typo = join(dir, 'no-such-folder')
  for (const args of [['run', typo], ['lint', typo], ['build', typo], ['check', typo], ['compare', typo, 'a', 'b'], ['score', typo, 'x'], ['report', typo, 'x'], ['baseline', typo, 'x'], ['run', '--dir', typo]]) {
    const out = await evals(args, dir)
    assert.equal(out.code, 2, args[0]); assert.match(out.out, /folder not found|no run called/, args[0])
  }
  assert.equal(runFiles(dir).length, 1)
})

test('compare reports a renamed case as missing and fails; --allow-removed and --allow-new-failures relax it', async () => {
  const dir = project(`return 'ok'`, [caseOf('old-name', [{ type: 'contains', value: 'ok' }])])
  assert.equal((await evals(['run', '--quiet', '--id', 'one'], dir)).code, 0)
  await evals(['score', 'one'], dir)
  writeFileSync(join(dir, 'cases.jsonl'), JSON.stringify(caseOf('new-name', [{ type: 'contains', value: 'never' }])) + '\n')
  await evals(['run', '--quiet', '--id', 'two'], dir)
  await evals(['score', 'two'], dir)
  const strict = await evals(['compare', 'one', 'two'], dir)
  assert.equal(strict.code, 1); assert.match(strict.out, /missing from this run.*old-name/); assert.match(strict.out, /new-name \(new, fail\)/)
  assert.equal((await evals(['compare', 'one', 'two', '--allow-removed', '--allow-new-failures', '--max-score-drop', '100'], dir)).code, 0)
  mkdirSync(join(dir, 'sub'))
  assert.equal((await evals(['compare', dir, 'one', 'two', '--allow-removed', '--allow-new-failures', '--max-score-drop', '100'], join(dir, 'sub'))).code, 0)
})

test('a module target that ignores its abort signal does not keep the command running', async () => {
  const dir = project(`return new Promise((done) => setTimeout(() => done('late'), 20000))`, [caseOf('slow', [{ type: 'contains', value: 'late' }])], { run: { retries: 0, timeoutMs: 200 } })
  const started = Date.now()
  const out = await evals(['run', '--quiet'], dir)
  assert.equal(out.code, 1); assert.match(out.out, /did not answer a single case/)
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`)
})
