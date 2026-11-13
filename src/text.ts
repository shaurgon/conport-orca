// What the panel says. Shared by the worker and the panel: no Node imports.
import { FIXER_TYPE } from './cli'
import type { EpicSummary, EpicTask, EpicTaskStatus, HandMode, Milestone, OutsideTask, Roles, Way } from './protocol'

/** The word for `n` things: `one` for exactly 1, `many` for any other number. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** What a release milestone holds: its open epics, or that it is ready to close. */
export function releaseLine(milestone: Milestone): string {
  if (milestone.ready_to_close) return 'Release · ready to close'
  const n = milestone.open_epics
  return `Release · ${n} ${plural(n, 'epic', 'epics')} open`
}

/** The group of the epics outside a milestone. */
export const NO_MILESTONE = 'No milestone'

/** Where an epic stands, from its tasks in ConPort. */
export interface EpicState {
  line: string
  /** The share of closed tasks, 0–100, for an epic in progress; null otherwise. */
  share: number | null
  closed: number
  total: number
}

/**
 * Where an epic stands in ConPort: ready to merge by the readiness entry of the core; in progress
 * once the epic is taken or a task is closed; else not started.
 */
export function epicState(epic: EpicSummary): EpicState {
  const { open, total } = epic.progress
  const closed = total - open
  if (epic.ready) return { line: `Ready to merge · ${closed} of ${total} closed`, share: null, closed, total }
  if (epic.status === 'IN_PROGRESS' || closed > 0) {
    const share = total > 0 ? Math.round((closed / total) * 100) : 0
    return { line: `In progress · ${closed} of ${total} closed`, share, closed, total }
  }
  return { line: `Not started · ${total} ${plural(total, 'task', 'tasks')}`, share: null, closed, total }
}

/** What an epic that cannot start lacks, said on its row in the tab Prepare. */
export const PREPARE_STATE = {
  spec: 'No spec',
  plan: 'Spec, no plan',
  other: 'Not ready to run for another reason'
} as const

/** What Prepare does for an epic without a spec or a plan. */
export const PREPARE_HINT =
  'The agent talks the epic through with you and writes its spec and plan; then the epic appears in the Ready to run tab.'

/** What to do about an agent that cannot be told its task: choose one of those that can. */
export const PREPARE_AGENTS_ACTION = 'Choose Claude Code, Codex or Cursor.'

/** Why no agent can be chosen in the sheet: none of those that take a task is found. */
export const NO_TASK_AGENT = 'Only Claude Code, Codex and Cursor take a task, and none of them was found'

/** Where the preparation of an epic went, and what to do once it is over. */
export const prepareNotice = (epic: number, project: string): string =>
  `Preparation of epic ${epic} is open in terminal “conport prepare ${epic}” of repository “${project}”: ` +
  'the agent is waiting for you there. Once the plan is in ConPort, press Refresh.'

/** Where a task handed to an agent went, and what comes of it. */
export function handNotice(task: number, mode: HandMode, project: string): string {
  if (mode === 'fix') {
    return (
      `Fixes of task ${task} are open in terminal “conport fix ${task}” of repository “${project}”: the agent is waiting for you there. ` +
      'Once it writes its fixes to the journal, the task waits for review again; press Refresh.'
    )
  }
  return mode === 'do'
    ? `Task ${task} is open in terminal “conport task ${task}” of repository “${project}”: the agent is waiting for you there. ` +
        'The work goes to a separate branch of the task, and you merge it. ' +
        'Once the agent writes its report, the task waits for review; press Refresh.'
    : `Review of task ${task} is open in terminal “conport review ${task}” of repository “${project}”: ` +
        "the agent writes its verdict to the task's journal and, on approval, closes the task with your consent."
}

/** Where the agent of an epic is: said once it is started, and on the screen of an epic whose session is alive. */
export const startNotice = (epic: number, way: Way): string =>
  way === 'sdd'
    ? `The agent of epic ${epic} is open in the terminal of working copy epic-${epic}; it asks its questions there`
    : `The agent of epic ${epic} is open in a terminal at the repository root; it asks its questions there`

/** Why a project of Orca that is a plain folder cannot run an epic. */
export const FOLDER_NOTE = 'Folder without git — nothing to run'

/** The four roles of an epic, each a subagent type of its harness. */
export const ROLE_TITLES: Record<keyof Roles, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  gapHunter: 'Gap hunter',
  finalReviewer: 'Final reviewer'
}

/** The two ways an epic is done. */
export const WAY_LABELS: Record<Way, string> = { sdd: 'SDD skill', workflow: '/conport:epic' }

/** Under the switch, by the workflow: what it does on its own. */
export const WORKFLOW_NOTE =
  'The workflow works in the repository root on the main branch: it starts with its own checks, merges the tasks into the main branch and closes the epic itself'

/** Under the roles: who fixes what a review found is not chosen. */
export const FIXER_NOTE = `Fixes: the same implementer, otherwise ${FIXER_TYPE}`

/** Why the role lists are off by the workflow. */
export const ROLES_FIXED_NOTE = 'The workflow has its subagent types built in'

/** Why the role lists are off for a harness whose subagents have no types. */
export const ROLES_UNTYPED_NOTE = 'This harness has no typed subagents: the roles follow the texts of conport agent <role>'

/** Why the role lists are off when the subagent types cannot be read: `what` is the refusal, in the panel's words. */
export const rolesUnavailableNote = (what: string): string => `The subagent list is unavailable, so the roles keep their default types: ${what}`

/** Beside a role whose type the list of the harness lacks. */
export const TYPE_MISSING_NOTE = 'Type not found — install or update the conport plugin.'

/** Under Start by the SDD skill, when the working copy of the epic is there and no agent is in it. */
export const COPY_NOTE = 'The working copy is already there: the agent resumes where the work stopped'

/** Under Start by the workflow, when branches of an earlier start of it are there. */
export const BRANCHES_NOTE = 'The workflow picks up the branches from the earlier start'

/** Under a Start that waits: the epic was started and its agent is not yet seen in the terminal. */
export const STARTED_NOTE = 'The agent is opening in a terminal: press Refresh to see its session'

/** Why the role lists are off for a harness that is not found: its subagent types are not asked for. */
export const ROLES_NO_HARNESS_NOTE = 'Harness not found: its subagent types cannot be read'

/** What a second start does while the session of the epic is alive: asked before it. */
export const RESTART_NOTE = "The epic's session is live. A new start opens one more agent with the same task; the old terminal stays open."

/** The refusal `way_needs_claude`, said beside a start that cannot be pressed. */
export const WAY_NEEDS_CLAUDE = {
  what: 'The /conport:epic mode is only in Claude Code with the conport plugin',
  action: 'Choose the Claude Code harness.'
} as const

/** A status of a task of an epic, as its row says it. */
export const TASK_STATUS: Record<EpicTaskStatus, string> = {
  TODO: 'to do',
  IN_PROGRESS: 'in progress',
  REVIEW: 'in review',
  BLOCKED: 'blocked',
  PARKED: 'parked',
  DONE: 'done',
  CANCELLED: 'cancelled'
}

/** The tasks of an epic by status; a cancelled one is in no count, nor in the total. */
export interface TaskCounts {
  todo: number
  inProgress: number
  review: number
  blocked: number
  parked: number
  done: number
  total: number
}

export function taskCounts(tasks: EpicTask[]): TaskCounts {
  const of = (status: EpicTaskStatus): number => tasks.filter((task) => task.status === status).length
  const counts = {
    todo: of('TODO'),
    inProgress: of('IN_PROGRESS'),
    review: of('REVIEW'),
    blocked: of('BLOCKED'),
    parked: of('PARKED'),
    done: of('DONE')
  }
  return { ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

/** The counts of an epic in one line; the parked ones only when there are some. */
export function taskCountsLine(counts: TaskCounts): string {
  const shown: Array<[EpicTaskStatus, number]> = [
    ['TODO', counts.todo],
    ['IN_PROGRESS', counts.inProgress],
    ['REVIEW', counts.review],
    ['BLOCKED', counts.blocked],
    ['PARKED', counts.parked],
    ['DONE', counts.done]
  ]
  return shown
    .filter(([status, n]) => status !== 'PARKED' || n > 0)
    .map(([status, n]) => `${TASK_STATUS[status]} ${n}`)
    .join(' · ')
}

/** The priority of a task, 1 to 5, in words. */
export const PRIORITY: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Idle'
}

/** The marker for a behaviour defect on its task row. */
export const BUG_LABEL = 'Bug'

/** A task outside the epics on its row: its priority while it waits, else its stage. */
export function taskState(task: OutsideTask): string {
  if (task.status === 'REVIEW') return 'In review'
  if (task.status === 'IN_PROGRESS') return task.changes_requested ? 'Changes requested' : 'In progress'
  return `${PRIORITY[task.priority] ?? 'No priority'} · not started`
}

/** What the agent opened from the sheet does, step by step. */
export const SHEET_STEPS = {
  spec: [
    'Talks the epic through with you and writes the spec',
    'After your yes, uploads it to ConPort',
    "Writes the plan, links the epic's tasks, imports the plan"
  ],
  plan: [
    "Reads the epic's spec and talks the plan through with you",
    "Links the epic's open tasks to the plan",
    'After your yes, imports the plan into ConPort'
  ],
  do: [
    'Starts the task',
    'Does it on its own branch, in a separate working copy beside the repository, checks it and commits',
    "Writes a report with the branch and the commit to the task's journal; the task goes to review"
  ],
  review: [
    "Reads the task's journal: brief, report, fixes",
    'Reviews the branch from the report',
    "Writes a review with a verdict to the task's journal; on approval, with your consent, closes the task"
  ],
  fix: [
    "Reads the task's journal and its latest review with the findings",
    "Continues on the task's branch, fixes and commits",
    "Writes the fixes to the task's journal; the task goes to review again"
  ]
} as const

/** What a failure means, in sentence case, and the one thing to do: one imperative sentence ending with a period. */
export interface FailureText {
  what: string
  action: string
}

/** A refusal said on one line: `What — action.`, the action lowercase after the dash. */
export function oneLine({ what, action }: FailureText): string {
  return `${what} — ${action.charAt(0).toLowerCase()}${action.slice(1)}`
}

const REFRESH = 'Press Refresh.'

/**
 * The refusals about an epic, a task or an agent that the worker says in its own words: whether it
 * found the reason itself or `conport prompt` refused with the same code.
 */
export const REFUSED = {
  epicNotFound: (epic: number): FailureText => ({ what: `Epic ${epic} is not in the project`, action: REFRESH }),
  epicReady: (epic: number): FailureText => ({ what: `Epic ${epic} is already ready to run`, action: 'Press Refresh and start it.' }),
  epicNotPreparable: (epic: number): FailureText => ({
    what: `Epic ${epic} is not ready to run for a reason preparation cannot fix`,
    action: 'Press Refresh and look at the epic in the Prepare tab.'
  }),
  epicNotReady: (epic: number): FailureText => ({
    what: `Epic ${epic} has no spec or no plan`,
    action: 'Prepare the epic in the Prepare tab.'
  }),
  wayNeedsClaude: { what: WAY_NEEDS_CLAUDE.what, action: WAY_NEEDS_CLAUDE.action },
  roleInvalid: { what: 'The subagent type is not a plain name', action: 'Choose a type for the role from the list.' },
  agentCannotPrepare: (noun: 'agent' | 'harness', agent: string): FailureText => ({
    what: `The ${noun} “${agent}” does not take a task at start`,
    action: PREPARE_AGENTS_ACTION
  }),
  taskNotFound: (task: number): FailureText => ({ what: `Task ${task} is not among the open tasks outside the epics`, action: REFRESH }),
  taskMoved: (task: number, mode: HandMode): FailureText => ({
    what: { do: `Task ${task} is already in progress`, review: `Task ${task} is not waiting for review`, fix: `Task ${task} is not waiting for fixes` }[mode],
    action: REFRESH
  })
}

/** What the worker asked `conport prompt` for: the request a refusal of it answers. */
export type PromptSubject =
  | { command: 'epic'; epic: number; harness: string }
  | { command: 'prepare'; epic: number }
  | { command: 'task'; task: number; mode: HandMode }

/**
 * A refusal of `conport prompt` in the words the worker says it in when it finds the reason
 * itself; undefined for a code the panel words by `refusalText`. The CLI words it in English for
 * a terminal: the panel tells the person in its own words.
 */
export function promptRefusal(code: string, subject: PromptSubject): FailureText | undefined {
  const epic = subject.command === 'task' ? undefined : subject.epic
  switch (code) {
    case 'epic_not_found':
      return epic === undefined ? undefined : REFUSED.epicNotFound(epic)
    case 'epic_ready':
      return epic === undefined ? undefined : REFUSED.epicReady(epic)
    case 'epic_not_preparable':
      return epic === undefined ? undefined : REFUSED.epicNotPreparable(epic)
    case 'epic_not_ready':
      return epic === undefined ? undefined : REFUSED.epicNotReady(epic)
    case 'way_needs_claude':
      return REFUSED.wayNeedsClaude
    case 'role_invalid':
      return REFUSED.roleInvalid
    case 'agent_cannot_prepare':
      return subject.command === 'epic' ? REFUSED.agentCannotPrepare('harness', subject.harness) : undefined
    case 'task_not_found':
      return subject.command === 'task' ? REFUSED.taskNotFound(subject.task) : undefined
    case 'task_moved':
      return subject.command === 'task' ? REFUSED.taskMoved(subject.task, subject.mode) : undefined
    default:
      return undefined
  }
}

const ORCA_AWAY: FailureText = { what: 'Orca did not answer', action: 'Check that Orca is running and try again.' }

/**
 * The refusals of the conport and orca CLIs by code, for the commands the plugin runs. The CLIs
 * word them in English for a terminal, and orca names no action: the panel says them by their code.
 */
const FAILURES: Record<string, FailureText> = {
  no_project: { what: 'No ConPort project is named', action: 'Bind the project in the panel and try again.' },
  project_not_found: {
    what: 'ConPort project not found',
    action: 'Check the project binding in the panel or CONPORT_PROJECT_NAME and try again.'
  },
  no_api_key: { what: 'No ConPort API key', action: 'Add CONPORT_API_KEY to ~/.config/conport/.env and try again.' },
  conport_unreachable: { what: 'ConPort did not answer', action: 'Check the network and try again.' },
  invalid_argument: { what: "The CLI did not accept the plugin's command", action: 'Update the plugin and try again.' },
  subagents_unavailable: {
    what: 'No answer from claude plugin list',
    action: "Install Claude Code or make claude visible on the Orca app's PATH, and try again."
  },
  command_removed: { what: 'The plugin called a command the CLI no longer has', action: 'Update the plugin.' },
  runtime_unavailable: ORCA_AWAY,
  runtime_timeout: ORCA_AWAY,
  unexpected_answer: { what: 'Orca answered in a way the plugin does not expect', action: 'Update Orca and try again.' },
  terminal_not_found: { what: 'Orca did not find the terminal', action: REFRESH }
}

/** The text of a known code; undefined for a code not known. */
function known(code: string): FailureText | undefined {
  return FAILURES[code] ?? httpText(code)
}

/** A status of ConPort the panel can act on: the key refused, or ConPort failing. */
function httpText(code: string): FailureText | undefined {
  const http = /^http_(\d{3})$/.exec(code)
  const status = http ? Number(http[1]) : 0
  if (status === 401 || status === 403) {
    return { what: 'ConPort did not accept the API key', action: 'Check CONPORT_API_KEY in ~/.config/conport/.env and try again.' }
  }
  if (status >= 500) return { what: 'ConPort answered with an error', action: 'Wait a few minutes and try again.' }
  return undefined
}

/** A refusal the panel does not know: what it says of it, and the one thing to do. */
const UNKNOWN_REFUSAL = 'A program refused for a reason the panel does not know'
const UNKNOWN_ACTION = 'Press Refresh; if the refusal repeats, update the plugin and Orca.'

/**
 * The refusals the worker words itself, in the panel's words: shown as they are. Every other refusal
 * comes from the conport or orca CLI, worded for a terminal, or names a program that could not start.
 */
const OWN_REFUSALS = new Set([
  'workspaces_truncated',
  'terminals_truncated',
  'project_not_handle',
  'session_gone',
  'harness_invalid',
  'workspace_ambiguous',
  'no_workspace',
  'no_repository',
  'root_not_open',
  'empty_project',
  'epic_not_found',
  'epic_ready',
  'epic_not_preparable',
  'task_not_found',
  'task_moved',
  'agent_not_found',
  'agent_cannot_prepare',
  'epic_not_ready',
  'way_needs_claude',
  'role_invalid',
  'root_detached',
  'epic_started_sdd',
  'epic_started_workflow',
  'epic_branch_taken',
  'git_failed',
  'bad_output',
  'worker'
])

/** What a refused action of the panel says: its own words, or the CLI's code said in the panel's words. */
export function refusalText(refusal: { code: string; message: string; action: string }): FailureText {
  if (OWN_REFUSALS.has(refusal.code)) return { what: refusal.message || refusal.code, action: refusal.action }
  // The worker words the action itself; its message carries the error of Node after the program.
  if (refusal.code === 'spawn_failed') {
    const program = /^([^:\s]+):/.exec(refusal.message)?.[1]
    return { what: program ? `Could not start ${program}` : 'Could not start a program', action: refusal.action }
  }
  const text = known(refusal.code)
  if (text) return text
  // Orca refuses with its own words and names no action: its words are shown as they are. A line
  // of an error stream that is no refusal (`cli_failed`) comes without an action too, and is not.
  const ofOrca = refusal.action === '' && refusal.code !== 'cli_failed' && refusal.message.trim() !== ''
  return { what: ofOrca ? refusal.message : UNKNOWN_REFUSAL, action: UNKNOWN_ACTION }
}

/**
 * The one thing to do about an agent kind found neither on the PATH of Orca's app nor among the
 * agents of the focused workspace: once Orca runs it there, the worker sees it through the host.
 */
export const AGENT_MISSING_ACTION = 'Start the agent in this Orca workspace and press Refresh.'

/** The same for the harness of an epic. */
export const HARNESS_MISSING_ACTION = 'Start it in this Orca workspace and press Refresh.'
