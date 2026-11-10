// What the panel says. Shared by the worker and the panel: no Node imports.
import { FIXER_TYPE } from './cli'
import type { EpicSummary, EpicTask, EpicTaskStatus, HandMode, Milestone, OutsideTask, Roles, Way } from './protocol'

/** The Russian word for `n` things: `one` for 1, 21…; `few` for 2–4, 22…; `many` for the rest. */
export function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100
  const units = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

/** What a release milestone holds: its open epics, or that it is ready to close. */
export function releaseLine(milestone: Milestone): string {
  if (milestone.ready_to_close) return 'Выпуск · готова к закрытию'
  const n = milestone.open_epics
  return `Выпуск · ${n} ${plural(n, 'эпик открыт', 'эпика открыто', 'эпиков открыто')}`
}

/** The group of the epics outside a milestone. */
export const NO_MILESTONE = 'Без вехи'

/** Where an epic stands, from its tasks in ConPort. */
export interface EpicState {
  line: string
  /** The share of closed tasks, 0–100, for an epic in progress; null otherwise. */
  share: number | null
  closed: number
  total: number
}

/**
 * Where an epic stands in ConPort: ready to merge by the readiness entry of the core; in progress
 * once the epic is taken or a task is closed; else not started.
 */
export function epicState(epic: EpicSummary): EpicState {
  const { open, total } = epic.progress
  const closed = total - open
  if (epic.ready) return { line: `Готов к вливанию · ${closed} из ${total} закрыто`, share: null, closed, total }
  if (epic.status === 'IN_PROGRESS' || closed > 0) {
    const share = total > 0 ? Math.round((closed / total) * 100) : 0
    return { line: `В работе · ${closed} из ${total} закрыто`, share, closed, total }
  }
  return { line: `Не начат · ${total} ${plural(total, 'задача', 'задачи', 'задач')}`, share: null, closed, total }
}

/** What an epic that cannot start lacks, said on its row in the tab «Подготовить». */
export const PREPARE_STATE = {
  spec: 'Нет спецификации',
  plan: 'Спецификация есть, нет плана',
  other: 'Не готов к запуску по другой причине'
} as const

/** What «Подготовить» does for an epic without a spec or a plan. */
export const PREPARE_HINT =
  'Агент обсудит эпик с вами, напишет спецификацию и план — после этого эпик появится во вкладке «К запуску».'

/** What to do about an agent that cannot be told its task: choose one of those that can. */
export const PREPARE_AGENTS_ACTION = 'выберите Claude Code, Codex или Cursor'

/** Why no agent can be chosen in the sheet: none of those that take a task is found. */
export const NO_TASK_AGENT = 'Задание принимают Claude Code, Codex или Cursor, и ни один из них не найден:'

/** Where the preparation of an epic went, and what to do once it is over. */
export const prepareNotice = (epic: number, project: string): string =>
  `Подготовка эпика ${epic} открыта в терминале «conport prepare ${epic}» репозитория «${project}»: ` +
  'агент ждёт вас там. Когда план загружен в ConPort, нажмите «Обновить».'

/** Where a task handed to an agent went, and what comes of it. */
export function handNotice(task: number, mode: HandMode, project: string): string {
  if (mode === 'fix') {
    return (
      `Исправления задачи ${task} открыты в терминале «conport fix ${task}» репозитория «${project}»: агент ждёт вас там. ` +
      'Когда он запишет исправления в журнал, задача снова будет ждать проверки — нажмите «Обновить».'
    )
  }
  return mode === 'do'
    ? `Задача ${task} открыта в терминале «conport task ${task}» репозитория «${project}»: агент ждёт вас там. ` +
        'Работа ляжет в отдельную ветку задачи, вливаете её вы. ' +
        'Когда агент запишет отчёт, задача будет ждать проверки — нажмите «Обновить».'
    : `Проверка задачи ${task} открыта в терминале «conport review ${task}» репозитория «${project}»: ` +
        'агент запишет вердикт в журнал задачи и при одобрении с вашего согласия закроет её.'
}

/** Where the agent of an epic is: said once it is started, and on the screen of an epic whose session is alive. */
export const startNotice = (epic: number, way: Way): string =>
  way === 'sdd'
    ? `Агент эпика ${epic} открыт в терминале рабочей копии epic-${epic}; вопросы он задаёт там же`
    : `Агент эпика ${epic} открыт в терминале корня репозитория; вопросы он задаёт там же`

/** Why a project of Orca that is a plain folder cannot run an epic. */
export const FOLDER_NOTE = 'Папка без git — запускать нечего'

/** The four roles of an epic, each a subagent type of its harness. */
export const ROLE_TITLES: Record<keyof Roles, string> = {
  implementer: 'Исполнитель',
  reviewer: 'Ревьюер',
  gapHunter: 'Поиск пробелов',
  finalReviewer: 'Итоговое ревью'
}

/** The two ways an epic is done. */
export const WAY_LABELS: Record<Way, string> = { sdd: 'Навык SDD', workflow: '/conport:epic' }

/** Under the switch, by the workflow: what it does on its own. */
export const WORKFLOW_NOTE =
  'Поток работает в корне репозитория на основной ветке: начинает со своих проверок, вливает задачи в основную ветку и закрывает эпик сам'

/** Under the roles: who fixes what a review found is not chosen. */
export const FIXER_NOTE = `Правки — тот же исполнитель, иначе ${FIXER_TYPE}`

/** Why the role lists are off by the workflow. */
export const ROLES_FIXED_NOTE = 'Типы субагентов зашиты в потоке'

/** Why the role lists are off for a harness whose subagents have no types. */
export const ROLES_UNTYPED_NOTE = 'У этого харнесса нет субагентов с типами: роли идут по текстам conport agent <роль>'

/** Why the role lists are off when the subagent types cannot be read: `what` is the refusal, said in Russian. */
export const rolesUnavailableNote = (what: string): string => `Список субагентов недоступен: ${what}; роли пойдут исходными типами`

/** Beside a role whose type the list of the harness lacks. */
export const TYPE_MISSING_NOTE = 'тип не найден: установите или обновите плагин conport'

/** Under «Запустить» by the SDD skill, when the working copy of the epic is there and no agent is in it. */
export const COPY_NOTE = 'рабочая копия уже есть, агент продолжит с того места, где работа встала'

/** Under «Запустить» by the workflow, when branches of an earlier start of it are there. */
export const BRANCHES_NOTE = 'поток подхватит ветки прежнего запуска'

/** Under a «Запустить» that waits: the epic was started and its agent is not yet seen in the terminal. */
export const STARTED_NOTE = 'Агент открывается в терминале: нажмите «Обновить», чтобы увидеть его сессию'

/** Why the role lists are off for a harness that is not found: its subagent types are not asked for. */
export const ROLES_NO_HARNESS_NOTE = 'Харнесс не найден: типы его субагентов не читаются'

/** What a second start does while the session of the epic is alive: asked before it. */
export const RESTART_NOTE = 'Сессия эпика жива. Новый запуск откроет ещё одного агента с тем же заданием, прежний терминал останется открыт.'

/** The refusal `way_needs_claude`, said beside a start that cannot be pressed. */
export const WAY_NEEDS_CLAUDE = {
  what: 'Способ «/conport:epic» есть только у Claude Code с плагином conport',
  action: 'выберите харнесс Claude Code'
} as const

/** A status of a task of an epic, as its row says it. */
export const TASK_STATUS: Record<EpicTaskStatus, string> = {
  TODO: 'к выполнению',
  IN_PROGRESS: 'в работе',
  REVIEW: 'на проверке',
  BLOCKED: 'остановлена',
  PARKED: 'отложена',
  DONE: 'закрыта',
  CANCELLED: 'отменена'
}

/** The tasks of an epic by status; a cancelled one is in no count, nor in the total. */
export interface TaskCounts {
  todo: number
  inProgress: number
  review: number
  blocked: number
  parked: number
  done: number
  total: number
}

export function taskCounts(tasks: EpicTask[]): TaskCounts {
  const of = (status: EpicTaskStatus): number => tasks.filter((task) => task.status === status).length
  const counts = {
    todo: of('TODO'),
    inProgress: of('IN_PROGRESS'),
    review: of('REVIEW'),
    blocked: of('BLOCKED'),
    parked: of('PARKED'),
    done: of('DONE')
  }
  return { ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

/** The counts of an epic in one line; the parked ones only when there are some. */
export function taskCountsLine(counts: TaskCounts): string {
  const shown: Array<[EpicTaskStatus, number]> = [
    ['TODO', counts.todo],
    ['IN_PROGRESS', counts.inProgress],
    ['REVIEW', counts.review],
    ['BLOCKED', counts.blocked],
    ['PARKED', counts.parked],
    ['DONE', counts.done]
  ]
  return shown
    .filter(([status, n]) => status !== 'PARKED' || n > 0)
    .map(([status, n]) => `${TASK_STATUS[status]} ${n}`)
    .join(' · ')
}

/** The priority of a task, 1 to 5, in words. */
export const PRIORITY: Record<number, string> = {
  1: 'Критический',
  2: 'Высокий',
  3: 'Средний',
  4: 'Низкий',
  5: 'Фоновый'
}

/** A task outside the epics on its row: its priority while it waits, else its stage. */
export function taskState(task: OutsideTask): string {
  if (task.status === 'REVIEW') return 'На проверке'
  if (task.status === 'IN_PROGRESS') return task.changes_requested ? 'Ждёт исправлений после проверки' : 'В работе'
  return `${PRIORITY[task.priority] ?? 'Без приоритета'} · не начата`
}

/** What the agent opened from the sheet does, step by step. */
export const SHEET_STEPS = {
  spec: [
    'Обсуждает эпик с вами и пишет спецификацию',
    'После вашего «да» выгружает её в ConPort',
    'Пишет план, привязывает задачи эпика, импортирует план'
  ],
  plan: [
    'Читает спецификацию эпика и обсуждает план с вами',
    'Привязывает к плану открытые задачи эпика',
    'После вашего «да» импортирует план в ConPort'
  ],
  do: [
    'Берёт задачу в работу',
    'Делает её в своей ветке, в отдельной рабочей копии рядом с репозиторием, проверяет и фиксирует коммитами',
    'Пишет в журнал задачи отчёт с веткой и коммитом — задача уходит на проверку'
  ],
  review: [
    'Читает журнал задачи: бриф, отчёт, исправления',
    'Проверяет ветку из отчёта',
    'Записывает в журнал задачи проверку с вердиктом; при одобрении с вашего согласия закрывает задачу'
  ],
  fix: [
    'Читает журнал задачи и последнюю проверку с замечаниями',
    'Продолжает в ветке задачи, исправляет и фиксирует коммитами',
    'Пишет исправления в журнал задачи — задача снова уходит на проверку'
  ]
} as const

/** What a failure means and the one thing to do, in Russian. */
export interface FailureText {
  what: string
  action: string
}

const ORCA_AWAY: FailureText = { what: 'Orca не ответила', action: 'проверьте, что Orca запущена, и повторите' }

/**
 * The refusals of the conport and orca CLIs by code, for the commands the plugin runs. The CLIs
 * word them in English for a terminal, and orca names no action: the panel says them by their code.
 */
const FAILURES: Record<string, FailureText> = {
  no_project: { what: 'проект ConPort не назван', action: 'привяжите проект в панели и повторите' },
  project_not_found: {
    what: 'проект ConPort не найден',
    action: 'проверьте привязку проекта в панели или CONPORT_PROJECT_NAME и повторите'
  },
  no_api_key: { what: 'нет ключа API ConPort', action: 'впишите CONPORT_API_KEY в ~/.config/conport/.env и повторите' },
  conport_unreachable: { what: 'ConPort не ответил', action: 'проверьте сеть и повторите' },
  invalid_argument: { what: 'CLI не принял команду плагина', action: 'обновите плагин и повторите' },
  subagents_unavailable: {
    what: 'команда claude plugin list не ответила',
    action: 'установите Claude Code или сделайте claude видимым в PATH приложения Orca и повторите'
  },
  command_removed: { what: 'плагин вызвал команду, которой в CLI больше нет', action: 'обновите плагин' },
  runtime_unavailable: ORCA_AWAY,
  runtime_timeout: ORCA_AWAY,
  unexpected_answer: { what: 'Orca ответила не так, как ждёт плагин', action: 'обновите Orca и повторите' },
  terminal_not_found: { what: 'Orca не нашла терминал', action: 'нажмите «Обновить»' }
}

/** The text of a known code; undefined for a code not known. */
function known(code: string): FailureText | undefined {
  return FAILURES[code] ?? httpText(code)
}

/** A status of ConPort the panel can act on: the key refused, or ConPort failing. */
function httpText(code: string): FailureText | undefined {
  const http = /^http_(\d{3})$/.exec(code)
  const status = http ? Number(http[1]) : 0
  if (status === 401 || status === 403) {
    return { what: 'ConPort не принял ключ API', action: 'проверьте CONPORT_API_KEY в ~/.config/conport/.env и повторите' }
  }
  if (status >= 500) return { what: 'ConPort ответил ошибкой', action: 'подождите несколько минут и повторите' }
  return undefined
}

/** A refusal the panel does not know: what it says of it, and the one thing to do. */
const UNKNOWN_REFUSAL = 'программа отказала по причине, которой панель не знает'
const UNKNOWN_ACTION = 'нажмите «Обновить»; если отказ повторится, обновите плагин и Orca'

/**
 * The refusals the worker words itself, in Russian: shown as they are. Every other refusal comes
 * from the conport or orca CLI, in English, or names a program that could not start.
 */
const OWN_REFUSALS = new Set([
  'workspaces_truncated',
  'terminals_truncated',
  'project_not_handle',
  'session_gone',
  'harness_invalid',
  'workspace_ambiguous',
  'no_workspace',
  'no_repository',
  'root_not_open',
  'empty_project',
  'epic_not_found',
  'epic_ready',
  'epic_not_preparable',
  'task_not_found',
  'task_moved',
  'agent_not_found',
  'agent_cannot_prepare',
  'epic_not_ready',
  'way_needs_claude',
  'role_invalid',
  'root_detached',
  'epic_started_sdd',
  'epic_started_workflow',
  'epic_branch_taken',
  'git_failed',
  'bad_output',
  'worker'
])

/** What a refused action of the panel says: its own words, or the CLI's code said in Russian. */
export function refusalText(refusal: { code: string; message: string; action: string }): FailureText {
  if (OWN_REFUSALS.has(refusal.code)) return { what: refusal.message || refusal.code, action: refusal.action }
  // The worker words the action itself; its message carries the error of Node after the program.
  if (refusal.code === 'spawn_failed') {
    const program = /^([^:\s]+):/.exec(refusal.message)?.[1]
    return { what: program ? `не удалось запустить ${program}` : 'не удалось запустить программу', action: refusal.action }
  }
  const text = known(refusal.code)
  if (text) return text
  // Orca refuses with its own words and names no action: its words are shown as they are. A line
  // of an error stream that is no refusal (`cli_failed`) comes without an action too, and is not.
  const ofOrca = refusal.action === '' && refusal.code !== 'cli_failed' && refusal.message.trim() !== ''
  return { what: ofOrca ? refusal.message : UNKNOWN_REFUSAL, action: UNKNOWN_ACTION }
}

/**
 * The one thing to do about an agent kind found neither on the PATH of Orca's app nor among the
 * agents of the focused workspace: once Orca runs it there, the worker sees it through the host.
 */
export const AGENT_MISSING_ACTION = 'запустите агента в этом рабочем месте Orca и нажмите «Обновить»'

/** The same for the harness of an epic. */
export const HARNESS_MISSING_ACTION = 'запустите его в этом рабочем месте Orca и нажмите «Обновить»'
