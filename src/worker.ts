// The plugin's worker: runs the conport CLI and orca as child processes for the panel, keeps
// the board of the watched epic current in the status bar, and tells about new questions.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { CONPORT, interpret, journalCommand, runCommand } from './cli'
import { runProcess } from './exec'
import type { AgentKind, EpicRef, EpicStatus, RepoContext, Result, Roles } from './protocol'
import { ACTIVE_PHASES, PHASE, statusLine } from './text'

/** How the worker starts the two programs it drives, and how often it reads the board. */
export interface WorkerDeps {
  conport: readonly string[]
  orca: readonly string[]
  timing?: Partial<Timing>
}

interface Timing {
  /** How often the board of a live run is read again. */
  pollMs: number
  /** The delay before reading the board after a run starts or an agent changes state. */
  nudgeMs: number
  /** How long a started run may show no phase (the CLI is being fetched, preflight runs). */
  startGraceMs: number
}

const TIMING: Timing = { pollMs: 15_000, nudgeMs: 3_000, startGraceMs: 180_000 }
const STATUS_ITEM = 'run'
const WATCH_KEY = 'watch'

const TRUNCATED = (): { ok: false; error: { code: string; message: string; action: string } } =>
  fail('workspaces_truncated', 'Orca отдала неполный список рабочих мест', 'уберите лишние рабочие места из Orca и повторите')

const normalize = (path: string): string => path.replace(/\/+$/, '')
const branchName = (branch: string | null): string => (branch ?? '').replace(/^refs\/heads\//, '')

const fail = (code: string, message: string, action = ''): { ok: false; error: { code: string; message: string; action: string } } => ({
  ok: false,
  error: { code, message, action }
})

function sameRef(a: EpicRef | null, b: EpicRef): boolean {
  return a !== null && a.project === b.project && a.epic === b.epic && a.root === b.root
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
  const timing: Timing = { ...TIMING, ...deps.timing }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const deactivate = (): void => {
    stopped = true
    clearTimeout(timer)
  }

  const activate = (orca: OrcaWorkerApi): void => {
    stopped = false
    let watch: EpicRef | null = null
    let livePhase = false
    /** When the panel last started a run of the watched epic. */
    let startedAt = 0
    const asked = new Set<string>()

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
      if (workspace) {
        return fail(
          'workspace_ambiguous',
          `в Orca несколько рабочих мест «${focus.displayName}», какое в фокусе — не понять`,
          'переименуйте одно из них в Orca'
        )
      }
      if (truncated) return TRUNCATED()
      return fail('no_workspace', `рабочего места «${focus.displayName}» нет в списке Orca`, 'откройте рабочее место репозитория')
    }

    const repoRoot = async (): Promise<Result<string>> => {
      const focused = await focusedPath()
      if (!focused.ok) return focused
      const shown = await orcaCli<{ worktree?: { repoId?: string } }>(['worktree', 'show', '--worktree', `path:${focused.data}`])
      if (!shown.ok) return shown
      const repoId = shown.data.worktree?.repoId
      if (!repoId) return fail('no_repository', 'рабочее место в фокусе не принадлежит репозиторию', 'откройте рабочее место репозитория')
      const repo = await orcaCli<{ repo?: { path?: string } }>(['repo', 'show', '--repo', `id:${repoId}`])
      if (!repo.ok) return repo
      const path = repo.data.repo?.path
      if (!path) return fail('bad_output', 'orca не назвал путь репозитория', 'обновите Orca')
      return { ok: true, data: path }
    }

    const contextOf = async (root: string): Promise<Result<RepoContext>> => {
      const fromRepository = await repositoryProject(root)
      if (fromRepository) return { ok: true, data: { root, project: fromRepository, source: 'repository' } }
      const stored = await orca.storage.get(`project:${root}`)
      if (typeof stored === 'string' && stored !== '') {
        return { ok: true, data: { root, project: stored, source: 'stored' } }
      }
      return { ok: true, data: { root, project: null, source: null } }
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

    const showStatus = async (board: Result<EpicStatus>, epic: number): Promise<void> => {
      const update = board.ok
        ? {
            id: STATUS_ITEM,
            text: statusLine(board.data),
            tone: board.data.questions.length > 0 ? ('warning' as const) : ('neutral' as const),
            tooltip: `ConPort: прогон эпика ${epic} — ${PHASE[board.data.phase]}`,
            visible: board.data.phase !== 'none'
          }
        : {
            id: STATUS_ITEM,
            text: `эпик ${epic}: нет ответа`,
            tone: 'danger' as const,
            tooltip: `${board.error.message} — ${board.error.action}`,
            visible: true
          }
      try {
        await orca.host.call('statusBar.update', update)
      } catch (error) {
        orca.log(`status bar: ${String(error)}`)
      }
    }

    const tellQuestions = async (status: EpicStatus): Promise<void> => {
      for (const q of status.questions) {
        const key = `${status.epic}:${q.task ?? 'epic'}:${q.case}:${q.text}`
        if (asked.has(key)) continue
        asked.add(key)
        const about = q.task === null ? 'вопрос по эпику' : `вопрос по задаче ${q.task}`
        try {
          await orca.host.call('notifications.show', { title: `Эпик ${status.epic}: ${about}`, body: q.text })
        } catch (error) {
          orca.log(`notification: ${String(error)}`)
        }
      }
    }

    const schedule = (delay: number): void => {
      clearTimeout(timer)
      if (stopped || watch === null) return
      const ref = watch
      timer = setTimeout(() => void refresh(ref), delay)
      timer.unref?.()
    }

    /** Reads the board; for the watched epic also updates the status bar and the open panels. */
    const refresh = async (ref: EpicRef): Promise<Result<EpicStatus>> => {
      const board = await conport<EpicStatus>(
        ['epic', 'status', String(ref.epic), '--project', ref.project, '--json'],
        ref.root
      )
      if (stopped || !sameRef(watch, ref)) return board
      // A read that failed (ConPort or the network away) keeps the phase last read: a live run stays watched.
      if (board.ok) livePhase = ACTIVE_PHASES.includes(board.data.phase)
      const starting = board.ok && board.data.phase === 'none' && Date.now() - startedAt < timing.startGraceMs
      await showStatus(board, ref.epic)
      if (board.ok) await tellQuestions(board.data)
      orca.panels.post('board.changed', { project: ref.project, epic: ref.epic, board })
      if (livePhase || starting) schedule(timing.pollMs)
      return board
    }

    const watchEpic = async (ref: EpicRef): Promise<void> => {
      if (!sameRef(watch, ref)) {
        asked.clear()
        startedAt = 0
      }
      watch = { project: ref.project, root: ref.root, epic: ref.epic }
      await orca.storage.set(WATCH_KEY, { project: ref.project, root: ref.root, epic: ref.epic })
    }

    orca.panels.handle('context.get', async () => {
      const root = await repoRoot()
      return root.ok ? contextOf(root.data) : root
    })

    orca.panels.handle('project.set', async ({ root, project }) => {
      const value = project.trim()
      if (value === '') return fail('empty_project', 'проект не назван', 'впишите имя или handle проекта')
      await orca.storage.set(`project:${root}`, value)
      return contextOf(root)
    })

    orca.panels.handle('project.forget', async ({ root }) => {
      await orca.storage.delete(`project:${root}`)
      return contextOf(root)
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
    orca.panels.handle('agents.get', async ({ project, root }) => {
      const answer = await conport<{ agents: AgentKind[] }>(['epic', 'agents', '--json'], root)
      if (!answer.ok) return answer
      const inOrca = await kindsInOrca()
      const agents = answer.data.agents.map((a) => (a.found || !inOrca.has(a.id) ? a : { ...a, found: true }))
      const chosen = (await orca.storage.get(`roles:${project}`)) as Roles | null
      return { ok: true, data: { agents, chosen } }
    })

    orca.panels.handle('board.get', async (ref) => {
      await watchEpic(ref)
      return refresh(ref)
    })

    orca.panels.handle('run.start', async ({ roles, ...ref }) => {
      const command = runCommand(ref.epic, ref.project, roles)
      const title = `conport epic ${ref.epic}`
      const terminal = await terminalInRoot(ref.root, title, command)
      if (!terminal.ok) return terminal
      // Preflight refusals of the run are printed in that terminal: bring it forward, or say where it is.
      const shown = await orcaCli(['terminal', 'switch', '--terminal', terminal.data])
      if (!shown.ok) {
        try {
          await orca.host.call('notifications.show', {
            title: `Эпик ${ref.epic}: прогон запущен`,
            body: `Терминал «${title}» в корне репозитория: там видно, если прогон откажет при подготовке.`
          })
        } catch (error) {
          orca.log(`notification: ${String(error)}`)
        }
      }
      await orca.storage.set(`roles:${ref.project}`, { ...roles })
      await watchEpic(ref)
      startedAt = Date.now()
      schedule(timing.nudgeMs)
      return { ok: true, data: { terminalId: terminal.data, command } }
    })

    orca.panels.handle('run.answer', async ({ task, choice, ...ref }) => {
      const args = ['epic', 'answer', String(ref.epic)]
      if (task !== null) args.push('--task', String(task))
      args.push('--choice', choice, '--project', ref.project, '--json')
      const answer = await conport(args, ref.root)
      if (!answer.ok) return answer
      return refresh(ref)
    })

    orca.panels.handle('run.stop', async (ref) => {
      const answer = await conport(['epic', 'stop', String(ref.epic), '--project', ref.project, '--json'], ref.root)
      if (!answer.ok) return answer
      return refresh(ref)
    })

    orca.panels.handle('task.open', async ({ worktree }) => {
      const list = await orcaCli<{ terminals?: Array<{ handle: string }> }>([
        'terminal',
        'list',
        '--worktree',
        `path:${worktree}`
      ])
      if (!list.ok) return list
      const handle = list.data.terminals?.[0]?.handle
      if (handle) {
        const shown = await orcaCli(['terminal', 'switch', '--terminal', handle])
        return shown.ok ? { ok: true, data: { terminal: handle } } : shown
      }
      const created = await orcaCli<{ terminal?: { handle?: string } }>([
        'terminal',
        'create',
        '--worktree',
        `path:${worktree}`,
        '--focus'
      ])
      if (!created.ok) return created
      return { ok: true, data: { terminal: created.data.terminal?.handle ?? '' } }
    })

    orca.panels.handle('task.journal', async ({ project, root, task }) => {
      const terminal = await terminalInRoot(root, `журнал задачи ${task}`, journalCommand(task, project))
      return terminal.ok ? { ok: true, data: { terminalId: terminal.data } } : terminal
    })

    // An agent of the run changed state: the board likely changed too.
    orca.events.on('agent.status.changed', () => {
      if (livePhase) schedule(timing.nudgeMs)
    })

    // Bring back the watched epic after a restart, or hide the status bar item.
    void (async () => {
      const saved = (await orca.storage.get(WATCH_KEY)) as EpicRef | null
      if (saved && typeof saved.epic === 'number') {
        watch = saved
        await refresh(saved)
      } else {
        await orca.host.call('statusBar.update', { id: STATUS_ITEM, visible: false }).catch(() => undefined)
      }
    })()
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
