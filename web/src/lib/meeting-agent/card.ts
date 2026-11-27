/**
 * The approval card for sending the assistant to a meeting (roadmap #12): its
 * title and its "why", the whole brief in the person's words. The chat tool's
 * card (src/lib/ai/tools/meeting-agent.ts) and the prep card's brief editor
 * (its Review step, from /api/account/meeting-agent's preview) show the same
 * words, so the person approves the same thing wherever they send it from.
 * Pure and client-safe.
 */
import { maskPhone } from '@/lib/twilio/phone'
import { ALWAYS_MUST_NOT_AGREE, type MeetingBrief } from './brief'

export interface MeetingAgentCard {
  title: string
  why: string
}

export function meetingAgentCard(args: { title: string; number: string; brief: MeetingBrief; everyOccurrence: boolean }): MeetingAgentCard {
  const b = args.brief
  const lines = (title: string, items: readonly string[]) => (items.length ? `${title}: ${items.join('; ')}` : null)
  return {
    title: args.everyOccurrence ? `Send your assistant to every “${args.title}”?` : `Send your assistant to “${args.title}”?`,
    why: [
      `It dials in at the start (${maskPhone(args.number)}), introduces itself as your AI assistant, says it is taking notes, and leaves if anyone objects.`,
      args.everyOccurrence ? 'It does the same for every later occurrence of this meeting, with this brief, until you stop it. You can skip any one.' : null,
      lines('Goals', b.goals),
      lines('May share', b.may_share),
      lines('Will ask', b.ask),
      lines('Never agrees to', [...b.must_not_agree, ...ALWAYS_MUST_NOT_AGREE]),
      'Anything else, it checks with you by text. The notes land as a capture.',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
