// What the plugin no longer has: the requests of a dispatcher run and the commands of the CLI
// behind them. Read from the files themselves, so a name that comes back anywhere is caught.
// The assert of orca/testing is Node's, but its typings leave doesNotMatch out.
import { doesNotMatch } from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
    'Controls a ConPort project from Orca by SDD stage: epics in work with their spec and plan, specs waiting for a plan, ' +
      'ideas and team proposals, and epics outside SDD. Brainstorms an idea, plans and builds a spec, ' +
      'and starts the lead session of an epic in Claude Code, Codex or Cursor.'
  )
  // The community catalog cuts a listing's description at 300 characters, mid-word.
  assert.ok(manifest.description.length <= 300, `the description is ${manifest.description.length} characters, over 300`)
  doesNotMatch(manifest.description, /prepare|start, continuation and stop|an agent per role/)
})

test('every Callout of the panel carries its own title: without one Orca shows its default in the system language', () => {
  const source = readFileSync(join(PLUGIN, 'src/panel.tsx'), 'utf8')
  // Each opening tag, read to its closing > outside the braces of its props.
  const tags: string[] = []
  for (let at = source.indexOf('<Callout'); at !== -1; at = source.indexOf('<Callout', at + 1)) {
    let depth = 0
    let end = at
    for (; end < source.length; end++) {
      const char = source[end]
      if (char === '{') depth++
      else if (char === '}') depth--
      else if (char === '>' && depth === 0) break
    }
    tags.push(source.slice(at, end + 1))
  }
  assert.ok(tags.length >= 7, `only ${tags.length} Callouts found in src/panel.tsx`)
  assert.deepEqual(tags.filter((tag) => !/\stitle=/.test(tag)), [])
})

test('the plugin is MIT: the manifest says so and LICENSE, which the mirror carries at its root, holds the text', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'orca-plugin.json'), 'utf8')) as { license: string }
  assert.equal(manifest.license, 'MIT')
  const license = readFileSync(join(PLUGIN, 'LICENSE'), 'utf8')
  assert.ok(license.startsWith('MIT License\n\nCopyright (c) 2026 shaurgon\n'), 'LICENSE does not open with the MIT title and its holder')
  assert.ok(license.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'), 'LICENSE lacks the MIT text')
})

test('the listing images the manifest names are in the plugin, each described', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'orca-plugin.json'), 'utf8')) as {
    icon?: string
    cover?: { path: string; alt: string }
    screenshots?: Array<{ path: string; alt: string }>
  }
  assert.equal(manifest.icon, 'images/icon.png')
  assert.equal(manifest.cover?.path, 'images/cover.png')
  const named = [manifest.icon, manifest.cover.path, ...(manifest.screenshots ?? []).map(({ path }) => path)]
  assert.deepEqual(named.filter((path) => !existsSync(join(PLUGIN, path))), [])
  for (const { path, alt } of [manifest.cover, ...(manifest.screenshots ?? [])]) assert.ok(alt.trim(), `${path} has no alt text`)
})
