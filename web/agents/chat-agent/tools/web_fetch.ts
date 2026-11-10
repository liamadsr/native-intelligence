/**
 * web_fetch — LIVE for the chat-agent, wrapped for safety.
 *
 * Web access is always on for chat agents (no toggle, matching how Anthropic's
 * own agents browse). This tool used to be a `disableTool()` sentinel; it now
 * wraps eve's built-in web_fetch (imported from the per-tool subpath
 * `eve/tools/web_fetch`) so the model can read pages, with two guards the
 * built-in doesn't provide:
 *
 *   1. SSRF url-guard (lib/url-guard.ts) — every URL is validated before the
 *      fetch runs, blocking private / loopback / link-local IPs and cloud-
 *      metadata hostnames so a user-influenced URL can't turn Native Intelligence into an SSRF
 *      reflection point. Mirrors src/lib/mcp-client/url-guard.ts (agents can't
 *      import src/).
 *   2. Per-conversation abuse cap (lib/web-fetch-cap.ts) — an invisible, generous
 *      ceiling on fetches per eve session, as insurance against a runaway loop.
 *
 * We SPREAD eve's built-in definition (inputSchema, outputSchema) and override
 * `execute` (guard + cap in front of the real fetch) plus `description` — the
 * framework description says nothing about workspace data, and this tool sits
 * next to workspace tools in the SAME session. Observed failure (2026-07-14):
 * the model web_fetched an invented "about:capture/<uuid>" URL to read the
 * capture the user was viewing. The steer keeps retrieval of workspace entities
 * on the workspace tools where it belongs.
 *
 * THE MAC BODY (contract C2, ../lib/host.ts) has none of this: built with
 * NI_AGENT_HOST=mac, the native tool is removed (it would fetch from this
 * process, outside the sandbox), and C1's spec advertises a `web_fetch` of its
 * own that the workspace resolver proxies to the app (tools/workspace_tools.ts):
 * the same guard, cap and untrusted marking, run on the server.
 */
import { defineTool, disableTool } from 'eve/tools'
import { webFetch, type WebFetchToolOutput } from 'eve/tools/web_fetch'
import { ensureSafeWebUrl } from '../lib/url-guard'
import { countWebFetch } from '../lib/web-fetch-cap'
import { wrapUntrustedWeb } from '../lib/untrusted'
import { isMacHost } from '../lib/host.js'

const guardedWebFetch = defineTool({
  ...webFetch,
  description:
    `${webFetch.description} ` +
    'ONLY for public https:// URLs on the open web. NEVER for workspace data — ' +
    'captures, documents, actions, contacts, and emails are not reachable by URL; ' +
    'read them with the workspace tools (find, get_capture_content, get_document, …) instead.',
  async execute(input, ctx) {
    const bag = (input ?? {}) as { url?: unknown }
    const rawUrl = typeof bag.url === 'string' ? bag.url : ''

    // Abuse cap FIRST — a refused call must not even validate/fetch. Keyed on the
    // conversation (eve session). Refusal returns a model-visible, non-throwing
    // result so the turn continues gracefully instead of failing.
    const gate = countWebFetch(ctx.session.id)
    if (!gate.allowed) {
      return {
        url: rawUrl,
        content:
          `This conversation has reached its web-fetch limit (${gate.limit}). ` +
          `Work with what you've already read, or ask me to focus the search.`,
        contentType: 'text/plain',
        truncated: false,
      }
    }

    // SSRF guard — throws on a blocked host. Surface it as a model-visible result
    // (not an unhandled throw) so the model can react rather than failing the turn.
    if (rawUrl) {
      try {
        ensureSafeWebUrl(rawUrl)
      } catch (err) {
        return {
          url: rawUrl,
          content: err instanceof Error ? err.message : 'Refused to fetch that URL.',
          contentType: 'text/plain',
          truncated: false,
        }
      }
    }

    // Delegate to eve's real web_fetch execute for the actual retrieval.
    // AWAIT is load-bearing: 0.47.7 types `execute` as returning
    // `TOutput | Promise<TOutput> | AsyncIterable<TOutput>`. Returning it bare
    // from an `async` fn yields `Promise<TOutput | AsyncIterable<TOutput>>`,
    // which no `defineTool` overload accepts. eve's web_fetch always resolves a
    // plain object (never an async iterable), so awaiting narrows it correctly.
    const fetched = (await webFetch.execute(input, ctx)) as WebFetchToolOutput
    // The page is someone else's text: it reaches the model inside the
    // untrusted-content marker (lib/untrusted.ts, A5), the envelope unchanged.
    return { ...fetched, content: wrapUntrustedWeb(fetched.content ?? '') }
  },
})

export default isMacHost() ? disableTool() : guardedWebFetch
