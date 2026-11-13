// Runs a child process and collects its output. Worker only: imports Node.
import { spawn } from 'node:child_process'
import type { ProcessResult } from './cli'

/** Past this a command is killed: `npx` may download the CLI on its first run. */
const TIMEOUT_MS = 110_000

/**
 * Runs `argv`, with `env` when given (else the worker's own); past `timeoutMs` (by default
 * TIMEOUT_MS) the command is killed and told as a failure.
 */
export function runProcess(
  argv: readonly string[],
  cwd?: string,
  timeoutMs = TIMEOUT_MS,
  env?: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  const [file, ...args] = argv
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(file ?? '', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, failure: `no answer in ${timeoutMs / 1000} s` })
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => finish({ code: null, stdout, stderr, failure: error.message }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}
