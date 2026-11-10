// Answers of `conport epic ... --json` and `conport task list --json` in the shape the CLI prints
// them, and answers of the worker about an epic, for the tests and the check scenarios.
import { DEFAULT_ROLES } from '../src/cli'
import type { AgentKind, EpicList, EpicSession, EpicTask, Milestone, Refusal, SubagentList, TaskList } from '../src/protocol'

export const HANDLE = 'prk7m2qx9d'

/** A release milestone with two of its epics open. */
export const RELEASE: Milestone = {
  id: 3,
  title: 'Release 2.4',
  sequence: 2,
  is_release: true,
  ready_to_close: false,
  open_epics: 2
}

export const EPIC_LIST: EpicList = {
  project: HANDLE,
  epics: [
    {
      id: 7,
      title: 'Search by meaning',
      status: 'IN_PROGRESS',
      progress: { open: 5, total: 6 },
      milestone: RELEASE,
      runnable: true,
      reason: null,
      ready: false
    },
    {
      id: 9,
      title: 'Archive export',
      status: 'TODO',
      progress: { open: 3, total: 3 },
      milestone: RELEASE,
      runnable: false,
      reason: 'no plan',
      ready: false
    },
    {
      id: 10,
      title: 'Audit log',
      status: 'TODO',
      progress: { open: 0, total: 0 },
      milestone: null,
      runnable: false,
      reason: 'no spec',
      ready: false
    },
    {
      id: 15,
      title: 'Offline mode',
      status: 'TODO',
      progress: { open: 4, total: 4 },
      milestone: null,
      runnable: true,
      reason: null,
      ready: false
    }
  ]
}

export const EPIC_WITHOUT_PLAN: EpicList = {
  project: HANDLE,
  epics: EPIC_LIST.epics.filter((e) => e.id === 9)
}

export const EMPTY_LIST: EpicList = { project: HANDLE, epics: [] }

/** The tasks of the project outside its epics, by priority, as `conport task list` prints them. */
export const TASK_LIST: TaskList = {
  project: HANDLE,
  tasks: [
    { id: 41, title: 'Rotate the backup key', status: 'TODO', priority: 2, changes_requested: false },
    { id: 42, title: 'Compare the metrics after the release', status: 'REVIEW', priority: 3, changes_requested: false },
    { id: 43, title: 'Check the backups', status: 'IN_PROGRESS', priority: 3, changes_requested: false },
    { id: 44, title: 'Simplify the search answer', status: 'TODO', priority: 3, changes_requested: false },
    { id: 45, title: 'Hints on an empty search', status: 'TODO', priority: 4, changes_requested: false }
  ]
}

export const AGENTS: { agents: AgentKind[] } = {
  agents: [
    { id: 'claude', label: 'Claude Code', command: 'claude', found: true },
    { id: 'codex', label: 'Codex', command: 'codex', found: true },
    { id: 'gemini', label: 'Gemini CLI', command: 'gemini', found: false }
  ]
}

/** A third harness, found on the machine. */
export const CURSOR: AgentKind = { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: true }

/** As the CLI words it, in English. */
export const NO_KEY: Refusal = {
  code: 'no_api_key',
  message: 'CONPORT_API_KEY is not set',
  action: 'put CONPORT_API_KEY=<key> in ~/.config/conport/.env'
}

/** The tasks of an epic in the order ConPort lists them, one in each of the seven statuses. */
export const EPIC_TASKS: EpicTask[] = [
  { id: 30, title: 'Drop the old index', status: 'CANCELLED' },
  { id: 36, title: 'Measure the search', status: 'PARKED' },
  { id: 31, title: 'Store the embeddings', status: 'DONE' },
  { id: 35, title: 'Rank the answers', status: 'TODO' },
  { id: 32, title: 'Build the index', status: 'REVIEW' },
  { id: 34, title: 'Read the queries', status: 'BLOCKED' },
  { id: 33, title: 'Search by a phrase', status: 'IN_PROGRESS' }
]

/** `conport epic subagents --harness claude --json`: the types of the conport plugin and one of each other source. */
export const SUBAGENTS: SubagentList = {
  harness: 'claude',
  typed: true,
  subagents: [
    { type: 'conport:sdd-implementer', source: 'plugin', plugin: 'conport', description: 'Implements one task of a plan' },
    { type: 'conport:sdd-task-reviewer', source: 'plugin', plugin: 'conport', description: 'Reviews one task' },
    { type: 'conport:sdd-gap-hunter', source: 'plugin', plugin: 'conport', description: 'Looks for what the plan missed' },
    { type: 'conport:sdd-final-reviewer', source: 'plugin', plugin: 'conport', description: 'Reviews the whole branch' },
    { type: 'conport:sdd-fixer', source: 'plugin', plugin: 'conport', description: 'Fixes what a review found' },
    { type: 'sdd-task-reviewer', source: 'user', plugin: null, description: 'Reviews one task' },
    { type: 'gap-hunter', source: 'project', plugin: null, description: 'Looks for what the plan missed' }
  ]
}

/** What a harness without typed subagents answers. */
export const untyped = (harness: string): SubagentList => ({ harness, typed: false, subagents: [] })

/** `epic.session` of an epic never started: the defaults, no working copy, no session. */
export const session = (extra: Partial<EpicSession> = {}): EpicSession => ({
  way: 'sdd',
  harness: 'claude',
  roles: DEFAULT_ROLES,
  worktree: null,
  alive: false,
  terminal: null,
  workflowBranches: false,
  ...extra
})

/** The working copy of epic 7 is there and no agent is in it. */
export const SESSION_COPY: EpicSession = session({ worktree: '/work/shop/.claude/worktrees/shop/epic-7' })

/** An agent works in the working copy of epic 7. */
export const SESSION_ALIVE: EpicSession = { ...SESSION_COPY, alive: true, terminal: 'term-epic-7' }

/** The workflow was chosen for the epic, and branches of an earlier start of it are there. */
export const SESSION_WORKFLOW: EpicSession = session({ way: 'workflow', workflowBranches: true })
