# ConPort Epics for Orca

A right-sidebar panel that runs a ConPort epic through Orca agents. An epic qualifies when it has
a spec and a plan in ConPort; the run itself is the `conport epic run` command of the
[conport CLI](https://www.npmjs.com/package/conport), which this plugin starts, watches and answers.

The panel shows:

1. the epics of the project by milestone; an epic that cannot run yet is greyed out with the reason;
2. the launcher: an agent for each role (implementer, reviewer, gap hunter, final reviewer), from
   the agents the CLI finds on the PATH of Orca's app and those Orca runs in the focused workspace
   (an agent found by neither counts as found while it runs there: start it and press refresh);
   **Run** opens a terminal in the repository root with `npx -y conport@<version> epic run <N> --project <handle> --host orca …`;
3. the board of the run: one row per task with its stage and agent, a jump to the task's worktree
   and to its journal;
4. the stop-list questions with their answers (`conport epic answer`);
5. the outcome, with the reason and the one action when a held run failed, and **Stop** (`conport epic stop`).

The status bar reads `эпик <N>: готово/всего, вопросов K` while a run is watched.

## Install

Before installing, make sure of three things:

- **Orca 1.4.248 or later** with plugins turned on (Settings → Plugins → "Turn on plugins").
- **Node.js 18 or later with `npx`, and the `orca` CLI, on the PATH Orca's app sees.** The
  plugin's worker starts both as child processes; it ships no CLI of its own and fetches the
  `conport` CLI through `npx` on first use.
- **A ConPort API key** in `~/.config/conport/.env` (or `$XDG_CONFIG_HOME/conport/.env`):

  ```sh
  CONPORT_API_KEY=cport_live_...
  ```

  The CLI reads this file itself, so the key never passes through the plugin or Orca.

Then, in Orca:

1. Open Settings → Plugins, choose **From a Git URL…** in the add menu and enter the repository
   `https://github.com/shaurgon/conport-orca` (or `shaurgon/conport-orca`). Orca installs its
   latest version tag.
2. Review what the plugin asks for (see [What the plugin may do](#what-the-plugin-may-do)) and
   choose **Install & enable**.
3. Open the **ConPort Epics** panel in the right sidebar and pick the ConPort project if the
   repository does not name one (see [Project and API key](#project-and-api-key)).

**Updating.** In Settings → Plugins, **Check for update** and **Update** on the installed plugin,
or turn on **Update plugins automatically**. An update asks for approval again only when it asks
for more access than the version you approved.

## Project and API key

The ConPort project comes from `CONPORT_PROJECT_NAME` in `.claude/settings.local.json` of the
repository's main working tree; without it the panel asks once and remembers the answer for that
repository. The plugin never touches the API key: the CLI reads it from its own configuration, and
when it refuses for a missing key the panel shows that refusal as is.

## What the plugin may do

Orca asks you to approve: reading your workspaces and agents, creating terminals and typing into
them, notifications, and its own storage. Besides that, its worker runs the `conport` CLI (through
`npx`) and the `orca` CLI as child processes with your account; through `orca terminal switch` and
`orca terminal create --focus` it brings a task's worktree or the run's terminal to the front,
which the approved rights alone would not allow.

## Permissions of the agents

The run does not choose how agents ask for permission: that comes from Orca's and the agents' own
settings. An agent that asks before every command will stop the run until someone answers it.

## Develop

`src/worker.ts` runs `conport` and `orca` as child processes; `src/panel.tsx` draws the panel and
asks the worker through `plugin.request`; `src/protocol.ts` types both sides.

```sh
orca plugin validate . --json
orca plugin test . --json     # worker and panel tests against a fake CLI (test/fake-cli.mjs)
orca plugin check . --json    # renders each scenario of src/panel.check.ts
orca plugin shot . --scenario running --json   # needs Orca's window hidden or minimized
```

Type checking: Orca does not ship the plugin typings yet (`orca plugin types .` fails), so the code
is only transpiled by `test` and `check`. Once `orca plugin types .` writes `.orca/types/`, run
`npx tsc -p .` and keep it clean.
