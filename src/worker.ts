// The plugin's worker: runs the conport CLI and orca as child processes for the panel. It reads
// only when the panel asks: no timer, no status bar item, no notification — the state of the
// agents is Orca's own.
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  CONPORT,
  commandLine,
  DEFAULT_ROLES,
  epicPromptArgs,
  HANDLE_FORM,
  interpret,
  PREPARE_AGENTS,
  preparePromptArgs,
  ROLE_TYPE_FORM,
  taskPromptArgs
} from './cli'
import { runProcess } from './exec'
import type {
  AgentKind,
  EpicList,
  EpicSession,
  EpicTask,
  OrcaProject,
  RepoContext,
  Result,
  Roles,
  SubagentList,
  TaskList,
  Way
} from './protocol'
import { readSettings, type SettingsText } from './settings'
import { AGENT_MISSING_ACTION, HARNESS_MISSING_ACTION, type PromptSubject, promptRefusal, REFUSED } from './text'

/** How the worker starts the three programs it drives. */
export interface WorkerDeps {
  conport: readonly string[]
  orca: readonly string[]
  git: readonly string[]
  /** The user env file of the conport CLI; by default `<XDG_CONFIG_HOME | ~/.config>/conport/.env`. */
  userEnv?: string
  /** How long git may take to say anything about the settings; by default GIT_TIMEOUT_MS. */
  gitTimeoutMs?: number
}

/** A working copy of a repository, as `orca worktree list` names it. */
interface WorktreeRow {
  path: string
  /** The branch it is on, without `refs/heads/`; null when it is on none. */
  branch: string | null
}

const TRUNCATED = (): { ok: false; error: { code: string; message: string; action: string } } =>
  fail('workspaces_truncated', 'Orca returned an incomplete list of workspaces', 'Remove the workspaces you do not need from Orca and try again.')

/** More rows than a repository has working copies: `orca worktree list` is asked for all of them. */
const WORKTREE_LIMIT = 10_000

/** More rows than a workspace has terminals: `orca terminal list` is asked for all of them. */
const TERMINAL_LIMIT = 10_000

/** How many tasks of an epic one call of `conport api tasks list` is asked for. */
const TASKS_PAGE = 200

/** The list of working copies did not fit even so: nothing is decided on a part of it. */
const COPIES_TRUNCATED = (): { ok: false; error: { code: string; message: string; action: string } } =>
  fail(
    'workspaces_truncated',
    `The repository's working copies did not fit in Orca's answer: there are more than ${WORKTREE_LIMIT}`,
    'Delete the working copies you do not need in Orca and try again.'
  )

const normalize = (path: string): string => path.replace(/\/+$/, '')
const branchName = (branch: string | null): string => (branch ?? '').replace(/^refs\/heads\//, '')

const fail = (code: string, message: string, action = ''): { ok: false; error: { code: string; message: string; action: string } } => ({
  ok: false,
  error: { code, message, action }
})

/** An answer with its data; `ok: true` stays a literal, as Result needs, inside a handler too. */
const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data })

/** A refusal the worker words itself, by its code and its text of `text.ts`. */
const refuse = (code: string, { what, action }: { what: string; action: string }) => fail(code, what, action)

const FORBID_VAR = 'CONPORT_SETTINGS_FORBID_ROOT'

/** How long git may take to say anything about the settings files, as every reader of them waits. */
export const GIT_TIMEOUT_MS = 5000

/** The user env file of the conport CLI: `<XDG_CONFIG_HOME | <home>/.config>/conport/.env`. */
export function userEnvFile(env: Record<string, string | undefined>, home: string): string {
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(config, 'conport', '.env')
}

/** The text of a file, null when there is none, its error code when it is there but cannot be read. */
async function readText(file: string): Promise<SettingsText> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    return { error: code ?? 'EIO' }
  }
}

/** A path with its links resolved, as far as it exists. */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolvePath(path)
  }
}

/**
 * With CONPORT_SETTINGS_FORBID_ROOT set, a root inside that path throws: a test must not read
 * the settings of the repository it runs in.
 */
async function guardRoot(root: string): Promise<void> {
  const forbid = process.env[FORBID_VAR]
  if (!forbid) return
  const [banned, real] = await Promise.all([realPath(forbid), realPath(root)])
  if (real === banned || real.startsWith(banned.endsWith(sep) ? banned : banned + sep)) {
    throw new Error(`settings root ${root} is inside ${FORBID_VAR}: run the test in a temporary folder`)
  }
}

/** CONPORT_PROJECT_NAME from `.claude/settings.local.json` of the repository's main working tree. */
async function repositoryProject(root: string): Promise<string | null> {
  try {
    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')) as {
      env?: Record<string, unknown>
    }
    const value = settings.env?.CONPORT_PROJECT_NAME
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

export function createWorker(deps: WorkerDeps): {
  activate: (orca: OrcaWorkerApi) => void
  deactivate: () => void
} {
  // Nothing outlives a request: there is nothing to stop.
  const deactivate = (): void => undefined

  const activate = (orca: OrcaWorkerApi): void => {
    const conport = async <T>(args: string[], cwd?: string): Promise<Result<T>> =>
      interpret('conport', await runProcess([...deps.conport, ...args], cwd), basename(deps.conport[0] ?? '')) as Result<T>

    /**
     * The task an agent is started with, as `conport prompt … --json` prints it. A refusal of an
     * epic, a task or an agent is told in the worker's own words, as when it finds the reason itself.
     */
    const promptText = async (args: string[], root: string, subject: PromptSubject): Promise<Result<string>> => {
      const answer = await conport<{ text?: unknown }>(args, root)
      if (!answer.ok) {
        const said = promptRefusal(answer.error.code, subject)
        return said ? refuse(answer.error.code, said) : answer
      }
      const { text } = answer.data
      if (typeof text !== 'string' || text === '') return fail('bad_output', "conport answered without the task's text", 'Update conport.')
      return ok(text)
    }

    /** An orca CLI call: its `result` on success. */
    const orcaCli = async <T>(args: string[]): Promise<Result<T>> => {
      const answer = interpret('orca', await runProcess([...deps.orca, ...args, '--json']), basename(deps.orca[0] ?? ''))
      if (!answer.ok) return answer
      const result = (answer.data as { result?: unknown }).result
      if (result === undefined) return fail('bad_output', 'orca answered without result', 'Update Orca.')
      return ok(result as T)
    }

    /**
     * Of several workspaces sharing the focused name, the one that holds a terminal of the
     * focus: the host names the focus's terminals by the handles orca lists per workspace.
     */
    const byTerminals = async (
      candidates: ReadonlyArray<{ path: string }>,
      focus: { displayName: string; terminals: ReadonlyArray<{ id: string }> }
    ): Promise<Result<string>> => {
      const ambiguous = fail(
        'workspace_ambiguous',
        `Orca has several workspaces named “${focus.displayName}” and cannot tell which one is in focus`,
        'Open a terminal in the right Orca workspace and try again.'
      )
      const focused = new Set(focus.terminals.map((t) => t.id))
      if (focused.size === 0) return ambiguous
      const matching: string[] = []
      let firstRefusal: Extract<Result<never>, { ok: false }> | null = null
      let listed = false
      for (const { path } of candidates) {
        const list = await orcaCli<{ terminals?: Array<{ handle: string }> }>(['terminal', 'list', '--worktree', `path:${path}`, '--limit', String(TERMINAL_LIMIT)])
        // A workspace orca cannot list does not match; only when none is listed is the refusal told.
        if (!list.ok) {
          firstRefusal ??= list
          continue
        }
        listed = true
        if ((list.data.terminals ?? []).some((t) => focused.has(t.handle))) matching.push(path)
      }
      if (!listed && firstRefusal) return firstRefusal
      const [match, ...more] = matching
      return match !== undefined && more.length === 0 ? ok(match) : ambiguous
    }

    /**
     * The path of the workspace in focus. The worker runs in its own folder, so orca's
     * `active` selector would name the plugin's folder: the host knows the focus.
     */
    const focusedPath = async (): Promise<Result<string>> => {
      const focus = await orca.host.call('workspace.readContext')
      if (focus === null) {
        return fail('no_workspace', 'Orca has no workspace in focus', 'Open a repository workspace.')
      }
      const { workspaces, truncated } = await orca.host.call('workspace.list')
      // The focus names no path: name and branch must point at one workspace, or nothing is picked.
      const named = workspaces.filter((w) => w.name === focus.displayName)
      const onBranch = named.filter((w) => branchName(w.branch) === branchName(focus.branch))
      const candidates = onBranch.length > 0 ? onBranch : named
      const [workspace, ...others] = candidates
      if (workspace && others.length === 0) return ok(workspace.path)
      if (workspace) return byTerminals(candidates, focus)
      if (truncated) return TRUNCATED()
      return fail('no_workspace', `The workspace “${focus.displayName}” is not in Orca's list`, 'Open a repository workspace.')
    }

    /** The id orca gives the repository of the workspace in focus. */
    const focusedRepoId = async (): Promise<Result<string>> => {
      const focused = await focusedPath()
      if (!focused.ok) return focused
      const shown = await orcaCli<{ worktree?: { repoId?: string } }>(['worktree', 'show', '--worktree', `path:${focused.data}`])
      if (!shown.ok) return shown
      const repoId = shown.data.worktree?.repoId
      if (!repoId) return fail('no_repository', 'The workspace in focus belongs to no repository', 'Open a repository workspace.')
      return ok(repoId)
    }

    /**
     * A call of git about the settings of `root`, bounded as every reader bounds it. Git is asked
     * in English (LC_ALL=C, no LANGUAGE): a git with translations would say "not a git repository"
     * in the person's language, and a folder outside git would read as a git failure.
     */
    const gitAbout = (root: string, args: string[]) =>
      runProcess([...deps.git, '-C', root, ...args], undefined, deps.gitTimeoutMs ?? GIT_TIMEOUT_MS, {
        ...process.env,
        LC_ALL: 'C',
        LANGUAGE: ''
      })

    /**
     * What git says of the repository at `root`: `main` — it has a main working tree, so its
     * settings files are read; `none` — a submodule or a worktree of a bare repository, whose common
     * git directory is not named `.git`: it has no main working tree and none of its files are
     * read; `outside` — not a git repository; `failed` — git could not tell.
     */
    const repositoryKind = async (root: string): Promise<{ kind: 'main' | 'none' | 'outside' } | { kind: 'failed'; line: string }> => {
      const answer = await gitAbout(root, ['rev-parse', '--show-toplevel', '--git-common-dir'])
      let error: string
      if (answer.failure !== undefined) {
        error = answer.failure
      } else if (answer.code !== 0) {
        error = answer.stderr.trim() || `exit code ${answer.code}`
        if (/not a git repository/i.test(error)) return { kind: 'outside' }
      } else {
        const [toplevel, commonDir] = answer.stdout.split(/\r?\n/).map((line) => line.trim())
        if (toplevel && commonDir) {
          const last = commonDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1)
          return { kind: last === '.git' ? 'main' : 'none' }
        }
        error = `unexpected answer of git rev-parse: ${answer.stdout.trim()}`
      }
      const first = error.split('\n').map((line) => line.trim()).find(Boolean) ?? 'unknown error'
      return { kind: 'failed', line: `git failed (${first}): ConPort settings were not read` }
    }

    /**
     * Whether git ignores the personal settings file in `root` and does not track it: true, false,
     * or null when git cannot tell.
     */
    const localIgnoredIn = async (root: string): Promise<boolean | null> => {
      const tracked = await gitAbout(root, ['ls-files', '--error-unmatch', '--', '.conport.local.json'])
      if (tracked.failure !== undefined) return null
      if (tracked.code === 0) return false
      if (tracked.code !== 1) return null
      const ignored = await gitAbout(root, ['check-ignore', '-q', '--', '.conport.local.json'])
      if (ignored.failure !== undefined) return null
      return ignored.code === 0 ? true : ignored.code === 1 ? false : null
    }

    /**
     * The settings of the repository at `root`, read by the rules every reader of them follows,
     * and whether its own files may name the project. No environment variable names the project
     * here: the plugin's process is Orca's. A git that fails names no project; a submodule or a
     * worktree of a bare repository reads none of its files.
     */
    const settingsOf = async (root: string): Promise<{ settings: ReturnType<typeof readSettings>; readsFiles: boolean }> => {
      await guardRoot(root)
      const [repository, userText] = await Promise.all([repositoryKind(root), readText(deps.userEnv ?? userEnvFile(process.env, homedir()))])
      const userEnv = typeof userText === 'string' ? userText : null
      const nothing = { shared: null, local: null, localIgnored: null, env: {}, explicit: null, userEnv }
      if (repository.kind === 'failed') {
        const settings = readSettings(nothing)
        return { settings: { ...settings, lines: [repository.line, ...settings.lines], blocked: true }, readsFiles: false }
      }
      if (repository.kind === 'none') return { settings: readSettings(nothing), readsFiles: false }
      const [shared, local] = await Promise.all([readText(join(root, '.conport.json')), readText(join(root, '.conport.local.json'))])
      // Git is asked about the personal file only when it is there; outside git nothing ignores it.
      const localIgnored = local === null || repository.kind === 'outside' ? null : await localIgnoredIn(root)
      return { settings: readSettings({ ...nothing, shared, local, localIgnored }), readsFiles: true }
    }

    /**
     * The project of the repository at `root`: from its settings files, then from the old place
     * (`.claude/settings.local.json`), then from the binding the panel remembered. A broken
     * settings file, or a git that fails, names none, and nothing stands in for it. A submodule or
     * a worktree of a bare repository has only the binding.
     */
    const contextOf = async (root: string): Promise<RepoContext> => {
      const { settings, readsFiles: filesRead } = await settingsOf(root)
      const { lines } = settings
      if (settings.project !== null) return { root, project: settings.project, source: 'file', lines, filesRead }
      if (settings.blocked) return { root, project: null, source: 'file', lines, filesRead }
      const fromRepository = filesRead ? await repositoryProject(root) : null
      if (fromRepository) return { root, project: fromRepository, source: 'repository', lines, filesRead }
      const stored = await orca.storage.get(`project:${root}`)
      if (typeof stored === 'string' && stored !== '') return { root, project: stored, source: 'stored', lines, filesRead }
      return { root, project: null, source: null, lines, filesRead }
    }

    /** A terminal in the repository root, which must be a workspace of Orca. */
    const terminalInRoot = async (root: string, title: string, command: string): Promise<Result<string>> => {
      const { workspaces, truncated } = await orca.host.call('workspace.list')
      const workspace = workspaces.find((w) => normalize(w.path) === normalize(root))
      if (!workspace) {
        if (truncated) return TRUNCATED()
        return fail('root_not_open', `The repository root ${root} is not open in Orca`, 'Add the repository to Orca.')
      }
      const { terminalId } = await orca.host.call('terminal.create', { workspaceId: workspace.id, title, command })
      return ok(terminalId)
    }

    /** A terminal orca opens in the working copy at `path`, by the handle orca lists it under. */
    const terminalIn = async (path: string, title: string, command: string): Promise<Result<string>> => {
      const created = await orcaCli<{ terminal?: { handle?: string } }>([
        'terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command
      ])
      if (!created.ok) return created
      const handle = created.data.terminal?.handle
      if (!handle) return fail('bad_output', 'orca opened a terminal and did not name it', 'Update Orca.')
      return ok(handle)
    }

    /**
     * What is left of an epic started before, read in one call of git: the branch `epic-<N>` of
     * the SDD skill, and the branches `epic<N>/…` the workflow cuts for its tasks.
     */
    const epicBranches = async (root: string, epic: number): Promise<Result<{ sdd: boolean; workflow: boolean }>> => {
      const own = `refs/heads/epic-${epic}`
      const tasks = `refs/heads/epic${epic}/`
      const listed = await runProcess([...deps.git, '-C', root, 'for-each-ref', '--format=%(refname)', own, `${tasks}*`])
      // A git that could not start is told as any program that could not.
      if (listed.failure !== undefined) return interpret('git', listed, basename(deps.git[0] ?? '')) as Result<never>
      if (listed.code !== 0) {
        // What git said, as it said it.
        const said = listed.stderr.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
        return fail('git_failed', said ?? `git: exit code ${listed.code}`, 'Check the repository with git status in its root and try again.')
      }
      const refs = listed.stdout.split('\n').map((line) => line.trim())
      // The pattern of the branch itself lists the branches under it too: only the exact name counts.
      return ok({ sdd: refs.includes(own), workflow: refs.some((ref) => ref.startsWith(tasks)) })
    }

    /**
     * The working copies of the repository at `root` and the branch its main working tree is on,
     * null when it is on none. `complete` is false when orca cut the list short.
     */
    const copiesOf = async (
      root: string
    ): Promise<Result<{ repoId: string; base: string | null; rows: WorktreeRow[]; complete: boolean }>> => {
      const listed = await orcaCli<{
        worktrees?: Array<{ repoId?: string; path?: string; branch?: string | null; isMainWorktree?: boolean }>
        truncated?: boolean
      }>(['worktree', 'list', '--repo', `path:${root}`, '--limit', String(WORKTREE_LIMIT)])
      if (!listed.ok) return listed
      const all = listed.data.worktrees ?? []
      const main = all.find((row) => row.isMainWorktree === true && normalize(row.path ?? '') === normalize(root))
      if (!main?.repoId) {
        if (listed.data.truncated) return COPIES_TRUNCATED()
        return fail('bad_output', "orca did not name the repository's main working copy", 'Update Orca.')
      }
      const base = branchName(main.branch ?? null) || null
      const rows = all
        .filter((row) => row.repoId === main.repoId && typeof row.path === 'string')
        .map((row) => ({ path: row.path as string, branch: branchName(row.branch ?? null) || null }))
      return ok({ repoId: main.repoId, base, rows, complete: listed.data.truncated !== true })
    }

    /** The working copies of the repository at `root`, with the base an epic is cut from: the start needs one. */
    const worktreesOf = async (
      root: string
    ): Promise<Result<{ repoId: string; base: string; rows: WorktreeRow[]; complete: boolean }>> => {
      const copies = await copiesOf(root)
      if (!copies.ok) return copies
      const { base } = copies.data
      if (base === null) {
        return fail('root_detached', "The repository's main working copy is not on a branch, so the epic has no base", 'Check out a branch in the main working copy.')
      }
      return ok({ ...copies.data, base })
    }

    /** The repository id of the focus, or null when neither the host nor orca can tell it. */
    const focusedRepo = async (): Promise<string | null> => {
      try {
        const focus = await focusedRepoId()
        return focus.ok ? focus.data : null
      } catch (error) {
        orca.log(`focus: ${String(error)}`)
        return null
      }
    }

    // Orca's projects in the order of its sidebar. The focus only marks one of them: a focus
    // nobody can tell (none, several workspaces of one name, the host failing) keeps no list away.
    orca.panels.handle('projects.list', async () => {
      const listed = await orcaCli<{ repos?: Array<{ id?: string; displayName?: string; path?: string; kind?: string }> }>([
        'repo',
        'list'
      ])
      if (!listed.ok) return listed
      const focus = await focusedRepo()
      const projects: OrcaProject[] = []
      for (const repo of listed.data.repos ?? []) {
        if (!repo.path) continue
        const kind = repo.kind === 'folder' ? 'folder' : 'git'
        // A folder cannot run an epic: its settings are not read.
        const context = kind === 'git' ? await contextOf(repo.path) : { root: repo.path, project: null, source: null, lines: [], filesRead: false }
        projects.push({
          ...context,
          name: repo.displayName || basename(normalize(repo.path)),
          kind,
          focused: focus !== null && repo.id === focus
        })
      }
      return ok(projects)
    })

    orca.panels.handle('project.set', async ({ root, project }) => {
      const value = project.trim()
      if (value === '') return fail('empty_project', 'No project is named', "Enter the project's name or handle.")
      await orca.storage.set(`project:${root}`, value)
      return ok(await contextOf(root))
    })

    orca.panels.handle('project.forget', async ({ root }) => {
      await orca.storage.delete(`project:${root}`)
      return ok(await contextOf(root))
    })

    orca.panels.handle('epics.list', ({ project, root }) =>
      conport(['epic', 'list', '--project', project, '--json'], root)
    )

    /** The agent kinds Orca runs in the focused workspace; none when the host cannot tell. */
    const kindsInOrca = async (): Promise<Set<string>> => {
      try {
        const { agents } = await orca.host.call('agents.list')
        return new Set(agents.flatMap((a) => (a.agent === null ? [] : [a.agent])))
      } catch (error) {
        orca.log(`agents.list: ${String(error)}`)
        return new Set()
      }
    }

    // The CLI looks for each command on the PATH of Orca's app, which is often not the PATH of a
    // terminal; a kind Orca runs is one a terminal of Orca can start, found or not.
    const agentKinds = async (root: string): Promise<Result<AgentKind[]>> => {
      const answer = await conport<{ agents: AgentKind[] }>(['epic', 'agents', '--json'], root)
      if (!answer.ok) return answer
      const inOrca = await kindsInOrca()
      return ok(answer.data.agents.map((a) => (a.found || !inOrca.has(a.id) ? a : { ...a, found: true })))
    }

    orca.panels.handle('agents.get', async ({ project, root }) => {
      const agents = await agentKinds(root)
      if (!agents.ok) return agents
      const preparer = await orca.storage.get(`prepare:${project}`)
      return ok({ agents: agents.data, preparer: typeof preparer === 'string' ? preparer : null })
    })

    /** Asks orca to bring a terminal to the front. */
    const switchTo = (terminal: string): Promise<Result<unknown>> => orcaCli(['terminal', 'switch', '--terminal', terminal])

    /**
     * Brings a terminal to the front. When orca cannot, the panel has already named the terminal:
     * the failure is only logged.
     */
    const bringForward = async (terminal: string): Promise<void> => {
      const shown = await switchTo(terminal)
      if (!shown.ok) orca.log(`terminal switch: ${shown.error.code}: ${shown.error.message}`)
    }

    /**
     * The command of an agent that can be told its task as its first argument and is found:
     * only such an agent starts a talk with the task it is given.
     */
    const agentCommand = async (root: string, agent: string, noun: 'agent' | 'harness' = 'agent'): Promise<Result<string>> => {
      if (!PREPARE_AGENTS.includes(agent)) return refuse('agent_cannot_prepare', REFUSED.agentCannotPrepare(noun, agent))
      const kinds = await agentKinds(root)
      if (!kinds.ok) return kinds
      const kind = kinds.data.find((a) => a.id === agent)
      if (!kind?.found) {
        return noun === 'agent'
          ? fail('agent_not_found', `Agent “${agent}” not found`, AGENT_MISSING_ACTION)
          : fail('agent_not_found', `Harness “${agent}” not found on this machine`, HARNESS_MISSING_ACTION)
      }
      return ok(kind.command)
    }

    /**
     * Opens `agent` with its one task in a terminal of the root. Nothing is remembered here: the
     * preparation of an epic and the hand of a task remember their agent themselves.
     */
    const startAgent = async (root: string, agent: string, title: string, task: string): Promise<Result<{ terminal: string }>> => {
      const command = await agentCommand(root, agent)
      if (!command.ok) return command
      const terminal = await terminalInRoot(root, title, commandLine([command.data, task]))
      if (!terminal.ok) return terminal
      // The person talks with the agent there: the terminal comes to the front.
      await bringForward(terminal.data)
      return ok({ terminal: terminal.data })
    }

    /** Remembers the agent of a preparation or of a hand for the project, once its terminal is open. */
    const rememberAgent = async <T>(project: string, agent: string, started: Result<T>): Promise<Result<T>> => {
      if (started.ok) await orca.storage.set(`prepare:${project}`, agent)
      return started
    }

    // An epic without a spec or a plan: its agent talks with the person in a terminal of the root.
    // The CLI reads the epic afresh and prints the task for what it lacks now, or refuses.
    orca.panels.handle('epic.prepare', async ({ project, root, epic, agent }) => {
      const task = await promptText(preparePromptArgs({ epic, project }), root, { command: 'prepare', epic })
      if (!task.ok) return task
      return rememberAgent(project, agent, await startAgent(root, agent, `conport prepare ${epic}`, task.data))
    })

    // An epic that has its spec and its plan: its harness gets the task of the epic in a terminal
    // and does the rest. The start reads the epic and the agent kinds, then asks `conport prompt`
    // for the task, and runs nothing else of ConPort: no check, no lock, no record of a run, no
    // file in the working copy.
    orca.panels.handle('epic.start', async ({ project, root, epic, way, harness, roles }) => {
      const list = await conport<EpicList>(['epic', 'list', '--project', project, '--json'], root)
      if (!list.ok) return list
      const found = list.data.epics.find((e) => e.id === epic)
      if (!found) return refuse('epic_not_found', REFUSED.epicNotFound(epic))
      if (!found.runnable) return refuse('epic_not_ready', REFUSED.epicNotReady(epic))
      if (way === 'workflow' && harness !== 'claude') return refuse('way_needs_claude', REFUSED.wayNeedsClaude)
      const roleInvalid = refuse('role_invalid', REFUSED.roleInvalid)
      // A request that names no roles has nothing to remember for the epic, whichever the way.
      if (typeof roles !== 'object' || roles === null) return roleInvalid
      // Only Claude Code by the SDD skill is told the types: there they reach the task and the command line.
      const types: unknown[] = [roles.implementer, roles.reviewer, roles.gapHunter, roles.finalReviewer]
      if (way === 'sdd' && harness === 'claude' && !types.every((type) => typeof type === 'string' && ROLE_TYPE_FORM.test(type))) {
        return roleInvalid
      }
      const command = await agentCommand(root, harness, 'harness')
      if (!command.ok) return command

      // An epic begun one way is not taken over by the other: their branches do not meet.
      const branches = await epicBranches(root, epic)
      if (!branches.ok) return branches
      if (way === 'sdd' && branches.data.workflow) {
        return fail('epic_started_workflow', `The SDD skill is chosen, but branches epic${epic}/… are there already: the epic was started by the workflow`, 'Choose the /conport:epic mode.')
      }
      if (way === 'workflow' && branches.data.sdd) {
        return fail('epic_started_sdd', `The workflow is chosen, but the branch epic-${epic} is there already: the epic was started by the SDD skill`, 'Choose the SDD skill mode.')
      }

      const trees = await worktreesOf(root)
      if (!trees.ok) return trees
      const handle = list.data.project
      let worktree: string | null = null
      if (way === 'sdd') {
        const branch = `epic-${epic}`
        // A copy that is there is taken as it is: nothing in it is read.
        worktree = trees.data.rows.find((row) => row.branch === branch)?.path ?? null
        if (worktree === null) {
          // The copy may be among the rows cut off: none is created on a part of the list.
          if (!trees.data.complete) return COPIES_TRUNCATED()
          if (branches.data.sdd) {
            return fail('epic_branch_taken', `The branch ${branch} is there, but it has no working copy`, 'Open the branch as a workspace in Orca.')
          }
          // No `--setup`: the setting of the repository in Orca decides.
          const created = await orcaCli<{ worktree?: { path?: string } }>([
            'worktree', 'create', '--repo', `id:${trees.data.repoId}`, '--name', branch, '--branch', branch,
            '--base-branch', trees.data.base, '--no-parent'
          ])
          if (!created.ok) return created
          worktree = created.data.worktree?.path ?? null
          if (worktree === null) return fail('bad_output', 'orca created a working copy and did not name its path', 'Update Orca.')
        }
      }
      // The CLI checks the epic again, now that the place of the work is known.
      const args =
        worktree === null
          ? epicPromptArgs({ epic, project: handle, harness, root, base: trees.data.base, way: 'workflow' })
          : epicPromptArgs({ epic, project: handle, harness, worktree, base: trees.data.base, roles })
      const task = await promptText(args, root, { command: 'epic', epic, harness })
      if (!task.ok) return task
      const title = `conport epic ${epic} · ${way === 'sdd' ? 'SDD' : 'workflow'}`
      const terminal = await terminalIn(worktree ?? root, title, commandLine([command.data, task.data]))
      if (!terminal.ok) return terminal
      // The person talks with the harness there: the terminal comes to the front.
      await bringForward(terminal.data)
      await orca.storage.set(`harness:${handle}:${epic}`, harness)
      await orca.storage.set(`roles:${handle}:${epic}`, { ...roles })
      await orca.storage.set(`way:${handle}:${epic}`, way)
      await orca.storage.set(`session:${handle}:${epic}`, { terminal: terminal.data, way })
      await orca.storage.set(`harness:${handle}`, harness)
      return ok({ terminal: terminal.data, way, worktree })
    })

    /** What a start of the epic remembered, or the default where it remembered nothing. */
    const chosenFor = async (project: string, epic: number): Promise<{ way: Way; harness: string; roles: Roles; terminal: string | null }> => {
      const name = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
      const [way, harness, lastHarness, roles, session] = await Promise.all([
        orca.storage.get(`way:${project}:${epic}`),
        orca.storage.get(`harness:${project}:${epic}`),
        orca.storage.get(`harness:${project}`),
        orca.storage.get(`roles:${project}:${epic}`),
        orca.storage.get(`session:${project}:${epic}`)
      ])
      const types = (roles ?? {}) as Partial<Record<keyof Roles, unknown>>
      const stored = {
        implementer: name(types.implementer),
        reviewer: name(types.reviewer),
        gapHunter: name(types.gapHunter),
        finalReviewer: name(types.finalReviewer)
      }
      const whole = Object.values(stored).every((type) => type !== null)
      return {
        way: way === 'workflow' ? 'workflow' : 'sdd',
        // A new epic takes the harness of the last start in the project.
        harness: name(harness) ?? name(lastHarness) ?? 'claude',
        roles: whole ? (stored as Roles) : DEFAULT_ROLES,
        terminal: name((session as { terminal?: unknown } | null)?.terminal)
      }
    }

    /**
     * The live session among the terminals at `path`. The remembered terminal is the session
     * while orca lists it with an agent in it. When orca no longer lists it (its handles are new
     * after a restart) or the agent has left it, any terminal an agent runs in is the session if
     * `anyAgent` is set. Titles are not read: an agent renames its tab.
     */
    const liveTerminal = async (path: string, remembered: string | null, anyAgent: boolean): Promise<Result<string | null>> => {
      const listed = await orcaCli<{ terminals?: Array<{ handle?: string; agentIdentity?: unknown }>; truncated?: boolean }>([
        'terminal', 'list', '--worktree', `path:${path}`, '--limit', String(TERMINAL_LIMIT)
      ])
      if (!listed.ok) return listed
      const terminals = listed.data.terminals ?? []
      const hasAgent = (identity: unknown): boolean => typeof identity === 'string' && identity.trim() !== ''
      const own = remembered === null ? undefined : terminals.find((terminal) => terminal.handle === remembered)
      // An orca that does not say who runs in a terminal: the terminal being there is all there is to know.
      if (own !== undefined && (own.agentIdentity === undefined || hasAgent(own.agentIdentity))) return ok(remembered)
      // The agent left the remembered terminal: where only that terminal counts, there is no session.
      if (own !== undefined && !anyAgent) return ok(null)
      const other = anyAgent ? terminals.find((terminal) => typeof terminal.handle === 'string' && hasAgent(terminal.agentIdentity)) : undefined
      if (other?.handle !== undefined) return ok(other.handle)
      // The session may be among the rows cut off: nothing is decided on a part of the list.
      if (listed.data.truncated === true) {
        return fail(
          'terminals_truncated',
          "The workspace's terminals did not fit in Orca's answer",
          'Close the terminals you do not need in this Orca workspace and press Refresh.'
        )
      }
      return ok(null)
    }

    /**
     * A start remembers an epic under the handle of its project: asked by a name, the records
     * would not be found, and a live session would be told as none.
     */
    const byHandle = (project: unknown): Result<string> =>
      typeof project === 'string' && HANDLE_FORM.test(project)
        ? ok(project)
        : fail('project_not_handle', "The project is not named by its handle: the choice and the epic's session are kept under the project's handle", 'Press Refresh.')

    /** The working copy of the epic and the terminal of its live session, as orca tells them now. */
    const liveSession = async (
      root: string,
      epic: number,
      chosen: { way: Way; terminal: string | null }
    ): Promise<Result<{ worktree: string | null; terminal: string | null }>> => {
      const copies = await copiesOf(root)
      if (!copies.ok) return copies
      const worktree = copies.data.rows.find((row) => row.branch === `epic-${epic}`)?.path ?? null
      // The copy may be among the rows cut off.
      if (worktree === null && !copies.data.complete) return COPIES_TRUNCATED()

      // By the SDD skill the session works in the copy of the epic, and after a restart of Orca
      // any agent there is it; by the workflow it works in the root, where other agents work too,
      // so only the remembered terminal is it.
      const bySdd = chosen.way === 'sdd'
      const place = bySdd ? worktree : chosen.terminal === null ? null : root
      let terminal: string | null = null
      if (place !== null) {
        const live = await liveTerminal(place, chosen.terminal, bySdd)
        if (!live.ok) return live
        terminal = live.data
      }
      return ok({ worktree, terminal })
    }

    // What is chosen for an epic and whether its session is alive. Orca is asked, ConPort is not.
    orca.panels.handle('epic.session', async ({ project, root, epic }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const chosen = await chosenFor(handle.data, epic)
      const branches = await epicBranches(root, epic)
      if (!branches.ok) return branches
      const live = await liveSession(root, epic, chosen)
      if (!live.ok) return live
      const session: EpicSession = {
        way: chosen.way,
        harness: chosen.harness,
        roles: chosen.roles,
        worktree: live.data.worktree,
        alive: live.data.terminal !== null,
        terminal: live.data.terminal,
        workflowBranches: branches.data.workflow
      }
      return ok(session)
    })

    // The tasks of an epic, whatever their status, the snoozed ones too: every page of them.
    orca.panels.handle('epic.tasks', async ({ project, root, epic }) => {
      const tasks: EpicTask[] = []
      for (;;) {
        const page = await conport<{ tasks?: EpicTask[]; total?: number }>(
          ['api', 'tasks', 'list', '--parent_task_id', String(epic), '--status', 'ALL', '--include_snoozed', 'true', '--limit', String(TASKS_PAGE), '--offset', String(tasks.length), '--project', project],
          root
        )
        if (!page.ok) return page
        if (!Array.isArray(page.data.tasks)) return fail('bad_output', 'conport answered without a list of tasks', 'Update conport.')
        tasks.push(...page.data.tasks.map(({ id, title, status }) => ({ id, title, status })))
        // A page that comes empty ends the reading: tasks removed meanwhile leave the total unreached.
        if (page.data.tasks.length === 0 || tasks.length >= (page.data.total ?? 0)) break
      }
      const last = (task: EpicTask): number => (task.status === 'CANCELLED' ? 1 : 0)
      return ok(tasks.sort((a, b) => last(a) - last(b) || a.id - b.id))
    })

    orca.panels.handle('subagents.get', async ({ root, harness }) => {
      if (typeof harness !== 'string' || harness.trim() === '') return fail('harness_invalid', 'No harness is named', "Choose the epic's harness.")
      return conport<SubagentList>(['epic', 'subagents', '--harness', harness, '--json'], root)
    })

    // Brings the terminal of the epic's live session to the front. The terminal is found anew by
    // the rule of `epic.session`: the request names an epic, never a terminal of its own choice.
    // The panel asked for it, so a refusal of orca is told, not only logged.
    orca.panels.handle('terminal.show', async ({ project, root, epic }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const live = await liveSession(root, epic, await chosenFor(handle.data, epic))
      if (!live.ok) return live
      if (live.data.terminal === null) {
        return fail('session_gone', `Epic ${epic} has no live session: its terminal is closed or its agent has exited`, 'Press Refresh.')
      }
      const shown = await switchTo(live.data.terminal)
      return shown.ok ? ok(null) : shown
    })

    orca.panels.handle('tasks.list', async ({ project, root }) => {
      const list = await conport<TaskList>(['task', 'list', '--project', project, '--json'], root)
      return list.ok ? ok(list.data.tasks) : list
    })

    // A task outside the epics, to do, to review or to fix: the CLI reads it afresh, so a task done
    // or taken meanwhile is not handed again. It takes only an agent that can be given a task.
    orca.panels.handle('task.hand', async ({ project, root, task, agent, mode }) => {
      if (!PREPARE_AGENTS.includes(agent)) return refuse('agent_cannot_prepare', REFUSED.agentCannotPrepare('agent', agent))
      const order = await promptText(taskPromptArgs({ task, project, mode, agent, root }), root, { command: 'task', task, mode })
      if (!order.ok) return order
      const title = `conport ${{ do: 'task', review: 'review', fix: 'fix' }[mode]} ${task}`
      return rememberAgent(project, agent, await startAgent(root, agent, title, order.data))
    })
  }

  return { activate, deactivate }
}

const worker = createWorker({ conport: CONPORT, orca: ['orca'], git: ['git'] })

export default function activate(orca: OrcaWorkerApi): void {
  worker.activate(orca)
}

export function deactivate(): void {
  worker.deactivate()
}
