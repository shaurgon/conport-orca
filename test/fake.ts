// Wires a worker to the fake `conport` and `orca` executables (test/fake-cli.mjs).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mockHost } from 'orca/testing'
import { createWorker } from '../src/worker'

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs')

export interface FakeAnswer {
  /** The start of the joined args this answer is for, e.g. `epic status 7`. */
  match: string
  code?: number
  stdout?: string
  stderr?: string
}

export interface Fake {
  /** A temporary folder standing in for the main working tree of the repository. */
  root: string
  /** The worktree of that repository the person has in focus in Orca. */
  focused: string
  /** The repository the plugin itself was installed from: what `active` names from its folder. */
  pluginRepo: string
  /**
   * A host whose focused workspace is `focused`, listing it among other workspaces of Orca,
   * the repository root included; `results` add to or replace its answers.
   */
  host(results?: Record<string, unknown>): ReturnType<typeof mockHost>
  /** The worker module to pass to `mountWorker`. */
  worker: { default: (orca: never) => void; deactivate: () => void }
  /** The args each call of the fake conport received, in order. */
  conportCalls(): string[][]
  orcaCalls(): string[][]
}

/**
 * The fake orca answers of a machine where `focused` is a worktree of `root`. Asked for
 * `active`, orca answers as it does from the worker's own folder: with the repository the
 * plugin was installed from, not the one in focus.
 */
function orcaRepo(root: string, focused: string, pluginRepo: string): FakeAnswer[] {
  const show = (path: string, repoId: string) =>
    JSON.stringify({ ok: true, result: { worktree: { path, repoId } } })
  const repos = [{ id: 'repo-focus', displayName: 'repo', path: root, kind: 'git' }]
  return [
    { match: 'repo list ', stdout: JSON.stringify({ ok: true, result: { repos } }) },
    { match: `worktree show --worktree path:${focused} `, stdout: show(focused, 'repo-focus') },
    { match: 'worktree show --worktree active ', stdout: show(pluginRepo, 'repo-plugin') }
  ]
}

export function json(value: unknown): FakeAnswer['stdout'] {
  return JSON.stringify(value)
}

/** Waits until `ready()` holds, checking every few milliseconds; fails after `limitMs`. */
export async function until(ready: () => boolean, limitMs = 3_000): Promise<void> {
  const deadline = Date.now() + limitMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the condition did not come true in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The folders of a fake machine, for answers that name them. */
export interface FakeDirs {
  /** A temporary folder for anything else the test needs. */
  dir: string
  root: string
  focused: string
}

export function fake(
  conport: FakeAnswer[],
  orca?: FakeAnswer[] | ((dirs: FakeDirs) => FakeAnswer[])
): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'conport-orca-'))
  const root = join(dir, 'repo')
  const focused = join(root, '.wt', 'feature')
  const pluginRepo = join(dir, 'plugin')
  mkdirSync(root)
  mkdirSync(pluginRepo)
  const scenario = (name: string, answers: FakeAnswer[]): string => {
    const file = join(dir, `${name}.json`)
    writeFileSync(file, JSON.stringify({ log: join(dir, `${name}.log`), answers }))
    writeFileSync(join(dir, `${name}.log`), '')
    return file
  }
  const calls = (name: string): string[][] =>
    readFileSync(join(dir, `${name}.log`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  const { activate, deactivate } = createWorker({
    conport: [process.execPath, FAKE_CLI, scenario('conport', conport)],
    orca: [
      process.execPath,
      FAKE_CLI,
      scenario('orca', [
        ...(typeof orca === 'function' ? orca({ dir, root, focused }) : (orca ?? [])),
        ...orcaRepo(root, focused, pluginRepo)
      ])
    ]
  })
  const workspaces = [
    { id: 'ws-elsewhere', kind: 'worktree', name: 'feature', path: join(dir, 'other', 'feature'), branch: 'hotfix', hostId: null },
    { id: 'ws-focus', kind: 'worktree', name: 'feature', path: focused, branch: 'feature', hostId: null },
    { id: 'ws-root', kind: 'worktree', name: 'repo', path: root, branch: 'main', hostId: null }
  ]
  const host = (results: Record<string, unknown> = {}) =>
    mockHost({
      results: {
        'workspace.readContext': { branch: 'feature', displayName: 'feature', terminals: [] },
        'workspace.list': { workspaces, truncated: false },
        'terminal.create': { terminalId: 'term-1' },
        ...results
      }
    })
  return {
    root,
    focused,
    pluginRepo,
    host,
    worker: { default: activate, deactivate },
    conportCalls: () => calls('conport'),
    orcaCalls: () => calls('orca')
  }
}
