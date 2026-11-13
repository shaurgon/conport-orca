// A stand-in for the `conport`, `orca` and `git` executables in the plugin's tests.
// Usage: node fake-cli.mjs <scenario.json> <args...>
// The scenario holds `log` (a file that gets one JSON line of args per call) and
// `answers`: the first answer whose `match` starts the joined args is printed as
// `stdout` and `stderr`, and the process exits with its `code` — after `delayMs` when it has one.
// An answer with `translatedStderr` writes that in place of `stderr` unless it was asked in English
// (LC_ALL=C and no LANGUAGE), as a git with translations does.
// A `prompt …` call no answer matches is answered as `conport prompt … --json` answers:
// `{"ok": true, "text": …}`, the text made of the args (`promptText` of test/fake.ts).
// A `-C <dir> rev-parse --show-toplevel --git-common-dir` call no answer matches is answered as
// git answers in the main working tree of a repository.
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
if (answer === undefined && args[0] === '-C' && args.slice(2, 5).join(' ') === 'rev-parse --show-toplevel --git-common-dir') {
  // Unless the scenario says otherwise, every folder git is asked about is the main working tree
  // of its repository.
  process.stdout.write(`${args[1]}\n.git\n`)
  process.exit(0)
}
if (answer === undefined) {
  process.stderr.write(`fake_unexpected: no answer for "${joined}" — add one to the scenario\n`)
  process.exit(1)
}
const reply = () => {
  if (answer.stdout) process.stdout.write(answer.stdout)
  const english = process.env.LC_ALL === 'C' && !process.env.LANGUAGE
  const stderr = answer.translatedStderr !== undefined && !english ? answer.translatedStderr : answer.stderr
  if (stderr) process.stderr.write(stderr)
  process.exit(answer.code ?? 0)
}
if (answer.delayMs) setTimeout(reply, answer.delayMs)
else reply()
