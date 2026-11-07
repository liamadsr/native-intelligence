/**
 * One line every live-conversation chat prompt carries, in the live-meeting
 * block (buildLiveCaptureContext).
 *
 * The chat talks AS the live agent, and that agent's own instructions are
 * written for the background listening loop (say_to_user, flushes, "you write
 * nothing down"). Without this line a talk-back reply follows the loop's output
 * contract instead of answering the user.
 */
export const LIVE_CHAT_REPLY_NOTE =
  'If your agent instructions describe the background listening loop (say_to_user, flushes, staging proposals, writing nothing down), those rules belong to that loop. Here you reply to the user directly in this chat: answer in plain text from the meeting context, and use your tools when they ask you to look something up or make a change. ' +
  // The quick-answer path (2026-10-15): the person asks mid-call and reads the
  // reply at a glance in the HUD, while the background loop keeps the notes.
  'They are mid-call and read your reply at a glance: answer in one to three short sentences, look up only what the question needs (one or two tool calls, made together), and leave the notes and summary to the background loop.'
