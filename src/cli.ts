// The command lines of the conport CLI and how its answers read. No Node imports: pure.
import type { Refusal, Result, Roles } from './protocol'

/** The conport CLI release the panel runs: kept equal to the CLI of the same repository. */
export const CLI_VERSION = '0.6.1'

/** How the CLI is started, as the person would type it. */
export const CONPORT = ['npx', '-y', `conport@${CLI_VERSION}`]

/** A child process's exit, or why it never ran. */
export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not be started or was killed for running too long. */
  failure?: string
}

/** Quotes a word for a POSIX shell unless it needs no quoting. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

export function commandLine(args: readonly string[]): string {
  return args.map(shellWord).join(' ')
}

/** The command the "Run" button types into a terminal of the repository root. */
export function runCommand(epic: number, project: string, roles: Roles): string {
  return commandLine([
    ...CONPORT,
    'epic',
    'run',
    String(epic),
    '--project',
    project,
    '--host',
    'orca',
    '--implementer',
    roles.implementer,
    '--reviewer',
    roles.reviewer,
    '--gap-hunter',
    roles.gapHunter,
    '--final-reviewer',
    roles.finalReviewer
  ])
}

export function journalCommand(task: number, project: string): string {
  return commandLine([...CONPORT, 'journal', 'get', '--task', String(task), '--project', project])
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function asRefusal(value: unknown): Refusal | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as { ok?: unknown; error?: unknown }
  if (body.ok !== false || typeof body.error !== 'object' || body.error === null) return undefined
  const error = body.error as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { code: text(error.code) || 'refused', message: text(error.message), action: text(error.action) }
}

/** `<code>: <what> — <one action>`, the line a refusing command prints to its error stream. */
function refusalLine(stderr: string, exit: number | null): Refusal {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  const match = /^([\w.-]+):\s*(.+?)\s+—\s+(.+)$/.exec(last)
  if (match) return { code: match[1] ?? '', message: match[2] ?? '', action: match[3] ?? '' }
  return { code: 'cli_failed', message: last || `код выхода ${exit}`, action: '' }
}

/**
 * Reads what a `--json` command answered: its JSON on success, its refusal otherwise —
 * `{"ok": false, "error": {code, message, action}}` on standard output, or else the one line
 * of the error stream.
 */
export function interpret(program: string, result: ProcessResult, executable = program): Result<unknown> {
  if (result.failure !== undefined) {
    return {
      ok: false,
      error: {
        code: 'spawn_failed',
        message: `${executable}: ${result.failure}`,
        action:
          `${executable === 'npx' || executable === 'node' ? 'установите Node.js и ' : ''}` +
          `сделайте ${executable} видимым в PATH приложения Orca, а не только терминала; затем перезапустите Orca`
      }
    }
  }
  const body = parseJson(result.stdout)
  const refusal = asRefusal(body)
  if (refusal) return { ok: false, error: refusal }
  if (result.code !== 0) return { ok: false, error: refusalLine(result.stderr, result.code) }
  if (body === undefined) {
    return {
      ok: false,
      error: { code: 'bad_output', message: `${program} ответил не JSON`, action: `обновите ${program}` }
    }
  }
  return { ok: true, data: body }
}
