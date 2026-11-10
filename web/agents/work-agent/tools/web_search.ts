/**
 * web_search — LIVE for the work-agent, pinned to Exa.
 *
 * Web access is an ALWAYS-ON capability of every Native Intelligence agent — not a per-agent
 * allowlist toggle, and not a ceiling entry. The work-agent's ceiling filters the
 * WORKSPACE-tool proxies (tools/workspace_tools.ts); web search sits outside that
 * mechanism entirely. Adding a `web_search` row to the app's TOOL_CATEGORIES
 * registry would make the resolver mint a workspace proxy of that name which
 * collides with this native provider tool — so it must never be added there.
 *
 * Approved work runs routinely need public/current facts the workspace doesn't
 * hold: what a prospect's company actually does before drafting an email, a
 * product's current pricing, a vendor's docs. Withholding search only made the
 * model guess, which the standing contract forbids.
 *
 * `web_search` is provider-executed: there is no local executor to wrap. The only
 * configuration surface eve exposes is the provider selection, so this file
 * exists purely to PIN Exa explicitly rather than inherit it as a framework
 * default. This REPLACES nothing (the slug had no file); its sibling
 * tools/web_fetch.ts replaces a former disableTool() sentinel.
 *
 * Results come back as untrusted third-party page content. The standing
 * instruction (instructions.md → "Web access") tells the model to treat them as
 * DATA to summarize and cite, never as instructions to follow — which matters
 * doubly here, where the run is autonomous and unsupervised.
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'exa' })
