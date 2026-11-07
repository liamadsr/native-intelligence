/**
 * The `profile` memory slot: facts about the person (docs/plans/always-on-agent.md
 * §3, slice A2a, decision 4). eve decides WHEN memory is recalled (before
 * every turn, and after every compaction); the app decides WHAT and WHERE
 * (profile_fact, migration 328, through POST /api/internal/chat/memory).
 *
 * Two keyed records come back, `facts` (a snapshot frozen per epoch) and
 * `facts-delta` (what changed since), so a told fact changes only the small,
 * recent record and the cached prefix holds. Both are fenced by the app as
 * information about the person, never instructions.
 *
 * No provider tools (they would be named `profile__*`): saving stays
 * `remember` with scope 'profile'.
 *
 * The capture pass (A2c): right before eve compacts, `compaction.requested`
 * posts what was said since the last capture (text only) to the same route,
 * which queues a utility-agent pass that saves what the person stated and
 * proposes what it inferred. It never throws: a throw would abort compaction.
 * The refreshed facts reach the chat at the next epoch, through
 * `compaction.completed`.
 *
 * The home thread's re-prime (A3): `compaction.completed` also posts the new
 * checkpoint's text to the route (op 'checkpoint'), stored on the
 * conversation; the recall it returns is unchanged, so replays stay
 * deterministic.
 *
 * Scope, failure handling, the slice and caching: lib/profile-memory.ts.
 */
import { defineMemory, defineMemoryProvider } from 'eve/memory'
import { captureProfile, profileMemoryScope, recallAfterCompaction, recallProfile } from '../lib/profile-memory.js'
import { recallTokens, recordMemorySize } from '../lib/context-parts.js'

/** A recall, with what it adds kept for the side panel's Context card (lib/context-parts.ts). */
async function measured<T>(recall: Promise<T>): Promise<T> {
  const result = await recall
  recordMemorySize(recallTokens(result))
  return result
}

export default defineMemory({
  description: 'Facts about the person: how they work, shared across their workspaces.',
  namespace: 'dial8-profile-facts-v1',
  scope: (ctx) => profileMemoryScope(ctx),
  provider: defineMemoryProvider({
    recall: {
      'turn.started': (ctx) => measured(recallProfile('turn.started', ctx)),
      'compaction.completed': (ctx) => measured(recallAfterCompaction(ctx)),
    },
    capture: {
      'compaction.requested': (ctx) => captureProfile(ctx),
    },
  }),
})
