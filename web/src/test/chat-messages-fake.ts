/**
 * An in-memory `chat_conversations` + `chat_messages` pair for the eve message
 * writer (src/lib/chat/eve-message-writer.ts) and its callers. It keeps the
 * table's real write semantics, so tests can assert what a thread ends up
 * holding:
 *   - upsert(row, { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates })
 *     inserts unless a row with the same conversation and ui_message.id
 *     exists, and `.select('id')` answers the inserted row only;
 *   - update(payload).eq(...).select('id') updates the rows the filters match,
 *     where a filter may be a JSON path (`ui_message->metadata->>key`, compared
 *     as text, as PostgREST does) or `ui_message_id` (ui_message.id, the
 *     generated column);
 *   - select(..).eq(..).maybeSingle() reads one row.
 * Rows keep insertion order (`seq`), the order a reload reads them in.
 */
export interface FakeMessageRow {
  id: string
  seq: number
  conversation_id: string
  user_id: string
  workspace_id: string
  role: string
  ui_message: { id: string; role: string; parts: unknown[]; metadata?: Record<string, unknown> }
}

export interface FakeConversationRow {
  id: string
  user_id: string
  workspace_id: string
  title?: string | null
  [key: string]: unknown
}

function valueAt(row: Record<string, unknown>, column: string): unknown {
  if (column === 'ui_message_id') return (row.ui_message as { id?: unknown } | undefined)?.id
  if (!column.includes('->')) return row[column]
  // a->b->>c: walk the JSON; `->>` reads the last step as text.
  const asText = column.includes('->>')
  const keys = column.split(/->>?/)
  let v: unknown = row[keys[0]]
  for (const k of keys.slice(1)) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
  return asText && v !== undefined && v !== null ? String(v) : v
}

/**
 * `members`: the `member` rows (user_id, workspace_id). Defaults to each
 * conversation's owner, a member of its workspace, as in the real database;
 * the run-token DB binding (src/lib/chat/surface-run-guard.ts) reads it.
 */
export function chatMessagesFake(
  conversations: FakeConversationRow[],
  members: Array<{ user_id: string; workspace_id: string }> = conversations.map((c) => ({
    user_id: c.user_id,
    workspace_id: c.workspace_id,
  })),
) {
  const messages: FakeMessageRow[] = []
  const memberRows = members.map((m, i) => ({ id: `member-${i + 1}`, ...m }))
  let seq = 0

  const from = (table: string) => {
    let op: 'select' | 'upsert' | 'update' = 'select'
    let payload: Record<string, unknown> | null = null
    let options: { ignoreDuplicates?: boolean } | undefined
    const eqs: Array<[string, unknown]> = []
    const rowsOf = (): Record<string, unknown>[] =>
      (table === 'chat_messages'
        ? messages
        : table === 'chat_conversations'
          ? conversations
          : table === 'member'
            ? memberRows
            : []) as unknown as Record<string, unknown>[]
    const matching = () => rowsOf().filter((r) => eqs.every(([c, v]) => valueAt(r, c) === v))

    const run = (): { data: unknown; error: null } => {
      if (op === 'upsert' && table === 'chat_messages' && payload) {
        const row = payload as Omit<FakeMessageRow, 'id' | 'seq'>
        const dup = messages.find((m) => m.conversation_id === row.conversation_id && m.ui_message.id === row.ui_message.id)
        if (dup) {
          if (!options?.ignoreDuplicates) Object.assign(dup, row)
          return { data: options?.ignoreDuplicates ? [] : [{ id: dup.id }], error: null }
        }
        const inserted: FakeMessageRow = { ...structuredClone(row), id: `row-${++seq}`, seq }
        messages.push(inserted)
        return { data: [{ id: inserted.id }], error: null }
      }
      if (op === 'update' && payload) {
        const hit = matching()
        for (const r of hit) Object.assign(r, structuredClone(payload))
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      return { data: matching(), error: null }
    }

    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (column: string, value: unknown) => (eqs.push([column, value]), chain)
    chain.upsert = (row: Record<string, unknown>, opts?: { ignoreDuplicates?: boolean }) => {
      op = 'upsert'
      payload = row
      options = opts
      return chain
    }
    chain.update = (patch: Record<string, unknown>) => {
      op = 'update'
      payload = patch
      return chain
    }
    chain.maybeSingle = async () => {
      const { data } = run()
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null }
    }
    chain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject)
    return chain
  }

  return {
    client: { from } as never,
    messages,
    conversations,
    /** The thread as a reload reads it: role + ui_message.id, oldest first. */
    thread: () => [...messages].sort((a, b) => a.seq - b.seq).map((m) => ({ role: m.role, id: m.ui_message.id })),
  }
}
