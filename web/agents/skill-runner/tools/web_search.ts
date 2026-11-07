/**
 * web_search — LIVE for the skill-runner, pinned to Exa.
 *
 * Web access is ON by default for every Dial8 agent — not a per-agent
 * allowlist toggle, and not part of a skill's tool ceiling. The one off switch
 * for skill runs is the spec's `webAccess: false` (the USE_GATEWAY kill switch),
 * under which tools/workspace_tools.ts replaces this tool with a stub
 * (lib/__tests__/web-access-gate.test.ts). This file REPLACES a
 * `disableTool()` sentinel: the old harness lockdown removed every default
 * outside the skill's workspace-tool ceiling, web included. That was wrong for
 * web specifically. A skill run that has to summarize a market, check a vendor's
 * current docs, or verify a public fact could previously only guess — which the
 * standing contract explicitly forbids.
 *
 * The ceiling still governs the WORKSPACE surface: the skill's permitted tools
 * are the only proxies tools/workspace_tools.ts mints, and the sandbox-backed
 * defaults (bash/read_file/write_file) stay structurally disabled. Web is
 * orthogonal to that ceiling. Note the trap: a `web_search` entry must NEVER be
 * added to a skill spec's ceilingTools/coreToolNames — the resolver would mint a
 * workspace proxy of that name colliding with this native provider tool.
 *
 * `web_search` is provider-executed: there is no local executor to wrap. The only
 * configuration surface eve exposes is the provider selection, so this file pins
 * Exa explicitly rather than inheriting it as a framework default.
 *
 * Results come back as untrusted third-party page content. The standing
 * instruction (instructions.md → "Web access") tells the model to treat them as
 * DATA to summarize and cite, never as instructions to follow — which matters
 * doubly here, where the run is unattended.
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'exa' })
