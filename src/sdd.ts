// The work of a project by the stages of SDD as the panel draws it: the order of the ideas, the
// rows taken in another session, when the list is read again in full, and what each row offers.
// Pure: no Node, no orca.
import { handMode } from './cli'
import type { Assignee, IdeaRow, InWorkRow, OpenStatus, ProposalRow, SddList, SpecRow, TakenList } from './protocol'

/** How often the panel reads the rows in progress while it is visible: the light read. */
export const POLL_TAKEN_MS = 60_000

/** How often the panel reads the whole list while it is visible, whatever the light read says. */
export const FULL_READ_MS = 600_000

/** A proposal counts as this priority among the ideas, after the tasks of the same priority. */
export const PROPOSAL_PRIORITY = 3

/** The buttons a row can offer, as the panel labels them. */
export const ACTION = {
  brainstorm: 'Brainstorm',
  decline: 'Decline',
  plan: 'Plan & build',
  openSpec: 'Open spec',
  start: 'Start',
  hand: 'Hand to agent',
  review: 'Review',
  fix: 'Fix',
  showTerminal: 'Show terminal',
  takeOver: 'Take over'
} as const

/** A row of a section: an idea, a proposal, a spec, an epic In work, or a task of an epic outside SDD. */
export type SddRow =
  | { kind: 'idea'; idea: IdeaRow }
  | { kind: 'proposal'; proposal: ProposalRow }
  | { kind: 'spec'; spec: SpecRow }
  | { kind: 'epic'; epic: InWorkRow }
  | { kind: 'task'; task: IdeaRow }

export const isProposal = (row: IdeaRow | ProposalRow): row is ProposalRow => 'doc' in row

/**
 * The section Ideas in the order it is shown: by priority, then by number; a proposal counts as
 * priority 3 and stands after the tasks of that priority, the proposals by their documents.
 */
export function ideaRows(list: SddList): Array<IdeaRow | ProposalRow> {
  const ideas = list.ideas
    .map((idea, index) => ({ idea, index }))
    .sort((a, b) => a.idea.priority - b.idea.priority || a.idea.id - b.idea.id || a.index - b.index)
    .map(({ idea }) => idea)
  const proposals = [...list.proposals].sort((a, b) => a.doc - b.doc)
  const at = ideas.findIndex((idea) => idea.priority > PROPOSAL_PRIORITY)
  const cut = at === -1 ? ideas.length : at
  return [...ideas.slice(0, cut), ...proposals, ...ideas.slice(cut)]
}

/** A root task of the list — the only rows `sdd list --taken` can name — with what makes it taken. */
interface RootRow {
  id: number
  status: OpenStatus | string | null
  /** An idea back from review waits for its fixes: in progress, and still not taken. */
  changesRequested: boolean
}

/**
 * The root tasks of the list, whatever their section: an epic In work, the epic of a spec, an
 * idea, an epic outside SDD. A spec document and a task of an epic are none.
 */
function rootRows(list: SddList): RootRow[] {
  return [
    ...list.in_work.map((epic) => ({ id: epic.id, status: epic.status, changesRequested: false })),
    ...list.specs.flatMap((spec) => (spec.epic === null ? [] : [{ id: spec.epic, status: spec.status, changesRequested: false }])),
    ...list.ideas.map((idea) => ({ id: idea.id, status: idea.status, changesRequested: idea.changes_requested })),
    ...list.outside.map((epic) => ({ id: epic.id, status: epic.status, changesRequested: false }))
  ]
}

/**
 * The root tasks of the list that are taken: those the light read names in progress, or, before
 * any light read since the list was read, those the list has in progress. An idea back from
 * review is in progress and not taken: its fixes are due.
 */
export function takenRows(list: SddList, taken: TakenList | null): Set<number> {
  const rows = rootRows(list)
  const inProgress = new Set(taken === null ? rows.filter((row) => row.status === 'IN_PROGRESS').map((row) => row.id) : taken.taken.map((row) => row.id))
  return new Set(rows.filter((row) => inProgress.has(row.id) && !row.changesRequested).map((row) => row.id))
}

/**
 * Whether the light read calls for the whole list: it names a number that is no root row of the
 * list (a row the list does not show yet), or a row the list has in progress is no longer in it.
 * A row of the list that another session took is marked by the light read itself. A number the
 * list read and shows nowhere (`unlisted`: an idea a spec clarifies) is known, and its leaving the
 * light read asks for nothing.
 */
export function needsFullRead(list: SddList, taken: TakenList): boolean {
  const rows = rootRows(list)
  const known = new Set([...rows.map((row) => row.id), ...(list.unlisted ?? [])])
  const now = new Set(taken.taken.map((row) => row.id))
  for (const id of now) if (!known.has(id)) return true
  return rows.some((row) => row.status === 'IN_PROGRESS' && !now.has(row.id))
}

/**
 * The person who leads a row when that is someone else: null for a row of the caller's (its handle
 * is `me`) or of nobody, and for every row while the caller is unknown (`me` null: the CLI could
 * not name it) — as in the dashboard, nobody is another person then. A Take over of a row someone
 * else leads is asked by name, and its yes lets the agent take the task over.
 */
export function ledByOther(assignee: Assignee | null | undefined, me: string | null | undefined): Assignee | null {
  if (assignee === null || assignee === undefined) return null
  if (me === null || me === undefined) return null
  return assignee.handle === me ? null : assignee
}

/**
 * Who leads root row `id` now: the light read when it names the row with the field — it is newer —
 * else the list.
 */
export function leadOf(id: number, row: { assignee?: Assignee | null }, taken: TakenList | null): Assignee | null {
  const named = taken?.taken.find((t) => t.id === id)
  if (named !== undefined && 'assignee' in named) return named.assignee ?? null
  return row.assignee ?? null
}

/** Show terminal when this host has the live terminal of the row, else Take over. */
const takenAction = (hasTerminal: boolean): string => (hasTerminal ? ACTION.showTerminal : ACTION.takeOver)

/**
 * The buttons of a row by the table of the panel: what it is, whether it is taken, and whether
 * this host has its live terminal.
 */
export function rowActions(row: SddRow, taken: boolean, hasTerminal: boolean): string[] {
  switch (row.kind) {
    case 'idea': {
      // Taken first: the light read is newer than the stage the list holds. Then in review or back
      // from it, then blocked, then a terminal of this host, then a brainstorm of an idea to do.
      const { idea } = row
      if (taken) return [takenAction(hasTerminal)]
      const mode = handMode(idea)
      if (mode === 'fix') return [ACTION.fix]
      if (mode === 'review') return [ACTION.review]
      if (idea.status === 'BLOCKED') return []
      if (hasTerminal) return [ACTION.showTerminal]
      return idea.status === 'TODO' ? [ACTION.brainstorm] : []
    }
    case 'proposal':
      return [ACTION.brainstorm, ACTION.decline]
    case 'spec':
      return [taken || hasTerminal ? takenAction(hasTerminal) : ACTION.plan, ACTION.openSpec]
    case 'epic':
      if (row.epic.reason !== null) return []
      return [taken || hasTerminal ? takenAction(hasTerminal) : ACTION.start]
    case 'task': {
      const mode = handMode(row.task)
      return mode === null ? [] : [{ do: ACTION.hand, review: ACTION.review, fix: ACTION.fix }[mode]]
    }
  }
}
