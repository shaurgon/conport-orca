// The worker against the fake conport and orca executables (test/fake-cli.mjs): every call
// spawns a real child process, as in Orca.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { AGENTS, EPIC_LIST, HANDLE, NO_KEY, QUESTION, RUNNING } from '../test/fixtures'
import { fake, json, until } from '../test/fake'
import { CLI_VERSION } from './cli'

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

test('a run terminal orca cannot bring forward is named in a notification', async () => {
  const refused = { ok: false, error: { code: 'terminal_not_found', message: 'no such terminal' } }
  const f = fake([], [{ match: 'terminal switch', code: 1, stdout: json(refused) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('run.start', { project: HANDLE, root: f.root, epic: 7, roles: ROLES })
  assert.equal(answer.ok, true)
  assert.deepEqual(host.callsOf('notifications.show'), [
    {
      title: 'Эпик 7: прогон запущен',
      body: 'Терминал «conport epic 7» в корне репозитория: там видно, если прогон откажет при подготовке.'
    }
  ])
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

test('board reads epic status json', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(QUESTION) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })

  assert.deepEqual(answer, { ok: true, data: QUESTION })
  assert.deepEqual(f.conportCalls(), [['epic', 'status', '7', '--project', HANDLE, '--json']])
  // The status bar: "epic <N>: done/total, questions K".
  const bar = host.callsOf('statusBar.update').at(-1) as { text: string; visible: boolean }
  assert.equal(bar.text, 'эпик 7: 1/6, вопросов 1')
  assert.equal(bar.visible, true)
  assert.deepEqual(worker.posts.at(-1), {
    event: 'board.changed',
    payload: { project: HANDLE, epic: 7, board: { ok: true, data: QUESTION } }
  })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the status bar hides for an epic that never ran', async () => {
  const idle = { epic: 15, phase: 'none', tasks: [], questions: [], outcome: null, paused: null }
  const f = fake([{ match: 'epic status 15', stdout: json(idle) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  await worker.request('board.get', { project: HANDLE, root: f.root, epic: 15 })
  const bar = host.callsOf('statusBar.update').at(-1) as { text: string; visible: boolean }
  assert.deepEqual([bar.text, bar.visible], ['эпик 15: 0/0, вопросов 0', false])
  await worker.deactivate()
})

const FAST = { pollMs: 5, nudgeMs: 5, startGraceMs: 60_000 }
const IDLE = { epic: 7, phase: 'none', tasks: [], questions: [], outcome: null, paused: null }
const statusCalls = (f: ReturnType<typeof fake>): number => f.conportCalls().filter((c) => c[1] === 'status').length

test('the board of a live run is read again', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(RUNNING) }], undefined, FAST)
  const worker = await mountWorker(f.worker, { host: f.host() })
  await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })
  await until(() => statusCalls(f) >= 3)
  await worker.deactivate()
})

test('a failed read of a live board keeps the board watched', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(RUNNING) }], undefined, FAST)
  const scenario = join(dirname(f.root), 'conport.json')
  const answers = (stdout: string, code = 0) =>
    writeFileSync(scenario, JSON.stringify({ log: join(dirname(f.root), 'conport.log'), answers: [{ match: 'epic status 7', stdout, code }] }))
  const worker = await mountWorker(f.worker, { host: f.host() })
  await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })
  // One read fails (ConPort away), and the next ones answer again.
  answers(json({ ok: false, error: { code: 'conport_unreachable', message: 'ConPort did not answer', action: 'check the network' } }) ?? '', 1)
  const failedFrom = statusCalls(f)
  await until(() => statusCalls(f) >= failedFrom + 2)
  answers(json(RUNNING) ?? '')
  const backFrom = statusCalls(f)
  await until(() => statusCalls(f) >= backFrom + 2)
  await worker.deactivate()
})

test('the board of an epic that is not running is read once', async () => {
  const done = { ...RUNNING, phase: 'ready', outcome: { kind: 'ready', head: 'abc123' } }
  for (const board of [IDLE, done]) {
    const f = fake([{ match: 'epic status 7', stdout: json(board) }], undefined, FAST)
    const worker = await mountWorker(f.worker, { host: f.host() })
    await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(statusCalls(f), 1, `phase ${board.phase}`)
    await worker.deactivate()
  }
})

test('an agent changing state brings the board of a live run in early', async () => {
  const SLOW_POLL = { ...FAST, pollMs: 60_000 }
  const event = { workspaceId: null, paneKey: 'tab:pane', state: 'done', receivedAt: 1 } as const
  const live = fake([{ match: 'epic status 7', stdout: json(RUNNING) }], undefined, SLOW_POLL)
  let worker = await mountWorker(live.worker, { host: live.host() })
  await worker.request('board.get', { project: HANDLE, root: live.root, epic: 7 })
  await worker.emit('agent.status.changed', event)
  await until(() => statusCalls(live) >= 2)
  await worker.deactivate()

  // A board that is not live is left alone.
  const idle = fake([{ match: 'epic status 7', stdout: json(IDLE) }], undefined, SLOW_POLL)
  worker = await mountWorker(idle.worker, { host: idle.host() })
  await worker.request('board.get', { project: HANDLE, root: idle.root, epic: 7 })
  await worker.emit('agent.status.changed', event)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(statusCalls(idle), 1)
  await worker.deactivate()
})

test('a started run is read again while it shows no phase yet, until the grace ends', async () => {
  const start = { project: HANDLE, epic: 7, roles: ROLES }
  const inGrace = fake([{ match: 'epic status 7', stdout: json(IDLE) }], [SWITCHED], FAST)
  let worker = await mountWorker(inGrace.worker, { host: inGrace.host() })
  await worker.request('run.start', { ...start, root: inGrace.root })
  await until(() => statusCalls(inGrace) >= 3)
  await worker.deactivate()

  // Past the grace a run that never showed a phase is read once and left alone.
  const pastGrace = fake([{ match: 'epic status 7', stdout: json(IDLE) }], [SWITCHED], { ...FAST, startGraceMs: 0 })
  worker = await mountWorker(pastGrace.worker, { host: pastGrace.host() })
  await worker.request('run.start', { ...start, root: pastGrace.root })
  await until(() => statusCalls(pastGrace) >= 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(statusCalls(pastGrace), 1)
  await worker.deactivate()
})

test('a new stop-list question is notified once', async () => {
  const f = fake([{ match: 'epic status 7', stdout: json(QUESTION) }])
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })
  await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })
  await worker.request('board.get', { project: HANDLE, root: f.root, epic: 7 })
  const shown = host.callsOf('notifications.show')
  assert.deepEqual(shown, [{ title: 'Эпик 7: вопрос по задаче 13', body: QUESTION.questions[0]?.text }])
  await worker.deactivate()
})

test('answer calls epic answer', async () => {
  const f = fake([
    { match: 'epic answer 7', stdout: json({ ok: true }) },
    { match: 'epic status 7', stdout: json(RUNNING) }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  const ref = { project: HANDLE, root: f.root, epic: 7 }
  const onTask = await worker.request('run.answer', { ...ref, task: 13, choice: 'запретить, решить иначе' })
  // A question of the epic itself (case 4) is answered without --task.
  await worker.request('run.answer', { ...ref, task: null, choice: 'продолжить здесь' })

  assert.deepEqual(onTask, { ok: true, data: RUNNING })
  assert.deepEqual(f.conportCalls(), [
    ['epic', 'answer', '7', '--task', '13', '--choice', 'запретить, решить иначе', '--project', HANDLE, '--json'],
    ['epic', 'status', '7', '--project', HANDLE, '--json'],
    ['epic', 'answer', '7', '--choice', 'продолжить здесь', '--project', HANDLE, '--json'],
    ['epic', 'status', '7', '--project', HANDLE, '--json']
  ])
  await worker.deactivate()
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

test('project comes from CONPORT_PROJECT_NAME of the repository settings', async () => {
  const f = fake([])
  // The settings of the main working tree count, not those of the focused worktree.
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  writeSettings(f.focused, { env: { CONPORT_PROJECT_NAME: 'somewhere-else' } })
  const worker = await mountWorker(f.worker, { host: f.host() })

  const answer = await worker.request('context.get')
  assert.deepEqual(answer, { ok: true, data: { root: f.root, project: 'shop-api', source: 'repository' } })
  await worker.deactivate()
})

test('project comes from the repository of the focused workspace', async () => {
  const f = fake([])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  // What `active` would name from the worker's own folder: the plugin's repository.
  writeSettings(f.pluginRepo, { env: { CONPORT_PROJECT_NAME: 'the-plugin' } })
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })

  const answer = await worker.request('context.get')
  assert.deepEqual(answer, { ok: true, data: { root: f.root, project: 'shop-api', source: 'repository' } })
  // The focused workspace is found through the host, then named to orca by its path.
  assert.equal(host.callsOf('workspace.readContext').length, 1)
  assert.deepEqual(f.orcaCalls(), [
    ['worktree', 'show', '--worktree', `path:${f.focused}`, '--json'],
    ['repo', 'show', '--repo', 'id:repo-focus', '--json']
  ])
  await worker.deactivate()
})

test('the one workspace of the focused name is taken when no branch matches', async () => {
  const f = fake([])
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
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
  assert.deepEqual(await worker.request('context.get'), {
    ok: true,
    data: { root: f.root, project: 'shop-api', source: 'repository' }
  })
  await worker.deactivate()
})

test('without a focused workspace the repository is not guessed', async () => {
  const f = fake([])
  const named = (path: string, branch: string) => ({ id: path, kind: 'worktree', name: 'feature', path, branch, hostId: null })
  const list = (...workspaces: ReturnType<typeof named>[]) => ({ 'workspace.list': { workspaces, truncated: false } })
  const cases = [
    [{ 'workspace.readContext': null }, 'no_workspace'],
    [{ 'workspace.list': { workspaces: [], truncated: false } }, 'no_workspace'],
    [{ 'workspace.list': { workspaces: [], truncated: true } }, 'workspaces_truncated'],
    // Two workspaces of the focused name on the focused branch: either repository could be meant.
    [list(named('/a/feature', 'feature'), named('/b/feature', 'feature')), 'workspace_ambiguous'],
    // Two of the focused name, neither on the focused branch.
    [list(named('/a/feature', 'hotfix'), named('/b/feature', 'main')), 'workspace_ambiguous']
  ] as const
  for (const [results, code] of cases) {
    const worker = await mountWorker(f.worker, { host: f.host(results) })
    const answer = await worker.request('context.get')
    assert.equal(answer.ok === false && answer.error.code, code)
    await worker.deactivate()
  }
  assert.deepEqual(f.orcaCalls(), [])
})

test('without the repository setting the project is asked once and remembered', async () => {
  const f = fake([])
  writeSettings(f.root, { env: { OTHER: 'x' } })
  const host = f.host()
  const worker = await mountWorker(f.worker, { host })

  assert.deepEqual(await worker.request('context.get'), {
    ok: true,
    data: { root: f.root, project: null, source: null }
  })
  assert.deepEqual(await worker.request('project.set', { root: f.root, project: ' shop-api ' }), {
    ok: true,
    data: { root: f.root, project: 'shop-api', source: 'stored' }
  })
  assert.deepEqual(await worker.request('context.get'), {
    ok: true,
    data: { root: f.root, project: 'shop-api', source: 'stored' }
  })
  assert.deepEqual(await worker.request('project.forget', { root: f.root }), {
    ok: true,
    data: { root: f.root, project: null, source: null }
  })
  await worker.deactivate()
})

test('an orca refusal while finding the repository is returned as is', async () => {
  const refusal = { ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running' } }
  const f = fake([], [{ match: 'worktree show', code: 1, stdout: json(refusal) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('context.get'), {
    ok: false,
    error: { code: 'runtime_unavailable', message: 'Orca is not running', action: '' }
  })
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
    data: { agents: AGENTS.agents, chosen: ROLES }
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
      chosen: null
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
    data: { agents: AGENTS.agents, chosen: null }
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

test('a task row brings the person to the terminal of its worktree', async () => {
  const wt = '/repo/.wt/ranking'
  const terminals = { ok: true, result: { terminals: [{ handle: 'term_a', worktreePath: wt }] } }
  const f = fake([], [
    { match: `terminal list --worktree path:${wt}`, stdout: json(terminals) },
    { match: 'terminal switch --terminal term_a', stdout: json({ ok: true, result: {} }) }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('task.open', { worktree: wt }), { ok: true, data: { terminal: 'term_a' } })
  assert.deepEqual(f.orcaCalls(), [
    ['terminal', 'list', '--worktree', `path:${wt}`, '--json'],
    ['terminal', 'switch', '--terminal', 'term_a', '--json']
  ])
  await worker.deactivate()
})

test('a task worktree without a terminal gets a new one in focus', async () => {
  const wt = '/repo/.wt/search-page'
  const f = fake([], [
    { match: `terminal list --worktree path:${wt}`, stdout: json({ ok: true, result: { terminals: [] } }) },
    { match: 'terminal create', stdout: json({ ok: true, result: { terminal: { handle: 'term_b' } } }) }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('task.open', { worktree: wt }), { ok: true, data: { terminal: 'term_b' } })
  assert.deepEqual(f.orcaCalls()[1], ['terminal', 'create', '--worktree', `path:${wt}`, '--focus', '--json'])
  await worker.deactivate()
})

test('the journal of a task opens in a terminal of the repository root', async () => {
  const f = fake([])
  const host = f.host({ 'terminal.create': { terminalId: 'term-j' } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('task.journal', { project: HANDLE, root: f.root, epic: 7, task: 13 })
  assert.deepEqual(answer, { ok: true, data: { terminalId: 'term-j' } })
  assert.deepEqual(host.callsOf('terminal.create'), [
    { workspaceId: 'ws-root', title: 'журнал задачи 13', command: `${NPX} journal get --task 13 --project ${HANDLE}` }
  ])
  await worker.deactivate()
})

test('run command quotes an agent id the shell would split', async () => {
  const { runCommand } = await import('./cli')
  assert.equal(
    runCommand(7, HANDLE, { implementer: 'my agent', reviewer: "o'neil", gapHunter: 'a', finalReviewer: 'b' }),
    `${NPX} epic run 7 --project ${HANDLE} --host orca --implementer 'my agent' --reviewer 'o'\\''neil' --gap-hunter a --final-reviewer b`
  )
})
