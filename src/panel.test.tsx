// The panel over a worker that answers from the fake conport and orca executables, or over
// stubbed requests where only the panel is under test.
// The assert of orca/testing is Node's, but its typings leave doesNotMatch out.
import { doesNotMatch } from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, assert, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import {
  AGENTS,
  CURSOR,
  EMPTY_LIST,
  EPIC_LIST,
  EPIC_TASKS,
  HANDLE,
  NO_KEY,
  session,
  SESSION_ALIVE,
  SESSION_COPY,
  SESSION_WORKFLOW,
  SUBAGENTS,
  TASK_LIST,
  untyped
} from '../test/fixtures'
import { fake, json, until } from '../test/fake'
import * as panel from './panel'
import type { EpicList, EpicSummary, Milestone, OrcaProject, Result } from './protocol'
import * as text from './text'
import { refusalText } from './text'

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

const ROOT = '/repo'
const ok = <T,>(data: T): Result<T> => ({ ok: true, data })
const SHOP: OrcaProject = { name: 'Shop', root: ROOT, kind: 'git', project: 'shop-api', source: 'repository', lines: [], filesRead: true, focused: true }
const BILLING: OrcaProject = { name: 'Billing', root: '/billing', kind: 'git', project: 'billing-api', source: 'stored', lines: [], filesRead: true, focused: false }
const NOTES: OrcaProject = { name: 'Notes', root: '/notes', kind: 'folder', project: null, source: null, lines: [], filesRead: false, focused: false }
const DOCS: OrcaProject = { name: 'Docs', root: '/docs', kind: 'git', project: null, source: null, lines: [], filesRead: true, focused: false }
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
    'agents.get': () => ok(AGENTS),
    'epic.session': () => ok(session()),
    'epic.tasks': () => ok(EPIC_TASKS),
    'subagents.get': (input: { harness: string }) => ok(input.harness === 'claude' ? SUBAGENTS : untyped(input.harness))
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
  await v.select({ label: 'Sections' }, value)
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
  const names = ['projects.list', 'epics.list', 'tasks.list', 'agents.get']
  view = await mount(panel, { host: mockHost({ requests: Object.fromEntries(names.map((n) => [n, forward(n)])) as never }) })

  const calls = f.conportCalls()
  assert.deepEqual(calls.find((c) => c[0] === 'epic' && c[1] === 'list'), ['epic', 'list', '--project', 'shop-api', '--json'])
  assert.deepEqual(calls.find((c) => c[0] === 'task'), ['task', 'list', '--project', 'shop-api', '--json'])
  assert.deepEqual(tabsOf(view), ['Ready to run · 2', 'Prepare · 2', 'Tasks · 5'])
  assert.deepEqual(groupsOf(view), ['Release 2.4', 'No milestone'])
  // The list reads nothing of an epic: its tasks and its subagent types are read when it is opened.
  assert.deepEqual(calls.filter((c) => c[0] === 'api' || c[1] === 'subagents' || c[1] === 'status'), [])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await worker.deactivate()
})

test('projects follow the orca repo list order and names', async () => {
  const { host } = stub({ 'projects.list': () => ok([unfocused(BILLING), SHOP, NOTES, DOCS]) })
  view = await mount(panel, { host })
  // The picker names the chosen project as Orca shows it, never by its handle.
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  assert.equal(pickerOf(view)?.props.description, 'ConPort · shop-api')
  assert.equal(view.find({ type: 'List', label: 'Projects' }), null)
  await view.toggle({ testId: 'project-picker' })
  assert.ok(view.find({ type: 'List', label: 'Projects' }), textOf(view))
  assert.match(textOf(view), /Orca projects, in sidebar order/)
  const items = view.findAll({ type: 'ListItem' }).filter((i) => i.key?.startsWith('project:'))
  assert.deepEqual(items.map((i) => i.props.title), ['Billing', 'Shop', 'Notes', 'Docs'])
  assert.deepEqual(items.map((i) => i.props.description), [
    'ConPort · billing-api',
    'ConPort · shop-api · in focus',
    'Folder without git — nothing to run',
    'No ConPort project'
  ])
  doesNotMatch(textOf(view), new RegExp(HANDLE))
})

test('the project search narrows the list by name', async () => {
  const { host } = stub({ 'projects.list': () => ok([unfocused(BILLING), SHOP, NOTES, DOCS]) })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  await view.type({ label: 'Find project' }, 'bil')
  const items = view.findAll({ type: 'ListItem' }).filter((i) => i.key?.startsWith('project:'))
  assert.deepEqual(items.map((i) => i.props.title), ['Billing'])
  // Choosing a project closes the picker.
  await view.press({ testId: `project:${BILLING.root}` })
  assert.equal(view.find({ type: 'List', label: 'Projects' }), null)
  assert.equal(pickerOf(view)?.props.title, 'Billing')
})

test('a project bound by its handle is not named by it in the picker', async () => {
  const { host } = stub({ 'projects.list': () => ok([{ ...SHOP, project: HANDLE }]) })
  view = await mount(panel, { host })
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  await view.toggle({ testId: 'project-picker' })
  doesNotMatch(textOf(view), new RegExp(HANDLE))
})

test('a project without a binding offers to bind it', async () => {
  let docs = DOCS
  const { host, calls } = stub({
    'projects.list': () => ok([SHOP, docs]),
    'project.set': (input: { root: string; project: string }) => {
      docs = { ...docs, project: input.project, source: 'stored' }
      return ok({ root: input.root, project: input.project, source: 'stored', lines: [], filesRead: true })
    }
  })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  // Only the project without a binding offers it.
  assert.equal(view.findAll({ text: 'Bind' }).length, 1)
  await view.press({ text: 'Bind' })
  assert.equal(pickerOf(view)?.props.title, 'Docs')
  await view.type({ label: 'ConPort project' }, 'docs-api', { submit: true })
  assert.deepEqual(inputsOf(calls, 'project.set'), [{ root: DOCS.root, project: 'docs-api' }])
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'docs-api', root: DOCS.root })
  assert.equal(view.find({ text: 'Bind' }), null)
})

test('the bind card names .conport.json', async () => {
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...DOCS, focused: true }]) })
  view = await mount(panel, { host })
  const card = view.find({ type: 'Card', label: 'ConPort project' })
  assert.equal(
    card?.props.description,
    'The repository has no .conport.json with project_name. Name the project once — the panel remembers it for this repository.'
  )
  doesNotMatch(textOf(view), /settings\.local\.json|CONPORT_PROJECT_NAME/)
  assert.deepEqual(inputsOf(calls, 'epics.list'), [])
})

test('the bind card of a submodule says its settings files are not read', async () => {
  const { host } = stub({ 'projects.list': () => ok([{ ...DOCS, focused: true, filesRead: false }]) })
  view = await mount(panel, { host })
  assert.equal(
    view.find({ type: 'Card', label: 'ConPort project' })?.props.description,
    'This repository is a submodule or a worktree of a bare repository: ConPort settings files are not read here. Bind a project below.'
  )
  // The binding is offered all the same: it is the only way to name the project there.
  assert.ok(view.find({ type: 'Input', label: 'ConPort project' }))
})

test('settings lines are shown with the project', async () => {
  const LINES = [
    'units is read from .conport.json only',
    'CONPORT_PROJECT_NAME in ~/.config/conport/.env is not read: it would apply to every repository — remove it'
  ]
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...SHOP, source: 'file', lines: LINES }]) })
  view = await mount(panel, { host })
  const shown = view.find({ testId: 'settings-lines' })
  assert.ok(shown, textOf(view))
  assert.deepEqual(
    view.findAll({ type: 'Text' }).filter((t) => t.path.startsWith(`${shown.path}/`)).map((t) => t.text),
    LINES
  )
  // The project is read as usual beside them.
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'shop-api', root: ROOT }])
  assert.ok(view.find({ testId: 'epic:15' }))
  await view.unmount()

  // A broken settings file names no project: its lines say what to fix, and no binding is offered.
  const BROKEN = ['.conport.json is not valid JSON (line 1, column 29): fix it']
  const broken = stub({ 'projects.list': () => ok([{ ...DOCS, focused: true, source: 'file', lines: BROKEN }]) })
  view = await mount(panel, { host: broken.host })
  assert.equal(view.find({ testId: 'settings-lines' })?.text.includes(BROKEN[0] ?? '-'), true, textOf(view))
  assert.equal(view.find({ type: 'Input', label: 'ConPort project' }), null)
  assert.equal(view.find({ type: 'Card', label: 'ConPort project' })?.props.description, text.SETTINGS_BROKEN)
  assert.deepEqual(inputsOf(broken.calls, 'epics.list'), [])

  // Without lines no box is drawn.
  await view.unmount()
  view = await mount(panel, { host: stub({}).host })
  assert.equal(view.find({ testId: 'settings-lines' }), null)
})

test('a project bound by the panel can be bound anew', async () => {
  const { host, calls } = stub({
    'projects.list': () => ok([BILLING]),
    'project.forget': (input: { root: string }) => ok({ root: input.root, project: null, source: null, lines: [], filesRead: true })
  })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  await view.press({ text: 'Change ConPort project' })
  assert.deepEqual(inputsOf(calls, 'project.forget'), [{ root: BILLING.root }])
  assert.ok(view.find({ label: 'ConPort project' }))
})

test('a folder project cannot run', async () => {
  // Even in focus, a folder without git is not picked: the first bound project is.
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...NOTES, focused: true }, unfocused(SHOP)]) })
  view = await mount(panel, { host })
  await view.toggle({ testId: 'project-picker' })
  const folder = view.find({ testId: `project:${NOTES.root}` })
  assert.equal(folder?.props.disabled, true)
  assert.equal(folder?.props.description, 'Folder without git — nothing to run')
  assert.equal(view.find({ text: 'Bind' }), null)
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
  assert.deepEqual(inputsOf(calls, 'epic.session'), [{ project: HANDLE, root: ROOT, epic: 15 }])
  await pick(view, BILLING.root)
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'billing-api', root: BILLING.root })
  assert.deepEqual(inputsOf(calls, 'tasks.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // No epic is open in the second project: its epics show, no session is read.
  assert.equal(inputsOf(calls, 'epic.session').length, 1)
  assert.ok(view.find({ testId: 'epic:15' }))
  await pick(view, ROOT)
  // Back in the first project, its epic is open again.
  assert.deepEqual(inputsOf(calls, 'epic.session').at(-1), { project: HANDLE, root: ROOT, epic: 15 })
  assert.ok(view.find({ text: 'Start' }))
})

test('a slow answer for a project left meanwhile is dropped', async () => {
  const billingEpics: EpicList = {
    project: 'prbi11ngq2',
    epics: [{ id: 30, title: 'Invoices', status: 'TODO', progress: { open: 2, total: 2 }, milestone: null, runnable: true, reason: null, ready: false }]
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
    'epic.start': () => ok({ terminal: 't', way: 'sdd', worktree: '/repo/epic-15' })
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
  // The panel shows Shop with its own epic open, and the epic starts in Shop with Shop's handle.
  assert.equal(pickerOf(view)?.props.title, 'Shop')
  doesNotMatch(textOf(view), /Invoices/)
  assert.deepEqual(inputsOf(calls, 'epic.session').at(-1), { project: HANDLE, root: ROOT, epic: 15 })
  await view.press({ text: 'Start' })
  const sent = inputsOf(calls, 'epic.start') as Array<{ project: string; root: string; epic: number }>
  assert.deepEqual(sent.map(({ project, root, epic }) => ({ project, root, epic })), [{ project: HANDLE, root: ROOT, epic: 15 }])
})

test('a session of the project left that answers late is not drawn in the chosen one', async () => {
  const pending: Array<() => void> = []
  let hold = false
  const { host } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'epic.session': (input: { root: string }) => {
      const answer = ok(input.root === ROOT ? SESSION_ALIVE : session())
      return hold && input.root === ROOT ? new Promise((resolve) => pending.push(() => resolve(answer))) : answer
    }
  })
  view = await mount(panel, { host, persisted: { plugin: { epics: { [ROOT]: 7, [BILLING.root]: 7 } } } })
  assert.ok(view.find({ text: 'Show terminal' }))
  await pick(view, BILLING.root)
  hold = true
  await openPicker(view, ROOT)
  const toShop = view.press({ testId: `project:${ROOT}` })
  await until(() => pending.length === 1)
  await openPicker(view, BILLING.root)
  const toBilling = view.press({ testId: `project:${BILLING.root}` })
  // Billing's session is drawn; then Shop's comes with its live agent.
  await new Promise((resolve) => setTimeout(resolve, 30))
  pending[0]?.()
  await Promise.all([toShop, toBilling])
  assert.equal(pickerOf(view)?.props.title, 'Billing')
  assert.equal(view.find({ text: 'Show terminal' }), null)
  assert.ok(view.find({ text: 'Start' }), 'the start of Billing, whose epic has no session')
})

test('refresh keeps the project chosen by hand while orca lists it', async () => {
  let listed = [SHOP, BILLING]
  const { host, calls } = stub({ 'projects.list': () => ok(listed) })
  view = await mount(panel, { host })
  await pick(view, BILLING.root)
  await view.press({ label: 'Refresh' })
  // The focus does not take the panel back from the project chosen by hand.
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // Once Orca no longer lists it, the project opens as on the first load: the one in focus.
  listed = [SHOP]
  await view.press({ label: 'Refresh' })
  assert.deepEqual(inputsOf(calls, 'epics.list').at(-1), { project: 'shop-api', root: ROOT })
})

test('a reload with no project to open on keeps the one chosen last remembered', async () => {
  let listed: OrcaProject[] = [BILLING]
  const { host, calls } = stub({ 'projects.list': () => ok(listed) })
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'epics.list'), [{ project: 'billing-api', root: BILLING.root }])
  listed = [NOTES]
  await view.press({ label: 'Refresh' })
  assert.equal(inputsOf(calls, 'epics.list').length, 1)
  // Back in the list, the project chosen last opens before the first bound one.
  listed = [unfocused(SHOP), BILLING]
  await view.press({ label: 'Refresh' })
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
  assert.deepEqual(groupsOf(view), ['Sooner', 'Later', 'No milestone'])
  const titles = (label: string) => itemsIn(view as TestPanel, label).map(([title]) => title)
  assert.deepEqual(titles('Sooner'), ['22 · Epic 22', '24 · Epic 24'])
  assert.deepEqual(titles('Later'), ['21 · Epic 21', '25 · Epic 25'])
  assert.deepEqual(titles('No milestone'), ['20 · Epic 20'])
  assert.equal(view.find({ testId: 'epic:23' }), null)
  assert.equal(tabsOf(view)[0], 'Ready to run · 5')
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
    'One open': 'Release · 1 epic open',
    'Two open': 'Release · 2 epics open',
    'Five open': 'Release · 5 epics open',
    'Twenty one open': 'Release · 21 epics open',
    'Twelve open': 'Release · 12 epics open',
    Ready: 'Release · ready to close',
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
      'Not started · 7 tasks',
      'Not started · 1 task',
      'In progress · 0 of 4 closed',
      'In progress · 8 of 26 closed',
      'In progress · 6 of 6 closed',
      'Not started · 0 tasks',
      'Ready to merge · 5 of 5 closed'
    ]
  )
  // Only an epic in progress draws the share of closed tasks.
  const bars = view.findAll({ type: 'Progress' }).map((p) => [p.props.label, p.props.value])
  assert.deepEqual(bars, [
    ['0 of 4 closed', 0],
    ['8 of 26 closed', 31],
    ['6 of 6 closed', 100]
  ])
  // The state comes from the tasks in ConPort: nothing names a phase.
  doesNotMatch(textOf(view), /running|stopped|preparing/)
})
const EPIC = { project: HANDLE, root: ROOT, epic: 15 }
const ROLE_LABELS = ['Implementer', 'Reviewer', 'Gap hunter', 'Final reviewer'] as const
const DEFAULT_TYPES = ['conport:sdd-implementer', 'conport:sdd-task-reviewer', 'conport:sdd-gap-hunter', 'conport:sdd-final-reviewer']
const WITH_CURSOR = { agents: [...AGENTS.agents, CURSOR] }
const refused = (code: string, message: string, action: string) => ({ ok: false, error: { code, message, action } })
const started = (way: 'sdd' | 'workflow' = 'sdd') => ok({ terminal: 'term-9', way, worktree: way === 'sdd' ? '/repo/.claude/worktrees/repo/epic-15' : null })

/** The type chosen in each of the four role lists, top to bottom, and whether each list is off. */
const typesOf = (v: TestPanel): unknown[] => ROLE_LABELS.map((label) => v.find({ label })?.props.value)
const listsOff = (v: TestPanel): boolean[] => ROLE_LABELS.map((label) => v.find({ label })?.props.disabled === true)
const startOf = (v: TestPanel) => v.find({ text: 'Start' })
/** The notice over the panel, and the line of the epic screen that says where the live agent is. */
const noticeOf = (v: TestPanel): string | null => v.find({ testId: 'notice' })?.text ?? null
const aliveOf = (v: TestPanel): string | null => v.find({ testId: 'session-alive' })?.text ?? null
/** No request of the panel asked for a run. */
const noRun = (calls: Array<{ name: string }>): boolean => !calls.some((c) => c.name.startsWith('run.'))

test('opening an epic reads its session, its tasks and the subagent types once, and no run', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  // The list reads nothing of an epic.
  assert.deepEqual([inputsOf(calls, 'epic.session'), inputsOf(calls, 'epic.tasks'), inputsOf(calls, 'subagents.get')], [[], [], []])
  await view.press({ testId: 'epic:15' })
  // The session and the tasks are asked by the handle of the project, not by the name the person bound.
  assert.deepEqual(inputsOf(calls, 'epic.session'), [EPIC])
  assert.deepEqual(inputsOf(calls, 'epic.tasks'), [EPIC])
  assert.deepEqual(inputsOf(calls, 'subagents.get'), [{ root: ROOT, harness: 'claude' }])
  assert.ok(view.find({ text: '← Epics' }))
  assert.equal(view.find({ testId: 'epic-kicker' })?.text, '15')
  assert.equal(headingOf(view, 2), 'Offline mode')
  assert.deepEqual(view.findAll({ type: 'Badge' }).map((b) => b.text), ['Spec ✓', 'Plan ✓'])
  assert.equal(view.find({ testId: 'epic-state' })?.text, 'Not started · 4 tasks')
  // Nothing else reads them: no timer, no event.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(['epic.session', 'epic.tasks', 'subagents.get'].map((name) => inputsOf(calls, name).length), [1, 1, 1])
  // Refresh is the person's request to read again.
  await view.press({ label: 'Refresh' })
  assert.deepEqual(['epic.session', 'epic.tasks', 'subagents.get'].map((name) => inputsOf(calls, name).length), [2, 2, 2])
  assert.equal(noRun(calls), true)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})

test('the epic screen offers the way, the harness and four roles with the default types', async () => {
  const { host } = stub({ 'agents.get': () => ok(WITH_CURSOR) })
  view = await mount(panel, { host, persisted: at(15) })
  const way = view.find({ label: 'Mode' })
  assert.equal(way?.type, 'RadioGroup')
  assert.equal(way?.props.value, 'sdd')
  assert.deepEqual(way?.props.options, [
    { value: 'sdd', label: 'SDD skill' },
    { value: 'workflow', label: '/conport:epic' }
  ])
  // The harnesses that take a task as their first argument, as found on this machine: Gemini is not one.
  const harness = view.find({ label: 'Harness' })
  assert.equal(harness?.props.value, 'claude')
  assert.deepEqual(harness?.props.options, [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'cursor', label: 'Cursor' }
  ])
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  assert.deepEqual(listsOff(view), [false, false, false, false])
  const options = view.find({ label: 'Reviewer' })?.props.options as Array<{ value: string }>
  assert.deepEqual(options.map((o) => o.value), SUBAGENTS.subagents.map((s) => s.type))
  assert.equal(view.find({ testId: 'fixer-note' })?.text, 'Fixes: the same implementer, otherwise conport:sdd-fixer')
  assert.equal(view.find({ testId: 'type-missing:implementer' }), null)
  assert.equal(startOf(view)?.props.disabled, false)
  // Top to bottom: the way, the harness, the roles, the start, the tasks.
  const drawn = textOf(view)
  const places = ['"Mode"', '"Harness"', '"Implementer"', '"Reviewer"', '"Gap hunter"', '"Final reviewer"', 'Fixes: the same implementer', '"Start"', 'Epic tasks'].map((s) => drawn.indexOf(s))
  assert.equal(places.includes(-1), false, JSON.stringify(places))
  assert.deepEqual(places, [...places].sort((a, b) => a - b))
  // The words of the dispatcher are gone.
  doesNotMatch(drawn, /Checker|Final check|Command|remembered for the project/)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('changing the harness puts the roles back to the defaults', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host, persisted: at(15) })
  await view.select({ label: 'Implementer' }, 'sdd-task-reviewer')
  assert.deepEqual(typesOf(view), ['sdd-task-reviewer', ...DEFAULT_TYPES.slice(1)])
  await view.select({ label: 'Harness' }, 'codex')
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'codex')
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  // Back on the first harness the roles are the defaults too, not what was chosen before.
  await view.select({ label: 'Harness' }, 'claude')
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  // The types of each harness were asked once.
  assert.deepEqual(inputsOf(calls, 'subagents.get'), [{ root: ROOT, harness: 'claude' }, { root: ROOT, harness: 'codex' }])
})

test('the choice of one epic does not change the choice of another', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host, persisted: at(15) })
  await view.select({ label: 'Implementer' }, 'sdd-task-reviewer')
  await view.select({ label: 'Mode' }, 'workflow')
  await view.press({ text: '← Epics' })
  await view.press({ testId: 'epic:7' })
  assert.equal(view.find({ label: 'Mode' })?.props.value, 'sdd')
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  await view.select({ label: 'Harness' }, 'codex')
  // Back in the first epic its own choice stands, though nothing was started.
  await view.press({ text: '← Epics' })
  await view.press({ testId: 'epic:15' })
  assert.equal(view.find({ label: 'Mode' })?.props.value, 'workflow')
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'claude')
  await view.select({ label: 'Mode' }, 'sdd')
  assert.deepEqual(typesOf(view), ['sdd-task-reviewer', ...DEFAULT_TYPES.slice(1)])
  // A choice not sent by a start is the panel's own: nothing was asked to keep it.
  assert.deepEqual([...new Set(calls.map((c) => c.name))].sort(), ['agents.get', 'epic.session', 'epic.tasks', 'epics.list', 'projects.list', 'subagents.get', 'tasks.list'])
})

test('a new epic takes the harness of the last start, and Claude Code without one', async () => {
  // The worker answers a new epic with the harness last started in the project.
  const last = stub({ 'epic.session': () => ok(session({ harness: 'codex' })) })
  view = await mount(panel, { host: last.host, persisted: at(15) })
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'codex')
  assert.deepEqual(inputsOf(last.calls, 'subagents.get'), [{ root: ROOT, harness: 'codex' }])
  await view.unmount()
  const none = stub({})
  view = await mount(panel, { host: none.host, persisted: at(15) })
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'claude')
})

test('the role lists are off with the reason when the list cannot be read', async () => {
  const unavailable = refused('subagents_unavailable', 'claude plugin list did not answer', 'install Claude Code or make claude visible on the PATH, then run the command again')
  const { host, calls } = stub({
    'subagents.get': () => unavailable,
    // What an earlier start chose is not shown either: the roles go by the default types.
    'epic.session': () => ok(session({ roles: { implementer: 'my-implementer', reviewer: 'a', gapHunter: 'b', finalReviewer: 'c' } })),
    'epic.start': () => started()
  })
  view = await mount(panel, { host, persisted: at(15) })
  assert.deepEqual(listsOff(view), [true, true, true, true])
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  assert.equal(
    view.find({ testId: 'roles-note' })?.text,
    'The subagent list is unavailable, so the roles keep their default types: No answer from claude plugin list'
  )
  // What to do about it stands under the lists, in the words of the panel.
  assert.equal(
    view.find({ testId: 'roles-action' })?.text,
    "Install Claude Code or make claude visible on the Orca app's PATH, and try again."
  )
  doesNotMatch(textOf(view), /did not answer|install Claude Code/)
  // The start is not held back.
  await view.press({ text: 'Start' })
  assert.deepEqual((inputsOf(calls, 'epic.start')[0] as { roles: unknown }).roles, {
    implementer: DEFAULT_TYPES[0],
    reviewer: DEFAULT_TYPES[1],
    gapHunter: DEFAULT_TYPES[2],
    finalReviewer: DEFAULT_TYPES[3]
  })
})

test('a refusal without an action leaves no empty line under the role lists', async () => {
  const { host } = stub({ 'subagents.get': () => refused('worker', 'The plugin could not read the list', '') })
  view = await mount(panel, { host, persisted: at(15) })
  assert.equal(view.find({ testId: 'roles-note' })?.text, 'The subagent list is unavailable, so the roles keep their default types: The plugin could not read the list')
  assert.equal(view.find({ testId: 'roles-action' }), null)
})

test('when the agents cannot be read the roles do not say the harness is not found', async () => {
  const { host, calls } = stub({ 'agents.get': () => refused('conport_unreachable', 'fetch failed', 'check the network') })
  view = await mount(panel, { host, persisted: at(15) })
  // The refusal itself is told where the harness is chosen.
  assert.match(textOf(view), /ConPort did not answer/)
  doesNotMatch(textOf(view), /Harness not found/)
  assert.equal(view.find({ testId: 'roles-note' }), null)
  assert.equal(view.find({ testId: 'roles-action' }), null)
  // The lists stay off by the default types, and nothing can be started.
  assert.deepEqual(inputsOf(calls, 'subagents.get'), [])
  assert.deepEqual(listsOff(view), [true, true, true, true])
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  assert.equal(startOf(view)?.props.disabled, true)
})

test('the role lists are off for Codex and Cursor', async () => {
  for (const harness of ['codex', 'cursor']) {
    const { host } = stub({ 'agents.get': () => ok(WITH_CURSOR), 'epic.session': () => ok(session({ harness })) })
    view = await mount(panel, { host, persisted: at(15) })
    assert.deepEqual(listsOff(view), [true, true, true, true], harness)
    assert.deepEqual(typesOf(view), DEFAULT_TYPES, harness)
    assert.equal(view.find({ testId: 'roles-note' })?.text, 'This harness has no typed subagents: the roles follow the texts of conport agent <role>', harness)
    assert.equal(startOf(view)?.props.disabled, false, harness)
    await view.unmount()
    view = undefined
  }
  // Claude Code has them: the lists work and no reason is given.
  const { host } = stub({})
  view = await mount(panel, { host, persisted: at(15) })
  assert.deepEqual(listsOff(view), [false, false, false, false])
  assert.equal(view.find({ testId: 'roles-note' }), null)
})

test('the role lists are off by the workflow, and the line under the switch says what the workflow does', async () => {
  const { host } = stub({})
  view = await mount(panel, { host, persisted: at(15) })
  assert.equal(view.find({ testId: 'workflow-note' }), null)
  await view.select({ label: 'Mode' }, 'workflow')
  assert.equal(
    view.find({ testId: 'workflow-note' })?.text,
    'The workflow works in the repository root on the main branch: it starts with its own checks, merges the tasks into the main branch and closes the epic itself'
  )
  assert.deepEqual(listsOff(view), [true, true, true, true])
  assert.equal(view.find({ testId: 'roles-note' })?.text, 'The workflow has its subagent types built in')
  assert.equal(view.find({ testId: 'roles-action' }), null)
  await view.select({ label: 'Mode' }, 'sdd')
  assert.equal(view.find({ testId: 'workflow-note' }), null)
  assert.deepEqual(listsOff(view), [false, false, false, false])
  assert.equal(view.find({ testId: 'roles-note' }), null)
})

test('a stored type that is not in the list keeps its value with the mark', async () => {
  const MARK = 'Type not found — install or update the conport plugin.'
  const marksOf = (v: TestPanel) => ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'].map((key) => v.find({ testId: `type-missing:${key}` })?.text ?? null)
  const roles = { implementer: 'my-implementer', reviewer: DEFAULT_TYPES[1], gapHunter: 'gap-hunter', finalReviewer: DEFAULT_TYPES[3] }
  const stored = stub({ 'epic.session': () => ok(session({ roles: roles as never })), 'epic.start': () => started() })
  view = await mount(panel, { host: stored.host, persisted: at(15) })
  assert.deepEqual(typesOf(view), Object.values(roles))
  // Only the type the list lacks is marked; the lists work.
  assert.deepEqual(marksOf(view), [MARK, null, null, null])
  assert.deepEqual(listsOff(view), [false, false, false, false])
  // The start is not forbidden: the session stops and asks.
  await view.press({ text: 'Start' })
  assert.deepEqual((inputsOf(stored.calls, 'epic.start')[0] as { roles: unknown }).roles, roles)
  await view.unmount()
  // A default type the list lacks is marked the same: the conport plugin is not installed.
  const bare = stub({ 'subagents.get': () => ok({ harness: 'claude', typed: true, subagents: SUBAGENTS.subagents.filter((s) => s.plugin === null) }) })
  view = await mount(panel, { host: bare.host, persisted: at(15) })
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  assert.deepEqual(marksOf(view), [MARK, MARK, MARK, MARK])
  assert.equal(startOf(view)?.props.disabled, false)
  // Choosing a type of the list takes the mark away.
  await view.select({ label: 'Reviewer' }, 'sdd-task-reviewer')
  assert.deepEqual(marksOf(view), [MARK, null, MARK, MARK])
})

test('a stored harness that is no longer found is shown as missing and another can be chosen', async () => {
  // Cursor started the epic once; now its command is gone, or the CLI no longer lists it at all.
  const lists = [{ agents: [...AGENTS.agents, { ...CURSOR, found: false }] }, AGENTS]
  const labels = ['Cursor — not found', 'cursor — not found']
  for (const [index, agents] of lists.entries()) {
    // Asked for the types of a harness it does not know, the CLI would refuse: the stub does the same.
    const { host, calls } = stub({
      'agents.get': () => ok(agents),
      'epic.session': () => ok(session({ harness: 'cursor', roles: { implementer: 'my-implementer', reviewer: 'a', gapHunter: 'b', finalReviewer: 'c' } })),
      'subagents.get': (input: { harness: string }) =>
        input.harness === 'claude' ? ok(SUBAGENTS) : refused('invalid_argument', `unknown harness "${input.harness}"`, 'choose one of claude, codex')
    })
    view = await mount(panel, { host, persisted: at(15) })
    // Its types are not asked for: the role lists are off by the default types, with the reason.
    assert.deepEqual(inputsOf(calls, 'subagents.get'), [])
    assert.deepEqual(listsOff(view), [true, true, true, true])
    assert.deepEqual(typesOf(view), DEFAULT_TYPES)
    assert.equal(view.find({ testId: 'roles-note' })?.text, 'Harness not found: its subagent types cannot be read')
    doesNotMatch(textOf(view), /The subagent list is unavailable/)
    const harness = view.find({ label: 'Harness' })
    assert.equal(harness?.props.value, 'cursor')
    const options = harness?.props.options as Array<{ value: string; label: string; disabled?: boolean }>
    assert.deepEqual(options.find((o) => o.value === 'cursor'), { value: 'cursor', label: labels[index], disabled: true })
    assert.equal(view.find({ testId: 'harness-missing' })?.text, 'Harness not found — start it in this Orca workspace and press Refresh.')
    assert.equal(startOf(view)?.props.disabled, true)
    await view.select({ label: 'Harness' }, 'claude')
    assert.equal(view.find({ testId: 'harness-missing' }), null)
    assert.equal(startOf(view)?.props.disabled, false)
    // The harness found is asked, and its lists work.
    assert.deepEqual(inputsOf(calls, 'subagents.get'), [{ root: ROOT, harness: 'claude' }])
    assert.deepEqual(listsOff(view), [false, false, false, false])
    assert.equal(view.find({ testId: 'roles-note' }), null)
    await view.unmount()
    view = undefined
  }
})

test('while the subagent types of the harness are being read the epic cannot start', async () => {
  const pending: Array<() => void> = []
  const { host, calls } = stub({
    'subagents.get': (input: { harness: string }) =>
      input.harness === 'codex' ? new Promise((resolve) => pending.push(() => resolve(ok(untyped('codex'))))) : ok(SUBAGENTS),
    'epic.start': () => started()
  })
  view = await mount(panel, { host, persisted: at(15) })
  assert.equal(startOf(view)?.props.disabled, false)
  // A select settles only once no request is pending: it is awaited after the answer.
  const toCodex = view.select({ label: 'Harness' }, 'codex')
  await until(() => pending.length === 1)
  await until(() => view?.find({ label: 'Harness' })?.props.value === 'codex')
  // Which roles would go is not known yet: no list is drawn and the start is off.
  assert.equal(view.find({ label: 'Implementer' }), null)
  assert.equal(startOf(view)?.props.disabled, true)
  pending[0]?.()
  await toCodex
  assert.deepEqual(listsOff(view), [true, true, true, true])
  assert.equal(startOf(view)?.props.disabled, false)
  await view.press({ text: 'Start' })
  assert.equal(inputsOf(calls, 'epic.start').length, 1)
})

test('a session that cannot be read says why in place of the choice, keeps the tasks and comes back on refresh', async () => {
  const refusals = [
    refused('project_not_handle', 'The project is named by its name, not by its handle', 'Press Refresh.'),
    refused('terminals_truncated', 'Orca returned an incomplete list of terminals', 'Close the terminals you do not need in Orca and try again.'),
    refused('git_failed', 'fatal: not a repository', 'Check that the project root is a git repository and try again.')
  ]
  for (const refusal of refusals) {
    let fails = true
    const { host, calls } = stub({ 'epic.session': () => (fails ? refusal : ok(session())) })
    view = await mount(panel, { host, persisted: at(7) })
    const code = refusal.error.code
    const boxes = view.findAll({ type: 'Callout' }).filter((c) => c.props.tone === 'danger')
    assert.deepEqual(boxes.map((c) => c.props.title), [refusal.error.message], code)
    assert.ok(boxes[0]?.text.includes(refusal.error.action), code)
    assert.match(JSON.stringify(boxes[0]), new RegExp(code), code)
    // Nothing is chosen and nothing starts on a session not known.
    assert.equal(startOf(view), null, code)
    assert.equal(view.find({ text: 'Show terminal' }), null, code)
    assert.equal(view.find({ label: 'Mode' }), null, code)
    assert.deepEqual(inputsOf(calls, 'subagents.get'), [], code)
    // The tasks are ConPort's and are drawn all the same.
    assert.equal(headingOf(view, 3), 'Tasks · 6', code)
    assert.equal(itemsIn(view, 'Epic tasks').length, 7, code)
    fails = false
    await view.press({ label: 'Refresh' })
    assert.equal(view.findAll({ type: 'Callout' }).some((c) => c.props.tone === 'danger'), false, code)
    assert.equal(startOf(view)?.props.disabled, false, code)
    assert.ok(view.find({ label: 'Mode' }), code)
    await view.unmount()
    view = undefined
  }
})

test('the workflow with a harness other than Claude Code cannot start and says what to do', async () => {
  const { host, calls } = stub({ 'epic.session': () => ok(session({ way: 'workflow', harness: 'codex' })), 'epic.start': () => started('workflow') })
  view = await mount(panel, { host, persisted: at(15) })
  assert.equal(startOf(view)?.props.disabled, true)
  assert.equal(
    view.find({ testId: 'way-needs-claude' })?.text,
    'The /conport:epic mode is only in Claude Code with the conport plugin — choose the Claude Code harness.'
  )
  // By the SDD skill the same harness starts.
  await view.select({ label: 'Mode' }, 'sdd')
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'way-needs-claude' }), null)
  // And the workflow starts with Claude Code.
  await view.select({ label: 'Mode' }, 'workflow')
  assert.equal(startOf(view)?.props.disabled, true)
  await view.select({ label: 'Harness' }, 'claude')
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'way-needs-claude' }), null)
  await view.press({ text: 'Start' })
  assert.deepEqual((inputsOf(calls, 'epic.start') as Array<{ way: string; harness: string }>).map(({ way, harness }) => ({ way, harness })), [{ way: 'workflow', harness: 'claude' }])
})

test('start sends the way, the harness and the roles and says where the agent is, for each way', async () => {
  const cases = [
    ['sdd', 'The agent of epic 15 is open in the terminal of working copy epic-15; it asks its questions there'],
    ['workflow', 'The agent of epic 15 is open in a terminal at the repository root; it asks its questions there']
  ] as const
  for (const [way, said] of cases) {
    // The session is read anew after the start; here the agent is not yet seen in its terminal.
    const { host, calls } = stub({ 'epic.start': () => started(way) })
    view = await mount(panel, { host, persisted: at(15) })
    if (way === 'workflow') await view.select({ label: 'Mode' }, 'workflow')
    else await view.select({ label: 'Reviewer' }, 'sdd-task-reviewer')
    await view.press({ text: 'Start' })
    assert.deepEqual(inputsOf(calls, 'epic.start'), [
      {
        ...EPIC,
        way,
        harness: 'claude',
        roles: {
          implementer: DEFAULT_TYPES[0],
          reviewer: way === 'sdd' ? 'sdd-task-reviewer' : DEFAULT_TYPES[1],
          gapHunter: DEFAULT_TYPES[2],
          finalReviewer: DEFAULT_TYPES[3]
        }
      }
    ])
    assert.equal(noticeOf(view), said, way)
    doesNotMatch(textOf(view), /Agents are starting|the reason will be there/)
    // The screen read the session and the tasks again, and the types of the harness not again.
    assert.deepEqual(['epic.session', 'epic.tasks', 'subagents.get'].map((name) => inputsOf(calls, name).length), [2, 2, 1], way)
    await view.unmount()
    view = undefined
  }
})

test('a started epic whose agent is not seen yet offers no second start until the session is read again', async () => {
  const { host, calls } = stub({ 'epic.start': () => started() })
  view = await mount(panel, { host, persisted: at(15) })
  await view.press({ text: 'Start' })
  // A second press would open a second terminal with the same task.
  assert.equal(startOf(view)?.props.disabled, true)
  assert.equal(inputsOf(calls, 'epic.start').length, 1)
  // The button that waits says for what, and the one thing to do.
  const WAITS = 'The agent is opening in a terminal: press Refresh to see its session'
  assert.equal(view.find({ testId: 'start-note' })?.text, WAITS)
  await view.press({ label: 'Refresh' })
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'start-note' }), null)
  await view.unmount()
  // The working copy this very start made is no earlier work: while the button waits, its note is not said.
  let made = false
  const copied = stub({
    'epic.session': () => ok(made ? { ...SESSION_COPY, worktree: '/repo/.claude/worktrees/repo/epic-15' } : session()),
    'epic.start': () => {
      made = true
      return started()
    }
  })
  view = await mount(panel, { host: copied.host, persisted: at(15) })
  await view.press({ text: 'Start' })
  assert.equal(view.find({ testId: 'start-note' })?.text, WAITS)
  await view.press({ label: 'Refresh' })
  assert.equal(view.find({ testId: 'start-note' })?.text, 'The working copy is already there: the agent resumes where the work stopped')
  // Nor are the branches of the workflow it has just begun.
  await view.unmount()
  made = false
  const branched = stub({
    'epic.session': () => ok(made ? SESSION_WORKFLOW : session({ way: 'workflow' })),
    'epic.start': () => {
      made = true
      return started('workflow')
    }
  })
  view = await mount(panel, { host: branched.host, persisted: at(15) })
  await view.press({ text: 'Start' })
  assert.equal(view.find({ testId: 'start-note' })?.text, WAITS)
  await view.press({ label: 'Refresh' })
  assert.equal(view.find({ testId: 'start-note' })?.text, 'The workflow picks up the branches from the earlier start')
  // A refused start leaves the button to try again.
  const refusing = stub({ 'epic.start': () => refused('root_not_open', 'The repository root /repo is not open in Orca', 'Add the repository to Orca.') })
  await view.unmount()
  view = await mount(panel, { host: refusing.host, persisted: at(15) })
  await view.press({ text: 'Start' })
  assert.equal(startOf(view)?.props.disabled, false)
  await view.press({ text: 'Start' })
  assert.equal(inputsOf(refusing.calls, 'epic.start').length, 2)
  // The session is not read again after a refusal: nothing was started.
  assert.equal(inputsOf(refusing.calls, 'epic.session').length, 1)
})

test('no working copy offers start; a working copy without a session offers start with the note', async () => {
  const COPY = 'The working copy is already there: the agent resumes where the work stopped'
  const fresh = stub({})
  view = await mount(panel, { host: fresh.host, persisted: at(7) })
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'start-note' }), null)
  assert.equal(view.find({ text: 'Show terminal' }), null)
  assert.equal(view.find({ text: 'Start again' }), null)
  await view.unmount()
  const copy = stub({ 'epic.session': () => ok(SESSION_COPY) })
  view = await mount(panel, { host: copy.host, persisted: at(7) })
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'start-note' })?.text, COPY)
  assert.equal(view.find({ text: 'Show terminal' }), null)
  // The note is of the SDD skill: the workflow makes no use of that working copy.
  await view.select({ label: 'Mode' }, 'workflow')
  assert.equal(view.find({ testId: 'start-note' }), null)
})

test('a live session offers its terminal and a second start only after a yes', async () => {
  const { host, calls } = stub({ 'epic.session': () => ok(SESSION_ALIVE), 'epic.start': () => started() })
  view = await mount(panel, { host, persisted: at(7) })
  assert.equal(startOf(view), null)
  assert.ok(view.find({ text: 'Show terminal' }))
  assert.equal(aliveOf(view), 'The agent of epic 7 is open in the terminal of working copy epic-7; it asks its questions there')
  await view.press({ text: 'Start again' })
  assert.deepEqual(inputsOf(calls, 'epic.start'), [])
  assert.equal(view.find({ testId: 'confirm-again' })?.props.title, 'Start epic 7 again?')
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ testId: 'confirm-again' }), null)
  assert.deepEqual(inputsOf(calls, 'epic.start'), [])
  await view.press({ text: 'Start again' })
  await view.press({ text: 'Yes, start' })
  assert.deepEqual((inputsOf(calls, 'epic.start') as Array<{ epic: number; way: string }>).map(({ epic, way }) => ({ epic, way })), [{ epic: 7, way: 'sdd' }])
  assert.equal(view.find({ testId: 'confirm-again' }), null)
  // The session of the workflow lives in the root of the repository.
  await view.unmount()
  const flow = stub({ 'epic.session': () => ok({ ...SESSION_WORKFLOW, alive: true, terminal: 'term-root' }) })
  view = await mount(panel, { host: flow.host, persisted: at(7) })
  assert.equal(aliveOf(view), 'The agent of epic 7 is open in a terminal at the repository root; it asks its questions there')
  assert.equal(startOf(view), null)
  assert.ok(view.find({ text: 'Start again' }))
})

test('show the terminal asks the worker to switch', async () => {
  let gone = false
  const { host, calls } = stub({
    'epic.session': () => ok(SESSION_ALIVE),
    'terminal.show': () => (gone ? refused('session_gone', 'Epic 7 has no live session: its terminal is closed or its agent has exited', 'Press Refresh.') : ok(null))
  })
  view = await mount(panel, { host, persisted: at(7) })
  await view.press({ text: 'Show terminal' })
  // The epic is named, by the handle of the project; no terminal is: the worker finds it anew.
  assert.deepEqual(inputsOf(calls, 'terminal.show'), [{ project: HANDLE, root: ROOT, epic: 7 }])
  assert.equal(view.findAll({ type: 'Callout' }).some((c) => c.props.tone === 'danger'), false)
  gone = true
  await view.press({ text: 'Show terminal' })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, 'Epic 7 has no live session: its terminal is closed or its agent has exited')
  assert.ok(box?.text.includes('Press Refresh.'), box?.text)
})

test('by the workflow branches of an earlier run are noted', async () => {
  const BRANCHES = 'The workflow picks up the branches from the earlier start'
  const flow = stub({ 'epic.session': () => ok(SESSION_WORKFLOW) })
  view = await mount(panel, { host: flow.host, persisted: at(7) })
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'start-note' })?.text, BRANCHES)
  // Chosen the SDD skill instead, the branches are not the workflow's to take up.
  await view.select({ label: 'Mode' }, 'sdd')
  assert.equal(view.find({ testId: 'start-note' }), null)
  await view.unmount()
  const none = stub({ 'epic.session': () => ok(session({ way: 'workflow' })) })
  view = await mount(panel, { host: none.host, persisted: at(7) })
  assert.equal(startOf(view)?.props.disabled, false)
  assert.equal(view.find({ testId: 'start-note' }), null)
})

test('the tasks of an epic are counted by status, parked only when there are some, cancelled outside the counts and last', async () => {
  const { host } = stub({})
  view = await mount(panel, { host, persisted: at(7) })
  assert.equal(headingOf(view, 3), 'Tasks · 6')
  assert.equal(view.find({ testId: 'task-counts' })?.text, 'to do 1 · in progress 1 · in review 1 · blocked 1 · parked 1 · done 1')
  assert.deepEqual(itemsIn(view, 'Epic tasks'), [
    ['36 · Measure the search', 'parked'],
    ['31 · Store the embeddings', 'done'],
    ['35 · Rank the answers', 'to do'],
    ['32 · Build the index', 'in review'],
    ['34 · Read the queries', 'blocked'],
    ['33 · Search by a phrase', 'in progress'],
    // Cancelled: last, muted, in no count.
    ['30 · Drop the old index', 'cancelled']
  ])
  assert.equal(view.find({ testId: 'epic-task:30' })?.props.disabled, true)
  assert.equal(view.find({ testId: 'epic-task:36' })?.props.disabled, undefined)
  await view.unmount()
  // With no task parked the counter is not drawn; the other five are, zero or not.
  const few = stub({ 'epic.tasks': () => ok(EPIC_TASKS.filter((t) => t.status === 'DONE' || t.status === 'CANCELLED')) })
  view = await mount(panel, { host: few.host, persisted: at(7) })
  assert.equal(headingOf(view, 3), 'Tasks · 1')
  assert.equal(view.find({ testId: 'task-counts' })?.text, 'to do 0 · in progress 0 · in review 0 · blocked 0 · done 1')
  await view.unmount()
  // The counts on their own, the boundary of each.
  assert.deepEqual(text.taskCounts(EPIC_TASKS), { todo: 1, inProgress: 1, review: 1, blocked: 1, parked: 1, done: 1, total: 6 })
  assert.deepEqual(text.taskCounts([]), { todo: 0, inProgress: 0, review: 0, blocked: 0, parked: 0, done: 0, total: 0 })
  assert.deepEqual(text.taskCounts([{ id: 1, title: 'a', status: 'CANCELLED' }]), { todo: 0, inProgress: 0, review: 0, blocked: 0, parked: 0, done: 0, total: 0 })
  // A task list that cannot be read is said in its place, and the start stays.
  const failing = stub({ 'epic.tasks': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host: failing.host, persisted: at(7) })
  assert.equal(view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')?.props.title, 'No ConPort API key')
  assert.equal(startOf(view)?.props.disabled, false)
})

test('the notice goes on refresh, on leaving the epic, on another tab, on another project and when the session is alive', async () => {
  const NOTICE = 'The agent of epic 15 is open in the terminal of working copy epic-15; it asks its questions there'
  /** A panel on epic 15 just started, its agent not yet seen: the notice stands. */
  const afterStart = async (): Promise<TestPanel> => {
    const { host } = stub({ 'projects.list': () => ok([SHOP, BILLING]), 'epic.start': () => started(), 'task.hand': () => ok({ terminal: 'term-1' }) })
    const v = await mount(panel, { host, persisted: at(15) })
    view = v
    await v.press({ text: 'Start' })
    assert.equal(noticeOf(v), NOTICE)
    return v
  }
  const leave = async (): Promise<void> => {
    await view?.unmount()
    view = undefined
  }

  let v = await afterStart()
  await v.press({ label: 'Refresh' })
  assert.equal(noticeOf(v), null, 'refresh')
  await leave()

  v = await afterStart()
  await v.press({ text: '← Epics' })
  assert.equal(noticeOf(v), null, 'leaving the epic')
  // The notice of a task handed to an agent goes with the tab.
  await tab(v, 'tasks')
  await v.press({ testId: 'hand:41' })
  await v.press({ text: 'Open in terminal' })
  assert.match(noticeOf(v) ?? '', /conport task 41/)
  await tab(v, 'prepare')
  assert.equal(noticeOf(v), null, 'another tab')
  await leave()

  v = await afterStart()
  await pick(v, BILLING.root)
  assert.equal(noticeOf(v), null, 'another project')
  await leave()

  // The session read after the start is alive: the screen says where the agent is, the notice does not stay over it.
  let live = false
  const { host } = stub({
    'epic.session': () => ok(live ? { ...SESSION_ALIVE, worktree: '/repo/.claude/worktrees/repo/epic-15' } : session()),
    'epic.start': () => {
      live = true
      return started()
    }
  })
  view = await mount(panel, { host, persisted: at(15) })
  await view.press({ text: 'Start' })
  assert.equal(noticeOf(view), null, 'a live session')
  assert.equal(aliveOf(view), NOTICE)
})

test('the epic screen has no stop and no continue and asks for no run', async () => {
  const sessions = [session(), SESSION_COPY, SESSION_ALIVE, SESSION_WORKFLOW, session({ way: 'workflow', harness: 'codex' })]
  for (const state of sessions) {
    const { host, calls } = stub({ 'epic.session': () => ok(state) })
    view = await mount(panel, { host, persisted: at(7) })
    assert.ok(view.find({ label: 'Mode' }))
    doesNotMatch(textOf(view), /Stop agents|Resume|The epic is held|Agents stopped|The epic waits for your answer|epic answer|epic status|epic run/)
    assert.equal(noRun(calls), true)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    await view.unmount()
    view = undefined
  }
  // Nothing of the run is left in the sources of the panel either.
  for (const file of ['panel.tsx', 'text.ts', 'panel.check.ts']) {
    const source = readFileSync(join(SOURCES, file), 'utf8')
    doesNotMatch(source, /run\.(get|start|stop)|EpicStatus|RunPhase|HeldBox|Unasked|StopControl|answerCommand|statusCommand|holdReason|failureText/, file)
  }
})

test('a missing api key shows the cli refusal in the panel', async () => {
  const { host } = stub({ 'epics.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  // Said in the panel's words by the code of the refusal, with its one action; the CLI's English never shows.
  assert.equal(box?.props.title, 'No ConPort API key')
  assert.ok(box?.text.includes('Add CONPORT_API_KEY to ~/.config/conport/.env and try again.'), box?.text)
  assert.match(JSON.stringify(box), /no_api_key/)
  doesNotMatch(textOf(view), /is not set|put CONPORT_API_KEY/)
})

/** The words for a refusal the panel does not know: they name no program, it may be conport or orca. */
const UNKNOWN_WHAT = 'A program refused for a reason the panel does not know'
const UNKNOWN_ACTION = 'Press Refresh; if the refusal repeats, update the plugin and Orca.'

test('every refused action says the panel words: the cli by its code, the worker in its own words', async () => {
  const own = (code: string, message: string, action: string): [{ code: string; message: string; action: string }, string, string] => [{ code, message, action }, message, action]
  const refusals: Array<[{ code: string; message: string; action: string }, string, string]> = [
    // A CLI code the panel knows, from any of the actions.
    [{ code: 'conport_unreachable', message: 'ConPort did not answer (fetch failed)', action: 'check the network and run the command again' }, 'ConPort did not answer', 'Check the network and try again.'],
    [{ code: 'http_502', message: 'ConPort answered 502: bad gateway', action: 'run the command again in a few minutes' }, 'ConPort answered with an error', 'Wait a few minutes and try again.'],
    [{ code: 'subagents_unavailable', message: 'claude plugin list did not answer', action: 'install Claude Code or make claude visible on the PATH, then run the command again' }, 'No answer from claude plugin list', "Install Claude Code or make claude visible on the Orca app's PATH, and try again."],
    [{ code: 'command_removed', message: 'conport epic run was removed in 0.7.0', action: 'start the epic from the ConPort Epics panel of Orca' }, 'The plugin called a command the CLI no longer has', 'Update the plugin.'],
    // A refusal of orca comes with no action: the panel names one.
    [{ code: 'terminal_not_found', message: 'no such terminal', action: '' }, 'Orca did not find the terminal', 'Press Refresh.'],
    // A refusal of orca the panel does not know: the words of orca as they are, and the one action of the panel.
    [{ code: 'worktree_busy', message: 'the worktree is busy', action: '' }, 'the worktree is busy', UNKNOWN_ACTION],
    // A CLI code it does not know, and a line of the error stream.
    [{ code: 'brand_new_refusal', message: 'something new broke', action: 'do the new thing' }, UNKNOWN_WHAT, UNKNOWN_ACTION],
    [{ code: 'cli_failed', message: 'TypeError: boom', action: '' }, UNKNOWN_WHAT, UNKNOWN_ACTION],
    // A code only the dispatcher had is not known any more.
    [{ code: 'gate_red', message: 'the gate is red', action: 'make the gate green' }, UNKNOWN_WHAT, UNKNOWN_ACTION],
    // A program that could not start: named, without the error of Node.
    [{ code: 'spawn_failed', message: 'npx: spawn npx ENOENT', action: "Install Node.js and make npx visible on the Orca app's PATH." }, 'Could not start npx', "Install Node.js and make npx visible on the Orca app's PATH."],
    // The worker's own refusals are in the panel's words already: shown as they are.
    own('root_not_open', 'The repository root /repo is not open in Orca', 'Add the repository to Orca.'),
    own('epic_not_ready', 'Epic 15 has no spec or no plan', 'Prepare the epic in the Prepare tab.'),
    own('way_needs_claude', 'The /conport:epic mode is only in Claude Code with the conport plugin', 'Choose the Claude Code harness.'),
    own('role_invalid', 'The subagent type is not a plain name', 'Choose a type for the role from the list.'),
    own('root_detached', "The repository's main working copy is not on a branch, so the epic has no base", 'Check out a branch in the main working copy.'),
    own('epic_started_sdd', 'The workflow is chosen, but the branch epic-15 is there already: the epic was started by the SDD skill', 'Choose the SDD skill mode.'),
    own('epic_started_workflow', 'The SDD skill is chosen, but branches epic15/… are there already: the epic was started by the workflow', 'Choose the /conport:epic mode.'),
    own('epic_branch_taken', 'The branch epic-15 is there, but it has no working copy', 'Open the branch as a workspace in Orca.'),
    own('project_not_handle', 'The project is named by its name, not by its handle', 'Press Refresh.'),
    own('session_gone', 'Epic 15 has no live session', 'Press Refresh.'),
    own('harness_invalid', 'No harness is named', "Choose the epic's harness."),
    own('terminals_truncated', 'Orca returned an incomplete list of terminals', 'Close the terminals you do not need in Orca and try again.'),
    own('git_failed', 'fatal: not a repository', 'Check that the project root is a git repository and try again.')
  ]
  for (const [error, what, action] of refusals) {
    const { host } = stub({ 'epic.start': () => ({ ok: false, error }) })
    view = await mount(panel, { host, persisted: at(15) })
    await view.press({ text: 'Start' })
    const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
    assert.equal(box?.props.title, what, error.code)
    assert.match(JSON.stringify(box), new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), error.code)
    assert.match(JSON.stringify(box), new RegExp(error.code), error.code)
    doesNotMatch(textOf(view), /ENOENT/, error.code)
    if (what !== error.message) doesNotMatch(textOf(view), new RegExp(error.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), error.code)
    await view.unmount()
    view = undefined
  }
})

test('every refusal of the commands left is said in the panel words with one action, an http status by its class', () => {
  const said = (code: string) => refusalText({ code, message: 'english words', action: 'an english action' })
  const unknown = said('brand_new_refusal')
  assert.deepEqual(unknown, { what: UNKNOWN_WHAT, action: UNKNOWN_ACTION })
  // The codes the commands the plugin still runs can refuse with.
  const codes = [
    'no_project', 'project_not_found', 'no_api_key', 'conport_unreachable', 'invalid_argument', 'subagents_unavailable',
    'command_removed', 'runtime_unavailable', 'runtime_timeout', 'unexpected_answer', 'terminal_not_found'
  ]
  for (const code of codes) {
    const text = said(code)
    assert.notDeepEqual(text, unknown, code)
    // What is said in sentence case; the action is one imperative sentence ending with a period.
    assert.match(text.what, /^[A-Z]/, code)
    assert.match(text.action, /^[A-Z].*\.$/, code)
    doesNotMatch(`${text.what} ${text.action}`, /english|\{again\}|Resume/, code)
  }
  // Orca names no action: a code of its the panel does not know keeps its words. A known one, a
  // line of an error stream and a refusal without a word do not.
  const bare = (code: string, message: string) => refusalText({ code, message, action: '' })
  assert.deepEqual(bare('worktree_busy', 'the worktree is busy'), { what: 'the worktree is busy', action: UNKNOWN_ACTION })
  assert.deepEqual(bare('terminal_not_found', 'no such terminal'), { what: 'Orca did not find the terminal', action: 'Press Refresh.' })
  assert.deepEqual(bare('cli_failed', 'TypeError: boom'), unknown)
  assert.deepEqual(bare('refused', ''), unknown)
  assert.deepEqual(bare('refused', '  '), unknown)
  assert.equal(said('http_401').what, 'ConPort did not accept the API key')
  assert.equal(said('http_403').what, 'ConPort did not accept the API key')
  assert.equal(said('http_500').what, 'ConPort answered with an error')
  assert.equal(said('http_503').what, 'ConPort answered with an error')
  // Below the server errors and besides the key, a status says nothing the panel can act on.
  assert.deepEqual(said('http_499'), unknown)
  assert.deepEqual(said('http_404'), unknown)
  // What only the dispatcher refused with is gone.
  for (const code of ['gate_red', 'epic_held', 'run_mismatch', 'no_run', 'workers_not_stopped', 'record_busy', 'host_unavailable']) {
    assert.deepEqual(said(code), unknown, code)
  }
})


test('a project list orca cannot give is retried from the panel', async () => {
  let answers = 0
  const { host, calls } = stub({
    'projects.list': () =>
      ++answers === 1 ? { ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running', action: '' } } : ok([SHOP])
  })
  view = await mount(panel, { host })
  assert.match(textOf(view), /Orca did not answer/)
  doesNotMatch(textOf(view), /Orca is not running/)
  await view.press({ text: 'Retry' })
  assert.equal(calls.filter((c) => c.name === 'epics.list').length, 1)
  doesNotMatch(textOf(view), /Orca did not answer/)
})

test('an empty project says so', async () => {
  const { host } = stub({ 'epics.list': () => ok(EMPTY_LIST) })
  view = await mount(panel, { host })
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.equal(view.find({ text: 'Start' }), null)
})

test('a project of only epics to prepare says none can be started', async () => {
  const none = { ...EPIC_LIST, epics: EPIC_LIST.epics.filter((e) => !e.runnable) }
  const { host } = stub({ 'epics.list': () => ok(none) })
  view = await mount(panel, { host })
  assert.match(textOf(view), /No epic is ready to run/)
  assert.deepEqual(tabsOf(view), ['Ready to run · 0', 'Prepare · 2', 'Tasks · 5'])
})

const PREPARABLE: EpicList = {
  project: HANDLE,
  epics: [
    ...EPIC_LIST.epics,
    epic(20, null, { title: 'Payments', runnable: false, reason: 'the documents of the epic cannot be read' })
  ]
}

test('the prepare tab offers a spec or a plan by what the epic lacks', async () => {
  const { host } = stub({ 'epics.list': () => ok(PREPARABLE) })
  view = await mount(panel, { host })
  assert.deepEqual(tabsOf(view), ['Ready to run · 2', 'Prepare · 3', 'Tasks · 5'])
  await tab(view, 'prepare')
  assert.match(textOf(view), /The agent talks the epic through with you and writes its spec and plan; then the epic appears in the Ready to run tab\./)
  assert.deepEqual(groupsOf(view), ['Release 2.4', 'No milestone'])
  // The reason of the CLI never reaches the panel as it is: the panel says its own line.
  doesNotMatch(textOf(view), /"no spec"|"no plan"|cannot be read/)
  // Nor glued into a longer line ("10 · no spec", "Audit log: no spec"): no row ends with a reason
  // of the data after a separator. "Spec, no plan" is the panel's own line, not a reason glued on.
  const reasons = PREPARABLE.epics.map((e) => e.reason).filter((r): r is string => r !== null)
  const glued = (line: string, reason: string): boolean =>
    line === reason || (line.endsWith(reason) && /[·:—]\s*$/.test(line.slice(0, line.length - reason.length)))
  const rows = view.findAll({ type: 'ListItem' })
  assert.equal(rows.length, 3)
  for (const row of rows) {
    const line = String(row.props.description ?? '')
    for (const reason of reasons) assert.equal(glued(line, reason), false, `${row.key}: ${line}`)
  }
  const described = Object.fromEntries([9, 10, 20].map((id) => [id, view?.find({ testId: `epic:${id}` })?.props.description]))
  assert.deepEqual(described, { 9: 'Spec, no plan', 10: 'No spec', 20: 'Not ready to run for another reason' })
  assert.equal(view.find({ testId: 'prepare:9' })?.text, 'Write plan')
  assert.equal(view.find({ testId: 'prepare:10' })?.text, 'Prepare')
  // An epic that cannot run for another reason cannot be prepared.
  assert.equal(view.find({ testId: 'prepare:20' }), null)
  assert.equal(view.find({ testId: 'epic:20' })?.props.disabled, true)
})

test('an epic without a spec is prepared by the agent chosen in the sheet', async () => {
  const { host, calls } = stub({
    'agents.get': () => ok({ agents: [...AGENTS.agents, { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: true }], preparer: 'codex' }),
    'epic.prepare': () => ok({ terminal: 'term-1' })
  })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:10' })
  // The sheet: what the agent does, and which agent; the one of last time first.
  const sheet = view.find({ testId: 'sheet' })
  assert.equal(sheet?.props.title, 'Prepare “Audit log”')
  assert.equal(sheet?.props.description, '10 · no spec')
  const steps = view.findAll({ type: 'Row' }).filter((r) => r.key?.startsWith('step:'))
  assert.deepEqual(steps.map((s) => s.text), [
    '1 Talks the epic through with you and writes the spec',
    '2 After your yes, uploads it to ConPort',
    "3 Writes the plan, links the epic's tasks, imports the plan"
  ])
  const radio = view.find({ label: 'Who prepares' })
  assert.equal(radio?.props.value, 'codex')
  assert.deepEqual(radio?.props.options, [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex', description: 'last time' },
    { value: 'cursor', label: 'Cursor' }
  ])
  await view.select({ label: 'Who prepares' }, 'claude')
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'epic.prepare'), [{ project: HANDLE, root: ROOT, epic: 10, agent: 'claude' }])
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.match(textOf(view), /Preparation of epic 10 is open in terminal “conport prepare 10” of repository “Shop”/)
  assert.deepEqual(view.errors, [])
})

test('the sheet of an epic with a spec writes the plan, and Cancel closes it', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Write plan “Archive export”')
  assert.equal(view.find({ testId: 'sheet' })?.props.description, '9 · no plan')
  // Without the agent of last time the first one found that can prepare.
  assert.equal(view.find({ label: 'Who prepares' })?.props.value, 'claude')
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.deepEqual(inputsOf(calls, 'epic.prepare'), [])
})

test('only an agent that takes a positional request is offered in the sheet', async () => {
  const withOpencode = [...AGENTS.agents, { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true }]
  const { host } = stub({ 'agents.get': () => ok({ agents: withOpencode, preparer: 'opencode' }) })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  const radio = view.find({ label: 'Who prepares' })
  assert.deepEqual((radio?.props.options as Array<{ value: string }>).map((o) => o.value), ['claude', 'codex'])
  // The one remembered for the project cannot take a task: the first that can is taken.
  assert.equal(radio?.props.value, 'claude')
})

test('with no agent found nothing can be prepared or handed', async () => {
  const none = AGENTS.agents.map((a) => ({ ...a, found: false }))
  const { host } = stub({ 'agents.get': () => ok({ agents: none }) })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  assert.equal(view.find({ testId: 'prepare:9' })?.props.disabled, true)
  // One line: what is wrong — the action, lowercase after the dash.
  assert.match(
    textOf(view),
    /Only Claude Code, Codex and Cursor take a task, and none of them was found — start the agent in this Orca workspace and press Refresh\./
  )
  await tab(view, 'tasks')
  assert.equal(view.find({ testId: 'hand:41' })?.props.disabled, true)
  assert.equal(view.find({ testId: 'review:42' })?.props.disabled, true)
})

test('a refused prepare says why and keeps the sheet', async () => {
  const { host } = stub({
    'epic.prepare': () => ({ ok: false, error: { code: 'epic_ready', message: 'Epic 9 is already ready to run', action: 'Press Refresh and start it.' } })
  })
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await view.press({ text: 'Open in terminal' })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, 'Epic 9 is already ready to run')
  assert.ok(view.find({ testId: 'sheet' }))
})

test('a folder or unbound project offers no prepare', async () => {
  // A folder in focus is never chosen; an unbound project asks for its binding, no epics.
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...NOTES, focused: true }, unfocused(DOCS)]) })
  view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Prepare' }), null)
  await view.press({ text: 'Bind' })
  assert.ok(view.find({ label: 'ConPort project' }))
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
  await view.press({ label: 'Refresh' })
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
  const preparing = view.press({ text: 'Open in terminal' })
  await until(() => pending.length === 1)
  await openPicker(view, BILLING.root)
  const toBilling = view.press({ testId: `project:${BILLING.root}` })
  await new Promise((resolve) => setTimeout(resolve, 30))
  pending[0]?.()
  await Promise.all([preparing, toBilling])
  assert.equal(pickerOf(view)?.props.title, 'Billing')
  doesNotMatch(textOf(view), /conport prepare 10/)
})

test('an agent picked by hand in the sheet stays when the panel comes back into view', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await view.select({ label: 'Who prepares' }, 'codex')
  await view.press({ text: 'Cancel' })
  await view.setVisible(false)
  await view.setVisible(true)
  await until(() => inputsOf(calls, 'agents.get').length === 2)
  await view.settled()
  await view.press({ testId: 'prepare:10' })
  assert.equal(view.find({ label: 'Who prepares' })?.props.value, 'codex')
})

test('an open sheet stays when the panel comes back into view while its task or epic is still listed', async () => {
  let listed = TASK_LIST.tasks
  const { host, calls } = stub({ 'tasks.list': () => ok(listed) })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  await view.press({ testId: 'hand:41' })
  await view.select({ label: 'Who takes the task' }, 'codex')
  const away = async (): Promise<void> => {
    const before = inputsOf(calls, 'agents.get').length
    await (view as TestPanel).setVisible(false)
    await (view as TestPanel).setVisible(true)
    await until(() => inputsOf(calls, 'agents.get').length === before + 1)
    await (view as TestPanel).settled()
  }
  await away()
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Hand to agent “Rotate the backup key”')
  assert.equal(view.find({ label: 'Who takes the task' })?.props.value, 'codex')
  // Taken meanwhile: the task is no longer one to hand, the sheet closes.
  listed = TASK_LIST.tasks.map((t) => (t.id === 41 ? { ...t, status: 'IN_PROGRESS' as const } : t))
  await away()
  assert.equal(view.find({ testId: 'sheet' }), null)
  // A sheet of an epic stays while the epic still lacks what it is prepared for, and closes once it can start.
  await tab(view, 'prepare')
  await view.press({ testId: 'prepare:9' })
  await away()
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Write plan “Archive export”')
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

test('the tasks tab marks a bug', async () => {
  const tasks = TASK_LIST.tasks.map((task) => ({ ...task, kind: task.id <= 43 ? 'bug' : 'task' }))
  const { host } = stub({ 'tasks.list': () => ok(tasks) })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  assert.deepEqual(itemsIn(view, 'In review'), [
    ['42 · Compare the metrics after the release', 'Bug · In review']
  ])
  assert.deepEqual(itemsIn(view, 'In progress'), [['43 · Check the backups', 'Bug · In progress']])
  assert.deepEqual(itemsIn(view, 'To do'), [
    ['41 · Rotate the backup key', 'Bug · High · not started'],
    ['44 · Simplify the search answer', 'Medium · not started'],
    ['45 · Hints on an empty search', 'Low · not started']
  ])
})

test('the tasks tab keeps the order of the list', async () => {
  // Server order takes precedence over the displayed priority.
  const tasks = [
    { id: 51, title: 'Background chore', kind: 'task', status: 'TODO', priority: 5, changes_requested: false },
    { id: 52, title: 'Fix the outage', kind: 'task', status: 'TODO', priority: 1, changes_requested: false },
    { id: 53, title: 'Under review', kind: 'task', status: 'REVIEW', priority: 4, changes_requested: false },
    { id: 54, title: 'Being done', kind: 'task', status: 'IN_PROGRESS', priority: 2, changes_requested: false },
    { id: 55, title: 'Rotate the key', kind: 'task', status: 'TODO', priority: 2, changes_requested: false },
    { id: 56, title: 'Simplify', kind: 'task', status: 'TODO', priority: 3, changes_requested: false },
    { id: 57, title: 'Hints', kind: 'task', status: 'TODO', priority: 4, changes_requested: false },
    { id: 58, title: 'Back from review', kind: 'task', status: 'IN_PROGRESS', priority: 3, changes_requested: true }
  ]
  const { host } = stub({ 'tasks.list': () => ok(tasks) })
  view = await mount(panel, { host })
  assert.equal(tabsOf(view)[2], 'Tasks · 8')
  await tab(view, 'tasks')
  assert.deepEqual(groupsOf(view), ['In review', 'In progress', 'To do'])
  const rows = (label: string) => itemsIn(view as TestPanel, label)
  assert.deepEqual(rows('In review'), [['53 · Under review', 'In review']])
  assert.deepEqual(rows('In progress'), [
    ['54 · Being done', 'In progress'],
    ['58 · Back from review', 'Changes requested']
  ])
  // A task the review sent back is fixed by an agent; one an agent is at is its own.
  assert.equal(view.find({ testId: 'fix:58' })?.text, 'Fix')
  assert.equal(view.find({ testId: 'fix:54' }), null)
  assert.deepEqual(rows('To do'), [
    ['51 · Background chore', 'Idle · not started'],
    ['52 · Fix the outage', 'Critical · not started'],
    ['55 · Rotate the key', 'High · not started'],
    ['56 · Simplify', 'Medium · not started'],
    ['57 · Hints', 'Low · not started']
  ])
  // Review asks for a check, todo for an agent; a task in progress is the agent's own.
  assert.equal(view.find({ testId: 'review:53' })?.text, 'Review')
  assert.equal(view.find({ testId: 'hand:52' })?.text, 'Hand to agent')
  assert.equal(view.find({ testId: 'hand:54' }), null)
  assert.equal(view.find({ testId: 'review:54' }), null)
})

test('a task is handed to the agent chosen in the sheet, to do, to review or to fix', async () => {
  const sentBack = TASK_LIST.tasks.map((t) => (t.id === 43 ? { ...t, changes_requested: true } : t))
  const { host, calls } = stub({
    'agents.get': () => ok({ agents: AGENTS.agents, preparer: 'codex' }),
    'tasks.list': () => ok(sentBack),
    'task.hand': () => ok({ terminal: 'term-1' })
  })
  view = await mount(panel, { host })
  await tab(view, 'tasks')
  await view.press({ testId: 'hand:41' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Hand to agent “Rotate the backup key”')
  assert.equal(view.find({ label: 'Who takes the task' })?.props.value, 'codex')
  // The agent works on a branch of its own and commits there; merging it is the person's.
  assert.match(textOf(view), /Does it on its own branch, in a separate working copy beside the repository, checks it and commits/)
  await view.press({ text: 'Open in terminal' })
  assert.match(textOf(view), /The work goes to a separate branch of the task, and you merge it\./)
  await view.press({ testId: 'review:42' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Review “Compare the metrics after the release”')
  // The reviewer checks that branch, and closes the task it approves only with the person's yes.
  assert.match(textOf(view), /Reviews the branch from the report/)
  assert.match(textOf(view), /on approval, with your consent, closes the task/)
  await view.select({ label: 'Who reviews' }, 'claude')
  await view.press({ text: 'Open in terminal' })
  assert.match(textOf(view), /Review of task 42 is open in terminal “conport review 42” of repository “Shop”: the agent writes its verdict to the task's journal and, on approval, closes the task with your consent/)
  // A task the review sent back: the agent goes on in its branch with the findings of the review.
  await view.press({ testId: 'fix:43' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Fix “Check the backups”')
  assert.match(textOf(view), /Continues on the task's branch, fixes and commits/)
  await view.select({ label: 'Who fixes' }, 'codex')
  await view.press({ text: 'Open in terminal' })
  assert.match(textOf(view), /Fixes of task 43 are open in terminal “conport fix 43” of repository “Shop”/)
  assert.deepEqual(inputsOf(calls, 'task.hand').at(-1), { project: HANDLE, root: ROOT, task: 43, agent: 'codex', mode: 'fix' })
  assert.deepEqual(inputsOf(calls, 'task.hand').slice(0, 2), [
    { project: HANDLE, root: ROOT, task: 41, agent: 'codex', mode: 'do' },
    { project: HANDLE, root: ROOT, task: 42, agent: 'claude', mode: 'review' }
  ])
})

test('a task list the cli cannot give is said in the tasks tab only', async () => {
  const { host } = stub({ 'tasks.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  assert.deepEqual(tabsOf(view), ['Ready to run · 2', 'Prepare · 2', 'Tasks'])
  assert.equal(view.findAll({ type: 'Callout' }).filter((c) => c.props.tone === 'danger').length, 0)
  await tab(view, 'tasks')
  assert.equal(view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')?.props.title, 'No ConPort API key')
})

const SOURCES = join(dirname(fileURLToPath(import.meta.url)))
const CYRILLIC = /[\u0400-\u04FF]/

test('no panel text is in russian', async () => {
  // Nothing the panel or the worker can show is: the sources hold no cyrillic letter.
  for (const file of ['panel.tsx', 'text.ts', 'worker.ts', 'cli.ts']) {
    doesNotMatch(readFileSync(join(SOURCES, file), 'utf8'), CYRILLIC, file)
  }
  // Nor does any screen drawn: each tab, the epic in each state of its session, the sheet.
  const screens: string[] = []
  const sessions = [session(), SESSION_COPY, SESSION_ALIVE, SESSION_WORKFLOW, session({ way: 'workflow', harness: 'codex' }), session({ harness: 'codex' })]
  for (const state of sessions) {
    const { host } = stub({ 'epic.session': () => ok(state), 'epic.start': () => started(state.way) })
    view = await mount(panel, { host, persisted: at(7) })
    screens.push(textOf(view))
    if (view.find({ text: 'Start again' })) {
      await view.press({ text: 'Start again' })
      screens.push(textOf(view))
      await view.press({ text: 'Cancel' })
    } else if (startOf(view)?.props.disabled === false) {
      await view.press({ text: 'Start' })
      screens.push(textOf(view))
    }
    await view.press({ text: '← Epics' })
    for (const value of ['launch', 'prepare', 'tasks'] as const) {
      await tab(view, value)
      screens.push(textOf(view))
    }
    await view.press({ testId: 'hand:41' })
    screens.push(textOf(view))
    await view.unmount()
    view = undefined
  }
  for (const screen of screens) doesNotMatch(screen, CYRILLIC)
})
