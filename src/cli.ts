// The command lines of the conport CLI and how its answers read. No Node imports: pure.
import type { HandMode, Refusal, Result, Roles } from './protocol'

/** The conport CLI release the panel runs: kept equal to the CLI of the same repository. */
export const CLI_VERSION = '0.6.2'

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

/** What a prepared epic lacks, and of which project. */
export interface PrepareInput {
  epic: number
  /** The project handle, as `conport epic list` answered it. */
  project: string
  missing: 'spec' | 'plan'
}

/**
 * The task an agent is started with to prepare an epic for a run: a talk with the person in
 * the terminal that ends in a spec and a plan in ConPort, each stored only once the person
 * approved it. Every ConPort command it names carries the project and the CLI release of the
 * panel; the API key is never in it, the CLI reads that itself.
 */
export function prepareTask({ epic, project, missing }: PrepareInput): string {
  const npx = `npx -y conport@${CLI_VERSION}`
  const cli = (args: string): string => `\`${npx} ${args} -p ${project}\``
  // The generic API commands name the project by their own flag.
  const api = (args: string): string => `\`${npx} api ${args} --project ${project}\``
  // The tasks the epic already has: a run refuses an open one without a section of the plan.
  const tasks =
    `Read the tasks the epic already has: ${api(`tasks list --parent_task_id ${epic} --status ALL --limit 200`)}. ` +
    'Each task that is neither DONE nor CANCELLED is open. Agree with the person which open tasks the plan keeps; ' +
    `close every other open task before the import, only with the person's consent: ${api('tasks update --task_id <id> --status CANCELLED')}.`
  const planFormat =
    'The plan is a Markdown file: a `# <title>` line at the top; a `## Global Constraints` section with the line ' +
    '`Gate object: {"dir": ".", "commands": ["<a command that checks the repository>"]}` naming the checks of this ' +
    'repository; then one section per task, `### Task <n>: <title>`, each with a `**Goal:**` line and an ' +
    '`**Acceptance:**` line (the import refuses a section without them). The section of every open task the plan ' +
    'keeps has the line `<!-- conport-task: <id> -->` right under its `### Task <n>:` heading, `<id>` being the ' +
    'number of that task; a section without that line becomes a new task.'
  const plan = (spec: string): string[] => [
    `Write the plan of the epic from the spec. ${planFormat} Show it to the person and change it until they approve it.`,
    `Only after the person approved the plan, and the open tasks it does not keep are closed, import it: ` +
      `${cli(`plan import <plan file> --spec ${spec} --epic ${epic}`)}`
  ]
  const steps =
    missing === 'spec'
      ? [
          tasks,
          'Discuss the epic with the person: its goal, what is in and out of it, the constraints. Ask until the design is clear.',
          'Write the spec as a Markdown file with a `# <title>` line at the top. Show it to the person and change it until they approve it.',
          `Only after the person approved the spec, upload it: ${cli('documents upload <spec file> --doc-type spec')}. ` +
            'Its answer is JSON; its `id` is the number of the new document: doc-<id>.',
          ...plan('doc-<id of the uploaded spec>')
        ]
      : [
          `Find the spec of the epic: list the links of the epic with ${api(`links list --item_type task --item_id ${epic}`)}; ` +
            'the spec is the document (`source_type` `doc`) linked to the epic with `clarifies` whose type is `spec`. ' +
            `${cli('documents get doc-<number>')} writes a document to a file and names its type. Read the spec.`,
          tasks,
          'Discuss the plan with the person: the tasks, their order, the checks of the repository.',
          ...plan('doc-<number of the spec>')
        ]
  return [
    `Prepare epic ${epic} of the ConPort project ${project} for an epic run: ` +
      (missing === 'spec' ? 'it has no spec yet, and needs a spec and a plan.' : 'it has a spec, and needs a plan.'),
    '',
    'Talk with the person in this terminal, in the language they write in. Store nothing in ConPort before they approve it.',
    'Run every ConPort command exactly as written here, with the CLI release and the project it names. ' +
      'Never print or pass the ConPort API key: the CLI reads it itself.',
    '',
    `1. Read the epic: ${api(`tasks get --task_id ${epic}`)}`,
    ...steps.map((step, i) => `${i + 2}. ${step}`),
    `${steps.length + 2}. Tell the person the epic is ready to run: they press refresh in the ConPort Epics panel of Orca.`
  ].join('\n')
}

/** A task outside the epics handed to an agent, and of which project. */
export interface HandInput {
  task: number
  /** The project handle, as `conport task list` answered it. */
  project: string
  mode: HandMode
  /** The agent kind that takes it: it signs its journal entry. */
  agent: string
}

/**
 * The task an agent is started with to do a task outside the epics, or to review the work done
 * on one: the work in this repository and an entry in the journal of the task. Every ConPort
 * command it names carries the project and the CLI release of the panel; the API key is never in
 * it, the CLI reads that itself.
 */
export function handTask({ task, project, mode, agent }: HandInput): string {
  const npx = `npx -y conport@${CLI_VERSION}`
  const cli = (args: string): string => `\`${npx} ${args} -p ${project}\``
  // The generic API commands name the project by their own flag.
  const api = (args: string): string => `\`${npx} api ${args} --project ${project}\``
  const rules = [
    'Talk with the person in this terminal, in the language they write in.',
    'Run every ConPort command exactly as written here, with the CLI release and the project it names. ' +
      'Never print or pass the ConPort API key: the CLI reads it itself. ' +
      'With the ConPort MCP server at hand, its tools for the same steps do as well.'
  ]
  const read = `Read the task: ${api(`tasks get --task_id ${task}`)}, and its journal: ${cli(`journal get --task ${task}`)}.`
  const steps =
    mode === 'do'
      ? [
          read,
          `Take it: ${api(`tasks update --task_id ${task} --status IN_PROGRESS`)}.`,
          'Do the work in this repository, test first, and run the checks the repository names; ' +
            'ask the person when the task is unclear rather than guess.',
          'Write your report to a file: what you did, the checks you ran with their output, the files changed, ' +
            `what is left open. Add it to the journal of the task: ${cli(`journal add --task ${task} --kind report --author implementer:${agent} --body-file <file>`)}. ` +
            'The report moves the task to review.',
          'Tell the person the task waits for review: in the ConPort Epics panel of Orca they press refresh and find it under the tasks to review.'
        ]
      : [
          `${read} Read the brief, the report and the fixes in it.`,
          'Check the work the report names in this repository against the brief: read the changes, run the checks the repository names. ' +
            'You are the reviewer, not the author of the report: judge the work as it is.',
          'Write your review to a file: each finding with where it is and what to do, or why the work is accepted. ' +
            `Add it to the journal of the task: ${cli(`journal add --task ${task} --kind review --verdict <verdict> --author reviewer:${agent} --body-file <file>`)}, ` +
            '`<verdict>` being `approve` when the work is done, or `changes_requested` when a finding must be fixed.',
          'Tell the person the verdict.'
        ]
  return [
    mode === 'do'
      ? `Do task ${task} of the ConPort project ${project}, as the conport skill describes taking a task: set it IN_PROGRESS, do it, report to its journal.`
      : `Review task ${task} of the ConPort project ${project}: read its journal, check the work, write your verdict to its journal.`,
    '',
    ...rules,
    '',
    ...steps.map((step, i) => `${i + 1}. ${step}`)
  ].join('\n')
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
