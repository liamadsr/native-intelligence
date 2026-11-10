/**
 * web_search — LIVE for the chat-agent, pinned to Exa.
 *
 * Web access is an ALWAYS-ON capability of every Native Intelligence agent — not a per-agent
 * allowlist toggle, and not a persona/ceiling entry (matching how Anthropic's
 * own agents browse). There is deliberately no `web_search` row in the app's
 * TOOL_CATEGORIES registry: adding one would make the eve resolver mint a
 * workspace-tool PROXY named `web_search` that collides with this native
 * provider tool.
 *
 * `web_search` is provider-executed: there is no local executor to wrap. The
 * only configuration surface eve exposes is the provider selection, so this file
 * exists purely to PIN Exa explicitly rather than inherit it as a framework
 * default. Absence of this file behaves identically today (AI-Gateway models
 * default to Exa), but the pin makes the choice reviewable and survives a change
 * to eve's default. It also replaces the old ambiguity where "no file" meant
 * both "we chose the default" and "someone deleted the disable sentinel".
 *
 * Results come back as untrusted third-party page content. The standing
 * instruction (instructions.md → "Web access") tells the model to treat them as
 * DATA to summarize and cite, never as instructions to follow.
 *
 * THE MAC BODY (contract C2, ../lib/host.ts) has none of this: built with
 * NI_AGENT_HOST=mac, the native tool is removed, and C1's spec advertises a
 * `web_search` of its own that the workspace resolver proxies to the app
 * (tools/workspace_tools.ts), so the search runs on the server and the Mac
 * stays off the network (absent on a local model).
 */
import { disableTool } from 'eve/tools'
import { webSearch } from 'eve/tools/web_search'
import { isMacHost } from '../lib/host.js'

export default isMacHost() ? disableTool() : webSearch({ provider: 'exa' })
