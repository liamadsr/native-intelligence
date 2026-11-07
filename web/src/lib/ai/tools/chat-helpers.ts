import { tool } from 'ai'
import { z } from 'zod'
import { AREA_KEYS } from '@/lib/packs/registry'
import { HELPER_MODEL_KEYS } from '@/lib/ai/models'

/**
 * Background helpers (always-on-agent §4, A4 slice 4): schema twins, like
 * ask_user. No generic executor, so MCP cannot export them and every other
 * surface treats them as absent (CHAT_NATIVE_TOOL_NAMES). Only the
 * authenticated main-chat tool route runs them (/api/internal/chat/tool, with
 * eve's call, turn and session ids), through src/lib/chat/start-helper.ts.
 *
 *   start_helper   hand a self-contained job to a background helper: a work
 *                  run with this thread's areas and what the agent knows about
 *                  the person, on the drafting ceiling (reads and drafts, no
 *                  board moves, no sends), bounded by what this chat may call.
 *                  With `agent_id`, one of the person's custom agents does it
 *                  as itself, within its own limits too. The helper reports
 *                  back into this conversation when it settles.
 *   stop_helper    stop one of the person's running helpers (the Stop button's
 *                  own path: the run flips to canceling and its watcher ends).
 */

/** At most this many areas ride on one helper (agent_run.helper_areas, migration 332). */
export const HELPER_AREAS_MAX = 2

export const startHelperSchema = z.object({
  task: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('The job, self-contained: what to do and what done looks like. The helper cannot read this conversation.'),
  context: z
    .string()
    .max(4000)
    .optional()
    .describe('The facts it needs from this conversation: names, ids, quotes, decisions already made.'),
  hand_back: z.string().max(1000).optional().describe('What to hand back (for example "a sourced one-page document").'),
  areas: z
    .array(z.enum(AREA_KEYS))
    .min(1)
    .max(HELPER_AREAS_MAX)
    .optional()
    .describe("The one or two areas this job is in (this thread's packs): the helper loads their playbooks and notes."),
  model: z
    .enum(HELPER_MODEL_KEYS)
    .optional()
    .describe(
      'The model this helper runs on, from "Models for helpers" in your instructions: the cheapest that will do the job well. ' +
        'flash: lookups and routine work; flash-thinking: multi-step research on a budget (the usual pick for a background job); haiku: quick reliable tool use and polished short drafts; ' +
        'gpt-luna: cheap high-volume extraction; sonnet: code, SQL, synthesis across many sources; gpt-terra: strong analysis from another model family; opus: only the hardest judgment. ' +
        'sonnet, gpt-terra and opus are premium (paid plans, a daily cap). Leave it out to let the app pick.',
    ),
  agent_id: z
    .string()
    .uuid('must be a bot_id of a custom agent from list_bot_work')
    .optional()
    .describe("A custom agent (its bot_id from list_bot_work) to do it as itself, within its own limits. Leave it out for a general helper."),
  expects: z
    .array(
      z.object({
        type: z.enum(['document', 'email_draft', 'action', 'entity']),
        min: z.number().int().min(0).max(20).optional(),
        entity_type: z.string().max(40).optional(),
      }),
    )
    .max(4)
    .optional()
    .describe('The deliverables the job should produce, when it should produce any. Leave out for a summary only.'),
  resources: z
    .array(z.object({ type: z.string().min(1).max(80), id: z.string().min(1).max(200), label: z.string().max(80).optional() }))
    .max(8)
    .optional()
    .describe('Workspace items it should read first (captures, documents, contacts) by id.'),
  item: z
    .string()
    .max(210)
    .optional()
    .describe('Only in your check-in: the tracked item this helper retries, exactly as the check-in names it (for example "work:<id>"). Leave it out everywhere else.'),
})
export type StartHelperInput = z.infer<typeof startHelperSchema>

export const stopHelperSchema = z.object({
  job: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The helper to stop: the work_item_id or run_id start_helper gave, or an item id from list_bot_work."),
})
export type StopHelperInput = z.infer<typeof stopHelperSchema>

export function createChatHelperTools() {
  return {
    start_helper: tool({
      description:
        'In main chat, hand a self-contained job the person asked for to a background helper that works while you keep talking: a long research pass, reading many emails, drafting a batch. ' +
        "It reads the workspace and writes drafts (documents, email drafts) within this chat's limits; it never sends, publishes, deletes or moves things on the board. " +
        'With agent_id, one of their custom agents does it as itself, within its own limits. ' +
        'Choose its `model` for the job (see "Models for helpers" in your instructions). ' +
        "Returns at once with a run id, work_item_id and the model it runs on; the helper reports back in this conversation when it finishes or needs them. Never claim the work is done from this acknowledgement. " +
        'Write the brief so it stands alone: it cannot read this chat. The brief is visible to members of the workspace. ' +
        'Call it once per job: a "queued" result is accepted work that starts on its own, and a refusal or an error is final for this request unless the person asks again. At most 3 helpers per conversation run at once. Works in main chat and from the person\'s own text or Slack message (from a text, only the general helper: no agent_id).',
      inputSchema: startHelperSchema,
    }),
    stop_helper: tool({
      description:
        "In main chat, stop one of the person's running helpers when they ask you to (\"stop the researcher\"), by the work_item_id or run_id start_helper gave, or an item id from list_bot_work. " +
        'Whatever it already drafted stays. Works in main chat and from the person\'s own text or Slack message.',
      inputSchema: stopHelperSchema,
    }),
  }
}
