// Target: a shell command. The question goes in on stdin, the answer comes back on stdout.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fillTemplate } from '../util.mjs'
import { shapeOutput, templateVars } from './shape.mjs'

const STDERR_TAIL_CHARS = 300

function programExists(program, cwd) {
  if (program.includes('/')) return existsSync(resolve(cwd, program))
  return spawnSync('sh', ['-c', 'command -v -- "$1"', 'sh', program], { stdio: 'ignore' }).status === 0
}

export function createCommandAdapter(target, { baseDir = process.cwd() } = {}) {
  if (!target.command) throw new Error('a command target needs "command"')
  const useShell = !target.args
  const program = useShell ? target.command.trim().split(/\s+/)[0] : target.command
  return {
    envNames: [],
    describe: () => ({ type: 'command', command: target.command, ...(target.args ? { args: target.args } : {}) }),
    probe: async () => (programExists(program, baseDir) ? { ok: true } : { ok: false, reason: `command not found: ${program}` }),
    call(caseDef, { signal } = {}) {
      const vars = templateVars(caseDef)
      const stdin = target.input === 'json' ? JSON.stringify(vars) : caseDef.input
      return new Promise((done, fail) => {
        const child = useShell
          ? spawn(target.command, { cwd: baseDir, shell: true, signal })
          : spawn(target.command, fillTemplate(target.args, vars), { cwd: baseDir, signal })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (e) => fail(e.name === 'AbortError' ? new Error('the command was stopped (timeout)') : e))
        child.on('close', (code) => {
          if (code !== 0) return fail(new Error(`the command exited with code ${code}: ${stderr.trim().slice(-STDERR_TAIL_CHARS)}`))
          if (target.output !== 'json') return done(shapeOutput(stdout.trim()))
          try { done(shapeOutput(JSON.parse(stdout), target.response)) } catch { fail(new Error('the command did not print valid JSON')) }
        })
        child.stdin.on('error', () => {}) // the command may exit without reading stdin
        child.stdin.end(stdin)
      })
    },
  }
}
