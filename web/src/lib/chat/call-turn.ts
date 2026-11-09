/**
 * Calling the agent (docs/plans/text-and-calling.md, Phase 4; the GPT-Live
 * spike): what is a call's own. The vocabulary every outside channel shares
 * is ./channel-turn.ts; a call's hand-off is a channel turn with reason
 * 'call' and surface 'call'.
 *
 * The flow: the person calls the Native Intelligence number from their verified phone.
 * GPT-Live answers and talks with them (src/lib/calls/live-bridge.ts); when
 * it needs Native Intelligence it hands the request over, the bridge writes what they said
 * into their home thread as THEIR message and runs the turn in-process
 * (src/lib/calls/call-turn-server.ts) as the server principal `channel_turn`
 * with surface `call`: the person speaking, remote (caller ID can be
 * spoofed), with their own tools minus what needs a screen. The reply goes
 * back to GPT-Live, which says it aloud.
 */

/**
 * What a call turn's risky call becomes (the chat tool route's gate,
 * src/lib/safety/action-review.ts alwaysHold): the person's approval card in
 * the app, and a line the model says back. As with a text, a caller ID can be
 * spoofed, so a call alone never sends, deletes or writes outside Native Intelligence.
 */
export const CALL_TURN_HOLD = {
  reason: 'call_turn',
  message:
    "Nothing ran: from a phone call, this needs the person's approval, and they now have a card for it in Native Intelligence. " +
    "Tell them in your reply that it's waiting in Native Intelligence for their OK. Do not call it again.",
  // The card's reason: they did ask, on a call, which can't run it alone.
  cardWhy: 'you asked for it on a phone call, and a call alone never runs it',
} as const
