// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario. The
// worker's answers are stubbed with the JSON of the conport CLI, so no scenario runs a process.
import { defineCheck } from 'orca/testing'
import { AGENTS, EMPTY_LIST, EPIC_LIST, EPIC_WITHOUT_PLAN, FAILED, idle, RUNNING, STOPPED, TASK_LIST } from '../test/fixtures'
import type { EpicList, EpicStatus, OrcaProject } from './protocol'

const ok = <T>(data: T) => ({ ok: true, data })
const ROOT = '/work/shop'
const PROJECTS: OrcaProject[] = [
  { name: 'Shop', root: ROOT, kind: 'git', project: 'shop-api', source: 'repository', focused: true },
  { name: 'Billing', root: '/work/billing', kind: 'git', project: 'billing-api', source: 'stored', focused: false },
  { name: 'Docs', root: '/work/docs', kind: 'git', project: null, source: null, focused: false },
  { name: 'Notes', root: '/work/notes', kind: 'folder', project: null, source: null, focused: false }
]
const ROLES = { implementer: 'claude', reviewer: 'codex', gapHunter: 'claude', finalReviewer: 'claude' }

/** The panel over `list`, on `tab`, with `epic` open and its run `status`. */
function scenario(list: EpicList, { tab = 'launch', epic = null, status = null }: { tab?: string; epic?: number | null; status?: EpicStatus | null } = {}) {
  return {
    requests: {
      'projects.list': () => ok(PROJECTS),
      'epics.list': () => ok(list),
      'tasks.list': () => ok(TASK_LIST.tasks),
      'agents.get': () => ok({ agents: AGENTS.agents, chosen: ROLES, preparer: 'claude' }),
      'run.get': () => ok(status ?? idle(epic ?? 0))
    },
    persisted: { plugin: { tab, epics: epic === null ? {} : { [ROOT]: epic } } }
  }
}

export default defineCheck({
  'empty-project': scenario(EMPTY_LIST),
  'epics': scenario(EPIC_LIST),
  'prepare': scenario(EPIC_LIST, { tab: 'prepare' }),
  'epic-without-plan': scenario(EPIC_WITHOUT_PLAN, { tab: 'prepare' }),
  'tasks': scenario(EPIC_LIST, { tab: 'tasks' }),
  'ready-to-run': scenario(EPIC_LIST, { epic: 15, status: idle(15) }),
  'running': scenario(EPIC_LIST, { epic: 7, status: RUNNING }),
  // A question Orca would not take: the epic waits for the person's answer by the command.
  'question-not-taken': scenario(EPIC_LIST, { epic: 7, status: { ...RUNNING, questions: [{ task: 12, case: 1, refused: true }] } }),
  'failed': scenario(EPIC_LIST, { epic: 7, status: FAILED }),
  'stopped': scenario(EPIC_LIST, { epic: 7, status: STOPPED }),
  'no-project': {
    requests: {
      'projects.list': () => ok(PROJECTS.map((p) => (p.root === ROOT ? { ...p, project: null, source: null } : p)))
    }
  }
})
