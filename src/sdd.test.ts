// The stages of SDD as the panel draws them: the order of the ideas, the taken rows, when the list
// is read in full, and the buttons of each row by the table of the panel.
import { assert, test } from 'orca/testing'
import { HANDLE, SDD_LIST, TAKEN } from '../test/fixtures'
import type { Assignee, IdeaRow, InWorkRow, SddList, SpecRow, TakenList } from './protocol'
import { ACTION, FULL_READ_MS, ideaRows, leadOf, ledByOther, needsFullRead, POLL_TAKEN_MS, rowActions, takenRows } from './sdd'
import { personName, SECTIONS, skippedLine, TAKE_OVER_CONFIRM, takeOverQuestion, updatedLine, withAssignee } from './text'

/** A fresh copy of the list, to change in one test. */
const list = (): SddList => JSON.parse(JSON.stringify(SDD_LIST)) as SddList

/** The light read naming `ids` in progress. */
const taken = (...ids: number[]): TakenList => ({ project: HANDLE, taken: ids.map((id) => ({ id, kind: 'task', updated_at: '2026-11-16T09:00:00Z' })) })

const idea = (extra: Partial<IdeaRow> = {}): IdeaRow => ({
  id: 60,
  kind: 'task',
  title: 'An idea',
  status: 'TODO',
  priority: 3,
  changes_requested: false,
  ...extra
})

test('the timers: the light read every minute, the full read every 10 minutes', () => {
  assert.equal(POLL_TAKEN_MS, 60_000)
  assert.equal(FULL_READ_MS, 600_000)
})

test('the sections, their captions and which one opens folded', () => {
  assert.deepEqual(SECTIONS, [
    { key: 'in_work', title: 'In work', caption: 'spec + plan', open: true },
    { key: 'specs', title: 'Specs', caption: 'spec, no plan', open: true },
    { key: 'ideas', title: 'Ideas', caption: 'not worked through', open: true },
    { key: 'outside', title: 'Outside SDD', caption: 'no spec', open: false }
  ])
  assert.equal(TAKE_OVER_CONFIRM, 'Another session may be working on it')
  assert.equal(skippedLine(1), '1 proposal is not shown: its state line cannot be read')
  assert.equal(skippedLine(2), '2 proposals are not shown: their state line cannot be read')
})

test('ideas put a proposal after the tasks of priority 3 and before 4', () => {
  const ids = (rows: ReturnType<typeof ideaRows>) => rows.map((row) => ('doc' in row ? `doc-${row.doc}` : row.id))
  // By priority, then by number, whatever order the CLI sent them in.
  assert.deepEqual(ids(ideaRows(SDD_LIST)), [41, 42, 43, 46, `doc-${301}`, 47])
  // No task after priority 3: the proposals end the list, by their documents.
  const two = { ...list(), ideas: [idea({ id: 70, priority: 1 }), idea({ id: 71, priority: 3 })] }
  two.proposals = [{ doc: 310, title: 'B', author: null }, { doc: 305, title: 'A', author: 'Anna' }]
  assert.deepEqual(ids(ideaRows(two)), [70, 71, `doc-${305}`, `doc-${310}`])
  // On the boundary: priority 3 before, priority 4 after; no task at all, the proposals alone.
  const edge = { ...list(), ideas: [idea({ id: 80, priority: 4 }), idea({ id: 81, priority: 3 }), idea({ id: 82, priority: 2 })] }
  assert.deepEqual(ids(ideaRows(edge)), [82, 81, `doc-${301}`, 80])
  assert.deepEqual(ids(ideaRows({ ...list(), ideas: [] })), [`doc-${301}`])
})

test('the taken rows go by the light read, and by the list before there is one', () => {
  // Before any light read: the rows the list has in progress, the idea back from review aside.
  assert.deepEqual([...takenRows(SDD_LIST, null)].sort((a, b) => a - b), [7, 43])
  // The light read names the epic and idea 41, which another client took after the list was read.
  assert.deepEqual([...takenRows(SDD_LIST, taken(7, 41, 46))].sort((a, b) => a - b), [7, 41])
  // A number the list does not hold is no row to mark.
  assert.deepEqual([...takenRows(SDD_LIST, taken(999))], [])
  // The epic of a spec and an epic outside SDD are marked as well.
  assert.deepEqual([...takenRows(SDD_LIST, taken(9, 50))].sort((a, b) => a - b), [9, 50])
})

test('the same set needs no full read', () => {
  assert.equal(needsFullRead(SDD_LIST, TAKEN), false)
  assert.equal(needsFullRead(SDD_LIST, { ...TAKEN, taken: [...TAKEN.taken].reverse() }), false)
  // A row of the list another client took is marked by the light read itself.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, 41)), false)
})

test('needsFullRead: an unknown taken number, a vanished one', () => {
  // A number the list does not hold: a new idea taken at once.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, 999)), true)
  // A row the list has in progress that the light read no longer names.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43)), true)
  assert.equal(needsFullRead(SDD_LIST, taken(43, 46)), true)
  assert.equal(needsFullRead(SDD_LIST, taken()), true)
  // One let go and another of the list taken in the same minute: the same count, another set.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 41)), true)
})

test('needsFullRead ignores nothing the list cannot hold', () => {
  // Every root row of the list is known, whatever its section: an epic In work, the epic of a
  // spec, an idea, an epic outside SDD.
  for (const id of [15, 9, 41, 50]) assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, id)), false, String(id))
  // A spec document's number and a task of an epic outside SDD are no root rows: the light read
  // reads the root tasks only, so a number known only as such is unknown.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, 30)), true)
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, 51)), true)
  // A task of an epic in progress and absent from the light read asks for nothing.
  const busy = list()
  const task = busy.outside[0]?.tasks[0]
  if (task) task.status = 'IN_PROGRESS'
  assert.equal(needsFullRead(busy, taken(7, 43, 46)), false)
  // The epic of a spec and an epic outside SDD in progress and absent from it each ask.
  const held = list()
  const [, spec] = held.specs
  const [outside] = held.outside
  if (spec) spec.status = 'IN_PROGRESS'
  if (outside) outside.status = 'IN_PROGRESS'
  assert.equal(needsFullRead(held, taken(7, 43, 46, 9, 50)), false)
  assert.equal(needsFullRead(held, taken(7, 43, 46, 50)), true)
  assert.equal(needsFullRead(held, taken(7, 43, 46, 9)), true)
})

test('needsFullRead: a taken unlisted idea asks for no full read', () => {
  // Idea 6 is in progress and the tagged spec 30 clarifies it: the list read it and shows it nowhere.
  const held: SddList = { ...SDD_LIST, unlisted: [6] }
  assert.equal(needsFullRead(held, taken(7, 43, 46, 6)), false)
  // Let go, it asks for nothing either: it is no row the list holds in progress.
  assert.equal(needsFullRead(held, taken(7, 43, 46)), false)
  // Without the field (an older CLI) the number is unknown.
  assert.equal(needsFullRead(SDD_LIST, taken(7, 43, 46, 6)), true)
})

test('an idea back from review shows Fix, not In progress', () => {
  const back = SDD_LIST.ideas.find((row) => row.id === 46) as IdeaRow
  assert.equal(back.changes_requested, true)
  // The light read names it in progress: it is not taken, and offers Fix whoever holds a terminal.
  assert.equal(takenRows(SDD_LIST, TAKEN).has(46), false)
  assert.deepEqual(rowActions({ kind: 'idea', idea: back }, false, false), [ACTION.fix])
  assert.deepEqual(rowActions({ kind: 'idea', idea: back }, false, true), [ACTION.fix])
  // A task of an epic outside SDD back from review the same.
  assert.deepEqual(rowActions({ kind: 'task', task: back }, false, false), [ACTION.fix])
})

test('a taken idea is decided by the light read before the stage the list holds', () => {
  const row = (extra: Partial<IdeaRow>) => ({ kind: 'idea' as const, idea: idea(extra) })
  // The list still has it in review or blocked; the light read, newer, names it in progress.
  for (const status of ['REVIEW', 'BLOCKED', 'TODO'] as const) {
    assert.deepEqual(rowActions(row({ status }), true, false), ['Take over'], status)
    assert.deepEqual(rowActions(row({ status }), true, true), ['Show terminal'], status)
  }
})

test('row actions follow the table of the panel', () => {
  const row = (extra: Partial<IdeaRow>) => ({ kind: 'idea' as const, idea: idea(extra) })
  // An idea to do: Brainstorm; taken: Show terminal when this host has its terminal, else Take over.
  assert.deepEqual(rowActions(row({}), false, false), ['Brainstorm'])
  assert.deepEqual(rowActions(row({ status: 'IN_PROGRESS' }), true, true), ['Show terminal'])
  assert.deepEqual(rowActions(row({ status: 'IN_PROGRESS' }), true, false), ['Take over'])
  // Started from this host and not yet taken: its terminal, not a second Brainstorm.
  assert.deepEqual(rowActions(row({}), false, true), ['Show terminal'])
  // Blocked: nothing; in review: Review; in progress with no terminal here and not taken: nothing.
  assert.deepEqual(rowActions(row({ status: 'BLOCKED' }), false, false), [])
  assert.deepEqual(rowActions(row({ status: 'REVIEW' }), false, false), ['Review'])
  assert.deepEqual(rowActions(row({ status: 'IN_PROGRESS' }), false, false), [])
  // A proposal: Brainstorm and Decline.
  assert.deepEqual(rowActions({ kind: 'proposal', proposal: { doc: 301, title: 'P', author: null } }, false, false), ['Brainstorm', 'Decline'])
  // A spec: Plan & build and Open spec; its terminal on this host, or its epic taken elsewhere.
  const doc: SpecRow = { doc: 30, title: 'S', idea: 6, priority: 2, epic: null, status: null }
  const ofEpic: SpecRow = { doc: 22, title: 'S', idea: null, priority: 3, epic: 9, status: 'IN_PROGRESS' }
  assert.deepEqual(rowActions({ kind: 'spec', spec: doc }, false, false), ['Plan & build', 'Open spec'])
  assert.deepEqual(rowActions({ kind: 'spec', spec: doc }, false, true), ['Show terminal', 'Open spec'])
  assert.deepEqual(rowActions({ kind: 'spec', spec: ofEpic }, true, false), ['Take over', 'Open spec'])
  // An epic In work: Start; taken: Show terminal or Take over; several specs or plans: nothing.
  const epic = SDD_LIST.in_work[1] as InWorkRow
  assert.deepEqual(rowActions({ kind: 'epic', epic }, false, false), ['Start'])
  assert.deepEqual(rowActions({ kind: 'epic', epic }, true, true), ['Show terminal'])
  assert.deepEqual(rowActions({ kind: 'epic', epic }, true, false), ['Take over'])
  assert.deepEqual(rowActions({ kind: 'epic', epic: { ...epic, reason: 'several specs' } }, false, false), [])
  // A task of an epic outside SDD: Hand to agent, Review, Fix; one an agent is at, nothing.
  assert.deepEqual(rowActions({ kind: 'task', task: idea() }, false, false), ['Hand to agent'])
  assert.deepEqual(rowActions({ kind: 'task', task: idea({ status: 'REVIEW' }) }, false, false), ['Review'])
  assert.deepEqual(rowActions({ kind: 'task', task: idea({ status: 'IN_PROGRESS' }) }, false, false), [])
  // No row offers what the panel no longer has.
  const all = [
    rowActions(row({}), false, false),
    rowActions({ kind: 'spec', spec: doc }, false, false),
    rowActions({ kind: 'epic', epic }, false, false)
  ].flat()
  assert.equal(all.some((label) => /Prepare|Write plan/.test(label)), false)
})

const ANN: Assignee = { handle: 'usann2345a', email: 'ann@example.com', former_member: false }
const ME = 'usme234567'

test('a row is own when it has no assignee or its handle is me, else another person leads it', () => {
  assert.equal(ledByOther(null, ME), null)
  assert.equal(ledByOther(undefined, ME), null)
  assert.equal(ledByOther({ ...ANN, handle: ME }, ME), null)
  assert.deepEqual(ledByOther(ANN, ME), ANN)
  // A caller the CLI could not name: nobody is another person, as in the dashboard.
  assert.equal(ledByOther(ANN, null), null)
  assert.equal(ledByOther(ANN, undefined), null)
})

test('who leads a root row: the light read when it names the row with an assignee, else the list', () => {
  const row = { assignee: ANN }
  assert.deepEqual(leadOf(43, row, null), ANN)
  // The light read is newer: it names another lead, or none.
  const bob: Assignee = { handle: 'usbob2345b', email: null, former_member: false }
  const read = (assignee?: Assignee | null): TakenList => ({
    project: HANDLE,
    taken: [{ id: 43, kind: 'task', updated_at: '2026-11-16T09:00:00Z', ...(assignee === undefined ? {} : { assignee }) }]
  })
  assert.deepEqual(leadOf(43, row, read(bob)), bob)
  assert.equal(leadOf(43, row, read(null)), null)
  // A light read without the field (a Private Team, an older CLI), or not naming the row: the list.
  assert.deepEqual(leadOf(43, row, read()), ANN)
  assert.deepEqual(leadOf(44, row, read(bob)), ANN)
  assert.equal(leadOf(43, {}, null), null)
})

test('a person is named by the email, else by the handle; the question names who leads', () => {
  assert.equal(personName(ANN), 'ann@example.com')
  assert.equal(personName({ ...ANN, email: null }), 'usann2345a')
  assert.equal(takeOverQuestion('ann@example.com'), 'ann@example.com leads this task. Take it over?')
  assert.equal(withAssignee('In progress', ANN), 'In progress · ann@example.com')
  assert.equal(withAssignee('In progress', null), 'In progress')
  assert.equal(withAssignee('In progress', undefined), 'In progress')
})

test('updatedLine today and on another day', () => {
  // Local time on both ends: the line is read where the person is.
  const now = new Date(2026, 10, 16, 18, 0)
  assert.equal(updatedLine(new Date(2026, 10, 16, 9, 5).toISOString(), now), 'In progress · updated 09:05')
  assert.equal(updatedLine(new Date(2026, 10, 16, 0, 0).toISOString(), now), 'In progress · updated 00:00')
  // The day before, by a minute: the day and the month are named.
  assert.equal(updatedLine(new Date(2026, 10, 15, 23, 59).toISOString(), now), 'In progress · updated 15 Nov 23:59')
  assert.equal(updatedLine(new Date(2025, 10, 16, 9, 5).toISOString(), now), 'In progress · updated 16 Nov 09:05')
  assert.equal(updatedLine(new Date(2026, 0, 2, 7, 30).toISOString(), now), 'In progress · updated 2 Jan 07:30')
  // No time to tell: the stage alone.
  assert.equal(updatedLine('', now), 'In progress')
  assert.equal(updatedLine('not a time', now), 'In progress')
})
