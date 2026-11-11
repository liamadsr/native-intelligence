/**
 * Authored sandbox for the coding-agent (Phase 3).
 *
 * This is what makes the eve agent an actual coder: the harness bash/read_file/
 * write_file tools bind to THIS sandbox, which we seed with the target repo
 * cloned onto the working branch. It is the ONLY cloud coding-run sandbox.
 *
 * ── eve 0.64+ provider-environment model (node_modules/eve/docs/sandbox/*) ──
 * A sandbox module exports ONE `environment` (prepared at `eve build`, before any
 * session exists) and default-exports a `defineSandbox()` SELECTOR. The selector
 * runs on the first sandbox access of a session and "runs until initialization
 * succeeds, then eve checkpoints the selected provider and its state. Later
 * workflow steps and process restarts call the provider's resume() directly
 * without rerunning the selector or environment.open()". Everything per-run
 * (network policy, the git gate credential, clone, setup script) therefore
 * happens here, once, inside the selector.
 *
 * ── WHERE THE SANDBOX RUNS ──────────────────────────────────────────────────
 * On Vercel Sandbox (the "hosted sandbox" below) whenever it can log in: on
 * Vercel with the deployment's own credentials, and off Vercel (the app's own
 * server) when SANDBOX_ACCESS_TOKEN, SANDBOX_TEAM_ID and SANDBOX_PROJECT_ID are
 * set: all three are then handed to eve's VercelSandbox environment, which eve
 * passes to every Sandbox.create/get/delete (bindings/vercel-credentials.js) and
 * keeps out of the sandbox name, the session state and the prepared artifact
 * (bindings/vercel.js vercelIdentityOptions). They log the APP in to the
 * service; nothing of them enters the sandbox. Everything below that says "on
 * Vercel" holds for that mode too: the selector cannot tell the two apart. Only
 * with none of the three set off Vercel does eve's DefaultSandbox run (the "OFF
 * VERCEL" section). eve prepares the snapshot at `eve build`, so the build must
 * see the same three (deploy/app/build-agents.sh).
 *
 * ── EGRESS: WHY THIS IS ENFORCED, NOT ASSUMED (the security-critical part) ──
 * On Vercel the selector opens the session sandbox with
 * `environment.open({ networkPolicy })` on a DEDICATED `VercelSandbox`
 * environment. Proven from eve 0.66.3's provider source
 * (dist/src/execution/sandbox/bindings/vercel.js), not from prose:
 *   1. The prepared environment is snapshot-backed (VercelSandbox.environment()
 *      routes through createVercelSandboxProvider, which never skips snapshot
 *      preparation), so `createSessionCreateParams` passes the open options —
 *      INCLUDING `networkPolicy` — into the Vercel `Sandbox.create()` call
 *      itself. The policy is in force from the sandbox's first instruction;
 *      there is no allow-all window before a later setNetworkPolicy (the
 *      pre-0.66 flow had one: use() then setNetworkPolicy). CAVEAT: this rests
 *      on the prepared artifact carrying a snapshot id. eve's no-snapshot
 *      branch creates `allow-all` and narrows afterwards. For THIS environment
 *      prepare() either returns a snapshot id or throws (it has no
 *      skip-empty-preparation shortcut), so that branch is unreachable here —
 *      pinned against eve's code in the contract test, but only a live preview
 *      run confirms the snapshot path on Vercel itself.
 *   2. The sandbox NAME is derived from the session id + the open options, so a
 *      reused same-name sandbox was created with this exact policy.
 *   3. `resume()` only reconnects: if the named sandbox is gone it THROWS
 *      ("Vercel sandbox session ... no longer exists") instead of recreating a
 *      replacement. This closes the pre-0.64 provider-loss gap, where a same-key
 *      replacement skipped onSession and came up with the backend default
 *      (allow-all, no brokering) policy.
 *   4. The record-form policy is Vercel's documented allow-list: "All traffic not
 *      explicitly allowed is denied" (compiled @vercel/sandbox network-policy.d.ts).
 *      `restricted` → exactly RESTRICTED_ALLOW_HOSTS, no "*" catch-all.
 * The environment also carries a `deny-all` baseline. It is NOT a general
 * fail-closed guarantee: eve merges open() options OVER the environment's
 * (`{ ...environment, ...open }`), so an explicit `networkPolicy: undefined`
 * would REPLACE deny-all with "unset" — which @vercel/sandbox treats as full
 * internet access — and the no-snapshot branch ignores the baseline entirely.
 * The baseline only covers opens where the key is ABSENT (e.g. eve's own
 * inheritance path) on the snapshot-backed provider. The real guard is in
 * openSessionSandbox: every open goes through requireDefinedNetworkPolicy.
 * (All of the above is pinned against eve's real provider code in
 * lib/__tests__/eve-vercel-provider-contract.test.ts.)
 *
 * ── GIT: ALL OF IT THROUGH THE APP'S GIT GATE. NO GITHUB CREDENTIAL HERE ───
 * The run's GitHub token (the triggering person's, repo scope: it can write
 * every branch, the live (default) one included) never reaches the sandbox:
 * not in a command, an env, a file, git's config or the network policy. The
 * spec this module is served does not even carry it. Every git request of the
 * run goes to the app's git gate (`<the app's public origin>/api/internal/
 * agent-run/git`, gitGateUrl), which reads the run from the database, adds
 * the GitHub token server-side, and forwards to the run's repo on GitHub:
 *   - READS (src/lib/agent-run/git-read-proxy.ts): the clone's remote IS the
 *     gate URL (`git clone … <gate URL> .`), so the clone and every later
 *     fetch go there, and `lfs.url` is `<gate URL>/info/lfs`, so git-lfs's
 *     batch and lock-check requests do too. The gate serves only the run's
 *     repo, only while the run is live. ACCEPTED: its LFS batch endpoint also
 *     answers `upload` batches (see git-read-proxy.ts); the LFS objects
 *     themselves move between the sandbox and GitHub's LFS storage on the
 *     short-lived links in GitHub's batch answer (*.githubusercontent.com).
 *   - PUSHES (src/lib/agent-run/git-push-proxy.ts): the push URL is the same
 *     gate URL (the remote's URL, and `remote.origin.pushurl` pinned to it
 *     too). The gate refuses every ref update but `refs/heads/<the run's
 *     branch>` (no deletes, no other branch, no tag), and only then pushes.
 * The gate takes ONE credential, the run's git gate token (spec.gitPushToken,
 * src/lib/agent-run/git-push-token.ts). It opens nothing on GitHub and nothing
 * else of the app, and only while the run is live: it can do no more than the
 * run itself may (read its repo, push its own branch). How it reaches the gate:
 *   - THE HOSTED SANDBOX (`credentialBrokered`): the firewall injects it on
 *     the gate's six exact endpoints, each with its method (gitGateRules), and
 *     on no other request. It is in no command string (eve's Vercel binding
 *     sends each command as `runCommand({cmd:'bash', args:['-lc', command],
 *     env})`, and Vercel records the command AND its env), no env, nothing in
 *     /workspace or git's config.
 *   - ANY OTHER PROVIDER: no firewall credentials at all (eve 0.66.3's
 *     microsandbox binding keeps a rule's `match` but never applies it, so a
 *     rule's credential would ride every request to its host, and it stores
 *     the policy, transforms included, on host disk). So the policy only
 *     narrows egress; the clone gets the gate token as a one-shot
 *     GIT_CONFIG_* env (there is no repo yet to hold it), and right after the
 *     clone it goes into the repo's git config as an extra header for the gate
 *     URL only, where later fetches, LFS and pushes find it. ACCEPTED: the
 *     model can read it there; it can do no more with it than the gate allows.
 *     It is in no command string either way.
 * A plain `git push` works; `git push https://github.com/…`, `--no-verify`,
 * `git send-pack` or raw HTTP to GitHub all arrive anonymous: the sandbox has
 * no GitHub credential to send. (github.com stays in every tier's allow-list,
 * with no rule: what reaches it goes out anonymous.) There is no fallback that
 * clones from GitHub directly: a gate the sandbox can't reach fails the clone.
 * The `pre-push` hook (prePushGuardScript) stays as the friendly first answer
 * (the run's own branch, no deletes, no force), but nothing rests on it now.
 * TENANCY: the repo, branch, gate token, and env all come from the spec REBUILT
 * server-side from the verified run token on the session principal
 * (`session.auth`) — never from model input. The model cannot name a
 * repository, a branch, or a token. The git gate re-reads the run's repo and
 * branch itself, so even the spec isn't trusted for what a clone may read or
 * a push may update.
 *
 * ── OFF VERCEL, WITHOUT THE HOSTED SANDBOX'S SETTINGS ──────────────────────
 * The provider is chosen from `process.env.VERCEL` (as eve's own DefaultSandbox
 * chooses) and the three settings, read when the module loads, at `eve build`
 * and at runtime alike; deploy/app/entrypoint.sh refuses to start an agent whose
 * build chose differently. Without them we use DefaultSandbox (Docker, else microsandbox, else just-bash),
 * whose typed handle hides provider capabilities, and apply the same policy
 * through the provider's setter (egress only, no credentials: see above):
 * microsandbox (the provider `eve info` reports on a Docker-less Mac; a root
 * devDependency so eve never auto-installs it) accepts domain policies, while Docker rejects the
 * record form (coarse allow-all/deny-all only) and just-bash has no setter.
 * When the policy cannot be applied:
 *   - a `restricted` or `isolated` run FAILS CLOSED (the selector throws, eve
 *     deletes the sandbox, the run fails) — UNLESS eve's dev signal is set
 *     (`EVE_DEV=1`, which `eve dev` and eve/next's dev sidecar set) AND this is
 *     not an eval (`EVE_EVALUATION=1`, which `eve eval` sets before it starts
 *     its local dev server — that server inherits EVE_DEV=1 too). Only an
 *     interactive dev session degrades to unrestricted egress, with a progress
 *     beat. A self-hosted build, CI, or a local `eve eval` never runs a
 *     narrowed run with open egress.
 *   - a `trusted` run already asks for allow-all egress; it proceeds with a
 *     beat, and clone/fetch/push use the "any other provider" gate token path
 *     described above.
 *     (Outside eve dev the beat names the three settings: a container whose
 *     sandbox is just-bash cannot run git at all.)
 *   - a session with NO spec asks for `deny-all`; off Vercel that is applied
 *     through the setter too, best-effort (a failure is logged and beaten, and
 *     the sandbox has nothing to clone and no credential in it either way).
 */
import {
  DefaultSandbox,
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxNetworkPolicy,
  type SandboxSession,
} from 'eve/sandbox'
import { VercelSandbox } from 'eve/sandbox/vercel'
import {
  fetchEveSpec,
  gitGateUrl,
  postEvent,
  runTokenFromAuth,
  type EveSpec,
} from './lib/spec-client.js'

/**
 * The `restricted` allow-list — the SINGLE source of truth for what a
 * `restricted` cloud environment lets sandbox commands reach (the Settings ▸
 * Environments helper text describes exactly this list; keep them in step):
 *   - github.com          — reachable, with no credential on any request (the
 *                           run's own clone, fetch and push go through the
 *                           app's git gate, below)
 *   - api.github.com      — anonymous REST reads build tooling makes (release
 *                           lookups); the PR itself is opened server-side by the
 *                           outcome route, never from the sandbox
 *   - *.githubusercontent.com / codeload.github.com — git archives + LFS + raw
 *   - registry.npmjs.org  — npm install (the most common setup-script fetch)
 * Every tier ALSO allows the app's public host (gitGateUrl), for one reason
 * only: the git gate, the only place a clone, fetch or push can authenticate.
 * buildNetworkPolicy adds it per run (it is not in this list), and the gate
 * token rides only the gate's six exact endpoints. Nothing else of the app is
 * open to the run in any useful way: there is no other credential for it.
 * WARNING: deliberately conservative. A repo that fetches from other hosts
 * (private registries, CDNs, apt) needs `trusted`. There is NO AI-gateway host
 * here: inference is eve's own concern (outside the sandbox), the agent has no
 * in-run Native Intelligence workspace access, and its web_search/web_fetch run outside the
 * sandbox too — so none of them depend on sandbox egress.
 * (lib/__tests__/network-policy.test.ts pins the exact list.)
 */
export const RESTRICTED_ALLOW_HOSTS = [
  'github.com',
  'api.github.com',
  '*.githubusercontent.com',
  'codeload.github.com',
  'registry.npmjs.org',
] as const

/**
 * The git gate token as git's HTTP Basic credential. The gate reads the
 * password and ignores the user name (extractGitPushToken); `x-access-token`
 * is only there because git and git-lfs expect a user name.
 */
function gateBasicAuth(gateToken: string): string {
  return `Basic ${Buffer.from(`x-access-token:${gateToken}`, 'utf8').toString('base64')}`
}

/** git's per-URL extra-header config key for a URL (the unbrokered path only). */
function extraHeaderKey(url: string): string {
  return `http.${url}.extraheader`
}

/**
 * The firewall rules that put the run's git gate token on the app's git gate:
 * exactly its six endpoints under the run's gate URL, each with its method,
 * and no other request:
 *   - GET  `info/refs`, only with `service=git-upload-pack` (clone/fetch
 *     advertisement) or with `service=git-receive-pack` (push advertisement);
 *   - POST `git-upload-pack` (clone, fetch) and POST `git-receive-pack` (push);
 *   - POST `info/lfs/objects/batch` (LFS batch API, download and upload) and
 *     POST `info/lfs/locks/verify` (git-lfs's pre-push lock check).
 * What each serves, and refuses, is the gate's (git-read-proxy.ts,
 * git-push-proxy.ts). Nothing else rides along: in particular no Vercel
 * protection-bypass secret (with `x-vercel-set-bypass-cookie` it would hand
 * the sandbox a bypass cookie it could leak through its own branch); the gate
 * URL is the app's public origin, and a protected deployment refuses the
 * request (closed). The hosted sandbox only: no other provider gets a rule
 * with a credential (see this file's header).
 */
export function gitGateRules(gateUrl: string, gateToken: string) {
  const path = new URL(gateUrl).pathname.replace(/\/+$/, '')
  const transform = [{ headers: { authorization: gateBasicAuth(gateToken) } }]
  const infoRefs = (service: 'git-upload-pack' | 'git-receive-pack') => ({
    match: {
      method: ['GET'],
      path: { exact: `${path}/info/refs` },
      queryString: [{ key: { exact: 'service' }, value: { exact: service } }],
    },
    transform,
  })
  const post = (endpoint: string) => ({ match: { method: ['POST'], path: { exact: `${path}/${endpoint}` } }, transform })
  return [
    infoRefs('git-upload-pack'),
    infoRefs('git-receive-pack'),
    post('git-upload-pack'),
    post('git-receive-pack'),
    post('info/lfs/objects/batch'),
    post('info/lfs/locks/verify'),
  ]
}

/** What the network policy needs to let a run clone, fetch and push (all through the git gate). */
export interface GitEgress {
  /** The app's git gate (gitGateUrl). Its host is allowed in every tier. */
  gateUrl: string
  /**
   * The credential the hosted sandbox's firewall injects on the gate. Null on
   * any other provider: the policy then only narrows egress and carries no
   * secret.
   */
  broker: { gateToken: string } | null
}

/**
 * Map a run's `networkAccess` to a sandbox network policy. Every tier allows
 * github.com (with no rule, so no credential) and the app's git gate host
 * (clone, fetch, push); on the hosted sandbox the firewall injects the run's
 * git gate token on the gate's six endpoints. No rule in any tier carries a
 * GitHub credential: the sandbox has none.
 *
 *   - 'trusted'    → allow-all egress via a "*" catch-all.
 *   - 'restricted' → RESTRICTED_ALLOW_HOSTS + the gate's host; everything
 *                    NOT listed is denied (no "*" catch-all).
 *   - 'isolated', or any value this code does not know → github.com and the
 *                    gate's host ONLY (no npm, no api.github.com, no "*"):
 *                    the tightest policy that still lets the run clone and
 *                    push. An unknown value fails toward this bucket, never open.
 *
 * On the hosted sandbox this is a creation option; on any other provider it
 * goes through the provider's setter when there is one (see this file's header).
 */
export function buildNetworkPolicy(networkAccess: EveSpec['networkAccess'], egress: GitEgress): SandboxNetworkPolicy {
  type Rules = ReturnType<typeof gitGateRules> | []
  const gateHost = new URL(egress.gateUrl).hostname
  const gateRules: Rules = egress.broker ? gitGateRules(egress.gateUrl, egress.broker.gateToken) : []
  if (networkAccess === 'trusted') {
    return { allow: { 'github.com': [], [gateHost]: gateRules, '*': [] } }
  }
  if (networkAccess === 'restricted') {
    const allow: Record<string, Rules> = {}
    for (const host of RESTRICTED_ALLOW_HOSTS) allow[host] = []
    allow[gateHost] = gateRules
    return { allow }
  }
  // 'isolated' (and anything unrecognised): clone + push, nothing else.
  return { allow: { 'github.com': [], [gateHost]: gateRules } }
}

/**
 * Env var names a user-supplied cloud environment must NEVER set in the sandbox —
 * they'd hijack egress (proxy / TLS-bypass), retarget git or switch off the push
 * guard, or plant a GitHub credential in a sandbox that by design holds none.
 * Matched case-insensitively. (There is no gateway/MCP secret in the sandbox to
 * protect; the strip guards egress and git.)
 */
const RESERVED_ENV_NAMES = new Set(
  [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    // git: these would retarget the repo or override the push guard's hooks-path pin.
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
  ].map((k) => k.toUpperCase()),
)

/**
 * Every git env-config name (`GIT_CONFIG`, `GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`): any of them
 * could replace the hooks-path pin.
 */
const RESERVED_ENV_PREFIX = 'GIT_CONFIG'

/**
 * The fixed shell text that hooks `$HOME/<envFile>` into the startup files a
 * `bash -lc` login shell (eve's command runner) and an interactive shell read.
 * See the provisioning comment in the selector for which files and why.
 */
export function envHookCommand(envFile: string): string {
  const line = `[ -f "$HOME/${envFile}" ] && . "$HOME/${envFile}"`
  return [
    `line=${shellSingleQuote(line)}`,
    'for f in .bashrc .profile .bash_profile .bash_login; do',
    '  case "$f" in .bashrc|.profile) ;; *) [ -f "$HOME/$f" ] || continue ;; esac',
    `  printf '%s\\n' "$line" >> "$HOME/$f"`,
    'done',
  ].join('\n')
}

/** The marker line that identifies Native Intelligence's push guard. */
export const PUSH_GUARD_MARKER = '# dial8-push-guard'

/**
 * Where the guard lives, relative to the sandbox user's $HOME: outside
 * /workspace (never committed) and outside .git (a repo's own hook tooling
 * never writes there).
 */
export const PUSH_GUARD_HOOKS_DIR = '.dial8-hooks'

/**
 * The startup-sourced file that pins git's hooks path to the guard's directory
 * (hooked into the login-shell startup files the same way as USER_ENV_FILE).
 */
export const GIT_PIN_FILE = '.dial8_git'

/**
 * The repo's own client hooks the guard's directory chains to, so pinning the
 * hooks path doesn't switch off a repo's husky / lefthook / git-lfs hooks.
 * (pre-push chains from the guard itself.)
 */
export const CHAINED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'post-rewrite',
] as const

/**
 * Shell text that sets `dir` to the repo's OWN hooks directory, the one git
 * would use without our pin: the repo-local `core.hooksPath` (husky sets one),
 * else `<git-common-dir>/hooks`. A relative path is relative to the work tree
 * top, which is where git runs hooks. Never our own directory (no loop).
 */
function repoHooksDirShell(guardDir: string): string[] {
  return [
    'dir=$(git config --local --get core.hooksPath 2>/dev/null)',
    '[ -n "$dir" ] || dir="$(git rev-parse --git-common-dir)/hooks"',
    `[ "$dir" = ${shellSingleQuote(guardDir)} ] && dir=`,
  ]
}

/**
 * The git `pre-push` hook (eve-templates-lessons.md §1.4). It refuses any push
 * whose remote ref isn't the run's own branch (`refs/heads/dial8/<identifier>-
 * <run8>`), so the default branch, other branches and tags are all refused; it
 * refuses deleting that branch, any non-fast-forward update of it (a force push
 * that rewrites history; a fast-forward is allowed whatever the flags), and any
 * push to a URL other than the run's repo (a pushurl or pushInsteadOf rewrite
 * included: git hands the hook the URL it will push to). A spec whose branch
 * equals its base is refused before this is written (seedWorkspace).
 *
 * Once every ref passes, it chains to the repo's own pre-push (husky, lefthook,
 * git-lfs) with the same stdin, or, when the repo has none, git-lfs is
 * installed and the top-level .gitattributes uses `filter=lfs`, to
 * `git lfs pre-push`, so an LFS repo's objects still upload
 * (GitHub refuses a push missing them, GH008).
 *
 * WHERE IT LIVES: `$HOME/.dial8-hooks/pre-push`, and git finds it because
 * `core.hooksPath` is pinned there through GIT_CONFIG_COUNT/KEY/VALUE env vars,
 * exported from a file every `bash -lc` sources (gitHooksPinFile). Env config
 * outranks the repo's own config, so husky's `prepare`
 * (`git config core.hooksPath .husky/_`, on any npm install) no longer switches
 * the guard off; the chain still runs husky's hooks.
 *
 * WHAT THIS IS NOT: the hard stop. The model has a shell, so it can get past
 * any hook (`--no-verify`, `git -c core.hooksPath=…`, `git send-pack`, raw
 * HTTP). The hard stop is the app's push gate, the only place a push can
 * authenticate (see this file's header): it refuses every ref but the run's
 * own branch whatever the sandbox sends. This hook is the early, readable
 * answer to an honest mistake, before the pack is even sent.
 *
 * POSIX sh, with the spec values single-quoted in. An object git can't find
 * locally (someone else pushed the branch) counts as non-fast-forward: fetch,
 * then push again.
 */
export function prePushGuardScript(args: { branchName: string; remoteUrl: string; guardDir: string }): string {
  return [
    '#!/bin/sh',
    PUSH_GUARD_MARKER,
    `allowed=${shellSingleQuote(`refs/heads/${args.branchName}`)}`,
    `remote_url=${shellSingleQuote(args.remoteUrl)}`,
    'refuse() { echo "Native Intelligence push guard: $1" >&2; status=1; }',
    'status=0',
    'if [ "$2" != "$remote_url" ]; then',
    '  echo "Native Intelligence push guard: this run may only push to $remote_url, not $2" >&2',
    '  exit 1',
    'fi',
    'input=$(cat)',
    'while read -r local_ref local_sha remote_ref remote_sha; do',
    '  [ -n "$remote_ref" ] || continue',
    '  if [ "$remote_ref" != "$allowed" ]; then',
    '    refuse "refusing to push $remote_ref: this run may only push ${allowed#refs/heads/}"',
    '    continue',
    '  fi',
    '  case "$local_sha" in',
    '    *[!0]*) ;;',
    '    *) refuse "refusing to delete ${allowed#refs/heads/}"; continue ;;',
    '  esac',
    '  case "$remote_sha" in',
    '    *[!0]*)',
    '      if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then',
    '        refuse "refusing a non-fast-forward (force) push to ${allowed#refs/heads/}; fetch and rebase instead"',
    '      fi',
    '      ;;',
    '  esac',
    'done <<NI_REFS',
    '$input',
    'NI_REFS',
    '[ "$status" -eq 0 ] || exit "$status"',
    ...repoHooksDirShell(args.guardDir),
    'if [ -n "$dir" ] && [ -x "$dir/pre-push" ]; then',
    '  printf \'%s\\n\' "$input" | "$dir/pre-push" "$@" || exit $?',
    "elif command -v git-lfs >/dev/null 2>&1 && grep -qs 'filter=lfs' .gitattributes; then",
    '  printf \'%s\\n\' "$input" | git lfs pre-push "$@" || exit $?',
    'fi',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Every other client hook in the guard's directory is this one script (symlinked
 * under each CHAINED_HOOKS name): it runs the repo's own hook of the same name,
 * stdin and arguments passed through, or does nothing.
 */
export function hookChainScript(guardDir: string): string {
  return [
    '#!/bin/sh',
    '# The hook chain: run the repo\'s own hook of this name, if it has one.',
    'name=${0##*/}',
    ...repoHooksDirShell(guardDir),
    '[ -n "$dir" ] && [ -x "$dir/$name" ] && exec "$dir/$name" "$@"',
    'exit 0',
    '',
  ].join('\n')
}

/** The file that pins git's hooks path for every login shell (sourced, plain exports). */
export function gitHooksPinFile(guardDir: string): string {
  return [
    'export GIT_CONFIG_COUNT=1',
    'export GIT_CONFIG_KEY_0=core.hooksPath',
    `export GIT_CONFIG_VALUE_0=${shellSingleQuote(guardDir)}`,
    '',
  ].join('\n')
}

/** What the push guard needs to know: the sandbox $HOME, the run's branch, the bare remote. */
export interface PushGuardArgs {
  home: string
  branchName: string
  remoteUrl: string
}

const guardDirFor = (home: string) => `${home}/${PUSH_GUARD_HOOKS_DIR}`

/**
 * The fixed command that writes the guard, the chain script and its links, and
 * the hooks-path pin file. Everything travels single-quoted in the command text:
 * it holds only paths, the branch name and the bare remote URL, no secret. It
 * does NOT hook the pin file into the startup files (envHookCommand does that
 * once; re-running this to reinstall never appends a second line).
 */
export function installPushGuardCommand(args: PushGuardArgs): string {
  const dir = guardDirFor(args.home)
  const q = shellSingleQuote
  const script = prePushGuardScript({ branchName: args.branchName, remoteUrl: args.remoteUrl, guardDir: dir })
  return [
    `mkdir -p ${q(dir)}`,
    `printf '%s' ${q(script)} > ${q(`${dir}/pre-push`)}`,
    `printf '%s' ${q(hookChainScript(dir))} > ${q(`${dir}/dial8-chain`)}`,
    `chmod 755 ${q(`${dir}/pre-push`)} ${q(`${dir}/dial8-chain`)}`,
    `for h in ${CHAINED_HOOKS.join(' ')}; do ln -sf dial8-chain ${q(dir)}/"$h" || exit 1; done`,
    `printf '%s' ${q(gitHooksPinFile(dir))} > ${q(`${args.home}/${GIT_PIN_FILE}`)}`,
  ].join(' && ')
}

/**
 * Exits 0 only while the guard is what git runs on push, in a login shell like
 * every later command: the effective `core.hooksPath` is the guard's directory,
 * and its pre-push is executable and byte-for-byte the expected script (so a
 * `chmod -x`, a stub that keeps the marker, or a moved hooks path all fail it).
 *
 * Only git and POSIX sh builtins: the byte comparison is two `git hash-object`
 * ids (works outside a repo), never `cmp` / `sha256sum` / `diff`, which a
 * minimal image (Vercel's build machine, maybe the sandbox) may not have.
 */
export function pushGuardCheckCommand(args: PushGuardArgs): string {
  const dir = guardDirFor(args.home)
  const q = shellSingleQuote
  const hook = q(`${dir}/pre-push`)
  const script = prePushGuardScript({ branchName: args.branchName, remoteUrl: args.remoteUrl, guardDir: dir })
  return [
    `[ "$(git config --get core.hooksPath)" = ${q(dir)} ]`,
    `[ -x ${hook} ]`,
    `want="$(printf '%s' ${q(script)} | git hash-object --stdin)"`,
    `have="$(git hash-object ${hook})"`,
    '[ -n "$want" ] && [ "$want" = "$have" ]',
  ].join(' && ')
}

/** Drop reserved/dangerous names (case-insensitive) from the user env vars. */
export function sanitizeEnvVars(envVars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envVars)) {
    const upper = k.toUpperCase()
    if (RESERVED_ENV_NAMES.has(upper) || upper.startsWith(RESERVED_ENV_PREFIX)) continue
    out[k] = v
  }
  return out
}

/** POSIX-quote a value for safe use inside single quotes in a shell export line. */
function shellSingleQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** Fire a best-effort progress beat so sandbox setup is observable in the UI. */
async function beat(runToken: string, text: string): Promise<void> {
  try {
    await postEvent(runToken, 'progress', text)
  } catch {
    // Progress is best-effort — never let a log write abort session setup.
  }
}

/**
 * The file the cloud environment's user env vars are written to, relative to
 * the sandbox user's $HOME. Written with the provider's file API (on Vercel
 * `writeFiles`, which is not a recorded command), then SOURCED by fixed,
 * secret-free commands — so no user value ever appears in a command string or
 * a command's env (both of which Vercel records; see this file's header).
 */
const USER_ENV_FILE = '.dial8_env'

/** Cap on the stderr tail quoted in a setup failure (it reaches logs + the UI). */
const STDERR_TAIL_CHARS = 400

/**
 * Run a setup step that MUST succeed. A nonzero exit does not throw on its own
 * (eve's run resolves with the exit code), so a failed clone used to leave an
 * empty /workspace behind a "Sandbox ready" beat. This beats the failure, then
 * throws — eve deletes the sandbox and the run fails with a clear cause. The
 * quoted stderr is scrubbed of the git gate token, raw and in its Basic form
 * (the only credential the sandbox side has; the GitHub token is never here).
 */
async function runRequired(
  sandbox: SandboxSession,
  opts: { command: string; env?: Record<string, string> },
  label: string,
  spec: EveSpec,
  runToken: string,
): Promise<{ stdout: string }> {
  const result = await sandbox.run(opts)
  if (result.exitCode === 0) return { stdout: result.stdout ?? '' }
  const tokens = [spec.gitPushToken ?? ''].filter((x) => x.length > 0)
  const secrets = [...tokens.map(gateBasicAuth), ...tokens]
  let stderr = (result.stderr ?? '').trim().slice(-STDERR_TAIL_CHARS)
  for (const secret of secrets) stderr = stderr.split(secret).join('[redacted]')
  const message = `${label} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ''}`
  await beat(runToken, message)
  throw new Error(`coding-agent sandbox: ${message}`)
}

/**
 * Clone `repoFullName` @ `baseBranch` into /workspace through the app's git
 * gate, create `branchName`, set a committer identity, and (best-effort) run
 * `setupScript`. The remote, the push URL and the `lfs.url` base are all
 * `gateUrl` (the gate serves the run's repo, whatever the URL says: it takes
 * the repo from the run). With `credentialBrokered` (the hosted sandbox) the
 * firewall injects the gate token and no token is used here; without it (any
 * other provider, see this file's header) the gate token travels as a one-shot
 * env for the clone, then sits in the repo's config for the gate URL only;
 * never in a command string. No GitHub token exists here at all. Every git
 * step must exit 0 or the selector throws (see runRequired).
 */
async function seedWorkspace(
  sandbox: SandboxSession,
  spec: EveSpec & { gitPushToken: string },
  runToken: string,
  credentialBrokered: boolean,
  gateUrl: string,
): Promise<void> {
  // Single-quote every interpolated spec field: repoFullName is regex-validated on
  // write, but baseBranch/branchName are not. Belt-and-suspenders against a spec
  // field that ever carries shell metachars.
  // The push guard allows exactly the working branch, so that branch must never
  // be the base the PR merges into.
  if (spec.branchName === spec.baseBranch) {
    await beat(runToken, `Refusing to run: the working branch is the base branch (${spec.baseBranch}).`)
    throw new Error('coding-agent sandbox: the working branch must differ from the base branch')
  }
  const gateAuthHeader = `Authorization: ${gateBasicAuth(spec.gitPushToken)}`
  // Unbrokered only: the gate token for THE CLONE, as a one-shot git config env
  // (there is no repo yet to hold it). Right after the clone it moves into the
  // repo's config (below), where every later fetch, LFS request and push finds it.
  const cloneEnv: Record<string, string> | undefined = credentialBrokered
    ? undefined
    : {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: extraHeaderKey(gateUrl),
        GIT_CONFIG_VALUE_0: gateAuthHeader,
        GIT_TERMINAL_PROMPT: '0',
      }
  const required = (opts: { command: string; env?: Record<string, string> }, label: string) =>
    runRequired(sandbox, opts, label, spec, runToken)

  // Shallow clone for speed (depth-bounded), from the gate. `lfs.url` is set
  // in the new repo by `-c` before anything is fetched or checked out, so an
  // LFS repo's checkout (git-lfs's smudge, during the clone) and every later
  // LFS request go to the gate's LFS endpoints too: git-lfs's own default
  // would be `<gate URL>.git/info/lfs`, which the gate doesn't serve.
  await required(
    {
      command: `git clone --depth 50 --branch ${shellSingleQuote(spec.baseBranch)} -c ${shellSingleQuote(`lfs.url=${gateUrl}/info/lfs`)} ${shellSingleQuote(gateUrl)} .`,
      ...(cloneEnv ? { env: cloneEnv } : {}),
    },
    `git clone of ${spec.repoFullName}@${spec.baseBranch}`,
  )
  if (!credentialBrokered) {
    // No broker: the gate token goes in the repo's config for the gate URL
    // only, referenced from the env so the command text never carries it. It
    // can do no more than the gate allows (read this repo, push this run's
    // branch, while the run lives).
    await required(
      {
        command: `git config ${shellSingleQuote(extraHeaderKey(gateUrl))} "$NI_GIT_GATE_AUTH_HEADER"`,
        env: { NI_GIT_GATE_AUTH_HEADER: gateAuthHeader },
      },
      'git gate credential config',
    )
  }
  // Pushes go to the gate too, which accepts only this run's branch
  // (src/lib/agent-run/git-push-proxy.ts). The clone already made the gate the
  // remote's URL; pinning the push URL as well keeps pushes there if the
  // remote's URL is changed later (the push guard checks the URL either way).
  await required({ command: `git config remote.origin.pushurl ${shellSingleQuote(gateUrl)}` }, 'git config the push URL')
  await required({ command: 'git config user.email "agent@dial8.ai"' }, 'git config user.email')
  await required({ command: 'git config user.name "Native Intelligence Agent"' }, 'git config user.name')
  // A first plain `git push` of the new branch sets its upstream (git ≥ 2.37).
  await required({ command: 'git config push.autoSetupRemote true' }, 'git config push.autoSetupRemote')
  if (typeof spec.startFrom === 'string' && spec.startFrom && spec.startFrom !== spec.branchName) {
    // A CI fix run (P10 F7): fork the working branch (a side branch) from the
    // open PR's branch. Fetch it (the shallow clone carries only the base)
    // from `origin`, the gate. The push guard still allows only the working
    // branch, so nothing this run does reaches the PR's branch: the outcome
    // route moves the PR there only after the reviewer approves. POSIX sh and
    // git only. No env: unbrokered, the repo's config already carries the
    // gate token (passing it again would send the header twice).
    const remoteRef = `refs/remotes/origin/${spec.startFrom}`
    await required(
      { command: `git fetch --depth 50 origin ${shellSingleQuote(`refs/heads/${spec.startFrom}:${remoteRef}`)}` },
      `git fetch of ${spec.startFrom}`,
    )
    await required(
      { command: `git checkout -b ${shellSingleQuote(spec.branchName)} ${shellSingleQuote(`origin/${spec.startFrom}`)}` },
      `git checkout of ${spec.branchName}`,
    )
  } else {
    await required({ command: `git checkout -b ${shellSingleQuote(spec.branchName)}` }, `git checkout -b ${spec.branchName}`)
  }

  const { stdout: homeOut } = await required({ command: 'printf %s "$HOME"' }, 'resolve $HOME')
  const home = homeOut.trim()
  if (!home.startsWith('/')) {
    await beat(runToken, 'Could not resolve the sandbox home directory.')
    throw new Error('coding-agent sandbox: could not resolve the sandbox home directory')
  }

  // The push guard, before any user env, setup script or model command runs:
  // the hook + chain in $HOME/.dial8-hooks, and the hooks-path pin hooked into
  // the login-shell startup files (see prePushGuardScript). Verified at once.
  // git hands the hook the URL it pushes to: the gate's (the same URL the
  // clone came from, and the only one the hook lets a push go to).
  const guard: PushGuardArgs = { home, branchName: spec.branchName, remoteUrl: gateUrl }
  await required({ command: installPushGuardCommand(guard) }, 'install the push guard')
  await required({ command: envHookCommand(GIT_PIN_FILE) }, 'hook the push guard into the shell startup files')
  await ensurePushGuard(sandbox, guard, spec, runToken, 'after install')

  // The linked cloud environment's user env vars (proxy/TLS/token names stripped).
  // These are plaintext CONFIG, not secrets brokered at the firewall (see the
  // design doc §deferred) — but users do put registry tokens here, so they are
  // written with the FILE API and only ever sourced by fixed command text:
  // never interpolated into a command, never passed as a command's env.
  // The startup files source it so EVERY later shell command (the agent's
  // harness bash included) sees them; the setup script sources it directly.
  // eve's vercel binding spawns `bash -lc <command>`: a NON-INTERACTIVE LOGIN
  // shell, which reads /etc/profile then the FIRST of ~/.bash_profile,
  // ~/.bash_login, ~/.profile, and never ~/.bashrc (whose Debian-style
  // interactive guard would skip an appended line anyway). So the hook goes
  // into ~/.profile (created if absent), any existing ~/.bash_profile or
  // ~/.bash_login (never created: that would shadow ~/.profile), and ~/.bashrc
  // for interactive shells. Sourcing twice is harmless (plain exports).
  const userEnv = sanitizeEnvVars(spec.envVars)
  const envKeys = Object.keys(userEnv)
  const sourceEnv = `. "$HOME/${USER_ENV_FILE}"`
  if (envKeys.length > 0) {
    const exports = envKeys.map((k) => `export ${k}=${shellSingleQuote(userEnv[k])}`).join('\n')
    await sandbox.writeTextFile({ path: `${home}/${USER_ENV_FILE}`, content: `${exports}\n` })
    // Append (not overwrite) so we don't clobber the base image's startup files.
    await required({ command: envHookCommand(USER_ENV_FILE) }, 'hook the environment file into the shell startup files')
  }

  const setup = spec.setupScript?.trim()
  if (setup) {
    await beat(runToken, 'Running setup script…')
    // Non-fatal on failure (design doc): a failed setup is logged, and the run
    // proceeds — the agent can diagnose a half-provisioned repo itself rather
    // than the session dying opaquely before the model ever runs. The env file
    // is sourced first so the script sees the user env even before ~/.bashrc is.
    const command = envKeys.length > 0 ? `${sourceEnv}\n${setup}` : setup
    const result = await sandbox.run({ command })
    if (result.exitCode !== 0) {
      await beat(runToken, `Setup script exited ${result.exitCode}; continuing.`)
    }
    // A setup script runs arbitrary repo code (npm install → prepare scripts).
    // The env pin outranks a repo-local core.hooksPath, but the script could
    // still have touched the guard's files: verify, reinstall once, else fail.
    await ensurePushGuard(sandbox, guard, spec, runToken, 'after the setup script')
  }
}

/**
 * Verify the push guard is in force (pushGuardCheckCommand). If not, reinstall
 * it once and verify again; still not in force → the run fails, never starts
 * unguarded. The one exception is an interactive eve dev session
 * (openEgressAllowedForNarrowedRun), whose local provider may not run commands
 * through a login shell: there it degrades with a beat, as egress does.
 */
async function ensurePushGuard(
  sandbox: SandboxSession,
  guard: PushGuardArgs,
  spec: EveSpec,
  runToken: string,
  when: string,
): Promise<void> {
  const check = () => sandbox.run({ command: pushGuardCheckCommand(guard) })
  if ((await check()).exitCode === 0) return
  await runRequired(sandbox, { command: installPushGuardCommand(guard) }, 'reinstall the push guard', spec, runToken)
  if ((await check()).exitCode === 0) {
    await beat(runToken, `Push guard was not in force ${when}; reinstalled it.`)
    return
  }
  if (openEgressAllowedForNarrowedRun()) {
    await beat(runToken, `Push guard is not in force ${when} (dev only: continuing without it).`)
    return
  }
  await beat(runToken, `Push guard is not in force ${when}; refusing to run.`)
  throw new Error(`coding-agent sandbox: the push guard is not in force ${when}`)
}

/**
 * The policy a session sandbox is OPENED with. A run with a spec gets its
 * mapped policy (see buildNetworkPolicy); a session with
 * NO spec (unknown/expired token, spec route down) gets `deny-all` — it has
 * nothing to clone, so it needs no egress at all. Pure so the fail-closed
 * mapping is unit-testable.
 */
export function sessionNetworkPolicy(spec: EveSpec | null): SandboxNetworkPolicy {
  return spec ? buildNetworkPolicy(spec.networkAccess, gitEgressFor(spec)) : 'deny-all'
}

/**
 * The run's git egress: the git gate at the app's public origin, and on the
 * hosted sandbox (on Vercel, or off it with its settings) the one credential
 * the firewall injects, the run's git gate token, on the gate's six
 * endpoints. With DefaultSandbox the policy carries no credential (see this
 * file's header).
 */
export function gitEgressFor(spec: EveSpec): GitEgress {
  const gateUrl = gitGateUrl()
  // The selector refuses a run with no gate URL before it opens anything.
  if (!gateUrl) throw new Error('coding-agent sandbox: no public app origin for the git gate')
  return {
    gateUrl,
    broker: vercelEnvironment ? { gateToken: spec.gitPushToken ?? '' } : null,
  }
}

/**
 * The last line before an open: never let an absent policy reach the provider.
 * eve lets open() options override the environment's deny-all baseline, and an
 * explicit undefined reaches Vercel's Sandbox.create as "no policy" = full
 * internet (see this file's header). The types already rule it out; this keeps
 * it ruled out if a future policy builder widens its return type.
 */
export function requireDefinedNetworkPolicy(
  policy: SandboxNetworkPolicy | undefined | null,
): SandboxNetworkPolicy {
  if (policy === undefined || policy === null) {
    throw new Error('coding-agent sandbox: refusing to open a sandbox without an explicit network policy')
  }
  return policy
}

/**
 * Mirrors eve's own DefaultSandbox provider probe (`!!process.env.VERCEL`,
 * dist/src/sandbox/providers/default.js) so the environment `eve build`
 * prepares is the one the runtime opens.
 */
const ON_VERCEL = Boolean(process.env.VERCEL)

/**
 * The settings that log the app in to the hosted sandbox service off Vercel:
 * the same three the cloud browser uses (src/lib/cloud-browser/config.ts), and
 * deploy/app/build-agents.sh reads the same names.
 */
export const SANDBOX_CREDENTIAL_ENVS = ['SANDBOX_ACCESS_TOKEN', 'SANDBOX_TEAM_ID', 'SANDBOX_PROJECT_ID'] as const

/**
 * The hosted sandbox's credentials off Vercel: all three settings, trimmed, or
 * null when none is set. A partial set throws (at module load, so at `eve build`
 * and when the agent starts) rather than quietly falling back to a sandbox that
 * cannot run a coding run.
 */
export function hostedSandboxCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { token: string; teamId: string; projectId: string } | null {
  const [token, teamId, projectId] = SANDBOX_CREDENTIAL_ENVS.map((name) => env[name]?.trim() || '')
  if (!token && !teamId && !projectId) return null
  const missing = SANDBOX_CREDENTIAL_ENVS.filter((_, i) => ![token, teamId, projectId][i])
  if (missing.length) {
    throw new Error(
      `coding-agent sandbox: ${missing.join(', ')} not set (all three of ${SANDBOX_CREDENTIAL_ENVS.join(', ')}, or none)`,
    )
  }
  return { token, teamId, projectId }
}

/** Off Vercel only: on Vercel the deployment's own credentials are used, as before. */
const HOSTED_CREDENTIALS = ON_VERCEL ? null : hostedSandboxCredentials()

/**
 * Hosted: a dedicated Vercel environment, so `open()` accepts `networkPolicy`
 * and the handle's `setNetworkPolicy` is typed. The `deny-all` here is the
 * environment baseline — `open()` options override it per session. It only
 * covers an open where the `networkPolicy` key is absent (an explicit
 * undefined overrides it); openSessionSandbox always passes a defined policy.
 * Off Vercel the credentials go on the ENVIRONMENT, as eve's docs say ("resume
 * does not reconstruct start-only options"; open() does not even accept them):
 * eve hands them to every Sandbox.create/get/delete it makes for this agent.
 */
const vercelEnvironment =
  ON_VERCEL || HOSTED_CREDENTIALS
    ? VercelSandbox.environment({ networkPolicy: 'deny-all', ...HOSTED_CREDENTIALS })
    : null

/** Local dev: eve's default selection (Docker → microsandbox → just-bash). */
const localEnvironment = vercelEnvironment ? null : DefaultSandbox.environment()

export const environment = vercelEnvironment ?? localEnvironment!

/**
 * Open this session's sandbox with its egress policy applied AT CREATION
 * (Vercel), or off Vercel through the provider's setter (see this file's
 * header). `credentialBrokered` says whether the firewall injects the git
 * gate token (the hosted sandbox only: elsewhere the policy carries none).
 */
async function openSessionSandbox(
  spec: EveSpec | null,
  runToken: string,
): Promise<{ sandbox: RuntimeSandboxSession; credentialBrokered: boolean }> {
  const policy = requireDefinedNetworkPolicy(sessionNetworkPolicy(spec))
  if (vercelEnvironment) {
    return { sandbox: await vercelEnvironment.open({ networkPolicy: policy }), credentialBrokered: true }
  }
  const sandbox = await localEnvironment!.open()
  const failure = await applyLocalPolicy(sandbox, policy)
  if (failure === null) return { sandbox, credentialBrokered: false }
  if (!spec) {
    // Nothing to clone and no credential in this sandbox; say so and go on.
    console.warn(`[coding-agent sandbox] ${failure}; the spec-less sandbox keeps the provider's default egress.`)
    await beat(runToken, `${failure}; the sandbox has no run spec (nothing will be cloned).`)
    return { sandbox, credentialBrokered: false }
  }
  // Only `trusted` asked for open egress; anything narrower (restricted,
  // isolated, or a value this code does not know) fails closed here.
  if (spec.networkAccess !== 'trusted' && !openEgressAllowedForNarrowedRun()) {
    await beat(runToken, `${failure}; refusing to run a ${spec.networkAccess} run with unrestricted egress.`)
    throw new Error(
      `coding-agent sandbox: ${failure}. A ${spec.networkAccess} run cannot proceed off Vercel without a policy-capable sandbox provider (${HOSTED_SANDBOX_HINT}).`,
    )
  }
  if (openEgressAllowedForNarrowedRun()) {
    await beat(runToken, `${failure}; egress is unrestricted (dev only).`)
  } else {
    // Not eve dev: a self-hosted container with no hosted-sandbox settings. Say
    // what is wrong and what fixes it, not "dev only".
    await beat(runToken, `${failure}; egress is unrestricted, and this sandbox may not run git at all: ${HOSTED_SANDBOX_HINT}.`)
  }
  return { sandbox, credentialBrokered: false }
}

/** What an operator sets to give this agent a sandbox that enforces its policy. */
const HOSTED_SANDBOX_HINT = `set ${SANDBOX_CREDENTIAL_ENVS.join(', ')} to run it on the hosted sandbox, then build the agents again`

/**
 * Whether a narrowed (`restricted` / `isolated`) run may degrade to open
 * egress when no policy can be applied: only in an interactive eve dev
 * session. `EVE_DEV=1` is eve's own dev signal (`eve dev`, eve/next's dev
 * sidecar), but `eve eval` also starts its local target through a dev server
 * that inherits EVE_DEV=1 — it sets `EVE_EVALUATION=1` first, so that excludes
 * evals. Read per call.
 */
function openEgressAllowedForNarrowedRun(): boolean {
  return process.env.EVE_DEV === '1' && process.env.EVE_EVALUATION !== '1'
}

/**
 * Apply `policy` through the provider's setter when the live handle has one.
 * The common handle type does not declare it (eve 0.66), so this probes at
 * runtime. Returns null when applied, else why not (no setter, or the provider
 * rejected it — Docker takes only allow-all/deny-all).
 */
async function applyLocalPolicy(sandbox: SandboxSession, policy: SandboxNetworkPolicy): Promise<string | null> {
  const setter = (sandbox as { setNetworkPolicy?: unknown }).setNetworkPolicy
  if (typeof setter !== 'function') return 'Local sandbox has no network-policy support'
  try {
    await (setter as (p: SandboxNetworkPolicy) => Promise<void>).call(sandbox, policy)
    return null
  } catch (err) {
    return `Network policy not applied (${err instanceof Error ? err.message : 'unsupported provider'})`
  }
}

export default defineSandbox(async ({ session }) => {
  const runToken = runTokenFromAuth(session.auth)
  const spec = await fetchEveSpec(runToken)

  // A spec without a git gate credential is a run that could neither clone nor
  // push (both only go through the app's git gate): refuse it before anything
  // opens.
  if (spec && !spec.gitPushToken) {
    await beat(runToken, 'Refusing to run: the run has no git gate credential.')
    throw new Error('coding-agent sandbox: the spec carries no git gate credential')
  }
  // Nor can it clone or push without the app's public origin (on Vercel the
  // deployment URL is protected, and the sandbox never gets a bypass secret).
  const gateUrl = gitGateUrl()
  if (spec && !gateUrl) {
    await beat(runToken, "Refusing to run: the app's public address (NEXT_PUBLIC_APP_URL) isn't set, so this run couldn't clone its repository or push its change.")
    throw new Error('coding-agent sandbox: NEXT_PUBLIC_APP_URL is not set, so the git gate has no public origin')
  }

  // No spec (unknown/expired token, route down, or the localDev smoke path with
  // no token): return an empty deny-all sandbox. The run fails cleanly when the
  // agent finds no repo — better than crashing setup.
  const { sandbox, credentialBrokered } = await openSessionSandbox(spec, runToken)
  if (!spec) return sandbox

  // The network policy (on the hosted sandbox with the git gate token on the
  // gate's endpoints) is already in force (there from creation; elsewhere
  // through the setter), so it governs the clone below and every later command
  // (push included). If anything here
  // throws, eve deletes this new sandbox and reruns the selector on the next
  // access. A nonzero exit does not throw by itself, so seedWorkspace checks
  // every git step and throws on failure (only the setup script is lenient).
  await beat(runToken, `Cloning ${spec.repoFullName}@${spec.baseBranch} onto ${spec.branchName}…`)
  await seedWorkspace(sandbox, { ...spec, gitPushToken: spec.gitPushToken! }, runToken, credentialBrokered, gateUrl!)
  await beat(runToken, `Sandbox ready. Working branch ${spec.branchName}.`)
  return sandbox
})
