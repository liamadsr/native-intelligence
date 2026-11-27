/**
 * A meeting's hand-off (roadmap #12, docs/plans/agent-joins-meetings.md §3).
 *
 * On the person's own call, a hand-off is the person asking, so it runs as
 * their home turn with their tools (src/lib/calls/call-turn-server.ts). In a
 * meeting the words are someone else's. So a meeting's hand-off never runs a
 * home turn, never reaches the person's tools or workspace: it is one
 * `meeting_reply` utility task (on eve, no tools) over the brief the person
 * approved and what was said, which comes back as exactly one of:
 *
 *   answer     words from the brief, for GPT-Live to say;
 *   check      "I'll check with <Name>": said in the meeting, and the
 *              question goes to the person (./ask.ts: their home thread,
 *              urgent, through the reach router);
 *   objection  someone objects: the bridge says goodbye and leaves;
 *   quiet      nothing to say.
 *
 * Never throws: a failure is a short notice that it will check, so the
 * meeting is never left hanging and nothing is said that the brief doesn't
 * hold.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { briefText } from './brief'
import type { MeetingAttendance } from './store'

export const MeetingReplySchema = z.object({
  kind: z.enum(['answer', 'check', 'objection', 'quiet']),
  say: z.string().max(600),
  question: z.string().max(400).optional(),
})
export type MeetingReply = z.infer<typeof MeetingReplySchema>

/** How much of the meeting a hand-off carries. */
export const MEETING_WORDS_MAX_CHARS = 2_000
export const MEETING_BEFORE_MAX_CHARS = 3_000

function fence(text: string, max: number): string {
  // The tags are ours: words that try to close them are written as text.
  return text.replace(/<\/?(?:brief|meeting|before)>/gi, '').slice(-max)
}

/** The task's message: the brief, then what was said. Pure. */
export function meetingReplyMessage(args: { firstName: string; brief: MeetingAttendance['brief']; words: string; before: string }): string {
  return [
    `The person's first name: ${args.firstName}.`,
    `<brief>\n${briefText(args.brief)}\n</brief>`,
    `<before>\n${fence(args.before, MEETING_BEFORE_MAX_CHARS) || '(nothing)'}\n</before>`,
    `<meeting>\n${fence(args.words, MEETING_WORDS_MAX_CHARS)}\n</meeting>`,
  ].join('\n\n')
}

/** What the meeting hears when the turn can't answer: the safe side, a check. */
export function fallbackReply(firstName: string): MeetingReply {
  return { kind: 'check', say: `Let me check with ${firstName} on that and get back to you.`, question: '' }
}

/**
 * The reply, made safe to say: a `check` always says it will check (in the
 * person's name), an `answer` with nothing to say is quiet. Pure.
 */
export function settleReply(reply: MeetingReply, firstName: string): MeetingReply {
  const say = reply.say.replace(/\s+/g, ' ').trim()
  if (reply.kind === 'answer') return say ? { kind: 'answer', say } : { kind: 'quiet', say: '' }
  if (reply.kind === 'check') return { kind: 'check', say: say || fallbackReply(firstName).say, question: (reply.question ?? '').replace(/\s+/g, ' ').trim() }
  if (reply.kind === 'objection') return { kind: 'objection', say }
  return { kind: 'quiet', say: '' }
}

export interface MeetingTurnDeps {
  run?: typeof runUtilityTask
  log?: typeof logUsage
}

/** Answer one hand-off from the brief. Never throws. */
export async function runMeetingTurn(
  supabase: SupabaseClient,
  args: { attendance: MeetingAttendance; delegationId: string; words: string; before: string },
  deps: MeetingTurnDeps = {},
): Promise<MeetingReply> {
  const a = args.attendance
  try {
    const result = await (deps.run ?? runUtilityTask)({
      kind: 'meeting_reply',
      supabase,
      workspaceId: a.workspaceId,
      userId: a.userId,
      outputSchema: MeetingReplySchema,
      message: meetingReplyMessage({ firstName: a.ownerFirstName, brief: a.brief, words: args.words, before: args.before }),
    })
    await (deps.log ?? logUsage)(a.userId, {
      provider: usageProviderLabel(result.model),
      model: result.model,
      feature: 'meeting_agent.reply',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: 0,
      costUsd: result.usage.costUsd ?? undefined,
      idempotencyKey: `meeting-reply:${a.id}:${args.delegationId}`,
      metadata: { workspace_id: a.workspaceId, meeting_attendance_id: a.id, ...usageCacheMetadata(result.usage) },
    }).catch(() => {})
    return settleReply(MeetingReplySchema.parse(result.object), a.ownerFirstName)
  } catch (err) {
    console.warn(`[meeting-agent] attendance=${a.id} reply failed: ${err instanceof Error ? err.name : 'error'}`)
    return fallbackReply(a.ownerFirstName)
  }
}
