/**
 * web_fetch — LIVE for the work-agent, wrapped for safety.
 *
 * Web access is always on for every Native Intelligence agent. This file REPLACES a
 * `disableTool()` sentinel whose stated reason was "raw web_fetch (no SSRF
 * url-guard here)" — the guard was the blocker, not the capability. This wrapper
 * supplies it, so the tool comes back live with the same two guards the chat
 * agents use:
 *
 *   1. SSRF url-guard (lib/url-guard.ts) — every URL is validated before the
 *      fetch runs, blocking private / loopback / link-local IPs and cloud-
 *      metadata hostnames so a URL the brief or a page suggested can't turn Native Intelligence
 *      into an SSRF reflection point. Mirrors src/lib/mcp-client/url-guard.ts
 *      (agents can't import src/).
 *   2. Per-session abuse cap (lib/web-fetch-cap.ts) — an invisible, generous
 *      ceiling on fetches per eve session, as insurance against a runaway loop in
 *      an autonomous run nobody is watching.
 *
 * What these guards do NOT do: constrain the destination host or what goes into
 * the URL. A run steered by injected text could put workspace data into the
 * path or query of a URL it fetches. Whether that egress risk is acceptable is
 * an OPEN product call for Liam (see "OPEN — needs Liam's product call: web_fetch
 * egress" above WORK_RUN_EXCLUDED_TOOLS in src/lib/agent-run/types.ts); this
 * wrapper does not claim to stop it.
 *
 * The REST of the work-agent's lockdown is unchanged and still structural: no
 * sandbox shell/filesystem, and no ask_question (opt-in since eve 0.65 and never
 * added here — its park is not the request_user_input shape the dispatcher
 * classifies).
 *
 * We SPREAD eve's built-in definition (inputSchema, outputSchema) and override
 * `execute` (guard + cap in front of the real fetch) plus `description` — this
 * tool sits next to the workspace proxies in the SAME session, and the framework
 * description says nothing about workspace data, so the steer keeps retrieval of
 * workspace entities on the workspace tools where it belongs.
 */
import { defineTool } from 'eve/tools'
import { webFetch, type WebFetchToolOutput } from 'eve/tools/web_fetch'
import { ensureSafeWebUrl } from '../lib/url-guard'
import { countWebFetch } from '../lib/web-fetch-cap'
import { wrapUntrustedWeb } from '../lib/untrusted'

export default defineTool({
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
    // eve session (one work run). Refusal returns a model-visible, non-throwing
    // result so the run continues gracefully instead of failing.
    const gate = countWebFetch(ctx.session.id)
    if (!gate.allowed) {
      return {
        url: rawUrl,
        content:
          `This run has reached its web-fetch limit (${gate.limit}). ` +
          'Finish the work with what you have already read.',
        contentType: 'text/plain',
        truncated: false,
      }
    }

    // SSRF guard — throws on a blocked host. Surface it as a model-visible result
    // (not an unhandled throw) so the model can react rather than failing the run.
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
