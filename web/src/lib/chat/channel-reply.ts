/**
 * What a channel turn sends (a text back, a Slack reply, an answer to a linked
 * agent): the turn's final answer, never its narration. A turn writes text
 * between its tool calls ("Let me check Liam's calendar...") that reads fine in
 * the app beside the tool rows, but texted it is the agent thinking out loud
 * (Liam, 2026-10-31: his wife was texted it). The home thread keeps every word;
 * only the send reads {@link replyTextOfParts}. Pure, client-safe.
 */

/**
 * The line every channel note carries, so the agent knows which words are
 * sent: the reply after its last tool call, whole, with no thinking in it.
 */
export const CHANNEL_REPLY_RULE =
  'Only what you write after your last tool call is sent, so put the whole reply there, and never write your reasoning or plans as text.'

/** A UI message part that is a tool call (static `tool-<name>` or a dynamic tool). */
function isToolPart(type: unknown): boolean {
  return type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'))
}

/**
 * The turn's final answer: its last run of text parts after its last tool
 * call, joined. When the turn ended on a tool call that worked (it answered,
 * then remembered something), the last run of text before it; when that call
 * failed (a failed turn's open calls are stored as errors), nothing: what came
 * before it was narration, and the caller's failure notice goes instead.
 * Reasoning, step and data parts neither count nor break a run. '' when the
 * turn wrote no text.
 */
export function replyTextOfParts(parts: unknown): string {
  const list = Array.isArray(parts) ? (parts as Array<{ type?: unknown; text?: unknown; state?: unknown }>) : []
  let last: string[] = []
  let run: string[] = []
  let endedOnFailedCall = false
  for (const p of list) {
    if (isToolPart(p?.type)) {
      if (run.length) last = run
      run = []
      endedOnFailedCall = p.state === 'output-error'
    } else if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      run.push(p.text)
    }
  }
  if (run.length) return run.join('\n').trim()
  return endedOnFailedCall ? '' : last.join('\n').trim()
}
