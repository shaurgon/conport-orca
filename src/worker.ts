// The plugin's worker: runs the conport CLI and orca as child processes for the panel. Each read
// is one request of the panel, which times its reads of the list itself; the worker keeps nothing
// running between requests. No status bar item, no notification — the state of the agents is
// Orca's own.
import { readFile, realpath } from 'node:fs/promises'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  CONPORT,
  commandLine,
  DEFAULT_ROLES,
  epicPromptArgs,
  HANDLE_FORM,
  ideaPromptArgs,
  interpret,
  proposalAcceptArgs,
  proposalDeclineArgs,
  ROLE_TYPE_FORM,
  sddListArgs,
  sddTakenArgs,
  specPromptArgs,
  TASK_AGENTS,
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
  RowRef,
  SddList,
  SubagentList,
  TakenList
} from './protocol'
import { readSettings, type SettingsText } from './settings'
import {
  AGENT_MISSING_ACTION,
  HARNESS_MISSING_ACTION,
  type PromptSubject,
  promptRefusal,
  proposalRefusal,
  REFUSED,
  type SpecTarget
} from './text'

/** How the worker starts the three programs it drives. */
export interface WorkerDeps {
  conport: readonly string[]
  orca: readonly string[]
  git: readonly string[]
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

/** The ConPort dashboard, where a spec is opened. */
const DASHBOARD = 'https://me.conport.app'

/** How long git may take to say anything about the settings files, as every reader of them waits. */
export const GIT_TIMEOUT_MS = 5000

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
      const repository = await repositoryKind(root)
      const nothing = { shared: null, local: null, localIgnored: null, env: {}, explicit: null }
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

    /** Whether the branch `epic-<N>` of an epic started before is there, read in one call of git. */
    const epicBranch = async (root: string, epic: number): Promise<Result<boolean>> => {
      const own = `refs/heads/epic-${epic}`
      const listed = await runProcess([...deps.git, '-C', root, 'for-each-ref', '--format=%(refname)', own])
      // A git that could not start is told as any program that could not.
      if (listed.failure !== undefined) return interpret('git', listed, basename(deps.git[0] ?? '')) as Result<never>
      if (listed.code !== 0) {
        // What git said, as it said it.
        const said = listed.stderr.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
        return fail('git_failed', said ?? `git: exit code ${listed.code}`, 'Check the repository with git status in its root and try again.')
      }
      const refs = listed.stdout.split('\n').map((line) => line.trim())
      // The pattern of the branch itself lists the branches under it too: only the exact name counts.
      return ok(refs.includes(own))
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

    orca.panels.handle('sdd.list', ({ project, root }) => conport<SddList>(sddListArgs(project), root))

    orca.panels.handle('sdd.taken', ({ project, root }) => conport<TakenList>(sddTakenArgs(project), root))

    // The address of the project in the dashboard: its canonical name `<team>/<name>` names the
    // team that holds it, and an address of the dashboard names that team.
    orca.panels.handle('project.page', async ({ project, root }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const read = await conport<{ canonical_name?: unknown; handle?: unknown }>(['api', 'projects', 'get', '--project', handle.data], root)
      if (!read.ok) return read
      const team = typeof read.data.canonical_name === 'string' ? read.data.canonical_name.split('/')[0] : ''
      if (!team) return fail('bad_output', 'conport answered without the team of the project', 'Update conport.')
      return ok({ url: `${DASHBOARD}/t/${encodeURIComponent(team)}/p/${handle.data}` })
    })

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

    /**
     * The agent of the last launch in the project. An earlier release kept it under
     * `prepare:<project>`: that record is read once, moved to `launcher:<project>` unless a
     * launcher is there already, and dropped.
     */
    const launcherOf = async (project: string): Promise<string | null> => {
      const name = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
      const [launcher, earlier] = await Promise.all([orca.storage.get(`launcher:${project}`), orca.storage.get(`prepare:${project}`)])
      if (earlier === undefined || earlier === null) return name(launcher)
      const moved = name(launcher) ?? name(earlier)
      if (name(launcher) === null && moved !== null) await orca.storage.set(`launcher:${project}`, moved)
      await orca.storage.delete(`prepare:${project}`)
      return moved
    }

    orca.panels.handle('agents.get', async ({ project, root }) => {
      const agents = await agentKinds(root)
      if (!agents.ok) return agents
      return ok({ agents: agents.data, launcher: await launcherOf(project) })
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
      if (!TASK_AGENTS.includes(agent)) return refuse('agent_cannot_prepare', REFUSED.agentCannotPrepare(noun, agent))
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
     * Opens `agent` with its one task in a terminal of the root. Nothing is remembered here: each
     * launch remembers its agent and its terminal itself.
     */
    const startAgent = async (root: string, agent: string, title: string, task: string): Promise<Result<{ terminal: string }>> => {
      const command = await agentCommand(root, agent)
      if (!command.ok) return command
      return openAgent(root, command.data, title, task)
    }

    /** Opens the agent's `command` with its one task in a terminal of the root, brought to the front. */
    const openAgent = async (root: string, command: string, title: string, task: string): Promise<Result<{ terminal: string }>> => {
      const terminal = await terminalInRoot(root, title, commandLine([command, task]))
      if (!terminal.ok) return terminal
      // The person talks with the agent there: the terminal comes to the front.
      await bringForward(terminal.data)
      return ok({ terminal: terminal.data })
    }

    /**
     * What a start remembers — the choice of an epic, the terminal of a row — is kept under the
     * handle of its project: asked or launched by a name, the records would not be found, and a
     * live session would be told as none.
     */
    const byHandle = (project: unknown): Result<string> =>
      typeof project === 'string' && HANDLE_FORM.test(project)
        ? ok(project)
        : fail('project_not_handle', "The project is not named by its handle: the choice and the epic's session are kept under the project's handle", 'Press Refresh.')

    /** Remembers the agent of a launch for the project, once its terminal is open. */
    const rememberAgent = async <T>(project: string, agent: string, started: Result<T>): Promise<Result<T>> => {
      if (started.ok) await orca.storage.set(`launcher:${project}`, agent)
      return started
    }

    /**
     * The key a row's terminal is kept under: `task-<id>` for an idea or a task, `doc-<N>` for a
     * spec document, `plan-<epic>` for the plan of an epic written in the root (Plan & build of an
     * epic with a spec). The session of an epic is kept apart, under the bare number, by `epic.start`.
     */
    type SessionOf = { task: number } | { doc: number } | { plan: number }
    const sessionKey = (project: string, row: SessionOf): string =>
      `session:${project}:${'task' in row ? `task-${row.task}` : 'doc' in row ? `doc-${row.doc}` : `plan-${row.plan}`}`

    /** Remembers the agent of a launch and the terminal it opened for its row. */
    const rememberLaunch = async (
      project: string,
      agent: string,
      row: SessionOf,
      started: Result<{ terminal: string }>
    ): Promise<Result<{ terminal: string }>> => {
      if (started.ok) await orca.storage.set(sessionKey(project, row), { terminal: started.data.terminal })
      return rememberAgent(project, agent, started)
    }

    /** An agent that cannot be told its task, refused before anything is read or written. */
    const cannotTakeTask = (agent: string): Result<never> | null =>
      TASK_AGENTS.includes(agent) ? null : refuse('agent_cannot_prepare', REFUSED.agentCannotPrepare('agent', agent))

    /**
     * Opens the agent of an idea in a terminal of the root with the task `conport prompt idea`
     * prints; `command` is the agent's, when the launch has looked it up already; `takeOver` when
     * the person said yes to taking over an idea another person leads.
     */
    const startIdea = async (
      project: string,
      root: string,
      task: number,
      agent: string,
      command?: string,
      takeOver?: boolean
    ): Promise<Result<{ terminal: string }>> => {
      const order = await promptText(ideaPromptArgs({ task, project, agent, root, takeOver }), root, { command: 'idea', task })
      if (!order.ok) return order
      const title = `conport idea ${task}`
      const started = command === undefined ? await startAgent(root, agent, title, order.data) : await openAgent(root, command, title, order.data)
      return rememberLaunch(project, agent, { task }, started)
    }

    // An idea: its agent works it through with the person in a terminal of the root. The CLI reads
    // the task afresh and refuses one that is no longer an idea.
    orca.panels.handle('idea.start', async ({ project, root, task, agent, takeOver }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const cannot = cannotTakeTask(agent)
      if (cannot) return cannot
      return startIdea(handle.data, root, task, agent, undefined, takeOver === true)
    })

    // A proposal of the team: accepted first — the CLI finds or makes its idea and answers it —
    // then that idea is started. The agent is looked up before the accept: a proposal is not taken
    // for an agent that cannot be started. A refused accept opens nothing; an accept repeated
    // answers the same idea.
    orca.panels.handle('proposal.start', async ({ project: named, root, doc, agent }) => {
      const handle = byHandle(named)
      if (!handle.ok) return handle
      const project = handle.data
      const command = await agentCommand(root, agent)
      if (!command.ok) return command
      const accepted = await conport<{ task?: unknown }>(proposalAcceptArgs({ doc, project }), root)
      if (!accepted.ok) {
        const said = proposalRefusal(accepted.error.code, doc)
        return said ? refuse(accepted.error.code, said) : accepted
      }
      const { task } = accepted.data
      if (typeof task !== 'number' || !Number.isInteger(task)) {
        return fail('bad_output', 'conport accepted the proposal without naming its task', 'Update conport.')
      }
      const started = await startIdea(project, root, task, agent, command.data)
      return started.ok ? ok({ terminal: started.data.terminal, task }) : started
    })

    // A spec without a plan, as a document or as the epic that has it: its agent writes the plan with
    // the person in a terminal of the root and builds the epic. The epic is cut from the branch of
    // the main working copy, as `epic.start` cuts it.
    orca.panels.handle('spec.start', async ({ project: named, root, target, agent, takeOver }) => {
      const handle = byHandle(named)
      if (!handle.ok) return handle
      const project = handle.data
      const cannot = cannotTakeTask(agent)
      if (cannot) return cannot
      const copies = await worktreesOf(root)
      if (!copies.ok) return copies
      const spec: SpecTarget = 'doc' in target ? { doc: target.doc } : { epic: target.epic }
      const args = specPromptArgs({ target: spec, project, agent, root, base: copies.data.base, takeOver: takeOver === true })
      const order = await promptText(args, root, { command: 'spec', target: spec })
      if (!order.ok) return order
      const title = 'doc' in spec ? `conport spec doc-${spec.doc}` : `conport spec ${spec.epic}`
      // The plan of an epic is written in the root: kept apart from the session of the epic, which
      // `epic.start` keeps under the bare number and looks for in the working copy of the epic.
      const row: SessionOf = 'doc' in spec ? { doc: spec.doc } : { plan: spec.epic }
      return rememberLaunch(project, agent, row, await startAgent(root, agent, title, order.data))
    })

    // A proposal declined with the reason the person wrote: no agent is started.
    orca.panels.handle('proposal.decline', async ({ project, root, doc, reason }) => {
      const why = typeof reason === 'string' ? reason.trim() : ''
      if (why === '') return refuse('reason_missing', REFUSED.reasonMissing)
      const declined = await conport<unknown>(proposalDeclineArgs({ doc, project, reason: why }), root)
      if (declined.ok) return ok(null)
      const said = proposalRefusal(declined.error.code, doc)
      return said ? refuse(declined.error.code, said) : declined
    })

    // An epic that has its spec and its plan: its harness gets the task of the epic in a terminal
    // of the working copy of the branch `epic-<N>` and does the rest by the SDD skill. The start
    // reads the epic and the agent kinds, then asks `conport prompt` for the task, and runs nothing
    // else of ConPort: no check, no lock, no record of a run, no file in the working copy.
    orca.panels.handle('epic.start', async ({ project, root, epic, harness, roles, takeOver }) => {
      const list = await conport<EpicList>(['epic', 'list', '--project', project, '--json'], root)
      if (!list.ok) return list
      const found = list.data.epics.find((e) => e.id === epic)
      if (!found) return refuse('epic_not_found', REFUSED.epicNotFound(epic))
      if (!found.runnable) return refuse('epic_not_ready', REFUSED.epicNotReady(epic))
      const roleInvalid = refuse('role_invalid', REFUSED.roleInvalid)
      // A request that names no roles has nothing to remember for the epic, whichever the harness.
      if (typeof roles !== 'object' || roles === null) return roleInvalid
      // Only Claude Code is told the types: there they reach the task and the command line.
      const types: unknown[] = [roles.implementer, roles.reviewer, roles.gapHunter, roles.finalReviewer]
      if (harness === 'claude' && !types.every((type) => typeof type === 'string' && ROLE_TYPE_FORM.test(type))) {
        return roleInvalid
      }
      const command = await agentCommand(root, harness, 'harness')
      if (!command.ok) return command

      const branchThere = await epicBranch(root, epic)
      if (!branchThere.ok) return branchThere
      const trees = await worktreesOf(root)
      if (!trees.ok) return trees
      const handle = list.data.project
      const branch = `epic-${epic}`
      // A copy that is there is taken as it is: nothing in it is read.
      let worktree = trees.data.rows.find((row) => row.branch === branch)?.path ?? null
      if (worktree === null) {
        // The copy may be among the rows cut off: none is created on a part of the list.
        if (!trees.data.complete) return COPIES_TRUNCATED()
        if (branchThere.data) {
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
      // The CLI checks the epic again, now that the place of the work is known.
      const args = epicPromptArgs({ epic, project: handle, harness, worktree, base: trees.data.base, roles, takeOver: takeOver === true })
      const task = await promptText(args, root, { command: 'epic', epic, harness })
      if (!task.ok) return task
      const terminal = await terminalIn(worktree, `conport epic ${epic} · SDD`, commandLine([command.data, task.data]))
      if (!terminal.ok) return terminal
      // The person talks with the harness there: the terminal comes to the front.
      await bringForward(terminal.data)
      await orca.storage.set(`harness:${handle}:${epic}`, harness)
      await orca.storage.set(`roles:${handle}:${epic}`, { ...roles })
      await orca.storage.set(`session:${handle}:${epic}`, { terminal: terminal.data })
      await orca.storage.set(`harness:${handle}`, harness)
      return ok({ terminal: terminal.data, worktree })
    })

    /**
     * What a start of the epic remembered, or the default where it remembered nothing. Of the
     * session record only its terminal is read: a record a start by an earlier release of the
     * panel left holds a `way` besides, and the key `way:<project>:<epic>` it wrote is not read.
     */
    const chosenFor = async (project: string, epic: number): Promise<{ harness: string; roles: Roles; terminal: string | null }> => {
      const name = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
      const [harness, lastHarness, roles, session] = await Promise.all([
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

    /** The working copy of the epic and the terminal of its live session, as orca tells them now. */
    const liveSession = async (
      root: string,
      epic: number,
      chosen: { terminal: string | null }
    ): Promise<Result<{ worktree: string | null; terminal: string | null }>> => {
      const copies = await copiesOf(root)
      if (!copies.ok) return copies
      const worktree = copies.data.rows.find((row) => row.branch === `epic-${epic}`)?.path ?? null
      // The copy may be among the rows cut off.
      if (worktree === null && !copies.data.complete) return COPIES_TRUNCATED()

      // The session works in the copy of the epic, and after a restart of Orca any agent there is
      // it. Without the copy, only the remembered terminal in the root can be one: a start by an
      // earlier release of the panel could open its session there, among other agents.
      const place = worktree ?? (chosen.terminal === null ? null : root)
      let terminal: string | null = null
      if (place !== null) {
        const live = await liveTerminal(place, chosen.terminal, worktree !== null)
        if (!live.ok) return live
        terminal = live.data
      }
      return ok({ worktree, terminal })
    }

    // What is chosen for an epic and whether its session is alive. Orca is asked, ConPort and git are not.
    orca.panels.handle('epic.session', async ({ project, root, epic }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const chosen = await chosenFor(handle.data, epic)
      const live = await liveSession(root, epic, chosen)
      if (!live.ok) return live
      const session: EpicSession = {
        harness: chosen.harness,
        roles: chosen.roles,
        worktree: live.data.worktree,
        alive: live.data.terminal !== null,
        terminal: live.data.terminal
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

    /**
     * The terminal this host opened in the root under `key`, while an agent runs in it; none when
     * nothing is remembered there, and then orca is not asked.
     */
    const rootTerminal = async (root: string, key: string): Promise<Result<string | null>> => {
      const record = await orca.storage.get(key)
      const remembered = (record as { terminal?: unknown } | null | undefined)?.terminal
      if (typeof remembered !== 'string' || remembered === '') return ok(null)
      return liveTerminal(root, remembered, false)
    }

    /** The first live terminal in the root among those kept under `sources`, in their order. */
    const firstRootTerminal = async (handle: string, root: string, sources: SessionOf[]): Promise<Result<string | null>> => {
      for (const source of sources) {
        const live = await rootTerminal(root, sessionKey(handle, source))
        if (!live.ok || live.data !== null) return live
      }
      return ok(null)
    }

    /**
     * The terminal of a row's live session. An idea and a task have only the terminal opened for
     * them in the root. A spec document has its own, else that of the idea it clarifies: the
     * brainstorm of the idea goes on to the plan in the same session. An epic has its own session
     * first, by the rule of `epic.session`; else the session its plan was written in (Plan & build
     * of the epic), else that of the spec it was made from, else that of its idea: one session goes
     * from the idea through the spec and the plan into the epic. A refusal of orca on the epic's
     * own session does not stop the search among those it inherits; it is answered only when none
     * of them is live.
     */
    const rowTerminal = async (handle: string, root: string, row: RowRef): Promise<Result<string | null>> => {
      if (row.kind === 'idea' || row.kind === 'task') return rootTerminal(root, sessionKey(handle, { task: row.id }))
      if (row.kind === 'spec') {
        return firstRootTerminal(handle, root, [{ doc: row.doc }, ...(typeof row.idea === 'number' ? [{ task: row.idea }] : [])])
      }
      const own = await liveSession(root, row.id, await chosenFor(handle, row.id))
      if (own.ok && own.data.terminal !== null) return ok(own.data.terminal)
      const inherited = await firstRootTerminal(handle, root, [
        { plan: row.id },
        ...(row.spec === null ? [] : [{ doc: row.spec }]),
        ...(row.idea === null ? [] : [{ task: row.idea }])
      ])
      if (!inherited.ok || inherited.data !== null || own.ok) return inherited
      return own
    }

    // The terminal of a row's live session, as orca tells it now. ConPort and git are not asked.
    orca.panels.handle('row.session', async ({ project, root, row }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const live = await rowTerminal(handle.data, root, row)
      return live.ok ? ok({ terminal: live.data }) : live
    })

    // Brings the terminal of a row's live session to the front. The terminal is found anew by the
    // rule of `row.session`: the request names a row, never a terminal of its own choice. The panel
    // asked for it, so a refusal of orca is told, not only logged.
    orca.panels.handle('terminal.show', async ({ project, root, row }) => {
      const handle = byHandle(project)
      if (!handle.ok) return handle
      const live = await rowTerminal(handle.data, root, row)
      if (!live.ok) return live
      if (live.data === null) return refuse('session_gone', REFUSED.sessionGone(row))
      const shown = await switchTo(live.data)
      return shown.ok ? ok(null) : shown
    })

    // A task of an epic outside SDD to do, or a task to review or to fix: the CLI reads it afresh,
    // so a task done or taken meanwhile is not handed again. It takes only an agent that can be given a task.
    orca.panels.handle('task.hand', async ({ project: named, root, task, agent, mode }) => {
      const handle = byHandle(named)
      if (!handle.ok) return handle
      const project = handle.data
      const cannot = cannotTakeTask(agent)
      if (cannot) return cannot
      const order = await promptText(taskPromptArgs({ task, project, mode, agent, root }), root, { command: 'task', task, mode })
      if (!order.ok) return order
      const title = `conport ${{ do: 'task', review: 'review', fix: 'fix' }[mode]} ${task}`
      return rememberLaunch(project, agent, { task }, await startAgent(root, agent, title, order.data))
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
