// The sidebar panel: control of a ConPort project from Orca. The chosen project's epics in three
// tabs — those to start, those to prepare, the tasks outside the epics — and the screen of an
// epic, where its agents are started, continued or stopped. The state of the agents is Orca's:
// the panel reads an epic's run only when the epic is opened. Every CLI call goes through the
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
import { answerCommand, handMode, missingDocument, PREPARE_AGENTS, statusCommand } from './cli'
import type {
  AgentKind,
  EpicList,
  EpicStatus,
  EpicSummary,
  HandMode,
  Milestone,
  OrcaProject,
  OutsideTask,
  Refusal,
  RepoContext,
  Result,
  Roles
} from './protocol'
import {
  ACTIVE_PHASES,
  AGENT_MISSING_ACTION,
  AT_WORK_NOTE,
  epicState,
  FAILURE_ACTION,
  failureText,
  FAILURE_TITLE,
  FOLDER_NOTE,
  handNotice,
  holdReason,
  NO_MILESTONE,
  NO_TASK_AGENT,
  PREPARE_HINT,
  PREPARE_STATE,
  prepareNotice,
  refusalText,
  releaseLine,
  ROLE_TITLES,
  SHEET_STEPS,
  startNotice,
  STOP_NOTE,
  taskState,
  TEAM_NOTE,
  unaskedText,
  UNASKED_TITLE
} from './text'

/** `npx` may fetch the CLI on its first call. */
const SLOW = { timeoutMs: 120_000 }

/** The form of a project handle: never shown as the name of a project. */
const HANDLE_FORM = /^pr[a-hjkmnp-z2-9]{8}$/

type TabName = 'launch' | 'prepare' | 'tasks'
const TAB_NAMES: readonly string[] = ['launch', 'prepare', 'tasks']

type AgentsAnswer = { agents: AgentKind[]; chosen: Roles | null; preparer?: string | null }

/** What the sheet opened over a tab is for: an epic to prepare, or a task to hand to an agent. */
type Sheet = { kind: 'spec' | 'plan'; epic: EpicSummary } | { kind: HandMode; task: OutsideTask }

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
const roles = atom<Roles | null>(null)
/** The epic open in each project, by its root. */
const openEpics = atom<Record<string, number>>('epics', {}, { persist: 'plugin' })
const tab = atom<string>('tab', 'launch', { persist: 'plugin' })
const run = atom<Result<EpicStatus> | null>(null)

const sheet = atom<Sheet | null>(null)
const sheetAgent = atom<string | null>(null)
/** The agent the person picked in the sheet in a project, kept while the project is read again. */
let pickedAgent: { root: string; agent: string } | null = null

/** What the last action was refused with. */
const refusal = atom<Refusal | null>(null)
const notice = atom<string | null>(null)
const busy = atom(false)
const confirmStop = atom(false)
/**
 * The epic whose agents the panel started since its run was last read, as `<root>:<epic>`: its
 * start button waits for that read, so a second press opens no second terminal.
 */
const started = atom<string | null>(null)

/**
 * Each load of a project, and each read of a run, takes a number; an answer is put in only while
 * its load is the last one, so a slow answer for a project left meanwhile is dropped.
 */
let projectLoad = 0
let runLoad = 0

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
    if (still()) set(refusal, { code: 'worker', message: 'воркер плагина не ответил', action: 'закройте и откройте панель снова' })
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

/** Reads the run of the open epic once. */
async function loadRun(): Promise<void> {
  const mine = ++runLoad
  set(run, null)
  set(started, null)
  const target = ref()
  if (target === null) return
  const answer = await plugin.request('run.get', target, SLOW)
  if (mine === runLoad) set(run, answer)
}

/** The agents found on this machine that can be told a task: those the sheet offers. */
const taskAgents = (list: AgentKind[]): AgentKind[] => list.filter((a) => a.found && PREPARE_AGENTS.includes(a.id))

function pickRoles(list: AgentsAnswer): void {
  if (list.chosen) {
    set(roles, list.chosen)
    return
  }
  const first = list.agents.find((a) => a.found)?.id
  set(roles, first ? { implementer: first, reviewer: first, gapHunter: first, finalReviewer: first } : null)
}

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
 * Reads the chosen project: its epics and tasks, the agents, and the run of the open epic. With
 * `keepSheet` (the panel back in view) an open sheet stays while its epic or task still wants it.
 */
async function loadProject({ keepSheet = false }: { keepSheet?: boolean } = {}): Promise<void> {
  const mine = ++projectLoad
  // A run read for the project left is no longer wanted either.
  runLoad++
  set(epics, null)
  set(tasks, null)
  set(agents, null)
  set(roles, null)
  set(run, null)
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
  if (answer.ok) pickRoles(answer.data)
  await loadRun()
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
  set(confirmStop, false)
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
    data: list.data.map((p) => (p.root === ctx.root ? { ...p, project: ctx.project, source: ctx.source } : p))
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
  set(confirmStop, false)
  set(notice, null)
  set(refusal, null)
  await loadRun()
}

function closeEpic(): void {
  setOpened(null)
  runLoad++
  set(run, null)
  set(confirmStop, false)
}

const startedKey = (root: string, epic: number): string => `${root}:${epic}`

async function start(): Promise<void> {
  const target = ref()
  const picked = read(roles)
  const name = current()?.name ?? ''
  if (target === null || picked === null) return
  await act(
    () => plugin.request('run.start', { ...target, roles: picked }),
    () => {
      set(started, startedKey(target.root, target.epic))
      set(notice, startNotice(target.epic, name))
    }
  )
}

async function stop(): Promise<void> {
  const target = ref()
  if (target === null) return
  set(confirmStop, false)
  await act(
    () => plugin.request('run.stop', target, SLOW),
    (status) => {
      if (sameRef(target, ref())) set(run, { ok: true, data: status })
    }
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

/** A refused action: said in Russian by its code, never in the English of the CLI. */
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
  if (project.project === null) return 'Нет проекта ConPort'
  return HANDLE_FORM.test(project.project) ? 'ConPort привязан' : `ConPort · ${project.project}`
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
            Привязать
          </Button>
        </Row>
      </ListItem>
    )
  }
  return (
    <ListItem
      key={key}
      title={project.name}
      description={project.focused ? `${bindingNote(project)} · в фокусе` : bindingNote(project)}
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
        label="Найти проект"
        labelHidden
        placeholder="Найти проект"
        value={read(projectQuery)}
        onChange={(value) => set(projectQuery, value)}
      />
      <Text size="xs" muted>
        Проекты Orca — в том же порядке, что в боковой панели
      </Text>
      {shown.length === 0 ? (
        <Text size="sm" muted>
          Ни один проект не подходит.
        </Text>
      ) : (
        <List label="Проекты">{shown.map((project) => projectItem(project, project.root === root))}</List>
      )}
      {current()?.source === 'stored' ? (
        <Row>
          <Button size="xs" variant="ghost" disabled={read(busy)} onPress={forgetProject}>
            Сменить проект ConPort
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

/** The chosen project, opening onto Orca's projects, and the refresh of the whole panel. */
function Header() {
  const list = read(projects)
  const refresh = <IconButton icon="refresh" label="Обновить" variant="outline" disabled={read(busy)} onPress={load} />
  if (list === null) return <Skeleton shape="text" lines={2} label="Читаю проекты Orca" />
  if (!list.ok) {
    return (
      <Stack gap="xs">
        <RefusalBox error={list.error} />
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={load}>
            Повторить
          </Button>
        </Row>
      </Stack>
    )
  }
  if (list.data.length === 0) {
    return (
      <Stack gap="sm">
        <Row justify="end">{refresh}</Row>
        <EmptyState icon="folder" title="В Orca нет проектов" description="Добавьте репозиторий в Orca и нажмите «Обновить»." />
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
          title={project?.name ?? 'Выберите проект'}
          description={project ? bindingNote(project) : 'Проект не выбран'}
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

function BindCard() {
  return (
    <Card
      title="Проект ConPort"
      description="В .claude/settings.local.json репозитория нет CONPORT_PROJECT_NAME. Назовите проект один раз — панель запомнит его для этого репозитория."
    >
      <Row gap="xs" align="end">
        <Input
          label="Проект ConPort"
          placeholder="имя или handle"
          value={read(projectDraft)}
          onChange={(v) => set(projectDraft, v)}
          onSubmit={(v) => void rememberProject(v)}
        />
        <Button variant="solid" tone="accent" disabled={read(busy)} onPress={() => rememberProject(read(projectDraft))}>
          Запомнить
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
      {state.share === null ? null : <Progress label={`Закрыто ${state.closed} из ${state.total}`} labelHidden value={state.share} />}
    </ListItem>
  )
}

function LaunchTab({ list }: { list: EpicList }) {
  if (list.epics.length === 0) {
    return (
      <EmptyState
        icon="layers"
        title="В проекте нет эпиков"
        description="Эпик можно запустить, когда у него есть спецификация и план в ConPort."
      />
    )
  }
  const runnable = list.epics.filter((e) => e.runnable)
  if (runnable.length === 0) {
    return (
      <Text size="sm" muted>
        Ни один эпик не готов к запуску: подготовьте его во вкладке «Подготовить».
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
      {`${NO_TASK_AGENT} ${AGENT_MISSING_ACTION}`}
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
          {missing === 'spec' ? 'Подготовить' : 'Написать план'}
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
          Готовить нечего: у каждого эпика есть спецификация и план.
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
  do: { key: 'hand', label: 'Отдать агенту', icon: 'flag' },
  review: { key: 'review', label: 'Проверить', icon: 'check' },
  fix: { key: 'fix', label: 'Исправить', icon: 'agent' }
}

/** The sheet of a task by what it is handed for: its title and who takes it. */
const HAND_SHEETS: Record<HandMode, { title: string; who: string }> = {
  do: { title: 'Отдать агенту', who: 'Кто возьмёт задачу' },
  review: { title: 'Проверить', who: 'Кто проверит' },
  fix: { title: 'Исправить', who: 'Кто исправит' }
}

function taskRow(task: OutsideTask) {
  const key = `task:${task.id}`
  const title = `${task.id} · ${task.title}`
  const mode = handMode(task)
  if (mode === null) return <ListItem key={key} title={title} description={taskState(task)} icon="agent" />
  const action = HAND_ACTIONS[mode]
  return (
    <ListItem key={key} title={title} description={taskState(task)} icon={action.icon}>
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
  if (outside === null) return <Skeleton shape="text" lines={3} label="Читаю задачи" />
  if (!outside.ok) return <RefusalBox error={outside.error} />
  if (outside.data.length === 0) {
    return <EmptyState icon="check" title="Задач вне эпиков нет" description="Открытые задачи проекта вне эпиков появятся здесь." />
  }
  const groups: Array<[string, OutsideTask[]]> = [
    ['Ждут проверки', outside.data.filter((t) => t.status === 'REVIEW')],
    ['В работе', outside.data.filter((t) => t.status === 'IN_PROGRESS')],
    ['К выполнению · по приоритету', outside.data.filter((t) => t.status === 'TODO').sort((a, b) => a.priority - b.priority)]
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
    <Tabs label="Разделы" value={shown} onChange={(value) => set(tab, value)}>
      <Tab value="launch" label={`К запуску · ${list.epics.filter((e) => e.runnable).length}`}>
        {shown === 'launch' ? <LaunchTab list={list} /> : null}
      </Tab>
      <Tab value="prepare" label={`Подготовить · ${list.epics.filter((e) => !e.runnable).length}`}>
        {shown === 'prepare' ? <PrepareTab list={list} /> : null}
      </Tab>
      <Tab value="tasks" label={outside?.ok ? `Задачи · ${outside.data.length}` : 'Задачи'}>
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
          title: `${open.kind === 'spec' ? 'Подготовить' : 'Написать план'} «${open.epic.title}»`,
          description: `${open.epic.id} · ${open.kind === 'spec' ? 'нет спецификации' : 'нет плана'}`,
          who: 'Кто подготовит'
        }
      : {
          title: `${HAND_SHEETS[open.kind].title} «${open.task.title}»`,
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
              {`${NO_TASK_AGENT} ${AGENT_MISSING_ACTION}`}
            </Text>
          ) : (
            <RadioGroup
              label={text.who}
              options={able.map((a) =>
                a.id === last ? { value: a.id, label: a.label, description: 'в прошлый раз' } : { value: a.id, label: a.label }
              )}
              value={read(sheetAgent) ?? ''}
              onChange={pickSheetAgent}
            />
          )}
          <Row gap="xs" justify="end">
            <Button variant="ghost" onPress={() => set(sheet, null)}>
              Отмена
            </Button>
            <Button
              variant="solid"
              tone="accent"
              icon="terminal"
              disabled={read(busy) || read(sheetAgent) === null}
              onPress={submitSheet}
            >
              Открыть в терминале
            </Button>
          </Row>
        </Stack>
      </Card>
    </Stack>
  )
}

function agentOptions(list: AgentKind[]): Array<{ value: string; label: string; disabled?: boolean }> {
  return list.map((a) =>
    a.found ? { value: a.id, label: a.label } : { value: a.id, label: `${a.label} — не найден`, disabled: true }
  )
}

/** The agent of each role; the choice is kept for the project when the agents start. */
function Team() {
  const kinds = read(agents)
  const picked = read(roles)
  if (kinds === null) return <Skeleton shape="block" label="Читаю агентов" />
  if (!kinds.ok) return <RefusalBox error={kinds.error} />
  const options = agentOptions(kinds.data.agents)
  const noAgent = !kinds.data.agents.some((a) => a.found)
  const someMissing = kinds.data.agents.some((a) => !a.found)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={3}>Команда</Heading>
        <Text size="xs" muted>
          запомнится для проекта
        </Text>
      </Row>
      {noAgent ? (
        <Callout tone="warning" icon="warning" title="Агенты не найдены">
          {`Ни одного агента, которого умеет запускать CLI, нет ни в PATH приложения Orca, ни среди агентов рабочего места: ${AGENT_MISSING_ACTION}`}
        </Callout>
      ) : null}
      <Grid columns={2} gap="md">
        {ROLE_KEYS.map((key) => (
          <Select
            key={key}
            label={ROLE_TITLES[key]}
            options={options}
            value={picked?.[key] ?? ''}
            placeholder="выберите агента"
            onChange={(value) => set(roles, { ...(picked ?? { implementer: '', reviewer: '', gapHunter: '', finalReviewer: '' }), [key]: value })}
          />
        ))}
      </Grid>
      {someMissing && !noAgent ? (
        <Text key="agents-missing" size="xs" muted>
          {`«не найден» — ${AGENT_MISSING_ACTION}`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Stop, asked once more. */
function StopControl({ epic }: { epic: number }) {
  if (read(confirmStop)) {
    return (
      <Callout tone="danger" title={`Остановить агентов эпика ${epic}?`}>
        <Stack gap="xs">
          <Text size="xs">{STOP_NOTE}</Text>
          <Row gap="xs">
            <Button variant="solid" tone="danger" disabled={read(busy)} onPress={stop}>
              Да, остановить
            </Button>
            <Button variant="ghost" onPress={() => set(confirmStop, false)}>
              Отмена
            </Button>
          </Row>
        </Stack>
      </Callout>
    )
  }
  return (
    <Stack gap="xs">
      <Row>
        <Button variant="outline" tone="danger" icon="stop" disabled={read(busy)} onPress={() => set(confirmStop, true)}>
          Остановить агентов
        </Button>
      </Row>
      <Text size="xs" muted>
        {STOP_NOTE}
      </Text>
    </Stack>
  )
}

/** The agents of the epic at work: their state is in Orca, the panel only stops them. */
function AtWork({ epic }: { epic: number }) {
  const kinds = read(agents)
  const picked = read(roles)
  const label = (id: string): string => (kinds?.ok ? (kinds.data.agents.find((a) => a.id === id)?.label ?? id) : id)
  const team = picked === null ? null : ROLE_KEYS.map((key) => label(picked[key])).join(' · ')
  return (
    <Card title="Агенты работают над эпиком">
      <Stack gap="sm">
        <Text size="sm">{AT_WORK_NOTE}</Text>
        {team === null ? null : (
          <Text size="xs" muted>
            {`Команда: ${team}`}
          </Text>
        )}
        <StopControl epic={epic} />
      </Stack>
    </Card>
  )
}

/**
 * Why held agents stopped and the one action: their terminal may be long gone. Said by the code
 * of the failure, never in the English of the CLI.
 */
function HeldBox({ status }: { status: EpicStatus }) {
  if (status.failure) {
    const text = failureText(status.failure.code, status.epic)
    return (
      <Callout tone="danger" icon="error" title={FAILURE_TITLE}>
        <Stack gap="xs">
          <Text>{text.what}</Text>
          <Text>{`${FAILURE_ACTION}${text.action}`}</Text>
          <Text muted size="xs">
            <Code>{status.failure.code}</Code>
          </Text>
        </Stack>
      </Callout>
    )
  }
  if (status.outcome?.kind !== 'held') return null
  return (
    <Callout tone="warning" icon="warning" title="Эпик держат">
      <Stack gap="xs">
        {status.outcome.reasons.map((reason, index) => (
          <Text key={`reason-${index}`}>{`· ${holdReason(reason, status.epic)}`}</Text>
        ))}
      </Stack>
    </Callout>
  )
}

/**
 * The questions of the run Orca did not take, each said as what the epic waits for with the
 * command that answers it: no gate of Orca holds them, and nothing else would show them.
 */
function Unasked({ status, project }: { status: EpicStatus; project: string }) {
  const refused = status.questions.filter((q) => q.refused)
  return (
    <Stack gap="sm">
      {refused.map((q) => {
        const text = unaskedText(q.task, ACTIVE_PHASES.includes(status.phase))
        return (
          <Callout key={`unasked:${q.task ?? 'epic'}`} tone="warning" icon="warning" title={UNASKED_TITLE}>
            <Stack gap="xs">
              <Text>{text.what}</Text>
              <Text>{`${FAILURE_ACTION}${text.action}`}</Text>
              <Text>
                <Code>{answerCommand(status.epic, project, q.task)}</Code>
              </Text>
              <Text muted size="xs">
                {text.hint}
              </Text>
              <Text muted size="xs">
                <Code>{statusCommand(status.epic, project)}</Code>
              </Text>
            </Stack>
          </Callout>
        )
      })}
    </Stack>
  )
}

/** What can be done with the agents of the open epic, by its run as read when it was opened. */
function RunPart({ epic, name }: { epic: number; name: string }) {
  const state = read(run)
  if (state === null) return <Skeleton shape="block" label="Читаю, работают ли агенты эпика" />
  if (!state.ok) return <RefusalBox error={state.error} />
  const controls = <RunControls status={state.data} epic={epic} name={name} />
  const project = handle()
  if (project === null || !state.data.questions.some((q) => q.refused)) return controls
  return (
    <Stack gap="lg">
      <Unasked status={state.data} project={project} />
      {controls}
    </Stack>
  )
}

/** Start, continue or stop the agents of the open epic, by the phase of its run. */
function RunControls({ status, epic, name }: { status: EpicStatus; epic: number; name: string }) {
  if (ACTIVE_PHASES.includes(status.phase)) return <AtWork epic={epic} />
  if (status.phase === 'ready') {
    const head = status.outcome?.kind === 'ready' ? `: ${status.outcome.head}` : ''
    return (
      <Stack gap="none">
        <Row key="run-ready" gap="xs" align="center" wrap>
          <Badge tone="success">Готов к вливанию</Badge>
          <Text size="xs" muted>{`голова ветки epic-${epic}${head}`}</Text>
        </Row>
      </Stack>
    )
  }
  const picked = read(roles)
  return (
    <Stack gap="lg">
      {status.phase === 'held' ? <HeldBox status={status} /> : null}
      <Team />
      <Callout tone="neutral" icon="info">
        {TEAM_NOTE}
      </Callout>
      <Stack gap="sm">
        <Button
          variant="solid"
          tone="accent"
          icon="play"
          disabled={
            read(busy) ||
            picked === null ||
            ROLE_KEYS.some((k) => !picked[k]) ||
            read(started) === startedKey(read(chosen) ?? '', epic)
          }
          onPress={start}
        >
          {status.phase === 'none' ? 'Запустить' : 'Продолжить'}
        </Button>
        <Text size="xs" muted>
          {`Агенты начнут работу в терминале Orca, в репозитории ${name}`}
        </Text>
      </Stack>
      {/* Held agents keep the epic and its tasks taken until they are stopped. */}
      {status.phase === 'held' ? <StopControl epic={epic} /> : null}
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
          ← Эпики
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
          <Badge>Спецификация</Badge>
          <Badge>План</Badge>
          <Text key="epic-state" size="xs" muted>
            {state.line}
          </Text>
        </Row>
      </Stack>
      <RunPart epic={epic.id} name={project.name} />
    </Stack>
  )
}

function Body() {
  const project = current()
  if (project === null) return null
  if (project.project === null) return <BindCard />
  const list = read(epics)
  if (list === null) return <Skeleton shape="text" lines={4} label="Читаю эпики и задачи" />
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
        <Callout tone="accent" icon="terminal">
          {message}
        </Callout>
      ) : null}
      <Body />
    </Stack>
  )
}
