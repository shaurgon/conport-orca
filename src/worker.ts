// The plugin's worker: runs the conport CLI and orca as child processes for the panel. It reads
// only when the panel asks: no timer, no status bar item, no notification — the state of the
// agents is Orca's own.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { CONPORT, commandLine, handTask, interpret, missingDocument, PREPARE_AGENTS, prepareTask, runCommand } from './cli'
import { runProcess } from './exec'
import type { AgentKind, EpicList, EpicRef, EpicStatus, OrcaProject, RepoContext, Result, Roles, TaskList } from './protocol'
import { AGENT_MISSING_ACTION, PREPARE_AGENTS_ACTION } from './text'

/** How the worker starts the two programs it drives. */
export interface WorkerDeps {
  conport: readonly string[]
  orca: readonly string[]
}

const TRUNCATED = (): { ok: false; error: { code: string; message: string; action: string } } =>
  fail('workspaces_truncated', 'Orca отдала неполный список рабочих мест', 'уберите лишние рабочие места из Orca и повторите')

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
        const list = await orcaCli<{ terminals?: Array<{ handle: string }> }>(['terminal', 'list', '--worktree', `path:${path}`])
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

    /** Reads the run of an epic once. */
    const readRun = (ref: EpicRef): Promise<Result<EpicStatus>> =>
      conport<EpicStatus>(['epic', 'status', String(ref.epic), '--project', ref.project, '--json'], ref.root)

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
    // terminal; a kind Orca runs is one `worker-start --agent` can start, found or not.
    const agentKinds = async (root: string): Promise<Result<AgentKind[]>> => {
      const answer = await conport<{ agents: AgentKind[] }>(['epic', 'agents', '--json'], root)
      if (!answer.ok) return answer
      const inOrca = await kindsInOrca()
      return { ok: true, data: answer.data.agents.map((a) => (a.found || !inOrca.has(a.id) ? a : { ...a, found: true })) }
    }

    orca.panels.handle('agents.get', async ({ project, root }) => {
      const agents = await agentKinds(root)
      if (!agents.ok) return agents
      const chosen = (await orca.storage.get(`roles:${project}`)) as Roles | null
      const preparer = await orca.storage.get(`prepare:${project}`)
      return { ok: true, data: { agents: agents.data, chosen, preparer: typeof preparer === 'string' ? preparer : null } }
    })

    /**
     * Brings a terminal to the front. When orca cannot, the panel has already named the terminal:
     * the failure is only logged.
     */
    const bringForward = async (terminal: string): Promise<void> => {
      const shown = await orcaCli(['terminal', 'switch', '--terminal', terminal])
      if (!shown.ok) orca.log(`terminal switch: ${shown.error.code}: ${shown.error.message}`)
    }

    /**
     * The command of an agent that can be told its task as its first argument and is found:
     * only such an agent starts a talk with the task it is given.
     */
    const agentCommand = async (root: string, agent: string): Promise<Result<string>> => {
      if (!PREPARE_AGENTS.includes(agent)) {
        return fail('agent_cannot_prepare', `агент «${agent}» не принимает задание при запуске`, PREPARE_AGENTS_ACTION)
      }
      const kinds = await agentKinds(root)
      if (!kinds.ok) return kinds
      const kind = kinds.data.find((a) => a.id === agent)
      if (!kind?.found) return fail('agent_not_found', `агент «${agent}» не найден`, AGENT_MISSING_ACTION)
      return { ok: true, data: kind.command }
    }

    /** Opens `agent` with its one task in a terminal of the root, and remembers the agent for the project. */
    const startAgent = async (
      { project, root, agent }: { project: string; root: string; agent: string },
      title: string,
      task: string
    ): Promise<Result<{ terminal: string }>> => {
      const command = await agentCommand(root, agent)
      if (!command.ok) return command
      const terminal = await terminalInRoot(root, title, commandLine([command.data, task]))
      if (!terminal.ok) return terminal
      // The person talks with the agent there: the terminal comes to the front.
      await bringForward(terminal.data)
      await orca.storage.set(`prepare:${project}`, agent)
      return { ok: true, data: { terminal: terminal.data } }
    }

    orca.panels.handle('run.get', (ref) => readRun(ref))

    orca.panels.handle('run.start', async ({ roles, ...ref }) => {
      const command = runCommand(ref.epic, ref.project, roles)
      const terminal = await terminalInRoot(ref.root, `conport epic ${ref.epic}`, command)
      if (!terminal.ok) return terminal
      // Refusals at the start are printed in that terminal: it comes to the front.
      await bringForward(terminal.data)
      await orca.storage.set(`roles:${ref.project}`, { ...roles })
      return { ok: true, data: { terminalId: terminal.data, command } }
    })

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
      return startAgent({ project, root, agent }, `conport prepare ${epic}`, prepareTask({ epic, project: list.data.project, missing }))
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
      if (found.status !== (mode === 'do' ? 'TODO' : 'REVIEW')) {
        return fail(
          'task_moved',
          mode === 'do' ? `задачу ${task} уже взяли в работу` : `задача ${task} не ждёт проверки`,
          'нажмите «Обновить»'
        )
      }
      const title = `conport ${mode === 'do' ? 'task' : 'review'} ${task}`
      return startAgent({ project, root, agent }, title, handTask({ task, project: list.data.project, mode, agent }))
    })

    orca.panels.handle('run.stop', async (ref) => {
      const answer = await conport(['epic', 'stop', String(ref.epic), '--project', ref.project, '--json'], ref.root)
      if (!answer.ok) return answer
      return readRun(ref)
    })
  }

  return { activate, deactivate }
}

const worker = createWorker({ conport: CONPORT, orca: ['orca'] })

export default function activate(orca: OrcaWorkerApi): void {
  worker.activate(orca)
}

export function deactivate(): void {
  worker.deactivate()
}
