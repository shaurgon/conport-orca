# ConPort Epics for Orca

A right-sidebar panel to control a ConPort project from Orca: what is ready to start, what needs
preparing, and the tasks outside the epics. The panel shows what ConPort knows and acts on the
project; the state of the agents and their questions stay in Orca, where they already are. The
epic itself runs through the `conport epic run` command of the
[conport CLI](https://www.npmjs.com/package/conport), which the plugin starts in a terminal of
Orca.

The panel shows:

1. at the top, the chosen project and **Refresh**. The project opens a list of Orca's projects in
   the order of its sidebar, under its names, with a search: each with its ConPort project, a
   repository without one with **Bind**, a plain folder without git greyed out. The project in
   focus is chosen first, else the one chosen last, else the first bound one;
2. three tabs with their counts:
   - **To start**: the epics with a spec and a plan, by milestone in the order of the roadmap, the
     epics outside a milestone last. A release milestone tells how many of its epics are open, or
     that it is ready to close. Each epic tells where it stands by its tasks in ConPort — not
     started, in progress with the share of tasks closed, or ready to merge;
   - **To prepare**: the epics without a spec, or with a spec and no plan. **Prepare** (or
     **Write the plan**) opens a sheet with what the agent will do and a choice of the agent found
     on this machine that takes its first request as an argument — Claude Code, Codex or Cursor,
     the one of last time first. **Open in a terminal** starts it in the root of the project with
     one argument, its task: it talks with you in your language, goes through the open tasks of
     the epic (those the plan keeps get a `<!-- conport-task: <id> -->` line in their section,
     the others are closed with your consent), writes the spec with you and uploads it
     (`documents upload --doc-type spec`), then the plan, imported with
     `plan import <plan> --spec doc-<number> --epic <N>`. It stores nothing before you approve it.
     Once the plan is in, refresh — or come back to the panel, which reads the project again
     whenever it comes into view — and the epic is ready to start;
   - **Tasks**: the open tasks outside the epics — waiting for review, in progress, and to do by
     priority. **Hand to an agent** and **Review** open the same sheet: the agent starts in the
     root of the project with its task as one argument. To do a task, it takes it as the conport
     skill describes — sets it IN_PROGRESS, does it and writes its report to the journal of the
     task (`journal add --kind report`); to review one, it reads the journal of the task, checks
     the work and writes its review with a verdict (`journal add --kind review --verdict
     approve|changes_requested`);
3. the screen of an epic: its milestone, its spec and plan, where it stands, and its run, read
   once when the epic is opened. Not started: the team — an agent for each role (implementer,
   reviewer, gap hunter, final reviewer), remembered for the project — and **Start**, which opens
   a terminal in the root of the project with
   `npx -y conport@<version> epic run <N> --project <handle> --host orca …`. Agents at work: a
   card that sends you to Orca for their state and questions, and **Stop the agents**
   (`conport epic stop`). Stopped or held: why, and **Continue**. Ready to merge: that line.

Every command the plugin types or gives an agent carries the project and the pinned CLI release;
the API key is never in one.

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
when it refuses for a missing key the panel says so in Russian, by the code of the refusal, with
the one thing to do.

## What the plugin may do

Orca asks you to approve: reading your workspaces and agents, creating terminals and typing into
them, and its own storage. Besides that, its worker runs the `conport` CLI (through `npx`) and the
`orca` CLI as child processes with your account; through `orca terminal switch` it brings the
terminal it opened to the front, which the approved rights alone would not allow. It reads only
when the panel asks: no timer, no status bar item, no notification.

## Permissions of the agents

The panel does not choose how agents ask for permission: that comes from Orca's and the agents' own
settings. They work in the branch of the epic; you merge it into the main branch. An agent that
asks before every command waits in Orca until someone answers it.

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
