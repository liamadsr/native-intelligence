# coding-agent

The eve sandbox agent that runs Native Intelligence's **cloud coding runs** (Phase 3 —
`docs/plans/eve-phase3-coding-runs.md`). It is the ONLY cloud coding-run runtime,
and it serves both origins — action-origin runs ("Start" on an assigned action) and flow-origin runs
(a `run_agent` flow action with no triggering action, whose repo / persona / task
live on the `agent_run` row). One spec build (`src/lib/agent-run/spec-rebuild.ts`)
serves both the dispatcher's precondition guard and the internal spec route.

## The eve agent IS the coder

There is no coding CLI and no `bypassPermissions`. The model itself does the
work through eve's default **harness tools**, which bind to the authored sandbox:

| Tool | Status | Why |
| --- | --- | --- |
| `bash`, `read_file`, `write_file` | **LIVE** (eve defaults) | This is the coder — it edits the cloned repo in `/workspace`. |
| `glob`, `grep` | **not registered** | eve dropped them from the default set in 0.39.0. They are now opt-in (`export { glob as default } from 'eve/tools/glob'`); neither file exists, so neither tool is advertised. Searching happens through `bash` (`rg`, `find`). |
| `finish_run` | LIVE (authored, terminal) | The ONLY way to end a run: POSTs the outcome; the system opens the PR. |
| `post_progress` | LIVE (authored) | Appends to `log_tail`; its response carries the cancel signal. |
| `web_search` | **LIVE**, pinned to Exa | Web access is an always-on capability of every Native Intelligence agent. An unattended run that hits an unfamiliar API or an opaque error has no one to ask — its only other options were guessing or failing. Provider-executed, so it does not touch the sandbox network policy. |
| `web_fetch` | **LIVE**, guarded wrapper | Doc/changelog lookup. Wraps eve's built-in with the SSRF url-guard (`lib/url-guard.ts`) and a per-session abuse cap (`lib/web-fetch-cap.ts`). Runs in the APP runtime, **not** the sandbox: it cannot read or write `/workspace`, and it is not a hole in the sandbox network policy. |

The tool surface is entirely structural: what the agent may do is bounded by the
authored tools + the guarded wrappers, nothing prose-only. `lib/__tests__/harness-lockdown.test.ts`
pins it — including the inverse-of-the-other-agents invariant that no
`disableTool()` file appears at `bash`/`read_file`/`write_file`, since removing
the coding surface is exactly what this agent must never do silently.

## Trust model

- **Internal-only.** Never browser-driven. Dispatched server-to-server from the
  Next app's Inngest eve branch. Auth (`channels/eve.ts` + `lib/auth.ts`):
  constant-time shared secret (`AGENT_RUN_INTERNAL_SECRET`, falling back to
  `RUN_SKILL_INTERNAL_SECRET`), then Vercel OIDC, then localDev.
- **Tenancy from the token, never the model.** The dispatch mints an HMAC-signed
  run token `{ agentRunId, workspaceId, userId, exp }`. The model resolver, the
  dynamic instructions, the sandbox selector, and both tools read that
  token off the verified session principal and call the Next app's internal
  routes with it (`/api/internal/agent-run/{spec,event,outcome}`), which
  re-verify the HMAC and rebuild everything server-side from live DB state. The
  model can never name a repo, branch, workspace, or token.
- **Safety boundary** = sandbox isolation + the sandbox network policy + the
  scoped terminal tools + the per-session output-token cap
  (`maxOutputTokensPerSession`, the token-budget analog of the legacy wall-clock
  timeout). No HITL approvals in v1. Reading a public doc page is not part of that
  boundary: `web_search` runs at the provider and `web_fetch` in the app runtime,
  so neither can reach the sandbox or widen what the repo's own build/test
  commands may contact.

## Sandbox

`sandbox.ts` (eve 0.64+ provider-environment model: an exported `environment`
plus a `defineSandbox()` selector that runs once per session until it succeeds).
The selector opens the session sandbox with the network policy mapped from the
run's `networkAccess` applied AT CREATION (`restricted` → exactly
`RESTRICTED_ALLOW_HOSTS` — GitHub + the npm registry — the single source of truth
for that tier; `trusted` → allow-all; `isolated` or unknown → `github.com` only;
every tier also allows the app's git gate; no spec → `deny-all`). The run's
GitHub token never reaches the sandbox (the spec doesn't carry it): every
clone, fetch, LFS request and push goes to the app's git gate on its public
origin (`/api/internal/agent-run/git`: `src/lib/agent-run/git-read-proxy.ts`
serves the run's repo for reads, `git-push-proxy.ts` pushes only the run's own
branch), which adds the GitHub token server-side. The gate takes one
credential, the run's git gate token: on the hosted sandbox the firewall
injects it on the gate's six exact endpoints (no protection-bypass secret), and
github.com carries no credential. Then it clones `repoFullName` @ `baseBranch`
into `/workspace` from the gate URL (also the push URL and the `lfs.url`
base), creates `branchName`, provisions the linked cloud
environment's `envVars` (reserved proxy/TLS/token names stripped; written to
`~/.dial8_env` and sourced from `~/.profile`, any existing `~/.bash_profile` /
`~/.bash_login`, and `~/.bashrc`, because eve runs commands with `bash -lc`, a
non-interactive login shell that never reads `~/.bashrc`; the setup run sources
it directly), and runs `setupScript` (non-fatal on failure). A lost Vercel sandbox is
never silently replaced: resume fails instead of recreating it without the
policy. Provider: a dedicated `VercelSandbox` environment on the hosted sandbox
service (the only place the allow-list and the firewall-injected gate token
are enforced); eve's `DefaultSandbox` (Docker → microsandbox → just-bash)
otherwise, where the policy carries no credential: the clone gets the git gate
token as a one-shot env, then it sits in the repo's git config for the gate URL
only; a local sandbox must be able to reach the app even to clone (there is no
fallback that clones from GitHub directly).

### What the push gate guarantees, and what it doesn't

No push from the sandbox can move any ref but the run's own `dial8/…` branch:
the sandbox holds no GitHub credential at all, and the gate refuses
every other ref, deletes and push options. What the gate does NOT stop (residual risk, the owner's call; nothing is built for it): a pushed `dial8/…` branch can change what the repo's existing CI runs on that branch (package.json scripts, tests, build config). The owner's token has no `workflow` scope, so the run can't edit `.github/workflows` itself. But on a repo whose Actions `GITHUB_TOKEN` can write (`default_workflow_permissions: write`, or a workflow with `contents: write`) and whose workflows run on `push` or `pull_request`, such a workflow could run the branch's code with that write token and push the default branch itself. A ruleset or branch protection on the default branch, or read-only workflow permissions, closes it.

## Configuration

Set `AGENT_RUN_INTERNAL_SECRET` (it falls back to `RUN_SKILL_INTERNAL_SECRET`, so
keep that one too). There is no runtime flag: every cloud coding run is an eve run.
Without either secret, `agentRunExecute` fails each run with a clear
"not configured" reason instead of dispatching.
