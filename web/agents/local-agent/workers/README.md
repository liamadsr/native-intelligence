# Workers: the person's own coding agent on the local agent's rails

L4 in `docs/plans/teammate-agent.md`. A job can run the person's own Claude
Code or Codex as its worker instead of Native Intelligence's eve agent. The
rails stay the same: the session, the ledger, the bridge and the grant. The
desktop starts this adapter instead of the launcher; it speaks the launcher's
JSON lines to the desktop and the Agent Client Protocol (ACP,
https://agentclientprotocol.com) to the agent.

There is no per-agent code. One adapter speaks ACP (JSON-RPC 2.0, one message
per line, over the agent process's stdio) to any agent, and everything that
differs between agents is an entry in `registry.json`.

| File | What it is |
| --- | --- |
| `acp.ts` | The one entry point the desktop runs, for every worker (bundled to `acp.mjs` by `build.sh`). `acp.mjs --mcp-proxy` is the stdio MCP proxy. |
| `registry.json`, `lib/registry.ts` | The agents, as data, and their checks. |
| `install-agents.sh`, `acp-adapters/` | Installs the ACP adapters exactly as `acp-adapters/package-lock.json` locks them into one folder (`LOCAL_AGENT_ACP_DIR`). |
| `lib/run.ts` | One job end to end: the job lock, the launch checks, the grant, the private home, the MCP server, the profile, `initialize`, `ready`, stdin, teardown. |
| `lib/driver.ts` | The session over ACP: start / resume / send / stop, turns, the queue, the held `finish`, the `finish` nudge, updates mapped to events, permission answers. |
| `lib/acp-client.ts` | The JSON-RPC connection (about a hundred lines, no SDK). |
| `lib/agent-profile.ts` | The ONE Seatbelt profile around the agent's whole process tree. |
| `lib/agent-home.ts` | The job's private home and the links to the person's existing login. |
| `lib/manager-tools.ts`, `lib/mcp-http.ts`, `lib/mcp-proxy.ts` | `report`, `ask_manager`, `finish` as an MCP server on 127.0.0.1 (a per-launch bearer), and the stdio proxy to it. |
| `lib/instructions.ts` | What the agent is told about the job. |
| `lib/env.ts`, `lib/protocol.ts`, `lib/process.ts` | The launch environment, the JSON lines (restated from the launcher), process plumbing. |

## The design

```
 desktop (Rust) ──JSON lines──▶ adapter (node, acp.mjs)          cwd: <root>/jobs/<id>
                                 ├─ MCP server on 127.0.0.1:<port>, bearer per launch: report / ask_manager / finish
                                 └─ sandbox-exec <agent profile> node <ACP adapter> ──▶ the person's CLI ──▶ its shell, its edits
                                      cwd: the granted folder (edit job: the worktree)
                                      HOME: <root>/jobs/<id>/home (this job's only)
                                      ├─ HTTPS (:443) to its vendor, on the person's own login
                                      └─ the MCP port (HTTP with the bearer, or `acp.mjs --mcp-proxy` over stdio)
```

- **The agent uses its own tools** (shell, file reads and edits) directly in
  the folder: ACP has no standard way to turn them off. The safety is one
  Seatbelt profile around the agent's whole process tree
  (`agent-profile.ts`); macOS refuses a second `sandbox-exec` inside a
  sandboxed process, so nothing below it is fenced again.
- **The profile**, `(allow default)` and then taken away, as in
  `../lib/seatbelt.ts`:
  - network: outbound TCP to port 443 on any host; ANY port on this Mac, TCP
    and UDP (`(allow network-outbound (remote ip "localhost:*"))`, the
    owner's decision, for local dev servers and databases; the MCP server keeps
    its bearer); the mDNSResponder socket; unix sockets in its own temp folder.
    Listening on local ports, TCP and UDP
    (`(allow network-bind network-inbound (local ip "localhost:*"))`, the
    owner's decision; see the risks for the wildcard address). Nothing else
    remote. The app's own ports (`LOCAL_AGENT_CLOSED_PORTS`) can be neither
    reached nor bound;
  - signals and process details (arguments, environment) of its own processes
    only;
  - **no daemon acting for it:** every Mach lookup is refused but an
    allow-list found by running both agents and the basic tools from deny-all
    (`ALLOWED_MACH_NAMES`: `com.apple.SecurityServer` and
    `com.apple.securityd.xpc` for the keychain, `com.apple.trustd` and
    `com.apple.trustd.agent` for TLS, `com.apple.system.opendirectoryd.libinfo`
    and `.membership` for user names, `com.apple.SystemConfiguration.configd`
    and `.DNSConfiguration`). So Shortcuts, Siri, sharing, accounts, password
    dialogs, cloud sync, FileProvider, LaunchServices, the pasteboard,
    notifications, login items, TCC, the Dock and the window server are all
    out of reach. Preference writes are refused (`user-preference-write`), and
    so are preference reads (cfprefsd is not on the list). No launchd jobs, no
    Apple events, no exec of `open`, `osascript`, `launchctl`, `shortcuts` or
    `automator`. DNS goes through mDNSResponder's socket;
  - writes: its private home, its temp folder (`/private/tmp/dial8-acp-*`,
    short for Claude Code's sockets, removed at exit), the keychain folder,
    each shared login file (that literal file and the scratch names its save
    makes beside it, only as REGULAR files, nothing else in its real folder;
    the folder itself can be opened for the fsync after a save), and the
    folder as the job's mode says. No hard link into or out of a login
    folder or the keychain folder (a second name would make every later
    launch refuse the file). bash's here-document files in
    `/private/var/tmp` must be regular files too;
  - **names, everywhere it can write:** a `.git`, an `.app` or a config the
    person's tools run on their own (`AUTO_RUN_CONFIGS`: `.claude` settings
    and hooks, `.mcp.json`, `.husky`, `.npmrc`, `.codex/config.toml`…) can't
    be made at any depth of the worktree, its home (its top level included),
    its temp folder or the keychain folder. All are on one volume: a folder
    built under an innocent name anywhere could otherwise be renamed into the
    worktree whole. The agent's own state folders whose names are among them
    (`.claude`, `.codex`: the registry's `homeFolders`) are made, empty, by
    the adapter before it starts, and their protected files (`settings.json`,
    `hooks/`, `config.toml`) stay unwritable. A hard link to a protected file
    is refused by the kernel too;
  - **pinned** (no rename, replacement, removal or `chmod`; writing inside
    still works): the folder or worktree root, its home and every folder the
    adapter made in it, its temp folder, the real keychain folder and the real
    folder of each login file. Without that a root could be moved aside,
    filled, and moved back;
  - reads: the real HOME, `/Users`, `/Volumes`, `/private/var/folders` and
    `/private/tmp` are denied, then re-opened for its home, its temp folder,
    the folder, the read-only roots (the Node runtime, the adapter install
    folders, the CLI's install and the tool PATH's dirs where reads are
    denied: `agentReadRoots`), the person's toolchains under HOME (the folder
    fence's own list: `~/.cargo/bin` and `registry`, `~/.rustup/toolchains`
    and `settings.toml`, `~/.nvm`, `~/.volta`, `~/.pyenv`, `~/.bun/bin`,
    `~/.local/bin`, `~/go/bin` and `pkg/mod`; read-only, their credential
    files denied), the keychain folder and the login files. Where
    a HOME credential really lives (`readProtected`, from
    `host-folder-sandbox.ts`) stays unreadable even inside the folder;
  - **the folder, by `seatbelt.ts`'s own rules** (`namesBelow`,
    `secretFileRules`, exported for this): a read job writes nothing in it
    and can't read or stat its secret files (`.env`, keys, credentials); an
    edit job writes only the worktree, reads the repository's `.git` and
    writes nothing under it, so **the agent can't commit**: the desktop
    commits when it sees `finish`.
- **The session's working folder is the folder** (the worktree in an edit
  job): the agent works there itself.
- **A private home per job** (`agent-home.ts`): `<job dir>/home` (0700),
  made by the adapter and never another job's, so nothing a job leaves there
  (settings, hooks, skills, a `CLAUDE.md`) reaches a later job on another
  folder; resuming the same job reuses it. None of the person's own settings,
  hooks, skills, plugins or MCP servers is read from there. The adapter runs
  outside the fence on paths the agent could write during an earlier launch of
  the job, so it repairs and removes nothing there: every folder from the job
  dir down must be a real folder at its own realpath (made when missing), and
  at a login link's name only a link may stand (one pointing elsewhere is
  unlinked, never followed). Anything else refuses the launch with a sentence.
- **Putting a login back** (`settleLoginLink`). An agent may save its login
  beside the path it was given (the link replaced by a file), and the person's
  own login would then keep a refresh token the agent already spent. Whatever
  stands at a login link's name is FIRST renamed out of the agent's reach,
  into the job dir itself (the desktop's: only `<job dir>/home` is writable
  inside the fence), and only THEN looked at: a rename moves the entry as it
  is at that instant, so a process still swapping a file and a link there
  can't make the check see one thing and the move carry another (the earlier
  check-then-move did exactly that under a race; the race test replays it). A
  regular file of this user with one name and at most 1 MB then goes onto the
  real login file (a rename, or across volumes a non-blocking, no-follow,
  exclusive copy beside it and a rename; the copy never stays behind); a link
  is dropped; a folder is left in the job dir and logged; anything else is
  unlinked. The link is then put back. This runs at the next launch and in
  `acp.mjs --return-logins` (below), never at the adapter's own teardown,
  when a process that left the tree may still run. Also at launch: a second
  name of the login file that is one of its scratch names in its own folder is
  unlinked.
- **Toolchains** (`toolchains.ts`): the agent's HOME is private, so tools that
  find themselves through HOME are pointed at the person's own, read-only:
  `RUSTUP_HOME`, `NVM_DIR`, `VOLTA_HOME`, `PYENV_ROOT` when those exist.
  `CARGO_HOME` stays private (`<home>/.cargo`, writable: cargo writes its
  registry cache) while `~/.cargo/bin` stays on the tool PATH; Go's and
  bun's caches stay in the private home too.
- **Existing login, no sign-in step of ours:**
  - `login.keychain` links `<home>/Library/Keychains` to the Mac's keychain
    folder (Claude Code's login);
  - `login.files` links each single login file (`.codex/auth.json`) to the
    real file. The person's folder around it (Codex's config, rules, prompts,
    skills) is never shared: the agent's `.codex` is its own. The real file
    must be a plain file with one name, or the launch is refused;
  - the adapter never calls ACP `authenticate` and never opens a browser
    (`NO_BROWSER=1`).
- **Manager tools.** `report`, `ask_manager` and `finish` are served by the
  adapter's MCP server, and their events come from the call ARRIVING there,
  never from the agent's output. The agent gets the server in `session/new`
  as an HTTP server with an `Authorization: Bearer` header when it advertises
  `mcpCapabilities.http`, else as a stdio server: `acp.mjs --mcp-proxy`, a
  child of the agent inside the fence, holding no Native Intelligence
  credential, forwarding each line to the same port with the bearer.
- **`finish` is held until the turn's `session/prompt` returns**, then
  emitted once: the desktop commits on it, so it must not land while the turn
  (or a command it left running) is still writing. A second `finish` in the
  same turn, and any manager call outside a turn (a command that read the
  bearer, say), is only logged.
- **Instructions** (`instructions.ts`) go as `systemPrompt` (`append`) on
  `session/new`, `session/resume` and `session/load` when the agent advertises
  `sessionCapabilities.systemPrompt`; otherwise at the top of the first prompt.
- **Mode.** A registry `sessionMode` is set with `session/set_mode` after the
  session exists (and again after a resume): the mode where the agent's own
  sandbox is off, since it can't nest inside ours. A refusal is fatal.
- **Permission requests** are answered at once with the first `allow_once`
  option (else the first allow option): the fence is the guard. They are
  logged to stderr, never shown as prompts.
- **Turns.** One `session/prompt` at a time. Messages that arrive during a
  turn (or while the session is being set up) wait and go together, joined by
  a blank line, as the next turn. `stop` sends `session/cancel`, gives the
  turn the grace period, then ends the agent and every process below it,
  including the ones it started that left its process group (a snapshot is
  taken before the agent is stopped: once it exits, its children belong to
  launchd).
- **The `finish` nudge.** A turn that ends normally (`end_turn`) with no
  `finish` yet in this job, and no `ask_manager` in that turn, gets ONE
  automatic follow-up prompt (`FINISH_NUDGE`). Once per adapter process: a
  relaunched job may get one more.
- **Updates** (`session/update`):
  - `agent_message_chunk` → `text`, and a whole `message` when the agent moves
    on (a tool call, a new message id, a manager call, the turn's end);
  - `tool_call` → `tool`, held until its input arrives when that comes in a
    later update (Claude Code sends it so);
  - a tool call `completed` / `failed` → one `tool_result`: text, diffs (path
    and new text) and terminal ids, each cut, then the whole cut to 4 KB;
  - thoughts, plans, usage, modes and commands are **dropped** for now.
  - Text is cut by the bytes of its JSON string (escapes counted: a control
    character takes 6), and every event line is checked against the
    desktop's 64 KB cap before it goes out.
- **Stop reasons:** `cancelled` → the stop's `cancelled`; `refusal`,
  `max_tokens`, `max_turn_requests` → an `error` event, then `waiting`.
- **Not signed in:** an "authentication required" error (-32000) on
  `session/new`, `session/resume`, `session/load` or `session/prompt` is fatal
  with the entry's `signInHint`.

## The registry

`registry.json`, keyed by the worker ids the desktop sends:

| Field | Meaning |
| --- | --- |
| `label` | The agent's name in sentences. |
| `cli` | The executable the desktop looks up on PATH; `LOCAL_AGENT_WORKER_BIN` must have this name. |
| `command` | The ACP adapter's argv: `$NODE` (this Node), `$ACP_DIR`, `$CLI` (the person's CLI, realpath). Its script must exist inside `$ACP_DIR`. |
| `env` | Extra environment: `$CLI`, `$TMP` (its temp folder), `$HOME` (its private home). Never `HOME`, `PATH`, `TMPDIR`, `NO_BROWSER`, `USER`, `LOGNAME`, `SHELL`, `LOCAL_AGENT_*` or `NI_*`. |
| `sessionMode` | Optional, set with `session/set_mode`. |
| `homeFolders` | Its own state folders, made empty in its home before it starts (their names are ones it can't create). |
| `login` | `keychain: true`, and/or `files: [{ path, scratch }]`: single login files of HOME and the names their save makes beside them. |
| `signInHint` | The sentence for a person whose agent isn't signed in. |
| `packages` | The ACP adapter's npm package and exact version; `acp-adapters/package.json` and its lockfile must say the same. |

Today: Claude Code through `@agentclientprotocol/claude-agent-acp` 0.107.0
(`CLAUDE_CODE_EXECUTABLE=$CLI`, so the person's own installed, unmodified
`claude` runs; `CLAUDE_CODE_TMPDIR=$TMP`, without which it tries
`/tmp/claude-<uid>` and fails in the fence; `DISABLE_AUTOUPDATER=1`; its
`.claude`; login in the keychain), and Codex through
`@agentclientprotocol/codex-acp` 2.6.0 (`CODEX_PATH=$CLI`, mode
`agent-full-access`, its `.codex`, login in `~/.codex/auth.json` with the
scratch names `.auth-*`, `auth.json.lock` and `auth.lock`).

## The desktop's side

**What to run.** For every worker: `<node 24> <bundle>/workers/acp.mjs`
(dev: `<agentDir>/.output/workers/acp.mjs`, after `workers/build.sh
agents/local-agent/.output`). The cwd is the job dir: the adapter makes the
agent's home in it (`<job dir>/home`), so a job dir must be the job's alone,
and removing a finished job's dir removes its home. Same process group and
stop and exit handling as for the launcher.

**The adapters.** `workers/install-agents.sh <dir>` installs them with `npm ci`
from `acp-adapters/package-lock.json` (`--ignore-scripts --omit=optional`:
no install script runs, and the optional platform builds of the CLIs, ~340 MB
each, are left out because the person's own CLI runs). Nothing is added to
`web/package.json`.

**Environment.** The launcher's fence environment, built from scratch
(`HOME`, `TMPDIR`, `LANG`, `PATH`, `LOCAL_AGENT_JOB_ID`, `_FOLDER`, `_MODE`,
`_TOOL_PATH`, `_DIR`, and `_EXTRA_READ` in edit mode), plus:
- `LOCAL_AGENT_WORKER`: a registry key (`claude-code` | `codex`);
- `LOCAL_AGENT_WORKER_BIN`: the absolute path of the person's CLI from the
  desktop's PATH lookup, named as the entry's `cli`; run as given (after
  realpath), PATH never searched;
- `LOCAL_AGENT_ACP_DIR`: the folder `install-agents.sh` filled;
- `LOCAL_AGENT_FENCE_DIR`: the fence marker folder (below);
- `LOCAL_AGENT_CLOSED_PORTS` (optional): a comma-separated list of the ports
  that belong to the app itself at launch (each local server of its own
  agent's running jobs, the automation bridge). The profile denies them again
  after it opens loopback, for connecting and for binding. Strict: each item
  an integer 1–65535, at most 512, or the launch is `fatal` with a sentence;
  unset or empty means no extra denials (an older desktop). It is a second
  line of defence only: it can't cover a port the app opens AFTER the worker
  launched, so each listener's own per-launch secret is the real protection.
  The worker's own MCP port is never closed. A registry `env` can't set it
  (no registry entry may set a `LOCAL_AGENT_*` name).

No relay URL, session token or dev key, and any of them (`NI_CREDENTIALS`) is
fatal; so is a `LOCAL_AGENT_LOCAL_MODEL_*` setting.

**The fence marker (a contract).** Before each worker launch the desktop
makes two empty files in a folder of its own that the agent can't write (under
the app's data folder in the person's real home), `<fence dir>/<job id>` and
`<fence dir>/<job id>.open`, and passes the folder as `LOCAL_AGENT_FENCE_DIR`
(absolute). The adapter refuses to run without it (missing, not absolute, not
a real folder, or either file missing: a `fatal` sentence). The profile holds,
after every other read rule:

```
(deny  file-read-data (literal "<fence dir>/<job id>"))
(allow file-read-data (literal "<fence dir>/<job id>.open"))
```

Both are needed: the first is unreadable anyway (it sits under the real home),
the second must be opened explicitly. So the kernel's answer per process tells
them apart: this job's fenced processes are denied the first and allowed the
second; another job's fence and an app's sandbox are denied both; an unfenced
process is allowed both. That is how the desktop finds every process of the
job, a `setsid` one re-parented to launchd included, after the adapter's own
kill of its process tree. Neither file nor the folder can be written, renamed
or removed from inside (pinned). A path that doesn't exist can't serve: the
kernel answers "denied" for it to every process.

**`acp.mjs --return-logins` (a contract).** After the desktop has swept a
finished or stopped job's processes (by its fence marker), it runs
`<node 24> <bundle>/workers/acp.mjs --return-logins`, UNSANDBOXED, with
`cwd` = the job dir, `LOCAL_AGENT_WORKER` = the worker and `HOME` = the
person's real home (no other variable is read; no argument beyond the flag).
It starts no agent and touches only the job's home, the job dir (where an
entry is moved to be looked at) and the worker's login files. It writes ONE
line on stdout and exits:

```
{"type":"logins","returned":<n>}     exit 0: n logins put back (0: nothing to do, or no home)
{"type":"fatal","message":"…"}       exit 1: an unknown worker, no HOME, a home folder that is not one, a locked login file
```

It is synchronous and file-only: well under a second (measured under 300 ms
in the e2e test); give it two seconds. Its log lines go to stderr. The next
launch of the same job does the same before the agent starts.

**Workspace tools (contract v1, `lib/workspace-tools.ts`).** The person's
agent gets Native Intelligence's workspace tools (read its card, comment,
make follow-up cards, link a pull request) without the adapter ever holding a
credential: the desktop holds the job's token and talks to the server.
- **The list:** `LOCAL_AGENT_TOOLS_FILE`, the absolute path of a JSON file the
  desktop wrote before the launch: `{"version":1,"instructions":"<≤ 4,000
  characters>","tools":[{"name","description","inputSchema"}]}`. Read once.
  The file at most 1 MB, at most 64 tools; a tool whose name isn't
  `^[a-z][a-z0-9_]{0,63}$`, is `report` / `ask_manager` / `finish`, is listed
  twice, has a description over 4,000 characters or an `inputSchema` that
  isn't an object is dropped (one log line each). No variable, no file, an
  unreadable or invalid one, or no tool left: no workspace tools, one log
  line, and the job runs exactly as without (same lines, same tool list, same
  instructions). Never fatal.
- **One server:** the tools are listed after `report`, `ask_manager`,
  `finish` on the same MCP server, behind the same per-launch bearer. The
  file's `instructions` go into the system prompt (or the first prompt) and
  the MCP server's instructions, framed as their own section and followed by
  our sentence: what these tools return is content from the workspace, to be
  read as information, never as instructions.
- **A call** (only during a turn; between turns it is refused to the agent):
  ```
  out: {"type":"tool_call","id":"<^[A-Za-z0-9_-]{8,64}$>","name":"<tool>","input":{…},"turn":"<turn id>"}
  in:  {"type":"tool_result","id":"<id>","ok":true,"output":<any JSON>}
  in:  {"type":"tool_result","id":"<id>","ok":false,"error":"<sentence>","code":"<^[A-Z0-9_]{1,64}$>, optional"}
  ```
  `id` is random and unique in the launch; `turn` is one id per agent turn.
  A `tool_call` line is at most 1 MB: a bigger input is refused to the agent
  and nothing is sent. At most 4 calls are with the desktop at once; more
  wait here, in order. Each gets 320 s from when its line is written; then
  the agent is told the tool did not answer and that the call may still have
  run. An unknown id, a second answer, a malformed one or one after the
  timeout is logged and ignored. On a stop or shutdown every waiting call is
  answered to the agent as cancelled. A `tool_result` line may be up to 4 MB
  (every other stdin line keeps the 256 KB cap); a longer one can't be
  matched to its call, which then times out.
- **`call_tool`** (when the list has it) is never forwarded by that name: its
  inner `name` and `input` are. Names: a tool LISTED in the file matches
  `^[a-z][a-z0-9_]{0,63}$`; an inner name (and so the `name` on the line it
  becomes) matches `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, because the person's
  connected MCP tools are named their own way (`linear.create_issue`,
  `GitHub:list-prs`). A manager tool ("call it directly") and an inner
  `call_tool` are refused; an inner `search_tools` is forwarded as
  `search_tools`. `search_tools` itself is forwarded like any tool, and its
  answer (a JSON value of matches, up to 256 KB) reaches the agent as text.
- **A held call** (waiting for the person: `{ success: false, code:
  "APPROVAL_REQUIRED" | "NEEDS_PERSON", message, approval_id }`) arrives as an
  ordinary `ok` answer, and the agent reads that output unchanged as the
  tool's result text, never as an MCP error.
- **The answer:** `ok`: one text content (a string as is, anything else as
  JSON), at most 256 KB, cut with a note saying so; not `ok`: `isError` with
  the sentence (cut to 2,000 characters) and the code in brackets.
- **The transcript** already shows each call as `tool` / `tool_result` from
  the agent's own ACP updates, cut to the usual limits; the adapter adds
  nothing of its own, so nothing shows twice. A read job is no different: the
  server decides which tools a job gets.

**Lines in:** `start`, `resume`, `send`, `stop`, as for the launcher. `token`
lines are dropped. `tool_result` lines go to the workspace tools (below).
`prompt_answer` lines go to the launcher's own prompt
broker (`../launcher/prompts.ts`, reused as is): the answer to the open `push`
prompt is taken; one for any other id, or malformed, is logged and dropped. A
line over 256 KB is skipped with an `error`. A `stop` is acted on at once,
never behind another line.

**Lines out:**

```
{"type":"ready","port":0,"worker":"claude-code","workerVersion":"0.107.0"}   after `initialize`: the ACP adapter's version
{"type":"session","sessionId":"<id>","streamIndex":<n>}                     after session/new, or after a resume succeeded
{"type":"cursor","streamIndex":<n>}                                         every finished prompt (the nudge's too)
{"type":"event","event":<NormalizedEvent>}                                  report / ask at once; finish after its turn, once
{"type":"prompt","id":"p-<hex>-<n>","kind":"push","detail":{"title":…,"body":…,"timeoutMs":…}}   the launcher's own line
{"type":"tool_call","id":…,"name":…,"input":{…},"turn":…}                   a workspace tool call (below)
{"type":"fatal","message":"<a sentence for the person>"}                    then exit 1
```

- **A pull request** (C5, as our own agent's): the agent's `finish` may carry
  `pull_request` (`title` 1–256 characters, `body` at most 60,000; control
  characters stripped from the title, as the prompt does). In an EDIT job the
  adapter then writes, in this order: the `finish` event (`summary` only,
  exactly as the launcher's), the `push` prompt line (the launcher's broker:
  same ids, one prompt at a time, 5-minute timeout counted in `timeoutMs`),
  and, once the `prompt_answer` arrives (or the timeout passes), the turn's
  `cursor` and `waiting`. The desktop commits on `finish`, and on a yes pushes
  and opens the pull request itself, writing the `prompt` and `pull_request`
  events as it does for our own agent. The agent hears the person's answer once,
  as a `[From Native Intelligence]` note at the start of its next turn: yes
  (the app is pushing and opening the pull request itself; it won't see the
  result and must not push), no (nothing pushed), or nobody answered (nothing
  pushed; `finish` with `pull_request` asks again). Never a link: the push's
  result never reaches the adapter. The note lives in memory only. A read job's
  `finish` with `pull_request` is a plain `finish` (no prompt; the agent is
  told nothing was changed). A worker never sends a `fence` prompt.

- **`finish`** comes right before the turn's `cursor`, never mid-turn (the
  agent is told to stop what it started first; see the risks); the
  desktop still has to refuse to commit an auto-run config in a worker job
  (the profile denies them, the desktop is the second check).
- **Session ids** are whatever the agent answered (both use UUIDs today),
  accepted when they are 1 to 256 of `[A-Za-z0-9._:-]` starting with a letter
  or digit (`SESSION_ID`): they travel in JSON, never on a command line.
- **`resume`** writes `session` and `waiting` once the agent has picked the
  session up (`session/resume`, else `session/load` with the replay
  swallowed). An agent with neither, or a session it doesn't know, is fatal.
- **The job lock is the launcher's** (`<cwd>/.launcher.lock`, `O_EXLOCK`).
- **Fatal** before `ready`: a bad launch environment, the adapter not
  installed, a home or login link that isn't what the adapter made, a login
  file that isn't a plain file, the agent not starting under its profile.
  After it: not signed in, a session that can't be made or picked up, the
  mode refused, the agent exiting on its own. A failed turn is an `error`
  event, then `waiting`.

## Doesn't map (a worker against our own agent)

- **`finish` lands when the turn ends**, not when the call is made: the
  adapter holds it until `session/prompt` returns (commands the turn started
  could still be writing). The order of `finish`, the `push` prompt and the
  cursor is the launcher's.
- **The push outcome comes one turn later.** Our own agent's `finish` waits
  for the person's answer and gets it as the tool's result; a worker's
  `finish` returns at once (ACP has no way to hold a tool call across the end
  of a turn), so the agent gets the person's answer at the start of its next
  turn, and never the pull request's link.
  If no message ever follows, it never hears it.
- **A bad `pull_request` is a tool error the agent can fix** (as eve's schema
  refuses it for our own agent), never an `invalid` prompt outcome.
- **No `fence` prompts**: a worker can't ask for one more path.
- **Steer and queue are the same**: ACP takes no input into a running turn.
- **Thoughts, plans and usage** are dropped (see the risks).

## Verified, and not

Verified here (`npx vitest run agents/local-agent/workers`, Node 24). **The
kernel tests (`agent-profile.test.ts`'s `sandbox-exec` part and
`worker.e2e.test.ts`) run only on a Mac (`runIf(onMac)`); elsewhere they are
skipped, not passed.** Also checked by the kernel: each denied Mach service
(looked up by name with `bootstrap_look_up`: refused under the profile, found
outside) and the kept ones still found; `defaults write` refused and nothing
written to the real preferences while `defaults read` works; `launchctl`
refused; hard links, symlinks, folders and moved-in trees at the login names
refused; a here-document folder in `/private/var/tmp` refused; the fence
marker denied and its `.open` readable, neither touchable; a login saved
beside its link moved onto the real file at the next launch and by
`--return-logins` (never by teardown), and never a link onto the person's
login while a process races the repair swapping a file and a link at the
login name (80 trials; the old check-then-move fails it within three); every
Mach lookup refused but the allow-list (the reviewer's reachable services by
name), `shortcuts` and `automator` refused; the person's toolchain folders
readable and nothing else near them, the credential files and
`~/.cargo/config.toml` not. Opt-in with `LA_TEST_NETWORK=1`: curl, `git
ls-remote`, `npm view`, Python's urllib and Node's https work over HTTPS
under the profile, and binding a local port is refused.
- the driver against a stand-in ACP agent (`fixtures/fake-acp-agent.mjs`) run
  as a real process: capabilities and both MCP hand-overs (HTTP with the
  bearer, and the bundle's real stdio proxy), instructions both ways, the
  event mapping and its cuts, permission answers, queued messages, stop and
  cancel, `session/resume`, `session/load` with the replay swallowed, neither,
  `session/set_mode`, the sign-in sentence, the manager events, `finish` held
  to the turn's end and once per turn, a forged `finish` between turns
  ignored, the one-time nudge; a pull request: `finish`, the launcher's
  `push` prompt line and (after the answer) the cursor, in that order, both
  answers told to the agent with its next message, a read job's plain
  finish, a second `finish` still ignored, a stray `prompt_answer` dropped;
- the private home: per job, the reviewer's probes replayed (its `Library`, its
  home or its login folder swapped for a link to the real one, a folder or a
  file where a link was) each refusing the launch with nothing of the fake
  real home changed, a link to elsewhere unlinked only, a linked or
  hard-linked login file refused;
- the profile enforced by the kernel (stand-in processes under
  `sandbox-exec`, a fake real home): no read of the rest of HOME or of a read
  job's secret files; writes only where each mode allows; the login file saved
  the way its CLI does (a `.auth-*` temp file renamed over it, a lock file)
  and nothing else of its real folder readable or writable; no commit; no
  `.git` or auto-run config anywhere, by name, by a hard link, or built under
  an innocent name and renamed into place, whole folders included; every
  pinned root unmovable, unreplaceable, unremovable; the reviewer's chain
  (settings and a hook built in the home, the worktree moved aside, the home
  moved in) refused; an unfenced server on this Mac reachable over IPv4, IPv6
and by name, and UDP to it, while 127.0.0.2, remote ports 80 and 22 are
refused and 443 is let through; a fenced server on a loopback port talking to
a second fenced process over TCP and over UDP both ways; a bind to the
wildcard address succeeding (the accepted cost); a port the app lists as its
own neither connectable nor bindable; a server the agent left listening killed
at the stop;
  the keychain through the home's link; no other process's arguments or
  signals; no launchd job;
- the whole worker end to end (`worker.e2e.test.ts`): the bundled adapter,
  the real profile, MCP server and proxy, the stand-in agent installed where
  `install-agents.sh` puts the real ones, a read job and an edit job, the
  login file saved through its link and nothing else of the real Codex folder
  touched, a relaunch that resumes, a second job unable to read or write the
  first job's home, every child process (one that left the group too) dead
  after a stop, the nudge, the sign-in sentence, the refusals;
- opt-in (`LA_TEST_CODEX_BIN=<codex>`): a real Codex saves an API-key login (a
  made-up key, a fake home, the file store forced) through the link under the
  profile, and nothing else appears in the real folder.
- **Codex's save, by version.** Seen for real: 0.166.0's `login
  --with-api-key` rewrote `auth.json` IN PLACE through the link (same inode;
  no scratch name used). Known only from its source (`codex-rs/login`, main
  branch, read 2026-11-13) and replayed by a Python stand-in under the profile
  (temp `.auth-*`, lock `auth.json.lock`, rename over the file, fsync of the
  folder: exit 0): the atomic save of newer versions. A token refresh of any
  version has not been seen.

By hand on 2026-11-13, one tiny read-job turn each through the built
`acp.mjs`, with the adapters from `install-agents.sh`, on the person's own
login: Claude Code 2.1.311 and Codex 0.166.0 started under the profile, made
a session in the folder, answered, called `finish` (Codex twice: the second
was ignored, and the one `finish` came after the turn), and stopped with
`cancelled`. Codex read its login through the file link; the real
`auth.json` kept its size and modification time (no refresh was due). Claude
Code's account-synced plugins failed to stage in its home (their files hit
the denied names), so they did not load; the turn was unaffected.

Not verified:
- a token refresh of either agent under the profile (Codex's newer atomic
  save is only replayed by a stand-in; a refused save during a refresh could
  spend a single-use refresh token and break the person's real login);
- an edit job, a resume, a permission request, a `sessionMode` refusal or the
  stdio proxy with a real agent (both real agents take HTTP MCP);
- pyenv and volta (not on this Mac): their variables are set, but whether
  their shims run read-only is unverified.

By hand on 2026-11-13 under the real profile on this Mac (an edit job in a
throwaway worktree): `rustc --version`, `cargo --version`, `cargo metadata
--offline`, `cargo check` (also with a crates.io dependency, downloaded into
the private `CARGO_HOME`), `node -v`, `npm -v`, `python3 --version`,
`uv --version`, `bun --version`, `whoami`, curl, `git ls-remote` (with the
osxkeychain helper configured: no hang, no prompt), `npm view`, Python and
Node over HTTPS all work; `shortcuts list` is refused.

## Known risks

- **The keychain.** The keychain folder is readable and writable to the agent
  and everything it runs, so a command it runs can read keychain items the
  login keychain hands out without a prompt: the same exposure as running the
  CLI in Terminal. Accepted by the owner.
- **Every service on this Mac is reachable.** The agent and every command it
  runs can connect to anything listening on this Mac: other projects' dev
  servers, local databases, local model servers, admin consoles, and anything
  else that trusts connections from the same machine. Seatbelt's `localhost`
  covers this Mac's own addresses (127.0.0.1, ::1, and its LAN address too,
  measured), not 127.0.0.2 and not another machine. Every job's MCP port is
  among them; each keeps its own per-launch bearer, and one job's bearer is
  refused by another's server (tested).
- **The agent can start servers, and one bound to all addresses is reachable
  from other machines on the same network while the job runs.** The profile
  language can't tell loopback from the wildcard address for a listener (in a
  bind rule `localhost` also matches `0.0.0.0` and `::`, and an accepted
  connection is never checked against the peer: measured, a fenced server on
  `0.0.0.0` accepted a connection on this Mac's LAN address). Accepted by the
  owner: the same exposure as running a dev server himself. The agent is told
  to bind loopback; nothing enforces it. Nothing it starts outlives the job
  (the tree kill at a stop, then the desktop's fence sweep).
- **Port 443 to any host.** Seatbelt can't filter by host, so the agent (and
  every command) can send what it reads (the folder, the login file) to any
  HTTPS server. A prompt injection in the folder could try exactly that.
- **The keychain folder stays writable for regular files** (Claude Code's
  login lives there); only hard links into or out of it are refused.
- **`finish` and commands still running.** The desktop commits when
  `finish` arrives. The agent is told to stop everything it started before
  calling it, but nothing enforces that: a background command still writing
  can land half a change in the commit, and one that left the process tree
  keeps running until the desktop's sweep.
- **`launchctl` is a binary, not the boundary.** The profile refuses running
  `/bin/launchctl` and creating jobs, but launchd's other requests (restarting
  an existing job, say) travel over a channel Seatbelt has no operation for;
  a program calling the library directly could still make them. Measured:
  sandboxed `launchctl setenv` is refused by launchd itself, `kickstart` of an
  existing job is not.
- **The login file is live.** A command can read it (the token) and rewrite
  it; the person's own Codex then uses what it holds. Only that file and its
  save's scratch names are writable: no setting, rule or skill of theirs.
- **The denied names cost something.** No `.git` can be made in its home or
  temp folder (a test suite that `git init`s in TMPDIR fails), nor a
  `.yarn` or `.npmrc` in its home, nor its agent's own `settings.json` or
  hooks; account-synced plugins don't install.
- **Thoughts, plans and usage are dropped.** The desktop sees text, tools and
  the manager events only.
- **A process that leaves the tree on its own.** A stop or a fatal kills every
  process below the adapter as it was before the agent was stopped. If the
  agent itself crashes first, what it started is re-parented before the
  adapter looks, and survives the job (still inside the profile).
- **A `tool` row for the manager tools too.** The agent reports its own call
  of `finish` as a tool call, so it shows as a tool beside the `finish` event.
- **The worker sends the folder's contents to Anthropic or OpenAI** on the
  person's account, which is the point. The desktop refuses workers while the
  Mac is set to a local model, and the adapter refuses them too.
- **Terms:** Anthropic allows a person's unmodified Claude Code, signed in
  with their own plan, inside another product (docs/plans/local-agents.md,
  appendix); the adapter runs their installed `claude` as is. For Codex on a
  ChatGPT login, OpenAI's sanctioned third-party route is Sign in with
  ChatGPT; check before shipping.

## What does not work inside the fence

Stated plainly, so a failure is not a surprise:
- **To other machines, port 443 only**: git over ssh and plain HTTP are
  refused. Every port on this Mac is reachable (see the risks).
- **No new git repository** in its temp folder or its home (`.git` is a
  denied name everywhere it can write), so test suites that `git init` in
  TMPDIR fail.
- **Setuid tools are refused**: `ps`, `ping`, `top` and the like.
- **File watchers that use FSEvents fail** (`fseventsd` is not on the Mach
  allow-list): watch modes of test runners and bundlers, and Claude Code's own
  settings watcher, which logs `EMFILE … watch` at start (harmless: its
  settings can't be written anyway).
- **No writes under `/var/folders`**: every Xcode shim (`git`, `clang`,
  `python3` from the command line tools) prints that it can't write its
  `xcrun_db` cache; compiler module caches that live there may fail.
- **Nothing of the person's own setup**: no `gh` login, no `~/.ssh`, no
  `~/.npmrc` registry auth, no global git identity (`git config user.name` is
  empty), no preferences (reads and writes refused).
- **Toolchains**: rustup, cargo, nvm's node and npm, Python, uv and bun work
  (above). A `rust-toolchain.toml` asking for a toolchain the person hasn't
  installed fails (rustup can't install into the read-only home); pyenv and
  volta shims are unverified; anything that keeps its setup only under HOME
  and isn't in the list sees an empty home.

## Servers the agent starts

The agent may start servers (dev servers, test suites that open a port, local
databases). Many tools bind all addresses by default, which makes them
reachable from other machines on the network while the job runs (see the
risks); the agent is told to bind `127.0.0.1` / `localhost` instead. The flags:
Vite `--host 127.0.0.1` (it binds localhost by default unless `--host` is
given), Next.js `-H 127.0.0.1`, `python3 -m http.server --bind 127.0.0.1`,
webpack-dev-server and Create React App `HOST=127.0.0.1`, Rails
`-b 127.0.0.1`, Django `runserver 127.0.0.1:8000` (its default),
Jupyter `--ip=127.0.0.1` (its default). Nothing in the environment pushes
tools toward loopback (`HOST` and `HOSTNAME` mean other things to other
programs). Every server it starts ends with the job: the adapter's kill of
its process tree at a stop, then the desktop's fence sweep for one that left
the tree.

## Windows

Not built: this whole local-agent path is macOS-only today, because the fence
is Seatbelt. The design for Windows, to be verified on a Windows machine, not
fact:
- **The process tree in a Job Object** with kill-on-job-close and no breakaway:
  every process the agent starts stays in the job and dies with it. That also
  replaces the fence marker (the desktop holds the job handle).
- **File and network limits** by a restricted token or an AppContainer, with
  access lists granting the job folder, the private home, the granted folder
  (read, or write for an edit job's worktree) and nothing else; outbound
  network limited by the AppContainer's capabilities or Windows Filtering
  Platform rules (port 443 and the MCP port).
- **The private home** through `USERPROFILE` / `APPDATA` / `LOCALAPPDATA`
  pointed at `<job dir>\home`.
- **Logins** there are files (no keychain link), so they go through
  `login.files`, with the same rules (one plain file, its save's scratch
  names, the repair at teardown); Windows has no Seatbelt `vnode-type`, so
  "regular files only" needs another check.
- **The registry**: `command`, `env` and `cli` are platform-neutral, but the
  placeholders (`$NODE`, `$CLI` paths), the `cli` name check (`claude.exe`,
  `codex.cmd`) and the path rules (drive letters, case, `\`) are not.

Not verifiable without a Windows machine: whether either agent and its CLI
start inside an AppContainer at all, how a token refresh saves its login
there, whether the network can be held to port 443 and one local port, and
what replaces the name rules (`.git`, auto-run configs) and the pins.

## Build

```bash
agents/local-agent/workers/build.sh <out-dir>            # <out-dir>/workers/acp.mjs (~140 KB)
agents/local-agent/workers/install-agents.sh <acp-dir>   # npm ci from acp-adapters/package-lock.json (~87 MB)
```

`scripts/local-agent/bundle.sh` (WS-B) should call both.
