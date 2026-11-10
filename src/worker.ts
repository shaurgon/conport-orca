// The plugin's worker: runs the conport CLI and orca as child processes for the panel. It reads
// only when the panel asks: no timer, no status bar item, no notification — the state of the
// agents is Orca's own.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  CONPORT,
  commandLine,
  DEFAULT_ROLES,
  epicTask,
  epicWorkflowTask,
  HANDLE_FORM,
  handMode,
  handTask,
  interpret,
  missingDocument,
  PREPARE_AGENTS,
  prepareTask,
  ROLE_TYPE_FORM
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
import { AGENT_MISSING_ACTION, HARNESS_MISSING_ACTION, PREPARE_AGENTS_ACTION } from './text'

/** How the worker starts the three programs it drives. */
export interface WorkerDeps {
  conport: readonly string[]
  orca: readonly string[]
  git: readonly string[]
}

/** A working copy of a repository, as `orca worktree list` names it. */
interface WorktreeRow {
  path: string
  /** The branch it is on, without `refs/heads/`; null when it is on none. */
  branch: string | null
}

const TRUNCATED = (): { ok: false; error: { code: string; message: string; action: string } } =>
  fail('workspaces_truncated', 'Orca отдала неполный список рабочих мест', 'уберите лишние рабочие места из Orca и повторите')

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
    `список рабочих копий репозитория не поместился в ответ Orca: их больше ${WORKTREE_LIMIT}`,
    'удалите ненужные рабочие копии репозитория в Orca и повторите'
  )

const normalize = (path: string): string => path.replace(/\/+$/, '')
const branchName = (branch: string | null): string => (branch ?? '').replace(/^refs\/heads\//, '')

const fail = (code: string, message: string, action = ''): { ok: false; error: { code: string; message: string; action: string } } => ({
  ok: false,
  error: { code, message, action }
})

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

    /** An orca CLI call: its `result` on success. */
    const orcaCli = async <T>(args: string[]): Promise<Result<T>> => {
      const answer = interpret('orca', await runProcess([...deps.orca, ...args, '--json']), basename(deps.orca[0] ?? ''))
      if (!answer.ok) return answer
      const result = (answer.data as { result?: unknown }).result
      if (result === undefined) return fail('bad_output', 'orca ответил без result', 'обновите Orca')
      return { ok: true, data: result as T }
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
        `в Orca несколько рабочих мест «${focus.displayName}», какое в фокусе — не понять`,
        'откройте терминал в нужном рабочем месте Orca и повторите'
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
      return match !== undefined && more.length === 0 ? { ok: true, data: match } : ambiguous
    }

    /**
     * The path of the workspace in focus. The worker runs in its own folder, so orca's
     * `active` selector would name the plugin's folder: the host knows the focus.
     */
    const focusedPath = async (): Promise<Result<string>> => {
      const focus = await orca.host.call('workspace.readContext')
      if (focus === null) {
        return fail('no_workspace', 'в Orca нет рабочего места в фокусе', 'откройте рабочее место репозитория')
      }
      const { workspaces, truncated } = await orca.host.call('workspace.list')
      // The focus names no path: name and branch must point at one workspace, or nothing is picked.
      const named = workspaces.filter((w) => w.name === focus.displayName)
      const onBranch = named.filter((w) => branchName(w.branch) === branchName(focus.branch))
      const candidates = onBranch.length > 0 ? onBranch : named
      const [workspace, ...others] = candidates
      if (workspace && others.length === 0) return { ok: true, data: workspace.path }
      if (workspace) return byTerminals(candidates, focus)
      if (truncated) return TRUNCATED()
      return fail('no_workspace', `рабочего места «${focus.displayName}» нет в списке Orca`, 'откройте рабочее место репозитория')
    }

    /** The id orca gives the repository of the workspace in focus. */
    const focusedRepoId = async (): Promise<Result<string>> => {
      const focused = await focusedPath()
      if (!focused.ok) return focused
      const shown = await orcaCli<{ worktree?: { repoId?: string } }>(['worktree', 'show', '--worktree', `path:${focused.data}`])
      if (!shown.ok) return shown
      const repoId = shown.data.worktree?.repoId
      if (!repoId) return fail('no_repository', 'рабочее место в фокусе не принадлежит репозиторию', 'откройте рабочее место репозитория')
      return { ok: true, data: repoId }
    }

    const contextOf = async (root: string): Promise<RepoContext> => {
      const fromRepository = await repositoryProject(root)
      if (fromRepository) return { root, project: fromRepository, source: 'repository' }
      const stored = await orca.storage.get(`project:${root}`)
      if (typeof stored === 'string' && stored !== '') return { root, project: stored, source: 'stored' }
      return { root, project: null, source: null }
    }

    /** A terminal in the repository root, which must be a workspace of Orca. */
    const terminalInRoot = async (root: string, title: string, command: string): Promise<Result<string>> => {
      const { workspaces, truncated } = await orca.host.call('workspace.list')
      const workspace = workspaces.find((w) => normalize(w.path) === normalize(root))
      if (!workspace) {
        if (truncated) return TRUNCATED()
        return fail('root_not_open', `корень репозитория ${root} не открыт в Orca`, 'добавьте репозиторий в Orca')
      }
      const { terminalId } = await orca.host.call('terminal.create', { workspaceId: workspace.id, title, command })
      return { ok: true, data: terminalId }
    }

    /** A terminal orca opens in the working copy at `path`, by the handle orca lists it under. */
    const terminalIn = async (path: string, title: string, command: string): Promise<Result<string>> => {
      const created = await orcaCli<{ terminal?: { handle?: string } }>([
        'terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command
      ])
      if (!created.ok) return created
      const handle = created.data.terminal?.handle
      if (!handle) return fail('bad_output', 'orca открыла терминал и не назвала его', 'обновите Orca')
      return { ok: true, data: handle }
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
        return fail('git_failed', said ?? `git: код выхода ${listed.code}`, 'проверьте репозиторий командой git status в его корне и повторите')
      }
      const refs = listed.stdout.split('\n').map((line) => line.trim())
      // The pattern of the branch itself lists the branches under it too: only the exact name counts.
      return { ok: true, data: { sdd: refs.includes(own), workflow: refs.some((ref) => ref.startsWith(tasks)) } }
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
        return fail('bad_output', 'orca не назвала главную рабочую копию репозитория', 'обновите Orca')
      }
      const base = branchName(main.branch ?? null) || null
      const rows = all
        .filter((row) => row.repoId === main.repoId && typeof row.path === 'string')
        .map((row) => ({ path: row.path as string, branch: branchName(row.branch ?? null) || null }))
      return { ok: true, data: { repoId: main.repoId, base, rows, complete: listed.data.truncated !== true } }
    }

    /** The working copies of the repository at `root`, with the base an epic is cut from: the start needs one. */
    const worktreesOf = async (
      root: string
    ): Promise<Result<{ repoId: string; base: string; rows: WorktreeRow[]; complete: boolean }>> => {
      const copies = await copiesOf(root)
      if (!copies.ok) return copies
      const { base } = copies.data
      if (base === null) {
        return fail('root_detached', 'главная рабочая копия репозитория не на ветке: базы для эпика нет', 'переключите главную рабочую копию на ветку')
      }
      return { ok: true, data: { ...copies.data, base } }
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
        const context = kind === 'git' ? await contextOf(repo.path) : { root: repo.path, project: null, source: null }
        projects.push({
          ...context,
          name: repo.displayName || basename(normalize(repo.path)),
          kind,
          focused: focus !== null && repo.id === focus
        })
      }
      return { ok: true, data: projects }
    })

    orca.panels.handle('project.set', async ({ root, project }) => {
      const value = project.trim()
      if (value === '') return fail('empty_project', 'проект не назван', 'впишите имя или handle проекта')
      await orca.storage.set(`project:${root}`, value)
      return { ok: true, data: await contextOf(root) }
    })

    orca.panels.handle('project.forget', async ({ root }) => {
      await orca.storage.delete(`project:${root}`)
      return { ok: true, data: await contextOf(root) }
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
      return { ok: true, data: answer.data.agents.map((a) => (a.found || !inOrca.has(a.id) ? a : { ...a, found: true })) }
    }

    orca.panels.handle('agents.get', async ({ project, root }) => {
      const agents = await agentKinds(root)
      if (!agents.ok) return agents
      const preparer = await orca.storage.get(`prepare:${project}`)
      return { ok: true, data: { agents: agents.data, preparer: typeof preparer === 'string' ? preparer : null } }
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
    const agentCommand = async (root: string, agent: string, noun: 'агент' | 'харнесс' = 'агент'): Promise<Result<string>> => {
      if (!PREPARE_AGENTS.includes(agent)) {
        return fail('agent_cannot_prepare', `${noun} «${agent}» не принимает задание при запуске`, PREPARE_AGENTS_ACTION)
      }
      const kinds = await agentKinds(root)
      if (!kinds.ok) return kinds
      const kind = kinds.data.find((a) => a.id === agent)
      if (!kind?.found) {
        return noun === 'агент'
          ? fail('agent_not_found', `агент «${agent}» не найден`, AGENT_MISSING_ACTION)
          : fail('agent_not_found', `харнесс «${agent}» не найден на машине`, HARNESS_MISSING_ACTION)
      }
      return { ok: true, data: kind.command }
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
      return { ok: true, data: { terminal: terminal.data } }
    }

    /** Remembers the agent of a preparation or of a hand for the project, once its terminal is open. */
    const rememberAgent = async <T>(project: string, agent: string, started: Result<T>): Promise<Result<T>> => {
      if (started.ok) await orca.storage.set(`prepare:${project}`, agent)
      return started
    }

    // An epic without a spec or a plan: its agent talks with the person in a terminal of the root.
    // What the epic lacks is read afresh, so the task fits the epic as it is now.
    orca.panels.handle('epic.prepare', async ({ project, root, epic, agent }) => {
      const list = await conport<EpicList>(['epic', 'list', '--project', project, '--json'], root)
      if (!list.ok) return list
      const found = list.data.epics.find((e) => e.id === epic)
      if (!found) return fail('epic_not_found', `эпика ${epic} нет в проекте`, 'нажмите «Обновить»')
      if (found.runnable) return fail('epic_ready', `эпик ${epic} уже готов к запуску`, 'нажмите «Обновить» и запустите его')
      const missing = missingDocument(found.reason)
      if (missing === null) {
        return fail(
          'epic_not_preparable',
          `эпик ${epic} не готов к запуску по причине, которую подготовка не исправит`,
          'нажмите «Обновить» и посмотрите эпик во вкладке «Подготовить»'
        )
      }
      const task = prepareTask({ epic, project: list.data.project, missing })
      return rememberAgent(project, agent, await startAgent(root, agent, `conport prepare ${epic}`, task))
    })

    // An epic that has its spec and its plan: its harness gets the task of the epic in a terminal
    // and does the rest. The start reads the epic and the agent kinds, and runs nothing else of
    // ConPort: no check, no lock, no record of a run, no file in the working copy.
    orca.panels.handle('epic.start', async ({ project, root, epic, way, harness, roles }) => {
      const list = await conport<EpicList>(['epic', 'list', '--project', project, '--json'], root)
      if (!list.ok) return list
      const found = list.data.epics.find((e) => e.id === epic)
      if (!found) return fail('epic_not_found', `эпика ${epic} нет в проекте`, 'нажмите «Обновить»')
      if (!found.runnable) {
        return fail('epic_not_ready', `у эпика ${epic} нет спецификации или плана`, 'подготовьте эпик на вкладке «Подготовить»')
      }
      if (way === 'workflow' && harness !== 'claude') {
        return fail('way_needs_claude', 'способ «/conport:epic» есть только у Claude Code с плагином conport', 'выберите харнесс Claude Code')
      }
      const roleInvalid = fail('role_invalid', 'тип субагента — не простое имя', 'выберите тип роли из списка')
      // A request that names no roles has nothing to remember for the epic, whichever the way.
      if (typeof roles !== 'object' || roles === null) return roleInvalid
      // Only Claude Code by the SDD skill is told the types: there they reach the task and the command line.
      const types: unknown[] = [roles.implementer, roles.reviewer, roles.gapHunter, roles.finalReviewer]
      if (way === 'sdd' && harness === 'claude' && !types.every((type) => typeof type === 'string' && ROLE_TYPE_FORM.test(type))) {
        return roleInvalid
      }
      const command = await agentCommand(root, harness, 'харнесс')
      if (!command.ok) return command

      // An epic begun one way is not taken over by the other: their branches do not meet.
      const branches = await epicBranches(root, epic)
      if (!branches.ok) return branches
      if (way === 'sdd' && branches.data.workflow) {
        return fail('epic_started_workflow', `выбран навык SDD, а ветки epic${epic}/… уже есть: эпик начат потоком`, 'выберите способ «/conport:epic»')
      }
      if (way === 'workflow' && branches.data.sdd) {
        return fail('epic_started_sdd', `выбран поток, а ветка epic-${epic} уже есть: эпик начат навыком SDD`, 'выберите способ «Навык SDD»')
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
            return fail('epic_branch_taken', `ветка ${branch} есть, а рабочей копии у неё нет`, 'откройте ветку рабочим местом в Orca')
          }
          // No `--setup`: the setting of the repository in Orca decides.
          const created = await orcaCli<{ worktree?: { path?: string } }>([
            'worktree', 'create', '--repo', `id:${trees.data.repoId}`, '--name', branch, '--branch', branch,
            '--base-branch', trees.data.base, '--no-parent'
          ])
          if (!created.ok) return created
          worktree = created.data.worktree?.path ?? null
          if (worktree === null) return fail('bad_output', 'orca создала рабочую копию и не назвала её путь', 'обновите Orca')
        }
      }
      const task =
        worktree === null
          ? epicWorkflowTask({ epic, project: handle, root, base: trees.data.base })
          : epicTask({ epic, project: handle, worktree, base: trees.data.base, harness, roles })
      const title = `conport epic ${epic} · ${way === 'sdd' ? 'SDD' : 'workflow'}`
      const terminal = await terminalIn(worktree ?? root, title, commandLine([command.data, task]))
      if (!terminal.ok) return terminal
      // The person talks with the harness there: the terminal comes to the front.
      await bringForward(terminal.data)
      await orca.storage.set(`harness:${handle}:${epic}`, harness)
      await orca.storage.set(`roles:${handle}:${epic}`, { ...roles })
      await orca.storage.set(`way:${handle}:${epic}`, way)
      await orca.storage.set(`session:${handle}:${epic}`, { terminal: terminal.data, way })
      await orca.storage.set(`harness:${handle}`, harness)
      return { ok: true, data: { terminal: terminal.data, way, worktree } }
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
      if (own !== undefined && (own.agentIdentity === undefined || hasAgent(own.agentIdentity))) return { ok: true, data: remembered }
      // The agent left the remembered terminal: where only that terminal counts, there is no session.
      if (own !== undefined && !anyAgent) return { ok: true, data: null }
      const other = anyAgent ? terminals.find((terminal) => typeof terminal.handle === 'string' && hasAgent(terminal.agentIdentity)) : undefined
      if (other?.handle !== undefined) return { ok: true, data: other.handle }
      // The session may be among the rows cut off: nothing is decided on a part of the list.
      if (listed.data.truncated === true) {
        return fail(
          'terminals_truncated',
          'список терминалов рабочего места не поместился в ответ Orca',
          'закройте лишние терминалы этого рабочего места в Orca и нажмите «Обновить»'
        )
      }
      return { ok: true, data: null }
    }

    /**
     * A start remembers an epic under the handle of its project: asked by a name, the records
     * would not be found, and a live session would be told as none.
     */
    const byHandle = (project: unknown): Result<string> =>
      typeof project === 'string' && HANDLE_FORM.test(project)
        ? { ok: true, data: project }
        : fail('project_not_handle', 'проект назван не по handle: выбор и сессия эпика хранятся под handle проекта', 'нажмите «Обновить»')

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
      return { ok: true, data: { worktree, terminal } }
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
      return { ok: true, data: session }
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
        if (!Array.isArray(page.data.tasks)) return fail('bad_output', 'conport ответил без списка задач', 'обновите conport')
        tasks.push(...page.data.tasks.map(({ id, title, status }) => ({ id, title, status })))
        // A page that comes empty ends the reading: tasks removed meanwhile leave the total unreached.
        if (page.data.tasks.length === 0 || tasks.length >= (page.data.total ?? 0)) break
      }
      const last = (task: EpicTask): number => (task.status === 'CANCELLED' ? 1 : 0)
      return { ok: true, data: tasks.sort((a, b) => last(a) - last(b) || a.id - b.id) }
    })

    orca.panels.handle('subagents.get', async ({ root, harness }) => {
      if (typeof harness !== 'string' || harness.trim() === '') return fail('harness_invalid', 'харнесс не назван', 'выберите харнесс эпика')
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
        return fail('session_gone', `у эпика ${epic} нет живой сессии: её терминал закрыт или агент в нём завершился`, 'нажмите «Обновить»')
      }
      const shown = await switchTo(live.data.terminal)
      return shown.ok ? { ok: true, data: null } : shown
    })

    orca.panels.handle('tasks.list', async ({ project, root }) => {
      const list = await conport<TaskList>(['task', 'list', '--project', project, '--json'], root)
      return list.ok ? { ok: true, data: list.data.tasks } : list
    })

    // A task outside the epics, to do or to review: read afresh, so a task done or taken
    // meanwhile is not handed again.
    orca.panels.handle('task.hand', async ({ project, root, task, agent, mode }) => {
      const list = await conport<TaskList>(['task', 'list', '--project', project, '--json'], root)
      if (!list.ok) return list
      const found = list.data.tasks.find((t) => t.id === task)
      if (!found) return fail('task_not_found', `задачи ${task} нет среди открытых задач вне эпиков`, 'нажмите «Обновить»')
      if (handMode(found) !== mode) {
        const moved = { do: `задачу ${task} уже взяли в работу`, review: `задача ${task} не ждёт проверки`, fix: `задача ${task} не ждёт исправлений` }
        return fail('task_moved', moved[mode], 'нажмите «Обновить»')
      }
      const title = `conport ${{ do: 'task', review: 'review', fix: 'fix' }[mode]} ${task}`
      const order = handTask({ task, project: list.data.project, mode, agent, root })
      return rememberAgent(project, agent, await startAgent(root, agent, title, order))
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
