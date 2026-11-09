// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The data shapes are the JSON the `conport epic ... --json` commands print.

/** A refusal of the conport CLI (or of orca), shown to the person as is. */
export interface Refusal {
  code: string
  message: string
  /** The one thing to do about it; empty when the refusal names none. */
  action: string
}

/** What every worker answer is: the data, or the refusal that stands in its place. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: Refusal }

/** The repository the focused workspace belongs to and its ConPort project. */
export interface RepoContext {
  /** The main working tree of the repository. */
  root: string
  /** The project as written in the settings or by the person: a handle or a name. */
  project: string | null
  /** Where `project` came from. */
  source: 'repository' | 'stored' | null
}

export type RunPhase = 'none' | 'preparing' | 'running' | 'finishing' | 'held' | 'ready' | 'stopped'

/** `conport epic list --json` */
export interface EpicList {
  /** The handle of the project. */
  project: string
  epics: Array<{
    id: number
    title: string
    milestone: { id: number; title: string } | null
    runnable: boolean
    reason: string | null
    run: { phase: RunPhase } | null
  }>
}

export type EpicSummary = EpicList['epics'][number]

export type TaskStage = 'waiting' | 'implementing' | 'review' | 'fixing' | 'merging' | 'done' | 'stopped'

export interface StopQuestion {
  task: number | null
  case: number
  text: string
  options: string[]
}

export type RunOutcome =
  | null
  | { kind: 'ready'; head: string }
  | { kind: 'held'; reasons: string[] }
  | { kind: 'stopped' }

/** `conport epic status <N> --json` */
export interface EpicStatus {
  epic: number
  phase: RunPhase
  tasks: Array<{
    id: number
    title: string
    stage: TaskStage
    agent: string | null
    round: number
    worktree: string | null
  }>
  questions: StopQuestion[]
  outcome: RunOutcome
  /** Why merging is paused, or null while it is not. */
  paused: string | null
  /** The gap hunter or the final reviewer at work once every task is done; absent from an older CLI. */
  epicRole?: { role: EpicRole; agent: string } | null
  /** Why the last run failed, as it refused: given only while the run is held. */
  failure: Refusal | null
}

/** The two roles of the epic's end: the gap hunt and the final review. */
export type EpicRole = 'gap-hunter' | 'final-reviewer'

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
    /** The repository of the focused workspace and its project. */
    'context.get': { output: Result<RepoContext> }
    /** Remembers the project the person typed for this repository. */
    'project.set': { input: { root: string; project: string }; output: Result<RepoContext> }
    /** Forgets the remembered project, so the panel asks again. */
    'project.forget': { input: { root: string }; output: Result<RepoContext> }
    'epics.list': { input: { project: string; root: string }; output: Result<EpicList> }
    /** The agent kinds the CLI knows and the roles last chosen in this project. */
    'agents.get': {
      input: { project: string; root: string }
      output: Result<{ agents: AgentKind[]; chosen: Roles | null }>
    }
    /** Reads the board of an epic and keeps watching it. */
    'board.get': { input: EpicRef; output: Result<EpicStatus> }
    /** Opens a terminal in the repository root with the run command. */
    'run.start': { input: EpicRef & { roles: Roles }; output: Result<{ terminalId: string; command: string }> }
    'run.answer': {
      input: EpicRef & { task: number | null; choice: string }
      output: Result<EpicStatus>
    }
    'run.stop': { input: EpicRef; output: Result<EpicStatus> }
    /** Brings the person to the worktree of a task. */
    'task.open': { input: { worktree: string }; output: Result<{ terminal: string }> }
    /** Opens a terminal that prints the journal of a task. */
    'task.journal': { input: EpicRef & { task: number }; output: Result<{ terminalId: string }> }
  }
  interface PluginPanelEvents {
    /** Posted after the worker read the board of the watched epic again. */
    'board.changed': { project: string; epic: number; board: Result<EpicStatus> }
  }
}
