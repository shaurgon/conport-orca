// Answers of `conport epic ... --json` and `conport task list --json` in the shape the CLI prints
// them (an epic's run with the fields the panel reads), for the tests and the check scenarios.
import type { AgentKind, EpicList, EpicStatus, Milestone, Refusal, TaskList } from '../src/protocol'

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
      run: { phase: 'running' },
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
      run: null,
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
      run: null,
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
      run: null,
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

export const RUNNING: EpicStatus = {
  epic: 7,
  phase: 'running',
  questions: [],
  outcome: null,
  failure: null
}

/** The run of an epic that never ran. */
export const idle = (epic: number): EpicStatus => ({
  epic,
  phase: 'none',
  questions: [],
  outcome: null,
  failure: null
})

/** A run that broke off on what waiting cannot cure: the record keeps why. */
export const FAILED: EpicStatus = {
  ...RUNNING,
  phase: 'held',
  // As `conport epic status` words it, with the epic's task reference.
  outcome: { kind: 'held', reasons: [`no run of epic task-${RUNNING.epic} is going: start it again with conport epic run ${RUNNING.epic}`] },
  failure: {
    code: 'gate_red',
    message: 'the gate is red on the head of the epic branch before the start',
    action: 'make the gate green on the epic branch, then start the run again'
  }
}

export const STOPPED: EpicStatus = { ...RUNNING, phase: 'stopped', outcome: { kind: 'stopped' } }

/** As the CLI words it, in English. */
export const NO_KEY: Refusal = {
  code: 'no_api_key',
  message: 'CONPORT_API_KEY is not set',
  action: 'put CONPORT_API_KEY=<key> in ~/.config/conport/.env'
}
