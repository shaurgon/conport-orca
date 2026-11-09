// What the panel and the status bar say. Shared by the worker and the panel: no Node imports.
import type { EpicRole, EpicStatus, RunPhase, TaskStage } from './protocol'

export const PHASE: Record<RunPhase, string> = {
  none: 'не запускался',
  preparing: 'подготовка',
  running: 'идёт',
  finishing: 'завершение',
  held: 'держится',
  ready: 'готов',
  stopped: 'остановлен'
}

/** The phases while the run is alive: the board is read again while one of them lasts. */
export const ACTIVE_PHASES: readonly RunPhase[] = ['preparing', 'running', 'finishing']

export function stageLabel(stage: TaskStage, round: number): string {
  switch (stage) {
    case 'waiting':
      return 'ждёт'
    case 'implementing':
      return 'исполняется'
    case 'review':
      return 'проверка'
    case 'fixing':
      return `исправление круг ${round}`
    case 'merging':
      return 'слияние'
    case 'done':
      return 'готова'
    case 'stopped':
      return 'стоп'
  }
}

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
  gapHunter: 'Искатель пробелов',
  finalReviewer: 'Итоговый проверяющий'
} as const

export const PERMISSION_REMINDER =
  'Режим разрешений агентов берётся из настроек Orca и самих агентов. ' +
  'Агент, который спрашивает разрешение на каждую команду, будет останавливать прогон.'

/** What the gap hunter and the final reviewer do, as the board names it. */
export const EPIC_ROLE_WORK: Record<EpicRole, string> = {
  'gap-hunter': 'поиск пробелов',
  'final-reviewer': 'итоговая проверка'
}

/** The box of a held run that failed: why, and the one action. */
export const FAILURE_TITLE = 'Прогон прервался'
export const FAILURE_ACTION = 'Что сделать: '

/**
 * The one thing to do about an agent kind found neither on the PATH of Orca's app nor among the
 * agents of the focused workspace: once Orca runs it there, the worker sees it through the host.
 */
export const AGENT_MISSING_ACTION = 'запустите агента в этом рабочем месте Orca и нажмите «Обновить»'

export function doneCount(status: EpicStatus): number {
  return status.tasks.filter((t) => t.stage === 'done').length
}

/** "эпик <N>: готово/всего, вопросов K", and the gap hunt or the final review while one goes on. */
export function statusLine(status: EpicStatus): string {
  const line = `эпик ${status.epic}: ${doneCount(status)}/${status.tasks.length}, вопросов ${status.questions.length}`
  return status.epicRole ? `${line}, ${EPIC_ROLE_WORK[status.epicRole.role]}` : line
}
