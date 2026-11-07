/**
 * The markdown to read for one chat message: its text parts, in order.
 * Reasoning, tool calls and files are not read.
 *
 * Text parts are joined with a blank line, so each starts a new block. A text
 * part that is finished (the part after it has begun, or the SDK marked it
 * `done`) is closed with a blank line too, so a reader streaming the message
 * speaks its last sentence straight away instead of waiting out a tool call.
 * The result only ever grows by appending while the message streams.
 */

interface MessageLike {
  parts: ReadonlyArray<{ type: string; text?: unknown; state?: unknown }>
}

/** `fromPart`: skip the parts before this index (a resumed turn only reads
 *  what it adds to the message). */
export function messageSpeechMarkdown(message: MessageLike, fromPart = 0): string {
  const parts = message.parts
  const texts: string[] = []
  for (let i = Math.max(0, fromPart); i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  if (texts.length === 0) return ''
  const last = parts[parts.length - 1]
  const lastTextFinished = last.type !== 'text' || last.state === 'done'
  return texts.join('\n\n') + (lastTextFinished ? '\n\n' : '')
}
