// What the plugin no longer has: the requests of a dispatcher run and the commands of the CLI
// behind them. Read from the files themselves, so a name that comes back anywhere is caught.
// The assert of orca/testing is Node's, but its typings leave doesNotMatch out.
import { doesNotMatch } from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The requests of a run and the commands of the dispatcher, as a source would spell them. */
const GONE = ['run.get', 'run.start', 'run.stop', 'epic run', 'epic status', 'epic answer', 'epic stop', 'worker-start']

/** The sources of the plugin, its test doubles and its README; the tests themselves are not sources. */
function sources(): string[] {
  const of = (dir: string, pattern: RegExp): string[] =>
    readdirSync(join(PLUGIN, dir))
      .filter((name) => pattern.test(name) && !/\.test\./.test(name))
      .map((name) => join(dir, name))
  return [...of('src', /\.tsx?$/), ...of('test', /\.ts$/), 'README.md']
}

test('no source of the plugin names a run request or a dispatcher command', () => {
  const files = sources()
  // The guard reads what it is meant to: the worker, the panel, the test doubles and the README.
  for (const file of ['src/worker.ts', 'src/cli.ts', 'src/protocol.ts', 'src/panel.tsx', 'test/fixtures.ts', 'test/fake.ts', 'README.md']) {
    assert.ok(files.includes(file), `${file} is not read`)
  }
  assert.deepEqual(files.filter((file) => /\.test\./.test(file)), [])
  const named = files.flatMap((file) => {
    const text = readFileSync(join(PLUGIN, file), 'utf8')
    return GONE.filter((name) => text.includes(name)).map((name) => `${file}: ${name}`)
  })
  assert.deepEqual(named, [])
})

test('nothing of the tabs Prepare and Tasks is left: no request, no command, no text', () => {
  const PREPARE = [
    'epics.list',
    'tasks.list',
    'epic.prepare',
    'missingDocument',
    'preparePromptArgs',
    'PREPARE_',
    'epic_ready',
    'epic_not_preparable',
    'prompt prepare',
    'Write plan',
    'Ready to run'
  ]
  const named = sources().flatMap((file) => {
    const text = readFileSync(join(PLUGIN, file), 'utf8')
    return PREPARE.filter((name) => text.includes(name)).map((name) => `${file}: ${name}`)
  })
  assert.deepEqual(named, [])
})

test('the manifest names the panel ConPort SDD and describes it by SDD stage', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'orca-plugin.json'), 'utf8')) as {
    id: string
    name: string
    description: string
    contributes: { panels: Array<{ id: string; title: string }> }
  }
  // The id and the panel id stay: Orca updates the plugin by them.
  assert.equal(manifest.id, 'conport-orca')
  assert.equal(manifest.name, 'ConPort SDD')
  assert.deepEqual(manifest.contributes.panels.map(({ id, title }) => ({ id, title })), [{ id: 'epics', title: 'ConPort SDD' }])
  assert.equal(
    manifest.description,
    'Controls ConPort projects from Orca by SDD stage: epics in work with their spec and plan, specs waiting for a plan, ' +
      'ideas and team proposals not worked through, and epics outside SDD; brainstorms an idea, plans and builds a spec, ' +
      'and starts the lead session of an epic in a terminal of the chosen harness.'
  )
  doesNotMatch(manifest.description, /prepare|start, continuation and stop|an agent per role/)
})
