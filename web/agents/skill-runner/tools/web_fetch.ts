/**
 * web_fetch — LIVE for the skill-runner, wrapped for safety.
 *
 * Web access is on by default for every Dial8 agent (for skill runs, off only
 * when the spec's `webAccess` is false — the USE_GATEWAY kill switch, stubbed in
 * tools/workspace_tools.ts; see lib/__tests__/web-access-gate.test.ts). This file REPLACES a
 * `disableTool()` sentinel: the old harness lockdown removed every default
 * outside the skill's workspace-tool ceiling, web included. Web is orthogonal to
 * that ceiling — a skill run that must read a public page the run references (a
 * vendor's changelog, a doc the brief links) could previously only guess, which
 * the standing contract forbids.
 *
 * The rest of the lockdown is unchanged and still structural: the skill's
 * permitted tools are the only workspace proxies tools/workspace_tools.ts mints,
 * and the sandbox-backed defaults (bash/read_file/write_file) stay disabled, so
 * no sandbox is provisioned for these sessions. Two guards ride on top of the
 * built-in, matching the chat agents:
 *
 *   1. SSRF url-guard (lib/url-guard.ts) — every URL is validated before the
 *      fetch runs, blocking private / loopback / link-local IPs and cloud-
 *      metadata hostnames so a URL the run's instructions supplied can't turn
 *      Dial8 into an SSRF reflection point. Mirrors
 *      src/lib/mcp-client/url-guard.ts (agents can't import src/).
 *   2. Per-session abuse cap (lib/web-fetch-cap.ts) — an invisible, generous
 *      ceiling on fetches per eve session, as insurance against a runaway loop in
 *      an unattended run.
 *
 * We SPREAD eve's built-in definition (inputSchema, outputSchema) and override
 * `execute` (guard + cap in front of the real fetch) plus `description` — this
 * tool sits next to the workspace proxies in the SAME session, so the steer keeps
 * retrieval of workspace entities on the workspace tools where it belongs.
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
    'Use it to read a public page this run references. ONLY for public https:// URLs ' +
    'on the open web — NEVER for workspace data: captures, documents, actions, contacts, ' +
    'and emails are not reachable by URL; read them with the workspace tools instead.',
  async execute(input, ctx) {
    const bag = (input ?? {}) as { url?: unknown }
    const rawUrl = typeof bag.url === 'string' ? bag.url : ''

    // Abuse cap FIRST — a refused call must not even validate/fetch. Keyed on the
    // eve session (one skill run). Refusal returns a model-visible, non-throwing
    // result so the run continues gracefully instead of failing.
    const gate = countWebFetch(ctx.session.id)
    if (!gate.allowed) {
      return {
        url: rawUrl,
        content:
          `This run has reached its web-fetch limit (${gate.limit}). ` +
          'Finish the run with what you have already read.',
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
