// The sidebar panel "ConPort SDD": the work of a ConPort project by the stages of SDD, in four
// sections that fold — In work, Specs, Ideas, Outside SDD — and the screen of an epic In work,
// where its harness and the subagent type of each role are chosen and its agent is started by the
// SDD skill. A row another session took says so, read from ConPort: the panel reads the rows in
// progress once a minute while it is visible, and the whole list when it opens, on Refresh, right
// after its own start, when that light read finds the set changed, and every ten minutes. The
// state of the agents is Orca's. Every CLI call goes through the plugin's worker (src/worker.ts).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  host,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  Progress,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Skeleton,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import { DEFAULT_ROLES, HANDLE_FORM, handMode, TASK_AGENTS } from './cli'
import type {
  AgentKind,
  EpicSession,
  EpicTask,
  HandMode,
  IdeaRow,
  InWorkRow,
  Milestone,
  OrcaProject,
  OutsideRow,
  ProposalRow,
  Refusal,
  RepoContext,
  Result,
  Roles,
  RowRef,
  SddList,
  SpecRow,
  SubagentList,
  TakenList
} from './protocol'
import {
  ACTION,
  FULL_READ_MS,
  ideaRows,
  isProposal,
  needsFullRead,
  POLL_TAKEN_MS,
  rowActions,
  type SddRow,
  takenRows
} from './sdd'
import {
  AGENT_MISSING_ACTION,
  BIND_PROJECT,
  BIND_PROJECT_NO_FILES,
  BUG_LABEL,
  COPY_NOTE,
  declineNotice,
  EMPTY_SECTION,
  epicState,
  FIXER_NOTE,
  FOLDER_NOTE,
  handNotice,
  HARNESS_MISSING_ACTION,
  ideaNotice,
  NO_MILESTONE,
  NO_TASK_AGENT,
  oneLine,
  refusalText,
  releaseLine,
  RESTART_NOTE,
  ROLE_TITLES,
  ROLES_NO_HARNESS_NOTE,
  ROLES_UNTYPED_NOTE,
  rolesUnavailableNote,
  inheritedNotice,
  rootSessionNotice,
  type Section,
  SECTIONS,
  SETTINGS_BROKEN,
  SHEET_STEPS,
  skippedLine,
  specNotice,
  STARTED_NOTE,
  startNotice,
  TAKE_OVER_CONFIRM,
  TAKE_OVER_NOTE,
  TASK_STATUS,
  taskCounts,
  taskCountsLine,
  taskState,
  TYPE_MISSING_NOTE,
  updatedLine
} from './text'

/** `npx` may fetch the CLI on its first call. */
const SLOW = { timeoutMs: 120_000 }

type AgentsAnswer = { agents: AgentKind[]; launcher?: string | null }

/** What is chosen for an epic on its screen: the harness and the subagent type of each role. */
interface Choice {
  harness: string
  roles: Roles
}

/**
 * What the sheet opened over the sections is for: an idea or a proposal to brainstorm, a spec to
 * plan and build, a proposal to decline, or a task to hand to an agent. A test of `kind` narrows
 * to the member of each.
 */
type Sheet =
  | { kind: 'idea'; idea: IdeaRow }
  | { kind: 'proposal'; proposal: ProposalRow }
  | { kind: 'spec'; spec: SpecRow }
  | { kind: 'decline'; proposal: ProposalRow }
  | { kind: HandMode; task: IdeaRow }

const projects = atom<Result<OrcaProject[]> | null>(null)
/** The root of the chosen project; the one chosen last is taken when no project is in focus. */
const chosen = atom<string | null>('project', null, { persist: 'plugin' })
/** The person chose the project in the list: a reload keeps it while Orca lists it. */
const pickedByHand = atom(false)
const pickerOpen = atom(false)
const projectQuery = atom('')
const projectDraft = atom('projectDraft', '')

/** The last full read of the chosen project's stages. */
const sdd = atom<Result<SddList> | null>(null)
/** Why the last full read failed while an earlier list stays shown; null when it did not. */
const listError = atom<Refusal | null>(null)
/** The light read since the last full read; null until there is one. */
const takenList = atom<TakenList | null>(null)
/** The rows whose live terminal this host has, by the key of the row. */
const terminals = atom<Record<string, boolean>>({})
/** The address of the chosen project in the dashboard, where a spec is opened. */
const page = atom<Result<{ url: string }> | null>(null)
const agents = atom<Result<AgentsAnswer> | null>(null)
/** The epic open in each project, by its root. */
const openEpics = atom<Record<string, number>>('epics', {}, { persist: 'plugin' })
/** The sections the person folded or unfolded, by their key: true when folded. */
const collapsed = atom<Record<string, boolean>>('sections', {}, { persist: 'plugin' })
/** What is remembered for the open epic and whether its session is alive, and its tasks in ConPort. */
const session = atom<Result<EpicSession> | null>(null)
const epicTasks = atom<Result<EpicTask[]> | null>(null)
/** The subagent types of each harness asked for since the open epic was read, by harness. */
const subagents = atom<Record<string, Result<SubagentList>>>({})
/**
 * What the person chose for an epic and no start has sent yet, as `<root>:<epic>`. It lives in
 * the panel and is never stored: a start remembers what it was given.
 */
const choices = atom<Record<string, Choice>>({})

/**
 * The sheet open over the sections, with the root of its project: it stays while the panel is
 * closed and opens again with the project, while its row still wants it.
 */
const sheetOpen = atom<{ root: string; sheet: Sheet } | null>('sheet', null, { persist: 'plugin' })
const sheetAgent = atom<string | null>(null)
/** The reason the person writes in the sheet that declines a proposal. */
const reason = atom('')
/** The agent the person picked in the sheet in a project, kept while the project is read again. */
let pickedAgent: { root: string; agent: string } | null = null
/** Take over of a row, asked once more: the row, the sheet its yes opens and the root of its project. */
const takeOverOpen = atom<{ root: string; key: string; then: Sheet } | null>('takeOver', null, { persist: 'plugin' })

/** What the last action was refused with. */
const refusal = atom<Refusal | null>(null)
const notice = atom<string | null>(null)
const busy = atom(false)
/** A second start of an epic whose session is alive, or one another session took, is asked once more. */
const confirmAgain = atom(false)
/**
 * The epic the panel started since the person last had its session read, as `<root>:<epic>`: its
 * start button waits for that read, so a second press opens no second terminal while the agent of
 * the first is not yet seen in it.
 */
const started = atom<string | null>(null)

/**
 * Each load of a project, and each read of an epic, takes a number; an answer is put in only
 * while its load is the last one, so a slow answer for a project left meanwhile is dropped.
 */
let projectLoad = 0
let epicLoad = 0

/** The reads of the list under way in this run of the panel: a tick starts none while one runs. */
let reading = new Set<symbol>()
/** When the list was last read in full, by `Date.now()`. */
let lastFull = 0

/** Whether Orca shows the panel, from the setup of its run; and whether it did at the last draw. */
let visibility: PanelContext['visible'] | null = null
let wasVisible = true

const ROLE_KEYS = ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'] as const

/** The sheet open in the chosen project. */
function openSheetOf(): Sheet | null {
  const open = read(sheetOpen)
  return open !== null && open.root === read(chosen) ? open.sheet : null
}

function setSheet(next: Sheet | null): void {
  const root = read(chosen)
  set(sheetOpen, next === null || root === null ? null : { root, sheet: next })
}

/** The Take over asked in the chosen project. */
function takeOverOf(): { key: string; then: Sheet } | null {
  const open = read(takeOverOpen)
  return open !== null && open.root === read(chosen) ? open : null
}

function setTakeOver(next: { key: string; then: Sheet } | null): void {
  const root = read(chosen)
  set(takeOverOpen, next === null || root === null ? null : { root, ...next })
}

/** The chosen project, while Orca lists it. */
function current(): OrcaProject | null {
  const list = read(projects)
  const root = read(chosen)
  return list?.ok ? (list.data.find((p) => p.root === root) ?? null) : null
}

/** The project handle the CLI answered with for the chosen project. */
function handle(): string | null {
  const list = read(sdd)
  return list?.ok ? list.data.project : null
}

/** The epic open in the chosen project, while it is In work and can be started. */
function openedEpic(): InWorkRow | null {
  const root = read(chosen)
  const list = read(sdd)
  if (root === null || !list?.ok) return null
  const id = read(openEpics)[root]
  return list.data.in_work.find((e) => e.id === id && e.reason === null) ?? null
}

/** The root tasks of the chosen project another session took, by the last reads. */
function taken(): Set<number> {
  const list = read(sdd)
  return list?.ok ? takenRows(list.data, read(takenList)) : new Set()
}

function setOpened(epic: number | null): void {
  const root = read(chosen)
  if (root === null) return
  const { [root]: _dropped, ...others } = read(openEpics)
  set(openEpics, epic === null ? others : { ...others, [root]: epic })
}

/** Runs an action of the panel; its answer is drawn only while `still()` holds when it comes. */
async function act<T>(call: () => Promise<Result<T>>, then: (data: T) => void, still: () => boolean = () => true): Promise<boolean> {
  set(busy, true)
  set(refusal, null)
  let done = false
  try {
    const answer = await call()
    if (!still()) return false
    if (answer.ok) {
      then(answer.data)
      done = true
    } else set(refusal, answer.error)
  } catch {
    // The worker's exception is in its own log; the panel says only that it did not answer.
    if (still()) set(refusal, { code: 'worker', message: "The plugin's worker did not answer", action: 'Close the panel and open it again.' })
  } finally {
    set(busy, false)
  }
  return done
}

function ref(): { project: string; root: string; epic: number } | null {
  const project = handle()
  const root = read(chosen)
  const epic = openedEpic()
  return project === null || root === null || epic === null ? null : { project, root, epic: epic.id }
}

const sameRef = (a: { project: string; root: string; epic: number }, b: ReturnType<typeof ref>): boolean =>
  b !== null && a.project === b.project && a.root === b.root && a.epic === b.epic

const epicKey = (root: string, epic: number): string => `${root}:${epic}`

/** What is chosen for the open epic: the person's choice not yet started, else what its session answered. */
function choiceOf(): Choice | null {
  const root = read(chosen)
  const epic = openedEpic()
  if (root === null || epic === null) return null
  const own = read(choices)[epicKey(root, epic.id)]
  if (own !== undefined) return own
  const state = read(session)
  return state?.ok ? { harness: state.data.harness, roles: state.data.roles } : null
}

/** Changes the choice of the open epic; the choice of every other epic stays. */
function choose(patch: Partial<Choice>): void {
  const root = read(chosen)
  const epic = openedEpic()
  const now = choiceOf()
  if (root === null || epic === null || now === null) return
  set(choices, { ...read(choices), [epicKey(root, epic.id)]: { ...now, ...patch } })
}

/** Reads the subagent types of a harness, once per read of the open epic. */
async function loadSubagents(root: string, harness: string): Promise<void> {
  if (read(subagents)[harness] !== undefined) return
  // A harness that is not found has no types to read: the CLI would only refuse its name.
  if (!canStart(harness)) return
  const mine = epicLoad
  const answer = await plugin.request('subagents.get', { root, harness }, SLOW)
  if (mine === epicLoad) set(subagents, { ...read(subagents), [harness]: answer })
}

/** Another harness has other subagents: the roles go back to the default types. */
async function chooseHarness(harness: string): Promise<void> {
  choose({ harness, roles: DEFAULT_ROLES })
  const root = read(chosen)
  if (root !== null) await loadSubagents(root, harness)
}

/**
 * Reads the open epic once: its session, its tasks and the subagent types of its harness. After a
 * start the person has not asked to read: the types read before stay, and so does the wait of the
 * start button.
 */
async function loadEpic({ afterStart = false }: { afterStart?: boolean } = {}): Promise<void> {
  const mine = ++epicLoad
  set(session, null)
  set(epicTasks, null)
  set(confirmAgain, false)
  if (!afterStart) {
    set(subagents, {})
    set(started, null)
  }
  const target = ref()
  if (target === null) return
  const [state, list] = await Promise.all([
    plugin.request('epic.session', target, SLOW),
    plugin.request('epic.tasks', target, SLOW)
  ])
  if (mine !== epicLoad) return
  set(session, state)
  set(epicTasks, list)
  // The screen of a live session says where the agent is: the notice does not stay over it.
  if (state.ok && state.data.alive) set(notice, null)
  const choice = choiceOf()
  if (choice !== null) await loadSubagents(target.root, choice.harness)
}

/** The agents found on this machine that can be told a task: those the sheet offers. */
const taskAgents = (list: AgentKind[]): AgentKind[] => list.filter((a) => a.found && TASK_AGENTS.includes(a.id))

/** The key a row's terminal is known by in the panel. */
function rowKey(row: SddRow): string {
  switch (row.kind) {
    case 'idea':
      return `task-${row.idea.id}`
    case 'task':
      return `task-${row.task.id}`
    case 'proposal':
      return `doc-${row.proposal.doc}`
    case 'spec':
      return row.spec.epic === null ? `doc-${row.spec.doc}` : `epic-${row.spec.epic}`
    case 'epic':
      return `epic-${row.epic.id}`
  }
}

/** The row a terminal of this host can belong to, as the worker names it; null for one that has none. */
function rowRef(row: SddRow): RowRef | null {
  switch (row.kind) {
    case 'idea':
      return { kind: 'idea', id: row.idea.id }
    case 'spec':
      return row.spec.epic === null
        ? { kind: 'spec', doc: row.spec.doc, idea: row.spec.idea }
        : { kind: 'epic', id: row.spec.epic, spec: row.spec.doc, idea: row.spec.idea }
    case 'epic':
      return { kind: 'epic', id: row.epic.id, spec: row.epic.spec, idea: row.epic.idea }
    default:
      return null
  }
}

/**
 * The rows whose live terminal this host may have: an idea waiting or in progress, a spec — whose
 * plan only the host that opened its terminal knows is being written — and every epic In work,
 * which inherits the terminal of its spec or its idea.
 */
function sessionRows(list: SddList, takenNow: Set<number>): SddRow[] {
  return [
    ...list.ideas
      .filter((idea) => idea.status === 'TODO' || (idea.status === 'IN_PROGRESS' && !idea.changes_requested))
      .map((idea): SddRow => ({ kind: 'idea', idea })),
    ...list.specs.map((spec): SddRow => ({ kind: 'spec', spec })),
    ...list.in_work.filter((epic) => epic.reason === null).map((epic): SddRow => ({ kind: 'epic', epic }))
  ]
}

/** Whether this host has the live terminal of the epic In work, its own or the one it inherits. */
const hasEpicTerminal = (epic: number): boolean => read(terminals)[`epic-${epic}`] === true

/**
 * Asks the worker which rows have their live terminal on this host: every row that may have one
 * after a full read, only the rows `only` names after a light read.
 */
async function readSessions(only?: ReadonlySet<string>): Promise<void> {
  const list = read(sdd)
  const root = read(chosen)
  if (!list?.ok || root === null) return
  const mine = projectLoad
  const project = list.data.project
  const rows = sessionRows(list.data, taken()).filter((row) => only === undefined || only.has(rowKey(row)))
  const answers = await Promise.all(
    rows.map(async (row): Promise<[string, boolean]> => {
      const target = rowRef(row)
      if (target === null) return [rowKey(row), false]
      try {
        const answer = await plugin.request('row.session', { project, root, row: target }, SLOW)
        return [rowKey(row), answer.ok && answer.data.terminal !== null]
      } catch {
        return [rowKey(row), false]
      }
    })
  )
  if (mine !== projectLoad) return
  const found = Object.fromEntries(answers)
  set(terminals, only === undefined ? found : { ...read(terminals), ...found })
}

/** The same row in the list read again, or undefined when it is no longer there. */
function sameIdea(list: SddList, id: number): IdeaRow | undefined {
  return [...list.ideas, ...list.outside.flatMap((epic) => epic.tasks)].find((task) => task.id === id)
}

/**
 * The sheet as it stands with the list read again: the same one, its row as now listed, while
 * that still wants it; else none.
 */
function sheetAfter(open: Sheet, list: Result<SddList>): Sheet | null {
  if (!list.ok) return null
  switch (open.kind) {
    case 'idea': {
      const idea = list.data.ideas.find((i) => i.id === open.idea.id)
      return idea && handMode(idea) !== 'review' && handMode(idea) !== 'fix' && idea.status !== 'BLOCKED' ? { kind: 'idea', idea } : null
    }
    case 'proposal':
    case 'decline': {
      const proposal = list.data.proposals.find((p) => p.doc === open.proposal.doc)
      return proposal ? { kind: open.kind, proposal } : null
    }
    case 'spec': {
      const spec = list.data.specs.find((s) => s.doc === open.spec.doc)
      return spec ? { kind: 'spec', spec } : null
    }
    default: {
      const task = sameIdea(list.data, open.task.id)
      return task && handMode(task) === open.kind ? { kind: open.kind, task } : null
    }
  }
}

/** Who waits for the reads of the list running now to end. */
let idleWaiters: Array<() => void> = []

/** Counts a read of the list while it runs: no other read starts meanwhile. */
async function asRead<T>(run: () => Promise<T>): Promise<T> {
  const running = reading
  const token = Symbol('read')
  running.add(token)
  try {
    return await run()
  } finally {
    running.delete(token)
    if (running.size === 0) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const wake of waiters) wake()
    }
  }
}

/** Resolves once no read of the list runs. */
const idle = (): Promise<void> => (reading.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)))

/** The full read asked for while another read ran: it starts once that one ends, one for all who asked. */
let queuedFull: Promise<void> | null = null

/**
 * Puts in a full read of the list: the taken rows go by it until the next light read. A read that
 * failed while a list is shown keeps that list, with the light read and the sheet that go with it,
 * and says why above it; with no list shown, the refusal is the list.
 */
function putList(list: Result<SddList>): void {
  lastFull = Date.now()
  if (!list.ok && read(sdd)?.ok === true) {
    set(listError, list.error)
    return
  }
  set(listError, null)
  set(sdd, list)
  set(takenList, null)
  const open = openSheetOf()
  if (open !== null) setSheet(sheetAfter(open, list))
  const confirm = takeOverOf()
  if (confirm !== null && sheetAfter(confirm.then, list) === null) setTakeOver(null)
  dropReleasedTakeOver()
}

/**
 * Take over is asked only of a row another session holds: once the row is released, by a full
 * read or a light one, the question goes.
 */
function dropReleasedTakeOver(): void {
  const confirm = takeOverOf()
  const list = read(sdd)
  if (confirm === null || !list?.ok) return
  const id = confirm.then.kind === 'idea' ? confirm.then.idea.id : confirm.then.kind === 'spec' ? confirm.then.spec.epic : null
  if (id === null || !takenRows(list.data, read(takenList)).has(id)) setTakeOver(null)
}

/**
 * Reads the whole list of the chosen project again, the screen as it is: by the timer, and right
 * after a start of the panel's own. Never beside another read: asked while one runs, it reads
 * once that one has ended, so an older answer never lands over a newer one.
 */
async function readList(): Promise<void> {
  if (reading.size === 0) return readListNow()
  queuedFull ??= (async () => {
    while (reading.size > 0) await idle()
    queuedFull = null
    await readListNow()
  })()
  return queuedFull
}

async function readListNow(): Promise<void> {
  const project = current()
  const root = read(chosen)
  if (project === null || root === null || project.project === null) return
  const mine = projectLoad
  const list = await asRead(() => plugin.request('sdd.list', { project: project.project as string, root }, SLOW))
  if (mine !== projectLoad) return
  putList(list)
  if (list.ok && read(openEpics)[root] !== undefined && openedEpic() === null) closeEpic()
  await readSessions()
}

/**
 * The timer of the panel, once a minute while it is visible and no read of the list runs: the
 * light read of the rows in progress, and the whole list when it finds the set changed or ten
 * minutes have passed since the last full read.
 */
async function tick(): Promise<void> {
  if (visibility !== null && !read(visibility)) return
  if (reading.size > 0) return
  const list = read(sdd)
  const root = read(chosen)
  if (list === null || root === null) return
  // A full read that failed is tried again on the same schedule: ten minutes after it.
  if (Date.now() - lastFull >= FULL_READ_MS) return readList()
  if (!list.ok) return
  const mine = projectLoad
  const answer = await asRead(() => plugin.request('sdd.taken', { project: list.data.project, root }, SLOW))
  const now = read(sdd)
  if (mine !== projectLoad || !answer.ok || !now?.ok) return
  const before = takenRows(now.data, read(takenList))
  set(takenList, answer.data)
  dropReleasedTakeOver()
  if (needsFullRead(now.data, answer.data)) return readList()
  const after = takenRows(now.data, answer.data)
  const changed = new Set(
    sessionRows(now.data, after)
      .filter((row) => {
        const id = row.kind === 'idea' ? row.idea.id : row.kind === 'epic' ? row.epic.id : row.kind === 'spec' ? row.spec.epic : null
        return id !== null && before.has(id) !== after.has(id)
      })
      .map(rowKey)
  )
  if (changed.size > 0) await readSessions(changed)
}

/**
 * Reads the chosen project: its stages, the agents, its page in the dashboard and the open epic.
 * With `keepSheet` (the panel back in view) an open sheet stays while its row still wants it.
 */
async function loadProject({ keepSheet = false }: { keepSheet?: boolean } = {}): Promise<void> {
  const mine = ++projectLoad
  // An epic read for the project left is no longer wanted either.
  epicLoad++
  set(sdd, null)
  set(listError, null)
  set(takenList, null)
  set(terminals, {})
  set(page, null)
  set(agents, null)
  set(session, null)
  set(epicTasks, null)
  if (!keepSheet) {
    setSheet(null)
    setTakeOver(null)
  }
  const project = current()
  if (project === null || project.kind !== 'git' || project.project === null) return
  const list = await asRead(() => plugin.request('sdd.list', { project: project.project as string, root: project.root }, SLOW))
  if (mine !== projectLoad) return
  putList(list)
  if (!list.ok) return
  if (read(openEpics)[project.root] !== undefined && openedEpic() === null) setOpened(null)
  const target = { project: list.data.project, root: project.root }
  const [answer, address] = await Promise.all([
    plugin.request('agents.get', target, SLOW),
    plugin.request('project.page', target, SLOW),
    readSessions()
  ])
  if (mine !== projectLoad) return
  set(agents, answer)
  set(page, address)
  // A sheet kept while the panel was closed takes the agent it would open with.
  if (openSheetOf() !== null && read(sheetAgent) === null) set(sheetAgent, defaultAgent())
  await loadEpic()
}

/**
 * The project the panel opens on: the one in focus, else the one chosen last, else the first
 * bound one. A folder without git is never picked.
 */
function initialRoot(list: OrcaProject[]): string | null {
  const usable = list.filter((p) => p.kind === 'git')
  const last = read(chosen)
  const pick =
    usable.find((p) => p.focused) ?? usable.find((p) => p.root === last) ?? usable.find((p) => p.project !== null)
  return pick?.root ?? null
}

async function load({ keepSheet = false }: { keepSheet?: boolean } = {}): Promise<void> {
  set(refusal, null)
  set(notice, null)
  set(projects, null)
  const list = await plugin.request('projects.list', undefined, SLOW)
  set(projects, list)
  if (!list.ok) return
  const kept = read(pickedByHand) ? list.data.find((p) => p.root === read(chosen) && p.kind === 'git') : undefined
  const root = kept?.root ?? initialRoot(list.data)
  // With no project to open on, the one chosen last stays remembered.
  if (root !== null) set(chosen, root)
  await loadProject({ keepSheet })
}

async function chooseProject(root: string): Promise<void> {
  set(pickerOpen, false)
  set(projectQuery, '')
  if (root === read(chosen)) return
  set(chosen, root)
  set(pickedByHand, true)
  set(notice, null)
  set(refusal, null)
  await loadProject()
}

/** Puts what the worker answered for a project's binding into the list. */
function rebind(ctx: RepoContext): void {
  const list = read(projects)
  if (!list?.ok) return
  set(projects, {
    ok: true,
    data: list.data.map((p) => (p.root === ctx.root ? { ...p, project: ctx.project, source: ctx.source, lines: ctx.lines, filesRead: ctx.filesRead } : p))
  })
}

async function rememberProject(value: string): Promise<void> {
  const root = read(chosen)
  if (root === null || value.trim() === '') return
  await act(
    () => plugin.request('project.set', { root, project: value }),
    (ctx) => {
      rebind(ctx)
      set(projectDraft, '')
    }
  )
  await loadProject()
}

async function forgetProject(): Promise<void> {
  const root = read(chosen)
  if (root === null) return
  set(pickerOpen, false)
  await act(() => plugin.request('project.forget', { root }), rebind)
  await loadProject()
}

async function openEpic(epic: number): Promise<void> {
  setOpened(epic)
  set(notice, null)
  set(refusal, null)
  setTakeOver(null)
  await loadEpic()
}

function closeEpic(): void {
  setOpened(null)
  epicLoad++
  set(session, null)
  set(epicTasks, null)
  set(confirmAgain, false)
  set(notice, null)
}

/** Whether the harness is one the agents answer lists as found and able to take a task. */
function canStart(harness: string): boolean {
  const kinds = read(agents)
  return kinds !== null && kinds.ok && harnessFound(kinds.data.agents, harness)
}

/**
 * The subagent types a role can be given, or why none can be chosen and what to do about it;
 * `roles` is what a start sends. No reason is given where the panel already tells it elsewhere.
 */
type RoleLists = { on: true; types: string[]; roles: Roles } | { on: false; note: string | null; action?: string; roles: Roles }

/** The role lists of a choice; null while the subagent types of its harness are being read. */
function roleLists(choice: Choice): RoleLists | null {
  const kinds = read(agents)
  if (kinds === null) return null
  // The agents could not be read: that refusal is told where the harness is chosen, and no harness is known missing.
  if (!kinds.ok) return { on: false, note: null, roles: DEFAULT_ROLES }
  if (!canStart(choice.harness)) return { on: false, note: ROLES_NO_HARNESS_NOTE, roles: DEFAULT_ROLES }
  const answer = read(subagents)[choice.harness]
  if (answer === undefined) return null
  if (!answer.ok) {
    const { what, action } = refusalText(answer.error)
    return { on: false, note: rolesUnavailableNote(what), action, roles: DEFAULT_ROLES }
  }
  if (!answer.data.typed) return { on: false, note: ROLES_UNTYPED_NOTE, roles: DEFAULT_ROLES }
  return { on: true, types: answer.data.subagents.map((s) => s.type), roles: choice.roles }
}

/** Starts the open epic as chosen, then reads its session and its tasks again. */
async function start(): Promise<void> {
  const target = ref()
  const choice = choiceOf()
  const lists = choice === null ? null : roleLists(choice)
  if (target === null || choice === null || lists === null) return
  set(confirmAgain, false)
  const key = epicKey(target.root, target.epic)
  const opened = await act(
    () => plugin.request('epic.start', { ...target, harness: choice.harness, roles: lists.roles }, SLOW),
    () => {
      set(started, key)
      set(notice, startNotice(target.epic))
      // The start remembered the choice: the panel keeps none of its own from now on.
      const { [key]: _sent, ...others } = read(choices)
      set(choices, others)
    },
    () => sameRef(target, ref())
  )
  if (opened) await loadEpic({ afterStart: true })
}

/** Asks the worker to bring the terminal of the open epic's live session to the front. */
async function showTerminal(): Promise<void> {
  const target = ref()
  const epic = openedEpic()
  if (target === null || epic === null) return
  const row = { kind: 'epic' as const, id: target.epic, spec: epic.spec, idea: epic.idea }
  await act(
    () => plugin.request('terminal.show', { project: target.project, root: target.root, row }, SLOW),
    () => undefined,
    () => sameRef(target, ref())
  )
}

/** Asks the worker to bring the live terminal of a row of the sections to the front. */
async function showRowTerminal(row: SddRow): Promise<void> {
  const project = handle()
  const root = read(chosen)
  const target = rowRef(row)
  if (project === null || root === null || target === null) return
  await act(
    () => plugin.request('terminal.show', { project, root, row: target }, SLOW),
    () => undefined,
    () => read(chosen) === root
  )
}

/** Opens a spec in the dashboard, in the team that holds the project. */
async function openSpec(doc: number): Promise<void> {
  const address = read(page)
  if (!address?.ok) return
  set(refusal, null)
  try {
    await host.call('shell.openExternal', { url: `${address.data.url}/documents?id=${doc}` })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    set(refusal, { code: typeof code === 'string' ? code : 'worker', message: 'Orca did not open the dashboard', action: 'Try again.' })
  }
}

/** The agent a sheet opens with: the one picked by hand in this project, else the one of last time, else the first. */
function defaultAgent(): string | null {
  const kinds = read(agents)
  if (!kinds?.ok) return null
  const able = taskAgents(kinds.data.agents).map((a) => a.id)
  const root = read(chosen)
  const picked = pickedAgent !== null && pickedAgent.root === root ? pickedAgent.agent : null
  return [picked, kinds.data.launcher ?? null].find((a) => a !== null && able.includes(a)) ?? able[0] ?? null
}

/** Opens a sheet over the sections; one that starts an agent with the agent it would open with. */
function openSheet(next: Sheet): void {
  setTakeOver(null)
  set(notice, null)
  set(refusal, null)
  if (next.kind === 'decline') {
    set(reason, '')
    setSheet(next)
    return
  }
  if (!read(agents)?.ok) return
  set(sheetAgent, defaultAgent())
  setSheet(next)
}

function pickSheetAgent(agent: string): void {
  set(sheetAgent, agent)
  const root = read(chosen)
  pickedAgent = root === null ? null : { root, agent }
}

/** The agent that took the last task is the one of last time from now on. */
function rememberAgent(agent: string): void {
  const kinds = read(agents)
  if (kinds?.ok) set(agents, { ok: true, data: { ...kinds.data, launcher: agent } })
}

/** Declines the proposal of the sheet with the reason written; nothing is sent without one. */
async function submitDecline(proposal: ProposalRow): Promise<void> {
  const project = handle()
  const root = read(chosen)
  const why = read(reason).trim()
  if (project === null || root === null || why === '') return
  const done = await act(
    () => plugin.request('proposal.decline', { project, root, doc: proposal.doc, reason: why }, SLOW),
    () => {
      setSheet(null)
      set(notice, declineNotice(proposal.doc))
    },
    () => read(chosen) === root
  )
  if (done) await readList()
}

/** Opens the agent of the sheet in a terminal of the project root, with the task of the sheet. */
async function submitSheet(): Promise<void> {
  const open = openSheetOf()
  const agent = read(sheetAgent)
  const project = handle()
  const root = read(chosen)
  const name = current()?.name ?? ''
  if (open === null || project === null || root === null) return
  if (open.kind === 'decline') return submitDecline(open.proposal)
  if (agent === null) return
  // An answer for a project left meanwhile is not told in the chosen one.
  const still = (): boolean => read(chosen) === root
  const done = (text: string): void => {
    setSheet(null)
    set(notice, text)
    rememberAgent(agent)
  }
  let opened: boolean
  switch (open.kind) {
    case 'idea': {
      const task = open.idea.id
      opened = await act(() => plugin.request('idea.start', { project, root, task, agent }, SLOW), () => done(ideaNotice(task, name)), still)
      break
    }
    case 'proposal': {
      const { doc } = open.proposal
      opened = await act(() => plugin.request('proposal.start', { project, root, doc, agent }, SLOW), (data) => done(ideaNotice(data.task, name)), still)
      break
    }
    case 'spec': {
      const target = open.spec.epic === null ? { doc: open.spec.doc } : { epic: open.spec.epic }
      opened = await act(() => plugin.request('spec.start', { project, root, target, agent }, SLOW), () => done(specNotice(target, name)), still)
      break
    }
    default: {
      const { kind: mode, task } = open
      opened = await act(
        () => plugin.request('task.hand', { project, root, task: task.id, agent, mode }, SLOW),
        () => done(handNotice(task.id, mode, name)),
        still
      )
    }
  }
  // The row the agent just took moves: the list is read again right away.
  if (opened) await readList()
}

/**
 * Reads the project again when the panel comes back into view: a row taken or a spec written
 * meanwhile shows. Called while drawing, which takes no change: the load starts after it.
 */
function followVisibility(): void {
  if (visibility === null) return
  const visible = read(visibility)
  if (visible && !wasVisible) setTimeout(() => void loadProject({ keepSheet: true }), 0)
  wasVisible = visible
}

export function setup(ctx: PanelContext): () => void {
  visibility = ctx.visible
  wasVisible = read(ctx.visible)
  pickedAgent = null
  reading = new Set()
  lastFull = 0
  const timer = setInterval(() => void tick(), POLL_TAKEN_MS)
  // A sheet left open when the panel closed opens again, while its row still wants it.
  void load({ keepSheet: true })
  return () => clearInterval(timer)
}

/** A refused action: said in the panel's words by its code, never in the words the CLI prints for a terminal. */
function RefusalBox({ error }: { error: Refusal }) {
  const text = refusalText(error)
  return (
    <Callout tone="danger" icon="error" title={text.what}>
      <Stack gap="xs">
        {text.action ? <Text>{text.action}</Text> : null}
        <Text muted size="xs">
          <Code>{error.code}</Code>
        </Text>
      </Stack>
    </Callout>
  )
}

/** The ConPort project of an Orca project as the picker names it: by name, never by handle. */
function bindingNote(project: OrcaProject): string {
  if (project.kind !== 'git') return FOLDER_NOTE
  if (project.project === null) return 'No ConPort project'
  return HANDLE_FORM.test(project.project) ? 'ConPort bound' : `ConPort · ${project.project}`
}

function projectItem(project: OrcaProject, isCurrent: boolean) {
  const key = `project:${project.root}`
  if (project.kind !== 'git') {
    return <ListItem key={key} title={project.name} description={FOLDER_NOTE} icon="folder" disabled onPress={() => undefined} />
  }
  if (project.project === null) {
    return (
      <ListItem key={key} title={project.name} description={bindingNote(project)} icon="folder" current={isCurrent}>
        <Row>
          <Button size="xs" variant="outline" disabled={read(busy)} onPress={() => chooseProject(project.root)}>
            Bind
          </Button>
        </Row>
      </ListItem>
    )
  }
  return (
    <ListItem
      key={key}
      title={project.name}
      description={project.focused ? `${bindingNote(project)} · in focus` : bindingNote(project)}
      icon="folder"
      current={isCurrent}
      onPress={() => chooseProject(project.root)}
    />
  )
}

/** Orca's projects in the order of its sidebar, narrowed by the search. */
function ProjectPicker({ list }: { list: OrcaProject[] }) {
  const query = read(projectQuery).trim().toLowerCase()
  const shown = query === '' ? list : list.filter((p) => `${p.name} ${p.project ?? ''}`.toLowerCase().includes(query))
  const root = read(chosen)
  return (
    <Stack gap="sm">
      <Input
        type="search"
        label="Find project"
        labelHidden
        placeholder="Find project"
        value={read(projectQuery)}
        onChange={(value) => set(projectQuery, value)}
      />
      <Text size="xs" muted>
        Orca projects, in sidebar order
      </Text>
      {shown.length === 0 ? (
        <Text size="sm" muted>
          No project matches.
        </Text>
      ) : (
        <List label="Projects">{shown.map((project) => projectItem(project, project.root === root))}</List>
      )}
      {current()?.source === 'stored' ? (
        <Row>
          <Button size="xs" variant="ghost" disabled={read(busy)} onPress={forgetProject}>
            Change ConPort project
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

/** The chosen project, opening onto Orca's projects, and the refresh of the whole panel. */
function Header() {
  const list = read(projects)
  const refresh = <IconButton icon="refresh" label="Refresh" variant="outline" disabled={read(busy)} onPress={() => load()} />
  if (list === null) return <Skeleton shape="text" lines={2} label="Loading projects…" />
  if (!list.ok) {
    return (
      <Stack gap="xs">
        <RefusalBox error={list.error} />
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={() => load()}>
            Retry
          </Button>
        </Row>
      </Stack>
    )
  }
  if (list.data.length === 0) {
    return (
      <Stack gap="sm">
        <Row justify="end">{refresh}</Row>
        <EmptyState icon="folder" title="Orca has no projects" description="Add a repository to Orca and press Refresh." />
      </Stack>
    )
  }
  const project = current()
  // With no project chosen the picker stays open: there is nothing else to show.
  const open = read(pickerOpen) || project === null
  return (
    <Row gap="xs" align="start">
      <Box grow>
        <Collapsible
          key="project-picker"
          title={project?.name ?? 'Choose a project'}
          description={project ? bindingNote(project) : 'No project chosen'}
          open={open}
          onChange={(value) => set(pickerOpen, value)}
        >
          {open ? <ProjectPicker list={list.data} /> : null}
        </Collapsible>
      </Box>
      {refresh}
    </Row>
  )
}

/** What the settings files of the project say, each line with the one thing to do. */
function SettingsLines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null
  return (
    <Callout tone="warning" icon="warning" title="ConPort settings">
      <Stack gap="xs">
        {lines.map((line, i) => (
          <Text key={`settings-line-${i}`} size="sm">
            {line}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

function BindCard({ filesRead }: { filesRead: boolean }) {
  return (
    <Card title="ConPort project" description={filesRead ? BIND_PROJECT : BIND_PROJECT_NO_FILES}>
      <Row gap="xs" align="end">
        <Input
          label="ConPort project"
          placeholder="name or handle"
          value={read(projectDraft)}
          onChange={(v) => set(projectDraft, v)}
          onSubmit={(v) => void rememberProject(v)}
        />
        <Button variant="solid" tone="accent" disabled={read(busy)} onPress={() => rememberProject(read(projectDraft))}>
          Remember
        </Button>
      </Row>
    </Card>
  )
}

interface Group<T> {
  key: string
  title: string
  milestone: Milestone | null
  rows: T[]
}

/** Rows by milestone, the milestones in the order of the roadmap, the rows outside one last. */
function byMilestone<T extends { milestone: Milestone | null }>(list: T[]): Array<Group<T>> {
  const groups = new Map<number, Group<T>>()
  const outside: T[] = []
  for (const row of list) {
    const m = row.milestone
    if (m === null) {
      outside.push(row)
      continue
    }
    const group = groups.get(m.id) ?? { key: `m${m.id}`, title: m.title, milestone: m, rows: [] }
    group.rows.push(row)
    groups.set(m.id, group)
  }
  const ordered = [...groups.values()].sort(
    (a, b) => (a.milestone?.sequence ?? 0) - (b.milestone?.sequence ?? 0) || (a.milestone?.id ?? 0) - (b.milestone?.id ?? 0)
  )
  return outside.length > 0 ? [...ordered, { key: 'none', title: NO_MILESTONE, milestone: null, rows: outside }] : ordered
}

function GroupTitle<T>({ group, section }: { group: Group<T>; section: Section['key'] }) {
  const m = group.milestone
  return (
    <Stack gap="none">
      <Text size="sm" weight="semibold">
        {group.title}
      </Text>
      {m?.is_release ? (
        <Text key={`release:${section}:${m.id}`} size="xs" muted>
          {releaseLine(m)}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Why no agent can be handed a task: the refusal of the agents, or none of them found. */
function AgentsNote() {
  const kinds = read(agents)
  if (kinds === null) return null
  if (!kinds.ok) return <RefusalBox error={kinds.error} />
  if (taskAgents(kinds.data.agents).length > 0) return null
  return (
    <Text size="xs" muted>
      {oneLine({ what: NO_TASK_AGENT, action: AGENT_MISSING_ACTION })}
    </Text>
  )
}

/** Whether a task can be handed: an agent that takes one is found. */
function canHand(): boolean {
  const kinds = read(agents)
  return !read(busy) && kinds !== null && kinds.ok && taskAgents(kinds.data.agents).length > 0
}

/** The button of a task by what it can be handed for, the key of its test id and the icon of its row. */
const HAND_ACTIONS: Record<HandMode, { key: string; label: string; icon: 'check' | 'flag' | 'agent' }> = {
  do: { key: 'hand', label: ACTION.hand, icon: 'flag' },
  review: { key: 'review', label: ACTION.review, icon: 'check' },
  fix: { key: 'fix', label: ACTION.fix, icon: 'agent' }
}

/** The sheet of a task by what it is handed for: its title and who takes it. */
const HAND_SHEETS: Record<HandMode, { title: string; who: string }> = {
  do: { title: 'Hand to agent', who: 'Who takes the task' },
  review: { title: 'Review', who: 'Who reviews' },
  fix: { title: 'Fix', who: 'Who fixes' }
}

/** The time a taken row last changed: by the light read when it names the row, else by the list. */
function updatedAt(id: number, row: { updated_at?: string }): string {
  return read(takenList)?.taken.find((t) => t.id === id)?.updated_at ?? row.updated_at ?? ''
}

/** What the button `label` of a row does, and the key of its test id. */
function actionOf(row: SddRow, label: string): { key: string; press: () => unknown; disabled: boolean } | null {
  const key = rowKey(row)
  const ask = (then: Sheet) => () => setTakeOver({ key, then })
  switch (label) {
    case ACTION.showTerminal:
      return { key: `show:${key}`, press: () => showRowTerminal(row), disabled: read(busy) }
    case ACTION.takeOver: {
      if (row.kind === 'idea') return { key: `take-over:${key}`, press: ask({ kind: 'idea', idea: row.idea }), disabled: !canHand() }
      if (row.kind === 'spec') return { key: `take-over:${key}`, press: ask({ kind: 'spec', spec: row.spec }), disabled: !canHand() }
      // An epic In work is taken over from its screen, where its harness is chosen.
      return null
    }
    case ACTION.brainstorm:
      if (row.kind === 'idea') return { key: `brainstorm:${key}`, press: () => openSheet({ kind: 'idea', idea: row.idea }), disabled: !canHand() }
      if (row.kind === 'proposal') {
        return { key: `brainstorm:${key}`, press: () => openSheet({ kind: 'proposal', proposal: row.proposal }), disabled: !canHand() }
      }
      return null
    case ACTION.decline:
      return row.kind === 'proposal'
        ? { key: `decline:${key}`, press: () => openSheet({ kind: 'decline', proposal: row.proposal }), disabled: read(busy) }
        : null
    case ACTION.plan:
      return row.kind === 'spec' ? { key: `plan:${key}`, press: () => openSheet({ kind: 'spec', spec: row.spec }), disabled: !canHand() } : null
    case ACTION.openSpec: {
      const address = read(page)
      return row.kind === 'spec' ? { key: `open-spec:${key}`, press: () => openSpec(row.spec.doc), disabled: !address?.ok } : null
    }
    default: {
      const task = row.kind === 'idea' ? row.idea : row.kind === 'task' ? row.task : null
      const mode = task === null ? null : handMode(task)
      if (task === null || mode === null) return null
      return { key: `${HAND_ACTIONS[mode].key}:${task.id}`, press: () => openSheet({ kind: mode, task }), disabled: !canHand() }
    }
  }
}

/** The buttons of a row, by the table of the panel. */
function Actions({ row, isTaken }: { row: SddRow; isTaken: boolean }) {
  const labels = rowActions(row, isTaken, read(terminals)[rowKey(row)] === true)
  const buttons = labels.flatMap((label) => {
    const action = actionOf(row, label)
    return action === null ? [] : [{ label, ...action }]
  })
  if (buttons.length === 0) return null
  return (
    <Row gap="xs" wrap>
      {buttons.map((button, index) => (
        <Button
          key={button.key}
          size="xs"
          variant={index === 0 ? 'outline' : 'ghost'}
          icon={button.label === ACTION.showTerminal ? 'terminal' : button.label === ACTION.openSpec ? 'open-external' : 'agent'}
          disabled={button.disabled}
          onPress={button.press}
        >
          {button.label}
        </Button>
      ))}
    </Row>
  )
}

/**
 * An epic In work: its screen opens on a press — Start, Show terminal and Take over are there,
 * where its harness is chosen (a row that opens on a press holds no button). A taken one says
 * when it last changed, unless it is ready to merge.
 */
function inWorkRow(epic: InWorkRow, isTaken: boolean) {
  const key = `epic:${epic.id}`
  const title = `${epic.id} · ${epic.title}`
  // Several specs or plans: the epic cannot start, and the reason of the CLI is not shown as it is.
  if (epic.reason !== null) {
    return <ListItem key={key} title={title} description="Cannot start: more than one spec or plan" icon="layers" disabled onPress={() => undefined} />
  }
  const state = epicState(epic)
  // Ready to merge before anything: its lead session keeps it in progress until the merge.
  const line = !epic.ready && isTaken ? updatedLine(updatedAt(epic.id, epic), new Date()) : state.line
  return (
    <ListItem key={key} title={title} description={line} icon="layers" onPress={() => openEpic(epic.id)}>
      {state.share === null ? null : <Progress label={`${state.closed} of ${state.total} closed`} labelHidden value={state.share} />}
    </ListItem>
  )
}

function specRow(spec: SpecRow, isTaken: boolean) {
  const row: SddRow = { kind: 'spec', spec }
  const title = spec.epic === null ? `doc-${spec.doc} · ${spec.title}` : `${spec.epic} · ${spec.title}`
  const plain = spec.epic === null ? (spec.idea === null ? 'Spec' : `Spec of idea ${spec.idea}`) : `Epic with a spec, no plan`
  const description = isTaken && spec.epic !== null ? updatedLine(updatedAt(spec.epic, spec), new Date()) : plain
  return (
    <ListItem key={`spec:${rowKey(row)}`} title={title} description={description} icon="file-text">
      <Actions row={row} isTaken={isTaken} />
    </ListItem>
  )
}

/** An idea or a task of an epic outside SDD: its stage, or when a session last changed it. */
function ideaDescription(task: IdeaRow, isTaken: boolean): string {
  const state = isTaken ? updatedLine(updatedAt(task.id, task), new Date()) : taskState(task)
  return task.kind === 'bug' ? `${BUG_LABEL} · ${state}` : state
}

function ideaItem(row: IdeaRow | ProposalRow, takenNow: Set<number>) {
  if (isProposal(row)) {
    return (
      <ListItem
        key={`proposal:${row.doc}`}
        title={`doc-${row.doc} · ${row.title}`}
        description={row.author ? `Proposal · ${row.author}` : 'Proposal'}
        icon="lightbulb"
      >
        <Actions row={{ kind: 'proposal', proposal: row }} isTaken={false} />
      </ListItem>
    )
  }
  const isTaken = takenNow.has(row.id)
  return (
    <ListItem key={`idea:${row.id}`} title={`${row.id} · ${row.title}`} description={ideaDescription(row, isTaken)} icon="lightbulb">
      <Actions row={{ kind: 'idea', idea: row }} isTaken={isTaken} />
    </ListItem>
  )
}

function outsideRows(epic: OutsideRow, takenNow: Set<number>) {
  const state = epicState({ ...epic, ready: false })
  const isTaken = takenNow.has(epic.id)
  return [
    <ListItem
      key={`outside:${epic.id}`}
      title={`${epic.id} · ${epic.title}`}
      description={isTaken ? updatedLine(updatedAt(epic.id, epic), new Date()) : state.line}
      icon="layers"
    />,
    ...epic.tasks.map((task) => (
      <ListItem key={`task:${task.id}`} title={`${task.id} · ${task.title}`} description={ideaDescription(task, false)} icon="flag">
        <Actions row={{ kind: 'task', task }} isTaken={false} />
      </ListItem>
    ))
  ]
}

/** The rows of a section, or what an empty one says. */
function SectionRows({ section, list, takenNow }: { section: Section; list: SddList; takenNow: Set<number> }) {
  const empty = (
    <Text size="sm" muted>
      {EMPTY_SECTION[section.key]}
    </Text>
  )
  switch (section.key) {
    case 'in_work':
      if (list.in_work.length === 0) return empty
      return (
        <Stack gap="md">
          {byMilestone(list.in_work).map((group) => (
            <Stack key={`group:in_work:${group.key}`} gap="xs">
              <GroupTitle group={group} section="in_work" />
              <List label={`In work: ${group.title}`}>{group.rows.map((epic) => inWorkRow(epic, takenNow.has(epic.id)))}</List>
            </Stack>
          ))}
        </Stack>
      )
    case 'specs':
      if (list.specs.length === 0) return empty
      return <List label="Specs">{list.specs.map((spec) => specRow(spec, spec.epic !== null && takenNow.has(spec.epic)))}</List>
    case 'ideas': {
      const rows = ideaRows(list)
      const skipped = list.skipped_proposals.length
      return (
        <Stack gap="xs">
          {rows.length === 0 ? empty : <List label="Ideas">{rows.map((row) => ideaItem(row, takenNow))}</List>}
          {skipped === 0 ? null : (
            <Text key="skipped-proposals" size="xs" muted>
              {skippedLine(skipped)}
            </Text>
          )}
        </Stack>
      )
    }
    case 'outside':
      if (list.outside.length === 0) return empty
      return (
        <Stack gap="md">
          {byMilestone(list.outside).map((group) => (
            <Stack key={`group:outside:${group.key}`} gap="xs">
              <GroupTitle group={group} section="outside" />
              <List label={`Outside SDD: ${group.title}`}>{group.rows.flatMap((epic) => outsideRows(epic, takenNow))}</List>
            </Stack>
          ))}
        </Stack>
      )
  }
}

/** How many rows a section holds: the ideas count the proposals too. */
function countOf(section: Section, list: SddList): number {
  switch (section.key) {
    case 'in_work':
      return list.in_work.length
    case 'specs':
      return list.specs.length
    case 'ideas':
      return list.ideas.length + list.proposals.length
    case 'outside':
      return list.outside.length
  }
}

/** Whether a section is shown unfolded: as the person left it, else as it opens at first. */
const isOpen = (section: Section): boolean => !(read(collapsed)[section.key] ?? !section.open)

/** Take over of a row, asked once more before the same start opens. */
function TakeOverBox({ then }: { then: Sheet }) {
  // The key of a component's own root does not reach the tree: the callout is wrapped.
  return (
    <Stack gap="none">
      <Callout key="take-over" tone="warning" title={TAKE_OVER_CONFIRM}>
        <Stack gap="xs">
          <Text size="xs">{TAKE_OVER_NOTE}</Text>
          <Row gap="xs">
            <Button variant="solid" tone="accent" disabled={!canHand()} onPress={() => openSheet(then)}>
              Yes, take over
            </Button>
            <Button variant="ghost" onPress={() => setTakeOver(null)}>
              Cancel
            </Button>
          </Row>
        </Stack>
      </Callout>
    </Stack>
  )
}

/** The four sections of the project, each folding, what is closer to a release first. */
function Sections({ list }: { list: SddList }) {
  const takenNow = takenRows(list, read(takenList))
  const confirm = takeOverOf()
  return (
    <Stack gap="md">
      <AgentsNote />
      {confirm === null ? null : <TakeOverBox then={confirm.then} />}
      {/* The sections alone in their stack: a key in a list beside other children does not reach the tree. */}
      <Stack gap="md">
        {SECTIONS.map((section) => {
          const open = isOpen(section)
          return (
            <Collapsible
              key={`section:${section.key}`}
              title={`${section.title} · ${countOf(section, list)}`}
              description={section.caption}
              open={open}
              onChange={(value) => set(collapsed, { ...read(collapsed), [section.key]: !value })}
            >
              {open ? <SectionRows section={section} list={list} takenNow={takenNow} /> : null}
            </Collapsible>
          )
        })}
      </Stack>
    </Stack>
  )
}

/** The title, the line under it and who acts of the sheet. */
function sheetText(open: Sheet): { title: string; description: string; who: string } {
  switch (open.kind) {
    case 'idea':
      return { title: `Brainstorm “${open.idea.title}”`, description: `${open.idea.id} · idea`, who: 'Who brainstorms' }
    case 'proposal':
      return { title: `Brainstorm “${open.proposal.title}”`, description: `doc-${open.proposal.doc} · proposal`, who: 'Who brainstorms' }
    case 'spec':
      return {
        title: `Plan & build “${open.spec.title}”`,
        description: open.spec.epic === null ? `doc-${open.spec.doc} · spec, no plan` : `${open.spec.epic} · spec, no plan`,
        who: 'Who plans and builds'
      }
    case 'decline':
      return { title: `Decline “${open.proposal.title}”`, description: `doc-${open.proposal.doc} · proposal`, who: '' }
    default:
      return {
        title: `${HAND_SHEETS[open.kind].title} “${open.task.title}”`,
        description: `${open.task.id} · ${taskState(open.task).toLowerCase()}`,
        who: HAND_SHEETS[open.kind].who
      }
  }
}

/** The sheet that declines a proposal: the reason, which the answer of the team carries. */
function DeclineCard({ text }: { text: { title: string; description: string } }) {
  const empty = read(reason).trim() === ''
  return (
    <Stack gap="none">
      <Card key="sheet" title={text.title} description={text.description}>
        <Stack gap="md">
          <Textarea label="Reason" placeholder="Why the proposal is declined" value={read(reason)} onChange={(value) => set(reason, value)} rows={3} />
          <Row gap="xs" justify="end">
            <Button variant="ghost" onPress={() => setSheet(null)}>
              Cancel
            </Button>
            <Button variant="solid" tone="danger" disabled={read(busy) || empty} onPress={submitSheet}>
              Decline
            </Button>
          </Row>
        </Stack>
      </Card>
    </Stack>
  )
}

/** The sheet over the sections: what the agent will do, which agent, and the terminal it opens in. */
function SheetCard({ open }: { open: Sheet }) {
  const text = sheetText(open)
  if (open.kind === 'decline') return <DeclineCard text={text} />
  const kinds = read(agents)
  const able = kinds?.ok ? taskAgents(kinds.data.agents) : []
  const last = kinds?.ok ? (kinds.data.launcher ?? null) : null
  const steps = SHEET_STEPS[open.kind]
  // The key of a component's own root does not reach the tree: the card is wrapped.
  return (
    <Stack gap="none">
      <Card key="sheet" title={text.title} description={text.description}>
        <Stack gap="md">
          <Stack gap="xs">
            {steps.map((step, index) => (
              <Row key={`step:${index + 1}`} gap="xs" align="center">
                <Badge>{String(index + 1)}</Badge>
                <Text size="sm">{step}</Text>
              </Row>
            ))}
          </Stack>
          {able.length === 0 ? (
            <Text size="xs" muted>
              {oneLine({ what: NO_TASK_AGENT, action: AGENT_MISSING_ACTION })}
            </Text>
          ) : (
            <RadioGroup
              label={text.who}
              options={able.map((a) =>
                a.id === last ? { value: a.id, label: a.label, description: 'last time' } : { value: a.id, label: a.label }
              )}
              value={read(sheetAgent) ?? ''}
              onChange={pickSheetAgent}
            />
          )}
          <Row gap="xs" justify="end">
            <Button variant="ghost" onPress={() => setSheet(null)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="accent"
              icon="terminal"
              disabled={read(busy) || read(sheetAgent) === null}
              onPress={submitSheet}
            >
              Open in terminal
            </Button>
          </Row>
        </Stack>
      </Card>
    </Stack>
  )
}

/** Whether the harness is one that takes a task and is found on this machine. */
const harnessFound = (list: AgentKind[], harness: string): boolean => taskAgents(list).some((a) => a.id === harness)

/**
 * The harnesses that take a task as their first argument, one not found on this machine marked
 * so; a chosen harness the CLI no longer lists is shown the same way, by its id.
 */
function harnessOptions(list: AgentKind[], current: string): Array<{ value: string; label: string; disabled?: boolean }> {
  const able = list.filter((a) => TASK_AGENTS.includes(a.id))
  const options = able.map((a) =>
    a.found ? { value: a.id, label: a.label } : { value: a.id, label: `${a.label} — not found`, disabled: true }
  )
  return able.some((a) => a.id === current) ? options : [...options, { value: current, label: `${current} — not found`, disabled: true }]
}

/** The harness of the epic: the agent that is opened in its terminal. */
function HarnessPart({ choice }: { choice: Choice }) {
  const kinds = read(agents)
  if (kinds === null) return <Skeleton shape="block" label="Loading harnesses…" />
  if (!kinds.ok) return <RefusalBox error={kinds.error} />
  return (
    <Stack gap="xs">
      <Select
        label="Harness"
        options={harnessOptions(kinds.data.agents, choice.harness)}
        value={choice.harness}
        onChange={chooseHarness}
      />
      {harnessFound(kinds.data.agents, choice.harness) ? null : (
        <Text key="harness-missing" size="xs" muted>
          {oneLine({ what: 'Harness not found', action: HARNESS_MISSING_ACTION })}
        </Text>
      )}
    </Stack>
  )
}

/** The subagent type of each role, or the default types with why none can be chosen. */
function RolesPart({ choice }: { choice: Choice }) {
  const lists = roleLists(choice)
  if (lists === null) return <Skeleton shape="block" label="Loading subagent types…" />
  return (
    <Stack gap="sm">
      <Text size="sm" weight="semibold">
        Roles
      </Text>
      <Grid columns={2} gap="md">
        {ROLE_KEYS.map((key) => {
          const value = lists.roles[key]
          // A type the list lacks keeps its place: the session stops and asks when it meets it.
          const missing = lists.on && !lists.types.includes(value)
          const types = lists.on ? (missing ? [value, ...lists.types] : lists.types) : [value]
          return (
            <Stack key={`role:${key}`} gap="xs">
              <Select
                label={ROLE_TITLES[key]}
                options={types.map((type) => ({ value: type, label: type }))}
                value={value}
                disabled={!lists.on}
                onChange={(type) => choose({ roles: { ...lists.roles, [key]: type } })}
              />
              {missing ? (
                <Text key={`type-missing:${key}`} size="xs" muted>
                  {TYPE_MISSING_NOTE}
                </Text>
              ) : null}
            </Stack>
          )
        })}
      </Grid>
      {lists.on || lists.note === null ? null : (
        <Text key="roles-note" size="xs" muted>
          {lists.note}
        </Text>
      )}
      {lists.on || !lists.action ? null : (
        <Text key="roles-action" size="xs" muted>
          {lists.action}
        </Text>
      )}
      <Text key="fixer-note" size="xs" muted>
        {FIXER_NOTE}
      </Text>
    </Stack>
  )
}

/**
 * The start of the open epic by what Orca sees of its session: start, or its terminal and a second
 * start, or — taken by another session — a start asked once more.
 */
function StartPart({ row, state, choice, taken }: { row: InWorkRow; state: EpicSession; choice: Choice; taken: boolean }) {
  const epic = row.id
  const blocked = read(busy) || !canStart(choice.harness) || roleLists(choice) === null
  // The agent that planned the epic from its spec or idea builds it in its own terminal: alive too.
  const inherited = !state.alive && hasEpicTerminal(epic)
  // As every row decides: its terminal on this host first, then taken by another session, then Start.
  const [main] = rowActions({ kind: 'epic', epic: row }, taken, state.alive || inherited)
  if (main === ACTION.showTerminal) {
    return (
      <Stack gap="sm">
        <Callout key="session-alive" tone="accent" icon="terminal">
          {inherited ? inheritedNotice(epic) : state.worktree === null ? rootSessionNotice(epic) : startNotice(epic)}
        </Callout>
        <Row gap="xs" wrap>
          <Button variant="solid" tone="accent" icon="terminal" disabled={read(busy)} onPress={showTerminal}>
            Show terminal
          </Button>
          <Button variant="outline" icon="play" disabled={blocked} onPress={() => set(confirmAgain, true)}>
            Start again
          </Button>
        </Row>
        {read(confirmAgain) ? (
          <Callout key="confirm-again" tone="warning" title={`Start epic ${epic} again?`}>
            <Stack gap="xs">
              <Text size="xs">{RESTART_NOTE}</Text>
              <Row gap="xs">
                <Button variant="solid" tone="accent" disabled={blocked} onPress={start}>
                  Yes, start
                </Button>
                <Button variant="ghost" onPress={() => set(confirmAgain, false)}>
                  Cancel
                </Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
      </Stack>
    )
  }
  // Started, and the agent is not yet seen in its terminal: the button waits, and says for what.
  const waits = read(started) === epicKey(read(chosen) ?? '', epic)
  if (main === ACTION.takeOver && !waits) {
    return (
      <Stack gap="sm">
        <Button variant="solid" tone="accent" icon="play" disabled={blocked} onPress={() => set(confirmAgain, true)}>
          Take over
        </Button>
        {read(confirmAgain) ? (
          <Callout key="confirm-take-over" tone="warning" title={TAKE_OVER_CONFIRM}>
            <Stack gap="xs">
              <Text size="xs">{TAKE_OVER_NOTE}</Text>
              <Row gap="xs">
                <Button variant="solid" tone="accent" disabled={blocked} onPress={start}>
                  Yes, take over
                </Button>
                <Button variant="ghost" onPress={() => set(confirmAgain, false)}>
                  Cancel
                </Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
      </Stack>
    )
  }
  const earlier = state.worktree === null ? null : COPY_NOTE
  // The working copy this very start made is no earlier work to take up.
  const note = waits ? STARTED_NOTE : earlier
  return (
    <Stack gap="sm">
      <Button variant="solid" tone="accent" icon="play" disabled={blocked || waits} onPress={start}>
        Start
      </Button>
      {note === null ? null : (
        <Text key="start-note" size="xs" muted>
          {note}
        </Text>
      )}
    </Stack>
  )
}

/** What is chosen for the open epic and its start, by its session as read when it was opened. */
function SessionPart({ epic, taken }: { epic: InWorkRow; taken: boolean }) {
  const state = read(session)
  if (state === null) return <Skeleton shape="block" label="Loading the epic's session…" />
  if (!state.ok) return <RefusalBox error={state.error} />
  const choice = choiceOf()
  if (choice === null) return null
  return (
    <Stack gap="lg">
      <HarnessPart choice={choice} />
      <RolesPart choice={choice} />
      <StartPart row={epic} state={state.data} choice={choice} taken={taken} />
    </Stack>
  )
}

function epicTaskRow(task: EpicTask) {
  const key = `epic-task:${task.id}`
  const title = `${task.id} · ${task.title}`
  const icon = task.status === 'DONE' ? 'check' : 'flag'
  // A cancelled task is no part of the epic's work: muted.
  if (task.status === 'CANCELLED') {
    return <ListItem key={key} title={title} description={TASK_STATUS[task.status]} icon={icon} disabled onPress={() => undefined} />
  }
  return <ListItem key={key} title={title} description={TASK_STATUS[task.status]} icon={icon} />
}

/** How the epic goes, by its tasks in ConPort: the counts by status and every task, the cancelled ones last. */
function EpicTasksPart() {
  const list = read(epicTasks)
  if (list === null) return <Skeleton shape="text" lines={3} label="Loading the epic's tasks…" />
  if (!list.ok) return <RefusalBox error={list.error} />
  const counts = taskCounts(list.data)
  const cancelled = (task: EpicTask): boolean => task.status === 'CANCELLED'
  const ordered = [...list.data.filter((task) => !cancelled(task)), ...list.data.filter(cancelled)]
  return (
    <Stack gap="sm">
      <Heading level={3}>{`Tasks · ${counts.total}`}</Heading>
      <Text key="task-counts" size="xs" muted>
        {taskCountsLine(counts)}
      </Text>
      {ordered.length === 0 ? null : <List label="Epic tasks">{ordered.map(epicTaskRow)}</List>}
    </Stack>
  )
}

function EpicScreen({ epic, project }: { epic: InWorkRow; project: OrcaProject }) {
  const state = epicState(epic)
  const isTaken = taken().has(epic.id)
  const kicker = epic.milestone ? `${epic.id} · ${epic.milestone.title}` : String(epic.id)
  return (
    <Stack gap="lg">
      <Row justify="between" align="center">
        <Button variant="ghost" size="sm" onPress={closeEpic}>
          ← Sections
        </Button>
        <Text size="xs" muted truncate>
          {project.name}
        </Text>
      </Row>
      <Stack gap="sm">
        <Text key="epic-kicker" size="xs" muted>
          <Code>{kicker}</Code>
        </Text>
        <Heading level={2}>{epic.title}</Heading>
        <Row gap="xs" align="center" wrap>
          {/* An epic In work has both: the CLI checks them before it lists it there. */}
          <Badge>Spec ✓</Badge>
          <Badge>Plan ✓</Badge>
          <Text key="epic-state" size="xs" muted>
            {!epic.ready && isTaken ? `${updatedLine(updatedAt(epic.id, epic), new Date())} · ${state.closed} of ${state.total} closed` : state.line}
          </Text>
        </Row>
      </Stack>
      <SessionPart epic={epic} taken={isTaken} />
      <EpicTasksPart />
    </Stack>
  )
}

function Body() {
  const project = current()
  if (project === null) return null
  return (
    <Stack gap="md">
      <SettingsLines key="settings-lines" lines={project.lines} />
      <ProjectBody project={project} />
    </Stack>
  )
}

function ProjectBody({ project }: { project: OrcaProject }) {
  // A broken settings file names no project, and a binding would not stand in for it.
  if (project.project === null && project.source === 'file') return <Card title="ConPort project" description={SETTINGS_BROKEN} />
  if (project.project === null) return <BindCard filesRead={project.filesRead} />
  const list = read(sdd)
  if (list === null) return <Skeleton shape="text" lines={4} label="Loading the stages of the project…" />
  if (!list.ok) return null
  const open = openSheetOf()
  if (open !== null) return <SheetCard open={open} />
  const epic = openedEpic()
  if (epic !== null) return <EpicScreen epic={epic} project={project} />
  return <Sections list={list.data} />
}

export default function Panel() {
  followVisibility()
  const list = read(sdd)
  const failed = read(refusal) ?? read(listError) ?? (list && !list.ok ? list.error : null)
  const message = read(notice)
  return (
    <Stack gap="md">
      <Header />
      {failed ? <RefusalBox error={failed} /> : null}
      {message ? (
        <Callout key="notice" tone="accent" icon="terminal">
          {message}
        </Callout>
      ) : null}
      <Body />
    </Stack>
  )
}
