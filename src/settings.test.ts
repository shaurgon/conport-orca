// The plugin's copy of the ConPort project settings rules against the cases every reader of
// `.conport.json` passes: the `resolve` group of the conport plugin's shared fixture, read by its
// path from the root of the repository. The `locations` group is not the copy's: its root is
// the main working tree Orca names, never found from a folder.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { jsonErrorPosition, resolveSettings, type SettingsInput, type SettingsResult } from './settings'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'conport-plugin', 'scripts', 'test', 'fixtures', 'project-config-cases.json'
)

interface ResolveCase {
  name: string
  input: SettingsInput
  expect: SettingsResult
}

test('every resolve case of the shared fixture', () => {
  const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { resolve: ResolveCase[] }).resolve
  assert.ok(cases.length > 0)
  for (const c of cases) {
    assert.deepEqual(resolveSettings(c.input), c.expect, c.name)
  }
})

test('the JSON error position is the first character no valid JSON text starts with', () => {
  assert.equal(jsonErrorPosition('{"a": 1}'), null)
  assert.deepEqual(jsonErrorPosition('{"a":}'), { line: 1, column: 6 })
  assert.deepEqual(jsonErrorPosition('{\n"a": 1,\n}'), { line: 3, column: 1 })
  assert.deepEqual(jsonErrorPosition('{"a": [1, 2'), { line: 1, column: 12 })
  assert.deepEqual(jsonErrorPosition('01'), { line: 1, column: 2 })
  assert.deepEqual(jsonErrorPosition('{"a": tru}'), { line: 1, column: 10 })
  assert.deepEqual(jsonErrorPosition('"\\x"'), { line: 1, column: 3 })
  assert.deepEqual(jsonErrorPosition('{} x'), { line: 1, column: 4 })
  assert.deepEqual(jsonErrorPosition('"a\tb"'), { line: 1, column: 3 })
  // A character outside the basic plane counts as two UTF-16 code units.
  assert.deepEqual(jsonErrorPosition('{\n"\u{1F600}": ,}'), { line: 2, column: 7 })
  // A byte order mark is dropped first and does not count.
  assert.deepEqual(jsonErrorPosition('﻿{"a":}'), { line: 1, column: 6 })
  // Deep nesting overflows no stack.
  assert.deepEqual(jsonErrorPosition('['.repeat(200000)), { line: 1, column: 200001 })
})
