/**
 * The chat bound on delegated work (agent_run.chat_ceiling, migration 299):
 * the drafting tools the main chat could call when a person asked it to hand
 * work to a teammate (snapshotChatCeiling in ./run-work-spec-rebuild, recorded
 * at admission). ceilingForWorkRun intersects it into the run's ceiling, and a
 * teammate handoff copies it from the run handing work over, so neither the
 * chat root nor anything under it can do what the chat itself could not.
 *
 * Pure and dependency-free so the delegation planner can use it without the
 * spec rebuild's import graph.
 */

/**
 * A run's chat bound, or null for none. FAIL CLOSED: a chat-origin row without
 * one (admitted before the bound was recorded) and a malformed value are an
 * EMPTY bound, never "none".
 */
export function chatBoundForWorkRun(origin: string | null | undefined, chatCeiling: unknown): Set<string> | null {
  if (chatCeiling === null || chatCeiling === undefined) return origin === 'chat' ? new Set() : null
  if (!Array.isArray(chatCeiling)) return new Set()
  return new Set(chatCeiling.filter((name): name is string => typeof name === 'string'))
}

/** The chat bound a teammate handoff inherits from the run handing it over (the same fail-closed reading), sorted. */
export function chatCeilingForChild(parent: { origin?: string | null; chat_ceiling?: unknown }): string[] | null {
  const bound = chatBoundForWorkRun(parent.origin, parent.chat_ceiling)
  return bound ? [...bound].sort() : null
}
