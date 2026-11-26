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
  EMPTY_SDD,
  EPIC_TASKS,
  HANDLE,
  NO_KEY,
  SDD_LIST,
  session,
  SESSION_ALIVE,
  SESSION_COPY,
  SUBAGENTS,
  TAKEN,
  untyped
} from '../test/fixtures'
import { fake, json, until } from '../test/fake'
import * as panel from './panel'
import type { Assignee, IdeaRow, InWorkRow, Milestone, OrcaProject, Result, RowTarget, SddList, TakenList } from './protocol'
import { FULL_READ_MS, POLL_TAKEN_MS } from './sdd'
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

/** A fresh copy of a list, to change in one test. */
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * The list of the project with no epic taken: epic 7 waits to start. The tests of the screen of
 * an epic run on it; the taken rows are tested on SDD_LIST.
 */
const LIST: SddList = (() => {
  const list = copy(SDD_LIST)
  list.in_work = list.in_work.map(({ updated_at: _gone, ...epic }) => ({ ...epic, status: 'TODO' as const }))
  return list
})()

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
    'sdd.list': () => ok(LIST),
    'sdd.taken': () => ok({ project: HANDLE, taken: [{ id: 43, kind: 'bug', updated_at: '2026-11-16T10:00:00Z' }, { id: 46, kind: 'task', updated_at: '2026-11-15T18:30:00Z' }] }),
    'agents.get': () => ok(AGENTS),
    'project.page': () => ok({ url: `https://me.conport.app/t/pers/p/${HANDLE}` }),
    'row.session': () => ok({ terminal: null }),
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

/** The sections as drawn, in order: their titles with counts, and the caption under each. */
const sectionsOf = (v: TestPanel): Array<[unknown, unknown]> =>
  v.findAll({ type: 'Collapsible' })
    .filter((c) => c.key?.startsWith('section:'))
    .map((c) => [c.props.title, c.props.description])

/** Unfolds or folds a section by its key. */
async function fold(v: TestPanel, key: 'in_work' | 'specs' | 'ideas' | 'outside'): Promise<void> {
  await v.toggle({ testId: `section:${key}` })
}

/** The titles of the lists drawn, in order. */
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

/** The labels of the buttons of a row, in order. */
function buttonsOf(v: TestPanel, testId: string): string[] {
  const row = v.find({ testId })
  if (!row) return []
  return v
    .findAll({ type: 'Button' })
    .filter((b) => b.path.startsWith(`${row.path}/`))
    .map((b) => b.text)
}

const headingOf = (v: TestPanel, level: number): string | undefined =>
  v.findAll({ type: 'Heading' }).find((h) => h.props.level === level)?.text

/**
 * Catches the timer the panel sets in its setup, so a test fires it by hand, and the clock the
 * panel reads. Set before the mount; `restore` after the test.
 */
function clockAndTimer() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now }
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  let now = real.now()
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const timer = { fn, ms: ms ?? 0, cleared: false }
    timers.push(timer)
    return timer
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((handle: unknown) => {
    const timer = timers.find((t) => t === handle)
    if (timer) timer.cleared = true
  }) as typeof clearInterval
  Date.now = () => now
  return {
    /** The timers of the panel at `ms`, not cleared. */
    at: (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared),
    /** Moves the clock and fires the minute timer once. */
    tick: (later = 0) => {
      now += later
      for (const t of timers) if (t.ms === POLL_TAKEN_MS && !t.cleared) t.fn()
    },
    restore: () => {
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
      Date.now = real.now
    }
  }
}

/** Lets the reads a tick started finish and the panel draw them. */
async function settle(v: TestPanel): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await v.settled()
}

test('the stages of the focused project come from the worker over the fake cli', async () => {
  const f = fake([
    { match: 'sdd list', stdout: json(LIST) },
    { match: 'epic agents', stdout: json(AGENTS) },
    { match: 'api projects get', stdout: json({ handle: HANDLE, canonical_name: 'pers/shop' }) }
  ])
  mkdirSync(join(f.root, '.claude'))
  writeFileSync(join(f.root, '.claude', 'settings.local.json'), JSON.stringify({ env: { CONPORT_PROJECT_NAME: 'shop-api' } }))
  const worker = await mountWorker(f.worker, { host: f.host() })
  // The panel's requests go to the real worker, which runs the fake CLI.
  const forward = (name: string) => (input: never) => worker.request(name as never, input)
  const names = ['projects.list', 'sdd.list', 'agents.get', 'project.page', 'row.session']
  view = await mount(panel, { host: mockHost({ requests: Object.fromEntries(names.map((n) => [n, forward(n)])) as never }) })

  const calls = f.conportCalls()
  assert.deepEqual(calls.find((c) => c[0] === 'sdd'), ['sdd', 'list', '-p', 'shop-api', '--json'])
  // No list of the tabs the panel had: no epic list, no task list.
  assert.deepEqual(calls.filter((c) => (c[0] === 'epic' && c[1] === 'list') || c[0] === 'task'), [])
  assert.deepEqual(sectionsOf(view), [
    ['In work · 2', 'spec + plan'],
    ['Specs · 2', 'spec, no plan'],
    ['Ideas · 6', 'not worked through'],
    ['Outside SDD · 1', 'no spec']
  ])
  assert.deepEqual(groupsOf(view), ['In work: Release 2.4', 'In work: No milestone', 'Specs', 'Ideas'])
  // The list reads nothing of an epic: its tasks and its subagent types are read when it is opened.
  assert.deepEqual(calls.filter((c) => (c[0] === 'api' && c[1] === 'tasks') || c[1] === 'subagents' || c[1] === 'status'), [])
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
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'docs-api', root: DOCS.root })
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
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [])
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
    '.conport.local.json is not ignored by git: add it to .gitignore'
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
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: 'shop-api', root: ROOT }])
  assert.ok(view.find({ testId: 'epic:15' }))
  await view.unmount()

  // A broken settings file names no project: its lines say what to fix, and no binding is offered.
  const BROKEN = ['.conport.json is not valid JSON (line 1, column 29): fix it']
  const broken = stub({ 'projects.list': () => ok([{ ...DOCS, focused: true, source: 'file', lines: BROKEN }]) })
  view = await mount(panel, { host: broken.host })
  assert.equal(view.find({ testId: 'settings-lines' })?.text.includes(BROKEN[0] ?? '-'), true, textOf(view))
  assert.equal(view.find({ type: 'Input', label: 'ConPort project' }), null)
  assert.equal(view.find({ type: 'Card', label: 'ConPort project' })?.props.description, text.SETTINGS_BROKEN)
  assert.deepEqual(inputsOf(broken.calls, 'sdd.list'), [])

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
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: 'shop-api', root: ROOT }])
})

test('the focused project is selected first', async () => {
  const { host, calls } = stub({ 'projects.list': () => ok([BILLING, SHOP].map((p) => ({ ...p, focused: p === SHOP }))) })
  // The project chosen last loses to the one in focus.
  view = await mount(panel, { host, persisted: { plugin: { project: BILLING.root } } })
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: 'shop-api', root: ROOT }])
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
    assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: expected.project, root: expected.root }])
    await view.unmount()
    view = undefined
  }
  // Neither a folder nor a project without a binding counts as the first bound one.
  const { host, calls } = stub({ 'projects.list': () => ok([NOTES, DOCS, BILLING]) })
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: 'billing-api', root: BILLING.root }])
})

test('choosing another project reads its stages and keeps the epic open in each', async () => {
  const { host, calls } = stub({ 'projects.list': () => ok([SHOP, BILLING]) })
  view = await mount(panel, { host, persisted: at(15) })
  assert.deepEqual(inputsOf(calls, 'epic.session'), [{ project: HANDLE, root: ROOT, epic: 15 }])
  await pick(view, BILLING.root)
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // No epic is open in the second project: its sections show, no session is read.
  assert.equal(inputsOf(calls, 'epic.session').length, 1)
  assert.ok(view.find({ testId: 'epic:15' }))
  await pick(view, ROOT)
  // Back in the first project, its epic is open again.
  assert.deepEqual(inputsOf(calls, 'epic.session').at(-1), { project: HANDLE, root: ROOT, epic: 15 })
  assert.ok(view.find({ text: 'Start' }))
})

test('a slow answer for a project left meanwhile is dropped', async () => {
  const billingEpics: SddList = {
    ...EMPTY_SDD,
    project: 'prbi11ngq2',
    in_work: [{ id: 30, title: 'Invoices', status: 'TODO', progress: { open: 2, total: 2 }, milestone: null, ready: false, reason: null, spec: null, idea: null }]
  }
  const pending: Array<() => void> = []
  let first = true
  const { host, calls } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'sdd.list': (input: { root: string }) => {
      if (first) {
        first = false
        return ok(LIST)
      }
      const answer = ok(input.root === BILLING.root ? billingEpics : LIST)
      return new Promise((resolve) => pending.push(() => resolve(answer)))
    },
    'epic.start': () => ok({ terminal: 't', worktree: '/repo/epic-15' })
  })
  view = await mount(panel, { host, persisted: at(15) })
  await openPicker(view, BILLING.root)
  // Billing, then Shop again before the stages of Billing came; they come last.
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
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'billing-api', root: BILLING.root })
  // Once Orca no longer lists it, the project opens as on the first load: the one in focus.
  listed = [SHOP]
  await view.press({ label: 'Refresh' })
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'shop-api', root: ROOT })
})

test('a reload with no project to open on keeps the one chosen last remembered', async () => {
  let listed: OrcaProject[] = [BILLING]
  const { host, calls } = stub({ 'projects.list': () => ok(listed) })
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [{ project: 'billing-api', root: BILLING.root }])
  listed = [NOTES]
  await view.press({ label: 'Refresh' })
  assert.equal(inputsOf(calls, 'sdd.list').length, 1)
  // Back in the list, the project chosen last opens before the first bound one.
  listed = [unfocused(SHOP), BILLING]
  await view.press({ label: 'Refresh' })
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'billing-api', root: BILLING.root })
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

/** An epic In work that never ran, in `m`, with two tasks open. */
const epic = (id: number, m: Milestone | null, extra: Partial<InWorkRow> = {}): InWorkRow => ({
  id,
  title: `Epic ${id}`,
  status: 'TODO',
  progress: { open: 2, total: 2 },
  milestone: m,
  ready: false,
  reason: null,
  spec: null,
  idea: null,
  ...extra
})

/** A project with only these epics In work. */
const inWork = (...epics: InWorkRow[]): SddList => ({ ...EMPTY_SDD, in_work: epics })

test('In work groups its epics by milestone in roadmap order', async () => {
  const later = milestone(4, 'Later', 9)
  const sooner = milestone(8, 'Sooner', 1)
  const list = inWork(epic(20, null), epic(21, later), epic(22, sooner), epic(24, sooner), epic(25, later))
  const { host } = stub({ 'sdd.list': () => ok(list) })
  view = await mount(panel, { host })
  // Milestones by their place in the roadmap, not by id or by the order of the epics; the epics
  // outside a milestone last.
  assert.deepEqual(groupsOf(view), ['In work: Sooner', 'In work: Later', 'In work: No milestone'])
  const titles = (label: string) => itemsIn(view as TestPanel, label).map(([title]) => title)
  assert.deepEqual(titles('In work: Sooner'), ['22 · Epic 22', '24 · Epic 24'])
  assert.deepEqual(titles('In work: Later'), ['21 · Epic 21', '25 · Epic 25'])
  assert.deepEqual(titles('In work: No milestone'), ['20 · Epic 20'])
  assert.equal(sectionsOf(view)[0]?.[0], 'In work · 5')
})

test('an epic In work with several specs or plans cannot start and does not show the reason of the CLI', async () => {
  const { host } = stub({ 'sdd.list': () => ok(inWork(epic(30, null, { reason: 'several specs' }), epic(31, null))) })
  view = await mount(panel, { host })
  const row = view.find({ testId: 'epic:30' })
  assert.equal(row?.props.description, 'Cannot start: more than one spec or plan')
  assert.equal(row?.props.disabled, true)
  doesNotMatch(textOf(view), /several specs/)
  // Remembered as open, it is not: the list shows.
  await view.unmount()
  view = await mount(panel, { host, persisted: at(30) })
  assert.equal(view.find({ text: '← Sections' }), null)
  assert.ok(view.find({ testId: 'epic:31' }))
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
  const { host } = stub({ 'sdd.list': () => ok(inWork(...milestones.map((m, i) => epic(30 + i, m)))) })
  view = await mount(panel, { host })
  const said = Object.fromEntries(milestones.map((m) => [m.title, view?.find({ testId: `release:in_work:${m.id}` })?.text ?? null]))
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
  const list = inWork(
    epic(40, null, { progress: { open: 7, total: 7 } }),
    epic(41, null, { progress: { open: 1, total: 1 } }),
    // One task closed: in progress. An epic IN_PROGRESS is taken, said by the time of its change.
    epic(43, null, { progress: { open: 18, total: 26 } }),
    // Every task closed, and no entry of the core that the epic is ready: still in progress.
    epic(44, null, { progress: { open: 0, total: 6 } }),
    // No task at all is not ready to merge.
    epic(45, null, { progress: { open: 0, total: 0 } }),
    // The core found it ready to merge.
    epic(46, null, { progress: { open: 0, total: 5 }, ready: true })
  )
  const { host } = stub({ 'sdd.list': () => ok(list) })
  view = await mount(panel, { host })
  const row = (id: number) => view?.find({ testId: `epic:${id}` })
  assert.deepEqual(
    [40, 41, 43, 44, 45, 46].map((id) => row(id)?.props.description),
    [
      'Not started · 7 tasks',
      'Not started · 1 task',
      'In progress · 8 of 26 closed',
      'In progress · 6 of 6 closed',
      'Not started · 0 tasks',
      'Ready to merge · 5 of 5 closed'
    ]
  )
  // Only an epic in progress draws the share of closed tasks.
  const bars = view.findAll({ type: 'Progress' }).map((p) => [p.props.label, p.props.value])
  assert.deepEqual(bars, [
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
const started = () => ok({ terminal: 'term-9', worktree: '/repo/.claude/worktrees/repo/epic-15' })

/** The type chosen in each of the four role lists, top to bottom, and whether each list is off. */
const typesOf = (v: TestPanel): unknown[] => ROLE_LABELS.map((label) => v.find({ label })?.props.value)
const listsOff = (v: TestPanel): boolean[] => ROLE_LABELS.map((label) => v.find({ label })?.props.disabled === true)
const startOf = (v: TestPanel) => v.find({ text: 'Start' })
/** The notice over the panel, and the line of the epic screen that says where the live agent is. */
/** The message of a Callout: its text after the title the kit reads first. */
function messageOf(v: TestPanel, testId: string): string | null {
  const box = v.find({ testId })
  if (!box) return null
  const title = String(box.props.title ?? '')
  return title && box.text.startsWith(`${title} `) ? box.text.slice(title.length + 1) : box.text
}
const noticeOf = (v: TestPanel): string | null => messageOf(v, 'notice')
const aliveOf = (v: TestPanel): string | null => messageOf(v, 'session-alive')
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
  assert.ok(view.find({ text: '← Sections' }))
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

test('the epic screen offers the harness and four roles with the default types, and no mode', async () => {
  const { host } = stub({ 'agents.get': () => ok(WITH_CURSOR) })
  view = await mount(panel, { host, persisted: at(15) })
  // The SDD skill is the only way an epic is done: there is no switch to choose another.
  assert.equal(view.find({ label: 'Mode' }), null)
  assert.deepEqual(view.findAll({ type: 'RadioGroup' }), [])
  assert.equal(view.find({ testId: 'way-needs-claude' }), null)
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
  // Top to bottom: the harness, the roles, the start, the tasks.
  const drawn = textOf(view)
  const places = ['"Harness"', '"Implementer"', '"Reviewer"', '"Gap hunter"', '"Final reviewer"', 'Fixes: the same implementer', '"Start"', 'Epic tasks'].map((s) => drawn.indexOf(s))
  assert.equal(places.includes(-1), false, JSON.stringify(places))
  assert.deepEqual(places, [...places].sort((a, b) => a - b))
  // The words of the dispatcher and of the removed mode are gone.
  doesNotMatch(drawn, /Checker|Final check|Command|remembered for the project/)
  doesNotMatch(drawn, /\bMode\b|[Ww]orkflow|SDD skill/)
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
  await view.press({ text: '← Sections' })
  await view.press({ testId: 'epic:7' })
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'claude')
  assert.deepEqual(typesOf(view), DEFAULT_TYPES)
  await view.select({ label: 'Harness' }, 'codex')
  // Back in the first epic its own choice stands, though nothing was started.
  await view.press({ text: '← Sections' })
  await view.press({ testId: 'epic:15' })
  assert.equal(view.find({ label: 'Harness' })?.props.value, 'claude')
  assert.deepEqual(typesOf(view), ['sdd-task-reviewer', ...DEFAULT_TYPES.slice(1)])
  // A choice not sent by a start is the panel's own: nothing was asked to keep it.
  assert.deepEqual([...new Set(calls.map((c) => c.name))].sort(), ['agents.get', 'epic.session', 'epic.tasks', 'project.page', 'projects.list', 'row.session', 'sdd.list', 'subagents.get'])
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
    assert.equal(view.find({ label: 'Harness' }), null, code)
    assert.deepEqual(inputsOf(calls, 'subagents.get'), [], code)
    // The tasks are ConPort's and are drawn all the same.
    assert.equal(headingOf(view, 3), 'Tasks · 6', code)
    assert.equal(itemsIn(view, 'Epic tasks').length, 7, code)
    fails = false
    await view.press({ label: 'Refresh' })
    assert.equal(view.findAll({ type: 'Callout' }).some((c) => c.props.tone === 'danger'), false, code)
    assert.equal(startOf(view)?.props.disabled, false, code)
    assert.ok(view.find({ label: 'Harness' }), code)
    await view.unmount()
    view = undefined
  }
})

test('every harness that takes a task starts the epic by the SDD skill', async () => {
  for (const harness of ['codex', 'cursor']) {
    const { host, calls } = stub({ 'agents.get': () => ok(WITH_CURSOR), 'epic.session': () => ok(session({ harness })), 'epic.start': () => started() })
    view = await mount(panel, { host, persisted: at(15) })
    // No harness is held back for a mode: there is none.
    assert.equal(startOf(view)?.props.disabled, false, harness)
    assert.equal(view.find({ testId: 'way-needs-claude' }), null, harness)
    await view.press({ text: 'Start' })
    const roles = { implementer: DEFAULT_TYPES[0], reviewer: DEFAULT_TYPES[1], gapHunter: DEFAULT_TYPES[2], finalReviewer: DEFAULT_TYPES[3] }
    assert.deepEqual(inputsOf(calls, 'epic.start'), [{ ...EPIC, harness, roles }], harness)
    await view.unmount()
    view = undefined
  }
})

test('start sends the harness and the roles, no way, and says where the agent is', async () => {
  // The session is read anew after the start; here the agent is not yet seen in its terminal.
  const { host, calls } = stub({ 'epic.start': () => started() })
  view = await mount(panel, { host, persisted: at(15) })
  await view.select({ label: 'Reviewer' }, 'sdd-task-reviewer')
  await view.press({ text: 'Start' })
  assert.deepEqual(inputsOf(calls, 'epic.start'), [
    {
      ...EPIC,
      harness: 'claude',
      roles: {
        implementer: DEFAULT_TYPES[0],
        reviewer: 'sdd-task-reviewer',
        gapHunter: DEFAULT_TYPES[2],
        finalReviewer: DEFAULT_TYPES[3]
      }
    }
  ])
  assert.equal(noticeOf(view), 'The agent of epic 15 is open in the terminal of working copy epic-15; it asks its questions there')
  assert.equal(view.find({ testId: 'notice' })?.props.title, 'Done')
  doesNotMatch(textOf(view), /Agents are starting|the reason will be there/)
  // The screen read the session and the tasks again, and the types of the harness not again.
  assert.deepEqual(['epic.session', 'epic.tasks', 'subagents.get'].map((name) => inputsOf(calls, name).length), [2, 2, 1])
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
  await view.unmount()
  // A refused start leaves the button to try again.
  const refusing = stub({ 'epic.start': () => refused('root_not_open', 'The repository root /repo is not open in Orca', 'Add the repository to Orca.') })
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
})

test('a live session offers its terminal and a second start only after a yes', async () => {
  const { host, calls } = stub({ 'epic.session': () => ok(SESSION_ALIVE), 'epic.start': () => started() })
  view = await mount(panel, { host, persisted: at(7) })
  assert.equal(startOf(view), null)
  assert.ok(view.find({ text: 'Show terminal' }))
  assert.equal(aliveOf(view), 'The agent of epic 7 is open in the terminal of working copy epic-7; it asks its questions there')
  assert.equal(view.find({ testId: 'session-alive' })?.props.title, 'Agent at work')
  await view.press({ text: 'Start again' })
  assert.deepEqual(inputsOf(calls, 'epic.start'), [])
  assert.equal(view.find({ testId: 'confirm-again' })?.props.title, 'Start epic 7 again?')
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ testId: 'confirm-again' }), null)
  assert.deepEqual(inputsOf(calls, 'epic.start'), [])
  await view.press({ text: 'Start again' })
  await view.press({ text: 'Yes, start' })
  assert.deepEqual((inputsOf(calls, 'epic.start') as Array<{ epic: number }>).map(({ epic }) => epic), [7])
  assert.equal(view.find({ testId: 'confirm-again' }), null)
  // A session a start by an earlier release of the panel left in the root of the repository: no working copy.
  await view.unmount()
  const old = stub({ 'epic.session': () => ok(session({ alive: true, terminal: 'term-root' })) })
  view = await mount(panel, { host: old.host, persisted: at(7) })
  assert.equal(aliveOf(view), 'The agent of epic 7 is open in a terminal at the repository root; it asks its questions there')
  assert.equal(startOf(view), null)
  assert.ok(view.find({ text: 'Show terminal' }))
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
  // The epic goes with its spec and its idea, whose terminals it inherits.
  assert.deepEqual(inputsOf(calls, 'terminal.show'), [{ project: HANDLE, root: ROOT, row: { kind: 'epic', id: 7, spec: 18, idea: null } }])
  assert.equal(view.findAll({ type: 'Callout' }).some((c) => c.props.tone === 'danger'), false)
  gone = true
  await view.press({ text: 'Show terminal' })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, 'Epic 7 has no live session: its terminal is closed or its agent has exited')
  assert.ok(box?.text.includes('Press Refresh.'), box?.text)
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

test('the notice goes on refresh, on leaving the epic, on opening a sheet, on another project and when the session is alive', async () => {
  const NOTICE = 'The agent of epic 15 is open in the terminal of working copy epic-15; it asks its questions there'
  /** A panel on epic 15 just started, its agent not yet seen: the notice stands. */
  const afterStart = async (): Promise<TestPanel> => {
    const { host } = stub({ 'projects.list': () => ok([SHOP, BILLING]), 'epic.start': () => started(), 'idea.start': () => ok({ terminal: 'term-1' }) })
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
  await v.press({ text: '← Sections' })
  assert.equal(noticeOf(v), null, 'leaving the epic')
  // The notice of an idea started goes when another sheet opens.
  await v.press({ testId: 'brainstorm:task-41' })
  await v.press({ text: 'Open in terminal' })
  assert.match(noticeOf(v) ?? '', /conport idea 41/)
  await v.press({ testId: 'review:42' })
  assert.equal(noticeOf(v), null, 'a sheet')
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
  const sessions = [session(), SESSION_COPY, SESSION_ALIVE, session({ harness: 'codex' })]
  for (const state of sessions) {
    const { host, calls } = stub({ 'epic.session': () => ok(state) })
    view = await mount(panel, { host, persisted: at(7) })
    assert.ok(view.find({ label: 'Harness' }))
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
  const { host } = stub({ 'sdd.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  // Said in the panel's words by the code of the refusal, with its one action; the CLI's English never shows.
  assert.equal(box?.props.title, 'No ConPort API key')
  assert.ok(box?.text.includes('Add the ConPort API key to ~/.config/conport/conport.key and try again.'), box?.text)
  assert.match(JSON.stringify(box), /no_api_key/)
  doesNotMatch(textOf(view), /is not set|put CONPORT_API_KEY/)
})

/** The words for a refusal the panel does not know: they name no program, it may be conport or orca. */
const UNKNOWN_WHAT = 'A program refused for a reason the panel does not know'
const UNKNOWN_ACTION = 'Press Refresh; if the refusal repeats, update the plugin and Orca.'

test('the worker words these refusals itself, and no other', () => {
  // The whole list: a code taken out of it, or one a removed start left in it, shows here.
  assert.deepEqual([...text.OWN_REFUSALS].sort(), [
    'agent_cannot_prepare',
    'agent_not_found',
    'bad_output',
    'empty_project',
    'epic_branch_taken',
    'epic_not_found',
    'epic_not_ready',
    'git_failed',
    'harness_invalid',
    'idea_taken',
    'no_repository',
    'no_spec',
    'no_workspace',
    'not_a_proposal',
    'not_an_idea',
    'project_not_handle',
    'proposal_accepted',
    'proposal_closed',
    'reason_missing',
    'role_invalid',
    'root_detached',
    'root_not_open',
    'session_gone',
    'spec_planned',
    'task_moved',
    'task_not_found',
    'terminals_truncated',
    'worker',
    'workspace_ambiguous',
    'workspaces_truncated'
  ])
})

test('every refused action says the panel words: the cli by its code, the worker in its own words', async () => {
  const own = (code: string, message: string, action: string): [{ code: string; message: string; action: string }, string, string] => [{ code, message, action }, message, action]
  const refusals: Array<[{ code: string; message: string; action: string }, string, string]> = [
    // A CLI code the panel knows, from any of the actions.
    [{ code: 'conport_unreachable', message: 'ConPort did not answer (fetch failed)', action: 'check the network and run the command again' }, 'ConPort did not answer', 'Check the network and try again.'],
    [{ code: 'http_502', message: 'ConPort answered 502: bad gateway', action: 'run the command again in a few minutes' }, 'ConPort answered with an error', 'Wait a few minutes and try again.'],
    [{ code: 'subagents_unavailable', message: 'claude plugin list did not answer', action: 'install Claude Code or make claude visible on the PATH, then run the command again' }, 'No answer from claude plugin list', "Install Claude Code or make claude visible on the Orca app's PATH, and try again."],
    [{ code: 'command_removed', message: 'conport epic run was removed in 0.7.0', action: 'start the epic from the ConPort Epics panel of Orca' }, 'The plugin called a command the CLI no longer has', 'Update the plugin.'],
    // A task another person leads: one line, what is wrong and the one action.
    [{ code: 'task_assigned_to_other', message: "Pick another task, or pass take_over=true only on your person's word", action: '' }, 'The task is led by another person', 'Pick another task, or take it over on your word.'],
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
    own('epic_not_ready', 'Epic 15 has no spec or no plan', 'Plan it from the Specs section.'),
    own('role_invalid', 'The subagent type is not a plain name', 'Choose a type for the role from the list.'),
    own('root_detached', "The repository's main working copy is not on a branch, so the epic has no base", 'Check out a branch in the main working copy.'),
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
    'command_removed', 'runtime_unavailable', 'runtime_timeout', 'unexpected_answer', 'terminal_not_found', 'task_assigned_to_other'
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
  assert.deepEqual(said('task_assigned_to_other'), text.REFUSED.assignedToOther)
  assert.deepEqual(text.REFUSED.assignedToOther, { what: 'The task is led by another person', action: 'Pick another task, or take it over on your word.' })
  assert.equal(text.oneLine(text.REFUSED.assignedToOther), 'The task is led by another person — pick another task, or take it over on your word.')
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
  assert.equal(calls.filter((c) => c.name === 'sdd.list').length, 1)
  doesNotMatch(textOf(view), /Orca did not answer/)
})

test('four sections in order with counts and captions, Outside SDD folded', async () => {
  const { host } = stub({})
  view = await mount(panel, { host })
  assert.deepEqual(sectionsOf(view), [
    ['In work · 2', 'spec + plan'],
    ['Specs · 2', 'spec, no plan'],
    ['Ideas · 6', 'not worked through'],
    ['Outside SDD · 1', 'no spec']
  ])
  assert.deepEqual(['in_work', 'specs', 'ideas', 'outside'].map((key) => view?.find({ testId: `section:${key}` })?.props.open), [true, true, true, false])
  // What a folded section holds is not drawn.
  assert.equal(view.find({ testId: 'outside:50' }), null)
  assert.deepEqual(itemsIn(view, 'Specs'), [
    [`doc-${30} · Archive export`, 'Spec of idea 6'],
    ['9 · Audit log', 'Epic with a spec, no plan']
  ])
  // Ideas by priority, the proposal after the tasks of priority 3; the bug marked.
  assert.deepEqual(
    itemsIn(view, 'Ideas').map(([title]) => title),
    ['41 · Rotate the backup key', '42 · Compare the metrics after the release', '43 · Check the backups', '46 · Simplify the search answer', `doc-${301} · Proposal: Search in the archive`, '47 · Read the old exports']
  )
  await fold(view, 'outside')
  assert.deepEqual(itemsIn(view, 'Outside SDD: No milestone'), [
    ['50 · Checks after the release', 'Not started · 1 task'],
    ['51 · Compare the latency', 'High · not started']
  ])
  assert.deepEqual(buttonsOf(view, 'task:51'), ['Hand to agent'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('an empty project says so in each section', async () => {
  const { host } = stub({ 'sdd.list': () => ok(EMPTY_SDD) })
  view = await mount(panel, { host, persisted: { plugin: { sections: { outside: false } } } })
  assert.deepEqual(sectionsOf(view).map(([title]) => title), ['In work · 0', 'Specs · 0', 'Ideas · 0', 'Outside SDD · 0'])
  for (const line of Object.values(text.EMPTY_SECTION)) assert.ok(view.find({ text: line }), line)
  assert.equal(view.find({ text: 'Start' }), null)
})

test('folding is kept in the plugin storage', async () => {
  const { host } = stub({})
  view = await mount(panel, { host })
  await fold(view, 'specs')
  await fold(view, 'outside')
  assert.deepEqual(view.persisted.plugin.sections, { specs: true, outside: false })
  assert.equal(view.find({ testId: `spec:doc-${30}` }), null)
  assert.ok(view.find({ testId: 'outside:50' }))
  // The next run of the panel opens them as they were left.
  const kept = view.persisted.plugin.sections
  await view.unmount()
  view = await mount(panel, { host: stub({}).host, persisted: { plugin: { sections: kept } } })
  assert.deepEqual(['in_work', 'specs', 'ideas', 'outside'].map((key) => view?.find({ testId: `section:${key}` })?.props.open), [true, false, true, true])
})

test('a taken row says In progress · updated and offers Show terminal when this host opened it, else Take over', async () => {
  // This host opened the terminal of idea 43; epic 7 was taken from another client.
  const { host, calls } = stub({
    'sdd.list': () => ok(SDD_LIST),
    'row.session': (input: RowTarget) => ok({ terminal: input.row.kind === 'idea' && input.row.id === 43 ? 'term-43' : null }),
    'terminal.show': () => ok(null)
  })
  view = await mount(panel, { host })
  const line = (iso: string) => text.updatedLine(iso, new Date())
  assert.equal(view.find({ testId: 'idea:43' })?.props.description, `${text.BUG_LABEL} · ${line('2026-11-16T10:00:00Z')}`)
  assert.deepEqual(buttonsOf(view, 'idea:43'), ['Show terminal'])
  assert.equal(view.find({ testId: 'epic:7' })?.props.description, line('2026-11-16T09:12:00Z'))
  assert.match(String(view.find({ testId: 'epic:7' })?.props.description), /^In progress · updated /)
  // An idea back from review is in progress and not taken: its fixes are due.
  assert.equal(view.find({ testId: 'idea:46' })?.props.description, 'Changes requested')
  assert.deepEqual(buttonsOf(view, 'idea:46'), ['Fix'])
  // Blocked: nothing to press; to do: Brainstorm; in review: Review.
  assert.deepEqual(buttonsOf(view, 'idea:47'), [])
  assert.equal(view.find({ testId: 'idea:47' })?.props.description, 'Blocked')
  assert.deepEqual(buttonsOf(view, 'idea:41'), ['Brainstorm'])
  assert.deepEqual(buttonsOf(view, 'idea:42'), ['Review'])
  // The terminals asked for: the ideas waiting or taken, the specs, every epic In work that can start.
  const asked = (inputsOf(calls, 'row.session') as RowTarget[]).map(({ row }) => row)
  assert.deepEqual(asked, [
    { kind: 'idea', id: 41 },
    { kind: 'idea', id: 43 },
    { kind: 'spec', doc: 30, idea: 6 },
    { kind: 'epic', id: 9, spec: 22, idea: null },
    { kind: 'epic', id: 7, spec: 18, idea: null },
    { kind: 'epic', id: 15, spec: 20, idea: 5 }
  ])
  await view.press({ testId: 'show:task-43' })
  assert.deepEqual(inputsOf(calls, 'terminal.show'), [{ project: HANDLE, root: ROOT, row: { kind: 'idea', id: 43 } }])
  await view.unmount()
  // Without a terminal of this host the taken idea offers Take over.
  const elsewhere = stub({ 'sdd.list': () => ok(SDD_LIST) })
  view = await mount(panel, { host: elsewhere.host })
  assert.deepEqual(buttonsOf(view, 'idea:43'), ['Take over'])
  // A spec whose plan this host writes shows its terminal; the taken epic of a spec offers Take over.
  await view.unmount()
  const list = copy(SDD_LIST)
  const ofEpic = list.specs[1]
  if (ofEpic) ofEpic.status = 'IN_PROGRESS'
  const writing = stub({ 'sdd.list': () => ok(list), 'row.session': (input: RowTarget) => ok({ terminal: input.row.kind === 'spec' ? 'term-30' : null }) })
  view = await mount(panel, { host: writing.host })
  assert.deepEqual(buttonsOf(view, `spec:doc-${30}`), ['Show terminal', 'Open spec'])
  assert.deepEqual(buttonsOf(view, 'spec:epic-9'), ['Take over', 'Open spec'])
})

test('a spec document whose idea this host brainstormed shows Show terminal, not Plan & build', async () => {
  // The brainstorm of idea 6 wrote spec 30 and goes on to its plan in the same terminal: the worker
  // finds that terminal by the idea the panel names with the spec.
  const { host, calls } = stub({
    'sdd.list': () => ok(SDD_LIST),
    'row.session': (input: RowTarget) => ok({ terminal: input.row.kind === 'spec' && input.row.idea === 6 ? 'term-6' : null }),
    'terminal.show': () => ok(null)
  })
  view = await mount(panel, { host })
  assert.deepEqual(buttonsOf(view, `spec:doc-${30}`), ['Show terminal', 'Open spec'])
  await view.press({ testId: `show:doc-${30}` })
  assert.deepEqual(inputsOf(calls, 'terminal.show'), [{ project: HANDLE, root: ROOT, row: { kind: 'spec', doc: 30, idea: 6 } }])
})

test('Take over asks Another session may be working on it first', async () => {
  const { host, calls } = stub({ 'sdd.list': () => ok(SDD_LIST), 'idea.start': () => ok({ terminal: 'term-1' }) })
  view = await mount(panel, { host })
  await view.press({ testId: 'take-over:task-43' })
  // Asked first: nothing is opened yet.
  const box = view.find({ testId: 'take-over' })
  assert.equal(box?.props.title, 'Another session may be working on it')
  assert.equal(view.find({ testId: 'sheet' }), null)
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ testId: 'take-over' }), null)
  // After the yes, the same start as Brainstorm.
  await view.press({ testId: 'take-over:task-43' })
  await view.press({ text: 'Yes, take over' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Check the backups”')
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'idea.start'), [{ project: HANDLE, root: ROOT, task: 43, agent: 'claude' }])
  await view.unmount()
  // An epic In work taken elsewhere is taken over from its screen, asked the same way.
  const epicCalls = stub({ 'sdd.list': () => ok(SDD_LIST), 'epic.start': () => started() })
  view = await mount(panel, { host: epicCalls.host })
  await view.press({ testId: 'epic:7' })
  assert.equal(view.find({ text: 'Start' }), null)
  await view.press({ text: 'Take over' })
  assert.equal(view.find({ testId: 'confirm-take-over' })?.props.title, 'Another session may be working on it')
  assert.deepEqual(inputsOf(epicCalls.calls, 'epic.start'), [])
  await view.press({ text: 'Yes, take over' })
  assert.deepEqual((inputsOf(epicCalls.calls, 'epic.start') as Array<{ epic: number }>).map(({ epic }) => epic), [7])
})

const ANN: Assignee = { handle: 'usann2345a', email: 'ann@example.com', former_member: false }
const ME = 'usme234567'

/**
 * SDD_LIST as `sdd list` answers it in a shared team, the caller `me`: idea 43, epic 7 and the epic
 * of spec 22 in progress, each led by `lead` (null: by nobody).
 */
function ledList(lead: Assignee | null): SddList {
  const list = copy(SDD_LIST)
  list.me = ME
  for (const idea of list.ideas) idea.assignee = idea.id === 43 ? lead : null
  for (const epic of list.in_work) epic.assignee = epic.id === 7 ? lead : null
  for (const spec of list.specs) {
    if (spec.epic === 9) {
      spec.status = 'IN_PROGRESS'
      spec.assignee = lead
    }
  }
  return list
}

/** The light read of ledList: the taken rows with the same lead. */
const ledTaken = (lead: Assignee | null): TakenList => ({
  project: HANDLE,
  taken: [7, 9, 43].map((id) => ({ id, kind: id === 43 ? ('bug' as const) : ('epic' as const), updated_at: '2026-11-16T10:00:00Z', assignee: lead }))
})

test('rows show the assignee name', async () => {
  const list = copy(SDD_LIST)
  list.me = ME
  const bob: Assignee = { handle: 'usbob2345b', email: null, former_member: false }
  const at = <T extends { id: number }>(rows: T[], id: number): T => rows.find((row) => row.id === id) as T
  at(list.ideas, 41).assignee = ANN
  // A person without an email is named by the handle.
  at(list.ideas, 43).assignee = bob
  at(list.in_work, 7).assignee = ANN
  const ofEpic = list.specs[1]
  if (ofEpic) ofEpic.assignee = ANN
  const outside = list.outside[0]
  if (outside) {
    outside.assignee = ANN
    const task = outside.tasks[0]
    if (task) task.assignee = ANN
  }
  const { host } = stub({ 'sdd.list': () => ok(list) })
  view = await mount(panel, { host })
  await fold(view, 'outside')
  const line = (iso: string) => text.updatedLine(iso, new Date())
  assert.equal(view.find({ testId: 'idea:41' })?.props.description, 'High · not started · ann@example.com')
  assert.equal(view.find({ testId: 'idea:43' })?.props.description, `${text.BUG_LABEL} · ${line('2026-11-16T10:00:00Z')} · usbob2345b`)
  assert.equal(view.find({ testId: 'epic:7' })?.props.description, `${line('2026-11-16T09:12:00Z')} · ann@example.com`)
  assert.equal(view.find({ testId: 'spec:epic-9' })?.props.description, 'Epic with a spec, no plan · ann@example.com')
  assert.equal(view.find({ testId: 'outside:50' })?.props.description, 'Not started · 1 task · ann@example.com')
  assert.equal(view.find({ testId: 'task:51' })?.props.description, 'High · not started · ann@example.com')
  // A row nobody leads says what it said.
  assert.equal(view.find({ testId: 'idea:42' })?.props.description, 'In review')
  assert.equal(view.find({ testId: 'epic:15' })?.props.description, 'Not started · 4 tasks')
  // The light read is newer: the lead it names stands on the row. The first panel goes before the
  // clock is caught, so its own timer is cleared for real.
  await view.unmount()
  view = undefined
  const clock = clockAndTimer()
  try {
    const light = stub({ 'sdd.list': () => ok(list), 'sdd.taken': () => ok({ ...TAKEN, taken: TAKEN.taken.map((row) => ({ ...row, assignee: row.id === 43 ? ANN : null })) }) })
    view = await mount(panel, { host: light.host })
    clock.tick()
    await settle(view)
    assert.match(String(view.find({ testId: 'idea:43' })?.props.description), / · ann@example\.com$/)
    assert.equal(String(view.find({ testId: 'epic:7' })?.props.description).includes('ann@example.com'), false)
  } finally {
    clock.restore()
  }
})

test('a foreign taken row asks "<name> leads this task. Take it over?" and starts with --take-over on yes', async () => {
  const clock = clockAndTimer()
  try {
    await foreignTakeOver(clock)
  } finally {
    clock.restore()
  }
})

/** The body of the test above, under the clock of the panel it moves. */
async function foreignTakeOver(clock: ReturnType<typeof clockAndTimer>): Promise<void> {
  const { host, calls } = stub({ 'sdd.list': () => ok(ledList(ANN)), 'idea.start': () => ok({ terminal: 'term-1' }), 'spec.start': () => ok({ terminal: 'term-2' }) })
  view = await mount(panel, { host })
  await view.press({ testId: 'take-over:task-43' })
  assert.equal(view.find({ testId: 'take-over' })?.props.title, 'ann@example.com leads this task. Take it over?')
  assert.equal(view.find({ testId: 'sheet' }), null)
  // Cancel starts nothing.
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ testId: 'take-over' }), null)
  await view.press({ testId: 'take-over:task-43' })
  await view.press({ text: 'Yes, take over' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Check the backups”')
  // The list read in full while the sheet is open keeps the sheet, and the yes with it.
  const reads = inputsOf(calls, 'sdd.list').length
  clock.tick(FULL_READ_MS)
  await settle(view)
  assert.equal(inputsOf(calls, 'sdd.list').length, reads + 1)
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Check the backups”')
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'idea.start'), [{ project: HANDLE, root: ROOT, task: 43, agent: 'claude', takeOver: true }])
  // The epic of a spec, the same way.
  await view.press({ testId: 'take-over:epic-9' })
  assert.equal(view.find({ testId: 'take-over' })?.props.title, 'ann@example.com leads this task. Take it over?')
  await view.press({ text: 'Yes, take over' })
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'spec.start'), [{ project: HANDLE, root: ROOT, target: { epic: 9 }, agent: 'claude', takeOver: true }])
  // Brainstorm of a row nobody took is no take over, whoever is named on another row.
  await view.press({ testId: 'brainstorm:task-41' })
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'idea.start')[1], { project: HANDLE, root: ROOT, task: 41, agent: 'claude' })
  await view.unmount()
  // An epic In work led by another person is asked the same from its screen.
  const epic = stub({ 'sdd.list': () => ok(ledList(ANN)), 'epic.start': () => started() })
  view = await mount(panel, { host: epic.host })
  await view.press({ testId: 'epic:7' })
  await view.press({ text: 'Take over' })
  assert.equal(view.find({ testId: 'confirm-take-over' })?.props.title, 'ann@example.com leads this task. Take it over?')
  assert.deepEqual(inputsOf(epic.calls, 'epic.start'), [])
  await view.press({ text: 'Yes, take over' })
  assert.deepEqual(
    (inputsOf(epic.calls, 'epic.start') as Array<{ epic: number; takeOver?: boolean }>).map(({ epic: id, takeOver }) => ({ id, takeOver })),
    [{ id: 7, takeOver: true }]
  )
}

test('an own taken row keeps today\'s Take over', async () => {
  // Led by the caller, and led by nobody: the question of today, and a start without the flag.
  for (const lead of [{ ...ANN, handle: ME }, null]) {
    const { host, calls } = stub({ 'sdd.list': () => ok(ledList(lead)), 'sdd.taken': () => ok(ledTaken(lead)), 'idea.start': () => ok({ terminal: 'term-1' }), 'epic.start': () => started() })
    view = await mount(panel, { host })
    await view.press({ testId: 'take-over:task-43' })
    assert.equal(view.find({ testId: 'take-over' })?.props.title, text.TAKE_OVER_CONFIRM)
    await view.press({ text: 'Yes, take over' })
    await view.press({ text: 'Open in terminal' })
    assert.deepEqual(inputsOf(calls, 'idea.start'), [{ project: HANDLE, root: ROOT, task: 43, agent: 'claude' }])
    await view.press({ testId: 'epic:7' })
    await view.press({ text: 'Take over' })
    assert.equal(view.find({ testId: 'confirm-take-over' })?.props.title, text.TAKE_OVER_CONFIRM)
    await view.press({ text: 'Yes, take over' })
    assert.equal('takeOver' in (inputsOf(calls, 'epic.start')[0] as object), false)
    await view.unmount()
    view = undefined
  }
})

test('a caller the CLI could not name makes no row foreign: today\'s Take over, no --take-over', async () => {
  // The list names a lead, but not the caller (a 4xx on /me): as in the dashboard, nobody is another person.
  const list = ledList(ANN)
  list.me = null
  const { host, calls } = stub({ 'sdd.list': () => ok(list), 'idea.start': () => ok({ terminal: 'term-1' }), 'epic.start': () => started() })
  view = await mount(panel, { host })
  await view.press({ testId: 'take-over:task-43' })
  assert.equal(view.find({ testId: 'take-over' })?.props.title, text.TAKE_OVER_CONFIRM)
  await view.press({ text: 'Yes, take over' })
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'idea.start'), [{ project: HANDLE, root: ROOT, task: 43, agent: 'claude' }])
  await view.press({ testId: 'epic:7' })
  await view.press({ text: 'Take over' })
  assert.equal(view.find({ testId: 'confirm-take-over' })?.props.title, text.TAKE_OVER_CONFIRM)
  await view.press({ text: 'Yes, take over' })
  assert.equal('takeOver' in (inputsOf(calls, 'epic.start')[0] as object), false)
})

test('Brainstorm of an idea calls idea.start, of a proposal proposal.start', async () => {
  const { host, calls } = stub({
    'agents.get': () => ok({ agents: [...AGENTS.agents, CURSOR], launcher: 'codex' }),
    'idea.start': () => ok({ terminal: 'term-1' }),
    'proposal.start': () => ok({ terminal: 'term-2', task: 61 })
  })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  // The sheet: what the agent does, and which agent; the one of last time first.
  const sheet = view.find({ testId: 'sheet' })
  assert.equal(sheet?.props.title, 'Brainstorm “Rotate the backup key”')
  assert.equal(sheet?.props.description, '41 · idea')
  const steps = view.findAll({ type: 'Row' }).filter((r) => r.key?.startsWith('step:'))
  assert.equal(steps.length, 3)
  assert.match(steps[2]?.text ?? '', /Writing the plan means building right after it\. Plan and build now\?/)
  const radio = view.find({ label: 'Who brainstorms' })
  assert.equal(radio?.props.value, 'codex')
  assert.deepEqual(radio?.props.options, [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex', description: 'last time' },
    { value: 'cursor', label: 'Cursor' }
  ])
  await view.select({ label: 'Who brainstorms' }, 'claude')
  const before = inputsOf(calls, 'sdd.list').length
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'idea.start'), [{ project: HANDLE, root: ROOT, task: 41, agent: 'claude' }])
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.match(view.find({ testId: 'notice' })?.text ?? '', /Brainstorm of task 41 is open in terminal “conport idea 41” of repository “Shop”/)
  // The list is read again right after the start.
  assert.equal(inputsOf(calls, 'sdd.list').length, before + 1)
  // A proposal: accepted and brainstormed by the worker; the notice names the idea it became.
  await view.press({ testId: `brainstorm:doc-${301}` })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Proposal: Search in the archive”')
  assert.match(textOf(view), /Takes the proposal into design: finds or files its idea/)
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'proposal.start'), [{ project: HANDLE, root: ROOT, doc: 301, agent: 'claude' }])
  assert.match(view.find({ testId: 'notice' })?.text ?? '', /Brainstorm of task 61 is open in terminal “conport idea 61”/)
  assert.deepEqual(view.errors, [])
})

test('a refused start says why and keeps the sheet', async () => {
  const { host, calls } = stub({
    'idea.start': () => refused('idea_taken', 'Task 41 is past brainstorming: it is in review, blocked or closed', 'Press Refresh.')
  })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  const reads = inputsOf(calls, 'sdd.list').length
  await view.press({ text: 'Open in terminal' })
  const box = view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')
  assert.equal(box?.props.title, 'Task 41 is past brainstorming: it is in review, blocked or closed')
  assert.ok(view.find({ testId: 'sheet' }))
  // Nothing was started: the list is not read again.
  assert.equal(inputsOf(calls, 'sdd.list').length, reads)
})

test('Decline sends nothing without a reason', async () => {
  const { host, calls } = stub({ 'proposal.decline': () => ok(null) })
  view = await mount(panel, { host })
  await view.press({ testId: `decline:doc-${301}` })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Decline “Proposal: Search in the archive”')
  const decline = () => view?.findAll({ type: 'Button' }).find((b) => b.text === 'Decline' && b.path.startsWith(`${view?.find({ testId: 'sheet' })?.path}/`))
  // No agent is offered: no agent is started.
  assert.equal(view.find({ type: 'RadioGroup' }), null)
  assert.equal(decline()?.props.disabled, true)
  await view.type({ label: 'Reason' }, '   ')
  assert.equal(decline()?.props.disabled, true)
  assert.deepEqual(inputsOf(calls, 'proposal.decline'), [])
  await view.type({ label: 'Reason' }, 'Out of scope for this year', { replace: true })
  assert.equal(decline()?.props.disabled, false)
  await view.press(decline() as never)
  assert.deepEqual(inputsOf(calls, 'proposal.decline'), [{ project: HANDLE, root: ROOT, doc: 301, reason: 'Out of scope for this year' }])
  assert.equal(view.find({ testId: 'sheet' }), null)
  assert.equal(noticeOf(view), `Proposal doc-${301} is declined with your reason.`)
  assert.deepEqual(inputsOf(calls, 'idea.start'), [])
})

test('Plan & build of a spec document and of an epic calls spec.start', async () => {
  const { host, calls } = stub({ 'spec.start': () => ok({ terminal: 'term-1' }) })
  view = await mount(panel, { host })
  assert.deepEqual(buttonsOf(view, `spec:doc-${30}`), ['Plan & build', 'Open spec'])
  await view.press({ testId: `plan:doc-${30}` })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Plan & build “Archive export”')
  assert.equal(view.find({ testId: 'sheet' })?.props.description, `doc-${30} · spec, no plan`)
  assert.equal(view.find({ label: 'Who plans and builds' })?.props.value, 'claude')
  await view.press({ text: 'Open in terminal' })
  assert.match(view.find({ testId: 'notice' })?.text ?? '', new RegExp(`Spec doc-${30} is open in terminal “conport spec doc-${30}”`))
  await view.press({ testId: 'plan:epic-9' })
  assert.equal(view.find({ testId: 'sheet' })?.props.description, '9 · spec, no plan')
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'spec.start'), [
    { project: HANDLE, root: ROOT, target: { doc: 30 }, agent: 'claude' },
    { project: HANDLE, root: ROOT, target: { epic: 9 }, agent: 'claude' }
  ])
  assert.match(view.find({ testId: 'notice' })?.text ?? '', /The spec of epic 9 is open in terminal “conport spec 9”/)
})

test('Open spec opens the document in the dashboard', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  assert.deepEqual(inputsOf(calls, 'project.page'), [{ project: HANDLE, root: ROOT }])
  await view.press({ testId: `open-spec:doc-${30}` })
  await view.press({ testId: 'open-spec:epic-9' })
  assert.deepEqual(view.host.callsOf('shell.openExternal'), [
    { url: `https://me.conport.app/t/pers/p/${HANDLE}/documents?id=30` },
    { url: `https://me.conport.app/t/pers/p/${HANDLE}/documents?id=22` }
  ])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
  // Without the address of the project nothing can be opened, and its refusal is not in the way.
  const away = stub({ 'project.page': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host: away.host })
  assert.equal(view.find({ testId: `open-spec:doc-${30}` })?.props.disabled, true)
  assert.equal(view.findAll({ type: 'Callout' }).some((c) => c.props.tone === 'danger'), false)
})

test('the light read runs every minute while the panel is visible, a changed set starts the full read, the full read every 10 minutes', async () => {
  const clock = clockAndTimer()
  try {
    let taken: TakenList = TAKEN
    const { host, calls } = stub({ 'sdd.list': () => ok(SDD_LIST), 'sdd.taken': () => ok(taken) })
    view = await mount(panel, { host })
    assert.equal(clock.at(POLL_TAKEN_MS).length, 1)
    assert.equal(inputsOf(calls, 'sdd.list').length, 1)
    // The same set: only the light read.
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.deepEqual(inputsOf(calls, 'sdd.taken'), [{ project: HANDLE, root: ROOT }])
    assert.equal(inputsOf(calls, 'sdd.list').length, 1)
    // Idea 41 taken in another client: marked by the light read alone, no full read.
    taken = { ...TAKEN, taken: [...TAKEN.taken, { id: 41, kind: 'task', updated_at: '2026-11-16T11:00:00Z' }] }
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 1)
    assert.match(String(view.find({ testId: 'idea:41' })?.props.description), /^In progress · updated /)
    assert.deepEqual(buttonsOf(view, 'idea:41'), ['Take over'])
    // A number the list does not hold: the full read.
    taken = { ...TAKEN, taken: [...TAKEN.taken, { id: 99, kind: 'task', updated_at: '2026-11-16T11:00:00Z' }] }
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
    // Hidden, the panel reads nothing.
    taken = TAKEN
    await view.setVisible(false)
    const hidden = inputsOf(calls, 'sdd.taken').length
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.taken').length, hidden)
    await view.setVisible(true)
    await until(() => inputsOf(calls, 'sdd.list').length === 3)
    await view.settled()
    // Ten minutes after the last full read the tick reads the whole list, not the light one.
    const light = inputsOf(calls, 'sdd.taken').length
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 4)
    assert.equal(inputsOf(calls, 'sdd.taken').length, light)
    // A minute short of the next ten: the light read again.
    clock.tick(FULL_READ_MS - POLL_TAKEN_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 4)
    assert.equal(inputsOf(calls, 'sdd.taken').length, light + 1)
    // The timer goes with the panel.
    await view.unmount()
    view = undefined
    assert.equal(clock.at(POLL_TAKEN_MS).length, 0)
  } finally {
    clock.restore()
  }
})

test('a tick while a read runs starts nothing', async () => {
  const clock = clockAndTimer()
  try {
    const pending: Array<() => void> = []
    const { host, calls } = stub({
      'sdd.taken': () => new Promise((resolve) => pending.push(() => resolve(ok(TAKEN))))
    })
    view = await mount(panel, { host })
    clock.tick(POLL_TAKEN_MS)
    await until(() => pending.length === 1)
    // The light read is still out: the next tick, and one ten minutes on, start no other read.
    clock.tick(POLL_TAKEN_MS)
    clock.tick(FULL_READ_MS)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(inputsOf(calls, 'sdd.taken').length, 1)
    assert.equal(inputsOf(calls, 'sdd.list').length, 1)
    pending[0]?.()
    await settle(view)
    // Once it is back, the next tick reads again: ten minutes have passed, the whole list.
    clock.tick()
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
  } finally {
    clock.restore()
  }
})

test('a full read that fails while a list is shown keeps the list and says why above it; the next good read clears it', async () => {
  const clock = clockAndTimer()
  try {
    let answer: Result<SddList> = ok(SDD_LIST)
    const { host, calls } = stub({ 'sdd.list': () => answer, 'sdd.taken': () => ok(TAKEN) })
    view = await mount(panel, { host })
    const danger = (): string | undefined => view?.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')?.props.title as string | undefined
    assert.ok(view.find({ testId: 'idea:41' }))
    assert.equal(danger(), undefined)
    // The full read of the ten minutes fails: the list stays, the refusal above it.
    answer = { ok: false, error: NO_KEY }
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
    assert.ok(view.find({ testId: 'idea:41' }))
    assert.deepEqual(buttonsOf(view, 'idea:41'), ['Brainstorm'])
    assert.equal(danger(), 'No ConPort API key')
    // The list shown goes on with its light read.
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.taken').length, 1)
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
    // The next full read that succeeds clears the refusal.
    answer = ok(SDD_LIST)
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 3)
    assert.equal(danger(), undefined)
    assert.ok(view.find({ testId: 'idea:41' }))
  } finally {
    clock.restore()
  }
})

test('a full read that fails while a sheet or the Take over question is open keeps it open', async () => {
  const clock = clockAndTimer()
  try {
    let answer: Result<SddList> = ok(SDD_LIST)
    const { host } = stub({ 'sdd.list': () => answer, 'sdd.taken': () => ok(TAKEN) })
    view = await mount(panel, { host })
    // The Brainstorm sheet of idea 41 is open when the full read of the ten minutes fails.
    await view.press({ testId: 'brainstorm:task-41' })
    assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Rotate the backup key”')
    answer = { ok: false, error: NO_KEY }
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Rotate the backup key”')
    await view.press({ text: 'Cancel' })
    // The question Take over asks of idea 43 stays as well.
    await view.press({ testId: 'take-over:task-43' })
    assert.equal(view.find({ testId: 'take-over' })?.props.title, 'Another session may be working on it')
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(view.find({ testId: 'take-over' })?.props.title, 'Another session may be working on it')
  } finally {
    clock.restore()
  }
})

test('a first full read that fails, with no list shown, shows the refusal and no section', async () => {
  const { host } = stub({ 'sdd.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  assert.equal(view.findAll({ type: 'Callout' }).find((c) => c.props.tone === 'danger')?.props.title, 'No ConPort API key')
  assert.equal(view.find({ testId: 'idea:41' }), null)
})

test('an epic In work started from its spec on this host shows the terminal it inherits on its screen, never Take over', async () => {
  // Plan & build from this Orca: the plan imported, the epic taken by the session that planned it.
  const { host, calls } = stub({
    'sdd.list': () => ok(SDD_LIST),
    'row.session': (input: RowTarget) => ok({ terminal: input.row.kind === 'epic' && input.row.id === 7 ? 'term-spec' : null }),
    'terminal.show': () => ok(null),
    'epic.start': () => started()
  })
  view = await mount(panel, { host })
  // The epic goes with its spec and its idea: the worker finds the terminal it inherits.
  assert.ok((inputsOf(calls, 'row.session') as RowTarget[]).some(({ row }) => row.kind === 'epic' && row.id === 7 && row.spec === 18))
  // The row opens the screen on a press, and holds no button: Show terminal is there.
  assert.deepEqual(buttonsOf(view, 'epic:7'), [])
  await view.press({ testId: 'epic:7' })
  // Its own session is not seen; the one of its spec is alive: Show terminal and Start again.
  assert.equal(view.find({ text: 'Take over' }), null)
  assert.equal(aliveOf(view), text.inheritedNotice(7))
  await view.press({ text: 'Show terminal' })
  const shown = { project: HANDLE, root: ROOT, row: { kind: 'epic', id: 7, spec: 18, idea: null } }
  assert.deepEqual(inputsOf(calls, 'terminal.show'), [shown])
  assert.ok(view.find({ text: 'Start again' }))
  // No second lead session was opened.
  assert.deepEqual(inputsOf(calls, 'epic.start'), [])
  await view.unmount()
  // Without that terminal the epic taken elsewhere offers Take over on its screen.
  const elsewhere = stub({ 'sdd.list': () => ok(SDD_LIST) })
  view = await mount(panel, { host: elsewhere.host })
  await view.press({ testId: 'epic:7' })
  assert.ok(view.find({ text: 'Take over' }))
})

test('a taken epic In work ready to merge says so, on its row and on its screen', async () => {
  const list = copy(SDD_LIST)
  const ready = list.in_work[0] as InWorkRow
  ready.ready = true
  ready.progress = { open: 0, total: 6 }
  assert.equal(ready.status, 'IN_PROGRESS')
  const { host } = stub({ 'sdd.list': () => ok(list) })
  view = await mount(panel, { host })
  assert.equal(view.find({ testId: 'epic:7' })?.props.description, 'Ready to merge · 6 of 6 closed')
  await view.press({ testId: 'epic:7' })
  assert.equal(view.find({ testId: 'epic-state' })?.text, 'Ready to merge · 6 of 6 closed')
  await view.press({ text: '← Sections' })
  // Not ready, the same epic says when its session last changed it.
  await view.unmount()
  view = await mount(panel, { host: stub({ 'sdd.list': () => ok(SDD_LIST) }).host })
  assert.match(String(view.find({ testId: 'epic:7' })?.props.description), /^In progress · updated /)
})

test('an idea the list holds in review or blocked and the light read names taken offers Take over', async () => {
  const clock = clockAndTimer()
  try {
    const list = copy(SDD_LIST)
    const blocked = list.ideas.find((t) => t.id === 47) as IdeaRow
    assert.equal(blocked.status, 'BLOCKED')
    const taken: TakenList = {
      ...TAKEN,
      taken: [...TAKEN.taken, { id: 42, kind: 'task', updated_at: '2026-11-16T11:00:00Z' }, { id: 47, kind: 'task', updated_at: '2026-11-16T11:05:00Z' }]
    }
    const { host, calls } = stub({ 'sdd.list': () => ok(list), 'sdd.taken': () => ok(taken) })
    view = await mount(panel, { host })
    assert.deepEqual([buttonsOf(view, 'idea:42'), buttonsOf(view, 'idea:47')], [['Review'], []])
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    // The light read is newer than the stage of the list: both are taken, and no full read was needed.
    assert.equal(inputsOf(calls, 'sdd.list').length, 1)
    for (const id of [42, 47]) {
      assert.deepEqual(buttonsOf(view, `idea:${id}`), ['Take over'], String(id))
      assert.match(String(view.find({ testId: `idea:${id}` })?.props.description), /^In progress · updated /)
    }
  } finally {
    clock.restore()
  }
})

test('a read asked while another runs waits for it: a start of its own never reads beside the timer', async () => {
  const clock = clockAndTimer()
  try {
    const pending: Array<() => void> = []
    let hold = false
    const { host, calls } = stub({
      'sdd.list': () => (hold ? new Promise((resolve) => pending.push(() => resolve(ok(LIST)))) : ok(LIST)),
      'idea.start': () => ok({ terminal: 'term-1' })
    })
    view = await mount(panel, { host })
    await view.press({ testId: 'brainstorm:task-41' })
    // The full read of the timer is out.
    hold = true
    clock.tick(FULL_READ_MS)
    await until(() => pending.length === 1)
    hold = false
    const starting = view.press({ text: 'Open in terminal' })
    await until(() => inputsOf(calls, 'idea.start').length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The read after the start waits for the one of the timer.
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
    pending[0]?.()
    await starting
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 3)
  } finally {
    clock.restore()
  }
})

test('after a full read that failed the timer reads the whole list again ten minutes on', async () => {
  const clock = clockAndTimer()
  try {
    let fail = true
    const { host, calls } = stub({ 'sdd.list': () => (fail ? { ok: false, error: NO_KEY } : ok(LIST)) })
    view = await mount(panel, { host })
    assert.equal(view.find({ testId: 'section:in_work' }), null)
    // Within the ten minutes nothing is read: no light read of a list there is none of.
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.deepEqual([inputsOf(calls, 'sdd.list').length, inputsOf(calls, 'sdd.taken').length], [1, 0])
    fail = false
    clock.tick(FULL_READ_MS)
    await settle(view)
    assert.equal(inputsOf(calls, 'sdd.list').length, 2)
    assert.ok(view.find({ testId: 'section:in_work' }))
  } finally {
    clock.restore()
  }
})

test('the Take over question goes once the row is released', async () => {
  const clock = clockAndTimer()
  try {
    let listed = SDD_LIST
    let taken: TakenList = TAKEN
    const { host } = stub({ 'sdd.list': () => ok(listed), 'sdd.taken': () => ok(taken) })
    view = await mount(panel, { host })
    await view.press({ testId: 'take-over:task-43' })
    assert.ok(view.find({ testId: 'take-over' }))
    // Still taken by the light read: the question stays.
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.ok(view.find({ testId: 'take-over' }))
    // Released: the light read no longer names it, and the list read again holds it to do.
    taken = { ...TAKEN, taken: TAKEN.taken.filter((row) => row.id !== 43) }
    listed = { ...SDD_LIST, ideas: SDD_LIST.ideas.map((t) => (t.id === 43 ? { ...t, status: 'TODO' as const } : t)) }
    clock.tick(POLL_TAKEN_MS)
    await settle(view)
    assert.equal(view.find({ testId: 'take-over' }), null)
    assert.equal(view.persisted.plugin.takeOver ?? null, null)
    assert.deepEqual(buttonsOf(view, 'idea:43'), ['Brainstorm'])
  } finally {
    clock.restore()
  }
})

test('skipped proposals are counted under Ideas', async () => {
  const { host } = stub({})
  view = await mount(panel, { host })
  assert.equal(view.find({ testId: 'skipped-proposals' })?.text, '1 proposal is not shown: its state line cannot be read')
  await view.unmount()
  const none = stub({ 'sdd.list': () => ok({ ...LIST, skipped_proposals: [] }) })
  view = await mount(panel, { host: none.host })
  assert.equal(view.find({ testId: 'skipped-proposals' }), null)
})

test('no Prepare or Write plan anywhere', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host, persisted: { plugin: { sections: { outside: false } } } })
  const screens = [textOf(view)]
  await view.press({ testId: `plan:doc-${30}` })
  screens.push(textOf(view))
  await view.press({ text: 'Cancel' })
  await view.press({ testId: 'epic:15' })
  screens.push(textOf(view))
  for (const screen of screens) doesNotMatch(screen, /Prepare|Write plan|Ready to run/)
  assert.deepEqual(calls.filter((c) => /^(epics|tasks)\.list$|^epic\.prepare$/.test(c.name)), [])
  assert.equal(view.find({ type: 'Tabs' }), null)
})

test('Start and the screen of an epic In work work as before', async () => {
  const { host, calls } = stub({ 'epic.start': () => started() })
  view = await mount(panel, { host })
  assert.deepEqual(buttonsOf(view, 'epic:15'), [])
  await view.press({ testId: 'epic:15' })
  assert.equal(headingOf(view, 2), 'Offline mode')
  assert.deepEqual(view.findAll({ type: 'Badge' }).map((b) => b.text), ['Spec ✓', 'Plan ✓'])
  await view.press({ text: 'Start' })
  assert.deepEqual((inputsOf(calls, 'epic.start') as Array<{ epic: number }>).map(({ epic }) => epic), [15])
  await view.press({ text: '← Sections' })
  assert.ok(view.find({ testId: 'section:in_work' }))
})

test('with no agent found nothing can be brainstormed, planned or handed', async () => {
  const none = AGENTS.agents.map((a) => ({ ...a, found: false }))
  const { host } = stub({ 'agents.get': () => ok({ agents: none }) })
  view = await mount(panel, { host, persisted: { plugin: { sections: { outside: false } } } })
  for (const id of ['brainstorm:task-41', `brainstorm:doc-${301}`, `plan:doc-${30}`, 'review:42', 'fix:46', 'hand:51']) {
    assert.equal(view.find({ testId: id })?.props.disabled, true, id)
  }
  // Declining starts no agent: it stays.
  assert.equal(view.find({ testId: `decline:doc-${301}` })?.props.disabled, false)
  // One line: what is wrong — the action, lowercase after the dash.
  assert.match(
    textOf(view),
    /Only Claude Code, Codex and Cursor take a task, and none of them was found — start the agent in this Orca workspace and press Refresh\./
  )
})

test('only an agent that takes a positional request is offered in the sheet', async () => {
  const withOpencode = [...AGENTS.agents, { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true }]
  const { host } = stub({ 'agents.get': () => ok({ agents: withOpencode, launcher: 'opencode' }) })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  const radio = view.find({ label: 'Who brainstorms' })
  assert.deepEqual((radio?.props.options as Array<{ value: string }>).map((o) => o.value), ['claude', 'codex'])
  // The one remembered for the project cannot take a task: the first that can is taken.
  assert.equal(radio?.props.value, 'claude')
})

test('the project is read again when the panel becomes visible', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  assert.equal(inputsOf(calls, 'sdd.list').length, 1)
  await view.setVisible(false)
  assert.equal(inputsOf(calls, 'sdd.list').length, 1)
  await view.setVisible(true)
  await until(() => inputsOf(calls, 'sdd.list').length === 2)
  assert.deepEqual(inputsOf(calls, 'sdd.list').at(-1), { project: 'shop-api', root: ROOT })
  // Refresh reads it again too: a spec written meanwhile shows.
  await view.press({ label: 'Refresh' })
  assert.equal(inputsOf(calls, 'sdd.list').length, 3)
})

test('a start answer for a project left is not drawn in the chosen one', async () => {
  const pending: Array<() => void> = []
  const { host } = stub({
    'projects.list': () => ok([SHOP, BILLING]),
    'idea.start': () => new Promise((resolve) => pending.push(() => resolve(ok({ terminal: 'term-1' }))))
  })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  const starting = view.press({ text: 'Open in terminal' })
  await until(() => pending.length === 1)
  await openPicker(view, BILLING.root)
  const toBilling = view.press({ testId: `project:${BILLING.root}` })
  await new Promise((resolve) => setTimeout(resolve, 30))
  pending[0]?.()
  await Promise.all([starting, toBilling])
  assert.equal(pickerOf(view)?.props.title, 'Billing')
  doesNotMatch(textOf(view), /conport idea 41/)
})

test('an agent picked by hand in the sheet stays when the panel comes back into view', async () => {
  const { host, calls } = stub({})
  view = await mount(panel, { host })
  await view.press({ testId: `plan:doc-${30}` })
  await view.select({ label: 'Who plans and builds' }, 'codex')
  await view.press({ text: 'Cancel' })
  await view.setVisible(false)
  await view.setVisible(true)
  await until(() => inputsOf(calls, 'agents.get').length === 2)
  await view.settled()
  await view.press({ testId: 'brainstorm:task-41' })
  assert.equal(view.find({ label: 'Who brainstorms' })?.props.value, 'codex')
})

test('an open sheet stays while its row still wants it, when the panel comes back into view and when it opens again', async () => {
  let listed = LIST
  const { host, calls } = stub({ 'sdd.list': () => ok(listed) })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  await view.select({ label: 'Who brainstorms' }, 'codex')
  const away = async (): Promise<void> => {
    const before = inputsOf(calls, 'agents.get').length
    await (view as TestPanel).setVisible(false)
    await (view as TestPanel).setVisible(true)
    await until(() => inputsOf(calls, 'agents.get').length === before + 1)
    await (view as TestPanel).settled()
  }
  await away()
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Rotate the backup key”')
  assert.equal(view.find({ label: 'Who brainstorms' })?.props.value, 'codex')
  // Kept for the next run of the panel, with the root of its project.
  const kept = view.persisted.plugin.sheet
  assert.deepEqual(kept, { root: ROOT, sheet: { kind: 'idea', idea: LIST.ideas[0] } })
  await view.unmount()
  view = await mount(panel, { host, persisted: { plugin: { sheet: kept } } })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Brainstorm “Rotate the backup key”')
  assert.equal(view.find({ label: 'Who brainstorms' })?.props.value, 'claude')
  // Taken to review meanwhile: the idea is past brainstorming, the sheet closes.
  listed = { ...LIST, ideas: LIST.ideas.map((t) => (t.id === 41 ? { ...t, status: 'REVIEW' as const } : t)) }
  await away()
  assert.equal(view.find({ testId: 'sheet' }), null)
  // A sheet of a spec stays while the spec waits for its plan, and closes once it is In work.
  listed = LIST
  await view.press({ label: 'Refresh' })
  await view.press({ testId: `plan:doc-${30}` })
  listed = { ...LIST, specs: LIST.specs.filter((s) => s.doc !== 30) }
  await away()
  assert.equal(view.find({ testId: 'sheet' }), null)
  // A sheet kept for another project is not shown in this one.
  await view.unmount()
  view = await mount(panel, { host: stub({}).host, persisted: { plugin: { sheet: { ...(kept as object), root: BILLING.root } } } })
  assert.equal(view.find({ testId: 'sheet' }), null)
})

test('choosing another project closes the sheet, and Refresh does too', async () => {
  const { host } = stub({ 'projects.list': () => ok([SHOP, BILLING]) })
  view = await mount(panel, { host })
  await view.press({ testId: 'brainstorm:task-41' })
  await pick(view, BILLING.root)
  assert.equal(view.find({ testId: 'sheet' }), null)
  await pick(view, ROOT)
  await view.press({ testId: 'brainstorm:task-41' })
  await view.press({ label: 'Refresh' })
  assert.equal(view.find({ testId: 'sheet' }), null)
})

test('an idea and a task of an epic outside SDD are handed to review or to fix, a task to do', async () => {
  const list = copy(LIST)
  const task = list.outside[0]?.tasks[0]
  if (task) task.kind = 'bug'
  const { host, calls } = stub({
    'sdd.list': () => ok(list),
    'agents.get': () => ok({ agents: AGENTS.agents, launcher: 'codex' }),
    'task.hand': () => ok({ terminal: 'term-1' })
  })
  view = await mount(panel, { host, persisted: { plugin: { sections: { outside: false } } } })
  assert.equal(view.find({ testId: 'task:51' })?.props.description, 'Bug · High · not started')
  await view.press({ testId: 'hand:51' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Hand to agent “Compare the latency”')
  assert.equal(view.find({ label: 'Who takes the task' })?.props.value, 'codex')
  // The agent works on a branch of its own and commits there; merging it is the person's.
  assert.match(textOf(view), /Does it on its own branch, in a separate working copy beside the repository, checks it and commits/)
  await view.press({ text: 'Open in terminal' })
  assert.match(textOf(view), /The work goes to a separate branch of the task, and you merge it\./)
  await view.press({ testId: 'review:42' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Review “Compare the metrics after the release”')
  assert.match(textOf(view), /Reviews the branch from the report/)
  await view.select({ label: 'Who reviews' }, 'claude')
  await view.press({ text: 'Open in terminal' })
  assert.match(textOf(view), /Review of task 42 is open in terminal “conport review 42” of repository “Shop”/)
  await view.press({ testId: 'fix:46' })
  assert.equal(view.find({ testId: 'sheet' })?.props.title, 'Fix “Simplify the search answer”')
  assert.match(textOf(view), /Continues on the task's branch, fixes and commits/)
  await view.press({ text: 'Open in terminal' })
  assert.deepEqual(inputsOf(calls, 'task.hand'), [
    { project: HANDLE, root: ROOT, task: 51, agent: 'codex', mode: 'do' },
    { project: HANDLE, root: ROOT, task: 42, agent: 'claude', mode: 'review' },
    { project: HANDLE, root: ROOT, task: 46, agent: 'claude', mode: 'fix' }
  ])
})

test('a list the cli cannot give is said once, with no section drawn', async () => {
  const { host, calls } = stub({ 'sdd.list': () => ({ ok: false, error: NO_KEY }) })
  view = await mount(panel, { host })
  const boxes = view.findAll({ type: 'Callout' }).filter((c) => c.props.tone === 'danger')
  assert.deepEqual(boxes.map((c) => c.props.title), ['No ConPort API key'])
  assert.equal(view.find({ testId: 'section:in_work' }), null)
  // Nothing else is read for a project the CLI could not read.
  assert.deepEqual([inputsOf(calls, 'agents.get'), inputsOf(calls, 'row.session')], [[], []])
})

test('a folder or unbound project offers no section', async () => {
  // A folder in focus is never chosen; an unbound project asks for its binding, no stages.
  const { host, calls } = stub({ 'projects.list': () => ok([{ ...NOTES, focused: true }, unfocused(DOCS)]) })
  view = await mount(panel, { host })
  assert.equal(view.find({ testId: 'section:ideas' }), null)
  await view.press({ text: 'Bind' })
  assert.ok(view.find({ label: 'ConPort project' }))
  assert.deepEqual(inputsOf(calls, 'sdd.list'), [])
})

const SOURCES = join(dirname(fileURLToPath(import.meta.url)))
const CYRILLIC = /[Ѐ-ӿ]/

test('no panel text is in russian', async () => {
  // Nothing the panel or the worker can show is: the sources hold no cyrillic letter.
  for (const file of ['panel.tsx', 'text.ts', 'worker.ts', 'cli.ts', 'sdd.ts']) {
    doesNotMatch(readFileSync(join(SOURCES, file), 'utf8'), CYRILLIC, file)
  }
  // Nor does any screen drawn: the sections, each window, the epic in each state of its session.
  // The proposal of the list is titled in English here: its title is the team's, not the panel's.
  const list = { ...SDD_LIST, proposals: [{ doc: 301, title: 'Search in the archive', author: 'Anna' }] }
  const screens: string[] = []
  const sessions = [session(), SESSION_COPY, SESSION_ALIVE, session({ harness: 'codex' })]
  for (const state of sessions) {
    const { host } = stub({ 'sdd.list': () => ok(list), 'epic.session': () => ok(state), 'epic.start': () => started() })
    view = await mount(panel, { host, persisted: { plugin: { sections: { outside: false } } } })
    screens.push(textOf(view))
    for (const id of ['brainstorm:task-41', `brainstorm:doc-${301}`, `decline:doc-${301}`, `plan:doc-${30}`, 'fix:46']) {
      await view.press({ testId: id })
      screens.push(textOf(view))
      await view.press({ text: 'Cancel' })
    }
    await view.press({ testId: 'take-over:task-43' })
    screens.push(textOf(view))
    await view.press({ text: 'Cancel' })
    await view.press({ testId: 'epic:7' })
    screens.push(textOf(view))
    if (view.find({ text: 'Start again' })) {
      await view.press({ text: 'Start again' })
      screens.push(textOf(view))
      await view.press({ text: 'Cancel' })
    } else if (view.find({ text: 'Take over' })) {
      await view.press({ text: 'Take over' })
      screens.push(textOf(view))
      await view.press({ text: 'Cancel' })
    }
    await view.press({ text: '← Sections' })
    await view.unmount()
    view = undefined
  }
  for (const screen of screens) doesNotMatch(screen, CYRILLIC)
})
