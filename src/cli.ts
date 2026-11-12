// The command lines of the conport CLI and how its answers read. No Node imports: pure.
import type { HandMode, OutsideTask, Refusal, Result, Roles } from './protocol'

/** The conport CLI release the panel runs: kept equal to the CLI of the same repository. */
export const CLI_VERSION = '0.8.0'

/** How the CLI is started, as the person would type it. */
export const CONPORT = ['npx', '-y', `conport@${CLI_VERSION}`]

/** A child process's exit, or why it never ran. */
export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not be started or was killed for running too long. */
  failure?: string
}

/** Quotes a word for a POSIX shell unless it needs no quoting. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

export function commandLine(args: readonly string[]): string {
  return args.map(shellWord).join(' ')
}

/**
 * The document an epic that cannot run lacks, read from the reason `conport epic list` gives:
 * the spec first, as the CLI checks it first. Null for any other reason: nothing to prepare.
 */
export function missingDocument(reason: string | null): 'spec' | 'plan' | null {
  return reason === 'no spec' ? 'spec' : reason === 'no plan' ? 'plan' : null
}

/**
 * The agent kinds that take their first request as a positional argument and start a talk with
 * it: only these can prepare an epic or take a task. Others read that argument as something else
 * (a folder).
 */
export const PREPARE_AGENTS: readonly string[] = ['claude', 'codex', 'cursor']

/** What a prepared epic lacks, and of which project. */
export interface PrepareInput {
  epic: number
  /** The project handle, as `conport epic list` answered it. */
  project: string
  missing: 'spec' | 'plan'
}

/**
 * The task an agent is started with to prepare an epic for its start: a talk with the person in
 * the terminal that ends in a spec and a plan in ConPort, each stored only once the person
 * approved it. Every ConPort command it names carries the project and the CLI release of the
 * panel; the API key is never in it, the CLI reads that itself.
 */
export function prepareTask({ epic, project, missing }: PrepareInput): string {
  const npx = `npx -y conport@${CLI_VERSION}`
  const cli = (args: string): string => `\`${npx} ${args} -p ${project}\``
  // The generic API commands name the project by their own flag.
  const api = (args: string): string => `\`${npx} api ${args} --project ${project}\``
  // The tasks the epic already has: an open one the plan has no section for is closed before the import.
  const tasks =
    `Read the tasks the epic already has: ${api(`tasks list --parent_task_id ${epic} --status ALL --include_snoozed true --limit 200`)}. ` +
    'Each task that is neither DONE nor CANCELLED is open. Agree with the person which open tasks the plan keeps; ' +
    `close every other open task before the import, only with the person's consent: ${api('tasks update --task_id <id> --status CANCELLED')}.`
  const planFormat =
    'The plan is a Markdown file: a `# <title>` line at the top; a `## Global Constraints` section with the line ' +
    '`Gate object: {"dir": ".", "commands": ["<a command that checks the repository>"]}` naming the checks of this ' +
    'repository; then one section per task, `### Task <n>: <title>`, each with a `**Goal:**` line and an ' +
    '`**Acceptance:**` line (the import refuses a section without them). The section of every open task the plan ' +
    'keeps has the line `<!-- conport-task: <id> -->` right under its `### Task <n>:` heading, `<id>` being the ' +
    'number of that task; a section without that line becomes a new task.'
  const plan = (spec: string): string[] => [
    `Write the plan of the epic from the spec. ${planFormat} Show it to the person and change it until they approve it.`,
    `Only after the person approved the plan, and the open tasks it does not keep are closed, import it: ` +
      `${cli(`plan import <plan file> --spec ${spec} --epic ${epic}`)}`
  ]
  const steps =
    missing === 'spec'
      ? [
          tasks,
          'Discuss the epic with the person: its goal, what is in and out of it, the constraints. Ask until the design is clear.',
          'Write the spec as a Markdown file with a `# <title>` line at the top. Show it to the person and change it until they approve it.',
          `Only after the person approved the spec, upload it: ${cli('documents upload <spec file> --doc-type spec')}. ` +
            'Its answer is JSON; its `id` is the number of the new document: doc-<id>.',
          ...plan('doc-<id of the uploaded spec>')
        ]
      : [
          `Find the spec of the epic: list the links of the epic with ${api(`links list --item_type task --item_id ${epic}`)}; ` +
            'the spec is the document (`source_type` `doc`) linked to the epic with `clarifies` whose type is `spec`. ' +
            `${cli('documents get doc-<number>')} writes a document to a file and names its type. Read the spec.`,
          tasks,
          'Discuss the plan with the person: the tasks, their order, the checks of the repository.',
          ...plan('doc-<number of the spec>')
        ]
  return [
    `Prepare epic ${epic} of the ConPort project ${project} for its start: ` +
      (missing === 'spec' ? 'it has no spec yet, and needs a spec and a plan.' : 'it has a spec, and needs a plan.'),
    '',
    'Talk with the person in this terminal, in the language they write in. Store nothing in ConPort before they approve it.',
    'Run every ConPort command exactly as written here, with the CLI release and the project it names. ' +
      'Never print or pass the ConPort API key: the CLI reads it itself.',
    '',
    `1. Read the epic: ${api(`tasks get --task_id ${epic}`)}`,
    ...steps.map((step, i) => `${i + 2}. ${step}`),
    `${steps.length + 2}. Tell the person the epic is ready to start: they press refresh in the ConPort Epics panel of Orca.`
  ].join('\n')
}

/** The subagent type each role of an epic starts with: the types of the conport plugin. */
export const DEFAULT_ROLES: Roles = {
  implementer: 'conport:sdd-implementer',
  reviewer: 'conport:sdd-task-reviewer',
  gapHunter: 'conport:sdd-gap-hunter',
  finalReviewer: 'conport:sdd-final-reviewer'
}

/** The subagent type of a fix round whose implementer is gone: never chosen. */
export const FIXER_TYPE = 'conport:sdd-fixer'

/**
 * The form of a project handle. The panel never shows one as the name of a project, and the
 * worker keeps what is chosen for an epic under it.
 */
export const HANDLE_FORM = /^pr[a-hjkmnp-z2-9]{8}$/

/** A subagent type is a plain name: it goes into the text of a task and into a command line. */
export const ROLE_TYPE_FORM = /^[\w.:-]+$/

/** An epic done by the SDD skill: where, from which branch, by which harness and subagent types. */
export interface EpicTaskInput {
  epic: number
  /** The project handle, as `conport epic list` answered it. */
  project: string
  /** The working copy of the branch `epic-<N>`. */
  worktree: string
  /** The branch the epic was cut from and is merged into by the person. */
  base: string
  /** The agent kind that leads the epic: `claude` works by the skill, another by the role texts of the CLI. */
  harness: string
  roles: Roles
}

/** An epic done by the workflow `/conport:epic`: in the repository root, on its default branch. */
export interface EpicWorkflowInput {
  epic: number
  /** The project handle, as `conport epic list` answered it. */
  project: string
  /** The main working tree of the repository. */
  root: string
  /** Its default branch: the workflow merges into it. */
  base: string
}

/**
 * The words of other texts the task of an epic names, each by where it stands there: the task is
 * built from this list alone. A test of the conport CLI holds every entry against its source, so
 * a step renumbered or a line reworded there is seen before the task points at nothing. `<M>`
 * stands for the number of the epic.
 */
export const QUOTES = {
  /** The reference of the conport skill: steps of its flow by title, one by number, a part of a step. */
  overlay: {
    file: 'references/superpowers-overlay.md',
    execution: 'Execution',
    dispatching: 'Dispatching a subagent',
    editing: 'Editing the plan during the work',
    finishStep: 8,
    finish: 'on a READY verdict the epic is closed, then the release follows'
  },
  /** The conport skill itself: a section, a line of it, and its order to close an epic at once. */
  skill: {
    section: 'Epic in its own branch',
    release: 'Release',
    closeLine: 'ready to close — close it with a resolution now',
    closeAnswer: 'ready to close: update_task('
  },
  /** The `finish` mode of the superpowers-conport skill: its verdict and the line printed with it. */
  finish: {
    mode: 'finish',
    verdict: 'READY',
    line: 'Сделай сейчас: update_task(task-<M>, DONE, '
  },
  /** The tail `plan pull` writes under a plan: its marker, its two headings, two of its orders. */
  tail: {
    marker: '<!-- conport-pull-tail -->',
    contract: 'ConPort execution contract',
    section: 'ConPort finish',
    done: ['Definition of Done', 'epic task-<M> closed'],
    handOver: 'delete the workspace, hand over to finishing-a-development-branch'
  }
} as const

/** The one title of the tails epic of a release, looked up before one is filed (the conport-roadmap skill). */
const TAILS_TITLE = 'Tails of release <title of the release milestone>'

// The lines the tasks of an epic share, whichever way it is done.
const EPIC_LEAD = 'You are the lead session of the epic. You work in this terminal, in '
const EPIC_HEARD = '; the person reads this terminal and can talk to you here.'
const EPIC_TALK =
  '- Talk with the person in the language they write in. Do not ask leave to begin: you were started to do the epic.'
const EPIC_COMMANDS =
  '- Run every ConPort command exactly as written here, with the CLI release and the project it names. ' +
  'Never print or pass the ConPort API key: the CLI reads it itself.'
/** The task is an argument of the command line and is stored nowhere: its blocks outlive a compaction only if kept. */
const keepBlocks = (blocks: string): string =>
  '- This task was given to you once, as the argument you were started with, and is stored nowhere else. ' +
  `When the context is compacted, keep its blocks ${blocks} word for word.`
const PLAN_FILE = '.superpowers/plans/doc-<M>.md'
/** A run started from the panel takes up no questions about the project: `init` hands out none. */
const INIT_QUIET = 'If you call `init` of ConPort, call it with `questions=false`: this run takes up no questions about the project.'
const pullPlan = (pull: string): string =>
  `Pull the plan: ${pull}. It writes \`${PLAN_FILE}\` and a \`.conport.json\` beside it: keep both.`

/**
 * The task the lead session of an epic is started with when the epic is done by the SDD skill:
 * the whole order of the work on the branch `epic-<N>`, up to the entry that says it is ready to
 * merge. Claude Code works by the skills and starts each role as the subagent type chosen for it;
 * another harness has neither, so it gets the same order with the role texts and the journal
 * named by their CLI commands, and the chosen types stay out of it. Every ConPort command carries
 * the project and the CLI release of the panel; the API key is never in it.
 */
export function epicTask({ epic, project, worktree, base, harness, roles }: EpicTaskInput): string {
  const typed = harness === 'claude'
  const npx = `npx -y conport@${CLI_VERSION}`
  const cli = (args: string): string => `\`${npx} ${args} -p ${project}\``
  // The generic API commands name the project by their own flag.
  const api = (args: string): string => `\`${npx} api ${args} --project ${project}\``
  const role = (name: string): string => `\`${npx} agent ${name}\``
  const branch = `\`epic-${epic}\``
  const ready = `Epic task-${epic} is ready to merge`
  const journal = (kind: string): string => cli(`journal add --task <id> --kind ${kind} --body-file <file>`)
  const tasks = `tasks list --parent_task_id ${epic} --status ALL --include_snoozed true --limit 200`
  const forEpic = (quote: string): string => quote.replace('<M>', String(epic))
  // The working copies of the tasks go into the folder that holds the working copy of the epic.
  const folder = worktree.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
  const baseWord = shellWord(base)
  // An approved task is in REVIEW: only a review entry sends it back to its implementer.
  const sendBack = typed ? '' : `, ${journal('review --verdict changes_requested')}`
  const { overlay, skill, finish: finishMode, tail } = QUOTES

  const way = typed
    ? [
        'Work by the skill superpowers:subagent-driven-development, with the changes the conport skill makes to it:',
        `its reference \`${overlay.file}\`, steps "${overlay.execution}" and "${overlay.dispatching}", and the first two ` +
          `paragraphs of the section "${skill.section}" of the conport skill itself (the branch of the epic, a branch per task).`,
        'A brief, a report, a review and a fix are entries of the task journal in ConPort, never files.'
      ]
    : [
        `The steps below are the whole order of the work. The order of each role is printed by ${role('<implementer|reviewer|gap-hunter|final-reviewer>')}; ` +
          'a brief, a report, a review and a fix are entries of the task journal in ConPort, never files.'
      ]

  const planTail = [
    `- in the tail of the pulled plan, "${tail.done[0]} … ${forEpic(tail.done[1])}";`,
    `- in the tail of the pulled plan, "${tail.handOver}".`
  ]
  // Closing the last task is answered with an order to close the epic, before the gap hunt has run.
  const closeEcho =
    `- the answer to closing the last task of the epic, when it says "${skill.closeAnswer}…)" or \`closable\`` +
    (typed ? `, and the line "[EPIC] … ${skill.closeLine}" of the conport skill;` : ';')
  const notCarried = typed
    ? [
        `- the line "${skill.release}" of the section "${skill.section}" (merge into main, push main);`,
        `- step ${overlay.finishStep} of the overlay, "${overlay.finish}";`,
        `- the line \`${forEpic(finishMode.line)}…)\` the \`${finishMode.mode}\` mode prints with ${finishMode.verdict};`,
        closeEcho,
        ...planTail
      ]
    : [closeEcho, ...planTail]

  const roleLines = typed
    ? [
        'Roles — each role is the subagent type the person chose for this epic.',
        `- Implementer: \`${roles.implementer}\`. A fix round continues the same subagent, or goes to \`${FIXER_TYPE}\` when it is gone.`,
        `- Reviewer: \`${roles.reviewer}\`.`,
        `- Gap hunter: \`${roles.gapHunter}\`.`,
        `- Final reviewer: \`${roles.finalReviewer}\`.`,
        'Start every role only as a subagent of the type named for it. Never put a subagent of another type, one without a type, ' +
          'or a general-purpose one, on a role, and never do the work of a role yourself. A subagent never starts a subagent.',
        'If a type is not found, stop and ask the person: the type is not installed, or its plugin is out of date. Do not go on without it.'
      ]
    : [
        'Roles — each role is a subagent of yours that works by the text the CLI prints for it.',
        `- Implementer: ${role('implementer')}. A fix round goes to the implementer again.`,
        `- Reviewer: ${role('reviewer')}.`,
        `- Gap hunter: ${role('gap-hunter')}.`,
        `- Final reviewer: ${role('final-reviewer')}.`,
        `Start every role only as a subagent of yours given the text of ${role('<role>')} as its standing procedure, ` +
          'and the task number; never do the work of a role yourself. A subagent never starts a subagent.'
      ]

  const take = `Take the task before dispatching its implementer: ${api('tasks update --task_id <id> --status IN_PROGRESS')}.`
  const oneTask = typed
    ? 'One task. Write the brief into its journal (`kind="brief"`: the full text of its plan section and the context the implementer needs). ' +
      `${take} ` +
      'Dispatch the implementer with the task number and how to read the journal, nothing else. Its report is the `report` entry. ' +
      'Dispatch the reviewer with the task number and the two commits to compare. Its verdict is the `review` entry: ' +
      'on `changes_requested` the implementer fixes every finding and writes a `fix` entry, then the reviewer reviews again; on `approve` go to step 7.'
    : `One task. Write the brief into its journal: ${journal('brief')} (the full text of its plan section and the context the implementer needs). ` +
      `${take} ` +
      `Dispatch the implementer with the task number and how to read the journal, ${cli('journal get --task <id>')}, nothing else. ` +
      `Its report is the \`report\` entry: ${journal('report')}. ` +
      'Dispatch the reviewer with the task number and the two commits to compare. ' +
      `Its verdict is the \`review\` entry, ${journal('review --verdict <approve|changes_requested>')}: ` +
      `on \`changes_requested\` the implementer fixes every finding and writes a \`fix\` entry, ${journal('fix')}, ` +
      'then the reviewer reviews again; on `approve` go to step 7.'
  const newSection = typed
    ? `as the overlay's step "${overlay.editing}" says: pull, add the section with the next free number, \`plan import\`, pull again.`
    : `by the commands of the plan: pull it (${cli(`plan pull ${epic}`)}), add the section with the next free number above the line ` +
      `\`${tail.marker}\`, import the file (${cli(`plan import ${PLAN_FILE}`)}), pull again.`
  const finish = typed
    ? `The section "${tail.section}" at the end of the pulled plan: run the skill superpowers-conport in \`${finishMode.mode}\` mode on the pulled plan file ` +
      `and do what it prescribes until it says ${finishMode.verdict} — except the six things named under "Never".`
    : `Check that every task of the epic is DONE or CANCELLED (${api(tasks)}) and that the checks of the plan are green on ${branch}. ` +
      `The section "${tail.section}" of the pulled plan is not for you: skip it.`
  // Without the conport plugin nothing but the CLI writes the entry: its command is spelled out.
  const readyEntry = typed
    ? ''
    : `: \`${npx} api progress create --project ${project} --title "${ready}" --description "<body>" --linked_item_type task --linked_item_id ${epic}\``

  const steps = [
    `${INIT_QUIET} Read the epic: ${api(`tasks get --task_id ${epic}`)}, and its tasks: ${api(tasks)}. The dependencies of a task are in its \`tasks get\`.`,
    `${pullPlan(cli(`plan pull ${epic}`))} Read the whole plan, its Global Constraints first. ` +
      `Its last section, "${tail.section}", and the "${tail.contract}" above it are written by \`plan pull\`: they are no task of the epic.`,
    `Read the spec: ${api(`links list --item_type task --item_id ${epic}`)} names the document of type \`spec\` linked to the epic with \`clarifies\`; ` +
      `${cli('documents get doc-<S>')} writes it to \`.superpowers/docs/doc-<S>.md\`.`,
    'Find where the epic stands, for it may have been started before. A task DONE or CANCELLED is finished. A task in REVIEW goes to its review. ' +
      'A task IN_PROGRESS goes on from its journal: the latest entry says whether a report, a review or a fix is due. ' +
      '`git worktree list` shows the working copies an earlier session left: a task whose branch `task-<id>` has a working copy goes on in that copy; ' +
      'a branch `task-<id>` without one gets a working copy added for it; ' +
      `never delete a branch or a working copy that holds commits not merged into ${branch}. ` +
      `If the epic is TODO, take it: ${api(`tasks update --task_id ${epic} --status IN_PROGRESS`)}. ` +
      `If ${branch} does not hold the tip of \`${base}\` (\`git merge-base --is-ancestor ${baseWord} epic-${epic}\` fails), ` +
      `bring \`${base}\` into it in this working copy before any branch \`task-<id>\` is cut: \`git merge --ff-only ${baseWord}\`, ` +
      `and when that refuses because ${branch} has commits of its own, \`git merge ${baseWord}\`; a conflict of that merge is a question to the person.`,
    'Order. A task is ready when every task it depends on (`blocks`, `requires`) is DONE; among ready tasks the order is the section number of the plan. ' +
      `Run ready tasks in parallel, each in a working copy of its own on the branch \`task-<id>\` cut from ${branch}; ` +
      'start the next ones as soon as their dependencies close. ' +
      `The working copy of a task is the folder ${folder}/task-<id>, beside ${worktree}, never inside it.`,
    oneTask,
    `Merge. Merge \`task-<id>\` into ${branch} in this working copy, one task at a time, and run there the checks the plan names in its Global Constraints. ` +
      'Red checks or a conflict go back to the implementer of that task as one fix round: the task is in REVIEW, where a `fix` entry is not accepted, ' +
      'so the reviewer of that task first writes a `review` entry with the verdict `changes_requested` and the output of the checks or of the merge' +
      `${sendBack}, and the fix round follows as in step 6. ` +
      `Then close the task: ${api('tasks update --task_id <id> --status DONE --resolution "<what was done, the merge commit>"')}, and remove its working copy.`,
    `Gap hunt, once, when every task of the epic is DONE or CANCELLED: the whole branch ${branch} against the spec, with the goal as the spec states it. ` +
      'Every Blocker and Should-fix becomes a task of the epic; a Note is ordinary work: a task of the epic within the ceiling of the Rules, of the tails epic past it. ' +
      'A Note only the person can answer is asked of the person at once, and the answer becomes the task.',
    'Final review, once, after the tasks of the gap hunt are merged: the whole branch against the spec. ' +
      'Every Critical and Important becomes a task of the epic; a Minor is ordinary work: a task of the epic within the ceiling of the Rules, of the tails epic past it. ' +
      'There is no second final review.',
    // The plan section kind identifies a defect across every surface.
    `A finding that becomes a task of this epic is a new section of the plan, ${newSection} ` +
      "File a defect as kind='bug': label its plan section `kind: bug`; ordinary work uses kind='task'. " +
      'It then runs through steps 6 and 7 once.',
    finish,
    `On READY, log a progress entry titled exactly \`${ready}\`, linked to task ${epic}${readyEntry}. ` +
      `Its body: the head commit of ${branch}, and the numbers of the tasks made from the findings of the gap hunt and of the final review. ` +
      `Then tell the person the same: the branch, its head commit, those task numbers, and that merging into \`${base}\`, the release and closing the epic are theirs.`
  ]

  return [
    `Execute epic ${epic} of the ConPort project ${project} by its plan, until the branch ${branch} is ready to merge into \`${base}\`.`,
    `${EPIC_LEAD}the working copy ${worktree} on the branch ${branch}${EPIC_HEARD}`,
    '',
    ...way,
    '',
    'Rules',
    EPIC_TALK,
    `${EPIC_COMMANDS} The ConPort MCP tools do the same steps as well, with project="${project}".`,
    '- Run no checks before the first task: the checks of the repository run inside the tasks and after the merges, where the steps below name them.',
    '- Decide an ambiguity by the spec and record the decision in the journal of the task.',
    '- In steps 8-10 too, read get_task(<epic>) for epic_progress: growth_ceiling is the server ceiling, null means no ceiling; use ordinary_added to read the remaining room, never count locally. On epic_growth_ceiling execute the ordered calls from suggestions (plan import prints them); refused ordinary work and polish ' +
      `go to the epic \`${TAILS_TITLE}\`: look for it before filing one. ` +
      'It is filed with priority 1. Inspect the next open milestone after the release: if it is a release, find the oldest open tails epic with the exact title in that milestone, or create it there; otherwise find or create it without a milestone, file the work, and ask the person which milestone it goes to. ' +
      'When suggestions include ask_user_milestone, the target tails epic has no milestone, whether found or created: ask the person where it belongs. Waiting work goes to the waiting milestone. ' +
      "A defect (kind='bug') never counts: a review's Critical or Important, a gap hunt's Blocker or Should-fix, a confirmed behaviour defect.",
    // The rule of the release (the conport-roadmap skill): the executor of the epic reads no project instructions.
    `- An epic does not bump a version: leave every version as \`${base}\` has it and write the changes into the changelog of the unit under \`## Unreleased\`; ` +
      'the version of every changed unit is bumped once, at the release step, after every epic of the release milestone has merged.',
    '- Stop and ask the person only for: an operation that cannot be undone; a merge conflict you cannot resolve without guessing; ' +
      'a task whose review has not approved after three rounds; ' +
      'a Note of the gap hunt only the person can answer; ' +
      'which milestone the tails epic goes to, when the rule above says to ask; ' +
      'a step that cannot be done as it is written here — a task that is BLOCKED, a dependency that can never close, ' +
      'a subagent type named under "Roles" that is not found, a refusal of the CLI or of its key, checks that stay red after a merge and its fix round.',
    "- When you ask, say what stopped you and the one thing you need, then end your turn and wait for the person's word. " +
      'Do not go on to another task while a question that holds the epic is open.',
    '- Every commit message is in the Conventional Commits form and never mentions an AI, an assistant or a model, and carries no Co-Authored-By line.',
    keepBlocks('"Rules", "Never", "Roles" and "Steps"'),
    '',
    `Never: push anything; merge ${branch} into \`${base}\` or any other branch; deploy; apply a migration or touch a production service; ` +
      `close the epic; remove the working copy ${worktree}. Those are the person's.`,
    `The texts you work by say otherwise in ${typed ? 'six' : 'three'} places. Do not carry these out:`,
    ...notCarried,
    'For this run the work is finished at step 12 below, with the epic open.',
    '',
    ...roleLines,
    '',
    'Steps',
    ...steps.map((step, i) => `${i + 1}. ${step}`)
  ].join('\n')
}

/**
 * The task the lead session of an epic is started with when the epic is done by the workflow
 * `/conport:epic`: pull the plan, start the workflow, tell the person how it ended. The workflow
 * does the rest itself, so the task names no role and no check; a second run is the same command.
 */
export function epicWorkflowTask({ epic, project, root, base }: EpicWorkflowInput): string {
  const npx = `npx -y conport@${CLI_VERSION}`
  const pull = `\`${npx} plan pull ${epic} -p ${project}\``
  const { tail } = QUOTES
  const steps = [
    `${INIT_QUIET} ${pullPlan(pull)}`,
    `Start the workflow: \`/conport:epic {"epic": ${epic}, "project": "${project}", "plan": "${PLAN_FILE}"}\`.`,
    'When it ends, tell the person its outcome as the run printed it — `EPIC_CLOSED`, `DONE_EPIC_OPEN` or `DONE_WITH_UNRESOLVED_CRITICALS` — ' +
      `with the tasks done, failed and skipped and the numbers of the tasks made from findings, and that pushing \`${base}\` and the release are theirs.`,
    // What only the person can settle comes in the ledger with the run's own way to act on each answer: the ceiling
    // of work added after the plan and the tails epic of the release are in it, so it is followed, not replaced.
    'When its ledger has `questions`, they are what only the person can settle, the findings it held for them among them, ' +
      'and its `questions_action` says what to do with each answer. ' +
      'Ask the person each question at once, one at a time, with its title, and wait for the answer; ' +
      `then do with the answer what \`questions_action\` says, with the ConPort MCP tools it names and project="${project}". ` +
      'When a question has no task and its title is the title of an entry of `unfiled_findings`, its task is the one step 5 finds: ' +
      'the answer goes to that task, and only when step 5 finds none does it get a new child.',
    // The run filed it already, at its accounting: the section binds to that task, never a second one.
    'Every entry of `unfiled_findings` in its ledger — its `title`, `brief` and `question` — is a finding the run filed ' +
      'at its accounting as a child of the epic with that title: find that task among the children of the epic ' +
      `(\`${npx} api tasks list --parent_task_id ${epic} --status ALL --include_snoozed true --limit 200 --project ${project}\`). ` +
      'An entry with a `question` is settled in step 4. ' +
      `An entry without one is bound to a section of the plan: pull the plan (${pull}), ` +
      `add a section with the next free number above the line \`${tail.marker}\`, with its title, ` +
      'the marker `<!-- conport-task: <id> -->` of that task under the heading and `brief` as its requirement, ' +
      `import the file (\`${npx} plan import ${PLAN_FILE} -p ${project}\`), pull again. ` +
      'No such task — the accounting could not file it: add the section the same way without a marker, and the import creates its task.',
    'Tell the person the numbers of the tasks steps 4 and 5 made, moved or kept; ' +
      'when they tell you to run the workflow again, the same command runs the sections step 5 added.'
  ]
  return [
    `Execute epic ${epic} of the ConPort project ${project} with the workflow /conport:epic.`,
    `${EPIC_LEAD}the repository ${root} on its default branch \`${base}\`${EPIC_HEARD}`,
    '',
    'Rules',
    EPIC_TALK,
    EPIC_COMMANDS,
    `- The workflow runs the checks, the working copies, the reviews, the merges into \`${base}\`, the gap hunt, the acceptance and the accounting in ConPort itself. ` +
      'Do none of that by hand, before it or beside it.',
    '- When the workflow stops with a question, an `ABORTED_…` status or a failed task, tell the person here what it said and the one thing to do, ' +
      'then end your turn and wait for their word. When they tell you to run it again, run the same command: the workflow picks up the branches an earlier run left.',
    keepBlocks('"Rules", "Never" and "Steps"'),
    '',
    'Never: push anything; deploy; apply a migration or touch a production service; merge by hand.',
    '',
    'Steps',
    ...steps.map((step, i) => `${i + 1}. ${step}`)
  ].join('\n')
}

/** A task outside the epics handed to an agent, and of which project. */
export interface HandInput {
  task: number
  /** The project handle, as `conport task list` answered it. */
  project: string
  mode: HandMode
  /** The agent kind that takes it: it signs its journal entry. */
  agent: string
  /** The main working tree of the repository: the work goes to a worktree beside it. */
  root: string
}

/** The folder beside the repository `root` where task `task` is done, on its own branch. */
function taskWorktree(root: string, task: number): string {
  return `${root.replace(/\/+$/, '')}-task-${task}`
}

/**
 * What a task outside the epics can be handed to an agent for: a todo one to do, one in review
 * to review, one in progress that its review sent back to fix; null for one an agent is at.
 */
export function handMode(task: OutsideTask): HandMode | null {
  if (task.status === 'TODO') return 'do'
  if (task.status === 'REVIEW') return 'review'
  return task.changes_requested ? 'fix' : null
}

/**
 * The task an agent is started with to do a task outside the epics, to review the work done on
 * one, or to fix what its review found. The work is done on branch `task-<N>` in a worktree of its
 * own beside the repository and committed there; the person merges it. The review checks that
 * branch and, on approval and with the person's yes, closes the task; on a request for changes
 * the fix goes on in the same branch. Every ConPort command it names carries the project and the
 * CLI release of the panel; the API key is never in it, the CLI reads that itself.
 */
export function handTask({ task, project, mode, agent, root }: HandInput): string {
  const npx = `npx -y conport@${CLI_VERSION}`
  const cli = (args: string): string => `\`${npx} ${args} -p ${project}\``
  // The generic API commands name the project by their own flag.
  const api = (args: string): string => `\`${npx} api ${args} --project ${project}\``
  const rules = [
    'Talk with the person in this terminal, in the language they write in.',
    'Run every ConPort command exactly as written here, with the CLI release and the project it names. ' +
      'Never print or pass the ConPort API key: the CLI reads it itself. ' +
      'With the ConPort MCP server at hand, its tools for the same steps do as well.'
  ]
  const read = `${INIT_QUIET} Read the task: ${api(`tasks get --task_id ${task}`)}, and its journal: ${cli(`journal get --task ${task}`)}.`
  const branch = `task-${task}`
  const folder = taskWorktree(root, task)
  const git = (args: string[]): string => `\`${commandLine(['git', '-C', root, ...args])}\``
  const commit =
    `Commit the work on the branch \`${branch}\`, each commit message in the Conventional Commits form (\`feat: …\`, \`fix: …\`). ` +
    'A commit message never mentions an AI, an assistant or a model, and carries no Co-Authored-By line. ' +
    "Never merge the branch and never push it: merging it is the person's."
  const steps =
    mode === 'fix'
      ? [
          `${read} Read the latest review in it: each of its findings is what to fix.`,
          `Go on in the worktree of the branch the report names (\`${branch}\` unless it names another), never in the working copy of this terminal: ` +
            `find it with ${git(['worktree', 'list'])}. If the branch has no worktree, add one: ${git(['worktree', 'add', folder, branch])}.`,
          'Fix every finding of the latest review there, test first, and run the checks the repository names; ' +
            'ask the person when a finding is unclear or looks wrong rather than guess.',
          commit,
          'Write your fix to a file: each finding and what you changed for it, the branch and its last commit, ' +
            `the checks you ran with their output. Add it to the journal of the task: ${cli(`journal add --task ${task} --kind fix --author implementer:${agent} --body-file <file>`)}. ` +
            'The fix moves the task back to review.',
          `Tell the person the task waits for review again on the branch \`${branch}\`: in the ConPort Epics panel of Orca they press refresh and find it under the tasks to review.`
        ]
      : mode === 'do'
      ? [
          read,
          `Take it: ${api(`tasks update --task_id ${task} --status IN_PROGRESS`)}.`,
          `Work on a branch of its own, in a worktree of its own beside the repository, never in the working copy of this terminal: ` +
            `${git(['worktree', 'add', folder, '-b', branch])}. If that branch or folder is there already, ask the person how to go on.`,
          `Do the work in ${folder}, test first, and run the checks the repository names there; ` +
            'ask the person when the task is unclear rather than guess.',
          commit,
          `Write your report to a file: the branch \`${branch}\` and its last commit, what you did, the checks you ran with their output, ` +
            `the files changed, what is left open. Add it to the journal of the task: ${cli(`journal add --task ${task} --kind report --author implementer:${agent} --body-file <file>`)}. ` +
            'The report moves the task to review.',
          `Tell the person the task waits for review on the branch \`${branch}\`: in the ConPort Epics panel of Orca they press refresh and find it under the tasks to review.`
        ]
      : [
          `${read} Read the brief, the report and the fixes in it.`,
          `Check the work on the branch the report names (\`${branch}\` unless it names another) against the brief: ` +
            `find its worktree with ${git(['worktree', 'list'])}, read its commits and changes, and run the checks the repository names there. ` +
            'You are the reviewer, not the author of the report: judge the work as it is.',
          'Write your review to a file: each finding with where it is and what to do, or why the work is accepted. ' +
            `Add it to the journal of the task: ${cli(`journal add --task ${task} --kind review --verdict <verdict> --author reviewer:${agent} --body-file <file>`)}, ` +
            '`<verdict>` being `approve` when the work is done, or `changes_requested` when a finding must be fixed.',
          'Tell the person the verdict.',
          'On `approve`, ask the person whether to close the task; only with their yes, close it: ' +
            `${api(`tasks update --task_id ${task} --status DONE --resolution <resolution>`)}, ` +
            '`<resolution>` being one quoted paragraph: the verdict, the branch and its last commit. ' +
            'ConPort adds it to the description of the task as its `## Resolution` section; the description itself stays as it is. ' +
            'Tell the person the branch waits for them to merge it.',
          'On `changes_requested`, tell the person the task waits for its fixes: in the ConPort Epics panel of Orca they press refresh ' +
            'and hand it to an agent to fix.'
        ]
  const lead: Record<HandMode, string> = {
    do: `Do task ${task} of the ConPort project ${project}, as the conport skill describes taking a task: set it IN_PROGRESS, do it, report to its journal.`,
    review: `Review task ${task} of the ConPort project ${project}: read its journal, check the work, write your verdict to its journal.`,
    fix: `Fix task ${task} of the ConPort project ${project} after its review asked for changes: read the latest review, fix it on the branch of the task, write your fix to its journal.`
  }
  return [
    lead[mode],
    '',
    ...rules,
    '',
    ...steps.map((step, i) => `${i + 1}. ${step}`)
  ].join('\n')
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function asRefusal(value: unknown): Refusal | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as { ok?: unknown; error?: unknown }
  if (body.ok !== false || typeof body.error !== 'object' || body.error === null) return undefined
  const error = body.error as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { code: text(error.code) || 'refused', message: text(error.message), action: text(error.action) }
}

/** `<code>: <what> — <one action>`, the line a refusing command prints to its error stream. */
function refusalLine(stderr: string, exit: number | null): Refusal {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  const match = /^([\w.-]+):\s*(.+?)\s+—\s+(.+)$/.exec(last)
  if (match) return { code: match[1] ?? '', message: match[2] ?? '', action: match[3] ?? '' }
  return { code: 'cli_failed', message: last || `код выхода ${exit}`, action: '' }
}

/**
 * Reads what a `--json` command answered: its JSON on success, its refusal otherwise —
 * `{"ok": false, "error": {code, message, action}}` on standard output, or else the one line
 * of the error stream.
 */
export function interpret(program: string, result: ProcessResult, executable = program): Result<unknown> {
  if (result.failure !== undefined) {
    return {
      ok: false,
      error: {
        code: 'spawn_failed',
        message: `${executable}: ${result.failure}`,
        action:
          `${executable === 'npx' || executable === 'node' ? 'установите Node.js и ' : ''}` +
          `сделайте ${executable} видимым в PATH приложения Orca, а не только терминала; затем перезапустите Orca`
      }
    }
  }
  const body = parseJson(result.stdout)
  const refusal = asRefusal(body)
  if (refusal) return { ok: false, error: refusal }
  if (result.code !== 0) return { ok: false, error: refusalLine(result.stderr, result.code) }
  if (body === undefined) {
    return {
      ok: false,
      error: { code: 'bad_output', message: `${program} ответил не JSON`, action: `обновите ${program}` }
    }
  }
  return { ok: true, data: body }
}
