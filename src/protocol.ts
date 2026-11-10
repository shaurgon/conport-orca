// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The data shapes are the JSON the `conport epic ... --json` and `conport task list --json`
// commands print.

/** A refusal of the conport CLI (or of orca), shown to the person as is. */
export interface Refusal {
  code: string
  message: string
  /** The one thing to do about it; empty when the refusal names none. */
  action: string
}

/** What every worker answer is: the data, or the refusal that stands in its place. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: Refusal }

/** A repository and its ConPort project. */
export interface RepoContext {
  /** The main working tree of the repository. */
  root: string
  /** The project as written in the settings or by the person: a handle or a name. */
  project: string | null
  /** Where `project` came from. */
  source: 'repository' | 'stored' | null
}

/** A project of Orca's sidebar, as `orca repo list` names it, with its ConPort project. */
export interface OrcaProject extends RepoContext {
  /** The name Orca shows for it. */
  name: string
  /** A folder without git cannot run an epic. */
  kind: 'git' | 'folder'
  /** The repository of the workspace in focus. */
  focused: boolean
}

export type RunPhase = 'none' | 'preparing' | 'running' | 'finishing' | 'held' | 'ready' | 'stopped'

/** The milestone of an epic, as `conport epic list` names it. */
export interface Milestone {
  id: number
  title: string
  /** The place of the milestone in the roadmap: the lower, the sooner. */
  sequence: number
  is_release: boolean
  /** A release whose every epic is closed. */
  ready_to_close: boolean
  /** How many epics of the milestone are open. */
  open_epics: number
}

/** `conport epic list --json` */
export interface EpicList {
  /** The handle of the project. */
  project: string
  epics: Array<{
    id: number
    title: string
    /** The status of the epic in ConPort. */
    status: string
    /** The tasks of the epic in ConPort: those not closed, of all. */
    progress: { open: number; total: number }
    milestone: Milestone | null
    runnable: boolean
    reason: string | null
    run: { phase: RunPhase } | null
    /**
     * Every task closed, and the core's newest readiness entry of the epic says it is ready to
     * merge, written after the last change of its tasks.
     */
    ready: boolean
  }>
}

export type EpicSummary = EpicList['epics'][number]

/** A task of the project outside its epics, as `conport task list` names it. */
export interface OutsideTask {
  id: number
  title: string
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW'
  /** 1 critical … 5 idle. */
  priority: number
  /** In progress after a review that asked for changes: its fixes are due. */
  changes_requested: boolean
}

/** `conport task list --json`: the open tasks of the project outside its epics, by priority. */
export interface TaskList {
  /** The handle of the project. */
  project: string
  tasks: OutsideTask[]
}

/** What an agent is handed a task for: to do it, to review the work done, or to fix what the review found. */
export type HandMode = 'do' | 'review' | 'fix'

export type RunOutcome =
  | null
  | { kind: 'ready'; head: string }
  | { kind: 'held'; reasons: string[] }
  | { kind: 'stopped' }

/** A stop-list question of an epic's run, the fields the panel reads: its text and options are Orca's to show. */
export interface RunQuestion {
  /** The task it is about; null for the epic itself. */
  task: number | null
  case: number
  /** Orca would not take it: no gate in Orca holds it, it is answered with `conport epic answer` only. */
  refused: boolean
}

/**
 * `conport epic status <N> --json`, the fields the panel reads: the CLI prints more (the tasks of
 * the run), which are Orca's to show.
 */
export interface EpicStatus {
  epic: number
  phase: RunPhase
  questions: RunQuestion[]
  outcome: RunOutcome
  /** Why the last run failed, as it refused: given only while the run is held. */
  failure: Refusal | null
}

/** `conport epic agents --json` */
export interface AgentKind {
  id: string
  label: string
  command: string
  found: boolean
}

/** The agent chosen for each role of a run. */
export interface Roles {
  implementer: string
  reviewer: string
  gapHunter: string
  finalReviewer: string
}

/** Names the epic a request is about. */
export interface EpicRef {
  /** The project handle (or name, before the handle is known). */
  project: string
  root: string
  epic: number
}

declare module 'orca' {
  interface PluginRequests {
    /** The projects of Orca's sidebar in its order, each with its ConPort project. */
    'projects.list': { output: Result<OrcaProject[]> }
    /** Remembers the project the person typed for this repository. */
    'project.set': { input: { root: string; project: string }; output: Result<RepoContext> }
    /** Forgets the remembered project, so the panel asks again. */
    'project.forget': { input: { root: string }; output: Result<RepoContext> }
    'epics.list': { input: { project: string; root: string }; output: Result<EpicList> }
    /** The open tasks of the project outside its epics. */
    'tasks.list': { input: { project: string; root: string }; output: Result<OutsideTask[]> }
    /**
     * The agent kinds the CLI knows, the roles last chosen in this project and the agent last
     * chosen in it to prepare an epic or to take a task.
     */
    'agents.get': {
      input: { project: string; root: string }
      output: Result<{ agents: AgentKind[]; chosen: Roles | null; preparer?: string | null }>
    }
    /** Reads the state of an epic's run once: the panel asks when the epic is opened. */
    'run.get': { input: EpicRef; output: Result<EpicStatus> }
    /** Opens a terminal in the repository root with the run command. */
    'run.start': { input: EpicRef & { roles: Roles }; output: Result<{ terminalId: string; command: string }> }
    /** Stops the agents of the epic, then reads its run once. */
    'run.stop': { input: EpicRef; output: Result<EpicStatus> }
    /**
     * Opens a terminal in the repository root with the chosen agent, told to prepare the epic
     * with the person: the spec it lacks, the plan, their upload to ConPort.
     */
    'epic.prepare': { input: EpicRef & { agent: string }; output: Result<{ terminal: string }> }
    /**
     * Opens a terminal in the repository root with the chosen agent, told to do a task outside
     * the epics or to review the work done on it.
     */
    'task.hand': {
      input: { project: string; root: string; task: number; agent: string; mode: HandMode }
      output: Result<{ terminal: string }>
    }
  }
}
