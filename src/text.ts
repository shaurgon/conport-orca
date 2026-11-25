// What the panel says. Shared by the worker and the panel: no Node imports.
import { FIXER_TYPE } from './cli'
import type { Assignee, EpicTask, EpicTaskStatus, HandMode, IdeaRow, InWorkRow, Milestone, Roles, RowRef } from './protocol'

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
export function epicState(epic: Pick<InWorkRow, 'progress' | 'ready' | 'status'>): EpicState {
  const { open, total } = epic.progress
  const closed = total - open
  if (epic.ready) return { line: `Ready to merge · ${closed} of ${total} closed`, share: null, closed, total }
  if (epic.status === 'IN_PROGRESS' || closed > 0) {
    const share = total > 0 ? Math.round((closed / total) * 100) : 0
    return { line: `In progress · ${closed} of ${total} closed`, share, closed, total }
  }
  return { line: `Not started · ${total} ${plural(total, 'task', 'tasks')}`, share: null, closed, total }
}

/** A section of the panel: its key, its title, the caption under it and whether it opens unfolded. */
export interface Section {
  key: 'in_work' | 'specs' | 'ideas' | 'outside'
  title: string
  caption: string
  open: boolean
}

/** The sections of the panel in order: what is closer to a release first. */
export const SECTIONS: readonly Section[] = [
  { key: 'in_work', title: 'In work', caption: 'spec + plan', open: true },
  { key: 'specs', title: 'Specs', caption: 'spec, no plan', open: true },
  { key: 'ideas', title: 'Ideas', caption: 'not worked through', open: true },
  { key: 'outside', title: 'Outside SDD', caption: 'no spec', open: false }
]

/** What an empty section says. */
export const EMPTY_SECTION: Record<Section['key'], string> = {
  in_work: 'No epic has its spec and plan.',
  specs: 'No spec waits for its plan.',
  ideas: 'No idea or proposal waits to be worked through.',
  outside: 'Every open epic has a spec.'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A row taken by a session, with the time of its last change in local time: the hour alone
 * today, the day and the month before it on another day.
 */
export function updatedLine(iso: string, now: Date): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'In progress'
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return `In progress · updated ${today ? time : `${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`}`
}

/** What Take over asks before it starts the task of a row another session may hold. */
export const TAKE_OVER_CONFIRM = 'Another session may be working on it'

/** A person as the panel names one: by the email, else by the handle — a handle alone names no colleague. */
export const personName = (person: Assignee): string => person.email || person.handle

/** What Take over asks of a row another person leads; a yes lets the agent take it over. */
export const takeOverQuestion = (name: string): string => `${name} leads this task. Take it over?`

/** The line of a row with the person who leads it, when someone does. */
export const withAssignee = (line: string, assignee: Assignee | null | undefined): string =>
  assignee ? `${line} · ${personName(assignee)}` : line

/** Under the question of Take over: what the start does. */
export const TAKE_OVER_NOTE = 'A new agent starts with the same task and goes on by the journal of the task and its links.'

/** Under the section Ideas: the proposals whose state line the CLI could not read. */
export function skippedLine(n: number): string {
  return `${n} ${plural(n, 'proposal is', 'proposals are')} not shown: ${plural(n, 'its', 'their')} state line cannot be read`
}

/** What to do about an agent that cannot be told its task: choose one of those that can. */
export const TASK_AGENTS_ACTION = 'Choose Claude Code, Codex or Cursor.'

/** Why no agent can be chosen in the sheet: none of those that take a task is found. */
export const NO_TASK_AGENT = 'Only Claude Code, Codex and Cursor take a task, and none of them was found'

/** Where the brainstorm of an idea went. */
export const ideaNotice = (task: number, project: string): string =>
  `Brainstorm of task ${task} is open in terminal “conport idea ${task}” of repository “${project}”: the agent is waiting for you there.`

/** Where the plan of a spec is written: named by its document, or by the epic that has it. */
export function specNotice(target: SpecTarget, project: string): string {
  const name = 'doc' in target ? `doc-${target.doc}` : String(target.epic)
  const what = 'doc' in target ? `Spec doc-${target.doc}` : `The spec of epic ${target.epic}`
  return (
    `${what} is open in terminal “conport spec ${name}” of repository “${project}”: the agent writes the plan with you, ` +
    'then builds the epic. Once the plan is imported, the epic is In work.'
  )
}

/** A proposal declined: no agent was started. */
export const declineNotice = (doc: number): string => `Proposal doc-${doc} is declined with your reason.`

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
export const startNotice = (epic: number): string =>
  `The agent of epic ${epic} is open in the terminal of working copy epic-${epic}; it asks its questions there`

/**
 * On the screen of an epic whose own session is not seen, while the terminal of its spec or its
 * idea — whose agent planned it and builds it — is open on this host.
 */
export const inheritedNotice = (epic: number): string =>
  `The agent that planned epic ${epic} is open in its terminal on this host; it builds the epic and asks its questions there`

/** On the screen of an epic whose live session an earlier release of the panel opened in the repository root. */
export const rootSessionNotice = (epic: number): string =>
  `The agent of epic ${epic} is open in a terminal at the repository root; it asks its questions there`

/** Why a project of Orca that is a plain folder cannot run an epic. */
export const FOLDER_NOTE = 'Folder without git — nothing to run'

/** The four roles of an epic, each a subagent type of its harness. */
export const ROLE_TITLES: Record<keyof Roles, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  gapHunter: 'Gap hunter',
  finalReviewer: 'Final reviewer'
}

/** Under the roles: who fixes what a review found is not chosen. */
export const FIXER_NOTE = `Fixes: the same implementer, otherwise ${FIXER_TYPE}`

/** Why the role lists are off for a harness whose subagents have no types. */
export const ROLES_UNTYPED_NOTE = 'This harness has no typed subagents: the roles follow the texts of conport agent <role>'

/** Why the role lists are off when the subagent types cannot be read: `what` is the refusal, in the panel's words. */
export const rolesUnavailableNote = (what: string): string => `The subagent list is unavailable, so the roles keep their default types: ${what}`

/** Beside a role whose type the list of the harness lacks. */
export const TYPE_MISSING_NOTE = 'Type not found — install or update the conport plugin.'

/** Under Start, when the working copy of the epic is there and no agent is in it. */
export const COPY_NOTE = 'The working copy is already there: the agent resumes where the work stopped'

/** Under a Start that waits: the epic was started and its agent is not yet seen in the terminal. */
export const STARTED_NOTE = 'The agent is opening in a terminal: press Refresh to see its session'

/** Why the role lists are off for a harness that is not found: its subagent types are not asked for. */
export const ROLES_NO_HARNESS_NOTE = 'Harness not found: its subagent types cannot be read'

/** What a second start does while the session of the epic is alive: asked before it. */
export const RESTART_NOTE = "The epic's session is live. A new start opens one more agent with the same task; the old terminal stays open."

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

/** A task or an idea on its row: its priority while it waits, else its stage. */
export function taskState(task: Pick<IdeaRow, 'status' | 'priority' | 'changes_requested'>): string {
  if (task.status === 'REVIEW') return 'In review'
  if (task.status === 'BLOCKED') return 'Blocked'
  if (task.status === 'IN_PROGRESS') return task.changes_requested ? 'Changes requested' : 'In progress'
  return `${PRIORITY[task.priority] ?? 'No priority'} · not started`
}

/** What the agent opened from the sheet does, step by step. */
export const SHEET_STEPS = {
  idea: [
    'Reads the idea, its journal and its links, and takes it',
    'Works it through with you: a small fix, a look into something, or a design',
    'A design ends in a spec you approve; then it asks: Writing the plan means building right after it. Plan and build now?'
  ],
  proposal: [
    'Takes the proposal into design: finds or files its idea',
    'Works the idea through with you: a small fix, a look into something, or a design',
    'A design ends in a spec you approve; then it asks: Writing the plan means building right after it. Plan and build now?'
  ],
  spec: [
    'Reads the spec and the idea it clarifies',
    'Writes the plan with you; after your yes, imports it, and the epic is created in the milestone you name',
    'Builds the epic by SDD in the working copy of its branch'
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
  epicNotReady: (epic: number): FailureText => ({
    what: `Epic ${epic} has no spec or no plan`,
    action: 'Plan it from the Specs section.'
  }),
  roleInvalid: { what: 'The subagent type is not a plain name', action: 'Choose a type for the role from the list.' },
  agentCannotPrepare: (noun: 'agent' | 'harness', agent: string): FailureText => ({
    what: `The ${noun} “${agent}” does not take a task at start`,
    action: TASK_AGENTS_ACTION
  }),
  taskNotFound: (task: number): FailureText => ({ what: `Task ${task} is not among the open tasks of the panel`, action: REFRESH }),
  taskMoved: (task: number, mode: HandMode): FailureText => ({
    what: { do: `Task ${task} is already in progress`, review: `Task ${task} is not waiting for review`, fix: `Task ${task} is not waiting for fixes` }[mode],
    action: REFRESH
  }),
  notAnIdea: (task: number): FailureText => ({ what: `Task ${task} is not an idea: it is an epic or a task of an epic`, action: REFRESH }),
  ideaTaken: (task: number): FailureText => ({ what: `Task ${task} is past brainstorming: it is in review, blocked or closed`, action: REFRESH }),
  ideaNotFound: (task: number): FailureText => ({ what: `Task ${task} is not in the project`, action: REFRESH }),
  noSpec: (target: SpecTarget): FailureText => ({
    what: 'doc' in target ? `Document doc-${target.doc} is not a spec` : `Epic ${target.epic} has no spec`,
    action: REFRESH
  }),
  specPlanned: (target: SpecTarget): FailureText => ({
    what: 'doc' in target ? `Spec doc-${target.doc} already has its plan: its epic is In work` : `Epic ${target.epic} already has its plan: it is In work`,
    action: REFRESH
  }),
  notAProposal: (doc: number): FailureText => ({ what: `Document doc-${doc} is not a proposal`, action: REFRESH }),
  proposalClosed: (doc: number): FailureText => ({ what: `Proposal doc-${doc} is no longer open: it was accepted or declined`, action: REFRESH }),
  proposalAccepted: (doc: number): FailureText => ({ what: `Proposal doc-${doc} already has its idea, and the idea is taken up`, action: REFRESH }),
  reasonMissing: { what: 'No reason is given', action: 'Write why the proposal is declined.' },
  /** A take of a task another person leads, refused by ConPort. */
  assignedToOther: { what: 'The task is led by another person', action: 'Pick another task, or take it over on your word.' },
  /** A row whose terminal this host does not have alive. */
  sessionGone: (row: RowRef): FailureText => {
    const name = { idea: 'Task', task: 'Task', epic: 'Epic', spec: 'Spec doc-' }[row.kind]
    const number = row.kind === 'spec' ? `${name}${row.doc}` : `${name} ${row.id}`
    return { what: `${number} has no live session: its terminal is closed or its agent has exited`, action: REFRESH }
  }
}

/** A spec named by its document, or by the epic that has it. */
export type SpecTarget = { doc: number } | { epic: number }

/** What the worker asked `conport prompt` for: the request a refusal of it answers. */
export type PromptSubject =
  | { command: 'epic'; epic: number; harness: string }
  | { command: 'task'; task: number; mode: HandMode }
  | { command: 'idea'; task: number }
  | { command: 'spec'; target: SpecTarget }

/**
 * A refusal of `conport proposal accept|decline` in the panel's words; undefined for a code the
 * panel words by `refusalText`.
 */
export function proposalRefusal(code: string, doc: number): FailureText | undefined {
  if (code === 'not_a_proposal') return REFUSED.notAProposal(doc)
  if (code === 'proposal_closed') return REFUSED.proposalClosed(doc)
  if (code === 'proposal_accepted') return REFUSED.proposalAccepted(doc)
  return undefined
}

/**
 * A refusal of `conport prompt` in the words the worker says it in when it finds the reason
 * itself; undefined for a code the panel words by `refusalText`. The CLI words it in English for
 * a terminal: the panel tells the person in its own words.
 */
export function promptRefusal(code: string, subject: PromptSubject): FailureText | undefined {
  if (subject.command === 'idea') return ideaRefusal(code, subject.task)
  if (subject.command === 'spec') return specRefusal(code, subject.target)
  const epic = subject.command === 'task' ? undefined : subject.epic
  switch (code) {
    case 'epic_not_found':
      return epic === undefined ? undefined : REFUSED.epicNotFound(epic)
    case 'epic_not_ready':
      return epic === undefined ? undefined : REFUSED.epicNotReady(epic)
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

/** A refusal of `conport prompt idea` in the panel's words. */
function ideaRefusal(code: string, task: number): FailureText | undefined {
  switch (code) {
    case 'not_an_idea':
      return REFUSED.notAnIdea(task)
    case 'idea_taken':
      return REFUSED.ideaTaken(task)
    case 'task_not_found':
      return REFUSED.ideaNotFound(task)
    default:
      return undefined
  }
}

/** A refusal of `conport prompt spec` in the panel's words. */
function specRefusal(code: string, target: SpecTarget): FailureText | undefined {
  switch (code) {
    case 'no_spec':
      return REFUSED.noSpec(target)
    case 'spec_planned':
      return REFUSED.specPlanned(target)
    case 'task_not_found':
      return 'epic' in target ? REFUSED.epicNotFound(target.epic) : undefined
    default:
      return undefined
  }
}

const ORCA_AWAY: FailureText = { what: 'Orca did not answer', action: 'Check that Orca is running and try again.' }

/** The bind card of a repository whose settings file names no project. */
export const BIND_PROJECT =
  'The repository has no .conport.json with project_name. Name the project once — the panel remembers it for this repository.'

/** The bind card of a submodule or a worktree of a bare repository: its settings files are not read. */
export const BIND_PROJECT_NO_FILES =
  'This repository is a submodule or a worktree of a bare repository: ConPort settings files are not read here. Bind a project below.'

/** In place of the bind card while a settings file is there but broken: it names no project, and no binding stands in. */
export const SETTINGS_BROKEN = "The repository's ConPort settings name no project until the lines above are fixed. Fix them and press Refresh."

/**
 * The refusals of the conport and orca CLIs by code, for the commands the plugin runs. The CLIs
 * word them in English for a terminal, and orca names no action: the panel says them by their code.
 */
const FAILURES: Record<string, FailureText> = {
  no_project: { what: 'No ConPort project is named', action: 'Bind the project in the panel and try again.' },
  project_not_found: {
    what: 'ConPort project not found',
    action: 'Check project_name in .conport.json or the project binding in the panel and try again.'
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
  terminal_not_found: { what: 'Orca did not find the terminal', action: REFRESH },
  task_assigned_to_other: REFUSED.assignedToOther
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
export const OWN_REFUSALS: ReadonlySet<string> = new Set([
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
  'task_not_found',
  'task_moved',
  'agent_not_found',
  'agent_cannot_prepare',
  'epic_not_ready',
  'role_invalid',
  'root_detached',
  'epic_branch_taken',
  'not_an_idea',
  'idea_taken',
  'no_spec',
  'spec_planned',
  'not_a_proposal',
  'proposal_accepted',
  'proposal_closed',
  'reason_missing',
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
