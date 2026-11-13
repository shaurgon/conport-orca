// A stand-in for the `conport`, `orca` and `git` executables in the plugin's tests.
// Usage: node fake-cli.mjs <scenario.json> <args...>
// The scenario holds `log` (a file that gets one JSON line of args per call) and
// `answers`: the first answer whose `match` starts the joined args is printed as
// `stdout` and `stderr`, and the process exits with its `code`.
// A `prompt …` call no answer matches is answered as `conport prompt … --json` answers:
// `{"ok": true, "text": …}`, the text made of the args (`promptText` of test/fake.ts).
import { appendFileSync, readFileSync } from 'node:fs'

const [scenarioFile, ...args] = process.argv.slice(2)
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'))
appendFileSync(scenario.log, JSON.stringify(args) + '\n')

const joined = args.join(' ')
const answer = scenario.answers.find((a) => joined.startsWith(a.match))
if (answer === undefined && args[0] === 'prompt') {
  // Quotes, a dollar, a backquote and a line end: the text must reach the agent as one argument.
  const text = `The task of: ${joined}\nIt's "one" argument: $HOME \`x\``
  process.stdout.write(JSON.stringify({ ok: true, text }))
  process.exit(0)
}
if (answer === undefined) {
  process.stderr.write(`fake_unexpected: no answer for "${joined}" — add one to the scenario\n`)
  process.exit(1)
}
if (answer.stdout) process.stdout.write(answer.stdout)
if (answer.stderr) process.stderr.write(answer.stderr)
process.exit(answer.code ?? 0)
