// The worker against the fake conport and orca executables (test/fake-cli.mjs): every call
// spawns a real child process, as in Orca.
// The assert of orca/testing is Node's, but its typings leave doesNotMatch out.
import { doesNotMatch } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import {
  AGENTS,
  EPIC_12_LIST,
  EPIC_LIST,
  EPIC_TASKS,
  HANDLE,
  HERDR_COPY,
  herdrWorktreeList,
  NO_KEY,
  SDD_LIST,
  SUBAGENTS,
  TAKEN
} from '../test/fixtures'
import {
  type FakeAnswer,
  type FakeDirs,
  type WorktreeRow,
  fake,
  json,
  promptRefused,
  promptText,
  terminalList,
  worktreeList,
  worktreeRow
} from '../test/fake'
import {
  DEFAULT_ROLES,
  HANDLE_FORM,
  epicPromptArgs,
  ideaPromptArgs,
  proposalAcceptArgs,
  proposalDeclineArgs,
  sddListArgs,
  sddTakenArgs,
  specPromptArgs,
  taskPromptArgs
} from './cli'
import type { AgentKind, EpicSession, EpicTask, HandMode, Result, Roles, RowRef } from './protocol'
import { HARNESS_MISSING_ACTION, refusalText } from './text'

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
  // An epic with a live session and tasks in progress: the worker reads them when asked, never by
  // itself. The panel times its reads of the list; the worker keeps no timer of its own.
  const f = fake(
    [
      { match: 'sdd list --taken', stdout: json(TAKEN) },
      { match: 'sdd list', stdout: json(SDD_LIST) },
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
  const host = f.host({ 'agents.list': { agents: [] } }, { [`session:${HANDLE}:7`]: { terminal: 'term-epic' } })
  const timers = pendingTimers()
  try {
    const worker = await mountWorker(f.worker, { host })
    const epic = { project: HANDLE, root: f.root, epic: 7 }
    const row: RowRef = { kind: 'epic', id: 7, spec: null, idea: null }
    const answers = [
      await worker.request('sdd.list', { project: HANDLE, root: f.root }),
      await worker.request('sdd.taken', { project: HANDLE, root: f.root }),
      await worker.request('agents.get', { project: HANDLE, root: f.root }),
      await worker.request('epic.session', epic),
      await worker.request('epic.tasks', epic),
      await worker.request('subagents.get', { root: f.root, harness: 'claude' }),
      await worker.request('terminal.show', { project: HANDLE, root: f.root, row }),
      await worker.request('epic.start', { ...epic, harness: 'claude', roles: DEFAULT_ROLES })
    ]
    // Every request did its work: a refusal would leave nothing to schedule and prove nothing.
    assert.deepEqual(answers.map((answer) => answer.ok), [true, true, true, true, true, true, true, true], JSON.stringify(answers))
    // Nothing is left scheduled once the answers are in: no read waits its turn, however far off.
    assert.deepEqual(timers.delays(), [])
    // Each read of ConPort was asked for by one request: none is repeated behind it.
    assert.deepEqual(f.conportCalls().map((call) => call.slice(0, 2).join(' ')), [
      'sdd list', 'sdd list', 'epic agents', 'api tasks', 'epic subagents', 'epic list', 'epic agents', 'prompt epic'
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
  lines: [],
  filesRead: true,
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

/** What `projects.list` says of the fake repository: its project, where it came from and the settings lines. */
async function contextOfRepo(worker: Worker): Promise<unknown> {
  const answer = await worker.request('projects.list')
  if (!answer.ok) return answer
  return answer.data.map(({ project, source, lines }) => ({ project, source, lines }))
}

/** git of a repository whose personal settings file is untracked and ignored. */
const localIgnored = ({ root }: FakeDirs): FakeAnswer[] => [
  { match: `-C ${root} ls-files --error-unmatch -- .conport.local.json`, code: 1 },
  { match: `-C ${root} check-ignore -q -- .conport.local.json`, code: 0 }
]

test('project comes from .conport.json of the main working tree', async () => {
  const f = fake([])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ $schema: 'https://conport.app/schema/conport.json', project_name: 'shop-api' }))
  // The old place and the remembered binding lose to the file; the focused worktree is not read.
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'old-place' } })
  mkdirSync(f.focused, { recursive: true })
  writeFileSync(join(f.focused, '.conport.json'), JSON.stringify({ project_name: 'somewhere-else' }))
  const worker = await mountWorker(f.worker, { host: f.host({}, { [`project:${f.root}`]: 'remembered' }) })
  assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'file', lines: [] }])
  // Git is asked only whether the root has a main working tree: with no personal file, not about one.
  assert.deepEqual(f.gitCalls(), [['-C', f.root, 'rev-parse', '--show-toplevel', '--git-common-dir']])
  await worker.deactivate()
})

test('the local settings file of the main working tree overrides it', async () => {
  const f = fake([], [], localIgnored)
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  // Written by a Windows editor: a byte order mark and CRLF line ends read as any file.
  writeFileSync(join(f.root, '.conport.local.json'), '﻿{\r\n  "project_name": "mine"\r\n}\r\n')
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await contextOfRepo(worker), [
    { project: 'mine', source: 'file', lines: ['project_name from .conport.local.json (mine) overrides .conport.json (shop-api)'] }
  ])
  // Whether the personal file is ignored is asked in the working tree that holds it.
  assert.deepEqual(f.gitCalls(), [
    ['-C', f.root, 'rev-parse', '--show-toplevel', '--git-common-dir'],
    ['-C', f.root, 'ls-files', '--error-unmatch', '--', '.conport.local.json'],
    ['-C', f.root, 'check-ignore', '-q', '--', '.conport.local.json']
  ])
  await worker.deactivate()
})

// The old place is read after the rules, never as their variable: naming another project than
// the file, it loses and says nothing — as in the Herdr mod.
test('a file and the old place naming another project: the file, with no line', async () => {
  const f = fake([])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'acme-app' } })
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'file', lines: [] }])
  await worker.deactivate()
})

test('the old settings place is read when there is no file', async () => {
  for (const shared of [null, JSON.stringify({ plugins: { superpowers: true } })]) {
    const f = fake([])
    // A settings file without project_name names no project: the old place is read next.
    if (shared !== null) writeFileSync(join(f.root, '.conport.json'), shared)
    writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: ' shop-api ' } })
    const worker = await mountWorker(f.worker, { host: f.host({}, { [`project:${f.root}`]: 'remembered' }) })
    assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'repository', lines: [] }], String(shared))
    await worker.deactivate()
  }
})

test('the stored binding is read last', async () => {
  const f = fake([])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ arch: { git: true } }))
  writeSettings(f.root, { env: { OTHER: 'x' } })
  const worker = await mountWorker(f.worker, { host: f.host({}, { [`project:${f.root}`]: 'remembered' }) })
  assert.deepEqual(await contextOfRepo(worker), [{ project: 'remembered', source: 'stored', lines: [] }])
  // Once the file names the project, the binding no longer counts.
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'file', lines: [] }])
  await worker.deactivate()
})

test('settings lines reach the context', async () => {
  // A personal file git does not ignore, and the variable in the user env file.
  const exposed = fake([], [], ({ root }) => [
    { match: `-C ${root} ls-files --error-unmatch -- .conport.local.json`, code: 1 },
    { match: `-C ${root} check-ignore -q -- .conport.local.json`, code: 1 }
  ])
  writeFileSync(join(exposed.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  writeFileSync(join(exposed.root, '.conport.local.json'), JSON.stringify({ plugins: { superpowers: true }, units: [] }))
  writeFileSync(exposed.userEnv, 'CONPORT_API_KEY=x\nCONPORT_PROJECT_NAME=everywhere\n')
  let worker = await mountWorker(exposed.worker, { host: exposed.host() })
  assert.deepEqual(await contextOfRepo(worker), [
    {
      project: 'shop-api',
      source: 'file',
      lines: [
        'units is read from .conport.json only',
        '.conport.local.json is not ignored by git: add it to .gitignore',
        'CONPORT_PROJECT_NAME in ~/.config/conport/.env is not read: it would apply to every repository — remove it'
      ]
    }
  ])
  // The answers of the binding carry the lines too.
  const set = await worker.request('project.set', { root: exposed.root, project: 'other' })
  assert.deepEqual(set.ok ? set.data.lines.length : set, 3)
  await worker.deactivate()

  // A broken file names no project: neither the old place nor the binding stands in for it.
  const broken = fake([])
  writeFileSync(join(broken.root, '.conport.json'), '{"project_name": "shop-api",}')
  writeSettings(broken.root, { env: { CONPORT_PROJECT_NAME: 'old-place' } })
  worker = await mountWorker(broken.worker, { host: broken.host({}, { [`project:${broken.root}`]: 'remembered' }) })
  assert.deepEqual(await contextOfRepo(worker), [
    { project: null, source: 'file', lines: ['.conport.json is not valid JSON (line 1, column 29): fix it'] }
  ])
  await worker.deactivate()

  // A folder where the file should be is a line, not a crash.
  const folder = fake([])
  mkdirSync(join(folder.root, '.conport.json'))
  worker = await mountWorker(folder.worker, { host: folder.host() })
  assert.deepEqual(await contextOfRepo(worker), [
    { project: null, source: 'file', lines: ['.conport.json cannot be read (EISDIR): fix it'] }
  ])
  await worker.deactivate()
})

test('a submodule or a worktree of a bare repository has only the stored binding', async () => {
  for (const commonDir of ['/work/super/.git/modules/repo', '/work/repo.git']) {
    const f = fake([], [], ({ root }) => [
      { match: `-C ${root} rev-parse --show-toplevel --git-common-dir`, stdout: `${root}\n${commonDir}\n` }
    ])
    // Neither the settings files nor the old place are read: the repository has no main working tree.
    writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
    writeFileSync(join(f.root, '.conport.local.json'), '{')
    writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'old-place' } })
    let worker = await mountWorker(f.worker, { host: f.host() })
    assert.deepEqual(await contextOfRepo(worker), [{ project: null, source: null, lines: [] }], commonDir)
    await worker.deactivate()
    worker = await mountWorker(f.worker, { host: f.host({}, { [`project:${f.root}`]: 'remembered' }) })
    assert.deepEqual(await contextOfRepo(worker), [{ project: 'remembered', source: 'stored', lines: [] }], commonDir)
    assert.deepEqual(f.gitCalls().map((call) => call[2]), ['rev-parse', 'rev-parse'], commonDir)
    // The panel is told that the files were not read, so its bind card does not claim there are none.
    const listed = await worker.request('projects.list')
    assert.deepEqual(listed.ok ? listed.data.map((p) => p.filesRead) : listed, [false], commonDir)
    await worker.deactivate()
  }
})

test('a git that fails names no project, and nothing stands in for it', async () => {
  const f = fake([], [], ({ root }) => [
    {
      match: `-C ${root} rev-parse --show-toplevel --git-common-dir`,
      code: 128,
      stderr: `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n`
    }
  ])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'old-place' } })
  const worker = await mountWorker(f.worker, { host: f.host({}, { [`project:${f.root}`]: 'remembered' }) })
  assert.deepEqual(await contextOfRepo(worker), [
    {
      project: null,
      source: 'file',
      lines: [`git failed (fatal: detected dubious ownership in repository at '${f.root}'): ConPort settings were not read`]
    }
  ])
  await worker.deactivate()

  // A git that cannot start fails the same way.
  const { createWorker } = await import('./worker')
  const missing = createWorker({ ...f.deps, git: ['/nonexistent/bin/git'] })
  const broken = await mountWorker({ default: missing.activate, deactivate: missing.deactivate } as typeof f.worker, { host: f.host() })
  const answer = await contextOfRepo(broken)
  assert.match(JSON.stringify(answer), /"lines":\["git failed \(spawn \/nonexistent\/bin\/git ENOENT\): ConPort settings were not read"\]/)
  await broken.deactivate()
})

test('outside git the settings files are read and git is not asked about the personal file', async () => {
  const f = fake([], [], ({ root }) => [
    {
      match: `-C ${root} rev-parse --show-toplevel --git-common-dir`,
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
    }
  ])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  writeFileSync(join(f.root, '.conport.local.json'), JSON.stringify({ project_name: 'mine' }))
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await contextOfRepo(worker), [
    { project: 'mine', source: 'file', lines: ['project_name from .conport.local.json (mine) overrides .conport.json (shop-api)'] }
  ])
  assert.deepEqual(f.gitCalls(), [['-C', f.root, 'rev-parse', '--show-toplevel', '--git-common-dir']])
  const listed = await worker.request('projects.list')
  assert.deepEqual(listed.ok ? listed.data.map((p) => p.filesRead) : listed, [true])
  await worker.deactivate()

  // Without a settings file the old place is read there too.
  const old = fake([], [], ({ root }) => [
    {
      match: `-C ${root} rev-parse --show-toplevel --git-common-dir`,
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
    }
  ])
  writeSettings(old.root, { env: { CONPORT_PROJECT_NAME: 'shop-api' } })
  const oldWorker = await mountWorker(old.worker, { host: old.host({}, { [`project:${old.root}`]: 'remembered' }) })
  assert.deepEqual(await contextOfRepo(oldWorker), [{ project: 'shop-api', source: 'repository', lines: [] }])
  await oldWorker.deactivate()
})

test('git is asked in English: under a Russian locale a folder outside git is still outside git', async () => {
  const f = fake([], [], ({ root }) => [
    {
      match: `-C ${root} rev-parse --show-toplevel --git-common-dir`,
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      translatedStderr: 'fatal: не найден git репозиторий (или один из родительских каталогов): .git\n'
    }
  ])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE }
  Object.assign(process.env, { LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', LANGUAGE: 'ru' })
  try {
    const worker = await mountWorker(f.worker, { host: f.host() })
    assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'file', lines: [] }])
    await worker.deactivate()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('git that does not answer in time names no project, and nothing stands in for it', async () => {
  const { GIT_TIMEOUT_MS, createWorker } = await import('./worker')
  // Every reader of the settings waits 5 s for git.
  assert.equal(GIT_TIMEOUT_MS, 5000)
  const f = fake([], [], ({ root }) => [
    { match: `-C ${root} rev-parse --show-toplevel --git-common-dir`, stdout: `${root}\n.git\n`, delayMs: 3000 }
  ])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  writeSettings(f.root, { env: { CONPORT_PROJECT_NAME: 'old-place' } })
  const quick = createWorker({ ...f.deps, gitTimeoutMs: 200 })
  const worker = await mountWorker({ default: quick.activate, deactivate: quick.deactivate } as typeof f.worker, {
    host: f.host({}, { [`project:${f.root}`]: 'remembered' })
  })
  assert.deepEqual(await contextOfRepo(worker), [
    { project: null, source: 'file', lines: ['git failed (no answer in 0.2 s): ConPort settings were not read'] }
  ])
  await worker.deactivate()
})

test('the user env file is in XDG_CONFIG_HOME when it is set, else in .config of the home folder', async () => {
  const { userEnvFile } = await import('./worker')
  assert.equal(userEnvFile({ XDG_CONFIG_HOME: '/xdg' }, '/work/me'), join('/xdg', 'conport', '.env'))
  for (const unset of [{}, { XDG_CONFIG_HOME: '' }, { XDG_CONFIG_HOME: '  ' }]) {
    assert.equal(userEnvFile(unset, '/work/me'), join('/work/me', '.config', 'conport', '.env'), JSON.stringify(unset))
  }
})

test('a command past its timeout is killed and told as a failure', async () => {
  const { runProcess } = await import('./exec')
  const started = Date.now()
  const answer = await runProcess([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], undefined, 200)
  assert.equal(answer.code, null)
  assert.equal(answer.failure, 'no answer in 0.2 s')
  assert.ok(Date.now() - started < 5000)
})

test('a settings root inside CONPORT_SETTINGS_FORBID_ROOT is refused', async () => {
  const f = fake([])
  writeFileSync(join(f.root, '.conport.json'), JSON.stringify({ project_name: 'shop-api' }))
  const worker = await mountWorker(f.worker, { host: f.host() })
  const before = process.env.CONPORT_SETTINGS_FORBID_ROOT
  const forbidding = async (path: string, check: () => Promise<void>): Promise<void> => {
    process.env.CONPORT_SETTINGS_FORBID_ROOT = path
    try {
      await check()
    } finally {
      if (before === undefined) delete process.env.CONPORT_SETTINGS_FORBID_ROOT
      else process.env.CONPORT_SETTINGS_FORBID_ROOT = before
    }
  }
  // The root itself and a folder above it are forbidden.
  for (const path of [f.root, dirname(f.root)]) {
    await forbidding(path, () =>
      assert.rejects(worker.request('projects.list'), (error: unknown) => {
        assert.equal(
          (error as Error).message,
          `settings root ${f.root} is inside CONPORT_SETTINGS_FORBID_ROOT: run the test in a temporary folder`
        )
        return true
      })
    )
  }
  // A root beside the forbidden path, not inside it, is read.
  await forbidding(`${f.root}-beside`, async () => {
    assert.deepEqual(await contextOfRepo(worker), [{ project: 'shop-api', source: 'file', lines: [] }])
  })
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
    data: { root: f.root, project: 'shop-api', source: 'stored', lines: [], filesRead: true }
  })
  assert.deepEqual(await listed(), [['shop-api', 'stored']])
  assert.deepEqual(await worker.request('project.forget', { root: f.root }), {
    ok: true,
    data: { root: f.root, project: null, source: null, lines: [], filesRead: true }
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
  const answer = await worker.request('sdd.list', { project: 'p', root: '/' })
  assert.equal(answer.ok, false)
  if (!answer.ok) {
    assert.equal(answer.error.code, 'spawn_failed')
    assert.match(answer.error.message, /^npx: /)
    assert.match(answer.error.action, /Node\.js/)
    assert.match(answer.error.action, /Orca app's PATH/)
  }
  await worker.deactivate()
})

test('a missing api key shows the cli refusal', async () => {
  const f = fake([
    {
      match: 'sdd list',
      code: 2,
      stdout: json({ ok: false, error: NO_KEY }),
      stderr: `${NO_KEY.code}: ${NO_KEY.message} — ${NO_KEY.action}\n`
    }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  const answer = await worker.request('sdd.list', { project: 'shop-api', root: f.root })
  assert.deepEqual(answer, { ok: false, error: NO_KEY })
  assert.deepEqual(f.conportCalls(), [sddListArgs('shop-api')])
  await worker.deactivate()
})

test('the json refusal on standard output is read before the error stream', async () => {
  const f = fake([
    { match: 'sdd list', code: 2, stdout: json({ ok: false, error: NO_KEY }), stderr: 'npm warn exec something\n' }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('sdd.list', { project: 'p', root: f.root }), { ok: false, error: NO_KEY })
  await worker.deactivate()
})

test('a refusal printed only to the error stream is read from its one line', async () => {
  const f = fake([
    { match: 'sdd list', code: 1, stderr: 'epic_busy: epic 7 is led by yuri — wait until their session ends\n' },
    { match: 'epic agents', code: 1, stderr: 'boom\n' }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('sdd.list', { project: 'p', root: f.root }), {
    ok: false,
    error: { code: 'epic_busy', message: 'epic 7 is led by yuri', action: 'wait until their session ends' }
  })
  assert.deepEqual(await worker.request('agents.get', { project: 'p', root: f.root }), {
    ok: false,
    error: { code: 'cli_failed', message: 'boom', action: '' }
  })
  await worker.deactivate()
})

test('agents come from epic agents json with the agent of the last launch, and no roles of the project', async () => {
  const f = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
  // The record of the roles of a project, kept by earlier versions, is not read.
  const host = mockHost({ storage: { [`roles:${HANDLE}`]: ROLES, [`launcher:${HANDLE}`]: 'codex' } })
  const worker = await mountWorker(f.worker, { host })
  assert.deepEqual(await worker.request('agents.get', { project: HANDLE, root: f.root }), {
    ok: true,
    data: { agents: AGENTS.agents, launcher: 'codex' }
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
      launcher: null
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
    data: { agents: AGENTS.agents, launcher: null }
  })
  await worker.deactivate()
})

test('the worker answers no request of the tabs it had: epics.list, tasks.list, epic.prepare', async () => {
  const f = fake([])
  const worker = await mountWorker(f.worker, { host: f.host() })
  for (const name of ['epics.list', 'tasks.list', 'epic.prepare']) {
    await assert.rejects(worker.request(name as never, { project: HANDLE, root: f.root, epic: 9, agent: 'claude' } as never), new RegExp(`no panel handler named ${name.replace(".", "\\.")}`))
  }
  assert.deepEqual(f.conportCalls(), [])
  await worker.deactivate()
})

test('project.page names the project in the team that holds it', async () => {
  const project = { handle: HANDLE, canonical_name: 'k7m2qx9d/shop' }
  const f = fake([{ match: `api projects get --project ${HANDLE}`, stdout: json(project) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('project.page', { project: HANDLE, root: f.root }), {
    ok: true,
    data: { url: `https://me.conport.app/t/k7m2qx9d/p/${HANDLE}` }
  })
  assert.deepEqual(f.conportCalls(), [['api', 'projects', 'get', '--project', HANDLE]])
  await worker.deactivate()
  // The Private Team is named pers; a name of a project is refused before the CLI is asked.
  const own = fake([{ match: 'api projects get', stdout: json({ handle: HANDLE, canonical_name: 'pers/shop' }) }])
  const second = await mountWorker(own.worker, { host: own.host() })
  assert.deepEqual(await second.request('project.page', { project: HANDLE, root: own.root }), { ok: true, data: { url: `https://me.conport.app/t/pers/p/${HANDLE}` } })
  const named = await second.request('project.page', { project: 'shop-api', root: own.root })
  assert.equal(named.ok === false && named.error.code, 'project_not_handle')
  assert.equal(own.conportCalls().length, 1)
  await second.deactivate()
  // An answer without the canonical name is bad output; a refusal of the CLI comes as it is.
  const odd = fake([{ match: 'api projects get', stdout: json({ handle: HANDLE }) }])
  const third = await mountWorker(odd.worker, { host: odd.host() })
  const bad = await third.request('project.page', { project: HANDLE, root: odd.root })
  assert.equal(bad.ok === false && bad.error.code, 'bad_output')
  await third.deactivate()
  const refusing = fake([{ match: 'api projects get', code: 2, stdout: json({ ok: false, error: NO_KEY }) }])
  const fourth = await mountWorker(refusing.worker, { host: refusing.host() })
  assert.deepEqual(await fourth.request('project.page', { project: HANDLE, root: refusing.root }), { ok: false, error: NO_KEY })
  await fourth.deactivate()
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
      { name: 'Billing', root: billing, kind: 'git', project: 'billing-api', source: 'stored', lines: [], filesRead: true, focused: false },
      { name: 'Shop', root: f.root, kind: 'git', project: 'shop-api', source: 'repository', lines: [], filesRead: true, focused: true },
      { name: 'Notes', root: notes, kind: 'folder', project: null, source: null, lines: [], filesRead: false, focused: false },
      { name: 'Docs', root: docs, kind: 'git', project: null, source: null, lines: [], filesRead: true, focused: false }
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
 * Starts the brainstorm of idea `task` with `agent` over the fake CLI, whose `conport prompt`
 * answers by `conport` when given and with its own text otherwise; the answer, the terminal
 * command and the one argument the agent gets.
 */
async function brainstorm(task: number, agent = 'claude', conport: FakeAnswer[] = [], agents = AGENTS, project = HANDLE) {
  const f = fake([...conport, { match: 'epic agents', stdout: json(agents) }], [SWITCHED])
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('idea.start', { project, root: f.root, task, agent })
  const created = host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string; command: string }>
  const command = created[0]?.command ?? ''
  const args = command === '' ? [] : argumentsOf(command)
  await worker.deactivate()
  return { f, host, worker, answer, created, command, args, task: args[0] ?? '' }
}

/** The calls of the fake conport that asked `conport prompt` for a text. */
const promptCalls = (f: ReturnType<typeof fake>): string[][] => f.conportCalls().filter((call) => call[0] === 'prompt')

test('a brainstorm opens the chosen agent in the project root with the text of conport prompt as one argument', async () => {
  const { f, answer, created, args, task, worker } = await brainstorm(41, 'codex')
  assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } })
  // A terminal of the repository root, the command of the chosen agent and one argument: the task.
  assert.deepEqual(created.map(({ workspaceId, title }) => ({ workspaceId, title })), [{ workspaceId: 'ws-root', title: 'conport idea 41' }])
  assert.match(created[0]?.command ?? '', /^codex '/)
  assert.equal(args.length, 1)
  // The text is the one the CLI printed for the panel of Orca; the idea is not read apart from it.
  const asked = ideaPromptArgs({ task: 41, project: HANDLE, agent: 'codex', root: f.root })
  assert.deepEqual(f.conportCalls(), [asked, ['epic', 'agents', '--json']])
  assert.equal(task, promptText(asked))
  // The person talks with the agent there: the terminal comes to the front.
  assert.deepEqual(f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
  assert.deepEqual(worker.refusals, [])
})

test('a task with quotes and dollars survives the shell, and a project named with quotes is refused before the CLI', async () => {
  // A brainstorm remembers its terminal under the handle: a name, quotes and all, is refused before anything runs.
  const byName = await brainstorm(41, 'claude', [], AGENTS, `it's "$HOME" \`x\``)
  assert.deepEqual(byName.answer, { ok: false, error: NOT_HANDLE })
  assert.deepEqual([promptCalls(byName.f), byName.created], [[], []])
  // The text the CLI prints carries quotes of both kinds, a dollar and a backquote: one argument still.
  const { f, task, args } = await brainstorm(41)
  assert.equal(args.length, 1)
  const asked = ideaPromptArgs({ task: 41, project: HANDLE, agent: 'claude', root: f.root })
  assert.deepEqual(promptCalls(f), [asked])
  assert.equal(task, promptText(asked))
  for (const piece of ["'", '"', '$', '\n', '`']) assert.ok(task.includes(piece), JSON.stringify(piece))
})

test('the api key never reaches the task or the command', async () => {
  const key = 'cport_live_secretvalue'
  process.env.CONPORT_API_KEY = key
  try {
    const { command } = await brainstorm(41)
    assert.ok(command !== '')
    doesNotMatch(command, /cport_|secretvalue/)
  } finally {
    delete process.env.CONPORT_API_KEY
  }
})

/** A machine whose CLI answers what a brainstorm reads. */
const brainstorming = () => fake([{ match: 'epic agents', stdout: json(AGENTS) }], [SWITCHED])

test('a brainstorm refuses when the repository root is not a workspace of Orca', async () => {
  const f = brainstorming()
  for (const [truncated, code] of [[false, 'root_not_open'], [true, 'workspaces_truncated']] as const) {
    const host = f.host({ 'workspace.list': { workspaces: [], truncated }, 'agents.list': { agents: [] } })
    const worker = await mountWorker(f.worker, { host })
    const answer = await worker.request('idea.start', { project: HANDLE, root: f.root, task: 41, agent: 'claude' })
    // A cut list of workspaces is not a sign that the root is missing from Orca.
    assert.equal(answer.ok === false && answer.error.code, code)
    assert.deepEqual(host.callsOf('terminal.create'), [])
    // No terminal was opened: no agent is remembered for the project.
    assert.equal(`launcher:${HANDLE}` in (host.data().storage as Record<string, unknown>), false)
    await worker.deactivate()
  }
})

test('a brainstorm opens its terminal in the root of the chosen project', async () => {
  const f = brainstorming()
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
  const answer = await worker.request('idea.start', { project: 'prb2ngqx9d', root: billing, task: 41, agent: 'claude' })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.deepEqual(host.callsOf('terminal.create').map((c) => (c as { workspaceId: string }).workspaceId), ['ws-billing'])
  // The CLI runs in the root of that project, for that project.
  assert.deepEqual(promptCalls(f), [ideaPromptArgs({ task: 41, project: 'prb2ngqx9d', agent: 'claude', root: billing })])
  await worker.deactivate()
})

test('a refusal of conport prompt the panel words by its code reaches it as the CLI gave it, and a text missing is bad output', async () => {
  const noKey = await brainstorm(41, 'claude', [{ match: 'prompt idea ', code: 2, stdout: json({ ok: false, error: NO_KEY }) }])
  assert.deepEqual(noKey.answer, { ok: false, error: NO_KEY })
  assert.deepEqual(noKey.created, [])
  for (const body of [{ ok: true }, { ok: true, text: '' }, { ok: true, text: 7 }]) {
    const odd = await brainstorm(41, 'claude', [{ match: 'prompt idea ', stdout: json(body) }])
    assert.deepEqual(odd.answer, { ok: false, error: { code: 'bad_output', message: "conport answered without the task's text", action: 'Update conport.' } })
    assert.deepEqual(odd.created, [])
  }
})

test('a brainstorm refuses an agent that takes no positional request, found or not, and one that can but is not found', async () => {
  // OpenCode reads a positional argument as a project folder: found, it is refused all the same.
  const agents = {
    agents: [
      ...AGENTS.agents,
      { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true },
      { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: false }
    ]
  }
  for (const agent of ['opencode', 'gemini', 'aider']) {
    const refused = await brainstorm(41, agent, [], agents)
    assert.deepEqual(refused.answer, {
      ok: false,
      error: { code: 'agent_cannot_prepare', message: `The agent “${agent}” does not take a task at start`, action: 'Choose Claude Code, Codex or Cursor.' }
    })
    assert.deepEqual(refused.created, [])
  }
  const cursor = await brainstorm(41, 'cursor', [], agents)
  assert.equal(cursor.answer.ok === false && cursor.answer.error.code, 'agent_not_found')
  // Cursor starts by its own command when found.
  const found = { agents: agents.agents.map((a) => (a.id === 'cursor' ? { ...a, found: true } : a)) }
  const started = await brainstorm(41, 'cursor', [], found)
  assert.equal(started.answer.ok, true)
  assert.match(started.command, /^cursor-agent '/)
})

/**
 * Hands `task` to `agent` over the fake CLI, to do it, to review it or to fix it; `conport prompt`
 * answers by `conport` when given. The answer, the terminal and the one argument the agent gets.
 */
async function hand(task: number, mode: HandMode, agent = 'claude', conport: FakeAnswer[] = [], project = HANDLE) {
  const f = fake([...conport, { match: 'epic agents', stdout: json(AGENTS) }], [SWITCHED])
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('task.hand', { project, root: f.root, task, agent, mode })
  const created = host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string; command: string }>
  const command = created[0]?.command ?? ''
  const args = command === '' ? [] : argumentsOf(command)
  const launcher = await worker.request('agents.get', { project, root: f.root })
  const storage = host.data().storage as Record<string, unknown>
  await worker.deactivate()
  return { f, answer, created, command, args, task: args[0] ?? '', remembered: launcher.ok ? launcher.data.launcher : null, storage }
}

test('hand a task opens the chosen agent with the text of conport prompt as one argument, in each mode', async () => {
  const cases: Array<[number, HandMode, string]> = [[41, 'do', 'conport task 41'], [42, 'review', 'conport review 42'], [46, 'fix', 'conport fix 46']]
  for (const [id, mode, title] of cases) {
    const { f, answer, created, args, task, remembered } = await hand(id, mode, 'codex')
    assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } })
    // A terminal of the repository root, the command of the chosen agent and one argument: the task.
    assert.deepEqual(created.map(({ workspaceId, title }) => ({ workspaceId, title })), [{ workspaceId: 'ws-root', title }])
    assert.match(created[0]?.command ?? '', /^codex '/)
    assert.equal(args.length, 1)
    // The text is the one the CLI printed for the panel of Orca; the task is not read apart from it.
    const asked = taskPromptArgs({ task: id, project: HANDLE, mode, agent: 'codex', root: f.root })
    assert.deepEqual(f.conportCalls(), [asked, ['epic', 'agents', '--json'], ['epic', 'agents', '--json']])
    assert.equal(task, promptText(asked))
    assert.deepEqual(f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
    // The agent picked is the one the sheet offers first next time.
    assert.equal(remembered, 'codex')
  }
})

test('hand tells each refusal of conport prompt in the words of the panel', async () => {
  const cases: Array<[number, HandMode, string, string]> = [
    [99, 'do', 'task_not_found', 'Task 99 is not among the open tasks of the panel'],
    // Done by someone else meanwhile: each mode says what the task no longer waits for.
    [42, 'do', 'task_moved', 'Task 42 is already in progress'],
    [41, 'review', 'task_moved', 'Task 41 is not waiting for review'],
    [43, 'fix', 'task_moved', 'Task 43 is not waiting for fixes']
  ]
  for (const [id, mode, code, message] of cases) {
    const { f, answer, created, remembered } = await hand(id, mode, 'claude', [promptRefused('task', code)])
    const error = { code, message, action: 'Press Refresh.' }
    assert.deepEqual(answer, { ok: false, error }, `${id} ${mode}`)
    assert.deepEqual(refusalText(error), { what: message, action: error.action })
    assert.deepEqual(created, [])
    assert.equal(remembered, null)
    assert.deepEqual(promptCalls(f), [taskPromptArgs({ task: id, project: HANDLE, mode, agent: 'claude', root: f.root })])
  }
})

test('a refusal of conport prompt whose code is not about the thing asked for reaches the panel as the CLI sent it', async () => {
  // A code of an epic on a task, and a code of a task an idea is not refused with: nothing to word it by.
  const english = (code: string) => ({ code, message: `${code.replace(/_/g, ' ')}, as the CLI words it`, action: 'do what the CLI says' })
  const onTask = await hand(41, 'do', 'claude', [promptRefused('task', 'epic_not_found')])
  assert.deepEqual(onTask.answer, { ok: false, error: english('epic_not_found') })
  assert.deepEqual(onTask.created, [])
  const onIdea = await brainstorm(41, 'claude', [promptRefused('idea', 'task_moved')])
  assert.deepEqual(onIdea.answer, { ok: false, error: english('task_moved') })
  assert.deepEqual(onIdea.created, [])
})

test('hand refuses an agent that cannot take a task before the CLI is asked, and one that is not found', async () => {
  const refused = await hand(41, 'do', 'gemini')
  assert.deepEqual(refused.answer, {
    ok: false,
    error: { code: 'agent_cannot_prepare', message: 'The agent “gemini” does not take a task at start', action: 'Choose Claude Code, Codex or Cursor.' }
  })
  // The CLI takes only an agent that can: it is not asked for a text the agent cannot be given.
  assert.deepEqual(promptCalls(refused.f), [])
  assert.deepEqual(refused.created, [])
  const cursor = { agents: [...AGENTS.agents, { id: 'cursor', label: 'Cursor', command: 'cursor-agent', found: false }] }
  const f = fake([{ match: 'epic agents', stdout: json(cursor) }])
  const worker = await mountWorker(f.worker, { host: f.host({ 'agents.list': { agents: [] } }) })
  const answer = await worker.request('task.hand', { project: HANDLE, root: f.root, task: 41, agent: 'cursor', mode: 'do' })
  assert.equal(answer.ok === false && answer.error.code, 'agent_not_found')
  await worker.deactivate()
})

test('a task named by a project with quotes is refused before the CLI, and the api key never reaches a handed task', async () => {
  // A hand remembers its terminal under the handle: a name, quotes and all, is refused before anything runs.
  const byName = await hand(41, 'do', 'claude', [], `it's "$HOME" \`x\``)
  assert.deepEqual(byName.answer, { ok: false, error: NOT_HANDLE })
  assert.deepEqual([byName.f.conportCalls().filter((call) => call[0] !== 'epic'), byName.created], [[], []])
  const key = 'cport_live_secretvalue'
  process.env.CONPORT_API_KEY = key
  try {
    const { f, task, args, command } = await hand(41, 'do', 'claude')
    assert.equal(args.length, 1)
    const asked = taskPromptArgs({ task: 41, project: HANDLE, mode: 'do', agent: 'claude', root: f.root })
    assert.deepEqual(promptCalls(f), [asked])
    assert.equal(task, promptText(asked))
    doesNotMatch(command, /cport_|secretvalue/)
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
  /** Answers of the fake orca tried before the usual ones, or made from the folders of the machine. */
  orca?: FakeAnswer[] | ((dirs: FakeDirs) => FakeAnswer[])
  /** Answers of the fake conport tried before the usual ones. */
  conport?: FakeAnswer[]
}

/** Where the fake orca puts a working copy it creates for `epic`. */
const copyOf = (root: string, epic: number): string => join(dirname(root), 'copies', 'repo', `epic-${epic}`)

/** A machine whose repository has the working copies of `options`, and a worker mounted on it. */
async function startMachine(options: StartCase = {}) {
  const base = options.base === undefined ? 'main' : options.base
  const f = fake(
    [
      ...(options.conport ?? []),
      { match: 'epic list', stdout: json(EPIC_LIST) },
      { match: 'epic agents', stdout: json(options.agents ?? AGENTS) }
    ],
    ({ dir, root, focused }) => [
      ...(typeof options.orca === 'function' ? options.orca({ dir, root, focused }) : (options.orca ?? [])),
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
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: copy } })
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
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: path } })
  assert.deepEqual(created, [])
  assert.equal(opened[0]?.[3], `path:${path}`)
})

test('epic.start takes the working copy of the epic made outside Orca, outside the repository', async () => {
  // Herdr made the branch epic-12 and its copy in its own folder; Orca lists that copy as any other.
  const { f, answer, created, opened, command } = await start({
    epic: 12,
    refs: ['refs/heads/epic-12'],
    conport: [{ match: 'epic list', stdout: json(EPIC_12_LIST) }],
    orca: ({ root }) => [{ match: `worktree list --repo path:${root} `, stdout: json(herdrWorktreeList(root)) }]
  })
  // Taken as it is: no refusal that the branch has no copy, and no copy created beside it.
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: HERDR_COPY } })
  assert.deepEqual(created, [])
  assert.deepEqual(opened, [
    ['terminal', 'create', '--worktree', `path:${HERDR_COPY}`, '--title', 'conport epic 12 · SDD', '--command', command, '--json']
  ])
  // The task names that copy as the place of the work.
  assert.deepEqual(
    f.conportCalls().at(-1),
    epicPromptArgs({ epic: 12, project: HANDLE, harness: 'claude', worktree: HERDR_COPY, base: 'main', roles: TYPES })
  )
})

test('epic.start takes the main working tree when it is on the branch of the epic', async () => {
  // The repository itself stands on `epic-7`: it is the copy of the epic, and no other is made.
  const { f, answer, created, opened } = await start({ base: 'epic-7', refs: ['refs/heads/epic-7'] })
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: f.root } })
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

test('epic.start gives the harness the text of conport prompt as one argument', async () => {
  for (const harness of ['claude', 'codex']) {
    const { f, copy, command, args, task } = await start({ harness, project: 'shop-api' })
    assert.ok(command.startsWith(`${harness} '`), command)
    assert.equal(args.length, 1)
    // The project is the handle the CLI answered with, the base the branch of the main working tree,
    // the working copy the one orca created; the types reach the CLI for Claude Code only.
    const asked = epicPromptArgs({ epic: 7, project: HANDLE, harness, worktree: copy, base: 'main', roles: TYPES })
    assert.deepEqual(f.conportCalls().at(-1), asked)
    assert.equal(asked.includes(TYPES.reviewer), harness === 'claude')
    assert.equal(task, promptText(asked))
    for (const piece of ['"', '\n', '`']) assert.ok(task.includes(piece), JSON.stringify(piece))
  }
})

test('a base branch the shell would read reaches the harness inside the one argument', async () => {
  // A name git allows for a branch: a quote, a dollar with a bracket, a backquote, a semicolon.
  const base = "it's-$(x)-`y`;z"
  const { f, copy, created, args, task, answer } = await start({ base })
  assert.equal(answer.ok, true)
  assert.deepEqual(created, [CREATE_COPY(base)])
  assert.equal(args.length, 1)
  const asked = epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', worktree: copy, base, roles: TYPES })
  assert.deepEqual(f.conportCalls().at(-1), asked)
  assert.equal(task, promptText(asked))
  assert.ok(task.includes(base))
})

test('epic.start remembers the harness and the roles for the epic, the harness for the project and the terminal', async () => {
  // Named by its name, the project is remembered by the handle the CLI answered with.
  const { storage } = await start({ harness: 'codex', project: 'shop-api' })
  // No way is written: the record of the session holds its terminal alone.
  assert.deepEqual(storage, {
    [`harness:${HANDLE}:7`]: 'codex',
    [`roles:${HANDLE}:7`]: TYPES,
    [`session:${HANDLE}:7`]: { terminal: EPIC_TERMINAL },
    [`harness:${HANDLE}`]: 'codex'
  })
})

test('epic.start writes neither the launcher nor the old roles record', async () => {
  const { storage, answer } = await start()
  assert.equal(answer.ok, true)
  assert.equal(`launcher:${HANDLE}` in storage, false)
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
  const { f, answer, command, copy } = await start({ agents, roles })
  assert.equal(answer.ok, true)
  assert.ok(command.startsWith("claude-code '"), command)
  // The types go to the CLI as they were chosen: nobody checks they are installed.
  assert.deepEqual(f.conportCalls().at(-1), epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', worktree: copy, base: 'main', roles }))
  assert.equal(f.conportCalls().filter((call) => call[1] === 'agents').length, 1)
})

test('epic.start runs no epic run and no check', async () => {
  const machine = await startMachine()
  const copy = copyOf(machine.f.root, 7)
  mkdirSync(copy, { recursive: true })
  const { f, answer, command, worker } = await startOn(machine)
  await worker.deactivate()
  assert.equal(answer.ok, true)
  // Every call of the three programs: the epic and the agent kinds are read, then the text is asked
  // for once the working copy is there; nothing else of ConPort.
  assert.deepEqual(f.conportCalls(), [
    EPIC_LIST_CALL,
    EPIC_AGENTS_CALL,
    epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', worktree: copy, base: 'main', roles: TYPES })
  ])
  assert.deepEqual(f.gitCalls(), [['-C', f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/epic-7']])
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

test('epic.start without a way starts by the SDD skill', async () => {
  // The request names no way: the epic is done in its working copy, in a terminal of the SDD skill.
  const { f, answer, copy, created, opened, command, storage } = await start()
  assert.deepEqual(answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: copy } })
  assert.deepEqual(created, [CREATE_COPY('main')])
  assert.deepEqual(opened, [
    ['terminal', 'create', '--worktree', `path:${copy}`, '--title', 'conport epic 7 · SDD', '--command', command, '--json']
  ])
  // The CLI is told no way either, and no way is remembered.
  const asked = f.conportCalls().at(-1) ?? []
  assert.deepEqual(asked, epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', worktree: copy, base: 'main', roles: TYPES }))
  assert.equal(asked.includes('--way'), false)
  assert.deepEqual(Object.keys(storage).filter((key) => key.startsWith('way:')), [])
})

test('epic.start refuses an epic that is gone', async () => {
  const started = await start({ epic: 99 })
  assertRefused(started, 'epic_not_found', 'Epic 99 is not in the project', 'Press Refresh.')
  // The first refusal: nothing else is asked.
  assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  assert.deepEqual(started.f.gitCalls(), [])
  assert.deepEqual(started.f.orcaCalls(), [])
})

test('epic.start refuses an epic without a spec or a plan', async () => {
  for (const epic of [9, 10]) {
    // Whatever else is wrong with the request, the epic is named first.
    const started = await start({ epic, harness: 'gemini' })
    assertRefused(started, 'epic_not_ready', `Epic ${epic} has no spec or no plan`, 'Plan it from the Specs section.')
    assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  }
})

test('epic.start refuses a role type that is not a plain name', async () => {
  const keys = ['implementer', 'reviewer', 'gapHunter', 'finalReviewer'] as const
  // What a shell or the text of a task would read, an empty type, a path, letters that are not Latin.
  const types = ['my implementer', "o'neil", 'gap\nhunter', '', '`id`', '$(id)', 'a;b', 'a/b', 'τύπος', 'sdd-implementer\n']
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
    assertRefused(started, 'role_invalid', 'The subagent type is not a plain name', 'Choose a type for the role from the list.')
    // Before the harness is looked for.
    assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL])
  }
  // A request that names no roles at all is refused the same, whichever the harness.
  for (const harness of ['claude', 'codex']) {
    const machine = await startMachine()
    const request = { project: HANDLE, root: machine.f.root, epic: 7, harness }
    const answer = await machine.worker.request('epic.start', request as typeof request & { roles: Roles })
    await machine.worker.deactivate()
    const error = { code: 'role_invalid', message: 'The subagent type is not a plain name', action: 'Choose a type for the role from the list.' }
    assert.deepEqual(answer, { ok: false, error }, harness)
    assert.deepEqual(machine.worker.refusals, [])
    assert.deepEqual(machine.f.orcaCalls(), [])
    assert.deepEqual(machine.host.data().storage, {})
  }
  // Only Claude Code is told the types: another harness never reads them.
  const codex = await start({ harness: 'codex', roles: { ...TYPES, reviewer: 'my reviewer' } })
  assert.equal(codex.answer.ok, true)
  assert.equal(codex.f.conportCalls().flat().includes('my reviewer'), false)
})

test('epic.start refuses a harness that takes no task', async () => {
  const agents = { agents: [...AGENTS.agents, { id: 'opencode', label: 'OpenCode', command: 'opencode', found: true }] }
  for (const harness of ['gemini', 'opencode', 'aider']) {
    const started = await start({ harness, agents })
    assertRefused(started, 'agent_cannot_prepare', `The harness “${harness}” does not take a task at start`, 'Choose Claude Code, Codex or Cursor.')
    assert.deepEqual(started.f.gitCalls(), [])
  }
})

test('epic.start refuses a harness that is not found', async () => {
  const agents = { agents: AGENTS.agents.map((a) => (a.id === 'codex' ? { ...a, found: false } : a)) }
  const started = await start({ harness: 'codex', agents })
  assertRefused(started, 'agent_not_found', 'Harness “codex” not found on this machine', HARNESS_MISSING_ACTION)
  assert.equal(HARNESS_MISSING_ACTION, 'Start it in this Orca workspace and press Refresh.')
  // Before the branches are read.
  assert.deepEqual(started.f.conportCalls(), [EPIC_LIST_CALL, EPIC_AGENTS_CALL])
  assert.deepEqual(started.f.gitCalls(), [])
  assert.deepEqual(started.f.orcaCalls(), [])
})

test('branches epicN/… do not hold the start, and git is asked only for epic-N', async () => {
  // Branches an earlier run of another process cut for its tasks: the SDD skill starts all the same.
  const started = await start({ refs: ['refs/heads/epic7/t12', 'refs/heads/epic7/t13'] })
  assert.deepEqual(started.answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: started.copy } })
  assert.equal(started.created.length, 1)
  assert.deepEqual(started.f.gitCalls(), [['-C', started.f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads/epic-7']])
  // A branch under `epic-7/` is no branch of the epic either.
  const other = await start({ refs: ['refs/heads/epic-7/notes'] })
  assert.equal(other.answer.ok, true)
  assert.equal(other.created.length, 1)
  // Beside the branch of the epic and its copy, they change nothing: the copy is taken as it is.
  const both = await start({
    refs: ['refs/heads/epic-7', 'refs/heads/epic7/t12'],
    rows: (dir) => [worktreeRow(join(dir, 'elsewhere', 'epic-7'), 'epic-7')]
  })
  assert.equal(both.answer.ok && both.answer.data.worktree, join(dirname(both.f.root), 'elsewhere', 'epic-7'))
  assert.deepEqual(both.created, [])
})

test('epic.start refuses when the main working tree is on no branch', async () => {
  assertRefused(await start({ base: null }), 'root_detached', "The repository's main working copy is not on a branch, so the epic has no base", 'Check out a branch in the main working copy.')
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
  assertRefused(started, 'epic_branch_taken', 'The branch epic-7 is there, but it has no working copy', 'Open the branch as a workspace in Orca.')
})

test('epic.start refuses a truncated worktree list', async () => {
  const message = "The repository's working copies did not fit in Orca's answer: there are more than 10000"
  const action = 'Delete the working copies you do not need in Orca and try again.'
  // The copy may be among the rows cut off: none is created on a part of the list.
  assertRefused(await start({ truncated: true }), 'workspaces_truncated', message, action)
  assertRefused(await start({ truncated: true, refs: ['refs/heads/epic-7'] }), 'workspaces_truncated', message, action)
  // A list cut short that still holds what the start needs is enough.
  const there = await start({ truncated: true, refs: ['refs/heads/epic-7'], rows: (dir) => [worktreeRow(join(dir, 'elsewhere', 'epic-7'), 'epic-7')] })
  assert.equal(there.answer.ok, true)
  assert.deepEqual(there.created, [])
  // The main working tree itself is among the rows cut off: the base is not known.
  const elsewhere = (dir: string): Partial<WorktreeRow> => ({ path: join(dir, 'elsewhere', 'main'), isMainWorktree: false })
  assertRefused(await start({ truncated: true, main: (row) => ({ ...row, ...elsewhere(dirname(row.path)) }) }), 'workspaces_truncated', message, action)
})

test('epic.start refuses an answer of orca that lacks what it was asked for', async () => {
  const answered = (match: string, result: unknown): FakeAnswer => ({ match, stdout: json({ ok: true, result }) })
  // A whole list that names no main working tree of the repository.
  const unlisted = await start({ main: (row) => ({ ...row, isMainWorktree: false }) })
  assertRefused(unlisted, 'bad_output', "orca did not name the repository's main working copy", 'Update Orca.')
  // A working copy created without its path: no terminal is opened in a guessed folder.
  const pathless = await start({ orca: [answered('worktree create ', { worktree: {} })] })
  assert.deepEqual(pathless.answer, { ok: false, error: { code: 'bad_output', message: 'orca created a working copy and did not name its path', action: 'Update Orca.' } })
  assert.deepEqual(pathless.opened, [])
  assert.deepEqual(pathless.storage, {})
  // A terminal opened without its handle: there is no session to remember or to bring forward.
  const nameless = await start({ orca: [answered('terminal create ', { terminal: {} })] })
  assert.deepEqual(nameless.answer, { ok: false, error: { code: 'bad_output', message: 'orca opened a terminal and did not name it', action: 'Update Orca.' } })
  assert.deepEqual(nameless.switched, [])
  assert.deepEqual(nameless.storage, {})
})

test('a refusal of orca is returned as is', async () => {
  const refusal = { code: 'branch_in_use', message: 'the branch is checked out elsewhere', action: 'remove the other checkout' }
  const refused = (match: string): FakeAnswer => ({ match, code: 1, stdout: json({ ok: false, error: refusal }) })
  for (const match of ['worktree list', 'worktree create', 'terminal create']) {
    const { answer, storage, switched } = await start({ orca: [refused(match)] })
    assert.deepEqual(answer, { ok: false, error: refusal }, match)
    // A start that opened no terminal is not remembered.
    assert.deepEqual(storage, {})
    assert.deepEqual(switched, [])
  }
})

test('epic.start tells each refusal of conport prompt in the words of the panel, the copy left for the next start', async () => {
  const cases: Array<[string, string, string]> = [
    ['epic_not_found', 'Epic 7 is not in the project', 'Press Refresh.'],
    ['epic_not_ready', 'Epic 7 has no spec or no plan', 'Plan it from the Specs section.'],
    ['role_invalid', 'The subagent type is not a plain name', 'Choose a type for the role from the list.'],
    ['agent_cannot_prepare', 'The harness “claude” does not take a task at start', 'Choose Claude Code, Codex or Cursor.']
  ]
  for (const [code, message, action] of cases) {
    // The CLI checks again what the worker checked: the epic may have changed in between.
    const { answer, created, opened, storage, host } = await start({ conport: [promptRefused('epic', code)] })
    assert.deepEqual(answer, { ok: false, error: { code, message, action } }, code)
    assert.deepEqual(refusalText({ code, message, action }), { what: message, action })
    // The text is asked for after the copy is created, before any terminal is opened.
    assert.deepEqual(created, [CREATE_COPY('main')])
    assert.deepEqual(opened, [])
    assert.deepEqual(host.callsOf('terminal.create'), [])
    assert.deepEqual(storage, {})
  }
  // Another refusal reaches the panel as the CLI gave it, and an answer without a text is bad output.
  const noKey = await start({ conport: [{ match: 'prompt epic ', code: 2, stdout: json({ ok: false, error: NO_KEY }) }] })
  assert.deepEqual(noKey.answer, { ok: false, error: NO_KEY })
  assert.deepEqual(noKey.opened, [])
  const textless = await start({ conport: [{ match: 'prompt epic ', stdout: json({ ok: true }) }] })
  assert.deepEqual(textless.answer, { ok: false, error: { code: 'bad_output', message: "conport answered without the task's text", action: 'Update conport.' } })
  assert.deepEqual(textless.opened, [])
})

test('epic.start refuses when the branches cannot be listed', async () => {
  const f = fake(
    [{ match: 'epic list', stdout: json(EPIC_LIST) }, { match: 'epic agents', stdout: json(AGENTS) }],
    [],
    [{ match: '-C ', code: 128, stderr: 'fatal: not a repository\n' }]
  )
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker(f.worker, { host })
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, harness: 'claude', roles: TYPES })
  await worker.deactivate()
  // What git said, as it said it, and the one thing to do; the panel shows both.
  const error = { code: 'git_failed', message: 'fatal: not a repository', action: 'Check the repository with git status in its root and try again.' }
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
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, harness: 'claude', roles: TYPES })
  await worker.deactivate()
  const error = { code: 'git_failed', message: 'git: exit code 3', action: 'Check the repository with git status in its root and try again.' }
  assert.deepEqual(answer, { ok: false, error })
  assert.deepEqual(f.orcaCalls(), [])
})

test('a git that cannot start is told with the one thing to do', async () => {
  const f = fake([{ match: 'epic list', stdout: json(EPIC_LIST) }, { match: 'epic agents', stdout: json(AGENTS) }])
  const { createWorker } = await import('./worker')
  const broken = createWorker({ conport: f.deps.conport, orca: f.deps.orca, git: ['/nonexistent/bin/git'] })
  const host = f.host({ 'agents.list': { agents: [] } })
  const worker = await mountWorker({ default: broken.activate, deactivate: broken.deactivate } as typeof f.worker, { host })
  const answer = await worker.request('epic.start', { project: HANDLE, root: f.root, epic: 7, harness: 'claude', roles: TYPES })
  await worker.deactivate()
  assert.equal(answer.ok === false && answer.error.code, 'spawn_failed')
  assert.match(answer.ok === false ? answer.error.action : '', /Make git visible on the Orca app's PATH/)
  assert.deepEqual(f.orcaCalls(), [])
})

test('an epic terminal orca cannot bring forward is only logged, and the start is remembered', async () => {
  const refused = { ok: false, error: { code: 'terminal_not_found', message: 'no such terminal' } }
  const { answer, storage, worker } = await start({ orca: [{ match: 'terminal switch', code: 1, stdout: json(refused) }] })
  assert.equal(answer.ok, true)
  assert.deepEqual(storage[`session:${HANDLE}:7`], { terminal: EPIC_TERMINAL })
  assert.equal(worker.logs.some((line) => line.includes('terminal_not_found')), true, JSON.stringify(worker.logs))
})

test('a brainstorm and a hand still remember the agent of the project', async () => {
  const machine = await startMachine({ orca: [SWITCHED] })
  const { f, host, worker } = machine
  const launcher = async (): Promise<unknown> => {
    const answer = await worker.request('agents.get', { project: HANDLE, root: f.root })
    return answer.ok ? answer.data.launcher : answer.error
  }
  const opened = await worker.request('idea.start', { project: HANDLE, root: f.root, task: 41, agent: 'codex' })
  assert.deepEqual(opened, { ok: true, data: { terminal: 'term-1' } })
  assert.equal(await launcher(), 'codex')
  // It opens its terminal as before: through the host, in the root.
  assert.deepEqual(
    (host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string }>).map(({ workspaceId, title }) => ({ workspaceId, title })),
    [{ workspaceId: 'ws-root', title: 'conport idea 41' }]
  )
  // The start of an epic with another harness leaves the agent of the project as it was.
  const started = await startOn(machine, { harness: 'claude' })
  assert.equal(started.answer.ok, true)
  assert.equal(await launcher(), 'codex')
  assert.equal(started.storage[`harness:${HANDLE}`], 'claude')
  // A refused brainstorm remembers nothing.
  const refused = await worker.request('idea.start', { project: 'prpther2kd', root: f.root, task: 41, agent: 'gemini' })
  assert.equal(refused.ok === false && refused.error.code, 'agent_cannot_prepare')
  assert.equal('launcher:prpther2kd' in (host.data().storage as Record<string, unknown>), false)
  await worker.deactivate()

  // A task handed remembers its agent, one whose agent is refused does not.
  assert.equal((await hand(41, 'do', 'codex')).remembered, 'codex')
  const refusedHand = await hand(41, 'do', 'gemini')
  assert.equal(refusedHand.answer.ok, false)
  assert.equal(refusedHand.remembered, null)
})

test('the choice of one epic does not change the choice of another', async () => {
  const machine = await startMachine()
  const first = await startOn(machine, { epic: 7, harness: 'claude' })
  assert.equal(first.answer.ok, true)
  const second = await startOn(machine, { epic: 15, harness: 'codex', roles: { ...TYPES, reviewer: 'other-reviewer' } })
  assert.equal(second.answer.ok, true)
  await machine.worker.deactivate()
  const storage = second.storage
  assert.deepEqual(Object.keys(storage).filter((key) => key.startsWith('way:')), [])
  assert.equal(storage[`harness:${HANDLE}:7`], 'claude')
  assert.equal(storage[`harness:${HANDLE}:15`], 'codex')
  assert.deepEqual(storage[`roles:${HANDLE}:7`], TYPES)
  assert.deepEqual(storage[`roles:${HANDLE}:15`], { ...TYPES, reviewer: 'other-reviewer' })
  assert.deepEqual(storage[`session:${HANDLE}:7`], { terminal: EPIC_TERMINAL })
  assert.deepEqual(storage[`session:${HANDLE}:15`], { terminal: EPIC_TERMINAL })
  // The project keeps the harness of its last start.
  assert.equal(storage[`harness:${HANDLE}`], 'codex')
})

// --- epic.session ---

/** A terminal of a shell, as orca opens two of them in a working copy it creates. */
const shell = (handle: string): Record<string, unknown> => ({ handle, title: '~/repo', agentIdentity: '' })
/** A terminal an agent runs in. */
const agent = (handle: string, title = '✳ Claude Code'): Record<string, unknown> => ({ handle, title, agentIdentity: 'claude' })

/** What the start of epic 7 remembers of its terminal. */
const remembered = (terminal = EPIC_TERMINAL): Record<string, unknown> => ({ [`session:${HANDLE}:7`]: { terminal } })

/** What a start of epic 7 by an earlier release of the panel remembered: its way besides its terminal. */
const rememberedByEarlierRelease = (terminal = EPIC_TERMINAL): Record<string, unknown> => ({
  [`way:${HANDLE}:7`]: 'workflow',
  [`session:${HANDLE}:7`]: { terminal, way: 'workflow' }
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
  const project = (options.project === undefined ? HANDLE : options.project) as string
  const answer: unknown =
    options.request === 'terminal.show'
      ? await worker.request('terminal.show', { project, root: f.root, row: { kind: 'epic', id: 7, spec: null, idea: null } })
      : await worker.request('epic.session', { project, root: f.root, epic: 7 })
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
  harness: 'claude',
  roles: DEFAULT_ROLES,
  worktree: null,
  alive: false,
  terminal: null
}

test('epic.session: no working copy, by SDD', async () => {
  const none = await session({ copy: false })
  assert.deepEqual(none.answer, { ok: true, data: NEW_EPIC })
  // Without a copy and without a remembered terminal there is no place to look for a session in.
  assert.deepEqual(none.listed, [])
  // ConPort and git are not asked, and a question stores nothing.
  assert.deepEqual(none.f.conportCalls(), [])
  assert.deepEqual(none.f.gitCalls(), [])
  assert.deepEqual(none.storage, {})
  assert.deepEqual(none.refusals, [])
  // A terminal remembered for a copy that is gone: only that terminal counts in the root, and
  // another agent working there is no session.
  const gone = await session({ copy: false, storage: remembered(), terminals: { root: [agent('term-other')] } })
  assert.deepEqual(gone.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(gone.listed, gone.inRoot)
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
    storage: remembered(),
    terminals: { copy: [shell('term-a'), shell('term-b'), agent(EPIC_TERMINAL)] }
  })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: copy, alive: true, terminal: EPIC_TERMINAL } })
  assert.deepEqual(listed, inCopy)
})

test('epic.session: the main working tree on the branch of the epic is its working copy', async () => {
  const { answer, f } = await session({ copy: false, base: 'epic-7', storage: remembered(), terminals: { root: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: f.root, alive: true, terminal: EPIC_TERMINAL } })
})

test('epic.session: an old session record with way workflow is read, only its terminal', async () => {
  // A start by an earlier release of the panel left `way` in the record and a key of its own;
  // its session works in the root, and there is no working copy of the epic.
  const storage = { [`way:${HANDLE}:7`]: 'workflow', [`session:${HANDLE}:7`]: { terminal: 't1', way: 'workflow' } }
  const { answer, listed, inRoot } = await session({ copy: false, storage, terminals: { root: [shell('term-a'), agent('t1')] } })
  // The state names no way: its terminal is t1, alive in the root.
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, alive: true, terminal: 't1' } })
  assert.equal(answer.ok && 'way' in answer.data, false)
  assert.equal(answer.ok && 'workflowBranches' in answer.data, false)
  assert.deepEqual(listed, inRoot)
  // Its agent left: the epic has no session and is offered a start, whatever other agent works in the root.
  const left = await session({ copy: false, storage, terminals: { root: [shell('t1'), agent('term-other')] } })
  assert.deepEqual(left.answer, { ok: true, data: NEW_EPIC })
  // With a working copy of the epic, the record names the terminal looked for there.
  const inCopy = await session({ storage, terminals: { copy: [shell('term-a'), agent('t1')] } })
  assert.deepEqual(inCopy.answer, { ok: true, data: { ...NEW_EPIC, worktree: inCopy.copy, alive: true, terminal: 't1' } })
  assert.deepEqual(inCopy.listed, inCopy.inCopy)
})

test('epic.session reads no branches: git is not asked', async () => {
  for (const refs of [['refs/heads/epic7/t12', 'refs/heads/epic7/t13'], ['refs/heads/epic-7']]) {
    const { answer, f } = await session({ copy: false, refs })
    assert.deepEqual(answer, { ok: true, data: NEW_EPIC }, refs.join(' '))
    assert.deepEqual(f.gitCalls(), [])
  }
})

test('epic.session: the remembered terminal with an agent identity is alive, with an empty one is not', async () => {
  const place = (terminals: unknown[]): SessionCase => ({ storage: remembered(), terminals: { copy: terminals } })
  const named = await session(place([agent(EPIC_TERMINAL)]))
  assert.equal(named.answer.ok && named.answer.data.alive, true)
  assert.equal(named.answer.ok && named.answer.data.terminal, EPIC_TERMINAL)
  // The agent left its terminal: a shell is what remains of it. However orca says "no agent".
  for (const agentIdentity of ['', null, '  ']) {
    const emptied = { handle: EPIC_TERMINAL, title: 'conport epic 7 · SDD', agentIdentity }
    const left = await session(place([shell('term-a'), emptied]))
    assert.equal(left.answer.ok && left.answer.data.alive, false, JSON.stringify(agentIdentity))
    assert.equal(left.answer.ok && left.answer.data.terminal, null)
    // Another agent in the copy of the epic is the session, or a start would open a second agent over it.
    const beside = await session(place([emptied, agent('term-other')]))
    assert.equal(beside.answer.ok && beside.answer.data.alive, true, JSON.stringify(agentIdentity))
    assert.equal(beside.answer.ok && beside.answer.data.terminal, 'term-other')
  }
})

test('epic.session: a remembered terminal without the field is alive', async () => {
  // An Orca that does not say who runs in a terminal: the terminal being there is all there is to know.
  const bare = (handle: string): Record<string, unknown> => ({ handle, title: 'zsh' })
  const sdd = await session({ storage: remembered(), terminals: { copy: [bare('term-a'), bare(EPIC_TERMINAL)] } })
  assert.equal(sdd.answer.ok && sdd.answer.data.alive, true)
  assert.equal(sdd.answer.ok && sdd.answer.data.terminal, EPIC_TERMINAL)
  // Without the remembered one, a terminal that names no agent is not known to hold one.
  const unknown = await session({ storage: remembered(), terminals: { copy: [bare('term-a'), bare('term-b')] } })
  assert.equal(unknown.answer.ok && unknown.answer.data.alive, false)
})

test('epic.session: a remembered terminal that is gone falls back to the working copy', async () => {
  // Orca was started again: the agent of the copy runs under a new handle.
  const again = await session({ storage: remembered(), terminals: { copy: [shell('term-a'), shell('term-b'), agent('term-new')] } })
  assert.deepEqual(again.answer, { ok: true, data: { ...NEW_EPIC, worktree: again.copy, alive: true, terminal: 'term-new' } })
  // No terminal was ever remembered, and an agent works in the copy.
  const never = await session({ terminals: { copy: [shell('term-a'), agent('term-new'), agent('term-later')] } })
  assert.equal(never.answer.ok && never.answer.data.terminal, 'term-new')
  // The two shells of the copy are no session.
  const shells = await session({ storage: remembered(), terminals: { copy: [shell('term-a'), shell('term-b')] } })
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
  // The old key of the way alone sends no search to the root; a remembered terminal is looked for
  // there by its handle, and none of these is it.
  const byWay = await session({ copy: false, storage: { [`way:${HANDLE}:7`]: 'workflow' }, terminals: { root } })
  assert.deepEqual(byWay.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(byWay.listed, [])
  const byRecord = await session({ copy: false, storage: rememberedByEarlierRelease(), terminals: { root } })
  assert.deepEqual(byRecord.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(byRecord.listed, byRecord.inRoot)
  // Nothing remembered: the root is not even asked for.
  const bySdd = await session({ copy: false, terminals: { root } })
  assert.deepEqual(bySdd.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(bySdd.listed, [])
  const withCopy = await session({ terminals: { root, copy: [shell('term-a')] } })
  assert.equal(withCopy.answer.ok && withCopy.answer.data.alive, false)
  assert.deepEqual(withCopy.listed, withCopy.inCopy)
})

test('epic.session answers the stored harness and roles, and the defaults for a new epic', async () => {
  const chosen = async (storage: Record<string, unknown>) => {
    const { answer } = await session({ copy: false, storage, terminals: { root: [] } })
    // The state names no way, whatever was stored.
    assert.equal(answer.ok && 'way' in answer.data, false)
    return answer.ok ? { harness: answer.data.harness, roles: answer.data.roles } : answer.error
  }
  assert.deepEqual(DEFAULT_ROLES, {
    implementer: 'conport:sdd-implementer',
    reviewer: 'conport:sdd-task-reviewer',
    gapHunter: 'conport:sdd-gap-hunter',
    finalReviewer: 'conport:sdd-final-reviewer'
  })
  assert.deepEqual(await chosen({}), { harness: 'claude', roles: DEFAULT_ROLES })
  // A new epic takes the harness of the last start in the project.
  assert.deepEqual(await chosen({ [`harness:${HANDLE}`]: 'codex' }), { harness: 'codex', roles: DEFAULT_ROLES })
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
    [`prepare:${HANDLE}`]: 'cursor',
    [`launcher:${HANDLE}`]: 'cursor'
  }
  assert.deepEqual(await chosen(elsewhere), { harness: 'claude', roles: DEFAULT_ROLES })
  // The records of the epic itself win over the harness of the project.
  const own = { [`way:${HANDLE}:7`]: 'workflow', [`harness:${HANDLE}:7`]: 'claude', [`roles:${HANDLE}:7`]: TYPES, [`harness:${HANDLE}`]: 'codex' }
  assert.deepEqual(await chosen({ ...elsewhere, ...own }), { harness: 'claude', roles: TYPES })
  // A record that is not what a start writes is no record.
  const broken = { [`way:${HANDLE}:7`]: 'dispatcher', [`harness:${HANDLE}:7`]: '', [`roles:${HANDLE}:7`]: { ...TYPES, reviewer: 7 }, [`harness:${HANDLE}`]: 3 }
  assert.deepEqual(await chosen(broken), { harness: 'claude', roles: DEFAULT_ROLES })
  assert.deepEqual(await chosen({ [`roles:${HANDLE}:7`]: {} }), { harness: 'claude', roles: DEFAULT_ROLES })
})

test('epic.session finds the session epic.start has just opened', async () => {
  const machine = await startMachine({
    // The fake lists the copy from the outset: the start takes it as it is.
    rows: (dir) => [worktreeRow(join(dir, 'copies', 'repo', 'epic-7'), 'epic-7')],
    refs: ['refs/heads/epic-7'],
    orca: [{ match: 'terminal list --worktree path:', stdout: json({ ok: true, result: { terminals: [shell('term-a'), agent(EPIC_TERMINAL)], truncated: false } }) }]
  })
  // Named by its name at the start, the project is remembered by its handle: the panel asks by that.
  const begun = await startOn(machine, { project: 'shop-api' })
  assert.equal(begun.answer.ok, true)
  const { f, worker } = machine
  const answer = await worker.request('epic.session', { project: HANDLE, root: f.root, epic: 7 })
  await worker.deactivate()
  const expected: EpicSession = { harness: 'claude', roles: TYPES, worktree: begun.copy, alive: true, terminal: EPIC_TERMINAL }
  assert.deepEqual(answer, { ok: true, data: expected })
  assert.deepEqual(f.orcaCalls().at(-1), ['terminal', 'list', '--worktree', `path:${begun.copy}`, '--limit', '10000', '--json'])
})

test('epic.session answers with the main working tree on no branch', async () => {
  // The base of a new copy is of no matter to the question whether a session is alive.
  const { answer, copy } = await session({ base: null, storage: remembered(), terminals: { copy: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(answer, { ok: true, data: { ...NEW_EPIC, worktree: copy, alive: true, terminal: EPIC_TERMINAL } })
})

test('epic.session decides nothing on a list orca cut short', async () => {
  const copies = {
    code: 'workspaces_truncated',
    message: "The repository's working copies did not fit in Orca's answer: there are more than 10000",
    action: 'Delete the working copies you do not need in Orca and try again.'
  }
  // The copy of the epic may be among the rows cut off.
  assert.deepEqual((await session({ copy: false, truncated: true })).answer, { ok: false, error: copies })
  // A list cut short that holds the copy is enough.
  const held = await session({ truncated: true, terminals: { copy: [agent('term-new')] } })
  assert.equal(held.answer.ok && held.answer.data.alive, true)

  const terminals = {
    code: 'terminals_truncated',
    message: "The workspace's terminals did not fit in Orca's answer",
    action: 'Close the terminals you do not need in this Orca workspace and press Refresh.'
  }
  // The terminal of the session may be among the rows cut off.
  const cut = await session({ storage: remembered(), terminals: { copy: [shell('term-a')] }, terminalsTruncated: true })
  assert.deepEqual(cut.answer, { ok: false, error: terminals })
  assert.deepEqual(refusalText(terminals), { what: terminals.message, action: terminals.action })
  // A session found in the part that came is alive all the same.
  const found = await session({ storage: remembered(), terminals: { copy: [agent(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.equal(found.answer.ok && found.answer.data.alive, true)
  // The remembered terminal is there with no agent in it: another agent of the copy may be cut off.
  const left = await session({ storage: remembered(), terminals: { copy: [shell(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.deepEqual(left.answer, { ok: false, error: terminals })
  // In the root nothing cut off would change that: only the remembered terminal counts there.
  const inRoot = await session({ copy: false, storage: rememberedByEarlierRelease(), terminals: { root: [shell(EPIC_TERMINAL)] }, terminalsTruncated: true })
  assert.deepEqual(inRoot.answer, { ok: true, data: NEW_EPIC })
})

test('epic.session returns a refusal of orca, and a git that fails is not asked', async () => {
  const refusal = { code: 'runtime_unavailable', message: 'Orca is not running', action: 'start Orca' }
  const refused = (match: string): FakeAnswer => ({ match, code: 1, stdout: json({ ok: false, error: refusal }) })
  for (const match of ['worktree list', 'terminal list']) {
    const { answer } = await session({ orca: [refused(match)], terminals: { copy: [] } })
    assert.deepEqual(answer, { ok: false, error: refusal }, match)
  }
  // The branches are no part of the state: a git that would fail is never asked.
  const git = await session({ copy: false, git: [{ match: '-C ', code: 128, stderr: 'fatal: not a repository\n' }] })
  assert.deepEqual(git.answer, { ok: true, data: NEW_EPIC })
  assert.deepEqual(git.f.gitCalls(), [])
})

/** What a request about the session of an epic answers when its project is not named by the handle. */
const NOT_HANDLE = {
  code: 'project_not_handle',
  message: "The project is not named by its handle: the choice and the epic's session are kept under the project's handle",
  action: 'Press Refresh.'
}

test('epic.session refuses a project that is not named by its handle', async () => {
  // What a start by this name remembered lies under the handle: an answer by the name would say "no session".
  const stored = { ...remembered(), 'way:shop-api:7': 'workflow', 'session:shop-api:7': { terminal: EPIC_TERMINAL, way: 'workflow' } }
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
  assert.deepEqual(odd.answer, { ok: false, error: { code: 'bad_output', message: 'conport answered without a list of tasks', action: 'Update conport.' } })
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
  const error = { code: 'harness_invalid', message: 'No harness is named', action: "Choose the epic's harness." }
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
  const sdd = await show({ storage: remembered(), terminals: { copy: [shell('term-a'), agent(EPIC_TERMINAL)] } })
  assert.deepEqual(sdd.answer, { ok: true, data: null })
  assert.deepEqual(sdd.switched, SWITCH(EPIC_TERMINAL))
  // The copies and their terminals are read anew, the branches and ConPort are not.
  assert.deepEqual(sdd.f.orcaCalls().map((call) => call.slice(0, 2).join(' ')), ['worktree list', 'terminal list', 'terminal switch'])
  assert.deepEqual(sdd.listed, sdd.inCopy)
  assert.deepEqual([sdd.f.gitCalls(), sdd.f.conportCalls()], [[], []])
  assert.deepEqual(sdd.refusals, [])
  // The terminal is found by the rule of epic.session: after a restart of Orca, the agent of the copy.
  const again = await show({ storage: remembered(), terminals: { copy: [shell('term-a'), agent('term-new')] } })
  assert.deepEqual(again.answer, { ok: true, data: null })
  assert.deepEqual(again.switched, SWITCH('term-new'))
  // The session a start by an earlier release left in the root: its remembered terminal, not another agent there.
  const old = await show({ copy: false, storage: rememberedByEarlierRelease(), terminals: { root: [agent('term-other'), agent(EPIC_TERMINAL)] } })
  assert.deepEqual(old.answer, { ok: true, data: null })
  assert.deepEqual(old.switched, SWITCH(EPIC_TERMINAL))
  assert.deepEqual(old.listed, old.inRoot)
})

test('terminal.show refuses when the epic has no live session, and switches to nothing', async () => {
  const error = { code: 'session_gone', message: 'Epic 7 has no live session: its terminal is closed or its agent has exited', action: 'Press Refresh.' }
  const gone: SessionCase[] = [
    // No working copy; a copy with its two shells; an agent that left its terminal.
    { copy: false, storage: remembered(), terminals: { root: [] } },
    { storage: remembered(), terminals: { copy: [shell('term-a'), shell('term-b')] } },
    { storage: remembered(), terminals: { copy: [shell(EPIC_TERMINAL)] } },
    // The records of a start by an earlier release: no terminal remembered, and one that is gone,
    // with an agent of someone else in the root.
    { copy: false, storage: { [`way:${HANDLE}:7`]: 'workflow' }, terminals: { root: [agent('term-other')] } },
    { copy: false, storage: rememberedByEarlierRelease(), terminals: { root: [agent('term-other')] } }
  ]
  for (const [i, options] of gone.entries()) {
    const { answer, switched } = await show(options)
    assert.deepEqual(answer, { ok: false, error }, String(i))
    assert.deepEqual(switched, [])
  }
  assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
})

test('terminal.show refuses a project that is not named by its handle, and returns a refusal of orca', async () => {
  const byName = await show({ project: 'shop-api', storage: remembered(), terminals: { copy: [agent(EPIC_TERMINAL)] } })
  assert.deepEqual(byName.answer, { ok: false, error: NOT_HANDLE })
  assert.deepEqual(byName.f.orcaCalls(), [])
  // The panel asked for this terminal: that orca cannot show it is told, not only logged.
  const refusal = { code: 'terminal_not_found', message: 'no such terminal' }
  for (const match of ['worktree list', 'terminal list', 'terminal switch']) {
    const refused = await show({
      storage: remembered(),
      terminals: { copy: [agent(EPIC_TERMINAL)] },
      orca: [{ match, code: 1, stdout: json({ ok: false, error: refusal }) }]
    })
    assert.deepEqual(refused.answer, { ok: false, error: { ...refusal, action: '' } }, match)
  }
})

// --- the SDD stages and their launches ---

/** A document as the CLI names it, `doc-<N>`, made from its number. */
const doc = (n: number): string => `doc-${n}`

test('sdd.list answers the JSON of conport sdd list', async () => {
  const f = fake([{ match: 'sdd list', stdout: json(SDD_LIST) }])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('sdd.list', { project: HANDLE, root: f.root }), { ok: true, data: SDD_LIST })
  // One read of the stages: epics and tasks are not listed apart from it.
  assert.deepEqual(f.conportCalls(), [sddListArgs(HANDLE)])
  await worker.deactivate()
  // A refusal of the CLI reaches the panel as it gave it.
  const refusing = fake([{ match: 'sdd list', code: 2, stdout: json({ ok: false, error: NO_KEY }) }])
  const refused = await mountWorker(refusing.worker, { host: refusing.host() })
  assert.deepEqual(await refused.request('sdd.list', { project: HANDLE, root: refusing.root }), { ok: false, error: NO_KEY })
  await refused.deactivate()
})

test('sdd.taken runs sdd list --taken', async () => {
  const f = fake([
    { match: 'sdd list --taken', stdout: json(TAKEN) },
    { match: 'sdd list', stdout: json(SDD_LIST) }
  ])
  const worker = await mountWorker(f.worker, { host: f.host() })
  assert.deepEqual(await worker.request('sdd.taken', { project: HANDLE, root: f.root }), { ok: true, data: TAKEN })
  // The light read alone: the full list is not read behind it.
  assert.deepEqual(f.conportCalls(), [sddTakenArgs(HANDLE)])
  await worker.deactivate()
})

/** A machine for the launches of the rows: the CLI answers by `conport`, the main working copy is on `base`. */
async function launchMachine(conport: FakeAnswer[] = [], options: { base?: string | null; storage?: Record<string, unknown> } = {}) {
  const base = options.base === undefined ? 'main' : options.base
  const f = fake([...conport, { match: 'epic agents', stdout: json(AGENTS) }], ({ root }) => [
    SWITCHED,
    worktreeList(root, [worktreeRow(root, base, true)])
  ])
  const host = f.host({ 'agents.list': { agents: [] } }, options.storage)
  const worker = await mountWorker(f.worker, { host })
  return {
    f,
    host,
    worker,
    storage: (): Record<string, unknown> => host.data().storage as Record<string, unknown>,
    created: () => host.callsOf('terminal.create') as Array<{ workspaceId: string; title: string; command: string }>
  }
}

type LaunchMachine = Awaited<ReturnType<typeof launchMachine>>

/** The terminals a launch opened: their workspace, their title, the program and the arguments the agent got. */
const openedBy = (m: LaunchMachine) =>
  m.created().map(({ workspaceId, title, command }) => ({ workspaceId, title, program: command.split(' ')[0], args: argumentsOf(command) }))

test('idea.start opens the agent in the root with the idea task and remembers its terminal and the launcher', async () => {
  const m = await launchMachine()
  const answer = await m.worker.request('idea.start', { project: HANDLE, root: m.f.root, task: 41, agent: 'codex' })
  assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } })
  const asked = ideaPromptArgs({ task: 41, project: HANDLE, agent: 'codex', root: m.f.root })
  // The text is the one the CLI printed for the panel of Orca, given to the agent as one argument.
  assert.deepEqual(m.f.conportCalls(), [asked, ['epic', 'agents', '--json']])
  assert.deepEqual(openedBy(m), [{ workspaceId: 'ws-root', title: 'conport idea 41', program: 'codex', args: [promptText(asked)] }])
  // The person talks with the agent there: the terminal comes to the front.
  assert.deepEqual(m.f.orcaCalls(), [['terminal', 'switch', '--terminal', 'term-1', '--json']])
  assert.deepEqual(m.storage(), { [`launcher:${HANDLE}`]: 'codex', [`session:${HANDLE}:task-41`]: { terminal: 'term-1' } })
  assert.deepEqual(m.worker.refusals, [])

  // An agent that takes no task is refused before the CLI is asked; nothing more is opened or kept.
  const refused = await m.worker.request('idea.start', { project: HANDLE, root: m.f.root, task: 43, agent: 'gemini' })
  assert.deepEqual(refused, {
    ok: false,
    error: { code: 'agent_cannot_prepare', message: 'The agent “gemini” does not take a task at start', action: 'Choose Claude Code, Codex or Cursor.' }
  })
  assert.equal(m.f.conportCalls().length, 2)
  assert.equal(m.created().length, 1)
  assert.equal(`session:${HANDLE}:task-43` in m.storage(), false)
  await m.worker.deactivate()
})

test('proposal.start accepts the proposal first, then starts the idea it answers', async () => {
  const m = await launchMachine([{ match: 'proposal accept ', stdout: json({ task: 60 }) }])
  const answer = await m.worker.request('proposal.start', { project: HANDLE, root: m.f.root, doc: 301, agent: 'claude' })
  assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1', task: 60 } })
  const idea = ideaPromptArgs({ task: 60, project: HANDLE, agent: 'claude', root: m.f.root })
  // The agent is looked up once, before the accept; then the idea the accept answers is the one
  // the agent is started with.
  assert.deepEqual(m.f.conportCalls(), [['epic', 'agents', '--json'], proposalAcceptArgs({ doc: 301, project: HANDLE }), idea])
  assert.deepEqual(openedBy(m), [{ workspaceId: 'ws-root', title: 'conport idea 60', program: 'claude', args: [promptText(idea)] }])
  // The row of the new idea finds this terminal.
  assert.deepEqual(m.storage(), { [`launcher:${HANDLE}`]: 'claude', [`session:${HANDLE}:task-60`]: { terminal: 'term-1' } })
  await m.worker.deactivate()
})

/** What the fake conport answers when a command starting with `match` refuses with `code`, in the CLI's English. */
function refusedAs(match: string, code: string): FakeAnswer {
  const message = `${code.replace(/_/g, ' ')}, as the CLI words it`
  return { match, code: 2, stdout: json({ ok: false, error: { code, message, action: 'do what the CLI says' } }) }
}

const PROPOSAL_CLOSED = { code: 'proposal_closed', message: `Proposal ${doc(301)} is no longer open: it was accepted or declined`, action: 'Press Refresh.' }
const NOT_A_PROPOSAL = { code: 'not_a_proposal', message: `Document ${doc(301)} is not a proposal`, action: 'Press Refresh.' }
/** A decline of a proposal whose idea an accept left and someone took up. */
const PROPOSAL_ACCEPTED = { code: 'proposal_accepted', message: `Proposal ${doc(301)} already has its idea, and the idea is taken up`, action: 'Press Refresh.' }

test('a refused accept opens nothing', async () => {
  for (const error of [PROPOSAL_CLOSED, NOT_A_PROPOSAL]) {
    const m = await launchMachine([refusedAs('proposal accept ', error.code)])
    const answer = await m.worker.request('proposal.start', { project: HANDLE, root: m.f.root, doc: 301, agent: 'claude' })
    // Said in the panel's words, and shown as they are.
    assert.deepEqual(answer, { ok: false, error }, error.code)
    assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
    // No idea is asked for, no terminal opened, nothing remembered.
    assert.deepEqual(m.f.conportCalls(), [['epic', 'agents', '--json'], proposalAcceptArgs({ doc: 301, project: HANDLE })])
    assert.deepEqual(m.created(), [])
    assert.deepEqual(m.storage(), {})
    await m.worker.deactivate()
  }
  // An accept that names no task is bad output: nothing is started on a guess.
  for (const body of [{}, { task: '60' }, { task: null }]) {
    const m = await launchMachine([{ match: 'proposal accept ', stdout: json(body) }])
    const answer = await m.worker.request('proposal.start', { project: HANDLE, root: m.f.root, doc: 301, agent: 'claude' })
    assert.deepEqual(answer, { ok: false, error: { code: 'bad_output', message: 'conport accepted the proposal without naming its task', action: 'Update conport.' } })
    assert.deepEqual(m.created(), [])
    assert.deepEqual(m.storage(), {})
    await m.worker.deactivate()
  }
  // An agent that takes no task is refused before the proposal is accepted: it stays where it was.
  const m = await launchMachine([{ match: 'proposal accept ', stdout: json({ task: 60 }) }])
  const answer = await m.worker.request('proposal.start', { project: HANDLE, root: m.f.root, doc: 301, agent: 'gemini' })
  assert.equal(answer.ok === false && answer.error.code, 'agent_cannot_prepare')
  assert.deepEqual(m.f.conportCalls(), [])
  // So is one that takes a task but is not on this machine: nothing is accepted for an agent that cannot start.
  const missing = await m.worker.request('proposal.start', { project: HANDLE, root: m.f.root, doc: 301, agent: 'cursor' })
  assert.deepEqual(missing, {
    ok: false,
    error: { code: 'agent_not_found', message: 'Agent “cursor” not found', action: 'Start the agent in this Orca workspace and press Refresh.' }
  })
  assert.deepEqual(m.f.conportCalls(), [['epic', 'agents', '--json']])
  assert.deepEqual(m.created(), [])
  assert.deepEqual(m.storage(), {})
  await m.worker.deactivate()
})

test('a launch by the name of the project is refused before anything runs: its terminal is kept under the handle', async () => {
  const m = await launchMachine([{ match: 'proposal accept ', stdout: json({ task: 60 }) }])
  const project = 'shop-api'
  const answers = [
    await m.worker.request('idea.start', { project, root: m.f.root, task: 41, agent: 'claude' }),
    await m.worker.request('proposal.start', { project, root: m.f.root, doc: 301, agent: 'claude' }),
    await m.worker.request('spec.start', { project, root: m.f.root, target: { doc: 30 }, agent: 'claude' }),
    await m.worker.request('task.hand', { project, root: m.f.root, task: 51, agent: 'claude', mode: 'do' })
  ]
  for (const answer of answers) assert.deepEqual(answer, { ok: false, error: NOT_HANDLE })
  // Nothing is read, accepted, opened or remembered.
  assert.deepEqual([m.f.conportCalls(), m.f.orcaCalls(), m.created(), m.storage()], [[], [], [], {}])
  await m.worker.deactivate()
})

test('spec.start of a document and of an epic passes the branch of the main copy as --base and remembers the terminal under doc-<N> or plan-<epic>', async () => {
  const cases: Array<[{ doc: number } | { epic: number }, string, string]> = [
    [{ doc: 30 }, `conport spec ${doc(30)}`, `session:${HANDLE}:${doc(30)}`],
    // Not under the bare number: that key is the session of the epic in its working copy.
    [{ epic: 9 }, 'conport spec 9', `session:${HANDLE}:plan-9`]
  ]
  for (const [target, title, key] of cases) {
    // The main working copy is on a branch other than main: that branch is the base.
    const m = await launchMachine([], { base: 'develop' })
    const answer = await m.worker.request('spec.start', { project: HANDLE, root: m.f.root, target, agent: 'codex' })
    assert.deepEqual(answer, { ok: true, data: { terminal: 'term-1' } }, title)
    const asked = specPromptArgs({ target, project: HANDLE, agent: 'codex', root: m.f.root, base: 'develop' })
    assert.deepEqual(m.f.conportCalls(), [asked, ['epic', 'agents', '--json']])
    assert.equal(asked[asked.indexOf('--base') + 1], 'develop')
    assert.deepEqual(openedBy(m), [{ workspaceId: 'ws-root', title, program: 'codex', args: [promptText(asked)] }])
    assert.deepEqual(m.storage(), { [`launcher:${HANDLE}`]: 'codex', [key]: { terminal: 'term-1' } })
    // The main copy is read through orca and the terminal brought forward; git is not asked.
    assert.deepEqual(m.f.orcaCalls().map((call) => call.slice(0, 2).join(' ')), ['worktree list', 'terminal switch'])
    assert.deepEqual(m.f.gitCalls(), [])
    await m.worker.deactivate()
  }
  // A main working copy on no branch gives the epic no base: refused before the CLI is asked.
  const m = await launchMachine([], { base: null })
  const answer = await m.worker.request('spec.start', { project: HANDLE, root: m.f.root, target: { doc: 30 }, agent: 'claude' })
  assert.equal(answer.ok === false && answer.error.code, 'root_detached')
  assert.deepEqual(m.f.conportCalls(), [])
  assert.deepEqual(m.created(), [])
  assert.deepEqual(m.storage(), {})
  await m.worker.deactivate()
  // An agent that takes no task is refused before anything is read.
  const gemini = await launchMachine()
  const refused = await gemini.worker.request('spec.start', { project: HANDLE, root: gemini.f.root, target: { doc: 30 }, agent: 'gemini' })
  assert.equal(refused.ok === false && refused.error.code, 'agent_cannot_prepare')
  assert.deepEqual([gemini.f.conportCalls(), gemini.f.orcaCalls()], [[], []])
  await gemini.worker.deactivate()
})

test('proposal.decline passes the reason; an empty reason is reason_missing, the CLI not run', async () => {
  const m = await launchMachine([{ match: 'proposal decline ', stdout: json({ doc: 301, state: 'declined' }) }])
  const declined = await m.worker.request('proposal.decline', { project: HANDLE, root: m.f.root, doc: 301, reason: '  Out of scope this year \n' })
  assert.deepEqual(declined, { ok: true, data: null })
  assert.deepEqual(m.f.conportCalls(), [proposalDeclineArgs({ doc: 301, project: HANDLE, reason: 'Out of scope this year' })])
  // No agent is started for a decline, and nothing is remembered.
  assert.deepEqual(m.created(), [])
  assert.deepEqual(m.storage(), {})
  const error = { code: 'reason_missing', message: 'No reason is given', action: 'Write why the proposal is declined.' }
  for (const reason of ['', '   ', '\n', undefined, 7]) {
    const answer = await m.worker.request('proposal.decline', { project: HANDLE, root: m.f.root, doc: 301, reason: reason as string })
    assert.deepEqual(answer, { ok: false, error }, JSON.stringify(reason))
  }
  assert.equal(m.f.conportCalls().length, 1)
  assert.deepEqual(refusalText(error), { what: error.message, action: error.action })
  await m.worker.deactivate()
  // A refusal of the CLI is said in the panel's words.
  for (const refusal of [PROPOSAL_CLOSED, NOT_A_PROPOSAL, PROPOSAL_ACCEPTED]) {
    const closed = await launchMachine([refusedAs('proposal decline ', refusal.code)])
    const answer = await closed.worker.request('proposal.decline', { project: HANDLE, root: closed.f.root, doc: 301, reason: 'No' })
    assert.deepEqual(answer, { ok: false, error: refusal })
    await closed.worker.deactivate()
  }
})

interface RowCase {
  storage?: Record<string, unknown>
  /** The terminals orca lists in the root; left out, the root is not answered. */
  root?: unknown[]
  /** The terminals of a working copy on `epic-<epic>`; left out, there is no such copy. `refused`: orca refuses to list them. */
  copy?: { epic: number; terminals: unknown[]; refused?: true }
  project?: string
  request?: 'row.session' | 'terminal.show'
}

/** Asks for the terminal of `row`; the answer and what orca was asked for. */
async function rowRequest(row: RowRef, options: RowCase = {}) {
  const copyPath = (dir: string, epic: number): string => join(dir, 'elsewhere', `epic-${epic}`)
  const copy = options.copy
  const f = fake([], ({ dir, root }) => [
    worktreeList(root, [worktreeRow(root, 'main', true), ...(copy ? [worktreeRow(copyPath(dir, copy.epic), `epic-${copy.epic}`)] : [])]),
    ...(copy
      ? [
          copy.refused
            ? { match: `terminal list --worktree path:${copyPath(dir, copy.epic)} `, code: 1, stdout: json(UNAVAILABLE) }
            : terminalList(copyPath(dir, copy.epic), copy.terminals)
        ]
      : []),
    ...(options.root ? [terminalList(root, options.root)] : []),
    { match: 'terminal switch --terminal ', stdout: json({ ok: true, result: {} }) }
  ])
  const host = f.host({}, options.storage)
  const worker = await mountWorker(f.worker, { host })
  const target = { project: options.project ?? HANDLE, root: f.root, row }
  const answer: unknown =
    options.request === 'terminal.show' ? await worker.request('terminal.show', target) : await worker.request('row.session', target)
  await worker.deactivate()
  return {
    answer,
    orca: f.orcaCalls().map((call) => call.slice(0, 2).join(' ')),
    switched: f.orcaCalls().filter((call) => call[0] === 'terminal' && call[1] === 'switch').map((call) => call[3]),
    conport: f.conportCalls(),
    storage: host.data().storage as Record<string, unknown>
  }
}

const IDEA_41: RowRef = { kind: 'idea', id: 41 }

test('row.session of an idea finds its remembered terminal while an agent runs in it', async () => {
  const storage = { [`session:${HANDLE}:task-41`]: { terminal: 'term-idea' } }
  const live = await rowRequest(IDEA_41, { storage, root: [shell('term-a'), agent('term-idea')] })
  assert.deepEqual(live.answer, { ok: true, data: { terminal: 'term-idea' } })
  // Only the root is looked at, and ConPort is not asked.
  assert.deepEqual(live.orca, ['terminal list'])
  assert.deepEqual(live.conport, [])
  // The agent left the terminal: no session, and another agent in the root is not taken for it.
  const left = await rowRequest(IDEA_41, { storage, root: [shell('term-idea'), agent('term-other')] })
  assert.deepEqual(left.answer, { ok: true, data: { terminal: null } })
  // A terminal orca no longer lists is no session either.
  const gone = await rowRequest(IDEA_41, { storage, root: [agent('term-other')] })
  assert.deepEqual(gone.answer, { ok: true, data: { terminal: null } })
  // Nothing remembered: nothing to look for, orca is not asked.
  const none = await rowRequest(IDEA_41, { root: [agent('term-idea')] })
  assert.deepEqual(none.answer, { ok: true, data: { terminal: null } })
  assert.deepEqual(none.orca, [])
  // A task outside SDD and a spec read their own keys.
  const task = await rowRequest({ kind: 'task', id: 41 }, { storage, root: [agent('term-idea')] })
  assert.deepEqual(task.answer, { ok: true, data: { terminal: 'term-idea' } })
  const ofSpec = { [`session:${HANDLE}:${doc(30)}`]: { terminal: 'term-spec' }, ...storage }
  const spec = await rowRequest({ kind: 'spec', doc: 30, idea: null }, { storage: ofSpec, root: [agent('term-idea'), agent('term-spec')] })
  assert.deepEqual(spec.answer, { ok: true, data: { terminal: 'term-spec' } })
  const otherDoc = await rowRequest({ kind: 'spec', doc: 31, idea: null }, { storage, root: [agent('term-idea')] })
  assert.deepEqual(otherDoc.answer, { ok: true, data: { terminal: null } })
  // The records are kept under the handle: a name is refused before orca is asked.
  const byName = await rowRequest(IDEA_41, { storage, root: [agent('term-idea')], project: 'shop-api' })
  assert.deepEqual(byName.answer, { ok: false, error: NOT_HANDLE })
  assert.deepEqual(byName.orca, [])
})

test('an epic made from an idea inherits the terminal of its spec or its idea', async () => {
  const epic: RowRef = { kind: 'epic', id: 15, spec: 20, idea: 5 }
  const ofIdea = { [`session:${HANDLE}:task-5`]: { terminal: 'term-idea' } }
  const ofSpec = { [`session:${HANDLE}:${doc(20)}`]: { terminal: 'term-spec' } }
  // The idea's session went on through the spec and the plan into the epic.
  const fromIdea = await rowRequest(epic, { storage: ofIdea, root: [shell('term-a'), agent('term-idea')] })
  assert.deepEqual(fromIdea.answer, { ok: true, data: { terminal: 'term-idea' } })
  // The terminal of its spec comes before the one of its idea.
  const both = { ...ofIdea, ...ofSpec }
  const fromSpec = await rowRequest(epic, { storage: both, root: [agent('term-idea'), agent('term-spec')] })
  assert.deepEqual(fromSpec.answer, { ok: true, data: { terminal: 'term-spec' } })
  // The agent left the spec's terminal: the idea's is taken.
  const specLeft = await rowRequest(epic, { storage: both, root: [shell('term-spec'), agent('term-idea')] })
  assert.deepEqual(specLeft.answer, { ok: true, data: { terminal: 'term-idea' } })
  // The epic's own session comes first: its working copy with an agent in it.
  const own = await rowRequest(epic, {
    storage: { ...both, [`session:${HANDLE}:15`]: { terminal: 'term-epic' } },
    copy: { epic: 15, terminals: [agent('term-epic')] },
    root: [agent('term-spec'), agent('term-idea')]
  })
  assert.deepEqual(own.answer, { ok: true, data: { terminal: 'term-epic' } })
  assert.deepEqual(own.orca, ['worktree list', 'terminal list'])
  // An epic that names no spec or idea it was made from: only its own session counts.
  const plain = await rowRequest({ kind: 'epic', id: 15, spec: null, idea: null }, { storage: both, root: [agent('term-spec'), agent('term-idea')] })
  assert.deepEqual(plain.answer, { ok: true, data: { terminal: null } })
  assert.deepEqual(plain.orca, ['worktree list'])
  // A spec or an idea of another epic lends it nothing.
  const other = await rowRequest({ kind: 'epic', id: 15, spec: 21, idea: 6 }, { storage: both, root: [agent('term-spec'), agent('term-idea')] })
  assert.deepEqual(other.answer, { ok: true, data: { terminal: null } })
})

test('a spec document inherits the terminal of its idea', async () => {
  // The brainstorm of idea 6 wrote spec 30 and, on yes, goes on to its plan in the same terminal.
  const ofIdea = { [`session:${HANDLE}:task-6`]: { terminal: 'term-idea' } }
  const spec: RowRef = { kind: 'spec', doc: 30, idea: 6 }
  const inherited = await rowRequest(spec, { storage: ofIdea, root: [shell('term-a'), agent('term-idea')] })
  assert.deepEqual(inherited.answer, { ok: true, data: { terminal: 'term-idea' } })
  assert.deepEqual(inherited.conport, [])
  // Its own terminal comes first.
  const both = { ...ofIdea, [`session:${HANDLE}:${doc(30)}`]: { terminal: 'term-spec' } }
  const own = await rowRequest(spec, { storage: both, root: [agent('term-idea'), agent('term-spec')] })
  assert.deepEqual(own.answer, { ok: true, data: { terminal: 'term-spec' } })
  // The agent left the idea's terminal: no session.
  const left = await rowRequest(spec, { storage: ofIdea, root: [shell('term-idea')] })
  assert.deepEqual(left.answer, { ok: true, data: { terminal: null } })
  // A spec that clarifies no idea, or another one, lends nothing.
  for (const idea of [null, 7]) {
    const none = await rowRequest({ kind: 'spec', doc: 30, idea }, { storage: ofIdea, root: [agent('term-idea')] })
    assert.deepEqual(none.answer, { ok: true, data: { terminal: null } }, String(idea))
  }
})

test('Plan & build of an epic keeps its terminal once the copy epic-N exists', async () => {
  // spec.start of epic 9 opened the plan's terminal in the root and kept it under plan-9.
  const m = await launchMachine()
  const started = await m.worker.request('spec.start', { project: HANDLE, root: m.f.root, target: { epic: 9 }, agent: 'claude' })
  assert.deepEqual(started, { ok: true, data: { terminal: 'term-1' } })
  const storage = m.storage()
  await m.worker.deactivate()
  const epic: RowRef = { kind: 'epic', id: 9, spec: 22, idea: null }
  // The lead session cut the copy epic-9 and still works in the root: no agent in the copy.
  const withCopy = await rowRequest(epic, { storage, copy: { epic: 9, terminals: [shell('term-copy')] }, root: [agent('term-1')] })
  assert.deepEqual(withCopy.answer, { ok: true, data: { terminal: 'term-1' } })
  // Orca refuses to list the copy's terminals: the inherited terminal is found all the same.
  const refused = await rowRequest(epic, { storage, copy: { epic: 9, terminals: [], refused: true }, root: [agent('term-1')] })
  assert.deepEqual(refused.answer, { ok: true, data: { terminal: 'term-1' } })
  // With none of the inherited terminals live, the refusal is answered.
  const gone = await rowRequest(epic, { storage, copy: { epic: 9, terminals: [], refused: true }, root: [shell('term-1')] })
  assert.equal(gone.answer !== null && typeof gone.answer === 'object' && 'ok' in gone.answer && gone.answer.ok, false)
  // An agent of the epic in its copy is its own session, and comes first.
  const own = await rowRequest(epic, { storage, copy: { epic: 9, terminals: [agent('term-epic')] }, root: [agent('term-1')] })
  assert.deepEqual(own.answer, { ok: true, data: { terminal: 'term-epic' } })
})

test('the launcher of an earlier release is read once from prepare:<project> and moved to launcher:<project>', async () => {
  const f = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
  const host = f.host({ 'agents.list': { agents: [] } }, { [`prepare:${HANDLE}`]: 'codex', 'prepare:prother000': 'cursor' })
  const worker = await mountWorker(f.worker, { host })
  const launcherOf = async (): Promise<unknown> => {
    const answer = await worker.request('agents.get', { project: HANDLE, root: f.root })
    return answer.ok ? answer.data.launcher : answer.error
  }
  assert.equal(await launcherOf(), 'codex')
  // Moved: the new key holds it, the old one is gone; another project is left until it is read.
  assert.deepEqual(host.data().storage, { [`launcher:${HANDLE}`]: 'codex', 'prepare:prother000': 'cursor' })
  assert.equal(await launcherOf(), 'codex')
  assert.deepEqual(host.data().storage, { [`launcher:${HANDLE}`]: 'codex', 'prepare:prother000': 'cursor' })
  await worker.deactivate()
  // A launcher already there wins over the old record, which is dropped all the same; a broken old record moves nothing.
  const cases: Array<[Record<string, unknown>, unknown, Record<string, unknown>]> = [
    [{ [`launcher:${HANDLE}`]: 'claude', [`prepare:${HANDLE}`]: 'codex' }, 'claude', { [`launcher:${HANDLE}`]: 'claude' }],
    [{ [`prepare:${HANDLE}`]: 7 }, null, {}],
    [{ [`prepare:${HANDLE}`]: '' }, null, {}]
  ]
  for (const [storage, launcher, after] of cases) {
    const g = fake([{ match: 'epic agents', stdout: json(AGENTS) }])
    const h = g.host({ 'agents.list': { agents: [] } }, storage)
    const w = await mountWorker(g.worker, { host: h })
    const answer = await w.request('agents.get', { project: HANDLE, root: g.root })
    assert.equal(answer.ok && answer.data.launcher, launcher, JSON.stringify(storage))
    assert.deepEqual(h.data().storage, after, JSON.stringify(storage))
    await w.deactivate()
  }
})

test('terminal.show brings the terminal of any row forward; a row without one is session_gone', async () => {
  const storage = {
    [`session:${HANDLE}:task-41`]: { terminal: 'term-idea' },
    [`session:${HANDLE}:task-51`]: { terminal: 'term-task' },
    [`session:${HANDLE}:${doc(30)}`]: { terminal: 'term-spec' }
  }
  const root = [agent('term-idea'), agent('term-task'), agent('term-spec')]
  const shown: Array<[RowRef, string]> = [
    [IDEA_41, 'term-idea'],
    [{ kind: 'task', id: 51 }, 'term-task'],
    [{ kind: 'spec', doc: 30, idea: null }, 'term-spec'],
    // A spec document comes to the terminal of the idea it clarifies.
    [{ kind: 'spec', doc: 32, idea: 41 }, 'term-idea'],
    // An epic made from the idea comes to the terminal of its idea.
    [{ kind: 'epic', id: 15, spec: null, idea: 41 }, 'term-idea']
  ]
  for (const [row, terminal] of shown) {
    const asked = await rowRequest(row, { storage, root, request: 'terminal.show' })
    assert.deepEqual(asked.answer, { ok: true, data: null }, JSON.stringify(row))
    assert.deepEqual(asked.switched, [terminal], JSON.stringify(row))
    // What is shown was found anew; nothing is stored by showing it.
    assert.deepEqual(asked.storage, storage)
  }
  const tail = 'has no live session: its terminal is closed or its agent has exited'
  const gone: Array<[RowRef, string]> = [
    [{ kind: 'idea', id: 43 }, `Task 43 ${tail}`],
    [{ kind: 'task', id: 52 }, `Task 52 ${tail}`],
    [{ kind: 'spec', doc: 31, idea: 43 }, `Spec ${doc(31)} ${tail}`],
    [{ kind: 'epic', id: 15, spec: 31, idea: 43 }, `Epic 15 ${tail}`],
    // A terminal whose agent left is not brought forward.
    [{ kind: 'idea', id: 44 }, `Task 44 ${tail}`]
  ]
  const left = { ...storage, [`session:${HANDLE}:task-44`]: { terminal: 'term-left' } }
  for (const [row, message] of gone) {
    const asked = await rowRequest(row, { storage: left, root: [...root, shell('term-left')], request: 'terminal.show' })
    const error = { code: 'session_gone', message, action: 'Press Refresh.' }
    assert.deepEqual(asked.answer, { ok: false, error }, JSON.stringify(row))
    assert.deepEqual(asked.switched, [])
    assert.deepEqual(refusalText(error), { what: message, action: 'Press Refresh.' })
  }
})

test("not_an_idea, idea_taken, no_spec, spec_planned are said in the panel's words", async () => {
  const ideaCases: Array<[string, string]> = [
    ['not_an_idea', 'Task 41 is not an idea: it is an epic or a task of an epic'],
    ['idea_taken', 'Task 41 is past brainstorming: it is in review, blocked or closed'],
    ['task_not_found', 'Task 41 is not in the project']
  ]
  for (const [code, message] of ideaCases) {
    const m = await launchMachine([promptRefused('idea', code)])
    const answer = await m.worker.request('idea.start', { project: HANDLE, root: m.f.root, task: 41, agent: 'claude' })
    const error = { code, message, action: 'Press Refresh.' }
    assert.deepEqual(answer, { ok: false, error }, code)
    assert.deepEqual(refusalText(error), { what: message, action: error.action })
    assert.deepEqual(m.created(), [])
    assert.deepEqual(m.storage(), {})
    await m.worker.deactivate()
  }
  const specCases: Array<[{ doc: number } | { epic: number }, string, string]> = [
    [{ doc: 30 }, 'no_spec', `Document ${doc(30)} is not a spec`],
    [{ epic: 9 }, 'no_spec', 'Epic 9 has no spec'],
    [{ doc: 30 }, 'spec_planned', `Spec ${doc(30)} already has its plan: its epic is In work`],
    [{ epic: 9 }, 'spec_planned', 'Epic 9 already has its plan: it is In work'],
    [{ epic: 99 }, 'task_not_found', 'Epic 99 is not in the project']
  ]
  for (const [target, code, message] of specCases) {
    const m = await launchMachine([promptRefused('spec', code)])
    const answer = await m.worker.request('spec.start', { project: HANDLE, root: m.f.root, target, agent: 'claude' })
    const error = { code, message, action: 'Press Refresh.' }
    assert.deepEqual(answer, { ok: false, error }, `${code} ${JSON.stringify(target)}`)
    assert.deepEqual(refusalText(error), { what: message, action: error.action })
    assert.deepEqual(m.created(), [])
    assert.deepEqual(m.storage(), {})
    await m.worker.deactivate()
  }
  // A code that is not about an idea or a spec reaches the panel as the CLI gave it.
  const m = await launchMachine([promptRefused('idea', 'epic_ready')])
  const answer = await m.worker.request('idea.start', { project: HANDLE, root: m.f.root, task: 41, agent: 'claude' })
  assert.deepEqual(answer, { ok: false, error: { code: 'epic_ready', message: 'epic ready, as the CLI words it', action: 'do what the CLI says' } })
  await m.worker.deactivate()
})

test('epic.start, epic.session, epic.tasks, task.hand answer as before', async () => {
  const machine = await startMachine({
    orca: [
      SWITCHED,
      { match: 'terminal list --worktree path:', stdout: json({ ok: true, result: { terminals: [agent(EPIC_TERMINAL)], truncated: false } }) }
    ],
    conport: [{ match: 'api tasks list', stdout: json({ tasks: EPIC_TASKS, total: EPIC_TASKS.length }) }]
  })
  const { f, worker } = machine
  const epic = { project: HANDLE, root: f.root, epic: 7 }
  const started = await startOn(machine, { harness: 'claude' })
  assert.deepEqual(started.answer, { ok: true, data: { terminal: EPIC_TERMINAL, worktree: copyOf(f.root, 7) } })
  const state = await worker.request('epic.session', epic)
  assert.deepEqual(state.ok && { harness: state.data.harness, alive: state.data.alive, terminal: state.data.terminal }, {
    harness: 'claude',
    alive: true,
    terminal: EPIC_TERMINAL
  })
  const tasks = await worker.request('epic.tasks', epic)
  assert.equal(tasks.ok && tasks.data.length, EPIC_TASKS.length)
  await worker.deactivate()
  // A task handed answers its terminal as before, and its row finds that terminal later.
  const handed = await hand(51, 'do', 'codex', [], HANDLE)
  assert.deepEqual(handed.answer, { ok: true, data: { terminal: 'term-1' } })
  assert.deepEqual(handed.storage, { [`launcher:${HANDLE}`]: 'codex', [`session:${HANDLE}:task-51`]: { terminal: 'term-1' } })
})
