// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario. The
// worker's answers are stubbed with the JSON of the conport CLI, so no scenario runs a process.
import { defineCheck } from 'orca/testing'
import {
  AGENTS,
  CURSOR,
  EMPTY_LIST,
  EPIC_LIST,
  EPIC_TASKS,
  EPIC_WITHOUT_PLAN,
  session,
  SESSION_ALIVE,
  SESSION_COPY,
  SESSION_WORKFLOW,
  SUBAGENTS,
  TASK_LIST,
  untyped
} from '../test/fixtures'
import type { EpicList, EpicSession, OrcaProject, Result } from './protocol'

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const ROOT = '/work/shop'
const PROJECTS: OrcaProject[] = [
  { name: 'Shop', root: ROOT, kind: 'git', project: 'shop-api', source: 'repository', focused: true },
  { name: 'Billing', root: '/work/billing', kind: 'git', project: 'billing-api', source: 'stored', focused: false },
  { name: 'Docs', root: '/work/docs', kind: 'git', project: null, source: null, focused: false },
  { name: 'Notes', root: '/work/notes', kind: 'folder', project: null, source: null, focused: false }
]
/** As the CLI refuses when Claude Code cannot be asked for its plugins. */
const NO_SUBAGENTS: Result<never> = {
  ok: false,
  error: {
    code: 'subagents_unavailable',
    message: 'claude plugin list did not answer',
    action: 'install Claude Code or make claude visible on the PATH, then run the command again'
  }
}

interface Shown {
  tab?: string
  epic?: number | null
  /** What `epic.session` answers for the open epic. */
  state?: EpicSession
  /** The subagent types cannot be read. */
  noSubagents?: boolean
}

/** The panel over `list`, on `tab`, with `epic` open and its session `state`. */
function scenario(list: EpicList, { tab = 'launch', epic = null, state = session(), noSubagents = false }: Shown = {}) {
  return {
    requests: {
      'projects.list': () => ok(PROJECTS),
      'epics.list': () => ok(list),
      'tasks.list': () => ok(TASK_LIST.tasks),
      'agents.get': () => ok({ agents: [...AGENTS.agents, CURSOR], preparer: 'claude' }),
      'epic.session': () => ok(state),
      'epic.tasks': () => ok(EPIC_TASKS),
      'subagents.get': ({ harness }: { harness: string }) =>
        noSubagents ? NO_SUBAGENTS : ok(harness === 'claude' ? SUBAGENTS : untyped(harness))
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
  'epic-new': scenario(EPIC_LIST, { epic: 15 }),
  'epic-copy-no-session': scenario(EPIC_LIST, { epic: 7, state: SESSION_COPY }),
  'epic-session-alive': scenario(EPIC_LIST, { epic: 7, state: SESSION_ALIVE }),
  'epic-workflow': scenario(EPIC_LIST, { epic: 7, state: SESSION_WORKFLOW }),
  // The workflow is Claude Code's alone: the start is off and says what to choose.
  'epic-workflow-not-claude': scenario(EPIC_LIST, { epic: 7, state: session({ way: 'workflow', harness: 'codex' }) }),
  'epic-roles-unavailable': scenario(EPIC_LIST, { epic: 15, noSubagents: true }),
  // A harness whose subagents have no types: the roles go by the texts of the CLI.
  'epic-codex': scenario(EPIC_LIST, { epic: 15, state: session({ harness: 'codex' }) }),
  'no-project': {
    requests: {
      'projects.list': () => ok(PROJECTS.map((p) => (p.root === ROOT ? { ...p, project: null, source: null } : p)))
    }
  }
})
