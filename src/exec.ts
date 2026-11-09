// Runs a child process and collects its output. Worker only: imports Node.
import { spawn } from 'node:child_process'
import type { ProcessResult } from './cli'

/** Past this a command is killed: `npx` may download the CLI on its first run. */
const TIMEOUT_MS = 110_000

export function runProcess(argv: readonly string[], cwd?: string): Promise<ProcessResult> {
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
    const child = spawn(file ?? '', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, failure: `no answer in ${TIMEOUT_MS / 1000} s` })
    }, TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => finish({ code: null, stdout, stderr, failure: error.message }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}
