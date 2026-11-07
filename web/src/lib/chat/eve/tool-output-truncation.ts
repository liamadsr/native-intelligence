/**
 * Display-boundary truncation for tool outputs entering useChat state.
 *
 * WHY (2026-08-05 live incident): the chat transport forwarded every tool
 * result IN FULL into the client message state. A big tool dump runs
 * tens-to-hundreds of KB, useChat retains the complete message array with no
 * cap, the TabsState snapshot duplicates it, and the auto-save persists it —
 * 10–100MB retained over a long session for bytes nothing ever renders past
 * the first screen.
 *
 * Truncating HERE — at the transport boundary, before the chunk is emitted —
 * is safe because the client's copy of a tool output is display-only:
 *  - The model already consumed the FULL output on its own side (eve executes
 *    tools server-side).
 *  - Continuity is the durable eve session on the server, never our copy.
 *  - History persistence stores the truncated view — a reload shows exactly
 *    what the live panel showed.
 *
 * Under-threshold outputs are returned UNCHANGED (same reference — downstream
 * caches key off output identity, e.g. chat-message's entity-links WeakMap).
 * Over-threshold outputs become a head + marker + tail STRING regardless of
 * input type; every downstream reader probes output shape defensively
 * (`typeof output === 'object'` guards), so structured-output affordances
 * (entity links, draft cards) degrade gracefully for oversized dumps.
 */

/** Serialized size above which an output is truncated (~64KB). */
export const TOOL_OUTPUT_MAX_SERIALIZED_CHARS = 64_000
/** How much of the start of an oversized output is kept (~8KB). */
export const TOOL_OUTPUT_HEAD_CHARS = 8_000
/** How much of the end of an oversized output is kept (~2KB). */
export const TOOL_OUTPUT_TAIL_CHARS = 2_000

/**
 * Bound a tool output for display. Returns the input untouched (same
 * reference) when its serialized form fits under the threshold; otherwise
 * returns a `head … [output truncated for display — N KB total] … tail`
 * string. A string input always yields a string output (typed overload) so
 * callers bounding already-string fields (e.g. errorText) need no cast.
 */
export function truncateToolOutput(output: string): string
export function truncateToolOutput(output: unknown): unknown
export function truncateToolOutput(output: unknown): unknown {
  let serialized: string
  if (typeof output === 'string') {
    serialized = output
  } else {
    try {
      // JSON.stringify(undefined) / stringify of a bare function returns
      // undefined (not a string) — those have no meaningful size; pass through.
      const s = JSON.stringify(output)
      if (typeof s !== 'string') return output
      serialized = s
    } catch {
      // Unserializable (circular) — cannot measure or truncate meaningfully.
      // Never seen from a JSON wire event; pass through rather than throw.
      return output
    }
  }
  if (serialized.length <= TOOL_OUTPUT_MAX_SERIALIZED_CHARS) return output

  const totalKb = Math.round(serialized.length / 1024)
  const head = serialized.slice(0, TOOL_OUTPUT_HEAD_CHARS)
  const tail = serialized.slice(-TOOL_OUTPUT_TAIL_CHARS)
  return `${head}\n\n[output truncated for display — ${totalKb} KB total]\n\n${tail}`
}

/**
 * Fields of a tool output only the model reads. The chat-agent attaches an
 * area's expertise pack to the tool result that first touches the area, under
 * `__expertise`, and its proxy's toModelOutput hands it to the model
 * (agents/chat-agent/lib/expertise.ts EXPERTISE_FIELD; expertise-drift.test.ts
 * keeps the two names equal). eve still sends the full output on
 * action.result, so the transport drops these before the part is drawn or
 * saved: the person never sees the pack, and history never stores it.
 */
export const MODEL_ONLY_TOOL_FIELDS: readonly string[] = ['__expertise']

/** The output without its model-only fields. Anything else passes through as is (same reference). */
export function stripModelOnlyToolFields(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  if (!MODEL_ONLY_TOOL_FIELDS.some((field) => field in output)) return output
  const rest: Record<string, unknown> = { ...(output as Record<string, unknown>) }
  for (const field of MODEL_ONLY_TOOL_FIELDS) delete rest[field]
  return rest
}
