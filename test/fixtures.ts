// Answers of `conport epic ... --json` in the shape the CLI prints them, for the tests and the
// check scenarios.
import type { AgentKind, EpicList, EpicStatus, Refusal } from '../src/protocol'

export const HANDLE = 'prk7m2qx9d'

export const EPIC_LIST: EpicList = {
  project: HANDLE,
  epics: [
    {
      id: 7,
      title: 'Search by meaning',
      milestone: { id: 3, title: 'Release 2.4' },
      runnable: true,
      reason: null,
      run: { phase: 'running' }
    },
    {
      id: 9,
      title: 'Archive export',
      milestone: { id: 3, title: 'Release 2.4' },
      runnable: false,
      reason: 'нет плана',
      run: null
    },
    {
      id: 15,
      title: 'Offline mode',
      milestone: null,
      runnable: true,
      reason: null,
      run: null
    }
  ]
}

export const EPIC_WITHOUT_PLAN: EpicList = {
  project: HANDLE,
  epics: [
    {
      id: 9,
      title: 'Archive export',
      milestone: { id: 3, title: 'Release 2.4' },
      runnable: false,
      reason: 'нет плана',
      run: null
    }
  ]
}

export const EMPTY_LIST: EpicList = { project: HANDLE, epics: [] }

export const AGENTS: { agents: AgentKind[] } = {
  agents: [
    { id: 'claude', label: 'Claude Code', command: 'claude', found: true },
    { id: 'codex', label: 'Codex', command: 'codex', found: true },
    { id: 'gemini', label: 'Gemini CLI', command: 'gemini', found: false }
  ]
}

export const RUNNING: EpicStatus = {
  epic: 7,
  phase: 'running',
  tasks: [
    { id: 11, title: 'Index the documents', stage: 'done', agent: 'codex', round: 1, worktree: null },
    { id: 12, title: 'Query endpoint', stage: 'merging', agent: 'codex', round: 1, worktree: '/repo/.wt/query-endpoint' },
    { id: 13, title: 'Ranking', stage: 'fixing', agent: 'claude', round: 2, worktree: '/repo/.wt/ranking' },
    { id: 14, title: 'Search page', stage: 'review', agent: 'claude', round: 1, worktree: '/repo/.wt/search-page' },
    { id: 16, title: 'Highlight matches', stage: 'implementing', agent: 'codex', round: 1, worktree: '/repo/.wt/highlight' },
    { id: 17, title: 'Docs', stage: 'waiting', agent: null, round: 0, worktree: null }
  ],
  questions: [],
  outcome: null,
  paused: 'гейт на голове ветки эпика красный: npm test',
  failure: null
}

/** A run that broke off on what waiting cannot cure: the record keeps why. */
export const FAILED: EpicStatus = {
  ...RUNNING,
  phase: 'held',
  paused: null,
  outcome: { kind: 'held', reasons: ['no run of this epic is going: start it again with conport epic run 7'] },
  failure: {
    code: 'gate_red',
    message: 'the gate is red on the head of the epic branch before the start',
    action: 'make the gate green on the epic branch, then start the run again'
  }
}

export const QUESTION: EpicStatus = {
  ...RUNNING,
  paused: null,
  questions: [
    {
      task: 13,
      case: 1,
      text: 'Нужно удалить колонку rank_legacy из таблицы documents.',
      options: ['разрешить', 'запретить, решить иначе', 'снять задачу']
    }
  ]
}

export const NO_KEY: Refusal = {
  code: 'no_api_key',
  message: 'нет ключа API ConPort',
  action: 'впишите CONPORT_API_KEY в ~/.config/conport/.env'
}
