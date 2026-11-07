/**
 * Automatic vocabulary from what the team writes (docs/plans/custom-vocabulary.md
 * §10; src/lib/vocabulary/harvest.ts). No model call and nothing for anyone to
 * approve (Liam, 2026-10-24): a text scan keeps the harvested words live.
 *
 *   - The workspace's words (workspace documents, confirmed actions): after
 *     every processed meeting (`flow/capture.processed`, so the list keeps up
 *     as meetings happen) and when someone's transcription asks for them
 *     (VOCABULARY_HARVEST_EVENT, sent at most hourly per person by
 *     requestVocabularyHarvest).
 *   - A person's own words (their chat messages and private documents): on
 *     VOCABULARY_HARVEST_EVENT, for that person.
 *
 * Debounced per workspace (and per person), so a burst of meetings or app
 * starts is one scan; the timeout guarantees a scan at least every 30 min
 * under constant traffic.
 */
import { getServiceClient } from '@/lib/admin'
import { dropMishearings, harvestWords, personalTexts, syncHarvest, trustedTerms, workspaceTexts } from '@/lib/vocabulary/harvest'
import { loadLexicon } from '@/lib/vocabulary/lexicon'
import { inngest } from './client'

export const VOCABULARY_HARVEST_EVENT = 'vocabulary/harvest.requested'

export interface VocabularyHarvestEventData {
  workspace_id: string
  user_id: string
  /** `${workspace_id}:${user_id}`: the per-person debounce key. */
  harvest_key: string
}

export const vocabularyHarvestWorkspace = inngest.createFunction(
  {
    id: 'vocabulary-harvest-workspace',
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.workspace_id' }],
    debounce: { key: 'event.data.workspace_id', period: '2m', timeout: '30m' },
    triggers: [{ event: 'flow/capture.processed' }, { event: VOCABULARY_HARVEST_EVENT }],
  },
  async ({ event, step }) => {
    const workspaceId = (event.data as { workspace_id?: string }).workspace_id
    if (!workspaceId) return { status: 'skipped', reason: 'no_workspace' }
    return await step.run('harvest-workspace', async () => {
      const supabase = getServiceClient()
      const [lexicon, texts] = await Promise.all([loadLexicon(), workspaceTexts(supabase, workspaceId)])
      const found = harvestWords(texts, lexicon)
      const words = dropMishearings(found, await trustedTerms(supabase, { workspaceId, userId: null }, lexicon))
      const r = await syncHarvest(supabase, { workspaceId, userId: null, words })
      return { status: 'ok', texts: texts.length, words: words.length, mishearings: found.length - words.length, ...r }
    })
  },
)

export const vocabularyHarvestPersonal = inngest.createFunction(
  {
    id: 'vocabulary-harvest-personal',
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.harvest_key' }],
    debounce: { key: 'event.data.harvest_key', period: '2m', timeout: '30m' },
    triggers: [{ event: VOCABULARY_HARVEST_EVENT }],
  },
  async ({ event, step }) => {
    const { workspace_id: workspaceId, user_id: userId } = event.data as Partial<VocabularyHarvestEventData>
    if (!workspaceId || !userId) return { status: 'skipped', reason: 'no_person' }
    return await step.run('harvest-personal', async () => {
      const supabase = getServiceClient()
      // Only a current member's own words, in a workspace they belong to.
      const { data: member } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
      if (!member) return { status: 'skipped', reason: 'not_a_member' }
      const [lexicon, texts] = await Promise.all([loadLexicon(), personalTexts(supabase, workspaceId, (member as { id: string }).id)])
      const found = harvestWords(texts, lexicon)
      const words = dropMishearings(found, await trustedTerms(supabase, { workspaceId, userId }, lexicon))
      const r = await syncHarvest(supabase, { workspaceId, userId, words })
      return { status: 'ok', texts: texts.length, words: words.length, mishearings: found.length - words.length, ...r }
    })
  },
)
