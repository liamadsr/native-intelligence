/**
 * capture-activity — durably records the research run's tool-call trail.
 *
 * WHY A HOOK (not the finish tool, not a server-side stream tap): finish_research
 * only sees its OWN arguments — its ctx carries no prior tool-call history — so it
 * structurally cannot reconstruct "what did the run do". The kickoff route can't
 * either: the eve event stream is consumed DIRECTLY by the browser, and a
 * server-side tap would have to hold a serverless function open for the whole run.
 * An `agent/hooks/*.ts` file is the right seam: eve fires it AFTER each stream
 * event is durably recorded, inside this agent's own tree, with a HookContext that
 * carries the verified session principal (same owner-derivation as the tools).
 *
 * WHAT IT CAPTURES: every `actions.requested` event carries the model's requested
 * tool calls. We label each meaningful one (web_search / web_fetch / save_*) with
 * the SAME friendly one-liner the live wizard shows (research-activity-labels.ts,
 * mirrored) and append it — dedup-by-callId, CAS-safe — onto
 * member.onboarding_progress.research.activityLog. finish_research then renders
 * that trail into the home conversation so the main agent can answer "what did
 * you look at?" (founder ask #3: the research is in the message history).
 *
 * OBSERVE-ONLY + FAIL-SAFE: hooks cannot change the model's context. Since eve
 * 0.68 a thrown hook is logged and the run continues (docs/guides/hooks.md
 * "What happens when a hook throws"), so a throw can no longer fail the run;
 * the body is still wrapped in try/catch so a failure is swallowed with our own
 * warning, and a missing trail stays a cosmetic loss.
 */
import { defineHook } from 'eve/hooks'
import { requireOwner, serviceClient, NoOwnerError } from '../lib/tool-context.js'
import {
  appendResearchActivity,
  type ResearchActivityEntry,
} from '../lib/research-progress.js'
import { labelForToolCall } from '../lib/research-activity-labels.js'

/**
 * Tools whose calls are worth recording as "what the research did". We narrate
 * the outward-facing research + setup actions and skip pure control/plumbing
 * tools (finish_research is the terminal ack, not an activity; sandbox tools
 * bash/read_file/… never fire for this agent). Keeping this curated means the
 * home trail reads as a clean story, not a raw event dump.
 */
const NARRATED_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'enrich_company',
  'enrich_me',
  'save_research_claims',
  'save_starter_content',
])

interface ToolCallAction {
  kind?: string
  toolName?: string
  callId?: string
  input?: unknown
}

export default defineHook({
  events: {
    async 'actions.requested'(event, ctx) {
      try {
        const actions = (event?.data?.actions ?? []) as ToolCallAction[]
        if (!Array.isArray(actions) || actions.length === 0) return

        const entries: ResearchActivityEntry[] = []
        for (const action of actions) {
          if (action?.kind !== 'tool-call') continue
          const toolName = action.toolName
          const callId = action.callId
          if (!toolName || !callId) continue
          if (!NARRATED_TOOLS.has(toolName)) continue
          entries.push({
            callId,
            toolName,
            label: labelForToolCall(toolName, action.input),
          })
        }
        if (entries.length === 0) return

        // Owner comes ONLY from the verified session principal (never model
        // input) — same choke point as every research tool. The localDev smoke
        // principal has no workspace; NoOwnerError there is expected and ignored.
        let owner
        try {
          owner = requireOwner(ctx)
        } catch (err) {
          if (err instanceof NoOwnerError) return
          throw err
        }

        await appendResearchActivity(serviceClient(), {
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          entries,
        })
      } catch (err) {
        // Best-effort trail: swallow with our own warning (eve 0.68+ would only
        // log a thrown hook, never fail the run on it).
        console.warn('capture-activity hook: swallowed error (non-fatal):', err)
      }
    },
  },
})
