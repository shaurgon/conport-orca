// The worker against the fake conport and orca executables (test/fake-cli.mjs): every call
// spawns a real child process, as in Orca.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { AGENTS, EPIC_LIST, EPIC_TASKS, HANDLE, NO_KEY, SUBAGENTS, TASK_LIST } from '../test/fixtures'
import { type FakeAnswer, type FakeDirs, type WorktreeRow, fake, json, terminalList, worktreeList, worktreeRow } from '../test/fake'
import { CLI_VERSION, DEFAULT_ROLES, HANDLE_FORM, epicTask, epicWorkflowTask, handTask, prepareTask } from './cli'
import type { AgentKind, EpicList, EpicSession, EpicTask, HandMode, Result, Roles, TaskList, Way } from './protocol'
import { HARNESS_MISSING_ACTION, refusalText } from './text'

const NPX = `npx -y conport@${CLI_VERSION}`
const SWITCHED = { match: 'terminal switch --terminal term-1 ', stdout: json({ ok: true, result: {} }) }

const ROLES = { implementer: 'codex', reviewer: 'claude', gapHunter: 'claude', finalReviewer: 'gemini' }

function writeSettings(dir: string, value: unknown): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(value))
}

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'orca-plugin.json')

/**
 * Records the timers set while it is on that are neither fired nor cleared: what a worker leaves
 * scheduled after it answered. Real delays: a timer seconds away still counts as pending.
 */
function pendingTimers() {
  const real = { setTimeout, clearTimeout, setInterval, clearInterval }
  const pending = new Map<unknown, number>()
  const wrap = (set: typeof setTimeout | typeof setInterval, repeats: boolean) =>
    ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle: unknown = set(
        (...a: unknown[]) => {
          if (!repeats) pending.delete(handle)
          fn(...a)
        },
        ms,
        ...args
      )
      pending.set(handle, ms ?? 0)
      return handle
    }) as typeof setTimeout
  const clear = (fn: (handle: never) => void) => (handle: unknown) => {
    pending.delete(handle)
    fn(handle as never)
  }
  globalThis.setTimeout = wrap(real.setTimeout, false)
  globalThis.setInterval = wrap(real.setInterval, true) as unknown as typeof setInterval
  globalThis.clearTimeout = clear(real.clearTimeout) as typeof clearTimeout
  globalThis.clearInterval = clear(real.clearInterval) as typeof clearInterval
  return {
    delays: (): number[] => [...pending.values()],
    restore: (): void => {
      Object.assign(globalThis, real)
    }
  }
}

test('the worker polls nothing and shows no status bar item', async () => {
  // An epic with a live session and tasks in progress: the worker reads them when asked, never by itself.
  const f = fake(
    [
      { match: 'epic list', stdout: json(EPIC_LIST) },
      { match: 'epic agents', stdout: json(AGENTS) },
      { match: 'api tasks list', stdout: json({ tasks: EPIC_TASKS, total: EPIC_TASKS.length }) },
      { match: 'epic subagents', stdout: json(SUBAGENTS) }
    ],
    ({ root }) => [
      worktreeList(root, [worktreeRow(root, 'main', true), worktreeRow(join(dirname(root), 'epic-7'), 'epic-7')]),
      terminalList(join(dirname(root), 'epic-7'), [{ handle: 'term-epic', agentIdentity: 'claude' }]),
      { match: 'terminal create ', stdout: json({ ok: true, result: { terminal: { handle: 'term-epic' } } }) },
      { match: 'terminal switch --terminal term-epic ', stdout: json({ ok: true, result: {} }) }
    ],
    ({ root }) => [{ match: `-C ${root} for-each-ref `, stdout: 'refs/heads/epic-7\n' }]
  )
  const host = f.host({ 'agents.list': { agents: [] } }, { [`session:${HANDLE}:7`]: { terminal: 'term-epic', way: 'sdd' } })
  const timers = pendingTimers()
  try {
    const worker = await mountWorker(f.worker, { host })
    const epic = { project: HANDLE, root: f.root, epic: 7 }
    const answers = [
      await worker.request('epics.list', { project: HANDLE, root: f.root }),
      await worker.request('agents.get', { project: HANDLE, root: f.root }),
      await worker.request('epic.session', epic),
      await worker.request('epic.tasks', epic),
      await worker.request('subagents.get', { root: f.root, harness: 'claude' }),
      await worker.request('terminal.show', epic),
      await worker.request('epic.start', { ...epic, way: 'sdd', harness: 'claude', roles: DEFAULT_ROLES })
    ]
    // Every request did its work: a refusal would leave nothing to schedule and prove nothing.
    assert.deepEqual(answers.map((answer) => answer.ok), [true, true, true, true, true, true, true], JSON.stringify(answers))
    // Nothing is left scheduled once the answers are in: no read waits its turn, however far off.
    assert.deepEqual(timers.delays(), [])
    // Each read of ConPort was asked for by one request: none is repeated behind it.
    assert.deepEqual(f.conportCalls().map((call) => call.slice(0, 2).join(' ')), [
      'epic list', 'epic agents', 'api tasks', 'epic subagents', 'epic list', 'epic agents'
    ])
    assert.deepEqual(worker.posts, [])
    assert.deepEqual(host.callsOf('statusBar.update'), [])
    assert.deepEqual(host.callsOf('notifications.show'), [])
    await worker.deactivate()
  } finally {
    timers.restore()
  }
  // Nor does the manifest ask for a status bar item, an event or notifications.
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    contributes: Record<string, unknown>
    capabilities: Array<{ kind: string }>
  }
  assert.deepEqual(Object.keys(manifest.contributes), ['panels'])
  assert.deepEqual(manifest.capabilities.map((c) => c.kind).filter((k) => k.startsWith('notifications')), [])
})

type Worker = Awaited<ReturnType<typeof mountWorker>>

/** The fake repository as `projects.list` names it. */
const shop = (root: string, focused: boolean) => ({
  name: 'repo',
  root,
  kind: 'git',
  project: 'shop-api',
  source: 'repository',
  focused
})

/** The roots `projects.list` marks as in focus; the list itself must answer. */
async function focusedRoots(worker: Worker): Promise<string[]> {
  const answer = await worker.request('projects.list')
  assert.equal(answer.ok, true, JSON.stringify(answer))
  return answer.ok ? answer.data.filter((p) => p.focused).map((p) => p.root) : []
}

/** The orca calls made to find the focus: all but the list of repositories. */
const focusCalls = (f: ReturnType<typeof fake>): string[][] => f.orcaCalls().filter((c) => c[0] !== 'repo')

test('project comes from CONPORT_PROJECT_NAME of the repository settings', async () => {
  const f = fake([])
  // The settings of the main working tree count, not those of the focused worktree.
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  writeSettings(f.focused, { env: { CONPORT_PROJECT_NAME: 'somewhere-else' } })
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('projects.list'), { ok: true, data: [shop(f.root, true)] })
  await worker.deactivate()
})

test('the focus is found through the host, not from the folder of the plugin', async () => {
  const f = fake([])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  // What `active` would name from the worker's own folder: the plugin's repository.
  writeSettings(f.pluginRepo, { env: { CONPORT_PROJECT_NAME: 'the-plugin' } })
  const host = f.host({
    'workspace.readContext': { branch: 'feature', displayName: 'feature', terminals: [{ id: 'term_focus' }] }
  })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await focusedRoots(worker), [f.root])
  // The focused workspace is found through the host, then named to orca by its path; one
  // workspace of the focused name and branch needs no comparison of terminals.
  assert.equal(host.callsOf('workspace.readContext').length, 1)
  assert.deepEqual(focusCalls(f), [['worktree', 'show', '--worktree', `path:${f.focused}`, '--json']])
  await worker.deactivate()
})

test('the one workspace of the focused name is taken when no branch matches', async () => {
  const f = fake([])
  // A detached HEAD: the list names no branch for the focused worktree.
  const host = f.host({
    'workspace.list': {
      workspaces: [
        { id: 'ws-focus', kind: 'worktree', name: 'feature', path: f.focused, branch: null, hostId: null },
        { id: 'ws-root', kind: 'worktree', name: 'repo', path: f.root, branch: 'main', hostId: null }
      ],
      truncated: false
    }
  })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await focusedRoots(worker), [f.root])
  await worker.deactivate()
})

test('without a focused workspace none is guessed', async () => {
  const f = fake([])
  const named = (path: string, branch: string) => ({ id: path, kind: 'worktree', name: 'feature', path, branch, hostId: null })
  const list = (...workspaces: ReturnType<typeof named>[]) => ({ 'workspace.list': { workspaces, truncated: false } })
  // The focus has terminals: with no workspace to compare them with, orca is not asked.
  const focus = { branch: 'feature', displayName: 'feature', terminals: [{ id: 'term_focus' }] }
  const cases = [
    { 'workspace.readContext': null },
    { 'workspace.readContext': focus, 'workspace.list': { workspaces: [], truncated: false } },
    { 'workspace.readContext': focus, 'workspace.list': { workspaces: [], truncated: true } },
    // Two workspaces of the focused name and a focus without terminals: nothing tells them apart,
    // whether both are on the focused branch or neither is.
    list(named('/a/feature', 'feature'), named('/b/feature', 'feature')),
    list(named('/a/feature', 'hotfix'), named('/b/feature', 'main'))
  ]
  for (const results of cases) {
    const worker = await mountWorker(f.worker, { host: f.host(results) })
    assert.deepEqual(await focusedRoots(worker), [], JSON.stringify(results))
    await worker.deactivate()
  }
  assert.deepEqual(focusCalls(f), [])
})

const ELSEWHERE = '/elsewhere/main'
const UNAVAILABLE = { ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running' } }
const terminalsOf = (...handles: string[]) => json({ ok: true, result: { terminals: handles.map((handle) => ({ handle })) } })
const listElsewhere = (answer: Omit<FakeAnswer, 'match'>): FakeAnswer => ({
  match: `terminal list --worktree path:${ELSEWHERE} `,
  ...answer
})
// Any other `terminal list` is the one of the focused worktree.
const listFocused = (answer: Omit<FakeAnswer, 'match'>): FakeAnswer => ({ match: 'terminal list --worktree path:', ...answer })

/**
 * Two workspaces `main` on the branch `main`, as two repositories have them: one elsewhere,
 * one the focused worktree of the fake repository. The answers give their `orca terminal list`.
 */
function twoMains(elsewhere: FakeAnswer, focused: FakeAnswer, focusTerminals: string[]) {
  const f = fake([], [elsewhere, focused])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  const main = (id: string, path: string) => ({ id, kind: 'worktree', name: 'main', path, branch: 'main', hostId: null })
  const host = f.host({
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: focusTerminals.map((id) => ({ id })) },
    'workspace.list': { workspaces: [main('ws-elsewhere', ELSEWHERE), main('ws-focus', f.focused)], truncated: false }
  })
  return { f, host }
}

test('of workspaces sharing the focused name the one holding a focused terminal is taken', async () => {
  const { f, host } = twoMains(
    listElsewhere({ stdout: terminalsOf('term_other') }),
    listFocused({ stdout: terminalsOf('term_shell', 'term_focus') }),
    ['term_focus']
  )
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await focusedRoots(worker), [f.root])
  assert.deepEqual(focusCalls(f), [
    ['terminal', 'list', '--worktree', `path:${ELSEWHERE}`, '--limit', '10000', '--json'],
    ['terminal', 'list', '--worktree', `path:${f.focused}`, '--limit', '10000', '--json'],
    ['worktree', 'show', '--worktree', `path:${f.focused}`, '--json']
  ])
  await worker.deactivate()
})

test('a focused terminal found in no workspace or in two of the same name picks none', async () => {
  const cases = [
    // The terminals of the focus belong to neither workspace.
    [terminalsOf('term_other'), terminalsOf('term_shell'), ['term_focus']],
    // A terminal of the focus is listed for both.
    [terminalsOf('term_focus'), terminalsOf('term_focus'), ['term_focus']],
    // Each workspace holds one of the focused terminals.
    [terminalsOf('term_a'), terminalsOf('term_b'), ['term_a', 'term_b']]
  ] as const
  for (const [elsewhere, focused, focusTerminals] of cases) {
    const { f, host } = twoMains(listElsewhere({ stdout: elsewhere }), listFocused({ stdout: focused }), [...focusTerminals])
    const worker = await mountWorker(f.worker, { host })
    assert.deepEqual(await focusedRoots(worker), [])
    // Nothing picked: the repository of neither workspace is asked for.
    assert.equal(focusCalls(f).some((c) => c[0] === 'worktree'), false)
    await worker.deactivate()
  }
})

test('a workspace whose terminals orca cannot list does not match, the other still can', async () => {
  const { f, host } = twoMains(
    listElsewhere({ code: 1, stdout: json(UNAVAILABLE) }),
    listFocused({ stdout: terminalsOf('term_focus') }),
    ['term_focus']
  )
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await focusedRoots(worker), [f.root])
  await worker.deactivate()
})

test('a workspace orca cannot list beside one listed without a focused terminal picks none', async () => {
  const { f, host } = twoMains(
    listElsewhere({ code: 1, stdout: json(UNAVAILABLE) }),
    listFocused({ stdout: terminalsOf('term_shell') }),
    ['term_focus']
  )
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await focusedRoots(worker), [])
  await worker.deactivate()
})

test('when orca lists the terminals of no workspace none is focused and the projects still answer', async () => {
  const other = { ok: false, error: { code: 'other_refusal', message: 'second' } }
  const { f, host } = twoMains(
    listElsewhere({ code: 1, stdout: json(UNAVAILABLE) }),
    listFocused({ code: 1, stdout: json(other) }),
    ['term_focus']
  )
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await worker.request('projects.list'), { ok: true, data: [shop(f.root, false)] })
  await worker.deactivate()
})

test('without the repository setting the project is asked once and remembered', async () => {
  const f = fake([])
  writeSettings(f.root, { env: { OTHER: 'x' } })
  const worker = await mountWorker(f.worker, { host: f.host() })
  const listed = async () => {
    const answer = await worker.request('projects.list')
    return answer.ok ? answer.data.map((p) => [p.project, p.source]) : answer
  }

  assert.deepEqual(await listed(), [[null, null]])
  assert.deepEqual(await worker.request('project.set', { root: f.root, project: ' shop-api ' }), {
    ok: true,
    data: { root: f.root, project: 'shop-api', source: 'stored' }
  })
  assert.deepEqual(await listed(), [['shop-api', 'stored']])
  assert.deepEqual(await worker.request('project.forget', { root: f.root }), {
    ok: true,
    data: { root: f.root, project: null, source: null }
  })
  assert.deepEqual(await listed(), [[null, null]])
  await worker.deactivate()
})

test('an orca refusal while finding the focus leaves the projects listed with none focused', async () => {
  const f = fake([], [{ match: 'worktree show', code: 1, stdout: json(UNAVAILABLE) }])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('projects.list'), { ok: true, data: [shop(f.root, false)] })
  await worker.deactivate()
})

test('a host failing while finding the focus leaves the projects listed with none focused', async () => {
  for (const failing of ['workspace.readContext', 'workspace.list']) {
    const f = fake([])
    writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
    const host = f.host({
      [failing]: () => {
        throw hostError('unavailable', 'the workspace service is not running yet')
      }
    })
    const worker = await mountWorker(f.worker, { host })
    assert.deepEqual(await worker.request('projects.list'), { ok: true, data: [shop(f.root, false)] }, failing)
    await worker.deactivate()
  }
})

test('a repository orca lists without a kind is a git project', async () => {
  const f = fake([], (d) => [
    { match: 'repo list ', stdout: json({ ok: true, result: { repos: [{ id: 'repo-focus', displayName: 'repo', path: d.root }] } }) }
  ])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('projects.list'), { ok: true, data: [shop(f.root, true)] })
  await worker.deactivate()
})

test('a cli that cannot start names npx, Node.js and the PATH of the app', async () => {
  const { createWorker } = await import('./worker')
  const missing = createWorker({ conport: ['/nonexistent/bin/npx', '-y', 'conport'], orca: ['/nonexistent/bin/orca'], git: ['/nonexistent/bin/git'] })
  const worker = await mountWorker({ default: missing.activate, deactivate: missing.deactivate }, { host: mockHost() })
  const answer = await worker.request('epics.list', { project: 'p', root: '/' })
  assert.equal(answer.ok, false)
  if (!answer.ok) {
    assert.equal(answer.error.code, 'spawn_failed')
    assert.match(answer.error.message, /^npx: /)
    assert.match(answer.error.action, /Node\.js/)
    assert.match(answer.error.action, /PATH приложения Orca/)
  }
  await worker.deactivate()
})

test('a missing api key shows the cli refusal', async () => {
  const f = fake([
    {
      match: 'epic list',
      code: 2,
      stdout: json({ ok: false, error: NO_KEY }),
      stderr: `${NO_KEY.code}: ${NO_KEY.message} — ${NO_KEY.action}\n`
    }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  const answer = await worker.request('epics.list', { project: 'shop-api', root: f.root })
  assert.deepEqual(answer, { ok: false, error: NO_KEY })
  assert.deepEqual(f.conportCalls(), [['epic', 'list', '--project', 'shop-api', '--json']])
  await worker.deactivate()
})

test('the json refusal on standard output is read before the error stream', async () => {
  const f = fake([
    { match: 'epic list', code: 2, stdout: json({ ok: false, error: NO_KEY }), stderr: 'npm warn exec something\n' }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('epics.list', { project: 'p', root: f.root }), { ok: false, error: NO_KEY })
  await worker.deactivate()
})

test('a refusal printed only to the error stream is read from its one line', async () => {
  const f = fake([
    { match: 'epic list', code: 1, stderr: 'epic_busy: эпик 7 ведёт yuri — дождитесь конца его прогона\n' },
    { match: 'epic agents', code: 1, stderr: 'boom\n' }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('epics.list', { project: 'p', root: f.root }), {
    ok: false,
    error: { code: 'epic_busy', message: 'эпик 7 ведёт yuri', action: 'дождитесь конца его прогона' }
  })
  assert.deepEqual(await worker.request('agents.get', { project: 'p', root: f.root }), {
    ok: false,
    error: { code: 'cli_failed', message: 'boom', action: '' }
  })
  await worker.deactivate()
})

test('agents come from epic agents json with the agent that prepared last, and no roles of the project', async () => {
  const f = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
  // The record of the roles of a project, kept by earlier versions, is not read.
  const host = mockHost({ storage: { [`roles:${HANDLE}`]: ROLES, [`prepare:${HANDLE}`]: 'codex' } })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await worker.request('agents.get', { project: HANDLE, root: f.root }), {
    ok: true,
    data: { agents: AGENTS.agents, preparer: 'codex' }
  })
  assert.deepEqual(f.conportCalls(), [['epic', 'agents', '--json']])
  await worker.deactivate()
})

/** One agent of the focused workspace, as the host's `agents.list` answers it. */
const inOrca = (agent: string | null) => ({ terminalId: null, title: null, agent, state: 'working' as const, stateStartedAt: 1 })

test('an agent kind Orca has is found though the worker PATH lacks its command', async () => {
  // The PATH of Orca's app finds only Codex, which Orca does not run; Orca runs Claude Code and an
  // agent the CLI does not know. Orca adds to the list of the CLI, it never takes from it.
  const onPath = { agents: AGENTS.agents.map((a) => ({ ...a, found: a.id === 'codex' })) }
  const f = fake([{ match: 'epic agents', stdout: json(onPath) }])
  const host = f.host({ 'agents.list': { agents: [inOrca('claude'), inOrca(null), inOrca('aider')] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('agents.get', { project: HANDLE, root: f.root })

  assert.deepEqual(answer, {
    ok: true,
    data: {
      agents: [
        { id: 'claude', label: 'Claude Code', command: 'claude', found: true },
        { id: 'codex', label: 'Codex', command: 'codex', found: true },
        { id: 'gemini', label: 'Gemini CLI', command: 'gemini', found: false }
      ],
      preparer: null
    }
  })
  assert.equal(host.callsOf('agents.list').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('agents Orca cannot list leave the list of the CLI as it is', async () => {
  const f = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
  const host = f.host({
    'agents.list': () => {
      throw hostError('unavailable', 'the agent service is not running yet')
    }
  })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await worker.request('agents.get', { project: HANDLE, root: f.root }), {
    ok: true,
    data: { agents: AGENTS.agents, preparer: null }
  })
  await worker.deactivate()
})

test('epics list reads epic list json', async () => {
  const f = fake([{ match: 'epic list', stdout: json(EPIC_LIST) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('epics.list', { project: 'shop-api', root: f.root }), {
    ok: true,
    data: EPIC_LIST
  })
  await worker.deactivate()
})

/** `orca repo list` of a machine with four projects in Orca's own order, the focused repository second. */
function fourProjects(d: FakeDirs): FakeAnswer[] {
  const repos = [
    { id: 'repo-billing', displayName: 'Billing', path: join(d.dir, 'billing'), kind: 'git' },
    { id: 'repo-focus', displayName: 'Shop', path: d.root, kind: 'git' },
    { id: 'repo-notes', displayName: 'Notes', path: join(d.dir, 'notes'), kind: 'folder' },
    { id: 'repo-docs', displayName: 'Docs', path: join(d.dir, 'docs'), kind: 'git' }
  ]
  return [{ match: 'repo list ', stdout: json({ ok: true, result: { repos } }) }]
}

test('projects follow the orca repo list order and names', async () => {
  const f = fake([], fourProjects)
  const dir = dirname(f.root)
  const [billing, notes, docs] = ['billing', 'notes', 'docs'].map((name) => join(dir, name))
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  // A folder is not read for a project: it cannot run an epic anyway.
  writeSettings(notes, { env: { CONPORT_PROJECT_NAME: 'notes-api' } })
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  // A project bound by the panel, the others as their settings name them.
  await worker.request('project.set', { root: billing, project: 'billing-api' })

  assert.deepEqual(await worker.request('projects.list'), {
    ok: true,
    data: [
      { name: 'Billing', root: billing, kind: 'git', project: 'billing-api', source: 'stored', focused: false },
      { name: 'Shop', root: f.root, kind: 'git', project: 'shop-api', source: 'repository', focused: true },
      { name: 'Notes', root: notes, kind: 'folder', project: null, source: null, focused: false },
      { name: 'Docs', root: docs, kind: 'git', project: null, source: null, focused: false }
    ]
  })
  // The focused workspace is matched to a project of the list by its repository id.
  assert.deepEqual(f.orcaCalls(), [
    ['repo', 'list', '--json'],
    ['worktree', 'show', '--worktree', `path:${f.focused}`, '--json']
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a focus orca cannot tell leaves the projects listed with none focused', async () => {
  const named = (path: string) => ({ id: path, kind: 'worktree', name: 'feature', path, branch: 'feature', hostId: null })
  const cases = [
    { 'workspace.readContext': null },
    { 'workspace.list': { workspaces: [named('/a/feature'), named('/b/feature')], truncated: false } }
  ]
  for (const results of cases) {
    const f = fake([], fourProjects)
    const worker = await mountWorker(f.worker, { host: f.host(results) })
    const answer = await worker.request('projects.list')
    assert.equal(answer.ok, true)
    if (answer.ok) {
      assert.deepEqual(answer.data.map((p) => p.name), ['Billing', 'Shop', 'Notes', 'Docs'])
      assert.deepEqual(answer.data.filter((p) => p.focused), [])
    }
    await worker.deactivate()
  }
})

test('a refusal of orca repo list is returned as is', async () => {
  const f = fake([], [{ match: 'repo list', code: 1, stdout: json(UNAVAILABLE) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('projects.list'), {
    ok: false,
    error: { code: 'runtime_unavailable', message: 'Orca is not running', action: '' }
  })
  await worker.deactivate()
})

/**
 * What the shell hands an agent from a terminal command: its arguments, the agent's command
 * a stub on the PATH that prints how many it got and each of them, NUL-separated.
 */
function argumentsOf(command: string): string[] {
  const program = command.split(' ')[0] ?? ''
  const bin = mkdtempSync(join(tmpdir(), 'conport-orca-bin-'))
  let out: string
  try {
    writeFileSync(join(bin, program), `#!/bin/sh\nprintf '%s' "$#"; for a in "$@"; do printf '\\0%s' "$a"; done\n`, { mode: 0o755 })
    out = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
  const [count, ...args] = out.split('\0')
  assert.equal(Number(count), args.length)
  return args
}

/**
 * Prepares `epic` of `list` with `agent` over the fake CLI; the answer, the terminal command
 * and the one argument the agent gets.
 */
async function prepare(epic: number, agent = 'claude', list: EpicList = EPIC_LIST, agents = AGENTS) {
  const f = fake([
    { match: 'epic list', stdout: json(list) },
    { match: 'epic agents', stdout: json(agents) }
  ], [SWITCHED])
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('epic.prepare', { project: 'shop-api', root: f.root, epic, agent })
  const created = host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string; command: string }>
  const command = created[0]?.command ?? ''
  const args = command === '' ? [] : argumentsOf(command)
  await worker.deactivate()
  return { f, host, worker, answer, created, command, args, task: args[0] ?? '' }
}

/** The ConPort commands of a task: every span in backquotes that starts one. */
const conportCommands = (task: string): string[] => [...task.matchAll(/`([^`]*conport@[^`]*)`/g)].map((m) => m[1] ?? '')

test('prepare opens the chosen agent in the project root with the task as one argument', async () => {
  const { f, answer, created, args, task, worker } = await prepare(10, 'codex')
  assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } })
  // A terminal of the repository root, the command of the chosen agent and one argument: the task.
  assert.deepEqual(created.map(({ workspaceId, title }) => ({ workspaceId, title })), [{ workspaceId: 'ws-root', title: 'conport prepare 10' }])
  assert.equal(args.length, 1)
  assert.equal(task, prepareTask({ epic: 10, project: HANDLE, missing: 'spec' }))
  // What the epic lacks is read afresh, its project named by the handle the CLI answered with.
  assert.deepEqual(f.conportCalls(), [['epic', 'list', '--project', 'shop-api', '--json'], ['epic', 'agents', '--json']])
  // The person talks with the agent there: the terminal comes to the front.
  assert.deepEqual(f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
  assert.deepEqual(worker.refusals, [])
})

test('the task for an epic without a spec asks for a spec, its upload and the plan import', async () => {
  const { task } = await prepare(10)
  assert.match(task, /^Prepare epic 10 of the ConPort project /)
  assert.match(task, /in the language they write in/)
  assert.match(task, /Store nothing in ConPort before they approve it/)
  assert.match(task, /Only after the person approved the spec, upload it: `[^`]* documents upload <spec file> --doc-type spec -p /)
  // The answer of the upload is JSON: its id is the number of the spec.
  assert.match(task, /Its answer is JSON; its `id` is the number of the new document: doc-<id>\./)
  assert.match(task, /import it: `[^`]* plan import <plan file> --spec doc-<id of the uploaded spec> --epic 10 -p /)
  // The plan is written in the form the import takes, with the gate the run needs.
  assert.match(task, /### Task <n>: <title>/)
  assert.match(task, /\*\*Goal:\*\*/)
  assert.match(task, /\*\*Acceptance:\*\*/)
  assert.match(task, /Gate object: \{"dir": "\.", "commands": \[/)
  // The spec is uploaded before the plan is imported.
  assert.ok(task.indexOf('documents upload') < task.indexOf('plan import'))
})

test('the task for an epic with a spec asks only for the plan and its import', async () => {
  const { task } = await prepare(9)
  assert.match(task, /^Prepare epic 9 of the ConPort project [^:]+: it has a spec, and needs a plan\./)
  assert.doesNotMatch(task, /documents upload/)
  // The spec is found by the links of the epic, its number goes to the import.
  assert.match(task, /`[^`]* api links list --item_type task --item_id 9 --project /)
  assert.match(task, /linked to the epic with `clarifies` whose type is `spec`/)
  assert.match(task, /`[^`]* plan import <plan file> --spec doc-<number of the spec> --epic 9 -p /)
})

test('the task binds the open tasks the epic keeps to their sections and closes the rest before the import', async () => {
  for (const epic of [9, 10]) {
    const { task } = await prepare(epic)
    // The tasks of the epic are read, every status, and the open ones are named.
    assert.match(task, new RegExp(`\`[^\`]* api tasks list --parent_task_id ${epic} --status ALL --include_snoozed true --limit 200 --project [^\`]+\``))
    assert.match(task, /Each task that is neither DONE nor CANCELLED is open\./)
    // The open tasks the plan keeps carry the marker the import binds by, right under their heading.
    assert.match(task, /The section of every open task the plan keeps has the line `<!-- conport-task: <id> -->` right under its `### Task <n>:` heading/)
    // The others are closed with the person's consent, before the import.
    assert.match(task, /close every other open task before the import, only with the person's consent: `[^`]* api tasks update --task_id <id> --status CANCELLED --project /)
    assert.match(task, /Only after the person approved the plan, and the open tasks it does not keep are closed, import it/)
    assert.ok(task.indexOf('tasks list --parent_task_id') < task.indexOf('plan import'))
  }
})

test('every conport command of the task carries the project and the pinned cli version', async () => {
  for (const epic of [9, 10]) {
    const { task } = await prepare(epic)
    const commands = conportCommands(task)
    assert.ok(commands.length >= 3, task)
    for (const command of commands) {
      assert.ok(command.startsWith(`${NPX} `), command)
      // The commands of the CLI take `-p`; its generic API commands name the project by `--project`.
      const project = command.startsWith(`${NPX} api `) ? `--project ${HANDLE}` : `-p ${HANDLE}`
      assert.ok(command.endsWith(` ${project}`), command)
    }
    // No ConPort command outside those: the version is pinned everywhere.
    assert.equal(task.split('conport@').length - 1, commands.length)
  }
})

test('a task with quotes and dollars survives the shell', async () => {
  // A project as the CLI might name it: quotes of both kinds, a dollar and a backquote.
  const project = `it's "$HOME" \`x\``
  const { task, args } = await prepare(10, 'claude', { ...EPIC_LIST, project })
  assert.equal(args.length, 1)
  assert.equal(task, prepareTask({ epic: 10, project, missing: 'spec' }))
  for (const piece of ["'", '"', '$', '\n', '`']) assert.ok(task.includes(piece), JSON.stringify(piece))
})

test('the api key never reaches the task or the command', async () => {
  const key = 'cport_live_secretvalue'
  process.env.CONPORT_API_KEY = key
  try {
    const { command } = await prepare(10)
    assert.ok(command !== '')
    assert.doesNotMatch(command, /cport_|secretvalue/)
  } finally {
    delete process.env.CONPORT_API_KEY
  }
})

/** A machine whose CLI answers what a preparation of epic 10 reads. */
const preparing = () =>
  fake([
    { match: 'epic list', stdout: json(EPIC_LIST) },
    { match: 'epic agents', stdout: json(AGENTS) }
  ], [SWITCHED])

test('prepare refuses when the repository root is not a workspace of Orca', async () => {
  const f = preparing()
  for (const [truncated, code] of [[false, 'root_not_open'], [true, 'workspaces_truncated']] as const) {
    const host = f.host({ 'workspace.list': { workspaces: [], truncated }, 'agents.list': { agents: [] } })
    const worker = await mountWorker(f.worker, { host })
    const answer = await worker.request('epic.prepare', { project: HANDLE, root: f.root, epic: 10, agent: 'claude' })
    // A cut list of workspaces is not a sign that the root is missing from Orca.
    assert.equal(answer.ok === false && answer.error.code, code)
    assert.deepEqual(host.callsOf('terminal.create'), [])
    // No terminal was opened: no agent is remembered for the project.
    assert.equal(`prepare:${HANDLE}` in (host.data().storage as Record<string, unknown>), false)
    await worker.deactivate()
  }
})

test('prepare opens its terminal in the root of the chosen project', async () => {
  const f = preparing()
  const billing = join(dirname(f.root), 'billing')
  const host = f.host({
    'workspace.list': {
      workspaces: [
        { id: 'ws-root', kind: 'worktree', name: 'repo', path: f.root, branch: 'main', hostId: null },
        { id: 'ws-billing', kind: 'worktree', name: 'billing', path: `${billing}/`, branch: 'main', hostId: null }
      ],
      truncated: false
    },
    'agents.list': { agents: [] }
  })
  const worker = await mountWorker(f.worker, { host })
  mkdirSync(billing, { recursive: true })
  const answer = await worker.request('epic.prepare', { project: 'billing-api', root: billing, epic: 10, agent: 'claude' })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.deepEqual(host.callsOf('terminal.create').map((c) => (c as { workspaceId: string }).workspaceId), ['ws-billing'])
  await worker.deactivate()
})

test('prepare refuses an epic that is ready, has nothing to prepare or is gone, and an agent not found', async () => {
  const unreadable: EpicList = {
    ...EPIC_LIST,
    epics: [{ id: 20, title: 'Payments', status: 'TODO', progress: { open: 2, total: 2 }, milestone: null, runnable: false, reason: 'the documents of the epic cannot be read' }]
  }
  const cases: Array<[number, string, EpicList, string]> = [
    [15, 'claude', EPIC_LIST, 'epic_ready'],
    [20, 'claude', unreadable, 'epic_not_preparable'],
    [99, 'claude', EPIC_LIST, 'epic_not_found'],
    [10, 'gemini', EPIC_LIST, 'agent_cannot_prepare'],
    [10, 'aider', EPIC_LIST, 'agent_cannot_prepare']
  ]
  for (const [epic, agent, list, code] of cases) {
    const { answer, created } = await prepare(epic, agent, list)
    assert.equal(answer.ok === false && answer.error.code, code, `${epic} ${agent}`)
    assert.deepEqual(created, [])
  }
})

test('the agent that prepared an epic is remembered for the project', async () => {
  const f = fake([
    { match: 'epic list', stdout: json(EPIC_LIST) },
    { match: 'epic agents', stdout: json(AGENTS) }
  ], [SWITCHED])
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const before = await worker.request('agents.get', { project: HANDLE, root: f.root })
  assert.equal(before.ok && before.data.preparer, null)
  await worker.request('epic.prepare', { project: HANDLE, root: f.root, epic: 9, agent: 'codex' })
  const after = await worker.request('agents.get', { project: HANDLE, root: f.root })
  assert.equal(after.ok && after.data.preparer, 'codex')
  // Another project keeps its own choice.
  const other = await worker.request('agents.get', { project: 'prother000', root: f.root })
  assert.equal(other.ok && other.data.preparer, null)
  await worker.deactivate()
})

test('prepare refuses an agent that takes no positional request, found or not, and one that can but is not found', async () => {
  // OpenCode reads a positional argument as a project folder: found, it is refused all the same.
  const agents = {
    agents: [
      ...AGENTS.agents,
      { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true },
      { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: false }
    ]
  }
  const opencode = await prepare(10, 'opencode', EPIC_LIST, agents)
  assert.equal(opencode.answer.ok === false && opencode.answer.error.code, 'agent_cannot_prepare')
  assert.deepEqual(opencode.created, [])
  const cursor = await prepare(10, 'cursor', EPIC_LIST, agents)
  assert.equal(cursor.answer.ok === false && cursor.answer.error.code, 'agent_not_found')
  // Cursor starts by its own command when found.
  const found = { agents: agents.agents.map((a) => (a.id === 'cursor' ? { ...a, found: true } : a)) }
  const started = await prepare(10, 'cursor', EPIC_LIST, found)
  assert.equal(started.answer.ok, true)
  assert.match(started.command, /^cursor-agent '/)
})

test('tasks list reads task list json', async () => {
  const f = fake([{ match: 'task list', stdout: json(TASK_LIST) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('tasks.list', { project: 'shop-api', root: f.root }), { ok: true, data: TASK_LIST.tasks })
  assert.deepEqual(f.conportCalls(), [['task', 'list', '--project', 'shop-api', '--json']])
  await worker.deactivate()
})

/**
 * Hands `task` of `list` to `agent` over the fake CLI, to do it or to review it; the answer, the
 * terminal and the one argument the agent gets.
 */
async function hand(task: number, mode: HandMode, agent = 'claude', list: TaskList = TASK_LIST) {
  const f = fake([
    { match: 'task list', stdout: json(list) },
    { match: 'epic agents', stdout: json(AGENTS) }
  ], [SWITCHED])
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('task.hand', { project: 'shop-api', root: f.root, task, agent, mode })
  const created = host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string; command: string }>
  const command = created[0]?.command ?? ''
  const args = command === '' ? [] : argumentsOf(command)
  const preparer = await worker.request('agents.get', { project: 'shop-api', root: f.root })
  await worker.deactivate()
  return { f, answer, created, command, args, task: args[0] ?? '', remembered: preparer.ok ? preparer.data.preparer : null }
}

/** The first step of a handed task: `init` of ConPort hands out no questions about the project. */
const INIT_QUIET = 'If you call `init` of ConPort, call it with `questions=false`: this run takes up no questions about the project.'

/** Every ConPort command of a task names the pinned CLI and the project, and no other one is in it. */
function pinned(task: string): void {
  const commands = conportCommands(task)
  assert.ok(commands.length >= 3, task)
  for (const command of commands) {
    assert.ok(command.startsWith(`${NPX} `), command)
    const project = command.startsWith(`${NPX} api `) ? `--project ${HANDLE}` : `-p ${HANDLE}`
    assert.ok(command.endsWith(` ${project}`), command)
  }
  assert.equal(task.split('conport@').length - 1, commands.length)
}

test('hand a task opens the chosen agent with the task as one argument', async () => {
  const { f, answer, created, args, task, remembered } = await hand(41, 'do', 'codex')
  assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } })
  // A terminal of the repository root, the command of the chosen agent and one argument: the task.
  assert.deepEqual(created.map(({ workspaceId, title }) => ({ workspaceId, title })), [{ workspaceId: 'ws-root', title: 'conport task 41' }])
  assert.match(created[0]?.command ?? '', /^codex '/)
  assert.equal(args.length, 1)
  assert.equal(task, handTask({ task: 41, project: HANDLE, mode: 'do', agent: 'codex', root: f.root }))
  // The task is read afresh; its project is named by the handle the CLI answered with.
  assert.deepEqual(f.conportCalls(), [['task', 'list', '--project', 'shop-api', '--json'], ['epic', 'agents', '--json'], ['epic', 'agents', '--json']])
  assert.deepEqual(f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
  // The agent is taken by the conport skill: IN_PROGRESS, the work, a report in the journal of the task.
  assert.match(task, /^Do task 41 of the ConPort project prk7m2qx9d/)
  assert.ok(task.includes(`\n1. ${INIT_QUIET} Read the task: `), task)
  assert.match(task, /conport skill/)
  assert.match(task, /in the language they write in/)
  assert.match(task, /`[^`]* api tasks update --task_id 41 --status IN_PROGRESS --project prk7m2qx9d`/)
  assert.match(task, /`[^`]* journal add --task 41 --kind report --author implementer:codex --body-file <file> -p prk7m2qx9d`/)
  assert.ok(task.indexOf('--status IN_PROGRESS') < task.indexOf('--kind report'))
  assert.doesNotMatch(task, /--kind review/)
  pinned(task)
  // The work is done apart from the main working copy: a worktree of its own beside the repository, on the task's branch.
  const branch = `task-${41}`
  const worktree = `git -C ${f.root} worktree add ${join(dirname(f.root), `repo-${branch}`)} -b ${branch}`
  assert.ok(task.includes(`\`${worktree}\``), task)
  assert.match(task, /never in the working copy of this terminal/)
  // It is committed there by Conventional Commits, with no word of an AI; the person merges it.
  assert.match(task, /Conventional Commits/)
  assert.match(task, /never mentions an AI, an assistant or a model, and carries no Co-Authored-By line/)
  assert.match(task, /Never merge the branch and never push it: merging it is the person's/)
  // The report names the branch and its commit.
  assert.ok(task.includes(`the branch \`${branch}\` and its last commit`), task)
  const at = (text: string): number => task.indexOf(text)
  assert.ok(at('--status IN_PROGRESS') < at(worktree))
  assert.ok(at(worktree) < at('Conventional Commits'))
  assert.ok(at('Conventional Commits') < at('--kind report'))
  assert.doesNotMatch(task, /--status DONE/)
  // The agent picked is the one the sheet offers first next time.
  assert.equal(remembered, 'codex')
})

test('review a task asks the agent for a verdict in the journal', async () => {
  const { f, answer, created, args, task } = await hand(42, 'review', 'claude')
  assert.equal(answer.ok, true)
  assert.deepEqual(created.map((c) => c.title), ['conport review 42'])
  assert.equal(args.length, 1)
  assert.equal(task, handTask({ task: 42, project: HANDLE, mode: 'review', agent: 'claude', root: f.root }))
  assert.match(task, /^Review task 42 of the ConPort project prk7m2qx9d/)
  assert.ok(task.includes(`\n1. ${INIT_QUIET} Read the task: `), task)
  // It reads the whole journal: the brief, the report, the fixes.
  assert.match(task, /`[^`]* journal get --task 42 -p prk7m2qx9d`/)
  assert.match(task, /brief, the report and the fixes/)
  // Its verdict goes to the journal as a review, signed apart from the author of the report.
  assert.match(task, /`[^`]* journal add --task 42 --kind review --verdict <verdict> --author reviewer:claude --body-file <file> -p prk7m2qx9d`/)
  assert.match(task, /`approve`/)
  assert.match(task, /`changes_requested`/)
  assert.match(task, /not the author of the report/)
  assert.doesNotMatch(task, /--kind report|--status IN_PROGRESS/)
  pinned(task)
  // It checks the branch the report names, in its worktree.
  assert.ok(task.includes(`the branch the report names (\`task-${42}\` unless it names another)`), task)
  assert.ok(task.includes(`\`git -C ${f.root} worktree list\``), task)
  // On approve, with the person's yes, the task is closed DONE, its resolution added to the description.
  const close = `${NPX} api tasks update --task_id 42 --status DONE --resolution <resolution> --project ${HANDLE}`
  assert.ok(task.includes(`\`${close}\``), task)
  assert.match(task, /ask the person whether to close the task; only with their yes/)
  assert.match(task, /`## Resolution` section; the description itself stays as it is/)
  assert.ok(task.indexOf('--kind review') < task.indexOf('--status DONE'))
  assert.ok(task.indexOf('ask the person whether to close') < task.indexOf('--status DONE'))
})

/** The task list with task 46 in progress after a review that asked for changes. */
const SENT_BACK: TaskList = {
  ...TASK_LIST,
  tasks: [...TASK_LIST.tasks, { id: 46, title: 'Trim the export', kind: 'task', status: 'IN_PROGRESS', priority: 3, changes_requested: true }]
}

test('fix a task the review sent back: its branch, the latest review, a fix entry', async () => {
  const { f, answer, created, args, task } = await hand(46, 'fix', 'codex', SENT_BACK)
  assert.equal(answer.ok, true)
  assert.deepEqual(created.map((c) => c.title), ['conport fix 46'])
  assert.equal(args.length, 1)
  assert.equal(task, handTask({ task: 46, project: HANDLE, mode: 'fix', agent: 'codex', root: f.root }))
  assert.match(task, /^Fix task 46 of the ConPort project prk7m2qx9d after its review asked for changes/)
  assert.ok(task.includes(`\n1. ${INIT_QUIET} Read the task: `), task)
  assert.match(task, /`[^`]* journal get --task 46 -p prk7m2qx9d`/)
  assert.match(task, /the latest review in it: each of its findings is what to fix/)
  // It goes on in the branch of the task and its worktree, never in this working copy.
  const branch = `task-${46}`
  assert.ok(task.includes(`\`git -C ${f.root} worktree list\``), task)
  assert.ok(task.includes(`\`git -C ${f.root} worktree add ${join(dirname(f.root), `repo-${branch}`)} ${branch}\``), task)
  assert.match(task, /never in the working copy of this terminal/)
  assert.match(task, /Conventional Commits/)
  assert.match(task, /never mentions an AI, an assistant or a model, and carries no Co-Authored-By line/)
  // The fix goes to the journal, signed as the implementer: it moves the task back to review.
  assert.match(task, /`[^`]* journal add --task 46 --kind fix --author implementer:codex --body-file <file> -p prk7m2qx9d`/)
  assert.ok(task.indexOf('worktree list') < task.indexOf('Conventional Commits'))
  assert.ok(task.indexOf('Conventional Commits') < task.indexOf('--kind fix'))
  // It neither takes the task again nor creates the branch anew, reports or closes.
  assert.doesNotMatch(task, /--status IN_PROGRESS|--status DONE|--kind report|--kind review| -b /)
  pinned(task)
})

test('the review tells what follows a request for changes', async () => {
  const { task } = await hand(42, 'review', 'claude')
  assert.match(task, /On `changes_requested`, tell the person the task waits for its fixes: in the ConPort Epics panel of Orca they press refresh and hand it to an agent to fix/)
})

test('hand refuses a task that is gone or moved, and an agent that cannot take it', async () => {
  const cursor = { agents: [...AGENTS.agents, { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: false }] }
  const cases: Array<[number, HandMode, string, string]> = [
    [99, 'do', 'claude', 'task_not_found'],
    // Done by someone else meanwhile: a task in review is not done again, a todo one not reviewed.
    [42, 'do', 'claude', 'task_moved'],
    [41, 'review', 'claude', 'task_moved'],
    [43, 'review', 'claude', 'task_moved'],
    // Only a task in progress that the review sent back is fixed: not one an agent is at, nor a todo one.
    [43, 'fix', 'claude', 'task_moved'],
    [41, 'fix', 'claude', 'task_moved'],
    [46, 'do', 'claude', 'task_moved'],
    [41, 'do', 'gemini', 'agent_cannot_prepare']
  ]
  for (const [task, mode, agent, code] of cases) {
    const { answer, created } = await hand(task, mode, agent, SENT_BACK)
    assert.equal(answer.ok === false && answer.error.code, code, `${task} ${mode} ${agent}`)
    assert.deepEqual(created, [])
  }
  const f = fake([{ match: 'task list', stdout: json(TASK_LIST) }, { match: 'epic agents', stdout: json(cursor) }])
  const worker = await mountWorker(f.worker, { host: f.host({ 'agents.list': { agents: [] } }) })
  const answer = await worker.request('task.hand', { project: 'shop-api', root: f.root, task: 41, agent: 'cursor', mode: 'do' })
  assert.equal(answer.ok === false && answer.error.code, 'agent_not_found')
  await worker.deactivate()
})

test('a task with quotes in its project survives the shell, and the api key never reaches it', async () => {
  const project = `it's "$HOME" \`x\``
  const key = 'cport_live_secretvalue'
  process.env.CONPORT_API_KEY = key
  try {
    const { f, task, args, command } = await hand(41, 'do', 'claude', { ...TASK_LIST, project })
    assert.equal(args.length, 1)
    assert.equal(task, handTask({ task: 41, project, mode: 'do', agent: 'claude', root: f.root }))
    assert.doesNotMatch(command, /cport_|secretvalue/)
  } finally {
    delete process.env.CONPORT_API_KEY
  }
})

// --- epic.start ---

/** Subagent types as a person may choose them: with the prefix of a plugin and without one. */
const TYPES: Roles = {
  implementer: 'conport:sdd-implementer',
  reviewer: 'sdd-task-reviewer',
  gapHunter: 'my.plugin:gap_hunter',
  finalReviewer: 'conport:sdd-final-reviewer'
}

const EPIC_TERMINAL = 'term-epic'

interface StartCase {
  epic?: number
  /** The project as the panel names it: a handle or a name. */
  project?: string
  way?: Way
  harness?: string
  roles?: Roles
  agents?: { agents: AgentKind[] }
  /** The branches `git for-each-ref` lists. */
  refs?: string[]
  /** The branch the main working tree is on; null when it is on none. */
  base?: string | null
  /** The working copies beside the main one, given the folder of the fake machine. */
  rows?: (dir: string) => WorktreeRow[]
  truncated?: boolean
  /** What orca says of the main working tree, made from its usual row. */
  main?: (row: WorktreeRow) => Partial<WorktreeRow>
  /** Answers of the fake orca tried before the usual ones. */
  orca?: FakeAnswer[]
}

/** Where the fake orca puts a working copy it creates for `epic`. */
const copyOf = (root: string, epic: number): string => join(dirname(root), 'copies', 'repo', `epic-${epic}`)

/** A machine whose repository has the working copies of `options`, and a worker mounted on it. */
async function startMachine(options: StartCase = {}) {
  const base = options.base === undefined ? 'main' : options.base
  const f = fake(
    [
      { match: 'epic list', stdout: json(EPIC_LIST) },
      { match: 'epic agents', stdout: json(options.agents ?? AGENTS) }
    ],
    ({ dir, root }) => [
      ...(options.orca ?? []),
      worktreeList(
        root,
        [(options.main ?? ((row) => row))(worktreeRow(root, base, true)) as WorktreeRow, ...(options.rows?.(dir) ?? [])],
        options.truncated
      ),
      // The copy lands where orca puts it, not where the worker might guess.
      ...[7, 15].map((epic) => ({
        match: `worktree create --repo id:repo-focus --name epic-${epic} `,
        stdout: json({ ok: true, result: { worktree: { path: copyOf(root, epic), repoId: 'repo-focus' } } })
      })),
      { match: 'terminal create ', stdout: json({ ok: true, result: { terminal: { handle: EPIC_TERMINAL } } }) },
      { match: `terminal switch --terminal ${EPIC_TERMINAL} `, stdout: json({ ok: true, result: {} }) }
    ],
    ({ root }) => [{ match: `-C ${root} for-each-ref `, stdout: (options.refs ?? []).map((ref) => `${ref}\n`).join('') }]
  )
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  return { f, host, worker }
}

type Machine = Awaited<ReturnType<typeof startMachine>>

/** Starts an epic on a machine; the answer and what the fake orca was asked for by this start. */
async function startOn({ f, host, worker }: Machine, options: StartCase = {}) {
  const epic = options.epic ?? 7
  const before = f.orcaCalls().length
  const answer = await worker.request('epic.start', {
    project: options.project ?? HANDLE,
    root: f.root,
    epic,
    way: options.way ?? 'sdd',
    harness: options.harness ?? 'claude',
    roles: options.roles ?? TYPES
  })
  const calls = f.orcaCalls().slice(before)
  const of = (...words: string[]): string[][] => calls.filter((call) => words.every((word, i) => call[i] === word))
  const opened = of('terminal', 'create')
  const first = opened[0] ?? []
  const command = first[first.indexOf('--command') + 1] ?? ''
  const args = command === '' ? [] : argumentsOf(command)
  return {
    f,
    host,
    worker,
    answer,
    copy: copyOf(f.root, epic),
    opened,
    created: of('worktree', 'create'),
    switched: of('terminal', 'switch'),
    command,
    args,
    task: args[0] ?? '',
    storage: host.data().storage as Record<string, unknown>
  }
}

async function start(options: StartCase = {}) {
  const started = await startOn(await startMachine(options), options)
  await started.worker.deactivate()
  return started
}

type Started = Awaited<ReturnType<typeof start>>

/**
 * A refusal of the start in the worker's own words: its code, what it says and its one action,
 * shown by the panel as they are; nothing is opened, created or remembered.
 */
function assertRefused({ answer, opened, created, storage, host }: Started, code: string, message: string, action: string): void {
  assert.deepEqual(answer, { ok: false, error: { code, message, action } })
  assert.deepEqual(refusalText({ code, message, action }), { what: message, action })
  assert.deepEqual(opened, [])
  assert.deepEqual(created, [])
  assert.deepEqual(host.callsOf('terminal.create'), [])
  assert.deepEqual(storage, {})
}

const EPIC_LIST_CALL = ['epic', 'list', '--project', HANDLE, '--json']
const EPIC_AGENTS_CALL = ['epic', 'agents', '--json']
const CREATE_COPY = (base: string): string[] => [
  'worktree', 'create', '--repo', 'id:repo-focus', '--name', 'epic-7', '--branch', 'epic-7', '--base-branch', base, '--no-parent', '--json'
]

test('epic.start creates the working copy when there is none', async () => {
  const { f, answer, copy, created, worker } = await start({ base: 'develop' })
  // The path of the copy is the one orca answered with.
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, way: 'sdd', worktree: copy } })
  // The repository by the id orca gives it, the branch cut from the one the main working tree is
  // on, no parent; the setup of the repository is left to its setting in Orca.
  assert.deepEqual(created, [CREATE_COPY('develop')])
  assert.equal(created.flat().includes('--setup'), false)
  // Every working copy of the repository is asked for, not the first page of them.
  assert.deepEqual(f.orcaCalls()[0], ['worktree', 'list', '--repo', `path:${f.root}`, '--limit', '10000', '--json'])
  assert.deepEqual(worker.refusals, [])
})

test('epic.start takes the working copy that is there and creates none', async () => {
  const there = (dir: string): string => join(dir, 'elsewhere', 'epic-7')
  const { f, answer, created, opened } = await start({
    refs: ['refs/heads/epic-7'],
    rows: (dir) => [worktreeRow(join(dir, 'elsewhere', 'epic-70'), 'epic-70'), worktreeRow(there(dir), 'epic-7')]
  })
  const path = there(dirname(f.root))
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, way: 'sdd', worktree: path } })
  assert.deepEqual(created, [])
  assert.equal(opened[0]?.[3], `path:${path}`)
})

test('epic.start takes the main working tree when it is on the branch of the epic', async () => {
  // The repository itself stands on `epic-7`: it is the copy of the epic, and no other is made.
  const { f, answer, created, opened } = await start({ base: 'epic-7', refs: ['refs/heads/epic-7'] })
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, way: 'sdd', worktree: f.root } })
  assert.deepEqual(created, [])
  assert.equal(opened[0]?.[3], `path:${f.root}`)
})

test('epic.start takes only a working copy of the same repository', async () => {
  // A row of another repository on the branch of the epic is not the copy of this one.
  const { answer, created, copy } = await start({
    rows: (dir) => [{ ...worktreeRow(join(dir, 'other', 'epic-7'), 'epic-7'), repoId: 'repo-other' }]
  })
  assert.equal(answer.ok && answer.data.worktree, copy)
  assert.equal(created.length, 1)
})

test('epic.start opens the SDD terminal in the working copy, not in the root, and brings it forward', async () => {
  const { f, host, copy, opened, command, switched } = await start()
  assert.deepEqual(opened, [
    ['terminal', 'create', '--worktree', `path:${copy}`, '--title', 'conport epic 7 · SDD', '--command', command, '--json']
  ])
  assert.notEqual(copy, f.root)
  // The session is a terminal orca opens: the host is not asked for one.
  assert.deepEqual(host.callsOf('terminal.create'), [])
  assert.deepEqual(switched, [['terminal', 'switch', '--terminal', EPIC_TERMINAL, '--json']])
})

test('epic.start gives the harness the task as one argument', async () => {
  for (const harness of ['claude', 'codex']) {
    const { copy, command, args, task } = await start({ harness, project: 'shop-api' })
    assert.ok(command.startsWith(`${harness} '`), command)
    assert.equal(args.length, 1)
    // The project is the handle the CLI answered with, the base the branch of the main working tree.
    assert.equal(task, epicTask({ epic: 7, project: HANDLE, worktree: copy, base: 'main', harness, roles: TYPES }))
    for (const piece of ['"', '\n', '`']) assert.ok(task.includes(piece), JSON.stringify(piece))
  }
})

test('a base branch the shell would read reaches the harness inside the one argument', async () => {
  // A name git allows for a branch: a quote, a dollar with a bracket, a backquote, a semicolon.
  const base = "it's-$(x)-`y`;z"
  const { copy, created, args, task, answer } = await start({ base })
  assert.equal(answer.ok, true)
  assert.deepEqual(created, [CREATE_COPY(base)])
  assert.equal(args.length, 1)
  assert.equal(task, epicTask({ epic: 7, project: HANDLE, worktree: copy, base, harness: 'claude', roles: TYPES }))
  assert.ok(task.includes(base))
})

test('epic.start remembers the harness, the roles and the way for the epic, the harness for the project and the terminal', async () => {
  // Named by its name, the project is remembered by the handle the CLI answered with.
  const { storage } = await start({ harness: 'codex', project: 'shop-api' })
  assert.deepEqual(storage, {
    [`harness:${HANDLE}:7`]: 'codex',
    [`roles:${HANDLE}:7`]: TYPES,
    [`way:${HANDLE}:7`]: 'sdd',
    [`session:${HANDLE}:7`]: { terminal: EPIC_TERMINAL, way: 'sdd' },
    [`harness:${HANDLE}`]: 'codex'
  })
})

test('epic.start writes neither prepare nor the old roles record', async () => {
  const { storage, answer } = await start()
  assert.equal(answer.ok, true)
  assert.equal(`prepare:${HANDLE}` in storage, false)
  assert.equal(`roles:${HANDLE}` in storage, false)
  // Nothing is kept for the project but its harness.
  assert.deepEqual(Object.keys(storage).filter((key) => key.split(':').length === 2), [`harness:${HANDLE}`])
})

test('epic.start checks only the command of the harness', async () => {
  // Claude Code under a command of its own, every other kind missing, and role types nobody has.
  const agents = {
    agents: [
      { id: 'claude', label: 'Claude Code', command: 'claude-code', found: true },
      { id: 'codex', label: 'Codex', command: 'codex', found: false }
    ]
  }
  const roles = { implementer: 'no-such:type', reviewer: 'nobody', gapHunter: 'none.at:all', finalReviewer: 'absent' }
  const { f, answer, command, task } = await start({ agents, roles })
  assert.equal(answer.ok, true)
  assert.ok(command.startsWith("claude-code '"), command)
  assert.match(task, /`no-such:type`/)
  assert.equal(f.conportCalls().filter((call) => call[1] === 'agents').length, 1)
})

test('epic.start runs no epic run and no check', async () => {
  const machine = await startMachine()
  const copy = copyOf(machine.f.root, 7)
  mkdirSync(copy, { recursive: true })
  const { f, answer, command, worker } = await startOn(machine)
  await worker.deactivate()
  assert.equal(answer.ok, true)
  // Every call of the three programs: the epic and the agent kinds are read, nothing else of ConPort.
  assert.deepEqual(f.conportCalls(), [EPIC_LIST_CALL, EPIC_AGENTS_CALL])
  assert.deepEqual(f.gitCalls(), [['-C', f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/epic-7', 'refs/heads/epic7/*']])
  assert.deepEqual(f.orcaCalls(), [
    ['worktree', 'list', '--repo', `path:${f.root}`, '--limit', '10000', '--json'],
    CREATE_COPY('main'),
    ['terminal', 'create', '--worktree', `path:${copy}`, '--title', 'conport epic 7 · SDD', '--command', command, '--json'],
    ['terminal', 'switch', '--terminal', EPIC_TERMINAL, '--json']
  ])
  // No file is written, into the working copy or into the root.
  assert.deepEqual(readdirSync(copy), [])
  assert.deepEqual(readdirSync(f.root), [])
  assert.deepEqual(worker.posts, [])
})

test('epic.start by the workflow creates no working copy and opens its terminal in the root', async () => {
  const { f, host, answer, created, opened, command, switched, storage } = await start({ way: 'workflow' })
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, way: 'workflow', worktree: null } })
  assert.deepEqual(created, [])
  assert.deepEqual(opened, [
    ['terminal', 'create', '--worktree', `path:${f.root}`, '--title', 'conport epic 7 · workflow', '--command', command, '--json']
  ])
  assert.deepEqual(host.callsOf('terminal.create'), [])
  assert.deepEqual(switched, [['terminal', 'switch', '--terminal', EPIC_TERMINAL, '--json']])
  assert.deepEqual(storage[`session:${HANDLE}:7`], { terminal: EPIC_TERMINAL, way: 'workflow' })
  assert.equal(storage[`way:${HANDLE}:7`], 'workflow')
})

test('epic.start by the workflow puts no role type into the task', async () => {
  // Types the SDD way would refuse are of no matter to the workflow: it never reads them.
  const roles = { implementer: 'my implementer', reviewer: "o'neil", gapHunter: 'gap\nhunter', finalReviewer: 'final-type' }
  const { f, answer, args, task } = await start({ way: 'workflow', roles, base: 'trunk' })
  assert.equal(answer.ok, true)
  assert.equal(args.length, 1)
  assert.equal(task, epicWorkflowTask({ epic: 7, project: HANDLE, root: f.root, base: 'trunk' }))
  for (const type of [...Object.values(roles), ...Object.values(TYPES)]) assert.equal(task.includes(type), false, type)
})

test('epic.start refuses an epic that is gone', async () => {
  const started = await start({ epic: 99 })
  assertRefused(started, 'epic_not_found', 'эпика 99 нет в проекте', 'нажмите «Обновить»')
  // The first refusal: nothing else is asked.
  assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  assert.deepEqual(started.f.gitCalls(), [])
  assert.deepEqual(started.f.orcaCalls(), [])
})

test('epic.start refuses an epic without a spec or a plan', async () => {
  for (const epic of [9, 10]) {
    // Whatever else is wrong with the request, the epic is named first.
    const started = await start({ epic, way: 'workflow', harness: 'gemini' })
    assertRefused(started, 'epic_not_ready', `у эпика ${epic} нет спецификации или плана`, 'подготовьте эпик на вкладке «Подготовить»')
    assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  }
})

test('epic.start refuses the workflow for a harness other than claude', async () => {
  for (const harness of ['codex', 'gemini']) {
    const started = await start({ way: 'workflow', harness })
    assertRefused(started, 'way_needs_claude', 'способ «/conport:epic» есть только у Claude Code с плагином conport', 'выберите харнесс Claude Code')
    // Before the harness is looked for.
    assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  }
})

test('epic.start refuses a role type that is not a plain name', async () => {
  const keys = ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'] as const
  // What a shell or the text of a task would read, an empty type, a path, letters that are not Latin.
  const types = ['my implementer', "o'neil", 'gap\nhunter', '', '`id`', '$(id)', 'a;b', 'a/b', 'тип', 'sdd-implementer\n']
  const invalid: unknown[] = [
    ...types.map((type, i) => ({ ...TYPES, [keys[i % keys.length] ?? 'reviewer']: type })),
    // A role that is not named at all, or not by a string.
    ...keys.map((key) => ({ ...TYPES, [key]: undefined })),
    {},
    { ...TYPES, reviewer: 7 },
    { ...TYPES, gapHunter: null }
  ]
  for (const roles of invalid) {
    const started = await start({ roles: roles as Roles })
    assertRefused(started, 'role_invalid', 'тип субагента — не простое имя', 'выберите тип роли из списка')
    // Before the harness is looked for.
    assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  }
  // A request that names no roles at all is refused the same, whichever the way and the harness.
  for (const [way, harness] of [['sdd', 'claude'], ['sdd', 'codex'], ['workflow', 'claude']] as const) {
    const machine = await startMachine()
    const request = { project: HANDLE, root: machine.f.root, epic: 7, way, harness }
    const answer = await machine.worker.request('epic.start', request as typeof request & { roles: Roles })
    await machine.worker.deactivate()
    const error = { code: 'role_invalid', message: 'тип субагента — не простое имя', action: 'выберите тип роли из списка' }
    assert.deepEqual(answer, { ok: false, error }, `${way} ${harness}`)
    assert.deepEqual(machine.worker.refusals, [])
    assert.deepEqual(machine.f.orcaCalls(), [])
    assert.deepEqual(machine.host.data().storage, {})
  }
  // Only Claude Code by the SDD skill is told the types: another harness never reads them.
  const codex = await start({ harness: 'codex', roles: { ...TYPES, reviewer: 'my reviewer' } })
  assert.equal(codex.answer.ok, true)
  assert.equal(codex.task.includes('my reviewer'), false)
})

test('epic.start refuses a harness that takes no task', async () => {
  const agents = { agents: [...AGENTS.agents, { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true }] }
  for (const harness of ['gemini', 'opencode', 'aider']) {
    const started = await start({ harness, agents })
    assertRefused(started, 'agent_cannot_prepare', `харнесс «${harness}» не принимает задание при запуске`, 'выберите Claude Code, Codex или Cursor')
    assert.deepEqual(started.f.gitCalls(), [])
  }
})

test('epic.start refuses a harness that is not found', async () => {
  const agents = { agents: AGENTS.agents.map((a) => (a.id === 'codex' ? { ...a, found: false } : a)) }
  const started = await start({ harness: 'codex', agents })
  assertRefused(started, 'agent_not_found', 'харнесс «codex» не найден на машине', HARNESS_MISSING_ACTION)
  assert.equal(HARNESS_MISSING_ACTION, 'запустите его в этом рабочем месте Orca и нажмите «Обновить»')
  // Before the branches are read.
  assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL, EPIC_AGENTS_CALL])
  assert.deepEqual(started.f.gitCalls(), [])
  assert.deepEqual(started.f.orcaCalls(), [])
})

test('epic.start refuses the workflow when the branch epic-N is there', async () => {
  const started = await start({ way: 'workflow', refs: ['refs/heads/epic-7'] })
  assertRefused(started, 'epic_started_sdd', 'выбран поток, а ветка epic-7 уже есть: эпик начат навыком SDD', 'выберите способ «Навык SDD»')
  // Before the working copies are read.
  assert.deepEqual(started.f.orcaCalls(), [])
  // The branches of the workflow itself are what a second run of it picks up.
  const again = await start({ way: 'workflow', refs: ['refs/heads/epic7/t12', 'refs/heads/epic7/t13'] })
  assert.equal(again.answer.ok, true)
})

test('epic.start refuses SDD when branches epicN/… are there', async () => {
  const started = await start({ refs: ['refs/heads/epic7/t12'] })
  assertRefused(started, 'epic_started_workflow', 'выбран навык SDD, а ветки epic7/… уже есть: эпик начат потоком', 'выберите способ «/conport:epic»')
  assert.deepEqual(started.f.orcaCalls(), [])
  // A branch under `epic-7/` is no branch of the workflow, and no branch of the epic either.
  const other = await start({ refs: ['refs/heads/epic-7/notes'] })
  assert.equal(other.answer.ok, true)
  assert.equal(other.created.length, 1)
})

test('epic.start refuses when the main working tree is on no branch', async () => {
  for (const way of ['sdd', 'workflow'] as const) {
    const started = await start({ way, base: null })
    assertRefused(started, 'root_detached', 'главная рабочая копия репозитория не на ветке: базы для эпика нет', 'переключите главную рабочую копию на ветку')
  }
  // However orca says "no branch": an empty name, or no name at all.
  const unnamed: Array<(row: WorktreeRow) => Partial<WorktreeRow>> = [(row) => ({ ...row, branch: '' }), ({ branch: _gone, ...row }) => row]
  for (const main of unnamed) {
    const started = await start({ main })
    assert.equal(started.answer.ok === false && started.answer.error.code, 'root_detached')
    assert.deepEqual(started.created, [])
    assert.deepEqual(started.opened, [])
  }
  // Told before the branch of the epic is looked at.
  const taken = await start({ base: null, refs: ['refs/heads/epic-7'] })
  assert.equal(taken.answer.ok === false && taken.answer.error.code, 'root_detached')
})

test('epic.start refuses a branch epic-N without a working copy', async () => {
  const started = await start({ refs: ['refs/heads/epic-7'], rows: (dir) => [worktreeRow(join(dir, 'elsewhere', 'epic-8'), 'epic-8')] })
  assertRefused(started, 'epic_branch_taken', 'ветка epic-7 есть, а рабочей копии у неё нет', 'откройте ветку рабочим местом в Orca')
})

test('epic.start refuses a truncated worktree list', async () => {
  const message = 'список рабочих копий репозитория не поместился в ответ Orca: их больше 10000'
  const action = 'удалите ненужные рабочие копии репозитория в Orca и повторите'
  // The copy may be among the rows cut off: none is created on a part of the list.
  assertRefused(await start({ truncated: true }), 'workspaces_truncated', message, action)
  assertRefused(await start({ truncated: true, refs: ['refs/heads/epic-7'] }), 'workspaces_truncated', message, action)
  // A list cut short that still holds what the start needs is enough.
  const there = await start({ truncated: true, refs: ['refs/heads/epic-7'], rows: (dir) => [worktreeRow(join(dir, 'elsewhere', 'epic-7'), 'epic-7')] })
  assert.equal(there.answer.ok, true)
  assert.deepEqual(there.created, [])
  // The main working tree itself is among the rows cut off: the base is not known, whichever the way.
  const elsewhere = (dir: string): Partial<WorktreeRow> => ({ path: join(dir, 'elsewhere', 'main'), isMainWorktree: false })
  for (const way of ['sdd', 'workflow'] as const) {
    assertRefused(await start({ way, truncated: true, main: (row) => ({ ...row, ...elsewhere(dirname(row.path)) }) }), 'workspaces_truncated', message, action)
  }
})

test('epic.start refuses an answer of orca that lacks what it was asked for', async () => {
  const answered = (match: string, result: unknown): FakeAnswer => ({ match, stdout: json({ ok: true, result }) })
  // A whole list that names no main working tree of the repository.
  for (const way of ['sdd', 'workflow'] as const) {
    const unlisted = await start({ way, main: (row) => ({ ...row, isMainWorktree: false }) })
    assertRefused(unlisted, 'bad_output', 'orca не назвала главную рабочую копию репозитория', 'обновите Orca')
  }
  // A working copy created without its path: no terminal is opened in a guessed folder.
  const pathless = await start({ orca: [answered('worktree create ', { worktree: {} })] })
  assert.deepEqual(pathless.answer, { ok: false, error: { code: 'bad_output', message: 'orca создала рабочую копию и не назвала её путь', action: 'обновите Orca' } })
  assert.deepEqual(pathless.opened, [])
  assert.deepEqual(pathless.storage, {})
  // A terminal opened without its handle: there is no session to remember or to bring forward.
  for (const way of ['sdd', 'workflow'] as const) {
    const nameless = await start({ way, orca: [answered('terminal create ', { terminal: {} })] })
    assert.deepEqual(nameless.answer, { ok: false, error: { code: 'bad_output', message: 'orca открыла терминал и не назвала его', action: 'обновите Orca' } })
    assert.deepEqual(nameless.switched, [])
    assert.deepEqual(nameless.storage, {})
  }
})

test('a refusal of orca is returned as is', async () => {
  const refusal = { code: 'branch_in_use', message: 'the branch is checked out elsewhere', action: 'remove the other checkout' }
  const refused = (match: string): FakeAnswer => ({ match, code: 1, stdout: json({ ok: false, error: refusal }) })
  const cases = [['worktree list', 'sdd'], ['worktree list', 'workflow'], ['worktree create', 'sdd'], ['terminal create', 'sdd'], ['terminal create', 'workflow']] as const
  for (const [match, way] of cases) {
    const { answer, storage, switched } = await start({ way, orca: [refused(match)] })
    assert.deepEqual(answer, { ok: false, error: refusal }, `${match} ${way}`)
    // A start that opened no terminal is not remembered.
    assert.deepEqual(storage, {})
    assert.deepEqual(switched, [])
  }
})

test('epic.start refuses when the branches cannot be listed', async () => {
  const f = fake(
    [{ match: 'epic list', stdout: json(EPIC_LIST) }, { match: 'epic agents', stdout: json(AGENTS) }],
    [],
    [{ match: '-C ', code: 128, stderr: 'fatal: not a repository\n' }]
  )
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, way: 'sdd', harness: 'claude', roles: TYPES })
  await worker.deactivate()
  // What git said, as it said it, and the one thing to do; the panel shows both.
  const error = { code: 'git_failed', message: 'fatal: not a repository', action: 'проверьте репозиторий командой git status в его корне и повторите' }
  assert.deepEqual(answer, { ok: false, error })
  assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
  assert.deepEqual(f.orcaCalls(), [])
  assert.deepEqual(host.data().storage, {})
})

test('a git that fails without a word is told by its exit code', async () => {
  const f = fake(
    [{ match: 'epic list', stdout: json(EPIC_LIST) }, { match: 'epic agents', stdout: json(AGENTS) }],
    [],
    [{ match: '-C ', code: 3, stderr: ' \n' }]
  )
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, way: 'sdd', harness: 'claude', roles: TYPES })
  await worker.deactivate()
  const error = { code: 'git_failed', message: 'git: код выхода 3', action: 'проверьте репозиторий командой git status в его корне и повторите' }
  assert.deepEqual(answer, { ok: false, error })
  assert.deepEqual(f.orcaCalls(), [])
})

test('a git that cannot start is told with the one thing to do', async () => {
  const f = fake([{ match: 'epic list', stdout: json(EPIC_LIST) }, { match: 'epic agents', stdout: json(AGENTS) }])
  const { createWorker } = await import('./worker')
  const broken = createWorker({ conport: f.deps.conport, orca: f.deps.orca, git: ['/nonexistent/bin/git'] })
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker({ default: broken.activate, deactivate: broken.deactivate } as typeof f.worker, { host })
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, way: 'sdd', harness: 'claude', roles: TYPES })
  await worker.deactivate()
  assert.equal(answer.ok === false && answer.error.code, 'spawn_failed')
  assert.match(answer.ok === false ? answer.error.action : '', /сделайте git видимым в PATH/)
  assert.deepEqual(f.orcaCalls(), [])
})

test('an epic terminal orca cannot bring forward is only logged, and the start is remembered', async () => {
  const refused = { ok: false, error: { code: 'terminal_not_found', message: 'no such terminal' } }
  const { answer, storage, worker } = await start({ orca: [{ match: 'terminal switch', code: 1, stdout: json(refused) }] })
  assert.equal(answer.ok, true)
  assert.deepEqual(storage[`session:${HANDLE}:7`], { terminal: EPIC_TERMINAL, way: 'sdd' })
  assert.equal(worker.logs.some((line) => line.includes('terminal_not_found')), true, JSON.stringify(worker.logs))
})

test('prepare and hand still remember the agent of the project', async () => {
  const machine = await startMachine({ orca: [SWITCHED] })
  const { f, host, worker } = machine
  const preparer = async (): Promise<unknown> => {
    const answer = await worker.request('agents.get', { project: HANDLE, root: f.root })
    return answer.ok ? answer.data.preparer : answer.error
  }
  const prepared = await worker.request('epic.prepare', { project: HANDLE, root: f.root, epic: 9, agent: 'codex' })
  assert.deepEqual(prepared, { ok: true, data: { terminal: 'term-1' } })
  assert.equal(await preparer(), 'codex')
  // It opens its terminal as before: through the host, in the root.
  assert.deepEqual(
    (host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string }>).map(({ workspaceId, title }) => ({ workspaceId, title })),
    [{ workspaceId: 'ws-root', title: 'conport prepare 9' }]
  )
  // The start of an epic with another harness leaves the agent of the project as it was.
  const started = await startOn(machine, { harness: 'claude' })
  assert.equal(started.answer.ok, true)
  assert.equal(await preparer(), 'codex')
  assert.equal(started.storage[`harness:${HANDLE}`], 'claude')
  // A refused preparation remembers nothing.
  const refused = await worker.request('epic.prepare', { project: 'prother000', root: f.root, epic: 9, agent: 'gemini' })
  assert.equal(refused.ok === false && refused.error.code, 'agent_cannot_prepare')
  assert.equal('prepare:prother000' in (host.data().storage as Record<string, unknown>), false)
  await worker.deactivate()

  // A task handed remembers its agent, one whose agent is refused does not.
  assert.equal((await hand(41, 'do', 'codex')).remembered, 'codex')
  const refusedHand = await hand(41, 'do', 'gemini')
  assert.equal(refusedHand.answer.ok, false)
  assert.equal(refusedHand.remembered, null)
})

test('the way of one epic does not change the way of another', async () => {
  const machine = await startMachine()
  const first = await startOn(machine, { epic: 7, way: 'workflow', harness: 'claude' })
  assert.equal(first.answer.ok, true)
  const second = await startOn(machine, { epic: 15, way: 'sdd', harness: 'codex', roles: { ...TYPES, reviewer: 'other-reviewer' } })
  assert.equal(second.answer.ok, true)
  await machine.worker.deactivate()
  const storage = second.storage
  assert.equal(storage[`way:${HANDLE}:7`], 'workflow')
  assert.equal(storage[`way:${HANDLE}:15`], 'sdd')
  assert.equal(storage[`harness:${HANDLE}:7`], 'claude')
  assert.equal(storage[`harness:${HANDLE}:15`], 'codex')
  assert.deepEqual(storage[`roles:${HANDLE}:7`], TYPES)
  assert.deepEqual(storage[`roles:${HANDLE}:15`], { ...TYPES, reviewer: 'other-reviewer' })
  assert.deepEqual(storage[`session:${HANDLE}:7`], { terminal: EPIC_TERMINAL, way: 'workflow' })
  assert.deepEqual(storage[`session:${HANDLE}:15`], { terminal: EPIC_TERMINAL, way: 'sdd' })
  // The project keeps the harness of its last start.
  assert.equal(storage[`harness:${HANDLE}`], 'codex')
})

// --- epic.session ---

/** A terminal of a shell, as orca opens two of them in a working copy it creates. */
const shell = (handle: string): Record<string, unknown> => ({ handle, title: '~/repo', agentIdentity: '' })
/** A terminal an agent runs in. */
const agent = (handle: string, title = '✳ Claude Code'): Record<string, unknown> => ({ handle, title, agentIdentity: 'claude' })

/** What the start of epic 7 remembers of its way and its terminal. */
const remembered = (way: Way, terminal = EPIC_TERMINAL): Record<string, unknown> => ({
  [`way:${HANDLE}:7`]: way,
  [`session:${HANDLE}:7`]: { terminal, way }
})

interface SessionCase {
  /** What the plugin has stored before. */
  storage?: Record<string, unknown>
  /** Whether the repository has a working copy on `epic-7` beside the main one. */
  copy?: boolean
  /** The branch the main working tree is on; null when it is on none. */
  base?: string | null
  refs?: string[]
  truncated?: boolean
  /** The terminals orca lists in the working copy of the epic and in the root; a place left out is not answered. */
  terminals?: { copy?: unknown[]; root?: unknown[] }
  terminalsTruncated?: boolean
  /** Answers of the fake orca and of the fake git tried before the usual ones. */
  orca?: FakeAnswer[]
  git?: FakeAnswer[]
  /** The project as the request names it; its handle unless told otherwise. */
  project?: unknown
  /** The request sent about epic 7. */
  request?: 'epic.session' | 'terminal.show'
}

const copyIn = (dir: string): string => join(dir, 'elsewhere', 'epic-7')

/** Asks for the session of epic 7; the answer and what the three programs were asked for. */
async function session(options: SessionCase = {}) {
  const asked = await sessionRequest({ ...options, request: 'epic.session' })
  return { ...asked, answer: asked.answer as Result<EpicSession> }
}

/** Asks to show the terminal of the session of epic 7. */
async function show(options: SessionCase = {}) {
  const asked = await sessionRequest({ ...options, request: 'terminal.show' })
  return { ...asked, answer: asked.answer as Result<null>, switched: asked.terminalCalls.filter((call) => call[1] === 'switch') }
}

async function sessionRequest(options: SessionCase) {
  const base = options.base === undefined ? 'main' : options.base
  const f = fake(
    [],
    ({ dir, root }) => [
      ...(options.orca ?? []),
      worktreeList(
        root,
        [worktreeRow(root, base, true), ...(options.copy === false ? [] : [worktreeRow(copyIn(dir), 'epic-7')])],
        options.truncated
      ),
      ...(options.terminals?.copy ? [terminalList(copyIn(dir), options.terminals.copy, options.terminalsTruncated)] : []),
      ...(options.terminals?.root ? [terminalList(root, options.terminals.root, options.terminalsTruncated)] : []),
      { match: 'terminal switch --terminal ', stdout: json({ ok: true, result: {} }) }
    ],
    ({ root }) => [
      ...(options.git ?? []),
      { match: `-C ${root} for-each-ref `, stdout: (options.refs ?? []).map((ref) => `${ref}\n`).join('') }
    ]
  )
  const host = f.host({}, options.storage)
  const worker = await mountWorker(f.worker, { host })
  const ref = { project: (options.project === undefined ? HANDLE : options.project) as string, root: f.root, epic: 7 }
  const answer: unknown = await worker.request(options.request ?? 'epic.session', ref)
  await worker.deactivate()
  const copy = copyIn(dirname(f.root))
  return {
    f,
    answer,
    copy,
    /** The places whose terminals orca was asked for. */
    listed: f.orcaCalls().filter((call) => call[0] === 'terminal' && call[1] === 'list'),
    terminalCalls: f.orcaCalls().filter((call) => call[0] === 'terminal'),
    inCopy: [['terminal', 'list', '--worktree', `path:${copy}`, '--limit', '10000', '--json']],
    inRoot: [['terminal', 'list', '--worktree', `path:${f.root}`, '--limit', '10000', '--json']],
    storage: host.data().storage as Record<string, unknown>,
    refusals: worker.refusals
  }
}

/** The session of an epic nobody started, by the defaults. */
const NEW_EPIC: EpicSession = {
  way: 'sdd',
  harness: 'claude',
  roles: DEFAULT_ROLES,
  worktree: null,
  alive: false,
  terminal: null,
  workflowBranches: false
}

test('epic.session: no working copy, by SDD', async () => {
  const none = await session({ copy: false })
  assert.deepEqual(none.answer, { ok: true, data: NEW_EPIC })
  // Without a copy there is no place to look for a session in: the root is not one.
  assert.deepEqual(none.listed, [])
  // ConPort is not asked, and a question stores nothing.
  assert.deepEqual(none.f.conportCalls(), [])
  assert.deepEqual(none.storage, {})
  assert.deepEqual(none.refusals, [])
  // A terminal remembered for a copy that is gone is no session, whatever runs in the root.
  const gone = await session({ copy: false, storage: remembered('sdd'), terminals: { root: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(gone.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(gone.listed, [])
})

test('epic.session: a working copy and no session', async () => {
  // The two shells orca opens in a copy it creates.
  const { answer, copy, listed, inCopy, f } = await session({ terminals: { copy: [shell('term-a'), shell('term-b')] } })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: copy } })
  assert.deepEqual(listed, inCopy)
  assert.deepEqual(f.orcaCalls()[0], ['worktree', 'list', '--repo', `path:${f.root}`, '--limit', '10000', '--json'])
  // A copy without a terminal at all.
  const empty = await session({ terminals: { copy: [] } })
  assert.deepEqual(empty.answer, { ok: true, data: { ...NEW_EPIC, worktree: empty.copy } })
})

test('epic.session: a live session by SDD', async () => {
  const { answer, copy, listed, inCopy } = await session({
    storage: remembered('sdd'),
    terminals: { copy: [shell('term-a'), shell('term-b'), agent(EPIC_TERMINAL)] }
  })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: copy, alive: true, terminal: EPIC_TERMINAL } })
  assert.deepEqual(listed, inCopy)
})

test('epic.session: the main working tree on the branch of the epic is its working copy', async () => {
  const { answer, f } = await session({ copy: false, base: 'epic-7', storage: remembered('sdd'), terminals: { root: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: f.root, alive: true, terminal: EPIC_TERMINAL } })
})

test('epic.session: no session in the root, by the workflow, with and without branches of an earlier run', async () => {
  const WORKFLOW: EpicSession = { ...NEW_EPIC, way: 'workflow' }
  // The remembered terminal is not listed: Orca was started again, its handles are new.
  const gone = { copy: false, storage: remembered('workflow'), terminals: { root: [shell('term-a'), agent('term-new')] } }
  const without = await session(gone)
  assert.deepEqual(without.answer, { ok: true, data: WORKFLOW })
  // The workflow runs in the root: its terminal is looked for there.
  assert.deepEqual(without.listed, without.inRoot)
  const withBranches = await session({ ...gone, refs: ['refs/heads/epic7/t12', 'refs/heads/epic7/t13'] })
  assert.deepEqual(withBranches.answer, { ok: true, data: { ...WORKFLOW, workflowBranches: true } })
  // The branch of the SDD skill and a branch under it are no branches of the workflow.
  const others = await session({ ...gone, refs: ['refs/heads/epic-7', 'refs/heads/epic-7/notes'] })
  assert.deepEqual(others.answer, { ok: true, data: WORKFLOW })
  assert.deepEqual(others.f.gitCalls(), [['-C', others.f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/epic-7', 'refs/heads/epic7/*']])
  // The way was chosen and no terminal remembered: there is nothing to look for.
  const never = await session({ copy: false, storage: { [`way:${HANDLE}:7`]: 'workflow' }, terminals: { root: [agent('term-new')] } })
  assert.deepEqual(never.answer, { ok: true, data: WORKFLOW })
  assert.deepEqual(never.listed, [])
})

test('epic.session: a live session by the workflow', async () => {
  const { answer, listed, inRoot } = await session({
    copy: false,
    storage: remembered('workflow'),
    refs: ['refs/heads/epic7/t12'],
    terminals: { root: [shell('term-a'), agent(EPIC_TERMINAL)] }
  })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, way: 'workflow', alive: true, terminal: EPIC_TERMINAL, workflowBranches: true } })
  assert.deepEqual(listed, inRoot)
})

test('epic.session: the remembered terminal with an agent identity is alive, with an empty one is not', async () => {
  for (const way of ['sdd', 'workflow'] as const) {
    const place = (terminals: unknown[]): SessionCase =>
      way === 'sdd'
        ? { storage: remembered(way), terminals: { copy: terminals } }
        : { copy: false, storage: remembered(way), terminals: { root: terminals } }
    const named = await session(place([agent(EPIC_TERMINAL)]))
    assert.equal(named.answer.ok && named.answer.data.alive, true, way)
    assert.equal(named.answer.ok && named.answer.data.terminal, EPIC_TERMINAL, way)
    // The agent left its terminal: a shell is what remains of it. However orca says "no agent".
    for (const agentIdentity of ['', null, '  ']) {
      const emptied = { handle: EPIC_TERMINAL, title: 'conport epic 7 · SDD', agentIdentity }
      const left = await session(place([shell('term-a'), emptied]))
      assert.equal(left.answer.ok && left.answer.data.alive, false, `${way} ${JSON.stringify(agentIdentity)}`)
      assert.equal(left.answer.ok && left.answer.data.terminal, null)
      // Another agent in the same place: in the copy of the epic it is the session, or a start
      // would open a second agent over it; in the root, where any agent may work, it is not.
      const beside = await session(place([emptied, agent('term-other')]))
      assert.equal(beside.answer.ok && beside.answer.data.alive, way === 'sdd', `${way} ${JSON.stringify(agentIdentity)}`)
      assert.equal(beside.answer.ok && beside.answer.data.terminal, way === 'sdd' ? 'term-other' : null)
    }
  }
})

test('epic.session: a remembered terminal without the field is alive', async () => {
  // An Orca that does not say who runs in a terminal: the terminal being there is all there is to know.
  const bare = (handle: string): Record<string, unknown> => ({ handle, title: 'zsh' })
  const sdd = await session({ storage: remembered('sdd'), terminals: { copy: [bare('term-a'), bare(EPIC_TERMINAL)] } })
  assert.equal(sdd.answer.ok && sdd.answer.data.alive, true)
  assert.equal(sdd.answer.ok && sdd.answer.data.terminal, EPIC_TERMINAL)
  const workflow = await session({ copy: false, storage: remembered('workflow'), terminals: { root: [bare(EPIC_TERMINAL)] } })
  assert.equal(workflow.answer.ok && workflow.answer.data.alive, true)
  // Without the remembered one, a terminal that names no agent is not known to hold one.
  const unknown = await session({ storage: remembered('sdd'), terminals: { copy: [bare('term-a'), bare('term-b')] } })
  assert.equal(unknown.answer.ok && unknown.answer.data.alive, false)
})

test('epic.session: a remembered terminal that is gone falls back to the working copy', async () => {
  // Orca was started again: the agent of the copy runs under a new handle.
  const again = await session({ storage: remembered('sdd'), terminals: { copy: [shell('term-a'), shell('term-b'), agent('term-new')] } })
  assert.deepEqual(again.answer, { ok: true, data: { ...NEW_EPIC, worktree: again.copy, alive: true, terminal: 'term-new' } })
  // No terminal was ever remembered, and an agent works in the copy.
  const never = await session({ terminals: { copy: [shell('term-a'), agent('term-new'), agent('term-later')] } })
  assert.equal(never.answer.ok && never.answer.data.terminal, 'term-new')
  // The two shells of the copy are no session.
  const shells = await session({ storage: remembered('sdd'), terminals: { copy: [shell('term-a'), shell('term-b')] } })
  assert.deepEqual(shells.answer, { ok: true, data: { ...NEW_EPIC, worktree: shells.copy } })
  // A record that names no terminal is no record.
  for (const record of [{}, { terminal: '' }, { terminal: 7 }, 'term-epic', null]) {
    const broken = await session({ storage: { [`session:${HANDLE}:7`]: record }, terminals: { copy: [agent('term-new')] } })
    assert.equal(broken.answer.ok && broken.answer.data.terminal, 'term-new', JSON.stringify(record))
  }
})

test('epic.session: the terminal of the old dispatcher in the root is no session', async () => {
  // Titles are not read: neither the one the dispatcher gave its terminal nor the ones of a start.
  const root = [agent('term-old', 'conport epic 7'), agent('term-titled', 'conport epic 7 · workflow'), agent('term-sdd', 'conport epic 7 · SDD')]
  for (const storage of [{ [`way:${HANDLE}:7`]: 'workflow' }, remembered('workflow')]) {
    const byWorkflow = await session({ copy: false, storage, terminals: { root } })
    assert.deepEqual(byWorkflow.answer, { ok: true, data: { ...NEW_EPIC, way: 'workflow' } })
  }
  // By SDD the root is not even asked for.
  const bySdd = await session({ copy: false, terminals: { root } })
  assert.deepEqual(bySdd.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(bySdd.listed, [])
  const withCopy = await session({ terminals: { root, copy: [shell('term-a')] } })
  assert.equal(withCopy.answer.ok && withCopy.answer.data.alive, false)
  assert.deepEqual(withCopy.listed, withCopy.inCopy)
})

test('epic.session answers the stored way, harness and roles, and the defaults for a new epic', async () => {
  const chosen = async (storage: Record<string, unknown>) => {
    const { answer } = await session({ copy: false, storage, terminals: { root: [] } })
    return answer.ok ? { way: answer.data.way, harness: answer.data.harness, roles: answer.data.roles } : answer.error
  }
  assert.deepEqual(DEFAULT_ROLES, {
    implementer: 'conport:sdd-implementer',
    reviewer: 'conport:sdd-task-reviewer',
    gapHunter: 'conport:sdd-gap-hunter',
    finalReviewer: 'conport:sdd-final-reviewer'
  })
  assert.deepEqual(await chosen({}), { way: 'sdd', harness: 'claude', roles: DEFAULT_ROLES })
  // A new epic takes the harness of the last start in the project.
  assert.deepEqual(await chosen({ [`harness:${HANDLE}`]: 'codex' }), { way: 'sdd', harness: 'codex', roles: DEFAULT_ROLES })
  // What another epic and another project chose, and the old record of the project, are not read.
  const elsewhere = {
    [`way:${HANDLE}:15`]: 'workflow',
    [`harness:${HANDLE}:15`]: 'cursor',
    [`roles:${HANDLE}:15`]: TYPES,
    [`way:${HANDLE}:70`]: 'workflow',
    [`harness:${HANDLE}:70`]: 'cursor',
    'way:prother000:7': 'workflow',
    'harness:prother000:7': 'cursor',
    'harness:prother000': 'cursor',
    [`roles:${HANDLE}`]: ROLES,
    [`prepare:${HANDLE}`]: 'cursor'
  }
  assert.deepEqual(await chosen(elsewhere), { way: 'sdd', harness: 'claude', roles: DEFAULT_ROLES })
  // The records of the epic itself win over the harness of the project.
  const own = { [`way:${HANDLE}:7`]: 'workflow', [`harness:${HANDLE}:7`]: 'claude', [`roles:${HANDLE}:7`]: TYPES, [`harness:${HANDLE}`]: 'codex' }
  assert.deepEqual(await chosen({ ...elsewhere, ...own }), { way: 'workflow', harness: 'claude', roles: TYPES })
  // A record that is not what a start writes is no record.
  const broken = { [`way:${HANDLE}:7`]: 'dispatcher', [`harness:${HANDLE}:7`]: '', [`roles:${HANDLE}:7`]: { ...TYPES, reviewer: 7 }, [`harness:${HANDLE}`]: 3 }
  assert.deepEqual(await chosen(broken), { way: 'sdd', harness: 'claude', roles: DEFAULT_ROLES })
  assert.deepEqual(await chosen({ [`roles:${HANDLE}:7`]: {} }), { way: 'sdd', harness: 'claude', roles: DEFAULT_ROLES })
})

test('epic.session finds the session epic.start has just opened', async () => {
  for (const way of ['sdd', 'workflow'] as const) {
    const machine = await startMachine({
      // The fake lists the copy from the outset: the start takes it as it is.
      rows: way === 'sdd' ? (dir) => [worktreeRow(join(dir, 'copies', 'repo', 'epic-7'), 'epic-7')] : undefined,
      refs: way === 'sdd' ? ['refs/heads/epic-7'] : [],
      orca: [{ match: 'terminal list --worktree path:', stdout: json({ ok: true, result: { terminals: [shell('term-a'), agent(EPIC_TERMINAL)], truncated: false } }) }]
    })
    // Named by its name at the start, the project is remembered by its handle: the panel asks by that.
    const begun = await startOn(machine, { way, project: 'shop-api' })
    assert.equal(begun.answer.ok, true)
    const { f, worker } = machine
    const answer = await worker.request('epic.session', { project: HANDLE, root: f.root, epic: 7 })
    await worker.deactivate()
    const place = way === 'sdd' ? begun.copy : f.root
    const expected: EpicSession = { way, harness: 'claude', roles: TYPES, worktree: way === 'sdd' ? begun.copy : null, alive: true, terminal: EPIC_TERMINAL, workflowBranches: false }
    assert.deepEqual(answer, { ok: true, data: expected }, way)
    assert.deepEqual(f.orcaCalls().at(-1), ['terminal', 'list', '--worktree', `path:${place}`, '--limit', '10000', '--json'])
  }
})

test('epic.session answers with the main working tree on no branch', async () => {
  // The base of a new copy is of no matter to the question whether a session is alive.
  const { answer, copy } = await session({ base: null, storage: remembered('sdd'), terminals: { copy: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: copy, alive: true, terminal: EPIC_TERMINAL } })
})

test('epic.session decides nothing on a list orca cut short', async () => {
  const copies = {
    code: 'workspaces_truncated',
    message: 'список рабочих копий репозитория не поместился в ответ Orca: их больше 10000',
    action: 'удалите ненужные рабочие копии репозитория в Orca и повторите'
  }
  // The copy of the epic may be among the rows cut off.
  assert.deepEqual((await session({ copy: false, truncated: true })).answer, { ok: false, error: copies })
  // A list cut short that holds the copy is enough.
  const held = await session({ truncated: true, terminals: { copy: [agent('term-new')] } })
  assert.equal(held.answer.ok && held.answer.data.alive, true)

  const terminals = {
    code: 'terminals_truncated',
    message: 'список терминалов рабочего места не поместился в ответ Orca',
    action: 'закройте лишние терминалы этого рабочего места в Orca и нажмите «Обновить»'
  }
  // The terminal of the session may be among the rows cut off.
  const cut = await session({ storage: remembered('sdd'), terminals: { copy: [shell('term-a')] }, terminalsTruncated: true })
  assert.deepEqual(cut.answer, { ok: false, error: terminals })
  assert.deepEqual(refusalText(terminals), { what: terminals.message, action: terminals.action })
  // A session found in the part that came is alive all the same.
  const found = await session({ storage: remembered('sdd'), terminals: { copy: [agent(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.equal(found.answer.ok && found.answer.data.alive, true)
  // The remembered terminal is there with no agent in it: another agent of the copy may be cut off.
  const left = await session({ storage: remembered('sdd'), terminals: { copy: [shell(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.deepEqual(left.answer, { ok: false, error: terminals })
  // In the root nothing cut off would change that: only the remembered terminal counts there.
  const inRoot = await session({ copy: false, storage: remembered('workflow'), terminals: { root: [shell(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.equal(inRoot.answer.ok && inRoot.answer.data.alive, false)
})

test('epic.session returns a refusal of orca and of git', async () => {
  const refusal = { code: 'runtime_unavailable', message: 'Orca is not running', action: 'start Orca' }
  const refused = (match: string): FakeAnswer => ({ match, code: 1, stdout: json({ ok: false, error: refusal }) })
  for (const match of ['worktree list', 'terminal list']) {
    const { answer } = await session({ orca: [refused(match)], terminals: { copy: [] } })
    assert.deepEqual(answer, { ok: false, error: refusal }, match)
  }
  const git = await session({ git: [{ match: '-C ', code: 128, stderr: 'fatal: not a repository\n' }] })
  assert.deepEqual(git.answer, {
    ok: false,
    error: { code: 'git_failed', message: 'fatal: not a repository', action: 'проверьте репозиторий командой git status в его корне и повторите' }
  })
  assert.deepEqual(git.f.orcaCalls(), [])
})

/** What a request about the session of an epic answers when its project is not named by the handle. */
const NOT_HANDLE = {
  code: 'project_not_handle',
  message: 'проект назван не по handle: выбор и сессия эпика хранятся под handle проекта',
  action: 'нажмите «Обновить»'
}

test('epic.session refuses a project that is not named by its handle', async () => {
  // What a start by this name remembered lies under the handle: an answer by the name would say "no session".
  const stored = { ...remembered('sdd'), 'way:shop-api:7': 'workflow', 'session:shop-api:7': { terminal: EPIC_TERMINAL, way: 'workflow' } }
  // A name, an address by name, a handle a letter short, a letter long, in capitals, and no string at all.
  for (const project of ['shop-api', 'pers/shop-api', `${HANDLE}/shop-api`, '', HANDLE.slice(0, -1), `${HANDLE}x`, HANDLE.toUpperCase(), 7, null]) {
    const { answer, f } = await session({ project, storage: stored, terminals: { copy: [agent(EPIC_TERMINAL)], root: [agent(EPIC_TERMINAL)] } })
    assert.deepEqual(answer, { ok: false, error: NOT_HANDLE }, JSON.stringify(project))
    // Nothing is asked on a name.
    assert.deepEqual([f.conportCalls(), f.orcaCalls(), f.gitCalls()], [[], [], []])
  }
  assert.deepEqual(refusalText(NOT_HANDLE), { what: NOT_HANDLE.message, action: NOT_HANDLE.action })
  // The form of a handle is one for the worker and the panel.
  assert.equal(HANDLE_FORM.test(HANDLE), true)
})

// --- epic.tasks ---

/** A task as `conport api tasks list` prints it: with more fields than the panel reads. */
const listedTask = (task: EpicTask): Record<string, unknown> => ({ ...task, kind: 'task', priority: 3, parent_task_id: 7, description: 'A long text' })

const tasksPage = (offset: number, tasks: EpicTask[], total: number): FakeAnswer => ({
  match: `api tasks list --parent_task_id 7 --status ALL --include_snoozed true --limit 200 --offset ${offset} --project ${HANDLE}`,
  stdout: json({ tasks: tasks.map(listedTask), total })
})

const tasksCall = (offset: number): string[] => [
  'api', 'tasks', 'list', '--parent_task_id', '7', '--status', 'ALL', '--include_snoozed', 'true', '--limit', '200', '--offset', String(offset), '--project', HANDLE
]

async function epicTasks(conport: FakeAnswer[]) {
  const f = fake(conport)
  const worker = await mountWorker(f.worker, { host: f.host() })
  const answer = await worker.request('epic.tasks', { project: HANDLE, root: f.root, epic: 7 })
  await worker.deactivate()
  return { f, answer }
}

test('epic.tasks names the seven statuses and puts the cancelled last', async () => {
  const cancelled: EpicTask = { id: 29, title: 'Keep the old ranking', status: 'CANCELLED' }
  const { f, answer } = await epicTasks([tasksPage(0, [...EPIC_TASKS, cancelled], 8)])
  // The number, the title and the status of each: by the number, the cancelled ones after the rest.
  assert.deepEqual(answer, {
    ok: true,
    data: [
      { id: 31, title: 'Store the embeddings', status: 'DONE' },
      { id: 32, title: 'Build the index', status: 'REVIEW' },
      { id: 33, title: 'Search by a phrase', status: 'IN_PROGRESS' },
      { id: 34, title: 'Read the queries', status: 'BLOCKED' },
      { id: 35, title: 'Rank the answers', status: 'TODO' },
      { id: 36, title: 'Measure the search', status: 'PARKED' },
      { id: 29, title: 'Keep the old ranking', status: 'CANCELLED' },
      { id: 30, title: 'Drop the old index', status: 'CANCELLED' }
    ]
  })
  assert.equal(new Set(EPIC_TASKS.map((task) => task.status)).size, 7)
  assert.deepEqual(f.conportCalls(), [tasksCall(0)])
  assert.deepEqual(f.orcaCalls(), [])
  // An epic without a task.
  const empty = await epicTasks([tasksPage(0, [], 0)])
  assert.deepEqual(empty.answer, { ok: true, data: [] })
  assert.deepEqual(empty.f.conportCalls(), [tasksCall(0)])
})

test('epic.tasks reads every page of an epic with more than 200 tasks', async () => {
  const all: EpicTask[] = Array.from({ length: 450 }, (_, i) => ({ id: 1000 - i, title: `Task ${1000 - i}`, status: i === 449 ? 'CANCELLED' : 'TODO' }))
  const { f, answer } = await epicTasks([tasksPage(0, all.slice(0, 200), 450), tasksPage(200, all.slice(200, 400), 450), tasksPage(400, all.slice(400), 450)])
  assert.equal(answer.ok && answer.data.length, 450)
  assert.deepEqual(answer.ok && answer.data.slice(0, 2).map((task) => task.id), [552, 553])
  assert.deepEqual(answer.ok && answer.data.at(-1), { id: 551, title: 'Task 551', status: 'CANCELLED' })
  assert.deepEqual(f.conportCalls(), [tasksCall(0), tasksCall(200), tasksCall(400)])
  // Exactly a page: no second one is asked for.
  const page = await epicTasks([tasksPage(0, all.slice(0, 200), 200)])
  assert.equal(page.answer.ok && page.answer.data.length, 200)
  assert.deepEqual(page.f.conportCalls(), [tasksCall(0)])
  // One task over a page.
  const over = await epicTasks([tasksPage(0, all.slice(0, 200), 201), tasksPage(200, all.slice(200, 201), 201)])
  assert.equal(over.answer.ok && over.answer.data.length, 201)
  assert.deepEqual(over.f.conportCalls(), [tasksCall(0), tasksCall(200)])
  // A page that comes empty before the total is reached ends the reading: tasks were removed meanwhile.
  const fewer = await epicTasks([tasksPage(0, all.slice(0, 2), 5), tasksPage(2, [], 5)])
  assert.equal(fewer.answer.ok && fewer.answer.data.length, 2)
  assert.deepEqual(fewer.f.conportCalls(), [tasksCall(0), tasksCall(2)])
})

test('epic.tasks returns the refusal of the cli, of the first page or of a later one', async () => {
  const refused = (offset: number): FakeAnswer => ({ ...tasksPage(offset, [], 0), code: 1, stdout: json({ ok: false, error: NO_KEY }) })
  assert.deepEqual((await epicTasks([refused(0)])).answer, { ok: false, error: NO_KEY })
  const first = Array.from({ length: 200 }, (_, i): EpicTask => ({ id: i + 1, title: `Task ${i + 1}`, status: 'TODO' }))
  // A part of the tasks is not shown as all of them.
  assert.deepEqual((await epicTasks([tasksPage(0, first, 300), refused(200)])).answer, { ok: false, error: NO_KEY })
  // An answer that is no list of tasks.
  const odd = await epicTasks([{ match: 'api tasks list', stdout: json({ detail: 'ok' }) }])
  assert.deepEqual(odd.answer, { ok: false, error: { code: 'bad_output', message: 'conport ответил без списка задач', action: 'обновите conport' } })
})

// --- subagents.get ---

async function subagentsOf(harness: string, conport: FakeAnswer[]) {
  const f = fake(conport)
  const worker = await mountWorker(f.worker, { host: f.host() })
  const answer = await worker.request('subagents.get', { root: f.root, harness })
  await worker.deactivate()
  return { f, answer }
}

test('subagents.get returns what epic subagents answered', async () => {
  const { f, answer } = await subagentsOf('claude', [{ match: 'epic subagents --harness claude --json', stdout: json(SUBAGENTS) }])
  assert.deepEqual(answer, { ok: true, data: SUBAGENTS })
  assert.deepEqual(f.conportCalls(), [['epic', 'subagents', '--harness', 'claude', '--json']])
  assert.deepEqual(f.orcaCalls(), [])
  // A harness without typed subagents answers so, and that is passed on.
  const untyped = { harness: 'codex', typed: false, subagents: [] }
  const codex = await subagentsOf('codex', [{ match: 'epic subagents --harness codex --json', stdout: json(untyped) }])
  assert.deepEqual(codex.answer, { ok: true, data: untyped })
})

test('subagents.get returns the refusal of the cli', async () => {
  const error = {
    code: 'subagents_unavailable',
    message: 'claude plugin list did not answer',
    action: 'install Claude Code or make claude visible on the PATH, then run the command again'
  }
  // As `--json` prints a refusal, and as the one line of the error stream.
  const printed: Array<Omit<FakeAnswer, 'match'>> = [
    { code: 1, stdout: json({ ok: false, error }) },
    { code: 1, stderr: `${error.code}: ${error.message} — ${error.action}\n` }
  ]
  for (const answer of printed) {
    const refused = await subagentsOf('claude', [{ match: 'epic subagents', ...answer }])
    assert.deepEqual(refused.answer, { ok: false, error })
  }
  const unknown = { code: 'invalid_argument', message: 'unknown harness "aider"', action: 'choose one of claude, codex, cursor' }
  const aider = await subagentsOf('aider', [{ match: 'epic subagents --harness aider', code: 2, stdout: json({ ok: false, error: unknown }) }])
  assert.deepEqual(aider.answer, { ok: false, error: unknown })
})

test('subagents.get refuses a harness that is not named', async () => {
  const error = { code: 'harness_invalid', message: 'харнесс не назван', action: 'выберите харнесс эпика' }
  for (const harness of ['', '  ', 7, null, undefined]) {
    const { f, answer } = await subagentsOf(harness as string, [])
    assert.deepEqual(answer, { ok: false, error }, JSON.stringify(harness))
    assert.deepEqual(f.conportCalls(), [])
  }
  assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
})

// --- terminal.show ---

const SWITCH = (terminal: string): string[][] => [['terminal', 'switch', '--terminal', terminal, '--json']]

test('terminal.show switches to the live terminal of the session of the epic', async () => {
  const sdd = await show({ storage: remembered('sdd'), terminals: { copy: [shell('term-a'), agent(EPIC_TERMINAL)] } })
  assert.deepEqual(sdd.answer, { ok: true, data: null })
  assert.deepEqual(sdd.switched, SWITCH(EPIC_TERMINAL))
  // The copies and their terminals are read anew, the branches and ConPort are not.
  assert.deepEqual(sdd.f.orcaCalls().map((call) => call.slice(0, 2).join(' ')), ['worktree list', 'terminal list', 'terminal switch'])
  assert.deepEqual(sdd.listed, sdd.inCopy)
  assert.deepEqual([sdd.f.gitCalls(), sdd.f.conportCalls()], [[], []])
  assert.deepEqual(sdd.refusals, [])
  // The terminal is found by the rule of epic.session: after a restart of Orca, the agent of the copy.
  const again = await show({ storage: remembered('sdd'), terminals: { copy: [shell('term-a'), agent('term-new')] } })
  assert.deepEqual(again.answer, { ok: true, data: null })
  assert.deepEqual(again.switched, SWITCH('term-new'))
  const workflow = await show({ copy: false, storage: remembered('workflow'), terminals: { root: [agent('term-other'), agent(EPIC_TERMINAL)] } })
  assert.deepEqual(workflow.answer, { ok: true, data: null })
  assert.deepEqual(workflow.switched, SWITCH(EPIC_TERMINAL))
  assert.deepEqual(workflow.listed, workflow.inRoot)
})

test('terminal.show refuses when the epic has no live session, and switches to nothing', async () => {
  const error = { code: 'session_gone', message: 'у эпика 7 нет живой сессии: её терминал закрыт или агент в нём завершился', action: 'нажмите «Обновить»' }
  const gone: SessionCase[] = [
    // No working copy; a copy with its two shells; an agent that left its terminal.
    { copy: false, storage: remembered('sdd') },
    { storage: remembered('sdd'), terminals: { copy: [shell('term-a'), shell('term-b')] } },
    { storage: remembered('sdd'), terminals: { copy: [shell(EPIC_TERMINAL)] } },
    // By the workflow: a terminal never remembered, one that is gone, and an agent of someone else in the root.
    { copy: false, storage: { [`way:${HANDLE}:7`]: 'workflow' }, terminals: { root: [agent('term-other')] } },
    { copy: false, storage: remembered('workflow'), terminals: { root: [agent('term-other')] } }
  ]
  for (const [i, options] of gone.entries()) {
    const { answer, switched } = await show(options)
    assert.deepEqual(answer, { ok: false, error }, String(i))
    assert.deepEqual(switched, [])
  }
  assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
})

test('terminal.show refuses a project that is not named by its handle, and returns a refusal of orca', async () => {
  const byName = await show({ project: 'shop-api', storage: remembered('sdd'), terminals: { copy: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(byName.answer, { ok: false, error: NOT_HANDLE })
  assert.deepEqual(byName.f.orcaCalls(), [])
  // The panel asked for this terminal: that orca cannot show it is told, not only logged.
  const refusal = { code: 'terminal_not_found', message: 'no such terminal' }
  for (const match of ['worktree list', 'terminal list', 'terminal switch']) {
    const refused = await show({
      storage: remembered('sdd'),
      terminals: { copy: [agent(EPIC_TERMINAL)] },
      orca: [{ match, code: 1, stdout: json({ ok: false, error: refusal }) }]
    })
    assert.deepEqual(refused.answer, { ok: false, error: { ...refusal, action: '' } }, match)
  }
})
