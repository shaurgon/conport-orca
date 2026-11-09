// The panel over a worker that answers from the fake conport and orca executables, or over
// stubbed requests where only the panel is under test.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, assert, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import { AGENTS, EMPTY_LIST, EPIC_LIST, FAILED, HANDLE, NO_KEY, QUESTION, RUNNING } from '../test/fixtures'
import { fake, json } from '../test/fake'
import * as panel from './panel'
import type { EpicStatus, Result } from './protocol'
import { AGENT_MISSING_ACTION } from './text'

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

const ROOT = '/repo'
const ok = <T,>(data: T): Result<T> => ({ ok: true, data })
const context = ok({ root: ROOT, project: 'shop-api', source: 'repository' as const })

/** A worker stand-in: the given answers, the rest as a quiet project. */
function stub(answers: Record<string, (input: never) => unknown>) {
  const calls: Array<{ name: string; input: unknown }> = []
  const wrap =
    (name: string, fn: (input: never) => unknown) =>
    (input: never): unknown => {
      calls.push({ name, input })
      return fn(input)
    }
  const defaults: Record<string, (input: never) => unknown> = {
    'context.get': () => context,
    'epics.list': () => ok(EPIC_LIST),
    'agents.get': () => ok({ agents: AGENTS.agents, chosen: null }),
    'board.get': () => ok(RUNNING)
  }
  const all = { ...defaults, ...answers }
  const requests = Object.fromEntries(Object.entries(all).map(([name, fn]) => [name, wrap(name, fn)]))
  return { host: mockHost({ requests: requests as never }), calls }
}

function textOf(v: TestPanel): string {
  return JSON.stringify(v.tree())
}

test('epics list reads epic list json and greys out an epic without a plan', async () => {
  const f = fake([
    { match: 'epic list', stdout: json(EPIC_LIST) },
    { match: 'epic agents', stdout: json(AGENTS) },
    { match: 'epic status 7', stdout: json(RUNNING) }
  ])
  mkdirSync(join(f.root, '.claude'))
  writeFileSync(join(f.root, '.claude', 'settings.local.json'), JSON.stringify({ env: { CONPORT_PROJECT_NAME: 'shop-api' } }))
  const workerHost = f.host()
  const worker = await mountWorker(f.worker, { host: workerHost })
  // The panel's requests go to the real worker, which runs the fake CLI.
  const forward = (name: string) => (input: never) => worker.request(name as never, input)
  const names = ['context.get', 'epics.list', 'agents.get', 'board.get']
  view = await mount(panel, { host: mockHost({ requests: Object.fromEntries(names.map((n) => [n, forward(n)])) as never }) })

  assert.deepEqual(f.conportCalls()[0], ['epic', 'list', '--project', 'shop-api', '--json'])
  const withoutPlan = view.find({ testId: 'epic:9' })
  assert.equal(withoutPlan?.props.disabled, true)
  assert.equal(withoutPlan?.props.description, 'нет плана')
  const runnable = view.find({ testId: 'epic:15' })
  assert.equal(runnable?.props.disabled, false)
  // Grouped by milestone, the epics outside one last.
  const groups = view.findAll({ type: 'List' }).map((l) => l.props.label)
  assert.deepEqual(groups, ['Release 2.4', 'Без вехи'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await worker.deactivate()
})

test('an empty project says so', async () => {
  const { host } = stub({ 'epics.list': () => ok(EMPTY_LIST) })
  view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.equal(view.find({ text: 'Запустить' }), null)
})

test('the board names each stage in Russian and shows the merge pause', async () => {
  const { host } = stub({})
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  const stages = view.findAll({ type: 'Badge' }).map((b) => b.text)
  for (const label of ['готова', 'слияние', 'исправление круг 2', 'проверка', 'исполняется', 'ждёт']) {
    assert.ok(stages.includes(label), `no stage "${label}" in ${JSON.stringify(stages)}`)
  }
  assert.match(textOf(view), /Слияния на паузе/)
  assert.match(textOf(view), /эпик 7: 1\/6, вопросов 0/)
  // A live run has no launcher: the epic runs once at a time.
  assert.equal(view.find({ text: 'Запустить' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('start sends the chosen roles and shows the permission reminder', async () => {
  const { host, calls } = stub({
    'board.get': () => ok({ ...RUNNING, epic: 15, phase: 'none', tasks: [], paused: null }),
    'run.start': () => ok({ terminalId: 't', command: 'npx …' })
  })
  view = await mount(panel, { host, persisted: { workspace: { epic: 15 } } })
  assert.match(textOf(view), /спрашивает разрешение на каждую команду/)
  await view.select({ label: 'Исполнитель' }, 'codex')
  await view.press({ text: 'Запустить' })
  const start = calls.find((c) => c.name === 'run.start')
  assert.deepEqual(start?.input, {
    project: HANDLE,
    root: ROOT,
    epic: 15,
    roles: { implementer: 'codex', reviewer: 'claude', gapHunter: 'claude', finalReviewer: 'claude' }
  })
  // An agent whose command is not on this machine cannot be chosen.
  const options = view.find({ label: 'Проверяющий' })?.props.options as Array<{ value: string; disabled?: boolean }>
  assert.equal(options.find((o) => o.value === 'gemini')?.disabled, true)
})

const NOT_STARTED = (): Result<EpicStatus> => ok({ ...RUNNING, epic: 15, phase: 'none', tasks: [], paused: null })

test('an agent that is not found names the one thing to do, and the refresh it names reads the agents again', async () => {
  const { host, calls } = stub({ 'board.get': NOT_STARTED })
  view = await mount(panel, { host, persisted: { workspace: { epic: 15 } } })
  const note = view.find({ testId: 'agents-missing' })
  assert.equal(note?.text, `«не найден» — ${AGENT_MISSING_ACTION}`)
  assert.equal(view.find({ text: /Агенты не найдены/ }), null)
  await view.press({ label: 'Обновить' })
  assert.equal(calls.filter((c) => c.name === 'agents.get').length, 2)
})

test('with no agent found the warning names the same one thing to do', async () => {
  const none = AGENTS.agents.map((a) => ({ ...a, found: false }))
  const { host } = stub({ 'board.get': NOT_STARTED, 'agents.get': () => ok({ agents: none, chosen: null }) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 15 } } })
  const warning = view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Агенты не найдены')
  assert.ok(warning?.text.endsWith(AGENT_MISSING_ACTION), warning?.text)
  // One place names the action, not two.
  assert.equal(view.find({ testId: 'agents-missing' }), null)
})

test('with every agent found nothing is said about missing ones', async () => {
  const all = AGENTS.agents.map((a) => ({ ...a, found: true }))
  const { host } = stub({ 'board.get': NOT_STARTED, 'agents.get': () => ok({ agents: all, chosen: null }) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 15 } } })
  assert.equal(view.find({ testId: 'agents-missing' }), null)
  assert.equal(textOf(view).includes(AGENT_MISSING_ACTION), false)
})

test('a stop-list question is answered with its option', async () => {
  const { host, calls } = stub({
    'board.get': () => ok(QUESTION),
    'run.answer': () => ok(RUNNING)
  })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  assert.match(textOf(view), /Нужна необратимая операция/)
  await view.press({ text: 'запретить, решить иначе' })
  assert.deepEqual(calls.find((c) => c.name === 'run.answer')?.input, {
    project: HANDLE,
    root: ROOT,
    epic: 7,
    task: 13,
    choice: 'запретить, решить иначе'
  })
  // The answer brings the board without the question.
  assert.doesNotMatch(textOf(view), /Нужна необратимая операция/)
})

test('stop asks once more before stopping the run', async () => {
  const stopped: EpicStatus = { ...RUNNING, phase: 'stopped', outcome: { kind: 'stopped' } }
  const { host, calls } = stub({ 'run.stop': () => ok(stopped) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  await view.press({ text: 'Остановить' })
  assert.equal(calls.filter((c) => c.name === 'run.stop').length, 0)
  await view.press({ text: 'Да, остановить' })
  assert.equal(calls.filter((c) => c.name === 'run.stop').length, 1)
  assert.match(textOf(view), /Прогон остановлен/)
})

test('a held run can be stopped too', async () => {
  const held: EpicStatus = { ...RUNNING, phase: 'held', outcome: { kind: 'held', reasons: ['a task of the epic is IN_PROGRESS outside this run'] } }
  const stopped: EpicStatus = { ...RUNNING, phase: 'stopped', outcome: { kind: 'stopped' } }
  const { host, calls } = stub({ 'board.get': () => ok(held), 'run.stop': () => ok(stopped) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  await view.press({ text: 'Остановить' })
  await view.press({ text: 'Да, остановить' })
  assert.equal(calls.filter((c) => c.name === 'run.stop').length, 1)
  assert.match(textOf(view), /Прогон остановлен/)
})

test('the board names the gap hunt or the final review at work', async () => {
  const done = RUNNING.tasks.map((t) => ({ ...t, stage: 'done' as const }))
  const hunting: EpicStatus = { ...RUNNING, tasks: done, paused: null, epicRole: { role: 'gap-hunter', agent: 'codex' } }
  const { host } = stub({ 'board.get': () => ok(hunting) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  assert.match(textOf(view), /Идёт поиск пробелов/)
  assert.match(textOf(view), /эпик 7: 6\/6, вопросов 0, поиск пробелов/)
  await view.post('board.changed', {
    project: HANDLE,
    epic: 7,
    board: ok({ ...hunting, epicRole: { role: 'final-reviewer', agent: 'claude' } })
  })
  assert.match(textOf(view), /Идёт итоговая проверка/)
  assert.deepEqual(view.errors, [])
})

test('a held run shows why it failed and the one action', async () => {
  const { host } = stub({ 'board.get': () => ok(FAILED) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Прогон прервался')
  assert.ok(box, `no failure box in ${textOf(view)}`)
  const inside = JSON.stringify(box)
  assert.match(inside, /the gate is red on the head of the epic branch before the start/)
  assert.match(inside, /Что сделать: make the gate green on the epic branch, then start the run again/)
  assert.match(inside, /gate_red/)
  assert.deepEqual(view.errors, [])
})

test('a held run without a failure, and a failure outside the held phase, show no failure box', async () => {
  const { host } = stub({ 'board.get': () => ok({ ...FAILED, failure: null }) })
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  assert.match(textOf(view), /Эпик держат/)
  assert.doesNotMatch(textOf(view), /Прогон прервался/)
  await view.post('board.changed', { project: HANDLE, epic: 7, board: ok({ ...FAILED, phase: 'stopped', outcome: { kind: 'stopped' } }) })
  assert.match(textOf(view), /Прогон остановлен/)
  assert.doesNotMatch(textOf(view), /Прогон прервался/)
})

test('a missing api key shows the cli refusal in the panel', async () => {
  const { host } = stub({ 'epics.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, NO_KEY.message)
  assert.match(JSON.stringify(box), /впишите CONPORT_API_KEY в ~\/\.config\/conport\/\.env/)
})

test('without a project the panel asks for one and remembers it', async () => {
  let project: string | null = null
  const { host, calls } = stub({
    'context.get': () => ok({ root: ROOT, project, source: project ? 'stored' : null }),
    'project.set': (input: { project: string }) => {
      project = input.project
      return ok({ root: ROOT, project, source: 'stored' })
    }
  })
  view = await mount(panel, { host })
  assert.equal(calls.filter((c) => c.name === 'epics.list').length, 0)
  await view.type({ label: 'Проект ConPort' }, 'shop-api', { submit: true })
  assert.deepEqual(calls.find((c) => c.name === 'project.set')?.input, { root: ROOT, project: 'shop-api' })
  assert.equal(calls.filter((c) => c.name === 'epics.list').length, 1)
})

test('a board change posted by the worker redraws the board', async () => {
  const { host } = stub({})
  view = await mount(panel, { host, persisted: { workspace: { epic: 7 } } })
  await view.post('board.changed', { project: HANDLE, epic: 7, board: ok(QUESTION) })
  assert.match(textOf(view), /вопросов 1/)
})

test('a repository orca cannot name is retried from the panel', async () => {
  let answers = 0
  const { host, calls } = stub({
    'context.get': () =>
      ++answers === 1 ? { ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running', action: '' } } : context
  })
  view = await mount(panel, { host })
  assert.match(textOf(view), /Orca is not running/)
  await view.press({ text: 'Повторить' })
  assert.equal(calls.filter((c) => c.name === 'epics.list').length, 1)
  assert.doesNotMatch(textOf(view), /Orca is not running/)
})
