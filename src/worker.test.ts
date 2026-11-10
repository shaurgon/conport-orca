// The worker against the fake conport and orca executables (test/fake-cli.mjs): every call
// spawns a real child process, as in Orca.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { AGENTS, EPIC_LIST, HANDLE, NO_KEY, RUNNING, TASK_LIST } from '../test/fixtures'
import { type FakeAnswer, type FakeDirs, fake, json } from '../test/fake'
import { CLI_VERSION, handTask, prepareTask } from './cli'
import type { EpicList, HandMode, TaskList } from './protocol'

const NPX = `npx -y conport@${CLI_VERSION}`
const SWITCHED = { match: 'terminal switch --terminal term-1 ', stdout: json({ ok: true, result: {} }) }

const ROLES = { implementer: 'codex', reviewer: 'claude', gapHunter: 'claude', finalReviewer: 'gemini' }

function writeSettings(dir: string, value: unknown): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(value))
}

test('start opens a terminal with the run command', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(RUNNING) }], [SWITCHED])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('run.start', { project: HANDLE, root: f.root, epic: 7, roles: ROLES })

  const command =
    `${NPX} epic run 7 --project ${HANDLE} --host orca` +
    ' --implementer codex --reviewer claude --gap-hunter claude --final-reviewer gemini'
  assert.deepEqual(answer, { ok: true, data: { terminalId: 'term-1', command } })
  assert.deepEqual(
    host.callsOf('terminal.create'),
    [{ workspaceId: 'ws-root', title: 'conport epic 7', command }]
  )
  // The terminal comes to the front: preflight refusals of the run are printed there.
  assert.deepEqual(f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
  assert.deepEqual(host.callsOf('notifications.show'), [])
  // The choice is remembered for the project.
  assert.deepEqual(host.data().storage[`roles:${HANDLE}`], ROLES)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a run terminal orca cannot bring forward is only logged', async () => {
  const refused = { ok: false, error: { code: 'terminal_not_found', message: 'no such terminal' } }
  const f = fake([], [{ match: 'terminal switch', code: 1, stdout: json(refused) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('run.start', { project: HANDLE, root: f.root, epic: 7, roles: ROLES })
  assert.equal(answer.ok, true)
  // The panel names the terminal itself: the worker shows no notification.
  assert.deepEqual(host.callsOf('notifications.show'), [])
  assert.equal(worker.logs.some((line) => line.includes('terminal_not_found')), true, JSON.stringify(worker.logs))
  await worker.deactivate()
})

test('start refuses when the repository root is not a workspace of Orca', async () => {
  const f = fake([])
  for (const [truncated, code] of [[false, 'root_not_open'], [true, 'workspaces_truncated']] as const) {
    const host = f.host({ 'workspace.list': { workspaces: [], truncated } })
    const worker = await mountWorker(f.worker, { host })
    const answer = await worker.request('run.start', { project: HANDLE, root: f.root, epic: 7, roles: ROLES })
    // A cut list of workspaces is not a sign that the root is missing from Orca.
    assert.equal(answer.ok === false && answer.error.code, code)
    assert.deepEqual(host.callsOf('terminal.create'), [])
    await worker.deactivate()
  }
})

test('the run of an epic reads epic status json once', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(RUNNING) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('run.get', { project: HANDLE, root: f.root, epic: 7 })

  assert.deepEqual(answer, { ok: true, data: RUNNING })
  assert.deepEqual(f.conportCalls(), [['epic', 'status', '7', '--project', HANDLE, '--json']])
  assert.deepEqual(worker.posts, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'orca-plugin.json')
const statusCalls = (f: ReturnType<typeof fake>): number => f.conportCalls().filter((c) => c[1] === 'status').length

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
  // A live run: the worker used to read it again on a timer and after each agent event.
  const f = fake([{ match: 'epic status 7', stdout: json(RUNNING) }], [SWITCHED])
  const host = f.host()
  const timers = pendingTimers()
  try {
    const worker = await mountWorker(f.worker, { host })
    await worker.request('run.get', { project: HANDLE, root: f.root, epic: 7 })
    await worker.request('run.start', { project: HANDLE, root: f.root, epic: 7, roles: ROLES })
    await worker.request('run.stop', { project: HANDLE, root: f.root, epic: 7 }).catch(() => undefined)
    // Nothing is left scheduled once the answers are in: no read waits its turn, however far off.
    assert.deepEqual(timers.delays(), [])
    assert.equal(statusCalls(f), 1)
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

test('stop calls epic stop', async () => {
  const stopped = { ...RUNNING, phase: 'stopped', outcome: { kind: 'stopped' } }
  const f = fake([
    { match: 'epic stop 7', stdout: json({ ok: true }) },
    { match: 'epic status 7', stdout: json(stopped) }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  const answer = await worker.request('run.stop', { project: HANDLE, root: f.root, epic: 7 })
  assert.deepEqual(answer, { ok: true, data: stopped })
  assert.deepEqual(f.conportCalls()[0], ['epic', 'stop', '7', '--project', HANDLE, '--json'])
  await worker.deactivate()
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
    ['terminal', 'list', '--worktree', `path:${ELSEWHERE}`, '--json'],
    ['terminal', 'list', '--worktree', `path:${f.focused}`, '--json'],
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
  const missing = createWorker({ conport: ['/nonexistent/bin/npx', '-y', 'conport'], orca: ['/nonexistent/bin/orca'] })
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

test('agents come from epic agents json with the roles chosen before', async () => {
  const f = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
  const host = mockHost({ storage: { [`roles:${HANDLE}`]: ROLES } })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await worker.request('agents.get', { project: HANDLE, root: f.root }), {
    ok: true,
    data: { agents: AGENTS.agents, chosen: ROLES, preparer: null }
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
      chosen: null,
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
    data: { agents: AGENTS.agents, chosen: null, preparer: null }
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

test('the run starts in a terminal of the chosen project root', async () => {
  const f = fake([], [SWITCHED])
  const billing = join(dirname(f.root), 'billing')
  const host = f.host({
    'workspace.list': {
      workspaces: [
        { id: 'ws-root', kind: 'worktree', name: 'repo', path: f.root, branch: 'main', hostId: null },
        { id: 'ws-billing', kind: 'worktree', name: 'billing', path: `${billing}/`, branch: 'main', hostId: null }
      ],
      truncated: false
    }
  })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('run.start', { project: 'billing-api', root: billing, epic: 3, roles: ROLES })
  assert.equal(answer.ok, true)
  assert.deepEqual(host.callsOf('terminal.create').map((c) => (c as { workspaceId: string }).workspaceId), ['ws-billing'])
  await worker.deactivate()
})

test('run command quotes an agent id the shell would split', async () => {
  const { runCommand } = await import('./cli')
  assert.equal(
    runCommand(7, HANDLE, { implementer: 'my agent', reviewer: "o'neil", gapHunter: 'a', finalReviewer: 'b' }),
    `${NPX} epic run 7 --project ${HANDLE} --host orca --implementer 'my agent' --reviewer 'o'\\''neil' --gap-hunter a --final-reviewer b`
  )
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
    assert.match(task, new RegExp(`\`[^\`]* api tasks list --parent_task_id ${epic} --status ALL --limit 200 --project [^\`]+\``))
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

test('prepare refuses an epic that is ready, has nothing to prepare or is gone, and an agent not found', async () => {
  const unreadable: EpicList = {
    ...EPIC_LIST,
    epics: [{ id: 20, title: 'Payments', status: 'TODO', progress: { open: 2, total: 2 }, milestone: null, runnable: false, reason: 'the documents of the epic cannot be read', run: null }]
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
  tasks: [...TASK_LIST.tasks, { id: 46, title: 'Trim the export', status: 'IN_PROGRESS', priority: 3, changes_requested: true }]
}

test('fix a task the review sent back: its branch, the latest review, a fix entry', async () => {
  const { f, answer, created, args, task } = await hand(46, 'fix', 'codex', SENT_BACK)
  assert.equal(answer.ok, true)
  assert.deepEqual(created.map((c) => c.title), ['conport fix 46'])
  assert.equal(args.length, 1)
  assert.equal(task, handTask({ task: 46, project: HANDLE, mode: 'fix', agent: 'codex', root: f.root }))
  assert.match(task, /^Fix task 46 of the ConPort project prk7m2qx9d after its review asked for changes/)
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
