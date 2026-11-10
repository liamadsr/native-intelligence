# Workers: Claude Code and Codex on the local agent's rails

L4 in `docs/plans/teammate-agent.md`. A job can run the person's own Claude
Code or Codex CLI as its worker instead of Native Intelligence's eve agent. The rails stay
the same: the session, the ledger, the bridge and the grant. The desktop
starts an adapter here instead of the launcher; the adapter speaks the
launcher's JSON lines and keeps every command, read and write inside the
folder's fence.

| File | What it is |
| --- | --- |
| `claude-code.ts`, `codex.ts` | The entry points the desktop runs, one per CLI (bundled to `.mjs` by `build.sh`). |
| `lib/run.ts` | One job end to end: the job lock, the launch checks, the fence, the MCP server, the CLI's profile, the probe, `ready`, stdin, teardown. |
| `lib/driver.ts` | The session: start / resume / send / stop, turns, statuses, the cursor, the CLI's processes. |
| `lib/claude-code.ts`, `lib/codex.ts` | Each CLI's adapter: the probe, the arguments, what goes on stdin, and its streaming JSON mapped to NormalizedEvents. |
| `lib/fence-tools.ts` | The only tools a CLI gets: `bash`, `read_file`, `write_file`, `edit_file` through `../lib/host-folder-sandbox.ts`, plus `report`, `ask_manager`, `finish`. |
| `lib/mcp-http.ts` | Those tools as an MCP server on 127.0.0.1 (Streamable HTTP, a per-launch bearer). |
| `lib/cli-profile.ts` | The Seatbelt profile the CLI process itself runs under. |
| `lib/env.ts`, `lib/protocol.ts`, `lib/process.ts`, `lib/instructions.ts`, `lib/adapter.ts` | The launch environment, the JSON lines (restated from the launcher), process plumbing, the job text, the adapter contract. |

## Two fences

```
 desktop (Rust) ──JSON lines──▶ adapter (node, this folder)
                                 ├─ MCP server on 127.0.0.1:<port>, bearer per launch
                                 │    └─ fence tools ─▶ sandbox-exec <folder profile> bash -c …
                                 │                       (seatbelt.ts: no network, HOME unreadable,
                                 │                        writes only in an edit job's worktree)
                                 └─ sandbox-exec <CLI profile> claude|codex …
                                      ├─ HTTPS (:443) to its vendor, on the person's own login
                                      └─ HTTP to the MCP port only
```

- **The folder's fence** holds what the agent does. The CLI has no built-in
  tool left (Claude Code `--tools ''`; Codex `features.shell_tool=false`,
  `unified_exec=false` and the rest of `CODEX_FEATURES_OFF`), so the fence
  tools are the only way to touch the folder. They run through the same
  host-folder sandbox as eve's `bash`, `read_file` and `write_file`, so the
  kernel enforces the same grant.
- **The CLI's profile** (`cli-profile.ts`) holds the CLI process, which must
  reach its vendor and read its own login, so it cannot sit in the folder's
  fence:
  - network: TCP to port 443, the one MCP port, DNS, and unix sockets in its
    own temp folder;
  - reads: system paths, its own state (`~/.claude`, `~/.claude.json`,
    `~/.codex`), its install, the tool PATH's dirs, its temp folder and its
    working folder. Nothing else under HOME, `/Volumes`,
    `/private/var/folders` or `/private/tmp`. **Not the granted folder:** it
    is denied last, whatever else allows it;
  - writes: its state and its temp folder only. Never the folder, and never
    the parts of its state that hold code or text a later session of the
    person's own (unfenced) runs or loads:
    - Claude Code's `settings*.json`, `CLAUDE.md`, `keybindings.json`,
      `plugins/`, `hooks/`, `agents/`, `commands/`, `skills/`,
      `output-styles/`, `rules/`, `local/` (its npm install), `bin/`,
      `scheduled-tasks/`, every project's auto memory
      (`projects/*/memory/`), and every path under `~/.claude` that a setting
      names, however the home is spelled (a status line or hook script, read
      from the settings at launch). A named path is protected as a folder too,
      unless it sits in a folder the CLI writes as it runs
      (`CLAUDE_RUNTIME_DIRS`: `projects/`, `sessions/`, caches…), where only
      that path is;
    - Codex's `*.toml`, `config.json`, `AGENTS*.md`, `instructions.md`,
      `hooks.json`, `.env` (loaded into its environment at every start),
      `memories*`, `rules/`, `skills/`, `prompts/`, `bin/`, `plugins/`,
      `automations/`;
    - no script (`*.sh`, `*.py`, `*.js` and the like) anywhere under
      `~/.claude` or `~/.codex`, for a setting that names one later.

    Atomic-rename siblings are included. An install that sits in its state
    folder (`~/.claude/local`) can run but never be written;
  - no rename can swap one in. Seatbelt judges a rename by its two paths and
    never by what the moved folder holds, so every folder above a protected
    or settings-named path is pinned (the state folder itself included: no
    creating, renaming, removing or `chmod`; writing inside still works), and
    under `~/.claude/projects` only this job's own project folder (named as
    Claude Code names it, from the working folder; pinned too) is writable.
    Without that, `mv cache/x projects/<slug>` would plant another project's
    auto memory, and `mv ~/.claude <tmp>` would take every rule with it. The
    adapter makes the pinned state folders, `projects` and the job's own
    project folder (0700) before the CLI starts, so a first run on a Mac
    still works. A working folder whose project name Claude Code would cut
    (over 200 characters) is refused;
  - no launchd jobs (`job-creation`), `open`, `osascript`, Apple events,
    pasteboard, window server, microphone or camera. The keychain stays
    reachable, because Claude Code keeps its login there;
  - no exec of a file in its writable folders, nor of a state file's atomic
    siblings (`~/.claude.json.*`). An interpreter can still read
    a script there; this profile is the second fence, not the first.
- **The CLI never starts in the folder.** Its working folder is
  `<job dir>/cli`: empty, read-only to it, and the same on every launch,
  because Claude Code keys its sessions by working folder. Codex also gets
  `project_doc_max_bytes=0`. So the CLI loads no `CLAUDE.md`, `AGENTS.md`,
  `.claude/` or `.codex/` of anyone's making.

  This matters because Seatbelt judges a symlink by its target. A
  `CLAUDE.md -> ~/.claude.json` planted in the folder would resolve into
  the CLI's own readable state (`cli-profile.test.ts` shows it), and so
  would an `@import` in a real `CLAUDE.md`. The model can still read the
  folder's own `CLAUDE.md` / `AGENTS.md` through `read_file`, under the
  folder's fence, which refuses that symlink.
- **Messages can't steer the CLI's prompt parser.** Claude Code acts on more
  than words: an `@path` mention attaches a file, and a leading `/`, `!`, `#`
  or `&` is a command. The adapter puts a U+2060 word joiner in front of
  each before the message goes in (`neutralizeClaudeText`). An `@` inside a
  word, such as an email address, is left alone.
- **Why the MCP server is HTTP and in the adapter:** macOS refuses a
  `sandbox-exec` inside a sandboxed process (`sandbox_apply: Operation not
  permitted`, measured on Darwin 27), so a stdio server, which would be the
  CLI's child, could not apply the folder's fence. Fenced commands cannot
  reach the server, because their profile has no network.
- **Nothing of the person's own setup runs.** Claude Code gets
  `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`,
  `--restricted` (when the version has it) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`:
  none of their hooks, plugins, settings env, MCP servers, skills or memory.
  Codex gets `--ignore-user-config` and `--ignore-rules`: none of their MCP
  servers, profiles, `notify` programs, project trust or exec rules. The
  folder's own `.claude/settings.json` or `.codex/config.toml`, which an edit
  job could write, is never loaded either.
- **Checked at runtime:** Claude Code's `system/init` must list exactly the
  seven fence tools (no more, no fewer) with the fence server `connected`, or
  the job fails before the model acts. A line from a subagent
  (`parent_tool_use_id` set) is fatal: with no Task tool there can be none. Any work before an init that passed is fatal too, so a version
  that drops the line can't skip the check. Codex's probe runs `features list` with the overrides and
  refuses a version that doesn't show the shell off. A `command_execution`,
  an applied `file_change`, a `web_search` or a call to another MCP server in
  either CLI's output kills the job at once. So does a block for a tool the
  API runs itself in Claude Code's answer (`server_tool_use`,
  `mcp_tool_use`, any `*_tool_result`), and any Codex item type the adapter
  doesn't know (only `agent_message`, `reasoning`, `todo_list`, `error` and
  the fence's own `mcp_tool_call` pass).

## The desktop's side (F-desk)

**What to run.** Instead of `<node> <bundle>/launcher/launcher.mjs`:
- packaged: `<node 24> <bundle>/workers/<worker>.mjs`, where `<worker>` is `claude-code` or `codex`;
- dev: `<node 24> <agentDir>/.output/workers/<worker>.mjs`, after
  `agents/local-agent/workers/build.sh agents/local-agent/.output` (run it
  after eve's build, which replaces `.output`). The `.ts` entries cannot run
  unbundled, because they import the sandbox through relative `.js` paths.

The cwd is the job dir, and the same process group and stop and exit
handling apply as for the launcher.

**Environment.** The launcher's fence environment, built from scratch (`HOME`,
`TMPDIR`, `LANG`, `PATH`, `LOCAL_AGENT_JOB_ID`, `_FOLDER`, `_MODE`,
`_TOOL_PATH`, `_DIR`, and `_EXTRA_READ` in edit mode), plus:
- `LOCAL_AGENT_WORKER`: `claude-code` | `codex`. It must match the entry file, or the job is fatal.
- `LOCAL_AGENT_WORKER_BIN`: the absolute path of the person's CLI, from the
  desktop's PATH lookup. It is run exactly as given (after realpath); PATH is
  never searched and nothing is installed.

No relay URL, session token or dev key is passed, and any of them in the
environment (`NI_CREDENTIALS` in `lib/env.ts`) makes the job fatal: a
worker runs on the person's own login. If `LOCAL_AGENT_LOCAL_MODEL_*` is set,
the job is fatal too: a worker sends the folder to its vendor, which a
local-model setting rules out.

**Lines in (stdin):** `start`, `resume`, `send` and `stop`, as for the launcher.
- `token` lines are read and dropped, and never passed on.
- `prompt_answer` lines are dropped too: workers ask no C3 prompts.
- A line over 256 KB (`MAX_LINE_BYTES`, as `protocol.rs`) is skipped whole,
  with an `error` event. The CLI's own stdout lines are capped at 64 MB.
- Input is read from the first byte, before the probe: a `stop`, stdin EOF or
  SIGTERM while the CLI is being checked ends the job (and removes the CLI's
  temp folder) without a `ready`, and no further probe step starts; anything
  else waits for `ready`.
- **Session ids are canonical lowercase UUIDs only**, in `resume` and in what
  a CLI reports (`SESSION_ID` in `lib/protocol.ts`). A `resume` with any other
  id is fatal, and so is a CLI that reports one: the id goes on the CLI's
  command line, so `-x`, `--settings=…` or `--last` must never get there.
  Claude Code gets it as one argv element (`--session-id=<uuid>`,
  `--resume=<uuid>`).

**Lines out (stdout):**

```
{"type":"ready","port":0,"worker":"claude-code","workerVersion":"2.1.292"}   after the probe; no eveVersion
{"type":"session","sessionId":"<id>","streamIndex":<n>}                     Claude Code: a UUID chosen at start (--session-id);
                                                                            Codex: the thread id, when its first turn reports it
{"type":"cursor","streamIndex":<n>}                                         finished turns; written right before each boundary's status
{"type":"event","event":<NormalizedEvent>}                                  the launcher's kinds; report / ask / finish from the manager tools
{"type":"fatal","message":"<a sentence for the person>"}                    then exit 1
```

- **`resume`** writes `session` at once, then `waiting`. A worker turn does
  not outlive its process (unlike eve's durable workflow), so a turn in flight
  when the app quit is lost. The next message starts the CLI again on the same
  session: `claude --resume=<uuid>` (cwd-scoped, so the folder must be the
  same) or `codex exec resume <uuid>`.
- **`stop`** kills the CLI (SIGTERM, then SIGKILL at 0.8 s), writes
  `cancelled`, kills what the fence left, and exits 0.
- **stdin EOF or SIGTERM** shuts down the same way, faster.
- **The job lock is the launcher's** (`<cwd>/.launcher.lock`, `O_EXLOCK`), so
  a launcher and a worker can't run one job twice.

**Failures that end the job before `ready`:** the CLI is missing or too old
(each message names the flag and the update command), not signed in, or
unable to start under its profile; a bad launch environment; a local-model
setting. After `ready`, a first turn that dies before the session exists is
also fatal. A later failure is an `error` event, and the job goes back to
`waiting`.

## Claude Code

- **Needs:** a `claude` that lists `--tools`, `--setting-sources`, `--strict-mcp-config`,
  `--session-id`, `--replay-user-messages` and the other `CLAUDE_REQUIRED_FLAGS` in `--help`.
  2.1.292 does. It must be signed in with the person's own account: `claude`
  in Terminal, then `/login`. The login stays theirs, in their keychain, and
  Native Intelligence never reads it. The probe runs `claude auth status --json` (only when
  `--help` lists `auth`) and says "not signed in" before anything starts.
- **One process per session.** Every message is a stream-json `user` line.
- **Turn boundary:** the `result` line. Its `queued_turn_count` says whether
  another queued turn follows, which keeps the job `running`. Without that
  field, the `--replay-user-messages` echoes (`isReplay`) show a message not
  taken up yet.
- **Env:** `CLAUDE_CODE_TMPDIR` points at the CLI's own temp folder (a short
  `/private/tmp/dial8-cli-*`, 0700, removed at exit). It needs a short path
  because Claude Code keeps unix sockets there and refuses long paths.
  `DISABLE_AUTOUPDATER=1` and `MCP_TOOL_TIMEOUT` (11 min) are also set.
- **The MCP server is named `ni_folder`,** not `workspace`: Claude Code
  reserves that name and drops a server called so (found by running the real
  CLI).
- **Doesn't map:**
  - Steer goes in as a queued message: the CLI takes no input into a running step.
  - A stop kills the process instead of sending a stream-json `interrupt`,
    which can leave the CLI unable to take the next message (Native Intelligence's own
    Claude Code chat hit this until 2026-10). The transcript on disk makes the
    next `--resume` lossless.
  - Subagents, web fetch and search, and skills aren't available.
  - The model is the person's default.

## Codex

- **Needs:**
  - a `codex` whose `exec --help` lists `--json`, `--skip-git-repo-check`,
    `--sandbox`, `--ignore-user-config` and `--cd`;
  - a `features list` that shows `shell_tool`. The 0.34.0 on this Mac is too
    old, and the probe says so with the update command;
  - signed in with the person's own login (`codex login`), checked with
    `codex login status`. When the top-level `--help` lists
    `--ignore-user-config`, `features list` and `login status` get it too, so
    the probe never reads the person's config either.
- **One process per turn:** `codex exec --json … -` with the prompt on stdin,
  then `codex exec --json … resume <thread> -`. The first prompt opens with
  the job instructions (`exec` has no system-prompt flag).
- **The fence server** comes in through `-c mcp_servers.ni_folder.*`, with
  `required = true`, an 11 min tool timeout and `default_tools_approval_mode
  = "approve"`. The bearer goes in the environment
  (`bearer_token_env_var`), never the arguments.
- **Doesn't map:**
  - Steer waits for the turn to end, like a queued message. Messages that
    arrive during a turn start the next one together.
  - There are no text deltas: each message arrives whole.
  - Reasoning and plan items aren't shown.
  - The model is Codex's default: the person's config, model included, is ignored.

## Verified, and not

Verified here (`npx vitest run agents/local-agent/workers`, Node 24):
- both normalizers on fixtures. `fixtures/claude-code-2.1.292-signed-out.jsonl`
  was recorded from the real Claude Code 2.1.292, running under the CLI
  profile and connected to the fence server, signed out so no model ran; its
  paths and ids were replaced. The other Claude Code fixtures follow those
  recorded shapes. The Codex fixtures follow OpenAI's documented `exec --json`
  events. The help fixtures are the real `--help` output of Claude Code
  2.1.292 and Codex 0.34.0;
- the probes, the arguments and the driver's turns, queues, resume and stop;
- the fence tools through the real `sandbox-exec`;
- the MCP server's guard, and its batch cap (1 to 32 messages, run one at a time);
- the CLI profile enforced by the kernel:
  - no read of the folder or the rest of HOME;
  - no write to the folder or to the protected state (a settings-named
    script, `~/.claude/local`, a new `*.sh` / `*.py`, `.env` included);
  - no other local port;
  - no exec from its temp folder;
  - no launchd job;
- the whole worker end to end on darwin (`worker.e2e.test.ts`): the bundled
  adapter, the real fence, MCP server and CLI profile, and a stand-in CLI
  (`fixtures/fake-cli.mjs`) for each of the two. The stand-in calls the fence
  tools and probes its own profile: a direct read of HOME and of the folder
  both get EPERM, another local port is refused, and its working folder is
  the job's `cli`. It also covers a stop before `ready`, an overlong
  stdin line and a `resume` whose id isn't a UUID.

By hand (no model call): the real `claude` 2.1.292, signed out, under the
final CLI profile (re-run on 2026-10-22 after the memory, script,
settings-path, pinned-folder and own-project rules):
- `--version`, `--help` and `auth status` work as they do unsandboxed;
- with the adapter's exact flags, protected state and empty working folder,
  it connects to the fence server over HTTP MCP (protocol 2025-11-25) and
  offers exactly the 7 fence tools;
- its working folder is still empty afterwards;
- it writes its transcript in its own project folder (the name the adapter
  computes is the one it uses);
- the kernel's sandbox log for the run shows no refused write: only reads of
  HOME (`~/.gitconfig`, `~/.CFUserTextEncoding`, the home listing),
  `/dev/dtracehelper` and a setuid exec, all denied by design. A signed-in
  model turn writes more (its transcript in `~/.claude/projects/`, which stays
  writable) and is not checked.

Also by hand: on Darwin 27, `launchctl submit` and `bootstrap` from inside
any `sandbox-exec` profile create no job, even `(allow default)`; outside a
sandbox they do. The profile denies `job-creation` anyway.

Not verified:
- a real model turn in either CLI (needs the person's signed-in CLI and their usage);
- a current Codex at all: the flags and config keys are from its docs, and the
  `-c` keys (`web_search`, `tools.view_image`, `default_tools_approval_mode`,
  `bearer_token_env_var`) need a real run;
- Claude Code's queue behaviour with a real model;
- that HTTPS, the keychain and token refresh work for both CLIs under the profile.

## Known risks

- **Protected state is a deny-list.** It names what a later session runs or
  loads; a new place a CLI version starts loading from stays writable until
  it is listed. A path named relative to `~/.claude` after a `cd` in a hook
  (`cd ~/.claude && ./statusline`) isn't found, though a script by its
  extension still is (and a new script is harmless until something names it).
  The sturdier design is an allow-list of what the CLI writes, which needs a
  signed-in run of each CLI to draw.
- **Codex's other threads.** Codex keeps every thread's transcript under
  `~/.codex/sessions` by date, not by folder, so the others stay writable
  (Claude Code's other projects don't: only its own project folder is).

- **Event size.** Messages and manager notes are cut by UTF-8 bytes (16 KB),
  and `report` / `ask` / `finish` to their tools' own limits. The desktop
  drops any event over 64 KB, and a dropped `finish` would lose an edit job's
  commit.
- **Codex's features are a deny-list.** It turns off the features it knows to
  be risky, and a new one stays on until it is listed: review the list on a
  Codex upgrade. Item types are default-deny: one this adapter doesn't know
  kills the job. Checked against `codex-rs/exec/src/exec_events.rs` on
  2026-10-22 (`agent_message`, `reasoning`, `command_execution`,
  `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`,
  `todo_list`, `error`): every harmless one passes, and `collab_tool_call`,
  off with `multi_agent=false`, is the one refused.
- **`~/.claude.json` stays writable**, and it is a way to persist: its
  user-scope `mcpServers` are commands the person's own Claude Code starts,
  unfenced. It can't be protected, because Claude Code rewrites it all the
  time (projects, settings, counters). The model can't write it (no built-in
  tools, every write through the fence's tools); only the CLI process itself
  can, so it takes a CLI that grew a capability the init check and the
  backstop miss. The follow-up: `CLAUDE_CONFIG_DIR` pointed at a job-private
  copy, if the keychain sign-in works from there (not built).
- **Bare paths in a message:** whether Claude Code's print mode attaches an
  image or file named by a bare path (not an `@` mention) is not verified.
- **Network.** The CLI process can open any TCP connection to port 443 (its
  vendor's, but Seatbelt can't filter by host). It runs no tool of its own, so
  this matters only if a CLI grows a capability the init check or the
  backstop misses.
- **Its own state is readable to it,** the person's other sessions in
  `~/.claude/projects` and `~/.codex/sessions` included. That is the CLI
  reading its own files; the model reaches nothing but the fence tools.
- **The worker sends the folder's contents to Anthropic or OpenAI** on the
  person's account, which is the point. The desktop refuses workers while the
  Mac is set to a local model, and the adapter refuses them too.
- **Terms:** Anthropic allows a person's unmodified Claude Code, signed in
  with their own plan, inside another product (docs/plans/local-agents.md,
  appendix). For Codex on a ChatGPT login, OpenAI's sanctioned third-party
  route is Sign in with ChatGPT; check before shipping.

## Build

```bash
agents/local-agent/workers/build.sh <out-dir>    # <out-dir>/workers/{claude-code,codex}.mjs, ~90 KB each
```

`scripts/local-agent/bundle.sh` (WS-B) should call it with its `<out-dir>`.
