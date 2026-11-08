/**
 * web_search — LIVE for the coding-agent, pinned to Exa.
 *
 * Web access is an ALWAYS-ON capability of every Native Intelligence agent. This file REPLACES
 * a `disableTool()` sentinel whose rationale was parity with the legacy Claude-
 * Code-CLI runner's hardcoded Bash/Read/Edit/Write/Glob/Grep allowlist. That
 * parity argument no longer holds: an unattended coding run that hits an
 * unfamiliar library API or an opaque compiler/runtime error has no one to ask,
 * so the only alternatives were guessing at an API or failing the run.
 *
 * The agent's real safety boundary is unchanged and structural: sandbox
 * isolation, the scoped terminal tools (finish_run / post_progress), and the
 * per-session output-token cap. Reading a doc page is not the boundary. Note
 * that search runs at the PROVIDER, not in the sandbox, so it is unaffected by
 * the sandbox's `restricted` network policy — that policy still governs what the
 * cloned repo's own build/test commands may reach.
 *
 * `web_search` is provider-executed: there is no local executor to wrap. The only
 * configuration surface eve exposes is the provider selection, so this file pins
 * Exa explicitly rather than inheriting it as a framework default.
 *
 * Results come back as untrusted third-party page content. The standing
 * instruction (instructions.md → "Web access") tells the model to treat them as
 * reference DATA — never as instructions, and never as code to paste unread into
 * the repository.
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'exa' })
