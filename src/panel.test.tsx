// The panel over a worker that answers from the fake conport and orca executables, or over
// stubbed requests where only the panel is under test.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, assert, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import { AGENTS, EMPTY_LIST, EPIC_LIST, FAILED, HANDLE, idle, NO_KEY, RELEASE, RUNNING, STOPPED, TASK_LIST } from '../test/fixtures'
import { fake, json, until } from '../test/fake'
import * as panel from './panel'
import type { EpicList, EpicStatus, EpicSummary, Milestone, OrcaProject, Result } from './protocol'
import { CLI_VERSION } from './cli'
import { AGENT_MISSING_ACTION, failureText } from './text'

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

const ROOT = '/repo'
const ok = <T,>(data: T): Result<T> => ({ ok: true, data })
const SHOP: OrcaProject = { name: 'Shop', root: ROOT, kind: 'git', project: 'shop-api', source: 'repository', focused: true }
const BILLING: OrcaProject = { name: 'Billing', root: '/billing', kind: 'git', project: 'billing-api', source: 'stored', focused: false }
const NOTES: OrcaProject = { name: 'Notes', root: '/notes', kind: 'folder', project: null, source: null, focused: false }
const DOCS: OrcaProject = { name: 'Docs', root: '/docs', kind: 'git', project: null, source: null, focused: false }
const unfocused = (p: OrcaProject): OrcaProject => ({ ...p, focused: false })

/** What an earlier run of the panel remembered: the epic open in the project at ROOT. */
const at = (epic: number) => ({ plugin: { epics: { [ROOT]: epic } } })

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
    'projects.list': () => ok([SHOP]),
    'epics.list': () => ok(EPIC_LIST),
    'tasks.list': () => ok(TASK_LIST.tasks),
    'agents.get': () => ok({ agents: AGENTS.agents, chosen: null }),
    'run.get': (input: { epic: number }) => ok(input.epic === 7 ? RUNNING : idle(input.epic))
  }
  const all = { ...defaults, ...answers }
  const requests = Object.fromEntries(Object.entries(all).map(([name, fn]) => [name, wrap(name, fn)]))
  return { host: mockHost({ requests: requests as never }), calls }
}

function textOf(v: TestPanel): string {
  return JSON.stringify(v.tree())
}

const inputsOf = (calls: Array<{ name: string; input: unknown }>, name: string): unknown[] =>
  calls.filter((c) => c.name === name).map((c) => c.input)

/** The project picker: the name of the chosen project, opening onto Orca's projects. */
const pickerOf = (v: TestPanel) => v.find({ testId: 'project-picker' })

/** Chooses a project in the picker, opening it first. */
async function pick(v: TestPanel, root: string): Promise<void> {
  if (v.find({ testId: `project:${root}` }) === null) await v.toggle({ testId: 'project-picker' })
  await v.press({ testId: `project:${root}` })
}

/**
 * Opens the picker while requests are pending: an act settles only once none is, so the toggle
 * is not awaited; the item it shows is.
 */
async function openPicker(v: TestPanel, root: string): Promise<void> {
  if (v.find({ testId: `project:${root}` }) !== null) return
  void v.toggle({ testId: 'project-picker' })
  await until(() => v.find({ testId: `project:${root}` }) !== null)
}

async function tab(v: TestPanel, value: 'launch' | 'prepare' | 'tasks'): Promise<void> {
  await v.select({ label: 'Разделы' }, value)
}

/** The labels of the tabs, with their counts. */
const tabsOf = (v: TestPanel): string[] => v.findAll({ type: 'Tab' }).map((t) => String(t.props.label))

/** The titles of the epic lists of the open tab, in the order drawn. */
const groupsOf = (v: TestPanel): string[] => v.findAll({ type: 'List' }).map((l) => String(l.props.label))

/** The items of the list `label`, as `[title, description]`, in the order drawn. */
function itemsIn(v: TestPanel, label: string): Array<[unknown, unknown]> {
  const list = v.findAll({ type: 'List' }).find((l) => l.props.label === label)
  if (!list) return []
  return v
    .findAll({ type: 'ListItem' })
    .filter((i) => i.path.startsWith(`${list.path}/`))
    .map((i) => [i.props.title, i.props.description])
}

const headingOf = (v: TestPanel, level: number): string | undefined =>
  v.findAll({ type: 'Heading' }).find((h) => h.props.level === level)?.text

test('epics and tasks of the focused project come from the worker over the fake cli', async () => {
  const f = fake([
    { match: 'epic list', stdout: json(EPIC_LIST) },
    { match: 'task list', stdout: json(TASK_LIST) },
    { match: 'epic agents', stdout: json(AGENTS) }
  ])
  mkdirSync(join(f.root, '.claude'))
  writeFileSync(join(f.root, '.claude', 'settings.local.json'), JSON.stringify({ env: { CONPORT_PROJECT_NAME: 'shop-api' } }))
  const worker = await mountWorker(f.worker, { host: f.host() })
  // The panel's requests go to the real worker, which runs the fake CLI.
  const forward = (name: string) => (input: never) => worker.request(name as never, input)
  const names = ['projects.list', 'epics.list', 'tasks.list', 'agents.get', 'run.get']
  view = await mount(panel, { host: mockHost({ requests: Object.fromEntries(names.map((n) => [n, forward(n)])) as never }) })

  const calls = f.conportCalls()
  assert.deepEqual(calls.find((c) => c[0] === 'epic' && c[1] === 'list'), ['epic', 'list', '--project', 'shop-api', '--json'])
  assert.deepEqual(calls.find((c) => c[0] === 'task'), ['task', 'list', '--project', 'shop-api', '--json'])
  assert.deepEqual(tabsOf(view), ['К запуску · 2', 'Подготовить · 2', 'Задачи · 5'])
  assert.deepEqual(groupsOf(view), ['Release 2.4', 'Без вехи'])
  // The list reads no run: the run of an epic is read when the epic is opened.
  assert.equal(calls.some((c) => c[1] === 'status'), false)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await worker.deactivate()
})

test('the run starts in the root of the chosen project', async () => {
  const f = fake(
    [
      { match: 'epic list', stdout: json({ ...EPIC_LIST, project: 'prbi11ngq2' }) },
      { match: 'task list', stdout: json({ ...TASK_LIST, project: 'prbi11ngq2' }) },
      { match: 'epic agents', stdout: json(AGENTS) },
      { match: 'epic status', stdout: json(idle(15)) }
    ],
    (d) => [
      {
        match: 'repo list ',
        stdout: json({
          ok: true,
          result: {
            repos: [
              { id: 'repo-focus', displayName: 'Shop', path: d.root, kind: 'git' },
              { id: 'repo-billing', displayName: 'Billing', path: join(d.dir, 'billing'), kind: 'git' }
            ]
          }
        })
      },
      { match: 'terminal switch', stdout: json({ ok: true, result: {} }) }
    ]
  )
  const billing = join(dirname(f.root), 'billing')
  for (const [dir, name] of [[f.root, 'shop-api'], [billing, 'billing-api']] as const) {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ env: { CONPORT_PROJECT_NAME: name } }))
  }
  const workerHost = f.host({
    'workspace.list': {
      workspaces: [
        { id: 'ws-focus', kind: 'worktree', name: 'feature', path: f.focused, branch: 'feature', hostId: null },
        { id: 'ws-root', kind: 'worktree', name: 'repo', path: f.root, branch: 'main', hostId: null },
        { id: 'ws-billing', kind: 'worktree', name: 'billing', path: billing, branch: 'main', hostId: null }
      ],
      truncated: false
    }
  })
  const worker = await mountWorker(f.worker, { host: workerHost })
  const forward = (name: string) => (input: never) => worker.request(name as never, input)
  const names = ['projects.list', 'epics.list', 'tasks.list', 'agents.get', 'run.get', 'run.start']
  view = await mount(panel, { host: mockHost({ requests: Object.fromEntries(names.map((n) => [n, forward(n)])) as never }) })

  await pick(view, billing)
  await view.press({ testId: 'epic:15' })
  await view.press({ text: 'Запустить' })
  // The epics and the run are those of the chosen project, in a terminal of its root.
  assert.deepEqual(f.conportCalls().filter((c) => c[1] === 'list' && c[0] === 'epic').at(-1), ['epic', 'list', '--project', 'billing-api', '--json'])
  const created = workerHost.callsOf('terminal.create') as Array<{ workspaceId: string; command: string }>
  assert.deepEqual(created.map((c) => c.workspaceId), ['ws-billing'])
  assert.match(created[0]?.command ?? '', / epic run 15 --project prbi11ngq2 /)
  assert.match(textOf(view), /в терминале «conport epic 15» репозитория «Billing»/)
  assert.deepEqual(view.errors, [])
  await worker.deactivate()
})

test('projects follow the orca repo list order and names', async () => {
  const { host } = stub({ 'projects.list': () => ok([unfocused(BILLING), SHOP, NOTES, DOCS]) })
  view = await mount(panel, { host })
  // The picker names the chosen project as Orca shows it, never by its handle.
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  assert.equal(pickerOf(view)?.props.description, 'ConPort · shop-api')
  assert.equal(view.find({ type: 'List', label: 'Проекты' }), null)
  await view.toggle({ testId: 'project-picker' })
  assert.ok(view.find({ type: 'List', label: 'Проекты' }), textOf(view))
  assert.match(textOf(view), /Проекты Orca — в том же порядке, что в боковой панели/)
  const items = view.findAll({ type: 'ListItem' }).filter((i) => i.key?.startsWith('project:'))
  assert.deepEqual(items.map((i) => i.props.title), ['Billing', 'Shop', 'Notes', 'Docs'])
  assert.deepEqual(items.map((i) => i.props.description), [
    'ConPort · billing-api',
    'ConPort · shop-api · в фокусе',
    'Папка без git — запускать нечего',
    'Нет проекта ConPort'
  ])
  assert.doesNotMatch(textOf(view), new RegExp(HANDLE))
})

test('the project search narrows the list by name', async () => {
  const { host } = stub({ 'projects.list': () => ok([unfocused(BILLING), SHOP, NOTES, DOCS]) })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  await view.type({ label: 'Найти проект' }, 'bil')
  const items = view.findAll({ type: 'ListItem' }).filter((i) => i.key?.startsWith('project:'))
  assert.deepEqual(items.map((i) => i.props.title), ['Billing'])
  // Choosing a project closes the picker.
  await view.press({ testId: `project:${BILLING.root}` })
  assert.equal(view.find({ type: 'List', label: 'Проекты' }), null)
  assert.equal(pickerOf(view)?.props.title, 'Billing')
})

test('a project bound by its handle is not named by it in the picker', async () => {
  const { host } = stub({ 'projects.list': () => ok([{ ...SHOP, project: HANDLE }]) })
  view = await mount(panel, { host })
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  await view.toggle({ testId: 'project-picker' })
  assert.doesNotMatch(textOf(view), new RegExp(HANDLE))
})

test('a project without a binding offers to bind it', async () => {
  let docs = DOCS
  const { host, calls } = stub({
    'projects.list': () => ok([SHOP, docs]),
    'project.set': (input: { root: string; project: string }) => {
      docs = { ...docs, project: input.project, source: 'stored' }
      return ok({ root: input.root, project: input.project, source: 'stored' })
    }
  })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  // Only the project without a binding offers it.
  assert.equal(view.findAll({ text: 'Привязать' }).length, 1)
  await view.press({ text: 'Привязать' })
  assert.equal(pickerOf(view)?.props.title, 'Docs')
  await view.type({ label: 'Проект ConPort' }, 'docs-api', { submit: true })
  assert.deepEqual(inputsOf(calls, 'project.set'), [{ root: DOCS.root, project: 'docs-api' }])
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'docs-api', root: DOCS.root })
  assert.equal(view.find({ text: 'Привязать' }), null)
})

test('a project bound by the panel can be bound anew', async () => {
  const { host, calls } = stub({
    'projects.list': () => ok([BILLING]),
    'project.forget': (input: { root: string }) => ok({ root: input.root, project: null, source: null })
  })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  await view.press({ text: 'Сменить проект ConPort' })
  assert.deepEqual(inputsOf(calls, 'project.forget'), [{ root: BILLING.root }])
  assert.ok(view.find({ label: 'Проект ConPort' }))
})

test('a folder project cannot run', async () => {
  // Even in focus, a folder without git is not picked: the first bound project is.
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...NOTES, focused: true }, unfocused(SHOP)]) })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  const folder = view.find({ testId: `project:${NOTES.root}` })
  assert.equal(folder?.props.disabled, true)
  assert.equal(folder?.props.description, 'Папка без git — запускать нечего')
  assert.equal(view.find({ text: 'Привязать' }), null)
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'shop-api', root: ROOT }])
})

test('the focused project is selected first', async () => {
  const { host, calls } = stub({ 'projects.list': () => ok([BILLING, SHOP].map((p) => ({ ...p, focused: p === SHOP }))) })
  // The project chosen last loses to the one in focus.
  view = await mount(panel, { host, persisted: { plugin: { project: BILLING.root } } })
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'shop-api', root: ROOT }])
  await view.toggle({ testId: 'project-picker' })
  assert.equal(view.find({ testId: `project:${ROOT}` })?.props.current, true)
  assert.equal(view.find({ testId: `project:${BILLING.root}` })?.props.current, false)
})

test('without a focused workspace the last chosen project is selected', async () => {
  const list = [unfocused(SHOP), BILLING]
  const cases = [
    // The project chosen last, when Orca still lists it.
    [{ plugin: { project: BILLING.root } }, BILLING],
    // A project chosen last that Orca no longer lists: the first bound one.
    [{ plugin: { project: '/gone' } }, SHOP],
    // Nothing chosen before: the first bound one.
    [undefined, SHOP]
  ] as const
  for (const [persisted, expected] of cases) {
    const { host, calls } = stub({ 'projects.list': () => ok(list) })
    view = await mount(panel, { host, persisted })
    assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: expected.project, root: expected.root }])
    await view.unmount()
    view = undefined
  }
  // Neither a folder nor a project without a binding counts as the first bound one.
  const { host, calls } = stub({ 'projects.list': () => ok([NOTES, DOCS, BILLING]) })
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'billing-api', root: BILLING.root }])
})

test('choosing another project reads its epics and tasks and keeps the epic open in each', async () => {
  const { host, calls } = stub({ 'projects.list': () => ok([SHOP, BILLING]) })
  view = await mount(panel, { host, persisted: at(15) })
  assert.deepEqual(inputsOf(calls, 'run.get'), [{ project: HANDLE, root: ROOT, epic: 15 }])
  await pick(view, BILLING.root)
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'billing-api', root: BILLING.root })
  assert.deepEqual(inputsOf(calls, 'tasks.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // No epic is open in the second project: its epics show, no run is read.
  assert.equal(inputsOf(calls, 'run.get').length, 1)
  assert.ok(view.find({ testId: 'epic:15' }))
  await pick(view, ROOT)
  // Back in the first project, its epic is open again.
  assert.deepEqual(inputsOf(calls, 'run.get').at(-1), { project: HANDLE, root: ROOT, epic: 15 })
  assert.ok(view.find({ text: 'Запустить' }))
})

test('a slow answer for a project left meanwhile is dropped', async () => {
  const billingEpics: EpicList = {
    project: 'prbi11ngq2',
    epics: [{ id: 30, title: 'Invoices', status: 'TODO', progress: { open: 2, total: 2 }, milestone: null, runnable: true, reason: null, run: null }]
  }
  const pending: Array<() => void> = []
  let first = true
  const { host, calls } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'epics.list': (input: { root: string }) => {
      if (first) {
        first = false
        return ok(EPIC_LIST)
      }
      const answer = ok(input.root === BILLING.root ? billingEpics : EPIC_LIST)
      return new Promise((resolve) => pending.push(() => resolve(answer)))
    },
    'run.start': () => ok({ terminalId: 't', command: 'npx …' })
  })
  view = await mount(panel, { host, persisted: at(15) })
  await openPicker(view, BILLING.root)
  // Billing, then Shop again before the epics of Billing came; they come last.
  const toBilling = view.press({ testId: `project:${BILLING.root}` })
  await until(() => pending.length === 1)
  await openPicker(view, ROOT)
  const toShop = view.press({ testId: `project:${ROOT}` })
  await until(() => pending.length === 2)
  // Shop answers and its load goes to the end; then the answer for Billing comes. A press
  // settles only once no request is pending, so both are awaited after the answers.
  pending[1]?.()
  await new Promise((resolve) => setTimeout(resolve, 30))
  pending[0]?.()
  await Promise.all([toBilling, toShop])
  // The panel shows Shop with its own epic open, and a run starts in Shop with Shop's handle.
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  assert.doesNotMatch(textOf(view), /Invoices/)
  assert.deepEqual(inputsOf(calls, 'run.get').at(-1), { project: HANDLE, root: ROOT, epic: 15 })
  await view.press({ text: 'Запустить' })
  const started = inputsOf(calls, 'run.start') as Array<{ project: string; root: string; epic: number }>
  assert.deepEqual(started.map(({ project, root, epic }) => ({ project, root, epic })), [{ project: HANDLE, root: ROOT, epic: 15 }])
})

/**
 * A panel over Shop and Billing, epic 7 open in both, that has opened Shop once; from then on
 * each request named in `hold` waits for the test to let it answer. Shop's agents work, Billing's
 * epic never ran.
 */
async function twoProjects() {
  const hold = new Set<string>()
  const pending = new Map<string, () => void>()
  const later = <T,>(key: string, answer: T): T | Promise<T> =>
    hold.has(key) ? new Promise((resolve) => pending.set(key, () => resolve(answer))) : answer
  const shopRoles = { implementer: 'codex', reviewer: 'codex', gapHunter: 'codex', finalReviewer: 'codex' }
  const billingRoles = { implementer: 'claude', reviewer: 'claude', gapHunter: 'claude', finalReviewer: 'claude' }
  const { host, calls } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'agents.get': (input: { root: string }) => {
      const shop = input.root === ROOT
      return later(`agents:${input.root}`, ok({ agents: AGENTS.agents, chosen: shop ? shopRoles : billingRoles }))
    },
    'run.get': (input: { root: string; epic: number }) => later(`run:${input.root}`, ok(input.root === ROOT ? RUNNING : idle(7))),
    'run.start': () => ok({ terminalId: 't', command: 'npx …' })
  })
  view = await mount(panel, { host, persisted: { plugin: { epics: { [ROOT]: 7, [BILLING.root]: 7 } } } })
  assert.match(textOf(view), /Агенты работают над эпиком/)
  /** Lets a held request answer, then gives the panel a moment to draw it. */
  const release = async (key: string): Promise<void> => {
    await until(() => pending.has(key))
    pending.get(key)?.()
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const isPending = (key: string): boolean => pending.has(key)
  return { hold, release, isPending, calls, shopRoles, billingRoles }
}

test('a run of the project left that answers late is not drawn in the chosen one', async () => {
  const { hold, release, isPending } = await twoProjects()
  const v = view as TestPanel
  await pick(v, BILLING.root)
  hold.add(`run:${ROOT}`)
  await openPicker(v, ROOT)
  const toShop = v.press({ testId: `project:${ROOT}` })
  await until(() => isPending(`run:${ROOT}`))
  await openPicker(v, BILLING.root)
  const toBilling = v.press({ testId: `project:${BILLING.root}` })
  // Billing's run is drawn; then Shop's run comes with its working agents.
  await new Promise((resolve) => setTimeout(resolve, 30))
  await release(`run:${ROOT}`)
  await Promise.all([toShop, toBilling])
  assert.equal(pickerOf(v)?.props.title, 'Billing')
  assert.doesNotMatch(textOf(v), /Агенты работают над эпиком/)
  assert.ok(v.find({ text: 'Запустить' }), 'the launcher of Billing, whose epic never ran')
})

test('a run of the project left that answers while the chosen one still loads is not drawn', async () => {
  const { hold, release, isPending } = await twoProjects()
  const v = view as TestPanel
  await pick(v, BILLING.root)
  hold.add(`run:${ROOT}`)
  await openPicker(v, ROOT)
  const toShop = v.press({ testId: `project:${ROOT}` })
  await until(() => isPending(`run:${ROOT}`))
  // Billing's epics come, its agents do not yet: its run is not asked for.
  hold.add(`agents:${BILLING.root}`)
  await openPicker(v, BILLING.root)
  const toBilling = v.press({ testId: `project:${BILLING.root}` })
  await release(`run:${ROOT}`)
  assert.doesNotMatch(textOf(v), /Агенты работают над эпиком/)
  await release(`agents:${BILLING.root}`)
  await Promise.all([toShop, toBilling])
  assert.doesNotMatch(textOf(v), /Агенты работают над эпиком/)
})

test('roles of the project left that answer late are not taken for the chosen one', async () => {
  const { hold, release, isPending, calls, billingRoles } = await twoProjects()
  const v = view as TestPanel
  await pick(v, BILLING.root)
  hold.add(`agents:${ROOT}`)
  await openPicker(v, ROOT)
  const toShop = v.press({ testId: `project:${ROOT}` })
  await until(() => isPending(`agents:${ROOT}`))
  await openPicker(v, BILLING.root)
  const toBilling = v.press({ testId: `project:${BILLING.root}` })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await release(`agents:${ROOT}`)
  await Promise.all([toShop, toBilling])
  assert.equal(v.find({ label: 'Исполнитель' })?.props.value, 'claude')
  await v.press({ text: 'Запустить' })
  const started = inputsOf(calls, 'run.start') as Array<{ root: string; roles: unknown }>
  assert.deepEqual(started.map(({ root, roles }) => ({ root, roles })), [{ root: BILLING.root, roles: billingRoles }])
})

test('refresh keeps the project chosen by hand while orca lists it', async () => {
  let listed = [SHOP, BILLING]
  const { host, calls } = stub({ 'projects.list': () => ok(listed) })
  view = await mount(panel, { host })
  await pick(view, BILLING.root)
  await view.press({ label: 'Обновить' })
  // The focus does not take the panel back from the project chosen by hand.
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // Once Orca no longer lists it, the project opens as on the first load: the one in focus.
  listed = [SHOP]
  await view.press({ label: 'Обновить' })
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'shop-api', root: ROOT })
})

test('a reload with no project to open on keeps the one chosen last remembered', async () => {
  let listed: OrcaProject[] = [BILLING]
  const { host, calls } = stub({ 'projects.list': () => ok(listed) })
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'billing-api', root: BILLING.root }])
  listed = [NOTES]
  await view.press({ label: 'Обновить' })
  assert.equal(inputsOf(calls, 'epics.list').length, 1)
  // Back in the list, the project chosen last opens before the first bound one.
  listed = [unfocused(SHOP), BILLING]
  await view.press({ label: 'Обновить' })
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'billing-api', root: BILLING.root })
})

/** A milestone of the roadmap, open epics as given. */
const milestone = (id: number, title: string, sequence: number, extra: Partial<Milestone> = {}): Milestone => ({
  id,
  title,
  sequence,
  is_release: false,
  ready_to_close: false,
  open_epics: 1,
  ...extra
})

/** A runnable epic that never ran, in `m`, with `open` of `total` tasks open. */
const epic = (id: number, m: Milestone | null, extra: Partial<EpicSummary> = {}): EpicSummary => ({
  id,
  title: `Epic ${id}`,
  status: 'TODO',
  progress: { open: 2, total: 2 },
  milestone: m,
  runnable: true,
  reason: null,
  run: null,
  ready: false,
  ...extra
})

test('the launch tab groups runnable epics by milestone in roadmap order', async () => {
  const later = milestone(4, 'Later', 9)
  const sooner = milestone(8, 'Sooner', 1)
  const list: EpicList = {
    project: HANDLE,
    epics: [
      epic(20, null),
      epic(21, later),
      epic(22, sooner),
      // An epic that cannot run is not in this tab, nor is its milestone.
      epic(23, milestone(6, 'Unprepared', 0), { runnable: false, reason: 'no plan' }),
      epic(24, sooner),
      epic(25, later)
    ]
  }
  const { host } = stub({ 'epics.list': () => ok(list) })
  view = await mount(panel, { host })
  // Milestones by their place in the roadmap, not by id or by the order of the epics; the epics
  // outside a milestone last.
  assert.deepEqual(groupsOf(view), ['Sooner', 'Later', 'Без вехи'])
  const titles = (label: string) => itemsIn(view as TestPanel, label).map(([title]) => title)
  assert.deepEqual(titles('Sooner'), ['22 · Epic 22', '24 · Epic 24'])
  assert.deepEqual(titles('Later'), ['21 · Epic 21', '25 · Epic 25'])
  assert.deepEqual(titles('Без вехи'), ['20 · Epic 20'])
  assert.equal(view.find({ testId: 'epic:23' }), null)
  assert.equal(tabsOf(view)[0], 'К запуску · 5')
})

test('a release milestone shows its open epics or that it is ready to close', async () => {
  const release = (id: number, title: string, open_epics: number, ready_to_close = false) =>
    milestone(id, title, id, { is_release: true, open_epics, ready_to_close })
  const milestones = [
    release(1, 'One open', 1),
    release(2, 'Two open', 2),
    release(3, 'Five open', 5),
    release(4, 'Twenty one open', 21),
    release(5, 'Twelve open', 12),
    release(6, 'Ready', 0, true),
    milestone(7, 'Not a release', 7, { open_epics: 3 })
  ]
  const { host } = stub({ 'epics.list': () => ok({ project: HANDLE, epics: milestones.map((m, i) => epic(30 + i, m)) }) })
  view = await mount(panel, { host })
  const said = Object.fromEntries(milestones.map((m) => [m.title, view?.find({ testId: `release:${m.id}` })?.text ?? null]))
  assert.deepEqual(said, {
    'One open': 'Выпуск · 1 эпик открыт',
    'Two open': 'Выпуск · 2 эпика открыто',
    'Five open': 'Выпуск · 5 эпиков открыто',
    'Twenty one open': 'Выпуск · 21 эпик открыт',
    'Twelve open': 'Выпуск · 12 эпиков открыто',
    Ready: 'Выпуск · готова к закрытию',
    // A milestone that is not a release says nothing of its epics.
    'Not a release': null
  })
})

test('the epic row tells not started and in progress from conport counts, ready to merge from the readiness entry', async () => {
  const list: EpicList = {
    project: HANDLE,
    epics: [
      epic(40, null, { progress: { open: 7, total: 7 } }),
      epic(41, null, { progress: { open: 1, total: 1 } }),
      // IN_PROGRESS with no task closed yet, and TODO with one closed: both in progress.
      epic(42, null, { status: 'IN_PROGRESS', progress: { open: 4, total: 4 } }),
      epic(43, null, { progress: { open: 18, total: 26 } }),
      // Every task closed, and no entry of the core that the epic is ready: still in progress.
      epic(44, null, { status: 'IN_PROGRESS', progress: { open: 0, total: 6 } }),
      // No task at all is not ready to merge.
      epic(45, null, { progress: { open: 0, total: 0 } }),
      // The core found it ready to merge.
      epic(46, null, { progress: { open: 0, total: 5 }, ready: true })
    ]
  }
  const { host } = stub({ 'epics.list': () => ok(list) })
  view = await mount(panel, { host })
  const row = (id: number) => view?.find({ testId: `epic:${id}` })
  assert.deepEqual(
    [40, 41, 42, 43, 44, 45, 46].map((id) => row(id)?.props.description),
    [
      'Не начат · 7 задач',
      'Не начат · 1 задача',
      'В работе · 0 из 4 закрыто',
      'В работе · 8 из 26 закрыто',
      'В работе · 6 из 6 закрыто',
      'Не начат · 0 задач',
      'Готов к вливанию · 5 из 5 закрыто'
    ]
  )
  // Only an epic in progress draws the share of closed tasks.
  const bars = view.findAll({ type: 'Progress' }).map((p) => [p.props.label, p.props.value])
  assert.deepEqual(bars, [
    ['Закрыто 0 из 4', 0],
    ['Закрыто 8 из 26', 31],
    ['Закрыто 6 из 6', 100]
  ])
  // The state comes from ConPort, not from the run the CLI records: nothing names a phase.
  assert.doesNotMatch(textOf(view), /идёт|остановлен|подготовка/)
})

test('opening an epic reads its run once and offers start, stop or continue', async () => {
  const runs: Record<number, EpicStatus> = {
    15: idle(15),
    7: RUNNING,
    16: { ...STOPPED, epic: 16 },
    17: { ...FAILED, epic: 17 },
    18: { ...RUNNING, epic: 18, phase: 'ready', outcome: { kind: 'ready', head: 'abc123' } }
  }
  const list: EpicList = {
    project: HANDLE,
    epics: [
      epic(15, RELEASE, { title: 'Offline mode', progress: { open: 7, total: 7 } }),
      epic(7, RELEASE, { title: 'Search by meaning', status: 'IN_PROGRESS', progress: { open: 8, total: 26 } }),
      epic(16, null),
      epic(17, null),
      epic(18, null, { progress: { open: 0, total: 3 } })
    ]
  }
  const roles = { implementer: 'claude', reviewer: 'codex', gapHunter: 'claude', finalReviewer: 'claude' }
  const { host, calls } = stub({
    'epics.list': () => ok(list),
    'agents.get': () => ok({ agents: AGENTS.agents, chosen: roles }),
    'run.get': (input: { epic: number }) => ok(runs[input.epic])
  })
  view = await mount(panel, { host })
  const v = view

  // Not started: the team and Запустить.
  await v.press({ testId: 'epic:15' })
  assert.deepEqual(inputsOf(calls, 'run.get'), [{ project: HANDLE, root: ROOT, epic: 15 }])
  assert.ok(v.find({ text: '← Эпики' }))
  assert.equal(v.find({ testId: 'epic-kicker' })?.text, '15 · Release 2.4')
  assert.equal(headingOf(v, 2), 'Offline mode')
  assert.deepEqual(v.findAll({ type: 'Badge' }).map((b) => b.text), ['Спецификация', 'План'])
  assert.equal(v.find({ testId: 'epic-state' })?.text, 'Не начат · 7 задач')
  assert.equal(headingOf(v, 3), 'Команда')
  assert.match(textOf(v), /запомнится для проекта/)
  assert.deepEqual(['Исполнитель', 'Проверяющий', 'Поиск пробелов', 'Итоговая проверка'].map((label) => v.find({ label })?.props.value), ['claude', 'codex', 'claude', 'claude'])
  assert.match(
    textOf(v),
    /Агенты работают с правами из настроек Orca и самих агентов, в ветке эпика; в основную ветку вливаете вы\. Состояние агентов и их вопросы — в Orca\. Агент, который спрашивает разрешение на каждую команду, будет останавливать работу над эпиком, пока вы ему не ответите\./
  )
  assert.ok(v.find({ text: 'Запустить' }))
  assert.match(textOf(v), /Агенты начнут работу в терминале Orca, в репозитории Shop/)
  assert.equal(v.find({ text: 'Остановить агентов' }), null)

  // Agents at work: a card that sends to Orca, and Stop.
  await v.press({ text: '← Эпики' })
  await v.press({ testId: 'epic:7' })
  assert.match(textOf(v), /Агенты работают над эпиком/)
  assert.match(textOf(v), /Состояние и вопросы агентов — в Orca: в списке проектов и на панели агентов\. Там же отвечайте на вопросы\./)
  assert.match(textOf(v), /Команда: Claude Code · Codex · Claude Code · Claude Code/)
  assert.ok(v.find({ text: 'Остановить агентов' }))
  assert.match(textOf(v), /Сделанное останется в ветке эпика; «Продолжить» запустит агентов снова с того же места/)
  assert.equal(v.find({ text: 'Запустить' }), null)
  assert.equal(v.find({ testId: 'epic-state' })?.text, 'В работе · 18 из 26 закрыто')

  // Stopped, or held on a failure: Продолжить.
  for (const id of [16, 17]) {
    await v.press({ text: '← Эпики' })
    await v.press({ testId: `epic:${id}` })
    assert.ok(v.find({ text: 'Продолжить' }), String(id))
    assert.equal(v.find({ text: 'Запустить' }), null, String(id))
  }

  // Ready to merge: the line, no start.
  await v.press({ text: '← Эпики' })
  await v.press({ testId: 'epic:18' })
  assert.match(v.find({ testId: 'run-ready' })?.text ?? '', /^Готов к вливанию/)
  assert.equal(v.find({ text: 'Запустить' }), null)
  assert.equal(v.find({ text: 'Продолжить' }), null)
  assert.equal(v.find({ text: 'Остановить агентов' }), null)

  // Each opening read the run once, and nothing else read it: no timer, no event.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual((inputsOf(calls, 'run.get') as Array<{ epic: number }>).map((r) => r.epic), [15, 7, 16, 17, 18])
  assert.deepEqual(v.errors, [])
  assert.deepEqual(v.warnings, [])
})

test('start sends the chosen roles and says where the agents work', async () => {
  const { host, calls } = stub({ 'run.start': () => ok({ terminalId: 't', command: 'npx …' }) })
  view = await mount(panel, { host, persisted: at(15) })
  await view.select({ label: 'Исполнитель' }, 'codex')
  await view.press({ text: 'Запустить' })
  assert.deepEqual(inputsOf(calls, 'run.start'), [
    {
      project: HANDLE,
      root: ROOT,
      epic: 15,
      roles: { implementer: 'codex', reviewer: 'claude', gapHunter: 'claude', finalReviewer: 'claude' }
    }
  ])
  assert.match(textOf(view), /в терминале «conport epic 15» репозитория «Shop»/)
  // An agent whose command is not on this machine cannot be chosen.
  const options = view.find({ label: 'Проверяющий' })?.props.options as Array<{ value: string; disabled?: boolean }>
  assert.equal(options.find((o) => o.value === 'gemini')?.disabled, true)
})

test('a started epic offers no second start until its run is read again', async () => {
  const { host, calls } = stub({ 'run.start': () => ok({ terminalId: 't', command: 'npx …' }) })
  view = await mount(panel, { host, persisted: at(15) })
  await view.press({ text: 'Запустить' })
  // A second press would open a second terminal with the same run.
  assert.equal(view.find({ text: 'Запустить' })?.props.disabled, true)
  assert.equal(inputsOf(calls, 'run.start').length, 1)
  // The next read of the run brings the button back.
  await view.press({ label: 'Обновить' })
  assert.equal(inputsOf(calls, 'run.get').length, 2)
  assert.equal(view.find({ text: 'Запустить' })?.props.disabled, false)
  // So does opening the epic again, which reads its run.
  await view.press({ text: 'Запустить' })
  await view.press({ text: '← Эпики' })
  await view.press({ testId: 'epic:15' })
  assert.equal(view.find({ text: 'Запустить' })?.props.disabled, false)
  assert.equal(inputsOf(calls, 'run.start').length, 2)
})

test('a refused start leaves the button to try again', async () => {
  const { host, calls } = stub({ 'run.start': () => ({ ok: false, error: { code: 'root_not_open', message: 'корень репозитория /repo не открыт в Orca', action: 'добавьте репозиторий в Orca' } }) })
  view = await mount(panel, { host, persisted: at(15) })
  await view.press({ text: 'Запустить' })
  assert.equal(view.find({ text: 'Запустить' })?.props.disabled, false)
  await view.press({ text: 'Запустить' })
  assert.equal(inputsOf(calls, 'run.start').length, 2)
})

test('an agent that is not found names the one thing to do, and the refresh it names reads the agents again', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host, persisted: at(15) })
  const note = view.find({ testId: 'agents-missing' })
  assert.equal(note?.text, `«не найден» — ${AGENT_MISSING_ACTION}`)
  assert.equal(view.find({ text: /Агенты не найдены/ }), null)
  await view.press({ label: 'Обновить' })
  assert.equal(calls.filter((c) => c.name === 'agents.get').length, 2)
})

test('with no agent found the warning names the same one thing to do', async () => {
  const none = AGENTS.agents.map((a) => ({ ...a, found: false }))
  const { host } = stub({ 'agents.get': () => ok({ agents: none, chosen: null }) })
  view = await mount(panel, { host, persisted: at(15) })
  const warning = view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Агенты не найдены')
  assert.ok(warning?.text.endsWith(AGENT_MISSING_ACTION), warning?.text)
  // One place names the action, not two.
  assert.equal(view.find({ testId: 'agents-missing' }), null)
})

test('with every agent found nothing is said about missing ones', async () => {
  const all = AGENTS.agents.map((a) => ({ ...a, found: true }))
  const { host } = stub({ 'agents.get': () => ok({ agents: all, chosen: null }) })
  view = await mount(panel, { host, persisted: at(15) })
  assert.equal(view.find({ testId: 'agents-missing' }), null)
  assert.equal(textOf(view).includes(AGENT_MISSING_ACTION), false)
})

test('stop asks once more, and stopped agents can be continued', async () => {
  const { host, calls } = stub({ 'run.stop': () => ok(STOPPED), 'run.start': () => ok({ terminalId: 't', command: 'npx …' }) })
  view = await mount(panel, { host, persisted: at(7) })
  await view.press({ text: 'Остановить агентов' })
  assert.equal(calls.filter((c) => c.name === 'run.stop').length, 0)
  await view.press({ text: 'Да, остановить' })
  assert.deepEqual(inputsOf(calls, 'run.stop'), [{ project: HANDLE, root: ROOT, epic: 7 }])
  assert.equal(view.find({ text: 'Остановить агентов' }), null)
  await view.press({ text: 'Продолжить' })
  assert.equal(inputsOf(calls, 'run.start').length, 1)
})

test('held agents can be continued or stopped', async () => {
  const held: EpicStatus = { ...RUNNING, phase: 'held', outcome: { kind: 'held', reasons: [`task-${13} is IN_PROGRESS outside this run`] } }
  const { host, calls } = stub({ 'run.get': () => ok(held), 'run.stop': () => ok(STOPPED) })
  view = await mount(panel, { host, persisted: at(7) })
  assert.ok(view.find({ text: 'Продолжить' }))
  assert.match(textOf(view), /· задача 13 в статусе IN_PROGRESS вне работы этих агентов/)
  await view.press({ text: 'Остановить агентов' })
  await view.press({ text: 'Да, остановить' })
  assert.equal(calls.filter((c) => c.name === 'run.stop').length, 1)
})

/** The box of held agents of epic 7 for this failure, as drawn, and the whole panel. */
async function failureBox(failure: { code: string; message: string; action: string }): Promise<{ box: string; all: string }> {
  const { host } = stub({ 'run.get': () => ok({ ...FAILED, failure }) })
  view = await mount(panel, { host, persisted: at(7) })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Агенты остановились')
  assert.ok(box, `no failure box in ${textOf(view)}`)
  assert.ok(view.find({ text: 'Продолжить' }))
  const drawn = { box: JSON.stringify(box), all: textOf(view) }
  await view.unmount()
  view = undefined
  return drawn
}

test('held agents say why they stopped and the one action by the code of the failure', async () => {
  assert.ok(FAILED.failure)
  const { box, all } = await failureBox(FAILED.failure)
  assert.match(box, /гейт красный на голове ветки эпика ещё до запуска/)
  assert.match(box, /Что сделать: сделайте гейт зелёным на ветке эпика и нажмите «Продолжить»/)
  assert.match(box, /gate_red/)
  // The English of the CLI never reaches the panel.
  assert.doesNotMatch(all, /the gate is red|make the gate green/)
})

test('a failure of a code the panel does not know names the terminal of the agents', async () => {
  const { box, all } = await failureBox({ code: 'brand_new_refusal', message: 'something new broke', action: 'do the new thing' })
  assert.match(box, /агенты остановились по причине, которой панель не знает/)
  assert.match(box, /Что сделать: посмотрите вывод в терминале «conport epic 7» корня репозитория и нажмите «Продолжить»/)
  assert.match(box, /brand_new_refusal/)
  assert.doesNotMatch(all, /something new broke|do the new thing/)
})

test('every failure the cli records is said in russian, an http status by its class', () => {
  const unknown = failureText('brand_new_refusal', 7)
  // The codes `conport epic run` can keep in its record.
  const recorded = [
    'gate_red', 'epic_worktree_dirty', 'epic_held', 'run_mismatch', 'no_spec', 'no_plan', 'several_specs',
    'several_plans', 'plan_unparsable', 'section_without_task', 'task_without_section', 'no_gate_object',
    'gate_dir_outside', 'dependency_cycle', 'not_an_epic', 'no_project', 'project_not_found', 'no_api_key',
    'conport_unreachable', 'host_unavailable', 'runtime_unavailable', 'runtime_timeout', 'worktree_list_truncated',
    'unexpected_answer', 'record_busy', 'invalid_argument', 'no_cli_version'
  ]
  for (const code of recorded) {
    const text = failureText(code, 7)
    assert.notDeepEqual(text, unknown, code)
    assert.match(text.what, /[а-яё]/, code)
    assert.match(text.action, /[а-яё]/, code)
  }
  assert.equal(failureText('http_401', 7).what, 'ConPort не принял ключ API')
  assert.equal(failureText('http_403', 7).what, 'ConPort не принял ключ API')
  assert.equal(failureText('http_500', 7).what, 'ConPort ответил ошибкой')
  assert.equal(failureText('http_503', 7).what, 'ConPort ответил ошибкой')
  // Below the server errors and besides the key, a status says nothing the panel can act on.
  assert.deepEqual(failureText('http_499', 7), unknown)
  assert.deepEqual(failureText('http_404', 7), unknown)
})

test('what holds an epic is said in russian, a reason the panel does not know names the terminal', async () => {
  const t = (n: number): string => `task-${n}`
  const reasons = [
    [`${t(13)} is IN_PROGRESS outside this run`, 'задача 13 в статусе IN_PROGRESS вне работы этих агентов'],
    [`${t(14)} is TODO`, 'задача 14 в статусе TODO'],
    [`${t(16)}: the person is asked (stop-list case 1, no gate in the host: answer it with conport epic answer 7 --task 16 --choice <option>)`, 'задача 16: вопрос к человеку, случай стоп-листа «Нужна необратимая операция»'],
    ['the epic: the person is asked (stop-list case 4, term_7)', 'эпик: вопрос к человеку, случай стоп-листа «Эпик вырос больше чем на 30%»'],
    [`${t(17)} waits for the epic's question`, 'задача 17 ждёт ответа на вопрос эпика'],
    [`${t(17)} waits for ${t(12)}, ${t(16)}`, 'задача 17 ждёт задач 12, 16'],
    ['the gate is red on the head of feature-branch:\nnpm test failed', 'гейт красный на голове ветки эпика'],
    ['the gate is red on feature-branch with main merged in:\nnpm test failed', 'гейт красный на ветке эпика после слияния main'],
    [`plan section 3 «Search page» has no closed task: ${t(14)} left the epic`, 'у раздела плана 3 «Search page» нет закрытой задачи: задача 14 ушла из эпика'],
    ['merging main into feature-branch conflicts in a.ts, b.ts', 'слияние main в ветку эпика даёт конфликт в a.ts, b.ts'],
    ['the trial merge of main could not run: git exploded', 'пробное слияние main в ветку эпика не запустилось'],
    [`no run of epic ${t(7)} is going: start it again with conport epic run 7`, 'агенты эпика не работают: нажмите «Продолжить»'],
    ['a reason worded in a later version', 'причина, которой панель не знает: посмотрите вывод в терминале «conport epic 7» корня репозитория']
  ] as const
  const held: EpicStatus = { ...FAILED, failure: null, outcome: { kind: 'held', reasons: reasons.map(([english]) => english) } }
  const { host } = stub({ 'run.get': () => ok(held) })
  view = await mount(panel, { host, persisted: at(7) })
  const said = view.findAll({ type: 'Text' }).map((x) => x.text).filter((x) => x.startsWith('· '))
  assert.deepEqual(said, reasons.map(([, russian]) => `· ${russian}`))
  assert.doesNotMatch(textOf(view), /outside this run|the person is asked|waits for|is red|left the epic|conflicts in|could not run|is going|later version/)
})

test('a question orca did not take is said as what the epic waits for, with the command that answers it', async () => {
  const command = (task: string) => `npx -y conport@${CLI_VERSION} epic answer 7${task} --choice '<вариант>' --project ${HANDLE}`
  const status = `npx -y conport@${CLI_VERSION} epic status 7 --project ${HANDLE}`
  const waits = (v: TestPanel) => v.findAll({ type: 'Callout' }).filter((c) => c.props.title === 'Эпик ждёт вашего ответа')
  const asked = { text: 'needs DROP TABLE users', options: ['allow', 'forbid'] }
  const runs: EpicStatus[] = [
    { ...RUNNING, questions: [{ task: 12, case: 1, ...asked, refused: true }, { task: 13, case: 1, ...asked, refused: false }] },
    { ...FAILED, failure: null, questions: [{ task: null, case: 4, ...asked, refused: true }] },
    { ...RUNNING, questions: [{ task: 13, case: 1, ...asked, refused: false }] }
  ]
  const said: string[][] = []
  for (const run of runs) {
    const { host } = stub({ 'run.get': () => ok(run) })
    view = await mount(panel, { host, persisted: at(7) })
    said.push(waits(view).map((c) => c.text))
    // The question itself is Orca's to show, or the terminal's: never the panel's.
    assert.doesNotMatch(textOf(view), /DROP TABLE|forbid/)
    await view.unmount()
    view = undefined
  }
  const box = (about: string, task: string, then: string) =>
    `Эпик ждёт вашего ответа Orca не приняла вопрос по ${about}, и в Orca его нет. ` +
    `Что сделать: ответьте на него в терминале репозитория командой ниже${then} ${command(task)} ` +
    `Вопрос и варианты ответа печатает команда ${status}`
  assert.deepEqual(said, [
    // Agents at work take the answer themselves.
    [box('задаче 12', ' --task 12', '')],
    // Held agents take it once continued: the question stays in their record until then.
    [box('эпику', '', ', затем нажмите «Продолжить»')],
    // A question in Orca's gate is answered there: the panel says nothing of it.
    []
  ])
})

test('held agents without a failure show the reasons and no failure box', async () => {
  const { host } = stub({ 'run.get': () => ok({ ...FAILED, failure: null }) })
  view = await mount(panel, { host, persisted: at(7) })
  assert.match(textOf(view), /Эпик держат/)
  assert.doesNotMatch(textOf(view), /Агенты остановились/)
})

test('a missing api key shows the cli refusal in the panel', async () => {
  const { host } = stub({ 'epics.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  // Said in Russian by the code of the refusal, with its one action; the CLI's English never shows.
  assert.equal(box?.props.title, 'нет ключа API ConPort')
  assert.ok(box?.text.includes('впишите CONPORT_API_KEY в ~/.config/conport/.env и повторите'), box?.text)
  assert.match(JSON.stringify(box), /no_api_key/)
  assert.doesNotMatch(textOf(view), /is not set|put CONPORT_API_KEY/)
})

/** The words for a refusal the panel does not know: they name no program, it may be conport or orca. */
const UNKNOWN_WHAT = 'программа отказала по причине, которой панель не знает'
const UNKNOWN_ACTION = 'нажмите «Обновить»; если отказ повторится, обновите плагин и Orca'

test('every refused action says russian: the cli by its code, the worker in its own words', async () => {
  const refusals: Array<[{ code: string; message: string; action: string }, string, string]> = [
    // A CLI code the panel knows, from any of the actions.
    [{ code: 'no_run', message: 'no run of epic 15 is recorded', action: 'start it' }, 'агенты над эпиком не запускались', 'нажмите «Запустить»'],
    [{ code: 'conport_unreachable', message: 'ConPort did not answer (fetch failed)', action: 'check the network and run the command again' }, 'ConPort не ответил', 'проверьте сеть и повторите'],
    [{ code: 'http_502', message: 'ConPort answered 502: bad gateway', action: 'run the command again in a few minutes' }, 'ConPort ответил ошибкой', 'подождите несколько минут и повторите'],
    // A CLI code it does not know, and a line of the error stream.
    [{ code: 'brand_new_refusal', message: 'something new broke', action: 'do the new thing' }, UNKNOWN_WHAT, UNKNOWN_ACTION],
    [{ code: 'cli_failed', message: 'TypeError: boom', action: '' }, UNKNOWN_WHAT, UNKNOWN_ACTION],
    // A program that could not start: named, without the error of Node.
    [{ code: 'spawn_failed', message: 'npx: spawn npx ENOENT', action: 'установите Node.js и сделайте npx видимым в PATH приложения Orca' }, 'не удалось запустить npx', 'установите Node.js и сделайте npx видимым в PATH приложения Orca'],
    // The worker's own refusal is Russian already: shown as it is.
    [{ code: 'root_not_open', message: 'корень репозитория /repo не открыт в Orca', action: 'добавьте репозиторий в Orca' }, 'корень репозитория /repo не открыт в Orca', 'добавьте репозиторий в Orca']
  ]
  for (const [error, what, action] of refusals) {
    const { host } = stub({ 'run.start': () => ({ ok: false, error }) })
    view = await mount(panel, { host, persisted: at(15) })
    await view.press({ text: 'Запустить' })
    const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
    assert.equal(box?.props.title, what, error.code)
    assert.match(JSON.stringify(box), new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), error.code)
    assert.doesNotMatch(textOf(view), /ENOENT/, error.code)
    if (error.code !== 'root_not_open') assert.doesNotMatch(textOf(view), new RegExp(error.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), error.code)
    await view.unmount()
    view = undefined
  }
})

test('a project list orca cannot give is retried from the panel', async () => {
  let answers = 0
  const { host, calls } = stub({
    'projects.list': () =>
      ++answers === 1 ? { ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running', action: '' } } : ok([SHOP])
  })
  view = await mount(panel, { host })
  assert.match(textOf(view), /Orca не ответила/)
  assert.doesNotMatch(textOf(view), /Orca is not running/)
  await view.press({ text: 'Повторить' })
  assert.equal(calls.filter((c) => c.name === 'epics.list').length, 1)
  assert.doesNotMatch(textOf(view), /Orca не ответила/)
})

test('an empty project says so', async () => {
  const { host } = stub({ 'epics.list': () => ok(EMPTY_LIST) })
  view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.equal(view.find({ text: 'Запустить' }), null)
})

test('a project of only epics to prepare says none can be started', async () => {
  const none = { ...EPIC_LIST, epics: EPIC_LIST.epics.filter((e) => !e.runnable) }
  const { host } = stub({ 'epics.list': () => ok(none) })
  view = await mount(panel, { host })
  assert.match(textOf(view), /Ни один эпик не готов к запуску/)
  assert.deepEqual(tabsOf(view), ['К запуску · 0', 'Подготовить · 2', 'Задачи · 5'])
})

const PREPARABLE: EpicList = {
  project: HANDLE,
  epics: [
    ...EPIC_LIST.epics,
    epic(20, null, { title: 'Payments', runnable: false, reason: 'the documents of the epic cannot be read' })
  ]
}

test('the prepare tab offers a spec or a plan by what the epic lacks, in russian', async () => {
  const { host } = stub({ 'epics.list': () => ok(PREPARABLE) })
  view = await mount(panel, { host })
  assert.deepEqual(tabsOf(view), ['К запуску · 2', 'Подготовить · 3', 'Задачи · 5'])
  await tab(view, 'prepare')
  assert.match(textOf(view), /Агент обсудит эпик с вами, напишет спецификацию и план — после этого эпик появится во вкладке «К запуску»\./)
  assert.deepEqual(groupsOf(view), ['Release 2.4', 'Без вехи'])
  const described = Object.fromEntries([9, 10, 20].map((id) => [id, view?.find({ testId: `epic:${id}` })?.props.description]))
  assert.deepEqual(described, { 9: 'Спецификация есть, нет плана', 10: 'Нет спецификации', 20: 'Не готов к запуску по другой причине' })
  assert.equal(view.find({ testId: 'prepare:9' })?.text, 'Написать план')
  assert.equal(view.find({ testId: 'prepare:10' })?.text, 'Подготовить')
  // An epic that cannot run for another reason cannot be prepared.
  assert.equal(view.find({ testId: 'prepare:20' }), null)
  assert.equal(view.find({ testId: 'epic:20' })?.props.disabled, true)
  // The English reason of the CLI never reaches the panel.
  assert.doesNotMatch(textOf(view), /no spec|no plan|cannot be read/)
})

test('an epic without a spec is prepared by the agent chosen in the sheet', async () => {
  const { host, calls } = stub({
    'agents.get': () => ok({ agents: [...AGENTS.agents, { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: true }], chosen: null, preparer: 'codex' }),
    'epic.prepare': () => ok({ terminal: 'term-1' })
  })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:10' })
  // The sheet: what the agent does, and which agent; the one of last time first.
  const sheet = view.find({ testId: 'sheet' })
  assert.equal(sheet?.props.title, 'Подготовить «Audit log»')
  assert.equal(sheet?.props.description, '10 · нет спецификации')
  const steps = view.findAll({ type: 'Row' }).filter((r) => r.key?.startsWith('step:'))
  assert.deepEqual(steps.map((s) => s.text), [
    '1 Обсуждает эпик с вами и пишет спецификацию',
    '2 После вашего «да» выгружает её в ConPort',
    '3 Пишет план, привязывает задачи эпика, импортирует план'
  ])
  const radio = view.find({ label: 'Кто подготовит' })
  assert.equal(radio?.props.value, 'codex')
  assert.deepEqual(radio?.props.options, [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex', description: 'в прошлый раз' },
    { value: 'cursor', label: 'Cursor' }
  ])
  await view.select({ label: 'Кто подготовит' }, 'claude')
  await view.press({ text: 'Открыть в терминале' })
  assert.deepEqual(inputsOf(calls, 'epic.prepare'), [{ project: HANDLE, root: ROOT, epic: 10, agent: 'claude' }])
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.match(textOf(view), /терминале «conport prepare 10» репозитория «Shop»/)
  assert.deepEqual(view.errors, [])
})

test('the sheet of an epic with a spec writes the plan, and Отмена closes it', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Написать план «Archive export»')
  assert.equal(view.find({ testId: 'sheet' })?.props.description, '9 · нет плана')
  // Without the agent of last time the first one found that can prepare.
  assert.equal(view.find({ label: 'Кто подготовит' })?.props.value, 'claude')
  await view.press({ text: 'Отмена' })
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.deepEqual(inputsOf(calls, 'epic.prepare'), [])
})

test('only an agent that takes a positional request is offered in the sheet', async () => {
  const withOpencode = [...AGENTS.agents, { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true }]
  const { host } = stub({ 'agents.get': () => ok({ agents: withOpencode, chosen: null, preparer: 'opencode' }) })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  const radio = view.find({ label: 'Кто подготовит' })
  assert.deepEqual((radio?.props.options as Array<{ value: string }>).map((o) => o.value), ['claude', 'codex'])
  // The one remembered for the project cannot take a task: the first that can is taken.
  assert.equal(radio?.props.value, 'claude')
})

test('with no agent found nothing can be prepared or handed', async () => {
  const none = AGENTS.agents.map((a) => ({ ...a, found: false }))
  const { host } = stub({ 'agents.get': () => ok({ agents: none, chosen: null }) })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  assert.equal(view.find({ testId: 'prepare:9' })?.props.disabled, true)
  assert.match(textOf(view), new RegExp(AGENT_MISSING_ACTION))
  await tab(view, 'tasks')
  assert.equal(view.find({ testId: 'hand:41' })?.props.disabled, true)
  assert.equal(view.find({ testId: 'review:42' })?.props.disabled, true)
})

test('a refused prepare says why in russian and keeps the sheet', async () => {
  const { host } = stub({
    'epic.prepare': () => ({ ok: false, error: { code: 'epic_ready', message: 'эпик 9 уже готов к запуску', action: 'нажмите «Обновить» и запустите его' } })
  })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await view.press({ text: 'Открыть в терминале' })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, 'эпик 9 уже готов к запуску')
  assert.ok(view.find({ testId: 'sheet' }))
})

test('a folder or unbound project offers no prepare', async () => {
  // A folder in focus is never chosen; an unbound project asks for its binding, no epics.
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...NOTES, focused: true }, unfocused(DOCS)]) })
  view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Подготовить' }), null)
  await view.press({ text: 'Привязать' })
  assert.ok(view.find({ label: 'Проект ConPort' }))
  assert.equal(view.find({ type: 'Tabs' }), null)
  assert.deepEqual(inputsOf(calls, 'epics.list'), [])
  assert.deepEqual(inputsOf(calls, 'tasks.list'), [])
})

test('the epics are read again when the panel becomes visible', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  assert.equal(inputsOf(calls, 'epics.list').length, 1)
  await view.setVisible(false)
  assert.equal(inputsOf(calls, 'epics.list').length, 1)
  await view.setVisible(true)
  await until(() => inputsOf(calls, 'epics.list').length === 2)
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'shop-api', root: ROOT })
  // Refresh reads them again too: an epic prepared meanwhile becomes runnable.
  await view.press({ label: 'Обновить' })
  assert.equal(inputsOf(calls, 'epics.list').length, 3)
  assert.equal(inputsOf(calls, 'tasks.list').length, 3)
})

test('a prepare answer for a project left is not drawn in the chosen one', async () => {
  const pending: Array<() => void> = []
  const { host } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'epic.prepare': () => new Promise((resolve) => pending.push(() => resolve(ok({ terminal: 'term-1' }))))
  })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:10' })
  const preparing = view.press({ text: 'Открыть в терминале' })
  await until(() => pending.length === 1)
  await openPicker(view, BILLING.root)
  const toBilling = view.press({ testId: `project:${BILLING.root}` })
  await new Promise((resolve) => setTimeout(resolve, 30))
  pending[0]?.()
  await Promise.all([preparing, toBilling])
  assert.equal(pickerOf(view)?.props.title, 'Billing')
  assert.doesNotMatch(textOf(view), /conport prepare 10/)
})

test('an agent picked by hand in the sheet stays when the panel comes back into view', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await view.select({ label: 'Кто подготовит' }, 'codex')
  await view.press({ text: 'Отмена' })
  await view.setVisible(false)
  await view.setVisible(true)
  await until(() => inputsOf(calls, 'agents.get').length === 2)
  await view.settled()
  await view.press({ testId: 'prepare:10' })
  assert.equal(view.find({ label: 'Кто подготовит' })?.props.value, 'codex')
})

test('an open sheet stays when the panel comes back into view while its task or epic is still listed', async () => {
  let listed = TASK_LIST.tasks
  const { host, calls } = stub({ 'tasks.list': () => ok(listed) })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  await view.press({ testId: 'hand:41' })
  await view.select({ label: 'Кто возьмёт задачу' }, 'codex')
  const away = async (): Promise<void> => {
    const before = inputsOf(calls, 'agents.get').length
    await (view as TestPanel).setVisible(false)
    await (view as TestPanel).setVisible(true)
    await until(() => inputsOf(calls, 'agents.get').length === before + 1)
    await (view as TestPanel).settled()
  }
  await away()
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Отдать агенту «Rotate the backup key»')
  assert.equal(view.find({ label: 'Кто возьмёт задачу' })?.props.value, 'codex')
  // Taken meanwhile: the task is no longer one to hand, the sheet closes.
  listed = TASK_LIST.tasks.map((t) => (t.id === 41 ? { ...t, status: 'IN_PROGRESS' as const } : t))
  await away()
  assert.equal(view.find({ testId: 'sheet' }), null)
  // A sheet of an epic stays while the epic still lacks what it is prepared for, and closes once it can start.
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await away()
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Написать план «Archive export»')
  await view.unmount()
  const ready = { ...EPIC_LIST, epics: EPIC_LIST.epics.map((e) => (e.id === 9 ? { ...e, runnable: true, reason: null } : e)) }
  let epics = EPIC_LIST
  const second = stub({ 'epics.list': () => ok(epics) })
  view = await mount(panel, { host: second.host, persisted: { plugin: { tab: 'prepare' } } })
  await view.press({ testId: 'prepare:9' })
  epics = ready
  const before = inputsOf(second.calls, 'agents.get').length
  await view.setVisible(false)
  await view.setVisible(true)
  await until(() => inputsOf(second.calls, 'agents.get').length === before + 1)
  await view.settled()
  assert.equal(view.find({ testId: 'sheet' }), null)
})

test('choosing another project closes the sheet', async () => {
  const { host } = stub({ 'projects.list': () => ok([SHOP, BILLING]) })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  await view.press({ testId: 'hand:41' })
  await pick(view, BILLING.root)
  assert.equal(view.find({ testId: 'sheet' }), null)
})

test('the tasks tab groups review, in progress and todo by priority', async () => {
  // Out of order as given: the panel lists the todo ones by priority all the same.
  const tasks = [
    { id: 51, title: 'Background chore', status: 'TODO', priority: 5, changes_requested: false },
    { id: 52, title: 'Fix the outage', status: 'TODO', priority: 1, changes_requested: false },
    { id: 53, title: 'Under review', status: 'REVIEW', priority: 4, changes_requested: false },
    { id: 54, title: 'Being done', status: 'IN_PROGRESS', priority: 2, changes_requested: false },
    { id: 55, title: 'Rotate the key', status: 'TODO', priority: 2, changes_requested: false },
    { id: 56, title: 'Simplify', status: 'TODO', priority: 3, changes_requested: false },
    { id: 57, title: 'Hints', status: 'TODO', priority: 4, changes_requested: false },
    { id: 58, title: 'Back from review', status: 'IN_PROGRESS', priority: 3, changes_requested: true }
  ]
  const { host } = stub({ 'tasks.list': () => ok(tasks) })
  view = await mount(panel, { host })
  assert.equal(tabsOf(view)[2], 'Задачи · 8')
  await tab(view, 'tasks')
  assert.deepEqual(groupsOf(view), ['Ждут проверки', 'В работе', 'К выполнению · по приоритету'])
  const rows = (label: string) => itemsIn(view as TestPanel, label)
  assert.deepEqual(rows('Ждут проверки'), [['53 · Under review', 'На проверке']])
  assert.deepEqual(rows('В работе'), [
    ['54 · Being done', 'В работе'],
    ['58 · Back from review', 'Ждёт исправлений после проверки']
  ])
  // A task the review sent back is fixed by an agent; one an agent is at is its own.
  assert.equal(view.find({ testId: 'fix:58' })?.text, 'Исправить')
  assert.equal(view.find({ testId: 'fix:54' }), null)
  assert.deepEqual(rows('К выполнению · по приоритету'), [
    ['52 · Fix the outage', 'Критический · не начата'],
    ['55 · Rotate the key', 'Высокий · не начата'],
    ['56 · Simplify', 'Средний · не начата'],
    ['57 · Hints', 'Низкий · не начата'],
    ['51 · Background chore', 'Фоновый · не начата']
  ])
  // Review asks for a check, todo for an agent; a task in progress is the agent's own.
  assert.equal(view.find({ testId: 'review:53' })?.text, 'Проверить')
  assert.equal(view.find({ testId: 'hand:52' })?.text, 'Отдать агенту')
  assert.equal(view.find({ testId: 'hand:54' }), null)
  assert.equal(view.find({ testId: 'review:54' }), null)
})

test('a task is handed to the agent chosen in the sheet, to do, to review or to fix', async () => {
  const sentBack = TASK_LIST.tasks.map((t) => (t.id === 43 ? { ...t, changes_requested: true } : t))
  const { host, calls } = stub({
    'agents.get': () => ok({ agents: AGENTS.agents, chosen: null, preparer: 'codex' }),
    'tasks.list': () => ok(sentBack),
    'task.hand': () => ok({ terminal: 'term-1' })
  })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  await view.press({ testId: 'hand:41' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Отдать агенту «Rotate the backup key»')
  assert.equal(view.find({ label: 'Кто возьмёт задачу' })?.props.value, 'codex')
  // The agent works on a branch of its own and commits there; merging it is the person's.
  assert.match(textOf(view), /Делает её в своей ветке, в отдельной рабочей копии рядом с репозиторием, проверяет и фиксирует коммитами/)
  await view.press({ text: 'Открыть в терминале' })
  assert.match(textOf(view), /Работа ляжет в отдельную ветку задачи, вливаете её вы\./)
  await view.press({ testId: 'review:42' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Проверить «Compare the metrics after the release»')
  // The reviewer checks that branch, and closes the task it approves only with the person's yes.
  assert.match(textOf(view), /Проверяет ветку из отчёта/)
  assert.match(textOf(view), /при одобрении с вашего согласия закрывает задачу/)
  await view.select({ label: 'Кто проверит' }, 'claude')
  await view.press({ text: 'Открыть в терминале' })
  assert.match(textOf(view), /терминале «conport review 42» репозитория «Shop»: агент запишет вердикт в журнал задачи и при одобрении с вашего согласия закроет её/)
  // A task the review sent back: the agent goes on in its branch with the findings of the review.
  await view.press({ testId: 'fix:43' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Исправить «Check the backups»')
  assert.match(textOf(view), /Продолжает в ветке задачи, исправляет и фиксирует коммитами/)
  await view.select({ label: 'Кто исправит' }, 'codex')
  await view.press({ text: 'Открыть в терминале' })
  assert.match(textOf(view), /Исправления задачи 43 открыты в терминале «conport fix 43» репозитория «Shop»/)
  assert.deepEqual(inputsOf(calls, 'task.hand').at(-1), { project: HANDLE, root: ROOT, task: 43, agent: 'codex', mode: 'fix' })
  assert.deepEqual(inputsOf(calls, 'task.hand').slice(0, 2), [
    { project: HANDLE, root: ROOT, task: 41, agent: 'codex', mode: 'do' },
    { project: HANDLE, root: ROOT, task: 42, agent: 'claude', mode: 'review' }
  ])
})

test('a task list the cli cannot give is said in the tasks tab only', async () => {
  const { host } = stub({ 'tasks.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  assert.deepEqual(tabsOf(view), ['К запуску · 2', 'Подготовить · 2', 'Задачи'])
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.tone === 'danger').length, 0)
  await tab(view, 'tasks')
  assert.equal(view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')?.props.title, 'нет ключа API ConPort')
})

const SOURCES = join(dirname(fileURLToPath(import.meta.url)))

test('no panel text says прогон', async () => {
  // Nothing the panel or the worker can show says it: the sources hold no such word.
  for (const file of ['panel.tsx', 'text.ts', 'worker.ts', 'cli.ts']) {
    assert.doesNotMatch(readFileSync(join(SOURCES, file), 'utf8'), /прогон/i, file)
  }
  // Nor does any screen drawn: each tab, the epic in each state, the sheet.
  const screens: string[] = []
  const runs: EpicStatus[] = [idle(7), RUNNING, STOPPED, FAILED, { ...FAILED, failure: null }, { ...RUNNING, phase: 'ready', outcome: { kind: 'ready', head: 'abc' } }]
  for (const run of runs) {
    const { host } = stub({ 'run.get': () => ok(run) })
    view = await mount(panel, { host, persisted: at(7) })
    screens.push(textOf(view))
    await view.press({ text: '← Эпики' })
    for (const value of ['launch', 'prepare', 'tasks'] as const) {
      await tab(view, value)
      screens.push(textOf(view))
    }
    await view.press({ testId: 'hand:41' })
    screens.push(textOf(view))
    await view.unmount()
    view = undefined
  }
  for (const screen of screens) assert.doesNotMatch(screen, /прогон/i)
})
