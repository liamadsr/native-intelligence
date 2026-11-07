import 'server-only'
import { runDecision } from './run-decision'
import { retrievalRelevanceSchema, type RetrievalRelevanceInput } from './tasks/retrieval-relevance'

export const RETRIEVAL_FILTER_BUDGET_MS = 1500
const MAX_BATCHES = 2
const PASSAGES_PER_BATCH = 4

export interface RetrievalPassage {
  id: string
  workspaceId: string
  title: string
  text: string
  /** The entire returned text passage is present; not a clipped or multimodal preview. */
  complete: boolean
}

export interface RetrievalFilterResult {
  irrelevantIds: Set<string>
}

/** A bounded negative-only filter. Unexamined and uncertain passages stay in their original rank order. */
export async function filterRetrievalPassages(args: {
  userId: string
  workspaceIds: readonly string[]
  query: string
  passages: readonly RetrievalPassage[]
  signal?: AbortSignal
}): Promise<RetrievalFilterResult> {
  const keepAll = (): RetrievalFilterResult => ({ irrelevantIds: new Set() })
  const query = args.query.trim()
  // Keyword/entity listing stays deterministic, including broad semantic queries.
  if (args.signal?.aborted || query.length < 2 || query.length > 2000 ||
    /^[\s*%_?.]+$/.test(query) || /^(?:(?:show|list|get|find)\s+)?(?:all|everything|anything|every)\b/i.test(query)) return keepAll()
  const allowed = new Set(args.workspaceIds)
  const batches: Array<{ workspaceId: string; passages: RetrievalRelevanceInput['passages'] }> = []
  const seen = new Set<string>()
  for (const passage of args.passages) {
    if (!allowed.has(passage.workspaceId) || !passage.complete || seen.has(passage.id)) continue
    const parsed = retrievalRelevanceSchema.safeParse({ query, passages: [passage] })
    if (!parsed.success || /(?:\.\.\.|…)\s*$/.test(passage.text)) continue
    let batch = batches.find(candidate => candidate.workspaceId === passage.workspaceId && candidate.passages.length < PASSAGES_PER_BATCH)
    if (!batch) {
      if (batches.length >= MAX_BATCHES) continue
      batch = { workspaceId: passage.workspaceId, passages: [] }
      batches.push(batch)
    }
    seen.add(passage.id)
    batch.passages.push(parsed.data.passages[0])
  }
  if (!batches.length) return keepAll()

  const controller = new AbortController()
  const signal = args.signal ? AbortSignal.any([controller.signal, args.signal]) : controller.signal
  const deadline = Date.now() + RETRIEVAL_FILTER_BUDGET_MS
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<RetrievalFilterResult>(resolve => {
    onAbort = () => resolve(keepAll())
    signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => controller.abort(), RETRIEVAL_FILTER_BUDGET_MS)
  })
  try {
    const work = Promise.all(batches.map(async batch => {
      try {
        const result = await runDecision('retrieval.relevance', { query, passages: batch.passages }, {
          userId: args.userId, workspaceId: batch.workspaceId, signal,
        })
        if (signal.aborted || Date.now() >= deadline || result.status !== 'accepted') return []
        // Only IDs actually supplied in THIS authorized workspace batch can be removed.
        const offered = new Set(batch.passages.map(passage => passage.id))
        return result.value.irrelevantIds.filter(id => offered.has(id))
      } catch { return [] }
    })).then(results => signal.aborted || Date.now() >= deadline ? keepAll() : {
      irrelevantIds: new Set(results.flat()),
    })
    return await Promise.race([work, interrupted])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
