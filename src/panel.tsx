// The sidebar panel: epics of the project, the run launcher, the board, the stop-list questions
// and the outcome. Every CLI call goes through the plugin's worker (src/worker.ts).
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type {
  AgentKind,
  EpicList,
  EpicStatus,
  EpicSummary,
  RepoContext,
  Refusal,
  Result,
  Roles,
  StopQuestion,
  TaskStage
} from './protocol'
import {
  ACTIVE_PHASES,
  AGENT_MISSING_ACTION,
  CASES,
  EPIC_ROLE_WORK,
  FAILURE_ACTION,
  FAILURE_TITLE,
  PERMISSION_REMINDER,
  PHASE,
  ROLE_TITLES,
  stageLabel,
  statusLine
} from './text'

/** `npx` may fetch the CLI on its first call. */
const SLOW = { timeoutMs: 120_000 }

const context = atom<Result<RepoContext> | null>(null)
const epics = atom<Result<EpicList> | null>(null)
const agents = atom<Result<{ agents: AgentKind[]; chosen: Roles | null }> | null>(null)
const board = atom<Result<EpicStatus> | null>(null)
/** The epic the panel shows, remembered per workspace. */
const selected = atom<number | null>('epic', null, { persist: 'workspace' })
const roles = atom<Roles | null>(null)
const projectDraft = atom('projectDraft', '')
/** What the last action was refused with. */
const refusal = atom<Refusal | null>(null)
const notice = atom<string | null>(null)
const busy = atom(false)
const confirmStop = atom(false)

const ROLE_KEYS = ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'] as const

function handle(): string | null {
  const list = read(epics)
  return list?.ok ? list.data.project : null
}

function repoRoot(): string | null {
  const ctx = read(context)
  return ctx?.ok ? ctx.data.root : null
}

async function act<T>(run: () => Promise<Result<T>>, then: (data: T) => void): Promise<void> {
  set(busy, true)
  set(refusal, null)
  try {
    const answer = await run()
    if (answer.ok) then(answer.data)
    else set(refusal, answer.error)
  } catch (error) {
    set(refusal, { code: 'worker', message: String(error), action: 'обновите панель' })
  } finally {
    set(busy, false)
  }
}

async function loadBoard(): Promise<void> {
  const project = handle()
  const root = repoRoot()
  const epic = read(selected)
  set(board, null)
  if (project === null || root === null || epic === null) return
  set(board, await plugin.request('board.get', { project, root, epic }, SLOW))
}

function pickDefaults(list: { agents: AgentKind[]; chosen: Roles | null }): void {
  if (list.chosen) {
    set(roles, list.chosen)
    return
  }
  const first = list.agents.find((a) => a.found)?.id
  set(roles, first ? { implementer: first, reviewer: first, gapHunter: first, finalReviewer: first } : null)
}

async function loadEpics(): Promise<void> {
  const ctx = read(context)
  if (!ctx?.ok || ctx.data.project === null) return
  set(epics, null)
  const list = await plugin.request('epics.list', { project: ctx.data.project, root: ctx.data.root }, SLOW)
  set(epics, list)
  if (!list.ok) return
  const known = list.data.epics
  const current = read(selected)
  if (current === null || !known.some((e) => e.id === current)) {
    set(selected, known.find((e) => e.run !== null)?.id ?? null)
  }
  const answer = await plugin.request('agents.get', { project: list.data.project, root: ctx.data.root }, SLOW)
  set(agents, answer)
  if (answer.ok) pickDefaults(answer.data)
  await loadBoard()
}

async function load(): Promise<void> {
  set(refusal, null)
  set(context, null)
  set(context, await plugin.request('context.get', undefined, SLOW))
  await loadEpics()
}

async function rememberProject(value: string): Promise<void> {
  const root = repoRoot()
  if (root === null || value.trim() === '') return
  await act(
    () => plugin.request('project.set', { root, project: value }),
    (ctx) => {
      set(context, { ok: true, data: ctx })
      set(projectDraft, '')
    }
  )
  await loadEpics()
}

async function forgetProject(): Promise<void> {
  const root = repoRoot()
  if (root === null) return
  await act(
    () => plugin.request('project.forget', { root }),
    (ctx) => {
      set(context, { ok: true, data: ctx })
      set(epics, null)
      set(board, null)
    }
  )
}

async function choose(epic: number): Promise<void> {
  set(selected, epic)
  set(confirmStop, false)
  set(notice, null)
  await loadBoard()
}

function ref(): { project: string; root: string; epic: number } | null {
  const project = handle()
  const root = repoRoot()
  const epic = read(selected)
  return project === null || root === null || epic === null ? null : { project, root, epic }
}

async function start(): Promise<void> {
  const target = ref()
  const chosen = read(roles)
  if (target === null || chosen === null) return
  await act(
    () => plugin.request('run.start', { ...target, roles: chosen }),
    () => set(notice, `Прогон эпика ${target.epic} запущен в терминале «conport epic ${target.epic}» корня репозитория; если он откажет при подготовке, причина будет там.`)
  )
}

async function answer(question: StopQuestion, choice: string): Promise<void> {
  const target = ref()
  if (target === null) return
  await act(
    () => plugin.request('run.answer', { ...target, task: question.task, choice }, SLOW),
    (status) => set(board, { ok: true, data: status })
  )
}

async function stop(): Promise<void> {
  const target = ref()
  if (target === null) return
  set(confirmStop, false)
  await act(
    () => plugin.request('run.stop', target, SLOW),
    (status) => set(board, { ok: true, data: status })
  )
}

async function openWorktree(worktree: string): Promise<void> {
  await act(() => plugin.request('task.open', { worktree }), () => undefined)
}

async function openJournal(task: number): Promise<void> {
  const target = ref()
  if (target === null) return
  await act(() => plugin.request('task.journal', { ...target, task }), () => undefined)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('board.changed', (payload) => {
      if (payload.epic === read(selected) && payload.project === handle()) set(board, payload.board)
    })
  )
  void load()
}

function RefusalBox({ error }: { error: Refusal }) {
  return (
    <Callout tone="danger" icon="error" title={error.message || error.code}>
      <Stack gap="xs">
        {error.action ? <Text>{error.action}</Text> : null}
        <Text muted size="xs">
          <Code>{error.code}</Code>
        </Text>
      </Stack>
    </Callout>
  )
}

function ProjectLine() {
  const ctx = read(context)
  if (ctx === null) return <Skeleton shape="text" lines={1} label="Ищу репозиторий" />
  if (!ctx.ok) {
    return (
      <Stack gap="xs">
        <RefusalBox error={ctx.error} />
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={load}>
            Повторить
          </Button>
        </Row>
      </Stack>
    )
  }
  const { project, source } = ctx.data
  if (project === null) {
    return (
      <Card title="Проект ConPort" description="В .claude/settings.local.json репозитория нет CONPORT_PROJECT_NAME. Назовите проект один раз — панель запомнит его для этого репозитория.">
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
  const list = read(epics)
  const shown = list?.ok ? list.data.project : project
  return (
    <Row justify="between" align="center">
      <Text size="xs" muted truncate>
        Проект <Code>{shown}</Code>
        {source === 'repository' ? ' · из настроек репозитория' : ' · запомнен панелью'}
      </Text>
      <Row gap="xs">
        {source === 'stored' ? (
          <Button size="xs" variant="ghost" onPress={forgetProject}>
            Сменить
          </Button>
        ) : null}
        <IconButton icon="refresh" label="Обновить" size="xs" variant="ghost" disabled={read(busy)} onPress={load} />
      </Row>
    </Row>
  )
}

function groupsOf(list: EpicSummary[]): Array<{ title: string; epics: EpicSummary[] }> {
  const groups = new Map<string, { title: string; epics: EpicSummary[] }>()
  for (const epic of list) {
    const key = epic.milestone ? `m${epic.milestone.id}` : 'none'
    const group = groups.get(key) ?? { title: epic.milestone?.title ?? 'Без вехи', epics: [] }
    group.epics.push(epic)
    groups.set(key, group)
  }
  const none = groups.get('none')
  groups.delete('none')
  return [...groups.values(), ...(none ? [none] : [])]
}

function epicNote(epic: EpicSummary): string | undefined {
  if (!epic.runnable) return epic.reason ?? 'не готов к прогону'
  return epic.run ? `прогон: ${PHASE[epic.run.phase]}` : undefined
}

function EpicsSection() {
  const list = read(epics)
  if (list === null) return <Skeleton shape="text" lines={3} label="Читаю эпики" />
  if (!list.ok) return null
  if (list.data.epics.length === 0) {
    return (
      <EmptyState
        icon="layers"
        title="В проекте нет эпиков"
        description="Эпик готов к прогону, когда у него есть спецификация и план в ConPort."
      />
    )
  }
  const current = read(selected)
  return (
    <Stack gap="sm">
      <Heading level={3}>Эпики</Heading>
      {groupsOf(list.data.epics).map((group) => (
        <Stack key={group.title} gap="xs">
          <Text size="xs" muted weight="medium">
            {group.title}
          </Text>
          <List label={group.title}>
            {group.epics.map((epic) => (
              <ListItem
                key={`epic:${epic.id}`}
                title={`${epic.id} · ${epic.title}`}
                description={epicNote(epic)}
                icon={epic.runnable ? (epic.run ? 'activity' : 'layers') : 'remove'}
                current={epic.id === current}
                disabled={!epic.runnable}
                onPress={() => choose(epic.id)}
              />
            ))}
          </List>
        </Stack>
      ))}
    </Stack>
  )
}

function agentOptions(list: AgentKind[]): Array<{ value: string; label: string; disabled?: boolean }> {
  return list.map((a) =>
    a.found ? { value: a.id, label: a.label } : { value: a.id, label: `${a.label} — не найден`, disabled: true }
  )
}

function LaunchSection({ epic }: { epic: number }) {
  const kinds = read(agents)
  const chosen = read(roles)
  if (kinds === null) return <Skeleton shape="block" label="Читаю агентов" />
  if (!kinds.ok) return <RefusalBox error={kinds.error} />
  const options = agentOptions(kinds.data.agents)
  const noAgent = !kinds.data.agents.some((a) => a.found)
  const someMissing = kinds.data.agents.some((a) => !a.found)
  return (
    <Card title={`Запуск эпика ${epic}`} description="Агент на каждую роль; выбор запоминается для проекта.">
      <Stack gap="sm">
        {noAgent ? (
          <Callout tone="warning" icon="warning" title="Агенты не найдены">
            {`Ни одного агента, которого умеет запускать прогон, нет ни в PATH приложения Orca, ни среди агентов рабочего места: ${AGENT_MISSING_ACTION}`}
          </Callout>
        ) : null}
        {ROLE_KEYS.map((key) => (
          <Select
            key={key}
            label={ROLE_TITLES[key]}
            options={options}
            value={chosen?.[key] ?? ''}
            placeholder="выберите агента"
            onChange={(value) => set(roles, { ...(chosen ?? { implementer: '', reviewer: '', gapHunter: '', finalReviewer: '' }), [key]: value })}
          />
        ))}
        {someMissing && !noAgent ? (
          <Text key="agents-missing" size="xs" muted>
            {`«не найден» — ${AGENT_MISSING_ACTION}`}
          </Text>
        ) : null}
        <Callout tone="warning" icon="info" title="Режим разрешений">
          {PERMISSION_REMINDER}
        </Callout>
        <Button
          variant="solid"
          tone="accent"
          icon="play"
          disabled={read(busy) || chosen === null || ROLE_KEYS.some((k) => !chosen[k])}
          onPress={start}
        >
          Запустить
        </Button>
      </Stack>
    </Card>
  )
}

const STAGE_TONE: Record<TaskStage, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  waiting: 'neutral',
  implementing: 'accent',
  review: 'accent',
  fixing: 'warning',
  merging: 'accent',
  done: 'success',
  stopped: 'danger'
}

function BoardSection({ status }: { status: EpicStatus }) {
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={3}>Доска</Heading>
        <Badge tone={status.questions.length > 0 ? 'warning' : 'neutral'}>{PHASE[status.phase]}</Badge>
      </Row>
      <Text size="xs" muted>
        {statusLine(status)}
      </Text>
      {status.epicRole ? (
        <Callout tone="accent" icon="activity" title={`Идёт ${EPIC_ROLE_WORK[status.epicRole.role]}`}>
          Агент: {status.epicRole.agent}
        </Callout>
      ) : null}
      {status.paused ? (
        <Callout tone="warning" icon="pause" title="Слияния на паузе">
          {status.paused}
        </Callout>
      ) : null}
      {status.tasks.length === 0 ? (
        <Text size="sm" muted>
          В прогоне пока нет задач.
        </Text>
      ) : (
        <Stack gap="none">
          {status.tasks.map((task, index) => (
            <Stack key={`task-${task.id}`} gap="none">
              {index > 0 ? <Separator /> : null}
              <Box direction="row" align="center" gap="sm" paddingY="xs">
                <Box grow>
                  <Text size="sm" truncate>
                    <Text size="xs" muted>
                      {String(task.id)}
                    </Text>{' '}
                    {task.title}
                  </Text>
                </Box>
                <Badge tone={STAGE_TONE[task.stage]}>{stageLabel(task.stage, task.round)}</Badge>
                <Text size="xs" muted>
                  {task.agent ?? '—'}
                </Text>
                <IconButton
                  icon="terminal"
                  label={`Рабочее место задачи ${task.id}`}
                  tooltip="Перейти в worktree задачи"
                  size="xs"
                  variant="ghost"
                  disabled={task.worktree === null}
                  onPress={() => (task.worktree ? openWorktree(task.worktree) : undefined)}
                />
                <IconButton
                  icon="file-text"
                  label={`Журнал задачи ${task.id}`}
                  tooltip="Открыть журнал задачи"
                  size="xs"
                  variant="ghost"
                  onPress={() => openJournal(task.id)}
                />
              </Box>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function QuestionsSection({ status }: { status: EpicStatus }) {
  if (status.questions.length === 0) return null
  return (
    <Stack gap="sm">
      <Heading level={3}>Вопросы</Heading>
      {status.questions.map((q) => (
        <Card
          key={`q-${q.task ?? 'epic'}-${q.case}`}
          title={q.task === null ? `Эпик ${status.epic}` : `Задача ${q.task}`}
          description={CASES[q.case] ?? `Случай ${q.case}`}
        >
          <Stack gap="sm">
            <Text>{q.text}</Text>
            <Row gap="xs" wrap>
              {q.options.map((option) => (
                <Button key={option} size="sm" variant="outline" disabled={read(busy)} onPress={() => answer(q, option)}>
                  {option}
                </Button>
              ))}
            </Row>
          </Stack>
        </Card>
      ))}
    </Stack>
  )
}

/** Why a held run failed and the one action: the run's terminal may be long gone. */
function FailureBox({ failure }: { failure: Refusal }) {
  return (
    <Callout tone="danger" icon="error" title={FAILURE_TITLE}>
      <Stack gap="xs">
        <Text>{failure.message || failure.code}</Text>
        {failure.action ? <Text>{`${FAILURE_ACTION}${failure.action}`}</Text> : null}
        <Text muted size="xs">
          <Code>{failure.code}</Code>
        </Text>
      </Stack>
    </Callout>
  )
}

function OutcomeSection({ status }: { status: EpicStatus }) {
  const live = ACTIVE_PHASES.includes(status.phase)
  // A held run keeps its epic and tasks IN_PROGRESS until it is stopped: it can be stopped too.
  const stoppable = live || status.phase === 'held'
  const outcome = status.outcome
  const failure = status.phase === 'held' ? status.failure : null
  return (
    <Stack gap="sm">
      <Heading level={3}>Итог</Heading>
      {failure ? <FailureBox failure={failure} /> : null}
      {outcome === null ? (
        <Text size="sm" muted>
          Прогон ещё идёт.
        </Text>
      ) : outcome.kind === 'ready' ? (
        <Callout tone="success" icon="check" title="Эпик готов к вливанию в main">
          <Text>
            Голова ветки <Code>{`epic-${status.epic}`}</Code>: <Code>{outcome.head}</Code>
          </Text>
        </Callout>
      ) : outcome.kind === 'held' ? (
        <Callout tone="warning" icon="warning" title="Эпик держат">
          <Stack gap="xs">
            {outcome.reasons.map((reason) => (
              <Text key={reason}>· {reason}</Text>
            ))}
          </Stack>
        </Callout>
      ) : (
        <Callout tone="neutral" icon="stop" title="Прогон остановлен">
          Задачи вернулись в TODO; неслитая работа осталась в своих worktree.
        </Callout>
      )}
      {stoppable && !read(confirmStop) ? (
        <Row>
          <Button variant="outline" tone="danger" icon="stop" disabled={read(busy)} onPress={() => set(confirmStop, true)}>
            Остановить
          </Button>
        </Row>
      ) : null}
      {stoppable && read(confirmStop) ? (
        <Callout tone="danger" title={`Остановить прогон эпика ${status.epic}?`}>
          <Row gap="xs">
            <Button variant="solid" tone="danger" disabled={read(busy)} onPress={stop}>
              Да, остановить
            </Button>
            <Button variant="ghost" onPress={() => set(confirmStop, false)}>
              Отмена
            </Button>
          </Row>
        </Callout>
      ) : null}
    </Stack>
  )
}

function RunSections() {
  const epic = read(selected)
  const list = read(epics)
  if (epic === null || list === null || !list.ok) return null
  const summary = list.data.epics.find((e) => e.id === epic)
  if (!summary?.runnable) return null
  const current = read(board)
  if (current === null) return <Skeleton shape="block" label="Читаю доску" />
  if (!current.ok) return <RefusalBox error={current.error} />
  const status = current.data
  const live = ACTIVE_PHASES.includes(status.phase)
  return (
    <Stack gap="md">
      {live ? null : <LaunchSection epic={epic} />}
      {status.phase === 'none' ? null : (
        <Stack gap="md">
          <Separator />
          <BoardSection status={status} />
          <QuestionsSection status={status} />
          <OutcomeSection status={status} />
        </Stack>
      )}
    </Stack>
  )
}

export default function Panel() {
  const ctx = read(context)
  const list = read(epics)
  const failed = read(refusal) ?? (list && !list.ok ? list.error : null)
  const message = read(notice)
  return (
    <Stack gap="md">
      <ProjectLine />
      {failed ? <RefusalBox error={failed} /> : null}
      {message ? (
        <Callout tone="accent" icon="terminal">
          {message}
        </Callout>
      ) : null}
      {ctx?.ok && ctx.data.project !== null ? (
        <Stack gap="md">
          <EpicsSection />
          <RunSections />
        </Stack>
      ) : null}
    </Stack>
  )
}
