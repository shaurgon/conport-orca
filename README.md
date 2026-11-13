# ConPort Epics for Orca

A right-sidebar panel to control a ConPort project from Orca: what is ready to start, what needs
preparing, and the tasks outside the epics. The panel shows what ConPort knows and acts on the
project; the state of the agents and their questions stay in Orca, where they already are. An
epic is done by a harness — Claude Code, Codex or Cursor — that the plugin opens in a terminal of
Orca with the task of the epic; what the panel reads of ConPort it reads through the
[conport CLI](https://www.npmjs.com/package/conport).

The panel shows:

1. at the top, the chosen project and **Refresh**. The project opens a list of Orca's projects in
   the order of its sidebar, under its names, with a search: each with its ConPort project, a
   repository without one with **Bind**, a plain folder without git greyed out. The project in
   focus is chosen first, otherwise the one chosen last, otherwise the first bound one;
2. three tabs with their counts:
   - **Ready to run**: the epics with a spec and a plan, by milestone in the order of the roadmap, the
     epics outside a milestone last. A release milestone tells how many of its epics are open, or
     that it is ready to close. Each epic tells where it stands by its tasks in ConPort — not
     started, or in progress with the share of tasks closed — or ready to merge, once the lead
     session of the epic has written to ConPort that it is;
   - **Prepare**: the epics without a spec, or with a spec and no plan. **Prepare** (or
     **Write plan**) opens a sheet with what the agent will do and a choice of the agent found
     on this machine that takes its first request as an argument — Claude Code, Codex or Cursor,
     the one of last time first. **Open in terminal** starts it in the root of the project with
     one argument, its task: it talks with you in your language, goes through the open tasks of
     the epic (those the plan keeps get a `<!-- conport-task: <id> -->` line in their section,
     the others are closed with your consent), writes the spec with you and uploads it
     (`documents upload --doc-type spec`), then the plan, imported with
     `plan import <plan> --spec doc-<number> --epic <N>`. It stores nothing before you approve it.
     Once the plan is in, refresh — or come back to the panel, which reads the project again
     whenever it comes into view — and the epic is ready to start;
   - **Tasks**: the open tasks outside the epics — in review, in progress, and to do by
     priority. **Hand to agent**, **Review** and **Fix** open the same sheet: the agent starts in the
     root of the project with its task as one argument. To do a task, it takes it as the conport
     skill describes — sets it IN_PROGRESS, does it on its own branch `task-<N>` in a worktree
     beside the repository, commits it there and writes its report, naming the branch and the
     commit, to the journal of the task (`journal add --kind report`); you merge the branch. To
     review one, it reads the journal of the task, checks that branch and writes its review with
     a verdict (`journal add --kind review --verdict approve|changes_requested`); on `approve`,
     and only with your yes, it closes the task with a resolution added to its description
     (`api tasks update --status DONE --resolution …`). A task the review sent back
     (`changes_requested`) waits in progress with **Fix**: the agent goes on in the same branch
     and its worktree, fixes what the latest review found, commits and writes its fix to the
     journal (`journal add --kind fix`), which sends the task to review again;
3. the screen of an epic: its milestone, its spec and plan, and where it stands. Its session and
   its tasks are read once when the epic is opened, and again on **Refresh**. On it you choose:
   - **the mode** the epic is done in: **SDD skill** — the harness leads the epic in a working copy of
     its own on the branch `epic-<N>`, up to the branch being ready to merge — or
     **`/conport:epic`**, the workflow of the conport plugin, which works in the root of the
     repository on its main branch, starts with its own checks, merges the tasks into that
     branch and closes the epic itself. The workflow is there for Claude Code only;
   - **the harness**: Claude Code, Codex or Cursor, of those found on this machine. A new epic
     takes the harness of the last start in the project, Claude Code without one;
   - **the roles**: the subagent type of the harness for each of the four — implementer,
     reviewer, gap hunter, final reviewer — the types of the conport plugin at first
     (`conport:sdd-implementer`, `conport:sdd-task-reviewer`, `conport:sdd-gap-hunter`,
     `conport:sdd-final-reviewer`). A fix round goes to the same implementer, otherwise to
     `conport:sdd-fixer`, which is not chosen. Changing the harness puts the roles back to these.
     The lists are off, each with its reason, when the subagents cannot be listed, for Codex and
     Cursor (they have no subagents with types: the roles follow the texts of
     `conport agent <role>`) and for the workflow (its types are fixed in it). A type the
     harness does not list stays chosen with a note to install or update the conport plugin.

   The mode, the harness and the roles are kept for the epic once it is started; a choice not
   started lives until the panel is closed.

   The button follows the session of the epic, which the panel asks Orca for:
   - no working copy of `epic-<N>` yet: **Start**. By the SDD skill it creates the working copy
     from the branch checked out in the main working tree of the repository and opens the
     harness there in a terminal `conport epic <N> · SDD`; by the workflow it opens the harness
     in the root of the repository, in a terminal `conport epic <N> · workflow`. The harness
     gets the task of the epic as its one argument, and the terminal comes to the front. A
     start checks nothing of the plan or of the working tree, takes no lock and writes no file;
   - the working copy is there and no agent works in it: **Start**, with a note that the agent
     goes on from where the work stood. By the workflow, when branches `epic<N>/…` of an earlier
     start are there, the note says the workflow picks them up;
   - the session is live: **Show terminal**, and **Start again**, which asks first — it
     opens one more agent with the same task and leaves the first terminal open.

   Under it, the tasks of the epic as ConPort has them, with their counts: to do, in progress,
   in review, blocked, parked (shown only when there are any) and done. Cancelled tasks are
   not counted and stand last, greyed out.

Questions are asked in the terminal of the harness. The lead session of an epic asks you there,
ends its turn and waits, as long as it takes; Orca shows the waiting agent as it does for any
terminal of an agent. The panel answers nothing for you and stops nobody: to stop the work, close
the terminal of the agent in Orca.

Every command the plugin types or gives an agent carries the project and the pinned CLI release;
the API key is never in one.

## Install

Before installing, make sure of five things:

- **Orca 1.4.251 or later** with plugins turned on (Settings → Plugins → "Turn on plugins").
- **Node.js 18 or later with `npx`, and the `orca` CLI, on the PATH Orca's app sees.** The
  plugin's worker starts both as child processes; it ships no CLI of its own and fetches the
  `conport` CLI through `npx` on first use.
- **The main working tree of the repository on a branch:** the branch of an epic is cut from the
  branch checked out in the main working tree, with the commits you have not pushed.
- **A ConPort API key** in `~/.config/conport/.env` (or `$XDG_CONFIG_HOME/conport/.env`):

  ```sh
  CONPORT_API_KEY=cport_live_...
  ```

  The CLI reads this file itself, so the key never passes through the plugin or Orca.
- **For an epic done by the SDD skill in Claude Code: the superpowers plugin, and the conport
  plugin of version 20 or later, both installed in Claude Code.** The lead session works by the
  skill `superpowers:subagent-driven-development` and by the conport skill, and starts each role
  as a subagent type of the conport plugin. The workflow `/conport:epic` needs the conport plugin
  alone; Codex and Cursor need neither, they work by the role texts of the CLI.

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

The ConPort project comes from `project_name` in `.conport.json` of the repository's main working
tree, or in `.conport.local.json` beside it, which overrides it for you alone (see
[Project settings](https://conport.app/docs/projects/project-settings.md)). Without either, the
panel reads the old place, `CONPORT_PROJECT_NAME` in `.claude/settings.local.json`, then asks once
and remembers the answer for that repository. What the settings files need fixing — a file that is
not valid JSON, a key of the wrong type, an API key in a file, a personal file git does not ignore —
the panel shows with the project, a line each; a broken file, or a git that cannot tell about the
repository, names no project until it is fixed. A submodule or a worktree of a bare repository has
no main working tree: none of its files are read, only the project the panel remembered.
The plugin never touches the API key: the CLI reads it from its own configuration, and
when it refuses for a missing key the panel says so in its own words, by the code of the refusal, with
the one thing to do.

## What the plugin may do

Orca asks you to approve: reading your workspaces and agents, creating terminals and typing into
them, and its own storage. Besides that, its worker runs the `conport` CLI (through `npx`), the
`orca` CLI and `git` as child processes with your account. Through `orca` it creates the working
copy of an epic, opens the terminal of its harness there and brings a terminal it opened to the
front, which the approved rights alone would not allow; of `git` it only asks which branches of
an epic are there. It reads only when the panel asks: no timer, no status bar item, no
notification.

## Permissions of the agents

The panel does not choose how agents ask for permission: that comes from Orca's and the agents' own
settings. By the SDD skill they work in the branch of the epic, and you merge it into the main
branch; the workflow merges its tasks into the main branch itself, and pushing it is yours. An
agent that asks before every command stops the work on the epic until someone answers it in its
terminal.

## Develop

`src/worker.ts` runs `conport` and `orca` as child processes; `src/panel.tsx` draws the panel and
asks the worker through `plugin.request`; `src/protocol.ts` types both sides.

```sh
orca plugin validate . --json
orca plugin test . --json     # worker and panel tests against a fake CLI (test/fake-cli.mjs)
orca plugin check . --json    # renders each scenario of src/panel.check.ts
orca plugin shot . --scenario epic-session-alive --json   # needs Orca's window hidden or minimized
```

Type checking: `test` and `check` only transpile the code. `npm ci` installs TypeScript and the Node typings, and
`npm run typecheck` writes the Orca typings to `.orca/types/` (`orca plugin types .`) and runs
`tsc -p .`; keep it clean.
