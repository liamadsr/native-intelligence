# local-agent: the Mac host

**The Mac body of the one Dial8 agent** (contract C2, `docs/plans/teammate-agent.md`):
the main chat agent, `agents/chat-agent`, built with `DIAL8_AGENT_HOST=mac` and
run **on the person's Mac**, in one folder they granted, as a teammate of the
cloud body (`docs/plans/local-agents.md` for the history: L0 was the Mac-only
spike, L1–L3 the Dial8 model relay with a per-session token, and **edit mode**:
a git worktree the desktop makes, writable except its `.git`, committed by the
desktop on `finish`). This folder is no longer an agent of its own: it is the
host that body runs in. It holds the launcher and its request guard, the fence
(the sandbox), the model, the channel and the Mac-only tools; the agent's
instructions, Dial8 tools, memory and hooks are the chat agent's.

- **Built from one source.** `scripts/local-agent/mac-body.sh` copies
  `agents/chat-agent` and this folder into a throwaway stage, leaves out what
  only the cloud has (the quick helpers and their subagents, the usage meter),
  puts this folder's `channels/eve.ts` in place of the cloud's channel, adds
  this folder's `sandbox.ts`, `tools/finish.ts` and
  `tools/request_folder_access.ts`, and runs `eve build` with
  `DIAL8_AGENT_HOST=mac`. It also replaces the chat agent's
  `lib/mac-slots.ts`, a stub that throws, with re-exports of this folder's
  model, token reader and mode text: the chat agent's only door into this
  folder, so none of it reaches the cloud bundle. Everything else that differs
  is a switch inside the chat agent's own files
  (`agents/chat-agent/lib/host.ts`: the model, the harness tools, the web
  tools, the spec and tool transport with a liveness check before every model
  step, and again before a tool that acts on the Mac when the last answer is
  over 2 s old (`lib/mac-guard.ts`, so a Stop that lands mid-step is refused),
  `ask_user`, no tool-result images, the Mac instructions). The cloud build is
  unchanged.
- **Its Dial8 tools come from the app** (C1): the spec and every tool call go
  to `/api/local-agent/agent/{spec,tool}` with the session token, never the
  shared secret (`agents/chat-agent/lib/mac-host.ts`).

The desktop app launches it; nothing here is mounted in the Next app
(`next.config.mjs` lists its agents explicitly, and this one is not among them).

## The six invariants (plan §1)

1. **Pinned code.** What runs on the Mac (this agent, its tools, its sandbox
   policy) ships with the app. The server cannot change it. *(L0: built from
   this repo by the developer; the pinned Local Module comes in L1.)*
2. **Requests, not commands.** The only inputs are `start` (request text),
   `send` (text) and `stop`. No message carries a command, code or path.
3. **The fence lives on the Mac.** The grant (folder, mode) is chosen in the
   desktop's native picker and passed in the environment by Rust; the sandbox
   provider re-checks it and the kernel enforces it (Seatbelt). A grant must
   be a realpath strictly inside HOME, or outside every system root (`/private*`,
   `/etc`, `/usr`, `/var`, `/opt`, `/tmp`, `/bin`, `/sbin`, `/dev`, `/System`,
   `/Library`, `/Applications`, `/Volumes`, `/Users`) and every read-denied
   root, neither inside one nor above one (`lib/seatbelt.ts` `grantRefusal`).
4. **Outbound only.** The eve server listens on 127.0.0.1 behind a random
   32-byte secret per launch, checked in constant time (`channels/eve.ts`,
   `lib/auth.ts`). No `localDev()`, no OIDC. A preload
   (`launcher/server-guard.ts`) answers a bare 403 to any request with an
   `Origin` header or a Host other than `127.0.0.1:<port>` (DNS rebinding),
   and to anything outside `/eve/*` without a second per-launch secret
   header. That covers the Workflow callbacks under `/.well-known/workflow/*`:
   the world's own callbacks get the header from a global fetch patched for the
   server's own base URL only. The launcher checks the guard is live (three
   probes must get 403) before it reports `ready`.
5. **Approvals on the Mac.** The desktop asks with a native prompt (contract
   C3, `launcher/prompts.ts`): `push` before it pushes the job's branch and
   opens a pull request, and `fence` before the job may read one
   more path, for this job only. Nothing else outside the fence is reachable.
6. **You can see and stop it on the Mac.** The desktop lists jobs, shows their
   events and stops them.

## Files

| File | What it is |
| --- | --- |
| `agents/chat-agent/agent.ts` (Mac branch) | The model from `lib/model.ts`, resolved per model step with its window (250K for the relay; for a local model, the context its server loaded, from `resolveLocalAgentContextWindow`, which awaits the probe the first request shares, so even the first step compacts at it; a failed probe gives the 32K floor and fails the turn through the request, never the session, and a Stop ends the wait), and spend caps. |
| `lib/model.ts` | `anthropic/claude-sonnet-5.5` (= `SURFACE_MODELS.coding_runs`, copied literal) as a `createGateway` LanguageModel: through the relay (base URL + token file) or the dev key. Or (L4) a model on this Mac: `createOpenAICompatible` on Ollama's or LM Studio's loopback server from `LOCAL_AGENT_LOCAL_MODEL_*`, with a fetch that refuses any other URL and any redirect, probes the server first and turns its failures into sentences. The probe refuses a model that isn't on this Mac (an Ollama `-cloud` model, or `remote_host` / `remote_model` in `/api/show`), one that can't call tools, and one whose loaded context is unknown or under 32K (`MIN_LOCAL_MODEL_CONTEXT`: Ollama `/api/ps` `context_length` after a no-options load, so the context is what the job's own requests get, else the Modelfile `num_ctx`; LM Studio `loaded_context_length`), counted at most 2M (`MAX_LOCAL_MODEL_CONTEXT`). On Ollama, an `/api/show` that doesn't answer is refused before anything loads. After a "too long" answer the probe runs again once, for a server that reloaded the model with less. eve's compaction window is the probed context: `localAgentContextWindow` (sync, the 32K floor until the probe ran) or `resolveLocalAgentContextWindow` (awaits the probe the first model request shares). A relay or Gateway variable beside `LOCAL_AGENT_LOCAL_MODEL_*` is refused. For a person on their own ChatGPT plan (the current token's `cp` claim, read every step), `localAgentPlanStep` gives the Mac body's model `gpt-6.1-sol` through the relay's plan path instead, with `store: false`. The ONE file the tripwire lets import `createGateway` and `@ai-sdk/openai-compatible` (decision 7). |
| `agents/chat-agent/lib/mac-instructions.ts`, `lib/mode-instructions.ts` | The Mac body's own instructions (the folder, the message prefixes, `report_to_person` / `message_teammate` / `finish`), appended to the conversation's prompt by the chat agent's persona; then read mode or edit mode text, picked per job from `LOCAL_AGENT_MODE`. |
| `channels/eve.ts`, `lib/auth.ts` | The Mac body's channel (it replaces the cloud's in the Mac build, and refuses to load outside the Mac host): bearer auth on `LOCAL_AGENT_SECRET` only, plus the stand-in run token and the other attributes the chat agent's resolvers read (`agents/chat-agent/lib/mac-host.ts` `macPrincipalAttributes`). |
| `sandbox.ts` | The `HostFolderSandbox` environment, added to the Mac body as its `sandbox.ts`; the selector opens it from `LOCAL_AGENT_FOLDER` / `LOCAL_AGENT_MODE` / `LOCAL_AGENT_TOOL_PATH` (+ `LOCAL_AGENT_EXTRA_READ` in edit mode) and fails closed if one is missing. |
| `lib/chatgpt-plan-model.ts` | The ChatGPT plan model, byte-identical to every plan agent's copy (`chatgpt-plan-model-drift.test.ts`). |
| `lib/seatbelt.ts` | Pure SBPL profile builder (unit-tested). |
| `lib/host-folder-sandbox.ts` | The `defineSandboxProvider` provider: path mapping, command rewrite, the job runner (one Seatbelt sandbox for every command and file method of the job), process groups, the reap on stop, and fence grants (`requestFenceAccess`). |
| `tools/finish.ts`, `tools/request_folder_access.ts` | The Mac-only tools, added to the Mac body. `finish` ends the turn; its optional `pull_request` asks the person (C3 `push`) in an edit job. `request_folder_access` asks to read one more path for this job (C3 `fence`, read only). The teammate tools (`report_to_person`, `message_teammate`, C4) are the app's, through C1. In the chat agent, `bash`, `read_file` and `write_file` are eve's own on the Mac, bound to the sandbox (`write_file` fails in read mode, and on `.git` in edit mode); eve's native web tools are off (C1 serves `web_fetch` / `web_search`), and so is the root-copy `agent`. |
| `launcher/launcher.ts` | The per-job launcher (below). |
| `launcher/prompts.ts` | C3 native prompts, both halves: the launcher's broker (`prompt` lines out, `prompt_answer` lines in, one prompt on screen at a time, a timeout is a no) and the eve server's `askPerson`, which tools await over fd 3. Self-contained (node: imports only). |
| `workers/` | L4: the person's own Claude Code or Codex as the job's worker instead of eve, on the same JSON lines, inside the same fence (`workers/README.md`). eve's build ignores the folder too. |

## The sandbox

`/workspace` is the granted folder. macOS `/` is read-only, so the provider
maps it: the file methods map `/workspace/...` and relative paths onto the
folder and reject anything that resolves outside it after realpath; commands
get `/workspace` tokens rewritten to the folder (or to a shell-safe symlink to
it when the folder's path has a space). eve's bash tool parks long commands'
output under `/tmp/.eve/jobs/<id>`; those tokens are rewritten to the
session's scratch dir, so jobs never share `/private/tmp/.eve` and a stop can
find and kill them.

eve stages message attachments and tool-result media under
`/workspace/.eve/attachments` after every model step, through the file
methods, and keeps the host path `resolvePath` gives back. The file methods
map `/workspace/.eve` (also `.eve/...`, `/workspace/./.eve`, and the folder's
or the alias's own `.eve` as a host path, in any letter case) onto
`<scratch>/workspace-eve`, so those copies never land in the person's folder
or worktree. They may write in the scratch dir in read mode too, so staging
never throws. Commands get only the literal `/workspace/.eve` token rewritten
to the same dir, so the model can open a staged file by either path. Other
spellings in a command (`cd /workspace && ls .eve`, `/workspace/./.eve`, the
folder's own path) and an in-folder symlink to `.eve` (for the file methods
too) reach the folder's real `.eve`: that is inside the grant, so nothing
leaves the fence. `/workspace/.eve/../x` is the folder's `x` to a file method
(the path is normalized first) but the scratch dir's `x` to a command (the
shell resolves `..` after the rewrite).

Every command of a job runs inside ONE Seatbelt sandbox: the job runner, a
small Node program started once as
`/usr/bin/sandbox-exec -p <profile> <node> -e <RUNNER_SOURCE>` (the server's
own Node, made readable by the profile). It forks each command
(`/bin/bash -c <cmd>`, and the file methods' `cat`, `mkdir`, `rm`) detached in
its own session and process group (an abort kills the group, from outside),
and relays its stdout, stderr and exit to the provider in frames. Each command
gets a clean environment: `PATH` (the toolchain PATH), `HOME`, `TMPDIR` (the
scratch dir), `LANG`, `TERM=dumb`, `AI_AGENT=eve`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0` (no opportunistic index
refresh: the index is read-only), `XDG_CONFIG_HOME=<scratch>/.config` (so
git and other tools don't warn about the unreadable `~/.config` on every call)
and `GOCACHE=<scratch>/.cache/go-build` (`go build` needs a writable cache).
Never the server's (no `AI_GATEWAY_API_KEY`, no `LOCAL_AGENT_*`), and no file
descriptor beyond stdio (Node spawns with `POSIX_SPAWN_CLOEXEC_DEFAULT`), so
no command reaches the prompt channel on the server's fd 3. In read mode every
write and remove fails before anything runs (the kernel refuses them too; a
test bypasses the guard to show it).

One sandbox per job is what lets the profile limit signals to `same-sandbox`
(measured on 27.0.1: each `sandbox-exec` is its own sandbox, so a per-command
sandbox would also stop eve's bash tool from claiming and cancelling its own
background jobs). The job's commands can signal each other (eve's claim and
cancel, the model's `kill -- -<pgid>`); nothing outside the job, not the
desktop app nor any of the person's processes. And it is how a stop kills
everything: the runner sends SIGKILL to -1 from inside the sandbox, which
reaches every process of that sandbox and only those, wherever `setsid`,
`setpgid`, a detached `posix_spawn` or a double fork moved them. Stop, quit
and delete reap this way, and so does the runner when its stdin closes (the
eve server went away). When the runner itself is killed from outside (the
launcher's teardown SIGKILLs every process group below the server; a job's
`pkill -9 node`), its reaper does it: a bash in the same sandbox,
double-forked at the runner's start (so outside the server's process tree),
blocked reading a socket only the runner holds; when the runner is gone it
sends SIGKILL to -1. eve builds a new sandbox handle for a session on every
workflow step, so the runner (and its earlier grant generations and command
groups) belongs to the session, keyed by its scratch dir, and every handle
shares it: a job started in one step can be stopped from the next. A runner
that doesn't start a command within 15 s (stopped, wedged) is killed from
here, and its reaper reaps. Nothing is ever killed by a pid read from eve's
`.eve/jobs/<id>/pid`: the job can write those files, and this unsandboxed
process would kill whatever they name. The runner ignores SIGTERM, SIGINT and
SIGHUP, so `pkill node` in a job leaves it running. Syscall filters can't
replace this: `(deny syscall-unix (syscall-number SYS_setsid))` is bypassed
by `posix_spawn(POSIX_SPAWN_SETSID)`, which Node's `detached` uses.

The profile (`lib/seatbelt.ts`): `(allow default)`, then no network,
signals only within the job's sandbox, no launchd job creation, no writes
except `/dev/null`, `/dev/tty`, the std streams, bash 3.2's here-document files
in `/var/tmp` and the scratch dir, and no reads of file contents anywhere
except:
- the system paths toolchains need (`SYSTEM_READ_ROOTS`, measured with git,
  the Xcode shims, python3, perl, ruby, swift, node, npm, cargo and the shell
  tools): `/usr`, `/bin`, `/sbin`, `/System/Library`, the cryptexes, `/opt`,
  `/nix`, `/dev`, `/Library/{Developer,Apple,Frameworks,Java,Ruby,Python,Perl}`,
  `/Applications/Xcode*.app`, the timezone database, the xcode-select links,
  `/etc/{localtime,hosts,ssl}` and Xcode's preferences (xcrun checks the
  license there on a cache miss). Not the rest of `/etc`, `/Library`,
  `/Applications` or `/private/var`;
- the tool PATH's own `bin` dirs outside HOME (for an entry under
  `/Applications`, its whole `.app`), and the server's Node runtime dir;
- the folder, the session dir (scratch + alias) and the paths the person
  allowed in a fence prompt;
- toolchains under HOME, binaries and toolchains only: `~/.nvm`,
  `~/.cargo/bin`, `~/.cargo/registry`, `~/.rustup/toolchains` (+ rustup's
  `settings.toml`), `~/.bun/bin`, `~/.local/bin`, `~/.volta`, `~/go/bin`,
  `~/go/pkg/mod` (never `~/go/src`) and `~/.pyenv`, read-only.

No git config (commands run with `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1`), no `~/.local/share`, no cargo config, and a last deny
on `credentials*` files near the top of a toolchain dir (at most two dirs down:
cargo's `credentials.toml`; deeper the name is source code, `botocore/credentials.py`
or gRPC's `credentials` package) and `npmrc` files anywhere under one, in any
letter case. No Apple events,
no LaunchServices or pasteboard, no exec of `open` / `osascript`. Beyond the
contract's profile: no exec from the writable scratch dir, and no window
server, audio HAL, camera or keychain lookups (the app holds mic and screen
permissions for meeting capture, and TCC attributes a child to the app). The
scratch dir is `$TMPDIR/dial8-local-agent/<session>/tmp`, under the job's
TMPDIR, which the desktop sets per job. One file in the per-user temp dir is
readable (never writable): xcrun's lookup cache, `.../T/xcrun_db`. Every Xcode
shim in `/usr/bin` (git, make, clang, python3) runs through xcrun, which
ignores TMPDIR; without the cache each call re-resolves the developer dir
(about 2 s on a busy Mac against 20 ms). It stays unwritable because the app's
own git, outside the sandbox, would follow what it says.

### Edit mode (L3)

The desktop makes the worktree before launch, outside the sandbox
(`git -C <repo> worktree add -b dial8/<slug>-<jobShort> ~/.dial8/worktrees/<jobId> HEAD`)
and launches with `LOCAL_AGENT_FOLDER=<worktree>`, `LOCAL_AGENT_MODE=edit` and
`LOCAL_AGENT_EXTRA_READ=<repo>/.git`. The profile then adds:

- `(allow file-write* (subpath <worktree>))`, followed by a deny of the
  worktree's `.git` entry in any letter case (`\.[Gg][Ii][Tt](/.*)?`: APFS is
  case-insensitive), so the link that points git at the repository can't be
  written, removed, renamed or replaced, and a deny of any `.app` bundle
  anywhere in the worktree (a program the person could open outside the
  sandbox);
- `<repo>/.git` as ONE extra read-only root, so git can read objects and refs.
  The repository's own working tree stays unreadable, and nothing under `.git`
  is writable, so `git add`, `git commit`, `git branch` and `git checkout` of
  another branch fail with "Operation not permitted"; `git status`, `git diff`
  and `git log` work.

The provider accepts `extraRead` only in edit mode, and edit mode only with
it. It must be a realpath, a directory named exactly `.git`, grantable,
apart from the folder, and the directory the worktree's `.git` FILE points
into (`gitdir: ...`), which also refuses edit mode on the person's own
checkout (whose `.git` is a directory). The file methods refuse `.git` before
anything runs; the kernel refuses it too. The checkpointed state gains
`extraRead`, and a resume must be launched with the same one.

On `finish` the desktop commits, outside the sandbox
(`git add -A`, then `git -c core.hooksPath=/dev/null commit -m <first line of
the summary> --allow-empty`) and emits a `branch` event. The agent's
instructions say so: make the changes, don't commit, describe them in
`finish`, first line = the commit message. Nothing is pushed.

### Native prompts and fence grants (C3)

`launcher/prompts.ts` is both halves of contract C3 (`docs/plans/teammate-agent.md`).
The launcher writes `{"type":"prompt","id","kind":"push"|"fence","detail"}`
and reads `{"type":"prompt_answer","id","allow"}`; the desktop shows a native
alert and answers each id exactly once (closing it, quitting or the launcher
exiting first is a no). It keeps one prompt open per job, so the broker sends
one at a time and holds the slot until the answer comes, or 60 s past the
prompt's timeout. Every ask has a timeout (5 minutes by default, 10 s to 30
min) that counts as no; each prompt carries what is left of it as
`detail.timeoutMs`, and the desktop takes it as given, closing the alert and
answering no at that moment, so both deadlines match. A queued prompt with
under 10 s left is never shown. An answer after the timeout never acts: it is dropped and
logged. Tools in the eve server ask with
`askPerson(kind, detail)`, over a socketpair the launcher's spawn adds as the
server's fd 3 (`LOCAL_AGENT_PROMPT_FD=3`). The server can only ask.

A fence grant is `requestFenceAccess({ path, access: 'read', reason })` in
`lib/host-folder-sandbox.ts`. **Fence grants are read-only** (C3,
2026-10-21): an edit job writes only in its own worktree, and a write grant
elsewhere could reach code that runs outside the sandbox later (a sibling
repo's hook config, files the shell sources, git config programs, other `.app`
bundles). A `write` request is refused before anything is asked, the prompt
module never shows one, and the profile refuses a write grant.

It resolves the path (it, or a new entry in a folder that exists), refuses
before asking what can never be granted (`fenceGrantRefusal`: outside the
folder rules, a hidden folder at HOME's top, `~/Library` except iCloud Drive,
the scratch dir, and where a credential or settings entry of HOME really
lives: a symlinked hidden entry (`~/.ssh -> ~/Dropbox/ssh`), each entry of the
credential folders (`.ssh`, `.aws`, `.gnupg`, `.docker`, `.kube`,
`.config/{gh,git,github-copilot,gcloud,stripe}`, `.codex`, `.cargo` except its
toolchain dirs, `.local/share`), and every `IdentityFile` / `CertificateFile`
that `~/.ssh/config` and its `Include`s name (parsed as OpenSSH does: quotes,
escapes, `${HOME}`, globs in any component; a path with another `%` token or
`${VAR}` protects the folder before it, at its real place too); with every dir
above one of those). The lists are `protectedPaths`, computed on the Mac, never
from the job. The profile also denies reading those places outright, even
inside the job's own folder: a person who picks `~/Dropbox` while
`~/.ssh -> ~/Dropbox/ssh` still keeps the keys out of the job. The write rules (outside HOME, `.git`, `<name>.git`, `.husky`, `.app`, the
tool PATH, git, gh, ssh, the shell, the agent's code, `.app` and
`node_modules`, the real places of dotfiles and git includes) stay in
`fenceGrantRefusal` as defense in depth, and any write ends refused. It answers
yes without asking for a path already readable, and otherwise asks. On yes,
every later command of the job runs in a new runner whose profile reads the
path; the file methods follow. Commands already running keep their sandbox
until the stop reaps both. Grants live in the eve server's process: a relaunch
starts without them, and the agent asks again (the desktop answers a path it
already allowed in this launch without asking).

When a toolchain home under HOME is a symlink (`~/.cargo -> ~/toolchains/cargo`),
the credential denies are anchored on its real place too, so
`credentials.toml` can't be read there through a grant of the folder holding
it.

## Launcher protocol (L0 contract §1)

The desktop spawns `<node 24> <LOCAL_AGENT_DIR>/launcher/launcher.ts` with
cwd = `<app_data>/local-agent/jobs/<jobId>/` and an environment built from
scratch: `HOME`, `TMPDIR`, `LANG`, `PATH`, `LOCAL_AGENT_JOB_ID`,
`LOCAL_AGENT_FOLDER` (realpath), `LOCAL_AGENT_MODE` (`read` | `edit`),
`LOCAL_AGENT_TOOL_PATH`, `LOCAL_AGENT_DIR`, in edit mode
`LOCAL_AGENT_EXTRA_READ` (`<repo>/.git`), optionally `LOCAL_AGENT_API_ORIGIN`
(the app's origin, for C1; otherwise the relay URL's origin is used), and for
the model one of:
- `LOCAL_AGENT_MODEL_BASE_URL` + `LOCAL_AGENT_MODEL_TOKEN` (the relay; Rust
  builds the URL from the app's own origin);
- a model on the Mac (L4): `LOCAL_AGENT_LOCAL_MODEL_BASE_URL` (127.0.0.1 or
  [::1]) + `LOCAL_AGENT_LOCAL_MODEL_ID` (+ `LOCAL_AGENT_LOCAL_MODEL_SERVER`,
  `ollama` | `lmstudio`; there is no context variable: `lib/model.ts` reads
  the context the server loaded the model with), passed to the server as they are, with `LOCAL_AGENT_MODEL_TOKEN`
  for C1 only when the server minted one, and never a relay URL or a dev key;
- in dev only, `LOCAL_AGENT_DEV_ENV_FILE` (the launcher reads only
  `AI_GATEWAY_API_KEY` from it).

One half of a pair without the other is fatal, and so is a local-model run
with a relay URL or a dev key: a half-configured route never falls back to
another. The job dir must not overlap the folder or `.git` (it holds the token).

The server's environment is built from scratch too: the grant, the model's
variables, `DIAL8_AGENT_HOST=mac` (eve imports each module again at runtime,
and it must pick the Mac host as the build did), the token file's path as
`LOCAL_AGENT_SESSION_TOKEN_FILE` (C1) and, in relay runs, as
`LOCAL_AGENT_MODEL_TOKEN_FILE` (the model), `LOCAL_AGENT_API_ORIGIN` when set,
and `LOCAL_AGENT_PROMPT_FD=3` for the C3 prompt channel.

### The model and token refresh

The relay token never enters the eve server's environment. The launcher
writes it to `<job dir>/.model-token` (mode 0600, a temp file then `rename`,
so a reader never sees half a token) and gives the server only
`LOCAL_AGENT_MODEL_BASE_URL` and `LOCAL_AGENT_MODEL_TOKEN_FILE`. `lib/model.ts`
builds `createGateway({ baseURL: <relay>, apiKey: <placeholder>, fetch })`;
the `fetch` reads the file on EVERY request, puts it in `Authorization: Bearer`,
and refuses any URL outside the relay base. A refresh is one stdin line,
`{"type":"token","modelToken":"..."}`: the launcher rewrites the file at once
(not queued behind a running start or send), and the next model request
carries the new token; so do the next spec and tool calls to the app (C1),
which read the same file. No restart, nothing to signal, and a request already in
flight keeps the token it was sent with. Sandboxed commands can't read the
file: the job dir is under the app's data in `~/Library`, inside the HOME
read-deny. The file is removed when the launcher exits. In dev the same
provider reads `AI_GATEWAY_API_KEY` from the server's environment.

**On the person's own ChatGPT plan** (the free tier,
`docs/plans/chatgpt-free-tier.md`): the relay mints the model token with a
`cp: true` claim when the person runs on their plan (`chatgptPlanFor` at claim
and at every refresh, the plan check read twice before it counts as no plan).
Every step `lib/model.ts` reads the claim from the token file (without the
key: it only picks the route) and, when set, uses an OpenAI Responses model,
`gpt-6.1-sol` (the plan's main model, at medium reasoning), against
`<base>/plan`, through the same `relayFetch`. Its calls go to `<base>/plan/responses`; the relay
checks the token and the live session, opts in to the plan's usage check, and
hands the call to `src/lib/chatgpt/plan-proxy.ts`, which calls OpenAI with the
person's own plan token. Nothing reaches the Gateway; the calls are metered at
$0 under `chatgpt-plan`. The relay's Gateway path still refuses a free user
whatever the token says. A refresh that gains or loses the claim moves the
job's next step to the matching route (a plan check that failed at claim, a
person who subscribed). The relay meters and frees its slot in `after()`, once
the call settles however the stream ends (its end, an upstream error, the
Mac cancelling).

Why a step selection (`agent.ts`: `defineDynamic`, `step.started`), not a
static model: eve compiles a static model's settings into the build's manifest
from the BUILD's environment (no relay: the dev Gateway model) and at runtime
takes only the LanguageModel object from `agent.ts`. The plan's `store: false`
would never reach a call, and without it the SDK sends a step's earlier items
as references to responses the plan route never stored: the second step of
every tool-using turn would fail. A step selection is resolved in the running
server with its own window and options (session and turn selections must be
model-id strings, which can't name the relay's base URL). `agent.ts` builds it
once at load, so a half-configured relay still fails the server's start.
Gateway model calls go to `<base>/language-model` with the
`ai-language-model-id` header; plan calls go to `<base>/plan/responses` (in
the relay test below, that was every request each provider made).

The launcher refuses an `.output` without the Mac build's host marker
(`.output/dial8-host.json`, `{"host":"mac","localModel":…}`, written by
`mac-body.sh`), and a local-model launch on a build without `localModel: true`.
It generates the secret, picks a free port, and starts
`.output/server/index.mjs` as a **child process** with cwd = the job dir
(eve keeps `.eve/.workflow-data` there) and only the variables it needs. It
waits for `/eve/v1/health`, checks the request guard and that the server's
channel refuses a session request without the secret (401), then drives the
server with `new Client({ host, auth: { bearer }, redirect: 'error' })`.

Child, not in-process: the server's environment stays separate from the
launcher's; the tripwire refuses a non-literal `import()` (and a literal one
would drag the 9 MB bundle into the root typecheck); and a stop is a process
kill. A `--import` preload makes the server exit when the launcher's pipe
closes, so a launcher killed outright leaves no server behind. Measured on
this Mac (M-series, macOS 27.0.1, Node 24.18.0), the Mac body on 2026-10-21:
**spawn → `ready` 680–750 ms**; **RSS ≈ 230 MB for the eve server and ≈ 160 MB
for the launcher** (≈ 80 MB as the bundle's esbuilt `launcher.mjs`). The old
single-purpose agent measured 690–720 ms and ≈ 200 + 150 MB.

stdin → launcher, one JSON object per line:

```
{"type":"start","request":"<text>"}
{"type":"resume","sessionId":"<id>","streamIndex":<n>}
{"type":"send","text":"<text>","policy":"steer"|"queue"}
{"type":"stop"}
{"type":"token","modelToken":"<token>"}   printable ASCII, no spaces, 16–2048 chars; jobs launched with a token (ignored otherwise)
{"type":"prompt_answer","id":"<id>","allow":<bool>}   C3: the person's answer to a native prompt (launcher/prompts.ts)
```

launcher → stdout:

```
{"type":"ready","port":<n>,"eveVersion":"0.79.1"}
{"type":"session","sessionId":"<id>","streamIndex":<n>}
{"type":"cursor","streamIndex":<n>}      only at turn boundaries, written BEFORE the boundary's status
{"type":"event","event":<NormalizedEvent>}
{"type":"fatal","message":"<text>"}      then exit 1
{"type":"prompt","id":"<id>","kind":"push"|"fence","detail":{…}}   C3: show a native prompt (launcher/prompts.ts)
```

`NormalizedEvent.kind`: `status` (`starting|running|waiting|completed|failed|cancelled`),
`text` (delta), `message` (completed assistant text), `tool` / `tool_result`
(input cut to 2 KB, output to 4 KB, as JSON strings), `ask` (eve's own input
requests), `finish`, `error`. A call to `finish` produces ONLY its own event,
never `tool` / `tool_result`. The teammate tools (`report_to_person`,
`message_teammate`) are ordinary `tool` events: the server writes the thread
and the ledger from the call itself. `report` stays in the protocol for older
bundles; the Mac body never sends it. `waiting` = the turn ended and
the agent is idle. After a cancel the session's `waiting` is not reported, so
the job stays `cancelled`.

stdin is framed on `\n` only (readline would also split on U+2028/U+2029),
and output lines escape U+2028/U+2029. The launcher takes an exclusive flock
on `<cwd>/.launcher.lock` (open(2) `O_EXLOCK`, so the kernel drops it if the
launcher dies); a second launcher for the same job prints
`{"type":"fatal","message":"job already running"}` and exits 1.

Behaviour: the stream is deduped on `meta.id`; a reader runs from a send to the
turn boundary, and reads on past it while a message we sent (a steer that raced
the end of the turn, or a queued one) has not reached a turn yet (tracked by
delivery id). `resume` attaches at the saved cursor, catches up, and either
reports `waiting` or follows a turn that ran on. `stop` cancels the running
turn, waits for its boundary (≈2.3 s at most, under the desktop's 5 s SIGTERM)
and exits 0. stdin EOF or SIGTERM (the app quitting; the desktop SIGKILLs the
group at 2.6 s) cancels for ≈1.0 s, kills every process below the eve server,
gives the server ≈0.6 s, and is gone in ≈2 s. Commands that left that tree are
the sandbox's to stop (each job's runner reaps inside its own sandbox); the
launcher no longer reads eve's job pid files, which sandboxed commands can
write, so they can't name a process for it to kill. A terminal eve outcome
(`session.completed` / `session.failed`) is reported and the launcher exits
(0 / 1 with a `fatal`), so no idle launcher holds a job slot. After `resume`,
an idle session always reports `waiting`.

## Known risks

- **A command that deliberately finds and kills the reaper, then the runner**
  (both in its own sandbox, so allowed), and then leaves its process group,
  can still outlive stop: with no member left to send SIGKILL to -1 from
  inside, nothing names its sandbox. Its blast radius is what the kernel fence
  leaves it (read the grant, no network, writes only in its scratch dir, no
  signals outside its sandbox). Daemons that merely `setsid` or double-fork
  (sccache, a dev server) are reaped, and so is everything when the runner
  alone dies.
- **The launcher still kills the pgids in eve's `.eve/jobs/<id>/pid` files**
  at teardown (`killJobProcesses`, owned by launcher.ts). The job can write
  those files, so a command can name any of the person's process groups for the
  unsandboxed launcher to SIGKILL. The reap covers those jobs, so that part can
  go (flagged to WS-B). Killing the runner's group there is harmless: its
  reaper reaps.
- System paths a toolchain needs stay readable (`/usr`, `/opt`, `/Library/Developer`,
  Xcode...), and what a command reads can reach the model. Paths outside the
  list need a fence prompt. A toolchain outside the list (`/Applications/Foo.app`
  not on the tool PATH, a JDK outside `/Library/Java`) doesn't run until it is.
- **A read grant shows the model what it reads.** Credentials are kept out
  (the credential folders' real places, ssh keys and certificates), but a
  granted folder's own files reach the model, the same as the job's folder.
- **Edit mode reads the repository's whole `.git`**, including `.git/config`,
  which can hold a remote URL with a token in it. Read mode on the same folder
  already read it; git needs the config to work.
- **Edit mode runs the project's code.** The worktree is writable and
  executable, so the agent can write and run scripts, tests and builds there.
  They keep the same fence (no network, no writes outside the worktree and
  scratch, HOME unreadable).
- **The desktop's commit runs outside the sandbox on files the agent wrote.**
  Hooks are off (`core.hooksPath=/dev/null`), and nothing that makes git run
  code (config, `config.worktree`, hooks, the `.git` link) is writable from
  the sandbox. A `.gitattributes` the agent writes can only name filters that
  config defines.

## Build, test, smoke

```bash
scripts/local-agent/build.sh                  # the Mac body (mac-body.sh, DIAL8_AGENT_HOST=mac) → agents/local-agent/.output/
npx vitest run agents/local-agent             # profile, provider + edit mode (darwin: real sandbox-exec, real
                                              # git worktree), model route, launcher, relay (fake app, built Mac body)
npx vitest run agents/chat-agent              # the chat agent, cloud and Mac (lib/__tests__/mac-host.test.ts, mac-body.test.ts)
node scripts/local-agent/smoke.ts --log /tmp/l0.jsonl              # read mode (the L0 cycle)
node scripts/local-agent/smoke.ts --mode edit --log /tmp/l3.jsonl  # edit mode
```

The relay test (`launcher/__tests__/relay.test.ts`) runs the real launcher and
the built Mac body against a fake app on 127.0.0.1: C1's spec and tool routes
and a model relay that answers with canned Gateway streams (a call of the
spec's tool, then a reply). Two turns, a token line between them; it checks
the path and the Bearer of every request (relay and C1, never a shared
secret), the model id, the tool call's body, and what the model saw (the
spec's prompt with the Mac instructions, the fence's tools, no native web
tools). No model is called.

The smoke runs the dev path (no session token, so no C1): it tests the fence,
`finish` and the launcher, with the Mac instructions and no conversation prompt.
A plan token's job (the ChatGPT free tier) gets canned Responses streams on the
relay's plan path instead (`lib/__tests__/model.test.ts` and the relay route's
tests pin its `store: false` and the second step's inline items).

The edit smoke makes a temp repo, does the desktop's `git worktree add`,
launches in edit mode, asks for a README change and a new CHANGELOG.md, steers
with a `[From <name>]` message, probes a write outside and a write to `.git`,
then on `finish` does the desktop's commit and `branch` event. It checks the
change is on the branch and the original checkout (files, branch, HEAD,
status) is untouched, that the agent couldn't commit, and that the repo's
pre-commit hook didn't run.

The smoke spawns the launcher exactly as the desktop does (clean env, a job
dir, a granted folder of fixtures and a sibling holding a secret, both under
a temporary dot folder in HOME), runs start → steer mid-turn → `finish` → stop
→ respawn with `resume` → follow-up answered, and asserts from the tool results
that the write, the sibling read and the network call were refused and that
the secret never appears. It uses the model (two short turns). It reads the
key only through the launcher, from `LOCAL_AGENT_DEV_ENV_FILE` (default
`.env.local`).

## Packaging (the desktop's release build)

```bash
scripts/local-agent/bundle.sh <out-dir>    # what the desktop ships in Contents/Resources/local-agent
node scripts/local-agent/smoke.ts --agent-dir <out-dir> --node <node 24>            # the bundle, read mode
node scripts/local-agent/smoke.ts --mode edit --agent-dir <out-dir> --node <node 24>
```

`bundle.sh` builds the Mac body in a throwaway copy at `/tmp/dial8-local-agent-build`
(`mac-body.sh`), bundles the launcher with `eve/client` and `prompts.ts` inlined
(`launcher/launcher.mjs`), keeps `launcher/server-guard.ts` as is (Node strips
its types), copies `.output/`, and, when `workers/` exists, runs its
`build.sh` from the copy for `workers/<worker>.mjs` (L4). `build.sh` (dev) does
the same into `.output/workers/`.
It deletes the copy before anything reads the bundle, and refuses a bundle that
names this checkout, HOME or TMPDIR outside a comment
(`bundle-notices.mjs --scrub`), so a bundle that only worked here can't ship. It
writes `licenses/NOTICES.txt` (the npm packages the bundlers' module comments
name, and those the agent's own code imports, read from the copy with esbuild's
import graph: eve inlines that code without module comments; each with its
license texts) and `BUNDLE.json` (the web commit, whether
`agents/chat-agent`, `agents/local-agent`, `scripts/local-agent`,
`package*.json` or `tsconfig.json` had uncommitted changes or gitignored files
the build would carry, eve's version, the Node major, a SHA-256 per file, and
`capabilities`: `"workers"` when `workers/build.sh` produced the adapters,
`"local-model"` when the host marker says the build has `lib/model.ts`'s
local route, as every Mac body built from this tree does; the desktop refuses
a feature the bundle doesn't declare). The Mac body's bundle is ≈ 11 MB (2.6 MB
compressed), against 10 MB (2.5 MB) for the old agent, and carries no Supabase
client: the cloud channel and the usage meter are left out.

The desktop vendors the bundle into `src-tauri/resources/local-agent/`
(`scripts/local-agent-bundle.sh <web-checkout>` there) and downloads its Node on
first use, pinned in `src-tauri/src/local_agent/runtime.json`. A change to the
agent therefore ships with a desktop release: rebuild the bundle there, commit it,
release.

## End-to-end runs (L1)

Two scripts, from the web repo root, with Node 24:

```bash
# The Mac half, no database: the real relay core + the real launcher, driven
# by a fake Rust (its own process) against the real server library on the
# unit tests' in-memory DB. --fake-model swaps in a scripted model and a C1
# stand-in on the same origin (no spend).
npx tsx scripts/local-agent/e2e-device.ts --fake-model
npx tsx scripts/local-agent/e2e-device.ts [--only A|B] --log /tmp/l1-e2e-device.jsonl   # real model: the key from LOCAL_AGENT_DEV_ENV_FILE (default .env.local)

# The whole chain on DEV (after migration 410 is applied there): a real chat
# turn, the real routes and model relay on next dev :3001, the headless relay,
# the real launcher. Check the guard and config first (no DB, no network):
npx tsx scripts/local-agent/e2e-dev.ts --dry-run
npx tsx scripts/local-agent/e2e-dev.ts --start-next --log /tmp/l1-e2e-log.jsonl
```

`e2e-dev.ts` refuses anything but DEV (`edrjddsxjoigpbecqgfb`) and any base URL
but loopback :3001. `--start-next` runs `npm run dev` on PORT=3001 for the run
and stops it after; leave it out if the app already runs there. The home-turn
check needs the Inngest dev server (`npm run dev:inngest`); without it that
check is skipped. `--chat-fallback` starts the local agents through the chat
tool route instead of real chat turns. It uses the fixture person
`local-agent-e2e@dial8-evals.test` and leaves its DEV rows in place (the
summary lists their ids). Both scripts print a step table (PASS, FAIL, SKIP,
KNOWN-BUG) and write a redacted JSONL log.
