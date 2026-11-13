// What the plugin keeps of the CLI: the subagent types, the agent kinds, the command line of an
// agent, and the arguments of `conport prompt` the worker runs. The texts themselves are the CLI's.
// The assert of orca/testing is Node's, but its typings leave doesNotMatch out.
import { doesNotMatch } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { HANDLE } from '../test/fixtures'
import * as cli from './cli'
import {
  CLI_VERSION,
  CONPORT,
  DEFAULT_ROLES,
  FIXER_TYPE,
  PREPARE_AGENTS,
  ROLE_TYPE_FORM,
  commandLine,
  epicPromptArgs,
  preparePromptArgs,
  taskPromptArgs
} from './cli'
import type { HandMode, Roles } from './protocol'

const OTHER_ROLES: Roles = {
  implementer: 'sdd-implementer',
  reviewer: 'team:strict-reviewer',
  gapHunter: 'gap.hunter',
  finalReviewer: 'final_reviewer-2'
}

test('the CLI is started by npx at the pinned release', () => {
  assert.deepEqual(CONPORT, ['npx', '-y', `conport@${CLI_VERSION}`])
})

test('the default roles are the types of the conport plugin, and the fixer is never chosen', () => {
  assert.deepEqual(DEFAULT_ROLES, {
    implementer: 'conport:sdd-implementer',
    reviewer: 'conport:sdd-task-reviewer',
    gapHunter: 'conport:sdd-gap-hunter',
    finalReviewer: 'conport:sdd-final-reviewer'
  })
  assert.equal(FIXER_TYPE, 'conport:sdd-fixer')
})

test('a role type is a plain name', () => {
  for (const type of [...Object.values(DEFAULT_ROLES), ...Object.values(OTHER_ROLES), FIXER_TYPE]) {
    assert.match(type, ROLE_TYPE_FORM)
  }
  for (const type of ['', 'two words', "it's", 'a"b', 'a\nb', 'a`b', 'a$b', 'a/b']) {
    doesNotMatch(type, ROLE_TYPE_FORM)
  }
})

test('only the agents that take their task as an argument can be handed one', () => {
  assert.deepEqual(PREPARE_AGENTS, ['claude', 'codex', 'cursor'])
})

test('the texts of the tasks are no longer built by the plugin', () => {
  // The CLI prints them: `conport prompt epic|prepare|task`.
  for (const name of ['epicTask', 'epicWorkflowTask', 'prepareTask', 'handTask', 'QUOTES']) {
    assert.equal(name in cli, false, name)
  }
})

test('the epic by the SDD skill in Claude Code: the working copy, the base and the four types', () => {
  const args = epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', worktree: '/work/app-epic-7', base: 'main', roles: OTHER_ROLES })
  assert.deepEqual(args, [
    'prompt', 'epic', '7', '-p', HANDLE, '--way', 'sdd', '--harness', 'claude', '--worktree', '/work/app-epic-7', '--base', 'main',
    '--implementer', 'sdd-implementer', '--reviewer', 'team:strict-reviewer', '--gap-hunter', 'gap.hunter', '--final-reviewer', 'final_reviewer-2',
    '--json'
  ])
})

test('the epic by the SDD skill in another harness names no type: the roles go by the texts of the CLI', () => {
  // Types the SDD way of Claude Code would refuse are never read for another harness.
  const odd = { ...OTHER_ROLES, reviewer: 'my reviewer' }
  for (const harness of ['codex', 'cursor']) {
    const args = epicPromptArgs({ epic: 12, project: HANDLE, harness, worktree: '/x/y/epic-12', base: 'trunk', roles: odd })
    assert.deepEqual(args, [
      'prompt', 'epic', '12', '-p', HANDLE, '--way', 'sdd', '--harness', harness, '--worktree', '/x/y/epic-12', '--base', 'trunk', '--json'
    ])
  }
})

test('the epic by the workflow: the root and its branch, no working copy and no type', () => {
  const args = epicPromptArgs({ epic: 7, project: HANDLE, harness: 'claude', root: '/work/app', base: 'main', way: 'workflow' })
  assert.deepEqual(args, [
    'prompt', 'epic', '7', '-p', HANDLE, '--way', 'workflow', '--harness', 'claude', '--root', '/work/app', '--base', 'main', '--json'
  ])
})

test('the preparation of an epic is asked for the panel of Orca', () => {
  assert.deepEqual(preparePromptArgs({ epic: 10, project: HANDLE }), ['prompt', 'prepare', '10', '-p', HANDLE, '--host', 'orca', '--json'])
})

test('a task outside the epics is asked for the panel of Orca, in its mode, for its agent and root', () => {
  for (const mode of ['do', 'review', 'fix'] as HandMode[]) {
    assert.deepEqual(taskPromptArgs({ task: 41, project: HANDLE, mode, agent: 'codex', root: '/work/app' }), [
      'prompt', 'task', '41', '-p', HANDLE, '--host', 'orca', '--mode', mode, '--agent', 'codex', '--root', '/work/app', '--json'
    ])
  }
})

test('a value the shell would read is one argument of the command: the CLI is run without a shell', () => {
  // A project, a path and a base as a person may name them reach the CLI word for word.
  const project = `it's "q" $HOME \`x\``
  const root = "/work/my app's"
  const base = "it's-$(x)-`y`;z"
  const epic = epicPromptArgs({ epic: 7, project, harness: 'claude', root, base, way: 'workflow' })
  assert.equal(epic[epic.indexOf('-p') + 1], project)
  assert.equal(epic[epic.indexOf('--root') + 1], root)
  assert.equal(epic[epic.indexOf('--base') + 1], base)
  const task = taskPromptArgs({ task: 41, project, mode: 'do', agent: 'claude', root })
  assert.equal(task[task.indexOf('--root') + 1], root)
})

test('the task of an agent survives the shell as one argument', () => {
  const task = `Execute epic 7 of the ConPort project it's "q" $HOME \`x\`.\n\nSteps\n1. Pull the plan: \`npx -y conport@${CLI_VERSION} plan pull 7\`.`
  const line = commandLine(['/bin/sh', '-c', 'printf %s "$1"', 'sh', task])
  assert.equal(execFileSync('/bin/sh', ['-c', line], { encoding: 'utf8' }), task)
})
