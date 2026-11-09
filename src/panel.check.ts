// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario. The
// worker's answers are stubbed with the JSON of the conport CLI, so no scenario runs a process.
import { defineCheck } from 'orca/testing'
import { AGENTS, EMPTY_LIST, EPIC_LIST, EPIC_WITHOUT_PLAN, FAILED, QUESTION, RUNNING } from '../test/fixtures'
import type { EpicList, EpicStatus } from './protocol'

const ok = <T>(data: T) => ({ ok: true, data })
const context = ok({ root: '/work/shop', project: 'shop-api', source: 'repository' })
const idle = (epic: number): EpicStatus => ({ epic, phase: 'none', tasks: [], questions: [], outcome: null, paused: null, failure: null })

function scenario(list: EpicList, board: EpicStatus | null, epic: number | null) {
  return {
    requests: {
      'context.get': () => context,
      'epics.list': () => ok(list),
      'agents.get': () => ok({ agents: AGENTS.agents, chosen: null }),
      'board.get': () => ok(board ?? idle(epic ?? 0))
    },
    persisted: { workspace: { epic } }
  }
}

export default defineCheck({
  'empty-project': scenario(EMPTY_LIST, null, null),
  'epic-without-plan': scenario(EPIC_WITHOUT_PLAN, null, null),
  'ready-to-run': scenario(EPIC_LIST, idle(15), 15),
  'running': scenario(EPIC_LIST, RUNNING, 7),
  'question': scenario(EPIC_LIST, QUESTION, 7),
  'failed': scenario(EPIC_LIST, FAILED, 7),
  'no-project': {
    requests: { 'context.get': () => ok({ root: '/work/shop', project: null, source: null }) }
  }
})
