import { inngest } from '@/lib/inngest/client'
import { VOCABULARY_HARVEST_EVENT, type VocabularyHarvestEventData } from '@/lib/inngest/vocabulary-harvest'

/**
 * Ask for this person's (and their workspace's) harvested vocabulary to be
 * refreshed (src/lib/inngest/vocabulary-harvest.ts). Called when their
 * transcription loads its vocabulary; sent at most once an hour per person per
 * server instance, and the jobs are debounced, so it costs next to nothing.
 * Fire-and-forget: never blocks or fails the request.
 */
const lastSent = new Map<string, number>()
const EVERY_MS = 60 * 60 * 1000

export function requestVocabularyHarvest(workspaceId: string, userId: string, now = Date.now()): boolean {
  const key = `${workspaceId}:${userId}`
  const prev = lastSent.get(key)
  if (prev !== undefined && now - prev < EVERY_MS) return false
  lastSent.set(key, now)
  if (lastSent.size > 5000) lastSent.clear()
  const data: VocabularyHarvestEventData = { workspace_id: workspaceId, user_id: userId, harvest_key: key }
  void Promise.resolve()
    .then(() => inngest.send({ name: VOCABULARY_HARVEST_EVENT, data }))
    .catch((err) => {
      lastSent.delete(key) // try again on the next load, not an hour later
      console.error('[vocabulary] harvest request failed', err)
    })
  return true
}

/** Tests only. */
export function __resetHarvestRequestsForTests() {
  lastSent.clear()
}
