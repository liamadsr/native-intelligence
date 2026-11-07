/**
 * Texting the agent (docs/plans/text-and-calling.md, Phase 1): what is SMS's
 * own. The vocabulary every outside channel shares (the person's message row,
 * the turn's framed body, the reply's channel mark) is ./channel-turn.ts; a
 * text is a channel turn with reason 'text' and surface 'sms'.
 *
 * The flow: the person texts the Dial8 number from their verified phone. The
 * webhook (src/lib/sms/inbound.ts) writes the text into their home thread as
 * THEIR message (src/lib/sms/deliver.ts) and sends `text/turn.requested`. The
 * consumer (src/lib/inngest/text-turn.ts) runs a home turn with reason 'text'
 * (the claim, lease, send, read and finish of home-turn-server.ts) as the
 * server principal `channel_turn` with surface `sms`: the person speaking,
 * with their own tools minus what needs a screen. The reply is written to the
 * thread and texted back (./text-turn-server.ts); `[quiet]` or nothing sends
 * nothing.
 */
/** The Inngest event a text turn is requested with (same data as home/turn.requested, reason 'text'). */
export const TEXT_TURN_REQUESTED_EVENT = 'text/turn.requested' as const

/** The longest text the webhook keeps (Twilio's own cap on one inbound message is 1,600). */
export const TEXT_MAX_CHARS = 1600

/**
 * What a text turn's risky call becomes (the chat tool route's gate, src/lib/safety/action-review.ts alwaysHold;
 * docs/plans/text-and-calling.md Risks: a text alone never sends, deletes or writes outside Dial8): the
 * person's approval card, and a line the model texts back.
 */
export const TEXT_TURN_HOLD = {
  reason: 'text_turn',
  message:
    "Nothing ran: from a text, this needs the person's approval, and they now have a card for it. " +
    'Right after your reply they get a text asking for their OK: they answer yes or no, or approve it in Dial8. ' +
    'Tell them in your reply that it needs their OK first. Do not call it again.',
  // The card's reason: they did ask, by text, which can't run it alone.
  cardWhy: 'you asked for it by text, and a text alone never runs it',
} as const
