// Answers of `conport sdd list --json` and `conport epic ... --json` in the shape the CLI prints them, one of `orca worktree list --json` in the shape Orca prints it, and
// answers of the worker about an epic, for the tests and the check scenarios.
import { DEFAULT_ROLES } from '../src/cli'
import type {
  AgentKind,
  EpicList,
  EpicSession,
  EpicTask,
  Milestone,
  Refusal,
  SddList,
  SubagentList,
  TakenList
} from '../src/protocol'

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

/**
 * `conport sdd list --json`: an epic In work taken from another client, one waiting to start
 * made from spec 20 of idea 5, a tagged spec and an epic with a spec and no plan, ideas in each
 * state a row shows, a proposal, one proposal the CLI could not read and a service epic.
 */
export const SDD_LIST: SddList = {
  project: HANDLE,
  in_work: [
    {
      id: 7,
      title: 'Search by meaning',
      status: 'IN_PROGRESS',
      updated_at: '2026-11-16T09:12:00Z',
      progress: { open: 5, total: 6 },
      milestone: RELEASE,
      ready: false,
      reason: null,
      spec: 18,
      idea: null
    },
    {
      id: 15,
      title: 'Offline mode',
      status: 'TODO',
      progress: { open: 4, total: 4 },
      milestone: null,
      ready: false,
      reason: null,
      spec: 20,
      idea: 5
    }
  ],
  specs: [
    { doc: 30, title: 'Archive export', idea: 6, priority: 2, epic: null, status: null },
    { doc: 22, title: 'Audit log', idea: null, priority: 3, epic: 9, status: 'TODO' }
  ],
  ideas: [
    { id: 41, kind: 'task', title: 'Rotate the backup key', status: 'TODO', priority: 2, changes_requested: false },
    { id: 43, kind: 'bug', title: 'Check the backups', status: 'IN_PROGRESS', updated_at: '2026-11-16T10:00:00Z', priority: 3, changes_requested: false },
    { id: 46, kind: 'task', title: 'Simplify the search answer', status: 'IN_PROGRESS', updated_at: '2026-11-15T18:30:00Z', priority: 3, changes_requested: true },
    { id: 42, kind: 'task', title: 'Compare the metrics after the release', status: 'REVIEW', priority: 3, changes_requested: false },
    { id: 47, kind: 'task', title: 'Read the old exports', status: 'BLOCKED', priority: 4, changes_requested: false }
  ],
  proposals: [{ doc: 301, title: 'Proposal: Search in the archive', author: 'Anna' }],
  skipped_proposals: [{ doc: 302, reason: 'no state line' }],
  outside: [
    {
      id: 50,
      title: 'Checks after the release',
      status: 'TODO',
      milestone: null,
      progress: { open: 1, total: 1 },
      tasks: [{ id: 51, kind: 'task', title: 'Compare the latency', status: 'TODO', priority: 2, changes_requested: false }]
    }
  ]
}

/** A project with nothing in any stage. */
export const EMPTY_SDD: SddList = { project: HANDLE, in_work: [], specs: [], ideas: [], proposals: [], skipped_proposals: [], outside: [] }

/** `conport sdd list --taken --json`: the root tasks in progress, the epic and the ideas of SDD_LIST. */
export const TAKEN: TakenList = {
  project: HANDLE,
  taken: [
    { id: 7, kind: 'epic', updated_at: '2026-11-16T09:12:00Z' },
    { id: 43, kind: 'bug', updated_at: '2026-11-16T10:00:00Z' },
    { id: 46, kind: 'task', updated_at: '2026-11-15T18:30:00Z' }
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
  harness: 'claude',
  roles: DEFAULT_ROLES,
  worktree: null,
  alive: false,
  terminal: null,
  ...extra
})

/** Epic 12, ready to start: its working copy was made outside Orca. */
export const EPIC_12_LIST: EpicList = {
  project: HANDLE,
  epics: [
    {
      id: 12,
      title: 'Sync over the air',
      status: 'TODO',
      progress: { open: 2, total: 2 },
      milestone: null,
      runnable: true,
      reason: null,
      ready: false
    }
  ]
}

/** The working copy of epic 12 that Herdr made in its own folder, outside the repository. */
export const HERDR_COPY = '/work/.herdr/worktrees/repo/epic-12'

/**
 * `orca worktree list --json` of a repository at `root` with the copy of epic 12 that Herdr made:
 * Orca lists every working copy git knows, its own or not, in the shape of its real answer.
 */
export function herdrWorktreeList(root: string): unknown {
  const row = (path: string, branch: string, isMainWorktree: boolean, head: string) => ({
    id: `repo-focus::${path}`,
    repoId: 'repo-focus',
    path,
    head,
    branch,
    isBare: false,
    isMainWorktree,
    git: { path, head, branch, isBare: false, isMainWorktree }
  })
  const worktrees = [
    row(root, 'refs/heads/main', true, '5f1c0b7e9a2d4c6b8e0f1a3c5d7e9b1a2c4d6e8f'),
    row(HERDR_COPY, 'refs/heads/epic-12', false, '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b')
  ]
  return { ok: true, result: { worktrees, totalCount: worktrees.length, truncated: false } }
}

/** The working copy of epic 7 is there and no agent is in it. */
export const SESSION_COPY: EpicSession = session({ worktree: '/work/shop/.claude/worktrees/shop/epic-7' })

/** An agent works in the working copy of epic 7. */
export const SESSION_ALIVE: EpicSession = { ...SESSION_COPY, alive: true, terminal: 'term-epic-7' }
