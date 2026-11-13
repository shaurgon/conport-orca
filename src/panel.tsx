// The sidebar panel: control of a ConPort project from Orca. The chosen project's epics in three
// tabs — those to start, those to prepare, the tasks outside the epics — and the screen of an
// epic, where the way it is done, its harness and the subagent type of each role are chosen and
// its agent is started. The state of the agent is Orca's: the panel reads the session and the
// tasks of an epic only when the epic is opened and on refresh. Every CLI call goes through the
// plugin's worker (src/worker.ts).
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
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import { DEFAULT_ROLES, HANDLE_FORM, handMode, missingDocument, PREPARE_AGENTS } from './cli'
import type {
  AgentKind,
  EpicList,
  EpicSession,
  EpicSummary,
  EpicTask,
  HandMode,
  Milestone,
  OrcaProject,
  OutsideTask,
  Refusal,
  RepoContext,
  Result,
  Roles,
  SubagentList,
  Way
} from './protocol'
import {
  AGENT_MISSING_ACTION,
  BIND_PROJECT,
  BIND_PROJECT_NO_FILES,
  BRANCHES_NOTE,
  BUG_LABEL,
  COPY_NOTE,
  epicState,
  FIXER_NOTE,
  FOLDER_NOTE,
  handNotice,
  HARNESS_MISSING_ACTION,
  NO_MILESTONE,
  NO_TASK_AGENT,
  oneLine,
  PREPARE_HINT,
  PREPARE_STATE,
  prepareNotice,
  refusalText,
  releaseLine,
  RESTART_NOTE,
  ROLE_TITLES,
  ROLES_FIXED_NOTE,
  ROLES_NO_HARNESS_NOTE,
  ROLES_UNTYPED_NOTE,
  rolesUnavailableNote,
  SETTINGS_BROKEN,
  SHEET_STEPS,
  STARTED_NOTE,
  startNotice,
  TASK_STATUS,
  taskCounts,
  taskCountsLine,
  taskState,
  TYPE_MISSING_NOTE,
  WAY_LABELS,
  WAY_NEEDS_CLAUDE,
  WORKFLOW_NOTE
} from './text'

/** `npx` may fetch the CLI on its first call. */
const SLOW = { timeoutMs: 120_000 }

type TabName = 'launch' | 'prepare' | 'tasks'
const TAB_NAMES: readonly string[] = ['launch', 'prepare', 'tasks']

type AgentsAnswer = { agents: AgentKind[]; preparer?: string | null }

/** What is chosen for an epic on its screen: the way, the harness and the subagent type of each role. */
interface Choice {
  way: Way
  harness: string
  roles: Roles
}

/** What the sheet opened over a tab is for: an epic to prepare, or a task to hand to an agent.
 *  One member per kind of an epic: a test of `kind` then narrows to the task's member. */
type Sheet = { kind: 'spec'; epic: EpicSummary } | { kind: 'plan'; epic: EpicSummary } | { kind: HandMode; task: OutsideTask }

const projects = atom<Result<OrcaProject[]> | null>(null)
/** The root of the chosen project; the one chosen last is taken when no project is in focus. */
const chosen = atom<string | null>('project', null, { persist: 'plugin' })
/** The person chose the project in the list: a reload keeps it while Orca lists it. */
const pickedByHand = atom(false)
const pickerOpen = atom(false)
const projectQuery = atom('')
const projectDraft = atom('projectDraft', '')

const epics = atom<Result<EpicList> | null>(null)
const tasks = atom<Result<OutsideTask[]> | null>(null)
const agents = atom<Result<AgentsAnswer> | null>(null)
/** The epic open in each project, by its root. */
const openEpics = atom<Record<string, number>>('epics', {}, { persist: 'plugin' })
const tab = atom<string>('tab', 'launch', { persist: 'plugin' })
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

const sheet = atom<Sheet | null>(null)
const sheetAgent = atom<string | null>(null)
/** The agent the person picked in the sheet in a project, kept while the project is read again. */
let pickedAgent: { root: string; agent: string } | null = null

/** What the last action was refused with. */
const refusal = atom<Refusal | null>(null)
const notice = atom<string | null>(null)
const busy = atom(false)
/** A second start of an epic whose session is alive is asked once more. */
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

/** Whether Orca shows the panel, from the setup of its run; and whether it did at the last draw. */
let visibility: PanelContext['visible'] | null = null
let wasVisible = true

const ROLE_KEYS = ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'] as const

/** The chosen project, while Orca lists it. */
function current(): OrcaProject | null {
  const list = read(projects)
  const root = read(chosen)
  return list?.ok ? (list.data.find((p) => p.root === root) ?? null) : null
}

/** The project handle the CLI answered with for the chosen project. */
function handle(): string | null {
  const list = read(epics)
  return list?.ok ? list.data.project : null
}

function currentTab(): TabName {
  const value = read(tab)
  return TAB_NAMES.includes(value) ? (value as TabName) : 'launch'
}

/** The epic open in the chosen project, while it is listed and can be started. */
function openedEpic(): EpicSummary | null {
  const root = read(chosen)
  const list = read(epics)
  if (root === null || !list?.ok) return null
  const id = read(openEpics)[root]
  return list.data.epics.find((e) => e.id === id && e.runnable) ?? null
}

function setOpened(epic: number | null): void {
  const root = read(chosen)
  if (root === null) return
  const { [root]: _dropped, ...others } = read(openEpics)
  set(openEpics, epic === null ? others : { ...others, [root]: epic })
}

/** Runs an action of the panel; its answer is drawn only while `still()` holds when it comes. */
async function act<T>(call: () => Promise<Result<T>>, then: (data: T) => void, still: () => boolean = () => true): Promise<void> {
  set(busy, true)
  set(refusal, null)
  try {
    const answer = await call()
    if (!still()) return
    if (answer.ok) then(answer.data)
    else set(refusal, answer.error)
  } catch {
    // The worker's exception is in its own log; the panel says only that it did not answer.
    if (still()) set(refusal, { code: 'worker', message: "The plugin's worker did not answer", action: 'Close the panel and open it again.' })
  } finally {
    set(busy, false)
  }
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
  return state?.ok ? { way: state.data.way, harness: state.data.harness, roles: state.data.roles } : null
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
const taskAgents = (list: AgentKind[]): AgentKind[] => list.filter((a) => a.found && PREPARE_AGENTS.includes(a.id))

/**
 * The sheet as it stands with the project read again: the same one, its epic or task as now
 * listed, while that still wants it; else none.
 */
function sheetAfter(open: Sheet, list: Result<EpicList>, outside: Result<OutsideTask[]>): Sheet | null {
  if (open.kind === 'spec' || open.kind === 'plan') {
    const epic = list.ok ? list.data.epics.find((e) => e.id === open.epic.id) : undefined
    const missing = epic && !epic.runnable ? missingDocument(epic.reason) : null
    return epic && missing ? { kind: missing, epic } : null
  }
  const task = outside.ok ? outside.data.find((t) => t.id === open.task.id) : undefined
  return task && handMode(task) === open.kind ? { kind: open.kind, task } : null
}

/**
 * Reads the chosen project: its epics and tasks, the agents, and the open epic. With
 * `keepSheet` (the panel back in view) an open sheet stays while its epic or task still wants it.
 */
async function loadProject({ keepSheet = false }: { keepSheet?: boolean } = {}): Promise<void> {
  const mine = ++projectLoad
  // An epic read for the project left is no longer wanted either.
  epicLoad++
  set(epics, null)
  set(tasks, null)
  set(agents, null)
  set(session, null)
  set(epicTasks, null)
  if (!keepSheet) set(sheet, null)
  const project = current()
  if (project === null || project.kind !== 'git' || project.project === null) return
  const target = { project: project.project, root: project.root }
  const [list, outside] = await Promise.all([
    plugin.request('epics.list', target, SLOW),
    plugin.request('tasks.list', target, SLOW)
  ])
  if (mine !== projectLoad) return
  set(epics, list)
  set(tasks, outside)
  const open = read(sheet)
  if (open !== null) set(sheet, sheetAfter(open, list, outside))
  if (!list.ok) return
  if (read(openEpics)[project.root] !== undefined && openedEpic() === null) setOpened(null)
  const answer = await plugin.request('agents.get', { project: list.data.project, root: project.root }, SLOW)
  if (mine !== projectLoad) return
  set(agents, answer)
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

async function load(): Promise<void> {
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
  await loadProject()
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
  if (choice.way === 'workflow') return { on: false, note: ROLES_FIXED_NOTE, roles: choice.roles }
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
  let opened = false
  await act(
    () => plugin.request('epic.start', { ...target, way: choice.way, harness: choice.harness, roles: lists.roles }, SLOW),
    () => {
      opened = true
      set(started, key)
      set(notice, startNotice(target.epic, choice.way))
      // The start remembered the choice: the panel keeps none of its own from now on.
      const { [key]: _sent, ...others } = read(choices)
      set(choices, others)
    },
    () => sameRef(target, ref())
  )
  if (opened) await loadEpic({ afterStart: true })
}

/** Asks the worker to bring the terminal of the epic's live session to the front. */
async function showTerminal(): Promise<void> {
  const target = ref()
  if (target === null) return
  await act(
    () => plugin.request('terminal.show', target, SLOW),
    () => undefined,
    () => sameRef(target, ref())
  )
}

/** Opens the sheet with the agent picked by hand in this project, else the one of last time, else the first. */
function openSheet(next: Sheet): void {
  const kinds = read(agents)
  if (!kinds?.ok) return
  const able = taskAgents(kinds.data.agents).map((a) => a.id)
  const root = read(chosen)
  const picked = pickedAgent !== null && pickedAgent.root === root ? pickedAgent.agent : null
  const agent = [picked, kinds.data.preparer ?? null].find((a) => a !== null && able.includes(a)) ?? able[0] ?? null
  set(sheetAgent, agent)
  set(notice, null)
  set(refusal, null)
  set(sheet, next)
}

function pickSheetAgent(agent: string): void {
  set(sheetAgent, agent)
  const root = read(chosen)
  pickedAgent = root === null ? null : { root, agent }
}

/** The agent that took the last task is the one of last time from now on. */
function rememberAgent(agent: string): void {
  const kinds = read(agents)
  if (kinds?.ok) set(agents, { ok: true, data: { ...kinds.data, preparer: agent } })
}

/** Opens the agent of the sheet in a terminal of the project root, with the task of the sheet. */
async function submitSheet(): Promise<void> {
  const open = read(sheet)
  const agent = read(sheetAgent)
  const project = handle()
  const root = read(chosen)
  const name = current()?.name ?? ''
  if (open === null || agent === null || project === null || root === null) return
  // An answer for a project left meanwhile is not told in the chosen one.
  const still = (): boolean => read(chosen) === root
  const done = (text: string): void => {
    set(sheet, null)
    set(notice, text)
    rememberAgent(agent)
  }
  if (open.kind === 'spec' || open.kind === 'plan') {
    const epic = open.epic.id
    await act(() => plugin.request('epic.prepare', { project, root, epic, agent }, SLOW), () => done(prepareNotice(epic, name)), still)
    return
  }
  const { kind: mode, task } = open
  await act(
    () => plugin.request('task.hand', { project, root, task: task.id, agent, mode }, SLOW),
    () => done(handNotice(task.id, mode, name)),
    still
  )
}

/**
 * Reads the project again when the panel comes back into view: an epic prepared or a task done
 * meanwhile shows. Called while drawing, which takes no change: the load starts after it.
 */
function followVisibility(): void {
  if (visibility === null) return
  const visible = read(visibility)
  if (visible && !wasVisible) setTimeout(() => void loadProject({ keepSheet: true }), 0)
  wasVisible = visible
}

export function setup(ctx: PanelContext): void {
  visibility = ctx.visible
  wasVisible = read(ctx.visible)
  pickedAgent = null
  void load()
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
  const refresh = <IconButton icon="refresh" label="Refresh" variant="outline" disabled={read(busy)} onPress={load} />
  if (list === null) return <Skeleton shape="text" lines={2} label="Loading projects…" />
  if (!list.ok) {
    return (
      <Stack gap="xs">
        <RefusalBox error={list.error} />
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={load}>
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

interface Group {
  key: string
  title: string
  milestone: Milestone | null
  epics: EpicSummary[]
}

/** Epics by milestone, the milestones in the order of the roadmap, the epics outside one last. */
function byMilestone(list: EpicSummary[]): Group[] {
  const groups = new Map<number, Group>()
  const outside: EpicSummary[] = []
  for (const epic of list) {
    const m = epic.milestone
    if (m === null) {
      outside.push(epic)
      continue
    }
    const group = groups.get(m.id) ?? { key: `m${m.id}`, title: m.title, milestone: m, epics: [] }
    group.epics.push(epic)
    groups.set(m.id, group)
  }
  const ordered = [...groups.values()].sort(
    (a, b) => (a.milestone?.sequence ?? 0) - (b.milestone?.sequence ?? 0) || (a.milestone?.id ?? 0) - (b.milestone?.id ?? 0)
  )
  return outside.length > 0 ? [...ordered, { key: 'none', title: NO_MILESTONE, milestone: null, epics: outside }] : ordered
}

function GroupTitle({ group }: { group: Group }) {
  const m = group.milestone
  return (
    <Stack gap="none">
      <Text size="sm" weight="semibold">
        {group.title}
      </Text>
      {m?.is_release ? (
        <Text key={`release:${m.id}`} size="xs" muted>
          {releaseLine(m)}
        </Text>
      ) : null}
    </Stack>
  )
}

function launchRow(epic: EpicSummary) {
  const state = epicState(epic)
  return (
    <ListItem
      key={`epic:${epic.id}`}
      title={`${epic.id} · ${epic.title}`}
      description={state.line}
      icon="layers"
      onPress={() => openEpic(epic.id)}
    >
      {state.share === null ? null : <Progress label={`${state.closed} of ${state.total} closed`} labelHidden value={state.share} />}
    </ListItem>
  )
}

function LaunchTab({ list }: { list: EpicList }) {
  if (list.epics.length === 0) {
    return (
      <EmptyState
        icon="layers"
        title="The project has no epics"
        description="An epic can start once it has a spec and a plan in ConPort."
      />
    )
  }
  const runnable = list.epics.filter((e) => e.runnable)
  if (runnable.length === 0) {
    return (
      <Text size="sm" muted>
        No epic is ready to run — prepare one in the Prepare tab.
      </Text>
    )
  }
  return (
    <Stack gap="md">
      {byMilestone(runnable).map((group) => (
        <Stack key={`group:${group.key}`} gap="xs">
          <GroupTitle group={group} />
          <List label={group.title}>{group.epics.map(launchRow)}</List>
        </Stack>
      ))}
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

function prepareRow(epic: EpicSummary) {
  const key = `epic:${epic.id}`
  const title = `${epic.id} · ${epic.title}`
  const missing = missingDocument(epic.reason)
  if (missing === null) {
    return <ListItem key={key} title={title} description={PREPARE_STATE.other} icon="file-text" disabled onPress={() => undefined} />
  }
  return (
    <ListItem key={key} title={title} description={PREPARE_STATE[missing]} icon="file-text">
      <Row>
        <Button
          key={`prepare:${epic.id}`}
          size="xs"
          variant="outline"
          icon="agent"
          disabled={!canHand()}
          onPress={() => openSheet({ kind: missing, epic })}
        >
          {missing === 'spec' ? 'Prepare' : 'Write plan'}
        </Button>
      </Row>
    </ListItem>
  )
}

function PrepareTab({ list }: { list: EpicList }) {
  const toPrepare = list.epics.filter((e) => !e.runnable)
  return (
    <Stack gap="md">
      <Text size="sm" muted>
        {PREPARE_HINT}
      </Text>
      <AgentsNote />
      {toPrepare.length === 0 ? (
        <Text size="sm" muted>
          Nothing to prepare: every epic has a spec and a plan.
        </Text>
      ) : (
        byMilestone(toPrepare).map((group) => (
          <Stack key={`group:${group.key}`} gap="xs">
            <GroupTitle group={{ ...group, milestone: null }} />
            <List label={group.title}>{group.epics.map(prepareRow)}</List>
          </Stack>
        ))
      )}
    </Stack>
  )
}

/** The button of a task by what it can be handed for, the key of its test id and the icon of its row. */
const HAND_ACTIONS: Record<HandMode, { key: string; label: string; icon: 'check' | 'flag' | 'agent' }> = {
  do: { key: 'hand', label: 'Hand to agent', icon: 'flag' },
  review: { key: 'review', label: 'Review', icon: 'check' },
  fix: { key: 'fix', label: 'Fix', icon: 'agent' }
}

/** The sheet of a task by what it is handed for: its title and who takes it. */
const HAND_SHEETS: Record<HandMode, { title: string; who: string }> = {
  do: { title: 'Hand to agent', who: 'Who takes the task' },
  review: { title: 'Review', who: 'Who reviews' },
  fix: { title: 'Fix', who: 'Who fixes' }
}

function taskRow(task: OutsideTask) {
  const key = `task:${task.id}`
  const title = `${task.id} · ${task.title}`
  const description = task.kind === 'bug' ? `${BUG_LABEL} · ${taskState(task)}` : taskState(task)
  const mode = handMode(task)
  if (mode === null) return <ListItem key={key} title={title} description={description} icon="agent" />
  const action = HAND_ACTIONS[mode]
  return (
    <ListItem key={key} title={title} description={description} icon={action.icon}>
      <Row>
        <Button
          key={`${action.key}:${task.id}`}
          size="xs"
          variant="outline"
          icon="agent"
          disabled={!canHand()}
          onPress={() => openSheet({ kind: mode, task })}
        >
          {action.label}
        </Button>
      </Row>
    </ListItem>
  )
}

function TasksTab() {
  const outside = read(tasks)
  if (outside === null) return <Skeleton shape="text" lines={3} label="Loading tasks…" />
  if (!outside.ok) return <RefusalBox error={outside.error} />
  if (outside.data.length === 0) {
    return <EmptyState icon="check" title="No tasks outside the epics" description="The project's open tasks outside the epics appear here." />
  }
  const groups: Array<[string, OutsideTask[]]> = [
    ['In review', outside.data.filter((t) => t.status === 'REVIEW')],
    ['In progress', outside.data.filter((t) => t.status === 'IN_PROGRESS')],
    ['To do', outside.data.filter((t) => t.status === 'TODO')]
  ]
  return (
    <Stack gap="md">
      <AgentsNote />
      {groups
        .filter(([, list]) => list.length > 0)
        .map(([title, list]) => (
          <Stack key={`tasks:${title}`} gap="xs">
            <Text size="sm" weight="semibold">
              {title}
            </Text>
            <List label={title}>{list.map(taskRow)}</List>
          </Stack>
        ))}
    </Stack>
  )
}

function Sections({ list }: { list: EpicList }) {
  const shown = currentTab()
  const outside = read(tasks)
  return (
    <Tabs
      label="Sections"
      value={shown}
      onChange={(value) => {
        set(tab, value)
        set(notice, null)
      }}
    >
      <Tab value="launch" label={`Ready to run · ${list.epics.filter((e) => e.runnable).length}`}>
        {shown === 'launch' ? <LaunchTab list={list} /> : null}
      </Tab>
      <Tab value="prepare" label={`Prepare · ${list.epics.filter((e) => !e.runnable).length}`}>
        {shown === 'prepare' ? <PrepareTab list={list} /> : null}
      </Tab>
      <Tab value="tasks" label={outside?.ok ? `Tasks · ${outside.data.length}` : 'Tasks'}>
        {shown === 'tasks' ? <TasksTab /> : null}
      </Tab>
    </Tabs>
  )
}

/** The sheet over a tab: what the agent will do, which agent, and the terminal it opens in. */
function SheetCard({ open }: { open: Sheet }) {
  const kinds = read(agents)
  const able = kinds?.ok ? taskAgents(kinds.data.agents) : []
  const last = kinds?.ok ? (kinds.data.preparer ?? null) : null
  const steps = SHEET_STEPS[open.kind]
  const text =
    open.kind === 'spec' || open.kind === 'plan'
      ? {
          title: `${open.kind === 'spec' ? 'Prepare' : 'Write plan'} “${open.epic.title}”`,
          description: `${open.epic.id} · ${open.kind === 'spec' ? 'no spec' : 'no plan'}`,
          who: 'Who prepares'
        }
      : {
          title: `${HAND_SHEETS[open.kind].title} “${open.task.title}”`,
          description: `${open.task.id} · ${taskState(open.task).toLowerCase()}`,
          who: HAND_SHEETS[open.kind].who
        }
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
            <Button variant="ghost" onPress={() => set(sheet, null)}>
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

const WAYS: readonly Way[] = ['sdd', 'workflow']

/** How the epic is done; under the switch, what the workflow does on its own. */
function WayPart({ choice }: { choice: Choice }) {
  return (
    <Stack gap="xs">
      <RadioGroup
        label="Mode"
        orientation="horizontal"
        options={WAYS.map((way) => ({ value: way, label: WAY_LABELS[way] }))}
        value={choice.way}
        onChange={(value) => choose({ way: value === 'workflow' ? 'workflow' : 'sdd' })}
      />
      {choice.way === 'workflow' ? (
        <Text key="workflow-note" size="xs" muted>
          {WORKFLOW_NOTE}
        </Text>
      ) : null}
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
  const able = list.filter((a) => PREPARE_AGENTS.includes(a.id))
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

/** The start of the open epic by what Orca sees of its session: start, or its terminal and a second start. */
function StartPart({ epic, state, choice }: { epic: number; state: EpicSession; choice: Choice }) {
  const needsClaude = choice.way === 'workflow' && choice.harness !== 'claude'
  const blocked = read(busy) || !canStart(choice.harness) || needsClaude || roleLists(choice) === null
  const needs = needsClaude ? (
    <Text key="way-needs-claude" size="xs" muted>
      {oneLine(WAY_NEEDS_CLAUDE)}
    </Text>
  ) : null
  if (state.alive) {
    return (
      <Stack gap="sm">
        <Callout key="session-alive" tone="accent" icon="terminal">
          {startNotice(epic, state.way)}
        </Callout>
        <Row gap="xs" wrap>
          <Button variant="solid" tone="accent" icon="terminal" disabled={read(busy)} onPress={showTerminal}>
            Show terminal
          </Button>
          <Button variant="outline" icon="play" disabled={blocked} onPress={() => set(confirmAgain, true)}>
            Start again
          </Button>
        </Row>
        {needs}
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
  const earlier = choice.way === 'sdd' ? (state.worktree === null ? null : COPY_NOTE) : state.workflowBranches ? BRANCHES_NOTE : null
  // The working copy and the branches this very start made are no earlier work to take up.
  const note = waits ? STARTED_NOTE : earlier
  return (
    <Stack gap="sm">
      <Button variant="solid" tone="accent" icon="play" disabled={blocked || waits} onPress={start}>
        Start
      </Button>
      {needs}
      {note === null ? null : (
        <Text key="start-note" size="xs" muted>
          {note}
        </Text>
      )}
    </Stack>
  )
}

/** What is chosen for the open epic and its start, by its session as read when it was opened. */
function SessionPart({ epic }: { epic: number }) {
  const state = read(session)
  if (state === null) return <Skeleton shape="block" label="Loading the epic's session…" />
  if (!state.ok) return <RefusalBox error={state.error} />
  const choice = choiceOf()
  if (choice === null) return null
  return (
    <Stack gap="lg">
      <WayPart choice={choice} />
      <HarnessPart choice={choice} />
      <RolesPart choice={choice} />
      <StartPart epic={epic} state={state.data} choice={choice} />
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

function EpicScreen({ epic, project }: { epic: EpicSummary; project: OrcaProject }) {
  const state = epicState(epic)
  const kicker = epic.milestone ? `${epic.id} · ${epic.milestone.title}` : String(epic.id)
  return (
    <Stack gap="lg">
      <Row justify="between" align="center">
        <Button variant="ghost" size="sm" onPress={closeEpic}>
          ← Epics
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
          {/* An epic that can start has both: the CLI checks them before it calls it runnable. */}
          <Badge>Spec ✓</Badge>
          <Badge>Plan ✓</Badge>
          <Text key="epic-state" size="xs" muted>
            {state.line}
          </Text>
        </Row>
      </Stack>
      <SessionPart epic={epic.id} />
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
  const list = read(epics)
  if (list === null) return <Skeleton shape="text" lines={4} label="Loading epics and tasks…" />
  if (!list.ok) return null
  const open = read(sheet)
  if (open !== null) return <SheetCard open={open} />
  const epic = openedEpic()
  if (epic !== null) return <EpicScreen epic={epic} project={project} />
  return <Sections list={list.data} />
}

export default function Panel() {
  followVisibility()
  const list = read(epics)
  const failed = read(refusal) ?? (list && !list.ok ? list.error : null)
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
