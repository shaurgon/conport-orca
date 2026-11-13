// The command lines of the conport CLI and how its answers read. No Node imports: pure.
import type { HandMode, OutsideTask, Refusal, Result, Roles } from './protocol'

/** The conport CLI release the panel runs: kept equal to the CLI of the same repository. */
export const CLI_VERSION = '0.10.0'

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

/**
 * The document an epic that cannot run lacks, read from the reason `conport epic list` gives:
 * the spec first, as the CLI checks it first. Null for any other reason: nothing to prepare.
 */
export function missingDocument(reason: string | null): 'spec' | 'plan' | null {
  return reason === 'no spec' ? 'spec' : reason === 'no plan' ? 'plan' : null
}

/**
 * The agent kinds that take their first request as a positional argument and start a talk with
 * it: only these can prepare an epic or take a task. Others read that argument as something else
 * (a folder).
 */
export const PREPARE_AGENTS: readonly string[] = ['claude', 'codex', 'cursor']

/** An epic done by the SDD skill: in the working copy of the branch `epic-<N>`, by these subagent types. */
export interface EpicSddPrompt {
  epic: number
  /** The project, as the CLI takes any address of one. */
  project: string
  harness: string
  worktree: string
  /** The branch the epic was cut from and is merged into by the person. */
  base: string
  roles: Roles
}

/** An epic done by the workflow `/conport:epic`: in the repository root, on its default branch. */
export interface EpicWorkflowPrompt {
  epic: number
  project: string
  harness: string
  root: string
  base: string
  way: 'workflow'
}

/**
 * The arguments of `conport prompt epic` after the CLI itself: the task the lead session of an
 * epic is started with. Only Claude Code by the SDD skill is told the subagent types: another
 * harness works by the role texts of the CLI, and the workflow has its own.
 */
export function epicPromptArgs(i: EpicSddPrompt | EpicWorkflowPrompt): string[] {
  const head = ['prompt', 'epic', String(i.epic), '-p', i.project]
  if ('way' in i) return [...head, '--way', 'workflow', '--harness', i.harness, '--root', i.root, '--base', i.base, '--json']
  const types =
    i.harness === 'claude'
      ? ['--implementer', i.roles.implementer, '--reviewer', i.roles.reviewer, '--gap-hunter', i.roles.gapHunter, '--final-reviewer', i.roles.finalReviewer]
      : []
  return [...head, '--way', 'sdd', '--harness', i.harness, '--worktree', i.worktree, '--base', i.base, ...types, '--json']
}

/** The arguments of `conport prompt prepare`: the task of an agent that prepares an epic, for this panel. */
export function preparePromptArgs(i: { epic: number; project: string }): string[] {
  return ['prompt', 'prepare', String(i.epic), '-p', i.project, '--host', 'orca', '--json']
}

/** The arguments of `conport prompt task`: the task of an agent that does, reviews or fixes a task outside the epics. */
export function taskPromptArgs(i: { task: number; project: string; mode: HandMode; agent: string; root: string }): string[] {
  return ['prompt', 'task', String(i.task), '-p', i.project, '--host', 'orca', '--mode', i.mode, '--agent', i.agent, '--root', i.root, '--json']
}

/** The subagent type each role of an epic starts with: the types of the conport plugin. */
export const DEFAULT_ROLES: Roles = {
  implementer: 'conport:sdd-implementer',
  reviewer: 'conport:sdd-task-reviewer',
  gapHunter: 'conport:sdd-gap-hunter',
  finalReviewer: 'conport:sdd-final-reviewer'
}

/** The subagent type of a fix round whose implementer is gone: never chosen. */
export const FIXER_TYPE = 'conport:sdd-fixer'

/**
 * The form of a project handle. The panel never shows one as the name of a project, and the
 * worker keeps what is chosen for an epic under it.
 */
export const HANDLE_FORM = /^pr[a-hjkmnp-z2-9]{8}$/

/** A subagent type is a plain name: it goes into the text of a task and into a command line. */
export const ROLE_TYPE_FORM = /^[\w.:-]+$/

/**
 * What a task outside the epics can be handed to an agent for: a todo one to do, one in review
 * to review, one in progress that its review sent back to fix; null for one an agent is at.
 */
export function handMode(task: OutsideTask): HandMode | null {
  if (task.status === 'TODO') return 'do'
  if (task.status === 'REVIEW') return 'review'
  return task.changes_requested ? 'fix' : null
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
  return { code: 'cli_failed', message: last || `exit code ${exit}`, action: '' }
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
          `${executable === 'npx' || executable === 'node' ? 'Install Node.js and make' : 'Make'} ${executable} visible ` +
          "on the Orca app's PATH, not only the terminal's; then restart Orca."
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
      error: { code: 'bad_output', message: `${program} did not answer with JSON`, action: `Update ${program}.` }
    }
  }
  return { ok: true, data: body }
}
