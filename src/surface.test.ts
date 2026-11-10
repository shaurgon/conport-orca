// What the plugin no longer has: the requests of a dispatcher run and the commands of the CLI
// behind them. Read from the files themselves, so a name that comes back anywhere is caught.
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

test('the manifest describes the start of an epic by a harness', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'orca-plugin.json'), 'utf8')) as { description: string }
  assert.equal(
    manifest.description,
    'Controls ConPort projects from Orca: the epics of a project by milestone, the start of an epic in a terminal of the ' +
      'chosen harness with a subagent type per role, an agent to prepare an epic without a spec or plan, and the tasks ' +
      'outside the epics handed to an agent to do or to review.'
  )
  assert.doesNotMatch(manifest.description, /start, continuation and stop|an agent per role/)
})
