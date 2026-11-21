// Target: a shell command. The question goes in on stdin, the answer comes back on stdout.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fillTemplate } from '../util.mjs'
import { shapeOutput, templateVars } from './shape.mjs'

const STDERR_TAIL_CHARS = 300

/** Stop a detached child and every process in its group. Already gone is fine. */
export function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL') } catch {
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
}

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
        // detached: the command gets its own process group, so a timeout can stop the shell and
        // everything it started (a pipeline, a server it forked), not just the shell.
        const options = { cwd: baseDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
        const child = useShell ? spawn(target.command, { ...options, shell: true }) : spawn(target.command, fillTemplate(target.args, vars), options)
        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', stop)
          fn(value)
        }
        function stop() {
          killGroup(child)
          child.stdout.destroy()
          child.stderr.destroy()
          child.stdin.destroy()
          finish(fail, new Error('the command was stopped (timeout)'))
        }
        if (signal?.aborted) return stop()
        signal?.addEventListener('abort', stop, { once: true })
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (e) => finish(fail, e))
        child.on('close', (code) => {
          if (code !== 0) return finish(fail, new Error(`the command exited with code ${code}: ${stderr.trim().slice(-STDERR_TAIL_CHARS)}`))
          if (target.output !== 'json') return finish(done, shapeOutput(stdout.trim()))
          try { finish(done, shapeOutput(JSON.parse(stdout), target.response)) } catch { finish(fail, new Error('the command did not print valid JSON')) }
        })
        child.stdin.on('error', () => {}) // the command may exit without reading stdin
        child.stdin.end(stdin)
      })
    },
  }
}
