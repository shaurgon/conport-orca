// What the panel says. Shared by the worker and the panel: no Node imports.
import type { EpicSummary, HandMode, Milestone, OutsideTask, RunPhase } from './protocol'

/** The phases while the agents of an epic are at work. */
export const ACTIVE_PHASES: readonly RunPhase[] = ['preparing', 'running', 'finishing']

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

/** Where the agents of an epic were started, and where a refusal at the start shows. */
export const startNotice = (epic: number, project: string): string =>
  `Агенты начинают работу в терминале «conport epic ${epic}» репозитория «${project}»; если запуск откажет, причина будет там. ` +
  'Нажмите «Обновить», чтобы увидеть, что агенты работают.'

/** Why a project of Orca that is a plain folder cannot run an epic. */
export const FOLDER_NOTE = 'Папка без git — запускать нечего'

/** The six cases of the stop list. */
export const CASES: Record<number, string> = {
  1: 'Нужна необратимая операция',
  2: 'Исправления не сошлись',
  3: 'Конфликт без догадки',
  4: 'Эпик вырос больше чем на 30%',
  5: 'Агент дважды ушёл',
  6: 'Агент ждёт человека'
}

export const ROLE_TITLES = {
  implementer: 'Исполнитель',
  reviewer: 'Проверяющий',
  gapHunter: 'Поиск пробелов',
  finalReviewer: 'Итоговая проверка'
} as const

/**
 * Under the team of an epic: whose rights the agents use, where their state is, and that an agent
 * asking leave for every command stops the work until it is answered.
 */
export const TEAM_NOTE =
  'Агенты работают с правами из настроек Orca и самих агентов, в ветке эпика; в основную ветку вливаете вы. ' +
  'Состояние агентов и их вопросы — в Orca. ' +
  'Агент, который спрашивает разрешение на каждую команду, будет останавливать работу над эпиком, пока вы ему не ответите.'

/** Where the agents of an epic at work are watched and answered. */
export const AT_WORK_NOTE = 'Состояние и вопросы агентов — в Orca: в списке проектов и на панели агентов. Там же отвечайте на вопросы.'

/** What stopping the agents keeps. */
export const STOP_NOTE = 'Сделанное останется в ветке эпика; «Продолжить» запустит агентов снова с того же места'

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

/** The one action ending a failure text: after held agents, they are continued; after a refused action, it is repeated. */
const AGAIN = 'и нажмите «Продолжить»'
const REPEAT = 'и повторите'

/** What a failure means and the one thing to do, in Russian. */
export interface FailureText {
  what: string
  action: string
}

const ORCA_AWAY: FailureText = { what: 'Orca не ответила', action: `проверьте, что Orca запущена, {again}` }

/**
 * The refusals of the conport and orca CLIs by code: the failures `conport epic run` keeps in its
 * record and those of the panel's actions. The CLIs word them in English for a terminal: the
 * panel says them by their code.
 */
const FAILURES: Record<string, FailureText> = {
  gate_red: {
    what: 'гейт красный на голове ветки эпика ещё до запуска',
    action: `сделайте гейт зелёным на ветке эпика {again}`
  },
  epic_worktree_dirty: {
    what: 'в рабочей копии эпика есть незафиксированные изменения или незавершённое слияние',
    action: `зафиксируйте или уберите их в рабочей копии эпика {again}`
  },
  epic_held: {
    what: 'эпик ведут другие агенты или другой человек',
    action: 'дождитесь, пока они закончат, или договоритесь с тем, кто ведёт эпик'
  },
  run_mismatch: {
    what: 'агенты эпика запущены для другого проекта, другой версией CLI или в другой команде',
    action: 'продолжите их тем же проектом, версией и командой или остановите и запустите заново'
  },
  no_spec: { what: 'у эпика нет спецификации', action: `добавьте спецификацию эпика в ConPort {again}` },
  no_plan: { what: 'у эпика нет плана', action: `добавьте план эпика в ConPort {again}` },
  several_specs: { what: 'у эпика несколько спецификаций', action: `оставьте у эпика одну спецификацию {again}` },
  several_plans: { what: 'у эпика несколько планов', action: `оставьте у эпика один план {again}` },
  plan_unparsable: { what: 'план эпика не читается', action: `исправьте разметку плана в ConPort {again}` },
  section_without_task: {
    what: 'в плане есть разделы без задачи эпика',
    action: `заведите задачу эпика на каждый раздел плана {again}`
  },
  task_without_section: {
    what: 'у эпика есть открытые задачи без раздела плана',
    action: `добавьте их в план или закройте {again}`
  },
  no_gate_object: { what: 'в плане нет описания гейта', action: `добавьте в план объект гейта {again}` },
  gate_dir_outside: {
    what: 'гейт плана запускает команды вне рабочей копии',
    action: `укажите в гейте плана папку внутри репозитория {again}`
  },
  dependency_cycle: {
    what: 'задачи эпика зависят друг от друга по кругу',
    action: `разорвите круг зависимостей задач {again}`
  },
  not_an_epic: { what: 'выбранная задача не эпик', action: 'выберите в панели эпик' },
  no_project: { what: 'проект ConPort не назван', action: `привяжите проект в панели {again}` },
  project_not_found: {
    what: 'проект ConPort не найден',
    action: `проверьте привязку проекта в панели или CONPORT_PROJECT_NAME {again}`
  },
  no_api_key: { what: 'нет ключа API ConPort', action: `впишите CONPORT_API_KEY в ~/.config/conport/.env {again}` },
  conport_unreachable: { what: 'ConPort не ответил', action: `проверьте сеть {again}` },
  host_unavailable: ORCA_AWAY,
  runtime_unavailable: ORCA_AWAY,
  runtime_timeout: ORCA_AWAY,
  worktree_list_truncated: {
    what: 'Orca отдала неполный список рабочих мест',
    action: `уберите лишние рабочие места из Orca {again}`
  },
  unexpected_answer: { what: 'Orca ответила не так, как ждёт CLI', action: `обновите Orca {again}` },
  record_busy: { what: 'запись агентов эпика занята другой командой', action: 'подождите минуту и нажмите «Продолжить»' },
  invalid_argument: { what: 'CLI не принял команду запуска', action: `обновите плагин {again}` },
  no_cli_version: { what: 'CLI не знает своей версии', action: `обновите плагин {again}` },
  // Refusals of the actions on the agents of an epic: reading their state and Stop.
  no_run: { what: 'агенты над эпиком не запускались', action: 'нажмите «Запустить»' },
  workers_not_stopped: {
    what: 'агенты эпика остановлены не все',
    action: 'остановите оставшихся агентов эпика в Orca'
  }
}

/** The text of a known code with its "{again}" said as `again`; undefined for a code not known. */
function known(code: string, again: string): FailureText | undefined {
  const text = FAILURES[code] ?? httpText(code)
  return text ? { what: text.what, action: text.action.replace('{again}', again) } : undefined
}

/** A status of ConPort the panel can act on: the key refused, or ConPort failing. */
function httpText(code: string): FailureText | undefined {
  const http = /^http_(\d{3})$/.exec(code)
  const status = http ? Number(http[1]) : 0
  if (status === 401 || status === 403) {
    return { what: 'ConPort не принял ключ API', action: 'проверьте CONPORT_API_KEY в ~/.config/conport/.env {again}' }
  }
  if (status >= 500) return { what: 'ConPort ответил ошибкой', action: 'подождите несколько минут {again}' }
  return undefined
}

/** A failure the panel does not know: the terminal of the agents printed it whole. */
function unknownFailure(epic: number): FailureText {
  return {
    what: 'агенты остановились по причине, которой панель не знает',
    action: `посмотрите вывод в терминале «conport epic ${epic}» корня репозитория ${AGAIN}`
  }
}

/** The title of the box that says the epic waits for the person: a question Orca did not take. */
export const UNASKED_TITLE = 'Эпик ждёт вашего ответа'

/**
 * A question Orca did not take, said as what the epic waits for: the task it is about and the one
 * action, to answer it by the command shown under it — and, while the agents are not at work, to
 * continue them, as only working agents take the answer. The question itself is not shown: the
 * command named by `hint` prints it with its options.
 */
export function unaskedText(task: number | null, atWork: boolean): FailureText & { hint: string } {
  return {
    what: `Orca не приняла вопрос по ${task === null ? 'эпику' : `задаче ${task}`}, и в Orca его нет.`,
    action: `ответьте на него в терминале репозитория командой ниже${atWork ? '' : ', затем нажмите «Продолжить»'}`,
    hint: 'Вопрос и варианты ответа печатает команда'
  }
}

/** The title of the box that says why the agents of an epic stopped. */
export const FAILURE_TITLE = 'Агенты остановились'
export const FAILURE_ACTION = 'Что сделать: '

/** Why the agents of an epic stopped and what to do, by the code of the failure; never the English of the CLI. */
export function failureText(code: string, epic: number): FailureText {
  return known(code, AGAIN) ?? unknownFailure(epic)
}

/**
 * The refusals the worker words itself, in Russian: shown as they are. Every other refusal comes
 * from the conport or orca CLI, in English, or names a program that could not start.
 */
const OWN_REFUSALS = new Set([
  'workspaces_truncated',
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
  return (
    known(refusal.code, REPEAT) ?? {
      what: 'программа отказала по причине, которой панель не знает',
      action: 'нажмите «Обновить»; если отказ повторится, обновите плагин и Orca'
    }
  )
}

/** The numbers of a CLI list of task references, without their `task-` prefix. */
const numbersOf = (text: string): string => text.replace(/task-/g, '')

/**
 * What holds an epic, as the CLI words each reason in English, and the Russian the panel says
 * instead. The first pattern that matches wins.
 */
const HOLD_REASONS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^task-(\d+) is (\S+) outside this run$/, (m) => `задача ${m[1]} в статусе ${m[2]} вне работы этих агентов`],
  [/^task-(\d+) is (\S+)$/, (m) => `задача ${m[1]} в статусе ${m[2]}`],
  [/^task-(\d+): the person is asked \(stop-list case (\d+)/, (m) => `задача ${m[1]}: вопрос к человеку, ${caseName(m[2])}`],
  [/^the epic: the person is asked \(stop-list case (\d+)/, (m) => `эпик: вопрос к человеку, ${caseName(m[1])}`],
  [/^task-(\d+) waits for the epic's question$/, (m) => `задача ${m[1]} ждёт ответа на вопрос эпика`],
  [/^task-(\d+) waits for (.+)$/, (m) => `задача ${m[1]} ждёт задач ${numbersOf(m[2] ?? '')}`],
  [/^the gate is red on the head of /, () => 'гейт красный на голове ветки эпика'],
  [/^the gate is red on \S+ with (\S+) merged in/, (m) => `гейт красный на ветке эпика после слияния ${m[1]}`],
  [
    /^plan section (\S+) «(.*)» has no closed task: task-(\d+) left the epic$/,
    (m) => `у раздела плана ${m[1]} «${m[2]}» нет закрытой задачи: задача ${m[3]} ушла из эпика`
  ],
  [/^merging (\S+) into \S+ conflicts in (.+)$/, (m) => `слияние ${m[1]} в ветку эпика даёт конфликт в ${m[2]}`],
  [/^the trial merge of (\S+) could not run/, (m) => `пробное слияние ${m[1]} в ветку эпика не запустилось`],
  [/^no run of epic \S+ is going/, () => 'агенты эпика не работают: нажмите «Продолжить»']
]

function caseName(no: string | undefined): string {
  const name = CASES[Number(no)]
  return name ? `случай стоп-листа «${name}»` : `случай стоп-листа ${no}`
}

/** One reason that holds an epic, in Russian; one the panel does not know is not shown as is. */
export function holdReason(reason: string, epic: number): string {
  for (const [pattern, say] of HOLD_REASONS) {
    const m = pattern.exec(reason)
    if (m) return say(m)
  }
  return `причина, которой панель не знает: посмотрите вывод в терминале «conport epic ${epic}» корня репозитория`
}

/**
 * The one thing to do about an agent kind found neither on the PATH of Orca's app nor among the
 * agents of the focused workspace: once Orca runs it there, the worker sees it through the host.
 */
export const AGENT_MISSING_ACTION = 'запустите агента в этом рабочем месте Orca и нажмите «Обновить»'
