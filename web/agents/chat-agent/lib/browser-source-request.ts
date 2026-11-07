/** Preserve human-authored text separately from planner and page text. */
export function browserSourceRequest(messages: readonly unknown[] | undefined): string {
  const requests: string[] = []
  for (const raw of messages ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as { role?: unknown; kind?: unknown; content?: unknown }
    // Eve keeps this provenance on projected messages. Unknown provenance,
    // context instructions, summaries, assistant and tool output stay out.
    if (message.role !== 'user' || message.kind !== 'user') continue
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n') : ''
    if (text.trim()) requests.push(text)
  }
  const recent = requests.slice(-3)
  // Never cut off a trailing constraint to satisfy the transport budget.
  const serialized = JSON.stringify(recent)
  return recent.length && serialized.length <= 8000 ? serialized : ''
}
