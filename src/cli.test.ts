// The tasks an epic's lead session is started with: the texts themselves, with no worker around.
import { execFileSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { HANDLE } from '../test/fixtures'
import {
  CLI_VERSION,
  DEFAULT_ROLES,
  FIXER_TYPE,
  QUOTES,
  ROLE_TYPE_FORM,
  commandLine,
  epicTask,
  epicWorkflowTask
} from './cli'
import type { Roles } from './protocol'

const NPX = `npx -y conport@${CLI_VERSION}`
const WORKTREE = '/work/app-epic-7'
const ROOT = '/work/app'

const SDD = { epic: 7, project: HANDLE, worktree: WORKTREE, base: 'main', harness: 'claude', roles: DEFAULT_ROLES }
const OTHER_ROLES: Roles = {
  implementer: 'sdd-implementer',
  reviewer: 'team:strict-reviewer',
  gapHunter: 'gap.hunter',
  finalReviewer: 'final_reviewer-2'
}
const WORKFLOW = { epic: 7, project: HANDLE, root: ROOT, base: 'main' }

/** The three texts: by SDD for Claude Code, by SDD for another harness, by the workflow. */
const TEXTS = [epicTask(SDD), epicTask({ ...SDD, harness: 'codex' }), epicWorkflowTask(WORKFLOW)]

/** Every `npx … conport…` command a text names, each without its backticks. */
function conportCommands(text: string): string[] {
  return [...text.matchAll(/`(npx [^`]*)`/g)].map((m) => m[1] ?? '')
}

/** The lines of the block that follows the line starting with `head`, up to the next empty line. */
function block(text: string, head: string): string[] {
  const lines = text.split('\n')
  const from = lines.findIndex((l) => l.startsWith(head))
  assert.ok(from >= 0, `no line starts with ${head}`)
  const rest = lines.slice(from)
  const end = rest.indexOf('')
  return end < 0 ? rest : rest.slice(0, end)
}

/** The first text of the spec with the trial parameters in; `<V>` stands for the CLI release. */
const FIRST_TEXT = [
  'Execute epic 7 of the ConPort project prk7m2qx9d by its plan, until the branch `epic-7` is ready to merge into `main`.',
  'You are the lead session of the epic. You work in this terminal, in the working copy /work/app-epic-7 on the branch `epic-7`; the person reads this terminal and can talk to you here.',
  '',
  'Work by the skill superpowers:subagent-driven-development, with the changes the conport skill makes to it:',
  'its reference `references/superpowers-overlay.md`, steps "Execution" and "Dispatching a subagent", and the first two paragraphs of the section "Epic in its own branch" of the conport skill itself (the branch of the epic, a branch per task).',
  'A brief, a report, a review and a fix are entries of the task journal in ConPort, never files.',
  '',
  'Rules',
  '- Talk with the person in the language they write in. Do not ask leave to begin: you were started to do the epic.',
  '- Run every ConPort command exactly as written here, with the CLI release and the project it names. Never print or pass the ConPort API key: the CLI reads it itself. The ConPort MCP tools do the same steps as well, with project="prk7m2qx9d".',
  '- Run no checks before the first task: the checks of the repository run inside the tasks and after the merges, where the steps below name them.',
  '- Decide an ambiguity by the spec and record the decision in the journal of the task.',
  "- Stop and ask the person only for: an operation that cannot be undone; a merge conflict you cannot resolve without guessing; a task whose review has not approved after three rounds; the epic grown by more than 30% of the plan's tasks; a step that cannot be done as it is written here — a task that is BLOCKED, a dependency that can never close, a subagent type named under \"Roles\" that is not found, a refusal of the CLI or of its key, checks that stay red after a merge and its fix round.",
  "- When you ask, say what stopped you and the one thing you need, then end your turn and wait for the person's word. Do not go on to another task while a question that holds the epic is open.",
  '- Every commit message is in the Conventional Commits form and never mentions an AI, an assistant or a model, and carries no Co-Authored-By line.',
  '- This task was given to you once, as the argument you were started with, and is stored nowhere else. When the context is compacted, keep its blocks "Rules", "Never", "Roles" and "Steps" word for word.',
  '',
  "Never: push anything; merge `epic-7` into `main` or any other branch; deploy; apply a migration or touch a production service; close the epic; remove the working copy /work/app-epic-7. Those are the person's.",
  'The texts you work by say otherwise in six places. Do not carry these out:',
  '- the line "Release" of the section "Epic in its own branch" (merge into main, push main);',
  '- step 8 of the overlay, "on a READY verdict the epic is closed, then the release follows";',
  '- the line `Сделай сейчас: update_task(task-7, DONE, …)` the `finish` mode prints with READY;',
  '- the answer to closing the last task of the epic, when it says "ready to close: update_task(…)" or `closable`, and the line "[EPIC] … ready to close — close it with a resolution now" of the conport skill;',
  '- in the tail of the pulled plan, "Definition of Done … epic task-7 closed";',
  '- in the tail of the pulled plan, "delete the workspace, hand over to finishing-a-development-branch".',
  'For this run the work is finished at step 12 below, with the epic open.',
  '',
  'Roles — each role is the subagent type the person chose for this epic.',
  '- Implementer: `conport:sdd-implementer`. A fix round continues the same subagent, or goes to `conport:sdd-fixer` when it is gone.',
  '- Reviewer: `conport:sdd-task-reviewer`.',
  '- Gap hunter: `conport:sdd-gap-hunter`.',
  '- Final reviewer: `conport:sdd-final-reviewer`.',
  'Start every role only as a subagent of the type named for it. Never put a subagent of another type, one without a type, or a general-purpose one, on a role, and never do the work of a role yourself. A subagent never starts a subagent.',
  'If a type is not found, stop and ask the person: the type is not installed, or its plugin is out of date. Do not go on without it.',
  '',
  'Steps',
  '1. If you call `init` of ConPort, call it with `questions=false`: this run takes up no questions about the project. Read the epic: `npx -y conport@<V> api tasks get --task_id 7 --project prk7m2qx9d`, and its tasks: `npx -y conport@<V> api tasks list --parent_task_id 7 --status ALL --include_snoozed true --limit 200 --project prk7m2qx9d`. The dependencies of a task are in its `tasks get`.',
  '2. Pull the plan: `npx -y conport@<V> plan pull 7 -p prk7m2qx9d`. It writes `.superpowers/plans/doc-<M>.md` and a `.conport.json` beside it: keep both. Read the whole plan, its Global Constraints first. Its last section, "ConPort finish", and the "ConPort execution contract" above it are written by `plan pull`: they are no task of the epic.',
  '3. Read the spec: `npx -y conport@<V> api links list --item_type task --item_id 7 --project prk7m2qx9d` names the document of type `spec` linked to the epic with `clarifies`; `npx -y conport@<V> documents get doc-<S> -p prk7m2qx9d` writes it to `.superpowers/docs/doc-<S>.md`.',
  '4. Find where the epic stands, for it may have been started before. A task DONE or CANCELLED is finished. A task in REVIEW goes to its review. A task IN_PROGRESS goes on from its journal: the latest entry says whether a report, a review or a fix is due. `git worktree list` shows the working copies an earlier session left: a task whose branch `task-<id>` has a working copy goes on in that copy; a branch `task-<id>` without one gets a working copy added for it; never delete a branch or a working copy that holds commits not merged into `epic-7`. If the epic is TODO, take it: `npx -y conport@<V> api tasks update --task_id 7 --status IN_PROGRESS --project prk7m2qx9d`. If `epic-7` does not hold the tip of `main` (`git merge-base --is-ancestor main epic-7` fails), bring `main` into it in this working copy before any branch `task-<id>` is cut: `git merge --ff-only main`, and when that refuses because `epic-7` has commits of its own, `git merge main`; a conflict of that merge is a question to the person.',
  '5. Order. A task is ready when every task it depends on (`blocks`, `requires`) is DONE; among ready tasks the order is the section number of the plan. Run ready tasks in parallel, each in a working copy of its own on the branch `task-<id>` cut from `epic-7`; start the next ones as soon as their dependencies close. The working copy of a task is the folder /work/task-<id>, beside /work/app-epic-7, never inside it.',
  '6. One task. Write the brief into its journal (`kind="brief"`: the full text of its plan section and the context the implementer needs). Take the task before dispatching its implementer: `npx -y conport@<V> api tasks update --task_id <id> --status IN_PROGRESS --project prk7m2qx9d`. Dispatch the implementer with the task number and how to read the journal, nothing else. Its report is the `report` entry. Dispatch the reviewer with the task number and the two commits to compare. Its verdict is the `review` entry: on `changes_requested` the implementer fixes every finding and writes a `fix` entry, then the reviewer reviews again; on `approve` go to step 7.',
  '7. Merge. Merge `task-<id>` into `epic-7` in this working copy, one task at a time, and run there the checks the plan names in its Global Constraints. Red checks or a conflict go back to the implementer of that task as one fix round: the task is in REVIEW, where a `fix` entry is not accepted, so the reviewer of that task first writes a `review` entry with the verdict `changes_requested` and the output of the checks or of the merge, and the fix round follows as in step 6. Then close the task: `npx -y conport@<V> api tasks update --task_id <id> --status DONE --resolution "<what was done, the merge commit>" --project prk7m2qx9d`, and remove its working copy.',
  '8. Gap hunt, once, when every task of the epic is DONE or CANCELLED: the whole branch `epic-7` against the spec, with the goal as the spec states it. A Blocker becomes a task of the epic; a Should-fix and a Note are kept for step 12.',
  '9. Final review, once, after the tasks of the gap hunt are merged: the whole branch against the spec. A Critical or Important finding becomes a task of the epic; a Minor is kept for step 12. There is no second final review.',
  "10. A finding that becomes a task is a new section of the plan, as the overlay's step \"Editing the plan during the work\" says: pull, add the section with the next free number, `plan import`, pull again. It then runs through steps 6 and 7 once.",
  '11. The section "ConPort finish" at the end of the pulled plan: run the skill superpowers-conport in `finish` mode on the pulled plan file and do what it prescribes until it says READY — except the six things named under "Never".',
  '12. On READY, log a progress entry titled exactly `Epic task-7 is ready to merge`, linked to task 7. Its body: the head commit of `epic-7`, and every finding left open — each Should-fix and Note of the gap hunt and each Minor of the final review, one line each. Then tell the person the same: the branch, its head commit, the findings left, and that merging into `main`, the release and closing the epic are theirs.'
]

/** The third text of the spec with the trial parameters in; `<V>` stands for the CLI release. */
const THIRD_TEXT = [
  'Execute epic 7 of the ConPort project prk7m2qx9d with the workflow /conport:epic.',
  'You are the lead session of the epic. You work in this terminal, in the repository /work/app on its default branch `main`; the person reads this terminal and can talk to you here.',
  '',
  'Rules',
  '- Talk with the person in the language they write in. Do not ask leave to begin: you were started to do the epic.',
  '- Run every ConPort command exactly as written here, with the CLI release and the project it names. Never print or pass the ConPort API key: the CLI reads it itself.',
  '- The workflow runs the checks, the working copies, the reviews, the merges into `main`, the gap hunt, the acceptance and the accounting in ConPort itself. Do none of that by hand, before it or beside it.',
  '- When the workflow stops with a question, an `ABORTED_…` status or a failed task, tell the person here what it said and the one thing to do, then end your turn and wait for their word. When they tell you to run it again, run the same command: the workflow picks up the branches an earlier run left.',
  '- This task was given to you once, as the argument you were started with, and is stored nowhere else. When the context is compacted, keep its blocks "Rules", "Never" and "Steps" word for word.',
  '',
  'Never: push anything; deploy; apply a migration or touch a production service; merge by hand.',
  '',
  'Steps',
  '1. If you call `init` of ConPort, call it with `questions=false`: this run takes up no questions about the project. Pull the plan: `npx -y conport@<V> plan pull 7 -p prk7m2qx9d`. It writes `.superpowers/plans/doc-<M>.md` and a `.conport.json` beside it: keep both.',
  '2. Start the workflow: `/conport:epic {"epic": 7, "project": "prk7m2qx9d", "plan": ".superpowers/plans/doc-<M>.md"}`.',
  '3. When it ends, tell the person its outcome as the run printed it — `EPIC_CLOSED`, `DONE_EPIC_OPEN` or `DONE_WITH_UNRESOLVED_CRITICALS` — with the tasks done, failed and skipped and the findings left, and that pushing `main` and the release are theirs.'
]

const spec = (lines: string[]): string => lines.join('\n').replaceAll('<V>', CLI_VERSION)

test('the SDD task names the skill, the epic, the project and the pinned cli version in every conport command', () => {
  for (const harness of ['claude', 'codex']) {
    const task = epicTask({ ...SDD, harness })
    assert.match(task, new RegExp(`^Execute epic 7 of the ConPort project ${HANDLE} by its plan`))
    assert.ok(task.includes('the branch `epic-7` is ready to merge into `main`'))
    assert.ok(task.includes(`in the working copy ${WORKTREE} on the branch \`epic-7\``))
    const commands = conportCommands(task)
    assert.ok(commands.length >= 7, `${harness}: ${commands.length} commands`)
    for (const command of commands) {
      assert.ok(command.startsWith(`${NPX} `), command)
      // The role texts are the same for every project: the one command that names none.
      if (command.startsWith(`${NPX} agent `)) continue
      assert.match(command, new RegExp(`(-p|--project) ${HANDLE}( |$)`), command)
    }
    // No command of another release, and none left without one.
    assert.equal(task.split('conport@').length - 1, task.split(`conport@${CLI_VERSION}`).length - 1)
    assert.doesNotMatch(task, /<[NHVWB]>/)
  }
  assert.ok(epicTask(SDD).includes('Work by the skill superpowers:subagent-driven-development'))
  // Another epic, project, working copy and base reach every place of the text.
  const other = epicTask({ ...SDD, epic: 12, project: 'prabcdefgh', worktree: '/x/y', base: 'trunk' })
  assert.doesNotMatch(other, /(epic|task|_id|pull|task-|epic-) ?7\b|prk7m2qx9d|app-epic|`main`/)
  assert.ok(other.includes('`Epic task-12 is ready to merge`, linked to task 12'))
  assert.ok(other.includes('merge `epic-12` into `trunk` or any other branch'))
  assert.ok(other.includes('remove the working copy /x/y.'))
})

test('the SDD task names the four chosen types and conport:sdd-fixer', () => {
  assert.deepEqual(DEFAULT_ROLES, {
    implementer: 'conport:sdd-implementer',
    reviewer: 'conport:sdd-task-reviewer',
    gapHunter: 'conport:sdd-gap-hunter',
    finalReviewer: 'conport:sdd-final-reviewer'
  })
  assert.equal(FIXER_TYPE, 'conport:sdd-fixer')
  assert.deepEqual(block(epicTask(SDD), 'Roles').slice(0, 5), [
    'Roles — each role is the subagent type the person chose for this epic.',
    '- Implementer: `conport:sdd-implementer`. A fix round continues the same subagent, or goes to `conport:sdd-fixer` when it is gone.',
    '- Reviewer: `conport:sdd-task-reviewer`.',
    '- Gap hunter: `conport:sdd-gap-hunter`.',
    '- Final reviewer: `conport:sdd-final-reviewer`.'
  ])
  const chosen = epicTask({ ...SDD, roles: OTHER_ROLES })
  assert.deepEqual(block(chosen, 'Roles').slice(1, 5), [
    '- Implementer: `sdd-implementer`. A fix round continues the same subagent, or goes to `conport:sdd-fixer` when it is gone.',
    '- Reviewer: `team:strict-reviewer`.',
    '- Gap hunter: `gap.hunter`.',
    '- Final reviewer: `final_reviewer-2`.'
  ])
  // A chosen type replaces the default one: only the fixer keeps the plugin's name.
  assert.deepEqual([...chosen.matchAll(/conport:sdd-[\w-]+/g)].map((m) => m[0]), ['conport:sdd-fixer'])
})

test('a role type is a plain name', () => {
  for (const type of [...Object.values(DEFAULT_ROLES), ...Object.values(OTHER_ROLES), FIXER_TYPE]) {
    assert.match(type, ROLE_TYPE_FORM)
  }
  for (const type of ['', 'two words', "it's", 'a"b', 'a\nb', 'a`b', 'a$b', 'a/b']) {
    assert.doesNotMatch(type, ROLE_TYPE_FORM)
  }
})

test('the SDD task tells to start a role only as its named type and to stop and ask when a type is not found', () => {
  const roles = block(epicTask(SDD), 'Roles')
  assert.deepEqual(roles.slice(5), [
    'Start every role only as a subagent of the type named for it. Never put a subagent of another type, one without a type, ' +
      'or a general-purpose one, on a role, and never do the work of a role yourself. A subagent never starts a subagent.',
    'If a type is not found, stop and ask the person: the type is not installed, or its plugin is out of date. Do not go on without it.'
  ])
})

test('the SDD task names the six prescriptions not to carry out', () => {
  const never = block(epicTask(SDD), 'Never:')
  assert.equal(never[1], 'The texts you work by say otherwise in six places. Do not carry these out:')
  const listed = never.filter((l) => l.startsWith('- '))
  assert.equal(listed.length, 6)
  assert.match(listed[0] ?? '', /the line "Release" of the section "Epic in its own branch"/)
  assert.match(listed[1] ?? '', /step 8 of the overlay/)
  assert.match(listed[2] ?? '', /update_task\(task-7, DONE, …\)/)
  assert.match(listed[3] ?? '', /the answer to closing the last task of the epic/)
  assert.match(listed[4] ?? '', /"Definition of Done … epic task-7 closed"/)
  assert.match(listed[5] ?? '', /hand over to finishing-a-development-branch/)
  assert.equal(never.at(-1), 'For this run the work is finished at step 12 below, with the epic open.')
  assert.ok(epicTask(SDD).includes('except the six things named under "Never".'))
})

test('the SDD task tells not to close the epic on the echo of its last closed task', () => {
  // The answer of the server reaches every harness; the line of the skill only the one that has the skill.
  const answer = '- the answer to closing the last task of the epic, when it says "ready to close: update_task(…)" or `closable`'
  const [typed, other] = TEXTS.slice(0, 2).map((task) => block(task, 'Never:').find((l) => l.startsWith(answer)))
  assert.equal(typed, `${answer}, and the line "[EPIC] … ready to close — close it with a resolution now" of the conport skill;`)
  assert.equal(other, `${answer};`)
  // The count named in the text is the count of the lines listed under it.
  for (const [task, count] of [[TEXTS[0], 'six'], [TEXTS[1], 'three']] as const) {
    const never = block(task ?? '', 'Never:')
    assert.equal(never[1], `The texts you work by say otherwise in ${count} places. Do not carry these out:`)
    assert.equal(never.filter((l) => l.startsWith('- ')).length, count === 'six' ? 6 : 3)
  }
})

test('every epic task tells to keep its blocks word for word when the context is compacted', () => {
  const kept = (task: string): string => block(task, 'Rules').at(-1) ?? ''
  const lead = '- This task was given to you once, as the argument you were started with, and is stored nowhere else. '
  for (const task of TEXTS.slice(0, 2)) {
    assert.equal(kept(task), `${lead}When the context is compacted, keep its blocks "Rules", "Never", "Roles" and "Steps" word for word.`)
  }
  assert.equal(kept(TEXTS[2] ?? ''), `${lead}When the context is compacted, keep its blocks "Rules", "Never" and "Steps" word for word.`)
  // Each block the line names is a block of that very text.
  for (const task of TEXTS) {
    for (const [, name] of kept(task).matchAll(/"(\w+)"/g)) {
      assert.ok(task.split('\n').some((l) => l === name || l.startsWith(`${name}:`) || l.startsWith(`${name} — `)), name)
    }
  }
})

test('the task is built from the list of quotes, with the number of the epic in', () => {
  const { overlay, skill, finish, tail } = QUOTES
  const first = epicTask({ ...SDD, epic: 12 })
  for (const quote of [
    overlay.file, overlay.execution, overlay.dispatching, overlay.editing, `step ${overlay.finishStep} of the overlay`,
    overlay.finish, skill.section, skill.release, skill.closeLine, skill.closeAnswer,
    finish.line.replace('<M>', '12'), finish.verdict, tail.contract, tail.section, tail.done[0],
    tail.done[1].replace('<M>', '12'), tail.handOver
  ]) {
    assert.ok(first.includes(quote), quote)
  }
  const second = epicTask({ ...SDD, epic: 12, harness: 'codex' })
  for (const quote of [tail.marker, tail.contract, tail.section, tail.done[0], tail.done[1].replace('<M>', '12'), tail.handOver, skill.closeAnswer]) {
    assert.ok(second.includes(quote), quote)
  }
  assert.doesNotMatch(first + second, /<M>(?!\.md)/)
})

test('the SDD task lists the reasons to stop and tells to end the turn', () => {
  for (const task of TEXTS.slice(0, 2)) {
    const stop = task.split('\n').find((l) => l.startsWith('- Stop and ask the person only for: ')) ?? ''
    for (const reason of [
      'an operation that cannot be undone',
      'a merge conflict you cannot resolve without guessing',
      'a task whose review has not approved after three rounds',
      "the epic grown by more than 30% of the plan's tasks",
      'a task that is BLOCKED',
      'a dependency that can never close',
      'a subagent type named under "Roles" that is not found',
      'a refusal of the CLI or of its key',
      'checks that stay red after a merge and its fix round'
    ]) {
      assert.ok(stop.includes(reason), reason)
    }
    assert.ok(
      task.includes(
        "- When you ask, say what stopped you and the one thing you need, then end your turn and wait for the person's word. " +
          'Do not go on to another task while a question that holds the epic is open.'
      )
    )
  }
})

test('the api key never reaches an epic task', () => {
  for (const task of [...TEXTS, epicTask({ ...SDD, roles: OTHER_ROLES })]) {
    assert.doesNotMatch(task, /CONPORT_API_KEY|cport_/)
    assert.ok(task.includes('Never print or pass the ConPort API key: the CLI reads it itself.'))
  }
})

test('no epic task names orca agent launch or orca orchestration', () => {
  for (const task of TEXTS) {
    assert.doesNotMatch(task, /orca agent launch|orca orchestration|\borca\b/i)
    assert.doesNotMatch(task, /conport epic run|epic run/)
  }
})

test('a harness other than claude gets the second text', () => {
  const first = epicTask(SDD)
  for (const harness of ['codex', 'cursor', 'gemini', '']) {
    const task = epicTask({ ...SDD, harness, roles: OTHER_ROLES })
    assert.notEqual(task, first)
    // The roles go by the texts of the CLI, not by a skill.
    assert.ok(
      task.includes(
        `The steps below are the whole order of the work. The order of each role is printed by \`${NPX} agent ` +
          '<implementer|reviewer|gap-hunter|final-reviewer>`; a brief, a report, a review and a fix are entries of ' +
          'the task journal in ConPort, never files.'
      )
    )
    assert.doesNotMatch(task, /Work by the skill|subagent-driven-development|superpowers-overlay|the overlay/)
    assert.doesNotMatch(task, /superpowers-conport/)
    // No chosen type and no type of the plugin: a role is a subagent given the role's text.
    for (const type of [...Object.values(OTHER_ROLES), ...Object.values(DEFAULT_ROLES), FIXER_TYPE]) {
      assert.ok(!task.includes(type), type)
    }
    const roles = block(task, 'Roles')
    assert.deepEqual(roles, [
      'Roles — each role is a subagent of yours that works by the text the CLI prints for it.',
      `- Implementer: \`${NPX} agent implementer\`. A fix round goes to the implementer again.`,
      `- Reviewer: \`${NPX} agent reviewer\`.`,
      `- Gap hunter: \`${NPX} agent gap-hunter\`.`,
      `- Final reviewer: \`${NPX} agent final-reviewer\`.`,
      `Start every role only as a subagent of yours given the text of \`${NPX} agent <role>\` as its standing procedure, ` +
        'and the task number; never do the work of a role yourself. A subagent never starts a subagent.'
    ])
    // The journal and the plan are named by their commands.
    for (const kind of ['brief', 'report', 'fix']) {
      assert.ok(task.includes(`\`${NPX} journal add --task <id> --kind ${kind} --body-file <file> -p ${HANDLE}\``), kind)
    }
    assert.ok(
      task.includes(`\`${NPX} journal add --task <id> --kind review --verdict <approve|changes_requested> --body-file <file> -p ${HANDLE}\``)
    )
    assert.ok(task.includes(`\`${NPX} journal get --task <id> -p ${HANDLE}\``))
    const edit = task.split('\n').find((l) => l.startsWith('10. ')) ?? ''
    assert.ok(edit.includes(`\`${NPX} plan pull 7 -p ${HANDLE}\``))
    assert.ok(edit.includes(`\`${NPX} plan import .superpowers/plans/doc-<M>.md -p ${HANDLE}\``))
    // The finish section of the plan is skipped: the skill that runs it is not there.
    assert.ok(
      task.includes(
        `11. Check that every task of the epic is DONE or CANCELLED (\`${NPX} api tasks list --parent_task_id 7 --status ALL --include_snoozed true --limit 200 --project ${HANDLE}\`) ` +
          'and that the checks of the plan are green on `epic-7`. The section "ConPort finish" of the pulled plan is not for you: skip it.'
      )
    )
    // An approved task whose merge is red goes back through a review entry, by the command of the journal.
    const merge = task.split('\n').find((l) => l.startsWith('7. ')) ?? ''
    assert.ok(
      merge.includes(
        'Red checks or a conflict go back to the implementer of that task as one fix round: the task is in REVIEW, where a `fix` entry is not accepted, ' +
          'so the reviewer of that task first writes a `review` entry with the verdict `changes_requested` and the output of the checks or of the merge, ' +
          `\`${NPX} journal add --task <id> --kind review --verdict changes_requested --body-file <file> -p ${HANDLE}\`, and the fix round follows as in step 6. Then close the task: `
      )
    )
    // Of the six prescriptions the answer of the server and the two about the tail of the plan are left.
    const never = block(task, 'Never:')
    assert.deepEqual(never.slice(1), [
      'The texts you work by say otherwise in three places. Do not carry these out:',
      '- the answer to closing the last task of the epic, when it says "ready to close: update_task(…)" or `closable`;',
      '- in the tail of the pulled plan, "Definition of Done … epic task-7 closed";',
      '- in the tail of the pulled plan, "delete the workspace, hand over to finishing-a-development-branch".',
      'For this run the work is finished at step 12 below, with the epic open.'
    ])
    assert.equal(never[0], block(first, 'Never:')[0])
    // The readiness entry is written by its command.
    const ready = task.split('\n').find((l) => l.startsWith('12. ')) ?? ''
    assert.ok(
      ready.includes(
        `\`${NPX} api progress create --project ${HANDLE} --title "Epic task-7 is ready to merge" ` +
          '--description "<body>" --linked_item_type task --linked_item_id 7`'
      )
    )
    assert.ok(ready.includes('titled exactly `Epic task-7 is ready to merge`, linked to task 7'))
    assert.ok(ready.includes('that merging into `main`, the release and closing the epic are theirs.'))
  }
  // What the second text does not change is the first text, line for line.
  const second = epicTask({ ...SDD, harness: 'codex' }).split('\n')
  const kept = first.split('\n').filter((l) => second.includes(l))
  // Of steps 1 to 9 two differ: 6 and 7 name the journal by its commands.
  assert.equal(kept.filter((l) => /^[1-9]\. /.test(l)).length, 7)
  assert.deepEqual(block(second.join('\n'), 'Rules'), block(first, 'Rules'))
  assert.deepEqual(second.slice(0, 2), first.split('\n').slice(0, 2))
})

test('the workflow task names /conport:epic with the epic, the project and the plan', () => {
  const task = epicWorkflowTask(WORKFLOW)
  assert.match(task, new RegExp(`^Execute epic 7 of the ConPort project ${HANDLE} with the workflow /conport:epic\\.\n`))
  assert.ok(task.includes(`in the repository ${ROOT} on its default branch \`main\``))
  assert.ok(task.includes(`Pull the plan: \`${NPX} plan pull 7 -p ${HANDLE}\`.`))
  assert.ok(
    task.includes(`2. Start the workflow: \`/conport:epic {"epic": 7, "project": "${HANDLE}", "plan": ".superpowers/plans/doc-<M>.md"}\`.`)
  )
  assert.deepEqual(conportCommands(task), [`${NPX} plan pull 7 -p ${HANDLE}`])
  const other = epicWorkflowTask({ epic: 12, project: 'prabcdefgh', root: '/x/y', base: 'trunk' })
  // The CLI release is the one thing the two texts share, and it may carry the digit of the first epic.
  assert.doesNotMatch(other.replaceAll(NPX, 'npx'), /\b7\b|prk7m2qx9d|\/work\/app|`main`/)
  assert.ok(other.includes('`/conport:epic {"epic": 12, "project": "prabcdefgh", "plan": ".superpowers/plans/doc-<M>.md"}`'))
  assert.ok(other.includes('in the repository /x/y on its default branch `trunk`'))
})

test('the workflow task names the three outcomes', () => {
  const task = epicWorkflowTask(WORKFLOW)
  const last = task.split('\n').at(-1) ?? ''
  assert.match(last, /^3\. When it ends, tell the person its outcome as the run printed it/)
  for (const outcome of ['`EPIC_CLOSED`', '`DONE_EPIC_OPEN`', '`DONE_WITH_UNRESOLVED_CRITICALS`']) {
    assert.ok(last.includes(outcome), outcome)
  }
  assert.ok(last.includes('that pushing `main` and the release are theirs.'))
})

test('the workflow task names neither SDD nor a role and does not forbid a second run', () => {
  const task = epicWorkflowTask(WORKFLOW)
  assert.doesNotMatch(task, /SDD|subagent|superpowers:|\bskill\b/i)
  assert.doesNotMatch(task, /\broles?\b|implementer|reviewer|gap hunter|sdd-/i)
  assert.doesNotMatch(task, /second run|never run|not run it again|do not start it again|only once/i)
  assert.ok(
    task.includes('When they tell you to run it again, run the same command: the workflow picks up the branches an earlier run left.')
  )
})

/** The line of step `n` of a text. */
const stepOf = (text: string, n: number): string => text.split('\n').find((l) => l.startsWith(`${n}. `)) ?? ''

test('every epic task calls init without questions in its first step', () => {
  const line = 'If you call `init` of ConPort, call it with `questions=false`: this run takes up no questions about the project.'
  for (const task of TEXTS) {
    assert.ok(stepOf(task, 1).startsWith(`1. ${line} `), stepOf(task, 1))
    assert.equal(task.split('questions=false').length - 1, 1)
  }
})

test('the SDD task brings the base into a branch of the epic that lags behind it before a task branch is cut', () => {
  for (const harness of ['claude', 'codex']) {
    const where = stepOf(epicTask({ ...SDD, harness }), 4)
    assert.ok(
      where.endsWith(
        'If `epic-7` does not hold the tip of `main` (`git merge-base --is-ancestor main epic-7` fails), ' +
          'bring `main` into it in this working copy before any branch `task-<id>` is cut: `git merge --ff-only main`, ' +
          'and when that refuses because `epic-7` has commits of its own, `git merge main`; a conflict of that merge is a question to the person.'
      ),
      where
    )
    // The epic is taken first, then the base is brought in.
    assert.ok(where.indexOf('--status IN_PROGRESS') < where.indexOf('git merge-base'))
  }
  // The base and the epic are the ones given.
  const other = stepOf(epicTask({ ...SDD, epic: 12, base: 'release/1.x' }), 4)
  assert.ok(other.includes('(`git merge-base --is-ancestor release/1.x epic-12` fails)'), other)
  assert.ok(other.includes('`git merge --ff-only release/1.x`, and when that refuses because `epic-12` has commits of its own, `git merge release/1.x`;'))
})

test('the SDD task puts the working copy of a task beside the working copy of the epic', () => {
  for (const harness of ['claude', 'codex']) {
    const order = stepOf(epicTask({ ...SDD, harness }), 5)
    assert.ok(order.endsWith('The working copy of a task is the folder /work/task-<id>, beside /work/app-epic-7, never inside it.'), order)
  }
  const cases: Array<[string, string]> = [
    ['/x/y/epic-12', '/x/y/task-<id>'],
    ['/x/y/epic-12/', '/x/y/task-<id>'],
    ['/epic-12', '/task-<id>']
  ]
  for (const [worktree, folder] of cases) {
    const order = stepOf(epicTask({ ...SDD, worktree }), 5)
    assert.ok(order.includes(`The working copy of a task is the folder ${folder}, beside ${worktree}, never inside it.`), order)
  }
})

test('the SDD task takes a task into work before its implementer is dispatched', () => {
  const take = `Take the task before dispatching its implementer: \`${NPX} api tasks update --task_id <id> --status IN_PROGRESS --project ${HANDLE}\`.`
  for (const harness of ['claude', 'codex']) {
    const one = stepOf(epicTask({ ...SDD, harness }), 6)
    assert.ok(one.includes(take), one)
    assert.ok(one.indexOf('Write the brief') < one.indexOf(take))
    assert.ok(one.indexOf(take) < one.indexOf('Dispatch the implementer'))
  }
})

test('the first text is the text of the spec', () => {
  assert.equal(epicTask(SDD), spec(FIRST_TEXT))
})

test('the workflow task is the third text of the spec', () => {
  assert.equal(epicWorkflowTask(WORKFLOW), spec(THIRD_TEXT))
})

test('the epic task survives the shell as one argument', () => {
  const awkward = { ...SDD, project: `it's "q" $HOME \`x\``, worktree: "/work/my app's/epic-7" }
  for (const task of [...TEXTS, epicTask(awkward), epicTask({ ...awkward, harness: 'cursor' })]) {
    const line = commandLine(['/bin/sh', '-c', 'printf %s "$1"', 'sh', task])
    assert.equal(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' }), task)
  }
})

test('the first text stays under 10000 characters', () => {
  const longest = epicTask({
    ...SDD,
    epic: 99999,
    worktree: `/work/someone/orca/workspaces/a-long-repository-name/epic-99999`,
    base: 'release/a-long-branch-name',
    roles: {
      implementer: 'a-long-plugin-name:a-long-implementer-type',
      reviewer: 'a-long-plugin-name:a-long-reviewer-type',
      gapHunter: 'a-long-plugin-name:a-long-gap-hunter-type',
      finalReviewer: 'a-long-plugin-name:a-long-final-reviewer-type'
    }
  })
  assert.ok(longest.length < 10000, `${longest.length} characters`)
  assert.ok(epicTask(SDD).length < 10000)
})
