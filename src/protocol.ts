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
  /**
   * Where `project` came from: `file` — `.conport.json` or `.conport.local.json` of the main
   * working tree; `repository` — `CONPORT_PROJECT_NAME` in its `.claude/settings.local.json`, the
   * old place; `stored` — the binding the panel remembered. `file` with no project: a settings
   * file is there but broken, or git could not tell about the repository, so no project is named
   * and nothing stands in for it until the lines are fixed.
   */
  source: 'file' | 'repository' | 'stored' | null
  /** What the person should know about the settings files, each line naming the one thing to do. */
  lines: string[]
  /**
   * Whether the repository's own files were read for the project. False for a submodule or a
   * worktree of a bare repository, which has no main working tree (only the binding names its
   * project); when git could not tell about the repository (no project at all); and for an Orca
   * project of kind `folder`, which is never read.
   */
  filesRead: boolean
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
  kind: 'task' | 'bug'
  title: string
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW'
  /** 1 critical … 5 idle. */
  priority: number
  /** In progress after a review that asked for changes: its fixes are due. */
  changes_requested: boolean
}

/** `conport task list --json`: the open tasks of the project outside its epics, in server order. */
export interface TaskList {
  /** The handle of the project. */
  project: string
  tasks: OutsideTask[]
}

/** What an agent is handed a task for: to do it, to review the work done, or to fix what the review found. */
export type HandMode = 'do' | 'review' | 'fix'

/** `conport epic agents --json` */
export interface AgentKind {
  id: string
  label: string
  command: string
  found: boolean
}

/** The subagent type of the epic's harness chosen for each role of an epic. */
export interface Roles {
  implementer: string
  reviewer: string
  gapHunter: string
  finalReviewer: string
}

/** How an epic is done: by the SDD skill in a working copy of its own, or by the workflow `/conport:epic`. */
export type Way = 'sdd' | 'workflow'

/** Names the epic a request is about. */
export interface EpicRef {
  /**
   * The project: its handle, or the name the person wrote where the CLI resolves it. The
   * requests that read what a start remembered — `epic.session` and `terminal.show` — take the
   * handle only (`project` of `EpicList`) and refuse anything else with `project_not_handle`.
   */
  project: string
  root: string
  epic: number
}

/**
 * What is chosen for an epic and whether its session is alive. The choice is what the last start
 * of the epic remembered; an epic never started answers the defaults.
 */
export interface EpicSession {
  way: Way
  harness: string
  roles: Roles
  /** The path of the working copy on the branch `epic-<N>`; null when there is none. */
  worktree: string | null
  alive: boolean
  /** The terminal of the live session, as orca lists it; null when no session is alive. */
  terminal: string | null
  /** Branches `epic<N>/…` of an earlier run of the workflow are there. */
  workflowBranches: boolean
}

export type EpicTaskStatus = 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'BLOCKED' | 'PARKED' | 'DONE' | 'CANCELLED'

/** A task of an epic, as ConPort names it. */
export interface EpicTask {
  id: number
  title: string
  status: EpicTaskStatus
}

/** A subagent type of a harness, as `conport epic subagents` names it. */
export interface Subagent {
  type: string
  source: 'plugin' | 'user' | 'project'
  /** The plugin the type comes from; null for the user's and the project's. */
  plugin: string | null
  description: string
}

/** `conport epic subagents --harness <kind> --json` */
export interface SubagentList {
  harness: string
  /** False for a harness that has no subagents with types. */
  typed: boolean
  subagents: Subagent[]
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
     * The agent kinds the CLI knows and the agent last chosen in this project to prepare an epic
     * or to take a task.
     */
    'agents.get': {
      input: { project: string; root: string }
      output: Result<{ agents: AgentKind[]; preparer?: string | null }>
    }
    /**
     * Opens a terminal in the repository root with the chosen agent, told to prepare the epic
     * with the person: the spec it lacks, the plan, their upload to ConPort.
     */
    'epic.prepare': { input: EpicRef & { agent: string }; output: Result<{ terminal: string }> }
    /**
     * Starts an epic with the harness chosen for it. By the SDD skill: finds or creates the
     * working copy of the branch `epic-<N>` and opens the harness there with the task of the
     * epic. By the workflow: opens the harness in the repository root, and `worktree` is null.
     * The harness, the roles and the way are remembered for the epic, with the terminal opened.
     */
    'epic.start': {
      input: EpicRef & { way: Way; harness: string; roles: Roles }
      output: Result<{ terminal: string; way: Way; worktree: string | null }>
    }
    /**
     * The way, the harness and the roles of an epic, and whether its session is alive: orca is
     * asked for its working copies and terminals, ConPort is not asked. `project` is the handle
     * the epic list answered with; a name is refused, since a start remembers by the handle.
     */
    'epic.session': { input: EpicRef; output: Result<EpicSession> }
    /** Every task of an epic in ConPort, by its number, the cancelled ones last. */
    'epic.tasks': { input: EpicRef; output: Result<EpicTask[]> }
    /** The subagent types of a harness, read in the repository root. */
    'subagents.get': { input: { root: string; harness: string }; output: Result<SubagentList> }
    /**
     * Brings the terminal of the epic's live session to the front, found anew by the rule of
     * `epic.session`; refused when the epic has no live session. `project` is the handle.
     */
    'terminal.show': { input: EpicRef; output: Result<null> }
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
