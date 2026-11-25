// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario. The
// worker's answers are stubbed with the JSON of the conport CLI, so no scenario runs a process.
import { defineCheck } from 'orca/testing'
import {
  AGENTS,
  CURSOR,
  EMPTY_SDD,
  EPIC_TASKS,
  HANDLE,
  SDD_LIST,
  session,
  SESSION_ALIVE,
  SESSION_COPY,
  SUBAGENTS,
  TAKEN,
  untyped
} from '../test/fixtures'
import type { Assignee, EpicSession, IdeaRow, OrcaProject, Result, RowTarget, SddList } from './protocol'

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const ROOT = '/work/shop'
const PROJECTS: OrcaProject[] = [
  { name: 'Shop', root: ROOT, kind: 'git', project: 'shop-api', source: 'repository', lines: [], filesRead: true, focused: true },
  { name: 'Billing', root: '/work/billing', kind: 'git', project: 'billing-api', source: 'stored', lines: [], filesRead: true, focused: false },
  { name: 'Docs', root: '/work/docs', kind: 'git', project: null, source: null, lines: [], filesRead: true, focused: false },
  { name: 'Notes', root: '/work/notes', kind: 'folder', project: null, source: null, lines: [], filesRead: false, focused: false }
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

const idea = (id: number): IdeaRow => SDD_LIST.ideas.find((row) => row.id === id) as IdeaRow

/** Another member of the team: a shared team, the caller `me`. */
const ANN: Assignee = { handle: 'usann2345a', email: 'ann@example.com', former_member: false }

/** SDD_LIST in a shared team: idea 41 assigned ahead to the caller, idea 43 and epic 7 led by Ann. */
const LED: SddList = {
  ...SDD_LIST,
  me: 'usme234567',
  in_work: SDD_LIST.in_work.map((epic) => ({ ...epic, assignee: epic.id === 7 ? ANN : null })),
  ideas: SDD_LIST.ideas.map((row) => ({
    ...row,
    assignee: row.id === 43 ? ANN : row.id === 41 ? { handle: 'usme234567', email: 'me@example.com', former_member: false } : null
  }))
}
const [proposal] = SDD_LIST.proposals
const [specDoc] = SDD_LIST.specs

interface Shown {
  epic?: number | null
  /** What `epic.session` answers for the open epic. */
  state?: EpicSession
  /** The subagent types cannot be read. */
  noSubagents?: boolean
  /** The rows whose live terminal this host has, by their kind and number. */
  terminals?: string[]
  /** What else the panel remembered: the folded sections, an open sheet, a Take over asked. */
  plugin?: Record<string, unknown>
}

/** The panel over `list` with `epic` open and its session `state`. */
function scenario(list: SddList, { epic = null, state = session(), noSubagents = false, terminals = [], plugin = {} }: Shown = {}) {
  return {
    requests: {
      'projects.list': () => ok(PROJECTS),
      'sdd.list': () => ok(list),
      'sdd.taken': () => ok(TAKEN),
      'agents.get': () => ok({ agents: [...AGENTS.agents, CURSOR], launcher: 'claude' }),
      'project.page': () => ok({ url: `https://me.conport.app/t/pers/p/${HANDLE}` }),
      'row.session': ({ row }: RowTarget) => {
        const name = row.kind === 'spec' ? `spec:${row.doc}` : `${row.kind}:${row.id}`
        return ok({ terminal: terminals.includes(name) ? `term-${name}` : null })
      },
      'epic.session': () => ok(state),
      'epic.tasks': () => ok(EPIC_TASKS),
      'subagents.get': ({ harness }: { harness: string }) =>
        noSubagents ? NO_SUBAGENTS : ok(harness === 'claude' ? SUBAGENTS : untyped(harness))
    },
    persisted: { plugin: { ...(epic === null ? {} : { epics: { [ROOT]: epic } }), ...plugin } }
  }
}

export default defineCheck({
  'empty-project': scenario(EMPTY_SDD),
  // The four sections, Outside SDD folded; the epic and the idea another session took.
  'sections': scenario(SDD_LIST),
  'outside-open': scenario(SDD_LIST, { plugin: { sections: { outside: false, specs: true } } }),
  // A taken idea whose terminal this host opened shows it; the taken epic offers Take over.
  'taken': scenario(SDD_LIST, { terminals: ['idea:43', 'spec:30'] }),
  'brainstorm': scenario(SDD_LIST, { plugin: { sheet: { root: ROOT, sheet: { kind: 'idea', idea: idea(41) } } } }),
  'plan-build': scenario(SDD_LIST, { plugin: { sheet: { root: ROOT, sheet: { kind: 'spec', spec: specDoc } } } }),
  'decline': scenario(SDD_LIST, { plugin: { sheet: { root: ROOT, sheet: { kind: 'decline', proposal } } } }),
  'take-over': scenario(SDD_LIST, { plugin: { takeOver: { root: ROOT, key: `task-${43}`, then: { kind: 'idea', idea: idea(43) } } } }),
  // In a shared team every row says who leads it; Take over of a row Ann leads asks by her name.
  'assignees': scenario(LED),
  'take-over-foreign': scenario(LED, { plugin: { takeOver: { root: ROOT, key: `task-${43}`, then: { kind: 'idea', idea: idea(43) } } } }),
  'epic-taken-foreign': scenario(LED, { epic: 7, state: SESSION_COPY }),
  'epic-new': scenario(SDD_LIST, { epic: 15 }),
  // Epic 7 is taken by another session: no session of this host, so Take over.
  'epic-taken': scenario(SDD_LIST, { epic: 7, state: SESSION_COPY }),
  'epic-session-alive': scenario(SDD_LIST, { epic: 7, state: SESSION_ALIVE }),
  'epic-roles-unavailable': scenario(SDD_LIST, { epic: 15, noSubagents: true }),
  // A harness whose subagents have no types: the roles go by the texts of the CLI.
  'epic-codex': scenario(SDD_LIST, { epic: 15, state: session({ harness: 'codex' }) }),
  'no-project': {
    requests: {
      'projects.list': () => ok(PROJECTS.map((p) => (p.root === ROOT ? { ...p, project: null, source: null } : p)))
    }
  }
})
